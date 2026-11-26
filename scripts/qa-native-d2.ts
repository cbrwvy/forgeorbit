/**
 * Direction 2 packaged walkthrough (virtual AI company). Isolated ForgeOrbitQA only.
 * Never opens the Owner's ForgeOrbit profile, never calls a provider (every driver is the fake one).
 *
 *   FORGEORBIT_QA_OUTPUT_ROOT=/private/tmp/fo-native-d2-XXXXXX bun run build:qa-native
 *   bun --no-env-file scripts/qa-native-d2.ts <root> up | down | dump [text] | press <name> [contains] | show <text>
 *                                          | text <string> | key <code> [flags] | api <METHOD> <route> [json] | run
 *
 * The Owner-visible actions under test go through the app window (AX press, keys, text). Prerequisites
 * (projects, harness enablement, PM consent, the fixture task and the hiring proposal the fake PM produces)
 * are seeded through the local API of the same isolated profile, never by writing SQLite.
 */
import { assertNativeQaEnvironment, NATIVE_QA_STUB } from "../src/bun/native-qa-environment.ts";
import assert from "node:assert/strict";
import { homedir } from "node:os";
import { mkdirSync, existsSync, realpathSync, readFileSync, writeFileSync, openSync, closeSync, statSync, appendFileSync } from "node:fs";
import { spawn, spawnSync } from "node:child_process";
import { join } from "node:path";

const root = realpathSync(process.argv[2] ?? "");
assert.match(root, /^\/private\/tmp\/fo-native-(?:d[23]|d2[0-9]|ux)-[A-Za-z0-9]+$/);
const cmd = process.argv[3] ?? "";
const repo = join(import.meta.dir, "..");
const runtime = join(root, "runtime");
let data = join(runtime, "data");
const home = join(runtime, "home");
const tmp = join(runtime, "tmp");
const app = join(root, "ForgeOrbitQA-dev.app");
const appBin = join(app, "Contents/MacOS");
const helper = join(root, "qa-native-pid");
const logPath = join(root, "native.log");
let credFile = join(data, "agetor-core.json");
const stateFile = join(root, "d2-state.json");
const bindingFile = join(root, "binding.json");
const evidencePath = join(root, "d2-evidence.json");
const qcVerdictFile = join(runtime, "qc-verdict.txt");

let creds: { pid: number; port: number; token: string } | undefined;
const state: { apiPort?: number; launcherPid?: number; generation?: number; lexicalOnly?: boolean; browserFixture?: boolean; dataDir?: string; homeDir?: string; appPath?: string } = existsSync(stateFile) ? JSON.parse(readFileSync(stateFile, "utf8")) : {};
const saveState = () => writeFileSync(stateFile, JSON.stringify(state));
// A second disposable profile inside the runtime (a restored one) can be opened by the same packaged app.
if (state.dataDir) { data = state.dataDir; credFile = join(data, "agetor-core.json"); }
const useDataDir = (dir: string | null) => { state.dataDir = dir ?? undefined; saveState(); data = dir ?? join(runtime, "data"); credFile = join(data, "agetor-core.json"); creds = undefined; };
const homeFor = () => state.homeDir ?? home;
const appFor = () => state.appPath ?? app;
const useProfile = (opts: { dataDir?: string | null; homeDir?: string | null; appPath?: string | null }) => {
  if (opts.dataDir !== undefined) useDataDir(opts.dataDir);
  if (opts.homeDir !== undefined) { state.homeDir = opts.homeDir ?? undefined; saveState(); }
  if (opts.appPath !== undefined) { state.appPath = opts.appPath ?? undefined; saveState(); }
};

const sh = (argv: string[], timeout = 15000) => {
  const result = spawnSync(argv[0]!, argv.slice(1), { encoding: "utf8", timeout, maxBuffer: 16 * 1024 * 1024 });
  if (result.status !== 0) throw Error(result.stderr?.trim() || String(result.error ?? "helper unavailable"));
  return result.stdout.trim();
};

const ownerPaths = [
  join(homedir(), "Library/Application Support/ForgeOrbit"), join(homedir(), "Library/WebKit/app.forgeorbit"),
  join(homedir(), ".agetor"), join(homedir(), ".forgeorbit"), join(homedir(), ".codex"), join(homedir(), ".claude"),
  join(homedir(), "Applications/ForgeOrbit.app"),
];
const stamp = (p: string) => { try { const s = statSync(p); return `${s.mtimeMs}:${s.size}`; } catch { return "absent"; } };

function prepare() {
  if (!existsSync(helper)) sh(["/usr/bin/clang", "-fobjc-arc", "-framework", "Cocoa", "-framework", "ApplicationServices", join(repo, "scripts/qa-native-pid.m"), "-o", helper], 120000);
  if (state.apiPort == null) {
    const probe = Bun.listen({ hostname: "127.0.0.1", port: 0, socket: { data() {} } });
    state.apiPort = probe.port; probe.stop(true);
    for (const p of [data, homeFor(), tmp, join(runtime, "projects")]) mkdirSync(p, { recursive: true, mode: 0o700 });
    writeFileSync(qcVerdictFile, "PASS\n", { mode: 0o600 });
    writeFileSync(join(root, "owner-before.json"), JSON.stringify(Object.fromEntries(ownerPaths.map((p) => [p, stamp(p)]))));
    saveState();
  }
  for (const p of [data, homeFor(), tmp, join(runtime, "projects")]) mkdirSync(p, { recursive: true, mode: 0o700 });
}

function environment(): Record<string, string> {
  const env: Record<string, string> = {
    PATH: "/usr/bin:/bin:/usr/sbin:/sbin", SHELL: "/bin/sh", LANG: "en_US.UTF-8", HOME: homeFor(), TMPDIR: tmp,
    CODEX_HOME: homeFor(), CLAUDE_CONFIG_DIR: homeFor(), CURSOR_CONFIG_DIR: homeFor(), GEMINI_CLI_HOME: homeFor(),
    XDG_CONFIG_HOME: homeFor(), XDG_DATA_HOME: homeFor(), XDG_STATE_HOME: homeFor(), XDG_CACHE_HOME: homeFor(), LD_LIBRARY_PATH: ".",
    FORGEORBIT_DATA_DIR: data, AGETOR_DATA_DIR: data, FORGEORBIT_API_PORT: String(state.apiPort), AGETOR_API_PORT: String(state.apiPort),
    FORGEORBIT_USAGE_OFFLINE: "1", AGETOR_USAGE_OFFLINE: "1", FORGEORBIT_DISABLE_UPDATES: "1", AGETOR_DISABLE_UPDATES: "1",
    AGETOR_FAKE_QC_VERDICT_FILE: qcVerdictFile,
  };
  const kinds = ["CLAUDE", "CODEX", "CURSOR", "GEMINI", "FX", "ANTIGRAVITY"];
  for (const kind of kinds) env[`AGETOR_${kind}_DRIVER`] = "fake";
  for (const kind of [...kinds, "TMUX", "NOTIFIER", "DISCLAIM"]) {
    const stub = join(runtime, kind.toLowerCase());
    writeFileSync(stub, NATIVE_QA_STUB, { mode: 0o755 });
    env[`AGETOR_${kind}_BIN`] = stub;
  }
  // The sanctioned lexical-only mode: a model directory that does not exist inside the runtime (no download, no seam).
  if (state.lexicalOnly) env.FORGEORBIT_EMBEDDING_MODEL_ROOT = join(runtime, "no-models");
  // Direction 19: the existing QA allowance that lets the bundled Chromium open a loopback http fixture. No other
  // browser variable is set, so the engine has no Playwright cache to fall back on (HOME is the empty QA home).
  if (state.browserFixture) env.FORGEORBIT_BROWSER_ALLOW_LOOPBACK_FIXTURE = "1";
  assertNativeQaEnvironment(runtime, env);
  return env;
}

const readCreds = () => { creds = JSON.parse(readFileSync(credFile, "utf8")); return creds!; };

const poll = async <T>(label: string, fn: () => T | null | Promise<T | null>, timeout = 20000): Promise<T> => {
  const end = Date.now() + timeout;
  let last = "";
  do {
    try { const value = await fn(); if (value) return value; } catch (error) { last = (error as Error).message; }
    await Bun.sleep(200);
  } while (Date.now() < end);
  throw Error(`${label}${last ? `: ${last}` : ""}`);
};

async function up() {
  prepare();
  const receipt = JSON.parse(readFileSync(join(root, "qa-native-build.json"), "utf8"));
  assert.equal(receipt.bundleIdentifier, "app.forgeorbit.qa");
  assert.equal(receipt.qaRuntimeRoot, runtime);
  const env = environment();
  const launched = appFor();
  const launchedBin = join(launched, "Contents/MacOS");
  const fd = openSync(logPath, "a", 0o600);
  const child = spawn(join(launchedBin, "launcher"), [], { cwd: launchedBin, env, detached: true, stdio: ["ignore", fd, fd] });
  closeSync(fd);
  state.launcherPid = child.pid; state.generation = (state.generation ?? 0) + 1; saveState();
  child.unref();
  await poll("Packaged backend did not boot", async () => {
    if (!existsSync(credFile)) return null;
    try { return (await fetch(`http://127.0.0.1:${state.apiPort}/health`, { signal: AbortSignal.timeout(750) })).ok || null; } catch { return null; }
  }, 40_000);
  readCreds();
  assert.equal(creds!.port, state.apiPort);
  await bind();
}

async function down() {
  const pid = state.launcherPid;
  if (!pid) return;
  try { process.kill(-pid, "SIGTERM"); } catch { /* gone */ }
  await poll("launcher exit", () => { try { process.kill(pid, 0); return null; } catch { return true; } }, 8000).catch(() => {
    try { process.kill(-pid, "SIGKILL"); } catch { /* gone */ }
  });
  await Bun.sleep(1200);
}

async function api(method: string, route: string, body?: unknown, expected: number | number[] = [200, 201, 202, 204]): Promise<any> {
  if (!creds) readCreds();
  const res = await fetch(`http://127.0.0.1:${state.apiPort}${route}`, {
    method, headers: { authorization: `Bearer ${creds!.token}`, "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(30_000),
  });
  const raw = await res.text();
  const ok = Array.isArray(expected) ? expected.includes(res.status) : res.status === expected;
  assert(ok, `${method} ${route}: HTTP ${res.status} ${raw.slice(0, 500)}`);
  return raw ? JSON.parse(raw) : null;
}

type AxNode = { AXRole?: string; AXTitle?: string; AXDescription?: string; AXHelp?: string; AXValue?: string | number; AXEnabled?: boolean;
  frame?: { x: number; y: number; width: number; height: number }; children?: AxNode[] };
const entries = (node: AxNode | undefined): AxNode[] => node ? [node, ...(node.children ?? []).flatMap(entries)] : [];
const labels = (node: AxNode) => [node.AXTitle, node.AXDescription, node.AXValue, node.AXHelp].filter((x): x is string => typeof x === "string" && x.length > 0);
const names = (node: AxNode) => [node.AXTitle, node.AXDescription].filter((x): x is string => typeof x === "string" && x.length > 0);
let binding: { axTrusted: boolean; windowId: number; corePid: number };
const ax = (...args: string[]) => sh([helper, bindingFile, ...args]);
const inspect = () => JSON.parse(ax("inspect")) as { web?: AxNode; ax?: AxNode };

async function bind() {
  const candidate = join(root, "candidate.json");
  writeFileSync(candidate, JSON.stringify({ launcherPid: state.launcherPid, corePid: readCreds().pid, artifact: appFor() }), { mode: 0o600 });
  binding = await poll("Packaged window could not be bound", () => { try { return JSON.parse(sh([helper, candidate, "identify"])); } catch { return null; } }, 25_000);
  assert(binding.axTrusted, "macOS Accessibility is unavailable to the QA runner");
  writeFileSync(bindingFile, JSON.stringify(binding), { mode: 0o600 });
  ax("focus");
  ax("resize", "1280", "860");
}

const find = (predicate: (node: AxNode) => boolean) => entries(inspect().web).filter(predicate);
const seek = (label: string, predicate: (node: AxNode) => boolean, timeout = 15_000) => poll(label, () => find(predicate).at(-1) ?? null, timeout);
const hasText = (part: string) => (n: AxNode) => labels(n).some((l) => l.toLowerCase().includes(part.toLowerCase()));
const show = (part: string, timeout?: number) => seek(`App did not render "${part}"`, hasText(part), timeout);
const absent = (part: string, timeout = 8000) => poll(`"${part}" is still shown`, () => (find(hasText(part)).length === 0 ? true : null), timeout);
const matching = (role: string, name: string, exact = true) => (n: AxNode) => n.AXRole === role && names(n).some((x) => (exact ? x === name : x.includes(name)));
const click = (node: AxNode) => {
  assert(node.frame, "Control has no clickable bounds");
  const { x, y, width, height } = node.frame;
  ax("click", String(Math.round(x + width / 2)), String(Math.round(y + height / 2)));
};
/** AX frames live in a shifted space: the web area's frame origin is the window content origin on screen. */
const toScreen = (node: AxNode, web: AxNode) => {
  const boundId = JSON.parse(readFileSync(bindingFile, "utf8")).windowId;
  const win = JSON.parse(sh([helper, join(root, "candidate.json"), "identify"])).windows.find((w: any) => w.kCGWindowIsOnscreen && (w.kCGWindowName === "ForgeOrbit" || w.kCGWindowNumber === boundId));
  const b = win.kCGWindowBounds as { X: number; Y: number };
  const f = node.frame!, o = web.frame!;
  return { x: Math.round(f.x - o.x + b.X + f.width / 2), y: Math.round(f.y - o.y + b.Y + f.height / 2), w: b };
};
/** Click a control by position, scrolling the task panel until it is on screen. For controls with no AX name (selects show only a value). */
const clickByPosition = async (match: (n: AxNode) => boolean, index = 0) => {
  for (let attempt = 0; attempt < 12; attempt++) {
    const web = inspect().web!;
    const node = entries(web).filter(match)[index];
    assert(node?.frame, "control not found for position click");
    const p = toScreen(node, web);
    if (p.y < p.w.Y + 90) { ax("scroll", String(p.w.X + 700), String(p.w.Y + 400), String(-Math.min(800, p.w.Y + 400 - p.y + 200))); await Bun.sleep(300); continue; }
    if (p.y > p.w.Y + 780) { ax("scroll", String(p.w.X + 700), String(p.w.Y + 400), String(Math.min(800, p.y - (p.w.Y + 400) + 200))); await Bun.sleep(300); continue; }
    ax("click", String(p.x), String(p.y));
    await Bun.sleep(400);
    return;
  }
  throw Error("control could not be scrolled into view");
};
const activate = (node: AxNode) => {
  const name = names(node)[0];
  assert(node.AXRole && name, "AX control is not labeled");
  const f = node.frame;
  const point = f ? [String(Math.round(f.x + f.width / 2)), String(Math.round(f.y + f.height / 2))] : [];
  try { ax("press", node.AXRole, name, ...point); } catch (first) {
    try { ax("press", node.AXRole, name); } catch { click(node); void first; }
  }
};
const PRESSABLE = ["AXDisclosureTriangle", "AXPopUpButton", "AXComboBox", "AXButton", "AXCheckBox", "AXRadioButton", "AXTab", "AXMenuItem", "AXLink"];
const pressable = (name: string, exact: boolean) => (n: AxNode) => !!n.AXRole && PRESSABLE.includes(n.AXRole)
  && [...names(n), ...(n.AXRole === "AXPopUpButton" && typeof n.AXValue === "string" ? [n.AXValue] : [])].some((x) => (exact ? x === name : x.includes(name))) && n.AXEnabled !== false;
const button = async (name: string, exact = true, index: number | null = null) => {
  const node = index === null ? await seek(`Missing enabled control "${name}"`, pressable(name, exact))
    : await poll(`Missing enabled control "${name}" #${index}`, () => find(pressable(name, exact))[index] ?? null, 15_000);
  activate(node);
  await Bun.sleep(350);
};

const steps: string[] = [];
const evidence: Record<string, unknown> = { steps };
const save = () => writeFileSync(evidencePath, JSON.stringify(evidence, null, 2) + "\n");
const mark = (step: string) => { steps.push(step); save(); console.log(step); };

function dump(filter?: string) {
  for (const n of entries(inspect().web)) {
    const l = labels(n);
    if (!n.AXRole || (!l.length && n.AXRole !== "AXButton")) continue;
    if (filter && !l.some((x) => x.toLowerCase().includes(filter.toLowerCase()))) continue;
    const f = n.frame ? `${Math.round(n.frame.x)},${Math.round(n.frame.y)} ${Math.round(n.frame.width)}x${Math.round(n.frame.height)}` : "";
    console.log(`${n.AXRole}\t${n.AXEnabled === false ? "disabled\t" : ""}${l.map((x) => x.replace(/\s+/g, " ").slice(0, 110)).join(" | ")}\t${f}`);
  }
}

// -------------------------------------------------------------------------------------------------------
// Scenario
// -------------------------------------------------------------------------------------------------------
async function scenario() { await (await import(process.argv[4] === "d10" ? "./qa-native-d10-scenario.ts" : process.argv[4] === "d29" ? "./qa-direction29-scenario.ts" : process.argv[4] === "d26" ? "./qa-direction26-scenario.ts" : process.argv[4] === "d25" ? "./qa-native-d25-scenario.ts" : process.argv[4] === "ux" ? "./qa-ux-spaces-scenario.ts" : process.argv[4] === "d21" ? "./qa-native-d21-scenario.ts" : process.argv[4] === "d20" ? "./qa-native-d20-scenario.ts" : process.argv[4] === "d19" ? "./qa-native-d19-scenario.ts" : process.argv[4] === "d18" ? "./qa-native-d18-scenario.ts" : process.argv[4] === "d17b" ? "./qa-native-d17b-scenario.ts" : process.argv[4] === "d17" ? "./qa-native-d17-scenario.ts" : process.argv[4] === "d16" ? "./qa-native-d16-scenario.ts" : process.argv[4] === "d15" ? "./qa-native-d15-scenario.ts" : process.argv[4] === "d14" ? "./qa-native-d14-scenario.ts" : process.argv[4] === "d13" ? "./qa-native-d13-scenario.ts" : process.argv[4] === "d12" ? "./qa-native-d12-scenario.ts" : process.argv[4] === "d11" ? "./qa-native-d11-scenario.ts" : process.argv[4] === "d9" ? "./qa-native-d9-scenario.ts" : process.argv[4] === "d8e" ? "./qa-native-d8e-scenario.ts" : process.argv[4] === "d8d" ? "./qa-native-d8d-scenario.ts" : process.argv[4] === "d8c" ? "./qa-native-d8c-scenario.ts" : process.argv[4] === "d8b" ? "./qa-native-d8b-scenario.ts" : process.argv[4] === "d8" ? "./qa-native-d8-scenario.ts" : process.argv[4] === "d7b" ? "./qa-native-d7b-scenario.ts" : process.argv[4] === "d7" ? "./qa-native-d7-scenario.ts" : process.argv[4] === "d6" ? "./qa-native-d6-scenario.ts" : process.argv[4] === "d5" ? "./qa-native-d5-scenario.ts" : process.argv[4] === "d4" ? "./qa-native-d4-scenario.ts" : process.argv[4] === "d3" ? "./qa-native-d3-scenario.ts" : "./qa-native-d2-scenario.ts")).run({ api, button, show, absent, find, seek, matching, hasText, activate, pressable, clickByPosition, toScreen, click, ax, mark, evidence, save, runtime, root, up, down, qcVerdictFile, sleep: Bun.sleep, poll, ownerPaths, stamp, state, saveState, useDataDir, useProfile, environment, appFor }); }

try {
  if (cmd === "up") { await up(); console.log("up", creds!.pid); }
  else if (cmd === "down") { await down(); console.log("down"); }
  else if (cmd === "dump") { prepare(); readCreds(); dump(process.argv[4]); }
  else if (cmd === "popup") { readCreds(); await clickByPosition((n) => n.AXRole === "AXPopUpButton" && n.AXValue === process.argv[4], Number(process.argv[5] ?? 0)); }
  else if (cmd === "press") { readCreds(); await button(process.argv[4]!, process.argv[5] !== "contains", process.argv[6] ? Number(process.argv[6]) : null); }
  else if (cmd === "show") { readCreds(); await show(process.argv[4]!); console.log("shown"); }
  else if (cmd === "text") { readCreds(); ax("text", process.argv[4]!); }
  else if (cmd === "key") { readCreds(); ax("key", process.argv[4]!, process.argv[5] ?? "0"); }
  else if (cmd === "api") { console.log(JSON.stringify(await api(process.argv[4]!, process.argv[5]!, process.argv[6] ? JSON.parse(process.argv[6]) : undefined), null, 2)); }
  else if (cmd === "run") { prepare(); await scenario(); }
  else throw Error("unknown command");
} catch (error) {
  evidence.result = "fail"; evidence.error = (error as Error).stack ?? String(error); save();
  appendFileSync(join(root, "failures.log"), String((error as Error).stack ?? error) + "\n");
  console.error(error);
  process.exitCode = 1;
}
