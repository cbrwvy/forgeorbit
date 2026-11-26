-- Project estimation inputs (FO-006B). One JSON document per registered
-- project path, same isolation as project_managers. The document is manual
-- planning input only: durations the user typed, fees they typed, and a
-- backlog fingerprint. It does not store tokens or generated tariffs.
--
-- Numbered 074 so 071_project_manager_executions, 072_task_scheduling and
-- 073_execution_batches keep their own ids. A database that already applied
-- this file as 071_project_estimation is recognized by that alias and is
-- not migrated again.
--
-- Rows are kept when a project is removed from the list. Re-adding the
-- folder brings the same inputs back, and a different path never reads them.
CREATE TABLE project_estimation (
  project_path         TEXT PRIMARY KEY,
  settings             TEXT NOT NULL,
  backlog_fingerprint  TEXT NOT NULL,
  updated_at           INTEGER NOT NULL
);
