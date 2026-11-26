import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

/**
 * FO-005C.1 autonomous execution core: structured dependencies and
 * priorities, approved execution batches, the scheduler, pause / resume /
 * cancel, recovery after a restart, spending policy and project isolation.
 * Every agent is a fake driver (`AGETOR_CODEX_DRIVER=fake`) on an isolated
 * SQLite — no real CLI runs and no AI quota is spent. Cursor points at a
 * missing binary to exercise "not available".
 */

const DATA_DIR = mkdtempSync(path.join(tmpdir(), "fo005c-batch-"));
process.env.AGETOR_DATA_DIR = DATA_DIR;
process.env.AGETOR_API_PORT = "4675";
process.env.AGETOR_CODEX_DRIVER = "fake";
process.env.AGETOR_CODEX_BIN = "/bin/echo";
process.env.AGETOR_CURSOR_BIN = "/nonexistent/cursor-agent";
process.env.AGETOR_TMUX_BIN = "/bin/echo";
// The spending policy reads variable names; keep the developer's own
// shell out of the results.
for (const name of ["OPENAI_API_KEY", "CODEX_API_KEY", "OPENAI_BASE_URL", "OPENAI_API_BASE"]) delete process.env[name];

let base = "";
let token = "";
let server: { stop: () => void };
let db: typeof import("./db.ts");
let batches: typeof import("./execution-batches.ts");
let exec: typeof import("./project-execution.ts");
let orchestrator: typeof import("./orchestrator.ts");
let consent = "";

beforeAll(async () => {
  db = await import("./db.ts");
  batches = await import("./execution-batches.ts");
  exec = await import("./project-execution.ts");
  orchestrator = await import("./orchestrator.ts");
  const runner = await import("./pipeline-runner.ts");
  runner.initPipelineRunner();
  batches.initExecutionBatches();
  const started = await import("./server.ts");
  token = started.API_TOKEN;
  server = started.startApiServer() as unknown as { stop: () => void };
  base = `http://127.0.0.1:${process.env.AGETOR_API_PORT}`;
  db.harnesses.setEnabled("codex", true);
  db.harnesses.setEnabled("cursor", true);
  const preflight = await call("POST", "/project-interviews/preflight", { harness: "codex", model: "gpt-6.1-sol" });
  consent = preflight.json.isolation.consentKey;
});

afterAll(() => {
  batches.stopExecutionBatchTimers();
  server?.stop?.();
});

beforeEach(async () => {
  await batches.__testing.settle();
  exec.__testing.reset();
  batches.__testing.setEventDeps({});
  delete process.env.AGETOR_FAKE_CODEX_RESOLVE_DELAY_MS;
});

async function call(method: string, route: string, body?: unknown): Promise<{ status: number; json: any }> {
  const res = await fetch(`${base}${route}`, {
    method,
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: res.status, json: await res.json().catch(() => null) };
}

const q = (p: string) => `path=${encodeURIComponent(p)}`;

function newProject(name: string): string {
  const dir = realpathSync(mkdtempSync(path.join(tmpdir(), "fo005c-proj-")));
  writeFileSync(path.join(dir, "README.md"), `# ${name}\n`);
  db.projects.upsert(dir, name);
  return dir;
}

async function newTask(dir: string, title: string, fields: Record<string, unknown> = {}): Promise<string> {
  const created = await orchestrator.createTask({
    title,
    prompt: `${title}.\n\n## Acceptance criteria\n- It works`,
    workdir: dir,
    column: "ready",
    agent: "codex",
    model: "gpt-6.1-sol",
    isolation: "none",
    ...fields,
  } as never);
  if ("error" in created) throw new Error(created.error);
  return created.task.id;
}

async function link(dir: string, taskId: string, dependsOn: string[]) {
  return call("PUT", `/project-manager/tasks/${taskId}/scheduling`, { path: dir, dependsOn });
}

async function prioritize(dir: string, taskId: string, priority: string) {
  const res = await call("PUT", `/project-manager/tasks/${taskId}/scheduling`, { path: dir, priority });
  expect(res.status).toBe(200);
}

/** The owner confirmed codex has no paid overage: the default spending
 *  policy (no-extra) then allows it. */
const OK_POLICY = { noOverageHarnessIds: ["codex"] };

async function draft(dir: string, taskIds: string[], policy: Record<string, unknown> = {}): Promise<any> {
  const res = await call("POST", "/project-manager/batches", { path: dir, taskIds, policy: { ...OK_POLICY, ...policy } });
  expect(res.status).toBe(201);
  return res.json;
}

async function approveB(dir: string, batch: any, extra: Record<string, unknown> = {}) {
  return call("POST", `/project-manager/batches/${batch.id}/approve`, { path: dir, revision: batch.revision, previewKey: batch.preview?.key, ...extra });
}

async function approved(dir: string, taskIds: string[], policy: Record<string, unknown> = {}): Promise<any> {
  const d = await draft(dir, taskIds, policy);
  expect(d.preview.canApprove).toBe(true);
  const res = await approveB(dir, d);
  expect(res.status).toBe(200);
  return res.json.batch;
}

async function startB(dir: string, id: string) {
  return call("POST", `/project-manager/batches/${id}/start`, { path: dir });
}

async function getB(dir: string, id: string): Promise<any> {
  const res = await call("GET", `/project-manager/batches/${id}?${q(dir)}`);
  expect(res.status).toBe(200);
  return res.json;
}

async function waitFor<T>(read: () => T | Promise<T>, ok: (value: T) => boolean, label: string, tries = 400): Promise<T> {
  let last: T | undefined;
  for (let i = 0; i < tries; i++) {
    last = await read();
    if (ok(last)) return last;
    await Bun.sleep(20);
  }
  throw new Error(`timed out waiting for ${label}: ${JSON.stringify(last)?.slice(0, 600)}`);
}

const stateOf = (view: any, taskId: string) => view.entries.find((e: any) => e.taskId === taskId)?.state;
const runsOf = (taskId: string) => db.runs.listForTask(taskId).length;

async function accept(dir: string, batchId: string, taskId: string) {
  const view = await getB(dir, batchId);
  const entry = view.entries.find((e: any) => e.taskId === taskId);
  const executionId = entry.attempts.at(-1).executionId;
  const res = await call("POST", `/project-manager/executions/${executionId}/review`, { path: dir, action: "accept" });
  expect(res.status).toBe(200);
}

async function waitState(dir: string, batchId: string, taskId: string, state: string) {
  return waitFor(() => getB(dir, batchId), (v) => stateOf(v, taskId) === state, `${taskId.slice(0, 8)} ${state}`);
}

test("every scheduling and batch route requires the API token", async () => {
  const routes: [string, string][] = [
    ["GET", "/project-manager/scheduling?path=x"],
    ["PUT", "/project-manager/tasks/x/scheduling"],
    ["GET", "/project-manager/batches?path=x"],
    ["POST", "/project-manager/batches"],
    ["GET", "/project-manager/batches/x?path=x"],
    ["PATCH", "/project-manager/batches/x"],
    ["POST", "/project-manager/batches/x/preview"],
    ["POST", "/project-manager/batches/x/approve"],
    ["POST", "/project-manager/batches/x/start"],
    ["POST", "/project-manager/batches/x/pause"],
    ["POST", "/project-manager/batches/x/resume"],
    ["POST", "/project-manager/batches/x/cancel"],
    ["POST", "/project-manager/batches/x/stop-runs"],
    ["POST", "/project-manager/batches/x/tasks/y/release"],
    ["GET", "/project-manager/batches/x/events?path=x"],
    ["POST", "/project-manager/proposals/x/batch"],
  ];
  for (const [method, route] of routes) {
    const res = await fetch(`${base}${route}`, { method, body: method === "GET" ? undefined : "{}" });
    expect(res.status).toBe(401);
  }
});

describe("structured dependencies and priorities", () => {
  test("links, priorities and readiness; self, cycles, foreign and missing tasks are refused", async () => {
    const dir = newProject("Deps");
    const other = newProject("Other");
    const a = await newTask(dir, "A");
    const b = await newTask(dir, "B");
    const c = await newTask(dir, "C");
    const foreign = await newTask(other, "Foreign");

    expect((await link(dir, b, [a])).status).toBe(200);
    expect((await link(dir, c, [b])).status).toBe(200);
    await prioritize(dir, c, "critical");

    const self = await link(dir, a, [a]);
    expect(self.status).toBe(409);
    expect(self.json.code).toBe("self");
    const cycle = await link(dir, a, [c]);
    expect(cycle.status).toBe(409);
    expect(cycle.json.code).toBe("cycle");
    expect(cycle.json.error).toContain("A → C → B → A");
    const cross = await link(dir, a, [foreign]);
    expect(cross.status).toBe(409);
    expect(cross.json.code).toBe("other-project");
    expect((await link(dir, a, ["no-such-task"])).status).toBe(404);
    // A task of another project can't be scheduled through this project.
    expect((await link(dir, foreign, [])).status).toBe(404);
    const badPriority = await call("PUT", `/project-manager/tasks/${a}/scheduling`, { path: dir, priority: "urgent" });
    expect(badPriority.status).toBe(400);

    const list = (await call("GET", `/project-manager/scheduling?${q(dir)}`)).json.tasks;
    const byId = (id: string) => list.find((t: any) => t.taskId === id);
    expect(byId(a)).toMatchObject({ priority: "normal", readiness: { state: "ready" }, dependents: [b] });
    expect(byId(b).readiness).toEqual({ state: "waiting", on: [a] });
    expect(byId(c)).toMatchObject({ priority: "critical", dependsOn: [{ taskId: b, done: false }] });
    // Existing tasks without rows keep working: Normal, no dependencies.
    expect(db.taskScheduling.priorityOf(foreign)).toBe("normal");
  });

  test("deleting a task removes its links instead of leaving them dangling", async () => {
    const dir = newProject("Cascade");
    const a = await newTask(dir, "A");
    const b = await newTask(dir, "B");
    expect((await link(dir, b, [a])).status).toBe(200);
    await prioritize(dir, a, "high");
    await orchestrator.deleteTask(a);
    expect(db.taskScheduling.dependenciesOf(b)).toEqual([]);
    expect(db.taskScheduling.priorityOf(a)).toBe("normal");
  });

  test("Markdown dependencies are never read as links", async () => {
    const dir = newProject("Markdown");
    const a = await newTask(dir, "A", { prompt: "Do A.\n\n## Depends on\n- B (task 1a2b3c4d)\n" });
    const list = (await call("GET", `/project-manager/scheduling?${q(dir)}`)).json.tasks;
    const row = list.find((t: any) => t.taskId === a);
    expect(row.dependsOn).toEqual([]);
    expect(row.readiness.state).toBe("ready");
    expect(row.markdownDependencies).toBe(true);
  });
});

describe("drafts, preview and approval", () => {
  test("a draft starts nothing and shows what would run, how, and when it stops", async () => {
    const dir = newProject("Draft");
    const a = await newTask(dir, "A");
    const b = await newTask(dir, "B", { mode: "ask" });
    const res = await call("POST", "/project-manager/batches", { path: dir, taskIds: [a, b] });
    expect(res.status).toBe(201);
    const batch = res.json;
    expect(batch.status).toBe("draft");
    expect(batch.policy).toMatchObject({ maxParallel: 1, maxStarts: 2, maxRetriesPerTask: 0, spending: "no-extra", reviewPolicy: "wait-for-review", onFailure: "pause" });
    const preview = batch.preview;
    expect(preview.tasks.map((t: any) => t.taskId)).toEqual([a, b]);
    expect(preview.tasks[0]).toMatchObject({ harnessLabel: "Codex", accessLevel: 3, isolation: "none" });
    expect(preview.tasks[1]).toMatchObject({ accessLevel: 0 });
    expect(preview.harnesses).toEqual([expect.objectContaining({ id: "codex", modes: expect.arrayContaining([expect.any(String)]) })]);
    expect(preview.stopConditions.join(" ")).toContain("Done");
    // Unverifiable overage is not treated as zero: it blocks approval until
    // the owner confirms the account or allows possible overage.
    const codes = preview.issues.map((i: any) => i.code);
    expect(codes).toContain("spend-overage-unverified");
    expect(codes).toContain("limits-unknown");
    expect(preview.canApprove).toBe(false);
    const refused = await approveB(dir, batch);
    expect(refused.status).toBe(409);
    expect(runsOf(a) + runsOf(b)).toBe(0);

    const edited = await call("PATCH", `/project-manager/batches/${batch.id}`, { path: dir, revision: batch.revision, policy: OK_POLICY });
    expect(edited.status).toBe(200);
    expect(edited.json.preview.canApprove).toBe(true);
    expect(edited.json.preview.issues.map((i: any) => i.code)).toContain("spend-no-overage-confirmed");
    // The approval names exactly what was previewed.
    expect((await approveB(dir, edited.json, { previewKey: "stale" })).status).toBe(409);
    expect((await approveB(dir, { ...edited.json, revision: 1 })).status).toBe(409);
    const ok = await approveB(dir, edited.json);
    expect(ok.status).toBe(200);
    expect(ok.json.batch.status).toBe("approved");
    expect(ok.json.batch.approval).toMatchObject({ allowedHarnessIds: ["codex"], maxAccessLevel: 3 });
    // Approval starts nothing either.
    expect(runsOf(a) + runsOf(b)).toBe(0);
    const again = await approveB(dir, edited.json);
    expect(again.json.alreadyApproved).toBe(true);
    const events = (await call("GET", `/project-manager/batches/${batch.id}/events?${q(dir)}`)).json.events.map((e: any) => e.kind);
    expect(events).toEqual(["created", "edited", "approved"]);
  });

  test("start without approval is refused", async () => {
    const dir = newProject("No approval");
    const a = await newTask(dir, "A");
    const batch = await draft(dir, [a]);
    const res = await startB(dir, batch.id);
    expect(res.status).toBe(409);
    expect(res.json.error).toContain("Approve");
    expect(runsOf(a)).toBe(0);
  });

  test("an approved batch can't gain tasks or change configuration", async () => {
    const dir = newProject("Frozen");
    const a = await newTask(dir, "A");
    const extra = await newTask(dir, "Extra");
    const batch = await approved(dir, [a]);
    const add = await call("PATCH", `/project-manager/batches/${batch.id}`, { path: dir, revision: batch.revision, taskIds: [a, extra] });
    expect(add.status).toBe(409);
    const conf = await call("PATCH", `/project-manager/batches/${batch.id}`, { path: dir, revision: batch.revision, configs: { [a]: { mode: "auto" } } });
    expect(conf.status).toBe(409);
    expect((await getB(dir, batch.id)).entries.map((e: any) => e.taskId)).toEqual([a]);
  });

  test("draft edits: bad tasks, configs and policies are refused", async () => {
    const dir = newProject("Edits");
    const other = newProject("Edits other");
    const a = await newTask(dir, "A");
    const foreign = await newTask(other, "Foreign");
    expect((await call("POST", "/project-manager/batches", { path: dir, taskIds: [foreign] })).status).toBe(404);
    expect((await call("POST", "/project-manager/batches", { path: dir, taskIds: [] })).status).toBe(400);
    expect((await call("POST", "/project-manager/batches", { path: dir, taskIds: [a], policy: { maxParallel: 99 } })).status).toBe(400);
    const batch = await draft(dir, [a]);
    const bad = await call("PATCH", `/project-manager/batches/${batch.id}`, { path: dir, revision: batch.revision, configs: { [a]: { harness: "nope" } } });
    expect(bad.status).toBe(400);
    const mode = await call("PATCH", `/project-manager/batches/${batch.id}`, { path: dir, revision: batch.revision, configs: { [a]: { mode: "ask" } } });
    expect(mode.status).toBe(200);
    expect(mode.json.entries[0].config.mode).toBe("ask");
    expect(mode.json.preview.tasks[0].accessLevel).toBe(0);
  });

  test("a task can't be in two approved batches", async () => {
    const dir = newProject("Two batches");
    const a = await newTask(dir, "A");
    await approved(dir, [a]);
    const second = await draft(dir, [a]);
    expect(second.preview.issues.map((i: any) => i.code)).toContain("task-in-other-batch");
    expect((await approveB(dir, second)).status).toBe(409);
  });

  test("an unavailable harness blocks approval, and the harness is never switched", async () => {
    const dir = newProject("Unavailable");
    const a = await newTask(dir, "A", { agent: "cursor", model: "grok-4.7" });
    const batch = await draft(dir, [a], { noOverageHarnessIds: ["cursor"] });
    expect(batch.preview.issues.map((i: any) => i.code)).toContain("task:harness-unavailable");
    expect((await approveB(dir, batch)).status).toBe(409);
    expect(db.tasks.get(a)!.agent).toBe("cursor");
    expect(runsOf(a)).toBe(0);
  });
});

describe("spending policy", () => {
  test("unknown billing is treated as paid: refused by default, acknowledged under allow-paid", async () => {
    const dir = newProject("Unknown cost");
    const a = await newTask(dir, "A");
    const deps = { envNames: () => ["OPENAI_BASE_URL"] };
    const created = await batches.createBatch(dir, { taskIds: [a], policy: OK_POLICY }, deps);
    if (!created.ok) throw new Error(created.error);
    expect(created.value.preview!.issues.map((i) => i.code)).toContain("spend-unknown-forbidden");
    expect(created.value.preview!.canApprove).toBe(false);

    const paid = await batches.updateBatch(dir, created.value.id, { revision: created.value.revision, policy: { spending: "allow-paid" } }, deps);
    if (!paid.ok) throw new Error(paid.error);
    expect(paid.value.preview!.needsSpendingAck).toBe(true);
    const noAck = await batches.approveBatch(dir, paid.value.id, { revision: paid.value.revision, previewKey: paid.value.preview!.key }, deps);
    expect(noAck.ok).toBe(false);
    if (!noAck.ok) expect(noAck.status).toBe(400);
    expect(paid.value.preview!.spendingHarnessIds).toEqual(["codex"]);
    const wrongHarness = await batches.approveBatch(dir, paid.value.id, { revision: paid.value.revision, previewKey: paid.value.preview!.key, acknowledgedHarnessIds: ["cursor"] }, deps);
    expect(wrongHarness.ok).toBe(false);
    if (!wrongHarness.ok) expect(wrongHarness.body?.missingHarnessIds).toEqual(["codex"]);
    const ok = await batches.approveBatch(dir, paid.value.id, { revision: paid.value.revision, previewKey: paid.value.preview!.key, acknowledgedHarnessIds: ["codex"] }, deps);
    expect(ok.ok).toBe(true);
    if (ok.ok) {
      expect(ok.value.batch.approval?.spendingAccepted).toEqual(["codex:spend-unknown"]);
      expect(ok.value.batch.approval?.acknowledgedHarnessIds).toEqual(["codex"]);
    }
  });

  test("a paid path that appears after approval holds the start (no overage allowed)", async () => {
    const dir = newProject("Overage");
    const a = await newTask(dir, "A");
    const batch = await approved(dir, [a]);
    const started = await batches.startBatch(dir, batch.id, { envNames: () => ["OPENAI_API_KEY"] });
    if (!started.ok) throw new Error(started.error);
    const view = started.value.batch;
    expect(view.status).toBe("paused");
    expect(view.reason?.code).toBe("held");
    expect(view.entries[0]!.hold?.code).toBe("spending:spend-paid-api-forbidden");
    expect(runsOf(a)).toBe(0);
  });
});

describe("scheduling", () => {
  test("independent tasks run one at a time by default, each only once, and wait for review", async () => {
    const dir = newProject("Independent");
    const a = await newTask(dir, "A");
    const b = await newTask(dir, "B");
    const batch = await approved(dir, [a, b]);
    const res = await startB(dir, batch.id);
    expect(res.status).toBe(200);
    expect(res.json.batch.status).toBe("running");
    expect(runsOf(a)).toBe(1);
    expect(runsOf(b)).toBe(0);
    await waitState(dir, batch.id, a, "review");
    // The finished run is not accepted on the owner's behalf.
    expect(db.tasks.get(a)!.column).toBe("review");
    await Bun.sleep(100);
    expect(runsOf(b)).toBe(0);
    expect((await getB(dir, batch.id)).next.reason).toContain("review");
    await accept(dir, batch.id, a);
    await waitState(dir, batch.id, b, "review");
    await accept(dir, batch.id, b);
    const done = await waitFor(() => getB(dir, batch.id), (v) => v.status === "completed", "completed");
    expect(done.counts.done).toBe(2);
    expect(runsOf(a)).toBe(1);
    expect(runsOf(b)).toBe(1);
    // Each start went through supervised execution and is reviewable there.
    const executions = (await call("GET", `/project-manager/executions?${q(dir)}`)).json;
    expect(executions.filter((e: any) => e.source === "batch" && e.batchId === batch.id)).toHaveLength(2);
  });

  test("sequential dependencies start in dependency order, not before Done", async () => {
    const dir = newProject("Chain");
    const a = await newTask(dir, "A");
    const b = await newTask(dir, "B");
    const c = await newTask(dir, "C");
    await link(dir, b, [a]);
    await link(dir, c, [b]);
    // Priority never overrides a dependency.
    await prioritize(dir, c, "critical");
    const batch = await approved(dir, [c, b, a], { reviewPolicy: "continue-independent" });
    expect(batch.preview.order).toEqual([a, b, c]);
    await startB(dir, batch.id);
    expect(runsOf(a)).toBe(1);
    await waitState(dir, batch.id, a, "review");
    await Bun.sleep(100);
    expect(runsOf(b) + runsOf(c)).toBe(0);
    await accept(dir, batch.id, a);
    await waitState(dir, batch.id, b, "review");
    expect(runsOf(c)).toBe(0);
    await accept(dir, batch.id, b);
    await waitState(dir, batch.id, c, "review");
    await accept(dir, batch.id, c);
    await waitFor(() => getB(dir, batch.id), (v) => v.status === "completed", "completed");
  });

  test("parallel branches respect the limit and the priority order", async () => {
    process.env.AGETOR_FAKE_CODEX_RESOLVE_DELAY_MS = "400";
    const dir = newProject("Parallel");
    const low = await newTask(dir, "Low");
    const mid = await newTask(dir, "Mid");
    const top = await newTask(dir, "Top");
    const after = await newTask(dir, "After top");
    await link(dir, after, [top]);
    await prioritize(dir, low, "low");
    await prioritize(dir, top, "critical");
    const batch = await approved(dir, [low, mid, top, after], { maxParallel: 2, maxStarts: 4, reviewPolicy: "continue-independent" });
    const res = await startB(dir, batch.id);
    expect(res.status).toBe(200);
    // Two slots: the critical task and the normal one; the low one waits.
    expect(runsOf(top)).toBe(1);
    expect(runsOf(mid)).toBe(1);
    expect(runsOf(low)).toBe(0);
    const live = () => [low, mid, top, after].filter((id) => orchestrator.isTaskRunLive(id)).length;
    expect(live()).toBeLessThanOrEqual(2);
    // A slot frees when a run finishes; the low task takes it, the
    // dependent one still waits for its dependency to be Done.
    await waitFor(() => runsOf(low), (n) => n === 1, "low started");
    expect(live()).toBeLessThanOrEqual(2);
    expect(runsOf(after)).toBe(0);
    await waitState(dir, batch.id, top, "review");
    await accept(dir, batch.id, top);
    await waitFor(() => runsOf(after), (n) => n === 1, "dependent started");
  });

  test("starting twice at once starts each task once", async () => {
    const dir = newProject("Double start");
    const a = await newTask(dir, "A");
    const batch = await approved(dir, [a]);
    const [x, y] = await Promise.all([startB(dir, batch.id), startB(dir, batch.id)]);
    expect([x.status, y.status]).toEqual([200, 200]);
    expect([x.json.alreadyRunning, y.json.alreadyRunning].sort()).toEqual([false, true]);
    await Bun.sleep(100);
    expect(runsOf(a)).toBe(1);
  });

  test("a start from the board at the same moment makes one run", async () => {
    const dir = newProject("Kanban race");
    const a = await newTask(dir, "A");
    const batch = await approved(dir, [a]);
    const [board, started] = await Promise.all([call("POST", `/tasks/${a}/start`), startB(dir, batch.id)]);
    expect(started.status).toBe(200);
    expect([200, 400]).toContain(board.status);
    await Bun.sleep(100);
    expect(runsOf(a)).toBe(1);
    const view = await getB(dir, batch.id);
    const entry = view.entries[0];
    // Either the batch launched it, or it saw the board's run and left it.
    expect(entry.attempts.filter((t: any) => t.outcome === "started").length + (board.status === 200 ? 1 : 0)).toBe(1);
  });

  test("a task changed on the board after approval is held, not run", async () => {
    const dir = newProject("Changed");
    const a = await newTask(dir, "A");
    const b = await newTask(dir, "B");
    const batch = await approved(dir, [a, b]);
    db.tasks.update(a, { prompt: "Something else entirely." });
    db.tasks.update(b, { mode: "auto" });
    const res = await startB(dir, batch.id);
    const view = res.json.batch;
    expect(view.status).toBe("paused");
    expect(view.reason.code).toBe("held");
    expect(view.entries[0].hold.code).toBe("task-changed");
    expect(runsOf(a)).toBe(0);
    // Resuming doesn't run the held task; it goes on with the rest.
    const resumed = await call("POST", `/project-manager/batches/${batch.id}/resume`, { path: dir });
    expect(resumed.status).toBe(200);
    expect(runsOf(a)).toBe(0);
    expect(stateOf(resumed.json.batch, a)).toBe("held");
    expect(stateOf(resumed.json.batch, b)).toBe("held");
    expect(resumed.json.batch.entries[1].hold.code).toBe("task-changed");
    expect(runsOf(b)).toBe(0);
  });

  test("a dependency link changed after approval holds the dependent task", async () => {
    const dir = newProject("Relinked");
    const a = await newTask(dir, "A");
    const b = await newTask(dir, "B");
    const batch = await approved(dir, [a, b], { onFailure: "continue" });
    await link(dir, b, [a]);
    const res = await startB(dir, batch.id);
    expect(res.json.batch.entries.find((e: any) => e.taskId === b).dependenciesChanged).toBe(true);
    // A starts; B is held once its turn comes, since its links aren't the approved ones.
    await waitState(dir, batch.id, a, "review");
    await accept(dir, batch.id, a);
    const view = await waitState(dir, batch.id, b, "held");
    expect(view.entries.find((e: any) => e.taskId === b).hold.code).toBe("dependencies-changed");
    expect(runsOf(b)).toBe(0);
  });
});

describe("limits", () => {
  test("the time limit stops new starts and can't be resumed past", async () => {
    const dir = newProject("Deadline");
    const a = await newTask(dir, "A");
    const b = await newTask(dir, "B");
    const batch = await approved(dir, [a, b], { maxDurationMinutes: 1, reviewPolicy: "continue-independent" });
    // Started "two hours ago": the first tick still runs inside the limit,
    // every later one (real clock) is past it.
    const past = Date.now() - 2 * 60 * 60_000;
    const started = await batches.startBatch(dir, batch.id, { now: () => past });
    if (!started.ok) throw new Error(started.error);
    expect(runsOf(a)).toBe(1);
    const stopped = await waitFor(() => getB(dir, batch.id), (v) => v.status === "stopped", "stopped");
    expect(stopped.reason.code).toBe("deadline");
    expect(runsOf(b)).toBe(0);
    expect((await call("POST", `/project-manager/batches/${batch.id}/resume`, { path: dir })).status).toBe(409);
  });
});

describe("failures and retries", () => {
  test("a run that fails pauses the batch; its dependents stay blocked", async () => {
    const dir = newProject("Run fails");
    const a = await newTask(dir, "A", { prompt: "Fail. __agetor_fake_run_fail__" });
    const b = await newTask(dir, "B");
    await link(dir, b, [a]);
    const batch = await approved(dir, [a, b]);
    await startB(dir, batch.id);
    const paused = await waitFor(() => getB(dir, batch.id), (v) => v.status === "paused", "paused");
    expect(paused.reason.code).toBe("failure");
    expect(stateOf(paused, a)).toBe("failed");
    expect(db.runs.listForTask(a)[0]!.status).toBe("failed");
    const resumed = await call("POST", `/project-manager/batches/${batch.id}/resume`, { path: dir });
    expect(resumed.json.batch.status).toBe("running");
    expect(resumed.json.batch.entries.find((e: any) => e.taskId === b).readiness.state).toBe("blocked");
    await Bun.sleep(100);
    expect(runsOf(a)).toBe(1);
    expect(runsOf(b)).toBe(0);
  });

  test("a failed run is retried within the allowance", async () => {
    const dir = newProject("Retry");
    const a = await newTask(dir, "A", { prompt: "Flaky. __agetor_fake_run_fail_once__" });
    const batch = await approved(dir, [a], { maxRetriesPerTask: 1, maxStarts: 2 });
    await startB(dir, batch.id);
    const view = await waitState(dir, batch.id, a, "review");
    expect(runsOf(a)).toBe(2);
    expect(view.launchesUsed).toBe(2);
    expect(view.status).toBe("running");
  });

  test("onFailure continue: independent tasks go on after a failure", async () => {
    const dir = newProject("Continue");
    const a = await newTask(dir, "A", { prompt: "Fail. __agetor_fake_run_fail__" });
    const b = await newTask(dir, "B");
    const batch = await approved(dir, [a, b], { onFailure: "continue" });
    await startB(dir, batch.id);
    await waitFor(() => runsOf(b), (n) => n === 1, "b started");
    const view = await waitState(dir, batch.id, b, "review");
    expect(stateOf(view, a)).toBe("failed");
    expect(view.status).toBe("running");
  });

  test("a runtime start error is recorded, redacted, and pauses the batch", async () => {
    const dir = newProject("Start error");
    const a = await newTask(dir, "A");
    const batch = await approved(dir, [a]);
    const res = await batches.startBatch(dir, batch.id, { startTask: async () => ({ error: "the CLI exited (token sk-abcdefghijklmnopqrstuv)" }) });
    if (!res.ok) throw new Error(res.error);
    const view = res.value.batch;
    expect(view.status).toBe("paused");
    expect(view.entries[0]!.attempts[0]!.outcome).toBe("start-failed");
    expect(view.entries[0]!.attempts[0]!.error).not.toContain("sk-abcdefghijklmnopqrstuv");
    expect(runsOf(a)).toBe(0);
    // The batch's own failed launch isn't approvable as a single run.
    const executionId = view.entries[0]!.attempts[0]!.executionId!;
    const single = await call("POST", `/project-manager/executions/${executionId}/approve`, { path: dir, revision: 1 });
    expect(single.status).toBe(409);
    expect(single.json.error).toContain("batch");
  });

  test("a harness disabled after approval holds the start", async () => {
    const dir = newProject("Disabled later");
    const a = await newTask(dir, "A");
    const batch = await approved(dir, [a]);
    db.harnesses.setEnabled("codex", false);
    try {
      const res = await startB(dir, batch.id);
      expect(res.json.batch.status).toBe("paused");
      expect(res.json.batch.entries[0].hold.code).toBe("check:harness-disabled");
      expect(runsOf(a)).toBe(0);
    } finally {
      db.harnesses.setEnabled("codex", true);
    }
  });
});

describe("pause, resume, cancel", () => {
  test("pause starts nothing new and leaves the running agent alone; resume continues", async () => {
    process.env.AGETOR_FAKE_CODEX_RESOLVE_DELAY_MS = "300";
    const dir = newProject("Pause");
    const a = await newTask(dir, "A");
    const b = await newTask(dir, "B");
    const batch = await approved(dir, [a, b], { reviewPolicy: "continue-independent" });
    await startB(dir, batch.id);
    const paused = await call("POST", `/project-manager/batches/${batch.id}/pause`, { path: dir });
    expect(paused.status).toBe(200);
    expect(paused.json.status).toBe("paused");
    expect(orchestrator.isTaskRunLive(a)).toBe(true);
    await waitFor(() => db.tasks.get(a)!.column, (c) => c === "review", "a review");
    await Bun.sleep(100);
    expect(runsOf(b)).toBe(0);
    expect((await call("POST", `/project-manager/batches/${batch.id}/pause`, { path: dir })).status).toBe(200);
    const resumed = await call("POST", `/project-manager/batches/${batch.id}/resume`, { path: dir });
    expect(resumed.status).toBe(200);
    expect(runsOf(b)).toBe(1);
    const kinds = (await call("GET", `/project-manager/batches/${batch.id}/events?${q(dir)}`)).json.events.map((e: any) => e.kind);
    expect(kinds).toEqual(expect.arrayContaining(["started", "task-started", "paused", "resumed"]));
  });

  test("cancel stops assigning, keeps results and runs; stopping runs is separate and only touches the batch's own", async () => {
    process.env.AGETOR_FAKE_CODEX_RESOLVE_DELAY_MS = "3000";
    const dir = newProject("Cancel");
    const a = await newTask(dir, "A");
    const b = await newTask(dir, "B");
    const outsider = await newTask(dir, "Outsider");
    const batch = await approved(dir, [a, b]);
    await startB(dir, batch.id);
    const outside = await orchestrator.startTask(outsider);
    expect("runId" in outside).toBe(true);
    expect((await call("POST", `/project-manager/batches/${batch.id}/stop-runs`, { path: dir })).status).toBe(409);
    const cancelled = await call("POST", `/project-manager/batches/${batch.id}/cancel`, { path: dir });
    expect(cancelled.status).toBe(200);
    expect(cancelled.json.status).toBe("cancelled");
    expect(cancelled.json.ownedLive).toEqual([a]);
    expect(orchestrator.isTaskRunLive(a)).toBe(true);
    const stopped = await call("POST", `/project-manager/batches/${batch.id}/stop-runs`, { path: dir });
    expect(stopped.status).toBe(200);
    expect(stopped.json.stopped).toEqual([a]);
    await waitFor(() => orchestrator.isTaskRunLive(a), (live) => !live, "a stopped");
    expect(orchestrator.isTaskRunLive(outsider)).toBe(true);
    expect(runsOf(b)).toBe(0);
    // Results stay: the task and its run are still there.
    expect(db.tasks.get(a)).toBeTruthy();
    expect(runsOf(a)).toBe(1);
    expect((await startB(dir, batch.id)).status).toBe(409);
    expect((await call("POST", `/project-manager/batches/${batch.id}/resume`, { path: dir })).status).toBe(409);
    const outsiderRun = db.tasks.get(outsider)!.runId!;
    await orchestrator.cancelRun(outsiderRun);
  });
});

describe("recovery", () => {
  test("after a restart a running batch comes back paused and starts nothing", async () => {
    const dir = newProject("Restart");
    const a = await newTask(dir, "A");
    const b = await newTask(dir, "B");
    const batch = await approved(dir, [a, b], { reviewPolicy: "continue-independent" });
    await startB(dir, batch.id);
    await waitState(dir, batch.id, b, "review");
    await batches.__testing.settle();
    batches.__testing.simulateRestart();
    expect(batches.recoverExecutionBatches()).toBeGreaterThanOrEqual(1);
    const view = await getB(dir, batch.id);
    expect(view.status).toBe("paused");
    expect(view.reason.code).toBe("restart");
    // Finished tasks are still known.
    expect(stateOf(view, a)).toBe("review");
    expect(stateOf(view, b)).toBe("review");
    expect(runsOf(a) + runsOf(b)).toBe(2);
    const kinds = (await call("GET", `/project-manager/batches/${batch.id}/events?${q(dir)}`)).json.events.map((e: any) => e.kind);
    expect(kinds).toContain("recovered");
  });

  test("a start in flight at the crash is adopted if its run exists, else held unconfirmed until released", async () => {
    const dir = newProject("Crash");
    const ran = await newTask(dir, "Ran");
    const unknown = await newTask(dir, "Unknown");
    const batch = await approved(dir, [ran, unknown], { maxParallel: 2, reviewPolicy: "continue-independent" });
    // Simulate a crash between "launching" and the result: the stored batch
    // says running with both starts in flight; only one task got a run.
    const stored = JSON.parse(db.executionBatches.get(dir, batch.id)!);
    const at = Date.now() - 5;
    stored.status = "running";
    stored.startedAt = at;
    for (const entry of stored.entries) entry.launching = { at, executionId: crypto.randomUUID() };
    db.executionBatches.put({ id: batch.id, projectPath: dir, status: "running", data: JSON.stringify(stored), createdAt: stored.createdAt });
    const started = await orchestrator.startTask(ran);
    if ("error" in started) throw new Error(started.error);
    batches.__testing.simulateRestart();

    const view = await getB(dir, batch.id);
    expect(view.status).toBe("paused");
    const ranEntry = view.entries.find((e: any) => e.taskId === ran);
    expect(ranEntry.attempts).toEqual([expect.objectContaining({ outcome: "started", runId: started.runId })]);
    const unknownEntry = view.entries.find((e: any) => e.taskId === unknown);
    expect(unknownEntry.state).toBe("held");
    expect(unknownEntry.hold.code).toBe("unconfirmed");

    // Resume continues, but never relaunches the unconfirmed one.
    const resumed = await call("POST", `/project-manager/batches/${batch.id}/resume`, { path: dir });
    expect(resumed.status).toBe(200);
    await Bun.sleep(100);
    expect(runsOf(ran)).toBe(1);
    expect(runsOf(unknown)).toBe(0);
    // After the owner checks it, releasing lets the batch start it.
    const released = await call("POST", `/project-manager/batches/${batch.id}/tasks/${unknown}/release`, { path: dir });
    expect(released.status).toBe(200);
    expect(runsOf(unknown)).toBe(1);
  });
});

describe("events", () => {
  test("every save is announced to the app stream with ids only, scoped by project", async () => {
    const { subscribeAppEvents } = await import("./quit-guard.ts");
    const seen: any[] = [];
    const unsubscribe = subscribeAppEvents((event) => {
      if (event.type === "execution_batch") seen.push(event);
    });
    try {
      const dir = newProject("Events");
      const a = await newTask(dir, "A");
      const batch = await approved(dir, [a]);
      const mine = seen.filter((event) => event.batchId === batch.id);
      expect(mine.map((event) => event.status)).toEqual(["draft", "approved"]);
      expect(mine.every((event) => event.projectPath === dir)).toBe(true);
      expect(Object.keys(mine[0]).sort()).toEqual(["batchId", "projectPath", "status", "ts", "type"]);
    } finally {
      unsubscribe();
    }
  });
});

describe("project isolation", () => {
  test("another project's path can't read or drive a batch", async () => {
    const mine = newProject("Mine");
    const theirs = newProject("Theirs");
    const task = await newTask(theirs, "Theirs");
    const batch = await approved(theirs, [task]);
    expect((await call("GET", `/project-manager/batches/${batch.id}?${q(mine)}`)).status).toBe(404);
    expect((await startB(mine, batch.id)).status).toBe(404);
    expect((await call("POST", `/project-manager/batches/${batch.id}/cancel`, { path: mine })).status).toBe(404);
    expect((await call("GET", `/project-manager/batches?${q(mine)}`)).json.some((b: any) => b.id === batch.id)).toBe(false);
    expect(runsOf(task)).toBe(0);
    const stray = realpathSync(mkdtempSync(path.join(tmpdir(), "fo005c-stray-")));
    expect([400, 404]).toContain((await call("POST", "/project-manager/batches", { path: stray, taskIds: [task] })).status);
  });
});

describe("task proposals and pipelines", () => {
  async function ask(dir: string, text: string): Promise<void> {
    await call("PUT", "/project-manager/config", { path: dir, config: { harness: "codex", model: "gpt-6.1-sol", effort: "low", consentKey: consent } });
    const sent = await call("POST", "/project-manager/messages", { path: dir, text });
    expect(sent.status).toBe(202);
    await waitFor(
      async () => (await call("GET", `/project-manager/turns/${sent.json.turn.id}`)).json,
      (turn) => turn?.status && turn.status !== "running",
      "turn",
    );
  }

  test("an approved proposal gets structured links and priorities; a batch from it starts nothing until approved and started", async () => {
    const dir = newProject("From proposal");
    await ask(dir, "Split authentication into tasks");
    const state = (await call("GET", `/project-manager?${q(dir)}`)).json;
    const proposal = state.proposals[0];
    const early = await call("POST", `/project-manager/proposals/${proposal.id}/batch`, { path: dir });
    expect(early.status).toBe(409);
    const res = await call("POST", `/project-manager/proposals/${proposal.id}/approve`, { path: dir, revision: proposal.revision });
    expect(res.status).toBe(200);
    const items = res.json.proposal.items;
    const taskOf = (ref: number) => items[ref].result.taskId as string;
    // T2 depends on T1, T5 on T2, T3 and T4 — as real rows now.
    expect(db.taskScheduling.dependenciesOf(taskOf(1))).toEqual([taskOf(0)]);
    expect([...db.taskScheduling.dependenciesOf(taskOf(4))].sort()).toEqual([taskOf(1), taskOf(2), taskOf(3)].sort());
    expect(db.taskScheduling.priorityOf(taskOf(0))).toBe("high");
    expect(db.taskScheduling.priorityOf(taskOf(3))).toBe("normal");
    // Approving the proposal prepared no batch and started nothing.
    expect((await call("GET", `/project-manager/batches?${q(dir)}`)).json).toEqual([]);

    const fromProposal = await call("POST", `/project-manager/proposals/${proposal.id}/batch`, { path: dir, policy: OK_POLICY });
    expect(fromProposal.status).toBe(201);
    const batch = fromProposal.json;
    expect(batch.status).toBe("draft");
    expect(batch.sourceProposalId).toBe(proposal.id);
    expect(batch.mappingNotes).toEqual([]);
    expect(batch.preview.order[0]).toBe(taskOf(0));
    expect(batch.preview.order.at(-1)).toBe(taskOf(4));
    for (const item of items) expect(runsOf(item.result.taskId)).toBe(0);
  });

  test("an older proposal whose links are only Markdown asks for manual mapping", async () => {
    const dir = newProject("Old proposal");
    await ask(dir, "Split authentication into tasks");
    const proposal = (await call("GET", `/project-manager?${q(dir)}`)).json.proposals[0];
    const res = await call("POST", `/project-manager/proposals/${proposal.id}/approve`, { path: dir, revision: proposal.revision });
    // As if approved before structured links existed.
    for (const item of res.json.proposal.items) db.taskScheduling.replaceDependencies(item.result.taskId, []);
    const batch = (await call("POST", `/project-manager/proposals/${proposal.id}/batch`, { path: dir, policy: OK_POLICY })).json;
    expect(batch.mappingNotes.length).toBeGreaterThan(0);
    const codes = batch.preview.issues.map((i: any) => i.code);
    expect(codes).toContain("dependency-mapping-required");
    expect(codes).toContain("markdown-dependencies");
    // Nothing was guessed from the Markdown.
    for (const item of res.json.proposal.items) expect(db.taskScheduling.dependenciesOf(item.result.taskId)).toEqual([]);
  });

  test("approving a single execution proposal doesn't approve a batch", async () => {
    const dir = newProject("Single");
    const a = await newTask(dir, "A");
    const b = await newTask(dir, "B");
    const batch = await draft(dir, [a, b]);
    const single = (await call("POST", "/project-manager/executions", { path: dir, taskId: a })).json.execution;
    const started = await call("POST", `/project-manager/executions/${single.id}/approve`, { path: dir, revision: single.revision });
    expect(started.status).toBe(200);
    const view = await getB(dir, batch.id);
    expect(view.status).toBe("draft");
    expect(runsOf(b)).toBe(0);
  });

  test("a pipeline task runs through the pipeline runner and counts once accepted", async () => {
    const dir = newProject("Pipeline batch");
    const profile = db.agentProfiles.insert({
      name: `Batch codex ${crypto.randomUUID().slice(0, 6)}`,
      harness: "codex",
      model: "gpt-6.1-sol",
      effort: "low",
      mode: "auto",
      fast: false,
      maxMode: false,
      instructions: "",
      skills: [],
    });
    const pipeline = db.pipelines.insert({
      name: `Batch pipeline ${crypto.randomUUID().slice(0, 6)}`,
      description: "",
      maxSteps: 10,
      graph: {
        startStepId: "s1",
        steps: [{ id: "s1", name: "Build", agentProfileId: profile.id, instructions: "", position: { x: 0, y: 0 }, transition: "choose", join: "any", subagents: { profileIds: [], cap: null } }],
        edges: [],
      },
    } as never);
    const task = await newTask(dir, "Piped", { prompt: "Do it. __agetor_fake_claude_handoff__:done" });
    const d = await draft(dir, [task]);
    const edited = await call("PATCH", `/project-manager/batches/${d.id}`, { path: dir, revision: d.revision, configs: { [task]: { pipelineId: pipeline.id } } });
    expect(edited.status).toBe(200);
    expect(edited.json.preview.tasks[0].pipelineName).toBe(pipeline.name);
    const ok = await approveB(dir, edited.json);
    expect(ok.status).toBe(200);
    expect(ok.json.batch.approval.allowedPipelineIds).toEqual([pipeline.id]);
    await startB(dir, d.id);
    await waitFor(() => db.tasks.get(task)!.pipelineRun?.status, (s) => s === "done", "pipeline done");
    await waitState(dir, d.id, task, "review");
    await accept(dir, d.id, task);
    await waitFor(() => getB(dir, d.id), (v) => v.status === "completed", "completed");
  });
});
