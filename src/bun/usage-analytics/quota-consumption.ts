import { AccountCore } from "../account-core.ts";
import { db } from "../db.ts";
import { quotaDelta } from "../../shared/accounts/resolve.ts";
import { isSyntheticEvidenceSource } from "../../shared/usage-analytics.ts";
import type { QuotaObservation, QuotaUnit } from "../../shared/accounts/types.ts";

export interface QuotaReceipt {
  runId: string;
  taskId: string;
  quotaId: string;
  amount: number;
  unit: string;
  at: number;
  source: "provider-reported-receipt";
}

export interface PoolConsumption {
  accountId: string;
  accountLabel: string;
  provider: string;
  quotaId: string;
  unit: string;
  window: string;
  scope: string;
  provenance: string;
  verification: string;
  synthetic: boolean;
  ownerReported: boolean;
  configuredLimit: false;
  poolDelta: number | null;
  attributed: number | null;
  unattributed: number | null;
  resets: number;
  incompatible: number;
  truncated: boolean;
  statement: string;
}

function unitName(unit: QuotaUnit): string {
  if ("name" in unit) return unit.name;
  if ("currency" in unit) return unit.currency;
  return unit.kind;
}

function resetLike(newer: QuotaObservation, older: QuotaObservation): boolean {
  const resetMoved = newer.resetAt !== null && older.resetAt !== null && newer.resetAt !== older.resetAt;
  const usedDropped = newer.used !== null && older.used !== null && newer.used < older.used;
  const remainingRose = newer.remaining !== null && older.remaining !== null && newer.remaining > older.remaining;
  const percentDropped = newer.indicator && older.indicator && newer.indicator.kind === older.indicator.kind &&
    (newer.indicator.kind === "percent-used" ? newer.indicator.value < older.indicator.value : newer.indicator.value > older.indicator.value);
  return resetMoved || usedDropped || remainingRose || !!percentDropped;
}

export function quotaReceipts(from = 0, until = Number.MAX_SAFE_INTEGER): QuotaReceipt[] {
  const rows = db.query<{ run_id: string; task_id: string; data: string; ts: number }, [number, number]>(`
    SELECT e.run_id, r.task_id, e.data, e.ts FROM run_events e
    JOIN runs r ON r.id = e.run_id
    WHERE e.stream = 'status' AND e.subagent_id IS NULL AND e.ts >= ? AND e.ts < ?
      AND e.data LIKE 'usage-accounting: %"quota"%'
    ORDER BY e.id LIMIT 501
  `).all(from, until);
  const receipts: QuotaReceipt[] = [];
  for (const row of rows.slice(0, 500)) {
    try {
      const item = JSON.parse(row.data.slice("usage-accounting: ".length)) as { quota?: { quotaId?: unknown; amount?: unknown; unit?: unknown } };
      const quota = item.quota;
      if (!quota || typeof quota.quotaId !== "string" || typeof quota.unit !== "string" || typeof quota.amount !== "number") continue;
      if (!Number.isFinite(quota.amount) || quota.amount < 0) continue;
      receipts.push({
        runId: row.run_id, taskId: row.task_id, quotaId: quota.quotaId, amount: quota.amount, unit: quota.unit,
        at: row.ts, source: "provider-reported-receipt",
      });
    } catch { /* ignore malformed receipts */ }
  }
  return receipts;
}

/** Pool deltas stay on the pool. A run that merely overlaps the interval does not receive the delta. */
export function quotaConsumption(
  filter: { from?: number; until?: number; accountId?: string; provider?: string } = {},
  now = Date.now(),
  knownReceipts?: QuotaReceipt[],
) {
  const from = filter.from ?? 0;
  const until = filter.until ?? now + 1;
  const core = new AccountCore(db);
  const receipts = knownReceipts ?? quotaReceipts(from, until);
  const pools: PoolConsumption[] = [];
  for (const account of core.listAccounts(true)) {
    if (filter.accountId && account.id !== filter.accountId) continue;
    if (filter.provider && account.provider !== filter.provider) continue;
    for (const definition of core.definitions(account.id, true)) {
      const stored = core.history(definition.id, null, 200);
      const superseded = new Set(stored.flatMap(o => o.revises ? [o.revises] : []));
      const readings = stored.filter(o => !superseded.has(o.id)).sort((a, b) => a.observedAt - b.observedAt || a.id.localeCompare(b.id));
      let poolDelta = 0;
      let counted = 0;
      let resets = 0;
      let incompatible = 0;
      let synthetic = false;
      let ownerReported = false;
      let provenance = "unknown";
      let verification = "unknown";
      for (let i = 1; i < readings.length; i++) {
        const newer = readings[i]!;
        const older = readings[i - 1]!;
        if (newer.observedAt < from || newer.observedAt >= until) continue;
        provenance = newer.provenance;
        verification = newer.verification;
        synthetic = synthetic || isSyntheticEvidenceSource(newer.source) || isSyntheticEvidenceSource(newer.acquisition?.sourceId) || isSyntheticEvidenceSource(newer.acquisition?.limitations);
        ownerReported = ownerReported || newer.provenance === "user-provided";
        const delta = quotaDelta(newer, older);
        if (delta?.amount != null) {
          poolDelta += delta.amount;
          counted++;
        } else if (resetLike(newer, older)) resets++;
        else incompatible++;
      }
      const matching = receipts.filter(r => r.quotaId === definition.id && r.unit === unitName(definition.unit));
      const attributed = matching.length ? matching.reduce((sum, r) => sum + r.amount, 0) : null;
      const observed = counted ? poolDelta : null;
      const conflict = observed !== null && attributed !== null && attributed > observed;
      const unattributed = observed === null ? null : attributed === null ? observed : conflict ? null : observed - attributed;
      pools.push({
        accountId: account.id, accountLabel: account.displayName, provider: account.provider,
        quotaId: definition.id, unit: unitName(definition.unit), window: definition.window, scope: definition.scope,
        provenance, verification, synthetic, ownerReported, configuredLimit: false,
        poolDelta: observed, attributed, unattributed, resets, incompatible,
        truncated: stored.length === 200,
        statement: conflict
          ? "Provider receipts exceed the observed pool change. The difference is not assigned."
          : attributed === null
            ? "Per-task subscription quota consumption: Unknown. The pool change is unattributed."
            : "Only an explicit provider receipt is attributed. The remainder stays on the pool.",
      });
    }
  }
  return {
    perTaskSubscription: "unknown" as const,
    note: "A pool delta is not assigned to whichever task ran between readings. Configured limits are not verified capacity. Owner-reported readings stay Owner-reported.",
    receipts, pools, observedAt: now,
  };
}
