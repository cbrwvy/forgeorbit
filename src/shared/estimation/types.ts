/**
 * Cost and time estimation core (FO-006A).
 *
 * Pure input and result types. Nothing here reads a price list, a quota, or
 * a clock. A later adapter (FO-006C) fills these structs from harness
 * snapshots, run history, and values the user typed. Until a field arrives
 * with an origin, the forecast leaves it unknown.
 *
 * Mapping from ForgeOrbit today, for that adapter — this module does not
 * import those types:
 *
 * - `Task` / `Run` identify work and can supply an observed duration
 *   (`endedAt - startedAt`) as a history sample. They do not carry complexity,
 *   stage effort, or a dependency edge (pipeline edges and proposal
 *   `dependsOn` are separate graphs the caller flattens into `WorkItemInput`).
 * - `HarnessQuota.meters[].usedPercent` maps to `{ kind: "percent-used" }`.
 *   That meter is not a token balance and is never converted into one here.
 * - `AccountUsageSummary` is historical token volume for one Claude account,
 *   not remaining capacity and not a price.
 * - No table stores a subscription fee, an overage price, an exchange rate,
 *   or a model speed. Those stay caller-supplied.
 */

export const ESTIMATION_LIMITS = {
  maxItems: 2_000,
  maxStagesPerItem: 32,
  maxDependenciesPerItem: 64,
  maxBlockersPerItem: 16,
  maxSubscriptions: 200,
  maxQuotasPerSubscription: 32,
  maxAccounts: 200,
  maxApiRates: 200,
  maxExchangeRates: 50,
  maxHistory: 500,
  maxIdLength: 200,
} as const;

export const SCENARIOS = ["optimistic", "expected", "conservative"] as const;

export type ScenarioId = (typeof SCENARIOS)[number];

/** Where a number came from. `unknown` is the absence of a value, not a zero. */
export type DataOrigin = "known" | "user-provided" | "observed" | "estimated" | "unknown";

export type ScopeKind = "task" | "feature" | "milestone" | "backlog" | "project" | "portfolio";

export type WorkType = "feature" | "bug" | "spike" | "chore" | "docs" | "refactor" | "review" | "other";

/** A label only. The core never maps a complexity word onto hours. */
export type Complexity = "trivial" | "low" | "medium" | "high" | "very-high";

export type StageKind =
  | "planning"
  | "implementation"
  | "testing"
  | "review"
  | "fixes"
  | "validation"
  | "other";

export type BillingPeriod = "weekly" | "monthly" | "yearly" | "custom" | "unknown";

export type ConfidenceLevel = "high" | "medium" | "low" | "none";

export type BudgetVerdict = "within-budget" | "potentially-over-budget" | "insufficient-data" | "over-budget";

export type ForecastStatus = "known" | "estimated" | "incomplete" | "unknown" | "invalid";

export type CashStatus = "known" | "incomplete" | "unknown" | "not-requested" | "mixed-currency";

/** Integer minor units in an ISO-4217-style code. The core has no exponent table. */
export interface Money {
  currency: string;
  minor: number;
}

export interface ExchangeRate {
  from: string;
  to: string;
  /**
   * Target minor units per one source minor unit. The adapter applies any
   * difference in currency exponents before the rate reaches this core.
   */
  rate: number;
  origin: DataOrigin;
}

/** Agent-active or calendar-wait milliseconds. optimistic ≤ expected ≤ conservative. */
export interface EffortRange {
  optimisticMs: number;
  expectedMs: number;
  conservativeMs: number;
  origin: DataOrigin;
}

/** How many times a stage runs. Zero skips the stage in that scenario. */
export interface CountRange {
  optimistic: number;
  expected: number;
  conservative: number;
}

export type ConsumptionUnit = "requests" | "tokens" | "credits";

/**
 * How much of a quota one execution of a stage draws. Multiplied by the
 * scenario's repetition count. Credits carry their own currency and are not
 * converted through the money exchange table.
 */
export interface StageConsumption {
  unit: ConsumptionUnit;
  amount: number;
  currency?: string | null;
  origin: DataOrigin;
}

export interface StageInput {
  id: string;
  kind: StageKind;
  label?: string;
  /** Harness id. Informational, plus an API-rate match key. */
  harnessId?: string | null;
  modelId?: string | null;
  /** Account that would run the stage. Unset means coverage cannot be proven. */
  accountId?: string | null;
  /** Null or omitted: this stage's duration is unknown. Complexity does not fill it. */
  effort?: EffortRange | null;
  /** Omitted means one execution in every scenario. */
  repetitions?: CountRange;
  consumption?: StageConsumption | null;
}

export interface BlockerInput {
  id: string;
  label?: string;
  /** Null: the blocker is real and its wait is unknown, so the calendar is not proven. */
  wait: EffortRange | null;
}

export interface WorkItemInput {
  id: string;
  projectId: string;
  projectPath?: string | null;
  /** Feature or milestone id. A scope can filter on it. */
  groupId?: string | null;
  title?: string;
  complexity?: Complexity | null;
  workType?: WorkType | null;
  /** Other item ids that must finish first. */
  dependsOn?: string[];
  /** Ordered. The core runs them one after another inside the item. */
  stages: StageInput[];
  blockers?: BlockerInput[];
  /** Echoed only. Pipeline graphs are flattened by the caller. */
  pipelineId?: string | null;
  /**
   * When true, the item needs a `review` stage. If none was given, duration
   * stays unknown — no review length is invented.
   */
  requiresReview?: boolean;
  /** When true, the item needs a `validation` stage. Same rule as review. */
  requiresValidation?: boolean;
}

export interface EstimationScope {
  kind: ScopeKind;
  id: string;
  label?: string;
  itemIds?: string[];
  projectIds?: string[];
  groupIds?: string[];
}

export type QuotaUnit =
  | { kind: "percent-used"; usedPercent: number; resetsAtMs: number | null }
  | {
      kind: "count";
      unit: "requests" | "tokens";
      remaining: number;
      limit: number | null;
      resetsAtMs: number | null;
    }
  | {
      kind: "credits";
      remainingMinor: number;
      currency: string;
      limitMinor: number | null;
      resetsAtMs: number | null;
    }
  | { kind: "opaque"; label: string; note: string };

export interface QuotaInput {
  id: string;
  label: string;
  origin: DataOrigin;
  /** Empty or null: the meter applies to every model on the subscription. */
  modelIds?: string[] | null;
  unit: QuotaUnit;
}

export interface OveragePrice {
  unit: ConsumptionUnit;
  /** Price covers this many units. Must be a positive integer. */
  per: number;
  money: Money;
  origin: DataOrigin;
  /** Set when `unit` is `credits`. Ignored otherwise. */
  currency?: string | null;
}

export interface OveragePolicy {
  /** The plan's own switch. Budget policy must also allow overage before a charge is estimated. */
  enabled: boolean;
  /** Null: the provider did not supply a price. */
  prices: OveragePrice[] | null;
}

export interface SubscriptionInput {
  id: string;
  provider: string;
  /** Existing fees are category A. Proposed fees can become additional cash. */
  commitment: "existing" | "proposed";
  planLabel: string | null;
  /** Full recurring fee for `billingPeriod`. Never divided across tasks. */
  recurringFee: Money | null;
  /**
   * One-time price to start a proposed subscription. When null, a proposed
   * purchase falls back to one `recurringFee` and says so.
   */
  purchasePrice: Money | null;
  /** Origin of `recurringFee` / `purchasePrice` / overage prices on this row. */
  priceOrigin: DataOrigin;
  billingPeriod: BillingPeriod;
  renewalAtMs: number | null;
  /** Null: the supported-model list was not provided. A mismatch is only a warning. */
  supportedModels: string[] | null;
  quotas: QuotaInput[];
  overage: OveragePolicy | null;
  /** Caller-declared cap for extra spend on this subscription. Not a charge. */
  allowedAdditionalSpend: Money | null;
}

export interface AccountInput {
  id: string;
  provider: string;
  subscriptionId: string | null;
  /**
   * `unbounded` is an explicit claim. `null` means the cap is unknown and a
   * calendar date that depends on this account is not proven. A number is not
   * simulated minute-by-minute; a binding cap downgrades the calendar.
   */
  maxConcurrent: number | "unbounded" | null;
}

export interface ApiRate {
  id: string;
  modelId: string;
  /** Null matches any harness. */
  harnessId: string | null;
  perAgentMs: number;
  money: Money;
  origin: DataOrigin;
}

export type AllocationMode =
  | { mode: "none" }
  | { mode: "fixed-share"; shares: Array<{ subscriptionId: string; share: number }> }
  | {
      mode: "usage-weighted";
      /** Used only when every origin is `known` or `observed`. */
      weights: Array<{ projectId: string; weight: number; origin: DataOrigin }>;
    };

export interface BudgetGuardInput {
  /** Null: no cap was declared, so the guard cannot say the budget is kept. */
  maxAdditionalSpend: Money | null;
  /** Providers the user is willing to pay extra. Empty means none. */
  allowedPaidServices: string[];
  paidOverageEnabled: boolean;
  subscriptionUpgradeAllowed: boolean;
}

export interface ParallelismInput {
  /** `null` means the cap was not provided. `unbounded` is an explicit claim. */
  maxConcurrentItems: number | "unbounded" | null;
}

export interface MachineAvailability {
  /** Share of wall time the computer can run agents, in (0, 1]. Null: unknown. */
  dutyCycle: number | null;
  /** Declared pauses. Null: unknown, and the calendar is not proven. */
  plannedPauseMs: number | null;
}

export interface HistorySample {
  projectId: string | null;
  workType: WorkType | null;
  complexity: Complexity | null;
  stageKind: StageKind | null;
  agentMs: number;
  sampleCount: number;
  origin: "observed";
}

export interface EstimationRequest {
  scope: EstimationScope;
  items: WorkItemInput[];
  subscriptions: SubscriptionInput[];
  accounts: AccountInput[];
  /** Currency of headline money figures. Other currencies need `exchangeRates`. */
  reportCurrency: string;
  exchangeRates: ExchangeRate[];
  allocation: AllocationMode;
  budget: BudgetGuardInput;
  parallelism: ParallelismInput;
  machine: MachineAvailability;
  /** Anchor for a finish instant and for quota-reset waits. Null: durations only. */
  startAtMs: number | null;
  /**
   * Null: API-equivalent was not asked for. An empty array means it was asked
   * for and no rate was supplied, so the figure stays unknown — not zero.
   */
  apiRates: ApiRate[] | null;
  /** Observed samples. They adjust confidence only. They never fill a missing effort. */
  history: HistorySample[] | null;
}

export interface EstimationIssue {
  severity: "error" | "warning";
  code: string;
  path: string;
  message: string;
}

export interface MissingDatum {
  code: string;
  path: string;
  message: string;
}

export interface ProvenanceEntry {
  path: string;
  origin: DataOrigin;
  detail: string;
}

export interface DurationForecast {
  status: ForecastStatus;
  /** Set when `status` is `known` or `estimated`. */
  ms: number | null;
  /** Sum of the pieces that had a number. Not a total unless `status` is `known`. */
  knownMs: number | null;
  unknownStageIds: string[];
  origin: DataOrigin;
  note: string | null;
}

export interface CalendarForecast {
  status: ForecastStatus;
  /** Completion time. Null when it would not be an honest headline. */
  ms: number | null;
  /**
   * Dependency-and-parallelism length before machine availability and quota
   * waits. Null when that length itself could not be built.
   */
  scheduleMs: number | null;
  /** Longest dependency path. A lower bound only when every item duration is known. */
  criticalPathMs: number | null;
  /** Sum of item durations. An upper bound when one item runs at a time and every duration is known. */
  serialUpperBoundMs: number | null;
  method: "critical-path" | "list-scheduling" | "none";
  /** True only when the model determines the number, not when a heuristic produced one. */
  exact: boolean;
  startAtMs: number | null;
  /** Set only for an exact, known calendar with a start instant. */
  finishAtMs: number | null;
  simplifications: string[];
  unknownItemIds: string[];
  note: string | null;
}

export interface CashForecast {
  status: CashStatus;
  money: Money | null;
  /** Priced portion when the total is not claimable. Never a substitute headline. */
  knownPortion: Money | null;
  origin: DataOrigin;
  /**
   * `capacity` — measured remaining quota covers the scenario.
   * `declared` is intentionally unused; a note cannot stand in for a measured remainder.
   * `policy` — extra spend is turned off, which is not proof the quota covers the work.
   * `priced` — a caller-supplied price produced the figure.
   * `none` — there is no work to bill.
   */
  basis: "capacity" | "policy" | "priced" | "none" | "unpriced";
  /** False when this figure must not be added to additional cash. */
  countsAsAdditionalCash: boolean;
  note: string | null;
}

export interface CoverageSubscription {
  subscriptionId: string;
  status: "sufficient" | "insufficient" | "unknown" | "unused";
  shortfall: Array<{ unit: ConsumptionUnit; amount: number; currency: string | null }>;
  reason: string | null;
}

export interface CoverageReport {
  status: "sufficient" | "insufficient" | "unknown" | "no-work" | "no-subscription";
  subscriptions: CoverageSubscription[];
  unassignedStageIds: string[];
  notes: string[];
}

export interface AllocationForecast {
  mode: AllocationMode["mode"];
  status: CashStatus;
  money: Money | null;
  knownPortion: Money | null;
  /** Always false. An allocation is not new spend. */
  countsAsAdditionalCash: false;
  note: string | null;
}

export interface BudgetAssessment {
  verdict: BudgetVerdict;
  reasons: string[];
}

export interface ItemForecast {
  itemId: string;
  projectId: string;
  groupId: string | null;
  agentMs: number | null;
  /** This item's own sequential length, before the cross-item schedule. */
  itemMs: number | null;
  agentRuns: number;
  reworkRuns: number;
  unknownStageIds: string[];
}

export interface ScenarioForecast {
  scenario: ScenarioId;
  agent: DurationForecast;
  calendar: CalendarForecast;
  agentRuns: number;
  reworkRuns: number;
  coverage: CoverageReport;
  /** Category B. */
  additionalCash: CashForecast;
  /** Category C. */
  apiEquivalent: CashForecast;
  /** Category A. Full recurring fees of referenced existing subscriptions. */
  subscriptionFees: CashForecast;
  /** Category D. */
  allocation: AllocationForecast;
  budget: BudgetAssessment;
  items: ItemForecast[];
}

export interface ConfidenceCheck {
  id: string;
  passed: boolean;
  /** False when the check does not apply to this request and is left out of the ratio. */
  applicable: boolean;
  message: string;
}

export interface ConfidenceReport {
  level: ConfidenceLevel;
  /** Passed applicable checks divided by applicable checks. */
  inputCompleteness: number;
  checks: ConfidenceCheck[];
  summary: string;
}

export interface EstimationResult {
  /** False when the request is malformed. A cycle still returns a partial forecast and `ok: true`. */
  ok: boolean;
  issues: EstimationIssue[];
  scope: EstimationScope;
  scenarios: Record<ScenarioId, ScenarioForecast> | null;
  confidence: ConfidenceReport;
  assumptions: string[];
  missing: MissingDatum[];
  warnings: string[];
  provenance: ProvenanceEntry[];
  simplifications: string[];
  /** Dependency cycles, each listed once around (the first id is repeated at the end). */
  cycles: string[][];
}

export interface EstimateSnapshot {
  scenario: ScenarioId;
  agentMs: number | null;
  calendarMs: number | null;
  additionalCash: Money | null;
  agentRuns: number | null;
  reworkRuns: number | null;
}

export interface ActualSnapshot {
  agentMs: number | null;
  calendarMs: number | null;
  additionalCash: Money | null;
  agentRuns: number | null;
  reviewReworkCount: number | null;
  observedAtMs: number | null;
}

export interface Variance {
  status: "known" | "unknown";
  /** actual − estimated. */
  absolute: number | null;
  /** (actual − estimated) / estimated. Null when the baseline is zero or either side is missing. */
  relative: number | null;
  reason: string | null;
}

/** JSON-serializable. Suitable for a future history table; FO-006A does not create one. */
export interface EstimateVsActual {
  id: string;
  scopeId: string;
  estimate: EstimateSnapshot;
  actual: ActualSnapshot;
  durationVariance: Variance;
  calendarVariance: Variance;
  cashVariance: Variance;
  runsVariance: Variance;
  reworkVariance: Variance;
  reviewReworkCount: number | null;
  missing: string[];
}

export interface WhatIfPatch {
  dropItemIds?: string[];
  upsertItems?: WorkItemInput[];
  stageEfforts?: Array<{ itemId: string; stageId: string; effort: EffortRange | null }>;
  stageAssignments?: Array<{
    itemId: string;
    stageId: string;
    harnessId?: string | null;
    modelId?: string | null;
    accountId?: string | null;
    consumption?: StageConsumption | null;
  }>;
  parallelism?: ParallelismInput;
  upsertAccounts?: AccountInput[];
  upsertSubscriptions?: SubscriptionInput[];
  budget?: BudgetGuardInput;
  allocation?: AllocationMode;
  dependencies?: Array<{ itemId: string; dependsOn: string[] }>;
  apiRates?: ApiRate[] | null;
  machine?: MachineAvailability;
  exchangeRates?: ExchangeRate[];
}
