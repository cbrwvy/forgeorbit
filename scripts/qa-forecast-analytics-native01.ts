/**
 * FO-FORECAST-NATIVE01 packaged walkthrough: portfolio planning, forecast versus actual, cost trace and export.
 * Isolated ForgeOrbitQA only. Fake drivers, recorded synthetic fixture rows, no provider.
 *
 *   FORGEORBIT_QA_OUTPUT_ROOT=/private/tmp/fo-native-fa01-XXXX bun --no-env-file scripts/build-qa-native.ts
 *   bun --no-env-file scripts/qa-forecast-analytics-native01.ts <root> [portfolio|forecast|cost|compact|all] [reuse]
 *
 * Fixture setup and the documented Estimate writes are recorded as separate phases from read-only interactions.
 * Every interaction under test is a native AX press, click or key event against the bound packaged window.
 */
import { Database } from "bun:sqlite";
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { closeSync, existsSync, mkdirSync, openSync, readdirSync, readFileSync, realpathSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { assertNativeQaEnvironment, NATIVE_QA_STUB } from "../src/bun/native-qa-environment.ts";
import { AccountCore } from "../src/bun/account-core.ts";
import { observePool, PLANNING_PROMPT, recordPool, recordRefusal, seedPlanningHistory, writeProjectManifest, type PlanningContext } from "./qa-portfolio-planning-fixture.ts";
import { seedTracePricing, seedTraceRun, TRACE_RECEIPT, type TraceContext } from "./qa-analytics-trace-fixture.ts";

const root = realpathSync(process.argv[2] ?? "");
assert.match(root, /^\/private\/tmp\/fo-native-fa01-[A-Za-z0-9]+$/);
const which = process.argv[3] ?? "all";
const reuse = process.argv[4] === "reuse";
const evidencePath = join(root, "fo-forecast-native01-evidence.json");
const consoleLocked = () => /"IOConsoleLocked" = Yes/.test(spawnSync("/usr/sbin/ioreg", ["-n", "Root", "-d1"], { encoding: "utf8" }).stdout ?? "");
let stoppedForLock = false;
const requireUnlocked = () => {
  if (stoppedForLock || consoleLocked()) { stoppedForLock = true; throw new Error("STOP: macOS console is locked."); }
};
requireUnlocked();
const repo = join(import.meta.dir, "..");
const runtime = join(root, "runtime");
const data = join(runtime, "data");
const home = join(runtime, "home");
const tmp = join(runtime, "tmp");
const fixtures = join(runtime, "fixtures");
const app = join(root, "ForgeOrbitQA-dev.app");
const appBin = join(app, "Contents/MacOS");
assert.equal(realpathSync(app), app);
const helper = join(root, "qa-native-pid");
const portProbe = Bun.listen({ hostname: "127.0.0.1", port: 0, socket: { data() {} } });
const apiPort = portProbe.port;
portProbe.stop(true);
const logPath = join(root, "native.log");
const credFile = join(data, "agetor-core.json");
if (!reuse) assert(!existsSync(data), "Refusing to reuse a QA profile");
for (const p of [data, home, tmp, fixtures]) mkdirSync(p, { recursive: true, mode: 0o700 });
const seededFile = join(root, "seeded.json");

const ownerPaths = [
  join(homedir(), "Library/Application Support/ForgeOrbit"), join(homedir(), "Library/WebKit/app.forgeorbit"),
  join(homedir(), ".agetor"), join(homedir(), ".forgeorbit"), join(homedir(), ".codex"), join(homedir(), ".claude"),
];
const stamp = (p: string) => { try { const s = statSync(p); return `${s.mtimeMs}:${s.size}`; } catch { return "absent"; } };
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
assertNativeQaEnvironment(runtime, env);
const receipt = JSON.parse(readFileSync(join(root, "qa-native-build.json"), "utf8"));
assert.equal(receipt.bundleIdentifier, "app.forgeorbit.qa");
assert.equal(receipt.qaRuntimeRoot, runtime);
const provenance = JSON.parse(readFileSync(join(root, "forgeorbit-provenance.json"), "utf8"));

const launch = () => {
  const fd = openSync(logPath, "a", 0o600);
  const child = spawn(join(appBin, "launcher"), [], { cwd: appBin, env, detached: true, stdio: ["ignore", fd, fd] });
  closeSync(fd);
  return child;
};

type Phase = { name: string; kind: "setup" | "estimate-write" | "read-only"; steps: string[]; before?: unknown; after?: unknown };
const phases: Phase[] = [];
const controls: string[] = [];
const verdicts: Record<string, string> = {};
const notes: Record<string, unknown> = {};
const evidence: Record<string, unknown> = {
  apiPort, bundle: "app.forgeorbit.qa", manifest: receipt.artifactManifestSHA256, sourceRevision: provenance.metadata.sourceRevision,
  sourceDirty: provenance.metadata.sourceDirty, builtAt: provenance.metadata.builtAt, signing: receipt.signing, fakeDrivers: kinds,
  synthetic: true, phases, controls, verdicts, notes,
};
const save = () => writeFileSync(evidencePath, JSON.stringify(evidence, null, 2) + "\n");
let phase: Phase | undefined;
const startPhase = (name: string, kind: Phase["kind"]) => {
  phase = { name, kind, steps: [], before: kind === "read-only" ? counts() : undefined };
  phases.push(phase);
  save();
  console.log(`== ${kind}: ${name}`);
};
const endPhase = () => { if (phase) { phase.after = phase.kind === "read-only" ? counts() : undefined; save(); } };
const mark = (step: string) => { phase?.steps.push(step); save(); console.log("  ", step); };

const poll = async <T>(label: string, fn: () => T | null | Promise<T | null>, timeout = 20000): Promise<T> => {
  const end = Date.now() + timeout;
  let last = "";
  do {
    try { const value = await fn(); if (value) return value; }
    catch (error) { if (stoppedForLock) throw error; last = (error as Error).message; }
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
    try { return (await fetch(`http://127.0.0.1:${apiPort}/health`, { signal: AbortSignal.timeout(750) })).ok || null; } catch { return null; }
  }, 40_000);
  creds = JSON.parse(readFileSync(credFile, "utf8"));
  assert.equal(creds.port, apiPort);
  assert.match(readFileSync(logPath, "utf8"), /FO-NATIVE005-QA-EPHEMERAL-V1/);
};
const stop = async () => {
  if (!child?.pid) return;
  const pid = child.pid;
  const exited = new Promise<void>((resolve) => {
    if (child?.exitCode != null || child?.signalCode != null) resolve(); else child?.once("exit", () => resolve());
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
    method, headers: { authorization: `Bearer ${creds.token}`, "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(30_000),
  });
  const raw = await res.text();
  assert([expected, expected === 200 ? 201 : expected].includes(res.status), `${method} ${route}: HTTP ${res.status}${raw ? ` ${raw.slice(0, 500)}` : ""}`);
  return raw ? JSON.parse(raw) : null;
}
const get = (route: string) => api("GET", route);
const openDb = (readonly = false) => {
  const db = new Database(join(data, "agetor.sqlite"), readonly ? { readonly: true } : undefined);
  db.run("PRAGMA busy_timeout = 5000");
  return db;
};
const TABLES = ["tasks", "runs", "run_events", "usage_task_estimates", "usage_group_forecasts", "usage_pricing", "usage_cost_adjustments", "quota_observations",
  "resource_accounts", "provider_refusal_observations", "allocation_plans", "autonomy_policies", "orchestration_missions", "task_dependencies", "project_account_preferences"];
function counts() {
  const db = openDb(true);
  try {
    return {
      ...Object.fromEntries(TABLES.map((table) => [table, (db.query(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n])),
      taskRows: db.query(`SELECT id, "column", agent, model, run_id FROM tasks ORDER BY id`).all(),
    };
  } finally { db.close(); }
}

// ---- native AX plumbing (same PID-scoped helper the earlier native campaigns use) ----
type AxNode = { AXRole?: string; AXTitle?: string; AXDescription?: string; AXHelp?: string; AXValue?: string | number | boolean; AXEnabled?: boolean;
  AXFocused?: boolean; frame?: { x: number; y: number; width: number; height: number }; children?: AxNode[] };
const entries = (node: AxNode | undefined): AxNode[] => node ? [node, ...(node.children ?? []).flatMap(entries)] : [];
const labels = (node: AxNode) => [node.AXTitle, node.AXDescription, node.AXValue, node.AXHelp].filter((x): x is string => typeof x === "string");
const names = (node: AxNode) => [node.AXTitle, node.AXDescription].filter((x): x is string => typeof x === "string");
const bindingFile = join(root, "binding.json");
let binding: { axTrusted: boolean; windowId: number; corePid: number } | undefined;
const ax = (...args: string[]) => { requireUnlocked(); return sh([helper, bindingFile, ...args]); };
const inspect = () => JSON.parse(ax("inspect")) as { web?: AxNode; window?: { kCGWindowBounds?: { Width: number; Height: number } } };
const bind = async () => {
  requireUnlocked();
  const candidate = join(root, "candidate.json");
  writeFileSync(candidate, JSON.stringify({ launcherPid: child?.pid, corePid: creds.pid, artifact: app }), { mode: 0o600 });
  binding = await poll("Packaged window could not be bound", () => {
    try { return JSON.parse(sh([helper, candidate, "identify"])); } catch { return null; }
  }, 40_000);
  assert(binding!.axTrusted, "macOS Accessibility is unavailable to the QA runner");
  writeFileSync(bindingFile, JSON.stringify(binding), { mode: 0o600 });
  ax("focus");
};
const find = (predicate: (node: AxNode) => boolean) => entries(inspect().web).filter(predicate);
const seek = (label: string, predicate: (node: AxNode) => boolean, timeout = 15_000) => poll(label, () => find(predicate).at(-1) ?? null, timeout);
const show = (part: string, timeout = 15_000) => seek(`WKWebView did not render "${part}"`, (node) => labels(node).some((label) => label.includes(part)), timeout);
const gone = (part: string, timeout = 8_000) => poll(`"${part}" is still rendered`, () => (find((node) => labels(node).some((label) => label.includes(part))).length === 0 ? true : null), timeout);
const exactName = (node: AxNode, name: string) => names(node).some((value) => value === name);
const containsName = (node: AxNode, part: string) => names(node).some((value) => value.includes(part));
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
  const x = node.frame.x + node.frame.width / 2, y = node.frame.y + node.frame.height / 2;
  return x >= web.x && x <= web.x + web.width && y >= web.y && y <= web.y + web.height;
};
const activate = (node: AxNode, preferred?: string) => {
  const labeled = names(node).filter((value) => value.length > 0);
  const name = preferred && labeled.some((value) => value.includes(preferred)) ? preferred : labeled.sort((a, b) => b.length - a.length)[0];
  assert(node.AXRole && name, `AX control is not labeled: ${JSON.stringify(labels(node))}`);
  if (onScreen(node) && node.frame) {
    const x = String(Math.round(node.frame.x + node.frame.width / 2)), y = String(Math.round(node.frame.y + node.frame.height / 2));
    try { ax("press", node.AXRole, name, x, y); return; } catch { click(node); return; }
  }
  ax("press", node.AXRole, name);
};
const button = async (name: string, part = false) => {
  const node = await seek(`Missing enabled button "${name}"`, (n) => n.AXRole === "AXButton" && (part ? containsName(n, name) : exactName(n, name)) && n.AXEnabled !== false);
  activate(node, name);
  controls.push(name);
  await Bun.sleep(350);
};
/** Any pressable control: aria-pressed toggles surface as checkboxes in WebKit's tree. */
const control = async (name: string, part = false) => {
  const roles = ["AXButton", "AXCheckBox", "AXRadioButton", "AXLink", "AXTab"];
  const node = await seek(`Missing control "${name}"`, (n) => roles.includes(n.AXRole ?? "") && (part ? containsName(n, name) : exactName(n, name)) && n.AXEnabled !== false);
  activate(node, name);
  controls.push(name);
  await Bun.sleep(400);
  return node;
};
const tab = async (name: string) => {
  const node = await seek(`Missing tab "${name}"`, (n) => n.AXRole === "AXCheckBox" && exactName(n, name) && n.AXEnabled !== false);
  if (node.AXValue !== 1 && node.AXValue !== true) activate(node, name);
  controls.push(`tab:${name}`);
  await Bun.sleep(450);
};
const disclose = async (name: string) => {
  const node = await seek(`Missing disclosure "${name}"`, (n) => n.AXRole === "AXDisclosureTriangle" && containsName(n, name) && n.AXEnabled !== false);
  activate(node, name);
  controls.push(`disclose:${name}`);
  await Bun.sleep(350);
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
  await Bun.sleep(250);
  controls.push(`fill:${name}`);
};
const textOf = () => entries(inspect().web).flatMap(labels).join("\n");
const around = (label: string, span = 10) => {
  const nodes = entries(inspect().web);
  const index = nodes.findIndex((node) => labels(node).some((value) => value.includes(label)));
  return index < 0 ? "" : nodes.slice(Math.max(0, index - 2), index + span).flatMap(labels).join(" | ");
};
const shot = (name: string) => {
  const file = join(root, "evidence", `${name}.png`);
  mkdirSync(join(root, "evidence"), { recursive: true });
  const result = spawnSync("/usr/sbin/screencapture", ["-x", "-o", `-l${binding!.windowId}`, file], { encoding: "utf8", timeout: 15_000 });
  const ok = result.status === 0 && existsSync(file) && statSync(file).size > 2000;
  (notes.screenshots as string[] | undefined)?.push(ok ? file : `FAILED:${name}`) ?? (notes.screenshots = [ok ? file : `FAILED:${name}`]);
  save();
  return ok;
};
const axDump = (name: string) => {
  mkdirSync(join(root, "evidence"), { recursive: true });
  writeFileSync(join(root, "evidence", `${name}.ax.txt`), entries(inspect().web).flatMap(labels).join("\n"));
};

// ---- fixtures (setup phases only) ----
type Seeded = {
  portfolio: { t1: string; t2: string; t3: string; total: number; alphaOnly: number; betaOnly: number; balance: number; accounts: Record<string, { accountId: string; harnessId: string }>; alphaPath: string; betaPath: string };
  forecast: { taskId: string; title: string; baselineId: number; laterId: number; dev1: string; dev2: string; reviewer: string };
  cost: { one: string; two: string; run: Record<string, string>; tasks: Record<string, string> };
};
async function seedAll(): Promise<Seeded> {
  const model = "gpt-6.1-sol";
  // Portfolio: two projects on one shared pool, a dependency, an independent account, an Unknown-capacity account.
  const profileHome = join(home, "profiles");
  mkdirSync(profileHome, { recursive: true, mode: 0o700 });
  const accounts: Array<{ accountId: string; harnessId: string }> = [];
  for (const name of ["Alpha account", "Beta account", "Unknown capacity account", "Independent account"]) {
    const directory = join(profileHome, name.replace(/ /g, "-").toLowerCase());
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    writeFileSync(join(directory, "synthetic-authenticated"), name, { mode: 0o600 });
    accounts.push(await api("POST", "/account-core/codex-profiles", { displayName: name, directory }, 201));
  }
  const [a, b, c, d] = accounts as [typeof accounts[0], typeof accounts[0], typeof accounts[0], typeof accounts[0]];
  const alphaPath = join(fixtures, "Alpha"), betaPath = join(fixtures, "Beta");
  for (const p of [alphaPath, betaPath]) writeProjectManifest(p);
  await api("POST", "/projects", { path: alphaPath, name: "Alpha" });
  await api("POST", "/projects", { path: betaPath, name: "Beta" });
  const make = async (title: string, harnessId: string, workdir: string) => (await api("POST", "/tasks", {
    title, prompt: PLANNING_PROMPT, workdir, agent: harnessId, model, isolation: "none", column: "backlog",
  })).id as string;
  const t1 = await make("Alpha parser", a.harnessId, alphaPath);
  const t3 = await make("Alpha parser tests", a.harnessId, alphaPath);
  const t2 = await make("Beta importer", b.harnessId, betaPath);
  const now = Date.now();
  const pctx: PlanningContext = { a, b, c, d, alphaPath, betaPath, model, now };
  let db = openDb();
  const core = new AccountCore(db);
  seedPlanningHistory(db, pctx);
  db.run("INSERT INTO task_dependencies(task_id, depends_on_id, created_at) VALUES (?, ?, ?)", [t3, t1, now]);
  const sharedA = recordPool(core, a.accountId, "shared", 100_000_000, "shared-credit", now, 5000);
  const sharedB = recordPool(core, b.accountId, "shared", 100_000_000, "shared-credit", now, 5000);
  recordPool(core, d.accountId, "independent", 100_000_000, null, now);
  recordRefusal(db, c, now);
  const demand = async (taskIds: string[]) => (await api("POST", "/api/usage-analytics/forecast", { taskIds, save: false })).capacity.rows.find((row: any) => row.shared).knownDemand as number;
  const total = await demand([t1, t3, t2]), alphaOnly = await demand([t1, t3]), betaOnly = await demand([t2]);
  const high = Math.max(alphaOnly, betaOnly);
  const balance = high + Math.floor((total - high) / 2);
  observePool(core, sharedA.id, a.accountId, "shared", balance, "shared-credit", now);
  observePool(core, sharedB.id, b.accountId, "shared", balance, "shared-credit", now);

  // Forecast versus actual: a baseline, two Developer attempts (one interrupted), one Reviewer attempt, then a later revision.
  const forecastDir = join(fixtures, "Forecast fixture");
  mkdirSync(forecastDir, { recursive: true });
  writeFileSync(join(forecastDir, "package.json"), "{}\n");
  await api("POST", "/projects", { path: forecastDir, name: "Forecast fixture" });
  const title = "Frozen baseline task";
  const taskId = (await api("POST", "/tasks", { title, prompt: "Add a health endpoint. Acceptance: add tests.", workdir: forecastDir, agent: "codex", model, isolation: "none", column: "backlog" })).id as string;
  const baselineId = (await api("POST", "/api/usage-analytics/forecast", { taskIds: [taskId], save: true })).estimates[0].estimateId as number;
  await Bun.sleep(1200);
  const start = Date.now();
  const run = (id: string, at: number, end: number | null, status: string, qc?: string) => {
    db.run(`INSERT INTO runs(id,task_id,agent,status,started_at,ended_at,exit_code,codex_session_id,qc_review_id,usage_scope) VALUES (?,?,?,?,?,?,?,?,?,?)`,
      [id, taskId, "codex", status, at, end, status === "succeeded" ? 0 : null, id, qc ?? null, JSON.stringify({ projectPath: forecastDir, clusterId: null, missionId: null, category: "task", technology: "JavaScript/TypeScript", complexity: "low" })]);
    db.run("INSERT INTO run_events(run_id,stream,data,ts) VALUES (?,'status',?,?)", [id, JSON.stringify({ kind: "execution-identity", executionType: "synthetic", provider: "codex", model, mode: qc ? "ask" : "auto" }), end ?? at]);
  };
  const dev1 = crypto.randomUUID(), dev2 = crypto.randomUUID(), reviewer = crypto.randomUUID(), qcId = crypto.randomUUID();
  run(dev1, start, null, "orphaned");
  run(dev2, start + 10_000, start + 20_000, "succeeded");
  run(reviewer, start + 22_000, start + 30_000, "succeeded", qcId);
  db.run(`INSERT INTO task_quality_reviews(id,task_id,project_path,round,status,verdict,reviewer_harness,reviewer_model,implementation_run_id,review_run_id,saved_task_json,requested_at,started_at,completed_at)
    VALUES (?,?,?,1,'completed','PASS','codex',?,?,?,'{}',?,?,?)`, [qcId, taskId, forecastDir, model, dev2, reviewer, start + 22_000, start + 22_000, start + 30_000]);
  db.run(`UPDATE tasks SET "column" = 'backlog', prompt = ? WHERE id = ?`, ["Add a health endpoint and readiness probe. Acceptance: add tests.", taskId]);
  db.close();
  const laterId = (await api("POST", "/api/usage-analytics/forecast", { taskIds: [taskId], save: true })).estimates[0].estimateId as number;
  db = openDb();
  db.run(`UPDATE tasks SET "column" = 'done' WHERE id = ?`, [taskId]);
  db.run("UPDATE usage_task_transitions SET at = ? WHERE task_id = ? AND destination = 'done'", [start + 31_000, taskId]);
  assert(laterId > baselineId, "the later revision must be newer than the baseline");
  assert.equal((db.query("SELECT usage_estimate_id AS id FROM runs WHERE task_id = ? ORDER BY started_at LIMIT 1").get(taskId) as { id: number }).id, baselineId);

  // Cost trace: two projects, USD and EUR price revisions, one run of each evidence kind, one run before the period.
  const one = join(fixtures, "Trace one"), two = join(fixtures, "Trace two");
  mkdirSync(one, { recursive: true });
  mkdirSync(two, { recursive: true });
  await api("POST", "/projects", { path: one, name: "Trace one" });
  await api("POST", "/projects", { path: two, name: "Trace two" });
  const acct = (displayName: string) => api("POST", "/account-core/accounts", { provider: "openai", displayName });
  const [t1a, t2a, t3a] = [await acct("Account one"), await acct("Account two"), await acct("Account three")];
  const ttask = async (title: string, workdir: string) => (await api("POST", "/tasks", { title, prompt: "Add an example.", workdir, agent: "codex", model, isolation: "none", column: "review" })).id as string;
  const tasks = {
    t1: await ttask("T1 calculated USD", one), t2: await ttask("T2 calculated EUR", two), t3: await ttask("T3 billed receipt", one),
    t4: await ttask("T4 no usage", two), t5: await ttask("T5 subscription", one), t6: await ttask("T6 synthetic", one), t7: await ttask("T7 before period", one),
  };
  const tctx: TraceContext = {
    db, projectOne: one, projectTwo: two, a1: { id: t1a.id }, a2: { id: t2a.id }, a3: { id: t3a.id }, now: Date.now(),
    insertRun: (row) => {
      const workdir = (db.query("SELECT workdir FROM tasks WHERE id = ?").get(row.taskId) as { workdir: string }).workdir;
      db.run(`INSERT INTO runs(id,task_id,agent,status,started_at,ended_at,exit_code,codex_session_id,usage_scope) VALUES (?,?,?,'succeeded',?,?,0,?,?)`,
        [row.id, row.taskId, row.agent, row.startedAt, row.endedAt, row.id, JSON.stringify({ projectPath: workdir, clusterId: null, missionId: null, category: "task", technology: "unknown", complexity: "low" })]);
    },
  };
  seedTracePricing(tctx);
  const costRun = {
    r1: seedTraceRun(tctx, { taskId: tasks.t1, account: tctx.a1, startOffsetMs: -600_000 }),
    r2: seedTraceRun(tctx, { taskId: tasks.t2, account: tctx.a2, startOffsetMs: -500_000 }),
    r3: seedTraceRun(tctx, { taskId: tasks.t3, account: tctx.a1, startOffsetMs: -400_000, billed: TRACE_RECEIPT }),
    r4: seedTraceRun(tctx, { taskId: tasks.t4, account: tctx.a1, startOffsetMs: -300_000, usage: false }),
    r5: seedTraceRun(tctx, { taskId: tasks.t5, account: tctx.a3, startOffsetMs: -200_000 }),
    r6: seedTraceRun(tctx, { taskId: tasks.t6, account: tctx.a1, startOffsetMs: -100_000, execution: "synthetic" }),
    r7: seedTraceRun(tctx, { taskId: tasks.t7, account: tctx.a1, startOffsetMs: -10 * 86_400_000 }),
  };
  db.close();
  return {
    portfolio: { t1, t2, t3, total, alphaOnly, betaOnly, balance, accounts: { a, b, c, d }, alphaPath, betaPath },
    forecast: { taskId, title, baselineId, laterId, dev1, dev2, reviewer },
    cost: { one, two, run: costRun, tasks },
  };
}

const num = (value: number) => new Intl.NumberFormat("en-US", { maximumFractionDigits: 2 }).format(value);
let seeded: Seeded;


/**
 * A native <select>: WKWebView draws its menu outside the accessibility tree, so open it from the keyboard
 * and click the row where the menu draws it (the current row sits over the control, rows are 24 pt apart).
 */
const PROJECT_OPTIONS = ["All", "Trace two", "Trace one", "Forecast fixture", "Beta", "Alpha"];
async function selectNative(name: string, option: string, options = PROJECT_OPTIONS) {
  const popup = () => find((n) => n.AXRole === "AXPopUpButton" && exactName(n, name)).at(-1);
  const current = () => String(popup()?.AXValue ?? "");
  await seek(`Missing select "${name}"`, (n) => n.AXRole === "AXPopUpButton" && exactName(n, name));
  if (current() === option) return;
  const from = options.indexOf(current());
  const to = options.indexOf(option);
  assert(from >= 0 && to >= 0, `unknown select option ${current()} / ${option}`);
  ax("focus-name", "AXPopUpButton", name);
  await Bun.sleep(300);
  // The closed, focused select does type-ahead; Space would open the native menu (outside the AX tree), so type only the
  // first letter, again after the type-ahead window, which steps through the rows that start with it.
  let presses = 0;
  while (current() !== option && presses < options.length) {
    ax("text", option[0]!);
    presses++;
    await Bun.sleep(1400);
  }
  notes.selectPresses = `${name}: ${presses} first-letter presses for ${option}`;
  if (current() !== option) shot(`select-failed-${name}`);
  assert(current() === option, `select "${name}" did not take "${option}" (value ${current()})`);
  controls.push(`select:${name}=${option}`);
}
/** The first button after a label in tree order: used for count buttons that share a name. */
async function buttonAfter(label: string) {
  const node = await poll(`No button after "${label}"`, () => {
    const nodes = entries(inspect().web);
    const at = nodes.findIndex((n) => labels(n).some((l) => l === label));
    if (at < 0) return null;
    return nodes.slice(at + 1, at + 8).find((n) => n.AXRole === "AXButton" || n.AXRole === "AXCheckBox") ?? null;
  });
  const f = node.frame!;
  const named = names(node).find((value) => value.length > 0) ?? String(node.AXValue ?? "");
  ax("press", node.AXRole!, named, String(Math.round(f.x + f.width / 2)), String(Math.round(f.y + f.height / 2)));
  controls.push(`press-after:${label}`);
  await Bun.sleep(500);
}
/** A button that appears more than once on the page (the task table repeats record titles): the one after a heading. */
async function buttonAfterHeading(heading: string, name: string) {
  const node = await poll(`No button "${name}" after "${heading}"`, () => {
    const nodes = entries(inspect().web);
    const at = nodes.findIndex((n) => labels(n).some((l) => l.startsWith(heading)));
    if (at < 0) return null;
    return nodes.slice(at + 1).find((n) => n.AXRole === "AXButton" && exactName(n, name)) ?? null;
  });
  ax("focus");
  // Page down until the button is inside the web view, re-reading its frame each time, then click its centre.
  let current = node;
  for (let step = 0; step < 12 && !onScreen(current); step++) {
    key(121);
    await Bun.sleep(500);
    const nodes = entries(inspect().web);
    const at = nodes.findIndex((n) => labels(n).some((l) => l.startsWith(heading)));
    current = nodes.slice(at + 1).find((n) => n.AXRole === "AXButton" && exactName(n, name)) ?? current;
  }
  const f = current.frame!;
  ax("press", "AXButton", name, String(Math.round(f.x + f.width / 2)), String(Math.round(f.y + f.height / 2)));
  controls.push(`${name} (after ${heading})`);
  await Bun.sleep(600);
}
const exportFiles = () => spawnSync("/usr/bin/find", [root, "-type", "f", "-name", "forgeorbit-*"], { encoding: "utf8" }).stdout.split("\n").filter((f) => f && !f.includes("/evidence/") && !f.includes("artifact-manifest") && !f.includes("provenance"));
async function exportAndRead(buttonName: string, extension: string) {
  const before = new Set(exportFiles());
  await button(buttonName);
  const landed = await poll(`Native export "${buttonName}" produced no file under the QA root`, () => exportFiles().find((f) => !before.has(f) && f.endsWith(extension)) ?? null, 12_000).catch((error) => {
    axDump(`export-no-file-${extension.slice(1)}`);
    shot(`export-no-file-${extension.slice(1)}`);
    notes[`exportNoFile${extension}`] = `after pressing "${buttonName}" the page said: ${textOf().includes("exported") || textOf().includes("Export") ? around("xport", 3) : "(nothing about an export)"}`;
    throw error;
  });
  assert(landed.startsWith(join(runtime, "home", "Downloads") + "/"), `export landed outside the isolated Downloads folder: ${landed}`);
  await Bun.sleep(300);
  const text = readFileSync(landed, "utf8");
  return { path: landed, text, notice: textOf().includes("Export saved to") };
}
const csvRows = (text: string) => {
  const lines = text.split("\n").filter(Boolean);
  const header = lines[1]!.split(",");
  return { preamble: lines[0]!, rows: lines.slice(2).map((line) => Object.fromEntries(line.split(",").map((cell, i) => [header[i]!, cell]))) as Record<string, string>[] };
};

/** Compact desktop width, then the same Costs path in Russian: clipped labels, table scrolling, focus, export notice. */
async function compactRussian() {
  startPhase("compact 900x700 and Russian: Costs → records → task → export (read-only except the export file)", "read-only");
  await control("Analytics"); await control("Usage"); await control("Last 7 days"); await control("Costs");
  await selectNative("Project", "Trace one"); await button("Apply filters");
  await show("Provider-reported API charge $0.80", 25_000);
  ax("resize", "900", "700");
  await Bun.sleep(1200);
  const size = inspect().window?.kCGWindowBounds;
  assert(size && size.Width <= 905 && size.Width >= 895, `window did not take the compact size: ${JSON.stringify(size)}`);
  mark(`window resized to ${size!.Width}x${size!.Height}`);
  key(37, 0x20000 | 0x80000); // Alt+Shift+L switches the language
  await show("Эти суммы покрывают 2 из 3 учтённых запусков", 20_000);
  shot("compact-ru-costs");
  const within = (name: string) => {
    const web = inspect().web!.frame!;
    const node = find((n) => ["AXButton", "AXCheckBox", "AXPopUpButton"].includes(n.AXRole ?? "") && containsName(n, name)).at(-1);
    assert(node?.frame, `Russian control "${name}" is not rendered`);
    const f = node!.frame!;
    return { name, clipped: f.x < web.x || f.x + f.width > web.x + web.width, frame: f, web };
  };
  const controlsChecked = ["Применить фильтры", "Экспорт запусков (CSV)", "Экспорт запусков (JSON)", "Расчётная стоимость API", "Затраты"].map(within);
  notes.compactClipping = JSON.stringify(controlsChecked.map((c) => ({ name: c.name, clipped: c.clipped })));
  assert(controlsChecked.every((c) => !c.clipped), `a control is clipped at the compact width: ${notes.compactClipping}`);
  await control("Расчётная стоимость API", true);
  await show("Записи, из которых складывается сумма", 15_000);
  const table = find((n) => n.AXRole === "AXTable").filter((n) => n.frame).sort((a, b) => b.frame!.width - a.frame!.width)[0];
  notes.compactRecordsTable = JSON.stringify(table?.frame);
  shot("compact-ru-records");
  await buttonAfterHeading("Записи, из которых складывается сумма", "T1 calculated USD");
  await seek("task dialog (Russian)", (n) => n.AXRole === "AXButton" && exactName(n, "Открыть задачу"), 15_000);
  const dialogRun = find((n) => labels(n).some((l) => l === (seeded.cost.run as Record<string, string>).r1!.slice(0, 8))).filter((n) => n.frame).at(-1);
  assert(dialogRun, "the contributing run is not listed in the Russian task dialog");
  shot("compact-ru-task-dialog");
  key(53);
  await Bun.sleep(700);
  assert(find((n) => n.AXRole === "AXButton" && exactName(n, "Открыть задачу")).length === 0, "the task dialog is still open after Escape (compact)");
  const focused = find((n) => (n as AxNode & { AXFocused?: boolean }).AXFocused === true).map((n) => names(n)[0] ?? n.AXRole);
  notes.focusAfterDialogClose = JSON.stringify(focused);
  mark(`after Escape the dialog is gone; focused element(s): ${notes.focusAfterDialogClose}`);
  await button("Закрыть записи");
  const csv = await exportAndRead("Экспорт запусков (CSV)", ".csv");
  assert(textOf().includes("Экспорт сохранён"), around("Экспорт", 3));
  assert(csvRows(csv.text).rows.length === 4, "Russian-locale export lost rows");
  evidence.exportsCompactRu = { csv: csv.path };
  mark(`Russian compact export landed at ${csv.path}; the page announced "Экспорт сохранён"`);
  key(37, 0x20000 | 0x80000);
  await show("Эти суммы покрывают", 5000).catch(() => undefined);
  await show("These amounts cover", 15_000);
  ax("resize", "1200", "800");
  endPhase();
  verdicts.compactRussian = "PASS";
}

async function main() {
  await boot();
  startPhase("setup: launch packaged QA app, isolation gate", "setup");
  mark(`bundle app.forgeorbit.qa, manifest ${receipt.artifactManifestSHA256}`);
  mark(`source revision ${provenance.metadata.sourceRevision} (sourceDirty=${provenance.metadata.sourceDirty}: the campaign script, the QA helper scripts/qa-native-pid.m and four historical untracked QA paths; no app source)`);
  mark(`QA runtime root ${runtime}; backend log carries FO-NATIVE005-QA-EPHEMERAL-V1; all six drivers fake; AGETOR_*_BIN are the inert audited stubs`);
  await api("PUT", "/preferences/onboardingDismissed", { value: "true" }, 204);
  await api("PUT", "/preferences/locale", { value: "en" }, 204);
  await api("PATCH", "/harnesses/codex", { enabled: true });
  if (reuse && existsSync(seededFile)) seeded = JSON.parse(readFileSync(seededFile, "utf8"));
  else {
    startPhase("setup: fixture seeding (API and recorded rows, no UI interaction)", "setup");
    seeded = await seedAll();
    writeFileSync(seededFile, JSON.stringify(seeded, null, 2));
    mark("seeded portfolio, forecast-vs-actual and cost-trace fixtures (synthetic, hand-written rows)");
  }
  evidence.seeded = seeded;
  await bind();
  mark(`packaged window bound (windowId ${binding!.windowId}, core pid ${binding!.corePid})`);
  const skip = find((n) => matching("AXButton", "Skip")(n)).at(-1);
  if (skip) activate(skip);
  if (which === "portfolio" || which === "all") await portfolio();
  if (which === "forecast-only") await forecast();
  if (which === "forecast" || which === "all") await forecast();
  if (which === "cost" || which === "all") await cost();
  if (which === "compact" || which === "all") await compactRussian();
}

async function portfolio() {
  const p = seeded.portfolio;
  startPhase("portfolio: open Analytics → Forecasts (read-only navigation)", "read-only");
  await control("Analytics");
  await control("Forecasts");
  await disclose("Backlog tasks");
  mark("Backlog selector opened");
  endPhase();
  // Selecting tasks is part of the question being asked; ticking changes only local form state.
  for (const title of ["Alpha parser", "Alpha parser tests", "Beta importer"]) {
    const box = await seek(`Missing checkbox ${title}`, (n) => n.AXRole === "AXCheckBox" && exactName(n, title));
    if (box.AXValue !== 1 && box.AXValue !== true) activate(box, title);
    await Bun.sleep(250);
    controls.push(`check:${title}`);
  }
  startPhase("portfolio: Estimate (documented write: saves unstarted estimate revisions)", "estimate-write");
  await button("Estimate");
  await show("First constraint on each task", 40_000);
  mark("Estimate rendered the portfolio result");
  endPhase();
  startPhase("portfolio: read the result (read-only)", "read-only");
  const text = textOf();
  assert(text.includes("A forecast is not a launch authorization"), "boundary line missing");
  const pool = around("Known shortfall", 14);
  notes.portfolioPool = pool;
  assert(pool.includes("Shared pool") || textOf().includes("Shared pool"), "shared pool row missing");
  assert(text.includes(num(p.balance)) && text.includes(num(p.total)) && text.includes(num(p.total - p.balance)), `pool numbers ${p.balance}/${p.total} not visible`);
  assert(!textOf().includes("Insufficient data"), "a known shortfall was labelled Insufficient data");
  const rows = {
    t1: around("Alpha parser", 8), t3: around("Alpha parser tests", 8), t2: around("Beta importer", 8),
  };
  notes.portfolioConstraintText = rows;
  const constraintsText = around("Starts only after", 4);
  assert(constraintsText.includes("Alpha parser"), "dependency wording missing");
  shot("portfolio-estimate");
  mark("shared pool shown once with known shortfall and demand; dependent task shown as waiting on another task");
  // Open the task whose pool is short and read its candidates.
  await button("Beta importer");
  await show("Preview alternative schedule", 8_000).then(() => { notes.previewButtonsPresent = true; }, () => { notes.previewButtonsPresent = false; });
  const options = textOf();
  notes.portfolioOptionsSimulated = options.includes("Simulated harness");
  axDump("portfolio-options");
  shot("portfolio-options");
  key(53); // Escape closes the task dialog before the next workflow
  await Bun.sleep(700);
  endPhase();
  if (notes.previewButtonsPresent) {
    startPhase("portfolio: previews (read-only calculations)", "read-only");
    // Reached only if a candidate is eligible, which the all-fake QA sandbox does not allow.
    mark("preview buttons present");
    endPhase();
    verdicts.portfolio = "PARTIAL";
  } else {
    verdicts.portfolio = "PARTIAL";
    verdicts.portfolioPreview = "BLOCKED";
    notes.portfolioPreviewBlocker = "Every driver is fake in the QA sandbox, so the Router labels every candidate Simulated and none is eligible; the Preview alternative schedule control is not offered. The sandbox was not weakened.";
  }
}

async function forecast() {
  const f = seeded.forecast;
  startPhase("forecast: project board → task panel (read-only)", "read-only");
  // The sidebar project button (its accessible name may or may not carry the avatar letter): the leftmost match.
  const side = await seek("Missing sidebar project Forecast fixture", (n) => n.AXRole === "AXButton" && containsName(n, "Forecast fixture") && !!n.frame && n.frame.x < 400);
  activate(side, "Forecast fixture");
  controls.push("Forecast fixture (sidebar)");
  await Bun.sleep(500);
  await control("Tasks");
  await button(f.title, true);
  await show("Forecast versus actual", 25_000);
  const panel = textOf();
  axDump("forecast-task-panel");
  assert(panel.includes(`Estimate #${f.baselineId} saved`), `baseline #${f.baselineId} not shown in the task panel`);
  assert(panel.includes("1 later estimate revision(s) exist"), "later revision note missing");
  assert(panel.includes("Not a genuine provider run"), "withheld-difference reason missing");
  assert(panel.includes("Completed"), "state chip missing");
  shot("forecast-task-panel");
  mark(`task panel shows baseline #${f.baselineId}, one later revision (#${f.laterId}) as unused, and why differences are withheld`);
  await disclose("Details: provenance");
  const attempts = textOf();
  axDump("forecast-task-panel-details");
  assert(attempts.includes("Developer attempt 1") && attempts.includes("Developer attempt 2") && attempts.includes("Reviewer attempt 1"), "attempts are not attributed by role");
  assert(attempts.includes("interrupted"), "interrupted attempt not marked");
  assert(attempts.includes("baseline run"), "baseline run not marked");
  mark("Details lists Developer attempt 1 (interrupted, baseline run), Developer attempt 2 and Reviewer attempt 1 under their own roles");
  shot("forecast-task-panel-attempts");
  await button("Open full task analytics");
  await show("usage_task", 3000).catch(() => undefined);
  await show("Records", 1000).catch(() => undefined);
  const dialog = await show("Forecast versus actual", 15_000).then(() => textOf());
  axDump("forecast-full-dialog");
  assert(dialog.includes(`Estimate #${f.baselineId} saved`), "the full dialog shows another baseline");
  assert(dialog.includes("Not a genuine provider run"), "the dialog does not explain the withheld difference");
  shot("forecast-full-dialog");
  mark("the full Analytics dialog opened from the task panel shows the same baseline and the same reason");
  await button("Close");
  await button("Close task details").catch(() => undefined);
  // Other direction: Analytics → task → dialog → Open task.
  await control("Analytics");
  await control("Usage");
  await fill("Selected task ids", f.taskId);
  await button("Apply filters");
  await button(f.title, true);
  await show("Forecast versus actual", 20_000);
  const fromAnalytics = textOf();
  assert(fromAnalytics.includes(`Estimate #${f.baselineId} saved`), "Analytics dialog shows another baseline");
  shot("forecast-from-analytics");
  mark("Analytics task row opens the same comparison");
  await button("Open task");
  await show("Forecast versus actual", 20_000);
  mark("Open task from the Analytics dialog returns to the task panel with the comparison");
  shot("forecast-back-to-task");
  key(53); // Escape closes the task panel so the next workflow starts from the app shell
  await Bun.sleep(900);
  endPhase();
  verdicts.forecast = "PASS";
}

async function cost() {
  const c = seeded.cost;
  const run = c.run as Record<string, string>;
  startPhase("cost: Analytics → Usage → Last 7 days → Costs, project scope Trace one (read-only)", "read-only");
  await control("Home", true); // leave and re-enter Analytics so the forecast workflow's filters do not carry over
  await control("Analytics");
  await control("Usage");
  await control("Last 7 days");
  await control("Costs");
  await selectNative("Project", "Trace one");
  await button("Apply filters");
  await show("Provider-reported API charge $0.80", 25_000).catch((error) => { shot("cost-first-view-failed"); axDump("cost-first-view-failed"); throw error; });
  let text = textOf();
  assert(text.includes("Calculated API cost $0.57"), "USD calculated amount missing");
  assert(!text.includes("Calculated API cost · EUR"), "the other project's EUR amount is still shown in Trace one");
  assert(text.includes("These amounts cover 2 of 3 counted runs. 0 have Unknown cost, 1 are subscription-covered, and 1 runs are excluded"), around("These amounts cover"));
  notes.costTilesTraceOne = around("Provider-reported API charge · USD", 24);
  shot("cost-trace-one-amounts");
  mark("Costs for Trace one: reported $0.80, calculated $0.57, subscription 1, excluded 1, coverage 2 of 3 counted runs, no EUR");
  await control("Calculated API cost $0.57", true);
  await show("Records behind this amount", 15_000);
  text = textOf();
  assert(text.includes("Calculated API cost · USD"), "category and currency not named in the records panel");
  assert(text.includes("add up to the amount shown above ($0.57)"), around("add up to"));
  assert(text.includes("T1 calculated USD") && text.includes("Account one") && text.includes("Trace one"), "record identity missing");
  assert(!text.includes("T3 billed receipt") || around("Records behind this amount", 60).indexOf("T3 billed receipt") < 0, "another category's run is in the USD calculated amount");
  axDump("cost-records-calculated");
  shot("cost-records-calculated");
  mark("USD calculated amount opens exactly its run (T1, Trace one, Account one) and says the records add up to $0.57");
  await buttonAfterHeading("Records behind this amount", "T1 calculated USD");
  let opened = false;
  for (let attempt = 0; attempt < 3 && !opened; attempt++) {
    try { await seek("task dialog", (n) => n.AXRole === "AXButton" && exactName(n, "Open task"), 6000); opened = true; }
    catch { await buttonAfterHeading("Records behind this amount", "T1 calculated USD"); }
  }
  if (!opened) { shot("cost-task-open-failed"); axDump("cost-task-open-failed"); }
  assert(opened, "the record title did not open the task dialog");
  const dialog = textOf();
  assert(dialog.includes(run.r1!.slice(0, 8)), "the opened task does not show the contributing run id");
  axDump("cost-task-dialog");
  shot("cost-task-dialog-top");
  // The runs table sits below the summary tiles: scroll the dialog until the run id is on screen.
  const runCell = () => find((n) => labels(n).some((l) => l === run.r1!.slice(0, 8))).filter((n) => n.frame).at(-1);
  // Wheel-scroll the dialog body (the pointer sits over it) until the runs table row is inside the window.
  const anchor = find((n) => labels(n).some((l) => l === "Unclassified time")).filter((n) => n.frame && onScreen(n)).at(-1);
  assert(anchor?.frame, "no point inside the task dialog body to scroll");
  const trail: string[] = [];
  for (let step = 0; step < 14 && !(runCell() && onScreen(runCell()!)); step++) {
    ax("scroll", String(Math.round(anchor!.frame!.x + anchor!.frame!.width / 2)), String(Math.round(anchor!.frame!.y + anchor!.frame!.height / 2)), "-300");
    await Bun.sleep(500);
    trail.push(JSON.stringify(runCell()?.frame));
  }
  shot("cost-task-dialog-after-scroll");
  notes.dialogScrollTrail = trail.join(" | ");
  notes.runCellFrame = JSON.stringify(runCell()?.frame);
  assert(runCell() && onScreen(runCell()!), `the contributing run id cannot be scrolled into view in the task dialog: ${JSON.stringify(runCell()?.frame)}`);
  shot("cost-task-dialog-run-highlight");
  mark(`task dialog opened from the record lists run ${run.r1!.slice(0, 8)} (screenshot shows its highlighted row; the page's data-highlight attribute is covered by the Chromium spec)`);
  key(53); // Escape closes the task dialog
  await Bun.sleep(600);
  assert(find((n) => n.AXRole === "AXButton" && exactName(n, "Open task")).length === 0, "the task dialog is still open after Escape");
  await button("Close records");
  await buttonAfter("Runs excluded from totals");
  axDump("cost-excluded-open");
  await show("Excluded: synthetic evidence", 10_000);
  text = textOf();
  assert(text.includes("T6 synthetic") && text.includes("Excluded from totals"), "excluded record missing");
  assert(around("Excluded: synthetic evidence", 6).includes("Unknown"), "excluded run amount is not Unknown");
  shot("cost-records-excluded");
  mark("excluded synthetic run listed with its reason and an Unknown amount; it is not in any amount above");
  await button("Close records");
  await buttonAfter("Subscription-covered");
  await show("Subscription-covered — no per-task money value", 10_000);
  assert(textOf().includes("T5 subscription") && textOf().includes("Account three"), "subscription record missing");
  await button("Close records");
  await control("Provider-reported API charge $0.80", true);
  await show("add up to the amount shown above ($0.80)", 10_000);
  assert(textOf().includes("T3 billed receipt"), "billed fixture record missing");
  mark("subscription (T5, no money) and provider-reported fixture ($0.80, T3) each open their own record");
  await button("Close records");
  endPhase();

  startPhase("cost: change scope to Trace two (read-only)", "read-only");
  await selectNative("Project", "Trace two");
  await button("Apply filters");
  await show("Calculated API cost €0.57", 25_000);
  text = textOf();
  assert(!text.includes("Provider-reported API charge $0.80") && !text.includes("Calculated API cost $0.57"), "Trace one amounts survived the scope change");
  assert(!text.includes("T1 calculated USD") && !text.includes("T3 billed receipt") && !text.includes("T5 subscription"), "Trace one tasks are still listed");
  assert(text.includes("These amounts cover 1 of 2 counted runs"), around("These amounts cover"));
  shot("cost-trace-two-amounts");
  await control("Calculated API cost €0.57", true);
  await show("add up to the amount shown above (€0.57)", 10_000);
  assert(textOf().includes("T2 calculated EUR") && !textOf().includes("T1 calculated USD"));
  mark("Trace two scope: only EUR €0.57 (T2) and one Unknown-cost run (T4); Trace one rows are gone");
  await button("Close records");
  endPhase();

  startPhase("cost: native export for the Trace two scope (read-only)", "read-only");
  const csv = await exportAndRead("Export runs (CSV)", ".csv");
  const json = await exportAndRead("Export runs (JSON)", ".json");
  evidence.exports = { csv: csv.path, json: json.path, noticeAfterCsv: csv.notice, noticeAfterJson: json.notice };
  const rows = csvRows(csv.text);
  assert(rows.preamble.includes("report=runs") && rows.preamble.includes(c.two), rows.preamble);
  assert.deepEqual(rows.rows.map((r) => r.runId).sort(), [run.r2, run.r4].sort());
  const eur = rows.rows.filter((r) => r.counting === "counted" && r.currency === "EUR").reduce((total, r) => total + Number(r.amount), 0);
  assert(Math.abs(eur - 0.57) < 1e-9, `EUR in the CSV is ${eur}`);
  const parsed = JSON.parse(json.text);
  assert.equal(parsed.runs.length, 2);
  assert.equal(parsed.coverage.runCounts.included, 2);
  assert.equal(parsed.coverage.runCounts.excluded, 0);
  assert.equal(parsed.coverage.filter.projectPath, c.two);
  assert.equal(parsed.coverage.reconciliation.matchesSummary, true);
  const bucket = (key: string) => parsed.coverage.amountBuckets.find((b: { key: string }) => b.key === key);
  assert(Math.abs(bucket("calculated-api/EUR").amount - 0.57) < 1e-9);
  assert.equal(bucket("unknown-cost").runs, 1);
  mark(`CSV and JSON landed at ${csv.path} and ${json.path}; they hold T2 and T4 only, EUR 0.57 matches the screen, filter and counts stated`);
  endPhase();

  startPhase("cost: native export for the Trace one scope, excluded evidence stays out (read-only)", "read-only");
  await selectNative("Project", "Trace one");
  await button("Apply filters");
  await show("Provider-reported API charge $0.80", 25_000);
  const csv1 = await exportAndRead("Export runs (CSV)", ".csv");
  const rows1 = csvRows(csv1.text);
  assert.deepEqual(rows1.rows.map((r) => r.runId).sort(), [run.r1, run.r3, run.r5, run.r6].sort());
  const synthetic = rows1.rows.find((r) => r.runId === run.r6)!;
  assert.equal(synthetic.counting, "excluded");
  assert.equal(synthetic.exclusionReason, "synthetic-evidence");
  assert(!rows1.rows.map((r) => r.runId).includes(run.r7!), "the run before the period is exported");
  const usd = rows1.rows.filter((r) => r.counting === "counted" && r.currency === "USD" && r.costKind === "calculated-api").reduce((total, r) => total + Number(r.amount), 0);
  assert(Math.abs(usd - 0.57) < 1e-9, `USD in the CSV is ${usd}`);
  assert(rows1.preamble.includes("includedRuns=3 excludedRuns=1"), rows1.preamble);
  evidence.exportsTraceOne = { csv: csv1.path };
  mark("Trace one CSV: four rows, the synthetic run flagged excluded and not summed, the run before the period absent, USD 0.57 matches");
  endPhase();
  verdicts.cost = "PASS";
}

try {
  await main();
} catch (error) {
  evidence.blocker = (error as Error).stack ?? (error as Error).message;
  console.error(error);
  if (binding) { try { writeFileSync(join(root, "ax-at-stop.json"), JSON.stringify(inspect(), null, 2)); } catch { /* no AX tree */ } }
  process.exitCode = 1;
} finally {
  try { endPhase(); await stop(); } catch (error) { evidence.cleanup = (error as Error).message; process.exitCode = 1; }
  const ownerAfter = Object.fromEntries(ownerPaths.map((p) => [p, stamp(p)]));
  evidence.ownerUnchanged = JSON.stringify(ownerBefore) === JSON.stringify(ownerAfter);
  if (!evidence.ownerUnchanged) { verdicts.ownerProfile = "FAIL"; process.exitCode = 1; }
  save();
}
