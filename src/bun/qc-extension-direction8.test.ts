import { afterAll, beforeAll, expect, setDefaultTimeout, test } from "bun:test";
import { mkdtempSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

/**
 * Direction 8 (offline): the Owner's one additional review round after the five-round limit.
 * Fake claude driver with deterministic verdicts, isolated data directory, no provider.
 */
setDefaultTimeout(60_000);
const root = realpathSync(mkdtempSync(path.join(tmpdir(), "fo-d8x-")));
process.env.AGETOR_DATA_DIR = root;
process.env.HOME = root;
process.env.AGETOR_API_PORT = "4853";
process.env.AGETOR_USAGE_OFFLINE = "1";
process.env.AGETOR_CLAUDE_DRIVER = "fake";
process.env.AGETOR_TMUX_BIN = "/bin/echo";

let store: typeof import("./db.ts");
let orchestrator: typeof import("./orchestrator.ts");
let backend: typeof import("./server.ts");
let server: { stop: (force?: boolean) => void };
const base = "http://127.0.0.1:4853";

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
async function review(taskId: string, verdict: "PASS" | "CHANGES_REQUESTED" | "BLOCKED") {
  process.env.AGETOR_FAKE_QC_VERDICT = verdict;
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

test("the extension is refused where it does not apply, and needs the Owner's confirmed, header-only request", async () => {
  const dir = project("refusals");
  const never = await ready(dir, "Never reviewed");
  expect((await extend(never.id, 0)).status).toBe(409);

  const early = await ready(dir, "One round used");
  await implement(early.id);
  await review(early.id, "CHANGES_REQUESTED");
  const tooEarly = await extend(early.id, 1);
  expect(tooEarly.status).toBe(409);
  expect(store.tasks.get(early.id)!.qcState?.extension ?? null).toBeNull();

  const limit = await blockedAtLimit("refusals-limit");
  const noConfirm = await call("POST", `/tasks/${limit.id}/qc/extension`, { expectedRound: 5 });
  expect(noConfirm.status).toBe(400);
  const noAuth = await call("POST", `/tasks/${limit.id}/qc/extension`, { confirm: true, expectedRound: 5 }, { "content-type": "application/json" });
  expect(noAuth.status).toBe(401);
  const queryToken = await call("POST", `/tasks/${limit.id}/qc/extension?token=${backend.API_TOKEN}`, { confirm: true, expectedRound: 5 }, { "content-type": "application/json" });
  expect(queryToken.status).toBe(401);
  const stale = await extend(limit.id, 4);
  expect(stale.status).toBe(409);
  expect(stale.body.code).toBe("stale");
  expect(store.tasks.get(limit.id)!.qcState?.extension ?? null).toBeNull();
  expect(journal(limit.id, "qc.extension.authorized")).toHaveLength(0);
});

test("authorizing starts nothing, journals the Owner's decision once, keeps every prior round, and a duplicate or concurrent request mints no second extension", async () => {
  const task = await blockedAtLimit("authorize");
  const runsBefore = store.runs.countForTask(task.id);
  const reviewsBefore = reviewVerdicts(task.id);
  const before = Date.now();

  const results = await Promise.all(Array.from({ length: 6 }, () => extend(task.id)));
  expect(results.every((r) => r.status === 200)).toBe(true);
  expect(results.filter((r) => r.body.replayed === false)).toHaveLength(1);
  expect(results.filter((r) => r.body.replayed === true)).toHaveLength(5);

  const state = store.tasks.get(task.id)!.qcState!;
  expect(state).toMatchObject({ roundCount: 5, maxRounds: 6, reworkCount: 5, latestVerdict: "CHANGES_REQUESTED", activeReviewId: null });
  expect(state.extension).toMatchObject({ authorizedBy: "owner", baseRound: 5, baseVerdict: "CHANGES_REQUESTED", reviewId: null });
  expect(state.extension!.authorizedAt).toBeGreaterThanOrEqual(before);
  // Nothing started, nothing approved, the round count was not reset, the history is intact.
  expect(store.runs.countForTask(task.id)).toBe(runsBefore);
  expect(reviewVerdicts(task.id)).toEqual(reviewsBefore);
  expect(store.tasks.get(task.id)!.column).toBe("blocked");
  expect((await done(task.id)).status).toBe(409);

  // One journal row: who, which task, when.
  const rows = journal(task.id, "qc.extension.authorized");
  expect(rows).toHaveLength(1);
  expect(rows[0]).toMatchObject({ actor_type: "owner", actor_id: "owner", task_id: task.id });
  expect(rows[0]!.created_at).toBeGreaterThanOrEqual(before);
  expect(JSON.parse(rows[0]!.payload_json)).toMatchObject({ taskId: task.id, baseRound: 5, maxRounds: 6, previousVerdict: "CHANGES_REQUESTED" });

  // A later replay is still a replay: the same extension, not a second one.
  const again = await extend(task.id);
  expect(again.body.replayed).toBe(true);
  expect(again.body.state.extension.authorizedAt).toBe(state.extension!.authorizedAt);
  expect(journal(task.id, "qc.extension.authorized")).toHaveLength(1);
});

test("the extension is not transferable: it belongs to one task only", async () => {
  const a = await blockedAtLimit("only-a");
  const b = await blockedAtLimit("only-b");
  expect((await extend(a.id)).status).toBe(200);
  expect(store.tasks.get(b.id)!.qcState?.extension ?? null).toBeNull();
  expect(store.tasks.get(b.id)!.qcState?.maxRounds).toBe(5);
  await implement(b.id);
  const refused = await call("POST", `/tasks/${b.id}/qc/reviews`, { reviewerHarness: "claude-code", reviewerModel: "opus-5.5" });
  expect(refused.status).toBe(409);
  expect(refused.body.code).toBe("max-rounds");
});

test("the additional round reviews NEW output only; a review of the old output is refused, then a fresh PASS waits for the separate Owner acceptance", async () => {
  const task = await blockedAtLimit("flow");
  const oldRun = store.tasks.get(task.id)!.runId!;
  expect((await extend(task.id)).status).toBe(200);

  // Blocked is not Review: no review can be prepared yet.
  const early = await call("POST", `/tasks/${task.id}/qc/reviews`, { reviewerHarness: "claude-code", reviewerModel: "opus-5.5" });
  expect(early.status).toBe(409);
  // Even with the card moved to Review by hand, the old output is refused (it was reviewed in round 5).
  expect((await call("PATCH", `/tasks/${task.id}`, { column: "review" })).status).toBe(200);
  const old = await call("POST", `/tasks/${task.id}/qc/reviews`, { reviewerHarness: "claude-code", reviewerModel: "opus-5.5" });
  expect(old.status).toBe(409);
  expect(old.body.code).toBe("no-implementation");   // the latest run is the round-5 review, not new implementation output
  // Naming the old implementation run directly (the recovery path can) is refused by the extension's own binding.
  const { prepareQcReview, QcError } = await import("./task-quality-control.ts");
  const reviewedBefore = store.taskQualityReviews.listForTask(task.id)[4]!.implementationRunId!;
  expect(reviewedBefore).toBeTruthy();
  let caught: unknown;
  try { prepareQcReview({ taskId: task.id, reviewerHarness: "claude-code", reviewerModel: "opus-5.5" }, { implementationRunId: reviewedBefore }); } catch (error) { caught = error; }
  expect(caught).toBeInstanceOf(QcError);
  expect((caught as InstanceType<typeof QcError>).code).toBe("extension-needs-new-output");
  expect(store.tasks.get(task.id)!.qcState?.extension?.reviewId ?? null).toBeNull();
  expect(store.taskQualityReviews.listForTask(task.id)).toHaveLength(5);

  // A new implementation attempt, then the additional review. A PASS waits for the Owner; Done is a separate act.
  await implement(task.id);
  expect(store.tasks.get(task.id)!.runId).not.toBe(oldRun);
  const passed = await review(task.id, "PASS");
  expect(passed.column).toBe("review");
  expect(passed.qcState).toMatchObject({ roundCount: 6, maxRounds: 6, reworkCount: 5, latestVerdict: "PASS", awaitingOwnerApproval: true });
  expect(passed.qcState!.extension).toMatchObject({ outcome: "PASS" });
  expect(passed.qcState!.extension!.reviewId).toBe(store.taskQualityReviews.listForTask(task.id)[5]!.id);
  expect(reviewVerdicts(task.id).slice(0, 5).every(([, , verdict]) => verdict === "CHANGES_REQUESTED")).toBe(true);
  expect(store.taskQualityReviews.listForTask(task.id)[5]).toMatchObject({ round: 6, verdict: "PASS" });
  const used = journal(task.id, "qc.extension.used");
  expect(used).toHaveLength(1);
  expect(JSON.parse(used[0]!.payload_json)).toMatchObject({ taskId: task.id, round: 6 });
  expect(journal(task.id, "qc.extension.authorized")).toHaveLength(1);

  // The covering evidence says which attempt each round reviewed.
  const bundle = (await call("GET", `/tasks/${task.id}/qc`)).body;
  expect(bundle.reviews.map((r: any) => [r.round, r.coversLatestOutput])).toEqual([[1, false], [2, false], [3, false], [4, false], [5, false], [6, true]]);

  // PASS is not acceptance. The earlier PASS cannot cover newer output.
  expect(store.tasks.get(task.id)!.column).not.toBe("done");
  const followUp = await call("POST", `/runs/${store.tasks.get(task.id)!.runId}/input`, { line: "Change the output once more." });
  expect(followUp.status).toBe(200);
  await waitFor(() => store.runs.countForTask(task.id), (n) => n >= 13, "a new run exists");
  await waitFor(() => store.tasks.get(task.id)!.column, (c) => c === "review", "changed output reaches Review");
  const after = store.tasks.get(task.id)!.qcState!;
  expect({ awaiting: after.awaitingOwnerApproval, verdict: after.latestVerdict }).toEqual({ awaiting: false, verdict: null });
  expect(after.extension).toMatchObject({ outcome: "PASS" });
  // No further review (the extra round is spent), so the PASS for the old output is not a way to accept the new one.
  const sixth = await call("POST", `/tasks/${task.id}/qc/reviews`, { reviewerHarness: "claude-code", reviewerModel: "opus-5.5" });
  expect(sixth.status).toBe(409);
  expect((await extend(task.id, 6)).status).toBe(409);
  expect((await extend(task.id, 6)).body.code).toBe("extension-used");
});

test("an additional round that ends without a PASS leaves the task Blocked: no further extension, no further review, no Done", async () => {
  const task = await blockedAtLimit("fail-extra");
  expect((await extend(task.id)).status).toBe(200);
  await implement(task.id);
  const failed = await review(task.id, "CHANGES_REQUESTED");
  expect(failed.column).toBe("blocked");
  expect(failed.qcState).toMatchObject({ roundCount: 6, maxRounds: 6, latestVerdict: "CHANGES_REQUESTED" });
  expect(failed.qcState!.extension).toMatchObject({ outcome: "CHANGES_REQUESTED" });

  const runsBefore = store.runs.countForTask(task.id);
  const again = await extend(task.id, 6);
  expect(again.status).toBe(409);
  expect(again.body.code).toBe("extension-used");
  await implement(task.id);
  const seventh = await call("POST", `/tasks/${task.id}/qc/reviews`, { reviewerHarness: "claude-code", reviewerModel: "opus-5.5" });
  expect(seventh.status).toBe(409);
  const refused = await done(task.id);
  expect(refused.status).toBe(409);
  expect(refused.body.error).toContain("without a PASS");
  expect(store.tasks.get(task.id)!.column).not.toBe("done");
  expect(store.runs.countForTask(task.id)).toBe(runsBefore + 1);
  expect(journal(task.id, "qc.extension.authorized")).toHaveLength(1);
  expect(journal(task.id, "qc.extension.used")).toHaveLength(1);
  expect(store.taskQualityReviews.listForTask(task.id)).toHaveLength(6);
});

test("a cancelled additional review spends the extension: Blocked again, rounds shown as used, no second extension and no second review", async () => {
  const task = await blockedAtLimit("cancel-extra");
  expect((await extend(task.id)).status).toBe(200);
  await implement(task.id);
  const prepared = await call("POST", `/tasks/${task.id}/qc/reviews`, { reviewerHarness: "claude-code", reviewerModel: "opus-5.5" });
  expect(prepared.status).toBe(200);
  expect(prepared.body.review.round).toBe(6);
  expect(store.tasks.get(task.id)!.qcState!.extension!.reviewId).toBe(prepared.body.review.id);
  // A concurrent second prepare cannot mint another review while one is active.
  const second = await call("POST", `/tasks/${task.id}/qc/reviews`, { reviewerHarness: "claude-code", reviewerModel: "opus-5.5" });
  expect(second.status).toBe(409);
  expect((await call("DELETE", `/tasks/${task.id}/qc/reviews/${prepared.body.review.id}`)).status).toBe(200);
  const state = store.tasks.get(task.id)!.qcState!;
  expect(state).toMatchObject({ activeReviewId: null, roundCount: 6, maxRounds: 6 });
  expect(state.extension).toMatchObject({ outcome: "none" });
  expect(store.tasks.get(task.id)!.column).toBe("blocked");
  expect((await extend(task.id, 6)).status).toBe(409);
  expect((await done(task.id)).status).toBe(409);
  expect(store.taskQualityReviews.listForTask(task.id).filter((r) => r.status !== "cancelled")).toHaveLength(5);
});

test("restart: the extension, its use and the journal persist; a replay after restart mints nothing", async () => {
  const task = await blockedAtLimit("restart");
  expect((await extend(task.id)).status).toBe(200);
  // "Restart": stop the API, read the raw persisted record, start it again.
  server.stop(true);
  const raw = store.db.query<{ qc_state: string }, [string]>(`SELECT qc_state FROM tasks WHERE id = ?`).get(task.id)!;
  expect(JSON.parse(raw.qc_state).extension).toMatchObject({ authorizedBy: "owner", baseRound: 5, reviewId: null });
  server = backend.startApiServer() as unknown as typeof server;
  const replay = await extend(task.id);
  expect(replay.body.replayed).toBe(true);
  expect(journal(task.id, "qc.extension.authorized")).toHaveLength(1);
  await implement(task.id);
  await review(task.id, "BLOCKED");
  server.stop(true);
  server = backend.startApiServer() as unknown as typeof server;
  const spent = await extend(task.id, 6);
  expect(spent.status).toBe(409);
  expect(spent.body.code).toBe("extension-used");
  expect(store.tasks.get(task.id)!.column).toBe("blocked");
  expect((await done(task.id)).status).toBe(409);
  expect(journal(task.id, "qc.extension.authorized")).toHaveLength(1);
});

test("a task that never entered QC behaves as before: Done is the Owner's own action, and no extension exists", async () => {
  const dir = project("unchanged");
  const task = await ready(dir, "Unchanged");
  await implement(task.id);
  expect(store.tasks.get(task.id)!.qcState?.extension ?? null).toBeNull();
  expect((await extend(task.id, 0)).status).toBe(409);
  expect((await done(task.id)).status).toBe(200);
});
