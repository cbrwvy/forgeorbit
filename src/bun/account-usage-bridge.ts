import type { Database } from "bun:sqlite";
import type { HarnessQuota } from "../shared/types.ts";

export const LEGACY_USAGE_FRESHNESS_MS = 5 * 60 * 1000;
const finite = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v) && v >= 0;
const safeId = (v: unknown): v is string => typeof v === "string" && /^[a-zA-Z0-9_.:-]{1,120}$/.test(v);
/** Closed projection: no reason, plan text, paths, tokens or arbitrary provider payloads. */
export function sanitizedLegacySnapshot(value: unknown) {
  const q = value as Partial<HarnessQuota> | null;
  if (!q || !safeId(q.harnessId) || !finite(q.fetchedAtMs)) return null;
  return {
    harnessId: q.harnessId,
    kind: ["claude-code", "codex", "cursor", "gemini", "fx", "antigravity"].includes(q.kind ?? "") ? q.kind : null,
    status: ["ok", "error", "unavailable"].includes(q.status ?? "") ? q.status : null,
    source: ["api", "cache", "scrape"].includes(q.source ?? "") ? q.source : null,
    fetchedAtMs: q.fetchedAtMs,
    meters: Array.isArray(q.meters) ? q.meters.filter(m => m && safeId(m.id) && finite(m.usedPercent) && m.usedPercent <= 100).map(m => ({
      id: m.id, usedPercent: m.usedPercent, resetsAtMs: finite(m.resetsAtMs) ? m.resetsAtMs : null,
    })) : [],
  };
}
export function journalLegacyUsage(db: Database, quota: HarnessQuota): void {
  const safe = sanitizedLegacySnapshot(quota);
  if (safe) db.run("INSERT OR IGNORE INTO harness_usage_history(harness_id, observed_at, snapshot_json) VALUES (?, ?, ?)", [safe.harnessId, safe.fetchedAtMs, JSON.stringify(safe)]);
}
/** Read-only view over the existing usage stream. A later binding never relabels old samples. */
export class LegacyUsageBridge {
  constructor(private db: Database, private now: () => number = Date.now) {}
  history(before: number | null = null) {
    const rows = this.db.query<{ id: number; snapshot_json: string }, [number | null, number | null]>(
      "SELECT id, snapshot_json FROM harness_usage_history WHERE (? IS NULL OR id < ?) ORDER BY id DESC LIMIT 201"
    ).all(before, before);
    return { observations: rows.slice(0, 200).flatMap(row => {
      const q = sanitizedLegacySnapshot(JSON.parse(row.snapshot_json));
      if (!q) return [];
      const fresh = q.status === "ok" && q.fetchedAtMs <= this.now() && q.fetchedAtMs + LEGACY_USAGE_FRESHNESS_MS > this.now();
      const current = fresh && q.meters.some(m => m.resetsAtMs === null || m.resetsAtMs > this.now());
      return [{ id: row.id, ...q, observedAt: q.fetchedAtMs, accountId: null, provenance: "observed" as const, verification: "unknown" as const,
        expiresAt: q.fetchedAtMs + LEGACY_USAGE_FRESHNESS_MS,
        current,
        warnings: ["Harness-level usage is unassigned; identity and absolute capacity are unknown.",
          ...current ? [] : ["No current meter evidence; stale snapshots are historical and reset does not prove replenishment."]],
        meters: q.meters.map(m => ({ scope: m.id, indicator: { kind: "percent-used" as const, value: m.usedPercent },
          resetAt: m.resetsAtMs, limit: null, used: null, remaining: null,
          current: fresh && (m.resetsAtMs === null || m.resetsAtMs > this.now()) })),
      }];
    }), nextCursor: rows.length > 200 ? rows[199]!.id : null };
  }
  /** Existing transcript totals remain history, not quota. Does not scan homes or expose config_dir. */
  tokenHistory(before: number | null = null) {
    const rows = this.db.query<{ id: number; day: string; model: string; inputTokens: number; outputTokens: number; cacheWriteTokens: number; cacheReadTokens: number; messageCount: number }, [number | null, number | null]>(
      `SELECT rowid AS id, day, model, input_tokens AS inputTokens, output_tokens AS outputTokens,
       cache_write_tokens AS cacheWriteTokens, cache_read_tokens AS cacheReadTokens, message_count AS messageCount
       FROM usage_daily WHERE (? IS NULL OR rowid < ?) ORDER BY rowid DESC LIMIT 201`).all(before, before);
    return { observations: rows.slice(0, 200).map(row => ({ ...row, model: safeId(row.model) ? row.model : "unknown",
      accountId: null, provenance: "observed", source: "stored-transcript-rollup", quota: null })), nextCursor: rows.length > 200 ? rows[199]!.id : null };
  }
}
