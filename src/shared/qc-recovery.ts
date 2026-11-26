/**
 * FO-QC-RECOVERY01 — Owner-authorized review of an existing implementation.
 * Pure rules only. Persistence and git evidence live on the Bun side.
 */
import { createHash } from "node:crypto";
import type { ReviewEvidenceBundle, ReviewTestAuthorization } from "./review-evidence.ts";
import type { ColumnId } from "./types.ts";

export const QC_RECOVERY_LIMITS = {
  maxLaunches: 1,
  validMinutes: { min: 5, max: 240, default: 30 },
  /** Files newer than the Developer run by more than this are treated as later edits. */
  clockSkewMs: 2_000,
  maxFiles: 4_000,
  maxFileBytes: 2_000_000,
} as const;

export const QC_RECOVERY_STATUSES = [
  "prepared",
  "approved",
  "consumed",
  "expired",
  "cancelled",
  "invalidated",
] as const;
export type QcRecoveryStatus = (typeof QC_RECOVERY_STATUSES)[number];

/** Codex `ask` is `--sandbox read-only`. Claude QC uses bounded-print read-only tools. */
export function readOnlyReviewerContract(kind: string): { mode: string; sandbox: string; permission: string } | null {
  if (kind === "codex") {
    return {
      mode: "ask",
      sandbox: "read-only",
      permission: "Codex ask launches with --sandbox read-only.",
    };
  }
  if (kind === "claude-code") {
    return {
      mode: "bounded-print",
      sandbox: "read-only-tools",
      permission: "Claude bounded-print quality review uses read-only tools.",
    };
  }
  return null;
}

export function recoveryRequirementsHash(prompt: string): string {
  return createHash("sha256").update(prompt).digest("hex");
}

export function recoveryIdentityHash(input: {
  taskId: string;
  title: string;
  prompt: string;
  workdir: string;
  projectPath: string;
  developerRunId: string;
  isolation: string;
}): string {
  return createHash("sha256").update(JSON.stringify({
    taskId: input.taskId,
    title: input.title,
    prompt: input.prompt,
    workdir: input.workdir,
    projectPath: input.projectPath,
    developerRunId: input.developerRunId,
    isolation: input.isolation,
  })).digest("hex");
}

export function recoveryTreeFingerprint(head: string, files: { path: string; sha256: string }[]): string {
  const lines = [head, ...files.map((file) => `${file.path}\0${file.sha256}`)];
  return createHash("sha256").update(lines.join("\n")).digest("hex");
}

export interface QcRecoveryEvidence {
  /** ForgeOrbit does not store a tree snapshot when a Developer run finishes. */
  snapshotCapturedAtDeveloperRun: false;
  basis: "git-worktree-not-newer-than-developer-run";
  note: string;
  taskId: string;
  title: string;
  requirementsHash: string;
  identityHash: string;
  developerRunId: string;
  developerEndedAt: number;
  projectPath: string;
  workspacePath: string;
  gitHead: string;
  treeFingerprint: string;
  fileCount: number;
  paths: string[];
  /**
   * Applied task-owned outputs whose bytes matched the publication.
   * Absent when this run has no verified publication. A newer mtime on one
   * of these paths is the publication write, not an untracked later edit.
   */
  publishedPaths?: string[];
}

export interface QcRecoveryCandidate {
  harnessId: string;
  label: string;
  kind: string;
  accountId: string | null;
  accountLabel: string | null;
  mode: string;
  sandbox: string;
  permission: string;
  unavailableReason: string | null;
  /** Account-scoped provider rejections. Not a login failure and not a model substitution. */
  unsupportedModels: { modelId: string; expiresAt: number }[];
}

export interface QcRecoveryGrant {
  id: string;
  taskId: string;
  projectPath: string;
  status: QcRecoveryStatus;
  developerRunId: string;
  failedReviewId: string;
  failedReviewRunId: string;
  failureSummary: string;
  historicalBatchId: string | null;
  evidence: QcRecoveryEvidence;
  reviewerHarnessId: string;
  reviewerKind: string;
  reviewerModel: string;
  reviewerEffort: string | null;
  reviewerMode: string;
  reviewerSandbox: string;
  reviewerAccountId: string | null;
  reviewerAccountLabel: string | null;
  resourceFingerprint: string;
  maxLaunches: 1;
  launchesUsed: number;
  validMinutes: number;
  expiresAt: number | null;
  approvedAt: number | null;
  approvedBy: "owner" | null;
  reviewId: string | null;
  reviewRunId: string | null;
  outcome: "pass" | "changes_requested" | "blocked" | "process_failure" | null;
  authorizesDeveloper: false;
  authorizesRework: false;
  authorizesOtherTasks: false;
  authorizesBatchResume: false;
  quota: "unknown";
  cost: "unknown";
  createdAt: number;
  updatedAt: number;
  /** Absent on grants prepared before evidence refresh. */
  purpose?: "process-failure" | "evidence-refresh";
  blockedReviewId?: string | null;
  evidenceBundle?: ReviewEvidenceBundle | null;
}

export interface QcRecoverySituation {
  archived: boolean;
  column: ColumnId | string;
  liveRun: boolean;
  activeReview: boolean;
  developerRunId: string | null;
  developerSucceeded: boolean;
  failedReviewId: string | null;
  failedReviewVerdict: string | null;
  failedReviewComplete: boolean;
  failedReviewImplementationRunId: string | null;
  failedRunStatus: string | null;
  latestVerdict: string | null;
  workflowStatus: string | null;
  batchStatus: string | null;
  requirementsMatch: boolean;
}

const TERMINAL_REVIEW_RUN = new Set(["failed", "cancelled", "orphaned"]);

export function assessQcRecovery(input: QcRecoverySituation): {
  eligible: boolean;
  reconciliationRequired: boolean;
  blockers: string[];
} {
  const blockers: string[] = [];
  if (input.archived) blockers.push("Task is archived.");
  if (input.liveRun) blockers.push("An implementation or review is still running for this task.");
  if (input.activeReview) blockers.push("A quality review is already in progress.");
  if (!input.developerSucceeded || !input.developerRunId) {
    blockers.push("Recovery needs the original successful Developer run.");
  }
  if (!input.failedReviewComplete || input.failedReviewVerdict != null || !input.failedReviewId) {
    blockers.push("Recovery needs a finished Reviewer run that produced no QC verdict.");
  }
  if (input.developerRunId && input.failedReviewImplementationRunId && input.failedReviewImplementationRunId !== input.developerRunId) {
    blockers.push("The failed review does not reference that Developer run.");
  }
  if (input.failedReviewId && !TERMINAL_REVIEW_RUN.has(input.failedRunStatus ?? "")) {
    blockers.push("The Reviewer run has not finished in a failed state.");
  }
  if (input.latestVerdict) blockers.push("A QC verdict already exists. This recovery does not replace it.");
  if (!input.requirementsMatch) blockers.push("Task requirements changed after the Developer run.");
  if (input.batchStatus === "running") {
    blockers.push("The batch is still running. Recovery does not stop or resume a batch.");
  }
  if (input.workflowStatus === "awaiting_owner") {
    blockers.push("The existing workflow is already waiting for Owner acceptance.");
  }
  const reconciliationRequired = blockers.length === 0
    && input.batchStatus !== "running"
    && (input.workflowStatus === "active" || input.column === "running");
  if (reconciliationRequired) {
    blockers.push("The finished failed review is still marked in progress. Reconcile it before a new grant. Reconciliation does not invent a verdict.");
  }
  return { eligible: blockers.length === 0, reconciliationRequired, blockers };
}

export interface QcRecoveryView {
  eligible: boolean;
  reconciliationRequired: boolean;
  blockers: string[];
  developerRunId: string | null;
  failedReviewId: string | null;
  failedReviewRunId: string | null;
  failureSummary: string | null;
  historicalBatchId: string | null;
  historicalBatchStatus: string | null;
  historicalBatchPauseReason: string | null;
  evidence: QcRecoveryEvidence | null;
  evidenceReason: string | null;
  candidates: QcRecoveryCandidate[];
  grant: QcRecoveryGrant | null;
  implementationRunCount: number;
  reviewRunCount: number;
  quota: "unknown";
  cost: "unknown";
  authorizesDeveloper: false;
  authorizesRework: false;
  authorizesOtherTasks: false;
  authorizesBatchResume: false;
  maxLaunches: 1;
  evidenceRefresh: {
    eligible: boolean;
    blockers: string[];
    blockedReviewId: string | null;
    blockedSummary: string | null;
    bundle: ReviewEvidenceBundle | null;
    bundleReason: string | null;
    /** Open test authorization, or the latest consumed authorization that failed to record an observation. */
    testAuthorization: ReviewTestAuthorization | null;
  };
  /**
   * Ordinary evidence before the first QC review. Independent of evidence-refresh:
   * a missing BLOCKED review is not a blocker here, and this view never invents one.
   */
  firstReview: {
    /** The task is in Review and has no QC review yet, so the panel should show this path. */
    applicable: boolean;
    eligible: boolean;
    blockers: string[];
    developerRunId: string | null;
    publicationStatus: string | null;
    bundle: ReviewEvidenceBundle | null;
    bundleReason: string | null;
    testAuthorization: ReviewTestAuthorization | null;
  };
}

export function clampRecoveryMinutes(value: unknown): number {
  const n = typeof value === "number" ? value : QC_RECOVERY_LIMITS.validMinutes.default;
  if (!Number.isFinite(n)) return QC_RECOVERY_LIMITS.validMinutes.default;
  return Math.min(QC_RECOVERY_LIMITS.validMinutes.max, Math.max(QC_RECOVERY_LIMITS.validMinutes.min, Math.trunc(n)));
}
