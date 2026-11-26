-- FO-INFRA-AUTO01: infrastructure operations on the existing cluster registry.
-- Configuration and durable results only. No credentials, no remote shell.

CREATE TABLE IF NOT EXISTS infra_bindings (
  id TEXT PRIMARY KEY,
  cluster_id TEXT NOT NULL,
  project_path TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('application', 'shared-infrastructure', 'database', 'worker')),
  environment TEXT NOT NULL CHECK (environment IN ('development', 'staging', 'production', 'custom')),
  environment_label TEXT NOT NULL DEFAULT '',
  source_branch TEXT NOT NULL,
  workflow_name TEXT NOT NULL,
  adapter TEXT NOT NULL CHECK (adapter IN ('fake', 'github-actions', 'manual')),
  services_json TEXT NOT NULL,
  health_json TEXT NOT NULL,
  required_checks_json TEXT NOT NULL,
  depends_on_project_path TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  FOREIGN KEY (cluster_id) REFERENCES clusters(id) ON DELETE CASCADE,
  FOREIGN KEY (project_path) REFERENCES projects(path) ON DELETE CASCADE,
  UNIQUE (project_path, environment, environment_label)
);

CREATE INDEX IF NOT EXISTS idx_infra_bindings_cluster ON infra_bindings (cluster_id);

CREATE TABLE IF NOT EXISTS infra_production_policies (
  id TEXT PRIMARY KEY,
  cluster_id TEXT,
  body_json TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS infra_plans (
  id TEXT PRIMARY KEY,
  cluster_id TEXT NOT NULL,
  project_path TEXT NOT NULL,
  environment TEXT NOT NULL,
  environment_label TEXT NOT NULL DEFAULT '',
  repository_path TEXT NOT NULL,
  branch TEXT NOT NULL,
  sha TEXT NOT NULL,
  adapter TEXT NOT NULL,
  workflow_name TEXT NOT NULL,
  dependencies_json TEXT NOT NULL,
  services_json TEXT NOT NULL,
  health_json TEXT NOT NULL,
  required_checks_json TEXT NOT NULL,
  rollback_json TEXT NOT NULL,
  digest TEXT NOT NULL,
  state TEXT NOT NULL,
  failure_reason TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_infra_plans_project ON infra_plans (project_path, environment, created_at DESC);

CREATE TABLE IF NOT EXISTS infra_authorizations (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL CHECK (kind IN ('deployment', 'git', 'ci-dispatch', 'rollback')),
  plan_id TEXT,
  digest TEXT NOT NULL,
  project_path TEXT NOT NULL,
  environment TEXT NOT NULL,
  sha TEXT NOT NULL,
  channel TEXT NOT NULL CHECK (channel = 'synthetic'),
  issued_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  consumed_at INTEGER,
  revoked_at INTEGER,
  nonce TEXT NOT NULL UNIQUE
);

CREATE TABLE IF NOT EXISTS infra_attempts (
  id TEXT PRIMARY KEY,
  plan_id TEXT NOT NULL UNIQUE,
  authorization_id TEXT NOT NULL,
  state TEXT NOT NULL,
  sha TEXT NOT NULL,
  health TEXT NOT NULL,
  provenance TEXT NOT NULL,
  failure_reason TEXT,
  log_excerpt TEXT NOT NULL DEFAULT '',
  started_at INTEGER NOT NULL,
  finished_at INTEGER
);

CREATE TABLE IF NOT EXISTS infra_ci_records (
  id TEXT PRIMARY KEY,
  project_path TEXT NOT NULL,
  workflow_name TEXT NOT NULL,
  run_key TEXT NOT NULL,
  sha TEXT NOT NULL,
  branch TEXT,
  status TEXT NOT NULL,
  conclusion TEXT,
  failed_jobs_json TEXT NOT NULL DEFAULT '[]',
  log_excerpt TEXT NOT NULL DEFAULT '',
  source TEXT NOT NULL CHECK (source IN ('fake', 'local-file', 'github')),
  observed_at INTEGER NOT NULL,
  UNIQUE (project_path, workflow_name, run_key)
);

CREATE TABLE IF NOT EXISTS infra_proposals (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL,
  project_path TEXT,
  environment TEXT,
  plan_id TEXT,
  status TEXT NOT NULL,
  detail TEXT NOT NULL,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS infra_task_gates (
  task_id TEXT PRIMARY KEY,
  project_path TEXT NOT NULL,
  upstream_project_path TEXT NOT NULL,
  reason TEXT NOT NULL,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS infra_runtime (
  id TEXT PRIMARY KEY CHECK (id = 'global'),
  paused INTEGER NOT NULL DEFAULT 0,
  cancelled INTEGER NOT NULL DEFAULT 0,
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS infra_operation_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  kind TEXT NOT NULL,
  project_path TEXT,
  detail TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
