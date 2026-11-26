-- FO-011E controlled knowledge inheritance for agent and manager context.
-- Separate from knowledge_context_grants (one-turn owner consent for managers).

ALTER TABLE knowledge_documents ADD COLUMN inherit_to_projects INTEGER NOT NULL DEFAULT 0 CHECK (inherit_to_projects IN (0, 1));

CREATE TABLE IF NOT EXISTS knowledge_inheritance_settings (
  scope_kind TEXT NOT NULL CHECK (scope_kind IN ('company', 'cluster', 'project')),
  scope_id TEXT NOT NULL CHECK (length(scope_id) BETWEEN 1 AND 4096),
  accept_company INTEGER NOT NULL DEFAULT 0 CHECK (accept_company IN (0, 1)),
  accept_cluster INTEGER NOT NULL DEFAULT 0 CHECK (accept_cluster IN (0, 1)),
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (scope_kind, scope_id)
);

ALTER TABLE runs ADD COLUMN knowledge_snapshot TEXT;
