/**
 * The Owner's one native confirmation for a project's hands-off work ("project envelope").
 *
 * The Owner signs an envelope, never a launch: which project, which Codex harness and account, which models and modes
 * for the Developer and the read-only Reviewer, which delivery steps, how many provider launches and until when.
 * Each launch inside the envelope then receives a single-use child grant from it, checked against the live policy,
 * the live task and Emergency Stop at the moment of the launch. Pure; no runtime imports from either process side.
 */
import { hasResource, type HandsoffPolicy, type HandsoffResourceRef } from "./handsoff.ts";

export const HANDSOFF_AUTH_LIMITS = {
  /** The signed document may be valid for at most this long (the existing bounded-grant ceiling). */
  maxHours: 24,
  defaultHours: 24,
  minLaunches: 1,
  maxLaunches: 60,
  defaultLaunches: 12,
} as const;

export const HANDSOFF_ENVELOPE_KIND = "project-envelope" as const;

/** What is actually signed, in plain fields. Every field is also enforced at launch. */
export interface HandsoffEnvelope {
  v: 1;
  /** Digest of the canonical project path and its registration time. A removed and re-added project is another project. */
  projectIdentity: string;
  projectPath: string;
  harnessIds: string[];
  /** Registered account ids. A launch whose resolved account is not listed is refused. */
  accountIds: string[];
  /** The exact role + harness + account pairs covered. A pair that is not listed is refused, whatever else is. */
  resources: HandsoffResourceRef[];
  /** Router-eligible models for each role at the moment of authorization. A model that appears later is not covered. */
  developerModels: string[];
  reviewerModels: string[];
  /** Codex Auto in the isolated working copy; the Reviewer's read-only contract. Never a wider mode. */
  developerMode: "auto";
  reviewerMode: "read-only";
  runOfflineTests: boolean;
  autoApply: boolean;
  autoDone: boolean;
  acknowledgeUsageNotice: boolean;
  maxFixRounds: number;
  launchBudget: number;
}

/** The envelope the current saved policy would need. Models come from the Router at authorization time. */
export function envelopeFrom(input: {
  policy: HandsoffPolicy;
  projectPath: string;
  projectIdentity: string;
  developerModels: string[];
  reviewerModels: string[];
  launchBudget: number;
}): HandsoffEnvelope {
  const { policy } = input;
  return {
    v: 1,
    projectIdentity: input.projectIdentity,
    projectPath: input.projectPath,
    harnessIds: [...policy.harnessIds].sort(),
    accountIds: [...policy.accountIds].sort(),
    resources: policy.resources.map((r) => ({ role: r.role, harnessId: r.harnessId, accountKey: r.accountKey })),
    developerModels: [...new Set(input.developerModels)].sort(),
    reviewerModels: [...new Set(input.reviewerModels)].sort(),
    developerMode: "auto",
    reviewerMode: "read-only",
    runOfflineTests: policy.runOfflineTests,
    autoApply: policy.autoApply,
    autoDone: policy.autoDone,
    acknowledgeUsageNotice: policy.acknowledgeUsageNotice,
    maxFixRounds: policy.maxFixRounds,
    launchBudget: input.launchBudget,
  };
}

/**
 * Is the live policy still inside what the Owner signed? Narrowing is fine and never asks again; anything wider, or a
 * different project, does. Cosmetic fields (auto-assign, parallelism, requiring a test) are not part of the envelope.
 */
export function policyWithinEnvelope(policy: HandsoffPolicy, envelope: HandsoffEnvelope): { ok: true } | { ok: false; reasons: string[] } {
  const reasons: string[] = [];
  const subset = (live: string[], signed: string[]) => live.every((id) => signed.includes(id));
  if (!policy.enabled) reasons.push("off");
  if (!subset(policy.harnessIds, envelope.harnessIds)) reasons.push("harnesses");
  if (!subset(policy.accountIds, envelope.accountIds)) reasons.push("accounts");
  if (!policy.resources.every((r) => hasResource(envelope.resources, r.role, r.harnessId, r.accountKey))) reasons.push("resources");
  if (policy.runOfflineTests && !envelope.runOfflineTests) reasons.push("tests");
  if (policy.autoApply && !envelope.autoApply) reasons.push("apply");
  if (policy.autoDone && !envelope.autoDone) reasons.push("done");
  if (policy.acknowledgeUsageNotice && !envelope.acknowledgeUsageNotice) reasons.push("billing");
  if (policy.maxFixRounds > envelope.maxFixRounds) reasons.push("fix-rounds");
  return reasons.length === 0 ? { ok: true } : { ok: false, reasons };
}

export type HandsoffAuthorizationState =
  | "not-required"
  | "off"
  | "not-authorized"
  | "active"
  | "expired"
  | "needs-renewal"
  | "exhausted"
  | "revoked";

export interface HandsoffAuthorizationView {
  state: HandsoffAuthorizationState;
  /** Why `needs-renewal` (fields that widened), or the reason a state is not active. */
  reasons: string[];
  /** Whether the previous authorization is still usable after a failed or cancelled attempt. */
  expiresAt: number | null;
  launchBudget: number | null;
  launchesUsed: number | null;
  launchesRemaining: number | null;
  envelope: HandsoffEnvelope | null;
  authorizedAt: number | null;
  /** True when this build asks for a native confirmation before provider launches. */
  required: boolean;
}

/** Launch claim identity: the same logical launch can never be claimed twice. */
export function launchClaimKey(input: { handsoffRunId: string; role: "developer" | "reviewer"; round: number; intentAt: number }): string {
  return `${input.handsoffRunId}:${input.role}:${input.round}:${input.intentAt}`;
}
