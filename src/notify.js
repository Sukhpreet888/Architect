'use strict';
/** All user-facing notifications and reminders. Every one of them is delivered by EMAIL only. */
const db = require('./db');
const { send } = require('./email');
const { config, ROLES, PLANS, DECISIONS, PRIORITIES } = require('./config');
const { fmtDate, fmtMoney, mapSeq } = require('./util');
const S = require('./services');

const url = (p) => `${config.appUrl}${p}`;
const orgOf = async (id) => await db.get('SELECT * FROM orgs WHERE id = ?', id);

// ---------------------------------------------------------------- account & workspace
const verification = async (user) => await send({
  to: user.email, category: 'account', subject: 'Verify your ARCHFLOW email address',
  title: `Welcome to ARCHFLOW, ${user.name}`, intro: 'Please confirm your email address to finish creating your account.',
  cta: { label: 'Verify email', url: url(`/verify/${user.verify_token}`) },
});
const passwordReset = async (user, tok) => await send({
  to: user.email, category: 'account', subject: 'Reset your ARCHFLOW password',
  title: 'Password reset requested', intro: 'Use the link below within 1 hour to choose a new password. If you did not request this, ignore this email.',
  cta: { label: 'Reset password', url: url(`/reset/${tok}`) },
});
const workspaceCreated = async (org, user) => await send({
  to: user.email, orgId: org.id, category: 'billing', subject: `Your ${org.name} workspace is ready — 15-day free trial started`,
  title: 'Workspace created', intro: `You are the Organisation Admin of ${org.name}. Your 15-day free trial is active — no card is needed until it ends. We'll email you before then to add your card details.`,
  rows: [['Trial ends', fmtDate(org.trial_ends_at)]], cta: { label: 'Open your dashboard', url: url('/dashboard') },
});
const invite = async (org, inv, inviter) => await send({
  to: inv.email, orgId: org.id, category: 'team', subject: `${inviter.name} invited you to ${org.name} on ARCHFLOW`,
  title: `Join ${org.name}`, intro: `${inviter.name} has invited you to collaborate as ${ROLES[inv.role]}.`,
  cta: { label: 'Accept invitation', url: url(`/invite/${inv.token}`) },
});
const roleChanged = async (org, user, role) => await send({
  to: user.email, orgId: org.id, category: 'team', subject: `Your role in ${org.name} is now ${ROLES[role]}`,
  title: 'Role updated', intro: `An administrator changed your role in ${org.name} to ${ROLES[role]}.`, cta: { label: 'Open dashboard', url: url('/dashboard') },
});

// ---------------------------------------------------------------- billing
const subscriptionActivated = async (org) => {
  const plan = PLANS[org.plan];
  return await send({
    to: [org.billing_email, ...await S.emailsForRoles(org.id, ['admin'])], orgId: org.id, category: 'billing',
    subject: org.plan_status === 'trial' ? `Plan selected: ${plan.name}` : `Subscription activated: ${plan.name} plan`,
    title: org.plan_status === 'trial' ? 'Plan selected' : 'Subscription activated',
    intro: org.plan_status !== 'trial' ? 'Thank you — your subscription is active.'
      : org.card_last4 ? `Your card will be charged automatically when your trial ends on ${fmtDate(org.trial_ends_at)}.`
        : `Enjoy your free trial. No card is needed until it ends on ${fmtDate(org.trial_ends_at)} — we'll remind you to add one.`,
    rows: [['Plan', plan.name], ['Price', plan.price ? `$${plan.price}/month` : 'Custom'], ['Card', org.card_last4 ? `•••• ${org.card_last4}` : '—']],
    cta: { label: 'View billing', url: url('/billing') },
  });
};
const paymentFailed = async (org, reason) => await send({
  to: [org.billing_email, ...await S.emailsForRoles(org.id, ['admin'])], orgId: org.id, category: 'billing',
  subject: 'Subscription payment failed', title: 'We could not process your payment', intro: `${reason} Please retry or choose another plan.`,
  cta: { label: 'Retry payment', url: url('/billing') },
});
const billingReceipt = async (org, description, amount) => await send({
  to: [org.billing_email, ...await S.emailsForRoles(org.id, ['admin'])], orgId: org.id, category: 'billing',
  subject: `Receipt: ${description}`, title: 'Payment receipt', rows: [['Item', description], ['Amount', `$${Number(amount).toFixed(2)}`]],
  cta: { label: 'Billing history', url: url('/billing') },
});
const trialReminder = async (org, daysLeft) => {
  const addCardUrl = url(org.plan ? `/billing/checkout?plan=${org.plan}` : '/billing/plans');
  return await send({
    to: [org.billing_email, ...await S.emailsForRoles(org.id, ['admin'])], orgId: org.id, category: 'billing',
    subject: daysLeft > 0 ? `Your ARCHFLOW trial ends in ${daysLeft} day${daysLeft === 1 ? '' : 's'} — add your card details` : daysLeft === 0 ? 'Your ARCHFLOW trial ends today — add your card details' : 'Your ARCHFLOW trial has ended — add your card to continue',
    title: daysLeft >= 0 ? 'Trial ending soon' : 'Trial ended',
    intro: daysLeft >= 0
      ? `Your free trial ends on ${fmtDate(org.trial_ends_at)}. Add your card details${org.plan ? '' : ' and choose a plan'} to keep your projects running without interruption.`
      : 'Your workspace is now read-only. Add your card details to activate your plan and continue where you left off.',
    cta: { label: 'Add card details', url: addCardUrl },
  });
};
const renewalReminder = async (org, amount) => await send({
  to: [org.billing_email, ...await S.emailsForRoles(org.id, ['admin'])], orgId: org.id, category: 'billing',
  subject: `Your ARCHFLOW subscription renews on ${fmtDate(org.next_billing_date)}`, title: 'Upcoming renewal',
  rows: [['Plan', PLANS[org.plan]?.name || org.plan], ['Amount', `$${Number(amount).toFixed(2)}`], ['Renewal date', fmtDate(org.next_billing_date)]],
  cta: { label: 'Manage billing', url: url('/billing') },
});
const usageLimitReached = async (org, what) => await send({
  to: await S.emailsForRoles(org.id, ['admin']), orgId: org.id, category: 'billing', subject: `Plan limit reached: ${what}`,
  title: 'Plan limit reached', intro: `Your workspace has reached its ${what} limit. Upgrade your plan or buy an add-on to continue.`,
  cta: { label: 'Upgrade or add-on', url: url('/billing') },
});

// ---------------------------------------------------------------- projects & phases
const projectCreated = async (project, creator) => await send({
  to: await S.projectTeamEmails(project.id), orgId: project.org_id, category: 'project',
  subject: `[${project.code}] You were added to project ${project.name}`, title: 'New project',
  intro: `${creator.name} created the project and added you to the team.`,
  rows: [['Client', project.client_name || '—'], ['Scope', project.scope === 'design_construction' ? 'Design + Construction' : 'Design only'], ['Start', fmtDate(project.start_date)], ['Target end', fmtDate(project.end_date)]],
  cta: { label: 'Open project', url: url(`/projects/${project.id}`) },
});
const phaseCompleted = async (project, phase, next) => await send({
  to: await S.projectTeamEmails(project.id), orgId: project.org_id, category: 'project',
  subject: `[${project.code}] Phase complete: ${phase.name}`, title: `${phase.name} completed`,
  intro: next ? `The next phase, ${next.name}, is now in progress.` : 'All applicable phases are complete. The project is ready for the closure checklist.',
  cta: { label: 'Open phase tracker', url: url(`/projects/${project.id}/phases`) },
});
const projectClosed = async (project, summary) => await send({
  to: [...await S.projectTeamEmails(project.id), project.client_email], orgId: project.org_id, category: 'project',
  subject: `[${project.code}] Project completed: ${project.name}`, title: 'Project completed and archived',
  intro: 'The project closure checklist is complete. A closure report has been generated and the project archived.', rows: summary,
});

// ---------------------------------------------------------------- tasks
async function taskRows(task, project) {
  const assignee = await S.userById(task.assignee_id);
  return [['Project', `${project.code} · ${project.name}`], ['Task', task.title], ['Assignee', assignee ? assignee.name : 'Unassigned'],
    ['Priority', PRIORITIES[task.priority] || task.priority], ['Due', fmtDate(task.due_date)], ['Progress', `${task.progress || 0}%`]];
}
const taskAssigned = async (task, project, by) => {
  const a = await S.userById(task.assignee_id); if (!a) return;
  return await send({
    to: a.email, orgId: project.org_id, category: 'task', subject: `[${project.code}] Task assigned: ${task.title}`,
    title: 'You have a new task', intro: `${by.name} assigned you a task.`, rows: await taskRows(task, project),
    cta: { label: 'Open task', url: url(`/projects/${project.id}/tasks/${task.id}`) },
  });
};
const taskUpdated = async (task, project, by, change) => {
  const a = await S.userById(task.assignee_id);
  const to = [...await S.projectManagerEmails(project), a && a.email].filter((e) => e && e !== by.email);
  return await send({
    to, orgId: project.org_id, category: 'task', subject: `[${project.code}] Task updated: ${task.title}`,
    title: 'Task updated', intro: `${by.name}: ${change}`, rows: await taskRows(task, project),
    cta: { label: 'Open task', url: url(`/projects/${project.id}/tasks/${task.id}`) },
  });
};
const taskDueReminder = async (task, project, kind, days) => {
  const a = await S.userById(task.assignee_id);
  const subj = kind === 'overdue' ? `OVERDUE (${days} day${days === 1 ? '' : 's'}): ${task.title}` : kind === 'due_today' ? `Due today: ${task.title}` : `Due in ${days} day${days === 1 ? '' : 's'}: ${task.title}`;
  return await send({
    to: [a && a.email, ...await S.projectManagerEmails(project)], orgId: project.org_id, category: 'reminder',
    subject: `[${project.code}] ${subj}`, title: kind === 'overdue' ? 'Task overdue' : 'Task nearing due date',
    intro: 'Reminder sent to the assignee and project manager.', rows: await taskRows(task, project),
    cta: { label: 'Update task', url: url(`/projects/${project.id}/tasks/${task.id}`) },
  });
};

// ---------------------------------------------------------------- approvals
function approvalRows(ap, project) {
  return [['Project', `${project.code} · ${project.name}`], ['Request', ap.title], ['Type', ap.type], ['Round', String(ap.round)]];
}
const approvalRequested = async (ap, project, by, reviewerIds, resubmitted) => await send({
  to: (await mapSeq(reviewerIds, async (id) => await S.userById(id))).map((u) => u && u.email), orgId: project.org_id, category: 'approval',
  subject: `[${project.code}] ${resubmitted ? 'Resubmitted for' : 'Review requested'}: ${ap.title}`,
  title: resubmitted ? 'Revised submission awaiting your review' : 'Your review is requested', intro: `${by.name} requested your decision.`,
  rows: approvalRows(ap, project), cta: { label: 'Review now', url: url(`/projects/${project.id}/approvals/${ap.id}`) },
});
const approvalDecision = async (ap, project, reviewer, decision, comment) => {
  const req = await S.userById(ap.requested_by);
  return await send({
    to: [req && req.email, ...await S.projectManagerEmails(project)].filter((e) => e !== reviewer.email), orgId: project.org_id, category: 'approval',
    subject: `[${project.code}] ${reviewer.name}: ${DECISIONS[decision]} — ${ap.title}`, title: `Decision: ${DECISIONS[decision]}`,
    intro: comment ? `Comment: ${comment}` : '', rows: approvalRows(ap, project),
    cta: { label: 'Open approval', url: url(`/projects/${project.id}/approvals/${ap.id}`) },
  });
};
const approvalFinal = async (ap, project, status) => {
  const req = await S.userById(ap.requested_by);
  return await send({
    to: [req && req.email, ...await S.projectManagerEmails(project)], orgId: project.org_id, category: 'approval',
    subject: `[${project.code}] ${ap.title}: ${DECISIONS[status]}`, title: `Final outcome: ${DECISIONS[status]}`,
    intro: status === 'approved' ? 'All reviewers approved. Linked deliverable and phase have been updated.' : 'Please revise and resubmit.',
    rows: approvalRows(ap, project), cta: { label: 'Open approval', url: url(`/projects/${project.id}/approvals/${ap.id}`) },
  });
};
const approvalPendingReminder = async (ap, project, reviewer) => await send({
  to: reviewer.email, orgId: project.org_id, category: 'reminder', subject: `[${project.code}] Reminder: review pending — ${ap.title}`,
  title: 'Approval still awaiting your decision', rows: approvalRows(ap, project),
  cta: { label: 'Review now', url: url(`/projects/${project.id}/approvals/${ap.id}`) },
});

// ---------------------------------------------------------------- documents
const documentVersion = async (doc, ver, project, by) => {
  const task = doc.task_id ? await db.get('SELECT * FROM tasks WHERE id = ?', doc.task_id) : null;
  const assignee = task ? await S.userById(task.assignee_id) : null;
  return await send({
    to: [...await S.projectManagerEmails(project), assignee && assignee.email].filter((e) => e && e !== by.email), orgId: project.org_id, category: 'document',
    subject: `[${project.code}] ${doc.title} — revision ${ver.version} uploaded`, title: 'New document version',
    rows: [['Document', doc.title], ['Revision', String(ver.version)], ['File', ver.original_name], ['Uploaded by', by.name], ['Notes', ver.notes || '—']],
    cta: { label: 'Open document', url: url(`/projects/${project.id}/documents/${doc.id}`) },
  });
};

// ---------------------------------------------------------------- invoices & payments
async function invoiceRows(inv, project, org) {
  const t = await S.invoiceTotals(inv);
  return [['Invoice', inv.number], ['Project', project.name], ['Milestone', inv.milestone], ['Amount', fmtMoney(t.total, org.currency)],
    ['Paid', fmtMoney(t.paid, org.currency)], ['Balance due', fmtMoney(t.balance, org.currency)], ['Due date', fmtDate(inv.due_date)]];
}
const invoiceIssued = async (inv, project) => {
  const org = await orgOf(project.org_id);
  return await send({
    to: [project.client_email, ...await S.projectTeamEmails(project.id)], orgId: org.id, category: 'invoice',
    subject: `Invoice ${inv.number} from ${org.name} — ${project.name}`, title: `Invoice ${inv.number}`,
    intro: `${org.name} has issued an invoice for ${inv.milestone}.`, rows: await invoiceRows(inv, project, org),
    footer: `Sent by ${org.name} via ARCHFLOW. Payment reminders are sent by email only.`,
  });
};
const invoiceReminder = async (inv, project, rule) => {
  const org = await orgOf(project.org_id);
  const overdue = rule.offset > 0;
  return await send({
    to: [project.client_email, ...await S.projectTeamEmails(project.id)], orgId: org.id, category: 'reminder',
    subject: `${overdue ? 'Overdue' : 'Payment reminder'}: invoice ${inv.number} (${rule.label})`,
    title: overdue ? `Invoice ${inv.number} is ${rule.offset} days overdue` : rule.offset === 0 ? `Invoice ${inv.number} is due today` : `Invoice ${inv.number} is due in ${-rule.offset} days`,
    intro: 'This is an automatic email reminder. If you have already paid, please ignore it or reply with the payment reference.',
    rows: await invoiceRows(inv, project, org), footer: `Sent by ${org.name} via ARCHFLOW. Reminders stop automatically once payment is recorded.`,
  });
};
const paymentReceived = async (inv, project, pay) => {
  const org = await orgOf(project.org_id);
  const t = await S.invoiceTotals(inv);
  return await send({
    to: [project.client_email, ...await S.projectTeamEmails(project.id)], orgId: org.id, category: 'invoice',
    subject: `Payment received for invoice ${inv.number}${t.balance > 0 ? ' (partial)' : ''}`, title: 'Payment received — thank you',
    intro: t.balance > 0 ? 'A partial payment was recorded. Reminders will continue for the remaining balance.' : 'The invoice is fully paid. No further reminders will be sent.',
    rows: [['Amount received', fmtMoney(pay.amount, org.currency)], ['Method', pay.method], ['Reference', pay.reference || '—'], ...(await invoiceRows(inv, project, org)).slice(3)],
  });
};

// ---------------------------------------------------------------- construction
const expenditureSubmitted = async (exp, project) => {
  const org = await orgOf(project.org_id);
  return await send({
    to: await S.emailsForRoles(project.org_id, ['admin', 'accountant', 'pm']), orgId: project.org_id, category: 'construction',
    subject: `[${project.code}] Expenditure awaiting approval: ${fmtMoney(exp.amount, org.currency)}`, title: 'Expenditure needs approval',
    rows: [['Category', exp.category], ['Description', exp.description], ['Vendor', exp.vendor || '—'], ['Amount', fmtMoney(exp.amount, org.currency)]],
    cta: { label: 'Review expenditure', url: url(`/projects/${project.id}/construction`) },
  });
};
const expenditureDecided = async (exp, project, by) => {
  const c = await S.userById(exp.created_by); const org = await orgOf(project.org_id);
  return await send({
    to: c && c.email, orgId: project.org_id, category: 'construction',
    subject: `[${project.code}] Expenditure ${exp.status}: ${exp.description}`, title: `Expenditure ${exp.status}`,
    rows: [['Amount', fmtMoney(exp.amount, org.currency)], ['Decided by', by.name]],
  });
};
const budgetAlert = async (project, spent, budget, categoryLabel) => {
  const org = orgOf(project.org_id);
  const what = categoryLabel ? `${categoryLabel} cost` : 'Project cost';
  return await send({
    to: [...await S.projectManagerEmails(project), ...await S.emailsForRoles(project.org_id, ['admin', 'accountant'])], orgId: project.org_id, category: 'construction',
    subject: `[${project.code}] ${what} at ${Math.round((spent / budget) * 100)}% of budget`, title: 'Budget alert',
    rows: [['Budget', fmtMoney(budget, (await org).currency)], ['Approved spend', fmtMoney(spent, (await org).currency)]],
    cta: { label: 'Open cost management', url: url(`/projects/${project.id}/costs`) },
  });
};
const reorderAlert = async (material, project, supplier) => await send({
  to: [...await S.projectManagerEmails(project), ...(await S.projectTeam(project.id)).filter((u) => u.role === 'site_engineer').map((u) => u.email)],
  orgId: project.org_id, category: 'construction', subject: `[${project.code}] Reorder alert: ${material.name}`, title: 'Material below reorder level',
  rows: [['Material', material.name], ['Stock', `${material.stock} ${material.unit}`], ['Reorder level', `${material.reorder_level} ${material.unit}`], ['Supplier', supplier ? `${supplier.name} ${supplier.email || ''}` : '—']],
  cta: { label: 'Open inventory', url: url(`/projects/${project.id}/construction#materials`) },
});
const siteVisitScheduled = async (visit, project, reminder) => {
  const a = await S.userById(visit.assigned_to);
  return await send({
    to: a && a.email, orgId: project.org_id, category: reminder ? 'reminder' : 'construction',
    subject: `[${project.code}] ${reminder ? 'Reminder: site visit tomorrow' : 'Site visit scheduled'} — ${fmtDate(visit.visit_date)}`,
    title: reminder ? 'Site visit tomorrow' : 'Site visit scheduled', rows: [['Project', project.name], ['Location', project.location || '—'], ['Date', fmtDate(visit.visit_date)], ['Purpose', visit.purpose]],
    cta: { label: 'Open site supervision', url: url(`/projects/${project.id}/construction#site`) },
  });
};

module.exports = {
  verification, passwordReset, workspaceCreated, invite, roleChanged, subscriptionActivated, paymentFailed, billingReceipt,
  trialReminder, renewalReminder, usageLimitReached, projectCreated, phaseCompleted, projectClosed, taskAssigned, taskUpdated,
  taskDueReminder, approvalRequested, approvalDecision, approvalFinal, approvalPendingReminder, documentVersion,
  invoiceIssued, invoiceReminder, paymentReceived, expenditureSubmitted, expenditureDecided, budgetAlert, reorderAlert, siteVisitScheduled,
};
