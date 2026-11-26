-- FO-011E one-turn permission to hand knowledge notes to an AI manager.
--
-- A grant is created only after the owner confirmed an exact list of notes
-- (id, revision, content hash) for one manager. It is consumed by exactly
-- one manager turn and then stays as an audit record. This table stores
-- metadata only: never Markdown, never a file path. It has no foreign keys,
-- so deleting a note, a project, or a cluster keeps the audit trail.
--
-- The grant id is the capability. It is 64 random hex characters, is never
-- listed again after it is returned, and an `approved` row that survives an
-- app restart is expired at boot.

CREATE TABLE IF NOT EXISTS knowledge_context_grants (
  id TEXT PRIMARY KEY CHECK (length(id) = 64),
  manager_kind TEXT NOT NULL CHECK (manager_kind IN ('project', 'portfolio')),
  project_path TEXT,
  status TEXT NOT NULL CHECK (status IN ('approved', 'consumed', 'revoked', 'expired', 'rejected')),
  preview_key TEXT NOT NULL,
  items_json TEXT NOT NULL,
  total_bytes INTEGER NOT NULL CHECK (total_bytes >= 0),
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  settled_at INTEGER,
  message_id TEXT,
  detail TEXT,
  CHECK ((manager_kind = 'project') = (project_path IS NOT NULL))
);

CREATE INDEX IF NOT EXISTS knowledge_context_grants_target
  ON knowledge_context_grants(manager_kind, project_path, created_at DESC);
