import type { Migration } from "../migrate.ts";

const TARGETS = "'company', 'project', 'employee', 'task', 'proposal', 'execution', 'turn', 'browser-session', 'native-session'";

/**
 * FO-NATIVE-CU01. Widens the activity journal target check so an Owner native
 * session can be recorded. Existing rows are copied. The table stays append-only.
 */
export const nativeComputerJournalMigration: Migration = {
  id: "118_native_computer_journal",
  sql: "SELECT 1;",
  apply(db) {
    const row = db.query<{ sql: string | null }, []>(
      "SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'activity_events'",
    ).get();
    if (!row?.sql) return;
    if (row.sql.includes("'native-session'") && row.sql.includes("'browser-session'")) return;

    db.run(`CREATE TABLE activity_events_v118 (
      sequence_id INTEGER PRIMARY KEY AUTOINCREMENT,
      id TEXT NOT NULL UNIQUE CHECK (length(trim(id)) > 0),
      event_type TEXT NOT NULL CHECK (length(trim(event_type)) > 0),
      schema_version INTEGER NOT NULL DEFAULT 1 CHECK (schema_version >= 1),
      project_path TEXT,
      actor_type TEXT NOT NULL CHECK (actor_type IN ('owner', 'project-manager', 'employee', 'system')),
      actor_id TEXT,
      target_type TEXT NOT NULL CHECK (target_type IN (${TARGETS})),
      target_id TEXT NOT NULL CHECK (length(trim(target_id)) > 0),
      task_id TEXT,
      run_id TEXT,
      execution_id TEXT,
      turn_id TEXT,
      employee_id TEXT,
      idempotency_key TEXT NOT NULL UNIQUE CHECK (length(trim(idempotency_key)) > 0),
      source_event_id TEXT,
      payload_json TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(payload_json) AND json_type(payload_json) = 'object'),
      created_at INTEGER NOT NULL
    )`);
    db.run(`INSERT INTO activity_events_v118 (
      sequence_id, id, event_type, schema_version, project_path, actor_type, actor_id,
      target_type, target_id, task_id, run_id, execution_id, turn_id, employee_id,
      idempotency_key, source_event_id, payload_json, created_at
    ) SELECT
      sequence_id, id, event_type, schema_version, project_path, actor_type, actor_id,
      target_type, target_id, task_id, run_id, execution_id, turn_id, employee_id,
      idempotency_key, source_event_id, payload_json, created_at
    FROM activity_events`);
    const before = db.query<{ n: number }, []>("SELECT COUNT(*) AS n FROM activity_events").get()?.n ?? 0;
    const after = db.query<{ n: number }, []>("SELECT COUNT(*) AS n FROM activity_events_v118").get()?.n ?? -1;
    if (before !== after) throw new Error("activity journal copy mismatch");
    db.run("DROP TABLE activity_events");
    db.run("ALTER TABLE activity_events_v118 RENAME TO activity_events");
    db.run("UPDATE sqlite_sequence SET name = 'activity_events' WHERE name = 'activity_events_v118'");
    for (const statement of [
      "CREATE INDEX IF NOT EXISTS activity_events_project ON activity_events(project_path, sequence_id)",
      "CREATE INDEX IF NOT EXISTS activity_events_actor ON activity_events(actor_type, actor_id, sequence_id)",
      "CREATE INDEX IF NOT EXISTS activity_events_employee ON activity_events(employee_id, sequence_id)",
      "CREATE INDEX IF NOT EXISTS activity_events_task ON activity_events(task_id, sequence_id)",
      "CREATE INDEX IF NOT EXISTS activity_events_type ON activity_events(event_type, sequence_id)",
      "CREATE INDEX IF NOT EXISTS activity_events_created ON activity_events(created_at, sequence_id)",
    ]) db.run(statement);
    db.run(`CREATE TRIGGER IF NOT EXISTS activity_events_no_replace BEFORE INSERT ON activity_events
      WHEN EXISTS (
        SELECT 1 FROM activity_events
        WHERE sequence_id = NEW.sequence_id OR id = NEW.id OR idempotency_key = NEW.idempotency_key
      )
      BEGIN SELECT RAISE(ABORT, 'activity_events is append-only: replacement is prohibited'); END`);
    db.run(`CREATE TRIGGER IF NOT EXISTS activity_events_no_update BEFORE UPDATE ON activity_events
      BEGIN SELECT RAISE(ABORT, 'activity_events is append-only: updates are prohibited'); END`);
    db.run(`CREATE TRIGGER IF NOT EXISTS activity_events_no_delete BEFORE DELETE ON activity_events
      BEGIN SELECT RAISE(ABORT, 'activity_events is append-only: deletes are prohibited'); END`);
  },
};
