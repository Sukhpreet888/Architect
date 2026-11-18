'use strict';
const router = require('express').Router();
const db = require('../db');
const N = require('../notify');
const S = require('../services');
const { ROLES } = require('../config');
const { requireOrg, perm, httpError } = require('../mw');
const { token, isEmail, parseTemplate, int } = require('../util');

router.use('/org', requireOrg);

// ---- organisation profile & preferences
router.get('/org/settings', perm('org_manage'), (req, res) => res.render('org/settings', { title: 'Organisation profile & preferences' }));
router.post('/org/settings', perm('org_manage'), async (req, res) => {
  const b = req.body;
  if (!String(b.name || '').trim()) { req.flash('error', 'Name is required.'); return res.redirect('/org/settings'); }
  await db.update('orgs', req.org.id, {
    name: b.name.trim(), address: b.address, phone: b.phone, website: b.website, currency: b.currency || 'INR',
    timezone: b.timezone || 'Asia/Kolkata', area_unit: b.area_unit || 'sqft', invoice_prefix: (b.invoice_prefix || 'INV').toUpperCase().slice(0, 8),
    billing_email: b.billing_email,
  });
  req.flash('success', 'Organisation profile saved.');
  res.redirect('/org/settings');
});

// ---- team members, invitations, roles
router.get('/org/team', async (req, res) => {
  res.render('org/team', {
    title: 'Team & roles', members: await S.orgMembers(req.org.id), limits: S.orgLimits(req.org), usage: await S.orgUsage(req.org.id),
    invites: await db.all('SELECT * FROM invites WHERE org_id = ? AND accepted_at IS NULL ORDER BY id DESC', req.org.id),
  });
});
router.post('/org/invite', perm('org_manage'), async (req, res) => {
  const email = String(req.body.email || '').trim().toLowerCase();
  const role = req.body.role;
  if (!isEmail(email) || !ROLES[role]) { req.flash('error', 'Enter a valid email and role.'); return res.redirect('/org/team'); }
  const existing = await db.get('SELECT 1 FROM memberships m JOIN users u ON u.id = m.user_id WHERE m.org_id = ? AND u.email = ? AND m.active = 1', req.org.id, email);
  if (existing) { req.flash('error', `${email} is already a member.`); return res.redirect('/org/team'); }
  const usage = await S.orgUsage(req.org.id); const limits = S.orgLimits(req.org);
  if (usage.users + usage.pendingInvites >= limits.users) {
    await N.usageLimitReached(req.org, 'users');
    req.flash('error', `Your plan allows ${limits.users} users. Upgrade or buy a user add-on to invite more.`);
    return res.redirect('/org/team');
  }
  await db.run('DELETE FROM invites WHERE org_id = ? AND email = ? AND accepted_at IS NULL', req.org.id, email);
  const inv = { org_id: req.org.id, email, name: req.body.name, role, token: token(), invited_by: req.user.id };
  await db.insert('invites', inv);
  await N.invite(req.org, inv, req.user);
  req.flash('success', `Invitation emailed to ${email}.`);
  res.redirect('/org/team');
});
router.post('/org/invites/:id/resend', perm('org_manage'), async (req, res) => {
  const inv = await db.get('SELECT * FROM invites WHERE id = ? AND org_id = ? AND accepted_at IS NULL', req.params.id, req.org.id);
  if (inv) { await N.invite(req.org, inv, req.user); req.flash('success', `Invitation re-sent to ${inv.email}.`); }
  res.redirect('/org/team');
});
router.post('/org/invites/:id/revoke', perm('org_manage'), async (req, res) => {
  await db.run('DELETE FROM invites WHERE id = ? AND org_id = ? AND accepted_at IS NULL', req.params.id, req.org.id);
  req.flash('success', 'Invitation revoked.');
  res.redirect('/org/team');
});
router.post('/org/members/:uid', perm('org_manage'), async (req, res, next) => {
  const m = await db.get('SELECT * FROM memberships WHERE org_id = ? AND user_id = ?', req.org.id, req.params.uid);
  if (!m) return next(httpError(404, 'Member not found.'));
  const admins = (await db.get("SELECT COUNT(*) c FROM memberships WHERE org_id = ? AND role = 'admin' AND active = 1", req.org.id)).c;
  const losingAdmin = m.role === 'admin' && m.active && (req.body.action === 'deactivate' || (req.body.role && req.body.role !== 'admin'));
  if (losingAdmin && admins <= 1) { req.flash('error', 'The organisation needs at least one active Admin.'); return res.redirect('/org/team'); }
  const user = await S.userById(m.user_id);
  if (req.body.action === 'deactivate') {
    await db.run('UPDATE memberships SET active = 0 WHERE id = ?', m.id);
    req.flash('success', `${user.name} deactivated.`);
  } else if (req.body.action === 'activate') {
    const usage = await S.orgUsage(req.org.id);
    if (usage.users >= S.orgLimits(req.org).users) { req.flash('error', 'User limit reached for your plan.'); return res.redirect('/org/team'); }
    await db.run('UPDATE memberships SET active = 1 WHERE id = ?', m.id);
    req.flash('success', `${user.name} re-activated.`);
  } else if (ROLES[req.body.role] && req.body.role !== m.role) {
    await db.run('UPDATE memberships SET role = ? WHERE id = ?', req.body.role, m.id);
    await N.roleChanged(req.org, user, req.body.role);
    req.flash('success', `${user.name} is now ${ROLES[req.body.role]}.`);
  }
  res.redirect('/org/team');
});

// ---- project templates (phases, subphases, tasks, deliverables, approvals) with versions
router.get('/org/templates', async (req, res) => {
  await S.ensureDefaultTemplate(req.org.id, req.user.id);
  const all = await db.all('SELECT t.*, u.name author FROM templates t LEFT JOIN users u ON u.id = t.created_by WHERE t.org_id = ? ORDER BY t.family_id, t.version DESC', req.org.id);
  res.render('org/templates', { title: 'Project templates', templates: all });
});
router.get('/org/templates/new', perm('project_manage'), async (req, res) => {
  const base = req.query.from ? await db.get('SELECT * FROM templates WHERE id = ? AND org_id = ?', req.query.from, req.org.id) : null;
  res.render('org/template-edit', { title: 'New template', tpl: { name: base ? `${base.name} (copy)` : '', body: base ? base.body : '' }, isNew: true, parsed: null });
});
router.get('/org/templates/:id', async (req, res, next) => {
  const tpl = await db.get('SELECT * FROM templates WHERE id = ? AND org_id = ?', req.params.id, req.org.id);
  if (!tpl) return next(httpError(404, 'Template not found.'));
  const versions = await db.all('SELECT t.*, u.name author FROM templates t LEFT JOIN users u ON u.id = t.created_by WHERE t.family_id = ? ORDER BY version DESC', tpl.family_id);
  res.render('org/template-edit', { title: tpl.name, tpl, versions, isNew: false, parsed: parseTemplate(tpl.body) });
});
router.post('/org/templates', perm('project_manage'), async (req, res) => {
  const name = String(req.body.name || '').trim();
  const { errors } = parseTemplate(req.body.body);
  if (!name) errors.unshift('Template name is required.');
  const familyId = int(req.body.family_id);
  if (errors.length) {
    return res.status(422).render('org/template-edit', { title: 'Template', tpl: { ...req.body, family_id: familyId }, isNew: !familyId, errors, parsed: null });
  }
  const id = await db.tx(async () => {
    if (familyId) {
      const fam = await db.get('SELECT MAX(version) v FROM templates WHERE family_id = ? AND org_id = ?', familyId, req.org.id);
      if (!fam || fam.v == null) throw httpError(404, 'Template not found.');
      await db.run('UPDATE templates SET is_current = 0 WHERE family_id = ?', familyId);
      return await db.insert('templates', { org_id: req.org.id, family_id: familyId, name, version: fam.v + 1, body: req.body.body, notes: req.body.notes, created_by: req.user.id });
    }
    const nid = await db.insert('templates', { org_id: req.org.id, name, version: 1, body: req.body.body, notes: req.body.notes, created_by: req.user.id });
    await db.run('UPDATE templates SET family_id = ? WHERE id = ?', nid, nid);
    return nid;
  });
  req.flash('success', familyId ? 'New template version saved for future projects.' : 'Template saved.');
  res.redirect(`/org/templates/${id}`);
});

// ---- email log (audit of every notification / reminder email)
router.get('/org/emails', perm('org_manage'), async (req, res) => {
  const cat = req.query.category;
  const rows = cat
    ? await db.all('SELECT id, to_email, subject, category, status, error, created_at FROM email_log WHERE org_id = ? AND category = ? ORDER BY id DESC LIMIT 300', req.org.id, cat)
    : await db.all('SELECT id, to_email, subject, category, status, error, created_at FROM email_log WHERE org_id = ? ORDER BY id DESC LIMIT 300', req.org.id);
  res.render('org/emails', { title: 'Email log', rows, cat });
});
router.get('/org/emails/:id', perm('org_manage'), async (req, res, next) => {
  const row = await db.get('SELECT * FROM email_log WHERE id = ? AND org_id = ?', req.params.id, req.org.id);
  if (!row) return next(httpError(404, 'Email not found.'));
  res.set('Content-Security-Policy', "default-src 'none'; style-src 'unsafe-inline'; img-src data:");
  res.type('html').send(row.body_html);
});
router.post('/org/reminders/run', perm('org_manage'), async (req, res) => {
  const r = await require('../scheduler').runReminders();
  req.flash('success', `Reminder run complete — ${r.total} email(s) sent.`);
  res.redirect('/org/emails');
});

module.exports = router;
