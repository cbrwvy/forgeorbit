-- Recurring tasks and autonomous scheduled workflows (FO-KANBAN-RECURRING01).
--
-- Architecture:
--   1. `recurring_templates` stores durable recurring task definitions, canonical
--      UTC schedule parameters, submission/overlap/missed policies, and an indexed
--      `next_due_ms` timestamp for O(log N) scheduler wakeups.
--   2. `recurring_occurrences` records every generated or skipped occurrence with a
--      UNIQUE deterministic `occurrence_key` for idempotency and crash recovery,
--      plus durable `submission_intent` state for hands-off submission reconciliation.
--   3. Nullable reference columns on `tasks` link each generated occurrence back to
--      its recurring template without modifying existing ordinary tasks.

CREATE TABLE recurring_templates (
  id TEXT PRIMARY KEY,
  project_path TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'active',
  title TEXT NOT NULL,
  prompt TEXT NOT NULL,
  urgency INTEGER NOT NULL DEFAULT 3,
  task_type TEXT NOT NULL DEFAULT 'task',
  template_config_json TEXT NOT NULL,
  recurrence_type TEXT NOT NULL,
  schedule_json TEXT NOT NULL,
  submission_mode TEXT NOT NULL DEFAULT 'generate_only',
  overlap_policy TEXT NOT NULL DEFAULT 'skip_if_unresolved',
  missed_policy TEXT NOT NULL DEFAULT 'run_once',
  catch_up_limit INTEGER NOT NULL DEFAULT 3,
  next_due_utc TEXT,
  next_due_ms INTEGER,
  last_nominal_utc TEXT,
  occurrence_seq INTEGER NOT NULL DEFAULT 0,
  last_completed_task_id TEXT,
  last_completed_at INTEGER,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  stopped_at INTEGER
);

CREATE INDEX recurring_templates_due
  ON recurring_templates(status, next_due_ms)
  WHERE status = 'active' AND next_due_ms IS NOT NULL;

CREATE INDEX recurring_templates_project
  ON recurring_templates(project_path, status, updated_at DESC);

CREATE TABLE recurring_occurrences (
  id TEXT PRIMARY KEY,
  template_id TEXT NOT NULL REFERENCES recurring_templates(id),
  project_path TEXT NOT NULL,
  occurrence_key TEXT NOT NULL UNIQUE,
  sequence_number INTEGER NOT NULL,
  kind TEXT NOT NULL DEFAULT 'scheduled',
  nominal_utc TEXT NOT NULL,
  status TEXT NOT NULL,
  skip_reason TEXT,
  task_id TEXT,
  submission_intent TEXT NOT NULL DEFAULT 'none',
  submission_error TEXT,
  submitted_run_id TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE UNIQUE INDEX recurring_occurrences_task_id
  ON recurring_occurrences(task_id)
  WHERE task_id IS NOT NULL;

CREATE INDEX recurring_occurrences_template
  ON recurring_occurrences(template_id, created_at DESC, id DESC);

CREATE INDEX recurring_occurrences_pending_submit
  ON recurring_occurrences(submission_intent, created_at ASC)
  WHERE submission_intent = 'pending';

ALTER TABLE tasks ADD COLUMN recurring_template_id TEXT;
ALTER TABLE tasks ADD COLUMN recurring_occurrence_id TEXT;
ALTER TABLE tasks ADD COLUMN recurring_nominal_utc TEXT;

CREATE INDEX tasks_recurring_template
  ON tasks(recurring_template_id)
  WHERE recurring_template_id IS NOT NULL;
