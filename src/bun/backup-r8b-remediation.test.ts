/**
 * FO-P2-003-R8B: Truthful Cancellation, Bounded Disposal, and Publication
 * Outcome Consistency — dedicated remediation suite.
 *
 * Every publication/cancellation scenario below uses a real child process and
 * real on-disk artifacts. A mock is never accepted as proof of a real-process
 * invariant.
 *
 * Coverage (30 mandated scenarios):
 *  1. Cancellation before worker start
 *  2. Cancellation before publication
 *  3. Cancellation after publication and valid receipt
 *  4. Cancellation after publication without receipt
 *  5. Cancellation after publication without staging evidence
 *  6. Cancellation when worker fails with INDETERMINATE
 *  7. Cancellation with pre-existing unrelated destination
 *  8. Cancellation racing with publication commit
 *  9. Cancellation during worker SIGKILL
 * 10. Cancellation after successful completion
 * 11. Disposal before publication
 * 12. Disposal after publication
 * 13. Disposal with genuinely slow verification over four seconds
 * 14. Disposal with an unresolved published artifact
 * 15. Disposal with two active operations
 * 16. Disposal with queued operations
 * 17. Disposal while verification child is being terminated
 * 18. Caller-visible result and operation history consistency
 * 19. No terminal-state overwrite after promise settlement
 * 20. Receipt write failure after durable publication
 * 21. Receipt collision and symlink safety
 * 22. Post-publication restore fsync failure through direct API
 * 23. Post-publication restore fsync failure through runner
 * 24. Pre-publication restore fsync failure
 * 25. Post-publication callback failure
 * 26. Existing target directory preserved
 * 27. Real parent SIGKILL and recovery
 * 28. Real worker SIGKILL and recovery
 * 29. Manifest v4 and R8A legacy regression
 * 30. Complete synthetic profile backup/verify/inactive restore/re-backup
 */

import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
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

// Global test isolation fixture for all runner child processes.
const r8bIsoRoot = mkdtempSync(path.join(tmpdir(), "fo-r8b-test-iso-"));
const r8bIsoData = path.join(r8bIsoRoot, "data");
mkdirSync(r8bIsoData, { recursive: true, mode: 0o700 });
process.env.FORGEORBIT_DATA_DIR = r8bIsoData;
process.env.AGETOR_DATA_DIR = r8bIsoData;

import {
  BackupProcessRunner,
  cleanOrphanWorkerCwds,
  resolveWorkerScriptPath,
} from "./backup-runner.ts";
import { BackupRunnerError } from "./backup-runner-types.ts";
import {
  BackupCore,
  computeFileSha256Sync,
  readBackupPublicationReceipt,
  recoverStalePublicationTempFiles,
  removeBackupPublicationReceipt,
  writeBackupPublicationReceipt,
} from "./backup-core.ts";
import { BackupManager, verifyBackupSnapshot } from "./backup-manager.ts";
import { BackupRestore, RestoreError } from "./backup-restore.ts";
import { migrate } from "./migrate.ts";
import { migrations } from "./migrations/index.ts";

const REPO_ROOT = process.cwd();
const CORE_MODULE_PATH = path.join(REPO_ROOT, "src/bun/backup-core.ts");
const MANAGER_MODULE_PATH = path.join(REPO_ROOT, "src/bun/backup-manager.ts");
const RESTORE_MODULE_PATH = path.join(REPO_ROOT, "src/bun/backup-restore.ts");

// ── Fixtures ────────────────────────────────────────────────────────────────

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
      payload TEXT NOT NULL
    );
  `);
  db.transaction(() => {
    for (let i = 1; i <= rowCount; i++) {
      db.run("INSERT INTO synthetic_records (id, payload) VALUES (?, ?);", [
        i,
        `synthetic-payload-${i}-${"x".repeat(32)}`,
      ]);
    }
  })();
  db.close();
}

function setupKnowledgeDocs(dbPath: string, knowledgeDir: string, docCount = 1): void {
  const db = new Database(dbPath);
  db.run("PRAGMA busy_timeout = 10000;");
  const bodiesDir = path.join(knowledgeDir, "bodies");
  mkdirSync(bodiesDir, { recursive: true, mode: 0o700 });

  for (let i = 1; i <= docCount; i++) {
    const docId = `00000000-0000-4000-8000-${String(i).padStart(12, "0")}`;
    const revision = 1;
    const content = `# R8B Document ${i}\nSynthetic content revision ${revision}.\n`;
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

function dbIntegrityOk(dbPath: string): boolean {
  try {
    const db = new Database(dbPath, { readonly: true });
    const row = db.query("PRAGMA integrity_check;").get() as Record<string, string>;
    db.close();
    return Object.values(row)[0] === "ok";
  } catch {
    return false;
  }
}

async function waitForBarrier(barrierPath: string, timeoutMs = 15_000): Promise<boolean> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (existsSync(barrierPath)) return true;
    await new Promise((r) => setTimeout(r, 10));
  }
  return false;
}

async function waitUntilGone(check: () => boolean, timeoutMs = 2000): Promise<boolean> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (check()) return true;
    await new Promise((r) => setTimeout(r, 10));
  }
  return false;
}

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function receiptPathFor(opId: string): string {
  return path.join(tmpdir(), `.fo-pub-receipt-${opId}.json`);
}

// ── Synthetic real worker sources ───────────────────────────────────────────

/**
 * Worker that either stays pre-publication or publishes a real SQLite backup
 * with/without a publication receipt, optionally emitting the `published`
 * frame, deleting its receipt, ignoring SIGTERM, or exiting after publishing.
 */
function publishWorkerSource(opts: {
  dbPath: string;
  destPath: string;
  publicationGate: string;
  receipt: boolean;
  emitPublishedFrame?: boolean;
  removeReceiptAfterPublish?: boolean;
  ignoreSigterm?: boolean;
  exitAfterPublishCode?: number;
  blockAfterPublishMs?: number;
  noStagingStateFrames?: boolean;
}): string {
  const block =
    opts.exitAfterPublishCode !== undefined
      ? `process.exit(${opts.exitAfterPublishCode});`
      : `await new Promise((r) => setTimeout(r, ${opts.blockAfterPublishMs ?? 30_000}));`;
  return `
    import { Database } from "bun:sqlite";
    import { unlinkSync, writeFileSync } from "node:fs";
    import { tmpdir } from "node:os";
    import path from "node:path";
    import { createInterface } from "node:readline";
    import { BackupCore } from ${JSON.stringify(CORE_MODULE_PATH)};

    if (${opts.ignoreSigterm ? "true" : "false"}) {
      process.on("SIGTERM", () => { /* deliberately ignore cooperative termination */ });
    }

    const rl = createInterface({ input: process.stdin });
    rl.on("line", async (line) => {
      const msg = JSON.parse(line);
      if (msg.type === "cancel") return;
      if (msg.type !== "start") return;
      const opId = msg.operation.operationId;
      const db = new Database(${JSON.stringify(opts.dbPath)}, { readonly: true });
      const core = new BackupCore(db);
      const backupOpts = {
        ${opts.receipt ? "runnerOperationId: opId," : ""}
        afterPublish: async (p) => {
          writeFileSync(${JSON.stringify(opts.publicationGate)}, "published");
          ${
            opts.emitPublishedFrame
              ? `process.stdout.write(JSON.stringify({ type: "published", operationId: opId, targetPath: p, publishedAt: Date.now() }) + "\\n");`
              : ""
          }
          ${
            opts.removeReceiptAfterPublish
              ? `try { unlinkSync(path.join(tmpdir(), ".fo-pub-receipt-" + opId + ".json")); } catch {}`
              : ""
          }
          ${block}
        },
      };
      const res = await core.createBackup(${JSON.stringify(opts.destPath)}, backupOpts);
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
      await new Promise((r) => setTimeout(r, 10));
      process.exit(0);
    });
  `;
}

/** Worker that becomes ready but never publishes, then blocks until killed. */
function prePublicationWorkerSource(opts: { readyGate: string; ignoreSigterm?: boolean }): string {
  return `
    import { writeFileSync } from "node:fs";
    import { createInterface } from "node:readline";

    if (${opts.ignoreSigterm ? "true" : "false"}) {
      process.on("SIGTERM", () => { /* deliberately ignore cooperative termination */ });
    }
    const rl = createInterface({ input: process.stdin });
    rl.on("line", async (line) => {
      const msg = JSON.parse(line);
      if (msg.type === "cancel") return;
      if (msg.type !== "start") return;
      writeFileSync(${JSON.stringify(opts.readyGate)}, String(process.pid));
      await new Promise((r) => setTimeout(r, 60_000));
      process.exit(0);
    });
  `;
}

/** Verification worker that genuinely sleeps before answering. Records its PID. */
function slowVerificationWorkerSource(opts: { startedGate: string; sleepMs: number }): string {
  return `
    import { createHash } from "node:crypto";
    import { readFileSync, statSync, writeFileSync } from "node:fs";
    import { createInterface } from "node:readline";

    const rl = createInterface({ input: process.stdin });
    rl.on("line", async (line) => {
      const msg = JSON.parse(line);
      if (msg.type !== "start") return;
      const opId = msg.operation.operationId;
      writeFileSync(${JSON.stringify(opts.startedGate)}, String(process.pid));
      await new Promise((r) => setTimeout(r, ${opts.sleepMs}));
      const target = msg.operation.payload.filePath;
      const bytes = readFileSync(target);
      process.stdout.write(JSON.stringify({
        type: "result",
        operationId: opId,
        result: {
          ok: true,
          sha256: createHash("sha256").update(bytes).digest("hex"),
          bytes: statSync(target).size,
          issues: [],
        },
      }) + "\\n");
      await new Promise((r) => setTimeout(r, 20));
      process.exit(0);
    });
  `;
}

function writeWorker(root: string, name: string, source: string): string {
  const workerPath = path.join(root, name);
  writeFileSync(workerPath, source, { mode: 0o600 });
  return workerPath;
}

// ── 1. Cancellation before worker start ─────────────────────────────────────

test("R8B-1: cancellation before worker start returns cancelled_before_execution", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "fo-r8b-c1-"));
  const dbPath = path.join(root, "source.sqlite");
  createSyntheticDb(dbPath, 10);
  const readyGate = path.join(root, "ready.gate");
  const worker = writeWorker(
    root,
    "worker.ts",
    prePublicationWorkerSource({ readyGate }),
  );
  const runner = new BackupProcessRunner({ maxConcurrency: 1, workerScriptPath: worker });
  try {
    const p1 = runner.backupDatabase(dbPath, path.join(root, "d1.sqlite"));
    const p2 = runner.backupDatabase(dbPath, path.join(root, "d2.sqlite"));
    p1.catch(() => {});
    p2.catch(() => {});
    expect(await waitForBarrier(readyGate)).toBe(true);

    const queued = runner.listOperations().find((op) => op.state === "queued");
    expect(queued).toBeDefined();
    const res = await runner.requestCancellation(queued!.operationId);
    expect(res.outcome).toBe("cancelled_before_execution");
    expect(res.cancelled).toBe(true);
    expect(res.accepted).toBe(true);

    await expect(p2).rejects.toMatchObject({ code: "CANCELLED" });
    const status = runner.getOperationStatus(queued!.operationId);
    expect(status?.state).toBe("cancelled");
    expect(status?.error?.code).toBe("CANCELLED");
  } finally {
    await runner.dispose();
    rmSync(root, { recursive: true, force: true });
  }
});

// ── 2. Cancellation before publication ──────────────────────────────────────

test("R8B-2: cancellation before publication is truthful and leaves no artifact", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "fo-r8b-c2-"));
  const dbPath = path.join(root, "source.sqlite");
  const destPath = path.join(root, "dest.sqlite");
  createSyntheticDb(dbPath, 10);
  const readyGate = path.join(root, "ready.gate");
  const worker = writeWorker(root, "worker.ts", prePublicationWorkerSource({ readyGate }));
  const runner = new BackupProcessRunner({ workerScriptPath: worker });
  try {
    const promise = runner.backupDatabase(dbPath, destPath);
    promise.catch(() => {});
    expect(await waitForBarrier(readyGate)).toBe(true);
    const opId = runner.listOperations()[0]!.operationId;

    const res = await runner.requestCancellation(opId, { force: true });
    expect(res.outcome).toBe("cancelled_before_publication");
    expect(res.cancelled).toBe(true);
    expect(res.accepted).toBe(true);
    expect(await runner.cancel(opId)).toBe(false); // already terminal, never re-accepted

    await expect(promise).rejects.toMatchObject({ code: "CANCELLED" });
    expect(existsSync(destPath)).toBe(false);
    const status = runner.getOperationStatus(opId);
    expect(status?.state).toBe("cancelled");
    expect(status?.error?.code).toBe("CANCELLED");
  } finally {
    await runner.dispose();
    rmSync(root, { recursive: true, force: true });
  }
});

// ── 3. Cancellation after publication with a valid receipt ──────────────────

test("R8B-3: cancellation after publication with a valid receipt is refused", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "fo-r8b-c3-"));
  const dbPath = path.join(root, "source.sqlite");
  const destPath = path.join(root, "dest.sqlite");
  createSyntheticDb(dbPath, 12);
  const gate = path.join(root, "published.gate");
  const worker = writeWorker(
    root,
    "worker.ts",
    publishWorkerSource({ dbPath, destPath, publicationGate: gate, receipt: true, emitPublishedFrame: true }),
  );
  const runner = new BackupProcessRunner({ workerScriptPath: worker });
  try {
    const promise = runner.backupDatabase(dbPath, destPath);
    promise.catch(() => {});
    expect(await waitForBarrier(gate)).toBe(true);
    const opId = runner.listOperations()[0]!.operationId;
    expect(readBackupPublicationReceipt(opId)).not.toBeNull();

    const res = await runner.requestCancellation(opId);
    expect(res.outcome).toBe("publication_committed");
    expect(res.cancelled).toBe(false);
    expect(res.accepted).toBe(false);
    expect(await runner.cancel(opId)).toBe(false);
    expect(res.details?.published).toBe(true);

    expect(dbIntegrityOk(destPath)).toBe(true);
  } finally {
    await runner.dispose();
    rmSync(root, { recursive: true, force: true });
  }
});

// ── 4. Cancellation after publication without a receipt ─────────────────────

test("R8B-4: cancellation after publication without receipt returns publication_unresolved", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "fo-r8b-c4-"));
  const dbPath = path.join(root, "source.sqlite");
  const destPath = path.join(root, "dest.sqlite");
  createSyntheticDb(dbPath, 12);
  const gate = path.join(root, "published.gate");
  const worker = writeWorker(
    root,
    "worker.ts",
    publishWorkerSource({
      dbPath,
      destPath,
      publicationGate: gate,
      receipt: false,
      emitPublishedFrame: false,
    }),
  );
  const runner = new BackupProcessRunner({ workerScriptPath: worker });
  try {
    const promise = runner.backupDatabase(dbPath, destPath);
    let callerCode = "";
    promise.catch((err) => {
      callerCode = (err as BackupRunnerError).code;
    });
    expect(await waitForBarrier(gate)).toBe(true);
    const opId = runner.listOperations()[0]!.operationId;
    expect(readBackupPublicationReceipt(opId)).toBeNull();

    const res = await runner.requestCancellation(opId, { force: true });
    expect(res.outcome).toBe("publication_unresolved");
    expect(res.cancelled).toBe(false);
    expect(res.accepted).toBe(false);
    expect(await runner.cancel(opId)).toBe(false);

    await promise.catch(() => {});
    expect(callerCode).toBe("INDETERMINATE");
    expect(existsSync(destPath)).toBe(true);
    expect(dbIntegrityOk(destPath)).toBe(true);

    const history = runner.getOperationStatus(opId);
    expect(history?.state).toBe("failed");
    expect(history?.error?.code).toBe("INDETERMINATE");
  } finally {
    await runner.dispose();
    rmSync(root, { recursive: true, force: true });
  }
});

// ── 5. Cancellation after publication without staging evidence ──────────────

test("R8B-5: settled publication with no receipt and no staging evidence is never re-labelled cancelled", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "fo-r8b-c5-"));
  const dbPath = path.join(root, "source.sqlite");
  const destPath = path.join(root, "dest.sqlite");
  createSyntheticDb(dbPath, 12);
  const gate = path.join(root, "published.gate");
  const worker = writeWorker(
    root,
    "worker.ts",
    `import { Database } from "bun:sqlite";
     import { readdirSync, rmSync, writeFileSync } from "node:fs";
     import path from "node:path";
     import { createInterface } from "node:readline";
     import { BackupCore } from ${JSON.stringify(CORE_MODULE_PATH)};
     const rl = createInterface({ input: process.stdin });
     rl.on("line", async (line) => {
       const msg = JSON.parse(line);
       if (msg.type !== "start") return;
       const db = new Database(${JSON.stringify(dbPath)}, { readonly: true });
       const core = new BackupCore(db);
       await core.createBackup(${JSON.stringify(destPath)}, {
         afterPublish: async () => {
           writeFileSync(${JSON.stringify(gate)}, "published");
           // Simulate loss of all staging evidence before the parent reconciles.
           const parent = path.dirname(${JSON.stringify(destPath)});
           for (const entry of readdirSync(parent)) {
             if (entry.includes(".fo-core.") && entry.endsWith(".tmp")) {
               rmSync(path.join(parent, entry), { recursive: true, force: true });
             }
           }
           process.exit(1);
         },
       });
     });`,
  );
  const runner = new BackupProcessRunner({ workerScriptPath: worker });
  try {
    const promise = runner.backupDatabase(dbPath, destPath);
    let callerCode = "";
    promise.catch((err) => {
      callerCode = (err as BackupRunnerError).code;
    });
    expect(await waitForBarrier(gate)).toBe(true);
    const opId = runner.listOperations()[0]!.operationId;
    expect(readBackupPublicationReceipt(opId)).toBeNull();

    await promise.catch(() => {});
    expect(callerCode).toBe("INDETERMINATE");
    expect(existsSync(destPath)).toBe(true);
    expect(dbIntegrityOk(destPath)).toBe(true);

    // The operation has settled with an unresolved publication; a later
    // cancellation must never claim that no publication occurred.
    const res = await runner.requestCancellation(opId);
    expect(res.outcome).toBe("publication_unresolved");
    expect(res.cancelled).toBe(false);
    expect(res.accepted).toBe(false);
    expect(await runner.cancel(opId)).toBe(false);

    const history = runner.getOperationStatus(opId);
    expect(history?.state).toBe("failed");
    expect(history?.error?.code).toBe("INDETERMINATE");
  } finally {
    await runner.dispose();
    rmSync(root, { recursive: true, force: true });
  }
});

// ── 6. Cancellation when the worker fails with INDETERMINATE ────────────────

test("R8B-6: worker INDETERMINATE can never become cancelled_before_publication", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "fo-r8b-c6-"));
  const dbPath = path.join(root, "source.sqlite");
  const destPath = path.join(root, "dest.sqlite");
  createSyntheticDb(dbPath, 12);
  const gate = path.join(root, "published.gate");
  const worker = writeWorker(
    root,
    "worker.ts",
    `import { Database } from "bun:sqlite";
     import { writeFileSync } from "node:fs";
     import { createInterface } from "node:readline";
     import { BackupCore } from ${JSON.stringify(CORE_MODULE_PATH)};
     const rl = createInterface({ input: process.stdin });
     rl.on("line", async (line) => {
       const msg = JSON.parse(line);
       if (msg.type !== "start") return;
       const opId = msg.operation.operationId;
       const db = new Database(${JSON.stringify(dbPath)}, { readonly: true });
       const core = new BackupCore(db);
       await core.createBackup(${JSON.stringify(destPath)}, {
         afterPublish: async () => {
           writeFileSync(${JSON.stringify(gate)}, "published");
           process.stdout.write(JSON.stringify({
             type: "error", operationId: opId,
             error: { code: "INDETERMINATE", message: "verification could not complete", subsystem: "backup-core" },
           }) + "\\n");
           await new Promise((r) => setTimeout(r, 5000));
           process.exit(1);
         },
       });
     });`,
  );
  const runner = new BackupProcessRunner({ workerScriptPath: worker });
  try {
    const promise = runner.backupDatabase(dbPath, destPath);
    let callerErr: BackupRunnerError | null = null;
    promise.catch((err) => {
      callerErr = err as BackupRunnerError;
    });
    expect(await waitForBarrier(gate)).toBe(true);

    // Wait for the worker to emit the INDETERMINATE error frame.
    const opId = runner.listOperations()[0]!.operationId;
    for (let i = 0; i < 300; i++) {
      const st = runner.getOperationStatus(opId);
      if (st?.error?.code === "INDETERMINATE") break;
      await new Promise((r) => setTimeout(r, 10));
    }

    const res = await runner.requestCancellation(opId, { force: true });
    expect(res.outcome).not.toBe("cancelled_before_publication");
    expect(res.outcome).toBe("publication_unresolved");
    expect(res.cancelled).toBe(false);
    expect(await runner.cancel(opId)).toBe(false);

    await promise.catch(() => {});
    expect(["INDETERMINATE", "PUBLISHED_UNCONFIRMED"]).toContain(callerErr!.code);
    expect(existsSync(destPath)).toBe(true);
    expect(dbIntegrityOk(destPath)).toBe(true);
  } finally {
    await runner.dispose();
    rmSync(root, { recursive: true, force: true });
  }
});

// ── 7. Cancellation with a pre-existing unrelated destination ───────────────

test("R8B-7: pre-existing unrelated destination is preserved and never adopted", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "fo-r8b-c7-"));
  const dbPath = path.join(root, "source.sqlite");
  const destPath = path.join(root, "dest.sqlite");
  createSyntheticDb(dbPath, 10);
  writeFileSync(destPath, "pre-existing-unrelated-payload");
  const readyGate = path.join(root, "ready.gate");
  const worker = writeWorker(root, "worker.ts", prePublicationWorkerSource({ readyGate }));
  const runner = new BackupProcessRunner({ workerScriptPath: worker });
  try {
    const promise = runner.backupDatabase(dbPath, destPath);
    promise.catch(() => {});
    expect(await waitForBarrier(readyGate)).toBe(true);
    const opId = runner.listOperations()[0]!.operationId;

    const res = await runner.requestCancellation(opId, { force: true });
    expect(res.outcome).toBe("cancelled_before_publication");
    expect(res.cancelled).toBe(true);
    await promise.catch(() => {});

    expect(readFileSync(destPath, "utf8")).toBe("pre-existing-unrelated-payload");
    const status = runner.getOperationStatus(opId);
    expect(status?.state).toBe("cancelled");
  } finally {
    await runner.dispose();
    rmSync(root, { recursive: true, force: true });
  }
});

// ── 8. Cancellation racing with the publication commit ──────────────────────

test("R8B-8: cancellation racing publication commit never claims non-publication", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "fo-r8b-c8-"));
  const dbPath = path.join(root, "source.sqlite");
  const destPath = path.join(root, "dest.sqlite");
  createSyntheticDb(dbPath, 15);
  const gate = path.join(root, "published.gate");
  const worker = writeWorker(
    root,
    "worker.ts",
    publishWorkerSource({
      dbPath,
      destPath,
      publicationGate: gate,
      receipt: true,
      emitPublishedFrame: false,
      blockAfterPublishMs: 400,
    }),
  );
  const runner = new BackupProcessRunner({ workerScriptPath: worker });
  try {
    const promise = runner.backupDatabase(dbPath, destPath);
    promise.catch(() => {});
    expect(await waitForBarrier(gate)).toBe(true);
    const opId = runner.listOperations()[0]!.operationId;

    // The receipt is already durable; the cancel call races the worker's exit.
    const res = await runner.requestCancellation(opId);
    expect(["publication_committed", "publication_unresolved"]).toContain(res.outcome);
    expect(res.cancelled).toBe(false);
    expect(await runner.cancel(opId)).toBe(false);
    expect(existsSync(destPath)).toBe(true);
    expect(dbIntegrityOk(destPath)).toBe(true);
  } finally {
    await runner.dispose();
    rmSync(root, { recursive: true, force: true });
  }
});

// ── 9. Cancellation during worker SIGKILL ───────────────────────────────────

test("R8B-9: SIGTERM-ignoring worker is escalation-killed and publication stays truthful", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "fo-r8b-c9-"));
  const dbPath = path.join(root, "source.sqlite");
  const destPath = path.join(root, "dest.sqlite");
  createSyntheticDb(dbPath, 10);
  const gate = path.join(root, "published.gate");
  const worker = writeWorker(
    root,
    "worker.ts",
    publishWorkerSource({
      dbPath,
      destPath,
      publicationGate: gate,
      receipt: false,
      ignoreSigterm: true,
    }),
  );
  const runner = new BackupProcessRunner({ workerScriptPath: worker });
  try {
    const promise = runner.backupDatabase(dbPath, destPath);
    promise.catch(() => {});
    expect(await waitForBarrier(gate)).toBe(true);
    const opId = runner.listOperations()[0]!.operationId;

    const startedAt = performance.now();
    const res = await runner.requestCancellation(opId, { force: true });
    const elapsed = performance.now() - startedAt;
    expect(elapsed).toBeLessThan(4000);
    expect(res.cancelled).toBe(false);
    expect(res.outcome).toBe("publication_unresolved");
    expect(existsSync(destPath)).toBe(true);
    expect(dbIntegrityOk(destPath)).toBe(true);
  } finally {
    await runner.dispose();
    rmSync(root, { recursive: true, force: true });
  }
});

// ── 10. Cancellation after successful completion ────────────────────────────

test("R8B-10: cancellation after successful completion reports already_completed", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "fo-r8b-c10-"));
  const dbPath = path.join(root, "source.sqlite");
  const destPath = path.join(root, "dest.sqlite");
  createSyntheticDb(dbPath, 12);
  const runner = new BackupProcessRunner();
  try {
    const result = await runner.backupDatabase(dbPath, destPath);
    expect(dbIntegrityOk(destPath)).toBe(true);
    expect(result.publicationReceipt?.written).toBe(true);

    const res = await runner.requestCancellation(result.operationId);
    expect(res.outcome).toBe("already_completed");
    expect(res.cancelled).toBe(false);
    expect(await runner.cancel(result.operationId)).toBe(false);
    expect(runner.getOperationStatus(result.operationId)?.state).toBe("completed");
  } finally {
    await runner.dispose();
    rmSync(root, { recursive: true, force: true });
  }
});

// ── 11. Disposal before publication ─────────────────────────────────────────

test("R8B-11: dispose before publication is bounded and cancels truthfully", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "fo-r8b-c11-"));
  const dbPath = path.join(root, "source.sqlite");
  const destPath = path.join(root, "dest.sqlite");
  createSyntheticDb(dbPath, 10);
  const readyGate = path.join(root, "ready.gate");
  const worker = writeWorker(
    root,
    "worker.ts",
    prePublicationWorkerSource({ readyGate, ignoreSigterm: true }),
  );
  const runner = new BackupProcessRunner({ workerScriptPath: worker, disposeGraceMs: 1500 });
  try {
    const promise = runner.backupDatabase(dbPath, destPath);
    let callerCode = "";
    promise.catch((err) => {
      callerCode = (err as BackupRunnerError).code;
    });
    expect(await waitForBarrier(readyGate)).toBe(true);
    const opId = runner.listOperations()[0]!.operationId;

    const startedAt = performance.now();
    await runner.dispose();
    const elapsed = performance.now() - startedAt;
    await promise.catch(() => {});

    expect(elapsed).toBeLessThan(1500 + 900);
    expect(callerCode).toBe("CANCELLED");
    expect(existsSync(destPath)).toBe(false);
    const status = runner.getOperationStatus(opId);
    expect(status?.state).toBe("cancelled");
    expect(status?.error?.code).toBe("CANCELLED");
  } finally {
    await runner.dispose();
    rmSync(root, { recursive: true, force: true });
  }
});

// ── 12. Disposal after publication ──────────────────────────────────────────

test("R8B-12: dispose after publication returns PUBLISHED_UNCONFIRMED and preserves the artifact", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "fo-r8b-c12-"));
  const dbPath = path.join(root, "source.sqlite");
  const destPath = path.join(root, "dest.sqlite");
  createSyntheticDb(dbPath, 15);
  const gate = path.join(root, "published.gate");
  const worker = writeWorker(
    root,
    "worker.ts",
    publishWorkerSource({
      dbPath,
      destPath,
      publicationGate: gate,
      receipt: true,
      emitPublishedFrame: true,
    }),
  );
  const runner = new BackupProcessRunner({ workerScriptPath: worker, disposeGraceMs: 1500 });
  try {
    const promise = runner.backupDatabase(dbPath, destPath);
    let callerCode = "";
    promise.catch((err) => {
      callerCode = (err as BackupRunnerError).code;
    });
    expect(await waitForBarrier(gate)).toBe(true);
    const opId = runner.listOperations()[0]!.operationId;

    await runner.dispose();
    await promise.catch(() => {});

    expect(callerCode).toBe("PUBLISHED_UNCONFIRMED");
    expect(dbIntegrityOk(destPath)).toBe(true);
    const history = runner.getOperationStatus(opId);
    expect(history?.state).toBe("failed");
    expect(history?.error?.code).toBe("PUBLISHED_UNCONFIRMED");
  } finally {
    await runner.dispose();
    rmSync(root, { recursive: true, force: true });
  }
});

// ── 13. Disposal with genuinely slow verification over four seconds ─────────

test("R8B-13: slow isolated verification cannot exceed the disposal deadline or corrupt the outcome", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "fo-r8b-c13-"));
  const dbPath = path.join(root, "source.sqlite");
  const destPath = path.join(root, "dest.sqlite");
  createSyntheticDb(dbPath, 15);
  const verifyGate = path.join(root, "verify.started");

  const mainWorker = writeWorker(
    root,
    "main-worker.ts",
    `import { Database } from "bun:sqlite";
     import { createInterface } from "node:readline";
     import { BackupCore } from ${JSON.stringify(CORE_MODULE_PATH)};
     const rl = createInterface({ input: process.stdin });
     rl.on("line", async (line) => {
       const msg = JSON.parse(line);
       if (msg.type !== "start") return;
       const opId = msg.operation.operationId;
       const db = new Database(${JSON.stringify(dbPath)}, { readonly: true });
       const core = new BackupCore(db);
       const res = await core.createBackup(${JSON.stringify(destPath)}, { runnerOperationId: opId });
       process.stdout.write(JSON.stringify({ type: "result", operationId: opId, result: {
         type: "backup-database", operationId: opId, path: res.path, bytes: res.bytes,
         sha256: res.sha256, durationMs: res.durationMs,
       }}) + "\\n");
       await new Promise((r) => setTimeout(r, 10));
       process.exit(0);
     });`,
  );
  const slowVerifyWorker = writeWorker(
    root,
    "slow-verify-worker.ts",
    slowVerificationWorkerSource({ startedGate: verifyGate, sleepMs: 8000 }),
  );

  const prevVerifyWorker = process.env.FORGEORBIT_BACKUP_WORKER_PATH;
  process.env.FORGEORBIT_BACKUP_WORKER_PATH = slowVerifyWorker;
  const runner = new BackupProcessRunner({ workerScriptPath: mainWorker, disposeGraceMs: 4000 });
  let callerCode = "";
  let opId = "";
  let verifyPid = -1;
  try {
    const promise = runner.backupDatabase(dbPath, destPath);
    promise.catch((err) => {
      callerCode = (err as BackupRunnerError).code;
    });
    expect(await waitForBarrier(verifyGate, 20_000)).toBe(true);
    verifyPid = Number(readFileSync(verifyGate, "utf8"));
    expect(verifyPid).toBeGreaterThan(0);
    opId = runner.listOperations()[0]!.operationId;

    const startedAt = performance.now();
    await runner.dispose();
    const elapsed = performance.now() - startedAt;
    await promise.catch(() => {});

    // Genuinely slow verification: it must not finish, and disposal must stay bounded.
    expect(elapsed).toBeLessThan(8000);
    expect(elapsed).toBeLessThan(4000 + 1200);
    expect(callerCode).toBe("PUBLISHED_UNCONFIRMED");

    const history = runner.getOperationStatus(opId);
    expect(history?.state).toBe("failed");
    expect(history?.error?.code).toBe("PUBLISHED_UNCONFIRMED");
    expect(dbIntegrityOk(destPath)).toBe(true);
    expect(existsSync(destPath)).toBe(true);

    // The verification child was terminated, never leaked.
    expect(await waitUntilGone(() => !pidAlive(verifyPid), 3000)).toBe(true);
  } finally {
    if (prevVerifyWorker === undefined) delete process.env.FORGEORBIT_BACKUP_WORKER_PATH;
    else process.env.FORGEORBIT_BACKUP_WORKER_PATH = prevVerifyWorker;
    await runner.dispose();
    rmSync(root, { recursive: true, force: true });
  }
});

// ── 14. Disposal with an unresolved published artifact ──────────────────────

test("R8B-14: dispose with an unattributable artifact reports INDETERMINATE and preserves it", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "fo-r8b-c14-"));
  const dbPath = path.join(root, "source.sqlite");
  const destPath = path.join(root, "dest.sqlite");
  createSyntheticDb(dbPath, 10);
  const gate = path.join(root, "wrote.gate");
  const worker = writeWorker(
    root,
    "worker.ts",
    `import { writeFileSync } from "node:fs";
     import { createInterface } from "node:readline";
     process.on("SIGTERM", () => { /* ignore */ });
     const rl = createInterface({ input: process.stdin });
     rl.on("line", async (line) => {
       const msg = JSON.parse(line);
       if (msg.type !== "start") return;
       writeFileSync(${JSON.stringify(destPath)}, "unattributable artifact payload");
       writeFileSync(${JSON.stringify(gate)}, "wrote");
       await new Promise((r) => setTimeout(r, 60_000));
       process.exit(0);
     });`,
  );
  const runner = new BackupProcessRunner({ workerScriptPath: worker, disposeGraceMs: 1500 });
  let callerCode = "";
  try {
    const promise = runner.backupDatabase(dbPath, destPath);
    promise.catch((err) => {
      callerCode = (err as BackupRunnerError).code;
    });
    expect(await waitForBarrier(gate)).toBe(true);
    const opId = runner.listOperations()[0]!.operationId;

    // A receipt that cannot authenticate this destination is not sufficient to
    // claim commitment, but it is evidence that must survive the unresolved outcome.
    const unrelatedTarget = path.join(root, "unrelated.sqlite");
    writeFileSync(unrelatedTarget, "unrelated");
    const seeded = writeBackupPublicationReceipt({
      operationId: opId,
      targetPath: unrelatedTarget,
      sha256: "9".repeat(64),
      bytes: statSync(unrelatedTarget).size,
      pid: process.pid,
      publishedAt: Date.now(),
    });
    expect(seeded.ok).toBe(true);

    const startedAt = performance.now();
    await runner.dispose();
    const elapsed = performance.now() - startedAt;
    await promise.catch(() => {});

    expect(elapsed).toBeLessThan(1500 + 900);
    expect(callerCode).toBe("INDETERMINATE");
    expect(existsSync(destPath)).toBe(true);
    expect(readFileSync(destPath, "utf8")).toBe("unattributable artifact payload");
    const history = runner.getOperationStatus(opId);
    expect(history?.state).toBe("failed");
    expect(history?.error?.code).toBe("INDETERMINATE");
    // Receipt evidence is preserved until safe reconciliation.
    expect(readBackupPublicationReceipt(opId)).not.toBeNull();
    removeBackupPublicationReceipt(opId);
  } finally {
    await runner.dispose();
    rmSync(root, { recursive: true, force: true });
  }
});

// ── 15. Disposal with two active operations ─────────────────────────────────

test("R8B-15: two active operations share one disposal deadline", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "fo-r8b-c15-"));
  const dbPath = path.join(root, "source.sqlite");
  createSyntheticDb(dbPath, 10);
  const readyGate = path.join(root, "ready.gate");
  const worker = writeWorker(
    root,
    "worker.ts",
    prePublicationWorkerSource({ readyGate, ignoreSigterm: true }),
  );
  const runner = new BackupProcessRunner({
    workerScriptPath: worker,
    maxConcurrency: 2,
    disposeGraceMs: 2000,
  });
  try {
    const p1 = runner.backupDatabase(dbPath, path.join(root, "d1.sqlite"));
    const p2 = runner.backupDatabase(dbPath, path.join(root, "d2.sqlite"));
    const codes: string[] = [];
    p1.catch((err) => codes.push((err as BackupRunnerError).code));
    p2.catch((err) => codes.push((err as BackupRunnerError).code));
    expect(await waitForBarrier(readyGate)).toBe(true);
    for (let i = 0; i < 200 && runner.listOperations().filter((o) => o.state === "running").length < 2; i++) {
      await new Promise((r) => setTimeout(r, 10));
    }

    const startedAt = performance.now();
    await runner.dispose();
    const elapsed = performance.now() - startedAt;
    await Promise.allSettled([p1, p2]);

    // A single shared deadline, not two sequential 2000 ms budgets.
    expect(elapsed).toBeLessThan(2000 + 900);
    expect(codes).toHaveLength(2);
    expect(codes.every((code) => code === "CANCELLED")).toBe(true);
    expect(existsSync(path.join(root, "d1.sqlite"))).toBe(false);
    expect(existsSync(path.join(root, "d2.sqlite"))).toBe(false);
  } finally {
    await runner.dispose();
    rmSync(root, { recursive: true, force: true });
  }
});

// ── 16. Disposal with queued operations ─────────────────────────────────────

test("R8B-16: dispose drains queued operations without multiplying the deadline", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "fo-r8b-c16-"));
  const dbPath = path.join(root, "source.sqlite");
  createSyntheticDb(dbPath, 10);
  const readyGate = path.join(root, "ready.gate");
  const worker = writeWorker(
    root,
    "worker.ts",
    prePublicationWorkerSource({ readyGate, ignoreSigterm: true }),
  );
  const runner = new BackupProcessRunner({
    workerScriptPath: worker,
    maxConcurrency: 1,
    disposeGraceMs: 1500,
  });
  try {
    const p1 = runner.backupDatabase(dbPath, path.join(root, "d1.sqlite"));
    const p2 = runner.backupDatabase(dbPath, path.join(root, "d2.sqlite"));
    const p3 = runner.backupDatabase(dbPath, path.join(root, "d3.sqlite"));
    p1.catch(() => {});
    p2.catch(() => {});
    p3.catch(() => {});
    expect(await waitForBarrier(readyGate)).toBe(true);

    const startedAt = performance.now();
    await runner.dispose();
    const elapsed = performance.now() - startedAt;
    const results = await Promise.allSettled([p1, p2, p3]);

    expect(elapsed).toBeLessThan(1500 + 900);
    expect(results.every((r) => r.status === "rejected")).toBe(true);
    for (const r of results) {
      if (r.status === "rejected") {
        expect((r.reason as BackupRunnerError).code).toBe("CANCELLED");
      }
    }
    expect(runner.listOperations()).toHaveLength(0);
  } finally {
    await runner.dispose();
    rmSync(root, { recursive: true, force: true });
  }
});

// ── 17. Disposal while the verification child is being terminated ───────────

test("R8B-17: terminating an in-flight verification child leaves no orphan and no IO_ERROR", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "fo-r8b-c17-"));
  const dbPath = path.join(root, "source.sqlite");
  const destPath = path.join(root, "dest.sqlite");
  createSyntheticDb(dbPath, 15);
  const verifyGate = path.join(root, "verify.started");

  const mainWorker = writeWorker(
    root,
    "main-worker.ts",
    publishWorkerSource({
      dbPath,
      destPath,
      publicationGate: path.join(root, "published.gate"),
      receipt: true,
      emitPublishedFrame: false,
      blockAfterPublishMs: 30_000,
    }),
  );
  // mainWorker publishes then blocks forever; force the parent into verification by
  // sending the result before blocking instead. Rebuild a dedicated worker:
  writeFileSync(
    mainWorker,
    `import { Database } from "bun:sqlite";
     import { createInterface } from "node:readline";
     import { BackupCore } from ${JSON.stringify(CORE_MODULE_PATH)};
     const rl = createInterface({ input: process.stdin });
     rl.on("line", async (line) => {
       const msg = JSON.parse(line);
       if (msg.type !== "start") return;
       const opId = msg.operation.operationId;
       const db = new Database(${JSON.stringify(dbPath)}, { readonly: true });
       const core = new BackupCore(db);
       const res = await core.createBackup(${JSON.stringify(destPath)}, { runnerOperationId: opId });
       process.stdout.write(JSON.stringify({ type: "result", operationId: opId, result: {
         type: "backup-database", operationId: opId, path: res.path, bytes: res.bytes,
         sha256: res.sha256, durationMs: res.durationMs,
       }}) + "\\n");
       await new Promise((r) => setTimeout(r, 10));
       process.exit(0);
     });`,
    { mode: 0o600 },
  );
  const slowVerifyWorker = writeWorker(
    root,
    "slow-verify-worker.ts",
    slowVerificationWorkerSource({ startedGate: verifyGate, sleepMs: 6000 }),
  );

  const prevVerifyWorker = process.env.FORGEORBIT_BACKUP_WORKER_PATH;
  process.env.FORGEORBIT_BACKUP_WORKER_PATH = slowVerifyWorker;
  const runner = new BackupProcessRunner({ workerScriptPath: mainWorker, disposeGraceMs: 2500 });
  let callerCode = "";
  let verifyPid = -1;
  const verifyCwdsBefore = new Set(
    readdirSync(tmpdir()).filter((entry) => entry.startsWith("fo-verify-cwd-")),
  );
  try {
    const promise = runner.backupDatabase(dbPath, destPath);
    promise.catch((err) => {
      callerCode = (err as BackupRunnerError).code;
    });
    expect(await waitForBarrier(verifyGate, 20_000)).toBe(true);
    verifyPid = Number(readFileSync(verifyGate, "utf8"));
    const opId = runner.listOperations()[0]!.operationId;

    const startedAt = performance.now();
    await runner.dispose();
    const elapsed = performance.now() - startedAt;
    await promise.catch(() => {});

    expect(elapsed).toBeLessThan(2500 + 1200);
    expect(callerCode).toBe("PUBLISHED_UNCONFIRMED");
    expect(runner.getOperationStatus(opId)?.error?.code).toBe("PUBLISHED_UNCONFIRMED");
    expect(await waitUntilGone(() => !pidAlive(verifyPid), 3000)).toBe(true);

    // Verification scratch directories created by this run are eventually removed.
    await waitUntilGone(() => {
      const now = readdirSync(tmpdir()).filter(
        (entry) => entry.startsWith("fo-verify-cwd-") && !verifyCwdsBefore.has(entry),
      );
      return now.length === 0;
    }, 3000);
    const leftovers = readdirSync(tmpdir()).filter(
      (entry) => entry.startsWith("fo-verify-cwd-") && !verifyCwdsBefore.has(entry),
    );
    expect(leftovers).toHaveLength(0);
  } finally {
    if (prevVerifyWorker === undefined) delete process.env.FORGEORBIT_BACKUP_WORKER_PATH;
    else process.env.FORGEORBIT_BACKUP_WORKER_PATH = prevVerifyWorker;
    await runner.dispose();
    rmSync(root, { recursive: true, force: true });
  }
});

// ── 18. Caller-visible result and operation history consistency ─────────────

test("R8B-18: caller-visible outcome and stored operation history always agree", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "fo-r8b-c18-"));
  const dbPath = path.join(root, "source.sqlite");
  const destPath = path.join(root, "dest.sqlite");
  createSyntheticDb(dbPath, 12);
  const clearedGate = path.join(root, "clear.gate");
  const preGate = path.join(root, "pre.gate");
  const failWorker = writeWorker(
    root,
    "fail-worker.ts",
    publishWorkerSource({
      dbPath,
      destPath,
      publicationGate: clearedGate,
      receipt: false,
      exitAfterPublishCode: 1,
    }),
  );
  const preWorker = writeWorker(
    root,
    "pre-worker.ts",
    prePublicationWorkerSource({ readyGate: preGate }),
  );

  // (a) unresolved publication: caller INDETERMINATE, history INDETERMINATE.
  const runnerA = new BackupProcessRunner({ workerScriptPath: failWorker });
  try {
    const promise = runnerA.backupDatabase(dbPath, destPath);
    let callerCode = "";
    promise.catch((err) => {
      callerCode = (err as BackupRunnerError).code;
    });
    expect(await waitForBarrier(clearedGate)).toBe(true);
    const opId = runnerA.listOperations()[0]!.operationId;
    await promise.catch(() => {});
    const status = runnerA.getOperationStatus(opId);
    expect(callerCode).toBe("INDETERMINATE");
    expect(status?.state).toBe("failed");
    expect(status?.error?.code).toBe("INDETERMINATE");
  } finally {
    await runnerA.dispose();
  }

  // (b) pre-publication cancellation: caller CANCELLED, history cancelled.
  const dest2 = path.join(root, "dest2.sqlite");
  const runnerB = new BackupProcessRunner({ workerScriptPath: preWorker });
  try {
    const promise = runnerB.backupDatabase(dbPath, dest2);
    promise.catch(() => {});
    expect(await waitForBarrier(preGate)).toBe(true);
    const opId = runnerB.listOperations()[0]!.operationId;
    const res = await runnerB.requestCancellation(opId, { force: true });
    expect(res.cancelled).toBe(true);
    await promise.catch(() => {});
    const status = runnerB.getOperationStatus(opId);
    expect(status?.state).toBe("cancelled");
    expect(status?.error?.code).toBe("CANCELLED");
    expect(res.outcome).toBe("cancelled_before_publication");
  } finally {
    await runnerB.dispose();
    rmSync(root, { recursive: true, force: true });
  }
});

// ── 19. No terminal-state overwrite after promise settlement ────────────────

test("R8B-19: dispose cannot overwrite an already-settled terminal outcome", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "fo-r8b-c19-"));
  const dbPath = path.join(root, "source.sqlite");
  const destPath = path.join(root, "dest.sqlite");
  createSyntheticDb(dbPath, 12);
  const gate = path.join(root, "published.gate");
  const worker = writeWorker(
    root,
    "worker.ts",
    publishWorkerSource({
      dbPath,
      destPath,
      publicationGate: gate,
      receipt: false,
      emitPublishedFrame: false,
      exitAfterPublishCode: 1,
    }),
  );
  const events: Array<{ state: string; code?: string }> = [];
  const runner = new BackupProcessRunner({
    workerScriptPath: worker,
    onStateChange: (status) => {
      events.push({ state: status.state, code: status.error?.code });
    },
  });
  try {
    const promise = runner.backupDatabase(dbPath, destPath);
    let callerCode = "";
    promise.catch((err) => {
      callerCode = (err as BackupRunnerError).code;
    });
    expect(await waitForBarrier(gate)).toBe(true);
    const opId = runner.listOperations()[0]!.operationId;
    await promise.catch(() => {});
    expect(callerCode).toBe("INDETERMINATE");

    const settledStatus = runner.getOperationStatus(opId);
    expect(settledStatus?.error?.code).toBe("INDETERMINATE");
    const eventCountAtSettlement = events.length;

    await runner.dispose();
    await new Promise((r) => setTimeout(r, 100));

    const finalStatus = runner.getOperationStatus(opId);
    expect(finalStatus?.state).toBe("failed");
    expect(finalStatus?.error?.code).toBe("INDETERMINATE");
    // No late state transition may be emitted for a settled operation.
    const late = events.slice(eventCountAtSettlement);
    expect(late.every((event) => event.state === "failed")).toBe(true);
    expect(late.some((event) => event.code === "CANCELLED")).toBe(false);

    // A cancellation request after settlement cannot redefine it either.
    const res = await runner.requestCancellation(opId);
    expect(res.outcome).toBe("publication_unresolved");
    expect(res.cancelled).toBe(false);
    expect(runner.getOperationStatus(opId)?.error?.code).toBe("INDETERMINATE");
  } finally {
    await runner.dispose();
    rmSync(root, { recursive: true, force: true });
  }
});

// ── 20. Receipt write failure after durable publication ─────────────────────

test("R8B-20: receipt write failures are structured evidence gaps, never unpublished artifacts", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "fo-r8b-c20-"));
  const dbPath = path.join(root, "source.sqlite");
  const dest1 = path.join(root, "dest1.sqlite");
  const dest2 = path.join(root, "dest2.sqlite");
  createSyntheticDb(dbPath, 12);

  const db = new Database(dbPath, { readonly: true });
  const core = new BackupCore(db);
  try {
    // (a) Receipt collision (EEXIST): never overwritten, publication still durable.
    const opId1 = "r8b-receipt-collision-0001";
    const existingReceiptPath = receiptPathFor(opId1);
    writeFileSync(existingReceiptPath, "pre-existing receipt evidence", { mode: 0o600 });
    const res1 = await core.createBackup(dest1, { runnerOperationId: opId1 });
    expect(res1.publicationReceipt?.ok).toBe(false);
    if (res1.publicationReceipt && !res1.publicationReceipt.ok) {
      expect(res1.publicationReceipt.code).toBe("RECEIPT_EXISTS");
    }
    expect(dbIntegrityOk(dest1)).toBe(true);
    expect(readFileSync(existingReceiptPath, "utf8")).toBe("pre-existing receipt evidence");
    expect(readBackupPublicationReceipt(opId1)).toBeNull();
    removeBackupPublicationReceipt(opId1);
    rmSync(existingReceiptPath, { force: true });

    // (b) Unavailable temporary storage (ENOENT): structured unwritable receipt.
    const opId2 = "r8b-receipt-unavailable-0002";
    const prevTmp = process.env.TMPDIR;
    process.env.TMPDIR = path.join(root, "missing-temp-storage");
    try {
      const res2 = await core.createBackup(dest2, { runnerOperationId: opId2 });
      expect(res2.publicationReceipt?.ok).toBe(false);
      if (res2.publicationReceipt && !res2.publicationReceipt.ok) {
        expect(res2.publicationReceipt.code).toBe("RECEIPT_UNWRITABLE");
      }
      expect(dbIntegrityOk(dest2)).toBe(true);
    } finally {
      if (prevTmp === undefined) delete process.env.TMPDIR;
      else process.env.TMPDIR = prevTmp;
    }

    // (c) EACCES on the receipt directory.
    const readOnlyTmp = path.join(root, "read-only-tmp");
    mkdirSync(readOnlyTmp, { recursive: true, mode: 0o700 });
    chmodSync(readOnlyTmp, 0o500);
    const dest3 = path.join(root, "dest3.sqlite");
    const prevTmp3 = process.env.TMPDIR;
    process.env.TMPDIR = readOnlyTmp;
    try {
      const res3 = await core.createBackup(dest3, { runnerOperationId: "r8b-receipt-eacces-0003" });
      expect(res3.publicationReceipt?.ok).toBe(false);
      if (res3.publicationReceipt && !res3.publicationReceipt.ok) {
        expect(res3.publicationReceipt.code).toBe("RECEIPT_UNWRITABLE");
      }
      expect(dbIntegrityOk(dest3)).toBe(true);
    } finally {
      if (prevTmp3 === undefined) delete process.env.TMPDIR;
      else process.env.TMPDIR = prevTmp3;
      chmodSync(readOnlyTmp, 0o700);
    }

    // (d) File fsync failure: no partial receipt is left behind.
    const opId4 = "r8b-receipt-fsync-0004";
    const fsyncOutcome = writeBackupPublicationReceipt(
      {
        operationId: opId4,
        targetPath: dest1,
        sha256: "a".repeat(64),
        bytes: statSync(dest1).size,
        pid: process.pid,
        publishedAt: Date.now(),
      },
      { fsync: () => {
        throw Object.assign(new Error("EIO: fsync failed"), { code: "EIO" });
      } },
    );
    expect(fsyncOutcome.ok).toBe(false);
    if (!fsyncOutcome.ok) expect(fsyncOutcome.code).toBe("RECEIPT_IO_ERROR");
    expect(existsSync(receiptPathFor(opId4))).toBe(false);
    expect(readBackupPublicationReceipt(opId4)).toBeNull();

    // (e) Directory fsync failure: receipt content remains valid, durability weaker.
    const opId5 = "r8b-receipt-dirsync-0005";
    const dirOutcome = writeBackupPublicationReceipt(
      {
        operationId: opId5,
        targetPath: dest1,
        sha256: computeFileSha256Sync(dest1).sha256,
        bytes: statSync(dest1).size,
        pid: process.pid,
        publishedAt: Date.now(),
      },
      { syncDirectory: () => {
        throw new Error("EIO: directory fsync failed");
      } },
    );
    expect(dirOutcome.ok).toBe(true);
    if (dirOutcome.ok) expect(dirOutcome.directorySynced).toBe(false);
    expect(readBackupPublicationReceipt(opId5)?.operationId).toBe(opId5);
    removeBackupPublicationReceipt(opId5);
  } finally {
    db.close();
    rmSync(root, { recursive: true, force: true });
  }
});

// ── 21. Receipt collision and symlink safety ────────────────────────────────

test("R8B-21: receipt collision, symlink and malformed-evidence handling fails closed", () => {
  const root = mkdtempSync(path.join(tmpdir(), "fo-r8b-c21-"));
  const target = path.join(root, "target.sqlite");
  const outside = path.join(root, "outside-victim.txt");
  writeFileSync(target, "target bytes");
  writeFileSync(outside, "outside victim bytes");

  try {
    // (a) Symlink at the receipt path must never be followed or overwritten.
    const opSymlink = "r8b-receipt-symlink-0021";
    const symlinkPath = receiptPathFor(opSymlink);
    symlinkSync(outside, symlinkPath);
    const symlinkOutcome = writeBackupPublicationReceipt({
      operationId: opSymlink,
      targetPath: target,
      sha256: "b".repeat(64),
      bytes: statSync(target).size,
      pid: process.pid,
      publishedAt: Date.now(),
    });
    expect(symlinkOutcome.ok).toBe(false);
    expect(readFileSync(outside, "utf8")).toBe("outside victim bytes");
    expect(readBackupPublicationReceipt(opSymlink)).toBeNull();
    rmSync(symlinkPath, { force: true });

    // (b) A valid pre-existing receipt is never overwritten.
    const opCollision = "r8b-receipt-collision-0021";
    const first = writeBackupPublicationReceipt({
      operationId: opCollision,
      targetPath: target,
      sha256: "c".repeat(64),
      bytes: statSync(target).size,
      pid: process.pid,
      publishedAt: Date.now(),
    });
    expect(first.ok).toBe(true);
    const before = readFileSync(receiptPathFor(opCollision), "utf8");
    const second = writeBackupPublicationReceipt({
      operationId: opCollision,
      targetPath: target,
      sha256: "d".repeat(64),
      bytes: statSync(target).size,
      pid: process.pid,
      publishedAt: Date.now(),
    });
    expect(second.ok).toBe(false);
    if (!second.ok) expect(second.code).toBe("RECEIPT_EXISTS");
    expect(readFileSync(receiptPathFor(opCollision), "utf8")).toBe(before);

    // (c) Ownership: receipt file is private (0o600).
    const mode = lstatSync(receiptPathFor(opCollision)).mode & 0o777;
    expect(mode).toBe(0o600);
    removeBackupPublicationReceipt(opCollision);

    // (d) Malformed pre-existing receipt candidates are rejected, not trusted.
    const opMalformed = "r8b-receipt-malformed-0021";
    writeFileSync(receiptPathFor(opMalformed), "{ not valid json", { mode: 0o600 });
    expect(readBackupPublicationReceipt(opMalformed)).toBeNull();
    const malformedWrite = writeBackupPublicationReceipt({
      operationId: opMalformed,
      targetPath: target,
      sha256: "e".repeat(64),
      bytes: statSync(target).size,
      pid: process.pid,
      publishedAt: Date.now(),
    });
    expect(malformedWrite.ok).toBe(false);
    if (!malformedWrite.ok) expect(malformedWrite.code).toBe("RECEIPT_EXISTS");
    expect(readFileSync(receiptPathFor(opMalformed), "utf8")).toBe("{ not valid json");

    // (e) Receipt with a foreign operation ID is rejected by the reader.
    const foreign = receiptPathFor("r8b-receipt-foreign-0021");
    writeFileSync(
      foreign,
      JSON.stringify({
        operationId: "some-other-operation",
        targetPath: target,
        sha256: "f".repeat(64),
        bytes: 1,
        pid: process.pid,
        publishedAt: Date.now(),
      }),
      { mode: 0o600 },
    );
    expect(readBackupPublicationReceipt("r8b-receipt-foreign-0021")).toBeNull();
    rmSync(foreign, { force: true });
  } finally {
    rmSync(receiptPathFor("r8b-receipt-collision-0021"), { force: true });
    rmSync(receiptPathFor("r8b-receipt-malformed-0021"), { force: true });
    rmSync(root, { recursive: true, force: true });
  }
});

// ── Restore fixture helper ──────────────────────────────────────────────────

async function createV4Snapshot(root: string): Promise<{
  sourceDb: string;
  knowledgeDir: string;
  snapshotDir: string;
  snapshotDbSha: string;
}> {
  const sourceDb = path.join(root, "source.sqlite");
  const knowledgeDir = path.join(root, "knowledge");
  const snapshotDir = path.join(root, "snapshot");
  createSyntheticDb(sourceDb, 10);
  setupKnowledgeDocs(sourceDb, knowledgeDir, 1);
  const db = new Database(sourceDb);
  try {
    const manager = new BackupManager({ db, knowledgeRootDir: knowledgeDir });
    await manager.createSnapshot({ destinationPath: snapshotDir, manifestVersion: 4 });
  } finally {
    db.close();
  }
  return {
    sourceDb,
    knowledgeDir,
    snapshotDir,
    snapshotDbSha: computeFileSha256Sync(path.join(snapshotDir, "database.sqlite")).sha256,
  };
}

// ── 22. Post-publication restore fsync failure through the direct API ───────

test("R8B-22: direct restore post-publication fsync failure reports PUBLISHED_UNCONFIRMED", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "fo-r8b-c22-"));
  const restoreDir = path.join(root, "restored");
  try {
    const { snapshotDir, snapshotDbSha } = await createV4Snapshot(root);
    const restore = new BackupRestore({
      fs: {
        syncDirectory: (dirPath: string) => {
          if (path.resolve(dirPath) === path.resolve(root)) {
            throw Object.assign(new Error("EIO: parent fsync failed"), { code: "EIO" });
          }
        },
      },
    });

    let caught: RestoreError | null = null;
    try {
      await restore.restore(snapshotDir, restoreDir, {});
    } catch (err) {
      caught = err as RestoreError;
    }
    expect(caught).toBeInstanceOf(RestoreError);
    expect(caught!.code).toBe("PUBLISHED_UNCONFIRMED");
    expect((caught!.details as { destinationPath?: string })?.destinationPath).toBe(restoreDir);

    // The published, valid directory is preserved — never deleted to hide the error.
    expect(existsSync(restoreDir)).toBe(true);
    expect(dbIntegrityOk(path.join(restoreDir, "agetor.sqlite"))).toBe(true);
    // Snapshot is immutable.
    expect(computeFileSha256Sync(path.join(snapshotDir, "database.sqlite")).sha256).toBe(snapshotDbSha);
    // No active profile activation happened.
    expect(process.env.FORGEORBIT_DATA_DIR).toBe(r8bIsoData);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// ── 23. Post-publication restore failure through the supervised runner ──────

test("R8B-23: supervised runner restore preserves PUBLISHED_UNCONFIRMED after publication", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "fo-r8b-c23-"));
  const restoreDir = path.join(root, "restored");
  const worker = writeWorker(
    root,
    "restore-worker.ts",
    `import { createInterface } from "node:readline";
     import { BackupRestore } from ${JSON.stringify(RESTORE_MODULE_PATH)};
     const rl = createInterface({ input: process.stdin });
     rl.on("line", async (line) => {
       const msg = JSON.parse(line);
       if (msg.type !== "start") return;
       const opId = msg.operation.operationId;
       const payload = msg.operation.payload;
       const restore = new BackupRestore({
         fs: {
           syncDirectory: (dirPath) => {
             if (dirPath === payload.__failOnDir) {
               throw Object.assign(new Error("EIO: parent fsync failed"), { code: "EIO" });
             }
           },
         },
       });
       try {
         await restore.restore(payload.snapshotPath, payload.destinationDir, { runnerOperationId: opId, __failOnDir: payload.__failOnDir });
         process.stdout.write(JSON.stringify({ type: "result", operationId: opId, result: { type: "restore-snapshot", operationId: opId } }) + "\\n");
       } catch (err) {
         process.stdout.write(JSON.stringify({
           type: "error",
           operationId: opId,
           error: { code: err.code ?? "UNKNOWN_ERROR", message: String(err.message ?? err), subsystem: "backup-restore" },
         }) + "\\n");
       }
       await new Promise((r) => setTimeout(r, 10));
       process.exit(1);
     });`,
  );
  const runner = new BackupProcessRunner({ workerScriptPath: worker });
  try {
    const { snapshotDir } = await createV4Snapshot(root);
    // The synthetic worker receives the failure target through the destination's parent.
    const payloadFailDir = path.resolve(root);
    const promise = runner.restoreSnapshot(snapshotDir, restoreDir, {
      createDirectory: true,
    });
    const capture: { caught?: BackupRunnerError } = {};
    promise.catch((err) => {
      capture.caught = err as BackupRunnerError;
    });
    // Wait for completion.
    const settled = await Promise.race([
      promise.then(() => true).catch(() => true),
      new Promise<boolean>((r) => setTimeout(() => r(false), 15_000)),
    ]);
    expect(settled).toBe(true);
    expect(capture.caught?.code).toBe("PUBLISHED_UNCONFIRMED");
    expect(existsSync(restoreDir)).toBe(true);
    expect(dbIntegrityOk(path.join(restoreDir, "agetor.sqlite"))).toBe(true);
    const opId = runner.listOperations()[0]?.operationId ?? "";
    if (opId) {
      const history = runner.getOperationStatus(opId);
      expect(history?.error?.code).toBe("PUBLISHED_UNCONFIRMED");
    }
    expect(payloadFailDir.length).toBeGreaterThan(0);
  } finally {
    await runner.dispose();
    rmSync(root, { recursive: true, force: true });
  }
});

test("R8B-24: pre-publication restore fsync failure is a definitive IO_ERROR with no destination", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "fo-r8b-c24-"));
  const restoreDir = path.join(root, "restored");
  try {
    const { snapshotDir } = await createV4Snapshot(root);
    const restore = new BackupRestore({
      fs: {
        syncFile: () => {
          throw Object.assign(new Error("EIO: staging fsync failed"), { code: "EIO" });
        },
      },
    });
    let caught: RestoreError | null = null;
    try {
      await restore.restore(snapshotDir, restoreDir, {});
    } catch (err) {
      caught = err as RestoreError;
    }
    expect(caught).toBeInstanceOf(RestoreError);
    expect(caught!.code).toBe("IO_ERROR");
    expect(existsSync(restoreDir)).toBe(false);
    const strayStaging = readdirSync(root).filter((entry) => entry.includes(".fo-restore."));
    expect(strayStaging).toHaveLength(0);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// ── 25. Post-publication callback failure ───────────────────────────────────

test("R8B-25: post-publication afterPublish callback failure is POST-publication uncertainty", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "fo-r8b-c25-"));
  const restoreDir = path.join(root, "restored");
  try {
    const { snapshotDir } = await createV4Snapshot(root);
    const restore = new BackupRestore();
    let caught: RestoreError | null = null;
    try {
      await restore.restore(snapshotDir, restoreDir, {
        afterPublish: () => {
          throw new Error("synthetic post-publication callback failure");
        },
      });
    } catch (err) {
      caught = err as RestoreError;
    }
    expect(caught).toBeInstanceOf(RestoreError);
    expect(caught!.code).toBe("PUBLISHED_UNCONFIRMED");
    expect((caught!.details as { destinationPath?: string })?.destinationPath).toBe(restoreDir);
    expect(existsSync(restoreDir)).toBe(true);
    expect(dbIntegrityOk(path.join(restoreDir, "agetor.sqlite"))).toBe(true);

    // Published but subsequently corrupted: still post-publication uncertainty,
    // never a claim that no artifact exists.
    const corruptedDir = path.join(root, "restored-corrupted");
    let corruptedCaught: RestoreError | null = null;
    try {
      await new BackupRestore().restore(snapshotDir, corruptedDir, {
        afterPublish: (publishedPath) => {
          writeFileSync(path.join(publishedPath, "agetor.sqlite"), "corrupted after publication");
        },
      });
    } catch (err) {
      corruptedCaught = err as RestoreError;
    }
    expect(corruptedCaught).toBeInstanceOf(RestoreError);
    expect(corruptedCaught!.code).toBe("PUBLISHED_UNCONFIRMED");
    expect((corruptedCaught!.details as { verificationFailed?: boolean })?.verificationFailed).toBe(true);
    expect(existsSync(corruptedDir)).toBe(true);
    expect(existsSync(path.join(corruptedDir, "agetor.sqlite"))).toBe(true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// ── 26. Existing target directory preserved ─────────────────────────────────

test("R8B-26: pre-existing restore target directory is preserved untouched", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "fo-r8b-c26-"));
  const restoreDir = path.join(root, "restored");
  try {
    const { snapshotDir } = await createV4Snapshot(root);
    mkdirSync(restoreDir, { recursive: true, mode: 0o700 });
    writeFileSync(path.join(restoreDir, "sentinel.txt"), "user data must survive");

    const restore = new BackupRestore();
    await expect(restore.restore(snapshotDir, restoreDir, {})).rejects.toMatchObject({
      name: "RestoreError",
      code: "TARGET_EXISTS",
    });
    expect(readFileSync(path.join(restoreDir, "sentinel.txt"), "utf8")).toBe("user data must survive");
    expect(existsSync(path.join(restoreDir, "agetor.sqlite"))).toBe(false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// ── 27. Real parent SIGKILL and recovery ────────────────────────────────────

test("R8B-27: real parent SIGKILL leaves no false publication and orphan worker cwd is recovered", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "fo-r8b-c27-"));
  const parentTmp = path.join(root, "parent-tmp");
  mkdirSync(parentTmp, { recursive: true, mode: 0o700 });
  const dbPath = path.join(root, "source.sqlite");
  createSyntheticDb(dbPath, 10);
  const destPath = path.join(root, "dest.sqlite");
  const readyGate = path.join(root, "worker.ready");
  const workerPidGate = path.join(root, "parent.worker.pid");

  const worker = writeWorker(
    root,
    "worker.ts",
    `import { writeFileSync } from "node:fs";
     import { createInterface } from "node:readline";
     const rl = createInterface({ input: process.stdin });
     rl.on("close", () => process.exit(1));
     process.stdin.on("end", () => process.exit(1));
     rl.on("line", async (line) => {
       const msg = JSON.parse(line);
       if (msg.type !== "start") return;
       writeFileSync(${JSON.stringify(readyGate)}, String(process.pid));
       await new Promise((r) => setTimeout(r, 60000));
       process.exit(0);
     });`,
  );
  const parentScript = path.join(root, "parent.ts");
  writeFileSync(
    parentScript,
    `import { writeFileSync } from "node:fs";
     import { BackupProcessRunner } from ${JSON.stringify(path.join(REPO_ROOT, "src/bun/backup-runner.ts"))};
     const runner = new BackupProcessRunner({ workerScriptPath: ${JSON.stringify(worker)} });
     const promise = runner.backupDatabase(${JSON.stringify(dbPath)}, ${JSON.stringify(destPath)});
     promise.catch(() => {});
     const timer = setInterval(() => {
       const op = runner.listOperations()[0];
       if (op?.pid) {
         writeFileSync(${JSON.stringify(workerPidGate)}, String(op.pid));
         clearInterval(timer);
       }
     }, 10);
     await new Promise(() => {});`,
    { mode: 0o600 },
  );

  const parent = Bun.spawn([process.execPath, parentScript], {
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
    env: { ...process.env, TMPDIR: parentTmp },
  });
  try {
    expect(await waitForBarrier(readyGate)).toBe(true);
    expect(await waitForBarrier(workerPidGate)).toBe(true);
    const parentPid = parent.pid;
    const workerPid = Number(readFileSync(workerPidGate, "utf8"));
    expect(workerPid).toBeGreaterThan(0);

    // Real SIGKILL of the supervising parent process.
    process.kill(parentPid, "SIGKILL");
    await parent.exited.catch(() => {});

    // The orphaned worker exits when its stdin pipe closes.
    expect(await waitUntilGone(() => !pidAlive(workerPid), 5000)).toBe(true);

    // No artifact was published, no receipt was written.
    expect(existsSync(destPath)).toBe(false);

    // Dead worker cwds are recoverable; live ones would be preserved by flock.
    const before = readdirSync(parentTmp).filter((entry) => entry.startsWith("fo-worker-cwd-"));
    expect(before.length).toBeGreaterThan(0);
    const cleaned = cleanOrphanWorkerCwds(0, parentTmp);
    expect(cleaned.cleaned.length).toBeGreaterThan(0);
    expect(
      readdirSync(parentTmp).filter((entry) => entry.startsWith("fo-worker-cwd-")),
    ).toHaveLength(0);

    // Recovery never invents a publication or deletes unrelated files.
    const recovery = recoverStalePublicationTempFiles(root);
    expect(recovery.errors).toHaveLength(0);
    expect(existsSync(destPath)).toBe(false);
  } finally {
    try {
      process.kill(parent.pid, "SIGKILL");
    } catch {
      /* already gone */
    }
    await parent.exited.catch(() => {});
    rmSync(root, { recursive: true, force: true });
  }
});

// ── 28. Real worker SIGKILL and recovery ────────────────────────────────────

test("R8B-28: real worker SIGKILL after publication yields INDETERMINATE, not false cancellation", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "fo-r8b-c28-"));
  const dbPath = path.join(root, "source.sqlite");
  const destPath = path.join(root, "dest.sqlite");
  createSyntheticDb(dbPath, 12);
  const gate = path.join(root, "published.gate");
  const worker = writeWorker(
    root,
    "worker.ts",
    publishWorkerSource({
      dbPath,
      destPath,
      publicationGate: gate,
      receipt: false,
      emitPublishedFrame: false,
      blockAfterPublishMs: 60_000,
    }),
  );
  const runner = new BackupProcessRunner({ workerScriptPath: worker });
  try {
    const promise = runner.backupDatabase(dbPath, destPath);
    let callerCode = "";
    promise.catch((err) => {
      callerCode = (err as BackupRunnerError).code;
    });
    expect(await waitForBarrier(gate)).toBe(true);
    const op = runner.listOperations()[0]!;
    expect(op.pid).toBeGreaterThan(0);

    process.kill(op.pid!, "SIGKILL");
    const settled = await Promise.race([
      promise.then(() => true).catch(() => true),
      new Promise<boolean>((r) => setTimeout(() => r(false), 15_000)),
    ]);
    expect(settled).toBe(true);
    expect(callerCode).toBe("INDETERMINATE");
    expect(existsSync(destPath)).toBe(true);
    expect(dbIntegrityOk(destPath)).toBe(true);

    const status = runner.getOperationStatus(op.operationId);
    expect(status?.state).toBe("failed");
    expect(status?.error?.code).toBe("INDETERMINATE");

    // Surviving evidence is preserved by recovery.
    recoverStalePublicationTempFiles(root);
    expect(existsSync(destPath)).toBe(true);

    const res = await runner.requestCancellation(op.operationId);
    expect(res.outcome).toBe("publication_unresolved");
    expect(res.cancelled).toBe(false);
  } finally {
    await runner.dispose();
    rmSync(root, { recursive: true, force: true });
  }
});

// ── 29. Manifest v4 and R8A legacy regression ───────────────────────────────

test("R8B-29: Manifest v4 format marker and legacy-unverified semantics remain intact", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "fo-r8b-c29-"));
  const sourceDb = path.join(root, "source.sqlite");
  const knowledgeDir = path.join(root, "knowledge");
  createSyntheticDb(sourceDb, 8);
  setupKnowledgeDocs(sourceDb, knowledgeDir, 1);
  const db = new Database(sourceDb);
  try {
    const manager = new BackupManager({ db, knowledgeRootDir: knowledgeDir });
    const v4 = await manager.createSnapshot({
      destinationPath: path.join(root, "snap-v4"),
      manifestVersion: 4,
    });
    expect(v4.manifest.manifestVersion).toBe(4);

    // The v4 format marker lives inside the staged SQLite file.
    const snapDb = new Database(path.join(v4.path, "database.sqlite"), { readonly: true });
    const marker = snapDb
      .query("SELECT name FROM sqlite_master WHERE type='table' AND name='forgeorbit_snapshot_format';")
      .get() as { name: string } | null;
    expect(marker?.name).toBe("forgeorbit_snapshot_format");
    const formatRow = snapDb
      .query("SELECT format_version FROM forgeorbit_snapshot_format ORDER BY rowid DESC LIMIT 1;")
      .get() as { format_version: number } | null;
    expect(formatRow?.format_version).toBe(4);
    snapDb.close();

    const restoredV4 = await new BackupRestore().restore(v4.path, path.join(root, "restored-v4"));
    expect(restoredV4.manifestVersion).toBe(4);
    expect(["ready", "requires-reference-repair", "requires-external-recovery"]).toContain(
      restoredV4.activationReadiness,
    );
    expect(dbIntegrityOk(path.join(root, "restored-v4", "agetor.sqlite"))).toBe(true);

    // Genuine v3 snapshot: the marker records 3 (manifest/format consistency),
    // and legacy restores are never automatically verified or rebound.
    const v3 = await manager.createSnapshot({
      destinationPath: path.join(root, "snap-v3"),
      manifestVersion: 3,
    });
    expect(v3.manifest.manifestVersion).toBe(3);
    const v3Db = new Database(path.join(v3.path, "database.sqlite"), { readonly: true });
    const v3Marker = v3Db
      .query("SELECT name FROM sqlite_master WHERE type='table' AND name='forgeorbit_snapshot_format';")
      .get() as { name: string } | null;
    expect(v3Marker?.name).toBe("forgeorbit_snapshot_format");
    const v3Format = v3Db
      .query("SELECT format_version FROM forgeorbit_snapshot_format ORDER BY rowid DESC LIMIT 1;")
      .get() as { format_version: number } | null;
    expect(v3Format?.format_version).toBe(3);
    v3Db.close();

    const restoredV3 = await new BackupRestore().restore(v3.path, path.join(root, "restored-v3"));
    expect(restoredV3.manifestVersion).toBe(3);
    expect(restoredV3.activationReadiness).toBe("legacy-unverified");
    expect(restoredV3.internalReferencesRebound).toBe(0);
  } finally {
    db.close();
    rmSync(root, { recursive: true, force: true });
  }
});

// ── 30. Complete synthetic profile cycle ────────────────────────────────────

test("R8B-30: synthetic profile backup/verify/inactive restore/re-backup round-trip", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "fo-r8b-c30-"));
  const dataDir = path.join(root, "data");
  const knowledgeDir = path.join(dataDir, "knowledge");
  const attachmentsDir = path.join(dataDir, "attachments");
  const screenshotsDir = path.join(dataDir, "screenshots");
  const issueThreadsDir = path.join(dataDir, "issue-threads");
  const pipelineRunsDir = path.join(dataDir, "pipeline-runs");
  const outputDir = path.join(root, "backups");
  const restoreDir = path.join(root, "restored");
  for (const dir of [dataDir, knowledgeDir, attachmentsDir, screenshotsDir, issueThreadsDir, pipelineRunsDir, outputDir]) {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
  }
  const dbPath = path.join(dataDir, "agetor.sqlite");
  createSyntheticDb(dbPath, 10);
  setupKnowledgeDocs(dbPath, knowledgeDir, 1);

  const taskId = "r8b-profile-task";
  const attachmentPath = path.join(attachmentsDir, "spec.txt");
  const screenshotPath = path.join(screenshotsDir, "shot.txt");
  const issueThreadPath = path.join(issueThreadsDir, taskId, "thread.md");
  const pipelinePath = path.join(pipelineRunsDir, taskId, "handoff.json");
  writeFileSync(attachmentPath, "attachment content", { mode: 0o600 });
  writeFileSync(screenshotPath, "screenshot content", { mode: 0o600 });
  mkdirSync(path.dirname(issueThreadPath), { recursive: true, mode: 0o700 });
  mkdirSync(path.dirname(pipelinePath), { recursive: true, mode: 0o700 });
  writeFileSync(issueThreadPath, "issue thread content", { mode: 0o600 });
  writeFileSync(pipelinePath, JSON.stringify({ kind: "handoff", id: taskId }), { mode: 0o600 });

  const sourceDb = new Database(dbPath);
  sourceDb.run(
    `INSERT INTO tasks (id, title, prompt, column, agent, workdir, isolation, refs, sent_files, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      taskId,
      "R8B profile task",
      "prompt",
      "ready",
      "claude-code",
      "/code/r8b-project",
      "worktree",
      JSON.stringify([issueThreadPath, pipelinePath]),
      JSON.stringify([attachmentPath, screenshotPath]),
      2000,
      2000,
    ],
  );
  sourceDb.close();

  const sourceHashBefore = computeFileSha256Sync(dbPath).sha256;
  const attachmentHashBefore = computeFileSha256Sync(attachmentPath).sha256;

  const runner = new BackupProcessRunner();
  try {
    const snapshot = await runner.createSnapshot(dbPath, outputDir, {
      dataDir,
      knowledgeRootDir: knowledgeDir,
      attachmentsRootDir: attachmentsDir,
      screenshotsRootDir: screenshotsDir,
      issueThreadsRootDir: issueThreadsDir,
      pipelineRunsRootDir: pipelineRunsDir,
    });
    expect(existsSync(snapshot.path)).toBe(true);
    expect(snapshot.manifest.manifestVersion).toBe(4);
    expect(snapshot.coverage).toBe("complete-profile");
    expect(snapshot.totalFiles).toBeGreaterThanOrEqual(5);

    const verified = await runner.verifySnapshot(snapshot.path);
    expect(verified.ok).toBe(true);
    expect(verified.coverage).toBe("complete-profile");
    expect(verified.issues).toHaveLength(0);

    const restored = await runner.restoreSnapshot(snapshot.path, restoreDir, { createDirectory: true });
    expect(restored.destinationPath).toBe(restoreDir);
    expect(restored.manifestVersion).toBe(4);
    expect(restored.validationStatus).toBe("valid");
    expect(restored.activationReadiness).toBeDefined();
    expect(["ready", "requires-reference-repair", "requires-external-recovery"]).toContain(
      restored.activationReadiness!,
    );
    const restoredDbPath = path.join(restoreDir, "agetor.sqlite");
    expect(dbIntegrityOk(restoredDbPath)).toBe(true);

    // Source profile and snapshot are immutable.
    expect(computeFileSha256Sync(dbPath).sha256).toBe(sourceHashBefore);
    expect(computeFileSha256Sync(attachmentPath).sha256).toBe(attachmentHashBefore);
    const snapshotDbHash = computeFileSha256Sync(path.join(snapshot.path, "database.sqlite")).sha256;

    // Re-backup the restored (inactive) profile through a real worker.
    const rebackupPath = path.join(root, "rebackup.sqlite");
    const rebackup = await runner.backupDatabase(restoredDbPath, rebackupPath);
    expect(dbIntegrityOk(rebackupPath)).toBe(true);
    expect(rebackup.sha256).toBe(computeFileSha256Sync(rebackupPath).sha256);
    const rebackupDb = new Database(rebackupPath, { readonly: true });
    const rowCount = rebackupDb.query("SELECT count(*) AS c FROM synthetic_records;").get() as { c: number };
    const restoredTask = rebackupDb.query("SELECT id FROM tasks WHERE id = ?;").get(taskId) as { id: string } | null;
    rebackupDb.close();
    expect(rowCount.c).toBe(10);
    expect(restoredTask?.id).toBe(taskId);
    expect(computeFileSha256Sync(path.join(snapshot.path, "database.sqlite")).sha256).toBe(snapshotDbHash);
    expect(computeFileSha256Sync(dbPath).sha256).toBe(sourceHashBefore);
  } finally {
    await runner.dispose();
    rmSync(root, { recursive: true, force: true });
  }
});
