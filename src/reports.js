'use strict';
/** Report builders produce a neutral structure that is rendered as HTML, Excel (.xlsx) or PDF. */
const ExcelJS = require('exceljs');
const PDFDocument = require('pdfkit');
const db = require('./db');
const S = require('./services');
const { ROLES, TASK_STATUSES, INVOICE_STATUSES, EXPENSE_CATEGORIES, PROJECT_TYPES, SCOPES } = require('./config');
const { today, daysBetween, fmtDate, fmtMoney, mapSeq } = require('./util');

async function projectReport(org, project) {
  const prog = await S.phaseProgress(project.id);
  const money = (n) => fmtMoney(n, org.currency);
  const tasks = await db.all(`SELECT t.*, u.name assignee, ph.name phase FROM tasks t LEFT JOIN users u ON u.id = t.assignee_id LEFT JOIN phases ph ON ph.id = t.phase_id WHERE t.project_id = ? ORDER BY ph.seq, t.id`, project.id);
  const approvals = await db.all("SELECT a.*, u.name requester FROM approvals a LEFT JOIN users u ON u.id = a.requested_by WHERE project_id = ? AND status != 'draft' ORDER BY id", project.id);
  const pay = await S.paymentsSummary(org.id, project.id);
  const invoices = await db.all('SELECT * FROM invoices WHERE project_id = ? ORDER BY due_date', project.id);
  const sections = [
    { heading: 'Summary', kpis: [
      ['Code', project.code], ['Client', project.client_name || '—'], ['Type', `${PROJECT_TYPES[project.type]?.name || project.type} — ${project.subtype || ''}`],
      ['Scope', SCOPES[project.scope]], ['Status', project.status], ['Progress', `${prog.pct}% (${prog.done}/${prog.applicable} phases)`],
      ['Tasks done', `${prog.tasksDone}/${prog.tasksTotal}`], ['Start', fmtDate(project.start_date)], ['Target end', fmtDate(project.end_date)],
    ] },
    { heading: 'Phases', table: { columns: ['#', 'Phase', 'Status', 'Planned start', 'Planned end', 'Completed'],
      rows: prog.phases.map((p) => [p.seq, p.name, p.status.replace('_', ' '), fmtDate(p.planned_start), fmtDate(p.planned_end), fmtDate(p.completed_at)]) } },
    { heading: 'Tasks', table: { columns: ['Task', 'Phase', 'Assignee', 'Priority', 'Due', 'Status', 'Progress'],
      rows: tasks.map((t) => [t.title, t.phase || '—', t.assignee || '—', t.priority, fmtDate(t.due_date), TASK_STATUSES[t.status], `${t.progress}%`]) } },
    { heading: 'Approvals', table: { columns: ['Request', 'Type', 'Round', 'Requested by', 'Status'],
      rows: approvals.map((a) => [a.title, a.type, a.round, a.requester || '—', a.status.replace('_', ' ')]) } },
    { heading: 'Invoices & payments', kpis: [['Receivable', money(pay.receivable)], ['Received', money(pay.received)], ['Outstanding', money(pay.pending + pay.overdue)], ['Collection rate', `${pay.collectionRate}%`]],
      table: { columns: ['Invoice', 'Milestone', 'Due', 'Total', 'Paid', 'Balance', 'Status'],
        rows: await mapSeq(invoices, async (i) => { const t = await S.invoiceTotals(i); return [i.number, i.milestone, fmtDate(i.due_date), money(t.total), money(t.paid), money(t.balance), INVOICE_STATUSES[i.status]]; }) } },
  ];
  if (project.scope === 'design_construction') {
    const exp = await db.all("SELECT category, SUM(amount) s FROM expenditures WHERE project_id = ? AND status = 'approved' GROUP BY category", project.id);
    const spent = exp.reduce((a, e) => a + e.s, 0);
    sections.push({ heading: 'Construction cost — budget vs actual',
      kpis: [['Budget', money(project.construction_budget)], ['Approved spend', money(spent)], ['Variance', money(project.construction_budget - spent)]],
      table: { columns: ['Category', 'Approved spend'], rows: exp.map((e) => [EXPENSE_CATEGORIES[e.category] || e.category, money(e.s)]) } });
  }
  return { title: `Project report — ${project.name}`, subtitle: `${org.name} · generated ${fmtDate(today())}`, sections };
}

async function orgReport(org) {
  const money = (n) => fmtMoney(n, org.currency);
  const projects = await db.all('SELECT * FROM projects WHERE org_id = ? ORDER BY status, created_at DESC', org.id);
  const team = await db.all(`SELECT u.name, m.role,
      (SELECT COUNT(*) FROM tasks t JOIN projects p ON p.id = t.project_id WHERE t.assignee_id = u.id AND p.org_id = m.org_id AND t.status != 'done') open_tasks,
      (SELECT COUNT(*) FROM tasks t JOIN projects p ON p.id = t.project_id WHERE t.assignee_id = u.id AND p.org_id = m.org_id AND t.status != 'done' AND t.due_date < ?) overdue,
      (SELECT COUNT(*) FROM tasks t JOIN projects p ON p.id = t.project_id WHERE t.assignee_id = u.id AND p.org_id = m.org_id AND t.status = 'done') done
    FROM memberships m JOIN users u ON u.id = m.user_id WHERE m.org_id = ? AND m.active = 1 ORDER BY u.name`, today(), org.id);
  const exp = await db.all(`SELECT p.code, p.name, p.construction_budget, COALESCE(SUM(CASE WHEN e.status = 'approved' THEN e.amount END),0) spent
    FROM projects p LEFT JOIN expenditures e ON e.project_id = p.id WHERE p.org_id = ? AND p.scope = 'design_construction' GROUP BY p.id`, org.id);
  const active = projects.filter((p) => p.status === 'active').length;
  return {
    title: `Organisation report — ${org.name}`, subtitle: `Generated ${fmtDate(today())}`,
    sections: [
      { heading: 'Portfolio', kpis: [['Projects', projects.length], ['Active', active], ['Completed', projects.length - active], ['Team members', team.length]],
        table: { columns: ['Code', 'Project', 'Type', 'Scope', 'Status', 'Progress', 'Target end'],
          rows: await mapSeq(projects, async (p) => [p.code, p.name, PROJECT_TYPES[p.type]?.name || p.type, SCOPES[p.scope], p.status, `${(await S.phaseProgress(p.id)).pct}%`, fmtDate(p.end_date)]) } },
      { heading: 'Team workload', table: { columns: ['Member', 'Role', 'Open tasks', 'Overdue', 'Completed'], rows: team.map((t) => [t.name, ROLES[t.role], t.open_tasks, t.overdue, t.done]) } },
      { heading: 'Construction expenditure', table: { columns: ['Code', 'Project', 'Budget', 'Approved spend', 'Utilisation'],
        rows: exp.map((e) => [e.code, e.name, money(e.construction_budget), money(e.spent), e.construction_budget ? `${Math.round((e.spent / e.construction_budget) * 100)}%` : '—']) } },
    ],
  };
}

async function financialReport(org) {
  const money = (n) => fmtMoney(n, org.currency);
  const sum = await S.paymentsSummary(org.id);
  const t = today();
  const invRows = await db.all("SELECT i.*, p.name project, p.client_name FROM invoices i JOIN projects p ON p.id = i.project_id WHERE i.org_id = ? AND i.status != 'draft' ORDER BY i.due_date", org.id);
  const invoices = await mapSeq(invRows, async (i) => ({ ...i, ...await S.invoiceTotals(i) }));
  const buckets = { 'Not due': 0, '1–30 days': 0, '31–60 days': 0, '61–90 days': 0, '90+ days': 0 };
  for (const i of invoices) {
    if (i.balance <= 0) continue;
    const late = daysBetween(i.due_date, t);
    const k = late <= 0 ? 'Not due' : late <= 30 ? '1–30 days' : late <= 60 ? '31–60 days' : late <= 90 ? '61–90 days' : '90+ days';
    buckets[k] += i.balance;
  }
  const receipts = await db.all(`SELECT pay.*, i.number, p.name project FROM payments pay JOIN invoices i ON i.id = pay.invoice_id JOIN projects p ON p.id = i.project_id
    WHERE i.org_id = ? ORDER BY pay.paid_on DESC`, org.id);
  return {
    title: `Financial report — ${org.name}`, subtitle: `Generated ${fmtDate(t)}`,
    sections: [
      { heading: 'Collections', kpis: [['Total receivable', money(sum.receivable)], ['Received', money(sum.received)], ['Pending', money(sum.pending)], ['Overdue', money(sum.overdue)], ['Collection rate', `${sum.collectionRate}%`]] },
      { heading: 'Receivables ageing', table: { columns: ['Bucket', 'Outstanding'], rows: Object.entries(buckets).map(([k, v]) => [k, money(v)]) } },
      { heading: 'Invoices', table: { columns: ['Invoice', 'Project', 'Client', 'Milestone', 'Due', 'Total', 'Paid', 'Balance', 'Status'],
        rows: invoices.map((i) => [i.number, i.project, i.client_name || '—', i.milestone, fmtDate(i.due_date), money(i.total), money(i.paid), money(i.balance), INVOICE_STATUSES[i.status]]) } },
      { heading: 'Receipts', table: { columns: ['Date', 'Invoice', 'Project', 'Method', 'Reference', 'Amount'],
        rows: receipts.map((r) => [fmtDate(r.paid_on), r.number, r.project, r.method, r.reference || '—', money(r.amount)]) } },
    ],
  };
}

async function toXlsx(report) {
  const wb = new ExcelJS.Workbook();
  wb.creator = 'ARCHFLOW';
  const used = new Set();
  for (const s of report.sections) {
    let name = s.heading.replace(/[\\/?*[\]:]/g, '').slice(0, 28) || 'Sheet';
    while (used.has(name)) name = `${name.slice(0, 26)}_${used.size}`;
    used.add(name);
    const ws = wb.addWorksheet(name);
    ws.addRow([report.title]).font = { bold: true, size: 14 };
    ws.addRow([report.subtitle]);
    ws.addRow([]);
    if (s.kpis) { s.kpis.forEach(([k, v]) => { const r = ws.addRow([k, v]); r.getCell(1).font = { bold: true }; }); ws.addRow([]); }
    if (s.table) {
      const h = ws.addRow(s.table.columns);
      h.font = { bold: true, color: { argb: 'FFFFFFFF' } };
      h.eachCell((c) => { c.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF0B1A33' } }; });
      s.table.rows.forEach((r) => ws.addRow(r));
    }
    ws.columns.forEach((c, i) => { c.width = i === 0 ? 28 : 18; });
  }
  return wb.xlsx.writeBuffer();
}

function toPdf(report) {
  return new Promise((resolve) => {
    const doc = new PDFDocument({ size: 'A4', layout: 'landscape', margin: 36 });
    const chunks = [];
    doc.on('data', (c) => chunks.push(c));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    const W = doc.page.width - 72;
    doc.rect(0, 0, doc.page.width, 50).fill('#0b1a33');
    doc.fill('#ffffff').fontSize(16).font('Helvetica-Bold').text('ARCHFLOW', 36, 17);
    doc.fill('#13233a').moveDown(2).fontSize(16).text(report.title, 36, 66).fontSize(9).font('Helvetica').fill('#5b6b82').text(report.subtitle);
    const ensure = (h) => { if (doc.y + h > doc.page.height - 40) doc.addPage(); };
    for (const s of report.sections) {
      ensure(60);
      doc.moveDown(1).fill('#1d6fd8').font('Helvetica-Bold').fontSize(12).text(s.heading, 36);
      doc.fill('#13233a').font('Helvetica').fontSize(9);
      if (s.kpis) doc.moveDown(0.3).text(s.kpis.map(([k, v]) => `${k}: ${v}`).join('   ·   '), { width: W });
      if (s.table) {
        const cols = s.table.columns.length; const cw = W / cols;
        const row = (cells, bold) => {
          const h = Math.max(...cells.map((c) => doc.heightOfString(String(c ?? ''), { width: cw - 6 }))) + 6;
          ensure(h);
          const y = doc.y;
          if (bold) doc.rect(36, y, W, h).fill('#e8eef8').fill('#13233a');
          doc.font(bold ? 'Helvetica-Bold' : 'Helvetica');
          cells.forEach((c, i) => doc.text(String(c ?? ''), 36 + i * cw + 3, y + 3, { width: cw - 6 }));
          doc.y = y + h; doc.x = 36;
          doc.moveTo(36, doc.y).lineTo(36 + W, doc.y).strokeColor('#dde4ee').stroke();
        };
        doc.moveDown(0.4);
        row(s.table.columns, true);
        if (!s.table.rows.length) doc.font('Helvetica-Oblique').text('No records.', 39, doc.y + 3);
        s.table.rows.forEach((r) => row(r, false));
      }
    }
    doc.end();
  });
}

module.exports = { projectReport, orgReport, financialReport, toXlsx, toPdf };
