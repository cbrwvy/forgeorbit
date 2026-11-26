import { expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { resolveDataDir } from "../src/bun/data-dir.ts";

test("copy-only restore tool refuses new default, legacy root, descendants and symlink aliases before DB import", () => {
  const home = mkdtempSync(path.join(tmpdir(), "fo-profile-restore-"));
  const env = { HOME: home, PATH: "/usr/bin:/bin", NODE_ENV: "production" };
  const fresh = resolveDataDir({ env, home }); const legacy = path.join(home, ".agetor");
  mkdirSync(fresh, { recursive: true }); mkdirSync(legacy);
  const alias = path.join(home, "default-alias"); symlinkSync(fresh, alias);
  for (const dir of [fresh, legacy, path.join(fresh, "child"), alias]) {
    const result = spawnSync(process.execPath, [path.join(import.meta.dir, "measure-restore.ts")], {
      env: { ...env, FORGEORBIT_DATA_DIR: dir }, encoding: "utf8", timeout: 5000,
    });
    expect(result.status, result.stderr).toBe(2); expect(result.stderr).toContain("production data dir");
  }
  expect(existsSync(path.join(fresh, "agetor.sqlite"))).toBe(false);
  expect(existsSync(path.join(legacy, "agetor.sqlite"))).toBe(false);
});
