import type { TrustedQuotaEvidence } from "./quota-sources.ts";
import type { ProviderQuotaEvidence } from "./provider-evidence.ts";
/** FO-009A: metadata and observations, never credentials or execution configuration. */
export type Provenance = "unknown" | "user-provided" | "observed" | "verified";
export type Verification = "unknown" | "unverified" | "verified";
export interface Evidence { provenance: Provenance; source: string; verification: Verification }
export interface Account extends Evidence {
  codexProfile?: import("./codex-profile.ts").CodexProfile;
  claudeProfile?: import("./claude-profile.ts").ClaudeProfile;
  id: string; provider: string; displayName: string; externalIdentity: string | null;
  availability: "unknown" | "available" | "unavailable";
  createdAt: number; updatedAt: number; archivedAt: number | null;
}
export interface Binding extends Evidence { accountId: string; harnessId: string; createdAt: number }
export interface ProfileAssociation { accountId: string; harnessId: string; profileId: string; createdAt: number }
export interface Subscription extends Evidence {
  id: string; provider: string; planLabel: string; currency: string | null;
  recurringCostMinor: number | null; billingPeriod: "unknown" | "month" | "year" | "week" | "day";
  renewsAt: number | null; resetsAt: number | null; createdAt: number; updatedAt: number; archivedAt: number | null;
}
export type QuotaUnit =
  | { kind: "requests" | "tokens" | "concurrency" | "percentage" }
  | { kind: "compute-time"; name: "milliseconds" | "seconds" }
  /** Monetary quantities use integer minor units of the named currency. */
  | { kind: "money"; currency: string }
  | { kind: "provider-specific"; name: string };
export type QuotaCategory = "subscription" | "api-rate" | "api-credit" | "organization-budget" | "other";
export interface QuotaDefinition {
  category?: QuotaCategory;
  windowMs?: number | null;
  /** Explicit membership of one shared model group, never a separate balance per model. */
  modelIds?: string[];
  warnAtRemainingPercent?: number | null;
  id: string; accountId: string; subscriptionId: string | null;
  scope: string; unit: QuotaUnit; window: string; createdAt: number; archivedAt: number | null;
}
export interface QuotaObservation extends Evidence {
  id: string; quotaId: string; observedAt: number; expiresAt: number | null; resetAt: number | null;
  limit: number | null; used: number | null; remaining: number | null;
  indicator: { kind: "percent-used" | "percent-remaining"; value: number } | null;
  confidence: "unknown" | "low" | "medium" | "high";
  sourceNote?: string;
  evidenceReference?: string;
  revises?: string;
  recordedAt?: number;
  acquisition?: TrustedQuotaEvidence;
  /** FO-ORCH03: diagnostic provider reading. Present only on `observed:*` sources, always unverified. */
  evidence?: ProviderQuotaEvidence;
}
export interface QuotaState {
  definition: QuotaDefinition;
  status: "unknown" | "current" | "stale" | "conflict";
  observations: QuotaObservation[];
  current: QuotaObservation | null;
  warnings: string[];
}
export interface ResourceIdentity {
  accountId: string | null; provenance: Provenance; verification: Verification;
  subscriptionIds: string[]; warnings: string[];
}
export interface ModelCapability extends Evidence {
  accountId: string; harnessId: string; modelId: string;
  support: "unknown" | "supported" | "unsupported";
  observedAt: number; expiresAt: number | null;
}
export type SourceCapability = "supported-safe" | "user-provided-only" | "unsupported" | "unknown";
