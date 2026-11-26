/**
 * FO-ROUTER-COMPLETE01 packaged Owner walk.
 * Isolated ForgeOrbitQA only. No inference and no provider requests.
 *
 * FORGEORBIT_QA_OUTPUT_ROOT=<root> bun --no-env-file scripts/build-qa-native.ts
 * bun --no-env-file scripts/qa-router-complete01.ts <root>
 */
import { Database } from "bun:sqlite";
import { assertNativeQaEnvironment, NATIVE_QA_STUB } from "../src/bun/native-qa-environment.ts";
import assert from "node:assert/strict";
import { homedir } from "node:os";
import { existsSync, realpathSync, readFileSync, writeFileSync, openSync, closeSync, statSync } from "node:fs";
import { spawn, spawnSync } from "node:child_process";
import { join } from "node:path";

const repo = join(import.meta.dir, "..");
const root = realpathSync(process.argv[2] ?? "");
assert.match(root, /^\/private\/tmp\/fo-router-complete01-[A-Za-z0-9]+$/);
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
const evidence: Record<string, unknown> = { bundle: "app.forgeorbit.qa", synthetic: true, inference: false, steps: [] as string[] };
const mark = (step: string) => { (evidence.steps as string[]).push(step); writeFileSync(join(root, "fo-router-complete01.json"), JSON.stringify(evidence, null, 2)); console.log(step); };

try {
  await boot();
  await bind();
  const skip = find(n => n.AXRole === "AXButton" && exact(n, "Skip")).at(-1);
  if (skip) activate(skip, "Skip");
  await press("AXButton", "Settings");
  await press("AXButton", "AI Router 2.0");
  await show("does not authorize execution");
  await show("not measured benchmark");
  await press("AXButton", "Quota Saver");
  await press("AXButton", "Save Policy");
  await show("Policy saved successfully.");
  mark("Native AI Router showed the recommendation boundary and saved Quota Saver");
  await press("AXButton", "General");
  const language = find(n => n.AXRole === "AXPopUpButton" && labels(n).some(label => label === "English" || label === "Русский")).at(-1);
  if (language) {
    try { ax("set-value", "AXPopUpButton", names(language)[0] ?? "English", "Русский"); }
    catch (error) { evidence.languageControl = (error as Error).message; }
  } else evidence.languageControl = "Language popup was not exposed";
  await Bun.sleep(500);
  const routerRu = find(n => n.AXRole === "AXButton" && exact(n, "AI-маршрутизатор 2.0")).at(-1);
  if (routerRu) {
    activate(routerRu, "AI-маршрутизатор 2.0");
    await Bun.sleep(400);
    await show("не разрешает исполнение");
    evidence.russianVisible = true;
  } else evidence.russianVisible = false;
  mark(evidence.russianVisible ? "Native Settings switched the Router copy to Russian" : "Native language control did not expose Russian Router copy");
  await stop();
  using stopped = new Database(join(data, "agetor.sqlite"), { readonly: true });
  assert.equal(stopped.query<{ n: number }, []>("SELECT COUNT(*) AS n FROM runs").get()?.n, 0);
  assert.equal(stopped.query<{ preset: string }, []>("SELECT preset FROM router_v2_policies WHERE scope_id = 'global'").get()?.preset, "quota-saver");
  mark("Quit left Quota Saver saved and created no runs");
  await boot();
  await bind();
  await press("AXButton", "Settings");
  const routerName = entries(inspect().web).flatMap(labels).some(label => label.includes("AI-маршрутизатор")) ? "AI-маршрутизатор 2.0" : "AI Router 2.0";
  await press("AXButton", routerName);
  await show(routerName === "AI Router 2.0" ? "does not authorize execution" : "не разрешает исполнение");
  const policy = await fetch(`http://127.0.0.1:${apiPort}/api/router-v2/policy?scopeId=global`, { headers: { authorization: `Bearer ${creds.token}` } });
  const body = await policy.json() as { preset?: string };
  assert.equal(policy.status, 200);
  assert.equal(body.preset, "quota-saver");
  evidence.relaunchedPreset = body.preset;
  mark("Relaunch kept the saved policy and showed the recommendation boundary");
  await stop();
  const ownerAfter = Object.fromEntries(ownerPaths.map(p => [p, stamp(p)]));
  evidence.ownerUnchanged = JSON.stringify(ownerBefore) === JSON.stringify(ownerAfter);
  writeFileSync(join(root, "fo-router-complete01.json"), JSON.stringify(evidence, null, 2));
  console.log(JSON.stringify(evidence, null, 2));
} catch (error) {
  evidence.error = (error as Error).message;
  writeFileSync(join(root, "fo-router-complete01.json"), JSON.stringify(evidence, null, 2));
  console.error(evidence.error);
  try { await stop(); } catch { /* already stopped */ }
  process.exit(1);
}
