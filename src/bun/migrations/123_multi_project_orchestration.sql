-- FO-ORCH-SCALE01: Scalable Multi-Project Orchestration

CREATE TABLE IF NOT EXISTS orchestration_missions (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  goal TEXT NOT NULL,
  initiative_id TEXT,
  status TEXT NOT NULL CHECK (status IN ('draft', 'planned', 'authorized', 'running', 'paused', 'completed', 'failed', 'cancelled')),
  revision INTEGER NOT NULL DEFAULT 1,
  clusters_json TEXT NOT NULL,
  projects_json TEXT NOT NULL,
  plan_json TEXT NOT NULL,
  plan_digest TEXT NOT NULL,
  authorization_json TEXT,
  concurrency_limits_json TEXT NOT NULL,
  state_json TEXT NOT NULL DEFAULT '{}',
  history_json TEXT NOT NULL DEFAULT '[]',
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_orch_missions_status ON orchestration_missions (status, updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_orch_missions_initiative ON orchestration_missions (initiative_id);

CREATE TABLE IF NOT EXISTS orchestration_task_dependencies (
  id TEXT PRIMARY KEY,
  mission_id TEXT NOT NULL REFERENCES orchestration_missions(id) ON DELETE CASCADE,
  task_id TEXT NOT NULL,
  project_path TEXT NOT NULL,
  depends_on_task_id TEXT NOT NULL,
  depends_on_project_path TEXT NOT NULL,
  condition TEXT NOT NULL CHECK (condition IN ('qc_pass', 'done', 'awaiting_owner')),
  satisfied_at INTEGER,
  created_at INTEGER NOT NULL,
  UNIQUE (mission_id, task_id, depends_on_task_id)
);

CREATE INDEX IF NOT EXISTS idx_orch_deps_mission ON orchestration_task_dependencies (mission_id);
CREATE INDEX IF NOT EXISTS idx_orch_deps_task ON orchestration_task_dependencies (task_id);
CREATE INDEX IF NOT EXISTS idx_orch_deps_target ON orchestration_task_dependencies (depends_on_task_id);

CREATE TABLE IF NOT EXISTS orchestration_reservations (
  id TEXT PRIMARY KEY,
  mission_id TEXT NOT NULL REFERENCES orchestration_missions(id) ON DELETE CASCADE,
  task_id TEXT NOT NULL,
  project_path TEXT NOT NULL,
  employee_id TEXT NOT NULL,
  account_id TEXT,
  harness_id TEXT NOT NULL,
  model_id TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('reserved', 'starting', 'running', 'awaiting_qc', 'qc_running', 'released', 'failed', 'cancelled')),
  run_id TEXT,
  qc_review_id TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  UNIQUE (task_id)
);

CREATE INDEX IF NOT EXISTS idx_orch_res_mission ON orchestration_reservations (mission_id);
CREATE INDEX IF NOT EXISTS idx_orch_res_status ON orchestration_reservations (status);
CREATE INDEX IF NOT EXISTS idx_orch_res_project ON orchestration_reservations (project_path);
CREATE INDEX IF NOT EXISTS idx_orch_res_account ON orchestration_reservations (account_id);
