# ARCHFLOW

Practice & project management SaaS for architecture firms — built from the ARCHFLOW flowchart.
**Email is the only notification and reminder channel, everywhere in the app** (no in-app, SMS or WhatsApp).

Stack: Node.js 22, Express 5, EJS server-rendered UI, **Supabase** (PostgreSQL + Storage), Nodemailer, ExcelJS, PDFKit. No build step.

## Run

```bash
npm install
cp .env.example .env    # fill in DATABASE_URL / SUPABASE_* (and SMTP_* to deliver email)
npm run seed            # optional demo workspace: admin@archflow.demo / password123
npm start               # http://localhost:3000
npm test                # end-to-end test of the whole flow (uses an embedded Postgres, never your Supabase data)
```

## Supabase

| What | Where it lives |
|---|---|
| All app data (27 tables) | Supabase Postgres, schema **`archflow`** — see `db/schema.sql` |
| Uploaded drawings, documents, payment proofs | Supabase Storage, **private** bucket `archflow-files` |

- `DATABASE_URL` — Dashboard → **Connect** → *Session pooler* connection string (with your DB password). Use the session pooler (port 5432) or the direct connection; the app sets `search_path` per connection, which transaction-mode pooling (port 6543) does not keep.
- `SUPABASE_URL` + `SUPABASE_SERVICE_ROLE_KEY` — Dashboard → Project Settings → API Keys. Server-side only.
- The schema is created automatically on start-up (idempotent) and has also been applied as the migration `archflow_initial_schema`.
- Security: the `archflow` schema is not exposed through Supabase's Data API, and every table has Row Level Security enabled with no policies, so the public `anon`/`authenticated` keys cannot read anything. Only the server (connecting as the table owner) can. Files are served through 60-second signed URLs after ARCHFLOW's own permission checks.
- Without `DATABASE_URL`, an embedded Postgres (PGlite) in `DATA_DIR/pgdata` is used; without the Supabase keys, files are stored in `DATA_DIR/uploads`. Same code either way.
- `DEBUG_SQL=1` prints every query.

Without `SMTP_HOST`, emails are recorded in **Organisation → Email log** (and the console) instead of being delivered.
The reminder scheduler runs inside the server every `REMINDER_INTERVAL_MINUTES` (default 60); you can also run it from an
external cron with `npm run reminders`, or press **Run reminder check now** on the Email log page. It is idempotent — each
reminder is sent once, and missed runs catch up without spamming.

## Flow coverage

| Flowchart step | Where |
|---|---|
| Register → email verified? → resend verification | `/register`, `/verify-pending`, `/verify/:token` |
| Create organisation workspace (first user = Org Admin) | `/onboarding/workspace` |
| 15-day free trial → select plan (Solo / Studio / Professional / Enterprise) → subscription activated? → retry / choose another | `/onboarding/plan`, `/billing/checkout` |
| Organisation setup: profile & preferences, invite team, roles (Admin, PM, Lead Architect, Architect, Site Engineer, Accountant), versioned project templates | `/org/settings`, `/org/team`, `/org/templates` |
| Create project — Step 1 classification (Residential / Commercial / Mixed-use / Exterior + sub-types, plot & built-up area, unit); Step 2 details, team, dates, scope (Design-only / Design + Construction) → generate workflow | `/projects/new` |
| Project execution: overview, 10-phase tracker, phase workspace, subphases / tasks / deliverables, uploads, submit for internal review → approved? → mark phase complete → next phase | `/projects/:id`, `/phases`, `/phases/:phase` |
| Payments: dashboard (receivable, received, pending, overdue, collection rate), invoices (draft / issued / partial / paid / overdue / disputed), transactions (partial/full, method, reference, proof), automatic reminders | `/payments` |
| Task management: list / kanban / calendar, assign, dates, priority, dependencies, progress, due & overdue notifications | `/tasks`, `/projects/:id/tasks` |
| Documents & drawings: phase-based library (PDF, DWG, DXF, JPG, PNG, DOCX, XLSX…), new versions (never overwritten), history, link to task/deliverable, permission-checked download | `/projects/:id/documents` |
| Approvals & reviews: create request, assign reviewers, approved / revision required / rejected, revise & re-submit, re-appoint reviewers, deliverable status updates | `/approvals`, `/projects/:id/approvals` |
| Construction (Design + Construction only): budget, expenditure (labour / contractor / material…) with approval, budget vs actual; materials, suppliers, purchases, consumption, reorder alerts; site visits, inspection reports, issues, rectification tasks | `/projects/:id/construction` |
| Reports & analytics: project, organisation, financial (ageing, receipts), export Excel / PDF | `/reports` |
| Billing & subscription: usage, upgrade, add-ons (users / projects / storage), payment method, history, new limits applied | `/billing` |
| Closure checklist (tasks, deliverables, approvals, payments…) → close project → closure report & archive → completed | `/projects/:id/closure` |

## Email notifications & reminders

| Event | Recipients |
|---|---|
| Verification, password reset, invitation, role change | the user |
| Workspace created, plan activated, receipts, payment failed, trial ending (3 & 1 days), trial ended, renewal notice (3 days), plan limit reached | billing email + admins |
| Added to project, phase completed, project closed | project team (+ client on closure) |
| Task assigned / updated; due in ≤2 days, due today, overdue (then weekly) | assignee + project manager |
| Approval requested / re-submitted; each decision; final outcome; still pending after 3 and 7 days | reviewers / requester + PM |
| New document revision | PM + linked task's assignee |
| Invoice issued; reminders **3 days before, on due date, 3 / 7 / 15 days after**; payment received (stops reminders) | client + project team |
| Expenditure awaiting approval / decided; budget at 80% / 100%; material at reorder level; site visit scheduled & day-before reminder | approvers, PM, site engineers, inspector |

## Notes

- Subscription payments use a simulated gateway (`src/billing.js` → `provider.charge`): any card number works except ones ending in `0002`, which are declined. Swap in Stripe/Razorpay there.
- When the trial ends without a plan, or a renewal fails, the workspace becomes read-only until billing is fixed.
- Supabase Auth is not used: ARCHFLOW keeps its own users, email verification and invitations (all by email).
