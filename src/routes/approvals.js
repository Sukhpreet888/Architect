'use strict';
const router = require('express').Router();
const db = require('../db');
const N = require('../notify');
const S = require('../services');
const { APPROVAL_TYPES, DECISIONS } = require('../config');
const { requireOrg, perm, loadProject, projectOpen, httpError, back } = require('../mw');
const { int, arr, filterSeq } = require('../util');

router.use(['/approvals', '/projects'], requireOrg);
const now = () => new Date().toISOString().slice(0, 19).replace('T', ' ');

router.get('/approvals', async (req, res) => {
  const mine = await db.all(`SELECT a.*, p.name project_name, p.code, r.decision my_decision FROM approval_reviewers r JOIN approvals a ON a.id = r.approval_id
    JOIN projects p ON p.id = a.project_id WHERE r.user_id = ? AND p.org_id = ? ORDER BY (r.decision IS NULL AND a.status = 'pending') DESC, a.id DESC LIMIT 100`, req.user.id, req.org.id);
  const requested = await db.all(`SELECT a.*, p.name project_name, p.code FROM approvals a JOIN projects p ON p.id = a.project_id
    WHERE a.requested_by = ? AND p.org_id = ? ORDER BY a.id DESC LIMIT 100`, req.user.id, req.org.id);
  res.render('approvals/index', { title: 'Approvals & reviews', mine, requested });
});

router.get('/projects/:pid/approvals', loadProject, async (req, res) => {
  const approvals = await db.all(`SELECT a.*, ph.name phase_name, u.name requester,
      (SELECT COUNT(*) FROM approval_reviewers r WHERE r.approval_id = a.id) reviewers,
      (SELECT COUNT(*) FROM approval_reviewers r WHERE r.approval_id = a.id AND r.decision IS NOT NULL) decided
    FROM approvals a LEFT JOIN phases ph ON ph.id = a.phase_id LEFT JOIN users u ON u.id = a.requested_by
    WHERE a.project_id = ? ORDER BY CASE a.status WHEN 'pending' THEN 0 WHEN 'revision_required' THEN 1 WHEN 'draft' THEN 2 ELSE 3 END, a.id DESC`, req.project.id);
  res.render('approvals/project', {
    title: `${req.project.name} — Approvals`, approvals, ...await formData(req),
  });
});

async function formData(req) {
  const pid = req.project.id;
  return {
    team: (await S.projectTeam(pid)).filter((u) => u.id !== req.user.id),
    phases: await db.all("SELECT * FROM phases WHERE project_id = ? AND status != 'na' ORDER BY seq", pid),
    deliverables: await db.all('SELECT id, name, status FROM deliverables WHERE project_id = ? ORDER BY id', pid),
    documents: await db.all('SELECT id, title FROM documents WHERE project_id = ? ORDER BY id DESC', pid),
  };
}
const scoped = async (req, table, id) => (id && await db.get(`SELECT id FROM ${table} WHERE id = ? AND project_id = ?`, id, req.project.id) ? id : null);
function validReviewers(req) {
  return filterSeq([...new Set(arr(req.body.reviewers).map(Number))], async (id) => id !== req.user.id && await S.isOrgUser(req.org.id, id));
}
async function setReviewers(apId, ids) {
  await db.run('DELETE FROM approval_reviewers WHERE approval_id = ?', apId);
  for (const uid of ids) await db.run('INSERT INTO approval_reviewers (approval_id, user_id) VALUES (?, ?)', apId, uid);
  for (const uid of ids) await db.run('INSERT INTO project_members (project_id, user_id) SELECT project_id, ?::int FROM approvals WHERE id = ? ON CONFLICT DO NOTHING', uid, apId);
}

// Create approval request (design, drawings, material, ...)
router.post('/projects/:pid/approvals', loadProject, projectOpen, perm('approval_create'), async (req, res) => {
  const title = String(req.body.title || '').trim();
  const reviewers = await validReviewers(req);
  if (!title || !APPROVAL_TYPES[req.body.type]) { req.flash('error', 'Title and type are required.'); return res.redirect(back(req)); }
  if (!reviewers.length) { req.flash('error', 'Assign at least one reviewer (other than yourself).'); return res.redirect(back(req)); }
  const id = await db.tx(async () => {
    const aid = await db.insert('approvals', {
      project_id: req.project.id, type: req.body.type, title, description: req.body.description, status: 'pending',
      phase_id: await scoped(req, 'phases', int(req.body.phase_id)), deliverable_id: await scoped(req, 'deliverables', int(req.body.deliverable_id)),
      document_id: await scoped(req, 'documents', int(req.body.document_id)), requested_by: req.user.id, requested_at: now(),
    });
    await setReviewers(aid, reviewers);
    await db.insert('approval_history', { approval_id: aid, round: 1, user_id: req.user.id, action: 'submitted', comment: req.body.description });
    const ap = await db.get('SELECT * FROM approvals WHERE id = ?', aid);
    if (ap.deliverable_id) await db.run("UPDATE deliverables SET status = 'submitted' WHERE id = ?", ap.deliverable_id);
    return aid;
  });
  await N.approvalRequested(await db.get('SELECT * FROM approvals WHERE id = ?', id), req.project, req.user, reviewers, false);
  req.flash('success', 'Approval requested — reviewers notified by email.');
  res.redirect(`/projects/${req.project.id}/approvals/${id}`);
});

async function loadApproval(req, res, next) {
  const ap = await db.get('SELECT * FROM approvals WHERE id = ? AND project_id = ?', req.params.aid, req.project.id);
  if (!ap) return next(httpError(404, 'Approval not found.'));
  req.approval = ap; next();
}

router.get('/projects/:pid/approvals/:aid', loadProject, loadApproval, async (req, res) => {
  const ap = req.approval;
  const reviewers = await db.all('SELECT r.*, u.name, u.email FROM approval_reviewers r JOIN users u ON u.id = r.user_id WHERE r.approval_id = ?', ap.id);
  res.render('approvals/show', {
    title: ap.title, ap, reviewers, me: reviewers.find((r) => r.user_id === req.user.id),
    history: await db.all('SELECT h.*, u.name FROM approval_history h LEFT JOIN users u ON u.id = h.user_id WHERE approval_id = ? ORDER BY h.id', ap.id),
    requester: await S.userById(ap.requested_by), phase: ap.phase_id && await db.get('SELECT * FROM phases WHERE id = ?', ap.phase_id),
    deliverable: ap.deliverable_id && await db.get('SELECT * FROM deliverables WHERE id = ?', ap.deliverable_id),
    document: ap.document_id && await db.get('SELECT * FROM documents WHERE id = ?', ap.document_id),
    ...await formData(req),
  });
});

/** Apply the final outcome once every reviewer has decided. */
async function finalize(req, ap, status) {
  await db.run('UPDATE approvals SET status = ?, decided_at = ? WHERE id = ?', status, now(), ap.id);
  const delivStatus = status === 'approved' ? 'approved' : 'revision_required';
  if (ap.deliverable_id) await db.run('UPDATE deliverables SET status = ? WHERE id = ?', delivStatus, ap.deliverable_id);
  let phaseResult = null;
  if (ap.type === 'phase' && ap.phase_id) {
    if (status === 'approved') {
      await db.run("UPDATE deliverables SET status = 'approved' WHERE phase_id = ? AND status = 'submitted'", ap.phase_id);
      phaseResult = await S.completePhase(ap.phase_id);
    } else {
      await db.run("UPDATE phases SET status = 'in_progress' WHERE id = ?", ap.phase_id);
      await db.run("UPDATE deliverables SET status = 'revision_required' WHERE phase_id = ? AND status = 'submitted'", ap.phase_id);
    }
  }
  await N.approvalFinal({ ...ap, status }, req.project, status);
  if (phaseResult) await N.phaseCompleted(req.project, phaseResult.phase, phaseResult.next);
  return phaseResult;
}

router.post('/projects/:pid/approvals/:aid/decide', loadProject, projectOpen, loadApproval, async (req, res) => {
  const ap = req.approval;
  const me = await db.get('SELECT * FROM approval_reviewers WHERE approval_id = ? AND user_id = ?', ap.id, req.user.id);
  const decision = req.body.decision;
  if (!me || ap.status !== 'pending') { req.flash('error', 'You are not an open reviewer on this request.'); return res.redirect(back(req)); }
  if (!DECISIONS[decision]) { req.flash('error', 'Choose a decision.'); return res.redirect(back(req)); }
  if (decision !== 'approved' && !String(req.body.comment || '').trim()) { req.flash('error', 'Please add a comment explaining the revision or rejection.'); return res.redirect(back(req)); }
  await db.run('UPDATE approval_reviewers SET decision = ?, comment = ?, decided_at = ? WHERE id = ?', decision, req.body.comment, now(), me.id);
  await db.insert('approval_history', { approval_id: ap.id, round: ap.round, user_id: req.user.id, action: decision, comment: req.body.comment });
  await N.approvalDecision(ap, req.project, req.user, decision, req.body.comment);
  const final = await S.resolveApproval(ap.id);
  if (final) {
    const r = await finalize(req, ap, final);
    req.flash('success', `Decision recorded. Final outcome: ${DECISIONS[final]}${r && r.next ? ` — ${r.next.name} is now in progress` : ''}.`);
  } else req.flash('success', 'Decision recorded. Waiting for the other reviewers.');
  res.redirect(`/projects/${req.project.id}/approvals/${ap.id}`);
});

// Revise & re-submit (new round), optionally re-appointing reviewers; also sends a draft request for the first time
router.post('/projects/:pid/approvals/:aid/submit', loadProject, projectOpen, loadApproval, perm('approval_create'), async (req, res) => {
  const ap = req.approval;
  if (!['draft', 'revision_required', 'rejected'].includes(ap.status)) { req.flash('error', 'This request is not awaiting submission.'); return res.redirect(back(req)); }
  let reviewers = await validReviewers(req);
  if (!reviewers.length) reviewers = (await db.all('SELECT user_id FROM approval_reviewers WHERE approval_id = ?', ap.id)).map((r) => r.user_id).filter((id) => id !== req.user.id);
  if (!reviewers.length) { req.flash('error', 'Assign at least one reviewer.'); return res.redirect(back(req)); }
  const resubmit = ap.status !== 'draft';
  await db.tx(async () => {
    await db.run(`UPDATE approvals SET status = 'pending', round = round + ?, requested_by = COALESCE(requested_by, ?), requested_at = ?, decided_at = NULL,
      document_id = COALESCE(?, document_id), deliverable_id = COALESCE(?, deliverable_id) WHERE id = ?`,
    resubmit ? 1 : 0, req.user.id, now(), await scoped(req, 'documents', int(req.body.document_id)), await scoped(req, 'deliverables', int(req.body.deliverable_id)), ap.id);
    await setReviewers(ap.id, reviewers);
    const fresh = await db.get('SELECT * FROM approvals WHERE id = ?', ap.id);
    await db.insert('approval_history', { approval_id: ap.id, round: fresh.round, user_id: req.user.id, action: resubmit ? 'resubmitted' : 'submitted', comment: req.body.comment });
    if (fresh.deliverable_id) await db.run("UPDATE deliverables SET status = 'submitted' WHERE id = ?", fresh.deliverable_id);
    if (fresh.type === 'phase' && fresh.phase_id) await db.run("UPDATE phases SET status = 'in_review' WHERE id = ?", fresh.phase_id);
  });
  await N.approvalRequested(await db.get('SELECT * FROM approvals WHERE id = ?', ap.id), req.project, req.user, reviewers, resubmit);
  req.flash('success', resubmit ? 'Revised submission sent — reviewers notified by email.' : 'Approval requested — reviewers notified by email.');
  res.redirect(`/projects/${req.project.id}/approvals/${ap.id}`);
});

// Re-appoint reviewers on a pending request (managers)
router.post('/projects/:pid/approvals/:aid/reviewers', loadProject, projectOpen, loadApproval, perm('project_manage'), async (req, res) => {
  const ap = req.approval;
  const reviewers = await validReviewers(req);
  if (ap.status !== 'pending' || !reviewers.length) { req.flash('error', 'Choose reviewers for a pending request.'); return res.redirect(back(req)); }
  const existing = new Set((await db.all('SELECT user_id FROM approval_reviewers WHERE approval_id = ?', ap.id)).map((r) => r.user_id));
  await db.tx(async () => {
    await db.run(`DELETE FROM approval_reviewers WHERE approval_id = ? AND user_id NOT IN (${reviewers.join(',')})`, ap.id);
    for (const uid of reviewers) await db.run('INSERT INTO approval_reviewers (approval_id, user_id) VALUES (?, ?) ON CONFLICT DO NOTHING', ap.id, uid);
    await db.insert('approval_history', { approval_id: ap.id, round: ap.round, user_id: req.user.id, action: 'reviewers re-appointed' });
  });
  const added = reviewers.filter((id) => !existing.has(id));
  if (added.length) await N.approvalRequested(ap, req.project, req.user, added, false);
  const final = await S.resolveApproval(ap.id);
  if (final) await finalize(req, ap, final);
  req.flash('success', 'Reviewers updated.');
  res.redirect(`/projects/${req.project.id}/approvals/${ap.id}`);
});

router.post('/projects/:pid/approvals/:aid/cancel', loadProject, projectOpen, loadApproval, perm('project_manage'), async (req, res) => {
  await db.run("UPDATE approvals SET status = 'cancelled' WHERE id = ? AND status IN ('draft','pending','revision_required','rejected')", req.approval.id);
  if (req.approval.type === 'phase' && req.approval.phase_id) await db.run("UPDATE phases SET status = 'in_progress' WHERE id = ? AND status = 'in_review'", req.approval.phase_id);
  req.flash('success', 'Approval request cancelled.');
  res.redirect(`/projects/${req.project.id}/approvals`);
});

module.exports = router;
