-- FO-NATIVE-CU02. One Owner grant lets one manager message read one native
-- computer observation and request one supported native action. The row is the audit trail.
-- It stores the bounded observation the manager was allowed to see. It does
-- not store credentials, tokens, or screenshots.
--
-- An approved grant that is still unused after a restart is expired.
-- A claimed action that did not finish is marked interrupted and is not replayed.

CREATE TABLE IF NOT EXISTS native_computer_agent_grants (
  id TEXT PRIMARY KEY CHECK (length(id) = 64),
  manager_kind TEXT NOT NULL CHECK (manager_kind IN ('head-of-pm', 'project-manager')),
  project_path TEXT,
  session_id TEXT NOT NULL,
  observation_id TEXT NOT NULL,
  bundle_id TEXT NOT NULL,
  pid INTEGER NOT NULL,
  start_sec INTEGER NOT NULL,
  start_usec INTEGER NOT NULL,
  window_id INTEGER NOT NULL,
  observed_at INTEGER NOT NULL,
  observation_json TEXT NOT NULL,
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

CREATE INDEX IF NOT EXISTS native_computer_agent_grants_target
  ON native_computer_agent_grants(manager_kind, project_path, created_at DESC);
