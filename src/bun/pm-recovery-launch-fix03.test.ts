/**
 * FO-AUTO03-RECOVERY-LAUNCH-FIX03. Isolated databases and fake drivers only.
 * Does not open the Owner database or call a live provider.
 */
import { afterAll, beforeAll, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { makeTask } from "../cli/test-fixtures.ts";
import { FAKE_TASK_FILES_MARKER } from "../shared/task-workspace.ts";
import type { QueuePhaseGrant } from "../shared/pm-orchestrated-batch.ts";

const root = realpathSync(mkdtempSync(path.join(tmpdir(), "fo-recovery-launch-fix03-")));
process.env.AGETOR_DATA_DIR = path.join(root, "data");
process.env.AGETOR_API_PORT = "4498";
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

beforeAll(async () => {
  ({ tasks, projects, runs, taskQualityReviews: reviews, db } = await import("./db.ts"));
  const serverMod = await import("./server.ts");
  const workflow = await import("./pm-orchestrated-workflow.ts");
  const batch = await import("./pm-orchestrated-batch.ts");
  workflow.initOrchestratedWorkflows();
  batch.initOrchestratedBatches();
  server = serverMod.startApiServer() as unknown as { stop: () => void };
  token = serverMod.API_TOKEN;
});

afterAll(() => {
  server?.stop?.();
  rmSync(root, { recursive: true, force: true });
});

const url = (p: string) => `http://127.0.0.1:4498${p}`;
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
  await git(dir, ["-c", "user.email=fix03@example.com", "-c", "user.name=FO Fix03", "commit", "-m", "seed"]);
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
  const body = await fetch(url("/employees"), { method: "POST", headers: auth(), body: JSON.stringify({ name: `Dev ${randomUUID().slice(0, 4)}`, jobTitle: "Eng", projectPath: dir }) }).then((r) => r.json()) as { id: string };
  return body.id;
}

async function api(method: string, pathname: string, body?: unknown) {
  const res = await fetch(url(pathname), { method, headers: auth(), body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await res.text();
  return { status: res.status, text, json: text ? JSON.parse(text) as Record<string, unknown> : {} };
}

async function until(pred: () => boolean | Promise<boolean>, detail?: () => unknown): Promise<void> {
  for (let i = 0; i < 160; i++) {
    if (await pred()) return;
    await Bun.sleep(50);
  }
  throw new Error(`timeout ${detail ? JSON.stringify(detail()) : ""}`);
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

function batchRecord(batchId: string): { status: string; policy?: { expiresAt?: number; maxLaunchesPerTask?: number }; phaseGrants?: QueuePhaseGrant[] } {
  const row = db.query<{ data_json: string; status: string }, [string]>(`SELECT data_json, status FROM pm_orchestrated_batches WHERE id = ?`).get(batchId)!;
  const record = JSON.parse(row.data_json) as ReturnType<typeof batchRecord>;
  record.status = row.status;
  return record;
}

function saveBatchRecord(batchId: string, record: ReturnType<typeof batchRecord>): void {
  db.run(`UPDATE pm_orchestrated_batches SET status = ?, data_json = ? WHERE id = ?`, [record.status, JSON.stringify(record), batchId]);
}

function recoveryRow(recoveryId: string): { status: string; approvedAt: number; expiresAt: number; supplementalLaunchesConsumed: number } {
  const row = db.query<{ status: string; recovery_json: string }, [string]>(`SELECT status, recovery_json FROM pm_provider_recoveries WHERE id = ?`).get(recoveryId)!;
  const auth = JSON.parse(row.recovery_json) as { approvedAt: number; expiresAt: number; supplementalLaunchesConsumed: number };
  return { status: row.status, approvedAt: auth.approvedAt, expiresAt: auth.expiresAt, supplementalLaunchesConsumed: auth.supplementalLaunchesConsumed };
}

async function throughReviewerGate(name: string): Promise<{ dir: string; taskId: string; batchId: string; implId: string }> {
  const dir = await project(name);
  const dev = await employee(dir);
  const task = readyTask(dir, name);
  await fetch(url("/task-assignments"), { method: "POST", headers: auth(), body: JSON.stringify({ taskId: task.id, employeeId: dev }) });
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
  const workflow = await import("./pm-orchestrated-workflow.ts");
  publishGlobalEvent({ kind: "run-status", taskId: task.id, runId: impl.id, status: "succeeded", ts: Date.now() });
  await tickOrchestratedBatch(batch.id);
  workflow.recoverOrchestratedWorkflows();
  expect((await api("POST", "/task-workspace/publish", { taskId: task.id, approve: true, paths: ["src/clamp.ts"] })).status).toBe(200);
  const testPrepared = await api("POST", `/tasks/${task.id}/qc-evidence/test-authorization`, { acknowledgeRisk: true, purpose: "first-review", validMinutes: 30 });
  expect(testPrepared.status).toBe(201);
  const authId = (testPrepared.json.authorization as { id: string } | undefined)?.id ?? (testPrepared.json as { id: string }).id;
  await api("POST", `/tasks/${task.id}/qc-evidence/test-authorization/${authId}/approve`, {});
  await api("POST", `/tasks/${task.id}/qc-evidence/test-authorization/${authId}/execute`, {});
  workflow.recoverOrchestratedWorkflows();
  await until(async () => {
    const view = await api("GET", `/project-manager/orchestrated-batches/${batch.id}?path=${encodeURIComponent(dir)}`);
    return (view.json.queueGate as { nextAuthorizationPhase?: string } | undefined)?.nextAuthorizationPhase === "reviewer";
  });
  return { dir, taskId: task.id, batchId: batch.id, implId: impl.id };
}

async function appliedRecovery(name: string): Promise<{ dir: string; taskId: string; batchId: string; implId: string; reviewRunId: string; reviewId: string; recoveryId: string }> {
  const scene = await throughReviewerGate(name);
  expect((await api("POST", `/project-manager/orchestrated-batches/${scene.batchId}/pause`, { path: scene.dir })).status).toBe(200);
  const granted = await api("POST", `/project-manager/orchestrated-batches/${scene.batchId}/phase-grants`, {
    path: scene.dir, taskId: scene.taskId, phase: "reviewer", implementationRunId: scene.implId,
  });
  expect(granted.status).toBe(200);
  const workflow = await import("./pm-orchestrated-workflow.ts");
  const fullWf = workflow.getWorkflowForTask(scene.taskId)!;
  const { prepareQcReview } = await import("./task-quality-control.ts");
  const prep = prepareQcReview({
    taskId: scene.taskId,
    reviewerHarness: fullWf.grant.reviewerHarness,
    reviewerModel: fullWf.grant.reviewerModel,
  }, { implementationRunId: scene.implId, allowColumns: ["review", "blocked"] });
  const reviewRunId = randomUUID();
  const now = Date.now();
  runs.insert({
    id: reviewRunId, taskId: scene.taskId, agent: fullWf.grant.reviewerHarness, status: "failed",
    startedAt: now, endedAt: now, exitCode: 1, tmuxSession: null, claudeSessionId: null, codexSessionId: null,
    cursorSessionId: null, geminiSessionId: null, fxSessionId: null, antigravitySessionId: null, origin: null,
    projectRulesSnapshot: null, knowledgeSnapshot: null, qcReviewId: prep.review.id,
  });
  reviews.linkReviewRun(prep.review.id, reviewRunId);
  reviews.markRunning(prep.review.id, now);
  workflow.noteOrchestratedLaunchCommitted(fullWf, "review", reviewRunId);
  runs.appendEvent(reviewRunId, "stderr", "provider failed: usage_limit_exceeded");
  const { settleQcReviewRun } = await import("./task-quality-control-settle.ts");
  await settleQcReviewRun(reviewRunId, "failed");
  const { moveTaskColumn } = await import("./orchestrator.ts");
  if (tasks.get(scene.taskId)?.column !== "blocked") moveTaskColumn(scene.taskId, "blocked");
  db.run(`UPDATE tasks SET run_id = ? WHERE id = ?`, [reviewRunId, scene.taskId]);
  const record = batchRecord(scene.batchId);
  const phaseGrant = record.phaseGrants?.find((row) => row.phase === "reviewer" && !row.recoveryAuthorizationId);
  if (phaseGrant) {
    phaseGrant.status = "consumed";
    phaseGrant.consumedRunId = reviewRunId;
  }
  record.status = "paused";
  saveBatchRecord(scene.batchId, record);
  const current = workflow.getWorkflowForTask(scene.taskId)!;
  db.run(
    `UPDATE pm_orchestrated_workflows SET status = 'paused', data_json = ?, updated_at = ? WHERE id = ?`,
    [JSON.stringify({ progress: { ...current.progress, failureClass: "quota-exhausted" }, counters: { ...current.counters, launchesUsed: 2 } }), Date.now(), current.id],
  );
  const approved = await api("POST", `/project-manager/orchestrated-batches/${scene.batchId}/provider-recovery`, { path: scene.dir, taskId: scene.taskId, validMinutes: 30 });
  expect(approved.status, approved.text).toBe(201);
  const recoveryId = (approved.json as { id: string }).id;
  expect((await api("POST", `/project-manager/orchestrated-batches/${scene.batchId}/provider-recovery/${recoveryId}/apply`, { path: scene.dir })).status).toBe(200);
  return { ...scene, reviewRunId, reviewId: prep.review.id, recoveryId };
}

test("ordinary gated Reviewer uses the Developer run and still requires Owner Done", async () => {
  process.env.AGETOR_FAKE_QC_VERDICT = "PASS";
  const scene = await throughReviewerGate("ordinary");
  const before = runs.listForTask(scene.taskId).length;
  const granted = await api("POST", `/project-manager/orchestrated-batches/${scene.batchId}/phase-grants`, {
    path: scene.dir, taskId: scene.taskId, phase: "reviewer", implementationRunId: scene.implId,
  });
  expect(granted.status, granted.text).toBe(200);
  const workflow = await import("./pm-orchestrated-workflow.ts");
  await until(
    () => workflow.getWorkflowForTask(scene.taskId)?.status === "awaiting_owner",
    () => {
      const wf = workflow.getWorkflowForTask(scene.taskId);
      const grants = batchRecord(scene.batchId).phaseGrants?.map((row) => ({ phase: row.phase, status: row.status, consumedRunId: row.consumedRunId, failure: row.prelaunchFailure?.message ?? null }));
      return {
        status: wf?.status,
        phase: wf?.progress.phase,
        pause: wf?.progress.pauseReason,
        wait: wf?.progress.waitReason,
        launchesUsed: wf?.counters.launchesUsed,
        column: tasks.get(scene.taskId)?.column,
        runId: tasks.get(scene.taskId)?.runId,
        runs: runs.listForTask(scene.taskId).map((row) => ({ id: row.id, status: row.status, qc: row.qcReviewId })),
        reviews: reviews.listForTask(scene.taskId).map((row) => ({ id: row.id, status: row.status, verdict: row.verdict, impl: row.implementationRunId })),
        grants,
        batch: batchRecord(scene.batchId).status,
      };
    },
  );
  const taskRuns = runs.listForTask(scene.taskId);
  expect(taskRuns.length).toBe(before + 1);
  const review = reviews.listForTask(scene.taskId).find((row) => row.verdict === "PASS");
  expect(review?.implementationRunId).toBe(scene.implId);
  expect(tasks.get(scene.taskId)?.column).not.toBe("done");
  expect(tasks.get(scene.taskId)?.qcState?.latestVerdict).toBe("PASS");
  expect(tasks.get(scene.taskId)?.qcState?.awaitingOwnerApproval).toBe(true);
  const wf = workflow.getWorkflowForTask(scene.taskId)!;
  expect(wf.grant.maxLaunches).toBe(2);
  expect(wf.counters.launchesUsed).toBe(2);
  const grant = batchRecord(scene.batchId).phaseGrants?.find((row) => row.phase === "reviewer");
  expect(grant?.status).toBe("consumed");
  expect(grant?.consumedRunId).toBe(review?.reviewRunId);
  expect(db.query<{ n: number }, [string]>(`SELECT COUNT(*) AS n FROM pm_provider_recoveries WHERE task_id = ?`).get(scene.taskId)?.n).toBe(0);
  const runsBeforeTick = taskRuns.length;
  await workflow.scheduleOrchestratedTick(wf.id);
  expect(runs.listForTask(scene.taskId)).toHaveLength(runsBeforeTick);
}, 90_000);

test("pre-launch QC failure does not create a Reviewer run or consume the supplemental allowance", async () => {
  process.env.AGETOR_FAKE_QC_VERDICT = "PASS";
  const scene = await appliedRecovery("prelaunch");
  expect((await api("POST", `/project-manager/orchestrated-batches/${scene.batchId}/resume`, { path: scene.dir })).status).toBe(200);
  const wf = (await import("./pm-orchestrated-workflow.ts")).getWorkflowForTask(scene.taskId)!;
  for (const round of [2, 3, 4, 5]) {
    reviews.insert({
      id: randomUUID(), taskId: scene.taskId, projectPath: scene.dir, round, status: "complete", findings: [],
      reviewerEmployeeId: null, reviewerRoleSlug: null, reviewerHarness: wf.grant.reviewerHarness, reviewerModel: wf.grant.reviewerModel,
      reviewerProfileId: null, implementationRunId: scene.implId, savedTaskJson: "{}", requestedAt: Date.now() - 60_000,
    });
  }
  const runsBefore = runs.listForTask(scene.taskId).length;
  const mint = await api("POST", `/project-manager/orchestrated-batches/${scene.batchId}/provider-recovery/${scene.recoveryId}/phase-grant`, { path: scene.dir });
  expect(mint.status, mint.text).toBe(201);
  await until(() => batchRecord(scene.batchId).status === "paused");
  expect(runs.listForTask(scene.taskId)).toHaveLength(runsBefore);
  const grant = batchRecord(scene.batchId).phaseGrants?.find((row) => row.recoveryAuthorizationId === scene.recoveryId);
  expect(grant?.status).toBe("prelaunch-failed");
  expect(grant?.consumedRunId).toBeNull();
  expect(grant?.prelaunchFailure?.operation).toBe("prepare-qc-review");
  expect(recoveryRow(scene.recoveryId).supplementalLaunchesConsumed).toBe(0);
  expect(recoveryRow(scene.recoveryId).status).toBe("applied");
  const workflow = await import("./pm-orchestrated-workflow.ts");
  expect(workflow.getWorkflowForTask(scene.taskId)?.counters.launchesUsed).toBe(2);
  expect(workflow.getWorkflowForTask(scene.taskId)?.grant.maxLaunches).toBe(2);
  await workflow.scheduleOrchestratedTick(workflow.getWorkflowForTask(scene.taskId)!.id);
  const { tickOrchestratedBatch } = await import("./pm-orchestrated-batch.ts");
  await tickOrchestratedBatch(scene.batchId);
  expect(runs.listForTask(scene.taskId)).toHaveLength(runsBefore);
  expect(reviews.get(scene.reviewId)?.verdict ?? null).toBeNull();
  expect(runs.get(scene.reviewRunId)?.status).toBe("failed");
}, 90_000);

test("a paused batch does not launch a Reviewer just because a recovery grant exists", async () => {
  const scene = await appliedRecovery("paused-grant");
  const runsBefore = runs.listForTask(scene.taskId).length;
  const mint = await api("POST", `/project-manager/orchestrated-batches/${scene.batchId}/provider-recovery/${scene.recoveryId}/phase-grant`, { path: scene.dir });
  expect(mint.status, mint.text).toBe(201);
  expect((mint.json as { scheduledReview?: boolean }).scheduledReview).toBe(false);
  await Bun.sleep(200);
  expect(runs.listForTask(scene.taskId)).toHaveLength(runsBefore);
  expect(batchRecord(scene.batchId).status).toBe("paused");
  const grant = batchRecord(scene.batchId).phaseGrants?.find((row) => row.id === (mint.json as { phaseGrantId: string }).phaseGrantId);
  expect(grant?.status).toBe("active");
  expect(recoveryRow(scene.recoveryId).supplementalLaunchesConsumed).toBe(0);
}, 90_000);

test("failed, foreign, and changed-evidence implementations are not reviewed", async () => {
  const failedDev = await appliedRecovery("failed-dev");
  const failedMint = await api("POST", `/project-manager/orchestrated-batches/${failedDev.batchId}/provider-recovery/${failedDev.recoveryId}/phase-grant`, { path: failedDev.dir });
  expect(failedMint.status).toBe(201);
  runs.update(failedDev.implId, { status: "failed", exitCode: 1 });
  const runsBefore = runs.listForTask(failedDev.taskId).length;
  expect((await api("POST", `/project-manager/orchestrated-batches/${failedDev.batchId}/resume`, { path: failedDev.dir })).status).toBe(200);
  await Bun.sleep(300);
  expect(runs.listForTask(failedDev.taskId)).toHaveLength(runsBefore);
  const failedGrant = batchRecord(failedDev.batchId).phaseGrants?.find((row) => row.recoveryAuthorizationId === failedDev.recoveryId);
  expect(failedGrant?.consumedRunId ?? null).toBeNull();
  expect(failedGrant?.status).not.toBe("consumed");

  const foreign = await appliedRecovery("foreign-run");
  const other = readyTask(foreign.dir, "other-task");
  const otherRun = randomUUID();
  const now = Date.now();
  runs.insert({
    id: otherRun, taskId: other.id, agent: "claude-code", status: "succeeded", startedAt: now, endedAt: now, exitCode: 0,
    tmuxSession: null, claudeSessionId: null, codexSessionId: null, cursorSessionId: null, geminiSessionId: null,
    fxSessionId: null, antigravitySessionId: null, origin: null, projectRulesSnapshot: null, knowledgeSnapshot: null, qcReviewId: null,
  });
  const foreignMint = await api("POST", `/project-manager/orchestrated-batches/${foreign.batchId}/provider-recovery/${foreign.recoveryId}/phase-grant`, { path: foreign.dir });
  expect(foreignMint.status).toBe(201);
  const foreignRecord = batchRecord(foreign.batchId);
  const foreignGrant = foreignRecord.phaseGrants?.find((row) => row.recoveryAuthorizationId === foreign.recoveryId);
  if (!foreignGrant) throw new Error("missing grant");
  foreignGrant.implementationRunId = otherRun;
  saveBatchRecord(foreign.batchId, foreignRecord);
  const foreignRuns = runs.listForTask(foreign.taskId).length;
  expect((await api("POST", `/project-manager/orchestrated-batches/${foreign.batchId}/resume`, { path: foreign.dir })).status).toBe(200);
  await Bun.sleep(300);
  expect(runs.listForTask(foreign.taskId)).toHaveLength(foreignRuns);
  expect(batchRecord(foreign.batchId).phaseGrants?.find((row) => row.id === foreignGrant.id)?.consumedRunId ?? null).toBeNull();

  const changed = await appliedRecovery("changed-evidence");
  const changedMint = await api("POST", `/project-manager/orchestrated-batches/${changed.batchId}/provider-recovery/${changed.recoveryId}/phase-grant`, { path: changed.dir });
  expect(changedMint.status).toBe(201);
  const file = path.join(changed.dir, "src/clamp.ts");
  const original = readFileSync(file, "utf8");
  writeFileSync(file, `${original}\n// evidence changed\n`);
  const changedRuns = runs.listForTask(changed.taskId).length;
  expect((await api("POST", `/project-manager/orchestrated-batches/${changed.batchId}/resume`, { path: changed.dir })).status).toBe(200);
  await Bun.sleep(400);
  expect(runs.listForTask(changed.taskId)).toHaveLength(changedRuns);
  const changedGrant = batchRecord(changed.batchId).phaseGrants?.find((row) => row.recoveryAuthorizationId === changed.recoveryId);
  expect(changedGrant?.consumedRunId ?? null).toBeNull();
  expect(changedGrant?.status === "consumed").toBe(false);
  expect(recoveryRow(changed.recoveryId).supplementalLaunchesConsumed).toBe(0);
  writeFileSync(file, original);
}, 120_000);

test("a provider failure after launch still consumes the supplemental allowance once", async () => {
  process.env.AGETOR_FAKE_QC_VERDICT = "MODEL_NOT_FOUND";
  const scene = await appliedRecovery("provider-fail");
  expect((await api("POST", `/project-manager/orchestrated-batches/${scene.batchId}/resume`, { path: scene.dir })).status).toBe(200);
  const before = runs.listForTask(scene.taskId).length;
  const mint = await api("POST", `/project-manager/orchestrated-batches/${scene.batchId}/provider-recovery/${scene.recoveryId}/phase-grant`, { path: scene.dir });
  expect(mint.status, mint.text).toBe(201);
  expect((mint.json as { scheduledReview?: boolean }).scheduledReview).toBe(true);
  const workflow = await import("./pm-orchestrated-workflow.ts");
  await until(
    () => recoveryRow(scene.recoveryId).status === "consumed",
    () => {
      const wf = workflow.getWorkflowForTask(scene.taskId);
      return {
        recovery: recoveryRow(scene.recoveryId).status,
        status: wf?.status,
        pause: wf?.progress.pauseReason,
        wait: wf?.progress.waitReason,
        launchesUsed: wf?.counters.launchesUsed,
        runs: runs.listForTask(scene.taskId).map((row) => row.status),
        grants: batchRecord(scene.batchId).phaseGrants?.map((row) => ({ status: row.status, consumed: row.consumedRunId, failure: row.prelaunchFailure?.operation ?? null })),
      };
    },
  );
  const taskRuns = runs.listForTask(scene.taskId);
  expect(taskRuns.length).toBe(before + 1);
  const launched = taskRuns.find((row) => row.id !== scene.implId && row.id !== scene.reviewRunId);
  expect(launched?.status).toBe("failed");
  const grant = batchRecord(scene.batchId).phaseGrants?.find((row) => row.id === (mint.json as { phaseGrantId: string }).phaseGrantId);
  expect(grant?.status).toBe("consumed");
  expect(grant?.consumedRunId).toBe(launched?.id);
  expect(workflow.getWorkflowForTask(scene.taskId)?.counters.launchesUsed).toBe(3);
  expect(workflow.getWorkflowForTask(scene.taskId)?.grant.maxLaunches).toBe(2);
  expect(recoveryRow(scene.recoveryId).supplementalLaunchesConsumed).toBe(1);
  expect((await api("POST", `/project-manager/orchestrated-batches/${scene.batchId}/provider-recovery`, { path: scene.dir, taskId: scene.taskId })).status).toBe(409);
  expect(reviews.get(scene.reviewId)?.verdict ?? null).toBeNull();
  const originalExpiry = batchRecord(scene.batchId).policy?.expiresAt;
  expect(originalExpiry).toBeTruthy();
}, 90_000);

test("concurrent claims cannot start two Reviewers", async () => {
  const scene = await appliedRecovery("concurrent");
  const mint = await api("POST", `/project-manager/orchestrated-batches/${scene.batchId}/provider-recovery/${scene.recoveryId}/phase-grant`, { path: scene.dir });
  expect(mint.status).toBe(201);
  const grantId = (mint.json as { phaseGrantId: string }).phaseGrantId;
  db.run(`UPDATE pm_orchestrated_batches SET status = 'running' WHERE id = ?`, [scene.batchId]);
  const { claimPhaseGrant } = await import("./pm-orchestrated-batch.ts");
  const [first, second] = await Promise.all([claimPhaseGrant(scene.batchId, grantId), claimPhaseGrant(scene.batchId, grantId)]);
  expect([first, second].filter(Boolean)).toHaveLength(1);
  const grant = batchRecord(scene.batchId).phaseGrants?.find((row) => row.id === grantId);
  expect(grant?.status).toBe("claimed");
  expect(grant?.consumedRunId).toBeNull();
  expect(runs.listForTask(scene.taskId)).toHaveLength(2);
  const record = batchRecord(scene.batchId);
  record.status = "paused";
  saveBatchRecord(scene.batchId, record);
}, 90_000);

test("an expired recovery is not extended, and one proved pre-launch reauthorization can launch once", async () => {
  process.env.AGETOR_FAKE_QC_VERDICT = "PASS";
  const scene = await appliedRecovery("reauth");
  const runsBefore = runs.listForTask(scene.taskId).length;
  const mint = await api("POST", `/project-manager/orchestrated-batches/${scene.batchId}/provider-recovery/${scene.recoveryId}/phase-grant`, { path: scene.dir });
  expect(mint.status, mint.text).toBe(201);
  expect((mint.json as { scheduledReview?: boolean }).scheduledReview).toBe(false);
  await Bun.sleep(150);
  expect(runs.listForTask(scene.taskId)).toHaveLength(runsBefore);
  const grantId = (mint.json as { phaseGrantId: string }).phaseGrantId;
  const { recoverProviderRecoveries } = await import("./pm-provider-recovery.ts");
  const { recoverOrchestratedBatches } = await import("./pm-orchestrated-batch.ts");
  const claimed = batchRecord(scene.batchId);
  const claimedGrant = claimed.phaseGrants?.find((row) => row.id === grantId);
  if (!claimedGrant) throw new Error("missing grant");
  claimedGrant.status = "claimed";
  claimedGrant.claimedAt = Date.now();
  saveBatchRecord(scene.batchId, claimed);
  recoverProviderRecoveries();
  recoverOrchestratedBatches();
  expect(batchRecord(scene.batchId).phaseGrants?.find((row) => row.id === grantId)?.status).toBe("claimed");

  const consumed = batchRecord(scene.batchId);
  const consumedGrant = consumed.phaseGrants?.find((row) => row.id === grantId);
  if (!consumedGrant) throw new Error("missing grant");
  consumedGrant.status = "consumed";
  consumedGrant.consumedRunId = null;
  saveBatchRecord(scene.batchId, consumed);
  db.run(
    `INSERT INTO pm_orchestrated_batch_events (batch_id, at, kind, task_id, text) VALUES (?, ?, 'paused', ?, ?)`,
    [scene.batchId, Date.now(), scene.taskId, "Quality review requires a succeeded implementation run."],
  );
  const original = recoveryRow(scene.recoveryId);
  const expiredAt = Date.now() - 5_000;
  const stored = db.query<{ recovery_json: string }, [string]>(`SELECT recovery_json FROM pm_provider_recoveries WHERE id = ?`).get(scene.recoveryId)!;
  const authJson = JSON.parse(stored.recovery_json) as { status: string; approvedAt: number; expiresAt: number };
  authJson.status = "expired";
  authJson.expiresAt = expiredAt;
  db.run(`UPDATE pm_provider_recoveries SET status = 'expired', recovery_json = ? WHERE id = ?`, [JSON.stringify(authJson), scene.recoveryId]);
  expect(recoveryRow(scene.recoveryId).approvedAt).toBe(original.approvedAt);
  expect(recoveryRow(scene.recoveryId).expiresAt).toBe(expiredAt);

  const ambiguousId = randomUUID();
  const ambiguousAt = Date.now();
  runs.insert({
    id: ambiguousId, taskId: scene.taskId, agent: "claude-code", status: "failed", startedAt: ambiguousAt, endedAt: ambiguousAt, exitCode: 1,
    tmuxSession: null, claudeSessionId: null, codexSessionId: "01999999-9999-4999-8999-999999999999", cursorSessionId: null,
    geminiSessionId: null, fxSessionId: null, antigravitySessionId: null, origin: null, projectRulesSnapshot: null, knowledgeSnapshot: null, qcReviewId: null,
  });
  const ambiguous = await api("GET", `/project-manager/orchestrated-batches/${scene.batchId}/provider-recovery/${scene.recoveryId}/prelaunch-classification?path=${encodeURIComponent(scene.dir)}`);
  expect(ambiguous.status).toBe(200);
  expect((ambiguous.json as { kind: string }).kind).toBe("manual-review");
  expect((await api("POST", `/project-manager/orchestrated-batches/${scene.batchId}/provider-recovery/${scene.recoveryId}/prelaunch-reauthorization`, { path: scene.dir, reason: "should fail" })).status).toBe(409);
  db.run(`DELETE FROM runs WHERE id = ?`, [ambiguousId]);

  const record = batchRecord(scene.batchId);
  const preservedExpiry = record.policy?.expiresAt;
  record.policy = { ...record.policy, expiresAt: Date.now() - 1_000 };
  saveBatchRecord(scene.batchId, record);
  const expiredBatch = await api("POST", `/project-manager/orchestrated-batches/${scene.batchId}/provider-recovery/${scene.recoveryId}/prelaunch-reauthorization`, { path: scene.dir });
  expect(expiredBatch.status).toBe(409);
  expect(batchRecord(scene.batchId).policy?.expiresAt).toBe(record.policy.expiresAt);
  const restored = batchRecord(scene.batchId);
  restored.policy = { ...restored.policy, expiresAt: preservedExpiry };
  saveBatchRecord(scene.batchId, restored);

  const proved = await api("GET", `/project-manager/orchestrated-batches/${scene.batchId}/provider-recovery/${scene.recoveryId}/prelaunch-classification?path=${encodeURIComponent(scene.dir)}`);
  expect(proved.status).toBe(200);
  expect(proved.json).toMatchObject({ kind: "proven-prelaunch-failure", grantId, developerRunId: scene.implId, failedReviewerRunId: scene.reviewRunId });
  const decision = await api("POST", `/project-manager/orchestrated-batches/${scene.batchId}/provider-recovery/${scene.recoveryId}/prelaunch-reauthorization`, {
    path: scene.dir, validMinutes: 30, reason: "Verified pre-launch failure.",
  });
  expect(decision.status, decision.text).toBe(201);
  const after = recoveryRow(scene.recoveryId);
  expect(after.approvedAt).toBe(original.approvedAt);
  expect(after.expiresAt).toBe(expiredAt);
  expect(after.status).toBe("expired");
  expect(after.supplementalLaunchesConsumed).toBe(0);
  expect(batchRecord(scene.batchId).phaseGrants?.find((row) => row.id === grantId)?.status).toBe("consumed");
  expect((await api("POST", `/project-manager/orchestrated-batches/${scene.batchId}/provider-recovery/${scene.recoveryId}/prelaunch-reauthorization`, { path: scene.dir })).status).toBe(409);
  recoverProviderRecoveries();
  expect(recoveryRow(scene.recoveryId).approvedAt).toBe(original.approvedAt);
  expect(recoveryRow(scene.recoveryId).expiresAt).toBe(expiredAt);
  const reloaded = JSON.parse(db.query<{ recovery_json: string }, [string]>(`SELECT recovery_json FROM pm_provider_recoveries WHERE id = ?`).get(scene.recoveryId)!.recovery_json) as { prelaunchReauthorization?: { status: string } };
  expect(reloaded.prelaunchReauthorization?.status).toBe("approved");

  expect((await api("POST", `/project-manager/orchestrated-batches/${scene.batchId}/provider-recovery/${scene.recoveryId}/prelaunch-reauthorization/apply`, { path: scene.dir })).status).toBe(200);
  expect((await api("POST", `/project-manager/orchestrated-batches/${scene.batchId}/resume`, { path: scene.dir })).status).toBe(200);
  expect(runs.listForTask(scene.taskId)).toHaveLength(runsBefore);
  const replacement = await api("POST", `/project-manager/orchestrated-batches/${scene.batchId}/provider-recovery/${scene.recoveryId}/prelaunch-reauthorization/phase-grant`, { path: scene.dir });
  expect(replacement.status, replacement.text).toBe(201);
  expect((replacement.json as { scheduledReview?: boolean }).scheduledReview).toBe(true);
  const workflow = await import("./pm-orchestrated-workflow.ts");
  await until(
    () => workflow.getWorkflowForTask(scene.taskId)?.status === "awaiting_owner",
    () => {
      const wf = workflow.getWorkflowForTask(scene.taskId);
      return { status: wf?.status, pause: wf?.progress.pauseReason, wait: wf?.progress.waitReason, launchesUsed: wf?.counters.launchesUsed, column: tasks.get(scene.taskId)?.column, recovery: recoveryRow(scene.recoveryId).status };
    },
  );
  expect(runs.listForTask(scene.taskId)).toHaveLength(runsBefore + 1);
  const pass = reviews.listForTask(scene.taskId).find((row) => row.verdict === "PASS");
  expect(pass?.implementationRunId).toBe(scene.implId);
  expect(tasks.get(scene.taskId)?.runId).not.toBe(scene.implId);
  expect(tasks.get(scene.taskId)?.column).not.toBe("done");
  expect(workflow.getWorkflowForTask(scene.taskId)?.counters.launchesUsed).toBe(3);
  expect(workflow.getWorkflowForTask(scene.taskId)?.grant.maxLaunches).toBe(2);
  expect(recoveryRow(scene.recoveryId).supplementalLaunchesConsumed).toBe(1);
  expect(recoveryRow(scene.recoveryId).status).toBe("consumed");
  expect(batchRecord(scene.batchId).policy?.maxLaunchesPerTask).toBe(2);
  expect(batchRecord(scene.batchId).policy?.expiresAt).toBe(preservedExpiry);
  expect(batchRecord(scene.batchId).phaseGrants?.find((row) => row.id === grantId)?.consumedRunId).toBeNull();
  expect(reviews.get(scene.reviewId)?.verdict ?? null).toBeNull();
  expect((await api("POST", `/project-manager/orchestrated-batches/${scene.batchId}/provider-recovery/${scene.recoveryId}/prelaunch-reauthorization/phase-grant`, { path: scene.dir })).status).toBe(409);
  expect((await api("POST", `/project-manager/orchestrated-batches/${scene.batchId}/provider-recovery`, { path: scene.dir, taskId: scene.taskId })).status).toBe(409);
  expect(runs.listForTask(scene.taskId)).toHaveLength(runsBefore + 1);
}, 120_000);
