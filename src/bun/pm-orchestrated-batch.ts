/**
 * FO-AUTO02 — multi-task bounded PM orchestration via sequential FO-AUTO01 grants.
 */
import { headBatchBlock, type HeadBatchAuthority } from "./head-pm-auto-boundary.ts";
import { getRunExecution } from "./run-execution.ts";
import { randomUUID } from "node:crypto";
import { db, harnesses, tasks } from "./db.ts";
import { ActivityJournalCore } from "./activity-journal-core.ts";
import { AssignmentCore } from "./assignment-core.ts";
import { resolveProject } from "./environment/http.ts";
import { broadcastAppEvent } from "./quit-guard.ts";
import { taskInProject } from "./project-ownership.ts";
import { checkProjectLaunchAdmission } from "./project-lifecycle.ts";
import { onTaskAvailabilityChange, taskAvailabilityFor, taskAvailabilityNow } from "./task-availability.ts";
import { columnBlockReason } from "../shared/project-execution.ts";
import { capText } from "../shared/project-interview.ts";
import {
  ORCHESTRATED_BATCH_LIMITS,
  batchPolicyFromApprove,
  batchPolicyFromApproveLegacy,
  buildOrchestratedBatchView,
  emptyBatchProgress,
  grantForBatchTask,
  taskPlanFromTask,
  type OrchestratedBatchApproveBody,
  type OrchestratedBatchDraftBody,
  type OrchestratedBatchRecord,
  type OrchestratedBatchStatus,
  type OrchestratedBatchTaskPhase,
  type OrchestratedBatchView,
  type QueuePhaseGrant,
} from "../shared/pm-orchestrated-batch.ts";
import { launchFingerprint } from "../shared/task-scheduling.ts";
import { getTaskWorkspace } from "./task-workspace.ts";
import { freezeWorkflowExecution } from "./orchestrated-resources.ts";
import { buildQueueGateView, isGatedPolicy } from "../shared/queue-gates.ts";
import type { Task } from "../shared/types.ts";
import type { OrchestratedWorkflowApproveBody } from "../shared/pm-orchestrated-workflow.ts";
import {
  OrchestratedWorkflowError,
  bootstrapOrchestratedWorkflowForBatch,
  getWorkflowForTask,
  cancelOrchestratedWorkflow,
  scheduleOrchestratedTick,
} from "./pm-orchestrated-workflow.ts";
import { supplementalRecoveryAuthIfNeeded } from "./pm-provider-recovery.ts";
import { supplementalLaunchesRemaining } from "../shared/pm-provider-recovery.ts";

export class OrchestratedBatchError extends Error {
  constructor(message: string, readonly status = 400, readonly code = "invalid") {
    super(message);
    this.name = "OrchestratedBatchError";
  }
}

type BatchResult<T> = { ok: true; value: T } | { ok: false; status: number; error: string; body?: Record<string, unknown> };

function fail<T>(status: number, error: string, body?: Record<string, unknown>): BatchResult<T> {
  return { ok: false, status, error, ...(body ? { body } : {}) };
}

function parseRecord(raw: string | null): OrchestratedBatchRecord | null {
  if (!raw) return null;
  try {
    return JSON.parse(raw) as OrchestratedBatchRecord;
  } catch {
    return null;
  }
}

function saveRecord(record: OrchestratedBatchRecord, at = Date.now()): OrchestratedBatchRecord {
  record.updatedAt = at;
  db.run(
    `INSERT INTO pm_orchestrated_batches (id, project_path, status, data_json, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET status = excluded.status, data_json = excluded.data_json, updated_at = excluded.updated_at
     WHERE pm_orchestrated_batches.project_path = excluded.project_path`,
    [record.id, record.projectPath, record.status, JSON.stringify(record), record.createdAt, at],
  );
  broadcastAppEvent({ type: "execution_batch", projectPath: record.projectPath, batchId: record.id, status: record.status, ts: Date.now() });
  return record;
}

function appendEvent(batchId: string, kind: string, text: string, taskId: string | null = null, at = Date.now()): void {
  db.run(
    `INSERT INTO pm_orchestrated_batch_events (batch_id, at, kind, task_id, text) VALUES (?, ?, ?, ?, ?)`,
    [batchId, at, kind, taskId, capText(text, 400)],
  );
}

function journal(batch: OrchestratedBatchRecord, eventType: "autonomy.grant.approved" | "autonomy.execution.started", payload: Record<string, unknown>, keySuffix: string, at: number, coordinated = false): void {
  new ActivityJournalCore(db).record({
    eventType,
    projectPath: batch.projectPath,
    actorType: coordinated ? "system" : "owner",
    actorId: coordinated ? "head-pm-auto" : "owner",
    targetType: "proposal",
    targetId: batch.id,
    idempotencyKey: `orchestrated_batch:${batch.id}:${keySuffix}`,
    payload: { batchId: batch.id, grantId: batch.id, title: batch.title, taskIds: batch.tasks.map((t) => t.taskId), ...payload },
    createdAt: at,
  });
}

function registered(rawPath: unknown): BatchResult<string> {
  const resolved = resolveProject(typeof rawPath === "string" ? rawPath : "");
  if (!resolved.ok) return fail(resolved.status, resolved.error);
  return { ok: true, value: resolved.path };
}

function load(projectPath: string, id: string): OrchestratedBatchRecord | null {
  const row = db.query<{ data_json: string }, [string, string]>(
    `SELECT data_json FROM pm_orchestrated_batches WHERE id = ? AND project_path = ?`,
  ).get(id, projectPath);
  return parseRecord(row?.data_json ?? null);
}

function viewOf(record: OrchestratedBatchRecord): OrchestratedBatchView {
  const cols = new Map<string, string | null>();
  for (const t of record.tasks) cols.set(t.taskId, tasks.get(t.taskId)?.column ?? null);
  const usesFakeDriver = record.tasks.some(p => { const id = tasks.get(p.taskId)?.runId; return !!id && getRunExecution(id)?.type === "synthetic"; });
  const view = buildOrchestratedBatchView(record, cols, usesFakeDriver);
  for (const row of view.tasks) {
    row.launchedRuns = record.progress.byTask[row.taskId]?.launchedRuns ?? [];
    const wf = getWorkflowForTask(row.taskId);
    if (wf?.grant.orchestratedBatchId === record.id) {
      row.launchedRuns = wf.progress.launchedRuns ?? row.launchedRuns;
      row.remainingLaunches = Math.max(0, wf.grant.maxLaunches - wf.counters.launchesUsed);
      const supplemental = supplementalRecoveryAuthIfNeeded(row.taskId, wf.grant, wf.counters);
      row.supplementalLaunchesRemaining = supplementalLaunchesRemaining(supplemental, Date.now());
      row.remainingRework = Math.max(0, wf.grant.maxReworkIterations - wf.counters.reworkCount);
      const p = record.progress.byTask[row.taskId];
      if (p) { p.completedImplementationRunIds = wf.progress.completedImplementationRunIds; p.completedReviewIds = wf.progress.completedReviewIds; }
    } else { row.remainingLaunches = record.policy?.maxLaunchesPerTask; row.remainingRework = record.policy?.maxReworkIterations; }
  }
  view.queueGate = queueGateFor(record);
  return view;
}

function queueGateFor(record: OrchestratedBatchRecord) {
  const gated = isGatedPolicy(record.policy);
  const activeId = record.progress.activeTaskId;
  const prog = activeId ? record.progress.byTask[activeId] : null;
  const plan = record.tasks.find((item) => item.taskId === activeId) ?? null;
  const next = nextQueuedTask(record);
  const grant = next ? record.phaseGrants?.find((item) => item.taskId === next.taskId && item.phase === "developer" && item.status === "active" && Date.now() < item.expiresAt) : null;
  const workspaceReady = !record.policy?.requireTaskWorkspace || !next || getTaskWorkspace(next.taskId)?.status === "armed";
  return buildQueueGateView({
    gated,
    batchStatus: record.status,
    pauseReason: record.progress.pauseReason,
    waitReason: record.progress.waitReason ?? prog?.waitReason ?? null,
    activeTaskId: activeId,
    activePhase: prog?.phase ?? null,
    failureClass: prog?.failureClass ?? null,
    lastCompletedStep: prog?.lastCompletedStep ?? null,
    developer: plan ? `${plan.implementerEmployeeId} · ${plan.implementerHarnessId} · ${plan.implementerModel}` : null,
    reviewer: plan ? `${plan.reviewerHarness} · ${plan.reviewerModel}` : null,
    nextAuthorization: prog?.waitReason ?? record.progress.waitReason ?? null,
    nextAuthorizationPhase: prog?.authorizationPhase ?? null,
    nextTaskId: next?.taskId ?? null,
    nextTaskEligible: gated && record.status === "running" && !!next && !!grant && workspaceReady && !earlierOpen(record, next.order),
  });
}

function earlierOpen(record: OrchestratedBatchRecord, order: number): boolean {
  if (record.policy?.completionGate !== "owner-done") return false;
  return record.tasks.some((plan) => plan.order < order && record.progress.byTask[plan.taskId]?.ownerAccepted !== true && record.progress.byTask[plan.taskId]?.phase !== "skipped");
}

function claimGrantOn(record: OrchestratedBatchRecord, grantId: string, now = Date.now()): boolean {
  const grant = record.phaseGrants?.find((item) => item.id === grantId);
  if (!grant) return false;
  if (grant.status === "claimed" || grant.status === "prelaunch-failed" || grant.status === "consumed") return false;
  if (grant.status === "active" && now >= grant.expiresAt) {
    grant.status = "expired";
    return false;
  }
  if (grant.status !== "active") return false;
  grant.status = "claimed";
  grant.claimedAt = now;
  grant.claimToken = randomUUID();
  return true;
}

/** Reserves an active grant for one worker. This is not launch consumption. */
export async function claimPhaseGrant(batchId: string, grantId: string): Promise<boolean> {
  return withLock(batchId, async () => {
    const row = db.query<{ data_json: string; status: string }, [string]>(`SELECT data_json, status FROM pm_orchestrated_batches WHERE id = ?`).get(batchId);
    const record = parseRecord(row?.data_json ?? null);
    if (!record || row?.status !== "running") return false;
    record.status = row.status as OrchestratedBatchRecord["status"];
    const grantBefore = record.phaseGrants?.find((item) => item.id === grantId);
    const statusBefore = grantBefore?.status;
    const claimed = claimGrantOn(record, grantId);
    const grant = record.phaseGrants?.find((item) => item.id === grantId);
    if (!claimed) {
      if (statusBefore === "active" && grant?.status === "expired") saveRecord(record);
      return false;
    }
    if (grant?.phase === "developer") setTaskPhase(record, grant.taskId, "implementing");
    if (grant?.phase === "reviewer") setTaskPhase(record, grant.taskId, "reviewing");
    saveRecord(record);
    return true;
  });
}

export async function noteGatedWait(batchId: string, taskId: string, action: {
  reason: string;
  failureClass: string | null;
  authorization: string | null;
  authorizationPhase: OrchestratedBatchTaskProgressPhase | null;
  lastCompletedStep: string | null;
}): Promise<void> {
  await withLock(batchId, async () => {
    const row = db.query<{ data_json: string }, [string]>(`SELECT data_json FROM pm_orchestrated_batches WHERE id = ?`).get(batchId);
    const record = parseRecord(row?.data_json ?? null);
    if (!record || record.status !== "running") return;
    record.progress.waitReason = action.authorization ?? action.reason;
    const prog = record.progress.byTask[taskId];
    if (prog) {
      prog.waitReason = action.reason;
      prog.failureClass = action.failureClass;
      prog.lastCompletedStep = action.lastCompletedStep;
      prog.authorizationPhase = action.authorizationPhase;
    }
    saveRecord(record);
  });
}

type OrchestratedBatchTaskProgressPhase = NonNullable<OrchestratedBatchRecord["progress"]["byTask"][string]["authorizationPhase"]>;

function assertReadyTask(task: Task, projectPath: string): void {
  if (!taskInProject(task, projectPath, { fresh: true })) throw new OrchestratedBatchError("Task not in this project.", 404, "not-found");
  if (task.archivedAt != null) throw new OrchestratedBatchError("Archived tasks cannot join a batch.", 409, "archived");
  if (task.column === "backlog" || task.column === "inbox") {
    throw new OrchestratedBatchError(columnBlockReason(task.column) ?? "Only Ready tasks can be scheduled.", 409, "wrong-column");
  }
  if (task.column !== "ready") {
    throw new OrchestratedBatchError(`Task must be in Ready (currently ${task.column}).`, 409, "wrong-column");
  }
}

function resolveTaskBody(
  taskId: string,
  defaults: OrchestratedWorkflowApproveBody,
  perTask: Record<string, Partial<OrchestratedWorkflowApproveBody>> | undefined,
): OrchestratedWorkflowApproveBody {
  const extra = perTask?.[taskId] ?? {};
  return { ...defaults, ...extra, implementerEmployeeId: extra.implementerEmployeeId ?? defaults.implementerEmployeeId };
}

const chains = new Map<string, Promise<void>>();

function withLock<T>(id: string, fn: () => Promise<T>): Promise<T> {
  const prev = chains.get(id) ?? Promise.resolve();
  const run = prev.then(fn, fn);
  chains.set(id, run.then(() => undefined, () => undefined));
  return run;
}

export function listOrchestratedBatches(projectPath: string): OrchestratedBatchView[] {
  return db.query<{ data_json: string }, [string]>(
    `SELECT data_json FROM pm_orchestrated_batches WHERE project_path = ? ORDER BY updated_at DESC LIMIT 40`,
  ).all(projectPath).map((row) => viewOf(parseRecord(row.data_json)!));
}

export function getOrchestratedBatch(projectPath: string, id: string): OrchestratedBatchView | null {
  const record = load(projectPath, id);
  return record ? viewOf(record) : null;
}

export function createOrchestratedBatchDraft(projectPath: string, body: OrchestratedBatchDraftBody): OrchestratedBatchView {
  if (!Array.isArray(body.taskIds) || body.taskIds.length === 0) throw new OrchestratedBatchError("Pick at least one task.", 400);
  if (body.taskIds.length > ORCHESTRATED_BATCH_LIMITS.maxTasks) throw new OrchestratedBatchError(`At most ${ORCHESTRATED_BATCH_LIMITS.maxTasks} tasks.`, 400);
  const unique = [...new Set(body.taskIds)];
  const resolved: Task[] = [];
  for (const id of unique) {
    const task = tasks.get(id);
    if (!task) throw new OrchestratedBatchError(`Task ${id.slice(0, 8)} not found.`, 404);
    assertReadyTask(task, projectPath);
    resolved.push(task);
  }
  const now = Date.now();
  const title = capText(typeof body.title === "string" ? body.title.trim() : `Bounded batch (${resolved.length} tasks)`, ORCHESTRATED_BATCH_LIMITS.titleChars);
  const record: OrchestratedBatchRecord = {
    id: randomUUID(),
    projectPath,
    title,
    status: "draft",
    revision: 1,
    tasks: resolved.map((task, order) => ({
      taskId: task.id,
      title: task.title,
      order,
      fingerprint: launchFingerprint(task),
      taskUpdatedAt: task.updatedAt,
      implementerEmployeeId: "",
      implementerHarnessId: "claude-code",
      implementerModel: "opus-5.5",
      implementerEffort: null,
      reviewerEmployeeId: null,
      reviewerHarness: "claude-code",
      reviewerModel: "haiku-5.5",
    })),
    policy: null,
    progress: emptyBatchProgress(unique),
    createdAt: now,
    updatedAt: now,
    startedAt: null,
    finishedAt: null,
  };
  saveRecord(record);
  appendEvent(record.id, "draft", `Draft batch with ${resolved.length} task(s).`);
  return viewOf(record);
}

function assertValidOrchestratedApproveQueueFields(defaults: OrchestratedWorkflowApproveBody): void {
  if (defaults.evidencePolicy === null) {
    throw new OrchestratedBatchError("evidencePolicy cannot be null. Omit the field or use a supported value.", 400, "invalid");
  }
  if (defaults.evidencePolicy != null && defaults.evidencePolicy !== "observed-test" && defaults.evidencePolicy !== "review-without-observed-test") {
    throw new OrchestratedBatchError("evidencePolicy must be observed-test, review-without-observed-test, or omitted.", 400, "invalid");
  }
  if (defaults.completionGate === null) {
    throw new OrchestratedBatchError("completionGate cannot be null. Omit the field or use a supported value.", 400, "invalid");
  }
  if (defaults.completionGate != null && defaults.completionGate !== "owner-done" && defaults.completionGate !== "qc-pass") {
    throw new OrchestratedBatchError("completionGate must be owner-done, qc-pass, or omitted.", 400, "invalid");
  }
  if (defaults.requireTaskWorkspace === null) {
    throw new OrchestratedBatchError("requireTaskWorkspace cannot be null. Omit the field or use true or false.", 400, "invalid");
  }
  if (defaults.requireTaskWorkspace != null && typeof defaults.requireTaskWorkspace !== "boolean") {
    throw new OrchestratedBatchError("requireTaskWorkspace must be a boolean or omitted.", 400, "invalid");
  }
}

export async function approveOrchestratedBatch(projectPath: string, id: string, body: OrchestratedBatchApproveBody): Promise<OrchestratedBatchView> {
  return withLock(id, async () => {
    const record = load(projectPath, id);
    if (!record) throw new OrchestratedBatchError("Batch not found.", 404);
    if (record.status !== "draft") throw new OrchestratedBatchError(`Batch is ${record.status}, not a draft.`, 409);
    if (body.revision !== record.revision) throw new OrchestratedBatchError("Batch changed since you opened it. Refresh and try again.", 409);
    const defaults = body.defaults;
    if (!defaults?.implementerHarnessId || !defaults.implementerModel || !defaults.reviewerHarness || !defaults.reviewerModel) {
      throw new OrchestratedBatchError("Implementer and reviewer harness/model are required.", 400);
    }
    const legacyQueueSchemaRequested = body.queuePolicySchema === "legacy-auto02";
    const legacyQueueSchemaAllowed = process.env.AGETOR_ALLOW_LEGACY_QUEUE_POLICY_SCHEMA === "1";
    if (legacyQueueSchemaRequested && !legacyQueueSchemaAllowed) {
      throw new OrchestratedBatchError("queuePolicySchema legacy-auto02 is not supported.", 400, "invalid");
    }
    assertValidOrchestratedApproveQueueFields(defaults);
    if (body.taskOrder !== undefined && (!Array.isArray(body.taskOrder) || body.taskOrder.length !== record.tasks.length)) throw new OrchestratedBatchError("taskOrder must list each draft task once.", 400);
    const order = Array.isArray(body.taskOrder) && body.taskOrder.length === record.tasks.length
      ? body.taskOrder
      : record.tasks.map((t) => t.taskId);
    if (new Set(order).size !== order.length) throw new OrchestratedBatchError("taskOrder must list each task once.", 400);
    const now = Date.now();
    const planRevision = record.revision + 1;
    if (order.some(taskId => !record.tasks.some(p => p.taskId === taskId))) throw new OrchestratedBatchError("taskOrder must contain exactly the draft task IDs.", 400);
    const plans = order.map((taskId, index) => {
      const task = tasks.get(taskId);
      if (!task) throw new OrchestratedBatchError(`Task ${taskId.slice(0, 8)} missing.`, 404);
      assertReadyTask(task, projectPath);
      const merged = resolveTaskBody(taskId, defaults, body.perTask);
      const implementerId = merged.implementerEmployeeId?.trim();
      if (!implementerId) throw new OrchestratedBatchError(`Assign an implementer for “${task.title}”.`, 409);
      if (!harnesses.getByIdOrKind(merged.implementerHarnessId)) throw new OrchestratedBatchError(`Unknown harness for “${task.title}”.`, 400);
      const assignment = new AssignmentCore(db).forTask(taskId);
      if (!assignment || assignment.employeeId !== implementerId) {
        throw new OrchestratedBatchError(`Implementer must be assigned to “${task.title}”.`, 409);
      }
      let execution;
      try { execution = freezeWorkflowExecution(task, merged); }
      catch (e) { throw new OrchestratedBatchError((e as Error).message, 409); }
      const approvedTask = { ...task, agent: merged.implementerHarnessId, model: merged.implementerModel, mode: execution.implementerMode, effort: merged.implementerEffort ?? task.effort };
      return { ...taskPlanFromTask(approvedTask, index, merged), execution };
    });
    record.tasks = plans;
    record.policy = legacyQueueSchemaRequested && legacyQueueSchemaAllowed
      ? batchPolicyFromApproveLegacy(body, now, planRevision)
      : batchPolicyFromApprove(body, now, planRevision);
    record.phaseGrants = [];
    record.progress = emptyBatchProgress(plans.map((p) => p.taskId));
    record.status = "approved";
    record.revision = planRevision;
    db.transaction(() => {
      for (const plan of plans) tasks.update(plan.taskId, { agent: plan.implementerHarnessId, model: plan.implementerModel, mode: plan.execution!.implementerMode, effort: plan.implementerEffort });
      // Fingerprints include all execution inputs after the explicit Owner resource selection.
      for (const plan of plans) plan.fingerprint = launchFingerprint(tasks.get(plan.taskId)!);
      saveRecord(record, now);
    }).immediate();
    appendEvent(record.id, "approved", `Approved ${plans.length} task(s) for bounded execution.`);
    journal(record, "autonomy.grant.approved", {
      maxRuns: record.policy!.maxLaunchesPerTask,
      maxParallelism: 1,
      expiresAt: record.policy!.expiresAt ?? 0,
      unknownQuotaAcknowledged: 0,
    }, "approved", now);
    return viewOf(record);
  });
}

export async function startOrchestratedBatch(projectPath: string, id: string, authority?: HeadBatchAuthority): Promise<OrchestratedBatchView> {
  const view = await withLock(id, async () => {
    const record = load(projectPath, id);
    if (!record) throw new OrchestratedBatchError("Batch not found.", 404);
    const gate = headBatchBlock(id, authority, true);
    if (gate) throw new OrchestratedBatchError(gate, 409);
    if (record.status === "running") return viewOf(record);
    if (record.status !== "approved") throw new OrchestratedBatchError(`Batch is ${record.status}. Approve it first.`, 409);
    const lifecycle = checkProjectLaunchAdmission(projectPath);
    if (!lifecycle.allowed) throw new OrchestratedBatchError(lifecycle.reason!, 409, "project-paused");
    if (record.policy && record.policy.expiresAt != null && Date.now() >= record.policy.expiresAt) {
      record.status = "stopped";
      record.progress.pauseReason = "Grant expired before start.";
      saveRecord(record);
      throw new OrchestratedBatchError("Grant expired.", 409, "expired");
    }
    for (const plan of record.tasks) {
      const task = tasks.get(plan.taskId);
      if (!task || launchFingerprint(task) !== plan.fingerprint) {
        throw new OrchestratedBatchError(`“${plan.title}” changed since approval. Cancel and prepare a new batch.`, 409, "stale");
      }
      assertReadyTask(task!, projectPath);
    }
    const now = Date.now();
    record.status = "running";
    record.startedAt = now;
    saveRecord(record, now);
    appendEvent(record.id, "started", "Batch started.");
    journal(record, "autonomy.execution.started", {
      batchId: record.id,
      grantId: record.id,
      taskIds: record.tasks.map((t) => t.taskId),
      maxRuns: record.policy!.maxLaunchesPerTask,
      expiresAt: record.policy!.expiresAt ?? 0,
      coordinationId: authority?.coordinationId ?? null,
    }, "started", now, !!authority);
    return viewOf(record);
  });
  await tickOrchestratedBatch(id);
  return viewOf(load(projectPath, id)!);
}

export function pauseOrchestratedBatch(projectPath: string, id: string, reason = "Paused by the owner."): Promise<OrchestratedBatchView> {
  return withLock(id, async () => {
    const record = load(projectPath, id);
    if (!record) throw new OrchestratedBatchError("Batch not found.", 404);
    if (record.status !== "running" && record.status !== "approved") throw new OrchestratedBatchError(`Cannot pause a ${record.status} batch.`, 409);
    record.status = "paused";
    record.progress.pauseReason = reason;
    saveRecord(record);
    appendEvent(record.id, "paused", reason);
    return viewOf(record);
  });
}

export async function resumeOrchestratedBatch(projectPath: string, id: string, authority?: HeadBatchAuthority): Promise<OrchestratedBatchView> {
  await withLock(id, async () => {
    const record = load(projectPath, id);
    if (!record) throw new OrchestratedBatchError("Batch not found.", 404);
    const gate = headBatchBlock(id, authority, true);
    if (gate) throw new OrchestratedBatchError(gate, 409);
    if (record.status !== "paused") throw new OrchestratedBatchError("Only a paused batch can be resumed.", 409);
    const lifecycle = checkProjectLaunchAdmission(projectPath);
    if (!lifecycle.allowed) throw new OrchestratedBatchError(lifecycle.reason!, 409, "project-paused");
    const active = record.progress.activeTaskId ? getWorkflowForTask(record.progress.activeTaskId) : null;
    if (active?.status === "active") {
      const unresolved = db.query<{ id: string }, [string]>(
        `SELECT id FROM task_quality_reviews WHERE task_id = ? AND status = 'complete' AND verdict IS NULL AND review_run_id IS NOT NULL LIMIT 1`,
      ).get(active.taskId);
      if (unresolved) {
        const { recoveryCoversUnresolvedReview } = await import("./pm-provider-recovery.ts");
        if (!recoveryCoversUnresolvedReview(active.taskId, unresolved.id)) {
          throw new OrchestratedBatchError("The active task has a finished Reviewer run with no QC verdict. Reconcile that review before resuming. Resume does not start another task.", 409);
        }
      }
    }
    if (active && active.status !== "active" && active.status !== "awaiting_owner") {
      throw new OrchestratedBatchError(active.progress.pauseReason ?? "The task grant is stopped; new Owner approval is required.", 409);
    }
    if (record.policy?.expiresAt != null && Date.now() >= record.policy.expiresAt) {
      record.status = "stopped";
      record.progress.pauseReason = "Grant expired.";
      saveRecord(record);
      throw new OrchestratedBatchError("Grant expired.", 409, "expired");
    }
    record.status = "running";
    record.progress.pauseReason = null;
    saveRecord(record);
    appendEvent(record.id, "resumed", "Batch resumed.");
  });
  await tickOrchestratedBatch(id);
  return viewOf(load(projectPath, id)!);
}

export function cancelOrchestratedBatch(projectPath: string, id: string): Promise<OrchestratedBatchView> {
  return withLock(id, async () => {
    const record = load(projectPath, id);
    if (!record) throw new OrchestratedBatchError("Batch not found.", 404);
    for (const plan of record.tasks) {
      const wf = getWorkflowForTask(plan.taskId);
      captureWorkflowProgress(record, plan.taskId);
      if (wf?.grant.orchestratedBatchId === id && wf.status !== "awaiting_owner") cancelOrchestratedWorkflow(plan.taskId);
    }
    record.status = "cancelled";
    record.progress.pauseReason = "Cancelled by the owner.";
    record.finishedAt = Date.now();
    saveRecord(record);
    appendEvent(record.id, "cancelled", "Batch cancelled.");
    return viewOf(record);
  });
}

function captureWorkflowProgress(record: OrchestratedBatchRecord, taskId: string): void {
  const wf = getWorkflowForTask(taskId), progress = record.progress.byTask[taskId];
  if (!progress || wf?.grant.orchestratedBatchId !== record.id) return;
  progress.completedImplementationRunIds = wf.progress.completedImplementationRunIds;
  progress.completedReviewIds = wf.progress.completedReviewIds;
  progress.launchedRuns = wf.progress.launchedRuns;
}

function setTaskPhase(record: OrchestratedBatchRecord, taskId: string, phase: OrchestratedBatchTaskPhase, pauseReason: string | null = null): void {
  const prog = record.progress.byTask[taskId];
  if (!prog) return;
  captureWorkflowProgress(record, taskId);
  prog.phase = phase;
  prog.pauseReason = pauseReason;
}

function pauseBatch(record: OrchestratedBatchRecord, reason: string, status: OrchestratedBatchStatus = "paused"): OrchestratedBatchRecord {
  record.status = status;
  record.progress.pauseReason = reason;
  record.updatedAt = Date.now();
  appendEvent(record.id, "paused", reason);
  return saveRecord(record);
}

function nextQueuedTask(record: OrchestratedBatchRecord): typeof record.tasks[0] | null {
  const ordered = [...record.tasks].sort((a, b) => a.order - b.order);
  for (const plan of ordered) {
    const phase = record.progress.byTask[plan.taskId]?.phase ?? "queued";
    if (phase !== "queued") continue;
    if (earlierOpen(record, plan.order)) return null;
    return plan;
  }
  return null;
}

function allTasksHandled(record: OrchestratedBatchRecord): boolean {
  if (record.policy?.completionGate === "owner-done") {
    return record.tasks.every((plan) => {
      const prog = record.progress.byTask[plan.taskId];
      return prog?.ownerAccepted === true || prog?.phase === "skipped";
    });
  }
  return record.tasks.every((plan) => {
    const phase = record.progress.byTask[plan.taskId]?.phase;
    return phase === "awaiting_owner" || phase === "skipped";
  });
}

export async function tickOrchestratedBatch(id: string): Promise<void> {
  await withLock(id, async () => {
    const row = db.query<{ project_path: string; data_json: string }, [string]>(`SELECT project_path, data_json FROM pm_orchestrated_batches WHERE id = ?`).get(id);
    if (!row) return;
    const record = parseRecord(row.data_json);
    if (!record || record.status !== "running") return;
    const gate = headBatchBlock(id);
    if (gate) { pauseBatch(record, gate); return; }
    if (record.policy?.expiresAt != null && Date.now() >= record.policy.expiresAt) {
      pauseBatch(record, "Grant expired.", "stopped");
      return;
    }
    if (allTasksHandled(record)) {
      record.status = "completed";
      record.finishedAt = Date.now();
      record.progress.activeTaskId = null;
      saveRecord(record);
      appendEvent(record.id, "completed", record.policy?.completionGate === "owner-done"
        ? "All tasks were accepted by the Owner."
        : "All tasks reached quality review; awaiting owner acceptance per task.");
      return;
    }

    const activeId = record.progress.activeTaskId;
    if (activeId) {
      const wf = getWorkflowForTask(activeId);
      const phase = record.progress.byTask[activeId]?.phase;
      if (wf?.status === "paused" || wf?.status === "exhausted" || wf?.status === "expired") {
        setTaskPhase(record, activeId, "paused", wf.progress.pauseReason);
        const prog = record.progress.byTask[activeId];
        if (prog) prog.failureClass = wf.progress.failureClass ?? prog.failureClass ?? null;
        pauseBatch(record, wf.progress.pauseReason ?? "Orchestrated step paused.");
        return;
      }
      if (wf?.status === "awaiting_owner" || phase === "awaiting_owner") {
        if (record.policy?.completionGate === "owner-done") {
          const current = tasks.get(activeId);
          if (current?.column === "done" && current.qcState?.latestVerdict === "PASS") {
            const prog = record.progress.byTask[activeId];
            if (prog) prog.ownerAccepted = true;
            record.progress.activeTaskId = null;
            record.progress.waitReason = null;
            saveRecord(record);
          } else {
            record.progress.waitReason = "Quality review passed. Mark the task Done before the next task can start.";
            const prog = record.progress.byTask[activeId];
            if (prog) {
              prog.waitReason = record.progress.waitReason;
              prog.authorizationPhase = "owner-done";
              prog.lastCompletedStep = prog.lastCompletedStep ?? "QC PASS";
              prog.failureClass = null;
            }
            saveRecord(record);
            return;
          }
        } else {
          record.progress.activeTaskId = null;
          saveRecord(record);
          void tickOrchestratedBatch(id);
          return;
        }
      } else if (wf?.status === "active") { void scheduleOrchestratedTick(wf.id); return; }
    }

    const plan = nextQueuedTask(record);
    if (!plan) return;
    const lifecycle = checkProjectLaunchAdmission(record.projectPath);
    if (!lifecycle.allowed) {
      pauseBatch(record, lifecycle.reason!);
      return;
    }

    const task = tasks.get(plan.taskId);
    if (!task || launchFingerprint(task) !== plan.fingerprint) {
      pauseBatch(record, `“${plan.title}” changed since approval.`);
      return;
    }
    const availability = taskAvailabilityFor(task, taskAvailabilityNow());
    if (!availability.available) {
      record.progress.waitReason = "Waiting for scheduled time.";
      const prog = record.progress.byTask[plan.taskId];
      if (prog) prog.waitReason = record.progress.waitReason;
      saveRecord(record);
      scheduleOrchestratedBatchWake(record.id, availability.availableFromMs);
      return;
    }
    try {
      assertReadyTask(task, record.projectPath);
    } catch (e) {
      pauseBatch(record, e instanceof OrchestratedBatchError ? e.message : "Task not executable.");
      return;
    }

    record.progress.activeTaskId = plan.taskId;
    if (!isGatedPolicy(record.policy)) setTaskPhase(record, plan.taskId, "implementing");
    saveRecord(record);

    const grant = grantForBatchTask(record, plan);
    try {
      const wf = await bootstrapOrchestratedWorkflowForBatch(grant);
      record.progress.byTask[plan.taskId]!.workflowId = wf.id;
      saveRecord(record);
      void scheduleOrchestratedTick(wf.id);
    } catch (e) {
      const msg = e instanceof OrchestratedWorkflowError ? e.message : "Could not start orchestrated step.";
      setTaskPhase(record, plan.taskId, "paused", msg);
      pauseBatch(record, msg);
    }
  });
}

/** Called from FO-AUTO01 when QC settles PASS on a batch-owned task. */
export async function onBatchTaskAwaitingOwner(batchId: string, taskId: string): Promise<void> {
  let advance = true;
  await withLock(batchId, async () => {
    const row = db.query<{ data_json: string }, [string]>(`SELECT data_json FROM pm_orchestrated_batches WHERE id = ?`).get(batchId);
    const record = parseRecord(row?.data_json ?? null);
    if (!record || record.status === "cancelled" || record.status === "stopped") { advance = false; return; }
    setTaskPhase(record, taskId, "awaiting_owner");
    if (record.policy?.completionGate === "owner-done") {
      advance = false;
      record.progress.activeTaskId = taskId;
      record.progress.waitReason = "Quality review passed. Mark the task Done before the next task can start.";
      const prog = record.progress.byTask[taskId];
      if (prog) {
        prog.waitReason = record.progress.waitReason;
        prog.authorizationPhase = "owner-done";
        prog.lastCompletedStep = "QC PASS";
        prog.failureClass = null;
      }
      saveRecord(record);
    } else {
      record.progress.activeTaskId = null;
      saveRecord(record);
    }
    appendEvent(batchId, "task-awaiting-owner", `“${tasks.get(taskId)?.title ?? taskId.slice(0, 8)}” passed review.`, taskId);
  });
  if (advance) void tickOrchestratedBatch(batchId);
}

/** Owner Done on a gated task. Does not invent a grant for the next task. */
export async function onOrchestratedOwnerDone(taskId: string): Promise<void> {
  const wf = getWorkflowForTask(taskId);
  const batchId = wf?.grant.orchestratedBatchId;
  if (!batchId || wf?.grant.completionGate !== "owner-done") return;
  const task = tasks.get(taskId);
  if (task?.column !== "done" || task.qcState?.latestVerdict !== "PASS") return;
  await withLock(batchId, async () => {
    const row = db.query<{ data_json: string }, [string]>(`SELECT data_json FROM pm_orchestrated_batches WHERE id = ?`).get(batchId);
    const record = parseRecord(row?.data_json ?? null);
    if (!record || record.status === "cancelled" || record.status === "stopped" || record.status === "completed") return;
    const prog = record.progress.byTask[taskId];
    if (prog?.ownerAccepted) return;
    if (prog) prog.ownerAccepted = true;
    if (record.progress.activeTaskId === taskId) record.progress.activeTaskId = null;
    record.progress.waitReason = null;
    saveRecord(record);
    appendEvent(batchId, "owner-done", `“${task.title}” was accepted.`, taskId);
  });
  await tickOrchestratedBatch(batchId);
}

export async function approvePhaseGrant(projectPath: string, id: string, body: { taskId?: unknown; phase?: unknown; implementationRunId?: unknown; harnessId?: unknown; validMinutes?: unknown }): Promise<OrchestratedBatchView> {
  const view = await withLock(id, async () => {
    const record = load(projectPath, id);
    if (!record) throw new OrchestratedBatchError("Batch not found.", 404);
    if (!isGatedPolicy(record.policy)) throw new OrchestratedBatchError("This batch does not use separate phase authorizations.", 409, "policy");
    if (record.status !== "approved" && record.status !== "running" && record.status !== "paused") {
      throw new OrchestratedBatchError(`Cannot authorize a step while the batch is ${record.status}.`, 409);
    }
    const taskId = typeof body.taskId === "string" ? body.taskId : "";
    const phase = body.phase === "developer" || body.phase === "reviewer" ? body.phase : null;
    if (!phase) throw new OrchestratedBatchError("phase must be developer or reviewer.", 400, "invalid");
    const plan = record.tasks.find((item) => item.taskId === taskId);
    if (!plan) throw new OrchestratedBatchError("Task is not in this batch.", 404, "not-found");
    const expected = phase === "developer" ? plan.implementerHarnessId : plan.reviewerHarness;
    const harnessId = typeof body.harnessId === "string" && body.harnessId.trim() ? body.harnessId.trim() : expected;
    if (harnessId !== expected) throw new OrchestratedBatchError("The authorization must use the harness frozen for this task. It cannot switch accounts.", 409, "harness");
    let implementationRunId: string | null = null;
    if (phase === "reviewer") {
      if (typeof body.implementationRunId !== "string" || !body.implementationRunId) {
        throw new OrchestratedBatchError("Reviewer authorization must name the implementation run.", 400, "invalid");
      }
      implementationRunId = body.implementationRunId;
      const wf = getWorkflowForTask(taskId);
      if (!wf || wf.grant.orchestratedBatchId !== record.id || !wf.progress.completedImplementationRunIds.includes(implementationRunId)) {
        throw new OrchestratedBatchError("That run is not this task's settled implementation.", 409, "run");
      }
    }
    const existing = (record.phaseGrants ?? []).filter((grant) => grant.taskId === taskId && grant.phase === phase && (phase === "developer" || grant.implementationRunId === implementationRunId));
    if (existing.some((grant) => grant.status === "active" && Date.now() < grant.expiresAt)) {
      throw new OrchestratedBatchError("An authorization for this step is already active.", 409, "active");
    }
    if (existing.some((grant) => grant.status === "claimed")) {
      throw new OrchestratedBatchError("An authorization for this step is already claimed.", 409, "claimed");
    }
    if (existing.some((grant) => grant.status === "prelaunch-failed")) {
      throw new OrchestratedBatchError("This step failed before launch. Owner intervention is required before another attempt.", 409, "prelaunch-failed");
    }
    if (existing.some((grant) => grant.status === "consumed")) {
      throw new OrchestratedBatchError("A consumed authorization cannot be renewed.", 409, "consumed");
    }
    const minutes = typeof body.validMinutes === "number" && Number.isFinite(body.validMinutes)
      ? Math.min(24 * 60, Math.max(5, Math.trunc(body.validMinutes)))
      : 240;
    const now = Date.now();
    const grant: QueuePhaseGrant = {
      id: randomUUID(), taskId, phase, implementationRunId, harnessId, status: "active",
      expiresAt: now + minutes * 60_000, approvedAt: now, consumedRunId: null,
    };
    record.phaseGrants = [...(record.phaseGrants ?? []), grant];
    saveRecord(record, now);
    appendEvent(record.id, "phase-grant", `${phase} authorized for ${plan.title}.`, taskId);
    return viewOf(record);
  });
  if (view.batch.status === "running") await tickOrchestratedBatch(id);
  return view;
}

/** Mints one recovery-bound Reviewer phase grant; does not launch a process. */
export async function approveRecoveryPhaseGrant(
  projectPath: string,
  id: string,
  body: {
    taskId: string;
    implementationRunId: string;
    recoveryAuthorizationId: string;
    harnessId: string;
    validMinutes?: number;
  },
): Promise<{ phaseGrantId: string }> {
  return withLock(id, async () => {
    const record = load(projectPath, id);
    if (!record) throw new OrchestratedBatchError("Batch not found.", 404);
    if (!isGatedPolicy(record.policy)) throw new OrchestratedBatchError("This batch does not use separate phase authorizations.", 409, "policy");
    if (record.status !== "paused" && record.status !== "running") {
      throw new OrchestratedBatchError(`Cannot authorize a step while the batch is ${record.status}.`, 409);
    }
    const plan = record.tasks.find((item) => item.taskId === body.taskId);
    if (!plan) throw new OrchestratedBatchError("Task is not in this batch.", 404, "not-found");
    if (body.harnessId !== plan.reviewerHarness) {
      throw new OrchestratedBatchError("The authorization must use the harness frozen for this task.", 409, "harness");
    }
    const wf = getWorkflowForTask(body.taskId);
    if (!wf || wf.grant.orchestratedBatchId !== record.id || !wf.progress.completedImplementationRunIds.includes(body.implementationRunId)) {
      throw new OrchestratedBatchError("That run is not this task's settled implementation.", 409, "run");
    }
    const { getProviderRecovery } = await import("./pm-provider-recovery.ts");
    const recovery = getProviderRecovery(body.recoveryAuthorizationId);
    if (!recovery || recovery.batchId !== record.id || recovery.taskId !== body.taskId) {
      throw new OrchestratedBatchError("Recovery authorization not found for this task.", 404, "not-found");
    }
    if (recovery.status !== "applied") throw new OrchestratedBatchError("Apply the recovery authorization before minting a phase grant.", 409, "not-applied");
    if (recovery.recoveryPhaseGrantId) throw new OrchestratedBatchError("A recovery phase grant already exists.", 409, "duplicate");
    if (recovery.developerRunId !== body.implementationRunId) {
      throw new OrchestratedBatchError("Recovery authorization is bound to a different implementation run.", 409, "run");
    }
    const existing = (record.phaseGrants ?? []).filter((grant) =>
      grant.taskId === body.taskId
      && grant.phase === "reviewer"
      && grant.implementationRunId === body.implementationRunId
      && grant.status === "active"
      && Date.now() < grant.expiresAt,
    );
    if (existing.length > 0) throw new OrchestratedBatchError("An authorization for this step is already active.", 409, "active");
    const minutes = typeof body.validMinutes === "number" && Number.isFinite(body.validMinutes)
      ? Math.min(24 * 60, Math.max(5, Math.trunc(body.validMinutes)))
      : 240;
    const now = Date.now();
    const grant: QueuePhaseGrant = {
      id: randomUUID(),
      taskId: body.taskId,
      phase: "reviewer",
      implementationRunId: body.implementationRunId,
      harnessId: body.harnessId,
      status: "active",
      expiresAt: now + minutes * 60_000,
      approvedAt: now,
      consumedRunId: null,
      recoveryAuthorizationId: body.recoveryAuthorizationId,
    };
    record.phaseGrants = [...(record.phaseGrants ?? []), grant];
    saveRecord(record, now);
    appendEvent(record.id, "phase-grant", `Supplemental reviewer authorized for ${plan.title}.`, body.taskId);
    return { phaseGrantId: grant.id };
  });
}

/**
 * One replacement Reviewer grant for a verified pre-launch failure.
 * The failed grant stays in place. This does not launch a process.
 */
export async function approveReplacementRecoveryPhaseGrant(
  projectPath: string,
  id: string,
  body: {
    taskId: string;
    implementationRunId: string;
    recoveryAuthorizationId: string;
    reauthorizationId: string;
    replacesGrantId: string;
    harnessId: string;
    expiresAt: number;
  },
): Promise<{ phaseGrantId: string }> {
  return withLock(id, async () => {
    const record = load(projectPath, id);
    if (!record) throw new OrchestratedBatchError("Batch not found.", 404);
    if (!isGatedPolicy(record.policy)) throw new OrchestratedBatchError("This batch does not use separate phase authorizations.", 409, "policy");
    if (record.status !== "paused" && record.status !== "running") {
      throw new OrchestratedBatchError(`Cannot authorize a step while the batch is ${record.status}.`, 409);
    }
    if (record.policy?.expiresAt != null && Date.now() >= record.policy.expiresAt) {
      throw new OrchestratedBatchError("The batch grant has expired. Recovery does not extend it.", 409, "expired");
    }
    const plan = record.tasks.find((item) => item.taskId === body.taskId);
    if (!plan) throw new OrchestratedBatchError("Task is not in this batch.", 404, "not-found");
    if (body.harnessId !== plan.reviewerHarness) {
      throw new OrchestratedBatchError("The authorization must use the harness frozen for this task.", 409, "harness");
    }
    const bound = (record.phaseGrants ?? []).filter((grant) => grant.recoveryAuthorizationId === body.recoveryAuthorizationId);
    if (bound.some((grant) => grant.consumedRunId)) {
      throw new OrchestratedBatchError("A supplemental Reviewer launch was already recorded.", 409, "consumed");
    }
    if (bound.some((grant) => grant.reauthorizationId === body.reauthorizationId || grant.replacesGrantId === body.replacesGrantId)) {
      throw new OrchestratedBatchError("A replacement Reviewer authorization already exists.", 409, "duplicate");
    }
    const failed = bound.find((grant) => grant.id === body.replacesGrantId);
    if (!failed) throw new OrchestratedBatchError("The failed pre-launch grant was not found.", 404, "not-found");
    if (failed.implementationRunId !== body.implementationRunId) {
      throw new OrchestratedBatchError("Replacement authorization is bound to a different implementation run.", 409, "run");
    }
    const now = Date.now();
    if (body.expiresAt <= now) throw new OrchestratedBatchError("Pre-launch reauthorization expired.", 409, "expired");
    const grant: QueuePhaseGrant = {
      id: randomUUID(),
      taskId: body.taskId,
      phase: "reviewer",
      implementationRunId: body.implementationRunId,
      harnessId: body.harnessId,
      status: "active",
      expiresAt: body.expiresAt,
      approvedAt: now,
      consumedRunId: null,
      recoveryAuthorizationId: body.recoveryAuthorizationId,
      replacesGrantId: body.replacesGrantId,
      reauthorizationId: body.reauthorizationId,
    };
    record.phaseGrants = [...(record.phaseGrants ?? []), grant];
    saveRecord(record, now);
    appendEvent(record.id, "phase-grant", `Replacement reviewer authorized for ${plan.title}.`, body.taskId);
    return { phaseGrantId: grant.id };
  });
}

export async function onBatchWorkflowPaused(batchId: string, taskId: string, reason: string): Promise<void> {
  await withLock(batchId, async () => {
    const row = db.query<{ data_json: string }, [string]>(`SELECT data_json FROM pm_orchestrated_batches WHERE id = ?`).get(batchId);
    const record = parseRecord(row?.data_json ?? null);
    if (!record || record.status === "cancelled" || record.status === "stopped") return;
    setTaskPhase(record, taskId, "paused", reason);
    const prog = record.progress.byTask[taskId];
    if (prog) prog.failureClass = getWorkflowForTask(taskId)?.progress.failureClass ?? prog.failureClass ?? null;
    pauseBatch(record, reason);
  });
}

export function listOrchestratedBatchHolds(): { projectPath: string; id: string; title: string; status: string; reason: string | null }[] {
  return db.query<{ data_json: string }, []>(
    `SELECT data_json FROM pm_orchestrated_batches WHERE status IN ('paused', 'approved', 'stopped') ORDER BY updated_at DESC LIMIT 30`,
  ).all().map((row) => {
    const record = parseRecord(row.data_json)!;
    return {
      projectPath: record.projectPath,
      id: record.id,
      title: record.title,
      status: record.status,
      reason: record.progress.pauseReason,
    };
  });
}

export function recoverOrchestratedBatches(): void {
  const rows = db.query<{ id: string; project_path: string }, []>(
    `SELECT id, project_path FROM pm_orchestrated_batches WHERE status = 'running'`,
  ).all();
  for (const row of rows) {
    if (!checkProjectLaunchAdmission(row.project_path).allowed) continue;
    void tickOrchestratedBatch(row.id);
  }
}

const orchestratedBatchWakeTimers = new Map<string, ReturnType<typeof setTimeout>>();

function scheduleOrchestratedBatchWake(batchId: string, untilMs: number | null): void {
  const existing = orchestratedBatchWakeTimers.get(batchId);
  if (existing) {
    clearTimeout(existing);
    orchestratedBatchWakeTimers.delete(batchId);
  }
  if (untilMs == null || !Number.isFinite(untilMs)) return;
  const now = taskAvailabilityNow();
  const delay = Math.min(60_000, Math.max(50, untilMs - now));
  const timer = setTimeout(() => {
    orchestratedBatchWakeTimers.delete(batchId);
    void tickOrchestratedBatch(batchId);
  }, delay);
  timer.unref?.();
  orchestratedBatchWakeTimers.set(batchId, timer);
}

let orchestratedBatchesInit = false;
export function initOrchestratedBatches(): void {
  if (orchestratedBatchesInit) return;
  orchestratedBatchesInit = true;
  onTaskAvailabilityChange((taskId) => {
    const rows = db.query<{ id: string; data_json: string }, []>(
      `SELECT id, data_json FROM pm_orchestrated_batches WHERE status = 'running'`,
    ).all();
    for (const row of rows) {
      const record = parseRecord(row.data_json);
      if (record?.tasks.some((item) => item.taskId === taskId)) {
        void tickOrchestratedBatch(row.id);
      }
    }
  });
}

export function buildPmOrchestratedBatchContext(projectPath: string): { id: string; title: string; status: string; activeTaskTitle: string | null; queued: number; awaitingOwner: number }[] {
  return db.query<{ data_json: string }, [string]>(
    `SELECT data_json FROM pm_orchestrated_batches WHERE project_path = ? AND status IN ('running', 'paused', 'approved') ORDER BY updated_at DESC LIMIT 5`,
  ).all(projectPath).map((row) => {
    const record = parseRecord(row.data_json)!;
    const active = record.progress.activeTaskId ? tasks.get(record.progress.activeTaskId)?.title ?? null : null;
    const queued = record.tasks.filter((t) => record.progress.byTask[t.taskId]?.phase === "queued").length;
    const awaitingOwner = record.tasks.filter((t) => record.progress.byTask[t.taskId]?.phase === "awaiting_owner").length;
    return { id: record.id, title: record.title, status: record.status, activeTaskTitle: active, queued, awaitingOwner };
  });
}

export async function managerCreateDraft(rawPath: unknown, body: OrchestratedBatchDraftBody): Promise<BatchResult<OrchestratedBatchView>> {
  const project = registered(rawPath);
  if (!project.ok) return project;
  try {
    return { ok: true, value: createOrchestratedBatchDraft(project.value, body) };
  } catch (e) {
    const msg = e instanceof OrchestratedBatchError ? e.message : String(e);
    return fail(e instanceof OrchestratedBatchError ? e.status : 400, msg);
  }
}

export async function managerApprove(rawPath: unknown, id: string, body: OrchestratedBatchApproveBody): Promise<BatchResult<OrchestratedBatchView>> {
  const project = registered(rawPath);
  if (!project.ok) return project;
  try {
    return { ok: true, value: await approveOrchestratedBatch(project.value, id, body) };
  } catch (e) {
    return fail(e instanceof OrchestratedBatchError ? e.status : 400, e instanceof Error ? e.message : String(e));
  }
}

export async function managerStart(rawPath: unknown, id: string): Promise<BatchResult<OrchestratedBatchView>> {
  const project = registered(rawPath);
  if (!project.ok) return project;
  try {
    return { ok: true, value: await startOrchestratedBatch(project.value, id) };
  } catch (e) {
    return fail(e instanceof OrchestratedBatchError ? e.status : 400, e instanceof Error ? e.message : String(e));
  }
}

export async function managerPause(rawPath: unknown, id: string): Promise<BatchResult<OrchestratedBatchView>> {
  const project = registered(rawPath);
  if (!project.ok) return project;
  try {
    return { ok: true, value: await pauseOrchestratedBatch(project.value, id) };
  } catch (e) {
    return fail(e instanceof OrchestratedBatchError ? e.status : 400, e instanceof Error ? e.message : String(e));
  }
}

export async function managerResume(rawPath: unknown, id: string): Promise<BatchResult<OrchestratedBatchView>> {
  const project = registered(rawPath);
  if (!project.ok) return project;
  try {
    return { ok: true, value: await resumeOrchestratedBatch(project.value, id) };
  } catch (e) {
    return fail(e instanceof OrchestratedBatchError ? e.status : 400, e instanceof Error ? e.message : String(e));
  }
}

export async function managerPhaseGrant(rawPath: unknown, id: string, body: { taskId?: unknown; phase?: unknown; implementationRunId?: unknown; harnessId?: unknown; validMinutes?: unknown }): Promise<BatchResult<OrchestratedBatchView>> {
  const project = registered(rawPath);
  if (!project.ok) return project;
  try {
    return { ok: true, value: await approvePhaseGrant(project.value, id, body) };
  } catch (e) {
    return fail(e instanceof OrchestratedBatchError ? e.status : 400, e instanceof Error ? e.message : String(e));
  }
}

export async function managerCancel(rawPath: unknown, id: string): Promise<BatchResult<OrchestratedBatchView>> {
  const project = registered(rawPath);
  if (!project.ok) return project;
  try {
    return { ok: true, value: await cancelOrchestratedBatch(project.value, id) };
  } catch (e) {
    return fail(e instanceof OrchestratedBatchError ? e.status : 400, e instanceof Error ? e.message : String(e));
  }
}

export function managerGet(rawPath: unknown, id: string): BatchResult<OrchestratedBatchView> {
  const project = registered(rawPath);
  if (!project.ok) return project;
  const view = getOrchestratedBatch(project.value, id);
  if (!view) return fail(404, "Batch not found.");
  return { ok: true, value: view };
}

export function managerList(rawPath: unknown): BatchResult<OrchestratedBatchView[]> {
  const project = registered(rawPath);
  if (!project.ok) return project;
  return { ok: true, value: listOrchestratedBatches(project.value) };
}
