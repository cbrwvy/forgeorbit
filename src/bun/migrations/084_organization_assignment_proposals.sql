-- FO-010D organizational assignment proposals.
--
-- A proposal says "this worker could take this task". It is a separate record
-- from employee_task_assignments (FO-010C): it is not an assignment, it grants
-- no permission to run anything, and it never touches the assignment tables
-- until the owner approves it through the existing assignment core. Migration
-- 083 is reserved for FO-009F and is intentionally absent here.
--
-- task_id, employee_id, project_path and delegation_id are soft references,
-- same as employee_task_assignments: deleting a task, archiving an employee or
-- removing a project must not rewrite or cascade into this history.
--
-- proposed_by_kind records who wrote the proposal. A model's output is only
-- ever stored as 'project-manager' after server-side validation; it never
-- carries owner authority. delegation_id is set when the project manager
-- turn that produced the proposal answered a portfolio-manager delegation the
-- owner had approved, so the head's recommendation stays traceable.
--
-- base_assignee_id / base_assignment_revision describe the active assignment
-- (if any) the owner was shown when the proposal was written. A different
-- active assignment later makes the proposal stale; it is never replaced
-- silently. revision counts status changes of the proposal itself.

CREATE TABLE IF NOT EXISTS assignment_proposals (
  id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL,
  project_path TEXT NOT NULL,
  employee_id TEXT NOT NULL,
  proposed_by_kind TEXT NOT NULL CHECK (proposed_by_kind IN ('owner', 'project-manager')),
  proposed_by_employee_id TEXT,
  delegation_id TEXT,
  source_message_id TEXT,
  rationale TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('pending', 'approved', 'rejected', 'stale', 'cancelled')),
  revision INTEGER NOT NULL CHECK (revision >= 1),
  base_assignee_id TEXT,
  base_assignment_revision INTEGER,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  decided_at INTEGER,
  decided_from_revision INTEGER,
  decision_reassign INTEGER,
  stale_reason TEXT,
  assignment_id TEXT,
  result_assignment_revision INTEGER,
  CHECK (length(trim(rationale)) BETWEEN 1 AND 600),
  CHECK ((base_assignee_id IS NULL) = (base_assignment_revision IS NULL)),
  CHECK ((status = 'pending') = (decided_at IS NULL)),
  CHECK ((status = 'approved') = (assignment_id IS NOT NULL)),
  CHECK ((status = 'stale') = (stale_reason IS NOT NULL))
);

-- One open proposal per task. Decided ones stay as history.
CREATE UNIQUE INDEX IF NOT EXISTS assignment_proposals_one_pending
  ON assignment_proposals(task_id) WHERE status = 'pending';

CREATE INDEX IF NOT EXISTS assignment_proposals_project
  ON assignment_proposals(project_path, status, created_at);

CREATE INDEX IF NOT EXISTS assignment_proposals_employee
  ON assignment_proposals(employee_id, status);

CREATE INDEX IF NOT EXISTS assignment_proposals_task
  ON assignment_proposals(task_id, created_at);

-- Append-only audit trail. Application code inserts rows and never updates or
-- deletes them (the migration runner cannot split trigger bodies, so this is
-- enforced in code and by test, like employee_task_assignment_events). `note` is a short fixed-vocabulary or owner-visible reason,
-- never model output beyond the stored rationale.
CREATE TABLE IF NOT EXISTS assignment_proposal_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  proposal_id TEXT NOT NULL,
  task_id TEXT NOT NULL,
  project_path TEXT NOT NULL,
  employee_id TEXT NOT NULL,
  action TEXT NOT NULL CHECK (action IN ('created', 'approved', 'rejected', 'cancelled', 'stale')),
  actor TEXT NOT NULL CHECK (actor IN ('owner', 'project-manager', 'system')),
  proposal_revision INTEGER NOT NULL CHECK (proposal_revision >= 1),
  reassign INTEGER,
  assignment_id TEXT,
  assignment_revision INTEGER,
  note TEXT,
  created_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS assignment_proposal_events_proposal
  ON assignment_proposal_events(proposal_id, id);

CREATE INDEX IF NOT EXISTS assignment_proposal_events_project
  ON assignment_proposal_events(project_path, id);
