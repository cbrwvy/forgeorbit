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
import { tmpdir } from "node:os";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import {
  BackupManager,
  BackupManagerError,
  createBackupSnapshot,
  verifyBackupSnapshot,
  cleanIncompleteBackupSnapshots,
  type SnapshotResult,
} from "./backup-manager.ts";
import { migrate } from "./migrate.ts";
import { migrations } from "./migrations/index.ts";

describe("Reliable Backup Manager and Snapshot Packaging (FO-P2-002)", () => {
  let testDir: string;
  let knowledgeDir: string;
  let backupOutputDir: string;
  let prevForgeorbit: string | undefined;
  let prevAgetor: string | undefined;

  beforeEach(() => {
    testDir = mkdtempSync(path.join(tmpdir(), "fo-backup-mgr-test-"));
    knowledgeDir = path.join(testDir, "knowledge");
    backupOutputDir = path.join(testDir, "backups");

    prevForgeorbit = process.env.FORGEORBIT_DATA_DIR;
    prevAgetor = process.env.AGETOR_DATA_DIR;
    process.env.FORGEORBIT_DATA_DIR = testDir;
    process.env.AGETOR_DATA_DIR = testDir;

    mkdirSync(knowledgeDir, { recursive: true, mode: 0o700 });
    mkdirSync(backupOutputDir, { recursive: true, mode: 0o700 });
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

    // Apply all repository migrations so schema matches real ForgeOrbit
    migrate(db, migrations);

    db.run(
      "INSERT INTO projects (path, name, added_at) VALUES (?, ?, ?)",
      ["/code/my-project", "My Project", 1000],
    );
    db.run(
      "INSERT INTO tasks (id, title, prompt, column, agent, workdir, isolation, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
      ["task-1", "First task", "Do something", "ready", "claude-code", "/code/my-project", "worktree", 1001, 1001],
    );

    return { db, dbPath };
  }

  function addKnowledgeNote(
    db: Database,
    id: string,
    revision: number,
    content: string,
    owner = { kind: "project", id: "/code/my-project" },
  ): { docId: string; revision: number; sha256: string; byteLength: number } {
    const bytes = Buffer.from(content, "utf8");
    const hash = sha256Hex(bytes);
    const byteLength = bytes.length;
    const now = Date.now();

    // Write file to knowledgeDir/bodies/<id>/<revision>.md
    const docBodiesDir = path.join(knowledgeDir, "bodies", id);
    mkdirSync(docBodiesDir, { recursive: true, mode: 0o700 });
    const filePath = path.join(docBodiesDir, `${revision}.md`);
    writeFileSync(filePath, bytes, { mode: 0o600 });

    if (revision === 1) {
      db.run(
        `INSERT INTO knowledge_documents (
           id, owner_kind, owner_id, title, description, category, tags_json, sensitive,
           revision, created_at, updated_at, archived_at, content_sha256, byte_length
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?)`,
        [
          id,
          owner.kind,
          owner.id,
          `Title for ${id}`,
          "Desc",
          "general",
          "[]",
          0,
          1,
          now,
          now,
          hash,
          byteLength,
        ],
      );
    } else {
      db.run(
        `UPDATE knowledge_documents SET revision = ?, updated_at = ?, content_sha256 = ?, byte_length = ? WHERE id = ?`,
        [revision, now, hash, byteLength, id],
      );
    }

    db.run(
      `INSERT INTO knowledge_revisions (document_id, revision, created_at, byte_length, content_sha256) VALUES (?, ?, ?, ?, ?)`,
      [id, revision, now, byteLength, hash],
    );

    return { docId: id, revision, sha256: hash, byteLength };
  }

  test("creates a complete, verified snapshot bundle with database and revision-pinned knowledge files", async () => {
    const { db } = setupTestDatabase();
    const docId1 = randomUUID();
    const docId2 = randomUUID();

    addKnowledgeNote(db, docId1, 1, "# Architecture Doc\nInitial draft.");
    addKnowledgeNote(db, docId1, 2, "# Architecture Doc\nSecond revision with updates.");
    addKnowledgeNote(db, docId2, 1, "# Deployment Runbook\nStep 1: Build.");

    const manager = new BackupManager({
      db,
      knowledgeRootDir: knowledgeDir,
      appVersion: "1.0.3-test",
    });

    const result = await manager.createSnapshot({
      destinationDir: backupOutputDir,
    });

    expect(existsSync(result.path)).toBe(true);
    expect(result.durationMs).toBeGreaterThanOrEqual(0);
    expect(result.snapshotId).toBeDefined();

    // Manifest must exist and be valid
    const manifestPath = path.join(result.path, "manifest.json");
    expect(existsSync(manifestPath)).toBe(true);
    const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));

    expect([2, 3, 4]).toContain(manifest.manifestVersion);
    expect(manifest.coverage).toBe("complete-profile");
    expect(manifest.appVersion).toBe("1.0.3-test");
    expect(manifest.schemaVersion).toBe("095_task_queue_progression");
    expect(manifest.verified).toBe(true);
    expect(manifest.stats.knowledgeDocumentCount).toBe(2);
    expect(manifest.stats.knowledgeRevisionCount).toBe(3);
    expect(manifest.stats.fileCount).toBe(4); // 1 db + 3 knowledge files

    // Verify snapshot file contents
    const dbPath = path.join(result.path, "database.sqlite");
    expect(existsSync(dbPath)).toBe(true);

    const doc1Rev1Path = path.join(result.path, "knowledge", "bodies", docId1, "1.md");
    const doc1Rev2Path = path.join(result.path, "knowledge", "bodies", docId1, "2.md");
    const doc2Rev1Path = path.join(result.path, "knowledge", "bodies", docId2, "1.md");

    expect(existsSync(doc1Rev1Path)).toBe(true);
    expect(existsSync(doc1Rev2Path)).toBe(true);
    expect(existsSync(doc2Rev1Path)).toBe(true);

    expect(readFileSync(doc1Rev1Path, "utf8")).toBe("# Architecture Doc\nInitial draft.");
    expect(readFileSync(doc1Rev2Path, "utf8")).toBe("# Architecture Doc\nSecond revision with updates.");
    expect(readFileSync(doc2Rev1Path, "utf8")).toBe("# Deployment Runbook\nStep 1: Build.");

    // Independent snapshot verification must pass
    const verification = await verifyBackupSnapshot(result.path);
    expect(verification.ok).toBe(true);
    expect(verification.issues).toEqual([]);
    expect(verification.filesChecked).toBe(4);

    db.close();
  });

  test("verifies database and knowledge contents can be queried independently from snapshot", async () => {
    const { db } = setupTestDatabase();
    const docId = randomUUID();
    addKnowledgeNote(db, docId, 1, "Snapshot test content");

    const manager = new BackupManager({ db, knowledgeRootDir: knowledgeDir });
    const targetSnapshotDir = path.join(backupOutputDir, "explicit-snapshot");

    await manager.createSnapshot({ destinationPath: targetSnapshotDir });

    const snapDb = new Database(path.join(targetSnapshotDir, "database.sqlite"), { readonly: true });
    const tasks = snapDb.query("SELECT id, title FROM tasks").all();
    expect(tasks).toEqual([{ id: "task-1", title: "First task" }]);

    const docs = snapDb.query("SELECT id, revision FROM knowledge_documents").all();
    expect(docs).toEqual([{ id: docId, revision: 1 }]);
    snapDb.close();

    db.close();
  });

  test("fails snapshot if a referenced knowledge revision file is missing on disk", async () => {
    const { db } = setupTestDatabase();
    const docId = randomUUID();
    addKnowledgeNote(db, docId, 1, "Will be removed");

    // Delete the revision file from disk
    const onDiskFile = path.join(knowledgeDir, "bodies", docId, "1.md");
    rmSync(onDiskFile);

    const manager = new BackupManager({ db, knowledgeRootDir: knowledgeDir });
    const targetSnapshotDir = path.join(backupOutputDir, "failing-snapshot");

    await expect(
      manager.createSnapshot({ destinationPath: targetSnapshotDir }),
    ).rejects.toMatchObject({
      name: "BackupManagerError",
      code: "INCONSISTENT_KNOWLEDGE",
    });

    // Destination snapshot directory must NOT exist
    expect(existsSync(targetSnapshotDir)).toBe(false);

    // Staging directories must have been cleanly removed
    const remaining = readdirSync(backupOutputDir);
    expect(remaining.filter((f) => f.includes(".tmp"))).toEqual([]);

    db.close();
  });

  test("fails snapshot if a referenced knowledge file has a checksum mismatch on disk", async () => {
    const { db } = setupTestDatabase();
    const docId = randomUUID();
    addKnowledgeNote(db, docId, 1, "Original content");

    // Tamper with the revision file on disk
    const onDiskFile = path.join(knowledgeDir, "bodies", docId, "1.md");
    writeFileSync(onDiskFile, "Tampered content that does not match SQLite SHA-256");

    const manager = new BackupManager({ db, knowledgeRootDir: knowledgeDir });
    const targetSnapshotDir = path.join(backupOutputDir, "tampered-source-snapshot");

    await expect(
      manager.createSnapshot({ destinationPath: targetSnapshotDir }),
    ).rejects.toMatchObject({
      name: "BackupManagerError",
      code: "INCONSISTENT_KNOWLEDGE",
    });

    expect(existsSync(targetSnapshotDir)).toBe(false);

    db.close();
  });

  test("rejects untrusted symlinks in knowledge storage", async () => {
    const { db } = setupTestDatabase();
    const docId = randomUUID();
    const content = "Real note content";
    addKnowledgeNote(db, docId, 1, content);

    // Replace the file with a symlink pointing to an external file
    const onDiskFile = path.join(knowledgeDir, "bodies", docId, "1.md");
    const externalFile = path.join(testDir, "external.txt");
    writeFileSync(externalFile, content);
    rmSync(onDiskFile);
    symlinkSync(externalFile, onDiskFile);

    const manager = new BackupManager({ db, knowledgeRootDir: knowledgeDir });
    const targetSnapshotDir = path.join(backupOutputDir, "symlink-snapshot");

    await expect(
      manager.createSnapshot({ destinationPath: targetSnapshotDir }),
    ).rejects.toMatchObject({
      name: "BackupManagerError",
      code: "UNTRUSTED_SYMLINK",
    });

    expect(existsSync(targetSnapshotDir)).toBe(false);

    db.close();
  });

  test("refuses to overwrite an existing snapshot directory", async () => {
    const { db } = setupTestDatabase();
    const targetSnapshotDir = path.join(backupOutputDir, "already-exists");
    mkdirSync(targetSnapshotDir, { recursive: true });
    writeFileSync(path.join(targetSnapshotDir, "unrelated.txt"), "pre-existing");

    const manager = new BackupManager({ db, knowledgeRootDir: knowledgeDir });

    await expect(
      manager.createSnapshot({ destinationPath: targetSnapshotDir }),
    ).rejects.toMatchObject({
      name: "BackupManagerError",
      code: "TARGET_EXISTS",
    });

    // Content of existing directory must be preserved
    expect(readFileSync(path.join(targetSnapshotDir, "unrelated.txt"), "utf8")).toBe("pre-existing");

    db.close();
  });

  test("refuses if snapshot destination is created during execution right before publish", async () => {
    const { db } = setupTestDatabase();
    const targetSnapshotDir = path.join(backupOutputDir, "race-snapshot");
    const manager = new BackupManager({ db, knowledgeRootDir: knowledgeDir });

    const beforePublish = () => {
      mkdirSync(targetSnapshotDir, { recursive: true });
      writeFileSync(path.join(targetSnapshotDir, "race.txt"), "racing");
    };

    await expect(
      manager.createSnapshot({ destinationPath: targetSnapshotDir, beforePublish }),
    ).rejects.toMatchObject({
      name: "BackupManagerError",
      code: "TARGET_EXISTS",
    });

    expect(readFileSync(path.join(targetSnapshotDir, "race.txt"), "utf8")).toBe("racing");

    // No leftover staging directory
    const remaining = readdirSync(backupOutputDir);
    expect(remaining.filter((f) => f.includes(".tmp"))).toEqual([]);

    db.close();
  });

  test("cleans up staging directory on unexpected error or verification failure", async () => {
    const { db } = setupTestDatabase();
    const targetSnapshotDir = path.join(backupOutputDir, "error-snapshot");
    const manager = new BackupManager({ db, knowledgeRootDir: knowledgeDir });

    const afterDatabaseBackup = () => {
      throw new Error("Simulated interruption during snapshot packaging");
    };

    await expect(
      manager.createSnapshot({ destinationPath: targetSnapshotDir, afterDatabaseBackup }),
    ).rejects.toThrow("Simulated interruption");

    expect(existsSync(targetSnapshotDir)).toBe(false);
    const remaining = readdirSync(backupOutputDir);
    expect(remaining.filter((f) => f.includes(".tmp"))).toEqual([]);

    db.close();
  });

  test("handles database with zero knowledge documents", async () => {
    const { db } = setupTestDatabase();
    const manager = new BackupManager({ db, knowledgeRootDir: knowledgeDir });
    const targetSnapshotDir = path.join(backupOutputDir, "zero-knowledge-snapshot");

    const result = await manager.createSnapshot({ destinationPath: targetSnapshotDir });

    expect(existsSync(result.path)).toBe(true);
    expect(result.manifest.stats.knowledgeDocumentCount).toBe(0);
    expect(result.manifest.stats.knowledgeRevisionCount).toBe(0);
    expect(result.manifest.stats.fileCount).toBe(1); // database.sqlite only

    const verification = await verifyBackupSnapshot(result.path);
    expect(verification.ok).toBe(true);
    expect(verification.issues).toEqual([]);

    db.close();
  });

  test("verifySnapshot detects missing manifest.json", async () => {
    const { db } = setupTestDatabase();
    const manager = new BackupManager({ db, knowledgeRootDir: knowledgeDir });
    const target = path.join(backupOutputDir, "missing-manifest");

    await manager.createSnapshot({ destinationPath: target });
    rmSync(path.join(target, "manifest.json"));

    const verification = await verifyBackupSnapshot(target);
    expect(verification.ok).toBe(false);
    expect(verification.issues.some((i) => i.includes("Missing manifest.json"))).toBe(true);

    db.close();
  });

  test("verifySnapshot detects corrupt JSON in manifest.json", async () => {
    const { db } = setupTestDatabase();
    const manager = new BackupManager({ db, knowledgeRootDir: knowledgeDir });
    const target = path.join(backupOutputDir, "corrupt-manifest");

    await manager.createSnapshot({ destinationPath: target });
    writeFileSync(path.join(target, "manifest.json"), "NOT VALID JSON {{{{");

    const verification = await verifyBackupSnapshot(target);
    expect(verification.ok).toBe(false);
    expect(verification.issues.some((i) => i.includes("Corrupt JSON"))).toBe(true);

    db.close();
  });

  test("verifySnapshot detects tampered file (checksum mismatch)", async () => {
    const { db } = setupTestDatabase();
    const docId = randomUUID();
    addKnowledgeNote(db, docId, 1, "Authentic note");

    const manager = new BackupManager({ db, knowledgeRootDir: knowledgeDir });
    const target = path.join(backupOutputDir, "tampered-file");

    await manager.createSnapshot({ destinationPath: target });

    // Tamper with the packaged knowledge file in the snapshot
    const snapNote = path.join(target, "knowledge", "bodies", docId, "1.md");
    writeFileSync(snapNote, "Modified content after snapshot publication");

    const verification = await verifyBackupSnapshot(target);
    expect(verification.ok).toBe(false);
    expect(verification.issues.some((i) => i.includes("Checksum mismatch"))).toBe(true);

    db.close();
  });

  test("verifySnapshot detects extra unmanifested files in snapshot", async () => {
    const { db } = setupTestDatabase();
    const manager = new BackupManager({ db, knowledgeRootDir: knowledgeDir });
    const target = path.join(backupOutputDir, "extra-files");

    await manager.createSnapshot({ destinationPath: target });

    // Plant an extra unmanifested file
    writeFileSync(path.join(target, "untracked-payload.sh"), "echo 1");

    const verification = await verifyBackupSnapshot(target);
    expect(verification.ok).toBe(false);
    expect(verification.issues.some((i) => i.includes("Unmanifested file found"))).toBe(true);

    db.close();
  });

  test("verifySnapshot detects missing files listed in manifest", async () => {
    const { db } = setupTestDatabase();
    const docId = randomUUID();
    addKnowledgeNote(db, docId, 1, "Note to be deleted");

    const manager = new BackupManager({ db, knowledgeRootDir: knowledgeDir });
    const target = path.join(backupOutputDir, "missing-file");

    await manager.createSnapshot({ destinationPath: target });

    // Remove the packaged file while leaving manifest intact
    rmSync(path.join(target, "knowledge", "bodies", docId, "1.md"));

    const verification = await verifyBackupSnapshot(target);
    expect(verification.ok).toBe(false);
    expect(verification.issues.some((i) => i.includes("Required snapshot file missing"))).toBe(true);

    db.close();
  });

  test("verifySnapshot detects corrupt SQLite database", async () => {
    const { db } = setupTestDatabase();
    const manager = new BackupManager({ db, knowledgeRootDir: knowledgeDir });
    const target = path.join(backupOutputDir, "corrupt-db");

    await manager.createSnapshot({ destinationPath: target });

    // Invalidate SQLite database header
    const dbFile = path.join(target, "database.sqlite");
    const bytes = readFileSync(dbFile);
    bytes[16] = 0x00;
    bytes[17] = 0x00;
    writeFileSync(dbFile, bytes);

    const verification = await verifyBackupSnapshot(target);
    expect(verification.ok).toBe(false);
    expect(verification.issues.some((i) => i.includes("integrity check failed"))).toBe(true);

    db.close();
  });

  test("cleanIncompleteSnapshots cleans only manager-owned staging dirs", async () => {
    const validSnapshotDir = path.join(backupOutputDir, "forgeorbit-snapshot-20261101T000000Z-12345678");
    const unrelatedTempDir = path.join(backupOutputDir, ".unrelated-temp.tmp");
    const orphanStagingDir = path.join(backupOutputDir, ".forgeorbit-snapshot.12345678-1234-1234-1234-123456789abc.tmp");

    mkdirSync(validSnapshotDir, { recursive: true });
    mkdirSync(unrelatedTempDir, { recursive: true });
    mkdirSync(orphanStagingDir, { recursive: true, mode: 0o700 });

    const { writeStagingOwnershipMetadata } = await import("./backup-core.ts");
    writeStagingOwnershipMetadata(orphanStagingDir, {
      version: 1,
      subsystem: "backup-manager",
      operationId: "12345678-1234-1234-1234-123456789abc",
      pid: 99999999,
      createdAt: Date.now() - 60000,
      state: "writing",
    }, false);

    const result = cleanIncompleteBackupSnapshots(backupOutputDir);

    expect(result.cleaned).toEqual([orphanStagingDir]);
    expect(result.errors).toEqual([]);

    expect(existsSync(orphanStagingDir)).toBe(false);
    expect(existsSync(validSnapshotDir)).toBe(true);
    expect(existsSync(unrelatedTempDir)).toBe(true);
  });

  test("does not mutate source database or source knowledge files", async () => {
    const { db } = setupTestDatabase();
    const docId = randomUUID();
    addKnowledgeNote(db, docId, 1, "Source knowledge note");

    const sourceTasksBefore = db.query("SELECT * FROM tasks").all();
    const sourceProjectsBefore = db.query("SELECT * FROM projects").all();
    const sourceRevsBefore = db.query("SELECT * FROM knowledge_revisions").all();

    const manager = new BackupManager({ db, knowledgeRootDir: knowledgeDir });
    await manager.createSnapshot({ destinationDir: backupOutputDir });

    // Source database tables must be completely unchanged
    expect(db.query("SELECT * FROM tasks").all()).toEqual(sourceTasksBefore);
    expect(db.query("SELECT * FROM projects").all()).toEqual(sourceProjectsBefore);
    expect(db.query("SELECT * FROM knowledge_revisions").all()).toEqual(sourceRevsBefore);

    // Source knowledge file must be completely unchanged
    const sourceFilePath = path.join(knowledgeDir, "bodies", docId, "1.md");
    expect(readFileSync(sourceFilePath, "utf8")).toBe("Source knowledge note");

    db.close();
  });

  test("verifySnapshot rejects intermediate directory symlinks inside snapshot", async () => {
    const { db } = setupTestDatabase();
    const docId = randomUUID();
    addKnowledgeNote(db, docId, 1, "Testing intermediate symlink");

    const manager = new BackupManager({ db, knowledgeRootDir: knowledgeDir });
    const snap = await manager.createSnapshot({ destinationDir: backupOutputDir });

    // Tamper with the snapshot: replace knowledge/bodies with a symlink to outside
    const bodiesDir = path.join(snap.path, "knowledge", "bodies");
    const outsideDir = path.join(testDir, "outside-target");
    mkdirSync(outsideDir, { recursive: true });
    // Move original bodies inside outsideDir
    const outsideDoc = path.join(outsideDir, docId);
    mkdirSync(outsideDoc, { recursive: true });
    writeFileSync(path.join(outsideDoc, "1.md"), "Testing intermediate symlink");
    rmSync(bodiesDir, { recursive: true, force: true });
    symlinkSync(outsideDir, bodiesDir);

    const verification = await verifyBackupSnapshot(snap.path);
    expect(verification.ok).toBe(false);
    expect(
      verification.issues.some((i) => i.includes("intermediate symlink") || i.includes("escapes root")),
    ).toBe(true);

    db.close();
  });

  test("verifySnapshot rejects manifest containing knowledge files unreferenced by database", async () => {
    const { db } = setupTestDatabase();
    const docId = randomUUID();
    addKnowledgeNote(db, docId, 1, "Legit note");

    const manager = new BackupManager({ db, knowledgeRootDir: knowledgeDir });
    const snap = await manager.createSnapshot({ destinationDir: backupOutputDir });

    // Plant an unreferenced knowledge file and add to manifest
    const unrefDocId = randomUUID();
    const unrefDir = path.join(snap.path, "knowledge", "bodies", unrefDocId);
    mkdirSync(unrefDir, { recursive: true });
    const unrefFile = path.join(unrefDir, "1.md");
    writeFileSync(unrefFile, "Smuggled unreferenced note");

    const manifestPath = path.join(snap.path, "manifest.json");
    const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
    const hash = sha256Hex(Buffer.from("Smuggled unreferenced note"));
    manifest.files.push({
      path: path.join("knowledge", "bodies", unrefDocId, "1.md"),
      bytes: Buffer.byteLength("Smuggled unreferenced note"),
      sha256: hash,
    });
    writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));

    const verification = await verifyBackupSnapshot(snap.path);
    expect(verification.ok).toBe(false);
    expect(
      verification.issues.some((i) => i.includes("unreferenced knowledge file not in database")),
    ).toBe(true);

    db.close();
  });

  test("cleanIncompleteSnapshots refuses when directory itself is a symlink", () => {
    const realDir = path.join(testDir, "real-staging-parent");
    mkdirSync(realDir, { recursive: true });
    const linkDir = path.join(testDir, "symlink-staging-parent");
    symlinkSync(realDir, linkDir);

    const result = cleanIncompleteBackupSnapshots(linkDir);
    expect(result.cleaned).toEqual([]);
    expect(result.errors.length).toBeGreaterThan(0);
    expect(result.errors[0]).toContain("symbolic link");
  });

  test("refuses to overwrite an existing empty snapshot directory (P2-4)", async () => {
    const { db } = setupTestDatabase();
    const manager = new BackupManager({ db, knowledgeRootDir: knowledgeDir });
    const targetDir = path.join(testDir, "empty-snapshot-target");
    mkdirSync(targetDir, { mode: 0o700 });

    await expect(
      manager.createSnapshot({ destinationPath: targetDir }),
    ).rejects.toMatchObject({
      name: "BackupManagerError",
      code: "TARGET_EXISTS",
    });

    // The pre-existing empty directory must remain untouched and empty
    expect(readdirSync(targetDir)).toHaveLength(0);
    db.close();
  });

  test("refuses if empty directory is created concurrently right before publish (P2-4)", async () => {
    const { db } = setupTestDatabase();
    const manager = new BackupManager({ db, knowledgeRootDir: knowledgeDir });
    const targetDir = path.join(testDir, "concurrent-empty-target");

    await expect(
      manager.createSnapshot({
        destinationPath: targetDir,
        beforePublish: () => {
          mkdirSync(targetDir, { mode: 0o700 });
        },
      }),
    ).rejects.toMatchObject({
      name: "BackupManagerError",
      code: "TARGET_EXISTS",
    });

    // Must remain empty, never replaced
    expect(readdirSync(targetDir)).toHaveLength(0);
    db.close();
  });

  test("verifySnapshot rejects FIFO special file at database.sqlite without hanging (P2-9)", async () => {
    const { db } = setupTestDatabase();
    const manager = new BackupManager({ db, knowledgeRootDir: knowledgeDir });
    const snap = await manager.createSnapshot({ destinationDir: backupOutputDir });
    const dbPath = path.join(snap.path, "database.sqlite");

    unlinkSync(dbPath);
    const mkfifoRes = spawnSync("mkfifo", [dbPath]);
    expect(mkfifoRes.status).toBe(0);

    const started = performance.now();
    const verification = await verifyBackupSnapshot(snap.path);
    const duration = performance.now() - started;

    expect(duration).toBeLessThan(1000);
    expect(verification.ok).toBe(false);
    expect(
      verification.issues.some((i) => i.includes("not a regular file") || i.includes("special file")),
    ).toBe(true);

    db.close();
  });

  test("verifySnapshot rejects FIFO special file at manifest.json without hanging (P2-9)", async () => {
    const { db } = setupTestDatabase();
    const manager = new BackupManager({ db, knowledgeRootDir: knowledgeDir });
    const snap = await manager.createSnapshot({ destinationDir: backupOutputDir });
    const manifestPath = path.join(snap.path, "manifest.json");

    unlinkSync(manifestPath);
    const mkfifoRes = spawnSync("mkfifo", [manifestPath]);
    expect(mkfifoRes.status).toBe(0);

    const started = performance.now();
    const verification = await verifyBackupSnapshot(snap.path);
    const duration = performance.now() - started;

    expect(duration).toBeLessThan(1000);
    expect(verification.ok).toBe(false);
    expect(
      verification.issues.some((i) => i.includes("not a regular file") || i.includes("special file")),
    ).toBe(true);

    db.close();
  });

  test("verifySnapshot rejects manifest.json exceeding maximum size limit (P2-9)", async () => {
    const { db } = setupTestDatabase();
    const manager = new BackupManager({ db, knowledgeRootDir: knowledgeDir });
    const snap = await manager.createSnapshot({ destinationDir: backupOutputDir });
    const manifestPath = path.join(snap.path, "manifest.json");

    // Create 11 MiB manifest
    const hugeBuf = Buffer.alloc(11 * 1024 * 1024, 0x20);
    writeFileSync(manifestPath, hugeBuf);

    const verification = await verifyBackupSnapshot(snap.path);
    expect(verification.ok).toBe(false);
    expect(verification.issues.some((i) => i.includes("exceeds maximum size limit"))).toBe(true);

    db.close();
  });

  test("verifySnapshot rejects symbolic link at manifest.json (P2-9)", async () => {
    const { db } = setupTestDatabase();
    const manager = new BackupManager({ db, knowledgeRootDir: knowledgeDir });
    const snap = await manager.createSnapshot({ destinationDir: backupOutputDir });
    const manifestPath = path.join(snap.path, "manifest.json");

    const outsidePath = path.join(testDir, "outside-manifest.json");
    writeFileSync(outsidePath, readFileSync(manifestPath));
    unlinkSync(manifestPath);
    symlinkSync(outsidePath, manifestPath);

    const verification = await verifyBackupSnapshot(snap.path);
    expect(verification.ok).toBe(false);
    expect(verification.issues.some((i) => i.includes("cannot be a symbolic link"))).toBe(true);

    db.close();
  });

  test("verifySnapshot rejects symbolic link at database.sqlite (P2-9)", async () => {
    const { db, dbPath } = setupTestDatabase();
    const manager = new BackupManager({ db, knowledgeRootDir: knowledgeDir });
    const snap = await manager.createSnapshot({ destinationDir: backupOutputDir });
    const dbPathInSnap = path.join(snap.path, "database.sqlite");

    const outsidePath = path.join(testDir, "outside-database.sqlite");
    writeFileSync(outsidePath, readFileSync(dbPathInSnap));
    unlinkSync(dbPathInSnap);
    symlinkSync(outsidePath, dbPathInSnap);

    const verification = await verifyBackupSnapshot(snap.path);
    expect(verification.ok).toBe(false);
    expect(verification.issues.some((i) => i.includes("cannot be a symbolic link"))).toBe(true);

    db.close();
  });

  // =========================================================================
  // FO-P2-003-R2A Regression Tests
  // =========================================================================

  test("P2-3: verifySnapshot rejects unexpected or non-revision files under knowledge/ directory", async () => {
    const { db } = setupTestDatabase();
    const docId = randomUUID();
    addKnowledgeNote(db, docId, 1, "Content");

    const manager = new BackupManager({ db, knowledgeRootDir: knowledgeDir });
    const snap = await manager.createSnapshot({ destinationDir: backupOutputDir });

    // 1. Plant an unexpected file directly under knowledge/
    const unexpectedFile1 = path.join(snap.path, "knowledge", "readme.txt");
    writeFileSync(unexpectedFile1, "unexpected info");

    let verification = await verifyBackupSnapshot(snap.path);
    expect(verification.ok).toBe(false);
    expect(verification.issues.some((i) => i.includes("Unexpected or invalid knowledge file"))).toBe(true);
    unlinkSync(unexpectedFile1);

    // 2. Plant an unexpected file inside bodies/
    const unexpectedFile2 = path.join(snap.path, "knowledge", "bodies", "notes.md");
    writeFileSync(unexpectedFile2, "stray file");

    verification = await verifyBackupSnapshot(snap.path);
    expect(verification.ok).toBe(false);
    expect(verification.issues.some((i) => i.includes("Unexpected or invalid knowledge file"))).toBe(true);
    unlinkSync(unexpectedFile2);

    // 3. Plant an invalid revision filename inside document dir (revision 0 or non-numeric)
    const docDir = path.join(snap.path, "knowledge", "bodies", docId);
    const unexpectedFile3 = path.join(docDir, "0.md");
    writeFileSync(unexpectedFile3, "rev 0 is invalid");

    verification = await verifyBackupSnapshot(snap.path);
    expect(verification.ok).toBe(false);
    expect(verification.issues.some((i) => i.includes("Unexpected or invalid knowledge file"))).toBe(true);
    unlinkSync(unexpectedFile3);

    // 4. Plant a non-.md file inside document dir
    const unexpectedFile4 = path.join(docDir, "notes.bak");
    writeFileSync(unexpectedFile4, "backup file");

    verification = await verifyBackupSnapshot(snap.path);
    expect(verification.ok).toBe(false);
    expect(verification.issues.some((i) => i.includes("Unexpected or invalid knowledge file"))).toBe(true);

    db.close();
  });

  test("P2-3: verifySnapshot rejects manifest with invalid knowledge file layout", async () => {
    const { db } = setupTestDatabase();
    const docId = randomUUID();
    addKnowledgeNote(db, docId, 1, "Content");

    const manager = new BackupManager({ db, knowledgeRootDir: knowledgeDir });
    const snap = await manager.createSnapshot({ destinationDir: backupOutputDir });
    const manifestPath = path.join(snap.path, "manifest.json");
    const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));

    // Add invalid knowledge path to manifest
    manifest.files.push({
      path: "knowledge/config.json",
      bytes: 10,
      sha256: sha256Hex("dummy"),
    });
    writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));

    const verification = await verifyBackupSnapshot(snap.path);
    expect(verification.ok).toBe(false);
    expect(
      verification.issues.some((i) => i.includes("unexpected file not permitted by Knowledge schema")),
    ).toBe(true);

    db.close();
  });

  test("P2-5: createSnapshot captures accurate schema version from snapshot even when live database changes", async () => {
    const { db } = setupTestDatabase();
    const manager = new BackupManager({ db, knowledgeRootDir: knowledgeDir });

    const snap = await manager.createSnapshot({
      destinationDir: backupOutputDir,
      afterDatabaseBackup: async () => {
        // Live database changes after SQLite snapshot was captured!
        db.run(
          "INSERT INTO _migrations (id, applied_at) VALUES (?, ?)",
          ["096_concurrent_live_migration", Date.now()],
        );
      },
    });

    // The manifest schemaVersion must match the snapshotted DB ("095_task_queue_progression"),
    // NOT the new migration inserted into the live DB ("096_concurrent_live_migration").
    expect(snap.manifest.schemaVersion).toBe("095_task_queue_progression");

    // The snapshot bundle must pass independent verification
    const verification = await verifyBackupSnapshot(snap.path);
    expect(verification.ok).toBe(true);
    expect(verification.schemaVersion).toBe("095_task_queue_progression");

    db.close();
  });

  test("P2-5: verifySnapshot rejects unknown future schema versions", async () => {
    const { db } = setupTestDatabase();
    const manager = new BackupManager({ db, knowledgeRootDir: knowledgeDir });
    const snap = await manager.createSnapshot({ destinationDir: backupOutputDir });

    // Tamper snapshot to claim an unknown future schema version
    const manifestPath = path.join(snap.path, "manifest.json");
    const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
    manifest.schemaVersion = "999_future_unsupported_migration";
    writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));

    const verification = await verifyBackupSnapshot(snap.path);
    expect(verification.ok).toBe(false);
    expect(
      verification.issues.some((i) => i.includes("Unsupported or unknown future schema version")),
    ).toBe(true);

    db.close();
  });

  test("P2-5: verifySnapshot rejects schema version mismatch between manifest and database", async () => {
    const { db } = setupTestDatabase();
    const manager = new BackupManager({ db, knowledgeRootDir: knowledgeDir });
    const snap = await manager.createSnapshot({ destinationDir: backupOutputDir });

    // Tamper manifest schemaVersion to a supported but different migration
    const manifestPath = path.join(snap.path, "manifest.json");
    const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
    manifest.schemaVersion = "001_init";
    writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));

    const verification = await verifyBackupSnapshot(snap.path);
    expect(verification.ok).toBe(false);
    expect(
      verification.issues.some((i) => i.includes("does not match database schema version")),
    ).toBe(true);

    db.close();
  });

  test("P2-6: createSnapshot succeeds via bounded retry when concurrent revision pruning races with snapshot creation", async () => {
    const { db } = setupTestDatabase();
    const docId = randomUUID();
    addKnowledgeNote(db, docId, 1, "Initial note revision 1");

    let pruneTriggered = false;
    let retryCount = 0;

    const manager = new BackupManager({ db, knowledgeRootDir: knowledgeDir });
    const snap = await manager.createSnapshot({
      destinationDir: backupOutputDir,
      onRetry: (_attempt, _err) => {
        retryCount++;
      },
      afterDatabaseBackup: async () => {
        if (!pruneTriggered) {
          pruneTriggered = true;
          // Simulate concurrent prune: revision 2 is written, revision 1 is pruned from db and deleted from disk
          addKnowledgeNote(db, docId, 2, "Second note revision 2");
          db.run("DELETE FROM knowledge_revisions WHERE document_id = ? AND revision = 1", [docId]);
          const rev1File = path.join(knowledgeDir, "bodies", docId, "1.md");
          if (existsSync(rev1File)) unlinkSync(rev1File);
        }
      },
    });

    expect(retryCount).toBe(1);
    expect(snap.manifest.stats.knowledgeRevisionCount).toBe(1);
    expect(existsSync(snap.path)).toBe(true);

    const verification = await verifyBackupSnapshot(snap.path);
    expect(verification.ok).toBe(true);

    db.close();
  });

  test("P2-6: createSnapshot succeeds via bounded retry when concurrent document deletion races with snapshot creation", async () => {
    const { db } = setupTestDatabase();
    const docId = randomUUID();
    addKnowledgeNote(db, docId, 1, "Note to be deleted concurrently");

    let deleteTriggered = false;
    let retryCount = 0;

    const manager = new BackupManager({ db, knowledgeRootDir: knowledgeDir });
    const snap = await manager.createSnapshot({
      destinationDir: backupOutputDir,
      onRetry: () => {
        retryCount++;
      },
      afterDatabaseBackup: async () => {
        if (!deleteTriggered) {
          deleteTriggered = true;
          // Delete document and files concurrently
          db.run("DELETE FROM knowledge_revisions WHERE document_id = ?", [docId]);
          db.run("DELETE FROM knowledge_documents WHERE id = ?", [docId]);
          const docDir = path.join(knowledgeDir, "bodies", docId);
          rmSync(docDir, { recursive: true, force: true });
        }
      },
    });

    expect(retryCount).toBe(1);
    expect(snap.manifest.stats.knowledgeDocumentCount).toBe(0);
    expect(snap.manifest.stats.knowledgeRevisionCount).toBe(0);

    const verification = await verifyBackupSnapshot(snap.path);
    expect(verification.ok).toBe(true);

    db.close();
  });

  test("P2-6: createSnapshot fails cleanly after bounded retries when a referenced knowledge file is permanently missing", async () => {
    const { db } = setupTestDatabase();
    const docId = randomUUID();
    addKnowledgeNote(db, docId, 1, "Permanent missing note file");

    // Remove the file from disk without updating the database (data loss)
    const rev1File = path.join(knowledgeDir, "bodies", docId, "1.md");
    unlinkSync(rev1File);

    let retriesObserved = 0;
    const manager = new BackupManager({ db, knowledgeRootDir: knowledgeDir });

    await expect(
      manager.createSnapshot({
        destinationDir: backupOutputDir,
        maxRetries: 2,
        onRetry: () => {
          retriesObserved++;
        },
      }),
    ).rejects.toThrow("Referenced knowledge file is missing on disk");

    // Exactly 2 retries (3 total attempts) were made
    expect(retriesObserved).toBe(2);

    // No staging directory or published snapshot left behind
    const files = readdirSync(backupOutputDir);
    expect(files).toHaveLength(0);

    db.close();
  });

  test("P2-7: verifySnapshot rejects active document missing its current revision in knowledge_revisions", async () => {
    const { db } = setupTestDatabase();
    const docId = randomUUID();
    addKnowledgeNote(db, docId, 1, "Content");

    const manager = new BackupManager({ db, knowledgeRootDir: knowledgeDir });
    const snap = await manager.createSnapshot({ destinationDir: backupOutputDir });

    // Open snapshot database and delete the revision row
    const dbPath = path.join(snap.path, "database.sqlite");
    const snapDb = new Database(dbPath);
    snapDb.run("DELETE FROM knowledge_revisions WHERE document_id = ? AND revision = 1", [docId]);
    snapDb.close();

    const verification = await verifyBackupSnapshot(snap.path);
    expect(verification.ok).toBe(false);
    expect(
      verification.issues.some((i) => i.includes("references current revision 1 which does not exist in knowledge_revisions")),
    ).toBe(true);

    db.close();
  });

  test("P2-7: verifySnapshot rejects archived document missing its current revision in knowledge_revisions", async () => {
    const { db } = setupTestDatabase();
    const docId = randomUUID();
    addKnowledgeNote(db, docId, 1, "Archived note content");
    db.run("UPDATE knowledge_documents SET archived_at = ? WHERE id = ?", [Date.now(), docId]);

    const manager = new BackupManager({ db, knowledgeRootDir: knowledgeDir });
    const snap = await manager.createSnapshot({ destinationDir: backupOutputDir });

    // Open snapshot database and delete the revision row for the archived document
    const dbPath = path.join(snap.path, "database.sqlite");
    const snapDb = new Database(dbPath);
    snapDb.run("DELETE FROM knowledge_revisions WHERE document_id = ? AND revision = 1", [docId]);
    snapDb.close();

    const verification = await verifyBackupSnapshot(snap.path);
    expect(verification.ok).toBe(false);
    expect(
      verification.issues.some((i) => i.includes("(archived) references current revision 1 which does not exist")),
    ).toBe(true);

    db.close();
  });

  test("P2-7: verifySnapshot rejects metadata mismatch (content_sha256 and byte_length) between document and revision", async () => {
    const { db } = setupTestDatabase();
    const docId = randomUUID();
    addKnowledgeNote(db, docId, 1, "Note content");

    const manager = new BackupManager({ db, knowledgeRootDir: knowledgeDir });
    const snap = await manager.createSnapshot({ destinationDir: backupOutputDir });

    // Open snapshot database and alter document's content_sha256 and byte_length
    const dbPath = path.join(snap.path, "database.sqlite");
    const snapDb = new Database(dbPath);
    snapDb.run(
      "UPDATE knowledge_documents SET content_sha256 = ?, byte_length = 9999 WHERE id = ?",
      ["0".repeat(64), docId],
    );
    snapDb.close();

    const verification = await verifyBackupSnapshot(snap.path);
    expect(verification.ok).toBe(false);
    expect(
      verification.issues.some((i) => i.includes("content_sha256 mismatch with current revision")),
    ).toBe(true);
    expect(
      verification.issues.some((i) => i.includes("byte_length mismatch with current revision")),
    ).toBe(true);

    db.close();
  });

  test("P2-8: verifySnapshot detects foreign-key violations in snapshot SQLite database", async () => {
    const { db } = setupTestDatabase();
    const manager = new BackupManager({ db, knowledgeRootDir: knowledgeDir });
    const snap = await manager.createSnapshot({ destinationDir: backupOutputDir });

    // Deliberately introduce an invalid foreign key in snapshot database
    const dbPath = path.join(snap.path, "database.sqlite");
    const snapDb = new Database(dbPath);
    snapDb.run("PRAGMA foreign_keys = OFF;");
    snapDb.run(
      "INSERT INTO knowledge_revisions (document_id, revision, created_at, byte_length, content_sha256) VALUES (?, ?, ?, ?, ?)",
      [randomUUID(), 1, Date.now(), 10, "a".repeat(64)],
    );
    snapDb.close();

    const verification = await verifyBackupSnapshot(snap.path);
    expect(verification.ok).toBe(false);
    expect(
      verification.issues.some(
        (i) => i.includes("Foreign key violation in table 'knowledge_revisions'") && i.includes("parent table 'knowledge_documents'"),
      ),
    ).toBe(true);

    db.close();
  });

  test("verifySnapshot rejects manifest statistics mismatches (Finding 6)", async () => {
    const { db } = setupTestDatabase();
    const docId = randomUUID();
    addKnowledgeNote(db, docId, 1, "Content");

    const manager = new BackupManager({ db, knowledgeRootDir: knowledgeDir });
    const snap = await manager.createSnapshot({ destinationDir: backupOutputDir });
    const manifestPath = path.join(snap.path, "manifest.json");
    const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));

    // Tamper stats
    manifest.stats.fileCount = 99;
    manifest.stats.totalBytes = 12345;
    manifest.stats.knowledgeRevisionCount = 88;
    manifest.stats.knowledgeDocumentCount = 77;
    writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));

    const verification = await verifyBackupSnapshot(snap.path);
    expect(verification.ok).toBe(false);
    expect(verification.issues.some((i) => i.includes("Manifest stats fileCount mismatch"))).toBe(true);
    expect(verification.issues.some((i) => i.includes("Manifest stats totalBytes mismatch"))).toBe(true);
    expect(verification.issues.some((i) => i.includes("Manifest stats knowledgeRevisionCount mismatch"))).toBe(true);
    expect(verification.issues.some((i) => i.includes("Manifest stats knowledgeDocumentCount mismatch"))).toBe(true);

    db.close();
  });

  // FO-P2-003-R2B Hardening Regressions

  test("P2-1: file synchronization failure during snapshot packaging fails closed and cleans up staging", async () => {
    const { db } = setupTestDatabase();
    const docId = randomUUID();
    addKnowledgeNote(db, docId, 1, "Content");

    const manager = new BackupManager({ db, knowledgeRootDir: knowledgeDir });
    const targetSnapshotDir = path.join(backupOutputDir, "sync-fail-snapshot");

    await expect(
      manager.createSnapshot({
        destinationPath: targetSnapshotDir,
        fs: {
          syncFile: (file) => {
            if (file.includes("1.md")) {
              throw new Error("Simulated I/O failure during file sync");
            }
          },
        },
      }),
    ).rejects.toMatchObject({
      name: "BackupManagerError",
      code: "IO_ERROR",
    });

    expect(existsSync(targetSnapshotDir)).toBe(false);
    const files = readdirSync(backupOutputDir);
    expect(files.filter((f) => f.startsWith("."))).toHaveLength(0);

    db.close();
  });

  test("P2-1: directory synchronization failure after publication fails closed and reports IO_ERROR", async () => {
    const { db } = setupTestDatabase();
    const manager = new BackupManager({ db, knowledgeRootDir: knowledgeDir });
    const targetSnapshotDir = path.join(backupOutputDir, "sync-dir-fail-snapshot");

    await expect(
      manager.createSnapshot({
        destinationPath: targetSnapshotDir,
        fs: {
          syncDirectory: (dir) => {
            if (dir === backupOutputDir) {
              throw new Error("Simulated parent directory fsync failure");
            }
          },
        },
      }),
    ).rejects.toMatchObject({
      name: "BackupManagerError",
      code: "IO_ERROR",
    });

    db.close();
  });

  test("P2-2: cleanIncompleteSnapshots preserves active operations holding locks", async () => {
    const { writeStagingOwnershipMetadata, tryAcquireFlock, STAGING_LOCK_FILENAME } =
      await import("./backup-core.ts");
    const activeStagingDir = path.join(backupOutputDir, ".active.fo-snapshot.12345678-1234-1234-1234-123456789abc.tmp");
    mkdirSync(activeStagingDir, { recursive: true, mode: 0o700 });

    writeStagingOwnershipMetadata(activeStagingDir, {
      version: 1,
      subsystem: "backup-manager",
      operationId: "12345678-1234-1234-1234-123456789abc",
      pid: process.pid,
      createdAt: Date.now(),
      state: "writing",
    }, false);

    const lockFd = openSync(path.join(activeStagingDir, STAGING_LOCK_FILENAME), constants.O_RDWR | constants.O_CREAT, 0o600);
    const locked = tryAcquireFlock(lockFd);
    expect(locked).toBe(true);

    const result = cleanIncompleteBackupSnapshots(backupOutputDir);
    expect(result.cleaned).not.toContain(activeStagingDir);
    expect(existsSync(activeStagingDir)).toBe(true);

    closeSync(lockFd);
    rmSync(activeStagingDir, { recursive: true, force: true });
  });

  test("P2-2: cleanIncompleteSnapshots preserves directories with missing or malformed metadata", async () => {
    const { writeStagingOwnershipMetadata } = await import("./backup-core.ts");

    const noMetaDir = path.join(backupOutputDir, ".no-meta.fo-snapshot.11111111-1111-1111-1111-111111111111.tmp");
    mkdirSync(noMetaDir, { recursive: true, mode: 0o700 });

    const corruptDir = path.join(backupOutputDir, ".corrupt.fo-snapshot.22222222-2222-2222-2222-222222222222.tmp");
    mkdirSync(corruptDir, { recursive: true, mode: 0o700 });
    writeFileSync(path.join(corruptDir, ".forgeorbit-ownership.json"), "{ broken json");

    const deadDir = path.join(backupOutputDir, ".dead.fo-snapshot.33333333-3333-3333-3333-333333333333.tmp");
    mkdirSync(deadDir, { recursive: true, mode: 0o700 });
    writeStagingOwnershipMetadata(deadDir, {
      version: 1,
      subsystem: "backup-manager",
      operationId: "33333333-3333-3333-3333-333333333333",
      pid: 99999999,
      createdAt: Date.now() - 100000,
      state: "writing",
    }, false);

    const result = cleanIncompleteBackupSnapshots(backupOutputDir);
    expect(result.cleaned).toEqual([deadDir]);
    expect(existsSync(noMetaDir)).toBe(true);
    expect(existsSync(corruptDir)).toBe(true);
    expect(existsSync(deadDir)).toBe(false);

    rmSync(noMetaDir, { recursive: true, force: true });
    rmSync(corruptDir, { recursive: true, force: true });
  });

  test("P2-2: cleanIncompleteSnapshots preserves staging directories owned by other subsystems", async () => {
    const { writeStagingOwnershipMetadata } = await import("./backup-core.ts");

    const coreDir = path.join(backupOutputDir, ".core-owner.fo-snapshot.44444444-4444-4444-4444-444444444444.tmp");
    mkdirSync(coreDir, { recursive: true, mode: 0o700 });
    writeStagingOwnershipMetadata(coreDir, {
      version: 1,
      subsystem: "backup-core",
      operationId: "44444444-4444-4444-4444-444444444444",
      pid: 99999999,
      createdAt: Date.now() - 100000,
      state: "writing",
    }, false);

    const restoreDir = path.join(backupOutputDir, ".restore-owner.fo-snapshot.55555555-5555-5555-5555-555555555555.tmp");
    mkdirSync(restoreDir, { recursive: true, mode: 0o700 });
    writeStagingOwnershipMetadata(restoreDir, {
      version: 1,
      subsystem: "backup-restore",
      operationId: "55555555-5555-5555-5555-555555555555",
      pid: 99999999,
      createdAt: Date.now() - 100000,
      state: "writing",
    }, false);

    const result = cleanIncompleteBackupSnapshots(backupOutputDir);
    expect(result.cleaned).toHaveLength(0);
    expect(existsSync(coreDir)).toBe(true);
    expect(existsSync(restoreDir)).toBe(true);

    rmSync(coreDir, { recursive: true, force: true });
    rmSync(restoreDir, { recursive: true, force: true });
  });

  test("P2-3: source knowledge root intermediate symlink traversal rejected with UNTRUSTED_SYMLINK", async () => {
    const { db } = setupTestDatabase();
    const docId = randomUUID();
    addKnowledgeNote(db, docId, 1, "Content");

    // Replace knowledge/bodies with a symlink to an outside folder
    const bodiesDir = path.join(knowledgeDir, "bodies");
    const externalDir = path.join(testDir, "external-bodies");
    mkdirSync(externalDir, { recursive: true, mode: 0o700 });
    rmSync(bodiesDir, { recursive: true, force: true });
    symlinkSync(externalDir, bodiesDir);

    const manager = new BackupManager({ db, knowledgeRootDir: knowledgeDir });
    await expect(
      manager.createSnapshot({ destinationDir: backupOutputDir }),
    ).rejects.toMatchObject({
      name: "BackupManagerError",
      code: "UNTRUSTED_SYMLINK",
    });

    db.close();
  });

  test("Finding 5: staging manifest has verified: false until full bundle verification completes", async () => {
    const { db } = setupTestDatabase();
    const docId = randomUUID();
    addKnowledgeNote(db, docId, 1, "Content");

    const manager = new BackupManager({ db, knowledgeRootDir: knowledgeDir });
    let verifiedBeforePublish = true;

    const snap = await manager.createSnapshot({
      destinationDir: backupOutputDir,
      afterManifestWrite: (stagingDir) => {
        const stagedManifest = JSON.parse(readFileSync(path.join(stagingDir, "manifest.json"), "utf8"));
        verifiedBeforePublish = Boolean(stagedManifest.verified);
      },
    });

    // In staging before verification pass, manifest must be unverified
    expect(verifiedBeforePublish).toBe(false);

    // In completed published snapshot, manifest must be verified: true
    const publishedManifest = JSON.parse(readFileSync(path.join(snap.path, "manifest.json"), "utf8"));
    expect(publishedManifest.verified).toBe(true);

    db.close();
  });

  test("Finding 5: verifySnapshot rejects published snapshots where manifest indicates verified: false", async () => {
    const { db } = setupTestDatabase();
    const manager = new BackupManager({ db, knowledgeRootDir: knowledgeDir });
    const snap = await manager.createSnapshot({ destinationDir: backupOutputDir });

    // Tamper published manifest to verified: false
    const manifestPath = path.join(snap.path, "manifest.json");
    const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
    manifest.verified = false;
    writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));

    const verification = await verifyBackupSnapshot(snap.path);
    expect(verification.ok).toBe(false);
    expect(verification.issues.some((i) => i.includes("manifest indicates snapshot is unverified"))).toBe(true);

    db.close();
  });

  test("Concurrent staging operations with independent destinations", async () => {
    const { db } = setupTestDatabase();
    const manager = new BackupManager({ db, knowledgeRootDir: knowledgeDir });

    const dest1 = path.join(backupOutputDir, "concurrent-snap-1");
    const dest2 = path.join(backupOutputDir, "concurrent-snap-2");

    const [res1, res2] = await Promise.all([
      manager.createSnapshot({ destinationPath: dest1 }),
      manager.createSnapshot({ destinationPath: dest2 }),
    ]);

    expect(res1.path).toBe(dest1);
    expect(res2.path).toBe(dest2);
    expect(existsSync(dest1)).toBe(true);
    expect(existsSync(dest2)).toBe(true);

    const check1 = await verifyBackupSnapshot(dest1);
    const check2 = await verifyBackupSnapshot(dest2);
    expect(check1.ok).toBe(true);
    expect(check2.ok).toBe(true);

    db.close();
  });
});
