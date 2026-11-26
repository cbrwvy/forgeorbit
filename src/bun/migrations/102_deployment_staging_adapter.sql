-- FO-DEPLOY02: staging integration config + execution attempts (extends FO-DEPLOY01).

CREATE TABLE deployment_staging_integrations (
  id                TEXT PRIMARY KEY,
  cluster_id        TEXT NOT NULL,
  project_path      TEXT NOT NULL,
  environment       TEXT NOT NULL CHECK (environment = 'staging'),
  integration_type  TEXT NOT NULL,
  integration_label TEXT NOT NULL,
  project_slug      TEXT NOT NULL,
  entrypoint_ref    TEXT NOT NULL,
  capabilities_json TEXT NOT NULL,
  real_execution_configured INTEGER NOT NULL DEFAULT 0 CHECK (real_execution_configured IN (0, 1)),
  real_execution_enabled INTEGER NOT NULL DEFAULT 0 CHECK (real_execution_enabled IN (0, 1)),
  created_at        INTEGER NOT NULL,
  updated_at        INTEGER NOT NULL,
  FOREIGN KEY (cluster_id) REFERENCES clusters(id) ON DELETE CASCADE,
  FOREIGN KEY (project_path) REFERENCES projects(path) ON DELETE CASCADE,
  UNIQUE (cluster_id, project_path, environment)
);

CREATE INDEX idx_deployment_staging_integrations_project
  ON deployment_staging_integrations (project_path, updated_at DESC);

ALTER TABLE deployment_requests ADD COLUMN plan_digest TEXT;
ALTER TABLE deployment_requests ADD COLUMN integration_id TEXT;
ALTER TABLE deployment_requests ADD COLUMN execution_auth_digest TEXT;
ALTER TABLE deployment_requests ADD COLUMN execution_auth_generation INTEGER NOT NULL DEFAULT 0;
ALTER TABLE deployment_requests ADD COLUMN execution_auth_at INTEGER;
ALTER TABLE deployment_requests ADD COLUMN execution_state TEXT NOT NULL DEFAULT 'none';
ALTER TABLE deployment_requests ADD COLUMN active_attempt_id TEXT;

CREATE TABLE deployment_execution_attempts (
  id                  TEXT PRIMARY KEY,
  request_id          TEXT NOT NULL,
  integration_id      TEXT,
  plan_digest         TEXT NOT NULL,
  revision            TEXT NOT NULL,
  revision_resolved   TEXT,
  state               TEXT NOT NULL,
  exit_code           INTEGER,
  log_sanitized       TEXT,
  error_message       TEXT,
  started_at          INTEGER,
  finished_at         INTEGER,
  created_at          INTEGER NOT NULL,
  FOREIGN KEY (request_id) REFERENCES deployment_requests(id) ON DELETE CASCADE
);

CREATE INDEX idx_deployment_execution_attempts_request
  ON deployment_execution_attempts (request_id, created_at DESC);

CREATE UNIQUE INDEX idx_deployment_execution_attempts_active
  ON deployment_execution_attempts (request_id)
  WHERE state = 'running';
