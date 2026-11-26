/**
 * Request failure boundary (FO-UPGRADE02 follow-up).
 *
 * `GET /tasks/:id/supervised-workflow` used to let an exception escape into the backend Worker,
 * which stopped the whole app. These tests run the real API server inside a Worker, as the app
 * does, against a synthetic profile, and check for each kind of failure that
 *   - the request fails alone (a client error for a malformed id, a 500 with a diagnostic id for
 *     an unexpected exception),
 *   - the same process and the same Worker keep serving a valid request afterwards (no Worker
 *     error or exit event, same pid),
 *   - the normal response is unchanged and authorization is still checked first,
 *   - the diagnostic line carries no message, query, id or title.
 */
import { afterAll, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { migrate } from "./migrate.ts";
import { migrations } from "./migrations/index.ts";
import { diagnosticFor, failedRequestResponse, maskPath, serverErrorResponse, stackFrames } from "./http-boundary.ts";

describe("http-boundary helpers", () => {
  test("paths keep their shape and lose ids", () => {
    expect(maskPath("/tasks/8f2c1d3e-1111-4222-8333-444455556666/supervised-workflow")).toBe("/tasks/:x/supervised-workflow");
    expect(maskPath("/tasks/plainword/supervised-workflow")).toBe("/tasks/:x/supervised-workflow");
    expect(maskPath("/project-manager/executions/abc123/approve")).toBe("/project-manager/executions/:x/approve");
    expect(maskPath("/health")).toBe("/health");
  });

  test("a diagnostic names the class and frames but never the message", () => {
    const secret = "Quarterly roadmap for ACME at /Users/someone/private/plan.md";
    const err = new TypeError(secret);
    const { id, line } = diagnosticFor(err, "get", "/tasks/8f2c1d3e-1111-4222-8333-444455556666/supervised-workflow");
    expect(id).toMatch(/^[0-9a-f]{8}$/);
    expect(line).toContain("[http] request failed");
    expect(line).toContain("GET /tasks/:x/supervised-workflow");
    expect(line).toContain("TypeError");
    expect(line).not.toContain("ACME");
    expect(line).not.toContain("/Users/");
    expect(line).not.toContain("8f2c1d3e");
    expect(stackFrames(err).length).toBeGreaterThan(0);
    for (const frame of stackFrames(err)) expect(frame).toMatch(/^[\w.$<>]+ \([^/\\:()]+:\d+\)$/);
  });

  test("responses are a 500 with an id and nothing else", async () => {
    const quiet = console.error;
    const lines: string[] = [];
    console.error = (...args: unknown[]) => { lines.push(args.join(" ")); };
    try {
      const response = failedRequestResponse(new Request("http://127.0.0.1/tasks/abc123/x?token=SECRET"), new Error("boom with private text"), { "x-test": "1" });
      expect(response.status).toBe(500);
      expect(response.headers.get("x-test")).toBe("1");
      const body = (await response.json()) as Record<string, string>;
      expect(Object.keys(body).sort()).toEqual(["diagnosticId", "error"]);
      expect(body.error).toBe("Internal error.");
      expect(lines.join("\n")).toContain(body.diagnosticId!);
      expect(lines.join("\n")).not.toContain("private text");
      expect(lines.join("\n")).not.toContain("SECRET");
      expect(serverErrorResponse(new Error("x")).status).toBe(500);
    } finally {
      console.error = quiet;
    }
  });
});

// ── The real server, inside a Worker ─────────────────────────────────────────

const ROOT = mkdtempSync(path.join(tmpdir(), "fo-request-boundary-"));
const TASK_OK = "6f1d9d9e-2c3b-4a55-9a52-0d3f3a1f2b01";
const TASK_BAD_ID = "not-a-uuid-task";
const children: Array<ReturnType<typeof Bun.spawn>> = [];
let nextPort = 46600 + Math.floor(Math.random() * 300);

function makeProfile(name: string, breakEmployeeRuns: boolean): string {
  const dir = path.join(ROOT, name);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const db = new Database(path.join(dir, "agetor.sqlite"));
  db.run("PRAGMA journal_mode = WAL;");
  migrate(db, migrations);
  const now = Date.now();
  const insert = (id: string) =>
    db.run(
      `INSERT INTO tasks (id, title, prompt, "column", agent, workdir, created_at, updated_at, isolation, mode, model, refs)
       VALUES (?, 'Synthetic title', 'Synthetic prompt', 'backlog', 'codex', ?, ?, ?, 'none', 'auto', NULL, '[]')`,
      [id, dir, now, now],
    );
  insert(TASK_OK);
  insert(TASK_BAD_ID);
  // A controlled unexpected exception: the table the live-workflow read model queries is gone.
  if (breakEmployeeRuns) db.run("DROP TABLE employee_executions");
  db.close();
  return dir;
}

interface Backend { port: number; token: string; pid: number; workerEvents: () => string[]; stderr: () => string; stop: () => Promise<void> }

async function startBackend(dataDir: string): Promise<Backend> {
  const port = nextPort++;
  const serverModule = path.resolve(import.meta.dir, "server.ts");
  const nativeModule = path.resolve(import.meta.dir, "test-native.ts");
  const workerFile = path.join(dataDir, "worker.ts");
  const hostFile = path.join(dataDir, "host.ts");
  const readyFile = path.join(dataDir, "ready.json");
  const eventsFile = path.join(dataDir, "worker-events.txt");
  writeFileSync(
    workerFile,
    `import { startApiServer, API_TOKEN } from ${JSON.stringify(serverModule)};
import { makeTestNative } from ${JSON.stringify(nativeModule)};
startApiServer({ native: makeTestNative() });
postMessage({ token: API_TOKEN });
`,
  );
  writeFileSync(
    hostFile,
    `import { appendFileSync, writeFileSync } from "node:fs";
const worker = new Worker(${JSON.stringify(workerFile)});
worker.addEventListener("message", (e) => writeFileSync(${JSON.stringify(readyFile)}, JSON.stringify({ token: e.data.token, pid: process.pid })));
worker.addEventListener("error", (e) => appendFileSync(${JSON.stringify(eventsFile)}, "error:" + (e.message ?? "") + "\\n"));
worker.addEventListener("close", () => appendFileSync(${JSON.stringify(eventsFile)}, "close\\n"));
setInterval(() => {}, 1000);
`,
  );
  const child = Bun.spawn([process.execPath, "run", hostFile], {
    cwd: path.resolve(import.meta.dir, "..", ".."),
    env: { ...process.env, NODE_ENV: "test", FORGEORBIT_DATA_DIR: dataDir, AGETOR_DATA_DIR: dataDir, AGETOR_API_PORT: String(port), FORGEORBIT_API_PORT: String(port), AGETOR_USAGE_OFFLINE: "1", AGETOR_DISABLE_UPDATES: "1" },
    stdout: "pipe",
    stderr: "pipe",
  });
  children.push(child);
  let stderr = "";
  void (async () => {
    const reader = (child.stderr as ReadableStream<Uint8Array>).getReader();
    try { for (;;) { const { done, value } = await reader.read(); if (done) break; stderr += new TextDecoder().decode(value); } } catch { /* ignore */ }
  })();
  const deadline = Date.now() + 60_000;
  while (!existsSync(readyFile)) {
    if (Date.now() > deadline || child.exitCode !== null) throw new Error(`backend did not start: ${stderr.slice(-600)}`);
    await Bun.sleep(100);
  }
  const ready = JSON.parse(readFileSync(readyFile, "utf8")) as { token: string; pid: number };
  while (!(await fetch(`http://127.0.0.1:${port}/health`).then((r) => r.ok).catch(() => false))) {
    if (Date.now() > deadline) throw new Error("backend did not answer /health");
    await Bun.sleep(100);
  }
  return {
    port,
    token: ready.token,
    pid: ready.pid,
    workerEvents: () => (existsSync(eventsFile) ? readFileSync(eventsFile, "utf8").split("\n").filter(Boolean) : []),
    stderr: () => stderr,
    stop: async () => { child.kill("SIGTERM"); await Promise.race([child.exited, Bun.sleep(5000)]); },
  };
}

const call = (b: Backend, route: string, init: RequestInit = {}, withToken = true) =>
  fetch(`http://127.0.0.1:${b.port}${route}`, { ...init, headers: { ...(withToken ? { authorization: `Bearer ${b.token}` } : {}), ...(init.headers ?? {}) } });

afterAll(async () => {
  for (const child of children) { try { child.kill("SIGKILL"); } catch { /* gone */ } }
  rmSync(ROOT, { recursive: true, force: true });
});

describe("GET /tasks/:id/supervised-workflow", () => {
  test("a normal response is unchanged, authorization is still first, and a malformed id is a client error", async () => {
    const backend = await startBackend(makeProfile("intact", false));
    try {
      const route = (id: string) => `/tasks/${id}/supervised-workflow`;

      // Authorization first: no token, no handler.
      expect((await call(backend, route(TASK_OK), {}, false)).status).toBe(401);

      // The normal workflow response.
      const ok = await call(backend, route(TASK_OK));
      expect(ok.status).toBe(200);
      const body = (await ok.json()) as Record<string, any>;
      expect(body.taskId).toBe(TASK_OK);
      expect(body.implementer).toBeNull();
      expect(body.implementation).toEqual({ harness: "codex", model: null });
      expect(body.latestEmployeeRunPhase).toBeNull();
      expect(body.qc.reviews).toEqual([]);
      expect(body.usesFakeDriver).toBe(false);
      const shape = ["columnBlock", "implementation", "implementer", "latestEmployeeRunPhase", "ownerAction", "phase", "qc", "qcAttention", "steps", "taskId", "usesFakeDriver"];
      expect(Object.keys(body).sort()).toEqual(shape); // exact, unchanged shape
      expect(body.phase).toBe("backlog-draft");
      expect(body).not.toHaveProperty("diagnosticId");

      // A task that exists under a malformed id: the assignment core rejects it: client error, not a crash.
      const malformed = await call(backend, route(TASK_BAD_ID));
      expect(malformed.status).toBe(400);
      expect(((await malformed.json()) as { error: string }).error).toBe("Invalid taskId.");
      expect(backend.workerEvents()).toEqual([]);

      // An unknown id is still a 404.
      const missing = await call(backend, route("00000000-0000-4000-8000-000000000000"));
      expect(missing.status).toBe(404);

      // The same process still serves, and the normal response did not change.
      const again = await call(backend, route(TASK_OK));
      expect(again.status).toBe(200);
      expect(Object.keys((await again.json()) as object).sort()).toEqual(shape);
      expect(backend.workerEvents()).toEqual([]);
    } finally {
      await backend.stop();
    }
  }, 120_000);

  test("an unexpected exception fails only that request and leaves a diagnostic without private data", async () => {
    const backend = await startBackend(makeProfile("faulty", true));
    try {
      const pidBefore = backend.pid;
      for (let attempt = 0; attempt < 3; attempt++) {
        const failed = await call(backend, `/tasks/${TASK_OK}/supervised-workflow`);
        expect(failed.status).toBe(500);
        const body = (await failed.json()) as Record<string, string>;
        expect(Object.keys(body).sort()).toEqual(["diagnosticId", "error"]);
        expect(body.error).toBe("Internal error.");
        expect(body.diagnosticId).toMatch(/^[0-9a-f]{8}$/);

        // The same backend, with no restart, still answers a valid request.
        const valid = await call(backend, "/tasks");
        expect(valid.status).toBe(200);
        expect(Array.isArray(await valid.json())).toBe(true);
        expect(backend.workerEvents()).toEqual([]);
      }
      // Browser-style failure: CORS headers survive on the failed response (the webview must be able to read it).
      const cors = await call(backend, `/tasks/${TASK_OK}/supervised-workflow`, { headers: { origin: "views://mainview" } });
      expect(cors.status).toBe(500);

      // Diagnostic: the id came back in the log, the class and the masked route are there, private data is not.
      const log = backend.stderr();
      expect(log).toContain("[http] request failed");
      expect(log).toContain("GET /tasks/:x/supervised-workflow");
      expect(log).not.toContain(TASK_OK);
      expect(log).not.toContain("Synthetic title");
      expect(log).not.toContain("Synthetic prompt");
      expect(log).not.toContain("no such table"); // the error message is not logged
      expect(backend.pid).toBe(pidBefore);
    } finally {
      await backend.stop();
    }
  }, 120_000);

  test("without the boundary the same fault stops the Worker (the failure being prevented)", async () => {
    // A server whose route handler throws and which has neither `authed`'s catch nor an `error` hook.
    const dir = path.join(ROOT, "unguarded");
    mkdirSync(dir, { recursive: true });
    const workerFile = path.join(dir, "w.ts");
    writeFileSync(workerFile, `const s = Bun.serve({ port: 0, development: false, routes: { "/ok": () => new Response("ok"), "/boom": async () => { throw new Error("x"); } } }); postMessage({ port: s.port });`);
    const worker = new Worker(workerFile);
    const events: string[] = [];
    worker.addEventListener("error", () => events.push("error"));
    const port: number = await new Promise((resolve) => worker.addEventListener("message", (e: MessageEvent) => resolve((e.data as { port: number }).port)));
    await fetch(`http://127.0.0.1:${port}/boom`).catch(() => null);
    await Bun.sleep(300);
    expect(events).toContain("error");
    worker.terminate();
  }, 60_000);
});
