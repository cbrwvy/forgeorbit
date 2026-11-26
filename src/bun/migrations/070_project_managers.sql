-- Project manager (FO-005A). One logical manager per registered project,
-- keyed by the project path like project_interviews / environment_profiles.
-- Chat history, task proposals and confirmed decisions live in their own
-- tables, never in `preferences` (a history can grow to hundreds of KB).
--
-- Rows are kept when a project is removed from the list: removing a project
-- never deletes its files, and re-adding the folder brings its manager back.
CREATE TABLE project_managers (
  project_path     TEXT PRIMARY KEY,
  config           TEXT NOT NULL,
  last_activity_at INTEGER,
  updated_at       INTEGER NOT NULL
);

-- `seq` orders a project's messages; `data` is the JSON ManagerMessage.
CREATE TABLE project_manager_messages (
  id           TEXT PRIMARY KEY,
  project_path TEXT NOT NULL,
  seq          INTEGER NOT NULL,
  data         TEXT NOT NULL,
  created_at   INTEGER NOT NULL
);
CREATE INDEX project_manager_messages_project ON project_manager_messages(project_path, seq);

-- `data` is the JSON TaskProposal (items, edits, per-item results).
CREATE TABLE project_manager_proposals (
  id           TEXT PRIMARY KEY,
  project_path TEXT NOT NULL,
  status       TEXT NOT NULL,
  data         TEXT NOT NULL,
  created_at   INTEGER NOT NULL,
  updated_at   INTEGER NOT NULL
);
CREATE INDEX project_manager_proposals_project ON project_manager_proposals(project_path, created_at);

CREATE TABLE project_manager_decisions (
  id           TEXT PRIMARY KEY,
  project_path TEXT NOT NULL,
  text         TEXT NOT NULL,
  source       TEXT NOT NULL,
  created_at   INTEGER NOT NULL
);
CREATE INDEX project_manager_decisions_project ON project_manager_decisions(project_path, created_at);
