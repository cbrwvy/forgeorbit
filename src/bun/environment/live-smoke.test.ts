/**
 * Live smoke for FO-004B. Spawns a temporary headless core and a loopback
 * Bun HTTP fixture. Does not import the application database, does not use
 * ~/.agetor or ~/.agetor-dev, and does not call Docker.
 */

import { expect, test } from "bun:test";
import { type ChildProcess, spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { statSync, type Stats } from "node:fs";
import { copyFile, mkdtemp, readFile, rm } from "node:fs/promises";
import { createServer } from "node:net";
import { homedir, tmpdir } from "node:os";
import path from "node:path";
import { Database } from "bun:sqlite";

import { LogBuffer } from "./logs.ts";

const REPO_ROOT = path.resolve(import.meta.dir, "../../..");
const HOME = homedir();
const USER_DBS = [path.join(HOME, ".agetor", "agetor.sqlite"), path.join(HOME, ".agetor-dev", "agetor.sqlite")];

test("the log buffer drops old text instead of growing", () => {
  const buffer = new LogBuffer(64);
  for (let i = 0; i < 40; i++) buffer.append("stdout", "0123456789", i);
  const text = buffer.snapshot().map((line) => line.text).join("");
  expect(text.length).toBeLessThanOrEqual(64);
});

test(
  "a real loopback process starts, recovers, and stops only when ownership is proven",
  async () => {
    const before = stampUserDbs();
    const dataDir = path.resolve(await mkdtemp(path.join(tmpdir(), "fo-live-data-")));
    const projectDir = path.resolve(await mkdtemp(path.join(tmpdir(), "fo-live-proj-")));
    assertIsolated(dataDir);
    assertIsolated(projectDir);

    const servicePort = await freePort();
    const apiPort = await freePort();
    const token = randomBytes(16).toString("hex");
    await copyFile(path.join(import.meta.dir, "smoke-server.ts"), path.join(projectDir, "smoke-server.ts"));
    await Bun.write(path.join(projectDir, "compose.yaml"), "services:\n  web:\n    image: example.invalid/fo-smoke:none\n");

    const core = new Core(dataDir, apiPort, token);
    let ownedPid: number | null = null;
    try {
      await core.start();
      expect(statSync(path.join(dataDir, "agetor.sqlite")).isFile()).toBe(true);

      await core.api("POST", "/projects", { path: projectDir, name: "Live Smoke" });
      const profile = smokeProfile(projectDir, servicePort);
      const created = await core.api("POST", "/projects/environment", { path: projectDir, profile });
      expect(created.status).toBe(200);
      expect(await serviceUp(servicePort)).toBe(false);

      const started = await core.api("POST", `/projects/environment/smoke/start?path=${encodeURIComponent(projectDir)}`);
      expect(started.status, JSON.stringify(started.body)).toBe(200);
      const first = statusOf(started.body);
      expect(first.recordedPhase).toBe("running");
      expect(first.ownership).toBe("session");
      expect(first.health.some((check) => check.ok && check.detail.includes("200"))).toBe(true);
      ownedPid = first.pid;
      expect(ownedPid).toBeGreaterThan(1);
      expect(await serviceUp(servicePort)).toBe(true);

      const secret = ownershipToken(dataDir);
      const listed = await core.api("GET", `/projects/environment?path=${encodeURIComponent(projectDir)}`);
      expect(JSON.stringify(listed.body)).not.toContain(secret);
      const logs = await core.api("GET", `/projects/environment/smoke/logs?path=${encodeURIComponent(projectDir)}`);
      const transcript = JSON.stringify(logs.body);
      expect(transcript).toContain("fo-smoke-ready");
      expect(transcript).not.toContain(secret);
      expect(await readSse(apiPort, token)).not.toContain(secret);
      expect(countCommand(path.join(projectDir, "smoke-server.ts"))).toBe(1);

      const again = await core.api("POST", `/projects/environment/smoke/start?path=${encodeURIComponent(projectDir)}`);
      expect(again.status).toBe(200);
      expect(statusOf(again.body).pid).toBe(ownedPid);
      expect(countCommand(path.join(projectDir, "smoke-server.ts"))).toBe(1);

      const restarted = await core.api("POST", `/projects/environment/smoke/restart?path=${encodeURIComponent(projectDir)}`);
      expect(restarted.status, JSON.stringify(restarted.body)).toBe(200);
      const secondPid = statusOf(restarted.body).pid;
      expect(secondPid).not.toBe(ownedPid);
      expect(processExists(ownedPid)).toBe(false);
      expect(await serviceUp(servicePort)).toBe(true);
      expect(countCommand(path.join(projectDir, "smoke-server.ts"))).toBe(1);
      ownedPid = secondPid;

      const quit = await fetch(`http://127.0.0.1:${servicePort}/quit`);
      expect(quit.status).toBe(200);
      await waitFor(async () => !(await serviceUp(servicePort)), "service to exit on its own");
      const afterExit = await core.api("GET", `/projects/environment?path=${encodeURIComponent(projectDir)}`);
      const exited = (afterExit.body as IndexBody).profiles[0]?.status;
      expect(exited?.recordedPhase === "error" || exited?.recordedPhase === "stopped").toBe(true);
      const stopped = await core.api("POST", `/projects/environment/smoke/stop?path=${encodeURIComponent(projectDir)}`);
      expect(stopped.status, JSON.stringify(stopped.body)).toBe(200);
      expect(processExists(ownedPid)).toBe(false);
      ownedPid = null;

      const relaunched = await core.api("POST", `/projects/environment/smoke/start?path=${encodeURIComponent(projectDir)}`);
      expect(relaunched.status, JSON.stringify(relaunched.body)).toBe(200);
      ownedPid = statusOf(relaunched.body).pid;
      expect(await serviceUp(servicePort)).toBe(true);
      const survived = requirePid(ownedPid);

      await core.stop();
      expect(await serviceUp(servicePort)).toBe(true);
      expect(processExists(survived)).toBe(true);

      await core.start();
      const recovered = await core.api("GET", `/projects/environment?path=${encodeURIComponent(projectDir)}`);
      const recoveredStatus = (recovered.body as IndexBody).profiles[0]?.status;
      expect(recoveredStatus?.recordedPhase).toBe("running");
      expect(recoveredStatus?.ownership).toBe("prior-forgeorbit");
      expect(recoveredStatus?.pid).toBe(survived);
      expect(JSON.stringify(recovered.body)).not.toContain(ownershipToken(dataDir));

      await core.stop();
      expect(await serviceUp(servicePort)).toBe(true);
      rewritePid(dataDir, 1);
      await core.start();
      const foreignStop = await core.api("POST", `/projects/environment/smoke/stop?path=${encodeURIComponent(projectDir)}`);
      expect(foreignStop.status).toBe(409);
      const foreignCode = (foreignStop.body as { code?: string }).code;
      expect(foreignCode === "unverified-ownership" || foreignCode === "foreign-process").toBe(true);
      expect(processExists(1)).toBe(true);
      expect(processExists(survived)).toBe(true);
      expect(await serviceUp(servicePort)).toBe(true);
      expect(JSON.stringify(foreignStop.body)).not.toContain(ownershipToken(dataDir));

      await core.stop();
      rewritePid(dataDir, survived);
      signalOwnedGroup(survived);
      ownedPid = null;
      await waitFor(async () => !(await serviceUp(servicePort)), "owned service to exit after the test stopped it");
      await core.start();
      const dead = await core.api("GET", `/projects/environment?path=${encodeURIComponent(projectDir)}`);
      const deadStatus = (dead.body as IndexBody).profiles[0]?.status;
      expect(deadStatus?.recordedPhase).toBe("stopped");
      expect(deadStatus?.pid).toBeNull();
      expect((dead.body as IndexBody).profiles[0]?.profile.name).toBe("Smoke");
      expect(await serviceUp(servicePort)).toBe(false);
    } finally {
      await core.stop().catch(() => {});
      if (ownedPid && ownedPid > 1 && (processExists(ownedPid) || (await serviceUp(servicePort)))) {
        signalOwnedGroup(ownedPid);
      }
      await rm(dataDir, { recursive: true, force: true });
      await rm(projectDir, { recursive: true, force: true });
      const after = stampUserDbs();
      expect(after, "user SQLite changed during the live smoke").toEqual(before);
    }
  },
  120_000,
);

interface StatusBody {
  recordedPhase: string;
  ownership: string;
  pid: number | null;
  health: { ok: boolean; detail: string }[];
}

interface IndexBody {
  profiles: { profile: { name: string }; status: StatusBody }[];
}

interface ApiResult {
  status: number;
  body: unknown;
}

class Core {
  private child: ChildProcess | null = null;
  private log = "";

  constructor(
    private readonly dataDir: string,
    private readonly apiPort: number,
    private readonly token: string,
  ) {}

  async start(): Promise<void> {
    await this.stop();
    const fxBin = await writeFxStub(this.dataDir);
    this.log = "";
    this.child = spawn("bun", ["src/bun/headless.ts"], {
      cwd: REPO_ROOT,
      env: {
        ...process.env,
        AGETOR_DATA_DIR: this.dataDir,
        AGETOR_API_PORT: String(this.apiPort),
        AGETOR_API_TOKEN: this.token,
        AGETOR_API_HOST: "127.0.0.1",
        AGETOR_DAEMON_IDLE_MS: "600000",
        AGETOR_CLAUDE_DRIVER: "fake",
        AGETOR_CLAUDE_BIN: "/bin/echo",
        AGETOR_TMUX_BIN: "/bin/echo",
        AGETOR_CLAUDE_ARGS: "",
        AGETOR_FX_DRIVER: "fake",
        AGETOR_FX_BIN: fxBin,
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    const append = (chunk: unknown) => {
      this.log += String(chunk);
      if (this.log.length > 80_000) this.log = this.log.slice(-40_000);
    };
    this.child.stdout?.on("data", append);
    this.child.stderr?.on("data", append);
    const deadline = Date.now() + 30_000;
    let last = "";
    while (Date.now() < deadline) {
      if (this.child.exitCode !== null) break;
      try {
        const res = await fetch(`http://127.0.0.1:${this.apiPort}/health`);
        if (res.ok) return;
        last = `HTTP ${res.status}`;
      } catch (error) {
        last = error instanceof Error ? error.message : String(error);
      }
      await Bun.sleep(200);
    }
    throw new Error(
      `headless core did not become healthy (${last})\n${this.log.slice(-2000)}\n${await tail(path.join(this.dataDir, "daemon.log"))}`,
    );
  }

  async stop(): Promise<void> {
    const child = this.child;
    this.child = null;
    if (!child || child.pid === undefined) return;
    if (child.exitCode !== null || child.signalCode !== null) return;
    child.kill("SIGTERM");
    const exited = new Promise<void>((resolve) => {
      child.once("exit", () => resolve());
    });
    const done = await Promise.race([exited.then(() => true), Bun.sleep(8_000).then(() => false)]);
    if (!done) child.kill("SIGKILL");
    await Promise.race([exited, Bun.sleep(2_000)]);
  }

  async api(method: string, pathname: string, body?: unknown): Promise<ApiResult> {
    const res = await fetch(`http://127.0.0.1:${this.apiPort}${pathname}`, {
      method,
      headers: {
        authorization: `Bearer ${this.token}`,
        ...(body === undefined ? {} : { "content-type": "application/json" }),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await res.text();
    let parsed: unknown = text;
    try {
      parsed = JSON.parse(text);
    } catch {
      /* keep the text */
    }
    return { status: res.status, body: parsed };
  }
}

function smokeProfile(projectDir: string, port: number): Record<string, unknown> {
  const url = `http://127.0.0.1:${port}/health`;
  return {
    id: "smoke",
    projectPath: projectDir,
    name: "Smoke",
    cwd: projectDir,
    launch: {
      kind: "local-process",
      command: { executable: process.execPath, args: [path.join(projectDir, "smoke-server.ts"), String(port)] },
    },
    stop: { kind: "signal", signal: "SIGTERM", graceMs: 4_000, killAfterGrace: true, processGroup: true },
    expectedPorts: [],
    healthChecks: [{
      id: "web",
      kind: "http",
      url,
      method: "GET",
      acceptedStatuses: [200],
      timeoutMs: 1_000,
      intervalMs: 200,
      maxAttempts: 20,
      required: true,
    }],
    urls: [{ id: "site", name: "Website", role: "website", url, healthCheckId: "web", optional: false }],
    startupTimeoutMs: 20_000,
    shutdownTimeoutMs: 8_000,
    env: [],
  };
}

function statusOf(body: unknown): StatusBody {
  const status = (body as { status?: StatusBody }).status;
  if (!status) throw new Error(`missing status in ${JSON.stringify(body)}`);
  return status;
}

function ownershipToken(dataDir: string): string {
  const database = new Database(path.join(dataDir, "agetor.sqlite"), { readonly: true });
  try {
    const row = database.query<{ data: string }, []>("SELECT data FROM environment_profiles WHERE id = 'smoke'").get();
    const token = row?.data.match(/"token":"([a-f0-9]{32})"/)?.[1];
    if (!token) throw new Error("ownership token was not stored for recovery");
    return token;
  } finally {
    database.close();
  }
}

function rewritePid(dataDir: string, pid: number): void {
  const database = new Database(path.join(dataDir, "agetor.sqlite"));
  try {
    const row = database.query<{ data: string }, []>("SELECT data FROM environment_profiles WHERE id = 'smoke'").get();
    if (!row) throw new Error("profile row missing");
    const stored = JSON.parse(row.data) as { runtime: { ownership: { pid: number } } };
    stored.runtime.ownership.pid = pid;
    database.run("UPDATE environment_profiles SET data = ? WHERE id = 'smoke'", [JSON.stringify(stored)]);
  } finally {
    database.close();
  }
}

function assertIsolated(dir: string): void {
  const resolved = path.resolve(dir);
  for (const banned of [path.join(HOME, ".agetor"), path.join(HOME, ".agetor-dev")]) {
    if (resolved === banned || resolved.startsWith(banned + path.sep)) {
      throw new Error(`refusing to use user data directory ${resolved}`);
    }
  }
  const temp = path.resolve(tmpdir());
  if (!resolved.startsWith(temp + path.sep)) {
    throw new Error(`${resolved} is outside the temp directory; live smoke stopped`);
  }
}

function stampUserDbs(): Record<string, { mtimeMs: number; size: number } | null> {
  const stamp: Record<string, { mtimeMs: number; size: number } | null> = {};
  for (const file of USER_DBS) stamp[file] = fileStamp(file);
  return stamp;
}

function fileStamp(file: string): { mtimeMs: number; size: number } | null {
  let info: Stats;
  try {
    info = statSync(file);
  } catch {
    return null;
  }
  return { mtimeMs: info.mtimeMs, size: info.size };
}

async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.on("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        reject(new Error("no port"));
        return;
      }
      server.close(() => resolve(address.port));
    });
  });
}

async function serviceUp(port: number): Promise<boolean> {
  try {
    const res = await fetch(`http://127.0.0.1:${port}/health`, { signal: AbortSignal.timeout(500) });
    return res.status === 200;
  } catch {
    return false;
  }
}

async function waitFor(ready: () => Promise<boolean>, label: string): Promise<void> {
  const deadline = Date.now() + 8_000;
  while (Date.now() < deadline) {
    if (await ready()) return;
    await Bun.sleep(100);
  }
  throw new Error(`timed out waiting for ${label}`);
}

function processExists(pid: number | null): boolean {
  if (pid === null || !Number.isInteger(pid) || pid <= 0) return false;
  const result = Bun.spawnSync(["/bin/ps", "-p", String(pid)]);
  return result.exitCode === 0;
}

function requirePid(pid: number | null): number {
  if (pid === null || !Number.isInteger(pid) || pid <= 1) throw new Error(`expected an owned pid, got ${String(pid)}`);
  return pid;
}

function countCommand(scriptPath: string): number {
  const result = Bun.spawnSync(["/bin/ps", "-ax", "-o", "command="]);
  const text = new TextDecoder().decode(result.stdout);
  return text.split("\n").filter((line) => line.includes(scriptPath) && !line.includes("/usr/bin/perl")).length;
}

function signalOwnedGroup(pid: number): void {
  if (!Number.isInteger(pid) || pid <= 1) return;
  try {
    process.kill(-pid, "SIGTERM");
  } catch {
    try {
      process.kill(pid, "SIGTERM");
    } catch {
      /* already gone */
    }
  }
}

async function readSse(apiPort: number, token: string): Promise<string> {
  const res = await fetch(`http://127.0.0.1:${apiPort}/app/events?token=${encodeURIComponent(token)}`);
  const reader = res.body?.getReader();
  if (!reader) return "";
  const decoder = new TextDecoder();
  let text = "";
  const deadline = Date.now() + 600;
  while (Date.now() < deadline) {
    const next = await Promise.race([
      reader.read(),
      Bun.sleep(200).then(() => null),
    ]);
    if (!next) continue;
    if (next.done) break;
    text += decoder.decode(next.value);
  }
  await reader.cancel().catch(() => {});
  return text;
}

async function writeFxStub(dataDir: string): Promise<string> {
  const { chmod, mkdir } = await import("node:fs/promises");
  const binDir = path.join(dataDir, "fx-stub-bin");
  await mkdir(binDir, { recursive: true });
  const bin = path.join(binDir, "fx");
  await Bun.write(
    bin,
    "#!/bin/sh\nif [ \"$1\" = \"--help\" ]; then echo \"Fast, native coding agent for the terminal\"; exit 0; fi\nif [ \"$1\" = \"--version\" ]; then echo 0.0.4-fake; exit 0; fi\nexit 0\n",
  );
  await chmod(bin, 0o755);
  return bin;
}

async function tail(file: string): Promise<string> {
  try {
    return (await readFile(file, "utf8")).slice(-2000);
  } catch {
    return "";
  }
}
