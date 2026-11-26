import { db } from "../db.ts";
import { AccountCore } from "../account-core.ts";
import type {
  BaselineAbsence, ComparisonAttempt, ComparisonBaseline, ComparisonRange, ComparisonRow, CostRow, CountRow, DeltaReason,
  DurationRow, ForecastComparison, MoneyEntry,
} from "../../shared/forecast-comparison.ts";
import type { ActualTask, summarizeRuns } from "./actuals.ts";
import type { forecastCost, TaskForecast } from "./forecast.ts";

type Usage = ReturnType<typeof summarizeRuns>;
type PlannedCost = ReturnType<typeof forecastCost>;

export interface ComparisonInput {
  actual: ActualTask;
  estimate: TaskForecast | null;
  forecastUsage: PlannedCost | null;
  actualUsage: Usage;
  sameResources: boolean;
  comparable: boolean;
  workMs: number | null;
  completionDeltaMs: number | null;
  costDelta: { currency: string; amount: number } | null;
  runCountDelta: number | null;
}

const range = (value: ComparisonRange | undefined | null): ComparisonRange | null =>
  value ? { optimistic: value.optimistic, expected: value.expected, conservative: value.conservative } : null;

function baselineAbsence(actual: ActualTask): BaselineAbsence {
  if (!actual.runs.length) return "not-started";
  const developerStart = actual.runs.find(run => run.role === "developer")?.start ?? actual.runs[0]!.start;
  const saved = db.query<{ created_at: number }, [string]>(
    "SELECT created_at FROM usage_task_estimates WHERE task_id = ? ORDER BY id",
  ).all(actual.id);
  if (!saved.length) return "none-before-start";
  return saved.every(row => row.created_at > developerStart) ? "saved-after-start" : "not-bound";
}

function baselineFor(actual: ActualTask, estimate: TaskForecast): ComparisonBaseline | null {
  const id = estimate.estimateId;
  if (id === null) return null;
  const row = db.query<{ created_at: number }, [number]>("SELECT created_at FROM usage_task_estimates WHERE id = ?").get(id);
  const bound = actual.runs.find(run => run.estimateId === id);
  const later = db.query<{ id: number; created_at: number }, [string, number]>(
    "SELECT id, created_at FROM usage_task_estimates WHERE task_id = ? AND id > ? ORDER BY id",
  ).all(actual.id, id).map(entry => ({ id: entry.id, at: entry.created_at }));
  return {
    estimateId: id, savedAt: row?.created_at ?? null, boundRunId: bound?.id ?? null, boundAt: bound?.start ?? null,
    method: estimate.methodology ?? null, confidence: estimate.confidence ?? null,
    plannedResource: estimate.plannedResource ?? null, laterRevisions: later,
  };
}

const moneyList = (items: Array<{ kind: string; currency: string; amount: number }>): MoneyEntry[] =>
  items.map(item => ({ kind: item.kind, currency: item.currency, amount: item.amount }));

/**
 * Builds the read-only comparison from records that already exist. A value is
 * Unknown (null) when its evidence is missing; it is never turned into zero.
 * Deltas keep the rules `taskBreakdown` already applies: genuine provider runs
 * on the planned resources, a recorded Done, complete durations, one currency.
 */
export function buildForecastComparison(input: ComparisonInput): ForecastComparison {
  const { actual, estimate, actualUsage } = input;
  const baseline = estimate ? baselineFor(actual, estimate) : null;
  const done = actual.doneAt !== null;
  const allReal = actual.runs.length > 0 && actual.runs.every(run => run.execution === "real-provider");

  const common = (planned: ComparisonRange | null, hasActual: boolean, partial: boolean): DeltaReason | null => {
    if (!estimate) return "no-baseline";
    if (!planned) return "not-planned";
    if (!hasActual) return "no-actual";
    if (!done) return "interim";
    if (!allReal) return "not-real-provider";
    if (!input.sameResources) return "different-resources";
    if (partial) return "partial-actuals";
    return null;
  };

  const roleRow = (key: "developer" | "reviewer"): DurationRow => {
    const coverage = key === "developer" ? actual.lifecycle.developerCoverage : actual.lifecycle.reviewerCoverage;
    const planned = estimate
      ? range(key === "developer" ? estimate.activeDeveloper : estimate.roles.includes("reviewer") ? estimate.qc : null)
      : null;
    const reason = common(planned, coverage.ms !== null, coverage.missing > 0);
    return {
      key, kind: "duration", planned, actual: coverage.ms,
      coverage: coverage.known + coverage.missing > 0 ? { known: coverage.known, missing: coverage.missing } : null,
      delta: reason === null && planned && coverage.ms !== null ? coverage.ms - planned.expected : null, reason,
    };
  };

  const workerKnown = actual.runs.filter(run => run.durationMs !== null).length;
  const workerPartial = workerKnown < actual.runs.length;
  const workerPlanned = estimate ? range(estimate.worker) : null;
  const workerReason = common(workerPlanned, actual.workerMs !== null, workerPartial);
  const worker: DurationRow = {
    key: "worker", kind: "duration", planned: workerPlanned, actual: actual.workerMs,
    coverage: actual.runs.length ? { known: workerKnown, missing: actual.runs.length - workerKnown } : null,
    delta: workerReason === null ? input.workMs : null, reason: workerReason,
  };

  const elapsedPlanned = estimate ? range(estimate.completion) : null;
  const elapsedReason = common(elapsedPlanned, actual.executionElapsedMs !== null, false);
  const elapsed: DurationRow = {
    key: "elapsed", kind: "duration", planned: elapsedPlanned, actual: actual.executionElapsedMs ?? actual.lifecycle.partialExecutionMs,
    coverage: null,
    delta: elapsedReason === null ? input.completionDeltaMs : null, reason: elapsedReason,
  };

  const runsPlanned = estimate ? range(estimate.runs) : null;
  const runsReason = common(runsPlanned, actual.runs.length > 0, false);
  const runs: CountRow = {
    key: "runs", kind: "count", planned: runsPlanned, actual: actual.runs.length ? actual.runs.length : null, coverage: null,
    delta: runsReason === null ? input.runCountDelta : null, reason: runsReason,
  };

  const plannedCost = input.forecastUsage;
  let costReason: DeltaReason | null = null;
  if (!estimate) costReason = "no-baseline";
  else if (!actual.runs.length) costReason = "no-actual";
  else if (!done) costReason = "interim";
  else if (!allReal) costReason = "not-real-provider";
  else if (!input.sameResources) costReason = "different-resources";
  else if (plannedCost && plannedCost.subscription > 0 || actualUsage.subscriptionRuns > 0) costReason = "subscription";
  else if (plannedCost && plannedCost.unknown > 0 || actualUsage.unknownCostRuns > 0) costReason = "unknown-cost";
  else if (!input.costDelta) costReason = "cost-mismatch";
  const reported: MoneyEntry[] = [];
  for (const run of actual.runs) {
    if (run.reportedTelemetry) reported.push({ kind: "cli-telemetry", currency: run.reportedTelemetry.currency, amount: run.reportedTelemetry.amount });
  }
  const cost: CostRow = {
    key: "cost", kind: "cost",
    planned: plannedCost ? { totals: moneyList(plannedCost.totals), subscriptionStages: plannedCost.subscription, unknownStages: plannedCost.unknown } : null,
    actual: {
      totals: moneyList(actualUsage.costTotals), subscriptionRuns: actualUsage.subscriptionRuns,
      unknownCostRuns: actualUsage.unknownCostRuns, reportedTelemetry: reported,
    },
    delta: costReason === null ? input.costDelta : null, reason: costReason,
  };

  const onlyActual: ComparisonRow[] = [
    { key: "activeWall", kind: "actual-only", actual: actual.activeWallMs, reason: "no-planned-counterpart" },
    { key: "measuredWait", kind: "actual-only", actual: actual.waiting.measuredMs, reason: "no-planned-counterpart" },
    { key: "unclassified", kind: "actual-only", actual: actual.waiting.unknownMs, reason: "no-planned-counterpart" },
  ];

  const seen = { developer: 0, reviewer: 0 };
  const accountLabels = new Map(new AccountCore(db).listAccounts().map(account => [account.id, account.displayName]));
  const stops = new Map(actual.runs.length ? db.query<{ run_id: string; reason: "manual" | "time-limit"; outcome: string | null }, string[]>(
    `SELECT run_id, reason, outcome FROM run_terminations WHERE requested_at IS NOT NULL AND reason IS NOT NULL
      AND run_id IN (${actual.runs.map(() => "?").join(",")})`,
  ).all(...actual.runs.map(run => run.id)).map(row => [row.run_id, { reason: row.reason, outcome: row.outcome }]) : []);
  const attempts: ComparisonAttempt[] = actual.runs.map(run => {
    seen[run.role]++;
    return {
      runId: run.id, role: run.role, attempt: seen[run.role], status: run.status, execution: run.execution as ComparisonAttempt["execution"],
      startedAt: run.start, endedAt: run.end, durationMs: run.durationMs, model: run.model, harnessId: run.harnessId, mode: run.mode,
      projectPath: run.scope?.projectPath ?? null, workerId: run.specialist, workerName: run.workerName,
      accountId: run.accountId, accountLabel: run.accountId ? accountLabels.get(run.accountId) ?? null : null, stop: stops.get(run.id) ?? null,
      costKind: run.cost.kind, interrupted: run.status === "orphaned" || run.status === "cancelled",
      boundToBaseline: baseline?.boundRunId === run.id,
    };
  });

  return {
    taskId: actual.id,
    state: !estimate ? "no-baseline" : done ? "complete" : "interim",
    baseline, absence: estimate ? null : baselineAbsence(actual),
    rows: [roleRow("developer"), roleRow("reviewer"), worker, elapsed, runs, cost, ...onlyActual],
    attempts,
    runCounts: {
      total: actual.runs.length, real: actual.runs.filter(run => run.execution === "real-provider").length,
      interrupted: actual.interrupted, failed: actual.failed,
    },
    genuineOnly: allReal,
    quotaStatement: actual.subscriptionQuota.statement,
  };
}
