import { expect, test, beforeAll, afterAll } from "bun:test";
import { mkdtempSync, mkdirSync, realpathSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import {
  classifyComposeProject,
  composeStopPermitted,
  type ComposeContainerSnapshot,
  type ComposeExpectation,
} from "../../shared/environment/compose-ownership.ts";
import type { HealthRunResult } from "./health.ts";
import { EnvironmentManager, type EnvironmentManagerOptions } from "./manager.ts";
import type { ExitInfo, LocalProcessHost, ProcessInspector, ProcessSignaller } from "./process-host.ts";
import type { ProcessSnapshot } from "./ps.ts";
import { MemoryEnvironmentStore } from "./store.ts";
import type { ComposeHost } from "./docker-compose.ts";

const DATA_DIR = mkdtempSync(path.join(tmpdir(), "fo-env-http-"));
process.env.AGETOR_DATA_DIR = DATA_DIR;
process.env.AGETOR_API_PORT = "4497";

const root = realpathSync(mkdtempSync(path.join(tmpdir(), "fo-env-proj-")));
const other = realpathSync(mkdtempSync(path.join(tmpdir(), "fo-env-other-")));
mkdirSync(path.join(root, "sub"));
writeFileSync(path.join(root, "compose.yaml"), "services:\n  web:\n    image: example\n");

let server: { stop: () => void };
let token = "";
let projects: typeof import("../db.ts").projects;
let installEnvironmentManager: typeof import("./runtime.ts").installEnvironmentManager;
let resetEnvironmentManagerForTests: typeof import("./runtime.ts").resetEnvironmentManagerForTests;

const signals: { pid: number; signal: string }[] = [];
const snaps = new Map<number, ProcessSnapshot | null>();
let starts = 0;
let releaseHealth: () => void = () => {};
let healthGate: Promise<void> = Promise.resolve();
let healthMode: "ok" | "fail" | "hold" = "ok";
const composeCalls: string[] = [];
const containers = new Map<string, ComposeContainerSnapshot[]>();
const store = new MemoryEnvironmentStore();

const processes: LocalProcessHost = {
  start: async (request) => {
    starts += 1;
    const pid = 5000 + starts;
    const owned = request.env.FORGEORBIT_ENV_TOKEN ?? "";
    snaps.set(pid, {
      pid,
      startedAtMs: 1,
      command: `supervisor ${owned} ${request.executable}`,
      envToken: owned,
    });
    request.onOutput("stdout", `token=${owned}\n`);
    let resolveExit: (exit: ExitInfo) => void = () => {};
    const exited = new Promise<ExitInfo>((resolve) => {
      resolveExit = resolve;
    });
    return {
      ok: true as const,
      process: {
        pid,
        startedAtMs: 1,
        processGroup: request.processGroup,
        exited,
        signal: (signal: string) => {
          signals.push({ pid, signal });
          snaps.set(pid, null);
          resolveExit({ code: null, signal });
        },
      },
    };
  },
};

const inspector: ProcessInspector = {
  inspect: async (pid) => (snaps.has(pid) ? snaps.get(pid) ?? null : null),
};

const signaller: ProcessSignaller = {
  signal: (pid, signal) => {
    signals.push({ pid, signal });
    return "ok";
  },
};

const compose: ComposeHost = {
  availability: async () => ({ ok: true as const }),
  inspect: async (expected) => classifyComposeProject(containers.get(expected.projectName) ?? [], expected),
  up: async (expected, services) => {
    composeCalls.push(`up ${expected.projectName}`);
    const made = services.map((service, index) => container(expected, service, index));
    containers.set(expected.projectName, made);
    return { ok: true as const, containers: made };
  },
  stop: async (expected) => {
    composeCalls.push(`stop ${expected.projectName}`);
    const view = classifyComposeProject(containers.get(expected.projectName) ?? [], expected);
    if (!composeStopPermitted(view)) return { ok: false as const, detail: "refused", refused: true as const };
    containers.set(expected.projectName, []);
    return { ok: true as const, containers: [] };
  },
  logs: async () => ({ ok: true as const, text: "web | ready\n" }),
};

function container(expected: ComposeExpectation, service: string, index: number): ComposeContainerSnapshot {
  return {
    id: `${index}abcabcabcabc`.slice(0, 12),
    service,
    state: "running",
    project: expected.projectName,
    workingDir: expected.workingDir,
    configFiles: [expected.composeFile],
    labels: {},
  };
}

function manager(overrides: EnvironmentManagerOptions = {}): EnvironmentManager {
  return new EnvironmentManager({
    store,
    sessionId: "session-a",
    processes,
    inspector,
    signaller,
    compose,
    markerDir: path.join(DATA_DIR, "markers"),
    parentEnv: { PATH: "/usr/bin:/bin", HOME: "/Users/me", SECRET_TOKEN: "nope" },
    sleep: (_ms, signal) =>
      new Promise((resolve) => {
        if (signal?.aborted) {
          resolve();
          return;
        }
        signal?.addEventListener("abort", () => resolve(), { once: true });
      }),
    health: async () => {
      if (healthMode === "hold") await healthGate;
      if (healthMode === "fail") {
        return {
          ok: false,
          code: "health-failed",
          detail: "web: HTTP 500",
          degraded: false,
          outcomes: [{ id: "web", ok: false, required: true, detail: "HTTP 500", attempts: 1 }],
        } satisfies HealthRunResult;
      }
      return {
        ok: true,
        code: "ok",
        detail: "ok",
        degraded: false,
        outcomes: [{ id: "web", ok: true, required: true, detail: "HTTP 200", attempts: 1 }],
      } satisfies HealthRunResult;
    },
    ...overrides,
  });
}

function localProfile(id = "app", dir = root): Record<string, unknown> {
  return {
    id,
    projectPath: dir,
    name: "App",
    cwd: dir,
    launch: { kind: "local-process", command: { executable: "/bin/echo", args: ["$HOME"] } },
    stop: { kind: "signal", signal: "SIGTERM", graceMs: 200, killAfterGrace: false, processGroup: false },
    expectedPorts: [{ host: "127.0.0.1", port: 3000 }],
    healthChecks: [{
      id: "web",
      kind: "http",
      url: "http://127.0.0.1:3000/",
      method: "GET",
      acceptedStatuses: [200],
      timeoutMs: 1000,
      intervalMs: 100,
      maxAttempts: 2,
      required: true,
    }],
    urls: [{ id: "site", name: "Website", role: "website", url: "http://127.0.0.1:3000/", healthCheckId: "web", optional: false }],
    startupTimeoutMs: 1000,
    shutdownTimeoutMs: 1000,
    env: [{ name: "PORT", from: "inherit" }],
  };
}

beforeAll(async () => {
  ({ projects } = await import("../db.ts"));
  const runtime = await import("./runtime.ts");
  installEnvironmentManager = runtime.installEnvironmentManager;
  resetEnvironmentManagerForTests = runtime.resetEnvironmentManagerForTests;
  installEnvironmentManager(manager());
  projects.upsert(root, "Root");
  projects.upsert(other, "Other");
  const serverMod = await import("../server.ts");
  server = serverMod.startApiServer() as unknown as { stop: () => void };
  token = serverMod.API_TOKEN;
});

afterAll(() => {
  server?.stop();
  resetEnvironmentManagerForTests?.();
});

const url = (pathname: string) => `http://127.0.0.1:4497${pathname}`;
const auth = () => ({ authorization: `Bearer ${token}`, "content-type": "application/json" });

test("environment routes require the bearer token", async () => {
  const res = await fetch(url(`/projects/environment?path=${encodeURIComponent(root)}`));
  expect(res.status).toBe(401);
});

test("profiles are created, persisted in the manager, edited, and deleted for one project only", async () => {
  const created = await fetch(url("/projects/environment"), {
    method: "POST",
    headers: auth(),
    body: JSON.stringify({ path: root, profile: localProfile() }),
  });
  expect(created.status).toBe(200);
  const createdBody = await created.json() as { profile: { id: string; env: unknown[] } };
  expect(JSON.stringify(createdBody)).not.toContain("FORGEORBIT_ENV_TOKEN");
  expect(createdBody.profile.env).toEqual([{ name: "PORT", from: "inherit" }]);

  const list = await fetch(url(`/projects/environment?path=${encodeURIComponent(root)}`), { headers: auth() });
  expect(list.status).toBe(200);
  const index = await list.json() as { profiles: { profile: { id: string } }[]; suggestions: { composeFiles: { file: string; services: string[] }[] } };
  expect(index.profiles).toHaveLength(1);
  expect(index.suggestions.composeFiles.some((file) => file.file === "compose.yaml" && file.services.includes("web"))).toBe(true);

  const foreign = await fetch(url(`/projects/environment/app?path=${encodeURIComponent(other)}`), { headers: auth() });
  expect(foreign.status).toBe(404);

  const missing = await fetch(url(`/projects/environment?path=${encodeURIComponent("/tmp/not-a-registered-project")}`), { headers: auth() });
  expect(missing.status).toBe(404);

  const renamed = localProfile();
  renamed.name = "Renamed";
  const patched = await fetch(url("/projects/environment/app"), {
    method: "PATCH",
    headers: auth(),
    body: JSON.stringify({ path: root, profile: renamed }),
  });
  expect(patched.status).toBe(200);

  const got = await fetch(url(`/projects/environment/app?path=${encodeURIComponent(root)}`), { headers: auth() });
  expect((await got.json() as { profile: { name: string } }).profile.name).toBe("Renamed");
});

test("rejects shell commands, escaped directories, literal secrets, and oversized bodies", async () => {
  const shell = localProfile("shell");
  shell.launch = { kind: "local-process", command: { executable: "bash", args: ["-c", "echo hi"] } };
  const shellRes = await fetch(url("/projects/environment"), {
    method: "POST",
    headers: auth(),
    body: JSON.stringify({ path: root, profile: shell }),
  });
  expect(shellRes.status).toBe(400);

  const escaped = localProfile("escape");
  escaped.cwd = path.join(root, "..");
  const escapeRes = await fetch(url("/projects/environment"), {
    method: "POST",
    headers: auth(),
    body: JSON.stringify({ path: root, profile: escaped }),
  });
  expect(escapeRes.status).toBe(400);

  const secret = localProfile("secret");
  secret.env = [{ name: "TOKEN", from: "literal", value: "super-secret-value" }];
  const secretRes = await fetch(url("/projects/environment"), {
    method: "POST",
    headers: auth(),
    body: JSON.stringify({ path: root, profile: secret }),
  });
  expect(secretRes.status).toBe(400);
  expect(await secretRes.text()).not.toContain("super-secret-value");

  const huge = await fetch(url("/projects/environment"), {
    method: "POST",
    headers: auth(),
    body: JSON.stringify({ path: root, profile: localProfile("huge"), pad: "x".repeat(70_000) }),
  });
  expect(huge.status).toBe(413);
});

test("a symlink that leaves the project is rejected for cwd and compose file", async () => {
  const outside = realpathSync(mkdtempSync(path.join(tmpdir(), "fo-env-outside-")));
  writeFileSync(path.join(outside, "compose.yaml"), "services:\n  web:\n    image: example\n");
  symlinkSync(outside, path.join(root, "escape-link"));
  symlinkSync(path.join(outside, "compose.yaml"), path.join(root, "linked-compose.yaml"));

  const linkedCwd = localProfile("linked-cwd");
  linkedCwd.cwd = path.join(root, "escape-link");
  const cwdRes = await fetch(url("/projects/environment"), {
    method: "POST",
    headers: auth(),
    body: JSON.stringify({ path: root, profile: linkedCwd }),
  });
  expect(cwdRes.status).toBe(400);

  const linkedFile = localProfile("linked-file");
  linkedFile.launch = { kind: "docker-compose", composeFile: "linked-compose.yaml", projectName: "fo-linked", services: [] };
  linkedFile.stop = { kind: "compose-stop" };
  linkedFile.healthChecks = [];
  linkedFile.urls = [];
  linkedFile.expectedPorts = [];
  const fileRes = await fetch(url("/projects/environment"), {
    method: "POST",
    headers: auth(),
    body: JSON.stringify({ path: root, profile: linkedFile }),
  });
  expect(fileRes.status).toBe(400);
  const body = await fileRes.text();
  expect(body).toContain("escapes");
});

test("start, stop, restart, health failure, logs, and urls go through the manager", async () => {
  healthMode = "fail";
  const failed = await fetch(url(`/projects/environment/app/start?path=${encodeURIComponent(root)}`), {
    method: "POST",
    headers: auth(),
  });
  expect(failed.status).toBe(422);
  const failedBody = await failed.json() as { code: string };
  expect(failedBody.code).toBe("health-failed");

  healthMode = "ok";
  const started = await fetch(url(`/projects/environment/app/start?path=${encodeURIComponent(root)}`), {
    method: "POST",
    headers: auth(),
  });
  expect(started.status).toBe(200);
  const startedBody = await started.json() as { status: { recordedPhase: string; ownership: string }; urls: { status: string; url: string }[] };
  expect(startedBody.status.recordedPhase).toBe("running");
  expect(startedBody.status.ownership).toBe("session");
  expect(startedBody.urls[0]?.status).toBe("up");
  expect(JSON.stringify(startedBody)).not.toMatch(/[a-f0-9]{32}/);

  const logs = await fetch(url(`/projects/environment/app/logs?path=${encodeURIComponent(root)}`), { headers: auth() });
  const logBody = await logs.json() as { lines: { text: string }[] };
  const transcript = logBody.lines.map((line) => line.text).join("\n");
  expect(transcript).toContain("[redacted]");
  expect(transcript).not.toMatch(/token=[a-f0-9]{32}/);

  const urls = await fetch(url(`/projects/environment/app/urls?path=${encodeURIComponent(root)}`), { headers: auth() });
  expect((await urls.json() as { urls: { url: string }[] }).urls[0]?.url).toBe("http://127.0.0.1:3000/");

  const restarted = await fetch(url(`/projects/environment/app/restart?path=${encodeURIComponent(root)}`), {
    method: "POST",
    headers: auth(),
  });
  expect(restarted.status).toBe(200);

  const stopped = await fetch(url(`/projects/environment/app/stop?path=${encodeURIComponent(root)}`), {
    method: "POST",
    headers: auth(),
  });
  expect(stopped.status).toBe(200);
  expect((await stopped.json() as { status: { recordedPhase: string } }).status.recordedPhase).toBe("stopped");
});

test("a second start joins the in-flight one", async () => {
  await fetch(url(`/projects/environment/app/stop?path=${encodeURIComponent(root)}`), { method: "POST", headers: auth() });
  healthMode = "hold";
  healthGate = new Promise((resolve) => {
    releaseHealth = resolve;
  });
  const before = starts;
  const first = fetch(url(`/projects/environment/app/start?path=${encodeURIComponent(root)}`), { method: "POST", headers: auth() });
  const second = fetch(url(`/projects/environment/app/start?path=${encodeURIComponent(root)}`), { method: "POST", headers: auth() });
  await new Promise((resolve) => setTimeout(resolve, 40));
  expect(starts).toBe(before + 1);
  releaseHealth();
  const [a, b] = await Promise.all([first, second]);
  expect(a.status).toBe(200);
  expect(b.status).toBe(200);
  healthMode = "ok";
  await fetch(url(`/projects/environment/app/stop?path=${encodeURIComponent(root)}`), { method: "POST", headers: auth() });
});

test("a recovered foreign pid and an external compose project are not stopped", async () => {
  healthMode = "ok";
  const started = await fetch(url(`/projects/environment/app/start?path=${encodeURIComponent(root)}`), {
    method: "POST",
    headers: auth(),
  });
  expect(started.status).toBe(200);
  const pid = (await started.json() as { status: { pid: number } }).status.pid;
  const recovered = manager({ sessionId: "session-b" });
  await recovered.restore();
  installEnvironmentManager(recovered);
  snaps.set(pid, { pid, startedAtMs: 1, command: "/usr/bin/unrelated", envToken: "ff".repeat(16) });
  const before = signals.length;
  const stopped = await fetch(url(`/projects/environment/app/stop?path=${encodeURIComponent(root)}`), {
    method: "POST",
    headers: auth(),
  });
  expect(stopped.status).toBe(409);
  const stoppedBody = await stopped.json() as { code: string };
  expect(stoppedBody.code).toBe("foreign-process");
  expect(signals.length).toBe(before);

  const composeProfile = {
    id: "stack",
    projectPath: root,
    name: "Stack",
    cwd: root,
    launch: { kind: "docker-compose", composeFile: "compose.yaml", projectName: "fo-external", services: ["web"] },
    stop: { kind: "compose-stop" },
    expectedPorts: [],
    healthChecks: [],
    urls: [],
    startupTimeoutMs: 1000,
    shutdownTimeoutMs: 1000,
    env: [],
  };
  const created = await fetch(url("/projects/environment"), {
    method: "POST",
    headers: auth(),
    body: JSON.stringify({ path: root, profile: composeProfile }),
  });
  expect(created.status).toBe(200);
  const composeFile = realpathSync(path.join(root, "compose.yaml"));
  containers.set("fo-external", [{
    id: "cccabcabcabc",
    service: "web",
    state: "running",
    project: "fo-external",
    workingDir: root,
    configFiles: [composeFile],
    labels: {},
  }]);
  const external = await fetch(url(`/projects/environment/stack/start?path=${encodeURIComponent(root)}`), {
    method: "POST",
    headers: auth(),
  });
  expect(external.status).toBe(409);
  expect((await external.json() as { code: string }).code).toBe("external-environment");
  expect(composeCalls.some((call) => call === "up fo-external")).toBe(false);
  const externalStop = await fetch(url(`/projects/environment/stack/stop?path=${encodeURIComponent(root)}`), {
    method: "POST",
    headers: auth(),
  });
  expect(externalStop.status).toBe(409);
  expect(composeCalls.some((call) => call === "stop fo-external")).toBe(false);
});
