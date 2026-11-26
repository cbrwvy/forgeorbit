-- FO-015A.1 Company Activity Journal.
--
-- Append-only audit journal for the virtual AI company ForgeOrbit.
-- Records real confirmed business events across organization, project management,
-- execution lifecycle, and multi-turn interaction.
--
-- Soft references: task_id, run_id, employee_id, project_path, execution_id, turn_id.
-- Deleting a task or archiving an employee must never rewrite or cascade into this history.

CREATE TABLE IF NOT EXISTS activity_events (
  sequence_id INTEGER PRIMARY KEY AUTOINCREMENT,
  id TEXT NOT NULL UNIQUE CHECK (length(trim(id)) > 0),
  event_type TEXT NOT NULL CHECK (length(trim(event_type)) > 0),
  schema_version INTEGER NOT NULL DEFAULT 1 CHECK (schema_version >= 1),
  project_path TEXT,
  actor_type TEXT NOT NULL CHECK (actor_type IN ('owner', 'project-manager', 'employee', 'system')),
  actor_id TEXT,
  target_type TEXT NOT NULL CHECK (target_type IN ('company', 'project', 'employee', 'task', 'proposal', 'execution', 'turn')),
  target_id TEXT NOT NULL CHECK (length(trim(target_id)) > 0),
  task_id TEXT,
  run_id TEXT,
  execution_id TEXT,
  turn_id TEXT,
  employee_id TEXT,
  idempotency_key TEXT NOT NULL UNIQUE CHECK (length(trim(idempotency_key)) > 0),
  source_event_id TEXT,
  payload_json TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(payload_json) AND json_type(payload_json) = 'object'),
  created_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS activity_events_project ON activity_events(project_path, sequence_id);
CREATE INDEX IF NOT EXISTS activity_events_actor ON activity_events(actor_type, actor_id, sequence_id);
CREATE INDEX IF NOT EXISTS activity_events_employee ON activity_events(employee_id, sequence_id);
CREATE INDEX IF NOT EXISTS activity_events_task ON activity_events(task_id, sequence_id);
CREATE INDEX IF NOT EXISTS activity_events_type ON activity_events(event_type, sequence_id);
CREATE INDEX IF NOT EXISTS activity_events_created ON activity_events(created_at, sequence_id);
