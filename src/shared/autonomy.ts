/**
 * Bounded autonomous execution (FO-ORCH08): pure model and decisions.
 *
 * An Execution Batch approval (FO-005C / FO-ORCH07) freezes WHICH tasks may
 * start and with which agents, but it does not bound how many Runs those
 * tasks may produce (pipeline steps, retries, reminders, auto-resumes) and it
 * has no expiry unless the batch came from a queue. A bounded grant is the
 * Owner's separate, explicit act on an already approved batch: an exact task
 * allow-list, exact harness/model/account/permission bindings, a Run budget, a
 * parallelism cap and a deadline. It never widens anything the batch approval
 * allowed, it is never extended automatically, and any change it did not
 * freeze stops further Runs until the Owner decides again.
 *
 * Nothing in here touches state. `src/bun/autonomy.ts` gathers the facts and
 * `evaluateAutonomousRun` decides.
 */

import type { AgentKind } from "./types.ts";

export const AUTONOMY_LIMITS = {
  maxRuns: { min: 1, max: 200 },
  maxParallelism: { min: 1, max: 4 },
  ttlMinutes: { min: 5, max: 24 * 60, default: 240 },
} as const;

/** Who is asking for a Run when ForgeOrbit (not the Owner's own click) makes it. */
export type AutonomyOrigin = "batch" | "pipeline-step" | "handoff-reminder" | "fx-auto-resume";

/**
 * Automatic paths a grant does NOT cover. A timer that restarts a paused
 * session can't be bounded by the Owner's decision, so inside a granted scope it
 * is refused. (A claude session that continues by itself after a background task
 * is the provider's act, not a ForgeOrbit start: it can't be prevented, but its
 * Run row is still counted against the budget — see docs/qa/fo-orch08-results.md.)
 */
export const AUTONOMY_FORBIDDEN_ORIGINS: readonly AutonomyOrigin[] = ["fx-auto-resume"];

export type AutonomyStatus = "active" | "exhausted" | "expired" | "revoked";

export interface AutonomyResource {
  taskId: string;
  /** Pipeline entries list one resource per step agent; the step name says which. */
  stepName: string | null;
  harnessId: string;
  model: string | null;
  mode: string;
  accessLevel: number;
  profileId: string | null;
  /** Known only when an agent profile identifies the account; otherwise null (Unknown). */
  accountId: string | null;
  /** The router's reading when the Owner granted. Never upgraded afterwards. */
  quotaEvidence: string;
}

export interface AutonomyPlanEvidence {
  previewKey: string;
  entries: { taskId: string; signature: string; fingerprint: string; dependsOn: string[] }[];
  queue: { queueId: string; planKey: string; queueRevision: number } | null;
}

export interface AutonomyGrant {
  id: string;
  batchId: string;
  status: AutonomyStatus;
  approvedAt: number;
  /** Always the Owner. Recorded so a later reader can't mistake it for an automatic act. */
  approvedBy: "owner";
  expiresAt: number;
  taskIds: string[];
  resources: AutonomyResource[];
  maxRuns: number;
  maxParallelism: number;
  /** Resources whose quota was Unknown when the Owner accepted running anyway. */
  acknowledgedUnknownQuota: { harnessId: string; model: string | null; evidence: string }[];
  planEvidence: AutonomyPlanEvidence;
  stopConditions: string[];
  /** Run count and concurrency are enforced locally; money is not measured. */
  cost: "run-count-only";
  endedAt: number | null;
  endReason: { code: string; text: string } | null;
  /** Bumped each time the Owner resumes; separates one stop from the next in the Journal. */
  epoch: number;
}

export const AUTONOMY_STOP_CONDITIONS: readonly string[] = [
  "The grant's deadline passes.",
  "The Run budget is used up.",
  "You revoke the grant, or pause, cancel or stop the batch.",
  "A task, its agent, model, account, permission mode or dependencies change after the grant.",
  "A resource is verified exhausted, denied or prohibited.",
  "A task would need Full access or a broader permission mode than granted.",
  "Another batch also holds one of the tasks.",
];

/* ────────────────────────────────────────────────────────────────────────── *
 * Permission modes an autonomous run may use.
 * ────────────────────────────────────────────────────────────────────────── */

export interface ModeVerdict {
  allowed: boolean;
  reason: string | null;
}

const MODE_POLICY: Record<AgentKind, Record<string, string | null>> = {
  // `null` = allowed; a string = why it is not.
  "claude-code": {
    plan: null,
    ask: null,
    acceptEdits: null,
    auto: null,
    bypass: "Bypass passes --dangerously-skip-permissions: no classifier and no prompts.",
  },
  codex: {
    ask: null,
    auto: null,
    "full-access": "Full access runs codex with danger-full-access.",
  },
  cursor: {
    ask: null,
    auto: "Auto passes --force --sandbox disabled: tools run with no sandbox.",
  },
  gemini: {
    ask: null,
    auto: "Auto passes --yolo: every tool call is approved with no sandbox.",
  },
  fx: {
    ask: null,
    auto: null,
    yolo: "Full access disables fx's permission checks entirely.",
  },
  antigravity: {
    plan: null,
    ask: null,
    auto: "Auto passes --dangerously-skip-permissions: no permission checks at all.",
  },
  custom: {
    manual: "Custom CLIs run with ordinary macOS user permissions and are not admitted for unattended autonomous runs.",
    automated: "Custom CLIs are not admitted for unattended autonomous runs.",
  },
};

/**
 * Whether a mode may run unattended under a grant. A mode is allowed only when
 * the existing launch contract keeps a restriction in force (a sandbox, the
 * provider's own classifier or approval prompts); anything that removes every
 * check, and any mode id this table doesn't know, is not. Owners can still run
 * those by hand.
 */
export function autonomyModeVerdict(kind: AgentKind | null, mode: string): ModeVerdict {
  if (!kind) return { allowed: false, reason: "The agent's harness is unknown." };
  const entry = MODE_POLICY[kind];
  if (!entry || !(mode in entry)) return { allowed: false, reason: `Permission mode “${mode}” has no autonomy rule, so it isn't allowed.` };
  const reason = entry[mode];
  return reason ? { allowed: false, reason } : { allowed: true, reason: null };
}

/* ────────────────────────────────────────────────────────────────────────── *
 * The decision.
 * ────────────────────────────────────────────────────────────────────────── */

export interface RunGateFacts {
  origin: AutonomyOrigin;
  now: number;
  /** Batch status as stored. */
  batchStatus: string;
  /** The task a Run would belong to, resolved to the batch entry (a step → its pipeline task). */
  rootTaskId: string;
  /** Another active batch also holds the root task. */
  competingBatches: number;
  /** `approval.previewKey` now. */
  approvalPreviewKey: string | null;
  /** Live checks on the batch entry. */
  entry: {
    present: boolean;
    signatureNow: string | null;
    approvedSignature: string | null;
    fingerprintOk: boolean;
    dependenciesSame: boolean;
    dependenciesDone: boolean;
    tombstones: boolean;
  };
  /** Runs counted for the grant's scope since it was granted, and those still running. */
  used: number;
  live: number;
  /**
   * The agent the Run would use. Null for a pipeline task itself (it never runs
   * an agent; each step is checked as its own Run).
   */
  current: { harnessId: string; kind: AgentKind | null; model: string | null; mode: string; accessLevel: number; accountId: string | null } | null;
}

export type RunGateVerdict =
  | { allowed: true }
  | { allowed: false; code: string; reason: string };

const deny = (code: string, reason: string): RunGateVerdict => ({ allowed: false, code, reason });

/** Effective status without writing it: a clock or a counter can end a grant. */
export function effectiveGrantStatus(grant: AutonomyGrant, now: number, used: number): AutonomyStatus {
  if (grant.status !== "active") return grant.status;
  if (now >= grant.expiresAt) return "expired";
  if (used >= grant.maxRuns) return "exhausted";
  return "active";
}

/**
 * May ONE more Run be recorded for this task, under this grant, right now?
 * Every check is a hard stop; none is a warning. Nothing is substituted.
 */
export function evaluateAutonomousRun(grant: AutonomyGrant, facts: RunGateFacts): RunGateVerdict {
  if (grant.status === "revoked") return deny("grant-revoked", "You revoked this autonomous grant. No further Run starts without a new decision from you.");
  if (grant.status === "expired" || facts.now >= grant.expiresAt) return deny("grant-expired", "The autonomous grant expired. Grant it again to continue.");
  if (grant.status === "exhausted" || facts.used >= grant.maxRuns) {
    return deny("grant-exhausted", `The grant's Run budget (${grant.maxRuns}) is used up. Grant a new budget to continue.`);
  }
  if (facts.batchStatus !== "running") return deny("batch-not-running", `The batch is ${facts.batchStatus}. Autonomous Runs only happen while it is running.`);
  if (AUTONOMY_FORBIDDEN_ORIGINS.includes(facts.origin)) {
    return deny("origin-not-granted", "Automatic fx resume isn't covered by a bounded grant. Resume it yourself, or revoke the grant.");
  }
  if (facts.competingBatches > 0) return deny("competing-batch", "Another active batch also holds this task.");
  if (!grant.taskIds.includes(facts.rootTaskId) || !facts.entry.present) return deny("task-not-granted", "This task isn't in the grant.");
  if (facts.approvalPreviewKey !== grant.planEvidence.previewKey) return deny("plan-changed", "The batch approval changed since the grant.");
  const frozen = grant.planEvidence.entries.find((item) => item.taskId === facts.rootTaskId);
  if (!frozen || frozen.signature !== facts.entry.approvedSignature || facts.entry.signatureNow !== frozen.signature) {
    return deny("configuration-changed", "The task's agent configuration changed since the grant.");
  }
  if (!facts.entry.fingerprintOk) return deny("task-changed", "The task's prompt or settings changed since the grant.");
  if (!facts.entry.dependenciesSame) return deny("dependencies-changed", "The task's dependency links changed since the grant.");
  if (facts.entry.tombstones) return deny("dependency-deleted", "A prerequisite of this task was deleted and the link hasn't been cleared.");
  if (!facts.entry.dependenciesDone) return deny("dependency-not-done", "A dependency is no longer Done.");
  if (facts.live >= grant.maxParallelism) return deny("parallelism-reached", `The grant allows ${grant.maxParallelism} Run${grant.maxParallelism === 1 ? "" : "s"} at a time.`);
  const current = facts.current;
  if (current) {
    const mode = autonomyModeVerdict(current.kind, current.mode);
    if (!mode.allowed) return deny("mode-not-allowed", `${mode.reason} Autonomous runs never use it.`);
    const bound = grant.resources.filter((item) => item.taskId === facts.rootTaskId);
    const same = bound.filter((item) => item.harnessId === current.harnessId && (item.model ?? null) === (current.model ?? null));
    if (same.length === 0) {
      return deny("resource-not-granted", `${current.harnessId}${current.model ? ` · ${current.model}` : ""} isn't what was granted for this task. No other model or harness is tried.`);
    }
    const exact = same.filter((item) => item.mode === current.mode);
    if (exact.length === 0) {
      return deny("permission-changed", `Permission mode “${current.mode}” isn't what was granted for this task.`);
    }
    if (!exact.some((item) => current.accessLevel <= item.accessLevel)) {
      return deny("permission-broadened", "It would run with broader permissions than were granted.");
    }
    if (!exact.some((item) => item.accountId === current.accountId)) {
      return deny("account-changed", "The account identified for this agent changed since the grant. Accounts are never switched automatically.");
    }
  }
  return { allowed: true };
}

/** Readable origin names for events and the UI. */
export const AUTONOMY_ORIGIN_LABEL: Record<AutonomyOrigin, string> = {
  batch: "batch start",
  "pipeline-step": "pipeline step",
  "handoff-reminder": "handoff reminder",
  "fx-auto-resume": "fx auto-resume",
};

export function sanitizeGrant(raw: unknown): AutonomyGrant | null {
  if (!raw || typeof raw !== "object") return null;
  const g = raw as Record<string, unknown>;
  const status = g.status;
  if (typeof g.id !== "string" || typeof g.batchId !== "string") return null;
  if (status !== "active" && status !== "exhausted" && status !== "expired" && status !== "revoked") return null;
  const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : null);
  const approvedAt = num(g.approvedAt);
  const expiresAt = num(g.expiresAt);
  const maxRuns = num(g.maxRuns);
  const maxParallelism = num(g.maxParallelism);
  if (approvedAt == null || expiresAt == null || maxRuns == null || maxParallelism == null) return null;
  if (!Array.isArray(g.taskIds) || !Array.isArray(g.resources)) return null;
  const evidence = g.planEvidence as AutonomyPlanEvidence | undefined;
  if (!evidence || typeof evidence !== "object" || typeof evidence.previewKey !== "string" || !Array.isArray(evidence.entries)) return null;
  return {
    id: g.id,
    batchId: g.batchId,
    status,
    approvedAt,
    approvedBy: "owner",
    expiresAt,
    taskIds: g.taskIds.filter((id): id is string => typeof id === "string"),
    resources: g.resources as AutonomyResource[],
    maxRuns,
    maxParallelism,
    acknowledgedUnknownQuota: Array.isArray(g.acknowledgedUnknownQuota) ? (g.acknowledgedUnknownQuota as AutonomyGrant["acknowledgedUnknownQuota"]) : [],
    planEvidence: { previewKey: evidence.previewKey, entries: evidence.entries, queue: evidence.queue ?? null },
    stopConditions: Array.isArray(g.stopConditions) ? g.stopConditions.filter((s): s is string => typeof s === "string") : [...AUTONOMY_STOP_CONDITIONS],
    cost: "run-count-only",
    endedAt: num(g.endedAt),
    endReason: g.endReason && typeof g.endReason === "object" ? (g.endReason as AutonomyGrant["endReason"]) : null,
    epoch: num(g.epoch) ?? 0,
  };
}

/** Owner-facing sentence for an unknown-quota acknowledgement. Never says "remaining". */
export function unknownQuotaText(items: readonly { harnessId: string; model: string | null; evidence: string }[]): string {
  if (items.length === 0) return "";
  const names = items.map((item) => `${item.harnessId}${item.model ? ` · ${item.model}` : ""} (${item.evidence})`).join(", ");
  return `Provider quota isn't verified for ${names}. Your grant limits how many Runs start; it does not make the quota known, and it never switches to another executor.`;
}

/** Why a grant can't be made as things stand. */
export interface GrantBlocker {
  taskId: string | null;
  code: string;
  message: string;
}

/** What the Owner reviews before allowing autonomous execution. Read-only: nothing is stored by building it. */
export interface AutonomyPreview {
  batchId: string;
  limits: typeof AUTONOMY_LIMITS;
  defaults: { maxRuns: number; maxParallelism: number; ttlMinutes: number };
  taskIds: string[];
  resources: AutonomyResource[];
  blockers: GrantBlocker[];
  unknownQuota: { harnessId: string; model: string | null; evidence: string }[];
  unknownQuotaText: string;
  stopConditions: readonly string[];
  /** Run count and concurrency are limits ForgeOrbit enforces; money and provider quota are not. */
  costNote: string;
  previewKey: string | null;
}
