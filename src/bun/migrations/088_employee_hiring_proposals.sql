-- FO-014C AI Project Team Builder & Hiring Proposals.
--
-- Distinct persistent entity for Project Manager team recommendations
-- and Owner hiring decisions from the Agency Agents role catalog.
--
-- A proposal is NOT an employee and does NOT modify `ai_employees` or
-- `ai_employee_professional_profiles` until explicitly approved by the owner.
-- It grants no execution permissions, starts no runs, assigns no tasks, and
-- switches no harnesses.

CREATE TABLE IF NOT EXISTS hiring_proposals (
  id TEXT PRIMARY KEY,
  project_path TEXT NOT NULL,
  proposed_name TEXT NOT NULL,
  kind TEXT NOT NULL DEFAULT 'worker' CHECK (kind = 'worker'),
  professional_title TEXT NOT NULL,
  catalog_role_slug TEXT NOT NULL,
  template_sha256 TEXT NOT NULL,
  prompt_markdown TEXT NOT NULL,
  justification TEXT NOT NULL,
  competencies TEXT NOT NULL DEFAULT '[]',
  related_tasks TEXT NOT NULL DEFAULT '[]',
  proposed_by_kind TEXT NOT NULL CHECK (proposed_by_kind IN ('owner', 'project-manager')),
  proposed_by_employee_id TEXT,
  source_message_id TEXT,
  status TEXT NOT NULL CHECK (status IN ('pending', 'approved', 'rejected', 'withdrawn', 'stale')),
  revision INTEGER NOT NULL DEFAULT 1 CHECK (revision >= 1),
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  decided_at INTEGER,
  decided_from_revision INTEGER,
  decision_note TEXT,
  stale_reason TEXT,
  created_employee_id TEXT,
  CHECK (length(trim(proposed_name)) BETWEEN 1 AND 120),
  CHECK (length(trim(professional_title)) BETWEEN 1 AND 120),
  CHECK (length(trim(catalog_role_slug)) BETWEEN 1 AND 120),
  CHECK (length(template_sha256) = 64),
  CHECK (length(trim(prompt_markdown)) > 0),
  CHECK (length(trim(justification)) BETWEEN 1 AND 2000),
  CHECK ((status = 'pending') = (decided_at IS NULL)),
  CHECK ((status = 'approved') = (created_employee_id IS NOT NULL)),
  CHECK ((status = 'stale') = (stale_reason IS NOT NULL))
);

CREATE INDEX IF NOT EXISTS idx_hiring_proposals_project
  ON hiring_proposals(project_path, status, created_at);

CREATE INDEX IF NOT EXISTS idx_hiring_proposals_role
  ON hiring_proposals(catalog_role_slug, status);

CREATE INDEX IF NOT EXISTS idx_hiring_proposals_created_employee
  ON hiring_proposals(created_employee_id);

CREATE TABLE IF NOT EXISTS hiring_proposal_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  proposal_id TEXT NOT NULL,
  project_path TEXT NOT NULL,
  action TEXT NOT NULL CHECK (action IN ('created', 'approved', 'rejected', 'withdrawn', 'stale', 'updated')),
  actor TEXT NOT NULL CHECK (actor IN ('owner', 'project-manager', 'system')),
  proposal_revision INTEGER NOT NULL CHECK (proposal_revision >= 1),
  created_employee_id TEXT,
  note TEXT,
  created_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_hiring_proposal_events_proposal
  ON hiring_proposal_events(proposal_id, id);

CREATE INDEX IF NOT EXISTS idx_hiring_proposal_events_project
  ON hiring_proposal_events(project_path, id);
