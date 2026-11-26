import { expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { resolveDataDir } from "./data-dir.ts";
import { canonicalizeProfilePath } from "./profile-paths.ts";
import { migrations } from "./migrations/index.ts";

const probe = path.join(import.meta.dir, "fixtures/profile-probe.ts");
function fixture() {
  const root = mkdtempSync(path.join(tmpdir(), "fo-profile01-"));
  const home = path.join(root, "Home With Spaces"); mkdirSync(home);
  const env: NodeJS.ProcessEnv = { HOME: home, PATH: "/usr/bin:/bin", NODE_ENV: "production", TMPDIR: root,
    AGETOR_USAGE_OFFLINE: "1", AGETOR_DISABLE_UPDATES: "1", AGETOR_TMUX_BIN: "/bin/echo" };
  return { root, home, env, legacy: path.join(home, ".agetor"), fresh: resolveDataDir({ home, env }) };
}
function run(entry: string, env: NodeJS.ProcessEnv, ...args: string[]): any {
  const out = spawnSync(process.execPath, [entry, ...args], { env, encoding: "utf8", timeout: 20_000 });
  expect(out.error, out.stderr).toBeUndefined(); expect(out.status, out.stderr).toBe(0);
  if (args[0] === "seed") return;
  const line = out.stdout.split("\n").find(s => s.startsWith("PROFILE_RESULT "));
  expect(line, out.stdout).toBeDefined(); return JSON.parse(line!.slice("PROFILE_RESULT ".length));
}
function hashes(dir: string): Record<string, string> {
  return Object.fromEntries(readdirSync(dir).sort().map(name => [name, createHash("sha256").update(readFileSync(path.join(dir, name))).digest("hex")]));
}
function assertProfile(result: any, dir: string) {
  const canon = canonicalizeProfilePath(dir);
  expect(canonicalizeProfilePath(result.dataDir)).toBe(canon);
  expect(canonicalizeProfilePath(result.resolver)).toBe(canon);
  for (const key of ["credsFilePath", "coreCredsPath", "githubTokensPath", "daemonLogPath", "pidFilePath"]) {
    expect(canonicalizeProfilePath(path.dirname(result[key]))).toBe(canon);
  }
  expect(result.integrity).toEqual([{ integrity_check: "ok" }]); expect(result.foreignKeys).toEqual([]);
  expect(result.journalMode).toEqual({ journal_mode: "wal" }); expect(result.migrations.length).toBe(migrations.length);
  expect(result.modes["."]).toBe(0o700);
  for (const file of ["agetor.sqlite", "agetor.sqlite-wal", "agetor.sqlite-shm", "agetor-core.json"]) expect(result.modes[file]).toBe(0o600);
}

test("fresh default initializes privately without legacy existence or any user action", () => {
  const f = fixture(); expect(existsSync(f.fresh)).toBe(false);
  const out = run(probe, f.env); assertProfile(out, f.fresh);
  expect(out.existingTasks).toEqual([]); expect(out.tokensBefore).toEqual([]); expect(out.credsBefore).toBeNull();
  expect(existsSync(f.legacy)).toBe(false);
});

test("synthetic legacy DB/tokens remain unopened by default; fresh rows, ledger and Journal survive reopen", () => {
  const f = fixture(); run(probe, { ...f.env, AGETOR_DATA_DIR: f.legacy }, "seed");
  const before = hashes(f.legacy); const first = run(probe, f.env); assertProfile(first, f.fresh);
  expect(first.existingTasks).toEqual([]); expect(first.tokensBefore).toEqual([]); expect(hashes(f.legacy)).toEqual(before);
  const again = run(probe, f.env); assertProfile(again, f.fresh);
  for (const table of ["tasks", "runs", "journal", "migrations"]) expect(again[table]).toEqual(first[table]);
  expect(first.eventCreated).toBe(true); expect(again.eventCreated).toBe(false);
  expect(hashes(f.legacy)).toEqual(before);
});

for (const variable of ["FORGEORBIT_DATA_DIR", "AGETOR_DATA_DIR"] as const) {
  test(`explicit ${variable} opens and forward-migrates only the selected synthetic legacy profile`, () => {
    const f = fixture(); run(probe, { ...f.env, AGETOR_DATA_DIR: f.legacy }, "seed");
    const selected = run(probe, { ...f.env, [variable]: f.legacy }); assertProfile(selected, f.legacy);
    expect(selected.existingTasks).toEqual([{ id: "legacy-task" }]);
    expect(selected.runs.some((r: any) => r.id === "legacy-run")).toBe(true);
    expect(selected.tokensBefore[0].host).toBe("legacy.invalid"); expect(existsSync(f.fresh)).toBe(false);
    const again = run(probe, { ...f.env, [variable]: f.legacy });
    for (const table of ["tasks", "runs", "journal", "migrations"]) expect(again[table]).toEqual(selected[table]);
  });
}

test("native pre-import bootstrap and DB/CLI credentials agree on fresh and explicit roots", async () => {
  const f = fixture();
  const native = await Bun.build({ entrypoints: [path.join(import.meta.dir, "native-bootstrap.ts")], target: "bun",
    outdir: path.join(f.root, "compiled"), define: { "process.env.NODE_ENV": "globalThis.process.env.NODE_ENV" },
    plugins: [{ name: "profile-only-no-native-gui", setup(build) {
      build.onResolve({ filter: /^\.\/index\.ts$/ }, () => ({ path: "profile-probe", namespace: "test" }));
      build.onLoad({ filter: /.*/, namespace: "test" }, () => ({ loader: "ts", contents: `import {probeProfile} from ${JSON.stringify(probe)}; await probeProfile();` }));
    } }] });
  expect(native.success, JSON.stringify(native.logs)).toBe(true);
  for (const override of [undefined, path.join(f.root, "Explicit New Root With Spaces")]) {
    const env = { ...f.env, ...(override ? { FORGEORBIT_DATA_DIR: override } : {}) };
    const selected = override ?? f.fresh; const result = run(native.outputs[0]!.path, env); assertProfile(result, selected);
    if (process.platform === "darwin") expect(existsSync(path.join(selected, "desktop-instance.lock"))).toBe(true);
    // CLI --no-daemon status performs real credential discovery with no DB startup.
    const cli = spawnSync(process.execPath, [path.join(import.meta.dir, "../cli/index.ts"), "daemon", "status", "--json", "--no-daemon"], { env, encoding: "utf8", timeout: 15_000 });
    expect(cli.status, cli.stderr).toBe(0); expect(JSON.parse(cli.stdout)).toEqual({ running: false });
  }
  expect(existsSync(f.legacy)).toBe(false);
}, 30_000);

test("CLI supervisor creates the fresh default privately and discovers/shuts down the same headless core", () => {
  const f = fixture(); expect(existsSync(f.fresh)).toBe(false);
  const out = spawnSync(process.execPath, [probe, "daemon"], { env: f.env, encoding: "utf8", timeout: 45_000 });
  expect(out.error, out.stderr).toBeUndefined(); expect(out.status, out.stderr).toBe(0);
  const line = out.stdout.split("\n").find((s) => s.startsWith("PROFILE_RESULT "));
  expect(line, out.stdout).toBeDefined();
  const daemon = JSON.parse(line!.slice("PROFILE_RESULT ".length));
  const sameProfilePath = (a: string, b: string) =>
    expect(canonicalizeProfilePath(a)).toBe(canonicalizeProfilePath(b));
  sameProfilePath(String(daemon.dataDir), f.fresh);
  sameProfilePath(String(daemon.defaults), f.fresh);
  sameProfilePath(String(daemon.credsPath), path.join(f.fresh, "agetor-core.json"));
  expect(daemon.discoveredSamePid).toBe(true); expect(daemon.kind).toBe("cli-daemon");
  expect(daemon.modes).toEqual({ ".": 0o700, "daemon.log": 0o600, "agetor.sqlite": 0o600 });
  expect(daemon.ownedPidAbsent).toBe(true); expect(daemon.credsRemoved).toBe(true);
  expect(existsSync(f.legacy)).toBe(false);
}, 60_000);
