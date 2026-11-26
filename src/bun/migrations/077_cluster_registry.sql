-- FO-011A cluster registry and project membership.
--
-- A cluster is an organizational group of registered projects. Its id is the
-- stable owner key for future knowledge documents (FO-011C) and infrastructure
-- bindings (FO-011D). This migration does not store documents, VPS rows,
-- secrets, or agent assignments.
--
-- Archive keeps the row. A cluster row cannot be removed while a project
-- belongs to it. Removing a registered project removes only that project's
-- membership. Projects, tasks, git paths, and managers are not rewritten.

CREATE TABLE IF NOT EXISTS clusters (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  slug TEXT,
  description TEXT NOT NULL DEFAULT '',
  color TEXT,
  icon TEXT,
  notes_summary TEXT,
  priority INTEGER,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  archived_at INTEGER,
  CHECK (length(trim(name)) BETWEEN 1 AND 120),
  CHECK (slug IS NULL OR (length(slug) BETWEEN 1 AND 64 AND slug = trim(slug))),
  CHECK (priority IS NULL OR (priority >= 0 AND priority <= 1000))
);

-- Display names may repeat. A slug, when the owner sets one, may not.
CREATE UNIQUE INDEX IF NOT EXISTS clusters_slug_unique
  ON clusters(slug) WHERE slug IS NOT NULL;

-- One primary cluster per registered project. project_path is the projects PK.
CREATE TABLE IF NOT EXISTS cluster_project_memberships (
  project_path TEXT PRIMARY KEY,
  cluster_id TEXT NOT NULL,
  assigned_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  FOREIGN KEY (project_path) REFERENCES projects(path) ON DELETE CASCADE,
  FOREIGN KEY (cluster_id) REFERENCES clusters(id) ON DELETE RESTRICT
);

CREATE INDEX IF NOT EXISTS cluster_project_memberships_cluster
  ON cluster_project_memberships(cluster_id);

-- Append-only membership history. No foreign key to projects or clusters:
-- unassign, project removal, and a later empty-cluster delete keep the record.
CREATE TABLE IF NOT EXISTS cluster_membership_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  project_path TEXT NOT NULL,
  from_cluster_id TEXT,
  to_cluster_id TEXT,
  action TEXT NOT NULL CHECK (action IN ('assign', 'move', 'unassign')),
  created_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS cluster_membership_events_to
  ON cluster_membership_events(to_cluster_id, id);

CREATE INDEX IF NOT EXISTS cluster_membership_events_from
  ON cluster_membership_events(from_cluster_id, id);
