-- FO-ROUTING04: AI Router 2.0 — Intelligent Model and Account Selection

CREATE TABLE IF NOT EXISTS router_v2_policies (
  scope_id TEXT PRIMARY KEY, -- 'global' or project path
  preset TEXT NOT NULL CHECK (preset IN ('best-quality', 'lowest-cost', 'balanced', 'fastest', 'quota-saver', 'custom')),
  quota_policy TEXT NOT NULL CHECK (quota_policy IN ('strict', 'permissive')),
  autonomy_mode TEXT NOT NULL CHECK (autonomy_mode IN ('supervised', 'autonomous', 'full-autonomy')),
  weights_json TEXT NOT NULL,
  constraints_json TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS router_v2_quality_tiers (
  model_id TEXT PRIMARY KEY,
  tier TEXT NOT NULL CHECK (tier IN ('flagship', 'advanced', 'standard', 'economy')),
  benchmark_score REAL,
  notes TEXT,
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS router_v2_decisions (
  id TEXT PRIMARY KEY,
  project_path TEXT NOT NULL,
  task_id TEXT,
  role TEXT NOT NULL CHECK (role IN ('developer', 'reviewer', 'head', 'devops', 'research')),
  policy_preset TEXT NOT NULL,
  quota_policy TEXT NOT NULL,
  autonomy_mode TEXT NOT NULL,
  selected_harness_id TEXT NOT NULL,
  selected_model_id TEXT NOT NULL,
  selected_account_id TEXT,
  selected_mode TEXT NOT NULL,
  decision_type TEXT NOT NULL CHECK (decision_type IN ('automatic', 'manual-override', 'fallback')),
  plan_digest TEXT,
  evaluation_json TEXT NOT NULL,
  actual_attribution_json TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_router_v2_decisions_project ON router_v2_decisions (project_path, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_router_v2_decisions_task ON router_v2_decisions (task_id);

CREATE TABLE IF NOT EXISTS router_v2_quota_sources (
  id TEXT PRIMARY KEY,
  provider TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('trusted_adapter', 'official_api', 'usage_observation', 'owner_budget', 'persisted_consumption')),
  enabled INTEGER NOT NULL DEFAULT 1,
  config_json TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);
