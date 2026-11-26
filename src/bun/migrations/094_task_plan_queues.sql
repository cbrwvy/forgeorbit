-- FO-ORCH05: the Owner's controlled execution queue for one task plan.
--
-- A queue stores only what the Owner decided: which tasks of a plan, in
-- which order, whether the queue is paused or stopped, and the plan key the
-- Owner last reviewed. Everything else (ready, blocked, running, done, the
-- recommended executor) is derived from the plan on every read. A queue is
-- not a permission: it starts nothing, and every start still goes through
-- Employee Review -> Permission Review -> Confirm -> Run.
CREATE TABLE IF NOT EXISTS task_plan_queues (
  id               TEXT PRIMARY KEY,
  project_path     TEXT NOT NULL,
  proposal_id      TEXT NOT NULL,
  task_ids         TEXT NOT NULL,
  status           TEXT NOT NULL CHECK (status IN ('active', 'paused', 'stopped')),
  revision         INTEGER NOT NULL,
  reviewed_plan_key TEXT NOT NULL,
  created_at       INTEGER NOT NULL,
  updated_at       INTEGER NOT NULL,
  UNIQUE (project_path, proposal_id)
);
