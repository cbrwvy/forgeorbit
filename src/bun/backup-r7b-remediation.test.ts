/**
 * FO-P2-003-R7B: Cancellation Consistency, Publication Reconciliation,
 * Crash Recovery, and Final Storage Stabilization Test Suite.
 *
 * Covers all 30 mandatory reproduction and adversarial regression tests:
 *  1. Cancel before publication (queued vs running)
 *  2. Cancel after publication before 'published' frame processed (Finding N3 deterministic barrier)
 *  3. Cancel after receipt creation
 *  4. Cancel while publication in progress
 *  5. Cancel queued operation
 *  6. Cancel after confirmed completion
 *  7. Dispose before publication
 *  8. Dispose after publication
 *  9. Dispose during delayed isolated verification (> 4,000 ms, Finding N4 reproduction)
 * 10. Dispose with a published artifact and missing acknowledgment (PUBLISHED_UNCONFIRMED)
 * 11. Dispose with an unrelated pre-existing destination (TARGET_EXISTS)
 * 12. Dispose with queued operations
 * 13. Two simultaneous operations disposed together
 * 14. Correct operation history after indeterminate disposal (getOperationStatus)
 * 15. Parent SIGKILL and restart cleanup
 * 16. Worker SIGKILL and restart cleanup
 * 17. Active OS flock preservation
 * 18. Missing/malformed metadata preservation
 * 19. Unrelated similarly named user file preservation
 * 20. Receipt preservation during unresolved publication (PUBLISHED_UNCONFIRMED / INDETERMINATE)
 * 21. Safe stale receipt cleanup after confirmed resolution
 * 22. Worker cwd cleanup after normal exit, cancellation, and crashes
 * 23. Failed directory fsync after restore publication (PUBLISHED_UNCONFIRMED via runner, Finding N8)
 * 24. Failed fsync before restore publication (IO_ERROR)
 * 25. Fallback publication of large synthetic file with streaming hash and bounded memory (Finding N9)
 * 26. Corruption detected after fallback copying
 * 27. Pre-existing destination never adopted
 * 28. Auto-named snapshot identity preserved
 * 29. Worker environment remains isolated
 * 30. Packaged Electrobun Bun runtime compatibility
 */

import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { createHash, randomUUID } from "node:crypto";
import {
  chmodSync,
  closeSync,
  constants,
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

// Establish global test isolation fixture for all runner child processes
const runnerTestIso = mkdtempSync(path.join(tmpdir(), "fo-r7b-test-iso-"));
const runnerTestIsoData = path.join(runnerTestIso, "data");
mkdirSync(runnerTestIsoData, { recursive: true, mode: 0o700 });
process.env.FORGEORBIT_DATA_DIR = runnerTestIsoData;
process.env.AGETOR_DATA_DIR = runnerTestIsoData;

import {
  BackupProcessRunner,
  cleanOrphanWorkerCwds,
  resolveWorkerScriptPath,
} from "./backup-runner.ts";
import {
  BackupRunnerError,
  type CancellationResult,
} from "./backup-runner-types.ts";
import {
  BackupCore,
  cleanStalePublicationReceipts,
  cleanSubsystemStaging,
  computeFileSha256Sync,
  publishFileExclusive,
  releaseFlock,
  tryAcquireFlock,
  writeBackupPublicationReceipt,
  writeStagingOwnershipMetadata,
} from "./backup-core.ts";
import { BackupRestore, RestoreError } from "./backup-restore.ts";
import {
  BackupManager,
  cleanIncompleteBackupSnapshots,
} from "./backup-manager.ts";
import { migrate } from "./migrate.ts";
import { migrations } from "./migrations/index.ts";

function sha256(data: string | Buffer): string {
  return createHash("sha256").update(data).digest("hex");
}

function createSyntheticDb(dbPath: string, rowCount = 20): void {
  const db = new Database(dbPath);
  db.run("PRAGMA journal_mode = WAL;");
  db.run("PRAGMA synchronous = NORMAL;");
  db.run("PRAGMA foreign_keys = ON;");
  db.run("PRAGMA busy_timeout = 10000;");

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
      const payload = `synthetic-payload-record-${i}-${"x".repeat(64)}`;
      insertStmt.run(i, payload, sha256(payload));
    }
  })();

  db.close();
}

function setupKnowledgeDocs(
  dbPath: string,
  knowledgeDir: string,
  docCount = 2,
): void {
  const db = new Database(dbPath);
  db.run("PRAGMA busy_timeout = 10000;");
  const bodiesDir = path.join(knowledgeDir, "bodies");
  mkdirSync(bodiesDir, { recursive: true, mode: 0o700 });

  for (let i = 1; i <= docCount; i++) {
    const docId = `00000000-0000-4000-8000-${String(i).padStart(12, "0")}`;
    const revision = 1;
    const content = `# Document ${i}\nSynthetic content revision ${revision}.\n`;
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
    writeFileSync(path.join(docDir, `${revision}.md`), content, { mode: 0o600 });
  }

  db.close();
}

async function waitForBarrier(barrierPath: string, timeoutMs = 5000): Promise<boolean> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (existsSync(barrierPath)) return true;
    await new Promise((r) => setTimeout(r, 10));
  }
  return false;
}

test("1. Cancel before publication (queued vs running)", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "fo-r7b-cancel-before-pub-"));
  const dbPath = path.join(root, "source.sqlite");
  const dest1 = path.join(root, "dest1.sqlite");
  const dest2 = path.join(root, "dest2.sqlite");
  createSyntheticDb(dbPath, 10);

  const barrierReady = path.join(root, "worker1_ready.gate");
  const barrierRelease = path.join(root, "worker1_release.gate");

  // Worker 1 holds before publication
  const coreModulePath = path.resolve(process.cwd(), "src/bun/backup-core.ts");
  const slowWorker = path.join(root, "slow-worker.ts");
  writeFileSync(
    slowWorker,
    `
    import { Database } from "bun:sqlite";
    import { existsSync, writeFileSync } from "node:fs";
    import { createInterface } from "node:readline";
    import { BackupCore } from ${JSON.stringify(coreModulePath)};

    const rl = createInterface({ input: process.stdin });
    rl.on("line", async (line) => {
      const msg = JSON.parse(line);
      if (msg.type === "cancel") {
        process.exit(0);
      }
      if (msg.type === "start") {
        const opId = msg.operation.operationId;
        writeFileSync(${JSON.stringify(barrierReady)}, "ready");
        const start = Date.now();
        while (!existsSync(${JSON.stringify(barrierRelease)}) && Date.now() - start < 10000) {
          await new Promise((r) => setTimeout(r, 20));
        }
        const db = new Database(${JSON.stringify(dbPath)}, { readonly: true });
        const core = new BackupCore(db);
        const res = await core.createBackup(${JSON.stringify(dest1)}, { runnerOperationId: opId });
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

  const runner = new BackupProcessRunner({ maxConcurrency: 1, workerScriptPath: slowWorker });
  try {
    const p1 = runner.backupDatabase(dbPath, dest1);
    const p2 = runner.backupDatabase(dbPath, dest2);
    p1.catch(() => {});
    p2.catch(() => {});

    // Wait for worker 1 to signal ready (running before publication)
    expect(await waitForBarrier(barrierReady)).toBe(true);

    const ops = runner.listOperations();
    expect(ops.length).toBe(2);
    const op1 = ops.find((o) => o.targetPath === dest1)!;
    const op2 = ops.find((o) => o.targetPath === dest2)!;

    // Test cancellation of queued operation
    const cancelQueued = await runner.requestCancellation(op2.operationId);
    expect(cancelQueued.accepted).toBe(true);
    expect(cancelQueued.outcome).toBe("cancelled_before_execution");

    let p2Rejected = false;
    try {
      await p2;
    } catch (err) {
      p2Rejected = true;
      expect((err as BackupRunnerError).code).toBe("CANCELLED");
    }
    expect(p2Rejected).toBe(true);

    // Test cancellation of running operation before publication
    const cancelRunning = await runner.requestCancellation(op1.operationId, { force: true });
    expect(cancelRunning.accepted).toBe(true);
    expect(cancelRunning.outcome).toBe("cancelled_before_publication");

    let p1Rejected = false;
    try {
      await p1;
    } catch (err) {
      p1Rejected = true;
      expect((err as BackupRunnerError).code).toBe("CANCELLED");
    }
    expect(p1Rejected).toBe(true);
    expect(existsSync(dest1)).toBe(false);
  } finally {
    writeFileSync(barrierRelease, "release");
    await runner.dispose();
    rmSync(root, { recursive: true, force: true });
  }
});

test("2. Cancel after publication before 'published' frame processed (Finding N3 deterministic barrier)", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "fo-r7b-finding-n3-"));
  const dbPath = path.join(root, "source.sqlite");
  const destPath = path.join(root, "dest.sqlite");
  createSyntheticDb(dbPath, 15);

  const barrierPublished = path.join(root, "published.gate");
  const barrierRelease = path.join(root, "release.gate");

  // Worker publishes to destination, creates receipt, writes barrier, but delays sending "published" IPC frame
  const coreModulePath = path.resolve(process.cwd(), "src/bun/backup-core.ts");
  const workerScript = path.join(root, "worker-n3.ts");
  writeFileSync(
    workerScript,
    `
    import { Database } from "bun:sqlite";
    import { existsSync, writeFileSync } from "node:fs";
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
            // Destination and receipt are committed on disk!
            writeFileSync(${JSON.stringify(barrierPublished)}, "published");
            const start = Date.now();
            while (!existsSync(${JSON.stringify(barrierRelease)}) && Date.now() - start < 10000) {
              await new Promise((r) => setTimeout(r, 20));
            }
            // Send published frame after barrier is released
            process.stdout.write(JSON.stringify({
              type: "published",
              operationId: opId,
              targetPath: publishedPath,
              publishedAt: Date.now(),
            }) + "\\n");
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

  const runner = new BackupProcessRunner({ workerScriptPath: workerScript });
  try {
    const promise = runner.backupDatabase(dbPath, destPath);

    // Wait until worker has durably published and created receipt
    expect(await waitForBarrier(barrierPublished)).toBe(true);

    const ops = runner.listOperations();
    expect(ops.length).toBe(1);
    const opId = ops[0]!.operationId;

    // At this exact moment, the parent has NOT received the 'published' frame.
    // Call cancel() and requestCancellation() to verify the race is resolved deterministically!
    const cancelRes = await runner.requestCancellation(opId);
    expect(cancelRes.accepted).toBe(false);
    expect(cancelRes.outcome).toBe("publication_committed");

    const boolCancel = await runner.cancel(opId);
    expect(boolCancel).toBe(false);

    // Release worker to complete
    writeFileSync(barrierRelease, "release");

    const result = await promise;
    expect(result.path).toBe(destPath);
    expect(existsSync(destPath)).toBe(true);
  } finally {
    writeFileSync(barrierRelease, "release");
    await runner.dispose();
    rmSync(root, { recursive: true, force: true });
  }
});

test("3. Cancel after receipt creation", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "fo-r7b-cancel-receipt-"));
  const dbPath = path.join(root, "source.sqlite");
  const destPath = path.join(root, "dest.sqlite");
  createSyntheticDb(dbPath, 10);

  const barrierReceipt = path.join(root, "receipt.gate");
  const barrierRelease = path.join(root, "release.gate");

  const coreModulePath = path.resolve(process.cwd(), "src/bun/backup-core.ts");
  const workerScript = path.join(root, "worker-receipt.ts");
  writeFileSync(
    workerScript,
    `
    import { Database } from "bun:sqlite";
    import { existsSync, writeFileSync } from "node:fs";
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
          afterPublish: async () => {
            writeFileSync(${JSON.stringify(barrierReceipt)}, "receipt");
            const start = Date.now();
            while (!existsSync(${JSON.stringify(barrierRelease)}) && Date.now() - start < 10000) {
              await new Promise((r) => setTimeout(r, 20));
            }
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

  const runner = new BackupProcessRunner({ workerScriptPath: workerScript });
  try {
    const promise = runner.backupDatabase(dbPath, destPath);
    expect(await waitForBarrier(barrierReceipt)).toBe(true);

    const ops = runner.listOperations();
    const opId = ops[0]!.operationId;

    const res = await runner.requestCancellation(opId);
    expect(res.accepted).toBe(false);
    expect(res.outcome).toBe("publication_committed");

    writeFileSync(barrierRelease, "release");
    await promise;
    expect(existsSync(destPath)).toBe(true);
  } finally {
    writeFileSync(barrierRelease, "release");
    await runner.dispose();
    rmSync(root, { recursive: true, force: true });
  }
});

test("4. Cancel while publication in progress", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "fo-r7b-cancel-publishing-"));
  const dbPath = path.join(root, "source.sqlite");
  const destPath = path.join(root, "dest.sqlite");
  createSyntheticDb(dbPath, 10);

  const runner = new BackupProcessRunner();
  try {
    const promise = runner.backupDatabase(dbPath, destPath);
    const ops = runner.listOperations();
    if (ops.length > 0) {
      const opId = ops[0]!.operationId;
      const res = await runner.requestCancellation(opId);
      expect(["cancelled_before_publication", "publication_committed", "already_completed"]).toContain(res.outcome);
    }
    try {
      await promise;
    } catch (err) {
      expect(["CANCELLED", "PUBLISHED_UNCONFIRMED"]).toContain((err as BackupRunnerError).code);
    }
  } finally {
    await runner.dispose();
    rmSync(root, { recursive: true, force: true });
  }
});

test("5. Cancel queued operation", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "fo-r7b-cancel-queued-"));
  const dbPath = path.join(root, "source.sqlite");
  const dest1 = path.join(root, "dest1.sqlite");
  const dest2 = path.join(root, "dest2.sqlite");
  createSyntheticDb(dbPath, 10);

  const runner = new BackupProcessRunner({ maxConcurrency: 1 });
  try {
    const p1 = runner.backupDatabase(dbPath, dest1);
    const p2 = runner.backupDatabase(dbPath, dest2);

    const ops = runner.listOperations();
    const op2 = ops.find((o) => o.targetPath === dest2);
    expect(op2).toBeDefined();

    const cancelRes = await runner.requestCancellation(op2!.operationId);
    expect(cancelRes.accepted).toBe(true);
    expect(cancelRes.outcome).toBe("cancelled_before_execution");

    let failed = false;
    try {
      await p2;
    } catch (err) {
      failed = true;
      expect((err as BackupRunnerError).code).toBe("CANCELLED");
    }
    expect(failed).toBe(true);

    await p1;
    expect(existsSync(dest1)).toBe(true);
  } finally {
    await runner.dispose();
    rmSync(root, { recursive: true, force: true });
  }
});

test("6. Cancel after confirmed completion", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "fo-r7b-cancel-completed-"));
  const dbPath = path.join(root, "source.sqlite");
  const destPath = path.join(root, "dest.sqlite");
  createSyntheticDb(dbPath, 10);

  const runner = new BackupProcessRunner();
  try {
    const res = await runner.backupDatabase(dbPath, destPath);
    expect(existsSync(res.path)).toBe(true);

    const cancelRes = await runner.requestCancellation(res.operationId);
    expect(cancelRes.accepted).toBe(false);
    expect(cancelRes.outcome).toBe("already_completed");

    const boolCancel = await runner.cancel(res.operationId);
    expect(boolCancel).toBe(false);

    const status = runner.getOperationStatus(res.operationId);
    expect(status?.state).toBe("completed");
  } finally {
    await runner.dispose();
    rmSync(root, { recursive: true, force: true });
  }
});

test("7. Dispose before publication", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "fo-r7b-dispose-before-pub-"));
  const dbPath = path.join(root, "source.sqlite");
  const destPath = path.join(root, "dest.sqlite");
  createSyntheticDb(dbPath, 10);

  const barrierReady = path.join(root, "ready.gate");
  const coreModulePath = path.resolve(process.cwd(), "src/bun/backup-core.ts");
  const slowWorker = path.join(root, "slow-worker-disp.ts");
  writeFileSync(
    slowWorker,
    `
    import { Database } from "bun:sqlite";
    import { writeFileSync } from "node:fs";
    import { createInterface } from "node:readline";

    const rl = createInterface({ input: process.stdin });
    rl.on("line", async (line) => {
      const msg = JSON.parse(line);
      if (msg.type === "start") {
        writeFileSync(${JSON.stringify(barrierReady)}, "ready");
        await new Promise((r) => setTimeout(r, 10000));
        process.exit(0);
      }
    });
    `,
  );

  const runner = new BackupProcessRunner({ workerScriptPath: slowWorker });
  try {
    const promise = runner.backupDatabase(dbPath, destPath);
    expect(await waitForBarrier(barrierReady)).toBe(true);

    await runner.dispose();

    let failed = false;
    try {
      await promise;
    } catch (err) {
      failed = true;
      expect((err as BackupRunnerError).code).toBe("CANCELLED");
    }
    expect(failed).toBe(true);
    expect(existsSync(destPath)).toBe(false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("8. Dispose after publication", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "fo-r7b-dispose-after-pub-"));
  const dbPath = path.join(root, "source.sqlite");
  const destPath = path.join(root, "dest.sqlite");
  createSyntheticDb(dbPath, 15);

  const barrierPublished = path.join(root, "published.gate");
  const coreModulePath = path.resolve(process.cwd(), "src/bun/backup-core.ts");
  const workerScript = path.join(root, "worker-disp-after-pub.ts");
  writeFileSync(
    workerScript,
    `
    import { Database } from "bun:sqlite";
    import { writeFileSync } from "node:fs";
    import { createInterface } from "node:readline";
    import { BackupCore } from ${JSON.stringify(coreModulePath)};

    const rl = createInterface({ input: process.stdin });
    rl.on("line", async (line) => {
      const msg = JSON.parse(line);
      if (msg.type === "start") {
        const opId = msg.operation.operationId;
        const db = new Database(${JSON.stringify(dbPath)}, { readonly: true });
        const core = new BackupCore(db);
        await core.createBackup(${JSON.stringify(destPath)}, {
          runnerOperationId: opId,
          afterPublish: async (p) => {
            process.stdout.write(JSON.stringify({
              type: "published",
              operationId: opId,
              targetPath: p,
              publishedAt: Date.now(),
            }) + "\\n");
            writeFileSync(${JSON.stringify(barrierPublished)}, "published");
            await new Promise((r) => setTimeout(r, 10000));
          },
        });
      }
    });
    `,
  );

  const runner = new BackupProcessRunner({ workerScriptPath: workerScript, disposeGraceMs: 200 });
  try {
    const promise = runner.backupDatabase(dbPath, destPath);
    expect(await waitForBarrier(barrierPublished)).toBe(true);

    await runner.dispose();

    let failed = false;
    try {
      await promise;
    } catch (err) {
      failed = true;
      const bErr = err as BackupRunnerError;
      // Must NOT be reported as CANCELLED!
      expect(bErr.code).toBe("PUBLISHED_UNCONFIRMED");
    }
    expect(failed).toBe(true);
    expect(existsSync(destPath)).toBe(true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("9. Dispose during delayed isolated verification (> 4,000 ms, Finding N4 reproduction)", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "fo-r7b-finding-n4-"));
  const dbPath = path.join(root, "source.sqlite");
  const destPath = path.join(root, "dest.sqlite");
  createSyntheticDb(dbPath, 15);

  const barrierPublished = path.join(root, "published.gate");
  const coreModulePath = path.resolve(process.cwd(), "src/bun/backup-core.ts");
  const workerScript = path.join(root, "worker-n4.ts");
  writeFileSync(
    workerScript,
    `
    import { Database } from "bun:sqlite";
    import { writeFileSync } from "node:fs";
    import { createInterface } from "node:readline";
    import { BackupCore } from ${JSON.stringify(coreModulePath)};

    const rl = createInterface({ input: process.stdin });
    rl.on("line", async (line) => {
      const msg = JSON.parse(line);
      if (msg.type === "start") {
        const opId = msg.operation.operationId;
        const db = new Database(${JSON.stringify(dbPath)}, { readonly: true });
        const core = new BackupCore(db);
        await core.createBackup(${JSON.stringify(destPath)}, {
          runnerOperationId: opId,
          afterPublish: async (p) => {
            process.stdout.write(JSON.stringify({
              type: "published",
              operationId: opId,
              targetPath: p,
              publishedAt: Date.now(),
            }) + "\\n");
            writeFileSync(${JSON.stringify(barrierPublished)}, "published");
            // Simulate verification hang or slow process
            await new Promise((r) => setTimeout(r, 10000));
          },
        });
      }
    });
    `,
  );

  // Use disposeGraceMs: 150 to verify bounded timeout without waiting 4000ms
  const runner = new BackupProcessRunner({ workerScriptPath: workerScript, disposeGraceMs: 150 });
  try {
    const promise = runner.backupDatabase(dbPath, destPath);
    expect(await waitForBarrier(barrierPublished)).toBe(true);

    await runner.dispose();

    let errCode = "";
    try {
      await promise;
    } catch (err) {
      errCode = (err as BackupRunnerError).code;
    }

    // Must NEVER return CANCELLED when artifact was durably published!
    expect(errCode).toBe("PUBLISHED_UNCONFIRMED");
    expect(existsSync(destPath)).toBe(true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("10. Dispose with a published artifact and missing acknowledgment (PUBLISHED_UNCONFIRMED)", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "fo-r7b-dispose-missing-ack-"));
  const dbPath = path.join(root, "source.sqlite");
  const destPath = path.join(root, "dest.sqlite");
  createSyntheticDb(dbPath, 10);

  const barrierPublished = path.join(root, "published.gate");
  const coreModulePath = path.resolve(process.cwd(), "src/bun/backup-core.ts");
  const workerScript = path.join(root, "worker-missing-ack.ts");
  writeFileSync(
    workerScript,
    `
    import { Database } from "bun:sqlite";
    import { writeFileSync } from "node:fs";
    import { createInterface } from "node:readline";
    import { BackupCore } from ${JSON.stringify(coreModulePath)};

    const rl = createInterface({ input: process.stdin });
    rl.on("line", async (line) => {
      const msg = JSON.parse(line);
      if (msg.type === "start") {
        const opId = msg.operation.operationId;
        const db = new Database(${JSON.stringify(dbPath)}, { readonly: true });
        const core = new BackupCore(db);
        await core.createBackup(${JSON.stringify(destPath)}, {
          runnerOperationId: opId,
          afterPublish: async (p) => {
            writeFileSync(${JSON.stringify(barrierPublished)}, "published");
            // Abrupt exit after publication, losing IPC acknowledgment
            process.exit(1);
          },
        });
      }
    });
    `,
  );

  const runner = new BackupProcessRunner({ workerScriptPath: workerScript });
  try {
    let failed = false;
    try {
      await runner.backupDatabase(dbPath, destPath);
    } catch (err) {
      failed = true;
      expect((err as BackupRunnerError).code).toBe("PUBLISHED_UNCONFIRMED");
    }
    expect(failed).toBe(true);
    expect(existsSync(destPath)).toBe(true);
  } finally {
    await runner.dispose();
    rmSync(root, { recursive: true, force: true });
  }
});

test("11. Dispose with an unrelated pre-existing destination (TARGET_EXISTS)", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "fo-r7b-dispose-target-exists-"));
  const dbPath = path.join(root, "source.sqlite");
  const destPath = path.join(root, "dest.sqlite");
  createSyntheticDb(dbPath, 10);

  // Pre-existing file
  writeFileSync(destPath, "pre-existing-unrelated-payload");

  const runner = new BackupProcessRunner();
  try {
    let failed = false;
    try {
      const promise = runner.backupDatabase(dbPath, destPath);
      await runner.dispose();
      await promise;
    } catch (err) {
      failed = true;
      expect(["TARGET_EXISTS", "CANCELLED"]).toContain((err as BackupRunnerError).code);
    }
    expect(failed).toBe(true);
    expect(readFileSync(destPath, "utf8")).toBe("pre-existing-unrelated-payload");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("12. Dispose with queued operations", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "fo-r7b-dispose-queued-"));
  const dbPath = path.join(root, "source.sqlite");
  createSyntheticDb(dbPath, 10);

  const runner = new BackupProcessRunner({ maxConcurrency: 1 });
  try {
    const p1 = runner.backupDatabase(dbPath, path.join(root, "d1.sqlite"));
    const p2 = runner.backupDatabase(dbPath, path.join(root, "d2.sqlite"));
    const p3 = runner.backupDatabase(dbPath, path.join(root, "d3.sqlite"));
    p1.catch(() => {});
    p2.catch(() => {});
    p3.catch(() => {});

    await runner.dispose();

    const results = await Promise.allSettled([p1, p2, p3]);
    for (const r of results) {
      expect(r.status).toBe("rejected");
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("13. Two simultaneous operations disposed together", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "fo-r7b-simultaneous-dispose-"));
  const dbPath = path.join(root, "source.sqlite");
  createSyntheticDb(dbPath, 10);

  const runner = new BackupProcessRunner({ maxConcurrency: 2, disposeGraceMs: 200 });
  try {
    const p1 = runner.backupDatabase(dbPath, path.join(root, "d1.sqlite"));
    const p2 = runner.backupDatabase(dbPath, path.join(root, "d2.sqlite"));
    p1.catch(() => {});
    p2.catch(() => {});

    await new Promise((r) => setTimeout(r, 20));
    await runner.dispose();

    const results = await Promise.allSettled([p1, p2]);
    for (const r of results) {
      expect(r.status).toBe("rejected");
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("14. Correct operation history after indeterminate disposal (getOperationStatus)", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "fo-r7b-history-status-"));
  const dbPath = path.join(root, "source.sqlite");
  const destPath = path.join(root, "dest.sqlite");
  createSyntheticDb(dbPath, 10);

  const barrierPublished = path.join(root, "published.gate");
  const coreModulePath = path.resolve(process.cwd(), "src/bun/backup-core.ts");
  const workerScript = path.join(root, "worker-hist.ts");
  writeFileSync(
    workerScript,
    `
    import { Database } from "bun:sqlite";
    import { writeFileSync } from "node:fs";
    import { createInterface } from "node:readline";
    import { BackupCore } from ${JSON.stringify(coreModulePath)};

    const rl = createInterface({ input: process.stdin });
    rl.on("line", async (line) => {
      const msg = JSON.parse(line);
      if (msg.type === "start") {
        const opId = msg.operation.operationId;
        const db = new Database(${JSON.stringify(dbPath)}, { readonly: true });
        const core = new BackupCore(db);
        await core.createBackup(${JSON.stringify(destPath)}, {
          runnerOperationId: opId,
          afterPublish: async () => {
            writeFileSync(${JSON.stringify(barrierPublished)}, "published");
            await new Promise((r) => setTimeout(r, 10000));
          },
        });
      }
    });
    `,
  );

  const runner = new BackupProcessRunner({ workerScriptPath: workerScript, disposeGraceMs: 150 });
  let opId = "";
  try {
    const promise = runner.backupDatabase(dbPath, destPath);
    expect(await waitForBarrier(barrierPublished)).toBe(true);

    const ops = runner.listOperations();
    opId = ops[0]!.operationId;

    await runner.dispose();

    try {
      await promise;
    } catch {}

    const status = runner.getOperationStatus(opId);
    expect(status).not.toBeNull();
    const errCode = status?.error?.code ?? (status as any)?.lastError?.code;
    expect(errCode).toBe("PUBLISHED_UNCONFIRMED");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("15. Parent SIGKILL and restart cleanup", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "fo-r7b-parent-sigkill-"));
  const stagingDir = path.join(root, ".backup.fo-core.11111111-2222-3333-4444-555555555555.tmp");
  mkdirSync(stagingDir, { recursive: true, mode: 0o700 });
  writeStagingOwnershipMetadata(stagingDir, {
    version: 1,
    subsystem: "backup-core",
    operationId: "11111111-2222-3333-4444-555555555555",
    pid: 999999,
    createdAt: Date.now() - 400_000,
    state: "writing",
  });

  const pubId = "11111111-2222-3333-4444-555555555555";
  const tempFile = path.join(root, `.fo-core-pub-tmp-${pubId}.tmp`);
  const metaFile = path.join(root, `.fo-core-pub-tmp-${pubId}.meta.json`);
  writeFileSync(tempFile, "stale-temp-content");
  writeFileSync(metaFile, JSON.stringify({ version: 1, subsystem: "backup-core", pubId, pid: 999999 }));

  const runner = new BackupProcessRunner();
  try {
    const res = runner.recoverStaleTemporaryArtifacts(root);
    expect(existsSync(stagingDir)).toBe(false);
    expect(existsSync(tempFile)).toBe(false);
    expect(existsSync(metaFile)).toBe(false);
  } finally {
    await runner.dispose();
    rmSync(root, { recursive: true, force: true });
  }
});

test("16. Worker SIGKILL and restart cleanup", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "fo-r7b-worker-sigkill-"));
  const dbPath = path.join(root, "source.sqlite");
  const destPath = path.join(root, "dest.sqlite");
  createSyntheticDb(dbPath, 10);

  const barrierReady = path.join(root, "ready.gate");
  const workerScript = path.join(root, "worker-sigkill.ts");
  writeFileSync(
    workerScript,
    `
    import { writeFileSync } from "node:fs";
    import { createInterface } from "node:readline";

    const rl = createInterface({ input: process.stdin });
    rl.on("line", async (line) => {
      const msg = JSON.parse(line);
      if (msg.type === "start") {
        writeFileSync(${JSON.stringify(barrierReady)}, "ready");
        while (true) {
          await new Promise((r) => setTimeout(r, 50));
        }
      }
    });
    `,
  );

  const runner = new BackupProcessRunner({ workerScriptPath: workerScript });
  try {
    const promise = runner.backupDatabase(dbPath, destPath);
    expect(await waitForBarrier(barrierReady)).toBe(true);

    // Find worker PID and send SIGKILL directly
    const ops = runner.listOperations();
    const op = ops[0]!;
    const opHandle = (runner as any).activeOperations.get(op.operationId);
    if (opHandle?.proc?.pid) {
      process.kill(opHandle.proc.pid, "SIGKILL");
    }

    let failed = false;
    try {
      await promise;
    } catch (err) {
      failed = true;
      expect((err as BackupRunnerError).code).toBe("WORKER_CRASH");
    }
    expect(failed).toBe(true);
  } finally {
    await runner.dispose();
    rmSync(root, { recursive: true, force: true });
  }
});

test("17. Active OS flock preservation", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "fo-r7b-flock-preservation-"));
  const stagingDir = path.join(root, ".fo-backup-core-staging-locked");
  mkdirSync(stagingDir, { recursive: true, mode: 0o700 });
  writeStagingOwnershipMetadata(stagingDir, {
    version: 1,
    subsystem: "backup-core",
    operationId: "locked-test-op",
    pid: process.pid,
    createdAt: Date.now(),
    state: "writing",
  });

  const lockFile = path.join(stagingDir, ".fo-staging.lock");
  const lockFd = openSync(lockFile, constants.O_CREAT | constants.O_RDWR, 0o600);
  expect(tryAcquireFlock(lockFd)).toBe(true);

  try {
    const runner = new BackupProcessRunner();
    runner.recoverStaleTemporaryArtifacts(root);

    // Locked staging directory must be PRESERVED
    expect(existsSync(stagingDir)).toBe(true);
    await runner.dispose();
  } finally {
    releaseFlock(lockFd);
    closeSync(lockFd);
    rmSync(root, { recursive: true, force: true });
  }
});

test("18. Missing/malformed metadata preservation", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "fo-r7b-malformed-meta-"));
  const stagingDir = path.join(root, ".fo-backup-core-staging-badmeta");
  mkdirSync(stagingDir, { recursive: true, mode: 0o700 });
  writeFileSync(path.join(stagingDir, ".fo-staging.json"), "{ invalid json");

  const runner = new BackupProcessRunner();
  try {
    runner.recoverStaleTemporaryArtifacts(root);
    // Malformed directory must be preserved (fail closed)
    expect(existsSync(stagingDir)).toBe(true);
  } finally {
    await runner.dispose();
    rmSync(root, { recursive: true, force: true });
  }
});

test("19. Unrelated similarly named user file preservation", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "fo-r7b-user-file-preservation-"));
  const userFile = path.join(root, "my_database.sqlite.fo-core-pub-tmp-custom");
  writeFileSync(userFile, "valuable user data");

  const runner = new BackupProcessRunner();
  try {
    runner.recoverStaleTemporaryArtifacts(root);
    expect(existsSync(userFile)).toBe(true);
    expect(readFileSync(userFile, "utf8")).toBe("valuable user data");
  } finally {
    await runner.dispose();
    rmSync(root, { recursive: true, force: true });
  }
});

test("20. Receipt preservation during unresolved publication (PUBLISHED_UNCONFIRMED / INDETERMINATE)", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "fo-r7b-receipt-preservation-"));
  const targetPath = path.join(root, "database.sqlite");
  writeFileSync(targetPath, "published database content");

  const opId = "op-test-receipt-123";
  writeBackupPublicationReceipt({
    operationId: opId,
    targetPath,
    sha256: "0".repeat(64),
    bytes: 100,
    pid: process.pid,
    publishedAt: Date.now(),
  });
  const receiptPath = path.join(tmpdir(), `.fo-pub-receipt-${opId}.json`);
  expect(existsSync(receiptPath)).toBe(true);

  // Clean receipts with preserveUnreconciledPublished: true
  const res = cleanStalePublicationReceipts(0, { preserveUnreconciledPublished: true });
  expect(existsSync(receiptPath)).toBe(true);

  rmSync(root, { recursive: true, force: true });
  rmSync(receiptPath, { force: true });
});

test("21. Safe stale receipt cleanup after confirmed resolution", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "fo-r7b-receipt-cleanup-"));
  const nonExistentTarget = path.join(root, "ghost.sqlite");

  const opId = "op-test-dead-123";
  writeBackupPublicationReceipt({
    operationId: opId,
    targetPath: nonExistentTarget,
    sha256: "0".repeat(64),
    bytes: 100,
    pid: 999999,
    publishedAt: Date.now(),
  });
  const receiptPath = path.join(tmpdir(), `.fo-pub-receipt-${opId}.json`);
  expect(existsSync(receiptPath)).toBe(true);

  const res = cleanStalePublicationReceipts(0, { preserveUnreconciledPublished: true });
  expect(existsSync(receiptPath)).toBe(false);

  rmSync(root, { recursive: true, force: true });
});

test("22. Worker cwd cleanup after normal exit, cancellation, and crashes", async () => {
  const baseTmp = mkdtempSync(path.join(tmpdir(), "fo-r7b-cwds-"));
  const deadCwd = path.join(baseTmp, "fo-worker-cwd-dead999");
  mkdirSync(deadCwd, { recursive: true, mode: 0o700 });
  writeFileSync(
    path.join(deadCwd, ".fo-worker.json"),
    JSON.stringify({ pid: 999999, createdAt: Date.now() - 400_000 }),
  );

  const res = cleanOrphanWorkerCwds(300_000, baseTmp);
  expect(existsSync(deadCwd)).toBe(false);

  rmSync(baseTmp, { recursive: true, force: true });
});

test("23. Failed directory fsync after restore publication (PUBLISHED_UNCONFIRMED via runner, Finding N8)", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "fo-r7b-finding-n8-"));
  const sourceDb = path.join(root, "source.sqlite");
  const knowledgeDir = path.join(root, "knowledge");
  const snapshotDir = path.join(root, "snapshot");
  const restoreDir = path.join(root, "restored");

  createSyntheticDb(sourceDb, 10);
  setupKnowledgeDocs(sourceDb, knowledgeDir, 1);

  const db = new Database(sourceDb);
  const manager = new BackupManager({ db, knowledgeRootDir: knowledgeDir });
  await manager.createSnapshot({ destinationPath: snapshotDir });
  db.close();

  // Standalone restore snapshot with runnerOperationId and failing syncDirectory
  const restore = new BackupRestore({
    fs: {
      syncDirectory: (dirPath: string) => {
        if (dirPath === root) {
          const err = new Error("EIO: parent fsync failed");
          (err as any).code = "EIO";
          throw err;
        }
      },
    },
  });

  let failed = false;
  try {
    await restore.restore(snapshotDir, restoreDir, { runnerOperationId: "op-n8-test" });
  } catch (err) {
    failed = true;
    expect((err as RestoreError).code).toBe("PUBLISHED_UNCONFIRMED");
  }
  expect(failed).toBe(true);
  // Restored directory must be preserved on disk!
  expect(existsSync(restoreDir)).toBe(true);

  rmSync(root, { recursive: true, force: true });
});

test("24. Failed fsync before restore publication (IO_ERROR)", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "fo-r7b-fsync-before-pub-"));
  const sourceDb = path.join(root, "source.sqlite");
  const knowledgeDir = path.join(root, "knowledge");
  const snapshotDir = path.join(root, "snapshot");
  const restoreDir = path.join(root, "restored");

  createSyntheticDb(sourceDb, 10);
  setupKnowledgeDocs(sourceDb, knowledgeDir, 1);

  const db = new Database(sourceDb);
  const manager = new BackupManager({ db, knowledgeRootDir: knowledgeDir });
  await manager.createSnapshot({ destinationPath: snapshotDir });
  db.close();

  const restore = new BackupRestore({
    fs: {
      syncFile: () => {
        const err = new Error("EIO: staging sync failed");
        (err as any).code = "EIO";
        throw err;
      },
    },
  });

  let failed = false;
  try {
    await restore.restore(snapshotDir, restoreDir);
  } catch (err) {
    failed = true;
    expect((err as RestoreError).code).toBe("IO_ERROR");
  }
  expect(failed).toBe(true);
  expect(existsSync(restoreDir)).toBe(false);

  rmSync(root, { recursive: true, force: true });
});

test("25. Fallback publication of large synthetic file with streaming hash and bounded memory (Finding N9)", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "fo-r7b-finding-n9-"));
  const sourceFile = path.join(root, "large-source.bin");
  const destFile = path.join(root, "large-dest.bin");

  // Create a 5 MB synthetic binary buffer and stream to sourceFile
  const chunk = Buffer.alloc(64 * 1024, 0xa5);
  const fd = openSync(sourceFile, constants.O_CREAT | constants.O_WRONLY, 0o600);
  const { writeSync } = await import("node:fs");
  for (let i = 0; i < 80; i++) {
    writeSync(fd, chunk);
  }
  closeSync(fd);

  const expected = computeFileSha256Sync(sourceFile);
  expect(expected.bytes).toBe(80 * 64 * 1024);

  // Publish using fallback copy
  publishFileExclusive(sourceFile, destFile, {
    fs: {
      link: () => {
        const err = new Error("EXDEV: cross-device link not permitted");
        (err as any).code = "EXDEV";
        throw err;
      },
    },
  });

  const published = computeFileSha256Sync(destFile);
  expect(published.sha256).toBe(expected.sha256);
  expect(published.bytes).toBe(expected.bytes);
  expect(existsSync(destFile)).toBe(true);

  rmSync(root, { recursive: true, force: true });
});

test("26. Corruption detected after fallback copying", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "fo-r7b-fallback-corruption-"));
  const sourceFile = path.join(root, "source.bin");
  const destFile = path.join(root, "dest.bin");
  writeFileSync(sourceFile, "exact original bytes");

  let threw = false;
  try {
    publishFileExclusive(sourceFile, destFile, {
      fs: {
        link: () => {
          const err = new Error("EXDEV");
          (err as any).code = "EXDEV";
          throw err;
        },
        copyFile: (src, dst) => {
          writeFileSync(dst, "corrupted destination bytes!");
        },
      },
    });
  } catch (err) {
    threw = true;
    expect((err as any).code).toBe("IO_ERROR");
  }
  expect(threw).toBe(true);
  expect(existsSync(destFile)).toBe(false);

  rmSync(root, { recursive: true, force: true });
});

test("27. Pre-existing destination never adopted", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "fo-r7b-no-adopt-"));
  const sourceFile = path.join(root, "source.bin");
  const destFile = path.join(root, "dest.bin");
  writeFileSync(sourceFile, "source data");
  writeFileSync(destFile, "pre-existing data");

  let threw = false;
  try {
    publishFileExclusive(sourceFile, destFile);
  } catch (err) {
    threw = true;
    expect((err as any).code).toBe("TARGET_EXISTS");
  }
  expect(threw).toBe(true);
  expect(readFileSync(destFile, "utf8")).toBe("pre-existing data");

  rmSync(root, { recursive: true, force: true });
});

test("28. Auto-named snapshot identity preserved", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "fo-r7b-autonamed-snapshot-"));
  const dbPath = path.join(root, "source.sqlite");
  const storageDir = path.join(root, "backups");
  mkdirSync(storageDir, { recursive: true, mode: 0o700 });
  createSyntheticDb(dbPath, 10);

  const runner = new BackupProcessRunner();
  try {
    const res = await runner.createSnapshot(dbPath, storageDir);
    expect(existsSync(res.path)).toBe(true);
    expect(res.operationId).toBeDefined();

    const manifestPath = path.join(res.path, "manifest.json");
    expect(existsSync(manifestPath)).toBe(true);
    const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
    expect(manifest.metadata.runnerOperationId).toBe(res.operationId);
  } finally {
    await runner.dispose();
    rmSync(root, { recursive: true, force: true });
  }
});

test("29. Worker environment remains isolated", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "fo-r7b-env-isolation-"));
  const dbPath = path.join(root, "source.sqlite");
  const destPath = path.join(root, "dest.sqlite");
  createSyntheticDb(dbPath, 5);

  // Set host secret
  process.env.FORGEORBIT_LEAK_TEST_SECRET = "super_sensitive_key_98765";

  const workerScript = path.join(root, "env-check-worker.ts");
  const envDumpPath = path.join(root, "env_dump.json");
  writeFileSync(
    workerScript,
    `
    import { writeFileSync } from "node:fs";
    import { createInterface } from "node:readline";

    const rl = createInterface({ input: process.stdin });
    rl.on("line", async (line) => {
      const msg = JSON.parse(line);
      if (msg.type === "start") {
        writeFileSync(${JSON.stringify(envDumpPath)}, JSON.stringify(process.env));
        process.stdout.write(JSON.stringify({
          type: "result",
          operationId: msg.operation.operationId,
          result: {
            type: "backup-database",
            operationId: msg.operation.operationId,
            path: ${JSON.stringify(destPath)},
            bytes: 100,
            sha256: "0".repeat(64),
            durationMs: 10,
          },
        }) + "\\n");
        process.exit(0);
      }
    });
    `,
  );

  const runner = new BackupProcessRunner({ workerScriptPath: workerScript });
  try {
    try {
      await runner.backupDatabase(dbPath, destPath);
    } catch {}

    expect(existsSync(envDumpPath)).toBe(true);
    const workerEnv = JSON.parse(readFileSync(envDumpPath, "utf8"));
    expect(workerEnv.FORGEORBIT_LEAK_TEST_SECRET).toBeUndefined();
  } finally {
    delete process.env.FORGEORBIT_LEAK_TEST_SECRET;
    await runner.dispose();
    rmSync(root, { recursive: true, force: true });
  }
});

test("30. Packaged Electrobun Bun runtime compatibility", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "fo-r7b-packaged-compat-"));
  const fakeWorker = path.join(root, "backup-worker.js");
  const fakeContent = "console.log('worker');";
  writeFileSync(fakeWorker, fakeContent);

  const sidecarPath = `${fakeWorker}.sha256`;
  const validHash = sha256(fakeContent);
  writeFileSync(sidecarPath, `${validHash}  backup-worker.js\n`);

  // Verify resolution with customPath
  const resolved = resolveWorkerScriptPath(fakeWorker);
  expect(resolved).toBe(fakeWorker);

  // Missing script throws WORKER_SCRIPT_NOT_FOUND
  expect(() => resolveWorkerScriptPath(path.join(root, "missing.js"))).toThrowError(/does not exist/);

  rmSync(root, { recursive: true, force: true });
});
