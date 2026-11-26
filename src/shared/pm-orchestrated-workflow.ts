/**
 * FO-AUTO01 — bounded Owner-authorized PM orchestration (implement → QC → verdict).
 * Pure types, limits, and read-model helpers; enforcement lives in `src/bun/pm-orchestrated-workflow.ts`.
 */
import type { ApprovedWorkflowExecution } from "./bounded-claude.ts";
import type { CompletionGate, EvidencePolicy } from "./queue-gates.ts";
import type { QcVerdict } from "./task-quality-control.ts";
import type { ColumnId } from "./types.ts";

export const ORCHESTRATED_WORKFLOW_LIMITS = {
  maxLaunches: { min: 1, max: 20, default: 2 },
  maxReworkIterations: { min: 0, max: 5, default: 0 },
  ttlMinutes: { min: 5, max: 24 * 60, default: 240 },
  grantBodyBytes: 8 * 1024,
} as const;

export type OrchestratedWorkflowStatus =
  | "active"
  | "paused"
  | "awaiting_owner"
  | "cancelled"
  | "exhausted"
  | "expired";

export type OrchestratedWorkflowPhase =
  | "implementing"
  | "awaiting_review"
  | "reviewing"
  | "rework"
  | "awaiting_owner_acceptance"
  | "idle";

/** Owner-approved policy frozen at grant time. */
export interface OrchestratedWorkflowGrant {
  taskId: string;
  projectPath: string;
  implementerEmployeeId: string;
  implementerHarnessId: string;
  implementerModel: string;
  implementerEffort: string | null;
  reviewerEmployeeId: string | null;
  reviewerHarness: string;
  reviewerModel: string;
  autoReviewAfterImplementation: boolean;
  autoReworkOnChanges: boolean;
  maxReworkIterations: number;
  maxLaunches: number;
  expiresAt: number | null;
  approvedAt: number;
  approvedBy: "owner";
  grantEpoch: number;
  /**
   * FO-AUTO03. Absent means the legacy FO-AUTO02 path.
   * `review-without-observed-test` is the only explicit exemption from a ForgeOrbit-observed test.
   */
  evidencePolicy?: EvidencePolicy;
  /** FO-AUTO03. Absent means the next task becomes eligible at QC PASS. */
  completionGate?: CompletionGate;
  /** FO-AUTO03. When true, an unprepared Developer launch is refused. */
  requireTaskWorkspace?: boolean;
  /** FO-AUTO02: set when this grant was issued by a multi-task batch coordinator. */
  orchestratedBatchId?: string;
  /** FO-AUTO02: frozen task fingerprint at batch approval. */
  approvedTaskFingerprint?: string;
  execution?: ApprovedWorkflowExecution;
}

export interface OrchestratedWorkflowCounters {
  launchesUsed: number;
  implementationRuns: number;
  reviewRuns: number;
  reworkCount: number;
}

export interface OrchestratedWorkflowProgress {
  phase: OrchestratedWorkflowPhase;
  pauseReason: string | null;
  lastFailure: string | null;
  activeEmployeeAttemptId: string | null;
  activeReviewId: string | null;
  completedImplementationRunIds: string[];
  completedReviewIds: string[];
  /** Idempotency: steps already finished (survives restart). */
  finishedSteps: string[];
  launchedRuns?: { runId: string; role: "implementation" | "review" }[];
  /** FO-AUTO03 waiting copy. Waiting is not a failure and does not pause the batch. */
  waitReason?: string | null;
  failureClass?: string | null;
  lastCompletedStep?: string | null;
}

export interface OrchestratedWorkflowRecord {
  id: string;
  taskId: string;
  projectPath: string;
  status: OrchestratedWorkflowStatus;
  grant: OrchestratedWorkflowGrant;
  progress: OrchestratedWorkflowProgress;
  counters: OrchestratedWorkflowCounters;
  createdAt: number;
  updatedAt: number;
}

export interface OrchestratedWorkflowView {
  workflow: OrchestratedWorkflowRecord | null;
  ownerAction: string | null;
  remainingLaunches: number;
  remainingRework: number;
  usesFakeDriver: boolean;
}

export interface OrchestratedWorkflowApproveBody {
  implementerMode?: string;
  reviewerMode?: string;
  implementerEmployeeId: string;
  implementerHarnessId: string;
  implementerModel: string;
  implementerEffort?: string | null;
  reviewerEmployeeId?: string | null;
  reviewerHarness: string;
  reviewerModel: string;
  autoReviewAfterImplementation?: boolean;
  autoReworkOnChanges?: boolean;
  maxReworkIterations?: number;
  maxLaunches?: number;
  validMinutes?: number;
  evidencePolicy?: EvidencePolicy;
  completionGate?: CompletionGate;
  requireTaskWorkspace?: boolean;
}

export function emptyProgress(): OrchestratedWorkflowProgress {
  return {
    phase: "implementing",
    pauseReason: null,
    lastFailure: null,
    activeEmployeeAttemptId: null,
    activeReviewId: null,
    completedImplementationRunIds: [],
    completedReviewIds: [],
    finishedSteps: [],
  };
}

export function emptyCounters(): OrchestratedWorkflowCounters {
  return { launchesUsed: 0, implementationRuns: 0, reviewRuns: 0, reworkCount: 0 };
}

export function grantExpired(grant: OrchestratedWorkflowGrant, now: number): boolean {
  return grant.expiresAt != null && now >= grant.expiresAt;
}

export function launchesRemaining(grant: OrchestratedWorkflowGrant, counters: OrchestratedWorkflowCounters): number {
  return Math.max(0, grant.maxLaunches - counters.launchesUsed);
}

export function reworkRemaining(grant: OrchestratedWorkflowGrant, counters: OrchestratedWorkflowCounters): number {
  return Math.max(0, grant.maxReworkIterations - counters.reworkCount);
}

export function ownerActionForOrchestrated(
  record: OrchestratedWorkflowRecord | null,
  taskColumn: ColumnId,
  qcVerdict: QcVerdict | null,
  awaitingOwnerApproval: boolean,
): string | null {
  if (!record || taskColumn === "done") return null;
  if (record.status === "awaiting_owner" || (awaitingOwnerApproval && qcVerdict === "PASS")) {
    return "Quality review passed. Inspect the result and mark the task done when you accept it.";
  }
  if (record.status === "paused") {
    return record.progress.pauseReason ?? "The orchestrated workflow is paused. Resume or cancel it, or grant anew.";
  }
  if (record.status === "exhausted" || record.status === "expired") {
    return "This workflow grant reached its limits or expired. Approve a new bounded workflow to continue.";
  }
  if (record.status === "cancelled") return null;
  if (taskColumn === "backlog" || taskColumn === "inbox") {
    return "Move the task to Ready before orchestration can run.";
  }
  return null;
}

export function buildOrchestratedWorkflowView(
  record: OrchestratedWorkflowRecord | null,
  opts: { taskColumn: ColumnId; qcVerdict: QcVerdict | null; awaitingOwnerApproval: boolean; usesFakeDriver: boolean },
): OrchestratedWorkflowView {
  if (!record) {
    return { workflow: null, ownerAction: null, remainingLaunches: 0, remainingRework: 0, usesFakeDriver: opts.usesFakeDriver };
  }
  return {
    workflow: record,
    ownerAction: ownerActionForOrchestrated(record, opts.taskColumn, opts.qcVerdict, opts.awaitingOwnerApproval),
    remainingLaunches: launchesRemaining(record.grant, record.counters),
    remainingRework: reworkRemaining(record.grant, record.counters),
    usesFakeDriver: opts.usesFakeDriver,
  };
}
