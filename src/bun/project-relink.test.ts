import { Database } from "bun:sqlite";
import { afterEach, expect, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { migrate } from "./migrate.ts";
import { migrations } from "./migrations/index.ts";
import { openBrainStore } from "./brain-store.ts";
import { relinkProject, validateProjectRelink } from "./project-relink.ts";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

function setup() {
  const root = mkdtempSync(path.join(tmpdir(), "fo-relink-test-"));
  roots.push(root);
  const dataDir = path.join(root, "data");
  mkdirSync(dataDir, { recursive: true, mode: 0o700 });

  const oldAlphaDirRaw = path.join(root, "old-alpha");
  const newAlphaDirRaw = path.join(root, "new-alpha");
  const betaDirRaw = path.join(root, "beta");
  mkdirSync(oldAlphaDirRaw, { recursive: true });
  mkdirSync(newAlphaDirRaw, { recursive: true });
  mkdirSync(betaDirRaw, { recursive: true });
  const oldAlphaDir = realpathSync(oldAlphaDirRaw);
  const newAlphaDir = realpathSync(newAlphaDirRaw);
  const betaDir = realpathSync(betaDirRaw);

  const dbPath = path.join(dataDir, "agetor.sqlite");
  const db = new Database(dbPath);
  db.exec("PRAGMA journal_mode = WAL;");
  db.exec("PRAGMA foreign_keys = ON;");
  migrate(db, migrations);

  // Seed projects
  db.run("INSERT INTO projects (path, name, added_at) VALUES (?, ?, ?)", [oldAlphaDir, "Alpha", 1000]);
  db.run("INSERT INTO projects (path, name, added_at) VALUES (?, ?, ?)", [betaDir, "Beta", 1001]);

  // Seed tasks
  db.run(
    "INSERT INTO tasks (id, title, prompt, column, agent, workdir, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
    ["task-1", "Task 1", "prompt 1", "running", "agent-1", oldAlphaDir, 1000, 1000],
  );
  db.run(
    "INSERT INTO tasks (id, title, prompt, column, agent, workdir, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
    ["task-2", "Task 2", "prompt 2", "todo", "agent-1", betaDir, 1001, 1001],
  );

  // Seed cluster and membership
  db.run(
    "INSERT INTO clusters (id, name, created_at, updated_at) VALUES (?, ?, ?, ?)",
    ["cluster-1", "Cluster 1", 1000, 1000],
  );
  db.run(
    "INSERT INTO cluster_project_memberships (project_path, cluster_id, assigned_at, updated_at) VALUES (?, ?, ?, ?)",
    [oldAlphaDir, "cluster-1", 1000, 1000],
  );

  // Seed Brain memories
  const brainStore = openBrainStore(
    path.join(dataDir, "brain"),
    { isRegistered: (p: string) => p === oldAlphaDir || p === betaDir },
  );

  const alphaMemory = brainStore.create({
    scopeKind: "project",
    projectPath: oldAlphaDir,
    title: "Alpha Architecture",
    kind: "decision",
    content: "Alpha uses React + Bun.",
  });

  const betaMemory = brainStore.create({
    scopeKind: "project",
    projectPath: betaDir,
    title: "Beta Secrets",
    kind: "fact",
    content: "Beta is confidential.",
  });

  const companyMemory = brainStore.create({
    scopeKind: "company",
    title: "Company Charter",
    kind: "fact",
    content: "Safety first.",
  });

  return {
    root,
    dataDir,
    oldAlphaDir,
    newAlphaDir,
    betaDir,
    db,
    brainStore,
    alphaMemoryId: alphaMemory.memory.id,
    betaMemoryId: betaMemory.memory.id,
    companyMemoryId: companyMemory.memory.id,
  };
}

test("relinkProject: successfully updates database tables, brain scopes, and preserves content", () => {
  const env = setup();
  const canonicalNewAlpha = realpathSync(env.newAlphaDir);

  const res = relinkProject(
    { oldPath: env.oldAlphaDir, newPath: env.newAlphaDir },
    { db: env.db, dataDir: env.dataDir, brainStore: env.brainStore },
  );
  expect(res.ok).toBe(true);

  expect(res.newPath).toBe(canonicalNewAlpha);
  expect(res.reboundBrainMemories).toBe(1);

  // 1. Verify projects table
  const oldProj = env.db.query("SELECT * FROM projects WHERE path = ?").get(env.oldAlphaDir);
  expect(oldProj).toBeNull();
  const newProj = env.db.query<{ path: string; name: string }, [string]>("SELECT * FROM projects WHERE path = ?").get(canonicalNewAlpha);
  expect(newProj?.path).toBe(canonicalNewAlpha);
  expect(newProj?.name).toBe("Alpha");

  // 2. Verify tasks table
  const task1 = env.db.query<{ workdir: string }, [string]>("SELECT workdir FROM tasks WHERE id = ?").get("task-1");
  expect(task1?.workdir).toBe(canonicalNewAlpha);
  const task2 = env.db.query<{ workdir: string }, [string]>("SELECT workdir FROM tasks WHERE id = ?").get("task-2");
  expect(task2?.workdir).toBe(env.betaDir);

  // 3. Verify cluster membership
  const membership = env.db.query<{ project_path: string }, [string]>("SELECT project_path FROM cluster_project_memberships WHERE cluster_id = ?").get("cluster-1");
  expect(membership?.project_path).toBe(canonicalNewAlpha);

  // 4. Verify foreign key consistency
  const fkCheck = env.db.query("PRAGMA foreign_key_check").all();
  expect(fkCheck.length).toBe(0);

  // 5. Verify Brain memories
  const newBrainStore = openBrainStore(
    path.join(env.dataDir, "brain"),
    { isRegistered: (p: string) => p === canonicalNewAlpha || p === env.betaDir },
  );

  const updatedAlpha = newBrainStore.read(env.alphaMemoryId);
  expect(updatedAlpha).not.toBeNull();
  expect(updatedAlpha.scope.kind).toBe("project");
  if (updatedAlpha.scope.kind === "project") {
    expect(updatedAlpha.scope.id).toBe(canonicalNewAlpha);
  }
  expect(updatedAlpha.title).toBe("Alpha Architecture");
  expect(updatedAlpha.content).toBe("Alpha uses React + Bun.");

  // 6. Beta memory untouched
  const updatedBeta = newBrainStore.read(env.betaMemoryId);
  expect(updatedBeta).not.toBeNull();
  if (updatedBeta.scope.kind === "project") {
    expect(updatedBeta.scope.id).toBe(env.betaDir);
  }

  // 7. Company memory untouched
  const updatedCompany = newBrainStore.read(env.companyMemoryId);
  expect(updatedCompany).not.toBeNull();
  expect(updatedCompany.scope.kind).toBe("company");
});

test("relinkProject: idempotent when oldPath equals newPath", () => {
  const env = setup();
  const res = relinkProject(
    { oldPath: env.oldAlphaDir, newPath: env.oldAlphaDir },
    { db: env.db, dataDir: env.dataDir, brainStore: env.brainStore },
  );
  expect(res.ok).toBe(true);
  expect(res.reboundBrainMemories).toBe(0);
  expect(res.newPath).toBe(path.resolve(env.oldAlphaDir));
});

test("validateProjectRelink: rejects unregistered oldPath", () => {
  const env = setup();
  const nonExistent = path.join(env.root, "not-registered");
  mkdirSync(nonExistent, { recursive: true });
  expect(() => validateProjectRelink(nonExistent, env.newAlphaDir, env.db, env.dataDir)).toThrow(
    /is not registered/,
  );
});

test("validateProjectRelink: rejects missing newPath", () => {
  const env = setup();
  const nonExistent = path.join(env.root, "does-not-exist");
  expect(() => validateProjectRelink(env.oldAlphaDir, nonExistent, env.db, env.dataDir)).toThrow(
    /does not exist/,
  );
});

test("validateProjectRelink: rejects file as newPath", () => {
  const env = setup();
  const filePath = path.join(env.root, "some-file.txt");
  writeFileSync(filePath, "hello");
  expect(() => validateProjectRelink(env.oldAlphaDir, filePath, env.db, env.dataDir)).toThrow(
    /is not a directory/,
  );
});

test("validateProjectRelink: rejects symlinked newPath", () => {
  const env = setup();
  const targetDir = path.join(env.root, "target-dir");
  mkdirSync(targetDir, { recursive: true });
  const symlinkPath = path.join(env.root, "symlink-dir");
  symlinkSync(targetDir, symlinkPath);

  expect(() => validateProjectRelink(env.oldAlphaDir, symlinkPath, env.db, env.dataDir)).toThrow(
    /Symbolic links are not permitted/,
  );
});

test("validateProjectRelink: rejects duplicate project collision", () => {
  const env = setup();
  expect(() => validateProjectRelink(env.oldAlphaDir, env.betaDir, env.db, env.dataDir)).toThrow(
    /already assigned to project|Directory already resolves to project/,
  );
});

test("validateProjectRelink: rejects protected path traversal into dataDir", () => {
  const env = setup();
  const insideData = path.join(env.dataDir, "sub");
  mkdirSync(insideData, { recursive: true });
  expect(() => validateProjectRelink(env.oldAlphaDir, insideData, env.db, env.dataDir)).toThrow(
    /protected/,
  );
});
