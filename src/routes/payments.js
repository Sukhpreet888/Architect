'use strict';
const fs = require('fs');
const router = require('express').Router();
const db = require('../db');
const N = require('../notify');
const S = require('../services');
const { PAYMENT_METHODS, INVOICE_REMINDERS } = require('../config');
const { requireOrg, perm, httpError, back } = require('../mw');
const { single, filePath, PROOF_EXT } = require('../upload');
const { num, int, isDate, today, addDays } = require('../util');

router.use('/payments', requireOrg, perm('payments_view'));

function invoiceList(orgId, where = '', args = []) {
  return db.all(`SELECT i.*, p.name project_name, p.code, p.client_name, p.client_email FROM invoices i JOIN projects p ON p.id = i.project_id
    WHERE i.org_id = ? ${where} ORDER BY i.due_date DESC, i.id DESC`, orgId, ...args).map((i) => ({ ...i, ...S.invoiceTotals(i) }));
}

// ---- Payments dashboard (Receivable, Received, Pending, Overdue, Collection rate)
router.get('/payments', (req, res) => {
  db.all("SELECT id FROM invoices WHERE org_id = ? AND status IN ('issued','partial','overdue')", req.org.id).forEach((i) => S.refreshInvoiceStatus(i.id));
  const summary = S.paymentsSummary(req.org.id);
  const invoices = invoiceList(req.org.id);
  const upcoming = invoices.filter((i) => ['issued', 'partial'].includes(i.status) && i.due_date <= addDays(today(), 7));
  const recent = db.all(`SELECT pay.*, i.number, p.name project_name FROM payments pay JOIN invoices i ON i.id = pay.invoice_id
    JOIN projects p ON p.id = i.project_id WHERE i.org_id = ? ORDER BY pay.paid_on DESC, pay.id DESC LIMIT 10`, req.org.id);
  res.render('payments/index', { title: 'Payments — client receivables', summary, invoices: invoices.slice(0, 15), upcoming, recent });
});

router.get('/payments/invoices', (req, res) => {
  const st = req.query.status;
  const pid = int(req.query.project);
  let where = ''; const args = [];
  if (st) { where += ' AND i.status = ?'; args.push(st); }
  if (pid) { where += ' AND i.project_id = ?'; args.push(pid); }
  res.render('payments/invoices', {
    title: 'Invoices', invoices: invoiceList(req.org.id, where, args), status: st, projectFilter: pid,
    projects: db.all('SELECT id, code, name FROM projects WHERE org_id = ? ORDER BY name', req.org.id),
  });
});

router.get('/payments/invoices/new', perm('invoice_manage'), (req, res) => {
  res.render('payments/invoice-form', {
    title: 'Create invoice', inv: { project_id: int(req.query.project), due_date: addDays(today(), 15), issue_date: today(), tax: 0 },
    projects: db.all("SELECT id, code, name, client_email FROM projects WHERE org_id = ? AND status = 'active' ORDER BY name", req.org.id),
  });
});

router.post('/payments/invoices', perm('invoice_manage'), (req, res) => {
  const b = req.body; const errors = [];
  const project = db.get("SELECT * FROM projects WHERE id = ? AND org_id = ? AND status = 'active'", b.project_id, req.org.id);
  if (!project) errors.push('Select an active project.');
  if (!String(b.milestone || '').trim()) errors.push('Milestone is required.');
  if (!(num(b.amount) > 0)) errors.push('Amount must be greater than zero.');
  if (!isDate(b.due_date)) errors.push('Due date is required.');
  if (b.action === 'issue' && project && !project.client_email) errors.push('The project has no client email — add one before issuing (invoices and reminders are sent by email).');
  if (errors.length) { req.flash('error', errors.join(' ')); return res.redirect(`/payments/invoices/new${project ? `?project=${project.id}` : ''}`); }
  const id = db.insert('invoices', {
    org_id: req.org.id, project_id: project.id, number: S.nextInvoiceNumber(req.org), milestone: b.milestone.trim(), amount: num(b.amount),
    tax: num(b.tax), issue_date: isDate(b.issue_date) ? b.issue_date : today(), due_date: b.due_date, notes: b.notes, status: 'draft', created_by: req.user.id,
  });
  if (b.action === 'issue') issue(id, project);
  req.flash('success', b.action === 'issue' ? 'Invoice issued and emailed to the client and project team.' : 'Invoice saved as draft.');
  res.redirect(`/payments/invoices/${id}`);
});

function issue(id, project) {
  db.run("UPDATE invoices SET status = 'issued', issue_date = COALESCE(issue_date, ?) WHERE id = ?", today(), id);
  S.refreshInvoiceStatus(id);
  N.invoiceIssued(db.get('SELECT * FROM invoices WHERE id = ?', id), project);
}

function loadInvoice(req, res, next) {
  const inv = db.get('SELECT * FROM invoices WHERE id = ? AND org_id = ?', req.params.iid, req.org.id);
  if (!inv) return next(httpError(404, 'Invoice not found.'));
  req.invoice = inv; req.invProject = db.get('SELECT * FROM projects WHERE id = ?', inv.project_id); next();
}

router.get('/payments/invoices/:iid', loadInvoice, (req, res) => {
  S.refreshInvoiceStatus(req.invoice.id);
  const inv = db.get('SELECT * FROM invoices WHERE id = ?', req.invoice.id);
  const sent = new Set(db.all("SELECT rkey FROM reminders_sent WHERE entity = 'invoice' AND entity_id = ?", inv.id).map((r) => r.rkey));
  const schedule = INVOICE_REMINDERS.map((r) => ({ ...r, date: addDays(inv.due_date, r.offset), sent: sent.has(r.key) }));
  res.render('payments/invoice', {
    title: `Invoice ${inv.number}`, inv, totals: S.invoiceTotals(inv), project: req.invProject, schedule,
    payments: db.all('SELECT pay.*, u.name recorder FROM payments pay LEFT JOIN users u ON u.id = pay.recorded_by WHERE invoice_id = ? ORDER BY paid_on, id', inv.id),
    emails: db.all("SELECT id, to_email, subject, status, created_at FROM email_log WHERE org_id = ? AND subject LIKE ? ORDER BY id DESC LIMIT 30", req.org.id, `%${inv.number}%`),
  });
});

router.post('/payments/invoices/:iid/status', perm('invoice_manage'), loadInvoice, (req, res) => {
  const inv = req.invoice; const action = req.body.action;
  if (req.invProject.status !== 'active') { req.flash('error', 'Project is closed.'); return res.redirect(back(req)); }
  if (action === 'issue' && inv.status === 'draft') {
    if (!req.invProject.client_email) { req.flash('error', 'Add a client email to the project before issuing.'); return res.redirect(back(req)); }
    issue(inv.id, req.invProject); req.flash('success', 'Invoice issued and emailed.');
  } else if (action === 'dispute' && ['issued', 'partial', 'overdue'].includes(inv.status)) {
    db.run("UPDATE invoices SET status = 'disputed' WHERE id = ?", inv.id); req.flash('success', 'Marked as disputed — reminders paused.');
  } else if (action === 'resolve' && inv.status === 'disputed') {
    db.run("UPDATE invoices SET status = 'issued' WHERE id = ?", inv.id); S.refreshInvoiceStatus(inv.id); req.flash('success', 'Dispute resolved — reminders resumed.');
  } else if (action === 'delete' && inv.status === 'draft') {
    db.run('DELETE FROM invoices WHERE id = ?', inv.id); req.flash('success', 'Draft deleted.'); return res.redirect('/payments/invoices');
  } else if (action === 'resend' && ['issued', 'partial', 'overdue'].includes(inv.status)) {
    N.invoiceIssued(inv, req.invProject); req.flash('success', 'Invoice re-sent by email.');
  } else if (action === 'update' && inv.status === 'draft') {
    db.update('invoices', inv.id, { milestone: req.body.milestone || inv.milestone, amount: num(req.body.amount, inv.amount), tax: num(req.body.tax, inv.tax), due_date: isDate(req.body.due_date) ? req.body.due_date : inv.due_date, notes: req.body.notes });
    req.flash('success', 'Draft updated.');
  } else if (action === 'due_date' && isDate(req.body.due_date) && !['paid', 'draft'].includes(inv.status)) {
    db.run('UPDATE invoices SET due_date = ? WHERE id = ?', req.body.due_date, inv.id);
    db.run("DELETE FROM reminders_sent WHERE entity = 'invoice' AND entity_id = ?", inv.id); // new schedule
    if (inv.status === 'overdue') db.run("UPDATE invoices SET status = 'issued' WHERE id = ?", inv.id);
    S.refreshInvoiceStatus(inv.id); req.flash('success', 'Due date changed — reminder schedule reset.');
  }
  res.redirect(`/payments/invoices/${inv.id}`);
});

// ---- Transactions: record payment (partial / full, method, reference, proof)
router.get('/payments/transactions', (req, res) => {
  const rows = db.all(`SELECT pay.*, i.number, i.id invoice_id, p.name project_name, u.name recorder FROM payments pay JOIN invoices i ON i.id = pay.invoice_id
    JOIN projects p ON p.id = i.project_id LEFT JOIN users u ON u.id = pay.recorded_by WHERE i.org_id = ? ORDER BY pay.paid_on DESC, pay.id DESC`, req.org.id);
  const open = invoiceList(req.org.id, "AND i.status IN ('issued','partial','overdue','disputed')");
  res.render('payments/transactions', { title: 'Transactions', rows, open, preselect: int(req.query.invoice) });
});

router.post('/payments/transactions', perm('invoice_manage'), single('proof', PROOF_EXT), (req, res) => {
  const b = req.body;
  const inv = db.get('SELECT * FROM invoices WHERE id = ? AND org_id = ?', b.invoice_id, req.org.id);
  const fail = (m) => { req.flash('error', m); return res.redirect(back(req, '/payments/transactions')); };
  if (req.uploadError) return fail(req.uploadError);
  if (!inv || !['issued', 'partial', 'overdue', 'disputed'].includes(inv.status)) return fail('Select an issued, unpaid invoice.');
  const { balance } = S.invoiceTotals(inv);
  const amount = Math.round(num(b.amount) * 100) / 100;
  if (!(amount > 0)) return fail('Amount must be greater than zero.');
  if (amount > balance + 0.001) return fail(`Amount exceeds the balance due (${balance.toFixed(2)}).`);
  if (!PAYMENT_METHODS[b.method]) return fail('Choose a payment method.');
  const pay = {
    invoice_id: inv.id, amount, paid_on: isDate(b.paid_on) ? b.paid_on : today(), method: b.method, reference: b.reference,
    proof_name: req.file && req.file.filename, proof_original: req.file && req.file.originalname, proof_size: req.file ? req.file.size : 0, recorded_by: req.user.id,
  };
  db.insert('payments', pay);
  if (inv.status === 'disputed' && b.resolve_dispute === '1') db.run("UPDATE invoices SET status = 'issued' WHERE id = ?", inv.id);
  // full payment -> Paid (stops further reminders); otherwise Partial
  if (S.invoiceTotals(inv).balance <= 0) db.run("UPDATE invoices SET status = 'paid' WHERE id = ?", inv.id);
  S.refreshInvoiceStatus(inv.id);
  const fresh = db.get('SELECT * FROM invoices WHERE id = ?', inv.id);
  N.paymentReceived(fresh, db.get('SELECT * FROM projects WHERE id = ?', inv.project_id), { ...pay, method: PAYMENT_METHODS[pay.method] });
  req.flash('success', fresh.status === 'paid' ? 'Payment recorded — invoice fully paid, reminders stopped.' : 'Partial payment recorded.');
  res.redirect(`/payments/invoices/${inv.id}`);
});

router.get('/payments/transactions/:id/proof', (req, res, next) => {
  const p = db.get('SELECT pay.* FROM payments pay JOIN invoices i ON i.id = pay.invoice_id WHERE pay.id = ? AND i.org_id = ?', req.params.id, req.org.id);
  if (!p || !p.proof_name || !fs.existsSync(filePath(p.proof_name))) return next(httpError(404, 'No proof uploaded.'));
  res.download(filePath(p.proof_name), p.proof_original);
});

module.exports = router;
