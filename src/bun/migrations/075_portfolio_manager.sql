-- Global portfolio manager (FO-008C). One logical manager for every
-- registered project, so its config is a single row keyed 'global'. Chat,
-- portfolio plans, delegation proposals and confirmed decisions live in
-- their own tables, never in `preferences`.
--
-- A delegation names the project path it targets. `status` is copied out of
-- the JSON so an approval can claim a row with one compare-and-set UPDATE,
-- which is what keeps a double click or two windows from sending twice.
-- Nothing here is deleted when a project is removed from the list.
CREATE TABLE portfolio_manager (
  id               TEXT PRIMARY KEY,
  config           TEXT NOT NULL,
  last_activity_at INTEGER,
  updated_at       INTEGER NOT NULL
);

CREATE TABLE portfolio_manager_messages (
  id         TEXT PRIMARY KEY,
  seq        INTEGER NOT NULL,
  data       TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX portfolio_manager_messages_seq ON portfolio_manager_messages(seq);

CREATE TABLE portfolio_manager_plans (
  id         TEXT PRIMARY KEY,
  message_id TEXT NOT NULL,
  status     TEXT NOT NULL,
  data       TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX portfolio_manager_plans_created ON portfolio_manager_plans(created_at);

CREATE TABLE portfolio_manager_delegations (
  id           TEXT PRIMARY KEY,
  project_path TEXT NOT NULL,
  message_id   TEXT NOT NULL,
  status       TEXT NOT NULL,
  data         TEXT NOT NULL,
  created_at   INTEGER NOT NULL,
  updated_at   INTEGER NOT NULL
);
CREATE INDEX portfolio_manager_delegations_created ON portfolio_manager_delegations(created_at);
CREATE INDEX portfolio_manager_delegations_project ON portfolio_manager_delegations(project_path, created_at);

CREATE TABLE portfolio_manager_decisions (
  id         TEXT PRIMARY KEY,
  text       TEXT NOT NULL,
  source     TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
