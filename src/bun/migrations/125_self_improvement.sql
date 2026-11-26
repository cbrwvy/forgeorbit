-- FO-SELF-IMPROVE01: versioned instruction and skill improvements.
-- Version rows are insert-only. Activation points at a version; it does not rewrite it.

CREATE TABLE IF NOT EXISTS improvement_versions (
  id TEXT PRIMARY KEY,
  artifact_key TEXT NOT NULL,
  version INTEGER NOT NULL,
  scope TEXT NOT NULL CHECK (scope IN ('global', 'project')),
  project_path TEXT,
  role TEXT NOT NULL,
  target_kind TEXT NOT NULL,
  content TEXT NOT NULL,
  content_sha TEXT NOT NULL,
  parent_version INTEGER,
  source TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  UNIQUE (artifact_key, version)
);

CREATE TABLE IF NOT EXISTS improvement_candidates (
  id TEXT PRIMARY KEY,
  status TEXT NOT NULL CHECK (status IN (
    'observed', 'proposed', 'evaluating', 'evaluated', 'approved', 'active',
    'monitoring', 'retained', 'rolled_back', 'blocked', 'rejected', 'expired'
  )),
  target_kind TEXT NOT NULL,
  role TEXT NOT NULL,
  scope TEXT NOT NULL CHECK (scope IN ('global', 'project')),
  project_path TEXT,
  artifact_key TEXT NOT NULL,
  current_version INTEGER,
  proposed_version INTEGER,
  current_content TEXT NOT NULL,
  proposed_content TEXT,
  diff_text TEXT,
  evidence_json TEXT NOT NULL,
  hypothesis TEXT,
  expected_result TEXT,
  evaluation_plan TEXT,
  risk TEXT NOT NULL CHECK (risk IN ('low', 'medium', 'high')),
  authorization TEXT NOT NULL CHECK (authorization IN ('owner', 'policy-low-risk', 'none')),
  metrics_json TEXT,
  decision TEXT,
  decision_reason TEXT,
  depth INTEGER NOT NULL DEFAULT 0,
  parent_candidate_id TEXT,
  synthetic INTEGER NOT NULL DEFAULT 0,
  expires_at INTEGER,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_improvement_candidates_status ON improvement_candidates (status, updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_improvement_candidates_scope ON improvement_candidates (project_path, role, status);

CREATE TABLE IF NOT EXISTS improvement_transitions (
  id TEXT PRIMARY KEY,
  candidate_id TEXT NOT NULL,
  from_status TEXT NOT NULL,
  to_status TEXT NOT NULL,
  reason TEXT NOT NULL,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS improvement_evaluations (
  id TEXT PRIMARY KEY,
  candidate_id TEXT NOT NULL,
  attempt INTEGER NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('running', 'finished', 'inconclusive')),
  fixture_ids_json TEXT NOT NULL,
  baseline_metrics_json TEXT,
  candidate_metrics_json TEXT,
  verdict TEXT,
  attribution TEXT NOT NULL,
  provider TEXT,
  model TEXT,
  baseline_model TEXT,
  account_id TEXT,
  quota_status TEXT NOT NULL DEFAULT 'unknown',
  permission_key TEXT NOT NULL,
  started_at INTEGER NOT NULL,
  finished_at INTEGER,
  UNIQUE (candidate_id, attempt),
  UNIQUE (permission_key)
);

CREATE TABLE IF NOT EXISTS improvement_activations (
  id TEXT PRIMARY KEY,
  candidate_id TEXT NOT NULL,
  artifact_key TEXT NOT NULL,
  version INTEGER NOT NULL,
  scope TEXT NOT NULL CHECK (scope IN ('global', 'project')),
  project_path TEXT,
  role TEXT NOT NULL,
  strategy TEXT NOT NULL CHECK (strategy IN ('manual', 'policy-low-risk', 'canary', 'project', 'role', 'full')),
  status TEXT NOT NULL CHECK (status IN ('active', 'superseded', 'rolled_back')),
  last_known_good_version INTEGER,
  canary_limit INTEGER,
  runs_consumed INTEGER NOT NULL DEFAULT 0,
  activated_at INTEGER NOT NULL,
  rolled_back_at INTEGER,
  rollback_reason TEXT
);

CREATE INDEX IF NOT EXISTS idx_improvement_activations_lookup
  ON improvement_activations (role, status, scope, project_path);

CREATE TABLE IF NOT EXISTS improvement_run_provenance (
  run_id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL,
  project_path TEXT NOT NULL,
  role TEXT NOT NULL,
  versions_json TEXT NOT NULL,
  snapshot_sha TEXT NOT NULL,
  frozen_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS improvement_observations (
  id TEXT PRIMARY KEY,
  role TEXT NOT NULL,
  project_path TEXT NOT NULL,
  fingerprint TEXT NOT NULL,
  summary TEXT NOT NULL,
  verified INTEGER NOT NULL,
  synthetic INTEGER NOT NULL,
  origin TEXT NOT NULL CHECK (origin IN ('production', 'evaluation')),
  source TEXT NOT NULL,
  source_id TEXT,
  evidence_json TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  UNIQUE (source, source_id)
);

CREATE TABLE IF NOT EXISTS improvement_fixtures (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  role TEXT NOT NULL,
  project_path TEXT,
  held_out INTEGER NOT NULL,
  defect_fingerprint TEXT NOT NULL,
  must_include_json TEXT NOT NULL,
  must_not_include_json TEXT NOT NULL,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS improvement_controls (
  id TEXT PRIMARY KEY CHECK (id = 'owner'),
  enabled INTEGER NOT NULL DEFAULT 0,
  paused INTEGER NOT NULL DEFAULT 0,
  stopped INTEGER NOT NULL DEFAULT 0,
  period_started_at INTEGER NOT NULL,
  candidates_in_period INTEGER NOT NULL DEFAULT 0,
  activation_attempts INTEGER NOT NULL DEFAULT 0,
  consecutive_failures INTEGER NOT NULL DEFAULT 0,
  consecutive_no_gain INTEGER NOT NULL DEFAULT 0,
  cooldown_until INTEGER,
  max_candidates_per_period INTEGER NOT NULL DEFAULT 8,
  max_evaluations_per_candidate INTEGER NOT NULL DEFAULT 2,
  max_activation_attempts INTEGER NOT NULL DEFAULT 3,
  max_nested_depth INTEGER NOT NULL DEFAULT 1,
  max_concurrent INTEGER NOT NULL DEFAULT 1,
  max_rework INTEGER NOT NULL DEFAULT 2,
  max_duration_ms INTEGER NOT NULL DEFAULT 600000,
  updated_at INTEGER NOT NULL
);
