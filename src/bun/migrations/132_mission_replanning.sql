CREATE TABLE mission_resource_proposals (
  id TEXT PRIMARY KEY,
  mission_id TEXT NOT NULL REFERENCES orchestration_missions(id),
  revision INTEGER NOT NULL,
  digest TEXT NOT NULL,
  snapshot TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('pending','approved','rejected')),
  created_at INTEGER NOT NULL,
  settled_at INTEGER,
  head_message_id TEXT
);

CREATE INDEX mission_resource_proposals_mission ON mission_resource_proposals(mission_id, created_at DESC);

CREATE TABLE mission_plan_revisions (
  mission_id TEXT NOT NULL REFERENCES orchestration_missions(id),
  revision INTEGER NOT NULL,
  snapshot TEXT NOT NULL,
  PRIMARY KEY (mission_id, revision)
);

CREATE TABLE mission_wait_transitions (
  id INTEGER PRIMARY KEY,
  mission_id TEXT NOT NULL,
  task_id TEXT NOT NULL,
  category TEXT,
  at INTEGER NOT NULL
);

CREATE INDEX mission_wait_transitions_task ON mission_wait_transitions(task_id, at, id);
