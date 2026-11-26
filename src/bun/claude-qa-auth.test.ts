import { afterAll, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { assertBoundedClaudeAuthentication, CLAUDE_QA_CONFIG_SETTING, configuredClaudeQaDirectory } from "./claude-auth-compat.ts";
import { boundedClaudeEnvironment } from "./claude-bounded-print.ts";

const root = mkdtempSync(path.join(tmpdir(), "fo-qa-auth-"));
const campaign = path.join(root, "campaign"), profile = path.join(root, "synthetic-persistent");
const home = path.join(campaign, "home"), temporary = path.join(campaign, "tmp"), data = path.join(campaign, "data"), project = path.join(campaign, "project");
for (const dir of [home, temporary, data, project, profile]) mkdirSync(dir, { recursive: true });
process.env.HOME = home;
process.env.TMPDIR = temporary;
process.env.AGETOR_DATA_DIR = data;
process.env.AGETOR_CLAUDE_DRIVER = "offline-executable-fixture";
delete process.env.FORGEORBIT_CLAUDE_QA_CONFIG_DIR;
delete process.env.AGETOR_CLAUDE_ARGS;
const base = { PATH: "/usr/bin:/bin", HOME: home, TMPDIR: temporary, AGETOR_DATA_DIR: data };
const selected = { ...base, [CLAUDE_QA_CONFIG_SETTING]: profile };
const calls = path.join(project, "calls.jsonl");
const bin = path.join(root, "fixture");
writeFileSync(bin, `#!${process.execPath}
import { appendFileSync, readFileSync } from "node:fs";
const p = ${JSON.stringify(profile)};
const behavior = readFileSync(p + "/behavior", "utf8");
appendFileSync(${JSON.stringify(calls)}, JSON.stringify({argv:process.argv.slice(2),home:process.env.HOME,config:process.env.CLAUDE_CONFIG_DIR,keys:Object.keys(process.env).sort()})+"\\n");
if (process.argv[2] !== "auth" || process.argv[3] !== "status") { console.error("INFERENCE TRIPWIRE"); process.exit(91); }
if (behavior === "error") { console.error("PRIVATE_SECRET"); process.exit(2); }
if (behavior === "malformed") { console.log("PRIVATE_SECRET"); process.exit(0); }
if (behavior === "timeout") await Bun.sleep(60000);
console.log(JSON.stringify({loggedIn:behavior!=="loggedout",authMethod:behavior==="method"?"api_key":"claude.ai",apiProvider:behavior==="provider"?"bedrock":"firstParty",configDirectory:behavior==="fallback"?"/wrong/default":process.env.CLAUDE_CONFIG_DIR,email:"PRIVATE_SECRET",token:"PRIVATE_SECRET"}));
process.exit(behavior==="loggedout"?1:0);
`, { mode: 0o700 });
writeFileSync(path.join(profile, "behavior"), "good");
afterAll(() => rmSync(root, { recursive: true, force: true }));
const records = () => existsSync(calls) ? readFileSync(calls, "utf8").trim().split("\n").map(line => JSON.parse(line)) : [];
const { buildCommand, spawnAgent } = await import("./agents.ts");
const harness = { id: "qa-fixture", kind: "claude-code" as const, isBuiltin: false, label: "Fixture", home: null, bin, enabled: true, env: { [CLAUDE_QA_CONFIG_SETTING]: profile } };
const launch = (env = harness.env, authorize?: () => boolean, onChunk = (_stream: string, _data: string) => {}) => spawnAgent({ taskId: "offline-task", runId: crypto.randomUUID(), harness: { ...harness, env }, cwd: project, prompt: "OFFLINE ONLY", opts: { model: "haiku-5.5", mode: "bounded-print" }, authorize, onChunk });

test("explicit setting overrides generic config; only approved environment reaches the isolated child", async () => {
  expect(configuredClaudeQaDirectory({}, {})).toBeUndefined();
  const env = boundedClaudeEnvironment({ ...selected, CLAUDE_CONFIG_DIR: "/wrong/default", ANTHROPIC_API_KEY: "PRIVATE_SECRET", CLAUDE_CODE_OAUTH_TOKEN: "PRIVATE_SECRET", CLAUDE_SECURESTORAGE_CONFIG_DIR: "", AGETOR_API_TOKEN: "PRIVATE_SECRET", ANTHROPIC_BASE_URL: "https://invalid", CLAUDE_CODE_USE_VERTEX: "1", NODE_OPTIONS: "injected" }, {});
  expect(env.HOME).toBe(home);
  expect(env.CLAUDE_CONFIG_DIR).toBe(profile);
  for (const key of ["ANTHROPIC_API_KEY", "CLAUDE_CODE_OAUTH_TOKEN", "CLAUDE_SECURESTORAGE_CONFIG_DIR", "AGETOR_API_TOKEN", "ANTHROPIC_BASE_URL", "CLAUDE_CODE_USE_VERTEX", "NODE_OPTIONS", CLAUDE_QA_CONFIG_SETTING]) expect(env[key]).toBeUndefined();
  const count = records().length;
  await assertBoundedClaudeAuthentication(bin, env, { qaConfigDirectory: profile, cwd: project });
  expect(records().length).toBe(count + 1);
  expect(records().at(-1)).toMatchObject({ argv: ["auth", "status"], home, config: profile });
  expect(existsSync(path.join(project, ".claude/settings.local.json"))).toBe(false);
  expect(existsSync(path.join(home, ".credentials.json"))).toBe(false);
});

test("setting can be supplied explicitly in the backend environment; no detection when absent", () => {
  expect(boundedClaudeEnvironment(base, { [CLAUDE_QA_CONFIG_SETTING]: profile }).CLAUDE_CONFIG_DIR).toBe(profile);
  expect(boundedClaudeEnvironment(base, {}).CLAUDE_CONFIG_DIR).toBeUndefined();
});

for (const [label, directory] of [["empty", ""], ["relative", "relative"], ["missing", path.join(root, "missing")], ["file", bin], ["HOME", home], ["data", data], ["temporary", temporary], ["parent", campaign], ["root", "/"]]) {
  test(`invalid ${label} profile fails before any executable, without fallback`, async () => {
    const count = records().length;
    await expect(launch({ [CLAUDE_QA_CONFIG_SETTING]: directory! })).rejects.toThrow(CLAUDE_QA_CONFIG_SETTING);
    expect(records()).toHaveLength(count);
  });
}
test("symlink into disposable data is rejected without modifying it", () => {
  const link = path.join(root, "link"); symlinkSync(data, link);
  expect(() => boundedClaudeEnvironment({ ...selected, [CLAUDE_QA_CONFIG_SETTING]: link }, {})).toThrow(CLAUDE_QA_CONFIG_SETTING);
});
for (const behavior of ["loggedout", "error", "malformed", "fallback", "method", "provider", "timeout"]) {
  test(`${behavior} authentication fails before inference and emits no secrets or Run events`, async () => {
    writeFileSync(path.join(profile, "behavior"), behavior);
    const count = records().length, events: string[] = [];
    let error = "";
    try { await launch(harness.env, undefined, (stream, text) => events.push(stream + text)); }
    catch (caught) { error = String(caught); }
    finally { writeFileSync(path.join(profile, "behavior"), "good"); }
    expect(error).toContain("authentication could not be established");
    expect(error).not.toContain("PRIVATE_SECRET");
    expect(events).toEqual([]);
    expect(records().slice(count).map(r => r.argv)).toEqual([["auth", "status"]]);
  }, 8000);
}
test("probe spawn errors are sanitized", async () => {
  await expect(assertBoundedClaudeAuthentication(path.join(root, "PRIVATE_SECRET"), boundedClaudeEnvironment(selected, {}))).rejects.toThrow("authentication could not be established");
});
test("successful auth is no launch grant; cancellation after probe prevents adapter submission", async () => {
  let checks = 0;
  const events: string[] = [], count = records().length;
  await expect(launch(harness.env, () => ++checks === 1, (_stream, text) => events.push(text))).rejects.toThrow("authorization changed");
  expect(records().slice(count).map(r => r.argv)).toEqual([["auth", "status"]]);
  expect(events).toEqual([]);
});
test("interactive command ignores QA selection and retains its normal harness config", () => {
  const normal = buildCommand({ ...harness, home: "/ordinary/alias" }, "unused", { model: "haiku-5.5", effort: "low", mode: "ask" });
  expect(normal.env?.CLAUDE_CONFIG_DIR).toBe("/ordinary/alias");
  expect(normal.env?.HOME).toBeUndefined();
  expect(normal.cmd).not.toContain("--print");
});
test("QA profile selection is included in the existing resource fingerprint", async () => {
  const { resourceKey } = await import("./orchestrated-resources.ts");
  const original = process.env[CLAUDE_QA_CONFIG_SETTING];
  try {
    const h = { ...harness, env: {} };
    delete process.env[CLAUDE_QA_CONFIG_SETTING]; const before = resourceKey(h);
    process.env[CLAUDE_QA_CONFIG_SETTING] = profile; const after = resourceKey(h);
    expect(after).not.toBe(before);
    process.env[CLAUDE_QA_CONFIG_SETTING] = profile + "-changed"; expect(resourceKey(h)).not.toBe(after);
  } finally { if (original === undefined) delete process.env[CLAUDE_QA_CONFIG_SETTING]; else process.env[CLAUDE_QA_CONFIG_SETTING] = original; }
});
test("cleanup of disposable campaign data preserves the separate synthetic profile", () => {
  const disposable = path.join(root, "cleanup-campaign"); mkdirSync(disposable);
  const environment = boundedClaudeEnvironment({ ...selected, HOME: disposable, TMPDIR: disposable, AGETOR_DATA_DIR: disposable }, {});
  expect(path.relative(disposable, environment.CLAUDE_CONFIG_DIR!)).toMatch(/^\.\./);
  rmSync(disposable, { recursive: true });
  expect(readFileSync(path.join(profile, "behavior"), "utf8")).toBe("good");
});
