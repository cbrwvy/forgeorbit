/**
 * FO-P2-004-R1 / F4: BackupService disposal is an application-lifecycle
 * concern, invoked once, bounded, and never via the Settings UI.
 */

import { afterAll, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const ORIGINAL_ENV = {
  FORGEORBIT_DATA_DIR: process.env.FORGEORBIT_DATA_DIR,
  AGETOR_DATA_DIR: process.env.AGETOR_DATA_DIR,
};
const ROOT = mkdtempSync(path.join(tmpdir(), "fo-r1-f4-"));
process.env.FORGEORBIT_DATA_DIR = path.join(ROOT, "env-profile");
process.env.AGETOR_DATA_DIR = process.env.FORGEORBIT_DATA_DIR;
mkdirSync(process.env.FORGEORBIT_DATA_DIR, { recursive: true, mode: 0o700 });

const { BackupService } = await import("./backup-service.ts");
const { disposeActiveBackupService } = await import("./server.ts");

function dataDir(name: string): string {
  const dir = path.join(ROOT, name);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  return dir;
}

test("dispose() invokes the runner exactly once, even when called concurrently", async () => {
  let disposed = 0;
  const runner = {
    dispose: async () => {
      disposed++;
      await new Promise((resolve) => setTimeout(resolve, 10));
    },
  };
  const service = new BackupService({
    dataDir: dataDir("once"),
    runner: runner as never,
  });
  const first = service.dispose();
  const second = service.dispose();
  expect(second).toBe(first);
  await Promise.all([first, second]);
  expect(disposed).toBe(1);
  await service.dispose();
  expect(disposed).toBe(1);
});

test("a runner disposal failure does not make a second disposal attempt retry it", async () => {
  let attempts = 0;
  const runner = {
    dispose: async () => {
      attempts++;
      throw new Error("bounded failure");
    },
  };
  const service = new BackupService({
    dataDir: dataDir("failure"),
    runner: runner as never,
  });
  await expect(service.dispose()).rejects.toThrow("bounded failure");
  await expect(service.dispose()).rejects.toThrow("bounded failure");
  expect(attempts).toBe(1);
});

test("application lifecycle wiring calls the disposer, and the Settings UI does not", () => {
  const indexSource = readFileSync(path.resolve(import.meta.dir, "index.ts"), "utf8");
  const headlessSource = readFileSync(path.resolve(import.meta.dir, "headless.ts"), "utf8");
  const serverSource = readFileSync(path.resolve(import.meta.dir, "server.ts"), "utf8");
  const settingsSource = readFileSync(
    path.resolve(import.meta.dir, "..", "mainview", "components", "settings", "BackupRecoverySection.tsx"),
    "utf8",
  );
  expect(indexSource).toContain("disposeActiveBackupService");
  expect(headlessSource).toContain("disposeActiveBackupService");
  expect(serverSource).toContain('"/daemon/shutdown"');
  expect(serverSource).toContain("disposeActiveBackupService");
  // Closing Settings is not a lifecycle event.
  expect(settingsSource).not.toContain("disposeActiveBackupService");
  expect(settingsSource).not.toContain(".dispose()");
});

test("the application-level disposer is a safe no-op when nothing is active", async () => {
  await disposeActiveBackupService(250);
  await disposeActiveBackupService(250);
});

afterAll(() => {
  for (const [key, value] of Object.entries(ORIGINAL_ENV)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  rmSync(ROOT, { recursive: true, force: true });
});
