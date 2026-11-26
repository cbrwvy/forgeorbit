import { expect, spyOn, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { ClusterCore } from "./cluster-core.ts";
import { migrate } from "./migrate.ts";
import { migrations } from "./migrations/index.ts";

function open(): Database {
  const db = new Database(":memory:");
  db.run("PRAGMA foreign_keys = ON");
  migrate(db, migrations);
  return db;
}

function addProject(db: Database, projectPath: string, name = "Project"): void {
  db.run(`INSERT INTO projects (path, name, added_at) VALUES (?, ?, 1)`, [projectPath, name]);
}

function coreFor(db: Database, now = 1_000): ClusterCore {
  return new ClusterCore(db, { now: () => now, pathExists: () => false, realpath: () => null });
}

function preserved(db: Database): unknown[] {
  return ["projects", "tasks", "runs", "project_managers", "agent_profiles"].map((table) => db.query(`SELECT * FROM ${table}`).all());
}

test("registry starts empty and a project can stay unassigned", () => {
  const db = open();
  try {
    const core = coreFor(db);
    addProject(db, "/work/free", "Free");
    expect(core.list()).toEqual([]);
    expect(core.listUnassigned().map((project) => project.projectPath)).toEqual(["/work/free"]);
    expect(core.resolve("/work/free").cluster).toBeNull();
  } finally {
    db.close();
  }
});

test("create, rename, duplicate display names, and stable ids", () => {
  const db = open();
  try {
    let now = 1_000;
    const core = new ClusterCore(db, { now: () => now, pathExists: () => false, realpath: () => null });
    const first = core.create({ name: "Lunarian Forge", description: "Products", color: "#0AF", icon: "orbit", priority: 2 });
    now = 2_000;
    const renamed = core.update(first.id, { name: "Lunarian" });
    const second = core.create({ name: "Lunarian", slug: "second-venture" });
    expect(renamed.id).toBe(first.id);
    expect(renamed.createdAt).toBe(1_000);
    expect(renamed.updatedAt).toBe(2_000);
    expect(renamed.color).toBe("#0af");
    expect(renamed.companyId).toBe("company:forgeorbit");
    expect(renamed.knowledgeOwner).toEqual({ kind: "cluster", id: first.id });
    expect(second.id).not.toBe(first.id);
    expect(core.list().map((cluster) => cluster.name)).toEqual(["Lunarian", "Lunarian"]);
    expect(core.list({ slug: "second-venture" }).map((cluster) => cluster.id)).toEqual([second.id]);
    expect(core.get(first.id).infrastructure.status).toBe("registry");
    expect(core.get(first.id).manager.status).toBe("not-assigned");
    expect(() => core.create({ name: "Other", slug: "second-venture" })).toThrow("Slug is already in use.");
  } finally {
    db.close();
  }
});

test("assign, move, unassign, and duplicate membership", () => {
  const db = open();
  try {
    let now = 10;
    const core = new ClusterCore(db, { now: () => now, pathExists: () => true, realpath: () => null });
    addProject(db, "/work/media", "ExampleApp");
    addProject(db, "/work/other", "Other");
    const alpha = core.create({ name: "Alpha" });
    const beta = core.create({ name: "Beta" });
    now = 20;
    expect(core.assign(alpha.id, "/work/media").clusterId).toBe(alpha.id);
    expect(() => core.assign(alpha.id, "/work/media")).toThrow("already in this cluster");
    expect(() => core.assign(beta.id, "/work/media")).toThrow("Move it explicitly");
    expect(() => core.move(beta.id, "/work/other")).toThrow("Assign it explicitly");
    now = 30;
    expect(core.move(beta.id, "/work/media").clusterId).toBe(beta.id);
    expect(core.listProjects(alpha.id)).toEqual([]);
    expect(core.listProjects(beta.id).map((project) => project.projectPath)).toEqual(["/work/media"]);
    expect(core.resolve("/work/media").cluster?.id).toBe(beta.id);
    expect(core.listUnassigned().map((project) => project.projectPath)).toEqual(["/work/other"]);
    now = 40;
    expect(core.unassign(beta.id, "/work/media")).toEqual({ unassigned: true, projectPath: "/work/media" });
    expect(() => core.unassign(beta.id, "/work/media")).toThrow("not in this cluster");
    expect(core.resolve("/work/media").cluster).toBeNull();
    const history = core.get(beta.id).membershipHistory.map((event) => event.action);
    expect(history).toEqual(["move", "unassign"]);
    expect(core.get(alpha.id).membershipHistory.map((event) => event.action)).toEqual(["assign", "move"]);
  } finally {
    db.close();
  }
});

test("unregistered, invalid, nested, and missing paths do not create projects", () => {
  const db = open();
  try {
    const core = coreFor(db);
    const parent = "/work/parent";
    const child = "/work/parent/child";
    addProject(db, parent, "Parent");
    addProject(db, child, "Child");
    const cluster = core.create({ name: "Nested" });
    const other = core.create({ name: "Other" });
    core.assign(cluster.id, parent);
    expect(core.listUnassigned().map((project) => project.projectPath)).toEqual([child]);
    core.assign(other.id, child);
    expect(core.listProjects(cluster.id).map((project) => project.projectPath)).toEqual([parent]);
    expect(core.resolve(child).cluster?.id).toBe(other.id);
    const before = db.query(`SELECT path FROM projects ORDER BY path`).all();
    expect(() => core.assign(cluster.id, "/work/missing")).toThrow("not registered");
    expect(() => core.assign(cluster.id, "relative/path")).toThrow("absolute");
    expect(() => core.assign(cluster.id, "/work/parent/../parent")).toThrow("Invalid projectPath.");
    expect(() => core.assign(cluster.id, "/work/bad\0path")).toThrow("Invalid projectPath.");
    expect(() => core.assign(cluster.id, parent + "/src")).toThrow("not registered");
    expect(db.query(`SELECT path FROM projects ORDER BY path`).all()).toEqual(before);
    const missing = "/work/deleted-registration";
    addProject(db, missing, "Gone");
    const assigned = core.assign(cluster.id, missing);
    expect(assigned.pathMissing).toBe(true);
    expect(db.query(`SELECT path FROM projects WHERE path = ?`).get(missing)).toEqual({ path: missing });
  } finally {
    db.close();
  }
});

test("archive keeps projects and membership, and blocks new assignment", () => {
  const db = open();
  try {
    let now = 50;
    const core = new ClusterCore(db, { now: () => now, pathExists: () => false, realpath: () => null });
    addProject(db, "/work/media", "ExampleApp");
    addProject(db, "/work/free", "Free");
    const cluster = core.create({ name: "Alpha" });
    core.assign(cluster.id, "/work/media");
    const rows = preserved(db);
    now = 60;
    const archived = core.archive(cluster.id);
    expect(archived.archivedAt).toBe(60);
    expect(core.archive(cluster.id).archivedAt).toBe(60);
    expect(core.list().map((item) => item.id)).toEqual([]);
    expect(core.list({ includeArchived: true })).toHaveLength(1);
    expect(core.listProjects(cluster.id)).toHaveLength(1);
    expect(core.listUnassigned().map((project) => project.projectPath)).toEqual(["/work/free"]);
    expect(() => core.assign(cluster.id, "/work/free")).toThrow("archived");
    expect(preserved(db)).toEqual(rows);
    const next = core.create({ name: "Beta" });
    core.move(next.id, "/work/media");
    expect(core.listProjects(cluster.id)).toEqual([]);
    expect(core.resolve("/work/media").cluster?.id).toBe(next.id);
  } finally {
    db.close();
  }
});

test("membership writes roll back together and do not touch other project rows", () => {
  const db = open();
  try {
    const core = coreFor(db);
    addProject(db, "/work/a", "A");
    addProject(db, "/work/b", "B");
    db.run(`INSERT INTO tasks (id, title, prompt, "column", agent, workdir, created_at, updated_at) VALUES ('tb', 'B', 'prompt', 'ready', 'codex', '/work/b', 1, 1)`);
    db.run(`INSERT INTO project_managers (project_path, config, updated_at) VALUES ('/work/b', '{"name":"kept"}', 1)`);
    const cluster = core.create({ name: "Alpha" });
    db.run(`CREATE TEMP TRIGGER reject_event BEFORE INSERT ON cluster_membership_events BEGIN SELECT RAISE(ABORT, 'fixture'); END`);
    expect(() => core.assign(cluster.id, "/work/a")).toThrow();
    expect(core.listProjects(cluster.id)).toEqual([]);
    expect(core.listUnassigned().map((project) => project.projectPath).sort()).toEqual(["/work/a", "/work/b"]);
    db.run(`DROP TRIGGER reject_event`);
    const before = preserved(db);
    core.assign(cluster.id, "/work/a");
    expect(preserved(db)).toEqual(before);
    expect(db.query(`SELECT config FROM project_managers`).get()).toEqual({ config: '{"name":"kept"}' });
  } finally {
    db.close();
  }
});

test("symlink, nested directories, worktrees, and missing folders do not change project files", () => {
  const root = mkdtempSync(path.join(tmpdir(), "fo011a-files-"));
  const db = open();
  const spawn = spyOn(Bun, "spawn").mockImplementation(() => {
    throw new Error("unexpected process");
  });
  try {
    const real = path.join(root, "real");
    const link = path.join(root, "link");
    const parent = path.join(root, "parent");
    const child = path.join(parent, "child");
    const main = path.join(root, "main");
    const wt = path.join(root, "wt");
    mkdirSync(real);
    writeFileSync(path.join(real, "keep.txt"), "real");
    symlinkSync(real, link);
    mkdirSync(child, { recursive: true });
    writeFileSync(path.join(parent, "keep.txt"), "parent");
    writeFileSync(path.join(child, "keep.txt"), "child");
    mkdirSync(path.join(main, ".git", "worktrees", "wt"), { recursive: true });
    mkdirSync(wt);
    writeFileSync(path.join(wt, ".git"), `gitdir: ${path.join(main, ".git", "worktrees", "wt")}\n`);
    writeFileSync(path.join(main, ".git", "worktrees", "wt", "gitdir"), `${path.join(wt, ".git")}\n`);
    writeFileSync(path.join(main, "keep.txt"), "main");
    writeFileSync(path.join(wt, "keep.txt"), "wt");
    const files = () => ({
      real: readFileSync(path.join(real, "keep.txt"), "utf8"),
      parent: readdirSync(parent).sort(),
      child: readFileSync(path.join(child, "keep.txt"), "utf8"),
      main: readFileSync(path.join(main, "keep.txt"), "utf8"),
      wt: readFileSync(path.join(wt, "keep.txt"), "utf8"),
      wtTop: readdirSync(wt).sort(),
    });
    const before = files();
    addProject(db, real, "Real");
    addProject(db, parent, "Parent");
    addProject(db, child, "Child");
    addProject(db, main, "Main");
    const core = new ClusterCore(db, { now: () => 5 });
    const cluster = core.create({ name: "Files" });
    const other = core.create({ name: "Elsewhere" });
    expect(core.assign(cluster.id, link).projectPath).toBe(real);
    expect(() => core.assign(cluster.id, real)).toThrow("already in this cluster");
    core.assign(cluster.id, parent);
    core.assign(cluster.id, main);
    core.assign(other.id, child);
    expect(() => core.assign(cluster.id, wt)).toThrow("not registered");
    addProject(db, wt, "Worktree");
    core.assign(other.id, wt);
    expect(core.resolve(main).cluster?.id).toBe(cluster.id);
    expect(core.resolve(wt).cluster?.id).toBe(other.id);
    const gone = path.join(root, "gone");
    addProject(db, gone, "Gone");
    expect(core.assign(cluster.id, gone).pathMissing).toBe(true);
    expect(files()).toEqual(before);
    expect(spawn).not.toHaveBeenCalled();
  } finally {
    spawn.mockRestore();
    db.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("two registrations of one directory are not guessed", () => {
  const root = mkdtempSync(path.join(tmpdir(), "fo011a-dup-"));
  const db = open();
  try {
    const real = path.join(root, "real");
    const link = path.join(root, "link");
    const other = path.join(root, "other");
    mkdirSync(real);
    symlinkSync(real, link);
    symlinkSync(real, other);
    addProject(db, real, "Real");
    addProject(db, link, "Link");
    const core = new ClusterCore(db, { now: () => 5 });
    const cluster = core.create({ name: "Dup" });
    expect(() => core.assign(cluster.id, other)).toThrow("more than one registered project");
    expect(core.listProjects(cluster.id)).toEqual([]);
    expect(core.assign(cluster.id, real).projectPath).toBe(real);
  } finally {
    db.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("summary reads a snapshot and does not write membership or projects", () => {
  const db = open();
  try {
    const core = coreFor(db);
    addProject(db, "/work/media", "ExampleApp");
    const cluster = core.create({ name: "Alpha" });
    core.assign(cluster.id, "/work/media");
    const before = db.query(`SELECT * FROM cluster_project_memberships`).all();
    const projects = db.query(`SELECT * FROM projects`).all();
    const summary = core.summary(cluster.id, null);
    expect(summary.aggregate.completeness).toBe("unknown");
    expect(summary.aggregate.counts.tasks.value).toBeNull();
    expect(summary.aggregate.memberPaths).toEqual(["/work/media"]);
    expect(db.query(`SELECT * FROM cluster_project_memberships`).all()).toEqual(before);
    expect(db.query(`SELECT * FROM projects`).all()).toEqual(projects);
    expect(db.query(`SELECT COUNT(*) AS n FROM project_managers`).get()).toEqual({ n: 0 });
  } finally {
    db.close();
  }
});
