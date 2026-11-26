/**
 * FO-P2-003-R5A: Complete Profile Integrity and Coverage Remediation Test Suite.
 *
 * Deterministic test coverage for:
 * 1. Database from profile A with active data directory pointing to profile B.
 * 2. Missing dataDir and mismatched source profile root.
 * 3. Explicit correct profile root.
 * 4. Snapshot with absolute attachment reference.
 * 5. Absolute reference pointing to a missing internal asset.
 * 6. Referenced internal asset removed from manifest and disk.
 * 7. External project reference that must not be copied.
 * 8. Structured attachments and sent_files references.
 * 9. Issue-thread, screenshot and pipeline reference completeness.
 * 10. Unreferenced but durable internal assets.
 * 11. Manifest coverage tampering.
 * 12. Manifest categories tampering.
 * 13. Empty mandatory categories.
 * 14. Legacy manifest verification.
 * 15. requireCompleteProfile correctness.
 * 16. Legitimate .log, .lock and .pid attachments.
 * 17. Forbidden profile-root credentials.
 * 18. Source profile unavailable during independent snapshot verification.
 * 19. Snapshot copied to a different directory.
 * 20. Successful complete-profile Backup -> Verify -> Restore -> Verify.
 * 21. No regression in worker IPC and cancellation.
 * 22. No production profile access by tests.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { createHash, randomUUID } from "node:crypto";
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import path from "node:path";
import {
  BackupCore,
  publishDirectoryExclusive,
} from "./backup-core.ts";
import {
  BackupManager,
  BackupManagerError,
  createBackupSnapshot,
  getReferencedInternalAssets,
  verifyBackupSnapshot,
  type SnapshotManifest,
  type SnapshotVerificationResult,
} from "./backup-manager.ts";
import {
  BackupRestore,
  restoreBackupSnapshot,
  RestoreError,
} from "./backup-restore.ts";
import {
  BackupProcessRunner,
} from "./backup-runner.ts";
import { BackupRunnerError } from "./backup-runner-types.ts";
import { resolveDataDir } from "./data-dir.ts";
import { setupIsolatedTestProfile, type IsolatedTestProfile } from "./test-isolation.ts";

function sha256Hex(buf: Buffer | Uint8Array | string): string {
  return createHash("sha256").update(buf).digest("hex");
}

function createTasksTable(db: Database): void {
  db.run("PRAGMA journal_mode = WAL;");
  db.run("PRAGMA foreign_keys = ON;");
  db.run(`
    CREATE TABLE IF NOT EXISTS projects (
      path TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      added_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS tasks (
      id TEXT PRIMARY KEY,
      title TEXT NOT NULL,
      prompt TEXT NOT NULL,
      column TEXT NOT NULL,
      agent TEXT NOT NULL,
      workdir TEXT NOT NULL,
      refs TEXT DEFAULT '[]',
      attachments TEXT DEFAULT '[]',
      sent_files TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );
  `);
}

describe("FO-P2-003-R5A: Profile Integrity and Coverage Remediation", () => {
  let isolatedProfile: IsolatedTestProfile;
  let testRoot: string;

  beforeEach(() => {
    isolatedProfile = setupIsolatedTestProfile("fo-r5a-suite-");
    testRoot = mkdtempSync(path.join(tmpdir(), "fo-r5a-case-"));
  });

  afterEach(() => {
    try {
      rmSync(testRoot, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
    isolatedProfile.cleanup();
  });

  // ── 1. Database from Profile A with active data directory pointing to Profile B ──
  test("1. Database from profile A with active data directory pointing to profile B binds strictly to A", async () => {
    const profileA = path.join(testRoot, "profile-A");
    const profileB = path.join(testRoot, "profile-B");
    mkdirSync(path.join(profileA, "attachments"), { recursive: true });
    mkdirSync(path.join(profileB, "attachments"), { recursive: true });

    // Profile B is active profile in process.env
    process.env.FORGEORBIT_DATA_DIR = profileB;
    process.env.AGETOR_DATA_DIR = profileB;

    // Put file in profile A
    const attA = path.join(profileA, "attachments", "asset-from-a.txt");
    writeFileSync(attA, "content of A", { mode: 0o600 });

    // Put different file in profile B
    const attB = path.join(profileB, "attachments", "asset-from-b.txt");
    writeFileSync(attB, "content of B", { mode: 0o600 });

    // Create DB belonging to profile A
    const dbPathA = path.join(profileA, "database.sqlite");
    const dbA = new Database(dbPathA);
    createTasksTable(dbA);
    dbA.run(
      `INSERT INTO tasks (id, title, prompt, column, agent, workdir, refs, attachments, sent_files, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ["task-a", "Task in A", "Prompt", "ready", "claude-code", "/code", JSON.stringify([attA]), "[]", null, 1000, 1000],
    );
    dbA.close();

    // Reopen DB for BackupManager without passing dataDir (should safely derive profileA)
    const readDb = new Database(dbPathA, { readonly: true });
    const manager = new BackupManager({ db: readDb });

    const backupsDir = path.join(testRoot, "backups");
    mkdirSync(backupsDir, { recursive: true });
    const snap = await manager.createSnapshot({ destinationDir: backupsDir });
    readDb.close();

    // Snapshot MUST contain asset-from-a.txt, NOT asset-from-b.txt
    expect(snap.manifest.files.some((f) => f.path === "attachments/asset-from-a.txt")).toBe(true);
    expect(snap.manifest.files.some((f) => f.path === "attachments/asset-from-b.txt")).toBe(false);
    expect(existsSync(path.join(snap.path, "attachments", "asset-from-a.txt"))).toBe(true);
    expect(existsSync(path.join(snap.path, "attachments", "asset-from-b.txt"))).toBe(false);

    // Verify snapshot succeeds independently
    const ver = await verifyBackupSnapshot(snap.path);
    expect(ver.ok).toBe(true);
    expect(ver.coverage).toBe("complete-profile");
  });

  // ── 2. Missing dataDir and mismatched source profile root ──────────────────
  test("2. Missing dataDir on in-memory DB and mismatched profile root fail closed", () => {
    // In-memory db with no dataDir must throw INVALID_PATH
    const memDb = new Database(":memory:");
    createTasksTable(memDb);
    expect(() => new BackupManager({ db: memDb })).toThrow(
      expect.objectContaining({ code: "INVALID_PATH" }),
    );
    memDb.close();

    // Mismatched source db and dataDir must throw INVALID_PATH
    const dirA = path.join(testRoot, "mismatch-a");
    const dirB = path.join(testRoot, "mismatch-b");
    mkdirSync(dirA, { recursive: true });
    mkdirSync(dirB, { recursive: true });
    const dbPathA = path.join(dirA, "database.sqlite");
    const dbA = new Database(dbPathA);
    createTasksTable(dbA);

    expect(() => new BackupManager({ db: dbA, dataDir: dirB })).toThrow(
      expect.objectContaining({ code: "INVALID_PATH" }),
    );
    dbA.close();
  });

  // ── 3. Explicit correct profile root ───────────────────────────────────────
  test("3. Explicit correct profile root is accepted and snapshot succeeds", async () => {
    const profileDir = path.join(testRoot, "explicit-profile");
    mkdirSync(path.join(profileDir, "attachments"), { recursive: true });
    const attPath = path.join(profileDir, "attachments", "doc.txt");
    writeFileSync(attPath, "hello world", { mode: 0o600 });

    const dbPath = path.join(profileDir, "database.sqlite");
    const db = new Database(dbPath);
    createTasksTable(db);
    db.run(
      `INSERT INTO tasks (id, title, prompt, column, agent, workdir, refs, attachments, sent_files, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ["t1", "T1", "Prompt", "ready", "claude-code", "/code", JSON.stringify([attPath]), "[]", null, 1000, 1000],
    );

    const manager = new BackupManager({ db, dataDir: profileDir });
    const outDir = path.join(testRoot, "out");
    const snap = await manager.createSnapshot({ destinationDir: outDir, createDirectory: true, manifestVersion: 4 });
    db.close();

    expect(snap.manifest.coverage).toBe("complete-profile");
    expect(snap.manifest.stats.attachmentCount).toBe(1);
    const ver = await verifyBackupSnapshot(snap.path);
    expect(ver.ok).toBe(true);
  });

  // ── 4. Snapshot with absolute attachment reference ─────────────────────────
  test("4. Snapshot with absolute attachment reference packages and verifies portable canonical-relative mapping", async () => {
    const profileDir = path.join(testRoot, "abs-ref-profile");
    mkdirSync(path.join(profileDir, "attachments"), { recursive: true });
    const attFile = path.join(profileDir, "attachments", "picture.png");
    writeFileSync(attFile, "fake png content", { mode: 0o600 });

    const dbPath = path.join(profileDir, "database.sqlite");
    const db = new Database(dbPath);
    createTasksTable(db);
    db.run(
      `INSERT INTO tasks (id, title, prompt, column, agent, workdir, refs, attachments, sent_files, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ["t-abs", "T Abs", "Prompt", "ready", "claude-code", "/code", JSON.stringify([attFile]), "[]", null, 1000, 1000],
    );

    const manager = new BackupManager({ db, dataDir: profileDir });
    const outDir = path.join(testRoot, "out");
    const snap = await manager.createSnapshot({ destinationDir: outDir, createDirectory: true, manifestVersion: 4 });
    db.close();

    // Version 4 manifest includes origin and canonical-relative internalReferences
    expect(snap.manifest.manifestVersion).toBe(4);
    expect(snap.manifest.origin).toBeDefined();
    expect(snap.manifest.origin?.sourceProfileRootSha256).toBe(sha256Hex(path.resolve(profileDir)));
    expect(snap.manifest.internalReferences?.length).toBe(1);
    expect(snap.manifest.internalReferences?.[0]?.canonicalPath).toBe("attachments/picture.png");
    expect(snap.manifest.internalReferences?.[0]?.refType).toBe("canonical-relative");

    // Verification passes
    const ver = await verifyBackupSnapshot(snap.path);
    expect(ver.ok).toBe(true);
    expect(ver.coverage).toBe("complete-profile");
  });

  // ── 5. Absolute reference pointing to a missing internal asset ─────────────
  test("5. Absolute reference pointing to a missing internal asset fails snapshot creation", async () => {
    const profileDir = path.join(testRoot, "missing-asset-profile");
    mkdirSync(profileDir, { recursive: true });

    const missingAtt = path.join(profileDir, "attachments", "missing-file.txt");
    const dbPath = path.join(profileDir, "database.sqlite");
    const db = new Database(dbPath);
    createTasksTable(db);
    db.run(
      `INSERT INTO tasks (id, title, prompt, column, agent, workdir, refs, attachments, sent_files, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ["t-miss", "T Miss", "Prompt", "ready", "claude-code", "/code", JSON.stringify([missingAtt]), "[]", null, 1000, 1000],
    );

    const manager = new BackupManager({ db, dataDir: profileDir });
    const outDir = path.join(testRoot, "out");
    await expect(manager.createSnapshot({ destinationDir: outDir, createDirectory: true })).rejects.toMatchObject({
      name: "BackupManagerError",
      code: "INCONSISTENT_ASSET",
    });
    db.close();
  });

  // ── 6. Referenced internal asset removed from manifest and disk ────────────
  test("6. Referenced internal asset removed from manifest and disk fails verification (P1-N1 fix)", async () => {
    const profileDir = path.join(testRoot, "tampered-asset-profile");
    mkdirSync(path.join(profileDir, "attachments"), { recursive: true });
    const attFile = path.join(profileDir, "attachments", "mandatory-doc.pdf");
    writeFileSync(attFile, "mandatory pdf bytes", { mode: 0o600 });

    const dbPath = path.join(profileDir, "database.sqlite");
    const db = new Database(dbPath);
    createTasksTable(db);
    db.run(
      `INSERT INTO tasks (id, title, prompt, column, agent, workdir, refs, attachments, sent_files, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ["t-tamper", "T Tamper", "Prompt", "ready", "claude-code", "/code", JSON.stringify([attFile]), "[]", null, 1000, 1000],
    );

    const manager = new BackupManager({ db, dataDir: profileDir });
    const outDir = path.join(testRoot, "out");
    const snap = await manager.createSnapshot({ destinationDir: outDir, createDirectory: true, manifestVersion: 4 });
    db.close();

    // Verify initially passes
    const initialVer = await verifyBackupSnapshot(snap.path);
    expect(initialVer.ok).toBe(true);

    // Now simulate attacker/corruption: delete attachments/mandatory-doc.pdf from disk AND manifest
    unlinkSync(path.join(snap.path, "attachments", "mandatory-doc.pdf"));
    const manifestPath = path.join(snap.path, "manifest.json");
    const manifest: SnapshotManifest = JSON.parse(readFileSync(manifestPath, "utf8"));
    manifest.files = manifest.files.filter((f) => f.path !== "attachments/mandatory-doc.pdf");
    manifest.stats.fileCount = manifest.files.length;
    manifest.stats.totalBytes = manifest.files.reduce((acc, f) => acc + f.bytes, 0);
    manifest.stats.attachmentCount = 0;
    writeFileSync(manifestPath, JSON.stringify(manifest, null, 2), { mode: 0o600 });

    // Verification MUST FAIL because database still references mandatory-doc.pdf
    const tamperedVer = await verifyBackupSnapshot(snap.path);
    expect(tamperedVer.ok).toBe(false);
    expect(tamperedVer.issues.some((i) => i.includes("attachments/mandatory-doc.pdf"))).toBe(true);
  });

  // ── 7. External project reference that must not be copied ──────────────────
  test("7. External project reference in task is preserved without copying external files", async () => {
    const profileDir = path.join(testRoot, "profile-ext");
    mkdirSync(profileDir, { recursive: true });

    // An external repository path
    const externalProjectDir = path.join(testRoot, "external-project");
    mkdirSync(externalProjectDir, { recursive: true });
    const externalFile = path.join(externalProjectDir, "secret-code.ts");
    writeFileSync(externalFile, "const secret = 'private';", { mode: 0o600 });

    const dbPath = path.join(profileDir, "database.sqlite");
    const db = new Database(dbPath);
    createTasksTable(db);
    db.run(
      `INSERT INTO tasks (id, title, prompt, column, agent, workdir, refs, attachments, sent_files, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ["t-ext", "T Ext", "Prompt", "ready", "claude-code", "/code", JSON.stringify([externalFile]), "[]", null, 1000, 1000],
    );

    const manager = new BackupManager({ db, dataDir: profileDir });
    const outDir = path.join(testRoot, "out");
    const snap = await manager.createSnapshot({ destinationDir: outDir, createDirectory: true, manifestVersion: 4 });
    db.close();

    // Snapshot MUST NOT contain external-project or secret-code.ts
    expect(snap.manifest.files.some((f) => f.path.includes("secret-code"))).toBe(false);
    expect(readdirSync(snap.path).includes("external-project")).toBe(false);

    // Verification passes
    const ver = await verifyBackupSnapshot(snap.path);
    expect(ver.ok).toBe(true);
  });

  // ── 8. Structured attachments and sent_files references ────────────────────
  test("8. Structured attachments and sent_files references are verified and packaged", async () => {
    const profileDir = path.join(testRoot, "struct-profile");
    mkdirSync(path.join(profileDir, "attachments"), { recursive: true });
    const att1 = path.join(profileDir, "attachments", "struct-att.png");
    const sent1 = path.join(profileDir, "attachments", "delivered-file.pdf");
    writeFileSync(att1, "att bytes", { mode: 0o600 });
    writeFileSync(sent1, "pdf bytes", { mode: 0o600 });

    const dbPath = path.join(profileDir, "database.sqlite");
    const db = new Database(dbPath);
    createTasksTable(db);
    // Task with structured objects in attachments and sent_files
    db.run(
      `INSERT INTO tasks (id, title, prompt, column, agent, workdir, refs, attachments, sent_files, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        "t-struct",
        "Structured Task",
        "Prompt",
        "ready",
        "claude-code",
        "/code",
        "[]",
        JSON.stringify([{ path: att1, size: 9, isImage: true }]),
        JSON.stringify([{ path: sent1, filename: "delivered-file.pdf" }]),
        1000,
        1000,
      ],
    );

    const manager = new BackupManager({ db, dataDir: profileDir });
    const outDir = path.join(testRoot, "out");
    const snap = await manager.createSnapshot({ destinationDir: outDir, createDirectory: true, manifestVersion: 4 });
    db.close();

    expect(snap.manifest.stats.attachmentCount).toBe(2);
    expect(snap.manifest.files.some((f) => f.path === "attachments/struct-att.png")).toBe(true);
    expect(snap.manifest.files.some((f) => f.path === "attachments/delivered-file.pdf")).toBe(true);

    const ver = await verifyBackupSnapshot(snap.path);
    expect(ver.ok).toBe(true);
  });

  // ── 9. Issue-thread, screenshot and pipeline reference completeness ────────
  test("9. Issue-thread, screenshot and pipeline reference completeness", async () => {
    const profileDir = path.join(testRoot, "full-categories-profile");
    mkdirSync(path.join(profileDir, "screenshots"), { recursive: true });
    mkdirSync(path.join(profileDir, "issue-threads", "task-parent"), { recursive: true });
    mkdirSync(path.join(profileDir, "pipeline-runs", "task-parent"), { recursive: true });

    const scrPath = path.join(profileDir, "screenshots", "screen.png");
    const issPath = path.join(profileDir, "issue-threads", "task-parent", "thread.md");
    const pipePath = path.join(profileDir, "pipeline-runs", "task-parent", "step-1.json");

    writeFileSync(scrPath, "screen data", { mode: 0o600 });
    writeFileSync(issPath, "# Issue Discussion", { mode: 0o600 });
    writeFileSync(pipePath, JSON.stringify({ step: 1, ok: true }), { mode: 0o600 });

    const dbPath = path.join(profileDir, "database.sqlite");
    const db = new Database(dbPath);
    createTasksTable(db);
    db.run(
      `INSERT INTO tasks (id, title, prompt, column, agent, workdir, refs, attachments, sent_files, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        "task-parent",
        "Parent Task",
        "Prompt",
        "ready",
        "claude-code",
        "/code",
        JSON.stringify([scrPath, issPath, pipePath]),
        "[]",
        null,
        1000,
        1000,
      ],
    );

    const manager = new BackupManager({ db, dataDir: profileDir });
    const outDir = path.join(testRoot, "out");
    const snap = await manager.createSnapshot({ destinationDir: outDir, createDirectory: true, manifestVersion: 4 });
    db.close();

    expect(snap.manifest.stats.screenshotCount).toBe(1);
    expect(snap.manifest.stats.issueThreadCount).toBe(1);
    expect(snap.manifest.stats.pipelineRunCount).toBe(1);

    const ver = await verifyBackupSnapshot(snap.path);
    expect(ver.ok).toBe(true);
  });

  // ── 10. Unreferenced but durable internal assets ───────────────────────────
  test("10. Unreferenced but durable internal assets are packaged and verified under complete-profile", async () => {
    const profileDir = path.join(testRoot, "unref-durable-profile");
    mkdirSync(path.join(profileDir, "attachments"), { recursive: true });
    // An attachment uploaded to the profile but not yet linked to any task
    const durableAtt = path.join(profileDir, "attachments", "unlinked-user-file.zip");
    writeFileSync(durableAtt, "zip bytes", { mode: 0o600 });

    const dbPath = path.join(profileDir, "database.sqlite");
    const db = new Database(dbPath);
    createTasksTable(db);
    // Task with no refs
    db.run(
      `INSERT INTO tasks (id, title, prompt, column, agent, workdir, refs, attachments, sent_files, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ["t-empty", "Empty Refs", "Prompt", "ready", "claude-code", "/code", "[]", "[]", null, 1000, 1000],
    );

    const manager = new BackupManager({ db, dataDir: profileDir });
    const outDir = path.join(testRoot, "out");
    const snap = await manager.createSnapshot({ destinationDir: outDir, createDirectory: true, manifestVersion: 4 });
    db.close();

    // Durable asset is included in complete-profile snapshot
    expect(snap.manifest.files.some((f) => f.path === "attachments/unlinked-user-file.zip")).toBe(true);
    expect(snap.manifest.stats.attachmentCount).toBe(1);

    const ver = await verifyBackupSnapshot(snap.path);
    expect(ver.ok).toBe(true);
    expect(ver.coverage).toBe("complete-profile");
  });

  // ── 11. Manifest coverage tampering ────────────────────────────────────────
  test("11. Tampered coverage declaration is reported truthfully and fails requireCompleteProfile", async () => {
    const profileDir = path.join(testRoot, "cov-tamper-profile");
    mkdirSync(path.join(profileDir, "attachments"), { recursive: true });
    writeFileSync(path.join(profileDir, "attachments", "a.txt"), "data", { mode: 0o600 });

    const dbPath = path.join(profileDir, "database.sqlite");
    const db = new Database(dbPath);
    createTasksTable(db);
    const manager = new BackupManager({ db, dataDir: profileDir });
    const outDir = path.join(testRoot, "out");
    const snap = await manager.createSnapshot({ destinationDir: outDir, createDirectory: true, manifestVersion: 4 });
    db.close();

    // Tamper manifest coverage to legacy-database-knowledge
    const manifestPath = path.join(snap.path, "manifest.json");
    const manifest: SnapshotManifest = JSON.parse(readFileSync(manifestPath, "utf8"));
    manifest.coverage = "legacy-database-knowledge";
    manifest.categories = ["database", "knowledge"];
    manifest.files = manifest.files.filter((f) => f.category === "database" || f.category === "knowledge");
    manifest.stats.fileCount = manifest.files.length;
    manifest.stats.totalBytes = manifest.files.reduce((acc, f) => acc + f.bytes, 0);
    delete manifest.stats.attachmentCount;
    delete manifest.stats.screenshotCount;
    delete manifest.stats.issueThreadCount;
    delete manifest.stats.pipelineRunCount;
    rmSync(path.join(snap.path, "attachments"), { recursive: true, force: true });
    writeFileSync(manifestPath, JSON.stringify(manifest, null, 2), { mode: 0o600 });

    // Verifier MUST report coverage as legacy-database-knowledge, NOT complete-profile
    const ver = await verifyBackupSnapshot(snap.path);
    expect(ver.coverage).toBe("legacy-database-knowledge");

    // Restore with requireCompleteProfile MUST fail with INCOMPLETE_PROFILE
    const restoreDir = path.join(testRoot, "restored");
    await expect(
      restoreBackupSnapshot(snap.path, restoreDir, {
        requireCompleteProfile: true,
      }),
    ).rejects.toMatchObject({
      name: "RestoreError",
      code: "INCOMPLETE_PROFILE",
    });
  });

  // ── 12. Manifest categories tampering ──────────────────────────────────────
  test("12. Manifest categories tampering (dropping mandatory category) fails complete-profile verification", async () => {
    const profileDir = path.join(testRoot, "cat-tamper-profile");
    mkdirSync(profileDir, { recursive: true });
    const dbPath = path.join(profileDir, "database.sqlite");
    const db = new Database(dbPath);
    createTasksTable(db);
    const manager = new BackupManager({ db, dataDir: profileDir });
    const outDir = path.join(testRoot, "out");
    const snap = await manager.createSnapshot({ destinationDir: outDir, createDirectory: true, manifestVersion: 4 });
    db.close();

    // Tamper categories to omit mandatory categories while claiming complete-profile
    const manifestPath = path.join(snap.path, "manifest.json");
    const manifest: SnapshotManifest = JSON.parse(readFileSync(manifestPath, "utf8"));
    manifest.categories = ["database"]; // Dropped knowledge, attachment, screenshot, etc.
    writeFileSync(manifestPath, JSON.stringify(manifest, null, 2), { mode: 0o600 });

    const ver = await verifyBackupSnapshot(snap.path);
    expect(ver.ok).toBe(false);
    expect(ver.issues.some((i) => i.includes("missing mandatory category"))).toBe(true);
  });

  // ── 13. Empty mandatory categories ─────────────────────────────────────────
  test("13. Empty mandatory categories are valid when profile legitimately has no files in them", async () => {
    const profileDir = path.join(testRoot, "empty-cats-profile");
    mkdirSync(profileDir, { recursive: true });
    const dbPath = path.join(profileDir, "database.sqlite");
    const db = new Database(dbPath);
    createTasksTable(db);
    db.run(
      `INSERT INTO tasks (id, title, prompt, column, agent, workdir, refs, attachments, sent_files, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ["t-empty-cats", "Clean Profile", "Prompt", "ready", "claude-code", "/code", "[]", "[]", null, 1000, 1000],
    );

    const manager = new BackupManager({ db, dataDir: profileDir });
    const outDir = path.join(testRoot, "out");
    const snap = await manager.createSnapshot({ destinationDir: outDir, createDirectory: true, manifestVersion: 4 });
    db.close();

    // Stats report 0 for empty categories
    expect(snap.manifest.stats.attachmentCount).toBe(0);
    expect(snap.manifest.stats.screenshotCount).toBe(0);
    expect(snap.manifest.stats.issueThreadCount).toBe(0);
    expect(snap.manifest.stats.pipelineRunCount).toBe(0);

    // Verification succeeds and coverage is complete-profile
    const ver = await verifyBackupSnapshot(snap.path);
    expect(ver.ok).toBe(true);
    expect(ver.coverage).toBe("complete-profile");
  });

  // ── 14. Legacy manifest verification ───────────────────────────────────────
  test("14. Legacy manifest (v1) verification succeeds and reports legacy coverage", async () => {
    const profileDir = path.join(testRoot, "legacy-v1-profile");
    mkdirSync(profileDir, { recursive: true });
    const dbPath = path.join(profileDir, "database.sqlite");
    const db = new Database(dbPath);
    createTasksTable(db);
    const manager = new BackupManager({ db, dataDir: profileDir });
    const outDir = path.join(testRoot, "out");
    // Explicitly create legacy v1 snapshot
    const snap = await manager.createSnapshot({ destinationDir: outDir, createDirectory: true, manifestVersion: 1 });
    db.close();

    expect(snap.manifest.manifestVersion).toBe(1);
    expect(snap.manifest.coverage).toBe("legacy-database-knowledge");

    const ver = await verifyBackupSnapshot(snap.path);
    expect(ver.ok).toBe(true);
    expect(ver.manifestVersion).toBe(1);
    expect(ver.coverage).toBe("legacy-database-knowledge");
  });

  // ── 15. requireCompleteProfile correctness ─────────────────────────────────
  test("15. requireCompleteProfile succeeds for complete profile and rejects legacy/incomplete", async () => {
    const profileDir = path.join(testRoot, "req-comp-profile");
    mkdirSync(profileDir, { recursive: true });
    const dbPath = path.join(profileDir, "database.sqlite");
    const db = new Database(dbPath);
    createTasksTable(db);

    const manager = new BackupManager({ db, dataDir: profileDir });
    const outDir = path.join(testRoot, "out");

    const completeSnap = await manager.createSnapshot({ destinationDir: outDir, createDirectory: true });
    const legacySnap = await manager.createSnapshot({ destinationDir: outDir, createDirectory: true, manifestVersion: 1 });
    db.close();

    // Complete snapshot succeeds with requireCompleteProfile: true
    const destComplete = path.join(testRoot, "dest-complete");
    const resComplete = await restoreBackupSnapshot(completeSnap.path, destComplete, {
      requireCompleteProfile: true,
    });
    expect(resComplete.coverage).toBe("complete-profile");

    // Legacy snapshot fails with requireCompleteProfile: true
    const destLegacy = path.join(testRoot, "dest-legacy");
    await expect(
      restoreBackupSnapshot(legacySnap.path, destLegacy, {
        requireCompleteProfile: true,
      }),
    ).rejects.toMatchObject({
      name: "RestoreError",
      code: "INCOMPLETE_PROFILE",
    });
  });

  // ── 16. Legitimate .log, .lock and .pid attachments ────────────────────────
  test("16. Legitimate .log, .lock and .pid attachments are accepted without false rejection (P2-N3 fix)", async () => {
    const profileDir = path.join(testRoot, "legit-files-profile");
    mkdirSync(path.join(profileDir, "attachments"), { recursive: true });

    // User-uploaded attachments with .log, .lock, .pid extensions
    const reportLog = path.join(profileDir, "attachments", "report.log");
    const processLock = path.join(profileDir, "attachments", "process.lock");
    const servicePid = path.join(profileDir, "attachments", "service.pid");

    writeFileSync(reportLog, "2026-11-01 [INFO] build successful", { mode: 0o600 });
    writeFileSync(processLock, "lock-id-9988", { mode: 0o600 });
    writeFileSync(servicePid, "12345\n", { mode: 0o600 });

    const dbPath = path.join(profileDir, "database.sqlite");
    const db = new Database(dbPath);
    createTasksTable(db);
    db.run(
      `INSERT INTO tasks (id, title, prompt, column, agent, workdir, refs, attachments, sent_files, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        "t-legit",
        "Legit files task",
        "Prompt",
        "ready",
        "claude-code",
        "/code",
        JSON.stringify([reportLog, processLock, servicePid]),
        "[]",
        null,
        1000,
        1000,
      ],
    );

    const manager = new BackupManager({ db, dataDir: profileDir });
    const outDir = path.join(testRoot, "out");
    const snap = await manager.createSnapshot({ destinationDir: outDir, createDirectory: true, manifestVersion: 4 });
    db.close();

    expect(snap.manifest.stats.attachmentCount).toBe(3);

    // Verification MUST SUCCEED: legitimate user attachments are not rejected
    const ver = await verifyBackupSnapshot(snap.path);
    expect(ver.ok).toBe(true);
    expect(ver.issues).toHaveLength(0);

    // Restoration MUST SUCCEED
    const restoreDir = path.join(testRoot, "restored-legit");
    const restRes = await restoreBackupSnapshot(snap.path, restoreDir);
    expect(existsSync(path.join(restoreDir, "attachments", "report.log"))).toBe(true);
    expect(existsSync(path.join(restoreDir, "attachments", "process.lock"))).toBe(true);
    expect(existsSync(path.join(restoreDir, "attachments", "service.pid"))).toBe(true);
  });

  // ── 17. Forbidden profile-root credentials ──────────────────────────────────
  test("17. Forbidden profile-root credentials and active runtime files are rejected", async () => {
    const profileDir = path.join(testRoot, "forbidden-profile");
    mkdirSync(profileDir, { recursive: true });
    const dbPath = path.join(profileDir, "database.sqlite");
    const db = new Database(dbPath);
    createTasksTable(db);
    const manager = new BackupManager({ db, dataDir: profileDir });
    const outDir = path.join(testRoot, "out");
    const snap = await manager.createSnapshot({ destinationDir: outDir, createDirectory: true, manifestVersion: 4 });
    db.close();

    // Inject forbidden credential file at root of snapshot: github-tokens.json
    writeFileSync(path.join(snap.path, "github-tokens.json"), "secret tokens", { mode: 0o600 });
    const ver1 = await verifyBackupSnapshot(snap.path);
    expect(ver1.ok).toBe(false);
    expect(ver1.issues.some((i) => i.includes("Forbidden credential or runtime file"))).toBe(true);
    unlinkSync(path.join(snap.path, "github-tokens.json"));

    // Inject daemon.log at root
    writeFileSync(path.join(snap.path, "daemon.log"), "runtime log", { mode: 0o600 });
    const ver2 = await verifyBackupSnapshot(snap.path);
    expect(ver2.ok).toBe(false);
    expect(ver2.issues.some((i) => i.includes("Forbidden credential or runtime file"))).toBe(true);
    unlinkSync(path.join(snap.path, "daemon.log"));

    // Inject forbidden credential file into attachments/
    mkdirSync(path.join(snap.path, "attachments"), { recursive: true });
    writeFileSync(path.join(snap.path, "attachments", "core-creds.json"), "secret creds", { mode: 0o600 });
    const ver3 = await verifyBackupSnapshot(snap.path);
    expect(ver3.ok).toBe(false);
    expect(ver3.issues.some((i) => i.includes("Forbidden credential or runtime file"))).toBe(true);
  });

  // ── 18. Source profile unavailable during independent snapshot verification
  test("18. Snapshot verification succeeds independently after source profile is completely deleted", async () => {
    const profileDir = path.join(testRoot, "deleted-source-profile");
    mkdirSync(path.join(profileDir, "attachments"), { recursive: true });
    const attFile = path.join(profileDir, "attachments", "contract.pdf");
    writeFileSync(attFile, "contract text", { mode: 0o600 });

    const dbPath = path.join(profileDir, "database.sqlite");
    const db = new Database(dbPath);
    createTasksTable(db);
    db.run(
      `INSERT INTO tasks (id, title, prompt, column, agent, workdir, refs, attachments, sent_files, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ["t-del", "T Del", "Prompt", "ready", "claude-code", "/code", JSON.stringify([attFile]), "[]", null, 1000, 1000],
    );

    const manager = new BackupManager({ db, dataDir: profileDir });
    const outDir = path.join(testRoot, "out");
    const snap = await manager.createSnapshot({ destinationDir: outDir, createDirectory: true, manifestVersion: 4 });
    db.close();

    // Completely erase the source profile directory
    rmSync(profileDir, { recursive: true, force: true });
    expect(existsSync(profileDir)).toBe(false);

    // Independent snapshot verification MUST STILL SUCCEED using portable origin metadata
    const ver = await verifyBackupSnapshot(snap.path);
    expect(ver.ok).toBe(true);
    expect(ver.coverage).toBe("complete-profile");
    expect(ver.issues).toHaveLength(0);
  });

  // ── 19. Snapshot copied to a different directory ───────────────────────────
  test("19. Snapshot copied to a different directory verifies and restores cleanly", async () => {
    const profileDir = path.join(testRoot, "copy-source-profile");
    mkdirSync(path.join(profileDir, "attachments"), { recursive: true });
    const attFile = path.join(profileDir, "attachments", "data.json");
    writeFileSync(attFile, JSON.stringify({ a: 1 }), { mode: 0o600 });

    const dbPath = path.join(profileDir, "database.sqlite");
    const db = new Database(dbPath);
    createTasksTable(db);
    db.run(
      `INSERT INTO tasks (id, title, prompt, column, agent, workdir, refs, attachments, sent_files, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ["t-copy", "T Copy", "Prompt", "ready", "claude-code", "/code", JSON.stringify([attFile]), "[]", null, 1000, 1000],
    );

    const manager = new BackupManager({ db, dataDir: profileDir });
    const outDir = path.join(testRoot, "out");
    const snap = await manager.createSnapshot({ destinationDir: outDir, createDirectory: true, manifestVersion: 4 });
    db.close();

    // Copy snapshot directory to an entirely different location
    const copiedSnapDir = path.join(testRoot, "relocated-snapshot");
    mkdirSync(copiedSnapDir, { recursive: true });
    mkdirSync(path.join(copiedSnapDir, "attachments"), { recursive: true });
    copyFileSync(path.join(snap.path, "manifest.json"), path.join(copiedSnapDir, "manifest.json"));
    copyFileSync(path.join(snap.path, "database.sqlite"), path.join(copiedSnapDir, "database.sqlite"));
    copyFileSync(path.join(snap.path, "attachments", "data.json"), path.join(copiedSnapDir, "attachments", "data.json"));

    // Verify copied snapshot
    const ver = await verifyBackupSnapshot(copiedSnapDir);
    expect(ver.ok).toBe(true);
    expect(ver.coverage).toBe("complete-profile");

    // Restore copied snapshot
    const restoreDir = path.join(testRoot, "restored-from-copy");
    const res = await restoreBackupSnapshot(copiedSnapDir, restoreDir, {
      requireCompleteProfile: true,
    });
    expect(res.coverage).toBe("complete-profile");
    expect(existsSync(path.join(restoreDir, "attachments", "data.json"))).toBe(true);
  });

  // ── 20. Successful complete-profile Backup -> Verify -> Restore -> Verify ──
  test("20. End-to-end complete-profile lifecycle: Backup -> Verify -> Restore -> Verify", async () => {
    const profileDir = path.join(testRoot, "e2e-source-profile");
    mkdirSync(path.join(profileDir, "attachments"), { recursive: true });
    mkdirSync(path.join(profileDir, "knowledge", "bodies", "11111111-1111-1111-1111-111111111111"), { recursive: true });
    mkdirSync(path.join(profileDir, "screenshots"), { recursive: true });
    mkdirSync(path.join(profileDir, "issue-threads", "task-e2e"), { recursive: true });
    mkdirSync(path.join(profileDir, "pipeline-runs", "task-e2e"), { recursive: true });

    const attFile = path.join(profileDir, "attachments", "final-report.pdf");
    const knFile = path.join(profileDir, "knowledge", "bodies", "11111111-1111-1111-1111-111111111111", "1.md");
    const scrFile = path.join(profileDir, "screenshots", "final-shot.png");
    const issFile = path.join(profileDir, "issue-threads", "task-e2e", "thread.md");
    const pipeFile = path.join(profileDir, "pipeline-runs", "task-e2e", "step-1.json");

    writeFileSync(attFile, "pdf content", { mode: 0o600 });
    writeFileSync(knFile, "# Knowledge Title\nBody content", { mode: 0o600 });
    writeFileSync(scrFile, "screenshot data", { mode: 0o600 });
    writeFileSync(issFile, "# Discussion", { mode: 0o600 });
    writeFileSync(pipeFile, JSON.stringify({ step: 1 }), { mode: 0o600 });

    const dbPath = path.join(profileDir, "database.sqlite");
    const db = new Database(dbPath);
    createTasksTable(db);
    db.run(`
      CREATE TABLE IF NOT EXISTS knowledge_documents (
        id TEXT PRIMARY KEY,
        owner_kind TEXT NOT NULL,
        owner_id TEXT NOT NULL,
        title TEXT NOT NULL,
        description TEXT NOT NULL DEFAULT '',
        category TEXT NOT NULL DEFAULT 'general',
        tags_json TEXT NOT NULL DEFAULT '[]',
        sensitive INTEGER NOT NULL DEFAULT 0,
        revision INTEGER NOT NULL,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        archived_at INTEGER,
        content_sha256 TEXT NOT NULL,
        byte_length INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS knowledge_revisions (
        document_id TEXT NOT NULL,
        revision INTEGER NOT NULL,
        content_sha256 TEXT NOT NULL,
        byte_length INTEGER NOT NULL,
        created_at INTEGER NOT NULL,
        PRIMARY KEY (document_id, revision)
      );
    `);
    const knBytes = Buffer.from("# Knowledge Title\nBody content");
    db.run(
      `INSERT INTO knowledge_documents (
        id, owner_kind, owner_id, title, revision, created_at, updated_at, content_sha256, byte_length
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ["11111111-1111-1111-1111-111111111111", "project", "test-proj", "Knowledge Title", 1, 1000, 1000, sha256Hex(knBytes), knBytes.length],
    );
    db.run(
      "INSERT INTO knowledge_revisions (document_id, revision, content_sha256, byte_length, created_at) VALUES (?, ?, ?, ?, ?)",
      ["11111111-1111-1111-1111-111111111111", 1, sha256Hex(knBytes), knBytes.length, 1000],
    );
    db.run(
      `INSERT INTO tasks (id, title, prompt, column, agent, workdir, refs, attachments, sent_files, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        "task-e2e",
        "E2E Task",
        "Prompt",
        "ready",
        "claude-code",
        "/code",
        JSON.stringify([attFile, scrFile, issFile, pipeFile]),
        "[]",
        null,
        1000,
        1000,
      ],
    );

    // 1. Backup
    const manager = new BackupManager({ db, dataDir: profileDir });
    const outDir = path.join(testRoot, "out");
    const snap = await manager.createSnapshot({ destinationDir: outDir, createDirectory: true, manifestVersion: 4 });
    db.close();

    // 2. Verify Snapshot
    const verSnap = await verifyBackupSnapshot(snap.path);
    expect(verSnap.ok).toBe(true);
    expect(verSnap.coverage).toBe("complete-profile");

    // 3. Restore
    const destDir = path.join(testRoot, "dest-e2e");
    const restoreRes = await restoreBackupSnapshot(snap.path, destDir, {
      requireCompleteProfile: true,
    });
    expect(restoreRes.coverage).toBe("complete-profile");
    expect(existsSync(path.join(destDir, "agetor.sqlite"))).toBe(true);

    // 4. Verify Restored Files Match Source
    expect(readFileSync(path.join(destDir, "attachments", "final-report.pdf"), "utf8")).toBe("pdf content");
    expect(readFileSync(path.join(destDir, "screenshots", "final-shot.png"), "utf8")).toBe("screenshot data");
    expect(readFileSync(path.join(destDir, "issue-threads", "task-e2e", "thread.md"), "utf8")).toBe("# Discussion");
    expect(readFileSync(path.join(destDir, "pipeline-runs", "task-e2e", "step-1.json"), "utf8")).toBe(JSON.stringify({ step: 1 }));
  });

  // ── 21. No regression in worker IPC and cancellation ────────────────────────
  test("21. BackupProcessRunner IPC and cancellation maintain safe lifecycle", async () => {
    const profileDir = path.join(testRoot, "runner-ipc-profile");
    mkdirSync(profileDir, { recursive: true });
    const dbPath = path.join(profileDir, "database.sqlite");
    const db = new Database(dbPath);
    createTasksTable(db);
    db.close();

    const runner = new BackupProcessRunner({ maxConcurrency: 2 });
    const outDir = path.join(testRoot, "runner-out");
    mkdirSync(outDir, { recursive: true });

    // Submit snapshot operation through isolated worker process
    const snapResult = await runner.createSnapshot(dbPath, outDir, {
      dataDir: profileDir,
    });
    expect(snapResult.type).toBe("create-snapshot");
    expect(snapResult.coverage).toBe("complete-profile");
    expect(existsSync(snapResult.path)).toBe(true);

    // Verify through isolated worker process
    const verResult = await runner.verifySnapshot(snapResult.path);
    expect(verResult.ok).toBe(true);
    expect(verResult.coverage).toBe("complete-profile");

    // Test cancellation
    const cancelOpPromise = runner.createSnapshot(dbPath, path.join(testRoot, "cancelled-out"), {
      dataDir: profileDir,
      createDirectory: true,
    });
    const opId = runner.listOperations().find((o) => o.state === "queued" || o.state === "running")?.operationId;
    if (opId) {
      await runner.cancel(opId);
    }
    try {
      await cancelOpPromise;
    } catch (err) {
      expect((err as BackupRunnerError).code === "CANCELLED" || (err as BackupRunnerError).code === "PROCESS_EXIT_ERROR").toBe(true);
    }

    await runner.dispose();
  });

  // ── 22. No production profile access by tests ──────────────────────────────
  test("22. Test isolation guarantees zero access to active user profile", () => {
    const activeDir = resolveDataDir();
    // Verify activeDir is strictly inside isolatedProfile fixture, never homedir
    expect(activeDir.startsWith(isolatedProfile.root)).toBe(true);
    expect(activeDir.includes("Library/Application Support/ForgeOrbit")).toBe(false);
    expect(activeDir.includes(".agetor")).toBe(false);
  });
});
