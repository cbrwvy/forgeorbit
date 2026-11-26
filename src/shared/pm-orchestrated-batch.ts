/**
 * FO-AUTO02 — bounded multi-task PM orchestration (sequential employee + QC).
 * Pure types and read-model helpers; enforcement in `src/bun/pm-orchestrated-batch.ts`.
 */
import type { OrchestratedWorkflowApproveBody } from "./pm-orchestrated-workflow.ts";
import { ORCHESTRATED_WORKFLOW_LIMITS, type OrchestratedWorkflowGrant } from "./pm-orchestrated-workflow.ts";
import type { CompletionGate, EvidencePolicy, QueueGateView } from "./queue-gates.ts";
import { launchFingerprint } from "./task-scheduling.ts";
import type { ApprovedWorkflowExecution } from "./bounded-claude.ts";
import type { Task } from "./types.ts";

/** Batches approved before FO-AUTO03-SAFE-DEFAULT01 store policy without this marker; load path stays legacy. */
export const QUEUE_POLICY_SCHEMA_V1 = 1 as const;

export const SAFE_QUEUE_DEFAULTS = {
  evidencePolicy: "observed-test" as const,
  completionGate: "owner-done" as const,
  requireTaskWorkspace: true as const,
} as const;

export const ORCHESTRATED_BATCH_LIMITS = {
  maxTasks: 50,
  titleChars: 120,
  defaultConcurrency: 1,
  grantBodyBytes: 64 * 1024,
} as const;

export type OrchestratedBatchStatus =
  | "draft"
  | "approved"
  | "running"
  | "paused"
  | "completed"
  | "cancelled"
  | "stopped";

export type OrchestratedBatchTaskPhase =
  | "queued"
  | "implementing"
  | "reviewing"
  | "awaiting_owner"
  | "paused"
  | "skipped"
  | "cancelled";

/** Frozen at approval: one READY task slot in the batch queue. */
export interface OrchestratedBatchTaskPlan {
  taskId: string;
  title: string;
  order: number;
  /** `launchFingerprint` at approval — task edits invalidate the batch. */
  fingerprint: string;
  /** Task `updatedAt` at approval (generation hint). */
  taskUpdatedAt: number;
  implementerEmployeeId: string;
  implementerHarnessId: string;
  implementerModel: string;
  implementerEffort: string | null;
  reviewerEmployeeId: string | null;
  reviewerHarness: string;
  reviewerModel: string;
  execution?: ApprovedWorkflowExecution;
}

/** Owner-approved bounds shared by every task in the batch. */
export interface OrchestratedBatchPolicy {
  autoReviewAfterImplementation: boolean;
  autoReworkOnChanges: boolean;
  maxReworkIterations: number;
  maxLaunchesPerTask: number;
  maxConcurrent: number;
  expiresAt: number | null;
  approvedAt: number;
  approvedBy: "owner";
  planRevision: number;
  /**
   * FO-AUTO03-SAFE-DEFAULT01. Present on new approvals with gated defaults; absent on
   * historical FO-AUTO02 batches (legacy semantics from missing gate fields).
   */
  queuePolicySchemaVersion?: typeof QUEUE_POLICY_SCHEMA_V1;
  /** FO-AUTO03. Absent on batches approved before the evidence gate. */
  evidencePolicy?: EvidencePolicy;
  completionGate?: CompletionGate;
  requireTaskWorkspace?: boolean;
}

/** Durable phase-grant lifecycle. `claimed` is an exclusive reservation, not a completed launch. */
export type QueuePhaseGrantStatus = "active" | "claimed" | "prelaunch-failed" | "consumed" | "expired";

/** Recorded when preparation fails before any Run exists. Not a successful consumption. */
export interface QueuePhaseGrantPrelaunchFailure {
  at: number;
  operation: "bind-implementation" | "prepare-qc-review";
  message: string;
  implementationRunId: string | null;
}

/** One Owner authorization for one executable phase of one task. */
export interface QueuePhaseGrant {
  id: string;
  taskId: string;
  phase: "developer" | "reviewer";
  implementationRunId: string | null;
  harnessId: string;
  status: QueuePhaseGrantStatus;
  expiresAt: number;
  approvedAt: number;
  /** Set only when a Run was actually recorded for this grant. */
  consumedRunId: string | null;
  /** FO-AUTO03-RECOVERY-FIX01: ties a supplemental Reviewer authorization to its Owner recovery grant. */
  recoveryAuthorizationId?: string | null;
  /** Set when a scheduler worker reserves the grant. Cleared only by consumption or pre-launch failure. */
  claimedAt?: number | null;
  claimToken?: string | null;
  prelaunchFailure?: QueuePhaseGrantPrelaunchFailure | null;
  /** Replacement grant minted by an Owner pre-launch reauthorization. The failed grant stays as history. */
  replacesGrantId?: string | null;
  reauthorizationId?: string | null;
}

export interface OrchestratedBatchTaskProgress {
  phase: OrchestratedBatchTaskPhase;
  workflowId: string | null;
  pauseReason: string | null;
  completedImplementationRunIds: string[];
  completedReviewIds: string[];
  launchedRuns?: {runId: string; role: "implementation" | "review"}[];
  /** FO-AUTO03. Set when the Owner has marked this task Done after QC PASS. */
  ownerAccepted?: boolean;
  waitReason?: string | null;
  failureClass?: string | null;
  lastCompletedStep?: string | null;
  /** Phase the gate is waiting for the Owner to authorize. */
  authorizationPhase?: "developer" | "publication" | "test" | "reviewer" | "owner-done" | null;
}

export interface OrchestratedBatchProgress {
  activeTaskId: string | null;
  pauseReason: string | null;
  waitReason?: string | null;
  byTask: Record<string, OrchestratedBatchTaskProgress>;
}

export interface OrchestratedBatchRecord {
  id: string;
  projectPath: string;
  title: string;
  status: OrchestratedBatchStatus;
  revision: number;
  tasks: OrchestratedBatchTaskPlan[];
  policy: OrchestratedBatchPolicy | null;
  progress: OrchestratedBatchProgress;
  createdAt: number;
  updatedAt: number;
  startedAt: number | null;
  finishedAt: number | null;
  /** FO-AUTO03 phase authorizations. Absent on older batches. */
  phaseGrants?: QueuePhaseGrant[];
}

export interface OrchestratedBatchTaskView extends OrchestratedBatchTaskPlan {
  phase: OrchestratedBatchTaskPhase;
  pauseReason: string | null;
  column: string | null;
  remainingLaunches?: number;
  /** Supplemental Owner recovery launches outside the frozen per-task cap. */
  supplementalLaunchesRemaining?: number;
  remainingRework?: number;
  launchedRuns?: {runId: string; role: "implementation" | "review"}[];
}

export interface OrchestratedBatchView {
  batch: OrchestratedBatchRecord;
  tasks: OrchestratedBatchTaskView[];
  remainingLaunchesPerTask: number;
  remainingReworkPerTask: number;
  queuePosition: number;
  queueTotal: number;
  usesFakeDriver: boolean;
  canApprove: boolean;
  canStart: boolean;
  blocker: string | null;
  queueGate?: QueueGateView;
}

export interface OrchestratedBatchDraftBody {
  taskIds: string[];
  title?: string;
}

export interface OrchestratedBatchApproveBody {
  revision: number;
  /** Optional explicit order; must be a permutation of draft task ids. */
  taskOrder?: string[];
  /**
   * Approve defaults. Queue policy (`evidencePolicy`, `completionGate`, `requireTaskWorkspace`):
   * omit or partially set fields — the server fills missing values with
   * `observed-test`, `owner-done`, `true`. Explicit values are honored. `null` and
   * unsupported strings are 400. Persisted policy gets `queuePolicySchemaVersion: 1`
   * unless `queuePolicySchema` requests the legacy path (see below).
   */
  defaults: OrchestratedWorkflowApproveBody;
  perTask?: Record<string, Partial<OrchestratedWorkflowApproveBody>>;
  validMinutes?: number;
  /**
   * Test / automation only. When `"legacy-auto02"` **and** the process sets
   * `AGETOR_ALLOW_LEGACY_QUEUE_POLICY_SCHEMA=1`, approve behaves like FO-AUTO02:
   * gate fields are copied only when set explicitly (no defaults, no schema
   * marker). Production clients must not send this key.
   */
  queuePolicySchema?: "legacy-auto02";
}

export function emptyBatchProgress(taskIds: string[]): OrchestratedBatchProgress {
  const byTask: Record<string, OrchestratedBatchTaskProgress> = {};
  for (const id of taskIds) {
    byTask[id] = {
      phase: "queued",
      workflowId: null,
      pauseReason: null,
      completedImplementationRunIds: [],
      completedReviewIds: [],
    };
  }
  return { activeTaskId: null, pauseReason: null, byTask };
}

export function taskPlanFromTask(
  task: Task,
  order: number,
  body: OrchestratedWorkflowApproveBody,
): OrchestratedBatchTaskPlan {
  return {
    taskId: task.id,
    title: task.title,
    order,
    fingerprint: launchFingerprint(task),
    taskUpdatedAt: task.updatedAt,
    implementerEmployeeId: body.implementerEmployeeId,
    implementerHarnessId: body.implementerHarnessId,
    implementerModel: body.implementerModel,
    implementerEffort: typeof body.implementerEffort === "string" ? body.implementerEffort : null,
    reviewerEmployeeId: typeof body.reviewerEmployeeId === "string" ? body.reviewerEmployeeId : null,
    reviewerHarness: body.reviewerHarness,
    reviewerModel: body.reviewerModel,
  };
}

export function grantForBatchTask(
  batch: OrchestratedBatchRecord,
  plan: OrchestratedBatchTaskPlan,
): OrchestratedWorkflowGrant {
  const p = batch.policy!;
  return {
    taskId: plan.taskId,
    projectPath: batch.projectPath,
    implementerEmployeeId: plan.implementerEmployeeId,
    implementerHarnessId: plan.implementerHarnessId,
    implementerModel: plan.implementerModel,
    implementerEffort: plan.implementerEffort,
    reviewerEmployeeId: plan.reviewerEmployeeId,
    reviewerHarness: plan.reviewerHarness,
    reviewerModel: plan.reviewerModel,
    autoReviewAfterImplementation: p.autoReviewAfterImplementation,
    ...(p.evidencePolicy ? { evidencePolicy: p.evidencePolicy } : {}),
    ...(p.completionGate ? { completionGate: p.completionGate } : {}),
    ...(p.requireTaskWorkspace ? { requireTaskWorkspace: true } : {}),
    autoReworkOnChanges: p.autoReworkOnChanges,
    maxReworkIterations: p.maxReworkIterations,
    maxLaunches: p.maxLaunchesPerTask,
    expiresAt: p.expiresAt,
    approvedAt: p.approvedAt,
    approvedBy: "owner",
    grantEpoch: p.planRevision,
    orchestratedBatchId: batch.id,
    approvedTaskFingerprint: plan.fingerprint,
    execution: plan.execution,
  };
}

/** @internal FO-AUTO02 path: copy defaults without FO-AUTO03 schema marker or safe defaults. */
export function batchPolicyFromApproveLegacy(
  body: OrchestratedBatchApproveBody,
  now: number,
  planRevision: number,
): OrchestratedBatchPolicy {
  const d = body.defaults;
  const validMinutes = typeof body.validMinutes === "number" && Number.isFinite(body.validMinutes)
    ? Math.min(ORCHESTRATED_WORKFLOW_LIMITS.ttlMinutes.max, Math.max(ORCHESTRATED_WORKFLOW_LIMITS.ttlMinutes.min, Math.trunc(body.validMinutes)))
    : ORCHESTRATED_WORKFLOW_LIMITS.ttlMinutes.default;
  const maxLaunches = typeof d.maxLaunches === "number"
    ? Math.min(ORCHESTRATED_WORKFLOW_LIMITS.maxLaunches.max, Math.max(ORCHESTRATED_WORKFLOW_LIMITS.maxLaunches.min, Math.trunc(d.maxLaunches)))
    : ORCHESTRATED_WORKFLOW_LIMITS.maxLaunches.default;
  const maxRework = typeof d.maxReworkIterations === "number"
    ? Math.min(ORCHESTRATED_WORKFLOW_LIMITS.maxReworkIterations.max, Math.max(ORCHESTRATED_WORKFLOW_LIMITS.maxReworkIterations.min, Math.trunc(d.maxReworkIterations)))
    : ORCHESTRATED_WORKFLOW_LIMITS.maxReworkIterations.default;
  const evidencePolicy = d.evidencePolicy === "observed-test" || d.evidencePolicy === "review-without-observed-test" ? d.evidencePolicy : undefined;
  const completionGate = d.completionGate === "owner-done" || d.completionGate === "qc-pass" ? d.completionGate : undefined;
  return {
    autoReviewAfterImplementation: d.autoReviewAfterImplementation !== false,
    ...(evidencePolicy ? { evidencePolicy } : {}),
    ...(completionGate ? { completionGate } : {}),
    ...(d.requireTaskWorkspace === true ? { requireTaskWorkspace: true as const } : {}),
    autoReworkOnChanges: d.autoReworkOnChanges === true,
    maxReworkIterations: maxRework,
    maxLaunchesPerTask: maxLaunches,
    maxConcurrent: ORCHESTRATED_BATCH_LIMITS.defaultConcurrency,
    expiresAt: now + validMinutes * 60_000,
    approvedAt: now,
    approvedBy: "owner",
    planRevision,
  };
}

export function batchPolicyFromApprove(
  body: OrchestratedBatchApproveBody,
  now: number,
  planRevision: number,
): OrchestratedBatchPolicy {
  const d = body.defaults;
  const validMinutes = typeof body.validMinutes === "number" && Number.isFinite(body.validMinutes)
    ? Math.min(ORCHESTRATED_WORKFLOW_LIMITS.ttlMinutes.max, Math.max(ORCHESTRATED_WORKFLOW_LIMITS.ttlMinutes.min, Math.trunc(body.validMinutes)))
    : ORCHESTRATED_WORKFLOW_LIMITS.ttlMinutes.default;
  const maxLaunches = typeof d.maxLaunches === "number"
    ? Math.min(ORCHESTRATED_WORKFLOW_LIMITS.maxLaunches.max, Math.max(ORCHESTRATED_WORKFLOW_LIMITS.maxLaunches.min, Math.trunc(d.maxLaunches)))
    : ORCHESTRATED_WORKFLOW_LIMITS.maxLaunches.default;
  const maxRework = typeof d.maxReworkIterations === "number"
    ? Math.min(ORCHESTRATED_WORKFLOW_LIMITS.maxReworkIterations.max, Math.max(ORCHESTRATED_WORKFLOW_LIMITS.maxReworkIterations.min, Math.trunc(d.maxReworkIterations)))
    : ORCHESTRATED_WORKFLOW_LIMITS.maxReworkIterations.default;
  const rawEvidence = d.evidencePolicy;
  const rawCompletion = d.completionGate;
  const rawWorkspace = d.requireTaskWorkspace;

  const evidencePolicy: EvidencePolicy =
    rawEvidence === undefined || rawEvidence === null
      ? SAFE_QUEUE_DEFAULTS.evidencePolicy
      : rawEvidence as EvidencePolicy;
  const completionGate: CompletionGate =
    rawCompletion === undefined || rawCompletion === null
      ? SAFE_QUEUE_DEFAULTS.completionGate
      : rawCompletion as CompletionGate;
  const requireTaskWorkspace: boolean =
    rawWorkspace === undefined || rawWorkspace === null
      ? SAFE_QUEUE_DEFAULTS.requireTaskWorkspace
      : rawWorkspace as boolean;

  return {
    queuePolicySchemaVersion: QUEUE_POLICY_SCHEMA_V1,
    autoReviewAfterImplementation: d.autoReviewAfterImplementation !== false,
    evidencePolicy,
    completionGate,
    requireTaskWorkspace,
    autoReworkOnChanges: d.autoReworkOnChanges === true,
    maxReworkIterations: maxRework,
    maxLaunchesPerTask: maxLaunches,
    maxConcurrent: ORCHESTRATED_BATCH_LIMITS.defaultConcurrency,
    expiresAt: now + validMinutes * 60_000,
    approvedAt: now,
    approvedBy: "owner",
    planRevision,
  };
}

export function buildOrchestratedBatchView(
  batch: OrchestratedBatchRecord,
  taskColumns: ReadonlyMap<string, string | null>,
  usesFakeDriver: boolean,
): OrchestratedBatchView {
  const ordered = [...batch.tasks].sort((a, b) => a.order - b.order);
  const remainingLaunches = batch.policy?.maxLaunchesPerTask ?? ORCHESTRATED_WORKFLOW_LIMITS.maxLaunches.default;
  const remainingRework = batch.policy?.maxReworkIterations ?? 0;
  const activeIdx = batch.progress.activeTaskId
    ? ordered.findIndex((t) => t.taskId === batch.progress.activeTaskId)
    : ordered.findIndex((t) => batch.progress.byTask[t.taskId]?.phase !== "awaiting_owner" && batch.progress.byTask[t.taskId]?.phase !== "skipped");
  const queuePosition = activeIdx >= 0 ? activeIdx + 1 : ordered.length;
  const tasks: OrchestratedBatchTaskView[] = ordered.map((plan) => {
    const prog = batch.progress.byTask[plan.taskId] ?? { phase: "queued" as const, workflowId: null, pauseReason: null, completedImplementationRunIds: [], completedReviewIds: [] };
    return { ...plan, phase: prog.phase, pauseReason: prog.pauseReason, column: taskColumns.get(plan.taskId) ?? null };
  });
  let blocker: string | null = batch.progress.pauseReason;
  if (!blocker && batch.status === "approved") blocker = null;
  if (batch.status === "draft" && ordered.length === 0) blocker = "Pick at least one Ready task.";
  return {
    batch,
    tasks,
    remainingLaunchesPerTask: remainingLaunches,
    remainingReworkPerTask: remainingRework,
    queuePosition,
    queueTotal: ordered.length,
    usesFakeDriver,
    canApprove: batch.status === "draft" && ordered.length > 0,
    canStart: batch.status === "approved",
    blocker,
  };
}
