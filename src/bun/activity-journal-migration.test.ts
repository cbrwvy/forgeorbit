import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const isolated = realpathSync(mkdtempSync(path.join(tmpdir(), "fo015a1-mig-env-")));
process.env.AGETOR_DATA_DIR = isolated;
process.env.HOME = isolated;
process.env.AGETOR_USAGE_OFFLINE = "1";

import { migrate } from "./migrate.ts";
import { migrations } from "./migrations/index.ts";

const index092 = migrations.findIndex((m) => m.id === "092_company_activity_journal");

test("1. Fresh migration applies 092 cleanly and creates activity_events schema", () => {
  const db = new Database(":memory:");
  try {
    const applied = migrate(db, migrations);
    expect(applied).toContain("092_company_activity_journal");

    const tables = db
      .query<{ name: string }, []>(`SELECT name FROM sqlite_master WHERE type='table' AND name = 'activity_events'`)
      .all();
    expect(tables.length).toBe(1);

    const triggers = db
      .query<{ name: string }, []>(
        `SELECT name FROM sqlite_master WHERE type='trigger' AND tbl_name = 'activity_events' ORDER BY name`,
      )
      .all()
      .map((t) => t.name);
    expect(triggers).toEqual([
      "activity_events_no_delete",
      "activity_events_no_replace",
      "activity_events_no_update",
    ]);

    const columns = db
      .query<{ name: string }, []>(`PRAGMA table_info(activity_events)`)
      .all()
      .map((c) => c.name);

    expect(columns).toContain("sequence_id");
    expect(columns).toContain("id");
    expect(columns).toContain("event_type");
    expect(columns).toContain("schema_version");
    expect(columns).toContain("project_path");
    expect(columns).toContain("actor_type");
    expect(columns).toContain("actor_id");
    expect(columns).toContain("target_type");
    expect(columns).toContain("target_id");
    expect(columns).toContain("task_id");
    expect(columns).toContain("run_id");
    expect(columns).toContain("execution_id");
    expect(columns).toContain("turn_id");
    expect(columns).toContain("employee_id");
    expect(columns).toContain("idempotency_key");
    expect(columns).toContain("source_event_id");
    expect(columns).toContain("payload_json");
    expect(columns).toContain("created_at");

    expect(db.query("PRAGMA foreign_key_check").all()).toEqual([]);
  } finally {
    db.close();
  }
});

test("2. Upgrade from 091 to 092 applies only 092 and preserves existing tables", () => {
  const file = path.join(mkdtempSync(path.join(tmpdir(), "fo015a1-upgrade-")), "fixture.sqlite");
  const db = new Database(file);
  try {
    db.exec("PRAGMA journal_mode=WAL");
    const before = migrate(db, migrations.slice(0, index092));
    expect(before).toContain("091_professional_execution_turns");
    expect(before).not.toContain("092_company_activity_journal");

    db.run(
      `INSERT INTO tasks(id, title, prompt, "column", agent, workdir, created_at, updated_at) VALUES('t1', 'Task 1', 'Prompt', 'backlog', 'claude-code', '/tmp/p', 1, 1)`,
    );

    const upgraded = migrate(db, migrations);
    expect(upgraded).toEqual(["092_company_activity_journal", "093_task_dependency_tombstones", "094_task_plan_queues", "095_task_queue_progression"]);

    const task = db.query<{ id: string }, []>("SELECT id FROM tasks WHERE id = 't1'").get();
    expect(task?.id).toBe("t1");

    const rowCount = db.query<{ count: number }, []>("SELECT COUNT(*) as count FROM activity_events").get();
    expect(rowCount?.count).toBe(0);
  } finally {
    db.close();
  }
});

test("3. Reopen and rerun migration is idempotent and no-op", () => {
  const file = path.join(mkdtempSync(path.join(tmpdir(), "fo015a1-reopen-")), "fixture.sqlite");
  let db = new Database(file);
  try {
    db.exec("PRAGMA journal_mode=WAL");
    migrate(db, migrations);

    db.run(
      `INSERT INTO activity_events (id, event_type, actor_type, target_type, target_id, idempotency_key, created_at)
       VALUES ('act-1', 'employee.hired', 'owner', 'employee', 'emp-1', 'idemp-1', 1000)`,
    );

    db.close();

    db = new Database(file);
    const reApplied = migrate(db, migrations);
    expect(reApplied).toEqual([]);

    const event = db.query<{ id: string }, []>("SELECT id FROM activity_events WHERE id = 'act-1'").get();
    expect(event?.id).toBe("act-1");
  } finally {
    db.close();
  }
});

test("4. Append-only constraints: UPDATE and DELETE on activity_events are strictly rejected by triggers", () => {
  const db = new Database(":memory:");
  try {
    migrate(db, migrations);

    db.run(
      `INSERT INTO activity_events (id, event_type, actor_type, target_type, target_id, idempotency_key, created_at)
       VALUES ('act-fixed', 'task.proposal.created', 'project-manager', 'proposal', 'prop-1', 'key-fixed', 2000)`,
    );

    expect(() => {
      db.run(`UPDATE activity_events SET event_type = 'changed' WHERE id = 'act-fixed'`);
    }).toThrow(/activity_events is append-only/i);

    expect(() => {
      db.run(`DELETE FROM activity_events WHERE id = 'act-fixed'`);
    }).toThrow(/activity_events is append-only/i);

    const row = db
      .query<{ event_type: string }, []>("SELECT event_type FROM activity_events WHERE id = 'act-fixed'")
      .get();
    expect(row?.event_type).toBe("task.proposal.created");
  } finally {
    db.close();
  }
});

test("5. [P0-1] SQLite append-only integrity blocks INSERT OR REPLACE, INSERT OR IGNORE, ON CONFLICT DO UPDATE, and conflicting INSERT across id, sequence_id, and idempotency_key with recursive_triggers=OFF", () => {
  const db = new Database(":memory:");
  try {
    db.exec("PRAGMA recursive_triggers = OFF");
    const recOff = db.query<{ recursive_triggers: number }, []>("PRAGMA recursive_triggers").get();
    expect(recOff?.recursive_triggers).toBe(0);

    migrate(db, migrations);

    db.run(
      `INSERT INTO activity_events (id, event_type, actor_type, target_type, target_id, idempotency_key, payload_json, created_at)
       VALUES ('act-1', 'employee.hired', 'owner', 'employee', 'emp-1', 'key-1', '{"employeeId":"emp-1"}', 1000)`,
    );

    // 1. Conflicting INSERT OR REPLACE by id
    expect(() => {
      db.run(
        `INSERT OR REPLACE INTO activity_events (id, event_type, actor_type, target_type, target_id, idempotency_key, created_at)
         VALUES ('act-1', 'FORGED_BY_ID', 'owner', 'employee', 'emp-1', 'key-new-1', 2000)`,
      );
    }).toThrow(/activity_events is append-only: replacement is prohibited/i);

    // 2. Conflicting INSERT OR REPLACE by idempotency_key
    expect(() => {
      db.run(
        `INSERT OR REPLACE INTO activity_events (id, event_type, actor_type, target_type, target_id, idempotency_key, created_at)
         VALUES ('act-new-2', 'FORGED_BY_KEY', 'owner', 'employee', 'emp-1', 'key-1', 3000)`,
      );
    }).toThrow(/activity_events is append-only: replacement is prohibited/i);

    // 3. Conflicting INSERT OR REPLACE by sequence_id
    expect(() => {
      db.run(
        `INSERT OR REPLACE INTO activity_events (sequence_id, id, event_type, actor_type, target_type, target_id, idempotency_key, created_at)
         VALUES (1, 'act-new-3', 'FORGED_BY_SEQ', 'owner', 'employee', 'emp-1', 'key-new-3', 4000)`,
      );
    }).toThrow(/activity_events is append-only: replacement is prohibited/i);

    // 4. Plain conflicting INSERT by id, idempotency_key, and sequence_id
    expect(() => {
      db.run(
        `INSERT INTO activity_events (id, event_type, actor_type, target_type, target_id, idempotency_key, created_at)
         VALUES ('act-1', 'DUP_ID', 'owner', 'employee', 'emp-1', 'key-dup-1', 5000)`,
      );
    }).toThrow(/activity_events is append-only: replacement is prohibited/i);

    expect(() => {
      db.run(
        `INSERT INTO activity_events (id, event_type, actor_type, target_type, target_id, idempotency_key, created_at)
         VALUES ('act-dup-2', 'DUP_KEY', 'owner', 'employee', 'emp-1', 'key-1', 5000)`,
      );
    }).toThrow(/activity_events is append-only: replacement is prohibited/i);

    expect(() => {
      db.run(
        `INSERT INTO activity_events (sequence_id, id, event_type, actor_type, target_type, target_id, idempotency_key, created_at)
         VALUES (1, 'act-dup-3', 'DUP_SEQ', 'owner', 'employee', 'emp-1', 'key-dup-3', 5000)`,
      );
    }).toThrow(/activity_events is append-only: replacement is prohibited/i);

    // 5. Conflicting INSERT OR IGNORE by id, idempotency_key, and sequence_id
    expect(() => {
      db.run(
        `INSERT OR IGNORE INTO activity_events (id, event_type, actor_type, target_type, target_id, idempotency_key, created_at)
         VALUES ('act-1', 'IGNORE_ID', 'owner', 'employee', 'emp-1', 'key-ign-1', 6000)`,
      );
    }).toThrow(/activity_events is append-only: replacement is prohibited/i);

    expect(() => {
      db.run(
        `INSERT OR IGNORE INTO activity_events (id, event_type, actor_type, target_type, target_id, idempotency_key, created_at)
         VALUES ('act-ign-2', 'IGNORE_KEY', 'owner', 'employee', 'emp-1', 'key-1', 6000)`,
      );
    }).toThrow(/activity_events is append-only: replacement is prohibited/i);

    expect(() => {
      db.run(
        `INSERT OR IGNORE INTO activity_events (sequence_id, id, event_type, actor_type, target_type, target_id, idempotency_key, created_at)
         VALUES (1, 'act-ign-3', 'IGNORE_SEQ', 'owner', 'employee', 'emp-1', 'key-ign-3', 6000)`,
      );
    }).toThrow(/activity_events is append-only: replacement is prohibited/i);

    // 6. Conflicting INSERT ... ON CONFLICT DO UPDATE (upsert)
    expect(() => {
      db.run(
        `INSERT INTO activity_events (id, event_type, actor_type, target_type, target_id, idempotency_key, created_at)
         VALUES ('act-1', 'UPSERT_ATTEMPT', 'owner', 'employee', 'emp-1', 'key-1', 7000)
         ON CONFLICT(id) DO UPDATE SET event_type = excluded.event_type`,
      );
    }).toThrow(/activity_events is append-only/i);

    // Verify original record is 100% intact with sequence_id = 1
    const rows = db
      .query<
        {
          sequence_id: number;
          id: string;
          event_type: string;
          idempotency_key: string;
          payload_json: string;
          created_at: number;
        },
        []
      >("SELECT sequence_id, id, event_type, idempotency_key, payload_json, created_at FROM activity_events")
      .all();

    expect(rows).toEqual([
      {
        sequence_id: 1,
        id: "act-1",
        event_type: "employee.hired",
        idempotency_key: "key-1",
        payload_json: '{"employeeId":"emp-1"}',
        created_at: 1000,
      },
    ]);

    // Non-conflicting insert still works after rejected conflicts
    db.run(
      `INSERT INTO activity_events (id, event_type, actor_type, target_type, target_id, idempotency_key, created_at)
       VALUES ('act-2', 'employee.archived', 'owner', 'employee', 'emp-1', 'key-2', 8000)`,
    );
    const total = db.query<{ count: number }, []>("SELECT COUNT(*) as count FROM activity_events").get();
    expect(total?.count).toBe(2);
  } finally {
    db.close();
  }
});

test("6. WAL reopen after transaction rollback preserves committed events and discards rolled-back writes", () => {
  const file = path.join(mkdtempSync(path.join(tmpdir(), "fo015a1-wal-rollback-")), "fixture.sqlite");
  let db = new Database(file);
  try {
    db.exec("PRAGMA journal_mode=WAL");
    migrate(db, migrations);

    db.run(
      `INSERT INTO activity_events (id, event_type, actor_type, target_type, target_id, idempotency_key, created_at)
       VALUES ('act-committed', 'employee.hired', 'owner', 'employee', 'emp-1', 'key-committed', 1000)`,
    );

    expect(() => {
      db.transaction(() => {
        db.run(
          `INSERT INTO activity_events (id, event_type, actor_type, target_type, target_id, idempotency_key, created_at)
           VALUES ('act-rolled-back', 'employee.archived', 'owner', 'employee', 'emp-1', 'key-rolled-back', 2000)`,
        );
        throw new Error("Force rollback");
      })();
    }).toThrow("Force rollback");

    db.close();

    db = new Database(file);
    const rows = db.query<{ id: string }, []>("SELECT id FROM activity_events ORDER BY sequence_id ASC").all();
    expect(rows).toEqual([{ id: "act-committed" }]);
  } finally {
    db.close();
  }
});
