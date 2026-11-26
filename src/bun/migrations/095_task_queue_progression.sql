-- FO-ORCH06: controlled queue progression.
--
-- `reviewed_snapshot` is a compact JSON copy of the plan as the Owner last
-- confirmed it (per-task state, assignee, executor, permission mode, evidence
-- and preference digests). It is only ever used to tell the Owner what changed
-- since that review; it never authorizes anything. `auto_prepare` is the
-- Owner's opt-in to have the panel keep the next task's review prepared
-- (read-only). It is OFF by default and grants no permission to start,
-- assign, retry, change a model or confirm anything.
ALTER TABLE task_plan_queues ADD COLUMN reviewed_snapshot TEXT;
ALTER TABLE task_plan_queues ADD COLUMN auto_prepare INTEGER NOT NULL DEFAULT 0 CHECK (auto_prepare IN (0, 1));
