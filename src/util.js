'use strict';
const crypto = require('crypto');

// ---------------------------------------------------------------- passwords & tokens
function hashPassword(pw) {
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto.scryptSync(String(pw), salt, 64).toString('hex');
  return `${salt}:${hash}`;
}
function checkPassword(pw, stored) {
  if (!stored || !stored.includes(':')) return false;
  const [salt, hash] = stored.split(':');
  const test = crypto.scryptSync(String(pw), salt, 64);
  const known = Buffer.from(hash, 'hex');
  return known.length === test.length && crypto.timingSafeEqual(known, test);
}
const token = (n = 24) => crypto.randomBytes(n).toString('hex');

// ---------------------------------------------------------------- dates (YYYY-MM-DD strings)
let clockOverride = null; // used by tests / reminder simulation
function today() {
  const d = clockOverride ? new Date(clockOverride) : new Date();
  return d.toISOString().slice(0, 10);
}
function setToday(iso) { clockOverride = iso ? `${iso}T12:00:00Z` : null; }
function addDays(iso, n) {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}
function daysBetween(a, b) { // b - a in days
  return Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / 86400000);
}
function fmtDate(iso) {
  if (!iso) return '—';
  const d = new Date(iso.length === 10 ? `${iso}T00:00:00Z` : iso.replace(' ', 'T') + (iso.includes('Z') ? '' : 'Z'));
  if (isNaN(d)) return iso;
  return d.toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric', timeZone: 'UTC' });
}
function fmtMoney(n, currency = 'INR') {
  const v = Number(n || 0);
  try {
    return new Intl.NumberFormat(currency === 'INR' ? 'en-IN' : 'en-US', { style: 'currency', currency, maximumFractionDigits: 2 }).format(v);
  } catch { return `${currency} ${v.toFixed(2)}`; }
}
function fmtBytes(b) {
  const n = Number(b || 0);
  if (n < 1024) return `${n} B`;
  if (n < 1048576) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1073741824) return `${(n / 1048576).toFixed(1)} MB`;
  return `${(n / 1073741824).toFixed(2)} GB`;
}
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const isEmail = (s) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(s || '').trim());
const num = (v, d = 0) => { const n = parseFloat(v); return Number.isFinite(n) ? n : d; };
const int = (v) => { const n = parseInt(v, 10); return Number.isFinite(n) ? n : null; };
const arr = (v) => (v === undefined || v === null || v === '' ? [] : Array.isArray(v) ? v : [v]);
const isDate = (s) => /^\d{4}-\d{2}-\d{2}$/.test(String(s || ''));

// ---------------------------------------------------------------- workflow template DSL
// Phase: <name> [construction]
//   Subphase: <name>
//     Task: <title>
//     Deliverable: <name>
//   Approval: <title>
function parseTemplate(body) {
  const phases = [];
  const errors = [];
  let phase = null; let sub = null;
  String(body || '').split(/\r?\n/).forEach((line, i) => {
    const t = line.trim();
    if (!t || t.startsWith('#')) return;
    const m = t.match(/^(phase|subphase|task|deliverable|approval)\s*:\s*(.+)$/i);
    if (!m) { errors.push(`Line ${i + 1}: expected "Phase:", "Subphase:", "Task:", "Deliverable:" or "Approval:"`); return; }
    const kind = m[1].toLowerCase(); let name = m[2].trim();
    if (kind === 'phase') {
      const construction = /\[construction\]/i.test(name);
      name = name.replace(/\[construction\]/i, '').trim();
      phase = { name, construction, subphases: [], approvals: [] }; sub = null; phases.push(phase); return;
    }
    if (!phase) { errors.push(`Line ${i + 1}: "${m[1]}" must come after a Phase`); return; }
    if (kind === 'subphase') { sub = { name, tasks: [], deliverables: [] }; phase.subphases.push(sub); return; }
    if (kind === 'approval') { phase.approvals.push(name); return; }
    if (!sub) { sub = { name: 'General', tasks: [], deliverables: [] }; phase.subphases.push(sub); }
    if (kind === 'task') sub.tasks.push(name); else sub.deliverables.push(name);
  });
  if (!phases.length) errors.push('Template needs at least one Phase.');
  return { phases, errors };
}

module.exports = {
  hashPassword, checkPassword, token, today, setToday, addDays, daysBetween, fmtDate, fmtMoney, fmtBytes,
  esc, isEmail, num, int, arr, isDate, parseTemplate,
};
