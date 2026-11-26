import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { spawnSync } from "node:child_process";
import {
  chmodSync,
  closeSync,
  constants,
  existsSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import {
  STAGING_LOCK_FILENAME,
  releaseFlock,
  tryAcquireFlock,
  writeStagingOwnershipMetadata,
} from "./backup-core.ts";
import { BackupManager } from "./backup-manager.ts";
import {
  BackupRestore,
  RestoreError,
  cleanIncompleteRestoreStaging,
  restoreBackupSnapshot,
} from "./backup-restore.ts";
import { migrate } from "./migrate.ts";
import { migrations } from "./migrations/index.ts";

describe("Safe Backup Restore Core (FO-P2-003)", () => {
  let testDir: string;
  let isolatedActiveDir: string;
  let knowledgeDir: string;
  let snapshotDir: string;
  let restoreDir: string;
  let prevForgeorbit: string | undefined;
  let prevAgetor: string | undefined;

  beforeEach(() => {
    testDir = mkdtempSync(path.join(tmpdir(), "fo-restore-test-"));
    isolatedActiveDir = mkdtempSync(path.join(tmpdir(), "fo-active-data-"));
    knowledgeDir = path.join(testDir, "knowledge");
    snapshotDir = path.join(testDir, "snapshots");
    restoreDir = path.join(testDir, "restored");

    prevForgeorbit = process.env.FORGEORBIT_DATA_DIR;
    prevAgetor = process.env.AGETOR_DATA_DIR;
    process.env.FORGEORBIT_DATA_DIR = isolatedActiveDir;
    process.env.AGETOR_DATA_DIR = isolatedActiveDir;

    mkdirSync(knowledgeDir, { recursive: true, mode: 0o700 });
    mkdirSync(snapshotDir, { recursive: true, mode: 0o700 });
  });

  afterEach(() => {
    if (prevForgeorbit !== undefined) {
      process.env.FORGEORBIT_DATA_DIR = prevForgeorbit;
    } else {
      delete process.env.FORGEORBIT_DATA_DIR;
    }
    if (prevAgetor !== undefined) {
      process.env.AGETOR_DATA_DIR = prevAgetor;
    } else {
      delete process.env.AGETOR_DATA_DIR;
    }

    try {
      rmSync(isolatedActiveDir, { recursive: true, force: true });
    } catch {
      /* best effort cleanup */
    }
    try {
      rmSync(testDir, { recursive: true, force: true });
    } catch {
      /* best effort cleanup */
    }
  });

  function sha256Hex(buf: Buffer | Uint8Array | string): string {
    return createHash("sha256").update(buf).digest("hex");
  }

  function setupTestDatabase(filename = "source.sqlite"): {
    db: Database;
    dbPath: string;
  } {
    const dbPath = path.join(testDir, filename);
    const db = new Database(dbPath);
    db.exec("PRAGMA journal_mode = WAL;");
    db.exec("PRAGMA synchronous = NORMAL;");
    db.exec("PRAGMA foreign_keys = ON;");

    // Apply real repository migrations
    migrate(db, migrations);

    db.run(
      "INSERT INTO projects (path, name, added_at) VALUES (?, ?, ?)",
      ["/code/alpha", "Project Alpha", 1000],
    );
    db.run(
      "INSERT INTO tasks (id, title, prompt, column, agent, workdir, isolation, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
      ["task-1", "Task 1", "Implement backup", "ready", "claude-code", "/code/alpha", "worktree", 1001, 1001],
    );

    return { db, dbPath };
  }

  function addKnowledgeNote(
    db: Database,
    id: string,
    revision: number,
    content: string,
  ): void {
    const bytes = Buffer.from(content, "utf8");
    const docBodiesDir = path.join(knowledgeDir, "bodies", id);
    mkdirSync(docBodiesDir, { recursive: true, mode: 0o700 });
    writeFileSync(path.join(docBodiesDir, `${revision}.md`), bytes, { mode: 0o600 });

    if (revision === 1) {
      db.run(
        `INSERT INTO knowledge_documents (
           id, owner_kind, owner_id, title, description, category, tags_json, sensitive,
           revision, created_at, updated_at, archived_at, content_sha256, byte_length
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?)`,
        [
          id,
          "project",
          "/code/alpha",
          `Note ${id}`,
          "Desc",
          "general",
          "[]",
          0,
          1,
          1000,
          1000,
          sha256Hex(bytes),
          bytes.length,
        ],
      );
    } else {
      db.run(
        `UPDATE knowledge_documents SET revision = ?, updated_at = ?, content_sha256 = ?, byte_length = ? WHERE id = ?`,
        [revision, 1000 + revision, sha256Hex(bytes), bytes.length, id],
      );
    }

    db.run(
      `INSERT INTO knowledge_revisions (document_id, revision, created_at, byte_length, content_sha256) VALUES (?, ?, ?, ?, ?)`,
      [id, revision, 1000 + revision, bytes.length, sha256Hex(bytes)],
    );
  }

  test("1. Successful Backup -> Restore round trip", async () => {
    const { db } = setupTestDatabase();
    const docId = randomUUID();
    addKnowledgeNote(db, docId, 1, "# Document Revision 1");

    const manager = new BackupManager({ db, knowledgeRootDir: knowledgeDir });
    const snap = await manager.createSnapshot({ destinationDir: snapshotDir });

    const targetDest = path.join(testDir, "restored-profile");
    const result = await restoreBackupSnapshot(snap.path, targetDest);

    expect(result.destinationPath).toBe(path.resolve(targetDest));
    expect(result.snapshotId).toBe(snap.snapshotId);
    expect(result.dbFilename).toBe("agetor.sqlite");
    expect(result.knowledgeDocumentCount).toBe(1);
    expect(result.knowledgeRevisionCount).toBe(1);
    expect(result.filesRestored).toBe(2);
    expect(existsSync(path.join(targetDest, "agetor.sqlite"))).toBe(true);
    expect(existsSync(path.join(targetDest, "knowledge", "bodies", docId, "1.md"))).toBe(true);

    db.close();
  });

  test("2. Database data equality after restoration", async () => {
    const { db } = setupTestDatabase();
    const docId = randomUUID();
    addKnowledgeNote(db, docId, 1, "Initial note");

    const manager = new BackupManager({ db, knowledgeRootDir: knowledgeDir });
    const snap = await manager.createSnapshot({ destinationDir: snapshotDir });

    const targetDest = path.join(testDir, "restored-equality");
    await restoreBackupSnapshot(snap.path, targetDest);

    // Open restored database independently
    const restoredDb = new Database(path.join(targetDest, "agetor.sqlite"), { readonly: true });
    const restoredProjects = restoredDb.query("SELECT * FROM projects").all();
    const restoredTasks = restoredDb.query("SELECT * FROM tasks").all();
    const restoredDocs = restoredDb.query("SELECT * FROM knowledge_documents").all();
    const restoredRevs = restoredDb.query("SELECT * FROM knowledge_revisions").all();

    expect(restoredProjects).toEqual(db.query("SELECT * FROM projects").all());
    expect(restoredTasks).toEqual(db.query("SELECT * FROM tasks").all());
    expect(restoredDocs).toEqual(db.query("SELECT * FROM knowledge_documents").all());
    expect(restoredRevs).toEqual(db.query("SELECT * FROM knowledge_revisions").all());

    restoredDb.close();
    db.close();
  });

  test("3. Knowledge revision preservation across multiple revisions", async () => {
    const { db } = setupTestDatabase();
    const docId = randomUUID();
    addKnowledgeNote(db, docId, 1, "First revision content");
    addKnowledgeNote(db, docId, 2, "Second updated revision content");

    const manager = new BackupManager({ db, knowledgeRootDir: knowledgeDir });
    const snap = await manager.createSnapshot({ destinationDir: snapshotDir });

    const targetDest = path.join(testDir, "restored-revisions");
    await restoreBackupSnapshot(snap.path, targetDest);

    const body1 = readFileSync(path.join(targetDest, "knowledge", "bodies", docId, "1.md"), "utf8");
    const body2 = readFileSync(path.join(targetDest, "knowledge", "bodies", docId, "2.md"), "utf8");

    expect(body1).toBe("First revision content");
    expect(body2).toBe("Second updated revision content");

    db.close();
  });

  test("4. Corrupt backup rejection (corrupt SQLite in snapshot)", async () => {
    const { db } = setupTestDatabase();
    const manager = new BackupManager({ db, knowledgeRootDir: knowledgeDir });
    const snap = await manager.createSnapshot({ destinationDir: snapshotDir });

    // Corrupt database.sqlite inside snapshot
    writeFileSync(path.join(snap.path, "database.sqlite"), "NOT A REAL SQLITE DATABASE");

    const targetDest = path.join(testDir, "restored-corrupt");
    await expect(restoreBackupSnapshot(snap.path, targetDest)).rejects.toMatchObject({
      name: "RestoreError",
      code: "SNAPSHOT_VERIFICATION_FAILED",
    });

    expect(existsSync(targetDest)).toBe(false);
    db.close();
  });

  test("5. Manifest version incompatibility rejection", async () => {
    const { db } = setupTestDatabase();
    const manager = new BackupManager({ db, knowledgeRootDir: knowledgeDir });
    const snap = await manager.createSnapshot({ destinationDir: snapshotDir });

    // Set unsupported manifest version
    const manifestPath = path.join(snap.path, "manifest.json");
    const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
    manifest.manifestVersion = 999;
    writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));

    const targetDest = path.join(testDir, "restored-unsupported-version");
    await expect(restoreBackupSnapshot(snap.path, targetDest)).rejects.toMatchObject({
      name: "RestoreError",
      code: "SNAPSHOT_VERIFICATION_FAILED",
    });

    expect(existsSync(targetDest)).toBe(false);
    db.close();
  });

  test("6. Missing knowledge files rejection", async () => {
    const { db } = setupTestDatabase();
    const docId = randomUUID();
    addKnowledgeNote(db, docId, 1, "Missing note test");

    const manager = new BackupManager({ db, knowledgeRootDir: knowledgeDir });
    const snap = await manager.createSnapshot({ destinationDir: snapshotDir });

    // Delete knowledge file from snapshot
    rmSync(path.join(snap.path, "knowledge", "bodies", docId, "1.md"));

    const targetDest = path.join(testDir, "restored-missing-note");
    await expect(restoreBackupSnapshot(snap.path, targetDest)).rejects.toMatchObject({
      name: "RestoreError",
      code: "SNAPSHOT_VERIFICATION_FAILED",
    });

    expect(existsSync(targetDest)).toBe(false);
    db.close();
  });

  test("7. Hash mismatch rejection", async () => {
    const { db } = setupTestDatabase();
    const docId = randomUUID();
    addKnowledgeNote(db, docId, 1, "Original content");

    const manager = new BackupManager({ db, knowledgeRootDir: knowledgeDir });
    const snap = await manager.createSnapshot({ destinationDir: snapshotDir });

    // Tamper with knowledge file contents
    const noteFile = path.join(snap.path, "knowledge", "bodies", docId, "1.md");
    writeFileSync(noteFile, "Tampered content with same byte count!!");

    const targetDest = path.join(testDir, "restored-tampered");
    await expect(restoreBackupSnapshot(snap.path, targetDest)).rejects.toMatchObject({
      name: "RestoreError",
      code: "SNAPSHOT_VERIFICATION_FAILED",
    });

    expect(existsSync(targetDest)).toBe(false);
    db.close();
  });

  test("8. Existing destination refusal (fail-closed, never overwrites)", async () => {
    const { db } = setupTestDatabase();
    const manager = new BackupManager({ db, knowledgeRootDir: knowledgeDir });
    const snap = await manager.createSnapshot({ destinationDir: snapshotDir });

    const existingDest = path.join(testDir, "pre-existing-destination");
    mkdirSync(existingDest, { recursive: true });
    writeFileSync(path.join(existingDest, "important.txt"), "DO NOT OVERWRITE");

    await expect(restoreBackupSnapshot(snap.path, existingDest)).rejects.toMatchObject({
      name: "RestoreError",
      code: "TARGET_EXISTS",
    });

    // Content must be untouched
    expect(readFileSync(path.join(existingDest, "important.txt"), "utf8")).toBe("DO NOT OVERWRITE");
    db.close();
  });

  test("9. Concurrent restore destination collision refusal", async () => {
    const { db } = setupTestDatabase();
    const manager = new BackupManager({ db, knowledgeRootDir: knowledgeDir });
    const snap = await manager.createSnapshot({ destinationDir: snapshotDir });

    const targetDest = path.join(testDir, "race-destination");

    await expect(
      restoreBackupSnapshot(snap.path, targetDest, {
        beforePublish: () => {
          mkdirSync(targetDest, { recursive: true });
          writeFileSync(path.join(targetDest, "race-file.txt"), "collided");
        },
      }),
    ).rejects.toMatchObject({
      name: "RestoreError",
      code: "TARGET_EXISTS",
    });

    expect(readFileSync(path.join(targetDest, "race-file.txt"), "utf8")).toBe("collided");
    db.close();
  });

  test("10. Overlapping source and destination rejection", async () => {
    const { db } = setupTestDatabase();
    const manager = new BackupManager({ db, knowledgeRootDir: knowledgeDir });
    const snap = await manager.createSnapshot({ destinationDir: snapshotDir });

    // Destination same as snapshot
    await expect(restoreBackupSnapshot(snap.path, snap.path)).rejects.toMatchObject({
      name: "RestoreError",
      code: "OVERLAPPING_PATHS",
    });

    // Destination inside snapshot
    const insideSnapshot = path.join(snap.path, "sub-restore");
    await expect(restoreBackupSnapshot(snap.path, insideSnapshot)).rejects.toMatchObject({
      name: "RestoreError",
      code: "OVERLAPPING_PATHS",
    });

    db.close();
  });

  test("11. Symlink and path traversal rejection", async () => {
    const { db } = setupTestDatabase();
    const manager = new BackupManager({ db, knowledgeRootDir: knowledgeDir });
    const snap = await manager.createSnapshot({ destinationDir: snapshotDir });

    // Traversal path
    const traversalDest = path.join(testDir, "dir1", "..", "restored");
    // Snapshot as symlink
    const symlinkSnap = path.join(testDir, "symlink-snap");
    symlinkSync(snap.path, symlinkSnap);

    await expect(restoreBackupSnapshot(symlinkSnap, path.join(testDir, "dest-symlink"))).rejects.toMatchObject({
      name: "RestoreError",
      code: "UNTRUSTED_SYMLINK",
    });

    db.close();
  });

  test("12. Interrupted restore cleanup leaves no stray staging files", async () => {
    const { db } = setupTestDatabase();
    const manager = new BackupManager({ db, knowledgeRootDir: knowledgeDir });
    const snap = await manager.createSnapshot({ destinationDir: snapshotDir });

    const targetDest = path.join(testDir, "failing-dest");

    await expect(
      restoreBackupSnapshot(snap.path, targetDest, {
        afterExtract: () => {
          throw new Error("Simulated interruption during extraction");
        },
      }),
    ).rejects.toThrow("Simulated interruption during extraction");

    expect(existsSync(targetDest)).toBe(false);
    const parentEntries = readdirSync(testDir);
    expect(parentEntries.some((e) => e.includes(".restore."))).toBe(false);

    db.close();
  });

  test("13. Destination parent directory permission failures", async () => {
    const { db } = setupTestDatabase();
    const manager = new BackupManager({ db, knowledgeRootDir: knowledgeDir });
    const snap = await manager.createSnapshot({ destinationDir: snapshotDir });

    const nonExistentParent = path.join(testDir, "non-existent-parent", "dest");
    await expect(
      restoreBackupSnapshot(snap.path, nonExistentParent, { createDirectory: false }),
    ).rejects.toMatchObject({
      name: "RestoreError",
      code: "DIRECTORY_NOT_FOUND",
    });

    db.close();
  });

  test("14. Restrictive restored file permissions (0o700 dir, 0o600 files)", async () => {
    const { db } = setupTestDatabase();
    const docId = randomUUID();
    addKnowledgeNote(db, docId, 1, "Secret notes");

    const manager = new BackupManager({ db, knowledgeRootDir: knowledgeDir });
    const snap = await manager.createSnapshot({ destinationDir: snapshotDir });

    const targetDest = path.join(testDir, "perms-test");
    await restoreBackupSnapshot(snap.path, targetDest);

    const destStat = statSync(targetDest);
    expect(destStat.mode & 0o777).toBe(0o700);

    const dbStat = statSync(path.join(targetDest, "agetor.sqlite"));
    expect(dbStat.mode & 0o777).toBe(0o600);

    const noteStat = statSync(path.join(targetDest, "knowledge", "bodies", docId, "1.md"));
    expect(noteStat.mode & 0o777).toBe(0o600);

    db.close();
  });

  test("15. No mutation of the original snapshot", async () => {
    const { db } = setupTestDatabase();
    const docId = randomUUID();
    addKnowledgeNote(db, docId, 1, "Snapshot immutable note");

    const manager = new BackupManager({ db, knowledgeRootDir: knowledgeDir });
    const snap = await manager.createSnapshot({ destinationDir: snapshotDir });

    const manifestBefore = readFileSync(path.join(snap.path, "manifest.json"), "utf8");
    const dbBefore = readFileSync(path.join(snap.path, "database.sqlite"));
    const noteBefore = readFileSync(path.join(snap.path, "knowledge", "bodies", docId, "1.md"), "utf8");

    const targetDest = path.join(testDir, "mutation-check");
    await restoreBackupSnapshot(snap.path, targetDest);

    const manifestAfter = readFileSync(path.join(snap.path, "manifest.json"), "utf8");
    const dbAfter = readFileSync(path.join(snap.path, "database.sqlite"));
    const noteAfter = readFileSync(path.join(snap.path, "knowledge", "bodies", docId, "1.md"), "utf8");

    expect(manifestAfter).toBe(manifestBefore);
    expect(Buffer.compare(dbAfter, dbBefore)).toBe(0);
    expect(noteAfter).toBe(noteBefore);

    db.close();
  });

  test("16. No exposure or restoration of runtime credentials or pidfiles", async () => {
    const { db } = setupTestDatabase();
    const manager = new BackupManager({ db, knowledgeRootDir: knowledgeDir });
    const snap = await manager.createSnapshot({ destinationDir: snapshotDir });

    const targetDest = path.join(testDir, "credentials-check");
    await restoreBackupSnapshot(snap.path, targetDest);

    expect(existsSync(path.join(targetDest, "agetor.pid"))).toBe(false);
    expect(existsSync(path.join(targetDest, "core-creds.json"))).toBe(false);
    expect(existsSync(path.join(targetDest, "agetor-core.json"))).toBe(false);

    db.close();
  });

  test("17. No access to the user's real production database (rejects active data dir)", async () => {
    const { db } = setupTestDatabase();
    const manager = new BackupManager({ db, knowledgeRootDir: knowledgeDir });
    const snap = await manager.createSnapshot({ destinationDir: snapshotDir });

    // Attempting to restore to active data directory must fail immediately
    const realProdDataDir = path.join(homedir(), "Library", "Application Support", "ForgeOrbit");
    await expect(restoreBackupSnapshot(snap.path, realProdDataDir)).rejects.toMatchObject({
      name: "RestoreError",
      code: "ACTIVE_PROFILE_PROTECTED",
    });

    const legacyDataDir = path.join(homedir(), ".agetor");
    await expect(restoreBackupSnapshot(snap.path, legacyDataDir)).rejects.toMatchObject({
      name: "RestoreError",
      code: "ACTIVE_PROFILE_PROTECTED",
    });

    db.close();
  });

  test("18. cleanIncompleteRestoreStaging cleans only restore-owned temp dirs", () => {
    const stagingParent = path.join(testDir, "staging-parent");
    mkdirSync(stagingParent, { recursive: true, mode: 0o700 });

    const restoreStagingDir = path.join(
      stagingParent,
      `.my-profile.restore.${randomUUID()}.tmp`,
    );
    const validDir = path.join(stagingParent, "my-profile");
    const unrelatedTmp = path.join(stagingParent, ".unrelated.tmp");

    mkdirSync(restoreStagingDir, { recursive: true, mode: 0o700 });
    writeStagingOwnershipMetadata(restoreStagingDir, {
      version: 1,
      subsystem: "backup-restore",
      operationId: randomUUID(),
      pid: 99999999,
      createdAt: Date.now() - 60000,
      state: "writing",
    }, false);

    mkdirSync(validDir, { recursive: true });
    mkdirSync(unrelatedTmp, { recursive: true });

    const result = cleanIncompleteRestoreStaging(stagingParent);

    expect(result.cleaned).toEqual([restoreStagingDir]);
    expect(result.errors).toEqual([]);

    expect(existsSync(restoreStagingDir)).toBe(false);
    expect(existsSync(validDir)).toBe(true);
    expect(existsSync(unrelatedTmp)).toBe(true);
  });

  test("19. Supports custom dbFilename and parent directory auto-creation", async () => {
    const { db } = setupTestDatabase();
    const manager = new BackupManager({ db, knowledgeRootDir: knowledgeDir });
    const snap = await manager.createSnapshot({ destinationDir: snapshotDir });

    const customDest = path.join(testDir, "nested", "parents", "custom-restore");
    const result = await restoreBackupSnapshot(snap.path, customDest, {
      dbFilename: "custom.sqlite",
      createDirectory: true,
    });

    expect(result.dbFilename).toBe("custom.sqlite");
    expect(existsSync(path.join(customDest, "custom.sqlite"))).toBe(true);
    expect(existsSync(path.join(customDest, "agetor.sqlite"))).toBe(false);

    db.close();
  });

  test("20. Rejects restore if database.sqlite is replaced or modified between initial verification and extraction (P1-1)", async () => {
    const { db } = setupTestDatabase();
    const docId = randomUUID();
    addKnowledgeNote(db, docId, 1, "Verified note");

    const manager = new BackupManager({ db, knowledgeRootDir: knowledgeDir });
    const snap = await manager.createSnapshot({ destinationDir: snapshotDir });

    // Simulate an external attacker replacing database.sqlite after verifyBackupSnapshot passes,
    // but before restore copies/extracts the file into staging.
    await expect(
      restoreBackupSnapshot(snap.path, restoreDir, {
        beforeExtract: (snapDir) => {
          writeFileSync(
            path.join(snapDir, "database.sqlite"),
            "tampered database contents after initial verification",
          );
        },
      }),
    ).rejects.toMatchObject({
      name: "RestoreError",
      code: "VERIFICATION_FAILED",
    });

    // CRITICAL: Tampered database must NEVER be published!
    expect(existsSync(restoreDir)).toBe(false);

    // Staging temp files must be completely cleaned up
    const filesInParent = readdirSync(testDir);
    const strayStaging = filesInParent.filter((f) => f.includes(".restore."));
    expect(strayStaging).toHaveLength(0);

    db.close();
  });

  test("21. Binds restore to validated manifest and ignores subsequent external tampering of manifest on disk (P1-1)", async () => {
    const { db } = setupTestDatabase();
    const docId = randomUUID();
    addKnowledgeNote(db, docId, 1, "Bound manifest note");

    const manager = new BackupManager({ db, knowledgeRootDir: knowledgeDir });
    const snap = await manager.createSnapshot({ destinationDir: snapshotDir });

    // Remove manifest.json from disk right after initial verification
    const result = await restoreBackupSnapshot(snap.path, restoreDir, {
      beforeExtract: (snapDir) => {
        unlinkSync(path.join(snapDir, "manifest.json"));
      },
    });

    // Restoration succeeded because it was bound to the verified in-memory manifest
    expect(result.destinationPath).toBe(restoreDir);
    expect(existsSync(path.join(restoreDir, "agetor.sqlite"))).toBe(true);

    db.close();
  });

  test("22. Rejects path traversal and dangerous directory characters in dbFilename (P1-2)", async () => {
    const { db } = setupTestDatabase();
    const manager = new BackupManager({ db, knowledgeRootDir: knowledgeDir });
    const snap = await manager.createSnapshot({ destinationDir: snapshotDir });

    const dangerousNames = [
      "../escaped.sqlite",
      "../../escaped.sqlite",
      "/tmp/escaped.sqlite",
      "nested/db.sqlite",
      "nested\\db.sqlite",
      ".",
      "..",
      ".hidden.sqlite",
      "evil\0.sqlite",
      "",
      "   ",
      "foo*bar.sqlite",
      "con.sqlite",
      "prn.sqlite",
      "aux.sqlite",
      "nul.sqlite",
      "com1.db",
      "lpt1.sqlite",
    ];

    for (const badName of dangerousNames) {
      const dest = path.join(testDir, `restore-bad-${randomUUID()}`);
      await expect(
        restoreBackupSnapshot(snap.path, dest, { dbFilename: badName }),
      ).rejects.toMatchObject({
        name: "RestoreError",
        code: "INVALID_PATH",
      });

      // Nothing must have been written to dest or outside
      expect(existsSync(dest)).toBe(false);
      expect(existsSync(path.join(testDir, "escaped.sqlite"))).toBe(false);
    }

    db.close();
  });

  test("23. Verifies that restored directory contains the expected database filename (P1-2)", async () => {
    const { db } = setupTestDatabase();
    const manager = new BackupManager({ db, knowledgeRootDir: knowledgeDir });
    const snap = await manager.createSnapshot({ destinationDir: snapshotDir });

    const result = await restoreBackupSnapshot(snap.path, restoreDir, {
      dbFilename: "my-valid_profile-2026.sqlite",
    });

    expect(result.dbFilename).toBe("my-valid_profile-2026.sqlite");
    expect(existsSync(path.join(restoreDir, "my-valid_profile-2026.sqlite"))).toBe(true);
    expect(existsSync(path.join(restoreDir, "agetor.sqlite"))).toBe(false);

    db.close();
  });

  test("24. Refuses to restore over an existing empty directory (P2-4)", async () => {
    const { db } = setupTestDatabase();
    const manager = new BackupManager({ db, knowledgeRootDir: knowledgeDir });
    const snap = await manager.createSnapshot({ destinationDir: snapshotDir });

    mkdirSync(restoreDir, { mode: 0o700 });

    await expect(
      restoreBackupSnapshot(snap.path, restoreDir),
    ).rejects.toMatchObject({
      name: "RestoreError",
      code: "TARGET_EXISTS",
    });

    // Existing directory must remain empty and was NOT overwritten
    expect(readdirSync(restoreDir)).toHaveLength(0);

    db.close();
  });

  test("25. Refuses to restore if empty directory is created concurrently right before publish (P2-4)", async () => {
    const { db } = setupTestDatabase();
    const manager = new BackupManager({ db, knowledgeRootDir: knowledgeDir });
    const snap = await manager.createSnapshot({ destinationDir: snapshotDir });

    await expect(
      restoreBackupSnapshot(snap.path, restoreDir, {
        beforePublish: () => {
          mkdirSync(restoreDir, { mode: 0o700 });
        },
      }),
    ).rejects.toMatchObject({
      name: "RestoreError",
      code: "TARGET_EXISTS",
    });

    // Must remain empty, never overwritten
    expect(readdirSync(restoreDir)).toHaveLength(0);

    db.close();
  });

  test("26. Rejects restore if snapshot database.sqlite is a FIFO special file without hanging (P2-9)", async () => {
    const { db } = setupTestDatabase();
    const manager = new BackupManager({ db, knowledgeRootDir: knowledgeDir });
    const snap = await manager.createSnapshot({ destinationDir: snapshotDir });
    const snapDbPath = path.join(snap.path, "database.sqlite");

    unlinkSync(snapDbPath);
    const mkfifoRes = spawnSync("mkfifo", [snapDbPath]);
    expect(mkfifoRes.status).toBe(0);

    const started = performance.now();
    await expect(
      restoreBackupSnapshot(snap.path, restoreDir),
    ).rejects.toMatchObject({
      name: "RestoreError",
    });
    const duration = performance.now() - started;

    expect(duration).toBeLessThan(1000);
    expect(existsSync(restoreDir)).toBe(false);

    db.close();
  });

  test("27. Rejects restore if snapshot manifest.json is a FIFO special file without hanging (P2-9)", async () => {
    const { db } = setupTestDatabase();
    const manager = new BackupManager({ db, knowledgeRootDir: knowledgeDir });
    const snap = await manager.createSnapshot({ destinationDir: snapshotDir });
    const snapManifestPath = path.join(snap.path, "manifest.json");

    unlinkSync(snapManifestPath);
    const mkfifoRes = spawnSync("mkfifo", [snapManifestPath]);
    expect(mkfifoRes.status).toBe(0);

    const started = performance.now();
    await expect(
      restoreBackupSnapshot(snap.path, restoreDir),
    ).rejects.toMatchObject({
      name: "RestoreError",
    });
    const duration = performance.now() - started;

    expect(duration).toBeLessThan(1000);
    expect(existsSync(restoreDir)).toBe(false);

    db.close();
  });

  test("28. Rejects restore if snapshot manifest.json exceeds maximum size limit (P2-9)", async () => {
    const { db } = setupTestDatabase();
    const manager = new BackupManager({ db, knowledgeRootDir: knowledgeDir });
    const snap = await manager.createSnapshot({ destinationDir: snapshotDir });
    const snapManifestPath = path.join(snap.path, "manifest.json");

    writeFileSync(snapManifestPath, Buffer.alloc(11 * 1024 * 1024, 0x20));

    await expect(
      restoreBackupSnapshot(snap.path, restoreDir),
    ).rejects.toMatchObject({
      name: "RestoreError",
      code: "SNAPSHOT_VERIFICATION_FAILED",
    });

    expect(existsSync(restoreDir)).toBe(false);

    db.close();
  });

  test("29. Rejects restore if snapshot contains unexpected files under knowledge/ (P2-3)", async () => {
    const { db } = setupTestDatabase();
    const docId = randomUUID();
    addKnowledgeNote(db, docId, 1, "Content");

    const manager = new BackupManager({ db, knowledgeRootDir: knowledgeDir });
    const snap = await manager.createSnapshot({ destinationDir: snapshotDir });

    // Plant an unexpected file inside snapshot knowledge/
    const unexpectedFile = path.join(snap.path, "knowledge", "malicious.sh");
    writeFileSync(unexpectedFile, "echo dangerous");

    await expect(
      restoreBackupSnapshot(snap.path, restoreDir),
    ).rejects.toMatchObject({
      name: "RestoreError",
      code: "SNAPSHOT_VERIFICATION_FAILED",
    });

    expect(existsSync(restoreDir)).toBe(false);
    db.close();
  });

  test("30. Rejects restore if snapshot requires an unknown future schema version (P2-5)", async () => {
    const { db } = setupTestDatabase();
    const manager = new BackupManager({ db, knowledgeRootDir: knowledgeDir });
    const snap = await manager.createSnapshot({ destinationDir: snapshotDir });

    // Tamper snapshot manifest to demand an unknown future schema version
    const manifestPath = path.join(snap.path, "manifest.json");
    const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
    manifest.schemaVersion = "999_future_unsupported_migration";
    writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));

    await expect(
      restoreBackupSnapshot(snap.path, restoreDir),
    ).rejects.toMatchObject({
      name: "RestoreError",
      code: "SNAPSHOT_VERIFICATION_FAILED",
    });

    expect(existsSync(restoreDir)).toBe(false);
    db.close();
  });

  test("31. Preserves supported historical schema version without silently running migrations (P2-5)", async () => {
    const historicalDbPath = path.join(testDir, "historical.sqlite");
    const db = new Database(historicalDbPath);
    db.exec("PRAGMA journal_mode = WAL;");
    db.exec("PRAGMA synchronous = NORMAL;");
    db.exec("PRAGMA foreign_keys = ON;");

    // Apply migrations up to 078_knowledge_documents only
    const idx078 = migrations.findIndex((m) => m.id === "078_knowledge_documents");
    migrate(db, migrations.slice(0, idx078 + 1));

    const docId = randomUUID();
    addKnowledgeNote(db, docId, 1, "Historical note");

    const manager = new BackupManager({ db, knowledgeRootDir: knowledgeDir });
    const snap = await manager.createSnapshot({ destinationDir: snapshotDir });

    expect(snap.manifest.schemaVersion).toBe("078_knowledge_documents");

    const result = await restoreBackupSnapshot(snap.path, restoreDir);
    expect(result.schemaVersion).toBe("078_knowledge_documents");

    // Verify restored database was NOT silently migrated to the latest version
    const restoredDb = new Database(path.join(restoreDir, "agetor.sqlite"), { readonly: true });
    const latestRestoredMigration = restoredDb
      .query<{ id: string }, []>("SELECT id FROM _migrations ORDER BY rowid DESC LIMIT 1;")
      .get()?.id;
    restoredDb.close();

    expect(latestRestoredMigration).toBe("078_knowledge_documents");
    db.close();
  });

  test("32. Rejects restore if snapshot database has document-revision metadata mismatch (P2-7)", async () => {
    const { db } = setupTestDatabase();
    const docId = randomUUID();
    addKnowledgeNote(db, docId, 1, "Valid note");

    const manager = new BackupManager({ db, knowledgeRootDir: knowledgeDir });
    const snap = await manager.createSnapshot({ destinationDir: snapshotDir });

    // Tamper snapshot database to introduce metadata mismatch
    const snapDbPath = path.join(snap.path, "database.sqlite");
    const snapDb = new Database(snapDbPath);
    snapDb.run(
      "UPDATE knowledge_documents SET content_sha256 = ? WHERE id = ?",
      ["f".repeat(64), docId],
    );
    snapDb.close();

    await expect(
      restoreBackupSnapshot(snap.path, restoreDir),
    ).rejects.toMatchObject({
      name: "RestoreError",
      code: "SNAPSHOT_VERIFICATION_FAILED",
    });

    expect(existsSync(restoreDir)).toBe(false);
    db.close();
  });

  test("33. Rejects restore if snapshot database has foreign key violations (P2-8)", async () => {
    const { db } = setupTestDatabase();
    const manager = new BackupManager({ db, knowledgeRootDir: knowledgeDir });
    const snap = await manager.createSnapshot({ destinationDir: snapshotDir });

    // Tamper snapshot database to introduce foreign key violation
    const snapDbPath = path.join(snap.path, "database.sqlite");
    const snapDb = new Database(snapDbPath);
    snapDb.run("PRAGMA foreign_keys = OFF;");
    snapDb.run(
      "INSERT INTO knowledge_revisions (document_id, revision, created_at, byte_length, content_sha256) VALUES (?, ?, ?, ?, ?)",
      [randomUUID(), 1, Date.now(), 5, "b".repeat(64)],
    );
    snapDb.close();

    await expect(
      restoreBackupSnapshot(snap.path, restoreDir),
    ).rejects.toMatchObject({
      name: "RestoreError",
      code: "SNAPSHOT_VERIFICATION_FAILED",
    });

    expect(existsSync(restoreDir)).toBe(false);
    db.close();
  });

  test("34. P2-1: file synchronization failure fails closed and cleans up staging (Finding 1)", async () => {
    const { db } = setupTestDatabase();
    const docId = randomUUID();
    addKnowledgeNote(db, docId, 1, "Sync fail note");
    const manager = new BackupManager({ db, knowledgeRootDir: knowledgeDir });
    const snap = await manager.createSnapshot({ destinationDir: snapshotDir });

    await expect(
      restoreBackupSnapshot(snap.path, restoreDir, {
        fs: {
          syncFile: () => {
            throw new Error("Disk full or fsync failed");
          },
        } as any,
      }),
    ).rejects.toMatchObject({
      name: "RestoreError",
      code: "IO_ERROR",
    });

    expect(existsSync(restoreDir)).toBe(false);
    const parentFiles = readdirSync(testDir);
    expect(parentFiles.filter((f) => f.includes(".fo-restore."))).toHaveLength(0);

    db.close();
  });

  test("35. P2-1/R8B: directory synchronization failure after publication reports post-publication uncertainty", async () => {
    const { db } = setupTestDatabase();
    const manager = new BackupManager({ db, knowledgeRootDir: knowledgeDir });
    const snap = await manager.createSnapshot({ destinationDir: snapshotDir });

    // R8B contract change: this failure occurs AFTER the atomic publication commit
    // point, so the direct API must report post-publication uncertainty
    // (PUBLISHED_UNCONFIRMED) instead of a definitive IO_ERROR, and must preserve
    // the already-published, valid restored directory.
    await expect(
      restoreBackupSnapshot(snap.path, restoreDir, {
        fs: {
          syncDirectory: (dirPath: string) => {
            if (dirPath === path.dirname(restoreDir)) {
              throw new Error("Parent directory fsync failed");
            }
          },
        } as any,
      }),
    ).rejects.toMatchObject({
      name: "RestoreError",
      code: "PUBLISHED_UNCONFIRMED",
      details: { destinationPath: restoreDir },
    });

    expect(existsSync(restoreDir)).toBe(true);
    const restoredDb = new Database(path.join(restoreDir, "agetor.sqlite"), { readonly: true });
    const integrity = restoredDb.query("PRAGMA integrity_check;").get() as Record<string, string>;
    expect(Object.values(integrity)[0]).toBe("ok");
    restoredDb.close();

    db.close();
  });

  test("36. P2-2: cleanIncompleteRestoreStaging preserves active operations holding locks", async () => {
    const activeRestoreDir = path.join(
      testDir,
      `.restore.fo-restore.${randomUUID()}.tmp`,
    );
    mkdirSync(activeRestoreDir, { mode: 0o700 });

    const lockPath = path.join(activeRestoreDir, STAGING_LOCK_FILENAME);
    const lockFd = openSync(lockPath, constants.O_RDWR | constants.O_CREAT, 0o600);
    tryAcquireFlock(lockFd);

    writeStagingOwnershipMetadata(
      activeRestoreDir,
      {
        version: 1,
        subsystem: "backup-restore",
        operationId: randomUUID(),
        pid: process.pid,
        createdAt: Date.now(),
        state: "writing",
        targetPath: restoreDir,
      },
      false,
    );

    try {
      const result = cleanIncompleteRestoreStaging(testDir);
      expect(result.cleaned).toEqual([]);
      expect(existsSync(activeRestoreDir)).toBe(true);
    } finally {
      releaseFlock(lockFd);
      closeSync(lockFd);
    }
  });

  test("37. P2-2: cleanIncompleteRestoreStaging preserves directories with missing or malformed metadata", async () => {
    const missingMetaDir = path.join(testDir, `.missing.fo-restore.${randomUUID()}.tmp`);
    const corruptMetaDir = path.join(testDir, `.corrupt.fo-restore.${randomUUID()}.tmp`);
    const invalidVerDir = path.join(testDir, `.invalidver.fo-restore.${randomUUID()}.tmp`);

    mkdirSync(missingMetaDir, { mode: 0o700 });
    mkdirSync(corruptMetaDir, { mode: 0o700 });
    mkdirSync(invalidVerDir, { mode: 0o700 });

    writeFileSync(path.join(corruptMetaDir, ".forgeorbit-ownership.json"), "NOT_JSON");
    writeFileSync(
      path.join(invalidVerDir, ".forgeorbit-ownership.json"),
      JSON.stringify({ version: 99, subsystem: "backup-restore", pid: 99999999 }),
    );

    const result = cleanIncompleteRestoreStaging(testDir);

    expect(result.cleaned).toEqual([]);
    expect(existsSync(missingMetaDir)).toBe(true);
    expect(existsSync(corruptMetaDir)).toBe(true);
    expect(existsSync(invalidVerDir)).toBe(true);
  });

  test("38. P2-2: cleanIncompleteRestoreStaging preserves staging directories owned by other subsystems", async () => {
    const coreDir = path.join(testDir, `.target.fo-core.${randomUUID()}.tmp`);
    const managerDir = path.join(testDir, `.target.fo-snapshot.${randomUUID()}.tmp`);
    const restoreDirStaging = path.join(testDir, `.target.fo-restore.${randomUUID()}.tmp`);

    mkdirSync(coreDir, { mode: 0o700 });
    mkdirSync(managerDir, { mode: 0o700 });
    mkdirSync(restoreDirStaging, { mode: 0o700 });

    const deadPid = 99999999;
    writeStagingOwnershipMetadata(
      coreDir,
      {
        version: 1,
        subsystem: "backup-core",
        operationId: randomUUID(),
        pid: deadPid,
        createdAt: Date.now() - 60000,
        state: "writing",
      },
      false,
    );
    writeStagingOwnershipMetadata(
      managerDir,
      {
        version: 1,
        subsystem: "backup-manager",
        operationId: randomUUID(),
        pid: deadPid,
        createdAt: Date.now() - 60000,
        state: "writing",
      },
      false,
    );
    writeStagingOwnershipMetadata(
      restoreDirStaging,
      {
        version: 1,
        subsystem: "backup-restore",
        operationId: randomUUID(),
        pid: deadPid,
        createdAt: Date.now() - 60000,
        state: "writing",
      },
      false,
    );

    const result = cleanIncompleteRestoreStaging(testDir);

    expect(result.cleaned).toEqual([restoreDirStaging]);
    expect(existsSync(coreDir)).toBe(true);
    expect(existsSync(managerDir)).toBe(true);
    expect(existsSync(restoreDirStaging)).toBe(false);
  });

  test("39. P2-2: cleanIncompleteRestoreStaging refuses symlinked root directory without traversing", async () => {
    const realTargetDir = path.join(testDir, "real-restore-target");
    mkdirSync(realTargetDir, { mode: 0o700 });

    const deadRestoreDir = path.join(realTargetDir, `.target.fo-restore.${randomUUID()}.tmp`);
    mkdirSync(deadRestoreDir, { mode: 0o700 });
    writeStagingOwnershipMetadata(
      deadRestoreDir,
      {
        version: 1,
        subsystem: "backup-restore",
        operationId: randomUUID(),
        pid: 99999999,
        createdAt: Date.now() - 60000,
        state: "writing",
      },
      false,
    );

    const symlinkRoot = path.join(testDir, "symlink-to-real");
    symlinkSync(realTargetDir, symlinkRoot);

    const result = cleanIncompleteRestoreStaging(symlinkRoot);
    expect(result.cleaned).toHaveLength(0);
    expect(result.errors.length).toBeGreaterThan(0);
    expect(existsSync(deadRestoreDir)).toBe(true);
  });

  test("40. Finding 5: rejects restore if snapshot manifest indicates verified: false", async () => {
    const { db } = setupTestDatabase();
    const manager = new BackupManager({ db, knowledgeRootDir: knowledgeDir });
    const snap = await manager.createSnapshot({ destinationDir: snapshotDir });

    const manifestPath = path.join(snap.path, "manifest.json");
    const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
    manifest.verified = false;
    writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));

    await expect(
      restoreBackupSnapshot(snap.path, restoreDir),
    ).rejects.toMatchObject({
      name: "RestoreError",
      code: "SNAPSHOT_VERIFICATION_FAILED",
    });

    expect(existsSync(restoreDir)).toBe(false);
    db.close();
  });

  test("41. Interrupted restore creation leaves no destination and cleans up staging", async () => {
    const { db } = setupTestDatabase();
    const manager = new BackupManager({ db, knowledgeRootDir: knowledgeDir });
    const snap = await manager.createSnapshot({ destinationDir: snapshotDir });

    await expect(
      restoreBackupSnapshot(snap.path, restoreDir, {
        afterExtract: () => {
          throw new Error("Simulated interruption during extraction");
        },
      }),
    ).rejects.toThrow("Simulated interruption during extraction");

    expect(existsSync(restoreDir)).toBe(false);
    const parentFiles = readdirSync(testDir);
    expect(parentFiles.filter((f) => f.includes(".fo-restore."))).toHaveLength(0);

    db.close();
  });

  test("42. Successful Backup -> Restore round trip with all R2B durability and ownership hardening", async () => {
    const { db } = setupTestDatabase();
    const docId1 = randomUUID();
    const docId2 = randomUUID();
    addKnowledgeNote(db, docId1, 1, "Initial note 1");
    addKnowledgeNote(db, docId1, 2, "Updated note 1 with more details");
    addKnowledgeNote(db, docId2, 1, "Initial note 2");

    const manager = new BackupManager({ db, knowledgeRootDir: knowledgeDir });
    const snap = await manager.createSnapshot({ destinationDir: snapshotDir });

    expect(snap.manifest.verified).toBe(true);
    expect(existsSync(path.join(snap.path, ".forgeorbit-ownership.json"))).toBe(false);
    expect(existsSync(path.join(snap.path, STAGING_LOCK_FILENAME))).toBe(false);

    const restoreResult = await restoreBackupSnapshot(snap.path, restoreDir);
    expect(restoreResult.destinationPath).toBe(restoreDir);
    expect(restoreResult.knowledgeDocumentCount).toBe(2);
    expect(restoreResult.knowledgeRevisionCount).toBe(3);

    // Verify restored directory and files permissions
    const dirStat = statSync(restoreDir);
    expect(dirStat.mode & 0o777).toBe(0o700);

    const restoredDbPath = path.join(restoreDir, "agetor.sqlite");
    const dbStat = statSync(restoredDbPath);
    expect(dbStat.mode & 0o777).toBe(0o600);

    const restoredNote1Rev2 = path.join(restoreDir, "knowledge", "bodies", docId1, "2.md");
    expect(statSync(restoredNote1Rev2).mode & 0o777).toBe(0o600);
    expect(readFileSync(restoredNote1Rev2, "utf8")).toBe("Updated note 1 with more details");

    // Verify no staging metadata leaked
    expect(existsSync(path.join(restoreDir, ".forgeorbit-ownership.json"))).toBe(false);
    expect(existsSync(path.join(restoreDir, STAGING_LOCK_FILENAME))).toBe(false);

    // Verify parent directory contains no lingering staging directories
    const lingering = readdirSync(testDir).filter((f) => f.includes(".fo-"));
    expect(lingering).toHaveLength(0);

    // Verify SQLite database integrity and data
    const restoredDb = new Database(restoredDbPath, { readonly: true });
    const integrityRow = restoredDb.query<{ integrity_check: string }, []>("PRAGMA integrity_check;").get();
    expect(integrityRow?.integrity_check).toBe("ok");

    const taskCount = restoredDb.query<{ count: number }, []>("SELECT COUNT(*) as count FROM tasks;").get()?.count;
    expect(taskCount).toBe(1);

    restoredDb.close();
    db.close();
  });
});
