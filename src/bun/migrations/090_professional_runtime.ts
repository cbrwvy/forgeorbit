import type { Migration } from "../migrate.ts";
import sql from "./090_professional_runtime.sql" with { type: "text" };

/** Trigger bodies must be sent as complete statements, outside the SQL splitter. */
export const professionalRuntimeMigration: Migration = {
  id: "090_professional_runtime", sql,
  apply(db) {
    db.run(`CREATE TRIGGER employee_professional_no_replace BEFORE INSERT ON employee_executions
      WHEN EXISTS (SELECT 1 FROM employee_executions WHERE id = NEW.id AND professional_json IS NOT NULL)
      BEGIN SELECT RAISE(ABORT, 'employee professional snapshot is immutable'); END`);
    db.run(`CREATE TRIGGER employee_professional_no_delete BEFORE DELETE ON employee_executions
      WHEN OLD.professional_json IS NOT NULL
      BEGIN SELECT RAISE(ABORT, 'employee professional snapshot is immutable'); END`);
    db.run(`CREATE TRIGGER employee_professional_snapshot_immutable
BEFORE UPDATE OF professional_json, employee_id, task_id ON employee_executions
WHEN NEW.professional_json IS NOT OLD.professional_json
  OR NEW.employee_id IS NOT OLD.employee_id OR NEW.task_id IS NOT OLD.task_id
BEGIN SELECT RAISE(ABORT, 'employee professional snapshot is immutable'); END;`);
    db.run(`CREATE TRIGGER employee_professional_payload_immutable
BEFORE UPDATE OF professional_payload_status, professional_payload_at, professional_payload_sha256, run_id ON employee_executions
WHEN (OLD.professional_payload_status IN ('included', 'failed') AND (
    NEW.professional_payload_status IS NOT OLD.professional_payload_status
    OR NEW.professional_payload_at IS NOT OLD.professional_payload_at
    OR NEW.professional_payload_sha256 IS NOT OLD.professional_payload_sha256))
  OR (OLD.professional_payload_sha256 IS NOT NULL AND NEW.professional_payload_sha256 IS NOT OLD.professional_payload_sha256)
  OR (OLD.run_id IS NOT NULL AND NEW.run_id IS NOT OLD.run_id)
BEGIN SELECT RAISE(ABORT, 'employee professional payload attribution is immutable'); END;`);
  },
};
