/**
 * FO-P2-003-R9: Publication Outcome Integrity and Worker/Runner Error Consistency.
 *
 * Every publication/cancellation scenario uses a real OS child process and real
 * on-disk SQLite artifacts. The parent performs real isolated verification. A
 * synthetic worker that merely sends a preselected PUBLISHED_UNCONFIRMED error is
 * never accepted as proof of the N1/N2 invariants.
 */

import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

// Global isolation fixture for every runner child process.
const r9IsoRoot = mkdtempSync(path.join(tmpdir(), "fo-r9-test-iso-"));
const r9IsoData = path.join(r9IsoRoot, "data");
mkdirSync(r9IsoData, { recursive: true, mode: 0o700 });
process.env.FORGEORBIT_DATA_DIR = r9IsoData;
process.env.AGETOR_DATA_DIR = r9IsoData;

import {
  BackupProcessRunner,
  resolveWorkerScriptPath,
} from "./backup-runner.ts";
import { BackupRunnerError } from "./backup-runner-types.ts";
import {
  BackupCore,
  computeFileSha256Sync,
  readBackupPublicationReceipt,
  removeBackupPublicationReceipt,
  writeBackupPublicationReceipt,
} from "./backup-core.ts";
import {
  BackupManager,
  readSnapshotFormatMarker,
  verifyBackupSnapshot,
  type SnapshotManifest,
} from "./backup-manager.ts";
import { BackupRestore, RestoreError, restoreBackupSnapshot } from "./backup-restore.ts";
import { migrate } from "./migrate.ts";
import { migrations } from "./migrations/index.ts";

const REPO_ROOT = process.cwd();
const CORE_MODULE_PATH = path.join(REPO_ROOT, "src/bun/backup-core.ts");
const MANAGER_MODULE_PATH = path.join(REPO_ROOT, "src/bun/backup-manager.ts");
const RESTORE_MODULE_PATH = path.join(REPO_ROOT, "src/bun/backup-restore.ts");
const IPC_MODULE_PATH = path.join(REPO_ROOT, "src/bun/backup-ipc.ts");

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

function createLargeDb(dbPath: string, rowCount = 250_000): void {
  const db = new Database(dbPath);
  db.run("PRAGMA journal_mode = WAL;");
  db.run("PRAGMA synchronous = NORMAL;");
  db.run("PRAGMA busy_timeout = 10000;");
  migrate(db, migrations);
  db.run("CREATE TABLE IF NOT EXISTS synthetic_records (id INTEGER PRIMARY KEY, payload TEXT NOT NULL);");
  const insert = db.prepare("INSERT INTO synthetic_records (id, payload) VALUES (?, ?);");
  db.transaction(() => {
    const payload = "y".repeat(400);
    for (let i = 1; i <= rowCount; i++) {
      insert.run(i, `${payload}-${i}`);
    }
  })();
  db.close();
}

function createCanonicalProfileDb(dbPath: string): Database {
  const db = new Database(dbPath);
  db.run("PRAGMA journal_mode = WAL;");
  db.run("PRAGMA synchronous = NORMAL;");
  db.run("PRAGMA foreign_keys = ON;");
  db.run("PRAGMA busy_timeout = 10000;");
  migrate(db, migrations);
  return db;
}

function insertTestTask(
  db: Database,
  opts: {
    id: string;
    refs?: unknown[];
    attachments?: unknown[];
    draft?: unknown;
    backlog?: unknown[];
  },
): void {
  db.run(
    `INSERT INTO tasks (
      id, title, prompt, column, agent, workdir,
      refs, attachments, sent_files, draft, backlog,
      created_at, updated_at
    ) VALUES (?, ?, ?, 'backlog', 'claude-code', ?, ?, ?, NULL, ?, ?, 1000, 1000);`,
    [
      opts.id,
      `Task ${opts.id}`,
      `Prompt for ${opts.id}`,
      tmpdir(),
      JSON.stringify(opts.refs ?? []),
      JSON.stringify(opts.attachments ?? []),
      opts.draft ? JSON.stringify(opts.draft) : null,
      JSON.stringify(opts.backlog ?? []),
    ],
  );
}

function dbIntegrityOk(dbPath: string): boolean {
  try {
    const db = new Database(dbPath, { readonly: true });
    try {
      const row = db.query("PRAGMA integrity_check;").get() as Record<string, string>;
      return Object.values(row)[0] === "ok";
    } finally {
      db.close();
    }
  } catch {
    return false;
  }
}

async function waitForBarrier(barrierPath: string, timeoutMs = 15_000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (existsSync(barrierPath)) return true;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  return false;
}

async function waitUntilGone(check: () => boolean, timeoutMs = 3000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (check()) return true;
    await new Promise((resolve) => setTimeout(resolve, 10));
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

function writeWorker(root: string, name: string, source: string): string {
  const workerPath = path.join(root, name);
  writeFileSync(workerPath, source, { mode: 0o600 });
  return workerPath;
}

/** Corrupts the first 16 bytes while preserving the file length. */
function corruptSqliteSameSize(filePath: string): void {
  const bytes = readFileSync(filePath);
  if (bytes.length < 16) return;
  Buffer.alloc(16, 0x58).copy(bytes, 0);
  writeFileSync(filePath, bytes);
}

function readManifest(snapDir: string): SnapshotManifest {
  return JSON.parse(readFileSync(path.join(snapDir, "manifest.json"), "utf8")) as SnapshotManifest;
}

function writeManifest(snapDir: string, manifest: SnapshotManifest): void {
  writeFileSync(path.join(snapDir, "manifest.json"), JSON.stringify(manifest, null, 2));
}

async function createV4Snapshot(root: string): Promise<{
  sourceDb: string;
  snapshotDir: string;
  snapshotDbSha: string;
}> {
  const sourceDb = path.join(root, "source.sqlite");
  const knowledgeDir = path.join(root, "knowledge");
  const snapshotDir = path.join(root, "snapshot");
  createSyntheticDb(sourceDb, 10);
  mkdirSync(path.join(knowledgeDir, "bodies"), { recursive: true, mode: 0o700 });
  const db = new Database(sourceDb);
  try {
    const manager = new BackupManager({ db, knowledgeRootDir: knowledgeDir });
    await manager.createSnapshot({ destinationPath: snapshotDir, manifestVersion: 4 });
  } finally {
    db.close();
  }
  return {
    sourceDb,
    snapshotDir,
    snapshotDbSha: computeFileSha256Sync(path.join(snapshotDir, "database.sqlite")).sha256,
  };
}

// ── Real child worker sources ───────────────────────────────────────────────

type BackupBehavior = "success" | "exit" | "error";

function backupWorkerSource(opts: {
  dbPath: string;
  destPath: string;
  gate: string;
  receipt: boolean;
  publishedFrame?: boolean;
  corruptAfterPublish?: boolean;
  behavior: BackupBehavior;
  errorCode?: string;
  blockAfterPublishMs?: number;
  emitPublishingState?: boolean;
}): string {
  const afterPublish: string[] = [
    `writeFileSync(${JSON.stringify(opts.gate)}, "published");`,
  ];
  if (opts.publishedFrame) {
    afterPublish.push(
      `process.stdout.write(JSON.stringify({ type: "published", operationId: opId, targetPath: p, publishedAt: Date.now() }) + "\\n");`,
    );
  }
  if (opts.corruptAfterPublish) {
    afterPublish.push(`
      try {
        const bytes = readFileSync(p);
        if (bytes.length >= 16) { Buffer.alloc(16, 0x58).copy(bytes, 0); writeFileSync(p, bytes); }
      } catch {}`);
  }
  if (opts.behavior === "error") {
    afterPublish.push(`
      process.stdout.write(JSON.stringify({
        type: "error",
        operationId: opId,
        error: {
          code: ${JSON.stringify(opts.errorCode ?? "IO_ERROR")},
          message: "Simulated worker failure after publication",
          subsystem: "backup-core",
        },
      }) + "\\n");
      await new Promise((r) => setTimeout(r, 20));
      process.exit(1);`);
  } else if (opts.behavior === "exit") {
    afterPublish.push(`process.exit(0);`);
  } else if (opts.blockAfterPublishMs) {
    afterPublish.push(`await new Promise((r) => setTimeout(r, ${opts.blockAfterPublishMs}));`);
  }

  return `
    import { Database } from "bun:sqlite";
    import { readFileSync, writeFileSync } from "node:fs";
    import path from "node:path";
    import { createInterface } from "node:readline";
    import { BackupCore } from ${JSON.stringify(CORE_MODULE_PATH)};

    const rl = createInterface({ input: process.stdin });
    rl.on("line", async (line) => {
      const msg = JSON.parse(line);
      if (msg.type !== "start") return;
      const opId = msg.operation.operationId;
      const db = new Database(${JSON.stringify(opts.dbPath)}, { readonly: true });
      const core = new BackupCore(db);
      const res = await core.createBackup(${JSON.stringify(opts.destPath)}, {
        ${opts.receipt ? "runnerOperationId: opId," : ""}
        ${
          opts.emitPublishingState
            ? `afterVerify: async (tempPath) => {
          process.stdout.write(JSON.stringify({ type: "state", operationId: opId, state: "publishing", stagingDir: path.dirname(tempPath), progress: { phase: "publishing", timestamp: Date.now() } }) + "\\n");
        },`
            : ""
        }
        afterPublish: async (p) => {
          ${afterPublish.join("\n          ")}
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
      await new Promise((r) => setTimeout(r, 20));
      process.exit(0);
    });
  `;
}

/** Real backup without any receipt / published frame, then exits without a result. */
function backupNoIdentityThenExitSource(opts: { dbPath: string; destPath: string }): string {
  return `
    import { Database } from "bun:sqlite";
    import { createInterface } from "node:readline";
    import { BackupCore } from ${JSON.stringify(CORE_MODULE_PATH)};
    const rl = createInterface({ input: process.stdin });
    rl.on("line", async (line) => {
      const msg = JSON.parse(line);
      if (msg.type !== "start") return;
      const db = new Database(${JSON.stringify(opts.dbPath)}, { readonly: true });
      const core = new BackupCore(db);
      await core.createBackup(${JSON.stringify(opts.destPath)});
      process.exit(0);
    });
  `;
}

function prePublicationWorkerSource(opts: { gate: string; errorCode?: string }): string {
  return `
    import { writeFileSync } from "node:fs";
    import { createInterface } from "node:readline";
    const rl = createInterface({ input: process.stdin });
    rl.on("line", async (line) => {
      const msg = JSON.parse(line);
      if (msg.type !== "start") return;
      const opId = msg.operation.operationId;
      writeFileSync(${JSON.stringify(opts.gate)}, String(process.pid));
      ${
        opts.errorCode
          ? `process.stdout.write(JSON.stringify({ type: "error", operationId: opId, error: { code: ${JSON.stringify(opts.errorCode)}, message: "Simulated pre-publication failure", subsystem: "backup-core" } }) + "\\n"); await new Promise((r) => setTimeout(r, 20)); process.exit(1);`
          : `await new Promise((r) => setTimeout(r, 60_000)); process.exit(0);`
      }
    });
  `;
}

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

function restoreWorkerSource(opts: {
  corruptAfterRestore?: boolean;
  behavior: "success" | "exit" | "error";
  detailsError?: boolean;
}): string {
  const corrupt = opts.corruptAfterRestore
    ? `
      const dbPath = path.join(res.destinationPath, res.dbFilename);
      try {
        const bytes = readFileSync(dbPath);
        if (bytes.length >= 16) { Buffer.alloc(16, 0x58).copy(bytes, 0); writeFileSync(dbPath, bytes); }
      } catch {}`
    : "";

  const finish =
    opts.behavior === "exit"
      ? `process.exit(0);`
      : opts.behavior === "error" || opts.detailsError
        ? `
          const err = new RestoreError(
            "Restore published but verification failed",
            "PUBLISHED_UNCONFIRMED",
            undefined,
            {
              destinationPath: res.destinationPath,
              committedAt: "publication",
              destinationVerified: false,
              verificationFailed: true,
              causeCode: "VERIFICATION_FAILED",
              verificationIssues: ["synthetic integrity issue"],
            },
          );
          const { serializeBackupError } = await import(${JSON.stringify(IPC_MODULE_PATH)});
          process.stdout.write(JSON.stringify({ type: "error", operationId: opId, error: serializeBackupError(err, "backup-restore") }) + "\\n");
          await new Promise((r) => setTimeout(r, 20));
          process.exit(1);`
        : `
          process.stdout.write(JSON.stringify({
            type: "result",
            operationId: opId,
            result: {
              type: "restore-snapshot",
              operationId: opId,
              destinationPath: res.destinationPath,
              snapshotId: res.snapshotId,
              manifestVersion: res.manifestVersion,
              appVersion: res.appVersion,
              schemaVersion: res.schemaVersion,
              dbFilename: res.dbFilename,
              databaseBytes: res.databaseBytes,
              originalDatabaseSha256: res.originalDatabaseSha256,
              databaseSha256: res.databaseSha256,
              databaseTransformed: res.databaseTransformed,
              knowledgeDocumentCount: res.knowledgeDocumentCount,
              knowledgeRevisionCount: res.knowledgeRevisionCount,
              filesRestored: res.filesRestored,
              totalBytesRestored: res.totalBytesRestored,
              durationMs: res.durationMs,
            },
          }) + "\\n");
          await new Promise((r) => setTimeout(r, 20));
          process.exit(0);`;

  return `
    import { readFileSync, writeFileSync } from "node:fs";
    import path from "node:path";
    import { createInterface } from "node:readline";
    import { BackupRestore, RestoreError } from ${JSON.stringify(RESTORE_MODULE_PATH)};
    const rl = createInterface({ input: process.stdin });
    rl.on("line", async (line) => {
      const msg = JSON.parse(line);
      if (msg.type !== "start") return;
      const opId = msg.operation.operationId;
      const payload = msg.operation.payload;
      const restore = new BackupRestore();
      const res = await restore.restore(payload.snapshotPath, payload.destinationDir, {
        runnerOperationId: opId,
        createDirectory: true,
      });
      ${corrupt}
      ${finish}
    });
  `;
}

// ── 1. N2 — published backup corrupted, acknowledgment lost ─────────────────

test("R9-01: corrupted published backup without acknowledgment is PUBLISHED_UNCONFIRMED with destinationVerified:false", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "fo-r9-01-"));
  const dbPath = path.join(root, "source.sqlite");
  const destPath = path.join(root, "dest.sqlite");
  createSyntheticDb(dbPath, 12);
  const gate = path.join(root, "gate");
  const worker = writeWorker(
    root,
    "worker.ts",
    backupWorkerSource({
      dbPath,
      destPath,
      gate,
      receipt: true,
      publishedFrame: true,
      corruptAfterPublish: true,
      behavior: "exit",
    }),
  );
  const runner = new BackupProcessRunner({ workerScriptPath: worker });
  try {
    const promise = runner.backupDatabase(dbPath, destPath);
    let caught: BackupRunnerError | null = null;
    promise.catch((err) => {
      caught = err as BackupRunnerError;
    });
    expect(await waitForBarrier(gate)).toBe(true);
    const opId = runner.listOperations()[0]!.operationId;
    await promise.catch(() => {});

    expect(caught!.code).toBe("PUBLISHED_UNCONFIRMED");
    const details = caught!.details as Record<string, unknown>;
    expect(details.destinationVerified).toBe(false);
    expect(details.verificationFailed).toBe(true);
    expect(details.integrityOutcome).toBe("failed");
    expect(Array.isArray(details.verificationIssues)).toBe(true);
    expect((details.verificationIssues as string[]).length).toBeGreaterThan(0);
    expect(existsSync(destPath)).toBe(true);
    expect(dbIntegrityOk(destPath)).toBe(false);

    const history = runner.getOperationStatus(opId);
    expect(history?.state).toBe("failed");
    expect(history?.error?.code).toBe("PUBLISHED_UNCONFIRMED");
    expect((history?.error?.details as Record<string, unknown>)?.destinationVerified).toBe(false);
    expect((history?.error?.details as Record<string, unknown>)?.verificationFailed).toBe(true);
  } finally {
    await runner.dispose();
    rmSync(root, { recursive: true, force: true });
  }
});

// ── 2. Parent verifier failure with a success result (N1 backup analogue) ───

test("R9-02: worker success result followed by verifier ok:false preserves issues and never claims verified", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "fo-r9-02-"));
  const dbPath = path.join(root, "source.sqlite");
  const destPath = path.join(root, "dest.sqlite");
  createSyntheticDb(dbPath, 12);
  const gate = path.join(root, "gate");
  const worker = writeWorker(
    root,
    "worker.ts",
    backupWorkerSource({
      dbPath,
      destPath,
      gate,
      receipt: true,
      publishedFrame: true,
      corruptAfterPublish: true,
      behavior: "success",
    }),
  );
  const runner = new BackupProcessRunner({ workerScriptPath: worker });
  try {
    const promise = runner.backupDatabase(dbPath, destPath);
    let caught: BackupRunnerError | null = null;
    promise.catch((err) => {
      caught = err as BackupRunnerError;
    });
    expect(await waitForBarrier(gate)).toBe(true);
    await promise.catch(() => {});
    expect(caught!.code).toBe("PUBLISHED_UNCONFIRMED");
    expect(caught!.code).not.toBe("IO_ERROR");
    const details = caught!.details as Record<string, unknown>;
    expect(details.destinationVerified).toBe(false);
    expect(details.verificationFailed).toBe(true);
    expect((details.verificationIssues as string[]).length).toBeGreaterThan(0);
  } finally {
    await runner.dispose();
    rmSync(root, { recursive: true, force: true });
  }
});

// ── 3. N1 — supervised restore publishes, corrupts, sends success ───────────

test("R9-03: published restore corrupted after success is PUBLISHED_UNCONFIRMED, never IO_ERROR", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "fo-r9-03-"));
  const operationRoot = path.join(root, "op");
  mkdirSync(operationRoot, { recursive: true });
  const restoreDir = path.join(operationRoot, "restored");
  const { snapshotDir, snapshotDbSha } = await createV4Snapshot(root);
  const worker = writeWorker(
    root,
    "restore-worker.ts",
    restoreWorkerSource({ corruptAfterRestore: true, behavior: "success" }),
  );
  const runner = new BackupProcessRunner({ workerScriptPath: worker });
  try {
    let caught: BackupRunnerError | null = null;
    await runner
      .restoreSnapshot(snapshotDir, restoreDir, { createDirectory: true })
      .catch((err) => {
        caught = err as BackupRunnerError;
      });
    expect(caught).not.toBeNull();
    expect(caught!.code).toBe("PUBLISHED_UNCONFIRMED");
    expect(caught!.code).not.toBe("IO_ERROR");
    const details = caught!.details as Record<string, unknown>;
    expect(details.destinationVerified).toBe(false);
    expect(details.verificationFailed).toBe(true);
    expect(details.destinationPath).toBe(restoreDir);
    expect((details.verificationIssues as string[]).length).toBeGreaterThan(0);

    expect(existsSync(restoreDir)).toBe(true);
    expect(dbIntegrityOk(path.join(restoreDir, "agetor.sqlite"))).toBe(false);
    // Source snapshot is immutable.
    expect(computeFileSha256Sync(path.join(snapshotDir, "database.sqlite")).sha256).toBe(snapshotDbSha);
  } finally {
    await runner.dispose();
    rmSync(root, { recursive: true, force: true });
  }
});

// ── 4. Published restore, corrupt, no result ────────────────────────────────

test("R9-04: published restore corruption with lost acknowledgment is PUBLISHED_UNCONFIRMED", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "fo-r9-04-"));
  const operationRoot = path.join(root, "op");
  mkdirSync(operationRoot, { recursive: true });
  const restoreDir = path.join(operationRoot, "restored");
  const { snapshotDir } = await createV4Snapshot(root);
  const worker = writeWorker(
    root,
    "restore-worker.ts",
    restoreWorkerSource({ corruptAfterRestore: true, behavior: "exit" }),
  );
  const runner = new BackupProcessRunner({ workerScriptPath: worker });
  try {
    let caught: BackupRunnerError | null = null;
    await runner
      .restoreSnapshot(snapshotDir, restoreDir, { createDirectory: true })
      .catch((err) => {
        caught = err as BackupRunnerError;
      });
    expect(caught).not.toBeNull();
    expect(caught!.code).toBe("PUBLISHED_UNCONFIRMED");
    const details = caught!.details as Record<string, unknown>;
    expect(details.destinationVerified).toBe(false);
    expect(details.verificationFailed).toBe(true);
    expect(details.destinationPath).toBe(restoreDir);
    expect((details.verificationIssues as string[]).length).toBeGreaterThan(0);
    expect(existsSync(restoreDir)).toBe(true);
  } finally {
    await runner.dispose();
    rmSync(root, { recursive: true, force: true });
  }
});

// ── 5. N3 — valid publication then worker IO_ERROR ──────────────────────────

test("R9-05: valid published backup followed by worker IO_ERROR is PUBLISHED_UNCONFIRMED and verified", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "fo-r9-05-"));
  const dbPath = path.join(root, "source.sqlite");
  const destPath = path.join(root, "dest.sqlite");
  createSyntheticDb(dbPath, 12);
  const gate = path.join(root, "gate");
  const worker = writeWorker(
    root,
    "worker.ts",
    backupWorkerSource({
      dbPath,
      destPath,
      gate,
      receipt: false,
      publishedFrame: false,
      emitPublishingState: true,
      behavior: "error",
      errorCode: "IO_ERROR",
    }),
  );
  const runner = new BackupProcessRunner({ workerScriptPath: worker });
  try {
    const promise = runner.backupDatabase(dbPath, destPath);
    let caught: BackupRunnerError | null = null;
    promise.catch((err) => {
      caught = err as BackupRunnerError;
    });
    expect(await waitForBarrier(gate)).toBe(true);
    const opId = runner.listOperations()[0]!.operationId;
    await promise.catch(() => {});
    expect(caught!.code).toBe("PUBLISHED_UNCONFIRMED");
    const details = caught!.details as Record<string, unknown>;
    expect(details.destinationVerified).toBe(true);
    expect(details.verificationFailed).toBe(false);
    expect(details.causeCode).toBe("IO_ERROR");
    expect(dbIntegrityOk(destPath)).toBe(true);
    const history = runner.getOperationStatus(opId);
    expect(history?.error?.code).toBe("PUBLISHED_UNCONFIRMED");
    expect((history?.error?.details as Record<string, unknown>)?.destinationVerified).toBe(true);
  } finally {
    await runner.dispose();
    rmSync(root, { recursive: true, force: true });
  }
});

// ── 6. N3 — invalid publication then worker IO_ERROR ────────────────────────

test("R9-06: corrupted published backup followed by worker IO_ERROR keeps verification failure visible", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "fo-r9-06-"));
  const dbPath = path.join(root, "source.sqlite");
  const destPath = path.join(root, "dest.sqlite");
  createSyntheticDb(dbPath, 12);
  const gate = path.join(root, "gate");
  const worker = writeWorker(
    root,
    "worker.ts",
    backupWorkerSource({
      dbPath,
      destPath,
      gate,
      receipt: true,
      publishedFrame: true,
      corruptAfterPublish: true,
      behavior: "error",
      errorCode: "IO_ERROR",
    }),
  );
  const runner = new BackupProcessRunner({ workerScriptPath: worker });
  try {
    const promise = runner.backupDatabase(dbPath, destPath);
    let caught: BackupRunnerError | null = null;
    promise.catch((err) => {
      caught = err as BackupRunnerError;
    });
    expect(await waitForBarrier(gate)).toBe(true);
    await promise.catch(() => {});
    expect(caught!.code).toBe("PUBLISHED_UNCONFIRMED");
    const details = caught!.details as Record<string, unknown>;
    expect(details.destinationVerified).toBe(false);
    expect(details.verificationFailed).toBe(true);
    expect((details.verificationIssues as string[]).length).toBeGreaterThan(0);
    expect(details.causeCode).toBe("IO_ERROR");
  } finally {
    await runner.dispose();
    rmSync(root, { recursive: true, force: true });
  }
});

// ── 7. No publication then worker IO_ERROR ──────────────────────────────────

test("R9-07: worker IO_ERROR before publication remains a definitive IO_ERROR", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "fo-r9-07-"));
  const dbPath = path.join(root, "source.sqlite");
  const destPath = path.join(root, "dest.sqlite");
  createSyntheticDb(dbPath, 5);
  const gate = path.join(root, "gate");
  const worker = writeWorker(
    root,
    "worker.ts",
    prePublicationWorkerSource({ gate, errorCode: "IO_ERROR" }),
  );
  const runner = new BackupProcessRunner({ workerScriptPath: worker });
  try {
    const promise = runner.backupDatabase(dbPath, destPath);
    let caught: BackupRunnerError | null = null;
    promise.catch((err) => {
      caught = err as BackupRunnerError;
    });
    expect(await waitForBarrier(gate)).toBe(true);
    const opId = runner.listOperations()[0]!.operationId;
    await promise.catch(() => {});
    expect(caught!.code).toBe("IO_ERROR");
    expect(existsSync(destPath)).toBe(false);
    const history = runner.getOperationStatus(opId);
    expect(history?.state).toBe("failed");
    expect(history?.error?.code).toBe("IO_ERROR");
  } finally {
    await runner.dispose();
    rmSync(root, { recursive: true, force: true });
  }
});

// ── 8. Published artifact with no receipt and no staging identity ───────────

test("R9-08: published backup with no receipt and no identity evidence is INDETERMINATE, never adopted", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "fo-r9-08-"));
  const dbPath = path.join(root, "source.sqlite");
  const destPath = path.join(root, "dest.sqlite");
  createSyntheticDb(dbPath, 8);
  const worker = writeWorker(
    root,
    "worker.ts",
    backupNoIdentityThenExitSource({ dbPath, destPath }),
  );
  const runner = new BackupProcessRunner({ workerScriptPath: worker });
  try {
    let caught: BackupRunnerError | null = null;
    await runner.backupDatabase(dbPath, destPath).catch((err) => {
      caught = err as BackupRunnerError;
    });
    expect(caught).not.toBeNull();
    expect(caught!.code).toBe("INDETERMINATE");
    expect(existsSync(destPath)).toBe(true);
    expect(dbIntegrityOk(destPath)).toBe(true);
    const details = caught!.details as Record<string, unknown>;
    expect(details.destinationVerified).toBe(false);
    expect(details.publicationOutcome).toBe("unresolved");
  } finally {
    await runner.dispose();
    rmSync(root, { recursive: true, force: true });
  }
});

// ── 9. Mismatched receipt and unrelated pre-existing artifact ───────────────

test("R9-09: forged/mismatched receipt never authorizes adoption of a foreign artifact", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "fo-r9-09-"));
  const dbPath = path.join(root, "source.sqlite");
  const destPath = path.join(root, "dest.sqlite");
  const foreignPath = path.join(root, "foreign.sqlite");
  createSyntheticDb(dbPath, 5);
  createSyntheticDb(foreignPath, 7);
  const gate = path.join(root, "gate");
  const worker = writeWorker(
    root,
    "worker.ts",
    `
      import { writeFileSync } from "node:fs";
      import { createInterface } from "node:readline";
      import { writeBackupPublicationReceipt } from ${JSON.stringify(CORE_MODULE_PATH)};
      const rl = createInterface({ input: process.stdin });
      rl.on("line", async (line) => {
        const msg = JSON.parse(line);
        if (msg.type !== "start") return;
        const opId = msg.operation.operationId;
        writeFileSync(${JSON.stringify(destPath)}, "unrelated artifact payload");
        writeBackupPublicationReceipt({
          operationId: opId,
          targetPath: ${JSON.stringify(foreignPath)},
          sha256: "9".repeat(64),
          bytes: 7,
          pid: process.pid,
          publishedAt: Date.now(),
        });
        writeFileSync(${JSON.stringify(gate)}, "done");
        await new Promise((r) => setTimeout(r, 20));
        process.exit(0);
      });
    `,
  );
  const runner = new BackupProcessRunner({ workerScriptPath: worker });
  try {
    const promise = runner.backupDatabase(dbPath, destPath);
    let caught: BackupRunnerError | null = null;
    promise.catch((err) => {
      caught = err as BackupRunnerError;
    });
    expect(await waitForBarrier(gate)).toBe(true);
    await promise.catch(() => {});
    expect(caught!.code).toBe("INDETERMINATE");
    expect(readFileSync(destPath, "utf8")).toBe("unrelated artifact payload");
    removeBackupPublicationReceipt(runner.listOperations()[0]!.operationId);
  } finally {
    await runner.dispose();
    rmSync(root, { recursive: true, force: true });
  }
});

// ── 10. Exact verification issues preserved in caller and history ───────────

test("R9-10: bounded verification issues are identical in caller result and stored history", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "fo-r9-10-"));
  const dbPath = path.join(root, "source.sqlite");
  const destPath = path.join(root, "dest.sqlite");
  createSyntheticDb(dbPath, 9);
  const gate = path.join(root, "gate");
  const worker = writeWorker(
    root,
    "worker.ts",
    backupWorkerSource({
      dbPath,
      destPath,
      gate,
      receipt: true,
      corruptAfterPublish: true,
      behavior: "exit",
    }),
  );
  const runner = new BackupProcessRunner({ workerScriptPath: worker });
  try {
    const promise = runner.backupDatabase(dbPath, destPath);
    let caught: BackupRunnerError | null = null;
    promise.catch((err) => {
      caught = err as BackupRunnerError;
    });
    expect(await waitForBarrier(gate)).toBe(true);
    const opId = runner.listOperations()[0]!.operationId;
    await promise.catch(() => {});
    const callerIssues = (caught!.details as Record<string, unknown>).verificationIssues as string[];
    const historyIssues = (runner.getOperationStatus(opId)?.error?.details as Record<string, unknown>)
      ?.verificationIssues as string[];
    expect(callerIssues.length).toBeGreaterThan(0);
    expect(historyIssues).toEqual(callerIssues);
    expect(callerIssues.length).toBeLessThanOrEqual(20);
    expect(callerIssues.every((issue) => issue.length <= 500)).toBe(true);
  } finally {
    await runner.dispose();
    rmSync(root, { recursive: true, force: true });
  }
});

// ── 11. Interrupted verification is never successful verification ───────────

test("R9-11: interrupted verification is reported as unverified, never as verified or failed", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "fo-r9-11-"));
  const dbPath = path.join(root, "source.sqlite");
  const destPath = path.join(root, "dest.sqlite");
  createSyntheticDb(dbPath, 15);
  const publishedGate = path.join(root, "published.gate");
  const verifyGate = path.join(root, "verify.started");
  const mainWorker = writeWorker(
    root,
    "main-worker.ts",
    backupWorkerSource({
      dbPath,
      destPath,
      gate: publishedGate,
      receipt: true,
      publishedFrame: true,
      behavior: "success",
    }),
  );
  const slowVerify = writeWorker(
    root,
    "slow-verify.ts",
    slowVerificationWorkerSource({ startedGate: verifyGate, sleepMs: 8000 }),
  );
  const prev = process.env.FORGEORBIT_BACKUP_WORKER_PATH;
  process.env.FORGEORBIT_BACKUP_WORKER_PATH = slowVerify;
  const runner = new BackupProcessRunner({ workerScriptPath: mainWorker, disposeGraceMs: 2500 });
  let caught: BackupRunnerError | null = null;
  try {
    const promise = runner.backupDatabase(dbPath, destPath);
    promise.catch((err) => {
      caught = err as BackupRunnerError;
    });
    expect(await waitForBarrier(verifyGate, 20_000)).toBe(true);
    await runner.dispose();
    await promise.catch(() => {});
    expect(caught!.code).toBe("PUBLISHED_UNCONFIRMED");
    const details = caught!.details as Record<string, unknown>;
    expect(details.destinationVerified).toBe(false);
    expect(details.verificationFailed).toBe(false);
    expect(["interrupted", "not_verified"]).toContain(details.integrityOutcome as string);
    expect(existsSync(destPath)).toBe(true);
  } finally {
    if (prev === undefined) delete process.env.FORGEORBIT_BACKUP_WORKER_PATH;
    else process.env.FORGEORBIT_BACKUP_WORKER_PATH = prev;
    await runner.dispose();
    rmSync(root, { recursive: true, force: true });
  }
});

// ── 12. Real repository worker cooperative pre-publication cancellation ─────

test("R9-12: real backup-worker cooperative pre-publication cancellation settles cancelled/CANCELLED", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "fo-r9-12-"));
  const dbPath = path.join(root, "source.sqlite");
  const destPath = path.join(root, "dest.sqlite");
  createLargeDb(dbPath, 120_000);
  const runner = new BackupProcessRunner({ workerScriptPath: resolveWorkerScriptPath() });
  try {
    let sawRunning = false;
    const promise = runner.backupDatabase(dbPath, destPath);
    let caught: BackupRunnerError | null = null;
    promise.catch((err) => {
      caught = err as BackupRunnerError;
    });
    const opId = runner.listOperations()[0]!.operationId;
    for (let i = 0; i < 500 && !sawRunning; i++) {
      const status = runner.getOperationStatus(opId);
      if (status?.state === "running" || status?.state === "verifying" || status?.state === "publishing") {
        sawRunning = true;
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, 2));
    }
    expect(sawRunning).toBe(true);
    const res = await runner.requestCancellation(opId);
    await promise.catch(() => {});
    expect(res.cancelled).toBe(true);
    expect(["cancelled_before_publication", "cancelled_before_execution"]).toContain(res.outcome);
    expect((caught as BackupRunnerError | null)?.code).toBe("CANCELLED");
    expect(existsSync(destPath)).toBe(false);
    const history = runner.getOperationStatus(opId);
    expect(history?.state).toBe("cancelled");
    expect(history?.error?.code).toBe("CANCELLED");
  } finally {
    await runner.dispose();
    rmSync(root, { recursive: true, force: true });
  }
});

// ── 13. Queued cancellation ─────────────────────────────────────────────────

test("R9-13: queued cancellation is cancelled_before_execution with matching history", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "fo-r9-13-"));
  const dbPath = path.join(root, "source.sqlite");
  createSyntheticDb(dbPath, 5);
  const gate = path.join(root, "gate");
  const worker = writeWorker(root, "worker.ts", prePublicationWorkerSource({ gate }));
  const runner = new BackupProcessRunner({ maxConcurrency: 1, workerScriptPath: worker });
  try {
    const first = runner.backupDatabase(dbPath, path.join(root, "d1.sqlite"));
    const second = runner.backupDatabase(dbPath, path.join(root, "d2.sqlite"));
    first.catch(() => {});
    second.catch(() => {});
    expect(await waitForBarrier(gate)).toBe(true);
    const queued = runner.listOperations().find((op) => op.state === "queued");
    expect(queued).toBeDefined();
    const res = await runner.requestCancellation(queued!.operationId);
    expect(res.outcome).toBe("cancelled_before_execution");
    expect(res.cancelled).toBe(true);
    await expect(second).rejects.toMatchObject({ code: "CANCELLED" });
    const history = runner.getOperationStatus(queued!.operationId);
    expect(history?.state).toBe("cancelled");
    expect(history?.error?.code).toBe("CANCELLED");
  } finally {
    await runner.dispose();
    rmSync(root, { recursive: true, force: true });
  }
});

// ── 14. Cancellation after publication ──────────────────────────────────────

test("R9-14: cancellation after publication is refused and the artifact remains unconfirmed", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "fo-r9-14-"));
  const dbPath = path.join(root, "source.sqlite");
  const destPath = path.join(root, "dest.sqlite");
  createSyntheticDb(dbPath, 10);
  const gate = path.join(root, "gate");
  const worker = writeWorker(
    root,
    "worker.ts",
    backupWorkerSource({
      dbPath,
      destPath,
      gate,
      receipt: true,
      publishedFrame: true,
      behavior: "success",
      blockAfterPublishMs: 60_000,
    }),
  );
  const runner = new BackupProcessRunner({ workerScriptPath: worker, disposeGraceMs: 2000 });
  try {
    const promise = runner.backupDatabase(dbPath, destPath);
    let caught: BackupRunnerError | null = null;
    promise.catch((err) => {
      caught = err as BackupRunnerError;
    });
    expect(await waitForBarrier(gate)).toBe(true);
    const opId = runner.listOperations()[0]!.operationId;
    const res = await runner.requestCancellation(opId);
    expect(res.outcome).toBe("publication_committed");
    expect(res.cancelled).toBe(false);
    await runner.dispose();
    await promise.catch(() => {});
    expect(caught!.code).toBe("PUBLISHED_UNCONFIRMED");
    const history = runner.getOperationStatus(opId);
    expect(history?.state).toBe("failed");
    expect(history?.error?.code).toBe("PUBLISHED_UNCONFIRMED");
  } finally {
    await runner.dispose();
    rmSync(root, { recursive: true, force: true });
  }
});

// ── 15. Failed operation queried for cancellation ───────────────────────────

test("R9-15: a failed operation is classified already_failed, never already_completed", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "fo-r9-15-"));
  const dbPath = path.join(root, "source.sqlite");
  createSyntheticDb(dbPath, 5);
  const gate = path.join(root, "gate");
  const worker = writeWorker(
    root,
    "worker.ts",
    prePublicationWorkerSource({ gate, errorCode: "IO_ERROR" }),
  );
  const runner = new BackupProcessRunner({ workerScriptPath: worker });
  try {
    const promise = runner.backupDatabase(dbPath, path.join(root, "dest.sqlite"));
    let caught: BackupRunnerError | null = null;
    promise.catch((err) => {
      caught = err as BackupRunnerError;
    });
    expect(await waitForBarrier(gate)).toBe(true);
    const opId = runner.listOperations()[0]!.operationId;
    await promise.catch(() => {});
    expect(caught!.code).toBe("IO_ERROR");
    const res = await runner.requestCancellation(opId);
    expect(res.outcome).toBe("already_failed");
    expect(res.outcome).not.toBe("already_completed");
    expect(res.cancelled).toBe(false);
  } finally {
    await runner.dispose();
    rmSync(root, { recursive: true, force: true });
  }
});

// ── 16. Pre-existing destination remains TARGET_EXISTS ──────────────────────

test("R9-16: pre-existing destination returns TARGET_EXISTS and is left untouched", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "fo-r9-16-"));
  const dbPath = path.join(root, "source.sqlite");
  const destPath = path.join(root, "dest.sqlite");
  createSyntheticDb(dbPath, 5);
  writeFileSync(destPath, "user-owned pre-existing bytes");
  const runner = new BackupProcessRunner({ workerScriptPath: resolveWorkerScriptPath() });
  try {
    let caught: BackupRunnerError | null = null;
    await runner.backupDatabase(dbPath, destPath).catch((err) => {
      caught = err as BackupRunnerError;
    });
    expect(caught).not.toBeNull();
    expect(caught!.code).toBe("TARGET_EXISTS");
    expect(readFileSync(destPath, "utf8")).toBe("user-owned pre-existing bytes");
  } finally {
    await runner.dispose();
    rmSync(root, { recursive: true, force: true });
  }
});

// ── 17. Structured worker error details round-trip through IPC ──────────────

test("R9-17: structured worker error details round-trip through the real IPC boundary", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "fo-r9-17-"));
  const dbPath = path.join(root, "source.sqlite");
  const destPath = path.join(root, "dest.sqlite");
  createSyntheticDb(dbPath, 5);
  const gate = path.join(root, "gate");
  const issues = [
    "database disk image is malformed",
    "page 2: invalid page header",
    "foreign key violation tasks.refs",
  ];
  const worker = writeWorker(
    root,
    "worker.ts",
    `
      import { writeFileSync } from "node:fs";
      import { createInterface } from "node:readline";
      import { serializeBackupError } from ${JSON.stringify(IPC_MODULE_PATH)};
      import { RestoreError } from ${JSON.stringify(RESTORE_MODULE_PATH)};
      const rl = createInterface({ input: process.stdin });
      rl.on("line", async (line) => {
        const msg = JSON.parse(line);
        if (msg.type !== "start") return;
        const opId = msg.operation.operationId;
        writeFileSync(${JSON.stringify(gate)}, "sent");
        const err = new RestoreError(
          "Published restore failed independent verification",
          "PUBLISHED_UNCONFIRMED",
          undefined,
          {
            destinationPath: ${JSON.stringify(destPath)},
            committedAt: "publication",
            destinationVerified: false,
            verificationFailed: true,
            causeCode: "VERIFICATION_FAILED",
            verificationIssues: ${JSON.stringify(issues)},
          },
        );
        process.stdout.write(JSON.stringify({ type: "error", operationId: opId, error: serializeBackupError(err, "backup-restore") }) + "\\n");
        await new Promise((r) => setTimeout(r, 20));
        process.exit(1);
      });
    `,
  );
  const runner = new BackupProcessRunner({ workerScriptPath: worker });
  try {
    const promise = runner.backupDatabase(dbPath, destPath);
    let caught: BackupRunnerError | null = null;
    promise.catch((err) => {
      caught = err as BackupRunnerError;
    });
    expect(await waitForBarrier(gate)).toBe(true);
    const opId = runner.listOperations()[0]!.operationId;
    await promise.catch(() => {});
    expect(caught!.code).toBe("PUBLISHED_UNCONFIRMED");
    const details = caught!.details as Record<string, unknown>;
    expect(details.destinationPath).toBe(destPath);
    expect(details.verificationFailed).toBe(true);
    expect(details.destinationVerified).toBe(false);
    expect(details.causeCode).toBe("VERIFICATION_FAILED");
    expect(details.verificationIssues).toEqual(issues);
    const history = runner.getOperationStatus(opId);
    expect((history?.error?.details as Record<string, unknown>)?.verificationIssues).toEqual(issues);
  } finally {
    await runner.dispose();
    rmSync(root, { recursive: true, force: true });
  }
});

// ── 18. Oversized / malformed IPC details are bounded or rejected ───────────

test("R9-18: oversized and malformed IPC error details are bounded safely", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "fo-r9-18-"));
  const dbPath = path.join(root, "source.sqlite");
  createSyntheticDb(dbPath, 5);
  const hugePath = `/${"p".repeat(5000)}/dest.sqlite`;
  const hugeIssues = Array.from({ length: 100 }, (_, i) => `issue-${i}-${"i".repeat(5000)}`);
  const gate = path.join(root, "gate");
  const oversizedWorker = writeWorker(
    root,
    "oversized.ts",
    `
      import { writeFileSync } from "node:fs";
      import { createInterface } from "node:readline";
      import { serializeBackupError } from ${JSON.stringify(IPC_MODULE_PATH)};
      import { RestoreError } from ${JSON.stringify(RESTORE_MODULE_PATH)};
      const rl = createInterface({ input: process.stdin });
      rl.on("line", async (line) => {
        const msg = JSON.parse(line);
        if (msg.type !== "start") return;
        const opId = msg.operation.operationId;
        writeFileSync(${JSON.stringify(gate)}, "sent");
        const err = new RestoreError(
          "token=super-secret ${"m".repeat(8000)}",
          "PUBLISHED_UNCONFIRMED",
          undefined,
          {
            destinationPath: ${JSON.stringify(hugePath)},
            verificationFailed: true,
            verificationIssues: ${JSON.stringify(hugeIssues)},
            secretIgnored: "anything",
          },
        );
        process.stdout.write(JSON.stringify({ type: "error", operationId: opId, error: serializeBackupError(err, "backup-restore") }) + "\\n");
        await new Promise((r) => setTimeout(r, 20));
        process.exit(1);
      });
    `,
  );
  const runner = new BackupProcessRunner({ workerScriptPath: oversizedWorker });
  try {
    let caught: BackupRunnerError | null = null;
    await runner
      .backupDatabase(dbPath, path.join(root, "dest.sqlite"))
      .catch((err) => {
        caught = err as BackupRunnerError;
      });
    expect(caught).not.toBeNull();
    expect(caught!.code).toBe("PUBLISHED_UNCONFIRMED");
    expect(caught!.message.length).toBeLessThanOrEqual(2000);
    const details = caught!.details as Record<string, unknown>;
    expect((details.destinationPath as string).length).toBeLessThanOrEqual(1024);
    const issues = details.verificationIssues as string[];
    expect(issues.length).toBeLessThanOrEqual(20);
    expect(issues.every((issue) => issue.length <= 500)).toBe(true);
    expect(details.secretIgnored).toBeUndefined();
  } finally {
    await runner.dispose();
  }

  const malformedGate = path.join(root, "malformed.gate");
  const malformedWorker = writeWorker(
    root,
    "malformed.ts",
    `
      import { writeFileSync } from "node:fs";
      import { createInterface } from "node:readline";
      const rl = createInterface({ input: process.stdin });
      rl.on("line", async (line) => {
        const msg = JSON.parse(line);
        if (msg.type !== "start") return;
        const opId = msg.operation.operationId;
        writeFileSync(${JSON.stringify(malformedGate)}, "sent");
        process.stdout.write(JSON.stringify({
          type: "error",
          operationId: opId,
          error: {
            code: "IO_ERROR",
            message: "Malformed details",
            details: {
              destinationPath: 42,
              verificationFailed: "yes",
              verificationIssues: "not-an-array",
              targetPath: { nested: true },
            },
          },
        }) + "\\n");
        await new Promise((r) => setTimeout(r, 20));
        process.exit(1);
      });
    `,
  );
  const runner2 = new BackupProcessRunner({ workerScriptPath: malformedWorker });
  try {
    const promise = runner2.backupDatabase(dbPath, path.join(root, "dest2.sqlite"));
    let caught: BackupRunnerError | null = null;
    promise.catch((err) => {
      caught = err as BackupRunnerError;
    });
    expect(await waitForBarrier(malformedGate)).toBe(true);
    await promise.catch(() => {});
    expect(caught!.code).toBe("IO_ERROR");
    expect(caught!.details).toBeUndefined();
  } finally {
    await runner2.dispose();
    rmSync(root, { recursive: true, force: true });
  }
});

// ── 19. Direct restore post-publication verification failure ─────────────────

test("R9-19: direct restore post-publication verification failure preserves destination identity", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "fo-r9-19-"));
  const restoreDir = path.join(root, "restored");
  try {
    const { snapshotDir } = await createV4Snapshot(root);
    const restore = new BackupRestore();
    let caught: RestoreError | null = null;
    try {
      await restore.restore(snapshotDir, restoreDir, {
        afterPublish: (publishedPath) => {
          corruptSqliteSameSize(path.join(publishedPath, "agetor.sqlite"));
        },
      });
    } catch (err) {
      caught = err as RestoreError;
    }
    expect(caught).toBeInstanceOf(RestoreError);
    expect(caught!.code).toBe("PUBLISHED_UNCONFIRMED");
    const details = caught!.details as Record<string, unknown>;
    expect(details.destinationPath).toBe(restoreDir);
    expect(details.destinationVerified).toBe(false);
    expect(details.verificationFailed).toBe(true);
    expect(Array.isArray(details.verificationIssues)).toBe(true);
    expect((details.verificationIssues as string[]).length).toBeGreaterThan(0);
    expect(existsSync(restoreDir)).toBe(true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// ── 20. Supervised restore with post-publication worker error ───────────────

test("R9-20: supervised restore with post-publication error preserves verification failure", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "fo-r9-20-"));
  const operationRoot = path.join(root, "op");
  mkdirSync(operationRoot, { recursive: true });
  const restoreDir = path.join(operationRoot, "restored");
  const { snapshotDir } = await createV4Snapshot(root);
  const worker = writeWorker(
    root,
    "restore-worker.ts",
    restoreWorkerSource({
      corruptAfterRestore: true,
      behavior: "error",
      detailsError: true,
    }),
  );
  const runner = new BackupProcessRunner({ workerScriptPath: worker });
  try {
    let caught: BackupRunnerError | null = null;
    await runner
      .restoreSnapshot(snapshotDir, restoreDir, { createDirectory: true })
      .catch((err) => {
        caught = err as BackupRunnerError;
      });
    expect(caught).not.toBeNull();
    expect(caught!.code).toBe("PUBLISHED_UNCONFIRMED");
    const details = caught!.details as Record<string, unknown>;
    expect(details.destinationVerified).toBe(false);
    expect(details.verificationFailed).toBe(true);
    expect(details.destinationPath).toBe(restoreDir);
    expect((details.verificationIssues as string[]).length).toBeGreaterThan(0);
    expect(existsSync(restoreDir)).toBe(true);
  } finally {
    await runner.dispose();
    rmSync(root, { recursive: true, force: true });
  }
});

// ── 21. No late terminal-state overwrite after settlement ───────────────────

test("R9-21: disposal cannot overwrite an already-settled completed result", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "fo-r9-21-"));
  const dbPath = path.join(root, "source.sqlite");
  const destPath = path.join(root, "dest.sqlite");
  createSyntheticDb(dbPath, 7);
  const runner = new BackupProcessRunner({ workerScriptPath: resolveWorkerScriptPath() });
  try {
    const result = await runner.backupDatabase(dbPath, destPath);
    expect(result.sha256.length).toBe(64);
    const opId = runner.listOperations()[0]!.operationId;
    const settled = runner.getOperationStatus(opId);
    expect(settled?.state).toBe("completed");
    await runner.dispose();
    const after = runner.getOperationStatus(opId);
    expect(after?.state).toBe("completed");
    expect(after?.error).toBeUndefined();
    expect(dbIntegrityOk(destPath)).toBe(true);
  } finally {
    await runner.dispose();
    rmSync(root, { recursive: true, force: true });
  }
});

// ── 22. Dispose during real delayed verification (R8B deadline) ─────────────

test("R9-22: dispose during real delayed verification stays bounded and leaves no orphan", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "fo-r9-22-"));
  const dbPath = path.join(root, "source.sqlite");
  const destPath = path.join(root, "dest.sqlite");
  createSyntheticDb(dbPath, 15);
  const publishedGate = path.join(root, "published.gate");
  const verifyGate = path.join(root, "verify.started");
  const mainWorker = writeWorker(
    root,
    "main-worker.ts",
    backupWorkerSource({
      dbPath,
      destPath,
      gate: publishedGate,
      receipt: true,
      publishedFrame: true,
      behavior: "success",
    }),
  );
  const slowVerify = writeWorker(
    root,
    "slow-verify.ts",
    slowVerificationWorkerSource({ startedGate: verifyGate, sleepMs: 8000 }),
  );
  const prev = process.env.FORGEORBIT_BACKUP_WORKER_PATH;
  process.env.FORGEORBIT_BACKUP_WORKER_PATH = slowVerify;
  const runner = new BackupProcessRunner({ workerScriptPath: mainWorker, disposeGraceMs: 4000 });
  let caught: BackupRunnerError | null = null;
  let verifyPid = -1;
  try {
    const promise = runner.backupDatabase(dbPath, destPath);
    promise.catch((err) => {
      caught = err as BackupRunnerError;
    });
    expect(await waitForBarrier(verifyGate, 20_000)).toBe(true);
    verifyPid = Number(readFileSync(verifyGate, "utf8"));
    expect(verifyPid).toBeGreaterThan(0);
    const startedAt = performance.now();
    await runner.dispose();
    const elapsed = performance.now() - startedAt;
    await promise.catch(() => {});
    expect(elapsed).toBeLessThan(4000 + 1200);
    expect(caught!.code).toBe("PUBLISHED_UNCONFIRMED");
    const details = caught!.details as Record<string, unknown>;
    expect(details.destinationVerified).toBe(false);
    expect(dbIntegrityOk(destPath)).toBe(true);
    expect(await waitUntilGone(() => !pidAlive(verifyPid), 3000)).toBe(true);
  } finally {
    if (prev === undefined) delete process.env.FORGEORBIT_BACKUP_WORKER_PATH;
    else process.env.FORGEORBIT_BACKUP_WORKER_PATH = prev;
    await runner.dispose();
    rmSync(root, { recursive: true, force: true });
  }
});

// ── 23. R8A Manifest v4/v3 downgrade security regression ────────────────────

test("R9-23: manifest v4-to-v3 downgrade is rejected and the source snapshot is unchanged", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "fo-r9-23-"));
  try {
    const { snapshotDir, snapshotDbSha } = await createV4Snapshot(root);
    expect(readSnapshotFormatMarker(path.join(snapshotDir, "database.sqlite"))).toBe(4);
    const manifest = readManifest(snapshotDir);
    manifest.manifestVersion = 3;
    writeManifest(snapshotDir, manifest);

    const ver = await verifyBackupSnapshot(snapshotDir);
    expect(ver.ok).toBe(false);
    expect(ver.issues.some((issue) => issue.includes("conflicts with manifest version"))).toBe(true);
    await expect(
      restoreBackupSnapshot(snapshotDir, path.join(root, "restored")),
    ).rejects.toThrow(/SNAPSHOT_VERIFICATION_FAILED|conflicts with manifest version/i);
    expect(computeFileSha256Sync(path.join(snapshotDir, "database.sqlite")).sha256).toBe(snapshotDbSha);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// ── 24. Draft/backlog and cross-profile references ──────────────────────────

test("R9-24: draft/backlog references and cross-profile dependencies keep their R8A semantics", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "fo-r9-24-"));
  try {
    // Draft/backlog coverage.
    const profileDir = path.join(root, "profile");
    mkdirSync(path.join(profileDir, "attachments"), { recursive: true });
    const a1 = path.join(profileDir, "attachments", "a1.txt");
    const a2 = path.join(profileDir, "attachments", "a2.txt");
    writeFileSync(a1, "a1", { mode: 0o600 });
    writeFileSync(a2, "a2", { mode: 0o600 });
    const profileDb = createCanonicalProfileDb(path.join(profileDir, "agetor.sqlite"));
    insertTestTask(profileDb, {
      id: "t24",
      attachments: [a1],
      draft: { text: "D", references: [{ path: a2 }] },
      backlog: [{ id: "m1", text: "B", references: [{ path: a1 }], createdAt: 100 }],
    });
    profileDb.close();

    const readDb = new Database(path.join(profileDir, "agetor.sqlite"), { readonly: true });
    const manager = new BackupManager({ db: readDb, dataDir: profileDir });
    const snapDir = path.join(root, "snap-24");
    const snap = await manager.createSnapshot({ destinationPath: snapDir, manifestVersion: 4 });
    readDb.close();
    expect(snap.manifest.internalReferences?.length).toBe(3);
    const restored = path.join(root, "restored-24");
    const res = await restoreBackupSnapshot(snapDir, restored);
    expect(res.activationReadiness).toBe("ready");
    expect(res.internalReferencesRebound).toBe(3);

    // Cross-profile dependency: foreign profile exists, must require recovery
    // and must never be rewritten.
    const profileB = path.join(root, "profile-b");
    mkdirSync(path.join(profileB, "attachments"), { recursive: true });
    const bAtt = path.join(profileB, "attachments", "b.txt");
    writeFileSync(bAtt, "b", { mode: 0o600 });
    createCanonicalProfileDb(path.join(profileB, "agetor.sqlite")).close();

    const profileA = path.join(root, "profile-a");
    mkdirSync(profileA, { recursive: true });
    const dbA = createCanonicalProfileDb(path.join(profileA, "agetor.sqlite"));
    insertTestTask(dbA, { id: "t24b", refs: [{ path: bAtt }] });
    dbA.close();
    const readA = new Database(path.join(profileA, "agetor.sqlite"), { readonly: true });
    const managerA = new BackupManager({ db: readA, dataDir: profileA });
    const snapA = path.join(root, "snap-24b");
    await managerA.createSnapshot({ destinationPath: snapA, manifestVersion: 4 });
    readA.close();

    const restoredA = path.join(root, "restored-24b");
    const resA = await restoreBackupSnapshot(snapA, restoredA);
    expect(resA.unresolvedCrossProfileReferences ?? 0).toBeGreaterThan(0);
    expect(resA.activationReadiness).toBe("requires-external-recovery");
    const destDb = new Database(path.join(restoredA, "agetor.sqlite"), { readonly: true });
    try {
      const row = destDb
        .query("SELECT refs FROM tasks WHERE id = 't24b';")
        .get() as { refs: string };
      expect(JSON.parse(row.refs)[0].path).toBe(bAtt);
    } finally {
      destDb.close();
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// ── 25. Offline snapshot verification and inactive restore round trip ───────

test("R9-25: offline v4 verification and inactive restore round-trip", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "fo-r9-25-"));
  try {
    const { snapshotDir, sourceDb } = await createV4Snapshot(root);
    const ver = await verifyBackupSnapshot(snapshotDir);
    expect(ver.ok).toBe(true);
    expect(ver.manifestVersion).toBe(4);

    const restoreDir = path.join(root, "restored");
    const res = await restoreBackupSnapshot(snapshotDir, restoreDir);
    expect(res.activationReadiness).toBe("ready");
    expect(existsSync(path.join(restoreDir, "agetor.sqlite"))).toBe(true);
    expect(dbIntegrityOk(path.join(restoreDir, "agetor.sqlite"))).toBe(true);

    // Source profile database is never mutated by snapshot/restore.
    expect(dbIntegrityOk(sourceDb)).toBe(true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
