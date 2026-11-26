import { t, t as tr } from "@/i18n/core";

/**
 * Pure helpers for the Employee Execution section (FO-010E1).
 * Labels and request building only. Nothing here starts an agent, and no
 * helper turns Unknown evidence into a ready or available state.
 */

import type { Task } from "../../shared/types.ts";
import type { EvidenceState, PreflightIssue, PreflightRequest, PreflightResult } from "../../shared/execution/preflight.ts";
import { type EmployeeRunPhase, type EmployeeRunView } from "../../shared/execution/run.ts";

export interface ExecutionDraft {
  harnessId: string;
  model: string;
  effort: string;
  complexity: "" | "low" | "medium" | "high" | "very-high";
}

export const EMPTY_EXECUTION_DRAFT: ExecutionDraft = { harnessId: "", model: "", effort: "", complexity: "" };

export type PreflightBody = Omit<PreflightRequest, "policy"> & { policy?: PreflightRequest["policy"] };

/** Optional strings become null when blank. Nothing is trimmed into a different value. */
export function buildPreflightBody(taskId: string, draft: ExecutionDraft, reviewedRevision: number | null): PreflightBody {
  const text = (value: string) => (value.trim() ? value.trim() : null);
  return {
    taskId,
    harnessId: text(draft.harnessId),
    model: text(draft.model),
    effort: text(draft.effort),
    complexity: draft.complexity === "" ? null : draft.complexity,
    expectedAssignmentRevision: reviewedRevision,
  };
}

/**
 * Everything the owner sees that a result rests on. A result is current only
 * while this key is unchanged and its own deadline has not passed.
 */
export function executionInputKey(task: Pick<Task, "id" | "column" | "updatedAt" | "archivedAt" | "ownerProjectPath" | "agent">, draft: ExecutionDraft): string {
  return JSON.stringify([task.id, task.column, task.updatedAt, task.archivedAt ?? null, task.ownerProjectPath ?? null, task.agent, draft]);
}

export function isPreflightStale(
  shown: { key: string; validUntil: number } | null,
  currentKey: string,
  now: number,
): boolean {
  return shown !== null && (shown.key !== currentKey || now >= shown.validUntil);
}

export const EVIDENCE_TONE: Record<EvidenceState, string> = {
  verified: "bg-success/15 text-success",
  conditional: "bg-warning/15 text-warning",
  unknown: "bg-muted text-muted-foreground",
  blocked: "bg-danger/15 text-danger",
  conflicting: "bg-info/15 text-info",
};

export function outcomeLabel(outcome: PreflightResult["outcome"]): string {
  if (outcome === "blocked") return tr("common.blocked");
  if (outcome === "prepared") return tr("common.prepared_for_review");
  return tr("common.choose_a_harness");
}

export function accountStateLabel(state: "unknown" | "identified-unverified" | "identified-verified"): string {
  if (state === "identified-verified") return tr("common.account_verified");
  if (state === "identified-unverified") return tr("common.account_identified_not_verified");
  return tr("common.account_unknown");
}

/** The reviewed revision to send next, or null when the shown result must not be trusted. */
export function reviewedRevisionOf(result: Pick<PreflightResult, "assignment" | "blockingErrors"> | null): number | null {
  if (!result?.assignment) return null;
  // After a stale-assignment answer the owner has now seen the fresh worker; the next click proceeds.
  if (result.blockingErrors.some((e) => e.code === "stale-assignment")) return null;
  return result.assignment.revision;
}

// ----- FO-010E2: review, confirmation, status -------------------------------------------------

export interface EmployeeRunReviewResponse {
  preflight: PreflightResult;
  /** Null when anything blocks; nothing was recorded then. */
  attempt: EmployeeRunView | null;
  blockingErrors: PreflightIssue[];
  reused: boolean;
}

/**
 * "Run Employee" is offered only for a fresh, fully prepared preflight with a
 * harness chosen and nothing blocking. It opens a review; it never starts.
 */
export function canOfferRun(result: Pick<PreflightResult, "outcome" | "blockingErrors" | "selection" | "employee" | "assignment"> | null, stale: boolean): boolean {
  return !!result && !stale && result.outcome === "prepared" && result.blockingErrors.length === 0
    && !!result.selection && !!result.employee && !!result.assignment;
}

/** Fields of the confirmation. Revision, explicit confirm, and only acknowledgements the owner ticked. */
export function buildStartBody(attempt: Pick<EmployeeRunView, "revision" | "usageNotice" | "requiresUnconfirmedAck"> & Partial<Pick<EmployeeRunView, "review">>, ack: { usage: boolean; unconfirmed: boolean; fullAccess?: boolean }) {
  return {
    revision: attempt.revision,
    confirm: true as const,
    ...(attempt.review?.permission?.sandbox === "danger-full-access" && ack.fullAccess ? { acknowledgeFullAccess: true } : {}),
    ...(attempt.usageNotice && ack.usage ? { acknowledgeUsage: true } : {}),
    ...(attempt.requiresUnconfirmedAck && ack.unconfirmed ? { acknowledgeUnconfirmed: true } : {}),
  };
}

/** The owner may confirm only while the review is open, not expired, and every required acknowledgement is ticked. */
export function canConfirm(
  attempt: Pick<EmployeeRunView, "status" | "expiresAt" | "usageNotice" | "requiresUnconfirmedAck"> & Partial<Pick<EmployeeRunView, "review">>,
  ack: { usage: boolean; unconfirmed: boolean; fullAccess?: boolean },
  now: number,
): boolean {
  if (attempt.status !== "awaiting-approval" || now >= attempt.expiresAt) return false;
  if (attempt.review?.permission?.sandbox === "danger-full-access" && !ack.fullAccess) return false;
  if (attempt.usageNotice && !ack.usage) return false;
  if (attempt.requiresUnconfirmedAck) return false;
  return true;
}

export const PHASE_TONE: Record<EmployeeRunPhase, string> = {
  "awaiting-approval": "bg-warning/15 text-warning",
  starting: "bg-info/15 text-info",
  running: "bg-info/15 text-info",
  completed: "bg-success/15 text-success",
  failed: "bg-danger/15 text-danger",
  cancelled: "bg-muted text-muted-foreground",
  "unknown-outcome": "bg-warning/15 text-warning",
  "not-started": "bg-muted text-muted-foreground",
  expired: "bg-muted text-muted-foreground",
  superseded: "bg-muted text-muted-foreground",
  withdrawn: "bg-muted text-muted-foreground",
};

/** Phases that still change on their own and are worth polling. */
export function isLivePhase(phase: EmployeeRunPhase): boolean {
  return phase === "starting" || phase === "running";
}

export function phaseLabel(phase: EmployeeRunPhase): string {
  return t(`phase.${phase}`);
}

/** Honest text for a resource that may be Unknown. Never invents a value. */
export function actualText(value: string | null): string {
  return value ?? tr("common.unknown");
}

export function accessText(level: number): string {
  if (level <= 0) return tr("common.read_only_or_plan_it_proposes_it_does");
  if (level === 1) return tr("common.asks_before_changing_anything");
  if (level === 2) return tr("common.edits_files_asks_before_running_other_commands");
  if (level === 3) return tr("common.edits_files_and_runs_commands_without_asking_with");
  return tr("common.no_checks_at_all_edits_files_and_runs");
}

/**
 * Antigravity's stored mode id `ask` launches `--mode accept-edits`.
 * File edits are accepted by the CLI. The generic "ask" label must not
 * be shown as a promise that ForgeOrbit confirms each file change.
 */
export function antigravityAutoAcceptsFileEdits(harnessId: string | null, mode: string): boolean {
  return harnessId === "antigravity" && mode === "ask";
}
