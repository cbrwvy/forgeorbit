/**
 * FO-AUTO01 — durable bounded orchestration: Owner grant → implement → QC → Owner done.
 * Reuses employee execution, QC (FO-QC01), and task runtime; no second engine.
 */
import { getRunExecution } from "./run-execution.ts";
import { randomUUID } from "node:crypto";
import type { Task } from "../shared/types.ts";
import {
  ORCHESTRATED_WORKFLOW_LIMITS,
  buildOrchestratedWorkflowView,
  emptyCounters,
  emptyProgress,
  grantExpired,
  launchesRemaining,
  reworkRemaining,
  type OrchestratedWorkflowApproveBody,
  type OrchestratedWorkflowGrant,
  type OrchestratedWorkflowProgress,
  type OrchestratedWorkflowRecord,
  type OrchestratedWorkflowView,
} from "../shared/pm-orchestrated-workflow.ts";
import { trustedCodexQuotaProof } from "../shared/codex-quota-failure.ts";
import { classifyQueueFailure, isGatedPolicy, type QueueFailureClass } from "../shared/queue-gates.ts";
import { effectiveLaunchesRemaining } from "../shared/pm-provider-recovery.ts";
import { noteSupplementalLaunchConsumed, supplementalRecoveryAuthIfNeeded } from "./pm-provider-recovery.ts";
import { commitClaimedPhaseGrant, failPhaseGrantPrelaunch } from "./pm-phase-grant-state.ts";
import { decideQueueStep, readBatchGateState } from "./queue-gates.ts";
import { columnBlockReason } from "../shared/project-execution.ts";
import { freezeWorkflowExecution, workflowResourceBlock } from "./orchestrated-resources.ts";
import { launchFingerprint } from "../shared/task-scheduling.ts";
import { db, harnesses, tasks, runs, taskQualityReviews } from "./db.ts";
import { AssignmentCore } from "./assignment-core.ts";
import { reviewEmployeeExecution, startEmployeeExecution, type EmployeeRunDeps } from "./employee-run.ts";
import { isRunLive, isRunStarting, isTaskRunLive, subscribeGlobal } from "./orchestrator.ts";
import { ownershipOf } from "./project-ownership.ts";
import { checkProjectLaunchAdmission } from "./project-lifecycle.ts";
import { onTaskAvailabilityChange, taskAvailabilityFor, taskAvailabilityNow } from "./task-availability.ts";
import { recoveryGrantIdForReview } from "./qc-recovery-link.ts";
import { prepareQcReview, startQcReview, QcError } from "./task-quality-control.ts";
import { harnessUnavailableReason } from "./supervised-live-workflow.ts";

export class OrchestratedWorkflowError extends Error {
  constructor(message: string, readonly status = 400, readonly code = "invalid") {
    super(message);
    this.name = "OrchestratedWorkflowError";
  }
}

type Row = {
  id: string;
  task_id: string;
  project_path: string;
  status: string;
  phase: string;
  grant_json: string;
  data_json: string;
  created_at: number;
  updated_at: number;
};

interface StoredData {
  progress: OrchestratedWorkflowProgress;
  counters: ReturnType<typeof emptyCounters>;
}

function parseGrant(raw: string): OrchestratedWorkflowGrant | null {
  try {
    const g = JSON.parse(raw) as OrchestratedWorkflowGrant;
    if (!g || typeof g.taskId !== "string" || typeof g.projectPath !== "string") return null;
    return g;
  } catch {
    return null;
  }
}

function parseData(raw: string): StoredData {
  try {
    const d = JSON.parse(raw) as StoredData;
    return {
      progress: { ...emptyProgress(), ...d.progress },
      counters: { ...emptyCounters(), ...d.counters },
    };
  } catch {
    return { progress: emptyProgress(), counters: emptyCounters() };
  }
}

function toRecord(row: Row): OrchestratedWorkflowRecord | null {
  const grant = parseGrant(row.grant_json);
  if (!grant) return null;
  const { progress, counters } = parseData(row.data_json);
  return {
    id: row.id,
    taskId: row.task_id,
    projectPath: row.project_path,
    status: row.status as OrchestratedWorkflowRecord["status"],
    grant,
    progress: { ...progress, phase: row.phase as OrchestratedWorkflowProgress["phase"] },
    counters,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function unionIds(current: string[] | undefined, stored: string[] | undefined): string[] {
  const out = [...(current ?? [])];
  const seen = new Set(out);
  for (const id of stored ?? []) if (!seen.has(id)) out.push(id);
  return out;
}

/** Launch counters and completed-run lists only move forward. A stale in-memory record must not erase a commit that already landed. */
function mergeMonotonic(record: OrchestratedWorkflowRecord): void {
  const row = db.query<{ data_json: string }, [string]>(`SELECT data_json FROM pm_orchestrated_workflows WHERE id = ?`).get(record.id);
  if (!row) return;
  let stored: StoredData;
  try { stored = JSON.parse(row.data_json) as StoredData; }
  catch { return; }
  const counters = stored.counters;
  if (counters) {
    record.counters.launchesUsed = Math.max(record.counters.launchesUsed, counters.launchesUsed ?? 0);
    record.counters.implementationRuns = Math.max(record.counters.implementationRuns, counters.implementationRuns ?? 0);
    record.counters.reviewRuns = Math.max(record.counters.reviewRuns, counters.reviewRuns ?? 0);
    record.counters.reworkCount = Math.max(record.counters.reworkCount, counters.reworkCount ?? 0);
  }
  const progress = stored.progress;
  if (!progress) return;
  record.progress.completedImplementationRunIds = unionIds(record.progress.completedImplementationRunIds, progress.completedImplementationRunIds);
  record.progress.completedReviewIds = unionIds(record.progress.completedReviewIds, progress.completedReviewIds);
  record.progress.finishedSteps = unionIds(record.progress.finishedSteps, progress.finishedSteps);
  const launched = record.progress.launchedRuns ?? [];
  const seenRuns = new Set(launched.map((item) => item.runId));
  for (const item of progress.launchedRuns ?? []) {
    if (!seenRuns.has(item.runId)) launched.push(item);
  }
  record.progress.launchedRuns = launched;
}

function save(record: OrchestratedWorkflowRecord): OrchestratedWorkflowRecord {
  mergeMonotonic(record);
  const data: StoredData = { progress: record.progress, counters: record.counters };
  db.run(
    `UPDATE pm_orchestrated_workflows SET status = ?, phase = ?, data_json = ?, updated_at = ? WHERE id = ?`,
    [record.status, record.progress.phase, JSON.stringify(data), record.updatedAt, record.id],
  );
  return record;
}

function insertRow(record: OrchestratedWorkflowRecord): OrchestratedWorkflowRecord {
  const data: StoredData = { progress: record.progress, counters: record.counters };
  db.run(
    `INSERT INTO pm_orchestrated_workflows (id, task_id, project_path, status, phase, grant_json, data_json, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      record.id, record.taskId, record.projectPath, record.status, record.progress.phase,
      JSON.stringify(record.grant), JSON.stringify(data), record.createdAt, record.updatedAt,
    ],
  );
  return record;
}

export function getWorkflowForTask(taskId: string): OrchestratedWorkflowRecord | null {
  const row = db.query<Row, [string]>(`SELECT * FROM pm_orchestrated_workflows WHERE task_id = ?`).get(taskId);
  return row ? toRecord(row) : null;
}

export function getWorkflow(id: string): OrchestratedWorkflowRecord | null {
  const row = db.query<Row, [string]>(`SELECT * FROM pm_orchestrated_workflows WHERE id = ?`).get(id);
  return row ? toRecord(row) : null;
}

export function listWorkflowHolds(): { projectPath: string; id: string; taskId: string; title: string; status: "paused" | "awaiting_owner" | "exhausted" | "expired" }[] {
  return db.query<Row, []>(
    `SELECT * FROM pm_orchestrated_workflows WHERE status IN ('paused', 'awaiting_owner', 'exhausted', 'expired') ORDER BY updated_at DESC`,
  ).all().filter((row) => tasks.get(row.task_id)?.column !== "done").map((row) => {
    const task = tasks.get(row.task_id);
    return {
      projectPath: row.project_path,
      id: row.id,
      taskId: row.task_id,
      title: task?.title ?? row.task_id.slice(0, 8),
      status: row.status as "paused" | "awaiting_owner" | "exhausted" | "expired",
    };
  });
}

function clampInt(value: unknown, min: number, max: number, fallback: number): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return fallback;
  return Math.min(max, Math.max(min, Math.trunc(value)));
}

export function approveOrchestratedWorkflow(taskId: string, body: OrchestratedWorkflowApproveBody): OrchestratedWorkflowRecord {
  const task = tasks.get(taskId);
  if (!task) throw new OrchestratedWorkflowError("Task not found.", 404, "not-found");
  if (task.archivedAt != null) throw new OrchestratedWorkflowError("Task is archived.", 409, "archived");
  if (task.column !== "ready") {
    const block = columnBlockReason(task.column);
    throw new OrchestratedWorkflowError(block ?? "Task must be in Ready to approve orchestration.", 409, "wrong-column");
  }
  const owner = ownershipOf(task.workdir, { fresh: true });
  if (owner.kind !== "owned") throw new OrchestratedWorkflowError("Task project ownership is ambiguous.", 409, "ownership");
  const projectPath = owner.projectPath;
  const lifecycle = checkProjectLaunchAdmission(projectPath);
  if (!lifecycle.allowed) throw new OrchestratedWorkflowError(lifecycle.reason!, 409, "project-paused");

  const existing = getWorkflowForTask(taskId);
  if (existing && (existing.status === "active" || existing.status === "paused" || existing.status === "awaiting_owner")) {
    throw new OrchestratedWorkflowError("An orchestrated workflow is already active for this task. Cancel it first.", 409, "active");
  }

  const implementerId = body.implementerEmployeeId?.trim();
  const implHarness = body.implementerHarnessId?.trim();
  const implModel = body.implementerModel?.trim();
  const reviewerHarness = body.reviewerHarness?.trim();
  const reviewerModel = body.reviewerModel?.trim();
  if (!implementerId || !implHarness || !implModel || !reviewerHarness || !reviewerModel) {
    throw new OrchestratedWorkflowError("Implementer, harness, model, and reviewer harness/model are required.", 400, "invalid");
  }
  if (!harnesses.getByIdOrKind(implHarness)) throw new OrchestratedWorkflowError(`Unknown implementer harness "${implHarness}".`, 400, "invalid");
  if (!harnesses.getByIdOrKind(reviewerHarness)) throw new OrchestratedWorkflowError(`Unknown reviewer harness "${reviewerHarness}".`, 400, "invalid");

  const assignment = new AssignmentCore(db).forTask(taskId);
  if (!assignment || assignment.employeeId !== implementerId) {
    throw new OrchestratedWorkflowError("The chosen implementer must be assigned to this task.", 409, "assignment");
  }

  const now = Date.now();
  const validMinutes = body.validMinutes === undefined
    ? ORCHESTRATED_WORKFLOW_LIMITS.ttlMinutes.default
    : clampInt(body.validMinutes, ORCHESTRATED_WORKFLOW_LIMITS.ttlMinutes.min, ORCHESTRATED_WORKFLOW_LIMITS.ttlMinutes.max, ORCHESTRATED_WORKFLOW_LIMITS.ttlMinutes.default);
  const maxLaunches = clampInt(
    body.maxLaunches,
    ORCHESTRATED_WORKFLOW_LIMITS.maxLaunches.min,
    ORCHESTRATED_WORKFLOW_LIMITS.maxLaunches.max,
    ORCHESTRATED_WORKFLOW_LIMITS.maxLaunches.default,
  );
  const maxRework = clampInt(
    body.maxReworkIterations,
    ORCHESTRATED_WORKFLOW_LIMITS.maxReworkIterations.min,
    ORCHESTRATED_WORKFLOW_LIMITS.maxReworkIterations.max,
    ORCHESTRATED_WORKFLOW_LIMITS.maxReworkIterations.default,
  );

  const grant: OrchestratedWorkflowGrant = {
    taskId,
    projectPath,
    implementerEmployeeId: implementerId,
    implementerHarnessId: implHarness,
    implementerModel: implModel,
    implementerEffort: typeof body.implementerEffort === "string" ? body.implementerEffort : null,
    reviewerEmployeeId: typeof body.reviewerEmployeeId === "string" ? body.reviewerEmployeeId : null,
    reviewerHarness,
    reviewerModel,
    autoReviewAfterImplementation: body.autoReviewAfterImplementation !== false,
    autoReworkOnChanges: body.autoReworkOnChanges === true,
    maxReworkIterations: maxRework,
    maxLaunches,
    expiresAt: now + validMinutes * 60_000,
    approvedAt: now,
    approvedBy: "owner",
    grantEpoch: 1,
    execution: freezeWorkflowExecution(task, body),
  };

  const record: OrchestratedWorkflowRecord = {
    id: randomUUID(),
    taskId,
    projectPath,
    status: "active",
    grant,
    progress: { ...emptyProgress(), phase: "implementing" },
    counters: emptyCounters(),
    createdAt: now,
    updatedAt: now,
  };

  if (existing) {
    db.run(`DELETE FROM pm_orchestrated_workflows WHERE id = ?`, [existing.id]);
  }
  if (body.implementerMode) tasks.update(taskId, { mode: grant.execution!.implementerMode });
  insertRow(record);
  void scheduleTick(record.id);
  return record;
}

/** FO-AUTO02: start or replace a per-task workflow under an approved batch grant. */
export async function bootstrapOrchestratedWorkflowForBatch(grant: OrchestratedWorkflowGrant): Promise<OrchestratedWorkflowRecord> {
  const taskId = grant.taskId;
  const task = tasks.get(taskId);
  if (!task) throw new OrchestratedWorkflowError("Task not found.", 404, "not-found");
  if (grant.approvedTaskFingerprint && launchFingerprint(task) !== grant.approvedTaskFingerprint) {
    throw new OrchestratedWorkflowError("Task changed since batch approval.", 409, "stale");
  }
  if (task.column !== "ready" && task.column !== "review" && task.column !== "running") {
    throw new OrchestratedWorkflowError(columnBlockReason(task.column) ?? "Task is not executable.", 409, "wrong-column");
  }
  const existing = getWorkflowForTask(taskId);
  if (existing && existing.grant.orchestratedBatchId === grant.orchestratedBatchId) {
    return existing;
  }
  if (existing) db.run(`DELETE FROM pm_orchestrated_workflows WHERE id = ?`, [existing.id]);
  const now = Date.now();
  const record: OrchestratedWorkflowRecord = {
    id: randomUUID(),
    taskId,
    projectPath: grant.projectPath,
    status: "active",
    grant,
    progress: { ...emptyProgress(), phase: task.column === "review" ? "awaiting_review" : "implementing" },
    counters: emptyCounters(),
    createdAt: now,
    updatedAt: now,
  };
  insertRow(record);
  return record;
}

/**
 * Legacy failed-review rows can stay `active` after the Reviewer process has
 * already exited. Pause this workflow only. Do not notify the batch, so a
 * historical pause reason and any coordination reservation stay as they are.
 */
export function reconcileStuckFailedReview(taskId: string, reason: string): OrchestratedWorkflowRecord | null {
  const record = getWorkflowForTask(taskId);
  if (!record) return null;
  if (record.status !== "active") return record;
  record.status = "paused";
  record.progress.pauseReason = reason;
  record.progress.activeReviewId = null;
  record.updatedAt = Date.now();
  return save(record);
}

export function cancelOrchestratedWorkflow(taskId: string): OrchestratedWorkflowRecord {
  const record = getWorkflowForTask(taskId);
  if (!record) throw new OrchestratedWorkflowError("No orchestrated workflow for this task.", 404, "not-found");
  record.status = "cancelled";
  record.progress.pauseReason = "Cancelled by the owner.";
  record.updatedAt = Date.now();
  return save(record);
}

/** Restores Reviewer eligibility after Owner-approved provider recovery. Does not launch a run. */
export function reactivateWorkflowForProviderRecovery(taskId: string): OrchestratedWorkflowRecord {
  const record = getWorkflowForTask(taskId);
  if (!record) throw new OrchestratedWorkflowError("No orchestrated workflow for this task.", 404, "not-found");
  record.status = "active";
  record.progress.pauseReason = null;
  record.progress.activeReviewId = null;
  record.progress.phase = "awaiting_review";
  record.progress.failureClass = "quota-exhausted";
  record.progress.waitReason = "Owner recovery applied. Authorize one supplemental Reviewer launch.";
  record.updatedAt = Date.now();
  return save(record);
}

export function resumeOrchestratedWorkflow(taskId: string): OrchestratedWorkflowRecord {
  const record = getWorkflowForTask(taskId);
  if (!record) throw new OrchestratedWorkflowError("No orchestrated workflow for this task.", 404, "not-found");
  if (record.status !== "paused") throw new OrchestratedWorkflowError("Only a paused workflow can be resumed.", 409, "not-paused");
  const lifecycle = checkProjectLaunchAdmission(record.projectPath);
  if (!lifecycle.allowed) throw new OrchestratedWorkflowError(lifecycle.reason!, 409, "project-paused");
  if (grantExpired(record.grant, Date.now())) {
    record.status = "expired";
    record.progress.pauseReason = "Grant expired before resume.";
    record.updatedAt = Date.now();
    save(record);
    throw new OrchestratedWorkflowError("Grant expired.", 409, "expired");
  }
  record.status = "active";
  record.progress.pauseReason = null;
  record.updatedAt = Date.now();
  save(record);
  void scheduleTick(record.id);
  return record;
}

function pause(
  record: OrchestratedWorkflowRecord,
  reason: string,
  terminal: OrchestratedWorkflowRecord["status"] = "paused",
  failureClass?: QueueFailureClass,
): OrchestratedWorkflowRecord {
  record.status = terminal;
  record.progress.pauseReason = reason;
  record.progress.failureClass = failureClass ?? classifyQueueFailure({ text: reason, qcVerdict: null, testExit: null }).failureClass;
  record.updatedAt = Date.now();
  save(record);
  if (record.grant.orchestratedBatchId) void import("./pm-orchestrated-batch.ts").then(m => m.onBatchWorkflowPaused(record.grant.orchestratedBatchId!, record.taskId, reason));
  return record;
}

function stepKey(kind: "impl" | "qc", id: string): string {
  return `${kind}:${id}`;
}

function hasStep(progress: OrchestratedWorkflowProgress, key: string): boolean {
  return progress.finishedSteps.includes(key);
}

function markStep(record: OrchestratedWorkflowRecord, key: string): void {
  if (!record.progress.finishedSteps.includes(key)) record.progress.finishedSteps.push(key);
}

/** Validates an employee start is covered by the active grant (FO-AUTO01 gate). */
export function validateOrchestratedEmployeeStart(workflowId: string, attemptId: string, taskId: string): OrchestratedWorkflowRecord {
  const record = getWorkflow(workflowId);
  if (!record || record.taskId !== taskId) throw new OrchestratedWorkflowError("Orchestrated workflow not found for this task.", 404, "not-found");
  if (record.status !== "active") throw new OrchestratedWorkflowError("Orchestrated workflow is not active.", 409, "not-active");
  const lifecycle = checkProjectLaunchAdmission(record.projectPath);
  if (!lifecycle.allowed) throw new OrchestratedWorkflowError(lifecycle.reason!, 409, "project-paused");
  const scheduled = taskAvailabilityFor(tasks.get(taskId), taskAvailabilityNow());
  if (!scheduled.available) {
    throw new OrchestratedWorkflowError(
      `Task is scheduled to be available from ${scheduled.availableFromUtc}. Waiting for scheduled time.`,
      409,
      "scheduled-not-yet-available",
    );
  }
  const block = workflowResourceBlock(record.grant);
  if (block) throw new OrchestratedWorkflowError(block, 409, "resource-changed");
  const attempt = db.query<{requested_mode: string; requested_harness_id: string; requested_model: string | null; employee_id: string; task_id: string; project_path: string}, [string]>("SELECT requested_mode, requested_harness_id, requested_model, employee_id, task_id, project_path FROM employee_executions WHERE id = ?").get(attemptId);
  if (record.grant.execution && (!attempt || attempt.employee_id !== record.grant.implementerEmployeeId || attempt.task_id !== record.grant.taskId || attempt.project_path !== record.grant.projectPath || attempt.requested_mode !== record.grant.execution.implementerMode || attempt.requested_harness_id !== record.grant.implementerHarnessId || attempt.requested_model !== record.grant.implementerModel)) throw new OrchestratedWorkflowError("Employee resource differs from the approved grant. No fallback.", 409);
  if (grantExpired(record.grant, Date.now())) {
    pause(record, "Grant expired.", "expired");
    throw new OrchestratedWorkflowError("Grant expired.", 409, "expired");
  }
  const supplemental = supplementalRecoveryAuthIfNeeded(record.taskId, record.grant, record.counters);
  if (effectiveLaunchesRemaining(record.grant, record.counters, supplemental) <= 0) {
    pause(record, "Launch limit reached.", "exhausted");
    throw new OrchestratedWorkflowError("Launch limit reached.", 409, "exhausted");
  }
  if (record.progress.activeEmployeeAttemptId && record.progress.activeEmployeeAttemptId !== attemptId) {
    throw new OrchestratedWorkflowError("Another orchestrated implementation step is in progress.", 409, "busy");
  }
  return record;
}

export function noteOrchestratedLaunchCommitted(record: OrchestratedWorkflowRecord, kind: "implementation" | "review", runId?: string): OrchestratedWorkflowRecord {
  const fresh = getWorkflow(record.id);
  if (!fresh) return record;
  if (runId && fresh.grant.orchestratedBatchId) {
    commitClaimedPhaseGrant(fresh.grant.orchestratedBatchId, fresh.taskId, kind === "review" ? "reviewer" : "developer", runId);
  }
  if (runId) {
    fresh.progress.launchedRuns ??= [];
    if (fresh.progress.launchedRuns.some(r => r.runId === runId)) return fresh;
    fresh.progress.launchedRuns.push({ runId, role: kind });
  }
  const usedSupplemental = fresh.counters.launchesUsed >= fresh.grant.maxLaunches;
  fresh.counters.launchesUsed += 1;
  if (usedSupplemental && runId) {
    noteSupplementalLaunchConsumed(fresh.taskId, runId);
  }
  if (kind === "implementation") fresh.counters.implementationRuns += 1;
  else fresh.counters.reviewRuns += 1;
  fresh.updatedAt = Date.now();
  return save(fresh);
}

const tickChains = new Map<string, Promise<void>>();

function scheduleTick(workflowId: string): Promise<void> {
  const prev = tickChains.get(workflowId) ?? Promise.resolve();
  const next = prev.then(() => tickOrchestratedWorkflow(workflowId)).catch((e) => {
    const record = getWorkflow(workflowId);
    if (record?.status === "active") pause(record, e instanceof Error ? e.message : "Orchestrated step failed; no retry.");
  });
  tickChains.set(workflowId, next);
  return next;
}

/** FO-AUTO02: awaitable tick scheduling for the batch coordinator. */
export function scheduleOrchestratedTick(workflowId: string): Promise<void> {
  return scheduleTick(workflowId);
}

const workflowAvailabilityTimers = new Map<string, ReturnType<typeof setTimeout>>();

function scheduleWorkflowAvailabilityWake(workflowId: string, untilMs: number | null): void {
  const existing = workflowAvailabilityTimers.get(workflowId);
  if (existing) {
    clearTimeout(existing);
    workflowAvailabilityTimers.delete(workflowId);
  }
  if (untilMs == null || !Number.isFinite(untilMs)) return;
  const delay = Math.min(60_000, Math.max(50, untilMs - taskAvailabilityNow()));
  const timer = setTimeout(() => {
    workflowAvailabilityTimers.delete(workflowId);
    void scheduleTick(workflowId);
  }, delay);
  timer.unref?.();
  workflowAvailabilityTimers.set(workflowId, timer);
}

let orchestratedWorkflowsInit = false;
export function initOrchestratedWorkflows(): void {
  if (orchestratedWorkflowsInit) return;
  orchestratedWorkflowsInit = true;
  subscribeGlobal((event) => {
    if (event.kind === "run-status") void onRunSettled(event.taskId, event.runId, event.status);
  });
  onTaskAvailabilityChange((taskId) => {
    const record = getWorkflowForTask(taskId);
    if (record?.status === "active") void scheduleTick(record.id);
  });
}

async function onRunSettled(taskId: string, runId: string, status: string): Promise<void> {
  const record = getWorkflowForTask(taskId);
  if (!record || record.status === "cancelled") return;
  const run = (await import("./db.ts")).runs.get(runId);
  if (run?.qcReviewId) {
    // A live exit settles in task-quality-control-settle. An orphaned or
    // cancelled recovery review has no exit handler, so settle it here.
    // This does not launch another review.
    if ((status === "orphaned" || status === "failed" || status === "cancelled") && recoveryGrantIdForReview(run.qcReviewId)) {
      const review = (await import("./db.ts")).taskQualityReviews.get(run.qcReviewId);
      if (review?.status === "running") {
        const { settleQcReviewRun } = await import("./task-quality-control-settle.ts");
        await settleQcReviewRun(runId, status as "orphaned" | "failed" | "cancelled");
      }
    }
    return;
  }
  if (status === "succeeded") {
    if (!hasStep(record.progress, stepKey("impl", runId))) {
      markStep(record, stepKey("impl", runId));
      if (!record.progress.completedImplementationRunIds.includes(runId)) {
        record.progress.completedImplementationRunIds.push(runId);
      }
      record.progress.activeEmployeeAttemptId = null;
      record.progress.phase = record.grant.autoReviewAfterImplementation ? "awaiting_review" : "awaiting_review";
      record.updatedAt = Date.now();
      save(record);
    }
  } else if (record.progress.activeEmployeeAttemptId) {
    record.progress.activeEmployeeAttemptId = null;
    pause(record, `Implementation run ${status}.`);
    return;
  }
  if (record.status === "active") void scheduleTick(record.id);
}

function quotaFailureClassForReview(reviewId: string): QueueFailureClass | undefined {
  const review = taskQualityReviews.get(reviewId);
  if (!review?.reviewRunId || review.verdict) return undefined;
  const run = runs.get(review.reviewRunId);
  if (!run) return undefined;
  return trustedCodexQuotaProof(run, runs.events(review.reviewRunId)) ? "quota-exhausted" : undefined;
}

export async function onOrchestratedQcSettled(taskId: string, reviewId: string, verdict: string | null, runStatus: string, reason?: string): Promise<void> {
  if (recoveryGrantIdForReview(reviewId)) return;
  const record = getWorkflowForTask(taskId);
  // A paused, cancelled, or already-accepted workflow must not be moved by a
  // later review. pause() would rewrite a historical batch reason, and a PASS
  // would release the next batch task. Recovery reviews return above.
  if (!record || record.status !== "active") return;
  if (runStatus !== "succeeded" || !verdict) {
    record.progress.activeReviewId = null;
    const quota = verdict ? undefined : quotaFailureClassForReview(reviewId);
    pause(record, reason?.trim() || "Quality review run did not succeed. No QC verdict was produced.", "paused", quota);
    return;
  }
  if (hasStep(record.progress, stepKey("qc", reviewId))) return;
  markStep(record, stepKey("qc", reviewId));
  if (!record.progress.completedReviewIds.includes(reviewId)) record.progress.completedReviewIds.push(reviewId);
  record.progress.activeReviewId = null;

  if (verdict === "PASS") {
    record.status = "awaiting_owner";
    record.progress.phase = "awaiting_owner_acceptance";
    record.progress.pauseReason = null;
    record.updatedAt = Date.now();
    save(record);
    if (record.grant.orchestratedBatchId) {
      const { onBatchTaskAwaitingOwner } = await import("./pm-orchestrated-batch.ts");
      void onBatchTaskAwaitingOwner(record.grant.orchestratedBatchId, taskId);
    }
    return;
  }
  if (verdict === "CHANGES_REQUESTED") {
    if (record.grant.autoReworkOnChanges && reworkRemaining(record.grant, record.counters) > 0 && launchesRemaining(record.grant, record.counters) > 0) {
      record.counters.reworkCount += 1;
      record.progress.phase = "rework";
      record.updatedAt = Date.now();
      save(record);
      void scheduleTick(record.id);
      return;
    }
    const reason = "Review requested changes. Rework is not authorized or limits were reached.";
    pause(record, reason);
    return;
  }
  const blocked = "Quality review blocked. Owner action required.";
  pause(record, blocked);
}

export async function tickOrchestratedWorkflow(workflowId: string, deps: EmployeeRunDeps = {}): Promise<void> {
  const record = getWorkflow(workflowId);
  if (!record || record.status !== "active") return;
  const resourceBlock = workflowResourceBlock(record.grant, record.progress.phase === "awaiting_review" || record.progress.phase === "reviewing");
  if (resourceBlock) {
    if (!resourceBlock.startsWith("Parent batch")) pause(record, resourceBlock);
    return;
  }
  const task = tasks.get(record.taskId);
  if (!task || task.archivedAt != null) {
    pause(record, "Task missing or archived.");
    return;
  }
  // Orphan reconciliation clears task.runId. The durable attempt/review owns
  // the launch identity across restart and must be checked before scheduling.
  const attemptRunId = record.progress.activeEmployeeAttemptId
    ? db.query<{run_id: string | null}, [string]>("SELECT run_id FROM employee_executions WHERE id = ?").get(record.progress.activeEmployeeAttemptId)?.run_id : null;
  const reviewRunId = record.progress.activeReviewId ? taskQualityReviews.get(record.progress.activeReviewId)?.reviewRunId : null;
  const latestId = reviewRunId ?? attemptRunId ?? task.runId;
  const latest = latestId ? runs.get(latestId) : null;
  if (latest && latest.startedAt >= record.grant.approvedAt && ["failed", "cancelled", "orphaned"].includes(latest.status)) {
    const { providerRecoveryAllowsRetry } = await import("./pm-provider-recovery.ts");
    if (!providerRecoveryAllowsRetry(record.taskId, latest.id)) {
      pause(record, `Previous run ${latest.status}; no automatic retry or continuation.`);
      return;
    }
  }
  if (record.progress.activeReviewId) {
    const review = taskQualityReviews.get(record.progress.activeReviewId);
    if (review?.status === "complete" && review.reviewRunId) {
      const reviewRun = runs.get(review.reviewRunId);
      await onOrchestratedQcSettled(record.taskId, review.id, review.verdict, reviewRun?.status ?? "orphaned");
      return;
    }
  }
  if (latest?.status === "succeeded" && !latest.qcReviewId && record.progress.activeEmployeeAttemptId && !hasStep(record.progress, stepKey("impl", latest.id))) {
    markStep(record, stepKey("impl", latest.id));
    record.progress.completedImplementationRunIds.push(latest.id);
    record.progress.activeEmployeeAttemptId = null;
    record.progress.phase = "awaiting_review";
    save(record);
  }
  if (task.column === "backlog" || task.column === "inbox") {
    pause(record, columnBlockReason(task.column) ?? "Task is not executable from this column.");
    return;
  }
  if (grantExpired(record.grant, Date.now())) {
    pause(record, "Grant expired.", "expired");
    return;
  }
  const supplementalTick = supplementalRecoveryAuthIfNeeded(record.taskId, record.grant, record.counters);
  // The launch that just consumed the last slot is already in flight. Reaching
  // the cap is not a reason to abandon that run or its QC verdict.
  const stepInFlight = !!record.progress.activeReviewId || !!record.progress.activeEmployeeAttemptId || isTaskRunLive(record.taskId);
  if (!stepInFlight && effectiveLaunchesRemaining(record.grant, record.counters, supplementalTick) <= 0) {
    pause(record, "Launch limit reached.", "exhausted");
    return;
  }

  const harnessBlock = await harnessUnavailableReason(record.grant.implementerHarnessId);
  if (harnessBlock && (record.progress.phase === "implementing" || record.progress.phase === "rework")) {
    pause(record, harnessBlock);
    return;
  }

  if (isTaskRunLive(record.taskId)) return;
  const runId = task.runId;
  if (runId && (isRunLive(runId) || isRunStarting(runId))) return;

  if (isGatedPolicy(record.grant)) {
    await stepGatedWorkflow(record, task, deps);
    return;
  }

  if (record.progress.phase === "implementing" || record.progress.phase === "rework") {
    if (task.column !== "ready") {
      if (task.column === "review" && record.grant.autoReviewAfterImplementation) {
        record.progress.phase = "awaiting_review";
        record.updatedAt = Date.now();
        save(record);
      } else if (task.column !== "running") {
        return;
      } else {
        return;
      }
    } else {
      const lifecycle = checkProjectLaunchAdmission(record.projectPath);
      if (!lifecycle.allowed) {
        pause(record, lifecycle.reason!, "paused", "project-paused");
        return;
      }
      const availability = taskAvailabilityFor(task, taskAvailabilityNow());
      if (!availability.available) {
        record.progress.waitReason = "Waiting for scheduled time.";
        record.updatedAt = Date.now();
        save(record);
        scheduleWorkflowAvailabilityWake(record.id, availability.availableFromMs);
        return;
      }
      await driveImplementation(record, task, deps);
      return;
    }
  }

  if (record.progress.phase === "awaiting_review" || record.progress.phase === "reviewing") {
    if (task.column !== "review") return;
    if (!record.grant.autoReviewAfterImplementation) {
      pause(record, "Automatic review was not authorized.");
      return;
    }
    const lifecycle = checkProjectLaunchAdmission(record.projectPath);
    if (!lifecycle.allowed) {
      pause(record, lifecycle.reason!, "paused", "project-paused");
      return;
    }
    const qcBlock = await harnessUnavailableReason(record.grant.reviewerHarness);
    if (qcBlock) {
      pause(record, qcBlock);
      return;
    }
    await driveQcReview(record, task);
  }
}

async function stepGatedWorkflow(record: OrchestratedWorkflowRecord, task: Task, deps: EmployeeRunDeps): Promise<void> {
  const batchId = record.grant.orchestratedBatchId;
  const batch = batchId ? readBatchGateState(batchId) : { status: "running", grants: [] };
  const implId = record.progress.completedImplementationRunIds.at(-1) ?? null;
  const implRun = implId ? runs.get(implId) : null;
  const action = await decideQueueStep({
    grant: record.grant,
    batchStatus: batch?.status ?? "running",
    task,
    live: false,
    implementation: implRun ? { id: implRun.id, status: implRun.status } : null,
    grants: batch?.grants ?? [],
    now: Date.now(),
  });
  if (action.kind === "legacy" || action.kind === "noop") return;
  if (action.kind === "wait") {
    record.progress.waitReason = action.reason;
    record.progress.failureClass = action.failureClass;
    record.progress.lastCompletedStep = action.lastCompletedStep;
    record.updatedAt = Date.now();
    save(record);
    if (batchId) {
      const { noteGatedWait } = await import("./pm-orchestrated-batch.ts");
      await noteGatedWait(batchId, record.taskId, action);
    }
    return;
  }
  if (action.kind === "pause") {
    pause(record, action.reason);
    return;
  }
  if (!batchId) return;
  const fresh = getWorkflow(record.id) ?? record;
  const current = tasks.get(fresh.taskId) ?? task;
  const lifecycle = checkProjectLaunchAdmission(fresh.projectPath);
  if (!lifecycle.allowed) {
    pause(fresh, lifecycle.reason!, "paused", "project-paused");
    return;
  }
  if (action.kind === "launch-developer") {
    if (!action.grantId) return;
    if (current.column !== "ready") return;
    const availability = taskAvailabilityFor(current, taskAvailabilityNow());
    if (!availability.available) {
      record.progress.waitReason = "Waiting for scheduled time.";
      record.updatedAt = Date.now();
      save(record);
      scheduleWorkflowAvailabilityWake(record.id, availability.availableFromMs);
      return;
    }
    if (fresh.grant.requireTaskWorkspace) {
      const { stagingCwdForTask } = await import("./task-workspace.ts");
      const staged = stagingCwdForTask(current.id);
      if (!staged.cwd) return;
    }
    const { claimPhaseGrant } = await import("./pm-orchestrated-batch.ts");
    if (!await claimPhaseGrant(batchId, action.grantId)) return;
    const after = getWorkflow(record.id) ?? fresh;
    await driveImplementation(after, tasks.get(after.taskId) ?? current, deps);
    return;
  }
  if (action.kind !== "launch-reviewer" || !action.grantId) return;
  if (current.column !== "review") return;
  const { resolveGatedReviewerTarget } = await import("./pm-reviewer-launch.ts");
  const binding = await resolveGatedReviewerTarget({
    task: current,
    batchId,
    grantId: action.grantId,
    completedImplementationRunIds: fresh.progress.completedImplementationRunIds,
    projectPath: fresh.grant.projectPath,
  });
  if (!binding.ok) {
    const marked = failPhaseGrantPrelaunch(batchId, action.grantId, {
      operation: "bind-implementation",
      message: binding.message,
      implementationRunId: null,
    }, ["active"]);
    if (marked) {
      pause(getWorkflow(record.id) ?? fresh, `Reviewer preparation failed before launch: ${binding.message}`, "paused", "unknown");
    }
    return;
  }
  const { claimPhaseGrant } = await import("./pm-orchestrated-batch.ts");
  if (!await claimPhaseGrant(batchId, action.grantId)) return;
  const after = getWorkflow(record.id) ?? fresh;
  await driveQcReview(after, tasks.get(after.taskId) ?? current, {
    implementationRunId: binding.implementationRunId,
    phaseGrantId: action.grantId,
    batchId,
  });
}

async function driveImplementation(record: OrchestratedWorkflowRecord, task: Task, deps: EmployeeRunDeps): Promise<void> {
  if (task.column !== "ready") return;

  if (record.progress.activeEmployeeAttemptId) {
    const attempt = (await import("./employee-run.ts")).getEmployeeRun(record.progress.activeEmployeeAttemptId, deps);
    if (attempt && (attempt.status === "awaiting-approval" || attempt.status === "starting" || attempt.status === "started")) {
      if (attempt.status === "awaiting-approval") {
        validateOrchestratedEmployeeStart(record.id, attempt.id, task.id);
        await startEmployeeExecution(attempt.id, {
          revision: attempt.revision,
          confirm: true,
          acknowledgeUsage: true,
          orchestratedWorkflowId: record.id,
        }, deps);
      }
      return;
    }
  }

  const review = await reviewEmployeeExecution({
    taskId: task.id,
    harnessId: record.grant.implementerHarnessId,
    model: record.grant.implementerModel,
    effort: record.grant.implementerEffort ?? undefined,
  }, deps);
  if (!review.attempt) {
    if (isTaskRunLive(task.id)) return;
    if (review.blockingErrors.some((e) => e.code === "unresolved-execution")) return;
    pause(record, review.blockingErrors[0]?.message ?? "Employee preflight blocked.");
    return;
  }
  record.progress.activeEmployeeAttemptId = review.attempt.id;
  record.updatedAt = Date.now();
  save(record);

  validateOrchestratedEmployeeStart(record.id, review.attempt.id, task.id);
  await startEmployeeExecution(review.attempt.id, {
    revision: review.attempt.revision,
    confirm: true,
    acknowledgeUsage: true,
    orchestratedWorkflowId: record.id,
  }, deps);
}

async function driveQcReview(
  record: OrchestratedWorkflowRecord,
  task: Task,
  launch?: { implementationRunId: string; phaseGrantId: string; batchId: string },
): Promise<void> {
  const active = (await import("./db.ts")).taskQualityReviews.getActive(task.id);
  if (active) {
    record.progress.activeReviewId = active.id;
    record.progress.phase = "reviewing";
    record.updatedAt = Date.now();
    save(record);
    if (active.status === "pending") {
      const started = await startQcReview(active.id, record.id);
      if ("error" in started) await pauseReviewLaunch(record, launch ?? null, started.error, active.reviewRunId);
    }
    return;
  }

  let prep;
  try {
    prep = prepareQcReview({
      taskId: task.id,
      reviewerHarness: record.grant.reviewerHarness,
      reviewerModel: record.grant.reviewerModel,
      reviewerEmployeeId: record.grant.reviewerEmployeeId ?? undefined,
    }, launch ? { implementationRunId: launch.implementationRunId } : undefined);
  } catch (e) {
    const msg = e instanceof QcError ? e.message : "Could not prepare quality review.";
    if (launch) {
      failPhaseGrantPrelaunch(launch.batchId, launch.phaseGrantId, {
        operation: "prepare-qc-review",
        message: msg,
        implementationRunId: launch.implementationRunId,
      }, ["claimed"]);
    }
    pause(record, `Reviewer preparation failed before launch: ${msg}`, "paused", "unknown");
    return;
  }
  record.progress.activeReviewId = prep.review.id;
  record.progress.phase = "reviewing";
  record.updatedAt = Date.now();
  save(record);
  const started = await startQcReview(prep.review.id, record.id);
  if ("error" in started) await pauseReviewLaunch(record, launch ?? null, started.error, null);
}

async function pauseReviewLaunch(
  record: OrchestratedWorkflowRecord,
  launch: { implementationRunId: string; phaseGrantId: string; batchId: string } | null,
  message: string,
  reviewRunId: string | null,
): Promise<void> {
  if (launch && !reviewRunId) {
    const row = db.query<{ data_json: string }, [string]>(`SELECT data_json FROM pm_orchestrated_batches WHERE id = ?`).get(launch.batchId);
    let consumedRunId: string | null = null;
    try {
      const parsed = JSON.parse(row?.data_json ?? "null") as { phaseGrants?: { id: string; consumedRunId: string | null; status: string }[] } | null;
      consumedRunId = parsed?.phaseGrants?.find((item) => item.id === launch.phaseGrantId)?.consumedRunId ?? null;
    } catch {
      consumedRunId = null;
    }
    if (!consumedRunId) {
      failPhaseGrantPrelaunch(launch.batchId, launch.phaseGrantId, {
        operation: "prepare-qc-review",
        message,
        implementationRunId: launch.implementationRunId,
      }, ["claimed"]);
      pause(record, `Reviewer preparation failed before launch: ${message}`, "paused", "unknown");
      return;
    }
  }
  pause(record, message);
}

export function recoverOrchestratedWorkflows(): void {
  const rows = db.query<{ id: string; project_path: string }, []>(
    `SELECT id, project_path FROM pm_orchestrated_workflows WHERE status = 'active'`,
  ).all();
  for (const row of rows) {
    if (!checkProjectLaunchAdmission(row.project_path).allowed) continue;
    void scheduleTick(row.id);
  }
}

export function getOrchestratedWorkflowView(taskId: string): OrchestratedWorkflowView {
  const task = tasks.get(taskId);
  const record = getWorkflowForTask(taskId);
  const usesFakeDriver = !!task?.runId && getRunExecution(task.runId)?.type === "synthetic";
  return buildOrchestratedWorkflowView(record, {
    taskColumn: task?.column ?? "ready",
    qcVerdict: task?.qcState?.latestVerdict ?? null,
    awaitingOwnerApproval: task?.qcState?.awaitingOwnerApproval ?? false,
    usesFakeDriver,
  });
}

/** PM read-only summary for manager context. */
export function pmOrchestratedWorkflowSummary(taskId: string): {
  active: boolean;
  phase: string;
  status: string;
  pauseReason: string | null;
  remainingLaunches: number;
} | null {
  const record = getWorkflowForTask(taskId);
  if (!record) return null;
  return {
    active: record.status === "active",
    phase: record.progress.phase,
    status: record.status,
    pauseReason: record.progress.pauseReason,
    remainingLaunches: launchesRemaining(record.grant, record.counters),
  };
}

export function buildPmOrchestratedContext(projectPath: string): { taskId: string; title: string; summary: ReturnType<typeof pmOrchestratedWorkflowSummary> }[] {
  return db.query<Row, [string]>(
    `SELECT * FROM pm_orchestrated_workflows WHERE project_path = ? AND status IN ('active', 'paused', 'awaiting_owner') ORDER BY updated_at DESC LIMIT 20`,
  ).all(projectPath).map((row) => {
    const task = tasks.get(row.task_id);
    return { taskId: row.task_id, title: task?.title ?? row.task_id.slice(0, 8), summary: pmOrchestratedWorkflowSummary(row.task_id) };
  });
}
