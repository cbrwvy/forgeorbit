-- FO-AUTO01: Owner-approved bounded PM orchestration for one READY task at a time.

CREATE TABLE pm_orchestrated_workflows (
  id           TEXT PRIMARY KEY,
  task_id      TEXT NOT NULL UNIQUE,
  project_path TEXT NOT NULL,
  status       TEXT NOT NULL CHECK (status IN ('active', 'paused', 'awaiting_owner', 'cancelled', 'exhausted', 'expired')),
  phase        TEXT NOT NULL,
  grant_json   TEXT NOT NULL,
  data_json    TEXT NOT NULL,
  created_at   INTEGER NOT NULL,
  updated_at   INTEGER NOT NULL
);

CREATE INDEX idx_pm_orchestrated_workflows_project ON pm_orchestrated_workflows (project_path, updated_at DESC);
CREATE INDEX idx_pm_orchestrated_workflows_status ON pm_orchestrated_workflows (status, updated_at DESC);
