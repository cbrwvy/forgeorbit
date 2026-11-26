/**
 * FO-P2-004-R1 / F5: bounded registry reads and corrupt/oversized handling.
 */

import { afterAll, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const ORIGINAL_ENV = {
  FORGEORBIT_DATA_DIR: process.env.FORGEORBIT_DATA_DIR,
  AGETOR_DATA_DIR: process.env.AGETOR_DATA_DIR,
};
const ROOT = mkdtempSync(path.join(tmpdir(), "fo-r1-f5-registry-"));
process.env.FORGEORBIT_DATA_DIR = path.join(ROOT, "env-profile");
process.env.AGETOR_DATA_DIR = process.env.FORGEORBIT_DATA_DIR;
mkdirSync(process.env.FORGEORBIT_DATA_DIR, { recursive: true, mode: 0o700 });

const { BackupService } = await import("./backup-service.ts");

function profileDir(name: string): string {
  const dir = path.join(ROOT, name, "profile");
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  return dir;
}

test("a valid existing registry is preserved and used", () => {
  const dataDir = profileDir("valid");
  const registryPath = path.join(ROOT, "valid-registry.json");
  const location = path.join(ROOT, "valid", "backups");
  mkdirSync(location, { recursive: true, mode: 0o700 });
  writeFileSync(
    registryPath,
    JSON.stringify({ version: 1, locations: [location], snapshots: [], verifications: {} }),
    { mode: 0o600 },
  );
  const service = new BackupService({ dataDir, registryPath });
  expect(service.listHistory().locations).toEqual([location]);
});

test("an oversized registry is ignored without crashing startup", () => {
  const dataDir = profileDir("oversized");
  const registryPath = path.join(ROOT, "oversized-registry.json");
  writeFileSync(registryPath, `{"locations":["${"a".repeat(2 * 1024 * 1024)}"]}`, { mode: 0o600 });
  const service = new BackupService({ dataDir, registryPath });
  expect(service.listHistory().locations).toEqual([]);
  // Startup-adjacent API still works.
  expect(service.getProfileInfo().databaseFilename).toBe("agetor.sqlite");
});

test("a corrupt registry is ignored, and the next write is atomic mode-0600 JSON", () => {
  const dataDir = profileDir("corrupt");
  const registryPath = path.join(ROOT, "corrupt-registry.json");
  writeFileSync(registryPath, "{ definitely not json", { mode: 0o600 });
  const service = new BackupService({ dataDir, registryPath });
  expect(service.listHistory().locations).toEqual([]);

  const location = path.join(ROOT, "corrupt", "new-location");
  mkdirSync(location, { recursive: true, mode: 0o700 });
  const grant = service.issueDestinationGrant(location, "history-location");
  expect(service.addLocation(grant.id)).toEqual([realpathSync(location)]);

  expect(existsSync(registryPath)).toBe(true);
  expect(statSync(registryPath).mode & 0o777).toBe(0o600);
  const parsed = JSON.parse(readFileSync(registryPath, "utf8")) as { locations?: string[] };
  expect(parsed.locations).toEqual([realpathSync(location)]);
});

afterAll(() => {
  for (const [key, value] of Object.entries(ORIGINAL_ENV)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  rmSync(ROOT, { recursive: true, force: true });
});
