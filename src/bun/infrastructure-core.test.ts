import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { readFileSync } from "node:fs";
import { migrate } from "./migrate.ts";
import { migrations } from "./migrations/index.ts";
import { InfrastructureCore } from "./infrastructure-core.ts";

const CLUSTER_A = "00000000-0000-4000-8000-00000000000a";
const CLUSTER_B = "00000000-0000-4000-8000-00000000000b";

function open(): Database {
  const db = new Database(":memory:");
  db.run("PRAGMA foreign_keys = ON");
  migrate(db, migrations);
  return db;
}

function seed(db: Database): void {
  db.run(`INSERT INTO projects (path, name, added_at) VALUES ('/registry/alpha', 'Alpha', 1)`);
  db.run(`INSERT INTO projects (path, name, added_at) VALUES ('/registry/beta', 'Beta', 1)`);
  db.run(`INSERT INTO clusters (id, name, description, created_at, updated_at) VALUES (?, 'One', '', 1, 1)`, [CLUSTER_A]);
  db.run(`INSERT INTO clusters (id, name, description, created_at, updated_at) VALUES (?, 'Two', '', 1, 1)`, [CLUSTER_B]);
  db.run(
    `INSERT INTO knowledge_documents (id, owner_kind, owner_id, title, revision, created_at, updated_at, content_sha256, byte_length)
     VALUES ('note', 'cluster', ?, 'Architecture', 1, 1, 1, ?, 4)`,
    [CLUSTER_A, "a".repeat(64)],
  );
}

test("inventory source does not reach a shell, the filesystem, or the network", () => {
  const core = readFileSync(new URL("./infrastructure-core.ts", import.meta.url), "utf8");
  const http = readFileSync(new URL("./infrastructure-http.ts", import.meta.url), "utf8");
  for (const source of [core, http]) {
    expect(source.includes("Bun.spawn")).toBe(false);
    expect(source.includes("child_process")).toBe(false);
    expect(source.includes("node:net")).toBe(false);
    expect(source.includes("node:dns")).toBe(false);
    expect(source.includes("node:fs")).toBe(false);
    expect(source.includes("fetch(")).toBe(false);
  }
});

test("one resource can belong to many clusters and projects without copying or touching the registry", () => {
  const db = open();
  try {
    seed(db);
    const core = new InfrastructureCore(db, { now: () => 50 });
    const projectsBefore = db.query(`SELECT * FROM projects`).all();
    const knowledgeBefore = db.query(`SELECT * FROM knowledge_documents`).all();
    const first = core.create({
      name: "Shared staging",
      resourceType: "vps",
      provider: "Fixture",
      hostname: "staging.fixture.invalid",
      environment: "staging",
      costAmount: "20",
      currency: "USD",
      status: "unknown",
      clusterIds: [CLUSTER_A],
      projectPaths: ["/registry/alpha"],
    });
    expect(first.verification).toBe("absent");
    expect(first.status).toBe("unknown");
    expect(first.ipAddress).toBeNull();
    expect(first.clusters.map((cluster) => cluster.id)).toEqual([CLUSTER_A]);
    const shared = core.linkCluster(first.id, { clusterId: CLUSTER_B });
    expect(shared.clusters.map((cluster) => cluster.id).sort()).toEqual([CLUSTER_A, CLUSTER_B]);
    expect(db.query(`SELECT COUNT(*) AS count FROM infrastructure_resources`).get()).toEqual({ count: 1 });
    expect(core.unlinkCluster(first.id, CLUSTER_B).clusters.map((cluster) => cluster.id)).toEqual([CLUSTER_A]);
    core.linkCluster(first.id, { clusterId: CLUSTER_B });
    core.linkProject(first.id, { projectPath: "/registry/beta" });
    expect(core.get(first.id).projects.map((project) => project.path).sort()).toEqual(["/registry/alpha", "/registry/beta"]);
    expect(core.unlinkProject(first.id, "/registry/beta").projects.map((project) => project.path)).toEqual(["/registry/alpha"]);
    core.linkProject(first.id, { projectPath: "/registry/beta" });
    core.create({ name: "Local", resourceType: "local-development", clusterIds: [CLUSTER_A] });
    core.create({ name: "Docs", resourceType: "domain", hostname: "docs.fixture.invalid" });
    expect(core.list({ clusterId: CLUSTER_A, archived: "active" }).resources).toHaveLength(2);
    expect(core.list({ archived: "active" }).resources.find((resource) => resource.name === "Docs")?.clusters).toEqual([]);
    const view = core.clusterView(CLUSTER_A);
    expect(view.domains).toEqual([]);
    expect(view.resources.some((resource) => resource.name === "Shared staging")).toBe(true);
    expect(view.costs).toEqual([{ resourceId: first.id, name: "Shared staging", amount: "20", currency: "USD" }]);
    expect(view.unverified).toEqual({ notVerified: 1, unknown: 1 });
    expect(JSON.stringify(view)).not.toContain("online");
    expect(db.query(`SELECT * FROM projects`).all()).toEqual(projectsBefore);
    expect(db.query(`SELECT * FROM knowledge_documents`).all()).toEqual(knowledgeBefore);
    expect(db.query(`SELECT COUNT(*) AS count FROM environment_profiles`).get()).toEqual({ count: 0 });
  } finally {
    db.close();
  }
});

test("environments are declarations, and archive keeps the record", () => {
  const db = open();
  try {
    seed(db);
    let now = 10;
    const core = new InfrastructureCore(db, { now: () => now });
    const resource = core.create({ name: "Database", resourceType: "database", environment: "production" });
    const declared = core.declareEnvironment({ projectPath: "/registry/alpha", environment: "production" });
    expect(declared.created).toBe(true);
    expect(core.declareEnvironment({ projectPath: "/registry/alpha", environment: "local" }).declaration.environment).toBe("local");
    const linked = core.linkEnvironment(resource.id, { projectPath: "/registry/alpha", environment: "production" });
    expect(linked.environmentLinks).toEqual([{
      projectPath: "/registry/alpha",
      projectName: "Alpha",
      environment: "production",
      customLabel: "",
    }]);
    expect(() => core.linkEnvironment(resource.id, { projectPath: "/registry/alpha", environment: "staging" })).toThrow(
      "Declare the project environment",
    );
    now = 20;
    const renamed = core.update(resource.id, { name: "Database renamed", currency: "EUR" });
    expect(renamed.name).toBe("Database renamed");
    expect(renamed.currency).toBe("EUR");
    expect(renamed.costAmount).toBeNull();
    expect(renamed.createdAt).toBe(10);
    const archived = core.archive(resource.id);
    expect(archived.archivedAt).toBe(20);
    expect(core.list({ archived: "active" }).resources.map((item) => item.id)).not.toContain(resource.id);
    expect(() => core.linkCluster(resource.id, { clusterId: CLUSTER_A })).toThrow("archived");
    expect(core.restore(resource.id).archivedAt).toBeNull();
    db.run(`DELETE FROM projects WHERE path = '/registry/alpha'`);
    expect(core.get(resource.id).projects).toEqual([]);
    expect(db.query(`SELECT id FROM infrastructure_resources`).get()).toEqual({ id: resource.id });
    expect(db.query(`SELECT * FROM infrastructure_project_environments`).all()).toEqual([]);
  } finally {
    db.close();
  }
});

test("unknown projects, duplicate links, and unsafe fields fail before a write", () => {
  const db = open();
  try {
    seed(db);
    const core = new InfrastructureCore(db, { now: () => 1 });
    expect(() => core.create({ name: "X", resourceType: "vps", projectPaths: ["/registry/missing"] })).toThrow("not registered");
    expect(db.query(`SELECT COUNT(*) AS count FROM infrastructure_resources`).get()).toEqual({ count: 0 });
    const resource = core.create({ name: "X'; DROP TABLE projects; --", resourceType: "other" });
    expect(db.query(`SELECT COUNT(*) AS count FROM projects`).get()).toEqual({ count: 2 });
    core.linkCluster(resource.id, { clusterId: CLUSTER_A });
    expect(() => core.linkCluster(resource.id, { clusterId: CLUSTER_A })).toThrow("already linked");
    expect(() => core.create({ name: "Bad", resourceType: "vps", status: "online" })).toThrow("not verified");
    expect(() => core.get("not-a-uuid")).toThrow("Invalid");
  } finally {
    db.close();
  }
});
