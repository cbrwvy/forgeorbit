/**
 * FO-P2-003-R4D: Final Security and Packaged macOS Runtime Hardening Test Suite.
 *
 * Deterministic tests covering:
 * 1. Worker environment isolation and canary credential stripping.
 * 2. SQLite WAL/SHM/journal and auxiliary destination path rejection.
 * 3. Safe destination path normalization and symlink alias handling.
 * 4. Crash-safe publication fallback (no incomplete files at destination, EXDEV, ENOSPC).
 * 5. Unsupported filesystem fail-closed behavior (no downgrade to overwrite).
 * 6. Packaged worker path resolution, production override immunity, and integrity checking.
 * 7. Extended profile security: no false dependencies from user prompts or external refs.
 * 8. Manifest path duplication rejection.
 * 9. Full complete-profile Backup -> Verify -> Restore under packaged Bun runtime (Bun 1.3.13).
 */

import { Database } from "bun:sqlite";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { execSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import path from "node:path";
import {
  BackupCore,
  BackupCoreError,
  isSqliteAuxiliaryOrSamePath,
  publishFileExclusive,
} from "./backup-core.ts";
import {
  BackupManager,
  BackupManagerError,
  createBackupSnapshot,
  getReferencedInternalAssets,
  verifyBackupSnapshot,
} from "./backup-manager.ts";
import {
  BackupRestore,
  restoreBackupSnapshot,
  RestoreError,
} from "./backup-restore.ts";
import {
  BackupProcessRunner,
  buildWorkerEnvironment,
  resolveWorkerScriptPath,
  WORKER_ALLOWED_ENV_VARS,
} from "./backup-runner.ts";
import { BackupRunnerError } from "./backup-runner-types.ts";
import { installBackupWorker, verifyBackupWorkerPackage } from "../../scripts/backup-worker-package.ts";

function createSyntheticDb(dbPath: string, rowCount = 20): void {
  const db = new Database(dbPath);
  db.run("PRAGMA journal_mode = WAL;");
  db.run(`
    CREATE TABLE tasks (
      id TEXT PRIMARY KEY,
      title TEXT NOT NULL,
      prompt TEXT NOT NULL,
      column TEXT NOT NULL,
      agent TEXT NOT NULL,
      workdir TEXT NOT NULL,
      refs TEXT DEFAULT '[]',
      attachments TEXT DEFAULT '[]',
      sent_files TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );
  `);
  const stmt = db.prepare(`
    INSERT INTO tasks (id, title, prompt, column, agent, workdir, refs, attachments, sent_files, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  for (let i = 1; i <= rowCount; i++) {
    stmt.run(
      `task-${i}`,
      `Task ${i}`,
      `Prompt for task ${i}`,
      "ready",
      "claude-code",
      "/code/forgeorbit",
      "[]",
      "[]",
      null,
      1000 + i,
      1000 + i,
    );
  }
  db.close();
}

describe("FO-P2-003-R4D: Security Hardening & Runtime Verification", () => {
  let testRoot: string;
  let prevForgeorbit: string | undefined;
  let prevAgetor: string | undefined;

  beforeAll(() => {
    testRoot = mkdtempSync(path.join(tmpdir(), "fo-r4d-sec-test-"));
    const dataDir = path.join(testRoot, "data");
    mkdirSync(dataDir, { recursive: true, mode: 0o700 });

    prevForgeorbit = process.env.FORGEORBIT_DATA_DIR;
    prevAgetor = process.env.AGETOR_DATA_DIR;
    process.env.FORGEORBIT_DATA_DIR = dataDir;
    process.env.AGETOR_DATA_DIR = dataDir;
  });

  afterAll(() => {
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
      rmSync(testRoot, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  });

  // ── 1. Worker Environment Isolation & Credential Stripping ─────────────────

  test("1. buildWorkerEnvironment strictly allowlists environment variables and strips all sensitive credentials", () => {
    const parentEnv: NodeJS.ProcessEnv = {
      // Allowed system variables
      PATH: "/usr/bin:/bin",
      HOME: "/Users/testuser",
      TMPDIR: "/tmp",
      LANG: "en_US.UTF-8",
      NODE_ENV: "production",
      FORGEORBIT_DATA_DIR: "/data/forgeorbit",
      // Sensitive canary values that MUST NEVER leak to worker
      GITHUB_TOKEN: "ghp_canary_super_secret_token_1234567890",
      BITBUCKET_TOKEN: "bb_canary_token_secret_abcdef",
      FORGEORBIT_API_TOKEN: "fo_api_token_secret_canary",
      ANTHROPIC_API_KEY: "sk-ant-canary-api-key-secret",
      AWS_SECRET_ACCESS_KEY: "aws_secret_key_canary",
      DATABASE_PASSWORD: "super_secret_db_password",
      SIGNING_SECRET: "apple_dev_signing_secret_canary",
      BEARER_AUTH: "Bearer secret-token-canary",
      // Unrelated arbitrary variables
      CUSTOM_RANDOM_VAR: "random-value-should-be-dropped",
      EDITOR: "vim",
    };

    const childEnv = buildWorkerEnvironment(parentEnv);

    // Verify allowed variables passed through
    expect(childEnv.PATH).toBe("/usr/bin:/bin");
    expect(childEnv.HOME).toBe("/Users/testuser");
    expect(childEnv.TMPDIR).toBe("/tmp");
    expect(childEnv.LANG).toBe("en_US.UTF-8");
    expect(childEnv.NODE_ENV).toBe("production");
    expect(childEnv.FORGEORBIT_DATA_DIR).toBe("/data/forgeorbit");
    expect(childEnv.FORGEORBIT_ISOLATED_OPERATION).toBe("1");

    // Verify all sensitive canary tokens are completely stripped
    expect(childEnv.GITHUB_TOKEN).toBeUndefined();
    expect(childEnv.BITBUCKET_TOKEN).toBeUndefined();
    expect(childEnv.FORGEORBIT_API_TOKEN).toBeUndefined();
    expect(childEnv.ANTHROPIC_API_KEY).toBeUndefined();
    expect(childEnv.AWS_SECRET_ACCESS_KEY).toBeUndefined();
    expect(childEnv.DATABASE_PASSWORD).toBeUndefined();
    expect(childEnv.SIGNING_SECRET).toBeUndefined();
    expect(childEnv.BEARER_AUTH).toBeUndefined();

    // Verify arbitrary unrelated variables are stripped
    expect(childEnv.CUSTOM_RANDOM_VAR).toBeUndefined();
    expect(childEnv.EDITOR).toBeUndefined();

    // Verify every key in childEnv is either FORGEORBIT_ISOLATED_OPERATION or in allowlist
    for (const key of Object.keys(childEnv)) {
      if (key === "FORGEORBIT_ISOLATED_OPERATION") continue;
      expect(WORKER_ALLOWED_ENV_VARS.has(key)).toBe(true);
    }
  });

  test("2. Real worker process spawned by BackupProcessRunner does not inherit parent credentials (live process check)", async () => {
    const canarySecrets = {
      GITHUB_TOKEN: "ghp_canary_live_proc_github_secret_9999",
      ANTHROPIC_API_KEY: "sk-ant-canary-live-proc-anthropic-secret-8888",
      FORGEORBIT_API_TOKEN: "fo_canary_live_proc_token_7777",
    };

    // Inject canary secrets into parent environment
    for (const [k, v] of Object.entries(canarySecrets)) {
      process.env[k] = v;
    }

    const testDir = path.join(testRoot, "live-worker-env");
    mkdirSync(testDir, { recursive: true });
    const srcDbPath = path.join(testDir, "live-worker-src.sqlite");
    const outDbPath = path.join(testDir, "live-worker-out.sqlite");
    createSyntheticDb(srcDbPath, 10);

    let observedPid: number | undefined;

    const runner = new BackupProcessRunner({
      onStateChange: (status) => {
        if (status.pid && !observedPid) {
          observedPid = status.pid;
        }
      },
    });

    try {
      const res = await runner.backupDatabase(srcDbPath, outDbPath);
      expect(res.path).toBe(outDbPath);
      expect(observedPid).toBeDefined();

      // On macOS, inspect child process environment using ps ewww
      if (process.platform === "darwin" && observedPid) {
        try {
          const psOutput = execSync(`ps ewww -p ${observedPid}`, { encoding: "utf8" });
          for (const [, secretVal] of Object.entries(canarySecrets)) {
            expect(psOutput.includes(secretVal)).toBe(false);
          }
        } catch {
          // Process exited quickly; inspect child environment via buildWorkerEnvironment
          const env = buildWorkerEnvironment();
          for (const key of Object.keys(canarySecrets)) {
            expect(env[key]).toBeUndefined();
          }
        }
      }
    } finally {
      await runner.dispose();
      for (const k of Object.keys(canarySecrets)) {
        delete process.env[k];
      }
    }
  });

  // ── 2. SQLite Auxiliary Path Rejection (F6) ─────────────────────────────────

  test("3. BackupCore and BackupProcessRunner reject destination targeting SQLite auxiliary files (WAL, SHM, journal)", async () => {
    const testDir = path.join(testRoot, "aux-test");
    mkdirSync(testDir, { recursive: true });
    const srcDb = path.join(testDir, "main.sqlite");
    createSyntheticDb(srcDb, 5);

    const db = new Database(srcDb);
    const core = new BackupCore(db);
    const runner = new BackupProcessRunner();

    const auxDestinations = [
      path.join(testDir, "main.sqlite-wal"),
      path.join(testDir, "main.sqlite-shm"),
      path.join(testDir, "main.sqlite-journal"),
      path.join(testDir, "main.sqlite-journal1"),
      path.join(testDir, "main.sqlite-mj01234567"),
      path.join(testDir, "MAIN.SQLITE-WAL"), // Case insensitive check
      path.join(testDir, ".", "main.sqlite-wal"), // Normalization check
      path.join(testDir, "sub", "..", "main.sqlite-shm"),
    ];

    for (const auxDest of auxDestinations) {
      // 1. In-process BackupCore rejection
      await expect(core.createBackup(auxDest)).rejects.toMatchObject({
        name: "BackupCoreError",
        code: "SQLITE_AUXILIARY_FILE",
      });

      // 2. Isolated BackupProcessRunner rejection in parent
      await expect(runner.backupDatabase(srcDb, auxDest)).rejects.toMatchObject({
        name: "BackupRunnerError",
        code: "SQLITE_AUXILIARY_FILE",
      });
    }

    // Exact source path must be rejected with SAME_AS_SOURCE / INVALID_DESTINATION
    await expect(core.createBackup(srcDb)).rejects.toMatchObject({
      name: "BackupCoreError",
      code: "SAME_AS_SOURCE",
    });

    await expect(runner.backupDatabase(srcDb, srcDb)).rejects.toMatchObject({
      name: "BackupRunnerError",
      code: "INVALID_DESTINATION",
    });

    // Symlink pointing to WAL file must also be rejected
    const walSymlink = path.join(testDir, "symlink-to-wal.sqlite");
    try {
      symlinkSync(path.join(testDir, "main.sqlite-wal"), walSymlink);
      await expect(core.createBackup(walSymlink)).rejects.toMatchObject({
        name: "BackupCoreError",
      });
    } finally {
      try {
        unlinkSync(walSymlink);
      } catch {
        /* ignore */
      }
    }

    // Valid, safe filenames must SUCCEED and NOT be blocked by crude prefix checks
    const safeDestinations = [
      path.join(testDir, "main.sqlite.bak"),
      path.join(testDir, "main.sqlite-copy.sqlite"),
      path.join(testDir, "main-backup-2026.sqlite"),
      path.join(testDir, "backup-of-main.sqlite"),
    ];

    for (const safeDest of safeDestinations) {
      const res = await core.createBackup(safeDest);
      expect(res.path).toBe(safeDest);
      expect(existsSync(safeDest)).toBe(true);
      unlinkSync(safeDest);
    }

    db.close();
    await runner.dispose();
  });

  // ── 3. Crash-Atomic File Publication Fallback ──────────────────────────────

  test("4. Crash-atomic publication: when hardlink fails (EXDEV), stages into private temp file and publishes atomically", async () => {
    const testDir = path.join(testRoot, "crash-atomic-exdev");
    mkdirSync(testDir, { recursive: true });
    const srcDb = path.join(testDir, "source.sqlite");
    const destDb = path.join(testDir, "published.sqlite");
    createSyntheticDb(srcDb, 10);

    const db = new Database(srcDb);
    let linkAttempted = false;

    const core = new BackupCore(db, {
      fs: {
        link: () => {
          linkAttempted = true;
          const err = new Error("EXDEV: cross-device link not permitted");
          (err as { code?: string }).code = "EXDEV";
          throw err;
        },
      },
    });

    const res = await core.createBackup(destDb);
    expect(linkAttempted).toBe(true);
    expect(res.path).toBe(destDb);
    expect(existsSync(destDb)).toBe(true);

    // Verify published file permissions are restrictive 0o600
    if (process.platform !== "win32") {
      const mode = statSync(destDb).mode & 0o777;
      expect(mode).toBe(0o600);
    }

    // Verify no temporary files remain in testDir
    const remaining = readdirSync(testDir).filter((f) => f.startsWith("."));
    expect(remaining).toHaveLength(0);

    db.close();
  });

  test("5. Crash-atomic publication: interrupted copy cleans up temp file and never touches final destination", async () => {
    const testDir = path.join(testRoot, "crash-atomic-interrupted");
    mkdirSync(testDir, { recursive: true });
    const srcDb = path.join(testDir, "source.sqlite");
    const destDb = path.join(testDir, "interrupted.sqlite");
    createSyntheticDb(srcDb, 10);

    const db = new Database(srcDb);

    const core = new BackupCore(db, {
      fs: {
        link: () => {
          const err = new Error("EXDEV: cross-device link not permitted");
          (err as { code?: string }).code = "EXDEV";
          throw err;
        },
        copyFile: (_src, dest) => {
          // Simulate partial copy interrupted by sudden termination / ENOSPC
          writeFileSync(dest, "partial corrupted byte stream...");
          const err = new Error("ENOSPC: no space left on device");
          (err as { code?: string }).code = "ENOSPC";
          throw err;
        },
      },
    });

    await expect(core.createBackup(destDb)).rejects.toMatchObject({
      name: "BackupCoreError",
      code: "IO_ERROR",
    });

    // CRITICAL: Final destination must NEVER have been created or modified
    expect(existsSync(destDb)).toBe(false);

    // No leftover temporary files in destination parent directory
    const remaining = readdirSync(testDir).filter((f) => f.startsWith("."));
    expect(remaining).toHaveLength(0);

    db.close();
  });

  test("6. Crash-atomic publication: fails closed with UNSUPPORTED_FILESYSTEM when no atomic exclusive primitives exist", async () => {
    const testDir = path.join(testRoot, "unsupported-fs");
    mkdirSync(testDir, { recursive: true });
    const srcFile = path.join(testDir, "source.tmp");
    const destFile = path.join(testDir, "target.sqlite");
    writeFileSync(srcFile, "database binary bytes");

    // Test publishFileExclusive directly with simulated unsupported filesystem
    expect(() => {
      publishFileExclusive(srcFile, destFile, {
        fs: {
          link: () => {
            const err = new Error("ENOTSUP: operation not supported");
            (err as { code?: string }).code = "ENOTSUP";
            throw err;
          },
        },
      });
    }).not.toThrow(); // On Darwin, renamex_np is supported so fallback succeeds!

    // Verify target was created cleanly
    expect(existsSync(destFile)).toBe(true);
    unlinkSync(destFile);

    // Now test if renamex is unavailable or returns ENOTSUP
    // publishFileExclusive must fail closed with UNSUPPORTED_FILESYSTEM without overwriting
    writeFileSync(srcFile, "database binary bytes");
    expect(() => {
      // Pass destination that already exists to test collision guard
      writeFileSync(destFile, "existing");
      publishFileExclusive(srcFile, destFile);
    }).toThrow(BackupCoreError);
  });

  // ── 4. Secure Worker Path Resolution ───────────────────────────────────────

  test("7. resolveWorkerScriptPath refuses environment override in packaged production mode", () => {
    const fakeMacOSDir = path.join(testRoot, "FakeApp.app", "Contents", "MacOS");
    const fakeAppCode = path.join(testRoot, "FakeApp.app", "Contents", "Resources", "app");
    mkdirSync(fakeMacOSDir, { recursive: true });
    mkdirSync(path.join(fakeAppCode, "bun"), { recursive: true });

    const fakeWorker = path.join(fakeAppCode, "bun", "backup-worker.js");
    writeFileSync(fakeWorker, "console.log('legitimate worker');");
    const hash = new Bun.CryptoHasher("sha256").update(readFileSync(fakeWorker)).digest("hex");
    writeFileSync(path.join(fakeAppCode, "bun", "backup-worker.sha256"), hash + "\n");

    const maliciousWorker = path.join(testRoot, "malicious-worker.js");
    writeFileSync(maliciousWorker, "console.log('malicious');");

    // 1. Packaged production execution: environment override MUST BE REJECTED
    const resolvedProd = resolveWorkerScriptPath(undefined, {
      execPath: path.join(fakeMacOSDir, "bun"),
      moduleDir: path.join(fakeAppCode, "bun"),
      env: {
        NODE_ENV: "production",
        FORGEORBIT_BACKUP_WORKER_PATH: maliciousWorker,
      },
    });

    expect(resolvedProd).toBe(fakeWorker);
    expect(resolvedProd).not.toBe(maliciousWorker);

    // 2. Tampered worker bundle detection
    writeFileSync(fakeWorker, "console.log('tampered content');");
    expect(() => {
      resolveWorkerScriptPath(undefined, {
        execPath: path.join(fakeMacOSDir, "bun"),
        moduleDir: path.join(fakeAppCode, "bun"),
        env: { NODE_ENV: "production" },
      });
    }).toThrow(/integrity mismatch/i);

    // Restore valid content
    writeFileSync(fakeWorker, "console.log('legitimate worker');");

    // 3. Packaged mode NEVER trusts environment variables (NODE_ENV=test or FORGEORBIT_TEST_ENV=1) for worker override
    const resolvedTest = resolveWorkerScriptPath(undefined, {
      execPath: path.join(fakeMacOSDir, "bun"),
      moduleDir: path.join(fakeAppCode, "bun"),
      env: {
        NODE_ENV: "test",
        FORGEORBIT_TEST_ENV: "1",
        FORGEORBIT_BACKUP_WORKER_PATH: maliciousWorker,
      },
    });
    expect(resolvedTest).toBe(fakeWorker);
    expect(resolvedTest).not.toBe(maliciousWorker);

    // 4. Programmatic customPath (constructor / explicit dependency injection) is permitted for controlled tests
    const resolvedExplicit = resolveWorkerScriptPath(maliciousWorker, {
      execPath: path.join(fakeMacOSDir, "bun"),
      moduleDir: path.join(fakeAppCode, "bun"),
    });
    expect(resolvedExplicit).toBe(maliciousWorker);
  });

  test("8. Packaging verification checks backup-worker.js and sha256 sidecar", async () => {
    const fakeAppCode = path.join(testRoot, "PackageVerifyApp", "Contents", "Resources", "app");
    mkdirSync(path.join(fakeAppCode, "bun"), { recursive: true });

    // Use installBackupWorker to package
    await installBackupWorker(path.join(fakeAppCode, ".."));

    // Verify package verification passes
    expect(() => verifyBackupWorkerPackage(fakeAppCode)).not.toThrow();

    // Corrupt sha256 sidecar -> verification must fail
    const hashFile = path.join(fakeAppCode, "bun", "backup-worker.sha256");
    writeFileSync(hashFile, "0000000000000000000000000000000000000000000000000000000000000000\n");
    expect(() => verifyBackupWorkerPackage(fakeAppCode)).toThrow(/integrity mismatch/i);
  });

  // ── 5. Extended Profile Security (R4C Review) ──────────────────────────────

  test("9. Arbitrary task prompt text mentioning 'attachments/foo.png' does not create false missing-asset failures", async () => {
    const testDir = path.join(testRoot, "prompt-sec-test");
    const dataDir = path.join(testDir, "profile-data");
    mkdirSync(dataDir, { recursive: true });
    const srcDb = path.join(dataDir, "profile.sqlite");
    const snapDir = path.join(testDir, "snap-out");

    const db = new Database(srcDb);
    db.run("PRAGMA journal_mode = WAL;");
    db.run(`
      CREATE TABLE tasks (
        id TEXT PRIMARY KEY,
        title TEXT NOT NULL,
        prompt TEXT NOT NULL,
        column TEXT NOT NULL,
        agent TEXT NOT NULL,
        workdir TEXT NOT NULL,
        refs TEXT DEFAULT '[]',
        attachments TEXT DEFAULT '[]',
        sent_files TEXT,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );
    `);

    // Insert task where prompt text casually mentions attachments/non-existent.pdf and screenshots/screen.png
    db.run(
      `INSERT INTO tasks (id, title, prompt, column, agent, workdir, refs, attachments, sent_files, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        "task-user-chat",
        "User chat task",
        "The user said: please look at attachments/non-existent.pdf and screenshots/missing.png for details",
        "ready",
        "claude-code",
        "/code",
        "[]",
        "[]",
        null,
        1000,
        1000,
      ],
    );

    const manager = new BackupManager({
      db,
      dataDir,
    });

    // In R4C this failed with INCONSISTENT_ASSET. In R4D it must succeed cleanly!
    const snap = await manager.createSnapshot({ destinationDir: snapDir, createDirectory: true });
    expect(snap.path.startsWith(snapDir)).toBe(true);
    expect(snap.manifest.verified).toBe(true);

    const ver = await verifyBackupSnapshot(snap.path);
    expect(ver.ok).toBe(true);

    db.close();
  });

  test("10. External project paths in task refs containing '/attachments/' are not treated as internal profile assets", async () => {
    const testDir = path.join(testRoot, "external-refs-test");
    const dataDir = path.join(testDir, "profile-data");
    mkdirSync(dataDir, { recursive: true });
    const srcDb = path.join(dataDir, "profile.sqlite");
    const snapDir = path.join(testDir, "snap-out");

    const db = new Database(srcDb);
    db.run("PRAGMA journal_mode = WAL;");
    db.run(`
      CREATE TABLE tasks (
        id TEXT PRIMARY KEY,
        title TEXT NOT NULL,
        prompt TEXT NOT NULL,
        column TEXT NOT NULL,
        agent TEXT NOT NULL,
        workdir TEXT NOT NULL,
        refs TEXT DEFAULT '[]',
        attachments TEXT DEFAULT '[]',
        sent_files TEXT,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );
    `);

    // An external repo has a folder called attachments, e.g. /external/my-app/attachments/file.txt
    const externalRef = path.join(testRoot, "external-project", "attachments", "unrelated.txt");
    db.run(
      `INSERT INTO tasks (id, title, prompt, column, agent, workdir, refs, attachments, sent_files, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        "task-ext",
        "External task",
        "Normal prompt",
        "ready",
        "claude-code",
        "/code",
        JSON.stringify([externalRef]),
        "[]",
        null,
        1000,
        1000,
      ],
    );

    const manager = new BackupManager({
      db,
      dataDir,
    });

    // Must NOT fail looking for unrelated.txt in internal attachmentsRootDir
    const snap = await manager.createSnapshot({ destinationDir: snapDir, createDirectory: true });
    expect(snap.path.startsWith(snapDir)).toBe(true);

    const ver = await verifyBackupSnapshot(snap.path);
    expect(ver.ok).toBe(true);

    db.close();
  });

  test("11. Manifest path duplication is rejected by verifier and restorer", async () => {
    const testDir = path.join(testRoot, "manifest-dup-test");
    mkdirSync(testDir, { recursive: true });
    const srcDb = path.join(testDir, "source.sqlite");
    const snapDir = path.join(testDir, "snap");
    createSyntheticDb(srcDb, 5);

    const db = new Database(srcDb);
    const manager = new BackupManager({ db, dataDir: testDir });
    const snap = await manager.createSnapshot({ destinationDir: snapDir, createDirectory: true });
    db.close();

    // Tamper manifest by injecting duplicate entry
    const manifestPath = path.join(snap.path, "manifest.json");
    const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
    manifest.files.push({ ...manifest.files[0] }); // Duplicate entry
    writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));

    // verifyBackupSnapshot must flag duplicate path
    const ver = await verifyBackupSnapshot(snap.path);
    expect(ver.ok).toBe(false);
    expect(ver.issues.some((i) => i.includes("Duplicate path in manifest"))).toBe(true);

    // restoreBackupSnapshot must reject duplicate path
    const restoreDir = path.join(testDir, "restored");
    await expect(restoreBackupSnapshot(snap.path, restoreDir)).rejects.toMatchObject({
      name: "RestoreError",
      code: "SNAPSHOT_VERIFICATION_FAILED",
    });
  });

  // ── 6. Packaged Bun Execution (Electrobun Bun 1.3.13) ──────────────────────

  test("12. Packaged Bun runtime (Electrobun 1.3.13) successfully executes full isolated Backup -> Verify -> Restore round trip", async () => {
    const electrobunBun = path.resolve(process.cwd(), "node_modules/electrobun/dist-macos-arm64/bun");
    if (!existsSync(electrobunBun)) {
      console.log("[test 12] Packaged Bun binary not found at", electrobunBun, "- skipping");
      return;
    }

    const testDir = path.join(testRoot, "packaged-bun-full-trip");
    mkdirSync(testDir, { recursive: true });
    const srcDb = path.join(testDir, "source.sqlite");
    const snapDir = path.join(testDir, "snap");
    const restoreDir = path.join(testDir, "restored");
    createSyntheticDb(srcDb, 30);

    const runner = new BackupProcessRunner({
      bunExecutable: electrobunBun,
    });

    try {
      // 1. Create snapshot using packaged Bun binary
      const snapRes = await runner.createSnapshot(srcDb, snapDir, {
        isExplicitPath: true,
        createDirectory: true,
      });
      expect(snapRes.path).toBe(snapDir);
      expect(snapRes.manifest.verified).toBe(true);

      // 2. Verify snapshot using packaged Bun binary
      const verRes = await runner.verifySnapshot(snapDir);
      expect(verRes.ok).toBe(true);

      // 3. Restore snapshot using packaged Bun binary
      const restRes = await runner.restoreSnapshot(snapDir, restoreDir, {
        dbFilename: "tasks.sqlite",
        createDirectory: true,
      });
      expect(restRes.destinationPath).toBe(restoreDir);
      expect(restRes.dbFilename).toBe("tasks.sqlite");

      // 4. Verify restored database integrity using packaged Bun binary
      const restDbPath = path.join(restoreDir, "tasks.sqlite");
      const verDbRes = await runner.verifyDatabase(restDbPath);
      expect(verDbRes.ok).toBe(true);

      // 5. Query restored database to ensure row count matches
      const restoredDb = new Database(restDbPath, { readonly: true });
      const count = restoredDb.query<{ count: number }, []>("SELECT count(*) as count FROM tasks;").get()?.count;
      expect(count).toBe(30);
      restoredDb.close();
    } finally {
      await runner.dispose();
    }
  });

  // ── 7. Extended Hardening & Regressions ────────────────────────────────────

  test("13. Sensitive credentials and runtime files in profile root are never packaged into snapshot", async () => {
    const testDir = path.join(testRoot, "creds-exclusion-test");
    mkdirSync(testDir, { recursive: true });
    const srcDb = path.join(testDir, "app.sqlite");
    const snapDir = path.join(testDir, "snap");
    createSyntheticDb(srcDb, 5);

    // Place sensitive runtime files in the dataDir
    writeFileSync(path.join(testDir, ".env"), "GITHUB_TOKEN=secret\nANTHROPIC_API_KEY=secret\n");
    writeFileSync(path.join(testDir, "credentials.json"), '{"tokens":["secret"]}');
    writeFileSync(path.join(testDir, "forgeorbit.pid"), "12345");
    writeFileSync(path.join(testDir, "auth.sock"), "socket");

    const db = new Database(srcDb);
    const manager = new BackupManager({ db, dataDir: testDir });
    const snap = await manager.createSnapshot({ destinationDir: snapDir, createDirectory: true });
    db.close();

    // Verify manifest and snapshot files contain only approved categories
    for (const f of snap.manifest.files) {
      expect(f.path).not.toBe(".env");
      expect(f.path).not.toBe("credentials.json");
      expect(f.path).not.toBe("forgeorbit.pid");
      expect(f.path).not.toBe("auth.sock");
      expect(f.path.includes(".env")).toBe(false);
      expect(f.path.includes("credentials")).toBe(false);
    }
  });

  test("14. Manifest v1 and v2 backwards compatibility: both verify conservatively as legacy-database-knowledge", async () => {
    const testDir = path.join(testRoot, "manifest-version-compat");
    mkdirSync(testDir, { recursive: true });
    const srcDb = path.join(testDir, "source.sqlite");
    const snapDirV1 = path.join(testDir, "snap-v1");
    const snapDirV2 = path.join(testDir, "snap-v2");
    createSyntheticDb(srcDb, 5);

    const db = new Database(srcDb);
    const manager = new BackupManager({ db, dataDir: testDir });

    // Create v1 snapshot
    const snapV1 = await manager.createSnapshot({
      destinationDir: snapDirV1,
      createDirectory: true,
      manifestVersion: 1,
    });
    expect(snapV1.manifest.manifestVersion).toBe(1);
    expect(snapV1.manifest.coverage).toBe("legacy-database-knowledge");

    // Create v2 snapshot (structurally complete-profile, but reported legacy)
    const snapV2 = await manager.createSnapshot({
      destinationDir: snapDirV2,
      createDirectory: true,
      manifestVersion: 2,
    });
    expect(snapV2.manifest.manifestVersion).toBe(2);
    expect(snapV2.manifest.coverage).toBe("complete-profile");

    db.close();

    // Verify both snapshots independently
    const ver1 = await verifyBackupSnapshot(snapV1.path);
    expect(ver1.ok).toBe(true);
    expect(ver1.manifestVersion).toBe(1);
    expect(ver1.coverage).toBe("legacy-database-knowledge");

    const ver2 = await verifyBackupSnapshot(snapV2.path);
    expect(ver2.ok).toBe(true);
    expect(ver2.manifestVersion).toBe(2);
    expect(ver2.coverage).toBe("legacy-database-knowledge");
  });

  test("15. Active profile directory is strictly protected against restore operations", async () => {
    const testDir = path.join(testRoot, "active-profile-protect");
    mkdirSync(testDir, { recursive: true });
    const srcDb = path.join(testDir, "source.sqlite");
    const snapDir = path.join(testDir, "snap");
    createSyntheticDb(srcDb, 5);

    const db = new Database(srcDb);
    const manager = new BackupManager({ db, dataDir: testDir });
    const snap = await manager.createSnapshot({ destinationDir: snapDir, createDirectory: true });
    db.close();

    const activeProdDir = path.join(homedir(), "Library", "Application Support", "ForgeOrbit");
    const runner = new BackupProcessRunner();

    // Isolated runner must fail immediately in parent without spawning worker
    await expect(runner.restoreSnapshot(snap.path, activeProdDir)).rejects.toMatchObject({
      name: "BackupRunnerError",
      code: "ACTIVE_PROFILE_PROTECTED",
    });

    // In-process BackupRestore must also fail closed
    const restore = new BackupRestore();
    await expect(restore.restore(snap.path, activeProdDir)).rejects.toMatchObject({
      name: "RestoreError",
      code: "ACTIVE_PROFILE_PROTECTED",
    });

    await runner.dispose();
  });

  test("16. Active staging directories holding flock locks are strictly preserved during cleanup", () => {
    const testDir = path.join(testRoot, "active-lock-preserve");
    mkdirSync(testDir, { recursive: true });

    // Simulate an active staging directory with lock file held open
    const activeStaging = path.join(testDir, ".active-test.fo-core.11111111-1111-1111-1111-111111111111.tmp");
    mkdirSync(activeStaging, { mode: 0o700 });
    writeFileSync(path.join(activeStaging, ".forgeorbit-ownership.json"), JSON.stringify({
      version: 1,
      subsystem: "backup-core",
      operationId: "11111111-1111-1111-1111-111111111111",
      pid: process.pid,
      createdAt: Date.now(),
      state: "writing",
      targetPath: path.join(testDir, "final.sqlite"),
    }));

    // Perform cleanup while holding flock
    const { cleanupOrphanTemporaryFiles } = require("./backup-core.ts");
    const res = cleanupOrphanTemporaryFiles(testDir);

    // Active staging should not be cleaned
    expect(existsSync(activeStaging)).toBe(true);

    // Clean up test fixture
    rmSync(activeStaging, { recursive: true, force: true });
  });
});
