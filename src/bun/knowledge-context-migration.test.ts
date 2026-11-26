import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { migrate } from "./migrate.ts";
import { migrations } from "./migrations/index.ts";

test("082 follows 081 and adds one metadata-only table without touching earlier data", () => {
  const ids = migrations.map((migration) => migration.id);
  const at = ids.indexOf("082_knowledge_context");
  expect(at).toBe(ids.indexOf("081_employee_task_assignments") + 1);
  expect(new Set(ids).size).toBe(ids.length);

  const db = new Database(":memory:");
  try {
    db.run("PRAGMA foreign_keys = ON");
    migrate(db, migrations.slice(0, at));
    db.run(`INSERT INTO projects (path, name, added_at) VALUES ('/registry/app', 'App', 5)`);
    db.run(
      `INSERT INTO knowledge_documents (id, owner_kind, owner_id, title, revision, created_at, updated_at, content_sha256, byte_length)
       VALUES ('note', 'project', '/registry/app', 'Note', 1, 5, 5, ?, 0)`,
      ["0".repeat(64)],
    );
    const tables = ["projects", "knowledge_documents", "knowledge_revisions"];
    const before = tables.map((table) => db.query(`SELECT * FROM ${table}`).all());
    expect(migrate(db, migrations)).toEqual(ids.slice(at));
    expect(migrate(db, migrations)).toEqual([]);
    expect(tables.map((table) => db.query(`SELECT * FROM ${table}`).all())).toEqual(before);
    const columns = db.query<{ name: string }, []>(`PRAGMA table_info(knowledge_context_grants)`).all().map((row) => row.name);
    expect(columns).not.toContain("content");
    expect(columns).not.toContain("markdown");
    expect(columns).not.toContain("path");
    // No foreign keys: the audit trail outlives notes, projects and clusters.
    expect(db.query(`PRAGMA foreign_key_list(knowledge_context_grants)`).all()).toEqual([]);
    db.run(`DELETE FROM knowledge_documents WHERE id = 'note'`);
    db.run(`DELETE FROM projects WHERE path = '/registry/app'`);
    expect(db.query(`PRAGMA foreign_key_check`).all()).toEqual([]);
  } finally {
    db.close();
  }
});

test("082 enforces the grant shape in the schema", () => {
  const db = new Database(":memory:");
  try {
    migrate(db, migrations);
    const insert = (values: Record<string, unknown>) => {
      const row = { id: "a".repeat(64), manager_kind: "project", project_path: "/p", status: "approved", preview_key: "k", items_json: "[]", total_bytes: 0, created_at: 1, expires_at: 2, ...values };
      db.run(`INSERT INTO knowledge_context_grants (${Object.keys(row).join(",")}) VALUES (${Object.keys(row).map(() => "?").join(",")})`, Object.values(row) as never[]);
    };
    expect(() => insert({ id: "short" })).toThrow();
    expect(() => insert({ status: "forever" })).toThrow();
    expect(() => insert({ manager_kind: "cluster" })).toThrow();
    expect(() => insert({ project_path: null })).toThrow();
    expect(() => insert({ manager_kind: "portfolio" })).toThrow();
    insert({ manager_kind: "portfolio", project_path: null, id: "b".repeat(64) });
    insert({});
    expect(() => insert({})).toThrow();
  } finally {
    db.close();
  }
});
