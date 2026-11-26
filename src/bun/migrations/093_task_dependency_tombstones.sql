-- FO-ORCH05: deleting a prerequisite must not unblock what waited for it.
--
-- `task_dependencies` cascades with both of its tasks, so deleting task A
-- used to erase "B waits for A" and B silently looked startable. A
-- tombstone remembers that link (written by the BEFORE DELETE trigger the
-- migration's apply() installs, so every delete path is covered). Every
-- readiness check treats a tombstone as a blocking, deleted dependency until
-- the Owner clears it explicitly. The migration also records links that a
-- stored PM proposal named for a prerequisite that is already gone (the
-- proposal is the durable record of that expectation). Tasks that never
-- had a dependency, in a proposal or a row, get no tombstone; nothing is
-- invented for existing data.
CREATE TABLE IF NOT EXISTS task_dependency_tombstones (
  task_id        TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  missing_id     TEXT NOT NULL,
  missing_title  TEXT NOT NULL,
  missing_column TEXT,
  deleted_at     INTEGER NOT NULL,
  -- Set when the Owner explicitly clears the link; the row stays as the record.
  cleared_at     INTEGER,
  PRIMARY KEY (task_id, missing_id)
);
