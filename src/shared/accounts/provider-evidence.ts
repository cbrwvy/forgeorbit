/** FO-ORCH03: provider quota evidence contract. Read-only observations, never credentials.
 * Evidence here is diagnostic: it can describe a provider bucket but never proves that the next
 * request of a chosen model will be accepted. It is always stored as unverified, so the router
 * keeps treating it as Unknown. */
export type EvidenceAuthMode = "chatgpt" | "apiKey" | "amazonBedrock" | "none" | "unknown";
/** `observed-correlated`: provider-reported, and two reads of the same session name the same account.
 * `observed`: provider-reported without that correlation. Neither is `verified`: no documented
 * provider subject exists and the Owner never bound one. */
export type EvidenceQuality = "observed-correlated" | "observed" | "unknown";
export type IdentityCorrelation = "matched" | "absent" | "mismatch";
export type ModelScope = { kind: "confirmed"; slug: string } | { kind: "unconfirmed" };

/** Stored on a QuotaObservation. Raw values stay as reported; nothing is converted to requests. */
export interface ProviderQuotaEvidence {
  schema: 1;
  provider: "openai";
  harnessKind: "codex";
  harnessId: string;
  source: "codex app-server account/rateLimits/read";
  /** The Owner's declaration (account ↔ harness binding). It is not provider verification. */
  association: { basis: "owner-declared-harness-binding"; identityVerified: false };
  identity: { fingerprint: string | null; correlation: IdentityCorrelation };
  authMode: EvidenceAuthMode;
  planType: string | null;
  bucketId: string;
  bucketName: string | null;
  modelScope: ModelScope;
  slot: "primary" | "secondary";
  metric: "percent-used";
  rawValue: number | null;
  unit: "percent of the reporting window";
  windowMins: number | null;
  /** Provider-reported limit-reached marker; null when the provider reported none. */
  reachedType: string | null;
  exhausted: "reported" | "not-reported";
  /** Response-level flag (not per bucket). */
  ordinaryUsageAllowed: boolean | null;
  quality: EvidenceQuality;
  unknownReason: string | null;
  receivedAt: number;
}

export type EvidenceFreshness = "fresh" | "stale" | "unknown";
/** Observation-time rule: a missing TTL is unknown, a past expiry or reset is stale. */
export function evidenceFreshness(o: { observedAt: number; expiresAt: number | null; resetAt: number | null }, now: number): EvidenceFreshness {
  if (o.expiresAt === null) return "unknown";
  if (o.expiresAt <= now || o.observedAt > now) return "stale";
  if (o.resetAt !== null && o.resetAt <= now) return "stale";
  return "fresh";
}

/** Why this item can never select an executor on its own. Always non-empty: nothing here is verified. */
export function autoSelectionBlockers(e: ProviderQuotaEvidence, freshness: EvidenceFreshness): string[] {
  const reasons = ["Provider subject is not verified and the Owner has not bound one; the account link is a declaration."];
  if (e.identity.correlation === "mismatch") reasons.push("Account identity differs between provider reads; evidence is unusable.");
  if (e.modelScope.kind === "unconfirmed") reasons.push("The provider did not tie this bucket to a specific model.");
  if (e.metric === "percent-used") reasons.push("Only a used percentage is known; remaining requests or tokens are unknown.");
  if (freshness !== "fresh") reasons.push(freshness === "stale" ? "Evidence is stale." : "Freshness is unknown.");
  if (e.unknownReason) reasons.push(e.unknownReason);
  reasons.push("Even a bucket with room does not prove the next request for a given model will be accepted.");
  return reasons;
}

export interface ProviderEvidenceItem {
  quotaId: string;
  evidence: ProviderQuotaEvidence;
  observedAt: number;
  expiresAt: number | null;
  resetAt: number | null;
  freshness: EvidenceFreshness;
  autoSelectionBlockers: string[];
}
/** In-memory (never persisted) part of the last collection. Email and the provider account id are never kept. */
export interface ProviderEvidenceSession {
  collectedAt: number;
  expiresAt: number;
  harnessId: string;
  cliVersion: string | null;
  authMode: EvidenceAuthMode;
  planType: string | null;
  catalog: { count: number; modelIds: string[]; note: string } | null;
  ordinaryUsageAllowed: boolean | null;
  credits: { hasCredits: boolean; unlimited: boolean } | null;
  identity: { fingerprint: string | null; correlation: IdentityCorrelation };
  unknownReasons: string[];
}
export interface ProviderEvidenceView {
  accountId: string;
  provider: "openai";
  items: ProviderEvidenceItem[];
  session: (ProviderEvidenceSession & { freshness: EvidenceFreshness }) | null;
  /** Interfaces that exist for other providers but yield no quota evidence. */
  limitations: string[];
  disclaimer: string;
}
export const PROVIDER_EVIDENCE_DISCLAIMER = "Usage percentages are diagnostic data reported by the provider for one bucket and window. They are not a guaranteed number of future requests, and a bucket with room does not prove that a chosen model will accept the next request.";
