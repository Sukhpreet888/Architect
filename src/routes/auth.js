'use strict';
const router = require('express').Router();
const db = require('../db');
const N = require('../notify');
const { config } = require('../config');
const { hashPassword, checkPassword, token, isEmail } = require('../util');

const safeNext = (n) => (typeof n === 'string' && n.startsWith('/') && !n.startsWith('//') ? n : '/dashboard');

router.get('/register', (req, res) => res.render('auth/register', { title: 'Create your account', form: {} }));
router.post('/register', async (req, res) => {
  const name = String(req.body.name || '').trim();
  const email = String(req.body.email || '').trim().toLowerCase();
  const password = String(req.body.password || '');
  const errors = [];
  if (!name) errors.push('Name is required.');
  if (!isEmail(email)) errors.push('Enter a valid email address.');
  if (password.length < 8) errors.push('Password must be at least 8 characters.');
  if (await db.get('SELECT 1 FROM users WHERE email = ?', email)) errors.push('An account with this email already exists. Try signing in.');
  if (errors.length) return res.status(422).render('auth/register', { title: 'Create your account', form: { name, email }, errors });
  // First-run bootstrap: while email delivery is not configured, the very first account on a fresh install is
  // verified immediately (nobody could receive the link). Every later sign-up must verify by email.
  const bootstrap = !config.mail.host && process.env.BOOTSTRAP_FIRST_USER !== '0'
    && (await db.get('SELECT COUNT(*) c FROM users')).c === 0;
  const verify_token = bootstrap ? null : token();
  const id = await db.insert('users', { name, email, password_hash: hashPassword(password), verify_token, email_verified: bootstrap ? 1 : 0 });
  req.session.userId = id;
  if (bootstrap) {
    req.flash('success', 'Welcome! As the first user of this ARCHFLOW installation your account is verified. Set up SMTP so teammates receive their emails.');
    return res.redirect('/dashboard');
  }
  await N.verification({ name, email, verify_token });
  res.redirect('/verify-pending');
});

router.get('/verify-pending', (req, res) => {
  if (!req.user) return res.redirect('/login');
  if (req.user.email_verified) return res.redirect('/dashboard');
  res.render('auth/verify-pending', { title: 'Verify your email' });
});
router.post('/verify/resend', async (req, res) => {
  if (!req.user) return res.redirect('/login');
  const u = await db.get('SELECT * FROM users WHERE id = ?', req.user.id);
  if (!u.email_verified) {
    const t = token();
    await db.run('UPDATE users SET verify_token = ? WHERE id = ?', t, u.id);
    await N.verification({ ...u, verify_token: t });
    req.flash('success', `Verification email re-sent to ${u.email}.`);
  }
  res.redirect('/verify-pending');
});
router.get('/verify/:token', async (req, res) => {
  const u = await db.get('SELECT * FROM users WHERE verify_token = ?', req.params.token);
  if (!u) { req.flash('error', 'That verification link is invalid or has already been used.'); return res.redirect(req.user ? '/verify-pending' : '/login'); }
  await db.run('UPDATE users SET email_verified = 1, verify_token = NULL WHERE id = ?', u.id);
  req.session.userId = u.id;
  req.flash('success', 'Email verified. Let\'s set up your workspace.');
  res.redirect('/dashboard');
});

router.get('/login', (req, res) => res.render('auth/login', { title: 'Sign in', next: req.query.next || '' }));
router.post('/login', async (req, res) => {
  const email = String(req.body.email || '').trim().toLowerCase();
  const u = await db.get('SELECT * FROM users WHERE email = ?', email);
  if (!u || !checkPassword(req.body.password || '', u.password_hash)) {
    return res.status(401).render('auth/login', { title: 'Sign in', next: req.body.next || '', errors: ['Invalid email or password.'], email });
  }
  req.session.userId = u.id;
  req.session.orgId = undefined;
  res.redirect(u.email_verified ? safeNext(req.body.next) : '/verify-pending');
});
router.post('/logout', (req, res) => { req.session = null; res.redirect('/'); });

router.get('/forgot', (req, res) => res.render('auth/forgot', { title: 'Forgot password' }));
router.post('/forgot', async (req, res) => {
  const u = await db.get('SELECT * FROM users WHERE email = ?', String(req.body.email || '').trim().toLowerCase());
  if (u) {
    const t = token();
    await db.run("UPDATE users SET reset_token = ?, reset_expires = to_char((now() + interval '1 hour') AT TIME ZONE 'utc', 'YYYY-MM-DD HH24:MI:SS') WHERE id = ?", t, u.id);
    await N.passwordReset(u, t);
  }
  req.flash('success', 'If that email has an account, a reset link is on its way.');
  res.redirect('/login');
});
router.get('/reset/:token', async (req, res) => {
  const u = await db.get("SELECT id FROM users WHERE reset_token = ? AND reset_expires > to_char(now() AT TIME ZONE 'utc', 'YYYY-MM-DD HH24:MI:SS')", req.params.token);
  if (!u) { req.flash('error', 'Reset link is invalid or expired.'); return res.redirect('/forgot'); }
  res.render('auth/reset', { title: 'Choose a new password', token: req.params.token });
});
router.post('/reset/:token', async (req, res) => {
  const u = await db.get("SELECT id FROM users WHERE reset_token = ? AND reset_expires > to_char(now() AT TIME ZONE 'utc', 'YYYY-MM-DD HH24:MI:SS')", req.params.token);
  if (!u) { req.flash('error', 'Reset link is invalid or expired.'); return res.redirect('/forgot'); }
  if (String(req.body.password || '').length < 8) return res.status(422).render('auth/reset', { title: 'Choose a new password', token: req.params.token, errors: ['Password must be at least 8 characters.'] });
  await db.run('UPDATE users SET password_hash = ?, reset_token = NULL, reset_expires = NULL, email_verified = 1 WHERE id = ?', hashPassword(req.body.password), u.id);
  req.flash('success', 'Password updated. Please sign in.');
  res.redirect('/login');
});

// ---- team invitations
async function loadInvite(req, res, next) {
  const inv = await db.get('SELECT i.*, o.name org_name FROM invites i JOIN orgs o ON o.id = i.org_id WHERE i.token = ? AND i.accepted_at IS NULL', req.params.token);
  if (!inv) { req.flash('error', 'This invitation is invalid or was already accepted.'); return res.redirect('/login'); }
  req.invite = inv; next();
}
async function acceptInto(inv, userId) {
  await db.tx(async () => {
    await db.run('INSERT INTO memberships (org_id, user_id, role) VALUES (?, ?, ?) ON CONFLICT DO NOTHING', inv.org_id, userId, inv.role);
    await db.run('UPDATE memberships SET active = 1, role = ? WHERE org_id = ? AND user_id = ?', inv.role, inv.org_id, userId);
    await db.run("UPDATE invites SET accepted_at = to_char(now() AT TIME ZONE 'utc', 'YYYY-MM-DD HH24:MI:SS') WHERE id = ?", inv.id);
  });
}
router.get('/invite/:token', loadInvite, async (req, res) => {
  const existing = await db.get('SELECT id FROM users WHERE email = ?', req.invite.email);
  res.render('auth/invite', { title: `Join ${req.invite.org_name}`, invite: req.invite, existing: !!existing });
});
router.post('/invite/:token', loadInvite, async (req, res) => {
  const inv = req.invite;
  let u = await db.get('SELECT * FROM users WHERE email = ?', inv.email);
  if (u) {
    if (!checkPassword(req.body.password || '', u.password_hash)) {
      return res.status(401).render('auth/invite', { title: `Join ${inv.org_name}`, invite: inv, existing: true, errors: ['Incorrect password.'] });
    }
    await db.run('UPDATE users SET email_verified = 1 WHERE id = ?', u.id);
  } else {
    const name = String(req.body.name || '').trim();
    if (!name || String(req.body.password || '').length < 8) {
      return res.status(422).render('auth/invite', { title: `Join ${inv.org_name}`, invite: inv, existing: false, errors: ['Enter your name and a password of at least 8 characters.'] });
    }
    // the invite link arrived by email, so the address is verified
    const id = await db.insert('users', { name, email: inv.email, password_hash: hashPassword(req.body.password), email_verified: 1 });
    u = { id };
  }
  await acceptInto(inv, u.id);
  req.session.userId = u.id; req.session.orgId = inv.org_id;
  req.flash('success', `Welcome to ${inv.org_name}!`);
  res.redirect('/dashboard');
});

module.exports = router;
