import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { migrate } from "./migrate.ts";
import { migrations } from "./migrations/index.ts";

const SEED = ["projects", "clusters", "environment_profiles", "knowledge_documents", "tasks"];

function seed(db: Database) {
  db.run(`INSERT INTO projects (path, name, added_at) VALUES ('/registry/app', 'App', 5)`);
  db.run(`INSERT INTO clusters (id, name, description, created_at, updated_at) VALUES ('cluster-1', 'Forge', '', 5, 5)`);
  db.run(`INSERT INTO environment_profiles (id, project_path, data, updated_at) VALUES ('profile', '/registry/app', '{}', 5)`);
  db.run(
    `INSERT INTO knowledge_documents (id, owner_kind, owner_id, title, revision, created_at, updated_at, content_sha256, byte_length)
     VALUES ('note', 'project', '/registry/app', 'Note', 1, 5, 5, ?, 0)`,
    ["0".repeat(64)],
  );
}

function expectInfrastructureTables(db: Database) {
  const created = db.query<{ name: string; sql: string }, []>(
    `SELECT name, sql FROM sqlite_master WHERE type = 'table' AND name LIKE 'infrastructure%' ORDER BY name`,
  ).all();
  expect(created.map((row) => row.name)).toEqual([
    "infrastructure_cluster_links",
    "infrastructure_environment_links",
    "infrastructure_project_environments",
    "infrastructure_project_links",
    "infrastructure_resources",
  ]);
  expect(created.map((row) => row.sql).join("\n").toLowerCase()).not.toContain("password");
  expect(created.map((row) => row.sql).join("\n").toLowerCase()).not.toContain("secret");
}

test("079 and 080 are both registered, in order, after 078 and before 081", () => {
  const ids = migrations.map((migration) => migration.id);
  const at078 = ids.indexOf("078_knowledge_documents");
  expect(ids.slice(at078, at078 + 8)).toEqual(["078_knowledge_documents", "079_ai_employees", "080_infrastructure_inventory", "081_employee_task_assignments", "082_knowledge_context", "084_organization_assignment_proposals", "085_employee_execution_attribution", "086_head_portfolio_binding"]);
});

test("a database at 078 gains 079 then 080 without rewriting projects, clusters, or knowledge", () => {
  const db = new Database(":memory:");
  try {
    db.run("PRAGMA foreign_keys = ON");
    const at = migrations.findIndex((migration) => migration.id === "079_ai_employees");
    migrate(db, migrations.slice(0, at));
    seed(db);
    const before = SEED.map((table) => db.query(`SELECT * FROM ${table}`).all());
    const ids = migrations.map((m) => m.id);
    expect(migrate(db, migrations)).toEqual(ids.slice(at));
    expect(migrate(db, migrations)).toEqual([]);
    expect(SEED.map((table) => db.query(`SELECT * FROM ${table}`).all())).toEqual(before);
    expectInfrastructureTables(db);
    expect(db.query(`PRAGMA foreign_key_check`).all()).toEqual([]);
  } finally {
    db.close();
  }
});

test("a database at 079 gains 080 then 081 and keeps its employees", () => {
  const db = new Database(":memory:");
  try {
    db.run("PRAGMA foreign_keys = ON");
    const at = migrations.findIndex((migration) => migration.id === "080_infrastructure_inventory");
    migrate(db, migrations.slice(0, at));
    seed(db);
    db.run(
      `INSERT INTO ai_employees (id, kind, name, name_source, job_title, role_category, status, created_at, updated_at)
       VALUES ('emp-1', 'worker', 'Alex', 'generated', 'QA Engineer', 'quality', 'active', 5, 5)`,
    );
    const tables = [...SEED, "ai_employees"];
    const before = tables.map((table) => db.query(`SELECT * FROM ${table}`).all());
    const ids = migrations.map((m) => m.id);
    expect(migrate(db, migrations)).toEqual(ids.slice(at));
    expect(migrate(db, migrations)).toEqual([]);
    expect(tables.map((table) => db.query(`SELECT * FROM ${table}`).all())).toEqual(before);
    expectInfrastructureTables(db);
    expect(db.query(`PRAGMA foreign_key_check`).all()).toEqual([]);
  } finally {
    db.close();
  }
});

test("a fresh installation applies 079 and 080 and enforces cascades only on infrastructure rows", () => {
  const db = new Database(":memory:");
  try {
    db.run("PRAGMA foreign_keys = ON");
    migrate(db, migrations);
    expectInfrastructureTables(db);
    expect(db.query(`SELECT id FROM _migrations WHERE id IN ('079_ai_employees', '080_infrastructure_inventory') ORDER BY id`).all()).toEqual([
      { id: "079_ai_employees" },
      { id: "080_infrastructure_inventory" },
    ]);
    expect(db.query(`PRAGMA foreign_key_check`).all()).toEqual([]);
  } finally {
    db.close();
  }
});
