-- FO-AUTO02: Owner-approved bounded multi-task PM orchestration (sequential employee + QC).

CREATE TABLE pm_orchestrated_batches (
  id           TEXT PRIMARY KEY,
  project_path TEXT NOT NULL,
  status       TEXT NOT NULL CHECK (status IN ('draft', 'approved', 'running', 'paused', 'completed', 'cancelled', 'stopped')),
  data_json    TEXT NOT NULL,
  created_at   INTEGER NOT NULL,
  updated_at   INTEGER NOT NULL
);

CREATE INDEX idx_pm_orchestrated_batches_project ON pm_orchestrated_batches (project_path, updated_at DESC);
CREATE INDEX idx_pm_orchestrated_batches_status ON pm_orchestrated_batches (status, updated_at DESC);

CREATE TABLE pm_orchestrated_batch_events (
  id       INTEGER PRIMARY KEY AUTOINCREMENT,
  batch_id TEXT NOT NULL,
  at       INTEGER NOT NULL,
  kind     TEXT NOT NULL,
  task_id  TEXT,
  text     TEXT NOT NULL,
  FOREIGN KEY (batch_id) REFERENCES pm_orchestrated_batches(id) ON DELETE CASCADE
);

CREATE INDEX idx_pm_orchestrated_batch_events_batch ON pm_orchestrated_batch_events (batch_id, id DESC);
