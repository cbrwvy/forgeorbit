/**
 * FO-ROUTING04: AI Router 2.0 — Replaceable Quota Source Adapters
 */

import type { Database } from "bun:sqlite";
import { AccountCore } from "../account-core.ts";
import { db } from "../db.ts";
import { exhaustedQuotaWindows, quotaApplies, remainingPercent, verifiedQuotaWindows, type ExhaustedQuotaWindow } from "../../shared/accounts/resolve.ts";
import type { QuotaState } from "../../shared/accounts/types.ts";

export type CapacityEvidence = "verified-headroom" | "verified-exhausted" | "owner-reported" | "configured" | "stale" | "unknown";

export interface QuotaStateResult {
  isUnknown: boolean;
  capacityEvidence?: CapacityEvidence;
  remainingPercent: number | null;
  remainingUnits: number | null;
  unitKind: string;
  isExhausted: boolean;
  exhaustedWindows?: ExhaustedQuotaWindow[];
  poolId?: string | null;
  sourceKind: "trusted_adapter" | "official_api" | "usage_observation" | "owner_budget" | "persisted_consumption";
  sourceName: string;
  observedAt: number;
}

export interface QuotaSourceAdapter {
  readonly id: string;
  readonly provider: string;
  readonly kind: QuotaStateResult["sourceKind"];
  getQuota(accountId: string | null, harnessId: string, modelId: string): Promise<QuotaStateResult | null>;
  getQuotaSync?(accountId: string | null, harnessId: string, modelId: string): QuotaStateResult | null;
}

/**
 * Adapter reading validated account-bound quotas from AccountCore.
 */
export class AccountCoreQuotaAdapter implements QuotaSourceAdapter {
  readonly id = "account-core-adapter";
  readonly provider = "all";
  readonly kind = "usage_observation";

  constructor(private database: Database = db, private now: () => number = Date.now) {}

  getQuotaSync(accountId: string | null, harnessId: string, modelId: string): QuotaStateResult | null {
    if (!accountId) return null;
    const core = new AccountCore(this.database, this.now);
    if (!core.bindings(accountId).some(b => b.harnessId === harnessId)) return null;
    return routingQuota(core.currentQuotas(accountId), accountId, core.getAccount(accountId).provider, harnessId, modelId, this.now());
  }

  async getQuota(accountId: string | null, harnessId: string, modelId: string): Promise<QuotaStateResult | null> {
    return this.getQuotaSync(accountId, harnessId, modelId);
  }
}

/** Each applicable verified window is evaluated separately. Percent is the tightest window,
 * never a sum. A partial or conflicting read cannot establish positive verified headroom. */
export function routingQuota(quotas: readonly QuotaState[], accountId: string, provider: string, harnessId: string, modelId: string, now: number): QuotaStateResult {
  const matching = quotas.filter(q => quotaApplies(q.definition, harnessId, modelId) &&
    q.definition.category !== "organization-budget" && q.definition.category !== "api-credit");
  const verified = verifiedQuotaWindows(quotas, accountId, provider, harnessId, modelId, now);
  const readings = verified.flatMap(q => q.current ? [{ o: q.current, unit: q.definition.unit.kind }] : []);
  const exhaustedWindows = exhaustedQuotaWindows(verified, now);
  const exhausted = exhaustedWindows.length > 0;
  const known = readings.length > 0 && (exhausted || readings.length === verified.length &&
    readings.every(({ o }) => (o.remaining ?? remainingPercent(o) ?? 0) > 0));
  const percentages = readings.flatMap(({ o }) => {
    const percent = remainingPercent(o);
    return percent === null ? [] : [percent];
  });
  const only = known && readings.length === 1 && (!exhausted || exhaustedWindows.some(window => window.id === readings[0]?.o.id)) ? readings[0] : null;
  const owner = matching.some(q => q.current?.provenance === "user-provided");
  return {
    isUnknown: !known && !exhausted, isExhausted: exhausted, exhaustedWindows,
    remainingPercent: known && (!exhausted || percentages.includes(0)) && percentages.length === readings.length ? Math.min(...percentages) : null,
    remainingUnits: only?.o.remaining ?? null, unitKind: only?.unit ?? "unknown",
    capacityEvidence: exhausted ? "verified-exhausted" : known ? "verified-headroom" :
      matching.some(q => q.status === "stale") ? "stale" : owner ? "owner-reported" :
      matching.some(q => q.definition.warnAtRemainingPercent != null) ? "configured" : "unknown",
    poolId: (() => {
      const ids = verified.flatMap(q => q.current?.acquisition?.sharedPool?.id ? [q.current.acquisition.sharedPool.id] : []);
      return ids.length > 0 && ids.every(id => id === ids[0]) ? ids[0]! : null;
    })(),
    sourceKind: "usage_observation", sourceName: known ? "AccountCore" : "unknown",
    observedAt: readings.length ? Math.min(...readings.map(({ o }) => o.observedAt)) : 0,
  };
}

/**
 * Synthetic quota adapter for testing / functional acceptance.
 * Allows seeding exact quota states (e.g. low quota, high quota, exhausted quota).
 */
export class SyntheticVerifiedQuotaAdapter implements QuotaSourceAdapter {
  readonly id = "synthetic-quota-adapter";
  readonly provider = "synthetic";
  readonly kind = "trusted_adapter";

  private syntheticStore = new Map<string, { remainingPercent: number; remainingUnits: number; unitKind: string }>();

  seedQuota(key: string, data: { remainingPercent: number; remainingUnits: number; unitKind: string }): void {
    this.syntheticStore.set(key, data);
  }

  clearQuota(key: string): void {
    this.syntheticStore.delete(key);
  }

  getQuotaSync(accountId: string | null, harnessId: string, modelId: string): QuotaStateResult | null {
    const key = `${harnessId}:${accountId ?? ""}:${modelId}`;
    const specific = this.syntheticStore.get(key) ?? (accountId ? this.syntheticStore.get(accountId) : null);
    if (!specific) return null;

    return {
      isUnknown: false,
      remainingPercent: specific.remainingPercent,
      remainingUnits: specific.remainingUnits,
      unitKind: specific.unitKind,
      isExhausted: specific.remainingPercent <= 0 || specific.remainingUnits <= 0,
      sourceKind: this.kind,
      sourceName: "SyntheticVerifiedAdapter",
      observedAt: Date.now(),
    };
  }

  async getQuota(accountId: string | null, harnessId: string, modelId: string): Promise<QuotaStateResult | null> {
    return this.getQuotaSync(accountId, harnessId, modelId);
  }
}

/**
 * Replaceable adapter registry.
 */
export class QuotaAdapterRegistry {
  private adapters: QuotaSourceAdapter[] = [];

  constructor() {
    this.register(new AccountCoreQuotaAdapter());
  }

  register(adapter: QuotaSourceAdapter): void {
    this.adapters = [adapter, ...this.adapters.filter((a) => a.id !== adapter.id)];
  }

  unregister(adapterId: string): void {
    this.adapters = this.adapters.filter((a) => a.id !== adapterId);
  }

  resolveQuotaSync(accountId: string | null, harnessId: string, modelId: string): QuotaStateResult {
    for (const adapter of this.adapters) {
      try {
        if (adapter.getQuotaSync) {
          const res = adapter.getQuotaSync(accountId, harnessId, modelId);
          if (res && (!res.isUnknown || res.capacityEvidence)) {
            return res;
          }
        }
      } catch {
        // Fall through
      }
    }

    return {
      isUnknown: true,
      remainingPercent: null,
      remainingUnits: null,
      unitKind: "unknown",
      isExhausted: false,
      sourceKind: "usage_observation",
      sourceName: "unknown",
      observedAt: Date.now(),
    };
  }

  async resolveQuota(accountId: string | null, harnessId: string, modelId: string): Promise<QuotaStateResult> {
    for (const adapter of this.adapters) {
      try {
        const res = await adapter.getQuota(accountId, harnessId, modelId);
        if (res && (!res.isUnknown || res.capacityEvidence)) {
          return res;
        }
      } catch {
        // Fall through to next adapter
      }
    }

    // Default: unknown quota
    return {
      isUnknown: true,
      remainingPercent: null,
      remainingUnits: null,
      unitKind: "unknown",
      isExhausted: false,
      sourceKind: "usage_observation",
      sourceName: "unknown",
      observedAt: Date.now(),
    };
  }
}

export const quotaAdapterRegistry = new QuotaAdapterRegistry();
