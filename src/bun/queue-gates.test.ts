/**
 * FO-AUTO03-GATES01. Synthetic project, fake drivers, isolated data directory.
 * No provider process and no historical Owner database.
 */
import { afterAll, beforeAll, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { makeTask } from "../cli/test-fixtures.ts";
import { FAKE_TASK_FILES_MARKER } from "../shared/task-workspace.ts";

const root = realpathSync(mkdtempSync(path.join(tmpdir(), "fo-auto03-")));
process.env.AGETOR_DATA_DIR = path.join(root, "data");
process.env.AGETOR_API_PORT = "4473";
process.env.AGETOR_CLAUDE_DRIVER = "fake";
process.env.AGETOR_CODEX_DRIVER = "fake";
process.env.AGETOR_CODEX_BIN = "/bin/echo";
process.env.AGETOR_FAKE_QC_VERDICT = "PASS";
process.env.AGETOR_USAGE_OFFLINE = "1";
process.env.AGETOR_DISABLE_UPDATES = "1";

const clampSource = `export function clampInt(value: number, min: number, max: number): number {
  if (min > max) throw new RangeError("min is greater than max");
  if (value < min) return min;
  if (value > max) return max;
  return value;
}
`;
const clampTest = `import { expect, test } from "bun:test";
import { clampInt } from "./clamp.ts";
test("keeps an in-range value", () => { expect(clampInt(5, 0, 10)).toBe(5); });
`;
const shiftSource = "export function shiftChars(text: string, amount: number): string { return text; }\n";

let server: { stop: () => void };
let token: string;
let tasks: typeof import("./db.ts").tasks;
let projects: typeof import("./db.ts").projects;
let runs: typeof import("./db.ts").runs;
let reviews: typeof import("./db.ts").taskQualityReviews;
let db: typeof import("./db.ts").db;
let recoverWorkflows: () => void;
let workflowFor: (taskId: string) => { status: string; progress: { phase: string; pauseReason?: string | null; waitReason?: string | null; failureClass?: string | null } } | null;
let recoverBatches: () => void;
let tickBatch: (id: string) => Promise<void>;
let qcSettled: (taskId: string, reviewId: string, verdict: string | null, runStatus: string, reason?: string) => Promise<void>;
let publishGlobal: typeof import("./orchestrator.ts").publishGlobalEvent;

beforeAll(async () => {
  ({ tasks, projects, runs, taskQualityReviews: reviews, db } = await import("./db.ts"));
  const serverMod = await import("./server.ts");
  const workflow = await import("./pm-orchestrated-workflow.ts");
  const batch = await import("./pm-orchestrated-batch.ts");
  const orchestrator = await import("./orchestrator.ts");
  workflow.initOrchestratedWorkflows();
  batch.initOrchestratedBatches();
  server = serverMod.startApiServer() as unknown as { stop: () => void };
  token = serverMod.API_TOKEN;
  recoverWorkflows = workflow.recoverOrchestratedWorkflows;
  workflowFor = workflow.getWorkflowForTask as typeof workflowFor;
  recoverBatches = batch.recoverOrchestratedBatches;
  tickBatch = batch.tickOrchestratedBatch;
  qcSettled = workflow.onOrchestratedQcSettled;
  publishGlobal = orchestrator.publishGlobalEvent;
  const { harnesses } = await import("./db.ts");
  harnesses.setEnabled("claude-code", true);
  harnesses.setEnabled("codex", true);
});

afterAll(() => {
  server?.stop?.();
  rmSync(root, { recursive: true, force: true });
});

const url = (p: string) => `http://127.0.0.1:4473${p}`;
const auth = () => ({ authorization: `Bearer ${token}`, "content-type": "application/json" });

async function git(cwd: string, args: string[]): Promise<void> {
  const proc = Bun.spawn(["git", "--no-optional-locks", "-C", cwd, ...args], { stdout: "pipe", stderr: "pipe" });
  if (await proc.exited !== 0) throw new Error(await new Response(proc.stderr).text());
}

async function project(name: string): Promise<string> {
  const dir = path.join(root, name);
  mkdirSync(path.join(dir, "src"), { recursive: true });
  writeFileSync(path.join(dir, "README.md"), "# synthetic\n");
  writeFileSync(path.join(dir, "src/clamp.test.ts"), clampTest);
  await git(dir, ["init", "-b", "main"]);
  await git(dir, ["add", "README.md", "src/clamp.test.ts"]);
  await git(dir, ["-c", "user.email=fo-auto03@example.com", "-c", "user.name=FO Auto03", "commit", "-m", "seed"]);
  writeFileSync(path.join(dir, "src/shift.ts"), shiftSource);
  projects.upsert(dir, name);
  return realpathSync(dir);
}

function prompt(writes: { path: string; contents: string }[]): string {
  return `Add the named file. Do not change other files.\n${FAKE_TASK_FILES_MARKER}:${JSON.stringify({ writes })}`;
}

function readyTask(dir: string, title: string, text: string, agent = "claude-code") {
  const now = Date.now();
  return tasks.insert(makeTask({
    id: randomUUID(), title, prompt: text, column: "ready", workdir: dir, agent, model: agent === "codex" ? "gpt-6.1-sol" : "opus-5.5",
    effort: "low", mode: "auto", isolation: "none", createdAt: now, updatedAt: now,
  }));
}

async function employee(dir: string, name: string): Promise<string> {
  const body = await fetch(url("/employees"), { method: "POST", headers: auth(), body: JSON.stringify({ name, jobTitle: "Eng", projectPath: dir }) }).then((r) => r.json()) as { id: string };
  return body.id;
}

async function assign(taskId: string, employeeId: string): Promise<void> {
  const res = await fetch(url("/task-assignments"), { method: "POST", headers: auth(), body: JSON.stringify({ taskId, employeeId }) });
  expect(res.ok, await res.text()).toBe(true);
}

async function api(method: string, pathname: string, body?: unknown) {
  const res = await fetch(url(pathname), { method, headers: auth(), body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await res.text();
  return { status: res.status, text, json: text ? JSON.parse(text) as Record<string, unknown> : {} };
}

async function until(label: string, pred: () => boolean | Promise<boolean>, detail?: () => unknown | Promise<unknown>): Promise<void> {
  for (let i = 0; i < 80; i++) {
    if (await pred()) return;
    await Bun.sleep(50);
  }
  const extra = detail ? JSON.stringify(await detail()) : "";
  throw new Error(`${label} ${extra}`);
}

const gatedDefaults = (employeeId: string, harness = "claude-code") => ({
  implementerEmployeeId: employeeId,
  implementerHarnessId: harness,
  implementerModel: harness === "codex" ? "gpt-6.1-sol" : "opus-5.5",
  implementerMode: "auto",
  implementerEffort: "low",
  reviewerHarness: "claude-code",
  reviewerModel: "haiku-5.5",
  reviewerMode: "auto",
  autoReviewAfterImplementation: true,
  autoReworkOnChanges: false,
  maxLaunches: 4,
  maxReworkIterations: 0,
  evidencePolicy: "observed-test" as const,
  completionGate: "owner-done" as const,
  requireTaskWorkspace: true,
});

test("two synthetic tasks wait at every owner gate and launch each phase once", async () => {
  const dir = await project("queue");
  const devA = await employee(dir, "Dev A");
  const devB = await employee(dir, "Dev B");
  const taskA = readyTask(dir, "Task A clamp", prompt([{ path: "src/clamp.ts", contents: clampSource }]));
  const taskB = readyTask(dir, "Task B other", prompt([{ path: "src/clamp.ts", contents: clampSource }]), "codex");
  await assign(taskA.id, devA);
  await assign(taskB.id, devB);
  const draft = await api("POST", "/project-manager/orchestrated-batches", { path: dir, taskIds: [taskA.id, taskB.id], title: "gated" });
  expect(draft.status).toBe(201);
  const batch = draft.json.batch as { id: string; revision: number };
  const approved = await api("POST", `/project-manager/orchestrated-batches/${batch.id}/approve`, {
    path: dir,
    revision: batch.revision,
    defaults: gatedDefaults(devA),
    perTask: { [taskB.id]: { ...gatedDefaults(devB, "codex"), implementerEmployeeId: devB } },
  });
  expect(approved.status, approved.text).toBe(200);
  const started = await api("POST", `/project-manager/orchestrated-batches/${batch.id}/start`, { path: dir });
  expect(started.status, started.text).toBe(200);
  expect(runs.listForTask(taskA.id)).toHaveLength(0);
  expect(runs.listForTask(taskB.id)).toHaveLength(0);

  const earlyReview = await api("POST", `/project-manager/orchestrated-batches/${batch.id}/phase-grants`, {
    path: dir, taskId: taskA.id, phase: "reviewer", implementationRunId: "not-a-run",
  });
  expect(earlyReview.status).toBe(409);
  expect(runs.listForTask(taskA.id)).toHaveLength(0);

  const granted = await api("POST", `/project-manager/orchestrated-batches/${batch.id}/phase-grants`, { path: dir, taskId: taskA.id, phase: "developer" });
  expect(granted.status, granted.text).toBe(200);
  await Bun.sleep(100);
  expect(runs.listForTask(taskA.id)).toHaveLength(0);

  const badPath = await api("POST", "/task-workspace/prepare", { taskId: taskA.id, outputPaths: ["../secret.ts"] });
  expect(badPath.status).toBe(400);
  expect(runs.listForTask(taskA.id)).toHaveLength(0);

  const prepared = await api("POST", "/task-workspace/prepare", { taskId: taskA.id, outputPaths: ["src/clamp.ts"] });
  expect(prepared.status, prepared.text).toBe(200);
  await until("one developer", () => runs.listForTask(taskA.id).length === 1 && tasks.get(taskA.id)?.column === "review", () => {
    const run = runs.listForTask(taskA.id)[0];
    const events = run ? db.query<{ stream: string; data: string }, [string]>("SELECT stream, data FROM run_events WHERE run_id = ? ORDER BY id DESC LIMIT 6").all(run.id) : [];
    const attempt = db.query<{ status: string; reason: string | null }, [string]>("SELECT status, reason FROM employee_executions WHERE task_id = ? ORDER BY created_at DESC LIMIT 1").get(taskA.id);
    return { runs: runs.listForTask(taskA.id).map((item) => ({ id: item.id, status: item.status, exitCode: item.exitCode })), column: tasks.get(taskA.id)?.column, attempt, events, workflow: workflowFor(taskA.id)?.progress };
  });
  expect(reviews.listForTask(taskA.id)).toHaveLength(0);
  expect(runs.listForTask(taskB.id)).toHaveLength(0);
  const impl = runs.listForTask(taskA.id)[0]!;
  expect(readFileSync(path.join(dir, "src/shift.ts"), "utf8")).toBe(shiftSource);
  expect(() => readFileSync(path.join(dir, "src/clamp.ts"))).toThrow();

  publishGlobal({ kind: "run-status", taskId: taskA.id, runId: impl.id, status: "succeeded", ts: Date.now() });
  publishGlobal({ kind: "run-status", taskId: taskA.id, runId: impl.id, status: "succeeded", ts: Date.now() });
  await Promise.all([tickBatch(batch.id), tickBatch(batch.id)]);
  recoverWorkflows();
  recoverBatches();
  await Bun.sleep(50);
  expect(runs.listForTask(taskA.id)).toHaveLength(1);
  expect(reviews.listForTask(taskA.id)).toHaveLength(0);

  const unpublished = await api("POST", "/task-workspace/publish", { taskId: taskA.id, paths: ["src/clamp.ts"] });
  expect(unpublished.status).toBe(400);
  const wrongPublish = await api("POST", "/task-workspace/publish", { taskId: taskA.id, approve: true, paths: ["src/shift.ts"] });
  expect(wrongPublish.status).toBe(409);
  expect(readFileSync(path.join(dir, "src/shift.ts"), "utf8")).toBe(shiftSource);

  const published = await api("POST", "/task-workspace/publish", { taskId: taskA.id, approve: true, paths: ["src/clamp.ts"] });
  expect(published.status, published.text).toBe(200);
  expect(readFileSync(path.join(dir, "src/clamp.ts"), "utf8")).toBe(clampSource);
  const again = await api("POST", "/task-workspace/publish", { taskId: taskA.id, approve: true, paths: ["src/clamp.ts"] });
  expect(again.status).toBe(409);
  expect(readFileSync(path.join(dir, "src/clamp.ts"), "utf8")).toBe(clampSource);

  recoverWorkflows();
  const testPrepared = await api("POST", `/tasks/${taskA.id}/qc-evidence/test-authorization`, { acknowledgeRisk: true, purpose: "first-review", validMinutes: 30 });
  expect(testPrepared.status, testPrepared.text).toBe(201);
  const authId = (testPrepared.json.authorization as { id: string } | undefined)?.id ?? (testPrepared.json as { id?: string }).id;
  expect(authId).toBeTruthy();
  const testApproved = await api("POST", `/tasks/${taskA.id}/qc-evidence/test-authorization/${authId}/approve`, {});
  expect(testApproved.status, testApproved.text).toBe(200);
  const executed = await api("POST", `/tasks/${taskA.id}/qc-evidence/test-authorization/${authId}/execute`, {});
  expect(executed.status, executed.text).toBe(200);
  const replay = await api("POST", `/tasks/${taskA.id}/qc-evidence/test-authorization/${authId}/execute`, {});
  expect(replay.status).toBe(409);
  expect(reviews.listForTask(taskA.id)).toHaveLength(0);

  recoverWorkflows();
  await until("reviewer gate", async () => {
    const view = await api("GET", `/project-manager/orchestrated-batches/${batch.id}?path=${encodeURIComponent(dir)}`);
    return (view.json.queueGate as { nextAuthorizationPhase?: string } | undefined)?.nextAuthorizationPhase === "reviewer";
  });
  const view = await api("GET", `/project-manager/orchestrated-batches/${batch.id}?path=${encodeURIComponent(dir)}`);
  expect((view.json.queueGate as { quota?: string }).quota).toBe("unknown");
  expect(runs.listForTask(taskB.id)).toHaveLength(0);

  const reviewer = await api("POST", `/project-manager/orchestrated-batches/${batch.id}/phase-grants`, {
    path: dir, taskId: taskA.id, phase: "reviewer", implementationRunId: impl.id,
  });
  expect(reviewer.status, reviewer.text).toBe(200);
  await until("qc pass", () => tasks.get(taskA.id)?.qcState?.latestVerdict === "PASS");
  expect(reviews.listForTask(taskA.id)).toHaveLength(1);
  expect(runs.listForTask(taskA.id)).toHaveLength(2);
  expect(runs.listForTask(taskB.id)).toHaveLength(0);
  const afterPass = await api("GET", `/project-manager/orchestrated-batches/${batch.id}?path=${encodeURIComponent(dir)}`);
  const rows = afterPass.json.tasks as { taskId: string; phase: string }[];
  expect(rows.find((row) => row.taskId === taskB.id)?.phase).toBe("queued");

  recoverWorkflows();
  recoverBatches();
  expect(runs.listForTask(taskB.id)).toHaveLength(0);
  const done = await api("PATCH", `/tasks/${taskA.id}`, { column: "done" });
  expect(done.status, done.text).toBe(200);
  await until("task b eligible", async () => {
    const next = await api("GET", `/project-manager/orchestrated-batches/${batch.id}?path=${encodeURIComponent(dir)}`);
    const gate = next.json.queueGate as { nextTaskId?: string; nextAuthorizationPhase?: string };
    return gate.nextTaskId === taskB.id;
  }, async () => {
    const next = await api("GET", `/project-manager/orchestrated-batches/${batch.id}?path=${encodeURIComponent(dir)}`);
    return { gate: next.json.queueGate, tasks: next.json.tasks, column: tasks.get(taskA.id)?.column, workflowA: workflowFor(taskA.id)?.status, workflowB: workflowFor(taskB.id)?.progress };
  });
  expect(runs.listForTask(taskB.id)).toHaveLength(0);
  const reused = await api("POST", `/project-manager/orchestrated-batches/${batch.id}/phase-grants`, { path: dir, taskId: taskB.id, phase: "developer", harnessId: "claude-code" });
  expect(reused.status).toBe(409);
  expect(runs.listForTask(taskB.id)).toHaveLength(0);
  const second = await api("POST", `/project-manager/orchestrated-batches/${batch.id}/phase-grants`, { path: dir, taskId: taskB.id, phase: "developer", harnessId: "codex" });
  expect(second.status, second.text).toBe(200);
  const preparedB = await api("POST", "/task-workspace/prepare", { taskId: taskB.id, outputPaths: ["src/clamp.ts"] });
  expect(preparedB.status, preparedB.text).toBe(200);
  await until("task b developer", () => runs.listForTask(taskB.id).length === 1);
  await Promise.all([tickBatch(batch.id), tickBatch(batch.id)]);
  recoverWorkflows();
  expect(runs.listForTask(taskB.id)).toHaveLength(1);
  expect(tasks.get(taskA.id)?.column).toBe("done");
}, 60_000);

async function gatedBatch(dir: string, employeeId: string, taskIds: string[]) {
  const draft = await api("POST", "/project-manager/orchestrated-batches", { path: dir, taskIds, title: "negative" });
  expect(draft.status, draft.text).toBe(201);
  const batch = draft.json.batch as { id: string; revision: number };
  const approved = await api("POST", `/project-manager/orchestrated-batches/${batch.id}/approve`, {
    path: dir, revision: batch.revision, defaults: gatedDefaults(employeeId),
  });
  expect(approved.status, approved.text).toBe(200);
  const started = await api("POST", `/project-manager/orchestrated-batches/${batch.id}/start`, { path: dir });
  expect(started.status, started.text).toBe(200);
  return batch.id;
}

test("a paused batch does not launch after a developer grant or workspace preparation", async () => {
  const dir = await project("paused");
  const dev = await employee(dir, "Paused Dev");
  const task = readyTask(dir, "Paused task", prompt([{ path: "src/clamp.ts", contents: clampSource }]));
  await assign(task.id, dev);
  const id = await gatedBatch(dir, dev, [task.id]);
  const paused = await api("POST", `/project-manager/orchestrated-batches/${id}/pause`, { path: dir });
  expect(paused.status, paused.text).toBe(200);
  const granted = await api("POST", `/project-manager/orchestrated-batches/${id}/phase-grants`, { path: dir, taskId: task.id, phase: "developer" });
  expect(granted.status, granted.text).toBe(200);
  const prepared = await api("POST", "/task-workspace/prepare", { taskId: task.id, outputPaths: ["src/clamp.ts"] });
  expect(prepared.status, prepared.text).toBe(200);
  recoverWorkflows();
  recoverBatches();
  await Bun.sleep(80);
  expect(runs.listForTask(task.id)).toHaveLength(0);
}, 20_000);

test("provider failure without a verdict is not a QC result and does not start a reviewer", async () => {
  const dir = await project("quota");
  const dev = await employee(dir, "Quota Dev");
  const task = readyTask(dir, "Quota task", prompt([{ path: "src/clamp.ts", contents: clampSource }]));
  await assign(task.id, dev);
  const id = await gatedBatch(dir, dev, [task.id]);
  const prepared = await api("POST", "/task-workspace/prepare", { taskId: task.id, outputPaths: ["src/clamp.ts"] });
  expect(prepared.status, prepared.text).toBe(200);
  const granted = await api("POST", `/project-manager/orchestrated-batches/${id}/phase-grants`, { path: dir, taskId: task.id, phase: "developer" });
  expect(granted.status, granted.text).toBe(200);
  await until("quota developer", () => tasks.get(task.id)?.column === "review");
  const before = runs.listForTask(task.id).length;
  await qcSettled(task.id, "not-a-review", null, "failed", "usage_limit_exceeded");
  expect(tasks.get(task.id)?.qcState?.latestVerdict ?? null).toBeNull();
  expect(reviews.listForTask(task.id)).toHaveLength(0);
  expect(runs.listForTask(task.id)).toHaveLength(before);
  const view = await api("GET", `/project-manager/orchestrated-batches/${id}?path=${encodeURIComponent(dir)}`);
  const gate = view.json.queueGate as { failureClass?: string; quota?: string; disposition?: string };
  expect(gate.failureClass).toBe("quota-exhausted");
  expect(gate.quota).toBe("exhausted");
  expect(gate.disposition).not.toBe("running");
}, 20_000);

test("an unauthorized workspace write and a changed published fingerprint do not start a reviewer", async () => {
  const dir = await project("fingerprint");
  const dev = await employee(dir, "Fingerprint Dev");
  const bad = readyTask(dir, "Writes outside scope", prompt([{ path: "src/shift.ts", contents: "export const changed = true;\n" }]));
  await assign(bad.id, dev);
  const badBatch = await gatedBatch(dir, dev, [bad.id]);
  expect((await api("POST", "/task-workspace/prepare", { taskId: bad.id, outputPaths: ["src/clamp.ts"] })).status).toBe(200);
  expect((await api("POST", `/project-manager/orchestrated-batches/${badBatch}/phase-grants`, { path: dir, taskId: bad.id, phase: "developer" })).status).toBe(200);
  await until("outside write settled", () => {
    const wf = workflowFor(bad.id);
    return wf?.progress.phase === "awaiting_review" || wf?.status === "paused" || (runs.listForTask(bad.id)[0]?.status === "succeeded");
  });
  await Bun.sleep(50);
  expect(reviews.listForTask(bad.id)).toHaveLength(0);
  expect(readFileSync(path.join(dir, "src/shift.ts"), "utf8")).toBe(shiftSource);

  const good = readyTask(dir, "Published then edited", prompt([{ path: "src/clamp.ts", contents: clampSource }]));
  await assign(good.id, dev);
  const goodBatch = await gatedBatch(dir, dev, [good.id]);
  expect((await api("POST", "/task-workspace/prepare", { taskId: good.id, outputPaths: ["src/clamp.ts"] })).status).toBe(200);
  expect((await api("POST", `/project-manager/orchestrated-batches/${goodBatch}/phase-grants`, { path: dir, taskId: good.id, phase: "developer" })).status).toBe(200);
  await until("fingerprint developer", () => tasks.get(good.id)?.column === "review");
  expect((await api("POST", "/task-workspace/publish", { taskId: good.id, approve: true, paths: ["src/clamp.ts"] })).status).toBe(200);
  writeFileSync(path.join(dir, "src/clamp.ts"), `${clampSource}\nexport const drifted = true;\n`);
  recoverWorkflows();
  await Bun.sleep(80);
  const reviewer = await api("POST", `/project-manager/orchestrated-batches/${goodBatch}/phase-grants`, {
    path: dir, taskId: good.id, phase: "reviewer", implementationRunId: runs.listForTask(good.id)[0]!.id,
  });
  expect(reviewer.status, reviewer.text).toBe(200);
  recoverWorkflows();
  await Bun.sleep(80);
  expect(reviews.listForTask(good.id)).toHaveLength(0);
  expect(runs.listForTask(good.id)).toHaveLength(1);
}, 30_000);

test("approve omits queue fields: server stores gated defaults and schema v1", async () => {
  const dir = await project("defaults");
  const dev = await employee(dir, "Defaults Dev");
  const task = readyTask(dir, "Defaults", prompt([{ path: "src/clamp.ts", contents: clampSource }]));
  await assign(task.id, dev);
  const draft = await api("POST", "/project-manager/orchestrated-batches", { path: dir, taskIds: [task.id], title: "def" });
  expect(draft.status).toBe(201);
  const batch = draft.json.batch as { id: string; revision: number };
  const approved = await api("POST", `/project-manager/orchestrated-batches/${batch.id}/approve`, {
    path: dir,
    revision: batch.revision,
    defaults: {
      implementerEmployeeId: dev,
      implementerHarnessId: "claude-code",
      implementerModel: "opus-5.5",
      implementerMode: "auto",
      implementerEffort: "low",
      reviewerHarness: "claude-code",
      reviewerModel: "haiku-5.5",
      reviewerMode: "auto",
      autoReviewAfterImplementation: true,
      autoReworkOnChanges: false,
      maxLaunches: 4,
      maxReworkIterations: 0,
    },
  });
  expect(approved.status, approved.text).toBe(200);
  const pol = (approved.json as { batch: { policy: Record<string, unknown> } }).batch.policy;
  expect(pol.queuePolicySchemaVersion).toBe(1);
  expect(pol.evidencePolicy).toBe("observed-test");
  expect(pol.completionGate).toBe("owner-done");
  expect(pol.requireTaskWorkspace).toBe(true);
});

test("approve partial queue fields merges only missing defaults", async () => {
  const dir = await project("partial");
  const dev = await employee(dir, "Partial Dev");
  const task = readyTask(dir, "Partial", prompt([{ path: "src/clamp.ts", contents: clampSource }]));
  await assign(task.id, dev);
  const draft = await api("POST", "/project-manager/orchestrated-batches", { path: dir, taskIds: [task.id], title: "p" });
  expect(draft.status).toBe(201);
  const batch = draft.json.batch as { id: string; revision: number };
  const approved = await api("POST", `/project-manager/orchestrated-batches/${batch.id}/approve`, {
    path: dir,
    revision: batch.revision,
    defaults: {
      implementerEmployeeId: dev,
      implementerHarnessId: "claude-code",
      implementerModel: "opus-5.5",
      implementerMode: "auto",
      implementerEffort: "low",
      reviewerHarness: "claude-code",
      reviewerModel: "haiku-5.5",
      reviewerMode: "auto",
      autoReviewAfterImplementation: true,
      autoReworkOnChanges: false,
      maxLaunches: 4,
      maxReworkIterations: 0,
      completionGate: "qc-pass",
    },
  });
  expect(approved.status, approved.text).toBe(200);
  const pol = (approved.json as { batch: { policy: Record<string, unknown> } }).batch.policy;
  expect(pol.evidencePolicy).toBe("observed-test");
  expect(pol.completionGate).toBe("qc-pass");
  expect(pol.requireTaskWorkspace).toBe(true);
});

test("approve rejects null and invalid queue policy values", async () => {
  const dir = await project("reject");
  const dev = await employee(dir, "Reject Dev");
  const task = readyTask(dir, "Reject", prompt([{ path: "src/clamp.ts", contents: clampSource }]));
  await assign(task.id, dev);
  const draft = await api("POST", "/project-manager/orchestrated-batches", { path: dir, taskIds: [task.id], title: "r" });
  const batch = draft.json.batch as { id: string; revision: number };
  const base = {
    path: dir,
    revision: batch.revision,
    defaults: {
      implementerEmployeeId: dev,
      implementerHarnessId: "claude-code",
      implementerModel: "opus-5.5",
      implementerMode: "auto",
      implementerEffort: "low",
      reviewerHarness: "claude-code",
      reviewerModel: "haiku-5.5",
      reviewerMode: "auto",
      autoReviewAfterImplementation: true,
      autoReworkOnChanges: false,
      maxLaunches: 2,
      maxReworkIterations: 0,
    },
  };
  const badPolicy = await api("POST", `/project-manager/orchestrated-batches/${batch.id}/approve`, {
    ...base,
    defaults: { ...base.defaults, evidencePolicy: "not-a-policy" as unknown as "observed-test" },
  });
  expect(badPolicy.status).toBe(400);
  const nullEv = await api("POST", `/project-manager/orchestrated-batches/${batch.id}/approve`, {
    ...base,
    defaults: { ...base.defaults, evidencePolicy: null as unknown as undefined },
  });
  expect(nullEv.status).toBe(400);
});

test("queuePolicySchema legacy-auto02 without env flag is rejected", async () => {
  const prevLegacy = process.env.AGETOR_ALLOW_LEGACY_QUEUE_POLICY_SCHEMA;
  process.env.AGETOR_ALLOW_LEGACY_QUEUE_POLICY_SCHEMA = "0";
  const dir = await project("schemaflag");
  const dev = await employee(dir, "Schema Dev");
  const task = readyTask(dir, "Schema", prompt([{ path: "src/clamp.ts", contents: clampSource }]));
  await assign(task.id, dev);
  const draft = await api("POST", "/project-manager/orchestrated-batches", { path: dir, taskIds: [task.id], title: "s" });
  const batch = draft.json.batch as { id: string; revision: number };
  const res = await api("POST", `/project-manager/orchestrated-batches/${batch.id}/approve`, {
    path: dir,
    revision: batch.revision,
    queuePolicySchema: "legacy-auto02",
    defaults: {
      implementerEmployeeId: dev,
      implementerHarnessId: "claude-code",
      implementerModel: "opus-5.5",
      reviewerHarness: "claude-code",
      reviewerModel: "haiku-5.5",
      autoReviewAfterImplementation: true,
      autoReworkOnChanges: false,
      maxLaunches: 2,
    },
  });
  expect(res.status).toBe(400);
  if (prevLegacy === undefined) delete process.env.AGETOR_ALLOW_LEGACY_QUEUE_POLICY_SCHEMA;
  else process.env.AGETOR_ALLOW_LEGACY_QUEUE_POLICY_SCHEMA = prevLegacy;
});

test("recover batch reload preserves queue policy v1", async () => {
  const dir = await project("recoverpol");
  const dev = await employee(dir, "Recover Dev");
  const task = readyTask(dir, "Recover", prompt([{ path: "src/clamp.ts", contents: clampSource }]));
  await assign(task.id, dev);
  const draft = await api("POST", "/project-manager/orchestrated-batches", { path: dir, taskIds: [task.id], title: "rcv" });
  const batch = draft.json.batch as { id: string; revision: number };
  const approved = await api("POST", `/project-manager/orchestrated-batches/${batch.id}/approve`, {
    path: dir,
    revision: batch.revision,
    defaults: {
      implementerEmployeeId: dev,
      implementerHarnessId: "claude-code",
      implementerModel: "opus-5.5",
      reviewerHarness: "claude-code",
      reviewerModel: "haiku-5.5",
      autoReviewAfterImplementation: true,
      autoReworkOnChanges: false,
      maxLaunches: 2,
    },
  });
  expect(approved.status).toBe(200);
  recoverBatches();
  const again = await api("GET", `/project-manager/orchestrated-batches/${batch.id}?path=${encodeURIComponent(dir)}`);
  expect(again.status).toBe(200);
  const pol = (again.json as { batch: { policy: Record<string, unknown> } }).batch.policy;
  expect(pol.queuePolicySchemaVersion).toBe(1);
  expect(pol.evidencePolicy).toBe("observed-test");
});

