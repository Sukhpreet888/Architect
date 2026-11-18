'use strict';
const router = require('express').Router();
const db = require('../db');
const N = require('../notify');
const S = require('../services');
const R = require('../reports');
const { requireOrg, perm, loadProject } = require('../mw');
const { fmtDate, fmtMoney, today, esc } = require('../util');

router.use('/projects', requireOrg);

router.get('/projects/:pid/closure', loadProject, (req, res) => {
  const p = req.project;
  const check = S.closureChecklist(p);
  const pending = {
    tasks: db.all("SELECT t.*, u.name assignee FROM tasks t LEFT JOIN users u ON u.id = t.assignee_id WHERE project_id = ? AND status != 'done' ORDER BY due_date", p.id),
    deliverables: db.all("SELECT d.* FROM deliverables d JOIN phases ph ON ph.id = d.phase_id WHERE d.project_id = ? AND ph.status != 'na' AND d.status != 'approved'", p.id),
    approvals: db.all("SELECT * FROM approvals WHERE project_id = ? AND status IN ('pending','revision_required')", p.id),
    invoices: db.all("SELECT * FROM invoices WHERE project_id = ? AND status IN ('issued','partial','overdue','disputed')", p.id).map((i) => ({ ...i, ...S.invoiceTotals(i) })),
  };
  res.render('projects/closure', { title: `${p.name} — Project closure`, check, pending });
});

router.post('/projects/:pid/closure', loadProject, perm('project_close'), (req, res) => {
  const p = req.project;
  if (p.status !== 'active') return res.redirect(`/projects/${p.id}/closure`);
  const check = S.closureChecklist(p);
  if (!check.complete) {
    req.flash('error', 'Closure checklist incomplete — complete the pending items first.');
    return res.redirect(`/projects/${p.id}/closure`);
  }
  // generate closure report snapshot, then close & archive
  const report = R.projectReport(req.org, p);
  const pay = S.paymentsSummary(req.org.id, p.id);
  const html = report.sections.map((s) => `<h3>${esc(s.heading)}</h3>${s.kpis ? `<ul>${s.kpis.map(([k, v]) => `<li><b>${esc(k)}:</b> ${esc(v)}</li>`).join('')}</ul>` : ''}${s.table ? `<table><tr>${s.table.columns.map((c) => `<th>${esc(c)}</th>`).join('')}</tr>${s.table.rows.map((r) => `<tr>${r.map((c) => `<td>${esc(c)}</td>`).join('')}</tr>`).join('')}</table>` : ''}`).join('');
  db.run("UPDATE projects SET status = 'closed', closed_at = ?, closure_report = ? WHERE id = ?", today(), `<p>Closed on ${fmtDate(today())} by ${esc(req.user.name)}.</p>${req.body.notes ? `<p><b>Closing notes:</b> ${esc(req.body.notes)}</p>` : ''}${html}`, p.id);
  db.run("UPDATE approvals SET status = 'cancelled' WHERE project_id = ? AND status = 'draft'", p.id);
  N.projectClosed(p, [['Project', `${p.code} · ${p.name}`], ['Closed on', fmtDate(today())], ['Total invoiced', fmtMoney(pay.receivable, req.org.currency)], ['Total received', fmtMoney(pay.received, req.org.currency)]]);
  req.flash('success', 'Project closed, closure report generated and project archived.');
  res.redirect(`/projects/${p.id}/closure`);
});

module.exports = router;
