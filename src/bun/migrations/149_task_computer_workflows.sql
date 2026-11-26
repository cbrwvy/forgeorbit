CREATE TABLE task_computer_workflows (
  task_id TEXT PRIMARY KEY REFERENCES tasks(id) ON DELETE CASCADE,
  revision TEXT NOT NULL,
  project_path TEXT NOT NULL,
  scope_json TEXT NOT NULL,
  used INTEGER NOT NULL DEFAULT 0 CHECK (used IN (0, 1))
);
CREATE TABLE task_computer_runs (
  run_id TEXT PRIMARY KEY REFERENCES runs(id) ON DELETE CASCADE,
  task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  revision TEXT NOT NULL,
  outcome TEXT NOT NULL,
  steps_json TEXT NOT NULL DEFAULT '[]',
  screenshot BLOB,
  UNIQUE (task_id, revision)
);
CREATE INDEX idx_task_computer_runs_task ON task_computer_runs(task_id);
