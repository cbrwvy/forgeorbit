-- FO-BROWSER02. One Owner grant lets one manager message read one browser
-- observation and request one browser action. The row is the audit trail.
-- It stores the bounded observation the manager was allowed to see. It does
-- not store cookies, storage, screenshots, or hidden fields.
--
-- An approved grant that is still unused after a restart is expired.
-- A claimed action that did not finish is marked interrupted and is not replayed.

CREATE TABLE IF NOT EXISTS browser_agent_grants (
  id TEXT PRIMARY KEY CHECK (length(id) = 64),
  manager_kind TEXT NOT NULL CHECK (manager_kind IN ('head-of-pm', 'project-manager')),
  project_path TEXT,
  session_id TEXT NOT NULL,
  observation_id TEXT NOT NULL,
  observed_at INTEGER NOT NULL,
  observation_json TEXT NOT NULL,
  approved_origins_json TEXT NOT NULL,
  allowed_actions_json TEXT NOT NULL,
  max_actions INTEGER NOT NULL CHECK (max_actions = 1),
  status TEXT NOT NULL CHECK (status IN ('approved', 'consumed', 'revoked', 'expired', 'rejected')),
  action_status TEXT NOT NULL DEFAULT 'none' CHECK (action_status IN ('none', 'claimed', 'completed', 'refused', 'interrupted')),
  action_json TEXT,
  outcome_json TEXT,
  claim_token TEXT,
  approved_by TEXT NOT NULL CHECK (approved_by = 'owner'),
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  settled_at INTEGER,
  message_id TEXT,
  turn_id TEXT,
  detail TEXT,
  CHECK ((manager_kind = 'project-manager') = (project_path IS NOT NULL))
);

CREATE INDEX IF NOT EXISTS browser_agent_grants_target
  ON browser_agent_grants(manager_kind, project_path, created_at DESC);
