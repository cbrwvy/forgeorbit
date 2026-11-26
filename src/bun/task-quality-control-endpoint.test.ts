import { test, expect, beforeAll, afterAll } from "bun:test";
import { randomUUID } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { makeTask } from "../cli/test-fixtures.ts";
import path from "node:path";
import { FAKE_QC_REVIEW_PROMPT_MARKER } from "../shared/task-quality-control.ts";

const DATA_DIR = mkdtempSync(path.join(tmpdir(), "fo-qc-"));
process.env.AGETOR_DATA_DIR = DATA_DIR;
process.env.AGETOR_API_PORT = "4403";
process.env.AGETOR_CLAUDE_DRIVER = "fake";

let server: { stop: () => void };
let token: string;
let tasks: typeof import("./db.ts").tasks;
let projects: typeof import("./db.ts").projects;

beforeAll(async () => {
  ({ tasks, projects } = await import("./db.ts"));
  const { startApiServer, API_TOKEN } = await import("./server.ts");
  server = startApiServer() as unknown as { stop: () => void };
  token = API_TOKEN;
});

afterAll(() => {
  server?.stop?.();
});

const url = (p: string) => `http://127.0.0.1:4403${p}`;
const auth = () => ({ authorization: `Bearer ${token}` });

test("QC review PASS then owner mark done", async () => {
  const workdir = mkdtempSync(path.join(tmpdir(), "fo-qc-proj-"));
  projects.upsert(workdir, "QC");
  const now = Date.now();
  const task = tasks.insert(makeTask({
    id: randomUUID(),
    title: "QC task",
    prompt: "Implement feature hello",
    column: "ready",
    workdir,
    model: "opus-5.5",
    effort: "high",
    mode: "auto",
    createdAt: now,
    updatedAt: now,
  }));

  const { startTask } = await import("./orchestrator.ts");
  const impl = await startTask(task.id);
  if ("error" in impl) throw new Error(impl.error);
  expect("runId" in impl).toBe(true);
  const deadline = Date.now() + 8000;
  while (Date.now() < deadline && tasks.get(task.id)?.column !== "review") {
    await new Promise((r) => setTimeout(r, 50));
  }
  expect(tasks.get(task.id)?.column).toBe("review");

  const prep = await fetch(url(`/tasks/${task.id}/qc/reviews`), {
    method: "POST",
    headers: { ...auth(), "content-type": "application/json" },
    body: JSON.stringify({ reviewerHarness: "claude-code", reviewerModel: "opus-5.5" }),
  });
  expect(prep.status).toBe(200);
  const { review } = (await prep.json()) as { review: { id: string } };

  const start = await fetch(url(`/tasks/${task.id}/qc/reviews/${review.id}/start`), {
    method: "POST",
    headers: auth(),
  });
  expect(start.status).toBe(200);

  while (Date.now() < deadline && tasks.get(task.id)?.qcState?.latestVerdict !== "PASS") {
    await new Promise((r) => setTimeout(r, 50));
  }
  expect(tasks.get(task.id)?.qcState?.latestVerdict).toBe("PASS");
  expect(tasks.get(task.id)?.qcState?.awaitingOwnerApproval).toBe(true);

  const done = await fetch(url(`/tasks/${task.id}`), {
    method: "PATCH",
    headers: { ...auth(), "content-type": "application/json" },
    body: JSON.stringify({ column: "done" }),
  });
  expect(done.status).toBe(200);
  expect((await done.json()).qcState.awaitingOwnerApproval).toBe(false);
  expect(tasks.get(task.id)?.column).toBe("done");
  expect(tasks.get(task.id)?.qcState?.awaitingOwnerApproval).toBe(false);
  const again = await fetch(url(`/tasks/${task.id}`), {
    method: "PATCH",
    headers: { ...auth(), "content-type": "application/json" },
    body: JSON.stringify({ column: "done" }),
  });
  expect(again.status).toBe(200);
  const qc = await fetch(url(`/tasks/${task.id}/qc`), { headers: auth() });
  expect((await qc.json()).reviews).toHaveLength(1);
});

async function insertReadyTask(workdir: string, title: string) {
  const now = Date.now();
  return tasks.insert(makeTask({
    id: randomUUID(),
    title,
    prompt: "Implement feature hello",
    column: "ready",
    workdir,
    model: "opus-5.5",
    effort: "high",
    mode: "auto",
    createdAt: now,
    updatedAt: now,
  }));
}

test("QC CHANGES_REQUESTED moves task to ready; mark done blocked until re-review", async () => {
  process.env.AGETOR_FAKE_QC_VERDICT = "CHANGES_REQUESTED";
  const workdir = mkdtempSync(path.join(tmpdir(), "fo-qc-cr-"));
  projects.upsert(workdir, "QC-CR");
  const task = await insertReadyTask(workdir, "QC rework");
  const { startTask } = await import("./orchestrator.ts");
  const impl = await startTask(task.id);
  if ("error" in impl) throw new Error(impl.error);
  const deadline = Date.now() + 8000;
  while (Date.now() < deadline && tasks.get(task.id)?.column !== "review") {
    await new Promise((r) => setTimeout(r, 50));
  }
  const prep = await fetch(url(`/tasks/${task.id}/qc/reviews`), {
    method: "POST",
    headers: { ...auth(), "content-type": "application/json" },
    body: JSON.stringify({ reviewerHarness: "claude-code", reviewerModel: "opus-5.5" }),
  });
  const { review } = (await prep.json()) as { review: { id: string } };
  await fetch(url(`/tasks/${task.id}/qc/reviews/${review.id}/start`), { method: "POST", headers: auth() });
  while (Date.now() < deadline && tasks.get(task.id)?.column !== "ready") {
    await new Promise((r) => setTimeout(r, 50));
  }
  expect(tasks.get(task.id)?.qcState?.latestVerdict).toBe("CHANGES_REQUESTED");
  tasks.update(task.id, { column: "review" });
  const blocked = await fetch(url(`/tasks/${task.id}`), {
    method: "PATCH",
    headers: { ...auth(), "content-type": "application/json" },
    body: JSON.stringify({ column: "done" }),
  });
  expect(blocked.status).toBe(409);
  delete process.env.AGETOR_FAKE_QC_VERDICT;
});

test("QC history survives server stop and restart", async () => {
  const workdir = mkdtempSync(path.join(tmpdir(), "fo-qc-persist-"));
  projects.upsert(workdir, "QC-persist");
  const task = await insertReadyTask(workdir, "QC persist");
  const { startTask } = await import("./orchestrator.ts");
  await startTask(task.id);
  const deadline = Date.now() + 8000;
  while (Date.now() < deadline && tasks.get(task.id)?.column !== "review") {
    await new Promise((r) => setTimeout(r, 50));
  }
  const prep = await fetch(url(`/tasks/${task.id}/qc/reviews`), {
    method: "POST",
    headers: { ...auth(), "content-type": "application/json" },
    body: JSON.stringify({ reviewerHarness: "claude-code", reviewerModel: "opus-5.5" }),
  });
  const { review } = (await prep.json()) as { review: { id: string } };
  await fetch(url(`/tasks/${task.id}/qc/reviews/${review.id}/start`), { method: "POST", headers: auth() });
  while (Date.now() < deadline && tasks.get(task.id)?.qcState?.latestVerdict !== "PASS") {
    await new Promise((r) => setTimeout(r, 50));
  }
  server.stop();
  const { startApiServer, API_TOKEN: token2 } = await import("./server.ts");
  server = startApiServer() as unknown as { stop: () => void };
  token = token2;
  const bundle = await fetch(url(`/tasks/${task.id}/qc`), { headers: auth() });
  expect(bundle.status).toBe(200);
  const body = (await bundle.json()) as { reviews: unknown[] };
  expect(body.reviews.length).toBeGreaterThan(0);
});

test("Return for changes clears only the pending acceptance and starts nothing", async () => {
  delete process.env.AGETOR_FAKE_QC_VERDICT;
  const workdir = mkdtempSync(path.join(tmpdir(), "fo-qc-return-"));
  projects.upsert(workdir, "QC-return");
  const task = await insertReadyTask(workdir, "QC return");
  const { startTask } = await import("./orchestrator.ts");
  const impl = await startTask(task.id);
  if ("error" in impl) throw new Error(impl.error);
  const deadline = Date.now() + 8000;
  while (Date.now() < deadline && tasks.get(task.id)?.column !== "review") {
    await new Promise((r) => setTimeout(r, 50));
  }
  const prep = await fetch(url(`/tasks/${task.id}/qc/reviews`), {
    method: "POST",
    headers: { ...auth(), "content-type": "application/json" },
    body: JSON.stringify({ reviewerHarness: "claude-code", reviewerModel: "opus-5.5" }),
  });
  const { review } = (await prep.json()) as { review: { id: string } };
  await fetch(url(`/tasks/${task.id}/qc/reviews/${review.id}/start`), { method: "POST", headers: auth() });
  while (Date.now() < deadline && !(tasks.get(task.id)?.column === "review" && tasks.get(task.id)?.qcState?.awaitingOwnerApproval)) {
    await new Promise((r) => setTimeout(r, 50));
  }
  const pending = tasks.get(task.id)!.qcState!;
  expect(pending.latestVerdict).toBe("PASS");
  expect(pending.awaitingOwnerApproval).toBe(true);
  const runsBefore = (await (await fetch(url(`/tasks/${task.id}/runs`), { headers: auth() })).json()) as { id: string }[];
  const reviewsBefore = ((await (await fetch(url(`/tasks/${task.id}/qc`), { headers: auth() })).json()) as { reviews: { id: string; verdict: string | null }[] }).reviews;

  const returned = await fetch(url(`/tasks/${task.id}`), {
    method: "PATCH",
    headers: { ...auth(), "content-type": "application/json" },
    body: JSON.stringify({ column: "ready" }),
  });
  expect(returned.status).toBe(200);
  expect(((await returned.json()) as { qcState: { awaitingOwnerApproval: boolean } }).qcState.awaitingOwnerApproval).toBe(false);

  // Persisted: re-read the row from the store, not the response.
  const stored = tasks.get(task.id)!;
  expect(stored.column).toBe("ready");
  expect(stored.qcState).toEqual({ ...pending, awaitingOwnerApproval: false });
  const runsAfter = (await (await fetch(url(`/tasks/${task.id}/runs`), { headers: auth() })).json()) as { id: string }[];
  expect(runsAfter.map((r) => r.id)).toEqual(runsBefore.map((r) => r.id));
  expect(stored.runId).toBe(runsBefore[0]?.id ?? stored.runId);
  const reviewsAfter = ((await (await fetch(url(`/tasks/${task.id}/qc`), { headers: auth() })).json()) as { reviews: { id: string; verdict: string | null }[] }).reviews;
  expect(reviewsAfter).toEqual(reviewsBefore);
  expect(reviewsAfter.some((r) => r.verdict === "PASS")).toBe(true);

  // A move that is not out of Review leaves a still-pending acceptance alone.
  tasks.update(task.id, { column: "review" });
  tasks.setQcState(task.id, pending);
  const stay = await fetch(url(`/tasks/${task.id}`), {
    method: "PATCH",
    headers: { ...auth(), "content-type": "application/json" },
    body: JSON.stringify({ title: "QC return (renamed)" }),
  });
  expect(stay.status).toBe(200);
  expect(tasks.get(task.id)?.qcState?.awaitingOwnerApproval).toBe(true);
});
