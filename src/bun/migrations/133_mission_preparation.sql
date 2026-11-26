CREATE TABLE mission_preparation_events (
  id INTEGER PRIMARY KEY,
  mission_id TEXT NOT NULL,
  task_id TEXT NOT NULL,
  revision INTEGER NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('developer', 'reviewer')),
  status TEXT NOT NULL CHECK (status IN ('started', 'completed', 'failed', 'interrupted')),
  at INTEGER NOT NULL,
  detail TEXT
);

CREATE INDEX mission_preparation_events_task ON mission_preparation_events(task_id, at, id);
