-- FO-TASKB-WORKSPACE01: one task-owned staging record and its baseline.
-- Publication is a later Owner action. Preparing this row does not start a run.

CREATE TABLE task_workspaces (
  id            TEXT PRIMARY KEY,
  task_id       TEXT NOT NULL,
  run_id        TEXT,
  status        TEXT NOT NULL CHECK (status IN ('armed', 'executing', 'settled', 'published', 'publication-partial', 'abandoned')),
  manifest_json TEXT NOT NULL,
  created_at    INTEGER NOT NULL,
  updated_at    INTEGER NOT NULL
);

CREATE INDEX idx_task_workspaces_task ON task_workspaces (task_id, created_at DESC);
CREATE INDEX idx_task_workspaces_run ON task_workspaces (run_id);
