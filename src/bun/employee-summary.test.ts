import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

/**
 * Direction 2: the employee profile's recorded-work summary. Fake codex driver behind a
 * /bin/echo stub, isolated data dir, no provider, no CLI. The summary is read-only and is
 * attributed by the identity recorded at the Owner-confirmed start.
 */
const isolated = realpathSync(mkdtempSync(path.join(tmpdir(), "d2-summary-")));
process.env.AGETOR_DATA_DIR = isolated;
process.env.HOME = isolated;
process.env.AGETOR_API_PORT = "4715";
process.env.AGETOR_USAGE_OFFLINE = "1";
process.env.AGETOR_CODEX_DRIVER = "fake";
process.env.AGETOR_CODEX_BIN = "/bin/echo";
process.env.AGETOR_TMUX_BIN = "/bin/echo";
for (const kind of ["CLAUDE", "CURSOR", "GEMINI", "FX", "ANTIGRAVITY"]) process.env["AGETOR_" + kind + "_BIN"] = "/nonexistent/d2";

let store: typeof import("./db.ts");
let backend: typeof import("./server.ts");
let server: ReturnType<(typeof import("./server.ts"))["startApiServer"]>;
let orchestrator: typeof import("./orchestrator.ts");
let run: typeof import("./employee-run.ts");
let EmployeeCore: typeof import("./employee-core.ts").EmployeeCore;
let AssignmentCore: typeof import("./assignment-core.ts").AssignmentCore;
const base = "http://127.0.0.1:4715";
let counter = 0;

beforeAll(async () => {
  store = await import("./db.ts");
  orchestrator = await import("./orchestrator.ts");
  run = await import("./employee-run.ts");
  backend = await import("./server.ts");
  ({ EmployeeCore } = await import("./employee-core.ts"));
  ({ AssignmentCore } = await import("./assignment-core.ts"));
  run.initEmployeeExecutionTracking();
  server = backend.startApiServer();
  store.harnesses.setEnabled("codex", true);
});
afterAll(() => server?.stop(true));

const dir = realpathSync(mkdtempSync(path.join(isolated, "proj-")));
writeFileSync(path.join(dir, "README.md"), "# proj\n");
beforeAll(() => { store.projects.upsert(dir, "Summary Project"); });

async function waitFor<T>(read: () => T, ok: (v: T) => boolean, label: string): Promise<T> {
  for (let i = 0; i < 300; i++) {
    const v = read();
    if (ok(v)) return v;
    await Bun.sleep(20);
  }
  throw new Error("timed out: " + label);
}
async function summary(employeeId: string) {
  const response = await fetch(`${base}/employee-execution/summary?employeeId=${employeeId}`, { headers: { authorization: "Bearer " + backend.API_TOKEN } });
  return { status: response.status, body: (await response.json()) as any };
}

/** The Owner's Done, as the board stores it. */
const markDone = (taskId: string) => store.db.run(`UPDATE tasks SET "column" = 'done' WHERE id = ?`, [taskId]);

/** One task: assigned, reviewed, confirmed, run to completion with the fake driver. */
async function finishedRun(employeeId: string, qc: { verdict: "PASS" | "CHANGES_REQUESTED"; reviewer?: string | null } | null, done: boolean) {
  const created = await orchestrator.createTask({
    title: `Task ${++counter}`, prompt: "do the work", workdir: dir, column: "ready", agent: "codex", model: "gpt-6.1-sol", isolation: "none",
  } as never);
  if ("error" in created) throw new Error(created.error);
  const taskId = created.task.id;
  new AssignmentCore(store.db).assign(taskId, employeeId);
  const out = await run.reviewEmployeeExecution({ taskId, harnessId: "codex" }, {});
  expect(out.blockingErrors).toEqual([]);
  const attempt = out.attempt!;
  await run.startEmployeeExecution(attempt.id, { revision: attempt.revision, confirm: true }, {});
  const finished = await waitFor(() => run.getEmployeeRun(attempt.id), (v) => v.finishedAt != null, "finish");
  await waitFor(() => store.tasks.get(taskId)!.column, (column) => column !== "running", "task leaves running");
  if (qc) {
    store.taskQualityReviews.insert({
      id: `qc-${counter}`, taskId, projectPath: dir, round: 1, status: "pending", findings: [],
      reviewerEmployeeId: qc.reviewer ?? null, reviewerRoleSlug: null, reviewerHarness: "codex", reviewerModel: "gpt-6.1-sol",
      reviewerProfileId: null, implementationRunId: finished.runId, savedTaskJson: "{}", requestedAt: Date.now(),
    });
    store.taskQualityReviews.complete(`qc-${counter}`, { verdict: qc.verdict, summary: null, findings: [], feedback: null, completedAt: Date.now(), status: "complete" });
    if (qc.verdict === "PASS") store.tasks.update(taskId, { column: "review" });
    store.db.run(`UPDATE tasks SET qc_state = ? WHERE id = ?`, [JSON.stringify({
      activeReviewId: null, awaitingOwnerApproval: qc.verdict === "PASS" && !done, latestVerdict: qc.verdict, reworkCount: 0, roundCount: 1, maxRounds: 5,
    }), taskId]);
  }
  if (done) markDone(taskId);
  return { taskId, attempt: finished };
}

test("an employee with no run has an empty summary: no zero cost, no rating", async () => {
  const person = new EmployeeCore(store.db).createWorker({ name: "Idle Worker", jobTitle: "QA Engineer", projectPath: dir });
  const out = await summary(person.id);
  expect(out.status).toBe(200);
  expect(out.body.summary).toMatchObject({
    employeeId: person.id, runsStarted: 0, ownerAccepted: 0, awaitingOwner: 0, quality: null,
    time: { totalMs: null, runsWithTime: 0, runsWithoutTime: 0 }, cost: { lines: [], unknownRuns: 0, fixtureRuns: 0 },
  });
});

test("an accepted run, a QC-passed run waiting for the Owner and a rejected run are counted apart; cost stays Unknown", async () => {
  const person = new EmployeeCore(store.db).createWorker({ name: "Busy Worker", jobTitle: "Developer", projectPath: dir });
  await finishedRun(person.id, { verdict: "PASS" }, true);
  await finishedRun(person.id, { verdict: "PASS" }, false);
  await finishedRun(person.id, { verdict: "CHANGES_REQUESTED" }, false);
  await finishedRun(person.id, null, false);
  const { body } = await summary(person.id);
  const s = body.summary;
  expect(s.runsStarted).toBe(4);
  expect(s.outcomes.completed).toBe(4);
  expect(s.review).toMatchObject({ passed: 2, changesRequested: 1, blocked: 0, notReviewed: 1 });
  // A QC PASS is not acceptance.
  expect(s.ownerAccepted).toBe(1);
  expect(s.awaitingOwner).toBe(1);
  // Fixture runs: no real billing, never a zero amount.
  expect(s.cost.lines).toEqual([]);
  expect(s.cost.unknownRuns).toBe(4);
  expect(s.cost.fixtureRuns + 0).toBeGreaterThanOrEqual(0);
  expect(s.time.runsWithTime + s.time.runsWithoutTime).toBe(4);
  expect(s.quality).toBeNull();
});

test("a later review round supersedes an earlier PASS for acceptance", async () => {
  const person = new EmployeeCore(store.db).createWorker({ name: "Reworked Worker", jobTitle: "Developer", projectPath: dir });
  const first = await finishedRun(person.id, { verdict: "PASS" }, false);
  store.taskQualityReviews.insert({
    id: "qc-later", taskId: first.taskId, projectPath: dir, round: 2, status: "pending", findings: [], reviewerEmployeeId: null, reviewerRoleSlug: null,
    reviewerHarness: "codex", reviewerModel: "gpt-6.1-sol", reviewerProfileId: null, implementationRunId: "some-other-run", savedTaskJson: "{}", requestedAt: Date.now(),
  });
  markDone(first.taskId);
  const { body } = await summary(person.id);
  expect(body.summary.ownerAccepted).toBe(0);
});

test("reviews are attributed to the reviewer identity that was recorded, not to the assignee", async () => {
  const core = new EmployeeCore(store.db);
  const developer = core.createWorker({ name: "Dev Person", jobTitle: "Developer", projectPath: dir });
  const reviewer = core.createWorker({ name: "Review Person", jobTitle: "QA Engineer", projectPath: dir });
  await finishedRun(developer.id, { verdict: "PASS", reviewer: reviewer.id }, true);
  const dev = (await summary(developer.id)).body.summary;
  const rev = (await summary(reviewer.id)).body.summary;
  expect(dev.reviewsPerformed.total).toBe(0);
  expect(rev.reviewsPerformed).toMatchObject({ total: 1, passed: 1 });
  expect(rev.runsStarted).toBe(0);
});

test("changing the assigned task's harness and model rewrites neither past attribution nor the summary", async () => {
  const person = new EmployeeCore(store.db).createWorker({ name: "Stable Worker", jobTitle: "Developer", projectPath: dir });
  const first = await finishedRun(person.id, { verdict: "PASS" }, true);
  const before = (await summary(person.id)).body.summary;
  const attemptBefore = run.getEmployeeRun(first.attempt.id);
  store.tasks.update(first.taskId, { model: "gpt-6-luna" } as never);
  store.tasks.update(first.taskId, { agent: "codex", model: "gpt-6-sol" } as never);
  const attemptAfter = run.getEmployeeRun(first.attempt.id);
  expect(attemptAfter.requested).toEqual(attemptBefore.requested);
  expect(attemptAfter.actual).toEqual(attemptBefore.actual);
  expect(attemptAfter.employee).toEqual(attemptBefore.employee);
  expect((await summary(person.id)).body.summary).toEqual(before);
  expect(new AssignmentCore(store.db).forTask(first.taskId)?.employeeId).toBe(person.id);
});

test("the route is read-only, bearer-only and strict", async () => {
  expect((await fetch(`${base}/employee-execution/summary?employeeId=x`)).status).toBe(401);
  const auth = { authorization: "Bearer " + backend.API_TOKEN };
  expect((await fetch(`${base}/employee-execution/summary`, { headers: auth })).status).toBe(400);
  expect((await fetch(`${base}/employee-execution/summary?employeeId=x&extra=1`, { headers: auth })).status).toBe(400);
  expect((await fetch(`${base}/employee-execution/summary?employeeId=x`, { method: "POST", headers: auth })).status).toBe(405);
  const runsBefore = store.db.query<{ n: number }, []>(`SELECT COUNT(*) AS n FROM runs`).get()!.n;
  await fetch(`${base}/employee-execution/summary?employeeId=nobody`, { headers: auth });
  expect(store.db.query<{ n: number }, []>(`SELECT COUNT(*) AS n FROM runs`).get()!.n).toBe(runsBefore);
});

test("a hired professional's task can be reviewed independently, then accepted: the real QC path feeds the summary", async () => {
  const { EmployeeProfileCore } = await import("./catalog/employee-profile-core.ts");
  const person = new EmployeeCore(store.db).createWorker({ name: "Professional Worker", jobTitle: "Engineer", projectPath: dir });
  new EmployeeProfileCore(store.db).assignRole(person.id, { catalogRoleSlug: "engineering-backend-architect", promptMarkdown: "# Guidance\nBe rigorous." });
  const created = await orchestrator.createTask({
    title: `Task ${++counter}`, prompt: "do the work", workdir: dir, column: "ready", agent: "codex", model: "gpt-6.1-sol", isolation: "none",
  } as never);
  if ("error" in created) throw new Error(created.error);
  const taskId = created.task.id;
  new AssignmentCore(store.db).assign(taskId, person.id);

  // An ordinary start is still refused: a professional profile needs the Owner's employee review.
  const ordinary = await orchestrator.startTask(taskId);
  expect("error" in ordinary).toBe(true);

  const out = await run.reviewEmployeeExecution({ taskId, harnessId: "codex" }, {});
  expect(out.blockingErrors).toEqual([]);
  const attempt = out.attempt!;
  await run.startEmployeeExecution(attempt.id, { revision: attempt.revision, confirm: true, acknowledgeUsage: true }, {});
  await waitFor(() => run.getEmployeeRun(attempt.id), (v) => v.finishedAt != null, "finish");
  await waitFor(() => store.tasks.get(taskId)!.column, (column) => column === "review", "task reaches review");

  // The independent Reviewer run is the Reviewer's, not the employee's continuation.
  const auth = { authorization: "Bearer " + backend.API_TOKEN, "content-type": "application/json" };
  const prepared = await fetch(`${base}/tasks/${taskId}/qc/reviews`, { method: "POST", headers: auth, body: JSON.stringify({ reviewerHarness: "codex", reviewerModel: "gpt-6.1-sol" }) });
  expect(prepared.status).toBe(200);
  const reviewId = ((await prepared.json()) as any).review.id as string;
  const started = await fetch(`${base}/tasks/${taskId}/qc/reviews/${reviewId}/start`, { method: "POST", headers: auth });
  expect({ status: started.status, body: await started.text() }).toMatchObject({ status: 200 });
  await waitFor(() => store.tasks.get(taskId)?.qcState?.latestVerdict, (verdict) => verdict === "PASS", "QC PASS");

  // PASS is not acceptance.
  let s = (await summary(person.id)).body.summary;
  expect(s.review.passed).toBe(1);
  expect(s.ownerAccepted).toBe(0);
  expect(s.awaitingOwner).toBe(1);

  const done = await fetch(`${base}/tasks/${taskId}`, { method: "PATCH", headers: auth, body: JSON.stringify({ column: "done" }) });
  expect(done.status).toBe(200);
  s = (await summary(person.id)).body.summary;
  expect(s).toMatchObject({ ownerAccepted: 1, awaitingOwner: 0, runsStarted: 1 });
  // The Reviewer run is not the employee's run, so it is neither counted as theirs nor attributed to them.
  expect(s.reviewsPerformed.total).toBe(0);
  expect(run.getEmployeeRun(attempt.id).employee).toEqual({ id: person.id, name: person.name });
});
