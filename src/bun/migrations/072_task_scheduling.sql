-- Structured task scheduling (FO-005C.1): real dependencies and priorities.
--
-- `task_dependencies` row = "task_id waits for depends_on_id". Both ends
-- cascade on delete, so removing a task never leaves a dangling link (an
-- approved batch notices the change: its frozen dependency list no longer
-- matches and the start is held). Self-links are refused here as well as
-- in code; cycles and cross-project links are refused in code, inside the
-- same synchronous write.
--
-- The "## Depends on" Markdown that task proposals write into prompts is
-- deliberately NOT migrated: it was written for the agent to read and is
-- not a reliable source for deciding what may run.
CREATE TABLE task_dependencies (
  task_id       TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  depends_on_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  created_at    INTEGER NOT NULL,
  PRIMARY KEY (task_id, depends_on_id),
  CHECK (task_id != depends_on_id)
);
CREATE INDEX task_dependencies_depends_on ON task_dependencies(depends_on_id);

-- A task without a row is Normal, so every existing task keeps working.
CREATE TABLE task_priorities (
  task_id    TEXT PRIMARY KEY REFERENCES tasks(id) ON DELETE CASCADE,
  priority   TEXT NOT NULL CHECK (priority IN ('critical', 'high', 'normal', 'low')),
  updated_at INTEGER NOT NULL
);
