import { afterAll, beforeAll, beforeEach, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

/**
 * FO-010E2 employee supervised execution. Every agent is the fake codex
 * driver behind a /bin/echo stub: no real AI CLI runs, not even `--version`.
 * One isolated data dir for the file; a real API server on its own port.
 */
const isolated = realpathSync(mkdtempSync(path.join(tmpdir(), "fo010e2-")));
process.env.AGETOR_DATA_DIR = isolated;
process.env.HOME = isolated;
process.env.AGETOR_API_PORT = "4702";
process.env.AGETOR_USAGE_OFFLINE = "1";
process.env.AGETOR_CODEX_DRIVER = "fake";
process.env.AGETOR_CODEX_BIN = "/bin/echo";
process.env.AGETOR_TMUX_BIN = "/bin/echo";
for (const kind of ["CLAUDE", "CURSOR", "GEMINI", "FX", "ANTIGRAVITY"]) process.env["AGETOR_" + kind + "_BIN"] = "/nonexistent/fo010e2";

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
const base = "http://127.0.0.1:4702";
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

test("review blocks impossible immutable worktree isolation before preparing an attempt", async () => {
  const dir = project("Non-Git worktree");
  const taskId = await newTask(dir, { isolation: "worktree" });
  assign(taskId, worker(dir).id);
  const out = await review(taskId);
  expect(out.attempt).toBeNull();
  expect(out.preflight.outcome).toBe("blocked");
  expect(codes(out)).toContain("worktree-unavailable");
  expect(store.tasks.get(taskId)!.isolation).toBe("worktree");
  expect(store.runs.listForTask(taskId)).toEqual([]);
  expect(rows(taskId)).toEqual([]);
});

test("review records explicit none and requires Owner confirmation before any Run", async () => {
  const { taskId } = await scenario();
  const out = await review(taskId);
  expect(out.blockingErrors).toEqual([]);
  expect(out.attempt!.review.isolation).toBe("none");
  expect(out.attempt!.review.checks).toContainEqual(expect.objectContaining({ code: "no-isolation", level: "warning" }));
  await expectError(run.startEmployeeExecution(out.attempt!.id, { revision: out.attempt!.revision, confirm: false }), 400, "invalid");
  expect(store.runs.listForTask(taskId)).toEqual([]);
});
test("the review names the reviewed launch target: project folder, Git worktree, or the armed task workspace", async () => {
  // Direct project folder.
  const direct = await scenario();
  const directReview = await review(direct.taskId);
  expect(directReview.attempt!.review).toMatchObject({ isolation: "none", workspaceKind: "project-folder", workspace: direct.dir });
  expect(directReview.attempt!.review.stagedOutputPaths).toBeUndefined();

  // Git worktree: the project is a Git repository and the task keeps worktree isolation.
  const gitProject = (name: string) => {
    const dir = project(name);
    for (const args of [["init", "-b", "main"], ["add", "-A"], ["-c", "user.email=fo@example.invalid", "-c", "user.name=FO", "commit", "-m", "seed"]]) {
      expect(Bun.spawnSync(["git", "-C", dir, ...args]).exitCode).toBe(0);
    }
    return dir;
  };
  const repo = gitProject("worktree-target");
  const wtTask = await newTask(repo, { isolation: "worktree", mode: "ask" });
  assign(wtTask, worker(repo).id);
  // Codex Auto on a linked worktree is blocked until a task-owned workspace is approved, so review the read-only mode.
  const wtReview = await review(wtTask);
  expect(wtReview.blockingErrors).toEqual([]);
  expect(wtReview.attempt!.review).toMatchObject({ isolation: "worktree", workspaceKind: "worktree" });

  // Armed task-owned workspace: recorded with isolation none, but it is NOT the project folder.
  const stagedDir = gitProject("staged-target");
  const staged = { dir: stagedDir, taskId: await newTask(stagedDir) };
  assign(staged.taskId, worker(stagedDir).id);
  const { prepareTaskWorkspace } = await import("./task-workspace.ts");
  const prepared = await prepareTaskWorkspace(staged.taskId, { outputPaths: ["src/is-odd.ts"] });
  const stagedReview = await review(staged.taskId);
  expect(stagedReview.blockingErrors).toEqual([]);
  const facts = stagedReview.attempt!.review;
  expect(facts).toMatchObject({ isolation: "none", workspaceKind: "task-staging", stagedOutputPaths: ["src/is-odd.ts"] });
  expect(facts.workspace).toBe(realpathSync(prepared.stagingPath));
  expect(facts.workspace.startsWith(staged.dir)).toBe(false);
  // Nothing started and nothing was published by reviewing.
  expect(store.runs.listForTask(staged.taskId)).toEqual([]);
  expect(store.runs.listForTask(wtTask)).toEqual([]);
  expect(store.runs.listForTask(direct.taskId)).toEqual([]);
});
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

// ------------------------------------------------------------------------------------------
// The valid path, attribution, requested vs actual
// ------------------------------------------------------------------------------------------

test("review starts nothing; the owner's confirmation starts exactly one run attributed to the worker", async () => {
  const s = await scenario();
  const { calls, deps } = launcher();
  const out = await review(s.taskId, {}, deps);
  expect(out.blockingErrors).toEqual([]);
  const attempt = out.attempt!;
  expect(attempt).toMatchObject({ status: "awaiting-approval", phase: "awaiting-approval", runId: null, approvedAt: null });
  expect(attempt.employee).toEqual({ id: s.person.id, name: s.person.name });
  expect(attempt.assignment).toEqual({ id: s.assignment.id, revision: s.assignment.revision });
  // Reviewing and preflighting never run anything.
  expect(calls.count).toBe(0);
  expect(store.runs.countForTask(s.taskId)).toBe(0);

  const started = await confirm(attempt.id, attempt.revision, {}, deps);
  expect(started.replayed).toBe(false);
  expect(calls.count).toBe(1);
  const view = started.attempt;
  expect(view.status).toBe("started");
  expect(view.runId).toBeTruthy();
  expect(view.provenance).toEqual({ actual: "runtime", approval: "owner" });
  expect(view.executionId).toBeTruthy();
  expect(store.runs.get(view.runId!)!.taskId).toBe(s.taskId);
  expect(store.runs.countForTask(s.taskId)).toBe(1);

  // Requested comes from the review; actual only from the runtime. Model and account stay Unknown.
  expect(view.requested).toMatchObject({ harnessId: "codex", model: "gpt-6.1-sol", complexity: null });
  expect(view.actual).toEqual({ harnessId: "codex", model: null, accountId: null });

  // The supervised row records the employee origin and cannot be approved through the old flow.
  const proposals = store.projectExecutions.list(s.dir, 10).map((raw) => JSON.parse(raw));
  expect(proposals).toHaveLength(1);
  expect(proposals[0]).toMatchObject({ source: "employee", employeeRunId: attempt.id, status: "started", runId: view.runId });
  const old = await execution.approveExecution(s.dir, proposals[0].id, { revision: proposals[0].revision });
  // Idempotent on a started row: it launches nothing more.
  expect(old.ok && old.value.alreadyStarted).toBe(true);
  expect(store.runs.countForTask(s.taskId)).toBe(1);

  // The end of the run is written once from the run row.
  const done = await waitFor(() => run.getEmployeeRun(attempt.id), (v) => v.finishedAt != null, "run finish");
  expect(done).toMatchObject({ result: "succeeded", phase: "completed" });
  expect(done.reason).toContain("finished");
  expect(done.actual.model).toBeNull();
  expect(done.actual.accountId).toBeNull();
});

test("Unknown account and quota do not stop a manual start, and the router recommendation is never copied into actual", async () => {
  const s = await scenario();
  const accounts = new AccountCore(store.db);
  const one = accounts.createAccount({ provider: "openai", displayName: "Work login", externalIdentity: "owner@example.com" });
  accounts.bindHarness(one.id, "codex");
  const { deps } = launcher();
  const attempt = await reviewed(s.taskId, deps);
  expect(attempt.review.account.state).toBe("unknown");
  expect(attempt.review.account.label).toContain("Account Unknown");
  expect(attempt.review.quota.state).toBe("unknown");
  expect(attempt.review.warnings.map((w) => w.code)).toEqual(expect.arrayContaining(["account-unverified", "quota-unverified"]));
  const started = await confirm(attempt.id, attempt.revision, {}, deps);
  expect(started.attempt.actual.accountId).toBeNull();
  expect(started.attempt.actual.model).toBeNull();
  const text = JSON.stringify(started.attempt) + JSON.stringify(rows(s.taskId));
  expect(text).not.toContain("owner@example.com");
  expect(text).not.toContain("SECRET_PROMPT_MARKER");
  accounts.unbindHarness(one.id, "codex");
});

test("a requested model is recorded as requested and written to the task by the existing runtime only", async () => {
  const s = await scenario();
  const { deps } = launcher();
  const attempt = await reviewed(s.taskId, deps, { model: "gpt-6-sol" });
  expect(attempt.requested.model).toBe("gpt-6-sol");
  expect(store.tasks.get(s.taskId)!.model).toBe("gpt-6.1-sol"); // review changes nothing
  const started = await confirm(attempt.id, attempt.revision, {}, deps);
  expect(started.attempt.requested.model).toBe("gpt-6-sol");
  expect(started.attempt.actual.model).toBeNull();
});

// ------------------------------------------------------------------------------------------
// Revalidation at start
// ------------------------------------------------------------------------------------------

test("without an assignment nothing is reviewed or recorded", async () => {
  const dir = project("noassign");
  const taskId = await newTask(dir);
  const out = await review(taskId);
  expect(out.attempt).toBeNull();
  expect(codes(out)).toContain("no-assignment");
  expect(rows(taskId)).toHaveLength(0);
});

test("a stale expected assignment revision blocks the review", async () => {
  const s = await scenario();
  const out = await review(s.taskId, { expectedAssignmentRevision: s.assignment.revision + 5 });
  expect(out.attempt).toBeNull();
  expect(codes(out)).toContain("stale-assignment");
});

test("reassigning the worker after the review voids the confirmation and launches nothing", async () => {
  const s = await scenario();
  const { calls, deps } = launcher();
  const attempt = await reviewed(s.taskId, deps);
  const other = worker(s.dir);
  new AssignmentCore(store.db).reassign(s.taskId, other.id, s.assignment.revision);
  const error = await expectError(confirm(attempt.id, attempt.revision, {}, deps), 409, "approval-rejected");
  expect(error.message).toContain("Nothing was started");
  expect(calls.count).toBe(0);
  expect(rows(s.taskId)[0].status).toBe("rejected");
  expect(store.runs.countForTask(s.taskId)).toBe(0);
  // The rejected approval cannot be reused.
  await expectError(confirm(attempt.id, attempt.revision, {}, deps), 409, "approval-rejected");
  expect(calls.count).toBe(0);
});

test("an archived or inactive employee blocks the start", async () => {
  const s = await scenario();
  const { calls, deps } = launcher();
  const attempt = await reviewed(s.taskId, deps);
  store.db.run("UPDATE ai_employees SET status = 'archived', archived_at = 5 WHERE id = ?", [s.person.id]);
  await expectError(confirm(attempt.id, attempt.revision, {}, deps), 409, "approval-rejected");
  expect(calls.count).toBe(0);
  const out = await review(s.taskId, {}, deps);
  expect(codes(out)).toContain("employee-archived");
});

test("a task moved to another project, a foreign worktree, and a disabled harness each block", async () => {
  const s = await scenario();
  const { calls, deps } = launcher();
  const attempt = await reviewed(s.taskId, deps);
  const elsewhere = project("elsewhere");
  store.db.run("UPDATE tasks SET workdir = ? WHERE id = ?", [elsewhere, s.taskId]);
  await expectError(confirm(attempt.id, attempt.revision, {}, deps), 409, "approval-rejected");
  expect(calls.count).toBe(0);
  expect(codes(await review(s.taskId))).toEqual(expect.arrayContaining(["assignment-project-diverged"]));

  const t = await scenario();
  store.db.run("UPDATE tasks SET worktree_path = ? WHERE id = ?", [t.dir, t.taskId]);
  expect(codes(await review(t.taskId))).toContain("foreign-worktree");

  const u = await scenario();
  expect(codes(await run.reviewEmployeeExecution({ taskId: u.taskId, harnessId: "cursor" }))).toContain("harness-disabled");
  const attempt2 = await reviewed(u.taskId, deps);
  store.harnesses.setEnabled("codex", false);
  try {
    await expectError(confirm(attempt2.id, attempt2.revision, {}, deps), 409, "approval-rejected");
  } finally {
    store.harnesses.setEnabled("codex", true);
  }
  expect(calls.count).toBe(0);
});

test("nested projects: a task attributes to the deepest project, so the outer project's worker is refused", async () => {
  const outer = project("outer");
  const inner = project("inner", outer);
  const outerWorker = worker(outer);
  const taskId = await newTask(inner);
  // The assignment core itself refuses an employee of another project; force one to test the start check.
  store.db.run(
    `INSERT INTO employee_task_assignments (id, task_id, project_path, employee_id, status, provenance, revision, created_at, updated_at, assigned_at)
     VALUES (?, ?, ?, ?, 'active', 'owner', 1, 1, 1, 1)`,
    [crypto.randomUUID(), taskId, outer, outerWorker.id],
  );
  const out = await review(taskId);
  expect(out.attempt).toBeNull();
  expect(codes(out)).toEqual(expect.arrayContaining(["assignment-project-diverged"]));

  const innerWorker = worker(inner);
  const t2 = await newTask(inner);
  assign(t2, innerWorker.id);
  const ok = await review(t2);
  expect(ok.attempt?.projectPath).toBe(inner);
});

test("Owner restrictions still bind a manual harness choice", async () => {
  const s = await scenario();
  const out = await review(s.taskId, {}, { preflight: { owner: (saved) => ({ ...saved, allowedHarnesses: ["claude-code"] }) } });
  expect(out.attempt).toBeNull();
  expect(codes(out)).toContain("owner-policy");
  expect(rows(s.taskId)).toHaveLength(0);
});

test("a live run blocks the review and the start", async () => {
  const s = await scenario();
  const blockedAtReview = await review(s.taskId, {}, { preflight: { isLive: () => true } });
  expect(codes(blockedAtReview)).toContain("task-running");

  const { calls, deps } = launcher();
  const attempt = await reviewed(s.taskId, deps);
  await expectError(confirm(attempt.id, attempt.revision, {}, { ...deps, preflight: { isLive: () => true } }), 409, "approval-rejected");
  expect(calls.count).toBe(0);
});

test("a supervised proposal that is open for the task blocks the employee review, and pipelines are refused", async () => {
  const s = await scenario();
  const prepared = await execution.prepareExecution(s.dir, { taskId: s.taskId });
  expect(prepared.ok).toBe(true);
  expect(codes(await review(s.taskId))).toContain("proposal-open");
  if (prepared.ok) execution.dismissExecution(s.dir, prepared.value.execution.id);
  expect((await review(s.taskId)).attempt).not.toBeNull();
});

// ------------------------------------------------------------------------------------------
// Approval: single use, expiry, idempotency, concurrency
// ------------------------------------------------------------------------------------------

test("the confirmation is explicit, bound to its revision, and single use", async () => {
  const s = await scenario();
  const { calls, deps } = launcher();
  const attempt = await reviewed(s.taskId, deps);
  await expectError(run.startEmployeeExecution(attempt.id, { revision: attempt.revision }, deps), 400, "invalid"); // no confirm
  await expectError(run.startEmployeeExecution(attempt.id, { revision: attempt.revision, confirm: true, command: "ls" }, deps), 400, "invalid");
  await expectError(run.startEmployeeExecution(attempt.id, { revision: attempt.revision, confirm: true, path: "/etc" }, deps), 400, "invalid");
  await expectError(confirm(attempt.id, attempt.revision + 1, {}, deps), 409, "attempt-changed");
  await expectError(confirm(crypto.randomUUID(), 1, {}, deps), 404, "not-found");
  expect(calls.count).toBe(0);

  const first = await confirm(attempt.id, attempt.revision, {}, deps);
  const second = await confirm(attempt.id, attempt.revision, {}, deps);
  expect(first.replayed).toBe(false);
  expect(second.replayed).toBe(true);
  expect(second.attempt.runId).toBe(first.attempt.runId);
  expect(calls.count).toBe(1);
  expect(store.runs.countForTask(s.taskId)).toBe(1);
});

test("an expired review cannot be confirmed", async () => {
  const s = await scenario();
  const { calls, deps } = launcher();
  const attempt = await reviewed(s.taskId, deps);
  const later = { ...deps, now: () => attempt.expiresAt + 1 };
  await expectError(confirm(attempt.id, attempt.revision, {}, later), 409, "approval-expired");
  expect(calls.count).toBe(0);
  expect(rows(s.taskId)[0].status).toBe("expired");
});

test("repeating a review with the same inputs returns the same pending record", async () => {
  const s = await scenario();
  const a = await review(s.taskId);
  const b = await review(s.taskId);
  expect(b.reused).toBe(true);
  expect(b.attempt!.id).toBe(a.attempt!.id);
  expect(rows(s.taskId)).toHaveLength(1);
});

test("a newer review from a second tab supersedes the first", async () => {
  const s = await scenario();
  const { calls, deps } = launcher();
  const first = await reviewed(s.taskId, deps);
  const second = await reviewed(s.taskId, deps, { effort: "low" });
  expect(second.id).not.toBe(first.id);
  await expectError(confirm(first.id, first.revision, {}, deps), 409, "approval-superseded");
  expect(calls.count).toBe(0);
  const started = await confirm(second.id, second.revision, {}, deps);
  expect(started.attempt.status).toBe("started");
  expect(calls.count).toBe(1);
});

test("a double click and two tabs at once launch the runtime exactly once", async () => {
  const s = await scenario();
  const { calls, deps } = launcher();
  const slow = { ...deps, afterClaim: () => Bun.sleep(60) };
  const attempt = await reviewed(s.taskId, slow);
  const results = await Promise.allSettled([
    confirm(attempt.id, attempt.revision, {}, slow),
    confirm(attempt.id, attempt.revision, {}, slow),
    confirm(attempt.id, attempt.revision, {}, slow),
  ]);
  expect(results.every((r) => r.status === "fulfilled")).toBe(true);
  const values = results.map((r) => (r as PromiseFulfilledResult<Awaited<ReturnType<typeof confirm>>>).value);
  expect(values.filter((v) => !v.replayed)).toHaveLength(1);
  expect(calls.count).toBe(1);
  expect(store.runs.countForTask(s.taskId)).toBe(1);
  expect(rows(s.taskId).filter((r) => r.status === "started")).toHaveLength(1);
});

test("two SQLite connections cannot both claim one approval, and a task has one open claim", async () => {
  const s = await scenario();
  const attempt = await reviewed(s.taskId);
  const second = new Database(path.join(isolated, "agetor.sqlite"));
  second.run("PRAGMA busy_timeout = 5000");
  try {
    const a = new core.EmployeeRunCore(store.db);
    const b = new core.EmployeeRunCore(second);
    const claimA = a.claim(attempt.id, attempt.revision, "exec-a");
    const claimB = b.claim(attempt.id, attempt.revision, "exec-b");
    expect([claimA.ok, claimB.ok].filter(Boolean)).toHaveLength(1);
    expect(claimB).toMatchObject({ ok: false, reason: "not-open" });
    expect(rows(s.taskId)[0]).toMatchObject({ status: "starting", execution_id: "exec-a", revision: 2 });
    // The unique index also refuses a second open row for the task outright.
    expect(() => store.db.run(
      `INSERT INTO employee_executions (id, task_id, task_title, project_path, employee_id, employee_name, assignment_id, assignment_revision, status, requested_harness_id, requested_policy, requested_mode, inputs_key, task_fingerprint, config_json, review_json, created_at, updated_at, expires_at)
       VALUES ('dup', ?, 't', ?, 'e', 'n', 'a', 1, 'awaiting-approval', 'codex', 'balanced', 'auto', 'k', 'f', '{}', '{}', 1, 1, 9)`,
      [s.taskId, s.dir],
    )).toThrow();
  } finally {
    second.close();
  }
});

// ------------------------------------------------------------------------------------------
// Failure, unknown outcome, restart
// ------------------------------------------------------------------------------------------

test("a runtime start failure is recorded as failed without a run, and secrets are redacted", async () => {
  const s = await scenario();
  const { calls, deps } = launcher({ error: "the CLI exited (token sk-abcdefghijklmnopqrstuvwx)" });
  const attempt = await reviewed(s.taskId, deps);
  const out = await confirm(attempt.id, attempt.revision, {}, deps);
  expect(calls.count).toBe(1);
  expect(out.attempt).toMatchObject({ status: "start-failed", phase: "failed", runId: null, startedAt: null });
  expect(out.attempt.reason).not.toContain("sk-abcdefghijklmnopqrstuvwx");
  expect(store.runs.countForTask(s.taskId)).toBe(0);
  // Not a success anywhere: no run, no result, nothing finished.
  expect(out.attempt.result).toBeNull();
  // The old supervised flow cannot retry a failed employee start either.
  const failedRow = store.projectExecutions.list(s.dir, 5).map((raw) => JSON.parse(raw))[0];
  expect(failedRow).toMatchObject({ source: "employee", status: "start-failed" });
  const retry = await execution.approveExecution(s.dir, failedRow.id, { revision: failedRow.revision }, deps.exec);
  expect(retry.ok).toBe(false);
  expect(calls.count).toBe(1);
  // The failed approval is spent; a new review is needed.
  await expectError(confirm(attempt.id, attempt.revision, {}, deps), 409, "start-failed");
});

test("an error mid-start stays unknown, is not retried, and acknowledgement cannot allow a new review", async () => {
  const s = await scenario();
  const { calls, deps } = launcher("throw");
  const attempt = await reviewed(s.taskId, deps);
  const out = await confirm(attempt.id, attempt.revision, {}, deps);
  // A thrown exception can happen after spawn and must remain uncertain.
  expect(out.attempt.status).toBe("indeterminate");
  expect(calls.count).toBe(1);
  await confirm(attempt.id, attempt.revision, {}, deps).catch(() => null);
  expect(calls.count).toBe(1);

  // Force the thrown-error branch of the runner itself.
  const t = await scenario();
  const throwing = { launch: (async () => { throw new Error("db exploded"); }) as unknown as typeof execution.launchEmployeeTask };
  const a2 = await reviewed(t.taskId, throwing);
  const o2 = await confirm(a2.id, a2.revision, {}, throwing);
  expect(o2.attempt).toMatchObject({ status: "indeterminate", phase: "unknown-outcome" });
  expect(o2.attempt.reason).toContain("not confirmed");
  const repeat = await confirm(a2.id, a2.revision, {}, throwing);
  expect(repeat.replayed).toBe(true);
  // No new approval is issued while a previous process may exist.
  const next = await review(t.taskId, { effort: "low" }, throwing);
  expect(next.attempt).toBeNull();
  expect(codes(next)).toContain("unresolved-execution");
});

test("restart recovery never launches: a lost claim becomes unknown, or adopts the run that exists", async () => {
  const s = await scenario();
  const attempt = await reviewed(s.taskId);
  const c = new core.EmployeeRunCore(store.db);
  expect(c.claim(attempt.id, attempt.revision, "exec-lost").ok).toBe(true); // claimed, then the process "died"
  const { calls } = launcher();
  run.__testing.reset();
  expect(run.recoverEmployeeExecutions()).toBeGreaterThanOrEqual(1);
  expect(calls.count).toBe(0);
  expect(rows(s.taskId)[0]).toMatchObject({ status: "indeterminate", run_id: null });
  expect(store.runs.countForTask(s.taskId)).toBe(0);

  const t = await scenario();
  const a2 = await reviewed(t.taskId);
  expect(c.claim(a2.id, a2.revision, "exec-lost-2").ok).toBe(true);
  const started = await orchestrator.startTask(t.taskId, { employeeAttemptId: a2.id, onRunRecorded: (runId) => {
    // Exact durable link recorded before spawn; never a timestamp match.
    store.db.run("UPDATE employee_executions SET run_id = ? WHERE id = ?", [runId, a2.id]);
  } }); // the run did start before the "crash"
  expect("error" in started).toBe(false);
  run.recoverEmployeeExecutions();
  const adopted = rows(t.taskId)[0];
  expect(adopted.status).toBe("started");
  expect(adopted.run_id).toBeTruthy();
  expect(store.runs.countForTask(t.taskId)).toBe(1); // still exactly one
  await waitFor(() => run.getEmployeeRun(a2.id), (v) => v.finishedAt != null, "adopted run finish");
});

test("a claim held by this process is not treated as lost", async () => {
  const s = await scenario();
  const { deps } = launcher();
  let during = "";
  const hooked = { ...deps, afterClaim: () => { during = run.getEmployeeRun(rows(s.taskId)[0].id).status; run.recoverEmployeeExecutions(); } };
  const attempt = await reviewed(s.taskId, hooked);
  const out = await confirm(attempt.id, attempt.revision, {}, hooked);
  expect(during).toBe("starting");
  expect(out.attempt.status).toBe("started");
});

// ------------------------------------------------------------------------------------------
// Boundaries: no auto launch, no side effects, strict API
// ------------------------------------------------------------------------------------------

test("assigning, proposing, previewing and preflight never start a run or write an attribution row", async () => {
  const dir = project("quiet");
  const person = worker(dir);
  const taskId = await newTask(dir);
  const { calls } = launcher();
  const accountsBefore = store.db.query("SELECT COUNT(*) AS n FROM account_harness_bindings").get();
  assign(taskId, person.id);
  const { prepareEmployeeExecution } = await import("./employee-execution.ts");
  prepareEmployeeExecution({ taskId, harnessId: "codex" });
  const candidate = worker(dir);
  const proposed = await http("/assignment-proposals", { taskId, employeeId: candidate.id, rationale: "Fits." });
  expect([200, 201]).toContain(proposed.status);
  const grants = store.db.query("SELECT COUNT(*) AS n FROM knowledge_context_grants").get();
  expect(store.runs.countForTask(taskId)).toBe(0);
  expect(rows(taskId)).toHaveLength(0);
  expect(calls.count).toBe(0);
  expect(store.db.query("SELECT COUNT(*) AS n FROM knowledge_context_grants").get()).toEqual(grants);
  expect(store.db.query("SELECT COUNT(*) AS n FROM account_harness_bindings").get()).toEqual(accountsBefore);
  // Even a review only records a pending row: no run, task still where it was.
  await review(taskId);
  expect(store.runs.countForTask(taskId)).toBe(0);
  expect(store.tasks.get(taskId)!.column).toBe("ready");
});

test("starting an employee run changes no account, binding or knowledge grant, and leaves other runs unattributed", async () => {
  const other = await scenario();
  const preexisting = await orchestrator.startTask(other.taskId); // a run started the ordinary way
  expect("error" in preexisting).toBe(false);
  await waitFor(() => store.tasks.get(other.taskId)!.column, (c) => c !== "running", "ordinary run settle");

  const s = await scenario();
  const accounts = new AccountCore(store.db);
  const before = JSON.stringify([store.db.query("SELECT * FROM account_harness_bindings").all(), store.db.query("SELECT * FROM resource_accounts").all()]);
  const { deps } = launcher();
  const attempt = await reviewed(s.taskId, deps);
  await confirm(attempt.id, attempt.revision, {}, deps);
  expect(JSON.stringify([store.db.query("SELECT * FROM account_harness_bindings").all(), store.db.query("SELECT * FROM resource_accounts").all()])).toBe(before);
  void accounts;
  // The ordinary run was not attributed to anyone, now or later.
  expect(rows(other.taskId)).toHaveLength(0);
});

test("history by employee and by task shows the traceable chain", async () => {
  const s = await scenario();
  const { deps } = launcher();
  const attempt = await reviewed(s.taskId, deps);
  const started = await confirm(attempt.id, attempt.revision, {}, deps);
  const byEmployee = run.listEmployeeRuns({ employeeId: s.person.id });
  const byTask = run.listEmployeeRuns({ taskId: s.taskId });
  expect(byEmployee.map((v) => v.id)).toContain(attempt.id);
  expect(byTask).toHaveLength(1);
  expect(byTask[0]).toMatchObject({
    employee: { id: s.person.id },
    assignment: { id: s.assignment.id, revision: s.assignment.revision },
    taskId: s.taskId,
    runId: started.attempt.runId,
    provenance: { approval: "owner" },
  });
});

test("withdrawing a review is allowed only before confirmation", async () => {
  const s = await scenario();
  const { calls, deps } = launcher();
  const attempt = await reviewed(s.taskId, deps);
  expect(run.cancelEmployeeExecution(attempt.id, { revision: attempt.revision }).status).toBe("cancelled");
  await expectError(confirm(attempt.id, attempt.revision, {}, deps), 409, "approval-cancelled");
  expect(calls.count).toBe(0);
  const next = await reviewed(s.taskId, deps);
  await confirm(next.id, next.revision, {}, deps);
  await expectError(Promise.resolve().then(() => run.cancelEmployeeExecution(next.id, undefined)), 409, "attempt-closed");
});

// ------------------------------------------------------------------------------------------
// HTTP
// ------------------------------------------------------------------------------------------

test("every route requires the API token and rejects query tokens and unknown fields", async () => {
  const s = await scenario();
  const routes: [string, unknown, string?][] = [
    ["/employee-execution/preflight", { taskId: s.taskId }],
    ["/employee-execution/reviews", { taskId: s.taskId, harnessId: "codex" }],
    ["/employee-execution/attempts?taskId=" + s.taskId, undefined],
    ["/employee-execution/attempts/x", undefined],
    ["/employee-execution/attempts/x/start", { revision: 1, confirm: true }],
    ["/employee-execution/attempts/x/cancel", {}],
  ];
  for (const [route, body] of routes) {
    expect((await http(route, body, undefined, null)).status).toBe(401);
    expect((await http(route, body, undefined, "Bearer wrong")).status).toBe(401);
  }
  expect((await http(`/employee-execution/reviews?token=${backend.API_TOKEN}`, { taskId: s.taskId, harnessId: "codex" })).status).toBe(400);
  expect((await http("/employee-execution/reviews", { taskId: s.taskId, harnessId: "codex", command: "rm -rf /" })).status).toBe(400);
  expect((await http("/employee-execution/reviews", { taskId: s.taskId, harnessId: "codex", workdir: "/etc" })).status).toBe(400);
  expect((await http("/employee-execution/reviews", { taskId: s.taskId })).body.code).toBe("harness-required");
  expect((await http("/employee-execution/attempts?taskId=a&employeeId=b")).status).toBe(400);
  expect((await http("/employee-execution/attempts/x/start", { revision: 1 })).status).toBe(400);
  expect((await http("/employee-execution/attempts/nope")).status).toBe(404);
  expect((await http("/employee-execution/attempts/x/start", undefined, "GET")).status).toBe(405);
  expect(rows(s.taskId)).toHaveLength(0);
});

test("over HTTP: review, concurrent confirmations, one run, then history", async () => {
  const s = await scenario();
  const reviewResponse = await http("/employee-execution/reviews", { taskId: s.taskId, harnessId: "codex" });
  expect(reviewResponse.status).toBe(200);
  const attempt = reviewResponse.body.attempt;
  expect(attempt.status).toBe("awaiting-approval");
  expect(reviewResponse.body.preflight.executionAvailable).toBe(false);
  expect(store.runs.countForTask(s.taskId)).toBe(0);

  const body = { revision: attempt.revision, confirm: true };
  const [a, b] = await Promise.all([
    http(`/employee-execution/attempts/${attempt.id}/start`, body),
    http(`/employee-execution/attempts/${attempt.id}/start`, body),
  ]);
  expect([a.status, b.status]).toEqual([200, 200]);
  expect([a.body.replayed, b.body.replayed].sort()).toEqual([false, true]);
  // The repeat may arrive while the start is still being recorded and then has no run id yet.
  const ids = [a.body.attempt.runId, b.body.attempt.runId].filter(Boolean);
  expect(new Set(ids).size).toBe(1);
  expect(store.runs.countForTask(s.taskId)).toBe(1);

  const list = await http(`/employee-execution/attempts?employeeId=${s.person.id}`);
  expect(list.status).toBe(200);
  expect(list.body.attempts[0]).toMatchObject({ id: attempt.id, runId: a.body.attempt.runId });
  const finished = await waitFor(() => run.getEmployeeRun(attempt.id), (v) => v.finishedAt != null, "finish");
  expect(finished.phase).toBe("completed");
  const text = JSON.stringify([reviewResponse.body, a.body, list.body]);
  expect(text).not.toMatch(/"(token|password|apiKey|externalIdentity|env|home)"/i);
});

test("a stale confirmation over HTTP is refused with a conflict and starts nothing", async () => {
  const s = await scenario();
  const reviewResponse = await http("/employee-execution/reviews", { taskId: s.taskId, harnessId: "codex" });
  const attempt = reviewResponse.body.attempt;
  const other = worker(s.dir);
  new AssignmentCore(store.db).reassign(s.taskId, other.id, s.assignment.revision);
  const result = await http(`/employee-execution/attempts/${attempt.id}/start`, { revision: attempt.revision, confirm: true });
  expect(result.status).toBe(409);
  expect(result.body.code).toBe("approval-rejected");
  expect(store.runs.countForTask(s.taskId)).toBe(0);
});
