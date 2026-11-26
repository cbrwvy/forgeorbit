/**
 * FO-P2-004-R1 / F1: destination reservation lifecycle.
 *
 * These are real-process, real-filesystem regression tests for the
 * DESTINATION_COLLISION leak: an auto-named snapshot reports a generated child
 * path but must release the destination PARENT reservation it acquired.
 */

import { afterAll, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const ORIGINAL_ENV = {
  HOME: process.env.HOME,
  TMPDIR: process.env.TMPDIR,
  FORGEORBIT_DATA_DIR: process.env.FORGEORBIT_DATA_DIR,
  AGETOR_DATA_DIR: process.env.AGETOR_DATA_DIR,
};
const ROOT = mkdtempSync(path.join(tmpdir(), "fo-r1-f1-"));
const HOME = path.join(ROOT, "home");
const DATA = path.join(ROOT, "profile");
const DEST = path.join(ROOT, "backups");
const WORK = path.join(ROOT, "work");
for (const dir of [HOME, DATA, DEST, WORK, path.join(ROOT, "tmp")]) {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
}
process.env.HOME = HOME;
process.env.TMPDIR = path.join(ROOT, "tmp");
process.env.FORGEORBIT_DATA_DIR = DATA;
process.env.AGETOR_DATA_DIR = DATA;

const REPO = process.cwd();
const { migrate } = await import("./migrate.ts");
const { migrations } = await import("./migrations/index.ts");
const { BackupProcessRunner } = await import("./backup-runner.ts");
const { BackupRunnerError } = await import("./backup-runner-types.ts");

function createSyntheticDb(dbPath: string, rowCount = 20): void {
  const db = new Database(dbPath);
  db.run("PRAGMA journal_mode = WAL;");
  db.run("PRAGMA foreign_keys = ON;");
  migrate(db, migrations);
  db.run("CREATE TABLE IF NOT EXISTS synthetic_records (id INTEGER PRIMARY KEY, payload TEXT NOT NULL);");
  const insert = db.prepare("INSERT INTO synthetic_records (payload) VALUES (?)");
  db.transaction(() => {
    for (let i = 0; i < rowCount; i++) insert.run(`payload-${i}`);
  })();
  db.close();
}

function snapshotOptions() {
  return {
    dataDir: DATA,
    knowledgeRootDir: path.join(DATA, "knowledge"),
    attachmentsRootDir: path.join(DATA, "attachments"),
    screenshotsRootDir: path.join(DATA, "screenshots"),
    issueThreadsRootDir: path.join(DATA, "issue-threads"),
    pipelineRunsRootDir: path.join(DATA, "pipeline-runs"),
    manifestVersion: 4 as const,
    createDirectory: true,
  };
}

function sha256(filePath: string): string {
  return createHash("sha256").update(readFileSync(filePath)).digest("hex");
}

for (const category of ["knowledge", "attachments", "screenshots", "issue-threads", "pipeline-runs"]) {
  mkdirSync(path.join(DATA, category), { recursive: true, mode: 0o700 });
}
const dbPath = path.join(DATA, "agetor.sqlite");
createSyntheticDb(dbPath);

test("F1: three sequential auto-named snapshots into one parent succeed on one long-lived runner", async () => {
  const runner = new BackupProcessRunner({ maxConcurrency: 1 });
  try {
    const paths: string[] = [];
    for (let i = 0; i < 3; i++) {
      const result = await runner.createSnapshot(dbPath, DEST, snapshotOptions());
      paths.push(result.path);
    }
    expect(new Set(paths).size).toBe(3);
    for (const snapshotPath of paths) {
      expect(existsSync(path.join(snapshotPath, "manifest.json"))).toBe(true);
      expect(existsSync(path.join(snapshotPath, "database.sqlite"))).toBe(true);
    }
    // Exactly the three published snapshots, no leaked staging directories.
    expect(readdirSync(DEST).filter((entry) => !entry.startsWith(".")).sort()).toEqual(
      paths.map((entry) => path.basename(entry)).sort(),
    );

    // The first snapshot is untouched by later publications.
    const firstDb = path.join(paths[0]!, "database.sqlite");
    const firstManifest = path.join(paths[0]!, "manifest.json");
    const beforeDb = sha256(firstDb);
    const beforeManifest = sha256(firstManifest);
    const fourth = await runner.createSnapshot(dbPath, DEST, snapshotOptions());
    expect(fourth.path).not.toBe(paths[0]);
    expect(sha256(firstDb)).toBe(beforeDb);
    expect(sha256(firstManifest)).toBe(beforeManifest);
  } finally {
    await runner.dispose();
  }
}, 120_000);

test("F1: a concurrent operation against the same parent is still rejected", async () => {
  const runner = new BackupProcessRunner({ maxConcurrency: 1 });
  try {
    const first = runner.createSnapshot(dbPath, DEST, snapshotOptions());
    let collision: unknown = null;
    try {
      await runner.createSnapshot(dbPath, DEST, snapshotOptions());
    } catch (err) {
      collision = err;
    }
    expect(collision).toBeInstanceOf(BackupRunnerError);
    expect((collision as InstanceType<typeof BackupRunnerError>).code).toBe("DESTINATION_COLLISION");
    await first;
    // And the successful first operation released the parent for the next one.
    await runner.createSnapshot(dbPath, DEST, snapshotOptions());
  } finally {
    await runner.dispose();
  }
}, 120_000);

test("F1: a failed operation does not leave a stale parent reservation", async () => {
  const runner = new BackupProcessRunner({ maxConcurrency: 1 });
  try {
    const missingDb = path.join(ROOT, "does-not-exist.sqlite");
    let failed = false;
    try {
      await runner.createSnapshot(missingDb, DEST, snapshotOptions());
    } catch {
      failed = true;
    }
    expect(failed).toBe(true);
    const recovered = await runner.createSnapshot(dbPath, DEST, snapshotOptions());
    expect(existsSync(recovered.path)).toBe(true);
  } finally {
    await runner.dispose();
  }
}, 120_000);

test("F1: cancellation does not leave a stale reservation (real child process)", async () => {
  // A deliberate hang worker occupies the single concurrency slot so the
  // cancellation path under test is deterministic. The reservation logic is
  // the runner's; the child process is real.
  const hangWorker = path.join(WORK, "hang-worker.ts");
  writeFileSync(
    hangWorker,
    `
    import { createInterface } from "node:readline";
    const rl = createInterface({ input: process.stdin });
    rl.on("line", (line) => {
      const msg = JSON.parse(line);
      if (msg.type === "start") {
        setInterval(() => {}, 1000);
      }
    });
    `,
  );
  const blockerDest = path.join(WORK, "blocker.sqlite");
  const cancelledDest = path.join(WORK, "cancelled.sqlite");
  const runner = new BackupProcessRunner({ workerScriptPath: hangWorker, maxConcurrency: 1, disposeGraceMs: 500 });
  const blocker = runner.backupDatabase(dbPath, blockerDest).catch(() => {});
  const queued = runner.backupDatabase(dbPath, cancelledDest).catch(() => {});
  try {
    let queuedId: string | undefined;
    for (let i = 0; i < 100 && !queuedId; i++) {
      queuedId = runner.listOperations().find((operation) => operation.state === "queued")?.operationId;
      if (!queuedId) await new Promise((resolve) => setTimeout(resolve, 20));
    }
    expect(queuedId).toBeString();
    const cancellation = await runner.requestCancellation(queuedId!);
    expect(cancellation.outcome).toBe("cancelled_before_execution");
    await queued;

    // The exact destination the cancelled operation reserved can be submitted
    // again without a stale DESTINATION_COLLISION (it simply queues).
    const recovered = runner.backupDatabase(dbPath, cancelledDest).catch(() => {});
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(runner.listOperations().some((operation) => operation.state === "queued")).toBe(true);
    void recovered;
  } finally {
    await runner.dispose();
    await blocker;
  }
}, 120_000);

test("F1: disposal during an auto-named snapshot is bounded and preserves published artifacts", async () => {
  const runner = new BackupProcessRunner({ maxConcurrency: 1, disposeGraceMs: 4000 });
  const pending = runner.createSnapshot(dbPath, DEST, snapshotOptions());
  const startedAt = performance.now();
  await runner.dispose();
  expect(performance.now() - startedAt).toBeLessThan(6000);
  await pending.catch(() => {});
  // Any snapshot that did publish remains a complete, readable bundle.
  for (const entry of readdirSync(DEST)) {
    if (entry.startsWith(".")) continue;
    expect(existsSync(path.join(DEST, entry, "manifest.json"))).toBe(true);
    expect(existsSync(path.join(DEST, entry, "database.sqlite"))).toBe(true);
  }
}, 120_000);

afterAll(() => {
  for (const [key, value] of Object.entries(ORIGINAL_ENV)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  rmSync(ROOT, { recursive: true, force: true });
});
