-- FO-DEPLOY01: Owner-approved cluster deployment requests (dry-run only).

CREATE TABLE deployment_requests (
  id              TEXT PRIMARY KEY,
  project_path    TEXT NOT NULL,
  cluster_id      TEXT NOT NULL,
  environment     TEXT NOT NULL CHECK (environment IN ('staging', 'production')),
  revision        TEXT NOT NULL,
  revision_resolved TEXT,
  requested_by_role TEXT NOT NULL CHECK (requested_by_role IN ('owner', 'project-manager', 'head-of-pm')),
  status          TEXT NOT NULL,
  approval_digest TEXT,
  approval_generation INTEGER NOT NULL DEFAULT 0,
  approved_at     INTEGER,
  rejected_at     INTEGER,
  preflight_json  TEXT NOT NULL,
  dry_run_json    TEXT,
  error_message   TEXT,
  created_at      INTEGER NOT NULL,
  updated_at      INTEGER NOT NULL,
  FOREIGN KEY (project_path) REFERENCES projects(path) ON DELETE CASCADE,
  FOREIGN KEY (cluster_id) REFERENCES clusters(id) ON DELETE RESTRICT
);

CREATE INDEX idx_deployment_requests_project ON deployment_requests (project_path, updated_at DESC);
CREATE INDEX idx_deployment_requests_status ON deployment_requests (status, updated_at DESC);
CREATE INDEX idx_deployment_requests_cluster ON deployment_requests (cluster_id, updated_at DESC);
