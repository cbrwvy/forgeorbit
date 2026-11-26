-- Project-level Owner authorization for hands-off work.
-- `grant_id` is the issued `owner_trust_grants` row the Owner signed (kind project-envelope). Each provider launch inside
-- the envelope is one row in `handsoff_launches` with its own single-use child grant; the unique claim key is the replay
-- guard and the row count is the launch budget. A released row returns its launch to the budget.
CREATE TABLE handsoff_authorizations (
  id TEXT PRIMARY KEY,
  project_path TEXT NOT NULL,
  project_identity TEXT NOT NULL,
  grant_id TEXT NOT NULL UNIQUE,
  enrollment_id TEXT NOT NULL,
  envelope_json TEXT NOT NULL,
  envelope_digest TEXT NOT NULL,
  policy_revision INTEGER NOT NULL,
  launch_budget INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  status TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  ended_at INTEGER
);
CREATE UNIQUE INDEX handsoff_authorizations_one_active ON handsoff_authorizations(project_path) WHERE status = 'active';

CREATE TABLE handsoff_launches (
  claim_key TEXT PRIMARY KEY,
  authorization_id TEXT NOT NULL,
  handsoff_run_id TEXT NOT NULL,
  task_id TEXT NOT NULL,
  role TEXT NOT NULL,
  child_grant_id TEXT NOT NULL UNIQUE,
  status TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX handsoff_launches_authorization ON handsoff_launches(authorization_id, status);
