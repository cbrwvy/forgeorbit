/**
 * FO-P2-004 packaged-worker verification.
 *
 * Builds the real worker bundle through the existing packaging helper, verifies
 * its SHA-256 sidecar, and executes the packaged JavaScript worker with Bun
 * against a synthetic profile. No real profile or installed app is touched.
 */
import { afterAll, beforeAll, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  installBackupWorker,
  verifyBackupWorkerPackage,
} from "../../scripts/backup-worker-package.ts";
import {
  BackupProcessRunner,
  resolveWorkerScriptPath,
} from "./backup-runner.ts";
import { migrate } from "./migrate.ts";
import { migrations } from "./migrations/index.ts";

const ROOT = mkdtempSync(path.join(tmpdir(), "fo-p2-004-package-"));
process.env.FORGEORBIT_DATA_DIR = path.join(ROOT, "env-profile");
process.env.AGETOR_DATA_DIR = path.join(ROOT, "env-profile");
mkdirSync(process.env.FORGEORBIT_DATA_DIR, { recursive: true, mode: 0o700 });

let appRoot = "";
let resources = "";
let appCode = "";
let workerJs = "";
let workerSidecar = "";

beforeAll(async () => {
  appRoot = path.join(ROOT, "ForgeOrbit.app");
  resources = path.join(appRoot, "Contents", "Resources");
  appCode = path.join(resources, "app");
  mkdirSync(path.join(appCode, "bun"), { recursive: true, mode: 0o700 });
  await installBackupWorker(resources);
  workerJs = path.join(appCode, "bun", "backup-worker.js");
  workerSidecar = path.join(appCode, "bun", "backup-worker.sha256");
}, 60_000);

afterAll(() => {
  rmSync(ROOT, { recursive: true, force: true });
});

test("the macOS packaging path still installs and verifies the worker", () => {
  const scripts = path.resolve(import.meta.dir, "..", "..", "scripts");
  const postBuild = readFileSync(path.join(scripts, "macos-post-build.ts"), "utf8");
  const catalog = readFileSync(path.join(scripts, "verify-catalog-package.ts"), "utf8");
  const secure = readFileSync(path.join(scripts, "build-native-secure.ts"), "utf8");
  expect(postBuild).toContain("verify-catalog-package");
  expect(catalog).toContain("installBackupWorker");
  expect(catalog).toContain("verifyBackupWorkerPackage");
  expect(secure).toContain("verifyBackupWorkerPackage");
});

test("the package helper installs the worker and a matching SHA-256 sidecar", () => {
  expect(existsSync(workerJs)).toBe(true);
  expect(existsSync(workerSidecar)).toBe(true);
  expect(() => verifyBackupWorkerPackage(appCode)).not.toThrow();
  const expected = readFileSync(workerSidecar, "utf8").trim();
  const actual = new Bun.CryptoHasher("sha256").update(readFileSync(workerJs)).digest("hex");
  expect(expected).toBe(actual);
});

test("development resolution finds the source worker without a sidecar", () => {
  const resolved = resolveWorkerScriptPath(undefined, {
    execPath: "/usr/local/bin/bun",
    moduleDir: path.resolve(import.meta.dir),
    env: {},
  });
  expect(resolved).toBe(path.join(path.resolve(import.meta.dir), "backup-worker.ts"));
  expect(existsSync(resolved)).toBe(true);
});

test("tampering with the packaged worker fails closed", () => {
  const original = readFileSync(workerJs);
  writeFileSync(workerJs, Buffer.concat([original, Buffer.from("\n// tampered\n")]));
  expect(() => verifyBackupWorkerPackage(appCode)).toThrow(/integrity mismatch/i);
  writeFileSync(workerJs, original);
  expect(() => verifyBackupWorkerPackage(appCode)).not.toThrow();
});

test("packaged resolution uses the bundled worker and refuses an environment override", () => {
  const macOS = path.join(appRoot, "Contents", "MacOS");
  mkdirSync(macOS, { recursive: true, mode: 0o700 });
  writeFileSync(path.join(macOS, "ForgeOrbit"), "#!/bin/sh\n");
  const malicious = path.join(ROOT, "malicious-worker.js");
  writeFileSync(malicious, "console.log('malicious');");
  const resolved = resolveWorkerScriptPath(undefined, {
    execPath: path.join(macOS, "ForgeOrbit"),
    moduleDir: path.join(appCode, "bun"),
    env: {
      NODE_ENV: "test",
      FORGEORBIT_TEST_ENV: "1",
      FORGEORBIT_BACKUP_WORKER_PATH: malicious,
    },
  });
  expect(resolved).toBe(workerJs);
  expect(resolved).not.toBe(malicious);

  // A broken sidecar is an integrity failure, never a silent fallback.
  writeFileSync(workerSidecar, "0".repeat(64) + "\n");
  expect(() =>
    resolveWorkerScriptPath(undefined, {
      execPath: path.join(macOS, "ForgeOrbit"),
      moduleDir: path.join(appCode, "bun"),
      env: {},
    }),
  ).toThrow(/integrity/i);
  // Restore the valid sidecar for the execution test.
  writeFileSync(
    workerSidecar,
    new Bun.CryptoHasher("sha256").update(readFileSync(workerJs)).digest("hex") + "\n",
  );
});

test("the packaged Bun worker executes a synthetic create-snapshot end to end", async () => {
  const profile = path.join(ROOT, "synthetic-profile");
  const dataDir = path.join(profile, "data");
  mkdirSync(dataDir, { recursive: true, mode: 0o700 });
  for (const category of ["knowledge", "attachments", "screenshots", "issue-threads", "pipeline-runs"]) {
    mkdirSync(path.join(dataDir, category), { recursive: true, mode: 0o700 });
  }
  const dbPath = path.join(dataDir, "agetor.sqlite");
  const db = new Database(dbPath);
  db.run("PRAGMA journal_mode = WAL;");
  migrate(db, migrations);
  db.close();

  const backups = path.join(ROOT, "packaged-backups");
  mkdirSync(backups, { recursive: true, mode: 0o700 });
  const runner = new BackupProcessRunner({ workerScriptPath: workerJs });
  try {
    const result = await runner.createSnapshot(dbPath, backups, {
      dataDir,
      knowledgeRootDir: path.join(dataDir, "knowledge"),
      attachmentsRootDir: path.join(dataDir, "attachments"),
      screenshotsRootDir: path.join(dataDir, "screenshots"),
      issueThreadsRootDir: path.join(dataDir, "issue-threads"),
      pipelineRunsRootDir: path.join(dataDir, "pipeline-runs"),
      manifestVersion: 4,
      createDirectory: true,
    });
    expect(existsSync(path.join(result.path, "manifest.json"))).toBe(true);
    expect(existsSync(path.join(result.path, "database.sqlite"))).toBe(true);
    const verified = await runner.verifySnapshot(result.path);
    expect(verified.ok).toBe(true);
    expect(verified.manifestVersion).toBe(4);
    expect(verified.filesChecked).toBeGreaterThan(0);
  } finally {
    await runner.dispose();
  }
}, 120_000);
