/**
 * FO-ROUTER-COMPLETE02 packaged Owner walk.
 * Isolated ForgeOrbitQA only. No inference and no provider requests.
 *
 * FORGEORBIT_QA_OUTPUT_ROOT=<root> bun --no-env-file scripts/build-qa-native.ts
 * bun --no-env-file scripts/qa-router-complete02.ts <root>
 */
import { seedMissionReplanFixture } from "./qa-forecast-replan01-fixture.ts";
import { Database } from "bun:sqlite";
import { assertNativeQaEnvironment, NATIVE_QA_STUB } from "../src/bun/native-qa-environment.ts";
import assert from "node:assert/strict";
import { homedir } from "node:os";
import { existsSync, mkdirSync, realpathSync, readFileSync, writeFileSync, openSync, closeSync, statSync } from "node:fs";
import { spawn, spawnSync } from "node:child_process";
import { join } from "node:path";

const repo = join(import.meta.dir, "..");
const root = realpathSync(process.argv[2] ?? "");
assert.match(root, /^\/private\/tmp\/fo-router-complete02-[A-Za-z0-9]+$/);
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
for (const dir of [data, home, tmp]) spawnSync("/bin/mkdir", ["-p", "-m", "700", dir]);
const helper = join(root, "qa-native-pid");
const portProbe = Bun.listen({ hostname: "127.0.0.1", port: 0, socket: { data() {} } });
const apiPort = portProbe.port;
portProbe.stop(true);
const logPath = join(root, "native.log");
const credFile = join(data, "agetor-core.json");
const ownerPaths = [join(homedir(), "Library/Application Support/ForgeOrbit"), join(homedir(), ".agetor")];
const stamp = (p: string) => { try { const s = statSync(p); return `${s.mtimeMs}:${s.size}`; } catch { return "absent"; } };
const ownerBefore = Object.fromEntries(ownerPaths.map(p => [p, stamp(p)]));

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
  const exited = new Promise<void>(resolve => { if (child?.exitCode != null || child?.signalCode != null) resolve(); else child?.once("exit", () => resolve()); });
  try { process.kill(-pid, "SIGTERM"); } catch { /* already stopped */ }
  await Promise.race([exited, Bun.sleep(4000)]);
  try { process.kill(-pid, 0); } catch { child = undefined; return; }
  try { process.kill(-pid, "SIGKILL"); } catch { /* already stopped */ }
  await Bun.sleep(500);
  child = undefined;
};

type AxNode = { AXRole?: string; AXTitle?: string; AXDescription?: string; AXValue?: string | number; AXEnabled?: boolean; frame?: { x: number; y: number; width: number; height: number }; children?: AxNode[] };
const entries = (node: AxNode | undefined): AxNode[] => node ? [node, ...(node.children ?? []).flatMap(entries)] : [];
const labels = (node: AxNode) => [node.AXTitle, node.AXDescription, node.AXValue].filter((value): value is string => typeof value === "string");
const names = (node: AxNode) => [node.AXTitle, node.AXDescription].filter((value): value is string => typeof value === "string");
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
    evidence.visible = [...new Set(entries(inspect().web).flatMap(labels))].slice(0, 200);
    throw error;
  }
};
const show = (part: string) => seek(`WKWebView did not render "${part}"`, node => labels(node).some(label => label.includes(part)));
const showAny = (parts: string[]) => seek(`WKWebView did not render ${parts.join(" | ")}`, node => labels(node).some(label => parts.some(part => label.includes(part))));
const exact = (node: AxNode, name: string) => names(node).some(value => value === name);
const activate = (node: AxNode, name: string) => {
  if (!node.frame) { ax("press", node.AXRole!, name); return; }
  const x = String(Math.round(node.frame.x + node.frame.width / 2));
  const y = String(Math.round(node.frame.y + node.frame.height / 2));
  try { ax("press", node.AXRole!, name, x, y); } catch { ax("click", x, y); }
};
const press = async (role: string, name: string) => {
  const node = await seek(`Missing ${role} "${name}"`, n => n.AXRole === role && exact(n, name) && n.AXEnabled !== false);
  activate(node, name);
  await Bun.sleep(350);
};
const pressAny = async (role: string, options: string[]) => {
  const node = await seek(`Missing ${role} ${options.join(" | ")}`, n => n.AXRole === role && options.some(name => exact(n, name)) && n.AXEnabled !== false);
  activate(node, options.find(name => exact(node, name))!);
  await Bun.sleep(350);
};
const pressLabel = async (options: string[]) => {
  const node = await seek(`Missing control ${options.join(" | ")}`, n => options.some(name => labels(n).includes(name)) && Boolean(n.frame));
  const name = options.find(option => labels(node).includes(option))!;
  ax("focus");
  if (node.AXRole && names(node).includes(name)) activate(node, name);
  else ax("click", String(Math.round(node.frame!.x + node.frame!.width / 2)), String(Math.round(node.frame!.y + node.frame!.height / 2)));
  await Bun.sleep(350);
};
const evidence: Record<string, unknown> = { bundle: "app.forgeorbit.qa", synthetic: true, inference: false, steps: [] as string[] };
const mark = (step: string) => { (evidence.steps as string[]).push(step); writeFileSync(join(root, "fo-router-complete02.json"), JSON.stringify(evidence, null, 2)); console.log(step); };
const api = async (method: string, route: string, body?: unknown, expected = 200) => {
  const response = await fetch(`http://127.0.0.1:${apiPort}${route}`, {
    method,
    headers: { authorization: `Bearer ${creds.token}`, "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(20_000),
  });
  const text = await response.text();
  const parsed = text ? JSON.parse(text) : null;
  if (response.status !== expected) throw new Error(`${method} ${route} -> ${response.status}: ${text.slice(0, 500)}`);
  return parsed;
};
const get = (route: string) => api("GET", route);

try {
  await boot();
  await bind();
  const skip = await poll("Welcome skip was not exposed", () =>
    find(n => labels(n).some(label => label === "Skip" || label.startsWith("Пропустить"))).at(-1) ?? null, 15_000);
  evidence.skip = { role: skip.AXRole, name: names(skip)[0] ?? null, frame: skip.frame ?? null };
  const skipName = names(skip)[0] ?? "Skip";
  if (skip.frame) {
    ax("press", skip.AXRole ?? "AXButton", skipName, String(Math.round(skip.frame.x + skip.frame.width / 2)), String(Math.round(skip.frame.y + skip.frame.height / 2)));
  } else ax("press", skip.AXRole ?? "AXButton", skipName);
  await poll("Welcome dialog stayed open", () => find(n => labels(n).some(label => label.startsWith("Добро пожаловать") || label.startsWith("Welcome"))).length === 0 ? true : null, 8_000);
  await pressAny("AXButton", ["Settings", "Настройки"]);
  await poll("Settings sections were not exposed", () =>
    find(n => labels(n).some(label => label === "AI Router 2.0" || label === "AI-маршрутизатор 2.0")).length ? true : null);
  const startedRussian = find(n => labels(n).some(label => label === "AI-маршрутизатор 2.0")).length > 0;
  if (startedRussian) {
    await press("AXButton", "AI-маршрутизатор 2.0");
    await show("не разрешает исполнение");
    await show("не дает права на исполнение");
    await press("AXButton", "Максимальная Скорость");
    await press("AXButton", "Сохранить политику");
    await show("Policy saved successfully.");
    evidence.russianVisible = true;
    mark("Native Russian Router showed both boundaries and saved Fastest");
    await press("AXButton", "Общее");
  } else {
    await press("AXButton", "AI Router 2.0");
    await show("does not authorize execution");
    await show("not execution authority");
    await press("AXButton", "Fastest");
    await press("AXButton", "Save Policy");
    await show("Policy saved successfully.");
    mark("Native AI Router showed the recommendation and fallback boundaries and saved Fastest");
    await press("AXButton", "General");
  }
  if (!startedRussian) {
    const language = find(n => n.AXRole === "AXPopUpButton" && labels(n).some(label => label === "English" || label === "Русский")).at(-1);
    if (language) {
      try { ax("set-value", "AXPopUpButton", names(language)[0] ?? "English", "Русский"); }
      catch (error) { evidence.languageControl = (error as Error).message; }
    }
    await Bun.sleep(500);
    const routerRu = find(n => n.AXRole === "AXButton" && exact(n, "AI-маршрутизатор 2.0")).at(-1);
    if (routerRu) {
      activate(routerRu, "AI-маршрутизатор 2.0");
      await Bun.sleep(400);
      await show("не разрешает исполнение");
      await show("не дает права на исполнение");
      evidence.russianVisible = true;
      await press("AXButton", "Общее");
    }
  }
  const popup = find(n => n.AXRole === "AXPopUpButton" && labels(n).some(label => label === "Русский" || label === "English")).at(-1);
  if (popup && labels(popup).includes("Русский")) {
    try { ax("set-value", "AXPopUpButton", names(popup)[0] ?? "Русский", "English"); }
    catch (error) { evidence.languageRestore = (error as Error).message; }
    await Bun.sleep(400);
  }
  mark(evidence.russianVisible ? "Native Router showed the Russian recommendation and fallback boundaries" : "Native language control did not expose Russian Router copy");
  ax("key", "37", "655360");
  await Bun.sleep(600);
  evidence.englishAfterToggle = find(n => labels(n).some(label => label === "Settings" || label === "AI Router 2.0" || label === "General")).length > 0;
  ax("key", "53", "0");
  await Bun.sleep(400);
  const backlogDir = join(tmp, "backlog-project");
  mkdirSync(backlogDir, { recursive: true });
  const backlog = await api("POST", "/tasks", {
    title: "Router backlog fixture", prompt: "Estimate only. Do not launch.", workdir: backlogDir, isolation: "none", column: "backlog",
    agent: "codex", model: "gpt-6.1-sol", mode: "auto",
  });
  evidence.backlogTaskId = backlog.task?.id ?? backlog.id ?? null;
  const backlogTitle = find(n => labels(n).some(label => label.includes("Router backlog fixture"))).at(-1);
  if (backlogTitle) {
    activate(backlogTitle, labels(backlogTitle)[0] ?? "Router backlog fixture");
    await Bun.sleep(500);
    const finder = find(n => n.AXRole === "AXButton" && exact(n, "Find suitable AI resource")).at(-1);
    if (finder) {
      activate(finder, "Find suitable AI resource");
      await Bun.sleep(800);
      await show("does not authorize execution");
      evidence.backlogRecommendation = "visible";
    } else evidence.backlogRecommendation = "task opened; recommendation control was not exposed";
  } else evidence.backlogRecommendation = "backlog card was not exposed; the task was seeded and was not started";
  const runsBeforeApproval = (await get("/tasks")) as Array<{ id: string; runId?: string | null }>;
  assert.equal(runsBeforeApproval.some(task => task.runId), false);
  mark("Backlog fixture stayed unlaunched before any resource approval");
  const seeded = await seedMissionReplanFixture(api, data, home);
  const base = `/api/orchestration/missions/${seeded.mission.id}`;
  const options = await get(`${base}/resource-options?role=reviewer&taskId=${seeded.task.id}`);
  const option = options.options.find((row: { accountId: string; modelId: string; resource?: { accountId: string } }) =>
    row.accountId === seeded.replacement.accountId && row.modelId === seeded.model);
  assert.ok(option?.resource, "Exact registered Reviewer fixture is unavailable");
  const preflight = await api("POST", "/project-interviews/preflight", { harness: "codex", model: "gpt-5.6-sol", effort: "low" });
  await api("PUT", "/portfolio-manager/config", {
    config: { harness: "codex", model: "gpt-5.6-sol", effort: "low", consentKey: preflight.isolation.consentKey },
  });
  await pressAny("AXButton", ["Open Head of PM", "Открыть Head of PM", "Открыть руководителя проектов"]);
  const field = await seek("Missing Head composer", n => ["AXTextArea", "AXTextField"].includes(n.AXRole ?? "")
    && labels(n).some(value => value.includes("Message to Head of PM") || value.includes("Сообщение Head of PM")));
  ax("focus-name", field.AXRole!, names(field).find(value => value.includes("Message to Head of PM") || value.includes("Сообщение Head of PM"))!);
  ax("text", `__fake_head_board__ ${JSON.stringify({
    kind: "replan_mission", missionId: seeded.mission.id, projectPath: seeded.projectPath, taskId: seeded.task.id, role: "reviewer",
    ...option.resource, reason: "Recorded reviewer resource blocker.",
  })}`);
  await Bun.sleep(300);
  const enabledSend = find(n => n.AXRole === "AXButton" && (exact(n, "Send") || exact(n, "Отправить")) && n.AXEnabled !== false);
  if (enabledSend.length) await pressAny("AXButton", ["Send", "Отправить"]);
  else await pressLabel(["Send", "Отправить"]);
  const proposal = await poll("Head did not save a durable resource proposal", async () => {
    const rows = await get(`${base}/resource-proposals`);
    return rows.proposals.find((row: { headMessageId: string | null; status: string }) => row.headMessageId && row.status === "pending") ?? null;
  }, 40_000);
  await showAny(["Mission resource replanning", "Перепланирование ресурсов миссии"]);
  await show("reviewer-fixture-dev");
  await show(option.resource.accountId);
  mark("Native Head showed the original run and the proposed replacement");
  const runsAtProposal = (await get("/tasks")) as Array<{ runId?: string | null }>;
  assert.equal(runsAtProposal.filter(task => task.runId).length, 1);
  await pressLabel(["Approve exact revision", "Одобрить точную версию"]);
  const revised = await poll("Owner approval did not revise the mission", async () => {
    const value = (await get(base)).mission;
    return value.revision === 2 ? value : null;
  });
  assert.equal(revised.plan.tasks[0].runId, "reviewer-fixture-dev");
  assert.equal(revised.plan.tasks[0].reviewerBinding.accountId, seeded.replacement.accountId);
  assert.equal(revised.status, "paused");
  await pressAny("AXButton", ["Missions", "Миссии"]);
  await showAny(["Mission resource replanning", "Перепланирование ресурсов миссии"]);
  mark("Native approval wrote revision 2, kept the mission paused, and preserved the original run");
  await stop();
  using stopped = new Database(join(data, "agetor.sqlite"), { readonly: true });
  assert.deepEqual(stopped.query("SELECT id, status FROM runs").all(), [{ id: "reviewer-fixture-dev", status: "succeeded" }]);
  assert.equal(stopped.query<{ preset: string }, []>("SELECT preset FROM router_v2_policies WHERE scope_id = 'global'").get()?.preset, "fastest");
  assert.equal(stopped.query<{ revision: number; status: string }, []>("SELECT revision, status FROM orchestration_missions").get()?.revision, 2);
  mark("Quit left Fastest saved, revision 2 paused, and the original run unchanged");
  await boot();
  await bind();
  await pressAny("AXButton", ["Settings", "Настройки"]);
  const routerName = entries(inspect().web).flatMap(labels).some(label => label.includes("AI-маршрутизатор")) ? "AI-маршрутизатор 2.0" : "AI Router 2.0";
  await press("AXButton", routerName);
  await show(routerName === "AI Router 2.0" ? "does not authorize execution" : "не разрешает исполнение");
  const policy = await fetch(`http://127.0.0.1:${apiPort}/api/router-v2/policy?scopeId=global`, { headers: { authorization: `Bearer ${creds.token}` } });
  const body = await policy.json() as { preset?: string };
  assert.equal(policy.status, 200);
  assert.equal(body.preset, "fastest");
  evidence.relaunchedPreset = body.preset;
  using relaunched = new Database(join(data, "agetor.sqlite"), { readonly: true });
  assert.equal(relaunched.query<{ revision: number }, []>("SELECT revision FROM orchestration_missions").get()?.revision, 2);
  assert.deepEqual(relaunched.query("SELECT id, status FROM runs").all(), [{ id: "reviewer-fixture-dev", status: "succeeded" }]);
  evidence.relaunchedRevision = 2;
  mark("Relaunch kept Fastest, revision 2, and the original run");
  await stop();
  const ownerAfter = Object.fromEntries(ownerPaths.map(p => [p, stamp(p)]));
  evidence.ownerUnchanged = JSON.stringify(ownerBefore) === JSON.stringify(ownerAfter);
  writeFileSync(join(root, "fo-router-complete02.json"), JSON.stringify(evidence, null, 2));
  console.log(JSON.stringify(evidence, null, 2));
} catch (error) {
  evidence.error = (error as Error).message;
  try { evidence.visible = [...new Set(entries(inspect().web).flatMap(labels))].slice(0, 200); } catch { /* window was not bound */ }
  writeFileSync(join(root, "fo-router-complete02.json"), JSON.stringify(evidence, null, 2));
  console.error(evidence.error);
  try { await stop(); } catch { /* already stopped */ }
  process.exit(1);
}
