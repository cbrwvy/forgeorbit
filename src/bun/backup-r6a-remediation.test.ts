/**
 * FO-P2-003-R6A: Critical Profile Integrity and Publication Identity Remediation Test Suite.
 *
 * Covers all 28 mandatory reproduction and regression tests:
 *  - Pre-existing destination and operation identity (Tests 1–7)
 *  - Auto-named snapshot forged adoption (Tests 8–11)
 *  - Canonical path and symlink alias handling (Tests 12–16)
 *  - Cross-profile mixing prevention (Tests 17–21)
 *  - Internal reference manifest completeness & mandatory rawRefSha256 (Tests 22–28)
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

// Establish global isolated profile environment before importing application code
const globalIsoRoot = mkdtempSync(path.join(tmpdir(), "fo-r6a-global-iso-"));
const globalIsoData = path.join(globalIsoRoot, "data");
mkdirSync(globalIsoData, { recursive: true, mode: 0o700 });
process.env.FORGEORBIT_DATA_DIR = globalIsoData;
process.env.AGETOR_DATA_DIR = globalIsoData;

import { BackupCore } from "./backup-core.ts";
import {
  BackupManager,
  BackupManagerError,
  verifyBackupSnapshot,
  type SnapshotManifest,
} from "./backup-manager.ts";
import {
  BackupRestore,
  RestoreError,
  restoreBackupSnapshot,
} from "./backup-restore.ts";
import { BackupProcessRunner } from "./backup-runner.ts";
import { BackupRunnerError } from "./backup-runner-types.ts";
import { migrate } from "./migrate.ts";
import { migrations } from "./migrations/index.ts";
import { setupIsolatedTestProfile, type IsolatedTestProfile } from "./test-isolation.ts";

function sha256Hex(data: Buffer | Uint8Array | string): string {
  return createHash("sha256").update(data).digest("hex");
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

describe("FO-P2-003-R6A: Critical Profile Integrity and Publication Identity Remediation", () => {
  let isolatedProfile: IsolatedTestProfile;
  let testRoot: string;

  beforeEach(() => {
    isolatedProfile = setupIsolatedTestProfile("fo-r6a-suite-");
    testRoot = mkdtempSync(path.join(tmpdir(), "fo-r6a-case-"));
  });

  afterEach(() => {
    try {
      rmSync(testRoot, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
    isolatedProfile.cleanup();
  });

  // ══════════════════════════════════════════════════════════════════════════
  // 1. Pre-existing destination and operation identity (Tests 1–7)
  // ══════════════════════════════════════════════════════════════════════════

  test("1. backupDatabase to pre-existing valid SQLite backup returns TARGET_EXISTS, never PUBLISHED_UNCONFIRMED, and leaves original file unchanged", async () => {
    const profileDir = path.join(testRoot, "profile");
    mkdirSync(profileDir, { recursive: true });
    const srcDbPath = path.join(profileDir, "agetor.sqlite");
    createCanonicalProfileDb(srcDbPath).close();

    const destPath = path.join(testRoot, "existing-backup.sqlite");
    // Create a pre-existing valid SQLite backup at destPath
    const oldDbPath = path.join(testRoot, "old-source.sqlite");
    const oldDb = createCanonicalProfileDb(oldDbPath);
    oldDb.run("INSERT INTO projects (path, name, added_at) VALUES ('/ext/old', 'Old', 100);");
    const oldCore = new BackupCore(oldDb);
    await oldCore.createBackup(destPath);
    oldDb.close();

    const beforeBytes = readFileSync(destPath);
    const beforeSha = sha256Hex(beforeBytes);

    const runner = new BackupProcessRunner();
    try {
      let caught: BackupRunnerError | null = null;
      try {
        await runner.backupDatabase(srcDbPath, destPath);
      } catch (err) {
        caught = err as BackupRunnerError;
      }
      expect(caught).toBeInstanceOf(BackupRunnerError);
      expect(caught!.code).toBe("TARGET_EXISTS");
      expect(caught!.code).not.toBe("PUBLISHED_UNCONFIRMED");

      // Original file must remain byte-for-byte unchanged
      const afterBytes = readFileSync(destPath);
      expect(sha256Hex(afterBytes)).toBe(beforeSha);
    } finally {
      await runner.dispose();
    }
  });

  test("2. createSnapshot with explicit destination to pre-existing valid snapshot returns TARGET_EXISTS, never PUBLISHED_UNCONFIRMED", async () => {
    const profileDir = path.join(testRoot, "profile");
    mkdirSync(profileDir, { recursive: true });
    const srcDbPath = path.join(profileDir, "agetor.sqlite");
    createCanonicalProfileDb(srcDbPath).close();

    const explicitSnapDir = path.join(testRoot, "existing-snapshot");
    const runner = new BackupProcessRunner();
    try {
      const first = await runner.createSnapshot(srcDbPath, explicitSnapDir, {
        isExplicitPath: true,
        dataDir: profileDir,
      });
      expect(first.path).toBe(explicitSnapDir);
      const originalManifestRaw = readFileSync(path.join(explicitSnapDir, "manifest.json"), "utf8");

      // Second attempt to the same explicit snapshot destination
      let caught: BackupRunnerError | null = null;
      try {
        await runner.createSnapshot(srcDbPath, explicitSnapDir, {
          isExplicitPath: true,
          dataDir: profileDir,
        });
      } catch (err) {
        caught = err as BackupRunnerError;
      }
      expect(caught).toBeInstanceOf(BackupRunnerError);
      expect(caught!.code).toBe("TARGET_EXISTS");
      expect(caught!.code).not.toBe("PUBLISHED_UNCONFIRMED");
      expect(readFileSync(path.join(explicitSnapDir, "manifest.json"), "utf8")).toBe(originalManifestRaw);
    } finally {
      await runner.dispose();
    }
  });

  test("3. restoreSnapshot to pre-existing valid restored directory returns TARGET_EXISTS, never PUBLISHED_UNCONFIRMED", async () => {
    const profileDir = path.join(testRoot, "profile");
    mkdirSync(profileDir, { recursive: true });
    const srcDbPath = path.join(profileDir, "agetor.sqlite");
    createCanonicalProfileDb(srcDbPath).close();

    const snapDir = path.join(testRoot, "snapshot");
    const restoreDir = path.join(testRoot, "restored");

    const runner = new BackupProcessRunner();
    try {
      await runner.createSnapshot(srcDbPath, snapDir, {
        isExplicitPath: true,
        dataDir: profileDir,
      });
      await runner.restoreSnapshot(snapDir, restoreDir);
      const markerBefore = readFileSync(path.join(restoreDir, ".forgeorbit-recovery.json"), "utf8");

      // Second restore into the already-existing valid restored directory
      let caught: BackupRunnerError | null = null;
      try {
        await runner.restoreSnapshot(snapDir, restoreDir);
      } catch (err) {
        caught = err as BackupRunnerError;
      }
      expect(caught).toBeInstanceOf(BackupRunnerError);
      expect(caught!.code).toBe("TARGET_EXISTS");
      expect(caught!.code).not.toBe("PUBLISHED_UNCONFIRMED");
      expect(readFileSync(path.join(restoreDir, ".forgeorbit-recovery.json"), "utf8")).toBe(markerBefore);
    } finally {
      await runner.dispose();
    }
  });

  test("4. Concurrent race where another actor creates destination right before worker publish returns TARGET_EXISTS, never PUBLISHED_UNCONFIRMED", async () => {
    const profileDir = path.join(testRoot, "profile");
    mkdirSync(profileDir, { recursive: true });
    const srcDbPath = path.join(profileDir, "agetor.sqlite");
    createCanonicalProfileDb(srcDbPath).close();

    const destPath = path.join(testRoot, "race-dest.sqlite");
    const otherDbPath = path.join(testRoot, "other.sqlite");
    createCanonicalProfileDb(otherDbPath).close();

    const coreModulePath = path.resolve(process.cwd(), "src/bun/backup-core.ts");
    const raceWorker = path.join(testRoot, "race-worker.ts");
    writeFileSync(
      raceWorker,
      `
      import { Database } from "bun:sqlite";
      import { copyFileSync } from "node:fs";
      import { createInterface } from "node:readline";
      import { BackupCore } from ${JSON.stringify(coreModulePath)};

      const rl = createInterface({ input: process.stdin });
      rl.on("line", async (line) => {
        const msg = JSON.parse(line);
        if (msg.type === "start") {
          const opId = msg.operation.operationId;
          const db = new Database(${JSON.stringify(srcDbPath)}, { readonly: true });
          const core = new BackupCore(db);
          try {
            await core.createBackup(${JSON.stringify(destPath)}, {
              runnerOperationId: opId,
              beforeVacuum: async (stagingDir) => {
                process.stdout.write(JSON.stringify({ type: "state", operationId: opId, state: "running", stagingDir }) + "\\n");
              },
              afterVacuum: async () => {
                // Another concurrent actor publishes a valid SQLite file at destPath right before this worker publishes
                copyFileSync(${JSON.stringify(otherDbPath)}, ${JSON.stringify(destPath)});
              },
            });
          } catch (err: any) {
            process.stdout.write(JSON.stringify({
              type: "error",
              operationId: opId,
              error: {
                code: err.code || "TARGET_EXISTS",
                message: err.message,
                subsystem: "backup-core"
              }
            }) + "\\n");
            process.exit(1);
          }
        }
      });
      `,
    );

    const runner = new BackupProcessRunner({ workerScriptPath: raceWorker });
    try {
      let caught: BackupRunnerError | null = null;
      try {
        await runner.backupDatabase(srcDbPath, destPath);
      } catch (err) {
        caught = err as BackupRunnerError;
      }
      expect(caught).toBeInstanceOf(BackupRunnerError);
      expect(caught!.code).toBe("TARGET_EXISTS");
      expect(caught!.code).not.toBe("PUBLISHED_UNCONFIRMED");
    } finally {
      await runner.dispose();
    }
  });

  test("5. Genuine lost final acknowledgment after current operation publishes backup returns PUBLISHED_UNCONFIRMED", async () => {
    const profileDir = path.join(testRoot, "profile");
    mkdirSync(profileDir, { recursive: true });
    const srcDbPath = path.join(profileDir, "agetor.sqlite");
    createCanonicalProfileDb(srcDbPath).close();
    const destPath = path.join(testRoot, "lost-ack-backup.sqlite");

    const coreModulePath = path.resolve(process.cwd(), "src/bun/backup-core.ts");
    const lostAckWorker = path.join(testRoot, "lost-ack-backup-worker.ts");
    writeFileSync(
      lostAckWorker,
      `
      import { Database } from "bun:sqlite";
      import { createInterface } from "node:readline";
      import { BackupCore } from ${JSON.stringify(coreModulePath)};

      const rl = createInterface({ input: process.stdin });
      rl.on("line", async (line) => {
        const msg = JSON.parse(line);
        if (msg.type === "start") {
          const opId = msg.operation.operationId;
          const db = new Database(${JSON.stringify(srcDbPath)}, { readonly: true });
          const core = new BackupCore(db);
          await core.createBackup(${JSON.stringify(destPath)}, {
            runnerOperationId: opId,
          });
          // Crash before sending result or published message
          process.exit(1);
        }
      });
      `,
    );

    const runner = new BackupProcessRunner({ workerScriptPath: lostAckWorker });
    try {
      let caught: BackupRunnerError | null = null;
      try {
        await runner.backupDatabase(srcDbPath, destPath);
      } catch (err) {
        caught = err as BackupRunnerError;
      }
      expect(caught).toBeInstanceOf(BackupRunnerError);
      expect(caught!.code).toBe("PUBLISHED_UNCONFIRMED");
      expect((caught!.details as any)?.destinationVerified).toBe(true);
      expect(existsSync(destPath)).toBe(true);
    } finally {
      await runner.dispose();
    }
  });

  test("6. Genuine lost final acknowledgment after current operation publishes explicit snapshot returns PUBLISHED_UNCONFIRMED", async () => {
    const profileDir = path.join(testRoot, "profile");
    mkdirSync(profileDir, { recursive: true });
    const srcDbPath = path.join(profileDir, "agetor.sqlite");
    createCanonicalProfileDb(srcDbPath).close();
    const explicitSnapDir = path.join(testRoot, "lost-ack-explicit-snap");

    const managerModulePath = path.resolve(process.cwd(), "src/bun/backup-manager.ts");
    const lostAckWorker = path.join(testRoot, "lost-ack-explicit-snap-worker.ts");
    writeFileSync(
      lostAckWorker,
      `
      import { Database } from "bun:sqlite";
      import { createInterface } from "node:readline";
      import { BackupManager } from ${JSON.stringify(managerModulePath)};

      const rl = createInterface({ input: process.stdin });
      rl.on("line", async (line) => {
        const msg = JSON.parse(line);
        if (msg.type === "start") {
          const opId = msg.operation.operationId;
          const db = new Database(${JSON.stringify(srcDbPath)}, { readonly: true });
          const mgr = new BackupManager({ db, dataDir: ${JSON.stringify(profileDir)} });
          await mgr.createSnapshot({
            destinationPath: ${JSON.stringify(explicitSnapDir)},
            runnerOperationId: opId,
          });
          process.exit(1);
        }
      });
      `,
    );

    const runner = new BackupProcessRunner({ workerScriptPath: lostAckWorker });
    try {
      let caught: BackupRunnerError | null = null;
      try {
        await runner.createSnapshot(srcDbPath, explicitSnapDir, {
          isExplicitPath: true,
          dataDir: profileDir,
        });
      } catch (err) {
        caught = err as BackupRunnerError;
      }
      expect(caught).toBeInstanceOf(BackupRunnerError);
      expect(caught!.code).toBe("PUBLISHED_UNCONFIRMED");
      expect((caught!.details as any)?.targetPath).toBe(explicitSnapDir);
    } finally {
      await runner.dispose();
    }
  });

  test("7. Genuine lost final acknowledgment after current operation publishes auto-named snapshot returns PUBLISHED_UNCONFIRMED with correct child path", async () => {
    const profileDir = path.join(testRoot, "profile");
    mkdirSync(profileDir, { recursive: true });
    const srcDbPath = path.join(profileDir, "agetor.sqlite");
    createCanonicalProfileDb(srcDbPath).close();
    const snapsParent = path.join(testRoot, "snapshots-parent");
    mkdirSync(snapsParent, { recursive: true });

    const managerModulePath = path.resolve(process.cwd(), "src/bun/backup-manager.ts");
    const lostAckWorker = path.join(testRoot, "lost-ack-autonamed-worker.ts");
    writeFileSync(
      lostAckWorker,
      `
      import { Database } from "bun:sqlite";
      import { createInterface } from "node:readline";
      import { BackupManager } from ${JSON.stringify(managerModulePath)};

      const rl = createInterface({ input: process.stdin });
      rl.on("line", async (line) => {
        const msg = JSON.parse(line);
        if (msg.type === "start") {
          const opId = msg.operation.operationId;
          const db = new Database(${JSON.stringify(srcDbPath)}, { readonly: true });
          const mgr = new BackupManager({ db, dataDir: ${JSON.stringify(profileDir)} });
          await mgr.createSnapshot({
            destinationDir: ${JSON.stringify(snapsParent)},
            runnerOperationId: opId,
          });
          process.exit(1);
        }
      });
      `,
    );

    const runner = new BackupProcessRunner({ workerScriptPath: lostAckWorker });
    try {
      let caught: BackupRunnerError | null = null;
      try {
        await runner.createSnapshot(srcDbPath, snapsParent, {
          isExplicitPath: false,
          dataDir: profileDir,
        });
      } catch (err) {
        caught = err as BackupRunnerError;
      }
      expect(caught).toBeInstanceOf(BackupRunnerError);
      expect(caught!.code).toBe("PUBLISHED_UNCONFIRMED");
      const targetPath = (caught!.details as any)?.targetPath as string;
      expect(path.dirname(targetPath)).toBe(snapsParent);
      expect(existsSync(path.join(targetPath, "manifest.json"))).toBe(true);
    } finally {
      await runner.dispose();
    }
  });

  // ══════════════════════════════════════════════════════════════════════════
  // 2. Auto-named snapshot forged adoption (Tests 8–11)
  // ══════════════════════════════════════════════════════════════════════════

  test("8. Fake worker sends stagingDir pointing at pre-existing valid snapshot in snapshotDestinationDir then fails -> rejected, never adopted as PUBLISHED_UNCONFIRMED", async () => {
    const profileDir = path.join(testRoot, "profile");
    mkdirSync(profileDir, { recursive: true });
    const srcDbPath = path.join(profileDir, "agetor.sqlite");
    createCanonicalProfileDb(srcDbPath).close();
    const snapsParent = path.join(testRoot, "snapshots-parent");
    mkdirSync(snapsParent, { recursive: true });

    // Create a pre-existing valid snapshot inside snapsParent
    const realRunner = new BackupProcessRunner();
    let existingSnapPath = "";
    try {
      const snap = await realRunner.createSnapshot(srcDbPath, snapsParent, {
        isExplicitPath: false,
        dataDir: profileDir,
      });
      existingSnapPath = snap.path;
    } finally {
      await realRunner.dispose();
    }

    const existingSnapName = path.basename(existingSnapPath);
    const forgedStagingDir = path.join(
      snapsParent,
      `.${existingSnapName}.fo-snapshot.11111111-2222-3333-4444-555555555555.tmp`,
    );

    const forgedWorker = path.join(testRoot, "forged-staging-worker.ts");
    writeFileSync(
      forgedWorker,
      `
      import { createInterface } from "node:readline";
      const rl = createInterface({ input: process.stdin });
      rl.on("line", (line) => {
        const msg = JSON.parse(line);
        if (msg.type === "start") {
          const opId = msg.operation.operationId;
          process.stdout.write(JSON.stringify({
            type: "state",
            operationId: opId,
            state: "running",
            stagingDir: ${JSON.stringify(forgedStagingDir)}
          }) + "\\n");
          process.exit(1);
        }
      });
      `,
    );

    const runner = new BackupProcessRunner({ workerScriptPath: forgedWorker });
    try {
      let caught: BackupRunnerError | null = null;
      try {
        await runner.createSnapshot(srcDbPath, snapsParent, {
          isExplicitPath: false,
          dataDir: profileDir,
        });
      } catch (err) {
        caught = err as BackupRunnerError;
      }
      expect(caught).toBeInstanceOf(BackupRunnerError);
      expect(caught!.code).not.toBe("PUBLISHED_UNCONFIRMED");
      expect(caught!.code).toBe("INVALID_WORKER_RESPONSE");
    } finally {
      await runner.dispose();
    }
  });

  test("9. Fake worker sends stagingDir outside snapshotDestinationDir -> rejected", async () => {
    const profileDir = path.join(testRoot, "profile");
    mkdirSync(profileDir, { recursive: true });
    const srcDbPath = path.join(profileDir, "agetor.sqlite");
    createCanonicalProfileDb(srcDbPath).close();
    const snapsParent = path.join(testRoot, "snapshots-parent");
    mkdirSync(snapsParent, { recursive: true });

    const outsideStaging = path.join(
      testRoot,
      ".outside-snap.fo-snapshot.11111111-2222-3333-4444-555555555555.tmp",
    );

    const outsideWorker = path.join(testRoot, "outside-staging-worker.ts");
    writeFileSync(
      outsideWorker,
      `
      import { createInterface } from "node:readline";
      const rl = createInterface({ input: process.stdin });
      rl.on("line", (line) => {
        const msg = JSON.parse(line);
        if (msg.type === "start") {
          const opId = msg.operation.operationId;
          process.stdout.write(JSON.stringify({
            type: "state",
            operationId: opId,
            state: "running",
            stagingDir: ${JSON.stringify(outsideStaging)}
          }) + "\\n");
          process.exit(1);
        }
      });
      `,
    );

    const runner = new BackupProcessRunner({ workerScriptPath: outsideWorker });
    try {
      let caught: BackupRunnerError | null = null;
      try {
        await runner.createSnapshot(srcDbPath, snapsParent, {
          isExplicitPath: false,
          dataDir: profileDir,
        });
      } catch (err) {
        caught = err as BackupRunnerError;
      }
      expect(caught).toBeInstanceOf(BackupRunnerError);
      expect(caught!.code).toBe("INVALID_WORKER_RESPONSE");
    } finally {
      await runner.dispose();
    }
  });

  test("10. Directory scan with multiple snapshots in snapshotDestinationDir only reconciles snapshot whose manifest.metadata.runnerOperationId matches current operationId", async () => {
    const profileDir = path.join(testRoot, "profile");
    mkdirSync(profileDir, { recursive: true });
    const srcDbPath = path.join(profileDir, "agetor.sqlite");
    createCanonicalProfileDb(srcDbPath).close();
    const snapsParent = path.join(testRoot, "snapshots-parent");
    mkdirSync(snapsParent, { recursive: true });

    // Create 2 pre-existing snapshots in snapsParent
    const setupRunner = new BackupProcessRunner();
    let oldSnap1 = "";
    let oldSnap2 = "";
    try {
      oldSnap1 = (await setupRunner.createSnapshot(srcDbPath, path.join(snapsParent, "snap-old-1"), {
        isExplicitPath: true,
        dataDir: profileDir,
      })).path;
      oldSnap2 = (await setupRunner.createSnapshot(srcDbPath, path.join(snapsParent, "snap-old-2"), {
        isExplicitPath: true,
        dataDir: profileDir,
      })).path;
    } finally {
      await setupRunner.dispose();
    }

    // Worker creates a new auto-named snapshot with current opId and crashes before sending IPC
    const managerModulePath = path.resolve(process.cwd(), "src/bun/backup-manager.ts");
    const crashWorker = path.join(testRoot, "multi-scan-worker.ts");
    writeFileSync(
      crashWorker,
      `
      import { Database } from "bun:sqlite";
      import { createInterface } from "node:readline";
      import { BackupManager } from ${JSON.stringify(managerModulePath)};

      const rl = createInterface({ input: process.stdin });
      rl.on("line", async (line) => {
        const msg = JSON.parse(line);
        if (msg.type === "start") {
          const opId = msg.operation.operationId;
          const db = new Database(${JSON.stringify(srcDbPath)}, { readonly: true });
          const mgr = new BackupManager({ db, dataDir: ${JSON.stringify(profileDir)} });
          await mgr.createSnapshot({
            destinationDir: ${JSON.stringify(snapsParent)},
            runnerOperationId: opId,
          });
          process.exit(1);
        }
      });
      `,
    );

    const runner = new BackupProcessRunner({ workerScriptPath: crashWorker });
    try {
      let caught: BackupRunnerError | null = null;
      try {
        await runner.createSnapshot(srcDbPath, snapsParent, {
          isExplicitPath: false,
          dataDir: profileDir,
        });
      } catch (err) {
        caught = err as BackupRunnerError;
      }
      expect(caught).toBeInstanceOf(BackupRunnerError);
      expect(caught!.code).toBe("PUBLISHED_UNCONFIRMED");
      const reconciledPath = (caught!.details as any)?.targetPath as string;
      expect(reconciledPath).not.toBe(oldSnap1);
      expect(reconciledPath).not.toBe(oldSnap2);
      const manifest = JSON.parse(readFileSync(path.join(reconciledPath, "manifest.json"), "utf8"));
      expect(manifest.metadata.runnerOperationId).toBe(caught!.operationId);
    } finally {
      await runner.dispose();
    }
  });

  test("11. Snapshot with mismatched runnerOperationId is never adopted on completion or failure reconciliation", async () => {
    const profileDir = path.join(testRoot, "profile");
    mkdirSync(profileDir, { recursive: true });
    const srcDbPath = path.join(profileDir, "agetor.sqlite");
    createCanonicalProfileDb(srcDbPath).close();
    const snapsParent = path.join(testRoot, "snapshots-parent");
    mkdirSync(snapsParent, { recursive: true });

    const managerModulePath = path.resolve(process.cwd(), "src/bun/backup-manager.ts");
    const wrongOpIdWorker = path.join(testRoot, "wrong-opid-snap-worker.ts");
    writeFileSync(
      wrongOpIdWorker,
      `
      import { Database } from "bun:sqlite";
      import { createInterface } from "node:readline";
      import { BackupManager } from ${JSON.stringify(managerModulePath)};

      const rl = createInterface({ input: process.stdin });
      rl.on("line", async (line) => {
        const msg = JSON.parse(line);
        if (msg.type === "start") {
          const opId = msg.operation.operationId;
          const db = new Database(${JSON.stringify(srcDbPath)}, { readonly: true });
          const mgr = new BackupManager({ db, dataDir: ${JSON.stringify(profileDir)} });
          // Create snapshot with a forged runnerOperationId
          const snap = await mgr.createSnapshot({
            destinationDir: ${JSON.stringify(snapsParent)},
            runnerOperationId: "00000000-0000-4000-8000-999999999999",
          });
          process.stdout.write(JSON.stringify({
            type: "result",
            operationId: opId,
            result: {
              type: "create-snapshot",
              operationId: opId,
              path: snap.path,
              snapshotId: snap.manifest.snapshotId,
              createdAt: snap.manifest.createdAt,
              schemaVersion: snap.manifest.schemaVersion,
              databaseSha256: snap.manifest.databaseSha256,
              databaseBytes: snap.manifest.databaseBytes,
              totalFiles: snap.manifest.files.length,
              totalBytes: snap.manifest.databaseBytes,
              knowledgeDocumentCount: 0,
              knowledgeRevisionCount: 0,
              manifest: {
                manifestVersion: snap.manifest.manifestVersion,
                snapshotId: snap.manifest.snapshotId,
                createdAt: snap.manifest.createdAt,
                schemaVersion: snap.manifest.schemaVersion,
                databaseSha256: snap.manifest.databaseSha256,
                databaseBytes: snap.manifest.databaseBytes,
                stats: snap.manifest.stats,
                verified: true,
              },
              durationMs: 10,
            }
          }) + "\\n");
          process.exit(0);
        }
      });
      `,
    );

    const runner = new BackupProcessRunner({ workerScriptPath: wrongOpIdWorker });
    try {
      let caught: BackupRunnerError | null = null;
      try {
        await runner.createSnapshot(srcDbPath, snapsParent, {
          isExplicitPath: false,
          dataDir: profileDir,
        });
      } catch (err) {
        caught = err as BackupRunnerError;
      }
      expect(caught).toBeInstanceOf(BackupRunnerError);
      expect(caught!.code).toBe("INVALID_WORKER_RESPONSE");
      expect(caught!.code).not.toBe("PUBLISHED_UNCONFIRMED");
    } finally {
      await runner.dispose();
    }
  });

  // ══════════════════════════════════════════════════════════════════════════
  // 3. Canonical path and symlink alias handling (Tests 12–16)
  // ══════════════════════════════════════════════════════════════════════════

  test("12. dataDir passed via /var/folders/... while SQLite references use /private/var/folders/... -> internalReferences populated, verify passes, restore rebinds to destination", async () => {
    const realRoot = realpathSync(testRoot); // /private/var/folders/... on macOS
    const varAliasRoot = realRoot.startsWith("/private/var/")
      ? realRoot.slice("/private".length)
      : realRoot;

    const extRepo = path.join(realRoot, "ext-repo-12");
    mkdirSync(extRepo, { recursive: true });

    const realProfileDir = path.join(realRoot, "profile-12");
    const aliasProfileDir = path.join(varAliasRoot, "profile-12");
    mkdirSync(path.join(realProfileDir, "attachments"), { recursive: true });

    const realAttachmentPath = path.join(realProfileDir, "attachments", "note.txt");
    writeFileSync(realAttachmentPath, "hello canonical world", { mode: 0o600 });

    const dbPath = path.join(aliasProfileDir, "agetor.sqlite");
    const db = createCanonicalProfileDb(dbPath);
    db.run(
      `INSERT INTO tasks (id, title, prompt, column, agent, workdir, refs, attachments, sent_files, created_at, updated_at)
       VALUES (?, 'T1', 'P', 'backlog', 'claude-code', ?, ?, '[]', NULL, 100, 100);`,
      ["task-12", extRepo, JSON.stringify([realAttachmentPath])],
    );
    db.close();

    // Pass dataDir via /var/folders/... alias while DB stores /private/var/folders/...
    const readDb = new Database(dbPath, { readonly: true });
    const manager = new BackupManager({ db: readDb, dataDir: aliasProfileDir });
    const snapDir = path.join(realRoot, "snap-12");
    const snap = await manager.createSnapshot({ destinationPath: snapDir });
    readDb.close();

    expect(snap.manifest.internalReferences?.length).toBe(1);
    expect(snap.manifest.internalReferences![0]!.canonicalPath).toBe("attachments/note.txt");

    const ver = await verifyBackupSnapshot(snapDir);
    expect(ver.ok).toBe(true);

    const restoreDest = path.join(realRoot, "restored-12");
    const res = await restoreBackupSnapshot(snapDir, restoreDest);
    expect(res.validationStatus).toBe("valid");
    expect(res.activationReadiness).toBe("ready");
    expect(res.internalReferencesRebound).toBe(1);

    const restoredDb = new Database(path.join(restoreDest, "agetor.sqlite"), { readonly: true });
    const row = restoredDb.query("SELECT refs FROM tasks WHERE id = 'task-12'").get() as { refs: string };
    restoredDb.close();
    const refs = JSON.parse(row.refs) as string[];
    expect(refs[0]).toBe(path.join(realpathSync(restoreDest), "attachments", "note.txt"));
  });

  test("13. dataDir passed via /private/var/folders/... while SQLite references use /var/folders/... -> internalReferences populated, verify passes, restore rebinds to destination", async () => {
    const realRoot = realpathSync(testRoot);
    const varAliasRoot = realRoot.startsWith("/private/var/")
      ? realRoot.slice("/private".length)
      : realRoot;

    const extRepo = path.join(realRoot, "ext-repo-13");
    mkdirSync(extRepo, { recursive: true });

    const realProfileDir = path.join(realRoot, "profile-13");
    const aliasProfileDir = path.join(varAliasRoot, "profile-13");
    mkdirSync(path.join(realProfileDir, "attachments"), { recursive: true });

    const realAttachmentPath = path.join(realProfileDir, "attachments", "note13.txt");
    const aliasAttachmentPath = path.join(aliasProfileDir, "attachments", "note13.txt");
    writeFileSync(realAttachmentPath, "hello reverse alias", { mode: 0o600 });

    const dbPath = path.join(realProfileDir, "agetor.sqlite");
    const db = createCanonicalProfileDb(dbPath);
    db.run(
      `INSERT INTO tasks (id, title, prompt, column, agent, workdir, refs, attachments, sent_files, created_at, updated_at)
       VALUES (?, 'T13', 'P', 'backlog', 'claude-code', ?, ?, '[]', NULL, 100, 100);`,
      ["task-13", extRepo, JSON.stringify([aliasAttachmentPath])],
    );
    db.close();

    // Pass dataDir via /private/var/folders/... while DB stores /var/folders/...
    const readDb = new Database(dbPath, { readonly: true });
    const manager = new BackupManager({ db: readDb, dataDir: realProfileDir });
    const snapDir = path.join(realRoot, "snap-13");
    const snap = await manager.createSnapshot({ destinationPath: snapDir });
    readDb.close();

    expect(snap.manifest.internalReferences?.length).toBe(1);
    expect(snap.manifest.internalReferences![0]!.canonicalPath).toBe("attachments/note13.txt");

    const ver = await verifyBackupSnapshot(snapDir);
    expect(ver.ok).toBe(true);

    const restoreDest = path.join(realRoot, "restored-13");
    const res = await restoreBackupSnapshot(snapDir, restoreDest);
    expect(res.validationStatus).toBe("valid");
    expect(res.activationReadiness).toBe("ready");
    expect(res.internalReferencesRebound).toBe(1);
  });

  test("14. User-created symlinked profile root pointing to real profile directory -> internalReferences populated, verify passes, restore rebinds to destination", async () => {
    const extRepo = path.join(testRoot, "ext-repo-14");
    mkdirSync(extRepo, { recursive: true });

    const realProfileDir = path.join(testRoot, "real-profile-14");
    const symlinkProfileDir = path.join(testRoot, "symlink-profile-14");
    mkdirSync(path.join(realProfileDir, "attachments"), { recursive: true });
    symlinkSync(realProfileDir, symlinkProfileDir);

    const fileInReal = path.join(realProfileDir, "attachments", "sym.txt");
    writeFileSync(fileInReal, "symlink profile test", { mode: 0o600 });
    const refViaSymlink = path.join(symlinkProfileDir, "attachments", "sym.txt");

    const dbPath = path.join(symlinkProfileDir, "agetor.sqlite");
    const db = createCanonicalProfileDb(dbPath);
    db.run(
      `INSERT INTO tasks (id, title, prompt, column, agent, workdir, refs, attachments, sent_files, created_at, updated_at)
       VALUES (?, 'T14', 'P', 'backlog', 'claude-code', ?, ?, '[]', NULL, 100, 100);`,
      ["task-14", extRepo, JSON.stringify([refViaSymlink])],
    );
    db.close();

    // Pass realProfileDir as dataDir while DB references symlinkProfileDir
    const readDb = new Database(path.join(realProfileDir, "agetor.sqlite"), { readonly: true });
    const manager = new BackupManager({ db: readDb, dataDir: realProfileDir });
    const snapDir = path.join(testRoot, "snap-14");
    const snap = await manager.createSnapshot({ destinationPath: snapDir });
    readDb.close();

    expect(snap.manifest.internalReferences?.length).toBe(1);
    expect(snap.manifest.internalReferences![0]!.canonicalPath).toBe("attachments/sym.txt");

    const ver = await verifyBackupSnapshot(snapDir);
    expect(ver.ok).toBe(true);

    const restoreDest = path.join(testRoot, "restored-14");
    const res = await restoreBackupSnapshot(snapDir, restoreDest);
    expect(res.validationStatus).toBe("valid");
    expect(res.activationReadiness).toBe("ready");
    expect(res.internalReferencesRebound).toBe(1);
  });

  test("15. Offline verifySnapshot after deleting original source profile directory still succeeds", async () => {
    const realRoot = realpathSync(testRoot);
    const varAliasRoot = realRoot.startsWith("/private/var/")
      ? realRoot.slice("/private".length)
      : realRoot;

    const realProfileDir = path.join(realRoot, "ephemeral-profile-15");
    const aliasProfileDir = path.join(varAliasRoot, "ephemeral-profile-15");
    mkdirSync(path.join(realProfileDir, "attachments"), { recursive: true });

    const attFile = path.join(realProfileDir, "attachments", "offline.txt");
    writeFileSync(attFile, "offline check", { mode: 0o600 });

    const dbPath = path.join(aliasProfileDir, "agetor.sqlite");
    const db = createCanonicalProfileDb(dbPath);
    db.run(
      `INSERT INTO tasks (id, title, prompt, column, agent, workdir, refs, attachments, sent_files, created_at, updated_at)
       VALUES (?, 'T15', 'P', 'backlog', 'claude-code', '/ext/repo', ?, '[]', NULL, 100, 100);`,
      ["task-15", JSON.stringify([attFile])],
    );
    db.close();

    const readDb = new Database(dbPath, { readonly: true });
    const manager = new BackupManager({ db: readDb, dataDir: aliasProfileDir });
    const snapDir = path.join(realRoot, "snap-15");
    await manager.createSnapshot({ destinationPath: snapDir });
    readDb.close();

    // Delete the original source profile directory completely
    rmSync(realProfileDir, { recursive: true, force: true });
    expect(existsSync(realProfileDir)).toBe(false);

    // Offline verification must still succeed without original directory existing
    const ver = await verifyBackupSnapshot(snapDir);
    expect(ver.ok).toBe(true);
    expect(ver.issues).toEqual([]);
  });

  test("16. Restored database contains rebound destination paths and no stale source-profile paths", async () => {
    const realRoot = realpathSync(testRoot);
    const varAliasRoot = realRoot.startsWith("/private/var/")
      ? realRoot.slice("/private".length)
      : realRoot;

    const extRepo = path.join(realRoot, "ext-repo-16");
    mkdirSync(path.join(extRepo, ".git"), { recursive: true });
    const readmePath = path.join(extRepo, "README.md");
    writeFileSync(readmePath, "sample readme");

    const realProfileDir = path.join(realRoot, "profile-16");
    const aliasProfileDir = path.join(varAliasRoot, "profile-16");
    mkdirSync(path.join(realProfileDir, "attachments"), { recursive: true });
    mkdirSync(path.join(realProfileDir, "screenshots"), { recursive: true });

    const attPath = path.join(realProfileDir, "attachments", "doc.pdf");
    const scrPath = path.join(aliasProfileDir, "screenshots", "screen.png");
    writeFileSync(attPath, "pdf-bytes", { mode: 0o600 });
    writeFileSync(path.join(realProfileDir, "screenshots", "screen.png"), "png-bytes", { mode: 0o600 });

    const dbPath = path.join(aliasProfileDir, "agetor.sqlite");
    const db = createCanonicalProfileDb(dbPath);
    db.run(
      `INSERT INTO tasks (id, title, prompt, column, agent, workdir, refs, attachments, sent_files, created_at, updated_at)
       VALUES (?, 'T16', 'P', 'backlog', 'claude-code', ?, ?, ?, NULL, 100, 100);`,
      [
        "task-16",
        extRepo,
        JSON.stringify([readmePath, attPath]),
        JSON.stringify([{ name: "screen.png", path: scrPath }]),
      ],
    );
    db.close();

    const readDb = new Database(dbPath, { readonly: true });
    const manager = new BackupManager({ db: readDb, dataDir: aliasProfileDir });
    const snapDir = path.join(realRoot, "snap-16");
    await manager.createSnapshot({ destinationPath: snapDir });
    readDb.close();

    // Remove source profile before restore to prove offline rebinding
    rmSync(realProfileDir, { recursive: true, force: true });

    const restoreDest = path.join(realRoot, "restored-16");
    const res = await restoreBackupSnapshot(snapDir, restoreDest);
    expect(res.validationStatus).toBe("valid");
    expect(res.activationReadiness).toBe("ready");
    expect(res.internalReferencesRebound).toBe(2);
    expect(res.internalReferencesUnresolved).toBe(0);

    const restoredDb = new Database(path.join(restoreDest, "agetor.sqlite"), { readonly: true });
    const row = restoredDb
      .query("SELECT refs, attachments FROM tasks WHERE id = 'task-16'")
      .get() as { refs: string; attachments: string };
    restoredDb.close();

    expect(row.refs).not.toContain(realProfileDir);
    expect(row.refs).not.toContain(aliasProfileDir);
    expect(row.attachments).not.toContain(realProfileDir);
    expect(row.attachments).not.toContain(aliasProfileDir);

    const parsedRefs = JSON.parse(row.refs) as string[];
    const parsedAtts = JSON.parse(row.attachments) as Array<{ name: string; path: string }>;
    expect(parsedRefs[0]).toBe(readmePath);
    expect(parsedRefs[1]).toBe(path.join(restoreDest, "attachments", "doc.pdf"));
    expect(parsedAtts[0]!.path).toBe(path.join(restoreDest, "screenshots", "screen.png"));
  });

  // ══════════════════════════════════════════════════════════════════════════
  // 4. Cross-profile mixing prevention (Tests 17–21)
  // ══════════════════════════════════════════════════════════════════════════

  test("17. Shared parent passed as dataDir with dbPath in profile-a and assets in profile-b -> rejected before copying", async () => {
    const sharedParent = path.join(testRoot, "shared-parent");
    const profileA = path.join(sharedParent, "profile-a");
    const profileB = path.join(sharedParent, "profile-b");
    mkdirSync(path.join(profileA, "attachments"), { recursive: true });
    mkdirSync(path.join(profileB, "attachments"), { recursive: true });
    writeFileSync(path.join(profileB, "attachments", "secret-b.txt"), "secret B");

    const dbPathA = path.join(profileA, "agetor.sqlite");
    createCanonicalProfileDb(dbPathA).close();

    const readDb = new Database(dbPathA, { readonly: true });
    let caught: BackupManagerError | null = null;
    try {
      new BackupManager({
        db: readDb,
        dataDir: sharedParent,
        attachmentsRootDir: path.join(profileB, "attachments"),
      });
    } catch (err) {
      caught = err as BackupManagerError;
    } finally {
      readDb.close();
    }
    expect(caught).toBeInstanceOf(BackupManagerError);
    expect(caught!.code).toBe("INVALID_PATH");

    // Also verify BackupProcessRunner rejects before spawning or copying
    const runner = new BackupProcessRunner();
    try {
      let runnerErr: BackupRunnerError | null = null;
      try {
        await runner.createSnapshot(dbPathA, path.join(testRoot, "out-snap-17"), {
          isExplicitPath: true,
          dataDir: sharedParent,
          attachmentsRootDir: path.join(profileB, "attachments"),
        });
      } catch (err) {
        runnerErr = err as BackupRunnerError;
      }
      expect(runnerErr).toBeInstanceOf(BackupRunnerError);
      expect(runnerErr!.code).toBe("INVALID_PATH");
      expect(existsSync(path.join(testRoot, "out-snap-17"))).toBe(false);
    } finally {
      await runner.dispose();
    }
  });

  test("18. dbPath in profile-a and dataDir set to profile-b -> rejected", () => {
    const profileA = path.join(testRoot, "profile-a");
    const profileB = path.join(testRoot, "profile-b");
    mkdirSync(profileA, { recursive: true });
    mkdirSync(profileB, { recursive: true });

    const dbPathA = path.join(profileA, "agetor.sqlite");
    createCanonicalProfileDb(dbPathA).close();

    const readDb = new Database(dbPathA, { readonly: true });
    try {
      expect(() => new BackupManager({ db: readDb, dataDir: profileB })).toThrow(BackupManagerError);
    } finally {
      readDb.close();
    }
  });

  test("19. Symlinked SQLite file inside profile-b pointing to profile-a database -> rejected", async () => {
    const profileA = path.join(testRoot, "profile-a");
    const profileB = path.join(testRoot, "profile-b");
    mkdirSync(profileA, { recursive: true });
    mkdirSync(profileB, { recursive: true });

    const realDbA = path.join(profileA, "agetor.sqlite");
    createCanonicalProfileDb(realDbA).close();

    const symlinkDbInB = path.join(profileB, "agetor.sqlite");
    symlinkSync(realDbA, symlinkDbInB);

    const runner = new BackupProcessRunner();
    try {
      let caught: BackupRunnerError | null = null;
      try {
        await runner.createSnapshot(symlinkDbInB, path.join(testRoot, "snap-19"), {
          isExplicitPath: true,
          dataDir: profileB,
        });
      } catch (err) {
        caught = err as BackupRunnerError;
      }
      expect(caught).toBeInstanceOf(BackupRunnerError);
      expect(caught!.code).toBe("UNTRUSTED_SYMLINK");
    } finally {
      await runner.dispose();
    }
  });

  test("20. Symlinked attachments directory pointing to another profile -> rejected", () => {
    const profileA = path.join(testRoot, "profile-a");
    const profileB = path.join(testRoot, "profile-b");
    mkdirSync(profileA, { recursive: true });
    mkdirSync(path.join(profileB, "attachments"), { recursive: true });

    // Symlink profileA/attachments -> profileB/attachments
    symlinkSync(path.join(profileB, "attachments"), path.join(profileA, "attachments"));

    const dbPathA = path.join(profileA, "agetor.sqlite");
    createCanonicalProfileDb(dbPathA).close();

    const readDb = new Database(dbPathA, { readonly: true });
    try {
      let caught: BackupManagerError | null = null;
      try {
        new BackupManager({ db: readDb, dataDir: profileA });
      } catch (err) {
        caught = err as BackupManagerError;
      }
      expect(caught).toBeInstanceOf(BackupManagerError);
      expect(caught!.code).toBe("UNTRUSTED_SYMLINK");
    } finally {
      readDb.close();
    }
  });

  test("21. Same-profile database and assets -> succeeds", async () => {
    const profileA = path.join(testRoot, "profile-21");
    mkdirSync(path.join(profileA, "attachments"), { recursive: true });
    mkdirSync(path.join(profileA, "screenshots"), { recursive: true });
    mkdirSync(path.join(profileA, "knowledge"), { recursive: true });

    const attFile = path.join(profileA, "attachments", "same-profile.txt");
    writeFileSync(attFile, "valid profile A asset", { mode: 0o600 });

    const dbPathA = path.join(profileA, "agetor.sqlite");
    const db = createCanonicalProfileDb(dbPathA);
    db.run(
      `INSERT INTO tasks (id, title, prompt, column, agent, workdir, refs, attachments, sent_files, created_at, updated_at)
       VALUES ('t-21', 'Title', 'Prompt', 'backlog', 'claude-code', '/ext', ?, '[]', NULL, 100, 100);`,
      [JSON.stringify([attFile])],
    );
    db.close();

    const readDb = new Database(dbPathA, { readonly: true });
    const manager = new BackupManager({
      db: readDb,
      dataDir: profileA,
      attachmentsRootDir: path.join(profileA, "attachments"),
      screenshotsRootDir: path.join(profileA, "screenshots"),
      knowledgeRootDir: path.join(profileA, "knowledge"),
    });
    const snapDir = path.join(testRoot, "snap-21");
    const snap = await manager.createSnapshot({ destinationPath: snapDir });
    readDb.close();

    expect(snap.manifest.verified).toBe(true);
    expect(snap.manifest.internalReferences?.length).toBe(1);
  });

  // ══════════════════════════════════════════════════════════════════════════
  // 5. Internal reference manifest completeness (Tests 22–28)
  // ══════════════════════════════════════════════════════════════════════════

  async function createTwoRefSnapshotFixture(name: string): Promise<{
    profileDir: string;
    snapDir: string;
    att1: string;
    att2: string;
    extRepo: string;
  }> {
    const extRepo = path.join(testRoot, `ext-repo-${name}`);
    mkdirSync(path.join(extRepo, ".git"), { recursive: true });

    const profileDir = path.join(testRoot, `profile-${name}`);
    mkdirSync(path.join(profileDir, "attachments"), { recursive: true });
    const att1 = path.join(profileDir, "attachments", "one.txt");
    const att2 = path.join(profileDir, "attachments", "two.txt");
    writeFileSync(att1, "file one", { mode: 0o600 });
    writeFileSync(att2, "file two", { mode: 0o600 });

    const dbPath = path.join(profileDir, "agetor.sqlite");
    const db = createCanonicalProfileDb(dbPath);
    db.run(
      `INSERT INTO tasks (id, title, prompt, column, agent, workdir, refs, attachments, sent_files, created_at, updated_at)
       VALUES ('task-main', 'Title', 'Prompt', 'backlog', 'claude-code', ?, ?, '[]', NULL, 100, 100);`,
      [extRepo, JSON.stringify([path.join(extRepo, "src"), att1, att2])],
    );
    db.close();

    const readDb = new Database(dbPath, { readonly: true });
    const manager = new BackupManager({ db: readDb, dataDir: profileDir });
    const snapDir = path.join(testRoot, `snap-${name}`);
    await manager.createSnapshot({ destinationPath: snapDir });
    readDb.close();

    return { profileDir, snapDir, att1, att2, extRepo };
  }

  test("22. manifest.internalReferences = [] when SQLite has internal references -> verifySnapshot fails, restoreSnapshot fails closed", async () => {
    const { snapDir } = await createTwoRefSnapshotFixture("22");

    // Tamper manifest: empty internalReferences = []
    const manifestPath = path.join(snapDir, "manifest.json");
    const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as SnapshotManifest;
    manifest.internalReferences = [];
    writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));

    const ver = await verifyBackupSnapshot(snapDir);
    expect(ver.ok).toBe(false);
    expect(ver.issues.some((i) => i.includes("missing mandatory internal reference"))).toBe(true);

    let restoreErr: RestoreError | null = null;
    try {
      await restoreBackupSnapshot(snapDir, path.join(testRoot, "restore-22"));
    } catch (err) {
      restoreErr = err as RestoreError;
    }
    expect(restoreErr).toBeInstanceOf(RestoreError);
    expect(existsSync(path.join(testRoot, "restore-22"))).toBe(false);
  });

  test("23. Partial removal of one manifest.internalReferences entry when SQLite has two -> verifySnapshot fails, restoreSnapshot fails closed", async () => {
    const { snapDir } = await createTwoRefSnapshotFixture("23");

    const manifestPath = path.join(snapDir, "manifest.json");
    const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as SnapshotManifest;
    expect(manifest.internalReferences?.length).toBe(2);
    manifest.internalReferences = [manifest.internalReferences![0]!];
    writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));

    const ver = await verifyBackupSnapshot(snapDir);
    expect(ver.ok).toBe(false);
    expect(ver.issues.some((i) => i.includes("missing mandatory internal reference"))).toBe(true);

    let restoreErr: RestoreError | null = null;
    try {
      await restoreBackupSnapshot(snapDir, path.join(testRoot, "restore-23"));
    } catch (err) {
      restoreErr = err as RestoreError;
    }
    expect(restoreErr).toBeInstanceOf(RestoreError);
    expect(existsSync(path.join(testRoot, "restore-23"))).toBe(false);
  });

  test("24. Extra fake manifest.internalReferences entry not present in SQLite -> verifySnapshot fails, restoreSnapshot fails closed", async () => {
    const { snapDir } = await createTwoRefSnapshotFixture("24");

    const manifestPath = path.join(snapDir, "manifest.json");
    const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as SnapshotManifest;
    const extraEntry = {
      ...manifest.internalReferences![0]!,
      itemIndex: 99,
      jsonPath: "$[99]",
    };
    manifest.internalReferences = [...manifest.internalReferences!, extraEntry];
    writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));

    const ver = await verifyBackupSnapshot(snapDir);
    expect(ver.ok).toBe(false);
    expect(ver.issues.some((i) => i.includes("extra entry not present in database"))).toBe(true);

    let restoreErr: RestoreError | null = null;
    try {
      await restoreBackupSnapshot(snapDir, path.join(testRoot, "restore-24"));
    } catch (err) {
      restoreErr = err as RestoreError;
    }
    expect(restoreErr).toBeInstanceOf(RestoreError);
  });

  test("25. Duplicate manifest.internalReferences entry -> verifySnapshot fails, restoreSnapshot fails closed", async () => {
    const { snapDir } = await createTwoRefSnapshotFixture("25");

    const manifestPath = path.join(snapDir, "manifest.json");
    const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as SnapshotManifest;
    manifest.internalReferences = [
      manifest.internalReferences![0]!,
      manifest.internalReferences![0]!,
      manifest.internalReferences![1]!,
    ];
    writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));

    const ver = await verifyBackupSnapshot(snapDir);
    expect(ver.ok).toBe(false);
    expect(ver.issues.some((i) => i.includes("duplicate entry"))).toBe(true);

    let restoreErr: RestoreError | null = null;
    try {
      await restoreBackupSnapshot(snapDir, path.join(testRoot, "restore-25"));
    } catch (err) {
      restoreErr = err as RestoreError;
    }
    expect(restoreErr).toBeInstanceOf(RestoreError);
  });

  test("26. Tampered manifest.internalReferences entry omitting rawRefSha256 with itemIndex: 0 targeting external Git repo path at tasks.refs[0] -> rejected before modifying SQLite; external path preserved", async () => {
    const { snapDir, extRepo } = await createTwoRefSnapshotFixture("26");

    const manifestPath = path.join(snapDir, "manifest.json");
    const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as SnapshotManifest;
    // Tamper entry 0 to point to itemIndex: 0 (which is extRepo/src) and omit rawRefSha256
    const tampered = { ...manifest.internalReferences![0]!, itemIndex: 0, jsonPath: "$[0]" } as any;
    delete tampered.rawRefSha256;
    delete tampered.expectedOriginalValue;
    manifest.internalReferences![0] = tampered;
    writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));

    const restoreDest = path.join(testRoot, "restore-26");
    let restoreErr: RestoreError | null = null;
    try {
      await restoreBackupSnapshot(snapDir, restoreDest);
    } catch (err) {
      restoreErr = err as RestoreError;
    }
    expect(restoreErr).toBeInstanceOf(RestoreError);
    expect(existsSync(restoreDest)).toBe(false);

    // Also verify snapshot database still has extRepo/src untouched at tasks.refs[0]
    const snapDb = new Database(path.join(snapDir, "database.sqlite"), { readonly: true });
    const row = snapDb.query("SELECT refs FROM tasks WHERE id = 'task-main'").get() as { refs: string };
    snapDb.close();
    expect(JSON.parse(row.refs)[0]).toBe(path.join(extRepo, "src"));
  });

  test("27. Tampered manifest.internalReferences entry with wrong rawRefSha256 -> rejected before modifying SQLite", async () => {
    const { snapDir } = await createTwoRefSnapshotFixture("27");

    const manifestPath = path.join(snapDir, "manifest.json");
    const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as SnapshotManifest;
    manifest.internalReferences![0] = {
      ...manifest.internalReferences![0]!,
      rawRefSha256: "f".repeat(64),
    };
    writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));

    const ver = await verifyBackupSnapshot(snapDir);
    expect(ver.ok).toBe(false);
    expect(ver.issues.some((i) => i.includes("rawRefSha256 mismatch"))).toBe(true);

    let restoreErr: RestoreError | null = null;
    try {
      await restoreBackupSnapshot(snapDir, path.join(testRoot, "restore-27"));
    } catch (err) {
      restoreErr = err as RestoreError;
    }
    expect(restoreErr).toBeInstanceOf(RestoreError);
  });

  test("28. restoreSnapshot with rebindInternalReferences: false when snapshot has profile-absolute internal references -> activationReadiness is NOT ready", async () => {
    const { snapDir } = await createTwoRefSnapshotFixture("28");

    const restoreDest = path.join(testRoot, "restore-28");
    const res = await restoreBackupSnapshot(snapDir, restoreDest, {
      rebindInternalReferences: false,
    });

    expect(res.databaseTransformed).toBe(false);
    expect(res.internalReferencesDiscovered).toBe(2);
    expect(res.internalReferencesRebound).toBe(0);
    expect(res.internalReferencesUnresolved).toBe(2);
    expect(res.activationReadiness).not.toBe("ready");
    expect(res.activationReadiness).toBe("requires-reference-repair");
  });
});
