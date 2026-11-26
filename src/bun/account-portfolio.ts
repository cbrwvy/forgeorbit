import type { ResourceSnapshotInput, QuotaKnowledge, Fact } from "../shared/portfolio/types.ts";
import type { QuotaState } from "../shared/accounts/types.ts";
import { AccountCore } from "./account-core.ts";
import { allActiveProviderRefusals } from "./provider-refusals.ts";

/** FO-008A accepts one quota. Only a single account-wide compatible count can be projected.
 * Every independent window/unit/scope stays visible in the full account quota view. */
export function portfolioQuota(states: readonly QuotaState[]): { quota: QuotaKnowledge; origin: Fact<unknown>["origin"] } {
  const unknown = (reason: string) => ({ quota: { kind: "unknown" as const, reason }, origin: "unknown" as const });
  const limits = states.filter(s => s.definition.unit.kind !== "concurrency");
  if (limits.length !== 1) return unknown("No single account quota: inspect the independent quota observations.");
  const state = limits[0]!;
  const o = state.current;
  if (!o || state.definition.scope !== "account") return unknown("Quota evidence is stale, conflicting, unknown or scoped to another resource.");
  if (o.acquisition?.sharedPool) return unknown("Verified shared pool capacity is retained in account details; it is not an independent per-account balance.");
  const unit = state.definition.unit.kind;
  if ((unit === "tokens" || unit === "requests") && o.remaining !== null) {
    return { quota: { kind: "remaining", unit, remaining: o.remaining, limit: o.limit, resetsAtMs: o.resetAt, currency: null }, origin: o.provenance === "verified" ? "known" : o.provenance };
  }
  if (o.indicator?.kind === "percent-used") return { quota: { kind: "percent-used", usedPercent: o.indicator.value, resetsAtMs: o.resetAt }, origin: o.provenance === "verified" ? "known" : o.provenance };
  return unknown("This unit or percent-remaining indicator has no compatible legacy capacity representation.");
}
export function accountPortfolioView(core: AccountCore) {
  const accounts = core.listAccounts();
  const refusals = allActiveProviderRefusals(core.db);
  return { accounts: accounts.map(account => ({ account, bindings: core.bindings(account.id), profiles: core.associations(account.id),
    providerRefusals: refusals.filter(refusal => refusal.accountId === account.id),
    subscriptionIds: core.subscriptionsFor(account.id).map(s => s.id), quotas: core.currentQuotas(account.id), models: core.modelCapabilities(account.id) })),
    subscriptions: core.listSubscriptions(), commitments: core.commitments() };
}
export function extendPortfolioResources(core: AccountCore, base: ResourceSnapshotInput[], now: number, warnings: string[]): ResourceSnapshotInput[] {
  const resources = [...base];
  for (const account of core.listAccounts()) {
    const bindings = core.bindings(account.id);
    if (account.provenance === "unknown") { warnings.push("A bound account has unknown identity; resource capacity remains unassigned."); continue; }
    const states = core.currentQuotas(account.id);
    const quota = portfolioQuota(states);
    const subscriptions = core.subscriptionsFor(account.id);
    const concurrency = states.filter(s => s.definition.unit.kind === "concurrency" && s.definition.scope === "account" && s.definition.window === "instant");
    // FO-008B has per-harness slots only. An account-wide cap cannot be duplicated across its harness rows.
    const candidate = concurrency.length === 1 && bindings.length === 1 ? concurrency[0]!.current : null;
    const cap = candidate?.acquisition?.sharedPool ? null : candidate;
    const related = base.filter(r => bindings.some(b => b.harnessId === r.harnessId));
    const noActiveRuns = related.every(r => r.occupiedSlots.value === 0 && r.occupiedSlots.origin !== "unknown");
    for (const binding of bindings) {
      const harness = base.find(r => r.harnessId === binding.harnessId);
      if (!harness) continue;
      const profiles = core.associations(account.id).filter(p => core.resolveIdentity(binding.harnessId, p.profileId).accountId === account.id);
      resources.push({ ...harness,
        id: `account:${account.id}:harness:${binding.harnessId}`, accountId: account.id, agentProfileIds: profiles.map(p => p.profileId),
        subscriptionId: subscriptions.length === 1 ? subscriptions[0]!.id : null,
        availability: harness.availability.value === "unavailable" ? harness.availability : account.availability === "unavailable"
          ? { value: "unavailable", origin: "user-provided", observedAtMs: account.updatedAt }
          : { value: null, origin: "unknown", observedAtMs: null, detail: "Account availability does not prove execution readiness." },
        concurrencyLimit: cap?.limit !== null && cap?.limit !== undefined
          ? { value: cap.limit, origin: cap.provenance === "verified" ? "known" : cap.provenance, observedAtMs: cap.observedAt }
          : { value: null, origin: "unknown", observedAtMs: null },
        occupiedSlots: noActiveRuns ? { value: 0, origin: "observed", observedAtMs: now }
          : { value: null, origin: "unknown", observedAtMs: null, detail: "Run history has no captured account identity; current profile bindings cannot identify historical executions." },
        quota: quota.quota, quotaOrigin: quota.origin,
        // User declarations are retained in accountPortfolioView; they do not prove model support.
        supportedModels: { value: null, origin: "unknown", observedAtMs: null, detail: "No supported verification mechanism has confirmed account model capabilities." },
      });
    }
    warnings.push(`Account ${account.id} is user-declared. Bindings do not switch execution accounts.`);
    if (bindings.length > 1 || subscriptions.some(s => core.listAccounts().filter(a => core.subscriptionsFor(a.id).some(other => other.id === s.id)).length > 1)) {
      warnings.push(`Account ${account.id} shares resource identity across bindings or a subscription. Per-harness capacity must not be added; allocation is not implemented.`);
    }
    if (states.some(s => s.current?.acquisition?.sharedPool)) warnings.push(`Account ${account.id} has verified shared pool evidence. Inspect its source, scope and window; per-account capacity is not independent.`);
    for (const state of states) warnings.push(...state.warnings.map(w => `Quota ${state.definition.id}: ${w}`));
  }
  return resources;
}
