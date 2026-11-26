/**
 * FO-ROUTING03 — bounded Owner-reviewable resource allocation plans.
 * Pure types shared by Bun and the webview. No execution grants or Runs.
 */
import type { ExecutorReason } from "../execution/executor-routing.ts";
import { launchFingerprint } from "../task-scheduling.ts";
import type { Task } from "../types.ts";

export const ALLOCATION_PLAN_LIMITS = {
  maxTasks: 50,
  titleChars: 120,
  bodyBytes: 256 * 1024,
} as const;

export type AllocationPlanStatus =
  | "proposed"
  | "approved"
  | "applied"
  | "partial"
  | "invalidated";

export type AllocationPlanScopeKind = "project-manager" | "head-initiative";

/** Minimal Owner allocation policy (not a grant). */
export interface AllocationPlanPolicy {
  allowedHarnessIds: string[] | null;
  preferredHarnessIds: string[] | null;
  allowedAccountIds: string[] | null;
  preferredAccountIds: string[] | null;
  requireReviewerReadOnly: true;
  unknownQuotaRequiresAcknowledgement: boolean;
  maxTasks: number;
}

export const DEFAULT_ALLOCATION_PLAN_POLICY: AllocationPlanPolicy = {
  allowedHarnessIds: null,
  preferredHarnessIds: null,
  allowedAccountIds: null,
  preferredAccountIds: null,
  requireReviewerReadOnly: true,
  unknownQuotaRequiresAcknowledgement: true,
  maxTasks: ALLOCATION_PLAN_LIMITS.maxTasks,
};

export interface AllocationResourcePick {
  optionId: string;
  harnessId: string;
  harnessLabel: string;
  kind: string;
  modelId: string;
  modelLabel: string;
  modeId: string;
  modeLabel: string;
  accountId: string | null;
  accountLabel: string | null;
  resourceFingerprint: string | null;
  eligibility: "eligible" | "unknown" | "ineligible";
  eligibilityReasons: ExecutorReason[];
  limitations: ExecutorReason[];
  unknownFacts: string[];
  blockers: string[];
  selectable: boolean;
}

export interface AllocationTaskSlot {
  taskId: string;
  title: string;
  projectPath: string;
  taskFingerprint: string;
  taskUpdatedAt: number;
  developerEmployeeId: string | null;
  developerEmployeeName: string | null;
  developer: AllocationResourcePick | null;
  blockers: string[];
}

export interface AllocationReviewerSlot {
  projectPath: string;
  batchId: string | null;
  reviewerEmployeeId: string | null;
  reviewerEmployeeName: string | null;
  reviewer: AllocationResourcePick | null;
  blockers: string[];
}

export interface AllocationProjectSlice {
  projectPath: string;
  projectLabel: string;
  batchId: string | null;
  batchStatus: string | null;
  batchFrozen: boolean;
  tasks: AllocationTaskSlot[];
  reviewer: AllocationReviewerSlot;
}

export interface AllocationPlanBody {
  scopeKind: AllocationPlanScopeKind;
  title: string;
  initiativeId: string | null;
  projects: AllocationProjectSlice[];
  policy: AllocationPlanPolicy;
  capturedAt: number;
  ownerApprovalRequired: true;
  executionAvailable: false;
  forecastChange?: {
    original: { harnessId: string; modelId: string | null; accountId: string | null; mode: string | null };
    reason: "resource-unavailable" | "owner-comparison";
    timeDeltaMs: number;
    costDelta: import("../usage-analytics.ts").MoneyAmount | null;
    confidence: "low" | "medium";
    pools: Array<{ id: string; status: string; knownDemand: number; unknownStages: number }>;
    /** FO-DIRECTION13. Fingerprint of the quota readings on the accounts this review compared. A new or corrected reading makes the review stale. */
    evidenceKey?: string;
  };
}

export interface AllocationPlanRecord {
  id: string;
  scopeKind: AllocationPlanScopeKind;
  scopeRef: string;
  status: AllocationPlanStatus;
  revision: number;
  planDigest: string;
  approvedDigest: string | null;
  approvedAt: number | null;
  appliedAt: number | null;
  invalidatedAt: number | null;
  invalidateReason: string | null;
  plan: AllocationPlanBody;
  history: { at: number; text: string }[];
  createdAt: number;
  updatedAt: number;
}

export interface AllocationPlanView {
  record: AllocationPlanRecord;
  planDigest: string;
  valid: boolean;
  validityBlocker: string | null;
  canApprove: boolean;
  canApply: boolean;
  applyBlocker: string | null;
}

export function taskFingerprintOf(task: Task): { fingerprint: string; updatedAt: number } {
  return { fingerprint: launchFingerprint(task), updatedAt: task.updatedAt };
}
