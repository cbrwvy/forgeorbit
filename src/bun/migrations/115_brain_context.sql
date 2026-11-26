-- FO-BRAIN02-B one-turn permission to hand Brain memories to a manager.
--
-- A grant exists only after the owner confirmed an exact list of memories
-- (id, revision, content hash) for one manager, one scope, and one message.
-- The row stores metadata. It does not copy Markdown. It has no foreign keys,
-- so archiving a memory or removing a project keeps the audit trail.
--
-- The grant id is the capability. It is 64 random hex characters. An
-- `approved` row that survives an app restart is expired at boot and is
-- never launched.

CREATE TABLE IF NOT EXISTS brain_context_grants (
  id TEXT PRIMARY KEY CHECK (length(id) = 64),
  manager_kind TEXT NOT NULL CHECK (manager_kind IN ('project', 'portfolio')),
  project_path TEXT,
  scope_mode TEXT NOT NULL CHECK (scope_mode IN ('company', 'project', 'project-company', 'projects')),
  inherit_company INTEGER NOT NULL CHECK (inherit_company IN (0, 1)),
  project_scopes_json TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('approved', 'consumed', 'revoked', 'expired', 'rejected')),
  preview_key TEXT NOT NULL,
  digest TEXT NOT NULL CHECK (length(digest) = 64),
  items_json TEXT NOT NULL,
  total_chars INTEGER NOT NULL CHECK (total_chars >= 0),
  approved_by TEXT NOT NULL CHECK (approved_by = 'owner'),
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  settled_at INTEGER,
  message_id TEXT,
  turn_id TEXT,
  used INTEGER NOT NULL DEFAULT 0 CHECK (used IN (0, 1)),
  detail TEXT,
  CHECK ((manager_kind = 'project') = (project_path IS NOT NULL))
);

CREATE INDEX IF NOT EXISTS brain_context_grants_target
  ON brain_context_grants(manager_kind, project_path, created_at DESC);
