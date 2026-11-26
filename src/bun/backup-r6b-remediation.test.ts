/**
 * Comprehensive reproduction and regression test suite for ForgeOrbit Backup/Restore
 * Phase 2 — FO-P2-003-R6B: Final Lifecycle, Crash Cleanup and Runtime Contract Remediation.
 *
 * Verifies:
 * 1. P2 — Reclaim stale private publication files (NEW-P2-PUB-TMP-UNRECLAIMED)
 * 2. P2 — Runner.dispose() must reconcile publication (NEW-P2-DISPOSE-HIDES-PUBLISHED)
 * 3. P2 — Stop swallowing traversal errors in tasks.refs (NEW-P2-REFS-TRAVERSAL-SWALLOWED)
 * 4. P2 — Relative payload path and worker cwd mismatch (NEW-P2-RELATIVE-PAYLOAD-CWD-MISMATCH)
 * 5. P3 — Fix shadowed SQLite resource handle (NEW-P3-SHADOWED-DBTOCLOSE)
 * 6. Review R6A publication receipts and lifecycle
 * 7. Preservation of R6A invariants
 */

import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { randomUUID } from "node:crypto";
import {
  chmodSync,
  closeSync,
  constants,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import {
  BackupCore,
  BackupCoreError,
  cleanScopedWorkerStaging,
  cleanStalePublicationReceipts,
  computeFileSha256,
  isPidAlive,
  pathExistsOrSymlink,
  readBackupPublicationReceipt,
  recoverStalePublicationTempFiles,
  removeBackupPublicationReceipt,
  tryAcquireFlock,
  verifyDatabaseIntegrity,
  writeBackupPublicationReceipt,
} from "./backup-core.ts";
import {
  BackupManager,
  BackupManagerError,
  getReferencedInternalAssets,
  verifyBackupSnapshot,
} from "./backup-manager.ts";
import { BackupRestore } from "./backup-restore.ts";
import { BackupProcessRunner } from "./backup-runner.ts";
import { BackupRunnerError } from "./backup-runner-types.ts";
import { setupIsolatedTestProfile } from "./test-isolation.ts";

function createSyntheticTestDb(dbPath: string): Database {
  const db = new Database(dbPath);
  db.run("PRAGMA journal_mode = WAL;");
  db.run("PRAGMA foreign_keys = ON;");
  db.run(
    "CREATE TABLE IF NOT EXISTS tasks (id TEXT PRIMARY KEY, title TEXT, prompt TEXT, column TEXT, agent TEXT, workdir TEXT, refs TEXT, attachments TEXT, sent_files TEXT, created_at INTEGER, updated_at INTEGER);",
  );
  db.run(`
    CREATE TABLE IF NOT EXISTS knowledge_documents (
      id TEXT PRIMARY KEY,
      owner_kind TEXT NOT NULL DEFAULT 'project',
      owner_id TEXT NOT NULL DEFAULT 'p1',
      title TEXT NOT NULL,
      description TEXT NOT NULL DEFAULT '',
      category TEXT NOT NULL DEFAULT 'general',
      tags_json TEXT NOT NULL DEFAULT '[]',
      sensitive INTEGER NOT NULL DEFAULT 0,
      revision INTEGER NOT NULL DEFAULT 1,
      created_at INTEGER NOT NULL DEFAULT 1000,
      updated_at INTEGER NOT NULL DEFAULT 1000,
      archived_at INTEGER,
      content_sha256 TEXT NOT NULL DEFAULT '0000000000000000000000000000000000000000000000000000000000000000',
      byte_length INTEGER NOT NULL DEFAULT 0
    );
  `);
  db.run(`
    CREATE TABLE IF NOT EXISTS knowledge_revisions (
      document_id TEXT NOT NULL,
      revision INTEGER NOT NULL,
      content_sha256 TEXT NOT NULL,
      byte_length INTEGER NOT NULL,
      created_at INTEGER NOT NULL,
      PRIMARY KEY (document_id, revision)
    );
  `);
  return db;
}

// ── 1. P2 — Stale Private Publication Files Recovery ─────────────────────────

test("1. Worker crash/SIGKILL during fallback copy leaves stale temp files; recoverStalePublicationTempFiles cleans them", async () => {
  const iso = setupIsolatedTestProfile("fo-r6b-stale-pub-1-");
  try {
    const pubId = randomUUID();
    const metaPath = path.join(iso.dataDir, `.fo-core-pub-tmp-${pubId}.meta.json`);
    const tmpPath = path.join(iso.dataDir, `.fo-core-pub-tmp-${pubId}.tmp`);
    const lockPath = path.join(iso.dataDir, `.fo-core-pub-tmp-${pubId}.lock`);

    // Simulate SIGKILL during fallback copy: dead PID (e.g. 99999999)
    const deadPid = 99999999;
    expect(isPidAlive(deadPid)).toBe(false);

    writeFileSync(tmpPath, "abandoned partial database content", { mode: 0o600 });
    writeFileSync(lockPath, "", { mode: 0o600 });
    writeFileSync(
      metaPath,
      JSON.stringify({
        version: 1,
        subsystem: "backup-core",
        pubId,
        pid: deadPid,
        targetPath: path.join(iso.dataDir, "backup.sqlite"),
        createdAt: Date.now() - 10000,
      }),
      { mode: 0o600 },
    );

    const result = recoverStalePublicationTempFiles(iso.dataDir);
    expect(result.cleaned).toContain(tmpPath);
    expect(result.cleaned).toContain(metaPath);
    expect(result.cleaned).toContain(lockPath);
    expect(existsSync(tmpPath)).toBe(false);
    expect(existsSync(metaPath)).toBe(false);
    expect(existsSync(lockPath)).toBe(false);
  } finally {
    iso.cleanup();
  }
});

test("2. Active flock preservation: publication temporary files held by active lock are strictly preserved", async () => {
  const iso = setupIsolatedTestProfile("fo-r6b-stale-pub-2-");
  try {
    const pubId = randomUUID();
    const metaPath = path.join(iso.dataDir, `.fo-core-pub-tmp-${pubId}.meta.json`);
    const tmpPath = path.join(iso.dataDir, `.fo-core-pub-tmp-${pubId}.tmp`);
    const lockPath = path.join(iso.dataDir, `.fo-core-pub-tmp-${pubId}.lock`);

    writeFileSync(tmpPath, "active copy content", { mode: 0o600 });
    writeFileSync(
      metaPath,
      JSON.stringify({
        version: 1,
        subsystem: "backup-core",
        pubId,
        pid: 99999999, // Dead PID, but active lock is held!
        targetPath: path.join(iso.dataDir, "backup.sqlite"),
        createdAt: Date.now(),
      }),
      { mode: 0o600 },
    );

    const lockFd = openSync(lockPath, constants.O_RDWR | constants.O_CREAT, 0o600);
    const lockAcquired = tryAcquireFlock(lockFd);
    expect(lockAcquired).toBe(true);

    try {
      const result = recoverStalePublicationTempFiles(iso.dataDir);
      expect(result.cleaned.length).toBe(0);
      const activeReason = result.preserved.find((p) => p.path === metaPath);
      expect(activeReason?.reason).toBe("ACTIVE_LOCK_HELD");
      expect(existsSync(tmpPath)).toBe(true);
      expect(existsSync(metaPath)).toBe(true);
      expect(existsSync(lockPath)).toBe(true);
    } finally {
      closeSync(lockFd);
    }
  } finally {
    iso.cleanup();
  }
});

test("3. Reused/alive PID preservation: publication temporary files owned by live process are preserved", async () => {
  const iso = setupIsolatedTestProfile("fo-r6b-stale-pub-3-");
  try {
    const pubId = randomUUID();
    const metaPath = path.join(iso.dataDir, `.fo-core-pub-tmp-${pubId}.meta.json`);
    const tmpPath = path.join(iso.dataDir, `.fo-core-pub-tmp-${pubId}.tmp`);
    const lockPath = path.join(iso.dataDir, `.fo-core-pub-tmp-${pubId}.lock`);

    writeFileSync(tmpPath, "active process data", { mode: 0o600 });
    writeFileSync(lockPath, "", { mode: 0o600 });
    writeFileSync(
      metaPath,
      JSON.stringify({
        version: 1,
        subsystem: "backup-core",
        pubId,
        pid: process.pid, // Current process is alive!
        targetPath: path.join(iso.dataDir, "backup.sqlite"),
        createdAt: Date.now(),
      }),
      { mode: 0o600 },
    );

    const result = recoverStalePublicationTempFiles(iso.dataDir);
    expect(result.cleaned.length).toBe(0);
    const preserved = result.preserved.find((p) => p.path === metaPath);
    expect(preserved?.reason).toBe("PID_ALIVE");
    expect(existsSync(tmpPath)).toBe(true);
  } finally {
    iso.cleanup();
  }
});

test("4. Malformed and invalid ownership metadata preservation: fails closed without deleting files", async () => {
  const iso = setupIsolatedTestProfile("fo-r6b-stale-pub-4-");
  try {
    const pubId1 = randomUUID();
    const metaPath1 = path.join(iso.dataDir, `.fo-core-pub-tmp-${pubId1}.meta.json`);
    const tmpPath1 = path.join(iso.dataDir, `.fo-core-pub-tmp-${pubId1}.tmp`);
    writeFileSync(tmpPath1, "some data", { mode: 0o600 });
    writeFileSync(metaPath1, "{ not valid json syntax", { mode: 0o600 });

    const pubId2 = randomUUID();
    const metaPath2 = path.join(iso.dataDir, `.fo-core-pub-tmp-${pubId2}.meta.json`);
    const tmpPath2 = path.join(iso.dataDir, `.fo-core-pub-tmp-${pubId2}.tmp`);
    writeFileSync(tmpPath2, "some data", { mode: 0o600 });
    writeFileSync(
      metaPath2,
      JSON.stringify({
        version: 1,
        subsystem: "unknown-subsystem",
        pubId: pubId2,
        pid: 99999999,
        targetPath: path.join(iso.dataDir, "backup.sqlite"),
      }),
      { mode: 0o600 },
    );

    const result = recoverStalePublicationTempFiles(iso.dataDir);
    expect(result.cleaned.length).toBe(0);
    expect(result.preserved.some((p) => p.path === metaPath1 && p.reason === "MALFORMED_METADATA")).toBe(true);
    expect(result.preserved.some((p) => p.path === metaPath2 && p.reason === "INVALID_METADATA")).toBe(true);
    expect(existsSync(tmpPath1)).toBe(true);
    expect(existsSync(tmpPath2)).toBe(true);
  } finally {
    iso.cleanup();
  }
});

test("5. Incomplete multi-file temporary sets: .tmp or .lock without .meta.json is preserved as ambiguous", async () => {
  const iso = setupIsolatedTestProfile("fo-r6b-stale-pub-5-");
  try {
    const pubIdOrphanTmp = randomUUID();
    const orphanTmp = path.join(iso.dataDir, `.fo-core-pub-tmp-${pubIdOrphanTmp}.tmp`);
    writeFileSync(orphanTmp, "orphan tmp without metadata", { mode: 0o600 });

    const pubIdOrphanLock = randomUUID();
    const orphanLock = path.join(iso.dataDir, `.fo-core-pub-tmp-${pubIdOrphanLock}.lock`);
    writeFileSync(orphanLock, "", { mode: 0o600 });

    const result = recoverStalePublicationTempFiles(iso.dataDir);
    expect(result.cleaned.length).toBe(0);
    expect(result.preserved.some((p) => p.path === orphanTmp && p.reason === "MISSING_METADATA")).toBe(true);
    expect(result.preserved.some((p) => p.path === orphanLock && p.reason === "MISSING_METADATA")).toBe(true);
    expect(existsSync(orphanTmp)).toBe(true);
    expect(existsSync(orphanLock)).toBe(true);
  } finally {
    iso.cleanup();
  }
});

test("6. Unrelated user files and published backups are strictly preserved", async () => {
  const iso = setupIsolatedTestProfile("fo-r6b-stale-pub-6-");
  try {
    const userFile1 = path.join(iso.dataDir, "fo-core-pub-tmp-123.txt");
    const userFile2 = path.join(iso.dataDir, ".fo-core-pub-tmp-mycustomfile.tmp");
    const publishedBackup = path.join(iso.dataDir, "backup.sqlite");
    writeFileSync(userFile1, "user notes");
    writeFileSync(userFile2, "user temp");
    writeFileSync(publishedBackup, "valid database backup content");

    const result = recoverStalePublicationTempFiles(iso.dataDir);
    expect(result.cleaned.length).toBe(0);
    expect(existsSync(userFile1)).toBe(true);
    expect(existsSync(userFile2)).toBe(true);
    expect(existsSync(publishedBackup)).toBe(true);
  } finally {
    iso.cleanup();
  }
});

test("7. Stale publication recovery is invoked through BackupProcessRunner production lifecycle", async () => {
  const iso = setupIsolatedTestProfile("fo-r6b-stale-pub-7-");
  try {
    const srcDb = path.join(iso.dataDir, "source.sqlite");
    createSyntheticTestDb(srcDb).close();
    const destDb = path.join(iso.dataDir, "dest.sqlite");

    // Plant a stale temporary publication set in the destination directory
    const pubId = randomUUID();
    const staleTmp = path.join(iso.dataDir, `.fo-core-pub-tmp-${pubId}.tmp`);
    const staleMeta = path.join(iso.dataDir, `.fo-core-pub-tmp-${pubId}.meta.json`);
    const staleLock = path.join(iso.dataDir, `.fo-core-pub-tmp-${pubId}.lock`);

    writeFileSync(staleTmp, "abandoned publication bytes", { mode: 0o600 });
    writeFileSync(staleLock, "", { mode: 0o600 });
    writeFileSync(
      staleMeta,
      JSON.stringify({
        version: 1,
        subsystem: "backup-core",
        pubId,
        pid: 99999999,
        targetPath: path.join(iso.dataDir, "old-backup.sqlite"),
        createdAt: Date.now() - 60000,
      }),
      { mode: 0o600 },
    );

    // Call controlled entrypoint
    const runner = new BackupProcessRunner();
    const lifecycleResult = runner.recoverStalePublicationTempFiles(iso.dataDir);
    expect(lifecycleResult.cleaned).toContain(staleTmp);
    expect(lifecycleResult.cleaned).toContain(staleMeta);
    expect(lifecycleResult.cleaned).toContain(staleLock);
    expect(existsSync(staleTmp)).toBe(false);

    // Also verify pre-operation recovery automatically runs before backupDatabase
    const pubId2 = randomUUID();
    const staleTmp2 = path.join(iso.dataDir, `.fo-core-pub-tmp-${pubId2}.tmp`);
    const staleMeta2 = path.join(iso.dataDir, `.fo-core-pub-tmp-${pubId2}.meta.json`);
    const staleLock2 = path.join(iso.dataDir, `.fo-core-pub-tmp-${pubId2}.lock`);
    writeFileSync(staleTmp2, "abandoned bytes 2", { mode: 0o600 });
    writeFileSync(staleLock2, "", { mode: 0o600 });
    writeFileSync(
      staleMeta2,
      JSON.stringify({
        version: 1,
        subsystem: "backup-core",
        pubId: pubId2,
        pid: 99999999,
        targetPath: path.join(iso.dataDir, "old-backup2.sqlite"),
        createdAt: Date.now() - 60000,
      }),
      { mode: 0o600 },
    );

    const bRes = await runner.backupDatabase(srcDb, destDb);
    expect(bRes.path).toBe(destDb);
    expect(existsSync(staleTmp2)).toBe(false);

    await runner.dispose();
  } finally {
    iso.cleanup();
  }
});

test("8. Concurrent recovery attempts are safe, idempotent, and non-blocking", async () => {
  const iso = setupIsolatedTestProfile("fo-r6b-stale-pub-8-");
  try {
    const pubId = randomUUID();
    const metaPath = path.join(iso.dataDir, `.fo-core-pub-tmp-${pubId}.meta.json`);
    const tmpPath = path.join(iso.dataDir, `.fo-core-pub-tmp-${pubId}.tmp`);
    const lockPath = path.join(iso.dataDir, `.fo-core-pub-tmp-${pubId}.lock`);

    writeFileSync(tmpPath, "concurrent cleanup data", { mode: 0o600 });
    writeFileSync(lockPath, "", { mode: 0o600 });
    writeFileSync(
      metaPath,
      JSON.stringify({
        version: 1,
        subsystem: "backup-core",
        pubId,
        pid: 99999999,
        targetPath: path.join(iso.dataDir, "backup.sqlite"),
      }),
      { mode: 0o600 },
    );

    // Run two recovery routines concurrently
    const [res1, res2] = await Promise.all([
      Promise.resolve().then(() => recoverStalePublicationTempFiles(iso.dataDir)),
      Promise.resolve().then(() => recoverStalePublicationTempFiles(iso.dataDir)),
    ]);

    const totalCleaned = [...res1.cleaned, ...res2.cleaned];
    expect(totalCleaned).toContain(tmpPath);
    expect(existsSync(tmpPath)).toBe(false);
  } finally {
    iso.cleanup();
  }
});

// ── 2. P2 — Runner.dispose() Publication Reconciliation ──────────────────────

test("9. dispose() immediately after publication returns PUBLISHED_UNCONFIRMED, never OPERATION_NOT_FOUND", async () => {
  const iso = setupIsolatedTestProfile("fo-r6b-dispose-1-");
  try {
    const srcDb = path.join(iso.dataDir, "source.sqlite");
    createSyntheticTestDb(srcDb).close();
    const destDb = path.join(iso.dataDir, "published-backup.sqlite");

    // Worker that publishes the backup, writes the receipt, emits 'published', and pauses before sending result
    const customWorker = path.join(iso.root, "pub-pause-worker.ts");
    const coreModulePath = path.resolve("src/bun/backup-core.ts");
    writeFileSync(
      customWorker,
      `
import { Database } from "bun:sqlite";
import { BackupCore } from ${JSON.stringify(coreModulePath)};

process.umask(0o077);

process.stdin.on("data", async (chunk) => {
  const lines = chunk.toString().split("\\n");
  for (const line of lines) {
    if (!line.trim()) continue;
    const msg = JSON.parse(line);
    if (msg.type === "start") {
      process.stdout.write(JSON.stringify({ type: "state", operationId: msg.operation.operationId, state: "running" }) + "\\n");
      const db = new Database(msg.operation.payload.dbPath, { readonly: true });
      const core = new BackupCore(db);
      await core.createBackup(msg.operation.payload.destinationPath, {
        runnerOperationId: msg.operation.operationId,
        afterPublish: async (destPath) => {
          process.stdout.write(JSON.stringify({ type: "published", operationId: msg.operation.operationId, targetPath: destPath, publishedAt: Date.now() }) + "\\n");
        },
      });
      db.close();
      // Sleep without sending completion result
      setInterval(() => {}, 1000);
    }
  }
});
`,
    );

    const runner = new BackupProcessRunner({ workerScriptPath: customWorker });
    const promise = runner.backupDatabase(srcDb, destDb);

    // Wait until destination exists on disk
    let published = false;
    for (let i = 0; i < 50; i++) {
      if (existsSync(destDb)) {
        published = true;
        break;
      }
      await new Promise((r) => setTimeout(r, 100));
    }
    expect(published).toBe(true);

    // Dispose runner right now!
    await runner.dispose();

    let errReceived: BackupRunnerError | null = null;
    try {
      await promise;
    } catch (err) {
      errReceived = err as BackupRunnerError;
    }

    expect(errReceived).not.toBeNull();
    expect(errReceived?.code).toBe("PUBLISHED_UNCONFIRMED");
    expect(errReceived?.code).not.toBe("OPERATION_NOT_FOUND");
    // Verified published destination MUST be preserved
    expect(existsSync(destDb)).toBe(true);
    const integrity = verifyDatabaseIntegrity(destDb);
    expect(integrity.ok).toBe(true);
  } finally {
    iso.cleanup();
  }
});

test("10. dispose() before publication returns CANCELLED, never OPERATION_NOT_FOUND, and cleans staging", async () => {
  const iso = setupIsolatedTestProfile("fo-r6b-dispose-2-");
  try {
    const srcDb = path.join(iso.dataDir, "source.sqlite");
    createSyntheticTestDb(srcDb).close();
    const destDb = path.join(iso.dataDir, "never-published.sqlite");

    const hangingWorker = path.join(iso.root, "hanging-worker.ts");
    writeFileSync(
      hangingWorker,
      `
process.stdin.on("data", (chunk) => {
  const lines = chunk.toString().split("\\n");
  for (const line of lines) {
    if (!line.trim()) continue;
    const msg = JSON.parse(line);
    if (msg.type === "start") {
      process.stdout.write(JSON.stringify({ type: "state", operationId: msg.operation.operationId, state: "running" }) + "\\n");
      setInterval(() => {}, 1000);
    }
  }
});
`,
    );

    const runner = new BackupProcessRunner({ workerScriptPath: hangingWorker });
    const promise = runner.backupDatabase(srcDb, destDb);

    // Wait for worker to be running
    await new Promise((r) => setTimeout(r, 150));

    await runner.dispose();

    let errReceived: BackupRunnerError | null = null;
    try {
      await promise;
    } catch (err) {
      errReceived = err as BackupRunnerError;
    }

    expect(errReceived).not.toBeNull();
    expect(errReceived?.code).toBe("CANCELLED");
    expect(errReceived?.code).not.toBe("OPERATION_NOT_FOUND");
    expect(existsSync(destDb)).toBe(false);
  } finally {
    iso.cleanup();
  }
});

test("11. dispose() with an existing pre-existing destination preserves destination and returns TARGET_EXISTS", async () => {
  const iso = setupIsolatedTestProfile("fo-r6b-dispose-3-");
  try {
    const srcDb = path.join(iso.dataDir, "source.sqlite");
    createSyntheticTestDb(srcDb).close();
    const destDb = path.join(iso.dataDir, "pre-existing.sqlite");
    createSyntheticTestDb(destDb).close();
    const initialContent = readFileSync(destDb);

    const runner = new BackupProcessRunner();
    let errReceived: BackupRunnerError | null = null;
    try {
      await runner.backupDatabase(srcDb, destDb);
    } catch (err) {
      errReceived = err as BackupRunnerError;
    }

    expect(errReceived?.code).toBe("TARGET_EXISTS");
    expect(readFileSync(destDb)).toEqual(initialContent);

    await runner.dispose();
  } finally {
    iso.cleanup();
  }
});

test("12. Publication receipts lifecycle: durable fsync write and safe stale cleanup", async () => {
  const opId = randomUUID();
  const targetPath = path.join(tmpdir(), `test-receipt-target-${opId}.sqlite`);

  writeBackupPublicationReceipt({
    operationId: opId,
    targetPath,
    sha256: "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
    bytes: 4096,
    pid: 99999999, // Dead PID
    publishedAt: Date.now() - 5000,
  });

  const receipt = readBackupPublicationReceipt(opId);
  expect(receipt).not.toBeNull();
  expect(receipt?.operationId).toBe(opId);
  expect(receipt?.bytes).toBe(4096);

  // Clean stale receipts for dead PIDs
  const cleanResult = cleanStalePublicationReceipts(0);
  expect(cleanResult.cleaned.some((p) => p.includes(opId))).toBe(true);

  // After cleaning, receipt is gone
  expect(readBackupPublicationReceipt(opId)).toBeNull();
});

// ── 3. P2 — tasks.refs Traversal Errors No Longer Swallowed ──────────────────

test("13. tasks.refs with path traversal in JSON array fails closed before publication", async () => {
  const iso = setupIsolatedTestProfile("fo-r6b-refs-1-");
  try {
    const dbPath = path.join(iso.dataDir, "tasks-traversal.sqlite");
    const db = createSyntheticTestDb(dbPath);
    db.run(
      "INSERT INTO tasks (id, title, prompt, column, agent, workdir, refs, attachments, sent_files, created_at, updated_at) " +
        "VALUES ('task-1', 'Test', 'prompt', 'todo', 'agent', 'workdir', ?, NULL, NULL, 1000, 1000);",
      [JSON.stringify(["attachments/../../etc/passwd"])],
    );
    const manager = new BackupManager({ db, dataDir: iso.dataDir });
    let error: BackupManagerError | null = null;
    try {
      await manager.createSnapshot({ destinationDir: path.join(iso.root, "snapshots"), createDirectory: true });
    } catch (err) {
      error = err as BackupManagerError;
    } finally {
      db.close();
    }

    expect(error).not.toBeNull();
    expect(error?.code).toBe("INVALID_PATH");
  } finally {
    iso.cleanup();
  }
});

test("14. tasks.refs with path traversal in JSON object reference fails closed", async () => {
  const iso = setupIsolatedTestProfile("fo-r6b-refs-2-");
  try {
    const dbPath = path.join(iso.dataDir, "tasks-obj-traversal.sqlite");
    const db = createSyntheticTestDb(dbPath);
    db.run(
      "INSERT INTO tasks (id, title, prompt, column, agent, workdir, refs, attachments, sent_files, created_at, updated_at) " +
        "VALUES ('task-2', 'Test', 'prompt', 'todo', 'agent', 'workdir', ?, NULL, NULL, 1000, 1000);",
      [JSON.stringify({ path: "../../../sensitive/data.key" })],
    );

    const manager = new BackupManager({ db, dataDir: iso.dataDir });
    let error: BackupManagerError | null = null;
    try {
      await manager.createSnapshot({ destinationDir: path.join(iso.root, "snapshots"), createDirectory: true });
    } catch (err) {
      error = err as BackupManagerError;
    } finally {
      db.close();
    }

    expect(error).not.toBeNull();
    expect(error?.code).toBe("INVALID_PATH");
  } finally {
    iso.cleanup();
  }
});

test("15. tasks.refs with path traversal in legacy non-JSON string fails closed", async () => {
  const iso = setupIsolatedTestProfile("fo-r6b-refs-3-");
  try {
    const dbPath = path.join(iso.dataDir, "tasks-legacy-traversal.sqlite");
    const db = createSyntheticTestDb(dbPath);
    db.run(
      "INSERT INTO tasks (id, title, prompt, column, agent, workdir, refs, attachments, sent_files, created_at, updated_at) " +
        "VALUES ('task-3', 'Test', 'prompt', 'todo', 'agent', 'workdir', '../escape-root', NULL, NULL, 1000, 1000);",
    );

    const manager = new BackupManager({ db, dataDir: iso.dataDir });
    let error: BackupManagerError | null = null;
    try {
      await manager.createSnapshot({ destinationDir: path.join(iso.root, "snapshots"), createDirectory: true });
    } catch (err) {
      error = err as BackupManagerError;
    } finally {
      db.close();
    }

    expect(error).not.toBeNull();
    expect(error?.code).toBe("INVALID_PATH");
  } finally {
    iso.cleanup();
  }
});

test("16. Valid external Git repository references in tasks.refs are preserved without copying", async () => {
  const iso = setupIsolatedTestProfile("fo-r6b-refs-4-");
  try {
    const extRepo = path.join(iso.root, "external-git-repo");
    mkdirSync(path.join(extRepo, "src"), { recursive: true });
    writeFileSync(path.join(extRepo, "src", "index.ts"), "console.log('git');");

    const dbPath = path.join(iso.dataDir, "tasks-ext.sqlite");
    const db = createSyntheticTestDb(dbPath);
    db.run(
      "INSERT INTO tasks (id, title, prompt, column, agent, workdir, refs, attachments, sent_files, created_at, updated_at) " +
        "VALUES ('task-4', 'Test', 'prompt', 'todo', 'agent', 'workdir', ?, NULL, NULL, 1000, 1000);",
      [JSON.stringify([path.join(extRepo, "src", "index.ts")])],
    );

    const manager = new BackupManager({ db, dataDir: iso.dataDir });
    const snapDir = path.join(iso.root, "snapshots");
    let snapRes: any;
    try {
      snapRes = await manager.createSnapshot({ destinationDir: snapDir, createDirectory: true });
    } finally {
      db.close();
    }

    const snapDb = new Database(path.join(snapRes.path, "database.sqlite"), { readonly: true });
    const row = snapDb.query("SELECT refs FROM tasks WHERE id = 'task-4';").get() as { refs: string };
    snapDb.close();

    const parsed = JSON.parse(row.refs) as string[];
    expect(parsed[0]).toBe(path.join(extRepo, "src", "index.ts"));
    // External file must NOT be copied into snapshot files
    expect(existsSync(path.join(snapRes.path, "external-git-repo"))).toBe(false);
  } finally {
    iso.cleanup();
  }
});

// ── 4. P2 — Relative Payload Path Normalization & Worker CWD ─────────────────

test("17. backupDatabase with relative paths resolves against parent submission cwd and succeeds", async () => {
  const iso = setupIsolatedTestProfile("fo-r6b-rel-path-1-");
  const prevCwd = process.cwd();
  try {
    process.chdir(iso.root);

    const relSrc = "./relative-source.sqlite";
    const relDest = "./relative-dest.sqlite";
    createSyntheticTestDb(path.resolve(relSrc)).close();

    const runner = new BackupProcessRunner();
    const result = await runner.backupDatabase(relSrc, relDest);

    expect(result.path).toBe(path.resolve(relDest));
    expect(existsSync(path.resolve(relDest))).toBe(true);

    const integrity = verifyDatabaseIntegrity(path.resolve(relDest));
    expect(integrity.ok).toBe(true);

    await runner.dispose();
  } finally {
    process.chdir(prevCwd);
    iso.cleanup();
  }
});

test("18. createSnapshot and restoreSnapshot with relative paths execute reliably", async () => {
  const iso = setupIsolatedTestProfile("fo-r6b-rel-path-2-");
  const prevCwd = process.cwd();
  try {
    process.chdir(iso.dataDir);

    const relDb = "./agetor.sqlite";
    createSyntheticTestDb(path.resolve(relDb)).close();

    const relSnapDest = "./rel-snapshots";
    const relRestoreDest = "../rel-restored";

    const runner = new BackupProcessRunner();
    const snapRes = await runner.createSnapshot(relDb, relSnapDest, {
      dataDir: ".",
      createDirectory: true,
    });

    expect(existsSync(snapRes.path)).toBe(true);
    expect(snapRes.path.startsWith(path.resolve(relSnapDest))).toBe(true);

    const restoreRes = await runner.restoreSnapshot(snapRes.path, relRestoreDest, {
      dbFilename: "agetor.sqlite",
      createDirectory: true,
    });

    expect(existsSync(restoreRes.destinationPath)).toBe(true);
    expect(restoreRes.destinationPath).toBe(path.resolve(relRestoreDest));

    await runner.dispose();
  } finally {
    process.chdir(prevCwd);
    iso.cleanup();
  }
});

test("19. Relative path cannot bypass active profile protection", async () => {
  const iso = setupIsolatedTestProfile("fo-r6b-rel-path-3-");
  const prevCwd = process.cwd();
  try {
    process.chdir(path.dirname(iso.dataDir));
    const relActiveDataDir = `./${path.basename(iso.dataDir)}`;

    const snapDir = path.join(iso.root, "snapshot");
    mkdirSync(snapDir, { recursive: true });

    const runner = new BackupProcessRunner();
    let error: BackupRunnerError | null = null;
    try {
      await runner.restoreSnapshot(snapDir, relActiveDataDir);
    } catch (err) {
      error = err as BackupRunnerError;
    }

    expect(error).not.toBeNull();
    expect(error?.code).toBe("ACTIVE_PROFILE_PROTECTED");

    await runner.dispose();
  } finally {
    process.chdir(prevCwd);
    iso.cleanup();
  }
});

test("20. Private worker cwd creation and cleanup: worker cwd is 0o700 and removed on finalization", async () => {
  const iso = setupIsolatedTestProfile("fo-r6b-worker-cwd-");
  try {
    const srcDb = path.join(iso.dataDir, "source.sqlite");
    createSyntheticTestDb(srcDb).close();
    const destDb = path.join(iso.dataDir, "backup.sqlite");

    // Capture the worker's cwd during execution
    const cwdCaptureWorker = path.join(iso.root, "cwd-worker.ts");
    const capturedCwdFile = path.join(iso.root, "captured-cwd.txt");
    const workerScriptPath = path.resolve("src/bun/backup-worker.ts");

    writeFileSync(
      cwdCaptureWorker,
      `
import { writeFileSync, statSync } from "node:fs";
const cwd = process.cwd();
const st = statSync(cwd);
writeFileSync(${JSON.stringify(capturedCwdFile)}, JSON.stringify({ cwd, mode: (st.mode & 0o777).toString(8) }));
await import(${JSON.stringify(workerScriptPath)});
`,
    );

    const runner = new BackupProcessRunner({ workerScriptPath: cwdCaptureWorker });
    await runner.backupDatabase(srcDb, destDb);

    expect(existsSync(capturedCwdFile)).toBe(true);
    const captured = JSON.parse(readFileSync(capturedCwdFile, "utf8")) as { cwd: string; mode: string };
    expect(captured.cwd.includes("fo-worker-cwd-")).toBe(true);
    expect(captured.mode).toBe("700");

    // After finalization, the private worker directory must be deleted
    expect(existsSync(captured.cwd)).toBe(false);

    await runner.dispose();
  } finally {
    iso.cleanup();
  }
});

// ── 5. P3 — Non-Shadowed SQLite Resource Handle Lifecycle ────────────────────

test("21. Worker SQLite db connection is properly closed when worker is cancelled via SIGTERM or stdin EOF", async () => {
  const iso = setupIsolatedTestProfile("fo-r6b-sqlite-lifecycle-");
  try {
    const srcDb = path.join(iso.dataDir, "source.sqlite");
    createSyntheticTestDb(srcDb).close();
    const destDb = path.join(iso.dataDir, "backup.sqlite");

    // Worker using standard backup-worker.ts
    const runner = new BackupProcessRunner();
    const promise = runner.backupDatabase(srcDb, destDb);

    // Wait for worker to open db and start running
    let opStatus = runner.listOperations()[0];
    for (let i = 0; i < 20; i++) {
      opStatus = runner.listOperations()[0];
      if (opStatus && opStatus.state === "running") break;
      await new Promise((r) => setTimeout(r, 20));
    }

    if (opStatus) {
      await runner.cancel(opStatus.operationId, { force: true });
    }

    try {
      await promise;
    } catch {
      /* expected */
    }

    // SQLite WAL and database must be accessible immediately by another connection without locks
    const dbTest = new Database(srcDb);
    const count = dbTest.query("SELECT count(*) as count FROM tasks;").get() as { count: number };
    expect(count.count).toBe(0);
    dbTest.close();

    await runner.dispose();
  } finally {
    iso.cleanup();
  }
});

test("22. Worker spawned with --no-env-file does not inherit sensitive environment variables", async () => {
  const iso = setupIsolatedTestProfile("fo-r6b-no-env-");
  try {
    const srcDb = path.join(iso.dataDir, "source.sqlite");
    createSyntheticTestDb(srcDb).close();
    const destDb = path.join(iso.dataDir, "backup.sqlite");

    const envCheckWorker = path.join(iso.root, "env-worker.ts");
    const capturedEnvFile = path.join(iso.root, "captured-env.json");
    const workerScriptPath = path.resolve("src/bun/backup-worker.ts");

    writeFileSync(
      envCheckWorker,
      `
import { writeFileSync } from "node:fs";
writeFileSync(${JSON.stringify(capturedEnvFile)}, JSON.stringify(process.env));
await import(${JSON.stringify(workerScriptPath)});
`,
    );

    // Set a secret in parent process
    process.env.FORGEORBIT_SECRET_API_KEY = "super-secret-parent-token-12345";

    const runner = new BackupProcessRunner({ workerScriptPath: envCheckWorker });
    await runner.backupDatabase(srcDb, destDb);

    expect(existsSync(capturedEnvFile)).toBe(true);
    const captured = JSON.parse(readFileSync(capturedEnvFile, "utf8")) as Record<string, string>;
    expect(captured.FORGEORBIT_SECRET_API_KEY).toBeUndefined();

    delete process.env.FORGEORBIT_SECRET_API_KEY;
    await runner.dispose();
  } finally {
    iso.cleanup();
  }
});
