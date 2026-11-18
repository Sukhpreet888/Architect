'use strict';
const db = require('./db');
const { PLANS, TRIAL_LIMITS, PERMS, DEFAULT_TEMPLATE } = require('./config');
const { today, addDays, daysBetween, parseTemplate } = require('./util');

// ---------------------------------------------------------------- permissions
const can = (role, perm) => !!role && (PERMS[perm] || []).includes(role);

// ---------------------------------------------------------------- org & plan limits
function orgLimits(org) {
  let base;
  if (org.plan === 'enterprise') base = { users: org.custom_users || 50, projects: org.custom_projects || 200, storageMb: org.custom_storage_mb || 512000 };
  else if (org.plan && PLANS[org.plan]) base = PLANS[org.plan];
  else base = TRIAL_LIMITS;
  return {
    users: base.users + (org.extra_users || 0),
    projects: base.projects + (org.extra_projects || 0),
    storageMb: base.storageMb + (org.extra_storage_mb || 0),
  };
}
async function orgUsage(orgId) {
  const users = (await db.get('SELECT COUNT(*) c FROM memberships WHERE org_id = ? AND active = 1', orgId)).c;
  const pendingInvites = (await db.get('SELECT COUNT(*) c FROM invites WHERE org_id = ? AND accepted_at IS NULL', orgId)).c;
  const projects = (await db.get("SELECT COUNT(*) c FROM projects WHERE org_id = ? AND status = 'active'", orgId)).c;
  const docBytes = (await db.get(`SELECT COALESCE(SUM(v.size),0) s FROM document_versions v JOIN documents d ON d.id = v.document_id
    JOIN projects p ON p.id = d.project_id WHERE p.org_id = ?`, orgId)).s;
  const proofBytes = (await db.get(`SELECT COALESCE(SUM(pay.proof_size),0) s FROM payments pay JOIN invoices i ON i.id = pay.invoice_id WHERE i.org_id = ?`, orgId)).s;
  return { users, pendingInvites, projects, storageBytes: Number(docBytes) + Number(proofBytes) };
}
function subscriptionState(org) {
  const t = today();
  const trialDaysLeft = daysBetween(t, org.trial_ends_at);
  const onTrial = org.plan_status === 'trial';
  // A finished trial with a plan AND a card on file is just waiting for the billing job to convert it.
  const awaitingConversion = onTrial && trialDaysLeft < 0 && !!org.plan && !!org.card_last4;
  const expired = (onTrial && trialDaysLeft < 0 && !awaitingConversion) || org.plan_status === 'past_due' || org.plan_status === 'cancelled';
  return { onTrial, trialDaysLeft, expired, needsPlan: !org.plan, needsCard: !org.card_last4 };
}

// ---------------------------------------------------------------- people
async function orgMembers(orgId) {
  return await db.all(`SELECT u.id, u.name, u.email, m.role, m.active FROM memberships m JOIN users u ON u.id = m.user_id
    WHERE m.org_id = ? ORDER BY u.name`, orgId);
}
async function activeMembers(orgId) { return (await orgMembers(orgId)).filter((m) => m.active); }
async function emailsForRoles(orgId, roles) {
  return (await db.all(`SELECT u.email FROM memberships m JOIN users u ON u.id = m.user_id WHERE m.org_id = ? AND m.active = 1
    AND m.role IN (${roles.map(() => '?').join(',')})`, orgId, ...roles)).map((r) => r.email);
}
const userById = async (id) => (id ? await db.get('SELECT id, name, email FROM users WHERE id = ?', id) : null);
async function isOrgUser(orgId, userId) {
  return !!await db.get('SELECT 1 FROM memberships WHERE org_id = ? AND user_id = ? AND active = 1', orgId, userId);
}

// ---------------------------------------------------------------- projects
async function visibleProjects(orgId, user, role, { status } = {}) {
  const st = status ? ' AND p.status = ?' : '';
  const args = status ? [status] : [];
  if (can(role, 'see_all_projects')) {
    return await db.all(`SELECT p.* FROM projects p WHERE p.org_id = ?${st} ORDER BY p.created_at DESC`, orgId, ...args);
  }
  return await db.all(`SELECT DISTINCT p.* FROM projects p LEFT JOIN project_members pm ON pm.project_id = p.id
    WHERE p.org_id = ? AND (pm.user_id = ? OR p.created_by = ? OR p.manager_id = ?)${st} ORDER BY p.created_at DESC`,
  orgId, user.id, user.id, user.id, ...args);
}
async function canAccessProject(project, user, role) {
  if (!project) return false;
  if (can(role, 'see_all_projects')) return true;
  if (project.created_by === user.id || project.manager_id === user.id) return true;
  return !!await db.get('SELECT 1 FROM project_members WHERE project_id = ? AND user_id = ?', project.id, user.id);
}
async function projectTeam(projectId) {
  return await db.all(`SELECT u.id, u.name, u.email, m.role FROM project_members pm JOIN users u ON u.id = pm.user_id
    JOIN projects p ON p.id = pm.project_id LEFT JOIN memberships m ON m.user_id = u.id AND m.org_id = p.org_id
    WHERE pm.project_id = ? ORDER BY u.name`, projectId);
}
async function projectTeamEmails(projectId) { return (await projectTeam(projectId)).map((u) => u.email); }
async function projectManagerEmails(project) {
  const out = [];
  const mgr = await userById(project.manager_id); if (mgr) out.push(mgr.email);
  const creator = await userById(project.created_by); if (creator) out.push(creator.email);
  return [...new Set(out)];
}

async function nextProjectCode(orgId) {
  const n = (await db.get('SELECT COUNT(*) c FROM projects WHERE org_id = ?', orgId)).c + 1;
  return `PRJ-${String(n).padStart(4, '0')}`;
}

async function ensureDefaultTemplate(orgId, userId) {
  const t = await db.get('SELECT id FROM templates WHERE org_id = ? LIMIT 1', orgId);
  if (t) return t.id;
  const id = await db.insert('templates', { org_id: orgId, name: 'Standard architectural workflow (10 phases)', version: 1, body: DEFAULT_TEMPLATE, is_current: 1, created_by: userId, notes: 'Default template' });
  await db.run('UPDATE templates SET family_id = ? WHERE id = ?', id, id);
  return id;
}

/** Create the project and generate its workflow (phases, subphases, tasks, deliverables, approvals) from a template. */
async function createProjectWithWorkflow(orgId, userId, data, memberIds) {
  return await db.tx(async () => {
    const tpl = await db.get('SELECT * FROM templates WHERE id = ? AND org_id = ?', data.template_id, orgId)
      || await db.get('SELECT * FROM templates WHERE id = ?', await ensureDefaultTemplate(orgId, userId));
    const { phases } = parseTemplate(tpl.body);
    const projectId = await db.insert('projects', { ...data, org_id: orgId, template_id: tpl.id, code: await nextProjectCode(orgId), created_by: userId });
    const members = new Set([...memberIds, userId, data.manager_id].filter(Boolean).map(Number));
    for (const uid of members) if (await isOrgUser(orgId, uid)) await db.run('INSERT INTO project_members (project_id, user_id) VALUES (?, ?) ON CONFLICT DO NOTHING', projectId, uid);

    const applicable = phases.filter((p) => data.scope === 'design_construction' || !p.construction);
    const start = data.start_date || today();
    const end = data.end_date && data.end_date > start ? data.end_date : addDays(start, applicable.length * 30);
    const span = Math.max(daysBetween(start, end), applicable.length);
    const per = span / Math.max(applicable.length, 1);
    let idx = 0; let seq = 0; let first = true;
    for (const ph of phases) {
      seq++;
      const isApplicable = data.scope === 'design_construction' || !ph.construction;
      let ps = null; let pe = null;
      if (isApplicable) { ps = addDays(start, Math.round(idx * per)); pe = addDays(start, Math.round((idx + 1) * per) - 1); idx++; }
      const status = !isApplicable ? 'na' : first ? 'in_progress' : 'not_started';
      const phaseId = await db.insert('phases', { project_id: projectId, seq, name: ph.name, status, planned_start: ps, planned_end: pe, started_at: status === 'in_progress' ? today() : null });
      if (isApplicable) first = false;
      if (!isApplicable) continue;
      for (const [si, sp] of ph.subphases.entries()) {
        const subId = await db.insert('subphases', { phase_id: phaseId, name: sp.name, seq: si + 1 });
        for (const d of sp.deliverables) await db.insert('deliverables', { project_id: projectId, phase_id: phaseId, subphase_id: subId, name: d, due_date: pe });
        for (const t of sp.tasks) await db.insert('tasks', { project_id: projectId, phase_id: phaseId, subphase_id: subId, title: t, start_date: ps, due_date: pe, source: 'template', created_by: userId });
      }
      for (const a of ph.approvals) await db.insert('approvals', { project_id: projectId, phase_id: phaseId, type: 'design', title: a, status: 'draft' });
    }
    return projectId;
  });
}

async function phaseProgress(projectId) {
  const phases = await db.all('SELECT * FROM phases WHERE project_id = ? ORDER BY seq', projectId);
  const applicable = phases.filter((p) => p.status !== 'na');
  const done = applicable.filter((p) => p.status === 'completed').length;
  const taskStats = await db.get("SELECT COUNT(*) total, SUM(CASE WHEN status = 'done' THEN 1 ELSE 0 END) done FROM tasks WHERE project_id = ?", projectId);
  return {
    phases, applicable: applicable.length, done,
    active: phases.find((p) => p.status === 'in_progress' || p.status === 'in_review'),
    pct: applicable.length ? Math.round((done / applicable.length) * 100) : 0,
    tasksTotal: taskStats.total || 0, tasksDone: taskStats.done || 0,
    allComplete: applicable.length > 0 && done === applicable.length,
  };
}

/** Mark a phase complete and open the next applicable phase. Returns { next, allComplete }. */
async function completePhase(phaseId) {
  const phase = await db.get('SELECT * FROM phases WHERE id = ?', phaseId);
  await db.run("UPDATE phases SET status = 'completed', completed_at = ? WHERE id = ?", today(), phaseId);
  const next = await db.get("SELECT * FROM phases WHERE project_id = ? AND seq > ? AND status = 'not_started' ORDER BY seq LIMIT 1", phase.project_id, phase.seq);
  if (next) await db.run("UPDATE phases SET status = 'in_progress', started_at = ? WHERE id = ?", today(), next.id);
  const prog = await phaseProgress(phase.project_id);
  return { phase, next, allComplete: prog.allComplete };
}

// ---------------------------------------------------------------- invoices
async function invoiceTotals(inv) {
  const paid = (await db.get('SELECT COALESCE(SUM(amount),0) s FROM payments WHERE invoice_id = ?', inv.id)).s;
  const total = Number(inv.amount) + Number(inv.tax || 0);
  return { total, paid, balance: Math.max(0, Math.round((total - paid) * 100) / 100) };
}
/** Recalculate an invoice's status after payments or date changes (never touches draft/disputed). */
async function refreshInvoiceStatus(invoiceId) {
  const inv = await db.get('SELECT * FROM invoices WHERE id = ?', invoiceId);
  if (!inv || inv.status === 'draft' || inv.status === 'disputed') return inv && inv.status;
  const { paid, balance } = await invoiceTotals(inv);
  let status;
  if (balance <= 0) status = 'paid';
  else if (inv.due_date < today()) status = 'overdue';
  else if (paid > 0) status = 'partial';
  else status = 'issued';
  if (status !== inv.status) await db.run('UPDATE invoices SET status = ? WHERE id = ?', status, invoiceId);
  return status;
}
async function nextInvoiceNumber(org) {
  const year = today().slice(0, 4);
  const n = (await db.get('SELECT COUNT(*) c FROM invoices WHERE org_id = ?', org.id)).c + 1;
  return `${org.invoice_prefix || 'INV'}-${year}-${String(n).padStart(4, '0')}`;
}
async function paymentsSummary(orgId, projectId) {
  const where = projectId ? 'i.org_id = ? AND i.project_id = ?' : 'i.org_id = ?';
  const args = projectId ? [orgId, projectId] : [orgId];
  const invs = await db.all(`SELECT i.* FROM invoices i WHERE ${where} AND i.status != 'draft'`, ...args);
  let receivable = 0; let received = 0; let overdue = 0; let pending = 0;
  for (const inv of invs) {
    const t = await invoiceTotals(inv);
    receivable += t.total; received += t.paid;
    if (inv.status === 'overdue') overdue += t.balance; else pending += t.balance;
  }
  return { receivable, received, pending, overdue, collectionRate: receivable ? Math.round((received / receivable) * 100) : 0, count: invs.length };
}

// ---------------------------------------------------------------- approvals
/** Combine reviewer decisions: any rejected -> rejected, any revision -> revision_required, all approved -> approved. */
async function resolveApproval(approvalId) {
  const reviewers = await db.all('SELECT * FROM approval_reviewers WHERE approval_id = ?', approvalId);
  if (!reviewers.length || reviewers.some((r) => !r.decision)) return null;
  if (reviewers.some((r) => r.decision === 'rejected')) return 'rejected';
  if (reviewers.some((r) => r.decision === 'revision_required')) return 'revision_required';
  return 'approved';
}

// ---------------------------------------------------------------- closure checklist
async function closureChecklist(project) {
  const pid = project.id;
  const openTasks = (await db.get("SELECT COUNT(*) c FROM tasks WHERE project_id = ? AND status != 'done'", pid)).c;
  const openDeliverables = (await db.get("SELECT COUNT(*) c FROM deliverables d JOIN phases ph ON ph.id = d.phase_id WHERE d.project_id = ? AND ph.status != 'na' AND d.status != 'approved'", pid)).c;
  const openApprovals = (await db.get("SELECT COUNT(*) c FROM approvals WHERE project_id = ? AND status IN ('pending','revision_required')", pid)).c;
  const unpaid = await db.all("SELECT * FROM invoices WHERE project_id = ? AND status IN ('issued','partial','overdue','disputed')", pid);
  let unpaidBalance = 0;
  for (const i of unpaid) unpaidBalance += (await invoiceTotals(i)).balance;
  const prog = await phaseProgress(pid);
  const items = [
    { key: 'phases', label: 'All applicable phases completed', ok: prog.allComplete, detail: `${prog.done}/${prog.applicable} phases` },
    { key: 'tasks', label: 'All tasks completed', ok: openTasks === 0, detail: `${openTasks} open` },
    { key: 'deliverables', label: 'All deliverables approved', ok: openDeliverables === 0, detail: `${openDeliverables} pending` },
    { key: 'approvals', label: 'No pending approvals', ok: openApprovals === 0, detail: `${openApprovals} pending` },
    { key: 'payments', label: 'All issued invoices paid', ok: unpaid.length === 0, detail: `${unpaid.length} unpaid (${unpaidBalance.toFixed(2)})` },
  ];
  if (project.scope === 'design_construction') {
    const openIssues = (await db.get("SELECT COUNT(*) c FROM site_issues WHERE project_id = ? AND status != 'resolved'", pid)).c;
    const pendingExp = (await db.get("SELECT COUNT(*) c FROM expenditures WHERE project_id = ? AND status = 'pending'", pid)).c;
    items.push({ key: 'site', label: 'All site issues resolved', ok: openIssues === 0, detail: `${openIssues} open` });
    items.push({ key: 'expenses', label: 'No expenditures awaiting approval', ok: pendingExp === 0, detail: `${pendingExp} pending` });
  }
  return { items, complete: items.every((i) => i.ok) };
}

module.exports = {
  can, orgLimits, orgUsage, subscriptionState, orgMembers, activeMembers, emailsForRoles, userById, isOrgUser,
  visibleProjects, canAccessProject, projectTeam, projectTeamEmails, projectManagerEmails, ensureDefaultTemplate,
  createProjectWithWorkflow, phaseProgress, completePhase, invoiceTotals, refreshInvoiceStatus, nextInvoiceNumber,
  paymentsSummary, resolveApproval, closureChecklist,
};
