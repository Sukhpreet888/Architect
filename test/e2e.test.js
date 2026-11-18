'use strict';
/* End-to-end walk through the ARCHFLOW flow, in-process, against a throwaway database. */
const os = require('os');
const fs = require('fs');
const path = require('path');
const test = require('node:test');
const assert = require('node:assert/strict');

process.env.NODE_ENV = 'test';
process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'archflow-test-'));
process.env.SMTP_HOST = '';
process.env.DATABASE_URL = ''; // embedded Postgres for tests
process.env.SUPABASE_URL = '';
process.env.BOOTSTRAP_FIRST_USER = '0';

const app = require('../src/app');
const db = require('../src/db');
const U = require('../src/util');
const { runReminders } = require('../src/scheduler');

let server; let base;
test.before(async () => {
  await db.ready();
  await new Promise((r) => { server = app.listen(0, r); });
  base = `http://127.0.0.1:${server.address().port}`;
  process.env.APP_URL = base;
});
test.after(async () => { server.close(); U.setToday(null); await db.end(); });

function client() {
  const jar = new Map();
  async function req(method, url, body, { multipart, json } = {}) {
    const headers = { cookie: [...jar].map(([k, v]) => `${k}=${v}`).join('; ') };
    let payload;
    if (multipart) payload = multipart;
    else if (json) { headers['content-type'] = 'application/json'; headers.accept = 'application/json'; payload = JSON.stringify(json); }
    else if (body) {
      headers['content-type'] = 'application/x-www-form-urlencoded';
      const p = new URLSearchParams();
      for (const [k, v] of Object.entries(body)) [].concat(v).forEach((x) => p.append(k, x));
      payload = p.toString();
    }
    const res = await fetch(base + url, { method, headers, body: payload, redirect: 'manual' });
    for (const c of res.headers.getSetCookie()) { const [kv] = c.split(';'); const i = kv.indexOf('='); jar.set(kv.slice(0, i), kv.slice(i + 1)); }
    const text = res.headers.get('content-type')?.includes('text') || res.headers.get('content-type')?.includes('json') ? await res.text() : Buffer.from(await res.arrayBuffer());
    return { status: res.status, location: res.headers.get('location'), text, type: res.headers.get('content-type') };
  }
  return { get: (u) => req('GET', u), post: (u, b, o) => req('POST', u, b, o) };
}
const emails = async (where = '1=1', ...a) => await db.all(`SELECT * FROM email_log WHERE ${where} ORDER BY id`, ...a);
const lastId = async () => ((await db.get('SELECT MAX(id) m FROM email_log')).m || 0);

async function signup(c, name, email) {
  let r = await c.post('/register', { name, email, password: 'password123' });
  assert.equal(r.location, '/verify-pending');
  const u = await db.get('SELECT * FROM users WHERE email = ?', email);
  assert.ok((await emails('to_email = ? AND subject LIKE ?', email, '%Verify%')).length, 'verification email sent');
  r = await c.post('/verify/resend', {});
  assert.equal((await emails('to_email = ? AND subject LIKE ?', email, '%Verify%')).length, 2, 'resend works');
  const tok = (await db.get('SELECT verify_token FROM users WHERE id = ?', u.id)).verify_token;
  r = await c.get(`/verify/${tok}`);
  assert.equal(r.location, '/dashboard');
  return u.id;
}

const S = {};
test('ARCHFLOW full flow', async (t) => {
  const admin = client();

  await t.test('register, verify email, create workspace, trial, choose plan', async () => {
    S.adminId = await signup(admin, 'Asha Admin', 'asha@studio.test');
    let r = await admin.get('/dashboard');
    assert.equal(r.location, '/onboarding/workspace');
    r = await admin.post('/onboarding/workspace', { name: 'Studio Asha', currency: 'INR', area_unit: 'sqft', billing_email: 'billing@studio.test' });
    assert.equal(r.location, '/dashboard', 'straight into the app — no card or plan needed during the trial');
    const org = await db.get('SELECT * FROM orgs');
    S.orgId = org.id;
    assert.equal(org.plan_status, 'trial');
    assert.equal(U.daysBetween(U.today(), org.trial_ends_at), 15);
    assert.equal((await db.get('SELECT role FROM memberships WHERE user_id = ?', S.adminId)).role, 'admin');
    r = await admin.get('/dashboard');
    assert.equal(r.status, 200, 'not forced to the plan page during the trial');
    assert.match(r.text, /no card needed until/);
    // choose a plan during the trial WITHOUT a card
    r = await admin.post('/billing/checkout', { plan: 'studio', onboarding: '1' });
    assert.equal(r.location, '/dashboard');
    let o = await db.get('SELECT plan, card_last4, plan_status FROM orgs');
    assert.deepEqual([o.plan, o.card_last4, o.plan_status], ['studio', null, 'trial']);
    // a card is optional during the trial, but if one is entered it is verified (declined card -> retry)
    r = await admin.post('/billing/checkout', { plan: 'studio', onboarding: '1', card_number: '4000000000000002', card_expiry: '12/30', card_cvc: '123' });
    assert.equal(r.location, '/onboarding/plan');
    assert.equal((await db.get('SELECT card_last4 FROM orgs')).card_last4, null);
    assert.ok((await emails("subject = 'Subscription payment failed'")).length);
    r = await admin.get('/dashboard');
    assert.equal(r.status, 200);
    assert.match(r.text, /Organisation dashboard/);
  });

  const pm = client(); const arch = client(); const acct = client(); const site = client();
  await t.test('organisation setup: profile, invites, roles, template version', async () => {
    let r = await admin.post('/org/settings', { name: 'Studio Asha', currency: 'INR', area_unit: 'sqft', invoice_prefix: 'SA', timezone: 'Asia/Kolkata', billing_email: 'billing@studio.test' });
    assert.equal(r.location, '/org/settings');
    for (const [c, email, role, name] of [[pm, 'pm@studio.test', 'pm', 'Priya PM'], [arch, 'arjun@studio.test', 'architect', 'Arjun Architect'], [acct, 'acc@studio.test', 'accountant', 'Anil Accounts'], [site, 'sam@studio.test', 'site_engineer', 'Sam Site']]) {
      r = await admin.post('/org/invite', { email, role, name });
      assert.equal(r.location, '/org/team');
      const inv = await db.get('SELECT * FROM invites WHERE email = ?', email);
      assert.ok((await emails('to_email = ? AND category = ?', email, 'team')).length, 'invite emailed');
      r = await c.post(`/invite/${inv.token}`, { name, password: 'password123' });
      assert.equal(r.location, '/dashboard');
      S[role] = (await db.get('SELECT id FROM users WHERE email = ?', email)).id;
    }
    // plan limit: studio = 5 users
    r = await admin.post('/org/invite', { email: 'six@studio.test', role: 'architect' });
    assert.ok(!await db.get("SELECT 1 FROM invites WHERE email = 'six@studio.test'"), 'user limit enforced');
    // role change emails the user
    r = await admin.post(`/org/members/${S.architect}`, { role: 'lead_architect' });
    assert.ok((await emails("to_email = 'arjun@studio.test' AND subject LIKE '%Lead Architect%'")).length);
    await admin.post(`/org/members/${S.architect}`, { role: 'architect' });
    // accountant cannot create projects
    r = await acct.get('/projects/new');
    assert.equal(r.status, 403);
    // template new version
    const tpl = await db.get('SELECT * FROM templates');
    r = await admin.post('/org/templates', { family_id: tpl.family_id, name: tpl.name, body: `${tpl.body}\nPhase: Post-occupancy Review\n  Task: Client feedback survey`, notes: 'added POE' });
    const v2 = await db.get('SELECT * FROM templates WHERE version = 2');
    assert.ok(v2 && v2.is_current === 1);
    assert.equal((await db.get('SELECT is_current FROM templates WHERE id = ?', tpl.id)).is_current, 0);
    S.templateId = v2.id;
  });

  await t.test('create project (2 steps) and generate workflow', async () => {
    let r = await pm.post('/projects/new/step1', { type: 'residential', subtype: 'Villa', plot_area: '4000', built_up_area: '3200', area_unit: 'sqft' });
    assert.equal(r.location, '/projects/new/step2');
    const start = U.today(); const end = U.addDays(start, 330);
    const before = await lastId();
    r = await pm.post('/projects', { name: 'Villa Serenity', client_name: 'Mr Rao', client_email: 'client@rao.test', start_date: start, end_date: end, scope: 'design_construction', construction_budget: '1000000', manager_id: String(S.pm), template_id: String(S.templateId), members: [String(S.architect), String(S.site_engineer), String(S.accountant)] });
    assert.match(r.location, /^\/projects\/\d+$/);
    S.pid = Number(r.location.split('/').pop());
    const phases = await db.all('SELECT * FROM phases WHERE project_id = ? ORDER BY seq', S.pid);
    assert.equal(phases.length, 11);
    assert.equal(phases[0].status, 'in_progress');
    assert.ok(phases.every((p) => p.status !== 'na'), 'construction scope -> all phases applicable');
    assert.ok((await db.get('SELECT COUNT(*) c FROM tasks WHERE project_id = ?', S.pid)).c >= 20);
    assert.ok((await db.get('SELECT COUNT(*) c FROM deliverables WHERE project_id = ?', S.pid)).c >= 10);
    assert.ok((await db.get("SELECT COUNT(*) c FROM approvals WHERE project_id = ? AND status = 'draft'", S.pid)).c >= 4);
    assert.ok((await emails('id > ? AND category = ?', before, 'project')).length >= 4, 'team emailed');
    r = await pm.get(`/projects/${S.pid}`);
    assert.equal(r.status, 200);
    // design-only project: construction-only phases are left out by default (not created at all)
    await pm.post('/projects/new/step1', { type: 'commercial', subtype: 'Retail', plot_area: '900', area_unit: 'sqm' });
    r = await pm.post('/projects', { name: 'Retail Fitout', scope: 'design', start_date: start, manager_id: String(S.pm) });
    S.pid2 = Number(r.location.split('/').pop());
    const p2 = await db.all('SELECT * FROM phases WHERE project_id = ? ORDER BY seq', S.pid2);
    assert.equal(p2.length, 9);
    assert.ok(!p2.some((p) => /Tendering|Construction Administration/.test(p.name)));
    r = await pm.get(`/projects/${S.pid2}/construction`);
    assert.match(r.text, /module is available for <b>Design \+ Construction<\/b> projects only/);

    // choose exactly which phases a project gets
    r = await pm.get('/projects/new/step2');
    assert.equal(r.location, '/projects/new', 'draft consumed');
    await pm.post('/projects/new/step1', { type: 'exterior', subtype: 'Facade', plot_area: '300', area_unit: 'sqm' });
    r = await pm.get('/projects/new/step2');
    assert.match(r.text, /Project phases/);
    r = await pm.post('/projects', { name: 'Facade only', scope: 'design', start_date: start, manager_id: String(S.pm), phases_submitted: '1' });
    assert.equal(r.location, '/projects/new/step2', 'at least one phase required');
    r = await pm.post('/projects', { name: 'Facade only', scope: 'design', start_date: start, manager_id: String(S.pm), phases_submitted: '1', phases: ['0', '2', '9'] });
    S.pid3 = Number(r.location.split('/').pop());
    let p3 = await db.all('SELECT * FROM phases WHERE project_id = ? ORDER BY seq', S.pid3);
    assert.deepEqual(p3.map((p) => [p.seq, p.name]), [[1, 'Pre-design & Client Brief'], [2, 'Concept Design'], [3, 'Handover & Closeout']]);
    assert.equal(p3[0].status, 'in_progress');
    assert.ok((await db.get('SELECT COUNT(*) c FROM tasks WHERE project_id = ?', S.pid3)).c === 6);

    // manage phases after creation: add a template phase in position 2, add a custom one, remove an untouched one
    r = await pm.get(`/projects/${S.pid3}/phases`);
    assert.match(r.text, /Manage phases/);
    await pm.post(`/projects/${S.pid3}/phases/add`, { template_phase: '1', after_seq: '1' });
    await pm.post(`/projects/${S.pid3}/phases/add`, { name: 'Interior Styling', after_seq: '4' });
    p3 = await db.all('SELECT * FROM phases WHERE project_id = ? ORDER BY seq', S.pid3);
    assert.deepEqual(p3.map((p) => p.name), ['Pre-design & Client Brief', 'Site Analysis & Feasibility', 'Concept Design', 'Handover & Closeout', 'Interior Styling']);
    assert.ok((await db.get('SELECT COUNT(*) c FROM tasks WHERE phase_id = ?', p3[1].id)).c === 2, 'template tasks added');
    // a phase with started work can't be removed
    await db.run("UPDATE tasks SET status = 'in_progress' WHERE phase_id = ?", p3[2].id);
    r = await pm.post(`/projects/${S.pid3}/phases/${p3[2].id}/remove`, {});
    assert.ok(await db.get('SELECT 1 FROM phases WHERE id = ?', p3[2].id), 'blocked: tasks started');
    r = await pm.post(`/projects/${S.pid3}/phases/${p3[3].id}/remove`, {});
    p3 = await db.all('SELECT * FROM phases WHERE project_id = ? ORDER BY seq', S.pid3);
    assert.deepEqual(p3.map((p) => [p.seq, p.name]), [[1, 'Pre-design & Client Brief'], [2, 'Site Analysis & Feasibility'], [3, 'Concept Design'], [4, 'Interior Styling']]);
    // a phase completes automatically when all its tasks are done, and re-opens if a task is re-opened
    const ph1Tasks = await db.all('SELECT * FROM tasks WHERE phase_id = ? ORDER BY id', p3[0].id);
    let b4 = await lastId();
    await pm.post(`/projects/${S.pid3}/tasks/${ph1Tasks[0].id}`, { status: 'done' });
    assert.equal((await db.get('SELECT status FROM phases WHERE id = ?', p3[0].id)).status, 'in_progress', 'one task left');
    r = await pm.post(`/projects/${S.pid3}/tasks/${ph1Tasks[1].id}`, null, { json: { status: 'done' } });
    assert.match(JSON.parse(r.text).messages[0], /completed/);
    assert.equal((await db.get('SELECT status FROM phases WHERE id = ?', p3[0].id)).status, 'completed', 'auto-completed at 100%');
    assert.equal((await db.get('SELECT status FROM phases WHERE id = ?', p3[1].id)).status, 'in_progress', 'next phase started');
    assert.ok((await emails("id > ? AND subject LIKE '%Phase complete: Pre-design%'", b4)).length, 'team emailed');
    r = await pm.get(`/projects/${S.pid3}/phases`);
    assert.match(r.text, /Phases completed<\/div><b>1 of 4<\/b>/);
    await pm.post(`/projects/${S.pid3}/tasks/${ph1Tasks[1].id}`, { status: 'in_progress' });
    assert.equal((await db.get('SELECT status FROM phases WHERE id = ?', p3[0].id)).status, 'in_progress', 're-opened');
    await pm.post(`/projects/${S.pid3}/tasks/${ph1Tasks[1].id}`, { status: 'done' });
    assert.equal((await db.get('SELECT status FROM phases WHERE id = ?', p3[0].id)).status, 'completed');
    r = await pm.get(`/projects/${S.pid3}/phases/${p3[0].id}`);
    assert.match(r.text, /<span class="tick on" aria-hidden="true">✓<\/span> Brief/, 'subphase ticked when all its tasks are done');
    assert.match(r.text, /2\/2 tasks done · completed/);
    assert.doesNotMatch((await pm.get(`/projects/${S.pid3}/tasks/${ph1Tasks[0].id}`)).text, /name="progress"/, 'no progress % entry');
    // the tick box un-ticks a task (status back to To do, progress 0)
    await pm.post(`/projects/${S.pid3}/tasks/${ph1Tasks[0].id}`, { status: 'todo' });
    assert.deepEqual(Object.values(await db.get('SELECT status, progress FROM tasks WHERE id = ?', ph1Tasks[0].id)), ['todo', 0]);
    await pm.post(`/projects/${S.pid3}/tasks/${ph1Tasks[0].id}`, { status: 'done' });
    r = await arch.post(`/projects/${S.pid3}/phases/add`, { name: 'Nope' });
    assert.equal(r.status, 404, 'architect is not on this project / cannot manage phases');
    // keep later plan-limit tests unaffected
    await db.run("UPDATE projects SET status = 'closed' WHERE id = ?", S.pid3);
  });

  await t.test('task management: create, assign, dependency, views, kanban update', async () => {
    const phase1 = await db.get('SELECT * FROM phases WHERE project_id = ? AND seq = 1', S.pid);
    let before = await lastId();
    let r = await pm.post(`/projects/${S.pid}/tasks`, { title: 'Prepare site survey', assignee_id: String(S.architect), phase_id: String(phase1.id), due_date: U.addDays(U.today(), 2), priority: 'high' });
    const t1 = await db.get("SELECT * FROM tasks WHERE title = 'Prepare site survey'");
    assert.ok((await emails("id > ? AND to_email = 'arjun@studio.test' AND subject LIKE '%Task assigned%'", before)).length);
    r = await pm.post(`/projects/${S.pid}/tasks`, { title: 'Draft concept', assignee_id: String(S.architect), depends_on: String(t1.id), due_date: U.addDays(U.today(), 5) });
    const t2 = await db.get("SELECT * FROM tasks WHERE title = 'Draft concept'");
    r = await arch.post(`/projects/${S.pid}/tasks/${t2.id}`, null, { json: { status: 'in_progress' } });
    assert.equal(r.status, 422, 'dependency blocks start');
    before = await lastId();
    r = await arch.post(`/projects/${S.pid}/tasks/${t1.id}`, null, { json: { status: 'done' } });
    assert.equal(r.status, 200);
    assert.ok((await emails("id > ? AND to_email = 'pm@studio.test' AND subject LIKE '%Task updated%'", before)).length, 'manager emailed on update');
    r = await arch.post(`/projects/${S.pid}/tasks/${t2.id}`, null, { json: { status: 'in_progress' } });
    assert.equal(r.status, 200);
    for (const v of ['list', 'kanban', 'calendar']) {
      r = await arch.get(`/projects/${S.pid}/tasks?view=${v}`); assert.equal(r.status, 200);
      r = await arch.get(`/tasks?view=${v}`); assert.equal(r.status, 200);
    }
    S.t2 = t2.id;
  });

  await t.test('documents: upload, new version, history, permissions', async () => {
    const phase1 = await db.get('SELECT * FROM phases WHERE project_id = ? AND seq = 1', S.pid);
    const fd = new FormData();
    fd.append('title', 'Site plan'); fd.append('phase_id', String(phase1.id)); fd.append('task_id', String(S.t2));
    fd.append('file', new Blob(['%PDF-1.4 test']), 'site-plan.pdf');
    let r = await arch.post(`/projects/${S.pid}/documents`, null, { multipart: fd });
    const doc = await db.get("SELECT * FROM documents WHERE title = 'Site plan'");
    assert.ok(doc);
    const fd2 = new FormData(); fd2.append('notes', 'Revised setbacks'); fd2.append('file', new Blob(['%PDF-1.4 v2']), 'site-plan-r2.pdf');
    r = await arch.post(`/projects/${S.pid}/documents/${doc.id}/versions`, null, { multipart: fd2 });
    const vers = await db.all('SELECT * FROM document_versions WHERE document_id = ? ORDER BY version', doc.id);
    assert.deepEqual(vers.map((v) => v.version), [1, 2]);
    r = await pm.get(`/projects/${S.pid}/documents/${doc.id}/versions/${vers[0].id}/download`);
    assert.equal(r.status, 200, 'old revision still downloadable');
    const bad = new FormData(); bad.append('file', new Blob(['x']), 'virus.exe');
    r = await arch.post(`/projects/${S.pid}/documents`, null, { multipart: bad });
    assert.equal((await db.get('SELECT COUNT(*) c FROM documents')).c, 1, 'exe rejected');
    // restricted doc hidden from architect
    const fd3 = new FormData(); fd3.append('title', 'Fee agreement'); fd3.append('restricted', '1'); fd3.append('file', new Blob(['x']), 'fee.pdf');
    await pm.post(`/projects/${S.pid}/documents`, null, { multipart: fd3 });
    const fee = await db.get("SELECT * FROM documents WHERE title = 'Fee agreement'");
    assert.equal(fee.restricted, 1);
    r = await arch.get(`/projects/${S.pid}/documents/${fee.id}`);
    assert.equal(r.status, 404);
    S.docId = doc.id;
  });

  await t.test('phase review: submit, revision required, resubmit, approve -> next phase', async () => {
    const phase1 = await db.get('SELECT * FROM phases WHERE project_id = ? AND seq = 1', S.pid);
    let before = await lastId();
    let r = await arch.post(`/projects/${S.pid}/phases/${phase1.id}/submit-review`, { reviewers: [String(S.pm)], note: 'Brief ready' });
    assert.equal((await db.get('SELECT status FROM phases WHERE id = ?', phase1.id)).status, 'in_review');
    assert.ok((await emails("id > ? AND to_email = 'pm@studio.test' AND subject LIKE '%Review requested%'", before)).length);
    const ap = await db.get("SELECT * FROM approvals WHERE type = 'phase' AND phase_id = ?", phase1.id);
    r = await pm.post(`/projects/${S.pid}/approvals/${ap.id}/decide`, { decision: 'revision_required', comment: 'Add area programme' });
    assert.equal((await db.get('SELECT status FROM approvals WHERE id = ?', ap.id)).status, 'revision_required');
    assert.equal((await db.get('SELECT status FROM phases WHERE id = ?', phase1.id)).status, 'in_progress');
    r = await arch.post(`/projects/${S.pid}/phases/${phase1.id}/submit-review`, { reviewers: [String(S.pm)], note: 'Updated' });
    assert.equal((await db.get('SELECT round FROM approvals WHERE id = ?', ap.id)).round, 2);
    before = await lastId();
    r = await pm.post(`/projects/${S.pid}/approvals/${ap.id}/decide`, { decision: 'approved' });
    assert.equal((await db.get('SELECT status FROM phases WHERE id = ?', phase1.id)).status, 'completed');
    assert.equal((await db.get('SELECT status FROM phases WHERE project_id = ? AND seq = 2', S.pid)).status, 'in_progress');
    assert.ok((await emails("id > ? AND subject LIKE '%Phase complete%'", before)).length);
    assert.equal((await db.get("SELECT COUNT(*) c FROM deliverables WHERE phase_id = ? AND status != 'approved'", phase1.id)).c, 0);
  });

  await t.test('approvals: material approval with two reviewers, reject then resubmit', async () => {
    let r = await arch.post(`/projects/${S.pid}/approvals`, { title: 'Facade stone', type: 'material', document_id: String(S.docId), reviewers: [String(S.pm), String(S.adminId)] });
    const ap = await db.get("SELECT * FROM approvals WHERE title = 'Facade stone'");
    assert.equal(ap.status, 'pending');
    r = await pm.post(`/projects/${S.pid}/approvals/${ap.id}/decide`, { decision: 'approved' });
    assert.equal((await db.get('SELECT status FROM approvals WHERE id = ?', ap.id)).status, 'pending', 'waits for all reviewers');
    r = await admin.post(`/projects/${S.pid}/approvals/${ap.id}/decide`, { decision: 'rejected', comment: 'Too costly' });
    assert.equal((await db.get('SELECT status FROM approvals WHERE id = ?', ap.id)).status, 'rejected');
    r = await arch.post(`/projects/${S.pid}/approvals/${ap.id}/submit`, { reviewers: [String(S.pm), String(S.adminId)], comment: 'Cheaper option' });
    assert.equal((await db.get('SELECT status, round FROM approvals WHERE id = ?', ap.id)).round, 2);
    // pending reminder after 3 days (email only)
    U.setToday(U.addDays(new Date().toISOString().slice(0, 10), 3));
    const before = await lastId();
    await runReminders();
    assert.ok((await emails("id > ? AND subject LIKE '%Reminder: review pending%'", before)).length >= 2);
    U.setToday(null);
    await pm.post(`/projects/${S.pid}/approvals/${ap.id}/decide`, { decision: 'approved' });
    await admin.post(`/projects/${S.pid}/approvals/${ap.id}/decide`, { decision: 'approved' });
    assert.equal((await db.get('SELECT status FROM approvals WHERE id = ?', ap.id)).status, 'approved');
  });

  await t.test('payments: invoice, email reminders schedule, partial & full payment stop reminders', async () => {
    const due = U.addDays(U.today(), -10); // past due so simulated dates stay inside the trial
    let before = await lastId();
    let r = await acct.post('/payments/invoices', { project_id: String(S.pid), milestone: 'Advance 10%', amount: '100000', tax: '18000', due_date: due, action: 'issue' });
    const inv = await db.get('SELECT * FROM invoices');
    assert.equal(inv.status, 'overdue', 'issued past its due date');
    assert.match(inv.number, /^SA-\d{4}-0001$/);
    assert.ok((await emails("id > ? AND to_email = 'client@rao.test' AND subject LIKE 'Invoice%'", before)).length, 'client emailed');
    const at = async (d) => { U.setToday(U.addDays(due, d)); const b = await lastId(); await runReminders(); return await emails('id > ? AND category = ? AND subject LIKE ?', b, 'reminder', `%${inv.number}%`); };
    assert.equal((await at(-5)).length, 0);
    assert.ok((await at(-3)).some((e) => e.to_email === 'client@rao.test'), '3 days before');
    assert.equal((await at(-3)).length, 0, 'not duplicated');
    assert.ok((await at(0)).length, 'on due date');
    U.setToday(U.addDays(due, 1)); await runReminders();
    assert.equal((await db.get('SELECT status FROM invoices WHERE id = ?', inv.id)).status, 'overdue');
    assert.ok((await at(3)).length, '3 days after');
    // partial payment
    U.setToday(null);
    r = await acct.post('/payments/transactions', { invoice_id: String(inv.id), amount: '50000', method: 'bank_transfer', reference: 'UTR1' });
    assert.equal((await db.get('SELECT status FROM invoices WHERE id = ?', inv.id)).status, 'overdue', 'still overdue with balance');
    assert.ok((await at(7)).length, '7 days after continues for balance');
    U.setToday(null);
    r = await acct.post('/payments/transactions', { invoice_id: String(inv.id), amount: '999999', method: 'upi' });
    assert.equal((await db.get('SELECT COUNT(*) c FROM payments')).c, 1, 'overpayment rejected');
    before = await lastId();
    r = await acct.post('/payments/transactions', { invoice_id: String(inv.id), amount: '68000', method: 'upi', reference: 'UPI2' });
    assert.equal((await db.get('SELECT status FROM invoices WHERE id = ?', inv.id)).status, 'paid');
    assert.ok((await emails("id > ? AND to_email = 'client@rao.test' AND subject LIKE 'Payment received%'", before)).length);
    assert.equal((await at(15)).length, 0, 'reminders stop after payment');
    U.setToday(null);
    r = await acct.get('/payments');
    assert.equal(r.status, 200);
    assert.match(r.text, /100%/);
    r = await arch.get('/payments');
    assert.equal(r.status, 403, 'architect cannot see payments');
  });

  await t.test('task due / overdue email reminders to assignee and manager', async () => {
    const task = await db.get('SELECT * FROM tasks WHERE id = ?', S.t2);
    U.setToday(U.addDays(task.due_date, 1));
    const before = await lastId();
    await runReminders();
    const sent = (await emails("id > ? AND subject LIKE '%OVERDUE%Draft concept%'", before)).map((e) => e.to_email);
    assert.ok(sent.includes('arjun@studio.test') && sent.includes('pm@studio.test'));
    U.setToday(null);
  });

  await t.test('construction: budget, expenditure approval, materials reorder alert, site supervision', async () => {
    let before = await lastId();
    let r = await site.post(`/projects/${S.pid}/construction/expenditures`, { category: 'labour', description: 'Excavation crew', amount: '850000', spent_on: U.today() });
    const exp = await db.get('SELECT * FROM expenditures');
    assert.ok((await emails("id > ? AND subject LIKE '%Expenditure awaiting approval%'", before)).length);
    r = await site.post(`/projects/${S.pid}/construction/expenditures/${exp.id}`, { decision: 'approve' });
    assert.equal(r.status, 403, 'site engineer cannot approve');
    before = await lastId();
    r = await acct.post(`/projects/${S.pid}/construction/expenditures/${exp.id}`, { decision: 'approve' });
    assert.equal((await db.get('SELECT status FROM expenditures WHERE id = ?', exp.id)).status, 'approved');
    assert.ok((await emails("id > ? AND subject LIKE '%of budget%'", before)).length, 'budget alert at 80%');
    await site.post(`/projects/${S.pid}/construction/suppliers`, { name: 'UltraCem', email: 'sales@ultracem.test' });
    const sup = await db.get('SELECT * FROM suppliers');
    await site.post(`/projects/${S.pid}/construction/materials`, { name: 'Cement', unit: 'bags', reorder_level: '20', supplier_id: String(sup.id) });
    const mat = await db.get('SELECT * FROM materials');
    await site.post(`/projects/${S.pid}/construction/materials/${mat.id}/txn`, { kind: 'purchase', qty: '100', unit_cost: '400' });
    assert.equal((await db.get('SELECT stock FROM materials')).stock, 100);
    assert.equal((await db.get("SELECT COUNT(*) c FROM expenditures WHERE category = 'material'")).c, 1);
    before = await lastId();
    await site.post(`/projects/${S.pid}/construction/materials/${mat.id}/txn`, { kind: 'consumption', qty: '85' });
    assert.ok((await emails("id > ? AND subject LIKE '%Reorder alert: Cement%'", before)).length);
    const vdate = U.addDays(U.today(), 4);
    await site.post(`/projects/${S.pid}/construction/visits`, { visit_date: vdate, purpose: 'Footing inspection', assigned_to: String(S.site_engineer) });
    const visit = await db.get('SELECT * FROM site_visits');
    U.setToday(U.addDays(vdate, -1)); before = await lastId(); await runReminders(); U.setToday(null);
    assert.ok((await emails("id > ? AND to_email = 'sam@studio.test' AND subject LIKE '%site visit tomorrow%'", before)).length);
    await site.post(`/projects/${S.pid}/construction/visits/${visit.id}`, { report: 'Footings OK; honeycombing at F3' });
    await site.post(`/projects/${S.pid}/construction/issues`, { title: 'Honeycombing at F3', severity: 'high', visit_id: String(visit.id) });
    const issue = await db.get('SELECT * FROM site_issues');
    before = await lastId();
    await site.post(`/projects/${S.pid}/construction/issues/${issue.id}`, { action: 'assign', assignee_id: String(S.site_engineer), due_date: U.addDays(U.today(), 3) });
    assert.ok((await db.get('SELECT task_id FROM site_issues')).task_id);
    assert.ok((await emails("id > ? AND subject LIKE '%Rectify%'", before)).length);
    await site.post(`/projects/${S.pid}/construction/issues/${issue.id}`, { action: 'resolve' });
    r = await pm.get(`/projects/${S.pid}/construction`);
    assert.equal(r.status, 200);
  });

  await t.test('reports: HTML, Excel and PDF exports', async () => {
    for (const u of [`/reports/projects/${S.pid}`, '/reports/organisation', '/reports/financial']) {
      let r = await admin.get(u); assert.equal(r.status, 200);
      r = await admin.get(`${u}?format=xlsx`); assert.match(r.type, /spreadsheetml/); assert.equal(r.text.slice(0, 2).toString(), 'PK');
      r = await admin.get(`${u}?format=pdf`); assert.equal(r.type, 'application/pdf'); assert.equal(r.text.slice(0, 4).toString(), '%PDF');
    }
    const r = await arch.get('/reports/financial');
    assert.equal(r.status, 403);
  });

  await t.test('project closure: checklist blocks, complete pending items, close & archive', async () => {
    let r = await pm.post(`/projects/${S.pid}/closure`, {});
    assert.equal((await db.get('SELECT status FROM projects WHERE id = ?', S.pid)).status, 'active', 'blocked by checklist');
    // complete everything
    await db.run("UPDATE tasks SET status = 'done', progress = 100 WHERE project_id = ?", S.pid);
    await db.run("UPDATE deliverables SET status = 'approved' WHERE project_id = ?", S.pid);
    await db.run("UPDATE expenditures SET status = 'approved' WHERE project_id = ?", S.pid);
    for (const ph of await db.all("SELECT * FROM phases WHERE project_id = ? AND status != 'completed' ORDER BY seq", S.pid)) {
      if (ph.status === 'not_started') await pm.post(`/projects/${S.pid}/phases/${ph.id}/status`, { action: 'start' });
      await pm.post(`/projects/${S.pid}/phases/${ph.id}/status`, { action: 'complete' });
    }
    assert.equal((await db.get("SELECT COUNT(*) c FROM phases WHERE project_id = ? AND status != 'completed'", S.pid)).c, 0);
    r = await pm.get(`/projects/${S.pid}/closure`);
    if (/class="no"/.test(r.text)) console.log(await require('../src/services').closureChecklist(await db.get('SELECT * FROM projects WHERE id = ?', S.pid)));
    assert.doesNotMatch(r.text, /class="no"/);
    const before = await lastId();
    r = await pm.post(`/projects/${S.pid}/closure`, { notes: 'Handed over' });
    const p = await db.get('SELECT * FROM projects WHERE id = ?', S.pid);
    assert.equal(p.status, 'closed');
    assert.match(p.closure_report, /Handed over/);
    assert.ok((await emails("id > ? AND to_email = 'client@rao.test' AND subject LIKE '%Project completed%'", before)).length);
    r = await pm.post(`/projects/${S.pid}/tasks`, { title: 'late' });
    assert.ok(!await db.get("SELECT 1 FROM tasks WHERE title = 'late'"), 'archived project is read-only');
  });

  await t.test('billing: card asked only when trial ends, add-on, renewal, failed renewal -> read-only', async () => {
    const org = await db.get('SELECT * FROM orgs');
    assert.equal(org.card_last4, null, 'whole trial used without a card');
    // 3 days before the end: email asking for card details
    U.setToday(U.addDays(org.trial_ends_at, -3)); let b = await lastId(); await runReminders();
    assert.ok((await emails("id > ? AND subject LIKE '%trial ends in 3 days — add your card details%'", b)).length);
    // trial over, still no card: workspace becomes read-only, admin is sent to add a card
    U.setToday(U.addDays(org.trial_ends_at, 1)); b = await lastId(); await runReminders();
    assert.equal((await db.get('SELECT plan_status FROM orgs')).plan_status, 'trial');
    assert.ok((await emails("id > ? AND subject LIKE '%trial has ended — add your card%'", b)).length);
    let r = await admin.get('/dashboard');
    assert.equal(r.location, '/billing/checkout?plan=studio', 'admin asked for card once trial ends');
    r = await pm.post(`/projects/${S.pid2}/tasks`, { title: 'blocked' });
    assert.equal(r.location, '/billing', 'read-only for everyone until a card is added');
    r = await admin.post('/billing/checkout', { plan: 'studio' });
    assert.equal((await db.get('SELECT plan_status FROM orgs')).plan_status, 'trial', 'card required after trial');
    b = await lastId();
    r = await admin.post('/billing/checkout', { plan: 'studio', card_number: '4242424242424242', card_expiry: '12/30', card_cvc: '123' });
    assert.equal(r.location, '/billing');
    const after = await db.get('SELECT * FROM orgs');
    assert.equal(after.plan_status, 'active');
    assert.equal(after.card_last4, '4242');
    assert.ok((await emails("id > ? AND subject LIKE 'Receipt:%'", b)).length, 'first month charged');
    r = await admin.get('/dashboard');
    assert.equal(r.status, 200);
    // add-on applies new limits
    r = await admin.post('/billing/addon', { addon: 'users', qty: '2' });
    assert.equal((await db.get('SELECT extra_users FROM orgs')).extra_users, 2);
    r = await admin.post('/org/invite', { email: 'six@studio.test', role: 'architect' });
    assert.ok(await db.get("SELECT 1 FROM invites WHERE email = 'six@studio.test'"), 'new limit applied');
    U.setToday(U.addDays(after.next_billing_date, -2)); b = await lastId(); await runReminders();
    assert.ok((await emails("id > ? AND subject LIKE '%renews on%'", b)).length);
    // make the card fail on renewal
    await db.run("UPDATE orgs SET card_last4 = '0002'");
    U.setToday(after.next_billing_date); await runReminders();
    assert.equal((await db.get('SELECT plan_status FROM orgs')).plan_status, 'past_due');
    r = await pm.post(`/projects/${S.pid2}/tasks`, { title: 'blocked' });
    assert.equal(r.location, '/billing', 'read-only when payment fails');
    r = await admin.post('/billing/payment-method', { card_number: '4242424242424242', card_expiry: '12/30', card_cvc: '123' });
    assert.equal((await db.get('SELECT plan_status FROM orgs')).plan_status, 'active');
    U.setToday(null);
  });

  await t.test('every notification is an email', async () => {
    const total = (await db.get('SELECT COUNT(*) c FROM email_log')).c;
    assert.ok(total > 50, `emails logged: ${total}`);
    const r = await admin.get('/org/emails');
    assert.equal(r.status, 200);
  });
});
