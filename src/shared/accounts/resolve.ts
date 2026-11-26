import { isSyntheticEvidenceSource } from "../usage-analytics.ts";
import type { QuotaDefinition, QuotaObservation, QuotaState, ResourceIdentity, Subscription } from "./types.ts";

/** A reset invalidates old evidence; it never proves replenishment. Missing TTL is not fresh. */
export function observationCurrent(o: QuotaObservation, now: number): boolean {
  return o.observedAt <= now && o.expiresAt !== null && o.expiresAt > now
    && (o.resetAt === null || o.resetAt > now);
}
export function resolveQuota(definition: QuotaDefinition, history: readonly QuotaObservation[], now: number): QuotaState {
  // Independent sources do not silently overwrite each other. Only a source's latest report supersedes it.
  const latest = new Map<string, QuotaObservation[]>();
  const superseded = new Set(history.flatMap(o => o.revises ? [o.revises] : []));
  for (const o of history.filter(o => o.quotaId === definition.id && o.observedAt <= now && !superseded.has(o.id))) {
    const prior = latest.get(o.source);
    if (!prior || o.observedAt > prior[0]!.observedAt) latest.set(o.source, [o]);
    else if (o.observedAt === prior[0]!.observedAt) prior.push(o);
  }
  const observations = [...latest.values()].flat();
  const active = observations.filter(o => observationCurrent(o, now));
  const warnings: string[] = [];
  if (observations.some(o => !observationCurrent(o, now))) warnings.push("Stale or undated freshness evidence is historical only.");
  const conflict = active.some((a, i) => active.slice(i + 1).some(b => disagree(a, b)));
  const status = definition.archivedAt !== null ? "unknown" : conflict ? "conflict" : active.length ? "current" : observations.length ? "stale" : "unknown";
  if (conflict) warnings.push("Current sources disagree; capacity is unknown.");
  if (!active.length) warnings.push("No current quota evidence; no replenishment is assumed.");
  // Do not combine complementary reports into a fabricated observation.
  return { definition, status, observations, current: status === "current" ? active.sort((a,b) => b.observedAt-a.observedAt || a.id.localeCompare(b.id))[0]! : null, warnings };
}
function disagree(a: QuotaObservation, b: QuotaObservation): boolean {
  for (const key of ["limit", "used", "remaining", "resetAt"] as const) {
    if (a[key] !== null && b[key] !== null && a[key] !== b[key]) return true;
  }
  if (a.indicator && b.indicator) {
    // Different semantics are kept separate, never converted implicitly.
    return a.indicator.kind !== b.indicator.kind || a.indicator.value !== b.indicator.value;
  }
  return false;
}
/** Future router helper: identity equality is not inferred from harness, name or plan. */
export function resourceRelationship(a: ResourceIdentity, b: ResourceIdentity): "same-account" | "shared-subscription" | "distinct-accounts" | "unknown" {
  if (!a.accountId || !b.accountId) return "unknown";
  if (a.accountId === b.accountId) return "same-account";
  if (a.subscriptionIds.some(id => b.subscriptionIds.includes(id))) return "shared-subscription";
  return "unknown";
}
/** Costs remain separate by currency AND period. Unknown prices are explicitly retained. */
export function subscriptionCommitments(subscriptions: readonly Subscription[]) {
  const unique = [...new Map(subscriptions.map(s => [s.id, s])).values()];
  const totals = new Map<string, { currency: string; billingPeriod: string; minor: number }>();
  const unknownIds: string[] = [];
  for (const s of unique) {
    if (s.recurringCostMinor === null || s.currency === null || s.billingPeriod === "unknown") { unknownIds.push(s.id); continue; }
    const key = `${s.currency}:${s.billingPeriod}`;
    const total = totals.get(key) ?? { currency: s.currency, billingPeriod: s.billingPeriod, minor: 0 };
    total.minor += s.recurringCostMinor;
    totals.set(key, total);
  }
  return { subscriptionIds: unique.map(s => s.id), totals: [...totals.values()], unknownIds };
}

/** Pure planning check for one explicitly selected quota; never pools independent definitions. */
export function assessQuotaDemand(state: QuotaState, demand: { quotaId: string; amount: number | null }): "unknown" | "fits" | "exceeds" {
  if (demand.quotaId !== state.definition.id || demand.amount === null || !Number.isFinite(demand.amount) || demand.amount < 0 || !state.current) return "unknown";
  const remaining = state.current.remaining;
  if (remaining === null) return "unknown";
  return demand.amount <= remaining ? "fits" : "exceeds";
}

/** A named model group is applicable only when its membership is explicitly known. */
export function quotaApplies(d: Pick<QuotaDefinition, "scope" | "modelIds">, harnessId: string, modelId: string): boolean {
  return d.scope === "account" || d.scope === `harness:${harnessId}` || d.scope === `model:${modelId}` ||
    d.scope.startsWith("group:") && d.modelIds?.includes(modelId) === true;
}

export function remainingPercent(o: Pick<QuotaObservation, "indicator" | "remaining" | "limit">): number | null {
  if (o.indicator) return o.indicator.kind === "percent-used" ? 100 - o.indicator.value : o.indicator.value;
  return o.remaining !== null && o.limit !== null && o.limit > 0 ? 100 * o.remaining / o.limit : null;
}

export function verifiedQuotaWindows(quotas: readonly QuotaState[], accountId: string, provider: string, harnessId: string, modelId: string, now: number) {
  return verifiedAccountQuotaWindows(quotas.filter(q => quotaApplies(q.definition, harnessId, modelId)), accountId, provider, now);
}

export function verifiedAccountQuotaWindows(quotas: readonly QuotaState[], accountId: string, provider: string, now: number) {
  return quotas.filter(q => q.definition.category !== "organization-budget" && q.definition.category !== "api-credit")
    .flatMap(q => {
      const proof = q.observations.filter(o => o.acquisition?.accountId === accountId && o.acquisition.provider === provider &&
        o.acquisition.method !== "provider-organization" && o.verification === "verified" && !isSyntheticEvidenceSource(o.source));
      // AccountCore marks an unavailable account or subscription Unknown. A separate manual
      // source cannot dilute a trusted reading or make an exhausted window pass permissively.
      return proof.length ? [q.status === "unknown" ? { ...q, current: null } : resolveQuota(q.definition, proof, now)] : [];
    });
}

export function quotaExhausted(observation: QuotaObservation): boolean {
  return observation.remaining === 0 || remainingPercent(observation) === 0;
}

export interface ExhaustedQuotaWindow {
  id: string;
  scope: string;
  window: string;
  source: string;
  observedAt: number;
  expiresAt: number | null;
  resetAt: number | null;
}

/** Retain a verified exhaustion until the published reset or a new reading.
 * Positive balances always obey freshness. */
export function exhaustedQuotaWindows(windows: readonly QuotaState[], now: number): ExhaustedQuotaWindow[] {
  return windows.flatMap(({ definition, status, current, observations }) => {
    if (status === "unknown" || status === "conflict") return [];
    const exhausted = current && quotaExhausted(current) ? current :
      !current ? observations.filter(o => (o.resetAt === null || o.resetAt > now) && quotaExhausted(o))
        .sort((a, b) => b.observedAt - a.observedAt)[0] : undefined;
    if (!exhausted) return [];
    return [{
      id: exhausted.id, scope: definition.scope, window: definition.window,
      source: exhausted.source, observedAt: exhausted.observedAt,
      expiresAt: exhausted.expiresAt, resetAt: exhausted.resetAt,
    }];
  });
}

/** Net window consumption, not task usage. Unknown reset means unknown window continuity. */
export function quotaDelta(newer: QuotaObservation, older: QuotaObservation) {
  const period = newer.acquisition?.period;
  const previousPeriod = older.acquisition?.period;
  const sameWindow = newer.resetAt !== null && newer.resetAt === older.resetAt && newer.resetAt > newer.observedAt ||
    period?.startAt != null && period.endAt != null && previousPeriod?.startAt === period.startAt &&
    previousPeriod.endAt === period.endAt && newer.observedAt < period.endAt && older.observedAt >= period.startAt;
  if (!sameWindow || newer.quotaId !== older.quotaId || newer.source !== older.source ||
    newer.verification !== older.verification || newer.observedAt <= older.observedAt ||
    newer.limit !== older.limit || newer.acquisition?.subject !== older.acquisition?.subject ||
    newer.acquisition?.sharedPool?.id !== older.acquisition?.sharedPool?.id ||
    newer.evidence?.harnessId !== older.evidence?.harnessId ||
    newer.evidence?.identity.fingerprint !== older.evidence?.identity.fingerprint) return null;
  const amount = newer.used !== null && older.used !== null ? newer.used - older.used
    : newer.remaining !== null && older.remaining !== null ? older.remaining - newer.remaining : null;
  const percent = newer.indicator && older.indicator && newer.indicator.kind === older.indicator.kind
    ? (newer.indicator.value - older.indicator.value) * (newer.indicator.kind === "percent-used" ? 1 : -1) : null;
  if ((amount !== null && amount < 0) || (percent !== null && percent < 0) || amount === null && percent === null) return null;
  return { amount, percent, from: older.observedAt, to: newer.observedAt };
}
