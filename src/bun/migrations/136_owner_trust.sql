-- FO-OWNER-TRUST01. Public Owner-trust records only. Private keys are not stored.

CREATE TABLE IF NOT EXISTS owner_trust_profile (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  data_dir_hash TEXT NOT NULL,
  machine_binding TEXT NOT NULL,
  sealed INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS owner_trust_enrollments (
  id TEXT PRIMARY KEY,
  trust_class TEXT NOT NULL,
  application_identity TEXT NOT NULL,
  public_key_spki TEXT NOT NULL UNIQUE,
  key_protection TEXT NOT NULL,
  authority_state TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  rotated_at INTEGER,
  label TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS owner_trust_challenges (
  id TEXT PRIMARY KEY,
  nonce_hash TEXT NOT NULL UNIQUE,
  nonce TEXT NOT NULL,
  operation_digest TEXT NOT NULL,
  operation_canonical TEXT NOT NULL,
  enrollment_id TEXT NOT NULL,
  expires_at INTEGER NOT NULL,
  consumed_at INTEGER,
  status TEXT NOT NULL,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS owner_trust_grants (
  id TEXT PRIMARY KEY,
  challenge_id TEXT NOT NULL UNIQUE,
  enrollment_id TEXT NOT NULL,
  operation_digest TEXT NOT NULL,
  operation_canonical TEXT NOT NULL,
  status TEXT NOT NULL,
  expires_at INTEGER NOT NULL,
  consumed_at INTEGER,
  task_id TEXT NOT NULL,
  mission_id TEXT NOT NULL,
  project_path TEXT NOT NULL,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS owner_trust_grant_uses (
  id TEXT PRIMARY KEY,
  grant_id TEXT NOT NULL,
  task_id TEXT NOT NULL,
  role TEXT NOT NULL,
  run_id TEXT NOT NULL,
  operation_digest TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  UNIQUE (grant_id, task_id, role, run_id)
);

CREATE TABLE IF NOT EXISTS owner_trust_decisions (
  id TEXT PRIMARY KEY,
  challenge_id TEXT,
  grant_id TEXT,
  enrollment_id TEXT,
  operation_digest TEXT NOT NULL,
  code TEXT NOT NULL,
  decision TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
