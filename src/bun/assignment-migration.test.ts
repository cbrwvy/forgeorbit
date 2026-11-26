import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { migrate } from "./migrate.ts";
import { migrations } from "./migrations/index.ts";
import { InfrastructureCore } from "./infrastructure-core.ts";

test("081 follows the real 080 infrastructure inventory and applies from a database at 079 or at 080", () => {
  const ids = migrations.map((migration) => migration.id);
  const at079 = ids.indexOf("079_ai_employees");
  const at080 = ids.indexOf("080_infrastructure_inventory");
  const at081 = ids.indexOf("081_employee_task_assignments");
  expect(at080).toBe(at079 + 1);
  expect(at081).toBe(at080 + 1);
  expect(new Set(ids).size).toBe(ids.length);
  expect(ids.slice(at079, at081 + 1)).toEqual(["079_ai_employees", "080_infrastructure_inventory", "081_employee_task_assignments"]);

  const from080 = new Database(":memory:");
  const from079 = new Database(":memory:");
  try {
    from080.run("PRAGMA foreign_keys = ON");
    migrate(from080, migrations.slice(0, at081));
    expect(migrate(from080, migrations)).toEqual(ids.slice(at081));
    expect(migrate(from080, migrations)).toEqual([]);
    expect(from080.query(`PRAGMA foreign_key_check`).all()).toEqual([]);

    from079.run("PRAGMA foreign_keys = ON");
    migrate(from079, migrations.slice(0, at080));
    expect(migrate(from079, migrations)).toEqual(ids.slice(at080));
    expect(migrate(from079, migrations)).toEqual([]);
    expect(from079.query(`PRAGMA foreign_key_check`).all()).toEqual([]);
  } finally {
    from080.close();
    from079.close();
  }
});

test("081 adds assignment tables without rewriting employees, tasks, runs, or projects", () => {
  const db = new Database(":memory:");
  try {
    db.run("PRAGMA foreign_keys = ON");
    const at = migrations.findIndex((migration) => migration.id === "081_employee_task_assignments");
    migrate(db, migrations.slice(0, at));
    db.run(`INSERT INTO projects (path, name, added_at) VALUES ('/registry/app', 'App', 5)`);
    db.run(`INSERT INTO tasks (id, title, prompt, "column", agent, workdir, created_at, updated_at) VALUES ('task-1', 'Keep', 'prompt', 'ready', 'codex', '/registry/app', 5, 5)`);
    db.run(`INSERT INTO runs (id, task_id, agent, status, started_at) VALUES ('run-1', 'task-1', 'codex', 'running', 5)`);
    db.run(
      `INSERT INTO ai_employees (id, kind, name, name_source, job_title, role_category, status, created_at, updated_at)
       VALUES ('worker-1', 'worker', 'Ada', 'owner', 'QA Engineer', 'quality', 'active', 1, 1)`,
    );
    const employeeColumns = db.query(`PRAGMA table_info(ai_employees)`).all();
    const tables = ["projects", "tasks", "runs", "ai_employees", "ai_employee_events", "project_managers"];
    const before = tables.map((table) => db.query(`SELECT * FROM ${table}`).all());
    expect(migrate(db, migrations)).toEqual(migrations.map(m => m.id).slice(at));
    expect(tables.map((table) => db.query(`SELECT * FROM ${table}`).all())).toEqual(before);
    expect(db.query(`PRAGMA table_info(ai_employees)`).all()).toEqual(employeeColumns);
    expect(db.query(`SELECT name FROM sqlite_master WHERE type = 'table' AND name LIKE 'employee_task_assignment%' ORDER BY name`).all()).toEqual([
      { name: "employee_task_assignment_events" },
      { name: "employee_task_assignments" },
    ]);
    expect(db.query(`PRAGMA foreign_key_list(employee_task_assignments)`).all()).toEqual([]);
    expect(db.query(`PRAGMA foreign_key_list(employee_task_assignment_events)`).all()).toEqual([]);
    expect(db.query(`SELECT COUNT(*) AS n FROM employee_task_assignments`).get()).toEqual({ n: 0 });
    db.run(`DELETE FROM tasks WHERE id = 'task-1'`);
    db.run(`DELETE FROM ai_employees WHERE id = 'worker-1'`);
    db.run(`DELETE FROM projects WHERE path = '/registry/app'`);
    expect(db.query(`SELECT COUNT(*) AS n FROM employee_task_assignment_events`).get()).toEqual({ n: 0 });
  } finally {
    db.close();
  }
});

test("079 still enforces employee identity when 081 is present", () => {
  const db = new Database(":memory:");
  try {
    migrate(db, migrations);
    db.run(
      `INSERT INTO ai_employees (id, kind, name, name_source, job_title, role_category, status, created_at, updated_at)
       VALUES ('h1', 'head', 'Ilse', 'owner', 'Head of Project Management', 'leadership', 'active', 1, 1)`,
    );
    expect(() => db.run(
      `INSERT INTO ai_employees (id, kind, name, name_source, job_title, role_category, status, created_at, updated_at)
       VALUES ('h2', 'head', 'Other', 'owner', 'Head of Project Management', 'leadership', 'active', 1, 1)`,
    )).toThrow();
    expect(db.query(`SELECT id FROM ai_employees`).all()).toEqual([{ id: "h1" }]);
  } finally {
    db.close();
  }
});

test("081 applied over a populated 080 keeps infrastructure, knowledge, employees, and assignments across a repeat run", () => {
  const db = new Database(":memory:");
  try {
    db.run("PRAGMA foreign_keys = ON");
    const at = migrations.findIndex((migration) => migration.id === "081_employee_task_assignments");
    migrate(db, migrations.slice(0, at));
    db.run(`INSERT INTO projects (path, name, added_at) VALUES ('/registry/app', 'App', 5)`);
    db.run(`INSERT INTO clusters (id, name, description, created_at, updated_at) VALUES ('3f1c7c1e-0a41-4d7e-9a5b-0b3a6f1d2e90', 'Forge', '', 5, 5)`);
    db.run(
      `INSERT INTO knowledge_documents (id, owner_kind, owner_id, title, revision, created_at, updated_at, content_sha256, byte_length)
       VALUES ('note', 'project', '/registry/app', 'Note', 1, 5, 5, ?, 0)`,
      ["0".repeat(64)],
    );
    db.run(
      `INSERT INTO ai_employees (id, kind, name, name_source, job_title, role_category, status, created_at, updated_at)
       VALUES ('worker-1', 'worker', 'Ada', 'owner', 'QA Engineer', 'quality', 'active', 1, 1)`,
    );
    new InfrastructureCore(db, { now: () => 50 }).create({ name: "Host", resourceType: "vps", clusterIds: ["3f1c7c1e-0a41-4d7e-9a5b-0b3a6f1d2e90"] });
    const tables = ["projects", "clusters", "knowledge_documents", "knowledge_revisions", "ai_employees", "infrastructure_resources", "infrastructure_cluster_links"];
    const before = tables.map((table) => db.query(`SELECT * FROM ${table}`).all());
    expect(migrate(db, migrations)).toEqual(migrations.map(m => m.id).slice(at));
    expect(tables.map((table) => db.query(`SELECT * FROM ${table}`).all())).toEqual(before);

    db.run(
      `INSERT INTO employee_task_assignments (id, task_id, project_path, employee_id, status, provenance, revision, created_at, updated_at, assigned_at)
       VALUES ('a1', 't1', '/registry/app', 'worker-1', 'active', 'owner', 1, 9, 9, 9)`,
    );
    const assignments = db.query(`SELECT * FROM employee_task_assignments`).all();
    expect(migrate(db, migrations)).toEqual([]);
    expect(db.query(`SELECT * FROM employee_task_assignments`).all()).toEqual(assignments);
    expect(db.query(`PRAGMA foreign_key_check`).all()).toEqual([]);
  } finally {
    db.close();
  }
});
