/**
 * FO-ANALYTICS-COMPLETE01 packaged walkthrough.
 * Isolated ForgeOrbitQA only. Fake drivers and recorded fixtures. No inference.
 *
 * bun --no-env-file scripts/qa-analytics-complete01.ts seed <root> <taskId> <projectPath> <clusterId>
 * bun --no-env-file scripts/qa-analytics-complete01.ts <root>
 */
import { Database } from "bun:sqlite";
import { assertNativeQaEnvironment, NATIVE_QA_STUB } from "../src/bun/native-qa-environment.ts";
import assert from "node:assert/strict";
import { homedir } from "node:os";
import { existsSync, realpathSync, readFileSync, writeFileSync, openSync, closeSync, statSync } from "node:fs";
import { spawn, spawnSync } from "node:child_process";
import { join } from "node:path";

const repo = join(import.meta.dir, "..");
const mode = process.argv[2] === "seed" ? "seed" : "walk";
const root = realpathSync(mode === "seed" ? process.argv[3] ?? "" : process.argv[2] ?? "");
assert.match(root, /^\/private\/tmp\/fo-analytics-complete01-[A-Za-z0-9]+$/);

if (mode === "seed") {
  const taskId = process.argv[4] ?? "";
  const projectPath = process.argv[5] ?? "";
  const clusterId = process.argv[6] ?? "";
  process.env.FORGEORBIT_DATA_DIR = join(root, "runtime", "data");
  process.env.AGETOR_DATA_DIR = process.env.FORGEORBIT_DATA_DIR;
  process.env.HOME = join(root, "runtime", "home");
  const { db, projects, tasks } = await import("../src/bun/db.ts");
  const { AccountCore } = await import("../src/bun/account-core.ts");
  const { recordAdjustment } = await import("../src/bun/usage-analytics/adjustments.ts");
  db.exec("PRAGMA busy_timeout = 8000");
  const task = tasks.get(taskId);
  if (!task || task.workdir !== projectPath) throw new Error("Seed task is outside the disposable project");
  projects.upsert(projectPath, "Company fixture");
  const now = Date.now();
  db.run("INSERT INTO clusters(id,name,description,created_at,updated_at) VALUES (?,?,?,?,?)", [clusterId, "Company cluster", "", now, now]);
  db.run("INSERT INTO cluster_project_memberships(project_path,cluster_id,assigned_at,updated_at) VALUES (?,?,?,?)", [projectPath, clusterId, now, now]);
  const scope = JSON.stringify({ projectPath, clusterId, missionId: null, category: "task", technology: "TypeScript", complexity: null });
  const insert = (id: string, start: number, end: number, qc: string | null) => {
    db.run(`INSERT INTO runs(id,task_id,agent,status,started_at,ended_at,exit_code,qc_review_id,usage_scope) VALUES (?,?,?,'succeeded',?,?,0,?,?)`,
      [id, taskId, task.agent, start, end, qc, scope]);
  };
  insert("company-dev", now - 40_000, now - 30_000, null);
  insert("company-overlap", now - 36_000, now - 28_000, null);
  insert("company-review", now - 20_000, now - 17_000, "company-qc");
  db.run("INSERT INTO run_events(run_id,stream,data,ts) VALUES (?,'status',?,?)", ["company-dev", JSON.stringify({ kind: "execution-identity", executionType: "synthetic", provider: "codex", model: "fixture-model" }), now - 30_000]);
  db.run("INSERT INTO run_events(run_id,stream,data,ts) VALUES (?,'status',?,?)", ["company-overlap", JSON.stringify({ kind: "execution-identity", executionType: "synthetic", provider: "codex", model: "fixture-model" }), now - 28_000]);
  db.run("INSERT INTO run_events(run_id,stream,data,ts) VALUES (?,'status',?,?)", ["company-review", JSON.stringify({ kind: "execution-identity", executionType: "real-provider", provider: "codex", model: "fixture-model" }), now - 17_000]);
  db.run("INSERT INTO run_events(run_id,stream,data,ts) VALUES (?,'status',?,?)", ["company-review", "usage-accounting: " + JSON.stringify({ input: 20, output: 5, cacheRead: 2, cacheWrite: 1, billed: { amount: 1.25, currency: "EUR" } }), now - 17_000]);
  db.run(`INSERT INTO task_quality_reviews(id,task_id,project_path,round,status,verdict,reviewer_harness,reviewer_model,implementation_run_id,review_run_id,saved_task_json,requested_at,started_at,completed_at)
    VALUES ('company-qc',?,?,1,'completed','PASS',?,?, 'company-dev','company-review','{}',?,?,?)`,
    [taskId, projectPath, task.agent, task.model, now - 20_000, now - 20_000, now - 17_000]);
  tasks.update(taskId, { column: "done" });
  const core = new AccountCore(db);
  const account = core.createAccount({ provider: "openai", displayName: "Fixture quota account" });
  const pool = core.createDefinition({ accountId: account.id, scope: "group:shared-company", unit: { kind: "requests" }, window: "weekly" });
  const evidence = { provider: "openai", accountId: account.id, subject: "synthetic-company-subject", method: "provider-account" as const,
    sourceId: "synthetic-fixture", officialUrl: "https://example.invalid", checkedAt: "2026-11-11", receivedAt: now, limitations: "Synthetic fixture",
    sharedPool: { id: "shared-company", scope: "account", window: "weekly", verified: true as const } };
  core.recordTrustedObservations("synthetic-fixture", [{ quotaId: pool.id, values: { observedAt: now - 50_000, used: 10, remaining: 90, limit: 100, resetAt: now + 86_400_000, expiresAt: now + 86_400_000 }, evidence }]);
  core.recordTrustedObservations("synthetic-fixture", [{ quotaId: pool.id, values: { observedAt: now - 10_000, used: 25, remaining: 75, limit: 100, resetAt: now + 86_400_000, expiresAt: now + 86_400_000 }, evidence: { ...evidence, receivedAt: now - 10_000 } }]);
  recordAdjustment({ taskId, amount: 3, currency: "EUR", note: "Owner-reported fixture adjustment" });
  const leaked = db.query<{ env_json: string }, []>("SELECT env_json FROM harnesses").all().some(row => Object.keys(JSON.parse(row.env_json)).length > 0);
  if (leaked) throw new Error("Seed wrote a harness environment override");
  console.log(JSON.stringify({ accountId: account.id, quotaId: pool.id }));
  process.exit(0);
}

const consoleLocked = () => /"IOConsoleLocked" = Yes/.test(spawnSync("/usr/sbin/ioreg", ["-n", "Root", "-d1"], { encoding: "utf8" }).stdout ?? "");
if (consoleLocked()) {
  console.error("STOP: macOS console is locked. No native interaction.");
  process.exit(2);
}
const runtime = join(root, "runtime");
const data = join(runtime, "data");
const home = join(runtime, "home");
const tmp = join(runtime, "tmp");
const projectDir = join(runtime, "CompanyFixture");
const app = join(root, "ForgeOrbitQA-dev.app");
assert.equal(realpathSync(app), app);
const resume = process.argv.includes("--resume");
if (!resume) assert.equal(existsSync(data), false, "Refusing to reuse a QA profile");
for (const dir of [data, home, tmp, projectDir]) spawnSync("/bin/mkdir", ["-p", "-m", "700", dir]);
writeFileSync(join(projectDir, "package.json"), "{}\n");
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
const api = async (method: string, route: string, body?: unknown) => {
  const res = await fetch(`http://127.0.0.1:${apiPort}${route}`, {
    method, headers: { authorization: `Bearer ${creds.token}`, "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(20_000),
  });
  const raw = await res.text();
  assert.equal(res.status, 200, `${method} ${route} ${res.status} ${raw.slice(0, 400)}`);
  return raw ? JSON.parse(raw) : null;
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
const show = (part: string, alt = part) => seek(`WKWebView did not render "${part}"`, node => labels(node).some(label => label.includes(part) || label.includes(alt)));
const textOf = () => entries(inspect().web).flatMap(labels).join("\n");
const exact = (node: AxNode, name: string) => names(node).some(value => value === name);
const activate = (node: AxNode, name: string) => {
  if (!node.frame) { ax("press", node.AXRole!, name); return; }
  const x = String(Math.round(node.frame.x + node.frame.width / 2));
  const y = String(Math.round(node.frame.y + node.frame.height / 2));
  try { ax("press", node.AXRole!, name, x, y); } catch { ax("click", x, y); }
};
const press = async (role: string, name: string, alt = name) => {
  const node = await seek(`Missing ${role} "${name}"`, n => n.AXRole === role && (exact(n, name) || exact(n, alt)) && n.AXEnabled !== false);
  const chosen = exact(node, name) ? name : alt;
  if (role === "AXCheckBox" && (node.AXValue === 1 || node.AXValue === true)) return;
  activate(node, chosen);
  await Bun.sleep(350);
};
const evidence: Record<string, unknown> = { bundle: "app.forgeorbit.qa", synthetic: true, steps: [] as string[] };
const mark = (step: string) => { (evidence.steps as string[]).push(step); writeFileSync(join(root, "fo-analytics-complete01.json"), JSON.stringify(evidence, null, 2)); console.log(step); };

try {
  let taskId = "";
  let projectPath = projectDir;
  if (!resume) {
    await boot();
    await bind();
    const skip = find(n => n.AXRole === "AXButton" && exact(n, "Skip")).at(-1);
    if (skip) activate(skip, "Skip");
    const registered = await api("POST", "/projects", { path: projectDir, name: "Company fixture" });
    const created = await api("POST", "/tasks", {
      title: "Company native task", prompt: "Private acceptance criteria must stay out of the export.",
      workdir: registered.path, isolation: "none", agent: "codex", model: "fixture-model", mode: "auto",
    });
    taskId = created.id;
    projectPath = registered.path;
    await stop();
    const seeded = JSON.parse(sh([process.execPath, "--no-env-file", join(repo, "scripts/qa-analytics-complete01.ts"), "seed", root, taskId, projectPath, "company-cluster"], 60_000));
    evidence.seed = seeded;
  } else {
    using existing = new Database(join(data, "agetor.sqlite"), { readonly: true });
    taskId = existing.query<{ id: string }, []>("SELECT id FROM tasks WHERE title = 'Company native task'").get()?.id ?? "";
    projectPath = existing.query<{ workdir: string }, []>("SELECT workdir FROM tasks WHERE id = ?").get(taskId)?.workdir ?? projectDir;
  }
  evidence.taskId = taskId;
  await boot();
  await bind();
  evidence.initialLocale = textOf().includes("Аналитика") ? "ru" : "en";
  await press("AXButton", "Analytics", "Аналитика");
  await press("AXCheckBox", "Analytics", "Аналитика");
  await show("Last 7 days", "Последние 7 дней");
  await press("AXButton", "Last 7 days", "Последние 7 дней");
  await show("Tasks created", "Создано задач");
  await show("P85");
  for (const [en, ru] of [["Project", "Проект"], ["Cluster", "Кластер"], ["Provider", "Провайдер"], ["Model", "Модель"], ["Account", "Аккаунт"]] as const) await show(en, ru);
  const popup = find(n => n.AXRole === "AXPopUpButton" && labels(n).some(label => ["Company fixture", "All", "Все"].includes(label))).at(-1);
  if (popup) {
    try { ax("set-value", "AXPopUpButton", names(popup)[0] ?? "All", "Company fixture"); evidence.projectFilter = "set"; }
    catch (error) { evidence.projectFilter = (error as Error).message; }
  }
  await press("AXButton", "Apply filters", "Применить фильтры");
  await show("Company native task");
  mark("Native Analytics showed the filtered company task");
  await press("AXCheckBox", "Time", "Время");
  await show("Developer time", "Время разработчика");
  await show("Cumulative agent time", "Суммарное время агентов");
  await show("Sum of active wall time", "Сумма активного астрономического времени");
  await press("AXCheckBox", "Costs", "Затраты");
  await show("Unknown", "Неизвестно");
  await show("Provider-reported API charge", "Начисление API по данным провайдера");
  await press("AXCheckBox", "Resources", "Ресурсы");
  await show("Per-task subscription quota consumption: Unknown", "Расход квоты подписки по задаче: неизвестен");
  await show("Unattributed", "Неотнесённое");
  await press("AXCheckBox", "Performance", "Результативность");
  await show("Employee effectiveness", "Результативность сотрудников");
  await show("Synthetic runs are excluded from comparison.", "Синтетические запуски исключены из сравнения.");
  await show("Insufficient data", "Недостаточно данных");
  await press("AXButton", "Company native task");
  await show("Created to Done", "От создания до завершения");
  await show("Active wall-clock time", "Время активной работы без пересечений");
  await show("Reviewer time", "Время ревьюера");
  await show("Owner-reported adjustment", "Корректировка, указанная владельцем");
  mark("Native task drill-down showed time, cost and quota evidence");
  await press("AXButton", "Close", "Закрыть");
  await press("AXButton", "Export tasks CSV", "Экспорт задач CSV");
  await show("Export downloaded", "Экспорт загружен");
  const exported = await fetch(`http://127.0.0.1:${apiPort}/api/usage-analytics/export?format=csv&report=tasks&projectPath=${encodeURIComponent(projectPath)}&timeZone=UTC&grain=day`, {
    headers: { authorization: `Bearer ${creds.token}` },
  });
  const csv = await exported.text();
  assert.equal(exported.status, 200);
  assert.match(csv, /Company native task/);
  assert.doesNotMatch(csv, /Private acceptance criteria/);
  assert.match(csv, /unknown=Unknown/);
  evidence.exportBytes = csv.length;
  const beforeToggle = textOf().includes("Аналитика") ? "ru" : "en";
  ax("focus");
  ax("key", "37", String(524288 + 131072));
  await Bun.sleep(700);
  const afterToggle = textOf().includes("Аналитика") ? "ru" : textOf().includes("Analytics") ? "en" : beforeToggle;
  evidence.localeAfterToggle = afterToggle;
  evidence.localeToggled = afterToggle !== beforeToggle;
  if (evidence.localeToggled) await show("Overview", "Обзор");
  mark(evidence.localeToggled ? "Native shortcut switched the visible language" : "Native shortcut did not switch the visible labels");
  await stop();
  using stopped = new Database(join(data, "agetor.sqlite"), { readonly: true });
  assert.equal(stopped.query<{ n: number }, []>("SELECT COUNT(*) AS n FROM runs").get()?.n, 3);
  assert.equal(stopped.query<{ amount: number }, []>("SELECT amount FROM usage_cost_adjustments").get()?.amount, 3);
  const overrides = stopped.query<{ env_json: string }, []>("SELECT env_json FROM harnesses").all();
  assert.equal(overrides.some(row => Object.keys(JSON.parse(row.env_json)).length > 0), false);
  mark("Quit left the fixture runs and Owner adjustment in the disposable database");
  await boot();
  await bind();
  const relaunch = textOf().includes("Аналитика") ? "Аналитика" : "Analytics";
  await press("AXButton", relaunch);
  await press("AXCheckBox", relaunch);
  await show("Company native task");
  const report = await api("GET", `/api/usage-analytics/analytics?taskId=${taskId}`);
  assert.equal(report.tasks[0].title, "Company native task");
  assert.equal(report.company.quota.perTaskSubscription, "unknown");
  mark("Relaunch showed the same task and Unknown per-task quota");
  await stop();
  const ownerAfter = Object.fromEntries(ownerPaths.map(p => [p, stamp(p)]));
  evidence.ownerUnchanged = JSON.stringify(ownerBefore) === JSON.stringify(ownerAfter);
  evidence.ownerPaths = { before: ownerBefore, after: ownerAfter };
  writeFileSync(join(root, "fo-analytics-complete01.json"), JSON.stringify(evidence, null, 2));
  console.log(JSON.stringify(evidence, null, 2));
} catch (error) {
  evidence.error = (error as Error).message;
  writeFileSync(join(root, "fo-analytics-complete01.json"), JSON.stringify(evidence, null, 2));
  console.error((error as Error).stack ?? (error as Error).message);
  try { await stop(); } catch { /* the app may already be gone */ }
  process.exit(1);
}
