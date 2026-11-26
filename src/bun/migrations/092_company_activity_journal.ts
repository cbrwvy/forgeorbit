import type { Migration } from "../migrate.ts";
import m092 from "./092_company_activity_journal.sql" with { type: "text" };

export const companyActivityJournalMigration: Migration = {
  id: "092_company_activity_journal",
  sql: m092,
  apply(db) {
    db.run(`CREATE TRIGGER IF NOT EXISTS activity_events_no_replace BEFORE INSERT ON activity_events
      WHEN EXISTS (
        SELECT 1 FROM activity_events
        WHERE sequence_id = NEW.sequence_id
           OR id = NEW.id
           OR idempotency_key = NEW.idempotency_key
      )
      BEGIN SELECT RAISE(ABORT, 'activity_events is append-only: replacement is prohibited'); END`);
    db.run(`CREATE TRIGGER IF NOT EXISTS activity_events_no_update BEFORE UPDATE ON activity_events
      BEGIN SELECT RAISE(ABORT, 'activity_events is append-only: updates are prohibited'); END`);
    db.run(`CREATE TRIGGER IF NOT EXISTS activity_events_no_delete BEFORE DELETE ON activity_events
      BEGIN SELECT RAISE(ABORT, 'activity_events is append-only: deletes are prohibited'); END`);
  },
};
