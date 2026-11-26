-- FO-010C AI employee task assignments.
--
-- An assignment is an organizational link between one existing task and one
-- worker. It is not a harness, an account, a model, an agent profile, or a
-- runtime session, and it does not start anything. Migration 080 is reserved
-- for FO-011D and is intentionally absent here.
--
-- task_id, employee_id, and project_path are soft references, same as
-- ai_employees.project_path. A foreign key would either cascade-delete people
-- and history or block the existing task and project delete paths. Removing
-- a project, archiving an employee, or deleting a task must not rewrite this
-- history. The assignment API does not delete employees, tasks, or projects.
--
-- One task has at most one active primary worker. Older rows stay when the
-- task is unassigned, so the partial unique index allows a later assignment.

CREATE TABLE IF NOT EXISTS employee_task_assignments (
  id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL,
  project_path TEXT NOT NULL,
  employee_id TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('active', 'unassigned')),
  provenance TEXT NOT NULL CHECK (provenance = 'owner'),
  revision INTEGER NOT NULL CHECK (revision >= 1),
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  assigned_at INTEGER NOT NULL,
  unassigned_at INTEGER,
  CHECK ((status = 'active') = (unassigned_at IS NULL))
);

CREATE UNIQUE INDEX IF NOT EXISTS employee_task_assignments_one_active
  ON employee_task_assignments(task_id) WHERE status = 'active';

CREATE INDEX IF NOT EXISTS employee_task_assignments_employee
  ON employee_task_assignments(employee_id, status);

CREATE INDEX IF NOT EXISTS employee_task_assignments_project
  ON employee_task_assignments(project_path, status);

-- Append-only. Application code inserts rows and never updates or deletes
-- them. employee_id is the worker the action names (the new worker on
-- reassignment). previous_employee_id is set only for reassignment. Names
-- are not stored, so a later rename cannot rewrite the record.
CREATE TABLE IF NOT EXISTS employee_task_assignment_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  assignment_id TEXT NOT NULL,
  task_id TEXT NOT NULL,
  project_path TEXT NOT NULL,
  employee_id TEXT NOT NULL,
  previous_employee_id TEXT,
  action TEXT NOT NULL CHECK (action IN ('assigned', 'reassigned', 'unassigned')),
  provenance TEXT NOT NULL CHECK (provenance = 'owner'),
  revision INTEGER NOT NULL CHECK (revision >= 1),
  created_at INTEGER NOT NULL,
  CHECK (
    (action = 'reassigned' AND previous_employee_id IS NOT NULL)
    OR (action != 'reassigned' AND previous_employee_id IS NULL)
  )
);

CREATE INDEX IF NOT EXISTS employee_task_assignment_events_task
  ON employee_task_assignment_events(task_id, id);

CREATE INDEX IF NOT EXISTS employee_task_assignment_events_employee
  ON employee_task_assignment_events(employee_id, id);

CREATE INDEX IF NOT EXISTS employee_task_assignment_events_project
  ON employee_task_assignment_events(project_path, id);
