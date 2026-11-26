import { afterAll, beforeAll, expect, setDefaultTimeout, test } from "bun:test";
import { mkdtempSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

/**
 * Direction 8 (offline): the common acceptance rule: a task that entered QC reaches Done only with a fresh PASS covering the current output.
 * Fake claude driver with deterministic verdicts, isolated data directory, no provider.
 */
setDefaultTimeout(60_000);
const root = realpathSync(mkdtempSync(path.join(tmpdir(), "fo-d8r-")));
process.env.AGETOR_DATA_DIR = root;
process.env.HOME = root;
process.env.AGETOR_API_PORT = "4854";
process.env.AGETOR_USAGE_OFFLINE = "1";
process.env.AGETOR_CLAUDE_DRIVER = "fake";
process.env.AGETOR_TMUX_BIN = "/bin/echo";

let store: typeof import("./db.ts");
let orchestrator: typeof import("./orchestrator.ts");
let backend: typeof import("./server.ts");
let server: { stop: (force?: boolean) => void };
const base = "http://127.0.0.1:4854";

beforeAll(async () => {
  store = await import("./db.ts");
  orchestrator = await import("./orchestrator.ts");
  backend = await import("./server.ts");
  server = backend.startApiServer() as unknown as typeof server;
});
afterAll(() => server?.stop(true));

async function call(method: string, route: string, body?: unknown, headers: Record<string, string> | null = null) {
  const response = await fetch(base + route, {
    method,
    headers: headers ?? { authorization: "Bearer " + backend.API_TOKEN, "content-type": "application/json" },
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
async function implement(taskId: string) {
  const before = store.runs.countForTask(taskId);
  const started = await orchestrator.startTask(taskId);
  if ("error" in started) throw new Error(started.error);
  await waitFor(() => store.tasks.get(taskId)!.column, (c) => c === "review", "implementation reaches Review");
  expect(store.runs.countForTask(taskId)).toBe(before + 1);
}
async function review(taskId: string, verdict: "PASS" | "CHANGES_REQUESTED" | "BLOCKED" | "FAIL") {
  // "FAIL": the Reviewer process fails and produces no verdict (a model-not-found style failure).
  process.env.AGETOR_FAKE_QC_VERDICT = verdict === "FAIL" ? "MODEL_NOT_FOUND" : verdict;
  const round = store.taskQualityReviews.listForTask(taskId).length + 1;
  const prepared = await call("POST", `/tasks/${taskId}/qc/reviews`, { reviewerHarness: "claude-code", reviewerModel: "opus-5.5" });
  expect(prepared.status, JSON.stringify(prepared.body)).toBe(200);
  const started = await call("POST", `/tasks/${taskId}/qc/reviews/${prepared.body.review.id}/start`);
  expect(started.status).toBe(200);
  await waitFor(() => store.tasks.get(taskId)!.qcState?.roundCount, (n) => n === round && !store.tasks.get(taskId)!.qcState?.activeReviewId, `round ${round} settles`);
  await waitFor(() => store.tasks.get(taskId)!.column, (c) => c !== "running", "task settles");
  delete process.env.AGETOR_FAKE_QC_VERDICT;
  return store.tasks.get(taskId)!;
}
/** Five rounds of CHANGES_REQUESTED: the task ends Blocked with the limit reached. */
async function blockedAtLimit(name: string) {
  const dir = project(name);
  const task = await ready(dir, name);
  for (let round = 1; round <= 5; round++) {
    await implement(task.id);
    await review(task.id, "CHANGES_REQUESTED");
  }
  expect(store.tasks.get(task.id)!.column).toBe("blocked");
  return task;
}
const done = (taskId: string) => call("PATCH", `/tasks/${taskId}`, { column: "done" });
const extend = (taskId: string, round = 5) => call("POST", `/tasks/${taskId}/qc/extension`, { confirm: true, expectedRound: round });
const journal = (taskId: string, type: string) =>
  store.db.query<{ actor_type: string; actor_id: string; task_id: string; created_at: number; payload_json: string }, [string, string]>(
    `SELECT actor_type, actor_id, task_id, created_at, payload_json FROM activity_events WHERE task_id = ? AND event_type = ?`,
  ).all(taskId, type);
const reviewVerdicts = (taskId: string) => store.taskQualityReviews.listForTask(taskId).map((r) => [r.round, r.status, r.verdict]);


/** Rounds 1..4 of CHANGES_REQUESTED, then the fifth round's Reviewer fails with no verdict. */
async function failedFifthRound(name: string) {
  const dir = project(name);
  const task = await ready(dir, name);
  for (let round = 1; round <= 4; round++) {
    await implement(task.id);
    await review(task.id, "CHANGES_REQUESTED");
  }
  await implement(task.id);
  const failed = await review(task.id, "FAIL");
  return { task, failed };
}

test("REPORTED BYPASS: a Reviewer that fails at the fifth round leaves no verdict; the task stays Blocked and Done is refused on every acceptance entry point", async () => {
  const { task, failed } = await failedFifthRound("bypass");
  // No verdict was obtained and none is invented.
  expect(failed.qcState).toMatchObject({ roundCount: 5, latestVerdict: null, awaitingOwnerApproval: false, activeReviewId: null });
  const last = store.taskQualityReviews.listForTask(task.id)[4]!;
  expect(last).toMatchObject({ round: 5, status: "complete", verdict: null });
  expect(failed.column).toBe("blocked");

  // The board / task route.
  const viaPatch = await done(task.id);
  expect(viaPatch.status, "the failed Reviewer must not make the task Done").toBe(409);
  expect(viaPatch.body.error).toContain("no verdict");
  expect(store.tasks.get(task.id)!.column).toBe("blocked");
  // Automatic completion and the shared gate.
  const { acceptAuthorizedTaskDone, assertCanMoveTaskToDone } = await import("./task-quality-control.ts");
  expect(assertCanMoveTaskToDone(store.tasks.get(task.id)!)).toContain("no verdict");
  const auto = acceptAuthorizedTaskDone(task.id);
  expect(auto.ok).toBe(false);
  expect(store.tasks.get(task.id)!.column).not.toBe("done");
  // Moving the card to Review by hand does not help either.
  expect((await call("PATCH", `/tasks/${task.id}`, { column: "review" })).status).toBe(200);
  expect((await done(task.id)).status).toBe(409);
  expect(store.tasks.get(task.id)!.column).not.toBe("done");
});

test("at the fifth round with no verdict the one-time extension qualifies: it needs new output, starts nothing, keeps the records, and only a fresh PASS leads to Done", async () => {
  const { task } = await failedFifthRound("extend-after-fail");
  const reviewsBefore = store.taskQualityReviews.listForTask(task.id).map((r) => [r.round, r.status, r.verdict]);
  const runsBefore = store.runs.countForTask(task.id);
  const granted = await extend(task.id, 5);
  expect(granted.status, JSON.stringify(granted.body)).toBe(200);
  expect(granted.body.replayed).toBe(false);
  expect(store.runs.countForTask(task.id)).toBe(runsBefore);
  expect(store.taskQualityReviews.listForTask(task.id).map((r) => [r.round, r.status, r.verdict])).toEqual(reviewsBefore);
  expect(store.tasks.get(task.id)!.qcState).toMatchObject({ roundCount: 5, maxRounds: 6, latestVerdict: null });
  expect((await done(task.id)).status).toBe(409);
  // New output is required.
  await implement(task.id);
  const passed = await review(task.id, "PASS");
  expect(passed.qcState).toMatchObject({ roundCount: 6, latestVerdict: "PASS", awaitingOwnerApproval: true });
  expect(passed.column).toBe("review");
  expect((await done(task.id)).status).toBe(200);
  expect(store.tasks.get(task.id)!.column).toBe("done");
  expect(store.tasks.get(task.id)!.qcState).toMatchObject({ awaitingOwnerApproval: false, latestVerdict: "PASS" });
});

test("a failed additional round is spent and does not unlock Done; the extension cannot be granted twice", async () => {
  const { task } = await failedFifthRound("extra-fails");
  expect((await extend(task.id, 5)).status).toBe(200);
  await implement(task.id);
  const failed = await review(task.id, "FAIL");
  expect(failed.column).toBe("blocked");
  expect(failed.qcState).toMatchObject({ roundCount: 6, latestVerdict: null });
  expect(failed.qcState!.extension).toMatchObject({ outcome: "none" });
  expect((await done(task.id)).status).toBe(409);
  const again = await extend(task.id, 6);
  expect(again.status).toBe(409);
  expect(again.body.code).toBe("extension-used");
  expect(store.tasks.get(task.id)!.column).toBe("blocked");
});

test("any earlier failed Reviewer (not only the fifth) leaves no PASS, so Done is refused", async () => {
  const dir = project("early-fail");
  const task = await ready(dir, "early-fail");
  await implement(task.id);
  const failed = await review(task.id, "FAIL");
  expect(failed.qcState).toMatchObject({ roundCount: 1, latestVerdict: null });
  expect((await done(task.id)).status).toBe(409);
  expect(store.tasks.get(task.id)!.column).not.toBe("done");
});

test("a PASS withdrawn by new output no longer covers the current output: Done is refused until a fresh PASS", async () => {
  const dir = project("withdrawn");
  const task = await ready(dir, "withdrawn");
  await implement(task.id);
  const first = await review(task.id, "PASS");
  expect(first.qcState).toMatchObject({ latestVerdict: "PASS", awaitingOwnerApproval: true });
  const followUp = await call("POST", `/runs/${store.tasks.get(task.id)!.runId}/input`, { line: "Change the output once more." });
  expect(followUp.status).toBe(200);
  await waitFor(() => store.runs.countForTask(task.id), (n) => n >= 3, "a new run exists");
  await waitFor(() => store.tasks.get(task.id)!.column, (c) => c === "review", "changed output reaches Review");
  expect(store.tasks.get(task.id)!.qcState).toMatchObject({ latestVerdict: null, awaitingOwnerApproval: false });
  const refused = await done(task.id);
  expect(refused.status).toBe(409);
  const second = await review(task.id, "PASS");
  expect(second.qcState).toMatchObject({ latestVerdict: "PASS", awaitingOwnerApproval: true });
  expect((await done(task.id)).status).toBe(200);
});

test("controls: a task that never entered QC is accepted by the Owner's own action; a fresh PASS after rework is accepted", async () => {
  const dir = project("controls");
  const never = await ready(dir, "never reviewed");
  await implement(never.id);
  expect((await done(never.id)).status).toBe(200);

  const reworked = await ready(dir, "reworked then passes");
  await implement(reworked.id);
  await review(reworked.id, "CHANGES_REQUESTED");
  await implement(reworked.id);
  const passed = await review(reworked.id, "PASS");
  expect(passed.qcState).toMatchObject({ latestVerdict: "PASS", awaitingOwnerApproval: true });
  expect((await done(reworked.id)).status).toBe(200);
  expect(store.tasks.get(reworked.id)!.column).toBe("done");
});

test("the existing Done tasks are not reopened and a Done task stays Done", async () => {
  const dir = project("done-stays");
  const task = await ready(dir, "done stays");
  await implement(task.id);
  await review(task.id, "PASS");
  expect((await done(task.id)).status).toBe(200);
  // The rule is evaluated when Done is requested; an already-Done task is never moved back by it.
  const { acceptAuthorizedTaskDone } = await import("./task-quality-control.ts");
  expect(acceptAuthorizedTaskDone(task.id).ok).toBe(true);
  expect(store.tasks.get(task.id)!.column).toBe("done");
});
