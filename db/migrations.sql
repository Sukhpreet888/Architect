-- Idempotent schema upgrades, applied on every start-up after schema.sql (safe to re-run).
-- 2026-11: Cost management (quantity x rate entries, site-visit link, per-category budgets)
ALTER TABLE archflow.expenditures ADD COLUMN IF NOT EXISTS qty double precision;
ALTER TABLE archflow.expenditures ADD COLUMN IF NOT EXISTS unit TEXT;
ALTER TABLE archflow.expenditures ADD COLUMN IF NOT EXISTS rate double precision;
ALTER TABLE archflow.expenditures ADD COLUMN IF NOT EXISTS visit_id INTEGER REFERENCES archflow.site_visits(id) ON DELETE SET NULL;
CREATE INDEX IF NOT EXISTS ix_expenditures_project_date ON archflow.expenditures(project_id, spent_on);
CREATE TABLE IF NOT EXISTS archflow.cost_budgets (
  project_id INTEGER NOT NULL REFERENCES archflow.projects(id) ON DELETE CASCADE, category TEXT NOT NULL,
  amount double precision NOT NULL DEFAULT 0, PRIMARY KEY(project_id, category)
);
ALTER TABLE archflow.cost_budgets ENABLE ROW LEVEL SECURITY;
