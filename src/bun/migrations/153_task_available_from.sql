-- Scheduled task availability (FO-KANBAN-SCHEDULE01).
--
-- Nullable canonical UTC ISO-8601 instant (e.g. '2026-11-27T08:00:00.000Z').
-- NULL means the task is available immediately; existing tasks default to NULL.
-- A future instant blocks every automatic launch path until that UTC instant
-- arrives. Preserves urgency, board_rank, status, dependencies and all history.
ALTER TABLE tasks ADD COLUMN available_from_utc TEXT;

CREATE INDEX tasks_available_from_utc ON tasks(available_from_utc) WHERE available_from_utc IS NOT NULL;
