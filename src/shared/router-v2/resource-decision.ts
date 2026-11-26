/**
 * FO-ROUTER-COMPLETE01: evidence rules for Smart Router decisions.
 * Scoring never grants execution. A high score cannot make a blocked resource executable.
 */

import { createHash } from "node:crypto";
import type { EvidenceClass, PolicyWeights, RouterPolicyPreset } from "./types.ts";

export const MIN_COMPARABLE_SAMPLES = 3;
export const HIGH_CONFIDENCE_SAMPLES = 8;
/** One local planning unit. This is not a provider-side reservation. */
export const RECOMMENDATION_BOUNDARY =
  "A routing recommendation does not authorize execution. The task stays in its current column until the normal lifecycle admits it.";

export const POLICY_WEIGHTS_NOTE: Record<RouterPolicyPreset, string> = {
  "best-quality": "Quality 60, history 20, latency 10, cost 10, quota 0. Measured history replaces the configured tier only when a comparable sample meets the minimum.",
  "lowest-cost": "Comparable API cost 60, quota 20, history 10, quality 10, latency 0. Subscription coverage is not treated as a free API execution.",
  "balanced": "Quality 30, cost 30, latency 20, history 20, quota 0.",
  fastest: "Expected completion 60, history 20, quality 10, cost 10, quota 0. Queue wait and rework overhead are part of completion time.",
  "quota-saver": "Verified remaining capacity 60, comparable cost 20, quality 10, history 10, latency 0. Unknown subscription demand stays Unknown.",
  custom: "The Owner's weights are used after validation. Each weight is an integer from 0 to 100 and at least one weight is positive.",
};

export type CapacityClass =
  | "verified-sufficient"
  | "verified-insufficient"
  | "owner-reported"
  | "stale"
  | "configured-unverified"
  | "unknown";

export type BillingClass = "api" | "subscription" | "internal" | "unknown";

export interface CapacityInput {
  isUnknown: boolean;
  capacityEvidence?: "verified-headroom" | "verified-exhausted" | "owner-reported" | "configured" | "stale" | "unknown";
  remainingPercent?: number | null;
  isExhausted?: boolean;
}

export function classifyCapacity(state: CapacityInput): CapacityClass {
  const evidence = state.capacityEvidence;
  if (evidence === "stale") return "stale";
  if (evidence === "owner-reported") return "owner-reported";
  if (evidence === "configured") return "configured-unverified";
  const exhausted = state.isExhausted === true || state.remainingPercent === 0 || evidence === "verified-exhausted";
  if (exhausted && evidence !== "unknown" && !state.isUnknown) return "verified-insufficient";
  if (!state.isUnknown && (evidence === "verified-headroom" || evidence === undefined) &&
    state.remainingPercent != null && state.remainingPercent > 0) return "verified-sufficient";
  return "unknown";
}

export function strictCapacityAllowed(state: CapacityInput): boolean {
  return classifyCapacity(state) === "verified-sufficient";
}

export function validatePolicyWeights(weights: PolicyWeights): string | null {
  const keys = ["quality", "cost", "latency", "quota", "history"] as const;
  for (const key of keys) {
    const value = weights[key];
    if (!Number.isInteger(value) || value < 0 || value > 100) return `Weight ${key} must be an integer from 0 to 100.`;
  }
  if (keys.reduce((sum, key) => sum + weights[key], 0) <= 0) return "At least one weight must be greater than zero.";
  return null;
}

export function assessApiCost(input: {
  costMinor?: number | null;
  currency?: string | null;
  billing?: BillingClass;
  policyCurrency?: string | null;
}): { score: number; evidence: EvidenceClass; detail: string; comparable: boolean } {
  if (input.billing === "subscription") {
    return {
      score: 50, evidence: "unknown", comparable: false,
      detail: "Subscription-covered execution has no measured per-task API cost. It is not treated as free.",
    };
  }
  const currency = input.currency ?? null;
  const policyCurrency = input.policyCurrency ?? "USD";
  if (currency && currency !== policyCurrency) {
    return {
      score: 50, evidence: "unknown", comparable: false,
      detail: `Cost is ${currency}. The policy compares ${policyCurrency}. No exchange rate is configured.`,
    };
  }
  if (input.billing === "internal") {
    return { score: 50, evidence: "unknown", comparable: false, detail: "Internal cost is not a provider API charge." };
  }
  if (input.costMinor == null) {
    return { score: 50, evidence: "unknown", comparable: false, detail: "No comparable API cost evidence." };
  }
  const amount = input.costMinor;
  const rendered = `${amount} ${currency ?? policyCurrency} minor units`;
  if (amount <= 0) return { score: 100, evidence: "estimated", comparable: true, detail: `Zero additional API cost (${rendered}).` };
  if (amount <= 1) return { score: 95, evidence: "estimated", comparable: true, detail: `Very low API cost (${rendered}).` };
  if (amount <= 5) return { score: 80, evidence: "estimated", comparable: true, detail: `Low API cost (${rendered}).` };
  if (amount <= 25) return { score: 60, evidence: "estimated", comparable: true, detail: `Moderate API cost (${rendered}).` };
  if (amount <= 100) return { score: 35, evidence: "estimated", comparable: true, detail: `High API cost (${rendered}).` };
  return { score: 15, evidence: "estimated", comparable: true, detail: `Very high API cost (${rendered}).` };
}

export function expectedCompletionMs(measuredLatencyMs: number | null | undefined, queueWaitMs: number | null | undefined, reworkRate: number | null | undefined): number | null {
  if (measuredLatencyMs == null || !Number.isFinite(measuredLatencyMs) || measuredLatencyMs < 0) return null;
  const wait = queueWaitMs != null && Number.isFinite(queueWaitMs) && queueWaitMs > 0 ? queueWaitMs : 0;
  const rework = reworkRate != null && Number.isFinite(reworkRate) && reworkRate > 0 ? measuredLatencyMs * Math.min(reworkRate, 1) : 0;
  return measuredLatencyMs + wait + rework;
}

export function historyConfidence(sampleCount: number, comparable: boolean): "high" | "low" | "none" {
  if (!comparable || sampleCount < MIN_COMPARABLE_SAMPLES) return "none";
  return sampleCount >= HIGH_CONFIDENCE_SAMPLES ? "high" : "low";
}

/** One demand per shared pool, even when several accounts or models point at it. */
export function countSharedPoolOnce(rows: ReadonlyArray<{ poolId: string | null; demand: number | null }>): Map<string, number | null> {
  const pools = new Map<string, number | null>();
  for (const row of rows) {
    if (!row.poolId) continue;
    const prior = pools.get(row.poolId);
    if (prior === null || row.demand === null) pools.set(row.poolId, null);
    else pools.set(row.poolId, Math.max(prior ?? 0, row.demand));
  }
  return pools;
}

export interface FallbackProposal {
  failed: { provider: string; harnessId: string; modelId: string; accountId: string | null; mode: string; runId: string | null; reason: string };
  replacement: { provider: string; harnessId: string; modelId: string; accountId: string | null; mode: string } | null;
  evidenceHash: string;
  authorizesExecution: false;
  explanation: string;
}

export function fallbackDigest(proposal: Pick<FallbackProposal, "failed" | "replacement" | "evidenceHash">): string {
  return createHash("sha256").update(JSON.stringify({
    failed: proposal.failed,
    replacement: proposal.replacement,
    evidenceHash: proposal.evidenceHash,
  })).digest("hex");
}

export function fallbackIsStale(proposal: { evidenceHash: string }, currentEvidenceHash: string): boolean {
  return proposal.evidenceHash !== currentEvidenceHash;
}
