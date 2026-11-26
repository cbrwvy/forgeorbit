/**
 * FO-OWNER-TRUST02 packaged QA walk.
 * Isolated ForgeOrbitQA only. The native review is cancelled.
 * No Touch ID, no password, no Owner enrollment, no provider process.
 *
 * FORGEORBIT_QA_OUTPUT_ROOT=<root> bun --no-env-file scripts/build-qa-native.ts
 * bun --no-env-file scripts/qa-owner-trust02.ts <root>
 */
import { assertNativeQaEnvironment, NATIVE_QA_STUB } from "../src/bun/native-qa-environment.ts";
import assert from "node:assert/strict";
import { Database } from "bun:sqlite";
import { homedir } from "node:os";
import { existsSync, mkdirSync, realpathSync, readFileSync, writeFileSync, openSync, closeSync, statSync } from "node:fs";
import { spawn, spawnSync } from "node:child_process";
import { join } from "node:path";

const repo = join(import.meta.dir, "..");
const root = realpathSync(process.argv[2] ?? "");
assert.match(root, /^\/private\/tmp\/fo-owner-trust02-[A-Za-z0-9]+$/);
const consoleLocked = () => /"IOConsoleLocked" = Yes/.test(spawnSync("/usr/sbin/ioreg", ["-n", "Root", "-d1"], { encoding: "utf8" }).stdout ?? "");
if (consoleLocked()) {
  console.error("STOP: macOS console is locked. No native interaction.");
  process.exit(2);
}

const runtime = join(root, "runtime");
const data = join(runtime, "data");
const home = join(runtime, "home");
const tmp = join(runtime, "tmp");
const workspace = join(runtime, "workspace");
const app = join(root, "ForgeOrbitQA-dev.app");
assert.equal(realpathSync(app), app);
assert.equal(existsSync(join(app, "Contents/Resources/app/bin/forgeorbit-owner-trust")), true);
assert.equal(existsSync(data), false, "Refusing to reuse a QA profile");
spawnSync("/bin/chmod", ["700", runtime]);
for (const dir of [data, home, tmp, workspace]) mkdirSync(dir, { recursive: true, mode: 0o700 });
const helper = join(root, "qa-native-pid");
const portProbe = Bun.listen({ hostname: "127.0.0.1", port: 0, socket: { data() {} } });
const apiPort = portProbe.port;
portProbe.stop(true);
const logPath = join(root, "native.log");
const credFile = join(data, "agetor-core.json");
const ownerPaths = [join(homedir(), "Library/Application Support/ForgeOrbit"), join(homedir(), ".agetor")];
const stamp = (p: string) => { try { const s = statSync(p); return `${s.mtimeMs}:${s.size}`; } catch { return "absent"; } };
const ownerBefore = Object.fromEntries(ownerPaths.map((p) => [p, stamp(p)]));
const providerNames = ["codex", "claude", "claude-code"];
const providerPids = () => providerNames.flatMap((name) => (spawnSync("/usr/bin/pgrep", ["-x", name], { encoding: "utf8" }).stdout ?? "").split("\n").filter(Boolean).map((pid) => `${name}:${pid}`)).sort();
const providersBefore = providerPids();

spawnSync("/usr/bin/clang", ["-fobjc-arc", "-framework", "Cocoa", "-framework", "ApplicationServices", join(repo, "scripts/qa-native-pid.m"), "-o", helper], { encoding: "utf8" });
const env: Record<string, string> = {
  PATH: "/usr/bin:/bin:/usr/sbin:/sbin", SHELL: "/bin/sh", LANG: "en_US.UTF-8", HOME: home, TMPDIR: tmp,
  CODEX_HOME: home, CLAUDE_CONFIG_DIR: home, CURSOR_CONFIG_DIR: home, GEMINI_CLI_HOME: home,
  XDG_CONFIG_HOME: home, XDG_DATA_HOME: home, XDG_STATE_HOME: home, XDG_CACHE_HOME: home,
  FORGEORBIT_DATA_DIR: data, AGETOR_DATA_DIR: data, FORGEORBIT_API_PORT: String(apiPort), AGETOR_API_PORT: String(apiPort),
  FORGEORBIT_EMBEDDING_MODEL_ROOT: join(runtime, "no-models"),
  FORGEORBIT_USAGE_OFFLINE: "1", AGETOR_USAGE_OFFLINE: "1", FORGEORBIT_DISABLE_UPDATES: "1", AGETOR_DISABLE_UPDATES: "1",
};
for (const kind of ["CLAUDE", "CODEX", "CURSOR", "GEMINI", "FX", "ANTIGRAVITY"]) env[`AGETOR_${kind}_DRIVER`] = "fake";
for (const kind of ["CLAUDE", "CODEX", "CURSOR", "GEMINI", "FX", "ANTIGRAVITY", "TMUX", "NOTIFIER", "DISCLAIM"]) {
  const stub = join(runtime, kind.toLowerCase());
  writeFileSync(stub, NATIVE_QA_STUB, { mode: 0o755 });
  env[`AGETOR_${kind}_BIN`] = stub;
}
assertNativeQaEnvironment(runtime, env);

const launch = () => {
  const fd = openSync(logPath, "a", 0o600);
  const child = spawn(join(app, "Contents/MacOS/launcher"), [], { cwd: join(app, "Contents/MacOS"), env, detached: true, stdio: ["ignore", fd, fd] });
  closeSync(fd);
  return child;
};
let child: ReturnType<typeof launch> | undefined;
let creds: { pid: number; port: number; token: string };
const poll = async <T>(label: string, fn: () => T | null | Promise<T | null>, timeout = 20_000): Promise<T> => {
  const end = Date.now() + timeout;
  let last = "";
  do {
    if (consoleLocked()) throw new Error("STOP: macOS console is locked.");
    try { const value = await fn(); if (value) return value; } catch (error) { last = (error as Error).message; }
    await Bun.sleep(250);
  } while (Date.now() < end);
  throw new Error(`${label}${last ? `: ${last}` : ""}`);
};
const boot = async () => {
  child = launch();
  await poll("Packaged backend did not boot", async () => {
    if (!existsSync(credFile)) return null;
    try { return (await fetch(`http://127.0.0.1:${apiPort}/health`, { signal: AbortSignal.timeout(750) })).ok || null; } catch { return null; }
  }, 45_000);
  creds = JSON.parse(readFileSync(credFile, "utf8"));
  assert.equal(creds.port, apiPort);
};
const stop = async () => {
  if (!child?.pid) return;
  const pid = child.pid;
  const exited = new Promise<void>((resolve) => { if (child?.exitCode != null || child?.signalCode != null) resolve(); else child?.once("exit", () => resolve()); });
  try { process.kill(-pid, "SIGTERM"); } catch { /* already stopped */ }
  await Promise.race([exited, Bun.sleep(4000)]);
  try { process.kill(-pid, 0); } catch { child = undefined; return; }
  try { process.kill(-pid, "SIGKILL"); } catch { /* already stopped */ }
  await Bun.sleep(500);
  child = undefined;
};
type AxNode = { AXRole?: string; AXTitle?: string; AXDescription?: string; AXValue?: string | number; frame?: { x: number; y: number; width: number; height: number }; children?: AxNode[] };
const entries = (node: AxNode | undefined): AxNode[] => node ? [node, ...(node.children ?? []).flatMap(entries)] : [];
const labels = (node: AxNode) => [node.AXTitle, node.AXDescription, node.AXValue].filter((value): value is string => typeof value === "string");
const bindingFile = join(root, "binding.json");
const ax = (...args: string[]) => {
  const result = spawnSync(helper, [bindingFile, ...args], { encoding: "utf8", timeout: 20_000 });
  if (result.status !== 0) throw new Error(result.stderr?.trim() || result.stdout?.trim() || "helper unavailable");
  return result.stdout.trim();
};
const inspect = () => JSON.parse(ax("inspect")) as { web?: AxNode };
const bind = async () => {
  const candidate = join(root, "candidate.json");
  writeFileSync(candidate, JSON.stringify({ launcherPid: child?.pid, corePid: creds.pid, artifact: app }));
  const binding = await poll("Packaged window could not be bound", () => { try { return JSON.parse(spawnSync(helper, [candidate, "identify"], { encoding: "utf8" }).stdout || "null"); } catch { return null; } }, 30_000);
  assert.ok(binding.axTrusted);
  writeFileSync(bindingFile, JSON.stringify(binding));
  ax("focus");
  ax("resize", "1400", "1000");
};
const find = (predicate: (node: AxNode) => boolean) => entries(inspect().web).filter(predicate);
const showAny = async (parts: string[]) => {
  try {
    await poll(`WKWebView did not render ${parts.join(" | ")}`, () => find((node) => labels(node).some((label) => parts.some((part) => label.includes(part)))).at(-1) ?? null, 20_000);
  } catch (error) {
    evidence.visible = [...new Set(entries(inspect().web).flatMap(labels))].slice(0, 300);
    writeFileSync(join(root, "fo-owner-trust02.json"), JSON.stringify(evidence, null, 2));
    throw error;
  }
};
const pressLabel = async (options: string[]) => {
  const matches = await poll(`Missing control ${options.join(" | ")}`, () => {
    const found = find((node) => options.some((name) => labels(node).includes(name)) && Boolean(node.AXRole));
    return found.length ? found : null;
  }, 20_000);
  const name = options.find((option) => labels(matches[0]!).includes(option))!;
  const frame = matches[0]!.frame;
  ax("focus");
  try {
    ax("press", matches[0]!.AXRole!, name);
  } catch (error) {
    if (!frame || !(error as Error).message.includes("ambiguous")) throw error;
    ax("click", String(Math.round(frame.x + frame.width / 2)), String(Math.round(frame.y + frame.height / 2)));
  }
  await Bun.sleep(500);
};
const api = async (route: string, init?: RequestInit) => {
  const response = await fetch(`http://127.0.0.1:${apiPort}${route}`, {
    ...init,
    headers: { authorization: `Bearer ${creds.token}`, "content-type": "application/json", ...(init?.headers ?? {}) },
    signal: AbortSignal.timeout(20_000),
  });
  const text = await response.text();
  if (!response.ok) throw new Error(`${init?.method ?? "GET"} ${route} -> ${response.status}: ${text.slice(0, 400)}`);
  return text ? JSON.parse(text) : null;
};
const trustCounts = () => {
  const database = new Database(join(data, "agetor.sqlite"), { readonly: true });
  const grants = database.query<{ count: number }, []>("SELECT COUNT(*) AS count FROM owner_trust_grants").get()?.count ?? 0;
  const enrolled = database.query<{ count: number }, []>("SELECT COUNT(*) AS count FROM owner_trust_enrollments").get()?.count ?? 0;
  const refused = database.query<{ count: number }, []>("SELECT COUNT(*) AS count FROM owner_trust_decisions WHERE decision = 'refused'").get()?.count ?? 0;
  database.close();
  return { grants, enrolled, refused };
};
const helperPid = () => {
  const text = spawnSync("/bin/ps", ["-ax", "-o", "pid=,command="], { encoding: "utf8" }).stdout ?? "";
  const embedded = join(app, "Contents/Resources/app/bin/forgeorbit-owner-trust");
  return text.split("\n").map((line) => line.trim()).filter((line) => line.includes(embedded) && !line.includes("status")).map((line) => Number(line.split(/\s+/)[0])).find((pid) => pid > 0) ?? null;
};
const cancelReview = (pid: number) => {
  const script = `
tell application "System Events"
  set targetProcess to first process whose unix id is ${pid}
  set names to name of every button of window 1 of targetProcess
  if names contains "Authenticate" and names does not contain "Cancel" and names does not contain "Отменить" then error "refusing to press Authenticate"
  if names contains "Cancel" then
    click button "Cancel" of window 1 of targetProcess
  else if names contains "Отменить" then
    click button "Отменить" of window 1 of targetProcess
  else
    error "cancel button was not found"
  end if
end tell`;
  const result = spawnSync("/usr/bin/osascript", ["-e", script], { encoding: "utf8", timeout: 10_000 });
  if (result.status !== 0) throw new Error(result.stderr || "Could not cancel the native review");
};

const evidence: Record<string, unknown> = { bundle: "app.forgeorbit.qa", inference: false, authentication: false, steps: [] as string[] };
const mark = (step: string) => { (evidence.steps as string[]).push(step); writeFileSync(join(root, "fo-owner-trust02.json"), JSON.stringify(evidence, null, 2)); console.log(step); };

try {
  await boot();
  const created = await api("/tasks", {
    method: "POST",
    body: JSON.stringify({
      title: "Owner trust review",
      prompt: "Inspect the exact operation and do not start a provider.",
      agent: "codex",
      model: "gpt-6.1-sol",
      mode: "auto",
      workdir: workspace,
      isolation: "none",
    }),
  }) as { id: string };
  evidence.taskId = created.id;
  await bind();
  try { await pressLabel(["Skip", "Пропустить — я уже знаком с приложением", "Пропустить", "Скрыть — я уже знаком с приложением"]); } catch { /* welcome already closed */ }
  await pressLabel(["Missions", "Миссии"]);
  await pressLabel(["Owner confirmation", "Подтверждение владельца"]);
  await showAny(["Owner authorization", "Авторизация владельца"]);
  await showAny(["This is a development build", "Это сборка для разработки"]);
  await showAny(["No external AI process", "Внешний процесс ИИ"]);
  await pressLabel(["Identifiers, signatures and raw values", "Идентификаторы, подписи и исходные значения"]);
  await showAny(["app.forgeorbit.qa"]);
  const status = await api("/api/owner-trust/status") as {
    code: string; executionReady: boolean; providerExecutionEligible: boolean; secureEnclave: string; enrollmentState: string;
    application: { bundleId: string | null; adhoc: boolean }; helper: { identifier: string | null; code: string }; operation: { taskId: string; externalProcess: boolean } | null;
  };
  assert.equal(status.application.bundleId, "app.forgeorbit.qa");
  assert.equal(status.application.adhoc, true);
  assert.equal(status.executionReady, false);
  assert.equal(status.providerExecutionEligible, false);
  assert.equal(status.secureEnclave, "hardware-present");
  assert.notEqual(status.enrollmentState, "active");
  assert.equal(status.helper.identifier, "app.forgeorbit.qa.owner-trust");
  assert.equal(status.operation?.taskId, created.id);
  assert.equal(status.operation?.externalProcess, false);
  assert.equal(status.code, "application-identity-unestablished");
  evidence.status = status.code;
  mark("Packaged QA showed signing, helper, enclave, enrollment, and the exact operation");
  await pressLabel(["Review with macOS", "Проверить через macOS"]);
  const pid = await poll("Native review did not open", () => helperPid(), 20_000);
  evidence.helperPid = pid;
  cancelReview(pid);
  await poll("Cancellation did not settle", () => {
    const counts = trustCounts();
    return counts.refused > 0 && counts.grants === 0 ? counts : null;
  }, 20_000);
  const afterCancel = trustCounts();
  assert.equal(afterCancel.grants, 0);
  assert.equal(afterCancel.enrolled, 0);
  assert.deepEqual(providerPids(), providersBefore);
  evidence.grants = 0;
  mark("Native review was cancelled. No grant, no enrollment, no provider process");
  const beforeRestart = trustCounts();
  await stop();
  await boot();
  await bind();
  await pressLabel(["Missions", "Миссии"]);
  await pressLabel(["Owner confirmation", "Подтверждение владельца"]);
  await showAny(["This is a development build", "Это сборка для разработки"]);
  const reopened = await api("/api/owner-trust/status") as { executionReady: boolean; providerExecutionEligible: boolean; application: { bundleId: string | null } };
  assert.equal(reopened.application.bundleId, "app.forgeorbit.qa");
  assert.equal(reopened.executionReady, false);
  assert.equal(reopened.providerExecutionEligible, false);
  assert.deepEqual(trustCounts(), beforeRestart);
  assert.deepEqual(providerPids(), providersBefore);
  mark("Relaunch kept the cancelled review and the production blocker");
} finally {
  await stop();
  evidence.ownerUnchanged = ownerPaths.every((p) => stamp(p) === ownerBefore[p]);
  writeFileSync(join(root, "fo-owner-trust02.json"), JSON.stringify(evidence, null, 2));
  if (evidence.ownerUnchanged !== true) throw new Error("Owner application data changed");
}
