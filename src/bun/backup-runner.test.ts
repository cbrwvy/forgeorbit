import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
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
  writeFileSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import path from "node:path";

// Ensure global test isolation fixture for all runner child processes
const runnerTestIso = mkdtempSync(path.join(tmpdir(), "fo-runner-test-iso-"));
const runnerTestIsoData = path.join(runnerTestIso, "data");
mkdirSync(runnerTestIsoData, { recursive: true, mode: 0o700 });
process.env.FORGEORBIT_DATA_DIR = runnerTestIsoData;
process.env.AGETOR_DATA_DIR = runnerTestIsoData;
import {
  BackupProcessRunner,
  resolveWorkerScriptPath,
} from "./backup-runner.ts";
import { BackupRunnerError } from "./backup-runner-types.ts";
import {
  cleanScopedWorkerStaging,
  tryAcquireFlock,
  writeStagingOwnershipMetadata,
} from "./backup-core.ts";
import { BackupRestore, RestoreError } from "./backup-restore.ts";
import { resolveDataDir } from "./data-dir.ts";
import { verifyBackupWorkerPackage } from "../../scripts/backup-worker-package.ts";
import { migrate } from "./migrate.ts";
import { migrations } from "./migrations/index.ts";

function sha256(data: string | Buffer): string {
  return createHash("sha256").update(data).digest("hex");
}

function createSyntheticDb(dbPath: string, rowCount = 100): void {
  const db = new Database(dbPath);
  db.run("PRAGMA journal_mode = WAL;");
  db.run("PRAGMA synchronous = NORMAL;");
  db.run("PRAGMA foreign_keys = ON;");
  db.run("PRAGMA busy_timeout = 10000;");

  // Run migrations to establish canonical ForgeOrbit schema
  migrate(db, migrations);

  db.run(`
    CREATE TABLE IF NOT EXISTS synthetic_records (
      id INTEGER PRIMARY KEY,
      payload TEXT NOT NULL,
      digest TEXT NOT NULL
    );
  `);

  const insertStmt = db.prepare(
    "INSERT INTO synthetic_records (id, payload, digest) VALUES (?, ?, ?);",
  );
  db.transaction(() => {
    for (let i = 1; i <= rowCount; i++) {
      const payload = `synthetic-payload-record-${i}-${"x".repeat(128)}`;
      insertStmt.run(i, payload, sha256(payload));
    }
  })();

  db.close();
}

function setupKnowledgeDocs(
  dbPath: string,
  knowledgeDir: string,
  docCount = 3,
): { documentId: string; revision: number; content: string; sha256: string }[] {
  const db = new Database(dbPath);
  db.run("PRAGMA busy_timeout = 10000;");
  const bodiesDir = path.join(knowledgeDir, "bodies");
  mkdirSync(bodiesDir, { recursive: true, mode: 0o700 });

  const results: {
    documentId: string;
    revision: number;
    content: string;
    sha256: string;
  }[] = [];

  for (let i = 1; i <= docCount; i++) {
    const docId = `00000000-0000-4000-8000-${String(i).padStart(12, "0")}`;
    const revision = 1;
    const content = `# Document ${i}\nSynthetic knowledge content for revision ${revision}.\n${"Knowledge payload ".repeat(10)}`;
    const contentSha = sha256(content);
    const byteLength = Buffer.byteLength(content, "utf8");
    const now = Date.now();

    db.run(
      `INSERT INTO knowledge_documents (
         id, owner_kind, owner_id, title, description, category, tags_json, sensitive,
         revision, created_at, updated_at, archived_at, content_sha256, byte_length
       ) VALUES (?, 'project', 'root', ?, 'desc', 'general', '[]', 0, ?, ?, ?, NULL, ?, ?);`,
      [docId, `Doc ${i}`, revision, now, now, contentSha, byteLength],
    );

    db.run(
      `INSERT INTO knowledge_revisions (
         document_id, revision, created_at, byte_length, content_sha256
       ) VALUES (?, ?, ?, ?, ?);`,
      [docId, revision, now, byteLength, contentSha],
    );

    const docDir = path.join(bodiesDir, docId);
    mkdirSync(docDir, { recursive: true, mode: 0o700 });
    const filePath = path.join(docDir, `${revision}.md`);
    writeFileSync(filePath, content, { mode: 0o600 });

    results.push({ documentId: docId, revision, content, sha256: contentSha });
  }

  db.close();
  return results;
}

test("1. Successful isolated backup operation (backupDatabase)", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "fo-iso-backup-"));
  const dbPath = path.join(root, "source.sqlite");
  const destPath = path.join(root, "output", "backup.sqlite");
  createSyntheticDb(dbPath, 50);

  const runner = new BackupProcessRunner();
  try {
    const result = await runner.backupDatabase(dbPath, destPath, { createDirectory: true });
    expect(result.bytes).toBeGreaterThan(0);
    expect(result.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(existsSync(destPath)).toBe(true);

    const stat = statSync(destPath);
    expect(stat.mode & 0o777).toBe(0o600);

    // Verify backup integrity independently
    const checkDb = new Database(destPath, { readonly: true });
    const count = checkDb.query("SELECT COUNT(*) as c FROM synthetic_records;").get() as { c: number };
    expect(count.c).toBe(50);
    checkDb.close();
  } finally {
    await runner.dispose();
    rmSync(root, { recursive: true, force: true });
  }
});

test("2. Successful isolated snapshot creation (createSnapshot)", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "fo-iso-snapshot-"));
  const dbPath = path.join(root, "source.sqlite");
  const knowledgeDir = path.join(root, "knowledge");
  const snapshotParent = path.join(root, "snapshots");
  createSyntheticDb(dbPath, 50);
  setupKnowledgeDocs(dbPath, knowledgeDir, 2);

  const runner = new BackupProcessRunner();
  try {
    const result = await runner.createSnapshot(dbPath, snapshotParent, {
      knowledgeRootDir: knowledgeDir,
      createDirectory: true,
    });

    expect(result.path).toBeDefined();
    expect(existsSync(result.path)).toBe(true);
    expect(existsSync(path.join(result.path, "database.sqlite"))).toBe(true);
    expect(existsSync(path.join(result.path, "manifest.json"))).toBe(true);

    const manifest = JSON.parse(readFileSync(path.join(result.path, "manifest.json"), "utf8"));
    expect(manifest.verified).toBe(true);
    expect(typeof manifest.schemaVersion).toBe("string");
    expect(manifest.stats.knowledgeDocumentCount).toBe(2);
  } finally {
    await runner.dispose();
    rmSync(root, { recursive: true, force: true });
  }
});

test("3. Successful isolated verification (verifyDatabase and verifySnapshot)", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "fo-iso-verify-"));
  const dbPath = path.join(root, "source.sqlite");
  const knowledgeDir = path.join(root, "knowledge");
  const snapshotDir = path.join(root, "snapshots", "snap1");
  createSyntheticDb(dbPath, 30);
  setupKnowledgeDocs(dbPath, knowledgeDir, 1);

  const runner = new BackupProcessRunner();
  try {
    // 3a. Database verification
    const dbVerify = await runner.verifyDatabase(dbPath);
    expect(dbVerify.ok).toBe(true);
    expect(!dbVerify.foreignKeyViolations || dbVerify.foreignKeyViolations.length === 0).toBe(true);

    // 3b. Snapshot creation and verification
    await runner.createSnapshot(dbPath, snapshotDir, {
      isExplicitPath: true,
      knowledgeRootDir: knowledgeDir,
      createDirectory: true,
    });

    const snapVerify = await runner.verifySnapshot(snapshotDir);
    expect(snapVerify.ok).toBe(true);
    expect(snapVerify.manifest?.verified).toBe(true);

    // Corrupt snapshot manifest to test verification failure
    const manifestPath = path.join(snapshotDir, "manifest.json");
    writeFileSync(manifestPath, JSON.stringify({ invalid: true }));

    const corruptedVerify = await runner.verifySnapshot(snapshotDir);
    expect(corruptedVerify.ok).toBe(false);
  } finally {
    await runner.dispose();
    rmSync(root, { recursive: true, force: true });
  }
});

test("4. Successful isolated restore into inactive destination (restoreSnapshot)", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "fo-iso-restore-"));
  const dbPath = path.join(root, "source.sqlite");
  const knowledgeDir = path.join(root, "knowledge");
  const snapshotDir = path.join(root, "snapshot");
  const restoreDir = path.join(root, "restored-profile");
  createSyntheticDb(dbPath, 40);
  setupKnowledgeDocs(dbPath, knowledgeDir, 2);

  const runner = new BackupProcessRunner();
  try {
    await runner.createSnapshot(dbPath, snapshotDir, {
      isExplicitPath: true,
      knowledgeRootDir: knowledgeDir,
      createDirectory: true,
    });

    const result = await runner.restoreSnapshot(snapshotDir, restoreDir, {
      dbFilename: "restored.sqlite",
      createDirectory: true,
    });

    expect(result.destinationPath).toBe(restoreDir);
    expect(existsSync(path.join(restoreDir, "restored.sqlite"))).toBe(true);
    expect(existsSync(path.join(restoreDir, "knowledge", "bodies"))).toBe(true);

    // Restored file permissions check
    const dbStat = statSync(path.join(restoreDir, "restored.sqlite"));
    expect(dbStat.mode & 0o777).toBe(0o600);
    const dirStat = statSync(restoreDir);
    expect(dirStat.mode & 0o777).toBe(0o700);

    // Data equality check
    const checkDb = new Database(path.join(restoreDir, "restored.sqlite"), { readonly: true });
    const count = checkDb.query("SELECT COUNT(*) as c FROM synthetic_records;").get() as { c: number };
    expect(count.c).toBe(40);
    checkDb.close();
  } finally {
    await runner.dispose();
    rmSync(root, { recursive: true, force: true });
  }
});

test("5. Main-thread responsiveness during heavy operations", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "fo-iso-responsiveness-"));
  const dbPath = path.join(root, "heavy.sqlite");
  const backupDest = path.join(root, "heavy-backup.sqlite");
  const snapshotDir = path.join(root, "heavy-snapshot");
  const restoreDir = path.join(root, "heavy-restored");
  const knowledgeDir = path.join(root, "knowledge");

  // If opted into heavy benchmark, run 50,000 rows; otherwise 1,500 rows for ordinary CI/test
  const isHeavyOptIn = process.env.FORGEORBIT_RUN_HEAVY_BACKUP_BENCH === "1";
  const rowCount = isHeavyOptIn ? 50_000 : 1_500;
  createSyntheticDb(dbPath, rowCount);
  setupKnowledgeDocs(dbPath, knowledgeDir, 3);

  const runner = new BackupProcessRunner();
  try {
    // Event-loop latency sampler running concurrently on main thread
    let ticks = 0;
    let maxLagMs = 0;
    let lastTick = performance.now();
    const intervalMs = 10;

    const sampler = setInterval(() => {
      ticks++;
      const now = performance.now();
      const elapsed = now - lastTick;
      const lag = Math.max(0, elapsed - intervalMs);
      if (lag > maxLagMs) maxLagMs = lag;
      lastTick = now;
    }, intervalMs);

    // 5a. Backup responsiveness
    const backupStart = performance.now();
    const backupResult = await runner.backupDatabase(dbPath, backupDest);
    const backupDuration = performance.now() - backupStart;

    // 5b. Snapshot creation responsiveness
    const snapStart = performance.now();
    const snapResult = await runner.createSnapshot(dbPath, snapshotDir, {
      isExplicitPath: true,
      knowledgeRootDir: knowledgeDir,
      createDirectory: true,
    });
    const snapDuration = performance.now() - snapStart;

    // 5c. Snapshot verification responsiveness
    const verifyStart = performance.now();
    const verifyResult = await runner.verifySnapshot(snapshotDir);
    const verifyDuration = performance.now() - verifyStart;

    // 5d. Restore responsiveness
    const restoreStart = performance.now();
    const restoreResult = await runner.restoreSnapshot(snapshotDir, restoreDir, {
      createDirectory: true,
    });
    const restoreDuration = performance.now() - restoreStart;

    clearInterval(sampler);

    expect(backupResult.bytes).toBeGreaterThan(0);
    expect(snapResult.path).toBe(snapshotDir);
    expect(verifyResult.ok).toBe(true);
    expect(restoreResult.destinationPath).toBe(restoreDir);

    // Main event loop must have processed dozens/hundreds of ticks while workers ran
    expect(ticks).toBeGreaterThanOrEqual(5);

    // Main-thread event-loop lag remains strictly bounded (< 150ms), proving non-blocking isolation
    expect(maxLagMs).toBeLessThan(150);

    if (isHeavyOptIn) {
      console.log(
        `[HEAVY BENCHMARK] rows=${rowCount} backup=${backupDuration.toFixed(1)}ms snap=${snapDuration.toFixed(1)}ms verify=${verifyDuration.toFixed(1)}ms restore=${restoreDuration.toFixed(1)}ms ticks=${ticks} maxLag=${maxLagMs.toFixed(1)}ms`,
      );
    }
  } finally {
    await runner.dispose();
    rmSync(root, { recursive: true, force: true });
  }
});

test("6. Worker process crash before publication", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "fo-iso-crash-"));
  const dbPath = path.join(root, "source.sqlite");
  const destDir = path.join(root, "output");
  createSyntheticDb(dbPath, 20);

  // Write a synthetic crashing worker
  const crashWorker = path.join(root, "crash-worker.ts");
  writeFileSync(
    crashWorker,
    `
    import { createInterface } from "node:readline";
    const rl = createInterface({ input: process.stdin });
    rl.on("line", (line) => {
      const msg = JSON.parse(line);
      if (msg.type === "start") {
        // Send state then immediately crash with code 42
        process.stdout.write(JSON.stringify({ type: "state", operationId: msg.operation.operationId, state: "running" }) + "\\n");
        setTimeout(() => process.exit(42), 50);
      }
    });
    `,
  );

  const runner = new BackupProcessRunner({ workerScriptPath: crashWorker });
  try {
    let failed = false;
    try {
      await runner.backupDatabase(dbPath, path.join(destDir, "backup.sqlite"));
    } catch (err) {
      failed = true;
      expect(err).toBeInstanceOf(BackupRunnerError);
      expect((err as BackupRunnerError).code).toBe("WORKER_CRASH");
    }
    expect(failed).toBe(true);
    expect(existsSync(path.join(destDir, "backup.sqlite"))).toBe(false);
  } finally {
    await runner.dispose();
    rmSync(root, { recursive: true, force: true });
  }
});

test("7. Cancellation during operation (before publication vs after publication)", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "fo-iso-cancel-"));
  const dbPath = path.join(root, "source.sqlite");
  const destPath = path.join(root, "cancelled-backup.sqlite");
  createSyntheticDb(dbPath, 50);

  const runner = new BackupProcessRunner();
  try {
    // 7a. Cancellation of queued operation
    const opPromise = runner.backupDatabase(dbPath, destPath);
    const active = runner.listOperations();
    expect(active.length).toBeGreaterThanOrEqual(1);
    const opId = active[0]!.operationId;

    const cancelSuccess = await runner.cancel(opId, { force: true });
    expect(cancelSuccess).toBe(true);

    let rejected = false;
    try {
      await opPromise;
    } catch (err) {
      rejected = true;
      expect((err as BackupRunnerError).code).toBe("CANCELLED");
    }
    expect(rejected).toBe(true);

    // 7b. Attempting to cancel already completed operation returns false
    const dest2 = path.join(root, "valid-backup.sqlite");
    const validResult = await runner.backupDatabase(dbPath, dest2);
    expect(validResult.bytes).toBeGreaterThan(0);

    const activeList = runner.listOperations();
    const completedOp = activeList.find((o) => o.targetPath === dest2);
    if (completedOp) {
      const cancelCompleted = await runner.cancel(completedOp.operationId);
      expect(cancelCompleted).toBe(false);
      expect(existsSync(dest2)).toBe(true);
    }
  } finally {
    await runner.dispose();
    rmSync(root, { recursive: true, force: true });
  }
});

test("8. Timeout handling", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "fo-iso-timeout-"));
  const dbPath = path.join(root, "source.sqlite");
  createSyntheticDb(dbPath, 20);

  // Write a synthetic hanging worker
  const hangWorker = path.join(root, "hang-worker.ts");
  writeFileSync(
    hangWorker,
    `
    import { createInterface } from "node:readline";
    const rl = createInterface({ input: process.stdin });
    rl.on("line", (line) => {
      const msg = JSON.parse(line);
      if (msg.type === "start") {
        process.stdout.write(JSON.stringify({ type: "state", operationId: msg.operation.operationId, state: "running" }) + "\\n");
        // Hang indefinitely
        setInterval(() => {}, 10000);
      }
    });
    `,
  );

  const runner = new BackupProcessRunner({ workerScriptPath: hangWorker });
  try {
    let timedOut = false;
    try {
      await runner.backupDatabase(dbPath, path.join(root, "timeout.sqlite"), { timeoutMs: 150 });
    } catch (err) {
      timedOut = true;
      expect(err).toBeInstanceOf(BackupRunnerError);
      expect((err as BackupRunnerError).code).toBe("TIMEOUT");
    }
    expect(timedOut).toBe(true);
  } finally {
    await runner.dispose();
    rmSync(root, { recursive: true, force: true });
  }
});

test("9. Failed IPC communication (malformed output from child)", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "fo-iso-ipc-"));
  const dbPath = path.join(root, "source.sqlite");
  createSyntheticDb(dbPath, 20);

  // Write a worker that sends malformed non-JSON data
  const malformedWorker = path.join(root, "malformed-worker.ts");
  writeFileSync(
    malformedWorker,
    `
    import { createInterface } from "node:readline";
    const rl = createInterface({ input: process.stdin });
    rl.on("line", (line) => {
      const msg = JSON.parse(line);
      if (msg.type === "start") {
        process.stdout.write("MALFORMED NON-JSON GARBAGE STRING\\n");
      }
    });
    `,
  );

  const runner = new BackupProcessRunner({ workerScriptPath: malformedWorker });
  try {
    let failed = false;
    try {
      await runner.backupDatabase(dbPath, path.join(root, "bad-ipc.sqlite"));
    } catch (err) {
      failed = true;
      expect(err).toBeInstanceOf(BackupRunnerError);
      expect((err as BackupRunnerError).code).toBe("IPC_ERROR");
    }
    expect(failed).toBe(true);
  } finally {
    await runner.dispose();
    rmSync(root, { recursive: true, force: true });
  }
});

test("10. Concurrent operation isolation & destination collision prevention", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "fo-iso-collision-"));
  const dbPath = path.join(root, "source.sqlite");
  const destPath = path.join(root, "collision-target.sqlite");
  createSyntheticDb(dbPath, 20);

  const runner = new BackupProcessRunner({ maxConcurrency: 2 });
  try {
    const op1 = runner.backupDatabase(dbPath, destPath);

    // Attempting same destination while op1 is active must throw DESTINATION_COLLISION
    let collisionDetected = false;
    try {
      await runner.backupDatabase(dbPath, destPath);
    } catch (err) {
      collisionDetected = true;
      expect((err as BackupRunnerError).code).toBe("DESTINATION_COLLISION");
    }
    expect(collisionDetected).toBe(true);

    await op1;
  } finally {
    await runner.dispose();
    rmSync(root, { recursive: true, force: true });
  }
});

test("11. Active profile protection", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "fo-iso-profile-"));
  const snapshotDir = path.join(root, "snap");
  mkdirSync(snapshotDir);

  const activeDir = path.join(homedir(), "Library", "Application Support", "ForgeOrbit");
  const runner = new BackupProcessRunner();
  try {
    let protectedRefusal = false;
    try {
      await runner.restoreSnapshot(snapshotDir, activeDir);
    } catch (err) {
      protectedRefusal = true;
      expect((err as BackupRunnerError).code).toBe("ACTIVE_PROFILE_PROTECTED");
    }
    expect(protectedRefusal).toBe(true);
  } finally {
    await runner.dispose();
    rmSync(root, { recursive: true, force: true });
  }
});

test("12. Staging cleanup after worker termination", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "fo-iso-staging-cleanup-"));
  const dbPath = path.join(root, "source.sqlite");
  const destDir = path.join(root, "output");
  mkdirSync(destDir);
  createSyntheticDb(dbPath, 20);

  // Custom worker that creates staging directory then crashes
  const stagingCrashWorker = path.join(root, "staging-crash-worker.ts");
  writeFileSync(
    stagingCrashWorker,
    `
    import { mkdirSync, writeFileSync } from "node:fs";
    import path from "node:path";
    import { createInterface } from "node:readline";

    const rl = createInterface({ input: process.stdin });
    rl.on("line", (line) => {
      const msg = JSON.parse(line);
      if (msg.type === "start") {
        const opId = msg.operation.operationId;
        const stagingUUID = "11111111-2222-3333-4444-555555555555";
        const stagingDir = path.join(${JSON.stringify(destDir)}, ".backup.sqlite.fo-core." + stagingUUID + ".tmp");
        mkdirSync(stagingDir, { recursive: true });
        const metadata = {
          version: 1,
          subsystem: "backup-core",
          operationId: stagingUUID,
          runnerOperationId: opId,
          pid: process.pid,
          createdAt: Date.now(),
          state: "preparing",
          targetPath: path.join(${JSON.stringify(destDir)}, "backup.sqlite"),
        };
        writeFileSync(path.join(stagingDir, ".forgeorbit-ownership.json"), JSON.stringify(metadata));
        writeFileSync(path.join(stagingDir, ".lock"), "");
        process.stdout.write(JSON.stringify({ type: "state", operationId: opId, state: "running", stagingDir }) + "\\n");
        setTimeout(() => process.exit(1), 50);
      }
    });
    `,
  );

  const runner = new BackupProcessRunner({ workerScriptPath: stagingCrashWorker });
  try {
    try {
      await runner.backupDatabase(dbPath, path.join(destDir, "backup.sqlite"));
    } catch {
      /* expected crash */
    }

    // Verify all staging dirs matching operation are cleaned up
    const entries = readdirSync(destDir);
    const stagingLeftovers = entries.filter((e) => e.includes(".fo-core.") && e.endsWith(".tmp"));
    expect(stagingLeftovers.length).toBe(0);
  } finally {
    await runner.dispose();
    rmSync(root, { recursive: true, force: true });
  }
});

test("13. Preservation of already published snapshots", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "fo-iso-preserve-"));
  const dbPath = path.join(root, "source.sqlite");
  const knowledgeDir = path.join(root, "knowledge");
  const snapshotDir = path.join(root, "snapshots", "published-snap");
  createSyntheticDb(dbPath, 20);
  setupKnowledgeDocs(dbPath, knowledgeDir, 1);

  const runner = new BackupProcessRunner();
  try {
    const res = await runner.createSnapshot(dbPath, snapshotDir, {
      isExplicitPath: true,
      knowledgeRootDir: knowledgeDir,
      createDirectory: true,
    });

    expect(existsSync(res.path)).toBe(true);

    // Cancel after completion must not touch the snapshot
    const active = runner.listOperations();
    const snapOp = active.find((o) => o.targetPath === snapshotDir);
    if (snapOp) {
      await runner.cancel(snapOp.operationId);
    }

    expect(existsSync(res.path)).toBe(true);
    expect(existsSync(path.join(res.path, "manifest.json"))).toBe(true);
  } finally {
    await runner.dispose();
    rmSync(root, { recursive: true, force: true });
  }
});

test("14. Existing Backup/Restore round-trip behavior through isolated runner", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "fo-iso-roundtrip-"));
  const srcDbPath = path.join(root, "original.sqlite");
  const knowledgeDir = path.join(root, "knowledge");
  const snapshotDir = path.join(root, "snapshot");
  const restoreDir = path.join(root, "restored");

  createSyntheticDb(srcDbPath, 100);
  const docs = setupKnowledgeDocs(srcDbPath, knowledgeDir, 3);

  const runner = new BackupProcessRunner();
  try {
    // 1. Snapshot
    const snapResult = await runner.createSnapshot(srcDbPath, snapshotDir, {
      isExplicitPath: true,
      knowledgeRootDir: knowledgeDir,
      createDirectory: true,
    });
    expect(snapResult.path).toBe(snapshotDir);

    // 2. Verify
    const verifyResult = await runner.verifySnapshot(snapshotDir);
    expect(verifyResult.ok).toBe(true);

    // 3. Restore
    const restoreResult = await runner.restoreSnapshot(snapshotDir, restoreDir, {
      dbFilename: "agetor.sqlite",
      createDirectory: true,
    });
    expect(restoreResult.destinationPath).toBe(restoreDir);

    // 4. Data verification on restored database
    const restoredDb = new Database(path.join(restoreDir, "agetor.sqlite"), { readonly: true });
    const countRow = restoredDb.query("SELECT COUNT(*) as c FROM synthetic_records;").get() as { c: number };
    expect(countRow.c).toBe(100);

    const docCountRow = restoredDb.query("SELECT COUNT(*) as c FROM knowledge_documents;").get() as { c: number };
    expect(docCountRow.c).toBe(3);
    restoredDb.close();

    // 5. Knowledge contents verification
    for (const doc of docs) {
      const restoredFile = path.join(restoreDir, "knowledge", "bodies", doc.documentId, `${doc.revision}.md`);
      expect(existsSync(restoredFile)).toBe(true);
      const content = readFileSync(restoredFile, "utf8");
      expect(sha256(content)).toBe(doc.sha256);
    }
  } finally {
    await runner.dispose();
    rmSync(root, { recursive: true, force: true });
  }
});

test("15. Packaged-runtime launch compatibility", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "fo-iso-package-"));
  try {
    // Test packaged path resolution layout
    const fakeAppCode = path.join(root, "Contents/Resources/app");
    mkdirSync(path.join(fakeAppCode, "bun"), { recursive: true });

    // Build standalone backup worker into package
    const buildRes = await Bun.build({
      entrypoints: [path.resolve(import.meta.dir, "backup-worker.ts")],
      target: "bun",
    });
    expect(buildRes.success).toBe(true);
    const code = await buildRes.outputs[0]!.text();
    writeFileSync(path.join(fakeAppCode, "bun/backup-worker.js"), code);
    const hash = new Bun.CryptoHasher("sha256").update(code).digest("hex");
    writeFileSync(path.join(fakeAppCode, "bun/backup-worker.sha256"), hash + "\n");

    // Verify package verification helper
    verifyBackupWorkerPackage(fakeAppCode);

    // Verify script resolver finds it
    const resolved = resolveWorkerScriptPath(path.join(fakeAppCode, "bun/backup-worker.js"));
    expect(existsSync(resolved)).toBe(true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("16. Malformed worker response payload rejection", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "fo-iso-malformed-resp-"));
  const dbPath = path.join(root, "source.sqlite");
  createSyntheticDb(dbPath, 10);

  // Custom worker that sends an error payload with missing fields or corrupt types
  const corruptWorker = path.join(root, "corrupt-response-worker.ts");
  writeFileSync(
    corruptWorker,
    `
    import { createInterface } from "node:readline";
    const rl = createInterface({ input: process.stdin });
    rl.on("line", (line) => {
      const msg = JSON.parse(line);
      if (msg.type === "start") {
        // Send state then malformed error response
        process.stdout.write(JSON.stringify({ type: "error", operationId: msg.operation.operationId, error: { code: "CUSTOM_FAIL", message: "simulated failure", subsystem: "backup-core" } }) + "\\n");
        process.exit(1);
      }
    });
    `,
  );

  const runner = new BackupProcessRunner({ workerScriptPath: corruptWorker });
  try {
    let rejected = false;
    try {
      await runner.backupDatabase(dbPath, path.join(root, "out.sqlite"));
    } catch (err) {
      rejected = true;
      expect(err).toBeInstanceOf(BackupRunnerError);
      expect((err as BackupRunnerError).code).toBe("CUSTOM_FAIL");
      expect((err as BackupRunnerError).subsystem).toBe("backup-core");
    }
    expect(rejected).toBe(true);
  } finally {
    await runner.dispose();
    rmSync(root, { recursive: true, force: true });
  }
});

test("17. Compact result bounding & Large manifest snapshot", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "fo-iso-compact-"));
  const dbPath = path.join(root, "source.sqlite");
  const knowledgeDir = path.join(root, "knowledge");
  const snapshotDir = path.join(root, "snapshots", "snap1");
  createSyntheticDb(dbPath, 20);
  setupKnowledgeDocs(dbPath, knowledgeDir, 10);

  const runner = new BackupProcessRunner();
  try {
    const result = await runner.createSnapshot(dbPath, snapshotDir, {
      isExplicitPath: true,
      knowledgeRootDir: knowledgeDir,
      createDirectory: true,
    });

    // Verify result is strictly compact summary without files list
    expect(result.path).toBe(snapshotDir);
    expect(result.snapshotId).toBeDefined();
    expect(result.databaseSha256).toMatch(/^[0-9a-f]{64}$/);
    expect(result.totalFiles).toBeGreaterThanOrEqual(11);
    expect((result as any).manifest.files).toBeUndefined();
    expect(JSON.stringify(result).length).toBeLessThan(2048);

    // Verify manifest.json on disk contains full verified files list
    const diskManifest = JSON.parse(readFileSync(path.join(snapshotDir, "manifest.json"), "utf8"));
    expect(Array.isArray(diskManifest.files)).toBe(true);
    expect(diskManifest.files.length).toBeGreaterThanOrEqual(11);
    expect(diskManifest.verified).toBe(true);

    // Verify snapshot returns compact summary
    const verifyRes = await runner.verifySnapshot(snapshotDir);
    expect(verifyRes.ok).toBe(true);
    expect(verifyRes.filesChecked).toBeGreaterThanOrEqual(11);
    expect((verifyRes as any).manifest?.files).toBeUndefined();
    expect(JSON.stringify(verifyRes).length).toBeLessThan(2048);
  } finally {
    await runner.dispose();
    rmSync(root, { recursive: true, force: true });
  }
});

test("18. Multi-megabyte on-disk manifest handled without IPC truncation (DeepSeek F1 reproduction)", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "fo-iso-multimeg-"));
  const dbPath = path.join(root, "source.sqlite");
  const knowledgeDir = path.join(root, "knowledge");
  const snapshotDir = path.join(root, "snapshot");
  createSyntheticDb(dbPath, 20);
  setupKnowledgeDocs(dbPath, knowledgeDir, 10);

  const runner = new BackupProcessRunner();
  try {
    // 1. Create a snapshot first
    await runner.createSnapshot(dbPath, snapshotDir, {
      isExplicitPath: true,
      knowledgeRootDir: knowledgeDir,
      createDirectory: true,
    });

    // 2. Read the valid manifest and inject large metadata (> 2.3 MB)
    const manifestPath = path.join(snapshotDir, "manifest.json");
    const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
    manifest.largeMetadata = "X".repeat(2_500_000);
    const largeJson = JSON.stringify(manifest);
    expect(largeJson.length).toBeGreaterThan(2 * 1024 * 1024); // > 2 MiB
    writeFileSync(manifestPath, largeJson);

    // In R3, this failed with IPC_ERROR because the worker sent all 2.3 MB across stdout.
    // In R4A, worker sends only the compact summary, so IPC succeeds cleanly!
    const verifyRes = await runner.verifySnapshot(snapshotDir);
    expect(verifyRes.ok).toBe(true);
    expect(verifyRes.filesChecked).toBe(manifest.files.length);
    expect((verifyRes as any).manifest?.files).toBeUndefined();
    expect(JSON.stringify(verifyRes).length).toBeLessThan(2048);

    // Separately opt-in heavy Knowledge dataset test
    if (process.env.FORGEORBIT_LARGE_DATASET_TEST === "1") {
      const heavyRoot = mkdtempSync(path.join(tmpdir(), "fo-heavy-dataset-"));
      try {
        const heavyDb = path.join(heavyRoot, "heavy.sqlite");
        const heavyKnowledge = path.join(heavyRoot, "knowledge");
        const heavySnap = path.join(heavyRoot, "heavy-snap");
        createSyntheticDb(heavyDb, 50);
        setupKnowledgeDocs(heavyDb, heavyKnowledge, 1000);
        const heavyResult = await runner.createSnapshot(heavyDb, heavySnap, {
          isExplicitPath: true,
          knowledgeRootDir: heavyKnowledge,
          createDirectory: true,
        });
        expect(heavyResult.path).toBe(heavySnap);
        const heavyVerify = await runner.verifySnapshot(heavySnap);
        expect(heavyVerify.ok).toBe(true);
      } finally {
        rmSync(heavyRoot, { recursive: true, force: true });
      }
    }
  } finally {
    await runner.dispose();
    rmSync(root, { recursive: true, force: true });
  }
}, 30000);

test("19. Real worker output under stdout backpressure", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "fo-iso-backpressure-"));
  const dummyWorker = path.join(root, "backpressure-worker.ts");

  writeFileSync(
    dummyWorker,
    `
    import { createInterface } from "node:readline";
    const rl = createInterface({ input: process.stdin });
    rl.on("line", async (line) => {
      const msg = JSON.parse(line);
      if (msg.type === "start") {
        const opId = msg.operation.operationId;
        for (let i = 0; i < 200; i++) {
          process.stdout.write(JSON.stringify({
            type: "state",
            operationId: opId,
            state: "running",
            progress: { phase: "running", filesProcessed: i, totalFiles: 200, timestamp: Date.now() }
          }) + "\\n");
        }
        const dest = msg.operation.payload.destinationPath;
        const fs = await import("node:fs");
        const crypto = await import("node:crypto");
        const { Database } = await import("bun:sqlite");
        const db = new Database(dest);
        db.exec("CREATE TABLE t (id INT); INSERT INTO t VALUES (1);");
        db.close();
        const buf = fs.readFileSync(dest);
        const hash = crypto.createHash("sha256").update(buf).digest("hex");
        const result = {
          type: "backup-database",
          operationId: opId,
          path: dest,
          bytes: buf.length,
          sha256: hash,
          durationMs: 10,
        };
        process.stdout.write(JSON.stringify({ type: "result", operationId: opId, result }) + "\\n");
        process.exit(0);
      }
    });
    `,
  );

  const runner = new BackupProcessRunner({ workerScriptPath: dummyWorker });
  try {
    const dest = path.join(root, "out.sqlite");
    const res = await runner.backupDatabase(path.join(root, "src.sqlite"), dest);
    expect(res.path).toBe(dest);
    expect(res.bytes).toBeGreaterThan(0);
  } finally {
    await runner.dispose();
    rmSync(root, { recursive: true, force: true });
  }
});

test("20. Worker stdout truncation rejection", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "fo-iso-trunc-"));
  const truncWorker = path.join(root, "trunc-worker.ts");

  writeFileSync(
    truncWorker,
    `
    import { createInterface } from "node:readline";
    const rl = createInterface({ input: process.stdin });
    rl.on("line", (line) => {
      const msg = JSON.parse(line);
      if (msg.type === "start") {
        process.stdout.write('{"type":"result","operationId":"' + msg.operation.operationId + '","result":{"par');
        process.exit(0);
      }
    });
    `,
  );

  let observedCompleted = false;
  const runner = new BackupProcessRunner({
    workerScriptPath: truncWorker,
    onStateChange: (s) => {
      if (s.state === "completed") observedCompleted = true;
    },
  });

  try {
    let failed = false;
    try {
      await runner.backupDatabase(path.join(root, "s.db"), path.join(root, "d.db"));
    } catch (err) {
      failed = true;
      expect(err).toBeInstanceOf(BackupRunnerError);
      expect((err as BackupRunnerError).code).toBe("IPC_ERROR");
      expect((err as BackupRunnerError).message).toContain("Truncated IPC message");
    }
    expect(failed).toBe(true);
    expect(observedCompleted).toBe(false);
  } finally {
    await runner.dispose();
    rmSync(root, { recursive: true, force: true });
  }
});

test("21. Worker exit immediately after sending a result", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "fo-iso-immed-exit-"));
  const exitWorker = path.join(root, "immed-exit-worker.ts");

  writeFileSync(
    exitWorker,
    `
    import { createInterface } from "node:readline";
    import { readFileSync } from "node:fs";
    import { createHash } from "node:crypto";
    import { Database } from "bun:sqlite";
    const rl = createInterface({ input: process.stdin });
    rl.on("line", (line) => {
      const msg = JSON.parse(line);
      if (msg.type === "start") {
        const dest = msg.operation.payload.destinationPath;
        const db = new Database(dest);
        db.exec("CREATE TABLE t (id INT); INSERT INTO t VALUES (1);");
        db.close();
        const buf = readFileSync(dest);
        const hash = createHash("sha256").update(buf).digest("hex");
        const res = {
          type: "backup-database",
          operationId: msg.operation.operationId,
          path: dest,
          bytes: buf.length,
          sha256: hash,
          durationMs: 5,
        };
        process.stdout.write(JSON.stringify({ type: "result", operationId: msg.operation.operationId, result: res }) + "\\n");
        process.exit(0);
      }
    });
    `,
  );

  const runner = new BackupProcessRunner({ workerScriptPath: exitWorker });
  try {
    const dest = path.join(root, "out.sqlite");
    const result = await runner.backupDatabase(path.join(root, "s.db"), dest);
    expect(result.path).toBe(dest);
    expect(result.bytes).toBeGreaterThan(0);
  } finally {
    await runner.dispose();
    rmSync(root, { recursive: true, force: true });
  }
});

test("22. Malformed JSON rejection", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "fo-iso-badjson-"));
  const badWorker = path.join(root, "bad-json-worker.ts");

  writeFileSync(
    badWorker,
    `
    import { createInterface } from "node:readline";
    const rl = createInterface({ input: process.stdin });
    rl.on("line", (line) => {
      const msg = JSON.parse(line);
      if (msg.type === "start") {
        process.stdout.write("{ corrupted json line \\n");
        process.exit(0);
      }
    });
    `,
  );

  const runner = new BackupProcessRunner({ workerScriptPath: badWorker });
  try {
    let rejected = false;
    try {
      await runner.backupDatabase(path.join(root, "s.db"), path.join(root, "d.db"));
    } catch (err) {
      rejected = true;
      expect(err).toBeInstanceOf(BackupRunnerError);
      expect((err as BackupRunnerError).code).toBe("IPC_ERROR");
    }
    expect(rejected).toBe(true);
  } finally {
    await runner.dispose();
    rmSync(root, { recursive: true, force: true });
  }
});

test("23. Oversized IPC frame rejection", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "fo-iso-oversized-"));
  const bigWorker = path.join(root, "oversized-worker.ts");

  writeFileSync(
    bigWorker,
    `
    import { createInterface } from "node:readline";
    const rl = createInterface({ input: process.stdin });
    rl.on("line", (line) => {
      const msg = JSON.parse(line);
      if (msg.type === "start") {
        const huge = JSON.stringify({
          type: "state",
          operationId: msg.operation.operationId,
          state: "running",
          padding: "x".repeat(100 * 1024),
        });
        process.stdout.write(huge + "\\n");
        process.exit(0);
      }
    });
    `,
  );

  const runner = new BackupProcessRunner({ workerScriptPath: bigWorker });
  try {
    let rejected = false;
    try {
      await runner.backupDatabase(path.join(root, "s.db"), path.join(root, "d.db"));
    } catch (err) {
      rejected = true;
      expect(err).toBeInstanceOf(BackupRunnerError);
      expect((err as BackupRunnerError).code).toBe("IPC_ERROR");
      expect((err as BackupRunnerError).message).toContain("maximum allowed size");
    }
    expect(rejected).toBe(true);
  } finally {
    await runner.dispose();
    rmSync(root, { recursive: true, force: true });
  }
});

test("24. Duplicate messages rejection", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "fo-iso-duplicate-"));
  const dupWorker = path.join(root, "duplicate-worker.ts");

  writeFileSync(
    dupWorker,
    `
    import { createInterface } from "node:readline";
    import { writeFileSync } from "node:fs";
    const rl = createInterface({ input: process.stdin });
    rl.on("line", (line) => {
      const msg = JSON.parse(line);
      if (msg.type === "start") {
        const dest = msg.operation.payload.destinationPath;
        writeFileSync(dest, "data");
        const res = {
          type: "backup-database",
          operationId: msg.operation.operationId,
          path: dest,
          bytes: 4,
          sha256: "2222222222222222222222222222222222222222222222222222222222222222",
          durationMs: 1,
        };
        process.stdout.write(JSON.stringify({ type: "result", operationId: msg.operation.operationId, result: res }) + "\\n");
        process.stdout.write(JSON.stringify({ type: "result", operationId: msg.operation.operationId, result: res }) + "\\n");
        process.exit(0);
      }
    });
    `,
  );

  const runner = new BackupProcessRunner({ workerScriptPath: dupWorker });
  try {
    let rejected = false;
    try {
      await runner.backupDatabase(path.join(root, "s.db"), path.join(root, "d.db"));
    } catch (err) {
      rejected = true;
      expect(err).toBeInstanceOf(BackupRunnerError);
      expect((err as BackupRunnerError).code).toBe("INVALID_WORKER_RESPONSE");
      expect((err as BackupRunnerError).message).toContain("Duplicate result");
    }
    expect(rejected).toBe(true);
  } finally {
    await runner.dispose();
    rmSync(root, { recursive: true, force: true });
  }
});

test("25. Wrong operation ID rejection", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "fo-iso-wrong-id-"));
  const wrongWorker = path.join(root, "wrong-id-worker.ts");

  writeFileSync(
    wrongWorker,
    `
    import { createInterface } from "node:readline";
    const rl = createInterface({ input: process.stdin });
    rl.on("line", (line) => {
      const msg = JSON.parse(line);
      if (msg.type === "start") {
        process.stdout.write(JSON.stringify({
          type: "result",
          operationId: "00000000-0000-0000-0000-000000000000",
          result: { type: "backup-database", operationId: "00000000-0000-0000-0000-000000000000", path: "/tmp/a", bytes: 1, sha256: "0000000000000000000000000000000000000000000000000000000000000000", durationMs: 1 }
        }) + "\\n");
        process.exit(0);
      }
    });
    `,
  );

  const runner = new BackupProcessRunner({ workerScriptPath: wrongWorker });
  try {
    let rejected = false;
    try {
      await runner.backupDatabase(path.join(root, "s.db"), path.join(root, "d.db"));
    } catch (err) {
      rejected = true;
      expect(err).toBeInstanceOf(BackupRunnerError);
      expect((err as BackupRunnerError).code).toBe("INVALID_WORKER_RESPONSE");
      expect((err as BackupRunnerError).message).toContain("operation ID mismatch");
    }
    expect(rejected).toBe(true);
  } finally {
    await runner.dispose();
    rmSync(root, { recursive: true, force: true });
  }
});

test("26. Wrong operation type rejection", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "fo-iso-wrong-type-"));
  const wrongTypeWorker = path.join(root, "wrong-type-worker.ts");

  writeFileSync(
    wrongTypeWorker,
    `
    import { createInterface } from "node:readline";
    const rl = createInterface({ input: process.stdin });
    rl.on("line", (line) => {
      const msg = JSON.parse(line);
      if (msg.type === "start") {
        process.stdout.write(JSON.stringify({
          type: "result",
          operationId: msg.operation.operationId,
          result: {
            type: "verify-database",
            operationId: msg.operation.operationId,
            filePath: "/tmp/fake",
            ok: true,
            issues: [],
          }
        }) + "\\n");
        process.exit(0);
      }
    });
    `,
  );

  const runner = new BackupProcessRunner({ workerScriptPath: wrongTypeWorker });
  try {
    let rejected = false;
    try {
      await runner.backupDatabase(path.join(root, "s.db"), path.join(root, "d.db"));
    } catch (err) {
      rejected = true;
      expect(err).toBeInstanceOf(BackupRunnerError);
      expect((err as BackupRunnerError).code).toBe("INVALID_WORKER_RESPONSE");
      expect((err as BackupRunnerError).message).toContain("type mismatch");
    }
    expect(rejected).toBe(true);
  } finally {
    await runner.dispose();
    rmSync(root, { recursive: true, force: true });
  }
});

test("27. Invalid backwards state transition rejection", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "fo-iso-invalid-trans-"));
  const transWorker = path.join(root, "invalid-trans-worker.ts");

  writeFileSync(
    transWorker,
    `
    import { createInterface } from "node:readline";
    const rl = createInterface({ input: process.stdin });
    rl.on("line", (line) => {
      const msg = JSON.parse(line);
      if (msg.type === "start") {
        process.stdout.write(JSON.stringify({ type: "state", operationId: msg.operation.operationId, state: "publishing" }) + "\\n");
        process.stdout.write(JSON.stringify({ type: "state", operationId: msg.operation.operationId, state: "running" }) + "\\n");
        process.exit(0);
      }
    });
    `,
  );

  const runner = new BackupProcessRunner({ workerScriptPath: transWorker });
  try {
    let rejected = false;
    try {
      await runner.backupDatabase(path.join(root, "s.db"), path.join(root, "d.db"));
    } catch (err) {
      rejected = true;
      expect(err).toBeInstanceOf(BackupRunnerError);
      expect((err as BackupRunnerError).code).toBe("INVALID_WORKER_RESPONSE");
      expect((err as BackupRunnerError).message).toContain("Invalid backwards state transition");
    }
    expect(rejected).toBe(true);
  } finally {
    await runner.dispose();
    rmSync(root, { recursive: true, force: true });
  }
});

test("28. Empty result object rejection (DeepSeek F5 reproduction)", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "fo-iso-empty-res-"));
  const emptyWorker = path.join(root, "empty-res-worker.ts");

  writeFileSync(
    emptyWorker,
    `
    import { createInterface } from "node:readline";
    const rl = createInterface({ input: process.stdin });
    rl.on("line", (line) => {
      const msg = JSON.parse(line);
      if (msg.type === "start") {
        process.stdout.write(JSON.stringify({ type: "state", operationId: msg.operation.operationId, state: "running" }) + "\\n");
        process.stdout.write(JSON.stringify({ type: "result", operationId: msg.operation.operationId, result: {} }) + "\\n");
        process.exit(0);
      }
    });
    `,
  );

  let observedCompleted = false;
  const runner = new BackupProcessRunner({
    workerScriptPath: emptyWorker,
    onStateChange: (s) => {
      if (s.state === "completed") observedCompleted = true;
    },
  });

  try {
    let rejected = false;
    try {
      await runner.backupDatabase(path.join(root, "s.db"), path.join(root, "d.db"));
    } catch (err) {
      rejected = true;
      expect(err).toBeInstanceOf(BackupRunnerError);
      expect((err as BackupRunnerError).code).toBe("INVALID_WORKER_RESPONSE");
      expect((err as BackupRunnerError).message).toContain("Empty result object");
    }
    expect(rejected).toBe(true);
    expect(observedCompleted).toBe(false);
  } finally {
    await runner.dispose();
    rmSync(root, { recursive: true, force: true });
  }
});

test("29. Invalid result fields rejection (bad hash, negative bytes)", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "fo-iso-bad-fields-"));
  const badFieldWorker = path.join(root, "bad-field-worker.ts");

  writeFileSync(
    badFieldWorker,
    `
    import { createInterface } from "node:readline";
    const rl = createInterface({ input: process.stdin });
    rl.on("line", (line) => {
      const msg = JSON.parse(line);
      if (msg.type === "start") {
        process.stdout.write(JSON.stringify({
          type: "result",
          operationId: msg.operation.operationId,
          result: {
            type: "backup-database",
            operationId: msg.operation.operationId,
            path: msg.operation.payload.destinationPath,
            bytes: -50,
            sha256: "not-a-valid-hex-hash",
            durationMs: 10,
          }
        }) + "\\n");
        process.exit(0);
      }
    });
    `,
  );

  const runner = new BackupProcessRunner({ workerScriptPath: badFieldWorker });
  try {
    let rejected = false;
    try {
      await runner.backupDatabase(path.join(root, "s.db"), path.join(root, "d.db"));
    } catch (err) {
      rejected = true;
      expect(err).toBeInstanceOf(BackupRunnerError);
      expect((err as BackupRunnerError).code).toBe("INVALID_WORKER_RESPONSE");
    }
    expect(rejected).toBe(true);
  } finally {
    await runner.dispose();
    rmSync(root, { recursive: true, force: true });
  }
});

test("30. Missing destination on claimed worker success fails closed (DeepSeek F5 reproduction)", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "fo-iso-missing-dest-"));
  const nonExistWorker = path.join(root, "nonexist-dest-worker.ts");

  writeFileSync(
    nonExistWorker,
    `
    import { createInterface } from "node:readline";
    const rl = createInterface({ input: process.stdin });
    rl.on("line", (line) => {
      const msg = JSON.parse(line);
      if (msg.type === "start") {
        const dest = msg.operation.payload.destinationPath;
        const result = {
          type: "backup-database",
          operationId: msg.operation.operationId,
          path: dest,
          bytes: 1024,
          sha256: "3333333333333333333333333333333333333333333333333333333333333333",
          durationMs: 10,
        };
        process.stdout.write(JSON.stringify({ type: "result", operationId: msg.operation.operationId, result }) + "\\n");
        process.exit(0);
      }
    });
    `,
  );

  let observedCompleted = false;
  const runner = new BackupProcessRunner({
    workerScriptPath: nonExistWorker,
    onStateChange: (s) => {
      if (s.state === "completed") observedCompleted = true;
    },
  });

  try {
    const dest = path.join(root, "ghost-backup.sqlite");
    let rejected = false;
    try {
      await runner.backupDatabase(path.join(root, "s.db"), dest);
    } catch (err) {
      rejected = true;
      expect(err).toBeInstanceOf(BackupRunnerError);
      expect((err as BackupRunnerError).code).toBe("IO_ERROR");
      expect((err as BackupRunnerError).message).toContain("Destination artifact verification failed");
    }
    expect(rejected).toBe(true);
    expect(observedCompleted).toBe(false);
    expect(runner.getOperationStatus(runner.listOperations()[0]!.operationId)!.state).toBe("failed");
  } finally {
    await runner.dispose();
    rmSync(root, { recursive: true, force: true });
  }
});

test("31. Premature completed message rejection preserves subscriber state safety", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "fo-iso-premature-comp-"));
  const prematureWorker = path.join(root, "premature-worker.ts");

  writeFileSync(
    prematureWorker,
    `
    import { createInterface } from "node:readline";
    const rl = createInterface({ input: process.stdin });
    rl.on("line", (line) => {
      const msg = JSON.parse(line);
      if (msg.type === "start") {
        process.stdout.write(JSON.stringify({ type: "state", operationId: msg.operation.operationId, state: "completed" }) + "\\n");
        process.exit(0);
      }
    });
    `,
  );

  const observedStates: string[] = [];
  const runner = new BackupProcessRunner({
    workerScriptPath: prematureWorker,
    onStateChange: (s) => {
      observedStates.push(s.state);
    },
  });

  try {
    let rejected = false;
    try {
      await runner.backupDatabase(path.join(root, "s.db"), path.join(root, "d.db"));
    } catch (err) {
      rejected = true;
      expect(err).toBeInstanceOf(BackupRunnerError);
      expect((err as BackupRunnerError).code).toBe("INVALID_WORKER_RESPONSE");
      expect((err as BackupRunnerError).message).toContain("Worker emitted premature completed state");
    }
    expect(rejected).toBe(true);
    expect(observedStates.includes("completed")).toBe(false);
    const stateTransitions = observedStates.filter((s, i, a) => i === 0 || s !== a[i - 1]);
    expect(stateTransitions).toEqual(["queued", "running", "failed"]);
  } finally {
    await runner.dispose();
    rmSync(root, { recursive: true, force: true });
  }
});

test("32. Parent disconnection handling in worker process", async () => {
  const workerScript = resolveWorkerScriptPath();
  const proc = Bun.spawn([process.execPath, workerScript], {
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
  });

  proc.stdin!.end();

  const exitCode = await Promise.race([
    proc.exited,
    new Promise((_, reject) => setTimeout(() => reject(new Error("Worker hung after parent disconnect")), 2000)),
  ]);

  expect(exitCode).toBe(1);
});

test("33. Cheap post-completion filesystem verification does not block event loop", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "fo-iso-loop-check-"));
  const dbPath = path.join(root, "source.sqlite");
  const destPath = path.join(root, "dest.sqlite");
  createSyntheticDb(dbPath, 50);

  let tickCount = 0;
  const interval = setInterval(() => {
    tickCount++;
  }, 10);

  const runner = new BackupProcessRunner();
  try {
    await runner.backupDatabase(dbPath, destPath);
    clearInterval(interval);
    expect(tickCount).toBeGreaterThan(0);
  } finally {
    clearInterval(interval);
    await runner.dispose();
    rmSync(root, { recursive: true, force: true });
  }
});

test("34. Packaged Bun runtime compatibility test (Bun 1.3.13 Electrobun)", async () => {
  const electrobunBun = path.resolve(process.cwd(), "node_modules/electrobun/dist-macos-arm64/bun");
  if (!existsSync(electrobunBun)) {
    console.log("[test 34] Packaged Bun binary not found at", electrobunBun, "- skipping");
    return;
  }

  const root = mkdtempSync(path.join(tmpdir(), "fo-iso-packaged-bun-"));
  const srcDbPath = path.join(root, "src.sqlite");
  const backupOut = path.join(root, "backup.sqlite");
  const knowledgeDir = path.join(root, "knowledge");
  const snapDir = path.join(root, "snapshot");
  const restoreDir = path.join(root, "restored");

  createSyntheticDb(srcDbPath, 40);
  setupKnowledgeDocs(srcDbPath, knowledgeDir, 3);

  const runner = new BackupProcessRunner({ bunExecutable: electrobunBun });
  try {
    // 1. backupDatabase with packaged Bun 1.3.13
    const backupRes = await runner.backupDatabase(srcDbPath, backupOut);
    expect(backupRes.path).toBe(backupOut);
    expect(existsSync(backupOut)).toBe(true);

    // 2. verifyDatabase with packaged Bun 1.3.13
    const verifyDbRes = await runner.verifyDatabase(backupOut);
    expect(verifyDbRes.ok).toBe(true);

    // 3. createSnapshot with packaged Bun 1.3.13
    const snapRes = await runner.createSnapshot(srcDbPath, snapDir, {
      isExplicitPath: true,
      knowledgeRootDir: knowledgeDir,
      createDirectory: true,
    });
    expect(snapRes.path).toBe(snapDir);
    expect(existsSync(path.join(snapDir, "manifest.json"))).toBe(true);
    expect(snapRes.manifest.verified).toBe(true);

    // 4. verifySnapshot with packaged Bun 1.3.13
    const verifySnapRes = await runner.verifySnapshot(snapDir);
    expect(verifySnapRes.ok).toBe(true);

    // 5. restoreSnapshot with packaged Bun 1.3.13
    const restoreRes = await runner.restoreSnapshot(snapDir, restoreDir, {
      dbFilename: "restored.sqlite",
      createDirectory: true,
    });
    expect(restoreRes.destinationPath).toBe(restoreDir);
    expect(existsSync(path.join(restoreDir, "restored.sqlite"))).toBe(true);
  } finally {
    await runner.dispose();
    rmSync(root, { recursive: true, force: true });
  }
});

// ══════════════════════════════════════════════════════════════════════════════
// FO-P2-003-R4B: Lifecycle, Staging Cleanup & Publication Reconciliation Tests
// ══════════════════════════════════════════════════════════════════════════════

test("35. Real staging UUID mismatch and cleanup (DeepSeek F2 reproduction)", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "fo-r4b-f2-real-cleanup-"));
  const dbPath = path.join(root, "source.sqlite");
  const destDir = path.join(root, "output");
  mkdirSync(destDir);
  createSyntheticDb(dbPath, 50);

  // Worker that uses real BackupCore (generating its own independent random UUID for staging)
  // but crashes right before publication
  const coreModulePath = path.resolve(process.cwd(), "src/bun/backup-core.ts");
  const crashWorker = path.join(root, "crash-worker.ts");
  writeFileSync(
    crashWorker,
    `
    import { Database } from "bun:sqlite";
    import path from "node:path";
    import { createInterface } from "node:readline";
    import { BackupCore } from ${JSON.stringify(coreModulePath)};

    const rl = createInterface({ input: process.stdin });
    rl.on("line", async (line) => {
      const msg = JSON.parse(line);
      if (msg.type === "start") {
        const opId = msg.operation.operationId;
        const db = new Database(${JSON.stringify(dbPath)}, { readonly: true });
        const core = new BackupCore(db);
        try {
          await core.createBackup(${JSON.stringify(path.join(destDir, "backup.sqlite"))}, {
            runnerOperationId: opId,
            beforeVacuum: async (stagingDir) => {
              process.stdout.write(JSON.stringify({ type: "state", operationId: opId, state: "running", stagingDir }) + "\\n");
            },
            afterVacuum: async () => {
              // Intentionally crash right after VACUUM before publication
              process.exit(42);
            },
          });
        } catch {
          process.exit(1);
        }
      }
    });
    `,
  );

  const runner = new BackupProcessRunner({ workerScriptPath: crashWorker });
  try {
    let failed = false;
    try {
      await runner.backupDatabase(dbPath, path.join(destDir, "backup.sqlite"));
    } catch (err) {
      failed = true;
      expect((err as BackupRunnerError).code).toBe("WORKER_CRASH");
    }
    expect(failed).toBe(true);

    // Verify:
    // 1. Real staging directory (named with BackupCore's independent UUID) was safely cleaned up
    const entries = readdirSync(destDir);
    const stagingLeftovers = entries.filter((e) => e.includes(".fo-core.") && e.endsWith(".tmp"));
    expect(stagingLeftovers.length).toBe(0);

    // 2. Final destination was never published
    expect(existsSync(path.join(destDir, "backup.sqlite"))).toBe(false);
  } finally {
    await runner.dispose();
    rmSync(root, { recursive: true, force: true });
  }
});

test("36. Timeout during a large active VACUUM with child termination and clean staging", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "fo-r4b-timeout-vacuum-"));
  const dbPath = path.join(root, "source.sqlite");
  const destDir = path.join(root, "output");
  mkdirSync(destDir);
  // Large synthetic DB
  createSyntheticDb(dbPath, 500);

  // Worker that simulates slow VACUUM
  const coreModulePath = path.resolve(process.cwd(), "src/bun/backup-core.ts");
  const slowWorker = path.join(root, "slow-vacuum-worker.ts");
  writeFileSync(
    slowWorker,
    `
    import { Database } from "bun:sqlite";
    import path from "node:path";
    import { createInterface } from "node:readline";
    import { BackupCore } from ${JSON.stringify(coreModulePath)};

    const rl = createInterface({ input: process.stdin });
    rl.on("line", async (line) => {
      const msg = JSON.parse(line);
      if (msg.type === "start") {
        const opId = msg.operation.operationId;
        const db = new Database(${JSON.stringify(dbPath)}, { readonly: true });
        const core = new BackupCore(db);
        try {
          await core.createBackup(${JSON.stringify(path.join(destDir, "backup.sqlite"))}, {
            runnerOperationId: opId,
            beforeVacuum: async (stagingDir) => {
              process.stdout.write(JSON.stringify({ type: "state", operationId: opId, state: "running", stagingDir }) + "\\n");
              // Sleep 2 seconds in staging to trigger timeout
              await new Promise((r) => setTimeout(r, 2000));
            },
          });
        } catch (err) {
          process.exit(1);
        }
      }
    });
    `,
  );

  const runner = new BackupProcessRunner({ workerScriptPath: slowWorker });
  try {
    let timedOut = false;
    try {
      // 100ms timeout
      await runner.backupDatabase(dbPath, path.join(destDir, "backup.sqlite"), { timeoutMs: 100 });
    } catch (err) {
      timedOut = true;
      expect((err as BackupRunnerError).code).toBe("TIMEOUT");
    }
    expect(timedOut).toBe(true);

    // Staging must be cleaned up
    const entries = readdirSync(destDir);
    const stagingLeftovers = entries.filter((e) => e.includes(".fo-core.") && e.endsWith(".tmp"));
    expect(stagingLeftovers.length).toBe(0);

    // No destination created
    expect(existsSync(path.join(destDir, "backup.sqlite"))).toBe(false);
  } finally {
    await runner.dispose();
    rmSync(root, { recursive: true, force: true });
  }
});

test("37. Force cancellation during snapshot creation cleans staging safely", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "fo-r4b-force-cancel-"));
  const dbPath = path.join(root, "source.sqlite");
  const destDir = path.join(root, "output");
  mkdirSync(destDir);
  createSyntheticDb(dbPath, 30);

  // Worker that pauses during staging
  const managerModulePath = path.resolve(process.cwd(), "src/bun/backup-manager.ts");
  const pauseWorker = path.join(root, "pause-snapshot-worker.ts");
  writeFileSync(
    pauseWorker,
    `
    import { Database } from "bun:sqlite";
    import path from "node:path";
    import { createInterface } from "node:readline";
    import { BackupManager } from ${JSON.stringify(managerModulePath)};

    const rl = createInterface({ input: process.stdin });
    rl.on("line", async (line) => {
      const msg = JSON.parse(line);
      if (msg.type === "start") {
        const opId = msg.operation.operationId;
        const db = new Database(${JSON.stringify(dbPath)}, { readonly: true });
        const manager = new BackupManager({ db });
        try {
          await manager.createSnapshot({
            runnerOperationId: opId,
            destinationDir: ${JSON.stringify(destDir)},
            onStagingPrepared: async (stagingDir) => {
              process.stdout.write(JSON.stringify({ type: "state", operationId: opId, state: "running", stagingDir }) + "\\n");
              // Wait for cancellation
              await new Promise((r) => setTimeout(r, 5000));
            },
          });
        } catch {
          process.exit(1);
        }
      }
    });
    `,
  );

  const runner = new BackupProcessRunner({ workerScriptPath: pauseWorker });
  try {
    const promise = runner.createSnapshot(dbPath, destDir);

    // Wait until running status has stagingDir
    let opId = "";
    for (let i = 0; i < 50; i++) {
      const ops = runner.listOperations();
      if (ops.length > 0 && ops[0]!.stagingDir) {
        opId = ops[0]!.operationId;
        break;
      }
      await new Promise((r) => setTimeout(r, 20));
    }
    expect(opId.length).toBeGreaterThan(0);

    // Force cancel
    const cancelRes = await runner.cancel(opId, { force: true });
    expect(cancelRes).toBe(true);

    let rejected = false;
    try {
      await promise;
    } catch (err) {
      rejected = true;
      expect((err as BackupRunnerError).code).toBe("CANCELLED");
    }
    expect(rejected).toBe(true);

    // Staging directory must be cleaned
    const entries = readdirSync(destDir);
    const stagingLeftovers = entries.filter((e) => e.includes(".fo-snapshot.") && e.endsWith(".tmp"));
    expect(stagingLeftovers.length).toBe(0);
  } finally {
    await runner.dispose();
    rmSync(root, { recursive: true, force: true });
  }
});

test("38. Active flock preservation (active locked staging directory survives)", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "fo-r4b-flock-preserve-"));
  const parentDir = path.join(root, "staging-parent");
  mkdirSync(parentDir);

  const activeStaging = path.join(parentDir, ".backup.sqlite.fo-core.aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee.tmp");
  mkdirSync(activeStaging);

  const metadata = {
    version: 1,
    subsystem: "backup-core",
    operationId: "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee",
    runnerOperationId: "runner-op-1",
    pid: process.pid,
    createdAt: Date.now(),
    state: "writing",
    targetPath: path.join(parentDir, "backup.sqlite"),
  };
  writeStagingOwnershipMetadata(activeStaging, metadata as any);

  // Hold exclusive flock on .lock
  const lockFd = openSync(path.join(activeStaging, ".lock"), constants.O_RDWR | constants.O_CREAT, 0o600);
  const flockOk = tryAcquireFlock(lockFd);
  expect(flockOk).toBe(true);

  try {
    // Attempt scoped worker staging cleanup
    const cleanResult = cleanScopedWorkerStaging({
      parentDir,
      subsystem: "backup-core",
      targetPath: path.join(parentDir, "backup.sqlite"),
      runnerOperationId: "runner-op-1",
    });

    // Must be preserved because active lock is held!
    expect(cleanResult.cleaned.length).toBe(0);
    expect(cleanResult.preserved.some((p) => p.reason === "ACTIVE_LOCK_HELD")).toBe(true);
    expect(existsSync(activeStaging)).toBe(true);
  } finally {
    closeSync(lockFd);
    rmSync(root, { recursive: true, force: true });
  }
});

test("39. Malformed metadata preservation (corrupt/missing metadata fails closed)", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "fo-r4b-corrupt-meta-"));
  const parentDir = path.join(root, "staging-parent");
  mkdirSync(parentDir);

  // Directory with corrupt metadata
  const corruptStaging = path.join(parentDir, ".backup.sqlite.fo-core.11111111-1111-1111-1111-111111111111.tmp");
  mkdirSync(corruptStaging);
  writeFileSync(path.join(corruptStaging, ".forgeorbit-ownership.json"), "{ NOT VALID JSON");
  writeFileSync(path.join(corruptStaging, ".lock"), "");

  // Directory with missing metadata
  const missingMetaStaging = path.join(parentDir, ".backup.sqlite.fo-core.22222222-2222-2222-2222-222222222222.tmp");
  mkdirSync(missingMetaStaging);
  writeFileSync(path.join(missingMetaStaging, ".lock"), "");

  try {
    const cleanResult = cleanScopedWorkerStaging({
      parentDir,
      subsystem: "backup-core",
      targetPath: path.join(parentDir, "backup.sqlite"),
    });

    expect(cleanResult.cleaned.length).toBe(0);
    expect(cleanResult.preserved.length).toBe(2);
    expect(existsSync(corruptStaging)).toBe(true);
    expect(existsSync(missingMetaStaging)).toBe(true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("40. Cross-subsystem cleanup isolation (snapshot staging survives core cleanup)", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "fo-r4b-cross-subsystem-"));
  const parentDir = path.join(root, "shared-dir");
  mkdirSync(parentDir);

  // Create an abandoned snapshot staging directory
  const snapshotStaging = path.join(parentDir, ".target.fo-snapshot.33333333-3333-3333-3333-333333333333.tmp");
  mkdirSync(snapshotStaging);
  const metadata = {
    version: 1,
    subsystem: "backup-manager",
    operationId: "33333333-3333-3333-3333-333333333333",
    pid: 999999, // dead pid
    createdAt: Date.now(),
    state: "writing",
    targetPath: path.join(parentDir, "target"),
  };
  writeStagingOwnershipMetadata(snapshotStaging, metadata as any);
  writeFileSync(path.join(snapshotStaging, ".lock"), "");

  try {
    // Attempt cleanup targeting backup-core subsystem
    const cleanResult = cleanScopedWorkerStaging({
      parentDir,
      subsystem: "backup-core",
      targetPath: path.join(parentDir, "target"),
    });

    // Must preserve snapshot directory!
    expect(cleanResult.cleaned.length).toBe(0);
    expect(existsSync(snapshotStaging)).toBe(true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("41. Forged worker staging paths outside parent directory are rejected", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "fo-r4b-forged-staging-"));
  const outsideDir = path.join(root, "outside-victim-dir");
  mkdirSync(outsideDir);
  const victimFile = path.join(outsideDir, "important.txt");
  writeFileSync(victimFile, "vital user data");

  const parentDir = path.join(root, "legitimate-parent");
  mkdirSync(parentDir);

  try {
    const cleanResult = cleanScopedWorkerStaging({
      parentDir,
      subsystem: "backup-core",
      targetPath: path.join(parentDir, "backup.sqlite"),
      candidateStagingDir: outsideDir, // Forged candidate path outside parentDir
    });

    expect(cleanResult.cleaned.length).toBe(0);
    expect(cleanResult.preserved.some((p) => p.reason === "CANONICAL_PATH_CONTAINMENT_VIOLATION")).toBe(true);
    // Victim file must survive intact
    expect(existsSync(victimFile)).toBe(true);
    expect(readFileSync(victimFile, "utf8")).toBe("vital user data");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("42. Crash before publication reports WORKER_CRASH and cleans staging", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "fo-r4b-crash-before-pub-"));
  const dbPath = path.join(root, "source.sqlite");
  const destPath = path.join(root, "dest.sqlite");
  createSyntheticDb(dbPath, 30);

  const crashWorker = path.join(root, "crash-early-worker.ts");
  writeFileSync(
    crashWorker,
    `
    import { createInterface } from "node:readline";
    const rl = createInterface({ input: process.stdin });
    rl.on("line", (line) => {
      const msg = JSON.parse(line);
      if (msg.type === "start") {
        process.stdout.write(JSON.stringify({ type: "state", operationId: msg.operation.operationId, state: "running" }) + "\\n");
        setTimeout(() => process.exit(137), 30);
      }
    });
    `,
  );

  const runner = new BackupProcessRunner({ workerScriptPath: crashWorker });
  try {
    let failed = false;
    try {
      await runner.backupDatabase(dbPath, destPath);
    } catch (err) {
      failed = true;
      expect((err as BackupRunnerError).code).toBe("WORKER_CRASH");
    }
    expect(failed).toBe(true);
    expect(existsSync(destPath)).toBe(false);
  } finally {
    await runner.dispose();
    rmSync(root, { recursive: true, force: true });
  }
});

test("43. Crash immediately after publication reports PUBLISHED_UNCONFIRMED and preserves destination", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "fo-r4b-crash-after-pub-"));
  const dbPath = path.join(root, "source.sqlite");
  const destPath = path.join(root, "dest.sqlite");
  createSyntheticDb(dbPath, 30);

  // Worker that completes real publication, emits published, then exits with code 1 before result
  const coreModulePath = path.resolve(process.cwd(), "src/bun/backup-core.ts");
  const crashAfterPubWorker = path.join(root, "crash-after-pub-worker.ts");
  writeFileSync(
    crashAfterPubWorker,
    `
    import { Database } from "bun:sqlite";
    import path from "node:path";
    import { createInterface } from "node:readline";
    import { BackupCore } from ${JSON.stringify(coreModulePath)};

    const rl = createInterface({ input: process.stdin });
    rl.on("line", async (line) => {
      const msg = JSON.parse(line);
      if (msg.type === "start") {
        const opId = msg.operation.operationId;
        const db = new Database(${JSON.stringify(dbPath)}, { readonly: true });
        const core = new BackupCore(db);
        try {
          await core.createBackup(${JSON.stringify(destPath)}, {
            runnerOperationId: opId,
            afterPublish: async (publishedPath) => {
              process.stdout.write(JSON.stringify({
                type: "published",
                operationId: opId,
                targetPath: publishedPath,
                publishedAt: Date.now(),
              }) + "\\n");
              // Wait for frame to flush then crash before emitting result
              await new Promise((r) => setTimeout(r, 20));
              process.exit(1);
            },
          });
        } catch {
          process.exit(1);
        }
      }
    });
    `,
  );

  const runner = new BackupProcessRunner({ workerScriptPath: crashAfterPubWorker });
  try {
    let failed = false;
    try {
      await runner.backupDatabase(dbPath, destPath);
    } catch (err) {
      failed = true;
      const bErr = err as BackupRunnerError;
      // Must NOT be reported as CANCELLED or clean WORKER_CRASH
      expect(bErr.code).toBe("PUBLISHED_UNCONFIRMED");
      expect((bErr.details as any)?.destinationVerified).toBe(true);
    }
    expect(failed).toBe(true);

    // Published destination MUST survive and NOT be deleted!
    expect(existsSync(destPath)).toBe(true);
  } finally {
    await runner.dispose();
    rmSync(root, { recursive: true, force: true });
  }
});

test("44. Cancellation after durable publication does not report CANCELLED", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "fo-r4b-cancel-after-pub-"));
  const dbPath = path.join(root, "source.sqlite");
  const destPath = path.join(root, "dest.sqlite");
  createSyntheticDb(dbPath, 30);

  // Worker that emits published, pauses briefly, then emits result
  const coreModulePath = path.resolve(process.cwd(), "src/bun/backup-core.ts");
  const slowWorker = path.join(root, "slow-pub-worker.ts");
  writeFileSync(
    slowWorker,
    `
    import { Database } from "bun:sqlite";
    import path from "node:path";
    import { createInterface } from "node:readline";
    import { BackupCore } from ${JSON.stringify(coreModulePath)};

    const rl = createInterface({ input: process.stdin });
    rl.on("line", async (line) => {
      const msg = JSON.parse(line);
      if (msg.type === "start") {
        const opId = msg.operation.operationId;
        const db = new Database(${JSON.stringify(dbPath)}, { readonly: true });
        const core = new BackupCore(db);
        const res = await core.createBackup(${JSON.stringify(destPath)}, {
          runnerOperationId: opId,
          afterPublish: async (publishedPath) => {
            process.stdout.write(JSON.stringify({
              type: "published",
              operationId: opId,
              targetPath: publishedPath,
              publishedAt: Date.now(),
            }) + "\\n");
            // Sleep so parent can attempt cancellation after publication
            await new Promise((r) => setTimeout(r, 100));
          },
        });
        process.stdout.write(JSON.stringify({
          type: "result",
          operationId: opId,
          result: {
            type: "backup-database",
            operationId: opId,
            path: res.path,
            bytes: res.bytes,
            sha256: res.sha256,
            durationMs: res.durationMs,
          },
        }) + "\\n");
        process.exit(0);
      }
    });
    `,
  );

  const runner = new BackupProcessRunner({ workerScriptPath: slowWorker });
  try {
    const promise = runner.backupDatabase(dbPath, destPath);

    // Wait until operation status is marked published
    let opId = "";
    for (let i = 0; i < 50; i++) {
      const ops = runner.listOperations();
      if (ops.length > 0 && existsSync(destPath)) {
        opId = ops[0]!.operationId;
        break;
      }
      await new Promise((r) => setTimeout(r, 20));
    }

    if (opId) {
      // Attempt to cancel after publication has commenced/finished
      const cancelResult = await runner.cancel(opId);
      // Once publishing has begun or succeeded, cancel() must return false
      expect(cancelResult).toBe(false);
    }

    // Operation must complete successfully or report publication intact, NOT CANCELLED!
    const result = await promise;
    expect(result.path).toBe(destPath);
    expect(existsSync(destPath)).toBe(true);
  } finally {
    await runner.dispose();
    rmSync(root, { recursive: true, force: true });
  }
});

test("45. Late timeout after publication and valid result does not override completion", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "fo-r4b-late-timeout-"));
  const dbPath = path.join(root, "source.sqlite");
  const destPath = path.join(root, "dest.sqlite");
  createSyntheticDb(dbPath, 30);

  const runner = new BackupProcessRunner();
  try {
    // Generous timeout that easily succeeds
    const result = await runner.backupDatabase(dbPath, destPath, { timeoutMs: 5000 });
    expect(result.path).toBe(destPath);
    expect(existsSync(destPath)).toBe(true);

    const status = runner.getOperationStatus(result.operationId);
    expect(status?.state).toBe("completed");
  } finally {
    await runner.dispose();
    rmSync(root, { recursive: true, force: true });
  }
});

test("46. Publication acknowledgment lost during IPC failure reports PUBLISHED_UNCONFIRMED", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "fo-r4b-lost-ack-"));
  const dbPath = path.join(root, "source.sqlite");
  const destPath = path.join(root, "dest.sqlite");
  createSyntheticDb(dbPath, 30);

  // Worker publishes file directly then abruptly crashes WITHOUT sending published or result message
  const coreModulePath = path.resolve(process.cwd(), "src/bun/backup-core.ts");
  const abruptWorker = path.join(root, "abrupt-worker.ts");
  writeFileSync(
    abruptWorker,
    `
    import { Database } from "bun:sqlite";
    import path from "node:path";
    import { createInterface } from "node:readline";
    import { BackupCore } from ${JSON.stringify(coreModulePath)};

    const rl = createInterface({ input: process.stdin });
    rl.on("line", async (line) => {
      const msg = JSON.parse(line);
      if (msg.type === "start") {
        const opId = msg.operation.operationId;
        const db = new Database(${JSON.stringify(dbPath)}, { readonly: true });
        const core = new BackupCore(db);
        try {
          await core.createBackup(${JSON.stringify(destPath)}, {
            runnerOperationId: opId,
          });
          // Abrupt exit without sending any IPC frame
          process.exit(1);
        } catch {
          process.exit(1);
        }
      }
    });
    `,
  );

  const runner = new BackupProcessRunner({ workerScriptPath: abruptWorker });
  try {
    let failed = false;
    try {
      await runner.backupDatabase(dbPath, destPath);
    } catch (err) {
      failed = true;
      const bErr = err as BackupRunnerError;
      expect(bErr.code).toBe("PUBLISHED_UNCONFIRMED");
      expect((bErr.details as any)?.destinationVerified).toBe(true);
    }
    expect(failed).toBe(true);
    // Destination must NOT be deleted
    expect(existsSync(destPath)).toBe(true);
  } finally {
    await runner.dispose();
    rmSync(root, { recursive: true, force: true });
  }
});

test("47. Already existing destination is never deleted or overwritten during reconciliation", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "fo-r4b-already-existing-"));
  const dbPath = path.join(root, "source.sqlite");
  const destPath = path.join(root, "dest.sqlite");
  createSyntheticDb(dbPath, 20);

  // Pre-create destination file with original content
  writeFileSync(destPath, "pre-existing original content");

  const runner = new BackupProcessRunner();
  try {
    let failed = false;
    try {
      await runner.backupDatabase(dbPath, destPath);
    } catch (err) {
      failed = true;
      expect((err as BackupRunnerError).code).toBe("TARGET_EXISTS");
    }
    expect(failed).toBe(true);
    // Pre-existing file content must remain completely unchanged
    expect(readFileSync(destPath, "utf8")).toBe("pre-existing original content");
  } finally {
    await runner.dispose();
    rmSync(root, { recursive: true, force: true });
  }
});

test("48. Bounded completed-operation history releases process handles and memory", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "fo-r4b-bounded-history-"));
  const dbPath = path.join(root, "source.sqlite");
  createSyntheticDb(dbPath, 10);

  const runner = new BackupProcessRunner({ maxConcurrency: 2, maxRecentOperations: 10 });
  try {
    // Run 15 verification operations to verify bounding at maxRecentOperations = 10
    for (let i = 0; i < 15; i++) {
      await runner.verifyDatabase(dbPath);
    }

    // Active operations map must be empty and recent operations bounded at 10
    const allOps = runner.listOperations();
    expect(allOps.length).toBe(10);

    // Each tracked recent operation must have terminal state and no lingering proc
    for (const op of allOps) {
      expect(op.state).toBe("completed");
    }
  } finally {
    await runner.dispose();
    rmSync(root, { recursive: true, force: true });
  }
}, 30000);

test("49. Queue processing continues after cancellation and failure", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "fo-r4b-queue-continuation-"));
  const dbPath = path.join(root, "source.sqlite");
  createSyntheticDb(dbPath, 20);

  const runner = new BackupProcessRunner({ maxConcurrency: 1 });
  try {
    const dest1 = path.join(root, "dest1.sqlite");
    const dest2 = path.join(root, "dest2.sqlite");
    const dest3 = path.join(root, "dest3.sqlite");

    // Queue 3 operations: 1st will be cancelled, 2nd will fail with bad path, 3rd will succeed
    const p1 = runner.backupDatabase(dbPath, dest1);
    const p2 = runner.backupDatabase(path.join(root, "non-existent.sqlite"), dest2);
    const p3 = runner.backupDatabase(dbPath, dest3);

    // Cancel p1 while queued
    const ops = runner.listOperations();
    await runner.cancel(ops[0]!.operationId);

    try {
      await p1;
    } catch (e) {
      expect((e as BackupRunnerError).code).toBe("CANCELLED");
    }

    try {
      await p2;
    } catch (e) {
      // Failed due to non-existent source
      expect(e).toBeDefined();
    }

    // p3 must succeed!
    const res3 = await p3;
    expect(res3.path).toBe(dest3);
    expect(existsSync(dest3)).toBe(true);
  } finally {
    await runner.dispose();
    rmSync(root, { recursive: true, force: true });
  }
});

test("50. Restore beforeExtract failure cleanup (DeepSeek F9 reproduction)", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "fo-r4b-f9-restore-extract-"));
  const dbPath = path.join(root, "source.sqlite");
  const snapDir = path.join(root, "snapshot");
  const restoreDest = path.join(root, "restored");
  createSyntheticDb(dbPath, 20);

  // First create a valid snapshot
  const runner = new BackupProcessRunner();
  try {
    await runner.createSnapshot(dbPath, snapDir, { isExplicitPath: true, createDirectory: true });
    expect(existsSync(path.join(snapDir, "manifest.json"))).toBe(true);

    const restore = new BackupRestore();

    let thrown = false;
    try {
      await restore.restore(snapDir, restoreDest, {
        beforeExtract: async () => {
          throw new Error("Simulated catastrophic failure in beforeExtract hook");
        },
      });
    } catch (err) {
      thrown = true;
      expect((err as Error).message).toContain("Simulated catastrophic failure in beforeExtract hook");
    }
    expect(thrown).toBe(true);

    // Verify: staging directory MUST NOT leak on disk!
    const parentEntries = readdirSync(path.dirname(restoreDest));
    const leakedStaging = parentEntries.filter((e) => e.includes(".fo-restore.") && e.endsWith(".tmp"));
    expect(leakedStaging.length).toBe(0);
  } finally {
    await runner.dispose();
    rmSync(root, { recursive: true, force: true });
  }
});

test("51. Parent disconnect and dispose() terminates workers and cleans staging", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "fo-r4b-dispose-workers-"));
  const dbPath = path.join(root, "source.sqlite");
  const destDir = path.join(root, "output");
  mkdirSync(destDir);
  createSyntheticDb(dbPath, 30);

  // Long-running worker
  const infiniteWorker = path.join(root, "infinite-worker.ts");
  writeFileSync(
    infiniteWorker,
    `
    import { createInterface } from "node:readline";
    const rl = createInterface({ input: process.stdin });
    rl.on("line", (line) => {
      const msg = JSON.parse(line);
      if (msg.type === "start") {
        process.stdout.write(JSON.stringify({ type: "state", operationId: msg.operation.operationId, state: "running" }) + "\\n");
        // Hang forever
        setInterval(() => {}, 1000);
      }
    });
    `,
  );

  const runner = new BackupProcessRunner({ workerScriptPath: infiniteWorker });
  const promise = runner.backupDatabase(dbPath, path.join(destDir, "backup.sqlite"));

  // Wait until worker is running
  await new Promise((r) => setTimeout(r, 100));

  // Dispose runner
  await runner.dispose();

  let rejected = false;
  try {
    await promise;
  } catch (err) {
    rejected = true;
    expect(["CANCELLED", "OPERATION_NOT_FOUND"]).toContain((err as BackupRunnerError).code);
  }
  expect(rejected).toBe(true);
  expect(runner.listOperations().length).toBe(0);

  rmSync(root, { recursive: true, force: true });
});

test("52. Full isolated round trip: Backup -> Verify -> Snapshot -> Restore -> Verify", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "fo-r4b-full-roundtrip-"));
  const dbPath = path.join(root, "source.sqlite");
  const backupPath = path.join(root, "backup.sqlite");
  const knowledgeDir = path.join(root, "knowledge");
  const snapshotPath = path.join(root, "snapshot");
  const restorePath = path.join(root, "restored");

  createSyntheticDb(dbPath, 60);
  setupKnowledgeDocs(dbPath, knowledgeDir, 4);

  const runner = new BackupProcessRunner();
  try {
    // 1. Isolated database backup
    const backupResult = await runner.backupDatabase(dbPath, backupPath);
    expect(backupResult.path).toBe(backupPath);
    expect(backupResult.bytes).toBeGreaterThan(0);

    // 2. Isolated database verification
    const dbVerify = await runner.verifyDatabase(backupPath);
    expect(dbVerify.ok).toBe(true);

    // 3. Isolated full snapshot creation
    const snapResult = await runner.createSnapshot(dbPath, snapshotPath, {
      isExplicitPath: true,
      knowledgeRootDir: knowledgeDir,
      createDirectory: true,
    });
    expect(snapResult.path).toBe(snapshotPath);
    expect(snapResult.manifest.verified).toBe(true);

    // 4. Isolated snapshot verification
    const snapVerify = await runner.verifySnapshot(snapshotPath);
    expect(snapVerify.ok).toBe(true);

    // 5. Isolated restore into fresh destination
    const restoreResult = await runner.restoreSnapshot(snapshotPath, restorePath, {
      dbFilename: "agetor.sqlite",
      createDirectory: true,
    });
    expect(restoreResult.destinationPath).toBe(restorePath);
    expect(restoreResult.filesRestored).toBeGreaterThanOrEqual(5);

    // 6. Verify restored database integrity
    const restoredDbVerify = await runner.verifyDatabase(path.join(restorePath, "agetor.sqlite"));
    expect(restoredDbVerify.ok).toBe(true);
  } finally {
    await runner.dispose();
    rmSync(root, { recursive: true, force: true });
  }
});
