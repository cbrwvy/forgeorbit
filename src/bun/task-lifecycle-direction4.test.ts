import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtempSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

/**
 * Direction 4 (offline): dependencies across two tasks, repeated rework with deterministic review verdicts,
 * the separate Owner acceptance, and changed output after a PASS. Fake claude driver, isolated data dir.
 */
const root = realpathSync(mkdtempSync(path.join(tmpdir(), "fo-d4-")));
process.env.AGETOR_DATA_DIR = root;
process.env.HOME = root;
process.env.AGETOR_API_PORT = "4408";
process.env.AGETOR_USAGE_OFFLINE = "1";
process.env.AGETOR_CLAUDE_DRIVER = "fake";
process.env.AGETOR_TMUX_BIN = "/bin/echo";

let store: typeof import("./db.ts");
let orchestrator: typeof import("./orchestrator.ts");
let backend: typeof import("./server.ts");
let server: { stop: (force?: boolean) => void };
const base = "http://127.0.0.1:4408";
let counter = 0;

beforeAll(async () => {
  store = await import("./db.ts");
  orchestrator = await import("./orchestrator.ts");
  backend = await import("./server.ts");
  server = backend.startApiServer() as unknown as typeof server;
});
afterAll(() => server?.stop(true));

async function call(method: string, route: string, body?: unknown) {
  const response = await fetch(base + route, {
    method, headers: { authorization: "Bearer " + backend.API_TOKEN, "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await response.text();
  return { status: response.status, body: text ? JSON.parse(text) : null };
}
const project = (name: string) => {
  const dir = realpathSync(mkdtempSync(path.join(root, `${name}-`)));
  store.projects.upsert(dir, name);
  return dir;
};
async function ready(dir: string, title: string) {
  const made = await orchestrator.createTask({ title, prompt: `Implement ${title}`, workdir: dir, column: "ready", agent: "claude-code", model: "opus-5.5", isolation: "none" } as never);
  if ("error" in made) throw new Error(made.error);
  return made.task;
}
async function waitFor<T>(read: () => T, ok: (v: T) => boolean, label: string): Promise<T> {
  for (let i = 0; i < 400; i++) { const v = read(); if (ok(v)) return v; await Bun.sleep(25); }
  throw new Error("timed out: " + label);
}
const runCount = (taskId: string) => store.runs.countForTask(taskId);
async function implement(taskId: string) {
  const before = runCount(taskId);
  const started = await orchestrator.startTask(taskId);
  if ("error" in started) throw new Error(started.error);
  await waitFor(() => store.tasks.get(taskId)!.column, (c) => c === "review", "implementation reaches Review");
  expect(runCount(taskId)).toBe(before + 1);
}
async function review(taskId: string, verdict: "PASS" | "CHANGES_REQUESTED" | "BLOCKED") {
  process.env.AGETOR_FAKE_QC_VERDICT = verdict;
  const round = store.taskQualityReviews.listForTask(taskId).length + 1;
  const prepared = await call("POST", `/tasks/${taskId}/qc/reviews`, { reviewerHarness: "claude-code", reviewerModel: "opus-5.5" });
  expect(prepared.status).toBe(200);
  const started = await call("POST", `/tasks/${taskId}/qc/reviews/${prepared.body.review.id}/start`);
  expect(started.status).toBe(200);
  await waitFor(() => store.tasks.get(taskId)!.qcState?.roundCount, (n) => n === round && !store.tasks.get(taskId)!.qcState?.activeReviewId, `round ${round} settles`);
  await waitFor(() => store.tasks.get(taskId)!.column, (c) => c !== "running", "task settles");
  delete process.env.AGETOR_FAKE_QC_VERDICT;
  return store.tasks.get(taskId)!;
}
const done = (taskId: string) => call("PATCH", `/tasks/${taskId}`, { column: "done" });

test("a dependent task waits for Done, not for a finished run or a passed review; a refused start creates no run", async () => {
  const dir = project("dep");
  const a = await ready(dir, "Prerequisite");
  const b = await ready(dir, "Successor");
  const link = await call("PUT", `/project-manager/tasks/${b.id}/scheduling`, { path: dir, dependsOn: [a.id] });
  expect(link.status).toBe(200);

  // Prerequisite not started: refused with the reason, and no run row exists.
  let refused = await orchestrator.startTask(b.id);
  expect("error" in refused && refused.error).toMatch(/dependencies are not satisfied.*Prerequisite.*not Done yet \(ready\)/s);
  expect(runCount(b.id)).toBe(0);
  expect(store.tasks.get(b.id)!.column).toBe("ready");

  // The prerequisite finishes execution: it sits in Review, and that does not open the gate.
  await implement(a.id);
  refused = await orchestrator.startTask(b.id);
  expect("error" in refused && refused.error).toMatch(/not Done yet \(review\).*finished run in Review does not count/s);
  expect(runCount(b.id)).toBe(0);

  // Review PASS is still not acceptance.
  const passed = await review(a.id, "PASS");
  expect(passed.column).toBe("review");
  expect(passed.qcState).toMatchObject({ latestVerdict: "PASS", awaitingOwnerApproval: true });
  refused = await orchestrator.startTask(b.id);
  expect("error" in refused && refused.error).toMatch(/not Done yet \(review\)/);
  expect(runCount(b.id)).toBe(0);

  // Only the Owner's Accept opens it.
  expect((await done(a.id)).status).toBe(200);
  const opened = await orchestrator.startTask(b.id);
  expect("runId" in opened).toBe(true);
  expect(runCount(b.id)).toBe(1);
  await waitFor(() => store.tasks.get(b.id)!.column, (c) => c === "review", "successor reaches Review");
});

test("invalid dependency requests are refused with a reason and change nothing", async () => {
  const dir = project("deps-invalid");
  const other = project("deps-other");
  const x = await ready(dir, "X");
  const y = await ready(dir, "Y");
  const z = await ready(dir, "Z");
  const foreign = await ready(other, "Foreign");
  const put = (id: string, dependsOn: string[]) => call("PUT", `/project-manager/tasks/${id}/scheduling`, { path: dir, dependsOn });
  expect((await put(x.id, [y.id])).status).toBe(200);
  expect((await put(y.id, [z.id])).status).toBe(200);
  const cycle = await put(z.id, [x.id]);
  expect(cycle.status).toBe(409);
  expect(cycle.body).toMatchObject({ code: "cycle" });
  expect(cycle.body.error).toMatch(/cycle: .*→/);
  expect(store.taskScheduling.dependenciesOf(z.id)).toEqual([]);
  expect(await put(x.id, [x.id])).toMatchObject({ status: 409, body: { code: "self" } });
  expect(await put(x.id, [foreign.id])).toMatchObject({ status: 409, body: { code: "other-project" } });
  expect(await put(x.id, ["00000000-0000-4000-8000-000000000000"])).toMatchObject({ status: 404, body: { code: "missing" } });
  expect(store.taskScheduling.dependenciesOf(x.id)).toEqual([y.id]);
  // None of the refusals started or created anything.
  for (const t of [x, y, z, foreign]) expect(runCount(t.id)).toBe(0);
});

test("repeated rework: each CHANGES_REQUESTED returns the task to Ready with history kept; PASS waits for the Owner; only Accept finishes", async () => {
  const dir = project("rework");
  const task = await ready(dir, "Reworked");
  const runIds: string[] = [];

  // Round 1: changes requested.
  await implement(task.id);
  runIds.push(store.tasks.get(task.id)!.runId!);
  let current = await review(task.id, "CHANGES_REQUESTED");
  expect(current.column).toBe("ready");
  expect(current.qcState).toMatchObject({ latestVerdict: "CHANGES_REQUESTED", reworkCount: 1, roundCount: 1, awaitingOwnerApproval: false });
  expect((await done(task.id)).status).toBe(409);

  // Round 2: the rework run's output is reviewed again; changes requested again.
  await implement(task.id);
  runIds.push(store.tasks.get(task.id)!.runId!);
  current = await review(task.id, "CHANGES_REQUESTED");
  expect(current.column).toBe("ready");
  expect(current.qcState).toMatchObject({ latestVerdict: "CHANGES_REQUESTED", reworkCount: 2, roundCount: 2, awaitingOwnerApproval: false });
  expect((await done(task.id)).status).toBe(409);

  // Round 3: PASS. The task waits in Review for the Owner; nothing moved it to Done.
  await implement(task.id);
  runIds.push(store.tasks.get(task.id)!.runId!);
  current = await review(task.id, "PASS");
  expect(current.column).toBe("review");
  expect(current.qcState).toMatchObject({ latestVerdict: "PASS", reworkCount: 2, roundCount: 3, awaitingOwnerApproval: true });

  // Prior attempts and verdicts are all kept, and each round names the implementation run it reviewed.
  const reviews = store.taskQualityReviews.listForTask(task.id);
  expect(reviews.map((r) => [r.round, r.verdict])).toEqual([[1, "CHANGES_REQUESTED"], [2, "CHANGES_REQUESTED"], [3, "PASS"]]);
  expect(reviews.map((r) => r.implementationRunId)).toEqual(runIds);
  expect(new Set(runIds).size).toBe(3);
  expect(runCount(task.id)).toBe(6); // three implementation runs and three review runs
  // Old evidence is told apart from evidence for the latest result.
  const bundle = (await call("GET", `/tasks/${task.id}/qc`)).body;
  expect(bundle.reviews.map((r: any) => [r.round, r.implementationAttempt, r.coversLatestOutput])).toEqual([[1, 1, false], [2, 2, false], [3, 3, true]]);

  // The Owner's separate action is the only way to Done.
  expect(store.tasks.get(task.id)!.column).toBe("review");
  expect((await done(task.id)).status).toBe(200);
  expect(store.tasks.get(task.id)!.column).toBe("done");
  expect(store.tasks.get(task.id)!.qcState).toMatchObject({ awaitingOwnerApproval: false, latestVerdict: "PASS" });
});

test("changed output after a PASS cannot be accepted on the earlier approval", async () => {
  const dir = project("stale-pass");
  const task = await ready(dir, "Changed after pass");
  await implement(task.id);
  const reviewedRun = store.tasks.get(task.id)!.runId!;
  const passed = await review(task.id, "PASS");
  expect(passed.qcState).toMatchObject({ latestVerdict: "PASS", awaitingOwnerApproval: true });

  // The Owner asks for a change from the Review column: a new implementation run produces different output.
  const followUp = await call("POST", `/runs/${reviewedRun}/input`, { line: "Change the output once more." });
  expect(followUp.status).toBe(200);
  await waitFor(() => runCount(task.id), (n) => n >= 3, "a new run exists");
  await waitFor(() => store.tasks.get(task.id)!.column, (c) => c === "review", "changed output reaches Review");
  const latestRun = store.tasks.get(task.id)!.runId!;
  expect(latestRun).not.toBe(reviewedRun);

  // The earlier PASS reviewed the earlier run. It must not authorize the later one.
  const state = store.tasks.get(task.id)!.qcState!;
  expect({ awaiting: state.awaitingOwnerApproval, verdict: state.latestVerdict }).toEqual({ awaiting: false, verdict: null });
  // The attention that said "passed, waiting for you" is gone; the task is still in Review with no verdict for this output.
  expect(store.tasks.get(task.id)!.column).toBe("review");
  // The earlier round and its verdict are still on record, tied to the run it reviewed.
  const first = store.taskQualityReviews.listForTask(task.id)[0]!;
  expect(first).toMatchObject({ round: 1, verdict: "PASS", implementationRunId: reviewedRun });
  const stale = (await call("GET", `/tasks/${task.id}/qc`)).body.reviews[0];
  expect(stale).toMatchObject({ round: 1, verdict: "PASS", implementationAttempt: 1, coversLatestOutput: false });
  // A fresh review of the changed output is required, and its PASS then waits for the Owner again.
  const second = await review(task.id, "PASS");
  expect(second.qcState).toMatchObject({ latestVerdict: "PASS", awaitingOwnerApproval: true, roundCount: 2 });
  expect(store.taskQualityReviews.listForTask(task.id)[1]!.implementationRunId).toBe(latestRun);
  const fresh = (await call("GET", `/tasks/${task.id}/qc`)).body.reviews;
  expect(fresh.map((r: any) => [r.round, r.coversLatestOutput])).toEqual([[1, false], [2, true]]);
  expect((await done(task.id)).status).toBe(200);
});

test("Prepare on a worktree-isolated task in a non-Git folder refuses in plain words and creates nothing", async () => {
  const { EmployeeCore } = await import("./employee-core.ts");
  const { AssignmentCore } = await import("./assignment-core.ts");
  const dir = project("worktree-refusal");
  const worker = new EmployeeCore(store.db).createWorker({ name: "Preflight Worker", jobTitle: "Engineer", projectPath: dir });
  const made = await orchestrator.createTask({ title: "Needs a worktree", prompt: "x", workdir: dir, column: "ready", agent: "claude-code", model: "opus-5.5", isolation: "worktree" } as never);
  if ("error" in made) throw new Error(made.error);
  new AssignmentCore(store.db).assign(made.task.id, worker.id);
  const before = { runs: runCount(made.task.id), attempts: store.db.query<{ n: number }, []>("SELECT COUNT(*) n FROM employee_executions").get()!.n };
  const out = await call("POST", "/employee-execution/preflight", { taskId: made.task.id, harnessId: "claude-code" });
  expect(out.status).toBe(200);
  const codes = [...out.body.preflight.blockingErrors, ...(out.body.preflight.errors ?? [])].map((e: any) => e.code);
  expect(out.body.preflight.outcome).toBe("blocked");
  const issue = [...(out.body.preflight.blockingErrors ?? [])].find((e: any) => e.code === "worktree-unavailable");
  expect(issue?.message).toMatch(/requires a Git worktree, but its folder is not a Git repository/);
  expect(codes).toContain("worktree-unavailable");
  expect(runCount(made.task.id)).toBe(before.runs);
  expect(store.db.query<{ n: number }, []>("SELECT COUNT(*) n FROM employee_executions").get()!.n).toBe(before.attempts);
  expect(store.tasks.get(made.task.id)!.column).toBe("ready");
  // A task with isolation off in the same folder is not refused for this reason.
  const plain = await ready(dir, "No isolation");
  new AssignmentCore(store.db).assign(plain.id, worker.id);
  const ok = await call("POST", "/employee-execution/preflight", { taskId: plain.id, harnessId: "claude-code" });
  expect(ok.body.preflight.blockingErrors.map((e: any) => e.code)).not.toContain("worktree-unavailable");
});
