/**
 * Manual estimation inputs for one project (FO-006B).
 *
 * This is the only shape persisted for the dashboard. It stores what a person
 * typed. It does not store tokens, and a parsed document never promotes a
 * typed number to origin "known" or "observed" — the adapter marks manual
 * numbers user-provided when it builds an EstimationRequest.
 */

import type { StructuredDependency } from "./project-adapter.ts";
import { ESTIMATION_LIMITS, type BillingPeriod, type Money, type StageKind } from "./types.ts";

export const ESTIMATION_SETTINGS_VERSION = 1 as const;

const STAGE_KINDS: readonly StageKind[] = ["planning", "implementation", "testing", "review", "fixes", "validation", "other"];
const BILLING_PERIODS: readonly BillingPeriod[] = ["weekly", "monthly", "yearly", "custom", "unknown"];
const SECRET_KEY = /token|secret|password|api[-_]?key|authorization|credential|cookie/i;

export type BudgetMode = "unset" | "overage-off" | "overage-on";

export interface ManualEffort {
  optimisticMs: number;
  expectedMs: number;
  conservativeMs: number;
}

export interface ManualCount {
  optimistic: number;
  expected: number;
  conservative: number;
}

export interface ManualConsumption {
  unit: "requests" | "tokens" | "credits";
  amount: number;
  currency: string | null;
}

export interface ManualStage {
  id: string;
  kind: StageKind;
  effort: ManualEffort | null;
  repetitions: ManualCount | null;
  /** When true, the task's stored harness is used and `harnessId` is ignored. */
  harnessFromTask: boolean;
  harnessId: string | null;
  modelFromTask: boolean;
  modelId: string | null;
  consumption: ManualConsumption | null;
}

export type ManualCapacity =
  | null
  | { kind: "count"; unit: "requests" | "tokens"; remaining: number; limit: number | null }
  | { kind: "credits"; remainingMinor: number; currency: string; limitMinor: number | null }
  | { kind: "percent-used"; usedPercent: number }
  | { kind: "opaque"; label: string; note: string };

export interface ManualOveragePrice {
  unit: "requests" | "tokens" | "credits";
  per: number;
  money: Money;
  currency: string | null;
}

export interface ManualSubscription {
  id: string;
  provider: string;
  commitment: "existing" | "proposed";
  planLabel: string | null;
  recurringFee: Money | null;
  purchasePrice: Money | null;
  billingPeriod: BillingPeriod;
  /** Null: the user does not know remaining capacity. Never filled in for them. */
  capacity: ManualCapacity;
  overageEnabled: boolean;
  /** Null: no overage price was supplied. */
  overagePrices: ManualOveragePrice[] | null;
}

export interface ManualApiRate {
  id: string;
  modelId: string;
  harnessId: string | null;
  perAgentMs: number;
  money: Money;
}

export interface ManualExchangeRate {
  from: string;
  to: string;
  /** Target minor units per one source minor unit. */
  rate: number;
}

export interface EstimationSettings {
  version: typeof ESTIMATION_SETTINGS_VERSION;
  /** Null until the user chooses a report currency. */
  reportCurrency: string | null;
  scope: { kind: "project" } | { kind: "selected"; itemIds: string[] };
  includeArchived: boolean;
  stages: Record<string, ManualStage[]>;
  /** User-confirmed edges only. Markdown in a task description is not stored here. */
  dependencies: Record<string, string[]>;
  parallelism: { maxConcurrentItems: number | "unbounded" | null };
  machine: { dutyCycle: number | null; plannedPauseMs: number | null };
  /**
   * `unset` is not a decision to forbid extra spend. The adapter must not
   * turn that into a policy zero.
   */
  budgetMode: BudgetMode;
  maxAdditionalSpend: Money | null;
  allowedPaidServices: string[];
  subscriptionUpgradeAllowed: boolean;
  subscriptions: ManualSubscription[];
  /** Null: no subscription is claimed to run these tasks. */
  pinnedSubscriptionId: string | null;
  /** Null: the pinned account's concurrency cap is unknown. */
  accountConcurrency: number | "unbounded" | null;
  /** Null: API-equivalent cost was not requested. */
  apiRates: ManualApiRate[] | null;
  exchangeRates: ManualExchangeRate[];
}

export interface ObservedDuration {
  taskId: string;
  runId: string;
  startedAt: number;
  endedAt: number;
  agentMs: number;
  status: string;
}

export interface EstimationRecord {
  settings: EstimationSettings | null;
  savedAt: number | null;
  backlogFingerprint: string | null;
  currentFingerprint: string;
  observations: ObservedDuration[];
  observationsTruncated: boolean;
  /**
   * Structured links from `task_dependencies` (FO-005C) whose dependent task
   * is in this project. Read-only here: they are edited on the board.
   */
  structuredDependencies: StructuredDependency[];
  /** Set when a stored document could not be parsed. The document is not returned. */
  settingsError?: string;
}

export function emptyEstimationSettings(): EstimationSettings {
  return {
    version: ESTIMATION_SETTINGS_VERSION,
    reportCurrency: null,
    scope: { kind: "project" },
    includeArchived: false,
    stages: {},
    dependencies: {},
    parallelism: { maxConcurrentItems: null },
    machine: { dutyCycle: null, plannedPauseMs: null },
    budgetMode: "unset",
    maxAdditionalSpend: null,
    allowedPaidServices: [],
    subscriptionUpgradeAllowed: false,
    subscriptions: [],
    pinnedSubscriptionId: null,
    accountConcurrency: null,
    apiRates: null,
    exchangeRates: [],
  };
}

export function parseEstimationSettings(value: unknown): { ok: true; settings: EstimationSettings } | { ok: false; error: string } {
  const secret = rejectSecrets(value);
  if (secret) return { ok: false, error: secret };
  if (!isRecord(value)) return { ok: false, error: "Settings must be an object." };
  if (value.version !== ESTIMATION_SETTINGS_VERSION) return { ok: false, error: "Unsupported estimation settings version." };

  const reportCurrency = value.reportCurrency == null ? null : currency(value.reportCurrency);
  if (value.reportCurrency != null && !reportCurrency) return { ok: false, error: "Report currency must be three uppercase letters." };

  const scope = parseScope(value.scope);
  if (!scope) return { ok: false, error: "Scope must be the whole project or a list of task ids." };

  const stages = parseStages(value.stages);
  if (!stages.ok) return stages;
  const dependencies = parseDependencies(value.dependencies);
  if (!dependencies.ok) return dependencies;
  const parallelism = parseParallel(value.parallelism);
  if (!parallelism.ok) return parallelism;
  const machine = parseMachine(value.machine);
  if (!machine.ok) return machine;
  if (value.budgetMode !== "unset" && value.budgetMode !== "overage-off" && value.budgetMode !== "overage-on") {
    return { ok: false, error: "Budget policy is not recognized." };
  }
  const maxAdditionalSpend = parseNullableMoney(value.maxAdditionalSpend, "Spending limit");
  if (!maxAdditionalSpend.ok) return maxAdditionalSpend;
  const allowed = parseStringList(value.allowedPaidServices, "Allowed providers", 64);
  if (!allowed.ok) return allowed;
  if (typeof value.subscriptionUpgradeAllowed !== "boolean") {
    return { ok: false, error: "Subscription upgrade must be yes or no." };
  }
  const subscriptions = parseSubscriptions(value.subscriptions);
  if (!subscriptions.ok) return subscriptions;
  const pinned = value.pinnedSubscriptionId == null ? null : asId(value.pinnedSubscriptionId);
  if (value.pinnedSubscriptionId != null && !pinned) return { ok: false, error: "Pinned subscription id is invalid." };
  if (pinned && !subscriptions.settings.some((row) => row.id === pinned)) {
    return { ok: false, error: "Pinned subscription is not in the list." };
  }
  const accountConcurrency = parseConcurrency(value.accountConcurrency);
  if (!accountConcurrency.ok) return accountConcurrency;
  const apiRates = parseApiRates(value.apiRates);
  if (!apiRates.ok) return apiRates;
  const exchangeRates = parseRates(value.exchangeRates);
  if (!exchangeRates.ok) return exchangeRates;
  if (typeof value.includeArchived !== "boolean") return { ok: false, error: "Archived inclusion must be yes or no." };

  return {
    ok: true,
    settings: {
      version: ESTIMATION_SETTINGS_VERSION,
      reportCurrency,
      scope: scope,
      includeArchived: value.includeArchived,
      stages: stages.settings,
      dependencies: dependencies.settings,
      parallelism: parallelism.settings,
      machine: machine.settings,
      budgetMode: value.budgetMode,
      maxAdditionalSpend: maxAdditionalSpend.money,
      allowedPaidServices: allowed.values,
      subscriptionUpgradeAllowed: value.subscriptionUpgradeAllowed,
      subscriptions: subscriptions.settings,
      pinnedSubscriptionId: pinned,
      accountConcurrency: accountConcurrency.value,
      apiRates: apiRates.rates,
      exchangeRates: exchangeRates.rates,
    },
  };
}

function rejectSecrets(value: unknown): string | null {
  let found = false;
  const walk = (node: unknown): void => {
    if (found) return;
    if (Array.isArray(node)) {
      for (const item of node) walk(item);
      return;
    }
    if (!isRecord(node)) return;
    for (const key of Object.keys(node)) {
      if (SECRET_KEY.test(key)) {
        found = true;
        return;
      }
      walk(node[key]);
    }
  };
  walk(value);
  return found ? "Estimation settings cannot store secrets." : null;
}

function parseScope(value: unknown): EstimationSettings["scope"] | null {
  if (!isRecord(value)) return null;
  if (value.kind === "project") return { kind: "project" };
  if (value.kind !== "selected" || !Array.isArray(value.itemIds)) return null;
  if (value.itemIds.length > ESTIMATION_LIMITS.maxItems) return null;
  const itemIds: string[] = [];
  for (const id of value.itemIds) {
    const parsed = asId(id);
    if (!parsed) return null;
    itemIds.push(parsed);
  }
  return { kind: "selected", itemIds };
}

function parseStages(value: unknown): { ok: true; settings: EstimationSettings["stages"] } | { ok: false; error: string } {
  if (!isRecord(value)) return { ok: false, error: "Stages must be an object keyed by task id." };
  const keys = Object.keys(value);
  if (keys.length > ESTIMATION_LIMITS.maxItems) return { ok: false, error: "Too many tasks have stage inputs." };
  const stages: EstimationSettings["stages"] = {};
  for (const key of keys) {
    if (!asId(key)) return { ok: false, error: "A stage is keyed by an invalid task id." };
    const list = value[key];
    if (!Array.isArray(list) || list.length > ESTIMATION_LIMITS.maxStagesPerItem) {
      return { ok: false, error: "Each task has at most 32 stages." };
    }
    const parsed: ManualStage[] = [];
    for (const row of list) {
      const stage = parseStage(row);
      if (!stage.ok) return stage;
      parsed.push(stage.stage);
    }
    stages[key] = parsed;
  }
  return { ok: true, settings: stages };
}

function parseStage(value: unknown): { ok: true; stage: ManualStage } | { ok: false; error: string } {
  if (!isRecord(value)) return { ok: false, error: "A stage must be an object." };
  const id = asId(value.id);
  if (!id) return { ok: false, error: "A stage id is invalid." };
  if (!isStageKind(value.kind)) return { ok: false, error: "A stage kind is invalid." };
  const effort = parseEffort(value.effort);
  if (!effort.ok) return effort;
  const repetitions = parseCount(value.repetitions);
  if (!repetitions.ok) return repetitions;
  if (typeof value.harnessFromTask !== "boolean" || typeof value.modelFromTask !== "boolean") {
    return { ok: false, error: "Say whether harness and model come from the task." };
  }
  const harnessId = parseOptionalId(value.harnessId, "Harness id");
  if (!harnessId.ok) return harnessId;
  const modelId = parseOptionalId(value.modelId, "Model id");
  if (!modelId.ok) return modelId;
  const consumption = parseConsumption(value.consumption);
  if (!consumption.ok) return consumption;
  return {
    ok: true,
    stage: {
      id,
      kind: value.kind,
      effort: effort.value,
      repetitions: repetitions.value,
      harnessFromTask: value.harnessFromTask,
      harnessId: harnessId.value,
      modelFromTask: value.modelFromTask,
      modelId: modelId.value,
      consumption: consumption.value,
    },
  };
}

function parseEffort(value: unknown): { ok: true; value: ManualEffort | null } | { ok: false; error: string } {
  if (value == null) return { ok: true, value: null };
  if (!isRecord(value)) return { ok: false, error: "A duration range must be three millisecond counts." };
  const optimisticMs = nonNegInt(value.optimisticMs);
  const expectedMs = nonNegInt(value.expectedMs);
  const conservativeMs = nonNegInt(value.conservativeMs);
  if (optimisticMs == null || expectedMs == null || conservativeMs == null) {
    return { ok: false, error: "Duration milliseconds must be non-negative integers." };
  }
  if (optimisticMs > expectedMs || expectedMs > conservativeMs) {
    return { ok: false, error: "Duration must rise from optimistic to expected to conservative." };
  }
  return { ok: true, value: { optimisticMs, expectedMs, conservativeMs } };
}

function parseCount(value: unknown): { ok: true; value: ManualCount | null } | { ok: false; error: string } {
  if (value == null) return { ok: true, value: null };
  if (!isRecord(value)) return { ok: false, error: "Repetitions must be three counts." };
  const optimistic = nonNegInt(value.optimistic);
  const expected = nonNegInt(value.expected);
  const conservative = nonNegInt(value.conservative);
  if (optimistic == null || expected == null || conservative == null) {
    return { ok: false, error: "Repetitions must be non-negative integers." };
  }
  if (optimistic > expected || expected > conservative) {
    return { ok: false, error: "Repetitions must rise from optimistic to expected to conservative." };
  }
  return { ok: true, value: { optimistic, expected, conservative } };
}

function parseConsumption(value: unknown): { ok: true; value: ManualConsumption | null } | { ok: false; error: string } {
  if (value == null) return { ok: true, value: null };
  if (!isRecord(value)) return { ok: false, error: "Consumption must be an object." };
  if (value.unit !== "requests" && value.unit !== "tokens" && value.unit !== "credits") {
    return { ok: false, error: "Consumption unit must be requests, tokens, or credits." };
  }
  const amount = nonNegInt(value.amount);
  if (amount == null || amount < 1) return { ok: false, error: "Consumption amount must be a positive integer." };
  if (value.unit === "credits") {
    const code = currency(value.currency);
    if (!code) return { ok: false, error: "Credit consumption needs a currency." };
    return { ok: true, value: { unit: "credits", amount, currency: code } };
  }
  return { ok: true, value: { unit: value.unit, amount, currency: null } };
}

function parseDependencies(value: unknown): { ok: true; settings: Record<string, string[]> } | { ok: false; error: string } {
  if (!isRecord(value)) return { ok: false, error: "Dependencies must be an object." };
  const dependencies: Record<string, string[]> = {};
  for (const key of Object.keys(value)) {
    if (!asId(key)) return { ok: false, error: "A dependency is keyed by an invalid task id." };
    const list = value[key];
    if (!Array.isArray(list) || list.length > ESTIMATION_LIMITS.maxDependenciesPerItem) {
      return { ok: false, error: "Too many dependencies on one task." };
    }
    const ids: string[] = [];
    for (const id of list) {
      const parsed = asId(id);
      if (!parsed) return { ok: false, error: "A dependency id is invalid." };
      ids.push(parsed);
    }
    dependencies[key] = ids;
  }
  return { ok: true, settings: dependencies };
}

function parseParallel(value: unknown): { ok: true; settings: EstimationSettings["parallelism"] } | { ok: false; error: string } {
  if (!isRecord(value)) return { ok: false, error: "Parallelism must be an object." };
  const cap = parseConcurrency(value.maxConcurrentItems);
  if (!cap.ok) return cap;
  return { ok: true, settings: { maxConcurrentItems: cap.value } };
}

function parseConcurrency(value: unknown): { ok: true; value: number | "unbounded" | null } | { ok: false; error: string } {
  if (value == null) return { ok: true, value: null };
  if (value === "unbounded") return { ok: true, value: "unbounded" };
  const parsed = nonNegInt(value);
  if (parsed == null || parsed < 1) return { ok: false, error: "Concurrency must be a positive integer, unbounded, or empty." };
  return { ok: true, value: parsed };
}

function parseMachine(value: unknown): { ok: true; settings: EstimationSettings["machine"] } | { ok: false; error: string } {
  if (!isRecord(value)) return { ok: false, error: "Availability must be an object." };
  let dutyCycle: number | null = null;
  if (value.dutyCycle != null) {
    if (typeof value.dutyCycle !== "number" || !Number.isFinite(value.dutyCycle) || value.dutyCycle <= 0 || value.dutyCycle > 1) {
      return { ok: false, error: "Duty cycle must be between 0 and 1, or empty." };
    }
    dutyCycle = value.dutyCycle;
  }
  let plannedPauseMs: number | null = null;
  if (value.plannedPauseMs != null) {
    const pause = nonNegInt(value.plannedPauseMs);
    if (pause == null) return { ok: false, error: "Planned pause must be a non-negative integer, or empty." };
    plannedPauseMs = pause;
  }
  return { ok: true, settings: { dutyCycle, plannedPauseMs } };
}

function parseSubscriptions(value: unknown): { ok: true; settings: ManualSubscription[] } | { ok: false; error: string } {
  if (!Array.isArray(value) || value.length > ESTIMATION_LIMITS.maxSubscriptions) {
    return { ok: false, error: "Subscriptions must be a list." };
  }
  const settings: ManualSubscription[] = [];
  const seen = new Set<string>();
  for (const row of value) {
    const parsed = parseSubscription(row);
    if (!parsed.ok) return parsed;
    if (seen.has(parsed.subscription.id)) return { ok: false, error: "Two subscriptions share an id." };
    seen.add(parsed.subscription.id);
    settings.push(parsed.subscription);
  }
  return { ok: true, settings };
}

function parseSubscription(value: unknown): { ok: true; subscription: ManualSubscription } | { ok: false; error: string } {
  if (!isRecord(value)) return { ok: false, error: "A subscription must be an object." };
  const id = asId(value.id);
  if (!id) return { ok: false, error: "A subscription id is invalid." };
  const provider = shortText(value.provider, 80);
  if (!provider) return { ok: false, error: "A subscription needs a provider name." };
  if (value.commitment !== "existing" && value.commitment !== "proposed") {
    return { ok: false, error: "A subscription is existing or proposed." };
  }
  const planLabel = value.planLabel == null ? null : shortText(value.planLabel, 120);
  if (value.planLabel != null && !planLabel) return { ok: false, error: "Plan label is too long." };
  const recurringFee = parseNullableMoney(value.recurringFee, "Subscription fee");
  if (!recurringFee.ok) return recurringFee;
  const purchasePrice = parseNullableMoney(value.purchasePrice, "Purchase price");
  if (!purchasePrice.ok) return purchasePrice;
  if (!isBilling(value.billingPeriod)) return { ok: false, error: "Billing period is invalid." };
  const capacity = parseCapacity(value.capacity);
  if (!capacity.ok) return capacity;
  if (typeof value.overageEnabled !== "boolean") return { ok: false, error: "Overage must be yes or no." };
  const overagePrices = parseOverage(value.overagePrices);
  if (!overagePrices.ok) return overagePrices;
  return {
    ok: true,
    subscription: {
      id,
      provider,
      commitment: value.commitment,
      planLabel,
      recurringFee: recurringFee.money,
      purchasePrice: purchasePrice.money,
      billingPeriod: value.billingPeriod,
      capacity: capacity.value,
      overageEnabled: value.overageEnabled,
      overagePrices: overagePrices.prices,
    },
  };
}

function parseCapacity(value: unknown): { ok: true; value: ManualCapacity } | { ok: false; error: string } {
  if (value == null) return { ok: true, value: null };
  if (!isRecord(value)) return { ok: false, error: "Capacity must be an object or empty." };
  if (value.kind === "count") {
    if (value.unit !== "requests" && value.unit !== "tokens") return { ok: false, error: "Count capacity is requests or tokens." };
    const remaining = nonNegInt(value.remaining);
    if (remaining == null) return { ok: false, error: "Remaining capacity must be a non-negative integer." };
    const limit = value.limit == null ? null : nonNegInt(value.limit);
    if (value.limit != null && limit == null) return { ok: false, error: "Capacity limit must be a non-negative integer or empty." };
    return { ok: true, value: { kind: "count", unit: value.unit, remaining, limit } };
  }
  if (value.kind === "credits") {
    const remainingMinor = nonNegInt(value.remainingMinor);
    const code = currency(value.currency);
    if (remainingMinor == null || !code) return { ok: false, error: "Credit capacity needs a minor amount and a currency." };
    const limitMinor = value.limitMinor == null ? null : nonNegInt(value.limitMinor);
    if (value.limitMinor != null && limitMinor == null) return { ok: false, error: "Credit limit is invalid." };
    return { ok: true, value: { kind: "credits", remainingMinor, currency: code, limitMinor } };
  }
  if (value.kind === "percent-used") {
    const usedPercent = value.usedPercent;
    if (typeof usedPercent !== "number" || !Number.isFinite(usedPercent) || usedPercent < 0 || usedPercent > 100) {
      return { ok: false, error: "Percent used must be between 0 and 100." };
    }
    return { ok: true, value: { kind: "percent-used", usedPercent } };
  }
  if (value.kind === "opaque") {
    const label = shortText(value.label, 80);
    const note = shortText(value.note, 400);
    if (!label || !note) return { ok: false, error: "An unquantified capacity needs a short label and a note." };
    return { ok: true, value: { kind: "opaque", label, note } };
  }
  return { ok: false, error: "Capacity kind is invalid." };
}

function parseOverage(value: unknown): { ok: true; prices: ManualOveragePrice[] | null } | { ok: false; error: string } {
  if (value == null) return { ok: true, prices: null };
  if (!Array.isArray(value) || value.length > 16) return { ok: false, error: "Overage prices must be a short list." };
  const prices: ManualOveragePrice[] = [];
  for (const row of value) {
    if (!isRecord(row)) return { ok: false, error: "An overage price must be an object." };
    if (row.unit !== "requests" && row.unit !== "tokens" && row.unit !== "credits") {
      return { ok: false, error: "Overage unit is invalid." };
    }
    const per = nonNegInt(row.per);
    if (per == null || per < 1) return { ok: false, error: "Overage price must cover a positive number of units." };
    const money = parseMoney(row.money);
    if (!money) return { ok: false, error: "Overage price amount is invalid." };
    const code = row.currency == null ? null : currency(row.currency);
    if (row.currency != null && !code) return { ok: false, error: "Overage credit currency is invalid." };
    prices.push({ unit: row.unit, per, money, currency: code });
  }
  return { ok: true, prices };
}

function parseApiRates(value: unknown): { ok: true; rates: ManualApiRate[] | null } | { ok: false; error: string } {
  if (value == null) return { ok: true, rates: null };
  if (!Array.isArray(value) || value.length > ESTIMATION_LIMITS.maxApiRates) {
    return { ok: false, error: "API rates must be a list." };
  }
  const rates: ManualApiRate[] = [];
  for (const row of value) {
    if (!isRecord(row)) return { ok: false, error: "An API rate must be an object." };
    const id = asId(row.id);
    const modelId = asId(row.modelId);
    if (!id || !modelId) return { ok: false, error: "An API rate needs an id and a model id." };
    const harnessId = parseOptionalId(row.harnessId, "API harness");
    if (!harnessId.ok) return harnessId;
    const perAgentMs = nonNegInt(row.perAgentMs);
    if (perAgentMs == null || perAgentMs < 1) return { ok: false, error: "An API rate needs a positive millisecond denominator." };
    const money = parseMoney(row.money);
    if (!money) return { ok: false, error: "An API rate amount is invalid." };
    rates.push({ id, modelId, harnessId: harnessId.value, perAgentMs, money });
  }
  return { ok: true, rates };
}

function parseRates(value: unknown): { ok: true; rates: ManualExchangeRate[] } | { ok: false; error: string } {
  if (!Array.isArray(value) || value.length > ESTIMATION_LIMITS.maxExchangeRates) {
    return { ok: false, error: "Exchange rates must be a list." };
  }
  const rates: ManualExchangeRate[] = [];
  for (const row of value) {
    if (!isRecord(row)) return { ok: false, error: "An exchange rate must be an object." };
    const from = currency(row.from);
    const to = currency(row.to);
    if (!from || !to || from === to) return { ok: false, error: "An exchange rate needs two different currencies." };
    if (typeof row.rate !== "number" || !Number.isFinite(row.rate) || row.rate <= 0) {
      return { ok: false, error: "An exchange rate must be a positive number." };
    }
    rates.push({ from, to, rate: row.rate });
  }
  return { ok: true, rates };
}

function parseNullableMoney(value: unknown, label: string): { ok: true; money: Money | null } | { ok: false; error: string } {
  if (value == null) return { ok: true, money: null };
  const money = parseMoney(value);
  if (!money) return { ok: false, error: `${label} must be a currency and a non-negative minor amount.` };
  return { ok: true, money };
}

function parseMoney(value: unknown): Money | null {
  if (!isRecord(value)) return null;
  const code = currency(value.currency);
  const minor = nonNegInt(value.minor);
  if (!code || minor == null) return null;
  return { currency: code, minor };
}

function parseStringList(value: unknown, label: string, max: number): { ok: true; values: string[] } | { ok: false; error: string } {
  if (!Array.isArray(value) || value.length > max) return { ok: false, error: `${label} must be a short list.` };
  const values: string[] = [];
  for (const item of value) {
    const text = shortText(item, 80);
    if (!text) return { ok: false, error: `${label} contains an empty or oversized entry.` };
    values.push(text);
  }
  return { ok: true, values };
}

function parseOptionalId(value: unknown, label: string): { ok: true; value: string | null } | { ok: false; error: string } {
  if (value == null || value === "") return { ok: true, value: null };
  const id = asId(value);
  if (!id) return { ok: false, error: `${label} is invalid.` };
  return { ok: true, value: id };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value != null && typeof value === "object" && !Array.isArray(value);
}

function asId(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (!trimmed || trimmed.length > ESTIMATION_LIMITS.maxIdLength || trimmed.includes("\0")) return null;
  return trimmed;
}

function shortText(value: unknown, max: number): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (!trimmed || trimmed.length > max || trimmed.includes("\0")) return null;
  return trimmed;
}

function currency(value: unknown): string | null {
  return typeof value === "string" && /^[A-Z]{3}$/.test(value) ? value : null;
}

function nonNegInt(value: unknown): number | null {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : null;
}

function isStageKind(value: unknown): value is StageKind {
  return typeof value === "string" && (STAGE_KINDS as readonly string[]).includes(value);
}

function isBilling(value: unknown): value is BillingPeriod {
  return typeof value === "string" && (BILLING_PERIODS as readonly string[]).includes(value);
}
