/**
 * FO-PROVIDERS-LIVE-READY01 packaged Owner walk.
 * Isolated ForgeOrbitQA only. Recorded drivers. No provider inference.
 *
 * FORGEORBIT_QA_OUTPUT_ROOT=<root> bun --no-env-file scripts/build-qa-native.ts
 * bun --no-env-file scripts/qa-providers-live-ready01.ts <root>
 */
import { assertNativeQaEnvironment, NATIVE_QA_STUB } from "../src/bun/native-qa-environment.ts";
import assert from "node:assert/strict";
import { homedir } from "node:os";
import { existsSync, realpathSync, readFileSync, writeFileSync, openSync, closeSync, statSync } from "node:fs";
import { spawn, spawnSync } from "node:child_process";
import { join } from "node:path";

const repo = join(import.meta.dir, "..");
const root = realpathSync(process.argv[2] ?? "");
assert.match(root, /^\/private\/tmp\/fo-providers-live-ready01-[A-Za-z0-9]+$/);
const consoleLocked = () => /"IOConsoleLocked" = Yes/.test(spawnSync("/usr/sbin/ioreg", ["-n", "Root", "-d1"], { encoding: "utf8" }).stdout ?? "");
if (consoleLocked()) {
  console.error("STOP: macOS console is locked. No native interaction.");
  process.exit(2);
}

const runtime = join(root, "runtime");
const data = join(runtime, "data");
const home = join(runtime, "home");
const tmp = join(runtime, "tmp");
const app = join(root, "ForgeOrbitQA-dev.app");
assert.equal(realpathSync(app), app);
assert.equal(existsSync(data), false, "Refusing to reuse a QA profile");
spawnSync("/bin/chmod", ["700", runtime]);
for (const dir of [data, home, tmp]) spawnSync("/bin/mkdir", ["-m", "700", dir]);
const helper = join(root, "qa-native-pid");
const portProbe = Bun.listen({ hostname: "127.0.0.1", port: 0, socket: { data() {} } });
const apiPort = portProbe.port;
portProbe.stop(true);
const logPath = join(root, "native.log");
const credFile = join(data, "agetor-core.json");
const ownerPaths = [join(homedir(), "Library/Application Support/ForgeOrbit"), join(homedir(), ".agetor")];
const stamp = (p: string) => { try { const s = statSync(p); return `${s.mtimeMs}:${s.size}`; } catch { return "absent"; } };
const ownerBefore = Object.fromEntries(ownerPaths.map((p) => [p, stamp(p)]));

const seeded = spawnSync(process.execPath, ["--no-env-file", join(repo, "scripts/qa-providers-live-ready01-seed.ts"), runtime], { encoding: "utf8" });
if (seeded.status !== 0) throw new Error(seeded.stderr || seeded.stdout || "seed failed");
const summary = JSON.parse(readFileSync(join(runtime, "seed-summary.json"), "utf8")) as {
  missionId: string; lifecycleTaskId: string; failedTaskId: string; cancelledTaskId: string; pausedTaskId: string;
  verdictFile: string; fixtureFile: string;
};

const sh = (argv: string[], timeout = 20_000) => {
  const result = spawnSync(argv[0]!, argv.slice(1), { encoding: "utf8", timeout, maxBuffer: 16 * 1024 * 1024 });
  if (result.status !== 0) throw new Error(result.stderr?.trim() || result.stdout?.trim() || "helper unavailable");
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
  AGETOR_FAKE_QC_VERDICT_FILE: summary.verdictFile,
  AGETOR_PROVIDER_FIXTURE_FILE: summary.fixtureFile,
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
  }, 30_000);
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
const ax = (...args: string[]) => sh([helper, bindingFile, ...args]);
const inspect = () => JSON.parse(ax("inspect")) as { web?: AxNode };
const bind = async () => {
  const candidate = join(root, "candidate.json");
  writeFileSync(candidate, JSON.stringify({ launcherPid: child?.pid, corePid: creds.pid, artifact: app }));
  const binding = await poll("Packaged window could not be bound", () => { try { return JSON.parse(sh([helper, candidate, "identify"])); } catch { return null; } }, 30_000);
  assert.ok(binding.axTrusted);
  writeFileSync(bindingFile, JSON.stringify(binding));
  ax("focus");
  ax("resize", "1400", "1000");
};
const find = (predicate: (node: AxNode) => boolean) => entries(inspect().web).filter(predicate);
const seek = async (label: string, predicate: (node: AxNode) => boolean, timeout = 15_000) => {
  try { return await poll(label, () => find(predicate).at(-1) ?? null, timeout); }
  catch (error) {
    evidence.visible = [...new Set(entries(inspect().web).flatMap(labels))].slice(0, 240);
    throw error;
  }
};
const showAny = (parts: string[]) => seek(`WKWebView did not render ${parts.join(" | ")}`, (node) => labels(node).some((label) => parts.some((part) => label.includes(part))));
const area = (node: AxNode) => (node.frame?.width ?? 1_000_000) * (node.frame?.height ?? 1_000_000);
const clickNode = (node: AxNode) => {
  const frame = node.frame;
  if (!frame || frame.width < 1 || frame.height < 1) throw new Error(`control has no frame: ${labels(node).join(" | ")}`);
  ax("focus");
  ax("click", String(Math.round(frame.x + frame.width / 2)), String(Math.round(frame.y + frame.height / 2)));
};
const activate = (nodes: AxNode[], name: string) => {
  const chosen = nodes.slice().sort((a, b) => area(a) - area(b))[0]!;
  try {
    ax("focus");
    ax("press", chosen.AXRole!, name);
  } catch (error) {
    if (!(error as Error).message.includes("ambiguous")) throw error;
    clickNode(chosen);
  }
};
const controls = async (label: string, predicate: (node: AxNode) => boolean, timeout = 20_000) => {
  try {
    return await poll(label, () => {
      const found = find(predicate);
      return found.length ? found : null;
    }, timeout);
  } catch (error) {
    evidence.visible = [...new Set(entries(inspect().web).flatMap(labels))].slice(0, 240);
    throw error;
  }
};
const pressMatching = async (part: string) => {
  const matches = await controls(`Missing control ${part}`, (n) => Boolean(n.AXRole) && labels(n).some((label) => label.includes(part)));
  const name = labels(matches[0]!).find((label) => label.includes(part))!;
  activate(matches, name);
  await Bun.sleep(500);
};
const pressLabel = async (options: string[], role?: string, timeout = 20_000) => {
  const matches = await controls(`Missing control ${options.join(" | ")}`, (n) => options.some((name) => labels(n).includes(name)) && Boolean(n.AXRole) && (role ? n.AXRole === role : true), timeout);
  const name = options.find((option) => labels(matches[0]!).includes(option))!;
  activate(matches, name);
  await Bun.sleep(400);
};
const evidence: Record<string, unknown> = { bundle: "app.forgeorbit.qa", synthetic: true, inference: false, steps: [] as string[] };
const mark = (step: string) => { (evidence.steps as string[]).push(step); writeFileSync(join(root, "fo-providers-live-ready01.json"), JSON.stringify(evidence, null, 2)); console.log(step); };
const api = async (route: string) => {
  const response = await fetch(`http://127.0.0.1:${apiPort}${route}`, {
    headers: { authorization: `Bearer ${creds.token}` },
    signal: AbortSignal.timeout(20_000),
  });
  const text = await response.text();
  if (!response.ok) throw new Error(`GET ${route} -> ${response.status}: ${text.slice(0, 400)}`);
  return text ? JSON.parse(text) : null;
};
const taskRow = async (id: string) => {
  const tasks = await api("/tasks");
  const rows = Array.isArray(tasks) ? tasks : tasks.tasks ?? [];
  return rows.find((task: { id: string }) => task.id === id) as { id: string; column: string; runId?: string | null; title: string } | undefined;
};
const missionRow = async () => {
  const body = await api(`/api/orchestration/missions/${summary.missionId}`) as { mission?: { status: string; plan: { tasks: Array<{ taskId: string; phase: string; phaseReason?: string; reworkEpoch?: number; runId?: string }> } } };
  return body.mission ?? body as unknown as { status: string; plan: { tasks: Array<{ taskId: string; phase: string; phaseReason?: string; reworkEpoch?: number; runId?: string }> } };
};

try {
  await boot();
  await bind();
  try { await pressLabel(["Skip", "Пропустить — я уже знаком с приложением", "Пропустить", "Скрыть — я уже знаком с приложением"], undefined, 4_000); } catch { /* welcome already closed */ }
  await pressLabel(["Settings", "Настройки"]);
  await pressLabel(["Harnesses", "Среды CLI"]);
  await showAny(["This screen cannot approve it", "Этот экран не может"]);
  await showAny(["Not authorized", "Не разрешено"]);
  await showAny(["Blocked", "Заблокировано"]);
  const harnesses = await api("/harnesses") as { runtimeReadiness?: { executableNow: boolean; authorizedExecution: string; genuineExecution: string }[] };
  assert.ok(harnesses.runtimeReadiness?.every((row) => row.executableNow === false && row.authorizedExecution === "not-authorized" && row.genuineExecution === "not-verified"));
  mark("Settings showed the trusted Owner channel is unsupported");
  ax("key", "53", "0");
  await Bun.sleep(400);
  try { await pressLabel(["Скрыть — я уже знаком с приложением", "Skip"], undefined, 3_000); } catch { /* checklist already closed */ }
  await pressMatching("projects/project-one");
  await showAny(["Lifecycle"]);
  mark("Project One board shows the lifecycle task");
  await pressLabel(["Missions", "Миссии"]);
  await showAny(["Pipeline company", "Mission Control", "Multi-Project"]);
  await showAny(["An external process will not start", "Внешний процесс не запустится"]);
  await showAny(["Execution blocked", "Исполнение заблокировано"]);
  await pressMatching("Work Queue");
  await showAny(["gpt-6.1-sol"]);
  await showAny(["Codex A"]);
  mark("Mission Control shows the allocated Developer model and account");
  const runsBefore = async () => {
    const tasks = await api("/tasks");
    const rows = (Array.isArray(tasks) ? tasks : tasks.tasks ?? []) as Array<{ runId?: string | null }>;
    return rows.filter((task) => task.runId).length;
  };
  assert.equal(await runsBefore(), 0);
  await pressLabel(["Start Mission"]);
  mark("Owner started the authorized recorded mission");
  const changed = await poll("Lifecycle did not request changes", async () => {
    const bundle = await api(`/tasks/${summary.lifecycleTaskId}/qc`) as { reviews?: Array<{ verdict?: string | null }> };
    return bundle.reviews?.some((review) => review.verdict === "CHANGES_REQUESTED") ? bundle : null;
  }, 90_000);
  evidence.changesRequested = true;
  await pressLabel(["All tasks", "Все задачи"]);
  await pressLabel(["Lifecycle"]);
  await showAny(["CHANGES_REQUESTED", "Changes requested", "Запрошены изменения", "Доработка выполняется", "Ожидается приёмка владельца"]);
  mark("Owner saw CHANGES_REQUESTED");
  writeFileSync(summary.verdictFile, "PASS");
  const passed = await poll("Rework did not reach QC PASS", async () => {
    const bundle = await api(`/tasks/${summary.lifecycleTaskId}/qc`) as { reviews?: Array<{ verdict?: string | null }>; state?: { latestVerdict?: string } };
    const pass = bundle.reviews?.some((review) => review.verdict === "PASS") || bundle.state?.latestVerdict === "PASS";
    return pass ? bundle : null;
  }, 90_000);
  evidence.qcPass = true;
  await showAny(["Owner acceptance pending", "QC passed", "Ожидается приёмка владельца", "QC пройден", "осмотрите результат"]);
  mark("Owner saw QC PASS waiting for acceptance");
  await pressLabel(["All tasks", "Все задачи"]);
  await showAny(["Lifecycle"]);
  await pressLabel(["Done", "Выполнено"], "AXButton", 40_000);
  const done = await poll("Owner Done did not settle", async () => {
    const row = await taskRow(summary.lifecycleTaskId);
    return row?.column === "done" ? row : null;
  }, 30_000);
  evidence.doneColumn = done.column;
  mark("Owner completed the authorized Done transition");
  const failed = await poll("Provider failure did not settle", async () => {
    const mission = await missionRow();
    const row = mission.plan.tasks.find((task) => task.taskId === summary.failedTaskId);
    return row?.phase === "failed" ? row : null;
  }, 60_000);
  evidence.providerFailed = failed.phase;
  const held = await poll("Cancellation task did not start", async () => {
    const row = await taskRow(summary.cancelledTaskId);
    return row?.column === "running" && row.runId ? row : null;
  }, 60_000);
  evidence.heldRunId = held.runId;
  await pressLabel(["All tasks", "Все задачи"]);
  await pressMatching("Остановить: Cancellation");
  const cancelled = await poll("Cancellation did not settle", async () => {
    const mission = await missionRow();
    const row = mission.plan.tasks.find((task) => task.taskId === summary.cancelledTaskId);
    return row?.phase === "cancelled" ? row : null;
  }, 45_000);
  mark("Owner stopped the held recorded run");
  const paused = await taskRow(summary.pausedTaskId);
  assert.equal(paused?.runId ?? null, null);
  evidence.pausedWithoutRun = true;
  await pressLabel(["Analytics", "Аналитика"]);
  await showAny(["Live provider launch is unavailable", "Живой запуск провайдера недоступен"]);
  await showAny(["Unknown", "Неизвестно"]);
  mark("Analytics opened on the persisted recorded company");
  const runIds = async () => {
    const tasks = await api("/tasks");
    const rows = (Array.isArray(tasks) ? tasks : tasks.tasks ?? []) as Array<{ id: string; column: string; runId?: string | null }>;
    return rows.map((task) => `${task.id}:${task.column}:${task.runId ?? ""}`).sort();
  };
  evidence.beforeRestart = await runIds();
  void changed;
  void passed;
  await stop();
  await boot();
  await bind();
  const after = await runIds();
  evidence.afterRestart = after;
  assert.deepEqual(after, evidence.beforeRestart);
  const running = await api("/tasks") as Array<{ column: string }> | { tasks: Array<{ column: string }> };
  const rows = Array.isArray(running) ? running : running.tasks ?? [];
  assert.equal(rows.filter((task) => task.column === "running").length, 0);
  mark("Relaunch kept the final task state and did not start another worker");
} finally {
  await stop();
  evidence.ownerUnchanged = ownerPaths.every((p) => stamp(p) === ownerBefore[p]);
  writeFileSync(join(root, "fo-providers-live-ready01.json"), JSON.stringify(evidence, null, 2));
  if (evidence.ownerUnchanged !== true) throw new Error("Owner application data changed");
}
