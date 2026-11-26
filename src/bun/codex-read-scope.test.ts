import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";

// Directories MUST be under the home folder, not /tmp: the restricted profile
// denies /private/tmp, and a canary in the same temp folder would hide that.
const BASE = mkdtempSync(path.join(homedir(), ".forgeorbit-read-scope-test-"));
const DATA_DIR = path.join(BASE, "data");
mkdirSync(DATA_DIR);
process.env.AGETOR_DATA_DIR = DATA_DIR;

const codexAvailable = (() => {
  const bin = Bun.which("codex");
  if (!bin) return false;
  const probe = Bun.spawnSync([bin, "sandbox", "--help"], { stdout: "pipe", stderr: "pipe" });
  return probe.exitCode === 0;
})();
const live = codexAvailable ? test : test.skip;

afterAll(() => { rmSync(BASE, { recursive: true, force: true }); });

let scopeModule: typeof import("./codex-read-scope.ts");
let agents: typeof import("./agents.ts");
beforeAll(async () => {
  scopeModule = await import("./codex-read-scope.ts");
  agents = await import("./agents.ts");
});

function dir(name: string): string {
  const p = path.join(BASE, name);
  mkdirSync(p, { recursive: true });
  return p;
}

const harness = (home: string) => ({
  id: "codex-read-scope-probe", kind: "codex" as const, label: "probe", isBuiltin: false, home: null, bin: null,
  env: { CODEX_HOME: home }, enabled: true, createdAt: 0, updatedAt: 0,
});

describe("opt-in and profile construction", () => {
  test("only the exact opt-in value enables it; anything else fails closed", () => {
    expect(scopeModule.codexReadScopeRestricted({})).toBe(false);
    expect(scopeModule.codexReadScopeRestricted({ FORGEORBIT_CODEX_READ_SCOPE: "" })).toBe(false);
    expect(scopeModule.codexReadScopeRestricted({ FORGEORBIT_CODEX_READ_SCOPE: "restricted" })).toBe(true);
    expect(() => scopeModule.codexReadScopeRestricted({ FORGEORBIT_CODEX_READ_SCOPE: "yes" })).toThrow("must be \"restricted\"");
  });

  test("developer writes only its working directory; reader only reads it", () => {
    const stage = dir("stage-a");
    const developer = scopeModule.buildCodexReadScope({ mode: "auto", cwd: stage, bunRoots: ["/opt/homebrew/bin"] });
    expect(developer.role).toBe("developer");
    const joined = developer.args.join(" ");
    expect(joined).toContain("default_permissions=\"forgeorbit_read_scope_developer\"");
    expect(joined).toContain("\":project_roots\"={\".\"=\"write\"}");
    expect(joined).toContain("\"/opt/homebrew/bin\"=\"read\"");
    expect(joined).toContain("\"/private/tmp\"=\"none\"");
    expect(developer.args).not.toContain("--sandbox");
    const reader = scopeModule.buildCodexReadScope({ mode: "ask", cwd: stage, bunRoots: ["/opt/homebrew/bin"] });
    expect(reader.role).toBe("reader");
    expect(reader.args.join(" ")).toContain("\":project_roots\"={\".\"=\"read\"}");
    expect(reader.args.join(" ")).not.toContain("/opt/homebrew/bin");
    expect(scopeModule.buildCodexReadScope({ mode: "ask", cwd: stage, codexRoots: ["/opt/codex/bin"] }).args.join(" ")).toContain("\"/opt/codex/bin\"=\"read\"");
    expect(reader.args.join(" ")).not.toContain("\"write\"");
  });

  test("full access, a missing directory and a path that cannot be quoted are refused", () => {
    const stage = dir("stage-b");
    expect(() => scopeModule.buildCodexReadScope({ mode: "full-access", cwd: stage })).toThrow("only for Codex modes auto and ask");
    expect(() => scopeModule.buildCodexReadScope({ mode: "auto", cwd: path.join(BASE, "missing") })).toThrow("missing or too broad");
    expect(() => scopeModule.buildCodexReadScope({ mode: "auto", cwd: "/" })).toThrow("missing or too broad");
    expect(() => scopeModule.buildCodexReadScope({ mode: "auto", cwd: stage, bunRoots: ["/opt/with\"quote"] })).toThrow("cannot be placed");
  });
});

describe("managed launch wiring", () => {
  const savedEnv = process.env.FORGEORBIT_CODEX_READ_SCOPE;
  afterAll(() => { if (savedEnv === undefined) delete process.env.FORGEORBIT_CODEX_READ_SCOPE; else process.env.FORGEORBIT_CODEX_READ_SCOPE = savedEnv; });

  test("default launch is unchanged", () => {
    delete process.env.FORGEORBIT_CODEX_READ_SCOPE;
    const built = agents.buildCommand(harness(dir("home-a")) as never, "p", { model: "gpt-6.1-sol", effort: "low", mode: "auto" });
    expect(built.cmd).toContain("--sandbox");
    expect(built.cmd).toContain("workspace-write");
    expect(built.cmd.join(" ")).not.toContain("default_permissions");
  });

  test("with the profile the argv has the profile and no --sandbox", () => {
    const scope = scopeModule.buildCodexReadScope({ mode: "auto", cwd: dir("stage-c"), bunRoots: [] });
    const built = agents.buildCommand(harness(dir("home-b")) as never, "p", { model: "gpt-6.1-sol", effort: "low", mode: "auto", codexReadScope: scope });
    expect(built.cmd).not.toContain("--sandbox");
    expect(built.cmd.join(" ")).not.toContain("sandbox_workspace_write");
    expect(built.cmd).toContain("approval_policy=never");
    expect(built.cmd.join(" ")).toContain("default_permissions=\"forgeorbit_read_scope_developer\"");
  });

  test("opt-in without a built profile never falls back to the broad sandbox", () => {
    process.env.FORGEORBIT_CODEX_READ_SCOPE = "restricted";
    try {
      expect(() => agents.buildCommand(harness(dir("home-c")) as never, "p", { model: "gpt-6.1-sol", effort: "low", mode: "auto" })).toThrow("did not build it");
    } finally { delete process.env.FORGEORBIT_CODEX_READ_SCOPE; }
  });

  test("AGETOR_CODEX_ARGS stays refused, with and without the profile", () => {
    process.env.AGETOR_CODEX_ARGS = "-c sandbox_mode=danger-full-access";
    try {
      expect(() => agents.buildCommand(harness(dir("home-d")) as never, "p", { model: "gpt-6.1-sol", effort: "low", mode: "auto" })).toThrow("cannot override managed Codex permissions");
      const scope = scopeModule.buildCodexReadScope({ mode: "auto", cwd: dir("stage-d"), bunRoots: [] });
      expect(() => agents.buildCommand(harness(dir("home-e")) as never, "p", { model: "gpt-6.1-sol", effort: "low", mode: "auto", codexReadScope: scope })).toThrow("cannot override managed Codex permissions");
    } finally { delete process.env.AGETOR_CODEX_ARGS; }
  });

  test("Full access is refused while the opt-in is on", async () => {
    process.env.FORGEORBIT_CODEX_READ_SCOPE = "restricted";
    try {
      await expect(agents.buildCodexCommand(harness(dir("home-f")) as never, "p", { model: "gpt-6.1-sol", effort: "low", mode: "full-access" }, dir("stage-e"))).rejects.toThrow(/only for Codex modes auto and ask|full access/i);
    } finally { delete process.env.FORGEORBIT_CODEX_READ_SCOPE; }
  });
});

describe("pre-launch self-test fails closed", () => {
  live("a rejected or non-holding profile stops the launch", async () => {
    const stage = dir("stage-f");
    const home = dir("home-g");
    scopeModule.clearCodexReadScopeSelfTestCache();
    const good = scopeModule.buildCodexReadScope({ mode: "auto", cwd: stage });
    await scopeModule.assertCodexReadScopeUsable({ bin: Bun.which("codex")!, env: { ...process.env, CODEX_HOME: home }, scope: good });

    // A profile that wrongly grants the data folder: the canary there becomes readable.
    scopeModule.clearCodexReadScopeSelfTestCache();
    const filesystemIndex = good.args.findIndex((arg) => arg.startsWith("permissions."));
    const patched = [...good.args];
    patched[filesystemIndex] = good.args[filesystemIndex]!.replace("{", `{"${DATA_DIR}"="read",`);
    await expect(scopeModule.assertCodexReadScopeUsable({ bin: Bun.which("codex")!, env: { ...process.env, CODEX_HOME: home }, scope: { ...good, digest: "leaky", args: patched } }))
      .rejects.toThrow("did not hold in the pre-launch self-test (READ_OUTSIDE was readable");

    // A Codex that rejects the configuration.
    scopeModule.clearCodexReadScopeSelfTestCache();
    const rejecting = path.join(BASE, "rejecting-codex.sh");
    writeFileSync(rejecting, "#!/bin/sh\necho 'unknown permissions profile' >&2\nexit 2\n");
    chmodSync(rejecting, 0o755);
    await expect(scopeModule.assertCodexReadScopeUsable({ bin: rejecting, env: { ...process.env, CODEX_HOME: home }, scope: good }))
      .rejects.toThrow("Codex rejected the restricted permission profile");

    // Nothing is left behind in the data folder.
    const leftovers = Array.from(new Bun.Glob(".codex-read-scope-canary-*").scanSync({ cwd: DATA_DIR, dot: true }));
    expect(leftovers).toEqual([]);
  }, 60_000);
});
