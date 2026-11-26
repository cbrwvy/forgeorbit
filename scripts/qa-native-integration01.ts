/**
 * FO-NATIVE-INTEGRATION01 packaged walkthrough.
 * Isolated ForgeOrbitQA only. Does not open the Owner's ForgeOrbit profile.
 *
 * FORGEORBIT_QA_OUTPUT_ROOT=<root> bun run build:qa-native
 * bun --no-env-file scripts/qa-native-integration01.ts <root>
 */
import { assertNativeQaEnvironment, NATIVE_QA_STUB } from "../src/bun/native-qa-environment.ts";
import assert from "node:assert/strict";
import { homedir } from "node:os";
import { mkdirSync, existsSync, realpathSync, readFileSync, writeFileSync, openSync, closeSync, statSync } from "node:fs";
import { spawn, spawnSync } from "node:child_process";
import { join } from "node:path";

const root = realpathSync(process.argv[2] ?? "");
assert.match(root, /^\/private\/tmp\/fo-native-integration01-[A-Za-z0-9]+$/);
const repo = join(import.meta.dir, "..");
const runtime = join(root, "runtime");
const data = join(runtime, "data");
const home = join(runtime, "home");
const tmp = join(runtime, "tmp");
const alpha = join(runtime, "Alpha");
const beta = join(runtime, "Beta");
const backups = join(runtime, "backups");
const restores = join(runtime, "restores");
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
for (const p of [data, home, tmp, alpha, beta, backups, restores]) mkdirSync(p, { recursive: true, mode: 0o700 });

const ownerPaths = [
  join(homedir(), "Library/Application Support/ForgeOrbit"),
  join(homedir(), "Library/WebKit/app.forgeorbit"),
  join(homedir(), ".agetor"),
  join(homedir(), ".forgeorbit"),
  join(homedir(), ".codex"),
  join(homedir(), ".claude"),
];
const stamp = (p: string) => {
  try {
    const s = statSync(p);
    return `${s.mtimeMs}:${s.size}`;
  } catch {
    return "absent";
  }
};
const ownerBefore = Object.fromEntries(ownerPaths.map((p) => [p, stamp(p)]));

const sh = (argv: string[], timeout = 7000) => {
  const result = spawnSync(argv[0]!, argv.slice(1), { encoding: "utf8", timeout, maxBuffer: 8 * 1024 * 1024 });
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
assertNativeQaEnvironment(runtime, env);
const receipt = JSON.parse(readFileSync(join(root, "qa-native-build.json"), "utf8"));
assert.equal(receipt.bundleIdentifier, "app.forgeorbit.qa");
assert.equal(receipt.qaRuntimeRoot, runtime);

const modelOnnx = join(app, "Contents/Resources/app/models/Xenova/paraphrase-multilingual-MiniLM-L12-v2/onnx/model_quantized.onnx");
const onnxBinding = join(app, "Contents/Resources/app/node_modules/onnxruntime-node/bin/napi-v3/darwin/arm64/onnxruntime_binding.node");
assert.equal(existsSync(modelOnnx), true, "packaged model missing");
assert.equal(existsSync(onnxBinding), true, "packaged ONNX binding missing");

const launch = () => {
  const fd = openSync(logPath, "a", 0o600);
  const child = spawn(join(appBin, "launcher"), [], { cwd: appBin, env, detached: true, stdio: ["ignore", fd, fd] });
  closeSync(fd);
  return child;
};

const steps: string[] = [];
const evidence: Record<string, unknown> = {
  apiPort, bundle: "app.forgeorbit.qa", manifest: receipt.artifactManifestSHA256,
  model: "Xenova/paraphrase-multilingual-MiniLM-L12-v2", fakeDrivers: kinds, steps,
};
const evidencePath = join(root, "fo-native-integration01-evidence.json");
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
    }
    await Bun.sleep(200);
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
  assert.equal(res.status, expected, `${method} ${route}: HTTP ${res.status}${raw ? ` ${raw.slice(0, 400)}` : ""}`);
  if (!raw && expected === 204) return null;
  return raw ? JSON.parse(raw) : null;
}

type AxNode = { AXRole?: string; AXTitle?: string; AXDescription?: string; AXHelp?: string; AXValue?: string | number; AXEnabled?: boolean;
  frame?: { x: number; y: number; width: number; height: number }; children?: AxNode[] };
const entries = (node: AxNode | undefined): AxNode[] => node ? [node, ...(node.children ?? []).flatMap(entries)] : [];
const labels = (node: AxNode) => [node.AXTitle, node.AXDescription, node.AXValue, node.AXHelp].filter((x): x is string => typeof x === "string");
const names = (node: AxNode) => [node.AXTitle, node.AXDescription].filter((x): x is string => typeof x === "string");
const bindingFile = join(root, "binding.json");
let binding: { axTrusted: boolean; windowId: number; corePid: number };
const ax = (...args: string[]) => sh([helper, bindingFile, ...args]);
const inspect = () => JSON.parse(ax("inspect")) as { web?: AxNode; ax?: AxNode };
const bind = async () => {
  const candidate = join(root, "candidate.json");
  writeFileSync(candidate, JSON.stringify({ launcherPid: child?.pid, corePid: creds.pid, artifact: app }), { mode: 0o600 });
  binding = await poll("Packaged window could not be bound", () => {
    try { return JSON.parse(sh([helper, candidate, "identify"])); } catch { return null; }
  }, 20_000);
  assert(binding.axTrusted, "macOS Accessibility is unavailable to the QA runner");
  writeFileSync(bindingFile, JSON.stringify(binding), { mode: 0o600 });
  ax("focus");
  ax("resize", "1280", "860");
};
const find = (predicate: (node: AxNode) => boolean) => entries(inspect().web).filter(predicate);
const seek = (label: string, predicate: (node: AxNode) => boolean, timeout = 12_000) =>
  poll(label, () => find(predicate).at(-1) ?? null, timeout);
const show = (part: string) => seek(`WKWebView did not render "${part}"`,
  (node) => labels(node).some((label) => label.includes(part)));
const matching = (role: string, name: string) => (n: AxNode) => n.AXRole === role && names(n).includes(name);
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
  const node = await seek(`Missing enabled button "${name}"`, (n) => matching("AXButton", name)(n) && n.AXEnabled !== false);
  activate(node);
  await Bun.sleep(250);
};

async function backupRoundTrip() {
  const script = `
    const data = ${JSON.stringify(data)};
    const backups = ${JSON.stringify(backups)};
    const restores = ${JSON.stringify(restores)};
    process.env.AGETOR_DATA_DIR = data;
    process.env.FORGEORBIT_DATA_DIR = data;
    const { BackupService } = await import(${JSON.stringify(join(repo, "src/bun/backup-service.ts"))});
    const service = new BackupService({ dataDir: data, dbPath: data + "/agetor.sqlite", registryPath: ${JSON.stringify(join(runtime, "backup-registry.json"))} });
    const info = service.getProfileInfo();
    const grant = service.issueDestinationGrant(backups, "backup-parent");
    const created = await wait(service, service.startCreate(grant.id).id);
    const snapshotPath = created.snapshotPath;
    const verified = await wait(service, service.startVerify(snapshotPath).id);
    const preview = await service.previewRestore(snapshotPath, verified.id);
    const restoreGrant = service.issueDestinationGrant(restores, "restore-parent");
    const restored = await wait(service, service.startRestore({ snapshotPath, grantId: restoreGrant.id, verificationId: verified.id, destinationName: "restored-profile" }).id);
    const manifest = JSON.parse(await Bun.file(snapshotPath + "/manifest.json").text());
    console.log(JSON.stringify({
      coverage: info.coverage,
      notIncluded: info.notIncluded,
      manifestKeys: Object.keys(manifest),
      activated: restored.restore?.activated ?? null,
      destination: restored.destinationPath,
      previewReady: preview.recovery?.readiness ?? null,
    }));
    async function wait(service, id) {
      for (let i = 0; i < 240; i++) {
        const op = service.getOperation(id);
        if (op.state === "completed") return op;
        if (op.state === "failed" || op.state === "cancelled") throw new Error(op.state + " " + JSON.stringify(op.error ?? op));
        await Bun.sleep(250);
      }
      throw new Error("backup operation did not settle");
    }
  `;
  const result = spawnSync(process.execPath, ["--no-env-file", "-e", script], { encoding: "utf8", timeout: 120_000 });
  if (result.status !== 0) throw new Error(result.stderr || result.stdout || "backup child failed");
  const line = result.stdout.trim().split("\n").filter((row) => row.startsWith("{")).at(-1);
  assert(line, result.stdout);
  return JSON.parse(line) as { coverage: string; notIncluded: string[]; activated: boolean | null; destination: string; previewReady: string };
}

try {
  await boot();
  mark("Packaged ForgeOrbitQA started on an isolated profile");
  await api("PUT", "/preferences/onboardingDismissed", { value: "true" }, 204);
  await api("PUT", "/preferences/locale", { value: "en" }, 204);
  const project = await api("POST", "/projects", { path: alpha, name: "Integration Alpha" });
  await api("POST", "/projects", { path: beta, name: "Integration Beta" });
  const cluster = await api("POST", "/clusters", { name: "Integration Cluster" }, 201);
  await api("POST", `/clusters/${cluster.id}/projects`, { projectPath: project.path }, 201);
  const channel = await api("GET", "/infra-auto/channel");
  assert.equal(channel.available, false);
  evidence.trustedChannel = channel;
  const memory = await api("POST", "/brain/memories", {
    scopeKind: "project", projectPath: alpha, title: "SQLite busy timeout", kind: "decision",
    content: "When SQLite reports database locked, set busy_timeout to 2000ms and use WAL.",
  }, 201);
  const embedded = await poll("Embedding status did not become the packaged multilingual model", async () => {
    const status = await api("GET", "/brain/embeddings/status");
    evidence.embeddingStatus = status;
    if (status.engine === "transformers-local" && String(status.model).includes("paraphrase-multilingual-MiniLM-L12-v2") && status.dimension === 384) return status;
    return null;
  }, 60_000);
  assert.equal(embedded.enabled, true);
  const search = await poll("Semantic search did not retrieve the saved memory", async () => {
    const report = await api("GET", "/brain/memories/search?scopeKind=project&projectPath=" + encodeURIComponent(alpha) + "&mode=semantic&q=" + encodeURIComponent("database lock workaround"));
    if (report.mode !== "semantic") return null;
    return report.results.some((row: { id: string }) => row.id === memory.id) ? report : null;
  }, 60_000);
  evidence.searchMode = search.mode;
  mark("Packaged process embedded and retrieved with the multilingual model");

  await bind();
  mark("Bound the packaged WKWebView");
  const skip = find((n) => ["Skip", "Пропустить"].some((s) => matching("AXButton", s)(n))).at(-1);
  if (skip) activate(skip);
  await button("Missions");
  await show("Multi-Project Mission Control");
  await show("Self-improvement");
  await show("Autonomous development");
  mark("Mission Control rendered in the packaged window");
  await button("Emergency stop");
  await show("Emergency stop is active");
  const stopped = await api("GET", "/api/autonomy/status");
  assert.equal(stopped.emergency.active, true);
  await button("Clear emergency stop");
  await poll("Emergency stop stayed active", async () => {
    const status = await api("GET", "/api/autonomy/status");
    return status.emergency.active ? null : status;
  });
  mark("Emergency stop and clear used the packaged button and the policy engine");
  await button("Brain");
  await show("paraphrase-multilingual-MiniLM-L12-v2");
  mark("Brain page showed the active embedding model");
  await button("Clusters");
  await show("Integration Cluster");
  mark("Cluster registry rendered the disposable cluster");

  await stop();
  mark("Quit the packaged app");
  await boot();
  const projects = await api("GET", "/projects");
  assert(projects.some((row: { name: string }) => row.name === "Integration Alpha"));
  const again = await api("GET", "/brain/embeddings/status");
  assert.equal(again.engine, "transformers-local");
  const remembered = await api("GET", "/brain/memories/search?scopeKind=project&projectPath=" + encodeURIComponent(alpha) + "&mode=semantic&q=" + encodeURIComponent("SQLite lock"));
  assert.equal(remembered.mode, "semantic");
  assert(remembered.results.some((row: { id: string }) => row.id === memory.id));
  const channelAfter = await api("GET", "/infra-auto/channel");
  assert.equal(channelAfter.available, false);
  mark("Restart kept the project, the memory, and the blocked infrastructure channel");
  await stop();

  const backup = await backupRoundTrip();
  assert.equal(backup.activated, false);
  assert(backup.notIncluded.some((item) => /credential/i.test(item)), JSON.stringify(backup.notIncluded));
  evidence.backup = backup;
  mark("Isolated profile backup restored without execution authority and without credentials");

  const ownerAfter = Object.fromEntries(ownerPaths.map((p) => [p, stamp(p)]));
  assert.deepEqual(ownerAfter, ownerBefore, "Owner profile paths changed");
  evidence.ownerUntouched = true;
  mark("Owner profile paths were unchanged");
  evidence.result = "pass";
  save();
  console.log("FO-NATIVE-INTEGRATION01 packaged walkthrough passed");
} catch (error) {
  evidence.result = "fail";
  evidence.error = (error as Error).stack ?? String(error);
  save();
  console.error(error);
  try { await stop(); } catch { /* already stopped */ }
  process.exitCode = 1;
}
