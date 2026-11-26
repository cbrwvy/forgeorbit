/**
 * Provider receipts. Missing numbers stay null. Cumulative totals are not
 * this turn's usage unless a prior baseline makes a non-negative delta.
 * Estimated API prices are not a subscription bill. Fixture sources never
 * count as genuine ranking evidence.
 */
import { isSyntheticEvidenceSource, type CostKind, type MoneyAmount, type TokenUsage } from "../usage-analytics.ts";

export type UsageSource = "provider-turn" | "cumulative-delta" | "unknown";
export type SubscriptionConsumption = "reported" | "unknown";

export interface ProviderUsageReceipt {
  inputTokens: number | null;
  outputTokens: number | null;
  cacheReadTokens: number | null;
  cacheWriteTokens: number | null;
  totalTokens: number | null;
  usageSource: UsageSource;
  accountId: string;
  modelId: string;
  runId: string;
  taskId: string;
  missionId: string;
  durationMs: number | null;
  costKind: CostKind;
  money: MoneyAmount | null;
  subscriptionConsumption: SubscriptionConsumption;
  executionType: "fixture" | "synthetic";
  rankingEligible: false;
  providerId: string;
}

export type ProviderErrorClass =
  | "unsupported-model"
  | "authentication"
  | "rate-limit"
  | "quota"
  | "permission-denied"
  | "timeout"
  | "cancelled"
  | "process-exit"
  | "containment"
  | "unknown";

const emptyTokens = (): TokenUsage => ({ input: null, output: null, cacheRead: null, cacheWrite: null });

function numberOrNull(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null;
}

function readTokens(value: unknown): TokenUsage {
  if (!value || typeof value !== "object") return emptyTokens();
  const row = value as Record<string, unknown>;
  return {
    input: numberOrNull(row.input ?? row.input_tokens ?? row.inputTokens),
    output: numberOrNull(row.output ?? row.output_tokens ?? row.outputTokens),
    cacheRead: numberOrNull(row.cacheRead ?? row.cache_read_input_tokens ?? row.cached_input_tokens ?? row.cacheReadTokens),
    cacheWrite: numberOrNull(row.cacheWrite ?? row.cache_creation_input_tokens ?? row.cacheWriteTokens),
  };
}

function delta(current: number | null, previous: number | null): number | null {
  if (current == null || previous == null) return null;
  const next = current - previous;
  return next >= 0 ? next : null;
}

/** Turn usage wins. A lone cumulative object is not attributed to this turn. */
export function tokensFromReport(input: {
  turn?: unknown;
  cumulative?: unknown;
  previousCumulative?: unknown;
}): { tokens: TokenUsage; usageSource: UsageSource } {
  const turn = readTokens(input.turn);
  if (input.turn && (turn.input != null || turn.output != null || turn.cacheRead != null || turn.cacheWrite != null)) {
    return { tokens: turn, usageSource: "provider-turn" };
  }
  if (input.cumulative && input.previousCumulative) {
    const current = readTokens(input.cumulative);
    const previous = readTokens(input.previousCumulative);
    const tokens = {
      input: delta(current.input, previous.input),
      output: delta(current.output, previous.output),
      cacheRead: delta(current.cacheRead, previous.cacheRead),
      cacheWrite: delta(current.cacheWrite, previous.cacheWrite),
    };
    if (tokens.input == null && tokens.output == null && tokens.cacheRead == null && tokens.cacheWrite == null) {
      return { tokens: emptyTokens(), usageSource: "unknown" };
    }
    return { tokens, usageSource: "cumulative-delta" };
  }
  return { tokens: emptyTokens(), usageSource: "unknown" };
}

export function classifyProviderError(input: { code?: string | null; message?: string | null; timedOut?: boolean; cancelled?: boolean; exitCode?: number | null }): ProviderErrorClass {
  if (input.cancelled) return "cancelled";
  if (input.timedOut) return "timeout";
  const text = `${input.code ?? ""} ${input.message ?? ""}`.toLowerCase();
  if (/rate.?limit|usage limit|429/.test(text)) return "rate-limit";
  if (/quota|insufficient/.test(text)) return "quota";
  if (/auth|unauthori[sz]ed|login|401/.test(text)) return "authentication";
  if (/model/.test(text) && /not found|unsupported|unknown/.test(text)) return "unsupported-model";
  if (/permission|denied|sandbox/.test(text)) return "permission-denied";
  if (/containment|hard link|setsid/.test(text)) return "containment";
  if (input.exitCode != null && input.exitCode !== 0) return "process-exit";
  return "unknown";
}

export function buildUsageReceipt(input: {
  providerId: string;
  accountId: string;
  modelId: string;
  runId: string;
  taskId: string;
  missionId: string;
  durationMs?: number | null;
  turn?: unknown;
  cumulative?: unknown;
  previousCumulative?: unknown;
  billing?: "api" | "subscription" | "unknown";
  reportedMoney?: MoneyAmount | null;
  calculatedMoney?: MoneyAmount | null;
  quotaUnits?: number | null;
  source: string;
}): ProviderUsageReceipt {
  const { tokens, usageSource } = tokensFromReport(input);
  const synthetic = isSyntheticEvidenceSource(input.source) || /fixture|fake|synthetic/i.test(input.source);
  let costKind: CostKind = "unknown";
  let money: MoneyAmount | null = null;
  let subscriptionConsumption: SubscriptionConsumption = "unknown";
  if (input.billing === "subscription") {
    costKind = "subscription";
    money = null;
    subscriptionConsumption = input.quotaUnits != null ? "reported" : "unknown";
  } else if (input.reportedMoney) {
    costKind = "reported-api";
    money = input.reportedMoney;
  } else if (input.billing === "api" && input.calculatedMoney) {
    costKind = "calculated-api";
    money = input.calculatedMoney;
  }
  const total = tokens.input == null && tokens.output == null ? null : (tokens.input ?? 0) + (tokens.output ?? 0);
  return {
    inputTokens: tokens.input,
    outputTokens: tokens.output,
    cacheReadTokens: tokens.cacheRead,
    cacheWriteTokens: tokens.cacheWrite,
    totalTokens: total,
    usageSource,
    accountId: input.accountId,
    modelId: input.modelId,
    runId: input.runId,
    taskId: input.taskId,
    missionId: input.missionId,
    durationMs: input.durationMs ?? null,
    costKind,
    money,
    subscriptionConsumption,
    executionType: synthetic ? "fixture" : "synthetic",
    rankingEligible: false,
    providerId: input.providerId,
  };
}

/** A shared pool movement is not a task charge without a receipt that names the run. */
export function attributePoolDelta(input: { poolId: string; delta: number | null; runId: string | null; evidence: "provider-receipt" | "none" }): { assignedToRun: boolean; reason: string } {
  if (input.evidence !== "provider-receipt" || !input.runId || input.delta == null) {
    return { assignedToRun: false, reason: "A shared pool delta is not assigned to a task without attributable evidence." };
  }
  return { assignedToRun: true, reason: `Attributed to run ${input.runId} for pool ${input.poolId}.` };
}

export function countsAsGenuineProviderUsage(input: { executionType?: string | null; usageSource?: string | null; source?: string | null }): boolean {
  if (input.executionType !== "real-provider") return false;
  if (isSyntheticEvidenceSource(input.usageSource) || isSyntheticEvidenceSource(input.source)) return false;
  return true;
}

/** Interrupted work is not success and is not retried. */
export function classifyTermination(input: { exitCode?: number | null; timedOut?: boolean; cancelled?: boolean; structuredResult?: boolean }): {
  outcome: "succeeded" | "failed" | "cancelled" | "timeout" | "indeterminate";
  retry: false;
} {
  if (input.cancelled) return { outcome: "cancelled", retry: false };
  if (input.timedOut) return { outcome: "timeout", retry: false };
  if (input.exitCode == null || !input.structuredResult) return { outcome: "indeterminate", retry: false };
  if (input.exitCode === 0) return { outcome: "succeeded", retry: false };
  return { outcome: "failed", retry: false };
}
