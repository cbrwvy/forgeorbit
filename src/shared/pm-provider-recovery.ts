/**
 * FO-AUTO03-RECOVERY-FIX01 — Owner-approved one supplemental Reviewer launch after
 * confirmed provider quota failure on a gated orchestrated batch.
 */
import type { OrchestratedWorkflowCounters, OrchestratedWorkflowGrant } from "./pm-orchestrated-workflow.ts";
export { runStderrProvesQuotaExhausted, trustedCodexQuotaProof } from "./codex-quota-failure.ts";
export type { CodexQuotaEvent, CodexQuotaProofDetail, CodexQuotaRun } from "./codex-quota-failure.ts";

export const PROVIDER_RECOVERY_LIMITS = {
  supplementalLaunches: 1,
  validMinutes: { min: 5, max: 240, default: 60 },
} as const;

export const PROVIDER_RECOVERY_STATUSES = [
  "approved",
  "applied",
  "consumed",
  "expired",
  "cancelled",
] as const;
export type ProviderRecoveryStatus = (typeof PROVIDER_RECOVERY_STATUSES)[number];

export type ProviderRecoveryFailureClass = "quota-exhausted";

export interface ProviderRecoveryAuditEntry {
  event: string;
  at: number;
  detail?: string;
}

/** One Owner decision to replace a verified pre-launch failure. It does not extend the original approval. */
export interface ProviderRecoveryPrelaunchReauthorization {
  id: string;
  status: "approved" | "applied" | "expired" | "cancelled";
  approvedAt: number;
  approvedBy: "owner";
  expiresAt: number;
  reason: string;
  failedGrantId: string;
  classification: "proven-prelaunch-failure";
  replacementPhaseGrantId: string | null;
  appliedAt: number | null;
}

export interface ProviderRecoveryAuthorization {
  id: string;
  batchId: string;
  taskId: string;
  projectPath: string;
  status: ProviderRecoveryStatus;
  failedReviewerRunId: string;
  failedReviewerPhaseGrantId: string;
  failedQcReviewId: string;
  developerRunId: string;
  evidenceBundleDigest: string;
  sourceFingerprint: string;
  reviewerHarnessId: string;
  reviewerModel: string;
  failureClass: ProviderRecoveryFailureClass;
  failureDetail: string;
  reason: string;
  approvedAt: number;
  approvedBy: "owner";
  expiresAt: number;
  supplementalMaxLaunches: 1;
  supplementalLaunchesConsumed: number;
  recoveryPhaseGrantId: string | null;
  appliedAt: number | null;
  audit: ProviderRecoveryAuditEntry[];
  createdAt: number;
  updatedAt: number;
  /** Absent on recoveries approved before FO-AUTO03-RECOVERY-LAUNCH-FIX03. */
  prelaunchReauthorization?: ProviderRecoveryPrelaunchReauthorization | null;
}

export type PrelaunchClaimClassification =
  | {
      kind: "proven-prelaunch-failure";
      recoveryId: string;
      grantId: string;
      operation: "bind-implementation" | "prepare-qc-review";
      message: string;
      implementationRunId: string | null;
      developerRunId: string;
      failedReviewerRunId: string;
    }
  | { kind: "manual-review"; recoveryId: string; grantId: string | null; reason: string }
  | { kind: "launched"; recoveryId: string; grantId: string; runId: string };

export interface ProviderRecoveryPreview {
  eligible: boolean;
  blockers: string[];
  batchId: string | null;
  taskId: string;
  failedReviewerRunId: string | null;
  failedReviewerPhaseGrantId: string | null;
  failedQcReviewId: string | null;
  developerRunId: string | null;
  evidenceBundleDigest: string | null;
  sourceFingerprint: string | null;
  reviewerHarnessId: string | null;
  reviewerModel: string | null;
  failureClass: ProviderRecoveryFailureClass | null;
  failureDetail: string | null;
  frozenMaxLaunches: number | null;
  launchesUsed: number | null;
  remainingOrdinaryLaunches: number | null;
  authorization: ProviderRecoveryAuthorization | null;
}

export function clampProviderRecoveryMinutes(value: unknown): number {
  const n = typeof value === "number" ? value : PROVIDER_RECOVERY_LIMITS.validMinutes.default;
  if (!Number.isFinite(n)) return PROVIDER_RECOVERY_LIMITS.validMinutes.default;
  return Math.min(
    PROVIDER_RECOVERY_LIMITS.validMinutes.max,
    Math.max(PROVIDER_RECOVERY_LIMITS.validMinutes.min, Math.trunc(n)),
  );
}

/** Frozen budget remaining — never includes supplemental allowance. */
export function ordinaryLaunchesRemaining(grant: OrchestratedWorkflowGrant, counters: OrchestratedWorkflowCounters): number {
  return Math.max(0, grant.maxLaunches - counters.launchesUsed);
}

/**
 * Text that proves QC preparation failed before a Reviewer process existed.
 * Provider usage-limit sentences are intentionally not included.
 */
export function isPreparationFailureText(text: string): boolean {
  return text.includes("Reviewer preparation failed before launch")
    || text.includes("Quality review requires a succeeded implementation run.")
    || /Maximum \d+ review rounds reached/.test(text);
}

export function supplementalLaunchesRemaining(auth: ProviderRecoveryAuthorization | null, now: number): number {
  if (!auth) return 0;
  if (auth.status === "cancelled" || auth.status === "consumed") return 0;
  if (auth.supplementalLaunchesConsumed >= auth.supplementalMaxLaunches) return 0;
  const reauth = auth.prelaunchReauthorization ?? null;
  // A replacement decision has its own deadline. It does not extend the original approval.
  if (reauth?.status === "applied" && reauth.expiresAt > now) return 1;
  if (auth.status !== "applied" && auth.status !== "approved") return 0;
  if (auth.expiresAt <= now) return 0;
  return auth.supplementalMaxLaunches - auth.supplementalLaunchesConsumed;
}

/** Launch allowed when ordinary budget remains or a valid supplemental allowance exists. */
export function effectiveLaunchesRemaining(
  grant: OrchestratedWorkflowGrant,
  counters: OrchestratedWorkflowCounters,
  supplemental: ProviderRecoveryAuthorization | null,
  now = Date.now(),
): number {
  const ordinary = ordinaryLaunchesRemaining(grant, counters);
  if (ordinary > 0) return ordinary;
  return supplementalLaunchesRemaining(supplemental, now);
}
