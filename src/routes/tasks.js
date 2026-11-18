'use strict';
const router = require('express').Router();
const db = require('../db');
const N = require('../notify');
const S = require('../services');
const { PRIORITIES, TASK_STATUSES } = require('../config');
const { requireOrg, perm, loadProject, projectOpen, httpError, back } = require('../mw');
const { int, isDate, today, addDays } = require('../util');

router.use(['/tasks', '/projects'], requireOrg);

function calendar(month) {
  const m = /^\d{4}-\d{2}$/.test(month || '') ? month : today().slice(0, 7);
  const first = `${m}-01`;
  const startDow = (new Date(`${first}T00:00:00Z`).getUTCDay() + 6) % 7; // Monday first
  const gridStart = addDays(first, -startDow);
  const days = Array.from({ length: 42 }, (_, i) => addDays(gridStart, i));
  const [y, mo] = m.split('-').map(Number);
  const prev = mo === 1 ? `${y - 1}-12` : `${y}-${String(mo - 1).padStart(2, '0')}`;
  const next = mo === 12 ? `${y + 1}-01` : `${y}-${String(mo + 1).padStart(2, '0')}`;
  return { month: m, days, prev, next, label: new Date(`${first}T00:00:00Z`).toLocaleDateString('en-GB', { month: 'long', year: 'numeric', timeZone: 'UTC' }) };
}

function viewData(req, tasks) {
  const view = ['list', 'kanban', 'calendar'].includes(req.query.view) ? req.query.view : 'list';
  return { view, tasks, cal: view === 'calendar' ? calendar(req.query.month) : null, today: today() };
}

// ---- Org-wide task management (tasks across all visible projects)
router.get('/tasks', async (req, res) => {
  const projects = await S.visibleProjects(req.org.id, req.user, req.role, { status: 'active' });
  const ids = projects.map((p) => p.id).join(',') || '0';
  const mine = req.query.scope !== 'all';
  const tasks = await db.all(`SELECT t.*, u.name assignee, p.name project_name, p.code FROM tasks t JOIN projects p ON p.id = t.project_id
    LEFT JOIN users u ON u.id = t.assignee_id WHERE t.project_id IN (${ids}) ${mine ? 'AND t.assignee_id = ?' : ''}
    ORDER BY t.due_date IS NULL, t.due_date, t.id`, ...(mine ? [req.user.id] : []));
  res.render('tasks/index', { title: 'Task management', scope: mine ? 'mine' : 'all', ...viewData(req, tasks), base: '/tasks' });
});

// ---- Project tasks
router.get('/projects/:pid/tasks', loadProject, async (req, res) => {
  const filter = req.query.phase ? 'AND t.phase_id = ?' : '';
  const tasks = await db.all(`SELECT t.*, u.name assignee, ph.name phase_name FROM tasks t LEFT JOIN users u ON u.id = t.assignee_id
    LEFT JOIN phases ph ON ph.id = t.phase_id WHERE t.project_id = ? ${filter} ORDER BY t.due_date IS NULL, t.due_date, t.id`,
  req.project.id, ...(req.query.phase ? [req.query.phase] : []));
  res.render('tasks/project', {
    title: `${req.project.name} — Tasks`, ...viewData(req, tasks), base: `/projects/${req.project.id}/tasks`,
    phases: await db.all("SELECT * FROM phases WHERE project_id = ? AND status != 'na' ORDER BY seq", req.project.id),
    team: await S.projectTeam(req.project.id), allTasks: await db.all('SELECT id, title FROM tasks WHERE project_id = ? ORDER BY id', req.project.id),
    deliverables: await db.all('SELECT id, name FROM deliverables WHERE project_id = ? ORDER BY id', req.project.id),
  });
});

async function validTask(req, b, existingId) {
  const errors = [];
  const pid = req.project.id;
  const out = {};
  if (b.title !== undefined) { out.title = String(b.title).trim(); if (!out.title) errors.push('Title is required.'); }
  if (b.description !== undefined) out.description = b.description;
  if (b.priority !== undefined) { if (!PRIORITIES[b.priority]) errors.push('Invalid priority.'); else out.priority = b.priority; }
  for (const k of ['start_date', 'due_date']) if (b[k] !== undefined) { if (b[k] && !isDate(b[k])) errors.push(`Invalid ${k.replace('_', ' ')}.`); out[k] = b[k] || null; }
  if (out.start_date && out.due_date && out.due_date < out.start_date) errors.push('Due date must be on or after the start date.');
  if (b.assignee_id !== undefined) {
    const a = int(b.assignee_id);
    if (a && !await S.isOrgUser(req.org.id, a)) errors.push('Invalid assignee.');
    out.assignee_id = a || null;
    if (a) await db.run('INSERT INTO project_members (project_id, user_id) VALUES (?, ?) ON CONFLICT DO NOTHING', pid, a);
  }
  if (b.phase_id !== undefined) { const v = int(b.phase_id); out.phase_id = v && await db.get('SELECT 1 FROM phases WHERE id = ? AND project_id = ?', v, pid) ? v : null; }
  if (b.deliverable_id !== undefined) { const v = int(b.deliverable_id); out.deliverable_id = v && await db.get('SELECT 1 FROM deliverables WHERE id = ? AND project_id = ?', v, pid) ? v : null; }
  if (b.depends_on !== undefined) {
    const v = int(b.depends_on);
    if (v && (v === existingId || !await db.get('SELECT 1 FROM tasks WHERE id = ? AND project_id = ?', v, pid))) errors.push('Invalid dependency.');
    else if (v && existingId) {
      // prevent cycles
      let cur = v; const seen = new Set();
      while (cur && !seen.has(cur)) { if (cur === existingId) { errors.push('That dependency would create a cycle.'); break; } seen.add(cur); cur = (await db.get('SELECT depends_on FROM tasks WHERE id = ?', cur))?.depends_on; }
    }
    out.depends_on = v || null;
  }
  if (b.progress !== undefined) out.progress = Math.max(0, Math.min(100, int(b.progress) || 0));
  if (b.status !== undefined) { if (!TASK_STATUSES[b.status]) errors.push('Invalid status.'); else out.status = b.status; }
  return { out, errors };
}

async function dependencyBlock(task, status) {
  if (!task.depends_on || !['in_progress', 'review', 'done'].includes(status)) return null;
  const dep = await db.get('SELECT * FROM tasks WHERE id = ?', task.depends_on);
  return dep && dep.status !== 'done' ? `Blocked: "${dep.title}" must be completed first.` : null;
}

/** Apply automatic phase completion/re-opening after task changes, emailing the team when a phase completes. */
async function syncPhases(req, phaseIds) {
  const msgs = [];
  for (const pid of [...new Set(phaseIds.filter(Boolean))]) {
    const r = await S.syncPhaseWithTasks(pid);
    if (r && r.completed) {
      await N.phaseCompleted(req.project, r.phase, r.next);
      msgs.push(r.next ? `All tasks done — phase "${r.phase.name}" completed; "${r.next.name}" is now in progress.` : `All tasks done — phase "${r.phase.name}" completed.`);
    } else if (r && r.reopened) msgs.push(`Phase "${r.phase.name}" re-opened because it has open tasks again.`);
  }
  return msgs;
}

router.post('/projects/:pid/tasks', loadProject, projectOpen, perm('task_manage'), async (req, res) => {
  const { out, errors } = await validTask(req, { priority: 'medium', ...req.body });
  if (errors.length) { req.flash('error', errors.join(' ')); return res.redirect(back(req)); }
  const id = await db.insert('tasks', { ...out, project_id: req.project.id, status: 'todo', created_by: req.user.id, source: 'manual' });
  const task = await db.get('SELECT * FROM tasks WHERE id = ?', id);
  if (task.assignee_id) await N.taskAssigned(task, req.project, req.user);
  req.flash('success', `Task created${task.assignee_id ? ' — assignee notified by email' : ''}.`);
  for (const m of await syncPhases(req, [task.phase_id])) req.flash('success', m);
  res.redirect(back(req, `/projects/${req.project.id}/tasks`));
});

async function loadTask(req, res, next) {
  const t = await db.get('SELECT * FROM tasks WHERE id = ? AND project_id = ?', req.params.tid, req.project.id);
  if (!t) return next(httpError(404, 'Task not found.'));
  req.task = t; next();
}

router.get('/projects/:pid/tasks/:tid', loadProject, loadTask, async (req, res) => {
  const t = req.task;
  res.render('tasks/show', {
    title: t.title, task: t, team: await S.projectTeam(req.project.id), assignee: await S.userById(t.assignee_id),
    phases: await db.all("SELECT * FROM phases WHERE project_id = ? AND status != 'na' ORDER BY seq", req.project.id),
    deliverables: await db.all('SELECT id, name FROM deliverables WHERE project_id = ?', req.project.id),
    otherTasks: await db.all('SELECT id, title, status FROM tasks WHERE project_id = ? AND id != ? ORDER BY id', req.project.id, t.id),
    dep: t.depends_on ? await db.get('SELECT * FROM tasks WHERE id = ?', t.depends_on) : null,
    blocking: await db.all('SELECT id, title, status FROM tasks WHERE depends_on = ?', t.id),
    documents: await db.all('SELECT * FROM documents WHERE task_id = ?', t.id),
  });
});

router.post('/projects/:pid/tasks/:tid', loadProject, projectOpen, loadTask, perm('task_manage'), async (req, res) => {
  const before = req.task;
  const isAssignee = before.assignee_id === req.user.id;
  if (!req.can('project_manage') && !isAssignee && before.created_by !== req.user.id) {
    // other team members may only update status/progress
    for (const k of Object.keys(req.body)) if (!['status', 'progress'].includes(k)) delete req.body[k];
  }
  if (req.body.action === 'delete') {
    if (!req.can('project_manage') && before.created_by !== req.user.id) throw httpError(403, 'Only managers or the creator can delete a task.');
    await db.run('DELETE FROM tasks WHERE id = ?', before.id);
    req.flash('success', 'Task deleted.');
    for (const m of await syncPhases(req, [before.phase_id])) req.flash('success', m);
    return res.redirect(`/projects/${req.project.id}/tasks`);
  }
  const { out, errors } = await validTask(req, req.body, before.id);
  const block = await dependencyBlock({ ...before, ...out }, out.status);
  if (block) errors.push(block);
  if (errors.length) {
    if (req.accepts(['html', 'json']) === 'json' && req.is('json')) return res.status(422).json({ errors });
    req.flash('error', errors.join(' ')); return res.redirect(back(req));
  }
  if (out.status === 'done') { out.progress = 100; out.completed_at = today(); } else if (out.status && before.status === 'done') out.completed_at = null;
  await db.update('tasks', before.id, out);
  const after = await db.get('SELECT * FROM tasks WHERE id = ?', before.id);
  // email notifications
  if (after.assignee_id && after.assignee_id !== before.assignee_id && after.assignee_id !== req.user.id) await N.taskAssigned(after, req.project, req.user);
  const changes = [];
  if (after.status !== before.status) changes.push(`status → ${TASK_STATUSES[after.status]}`);
  if (after.due_date !== before.due_date) changes.push(`due date → ${after.due_date || 'none'}`);
  if (after.priority !== before.priority) changes.push(`priority → ${PRIORITIES[after.priority]}`);
  if (changes.length) await N.taskUpdated(after, req.project, req.user, changes.join(', '));
  const phaseMsgs = await syncPhases(req, [before.phase_id, after.phase_id]);
  if (req.is('json')) return res.json({ ok: true, task: after, messages: phaseMsgs });
  req.flash('success', 'Task updated.');
  for (const m of phaseMsgs) req.flash('success', m);
  res.redirect(back(req, `/projects/${req.project.id}/tasks/${before.id}`));
});

module.exports = router;
