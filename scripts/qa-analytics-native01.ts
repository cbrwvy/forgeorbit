/**
 * FO-ANALYTICS-NATIVE01 packaged walkthrough.
 * Isolated ForgeOrbitQA only. Fake drivers and recorded synthetic usage.
 *
 * FORGEORBIT_QA_OUTPUT_ROOT=<root> bun --no-env-file scripts/build-qa-native.ts
 * bun --no-env-file scripts/qa-analytics-native01.ts <root>
 */
import { Database } from "bun:sqlite";
import { seedMissionReplanFixture } from "./qa-forecast-replan01-fixture.ts";
import { assertNativeQaEnvironment, NATIVE_QA_STUB } from "../src/bun/native-qa-environment.ts";
import assert from "node:assert/strict";
import { homedir } from "node:os";
import { mkdirSync, existsSync, realpathSync, readFileSync, writeFileSync, openSync, closeSync, statSync } from "node:fs";
import { spawn, spawnSync } from "node:child_process";
import { join } from "node:path";

const root = realpathSync(process.argv[2] ?? "");
assert.match(root, /^\/private\/tmp\/fo-analytics-native01-[A-Za-z0-9]+$/);
const missionReplan = process.argv[3] === "mission-replan";
const evidencePath = join(root, missionReplan ? "fo-forecast-replan02-native.json" : "fo-analytics-native01-evidence.json");
const consoleLocked = () => /"IOConsoleLocked" = Yes/.test(spawnSync("/usr/sbin/ioreg", ["-n", "Root", "-d1"], { encoding: "utf8" }).stdout ?? "");
let stoppedForLock = false;
const requireUnlocked = () => {
  if (missionReplan && (stoppedForLock || consoleLocked())) {
    stoppedForLock = true;
    throw new Error("STOP: macOS console is locked.");
  }
};
requireUnlocked();
const repo = join(import.meta.dir, "..");
const runtime = join(root, "runtime");
const data = join(runtime, "data");
const home = join(runtime, "home");
const tmp = join(runtime, "tmp");
const projectDir = join(runtime, "AnalyticsFixture");
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
for (const p of [data, home, tmp, projectDir]) mkdirSync(p, { recursive: true, mode: 0o700 });
writeFileSync(join(projectDir, "package.json"), "{}\n");
writeFileSync(join(projectDir, "README.md"), "synthetic analytics fixture\n");

const ownerPaths = missionReplan ? [] : [
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

const sh = (argv: string[], timeout = 20000) => {
  const result = spawnSync(argv[0]!, argv.slice(1), { encoding: "utf8", timeout, maxBuffer: 16 * 1024 * 1024 });
  if (result.status !== 0) throw Error(result.stderr?.trim() || result.stdout?.trim() || String(result.error ?? "helper unavailable"));
  return result.stdout.trim();
};
sh(["/usr/bin/clang", "-fobjc-arc", "-framework", "Cocoa", "-framework", "ApplicationServices", join(repo, "scripts/qa-native-pid.m"), "-o", helper]);

const env: Record<string, string> = {
  PATH: "/usr/bin:/bin:/usr/sbin:/sbin", SHELL: "/bin/sh", LANG: "en_US.UTF-8", HOME: home, TMPDIR: tmp,
  CODEX_HOME: home, CLAUDE_CONFIG_DIR: home, CURSOR_CONFIG_DIR: home, GEMINI_CLI_HOME: home,
  XDG_CONFIG_HOME: home, XDG_DATA_HOME: home, XDG_STATE_HOME: home, XDG_CACHE_HOME: home, LD_LIBRARY_PATH: ".",
  FORGEORBIT_DATA_DIR: data, AGETOR_DATA_DIR: data, FORGEORBIT_API_PORT: String(apiPort), AGETOR_API_PORT: String(apiPort),
  FORGEORBIT_EMBEDDING_MODEL_ROOT: join(runtime, "no-models"),
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
  fakeDrivers: kinds, synthetic: true, steps, controls, verdicts,
};
const save = () => writeFileSync(evidencePath, JSON.stringify(evidence, null, 2) + "\n");
const mark = (step: string) => { steps.push(step); save(); console.log(step); };

const poll = async <T>(label: string, fn: () => T | null | Promise<T | null>, timeout = 20000): Promise<T> => {
  const end = Date.now() + timeout;
  let last = "";
  do {
    try {
      const value = await fn();
      if (value) return value;
    } catch (error) {
      if (stoppedForLock) throw error;
      last = (error as Error).message;
    }
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
  }, 30_000);
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
  return raw ? JSON.parse(raw) : null;
}
const get = (route: string) => api("GET", route);

const seed = (args: string[]) => {
  let last = "";
  for (let attempt = 0; attempt < 4; attempt++) {
    const result = spawnSync(process.execPath, ["--no-env-file", join(repo, "scripts/qa-analytics-native01-seed.ts"), ...args], {
      cwd: repo, encoding: "utf8", timeout: 60_000,
      env: { ...env, FORGEORBIT_DATA_DIR: data, AGETOR_DATA_DIR: data, HOME: home },
    });
    if (result.status === 0) return JSON.parse(result.stdout);
    last = `${result.stderr}\n${result.stdout}`.trim();
    if (!/database is locked|SQLITE_BUSY/i.test(last)) break;
    spawnSync("/bin/sleep", ["0.4"]);
  }
  throw new Error(last || "seed failed");
};

type AxNode = { AXRole?: string; AXTitle?: string; AXDescription?: string; AXHelp?: string; AXValue?: string | number; AXEnabled?: boolean;
  AXFocused?: boolean; frame?: { x: number; y: number; width: number; height: number }; children?: AxNode[] };
const entries = (node: AxNode | undefined): AxNode[] => node ? [node, ...(node.children ?? []).flatMap(entries)] : [];
const labels = (node: AxNode) => [node.AXTitle, node.AXDescription, node.AXValue, node.AXHelp].filter((x): x is string => typeof x === "string");
const names = (node: AxNode) => [node.AXTitle, node.AXDescription].filter((x): x is string => typeof x === "string");
const bindingFile = join(root, "binding.json");
let binding: { axTrusted: boolean; windowId: number; corePid: number } | undefined;
const ax = (...args: string[]) => {
  requireUnlocked();
  return sh([helper, bindingFile, ...args]);
};
const inspect = () => JSON.parse(ax("inspect")) as { web?: AxNode };
const bind = async () => {
  requireUnlocked();
  const candidate = join(root, "candidate.json");
  writeFileSync(candidate, JSON.stringify({ launcherPid: child?.pid, corePid: creds.pid, artifact: app }), { mode: 0o600 });
  binding = await poll("Packaged window could not be bound", () => {
    try { return JSON.parse(sh([helper, candidate, "identify"])); } catch { return null; }
  }, 30_000);
  assert(binding.axTrusted, "macOS Accessibility is unavailable to the QA runner");
  writeFileSync(bindingFile, JSON.stringify(binding), { mode: 0o600 });
  ax("focus");
};
const find = (predicate: (node: AxNode) => boolean) => entries(inspect().web).filter(predicate);
const seek = (label: string, predicate: (node: AxNode) => boolean, timeout = 15_000) =>
  poll(label, () => find(predicate).at(-1) ?? null, timeout);
const show = (part: string, timeout = 15_000) => seek(`WKWebView did not render "${part}"`,
  (node) => labels(node).some((label) => label.includes(part)), timeout);
const exactName = (node: AxNode, name: string) => names(node).some((value) => value === name);
const matching = (role: string, name: string) => (n: AxNode) => n.AXRole === role && exactName(n, name);
const click = (node: AxNode) => {
  assert(node.frame, "Control has no clickable bounds");
  const { x, y, width, height } = node.frame;
  ax("focus");
  ax("click", String(Math.round(x + width / 2)), String(Math.round(y + height / 2)));
};
const onScreen = (node: AxNode) => {
  const web = inspect().web?.frame;
  if (!web || !node.frame) return false;
  const x = node.frame.x + node.frame.width / 2;
  const y = node.frame.y + node.frame.height / 2;
  return x >= web.x && x <= web.x + web.width && y >= web.y && y <= web.y + web.height;
};
const activate = (node: AxNode, preferred?: string) => {
  const labeled = names(node).filter((value) => value.length > 0);
  const name = preferred && labeled.some((value) => value.includes(preferred))
    ? preferred
    : labeled.sort((a, b) => b.length - a.length)[0];
  assert(node.AXRole && name, `AX control is not labeled: ${JSON.stringify(labels(node))}`);
  if (onScreen(node) && node.frame) {
    const x = String(Math.round(node.frame.x + node.frame.width / 2));
    const y = String(Math.round(node.frame.y + node.frame.height / 2));
    try { ax("press", node.AXRole, name, x, y); return; }
    catch { click(node); return; }
  }
  ax("press", node.AXRole, name);
};
const button = async (name: string) => {
  const node = await seek(`Missing enabled button "${name}"`, (n) => matching("AXButton", name)(n) && n.AXEnabled !== false);
  activate(node, name);
  controls.push(name);
  await Bun.sleep(300);
};
const disclose = async (name: string) => {
  const node = await seek(`Missing disclosure "${name}"`, (n) => n.AXRole === "AXDisclosureTriangle" && exactName(n, name) && n.AXEnabled !== false);
  activate(node, name);
  controls.push(`disclose:${name}`);
  await Bun.sleep(300);
};
const tab = async (name: string) => {
  const node = await seek(`Missing tab "${name}"`, (n) => n.AXRole === "AXCheckBox" && exactName(n, name) && n.AXEnabled !== false);
  if (node.AXValue !== 1 && node.AXValue !== true) activate(node, name);
  controls.push(`tab:${name}`);
  await Bun.sleep(400);
};
const key = (code: number, flags = 0) => ax("key", String(code), String(flags));
const fill = async (name: string, value: string) => {
  const node = await seek(`Missing field "${name}"`, (n) => ["AXTextArea", "AXTextField"].includes(n.AXRole ?? "") && names(n).some((label) => label.includes(name)));
  const role = node.AXRole!;
  const accessible = names(node).find((label) => label.includes(name)) ?? name;
  ax("focus-name", role, accessible);
  await Bun.sleep(150);
  key(0, 1048576);
  key(51);
  ax("text", value);
  await Bun.sleep(200);
  const written = find((n) => n.AXRole === role && names(n).some((label) => label.includes(name))).at(-1);
  assert(String(written?.AXValue ?? "").includes(value.slice(0, 24)), `${name} did not receive the typed value`);
  controls.push(`fill:${name}`);
};
const textOf = () => entries(inspect().web).flatMap(labels).join("\n");
const around = (label: string) => {
  const nodes = entries(inspect().web);
  const index = nodes.findIndex((node) => labels(node).some((value) => value.includes(label)));
  return nodes.slice(Math.max(0, index), index + 8).flatMap(labels).join(" ");
};

const PROJECT = "Analytics Fixture";
const TASK = "Native estimate task";
const NEXT_SCOPE = "Refactor authentication, concurrency and migrations. Add tests.";

async function checkMissionReplan() {
  const { task, mission, replacement, model, projectPath } = await seedMissionReplanFixture(api, data, home);
  const preflight = await api("POST", "/project-interviews/preflight", { harness: "codex", model: "gpt-5.6-sol", effort: "low" });
  await api("PUT", "/portfolio-manager/config", {
    config: { harness: "codex", model: "gpt-5.6-sol", effort: "low", consentKey: preflight.isolation.consentKey },
  });
  const base = `/api/orchestration/missions/${mission.id}`;
  const options = await get(`${base}/resource-options?role=reviewer&taskId=${task.id}`);
  const option = options.options.find((row: { accountId: string; modelId: string }) =>
    row.accountId === replacement.accountId && row.modelId === model);
  assert(option?.resource, "Exact registered Reviewer fixture is unavailable");
  assert.equal((await get(base)).mission.revision, 1);
  evidence.initialRevision = 1;
  await bind();
  const skip = find((n) => matching("AXButton", "Skip")(n)).at(-1);
  if (skip) activate(skip);
  await button("Open Head of PM");
  const beforeMessages = (await get("/portfolio-manager")).messages.length;
  const field = await seek("Missing Head composer", (n) => ["AXTextArea", "AXTextField"].includes(n.AXRole ?? "")
    && labels(n).some((value) => value.includes("Message to Head of PM")));
  ax("focus-name", field.AXRole!, names(field).find((value) => value.includes("Message to Head of PM"))!);
  const action = {
    kind: "replan_mission", missionId: mission.id, projectPath, taskId: task.id, role: "reviewer",
    ...option.resource, reason: "Preserve the recorded implementation.",
  };
  ax("text", `__fake_head_board__ ${JSON.stringify(action)}`);
  await Bun.sleep(300);
  await button("Send");
  const proposal = await poll("Head did not save a durable resource proposal", async () => {
    const rows = await get(`${base}/resource-proposals`);
    return rows.proposals.find((row: { headMessageId: string | null; status: string }) => row.headMessageId && row.status === "pending") ?? null;
  }, 40_000);
  assert.equal((await get("/portfolio-manager")).messages.length >= beforeMessages + 2, true);
  await show("Mission resource replanning");
  await show("reviewer-fixture-dev");
  await show(option.resource.accountId);
  mark("Packaged Head displayed the durable proposal card and preserved Developer run");
  await button("Approve exact revision");
  await button("Missions");
  const current = await poll("Owner approval did not revise the mission", async () => {
    const value = (await get(base)).mission;
    return value.revision === 2 ? value : null;
  });
  assert.equal(current.plan.tasks[0].runId, "reviewer-fixture-dev");
  assert.equal(current.plan.tasks[0].reviewerBinding.accountId, replacement.accountId);
  assert.equal(current.authorization.digest, proposal.newPlanDigest);
  await show("Mission resource replanning · #2");
  await button("Stage schedule");
  await show("Provider-reported waiting");
  using database = new Database(join(data, "agetor.sqlite"), { readonly: true });
  assert.deepEqual(database.query("SELECT id FROM runs").all(), [{ id: "reviewer-fixture-dev" }]);
  evidence.finalRevision = 2;
  verdicts.missionOwnerApproval = "PASS";
  mark("Packaged Owner approval recorded revision 2 and showed the revised stage schedule");
  await stop();
  using restoredDb = new Database(join(data, "agetor.sqlite"), { readonly: true });
  assert.equal(restoredDb.query<{ revision: number; status: string }, []>("SELECT revision, status FROM orchestration_missions").get()?.revision, 2);
  assert.equal(restoredDb.query<{ status: string }, []>("SELECT status FROM orchestration_missions").get()?.status, "paused");
  assert.deepEqual(restoredDb.query("SELECT id, status FROM runs").all(), [{ id: "reviewer-fixture-dev", status: "succeeded" }]);
  verdicts.missionRestart = "PASS";
  mark("Quit left revision 2 paused with the original Developer run and no additional launch");
}

async function checkAnalytics() {
  const accounts = seed(["accounts"]);
  evidence.accounts = accounts;
  assert(accounts.accounts.some((account: { label: string; quota: Array<{ current: { source?: string; remaining?: number; resetAt?: number | null } | null }> }) =>
    account.label === "Synthetic quota" && account.quota.some(item => item.current?.source === "synthetic-fixture" && item.current.remaining === 20 && item.current.resetAt == null)));
  assert(accounts.accounts.some((account: { label: string; quota: Array<{ provenances: string[] }> }) =>
    account.label === "Configured limit" && account.quota.some(item => item.provenances.includes("user-provided"))));
  assert(accounts.accounts.some((account: { label: string; quota: unknown[] }) => account.label === "No quota reading" && account.quota.length === 0));
  assert(accounts.localMeters.some((meter: { usedPercent: number; resetsAtMs: number | null }) => meter.usedPercent === 37 && meter.resetsAtMs == null));
  const registered = await api("POST", "/projects", { path: projectDir, name: PROJECT });
  const created = await api("POST", "/tasks", {
    title: TASK, prompt: "Add a parser. Acceptance criteria: verify it with tests.",
    workdir: registered.path, isolation: "none", agent: "codex", model: "gpt-5.6-sol", mode: "auto",
  });
  const taskId = created.id as string;
  evidence.taskId = taskId;
  assert.equal(created.column, "backlog");
  await bind();
  const skip = find((n) => matching("AXButton", "Skip")(n)).at(-1);
  if (skip) activate(skip);
  await button(PROJECT);
  await Bun.sleep(500);
  if (!find((n) => matching("AXButton", "Open board")(n)).length) {
    const card = await seek("Missing project card", (n) => n.AXRole === "AXButton" && n.AXEnabled !== false
      && names(n).some((value) => value.includes(PROJECT) && value !== PROJECT));
    activate(card, PROJECT);
    await Bun.sleep(500);
  }
  await button("Open board");
  await show("BACKLOG");
  await button("Estimate");
  await show("Revision #");
  await show("Unknown");
  await show("Compare resources");
  await show("Subscription consumption");
  const opened = await get(`/api/usage-analytics/task?taskId=${taskId}`);
  const firstId = opened.revisions.find((revision: { stale: boolean }) => !revision.stale)?.id;
  assert.equal(typeof firstId, "number");
  assert.equal(opened.actual.runs.length, 0);
  assert.equal((await get(`/tasks/${taskId}`)).column, "backlog");
  evidence.firstRevision = firstId;
  mark("Backlog estimate saved without a run");

  await fill("Scope", NEXT_SCOPE);
  await button("Save scope and regenerate");
  const revised = await poll("Scope change did not save a new revision", async () => {
    const detail = await get(`/api/usage-analytics/task?taskId=${taskId}`);
    const current = detail.revisions.find((revision: { stale: boolean }) => !revision.stale);
    return current && current.id !== firstId && detail.actual.runs.length === 0 ? detail : null;
  }, 20_000);
  const secondId = revised.revisions.find((revision: { stale: boolean }) => !revision.stale).id;
  assert(revised.revisions.some((revision: { id: number; stale: boolean }) => revision.id === firstId && revision.stale));
  await show(`Revision #${secondId}`);
  assert.equal((await get(`/tasks/${taskId}`)).column, "backlog");
  assert.equal((await get(`/tasks/${taskId}`)).prompt, NEXT_SCOPE);
  evidence.secondRevision = secondId;
  verdicts.backlogEstimate = "PASS";
  mark("Scope change created a new revision and still created no run");
  await button("Close");

  const actual = seed(["complete", taskId]);
  evidence.actual = actual;
  assert.equal(actual.estimateId, secondId);
  await button("Analytics");
  await tab("Analytics");
  await show("Tasks completed");
  await button(TASK);
  await show("Synthetic");
  await show("Frozen at first run");
  await show("Cumulative agent time");
  await show("Active wall-clock time");
  await show("Created to Done");
  await show("Elapsed first run to last Done");
  const rendered = textOf();
  assert(rendered.includes("19 sec"), "Cumulative worker duration was not shown");
  assert(rendered.includes("14 sec"), "Wall-clock or first-run duration was not shown separately from the worker sum");
  assert(around("Active wall-clock time").includes("14 sec"), around("Active wall-clock time"));
  assert(!around("Active wall-clock time").includes("19 sec"), around("Active wall-clock time"));
  assert(rendered.includes("Unknown"), "An unknown actual was not labeled Unknown");
  assert(!rendered.includes("fixture-subject"));
  await disclose("Frozen at first run");
  await show(`Revision #${secondId}`);
  verdicts.analytics = "PASS";
  mark("Completed synthetic task shows the frozen revision and separate durations");
  await button("Close");

  await tab("AI Resources");
  await show("Synthetic quota");
  await show("Synthetic");
  await show("20 requests");
  await show("Owner-configured");
  await show("Configured limit");
  await show("No quota reading");
  await show("Unknown");
  await disclose("Unbound harness observations");
  await show("37%");
  const resources = textOf();
  assert(!resources.includes("fixture-subject"));
  assert(!resources.includes("Verified provider report") || resources.includes("Synthetic"), "A synthetic quota was presented as a live provider report");
  verdicts.resources = "PASS";
  mark("AI Resources keeps synthetic, configured, local, and unknown quota distinct");

  await button("Open Head of PM");
  const beforeHead = (await get(`/api/usage-analytics/task?taskId=${taskId}`)).actual.runs.length;
  const beforeMessages = (await get("/portfolio-manager")).messages.length;
  const field = await seek("Missing Head composer", (n) => ["AXTextArea", "AXTextField"].includes(n.AXRole ?? "")
    && labels(n).some((value) => value.includes("Message to Head of PM")));
  ax("focus-name", field.AXRole!, names(field).find((value) => value.includes("Message to Head of PM"))!);
  const question = `Estimate task ${taskId}. How long will the project backlog take? How much have we spent on this project? How long did this task take to complete? Which tasks required the most rework? What is our verified remaining quota? Why did this task exceed the forecast?`;
  ax("text", question);
  key(36, 1048576);
  controls.push("Head usage question");
  const reply = await poll("Head did not answer from stored usage evidence", async () => {
    const state = await get("/portfolio-manager");
    if (state.messages.length < beforeMessages + 2 || state.activeTurn) return null;
    const message = state.messages.at(-1);
    return String(message?.text ?? "").includes("Usage evidence from stored records") ? message : null;
  }, 40_000);
  const answer = String(reply.text);
  assert(answer.includes("Usage Analytics evidence"), answer);
  assert(answer.includes(taskId), answer);
  assert(answer.includes("synthetic fixture"), answer);
  assert(!answer.includes("fixture-subject"), answer);
  assert.equal((await get(`/api/usage-analytics/task?taskId=${taskId}`)).actual.runs.length, beforeHead);
  evidence.headReply = answer.slice(0, 1500);
  verdicts.head = "PASS";
  mark("Head quoted stored usage evidence without starting a run");

  await stop();
  await boot();
  await bind();
  const restored = await get(`/api/usage-analytics/task?taskId=${taskId}`);
  assert.equal(restored.revisions.find((revision: { stale: boolean }) => !revision.stale)?.id, secondId);
  assert.equal(restored.actual.runs.length, 2);
  assert(restored.actual.runs.every((run: { execution: string }) => run.execution === "synthetic"));
  assert.equal(restored.estimate.estimateId, secondId);
  const restoredResources = await get("/api/usage-analytics/resources");
  assert(JSON.stringify(restoredResources).includes("synthetic-fixture"));
  assert(!JSON.stringify(restoredResources).includes("fixture-subject"));
  await button("Analytics");
  await tab("Analytics");
  await show(TASK);
  await button(TASK);
  await show("Synthetic");
  await show(`Revision #${secondId}`);
  verdicts.persistence = "PASS";
  mark("Quit and relaunch kept the revision, synthetic actuals, and quota fixture");
  verdicts.ownerProfile = "PASS";
}

try {
  await boot();
  mark("Packaged ForgeOrbitQA started on a disposable profile");
  await api("PUT", "/preferences/onboardingDismissed", { value: "true" }, 204);
  await api("PUT", "/preferences/locale", { value: "en" }, 204);
  await api("PATCH", "/harnesses/codex", { enabled: true });
  if (missionReplan) await checkMissionReplan();
  else await checkAnalytics();
} catch (error) {
  evidence.blocker = (error as Error).stack ?? (error as Error).message;
  console.error(error);
  if (binding) {
    try { writeFileSync(join(root, "ax-at-stop.json"), JSON.stringify(inspect(), null, 2)); } catch { /* no AX tree */ }
  }
  process.exitCode = 1;
} finally {
  try { await stop(); } catch (error) { evidence.cleanup = (error as Error).message; process.exitCode = 1; }
  const ownerAfter = Object.fromEntries(ownerPaths.map((p) => [p, stamp(p)]));
  if (!missionReplan) evidence.ownerUnchanged = JSON.stringify(ownerBefore) === JSON.stringify(ownerAfter);
  if (!missionReplan && !evidence.ownerUnchanged) {
    verdicts.ownerProfile = "FAIL";
    process.exitCode = 1;
  }
  save();
}
