import { expect, test } from "bun:test";
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import {
  classifyComposeProject,
  composeStopPermitted,
  FO_LABEL_MANAGED,
  FO_LABEL_PROFILE,
  FO_LABEL_TOKEN,
  type ComposeContainerSnapshot,
  type ComposeExpectation,
} from "../../shared/environment/compose-ownership.ts";
import type { HealthRunResult } from "./health.ts";
import { EnvironmentManager, type EnvironmentManagerOptions } from "./manager.ts";
import type { ExitInfo, LocalProcessHost, LocalStartRequest, ProcessInspector, ProcessSignaller } from "./process-host.ts";
import type { ProcessSnapshot } from "./ps.ts";
import { MemoryEnvironmentStore } from "./store.ts";
import type { ComposeHost } from "./docker-compose.ts";

type HealthMode = "ok" | "fail" | "hang" | "degraded";

class World {
  readonly store = new MemoryEnvironmentStore();
  readonly signals: { pid: number; signal: string }[] = [];
  readonly signed: { pid: number; signal: string }[] = [];
  starts = 0;
  ignoreSignal = false;
  releaseSleep = false;
  healthMode: HealthMode = "ok";
  readonly snaps = new Map<number, ProcessSnapshot | null>();
  readonly exiters = new Map<number, (exit: ExitInfo) => void>();
  lastRequest: LocalStartRequest | null = null;
  readonly composeCalls: string[] = [];
  readonly containers = new Map<string, ComposeContainerSnapshot[]>();
  composeAvailable = true;
  readonly dir: string;

  constructor() {
    this.dir = realpathSync(mkdtempSync(path.join(tmpdir(), "fo-env-")));
  }

  cleanup(): void {
    rmSync(this.dir, { recursive: true, force: true });
  }

  processes: LocalProcessHost = {
    start: async (request) => {
      this.starts += 1;
      this.lastRequest = request;
      request.onOutput("stdout", "out-line\n");
      request.onOutput("stderr", "err-line\n");
      const echoed = request.env.FORGEORBIT_ENV_TOKEN ?? "";
      if (echoed.length >= 8) request.onOutput("stdout", `token=${echoed}\n`);
      const pid = 4000 + this.starts;
      const token = request.env.FORGEORBIT_ENV_TOKEN ?? "";
      this.snaps.set(pid, {
        pid,
        startedAtMs: 1_700_000_000_000,
        command: `supervisor ${token} ${request.executable}`,
        envToken: token,
      });
      let resolveExit: (exit: ExitInfo) => void = () => {};
      const exited = new Promise<ExitInfo>((resolve) => {
        resolveExit = resolve;
      });
      this.exiters.set(pid, resolveExit);
      return {
        ok: true,
        process: {
          pid,
          startedAtMs: 1_700_000_000_000,
          processGroup: request.processGroup,
          exited,
          signal: (signal) => {
            this.signals.push({ pid, signal });
            if (!this.ignoreSignal) {
              this.snaps.set(pid, null);
              resolveExit({ code: null, signal });
            }
          },
        },
      };
    },
  };

  inspector: ProcessInspector = {
    inspect: async (pid) => {
      if (!this.snaps.has(pid)) return null;
      return this.snaps.get(pid) ?? null;
    },
  };

  signaller: ProcessSignaller = {
    signal: (pid, signal) => {
      this.signed.push({ pid, signal });
      if (!this.ignoreSignal) this.snaps.set(pid, null);
      return "ok";
    },
  };

  compose: ComposeHost = {
    availability: async () => (this.composeAvailable ? { ok: true } : { ok: false, detail: "docker: command not found" }),
    inspect: async (expected) => {
      this.composeCalls.push(`inspect ${expected.projectName}`);
      return classifyComposeProject(this.containers.get(expected.projectName) ?? [], expected);
    },
    up: async (expected, services) => {
      this.composeCalls.push(`up ${expected.projectName}`);
      const containers = services.map((service, index) => this.container(expected, service, index));
      this.containers.set(expected.projectName, containers);
      return { ok: true, containers };
    },
    stop: async (expected) => {
      this.composeCalls.push(`stop ${expected.projectName}`);
      const view = classifyComposeProject(this.containers.get(expected.projectName) ?? [], expected);
      if (!composeStopPermitted(view)) return { ok: false, detail: "refused", refused: true };
      this.containers.set(expected.projectName, []);
      return { ok: true, containers: [] };
    },
    logs: async (expected) => {
      this.composeCalls.push(`logs ${expected.projectName}`);
      return { ok: true, text: `log ${expected.projectName}` };
    },
  };

  container(expected: ComposeExpectation, service: string, index: number): ComposeContainerSnapshot {
    const id = `${index.toString(16)}abcabcabcab`.slice(0, 12);
    return {
      id,
      service,
      state: "running",
      project: expected.projectName,
      workingDir: expected.workingDir,
      configFiles: [expected.composeFile],
      labels: {
        [FO_LABEL_MANAGED]: "1",
        [FO_LABEL_PROFILE]: expected.profileId,
        [FO_LABEL_TOKEN]: expected.token ?? "",
      },
    };
  }

  manager(overrides: EnvironmentManagerOptions = {}): EnvironmentManager {
    const world = this;
    return new EnvironmentManager({
      store: this.store,
      sessionId: "session-a",
      processes: this.processes,
      inspector: this.inspector,
      signaller: this.signaller,
      compose: this.compose,
      markerDir: path.join(this.dir, "markers"),
      parentEnv: { PATH: "/usr/bin:/bin", HOME: "/Users/me", SECRET_TOKEN: "nope" },
      sleep: (_ms, signal) =>
        new Promise((resolve) => {
          if (signal?.aborted || world.releaseSleep) {
            resolve();
            return;
          }
          signal?.addEventListener("abort", () => resolve(), { once: true });
        }),
      health: (_profile, signal) => this.healthResult(signal),
      ...overrides,
    });
  }

  healthResult(signal: AbortSignal): Promise<HealthRunResult> {
    if (this.healthMode === "hang") {
      return new Promise((resolve) => {
        signal.addEventListener(
          "abort",
          () =>
            resolve({
              ok: false,
              code: "cancelled",
              detail: "cancelled",
              outcomes: [],
              degraded: false,
            }),
          { once: true },
        );
      });
    }
    if (this.healthMode === "fail") {
      return Promise.resolve({
        ok: false,
        code: "health-failed",
        detail: "web: HTTP 500",
        outcomes: [{ id: "web", ok: false, required: true, detail: "HTTP 500", attempts: 1 }],
        degraded: false,
      });
    }
    if (this.healthMode === "degraded") {
      return Promise.resolve({
        ok: true,
        code: "ok",
        detail: "optional checks failed",
        degraded: true,
        outcomes: [
          { id: "web", ok: true, required: true, detail: "HTTP 200", attempts: 1 },
          { id: "admin", ok: false, required: false, detail: "HTTP 503", attempts: 1 },
        ],
      });
    }
    return Promise.resolve({
      ok: true,
      code: "ok",
      detail: "ok",
      degraded: false,
      outcomes: [{ id: "web", ok: true, required: true, detail: "HTTP 200", attempts: 1 }],
    });
  }
}

function loopbackCheck(url: string): Record<string, unknown> {
  return {
    id: "web",
    kind: "http",
    url,
    timeoutMs: 200,
    intervalMs: 50,
    maxAttempts: 3,
    required: true,
  };
}

function localProfile(dir: string, id = "app"): Record<string, unknown> {
  return {
    id,
    projectPath: dir,
    name: id,
    cwd: dir,
    launch: { kind: "local-process", command: { executable: "/bin/echo", args: ["$HOME", "a; rm"] } },
    stop: { kind: "signal", signal: "SIGTERM", graceMs: 200, killAfterGrace: true, processGroup: false },
    expectedPorts: [],
    healthChecks: [loopbackCheck("http://127.0.0.1:3000/")],
    urls: [{ id: "site", name: "Website", role: "website", url: "http://127.0.0.1:3000/", healthCheckId: "web", optional: false }],
    startupTimeoutMs: 1_000,
    shutdownTimeoutMs: 1_000,
    env: [],
  };
}

function composeProfile(dir: string, id: string, projectName: string): Record<string, unknown> {
  writeFileSync(path.join(dir, "compose.yaml"), "services:\n  web:\n    image: example\n");
  return {
    id,
    projectPath: dir,
    name: id,
    cwd: dir,
    launch: { kind: "docker-compose", composeFile: "compose.yaml", projectName, services: ["web"] },
    stop: { kind: "compose-stop" },
    expectedPorts: [],
    healthChecks: [loopbackCheck("http://127.0.0.1:8080/")],
    urls: [
      { id: "site", name: "Website", role: "website", url: "http://127.0.0.1:8080/", healthCheckId: "web", optional: false },
    ],
    startupTimeoutMs: 1_000,
    shutdownTimeoutMs: 1_000,
    env: [],
  };
}

test("registers a valid profile, rejects an invalid one, and reports a missing working directory", async () => {
  const world = new World();
  try {
    const manager = world.manager();
    const bad = await manager.register({ id: "nope", launch: { kind: "local-process", command: "bun run dev" } });
    expect(bad.ok).toBe(false);
    if (!bad.ok) expect(bad.code).toBe("invalid-profile");

    const registered = await manager.register(localProfile(world.dir));
    expect(registered.ok).toBe(true);

    const missing = world.manager();
    const ghost = `/tmp/forgeorbit-missing-${process.pid}-env`;
    await missing.register(localProfile(ghost, "ghost"));
    const started = await missing.start("ghost");
    expect(started.ok).toBe(false);
    if (!started.ok) expect(started.code).toBe("missing-workdir");
    expect(world.starts).toBe(0);
    expect(missing.status("ghost")?.recordedPhase).toBe("error");
  } finally {
    world.cleanup();
  }
});

test("starts once, is idempotent, stops, restarts, and keeps two projects apart", async () => {
  const world = new World();
  try {
    const manager = world.manager();
    await manager.register(localProfile(world.dir, "one"));
    const otherDir = realpathSync(mkdtempSync(path.join(tmpdir(), "fo-env-b-")));
    try {
      await manager.register(localProfile(otherDir, "two"));
      const first = manager.start("one");
      const second = manager.start("one");
      const [a, b] = await Promise.all([first, second]);
      expect(a.ok && b.ok).toBe(true);
      expect(world.starts).toBe(1);
      expect(manager.status("one")?.recordedPhase).toBe("running");
      expect(manager.status("one")?.ownership).toBe("session");
      expect(manager.status("one")?.observed.processAlive).toBe(true);

      const again = await manager.start("one");
      expect(again.ok).toBe(true);
      expect(world.starts).toBe(1);

      await manager.start("two");
      expect(world.starts).toBe(2);
      const stopped = await manager.stop("one");
      expect(stopped.ok).toBe(true);
      expect(manager.status("one")?.recordedPhase).toBe("stopped");
      expect(manager.status("one")?.pid).toBeNull();
      expect(world.signals.map((signal) => signal.pid)).toEqual([4001]);
      expect(manager.status("two")?.recordedPhase).toBe("running");

      const stoppedAgain = await manager.stop("one");
      expect(stoppedAgain.ok).toBe(true);
      expect(world.signals).toHaveLength(1);

      const restarted = await manager.restart("two");
      expect(restarted.ok).toBe(true);
      expect(manager.status("two")?.recordedPhase).toBe("running");
      expect(world.starts).toBe(3);
      expect(world.signals.some((signal) => signal.pid === 4002)).toBe(true);
    } finally {
      rmSync(otherDir, { recursive: true, force: true });
    }
  } finally {
    world.cleanup();
  }
});

test("a failed spawn, a failed health check, and an unexpected exit land in error and clean up our process", async () => {
  const world = new World();
  const failing: LocalProcessHost = {
    start: async () => ({ ok: false, detail: "executable not found" }),
  };
  try {
    const manager = world.manager({ processes: failing });
    await manager.register(localProfile(world.dir));
    const failed = await manager.start("app");
    expect(failed.ok).toBe(false);
    if (!failed.ok) expect(failed.code).toBe("start-failed");
    expect(manager.status("app")?.recordedPhase).toBe("error");

    const healthy = world.manager();
    await healthy.register(localProfile(world.dir));
    world.healthMode = "fail";
    const unhealthy = await healthy.start("app");
    expect(unhealthy.ok).toBe(false);
    if (!unhealthy.ok) expect(unhealthy.code).toBe("health-failed");
    expect(healthy.status("app")?.recordedPhase).toBe("error");
    expect(world.signals).toHaveLength(1);
    expect(healthy.status("app")?.pid).toBeNull();

    world.healthMode = "ok";
    world.signals.length = 0;
    const running = await healthy.start("app");
    expect(running.ok).toBe(true);
    const exit = world.exiters.get(healthy.status("app")?.pid ?? 0);
    exit?.({ code: 1, signal: null });
    await Bun.sleep(10);
    expect(healthy.status("app")?.recordedPhase).toBe("error");
    expect(healthy.status("app")?.errorCode).toBe("process-exited");
    expect(healthy.status("app")?.observed.processAlive).toBe(false);
  } finally {
    world.cleanup();
  }
});

test("startup timeout and shutdown timeout are reported, and shutdown escalates only for our pid", async () => {
  const world = new World();
  try {
    const manager = world.manager();
    await manager.register(localProfile(world.dir));
    world.healthMode = "hang";
    world.releaseSleep = true;
    const timed = await manager.start("app");
    expect(timed.ok).toBe(false);
    if (!timed.ok) expect(timed.code).toBe("startup-timeout");
    expect(manager.status("app")?.recordedPhase).toBe("error");
    expect(world.signals.map((signal) => signal.signal)).toContain("SIGTERM");
    expect(world.signals.every((signal) => signal.pid === 4001)).toBe(true);

    world.healthMode = "ok";
    world.releaseSleep = false;
    world.ignoreSignal = false;
    const running = await manager.start("app");
    expect(running.ok).toBe(true);
    world.ignoreSignal = true;
    world.releaseSleep = true;
    world.signals.length = 0;
    const stop = await manager.stop("app");
    expect(stop.ok).toBe(false);
    if (!stop.ok) expect(stop.code).toBe("shutdown-timeout");
    expect(world.signals.map((signal) => signal.signal)).toEqual(["SIGTERM", "SIGKILL"]);
    expect(manager.status("app")?.recordedPhase).toBe("error");
  } finally {
    world.cleanup();
  }
});

test("stdout and stderr are kept, and the launch argv is not a shell", async () => {
  const world = new World();
  try {
    const manager = world.manager();
    await manager.register(localProfile(world.dir));
    await manager.start("app");
    const logs = await manager.logs("app");
    expect(logs?.lines.map((line) => `${line.stream}:${line.text}`).join("")).toContain("stdout:out-line");
    expect(logs?.lines.map((line) => line.text).join("")).toContain("err-line");
    expect(world.lastRequest?.executable).toBe("/bin/echo");
    expect(world.lastRequest?.args).toEqual(["$HOME", "a; rm"]);
    expect(world.lastRequest?.env.SECRET_TOKEN).toBeUndefined();
    const token = world.lastRequest?.env.FORGEORBIT_ENV_TOKEN ?? "";
    expect(token).toMatch(/^[a-f0-9]{32}$/);
    const transcript = logs?.lines.map((line) => line.text).join("\n") ?? "";
    expect(transcript).not.toContain(token);
    expect(transcript).toContain("[redacted]");
    const urls = manager.urls("app");
    expect(urls?.[0]).toMatchObject({ name: "Website", status: "up" });
  } finally {
    world.cleanup();
  }
});

test("after a restart, a proven process is prior-forgeorbit and a foreign pid is not signalled", async () => {
  const world = new World();
  try {
    const first = world.manager({ sessionId: "session-a" });
    await first.register(localProfile(world.dir));
    const started = await first.start("app");
    expect(started.ok).toBe(true);
    const pid = first.status("app")?.pid ?? 0;

    const second = world.manager({ sessionId: "session-b" });
    const restored = await second.restore();
    expect(restored[0]?.recordedPhase).toBe("running");
    expect(restored[0]?.ownership).toBe("prior-forgeorbit");
    expect(world.signed).toHaveLength(0);
    expect(world.signals.filter((signal) => signal.pid === pid)).toHaveLength(0);

    world.snaps.set(pid, {
      pid,
      startedAtMs: 1,
      command: "/usr/bin/unrelated",
      envToken: "ff".repeat(16),
    });
    const stopped = await second.stop("app");
    expect(stopped.ok).toBe(false);
    if (!stopped.ok) expect(stopped.code).toBe("foreign-process");
    expect(world.signed).toHaveLength(0);
    expect(world.signals.filter((signal) => signal.pid === pid)).toHaveLength(0);
    expect(second.status("app")?.recordedPhase).toBe("unknown");
  } finally {
    world.cleanup();
  }
});

test("a dead pid discovered at recovery becomes stopped without a signal", async () => {
  const world = new World();
  try {
    const first = world.manager({ sessionId: "session-a" });
    await first.register(localProfile(world.dir));
    await first.start("app");
    const pid = first.status("app")?.pid ?? 0;
    world.snaps.set(pid, null);
    const second = world.manager({ sessionId: "session-b" });
    const restored = await second.restore();
    expect(restored[0]?.recordedPhase).toBe("stopped");
    expect(world.signed).toHaveLength(0);
    expect(second.status("app")?.pid).toBeNull();
  } finally {
    world.cleanup();
  }
});

test("a saved running phase with no ownership is not treated as running", async () => {
  const world = new World();
  try {
    const first = world.manager();
    await first.register(localProfile(world.dir));
    const rows = await world.store.loadAll();
    rows[0]!.runtime.phase = "running";
    await world.store.save(rows[0]!);
    const second = world.manager({ sessionId: "session-b" });
    const restored = await second.restore();
    expect(restored[0]?.recordedPhase).toBe("stopped");
    expect(restored[0]?.ownership).toBe("none");
    expect(world.signed).toHaveLength(0);
    expect(world.signals).toHaveLength(0);
  } finally {
    world.cleanup();
  }
});

test("update replaces a stopped profile and refuses a running one", async () => {
  const world = new World();
  try {
    const manager = world.manager();
    await manager.register(localProfile(world.dir));
    const renamed = localProfile(world.dir);
    renamed.name = "Renamed";
    const updated = await manager.update("app", renamed);
    expect(updated.ok).toBe(true);
    expect(manager.profile("app")?.name).toBe("Renamed");
    await manager.start("app");
    renamed.name = "Again";
    const refused = await manager.update("app", renamed);
    expect(refused.ok).toBe(false);
    if (!refused.ok) expect(refused.code).toBe("busy");
    expect(manager.profile("app")?.name).toBe("Renamed");
  } finally {
    world.cleanup();
  }
});

test("compose projects stay isolated, external stacks are not stopped, and a missing daemon fails closed", async () => {
  const world = new World();
  const other = realpathSync(mkdtempSync(path.join(tmpdir(), "fo-env-c-")));
  try {
    const manager = world.manager();
    await manager.register(composeProfile(world.dir, "example-project", "fo-example-project"));
    await manager.register(composeProfile(other, "example-portal", "fo-example-portal"));
    const media = await manager.start("example-project");
    const sog = await manager.start("example-portal");
    expect(media.ok && sog.ok).toBe(true);
    expect(world.composeCalls.filter((call) => call.startsWith("up "))).toEqual(["up fo-example-project", "up fo-example-portal"]);

    const again = await manager.start("example-project");
    expect(again.ok).toBe(true);
    expect(world.composeCalls.filter((call) => call === "up fo-example-project")).toHaveLength(1);

    const stopped = await manager.stop("example-project");
    expect(stopped.ok).toBe(true);
    expect(world.composeCalls.filter((call) => call.startsWith("stop "))).toEqual(["stop fo-example-project"]);
    expect(manager.status("example-portal")?.recordedPhase).toBe("running");
    const logs = await manager.logs("example-portal");
    expect(logs?.lines.some((line) => line.text.includes("log fo-example-portal"))).toBe(true);

    const externalDir = realpathSync(mkdtempSync(path.join(tmpdir(), "fo-env-d-")));
    try {
      await manager.register(composeProfile(externalDir, "example-service", "fo-example-service"));
      const cwd = realpathSync(externalDir);
      const composeFile = realpathSync(path.join(externalDir, "compose.yaml"));
      world.containers.set("fo-example-service", [
        {
          id: "cccabcabcabc",
          service: "web",
          state: "running",
          project: "fo-example-service",
          workingDir: cwd,
          configFiles: [composeFile],
          labels: {},
        },
      ]);
      const external = await manager.start("example-service");
      expect(external.ok).toBe(false);
      if (!external.ok) expect(external.code).toBe("external-environment");
      expect(world.composeCalls.some((call) => call === "up fo-example-service")).toBe(false);
      const externalStop = await manager.stop("example-service");
      expect(externalStop.ok).toBe(false);
      if (!externalStop.ok) expect(externalStop.code).toBe("external-environment");
      expect(world.composeCalls.some((call) => call === "stop fo-example-service")).toBe(false);
    } finally {
      rmSync(externalDir, { recursive: true, force: true });
    }

    world.composeAvailable = false;
    const offline = await manager.start("example-project");
    expect(offline.ok).toBe(false);
    if (!offline.ok) expect(offline.code).toBe("docker-unavailable");
    expect(world.composeCalls.filter((call) => call === "up fo-example-project")).toHaveLength(1);
  } finally {
    rmSync(other, { recursive: true, force: true });
    world.cleanup();
  }
});

test("unregister drops our record and does not signal an external environment", async () => {
  const world = new World();
  try {
    const manager = world.manager();
    await manager.register(localProfile(world.dir));
    await manager.start("app");
    const removed = await manager.unregister("app");
    expect(removed.ok).toBe(true);
    expect(manager.status("app")).toBeNull();
    expect(world.signals).toHaveLength(1);
    expect(await world.store.loadAll()).toHaveLength(0);
  } finally {
    world.cleanup();
  }
});

test("stop waits for the process after cancelling the in-flight health check", async () => {
  const dir = realpathSync(mkdtempSync(path.join(tmpdir(), "fo-env-grace-")));
  const signals: string[] = [];
  let releaseExit: (exit: ExitInfo) => void = () => {};
  const exited = new Promise<ExitInfo>((resolve) => {
    releaseExit = resolve;
  });
  const manager = new EnvironmentManager({
    sleep: (ms, signal) =>
      new Promise((resolve) => {
        if (signal?.aborted) {
          resolve();
          return;
        }
        const timer = setTimeout(resolve, ms);
        signal?.addEventListener("abort", () => {
          clearTimeout(timer);
          resolve();
        }, { once: true });
      }),
    processes: {
      async start() {
        return {
          ok: true as const,
          process: {
            pid: 4242,
            startedAtMs: 1,
            processGroup: false,
            exited,
            signal(signal: string) {
              signals.push(signal);
              setTimeout(() => releaseExit({ code: null, signal }), 30);
            },
          },
        };
      },
    },
    health: async () => ({
      ok: true,
      code: "ok",
      detail: "ok",
      degraded: false,
      outcomes: [],
    }),
    markerDir: path.join(dir, "markers"),
  });
  try {
    await manager.register(localProfile(dir));
    const started = await manager.start("app");
    expect(started.ok).toBe(true);
    const stopped = await manager.stop("app");
    expect(stopped.ok).toBe(true);
    if (stopped.ok) expect(stopped.status.recordedPhase).toBe("stopped");
    expect(signals).toEqual(["SIGTERM"]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
