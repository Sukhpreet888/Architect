'use strict';
/**
 * Cost management tab (every project): construction work, labour, material, site supervision, equipment and
 * other costs — recorded per entry (optionally quantity × rate), approved by Admin/PM/Accountant, summarised
 * against per-category budgets, and rolled up per day.
 */
const router = require('express').Router();
const db = require('../db');
const N = require('../notify');
const R = require('../reports');
const { EXPENSE_CATEGORIES } = require('../config');
const { requireOrg, perm, loadProject, projectOpen, httpError, back } = require('../mw');
const { num, int, isDate, today, addDays, daysBetween, fmtDate, fmtMoney } = require('../util');

router.use('/projects', requireOrg);
const CATS = Object.keys(EXPENSE_CATEGORIES);
const base = (req) => `/projects/${req.project.id}/costs`;

const approvedTotal = async (pid, category) => (category
  ? await db.get("SELECT COALESCE(SUM(amount),0) s FROM expenditures WHERE project_id = ? AND status = 'approved' AND category = ?", pid, category)
  : await db.get("SELECT COALESCE(SUM(amount),0) s FROM expenditures WHERE project_id = ? AND status = 'approved'", pid)).s;

/** Record a cost entry (status pending) and email the approvers. Used by this tab and by material purchases. */
async function addCost(project, user, data) {
  const id = await db.insert('expenditures', { project_id: project.id, status: 'pending', created_by: user.id, ...data });
  const exp = await db.get('SELECT * FROM expenditures WHERE id = ?', id);
  await N.expenditureSubmitted(exp, project);
  return id;
}

function range(q, project) {
  let from = isDate(q.from) ? q.from : null; let to = isDate(q.to) ? q.to : null;
  if (q.period === 'all') { from = null; to = null; }
  if (!from && !to && q.period !== 'all') { to = today(); from = addDays(to, -29); }
  if (from && to && from > to) [from, to] = [to, from];
  return { from, to, all: !from && !to };
}
function rangeSql(r, col = 'spent_on') {
  const parts = []; const args = [];
  if (r.from) { parts.push(`${col} >= ?`); args.push(r.from); }
  if (r.to) { parts.push(`${col} <= ?`); args.push(r.to); }
  return { sql: parts.length ? ` AND ${parts.join(' AND ')}` : '', args };
}

async function costData(req) {
  const p = req.project; const rg = range(req.query, p); const w = rangeSql(rg);
  const budgets = Object.fromEntries((await db.all('SELECT category, amount FROM cost_budgets WHERE project_id = ?', p.id)).map((b) => [b.category, b.amount]));
  const byCatRows = await db.all(`SELECT category,
      SUM(CASE WHEN status = 'approved' THEN amount ELSE 0 END) approved,
      SUM(CASE WHEN status = 'pending' THEN amount ELSE 0 END) pending,
      COUNT(*) entries FROM expenditures WHERE project_id = ? GROUP BY category`, p.id);
  const byCat = Object.fromEntries(byCatRows.map((r) => [r.category, r]));
  const categories = CATS.map((k) => ({
    key: k, label: EXPENSE_CATEGORIES[k], budget: budgets[k] || 0,
    approved: Number(byCat[k]?.approved || 0), pending: Number(byCat[k]?.pending || 0), entries: Number(byCat[k]?.entries || 0),
  }));
  const totals = categories.reduce((t, c) => ({ approved: t.approved + c.approved, pending: t.pending + c.pending }), { approved: 0, pending: 0 });

  // daily cost (approved, by category) + pending per day, within the selected range
  const dailyRows = await db.all(`SELECT spent_on, category, status, SUM(amount) s FROM expenditures
    WHERE project_id = ? AND status IN ('approved','pending')${w.sql} GROUP BY spent_on, category, status ORDER BY spent_on DESC`, p.id, ...w.args);
  const daysMap = new Map();
  for (const r of dailyRows) {
    if (!daysMap.has(r.spent_on)) daysMap.set(r.spent_on, { date: r.spent_on, cats: {}, total: 0, pending: 0 });
    const d = daysMap.get(r.spent_on);
    if (r.status === 'approved') { d.cats[r.category] = (d.cats[r.category] || 0) + Number(r.s); d.total += Number(r.s); } else d.pending += Number(r.s);
  }
  const days = [...daysMap.values()];
  const rangeTotal = days.reduce((a, d) => a + d.total, 0);
  const span = rg.all ? null : daysBetween(rg.from, rg.to) + 1;

  // cost register (filterable)
  const f = { category: CATS.includes(req.query.category) ? req.query.category : '', status: ['pending', 'approved', 'rejected'].includes(req.query.status) ? req.query.status : '' };
  let rsql = ''; const rargs = [];
  if (f.category) { rsql += ' AND e.category = ?'; rargs.push(f.category); }
  if (f.status) { rsql += ' AND e.status = ?'; rargs.push(f.status); }
  const rw = rangeSql(rg, 'e.spent_on');
  const register = await db.all(`SELECT e.*, u.name creator, d.name decider, v.visit_date, v.purpose visit_purpose FROM expenditures e
    LEFT JOIN users u ON u.id = e.created_by LEFT JOIN users d ON d.id = e.decided_by LEFT JOIN site_visits v ON v.id = e.visit_id
    WHERE e.project_id = ?${rsql}${rw.sql} ORDER BY e.spent_on DESC, e.id DESC LIMIT 500`, p.id, ...rargs, ...rw.args);
  return { rg, budgets, categories, totals, days, rangeTotal, span, register, f };
}

router.get('/projects/:pid/costs', loadProject, perm('cost_view'), async (req, res) => {
  const data = await costData(req);
  res.render('costs/index', {
    title: `${req.project.name} — Cost management`, ...data, cats: EXPENSE_CATEGORIES,
    visits: await db.all('SELECT id, visit_date, purpose FROM site_visits WHERE project_id = ? ORDER BY visit_date DESC LIMIT 50', req.project.id),
  });
});

// ---- record a cost
router.post('/projects/:pid/costs', loadProject, projectOpen, perm('cost_record'), async (req, res) => {
  const b = req.body;
  const qty = b.qty === '' || b.qty === undefined ? null : num(b.qty, NaN);
  const rate = b.rate === '' || b.rate === undefined ? null : num(b.rate, NaN);
  let amount = b.amount === '' || b.amount === undefined ? null : num(b.amount, NaN);
  const errors = [];
  if (!EXPENSE_CATEGORIES[b.category]) errors.push('Choose a cost category.');
  if (!String(b.description || '').trim()) errors.push('Description is required.');
  if ((qty !== null && !(qty > 0)) || (rate !== null && !(rate >= 0))) errors.push('Quantity and rate must be positive numbers.');
  if (amount === null && qty !== null && rate !== null) amount = Math.round(qty * rate * 100) / 100;
  if (!(amount > 0)) errors.push('Enter an amount, or a quantity and rate.');
  if (b.spent_on && !isDate(b.spent_on)) errors.push('Invalid date.');
  if (b.spent_on && b.spent_on > today()) errors.push('The cost date cannot be in the future.');
  const visit = int(b.visit_id);
  const visitOk = visit && await db.get('SELECT 1 FROM site_visits WHERE id = ? AND project_id = ?', visit, req.project.id);
  if (errors.length) { req.flash('error', errors.join(' ')); return res.redirect(back(req, base(req))); }
  await addCost(req.project, req.user, {
    category: b.category, description: b.description.trim(), vendor: b.vendor, amount, qty, unit: b.unit, rate,
    spent_on: b.spent_on || today(), invoice_ref: b.invoice_ref, visit_id: visitOk ? visit : null,
  });
  req.flash('success', `${EXPENSE_CATEGORIES[b.category]} cost of ${fmtMoney(amount, req.org.currency)} recorded — sent for approval by email.`);
  res.redirect(back(req, base(req)));
});

// ---- approve / reject / delete
router.post('/projects/:pid/costs/:eid', loadProject, projectOpen, async (req, res, next) => {
  const exp = await db.get('SELECT * FROM expenditures WHERE id = ? AND project_id = ?', req.params.eid, req.project.id);
  if (!exp) return next(httpError(404, 'Cost entry not found.'));
  if (req.body.action === 'delete') {
    if (exp.status !== 'pending' || (exp.created_by !== req.user.id && !req.can('expenditure_approve'))) {
      req.flash('error', 'Only pending entries can be deleted, by their author or an approver.'); return res.redirect(back(req, base(req)));
    }
    await db.run('DELETE FROM expenditures WHERE id = ?', exp.id);
    req.flash('success', 'Cost entry deleted.');
    return res.redirect(back(req, base(req)));
  }
  if (!req.can('expenditure_approve')) return next(httpError(403, 'Only Admin, Project Manager or Accountant can approve costs.'));
  const status = req.body.decision === 'approve' ? 'approved' : req.body.decision === 'reject' ? 'rejected' : null;
  if (!status || exp.status !== 'pending') { req.flash('error', 'Nothing to decide.'); return res.redirect(back(req, base(req))); }
  const before = await approvedTotal(req.project.id); const catBefore = await approvedTotal(req.project.id, exp.category);
  await db.run('UPDATE expenditures SET status = ?, decided_by = ? WHERE id = ?', status, req.user.id, exp.id);
  await N.expenditureDecided({ ...exp, status }, req.project, req.user);
  if (status === 'approved') {
    // budget alerts by email: overall at 80% and 100%, category at 100%
    const budget = req.project.construction_budget; const after = before + Number(exp.amount);
    if (budget > 0) for (const th of [1, 0.8]) if (before < budget * th && after >= budget * th) { await N.budgetAlert(req.project, after, budget); break; }
    const cb = await db.get('SELECT amount FROM cost_budgets WHERE project_id = ? AND category = ?', req.project.id, exp.category);
    if (cb && cb.amount > 0 && catBefore < cb.amount && catBefore + Number(exp.amount) >= cb.amount) {
      await N.budgetAlert(req.project, catBefore + Number(exp.amount), cb.amount, EXPENSE_CATEGORIES[exp.category]);
    }
  }
  req.flash('success', `Cost ${status}.`);
  res.redirect(back(req, base(req)));
});

// ---- budgets (total + per category)
router.post('/projects/:pid/costs-budget', loadProject, projectOpen, perm('project_manage'), async (req, res) => {
  await db.tx(async () => {
    await db.run('UPDATE projects SET construction_budget = ? WHERE id = ?', Math.max(0, num(req.body.total)), req.project.id);
    for (const k of CATS) {
      const v = Math.max(0, num(req.body[`budget_${k}`]));
      await db.run(`INSERT INTO cost_budgets (project_id, category, amount) VALUES (?, ?, ?)
        ON CONFLICT (project_id, category) DO UPDATE SET amount = EXCLUDED.amount`, req.project.id, k, v);
    }
  });
  req.flash('success', 'Budgets saved.');
  res.redirect(base(req));
});

// ---- export (Excel / PDF)
router.get('/projects/:pid/costs/export', loadProject, perm('cost_view'), async (req, res) => {
  const d = await costData(req);
  const money = (n) => fmtMoney(n, req.org.currency);
  const period = d.rg.all ? 'All time' : `${fmtDate(d.rg.from)} – ${fmtDate(d.rg.to)}`;
  const report = {
    title: `Cost management — ${req.project.name}`, subtitle: `${req.org.name} · ${period} · generated ${fmtDate(today())}`,
    sections: [
      { heading: 'Summary by category', kpis: [['Total budget', money(req.project.construction_budget)], ['Approved cost', money(d.totals.approved)], ['Pending approval', money(d.totals.pending)], ['Remaining', money(req.project.construction_budget - d.totals.approved)]],
        table: { columns: ['Category', 'Budget', 'Approved', 'Pending', 'Remaining'], rows: d.categories.map((c) => [c.label, money(c.budget), money(c.approved), money(c.pending), c.budget ? money(c.budget - c.approved) : '—']) } },
      { heading: `Daily cost (${period})`, table: { columns: ['Date', ...d.categories.map((c) => c.label), 'Total approved', 'Pending'],
        rows: d.days.map((day) => [fmtDate(day.date), ...d.categories.map((c) => (day.cats[c.key] ? money(day.cats[c.key]) : '—')), money(day.total), day.pending ? money(day.pending) : '—']) } },
      { heading: 'Cost register', table: { columns: ['Date', 'Category', 'Description', 'Qty × rate', 'Vendor / payee', 'Amount', 'Status'],
        rows: d.register.map((e) => [fmtDate(e.spent_on), EXPENSE_CATEGORIES[e.category] || e.category, e.description, e.qty ? `${e.qty} ${e.unit || ''} × ${money(e.rate)}` : '—', e.vendor || '—', money(e.amount), e.status]) } },
    ],
  };
  const name = `costs-${req.project.code}`;
  if (req.query.format === 'pdf') return res.attachment(`${name}.pdf`).type('application/pdf').send(await R.toPdf(report));
  const buf = await R.toXlsx(report);
  res.attachment(`${name}.xlsx`).type('application/vnd.openxmlformats-officedocument.spreadsheetml.sheet').send(Buffer.from(buf));
});

module.exports = router;
module.exports.addCost = addCost;
