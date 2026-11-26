import type { TrustedQuotaSample } from "./trusted-quota.ts";

export interface CodexQuotaWindow {
  limitId: string;
  slot: "primary" | "secondary";
  durationMins: number | null;
  providerLimitReported: boolean | null;
  sample: Omit<TrustedQuotaSample, "quotaId">;
}
const obj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);
function invalid(): never { throw new Error("Invalid Codex rate-limit response."); }
const nullable = (v: unknown, test: (n: number) => boolean): number | null => v == null ? null
  : typeof v === "number" && Number.isFinite(v) && test(v) ? v : invalid();

/** Preparation only: never acquires, assigns, persists or creates VerifiedQuotaBinding.
 * A future approved adapter must map every exact scope/window to existing AccountCore definitions.
 * TTL is a local five-minute maximum, capped at reset; reset never implies replenishment.
 * `accountId` and `ordinaryUsageAllowed` on this payload are not attribution: account/read
 * does not return the same subject, so neither field can bind a sample or prove remaining capacity.
 */
export function normalizeCodexQuotas(response: unknown, observedAt: number): CodexQuotaWindow[] {
  if (!obj(response) || !Number.isSafeInteger(observedAt) || observedAt < 0 || !Number.isSafeInteger(observedAt + 300_000)) invalid();
  let buckets: [string | null, unknown][];
  if (response.rateLimitsByLimitId != null) {
    if (!obj(response.rateLimitsByLimitId)) invalid();
    buckets = Object.entries(response.rateLimitsByLimitId);
  } else {
    if (response.rateLimits == null) return [];
    buckets = [[null, response.rateLimits]];
  }
  if (buckets.length > 50) invalid();
  const seen = new Set<string>();
  const windows: CodexQuotaWindow[] = [];
  for (const [key, bucket] of buckets) {
    if (!obj(bucket)) invalid();
    const limitId = bucket.limitId;
    // No undocumented fallback identity for an unnamed legacy bucket.
    if (key === null && limitId == null) continue;
    if (typeof limitId !== "string" || !/^[a-zA-Z0-9_.:-]{1,128}$/.test(limitId)
      || /(?:sk-|eyJ|token|secret|cookie|bearer)/i.test(limitId) || (key !== null && key !== limitId) || seen.has(limitId)) invalid();
    seen.add(limitId);
    if (bucket.rateLimitReachedType != null && typeof bucket.rateLimitReachedType !== "string") invalid();
    for (const slot of ["primary", "secondary"] as const) {
      const value = bucket[slot];
      if (value == null) continue;
      if (!obj(value)) invalid();
      const percent = nullable(value.usedPercent, n => n >= 0 && n <= 100);
      const durationMins = nullable(value.windowDurationMins, n => Number.isSafeInteger(n) && n > 0);
      const seconds = nullable(value.resetsAt, n => Number.isSafeInteger(n) && n >= 0 && Number.isSafeInteger(n * 1000));
      const resetAt = seconds === null ? null : seconds * 1000;
      windows.push({ limitId, slot, durationMins,
        providerLimitReported: bucket.rateLimitReachedType == null ? null : true,
        sample: { scope: `codex:${limitId}`, unit: { kind: "provider-specific", name: "codex-window-percent" },
          window: `${slot}:${durationMins ?? "unknown"}m`, observedAt,
          expiresAt: resetAt === null ? observedAt + 300_000 : Math.min(observedAt + 300_000, resetAt), resetAt,
          limit: null, used: null, remaining: null,
          indicator: percent === null ? null : { kind: "percent-used", value: percent }, sharedPool: null } });
    }
  }
  return windows;
}
