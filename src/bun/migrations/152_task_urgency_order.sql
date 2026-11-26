-- Kanban urgency (1..5) and a persisted vertical order (FO-KANBAN-URGENCY01).
--
-- `urgency` is NOT the scheduling priority in `task_priorities` (migration 072: four levels,
-- consumed by the approved-batch scheduler and frozen into approvals). It only orders the
-- Kanban board; nothing that decides what may run reads it. Higher is more urgent; 3 is Normal,
-- so every existing task keeps a valid value.
--
-- `board_rank` orders tasks inside one (project, column, urgency) group, ascending. Ranks are
-- sparse integers (spacing 1024) so a drag rewrites one row; the group is renumbered only when
-- two neighbours run out of room. The displayed order is always urgency DESC, board_rank ASC,
-- created_at ASC, id ASC.
ALTER TABLE tasks ADD COLUMN urgency INTEGER NOT NULL DEFAULT 3 CHECK (urgency BETWEEN 1 AND 5);
ALTER TABLE tasks ADD COLUMN board_rank INTEGER NOT NULL DEFAULT 0;

-- Keep the order people already see: the board listed each column newest first, so the newest
-- task gets the smallest rank within its column.
UPDATE tasks SET board_rank = 1024 * (
  SELECT COUNT(*) FROM tasks AS newer
   WHERE newer."column" = tasks."column"
     AND (newer.created_at > tasks.created_at OR (newer.created_at = tasks.created_at AND newer.id < tasks.id))
) + 1024;

CREATE INDEX tasks_board_order ON tasks("column", urgency, board_rank);
