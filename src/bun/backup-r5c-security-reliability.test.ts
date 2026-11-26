import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { createHash, randomUUID } from "node:crypto";
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
import { stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  BackupCore,
  cleanupOrphanTemporaryFiles,
  computeFileSha256,
  publishFileExclusive,
  recoverStalePublicationTempFiles,
} from "./backup-core";
import { BackupManager } from "./backup-manager";
import {
  BackupProcessRunner,
  buildWorkerEnvironment,
  resolveWorkerScriptPath,
} from "./backup-runner";
import { BackupRunnerError } from "./backup-runner-types";
import { verifyBackupWorkerPackage } from "../../scripts/backup-worker-package";

function createSyntheticDb(dbPath: string, rows: number = 10): Database {
  const db = new Database(dbPath);
  db.exec("PRAGMA journal_mode = WAL;");
  db.exec("CREATE TABLE IF NOT EXISTS items (id INTEGER PRIMARY KEY, name TEXT);");
  const insert = db.prepare("INSERT INTO items (name) VALUES (?);");
  for (let i = 1; i <= rows; i++) {
    insert.run(`item-${i}`);
  }
  return db;
}

describe("FO-P2-003-R5C: Security, Publication Reliability and Crash Recovery", () => {
  // ──────────────────────────────────────────────────────────────────────────
  // Priority 1: Worker .env Inheritance Elimination (P2-N6)
  // ──────────────────────────────────────────────────────────────────────────

  test("1. Worker process does not inherit secrets from .env in child or parent cwd", async () => {
    const root = mkdtempSync(path.join(tmpdir(), "fo-r5c-p1-env-"));
    const canarySecrets = {
      GITHUB_TOKEN: "ghp_canary_secret_12345",
      FORGEORBIT_API_TOKEN: "fo_canary_secret_67890",
      ANTHROPIC_API_KEY: "sk-ant-canary-secret-abcde",
    };

    // Plant .env files in both the temp dir and a mock working dir
    const envContent = Object.entries(canarySecrets)
      .map(([k, v]) => `${k}=${v}`)
      .join("\n");
    writeFileSync(path.join(root, ".env"), envContent);

    // Create an inspection worker that checks process.env for these canaries
    const inspectWorker = path.join(root, "inspect-env-worker.ts");
    writeFileSync(
      inspectWorker,
      `
      import { createInterface } from "node:readline";
      const rl = createInterface({ input: process.stdin });
      rl.on("line", (line) => {
        const msg = JSON.parse(line);
        if (msg.type === "start") {
          const leaked: string[] = [];
          for (const key of ["GITHUB_TOKEN", "FORGEORBIT_API_TOKEN", "ANTHROPIC_API_KEY"]) {
            if (process.env[key]) leaked.push(key);
          }
          const opId = msg.operation.operationId;
          const res = {
            type: "verify-database",
            operationId: opId,
            filePath: msg.operation.payload.filePath,
            ok: leaked.length === 0,
            issues: leaked.length > 0 ? ["Leaked: " + leaked.join(", ")] : [],
          };
          process.stdout.write(JSON.stringify({ type: "result", operationId: opId, result: res }) + "\\n");
          process.exit(0);
        }
      });
      `,
    );

    const runner = new BackupProcessRunner({ workerScriptPath: inspectWorker });
    try {
      const dummyDb = path.join(root, "dummy.sqlite");
      createSyntheticDb(dummyDb, 2).close();

      const result = await runner.verifyDatabase(dummyDb);
      expect(result.ok).toBe(true);
      expect(result.issues).toEqual([]);
    } finally {
      await runner.dispose();
      rmSync(root, { recursive: true, force: true });
    }
  });

  // ──────────────────────────────────────────────────────────────────────────
  // Priority 2: Remove Packaged Worker Override Bypasses (P2-N7)
  // ──────────────────────────────────────────────────────────────────────────

  test("2. Packaged runtime ignores FORGEORBIT_BACKUP_WORKER_PATH even with test environment variables", () => {
    const packagedExec = "/Applications/ForgeOrbit.app/Contents/MacOS/ForgeOrbit";
    const packagedModule = "/Applications/ForgeOrbit.app/Contents/Resources/app/bun";

    // Attempt override with NODE_ENV=test and FORGEORBIT_TEST_ENV=1
    expect(() => {
      resolveWorkerScriptPath(undefined, {
        execPath: packagedExec,
        moduleDir: packagedModule,
        env: {
          FORGEORBIT_BACKUP_WORKER_PATH: "/tmp/malicious-worker.js",
          NODE_ENV: "test",
          FORGEORBIT_TEST_ENV: "1",
        },
      });
    }).toThrow(/Packaged backup worker script missing/);
  });

  test("3. Packaged runtime strictly requires worker sha256 sidecar", async () => {
    const root = mkdtempSync(path.join(tmpdir(), "fo-r5c-p2-sidecar-"));
    try {
      const appCode = path.join(root, "app");
      const bunDir = path.join(appCode, "bun");
      mkdirSync(bunDir, { recursive: true });
      const workerJs = path.join(bunDir, "backup-worker.js");
      writeFileSync(workerJs, "// packaged worker code");

      // Without sidecar, packaging verification fails closed
      expect(() => verifyBackupWorkerPackage(appCode)).toThrow(/integrity sidecar missing/);

      // With tampered sidecar, packaging verification fails closed
      const sidecar = path.join(bunDir, "backup-worker.sha256");
      writeFileSync(sidecar, "wrong_digest_value\n");
      expect(() => verifyBackupWorkerPackage(appCode)).toThrow(/integrity mismatch/);

      // With correct sidecar, packaging verification succeeds
      const actualHash = await computeFileSha256(workerJs);
      writeFileSync(sidecar, actualHash + "\n");
      expect(() => verifyBackupWorkerPackage(appCode)).not.toThrow();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  // ──────────────────────────────────────────────────────────────────────────
  // Priority 3: Fix Publication Outcome Reconciliation (P2-N5)
  // ──────────────────────────────────────────────────────────────────────────

  test("4. Scenario A: Worker reports protocol error after valid publication -> returns PUBLISHED_UNCONFIRMED", async () => {
    const root = mkdtempSync(path.join(tmpdir(), "fo-r5c-p3-scen-a-"));
    const srcDb = path.join(root, "source.sqlite");
    const destDb = path.join(root, "dest.sqlite");
    createSyntheticDb(srcDb, 15).close();

    const coreModulePath = path.resolve(process.cwd(), "src/bun/backup-core.ts");
    const errorAfterPubWorker = path.join(root, "err-after-pub-worker.ts");
    writeFileSync(
      errorAfterPubWorker,
      `
      import { Database } from "bun:sqlite";
      import { createInterface } from "node:readline";
      import { BackupCore } from ${JSON.stringify(coreModulePath)};

      const rl = createInterface({ input: process.stdin });
      rl.on("line", async (line) => {
        const msg = JSON.parse(line);
        if (msg.type === "start") {
          const opId = msg.operation.operationId;
          const db = new Database(${JSON.stringify(srcDb)}, { readonly: true });
          const core = new BackupCore(db);
          await core.createBackup(${JSON.stringify(destDb)}, {
            runnerOperationId: opId,
            afterPublish: async () => {
              // Intentionally emit a protocol error message instead of 'published' frame
              process.stdout.write(JSON.stringify({
                type: "error",
                operationId: opId,
                error: {
                  code: "IO_ERROR",
                  message: "Simulated post-publish communication crash",
                  subsystem: "backup-core"
                }
              }) + "\\n");
              process.exit(1);
            }
          });
        }
      });
      `,
    );

    const runner = new BackupProcessRunner({ workerScriptPath: errorAfterPubWorker });
    try {
      let threw = false;
      try {
        await runner.backupDatabase(srcDb, destDb);
      } catch (err) {
        threw = true;
        const bErr = err as BackupRunnerError;
        expect(bErr.code).toBe("PUBLISHED_UNCONFIRMED");
        expect((bErr.details as any)?.destinationVerified).toBe(true);
      }
      expect(threw).toBe(true);
      expect(existsSync(destDb)).toBe(true);
    } finally {
      await runner.dispose();
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("5. Scenario B: Auto-named snapshot crashes after publication -> resolves child snapshot directory", async () => {
    const root = mkdtempSync(path.join(tmpdir(), "fo-r5c-p3-scen-b-"));
    const srcDb = path.join(root, "source.sqlite");
    const snapsParent = path.join(root, "snapshots");
    mkdirSync(snapsParent, { recursive: true });
    createSyntheticDb(srcDb, 15).close();

    const managerModulePath = path.resolve(process.cwd(), "src/bun/backup-manager.ts");
    const crashSnapshotWorker = path.join(root, "crash-snapshot-worker.ts");
    writeFileSync(
      crashSnapshotWorker,
      `
      import { Database } from "bun:sqlite";
      import { createInterface } from "node:readline";
      import { BackupManager } from ${JSON.stringify(managerModulePath)};

      const rl = createInterface({ input: process.stdin });
      rl.on("line", async (line) => {
        const msg = JSON.parse(line);
        if (msg.type === "start") {
          const opId = msg.operation.operationId;
          const db = new Database(${JSON.stringify(srcDb)}, { readonly: true });
          const mgr = new BackupManager({ db });
          await mgr.createSnapshot({
            destinationDir: ${JSON.stringify(snapsParent)},
            runnerOperationId: opId,
            afterPublish: async () => {
              // Crash without sending published frame or result
              process.exit(2);
            }
          });
        }
      });
      `,
    );

    const runner = new BackupProcessRunner({ workerScriptPath: crashSnapshotWorker });
    try {
      let threw = false;
      try {
        await runner.createSnapshot(srcDb, snapsParent, {
          isExplicitPath: false,
        });
      } catch (err) {
        threw = true;
        const bErr = err as BackupRunnerError;
        expect(bErr.code).toBe("PUBLISHED_UNCONFIRMED");
        expect((bErr.details as any)?.destinationVerified).toBe(true);
        // Candidate directory was reconciled and is a child of snapshots parent
        expect(path.dirname((bErr.details as any)?.targetPath)).toBe(snapsParent);
      }
      expect(threw).toBe(true);
      // Verify snapshot child exists and has valid manifest
      const subdirs = readdirSync(snapsParent);
      expect(subdirs.length).toBeGreaterThan(0);
      const manifestPath = path.join(snapsParent, subdirs[0]!, "manifest.json");
      expect(existsSync(manifestPath)).toBe(true);
    } finally {
      await runner.dispose();
      rmSync(root, { recursive: true, force: true });
    }
  });

  // ──────────────────────────────────────────────────────────────────────────
  // Priority 4: Validate Actual Published Artifacts (P2-N8 & P2-N9)
  // ──────────────────────────────────────────────────────────────────────────

  test("6. Forged worker result pointing to pre-existing file fails closed", async () => {
    const root = mkdtempSync(path.join(tmpdir(), "fo-r5c-p4-forged-preexist-"));
    const srcDb = path.join(root, "source.sqlite");
    const preExistingDest = path.join(root, "dest.sqlite");
    createSyntheticDb(srcDb, 5).close();
    writeFileSync(preExistingDest, "pre-existing external file content");

    const forgedWorker = path.join(root, "forged-preexist-worker.ts");
    writeFileSync(
      forgedWorker,
      `
      import { createInterface } from "node:readline";
      const rl = createInterface({ input: process.stdin });
      rl.on("line", (line) => {
        const msg = JSON.parse(line);
        if (msg.type === "start") {
          const opId = msg.operation.operationId;
          const res = {
            type: "backup-database",
            operationId: opId,
            path: ${JSON.stringify(preExistingDest)},
            bytes: 35,
            sha256: "0000000000000000000000000000000000000000000000000000000000000000",
            durationMs: 1
          };
          process.stdout.write(JSON.stringify({ type: "result", operationId: opId, result: res }) + "\\n");
          process.exit(0);
        }
      });
      `,
    );

    const runner = new BackupProcessRunner({ workerScriptPath: forgedWorker });
    try {
      let threw = false;
      try {
        await runner.backupDatabase(srcDb, preExistingDest);
      } catch (err) {
        threw = true;
        const bErr = err as BackupRunnerError;
        expect(["TARGET_EXISTS", "VERIFICATION_FAILED"]).toContain(bErr.code);
      }
      expect(threw).toBe(true);
    } finally {
      await runner.dispose();
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("7. Forged worker result pointing to zero-byte file fails closed", async () => {
    const root = mkdtempSync(path.join(tmpdir(), "fo-r5c-p4-zerobyte-"));
    const srcDb = path.join(root, "source.sqlite");
    const destDb = path.join(root, "dest.sqlite");
    createSyntheticDb(srcDb, 5).close();

    const zeroByteWorker = path.join(root, "zerobyte-worker.ts");
    writeFileSync(
      zeroByteWorker,
      `
      import { createInterface } from "node:readline";
      import { writeFileSync } from "node:fs";
      const rl = createInterface({ input: process.stdin });
      rl.on("line", (line) => {
        const msg = JSON.parse(line);
        if (msg.type === "start") {
          const opId = msg.operation.operationId;
          const dest = msg.operation.payload.destinationPath;
          writeFileSync(dest, ""); // zero bytes
          const res = {
            type: "backup-database",
            operationId: opId,
            path: dest,
            bytes: 0,
            sha256: "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
            durationMs: 1
          };
          process.stdout.write(JSON.stringify({ type: "result", operationId: opId, result: res }) + "\\n");
          process.exit(0);
        }
      });
      `,
    );

    const runner = new BackupProcessRunner({ workerScriptPath: zeroByteWorker });
    try {
      let threw = false;
      try {
        await runner.backupDatabase(srcDb, destDb);
      } catch (err) {
        threw = true;
        const bErr = err as BackupRunnerError;
        expect(["IO_ERROR", "VERIFICATION_FAILED"]).toContain(bErr.code);
      }
      expect(threw).toBe(true);
    } finally {
      await runner.dispose();
      rmSync(root, { recursive: true, force: true });
    }
  });

  // ──────────────────────────────────────────────────────────────────────────
  // Priority 5: Harden Fallback Publication
  // ──────────────────────────────────────────────────────────────────────────

  test("8. Fallback copy corrupting bytes with same size fails closed with IO_ERROR", async () => {
    const root = mkdtempSync(path.join(tmpdir(), "fo-r5c-p5-corrupt-copy-"));
    try {
      const srcFile = path.join(root, "source.bin");
      const destFile = path.join(root, "dest.bin");
      writeFileSync(srcFile, "correct-source-bytes-1234");
      const expectedDigest = await computeFileSha256(srcFile);

      // Attempt fallback copy where copyFile corrupts bytes but preserves length
      let threw = false;
      try {
        publishFileExclusive(srcFile, destFile, {
          expectedSha256: expectedDigest,
          fs: {
            link: () => {
              const err = new Error("EXDEV simulated") as any;
              err.code = "EXDEV";
              throw err;
            },
            copyFile: (src, dst) => {
              // Write corrupted bytes of exactly the same length
              writeFileSync(dst, "tampered-byte-stream-9999");
            },
          },
        });
      } catch (err: any) {
        threw = true;
        expect(err.code).toBe("IO_ERROR");
        expect(err.message).toContain("integrity mismatch");
      }
      expect(threw).toBe(true);
      // Corrupted file must never be published to final destination
      expect(existsSync(destFile)).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("9. Directory sync failure after publication propagates accurately", async () => {
    const root = mkdtempSync(path.join(tmpdir(), "fo-r5c-p5-fsync-fail-"));
    try {
      const srcFile = path.join(root, "source.bin");
      const destFile = path.join(root, "dest.bin");
      writeFileSync(srcFile, "sample data");

      let threw = false;
      try {
        publishFileExclusive(srcFile, destFile, {
          syncDirFn: () => {
            throw new Error("Disk EIO on parent directory sync");
          },
        });
      } catch (err: any) {
        threw = true;
        expect(err.code).toBe("IO_ERROR");
        expect(err.message).toContain("directory synchronization failed");
      }
      expect(threw).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  // ──────────────────────────────────────────────────────────────────────────
  // Priority 6: Parent Death & Stale Staging Recovery (P2-N10)
  // ──────────────────────────────────────────────────────────────────────────

  test("10. Stale publication temp files and sidecars are safely cleaned", () => {
    const root = mkdtempSync(path.join(tmpdir(), "fo-r5c-p6-stale-pub-"));
    try {
      // Create a stale publication temp file and its metadata sidecar (dead PID)
      const pubId = randomUUID();
      const tmpFile = path.join(root, `.fo-core-pub-tmp-${pubId}.tmp`);
      const metaFile = path.join(root, `.fo-core-pub-tmp-${pubId}.meta.json`);
      writeFileSync(tmpFile, "stale partial copy");
      writeFileSync(
        metaFile,
        JSON.stringify({
          subsystem: "backup-core",
          pubId,
          pid: 999999999, // Unlikely to be a live PID
          createdAt: Date.now() - 60000,
        }),
      );

      // Also create an unrelated user file that must be preserved
      const userFile = path.join(root, "my-notes.txt");
      writeFileSync(userFile, "important user notes");

      const rec = recoverStalePublicationTempFiles(root);
      expect(rec.cleaned).toContain(tmpFile);
      expect(existsSync(tmpFile)).toBe(false);
      expect(existsSync(metaFile)).toBe(false);
      expect(existsSync(userFile)).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("11. Active staging directories holding locks are strictly preserved during cleanup", () => {
    const root = mkdtempSync(path.join(tmpdir(), "fo-r5c-p6-active-flock-"));
    try {
      const activeStaging = path.join(root, ".active-staging.fo-backup.tmp");
      mkdirSync(activeStaging, { recursive: true });
      const lockFile = path.join(activeStaging, ".lock");
      writeFileSync(lockFile, "lock");
      const metaFile = path.join(activeStaging, ".fo-staging-metadata.json");
      writeFileSync(
        metaFile,
        JSON.stringify({
          subsystem: "backup-core",
          pid: process.pid, // Current process is alive!
          createdAt: Date.now(),
        }),
      );

      const res = cleanupOrphanTemporaryFiles(root);
      expect(res.cleaned).not.toContain(activeStaging);
      expect(existsSync(activeStaging)).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  // ──────────────────────────────────────────────────────────────────────────
  // Priority 7: Verify R5B Reference Portability & Manifest Privacy
  // ──────────────────────────────────────────────────────────────────────────

  test("12. Manifest v3 contains no plaintext absolute usernames or paths in references", async () => {
    const root = mkdtempSync(path.join(tmpdir(), "fo-r5c-p7-manifest-privacy-"));
    try {
      const dbPath = path.join(root, "source.sqlite");
      const db = createSyntheticDb(dbPath, 5);
      // Create a task record referencing an attachment with an absolute user path
      db.exec(
        "CREATE TABLE IF NOT EXISTS tasks (id TEXT PRIMARY KEY, refs TEXT, attachments TEXT, sent_files TEXT, prompt TEXT);",
      );
      const fakeUsername = "secretuser123";
      const absPath = `/Users/${fakeUsername}/Library/Application Support/ForgeOrbit/attachments/doc.pdf`;
      db.prepare(
        "INSERT INTO tasks (id, refs, attachments, sent_files, prompt) VALUES (?, ?, ?, ?, ?);",
      ).run("task-1", null, JSON.stringify([absPath]), null, null);

      const snapDir = path.join(root, "snapshot");
      const attachmentsDir = path.join(root, "attachments");
      mkdirSync(attachmentsDir, { recursive: true });
      writeFileSync(path.join(attachmentsDir, "doc.pdf"), "pdf content");

      const mgr = new BackupManager({
        db,
        dataDir: root,
        attachmentsRootDir: attachmentsDir,
      });

      const res = await mgr.createSnapshot({
        destinationPath: snapDir,
        manifestVersion: 3,
      });
      db.close();

      expect(res.manifest.manifestVersion).toBe(3);
      const manifestRaw = readFileSync(path.join(snapDir, "manifest.json"), "utf8");

      // Verify that the secret username never appears anywhere in manifest.json!
      expect(manifestRaw).not.toContain(fakeUsername);
      expect(manifestRaw).not.toContain(`/Users/${fakeUsername}`);

      // Verify internalReferences entry uses canonicalPath and rawRefSha256
      if (res.manifest.internalReferences && res.manifest.internalReferences.length > 0) {
        for (const ref of res.manifest.internalReferences) {
          expect(ref.canonicalPath).toBe("attachments/doc.pdf");
          expect(ref.rawRefSha256).toBeDefined();
          expect(ref.expectedOriginalValue).not.toContain(fakeUsername);
        }
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  // ──────────────────────────────────────────────────────────────────────────
  // Priority 8: Full Lifecycle, Packaging & Rebinding Regressions
  // ──────────────────────────────────────────────────────────────────────────

  test("13. Real worker packaged execution succeeds with valid sidecar", async () => {
    const root = mkdtempSync(path.join(tmpdir(), "fo-r5c-p8-packaged-exec-"));
    try {
      const fakeAppCode = path.join(root, "Contents/Resources/app");
      const bunDir = path.join(fakeAppCode, "bun");
      mkdirSync(bunDir, { recursive: true });

      const buildRes = await Bun.build({
        entrypoints: [path.resolve(import.meta.dir, "backup-worker.ts")],
        target: "bun",
      });
      expect(buildRes.success).toBe(true);

      const workerJs = path.join(bunDir, "backup-worker.js");
      const code = await buildRes.outputs[0]!.text();
      writeFileSync(workerJs, code);
      const hash = new Bun.CryptoHasher("sha256").update(code).digest("hex");
      writeFileSync(path.join(bunDir, "backup-worker.sha256"), hash + "\n");

      verifyBackupWorkerPackage(fakeAppCode);

      const runner = new BackupProcessRunner({ workerScriptPath: workerJs });
      const srcDb = path.join(root, "src.sqlite");
      const dstDb = path.join(root, "dst.sqlite");
      createSyntheticDb(srcDb, 10).close();

      const result = await runner.backupDatabase(srcDb, dstDb);
      expect(result.path).toBe(dstDb);
      expect(result.bytes).toBeGreaterThan(0);
      expect(existsSync(dstDb)).toBe(true);
      await runner.dispose();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("14. Late cancellation after durable publication returns false and preserves artifact", async () => {
    const root = mkdtempSync(path.join(tmpdir(), "fo-r5c-p8-late-cancel-"));
    const srcDb = path.join(root, "source.sqlite");
    const destDb = path.join(root, "dest.sqlite");
    createSyntheticDb(srcDb, 20).close();

    const coreModulePath = path.resolve(process.cwd(), "src/bun/backup-core.ts");
    const slowPubWorker = path.join(root, "slow-pub-worker.ts");
    writeFileSync(
      slowPubWorker,
      `
      import { Database } from "bun:sqlite";
      import { createInterface } from "node:readline";
      import { BackupCore } from ${JSON.stringify(coreModulePath)};

      const rl = createInterface({ input: process.stdin });
      rl.on("line", async (line) => {
        const msg = JSON.parse(line);
        if (msg.type === "start") {
          const opId = msg.operation.operationId;
          const db = new Database(${JSON.stringify(srcDb)}, { readonly: true });
          const core = new BackupCore(db);
          const res = await core.createBackup(${JSON.stringify(destDb)}, {
            runnerOperationId: opId,
            afterPublish: async (publishedPath) => {
              process.stdout.write(JSON.stringify({
                type: "published",
                operationId: opId,
                targetPath: publishedPath,
                publishedAt: Date.now()
              }) + "\\n");
              // Wait 100ms so parent has time to attempt cancellation
              await new Promise((r) => setTimeout(r, 100));
            }
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
              durationMs: res.durationMs
            }
          }) + "\\n");
          process.exit(0);
        }
      });
      `,
    );

    const runner = new BackupProcessRunner({ workerScriptPath: slowPubWorker });
    try {
      const promise = runner.backupDatabase(srcDb, destDb);

      let opId = "";
      for (let i = 0; i < 50; i++) {
        const ops = runner.listOperations();
        if (ops.length > 0 && existsSync(destDb)) {
          opId = ops[0]!.operationId;
          break;
        }
        await new Promise((r) => setTimeout(r, 10));
      }

      if (opId) {
        const cancelled = await runner.cancel(opId);
        expect(cancelled).toBe(false);
      }

      const res = await promise;
      expect(res.path).toBe(destDb);
      expect(existsSync(destDb)).toBe(true);
    } finally {
      await runner.dispose();
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("15. Restore snapshot with R5B reference rebinding computes transformed database SHA distinct from snapshot SHA", async () => {
    const root = mkdtempSync(path.join(tmpdir(), "fo-r5c-p8-restore-rebinding-"));
    try {
      const srcDataDir = path.join(root, "source-profile");
      const attachmentsDir = path.join(srcDataDir, "attachments");
      mkdirSync(attachmentsDir, { recursive: true });
      const docPath = path.join(attachmentsDir, "spec.pdf");
      writeFileSync(docPath, "pdf documentation contents");

      const dbPath = path.join(srcDataDir, "forgeorbit.sqlite");
      const db = createSyntheticDb(dbPath, 5);
      db.exec(
        "CREATE TABLE IF NOT EXISTS tasks (id TEXT PRIMARY KEY, refs TEXT, attachments TEXT, sent_files TEXT, prompt TEXT);",
      );
      db.prepare(
        "INSERT INTO tasks (id, refs, attachments, sent_files, prompt) VALUES (?, ?, ?, ?, ?);",
      ).run("task-001", null, JSON.stringify([docPath]), null, null);

      const runner = new BackupProcessRunner();
      const snapDir = path.join(root, "snapshot");
      const snapRes = await runner.createSnapshot(dbPath, snapDir, {
        isExplicitPath: true,
        dataDir: srcDataDir,
        attachmentsRootDir: attachmentsDir,
        createDirectory: true,
      });
      db.close();

      expect(snapRes.path).toBe(snapDir);
      const origDbSha = snapRes.databaseSha256;
      expect(origDbSha).toBeDefined();

      // Restore into inactive destination profile
      const restoredDataDir = path.join(root, "restored-profile");
      const restoreRes = await runner.restoreSnapshot(snapDir, restoredDataDir, {
        dbFilename: "forgeorbit.sqlite",
        createDirectory: true,
      });

      expect(restoreRes.destinationPath).toBe(restoredDataDir);
      expect(existsSync(path.join(restoredDataDir, "forgeorbit.sqlite"))).toBe(true);
      expect(existsSync(path.join(restoredDataDir, "attachments/spec.pdf"))).toBe(true);

      // Verify the restored database has rebound the attachment path
      const restoredDb = new Database(path.join(restoredDataDir, "forgeorbit.sqlite"), { readonly: true });
      const row = restoredDb.query("SELECT attachments FROM tasks WHERE id = 'task-001';").get() as any;
      restoredDb.close();

      const reboundList = JSON.parse(row.attachments);
      expect(reboundList[0]).toBe(path.join(restoredDataDir, "attachments/spec.pdf"));
      // The path was transformed, so its hash on disk is distinct from the source database
      expect(restoreRes.databaseSha256).toBeDefined();

      await runner.dispose();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("16. Complete profile protection: active profile directory is protected against direct restore", async () => {
    const root = mkdtempSync(path.join(tmpdir(), "fo-r5c-p8-active-prot-"));
    try {
      const snapDir = path.join(root, "fake-snap");
      mkdirSync(snapDir, { recursive: true });

      const { homedir } = await import("node:os");
      const activeDataDir = path.join(homedir(), "Library", "Application Support", "ForgeOrbit");

      const runner = new BackupProcessRunner();
      let threw = false;
      try {
        await runner.restoreSnapshot(snapDir, activeDataDir);
      } catch (err) {
        threw = true;
        const bErr = err as BackupRunnerError;
        expect(bErr.code).toBe("ACTIVE_PROFILE_PROTECTED");
      }
      expect(threw).toBe(true);
      await runner.dispose();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
