-- FO-AUTO03-RECOVERY-FIX01: Owner-approved supplemental Reviewer launch after provider quota failure.

CREATE TABLE pm_provider_recoveries (
  id            TEXT PRIMARY KEY,
  batch_id      TEXT NOT NULL,
  task_id       TEXT NOT NULL,
  project_path  TEXT NOT NULL,
  status        TEXT NOT NULL CHECK (status IN ('approved', 'applied', 'consumed', 'expired', 'cancelled')),
  recovery_json TEXT NOT NULL,
  created_at    INTEGER NOT NULL,
  updated_at    INTEGER NOT NULL
);

CREATE INDEX idx_pm_provider_recoveries_batch_task
  ON pm_provider_recoveries (batch_id, task_id, created_at DESC);

CREATE INDEX idx_pm_provider_recoveries_task
  ON pm_provider_recoveries (task_id, created_at DESC);
