'use strict';
const path = require('path');
const fs = require('fs');

const envFile = path.join(__dirname, '..', '.env');
if (fs.existsSync(envFile) && typeof process.loadEnvFile === 'function') process.loadEnvFile(envFile);

const DATA_DIR = path.resolve(process.env.DATA_DIR || path.join(__dirname, '..', 'data'));

const config = {
  port: Number(process.env.PORT || 3000),
  appUrl: (process.env.APP_URL || `http://localhost:${process.env.PORT || 3000}`).replace(/\/$/, ''),
  sessionSecret: process.env.SESSION_SECRET || 'archflow-dev-secret-change-me',
  dataDir: DATA_DIR,
  dbFile: process.env.DB_FILE || path.join(DATA_DIR, 'archflow.db'),
  uploadDir: path.join(DATA_DIR, 'uploads'),
  trialDays: 15,
  reminderIntervalMinutes: Number(process.env.REMINDER_INTERVAL_MINUTES || 60),
  mail: {
    host: process.env.SMTP_HOST || '',
    port: Number(process.env.SMTP_PORT || 587),
    secure: String(process.env.SMTP_SECURE || 'false') === 'true',
    user: process.env.SMTP_USER || '',
    pass: process.env.SMTP_PASS || '',
    from: process.env.MAIL_FROM || 'ARCHFLOW <no-reply@archflow.app>',
    sales: process.env.SALES_EMAIL || 'sales@archflow.app',
  },
};

// ---------------------------------------------------------------- Plans
const PLANS = {
  solo: { key: 'solo', name: 'Solo', users: 1, projects: 3, storageMb: 2048, price: 19, blurb: '1 user, 3 projects' },
  studio: { key: 'studio', name: 'Studio', users: 5, projects: 10, storageMb: 10240, price: 79, blurb: '5 users, 10 projects' },
  professional: { key: 'professional', name: 'Professional', users: 15, projects: 30, storageMb: 51200, price: 199, blurb: '15 users, 30 projects' },
  enterprise: { key: 'enterprise', name: 'Enterprise', users: null, projects: null, storageMb: null, price: null, blurb: 'Custom users & projects' },
};
// Limits that apply while on trial before a plan is chosen
const TRIAL_LIMITS = { users: 5, projects: 10, storageMb: 10240 };

const ADDONS = {
  users: { key: 'users', name: 'Extra users', unit: 1, label: '+1 user', price: 15 },
  projects: { key: 'projects', name: 'Extra projects', unit: 5, label: '+5 projects', price: 25 },
  storage: { key: 'storage', name: 'Extra storage', unit: 10240, label: '+10 GB storage', price: 10 },
};

// ---------------------------------------------------------------- Roles & permissions
const ROLES = {
  admin: 'Admin',
  pm: 'Project Manager',
  lead_architect: 'Lead Architect',
  architect: 'Architect',
  site_engineer: 'Site Engineer',
  accountant: 'Accountant',
};

const PERMS = {
  org_manage: ['admin'],
  billing: ['admin'],
  project_create: ['admin', 'pm', 'lead_architect'],
  project_manage: ['admin', 'pm', 'lead_architect'],
  project_close: ['admin', 'pm'],
  see_all_projects: ['admin', 'pm', 'accountant'],
  phase_submit: ['admin', 'pm', 'lead_architect', 'architect'],
  task_manage: ['admin', 'pm', 'lead_architect', 'architect', 'site_engineer'],
  doc_upload: ['admin', 'pm', 'lead_architect', 'architect', 'site_engineer'],
  doc_restricted: ['admin', 'pm', 'lead_architect'],
  approval_create: ['admin', 'pm', 'lead_architect', 'architect', 'site_engineer'],
  invoice_manage: ['admin', 'pm', 'accountant'],
  payments_view: ['admin', 'pm', 'accountant'],
  construction_manage: ['admin', 'pm', 'site_engineer', 'lead_architect'],
  expenditure_approve: ['admin', 'pm', 'accountant'],
  reports_view: ['admin', 'pm', 'lead_architect', 'accountant'],
  financial_reports: ['admin', 'pm', 'accountant'],
};

// ---------------------------------------------------------------- Project classification
const PROJECT_TYPES = {
  residential: { name: 'Residential', subtypes: ['Villa', '2 BHK Apartment', '3 BHK Apartment'] },
  commercial: { name: 'Commercial', subtypes: ['Retail', 'Hospital', 'Restaurant'] },
  mixed_use: { name: 'Mixed-use', subtypes: ['Residential + Commercial', 'Urban Planning'] },
  exterior: { name: 'Exterior', subtypes: ['Facade', 'Landscape', 'Exterior Renovation'] },
};
const AREA_UNITS = { sqft: 'sq ft', sqm: 'sq m', sqyd: 'sq yd', acre: 'acre' };
const SCOPES = { design: 'Design only', design_construction: 'Design + Construction' };

const PRIORITIES = { low: 'Low', medium: 'Medium', high: 'High', urgent: 'Urgent' };
const TASK_STATUSES = { todo: 'To do', in_progress: 'In progress', review: 'In review', done: 'Done' };
const INVOICE_STATUSES = { draft: 'Draft', issued: 'Issued', partial: 'Partial', paid: 'Paid', overdue: 'Overdue', disputed: 'Disputed' };
const PAYMENT_METHODS = { bank_transfer: 'Bank transfer', upi: 'UPI', cheque: 'Cheque', cash: 'Cash', card: 'Card', other: 'Other' };
const EXPENSE_CATEGORIES = { labour: 'Labour', contractor: 'Contractor', material: 'Material', equipment: 'Equipment', other: 'Other' };
const APPROVAL_TYPES = { design: 'Design', drawing: 'Drawings', material: 'Material', phase: 'Phase review', other: 'Other' };
const DECISIONS = { approved: 'Approved', revision_required: 'Revision required', rejected: 'Rejected' };

// Invoice reminder schedule (email only). offset = days relative to due date.
const INVOICE_REMINDERS = [
  { key: 'before_3', offset: -3, label: '3 days before due' },
  { key: 'due_0', offset: 0, label: 'On due date' },
  { key: 'after_3', offset: 3, label: '3 days after' },
  { key: 'after_7', offset: 7, label: '7 days after' },
  { key: 'after_15', offset: 15, label: '15 days after' },
];

// Default 10-phase architectural workflow template, in the template DSL.
// "[construction]" marks phases only applicable to Design + Construction scope.
const DEFAULT_TEMPLATE = `Phase: Pre-design & Client Brief
  Subphase: Brief
    Task: Kick-off meeting with client
    Task: Prepare design brief & area programme
    Deliverable: Signed design brief
  Approval: Client sign-off on brief
Phase: Site Analysis & Feasibility
  Subphase: Site study
    Task: Site visit & measurement survey
    Task: Bye-law & zoning analysis
    Deliverable: Site analysis report
Phase: Concept Design
  Subphase: Concept
    Task: Prepare concept options
    Task: Mood boards & references
    Deliverable: Concept presentation
  Approval: Client concept approval
Phase: Schematic Design
  Subphase: Schematics
    Task: Floor plans, sections & elevations
    Task: Preliminary 3D views
    Deliverable: Schematic drawing set
Phase: Design Development
  Subphase: Development
    Task: Structural & MEP coordination
    Task: Material & finish selection
    Deliverable: Design development set
  Approval: Material selection approval
Phase: Statutory Approvals & Permits
  Subphase: Submissions
    Task: Prepare authority submission drawings
    Task: Follow up on permits
    Deliverable: Approved sanction drawings
Phase: Construction Documentation
  Subphase: Working drawings
    Task: Working drawings
    Task: BOQ & specifications
    Deliverable: Good-for-construction (GFC) drawing set
  Approval: GFC drawings approval
Phase: Tendering & Contractor Selection [construction]
  Subphase: Tender
    Task: Prepare tender documents
    Task: Bid evaluation
    Deliverable: Contractor recommendation report
Phase: Construction Administration [construction]
  Subphase: Site
    Task: Periodic site supervision
    Task: Certify contractor bills
    Deliverable: Site inspection reports
Phase: Handover & Closeout
  Subphase: Handover
    Task: Snag list & rectification
    Task: As-built drawings
    Deliverable: Handover documentation
  Approval: Client handover acceptance
`;

module.exports = {
  config, PLANS, TRIAL_LIMITS, ADDONS, ROLES, PERMS, PROJECT_TYPES, AREA_UNITS, SCOPES, PRIORITIES,
  TASK_STATUSES, INVOICE_STATUSES, PAYMENT_METHODS, EXPENSE_CATEGORIES, APPROVAL_TYPES, DECISIONS,
  INVOICE_REMINDERS, DEFAULT_TEMPLATE,
};
