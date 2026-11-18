'use strict';
const path = require('path');
const express = require('express');
const cookieSession = require('cookie-session');
const db = require('./db');
const C = require('./config');
const U = require('./util');
const S = require('./services');

const app = express();
app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, '..', 'views'));
app.set('trust proxy', 1);
app.disable('x-powered-by');

app.use('/static', express.static(path.join(__dirname, '..', 'public'), { maxAge: '1h' }));
app.use(express.urlencoded({ extended: true, limit: '2mb' }));
app.use(express.json({ limit: '1mb' }));
app.use(cookieSession({
  name: 'archflow', keys: [C.config.sessionSecret], maxAge: 14 * 24 * 3600 * 1000, sameSite: 'lax', httpOnly: true,
  secure: C.config.appUrl.startsWith('https://'),
}));

// CSRF defence: state-changing requests from a browser must originate from this site.
app.use((req, res, next) => {
  if (['GET', 'HEAD', 'OPTIONS'].includes(req.method)) return next();
  const src = req.get('origin') || req.get('referer');
  if (!src) return next();
  try { if (new URL(src).host === req.get('host')) return next(); } catch { /* fallthrough */ }
  res.status(403).send('Cross-site request blocked');
});

// flash messages + view helpers
app.use((req, res, next) => {
  req.flash = (type, msg) => { req.session.flash = [...(req.session.flash || []), { type, msg }]; };
  res.locals.flash = req.session.flash || [];
  req.session.flash = undefined;
  Object.assign(res.locals, {
    U, C, fmtDate: U.fmtDate, fmtBytes: U.fmtBytes, esc: U.esc, path: req.path, query: req.query,
    badge: (st, label) => {
      const cls = { completed: 'green', approved: 'green', paid: 'green', done: 'green', active: 'green', resolved: 'green', sent: 'green',
        in_progress: 'blue', issued: 'blue', in_review: 'blue', review: 'blue', pending: 'amber', submitted: 'blue', scheduled: 'blue', trial: 'blue', logged: 'blue',
        partial: 'amber', revision_required: 'amber', draft: '', disputed: 'amber', open: 'amber', high: 'amber', past_due: 'red', queued: 'amber',
        overdue: 'red', rejected: 'red', urgent: 'red', critical: 'red', failed: 'red', cancelled: '', closed: '' }[st] ?? '';
      const text = label || String(st || '').replace(/_/g, ' ');
      return `<span class="badge${cls ? ` b-${cls}` : ''}">${U.esc(text.charAt(0).toUpperCase() + text.slice(1))}</span>`;
    },
    title: 'ARCHFLOW', user: null, org: null, role: null, can: () => false, sub: null,
  });
  next();
});

// load session user / organisation / role
app.use((req, res, next) => {
  const uid = req.session.userId;
  if (!uid) return next();
  const user = db.get('SELECT id, name, email, email_verified FROM users WHERE id = ?', uid);
  if (!user) { req.session = null; return next(); }
  req.user = user; res.locals.user = user;
  let m = req.session.orgId && db.get('SELECT * FROM memberships WHERE user_id = ? AND org_id = ? AND active = 1', uid, req.session.orgId);
  if (!m) m = db.get('SELECT * FROM memberships WHERE user_id = ? AND active = 1 ORDER BY id LIMIT 1', uid);
  if (m) {
    req.session.orgId = m.org_id;
    req.org = db.get('SELECT * FROM orgs WHERE id = ?', m.org_id);
    req.role = m.role;
    req.can = (p) => S.can(req.role, p);
    req.sub = S.subscriptionState(req.org);
    Object.assign(res.locals, { org: req.org, role: req.role, can: req.can, sub: req.sub,
      money: (n) => U.fmtMoney(n, req.org.currency),
      orgs: db.all('SELECT o.id, o.name FROM memberships m JOIN orgs o ON o.id = m.org_id WHERE m.user_id = ? AND m.active = 1', uid) });
  }
  next();
});

app.use(require('./routes/public'));
app.use(require('./routes/auth'));
app.use(require('./routes/onboarding'));
app.use(require('./routes/org'));
app.use(require('./routes/billing'));
app.use(require('./routes/dashboard'));
app.use(require('./routes/projects'));
app.use(require('./routes/tasks'));
app.use(require('./routes/documents'));
app.use(require('./routes/approvals'));
app.use(require('./routes/payments'));
app.use(require('./routes/construction'));
app.use(require('./routes/reports'));
app.use(require('./routes/closure'));

app.use((req, res) => res.status(404).render('error', { title: 'Not found', code: 404, message: 'The page you are looking for does not exist.' }));
// eslint-disable-next-line no-unused-vars
app.use((err, req, res, next) => {
  if (err.status && err.status < 500) return res.status(err.status).render('error', { title: 'Error', code: err.status, message: err.message });
  console.error(err);
  res.status(500).render('error', { title: 'Error', code: 500, message: 'Something went wrong. Please try again.' });
});

module.exports = app;
