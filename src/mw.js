'use strict';
const db = require('./db');
const S = require('./services');

const httpError = (status, message) => Object.assign(new Error(message), { status });

function requireAuth(req, res, next) {
  if (!req.user) return res.redirect(`/login?next=${encodeURIComponent(req.originalUrl)}`);
  if (!req.user.email_verified) return res.redirect('/verify-pending');
  next();
}

/** Signed in + verified + member of a workspace + plan chosen (admins) + read-only if subscription lapsed. */
function requireOrg(req, res, next) {
  requireAuth(req, res, () => {
    if (!req.org) return res.redirect('/onboarding/workspace');
    const p = req.originalUrl.split('?')[0];
    if (req.sub.needsPlan && req.role === 'admin' && !p.startsWith('/billing') && !p.startsWith('/onboarding')) {
      return res.redirect('/onboarding/plan');
    }
    if (req.sub.expired && req.method !== 'GET' && !p.startsWith('/billing') && !p.startsWith('/onboarding')) {
      req.flash('error', 'Your subscription is inactive — the workspace is read-only. Choose a plan to continue.');
      return res.redirect('/billing');
    }
    next();
  });
}

const perm = (p) => (req, res, next) => (req.can(p) ? next() : next(httpError(403, 'You do not have permission to do that.')));

/** Load :pid as req.project (and res.locals.project) after checking access. */
async function loadProject(req, res, next) {
  const project = await db.get('SELECT * FROM projects WHERE id = ? AND org_id = ?', req.params.pid, req.org.id);
  if (!project || !await S.canAccessProject(project, req.user, req.role)) return next(httpError(404, 'Project not found.'));
  req.project = project;
  res.locals.project = project;
  next();
}

/** Block changes on closed (archived) projects. */
function projectOpen(req, res, next) {
  if (req.project.status !== 'active' && req.method !== 'GET') {
    req.flash('error', 'This project is closed and archived — it can no longer be changed.');
    return res.redirect(`/projects/${req.project.id}`);
  }
  next();
}

const back = (req, fallback = '/dashboard') => {
  const ref = req.get('referer');
  try { if (ref && new URL(ref).host === req.get('host')) return ref; } catch { /* ignore */ }
  return fallback;
};

module.exports = { httpError, requireAuth, requireOrg, perm, loadProject, projectOpen, back };
