-- FO-QC-PREFLIGHT01: one Owner authorization for one fixed Bun test.
-- Opening an evidence preview does not write these rows and does not spawn a test.

CREATE TABLE review_test_authorizations (
  id                  TEXT PRIMARY KEY,
  task_id             TEXT NOT NULL,
  project_path        TEXT NOT NULL,
  status              TEXT NOT NULL CHECK (status IN ('prepared', 'approved', 'consumed', 'expired', 'cancelled', 'invalidated')),
  authorization_json  TEXT NOT NULL,
  created_at          INTEGER NOT NULL,
  updated_at          INTEGER NOT NULL
);

CREATE INDEX idx_review_test_auth_task ON review_test_authorizations (task_id, created_at DESC);

CREATE TABLE review_test_observations (
  id                  TEXT PRIMARY KEY,
  task_id             TEXT NOT NULL,
  project_path        TEXT NOT NULL,
  workspace_path      TEXT NOT NULL,
  command             TEXT NOT NULL,
  source_fingerprint  TEXT NOT NULL,
  observation_json    TEXT NOT NULL,
  created_at          INTEGER NOT NULL
);

CREATE INDEX idx_review_test_obs_lookup
  ON review_test_observations (task_id, workspace_path, command, source_fingerprint, created_at DESC);
