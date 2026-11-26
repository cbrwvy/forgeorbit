import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { migrate } from "./migrate.ts";
import { migrations } from "./migrations/index.ts";
import { professionalRuntimeMigration } from "./migrations/090_professional_runtime.ts";

function seed(db: Database) {
  db.run(`INSERT INTO employee_executions (id, task_id, task_title, project_path, employee_id, employee_name,
    assignment_id, assignment_revision, status, revision, requested_harness_id, requested_policy, requested_mode,
    inputs_key, task_fingerprint, config_json, review_json, created_at, updated_at, expires_at)
    VALUES ('historical', 'task', 'Task', '/fixture', 'employee', 'Worker', 'assignment', 1,
    'awaiting-approval', 1, 'codex', 'balanced', 'ask', 'key', 'fingerprint', '{}', '{}', 10, 10, 100)`);
}
const allThrough090 = migrations.slice(0, migrations.findIndex(m => m.id === "091_professional_execution_turns"));
const at = migrations.findIndex(m => m.id === "090_professional_runtime");

test("090 upgrades 089, preserves historical Unknown, is idempotent and persists after reopening", () => {
  const file = path.join(mkdtempSync(path.join(tmpdir(), "fo014d-migration-")), "fixture.sqlite");
  let db = new Database(file);
  try {
    migrate(db, migrations.slice(0, at)); seed(db);
    const before = db.query<Record<string, unknown>, []>("SELECT * FROM employee_executions").get()!;
    expect(migrate(db, allThrough090)).toEqual(["090_professional_runtime"]);
    const after = db.query<Record<string, unknown>, []>("SELECT * FROM employee_executions").get()!;
    for (const key of Object.keys(before)) expect(after[key]).toEqual(before[key]);
    expect(after.professional_json).toBeNull(); expect(after.professional_payload_sha256).toBeNull();
    expect(migrate(db, allThrough090)).toEqual([]);
    db.close(); db = new Database(file);
    expect(db.query("SELECT professional_json FROM employee_executions").get()).toEqual({ professional_json: null });
    expect(db.query("PRAGMA foreign_key_check").all()).toEqual([]);
  } finally { db.close(); }
});

test("090 failed application rolls all columns/triggers and migration stamp back", () => {
  const db = new Database(":memory:");
  try {
    migrate(db, migrations.slice(0, at)); seed(db);
    expect(() => migrate(db, [{ ...professionalRuntimeMigration, apply(db) {
      professionalRuntimeMigration.apply!(db); throw new Error("fixture transaction interruption");
    } }])).toThrow("fixture transaction interruption");
    expect(db.query<{ name: string }, []>("PRAGMA table_info(employee_executions)").all().map(c => c.name)).not.toContain("professional_json");
    expect(db.query("SELECT * FROM _migrations WHERE id = '090_professional_runtime'").get()).toBeNull();
    expect(db.query("SELECT * FROM sqlite_master WHERE type = 'trigger' AND name LIKE 'employee_professional_%'").all()).toEqual([]);
    expect(migrate(db, allThrough090)).toEqual(["090_professional_runtime"]);
  } finally { db.close(); }
});

test("090 fresh database rejects snapshot, completed payload and run-link rewrites", () => {
  const db = new Database(":memory:");
  try {
    migrate(db, allThrough090); seed(db);
    expect(() => db.run("UPDATE employee_executions SET professional_json = '{}' WHERE id = 'historical'")).toThrow("snapshot is immutable");
    db.run("UPDATE employee_executions SET run_id = 'run', professional_payload_sha256 = ?, professional_payload_status = 'prepared'", ["a".repeat(64)]);
    db.run("UPDATE employee_executions SET professional_payload_status = 'included', professional_payload_at = 20");
    for (const update of ["professional_payload_status = 'bound'", "professional_payload_at = 21", "professional_payload_sha256 = 'wrong'", "run_id = 'other'", "run_id = NULL"]) {
      expect(() => db.run(`UPDATE employee_executions SET ${update}`)).toThrow("payload attribution is immutable");
    }
    // Idempotent reconciliation may re-stamp the same durable link.
    db.run("UPDATE employee_executions SET run_id = 'run'");
  } finally { db.close(); }
});
