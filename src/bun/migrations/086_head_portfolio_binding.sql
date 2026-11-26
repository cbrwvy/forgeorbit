-- Organizational binding only. No runtime/config/account is created or copied.
CREATE TABLE head_portfolio_binding (
  id TEXT PRIMARY KEY CHECK (id = 'global'),
  employee_id TEXT,
  job_title TEXT,
  role_category TEXT,
  employee_event_id INTEGER NOT NULL DEFAULT 0,
  revision INTEGER NOT NULL CHECK (revision >= 0),
  updated_at INTEGER NOT NULL
);
INSERT INTO head_portfolio_binding (id, revision, updated_at) VALUES ('global', 0, 0);
CREATE TABLE head_portfolio_binding_events (
  revision INTEGER PRIMARY KEY,
  from_employee_id TEXT,
  to_employee_id TEXT,
  actor TEXT NOT NULL CHECK (actor = 'owner'),
  created_at INTEGER NOT NULL
);
-- Immutable attribution of each NEW invocation, including retries. Soft refs
-- retain history when employees are archived or projects leave the registry.
CREATE TABLE portfolio_manager_turn_attributions (
  turn_id TEXT PRIMARY KEY,
  message_id TEXT NOT NULL,
  data TEXT NOT NULL,
  requested_runtime TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX portfolio_manager_turn_attributions_message ON portfolio_manager_turn_attributions(message_id);
