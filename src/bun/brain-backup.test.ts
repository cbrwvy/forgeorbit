import { Database } from "bun:sqlite";
import { createHash, randomUUID } from "node:crypto";
import { afterEach, expect, test } from "bun:test";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { BackupManager, verifyBackupSnapshot } from "./backup-manager.ts";
import { RestoreError, restoreBackupSnapshot } from "./backup-restore.ts";
import { migrate } from "./migrate.ts";
import { migrations } from "./migrations/index.ts";
import { openBrainStore, type BrainStore } from "./brain-store.ts";
import { captureBrainSnapshot } from "./brain-snapshot.ts";
import { decodeMemoryFile } from "../shared/brain/document.ts";
import type { SnapshotBrainRecord } from "../shared/brain/snapshot.ts";

const ALPHA = "/registry/alpha";
const BETA = "/registry/beta";
const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function projectsOf(paths: string[]) {
  const known = new Set(paths);
  return { isRegistered: (projectPath: string) => known.has(projectPath) };
}

function layout() {
  const root = mkdtempSync(path.join(tmpdir(), "fo-brain-backup-"));
  roots.push(root);
  const dataDir = path.join(root, "profile");
  const active = path.join(root, "active");
  mkdirSync(dataDir, { recursive: true, mode: 0o700 });
  mkdirSync(active, { recursive: true, mode: 0o700 });
  const previousForge = process.env.FORGEORBIT_DATA_DIR;
  const previousAgetor = process.env.AGETOR_DATA_DIR;
  process.env.FORGEORBIT_DATA_DIR = active;
  process.env.AGETOR_DATA_DIR = active;
  const dbPath = path.join(dataDir, "agetor.sqlite");
  const db = new Database(dbPath);
  db.exec("PRAGMA journal_mode = WAL;");
  db.exec("PRAGMA foreign_keys = ON;");
  migrate(db, migrations);
  db.run("INSERT INTO projects (path, name, added_at) VALUES (?, ?, ?)", [ALPHA, "Alpha", 1]);
  db.run("INSERT INTO projects (path, name, added_at) VALUES (?, ?, ?)", [BETA, "Beta", 1]);
  return {
    root,
    dataDir,
    db,
    restoreEnv() {
      if (previousForge === undefined) delete process.env.FORGEORBIT_DATA_DIR;
      else process.env.FORGEORBIT_DATA_DIR = previousForge;
      if (previousAgetor === undefined) delete process.env.AGETOR_DATA_DIR;
      else process.env.AGETOR_DATA_DIR = previousAgetor;
    },
  };
}

function addKnowledge(dataDir: string, db: Database, content: string): string {
  const id = randomUUID();
  const bytes = Buffer.from(content, "utf8");
  const directory = path.join(dataDir, "knowledge", "bodies", id);
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  writeFileSync(path.join(directory, "1.md"), bytes, { mode: 0o600 });
  const sha = createHash("sha256").update(bytes).digest("hex");
  db.run(
    `INSERT INTO knowledge_documents (
       id, owner_kind, owner_id, title, description, category, tags_json, sensitive,
       revision, created_at, updated_at, archived_at, content_sha256, byte_length
     ) VALUES (?, 'project', ?, 'Note', 'Desc', 'general', '[]', 0, 1, 1, 1, NULL, ?, ?)`,
    [id, ALPHA, sha, bytes.length],
  );
  db.run(
    "INSERT INTO knowledge_revisions (document_id, revision, created_at, byte_length, content_sha256) VALUES (?, 1, 1, ?, ?)",
    [id, bytes.length, sha],
  );
  return id;
}

async function snapshotOf(env: ReturnType<typeof layout>, manifestVersion: 1 | 4 = 4) {
  const manager = new BackupManager({ db: env.db, dataDir: env.dataDir });
  const created = await manager.createSnapshot({
    destinationDir: path.join(env.root, "snaps"),
    createDirectory: true,
    manifestVersion,
  });
  return created;
}

function brainRecord(snapshotPath: string): SnapshotBrainRecord | undefined {
  const manifest = JSON.parse(readFileSync(path.join(snapshotPath, "manifest.json"), "utf8")) as {
    brain?: SnapshotBrainRecord;
    files: { path: string }[];
  };
  return manifest.brain;
}

function manifestPaths(snapshotPath: string): string[] {
  const manifest = JSON.parse(readFileSync(path.join(snapshotPath, "manifest.json"), "utf8")) as {
    files: { path: string; sha256: string }[];
  };
  return manifest.files.map((file) => file.path);
}

test("a profile with no Brain directory records an absent category and restores nothing", async () => {
  const env = layout();
  const snap = await snapshotOf(env);
  expect(brainRecord(snap.path)?.coverage).toBe("absent");
  expect(manifestPaths(snap.path).some((file) => file.startsWith("brain/"))).toBe(false);
  const destination = path.join(env.root, "restored-empty");
  await restoreBackupSnapshot(snap.path, destination);
  expect(existsSync(path.join(destination, "brain"))).toBe(false);

  const manifestPath = path.join(snap.path, "manifest.json");
  const legacyManifest = JSON.parse(readFileSync(manifestPath, "utf8")) as { brain?: unknown };
  delete legacyManifest.brain;
  writeFileSync(manifestPath, JSON.stringify(legacyManifest, null, 2));
  const legacy = await verifyBackupSnapshot(snap.path);
  expect(legacy.ok).toBe(true);
  const legacyDestination = path.join(env.root, "restored-legacy-v4");
  await restoreBackupSnapshot(snap.path, legacyDestination);
  expect(existsSync(path.join(legacyDestination, "brain"))).toBe(false);
  env.db.close();
  env.restoreEnv();
});

test("company, project, archived, and revised memories round-trip with hashes intact", async () => {
  const env = layout();
  const knowledgeId = addKnowledge(env.dataDir, env.db, "Knowledge stays beside Brain.");
  const brain = path.join(env.dataDir, "brain");
  const store = openBrainStore(brain, projectsOf([ALPHA, BETA]));
  const company = store.create({
    scopeKind: "company",
    title: "Company fact",
    kind: "fact",
    content: "Company memory stays company scoped.",
  });
  const alpha = store.create({
    scopeKind: "project",
    projectPath: ALPHA,
    title: "Alpha decision",
    kind: "decision",
    content: "Alpha uses worktrees.",
  });
  const beta = store.create({
    scopeKind: "project",
    projectPath: BETA,
    title: "Beta decision",
    kind: "decision",
    content: "Beta keeps its own rule.",
  });
  const revised = store.update(alpha.memory.id, {
    expectedRevision: 1,
    content: "Alpha uses worktrees and reviews.",
  });
  const archived = store.archive(beta.memory.id, 1);
  expect(store.status().backup.includedInProfileSnapshot).toBe(true);
  store.close();

  const snap = await snapshotOf(env);
  const record = brainRecord(snap.path);
  expect(record?.coverage).toBe("included");
  expect(record?.memoryCount).toBe(3);
  expect(record?.archivedCount).toBe(1);
  expect(record?.revisionCount).toBe(5);
  expect(record?.pendingExcluded).toBe(0);
  expect(manifestPaths(snap.path)).toContain("brain/index.sqlite");
  expect(manifestPaths(snap.path)).toContain(`brain/memories/${company.memory.id}.md`);
  expect(manifestPaths(snap.path)).toContain(`brain/revisions/${alpha.memory.id}/1.md`);
  expect(manifestPaths(snap.path).some((file) => file.includes("provider") || file.endsWith("credentials.txt"))).toBe(false);

  const destination = path.join(env.root, "restored-full");
  await restoreBackupSnapshot(snap.path, destination);
  expect(existsSync(path.join(destination, "knowledge", "bodies", knowledgeId, "1.md"))).toBe(true);
  expect(readFileSync(path.join(destination, "knowledge", "bodies", knowledgeId, "1.md"), "utf8")).toBe(
    "Knowledge stays beside Brain.",
  );

  const restored = openBrainStore(path.join(destination, "brain"), projectsOf([ALPHA, BETA]));
  const companyRead = restored.read(company.memory.id);
  const alphaRead = restored.read(revised.id);
  expect(companyRead.content).toBe("Company memory stays company scoped.");
  expect(companyRead.contentSha256).toBe(company.memory.contentSha256);
  expect(companyRead.role).toBe("data");
  expect(companyRead.executable).toBe(false);
  expect(companyRead.scope).toEqual({ kind: "company", id: company.memory.scope.id });
  expect(alphaRead.content).toBe("Alpha uses worktrees and reviews.");
  expect(alphaRead.revision).toBe(2);
  expect(alphaRead.contentSha256).toBe(revised.contentSha256);
  const oldRevision = decodeMemoryFile(
    readFileSync(path.join(destination, "brain", "revisions", alpha.memory.id, "1.md"), "utf8"),
  );
  expect(oldRevision.ok && oldRevision.body).toBe("Alpha uses worktrees.");
  expect(restored.read(archived.id).status).toBe("archived");
  const activeAlpha = restored.list({
    scopeKind: "project",
    projectPath: ALPHA,
    inheritCompany: false,
    text: "",
    status: "active",
    limit: 20,
  });
  expect(activeAlpha.memories.map((item) => item.id)).toEqual([alpha.memory.id]);
  expect(JSON.stringify(activeAlpha)).not.toContain(beta.memory.id);
  expect(JSON.stringify(activeAlpha)).not.toContain("Beta keeps");
  restored.close();

  const reopened = openBrainStore(path.join(destination, "brain"), projectsOf([ALPHA, BETA]));
  expect(reopened.read(alpha.memory.id).contentSha256).toBe(revised.contentSha256);
  reopened.close();
  env.db.close();
  env.restoreEnv();
});

test("an empty Brain store is included with zero memories", async () => {
  const env = layout();
  const store = openBrainStore(path.join(env.dataDir, "brain"), projectsOf([ALPHA]));
  store.close();
  const snap = await snapshotOf(env);
  expect(brainRecord(snap.path)).toMatchObject({ coverage: "included", memoryCount: 0, archivedCount: 0 });
  const destination = path.join(env.root, "restored-zero");
  await restoreBackupSnapshot(snap.path, destination);
  const restored = openBrainStore(path.join(destination, "brain"), projectsOf([ALPHA]));
  expect(restored.list({
    scopeKind: "company",
    inheritCompany: false,
    text: "",
    status: "active",
    limit: 20,
  }).memories).toHaveLength(0);
  restored.close();
  env.db.close();
  env.restoreEnv();
});

test("pending writes are excluded and a failed or legacy restore leaves existing Brain data", async () => {
  const env = layout();
  const store = openBrainStore(path.join(env.dataDir, "brain"), projectsOf([ALPHA, BETA]), {
    hooks: {
      afterPendingInsert() {
        throw new Error("stop before the file write");
      },
    },
  });
  let pendingStore: BrainStore = store;
  expect(() => pendingStore.create({
    scopeKind: "company",
    title: "Unfinished",
    kind: "observation",
    content: "This write never committed.",
  })).toThrow(/stop before/);
  store.close();
  const healthy = openBrainStore(path.join(env.dataDir, "brain"), projectsOf([ALPHA, BETA]));
  const kept = healthy.create({
    scopeKind: "company",
    title: "Kept",
    kind: "fact",
    content: "This committed memory stays.",
  });
  healthy.close();
  const before = readFileSync(path.join(env.dataDir, "brain", "index.sqlite"));

  const snap = await snapshotOf(env);
  expect(brainRecord(snap.path)?.pendingExcluded).toBe(1);
  expect(manifestPaths(snap.path).join("\n")).not.toContain("Unfinished");
  const destination = path.join(env.root, "restored-pending");
  await restoreBackupSnapshot(snap.path, destination);
  const restored = openBrainStore(path.join(destination, "brain"), projectsOf([ALPHA]));
  expect(restored.read(kept.memory.id).content).toBe("This committed memory stays.");
  expect(restored.list({
    scopeKind: "company",
    inheritCompany: false,
    text: "Unfinished",
    status: "active",
    limit: 20,
  }).memories).toHaveLength(0);
  restored.close();

  const legacy = await snapshotOf(env, 1);
  expect(brainRecord(legacy.path)).toBeUndefined();
  expect(manifestPaths(legacy.path).some((file) => file.startsWith("brain/"))).toBe(false);
  const legacyDest = path.join(env.root, "restored-legacy");
  await restoreBackupSnapshot(legacy.path, legacyDest);
  expect(existsSync(path.join(legacyDest, "brain"))).toBe(false);
  expect(readFileSync(path.join(env.dataDir, "brain", "index.sqlite")).equals(before)).toBe(true);

  const strippedManifestPath = path.join(snap.path, "manifest.json");
  const stripped = JSON.parse(readFileSync(strippedManifestPath, "utf8")) as { brain?: unknown };
  delete stripped.brain;
  writeFileSync(strippedManifestPath, JSON.stringify(stripped, null, 2));
  const strippedVerify = await verifyBackupSnapshot(snap.path);
  expect(strippedVerify.ok).toBe(false);

  await expect(restoreBackupSnapshot(snap.path, path.join(env.dataDir))).rejects.toBeInstanceOf(RestoreError);
  expect(readFileSync(path.join(env.dataDir, "brain", "index.sqlite")).equals(before)).toBe(true);
  env.db.close();
  env.restoreEnv();
});

test("corrupted, missing, symlink, and traversal snapshots are rejected without publishing", async () => {
  const env = layout();
  const store = openBrainStore(path.join(env.dataDir, "brain"), projectsOf([ALPHA]));
  const saved = store.create({
    scopeKind: "project",
    projectPath: ALPHA,
    title: "Stable",
    kind: "fact",
    content: "Original memory bytes.",
  });
  store.close();
  const snap = await snapshotOf(env);
  const memoryPath = path.join(snap.path, "brain", "memories", `${saved.memory.id}.md`);
  const original = readFileSync(memoryPath);
  writeFileSync(memoryPath, original.toString("utf8").replace("Original", "Tampered"));
  const corruptFile = await verifyBackupSnapshot(snap.path);
  expect(corruptFile.ok).toBe(false);
  const missingDest = path.join(env.root, "not-published");
  await expect(restoreBackupSnapshot(snap.path, missingDest)).rejects.toBeInstanceOf(RestoreError);
  expect(existsSync(missingDest)).toBe(false);

  writeFileSync(memoryPath, original);
  const indexPath = path.join(snap.path, "brain", "index.sqlite");
  const index = readFileSync(indexPath);
  index[index.length - 1] = index[index.length - 1]! ^ 0xff;
  writeFileSync(indexPath, index);
  const corruptIndex = await verifyBackupSnapshot(snap.path);
  expect(corruptIndex.ok).toBe(false);
  expect(corruptIndex.issues.some((issue) => issue.startsWith("Brain ") || issue.includes("Checksum mismatch"))).toBe(true);

  writeFileSync(indexPath, readFileSync(path.join(env.dataDir, "brain", "index.sqlite")));
  unlinkSync(memoryPath);
  const missing = await verifyBackupSnapshot(snap.path);
  expect(missing.ok).toBe(false);
  expect(missing.issues.some((issue) => issue.includes(saved.memory.id) || issue.includes("missing"))).toBe(true);

  const manifestPath = path.join(snap.path, "manifest.json");
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as { files: { path: string }[] };
  manifest.files.push({ path: "brain/../../secret.txt", bytes: 1, sha256: "ab".repeat(32) } as { path: string });
  writeFileSync(manifestPath, JSON.stringify(manifest));
  const traversal = await verifyBackupSnapshot(snap.path);
  expect(traversal.ok).toBe(false);
  expect(traversal.issues.some((issue) => /traversal|Illegal|not allowed|unexpected/i.test(issue))).toBe(true);

  const outside = path.join(env.root, "outside-secret.txt");
  writeFileSync(outside, "secret");
  const liveFile = path.join(env.dataDir, "brain", "memories", `${saved.memory.id}.md`);
  unlinkSync(liveFile);
  symlinkSync(outside, liveFile);
  await expect(snapshotOf(env)).rejects.toMatchObject({ code: "UNTRUSTED_SYMLINK" });
  expect(readFileSync(outside, "utf8")).toBe("secret");
  env.db.close();
  env.restoreEnv();
});

test("orphaned project identities stay on their original path and a locked index does not publish a mixed snapshot", async () => {
  const env = layout();
  writeFileSync(path.join(env.dataDir, "provider-auth.json"), "sk-not-a-real-token");
  const store = openBrainStore(path.join(env.dataDir, "brain"), projectsOf([ALPHA, BETA]));
  const alpha = store.create({
    scopeKind: "project",
    projectPath: ALPHA,
    title: "Alpha only",
    kind: "fact",
    content: "Stay on Alpha.",
  });
  store.close();
  writeFileSync(path.join(env.dataDir, "brain", "credentials.txt"), "ghp_should_not_be_packaged");
  const snap = await snapshotOf(env);
  expect(manifestPaths(snap.path)).not.toContain("provider-auth.json");
  expect(manifestPaths(snap.path)).not.toContain("brain/credentials.txt");
  expect(brainRecord(snap.path)?.orphanedProjectCount).toBe(0);

  const destination = path.join(env.root, "restored-orphan");
  await restoreBackupSnapshot(snap.path, destination);
  const orphaned = openBrainStore(path.join(destination, "brain"), projectsOf([BETA]));
  expect(orphaned.status().orphanedProjects).toEqual([{ scopeId: ALPHA, count: 1 }]);
  expect(orphaned.read(alpha.memory.id).scope).toEqual({ kind: "project", id: ALPHA });
  expect(orphaned.list({
    scopeKind: "project",
    projectPath: BETA,
    inheritCompany: false,
    text: "",
    status: "active",
    limit: 20,
  }).memories).toHaveLength(0);
  orphaned.close();

  const holder = new Database(path.join(env.dataDir, "brain", "index.sqlite"));
  holder.run("BEGIN IMMEDIATE");
  let busy: unknown;
  try {
    captureBrainSnapshot({
      sourceRoot: path.join(env.dataDir, "brain"),
      stagingDir: path.join(env.root, "busy-staging"),
      registeredProjectPaths: [ALPHA],
    });
  } catch (error) {
    busy = error;
  }
  expect(busy).toMatchObject({ code: "busy" });
  holder.run("ROLLBACK");
  holder.close();
  expect(readFileSync(path.join(env.dataDir, "brain", "memories", `${alpha.memory.id}.md`), "utf8")).toContain("Stay on Alpha.");
  env.db.close();
  env.restoreEnv();
});

test("a symlink inside a published snapshot is rejected", async () => {
  const env = layout();
  const store = openBrainStore(path.join(env.dataDir, "brain"), projectsOf([ALPHA]));
  const saved = store.create({
    scopeKind: "company",
    title: "Linked",
    kind: "fact",
    content: "Do not follow links.",
  });
  store.close();
  const snap = await snapshotOf(env);
  const memoryPath = path.join(snap.path, "brain", "memories", `${saved.memory.id}.md`);
  const replacement = path.join(env.root, "other.md");
  writeFileSync(replacement, readFileSync(memoryPath));
  unlinkSync(memoryPath);
  symlinkSync(replacement, memoryPath);
  expect(lstatSync(memoryPath).isSymbolicLink()).toBe(true);
  const verified = await verifyBackupSnapshot(snap.path);
  expect(verified.ok).toBe(false);
  expect(verified.issues.some((issue) => /symlink|symbolic/i.test(issue))).toBe(true);
  env.db.close();
  env.restoreEnv();
});
