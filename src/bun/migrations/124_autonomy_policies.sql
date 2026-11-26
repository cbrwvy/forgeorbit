-- FO-AUTONOMY-FULL01: durable Owner autonomy policies.
-- Activations are insert-only provenance. Later status changes never rewrite the digest.

CREATE TABLE IF NOT EXISTS autonomy_policies (
  id TEXT NOT NULL,
  revision INTEGER NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('draft', 'active', 'paused', 'revoked', 'expired', 'superseded')),
  mode TEXT NOT NULL,
  scope_kind TEXT NOT NULL,
  scope_ref TEXT NOT NULL,
  mission_id TEXT,
  body_json TEXT NOT NULL,
  digest TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (id, revision)
);

CREATE INDEX IF NOT EXISTS idx_autonomy_policies_status ON autonomy_policies (status, updated_at DESC);

CREATE TABLE IF NOT EXISTS autonomy_activations (
  id TEXT PRIMARY KEY,
  policy_id TEXT NOT NULL,
  revision INTEGER NOT NULL,
  digest TEXT NOT NULL,
  activated_by TEXT NOT NULL CHECK (activated_by = 'owner'),
  activated_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('active', 'paused', 'revoked', 'expired')),
  provenance_json TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  UNIQUE (policy_id, revision)
);

CREATE TABLE IF NOT EXISTS autonomy_action_reservations (
  id TEXT PRIMARY KEY,
  activation_id TEXT NOT NULL,
  policy_id TEXT NOT NULL,
  revision INTEGER NOT NULL,
  action TEXT NOT NULL,
  target_key TEXT NOT NULL,
  mission_id TEXT,
  task_id TEXT,
  project_path TEXT,
  status TEXT NOT NULL CHECK (status IN ('reserved', 'consumed', 'released', 'cancelled')),
  outcome_json TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  UNIQUE (activation_id, target_key)
);

CREATE INDEX IF NOT EXISTS idx_autonomy_reservations_activation ON autonomy_action_reservations (activation_id, status);

CREATE TABLE IF NOT EXISTS autonomy_decisions (
  id TEXT PRIMARY KEY,
  activation_id TEXT,
  policy_id TEXT,
  revision INTEGER,
  action TEXT NOT NULL,
  target_json TEXT NOT NULL,
  verdict TEXT NOT NULL CHECK (verdict IN ('allowed', 'denied')),
  reason TEXT NOT NULL,
  mission_id TEXT,
  task_id TEXT,
  created_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_autonomy_decisions_created ON autonomy_decisions (created_at DESC);

CREATE TABLE IF NOT EXISTS autonomy_mission_bindings (
  mission_id TEXT PRIMARY KEY,
  policy_id TEXT NOT NULL,
  revision INTEGER NOT NULL,
  activation_id TEXT NOT NULL,
  digest TEXT NOT NULL,
  mode TEXT NOT NULL,
  outcome TEXT NOT NULL,
  summary_text TEXT,
  emergency_task_ids_json TEXT NOT NULL DEFAULT '[]',
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS autonomy_recovery_journal (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS autonomy_emergency (
  id TEXT PRIMARY KEY CHECK (id = 'global'),
  active INTEGER NOT NULL,
  activated_at INTEGER,
  reason TEXT,
  outstanding_json TEXT NOT NULL DEFAULT '[]'
);
