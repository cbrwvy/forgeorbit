/**
 * Employee supervised execution (FO-010E2): contract shared by the runner,
 * the API and the Task panel.
 *
 * A *review* is the owner looking at the exact run that would start. It is a
 * pending record, not a permission. Only the owner's explicit confirmation of
 * that one review (single use, short lived) lets the existing task runtime
 * start the task. The record then becomes the durable link
 * Employee -> Assignment revision -> Task -> Run.
 *
 * `actual.*` is `null` (Unknown) unless the runtime itself established it. It
 * is never copied from `requested` or from a router recommendation.
 */

import type { AttributionProvenance, RunAttributionActual, RunAttributionRequested } from "./attribution.ts";
import type { PermissionDisclosure } from "./permissions.ts";
import type { PreflightIssue } from "./preflight.ts";

/** A review that is not confirmed in this time is void. */
export const EMPLOYEE_REVIEW_VALID_MS = 5 * 60_000;

export const EMPLOYEE_RUN_LIMITS = { bodyBytes: 4 * 1024, history: 100, reason: 600 } as const;

export const EMPLOYEE_RUN_STATUSES = [
  "awaiting-approval",
  "starting",
  "started",
  "start-failed",
  "indeterminate",
  "rejected",
  "expired",
  "superseded",
  "cancelled",
] as const;
export type EmployeeRunStatus = (typeof EMPLOYEE_RUN_STATUSES)[number];

export type EmployeeRunResult = "succeeded" | "failed" | "cancelled" | "orphaned";

/** What the owner sees about the resources. Facts from the review moment. */
export interface EmployeeRunReviewFacts {
  resourceKey?: string;
  permissionIdentity?: string | null;
  routingEvidenceKey?: string;
  routingPreferences?: import("./executor-routing.ts").ExecutorPreferences;
  evidence: string;
  account: { state: string; label: string };
  quota: { state: string; label: string; facts?: import("../accounts/availability.ts").QuotaFactKind[] };
  model: { state: string; label: string };
  warnings: PreflightIssue[];
  ownerRestrictions: {
    spending: string | null;
    allowedHarnesses: string[] | null;
    requiredApprovals: string[];
  };
  checks: { level: string; code: string; message: string }[];
  harnessLabel: string;
  modelLabel: string;
  modeLabel: string;
  /** 0 read-only … 4 no checks. See `modeAccessLevel`. */
  accessLevel: number;
  workspace: string;
  /** What the harness mode really grants for this workspace (FO-ORCH01). Absent on older reviews. */
  permission?: PermissionDisclosure | null;
  /** Access mode & OS vs app enforcement diagnostics across all harnesses (Direction 21). */
  accessDiagnostics?: import("./access-mode.ts").AccessDiagnostics | null;
  /** The executable, version and mode this launch would use (Direction 9). Absent on older reviews. */
  launchTarget?: import("../provider-launch-target.ts").LaunchTargetFacts;
  /** Absent on historical review snapshots; never inferred from today's task. */
  isolation?: "worktree" | "none";
  /** What `workspace` is for this reviewed launch (task-owned staging, Git worktree, project folder). Absent on older reviews. */
  workspaceKind?: "task-staging" | "worktree" | "project-folder";
  /** Outputs prepared for an armed staging workspace: eligible for later publication, not a write restriction. */
  stagedOutputPaths?: string[];
  /** Project-scoped "Development in a working copy" setting frozen at review time. */
  workspaceDevelopment?: boolean;
  computerWorkflow?: import("../task-computer-workflow.ts").TaskComputerReview;
  computerWorkflowDocumentDigest?: string;
  computerWorkflowLockdownArgs?: string[];
  /** Write scope of the task workspace bound to this review. */
  workingCopyWriteScope?: "explicit-outputs" | "working-copy";
  /** Private sandbox scratch path bound to a working-copy workspace. */
  workingCopyScratchPath?: string | null;
  /** Workspace ID auto-prepared during review so cancelling/expiring this unstarted review cleans it up. */
  autoPreparedWorkspaceId?: string | null;
}

export interface EmployeeRunView {
  /** Absent/null on historical attempts predating professional runtime binding. */
  professional?: import("./professional.ts").ProfessionalExecutionView | null;
  id: string;
  status: EmployeeRunStatus;
  /** Part of the approval: the confirm request must name it. */
  revision: number;
  taskId: string;
  taskTitle: string;
  projectPath: string;
  employee: { id: string; name: string };
  assignment: { id: string; revision: number };
  requested: RunAttributionRequested & { mode: string; complexity: string | null };
  actual: RunAttributionActual;
  provenance: { actual: AttributionProvenance; approval: AttributionProvenance };
  review: EmployeeRunReviewFacts;
  usageNotice: string | null;
  /** An earlier attempt for this task has an unconfirmed outcome. */
  requiresUnconfirmedAck: boolean;
  runId: string | null;
  executionId: string | null;
  /** Live run status read from the run row, when a run exists. */
  runStatus: "starting" | "running" | EmployeeRunResult | null;
  result: EmployeeRunResult | null;
  reason: string | null;
  createdAt: number;
  expiresAt: number;
  approvedAt: number | null;
  startedAt: number | null;
  finishedAt: number | null;
  phase: EmployeeRunPhase;
}

export type EmployeeRunPhase =
  | "awaiting-approval"
  | "starting"
  | "running"
  | "completed"
  | "failed"
  | "cancelled"
  | "unknown-outcome"
  | "not-started"
  | "expired"
  | "superseded"
  | "withdrawn";

export const PHASE_LABEL: Record<EmployeeRunPhase, string> = {
  "awaiting-approval": "Awaiting your confirmation",
  starting: "Starting",
  running: "Running",
  completed: "Completed",
  failed: "Failed",
  cancelled: "Cancelled",
  "unknown-outcome": "Unknown outcome",
  "not-started": "Not started",
  expired: "Review expired",
  superseded: "Replaced by a newer review",
  withdrawn: "Withdrawn",
};

/**
 * One honest word for the UI. Running appears only for a start the runtime
 * accepted; Completed only for a run that really finished successfully.
 */
export function phaseOf(
  row: { status: EmployeeRunStatus; result: EmployeeRunResult | null },
  runStatus: EmployeeRunView["runStatus"],
): EmployeeRunPhase {
  switch (row.status) {
    case "awaiting-approval": return "awaiting-approval";
    case "starting": return "starting";
    case "start-failed": return "failed";
    case "indeterminate": return "unknown-outcome";
    case "rejected": return "not-started";
    case "expired": return "expired";
    case "superseded": return "superseded";
    case "cancelled": return "withdrawn";
    case "started": {
      const outcome = row.result ?? (runStatus && runStatus !== "running" ? runStatus : null);
      if (outcome === "succeeded") return "completed";
      if (outcome === "failed") return "failed";
      if (outcome === "cancelled") return "cancelled";
      if (outcome === "orphaned") return "unknown-outcome";
      return runStatus === "running" ? "running" : runStatus === "starting" ? "starting" : "unknown-outcome";
    }
  }
}

export const EMPLOYEE_RUN_BANNER =
  "Nothing runs until you confirm. Confirming starts the task now with the employee and harness shown here.";

/** Request body of the confirmation. Strict; identifiers and flags only. */
export interface EmployeeRunStartRequest {
  revision: number;
  acknowledgeFullAccess: boolean;
  acknowledgeUsage: boolean;
  acknowledgeUnconfirmed: boolean;
  /** FO-AUTO01: server validates grant; not accepted from PM chat text alone. */
  orchestratedWorkflowId?: string;
}

export function parseStartRequest(value: unknown): EmployeeRunStartRequest {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw "Expected an object.";
  const record = value as Record<string, unknown>;
  const allowed = ["revision", "confirm", "acknowledgeUsage", "acknowledgeUnconfirmed", "acknowledgeFullAccess", "orchestratedWorkflowId"];
  if (Object.keys(record).some((key) => !allowed.includes(key))) throw "Unsupported field.";
  const orchestratedWorkflowId = typeof record.orchestratedWorkflowId === "string" && record.orchestratedWorkflowId.trim()
    ? record.orchestratedWorkflowId.trim()
    : undefined;
  if (orchestratedWorkflowId == null && record.confirm !== true) throw "Explicit owner confirmation is required (confirm: true).";
  const revision = record.revision;
  if (typeof revision !== "number" || !Number.isSafeInteger(revision) || revision < 1) throw "Invalid revision.";
  for (const flag of ["acknowledgeUsage", "acknowledgeUnconfirmed", "acknowledgeFullAccess"]) {
    const v = record[flag];
    if (v !== undefined && typeof v !== "boolean") throw `Invalid ${flag}.`;
  }
  return {
    revision,
    acknowledgeFullAccess: record.acknowledgeFullAccess === true,
    acknowledgeUsage: record.acknowledgeUsage === true,
    acknowledgeUnconfirmed: record.acknowledgeUnconfirmed === true,
    ...(orchestratedWorkflowId ? { orchestratedWorkflowId } : {}),
  };
}

/** Optional body of a cancel: only a revision, to refuse a stale click. */
export function parseCancelRequest(value: unknown): { revision: number | null } {
  if (value === undefined || value === null) return { revision: null };
  if (typeof value !== "object" || Array.isArray(value)) throw "Expected an object.";
  const record = value as Record<string, unknown>;
  if (Object.keys(record).some((key) => key !== "revision")) throw "Unsupported field.";
  const revision = record.revision;
  if (revision === undefined || revision === null) return { revision: null };
  if (typeof revision !== "number" || !Number.isSafeInteger(revision) || revision < 1) throw "Invalid revision.";
  return { revision };
}

/** Map a run row status onto the attribution result. */
export function resultOfRunStatus(status: string): EmployeeRunResult | null {
  return status === "succeeded" || status === "failed" || status === "cancelled" || status === "orphaned" ? status : null;
}

/** Short, secret-free completion reason from the facts the run row holds. */
export function reasonOfRun(result: EmployeeRunResult, exitCode: number | null): string {
  switch (result) {
    case "succeeded": return "The run finished successfully.";
    case "failed": return exitCode == null ? "The run failed." : `The run failed (exit code ${exitCode}).`;
    case "cancelled": return "The run was stopped.";
    case "orphaned": return "The app closed while the run was active; its outcome is not confirmed.";
  }
}

export function isOpenStatus(status: EmployeeRunStatus): boolean {
  return status === "awaiting-approval" || status === "starting";
}
