'use strict';
const router = require('express').Router();
const db = require('../db');
const S = require('../services');
const { requireOrg } = require('../mw');
const { today, addDays, daysBetween, mapSeq } = require('../util');

router.get('/dashboard', requireOrg, async (req, res) => {
  const orgId = req.org.id;
  const t0 = today();
  const projects = await mapSeq(await S.visibleProjects(orgId, req.user, req.role, { status: 'active' }), async (p) => ({ ...p, prog: await S.phaseProgress(p.id) }));
  const closedCount = (await S.visibleProjects(orgId, req.user, req.role, { status: 'closed' })).length;
  const ids = projects.map((p) => p.id);
  const inIds = ids.length ? ids.join(',') : '0';

  // ---- tasks
  const taskTotals = await db.get(`SELECT COUNT(*) total, SUM(CASE WHEN status = 'done' THEN 1 ELSE 0 END) done,
      SUM(CASE WHEN status != 'done' AND due_date < ? THEN 1 ELSE 0 END) overdue,
      SUM(CASE WHEN status != 'done' AND due_date BETWEEN ? AND ? THEN 1 ELSE 0 END) due_soon
    FROM tasks WHERE project_id IN (${inIds})`, t0, t0, addDays(t0, 3));
  const overdueByProject = Object.fromEntries((await db.all(`SELECT project_id, COUNT(*) c FROM tasks
    WHERE project_id IN (${inIds}) AND status != 'done' AND due_date < ? GROUP BY project_id`, t0)).map((r) => [r.project_id, Number(r.c)]));
  const upcomingTasks = await db.all(`SELECT t.*, p.name project_name, p.code, u.name assignee FROM tasks t JOIN projects p ON p.id = t.project_id
    LEFT JOIN users u ON u.id = t.assignee_id WHERE t.project_id IN (${inIds}) AND t.status != 'done'
    ORDER BY t.due_date IS NULL, t.due_date, t.id LIMIT 7`);

  // ---- money (only for roles that may see payments)
  const canPay = req.can('payments_view');
  const pay = canPay ? await S.paymentsSummary(orgId) : null;
  const overdueInvoices = canPay ? await db.all(`SELECT i.*, p.name project_name FROM invoices i JOIN projects p ON p.id = i.project_id
    WHERE i.org_id = ? AND i.status = 'overdue' ORDER BY i.due_date LIMIT 4`, orgId) : [];
  const overdueInvoiceProjects = new Set(canPay ? (await db.all(`SELECT DISTINCT project_id FROM invoices WHERE org_id = ? AND status = 'overdue'`, orgId)).map((r) => r.project_id) : []);
  const fee = projects.reduce((s, p) => s + (Number(p.contract_value) || 0), 0);
  const budget = projects.filter((p) => p.scope === 'design_construction').reduce((s, p) => s + (Number(p.construction_budget) || 0), 0);
  const spent = Number((await db.get(`SELECT COALESCE(SUM(amount),0) s FROM expenditures WHERE project_id IN (${inIds}) AND status = 'approved'`)).s) || 0;
  const received = canPay ? Number((await db.get(`SELECT COALESCE(SUM(pay.amount),0) s FROM payments pay JOIN invoices i ON i.id = pay.invoice_id WHERE i.project_id IN (${inIds})`)).s) || 0 : 0;

  // ---- project health (each active project in exactly one bucket, plus completed/archived)
  const health = { on_track: 0, not_started: 0, at_risk: 0, completed: closedCount };
  for (const p of projects) {
    p.atRisk = (overdueByProject[p.id] || 0) > 0 || overdueInvoiceProjects.has(p.id);
    p.health = p.atRisk ? 'at_risk' : p.prog.pct > 0 ? 'on_track' : 'not_started';
    health[p.health]++;
  }
  const avgPct = projects.length ? Math.round(projects.reduce((s, p) => s + p.prog.pct, 0) / projects.length) : 0;

  // ---- team workload (open tasks in visible active projects)
  const team = await db.all(`SELECT u.id, u.name, m.role,
      (SELECT COUNT(*) FROM tasks t WHERE t.assignee_id = u.id AND t.project_id IN (${inIds}) AND t.status != 'done') open_tasks,
      (SELECT COUNT(*) FROM tasks t WHERE t.assignee_id = u.id AND t.project_id IN (${inIds}) AND t.status != 'done' AND t.due_date < ?) overdue
    FROM memberships m JOIN users u ON u.id = m.user_id WHERE m.org_id = ? AND m.active = 1
    ORDER BY u.name`, t0, orgId);
  team.sort((a, b) => b.open_tasks - a.open_tasks || a.name.localeCompare(b.name));
  const maxOpen = Math.max(1, ...team.map((m) => Number(m.open_tasks)));

  // ---- upcoming deadlines (next 14 days, plus anything already late)
  const horizon = addDays(t0, 14);
  const events = [];
  for (const t of await db.all(`SELECT t.id, t.title, t.due_date, t.project_id, p.code FROM tasks t JOIN projects p ON p.id = t.project_id
      WHERE t.project_id IN (${inIds}) AND t.status != 'done' AND t.due_date <= ? ORDER BY t.due_date LIMIT 12`, horizon)) {
    events.push({ date: t.due_date, kind: 'Task', title: t.title, sub: t.code, url: `/projects/${t.project_id}/tasks/${t.id}` });
  }
  for (const ph of await db.all(`SELECT ph.name, ph.planned_end, ph.project_id, p.code, p.name pname FROM phases ph JOIN projects p ON p.id = ph.project_id
      WHERE ph.project_id IN (${inIds}) AND ph.status IN ('in_progress','in_review') AND ph.planned_end <= ?`, horizon)) {
    events.push({ date: ph.planned_end, kind: 'Phase end', title: ph.name, sub: `${ph.code} · ${ph.pname}`, url: `/projects/${ph.project_id}/phases` });
  }
  for (const v of await db.all(`SELECT v.visit_date, v.purpose, v.project_id, p.code FROM site_visits v JOIN projects p ON p.id = v.project_id
      WHERE v.project_id IN (${inIds}) AND v.status = 'scheduled' AND v.visit_date <= ?`, horizon)) {
    events.push({ date: v.visit_date, kind: 'Site visit', title: v.purpose, sub: v.code, url: `/projects/${v.project_id}/construction#site` });
  }
  if (canPay) {
    for (const i of await db.all(`SELECT i.id, i.number, i.due_date, i.milestone, p.code FROM invoices i JOIN projects p ON p.id = i.project_id
        WHERE i.org_id = ? AND i.status IN ('issued','partial','overdue') AND i.due_date <= ?`, orgId, horizon)) {
      events.push({ date: i.due_date, kind: 'Invoice due', title: `${i.number} — ${i.milestone}`, sub: i.code, url: `/payments/invoices/${i.id}` });
    }
  }
  events.sort((a, b) => a.date.localeCompare(b.date));
  for (const e of events) e.days = daysBetween(t0, e.date);

  const myReviews = await db.all(`SELECT a.*, p.name project_name, p.code FROM approval_reviewers r JOIN approvals a ON a.id = r.approval_id
    JOIN projects p ON p.id = a.project_id WHERE r.user_id = ? AND r.decision IS NULL AND a.status = 'pending' AND p.org_id = ?`, req.user.id, orgId);

  const hour = Number(new Date().toLocaleString('en-GB', { hour: '2-digit', hour12: false, timeZone: req.org.timezone || 'Asia/Kolkata' }));
  const greeting = hour < 12 ? 'Good morning' : hour < 17 ? 'Good afternoon' : 'Good evening';
  const dateLabel = new Date().toLocaleDateString('en-GB', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric', timeZone: req.org.timezone || 'Asia/Kolkata' });

  res.render('dashboard', {
    title: 'Organisation dashboard', greeting, dateLabel, projects, closedCount, avgPct, health,
    taskTotals: { total: Number(taskTotals.total) || 0, done: Number(taskTotals.done) || 0, overdue: Number(taskTotals.overdue) || 0, dueSoon: Number(taskTotals.due_soon) || 0 },
    upcomingTasks, pay, overdueInvoices, fee, budget, spent, received, team: team.slice(0, 7), maxOpen,
    events: events.slice(0, 8), myReviews, usage: await S.orgUsage(orgId), limits: S.orgLimits(req.org), today: t0,
  });
});

module.exports = router;
