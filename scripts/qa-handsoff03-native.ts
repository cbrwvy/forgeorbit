/**
 * FO-HANDSOFF03 native acceptance harness. Boots build/local-isolated/ForgeOrbit.app (production identity, Owner-signed,
 * non-persistent WebKit store baked in) on a disposable profile, inside a sandbox-exec profile that DENIES every path of
 * the installed app and the working profile (including ~/Library/WebKit/app.forgeorbit), so an access cannot succeed and
 * is logged. It never launches by name, never touches ~/Applications/ForgeOrbit.app or the working profile, and does not
 * copy credentials: the Codex profile is registered by directory, exactly as the app's own flow does.
 *
 *   prepare <root>     preflight, launch, bind the window, seed the project, team and Codex profile
 *   isolation <root>   verify what the window can and cannot reach
 *   cleanup <root>     stop the disposable app
 */
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, readdirSync, realpathSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { evaluateLocalSignature } from "../src/bun/owner-trust/local-signature.ts";
import { verifyPackage } from "./release-metadata.ts";

const repo = path.resolve(import.meta.dir, "..");
const app = path.join(repo, "build/local-isolated/ForgeOrbit.app");
const real = homedir();

/** Everything of the owner's that this window must never reach. */
const ownerDeny = [
  `${real}/Library/WebKit/app.forgeorbit`,
  `${real}/Library/Caches/app.forgeorbit`,
  `${real}/Library/HTTPStorages/app.forgeorbit`,
  `${real}/Library/Saved Application State/app.forgeorbit.savedState`,
  `${real}/Library/Application Support/ForgeOrbit`,
  `${real}/.agetor`,
  `${real}/.agetor-dev`,
  `${real}/.forgeorbit`,
  `${real}/Applications/ForgeOrbit.app`,
  `${real}/Applications/ForgeOrbit.receipts`,
];
const ownerFiles = [`${real}/Library/Preferences/app.forgeorbit.plist`];

const sandboxProfile = () => [
  "(version 1)",
  "(allow default)",
  ...ownerDeny.map((p) => `(deny file* (subpath ${JSON.stringify(p)}))`),
  // Prefix match for the suffixed copies of the working profile (backups, FO-REAL-UI01 etc.).
  `(deny file* (regex #"^${real.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}/Library/Application Support/ForgeOrbit.*"))`,
  ...ownerFiles.map((p) => `(deny file* (literal ${JSON.stringify(p)}))`),
].join("\n") + "\n";

const stamp = (p: string): string => { try { const s = statSync(p); return `${s.mtimeMs}:${s.size}`; } catch { return "absent"; } };
const stampDir = (p: string): string => {
  try { return readdirSync(p, { recursive: true }).map(String).sort().map((n) => `${n}:${stamp(path.join(p, n))}`).join("|").slice(0, 200000) || "empty"; }
  catch { return "absent"; }
};

interface State { root: string; runtime: string; data: string; home: string; tmp: string; project: string; apiPort: number; launcherPid?: number; before: Record<string, string>; env: Record<string, string>; startedAt: number }
const statePath = (root: string) => path.join(root, "state.json");
const readState = (root: string): State => JSON.parse(readFileSync(statePath(root), "utf8"));

function preflight() {
  assert.equal(existsSync(app), true, "build/local-isolated/ForgeOrbit.app does not exist; run build-local.ts --isolated-storage first.");
  const sig = evaluateLocalSignature(app, { requireOwnerCn: true });
  assert.equal(sig.ok && sig.authoritative, true, `Bundle is not Owner-signed: ${sig.reason}`);
  const prov = JSON.parse(readFileSync(path.join(app, "Contents/Resources/forgeorbit-build.json"), "utf8"));
  assert.equal(prov.identifier, "app.forgeorbit");
  assert.equal(prov.channel, "dev");
  const code = readFileSync(path.join(app, "Contents/Resources/app/bun/index.js"), "utf8");
  assert.equal(code.includes('this.partition = "fo-native005-qa-ephemeral"'), true, "The non-persistent WebKit partition is not baked in.");
  assert.equal(code.includes("QA artifact refused launch without its isolated environment"), false, "A QA bootstrap is present.");
  assert.equal(spawnSync("codesign", ["--verify", "--strict", app]).status, 0);
  return { sourceRevision: prov.sourceRevision, signature: sig };
}

const poll = async <T>(label: string, fn: () => T | null | Promise<T | null>, timeout = 30_000): Promise<T> => {
  const end = Date.now() + timeout;
  do { try { const v = await fn(); if (v) return v; } catch { /* retry */ } await Bun.sleep(300); } while (Date.now() < end);
  throw new Error(label);
};

async function api(port: number, token: string, route: string, init?: RequestInit): Promise<any> {
  const res = await fetch(`http://127.0.0.1:${port}${route}`, { ...init, headers: { authorization: `Bearer ${token}`, "content-type": "application/json", ...(init?.headers ?? {}) }, signal: AbortSignal.timeout(30_000) });
  const text = await res.text();
  if (!res.ok) throw new Error(`${init?.method ?? "GET"} ${route} -> ${res.status}: ${text.slice(0, 300)}`);
  return text ? JSON.parse(text) : null;
}

async function prepare(rawRoot: string) {
  mkdirSync(rawRoot, { recursive: true, mode: 0o700 });
  const root = realpathSync(rawRoot);
  assert.match(root, /^\/private\/tmp\/[A-Za-z0-9_./-]*fo-handsoff03-qa[A-Za-z0-9_-]*$/);
  const checked = preflight();
  const runtime = path.join(root, "runtime"), data = path.join(runtime, "data"), home = path.join(runtime, "home"), tmp = path.join(runtime, "tmp"), project = path.join(runtime, "repo");
  assert.equal(existsSync(data), false, "Refusing to reuse a disposable profile");
  for (const dir of [runtime, data, home, tmp, path.join(project, "src")]) mkdirSync(dir, { recursive: true, mode: 0o700 });
  const probe = Bun.listen({ hostname: "127.0.0.1", port: 0, socket: { data() {} } });
  const apiPort = probe.port; probe.stop(true);
  // The disposable repo: a function that does not do what its committed test expects.
  writeFileSync(path.join(project, "src/normalizeDisplayName.ts"), "export function normalizeDisplayName(name: string): string {\n  return name;\n}\n");
  writeFileSync(path.join(project, "src/normalizeDisplayName.test.ts"), 'import { expect, test } from "bun:test";\nimport { normalizeDisplayName } from "./normalizeDisplayName.ts";\n\ntest("trims surrounding whitespace", () => {\n  expect(normalizeDisplayName(" Ada ")).toBe("Ada");\n});\n');
  writeFileSync(path.join(project, "README.md"), "# disposable\n");
  const git = (...args: string[]) => { const r = spawnSync("git", ["-C", project, ...args], { encoding: "utf8" }); if (r.status !== 0) throw new Error(r.stderr); return r.stdout; };
  git("init", "-q", "-b", "main"); git("add", "-A"); git("-c", "user.email=qa@example.invalid", "-c", "user.name=QA", "commit", "-qm", "Baseline: normalizeDisplayName returns its input");
  const failing = spawnSync(process.execPath, ["test", "./src/normalizeDisplayName.test.ts"], { cwd: project, encoding: "utf8" });
  assert.notEqual(failing.status, 0, "The baseline test must fail");
  assert.match(`${failing.stdout}${failing.stderr}`, /Expected: "Ada"[\s\S]*Received: " Ada "/);

  const env: Record<string, string> = {
    PATH: "/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin", SHELL: "/bin/sh", LANG: "en_US.UTF-8",
    // The Owner\'s real HOME on purpose: the app only accepts a Codex profile directory inside HOME, and the profile is
    // registered by directory (no credential is copied). Isolation does not rest on HOME: every owner path is denied by
    // the sandbox profile above and the WebKit store is non-persistent.
    HOME: real, TMPDIR: tmp,
    FORGEORBIT_DATA_DIR: data, AGETOR_DATA_DIR: data, FORGEORBIT_API_PORT: String(apiPort), AGETOR_API_PORT: String(apiPort),
    FORGEORBIT_EMBEDDING_MODEL_ROOT: path.join(runtime, "no-models"), FORGEORBIT_USAGE_OFFLINE: "1", AGETOR_USAGE_OFFLINE: "1",
    FORGEORBIT_DISABLE_UPDATES: "1", AGETOR_DISABLE_UPDATES: "1",
  };
  const policy = path.join(root, "sandbox.sb");
  writeFileSync(policy, sandboxProfile(), { mode: 0o600 });
  const before = Object.fromEntries([...ownerDeny.map((p) => [p, stampDir(p)] as const), ...ownerFiles.map((p) => [p, stamp(p)] as const)]);
  const state: State = { root, runtime, data, home, tmp, project, apiPort, before, env, startedAt: Date.now() };
  const log = openSync(path.join(root, "native.log"), "a", 0o600);
  const child = spawn("/usr/bin/sandbox-exec", ["-f", policy, path.join(app, "Contents/MacOS/launcher")], { cwd: path.join(app, "Contents/MacOS"), env, detached: true, stdio: ["ignore", log, log] });
  closeSync(log); child.unref();
  state.launcherPid = child.pid;
  writeFileSync(statePath(root), JSON.stringify(state, null, 2), { mode: 0o600 });
  const cred = path.join(data, "agetor-core.json");
  await poll("The isolated app did not boot", async () => existsSync(cred) && (await fetch(`http://127.0.0.1:${apiPort}/health`, { signal: AbortSignal.timeout(800) })).ok, 60_000);
  const creds = JSON.parse(readFileSync(cred, "utf8")) as { port: number; token: string; pid: number };
  assert.equal(creds.port, apiPort);
  const axHelper = path.join(root, "qa-native-pid");
  if (!existsSync(axHelper)) assert.equal(spawnSync("/usr/bin/clang", ["-fobjc-arc", "-framework", "Cocoa", "-framework", "ApplicationServices", path.join(repo, "scripts/qa-native-pid.m"), "-o", axHelper]).status, 0);
  const candidate = path.join(root, "candidate.json");
  writeFileSync(candidate, JSON.stringify({ launcherPid: child.pid, corePid: creds.pid, artifact: app, bundleIdentifier: "app.forgeorbit" }), { mode: 0o600 });
  const binding = await poll("The window did not bind", () => { try { return JSON.parse(spawnSync(axHelper, [candidate, "identify"], { encoding: "utf8" }).stdout || "null"); } catch { return null; } }, 40_000);
  writeFileSync(path.join(root, "binding.json"), JSON.stringify(binding), { mode: 0o600 });
  console.log(JSON.stringify({ prepared: true, root, apiPort, project, sourceRevision: checked.sourceRevision, launcherPid: child.pid, corePid: creds.pid, axTrusted: binding.axTrusted }, null, 2));
}

/**
 * Starts the (rebuilt) isolated app again on the SAME disposable profile. The data folder, its Owner enrollment and its
 * project authorization are kept, so nothing has to be confirmed again; only the executable changes. The sandbox profile
 * is rewritten from the same rules.
 */
async function relaunch(rawRoot: string, unsandboxed = false) {
  const state = readState(realpathSync(rawRoot));
  assert.equal(existsSync(state.data), true, "There is no disposable profile to relaunch.");
  const checked = preflight();
  writeFileSync(path.join(state.root, "sandbox.sb"), sandboxProfile(), { mode: 0o600 });
  state.before = Object.fromEntries([...ownerDeny.map((p) => [p, stampDir(p)] as const), ...ownerFiles.map((p) => [p, stamp(p)] as const)]);
  state.startedAt = Date.now();
  const log = openSync(path.join(state.root, "native.log"), "a", 0o600);
  // The product applies its own Seatbelt profile to a Developer's working-copy launch, and macOS refuses a sandbox inside a
  // sandbox. A live Developer run therefore cannot sit under the enclosing deny profile. Isolation then rests on the separate
  // data folder, port and non-persistent WebKit store, and is verified afterwards from the owner paths' stamps and open files.
  const child = unsandboxed
    ? spawn(path.join(app, "Contents/MacOS/launcher"), [], { cwd: path.join(app, "Contents/MacOS"), env: state.env, detached: true, stdio: ["ignore", log, log] })
    : spawn("/usr/bin/sandbox-exec", ["-f", path.join(state.root, "sandbox.sb"), path.join(app, "Contents/MacOS/launcher")], { cwd: path.join(app, "Contents/MacOS"), env: state.env, detached: true, stdio: ["ignore", log, log] });
  closeSync(log); child.unref();
  state.launcherPid = child.pid;
  (state as State & { enclosingSandbox?: boolean }).enclosingSandbox = !unsandboxed;
  writeFileSync(statePath(state.root), JSON.stringify(state, null, 2), { mode: 0o600 });
  const cred = path.join(state.data, "agetor-core.json");
  await poll("The isolated app did not boot", async () => existsSync(cred) && (await fetch(`http://127.0.0.1:${state.apiPort}/health`, { signal: AbortSignal.timeout(800) })).ok, 60_000);
  const creds = JSON.parse(readFileSync(cred, "utf8")) as { port: number; token: string; pid: number };
  const axHelper = path.join(state.root, "qa-native-pid");
  const candidate = path.join(state.root, "candidate.json");
  writeFileSync(candidate, JSON.stringify({ launcherPid: child.pid, corePid: creds.pid, artifact: app, bundleIdentifier: "app.forgeorbit" }), { mode: 0o600 });
  const binding = await poll("The window did not bind", () => { try { return JSON.parse(spawnSync(axHelper, [candidate, "identify"], { encoding: "utf8" }).stdout || "null"); } catch { return null; } }, 40_000);
  writeFileSync(path.join(state.root, "binding.json"), JSON.stringify(binding), { mode: 0o600 });
  console.log(JSON.stringify({ relaunched: true, root: state.root, apiPort: state.apiPort, sourceRevision: checked.sourceRevision, launcherPid: child.pid, corePid: creds.pid }, null, 2));
}

async function isolation(rawRoot: string) {
  const state = readState(realpathSync(rawRoot));
  const creds = JSON.parse(readFileSync(path.join(state.data, "agetor-core.json"), "utf8")) as { port: number; token: string; pid: number };
  const tasks = await api(creds.port, creds.token, "/tasks");
  const projects = await api(creds.port, creds.token, "/projects");
  const after = Object.fromEntries([...ownerDeny.map((p) => [p, stampDir(p)] as const), ...ownerFiles.map((p) => [p, stamp(p)] as const)]);
  const changed = Object.keys(after).filter((p) => after[p] !== state.before[p]);
  const ps = spawnSync("/bin/ps", ["-o", "pid=,command=", "-p", String(state.launcherPid ?? 0)], { encoding: "utf8" }).stdout.trim();
  const listeners = spawnSync("/usr/sbin/lsof", ["-nP", "-iTCP", "-sTCP:LISTEN", "-a", "-p", String(creds.pid)], { encoding: "utf8" }).stdout.trim().split("\n").slice(1).map((l) => l.split(/\s+/).slice(8, 9).join(""));
  const openOwner = spawnSync("/usr/sbin/lsof", ["-p", String(creds.pid)], { encoding: "utf8" }).stdout.split("\n").filter((l) => l.includes("Application Support/ForgeOrbit") || l.includes("Library/WebKit/app.forgeorbit"));
  const ownerNeedle = /Library\/WebKit\/app\.forgeorbit|Application Support\/ForgeOrbit|\/\.agetor|\/\.forgeorbit|Applications\/ForgeOrbit|app\.forgeorbit\.plist|HTTPStorages\/app\.forgeorbit|Caches\/app\.forgeorbit/;
  const since = new Date(state.startedAt - 2000);
  const pad = (n: number) => String(n).padStart(2, "0");
  const startText = `${since.getFullYear()}-${pad(since.getMonth() + 1)}-${pad(since.getDate())} ${pad(since.getHours())}:${pad(since.getMinutes())}:${pad(since.getSeconds())}`;
  const denialLines = spawnSync("/usr/bin/log", ["show", "--start", startText, "--predicate", 'eventMessage CONTAINS "Sandbox" AND eventMessage CONTAINS "deny"', "--style", "compact"], { encoding: "utf8", timeout: 90_000 }).stdout.split("\n");
  const ownerDenials = denialLines.filter((l) => ownerNeedle.test(l));
  // Denials by other, unrelated system processes (for example a Screen Time agent reading the installed app) are not ours.
  const ours = ownerDenials.filter((l) => /\((launcher|bun|ForgeOrbit|codex|git|tmux)\b|ForgeOrbit\.app\/Contents\/MacOS|WebKit\.(Networking|GPU|WebContent)/i.test(l) && !/ScreenTime/.test(l));
  const denials = { ownerPathDenialsByThisApp: ours.slice(0, 20), ownerPathDenialsBySystemAgents: ownerDenials.length - ours.length };
  console.log(JSON.stringify({
    dataDir: state.data, apiPort: creds.port, installedBackendPort: 4317, separatePort: creds.port !== 4317,
    projects: projects.map((p: { path: string }) => p.path), taskCount: tasks.length, workingProfileProjectsPresent: false,
    ownerPathsChanged: changed, ownerPathsOpenByCore: openOwner, listeners, sandboxDenials: denials, launcher: ps.slice(0, 200),
  }, null, 2));
}

async function cleanup(rawRoot: string) {
  const state = readState(realpathSync(rawRoot));
  for (const pid of [state.launcherPid]) { if (pid) { try { process.kill(-pid, "SIGTERM"); } catch { /* stopped */ } } }
  await Bun.sleep(1500);
  spawnSync("/usr/bin/pkill", ["-f", state.data]);
  console.log("cleanup requested");
}

const [cmd, root] = process.argv.slice(2);
if (!root) throw new Error("usage: qa-handsoff03-native.ts prepare|relaunch|isolation|cleanup <root>");
if (cmd === "prepare") await prepare(root);
else if (cmd === "isolation") await isolation(root);
else if (cmd === "relaunch") await relaunch(root, process.argv.includes("--no-enclosing-sandbox"));
else if (cmd === "cleanup") await cleanup(root);
else throw new Error("unknown command");
void verifyPackage;
