-- FO-014B AI Employee Professional Profiles & Role Catalog Integration.
--
-- Distinct persistent entity for an employee's professional specialization,
-- adapted markdown instructions, and append-only revision history.
--
-- ai_employees retains their organizational identity (kind, name, project,
-- assignments, run history). Their professional specialization and prompt
-- are tracked here without altering their identity, runtime permissions,
-- or assignments.
--
-- ai_employee_professional_profiles tracks the current active specialization.
-- ai_employee_profile_revisions tracks the immutable history of all prompt revisions.

CREATE TABLE IF NOT EXISTS ai_employee_professional_profiles (
  employee_id TEXT PRIMARY KEY,
  catalog_role_slug TEXT NOT NULL,
  professional_title TEXT NOT NULL,
  division TEXT NOT NULL,
  current_revision INTEGER NOT NULL DEFAULT 1 CHECK (current_revision >= 1),
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  CHECK (length(trim(catalog_role_slug)) BETWEEN 1 AND 120),
  CHECK (length(trim(professional_title)) BETWEEN 1 AND 120),
  CHECK (length(trim(division)) BETWEEN 1 AND 80)
);

CREATE INDEX IF NOT EXISTS idx_employee_professional_profiles_role
  ON ai_employee_professional_profiles(catalog_role_slug);

CREATE TABLE IF NOT EXISTS ai_employee_profile_revisions (
  id TEXT PRIMARY KEY,
  employee_id TEXT NOT NULL,
  revision INTEGER NOT NULL CHECK (revision >= 1),
  catalog_role_slug TEXT NOT NULL,
  professional_title TEXT NOT NULL,
  division TEXT NOT NULL,
  prompt_markdown TEXT NOT NULL,
  prompt_sha256 TEXT NOT NULL,
  owner_provenance TEXT NOT NULL DEFAULT 'owner' CHECK (owner_provenance IN ('owner', 'system')),
  change_note TEXT,
  created_at INTEGER NOT NULL,
  UNIQUE(employee_id, revision),
  CHECK (length(trim(prompt_markdown)) > 0),
  CHECK (length(prompt_sha256) = 64)
);

CREATE INDEX IF NOT EXISTS idx_employee_profile_revisions_lookup
  ON ai_employee_profile_revisions(employee_id, revision DESC);
