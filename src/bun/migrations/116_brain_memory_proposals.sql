-- FO-BRAIN03 owner-approved memory proposals.
--
-- A row is a suggestion from Head of PM or a Project Manager.
-- It is not a Brain memory. Approval creates one memory through the Brain
-- store and stores that memory id here. Boot clears an in-flight claim and
-- does not approve anything.

CREATE TABLE IF NOT EXISTS brain_memory_proposals (
  id TEXT PRIMARY KEY,
  status TEXT NOT NULL CHECK (status IN ('pending', 'approved', 'rejected', 'invalidated')),
  revision INTEGER NOT NULL CHECK (revision >= 1),
  manager_kind TEXT NOT NULL CHECK (manager_kind IN ('project-manager', 'head-of-pm')),
  source_project_path TEXT,
  conversation_key TEXT NOT NULL,
  turn_id TEXT NOT NULL,
  message_id TEXT NOT NULL,
  scope_kind TEXT NOT NULL CHECK (scope_kind IN ('company', 'project')),
  scope_id TEXT NOT NULL,
  company_scope_allowed INTEGER NOT NULL CHECK (company_scope_allowed IN (0, 1)),
  claim TEXT NOT NULL CHECK (claim IN ('owner-stated', 'observation', 'hypothesis')),
  source_ref TEXT NOT NULL,
  original_title TEXT NOT NULL,
  original_kind TEXT NOT NULL,
  original_content TEXT NOT NULL,
  original_fingerprint TEXT NOT NULL,
  title TEXT NOT NULL,
  kind TEXT NOT NULL,
  content TEXT NOT NULL,
  content_fingerprint TEXT NOT NULL,
  edited_by_owner INTEGER NOT NULL CHECK (edited_by_owner IN (0, 1)),
  decision TEXT,
  decision_reason TEXT,
  decided_at INTEGER,
  memory_id TEXT,
  approval_request_id TEXT NOT NULL UNIQUE,
  approval_claim TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  CHECK ((manager_kind = 'project-manager') = (source_project_path IS NOT NULL)),
  CHECK (scope_kind != 'project' OR scope_id = source_project_path OR manager_kind = 'head-of-pm')
);

CREATE UNIQUE INDEX IF NOT EXISTS brain_memory_proposals_turn_fingerprint
  ON brain_memory_proposals(turn_id, original_fingerprint);

CREATE INDEX IF NOT EXISTS brain_memory_proposals_status
  ON brain_memory_proposals(status, created_at DESC);

CREATE INDEX IF NOT EXISTS brain_memory_proposals_message
  ON brain_memory_proposals(message_id, created_at ASC);

CREATE TABLE IF NOT EXISTS brain_memory_proposal_events (
  id TEXT PRIMARY KEY,
  proposal_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  revision INTEGER NOT NULL,
  detail TEXT NOT NULL,
  created_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS brain_memory_proposal_events_proposal
  ON brain_memory_proposal_events(proposal_id, created_at ASC);
