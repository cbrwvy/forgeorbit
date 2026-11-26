-- FO-QC-RECOVERY01: one Owner-approved read-only review of an existing Developer run.
-- This is not a second workflow grant and it does not replace pm_orchestrated_workflows.

CREATE TABLE qc_recovery_grants (
  id            TEXT PRIMARY KEY,
  task_id       TEXT NOT NULL,
  project_path  TEXT NOT NULL,
  status        TEXT NOT NULL CHECK (status IN ('prepared', 'approved', 'consumed', 'expired', 'cancelled', 'invalidated')),
  review_id     TEXT,
  review_run_id TEXT,
  grant_json    TEXT NOT NULL,
  created_at    INTEGER NOT NULL,
  updated_at    INTEGER NOT NULL
);

CREATE INDEX idx_qc_recovery_grants_task ON qc_recovery_grants (task_id, created_at DESC);
CREATE INDEX idx_qc_recovery_grants_review ON qc_recovery_grants (review_id);
