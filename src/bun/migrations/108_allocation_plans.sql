-- FO-ROUTING03: Owner-reviewable resource allocation plans (no execution grants).

CREATE TABLE allocation_plans (
  id            TEXT PRIMARY KEY,
  scope_kind    TEXT NOT NULL CHECK (scope_kind IN ('project-manager', 'head-initiative')),
  scope_ref     TEXT NOT NULL,
  status        TEXT NOT NULL CHECK (status IN ('proposed', 'approved', 'applied', 'partial', 'invalidated')),
  revision      INTEGER NOT NULL,
  plan_digest   TEXT NOT NULL,
  approved_digest TEXT,
  data_json     TEXT NOT NULL,
  created_at    INTEGER NOT NULL,
  updated_at    INTEGER NOT NULL
);

CREATE INDEX idx_allocation_plans_scope ON allocation_plans (scope_kind, scope_ref, updated_at DESC);
CREATE INDEX idx_allocation_plans_status ON allocation_plans (status, updated_at DESC);
