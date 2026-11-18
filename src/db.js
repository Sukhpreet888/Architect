'use strict';
const fs = require('fs');
const path = require('path');
const { DatabaseSync } = require('node:sqlite');
const { config } = require('./config');

fs.mkdirSync(path.dirname(config.dbFile), { recursive: true });
fs.mkdirSync(config.uploadDir, { recursive: true });

const SCHEMA = `
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY, email TEXT UNIQUE NOT NULL, name TEXT NOT NULL, password_hash TEXT NOT NULL,
  email_verified INTEGER NOT NULL DEFAULT 0, verify_token TEXT, reset_token TEXT, reset_expires TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS orgs (
  id INTEGER PRIMARY KEY, name TEXT NOT NULL, address TEXT, phone TEXT, website TEXT,
  currency TEXT NOT NULL DEFAULT 'INR', timezone TEXT NOT NULL DEFAULT 'Asia/Kolkata', area_unit TEXT NOT NULL DEFAULT 'sqft',
  invoice_prefix TEXT NOT NULL DEFAULT 'INV', billing_email TEXT,
  plan TEXT, plan_status TEXT NOT NULL DEFAULT 'trial', trial_ends_at TEXT NOT NULL,
  custom_users INTEGER, custom_projects INTEGER, custom_storage_mb INTEGER,
  extra_users INTEGER NOT NULL DEFAULT 0, extra_projects INTEGER NOT NULL DEFAULT 0, extra_storage_mb INTEGER NOT NULL DEFAULT 0,
  card_last4 TEXT, card_brand TEXT, next_billing_date TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS memberships (
  id INTEGER PRIMARY KEY, org_id INTEGER NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE, role TEXT NOT NULL,
  active INTEGER NOT NULL DEFAULT 1, created_at TEXT NOT NULL DEFAULT (datetime('now')), UNIQUE(org_id, user_id)
);
CREATE TABLE IF NOT EXISTS invites (
  id INTEGER PRIMARY KEY, org_id INTEGER NOT NULL REFERENCES orgs(id) ON DELETE CASCADE, email TEXT NOT NULL, name TEXT,
  role TEXT NOT NULL, token TEXT UNIQUE NOT NULL, invited_by INTEGER, accepted_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS billing_events (
  id INTEGER PRIMARY KEY, org_id INTEGER NOT NULL REFERENCES orgs(id) ON DELETE CASCADE, kind TEXT NOT NULL,
  description TEXT NOT NULL, amount REAL NOT NULL DEFAULT 0, status TEXT NOT NULL, created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS templates (
  id INTEGER PRIMARY KEY, org_id INTEGER NOT NULL REFERENCES orgs(id) ON DELETE CASCADE, family_id INTEGER, name TEXT NOT NULL,
  version INTEGER NOT NULL DEFAULT 1, body TEXT NOT NULL, is_current INTEGER NOT NULL DEFAULT 1, notes TEXT,
  created_by INTEGER, created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS projects (
  id INTEGER PRIMARY KEY, org_id INTEGER NOT NULL REFERENCES orgs(id) ON DELETE CASCADE, code TEXT NOT NULL, name TEXT NOT NULL,
  client_name TEXT, client_email TEXT, client_phone TEXT, location TEXT, description TEXT,
  type TEXT NOT NULL, subtype TEXT, plot_area REAL, built_up_area REAL, area_unit TEXT,
  start_date TEXT, end_date TEXT, scope TEXT NOT NULL DEFAULT 'design', template_id INTEGER, manager_id INTEGER,
  contract_value REAL, construction_budget REAL NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'active', closure_report TEXT, closed_at TEXT, created_by INTEGER,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS project_members (
  project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE, user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  PRIMARY KEY(project_id, user_id)
);
CREATE TABLE IF NOT EXISTS phases (
  id INTEGER PRIMARY KEY, project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE, seq INTEGER NOT NULL, name TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'not_started', planned_start TEXT, planned_end TEXT, started_at TEXT, completed_at TEXT
);
CREATE TABLE IF NOT EXISTS subphases (
  id INTEGER PRIMARY KEY, phase_id INTEGER NOT NULL REFERENCES phases(id) ON DELETE CASCADE, name TEXT NOT NULL, seq INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS deliverables (
  id INTEGER PRIMARY KEY, project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  phase_id INTEGER REFERENCES phases(id) ON DELETE CASCADE, subphase_id INTEGER REFERENCES subphases(id) ON DELETE SET NULL,
  name TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'pending', due_date TEXT, created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS tasks (
  id INTEGER PRIMARY KEY, project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  phase_id INTEGER REFERENCES phases(id) ON DELETE SET NULL, subphase_id INTEGER REFERENCES subphases(id) ON DELETE SET NULL,
  deliverable_id INTEGER REFERENCES deliverables(id) ON DELETE SET NULL,
  title TEXT NOT NULL, description TEXT, assignee_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
  start_date TEXT, due_date TEXT, priority TEXT NOT NULL DEFAULT 'medium', status TEXT NOT NULL DEFAULT 'todo',
  progress INTEGER NOT NULL DEFAULT 0, depends_on INTEGER REFERENCES tasks(id) ON DELETE SET NULL, source TEXT,
  created_by INTEGER, completed_at TEXT, created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS documents (
  id INTEGER PRIMARY KEY, project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  phase_id INTEGER REFERENCES phases(id) ON DELETE SET NULL, title TEXT NOT NULL, category TEXT,
  task_id INTEGER REFERENCES tasks(id) ON DELETE SET NULL, deliverable_id INTEGER REFERENCES deliverables(id) ON DELETE SET NULL,
  restricted INTEGER NOT NULL DEFAULT 0, created_by INTEGER, created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS document_versions (
  id INTEGER PRIMARY KEY, document_id INTEGER NOT NULL REFERENCES documents(id) ON DELETE CASCADE, version INTEGER NOT NULL,
  stored_name TEXT NOT NULL, original_name TEXT NOT NULL, mime TEXT, size INTEGER NOT NULL DEFAULT 0, notes TEXT,
  uploaded_by INTEGER, created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS approvals (
  id INTEGER PRIMARY KEY, project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  phase_id INTEGER REFERENCES phases(id) ON DELETE SET NULL, deliverable_id INTEGER REFERENCES deliverables(id) ON DELETE SET NULL,
  document_id INTEGER REFERENCES documents(id) ON DELETE SET NULL, type TEXT NOT NULL DEFAULT 'design', title TEXT NOT NULL,
  description TEXT, status TEXT NOT NULL DEFAULT 'draft', round INTEGER NOT NULL DEFAULT 1, requested_by INTEGER,
  requested_at TEXT, decided_at TEXT, created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS approval_reviewers (
  id INTEGER PRIMARY KEY, approval_id INTEGER NOT NULL REFERENCES approvals(id) ON DELETE CASCADE,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE, decision TEXT, comment TEXT, decided_at TEXT,
  UNIQUE(approval_id, user_id)
);
CREATE TABLE IF NOT EXISTS approval_history (
  id INTEGER PRIMARY KEY, approval_id INTEGER NOT NULL REFERENCES approvals(id) ON DELETE CASCADE, round INTEGER NOT NULL,
  user_id INTEGER, action TEXT NOT NULL, comment TEXT, created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS invoices (
  id INTEGER PRIMARY KEY, org_id INTEGER NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
  project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE, number TEXT NOT NULL, milestone TEXT NOT NULL,
  amount REAL NOT NULL, tax REAL NOT NULL DEFAULT 0, issue_date TEXT, due_date TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'draft', notes TEXT, created_by INTEGER, created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS payments (
  id INTEGER PRIMARY KEY, invoice_id INTEGER NOT NULL REFERENCES invoices(id) ON DELETE CASCADE, amount REAL NOT NULL,
  paid_on TEXT NOT NULL, method TEXT NOT NULL, reference TEXT, proof_name TEXT, proof_original TEXT, proof_size INTEGER NOT NULL DEFAULT 0,
  recorded_by INTEGER, created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS expenditures (
  id INTEGER PRIMARY KEY, project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE, category TEXT NOT NULL,
  description TEXT NOT NULL, vendor TEXT, amount REAL NOT NULL, spent_on TEXT NOT NULL, invoice_ref TEXT,
  status TEXT NOT NULL DEFAULT 'pending', decided_by INTEGER, created_by INTEGER, created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS suppliers (
  id INTEGER PRIMARY KEY, org_id INTEGER NOT NULL REFERENCES orgs(id) ON DELETE CASCADE, name TEXT NOT NULL,
  contact TEXT, email TEXT, phone TEXT, created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS materials (
  id INTEGER PRIMARY KEY, project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE, name TEXT NOT NULL,
  unit TEXT NOT NULL DEFAULT 'nos', stock REAL NOT NULL DEFAULT 0, reorder_level REAL NOT NULL DEFAULT 0,
  supplier_id INTEGER REFERENCES suppliers(id) ON DELETE SET NULL, created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS material_txns (
  id INTEGER PRIMARY KEY, material_id INTEGER NOT NULL REFERENCES materials(id) ON DELETE CASCADE, kind TEXT NOT NULL,
  qty REAL NOT NULL, unit_cost REAL NOT NULL DEFAULT 0, txn_date TEXT NOT NULL, note TEXT,
  expenditure_id INTEGER REFERENCES expenditures(id) ON DELETE SET NULL, created_by INTEGER,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS site_visits (
  id INTEGER PRIMARY KEY, project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE, visit_date TEXT NOT NULL,
  purpose TEXT NOT NULL, assigned_to INTEGER REFERENCES users(id) ON DELETE SET NULL, status TEXT NOT NULL DEFAULT 'scheduled',
  report TEXT, completed_at TEXT, created_by INTEGER, created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS site_issues (
  id INTEGER PRIMARY KEY, project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  visit_id INTEGER REFERENCES site_visits(id) ON DELETE SET NULL, title TEXT NOT NULL, description TEXT,
  severity TEXT NOT NULL DEFAULT 'medium', status TEXT NOT NULL DEFAULT 'open', task_id INTEGER REFERENCES tasks(id) ON DELETE SET NULL,
  created_by INTEGER, created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS reminders_sent (
  entity TEXT NOT NULL, entity_id INTEGER NOT NULL, rkey TEXT NOT NULL, sent_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY(entity, entity_id, rkey)
);
CREATE TABLE IF NOT EXISTS email_log (
  id INTEGER PRIMARY KEY, org_id INTEGER, to_email TEXT NOT NULL, subject TEXT NOT NULL, category TEXT,
  body_html TEXT, status TEXT NOT NULL, error TEXT, created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS ix_tasks_project ON tasks(project_id);
CREATE INDEX IF NOT EXISTS ix_tasks_assignee ON tasks(assignee_id);
CREATE INDEX IF NOT EXISTS ix_invoices_org ON invoices(org_id);
CREATE INDEX IF NOT EXISTS ix_projects_org ON projects(org_id);
CREATE INDEX IF NOT EXISTS ix_email_org ON email_log(org_id);
`;

const raw = new DatabaseSync(config.dbFile);
raw.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;');
raw.exec(SCHEMA);

const cache = new Map();
function stmt(sql) {
  let s = cache.get(sql);
  if (!s) { s = raw.prepare(sql); cache.set(sql, s); }
  return s;
}
function norm(params) {
  return params.map((v) => (v === undefined || v === '' ? null : typeof v === 'boolean' ? (v ? 1 : 0) : v));
}

let depth = 0;
const db = {
  raw,
  get: (sql, ...p) => stmt(sql).get(...norm(p)),
  all: (sql, ...p) => stmt(sql).all(...norm(p)),
  run: (sql, ...p) => {
    const r = stmt(sql).run(...norm(p));
    return { changes: Number(r.changes), id: Number(r.lastInsertRowid) };
  },
  insert(table, obj) {
    const keys = Object.keys(obj);
    const sql = `INSERT INTO ${table} (${keys.join(',')}) VALUES (${keys.map(() => '?').join(',')})`;
    return db.run(sql, ...keys.map((k) => obj[k])).id;
  },
  update(table, id, obj) {
    const keys = Object.keys(obj);
    if (!keys.length) return;
    db.run(`UPDATE ${table} SET ${keys.map((k) => `${k} = ?`).join(', ')} WHERE id = ?`, ...keys.map((k) => obj[k]), id);
  },
  tx(fn) {
    if (depth > 0) return fn();
    depth++;
    raw.exec('BEGIN');
    try { const r = fn(); raw.exec('COMMIT'); return r; } catch (e) { raw.exec('ROLLBACK'); throw e; } finally { depth--; }
  },
};

module.exports = db;
