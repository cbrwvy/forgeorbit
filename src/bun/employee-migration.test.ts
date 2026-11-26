import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { migrate } from "./migrate.ts";
import { migrations } from "./migrations/index.ts";

const insert = (db: Database, values: Record<string, unknown>) => {
  const row = { id: "e1", kind: "worker", name: "Alex", name_source: "generated", job_title: "QA Engineer", role_category: "quality", status: "active", created_at: 1, updated_at: 1, ...values };
  const keys = Object.keys(row);
  db.run(`INSERT INTO ai_employees (${keys.join(", ")}) VALUES (${keys.map(() => "?").join(", ")})`, Object.values(row) as never[]);
};

test("079 follows 078, precedes 080, and leaves 076-078 as they were", () => {
  const ids = migrations.map((migration) => migration.id);
  const at = ids.indexOf("079_ai_employees");
  expect(ids.slice(at - 3, at)).toEqual(["076_account_quota_core", "077_cluster_registry", "078_knowledge_documents"]);
  expect(ids[at + 1]).toBe("080_infrastructure_inventory");
  expect(ids[at + 2]).toBe("081_employee_task_assignments");
});

test("079 adds employees without rewriting projects, tasks, runs, managers, clusters, or profiles", () => {
  const db = new Database(":memory:");
  try {
    db.run("PRAGMA foreign_keys = ON");
    const at = migrations.findIndex((migration) => migration.id === "079_ai_employees");
    migrate(db, migrations.slice(0, at));
    db.run(`INSERT INTO projects (path, name, added_at) VALUES ('/registry/app', 'App', 5)`);
    db.run(`INSERT INTO tasks (id, title, prompt, "column", agent, workdir, created_at, updated_at) VALUES ('task-1', 'Keep', 'prompt', 'ready', 'codex', '/registry/app', 5, 5)`);
    db.run(`INSERT INTO runs (id, task_id, agent, status, started_at) VALUES ('run-1', 'task-1', 'codex', 'running', 5)`);
    db.run(`INSERT INTO project_managers (project_path, config, updated_at) VALUES ('/registry/app', '{"name":"kept"}', 5)`);
    db.run(`INSERT INTO clusters (id, name, description, created_at, updated_at) VALUES ('c1', 'Forge', '', 5, 5)`);
    const tables = ["projects", "tasks", "runs", "project_managers", "project_manager_messages", "portfolio_manager", "clusters", "cluster_project_memberships", "agent_profiles", "knowledge_documents"];
    const before = tables.map((table) => db.query(`SELECT * FROM ${table}`).all());
    expect(migrate(db, migrations.slice(0, at + 1))).toEqual(["079_ai_employees"]);
    expect(migrate(db, migrations.slice(0, at + 1))).toEqual([]);
    expect(tables.map((table) => db.query(`SELECT * FROM ${table}`).all())).toEqual(before);
    expect(db.query(`SELECT name FROM sqlite_master WHERE type = 'table' AND name LIKE 'ai_employee%' ORDER BY name`).all()).toEqual([
      { name: "ai_employee_events" },
      { name: "ai_employees" },
    ]);
    expect(db.query(`SELECT COUNT(*) AS n FROM ai_employees`).get()).toEqual({ n: 0 });
    expect(db.query(`PRAGMA foreign_key_check`).all()).toEqual([]);
  } finally {
    db.close();
  }
});

test("079 enforces positions, statuses, and uniqueness in the schema", () => {
  const db = new Database(":memory:");
  try {
    db.run("PRAGMA foreign_keys = ON");
    migrate(db, migrations);
    insert(db, { id: "w1" });
    insert(db, { id: "w2" });
    expect(db.query(`SELECT COUNT(*) AS n FROM ai_employees WHERE name = 'Alex'`).get()).toEqual({ n: 2 });
    expect(() => insert(db, { id: "bad-kind", kind: "robot" })).toThrow();
    expect(() => insert(db, { id: "bad-source", name_source: "random" })).toThrow();
    expect(() => insert(db, { id: "bad-status", status: "fired" })).toThrow();
    expect(() => insert(db, { id: "empty", name: "   " })).toThrow();
    expect(() => insert(db, { id: "long", name: "x".repeat(81) })).toThrow();
    expect(() => insert(db, { id: "archived-no-time", status: "archived" })).toThrow();
    expect(() => insert(db, { id: "time-not-archived", archived_at: 3 })).toThrow();
    expect(() => insert(db, { id: "head-project", kind: "head", project_path: "/p" })).toThrow();
    expect(() => insert(db, { id: "pm-none", kind: "project-manager" })).toThrow();
    insert(db, { id: "h1", kind: "head" });
    expect(() => insert(db, { id: "h2", kind: "head" })).toThrow();
    insert(db, { id: "m1", kind: "project-manager", project_path: "/p" });
    expect(() => insert(db, { id: "m2", kind: "project-manager", project_path: "/p" })).toThrow();
    insert(db, { id: "m3", kind: "project-manager", project_path: "/q" });
    db.run(`UPDATE ai_employees SET status = 'archived', archived_at = 9 WHERE id IN ('h1', 'm1')`);
    insert(db, { id: "h3", kind: "head" });
    insert(db, { id: "m4", kind: "project-manager", project_path: "/p" });
    expect(() => db.run(`INSERT INTO ai_employee_events (employee_id, action, created_at) VALUES ('w1', 'promote', 1)`)).toThrow();
    db.run(`INSERT INTO ai_employee_events (employee_id, action, created_at) VALUES ('w1', 'rename', 1)`);
  } finally {
    db.close();
  }
});

test("079 has no foreign keys, so removing a project or a task never removes a person or history", () => {
  const db = new Database(":memory:");
  try {
    db.run("PRAGMA foreign_keys = ON");
    migrate(db, migrations);
    db.run(`INSERT INTO projects (path, name, added_at) VALUES ('/registry/app', 'App', 5)`);
    insert(db, { id: "m1", kind: "project-manager", project_path: "/registry/app" });
    db.run(`INSERT INTO ai_employee_events (employee_id, action, created_at) VALUES ('m1', 'create', 1)`);
    expect(db.query(`PRAGMA foreign_key_list(ai_employees)`).all()).toEqual([]);
    expect(db.query(`PRAGMA foreign_key_list(ai_employee_events)`).all()).toEqual([]);
    db.run(`DELETE FROM projects WHERE path = '/registry/app'`);
    expect(db.query(`SELECT id FROM ai_employees`).all()).toEqual([{ id: "m1" }]);
    expect(db.query(`SELECT employee_id FROM ai_employee_events`).all()).toEqual([{ employee_id: "m1" }]);
  } finally {
    db.close();
  }
});
