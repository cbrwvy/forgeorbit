/**
 * Cost and time estimation core (FO-006A).
 *
 * Pure functions. No network, no harness, no database, no clock, and no
 * built-in provider price. Callers pass the facts they actually have.
 */

export { compareEstimateToActual } from "./compare.ts";
export { BASE_ASSUMPTIONS, estimate, estimateWhatIf } from "./estimate.ts";
export { convertMoney, scaleCharge } from "./money.ts";
export { adaptProject, backlogFingerprint, estimateIsStale, UNSET_REPORT_CURRENCY } from "./project-adapter.ts";
export { compareResults, formatCash, formatCalendar, formatDurationForecast, formatMoney, majorToMinor, runWhatIf } from "./present.ts";
export { emptyEstimationSettings, parseEstimationSettings } from "./settings.ts";
export { ESTIMATION_LIMITS, SCENARIOS } from "./types.ts";
export { applyWhatIf } from "./what-if.ts";

export type {
  AccountInput,
  ActualSnapshot,
  AllocationForecast,
  AllocationMode,
  ApiRate,
  BillingPeriod,
  BudgetAssessment,
  BudgetGuardInput,
  BudgetVerdict,
  CalendarForecast,
  CashForecast,
  CashStatus,
  Complexity,
  ConfidenceLevel,
  ConfidenceReport,
  ConsumptionUnit,
  CountRange,
  CoverageReport,
  DataOrigin,
  DurationForecast,
  EffortRange,
  EstimateSnapshot,
  EstimateVsActual,
  EstimationIssue,
  EstimationRequest,
  EstimationResult,
  EstimationScope,
  ExchangeRate,
  ForecastStatus,
  HistorySample,
  ItemForecast,
  MachineAvailability,
  MissingDatum,
  Money,
  OveragePolicy,
  OveragePrice,
  ParallelismInput,
  ProvenanceEntry,
  QuotaInput,
  QuotaUnit,
  ScenarioForecast,
  ScenarioId,
  ScopeKind,
  StageConsumption,
  StageInput,
  StageKind,
  SubscriptionInput,
  Variance,
  WhatIfPatch,
  WorkItemInput,
  WorkType,
} from "./types.ts";

export type {
  AdaptedEstimate,
  FingerprintTask,
  ProjectEstimateInput,
  ProjectTaskFact,
  StructuredDependency,
} from "./project-adapter.ts";

export type {
  BudgetMode,
  EstimationRecord,
  EstimationSettings,
  ManualStage,
  ManualSubscription,
  ObservedDuration,
} from "./settings.ts";
