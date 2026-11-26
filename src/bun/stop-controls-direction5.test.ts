/**
 * Direction 5: what each Stop control affects, and that none of them reopens or clears another.
 * Backend only (fake Codex driver, no process, no provider). Three registered projects in three states, a manually
 * started task that outlives an Emergency Stop, restart-style recovery, and repeated actions.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { makeTask } from "../cli/test-fixtures.ts";

const DATA_DIR = mkdtempSync(path.join(tmpdir(), "fo-stop-controls-d5-"));
process.env.AGETOR_DATA_DIR = DATA_DIR;
process.env.AGETOR_API_PORT = "4797";
process.env.AGETOR_ALLOW_LEGACY_QUEUE_POLICY_SCHEMA = "1";
process.env.AGETOR_CODEX_DRIVER = "fake";
process.env.AGETOR_CODEX_BIN = "/bin/echo";
process.env.AGETOR_FAKE_CODEX_RESOLVE_DELAY_MS = "20";

let server: { stop: () => void };
let token: string;
let db: typeof import("./db.ts").db;
let tasks: typeof import("./db.ts").tasks;
let runs: typeof import("./db.ts").runs;
let projects: typeof import("./db.ts").projects;
let startTask: typeof import("./orchestrator.ts").startTask;
let recoverAutonomy: typeof import("./autonomy/coordinator.ts").recoverAutonomy;
const dirs: string[] = [];

beforeAll(async () => {
  ({ db, tasks, runs, projects } = await import("./db.ts"));
  const { harnesses } = await import("./db.ts");
  harnesses.setEnabled("codex", true);
  ({ startTask } = await import("./orchestrator.ts"));
  ({ recoverAutonomy } = await import("./autonomy/coordinator.ts"));
  const { startApiServer, API_TOKEN } = await import("./server.ts");
  server = startApiServer() as unknown as { stop: () => void };
  token = API_TOKEN;
});
afterAll(() => {
  server?.stop?.();
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
  rmSync(DATA_DIR, { recursive: true, force: true });
});

const url = (p: string) => `http://127.0.0.1:4797${p}`;
const headers = () => ({ authorization: `Bearer ${token}`, "content-type": "application/json" });
async function post(route: string, body: unknown = {}) {
  const res = await fetch(url(route), { method: "POST", headers: headers(), body: JSON.stringify(body) });
  return { status: res.status, json: (await res.json()) as any };
}
async function get(route: string) {
  const res = await fetch(url(route), { headers: headers() });
  return { status: res.status, json: (await res.json()) as any };
}
const lifecycleOf = async (dir: string) => (await get(`/projects/lifecycle?path=${encodeURIComponent(dir)}`)).json.lifecycle;

function project(name: string): string {
  const dir = realpathSync(mkdtempSync(path.join(tmpdir(), `fo-d5-${name}-`)));
  dirs.push(dir);
  execFileSync("git", ["init", "-q"], { cwd: dir });
  writeFileSync(path.join(dir, "README.md"), `# ${name}\n`);
  projects.upsert(dir, name);
  return dir;
}
function task(workdir: string, title: string) {
  const now = Date.now();
  return tasks.insert(makeTask({ id: randomUUID(), title, prompt: `Do ${title}`, column: "ready", agent: "codex" as "codex", model: "gpt-5.3-codex", effort: "medium", mode: "auto", isolation: "none", workdir, createdAt: now, updatedAt: now }));
}
async function waitUntil(predicate: () => boolean | Promise<boolean>, timeoutMs = 6000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) { if (await predicate()) return; await Bun.sleep(25); }
  throw new Error("Timed out waiting for condition.");
}
const runCount = (taskId: string) => runs.listForTask(taskId).length;

describe("Direction 5 — Stop controls are distinct, scoped and independent", () => {
  test("three projects in three states: each launch follows its own project, repeated actions change nothing", async () => {
    const a = project("running");
    const b = project("draining");
    const c = project("paused");
    const ta = task(a, "task in running project");
    const tb = task(b, "in-flight task in draining project");
    const tb2 = task(b, "queued task in draining project");
    const tc = task(c, "task in paused project");

    process.env.AGETOR_FAKE_CODEX_RESOLVE_DELAY_MS = "700";
    try {
      const live = await startTask(tb.id);
      expect("runId" in live).toBe(true);
      expect((await post("/projects/lifecycle/stop", { path: b })).json.lifecycle.state).toBe("draining");
      expect((await post("/projects/lifecycle/stop", { path: c })).json.lifecycle.state).toBe("paused");

      // Three different states at once, read from the persisted records.
      expect((await lifecycleOf(a)).state).toBe("running");
      expect((await lifecycleOf(b)).state).toBe("draining");
      expect((await lifecycleOf(b)).activeExecutions).toBe(1);
      expect((await lifecycleOf(c)).state).toBe("paused");
      const listed = (await get("/projects")).json as Array<{ path: string; lifecycle?: { state: string } }>;
      expect(Object.fromEntries(listed.filter((p) => [a, b, c].includes(p.path)).map((p) => [p.path, p.lifecycle?.state]))).toEqual({ [a]: "running", [b]: "draining", [c]: "paused" });

      // Launches: only the running project admits work. The refusals say why and create no run.
      const refusedB = await startTask(tb2.id);
      const refusedC = await startTask(tc.id);
      expect("error" in refusedB && refusedB.error).toMatch(/draining/i);
      expect("error" in refusedC && refusedC.error).toMatch(/paused|resume/i);
      expect(runCount(tb2.id)).toBe(0);
      expect(runCount(tc.id)).toBe(0);
      const okA = await startTask(ta.id);
      expect("runId" in okA).toBe(true);

      // Repeated and mixed actions: idempotent where the state already holds, refused with a code where it cannot apply.
      const stopC = await post("/projects/lifecycle/stop", { path: c });
      expect(stopC.status).toBe(200);
      expect(stopC.json.changed).toBe(false);
      const stopB = await post("/projects/lifecycle/stop", { path: b });
      expect(stopB.json.changed).toBe(false);
      expect(stopB.json.lifecycle.state).toBe("draining");
      const startB = await post("/projects/lifecycle/start", { path: b });
      expect(startB.status).toBe(409);
      expect(startB.json.code).toBe("draining-active-work");
      const startA = await post("/projects/lifecycle/start", { path: a });
      expect(startA.status).toBe(200);
      expect(startA.json.changed).toBe(false);
      expect((await lifecycleOf(a)).state).toBe("running");

      // The draining project settles by itself once its run ends, and only to Paused (never back to Running).
      await waitUntil(async () => (await lifecycleOf(b)).state === "paused");
      expect(runs.get((live as { runId: string }).runId)?.status).toBe("succeeded");
      expect(tasks.get(tb2.id)?.column).toBe("ready");
      expect(runCount(tb2.id)).toBe(0);
      // Starting a project reopens admission only; the queued task is not started because the gate opened.
      const resumed = await post("/projects/lifecycle/start", { path: b });
      expect(resumed.json.lifecycle.state).toBe("running");
      await Bun.sleep(300);
      expect(runCount(tb2.id)).toBe(0);
      expect(runCount(tc.id)).toBe(0);
    } finally {
      process.env.AGETOR_FAKE_CODEX_RESOLVE_DELAY_MS = "20";
    }
  });

  test("Emergency Stop is company-level, leaves manually started work and project states alone, says what it did not stop, and nothing reopens or clears another control", async () => {
    // The previous test's runs must be finished: the count below is of what is live now.
    await waitUntil(() => db.query<{ n: number }, []>("SELECT count(*) AS n FROM runs WHERE status = 'running'").get()!.n === 0);
    const a = project("e-running");
    const b = project("e-paused");
    const manual = task(a, "manual task left running");
    const waiting = task(b, "task waiting in a paused project");
    await post("/projects/lifecycle/stop", { path: b });

    process.env.AGETOR_FAKE_CODEX_RESOLVE_DELAY_MS = "900";
    try {
      const started = await startTask(manual.id);
      expect("runId" in started).toBe(true);
      const runId = (started as { runId: string }).runId;
      expect(runs.get(runId)?.status).toBe("running");

      // One Emergency Stop. Autonomous work only: the manual run is not cancelled, and the answer says it was left running.
      const stop = await post("/api/autonomy/emergency-stop", { reason: "test" });
      expect(stop.status).toBe(200);
      expect(stop.json.status.emergency.active).toBe(true);
      expect(stop.json.outstanding).not.toContain(runId);
      expect(stop.json.status.emergency.leftRunning).toBe(1);
      expect(runs.get(runId)?.status).toBe("running");
      expect(tasks.get(manual.id)?.column).toBe("running");
      // Project states are separate controls: unchanged.
      expect((await lifecycleOf(a)).state).toBe("running");
      expect((await lifecycleOf(b)).state).toBe("paused");

      // The status read reports the same live number, and drops it when the manual run ends. It never reports it as stopped.
      expect((await get("/api/autonomy/status")).json.emergency.leftRunning).toBe(1);
      await waitUntil(() => runs.get(runId)?.status === "succeeded");
      await waitUntil(async () => (await get("/api/autonomy/status")).json.emergency.leftRunning === 0);

      // Restart-style recovery with the stop on: the flag survives, nothing is relaunched.
      await recoverAutonomy();
      expect((await get("/api/autonomy/status")).json.emergency.active).toBe(true);

      // Starting the paused project does not lift the Emergency Stop.
      const startB = await post("/projects/lifecycle/start", { path: b });
      expect(startB.json.lifecycle.state).toBe("running");
      expect((await get("/api/autonomy/status")).json.emergency.active).toBe(true);
      expect(runCount(waiting.id)).toBe(0);

      // Stop the project again, then lift the Emergency Stop: the project stays stopped and nothing starts.
      await post("/projects/lifecycle/stop", { path: b });
      const cleared = await post("/api/autonomy/emergency-stop/clear");
      expect(cleared.json.status.emergency.active).toBe(false);
      expect(cleared.json.status.emergency.leftRunning).toBe(0);
      expect((await lifecycleOf(b)).state).toBe("paused");
      const refused = await startTask(waiting.id);
      expect("error" in refused).toBe(true);
      expect(runCount(waiting.id)).toBe(0);
      await Bun.sleep(300);
      expect(runCount(waiting.id)).toBe(0);
    } finally {
      process.env.AGETOR_FAKE_CODEX_RESOLVE_DELAY_MS = "20";
      await post("/api/autonomy/emergency-stop/clear");
    }
  });
});
