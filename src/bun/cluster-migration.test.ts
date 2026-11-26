import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { migrate } from "./migrate.ts";
import { migrations } from "./migrations/index.ts";
import { ClusterCore } from "./cluster-core.ts";

test("077 adds the cluster registry without rewriting projects, tasks, or managers", () => {
  const db = new Database(":memory:");
  try {
    db.run("PRAGMA foreign_keys = ON");
    const clusterAt = migrations.findIndex((migration) => migration.id === "077_cluster_registry");
    expect(clusterAt).toBeGreaterThan(0);
    const ids = migrations.map((m) => m.id);
    expect(ids.slice(clusterAt, clusterAt + 9)).toEqual(["077_cluster_registry", "078_knowledge_documents", "079_ai_employees", "080_infrastructure_inventory", "081_employee_task_assignments", "082_knowledge_context", "084_organization_assignment_proposals", "085_employee_execution_attribution", "086_head_portfolio_binding"]);
    migrate(db, migrations.slice(0, clusterAt));
    db.run(`INSERT INTO projects (path, name, added_at) VALUES ('/registry/app', 'App', 5)`);
    db.run(
      `INSERT INTO tasks (id, title, prompt, "column", agent, workdir, created_at, updated_at) VALUES ('task-1', 'Keep', 'prompt', 'ready', 'codex', '/registry/app', 5, 5)`,
    );
    db.run(`INSERT INTO project_managers (project_path, config, updated_at) VALUES ('/registry/app', '{"name":"kept"}', 5)`);
    const before = ["projects", "tasks", "project_managers", "runs", "agent_profiles"].map((table) => db.query(`SELECT * FROM ${table}`).all());
    const [projectsBefore, tasksBefore, managersBefore] = before;
    if (!projectsBefore || !tasksBefore || !managersBefore) throw new Error("snapshot missing");
    expect(migrate(db, migrations)).toEqual(ids.slice(clusterAt));
    expect(migrate(db, migrations)).toEqual([]);
    expect(["projects", "tasks", "project_managers", "runs", "agent_profiles"].map((table) => db.query(`SELECT * FROM ${table}`).all())).toEqual(before);
    expect(db.query(`SELECT name FROM sqlite_master WHERE type = 'table' AND name LIKE 'cluster%' ORDER BY name`).all()).toEqual([
      { name: "cluster_membership_events" },
      { name: "cluster_project_memberships" },
      { name: "clusters" },
    ]);
    const core = new ClusterCore(db, { now: () => 10, pathExists: () => false, realpath: () => null });
    expect(core.list()).toEqual([]);
    const cluster = core.create({ name: "Lunarian Forge" });
    core.assign(cluster.id, "/registry/app");
    expect(db.query(`SELECT * FROM projects`).all()).toEqual(projectsBefore);
    expect(db.query(`SELECT * FROM tasks`).all()).toEqual(tasksBefore);
    expect(db.query(`SELECT * FROM project_managers`).all()).toEqual(managersBefore);
    expect(() => db.run(`DELETE FROM clusters WHERE id = ?`, [cluster.id])).toThrow();
    db.run(`DELETE FROM projects WHERE path = '/registry/app'`);
    expect(db.query(`SELECT * FROM cluster_project_memberships`).all()).toEqual([]);
    expect(db.query(`SELECT id FROM clusters`).get()).toEqual({ id: cluster.id });
    expect(db.query(`SELECT action FROM cluster_membership_events`).all()).toEqual([{ action: "assign" }]);
    expect(db.query(`PRAGMA foreign_key_check`).all()).toEqual([]);
  } finally {
    db.close();
  }
});
