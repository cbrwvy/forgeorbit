-- Single-use owner grants letting the project manager admit Backlog tasks to
-- the project inbox column on one chat turn (FO-005 intake).
CREATE TABLE pm_intake_grants (
  id           TEXT PRIMARY KEY,
  project_path TEXT NOT NULL,
  task_ids     TEXT NOT NULL,
  status       TEXT NOT NULL CHECK (status IN ('pending', 'consumed', 'revoked')),
  message_id   TEXT,
  created_at   INTEGER NOT NULL,
  consumed_at  INTEGER
);
CREATE INDEX pm_intake_grants_project ON pm_intake_grants(project_path, created_at);
