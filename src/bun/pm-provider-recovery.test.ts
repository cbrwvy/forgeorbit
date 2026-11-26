/**
 * FO-AUTO03-RECOVERY-FIX01. Fake drivers only; isolated database.
 */
import { afterAll, beforeAll, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { makeTask } from "../cli/test-fixtures.ts";
import { FAKE_TASK_FILES_MARKER } from "../shared/task-workspace.ts";

const root = realpathSync(mkdtempSync(path.join(tmpdir(), "fo-recovery-fix01-")));
process.env.AGETOR_DATA_DIR = path.join(root, "data");
process.env.AGETOR_API_PORT = "4494";
process.env.AGETOR_CLAUDE_DRIVER = "fake";
process.env.AGETOR_FAKE_QC_VERDICT = "MODEL_NOT_FOUND";
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

let server: { stop: () => void };
let token: string;
let tasks: typeof import("./db.ts").tasks;
let projects: typeof import("./db.ts").projects;
let runs: typeof import("./db.ts").runs;
let reviews: typeof import("./db.ts").taskQualityReviews;
let db: typeof import("./db.ts").db;
let recoverWorkflows: () => void;
let recoverBatches: () => void;
let workflowFor: (taskId: string) => {
  id: string;
  status: string;
  counters: { launchesUsed: number };
  grant: { maxLaunches: number; orchestratedBatchId?: string };
} | null;

beforeAll(async () => {
  ({ tasks, projects, runs, taskQualityReviews: reviews, db } = await import("./db.ts"));
  const serverMod = await import("./server.ts");
  const workflow = await import("./pm-orchestrated-workflow.ts");
  const batch = await import("./pm-orchestrated-batch.ts");
  workflow.initOrchestratedWorkflows();
  batch.initOrchestratedBatches();
  server = serverMod.startApiServer() as unknown as { stop: () => void };
  token = serverMod.API_TOKEN;
  recoverWorkflows = workflow.recoverOrchestratedWorkflows;
  recoverBatches = batch.recoverOrchestratedBatches;
  workflowFor = workflow.getWorkflowForTask as typeof workflowFor;
  const { recoverProviderRecoveries } = await import("./pm-provider-recovery.ts");
  recoverProviderRecoveries();
});

afterAll(() => {
  server?.stop?.();
  rmSync(root, { recursive: true, force: true });
});

const url = (p: string) => `http://127.0.0.1:4494${p}`;
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
  await git(dir, ["-c", "user.email=fix01@example.com", "-c", "user.name=FO Fix01", "commit", "-m", "seed"]);
  projects.upsert(dir, name);
  return realpathSync(dir);
}

function prompt(writes: { path: string; contents: string }[]): string {
  return `Add the named file.\n${FAKE_TASK_FILES_MARKER}:${JSON.stringify({ writes })}`;
}

function readyTask(dir: string, title: string) {
  const now = Date.now();
  return tasks.insert(makeTask({
    id: randomUUID(), title, prompt: prompt([{ path: "src/clamp.ts", contents: clampSource }]),
    column: "ready", workdir: dir, agent: "claude-code", model: "opus-5.5", effort: "low", mode: "auto",
    isolation: "none", createdAt: now, updatedAt: now,
  }));
}

async function employee(dir: string): Promise<string> {
  const body = await fetch(url("/employees"), { method: "POST", headers: auth(), body: JSON.stringify({ name: "Dev", jobTitle: "Eng", projectPath: dir }) }).then((r) => r.json()) as { id: string };
  return body.id;
}

async function assign(taskId: string, employeeId: string): Promise<void> {
  await fetch(url("/task-assignments"), { method: "POST", headers: auth(), body: JSON.stringify({ taskId, employeeId }) });
}

async function api(method: string, pathname: string, body?: unknown) {
  const res = await fetch(url(pathname), { method, headers: auth(), body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await res.text();
  return { status: res.status, text, json: text ? JSON.parse(text) as Record<string, unknown> : {} };
}

async function until(pred: () => boolean | Promise<boolean>): Promise<void> {
  for (let i = 0; i < 160; i++) {
    if (await pred()) return;
    await Bun.sleep(50);
  }
  throw new Error("timeout");
}

const gatedApprove = (employeeId: string) => ({
  implementerEmployeeId: employeeId,
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
  evidencePolicy: "observed-test" as const,
  completionGate: "owner-done" as const,
  requireTaskWorkspace: true,
});

const LEGACY_USAGE_LIMIT = "You\u2019ve hit your usage limit. Upgrade to Pro (https://chatgpt.com/explore/pro), visit https://chatgpt.com/settings/usage to purchase more credits or try again at 3:50 PM.";
const CODEX_AGENT = "codex-profile-22222222-2222-4222-8222-222222222222";
const CODEX_SESSION = "11111111-1111-4111-8111-111111111111";

async function pausedQuotaScene(opts: {
  name: string;
  stderr: { data: string; lineUuid?: string | null }[];
  runAgent?: string;
  codexSessionId?: string | null;
  promptExtra?: string;
}): Promise<{ dir: string; task: ReturnType<typeof readyTask>; batchId: string; implId: string; reviewRunId: string; reviewId: string }> {
  const dir = await project(opts.name);
  const dev = await employee(dir);
  const task = readyTask(dir, opts.name);
  if (opts.promptExtra) tasks.update(task.id, { prompt: `${task.prompt}\n${opts.promptExtra}` });
  await assign(task.id, dev);
  const draft = await api("POST", "/project-manager/orchestrated-batches", { path: dir, taskIds: [task.id] });
  expect(draft.status).toBe(201);
  const batch = draft.json.batch as { id: string; revision: number };
  expect((await api("POST", `/project-manager/orchestrated-batches/${batch.id}/approve`, { path: dir, revision: batch.revision, defaults: gatedApprove(dev) })).status).toBe(200);
  expect((await api("POST", `/project-manager/orchestrated-batches/${batch.id}/start`, { path: dir })).status).toBe(200);
  expect((await api("POST", "/task-workspace/prepare", { taskId: task.id, outputPaths: ["src/clamp.ts"] })).status).toBe(200);
  expect((await api("POST", `/project-manager/orchestrated-batches/${batch.id}/phase-grants`, { path: dir, taskId: task.id, phase: "developer" })).status).toBe(200);
  await until(() => tasks.get(task.id)?.column === "review");
  const impl = runs.listForTask(task.id)[0]!;
  const { publishGlobalEvent } = await import("./orchestrator.ts");
  const { tickOrchestratedBatch } = await import("./pm-orchestrated-batch.ts");
  publishGlobalEvent({ kind: "run-status", taskId: task.id, runId: impl.id, status: "succeeded", ts: Date.now() });
  await tickOrchestratedBatch(batch.id);
  recoverWorkflows();
  expect((await api("POST", "/task-workspace/publish", { taskId: task.id, approve: true, paths: ["src/clamp.ts"] })).status).toBe(200);
  const testPrepared = await api("POST", `/tasks/${task.id}/qc-evidence/test-authorization`, { acknowledgeRisk: true, purpose: "first-review", validMinutes: 30 });
  expect(testPrepared.status).toBe(201);
  const authId = (testPrepared.json.authorization as { id: string } | undefined)?.id ?? (testPrepared.json as { id: string }).id;
  await api("POST", `/tasks/${task.id}/qc-evidence/test-authorization/${authId}/approve`, {});
  await api("POST", `/tasks/${task.id}/qc-evidence/test-authorization/${authId}/execute`, {});
  recoverWorkflows();
  await until(async () => {
    const view = await api("GET", `/project-manager/orchestrated-batches/${batch.id}?path=${encodeURIComponent(dir)}`);
    return (view.json.queueGate as { nextAuthorizationPhase?: string } | undefined)?.nextAuthorizationPhase === "reviewer";
  });
  const reviewerGrant = await api("POST", `/project-manager/orchestrated-batches/${batch.id}/phase-grants`, { path: dir, taskId: task.id, phase: "reviewer", implementationRunId: impl.id });
  expect(reviewerGrant.status, reviewerGrant.text).toBe(200);
  const fullWf = (await import("./pm-orchestrated-workflow.ts")).getWorkflowForTask(task.id)!;
  const { prepareQcReview } = await import("./task-quality-control.ts");
  const { noteOrchestratedLaunchCommitted } = await import("./pm-orchestrated-workflow.ts");
  const prep = prepareQcReview({
    taskId: task.id,
    reviewerHarness: fullWf.grant.reviewerHarness,
    reviewerModel: fullWf.grant.reviewerModel,
  }, { implementationRunId: impl.id, allowColumns: ["review", "blocked"] });
  const reviewRunId = randomUUID();
  const now = Date.now();
  runs.insert({
    id: reviewRunId,
    taskId: task.id,
    agent: opts.runAgent ?? fullWf.grant.reviewerHarness,
    status: "failed",
    startedAt: now,
    endedAt: now,
    exitCode: 1,
    tmuxSession: null,
    claudeSessionId: null,
    codexSessionId: opts.codexSessionId ?? null,
    cursorSessionId: null,
    geminiSessionId: null,
    fxSessionId: null,
    antigravitySessionId: null,
    origin: null,
    projectRulesSnapshot: null,
    knowledgeSnapshot: null,
    qcReviewId: prep.review.id,
  });
  reviews.linkReviewRun(prep.review.id, reviewRunId);
  reviews.markRunning(prep.review.id, now);
  noteOrchestratedLaunchCommitted(fullWf, "review", reviewRunId);
  for (const chunk of opts.stderr) runs.appendEvent(reviewRunId, "stderr", chunk.data, chunk.lineUuid ?? null);
  const { settleQcReviewRun } = await import("./task-quality-control-settle.ts");
  await settleQcReviewRun(reviewRunId, "failed");
  const { moveTaskColumn } = await import("./orchestrator.ts");
  if (tasks.get(task.id)?.column !== "blocked") moveTaskColumn(task.id, "blocked");
  const batchRow = db.query<{ data_json: string; status: string }, [string]>(`SELECT data_json, status FROM pm_orchestrated_batches WHERE id = ?`).get(batch.id)!;
  const record = JSON.parse(batchRow.data_json) as { phaseGrants?: { id: string; phase: string; status: string; consumedRunId: string | null }[]; status?: string; policy?: { expiresAt?: number } };
  const phaseGrant = record.phaseGrants?.find((row) => row.phase === "reviewer");
  if (phaseGrant) {
    phaseGrant.status = "consumed";
    phaseGrant.consumedRunId = reviewRunId;
  }
  record.status = "paused";
  db.run(`UPDATE pm_orchestrated_batches SET status = 'paused', data_json = ? WHERE id = ?`, [JSON.stringify(record), batch.id]);
  const workflowMod = await import("./pm-orchestrated-workflow.ts");
  const current = workflowMod.getWorkflowForTask(task.id);
  expect(current?.progress.failureClass).toBe("quota-exhausted");
  if (current) await workflowMod.scheduleOrchestratedTick(current.id);
  const settled = workflowMod.getWorkflowForTask(task.id);
  if (settled) {
    const data = {
      progress: { ...settled.progress, failureClass: "quota-exhausted" },
      counters: { ...settled.counters, launchesUsed: 2 },
    };
    db.run(
      `UPDATE pm_orchestrated_workflows SET status = 'paused', phase = ?, data_json = ?, updated_at = ? WHERE id = ?`,
      [settled.progress.phase, JSON.stringify(data), Date.now(), settled.id],
    );
  }
  return { dir, task, batchId: batch.id, implId: impl.id, reviewRunId, reviewId: prep.review.id };
}

test("provider quota failure blocks renewal until Owner recovery authorizes one supplemental Reviewer", async () => {
  const scene = await pausedQuotaScene({ name: "recovery", stderr: [{ data: "provider failed: usage_limit_exceeded" }] });
  const { dir, task } = scene;
  const batch = { id: scene.batchId };
  const impl = { id: scene.implId };
  expect(tasks.get(task.id)?.column).toBe("blocked");
  expect(workflowFor(task.id)?.counters.launchesUsed).toBe(2);
  expect(workflowFor(task.id)?.status).toBe("paused");
  expect((await api("POST", `/project-manager/orchestrated-batches/${batch.id}/phase-grants`, { path: dir, taskId: task.id, phase: "reviewer", implementationRunId: impl.id })).status).toBe(409);

  const preview = await api("GET", `/project-manager/orchestrated-batches/${batch.id}/provider-recovery?path=${encodeURIComponent(dir)}&taskId=${task.id}`);
  expect(preview.status).toBe(200);
  expect((preview.json as { eligible: boolean }).eligible).toBe(true);

  const approved = await api("POST", `/project-manager/orchestrated-batches/${batch.id}/provider-recovery`, { path: dir, taskId: task.id });
  expect(approved.status).toBe(201);
  const recovery = approved.json as { id: string };
  expect((await api("POST", `/project-manager/orchestrated-batches/${batch.id}/provider-recovery/${recovery.id}/apply`, { path: dir })).status).toBe(200);
  expect((await api("POST", `/project-manager/orchestrated-batches/${batch.id}/resume`, { path: dir })).status).toBe(200);
  process.env.AGETOR_FAKE_QC_VERDICT = "PASS";
  db.run(`UPDATE tasks SET run_id = ? WHERE id = ?`, [scene.reviewRunId, task.id]);
  const mint = await api("POST", `/project-manager/orchestrated-batches/${batch.id}/provider-recovery/${recovery.id}/phase-grant`, { path: dir });
  expect(mint.status).toBe(201);
  const mintBody = mint.json as { scheduledReview?: boolean; phaseGrantId?: string };
  expect(mintBody.scheduledReview).toBe(true);
  await until(() => workflowFor(task.id)?.status === "awaiting_owner");
  const supplementalReview = reviews.listForTask(task.id).find((row) => row.verdict === "PASS");
  expect(supplementalReview?.implementationRunId).toBe(impl.id);
  expect(runs.listForTask(task.id)).toHaveLength(3);
  expect(workflowFor(task.id)?.counters.launchesUsed).toBe(3);
  expect(workflowFor(task.id)?.grant.maxLaunches).toBe(2);
  const view = await api("GET", `/project-manager/orchestrated-batches/${batch.id}?path=${encodeURIComponent(dir)}`);
  const taskRow = (view.json.tasks as { taskId: string; remainingLaunches?: number; supplementalLaunchesRemaining?: number }[]).find((row) => row.taskId === task.id)!;
  expect(taskRow.remainingLaunches).toBe(0);
  expect(taskRow.supplementalLaunchesRemaining).toBe(0);
  expect(reviews.listForTask(task.id).filter((row) => row.verdict === "PASS")).toHaveLength(1);
  expect(reviews.listForTask(task.id).filter((row) => row.verdict == null)).toHaveLength(1);
}, 60_000);

test("legacy Codex usage-limit stderr is recovery-eligible only with process provenance", async () => {
  process.env.AGETOR_FAKE_QC_VERDICT = "MODEL_NOT_FOUND";
  const scene = await pausedQuotaScene({
    name: "legacy-quota",
    stderr: [
      { data: LEGACY_USAGE_LIMIT, lineUuid: "error:0" },
      { data: LEGACY_USAGE_LIMIT, lineUuid: "turn.failed:1" },
    ],
    runAgent: CODEX_AGENT,
    codexSessionId: CODEX_SESSION,
    promptExtra: LEGACY_USAGE_LIMIT,
  });
  const { dir, task, reviewRunId, reviewId, implId } = scene;
  const batchId = scene.batchId;
  const wf = async () => (await import("./pm-orchestrated-workflow.ts")).getWorkflowForTask(task.id);
  expect((await wf())?.progress.failureClass).toBe("quota-exhausted");
  expect((await wf())?.grant.maxLaunches).toBe(2);
  expect((await wf())?.counters.launchesUsed).toBe(2);

  const previewUrl = `/project-manager/orchestrated-batches/${batchId}/provider-recovery?path=${encodeURIComponent(dir)}&taskId=${task.id}`;
  const first = await api("GET", previewUrl);
  expect(first.status).toBe(200);
  const body = first.json as {
    eligible: boolean;
    blockers: string[];
    failedReviewerRunId: string | null;
    failedQcReviewId: string | null;
    developerRunId: string | null;
    evidenceBundleDigest: string | null;
    sourceFingerprint: string | null;
    authorization: unknown;
    launchesUsed: number | null;
    frozenMaxLaunches: number | null;
    failureClass: string | null;
  };
  expect(body.eligible, JSON.stringify(body.blockers)).toBe(true);
  expect(body.failedReviewerRunId).toBe(reviewRunId);
  expect(body.failedQcReviewId).toBe(reviewId);
  expect(body.developerRunId).toBe(implId);
  expect(body.failureClass).toBe("quota-exhausted");
  expect(body.evidenceBundleDigest).toMatch(/^[0-9a-f]{64}$/);
  expect(body.sourceFingerprint).toMatch(/^[0-9a-f]{64}$/);
  expect(body.authorization).toBeNull();
  expect(body.launchesUsed).toBe(2);
  expect(body.frozenMaxLaunches).toBe(2);
  expect(reviews.get(reviewId)?.verdict ?? null).toBeNull();
  const recoveryRows = () => db.query<{ n: number }, [string]>(`SELECT COUNT(*) AS n FROM pm_provider_recoveries WHERE task_id = ?`).get(task.id)?.n ?? 0;
  expect(recoveryRows()).toBe(0);

  const expectIneligible = async () => {
    const preview = await api("GET", previewUrl);
    expect((preview.json as { eligible: boolean }).eligible).toBe(false);
  };
  const restoreProof = () => {
    db.run(`DELETE FROM run_events WHERE run_id = ? AND stream IN ('stderr', 'assistant')`, [reviewRunId]);
    runs.appendEvent(reviewRunId, "stderr", LEGACY_USAGE_LIMIT, "error:0");
    runs.appendEvent(reviewRunId, "stderr", LEGACY_USAGE_LIMIT, "turn.failed:1");
    runs.update(reviewRunId, { status: "failed", exitCode: 1, codexSessionId: CODEX_SESSION });
    db.run(`UPDATE runs SET agent = ? WHERE id = ?`, [CODEX_AGENT, reviewRunId]);
    reviews.complete(reviewId, { verdict: null, summary: "Reviewer process failed before a QC verdict.", findings: [], feedback: null, completedAt: Date.now(), status: "complete" });
    const state = tasks.get(task.id)?.qcState;
    if (state) tasks.setQcState(task.id, { ...state, latestVerdict: null, awaitingOwnerApproval: false });
  };

  db.run(`DELETE FROM run_events WHERE run_id = ? AND stream = 'stderr'`, [reviewRunId]);
  runs.appendEvent(reviewRunId, "assistant", LEGACY_USAGE_LIMIT, "item.completed:1");
  await expectIneligible();
  restoreProof();

  db.run(`DELETE FROM run_events WHERE run_id = ? AND stream = 'stderr'`, [reviewRunId]);
  await expectIneligible();
  restoreProof();

  runs.update(reviewRunId, { status: "succeeded", exitCode: 0 });
  await expectIneligible();
  restoreProof();

  db.run(`DELETE FROM run_events WHERE run_id = ? AND stream = 'stderr'`, [reviewRunId]);
  runs.appendEvent(reviewRunId, "stderr", "Not logged in", "error:0");
  await expectIneligible();
  restoreProof();

  db.run(`DELETE FROM run_events WHERE run_id = ? AND stream = 'stderr'`, [reviewRunId]);
  runs.appendEvent(reviewRunId, "stderr", "rate limit exceeded", "error:0");
  await expectIneligible();
  restoreProof();

  const otherRunId = randomUUID();
  const reviewRun = runs.get(reviewRunId)!;
  runs.insert({ ...reviewRun, id: otherRunId, qcReviewId: null });
  db.run(`DELETE FROM run_events WHERE run_id = ? AND stream = 'stderr'`, [reviewRunId]);
  runs.appendEvent(otherRunId, "stderr", LEGACY_USAGE_LIMIT, "error:0");
  await expectIneligible();
  db.run(`DELETE FROM run_events WHERE run_id = ?`, [otherRunId]);
  db.run(`DELETE FROM runs WHERE id = ?`, [otherRunId]);
  restoreProof();

  runs.update(reviewRunId, { codexSessionId: null });
  await expectIneligible();
  runs.update(reviewRunId, { codexSessionId: "not-a-session" });
  await expectIneligible();
  db.run(`UPDATE runs SET agent = 'claude-code' WHERE id = ?`, [reviewRunId]);
  runs.update(reviewRunId, { codexSessionId: CODEX_SESSION });
  await expectIneligible();
  restoreProof();

  const state = tasks.get(task.id)?.qcState;
  for (const verdict of ["PASS", "BLOCKED", "CHANGES_REQUESTED"] as const) {
    reviews.complete(reviewId, { verdict, summary: "genuine", findings: [], feedback: null, completedAt: Date.now(), status: "complete" });
    if (state) tasks.setQcState(task.id, { ...state, latestVerdict: verdict });
    await expectIneligible();
  }
  restoreProof();
  expect((await api("GET", previewUrl)).json).toMatchObject({ eligible: true, failedReviewerRunId: reviewRunId });

  const row = db.query<{ data_json: string }, [string]>(`SELECT data_json FROM pm_orchestrated_batches WHERE id = ?`).get(batchId)!;
  const stored = JSON.parse(row.data_json) as { policy?: { expiresAt?: number } };
  const originalExpiry = stored.policy?.expiresAt;
  stored.policy = { ...stored.policy, expiresAt: Date.now() - 1_000 };
  db.run(`UPDATE pm_orchestrated_batches SET data_json = ? WHERE id = ?`, [JSON.stringify(stored), batchId]);
  const expired = await api("POST", `/project-manager/orchestrated-batches/${batchId}/provider-recovery`, { path: dir, taskId: task.id });
  expect(expired.status).toBe(409);
  stored.policy = { ...stored.policy, expiresAt: originalExpiry };
  db.run(`UPDATE pm_orchestrated_batches SET data_json = ? WHERE id = ?`, [JSON.stringify(stored), batchId]);
  expect((await wf())?.counters.launchesUsed).toBe(2);
  expect((await wf())?.grant.maxLaunches).toBe(2);

  const approved = await api("POST", `/project-manager/orchestrated-batches/${batchId}/provider-recovery`, { path: dir, taskId: task.id });
  expect(approved.status).toBe(201);
  const recoveryId = (approved.json as { id: string }).id;
  expect((await wf())?.counters.launchesUsed).toBe(2);
  expect((await wf())?.grant.maxLaunches).toBe(2);
  expect(recoveryRows()).toBe(1);

  const clampPath = path.join(dir, "src/clamp.ts");
  const originalClamp = readFileSync(clampPath, "utf8");
  writeFileSync(clampPath, `${originalClamp}\n// changed after approval\n`);
  const changed = await api("POST", `/project-manager/orchestrated-batches/${batchId}/provider-recovery/${recoveryId}/apply`, { path: dir });
  expect(changed.status).toBe(409);
  writeFileSync(clampPath, originalClamp);
  expect((await wf())?.counters.launchesUsed).toBe(2);
  expect((await wf())?.status).toBe("paused");

  db.run(`UPDATE pm_provider_recoveries SET status = 'consumed' WHERE id = ?`, [recoveryId]);
  const reused = await api("POST", `/project-manager/orchestrated-batches/${batchId}/provider-recovery`, { path: dir, taskId: task.id });
  expect(reused.status).toBe(409);
  expect((await wf())?.counters.launchesUsed).toBe(2);
  expect((await wf())?.grant.maxLaunches).toBe(2);
  expect(reviews.get(reviewId)?.verdict ?? null).toBeNull();
}, 90_000);
