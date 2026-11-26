/**
 * FO-NATIVE-WORKFLOW01 packaged walkthrough.
 * Isolated ForgeOrbitQA only. Fake drivers. One real local bun test.
 *
 * FORGEORBIT_QA_OUTPUT_ROOT=<root> bun --no-env-file scripts/build-qa-native.ts
 * bun --no-env-file scripts/qa-native-workflow01.ts <root>
 */
import { assertNativeQaEnvironment, NATIVE_QA_STUB } from "../src/bun/native-qa-environment.ts";
import { FAKE_PRACTICAL_IMPL_MARKER } from "../src/shared/practical-cycle.ts";
import assert from "node:assert/strict";
import { homedir } from "node:os";
import { mkdirSync, existsSync, realpathSync, readFileSync, writeFileSync, openSync, closeSync, statSync } from "node:fs";
import { spawn, spawnSync } from "node:child_process";
import { join } from "node:path";

const root = realpathSync(process.argv[2] ?? "");
assert.match(root, /^\/private\/tmp\/fo-native-workflow01-[A-Za-z0-9]+$/);
const repo = join(import.meta.dir, "..");
const runtime = join(root, "runtime");
const data = join(runtime, "data");
const home = join(runtime, "home");
const tmp = join(runtime, "tmp");
const alpha = join(runtime, "Alpha");
const beta = join(runtime, "Beta");
const app = join(root, "ForgeOrbitQA-dev.app");
const appBin = join(app, "Contents/MacOS");
assert.equal(realpathSync(app), app);
const helper = join(root, "qa-native-pid");
const portProbe = Bun.listen({ hostname: "127.0.0.1", port: 0, socket: { data() {} } });
const apiPort = portProbe.port;
portProbe.stop(true);
const logPath = join(root, "native.log");
const credFile = join(data, "agetor-core.json");
assert(!existsSync(data), "Refusing to reuse a QA profile");
for (const p of [data, home, tmp, join(alpha, "src"), join(beta, "src")]) mkdirSync(p, { recursive: true, mode: 0o700 });

const TEST_SOURCE = `import { expect, test } from "bun:test";
import { add } from "./add.ts";
test("add", () => { expect(add(1, 2)).toBe(3); });
`;
const git = (dir: string, args: string[]) => {
  const result = spawnSync("git", args, { cwd: dir, encoding: "utf8" });
  if (result.status !== 0) throw new Error(result.stderr || "git fixture failed");
};
for (const dir of [alpha, beta]) {
  writeFileSync(join(dir, "src", "add.test.ts"), TEST_SOURCE);
  writeFileSync(join(dir, "README.md"), "fixture\n");
  git(dir, ["init", "-q"]);
  git(dir, ["add", "."]);
  git(dir, ["-c", "user.email=fixture@example.com", "-c", "user.name=Fixture", "commit", "-q", "-m", "fixture"]);
}

const ownerPaths = [
  join(homedir(), "Library/Application Support/ForgeOrbit"),
  join(homedir(), "Library/WebKit/app.forgeorbit"),
  join(homedir(), ".agetor"),
  join(homedir(), ".forgeorbit"),
  join(homedir(), ".codex"),
  join(homedir(), ".claude"),
];
const stamp = (p: string) => {
  try { const s = statSync(p); return `${s.mtimeMs}:${s.size}`; } catch { return "absent"; }
};
const ownerBefore = Object.fromEntries(ownerPaths.map((p) => [p, stamp(p)]));

const sh = (argv: string[], timeout = 15000) => {
  const result = spawnSync(argv[0]!, argv.slice(1), { encoding: "utf8", timeout, maxBuffer: 16 * 1024 * 1024 });
  if (result.status !== 0) throw Error(result.stderr?.trim() || String(result.error ?? "helper unavailable"));
  return result.stdout.trim();
};
sh(["/usr/bin/clang", "-fobjc-arc", "-framework", "Cocoa", "-framework", "ApplicationServices", join(repo, "scripts/qa-native-pid.m"), "-o", helper]);

const env: Record<string, string> = {
  PATH: "/usr/bin:/bin:/usr/sbin:/sbin", SHELL: "/bin/sh", LANG: "en_US.UTF-8", HOME: home, TMPDIR: tmp,
  CODEX_HOME: home, CLAUDE_CONFIG_DIR: home, CURSOR_CONFIG_DIR: home, GEMINI_CLI_HOME: home,
  XDG_CONFIG_HOME: home, XDG_DATA_HOME: home, XDG_STATE_HOME: home, XDG_CACHE_HOME: home, LD_LIBRARY_PATH: ".",
  FORGEORBIT_DATA_DIR: data, AGETOR_DATA_DIR: data, FORGEORBIT_API_PORT: String(apiPort), AGETOR_API_PORT: String(apiPort),
  FORGEORBIT_USAGE_OFFLINE: "1", AGETOR_USAGE_OFFLINE: "1", FORGEORBIT_DISABLE_UPDATES: "1", AGETOR_DISABLE_UPDATES: "1",
};
const kinds = ["CLAUDE", "CODEX", "CURSOR", "GEMINI", "FX", "ANTIGRAVITY"];
for (const kind of kinds) env[`AGETOR_${kind}_DRIVER`] = "fake";
for (const kind of [...kinds, "TMUX", "NOTIFIER", "DISCLAIM"]) {
  const stub = join(runtime, kind.toLowerCase());
  writeFileSync(stub, NATIVE_QA_STUB, { mode: 0o755 });
  env[`AGETOR_${kind}_BIN`] = stub;
}
assert.equal("AGETOR_ALLOW_REAL_IMPROVEMENT_INFERENCE" in env, false);
assertNativeQaEnvironment(runtime, env);
const receipt = JSON.parse(readFileSync(join(root, "qa-native-build.json"), "utf8"));
assert.equal(receipt.bundleIdentifier, "app.forgeorbit.qa");
assert.equal(receipt.qaRuntimeRoot, runtime);

for (const key of ["NSAutomaticQuoteSubstitutionEnabled", "NSAutomaticDashSubstitutionEnabled", "NSAutomaticTextReplacementEnabled", "NSAutomaticSpellingCorrectionEnabled"]) {
  spawnSync("defaults", ["write", "NSGlobalDomain", key, "-bool", "false"], { env: { ...process.env, HOME: home } });
}
const launch = () => {
  const fd = openSync(logPath, "a", 0o600);
  const child = spawn(join(appBin, "launcher"), [], { cwd: appBin, env, detached: true, stdio: ["ignore", fd, fd] });
  closeSync(fd);
  return child;
};

const steps: string[] = [];
const controls: string[] = [];
const verdicts: Record<string, string> = {};
const evidence: Record<string, unknown> = {
  apiPort, bundle: "app.forgeorbit.qa", manifest: receipt.artifactManifestSHA256,
  fakeDrivers: kinds, syntheticHead: true, syntheticImplementation: true, observedTest: "bun test ./src/add.test.ts",
  steps, controls, verdicts,
};
const evidencePath = join(root, "fo-native-workflow01-evidence.json");
const save = () => writeFileSync(evidencePath, JSON.stringify(evidence, null, 2) + "\n");
const mark = (step: string) => { steps.push(step); save(); console.log(step); };

const poll = async <T>(label: string, fn: () => T | null | Promise<T | null>, timeout = 20000): Promise<T> => {
  const end = Date.now() + timeout;
  let last = "";
  do {
    try {
      const value = await fn();
      if (value) return value;
    } catch (error) { last = (error as Error).message; }
    await Bun.sleep(250);
  } while (Date.now() < end);
  throw Error(`${label}${last ? `: ${last}` : ""}`);
};

let child: ReturnType<typeof launch> | undefined;
let creds: { pid: number; port: number; token: string };
const boot = async () => {
  child = launch();
  await poll("Packaged backend did not boot", async () => {
    if (!existsSync(credFile)) return null;
    try {
      const result = await fetch(`http://127.0.0.1:${apiPort}/health`, { signal: AbortSignal.timeout(750) });
      return result.ok || null;
    } catch { return null; }
  }, 25_000);
  creds = JSON.parse(readFileSync(credFile, "utf8"));
  assert.equal(creds.port, apiPort);
  assert.match(readFileSync(logPath, "utf8"), /FO-NATIVE005-QA-EPHEMERAL-V1/);
};
const stop = async () => {
  if (!child?.pid) return;
  const pid = child.pid;
  const exited = new Promise<void>((resolve) => {
    if (child?.exitCode != null || child?.signalCode != null) resolve();
    else child?.once("exit", () => resolve());
  });
  try { process.kill(-pid, "SIGTERM"); } catch { /* already stopped */ }
  await Promise.race([exited, Bun.sleep(4000)]);
  try { process.kill(-pid, 0); } catch { child = undefined; return; }
  try { process.kill(-pid, "SIGKILL"); } catch { /* already stopped */ }
  await Bun.sleep(500);
  child = undefined;
};

async function api(method: string, route: string, body?: unknown, expected = 200): Promise<any> {
  const res = await fetch(`http://127.0.0.1:${apiPort}${route}`, {
    method,
    headers: { authorization: `Bearer ${creds.token}`, "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(20_000),
  });
  const raw = await res.text();
  assert.equal(res.status, expected, `${method} ${route}: HTTP ${res.status}${raw ? ` ${raw.slice(0, 500)}` : ""}`);
  if (!raw && expected === 204) return null;
  return raw ? JSON.parse(raw) : null;
}
const get = (route: string) => api("GET", route);

type AxNode = { AXRole?: string; AXTitle?: string; AXDescription?: string; AXHelp?: string; AXValue?: string | number; AXEnabled?: boolean;
  frame?: { x: number; y: number; width: number; height: number }; children?: AxNode[] };
const entries = (node: AxNode | undefined): AxNode[] => node ? [node, ...(node.children ?? []).flatMap(entries)] : [];
const labels = (node: AxNode) => [node.AXTitle, node.AXDescription, node.AXValue, node.AXHelp].filter((x): x is string => typeof x === "string");
const names = (node: AxNode) => [node.AXTitle, node.AXDescription].filter((x): x is string => typeof x === "string");
const bindingFile = join(root, "binding.json");
let binding: { axTrusted: boolean; windowId: number; corePid: number };
const ax = (...args: string[]) => sh([helper, bindingFile, ...args]);
const inspect = () => JSON.parse(ax("inspect")) as { web?: AxNode };
const bind = async () => {
  const candidate = join(root, "candidate.json");
  writeFileSync(candidate, JSON.stringify({ launcherPid: child?.pid, corePid: creds.pid, artifact: app }), { mode: 0o600 });
  binding = await poll("Packaged window could not be bound", () => {
    try { return JSON.parse(sh([helper, candidate, "identify"])); } catch { return null; }
  }, 20_000);
  assert(binding.axTrusted, "macOS Accessibility is unavailable to the QA runner");
  writeFileSync(bindingFile, JSON.stringify(binding), { mode: 0o600 });
  await poll("Packaged window frame was not stable", () => {
    spawnSync("osascript", ["-e", "tell application id \"app.forgeorbit.qa\" to activate"], { timeout: 3000 });
    ax("focus");
    return true;
  }, 20_000);
};
const find = (predicate: (node: AxNode) => boolean) => entries(inspect().web).filter(predicate);
const seek = (label: string, predicate: (node: AxNode) => boolean, timeout = 12_000) =>
  poll(label, () => find(predicate).at(-1) ?? null, timeout);
const show = (part: string, timeout = 12_000) => seek(`WKWebView did not render "${part}"`,
  (node) => labels(node).some((label) => label.includes(part)), timeout);
const matching = (role: string, name: string) => (n: AxNode) => n.AXRole === role && names(n).some((value) => value === name || value.includes(name));
const click = (node: AxNode) => {
  assert(node.frame, "Control has no clickable bounds");
  const { x, y, width, height } = node.frame;
  ax("click", String(Math.round(x + width / 2)), String(Math.round(y + height / 2)));
};
const activate = (node: AxNode) => {
  const name = names(node)[0];
  assert(node.AXRole && name, "AX control is not labeled");
  try { ax("press", node.AXRole, name); } catch { click(node); }
};
const button = async (name: string) => {
  let node: AxNode | null = null;
  try {
    node = await seek(`Missing enabled button "${name}"`, (n) => matching("AXButton", name)(n) && n.AXEnabled !== false);
  } catch (error) {
    const titles = find((n) => n.AXRole === "AXButton").map((item) => names(item)[0]).filter(Boolean).slice(-25);
    throw Error(`${(error as Error).message}; buttons: ${titles.join(" | ")}`);
  }
  activate(node!);
  controls.push(name);
  await Bun.sleep(250);
};
const key = (code: number, flags = 0) => ax("key", String(code), String(flags));
const choose = async (label: string, option: string, required = true) => {
  const match = matching("AXPopUpButton", label);
  await seek(`Missing select "${label}"`, match);
  for (let i = 0; i < 6; i++) {
    const node = find(match).at(-1);
    if (String(node?.AXValue).includes(option)) { controls.push(`${label}=${option}`); return true; }
    try { ax("press", "AXPopUpButton", label); } catch { try { ax("focus-name", "AXPopUpButton", label); } catch { /* The popup was not exposed on this pass. */ } }
    await Bun.sleep(500);
    const item = find((n) => n.AXRole !== "AXPopUpButton" && labels(n).some((value) => value.includes(option))).at(-1);
    const itemName = item ? names(item)[0] : "";
    if (item?.AXRole && itemName) {
      try { ax("press", item.AXRole, itemName); } catch { /* Fall through to the menu-item role. */ }
    }
    try { ax("press", "AXMenuItem", option); } catch { /* The option is not exposed in this menu. */ }
    await Bun.sleep(250);
  }
  const last = find(match).at(-1);
  if (required) throw Error(`${label} stayed on "${last?.AXValue ?? ""}"`);
  controls.push(`${label} stayed ${last?.AXValue ?? ""}`);
  return false;
};
const fill = async (name: string, value: string) => {
  const node = await seek(`Missing field "${name}"`, (n) => ["AXTextArea", "AXTextField"].includes(n.AXRole ?? "") && names(n).some((label) => label.includes(name)));
  const role = node.AXRole!;
  const accessible = names(node).find((label) => label.includes(name)) ?? name;
  ax("focus-name", role, accessible);
  await Bun.sleep(120);
  key(0, 1048576);
  key(51);
  ax("text", value);
  await Bun.sleep(150);
  const written = find((n) => n.AXRole === role && names(n).some((label) => label.includes(name))).at(-1);
  assert(String(written?.AXValue ?? "").includes(value.slice(0, 24)), `${name} did not receive the typed value`);
  controls.push(`fill:${name}`);
};
const openProjectBrain = async (name: string) => {
  await button(name);
  await seek(`Project ${name} did not open`, (n) => n.AXRole === "AXHeading" && labels(n).some((value) => value.includes(name)));
  ax("press", "AXCheckBox", "Brain for this project");
  controls.push("Brain for this project");
  await show("Project memories stay on this project");
};
const check = async (label: string, want = true) => {
  const node = await seek(`Missing checkbox "${label}"`, (n) => n.AXRole === "AXCheckBox" && labels(n).some((value) => value.includes(label)));
  const on = node.AXValue === 1 || node.AXValue === "1" || node.AXValue === true;
  if (on !== want) {
    activate(node);
    await Bun.sleep(200);
  }
  controls.push(`check:${label}`);
};

const prompt = `${FAKE_PRACTICAL_IMPL_MARKER} FO_PRACTICAL_OUTPUT src/add.ts Implement add so the authorized test passes.`;
const boardTitle = "Alpha board notes";

try {
  await boot();
  mark("Packaged ForgeOrbitQA started on a disposable profile");
  await api("PUT", "/preferences/onboardingDismissed", { value: "true" }, 204);
  await api("PUT", "/preferences/locale", { value: "en" }, 204);
  const project = await api("POST", "/projects", { path: alpha, name: "Workflow Alpha" });
  await api("POST", "/projects", { path: beta, name: "Workflow Beta" });
  const cluster = await api("POST", "/clusters", { name: "Workflow Cluster" }, 201);
  await api("POST", `/clusters/${cluster.id}/projects`, { projectPath: project.path }, 201);
  await api("POST", `/clusters/${cluster.id}/projects`, { projectPath: beta }, 201);
  const worker = await api("POST", "/employees", { projectPath: alpha, name: "Ada", jobTitle: "Developer" }, 201);
  await api("PATCH", "/harnesses/codex", { enabled: true });
  const config = { harness: "codex", model: "gpt-5.6-sol", effort: "low" };
  const preflight = await api("POST", "/project-interviews/preflight", config);
  await api("PUT", "/portfolio-manager/config", { config: { ...config, consentKey: preflight.isolation.consentKey } });
  const memory = await api("POST", "/brain/memories", {
    scopeKind: "project", projectPath: alpha, title: "Alpha busy timeout", kind: "decision",
    content: "Workflow Alpha keeps SQLite busy_timeout at 2000ms.",
  }, 201);
  evidence.memoryId = memory.id;
  const channel = await get("/infra-auto/channel");
  assert.equal(channel.available, false);

  await bind();
  const skip = find((n) => ["Skip", "Пропустить"].some((s) => matching("AXButton", s)(n))).at(-1);
  if (skip) activate(skip);
  await button("Open Head of PM");
  const scoped = await choose("Context", "Workflow Alpha", false);
  verdicts.headScopeSelect = scoped ? "PASS" : "NOT VERIFIED";
  if (!scoped) mark("Head scope menu stayed on Workspace overview; proposals name the project explicitly");
  const propose = async (action: Record<string, unknown>) => {
    action = { projectPath: alpha, ...action };
    const before = (await get("/portfolio-manager")).messages.length;
    const composer = await seek("Missing Head composer", (n) => ["AXTextArea", "AXTextField"].includes(n.AXRole ?? "")
      && labels(n).some((value) => value.includes("Message to Head of PM")));
    ax("focus-name", composer.AXRole!, names(composer)[0]!);
    ax("text", `__fake_head_board__ ${JSON.stringify(action)}`);
    key(36, 1048576);
    controls.push("Head send");
    await poll("Head did not answer", async () => {
      const state = await get("/portfolio-manager");
      return state.messages.length >= before + 2 && !state.activeTurn ? state : null;
    }, 40_000);
    await show("Review the board proposal");
    const state = await get("/portfolio-manager");
    const proposal = state.boardProposals?.at(-1);
    if (!proposal || proposal.status !== "pending") {
      const last = state.messages?.at(-1);
      const owner = state.messages?.at(-2);
      throw Error(`No pending Head proposal: ${JSON.stringify({ proposal, errors: last?.protocolErrors, owner: String(owner?.text ?? "").slice(0, 240), reply: String(last?.text ?? "").slice(0, 180) })}`);
    }
  };
  const approve = async () => {
    await button("Approve");
    let last = "";
    await poll("Head proposal was not applied", async () => {
      const current = (await get("/portfolio-manager")).boardProposals?.at(-1);
      last = `${current?.status ?? "missing"}${current?.error ? `: ${current.error}` : ""}`;
      if (current?.status === "applied") return current;
      if (current && !["pending", "applying"].includes(current.status)) throw Error(last);
      return null;
    }, 90_000).catch((error) => { throw Error(`${(error as Error).message} (${last})`); });
  };
  await propose({ kind: "create", title: boardTitle, projectPath: alpha, description: "Organize the Alpha board. This note is not the execution prompt." });
  assert.equal((await get("/tasks")).some((row: { title: string }) => row.title === boardTitle), false);
  await approve();
  let board = (await get("/tasks")).find((row: { title: string }) => row.title === boardTitle);
  assert.equal(board.column, "backlog");
  await propose({ kind: "edit", taskId: board.id, title: boardTitle, description: "Keep this board note in the project." });
  await approve();
  await propose({ kind: "prioritize", taskId: board.id, priority: "high" });
  await approve();
  await propose({ kind: "admit", taskId: board.id });
  assert.equal((await get(`/tasks/${board.id}`)).column, "backlog");
  await approve();
  assert.equal((await get(`/tasks/${board.id}`)).column, "inbox");
  await propose({ kind: "assign", taskId: board.id, employeeId: worker.id });
  await approve();
  await propose({ kind: "stage_ready", taskId: board.id });
  await approve();
  verdicts.executionPlan = "NOT VERIFIED";
  evidence.executionPlan = "The employee execution review asks for an explicit Full access decision before Git writes outside the app workspace. This campaign does not grant that.";
  board = await get(`/tasks/${board.id}`);
  assert.equal(board.column, "ready");
  const boardRuns = await get(`/employee-execution/attempts?taskId=${board.id}`);
  assert.equal(boardRuns.attempts.length, 0);
  evidence.boardTaskId = board.id;
  verdicts.head = "PASS";
  mark("Head created, edited, prioritized, admitted, assigned, and staged a task only after each approval");
  await button("Close Head of PM");

  await button("Missions");
  await show("Multi-Project Mission Control");
  await button("Full Autonomy");
  await show("Full Autonomy is not active");
  await show("Trusted Owner authorization is unavailable");
  const beforeDraft = await get("/api/autonomy/status");
  assert.equal(beforeDraft.enforcement.fullAutonomyActive, false);
  assert.equal(beforeDraft.policies.length, 0);
  verdicts.modeDoesNotActivate = "PASS";
  await fill("Authorized projects", `${alpha}\n${beta}`);
  await fill("Providers", "codex");
  await fill("Models", "gpt-5.6-sol");
  await fill("Launches", "40");
  await check("Allow a resource that has no account id");
  await check("Require the fixed observed Bun test");
  await check("QC PASS may complete tasks");
  await check("Permit self-improvement proposals");
  await show("bun test ./src/add.test.ts");
  await button("Save draft");
  const drafted = await poll("Draft policy was not stored", async () => {
    const status = await get("/api/autonomy/status");
    const policy = status.policies.find((row: { status: string }) => row.status === "draft");
    return policy && status.enforcement.fullAutonomyActive === false ? status : null;
  });
  await show("Draft digest");
  evidence.draftDigest = drafted.policies.at(-1)?.digest ?? drafted.policies[0]?.digest;
  await button("Activate policy");
  const active = await poll("Full Autonomy did not become the enforced mode", async () => {
    const status = await get("/api/autonomy/status");
    return status.enforcement.fullAutonomyActive ? status : null;
  });
  assert.equal(active.policies.some((row: { status: string; mode: string }) => row.status === "active" && row.mode === "full-autonomy"), true);
  verdicts.policy = "PASS";
  mark("Saved a draft, then activated that revision; the mode button alone did not activate it");

  await fill("Mission title", "Workflow mission");
  await fill("Mission goal", "Implement add and pass the authorized test.");
  const missionLines = [
    `Alpha backend | ${alpha} | developer | - | - | ${prompt}`,
    `Beta follow-up | ${beta} | developer | Alpha backend | - | ${prompt} FO_PRACTICAL_CORRECT`,
  ];
  const missionField = await seek("Missing mission tasks", (n) => n.AXRole === "AXTextArea" && names(n).some((label) => label.includes("Mission tasks")));
  ax("focus-name", "AXTextArea", names(missionField).find((label) => label.includes("Mission tasks"))!);
  key(0, 1048576);
  key(51);
  ax("text", missionLines[0]!);
  key(36);
  ax("text", missionLines[1]!);
  controls.push("fill:Mission tasks");
  await button("Start authorized mission");
  const mission = await poll("Mission did not start", async () => {
    const listed = await get("/api/orchestration/missions");
    return listed.missions.find((row: { title: string }) => row.title === "Workflow mission") ?? null;
  }, 30_000);
  evidence.missionId = mission.id;
  const alphaPlan = mission.plan.tasks.find((row: { taskTitle: string }) => row.taskTitle === "Alpha backend");
  const betaPlan = mission.plan.tasks.find((row: { taskTitle: string }) => row.taskTitle === "Beta follow-up");
  assert(alphaPlan && betaPlan, "Mission plan is missing a task");
  let sawFailure = false;
  let betaStartedEarly = false;
  const cycle = await poll("Observed test cycle did not finish", async () => {
    const status = await get("/api/autonomy/practical-cycle?missionId=" + encodeURIComponent(mission.id));
    const attempts = status.attempts as Array<{ taskId: string; status: string; exitCode: number | null; isolation: string; implementationExecution: string; failureKind: string | null }>;
    const blocked = attempts.find((row) => row.isolation === "blocked" || row.status === "blocked");
    if (blocked) return { blocked, attempts };
    const alphaAttempts = attempts.filter((row) => row.taskId === alphaPlan.taskId);
    if (alphaAttempts.some((row) => row.status === "failed" && row.exitCode !== 0)) sawFailure = true;
    const tasks = await get("/tasks");
    const alphaTask = tasks.find((row: { id: string }) => row.id === alphaPlan.taskId);
    const betaTask = tasks.find((row: { id: string }) => row.id === betaPlan.taskId);
    if ((betaTask?.column === "running" || betaTask?.column === "review" || betaTask?.column === "done") && alphaTask?.column !== "done") betaStartedEarly = true;
    const passed = alphaAttempts.some((row) => row.status === "passed" && row.exitCode === 0 && row.isolation === "macos-offline-seatbelt");
    if (sawFailure && passed && alphaTask?.column === "done" && betaTask?.column === "done" && alphaTask?.qcState?.latestVerdict === "PASS" && betaTask?.qcState?.latestVerdict === "PASS") {
      return { attempts, alphaTask, betaTask };
    }
    return null;
  }, 240_000);
  evidence.attempts = cycle.attempts ?? cycle;
  evidence.betaStartedEarly = betaStartedEarly;
  if ("blocked" in cycle && cycle.blocked) {
    verdicts.observedTest = "BLOCKED";
    evidence.blockReason = cycle.blocked;
    mark("Observed test was blocked by the sandbox; no pass was invented");
  } else {
    assert.equal(sawFailure, true);
    assert.equal(betaStartedEarly, false);
    await show("Failed", 20_000);
    await show("Passed", 20_000);
    await show("synthetic");
    verdicts.observedTest = "PASS";
    verdicts.qc = "PASS";
    verdicts.done = "PASS";
    mark("UI showed a real failed test, one rework, a passing retest, and QC PASS");
  }
  assert.equal((await get(`/employee-execution/attempts?taskId=${board.id}`)).attempts.length, 0);
  verdicts.boardNotLaunched = "PASS";

  if (verdicts.observedTest === "PASS") {
    await button("Enable");
    await button("Look for candidates");
    const discovered = await get("/api/self-improvement/status");
    evidence.improvementCandidates = discovered.candidates?.length ?? 0;
    evidence.improvementObservations = discovered.observations ?? null;
    if ((discovered.candidates ?? []).length === 0) {
      verdicts.selfImprovement = "PARTIAL";
      mark("Self-improvement controls ran; no repeated weakness was available to draft");
    } else {
      const candidateButton = await seek("Missing improvement candidate", (n) => n.AXRole === "AXButton" && names(n).some((value) => value.toLowerCase().includes("developer")));
      activate(candidateButton);
      controls.push("improvement candidate");
      await button("Prepare draft");
      await show("synthetic");
      await button("Evaluate on authorized test");
      const evaluated = await poll("Improvement evaluation did not finish", async () => {
        const status = await get("/api/self-improvement/status");
        const row = status.candidates?.find((item: { decision?: string }) => item.decision);
        return row ?? null;
      }, 180_000);
      evidence.improvementDecision = evaluated.decision;
      if (evaluated.decision !== "pass") {
        verdicts.selfImprovement = "PARTIAL";
        mark(`Improvement evaluation decision was ${evaluated.decision}; it was not activated`);
      } else {
        await button("Approve");
        await button("Activate");
        const followField = await seek("Missing mission tasks", (n) => n.AXRole === "AXTextArea" && names(n).some((label) => label.includes("Mission tasks")));
        ax("focus-name", "AXTextArea", names(followField).find((label) => label.includes("Mission tasks"))!);
        key(0, 1048576);
        key(51);
        ax("text", `Skill check | ${alpha} | developer | - | - | ${prompt} FO_PRACTICAL_CORRECT`);
        await button("Start authorized mission");
        const used = await poll("Activated skill was not recorded on a later launch", async () => {
          const status = await get("/api/self-improvement/status");
          const hit = (status.launches ?? []).find((row: { versions?: Array<{ version: number }> }) => (row.versions ?? []).some((version) => version.version > 1));
          return hit ?? null;
        }, 90_000);
        evidence.skillLaunch = { runId: used.runId, versions: used.versions };
        await show("not a measured gain in model intelligence");
        verdicts.selfImprovement = "PASS";
        mark("Activated skill was included in a later synthetic Developer launch");
      }
    }
  } else {
    verdicts.selfImprovement = "NOT VERIFIED";
  }

  await openProjectBrain("Workflow Alpha");
  await show("paraphrase-multilingual-MiniLM-L12-v2");
  const listed = await get(`/brain/memories?scopeKind=project&projectPath=${encodeURIComponent(alpha)}&status=active`);
  evidence.brainTitles = (listed.memories ?? []).map((row: { title: string }) => row.title);
  try {
    await show("Alpha busy timeout", 30_000);
  } catch (error) {
    throw Error(`${(error as Error).message}; listed: ${JSON.stringify(evidence.brainTitles)}`);
  }
  await choose("Search mode", "Lexical");
  await fill("Search titles and text", "busy timeout");
  await button("Search");
  await show("Alpha busy timeout", 30_000);
  await button("Extraction Candidates");
  const candidateVisible = find((n) => n.AXRole === "AXButton" && names(n).some((value) => value.includes("Observed test did not pass"))).length > 0;
  if (candidateVisible) {
    await button("Observed test did not pass");
    await button("Approve & Save");
    verdicts.brainCandidate = "PASS";
  } else {
    verdicts.brainCandidate = "NOT VERIFIED";
  }
  await button("Rebuild Index");
  await show("Index rebuilt", 60_000);
  verdicts.brain = "PASS";
  mark("Brain search, mode, and index rebuild ran in the packaged window");
  await button("Open Head of PM");
  try {
    await button("Brain for the next message");
    const memoryBox = await seek("Missing memory checkbox", (n) => n.AXRole === "AXCheckBox" && labels(n).some((value) => value.includes("Alpha busy timeout")), 8_000);
    activate(memoryBox);
    await button("Preview context");
    await show("Context that will be sent", 15_000);
    await button("Use these memories on the next message");
    await show("approved for the next message", 12_000);
    verdicts.brainInHead = "PASS";
  } catch (error) {
    verdicts.brainInHead = "NOT VERIFIED";
    evidence.brainInHead = (error as Error).message;
  }
  const closeHead = find((n) => matching("AXButton", "Close Head of PM")(n)).at(-1);
  if (closeHead) { activate(closeHead); await Bun.sleep(250); }

  await button("Settings");
  await button("AI Router 2.0");
  await show("A router preference does not launch a worker.");
  await show("unknown quota");
  verdicts.router = "PASS";
  key(53);
  mark("Router page showed preference text and the unknown-quota warning");
  verdicts.infrastructure = "PASS";

  await button("Missions");
  await button("Emergency stop");
  await show("Emergency stop is active");
  const stopped = await get("/api/autonomy/status");
  assert.equal(stopped.emergency.active, true);
  const runsBefore = (await get("/tasks")).map((row: { id: string; column: string; runId: string | null }) => [row.id, row.column, row.runId]);
  evidence.runsBeforeRestart = runsBefore;
  verdicts.emergency = "PASS";
  await stop();
  mark("Quit the packaged app after emergency stop");

  await boot();
  await bind();
  const projects = await get("/projects");
  assert(projects.some((row: { name: string }) => row.name === "Workflow Alpha"));
  const runsAfter = (await get("/tasks")).map((row: { id: string; column: string; runId: string | null }) => [row.id, row.column, row.runId]);
  assert.deepEqual(runsAfter, runsBefore);
  const remembered = await get("/brain/memories/search?scopeKind=project&projectPath=" + encodeURIComponent(alpha) + "&mode=lexical&q=" + encodeURIComponent("busy timeout"));
  assert(remembered.results.some((row: { id: string }) => row.id === memory.id));
  const channelAfter = await get("/infra-auto/channel");
  assert.equal(channelAfter.available, false);
  const stillStopped = await get("/api/autonomy/status");
  assert.equal(stillStopped.emergency.active, true);
  await button("Missions");
  await show("Emergency stop is active");
  await openProjectBrain("Workflow Alpha");
  await show("Alpha busy timeout");
  verdicts.restart = "PASS";
  mark("Relaunch kept the tasks, memory, blocked channel, and did not start another run");

  const ownerAfter = Object.fromEntries(ownerPaths.map((p) => [p, stamp(p)]));
  assert.deepEqual(ownerAfter, ownerBefore, "Owner profile paths changed");
  evidence.ownerUntouched = true;
  evidence.result = Object.values(verdicts).every((value) => value === "PASS") ? "pass" : "partial";
  save();
  console.log(JSON.stringify(verdicts, null, 2));
} catch (error) {
  evidence.result = "fail";
  evidence.error = (error as Error).stack ?? String(error);
  save();
  console.error(error);
  try { writeFileSync(join(root, "ax-at-stop.json"), JSON.stringify(inspect(), null, 2)); } catch { /* no tree */ }
  try { await stop(); } catch { /* already stopped */ }
  process.exitCode = 1;
} finally {
  try { await stop(); } catch { /* already stopped */ }
  save();
}
