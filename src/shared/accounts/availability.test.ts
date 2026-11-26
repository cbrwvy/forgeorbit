import { expect, test } from "bun:test";
import { quotaFact } from "./availability.ts";
import type { QuotaObservation, QuotaState } from "./types.ts";

const NOW = 1_000_000;
const obs = (patch: Partial<QuotaObservation> = {}): QuotaObservation => ({
  id: "o1", quotaId: "q", provenance: "user-provided", source: "manual", verification: "unverified",
  observedAt: NOW - 1000, expiresAt: NOW + 1000, resetAt: null, limit: null, used: null, remaining: null, indicator: null, confidence: "unknown", ...patch,
});
const state = (status: QuotaState["status"], observations: QuotaObservation[], current: QuotaObservation | null = null, archivedAt: number | null = null): QuotaState => ({
  definition: { id: "q", accountId: "a", subscriptionId: null, scope: "account", unit: { kind: "tokens" }, window: "w", createdAt: 0, archivedAt }, status, observations, current, warnings: [],
});

test("each reading kind is its own fact", () => {
  const owner = obs();
  expect(quotaFact(state("current", [owner], owner), NOW).kind).toBe("owner-reported");
  const verified = obs({ provenance: "verified", verification: "verified", source: "trusted:x" });
  expect(quotaFact(state("current", [verified], verified), NOW).kind).toBe("verified");
  const diagnostic = obs({ provenance: "observed", source: "observed:x" });
  expect(quotaFact(state("current", [diagnostic], diagnostic), NOW).kind).toBe("observed");
});

test("a reading that is no longer current is history, and keeps its own time and source", () => {
  const old = obs({ observedAt: NOW - 9000, expiresAt: NOW - 5000, provenance: "verified", verification: "verified", source: "trusted:x" });
  const fact = quotaFact(state("stale", [old]), NOW);
  expect(fact).toMatchObject({ kind: "historical", reading: { source: "trusted:x", observedAt: NOW - 9000 } });
  // A captured "current" snapshot judged after its expiry is the past too, and a past reset is not replenishment.
  const snap = obs({ resetAt: NOW - 1 });
  expect(quotaFact(state("current", [snap], snap), NOW).kind).toBe("historical");
  expect(quotaFact(state("stale", [obs({ expiresAt: null })]), NOW).kind).toBe("historical");
});

test("no reading, an archived pool and a conflict are never read as a value", () => {
  expect(quotaFact(state("unknown", []), NOW)).toEqual({ kind: "unknown", reading: null });
  expect(quotaFact(state("unknown", [obs()], null, 5), NOW)).toEqual({ kind: "unknown", reading: null });
  expect(quotaFact(state("conflict", [obs(), obs({ id: "o2", source: "trusted:y" })]), NOW).kind).toBe("conflict");
});
