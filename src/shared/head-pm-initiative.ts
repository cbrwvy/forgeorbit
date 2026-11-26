/**
 * FO-HEAD02 — durable cross-project initiatives for Head of PM coordination.
 * Pure types and progress derivation; no duplicate task/run history.
 */

import type { ColumnId } from "./types.ts";
import type { DelegationStatus } from "./portfolio-manager.ts";
import type { OrchestratedBatchStatus } from "./pm-orchestrated-batch.ts";

export const HEAD_PM_INITIATIVE_LIMITS = {
  titleChars: 160,
  goalChars: 500,
  descriptionChars: 4000,
  closeReasonChars: 500,
  maxProjects: 12,
} as const;

export type InitiativeStatus =
  | "draft"
  | "awaiting_delegation_approval"
  | "delegated"
  | "preparing_tasks"
  | "in_progress"
  | "needs_owner"
  | "completed"
  | "cancelled";

export type ContributionProgressKind =
  | "pending_delegation"
  | "awaiting_delegation_approval"
  | "delegated"
  | "preparing_tasks"
  | "in_progress"
  | "needs_owner"
  | "completed"
  | "closed_by_owner";

export interface InitiativeDelegationDraft {
  objective: string;
  request: string;
  reason: string;
  contextSummary: string;
  expectedOutput: string;
}

export interface InitiativeContribution {
  projectPath: string;
  /** Snapshot at initiative create — not rewritten when project is renamed. */
  projectName: string;
  clusterId: string | null;
  clusterName: string | null;
  pmEmployeeId: string | null;
  pmName: string | null;
  delegationId: string | null;
  proposalIds: string[];
  taskIds: string[];
  orchestratedBatchIds: string[];
  manuallyClosed: boolean;
  closeReason: string | null;
  blockers: string[];
  /** Suggested PM delegation text from an approved chat proposal (FO-HEAD03). */
  delegationDraft: InitiativeDelegationDraft | null;
  /** Derived on read; not persisted separately. */
  progress: ContributionProgressKind;
}

export interface HeadPmInitiative {
  id: string;
  title: string;
  goal: string;
  description: string;
  contributions: InitiativeContribution[];
  status: InitiativeStatus;
  blockers: string[];
  sourceMessageId: string | null;
  sourceProposalId: string | null;
  createdAt: number;
  updatedAt: number;
  cancelledAt: number | null;
}

export interface InitiativeTaskSnapshot {
  id: string;
  title: string;
  column: ColumnId;
  awaitingOwnerQc: boolean;
}

export interface InitiativeBatchSnapshot {
  id: string;
  projectPath: string;
  title: string;
  status: OrchestratedBatchStatus;
  needsAttention: boolean;
}

export interface HeadPmInitiativeView extends HeadPmInitiative {
  delegations: InitiativeDelegationSnapshot[];
  tasks: InitiativeTaskSnapshot[];
  batches: InitiativeBatchSnapshot[];
}

export interface InitiativeDelegationSnapshot {
  id: string;
  projectPath: string;
  objective: string;
  status: DelegationStatus;
  initiativeId: string | null;
}

export interface ContributionRefreshInput {
  delegationStatus: DelegationStatus | null;
  pendingProposalCount: number;
  tasks: { id: string; column: ColumnId; awaitingOwnerQc: boolean }[];
  batchStatuses: { id: string; status: OrchestratedBatchStatus; needsAttention: boolean }[];
  manuallyClosed: boolean;
  projectRegistered: boolean;
}

export function deriveContributionProgress(input: ContributionRefreshInput): ContributionProgressKind {
  if (input.manuallyClosed) return "closed_by_owner";
  if (!input.projectRegistered) return "needs_owner";
  if (!input.delegationStatus) return "pending_delegation";
  if (input.delegationStatus === "proposed" || input.delegationStatus === "failed") return "awaiting_delegation_approval";
  if (input.delegationStatus === "rejected") return "needs_owner";
  if (input.delegationStatus === "sending" || input.delegationStatus === "sent") return "delegated";
  const taskIds = input.tasks;
  if (taskIds.length === 0 && input.pendingProposalCount > 0) return "preparing_tasks";
  if (taskIds.length === 0) return "delegated";
  if (taskIds.some((t) => t.awaitingOwnerQc)) return "needs_owner";
  if (input.batchStatuses.some((b) => b.needsAttention)) return "needs_owner";
  if (taskIds.every((t) => t.column === "done")) return "completed";
  if (taskIds.some((t) => t.column === "running" || t.column === "ready" || t.column === "review" || t.column === "blocked")) {
    return "in_progress";
  }
  if (input.pendingProposalCount > 0) return "preparing_tasks";
  return "in_progress";
}

export function deriveInitiativeStatus(
  cancelledAt: number | null,
  contributions: Pick<InitiativeContribution, "progress">[],
): InitiativeStatus {
  if (cancelledAt != null) return "cancelled";
  if (contributions.length === 0) return "draft";
  const progress = contributions.map((c) => c.progress);
  if (progress.every((p) => p === "completed" || p === "closed_by_owner")) return "completed";
  if (progress.some((p) => p === "needs_owner")) return "needs_owner";
  if (progress.some((p) => p === "awaiting_delegation_approval")) return "awaiting_delegation_approval";
  if (progress.some((p) => p === "in_progress")) return "in_progress";
  if (progress.some((p) => p === "preparing_tasks")) return "preparing_tasks";
  if (progress.some((p) => p === "delegated")) return "delegated";
  if (progress.every((p) => p === "pending_delegation")) return "draft";
  return "delegated";
}

export function sanitizeHeadPmInitiative(value: unknown): HeadPmInitiative | null {
  if (!value || typeof value !== "object") return null;
  const rec = value as Record<string, unknown>;
  if (typeof rec.id !== "string" || typeof rec.title !== "string") return null;
  const contributionsRaw = Array.isArray(rec.contributions) ? rec.contributions : [];
  const contributions: InitiativeContribution[] = [];
  for (const item of contributionsRaw) {
    if (!item || typeof item !== "object") continue;
    const c = item as Record<string, unknown>;
    if (typeof c.projectPath !== "string") continue;
    contributions.push({
      projectPath: c.projectPath,
      projectName: typeof c.projectName === "string" ? c.projectName : c.projectPath,
      clusterId: typeof c.clusterId === "string" ? c.clusterId : null,
      clusterName: typeof c.clusterName === "string" ? c.clusterName : null,
      pmEmployeeId: typeof c.pmEmployeeId === "string" ? c.pmEmployeeId : null,
      pmName: typeof c.pmName === "string" ? c.pmName : null,
      delegationId: typeof c.delegationId === "string" ? c.delegationId : null,
      proposalIds: Array.isArray(c.proposalIds) ? c.proposalIds.filter((x): x is string => typeof x === "string") : [],
      taskIds: Array.isArray(c.taskIds) ? c.taskIds.filter((x): x is string => typeof x === "string") : [],
      orchestratedBatchIds: Array.isArray(c.orchestratedBatchIds)
        ? c.orchestratedBatchIds.filter((x): x is string => typeof x === "string")
        : [],
      manuallyClosed: c.manuallyClosed === true,
      closeReason: typeof c.closeReason === "string" ? c.closeReason : null,
      blockers: Array.isArray(c.blockers) ? c.blockers.filter((x): x is string => typeof x === "string") : [],
      delegationDraft: sanitizeDelegationDraft(c.delegationDraft),
      progress: "pending_delegation",
    });
  }
  const statuses: InitiativeStatus[] = [
    "draft", "awaiting_delegation_approval", "delegated", "preparing_tasks",
    "in_progress", "needs_owner", "completed", "cancelled",
  ];
  const status = statuses.includes(rec.status as InitiativeStatus) ? rec.status as InitiativeStatus : "draft";
  return {
    id: rec.id,
    title: rec.title,
    goal: typeof rec.goal === "string" ? rec.goal : "",
    description: typeof rec.description === "string" ? rec.description : "",
    contributions,
    status,
    blockers: Array.isArray(rec.blockers) ? rec.blockers.filter((x): x is string => typeof x === "string") : [],
    sourceMessageId: typeof rec.sourceMessageId === "string" ? rec.sourceMessageId : null,
    sourceProposalId: typeof rec.sourceProposalId === "string" ? rec.sourceProposalId : null,
    createdAt: typeof rec.createdAt === "number" ? rec.createdAt : 0,
    updatedAt: typeof rec.updatedAt === "number" ? rec.updatedAt : 0,
    cancelledAt: typeof rec.cancelledAt === "number" ? rec.cancelledAt : null,
  };
}

function sanitizeDelegationDraft(value: unknown): InitiativeDelegationDraft | null {
  if (!value || typeof value !== "object") return null;
  const rec = value as Record<string, unknown>;
  if (typeof rec.request !== "string" || !rec.request.trim()) return null;
  return {
    objective: typeof rec.objective === "string" ? rec.objective : "",
    request: rec.request,
    reason: typeof rec.reason === "string" ? rec.reason : "",
    contextSummary: typeof rec.contextSummary === "string" ? rec.contextSummary : "",
    expectedOutput: typeof rec.expectedOutput === "string" ? rec.expectedOutput : "",
  };
}
