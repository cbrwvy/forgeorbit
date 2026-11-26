import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

interface ValidationReport {
  profiles: Array<{ directory: string; directoryIdentity: string }>;
  rejected: Array<{ directory: string; message: string }>;
}

if (process.env.FO_CODEX_PROFILE_VALIDATE === "1") {
  const { lstatSync } = await import("node:fs");
  const { validateCodexProfileDirectory } = await import("./codex-profiles.ts");
  const { AccountCoreError } = await import("./account-core.ts");
  const home = process.env.HOME!;
  const report: ValidationReport = { profiles: [], rejected: [] };
  for (const directory of [path.join(home, ".codex"), path.join(home, ".codex-secondary")]) {
    const checked = validateCodexProfileDirectory(directory);
    const listed = lstatSync(directory);
    if (checked.directory !== directory) throw new Error("canonical path changed");
    if (checked.directoryIdentity !== `${listed.dev}:${listed.ino}`) throw new Error("identity mismatch");
    report.profiles.push({ directory: checked.directory, directoryIdentity: checked.directoryIdentity });
  }
  for (const directory of [path.join(home, ".Trash"), path.join(home, ".ssh"), path.join(home, ".aws")]) {
    try {
      validateCodexProfileDirectory(directory);
      throw new Error(`accepted ${directory}`);
    } catch (error) {
      if (!(error instanceof AccountCoreError)) throw error;
      report.rejected.push({ directory, message: error.message });
    }
  }
  process.stdout.write(`\nFO_CODEX_PROFILE_REPORT ${JSON.stringify(report)}\n`);
  process.exit(0);
}

test("Codex profile paths validate and reject sensitive directories in an isolated home", async () => {
  const root = realpathSync(mkdtempSync(path.join(tmpdir(), "fo-codex-macos-")));
  const fakeHome = path.join(root, "home");
  const dataDir = path.join(root, "data");
  for (const sub of [".codex", ".codex-secondary", ".Trash", ".ssh", ".aws"]) {
    mkdirSync(path.join(fakeHome, sub), { recursive: true });
  }
  mkdirSync(dataDir, { recursive: true });
  try {
    const child = Bun.spawn([process.execPath, import.meta.path], {
      cwd: path.join(import.meta.dir, "../.."),
      env: {
        ...process.env,
        HOME: fakeHome,
        AGETOR_DATA_DIR: dataDir,
        FORGEORBIT_DATA_DIR: dataDir,
        AGETOR_USAGE_OFFLINE: "1",
        AGETOR_DISABLE_UPDATES: "1",
        AGETOR_CODEX_DRIVER: "fake",
        FO_CODEX_PROFILE_VALIDATE: "1",
      },
      stdout: "pipe",
      stderr: "pipe",
    });
    const [stdout, stderr, code] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ]);
    expect(code, stderr).toBe(0);
    const line = stdout.split("\n").find((entry) => entry.startsWith("FO_CODEX_PROFILE_REPORT "));
    const report = JSON.parse(line?.slice("FO_CODEX_PROFILE_REPORT ".length) ?? "") as ValidationReport;
    expect(report.profiles.map((row) => row.directory)).toEqual([
      path.join(fakeHome, ".codex"),
      path.join(fakeHome, ".codex-secondary"),
    ]);
    expect(new Set(report.profiles.map((row) => row.directoryIdentity)).size).toBe(2);
    expect(report.rejected.map((row) => row.directory)).toEqual([
      path.join(fakeHome, ".Trash"),
      path.join(fakeHome, ".ssh"),
      path.join(fakeHome, ".aws"),
    ]);
    expect(report.rejected.every((row) => row.message !== "Account operation failed." && !row.message.includes("EPERM"))).toBe(true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}, 30_000);
