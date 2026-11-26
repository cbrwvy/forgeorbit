import { describe, expect, test } from "bun:test";

import { DEFAULT_HTTP_OK_STATUSES, validateLaunchProfile } from "./profile.ts";

const dir = "/tmp/forgeorbit-env-profile";

function local(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: "app",
    projectPath: dir,
    name: "App",
    cwd: dir,
    launch: { kind: "local-process", command: { executable: "bun", args: ["run", "dev"] } },
    stop: { kind: "signal", signal: "SIGTERM", graceMs: 1_000, killAfterGrace: true, processGroup: true },
    expectedPorts: [{ host: "127.0.0.1", port: 3000 }],
    healthChecks: [
      {
        id: "web",
        kind: "http",
        url: "http://127.0.0.1:3000/",
        timeoutMs: 200,
        intervalMs: 50,
        maxAttempts: 3,
      },
    ],
    urls: [{ id: "site", name: "Website", role: "website", url: "http://127.0.0.1:3000/", healthCheckId: "web" }],
    startupTimeoutMs: 5_000,
    shutdownTimeoutMs: 2_000,
    env: [{ name: "PORT", from: "literal", value: "3000" }],
    ...overrides,
  };
}

describe("validateLaunchProfile", () => {
  test("accepts a local process profile and defaults HTTP success to 2xx", () => {
    const result = validateLaunchProfile(local());
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.profile.launch).toEqual({ kind: "local-process", command: { executable: "bun", args: ["run", "dev"] } });
    expect(result.profile.healthChecks[0]).toMatchObject({ kind: "http", required: true });
    if (result.profile.healthChecks[0]?.kind !== "http") return;
    expect(result.profile.healthChecks[0].acceptedStatuses).toEqual([...DEFAULT_HTTP_OK_STATUSES]);
    expect(result.profile.healthChecks[0].acceptedStatuses).not.toContain(500);
    expect(result.profile.urls[0]).toMatchObject({ role: "website", healthCheckId: "web", optional: false });
  });

  test("accepts an explicit non-2xx status list", () => {
    const result = validateLaunchProfile(
      local({
        healthChecks: [
          {
            id: "web",
            kind: "http",
            url: "http://127.0.0.1:3000/health",
            acceptedStatuses: [500],
            timeoutMs: 200,
            intervalMs: 0,
            maxAttempts: 1,
          },
        ],
        urls: [],
        expectedPorts: [],
      }),
    );
    expect(result.ok).toBe(true);
    if (!result.ok || result.profile.healthChecks[0]?.kind !== "http") return;
    expect(result.profile.healthChecks[0].acceptedStatuses).toEqual([500]);
  });

  test("accepts a docker compose profile", () => {
    const result = validateLaunchProfile(
      local({
        launch: { kind: "docker-compose", composeFile: "compose.yaml", projectName: "fo-example-project", services: ["web"] },
        stop: { kind: "compose-stop" },
        healthChecks: [
          {
            id: "web",
            kind: "docker-service",
            service: "web",
            timeoutMs: 200,
            intervalMs: 0,
            maxAttempts: 1,
          },
        ],
        urls: [],
        expectedPorts: [],
      }),
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.profile.launch).toMatchObject({ kind: "docker-compose", projectName: "fo-example-project" });
  });

  test("rejects a shell command string, a shell -c flag, a relative cwd, and a public health URL", () => {
    const shellString = validateLaunchProfile(
      local({ launch: { kind: "local-process", command: { executable: "bun run dev", args: [] } } }),
    );
    expect(shellString.ok).toBe(false);
    if (!shellString.ok) expect(shellString.errors.some((issue) => issue.message.includes("shell command"))).toBe(true);

    const shellFlag = validateLaunchProfile(
      local({ launch: { kind: "local-process", command: { executable: "/bin/sh", args: ["-c", "bun run dev"] } } }),
    );
    expect(shellFlag.ok).toBe(false);
    if (!shellFlag.ok) expect(shellFlag.errors.some((issue) => issue.message.includes("shell"))).toBe(true);

    const relative = validateLaunchProfile(local({ cwd: "relative/path" }));
    expect(relative.ok).toBe(false);

    const remote = validateLaunchProfile(
      local({
        healthChecks: [
          { id: "web", kind: "http", url: "https://example.com/health", timeoutMs: 200, intervalMs: 0, maxAttempts: 1 },
        ],
        urls: [],
        expectedPorts: [],
      }),
    );
    expect(remote.ok).toBe(false);
    if (!remote.ok) expect(remote.errors.some((issue) => issue.message.includes("loopback"))).toBe(true);
  });

  test("rejects a compose project without a project name and a mismatched stop strategy", () => {
    const missingName = validateLaunchProfile(
      local({
        launch: { kind: "docker-compose", composeFile: "compose.yaml" },
        stop: { kind: "compose-stop" },
        healthChecks: [],
        urls: [],
        expectedPorts: [],
      }),
    );
    expect(missingName.ok).toBe(false);

    const down = validateLaunchProfile(
      local({
        launch: { kind: "docker-compose", composeFile: "../compose.yaml", projectName: "FO-Bad" },
        stop: { kind: "compose-stop" },
        healthChecks: [],
        urls: [],
        expectedPorts: [],
      }),
    );
    expect(down.ok).toBe(false);

    const signalOnCompose = validateLaunchProfile(
      local({
        launch: { kind: "docker-compose", composeFile: "compose.yaml", projectName: "fo-app", services: [] },
        healthChecks: [],
        urls: [],
        expectedPorts: [],
      }),
    );
    expect(signalOnCompose.ok).toBe(false);
  });

  test("rejects an unimplemented kind instead of coercing it into a shell command", () => {
    const result = validateLaunchProfile(local({ launch: { kind: "makefile", target: "dev" } }));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.errors.some((issue) => issue.message.includes("not implemented"))).toBe(true);
  });
});
