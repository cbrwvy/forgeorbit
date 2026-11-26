import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { FORGEORBIT_COMPANY } from "../shared/clusters/types.ts";
import type { KnowledgeCreateInput } from "../shared/knowledge/document.ts";
import { ClusterCore } from "./cluster-core.ts";
import { KnowledgeCore } from "./knowledge-core.ts";
import { createKnowledgeFiles } from "./knowledge-files.ts";
import { migrate } from "./migrate.ts";
import { migrations } from "./migrations/index.ts";

function note(owner: KnowledgeCreateInput["owner"], title: string, content: string, extra: Partial<KnowledgeCreateInput> = {}): KnowledgeCreateInput {
  return {
    owner,
    title,
    description: extra.description ?? "",
    category: extra.category ?? "general",
    tags: extra.tags ?? [],
    content,
    sensitive: extra.sensitive ?? false,
  };
}

function harness(root = mkdtempSync(path.join(tmpdir(), "fo011c-core-"))) {
  const db = new Database(":memory:");
  db.run("PRAGMA foreign_keys = ON");
  migrate(db, migrations);
  const files = createKnowledgeFiles(path.join(root, "knowledge"));
  const core = new KnowledgeCore(db, files, { now: () => 1_700_000_000_000 });
  const clusters = new ClusterCore(db, { now: () => 1_700_000_000_000, pathExists: () => false, realpath: () => null });
  return { root, db, files, core, clusters };
}

function addProject(db: Database, projectPath: string, name: string): void {
  db.run(`INSERT INTO projects (path, name, added_at) VALUES (?, ?, 1)`, [projectPath, name]);
}

test("company, cluster, and project notes stay with that owner", () => {
  const { db, core, clusters } = harness();
  addProject(db, "/registry/alpha", "Alpha");
  const cluster = clusters.create({ name: "Lunarian Forge" });
  clusters.assign(cluster.id, "/registry/alpha");
  const company = core.create(note({ kind: "company", id: FORGEORBIT_COMPANY.id }, "Git conventions", "# Git"));
  const grouped = core.create(note({ kind: "cluster", id: cluster.id }, "CI agreement", "Use one pipeline.", { category: "agreements", tags: ["ci"] }));
  const project = core.create(note({ kind: "project", id: "/registry/alpha" }, "Alpha decisions", "Ship the editor."));
  expect(company.owner).toEqual({ kind: "company", id: FORGEORBIT_COMPANY.id });
  expect(core.list({ kind: "company", id: FORGEORBIT_COMPANY.id }).documents.map((item) => item.id)).toEqual([company.id]);
  expect(core.list({ kind: "cluster", id: cluster.id }).documents.map((item) => item.title)).toEqual(["CI agreement"]);
  expect(core.list({ kind: "project", id: "/registry/alpha" }).documents.map((item) => item.id)).toEqual([project.id]);
  expect(grouped.tags).toEqual(["ci"]);
  expect(() => core.create(note({ kind: "cluster", id: "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee" }, "Missing", "x"))).toThrow("Cluster not found");
  expect(() => core.create(note({ kind: "project", id: "/registry/missing" }, "Missing", "x"))).toThrow("not registered");
});

test("an unassigned project sees company and itself, not another cluster", () => {
  const { db, core, clusters } = harness();
  addProject(db, "/registry/free", "Free");
  addProject(db, "/registry/alpha", "Alpha");
  const cluster = clusters.create({ name: "Other" });
  clusters.assign(cluster.id, "/registry/alpha");
  core.create(note({ kind: "company", id: FORGEORBIT_COMPANY.id }, "Company", "shared"));
  core.create(note({ kind: "cluster", id: cluster.id }, "Other cluster", "private-cluster"));
  core.create(note({ kind: "project", id: "/registry/free" }, "Free note", "only-free"));
  const scope = core.scope("/registry/free");
  expect(scope.cluster).toBeNull();
  expect(scope.documents.map((item) => item.title).sort()).toEqual(["Company", "Free note"]);
  expect(scope.note).toContain("does not send notes to a model");
  expect(JSON.stringify(scope)).not.toContain("private-cluster");
});

test("archiving a cluster keeps its notes, and moving a project does not move notes", () => {
  const { db, core, clusters, root } = harness();
  const projectDir = path.join(root, "alpha-repo");
  mkdirSync(projectDir);
  writeFileSync(path.join(projectDir, "IDEA.md"), "do not touch\n");
  addProject(db, projectDir, "Alpha");
  const first = clusters.create({ name: "First" });
  const second = clusters.create({ name: "Second" });
  clusters.assign(first.id, projectDir);
  const clusterNote = core.create(note({ kind: "cluster", id: first.id }, "First agreement", "stay-here"));
  const projectNote = core.create(note({ kind: "project", id: projectDir }, "Alpha note", "project-text"));
  clusters.archive(first.id);
  expect(core.read(clusterNote.id).content).toBe("stay-here");
  expect(core.read(clusterNote.id).owner).toEqual({ kind: "cluster", id: first.id });
  clusters.move(second.id, projectDir);
  const scope = core.scope(projectDir);
  expect(scope.cluster?.id).toBe(second.id);
  expect(scope.documents.map((item) => item.id)).toEqual([projectNote.id]);
  expect(core.read(clusterNote.id).owner.id).toBe(first.id);
  expect(core.read(projectNote.id).owner).toEqual({ kind: "project", id: projectDir });
  expect(readFileSync(path.join(projectDir, "IDEA.md"), "utf8")).toBe("do not touch\n");
  expect(readdirSync(projectDir)).toEqual(["IDEA.md"]);
});

test("markdown survives a sqlite restart, rename, tags, search, archive, and export metadata", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "fo011c-restart-"));
  const file = path.join(dir, "knowledge.sqlite");
  const root = path.join(dir, "knowledge");
  const db = new Database(file);
  db.run("PRAGMA foreign_keys = ON");
  migrate(db, migrations);
  const files = createKnowledgeFiles(root);
  const core = new KnowledgeCore(db, files, { now: () => 20 });
  const created = core.create(note(
    { kind: "company", id: FORGEORBIT_COMPANY.id },
    "Deploy notes",
    "Run the staging checklist.",
    { category: "deployment", tags: ["staging"], description: "How we deploy" },
  ));
  const renamed = core.update(created.id, { expectedRevision: 1, title: "Deployment notes", tags: ["staging", "runbook"] });
  expect(renamed.revision).toBe(2);
  expect(renamed.title).toBe("Deployment notes");
  db.close();
  const reopened = new Database(file);
  const restored = new KnowledgeCore(reopened, files, { now: () => 30 });
  expect(restored.read(created.id).content).toBe("Run the staging checklist.");
  expect(restored.read(created.id, 1).content).toBe("Run the staging checklist.");
  const found = restored.search({ query: "checklist", owner: { kind: "company", id: FORGEORBIT_COMPANY.id }, limit: 10 });
  expect(found.hits.map((hit) => hit.document.id)).toEqual([created.id]);
  expect(found.hits[0]?.snippet).toContain("checklist");
  const byTag = restored.list({ kind: "company", id: FORGEORBIT_COMPANY.id }, { tag: "runbook" });
  expect(byTag.documents).toHaveLength(1);
  const archived = restored.archive(created.id, 2);
  expect(archived.archivedAt).toBe(30);
  expect(restored.list({ kind: "company", id: FORGEORBIT_COMPANY.id }).documents).toHaveLength(0);
  expect(restored.restore(created.id, 2).archivedAt).toBeNull();
  restored.archive(created.id, 2);
  restored.remove(created.id, 2);
  expect(() => restored.read(created.id)).toThrow("Note not found");
  const bodyDir = path.join(root, "bodies", created.id);
  expect(!existsSync(bodyDir) || !readdirSync(bodyDir).some((name) => name.endsWith(".md"))).toBe(true);
  reopened.close();
});

test("a stale write cannot replace a newer note, and a failed commit keeps the previous markdown", () => {
  const { db, files, core } = harness();
  const created = core.create(note({ kind: "company", id: FORGEORBIT_COMPANY.id }, "Live", "version-one"));
  core.update(created.id, { expectedRevision: 1, content: "version-two" });
  expect(() => core.update(created.id, { expectedRevision: 1, content: "version-old" })).toThrow("newer edit");
  expect(core.read(created.id).content).toBe("version-two");
  const flaky = new KnowledgeCore(db, files, {
    now: () => 40,
    beforeCommit: () => { throw new Error("commit failed"); },
  });
  expect(() => flaky.update(created.id, { expectedRevision: 2, content: "version-lost" })).toThrow("Knowledge operation failed");
  expect(core.read(created.id).content).toBe("version-two");
  expect(core.read(created.id).revision).toBe(2);
  expect(() => flaky.create(note({ kind: "company", id: FORGEORBIT_COMPANY.id }, "Ghost", "should-not-land"))).toThrow("Knowledge operation failed");
  expect(core.list({ kind: "company", id: FORGEORBIT_COMPANY.id }).documents).toHaveLength(1);
});

test("search stays inside one project, a sensitive note has no excerpt, and delete does not remove the project", () => {
  const { db, core, root } = harness();
  const projectDir = path.join(root, "repo");
  mkdirSync(projectDir);
  writeFileSync(path.join(projectDir, "keep.txt"), "project");
  addProject(db, "/registry/alpha", "Alpha");
  addProject(db, "/registry/beta", "Beta");
  addProject(db, projectDir, "Repo");
  core.create(note({ kind: "project", id: "/registry/alpha" }, "Alpha secret", "alpha-only-token-text", { sensitive: true }));
  core.create(note({ kind: "project", id: "/registry/beta" }, "Beta", "beta-only"));
  const hits = core.search({ query: "alpha-only", projectPath: "/registry/beta", limit: 10 });
  expect(hits.hits).toEqual([]);
  const own = core.search({ query: "alpha-only", projectPath: "/registry/alpha", limit: 10 });
  expect(own.hits).toHaveLength(1);
  expect(own.hits[0]?.snippet).toBeNull();
  const repoNote = core.create(note({ kind: "project", id: projectDir }, "Repo note", "inside"));
  core.archive(repoNote.id, 1);
  core.remove(repoNote.id, 1);
  expect(db.query(`SELECT path FROM projects WHERE path = ?`).get(projectDir)).toEqual({ path: projectDir });
  expect(readFileSync(path.join(projectDir, "keep.txt"), "utf8")).toBe("project");
});

test("knowledge storage does not start a model or log note text", () => {
  for (const file of ["knowledge-core.ts", "knowledge-http.ts", "knowledge-files.ts"]) {
    const source = readFileSync(new URL(`./${file}`, import.meta.url), "utf8");
    expect(source).not.toMatch(/child_process|Bun\.spawn|from "\.\/agents|from "\.\/orchestrator/);
    expect(source).not.toMatch(/console\.(log|info|debug|warn|error)/);
  }
});

test("search result count is capped", () => {
  const { core } = harness();
  for (let index = 0; index < 3; index++) {
    core.create(note({ kind: "company", id: FORGEORBIT_COMPANY.id }, `Note ${index}`, "shared-needle"));
  }
  const found = core.search({ query: "shared-needle", owner: { kind: "company", id: FORGEORBIT_COMPANY.id }, limit: 2 });
  expect(found.hits).toHaveLength(2);
  expect(found.truncated).toBe(true);
});

test("a competing SQLite connection cannot overwrite or remove the winning body", () => {
  const root = mkdtempSync(path.join(tmpdir(), "fo011c-contention-"));
  const filename = path.join(root, "index.sqlite");
  const db = new Database(filename);
  db.run("PRAGMA journal_mode = WAL");
  migrate(db, migrations);
  const other = new Database(filename);
  other.run("PRAGMA busy_timeout = 0");
  const files = createKnowledgeFiles(path.join(root, "knowledge"));
  const initial = new KnowledgeCore(db, files);
  const created = initial.create(note({ kind: "company", id: FORGEORBIT_COMPANY.id }, "Concurrent", "original"));
  const competitor = new KnowledgeCore(other, files);
  let rejected = false;
  const writer = new KnowledgeCore(db, files, {
    beforeCommit: () => {
      try {
        competitor.update(created.id, { expectedRevision: 1, content: "competing body" });
      } catch {
        rejected = true;
      }
    },
  });
  try {
    expect(writer.update(created.id, { expectedRevision: 1, content: "winning body" }).revision).toBe(2);
    expect(rejected).toBe(true);
    expect(competitor.read(created.id).content).toBe("winning body");
    expect(() => competitor.update(created.id, { expectedRevision: 1, content: "stale" })).toThrow("newer edit");
    expect(initial.read(created.id, 1).content).toBe("original");
    expect(initial.read(created.id, 2).content).toBe("winning body");
  } finally {
    other.close();
    db.close();
  }
});

test("search never returns text from a body changed outside the revision store", () => {
  const { core, root } = harness();
  const owner = { kind: "company" as const, id: FORGEORBIT_COMPANY.id };
  const created = core.create(note(owner, "Untampered title", "original"));
  writeFileSync(path.join(root, "knowledge", "bodies", created.id, "1.md"), "injected-external-text");
  expect(() => core.read(created.id)).toThrow("does not match");
  expect(core.search({ query: "injected-external-text", owner, limit: 10 }).hits).toEqual([]);
});

test("a process exit between durable body and SQLite commit restores the previous revision", () => {
  const root = mkdtempSync(path.join(tmpdir(), "fo011c-crash-"));
  const filename = path.join(root, "index.sqlite");
  const db = new Database(filename);
  db.run("PRAGMA journal_mode = WAL");
  migrate(db, migrations);
  const files = createKnowledgeFiles(path.join(root, "knowledge"));
  const created = new KnowledgeCore(db, files).create(note({ kind: "company", id: FORGEORBIT_COMPANY.id }, "Recover", "committed"));
  db.close();
  const child = Bun.spawnSync([process.execPath, "-e", `
    import { Database } from 'bun:sqlite';
    import { KnowledgeCore } from ${JSON.stringify(new URL("./knowledge-core.ts", import.meta.url).pathname)};
    import { createKnowledgeFiles } from ${JSON.stringify(new URL("./knowledge-files.ts", import.meta.url).pathname)};
    const db = new Database(${JSON.stringify(filename)});
    const core = new KnowledgeCore(db, createKnowledgeFiles(${JSON.stringify(path.join(root, "knowledge"))}), {
      beforeCommit: () => process.exit(73),
    });
    core.update(${JSON.stringify(created.id)}, { expectedRevision: 1, content: 'uncommitted orphan' });
  `], { env: process.env, stdout: "pipe", stderr: "pipe" });
  expect(child.exitCode).toBe(73);
  expect(readFileSync(path.join(root, "knowledge", "bodies", created.id, "2.md"), "utf8")).toBe("uncommitted orphan");
  const reopened = new Database(filename);
  try {
    const restored = new KnowledgeCore(reopened, files);
    expect(restored.read(created.id).content).toBe("committed");
    expect(restored.revisions(created.id).map(row => row.revision)).toEqual([1]);
    expect(restored.update(created.id, { expectedRevision: 1, content: "recovered edit" }).revision).toBe(2);
    expect(restored.read(created.id).content).toBe("recovered edit");
    expect(reopened.query("PRAGMA foreign_key_check").all()).toEqual([]);
  } finally {
    reopened.close();
  }
});

test("a pruning rollback leaves every retained revision readable", () => {
  const { db, core } = harness();
  const created = core.create(note({ kind: "company", id: FORGEORBIT_COMPANY.id }, "History", "body 1"));
  db.run(`CREATE TRIGGER fail_prune BEFORE DELETE ON knowledge_revisions WHEN OLD.revision = 1 BEGIN SELECT RAISE(ABORT, 'prune failure'); END`);
  for (let revision = 1; revision < 32; revision++) {
    core.update(created.id, { expectedRevision: revision, content: `body ${revision + 1}` });
  }
  expect(core.revisions(created.id)).toHaveLength(32);
  for (const row of core.revisions(created.id)) {
    expect(core.read(created.id, row.revision).content).toBe(`body ${row.revision}`);
  }
});
