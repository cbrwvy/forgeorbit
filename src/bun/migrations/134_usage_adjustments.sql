-- Owner accounting adjustments are immutable rows. A later row may name an
-- earlier row in supersedes; the earlier row is never updated or deleted by
-- the application. Historical API charges stay on the run that recorded them.
CREATE TABLE usage_cost_adjustments (
  id INTEGER PRIMARY KEY,
  task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  run_id TEXT REFERENCES runs(id) ON DELETE SET NULL,
  amount REAL NOT NULL CHECK (amount >= 0 AND amount <= 1000000000),
  currency TEXT NOT NULL CHECK (length(currency) = 3),
  note TEXT NOT NULL CHECK (length(note) BETWEEN 1 AND 400),
  created_at INTEGER NOT NULL,
  supersedes INTEGER REFERENCES usage_cost_adjustments(id)
);
CREATE INDEX usage_cost_adjustments_task ON usage_cost_adjustments(task_id, id);
CREATE INDEX usage_transitions_destination_at ON usage_task_transitions(destination, at);
CREATE INDEX runs_started_task ON runs(started_at, task_id);
