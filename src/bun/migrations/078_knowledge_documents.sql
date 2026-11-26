-- FO-011C hierarchical Markdown knowledge.
--
-- SQLite stores the index only. Markdown bytes live under the app data
-- directory, addressed by the document id and revision. This migration does
-- not reference projects, clusters, tasks, or git paths: deleting a note must
-- not delete a project, and moving a project must not move its documents.
-- Owner existence is checked when a note is written.

CREATE TABLE IF NOT EXISTS knowledge_documents (
  id TEXT PRIMARY KEY,
  owner_kind TEXT NOT NULL CHECK (owner_kind IN ('company', 'cluster', 'project')),
  owner_id TEXT NOT NULL CHECK (length(owner_id) BETWEEN 1 AND 4096),
  title TEXT NOT NULL CHECK (length(trim(title)) BETWEEN 1 AND 200),
  description TEXT NOT NULL DEFAULT '' CHECK (length(description) <= 2000),
  category TEXT NOT NULL DEFAULT 'general' CHECK (length(category) BETWEEN 1 AND 40),
  tags_json TEXT NOT NULL DEFAULT '[]',
  sensitive INTEGER NOT NULL DEFAULT 0 CHECK (sensitive IN (0, 1)),
  revision INTEGER NOT NULL CHECK (revision >= 1),
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  archived_at INTEGER,
  content_sha256 TEXT NOT NULL CHECK (length(content_sha256) = 64),
  byte_length INTEGER NOT NULL CHECK (byte_length >= 0 AND byte_length <= 524288)
);

CREATE INDEX IF NOT EXISTS knowledge_documents_owner
  ON knowledge_documents(owner_kind, owner_id, updated_at DESC);

CREATE TABLE IF NOT EXISTS knowledge_revisions (
  document_id TEXT NOT NULL,
  revision INTEGER NOT NULL CHECK (revision >= 1),
  created_at INTEGER NOT NULL,
  byte_length INTEGER NOT NULL CHECK (byte_length >= 0),
  content_sha256 TEXT NOT NULL CHECK (length(content_sha256) = 64),
  PRIMARY KEY (document_id, revision),
  FOREIGN KEY (document_id) REFERENCES knowledge_documents(id) ON DELETE CASCADE
);
