-- Project permission rules and requests for one bounded local action
-- (run_project_test). Rules are Owner-written and revocable. `ask` is the
-- absence of a rule. A request is the record of one ask; an Owner "allow once"
-- is consumed by flipping pending -> running in a single guarded UPDATE.
CREATE TABLE project_permission_rules (
  id TEXT PRIMARY KEY,
  project_path TEXT NOT NULL,
  action TEXT NOT NULL CHECK (action IN ('run_project_test')),
  mode TEXT NOT NULL CHECK (mode IN ('deny', 'allow')),
  command TEXT,
  created_at INTEGER NOT NULL,
  revoked_at INTEGER,
  CHECK (mode = 'deny' OR command IS NOT NULL)
);
CREATE INDEX project_permission_rules_project ON project_permission_rules(project_path, action, revoked_at);

CREATE TABLE project_permission_requests (
  id TEXT PRIMARY KEY,
  project_path TEXT NOT NULL,
  task_id TEXT NOT NULL,
  action TEXT NOT NULL CHECK (action IN ('run_project_test')),
  command TEXT NOT NULL,
  argv_json TEXT NOT NULL,
  cwd TEXT NOT NULL,
  source_fingerprint TEXT NOT NULL,
  command_fingerprint TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('pending','running','completed','failed','denied','cancelled','expired','blocked','interrupted')),
  authority TEXT CHECK (authority IN ('owner-once', 'project-rule')),
  rule_id TEXT,
  reason TEXT,
  exit_code INTEGER,
  summary TEXT,
  isolation TEXT,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  decided_at INTEGER,
  started_at INTEGER,
  finished_at INTEGER
);
CREATE INDEX project_permission_requests_status ON project_permission_requests(status, created_at);
CREATE INDEX project_permission_requests_task ON project_permission_requests(task_id, created_at);
