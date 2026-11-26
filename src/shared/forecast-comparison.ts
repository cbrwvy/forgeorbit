/**
 * Read-only forecast-versus-actual model for one task (FO-FORECAST-ACTUAL01).
 *
 * Pure types and helpers shared by the core (which builds the model from the
 * stored estimate revision bound to the first Developer run and the recorded
 * run actuals) and the webview (which renders it). Nothing here reads state or
 * changes QC, Done, approval, Router selection, budgets or launch behaviour.
 */

export interface ComparisonRange {
  optimistic: number;
  expected: number;
  conservative: number;
}

/** Why a delta cannot be shown. A delta is never silently zero. */
export type DeltaReason =
  | "no-baseline"
  | "not-planned"
  | "no-actual"
  | "interim"
  | "not-real-provider"
  | "different-resources"
  | "partial-actuals"
  | "unknown-cost"
  | "subscription"
  | "cost-mismatch"
  | "no-planned-counterpart";

export type BaselineAbsence =
  /** The task has no run yet; an estimate saved before Start becomes its baseline. */
  | "not-started"
  /** Work started with no estimate saved before it. Older tasks are never back-filled. */
  | "none-before-start"
  /** An estimate exists but was saved after the first Developer run, so it is not a baseline. */
  | "saved-after-start"
  /** The estimate saved before work started was superseded or planned another harness. */
  | "not-bound";

export interface ComparisonBaseline {
  estimateId: number;
  savedAt: number | null;
  /** The first Developer run the estimate was frozen to. */
  boundRunId: string | null;
  boundAt: number | null;
  method: string | null;
  confidence: "low" | "medium" | null;
  plannedResource: { harnessId: string; modelId: string | null; accountId: string | null; mode: string | null } | null;
  /** Estimate revisions saved after this baseline. They never replace it. */
  laterRevisions: Array<{ id: number; at: number }>;
}

export interface DurationRow {
  key: "developer" | "reviewer" | "worker" | "elapsed";
  kind: "duration";
  planned: ComparisonRange | null;
  actual: number | null;
  /** Runs with a recorded duration and runs without one (an interrupted run can lack an end). */
  coverage: { known: number; missing: number } | null;
  delta: number | null;
  reason: DeltaReason | null;
}

export interface CountRow {
  key: "runs";
  kind: "count";
  planned: ComparisonRange | null;
  actual: number | null;
  coverage: null;
  delta: number | null;
  reason: DeltaReason | null;
}

export interface ActualOnlyRow {
  key: "activeWall" | "measuredWait" | "unclassified";
  kind: "actual-only";
  actual: number | null;
  reason: DeltaReason;
}

export interface MoneyEntry {
  kind: string;
  currency: string;
  amount: number;
}

export interface CostRow {
  key: "cost";
  kind: "cost";
  planned: { totals: MoneyEntry[]; subscriptionStages: number; unknownStages: number } | null;
  actual: { totals: MoneyEntry[]; subscriptionRuns: number; unknownCostRuns: number; reportedTelemetry: MoneyEntry[] };
  delta: { currency: string; amount: number } | null;
  reason: DeltaReason | null;
}

export type ComparisonRow = DurationRow | CountRow | ActualOnlyRow | CostRow;

export interface ComparisonAttempt {
  runId: string;
  role: "developer" | "reviewer";
  /** 1-based position among this task's runs of the same role. */
  attempt: number;
  status: string;
  execution: "real-provider" | "synthetic" | "unknown";
  startedAt: number;
  endedAt: number | null;
  durationMs: number | null;
  model: string | null;
  /** The recorded execution resource and where it ran. Null where the source did not record it; never filled from the task's current settings. */
  harnessId: string | null;
  mode: string | null;
  projectPath: string | null;
  /** The worker recorded for this attempt (its id is the attribution; a later reassignment never changes it). Null when no employee execution recorded one. */
  workerId: string | null;
  /** The name recorded when the attempt ran. A Reviewer has no recorded name, so this is its current registry name. */
  workerName: string | null;
  accountId: string | null;
  /** Display only. A rename changes this label and never `accountId`. */
  accountLabel: string | null;
  /** How the run ended when the core recorded a stop or a time limit for it. */
  stop: { reason: "manual" | "time-limit"; outcome: string | null } | null;
  costKind: string;
  interrupted: boolean;
  boundToBaseline: boolean;
}

export interface ForecastComparison {
  taskId: string;
  state: "no-baseline" | "interim" | "complete";
  baseline: ComparisonBaseline | null;
  absence: BaselineAbsence | null;
  rows: ComparisonRow[];
  attempts: ComparisonAttempt[];
  /** Exact counts for the coverage line ("2 of 3 runs have a recorded duration"). */
  runCounts: { total: number; real: number; interrupted: number; failed: number };
  /** True for the Owner's own scope: nothing here is a measure of forecast accuracy on real work unless every run was a genuine provider run. */
  genuineOnly: boolean;
  quotaStatement: string | null;
}

export const COMPARISON_REASON_KEYS: Record<DeltaReason, string> = {
  "no-baseline": "comparison.reason.noBaseline",
  "not-planned": "comparison.reason.notPlanned",
  "no-actual": "comparison.reason.noActual",
  "interim": "comparison.reason.interim",
  "not-real-provider": "comparison.reason.notReal",
  "different-resources": "comparison.reason.differentResources",
  "partial-actuals": "comparison.reason.partial",
  "unknown-cost": "comparison.reason.unknownCost",
  "subscription": "comparison.reason.subscription",
  "cost-mismatch": "comparison.reason.costMismatch",
  "no-planned-counterpart": "comparison.reason.noCounterpart",
};

export const BASELINE_ABSENCE_KEYS: Record<BaselineAbsence, string> = {
  "not-started": "comparison.absence.notStarted",
  "none-before-start": "comparison.absence.none",
  "saved-after-start": "comparison.absence.late",
  "not-bound": "comparison.absence.notBound",
};
