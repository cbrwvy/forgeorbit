import { afterAll, beforeAll, beforeEach, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

/**
 * Direction 9: what a launch will actually run. The executable is a small shell script that prints a fixed
 * version and appends every invocation to a log, so the tests can assert both what the screens say and that
 * reading them started nothing. No provider CLI, no login, no model call: the script is not a provider.
 * The driver is the REAL one here (not `fake`); `runChecks` and a review only read, and nothing is started.
 */
const isolated = realpathSync(mkdtempSync(path.join(tmpdir(), "fo-d9-")));
const ownerHome = path.join(isolated, "owner");
mkdirSync(ownerHome);
process.env.AGETOR_DATA_DIR = path.join(isolated, "data");
process.env.HOME = ownerHome;
process.env.AGETOR_USAGE_OFFLINE = "1";
process.env.AGETOR_API_PORT = "47012";
process.env.AGETOR_DISABLE_UPDATES = "1";
process.env.AGETOR_TMUX_BIN = "/bin/echo";
delete process.env.AGETOR_CODEX_DRIVER;
delete process.env.AGETOR_CLAUDE_DRIVER;
delete process.env.AGETOR_CURSOR_DRIVER;
delete process.env.AGETOR_SKIP_CLI_VERSION_FLOOR;

const binDir = path.join(isolated, "bin");
mkdirSync(binDir);
const log = path.join(isolated, "invocations.log");
writeFileSync(log, "");

/** A fake CLI: prints `versionText` for --version (nothing when null), answers `login status` from CODEX_HOME. */
function plantCli(name: string, versionText: string | null): string {
  const file = path.join(binDir, name);
  writeFileSync(file, [
    "#!/bin/sh",
    `echo "${name} $*" >> "${log}"`,
    `if [ "$1" = "--version" ]; then ${versionText === null ? "true" : `printf '%s\\n' "${versionText}"`}; exit 0; fi`,
    `if [ "$1" = "-c" ] && [ "$3" = "login" ]; then if [ -f "$CODEX_HOME/synthetic-authenticated" ]; then echo "Logged in using ChatGPT" >&2; exit 0; fi; echo "Not logged in" >&2; exit 1; fi`,
    "exit 0",
    "",
  ].join("\n"), { mode: 0o755 });
  chmodSync(file, 0o755);
  return file;
}
const okBin = plantCli("codex-ok", "codex-cli 0.159.2");
const oldBin = plantCli("codex-old", "codex-cli 0.150.0");
const blankBin = plantCli("codex-blank", null);
const junkBin = plantCli("codex-junk", "hello there");
const claudeBin = plantCli("claude-junk", "not a version");
const cursorBin = plantCli("cursor-stub", "cursor 2026.10.1");
const invocations = () => readFileSync(log, "utf8").split("\n").filter(Boolean);

let store: typeof import("./db.ts");
let exec: typeof import("./project-execution.ts");
let orchestrator: typeof import("./orchestrator.ts");
let target: typeof import("./launch-target.ts");
let status: typeof import("./agent-status.ts");
let agents: typeof import("./agents.ts");
let profilesModule: typeof import("./codex-profiles.ts");
let run: typeof import("./employee-run.ts");
let EmployeeCore: typeof import("./employee-core.ts").EmployeeCore;
let AssignmentCore: typeof import("./assignment-core.ts").AssignmentCore;
let counter = 0;

beforeAll(async () => {
  store = await import("./db.ts");
  exec = await import("./project-execution.ts");
  orchestrator = await import("./orchestrator.ts");
  target = await import("./launch-target.ts");
  status = await import("./agent-status.ts");
  agents = await import("./agents.ts");
  profilesModule = await import("./codex-profiles.ts");
  run = await import("./employee-run.ts");
  ({ EmployeeCore } = await import("./employee-core.ts"));
  ({ AssignmentCore } = await import("./assignment-core.ts"));
  store.harnesses.setEnabled("codex", true);
});
afterAll(() => { try { rmSync(isolated, { recursive: true, force: true }); } catch { /* the data dir may still be open */ } });
beforeEach(() => { process.env.AGETOR_CODEX_BIN = okBin; delete process.env.AGETOR_CODEX_DRIVER; });

function project(name: string): string {
  const dir = realpathSync(mkdtempSync(path.join(isolated, `${name}-`)));
  writeFileSync(path.join(dir, "README.md"), `# ${name}\n`);
  store.projects.upsert(dir, name);
  return dir;
}
async function newTask(dir: string, fields: Record<string, unknown> = {}): Promise<string> {
  const created = await orchestrator.createTask({
    title: `Task ${++counter}`, prompt: "do the work", workdir: dir, column: "ready", agent: "codex", model: "gpt-6.1-sol", isolation: "none", ...fields,
  } as never);
  if ("error" in created) throw new Error(created.error);
  return created.task.id;
}
function addHarness(id: string, kind: "codex" | "claude-code" | "cursor", bin: string | null, label = id) {
  store.harnesses.insert({ id, kind, label, bin: bin ?? undefined, env: {} } as never);
  store.harnesses.setEnabled(id, true);
  return store.harnesses.get(id)!;
}
async function checksFor(harnessId: string, over: Partial<Parameters<typeof exec.runChecks>[2]> = {}, kind: "codex" | "claude-code" | "cursor" = "codex") {
  const dir = project("proj");
  const taskId = await newTask(dir, { agent: kind === "codex" ? "codex" : kind });
  const task = store.tasks.get(taskId)!;
  const config = { ...exec.configFromTask(task), harness: harnessId, ...over };
  return exec.runChecks(dir, task, config, {});
}
const find = (checks: { code: string; level: string; message: string }[], code: string) => checks.find((c) => c.code === code);

test("the resolved executable and its source come from the one function the launch uses", () => {
  const withBin = addHarness("codex-with-bin", "codex", oldBin);
  const builtIn = store.harnesses.get("codex")!;
  expect(target.describeLaunchTarget(withBin, { model: null, mode: null }).executable).toEqual({ bin: oldBin, path: oldBin, source: "harness-executable" });
  const viaEnv = target.describeLaunchTarget(builtIn, { model: null, mode: null }).executable;
  expect(viaEnv).toEqual({ bin: okBin, path: okBin, source: "environment-override" });
  // The facts and the launch cannot name different binaries.
  for (const h of [withBin, builtIn]) expect(target.describeLaunchTarget(h, { model: null, mode: null }).executable.bin).toBe(agents.resolveBin(h));
  delete process.env.AGETOR_CODEX_BIN;
  const none = target.describeLaunchTarget(builtIn, { model: null, mode: null }).executable;
  expect(none.source === "path-lookup" || none.source === "default-name").toBe(true);
});

test("a compatible Codex reports its path and version, and says what that does not prove", async () => {
  const out = await checksFor("codex");
  const facts = out.resolved.launchTarget!;
  expect(facts).toMatchObject({ verdict: "compatible", code: "compatible", version: { state: "read", parsed: "0.159.2" }, floor: { model: "gpt-6.1-sol", min: "0.159.0" }, minimumEnforced: true });
  expect(facts.executable.path).toBe(okBin);
  expect(out.checks.filter((c) => c.level === "error" && /^cli-|registration|contract/.test(c.code))).toEqual([]);
});

test("a version below the model's minimum blocks, naming the executable that was read", async () => {
  process.env.AGETOR_CODEX_BIN = oldBin;
  const out = await checksFor("codex");
  expect(out.resolved.launchTarget).toMatchObject({ verdict: "blocked", code: "version-below-minimum", version: { parsed: "0.150.0" } });
  expect(find(out.checks, "cli-too-old")).toMatchObject({ level: "error" });
  expect(find(out.checks, "cli-too-old")!.message).toContain("0.159.0");
});

test("an unreadable version does not block launch (fail-open per FO-PROVIDERS-SIMPLIFY01)", async () => {
  for (const bin of [blankBin, junkBin]) {
    process.env.AGETOR_CODEX_BIN = bin;
    const real = await checksFor("codex");
    expect(find(real.checks, "cli-version-unreadable")).toBeUndefined();
    expect(find(real.checks, "cli-too-old")).toBeUndefined();
  }
  process.env.AGETOR_CODEX_BIN = junkBin;
  process.env.AGETOR_CODEX_DRIVER = "fake";
  const fixture = await checksFor("codex");
  expect(fixture.resolved.launchTarget).toMatchObject({ verdict: "unverified", code: "version-unreadable" });
  expect(find(fixture.checks, "cli-version-unverified")).toMatchObject({ level: "warning" });
  expect(find(fixture.checks, "cli-version-unreadable")).toBeUndefined();
});

test("a model without a floor never needs a readable version, and no floor is invented for Claude Code", async () => {
  process.env.AGETOR_CODEX_BIN = junkBin;
  const codex = await checksFor("codex", { model: "gpt-5.6-sol" });
  expect(codex.resolved.launchTarget).toMatchObject({ verdict: "compatible", floor: null, minimumEnforced: false });
  expect(codex.checks.some((c) => c.code.startsWith("cli-"))).toBe(false);
  const claude = addHarness("claude-junk", "claude-code", claudeBin, "Claude Code (fixture)");
  const out = await checksFor(claude.id, { model: "opus-5.5", mode: "auto" }, "claude-code");
  expect(out.resolved.launchTarget).toMatchObject({ verdict: "compatible", code: "compatible", floor: null, minimumEnforced: false, version: { state: "unreadable" } });
  expect(out.checks.some((c) => c.code.startsWith("cli-"))).toBe(false);
});

test("a missing executable is its own state, and the two harnesses resolve to different files", async () => {
  const gone = addHarness("codex-gone", "codex", path.join(binDir, "does-not-exist"));
  const missing = await checksFor(gone.id);
  expect(missing.resolved.launchTarget).toMatchObject({ verdict: "blocked", code: "executable-missing", executable: { path: null, source: "harness-executable" } });
  expect(find(missing.checks, "harness-unavailable")).toMatchObject({ level: "error" });
  const old = addHarness("codex-second", "codex", oldBin);
  const first = (await checksFor("codex")).resolved.launchTarget!;
  const second = (await checksFor(old.id)).resolved.launchTarget!;
  expect([first.executable.path, second.executable.path]).toEqual([okBin, oldBin]);
  expect([first.code, second.code]).toEqual(["compatible", "version-below-minimum"]);
});

test("a mode the harness does not offer for the model is named, and is not replaced by another", async () => {
  const out = await checksFor("codex", { mode: "no-such-mode" });
  expect(out.resolved.launchTarget).toMatchObject({ verdict: "blocked", code: "mode-unsupported", mode: { id: "no-such-mode", supported: false } });
  expect(find(out.checks, "mode-unknown")).toMatchObject({ level: "error" });
});

test("Cursor stays blocked by the provider contract for a real driver, and legacy force flags are never reached", async () => {
  const cursor = addHarness("cursor-fixture", "cursor", cursorBin, "Cursor (fixture)");
  const out = await checksFor(cursor.id, { model: "grok-4.7", mode: "auto" }, "cursor");
  expect(out.resolved.launchTarget).toMatchObject({ verdict: "blocked", code: "contract-blocked" });
  const blocked = find(out.checks, "provider-contract-blocked")!;
  expect(blocked.level).toBe("error");
  expect(blocked.message).toContain("sandbox");
  expect(() => { throw new Error(blocked.message); }).toThrow();
  process.env.AGETOR_CURSOR_DRIVER = "fake";
  try {
    const fixture = await checksFor(cursor.id, { model: "grok-4.7", mode: "auto" }, "cursor");
    expect(find(fixture.checks, "provider-contract-blocked")).toMatchObject({ level: "warning" });
  } finally { delete process.env.AGETOR_CURSOR_DRIVER; }
});

test("a passive read starts no process; an explicit probe is remembered only for the identical file", async () => {
  const solo = addHarness("codex-passive", "codex", okBin);
  const before = invocations().length;
  const passive = target.profileLaunchTarget(solo.id)!;
  target.profileLaunchTarget(solo.id);
  expect(invocations().length).toBe(before);
  expect(passive).toMatchObject({ verdict: "unverified", code: "version-not-checked", version: { state: "not-checked", raw: null } });
  await status.probeHarnessVersion(solo);
  expect(invocations().length).toBe(before + 1);
  expect(target.profileLaunchTarget(solo.id)).toMatchObject({ verdict: "compatible", version: { state: "read", parsed: "0.159.2" } });
  expect(invocations().length).toBe(before + 1);
  // The file is replaced by another build: what the earlier probe read no longer applies.
  const copy = path.join(binDir, "codex-passive-next");
  writeFileSync(copy, readFileSync(oldBin));
  chmodSync(copy, 0o755);
  renameSync(copy, okBin.replace("codex-ok", "codex-passive"));
  store.harnesses.update(solo.id, { bin: okBin.replace("codex-ok", "codex-passive") } as never);
  expect(target.profileLaunchTarget(solo.id)).toMatchObject({ code: "version-not-checked", version: { state: "not-checked" } });
});

test("a registered Codex profile is gated on the model's minimum like any other launch, and a stale registration is named", async () => {
  process.env.AGETOR_CODEX_BIN = oldBin;
  const { AccountCore } = await import("./account-core.ts");
  const profiles = new profilesModule.CodexProfiles(new AccountCore(store.db));
  const directory = path.join(ownerHome, "profile-a");
  mkdirSync(directory, { recursive: true });
  writeFileSync(path.join(directory, "synthetic-authenticated"), "subject-a");
  const registered = profiles.register({ displayName: "Profile A", directory });
  const harness = store.harnesses.get(registered.harnessId)!;
  // The status probe used to return `version: null` for a profile, which the floor reads as "unknown, allow".
  const checked = await status.checkHarness(harness, { freshAuth: true });
  expect(checked.version).toBe("codex-cli 0.150.0");
  expect(await orchestrator.minCliVersionError(harness, "gpt-6.1-sol", checked)).toContain("0.159.0");
  expect(profiles.view(registered.accountId).availability).toBe("unchecked");
  expect(target.profileLaunchTarget(registered.harnessId)).toMatchObject({ code: "version-below-minimum", executable: { path: oldBin } });

  renameSync(directory, directory + "-moved");
  mkdirSync(directory);
  const stale = target.profileLaunchTarget(registered.harnessId)!;
  expect(stale).toMatchObject({ verdict: "blocked", code: "registration-stale" });
  const out = await checksFor(registered.harnessId);
  expect(find(out.checks, "registration-stale")).toMatchObject({ level: "error" });
  expect(find(out.checks, "registration-stale")!.message).not.toMatch(/upgrade|update/i);
});

async function reviewScenario() {
  const dir = project("employee");
  const person = new EmployeeCore(store.db).createWorker({ name: `Worker ${++counter}`, jobTitle: "QA Engineer", projectPath: dir });
  const taskId = await newTask(dir);
  new AssignmentCore(store.db).assign(taskId, person.id);
  return taskId;
}

test("the employee launch review shows the executable, and a refused target creates no attempt and no run", async () => {
  process.env.AGETOR_CODEX_BIN = okBin;
  const ok = await run.reviewEmployeeExecution({ taskId: await reviewScenario(), harnessId: "codex" }, {});
  const blockingCodes = ok.blockingErrors.map((e) => e.code);
  expect(blockingCodes.filter((c) => /^cli-|registration|contract/.test(c))).toEqual([]);
  expect(ok.attempt).not.toBeNull();
  expect(ok.attempt!.review.launchTarget).toMatchObject({ code: "compatible", executable: { path: okBin } });
  expect(ok.attempt!.status).toBe("awaiting-approval");
  expect(store.runs.listForTask(ok.attempt!.taskId).length).toBe(0);
  for (const [bin, code] of [[oldBin, "cli-too-old"]] as const) {
    process.env.AGETOR_CODEX_BIN = bin;
    const taskId = await reviewScenario();
    const refused = await run.reviewEmployeeExecution({ taskId, harnessId: "codex" }, {});
    expect(refused.attempt).toBeNull();
    expect(refused.blockingErrors.map((e) => e.code)).toContain(code);
    expect(store.runs.listForTask(taskId).length).toBe(0);
  }
  expect(existsSync(log)).toBe(true);
});

test("the board's Run allows an executable whose version cannot be parsed (fail-open)", async () => {
  for (const bin of [blankBin, junkBin]) {
    process.env.AGETOR_CODEX_BIN = bin;
    const codex = store.harnesses.get("codex")!;
    const st = await status.checkHarness(codex, { freshAuth: true });
    expect(await orchestrator.minCliVersionError(codex, "gpt-6.1-sol", st)).toBeNull();
  }
});

test("the board's Run still refuses a version below the minimum with the existing wording", async () => {
  process.env.AGETOR_CODEX_BIN = oldBin;
  const taskId = await newTask(project("board-old"));
  const started = await orchestrator.startTask(taskId);
  expect("error" in started && started.error).toContain("0.159.0");
  expect(store.runs.listForTask(taskId).length).toBe(0);
});

test("an isolated outer-Seatbelt Cursor run stays refused while manual Cursor buildCommand works", async () => {
  const cursor = addHarness("cursor-spawn", "cursor", cursorBin, "Cursor (spawn fixture)");
  const before = invocations().length;
  const chunks: string[] = [];
  await expect(agents.spawnAgent({
    taskId: "task-cursor-d9", runId: "run-cursor-d9", harness: cursor, prompt: "hello", cwd: isolated,
    onChunk: (chunk: { data?: string }) => { chunks.push(String(chunk.data ?? "")); },
    opts: { model: "grok-4.7", mode: "auto", cursorRuntime: {} as never },
  } as never)).rejects.toThrow(/Cursor is not executable/);
  expect(invocations().length).toBe(before);
  expect(chunks).toEqual([]);
  expect(agents.buildCommand(cursor, "hello", { model: "grok-4.7", mode: "auto" }).cmd).toContain("--force");
});

test("the production builder runs the very executable the review showed, with the reviewed model and sandbox", () => {
  const codex = addHarness("codex-builder", "codex", okBin);
  const facts = target.describeLaunchTarget(codex, { model: "gpt-6.1-sol", mode: "auto" });
  const developer = agents.buildCommand(codex, "work", { model: "gpt-6.1-sol", mode: "auto", effort: "low" }).cmd;
  expect(developer[0]).toBe(facts.executable.path!);
  expect(developer).toContain("gpt-6.1-sol");
  expect(developer.join(" ")).toMatch(/--sandbox (workspace-write|danger-full-access)/);
  const reviewer = agents.buildCommand(codex, "review", { model: "gpt-6.1-sol", mode: "ask", effort: "low" }).cmd;
  expect(reviewer[0]).toBe(facts.executable.path!);
  expect(reviewer.join(" ")).toContain("--sandbox read-only");
  expect(reviewer.join(" ")).not.toContain("danger-full-access");

  const claude = addHarness("claude-builder", "claude-code", claudeBin, "Claude Code (builder)");
  const claudeFacts = target.describeLaunchTarget(claude, { model: "opus-5.5", mode: "auto" });
  const claudeCmd = agents.buildCommand(claude, "work", { model: "opus-5.5", mode: "auto", effort: "high" }).cmd;
  expect(claudeCmd[0]).toBe(claudeFacts.executable.path!);
  expect(claudeFacts.minimumEnforced).toBe(false);
});

test("opening Settings or Accounts starts no Codex process, and the screens carry the resolved target", async () => {
  process.env.AGETOR_CODEX_BIN = okBin;
  const backend = await import("./server.ts");
  const server = backend.startApiServer() as unknown as { stop: (force?: boolean) => void };
  const call = async (route: string, init: RequestInit = {}) => {
    const res = await fetch(`http://127.0.0.1:47012${route}`, { ...init, headers: { authorization: `Bearer ${backend.API_TOKEN}`, "content-type": "application/json" } });
    return { status: res.status, json: await res.json().catch(() => null) as any };
  };
  try {
    const { AccountCore } = await import("./account-core.ts");
    const profiles = new profilesModule.CodexProfiles(new AccountCore(store.db));
    const directory = path.join(ownerHome, "profile-screen");
    mkdirSync(directory, { recursive: true });
    writeFileSync(path.join(directory, "synthetic-authenticated"), "subject-screen");
    const registered = profiles.register({ displayName: "Screen profile", directory });
    const before = invocations().filter((line) => line.startsWith("codex-")).length;
    const settings = await call("/harnesses");
    const accounts = await call("/account-core/codex-profiles");
    expect(settings.status).toBe(200);
    expect(accounts.status).toBe(200);
    expect(invocations().filter((line) => line.startsWith("codex-")).length).toBe(before);
    const codex = settings.json.runtimeReadiness.find((r: any) => r.providerId === "codex");
    expect(codex.launchTarget).toMatchObject({ executable: { path: okBin }, version: { state: "not-checked" }, verdict: "unverified" });
    const cursor = settings.json.runtimeReadiness.find((r: any) => r.providerId === "cursor");
    expect(cursor.launchTarget).toMatchObject({ verdict: "blocked", code: "contract-blocked" });
    const card = accounts.json.find((p: any) => p.accountId === registered.accountId);
    expect(card.launchTarget).toMatchObject({ code: "version-not-checked", executable: { path: okBin } });
    // The Owner's Check reads the version of this profile's own executable, once.
    const checked = await call(`/account-core/codex-profiles/${registered.accountId}/check`, { method: "POST" });
    expect(checked.status).toBe(200);
    expect(checked.json.launchTarget).toMatchObject({ verdict: "compatible", version: { state: "read", parsed: "0.159.2" } });
    expect(invocations().filter((line) => line.includes("--version")).length).toBeGreaterThan(0);
    const again = await call("/account-core/codex-profiles");
    expect(again.json.find((p: any) => p.accountId === registered.accountId).launchTarget).toMatchObject({ code: "compatible" });
  } finally { server.stop(true); }
});
