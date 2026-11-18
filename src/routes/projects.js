'use strict';
const router = require('express').Router();
const db = require('../db');
const N = require('../notify');
const S = require('../services');
const { PROJECT_TYPES, AREA_UNITS, SCOPES } = require('../config');
const { requireOrg, perm, loadProject, projectOpen, httpError } = require('../mw');
const { num, int, arr, isDate, today, mapSeq, filterSeq } = require('../util');

router.use('/projects', requireOrg);
router.param('pid', (req, res, next) => (/^\d+$/.test(req.params.pid) ? next() : next('route')));

router.get('/projects', async (req, res) => {
  const status = req.query.status === 'closed' ? 'closed' : 'active';
  const projects = await mapSeq(await S.visibleProjects(req.org.id, req.user, req.role, { status }), async (p) => ({ ...p, prog: await S.phaseProgress(p.id), manager: await S.userById(p.manager_id) }));
  res.render('projects/index', { title: 'Projects', projects, status });
});

// ---- Create project: Step 1 — classification
router.get('/projects/new', perm('project_create'), async (req, res) => {
  const usage = await S.orgUsage(req.org.id); const limits = S.orgLimits(req.org);
  if (usage.projects >= limits.projects) {
    await N.usageLimitReached(req.org, 'projects');
    req.flash('error', `Your plan allows ${limits.projects} active projects. Upgrade or buy a project add-on.`);
    return res.redirect('/projects');
  }
  res.render('projects/new-step1', { title: 'New project — Step 1: Classification', draft: req.session.projectDraft || { area_unit: req.org.area_unit } });
});
router.post('/projects/new/step1', perm('project_create'), (req, res) => {
  const b = req.body; const errors = [];
  if (!PROJECT_TYPES[b.type]) errors.push('Choose the main project type.');
  else if (!PROJECT_TYPES[b.type].subtypes.includes(b.subtype)) errors.push('Choose a sub-type for the project type.');
  if (!(num(b.plot_area) > 0)) errors.push('Enter the plot area.');
  if (b.built_up_area && !(num(b.built_up_area) > 0)) errors.push('Built-up area must be a positive number.');
  if (!AREA_UNITS[b.area_unit]) errors.push('Choose an area unit.');
  const draft = { type: b.type, subtype: b.subtype, plot_area: num(b.plot_area), built_up_area: b.built_up_area ? num(b.built_up_area) : null, area_unit: b.area_unit };
  if (errors.length) return res.status(422).render('projects/new-step1', { title: 'New project — Step 1', draft, errors });
  req.session.projectDraft = draft;
  res.redirect('/projects/new/step2');
});

// ---- Step 2 — project information, team, dates, scope
router.get('/projects/new/step2', perm('project_create'), async (req, res) => {
  if (!req.session.projectDraft) return res.redirect('/projects/new');
  res.render('projects/new-step2', {
    title: 'New project — Step 2: Project information', draft: req.session.projectDraft, form: { start_date: today(), manager_id: req.user.id, scope: 'design' },
    members: await S.activeMembers(req.org.id), templates: await db.all('SELECT * FROM templates WHERE org_id = ? AND is_current = 1 ORDER BY name', req.org.id),
  });
});
router.post('/projects', perm('project_create'), async (req, res) => {
  const draft = req.session.projectDraft;
  if (!draft) return res.redirect('/projects/new');
  const usage = await S.orgUsage(req.org.id);
  if (usage.projects >= S.orgLimits(req.org).projects) { req.flash('error', 'Project limit reached for your plan.'); return res.redirect('/billing'); }
  const b = req.body; const errors = [];
  if (!String(b.name || '').trim()) errors.push('Project name is required.');
  if (!SCOPES[b.scope]) errors.push('Choose the execution scope.');
  if (b.start_date && !isDate(b.start_date)) errors.push('Invalid start date.');
  if (b.end_date && (!isDate(b.end_date) || b.end_date < b.start_date)) errors.push('Target end date must be after the start date.');
  if (b.client_email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(b.client_email)) errors.push('Client email is invalid (invoices and reminders are emailed to it).');
  const managerId = int(b.manager_id);
  if (managerId && !await S.isOrgUser(req.org.id, managerId)) errors.push('Invalid project manager.');
  if (errors.length) {
    req.flash('error', errors.join(' '));
    return res.redirect('/projects/new/step2');
  }
  const data = {
    ...draft, name: b.name.trim(), client_name: b.client_name, client_email: b.client_email && b.client_email.trim().toLowerCase(), client_phone: b.client_phone,
    location: b.location, description: b.description, start_date: b.start_date || today(), end_date: b.end_date, scope: b.scope,
    manager_id: managerId || req.user.id, contract_value: b.contract_value ? num(b.contract_value) : null,
    construction_budget: b.scope === 'design_construction' ? num(b.construction_budget) : 0, template_id: int(b.template_id),
  };
  const id = await S.createProjectWithWorkflow(req.org.id, req.user.id, data, arr(b.members).map(Number));
  req.session.projectDraft = undefined;
  const project = await db.get('SELECT * FROM projects WHERE id = ?', id);
  await N.projectCreated(project, req.user);
  req.flash('success', 'Project created and workflow generated from the template.');
  res.redirect(`/projects/${id}`);
});

// ---- Project overview dashboard
router.get('/projects/:pid', loadProject, async (req, res) => {
  const p = req.project;
  const prog = await S.phaseProgress(p.id);
  const upcoming = await db.all(`SELECT t.*, u.name assignee FROM tasks t LEFT JOIN users u ON u.id = t.assignee_id
    WHERE t.project_id = ? AND t.status != 'done' ORDER BY t.due_date IS NULL, t.due_date LIMIT 8`, p.id);
  const approvals = await db.all("SELECT * FROM approvals WHERE project_id = ? AND status IN ('pending','revision_required') ORDER BY id DESC LIMIT 5", p.id);
  const pay = req.can('payments_view') ? await S.paymentsSummary(req.org.id, p.id) : null;
  const spent = (await db.get("SELECT COALESCE(SUM(amount),0) s FROM expenditures WHERE project_id = ? AND status = 'approved'", p.id)).s;
  res.render('projects/show', {
    title: p.name, prog, upcoming, approvals, pay, spent, team: await S.projectTeam(p.id), manager: await S.userById(p.manager_id),
    members: await S.activeMembers(req.org.id), docsCount: (await db.get('SELECT COUNT(*) c FROM documents WHERE project_id = ?', p.id)).c,
    overdue: (await db.get("SELECT COUNT(*) c FROM tasks WHERE project_id = ? AND status != 'done' AND due_date < ?", p.id, today())).c,
  });
});

router.post('/projects/:pid/edit', loadProject, projectOpen, perm('project_manage'), async (req, res) => {
  const b = req.body;
  const upd = {
    name: String(b.name || req.project.name).trim(), client_name: b.client_name, client_email: b.client_email && b.client_email.trim().toLowerCase(),
    client_phone: b.client_phone, location: b.location, description: b.description,
    end_date: isDate(b.end_date) ? b.end_date : req.project.end_date, contract_value: b.contract_value ? num(b.contract_value) : null,
  };
  const mgr = int(b.manager_id);
  if (mgr && await S.isOrgUser(req.org.id, mgr)) { upd.manager_id = mgr; await db.run('INSERT INTO project_members (project_id, user_id) VALUES (?, ?) ON CONFLICT DO NOTHING', req.project.id, mgr); }
  if (req.project.scope === 'design_construction' && b.construction_budget !== undefined) upd.construction_budget = num(b.construction_budget);
  await db.update('projects', req.project.id, upd);
  req.flash('success', 'Project details updated.');
  res.redirect(`/projects/${req.project.id}`);
});

router.post('/projects/:pid/members', loadProject, projectOpen, perm('project_manage'), async (req, res) => {
  const uid = int(req.body.user_id);
  if (req.body.action === 'remove') {
    if (uid === req.project.manager_id) req.flash('error', 'Change the project manager before removing them.');
    else await db.run('DELETE FROM project_members WHERE project_id = ? AND user_id = ?', req.project.id, uid);
  } else if (uid && await S.isOrgUser(req.org.id, uid)) {
    const r = await db.run('INSERT INTO project_members (project_id, user_id) VALUES (?, ?) ON CONFLICT DO NOTHING', req.project.id, uid);
    if (r.changes) await N.projectCreated({ ...req.project }, req.user); // emails the team incl. new member
  }
  res.redirect(`/projects/${req.project.id}#team`);
});

// ---- Phase tracker (10 architectural phases)
router.get('/projects/:pid/phases', loadProject, async (req, res) => {
  const prog = await S.phaseProgress(req.project.id);
  res.render('projects/phases', { title: `${req.project.name} — Phase tracker`, prog });
});

async function loadPhase(req, res, next) {
  const phase = await db.get('SELECT * FROM phases WHERE id = ? AND project_id = ?', req.params.phid, req.project.id);
  if (!phase) return next(httpError(404, 'Phase not found.'));
  req.phase = phase; res.locals.phase = phase; next();
}

// ---- Phase workspace
router.get('/projects/:pid/phases/:phid', loadProject, loadPhase, async (req, res) => {
  const ph = req.phase;
  const subphases = await db.all('SELECT * FROM subphases WHERE phase_id = ? ORDER BY seq', ph.id);
  const tasks = await db.all('SELECT t.*, u.name assignee FROM tasks t LEFT JOIN users u ON u.id = t.assignee_id WHERE t.phase_id = ? ORDER BY t.due_date, t.id', ph.id);
  const deliverables = await db.all('SELECT * FROM deliverables WHERE phase_id = ? ORDER BY id', ph.id);
  const documents = await db.all(`SELECT d.*, (SELECT MAX(version) FROM document_versions v WHERE v.document_id = d.id) rev FROM documents d WHERE d.phase_id = ? ORDER BY d.id DESC`, ph.id);
  const approvals = await db.all('SELECT * FROM approvals WHERE phase_id = ? ORDER BY id DESC', ph.id);
  const review = approvals.find((a) => a.type === 'phase' && ['pending', 'revision_required', 'rejected'].includes(a.status));
  res.render('projects/phase', {
    title: `${ph.name} — ${req.project.name}`, subphases, tasks, deliverables, documents, approvals, review,
    team: await S.projectTeam(req.project.id), allPhases: await db.all('SELECT id, seq, name, status FROM phases WHERE project_id = ? ORDER BY seq', req.project.id),
  });
});

router.post('/projects/:pid/phases/:phid/subphases', loadProject, projectOpen, loadPhase, perm('task_manage'), async (req, res) => {
  const name = String(req.body.name || '').trim();
  if (name) {
    const seq = (await db.get('SELECT COALESCE(MAX(seq),0)+1 n FROM subphases WHERE phase_id = ?', req.phase.id)).n;
    await db.insert('subphases', { phase_id: req.phase.id, name, seq });
  }
  res.redirect(`/projects/${req.project.id}/phases/${req.phase.id}`);
});
router.post('/projects/:pid/phases/:phid/deliverables', loadProject, projectOpen, loadPhase, perm('task_manage'), async (req, res) => {
  const name = String(req.body.name || '').trim();
  const sub = int(req.body.subphase_id);
  const subOk = sub && await db.get('SELECT 1 FROM subphases WHERE id = ? AND phase_id = ?', sub, req.phase.id);
  if (name) await db.insert('deliverables', { project_id: req.project.id, phase_id: req.phase.id, subphase_id: subOk ? sub : null, name, due_date: isDate(req.body.due_date) ? req.body.due_date : req.phase.planned_end });
  res.redirect(`/projects/${req.project.id}/phases/${req.phase.id}`);
});
router.post('/projects/:pid/deliverables/:did', loadProject, projectOpen, perm('task_manage'), async (req, res, next) => {
  const d = await db.get('SELECT * FROM deliverables WHERE id = ? AND project_id = ?', req.params.did, req.project.id);
  if (!d) return next(httpError(404, 'Deliverable not found.'));
  const allowed = ['pending', 'in_progress', 'submitted'];
  if (req.can('project_manage')) allowed.push('approved');
  if (req.body.action === 'delete' && req.can('project_manage')) await db.run('DELETE FROM deliverables WHERE id = ?', d.id);
  else if (allowed.includes(req.body.status)) await db.run('UPDATE deliverables SET status = ? WHERE id = ?', req.body.status, d.id);
  res.redirect(`/projects/${req.project.id}/phases/${d.phase_id}`);
});

// Submit phase for internal review -> creates an approval request to the chosen reviewers
router.post('/projects/:pid/phases/:phid/submit-review', loadProject, projectOpen, loadPhase, perm('phase_submit'), async (req, res) => {
  const ph = req.phase;
  const reviewers = await filterSeq(arr(req.body.reviewers).map(Number), async (id) => id !== req.user.id && await S.isOrgUser(req.org.id, id));
  if (ph.status !== 'in_progress') { req.flash('error', 'Only an in-progress phase can be submitted for review.'); return res.redirect(`/projects/${req.project.id}/phases/${ph.id}`); }
  if (!reviewers.length) { req.flash('error', 'Choose at least one reviewer (other than yourself).'); return res.redirect(`/projects/${req.project.id}/phases/${ph.id}`); }
  const existing = await db.get("SELECT * FROM approvals WHERE phase_id = ? AND type = 'phase' AND status IN ('revision_required','rejected') ORDER BY id DESC LIMIT 1", ph.id);
  const apId = await db.tx(async () => {
    let id;
    if (existing) {
      id = existing.id;
      await db.run("UPDATE approvals SET status = 'pending', round = round + 1, requested_at = to_char(now() AT TIME ZONE 'utc', 'YYYY-MM-DD HH24:MI:SS'), decided_at = NULL, description = COALESCE(?, description) WHERE id = ?", req.body.note, id);
      await db.run('DELETE FROM approval_reviewers WHERE approval_id = ?', id);
    } else {
      id = await db.insert('approvals', { project_id: req.project.id, phase_id: ph.id, type: 'phase', title: `Phase review: ${ph.name}`, description: req.body.note, status: 'pending', requested_by: req.user.id, requested_at: new Date().toISOString().slice(0, 19).replace('T', ' ') });
    }
    for (const uid of reviewers) await db.run('INSERT INTO approval_reviewers (approval_id, user_id) VALUES (?, ?) ON CONFLICT DO NOTHING', id, uid);
    const ap = await db.get('SELECT * FROM approvals WHERE id = ?', id);
    await db.insert('approval_history', { approval_id: id, round: ap.round, user_id: req.user.id, action: existing ? 'resubmitted' : 'submitted', comment: req.body.note });
    await db.run("UPDATE phases SET status = 'in_review' WHERE id = ?", ph.id);
    await db.run("UPDATE deliverables SET status = 'submitted' WHERE phase_id = ? AND status IN ('pending','in_progress','revision_required')", ph.id);
    return id;
  });
  await N.approvalRequested(await db.get('SELECT * FROM approvals WHERE id = ?', apId), req.project, req.user, reviewers, !!existing);
  req.flash('success', 'Phase submitted for internal review — reviewers notified by email.');
  res.redirect(`/projects/${req.project.id}/phases/${ph.id}`);
});

// Manual controls for managers
router.post('/projects/:pid/phases/:phid/status', loadProject, projectOpen, loadPhase, perm('project_manage'), async (req, res) => {
  const ph = req.phase;
  if (req.body.action === 'complete' && ['in_progress', 'in_review'].includes(ph.status)) {
    const r = await S.completePhase(ph.id);
    await N.phaseCompleted(req.project, ph, r.next);
    req.flash('success', r.next ? `Phase complete. ${r.next.name} is now in progress.` : 'All applicable phases complete — run the project closure checklist.');
  } else if (req.body.action === 'start' && ph.status === 'not_started') {
    await db.run("UPDATE phases SET status = 'in_progress', started_at = ? WHERE id = ?", today(), ph.id);
  } else if (req.body.action === 'reopen' && ph.status === 'completed') {
    await db.run("UPDATE phases SET status = 'in_progress', completed_at = NULL WHERE id = ?", ph.id);
  } else if (req.body.action === 'toggle_na') {
    if (ph.status === 'na') await db.run("UPDATE phases SET status = 'not_started' WHERE id = ?", ph.id);
    else if (ph.status === 'not_started') await db.run("UPDATE phases SET status = 'na' WHERE id = ?", ph.id);
  }
  res.redirect(`/projects/${req.project.id}/phases/${ph.id}`);
});

module.exports = router;
module.exports.loadPhase = loadPhase;
