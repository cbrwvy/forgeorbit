import { afterAll, beforeAll, beforeEach, expect, spyOn, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

/**
 * FO-010E3 employee supervised execution. Every agent is the fake codex
 * driver behind a /bin/echo stub: no real AI CLI runs, not even `--version`.
 * One isolated data dir for the file; a real API server on its own port.
 */
const isolated = realpathSync(mkdtempSync(path.join(tmpdir(), "fo010e3-")));
process.env.AGETOR_DATA_DIR = isolated;
process.env.HOME = isolated;
process.env.AGETOR_API_PORT = "4703";
process.env.AGETOR_USAGE_OFFLINE = "1";
process.env.AGETOR_CODEX_DRIVER = "fake";
process.env.AGETOR_CODEX_BIN = "/bin/echo";
process.env.AGETOR_TMUX_BIN = "/bin/echo";
for (const kind of ["CLAUDE", "CURSOR", "GEMINI", "FX", "ANTIGRAVITY"]) process.env["AGETOR_" + kind + "_BIN"] = "/nonexistent/fo010e3";

let store: typeof import("./db.ts");
let backend: typeof import("./server.ts");
let server: ReturnType<(typeof import("./server.ts"))["startApiServer"]>;
let orchestrator: typeof import("./orchestrator.ts");
let run: typeof import("./employee-run.ts");
let core: typeof import("./employee-run-core.ts");
let execution: typeof import("./project-execution.ts");
let EmployeeCore: typeof import("./employee-core.ts").EmployeeCore;
let AssignmentCore: typeof import("./assignment-core.ts").AssignmentCore;
let AccountCore: typeof import("./account-core.ts").AccountCore;
const base = "http://127.0.0.1:4703";
let counter = 0;

beforeAll(async () => {
  store = await import("./db.ts");
  orchestrator = await import("./orchestrator.ts");
  run = await import("./employee-run.ts");
  core = await import("./employee-run-core.ts");
  execution = await import("./project-execution.ts");
  backend = await import("./server.ts");
  ({ EmployeeCore } = await import("./employee-core.ts"));
  ({ AssignmentCore } = await import("./assignment-core.ts"));
  ({ AccountCore } = await import("./account-core.ts"));
  run.initEmployeeExecutionTracking();
  server = backend.startApiServer();
  store.harnesses.setEnabled("codex", true);
  store.harnesses.setEnabled("cursor", false);
});
afterAll(() => server?.stop(true));
beforeEach(() => run.__testing.reset());

function project(name: string, parent?: string): string {
  const dir = realpathSync(mkdtempSync(path.join(parent ?? isolated, `${name}-`)));
  writeFileSync(path.join(dir, "README.md"), `# ${name}\n`);
  store.projects.upsert(dir, name);
  return dir;
}
async function newTask(dir: string, fields: Record<string, unknown> = {}): Promise<string> {
  const created = await orchestrator.createTask({
    title: `Task ${++counter}`,
    prompt: "SECRET_PROMPT_MARKER do the work",
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
const worker = (projectPath: string, name = `Worker ${++counter}`) =>
  new EmployeeCore(store.db).createWorker({ name, jobTitle: "QA Engineer", projectPath });
const assign = (taskId: string, employeeId: string) => new AssignmentCore(store.db).assign(taskId, employeeId).assignment;

async function scenario() {
  const dir = project("proj");
  const person = worker(dir);
  const taskId = await newTask(dir);
  const assignment = assign(taskId, person.id);
  return { dir, person, taskId, assignment };
}

/** Counts how often the existing runtime is invoked; delegates to the real (fake-driver) one. */
function launcher(mode: "real" | { error: string } | "throw" = "real") {
  const calls = { count: 0 };
  const startTask = (async (taskId: string, options?: Parameters<typeof orchestrator.startTask>[1]) => {
    calls.count++;
    if (mode === "throw") throw new Error("spawn exploded sk-abcdefghijklmnopqrstuvwx");
    if (typeof mode === "object") return { error: mode.error };
    return orchestrator.startTask(taskId, options);
  }) as typeof orchestrator.startTask;
  return { calls, deps: { exec: { startTask } } as import("./employee-run.ts").EmployeeRunDeps };
}
const review = (taskId: string, extra: Record<string, unknown> = {}, deps: import("./employee-run.ts").EmployeeRunDeps = {}) =>
  run.reviewEmployeeExecution({ taskId, harnessId: "codex", ...extra }, deps);
const confirm = (id: string, revision: number, extra: Record<string, unknown> = {}, deps: import("./employee-run.ts").EmployeeRunDeps = {}) =>
  run.startEmployeeExecution(id, { revision, confirm: true, ...extra }, deps);
async function reviewed(taskId: string, deps: import("./employee-run.ts").EmployeeRunDeps = {}, extra: Record<string, unknown> = {}) {
  const out = await review(taskId, extra, deps);
  expect(out.blockingErrors.map((e) => e.code)).toEqual([]);
  return out.attempt!;
}
const codes = (out: { blockingErrors: { code: string }[] }) => out.blockingErrors.map((e) => e.code);
const rows = (taskId?: string) =>
  store.db.query<any, any[]>(`SELECT * FROM employee_executions ${taskId ? "WHERE task_id = ?" : ""} ORDER BY rowid`).all(...(taskId ? [taskId] : []));
async function waitFor<T>(read: () => T, ok: (v: T) => boolean, label: string): Promise<T> {
  for (let i = 0; i < 300; i++) {
    const v = read();
    if (ok(v)) return v;
    await Bun.sleep(20);
  }
  throw new Error("timed out: " + label);
}
async function expectError(promise: Promise<unknown>, status: number, code: string) {
  const error = await promise.then(() => null, (e) => e);
  expect(error).toBeInstanceOf(run.EmployeeRunError);
  expect({ status: error.status, code: error.code }).toEqual({ status, code });
  return error as InstanceType<typeof run.EmployeeRunError>;
}
async function http(route: string, body?: unknown, method = body === undefined ? "GET" : "POST", auth: string | null = "Bearer " + backend.API_TOKEN) {
  const response = await fetch(base + route, {
    method,
    headers: { ...(auth ? { authorization: auth } : {}), "content-type": "application/json" },
    body: body === undefined ? undefined : typeof body === "string" ? body : JSON.stringify(body),
  });
  return { status: response.status, body: (await response.json()) as any };
}

async function lostClaim() {
  const s = await scenario();
  const attempt = await reviewed(s.taskId);
  const c = new core.EmployeeRunCore(store.db);
  expect(c.claim(attempt.id, attempt.revision, crypto.randomUUID()).ok).toBe(true);
  return { ...s, attempt, c };
}
type Lost = Awaited<ReturnType<typeof lostClaim>>;
function persistProposal(s: Lost, runId: string | null, extra: Record<string, unknown> = {}) {
  const row = s.c.get(s.attempt.id)!;
  const proposal = { id: row.execution_id!, projectPath: s.dir, taskId: s.taskId, employeeRunId: s.attempt.id,
    source: "employee", runId, status: "starting", config: { harness: "codex", model: "gpt-6.1-sol" }, ...extra };
  store.projectExecutions.put({ ...proposal, data: JSON.stringify(proposal), createdAt: row.created_at });
}
function recorded(s: Lost, status: "running" | "succeeded" | "failed" | "cancelled" | "orphaned", extra: Record<string, unknown> = {}) {
  const id = crypto.randomUUID();
  const at = s.c.get(s.attempt.id)!.claimed_at! + 1;
  store.runs.insert({ id, taskId: s.taskId, agent: "codex", status, startedAt: at,
    endedAt: status === "running" ? null : at + 5, exitCode: status === "failed" ? 2 : 0,
    tmuxSession: null, claudeSessionId: null, codexSessionId: null, cursorSessionId: null, geminiSessionId: null,
    ...extra } as never);
  persistProposal(s, id);
  return id;
}
const reconcile = (id: string) => run.reconcileEmployeeExecution(id, {});

test("reconcile an active exact Run using the canonical in-process runtime handle", async () => {
  const s = await scenario();
  const a = await reviewed(s.taskId);
  const started = await confirm(a.id, a.revision);
  const result = reconcile(a.id);
  expect(result.outcome).toBe("running");
  expect(result.attempt.runId).toBe(started.attempt.runId);
  expect(store.runs.countForTask(s.taskId)).toBe(1);
});

for (const [status, phase] of [["succeeded", "completed"], ["failed", "failed"], ["cancelled", "cancelled"]] as const) {
  test(`reconcile a confirmed ${status} Run and copy its terminal timestamp exactly once`, async () => {
    const s = await lostClaim();
    const id = recorded(s, status);
    const original = store.runs.get(id)!;
    const result = reconcile(s.attempt.id);
    expect(result).toMatchObject({ outcome: "terminal", attempt: { phase, result: status, runId: id, finishedAt: original.endedAt } });
    const before = s.c.get(s.attempt.id);
    for (let i = 0; i < 3; i++) reconcile(s.attempt.id);
    expect(s.c.get(s.attempt.id)).toEqual(before);
    expect(store.runs.get(id)).toEqual(original);
  });
}

test("missing Run is not evidence of no process; acknowledgeUnconfirmed never releases the guard", async () => {
  const s = await lostClaim();
  const result = reconcile(s.attempt.id);
  expect(result).toMatchObject({ outcome: "indeterminate", confirmedRun: null, attempt: { phase: "unknown-outcome", finishedAt: null } });
  expect((await review(s.taskId)).attempt).toBeNull();
  expect(await confirm(s.attempt.id, 2, { acknowledgeUnconfirmed: true })).toMatchObject({ replayed: true });
  expect(store.runs.countForTask(s.taskId)).toBe(0);
});

test("a same-task run near the claim time is never adopted without an exact durable link", async () => {
  const s = await lostClaim();
  const id = recorded(s, "succeeded");
  // Lose the exact link while retaining the nearby run.
  store.db.run("DELETE FROM project_manager_executions WHERE id = ?", [s.c.get(s.attempt.id)!.execution_id]);
  expect(reconcile(s.attempt.id).attempt).toMatchObject({ status: "indeterminate", runId: null, finishedAt: null });
  expect(s.c.byRun(id)).toBeNull();
});

test("a known running row without a current process handle remains unknown and blocks relaunch", async () => {
  const s = await lostClaim();
  const id = recorded(s, "running");
  const result = reconcile(s.attempt.id);
  expect(result).toMatchObject({ outcome: "indeterminate", confirmedRun: { id, status: "running" }, attempt: { phase: "unknown-outcome", finishedAt: null } });
  expect(s.c.hasUnconfirmed(s.taskId)).toBe(true);
});

test("an orphaned run is never treated as proof that its process stopped", async () => {
  const s = await lostClaim();
  recorded(s, "orphaned");
  expect(reconcile(s.attempt.id)).toMatchObject({ outcome: "indeterminate", attempt: { phase: "unknown-outcome", result: "orphaned" } });
  expect((await review(s.taskId)).attempt).toBeNull();
  expect(s.c.hasUnconfirmed(s.taskId)).toBe(true);
});

test("repeated and concurrent HTTP reconciliation are idempotent and never append run history", async () => {
  const s = await lostClaim();
  const id = recorded(s, "succeeded");
  const events = store.runs.events(id);
  const results = await Promise.all(Array.from({ length: 8 }, () => http(`/employee-execution/attempts/${s.attempt.id}/reconcile`, {})));
  expect(results.every((r) => r.status === 200 && r.body.outcome === "terminal")).toBe(true);
  expect(new Set(results.map((r) => JSON.stringify(r.body))).size).toBe(1);
  const row = s.c.get(s.attempt.id);
  reconcile(s.attempt.id);
  expect(s.c.get(s.attempt.id)).toEqual(row);
  expect(store.runs.events(id)).toEqual(events);
  expect(rows(s.taskId)).toHaveLength(1);
});

test("restart during Starting preserves approval and recovers only the exact recorded Run", async () => {
  const s = await lostClaim();
  const id = recorded(s, "succeeded");
  const before = s.c.get(s.attempt.id)!;
  run.__testing.reset();
  run.recoverEmployeeExecutions();
  expect(run.getEmployeeRun(s.attempt.id)).toMatchObject({ phase: "completed", runId: id, approvedAt: before.approved_at, provenance: { approval: "owner" } });
});

test("restart during Running preserves an unknown process, then reconciles canonical completion", async () => {
  const s = await lostClaim();
  const id = recorded(s, "running");
  reconcile(s.attempt.id);
  run.__testing.reset();
  run.recoverEmployeeExecutions();
  expect(run.getEmployeeRun(s.attempt.id).phase).toBe("unknown-outcome");
  store.runs.update(id, { status: "succeeded", endedAt: 12345, exitCode: 0 });
  expect(reconcile(s.attempt.id).attempt).toMatchObject({ phase: "completed", finishedAt: 12345 });
  expect(store.runs.countForTask(s.taskId)).toBe(1);
});

test("a durable runtime refusal is confirmed, while legacy recovery's guessed failure is not", async () => {
  const s = await lostClaim();
  persistProposal(s, null, { status: "start-failed", history: [{ at: Date.now(), kind: "start-failed", text: "app closed" }] });
  expect(reconcile(s.attempt.id).outcome).toBe("indeterminate");
  persistProposal(s, null, { status: "start-failed", history: [{ at: Date.now(), kind: "start-refused", text: "runtime refused" }] });
  expect(reconcile(s.attempt.id)).toMatchObject({ outcome: "start-failed", attempt: { phase: "failed", startedAt: null } });
});

test("reconcile cannot bypass revoked or expired Owner approval", async () => {
  const s = await scenario();
  const a = await reviewed(s.taskId);
  run.cancelEmployeeExecution(a.id, { revision: a.revision });
  expect(reconcile(a.id).attempt.status).toBe("cancelled");
  const b = await reviewed(s.taskId);
  const expired = run.reconcileEmployeeExecution(b.id, {}, { now: () => b.expiresAt + 1 });
  expect(expired.attempt.status).toBe("expired");
  expect(store.runs.countForTask(s.taskId)).toBe(0);
});

test("reconciliation never reassigns historical attribution after a stale assignment", async () => {
  const s = await lostClaim();
  recorded(s, "succeeded");
  const next = worker(s.dir);
  new AssignmentCore(store.db).reassign(s.taskId, next.id, s.assignment.revision);
  const result = reconcile(s.attempt.id);
  expect(result.attempt.employee.id).toBe(s.person.id);
  expect(result.attempt.assignment.id).toBe(s.assignment.id);
});

test("employee rename and archive preserve history and the name approved at start", async () => {
  const s = await lostClaim();
  recorded(s, "succeeded");
  new EmployeeCore(store.db).update(s.person.id, { name: "Renamed Runner" });
  new AssignmentCore(store.db).unassign(s.taskId, s.assignment.revision);
  new EmployeeCore(store.db).archive(s.person.id);
  reconcile(s.attempt.id);
  const history = run.listEmployeeRuns({ employeeId: s.person.id });
  expect(history).toHaveLength(1);
  expect(history[0]!.employee.name).toBe(s.person.name);
  expect(history[0]!.phase).toBe("completed");
});

test("project ownership change denies reconciliation while historical snapshots remain readable", async () => {
  const s = await lostClaim();
  const id = recorded(s, "succeeded");
  const foreign = project("foreign");
  store.tasks.update(s.taskId, { workdir: foreign });
  const response = await http(`/employee-execution/attempts/${s.attempt.id}/reconcile`, {});
  expect(response).toMatchObject({ status: 409, body: { code: "ownership-changed" } });
  expect(store.runs.get(id)!.status).toBe("succeeded");
  expect(run.listEmployeeRuns({ employeeId: s.person.id })[0]!.projectPath).toBe(s.dir);
});

test("a forged foreign-task Run link is not adopted", async () => {
  const s = await lostClaim();
  const other = await lostClaim();
  const id = recorded(other, "succeeded");
  persistProposal(s, id);
  expect(reconcile(s.attempt.id)).toMatchObject({ outcome: "indeterminate", confirmedRun: null });
  expect(s.c.get(s.attempt.id)!.run_id).toBeNull();
});

test("Employee History keyset pagination is newest first, bounded and stable with new inserts", async () => {
  const s = await scenario();
  const ids: string[] = [];
  for (let i = 0; i < 26; i++) {
    const a = await reviewed(s.taskId, {}, { effort: i % 2 ? "low" : "high" });
    ids.unshift(a.id);
    run.cancelEmployeeExecution(a.id, { revision: a.revision });
  }
  const first = run.listEmployeeRuns({ employeeId: s.person.id, limit: 20 });
  expect(first.map((a) => a.id)).toEqual(ids.slice(0, 20));
  const newer = await reviewed(s.taskId);
  const next = await http(`/employee-execution/attempts?employeeId=${s.person.id}&limit=20&before=${first.at(-1)!.id}`);
  expect(next.body.attempts.map((a: any) => a.id)).toEqual(ids.slice(20));
  expect(next.body.attempts.map((a: any) => a.id)).not.toContain(newer.id);
});

test("actual model/account remain Unknown and existing Run History is unchanged", async () => {
  const s = await lostClaim();
  const id = recorded(s, "failed");
  const before = store.runs.listForTask(s.taskId);
  const result = reconcile(s.attempt.id);
  expect(result.attempt.actual).toEqual({ harnessId: "codex", model: null, accountId: null });
  const runsResponse = await http(`/tasks/${s.taskId}/runs`);
  expect(runsResponse.body.map((r: any) => r.id)).toContain(id);
  expect(store.runs.listForTask(s.taskId)).toEqual(before);
});

test("a missing endedAt never produces a synthetic finish timestamp", async () => {
  const s = await lostClaim();
  recorded(s, "failed", { endedAt: null });
  expect(reconcile(s.attempt.id).attempt.finishedAt).toBeNull();
  expect(s.c.hasUnconfirmed(s.taskId)).toBe(true);
});

test("follow-up runs never inherit attribution even when the employee is reassigned", async () => {
  const s = await lostClaim();
  const first = recorded(s, "succeeded");
  reconcile(s.attempt.id);
  const before = s.c.get(s.attempt.id);
  const next = worker(s.dir);
  new AssignmentCore(store.db).reassign(s.taskId, next.id, s.assignment.revision);
  const second = recorded(s, "succeeded"); // another standalone Run, not another approval
  // Restore the original proposal link: the next turn has no employee origin.
  persistProposal(s, first);
  reconcile(s.attempt.id);
  expect(s.c.byRun(second)).toBeNull();
  expect(s.c.get(s.attempt.id)).toEqual(before);
  expect(run.listEmployeeRuns({ employeeId: next.id })).toEqual([]);
});

test("Reconcile requires bearer auth, an empty strict body and bounded identifiers/cursors", async () => {
  const s = await lostClaim();
  const route = `/employee-execution/attempts/${s.attempt.id}/reconcile`;
  expect((await http(route, {}, "POST", null)).status).toBe(401);
  expect((await http(route + "?token=" + backend.API_TOKEN, {}, "POST", null)).status).toBe(401);
  for (const value of [{ runId: "fake" }, { status: "succeeded" }, { command: "ls" }, { path: "/etc" }, { accountId: "other" }, [], null]) {
    expect((await http(route, value)).status).toBe(400);
  }
  expect((await http(route + "?projectPath=/other", {})).status).toBe(400);
  expect((await http(route, undefined, "GET")).status).toBe(405);
  expect((await http(route, '"' + 'x'.repeat(5000) + '"')).status).toBe(413);
  for (const query of ["employeeId=", "employeeId=a&employeeId=b", "taskId=a&before=b", "employeeId=a&limit=101", "employeeId=a&path=/tmp"]) {
    expect((await http("/employee-execution/attempts?" + query)).status).toBe(400);
  }
});

test("reconcile, recovery and history never call a CLI or read credentials; raw errors are not disclosed", async () => {
  const s = await lostClaim();
  recorded(s, "succeeded");
  const spawn = spyOn(Bun, "spawn").mockImplementation(() => { throw new Error("Unexpected CLI"); });
  const sync = spyOn(Bun, "spawnSync").mockImplementation(() => { throw new Error("Unexpected CLI"); });
  try {
    reconcile(s.attempt.id);
    run.recoverEmployeeExecutions();
    run.listEmployeeRuns({ employeeId: s.person.id });
    expect(spawn).not.toHaveBeenCalled();
    expect(sync).not.toHaveBeenCalled();
  } finally { spawn.mockRestore(); sync.mockRestore(); }
  const t = await scenario();
  const deps = { launch: (async () => { throw new Error("password=SECRET_MARKER email@example.com"); }) as typeof execution.launchEmployeeTask };
  const a = await reviewed(t.taskId, deps);
  const out = await confirm(a.id, a.revision, {}, deps);
  expect(JSON.stringify(out) + JSON.stringify(rows(t.taskId))).not.toContain("SECRET_MARKER");
  const refused = await scenario();
  const fake = launcher({ error: "arbitrary private credential SECRET_MARKER" }).deps;
  const r = await reviewed(refused.taskId, fake);
  await confirm(r.id, r.revision, {}, fake);
  expect(JSON.stringify(rows(refused.taskId)) + JSON.stringify(store.projectExecutions.list(refused.dir, 10))).not.toContain("SECRET_MARKER");
});

test("a run link is committed with the run and a failure of the callback rolls both back before spawn", async () => {
  const s = await scenario();
  await expect(orchestrator.startTask(s.taskId, { onRunRecorded: () => { throw new Error("durability failure"); } })).rejects.toThrow("durability failure");
  expect(store.runs.countForTask(s.taskId)).toBe(0);
  expect(store.tasks.get(s.taskId)!.column).toBe("ready");
});

test("a new backend process recovers durable Starting and Running attempts without launching", async () => {
  const starting = await lostClaim();
  const running = await lostClaim();
  recorded(running, "orphaned"); // canonical runtime boot reconciliation cannot reattach it
  reconcile(running.attempt.id);
  const child = Bun.spawn(["bun", "-e", `
    const { recoverEmployeeExecutions, getEmployeeRun } = await import("./src/bun/employee-run.ts");
    recoverEmployeeExecutions();
    console.log("RECOVERY=" + JSON.stringify([getEmployeeRun(${JSON.stringify(starting.attempt.id)}), getEmployeeRun(${JSON.stringify(running.attempt.id)})]));
  `], { cwd: process.cwd(), env: { ...process.env }, stdout: "pipe", stderr: "pipe" });
  const output = new Response(child.stdout).text();
  const error = new Response(child.stderr).text();
  expect(await child.exited, await error).toBe(0);
  const line = (await output).split("\n").find((line) => line.startsWith("RECOVERY="));
  const recovered = JSON.parse(line!.slice("RECOVERY=".length));
  expect(recovered.map((a: any) => a.phase)).toEqual(["unknown-outcome", "unknown-outcome"]);
  expect(recovered[0].approvedAt).toBe(starting.c.get(starting.attempt.id)!.approved_at);
  expect(store.runs.countForTask(starting.taskId)).toBe(0);
  expect(store.runs.countForTask(running.taskId)).toBe(1);
});

test("exact reconciliation settles supervised bookkeeping once and permits a fresh Owner review after completion", async () => {
  const s = await lostClaim();
  recorded(s, "succeeded");
  reconcile(s.attempt.id);
  const proposal = store.projectExecutions.get(s.dir, s.c.get(s.attempt.id)!.execution_id!);
  expect(JSON.parse(proposal!).status).toBe("started");
  reconcile(s.attempt.id);
  expect(store.projectExecutions.get(s.dir, s.c.get(s.attempt.id)!.execution_id!)).toBe(proposal);
  const next = await reviewed(s.taskId);
  expect(next.id).not.toBe(s.attempt.id);
  expect(next.approvedAt).toBeNull();
  expect(store.runs.countForTask(s.taskId)).toBe(1);
});

test("ordinary Task Runtime start cannot bypass an unresolved employee process", async () => {
  const s = await lostClaim();
  reconcile(s.attempt.id);
  const direct = await orchestrator.startTask(s.taskId);
  expect(direct).toMatchObject({ error: expect.stringContaining("unresolved") });
  const response = await http(`/tasks/${s.taskId}/start`, {});
  expect(response.body.error).toContain("unresolved");
  expect(store.runs.countForTask(s.taskId)).toBe(0);
  const forged = await orchestrator.startTask(s.taskId, { employeeAttemptId: s.attempt.id });
  expect(forged).toMatchObject({ error: expect.stringContaining("approval") });
});

test("a bounded pending spawn remains Starting only while the exact runtime claim exists", async () => {
  const s = await scenario();
  store.harnesses.setEnabled("claude-code", true);
  store.tasks.update(s.taskId, { agent: "claude-code", model: "opus", mode: "auto" });
  const priorBin = process.env.AGETOR_CLAUDE_BIN;
  process.env.AGETOR_CLAUDE_BIN = "/bin/echo";
  const priorDriver = process.env.AGETOR_CLAUDE_DRIVER;
  process.env.AGETOR_CLAUDE_DRIVER = "fake";
  const prior = process.env.AGETOR_FAKE_CLAUDE_SPAWN_DELAY_MS;
  process.env.AGETOR_FAKE_CLAUDE_SPAWN_DELAY_MS = "1800";
  try {
    const out = await run.reviewEmployeeExecution({ taskId: s.taskId, harnessId: "claude-code" });
    expect(out.blockingErrors).toEqual([]);
    expect(out.attempt).not.toBeNull();
    const started = await confirm(out.attempt!.id, out.attempt!.revision);
    expect(started.attempt.phase).toBe("starting");
    expect(reconcile(out.attempt!.id).attempt.phase).toBe("starting");
    await waitFor(() => run.getEmployeeRun(out.attempt!.id), (v) => v.finishedAt != null, "bounded spawn finish");
  } finally {
    if (priorBin === undefined) delete process.env.AGETOR_CLAUDE_BIN;
    else process.env.AGETOR_CLAUDE_BIN = priorBin;
    if (priorDriver === undefined) delete process.env.AGETOR_CLAUDE_DRIVER;
    else process.env.AGETOR_CLAUDE_DRIVER = priorDriver;
    if (prior === undefined) delete process.env.AGETOR_FAKE_CLAUDE_SPAWN_DELAY_MS;
    else process.env.AGETOR_FAKE_CLAUDE_SPAWN_DELAY_MS = prior;
  }
});
