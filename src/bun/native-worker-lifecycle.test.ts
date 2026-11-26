import { expect, test } from "bun:test";
import { execFileSync, spawnSync } from "node:child_process";
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { electrobunLifecycle, installLauncherLifecycle, patchLauncher, patchUtils, verifyLauncherLifecycle } from "../../scripts/electrobun-lifecycle.ts";
import { electrobunRpcSecurity } from "../../scripts/electrobun-rpc-security.ts";
import { acquireNativeInstanceLock } from "./native-instance-lock.ts";
import { NATIVE_QA_STUB } from "./native-qa-environment.ts";
import { coreCredsPath, readCoreCreds, writeCoreCreds } from "./core-creds.ts";

const repo = path.resolve(import.meta.dirname, "../..");
const sdk = path.join(repo, "node_modules/electrobun");
const root = realpathSync(mkdtempSync(path.join(tmpdir(), "fo-native004-fix01-")));
chmodSync(root, 0o700);
const macos = path.join(root, "Fixture.app/Contents/MacOS");
const resources = path.join(root, "Fixture.app/Contents/Resources");
const appCode = path.join(resources, "app/bun");
for (const dir of [macos, appCode, path.join(root, "evidence")]) mkdirSync(dir, { recursive: true });
// The actual SDK launcher executable has only libSystem linked. It execs this
// private copy of SDK Bun, loading Resources/main.js. No real native dylib.
for (const file of ["launcher", "bun"]) execFileSync("/bin/cp", ["-c", path.join(sdk, "dist-macos-arm64", file), path.join(macos, file)]);
const cSource = path.join(root, "native-fixture.c");
writeFileSync(cSource, `#include <unistd.h>
#include <stdio.h>
static volatile int stopped = 0;
void startEventLoop(const char *id, const char *name, const char *channel) {
  printf("SYNTHETIC_NATIVE_LOOP pid=%d\\n", getpid()); fflush(stdout);
  while (!stopped) usleep(10000);
}
void stopEventLoop(void) { stopped = 1; }
void waitForShutdownComplete(int ms) {}
void forceExit(int code) { _exit(code); }
`);
execFileSync("/usr/bin/clang", ["-dynamiclib", cSource, "-o", path.join(macos, "libNativeWrapper.dylib")]);
writeFileSync(path.join(resources, "version.json"), JSON.stringify({ identifier: "qa.forgeorbit.synthetic", name: "Fixture", channel: "dev" }));
const evidence: unknown[] = [];

function environment(data: string) {
  const home = path.join(data, "home"); mkdirSync(home, { recursive: true });
  const stub = path.join(root, "stub"); writeFileSync(stub, NATIVE_QA_STUB, { mode: 0o700 });
  const env: Record<string, string> = { HOME: home, PATH: "/usr/bin:/bin:/usr/sbin:/sbin", SHELL: "/bin/sh",
    TMPDIR: home, AGETOR_DATA_DIR: data, FORGEORBIT_DATA_DIR: data, AGETOR_API_PORT: "0", FORGEORBIT_API_PORT: "0",
    AGETOR_USAGE_OFFLINE: "1", AGETOR_DISABLE_UPDATES: "1" };
  for (const kind of ["CLAUDE", "CODEX", "CURSOR", "GEMINI", "FX", "ANTIGRAVITY"]) env[`AGETOR_${kind}_DRIVER`] = "fake";
  for (const kind of ["CLAUDE", "CODEX", "CURSOR", "GEMINI", "FX", "ANTIGRAVITY", "TMUX", "NOTIFIER", "DISCLAIM"]) env[`AGETOR_${kind}_BIN`] = stub;
  for (const key of ["CODEX_HOME", "CLAUDE_CONFIG_DIR", "CURSOR_CONFIG_DIR", "GEMINI_CLI_HOME", "XDG_CONFIG_HOME", "XDG_DATA_HOME", "XDG_STATE_HOME", "XDG_CACHE_HOME"]) env[key] = home;
  return env;
}

async function bundle(mode: string) {
  const entry = path.join(root, "entry.ts");
  const bootstrap = mode.startsWith("qa-") ? "native-qa-bootstrap.ts" : "native-bootstrap.ts";
  writeFileSync(entry, mode === "worker-startup-error" ? "throw new Error('synthetic Worker startup error');" : `await import(${JSON.stringify(path.join(repo, "src/bun", bootstrap))});`);
  const inert = `
    import { parentPort } from 'node:worker_threads';
    parentPort?.on('message', (message) => {
      if (message?.type !== 'fo-native004-release-settled') return;
      console.log('RELEASE_ACK');
      parentPort.postMessage({ type: 'fo-native004-released' });
    });
    import { writeCoreCreds } from ${JSON.stringify(path.join(repo, "src/bun/core-creds.ts"))};
    import { markNativeBackendReady, ownNativeCredentials } from ${JSON.stringify(path.join(repo, "src/bun/native-runtime-cleanup.ts"))};
    import { startApiServer } from ${JSON.stringify(path.join(repo, "src/bun/server.ts"))};
    import { rpcPort } from ${JSON.stringify(path.join(sdk, "dist/api/bun/core/Socket.ts"))};
    import { quit } from ${JSON.stringify(path.join(sdk, "dist/api/bun/core/Utils.ts"))};
    import { electrobunEventEmitter } from ${JSON.stringify(path.join(sdk, "dist/api/bun/events/eventEmitter.ts"))};
    const mode = ${JSON.stringify(mode)};
    if (mode === 'fallback') process.on('exit', () => console.log('FALLBACK_EXIT_CALLBACK'));
    if (mode === 'zero-refusal') process.exit(0);
    let api;
    try { api = startApiServer(); } catch { console.error('SYNTHETIC_API_BIND_REFUSED'); process.exit(1); }
    const token = 'synthetic-native004-token';
    ownNativeCredentials(process.env.FORGEORBIT_DATA_DIR!, token, () => api.stop(true));
    writeCoreCreds({port:api.port,token,pid:process.pid,kind:'app',version:'fixture',startedAt:Date.now()});
    markNativeBackendReady();
    console.log('READY ' + JSON.stringify({pid:process.pid,api:api.port,rpc:rpcPort}));
    if (mode === 'veto' || mode === 'fatal-veto') {
      let attempts = 0;
      electrobunEventEmitter.on('before-quit', event => { event.response = {allow: mode !== 'fatal-veto' && ++attempts > 1}; });
    }
    setTimeout(() => {
      if (mode === 'launcher-crash') return;
      if (mode === 'exception') throw new Error('synthetic backend exception');
      if (mode === 'rejection') { Promise.reject(new Error('synthetic rejection')); return; }
      if (mode === 'termination') { parentPort!.postMessage({type:'synthetic-terminate'}); return; }
      if (mode === 'backend-exit' || mode === 'fatal-veto') process.exit(23);
      if (mode === 'crash') { const {dlopen}=require('bun:ffi'); dlopen('/usr/lib/libSystem.B.dylib',{_exit:{args:['i32'],returns:'void'}}).symbols._exit(29); }
      quit();
      if (mode === 'veto') {
        if (!require('fs').existsSync(process.env.FORGEORBIT_DATA_DIR + '/agetor-core.json')) throw new Error('quit veto removed credentials');
        console.log('QUIT_VETO_PRESERVED');
        setTimeout(quit, 120);
      }
    }, 120);
  `;
  const built = await Bun.build({ entrypoints: [entry], target: "bun", outdir: appCode,
    naming: "index.js", define: { __FORGEORBIT_NATIVE_QA_ROOT__: JSON.stringify(root) },
    plugins: [electrobunRpcSecurity(), electrobunLifecycle(), { name: "synthetic-native-only", setup(build) {
      build.onResolve({ filter: /^\.\/index\.ts$/ }, args => args.importer.endsWith("native-bootstrap.ts") ? { path: "inert", namespace: "fixture" } : undefined);
      build.onLoad({ filter: /.*/, namespace: "fixture" }, () => ({ loader: "ts", contents: inert }));
      build.onResolve({ filter: /BrowserView(?:\.ts)?$/ }, () => ({ path: "view", namespace: "view" }));
      build.onLoad({ filter: /.*/, namespace: "view" }, () => ({ loader: "ts", contents: "export class BrowserView { static getById() {} }" }));
      build.onResolve({ filter: /proc\/native$/ }, () => ({ path: "native", namespace: "native" }));
      build.onLoad({ filter: /.*/, namespace: "native" }, () => ({ loader: "ts", contents: mode === "fallback" ? "export const ffi = {}; export const native = null;" : `
        import {dlopen} from 'bun:ffi';
        export const ffi = {};
        export const native = dlopen(${JSON.stringify(path.join(macos, "libNativeWrapper.dylib"))}, {
          stopEventLoop:{args:[],returns:'void'}, waitForShutdownComplete:{args:['i32'],returns:'void'}, forceExit:{args:['i32'],returns:'void'}
        });` }));
    } }] });
  expect(built.success, built.logs.join("\n")).toBe(true);
}

async function gone(pid: number, timeout = 3000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    try { process.kill(pid, 0); } catch { return true; }
    await Bun.sleep(20);
  }
  return false;
}
async function launch(mode: string, env: Record<string, string>, timeout = 8000) {
  // Only this newly spawned synthetic fixture can receive the timeout signal.
  // Upstream ignores SIGTERM, so its baseline hang requires SIGKILL.
  const result = spawnSync(path.join(macos, "launcher"), [], { cwd: macos, env, encoding: "utf8", timeout, killSignal: "SIGKILL" });
  // An upstream baseline parent can leave its Bun child alive. This PID came
  // from the private fixture launcher just spawned above, never a system scan.
  if (result.error) {
    const childPid = Number(result.stderr.match(/Child process spawned with PID (\d+)/)?.[1]);
    if (childPid > 0) {
      try { process.kill(childPid, "SIGKILL"); } catch { /* already gone */ }
      expect(await gone(childPid)).toBe(true);
    }
  }
  writeFileSync(path.join(root, "evidence", `${mode}.log`), result.stdout + result.stderr);
  return result;
}
function lockFree(data: string) {
  try { const release = acquireNativeInstanceLock(data); release(); return true; } catch { return false; }
}
function portFree(port: number) {
  try { const server = Bun.serve({ hostname: "127.0.0.1", port, reusePort: false, fetch: () => new Response() }); server.stop(true); return true; } catch { return false; }
}

test("native launcher source and Utils are version checked", () => {
  expect(() => patchLauncher(readFileSync(path.join(sdk, "dist/main.js"), "utf8") + "\n")).toThrow("unreviewed");
  expect(() => patchUtils(readFileSync(path.join(sdk, "dist/api/bun/core/Utils.ts"), "utf8") + "\n")).toThrow("unreviewed");
});

test("actual SDK launcher and Bun: failures exit while synthetic native main thread blocks; cleanup, refusal and restart", async () => {
  // Baseline: the unmodified SDK keeps the launcher alive after Worker refusal.
  copyFileSync(path.join(sdk, "dist/main.js"), path.join(resources, "main.js"));
  writeFileSync(path.join(appCode, "index.js"), "console.log('BASELINE_REFUSED'); process.exit(17);");
  const baseline = await launch("baseline", environment(path.join(root, "baseline")), 3000);
  expect(baseline.error?.message).toContain("ETIMEDOUT");
  expect(baseline.stdout).toContain("BASELINE_REFUSED");
  // The baseline cannot shut down normally after losing its Worker.
  const baselineBackendPid = Number(baseline.stderr.match(/Child process spawned with PID (\d+)/)?.[1]);
  expect(baselineBackendPid).toBeGreaterThan(0);
  for (const pid of [baseline.pid, baselineBackendPid]) expect(() => process.kill(pid, 0)).toThrow();
  evidence.push({ mode: "baseline", launcherPid: baseline.pid, backendPid: baselineBackendPid,
    bothPidsGoneAfterSyntheticTimeout: true, signal: baseline.signal, timeout: !!baseline.error });
  await installLauncherLifecycle(resources);
  verifyLauncherLifecycle(resources);
  // Simulate reparenting before supervision is installed. No backend may start.
  const mainFile = path.join(resources, "main.js");
  const originalMain = readFileSync(mainFile, "utf8");
  writeFileSync(mainFile, originalMain.replace('const launcherPid = process.ppid;', 'const launcherPid = 1;'));
  const earlyOrphan = await launch("early-parent-loss", environment(path.join(root, "early-parent-loss")));
  expect(earlyOrphan.status).toBe(1);
  expect(earlyOrphan.stdout).not.toContain("backend supervision active");
  evidence.push({mode:"early-parent-loss",status:earlyOrphan.status,backendStarted:false,mechanism:"fixture injects kernel-parent result 1 before supervisor creation"});
  writeFileSync(mainFile, originalMain);
  // Test-only trigger: terminate exactly the backend owned by this supervisor.
  const supervisor = path.join(resources, "forgeorbit-lifecycle.js");
  writeFileSync(supervisor, readFileSync(supervisor, "utf8").replace('backend.on("message", (message) => {', 'backend.on("message", (message) => { if (message?.type === "synthetic-terminate") { backend.terminate(); return; }'));
  for (const mode of ["qa-refusal", "worker-startup-error", "zero-refusal", "exception", "rejection", "termination", "api-bind", "lock-busy", "backend-exit", "fatal-veto", "crash", "normal", "veto", "restart"]) {
    const data = path.join(root, mode); const env = environment(data);
    await bundle(mode);
    let held: (() => void) | undefined;
    let blocker: ReturnType<typeof Bun.serve> | undefined;
    if (mode === "qa-refusal") delete env.AGETOR_CODEX_DRIVER;
    if (mode === "lock-busy") held = acquireNativeInstanceLock(data);
    if (mode === "api-bind") {
      blocker = Bun.serve({ hostname: "127.0.0.1", port: 0, reusePort: false, fetch: () => new Response("synthetic blocker") });
      env.AGETOR_API_PORT = env.FORGEORBIT_API_PORT = String(blocker.port);
    }
    if (mode === "api-bind" || mode === "lock-busy") writeCoreCreds({port:blocker?.port ?? 1,token:'synthetic-other-owner',pid:process.pid,kind:'app',version:'fixture',startedAt:Date.now()}, data);
    const result = await launch(mode, env);
    try {
      expect(result.error, result.stderr).toBeUndefined();
      expect(result.status, result.stdout + result.stderr).toBe(["normal", "veto", "restart"].includes(mode) ? 0 : ["backend-exit", "fatal-veto"].includes(mode) ? 23 : mode === "crash" ? 29 : 1);
      const backendPid = Number(result.stderr.match(/Child process spawned with PID (\d+)/)?.[1]);
      expect(backendPid).toBeGreaterThan(0);
      for (const pid of [result.pid, backendPid]) expect(() => process.kill(pid, 0)).toThrow();
      expect(result.stdout.match(/backend supervision active/g)).toHaveLength(1);
      const readyLine = result.stdout.split("\n").find(line => line.startsWith("READY "));
      const ready = readyLine ? JSON.parse(readyLine.slice(6)) : undefined;
      const rpcPort = Number(result.stdout.match(/Server started at http:\/\/127\.0\.0\.1:(\d+) FO-NATIVE003/)?.[1]) || null;
      if (rpcPort) expect(portFree(rpcPort)).toBe(true);
      let credentials = existsSync(coreCredsPath(data));
      // A process-wide _exit cannot execute JS cleanup; stale creds are detected
      // by liveness/auth checks and replaced by the next successful owner.
      expect(credentials).toBe(["crash", "api-bind", "lock-busy"].includes(mode));
      if (mode === "api-bind" || mode === "lock-busy") expect(readCoreCreds(data)?.token).toBe('synthetic-other-owner');
      if (mode === "veto") expect(result.stdout).toContain("QUIT_VETO_PRESERVED");
      expect(lockFree(data)).toBe(mode !== "lock-busy");
      if (ready) {
        expect(portFree(ready.api)).toBe(true); expect(portFree(ready.rpc)).toBe(true);
        expect(() => process.kill(ready.pid, 0)).toThrow();
      }
      if (mode === "qa-refusal" || mode === "lock-busy") expect(existsSync(path.join(data, "agetor.sqlite"))).toBe(false);
      if (blocker) expect(portFree(blocker.port!)).toBe(false);
      evidence.push({ mode, launcherPid: result.pid, backendPid, bothPidsGone: true, launcherStatus: result.status, launcherSignal: result.signal, ready, credentials,
        sqlite: existsSync(path.join(data, "agetor.sqlite")), lockFree: lockFree(data),
        apiFree: ready ? portFree(ready.api) : null, rpcPort, rpcFree: rpcPort ? portFree(rpcPort) : null,
        blockerPort: blocker?.port, blockerSurvived: blocker ? !portFree(blocker.port!) : null });
    } finally { held?.(); blocker?.stop(true); }
    // Reuse the exact failed/crashed data directory and API port for restart.
    if (!["normal", "veto", "restart"].includes(mode)) {
      // Repair the intentionally omitted QA value, using the same paths.
      env.AGETOR_CODEX_DRIVER = "fake";
      await bundle(mode === "qa-refusal" ? "qa-restart" : "restart");
      const restarted = await launch(mode + "-restart", env);
      expect(restarted.error).toBeUndefined(); expect(restarted.status, restarted.stderr).toBe(0);
      expect(restarted.stdout).toContain("READY "); expect(existsSync(coreCredsPath(data))).toBe(false);
      expect(lockFree(data)).toBe(true);
      evidence.push({ mode: mode + "-restart", status: restarted.status, lockFree: true, credentials: false });
    }
  }
  // Utils' non-native fallback must still emit exactly one real JS exit event.
  await bundle("fallback");
  const fallbackData = path.join(root, "fallback");
  const fallback = spawnSync(path.join(macos, "bun"), [path.join(appCode, "index.js")], { cwd: macos,
    env: environment(fallbackData), encoding: "utf8", timeout: 8000, killSignal: "SIGKILL" });
  expect(fallback.error).toBeUndefined(); expect(fallback.status, fallback.stderr).toBe(0);
  expect(fallback.stdout.match(/FALLBACK_EXIT_CALLBACK/g)).toHaveLength(1);
  expect(existsSync(coreCredsPath(fallbackData))).toBe(false); expect(lockFree(fallbackData)).toBe(true);
  writeFileSync(path.join(root, "evidence/fallback.log"), fallback.stdout + fallback.stderr);
  evidence.push({mode:"non-native-quit-fallback",status:fallback.status,exitHooks:1,credentials:false,lockFree:true});
  // Fault exactly our synthetic outer launcher after both listeners are live.
  // Supervisor observes reparenting and exits Bun without signalling anybody.
  const orphanData = path.join(root, "launcher-crash");
  await bundle("launcher-crash");
  const child = Bun.spawn([path.join(macos, "launcher")], { cwd: macos, env: environment(orphanData), stdout: "pipe", stderr: "pipe" });
  let stdout = "";
  const output = (async () => {
    const reader = child.stdout.getReader();
    for (;;) {
      const { value, done } = await reader.read();
      if (done) return;
      stdout += new TextDecoder().decode(value);
    }
  })();
  const errors = new Response(child.stderr).text();
  let backendPid = 0;
  try {
    const end = Date.now() + 5000;
    while (!stdout.includes("READY ") && Date.now() < end) await Bun.sleep(10);
    const ready = JSON.parse(stdout.split("\n").find(line => line.startsWith("READY "))!.slice(6));
    backendPid = ready.pid;
    expect(backendPid).not.toBe(child.pid);
    child.kill("SIGKILL");
    const launcherCode = await child.exited;
    expect(await gone(backendPid)).toBe(true);
    await output;
    const stderr = await errors;
    expect(stderr).toContain("native launcher owner exited");
    expect(stdout).toContain("RELEASE_ACK");
    expect(existsSync(coreCredsPath(orphanData))).toBe(false);
    expect(lockFree(orphanData)).toBe(true);
    expect(portFree(ready.api)).toBe(true); expect(portFree(ready.rpc)).toBe(true);
    writeFileSync(path.join(root, "evidence/launcher-crash.log"), stdout + stderr);
    evidence.push({mode:"launcher-crash",launcherPid:child.pid,backendPid,launcherCode,backendCode:"UNOBSERVABLE after parent death",bothPidsGone:true,
      api:ready.api,rpc:ready.rpc,apiFree:true,rpcFree:true,lockFree:true,credentials:false});
    await bundle("restart");
    const restarted = await launch("launcher-crash-restart", environment(orphanData));
    expect(restarted.status, restarted.stderr).toBe(0);
    expect(restarted.stdout).toContain("READY ");
    evidence.push({mode:"launcher-crash-restart",status:restarted.status,lockFree:lockFree(orphanData),credentials:existsSync(coreCredsPath(orphanData))});
  } finally {
    if (child.exitCode === null) child.kill("SIGKILL");
    if (backendPid > 0 && !await gone(backendPid, 100)) {
      try { process.kill(backendPid, "SIGKILL"); } catch { /* already gone */ }
    }
    await child.exited;
  }
  writeFileSync(path.join(root, "evidence/results.json"), JSON.stringify(evidence, null, 2));
  console.log("NATIVE004 synthetic evidence:", path.join(root, "evidence"));
}, 120000);
