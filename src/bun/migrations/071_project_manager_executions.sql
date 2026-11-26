-- Supervised task execution from the project manager (FO-005B). One row
-- per execution proposal: the configuration the owner reviewed, the checks
-- shown, the approval, and the run it started. `data` is the JSON
-- ExecutionProposal. Run progress is never copied here — it is read from
-- the tasks/runs tables each time, so this row can't disagree with them.
--
-- At most one open proposal (proposed or starting) per task: a double
-- click, a replayed request or a second "Execute" can never end up with two
-- approvals racing for the same task.
CREATE TABLE project_manager_executions (
  id           TEXT PRIMARY KEY,
  project_path TEXT NOT NULL,
  task_id      TEXT NOT NULL,
  status       TEXT NOT NULL,
  run_id       TEXT,
  data         TEXT NOT NULL,
  created_at   INTEGER NOT NULL,
  updated_at   INTEGER NOT NULL
);
CREATE INDEX project_manager_executions_project ON project_manager_executions(project_path, created_at);
CREATE INDEX project_manager_executions_task ON project_manager_executions(task_id);
CREATE UNIQUE INDEX project_manager_executions_open_task
  ON project_manager_executions(task_id) WHERE status IN ('proposed', 'starting');
