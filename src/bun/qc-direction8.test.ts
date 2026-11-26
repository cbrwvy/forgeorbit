import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtempSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

/**
 * Direction 8 (offline): the Reviewer cannot be bypassed, and the rework loop ends.
 * Fake claude driver with deterministic verdicts, isolated data directory, no provider.
 */
const root = realpathSync(mkdtempSync(path.join(tmpdir(), "fo-d8-")));
process.env.AGETOR_DATA_DIR = root;
process.env.HOME = root;
process.env.AGETOR_API_PORT = "4851";
process.env.AGETOR_USAGE_OFFLINE = "1";
process.env.AGETOR_CLAUDE_DRIVER = "fake";
process.env.AGETOR_TMUX_BIN = "/bin/echo";

let store: typeof import("./db.ts");
let orchestrator: typeof import("./orchestrator.ts");
let backend: typeof import("./server.ts");
let server: { stop: (force?: boolean) => void };
const base = "http://127.0.0.1:4851";

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
  expect(prepared.status).toBe(200);
  const started = await call("POST", `/tasks/${taskId}/qc/reviews/${prepared.body.review.id}/start`);
  expect(started.status).toBe(200);
  await waitFor(() => store.tasks.get(taskId)!.qcState?.roundCount, (n) => n === round && !store.tasks.get(taskId)!.qcState?.activeReviewId, `round ${round} settles`);
  await waitFor(() => store.tasks.get(taskId)!.column, (c) => c !== "running", "task settles");
  delete process.env.AGETOR_FAKE_QC_VERDICT;
  return store.tasks.get(taskId)!;
}
const done = (taskId: string) => call("PATCH", `/tasks/${taskId}`, { column: "done" });

test("Done is refused while a review is running or after CHANGES_REQUESTED or BLOCKED, however many times the Owner tries; only a PASS (or no review at all) lets the Owner accept", async () => {
  const dir = project("gate");
  const task = await ready(dir, "Gated");
  await implement(task.id);

  // A review that was prepared but has not finished: Done is refused, the review is not skipped.
  const prepared = await call("POST", `/tasks/${task.id}/qc/reviews`, { reviewerHarness: "claude-code", reviewerModel: "opus-5.5" });
  expect(prepared.status).toBe(200);
  const active = await done(task.id);
  expect(active.status).toBe(409);
  expect(active.body.error).toContain("in progress");
  expect(store.tasks.get(task.id)!.column).toBe("review");
  const cancelled = await call("DELETE", `/tasks/${task.id}/qc/reviews/${prepared.body.review.id}`);
  expect(cancelled.status).toBe(200);
  expect(store.tasks.get(task.id)!.qcState?.activeReviewId ?? null).toBeNull();

  // CHANGES_REQUESTED: refused, also after a rework run that has not been reviewed again.
  let current = await review(task.id, "CHANGES_REQUESTED");
  expect(current.column).toBe("ready");
  expect((await done(task.id)).status).toBe(409);
  await implement(task.id);
  const afterRework = await done(task.id);
  expect(afterRework.status).toBe(409);
  expect(afterRework.body.error).toContain("Address the requested changes");
  expect(store.tasks.get(task.id)!.column).toBe("review");

  // BLOCKED: refused from Review.
  current = await review(task.id, "BLOCKED");
  expect(current.qcState).toMatchObject({ latestVerdict: "BLOCKED" });
  const blocked = await done(task.id);
  expect(blocked.status).toBe(409);
  expect(store.tasks.get(task.id)!.column).not.toBe("done");

  // Each refusal left the rounds and verdicts untouched.
  expect(store.taskQualityReviews.listForTask(task.id).filter((r) => r.status === "complete").map((r) => r.verdict)).toEqual(["CHANGES_REQUESTED", "BLOCKED"]);
});

test("a task that was never reviewed can be accepted by the Owner's own action; this is recorded, not an override of a verdict", async () => {
  const dir = project("noreview");
  const task = await ready(dir, "Never reviewed");
  await implement(task.id);
  expect(store.tasks.get(task.id)!.qcState?.roundCount ?? 0).toBe(0);
  expect(store.tasks.get(task.id)!.qcState?.latestVerdict ?? null).toBeNull();
  expect((await done(task.id)).status).toBe(200);
  expect(store.tasks.get(task.id)!.column).toBe("done");
  expect(store.taskQualityReviews.listForTask(task.id)).toHaveLength(0);
});

test("the rework loop ends at the round limit: round 5 CHANGES_REQUESTED blocks the task for the Owner, a sixth review is refused and no run is created", async () => {
  const dir = project("limit");
  const task = await ready(dir, "Limit");
  const max = store.tasks.get(task.id)!.qcState?.maxRounds ?? 5;
  expect(max).toBe(5);
  for (let round = 1; round < max; round++) {
    await implement(task.id);
    const current = await review(task.id, "CHANGES_REQUESTED");
    expect(current.column).toBe("ready");
    expect(current.qcState).toMatchObject({ roundCount: round, reworkCount: round, latestVerdict: "CHANGES_REQUESTED" });
  }
  // The last round that may run.
  await implement(task.id);
  const last = await review(task.id, "CHANGES_REQUESTED");
  expect(last.column).toBe("blocked");
  expect(last.qcState).toMatchObject({ roundCount: max, reworkCount: max, latestVerdict: "CHANGES_REQUESTED", activeReviewId: null });

  // Nothing loops: no further review can be prepared, and nothing was created by trying.
  const runsBefore = store.runs.countForTask(task.id);
  const reviewsBefore = store.taskQualityReviews.listForTask(task.id).length;
  const sixth = await call("POST", `/tasks/${task.id}/qc/reviews`, { reviewerHarness: "claude-code", reviewerModel: "opus-5.5" });
  expect(sixth.status).toBe(409);
  expect(sixth.body.code ?? sixth.body.error).toBeTruthy();
  expect(store.runs.countForTask(task.id)).toBe(runsBefore);
  expect(store.taskQualityReviews.listForTask(task.id)).toHaveLength(reviewsBefore);

  // The Owner is told why Done is not available; the verdict history is complete and in order.
  const refused = await done(task.id);
  expect(refused.status).toBe(409);
  expect(refused.body.error).toContain("review rounds are used");
  expect(store.tasks.get(task.id)!.column).toBe("blocked");
  expect(store.taskQualityReviews.listForTask(task.id).map((r) => [r.round, r.verdict])).toEqual(
    [[1, "CHANGES_REQUESTED"], [2, "CHANGES_REQUESTED"], [3, "CHANGES_REQUESTED"], [4, "CHANGES_REQUESTED"], [5, "CHANGES_REQUESTED"]],
  );
  // The panel's own read says the same thing the Done gate says.
  const bundle = (await call("GET", `/tasks/${task.id}/qc`)).body;
  expect(bundle.state).toMatchObject({ roundCount: 5, maxRounds: 5, latestVerdict: "CHANGES_REQUESTED" });
});

test("a PASS in the last round still waits for the Owner and is accepted normally", async () => {
  const dir = project("last-pass");
  const task = await ready(dir, "Last round passes");
  for (let round = 1; round < 5; round++) {
    await implement(task.id);
    await review(task.id, "CHANGES_REQUESTED");
  }
  await implement(task.id);
  const passed = await review(task.id, "PASS");
  expect(passed.column).toBe("review");
  expect(passed.qcState).toMatchObject({ roundCount: 5, latestVerdict: "PASS", awaitingOwnerApproval: true });
  expect((await done(task.id)).status).toBe(200);
});
