import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { migrate } from "./migrate.ts";
import { migrations } from "./migrations/index.ts";
import { AccountCore } from "./account-core.ts";

test("078 adds the knowledge index without rewriting projects, clusters, or tasks", () => {
  const db = new Database(":memory:");
  try {
    db.run("PRAGMA foreign_keys = ON");
    const at = migrations.findIndex((migration) => migration.id === "078_knowledge_documents");
    expect(at).toBeGreaterThan(0);
    expect(migrations[at - 1]?.id).toBe("077_cluster_registry");
    expect(migrations[at + 1]?.id).toBe("079_ai_employees");
    migrate(db, migrations.slice(0, at));
    db.run(`INSERT INTO projects (path, name, added_at) VALUES ('/registry/app', 'App', 5)`);
    db.run(`INSERT INTO clusters (id, name, description, created_at, updated_at) VALUES ('cluster-1', 'Forge', '', 5, 5)`);
    db.run(`INSERT INTO cluster_project_memberships (project_path, cluster_id, assigned_at, updated_at) VALUES ('/registry/app', 'cluster-1', 5, 5)`);
    db.run(
      `INSERT INTO tasks (id, title, prompt, "column", agent, workdir, created_at, updated_at) VALUES ('task-1', 'Keep', 'prompt', 'ready', 'codex', '/registry/app', 5, 5)`,
    );
    const accounts = new AccountCore(db, () => 7);
    const account = accounts.createAccount({ provider: "fixture", displayName: "Existing account" });
    accounts.bindHarness(account.id, "codex");
    const quota = accounts.createDefinition({ accountId: account.id, scope: "account", unit: { kind: "tokens" }, window: "daily" });
    accounts.recordObservation(quota.id, { remaining: 42 });
    const tables = ["projects", "clusters", "cluster_project_memberships", "tasks", "resource_accounts", "account_harness_bindings", "quota_definitions", "quota_observations"];
    const before = tables.map((table) => db.query(`SELECT * FROM ${table}`).all());
    expect(migrate(db, migrations)).toEqual(migrations.map(m => m.id).slice(at));
    expect(migrate(db, migrations)).toEqual([]);
    expect(tables.map((table) => db.query(`SELECT * FROM ${table}`).all())).toEqual(before);
    expect(accounts.listAccounts().map(row => row.id)).toEqual([account.id]);
    expect(accounts.history(quota.id)).toHaveLength(1);
    expect(db.query(`SELECT name FROM sqlite_master WHERE type = 'table' AND name LIKE 'knowledge%' ORDER BY name`).all()).toEqual([
      { name: "knowledge_context_grants" },
      { name: "knowledge_documents" },
      { name: "knowledge_revisions" },
    ]);
    expect(db.query(`PRAGMA foreign_key_check`).all()).toEqual([]);
  } finally {
    db.close();
  }
});

test("a fresh installation enforces revision foreign keys and cascades only knowledge rows", () => {
  const db = new Database(":memory:");
  try {
    db.run("PRAGMA foreign_keys = ON");
    migrate(db, migrations);
    const at076 = migrations.findIndex((m) => m.id === "076_account_quota_core");
    expect(migrations.slice(at076, at076 + 10).map(row => row.id)).toEqual(["076_account_quota_core", "077_cluster_registry", "078_knowledge_documents", "079_ai_employees", "080_infrastructure_inventory", "081_employee_task_assignments", "082_knowledge_context", "084_organization_assignment_proposals", "085_employee_execution_attribution", "086_head_portfolio_binding"]);
    const insertRevision = () => db.run(`INSERT INTO knowledge_revisions VALUES ('note', 1, 1, 0, ?)`, ["0".repeat(64)]);
    expect(insertRevision).toThrow();
    db.run(`INSERT INTO projects(path, name, added_at) VALUES ('/registry/kept', 'Kept', 1)`);
    db.run(`INSERT INTO knowledge_documents(id, owner_kind, owner_id, title, revision, created_at, updated_at, content_sha256, byte_length)
      VALUES ('note', 'project', '/registry/kept', 'Note', 1, 1, 1, ?, 0)`, ["0".repeat(64)]);
    insertRevision();
    db.run("DELETE FROM knowledge_documents WHERE id = 'note'");
    expect(db.query("SELECT * FROM knowledge_revisions").all()).toEqual([]);
    expect(db.query("SELECT path FROM projects").all()).toEqual([{ path: "/registry/kept" }]);
    expect(db.query("PRAGMA foreign_key_check").all()).toEqual([]);
    expect(migrate(db, migrations)).toEqual([]);
  } finally {
    db.close();
  }
});
