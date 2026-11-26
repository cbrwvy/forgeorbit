-- FO-010A AI employee identity and organization core.
--
-- An employee is a persistent organizational identity: a stable UUID, a name,
-- a job title and a project. It is NOT an agent profile, a harness, an
-- account, a model, or a runtime session, so this table deliberately has no
-- column for any of them. A future task picks an employee and then a
-- verified resource for that single run.
--
-- kind:
--   head             the one global Head of Project Management (owner-named)
--   project-manager  the one manager of one registered project
--   worker           a specialist; may have no project
--
-- project_path is a soft reference to projects(path), exactly like
-- project_managers: removing a project from the registry never deletes
-- people or history, and re-adding the folder brings the team back. No
-- foreign key, no cascade.
--
-- Archive keeps the row. Nothing here is deleted by an application path.
-- Job title and role_category describe the organization; they grant no
-- permission and are not capability evidence.

CREATE TABLE IF NOT EXISTS ai_employees (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL CHECK (kind IN ('head', 'project-manager', 'worker')),
  name TEXT NOT NULL,
  name_source TEXT NOT NULL CHECK (name_source IN ('generated', 'owner')),
  display_name TEXT,
  job_title TEXT NOT NULL,
  role_category TEXT NOT NULL,
  specializations TEXT NOT NULL DEFAULT '[]',
  project_path TEXT,
  department TEXT,
  description TEXT NOT NULL DEFAULT '',
  notes TEXT,
  status TEXT NOT NULL CHECK (status IN ('active', 'inactive', 'archived')),
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  archived_at INTEGER,
  CHECK (length(trim(name)) BETWEEN 1 AND 80),
  CHECK (length(trim(job_title)) BETWEEN 1 AND 120),
  CHECK (
    (kind = 'head' AND project_path IS NULL)
    OR (kind = 'project-manager' AND project_path IS NOT NULL)
    OR kind = 'worker'
  ),
  CHECK ((status = 'archived') = (archived_at IS NOT NULL))
);

-- Display names may repeat. These are the only uniqueness rules.
CREATE UNIQUE INDEX IF NOT EXISTS ai_employees_one_head
  ON ai_employees(kind) WHERE kind = 'head' AND archived_at IS NULL;

CREATE UNIQUE INDEX IF NOT EXISTS ai_employees_one_project_manager
  ON ai_employees(project_path) WHERE kind = 'project-manager' AND archived_at IS NULL;

CREATE INDEX IF NOT EXISTS ai_employees_project
  ON ai_employees(project_path, kind);

-- Append-only identity and assignment history. No foreign key: archive and a
-- project removal keep the record. `changes` is a JSON object of
-- {field: {from, to}}.
CREATE TABLE IF NOT EXISTS ai_employee_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  employee_id TEXT NOT NULL,
  action TEXT NOT NULL CHECK (action IN (
    'create', 'initialize', 'rename', 'regenerate-name', 'update',
    'assign', 'reassign', 'unassign', 'archive', 'unarchive'
  )),
  changes TEXT NOT NULL DEFAULT '{}',
  created_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS ai_employee_events_employee
  ON ai_employee_events(employee_id, id);
