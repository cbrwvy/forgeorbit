import { codexUsageLimitRetryHint, isCodexProviderAgent, legacyCodexUsageLimitLine, trustedCodexQuotaProof, type CodexQuotaEvent } from "./codex-quota-failure.ts";
/**
 * Provider refusal observations (FO-REAL-UI01 follow-up).
 *
 * A signed-in account can still be refused by the provider. A refusal is what the provider said
 * about ONE request for ONE account, harness and model. It is not a balance, a spend, a quota
 * reset or a verdict about other models or accounts, and it never becomes capacity or readiness.
 * The retry hint is the provider's own words: it names no time zone, so it is never converted.
 */
export const PROVIDER_REFUSAL_KINDS = ["usage-limit"] as const;
export type ProviderRefusalKind = (typeof PROVIDER_REFUSAL_KINDS)[number];

/** How the refusal was proven. Both come from provider execution evidence, never model text. */
export type ProviderRefusalProof = "usage_limit_exceeded" | "codex-cli-usage-limit";

export interface ProviderRefusalSummary {
  id: string;
  kind: ProviderRefusalKind;
  provider: string;
  harnessId: string;
  /** The registered account the harness is bound to, or null when the account is not identified. */
  accountId: string | null;
  modelId: string | null;
  /** ForgeOrbit's clock when the refusal was recorded. */
  observedAt: number;
  surface: string;
  proof: ProviderRefusalProof;
  /** The provider's own retry words, verbatim, or null. No time zone is stated. */
  retryHint: string | null;
  /** Set when a later successful provider answer for the same scope was observed. */
  supersededAt: number | null;
  /** Redacted, capped provider diagnostics for the Details disclosure. Never credentials. */
  diagnostics: string;
  /** The account's display name when the reader could resolve it. Display only; never a scope key. */
  accountLabel?: string | null;
}

export interface ProviderRefusalScope {
  harnessId: string;
  accountId: string | null;
  modelId: string | null;
}

/** An old refusal is still a hold for automatic dispatch until a matching answer
 * or an explicit retry. Age alone cannot establish a reset. */
export const PROVIDER_REFUSAL_FRESHNESS_MS = 24 * 60 * 60_000;

export function providerRefusalFreshness(refusal: ProviderRefusalSummary, now: number): "fresh" | "stale" {
  return refusal.supersededAt === null && now >= refusal.observedAt &&
    now - refusal.observedAt < PROVIDER_REFUSAL_FRESHNESS_MS ? "fresh" : "stale";
}

export const PROVIDER_LIMIT_REASON = "provider-usage-limit: The provider reported a usage limit for this operation.";

/**
 * A refusal speaks only for what it was observed on. An unidentified account is its own scope: it
 * never covers a registered account, and a registered account's refusal never covers another one.
 * A refusal with no model covers the account's requests; one with a model covers that model only.
 */
export function refusalApplies(refusal: Pick<ProviderRefusalSummary, "harnessId" | "accountId" | "modelId" | "supersededAt">, scope: ProviderRefusalScope): boolean {
  if (refusal.supersededAt !== null) return false;
  if (refusal.harnessId !== scope.harnessId) return false;
  if (refusal.accountId !== scope.accountId) return false;
  return refusal.modelId === null || refusal.modelId === scope.modelId;
}

/**
 * A successful provider answer ends a refusal only for the exact scope it answered on: the same
 * harness, the same account (an unidentified answer only for an unidentified refusal) and the same
 * model. An account-wide refusal (no model) is never ended by an answer on one model, and an answer on
 * one model never ends a refusal on another.
 */
export function refusalClearedBy(
  refusal: Pick<ProviderRefusalSummary, "harnessId" | "accountId" | "modelId" | "supersededAt">,
  answer: { harnessId: string; accountId: string | null; modelId: string },
): boolean {
  return refusal.supersededAt === null
    && refusal.harnessId === answer.harnessId
    && refusal.accountId === answer.accountId
    && refusal.modelId !== null
    && refusal.modelId === answer.modelId;
}

/** Fixed sentence so the preflight can be localized exactly. No time, hint or balance is stated. */
export const PROVIDER_REFUSAL_PREFLIGHT_WARNING =
  "The provider refused an earlier request for this account and model (usage limit). Sign-in is valid, but readiness to run is unconfirmed.";

/** Strict reader for a stored snapshot (a Head message keeps one as evidence). Anything else is dropped. */
export function sanitizeProviderRefusal(value: unknown): ProviderRefusalSummary | null {
  if (!value || typeof value !== "object") return null;
  const r = value as Record<string, unknown>;
  const text = (v: unknown, max: number): string | null => (typeof v === "string" ? v.slice(0, max) : null);
  const optional = (v: unknown, max: number): string | null => (typeof v === "string" && v ? v.slice(0, max) : null);
  if (!PROVIDER_REFUSAL_KINDS.includes(r.kind as ProviderRefusalKind)) return null;
  if (r.proof !== "usage_limit_exceeded" && r.proof !== "codex-cli-usage-limit") return null;
  const id = text(r.id, 80), provider = text(r.provider, 60), harnessId = text(r.harnessId, 200), surface = text(r.surface, 60);
  if (!id || !provider || !harnessId || !surface) return null;
  if (typeof r.observedAt !== "number" || !Number.isFinite(r.observedAt)) return null;
  return {
    id, kind: r.kind as ProviderRefusalKind, provider, harnessId,
    accountId: optional(r.accountId, 200), modelId: optional(r.modelId, 200),
    observedAt: r.observedAt, surface, proof: r.proof,
    retryHint: optional(r.retryHint, 120),
    supersededAt: typeof r.supersededAt === "number" && Number.isFinite(r.supersededAt) ? r.supersededAt : null,
    diagnostics: text(r.diagnostics, 700) ?? "",
    accountLabel: optional(r.accountLabel, 120),
  };
}

export interface ProviderRefusalEvidence {
  kind: ProviderRefusalKind;
  proof: ProviderRefusalProof;
  /** The provider's own retry words, verbatim, or null. */
  retryHint: string | null;
  /** The provider line, trimmed. The caller redacts it before storing. */
  diagnostics: string;
}

/**
 * The refusal a failed Codex process proves, or null. Trusted evidence only: the machine token or the
 * exact CLI sentence on a main-stream stderr `error:` / `turn.failed:` line, from a Codex agent with a
 * Codex session id. Assistant, user, status and tool text, generic rate limits, authentication errors
 * and unrelated failures never qualify.
 */
export function providerRefusalEvidence(agent: string, sessionId: string | null, events: CodexQuotaEvent[]): ProviderRefusalEvidence | null {
  if (!isCodexProviderAgent(agent)) return null;
  const proof = trustedCodexQuotaProof({ status: "failed", agent, codexSessionId: sessionId }, events);
  if (!proof) return null;
  const stderr = events.filter((event) => event.stream === "stderr" && (event.subagentId == null || event.subagentId === ""));
  const sentence = stderr.find((event) => legacyCodexUsageLimitLine(event.data));
  const line = sentence?.data ?? stderr.find((event) => event.data.includes("usage_limit_exceeded"))?.data ?? "";
  return {
    kind: "usage-limit",
    proof: proof.detail,
    retryHint: sentence ? codexUsageLimitRetryHint(sentence.data) : null,
    diagnostics: line.trim().slice(0, 700),
  };
}
