-- FO-AUTO-PRACTICAL01: one observed test attempt per task, command, source, and rework epoch.
-- A running row that is still open at restart is marked interrupted and is not a pass.

CREATE TABLE practical_test_attempts (
  id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL,
  project_path TEXT NOT NULL,
  workspace_path TEXT NOT NULL,
  mission_id TEXT,
  rework_epoch INTEGER NOT NULL,
  command TEXT NOT NULL,
  command_fingerprint TEXT NOT NULL,
  source_fingerprint TEXT NOT NULL,
  evidence_digest TEXT,
  status TEXT NOT NULL CHECK (status IN ('running', 'passed', 'failed', 'blocked', 'interrupted')),
  exit_code INTEGER,
  summary TEXT,
  failure_kind TEXT,
  policy_id TEXT,
  policy_revision INTEGER,
  isolation TEXT NOT NULL,
  isolation_reason TEXT,
  provider TEXT,
  model TEXT,
  account_id TEXT,
  instruction_sha TEXT,
  complexity TEXT,
  execution_mode TEXT,
  implementation_execution TEXT NOT NULL,
  started_at INTEGER NOT NULL,
  finished_at INTEGER
);

CREATE UNIQUE INDEX practical_test_attempt_identity
  ON practical_test_attempts (task_id, command_fingerprint, source_fingerprint, rework_epoch)
  WHERE status IN ('running', 'passed', 'failed', 'blocked');

CREATE INDEX practical_test_attempt_task ON practical_test_attempts (task_id, started_at DESC);

CREATE TABLE practical_rework_briefs (
  task_id TEXT PRIMARY KEY,
  epoch INTEGER NOT NULL,
  kind TEXT NOT NULL,
  brief TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
