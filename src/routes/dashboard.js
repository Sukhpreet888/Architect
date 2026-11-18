'use strict';
const router = require('express').Router();
const db = require('../db');
const S = require('../services');
const { requireOrg } = require('../mw');
const { today, addDays } = require('../util');

router.get('/dashboard', requireOrg, (req, res) => {
  const orgId = req.org.id;
  const projects = S.visibleProjects(orgId, req.user, req.role, { status: 'active' }).map((p) => ({ ...p, prog: S.phaseProgress(p.id) }));
  const ids = projects.map((p) => p.id);
  const inIds = ids.length ? ids.join(',') : '0';
  const myTasks = db.all(`SELECT t.*, p.name project_name, p.code FROM tasks t JOIN projects p ON p.id = t.project_id
    WHERE t.assignee_id = ? AND t.status != 'done' AND p.status = 'active' AND p.org_id = ? ORDER BY t.due_date IS NULL, t.due_date LIMIT 10`, req.user.id, orgId);
  const overdueTasks = db.get(`SELECT COUNT(*) c FROM tasks WHERE project_id IN (${inIds}) AND status != 'done' AND due_date < ?`, today()).c;
  const dueSoon = db.get(`SELECT COUNT(*) c FROM tasks WHERE project_id IN (${inIds}) AND status != 'done' AND due_date BETWEEN ? AND ?`, today(), addDays(today(), 3)).c;
  const myReviews = db.all(`SELECT a.*, p.name project_name, p.code FROM approval_reviewers r JOIN approvals a ON a.id = r.approval_id
    JOIN projects p ON p.id = a.project_id WHERE r.user_id = ? AND r.decision IS NULL AND a.status = 'pending' AND p.org_id = ?`, req.user.id, orgId);
  const pay = req.can('payments_view') ? S.paymentsSummary(orgId) : null;
  const overdueInvoices = req.can('payments_view') ? db.all(`SELECT i.*, p.name project_name FROM invoices i JOIN projects p ON p.id = i.project_id
    WHERE i.org_id = ? AND i.status = 'overdue' ORDER BY i.due_date LIMIT 5`, orgId) : [];
  const emailsToday = db.get("SELECT COUNT(*) c FROM email_log WHERE org_id = ? AND date(created_at) = date('now')", orgId).c;
  res.render('dashboard', {
    title: 'Organisation dashboard', projects, myTasks, overdueTasks, dueSoon, myReviews, pay, overdueInvoices, emailsToday,
    usage: S.orgUsage(orgId), limits: S.orgLimits(req.org),
  });
});

module.exports = router;
