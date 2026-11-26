-- Hands-off project execution ("Work independently").
-- One Owner-activated policy per project, one driven run per submitted task, and an append-only history.
-- A run is pinned to the policy revision it was submitted under. At most one unfinished run exists per task
-- (the unique partial index is the double-submit guard). No row grants anything by itself: the core reads the
-- live policy again on every step.
CREATE TABLE project_handsoff_policies (
  project_path TEXT PRIMARY KEY,
  policy_json TEXT NOT NULL,
  revision INTEGER NOT NULL,
  activated_at INTEGER,
  updated_at INTEGER NOT NULL
);

CREATE TABLE handsoff_runs (
  id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL,
  project_path TEXT NOT NULL,
  policy_revision INTEGER NOT NULL,
  policy_json TEXT NOT NULL,
  stage TEXT NOT NULL,
  status TEXT NOT NULL,
  round INTEGER NOT NULL DEFAULT 0,
  state_json TEXT NOT NULL,
  blocker_json TEXT,
  result_json TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  finished_at INTEGER
);
CREATE UNIQUE INDEX handsoff_runs_one_open_per_task ON handsoff_runs(task_id) WHERE finished_at IS NULL;
CREATE INDEX handsoff_runs_project ON handsoff_runs(project_path, finished_at);
CREATE INDEX handsoff_runs_task ON handsoff_runs(task_id, created_at);

CREATE TABLE handsoff_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  run_id TEXT NOT NULL,
  task_id TEXT NOT NULL,
  ts INTEGER NOT NULL,
  kind TEXT NOT NULL,
  stage TEXT NOT NULL,
  message TEXT NOT NULL,
  detail_json TEXT NOT NULL
);
CREATE INDEX handsoff_events_run ON handsoff_events(run_id, id);
CREATE INDEX handsoff_events_task ON handsoff_events(task_id, id);
