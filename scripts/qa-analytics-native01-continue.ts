/**
 * FO-ANALYTICS-NATIVE01 continuation.
 * Reuses the isolated ForgeOrbitQA profile. Does not repeat the accepted
 * Backlog estimate clicks. Fake drivers only.
 *
 * bun --no-env-file scripts/qa-analytics-native01-continue.ts <root>
 */
import { assertNativeQaEnvironment, NATIVE_QA_STUB } from "../src/bun/native-qa-environment.ts";
import assert from "node:assert/strict";
import { homedir } from "node:os";
import { existsSync, realpathSync, readFileSync, writeFileSync, openSync, closeSync, statSync } from "node:fs";
import { spawn, spawnSync } from "node:child_process";
import { Database } from "bun:sqlite";
import { join, resolve } from "node:path";

const root = realpathSync(process.argv[2] ?? "");
assert.match(root, /^\/private\/tmp\/fo-analytics-native01-[A-Za-z0-9]+$/);
const evidencePath = join(root, "fo-analytics-native01-continue.json");
const repo = join(import.meta.dir, "..");
const runtime = join(root, "runtime");
const data = join(runtime, "data");
const home = join(runtime, "home");
const tmp = join(runtime, "tmp");
const app = join(root, "ForgeOrbitQA-dev.app");
const appBin = join(app, "Contents/MacOS");
assert.equal(realpathSync(app), app);
assert.equal(existsSync(data), true, "Disposable QA profile is missing");
const helper = join(root, "qa-native-pid");
const portProbe = Bun.listen({ hostname: "127.0.0.1", port: 0, socket: { data() {} } });
const apiPort = portProbe.port;
portProbe.stop(true);
const logPath = join(root, "native-continue.log");
const credFile = join(data, "agetor-core.json");

const consoleLocked = () => {
  const listed = spawnSync("/usr/sbin/ioreg", ["-n", "Root", "-d1"], { encoding: "utf8" });
  return /"IOConsoleLocked" = Yes/.test(listed.stdout ?? "");
};
if (consoleLocked()) {
  console.error("STOP: macOS console is locked. No native interaction.");
  process.exit(2);
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
const plistId = sh(["/usr/libexec/PlistBuddy", "-c", "Print :CFBundleIdentifier", join(app, "Contents/Info.plist")]);
assert.equal(plistId, "app.forgeorbit.qa");

/** The packaged QA gate rejects every stored harness env override, including
 * the synthetic CODEX_HOME paths this fixture wrote while it was running.
 * Clear only those in-root pointers so the existing app can boot. The
 * directories stay; this does not touch credentials or the owner profile. */
const releaseStoredHarnessEnv = () => {
  const db = new Database(join(data, "agetor.sqlite"));
  const cleared: { id: string; env: Record<string, string> }[] = [];
  try {
    const rows = db.query<{ id: string; env_json: string }, []>("SELECT id, env_json FROM harnesses").all();
    for (const row of rows) {
      const parsed = JSON.parse(row.env_json) as Record<string, unknown>;
      const keys = Object.keys(parsed);
      if (keys.length === 0) continue;
      if (keys.length !== 1 || keys[0] !== "CODEX_HOME" || typeof parsed.CODEX_HOME !== "string") {
        throw Error(`Refusing to clear unexpected harness env on ${row.id}`);
      }
      const target = resolve(parsed.CODEX_HOME);
      if (!target.startsWith(`${runtime}/home/`) || !existsSync(target)) {
        throw Error(`Harness ${row.id} CODEX_HOME is not an existing path inside this QA home`);
      }
      db.run("UPDATE harnesses SET env_json = ? WHERE id = ?", ["{}", row.id]);
      cleared.push({ id: row.id, env: { CODEX_HOME: target } });
    }
  } finally {
    db.close();
  }
  return cleared;
};

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
  fakeDrivers: kinds, synthetic: true, continued: true, steps, controls, verdicts,
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
      last = (error as Error).message;
      if (last.startsWith("STOP:")) throw error;
    }
    await Bun.sleep(250);
  } while (Date.now() < end);
  throw Error(`${label}${last ? `: ${last}` : ""}`);
};

let child: ReturnType<typeof launch> | undefined;
let creds: { pid: number; port: number; token: string };
const boot = async () => {
  if (consoleLocked()) throw Error("STOP: macOS console is locked. No native interaction.");
  const cleared = releaseStoredHarnessEnv();
  if (cleared.length) {
    evidence.clearedHarnessEnv = cleared;
    save();
  }
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

const seedComplete = (taskId: string) => {
  let last = "";
  for (let attempt = 0; attempt < 4; attempt++) {
    const result = spawnSync(process.execPath, ["--no-env-file", join(repo, "scripts/qa-analytics-native01-seed.ts"), "complete", taskId], {
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
  frame?: { x: number; y: number; width: number; height: number }; children?: AxNode[] };
const entries = (node: AxNode | undefined): AxNode[] => node ? [node, ...(node.children ?? []).flatMap(entries)] : [];
const labels = (node: AxNode) => [node.AXTitle, node.AXDescription, node.AXValue, node.AXHelp].filter((x): x is string => typeof x === "string");
const names = (node: AxNode) => [node.AXTitle, node.AXDescription].filter((x): x is string => typeof x === "string");
const bindingFile = join(root, "binding-continue.json");
let binding: { axTrusted: boolean; windowId: number; corePid: number } | undefined;
const ax = (...args: string[]) => sh([helper, bindingFile, ...args]);
const inspect = () => JSON.parse(ax("inspect")) as { web?: AxNode };
const bind = async () => {
  if (consoleLocked()) throw Error("STOP: macOS console is locked. No native interaction.");
  const candidate = join(root, "candidate-continue.json");
  writeFileSync(candidate, JSON.stringify({ launcherPid: child?.pid, corePid: creds.pid, artifact: app }), { mode: 0o600 });
  binding = await poll("Packaged window could not be bound", () => {
    if (consoleLocked()) throw Error("STOP: macOS console is locked. No native interaction.");
    try { return JSON.parse(sh([helper, candidate, "identify"])); }
    catch (error) {
      const message = (error as Error).message;
      if (/loginwindow/i.test(message)) throw Error(`STOP: ${message}`);
      return null;
    }
  }, 30_000);
  assert(binding.axTrusted, "macOS Accessibility is unavailable to the QA runner");
  assert.equal(binding.corePid, creds.pid);
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
const textOf = () => entries(inspect().web).flatMap(labels).join("\n");
const linesOf = () => textOf().split("\n").map((line) => line.trim()).filter(Boolean);
const afterLabel = (label: string) => {
  const all = linesOf();
  const index = all.findIndex((line) => line === label);
  return index < 0 ? "" : (all[index + 1] ?? "");
};
const choose = async (label: string, option: string) => {
  const match = (n: AxNode) => n.AXRole === "AXPopUpButton" && names(n).some((value) => value === label || value.includes(label));
  await seek(`Missing select "${label}"`, match);
  for (let i = 0; i < 6; i++) {
    const node = find(match).at(-1);
    if (String(node?.AXValue ?? "").includes(option)) { controls.push(`${label}=${option}`); return; }
    try { ax("press", "AXPopUpButton", label); } catch { try { ax("focus-name", "AXPopUpButton", label); } catch { /* popup not exposed this pass */ } }
    await Bun.sleep(400);
    try { ax("press", "AXMenuItem", option); } catch { /* option not exposed yet */ }
    await Bun.sleep(250);
  }
  const last = find(match).at(-1);
  throw Error(`${label} stayed on "${last?.AXValue ?? ""}"`);
};

const TASK_ID = "86afc6e5-8d16-4f66-bb00-ba5a6e36fc0c";
const TASK = "Native estimate task";
const NEXT_SCOPE = "Refactor authentication, concurrency and migrations. Add tests.";

try {
  await boot();
  mark("Continuation relaunched ForgeOrbitQA on the existing disposable profile");
  await api("PUT", "/preferences/onboardingDismissed", { value: "true" }, 204);
  await api("PUT", "/preferences/locale", { value: "en" }, 204);
  const task = await get(`/tasks/${TASK_ID}`);
  assert.equal(task.title, TASK);
  evidence.projectPath = task.workdir;
  let detail = await get(`/api/usage-analytics/task?taskId=${TASK_ID}`);
  const currentRevision = () => detail.revisions.find((revision: { stale: boolean }) => !revision.stale);
  if (!detail.revisions.some((revision: { stale: boolean }) => revision.stale) || !currentRevision()) {
    if (detail.actual.runs.length !== 0 || task.column !== "backlog") {
      throw Error(`Cannot reconstruct revisions on column ${task.column} with ${detail.actual.runs.length} runs`);
    }
    await api("POST", "/api/usage-analytics/forecast", { taskIds: [TASK_ID], save: true });
    await api("PATCH", `/tasks/${TASK_ID}`, { prompt: NEXT_SCOPE });
    await api("POST", "/api/usage-analytics/forecast", { taskIds: [TASK_ID], save: true });
    detail = await get(`/api/usage-analytics/task?taskId=${TASK_ID}`);
    evidence.revisionsReconstructed = true;
    mark("Reconstructed two forecast revisions through the existing save API; Backlog UI was not repeated");
  }
  const current = currentRevision();
  const superseded = detail.revisions.find((revision: { stale: boolean }) => revision.stale);
  assert.equal(typeof current?.id, "number");
  assert.equal(typeof superseded?.id, "number");
  assert.notEqual(current.id, superseded.id);
  evidence.currentRevision = current.id;
  evidence.supersededRevision = superseded.id;
  if (detail.actual.runs.length === 0) {
    const actual = seedComplete(TASK_ID);
    evidence.actual = actual;
    assert.equal(actual.workerMs, 19_000);
    assert.equal(actual.activeWallMs, 14_000);
    assert.equal(actual.estimateId, current.id);
    mark("Recorded the existing synthetic two-run fixture");
  } else {
    evidence.actual = {
      runs: detail.actual.runs.length,
      workerMs: detail.actual.workerMs,
      activeWallMs: detail.actual.activeWallMs,
      estimateId: detail.estimate?.estimateId ?? null,
    };
  }
  detail = await get(`/api/usage-analytics/task?taskId=${TASK_ID}`);
  assert.equal(detail.actual.workerMs, 19_000);
  assert.equal(detail.actual.activeWallMs, 14_000);
  assert.equal(detail.actual.runs.length, 2);
  assert.equal(detail.actual.runs.every((run: { execution: string; role: string }) => run.execution === "synthetic"), true);
  assert.equal(detail.estimate.estimateId, current.id);
  assert.equal(detail.actual.runs.filter((run: { role: string }) => run.role === "developer").length, 2);
  assert.equal(detail.actual.runs.filter((run: { role: string }) => run.role === "reviewer").length, 0);
  const resourcesBefore = JSON.stringify(await get("/api/usage-analytics/resources"));
  assert(resourcesBefore.includes("synthetic-fixture"));
  assert(!resourcesBefore.includes("fixture-subject"));
  const config = { harness: "codex", model: "gpt-5.6-sol", effort: "low" };
  const preflight = await api("POST", "/project-interviews/preflight", config);
  await api("PUT", "/portfolio-manager/config", { config: { ...config, consentKey: preflight.isolation.consentKey } });
  evidence.headDriver = "fake";

  await bind();
  mark(`Bound Accessibility to QA pid ${creds.pid}`);
  const skip = find((n) => matching("AXButton", "Skip")(n)).at(-1);
  if (skip) activate(skip, "Skip");
  await button("Analytics");
  await tab("Analytics");
  await show("Tasks completed");
  await show("Developer");
  await show("Reviewer");
  const attribution = textOf();
  evidence.attributionExcerpt = linesOf().filter((line) => /Developer|Reviewer|Synthetic|Unknown|All/.test(line)).slice(0, 40);
  assert(attribution.includes("Developer") && attribution.includes("Reviewer"), "Developer and Reviewer rows were not both on the analytics page");
  await button(TASK);
  await show("Synthetic");
  await show("Frozen at first run");
  await show("Cumulative agent time");
  await show("Active wall-clock time");
  await show("Created to Done");
  await show("Elapsed first run to last Done");
  await show("Subscription consumption");
  const activeNear = afterLabel("Active wall-clock time");
  const workerNear = afterLabel("Cumulative agent time");
  evidence.activeNear = activeNear;
  evidence.workerNear = workerNear;
  assert(workerNear.includes("19 sec"), `Cumulative worker duration was not shown separately: ${workerNear}`);
  assert(activeNear.includes("14 sec"), `Wall-clock union was not shown separately: ${activeNear}`);
  assert(!activeNear.includes("19 sec"), `Wall-clock row also showed the worker sum: ${activeNear}`);
  const rendered = textOf();
  assert(rendered.includes("Unknown"), "An unknown actual was not labeled Unknown");
  assert(rendered.includes("Developer"), "Run attribution did not show Developer");
  assert(!rendered.includes("fixture-subject"));
  await disclose("Frozen at first run");
  await show(`Revision #${current.id}`);
  await disclose("Saved estimate revisions");
  await show("Superseded");
  await show(`#${superseded.id}`);
  evidence.analyticsText = {
    activeNear, workerNear,
    hasSynthetic: rendered.includes("Synthetic"),
    hasUnknown: rendered.includes("Unknown"),
    hasDeveloper: rendered.includes("Developer"),
  };
  verdicts.analytics = "PASS";
  mark("Completed synthetic task shows the frozen revision, separate durations, Developer runs, and Unknown costs");
  await button("Close");

  const beforeHeadRuns = (await get(`/api/usage-analytics/task?taskId=${TASK_ID}`)).actual.runs.length;
  const beforeMessages = (await get("/portfolio-manager")).messages.length;
  await button("Open Head of PM");
  await choose("Context", "Analytics Fixture");
  const field = await seek("Missing Head composer", (n) => ["AXTextArea", "AXTextField"].includes(n.AXRole ?? "")
    && labels(n).some((value) => value.includes("Message to Head of PM")));
  ax("focus-name", field.AXRole!, names(field).find((value) => value.includes("Message to Head of PM"))!);
  key(0, 1048576);
  key(51);
  const question = `Estimate task ${TASK_ID}. How long will the project backlog take? How much have we spent on this project? How long did this task take to complete? Which tasks required the most rework? What is our verified remaining quota? Why did this task exceed the forecast?`;
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
  evidence.headScope = reply.headScope ?? stateScope(await get("/portfolio-manager"));
  evidence.headReply = answer.slice(0, 2500);
  assert(answer.includes("Usage Analytics evidence"), answer);
  assert(answer.includes(TASK_ID), answer);
  assert(answer.includes("synthetic fixture"), answer);
  assert(answer.includes(task.workdir), answer);
  assert(answer.includes("\"elapsedMs\":14000"), answer);
  assert(!answer.includes("fixture-subject"), answer);
  assert(!/"humanMs":0|"workerMs":0|"costDelta":0/.test(answer), answer);
  evidence.replyIncludesWorkerMs = answer.includes("19000") || answer.includes("19,000");
  const scoped = await get("/portfolio-manager");
  const owner = [...scoped.messages].reverse().find((message: { role: string }) => message.role === "owner");
  assert.equal(owner?.headScope?.scope?.kind, "project");
  assert.equal(owner?.headScope?.scope?.path, task.workdir);
  assert(!answer.includes("Project Beta") && !answer.includes("unrelated"));
  assert.equal((await get(`/api/usage-analytics/task?taskId=${TASK_ID}`)).actual.runs.length, beforeHeadRuns);
  await show("Usage evidence from stored records");
  await show("synthetic fixture");
  verdicts.head = "PASS";
  mark("Head quoted stored project-scoped usage evidence without starting a run");

  const runsBeforeQuit = (await get(`/api/usage-analytics/task?taskId=${TASK_ID}`)).actual.runs.map((run: { id: string }) => run.id);
  await stop();
  await boot();
  await bind();
  const restored = await get(`/api/usage-analytics/task?taskId=${TASK_ID}`);
  assert.equal(restored.revisions.find((revision: { stale: boolean }) => !revision.stale)?.id, current.id);
  assert(restored.revisions.some((revision: { id: number; stale: boolean }) => revision.id === superseded.id && revision.stale));
  assert.deepEqual(restored.actual.runs.map((run: { id: string }) => run.id), runsBeforeQuit);
  assert.equal(restored.actual.runs.length, 2);
  assert(restored.actual.runs.every((run: { execution: string; status: string }) => run.execution === "synthetic" && run.status !== "running"));
  assert.equal(restored.actual.workerMs, 19_000);
  assert.equal(restored.actual.activeWallMs, 14_000);
  assert.equal(restored.estimate.estimateId, current.id);
  const restoredResources = JSON.stringify(await get("/api/usage-analytics/resources"));
  assert(restoredResources.includes("synthetic-fixture"));
  assert(!restoredResources.includes("fixture-subject"));
  const running = await get("/tasks");
  const ours = (Array.isArray(running) ? running : running.tasks ?? []).find((item: { id: string }) => item.id === TASK_ID);
  assert.equal(ours?.column ?? (await get(`/tasks/${TASK_ID}`)).column, "done");
  await button("Analytics");
  await tab("Analytics");
  await show(TASK);
  await button(TASK);
  await show("Synthetic");
  await disclose("Frozen at first run");
  await show(`Revision #${current.id}`);
  await disclose("Saved estimate revisions");
  await show("Superseded");
  const againActive = afterLabel("Active wall-clock time");
  const againWorker = afterLabel("Cumulative agent time");
  assert(againWorker.includes("19 sec"), againWorker);
  assert(againActive.includes("14 sec") && !againActive.includes("19 sec"), againActive);
  evidence.persistence = { againActive, againWorker, runs: runsBeforeQuit };
  verdicts.persistence = "PASS";
  mark("Quit and relaunch kept the revisions, synthetic actuals, and the same run rows");
  verdicts.ownerProfile = "PASS";
} catch (error) {
  evidence.blocker = (error as Error).stack ?? (error as Error).message;
  console.error(error);
  if (binding) {
    try { writeFileSync(join(root, "ax-continue-stop.json"), JSON.stringify(inspect(), null, 2)); } catch { /* no AX tree */ }
  }
  process.exitCode = 1;
} finally {
  try { await stop(); } catch (error) { evidence.cleanup = (error as Error).message; process.exitCode = 1; }
  const ownerAfter = Object.fromEntries(ownerPaths.map((p) => [p, stamp(p)]));
  evidence.ownerUnchanged = JSON.stringify(ownerBefore) === JSON.stringify(ownerAfter);
  if (!evidence.ownerUnchanged) {
    verdicts.ownerProfile = "FAIL";
    process.exitCode = 1;
  }
  save();
}

function stateScope(state: { messages?: Array<{ headScope?: unknown }> }) {
  return state.messages?.at(-1)?.headScope ?? null;
}
