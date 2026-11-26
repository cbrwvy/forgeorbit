/**
 * One scenario: agent time, a conservative calendar, coverage, and the four
 * money categories. Every figure is either computed from the request or left
 * unknown. Nothing in this file is a price list.
 */

import { combineMoney, scaleCharge, weakerOrigin, zeroMoney, type CombinedMoney } from "./money.ts";
import { scheduleItems } from "./schedule.ts";
import type {
  AccountInput,
  AllocationForecast,
  ApiRate,
  BudgetAssessment,
  CalendarForecast,
  CashForecast,
  ConsumptionUnit,
  CountRange,
  CoverageReport,
  DataOrigin,
  DurationForecast,
  EffortRange,
  EstimationRequest,
  ItemForecast,
  Money,
  OveragePrice,
  QuotaInput,
  ScenarioForecast,
  ScenarioId,
  StageInput,
  SubscriptionInput,
  WorkItemInput,
} from "./types.ts";

const ONCE: CountRange = { optimistic: 1, expected: 1, conservative: 1 };

export function effortMs(range: EffortRange, scenario: ScenarioId): number {
  if (scenario === "optimistic") return range.optimisticMs;
  if (scenario === "expected") return range.expectedMs;
  return range.conservativeMs;
}

export function countOf(range: CountRange, scenario: ScenarioId): number {
  if (scenario === "optimistic") return range.optimistic;
  if (scenario === "expected") return range.expected;
  return range.conservative;
}

interface ItemRollup {
  item: WorkItemInput;
  agentMs: number | null;
  knownAgentMs: number;
  agentKnown: boolean;
  itemMs: number | null;
  runs: number;
  reworkRuns: number;
  unknownStageIds: string[];
  origin: DataOrigin;
}

function rollupItem(item: WorkItemInput, scenario: ScenarioId): ItemRollup {
  let knownAgentMs = 0;
  let agentKnown = true;
  let runs = 0;
  let reworkRuns = 0;
  const unknownStageIds: string[] = [];
  let origin: DataOrigin = "known";
  let sawOrigin = false;

  for (const stage of item.stages) {
    const reps = countOf(stage.repetitions ?? ONCE, scenario);
    if (!Number.isSafeInteger(runs + reps)) {
      agentKnown = false;
      unknownStageIds.push(stage.id);
      continue;
    }
    runs += reps;
    if (stage.kind === "fixes") reworkRuns += reps;
    if (reps === 0) continue;
    if (!stage.effort) {
      agentKnown = false;
      unknownStageIds.push(stage.id);
      continue;
    }
    const piece = effortMs(stage.effort, scenario) * reps;
    if (!Number.isSafeInteger(piece) || !Number.isSafeInteger(knownAgentMs + piece)) {
      agentKnown = false;
      unknownStageIds.push(stage.id);
      continue;
    }
    knownAgentMs += piece;
    origin = sawOrigin ? weakerOrigin(origin, stage.effort.origin) : stage.effort.origin;
    sawOrigin = true;
  }

  if (item.requiresReview && !item.stages.some((stage) => stage.kind === "review")) {
    agentKnown = false;
    unknownStageIds.push("required:review");
  }
  if (item.requiresValidation && !item.stages.some((stage) => stage.kind === "validation")) {
    agentKnown = false;
    unknownStageIds.push("required:validation");
  }

  let wait = 0;
  let waitKnown = true;
  for (const blocker of item.blockers ?? []) {
    if (!blocker.wait) {
      waitKnown = false;
      unknownStageIds.push(`blocker:${blocker.id}`);
      continue;
    }
    const piece = effortMs(blocker.wait, scenario);
    if (!Number.isSafeInteger(wait + piece)) {
      waitKnown = false;
      continue;
    }
    wait += piece;
    origin = sawOrigin ? weakerOrigin(origin, blocker.wait.origin) : blocker.wait.origin;
    sawOrigin = true;
  }

  const agentMs = agentKnown ? knownAgentMs : null;
  const itemMs = agentKnown && waitKnown ? knownAgentMs + wait : null;
  return {
    item,
    agentMs,
    knownAgentMs: agentKnown || knownAgentMs > 0 ? knownAgentMs : 0,
    agentKnown,
    itemMs,
    runs,
    reworkRuns,
    unknownStageIds,
    origin: sawOrigin ? origin : "unknown",
  };
}

interface Pool {
  subscriptionId: string;
  quotaId: string;
  unit: "requests" | "tokens" | "credits";
  currency: string | null;
  modelIds: string[] | null;
  remaining: number;
  resetsAtMs: number | null;
  specificity: number;
}

interface Shortfall {
  subscriptionId: string;
  unit: ConsumptionUnit;
  amount: number;
  currency: string | null;
  resetsAtMs: number | null;
}

function poolsFor(sub: SubscriptionInput): Pool[] {
  const pools: Pool[] = [];
  for (const quota of sub.quotas) {
    const pool = poolFromQuota(sub.id, quota);
    if (pool) pools.push(pool);
  }
  return pools;
}

function poolFromQuota(subscriptionId: string, quota: QuotaInput): Pool | null {
  const unit = quota.unit;
  if (unit.kind === "count") {
    return {
      subscriptionId,
      quotaId: quota.id,
      unit: unit.unit,
      currency: null,
      modelIds: quota.modelIds && quota.modelIds.length > 0 ? quota.modelIds : null,
      remaining: unit.remaining,
      resetsAtMs: unit.resetsAtMs,
      specificity: quota.modelIds && quota.modelIds.length > 0 ? 1_000 - quota.modelIds.length : 0,
    };
  }
  if (unit.kind === "credits") {
    return {
      subscriptionId,
      quotaId: quota.id,
      unit: "credits",
      currency: unit.currency,
      modelIds: quota.modelIds && quota.modelIds.length > 0 ? quota.modelIds : null,
      remaining: unit.remainingMinor,
      resetsAtMs: unit.resetsAtMs,
      specificity: quota.modelIds && quota.modelIds.length > 0 ? 1_000 - quota.modelIds.length : 0,
    };
  }
  return null;
}

function poolMatches(pool: Pool, unit: ConsumptionUnit, currency: string | null, modelId: string | null): boolean {
  if (pool.unit !== unit) return false;
  if (unit === "credits" && pool.currency !== currency) return false;
  if (pool.modelIds && pool.modelIds.length > 0) {
    return modelId !== null && pool.modelIds.includes(modelId);
  }
  return true;
}

interface CoverageBuild {
  report: CoverageReport;
  shortfalls: Shortfall[];
  /** Stages whose draw on a quota could not be measured. */
  unmeasured: boolean;
}

function coverageFor(
  request: EstimationRequest,
  items: readonly WorkItemInput[],
  scenario: ScenarioId,
): CoverageBuild {
  const accounts = new Map<string, AccountInput>(request.accounts.map((account) => [account.id, account]));
  const subscriptions = new Map<string, SubscriptionInput>(request.subscriptions.map((sub) => [sub.id, sub]));
  const notes: string[] = [];
  const unassigned = new Set<string>();
  const used = new Set<string>();
  const pools: Pool[] = [];

  if (items.length === 0 || items.every((item) => item.stages.every((stage) => countOf(stage.repetitions ?? ONCE, scenario) === 0))) {
    return {
      report: { status: "no-work", subscriptions: [], unassignedStageIds: [], notes: [] },
      shortfalls: [],
      unmeasured: false,
    };
  }

  for (const sub of request.subscriptions) {
    const usable = sub.commitment === "existing" || request.budget.subscriptionUpgradeAllowed;
    if (!usable) continue;
    pools.push(...poolsFor(sub));
    for (const quota of sub.quotas) {
      if (quota.unit.kind === "percent-used" || quota.unit.kind === "opaque") {
        notes.push(
          `Quota ${quota.id} on ${sub.id} is ${quota.unit.kind === "percent-used" ? "a percent-used window" : "opaque"}. It was not converted into requests, tokens, or credits.`,
        );
      }
    }
  }

  const draws: Array<{
    subscriptionId: string;
    unit: ConsumptionUnit;
    amount: number;
    currency: string | null;
    modelId: string | null;
    stagePath: string;
  }> = [];

  let activeStages = 0;
  for (const item of items) {
    for (const stage of item.stages) {
      const reps = countOf(stage.repetitions ?? ONCE, scenario);
      if (reps === 0) continue;
      activeStages += 1;
      const path = `${item.id}/${stage.id}`;
      const accountId = stage.accountId ?? null;
      if (!accountId) {
        unassigned.add(path);
        notes.push(`Stage ${path} is not pinned to an account, so subscription coverage cannot be proven.`);
        continue;
      }
      const account = accounts.get(accountId);
      if (!account) {
        unassigned.add(path);
        notes.push(`Stage ${path} names account ${accountId}, which is not in the request.`);
        continue;
      }
      if (!account.subscriptionId) {
        unassigned.add(path);
        notes.push(`Account ${accountId} has no subscription, so stage ${path} cannot be checked against a quota.`);
        continue;
      }
      const sub = subscriptions.get(account.subscriptionId);
      if (!sub) {
        unassigned.add(path);
        continue;
      }
      const usable = sub.commitment === "existing" || request.budget.subscriptionUpgradeAllowed;
      if (!usable) {
        unassigned.add(path);
        notes.push(`Subscription ${sub.id} is proposed and upgrades are not allowed, so its quota was not applied to ${path}.`);
        continue;
      }
      used.add(sub.id);
      if (!stage.consumption) {
        unassigned.add(path);
        notes.push(`Stage ${path} has no consumption amount, so remaining quota cannot be compared with it.`);
        continue;
      }
      const amount = stage.consumption.amount * reps;
      if (!Number.isSafeInteger(amount)) {
        unassigned.add(path);
        notes.push(`Stage ${path} consumption overflowed and was left unmeasured.`);
        continue;
      }
      const listed = sub.supportedModels;
      if (listed && listed.length > 0 && stage.modelId && !listed.includes(stage.modelId)) {
        notes.push(`Model ${stage.modelId} is not in the supported-model list on ${sub.id}. Coverage was still checked against the quota units.`);
      }
      draws.push({
        subscriptionId: sub.id,
        unit: stage.consumption.unit,
        amount,
        currency: stage.consumption.unit === "credits" ? (stage.consumption.currency ?? null) : null,
        modelId: stage.modelId ?? null,
        stagePath: path,
      });
    }
  }

  const shortfalls: Shortfall[] = [];
  for (const draw of draws) {
    const matching = pools
      .filter((pool) => pool.subscriptionId === draw.subscriptionId && poolMatches(pool, draw.unit, draw.currency, draw.modelId))
      .sort((a, b) => b.specificity - a.specificity || (a.quotaId < b.quotaId ? -1 : 1));
    if (matching.length === 0) {
      unassigned.add(draw.stagePath);
      notes.push(`Stage ${draw.stagePath} consumes ${draw.unit}, and subscription ${draw.subscriptionId} has no remaining balance in that unit.`);
      continue;
    }
    let left = draw.amount;
    for (const pool of matching) {
      const take = Math.min(pool.remaining, left);
      pool.remaining -= take;
      left -= take;
      if (left === 0) break;
    }
    if (left > 0) {
      const reset = matching.reduce<number | null>((latest, pool) => {
        if (pool.resetsAtMs === null) return latest;
        if (latest === null) return pool.resetsAtMs;
        return Math.max(latest, pool.resetsAtMs);
      }, null);
      if (matching.some((pool) => pool.resetsAtMs === null)) {
        shortfalls.push({
          subscriptionId: draw.subscriptionId,
          unit: draw.unit,
          amount: left,
          currency: draw.currency,
          resetsAtMs: null,
        });
      } else {
        shortfalls.push({
          subscriptionId: draw.subscriptionId,
          unit: draw.unit,
          amount: left,
          currency: draw.currency,
          resetsAtMs: reset,
        });
      }
    }
  }

  const byId = new Map<string, CoverageReport["subscriptions"][number]>();
  for (const sub of request.subscriptions) {
    byId.set(sub.id, { subscriptionId: sub.id, status: "unused", shortfall: [], reason: null });
  }
  for (const id of used) {
    const row = byId.get(id);
    if (row) row.status = "sufficient";
  }
  for (const gap of shortfalls) {
    const row = byId.get(gap.subscriptionId);
    if (!row) continue;
    row.status = "insufficient";
    row.shortfall.push({ unit: gap.unit, amount: gap.amount, currency: gap.currency });
    row.reason = "Measured remaining quota is below the consumption declared for this scenario.";
  }
  const unmeasured = unassigned.size > 0;
  if (unmeasured) {
    for (const id of used) {
      const row = byId.get(id);
      if (row && row.status !== "insufficient") {
        row.status = "unknown";
        row.reason = "At least one pinned stage has no comparable remaining quota.";
      }
    }
  }

  let status: CoverageReport["status"];
  if (activeStages === 0) status = "no-work";
  else if (request.subscriptions.length === 0) status = "no-subscription";
  else if (unmeasured) status = "unknown";
  else if (shortfalls.length > 0) status = "insufficient";
  else if (used.size === 0) status = "unknown";
  else status = "sufficient";

  return {
    report: {
      status,
      subscriptions: [...byId.values()],
      unassignedStageIds: [...unassigned].sort(),
      notes,
    },
    shortfalls,
    unmeasured,
  };
}

function findPrice(sub: SubscriptionInput, unit: ConsumptionUnit, currency: string | null): OveragePrice | null {
  for (const price of sub.overage?.prices ?? []) {
    if (price.unit !== unit) continue;
    if (unit === "credits" && (price.currency ?? price.money.currency) !== currency) continue;
    return price;
  }
  return null;
}

function overageOpen(sub: SubscriptionInput, request: EstimationRequest): boolean {
  return request.budget.paidOverageEnabled && sub.overage?.enabled === true;
}

interface CashBuild {
  cash: CashForecast;
  unauthorized: boolean;
  /** Unpaid measured shortfalls, for a possible reset wait. */
  unpaid: Shortfall[];
}

function additionalCash(
  request: EstimationRequest,
  items: readonly WorkItemInput[],
  scenario: ScenarioId,
  coverage: CoverageBuild,
): CashBuild {
  const subscriptions = new Map(request.subscriptions.map((sub) => [sub.id, sub]));
  const accounts = new Map(request.accounts.map((account) => [account.id, account]));
  const allowed = new Set(request.budget.allowedPaidServices);
  const parts: Money[] = [];
  const origins: DataOrigin[] = [];
  let unpriced = 0;
  let unauthorized = false;
  const unpaid: Shortfall[] = [];
  const notes: string[] = [];

  const referenced = new Set<string>();
  for (const item of items) {
    for (const stage of item.stages) {
      if (countOf(stage.repetitions ?? ONCE, scenario) === 0) continue;
      const account = stage.accountId ? accounts.get(stage.accountId) : undefined;
      if (account?.subscriptionId) referenced.add(account.subscriptionId);
    }
  }

  for (const gap of coverage.shortfalls) {
    const sub = subscriptions.get(gap.subscriptionId);
    if (!sub || !overageOpen(sub, request)) {
      unpaid.push(gap);
      continue;
    }
    if (!allowed.has(sub.provider)) unauthorized = true;
    const price = findPrice(sub, gap.unit, gap.currency);
    if (!price) {
      unpriced += 1;
      notes.push(`Subscription ${sub.id} is short ${gap.amount} ${gap.unit} and no overage price was provided.`);
      continue;
    }
    const minor = scaleCharge(price.money.minor, gap.amount, price.per);
    if (minor === null) {
      unpriced += 1;
      continue;
    }
    parts.push({ currency: price.money.currency, minor });
    origins.push(price.origin);
  }

  if ((coverage.unmeasured || coverage.report.status === "no-subscription" || coverage.report.status === "unknown") && request.budget.paidOverageEnabled) {
    unpriced += 1;
    notes.push("Remaining capacity is not known in a unit that can be compared with this work, so additional cash was not set to zero.");
    for (const id of referenced) {
      const sub = subscriptions.get(id);
      if (sub && !allowed.has(sub.provider)) unauthorized = true;
    }
  }

  for (const id of referenced) {
    const sub = subscriptions.get(id);
    if (!sub || sub.commitment !== "proposed" || !request.budget.subscriptionUpgradeAllowed) continue;
    if (!allowed.has(sub.provider)) unauthorized = true;
    const price = sub.purchasePrice ?? sub.recurringFee;
    if (!price) {
      unpriced += 1;
      notes.push(`Proposed subscription ${sub.id} has no purchase price.`);
      continue;
    }
    parts.push(price);
    origins.push(sub.priceOrigin);
    if (!sub.purchasePrice && sub.recurringFee) {
      notes.push(`Proposed subscription ${sub.id} is priced as one billing period of its recurring fee.`);
    }
  }

  if (parts.length === 0 && unpriced === 0) {
    const hasWork = coverage.report.status !== "no-work";
    if (!hasWork) {
      return {
        cash: cashForecast("known", zeroMoney(request.reportCurrency), zeroMoney(request.reportCurrency), "known", "none", true, "There is no work to bill."),
        unauthorized: false,
        unpaid,
      };
    }
    if (coverage.report.status === "sufficient") {
      return {
        cash: cashForecast(
          "known",
          zeroMoney(request.reportCurrency),
          zeroMoney(request.reportCurrency),
          "known",
          "capacity",
          true,
          "Measured remaining quota covers the consumption declared for this scenario, so no additional charge was added.",
        ),
        unauthorized: false,
        unpaid,
      };
    }
    return {
      cash: cashForecast(
        "known",
        zeroMoney(request.reportCurrency),
        zeroMoney(request.reportCurrency),
        "known",
        "policy",
        true,
        "Additional cash is zero because paid overage and new subscriptions are not both enabled. That is not proof the subscription covers the work.",
      ),
      unauthorized,
      unpaid,
    };
  }

  const combined = combineMoney(parts, unpriced, origins, request.reportCurrency, request.exchangeRates);
  const note = [combined.note, ...notes].filter((line): line is string => Boolean(line)).join(" ");
  const basis = combined.status === "known" ? "priced" : "unpriced";
  return {
    cash: cashForecast(combined.status, combined.money, combined.knownPortion, combined.origin, basis, true, note || null),
    unauthorized,
    unpaid,
  };
}

function cashForecast(
  status: CashForecast["status"],
  money: Money | null,
  knownPortion: Money | null,
  origin: DataOrigin,
  basis: CashForecast["basis"],
  countsAsAdditionalCash: boolean,
  note: string | null,
): CashForecast {
  return { status, money, knownPortion, origin, basis, countsAsAdditionalCash, note };
}

function fromCombined(
  combined: CombinedMoney,
  basis: CashForecast["basis"],
  counts: boolean,
  note: string | null,
): CashForecast {
  return cashForecast(combined.status, combined.money, combined.knownPortion, combined.origin, basis, counts, note ?? combined.note);
}

function subscriptionFees(request: EstimationRequest, items: readonly WorkItemInput[], scenario: ScenarioId): CashForecast {
  const accounts = new Map(request.accounts.map((account) => [account.id, account]));
  const subscriptions = new Map(request.subscriptions.map((sub) => [sub.id, sub]));
  const referenced = new Set<string>();
  for (const item of items) {
    for (const stage of item.stages) {
      if (countOf(stage.repetitions ?? ONCE, scenario) === 0) continue;
      const account = stage.accountId ? accounts.get(stage.accountId) : undefined;
      const sub = account?.subscriptionId ? subscriptions.get(account.subscriptionId) : undefined;
      if (sub?.commitment === "existing") referenced.add(sub.id);
    }
  }
  if (referenced.size === 0) {
    return cashForecast(
      "known",
      zeroMoney(request.reportCurrency),
      zeroMoney(request.reportCurrency),
      "known",
      "none",
      false,
      "No existing subscription was referenced by this scope. Nothing was allocated from a monthly fee onto the work.",
    );
  }
  const parts: Money[] = [];
  const origins: DataOrigin[] = [];
  let unpriced = 0;
  for (const id of referenced) {
    const sub = subscriptions.get(id);
    if (!sub?.recurringFee) {
      unpriced += 1;
      continue;
    }
    parts.push(sub.recurringFee);
    origins.push(sub.priceOrigin);
  }
  const combined = combineMoney(parts, unpriced, origins, request.reportCurrency, request.exchangeRates);
  const note = "Full recurring fee for the billing period of each referenced existing subscription. This is not an incremental cost of the scope and is not divided across tasks.";
  return fromCombined(combined, combined.status === "known" ? "priced" : "unpriced", false, [note, combined.note].filter(Boolean).join(" "));
}

function allocationFor(request: EstimationRequest, items: readonly WorkItemInput[]): AllocationForecast {
  const mode = request.allocation.mode;
  if (mode === "none") {
    return {
      mode,
      status: "not-requested",
      money: null,
      knownPortion: null,
      countsAsAdditionalCash: false,
      note: "Subscription fees were not allocated to this scope.",
    };
  }
  if (mode === "usage-weighted") {
    const weights = request.allocation.mode === "usage-weighted" ? request.allocation.weights : [];
    if (weights.some((weight) => weight.origin !== "known" && weight.origin !== "observed")) {
      return {
        mode,
        status: "unknown",
        money: null,
        knownPortion: null,
        countsAsAdditionalCash: false,
        note: "Usage-weighted allocation needs measured weights (origin known or observed). Unmeasured weights were not turned into a share.",
      };
    }
    let total = 0;
    let mine = 0;
    const projects = new Set(items.map((item) => item.projectId));
    for (const weight of weights) {
      total += weight.weight;
      if (projects.has(weight.projectId)) mine += weight.weight;
    }
    if (!(total > 0) || !Number.isFinite(total)) {
      return {
        mode,
        status: "unknown",
        money: null,
        knownPortion: null,
        countsAsAdditionalCash: false,
        note: "Usage weights do not form a positive total, so no share was computed.",
      };
    }
    return {
      mode,
      ...feeShare(request, mine / total, "Usage-weighted share of recurring fees. The share uses measured weights. It is not additional cash."),
    };
  }
  const shares = request.allocation.mode === "fixed-share" ? request.allocation.shares : [];
  const parts: Money[] = [];
  const origins: DataOrigin[] = [];
  let unpriced = 0;
  const subscriptions = new Map(request.subscriptions.map((sub) => [sub.id, sub]));
  for (const share of shares) {
    const sub = subscriptions.get(share.subscriptionId);
    if (!sub?.recurringFee) {
      unpriced += 1;
      continue;
    }
    const minor = Math.round(sub.recurringFee.minor * share.share);
    if (!Number.isSafeInteger(minor)) {
      unpriced += 1;
      continue;
    }
    parts.push({ currency: sub.recurringFee.currency, minor });
    origins.push(sub.priceOrigin);
  }
  const combined = combineMoney(parts, unpriced, origins, request.reportCurrency, request.exchangeRates);
  return {
    mode,
    status: combined.status,
    money: combined.money,
    knownPortion: combined.knownPortion,
    countsAsAdditionalCash: false,
    note: ["Fixed share of the recurring fee. This allocation is not additional cash.", combined.note].filter(Boolean).join(" "),
  };
}

function feeShare(request: EstimationRequest, share: number, note: string): Omit<AllocationForecast, "mode"> {
  const parts: Money[] = [];
  const origins: DataOrigin[] = [];
  let unpriced = 0;
  for (const sub of request.subscriptions) {
    if (sub.commitment !== "existing") continue;
    if (!sub.recurringFee) {
      unpriced += 1;
      continue;
    }
    const minor = Math.round(sub.recurringFee.minor * share);
    if (!Number.isSafeInteger(minor)) {
      unpriced += 1;
      continue;
    }
    parts.push({ currency: sub.recurringFee.currency, minor });
    origins.push(sub.priceOrigin);
  }
  const combined = combineMoney(parts, unpriced, origins, request.reportCurrency, request.exchangeRates);
  return {
    status: combined.status,
    money: combined.money,
    knownPortion: combined.knownPortion,
    countsAsAdditionalCash: false,
    note: [note, combined.note].filter(Boolean).join(" "),
  };
}

function apiEquivalent(request: EstimationRequest, items: readonly WorkItemInput[], scenario: ScenarioId): CashForecast {
  if (request.apiRates === null) {
    return cashForecast("not-requested", null, null, "unknown", "none", false, "API-equivalent cost was not requested.");
  }
  const rates = request.apiRates;
  const parts: Money[] = [];
  const origins: DataOrigin[] = [];
  let unpriced = 0;
  let active = 0;
  for (const item of items) {
    for (const stage of item.stages) {
      const reps = countOf(stage.repetitions ?? ONCE, scenario);
      if (reps === 0) continue;
      active += 1;
      const priced = priceStage(stage, reps, scenario, rates);
      if (!priced) {
        unpriced += 1;
        continue;
      }
      parts.push(priced.money);
      origins.push(priced.origin);
    }
  }
  if (active === 0) {
    return cashForecast(
      "known",
      zeroMoney(request.reportCurrency),
      zeroMoney(request.reportCurrency),
      "known",
      "none",
      false,
      "API-equivalent cost is not a cash charge. There is no stage to price.",
    );
  }
  const combined = combineMoney(parts, unpriced, origins, request.reportCurrency, request.exchangeRates);
  return fromCombined(
    combined,
    combined.status === "known" ? "priced" : "unpriced",
    false,
    ["API-equivalent cost is not a cash charge against a subscription.", combined.note].filter(Boolean).join(" "),
  );
}

function priceStage(
  stage: StageInput,
  reps: number,
  scenario: ScenarioId,
  rates: readonly ApiRate[],
): { money: Money; origin: DataOrigin } | null {
  if (!stage.effort || !stage.modelId) return null;
  const agentMs = effortMs(stage.effort, scenario) * reps;
  if (!Number.isSafeInteger(agentMs)) return null;
  const matches = rates.filter((rate) => rate.modelId === stage.modelId && (rate.harnessId === null || rate.harnessId === (stage.harnessId ?? null)));
  const specific = matches.filter((rate) => rate.harnessId !== null);
  const chosen = specific.length === 1 ? specific[0] : specific.length === 0 && matches.length === 1 ? matches[0] : undefined;
  if (!chosen) return null;
  const minor = scaleCharge(chosen.money.minor, agentMs, chosen.perAgentMs);
  if (minor === null) return null;
  return { money: { currency: chosen.money.currency, minor }, origin: chosen.origin };
}

function assessBudget(request: EstimationRequest, cash: CashForecast, unauthorized: boolean): BudgetAssessment {
  const reasons: string[] = [];
  if (unauthorized) {
    reasons.push("The scenario needs a paid service that is not in the allowed list. The budget guard does not start that purchase.");
  }
  const cap = request.budget.maxAdditionalSpend;
  if (!cap) {
    reasons.push("No maximum additional spend was set, so the budget was not treated as kept.");
    return { verdict: unauthorized ? "potentially-over-budget" : "insufficient-data", reasons };
  }
  const capCombined = combineMoney([cap], 0, ["known"], request.reportCurrency, request.exchangeRates);
  if (capCombined.status !== "known" || !capCombined.money) {
    reasons.push("The budget cap has no exchange rate into the report currency.");
    return { verdict: "insufficient-data", reasons };
  }
  const limit = capCombined.money.minor;
  if (cash.status === "mixed-currency") {
    reasons.push("Additional cash mixes currencies that have no rate, so the budget was not treated as kept.");
    return { verdict: "insufficient-data", reasons };
  }
  if (cash.status === "known" && cash.money) {
    if (cash.money.minor > limit || unauthorized) {
      if (cash.money.minor > limit) reasons.push("Additional cash is above the maximum.");
      return { verdict: "over-budget", reasons };
    }
    reasons.push("Additional cash is known and within the maximum.");
    return { verdict: "within-budget", reasons };
  }
  const portion = cash.knownPortion?.minor ?? null;
  if (portion !== null && portion > limit) {
    reasons.push("The priced portion alone is already above the maximum.");
    return { verdict: "over-budget", reasons };
  }
  if (portion !== null) {
    reasons.push("Only part of additional cash is priced and that part is within the maximum. The unpriced part could exceed it.");
    return { verdict: "potentially-over-budget", reasons };
  }
  if (unauthorized) return { verdict: "potentially-over-budget", reasons };
  reasons.push("Additional cash is unknown, so the budget was not treated as kept.");
  return { verdict: "insufficient-data", reasons };
}

function referencedAccounts(request: EstimationRequest, items: readonly WorkItemInput[], scenario: ScenarioId): {
  missing: boolean;
  unknownCap: boolean;
  bindingCap: boolean;
} {
  const accounts = new Map(request.accounts.map((account) => [account.id, account]));
  const pinned = new Map<string, number>();
  let missing = false;
  for (const item of items) {
    const seen = new Set<string>();
    for (const stage of item.stages) {
      if (countOf(stage.repetitions ?? ONCE, scenario) === 0) continue;
      if (!stage.accountId || seen.has(stage.accountId)) continue;
      const account = accounts.get(stage.accountId);
      if (!account) {
        missing = true;
        continue;
      }
      seen.add(stage.accountId);
      pinned.set(account.id, (pinned.get(account.id) ?? 0) + 1);
    }
  }
  let unknownCap = false;
  let bindingCap = false;
  for (const [id, count] of pinned) {
    const cap = accounts.get(id)?.maxConcurrent;
    if (cap === null) unknownCap = true;
    if (typeof cap === "number" && count > cap) bindingCap = true;
  }
  return { missing, unknownCap, bindingCap };
}

function agentForecast(rollups: readonly ItemRollup[]): DurationForecast {
  if (rollups.length === 0) {
    return { status: "known", ms: 0, knownMs: 0, unknownStageIds: [], origin: "known", note: "The scope has no work items." };
  }
  let known = 0;
  let allKnown = true;
  let origin: DataOrigin = "known";
  let saw = false;
  const unknownStageIds: string[] = [];
  for (const rollup of rollups) {
    if (!rollup.agentKnown) allKnown = false;
    if (rollup.agentKnown || rollup.knownAgentMs > 0) {
      if (!Number.isSafeInteger(known + rollup.knownAgentMs)) {
        return {
          status: "unknown",
          ms: null,
          knownMs: null,
          unknownStageIds,
          origin: "unknown",
          note: "Agent time does not fit in a safe integer.",
        };
      }
      known += rollup.knownAgentMs;
      if (rollup.agentKnown) {
        origin = saw ? weakerOrigin(origin, rollup.origin) : rollup.origin;
        saw = true;
      }
    }
    unknownStageIds.push(...rollup.unknownStageIds.map((id) => `${rollup.item.id}/${id}`));
  }
  if (allKnown) {
    return { status: "known", ms: known, knownMs: known, unknownStageIds: [], origin: saw ? origin : "known", note: null };
  }
  if (known > 0) {
    return {
      status: "incomplete",
      ms: null,
      knownMs: known,
      unknownStageIds,
      origin: "unknown",
      note: "Some stages have no effort range. The known portion is not the total.",
    };
  }
  return {
    status: "unknown",
    ms: null,
    knownMs: null,
    unknownStageIds,
    origin: "unknown",
    note: "No stage in this scope has an effort range.",
  };
}

function calendarFor(
  request: EstimationRequest,
  rollups: readonly ItemRollup[],
  scenario: ScenarioId,
  cycles: string[][],
  external: readonly string[],
  coverage: CoverageBuild,
  unpaid: Shortfall[],
): CalendarForecast {
  const base: CalendarForecast = {
    status: "unknown",
    ms: null,
    scheduleMs: null,
    criticalPathMs: null,
    serialUpperBoundMs: null,
    method: "none",
    exact: false,
    startAtMs: request.startAtMs,
    finishAtMs: null,
    simplifications: [],
    unknownItemIds: rollups.filter((rollup) => rollup.itemMs === null).map((rollup) => rollup.item.id),
    note: null,
  };
  if (rollups.length === 0) {
    return { ...base, status: "known", ms: 0, scheduleMs: 0, criticalPathMs: 0, serialUpperBoundMs: 0, method: "critical-path", exact: true, note: "The scope has no work items." };
  }
  if (cycles.length > 0) {
    return {
      ...base,
      status: "invalid",
      note: `Dependency cycle: ${cycles[0]?.join(" → ") ?? ""}. No calendar completion time was produced.`,
    };
  }
  if (external.length > 0) {
    return {
      ...base,
      status: "incomplete",
      note: `Depends on items outside this scope (${external.join(", ")}). Those predecessors were not assumed finished, so no calendar completion time was produced.`,
    };
  }
  if (rollups.some((rollup) => rollup.itemMs === null)) {
    return {
      ...base,
      status: base.unknownItemIds.length === rollups.length ? "unknown" : "incomplete",
      note: "At least one item has an unknown stage, blocker, or required phase. Calendar completion time was not produced.",
    };
  }

  const ids = rollups.map((rollup) => rollup.item.id);
  const duration = new Map<string, number>();
  const deps = new Map<string, string[]>();
  const selected = new Set(ids);
  for (const rollup of rollups) {
    duration.set(rollup.item.id, rollup.itemMs ?? 0);
    deps.set(
      rollup.item.id,
      (rollup.item.dependsOn ?? []).filter((id) => selected.has(id)),
    );
  }

  const cap = request.parallelism.maxConcurrentItems;
  if (cap === null) {
    const bounds = scheduleItems(ids, duration, deps, "unbounded");
    return {
      ...base,
      status: "incomplete",
      criticalPathMs: bounds.criticalPathMs,
      serialUpperBoundMs: bounds.serialMs,
      note: "Item concurrency was not provided. The critical path is a dependency lower bound, not a calendar completion time.",
    };
  }

  const scheduled = scheduleItems(ids, duration, deps, cap);
  if (scheduled.cycles.length > 0 || scheduled.scheduleMs === null) {
    return { ...base, status: "invalid", note: "The dependency graph has a cycle. No calendar completion time was produced." };
  }

  const simplifications: string[] = [];
  if (!scheduled.exact) {
    simplifications.push(
      "A concurrency cap is in effect. The calendar uses list scheduling (longest remaining path first), which is a feasible plan, not a proven optimum.",
    );
  }

  return applyLimits(
    request,
    base,
    coverage,
    unpaid,
    {
      scheduleMs: scheduled.scheduleMs,
      criticalPathMs: scheduled.criticalPathMs,
      serialMs: scheduled.serialMs,
      method: scheduled.method,
      exact: scheduled.exact,
      simplifications,
    },
    referencedAccounts(request, rollups.map((rollup) => rollup.item), scenario),
  );
}

function applyLimits(
  request: EstimationRequest,
  base: CalendarForecast,
  coverage: CoverageBuild,
  unpaid: Shortfall[],
  built: {
    scheduleMs: number;
    criticalPathMs: number | null;
    serialMs: number | null;
    method: CalendarForecast["method"];
    exact: boolean;
    simplifications: string[];
  },
  pins: { missing: boolean; unknownCap: boolean; bindingCap: boolean },
): CalendarForecast {
  const simplifications = [...built.simplifications];
  let exact = built.exact;
  let scheduleMs = built.scheduleMs;
  const blocks: string[] = [];

  if (pins.missing) {
    blocks.push("A stage names an account that is not in the request, so account concurrency is unknown and the calendar is not a completion time.");
  } else if (pins.unknownCap) {
    blocks.push("A referenced account does not declare how many runs can execute at once, so the calendar is not a completion time.");
  } else if (pins.bindingCap) {
    exact = false;
    simplifications.push(
      "An account concurrency cap is lower than the number of pinned items. The timeline was not re-simulated per account; treat this length as a simplification.",
    );
  }

  if (coverage.report.status === "unknown" && request.subscriptions.length > 0) {
    blocks.push("Subscription capacity could not be compared with this work, so no quota wait was added and the calendar is not a completion time.");
  } else if (coverage.report.status === "insufficient" && unpaid.length > 0) {
    const resets = unpaid.map((gap) => gap.resetsAtMs);
    if (resets.some((reset) => reset === null) || request.startAtMs === null) {
      blocks.push("Measured quota does not cover the work, extra spend is off, and the wait until reset is unknown. No completion time was produced.");
    } else if (blocks.length === 0) {
      let wait = 0;
      for (const reset of resets) {
        if (reset !== null && request.startAtMs !== null) wait = Math.max(wait, Math.max(0, reset - request.startAtMs));
      }
      if (!Number.isSafeInteger(scheduleMs + wait)) {
        blocks.push("The quota wait does not fit in a safe integer.");
      } else {
        scheduleMs += wait;
        exact = false;
        simplifications.push("Quota reset wait is a single delay added on top of the schedule, not a per-account simulation.");
      }
    }
  } else if (coverage.report.status === "no-subscription") {
    simplifications.push("No subscriptions were supplied, so the calendar ignores account quotas.");
  }

  if (blocks.length > 0) {
    return {
      ...base,
      status: "incomplete",
      ms: null,
      scheduleMs: built.scheduleMs,
      criticalPathMs: built.criticalPathMs,
      serialUpperBoundMs: built.serialMs,
      method: built.method,
      exact: false,
      finishAtMs: null,
      simplifications,
      unknownItemIds: [],
      note: blocks[0] ?? null,
    };
  }

  let ms: number | null = scheduleMs;
  let note: string | null = null;
  let status: CalendarForecast["status"] | null = null;
  if (ms !== null) {
    const duty = request.machine.dutyCycle;
    const pause = request.machine.plannedPauseMs;
    if (duty === null || pause === null) {
      status = "incomplete";
      ms = null;
      exact = false;
      note = "Local machine availability was not provided, so the schedule length is not a calendar completion time.";
    } else {
      const stretched = Math.ceil(ms / duty + pause);
      if (!Number.isSafeInteger(stretched)) {
        status = "unknown";
        ms = null;
        exact = false;
        note = "The calendar stretch does not fit in a safe integer.";
      } else {
        if (stretched !== ms) {
          simplifications.push("Machine availability is a single duty-cycle stretch plus the declared pauses, not a calendar of on and off windows.");
        }
        ms = stretched;
      }
    }
  }

  if (status === null) status = ms === null ? "unknown" : exact ? "known" : "estimated";
  const finishAtMs = status === "known" && exact && ms !== null && request.startAtMs !== null ? request.startAtMs + ms : null;
  if (finishAtMs !== null && !Number.isSafeInteger(finishAtMs)) {
    return {
      ...base,
      status: "known",
      ms,
      scheduleMs,
      criticalPathMs: built.criticalPathMs,
      serialUpperBoundMs: built.serialMs,
      method: built.method,
      exact,
      finishAtMs: null,
      simplifications,
      note: "The finish instant does not fit in a safe integer, so no date was produced.",
    };
  }
  return {
    ...base,
    status,
    ms,
    scheduleMs,
    criticalPathMs: built.criticalPathMs,
    serialUpperBoundMs: built.serialMs,
    method: built.method,
    exact,
    finishAtMs,
    simplifications,
    unknownItemIds: [],
    note,
  };
}

export function forecastScenario(
  request: EstimationRequest,
  items: readonly WorkItemInput[],
  scenario: ScenarioId,
  cycles: string[][],
  external: readonly string[],
): ScenarioForecast {
  const rollups = items.map((item) => rollupItem(item, scenario));
  const coverage = coverageFor(request, items, scenario);
  const cash = additionalCash(request, items, scenario, coverage);
  const calendar = calendarFor(request, rollups, scenario, cycles, external, coverage, cash.unpaid);
  return {
    scenario,
    agent: agentForecast(rollups),
    calendar,
    agentRuns: rollups.reduce((sum, rollup) => sum + rollup.runs, 0),
    reworkRuns: rollups.reduce((sum, rollup) => sum + rollup.reworkRuns, 0),
    coverage: coverage.report,
    additionalCash: cash.cash,
    apiEquivalent: apiEquivalent(request, items, scenario),
    subscriptionFees: subscriptionFees(request, items, scenario),
    allocation: allocationFor(request, items),
    budget: assessBudget(request, cash.cash, cash.unauthorized),
    items: rollups.map((rollup) => ({
      itemId: rollup.item.id,
      projectId: rollup.item.projectId,
      groupId: rollup.item.groupId ?? null,
      agentMs: rollup.agentMs,
      itemMs: rollup.itemMs,
      agentRuns: rollup.runs,
      reworkRuns: rollup.reworkRuns,
      unknownStageIds: rollup.unknownStageIds,
    })),
  };
}
