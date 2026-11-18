'use strict';
// Creates a demo workspace: admin@archflow.demo / password123 (plus team members with the same password).
const db = require('../src/db');
const S = require('../src/services');
const { hashPassword, today, addDays } = require('../src/util');

(async () => {
await db.ready();
if (await db.get("SELECT 1 FROM users WHERE email = 'admin@archflow.demo'")) { console.log('Demo data already present.'); process.exit(0); }
const pw = hashPassword('password123');
const mk = async (name, email) => await db.insert('users', { name, email, password_hash: pw, email_verified: 1 });
await db.tx(async () => {
  const admin = await mk('Asha Menon', 'admin@archflow.demo');
  const orgId = await db.insert('orgs', { name: 'Menon Design Studio', plan: 'studio', plan_status: 'trial', trial_ends_at: addDays(today(), 15), next_billing_date: addDays(today(), 15), card_last4: '4242', card_brand: 'Visa', billing_email: 'admin@archflow.demo', invoice_prefix: 'MDS' });
  const team = { admin };
  await db.insert('memberships', { org_id: orgId, user_id: admin, role: 'admin' });
  for (const [role, name, email] of [['pm', 'Priya Nair', 'pm@archflow.demo'], ['lead_architect', 'Rahul Iyer', 'lead@archflow.demo'], ['architect', 'Arjun Das', 'architect@archflow.demo'], ['accountant', 'Anil Shah', 'accounts@archflow.demo']]) {
    team[role] = await mk(name, email); await db.insert('memberships', { org_id: orgId, user_id: team[role], role });
  }
  await S.ensureDefaultTemplate(orgId, admin);
  const start = addDays(today(), -60);
  const pid = await S.createProjectWithWorkflow(orgId, team.pm, { name: 'Villa Serenity', client_name: 'Mr & Mrs Rao', client_email: 'client@example.com', location: 'Whitefield, Bengaluru', type: 'residential', subtype: 'Villa', plot_area: 4000, built_up_area: 3200, area_unit: 'sqft', start_date: start, end_date: addDays(start, 360), scope: 'design_construction', construction_budget: 4500000, contract_value: 1200000, manager_id: team.pm }, [team.lead_architect, team.architect, team.accountant]);
  const phases = await db.all('SELECT * FROM phases WHERE project_id = ? ORDER BY seq', pid);
  await S.completePhase(phases[0].id);
  await db.run("UPDATE tasks SET status = 'done', progress = 100 WHERE phase_id = ?", phases[0].id);
  await db.run("UPDATE deliverables SET status = 'approved' WHERE phase_id = ?", phases[0].id);
  for (const [i, t] of (await db.all('SELECT id FROM tasks WHERE project_id = ? AND status != ?', pid, 'done')).entries()) await db.run('UPDATE tasks SET assignee_id = ? WHERE id = ?', i % 2 ? team.architect : team.lead_architect, t.id);
  await db.run("UPDATE tasks SET status = 'in_progress', progress = 0 WHERE phase_id = ?", phases[1].id);
  await db.insert('invoices', { org_id: orgId, project_id: pid, number: `MDS-${today().slice(0, 4)}-0001`, milestone: 'Advance — 10% of fee', amount: 120000, tax: 21600, issue_date: start, due_date: addDays(start, 15), status: 'paid', created_by: team.accountant });
  await db.insert('payments', { invoice_id: 1, amount: 141600, paid_on: addDays(start, 12), method: 'bank_transfer', reference: 'UTR4481', recorded_by: team.accountant });
  await db.insert('invoices', { org_id: orgId, project_id: pid, number: `MDS-${today().slice(0, 4)}-0002`, milestone: 'Concept approval — 20%', amount: 240000, tax: 43200, issue_date: addDays(today(), -20), due_date: addDays(today(), -4), status: 'overdue', created_by: team.accountant });
  await S.createProjectWithWorkflow(orgId, team.lead_architect, { name: 'Café Banyan Fit-out', client_name: 'Banyan Hospitality', client_email: 'owner@example.com', type: 'commercial', subtype: 'Restaurant', plot_area: 2200, area_unit: 'sqft', start_date: today(), end_date: addDays(today(), 120), scope: 'design', manager_id: team.lead_architect }, [team.architect]);
});
console.log('Demo workspace created. Sign in as admin@archflow.demo / password123');
await db.end();
})().catch((e) => { console.error(e); process.exit(1); });
