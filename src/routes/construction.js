'use strict';
const router = require('express').Router();
const db = require('../db');
const N = require('../notify');
const S = require('../services');
const { EXPENSE_CATEGORIES } = require('../config');
const { requireOrg, perm, loadProject, projectOpen, httpError, back } = require('../mw');
const { num, int, isDate, today } = require('../util');

router.use('/projects', requireOrg);

function constructionOnly(req, res, next) {
  if (req.project.scope !== 'design_construction') {
    if (req.method === 'GET') return res.render('construction/na', { title: 'Construction' });
    return next(httpError(400, 'Construction module is only available for Design + Construction projects.'));
  }
  next();
}
const base = (req) => `/projects/${req.project.id}/construction`;
const approvedSpend = async (pid) => (await db.get("SELECT COALESCE(SUM(amount),0) s FROM expenditures WHERE project_id = ? AND status = 'approved'", pid)).s;

router.get('/projects/:pid/construction', loadProject, constructionOnly, async (req, res) => {
  const pid = req.project.id;
  const byCat = await db.all(`SELECT category, SUM(CASE WHEN status = 'approved' THEN amount ELSE 0 END) approved,
    SUM(CASE WHEN status = 'pending' THEN amount ELSE 0 END) pending FROM expenditures WHERE project_id = ? GROUP BY category`, pid);
  res.render('construction/index', {
    title: `${req.project.name} — Construction`, byCat, spent: await approvedSpend(pid),
    pending: (await db.get("SELECT COALESCE(SUM(amount),0) s FROM expenditures WHERE project_id = ? AND status = 'pending'", pid)).s,
    expenditures: await db.all('SELECT e.*, u.name creator, d.name decider FROM expenditures e LEFT JOIN users u ON u.id = e.created_by LEFT JOIN users d ON d.id = e.decided_by WHERE project_id = ? ORDER BY spent_on DESC, id DESC', pid),
    materials: await db.all('SELECT m.*, s.name supplier FROM materials m LEFT JOIN suppliers s ON s.id = m.supplier_id WHERE project_id = ? ORDER BY name', pid),
    txns: await db.all('SELECT t.*, m.name material, m.unit FROM material_txns t JOIN materials m ON m.id = t.material_id WHERE m.project_id = ? ORDER BY t.txn_date DESC, t.id DESC LIMIT 30', pid),
    suppliers: await db.all('SELECT * FROM suppliers WHERE org_id = ? ORDER BY name', req.org.id),
    visits: await db.all('SELECT v.*, u.name assignee FROM site_visits v LEFT JOIN users u ON u.id = v.assigned_to WHERE project_id = ? ORDER BY visit_date DESC', pid),
    issues: await db.all('SELECT i.*, t.status task_status, t.assignee_id, u.name assignee FROM site_issues i LEFT JOIN tasks t ON t.id = i.task_id LEFT JOIN users u ON u.id = t.assignee_id WHERE i.project_id = ? ORDER BY i.status = \'resolved\', i.id DESC', pid),
    team: await S.projectTeam(pid),
  });
});

// ---- Construction cost management
router.post('/projects/:pid/construction/budget', loadProject, projectOpen, constructionOnly, perm('project_manage'), async (req, res) => {
  await db.run('UPDATE projects SET construction_budget = ? WHERE id = ?', Math.max(0, num(req.body.budget)), req.project.id);
  req.flash('success', 'Construction budget set.');
  res.redirect(base(req));
});

async function addExpenditure(req, data) {
  const id = await db.insert('expenditures', { project_id: req.project.id, status: 'pending', created_by: req.user.id, ...data });
  const exp = await db.get('SELECT * FROM expenditures WHERE id = ?', id);
  await N.expenditureSubmitted(exp, req.project);
  return id;
}

router.post('/projects/:pid/construction/expenditures', loadProject, projectOpen, constructionOnly, perm('construction_manage'), async (req, res) => {
  const b = req.body;
  if (!EXPENSE_CATEGORIES[b.category] || !String(b.description || '').trim() || !(num(b.amount) > 0)) {
    req.flash('error', 'Category, description and a positive amount are required.'); return res.redirect(base(req));
  }
  await addExpenditure(req, { category: b.category, description: b.description.trim(), vendor: b.vendor, amount: num(b.amount), spent_on: isDate(b.spent_on) ? b.spent_on : today(), invoice_ref: b.invoice_ref });
  req.flash('success', 'Expenditure recorded — sent for approval by email.');
  res.redirect(`${base(req)}#cost`);
});

router.post('/projects/:pid/construction/expenditures/:eid', loadProject, projectOpen, constructionOnly, perm('expenditure_approve'), async (req, res, next) => {
  const exp = await db.get('SELECT * FROM expenditures WHERE id = ? AND project_id = ?', req.params.eid, req.project.id);
  if (!exp) return next(httpError(404, 'Expenditure not found.'));
  const status = req.body.decision === 'approve' ? 'approved' : req.body.decision === 'reject' ? 'rejected' : null;
  if (!status || exp.status !== 'pending') { req.flash('error', 'Nothing to decide.'); return res.redirect(base(req)); }
  const before = await approvedSpend(req.project.id);
  await db.run('UPDATE expenditures SET status = ?, decided_by = ? WHERE id = ?', status, req.user.id, exp.id);
  await N.expenditureDecided({ ...exp, status }, req.project, req.user);
  const budget = req.project.construction_budget;
  const after = await approvedSpend(req.project.id);
  if (budget > 0) {
    for (const th of [0.8, 1]) if (before < budget * th && after >= budget * th) { await N.budgetAlert(req.project, after, budget); break; }
  }
  req.flash('success', `Expenditure ${status}.`);
  res.redirect(`${base(req)}#cost`);
});

// ---- Materials & inventory
router.post('/projects/:pid/construction/suppliers', loadProject, projectOpen, constructionOnly, perm('construction_manage'), async (req, res) => {
  if (!String(req.body.name || '').trim()) { req.flash('error', 'Supplier name required.'); return res.redirect(base(req)); }
  await db.insert('suppliers', { org_id: req.org.id, name: req.body.name.trim(), contact: req.body.contact, email: req.body.email, phone: req.body.phone });
  req.flash('success', 'Supplier added.');
  res.redirect(`${base(req)}#materials`);
});
router.post('/projects/:pid/construction/materials', loadProject, projectOpen, constructionOnly, perm('construction_manage'), async (req, res) => {
  const b = req.body;
  if (!String(b.name || '').trim()) { req.flash('error', 'Material name required.'); return res.redirect(base(req)); }
  const sup = int(b.supplier_id);
  await db.insert('materials', { project_id: req.project.id, name: b.name.trim(), unit: b.unit || 'nos', reorder_level: Math.max(0, num(b.reorder_level)), stock: 0, supplier_id: sup && await db.get('SELECT 1 FROM suppliers WHERE id = ? AND org_id = ?', sup, req.org.id) ? sup : null });
  req.flash('success', 'Material added.');
  res.redirect(`${base(req)}#materials`);
});
router.post('/projects/:pid/construction/materials/:mid/txn', loadProject, projectOpen, constructionOnly, perm('construction_manage'), async (req, res, next) => {
  const m = await db.get('SELECT * FROM materials WHERE id = ? AND project_id = ?', req.params.mid, req.project.id);
  if (!m) return next(httpError(404, 'Material not found.'));
  const kind = req.body.kind === 'purchase' ? 'purchase' : 'consumption';
  const qty = num(req.body.qty);
  if (!(qty > 0)) { req.flash('error', 'Quantity must be positive.'); return res.redirect(`${base(req)}#materials`); }
  if (kind === 'consumption' && qty > m.stock) { req.flash('error', `Only ${m.stock} ${m.unit} in stock.`); return res.redirect(`${base(req)}#materials`); }
  const unitCost = num(req.body.unit_cost);
  const date = isDate(req.body.txn_date) ? req.body.txn_date : today();
  await db.tx(async () => {
    let expId = null;
    if (kind === 'purchase' && unitCost > 0) {
      const sup = m.supplier_id && await db.get('SELECT name FROM suppliers WHERE id = ?', m.supplier_id);
      expId = await addExpenditure(req, { category: 'material', description: `Purchase: ${qty} ${m.unit} ${m.name}`, vendor: sup && sup.name, amount: Math.round(qty * unitCost * 100) / 100, spent_on: date, invoice_ref: req.body.note });
    }
    await db.insert('material_txns', { material_id: m.id, kind, qty, unit_cost: unitCost, txn_date: date, note: req.body.note, expenditure_id: expId, created_by: req.user.id });
    await db.run(`UPDATE materials SET stock = stock ${kind === 'purchase' ? '+' : '-'} ? WHERE id = ?`, qty, m.id);
  });
  const after = await db.get('SELECT * FROM materials WHERE id = ?', m.id);
  if (kind === 'consumption' && m.stock > m.reorder_level && after.stock <= after.reorder_level) {
    await N.reorderAlert(after, req.project, m.supplier_id && await db.get('SELECT * FROM suppliers WHERE id = ?', m.supplier_id));
    req.flash('error', `${m.name} is at or below its reorder level — alert emailed.`);
  }
  req.flash('success', kind === 'purchase' ? 'Purchase recorded (expenditure created for approval).' : 'Consumption recorded (stock reduced).');
  res.redirect(`${base(req)}#materials`);
});

// ---- Site supervision
router.post('/projects/:pid/construction/visits', loadProject, projectOpen, constructionOnly, perm('construction_manage'), async (req, res) => {
  const b = req.body; const a = int(b.assigned_to);
  if (!isDate(b.visit_date) || !String(b.purpose || '').trim()) { req.flash('error', 'Visit date and purpose are required.'); return res.redirect(base(req)); }
  const id = await db.insert('site_visits', { project_id: req.project.id, visit_date: b.visit_date, purpose: b.purpose.trim(), assigned_to: a && await S.isOrgUser(req.org.id, a) ? a : req.user.id, created_by: req.user.id });
  await N.siteVisitScheduled(await db.get('SELECT * FROM site_visits WHERE id = ?', id), req.project, false);
  req.flash('success', 'Site visit scheduled — inspector notified by email.');
  res.redirect(`${base(req)}#site`);
});
router.post('/projects/:pid/construction/visits/:vid', loadProject, projectOpen, constructionOnly, perm('construction_manage'), async (req, res, next) => {
  const v = await db.get('SELECT * FROM site_visits WHERE id = ? AND project_id = ?', req.params.vid, req.project.id);
  if (!v) return next(httpError(404, 'Visit not found.'));
  if (req.body.action === 'cancel') await db.run("UPDATE site_visits SET status = 'cancelled' WHERE id = ?", v.id);
  else {
    if (!String(req.body.report || '').trim()) { req.flash('error', 'Write the inspection report.'); return res.redirect(`${base(req)}#site`); }
    await db.run("UPDATE site_visits SET status = 'completed', report = ?, completed_at = ? WHERE id = ?", req.body.report.trim(), today(), v.id);
  }
  req.flash('success', 'Site visit updated.');
  res.redirect(`${base(req)}#site`);
});
router.post('/projects/:pid/construction/issues', loadProject, projectOpen, constructionOnly, perm('construction_manage'), async (req, res) => {
  const b = req.body;
  if (!String(b.title || '').trim()) { req.flash('error', 'Issue title required.'); return res.redirect(base(req)); }
  const visit = int(b.visit_id);
  await db.insert('site_issues', { project_id: req.project.id, visit_id: visit && await db.get('SELECT 1 FROM site_visits WHERE id = ? AND project_id = ?', visit, req.project.id) ? visit : null, title: b.title.trim(), description: b.description, severity: ['low', 'medium', 'high', 'critical'].includes(b.severity) ? b.severity : 'medium', created_by: req.user.id });
  req.flash('success', 'Issue logged.');
  res.redirect(`${base(req)}#site`);
});
router.post('/projects/:pid/construction/issues/:iid', loadProject, projectOpen, constructionOnly, perm('construction_manage'), async (req, res, next) => {
  const issue = await db.get('SELECT * FROM site_issues WHERE id = ? AND project_id = ?', req.params.iid, req.project.id);
  if (!issue) return next(httpError(404, 'Issue not found.'));
  if (req.body.action === 'assign') {
    const a = int(req.body.assignee_id);
    if (!a || !await S.isOrgUser(req.org.id, a) || !isDate(req.body.due_date)) { req.flash('error', 'Choose an assignee and due date.'); return res.redirect(`${base(req)}#site`); }
    const phase = await db.get("SELECT id FROM phases WHERE project_id = ? AND status IN ('in_progress','in_review') ORDER BY seq LIMIT 1", req.project.id);
    const taskId = await db.insert('tasks', { project_id: req.project.id, phase_id: phase && phase.id, title: `Rectify: ${issue.title}`, description: issue.description, assignee_id: a, due_date: req.body.due_date, priority: issue.severity === 'critical' ? 'urgent' : issue.severity === 'high' ? 'high' : 'medium', source: 'site_issue', created_by: req.user.id });
    await db.run("UPDATE site_issues SET task_id = ?, status = 'in_progress' WHERE id = ?", taskId, issue.id);
    await db.run('INSERT INTO project_members (project_id, user_id) VALUES (?, ?) ON CONFLICT DO NOTHING', req.project.id, a);
    await N.taskAssigned(await db.get('SELECT * FROM tasks WHERE id = ?', taskId), req.project, req.user);
    req.flash('success', 'Rectification task assigned — emailed to assignee.');
  } else if (req.body.action === 'resolve') {
    await db.run("UPDATE site_issues SET status = 'resolved' WHERE id = ?", issue.id);
    if (issue.task_id) {
      await db.run("UPDATE tasks SET status = 'done', progress = 100, completed_at = ? WHERE id = ? AND status != 'done'", today(), issue.task_id);
      const t = await db.get('SELECT phase_id FROM tasks WHERE id = ?', issue.task_id);
      const r = t && await S.syncPhaseWithTasks(t.phase_id);
      if (r && r.completed) await N.phaseCompleted(req.project, r.phase, r.next);
    }
    req.flash('success', 'Issue resolved.');
  }
  res.redirect(back(req, `${base(req)}#site`));
});

module.exports = router;
