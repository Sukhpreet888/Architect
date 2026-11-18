'use strict';
/**
 * Automatic EMAIL reminders. Idempotent: every reminder is recorded in reminders_sent so it is sent once,
 * and the job catches up safely if the server was down (only the most relevant pending reminder is sent).
 */
const db = require('./db');
const N = require('./notify');
const S = require('./services');
const B = require('./billing');
const { INVOICE_REMINDERS, config } = require('./config');
const { today, addDays, daysBetween } = require('./util');

async function once(entity, id, key, fn) {
  const r = await db.run('INSERT INTO reminders_sent (entity, entity_id, rkey) VALUES (?, ?, ?) ON CONFLICT DO NOTHING', entity, id, key);
  if (r.changes) { await fn(); return 1; }
  return 0;
}

async function invoiceReminders() {
  let sent = 0;
  const t = today();
  const invs = await db.all(`SELECT i.* FROM invoices i JOIN projects p ON p.id = i.project_id
    WHERE i.status IN ('issued','partial','overdue') AND p.status = 'active'`);
  for (const inv of invs) {
    await S.refreshInvoiceStatus(inv.id);
    const fresh = await db.get('SELECT * FROM invoices WHERE id = ?', inv.id);
    if (!['issued', 'partial', 'overdue'].includes(fresh.status)) continue; // paid -> reminders stop
    const late = daysBetween(fresh.due_date, t); // >0 means overdue by N days
    // the latest rule whose offset has been reached, but don't send "before due" once the due date passed
    const due = INVOICE_REMINDERS.filter((r) => late >= r.offset && !(r.offset < 0 && late > 0) && !(r.offset === 0 && late > 2));
    const rule = due[due.length - 1];
    if (!rule) continue;
    const project = await db.get('SELECT * FROM projects WHERE id = ?', fresh.project_id);
    sent += await once('invoice', fresh.id, rule.key, async () => await N.invoiceReminder(fresh, project, rule));
  }
  return sent;
}

async function taskReminders() {
  let sent = 0;
  const t = today();
  const tasks = await db.all(`SELECT tk.* FROM tasks tk JOIN projects p ON p.id = tk.project_id
    WHERE tk.status != 'done' AND tk.due_date IS NOT NULL AND tk.due_date <= ? AND p.status = 'active'`, addDays(t, 2));
  for (const task of tasks) {
    const project = await db.get('SELECT * FROM projects WHERE id = ?', task.project_id);
    const d = daysBetween(t, task.due_date);
    if (d > 0) sent += await once('task', task.id, `soon_${task.due_date}`, async () => await N.taskDueReminder(task, project, 'due_soon', d));
    else if (d === 0) sent += await once('task', task.id, `today_${task.due_date}`, async () => await N.taskDueReminder(task, project, 'due_today', 0));
    else {
      const late = -d; // first overdue email immediately, then weekly
      sent += await once('task', task.id, `overdue_${task.due_date}_w${Math.floor(late / 7)}`, async () => await N.taskDueReminder(task, project, 'overdue', late));
    }
  }
  return sent;
}

async function approvalReminders() {
  let sent = 0;
  const t = today();
  const rows = await db.all(`SELECT a.*, r.user_id FROM approvals a JOIN approval_reviewers r ON r.approval_id = a.id
    JOIN projects p ON p.id = a.project_id WHERE a.status = 'pending' AND r.decision IS NULL AND p.status = 'active'`);
  for (const row of rows) {
    const waited = daysBetween((row.requested_at || row.created_at).slice(0, 10), t);
    const step = waited >= 7 ? 7 : waited >= 3 ? 3 : 0;
    if (!step) continue;
    const project = await db.get('SELECT * FROM projects WHERE id = ?', row.project_id);
    const reviewer = await S.userById(row.user_id);
    sent += await once('approval', row.id, `r${row.round}_u${row.user_id}_d${step}`, async () => await N.approvalPendingReminder(row, project, reviewer));
  }
  return sent;
}

async function siteVisitReminders() {
  let sent = 0;
  const visits = await db.all(`SELECT v.* FROM site_visits v JOIN projects p ON p.id = v.project_id
    WHERE v.status = 'scheduled' AND v.visit_date = ? AND p.status = 'active'`, addDays(today(), 1));
  for (const v of visits) {
    const project = await db.get('SELECT * FROM projects WHERE id = ?', v.project_id);
    sent += await once('visit', v.id, `day_before_${v.visit_date}`, async () => await N.siteVisitScheduled(v, project, true));
  }
  return sent;
}

async function subscriptionJobs() {
  let sent = 0;
  const t = today();
  for (const org of await db.all("SELECT * FROM orgs WHERE plan_status = 'trial'")) {
    const left = daysBetween(t, org.trial_ends_at);
    if (left < 0 && org.plan && org.card_last4) {
      // trial over with a plan chosen: start the paid subscription
      const res = await B.chargeRenewal({ ...org, next_billing_date: org.trial_ends_at });
      const fresh = await db.get('SELECT * FROM orgs WHERE id = ?', org.id);
      sent += await once('org', org.id, `trial_convert_${org.trial_ends_at}`, async () => (res.ok ? await N.billingReceipt(fresh, 'Subscription started after free trial', res.amount) : await N.paymentFailed(fresh, res.error)));
      continue;
    }
    if (left === 3 || left === 1) sent += await once('org', org.id, `trial_${left}`, async () => await N.trialReminder(org, left));
    if (left < 0) sent += await once('org', org.id, 'trial_expired', async () => await N.trialReminder(org, 0));
  }
  for (const org of await db.all("SELECT * FROM orgs WHERE plan_status = 'active' AND next_billing_date IS NOT NULL")) {
    const left = daysBetween(t, org.next_billing_date);
    const amount = B.monthlyAmount(org);
    if (left > 0 && left <= 3 && amount > 0) sent += await once('org', org.id, `renew_notice_${org.next_billing_date}`, async () => await N.renewalReminder(org, amount));
    if (left <= 0) {
      const date = org.next_billing_date;
      const res = await B.chargeRenewal(org);
      const fresh = await db.get('SELECT * FROM orgs WHERE id = ?', org.id);
      sent += await once('org', org.id, `renewed_${date}`, async () => (res.ok ? await N.billingReceipt(fresh, 'Monthly subscription renewal', res.amount) : await N.paymentFailed(fresh, res.error)));
    }
  }
  return sent;
}

async function runReminders() {
  const out = {
    invoices: await invoiceReminders(), tasks: await taskReminders(), approvals: await approvalReminders(),
    siteVisits: await siteVisitReminders(), subscriptions: await subscriptionJobs(),
  };
  out.total = Object.values(out).reduce((a, b) => a + b, 0);
  return out;
}

let timer = null;
function start() {
  const tick = async () => {
    try {
      const r = await runReminders();
      if (r.total && process.env.NODE_ENV !== 'test') console.log('[reminders] emails sent:', JSON.stringify(r));
    } catch (e) { console.error('[reminders] failed', e); }
  };
  setTimeout(tick, 2000).unref();
  timer = setInterval(tick, config.reminderIntervalMinutes * 60000);
  timer.unref();
}
function stop() { if (timer) clearInterval(timer); }

module.exports = { runReminders, start, stop };
