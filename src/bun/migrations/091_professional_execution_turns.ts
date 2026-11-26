import type { Migration } from "../migrate.ts";

export const professionalTurnsMigration: Migration = {
  id: "091_professional_execution_turns",
  sql: `ALTER TABLE employee_executions ADD COLUMN professional_snapshot_sha256 TEXT;
  CREATE TABLE employee_execution_turns (
    id TEXT PRIMARY KEY,
    run_id TEXT NOT NULL,
    task_id TEXT NOT NULL,
    employee_id TEXT NOT NULL,
    attempt_id TEXT NOT NULL REFERENCES employee_executions(id),
    snapshot_revision_id TEXT NOT NULL,
    snapshot_sha256 TEXT NOT NULL CHECK(length(snapshot_sha256) = 64),
    turn_number INTEGER NOT NULL CHECK(turn_number >= 1),
    parent_turn_id TEXT REFERENCES employee_execution_turns(id),
    session_id TEXT,
    authorization_ref TEXT,
    prompt TEXT,
    prompt_sha256 TEXT NOT NULL CHECK(length(prompt_sha256) = 64),
    facts_json TEXT NOT NULL,
    status TEXT NOT NULL CHECK(status IN ('reviewed','approved','claimed','prepared','included','failed','indeterminate')),
    revision INTEGER NOT NULL DEFAULT 1,
    idempotency_key TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    expires_at INTEGER NOT NULL,
    approved_at INTEGER,
    submitted_at INTEGER,
    settled_at INTEGER,
    reason TEXT,
    observed_run_status TEXT,
    observed_run_ended_at INTEGER,
    UNIQUE(run_id, turn_number),
    UNIQUE(run_id, idempotency_key)
  );
  CREATE UNIQUE INDEX employee_turn_one_open ON employee_execution_turns(run_id)
    WHERE status IN ('reviewed','approved','claimed','prepared','indeterminate');`,
  apply(db) {
    db.run(`CREATE TRIGGER employee_turn_snapshot_hash BEFORE UPDATE OF professional_snapshot_sha256 ON employee_executions
      WHEN OLD.professional_snapshot_sha256 IS NOT NULL AND NEW.professional_snapshot_sha256 IS NOT OLD.professional_snapshot_sha256
      BEGIN SELECT RAISE(ABORT, 'professional snapshot hash is immutable'); END`);
    db.run(`CREATE TRIGGER employee_turn_correlation BEFORE INSERT ON employee_execution_turns
      WHEN NOT EXISTS(SELECT 1 FROM employee_executions e JOIN runs r ON r.id = e.run_id AND r.task_id = e.task_id WHERE e.id = NEW.attempt_id
        AND e.run_id = NEW.run_id AND e.task_id = NEW.task_id AND e.employee_id = NEW.employee_id
        AND e.approval_provenance = 'owner' AND e.approved_at IS NOT NULL
        AND json_extract(e.professional_json, '$.kind') = 'professional'
        AND json_extract(e.professional_json, '$.revisionId') = NEW.snapshot_revision_id
        AND e.professional_snapshot_sha256 = NEW.snapshot_sha256)
        OR (NEW.turn_number = 1 AND NEW.parent_turn_id IS NOT NULL)
        OR (NEW.turn_number > 1 AND NOT EXISTS(SELECT 1 FROM employee_execution_turns p
          WHERE p.id = NEW.parent_turn_id AND p.run_id = NEW.run_id AND p.turn_number = NEW.turn_number - 1))
      BEGIN SELECT RAISE(ABORT, 'professional turn correlation mismatch'); END`);
    db.run(`CREATE TRIGGER employee_turn_no_replace BEFORE INSERT ON employee_execution_turns
      WHEN EXISTS(SELECT 1 FROM employee_execution_turns WHERE id = NEW.id OR (run_id = NEW.run_id AND
        (turn_number = NEW.turn_number OR idempotency_key = NEW.idempotency_key)))
      BEGIN SELECT RAISE(ABORT, 'professional turn is immutable'); END`);
    db.run(`CREATE TRIGGER employee_turn_no_delete BEFORE DELETE ON employee_execution_turns
      BEGIN SELECT RAISE(ABORT, 'professional turn is immutable'); END`);
    db.run(`CREATE TRIGGER employee_turn_identity BEFORE UPDATE ON employee_execution_turns
      WHEN NEW.id IS NOT OLD.id OR NEW.run_id IS NOT OLD.run_id OR NEW.task_id IS NOT OLD.task_id
        OR NEW.employee_id IS NOT OLD.employee_id OR NEW.attempt_id IS NOT OLD.attempt_id
        OR NEW.snapshot_revision_id IS NOT OLD.snapshot_revision_id OR NEW.snapshot_sha256 IS NOT OLD.snapshot_sha256
        OR NEW.turn_number IS NOT OLD.turn_number OR NEW.parent_turn_id IS NOT OLD.parent_turn_id
        OR NEW.prompt IS NOT OLD.prompt OR NEW.prompt_sha256 IS NOT OLD.prompt_sha256
        OR NEW.facts_json IS NOT OLD.facts_json OR NEW.idempotency_key IS NOT OLD.idempotency_key
        OR NEW.created_at IS NOT OLD.created_at OR NEW.expires_at IS NOT OLD.expires_at
        OR (OLD.session_id IS NOT NULL AND NEW.session_id IS NOT OLD.session_id)
        OR (OLD.authorization_ref IS NOT NULL AND NEW.authorization_ref IS NOT OLD.authorization_ref)
        OR (OLD.approved_at IS NOT NULL AND NEW.approved_at IS NOT OLD.approved_at)
        OR (OLD.submitted_at IS NOT NULL AND NEW.submitted_at IS NOT OLD.submitted_at)
        OR (OLD.observed_run_status IS NOT NULL AND (NEW.observed_run_status IS NOT OLD.observed_run_status
          OR NEW.observed_run_ended_at IS NOT OLD.observed_run_ended_at))
        OR (OLD.status IN ('included','failed','indeterminate') AND
          (NEW.status IS NOT OLD.status OR NEW.settled_at IS NOT OLD.settled_at OR NEW.reason IS NOT OLD.reason
            OR (NEW.session_id IS NOT OLD.session_id AND NOT (OLD.turn_number = 1 AND OLD.session_id IS NULL AND NEW.session_id IS NOT NULL))
            OR NEW.authorization_ref IS NOT OLD.authorization_ref
            OR NEW.approved_at IS NOT OLD.approved_at OR NEW.submitted_at IS NOT OLD.submitted_at OR NEW.revision IS NOT OLD.revision))
      BEGIN SELECT RAISE(ABORT, 'professional turn is immutable'); END`);
    db.run(`CREATE TRIGGER employee_turn_transition BEFORE UPDATE OF status ON employee_execution_turns
      WHEN NEW.status IS NOT OLD.status AND NOT (
        (OLD.status = 'reviewed' AND NEW.status IN ('approved','failed')) OR
        (OLD.status = 'approved' AND NEW.status IN ('claimed','failed')) OR
        (OLD.status = 'claimed' AND NEW.status IN ('prepared','failed')) OR
        (OLD.status = 'prepared' AND NEW.status IN ('included','indeterminate')))
      BEGIN SELECT RAISE(ABORT, 'invalid professional turn transition'); END`);
  },
};
