-- FO-010E2 employee supervised execution and run attribution.
--
-- One row per owner-reviewed attempt to run an assigned task. The row is
-- (a) the single-use owner approval for exactly that attempt and (b) the
-- durable link Employee -> Assignment revision -> Task -> Run once a run
-- really exists. It is not a second run history: run status, events and
-- exit codes stay in `runs`; this row only records who was responsible and
-- what was requested versus what the runtime confirmed.
--
-- task_id, employee_id, assignment_id, project_path, run_id and
-- execution_id are soft references (same as employee_task_assignments):
-- deleting a task or archiving an employee must not rewrite this history.
-- Existing runs are never back-filled; only runs started through this flow
-- get a row.
--
-- status:
--   awaiting-approval  reviewed by the owner, not yet confirmed (expires)
--   starting           confirmed and claimed; the runtime call is in flight
--   started            the existing runtime accepted the start (run_id set)
--   start-failed       the runtime refused or failed before a run existed
--   indeterminate      outcome unknown (crash or error mid-start); needs a look
--   rejected           revalidation after the confirmation refused; nothing started
--   expired | superseded | cancelled   the review never became a start
--
-- actual_* are NULL unless the runtime itself established them. They are
-- never copied from requested_* or from a router recommendation.

CREATE TABLE IF NOT EXISTS employee_executions (
  id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL,
  task_title TEXT NOT NULL,
  project_path TEXT NOT NULL,
  employee_id TEXT NOT NULL,
  employee_name TEXT NOT NULL,
  assignment_id TEXT NOT NULL,
  assignment_revision INTEGER NOT NULL CHECK (assignment_revision >= 1),
  status TEXT NOT NULL CHECK (status IN (
    'awaiting-approval', 'starting', 'started', 'start-failed', 'indeterminate',
    'rejected', 'expired', 'superseded', 'cancelled'
  )),
  revision INTEGER NOT NULL DEFAULT 1 CHECK (revision >= 1),

  requested_harness_id TEXT NOT NULL,
  requested_model TEXT,
  requested_effort TEXT,
  requested_complexity TEXT,
  requested_policy TEXT NOT NULL,
  requested_mode TEXT NOT NULL,

  inputs_key TEXT NOT NULL,
  task_fingerprint TEXT NOT NULL,
  config_json TEXT NOT NULL,
  review_json TEXT NOT NULL,
  usage_notice TEXT,
  unconfirmed_prior INTEGER NOT NULL DEFAULT 0,

  execution_id TEXT,
  run_id TEXT,
  actual_harness_id TEXT,
  actual_model TEXT,
  actual_account_id TEXT,
  actual_provenance TEXT NOT NULL DEFAULT 'unknown' CHECK (actual_provenance IN ('runtime', 'owner', 'unknown')),
  approval_provenance TEXT NOT NULL DEFAULT 'unknown' CHECK (approval_provenance IN ('runtime', 'owner', 'unknown')),

  result TEXT CHECK (result IS NULL OR result IN ('succeeded', 'failed', 'cancelled', 'orphaned')),
  reason TEXT,

  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  approved_at INTEGER,
  claimed_at INTEGER,
  started_at INTEGER,
  finished_at INTEGER,

  CHECK (status NOT IN ('starting', 'started') OR approved_at IS NOT NULL),
  CHECK (status != 'started' OR started_at IS NOT NULL),
  CHECK (finished_at IS NULL OR result IS NOT NULL)
);

-- One unfinished claim or open review per task. A second tab's review
-- replaces the first (superseded); a second confirmation cannot start twice.
CREATE UNIQUE INDEX IF NOT EXISTS employee_executions_one_open
  ON employee_executions(task_id) WHERE status IN ('awaiting-approval', 'starting');

-- A run belongs to at most one attempt.
CREATE UNIQUE INDEX IF NOT EXISTS employee_executions_one_per_run
  ON employee_executions(run_id) WHERE run_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS employee_executions_task ON employee_executions(task_id, created_at);
CREATE INDEX IF NOT EXISTS employee_executions_employee ON employee_executions(employee_id, created_at);
CREATE INDEX IF NOT EXISTS employee_executions_project ON employee_executions(project_path, status, created_at);
