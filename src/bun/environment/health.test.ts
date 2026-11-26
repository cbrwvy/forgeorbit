import { afterEach, expect, test } from "bun:test";
import net from "node:net";

import type { HealthCheck } from "../../shared/environment/types.ts";
import { createDefaultHealthProbes, runHealthChecks, tcpConnect, type HealthProbes } from "./health.ts";

const servers: { stop: () => void }[] = [];

afterEach(() => {
  for (const server of servers) server.stop();
  servers.length = 0;
});

function check(overrides: Partial<Extract<HealthCheck, { kind: "http" }>> & { kind: "http" }): HealthCheck {
  return {
    id: "web",
    url: "http://127.0.0.1/",
    method: "GET",
    acceptedStatuses: [200],
    timeoutMs: 500,
    intervalMs: 0,
    maxAttempts: 2,
    required: true,
    ...overrides,
  };
}

function input(checks: HealthCheck[], probes: HealthProbes, signal = new AbortController().signal) {
  return {
    checks,
    signal,
    deadlineAt: Date.now() + 5_000,
    now: () => Date.now(),
    sleep: async () => {},
    probes,
    pid: 42,
  };
}

test("HTTP 200 passes and HTTP 500 fails unless that status was requested", async () => {
  let status = 200;
  const probes: HealthProbes = {
    tcp: async () => {},
    http: async () => ({ status }),
    processAlive: async () => true,
    dockerService: async () => ({ state: "running", detail: "running" }),
  };
  const ok = await runHealthChecks(input([check({ kind: "http", url: "http://127.0.0.1:9/" })], probes));
  expect(ok.ok).toBe(true);
  expect(ok.outcomes[0]?.detail).toContain("200");

  status = 500;
  const failed = await runHealthChecks(input([check({ kind: "http", url: "http://127.0.0.1:9/" })], probes));
  expect(failed.ok).toBe(false);
  expect(failed.code).toBe("health-failed");
  expect(failed.detail).toContain("500");

  const explicit = await runHealthChecks(
    input([check({ kind: "http", url: "http://127.0.0.1:9/", acceptedStatuses: [500] })], probes),
  );
  expect(explicit.ok).toBe(true);
});

test("a real loopback HTTP server and a refused TCP port are reported", async () => {
  const http = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch(request) {
      if (new URL(request.url).pathname === "/fail") return new Response("no", { status: 500 });
      return new Response("ok", { status: 200 });
    },
  });
  servers.push({ stop: () => http.stop(true) });
  const port = http.port;
  if (port === undefined) throw new Error("http server did not bind a port");
  const probes = {
    ...createDefaultHealthProbes(),
    processAlive: async () => true,
    dockerService: async () => ({ state: "running", detail: "running" }),
  };
  const passed = await runHealthChecks(
    input([check({ kind: "http", url: `http://127.0.0.1:${port}/` })], probes),
  );
  expect(passed.ok).toBe(true);

  const failed = await runHealthChecks(
    input([check({ kind: "http", url: `http://127.0.0.1:${port}/fail`, maxAttempts: 1 })], probes),
  );
  expect(failed.ok).toBe(false);
  expect(failed.detail).toContain("500");

  const tcp = await runHealthChecks(
    input(
      [
        {
          id: "port",
          kind: "tcp",
          host: "127.0.0.1",
          port,
          timeoutMs: 500,
          intervalMs: 0,
          maxAttempts: 1,
          required: true,
        },
      ],
      probes,
    ),
  );
  expect(tcp.ok).toBe(true);

  const refused = await runHealthChecks(
    input(
      [
        {
          id: "port",
          kind: "tcp",
          host: "127.0.0.1",
          port: 1,
          timeoutMs: 300,
          intervalMs: 0,
          maxAttempts: 1,
          required: true,
        },
      ],
      probes,
    ),
  );
  expect(refused.ok).toBe(false);
  expect(refused.code).toBe("health-failed");
});

test("TCP connect is refused for a non-loopback host before a socket opens", async () => {
  await expect(tcpConnect("example.com", 80, 200, new AbortController().signal)).rejects.toThrow(/loopback/);
});

test("cancellation stops further attempts", async () => {
  const controller = new AbortController();
  let attempts = 0;
  const probes: HealthProbes = {
    tcp: async () => {
      attempts += 1;
      controller.abort();
      throw new Error("cancelled");
    },
    http: async () => ({ status: 200 }),
    processAlive: async () => false,
    dockerService: async () => ({ state: null, detail: "missing" }),
  };
  const result = await runHealthChecks(
    input(
      [
        {
          id: "port",
          kind: "tcp",
          host: "127.0.0.1",
          port: 9,
          timeoutMs: 200,
          intervalMs: 1_000,
          maxAttempts: 5,
          required: true,
        },
      ],
      probes,
      controller.signal,
    ),
  );
  expect(result.code).toBe("cancelled");
  expect(attempts).toBe(1);
});

test("a probe error is kept on the outcome", async () => {
  const probes: HealthProbes = {
    tcp: async () => {
      throw new Error("connect ECONNREFUSED 127.0.0.1:9");
    },
    http: async () => {
      throw new Error("connect ECONNREFUSED");
    },
    processAlive: async () => false,
    dockerService: async () => ({ state: "exited", detail: "service web is exited" }),
  };
  const result = await runHealthChecks(
    input(
      [
        check({ kind: "http", url: "http://127.0.0.1:9/", maxAttempts: 1 }),
        {
          id: "web",
          kind: "docker-service",
          service: "web",
          timeoutMs: 200,
          intervalMs: 0,
          maxAttempts: 1,
          required: true,
        },
      ],
      probes,
    ),
  );
  expect(result.ok).toBe(false);
  expect(result.detail).toContain("ECONNREFUSED");
  expect(result.outcomes[1]?.detail).toContain("exited");
});

test("a listening TCP socket accepts the tcp check and closes", async () => {
  const sockets = new Set<net.Socket>();
  const server = net.createServer((socket) => {
    sockets.add(socket);
    socket.end();
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  servers.push({
    stop: () => {
      for (const socket of sockets) socket.destroy();
      server.close();
    },
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("expected a tcp port");
  const probes = {
    ...createDefaultHealthProbes(),
    processAlive: async () => true,
    dockerService: async () => ({ state: null, detail: "" }),
  };
  const result = await runHealthChecks(
    input(
      [
        {
          id: "port",
          kind: "tcp",
          host: "127.0.0.1",
          port: address.port,
          timeoutMs: 500,
          intervalMs: 0,
          maxAttempts: 1,
          required: true,
        },
      ],
      probes,
    ),
  );
  expect(result.ok).toBe(true);
});
