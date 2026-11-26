-- Owner-defined project rules (one project_path namespace).

CREATE TABLE project_rules (
  id TEXT PRIMARY KEY,
  project_path TEXT NOT NULL,
  name TEXT NOT NULL,
  body TEXT NOT NULL,
  enabled INTEGER NOT NULL DEFAULT 1,
  sort_order INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE INDEX idx_project_rules_path ON project_rules (project_path, sort_order, name);

ALTER TABLE runs ADD COLUMN project_rules_snapshot TEXT;
