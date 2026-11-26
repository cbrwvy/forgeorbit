/**
 * Employee execution preflight (FO-010E1).
 *
 * A preflight describes a FUTURE run of an assigned task by its worker. It is
 * a read-only calculation: it starts no agent, creates no run, changes no
 * task, and grants no permission. A result is a snapshot that may be stale a
 * moment later, never a guarantee that a later start will succeed.
 *
 * Employee Identity stores no harness, account or model. Nothing here is
 * written back to the employee, the assignment, or the task.
 */

import type { ResourceCandidate } from "../model-router/types.ts";
import { ROUTING_POLICIES, type Complexity, type RoutingPolicy } from "../model-router/types.ts";
import { currentFact } from "../model-router/route.ts";

export { ROUTING_POLICIES };
export const PREFLIGHT_COMPLEXITIES = ["low", "medium", "high", "very-high"] as const satisfies readonly Complexity[];
export type { RoutingPolicy };

/** How long a displayed result is current. Matches router evidence expiry. */
export const PREFLIGHT_VALID_MS = 30_000;

export const PREFLIGHT_LIMITS = { bodyBytes: 4 * 1024, identifier: 200 } as const;

export const PREFLIGHT_BANNER = "Preflight only — no agent started.";

export const EVIDENCE_STATES = ["verified", "conditional", "unknown", "blocked", "conflicting"] as const;
export type EvidenceState = (typeof EVIDENCE_STATES)[number];

export const PREFLIGHT_ERROR_CODES = [
  "task-archived",
  "task-pipeline-step",
  "task-column",
  "task-running",
  "task-other-project",
  "ownership-ambiguous",
  "symlink-escape",
  "foreign-worktree",
  "workdir-missing",
  "task-outside-project",
  "project-unregistered",
  "no-assignment",
  "assignment-project-diverged",
  "stale-assignment",
  "employee-missing",
  "employee-not-worker",
  "employee-inactive",
  "employee-archived",
  "employee-other-project",
  "unknown-harness",
  "harness-disabled",
  "unknown-model",
  "unsupported-effort",
  "routing-input-unavailable",
  "owner-policy",
  "resource-excluded",
  "owner-model-forbidden",
  "required-mode-unsupported",
  "execution-starting",
] as const;
export type PreflightErrorCode = (typeof PREFLIGHT_ERROR_CODES)[number];

export interface PreflightIssue {
  code: string;
  message: string;
}

export interface PreflightAccountState {
  /**
   * unknown: the execution account is not identified. A registry binding only
   * lists accounts that MAY be used; it does not select one.
   * identified-*: an explicit agent-profile association names the account.
   */
  state: "unknown" | "identified-unverified" | "identified-verified";
  label: string;
  /** Identified account first, otherwise the registry accounts bound to this harness. */
  accounts: { id: string; displayName: string; provider: string; verification: string; availability: string }[];
}

export interface PreflightQuotaState {
  state: "unknown" | "verified" | "stale" | "conflicting";
  label: string;
  quotas: { id: string; status: string; verification: string | null; fact?: import("../accounts/availability.ts").QuotaFactKind }[];
  /** Direction 11: the distinct kinds of reading on record (unique, in a fixed order). Never capacity. */
  facts?: import("../accounts/availability.ts").QuotaFactKind[];
}

export interface PreflightModelEvidence {
  state: "unknown" | "supported" | "unsupported";
  label: string;
  models: { modelId: string | null; support: string; verification: string }[];
}

export interface PreflightHarnessOption {
  harnessId: string;
  kind: string;
  label: string;
  enabled: boolean;
  evidence: EvidenceState;
  /** Why this resource is not (or cannot yet be) recommended automatically. */
  notRecommendedBecause: string[];
}

export interface PreflightHarnessSelection extends PreflightHarnessOption {
  account: PreflightAccountState;
  quota: PreflightQuotaState;
  model: PreflightModelEvidence;
  /** Router-reported missing or unverified information for this harness. */
  missingEvidence: string[];
  conflicts: string[];
  provenance: string[];
  /** The observed provider usage-limit refusal for exactly this account and launch model, if any. An observation, not a block. */
  providerRefusal?: import("../provider-refusal.ts").ProviderRefusalSummary | null;
}

export interface PreflightResult {
  permission?: import("./permissions.ts").PermissionDisclosure | null;
  accessDiagnostics?: import("./access-mode.ts").AccessDiagnostics | null;
  readOnly: true;
  /** Always false in FO-010E1. Execution is a separate, later stage. */
  executionAvailable: false;
  banner: typeof PREFLIGHT_BANNER;
  outcome: "blocked" | "selection-needed" | "prepared";
  taskId: string;
  task: { title: string; column: string; agent: string; mode: string | null };
  canonicalProject: { path: string; name: string | null; via: string } | null;
  employee: { id: string; name: string; jobTitle: string; kind: string; status: string } | null;
  assignment: { id: string; revision: number; assignedAt: number } | null;
  requested: { harnessId: string | null; model: string | null; effort: string | null; complexity: string | null };
  harnessOptions: PreflightHarnessOption[];
  selection: PreflightHarnessSelection | null;
  routerRecommendation: {
    status: "recommended" | "no-verified-candidate";
    harnessId: string | null;
    modelId: string | null;
    accountId: string | null;
    note: string;
  };
  ownerRestrictions: {
    spending: string | null;
    maxExpectedCost: { currency: string; minor: number } | null;
    allowedHarnesses: string[] | null;
    allowedAccounts: string[] | null;
    requiredApprovals: string[];
    /** From saved executor-routing preferences (FO-ORCH01). Absent on older snapshots. */
    forbiddenModels?: string[];
    requiredMode?: string | null;
  };
  executionMode: { taskMode: string | null; taskHarness: string; note: string };
  missingEvidence: string[];
  warnings: PreflightIssue[];
  blockingErrors: PreflightIssue[];
  capturedAt: number;
  validUntil: number;
  /** Hash of the facts this result rests on. Informational; never a permission. */
  stateKey: string;
  proposedNextAction: { code: string; text: string };
  /** What FO-010E2 must re-check atomically at start. This result proves none of it. */
  startContract: typeof EXECUTION_START_CONTRACT;
}

/**
 * Contract for the later execution stage. A preflight does not satisfy any of
 * these. The start step re-reads each fact under a write lock.
 */
export const EXECUTION_START_CONTRACT = {
  approvals: {
    "assignment-approval": "FO-010D owner approval confirms only the assignment. It does not allow a run.",
    "knowledge-grant": "FO-011E grants selected notes to a manager for one message. It does not allow a run.",
    "execution-approval": "A separate, explicit owner confirmation immediately before start. Not stored by preflight.",
  },
  recheckAtStart: [
    "Task still exists, is not archived, is not a pipeline step, and is in a runnable column.",
    "Task ownership: fresh classification yields the same single registered project (verifyLaunchScope).",
    "Employee still exists, is an active worker of that project, and is not archived.",
    "Assignment is still active at the expected revision.",
    "Harness is still registered and enabled; model and effort are still accepted.",
    "Owner policies and spending limits are still satisfied.",
    "No other live run or starting proposal exists for the task (concurrency check under lock).",
    "Existing supervised approval (approveExecution) is used; this stage adds no second runtime.",
  ],
  recordAfterConfirmedStart: "Actual harness, model, account and employee are written only after the start is confirmed.",
  clientTimestampIsNotProof: true,
} as const;

export interface PreflightRequest {
  taskId: string;
  harnessId: string | null;
  model: string | null;
  effort: string | null;
  /** Owner-stated task complexity. Null stays Unknown; nothing is inferred from the task text. */
  complexity: (typeof PREFLIGHT_COMPLEXITIES)[number] | null;
  policy: RoutingPolicy;
  expectedAssignmentRevision: number | null;
}

/** Strict request schema. Throws a string message on the first problem. */
export function parsePreflightRequest(value: unknown): PreflightRequest {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw "Expected an object.";
  const record = value as Record<string, unknown>;
  const allowed = ["taskId", "harnessId", "model", "effort", "complexity", "policy", "expectedAssignmentRevision"];
  if (Object.keys(record).some((key) => !allowed.includes(key))) throw "Unsupported field.";
  const text = (key: string, required: boolean): string | null => {
    const v = record[key];
    if (v === undefined || v === null) {
      if (required) throw `${key} is required.`;
      return null;
    }
    if (typeof v !== "string" || !v.trim() || v.length > PREFLIGHT_LIMITS.identifier || /[\x00-\x1f\x7f]/.test(v)) throw `Invalid ${key}.`;
    return v;
  };
  const taskId = text("taskId", true)!;
  const policy = record.policy ?? "balanced";
  if (typeof policy !== "string" || !(ROUTING_POLICIES as readonly string[]).includes(policy)) throw "Invalid policy.";
  const complexity = record.complexity;
  if (complexity !== undefined && complexity !== null
    && (typeof complexity !== "string" || !(PREFLIGHT_COMPLEXITIES as readonly string[]).includes(complexity))) throw "Invalid complexity.";
  const revision = record.expectedAssignmentRevision;
  if (revision !== undefined && revision !== null && (typeof revision !== "number" || !Number.isSafeInteger(revision) || revision < 1)) {
    throw "Invalid expectedAssignmentRevision.";
  }
  return {
    taskId,
    harnessId: text("harnessId", false),
    model: text("model", false),
    effort: text("effort", false),
    complexity: (complexity as PreflightRequest["complexity"] | undefined) ?? null,
    policy: policy as RoutingPolicy,
    expectedAssignmentRevision: (revision as number | undefined | null) ?? null,
  };
}

export const EVIDENCE_LABEL: Record<EvidenceState, string> = {
  verified: "Verified evidence",
  conditional: "Conditional evidence",
  unknown: "Unknown evidence",
  blocked: "Explicitly blocked",
  conflicting: "Conflicting evidence",
};

/** A short, honest word for UI. Never "Ready" or "Available". */
export function evidenceLabel(state: EvidenceState): string {
  return EVIDENCE_LABEL[state];
}

/**
 * Classify one registered harness from the router's assessments of its
 * candidates. `candidates` are the snapshot rows the router judged, so the
 * check for positive evidence reads the same facts.
 */
export function classifyHarnessEvidence(
  enabled: boolean,
  assessments: readonly { status: "verified" | "conditional" | "excluded"; conflicts: string[] }[],
  candidates: readonly Pick<ResourceCandidate, "authorization" | "availability" | "support">[],
  now: number,
): EvidenceState {
  if (!enabled) return "blocked";
  if (assessments.length === 0) return "unknown";
  // Conflicting source evidence is not the same as an exhausted resource.
  if (assessments.some((a) => a.status !== "excluded" && a.conflicts.length > 0)) return "conflicting";
  if (assessments.every((a) => a.status === "excluded")) return "blocked";
  if (assessments.some((a) => a.status === "verified")) return "verified";
  const positive = candidates.some((c) =>
    currentFact(c.authorization, now) || currentFact(c.availability, now)
    || (c.support?.verification === "verified" && c.support.support === "supported"
      && c.support.expiresAt !== null && c.support.expiresAt > now && c.support.observedAt <= now));
  return positive ? "conditional" : "unknown";
}

/** Order for picking the "best known" state when a harness has several candidates. */
export function nextActionFor(result: Pick<PreflightResult, "blockingErrors" | "assignment" | "requested">): { code: string; text: string } {
  const codes = result.blockingErrors.map((e) => e.code);
  if (codes.includes("no-assignment")) {
    return { code: "assign-worker", text: "Assign a worker to this task in Company → Staff. Preflight does not assign anyone." };
  }
  if (codes.includes("stale-assignment")) {
    return { code: "refresh", text: "The assignment changed. Review the worker shown here and prepare again." };
  }
  if (result.blockingErrors.length > 0) {
    return { code: "resolve-blockers", text: "Resolve the blocking errors, then prepare again." };
  }
  if (!result.requested.harnessId) {
    return { code: "select-harness", text: "Choose a registered harness, or keep the router recommendation for reference only." };
  }
  return { code: "await-execution-stage", text: "Preflight is complete. Run Employee opens a review; nothing starts until you confirm it." };
}
