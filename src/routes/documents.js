'use strict';
const router = require('express').Router();
const db = require('../db');
const N = require('../notify');
const { requireOrg, perm, loadProject, projectOpen, httpError, back } = require('../mw');
const { single } = require('../upload');
const storage = require('../storage');
const { int } = require('../util');

router.use('/projects', requireOrg);

const canSeeDoc = (req, doc) => !doc.restricted || req.can('doc_restricted') || doc.created_by === req.user.id;

router.get('/projects/:pid/documents', loadProject, async (req, res) => {
  const phases = await db.all('SELECT * FROM phases WHERE project_id = ? ORDER BY seq', req.project.id);
  const docs = (await db.all(`SELECT d.*, v.version rev, v.original_name, v.size, v.created_at updated_at, u.name uploader, t.title task_title, dl.name deliverable_name
    FROM documents d JOIN document_versions v ON v.document_id = d.id AND v.version = (SELECT MAX(version) FROM document_versions WHERE document_id = d.id)
    LEFT JOIN users u ON u.id = v.uploaded_by LEFT JOIN tasks t ON t.id = d.task_id LEFT JOIN deliverables dl ON dl.id = d.deliverable_id
    WHERE d.project_id = ? ORDER BY d.phase_id, d.title`, req.project.id)).filter((d) => canSeeDoc(req, d));
  res.render('documents/index', {
    title: `${req.project.name} — Documents & drawings`, phases, docs, phaseFilter: int(req.query.phase),
    tasks: await db.all('SELECT id, title FROM tasks WHERE project_id = ? ORDER BY id', req.project.id),
    deliverables: await db.all('SELECT id, name FROM deliverables WHERE project_id = ? ORDER BY id', req.project.id),
  });
});

async function scoped(req, table, id) { return id && await db.get(`SELECT id FROM ${table} WHERE id = ? AND project_id = ?`, id, req.project.id) ? id : null; }

router.post('/projects/:pid/documents', loadProject, projectOpen, perm('doc_upload'), single('file'), async (req, res) => {
  if (!req.file) { req.flash('error', req.uploadError || 'Choose a file to upload.'); return res.redirect(back(req)); }
  const title = String(req.body.title || '').trim() || req.file.originalname;
  const id = await db.tx(async () => {
    const docId = await db.insert('documents', {
      project_id: req.project.id, phase_id: await scoped(req, 'phases', int(req.body.phase_id)), title, category: req.body.category,
      task_id: await scoped(req, 'tasks', int(req.body.task_id)), deliverable_id: await scoped(req, 'deliverables', int(req.body.deliverable_id)),
      restricted: req.body.restricted === '1' && req.can('doc_restricted') ? 1 : 0, created_by: req.user.id,
    });
    await db.insert('document_versions', { document_id: docId, version: 1, stored_name: req.file.filename, original_name: req.file.originalname, mime: req.file.mimetype, size: req.file.size, notes: req.body.notes || 'Initial upload', uploaded_by: req.user.id });
    return docId;
  });
  const doc = await db.get('SELECT * FROM documents WHERE id = ?', id);
  await N.documentVersion(doc, { version: 1, original_name: req.file.originalname, notes: req.body.notes }, req.project, req.user);
  req.flash('success', `Uploaded "${title}" (revision 1).`);
  res.redirect(back(req, `/projects/${req.project.id}/documents/${id}`));
});

async function loadDoc(req, res, next) {
  const doc = await db.get('SELECT * FROM documents WHERE id = ? AND project_id = ?', req.params.did, req.project.id);
  if (!doc || !canSeeDoc(req, doc)) return next(httpError(404, 'Document not found.'));
  req.doc = doc; next();
}

router.get('/projects/:pid/documents/:did', loadProject, loadDoc, async (req, res) => {
  res.render('documents/show', {
    title: req.doc.title, doc: req.doc,
    versions: await db.all('SELECT v.*, u.name uploader FROM document_versions v LEFT JOIN users u ON u.id = v.uploaded_by WHERE document_id = ? ORDER BY version DESC', req.doc.id),
    phases: await db.all('SELECT * FROM phases WHERE project_id = ? ORDER BY seq', req.project.id),
    tasks: await db.all('SELECT id, title FROM tasks WHERE project_id = ? ORDER BY id', req.project.id),
    deliverables: await db.all('SELECT id, name FROM deliverables WHERE project_id = ? ORDER BY id', req.project.id),
    approvals: await db.all('SELECT * FROM approvals WHERE document_id = ?', req.doc.id),
  });
});

// New revision — previous versions are kept (never overwritten)
router.post('/projects/:pid/documents/:did/versions', loadProject, projectOpen, loadDoc, perm('doc_upload'), single('file'), async (req, res) => {
  if (!req.file) { req.flash('error', req.uploadError || 'Choose a file to upload.'); return res.redirect(back(req)); }
  const version = (await db.get('SELECT MAX(version) v FROM document_versions WHERE document_id = ?', req.doc.id)).v + 1;
  const ver = { document_id: req.doc.id, version, stored_name: req.file.filename, original_name: req.file.originalname, mime: req.file.mimetype, size: req.file.size, notes: req.body.notes, uploaded_by: req.user.id };
  await db.insert('document_versions', ver);
  await N.documentVersion(req.doc, ver, req.project, req.user);
  req.flash('success', `Revision ${version} uploaded.`);
  res.redirect(`/projects/${req.project.id}/documents/${req.doc.id}`);
});

router.post('/projects/:pid/documents/:did/link', loadProject, projectOpen, loadDoc, perm('doc_upload'), async (req, res) => {
  const upd = {
    task_id: await scoped(req, 'tasks', int(req.body.task_id)), deliverable_id: await scoped(req, 'deliverables', int(req.body.deliverable_id)),
    phase_id: await scoped(req, 'phases', int(req.body.phase_id)), category: req.body.category, title: String(req.body.title || req.doc.title).trim(),
  };
  if (req.can('doc_restricted')) upd.restricted = req.body.restricted === '1' ? 1 : 0;
  await db.update('documents', req.doc.id, upd);
  req.flash('success', 'Document details & links updated.');
  res.redirect(`/projects/${req.project.id}/documents/${req.doc.id}`);
});

router.post('/projects/:pid/documents/:did/delete', loadProject, projectOpen, loadDoc, perm('project_manage'), async (req, res) => {
  const vers = await db.all('SELECT stored_name FROM document_versions WHERE document_id = ?', req.doc.id);
  await db.run('DELETE FROM documents WHERE id = ?', req.doc.id);
  for (const v of vers) await storage.remove(v.stored_name);
  req.flash('success', 'Document deleted.');
  res.redirect(`/projects/${req.project.id}/documents`);
});

router.get('/projects/:pid/documents/:did/versions/:vid/download', loadProject, loadDoc, async (req, res, next) => {
  const v = await db.get('SELECT * FROM document_versions WHERE id = ? AND document_id = ?', req.params.vid, req.doc.id);
  if (!v || !(await storage.send(res, v.stored_name, v.original_name))) return next(httpError(404, 'File not found.'));
});

module.exports = router;
