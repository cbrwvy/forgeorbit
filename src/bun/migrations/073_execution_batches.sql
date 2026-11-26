-- Approved execution batches (FO-005C.1). One row per batch: the tasks the
-- owner approved, the frozen configuration and policy, every launch the
-- batch made and why a start was held. `data` is the JSON ExecutionBatch.
-- Run progress is not copied here; it is read from tasks/runs each time.
CREATE TABLE project_execution_batches (
  id           TEXT PRIMARY KEY,
  project_path TEXT NOT NULL,
  status       TEXT NOT NULL,
  data         TEXT NOT NULL,
  created_at   INTEGER NOT NULL,
  updated_at   INTEGER NOT NULL
);
CREATE INDEX project_execution_batches_project ON project_execution_batches(project_path, created_at);
CREATE INDEX project_execution_batches_status ON project_execution_batches(status);

-- Append-only history of meaningful transitions (approved, started,
-- paused, task started/held/failed, recovered after a restart, …).
CREATE TABLE project_execution_batch_events (
  id       INTEGER PRIMARY KEY AUTOINCREMENT,
  batch_id TEXT NOT NULL REFERENCES project_execution_batches(id) ON DELETE CASCADE,
  at       INTEGER NOT NULL,
  kind     TEXT NOT NULL,
  task_id  TEXT,
  text     TEXT NOT NULL
);
CREATE INDEX project_execution_batch_events_batch ON project_execution_batch_events(batch_id, id);
