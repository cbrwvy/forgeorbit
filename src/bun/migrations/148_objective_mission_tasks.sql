CREATE TABLE objective_mission_tasks (
  task_id TEXT PRIMARY KEY,
  mission_id TEXT NOT NULL REFERENCES orchestration_missions(id) ON DELETE CASCADE,
  operation_id TEXT
);
