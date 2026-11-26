import { ActivityJournalCore } from "../activity-journal-core.ts";
import { AccountCore } from "../account-core.ts";
import { providerName } from "./scope.ts";
import { db, harnesses } from "../db.ts";
import { routerV2Service } from "../router-v2/router-v2-service.ts";
import { PROVIDER_FOR_HARNESS, providerCapability } from "../../shared/accounts/capabilities.ts";
import { CURSOR_INTERNAL_SANDBOX_BLOCKER, DEEPSEEK_CONTAINMENT_BLOCKER } from "../../shared/provider-readiness.ts";
import { evidenceFreshness } from "../../shared/accounts/provider-evidence.ts";
import { quotaDelta, remainingPercent } from "../../shared/accounts/resolve.ts";
import { getDiscoveredModels, getHarnessDiscoveredModels } from "../agent-discovery.ts";
import { cachedHarnessAuthentication, harnessBinaryPresent } from "../agent-status.ts";
import { discoverDeepSeekInstallation } from "../deepseek-installation.ts";
import { TrustedQuotaRefresh } from "../trusted-quota.ts";
import { readExecutionMeta } from "../multiaccount/registry.ts";
import type { AgentKind } from "../../shared/types.ts";
import type { QuotaObservation } from "../../shared/accounts/types.ts";
import type { PricingTerms, RunCost, TokenUsage } from "../../shared/usage-analytics.ts";

export interface ResourceKey {
  harnessId: string;
  accountId: string | null;
  modelId: string;
}

interface PriceRow {
  id: number;
  harness_id: string;
  account_id: string | null;
  model_id: string;
  created_at: number;
  terms: string;
}

function priceView(row: PriceRow) {
  return {
    id: row.id, harnessId: row.harness_id, accountId: row.account_id, modelId: row.model_id,
    createdAt: row.created_at, terms: JSON.parse(row.terms) as PricingTerms,
  };
}

export function listPricing() {
  return db.query<PriceRow, []>("SELECT * FROM usage_pricing ORDER BY id DESC LIMIT 100").all().map(priceView);
}

export function savePricing(key: ResourceKey, terms: PricingTerms) {
  const core = new AccountCore(db);
  if (!routerV2Service.gatherCandidatesSync().some(c =>
    c.harnessId === key.harnessId && c.modelId === key.modelId && c.accountId === key.accountId
  )) throw new Error("Select a registered model and its bound account.");
  if ((terms.billing === "api" || terms.billing === "subscription") &&
      (!key.accountId || !core.bindings(key.accountId).some(b => b.harnessId === key.harnessId))) {
    throw new Error("API or subscription classification requires an explicit account binding.");
  }
  return db.transaction(() => {
    const row = db.query<PriceRow, [string, string | null, string, number, string]>(
      "INSERT INTO usage_pricing(harness_id,account_id,model_id,created_at,terms) VALUES (?,?,?,?,?) RETURNING *",
    ).get(key.harnessId, key.accountId, key.modelId, Date.now(), JSON.stringify(terms))!;
    new ActivityJournalCore(db).record({
      eventType: "usage.pricing.saved", actorType: "owner", actorId: "owner",
      targetType: "company", targetId: "company",
      idempotencyKey: `usage-price:${row.id}`, payload: { revision: row.id, billing: terms.billing, currency: terms.currency },
    });
    return priceView(row);
  })();
}

export function pricingAt(key: ResourceKey, before: number) {
  const row = db.query<PriceRow, [string, string, string | null, number]>(
    "SELECT * FROM usage_pricing WHERE harness_id = ? AND model_id = ? AND account_id IS ? AND created_at < ? ORDER BY created_at DESC, id DESC LIMIT 1",
  ).get(key.harnessId, key.modelId, key.accountId, before);
  return row ? priceView(row) : null;
}

export function costFor(price: ReturnType<typeof pricingAt>, usage: TokenUsage, cacheIncluded: boolean): RunCost {
  if (!price || price.terms.billing === "unknown") return { kind: "unknown", money: null, pricingId: null, source: null };
  const { terms } = price;
  const basis = { pricingId: price.id, source: "owner-configured" };
  if (terms.billing === "subscription") return { ...basis, kind: "subscription", money: null };
  const kind = terms.billing === "api" ? "calculated-api" : "internal";
  const read = usage.cacheRead;
  const write = usage.cacheWrite;
  const input = usage.input === null || (cacheIncluded && read === null) ? null : usage.input - (cacheIncluded ? read! : 0);
  const pricePart = (tokens: number | null, rate: number | null) =>
    tokens === 0 ? 0 : tokens == null || tokens < 0 || rate === null ? null : tokens * rate / 1_000_000;
  const values = [
    pricePart(input, terms.inputPerMillion), pricePart(usage.output, terms.outputPerMillion),
    pricePart(read, terms.cacheReadPerMillion), pricePart(write, terms.cacheWritePerMillion),
  ];
  if (values.some(v => v === null)) return { ...basis, kind, money: null };
  return { ...basis, kind, money: { amount: values.reduce<number>((n, v) => n + v!, 0), currency: terms.currency } };
}

function amountFor(o: QuotaObservation, now: number) {
  return {
    id: o.id, limit: o.limit, used: o.used, remaining: o.remaining, indicator: o.indicator,
    observedAt: o.observedAt, resetAt: o.resetAt, expiresAt: o.expiresAt,
    provenance: o.provenance, verification: o.verification,
    source: o.acquisition?.sourceId ?? o.evidence?.source ?? o.source,
    sourceNote: o.sourceNote ?? null, evidenceReference: o.evidenceReference ?? null,
    revises: o.revises ?? null, recordedAt: o.recordedAt ?? null,
    freshness: evidenceFreshness(o, now),
    remainingPercent: remainingPercent(o),
    receivedAt: o.acquisition?.receivedAt ?? o.evidence?.receivedAt ?? null,
    officialUrl: o.acquisition?.officialUrl ?? null,
    sharedPool: o.acquisition?.sharedPool != null,
    pool: o.acquisition?.sharedPool ?? null,
    poolProvider: o.acquisition?.provider ?? null,
    period: o.acquisition?.period ?? null,
    reason: o.evidence?.unknownReason ?? null,
  };
}

export function quotaFor(accountId: string, core = new AccountCore(db), history = false, now = Date.now()) {
  return core.currentQuotas(accountId, history).map(q => {
    const stored = history ? core.history(q.definition.id, null, 20) : q.observations;
    const superseded = new Set(stored.flatMap(o => o.revises ? [o.revises] : []));
    const manual = q.observations.filter(o => o.provenance === "user-provided").sort((a, b) => b.observedAt - a.observedAt);
    const ownerLatest = manual.length === 1 ? manual[0]! : null;
    const threshold = q.definition.warnAtRemainingPercent ?? null;
    const latestVerified = q.observations.filter(o => o.verification === "verified" && o.acquisition)
      .sort((a, b) => b.observedAt - a.observedAt)[0];
    const historicalVerified = latestVerified ? amountFor(latestVerified, now) : null;
    const current = q.current?.verification === "verified" ? amountFor(q.current, now) : null;
    const ownerReported = ownerLatest ? amountFor(ownerLatest, now) : null;
    const displayed = current ?? ownerReported;
    const readings = stored.filter(o => !superseded.has(o.id))
      .sort((a, b) => b.observedAt - a.observedAt);
    const changes = readings.flatMap((o, i) => {
      const previous = readings.slice(i + 1).find(p => p.source === o.source);
      const change = previous && quotaDelta(o, previous);
      return change ? [{ ...change, provenance: o.provenance, source: amountFor(o, now).source }] : [];
    }).slice(0, 10);
    return {
      id: q.definition.id, accountId, unit: q.definition.unit, window: q.definition.window, windowMs: q.definition.windowMs ?? null,
      scope: q.definition.scope, modelIds: q.definition.modelIds ?? [], subscriptionId: q.definition.subscriptionId,
      category: q.definition.category ?? "other", archived: q.definition.archivedAt !== null, status: q.status,
      threshold, warning: q.status === "current" && displayed?.freshness === "fresh" && threshold !== null &&
        displayed.remainingPercent !== null && displayed.remainingPercent <= threshold,
      current, ownerReported, historicalVerified, observations: stored.map(o => ({ ...amountFor(o, now), superseded: superseded.has(o.id) })), changes,
    };
  });
}

export function quotaHistory(quotaId: string, before: number | null) {
  const core = new AccountCore(db);
  const page = core.historyPage(quotaId, before);
  const now = Date.now();
  const corrected = db.query<{ id: string }, [string]>(`
    SELECT json_extract(data, '$.revises') AS id FROM quota_observations
    WHERE quota_id = ? AND json_extract(data, '$.revises') IS NOT NULL
  `).all(quotaId);
  const superseded = new Set(corrected.map(row => row.id));
  return { nextCursor: page.nextCursor, observations: page.observations.map(o => ({ ...amountFor(o, now), superseded: superseded.has(o.id) })) };
}

/** Reads stored snapshots only. A legacy harness reading is never bound to an account. */
export function usageResources(sourceRegistry?: TrustedQuotaRefresh) {
  const core = new AccountCore(db);
  const now = Date.now();
  const sources = sourceRegistry ?? new TrustedQuotaRefresh(core);
  const accounts = core.listAccounts(true).map(a => {
    const meta = readExecutionMeta(db, a.id);
    return {
      id: a.id, label: a.displayName, provider: a.provider, identity: a.verification,
      availability: a.availability, archived: a.archivedAt !== null, quota: quotaFor(a.id, core, true, now),
      sources: sources.availability(a.id), harnessIds: core.bindings(a.id).map(b => b.harnessId),
      profileLimit: meta.concurrencyLimit, providerLimit: meta.providerSharedLimit,
    };
  });
  const allHarnesses = harnesses.list();
  const inventory = [...new Set([...Object.keys(PROVIDER_FOR_HARNESS), ...allHarnesses.map(h => h.kind)])].map(kind => {
    const capability = providerCapability(kind);
    const isDeepSeek = kind === "deepseek-dsh";
    const ds = isDeepSeek ? discoverDeepSeekInstallation() : null;
    const entries = allHarnesses.filter(h => h.kind === kind).map(h => ({
      id: h.id, label: h.label, installed: harnessBinaryPresent(h), auth: cachedHarnessAuthentication(h, now),
      enabled: h.enabled, discoveredModels: (kind === "codex" || kind === "fx" ? getHarnessDiscoveredModels(h.id)
        : kind === "claude-code" ? [] : getDiscoveredModels(h.kind as AgentKind)).map(m => m.id),
    }));
    return { ...capability, harnesses: entries, installed: ds ? ds.status !== "missing" && ds.status !== "unidentified"
      : entries.length ? entries.some(h => h.installed) : null,
      blockers: isDeepSeek ? [DEEPSEEK_CONTAINMENT_BLOCKER] : kind === "cursor" ? [CURSOR_INTERNAL_SANDBOX_BLOCKER] : [] };
  });
  const resources = routerV2Service.gatherCandidatesSync().map(c => ({
    harnessId: c.harnessId, harness: c.harnessLabel, provider: providerName(c.provider), modelId: c.modelId,
    accountId: c.accountId, auth: c.cliLoggedIn, installed: c.cliInstalled, mode: c.mode, simulated: !!c.simulated,
    enabled: c.enabled, blocks: c.activeBlocks ?? [], occupied: c.concurrency.occupied, limit: c.concurrency.limit,
    binding: c.accountId && (c.isolationType === "child-home" || c.isolationType === "config-dir") &&
      !c.activeBlocks?.includes("account-binding-unavailable") ? "exact" : c.accountId ? "metadata" : "unassigned",
  }));
  const observations = db.query<{ harnessId: string; observedAt: number; snapshot: string }, []>(`
    SELECT h.harness_id AS harnessId, h.observed_at AS observedAt, h.snapshot_json AS snapshot
    FROM harness_usage_history h WHERE h.id = (
      SELECT x.id FROM harness_usage_history x WHERE x.harness_id = h.harness_id ORDER BY x.observed_at DESC, x.id DESC LIMIT 1)
    ORDER BY h.observed_at DESC LIMIT 100
  `).all().map(row => {
    const parsed = JSON.parse(row.snapshot) as { meters?: Array<{ id: string; usedPercent: number | null; resetsAtMs: number | null }> };
    return { harnessId: row.harnessId, observedAt: row.observedAt, meters: parsed.meters ?? [] };
  });
  return { inventory, accounts, resources, observations, pricing: listPricing() };
}
