/**
 * Structural checks. Domain outcomes (unknown quota, unknown effort) are not
 * errors — they become unknown forecasts. Cycles are detected later so agent
 * time can still be summed.
 */

import { isCurrencyCode } from "./money.ts";
import { ESTIMATION_LIMITS, type EffortRange, type EstimationIssue, type EstimationRequest, type Money } from "./types.ts";

function issue(path: string, code: string, message: string): EstimationIssue {
  return { severity: "error", code, path, message };
}

function isSafeNonNegInt(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function checkId(issues: EstimationIssue[], path: string, id: unknown): void {
  if (typeof id !== "string" || id.trim() === "" || id.length > ESTIMATION_LIMITS.maxIdLength || id.includes("\0")) {
    issues.push(issue(path, "bad-id", "An id must be a non-empty string."));
  }
}

function checkCurrency(issues: EstimationIssue[], path: string, currency: unknown): void {
  if (typeof currency !== "string" || !isCurrencyCode(currency)) {
    issues.push(issue(path, "bad-currency", "A currency must be three uppercase letters."));
  }
}

function checkMoney(issues: EstimationIssue[], path: string, money: Money | null): void {
  if (money === null) return;
  if (!money || typeof money !== "object") {
    issues.push(issue(path, "bad-money", "Money must be a currency plus an integer minor amount."));
    return;
  }
  checkCurrency(issues, `${path}.currency`, money.currency);
  if (!isSafeNonNegInt(money.minor)) {
    issues.push(issue(path, "bad-money", "Money minor units must be a non-negative integer."));
  }
}

function checkEffort(issues: EstimationIssue[], path: string, effort: EffortRange | null | undefined): void {
  if (effort == null) return;
  const values = [effort.optimisticMs, effort.expectedMs, effort.conservativeMs];
  if (values.some((value) => !isSafeNonNegInt(value))) {
    issues.push(issue(path, "bad-effort", "Effort milliseconds must be non-negative integers."));
    return;
  }
  if (effort.optimisticMs > effort.expectedMs || effort.expectedMs > effort.conservativeMs) {
    issues.push(issue(path, "inverted-range", "Effort must rise from optimistic to expected to conservative."));
  }
  if (effort.origin === "unknown") {
    issues.push(issue(path, "bad-origin", "A provided effort range cannot have origin unknown. Omit the range instead."));
  }
}

function checkCountRange(issues: EstimationIssue[], path: string, count: { optimistic: number; expected: number; conservative: number } | undefined): void {
  if (!count) return;
  const values = [count.optimistic, count.expected, count.conservative];
  if (values.some((value) => !isSafeNonNegInt(value))) {
    issues.push(issue(path, "bad-repetition", "Repetitions must be non-negative integers."));
    return;
  }
  if (count.optimistic > count.expected || count.expected > count.conservative) {
    issues.push(issue(path, "inverted-range", "Repetitions must rise from optimistic to expected to conservative."));
  }
}

export function validateRequest(request: EstimationRequest): EstimationIssue[] {
  const issues: EstimationIssue[] = [];
  if (!request || typeof request !== "object") {
    return [issue("request", "malformed", "The request must be an object.")];
  }
  if (!request.scope || typeof request.scope !== "object") {
    issues.push(issue("scope", "malformed", "A scope is required."));
  } else {
    checkId(issues, "scope.id", request.scope.id);
  }
  checkCurrency(issues, "reportCurrency", request.reportCurrency);

  if (!Array.isArray(request.items)) {
    issues.push(issue("items", "malformed", "Items must be an array."));
    return issues;
  }
  if (request.items.length > ESTIMATION_LIMITS.maxItems) {
    issues.push(issue("items", "too-large", `At most ${ESTIMATION_LIMITS.maxItems} work items are accepted.`));
  }

  const itemIds = new Set<string>();
  for (const item of request.items) {
    if (!item || typeof item !== "object") {
      issues.push(issue("items", "malformed", "Each work item must be an object."));
      continue;
    }
    checkId(issues, `items.${String(item.id)}`, item.id);
    if (typeof item.id === "string") {
      if (itemIds.has(item.id)) issues.push(issue(`items.${item.id}`, "duplicate-id", `Duplicate work item id ${item.id}.`));
      itemIds.add(item.id);
    }
    if (typeof item.projectId !== "string" || item.projectId.trim() === "") {
      issues.push(issue(`items.${String(item.id)}.projectId`, "bad-id", "A project id is required."));
    }
    if (!Array.isArray(item.stages)) {
      issues.push(issue(`items.${String(item.id)}.stages`, "malformed", "Stages must be an array."));
      continue;
    }
    if (item.stages.length > ESTIMATION_LIMITS.maxStagesPerItem) {
      issues.push(issue(`items.${item.id}.stages`, "too-large", "Too many stages on one item."));
    }
    const stageIds = new Set<string>();
    for (const stage of item.stages) {
      checkId(issues, `items.${item.id}.stages`, stage?.id);
      if (stage && stageIds.has(stage.id)) {
        issues.push(issue(`items.${item.id}.stages.${stage.id}`, "duplicate-id", `Duplicate stage id ${stage.id}.`));
      }
      if (stage) stageIds.add(stage.id);
      checkEffort(issues, `items.${item.id}.stages.${stage?.id ?? "?"}.effort`, stage?.effort);
      checkCountRange(issues, `items.${item.id}.stages.${stage?.id ?? "?"}.repetitions`, stage?.repetitions);
      if (stage?.consumption) {
        if (!isSafeNonNegInt(stage.consumption.amount)) {
          issues.push(issue(`items.${item.id}.stages.${stage.id}.consumption`, "bad-consumption", "Consumption must be a non-negative integer."));
        }
        if (stage.consumption.unit === "credits") {
          checkCurrency(issues, `items.${item.id}.stages.${stage.id}.consumption.currency`, stage.consumption.currency);
        }
        if (stage.consumption.origin === "unknown") {
          issues.push(issue(`items.${item.id}.stages.${stage.id}.consumption`, "bad-origin", "Omit consumption instead of marking it unknown."));
        }
      }
    }
    const deps = item.dependsOn ?? [];
    if (!Array.isArray(deps)) {
      issues.push(issue(`items.${item.id}.dependsOn`, "malformed", "Dependencies must be an array of ids."));
    } else if (deps.length > ESTIMATION_LIMITS.maxDependenciesPerItem) {
      issues.push(issue(`items.${item.id}.dependsOn`, "too-large", "Too many dependencies."));
    }
    const blockers = item.blockers ?? [];
    if (blockers.length > ESTIMATION_LIMITS.maxBlockersPerItem) {
      issues.push(issue(`items.${item.id}.blockers`, "too-large", "Too many blockers."));
    }
    for (const blocker of blockers) {
      checkId(issues, `items.${item.id}.blockers`, blocker?.id);
      checkEffort(issues, `items.${item.id}.blockers.${blocker?.id ?? "?"}`, blocker?.wait);
    }
  }

  for (const item of request.items) {
    if (!item || typeof item !== "object") continue;
    for (const dep of item.dependsOn ?? []) {
      if (dep === item.id) {
        issues.push(issue(`items.${item.id}.dependsOn`, "self-dependency", `${item.id} depends on itself.`));
      } else if (!itemIds.has(dep)) {
        issues.push(issue(`items.${item.id}.dependsOn`, "unknown-dependency", `${item.id} depends on unknown item ${dep}.`));
      }
    }
  }

  if (Array.isArray(request.scope?.itemIds)) {
    for (const id of request.scope.itemIds) {
      if (!itemIds.has(id)) issues.push(issue("scope.itemIds", "unknown-scope-item", `Scope names unknown item ${id}.`));
    }
  }

  if (!Array.isArray(request.subscriptions) || !Array.isArray(request.accounts)) {
    issues.push(issue("resources", "malformed", "Subscriptions and accounts must be arrays."));
    return issues;
  }
  if (request.subscriptions.length > ESTIMATION_LIMITS.maxSubscriptions) {
    issues.push(issue("subscriptions", "too-large", "Too many subscriptions."));
  }
  if (request.accounts.length > ESTIMATION_LIMITS.maxAccounts) {
    issues.push(issue("accounts", "too-large", "Too many accounts."));
  }

  const subIds = new Set<string>();
  for (const sub of request.subscriptions) {
    checkId(issues, "subscriptions", sub?.id);
    if (sub && subIds.has(sub.id)) issues.push(issue(`subscriptions.${sub.id}`, "duplicate-id", `Duplicate subscription ${sub.id}.`));
    if (sub) subIds.add(sub.id);
    if (!sub) continue;
    if (typeof sub.provider !== "string" || sub.provider.trim() === "") {
      issues.push(issue(`subscriptions.${sub.id}.provider`, "bad-id", "A provider id is required."));
    }
    checkMoney(issues, `subscriptions.${sub.id}.recurringFee`, sub.recurringFee);
    checkMoney(issues, `subscriptions.${sub.id}.purchasePrice`, sub.purchasePrice);
    checkMoney(issues, `subscriptions.${sub.id}.allowedAdditionalSpend`, sub.allowedAdditionalSpend);
    const priced = sub.recurringFee !== null || sub.purchasePrice !== null || (sub.overage?.prices?.length ?? 0) > 0;
    if (priced && sub.priceOrigin === "unknown") {
      issues.push(issue(`subscriptions.${sub.id}.priceOrigin`, "bad-origin", "A supplied price cannot have origin unknown."));
    }
    if (!Array.isArray(sub.quotas)) {
      issues.push(issue(`subscriptions.${sub.id}.quotas`, "malformed", "Quotas must be an array."));
      continue;
    }
    if (sub.quotas.length > ESTIMATION_LIMITS.maxQuotasPerSubscription) {
      issues.push(issue(`subscriptions.${sub.id}.quotas`, "too-large", "Too many quotas."));
    }
    const quotaIds = new Set<string>();
    for (const quota of sub.quotas) {
      checkId(issues, `subscriptions.${sub.id}.quotas`, quota?.id);
      if (quota && quotaIds.has(quota.id)) {
        issues.push(issue(`subscriptions.${sub.id}.quotas.${quota.id}`, "duplicate-id", `Duplicate quota ${quota.id}.`));
      }
      if (quota) quotaIds.add(quota.id);
      if (!quota) continue;
      const unit = quota.unit;
      if (!unit || typeof unit !== "object") {
        issues.push(issue(`subscriptions.${sub.id}.quotas.${quota.id}`, "bad-quota", "A quota unit is required."));
        continue;
      }
      if (unit.kind === "percent-used") {
        if (typeof unit.usedPercent !== "number" || !Number.isFinite(unit.usedPercent) || unit.usedPercent < 0 || unit.usedPercent > 100) {
          issues.push(issue(`subscriptions.${sub.id}.quotas.${quota.id}`, "bad-quota", "usedPercent must be between 0 and 100."));
        }
      } else if (unit.kind === "count") {
        if (!isSafeNonNegInt(unit.remaining)) {
          issues.push(issue(`subscriptions.${sub.id}.quotas.${quota.id}`, "bad-quota", "Remaining quota must be a non-negative integer."));
        }
        if (unit.limit !== null && (!isSafeNonNegInt(unit.limit) || unit.limit < unit.remaining)) {
          issues.push(issue(`subscriptions.${sub.id}.quotas.${quota.id}`, "bad-quota", "A quota limit must be an integer at least as large as the remainder."));
        }
      } else if (unit.kind === "credits") {
        checkCurrency(issues, `subscriptions.${sub.id}.quotas.${quota.id}.currency`, unit.currency);
        if (!isSafeNonNegInt(unit.remainingMinor)) {
          issues.push(issue(`subscriptions.${sub.id}.quotas.${quota.id}`, "bad-quota", "Remaining credits must be a non-negative integer."));
        }
      }
      if (unit.kind !== "opaque" && unit.resetsAtMs !== null && !isSafeNonNegInt(unit.resetsAtMs)) {
        issues.push(issue(`subscriptions.${sub.id}.quotas.${quota.id}.resetsAtMs`, "bad-quota", "A reset instant must be an integer epoch millisecond or null."));
      }
    }
    for (const price of sub.overage?.prices ?? []) {
      if (!price || !isSafeNonNegInt(price.per) || price.per <= 0) {
        issues.push(issue(`subscriptions.${sub.id}.overage`, "bad-price", "An overage price must cover a positive integer number of units."));
      }
      checkMoney(issues, `subscriptions.${sub.id}.overage`, price?.money ?? null);
      if (price?.origin === "unknown") {
        issues.push(issue(`subscriptions.${sub.id}.overage`, "bad-origin", "Omit an overage price instead of marking it unknown."));
      }
    }
  }

  const accountIds = new Set<string>();
  for (const account of request.accounts) {
    checkId(issues, "accounts", account?.id);
    if (account && accountIds.has(account.id)) {
      issues.push(issue(`accounts.${account.id}`, "duplicate-id", `Duplicate account ${account.id}.`));
    }
    if (account) accountIds.add(account.id);
    if (!account) continue;
    if (account.subscriptionId !== null && !subIds.has(account.subscriptionId)) {
      issues.push(issue(`accounts.${account.id}.subscriptionId`, "unknown-subscription", `Account ${account.id} names unknown subscription ${account.subscriptionId}.`));
    }
    const cap = account.maxConcurrent;
    if (cap !== null && cap !== "unbounded" && (!isSafeNonNegInt(cap) || cap < 1)) {
      issues.push(issue(`accounts.${account.id}.maxConcurrent`, "bad-parallelism", "Account concurrency must be a positive integer, unbounded, or null."));
    }
  }

  const parallel = request.parallelism?.maxConcurrentItems;
  if (parallel !== null && parallel !== "unbounded" && (typeof parallel !== "number" || !isSafeNonNegInt(parallel) || parallel < 1)) {
    issues.push(issue("parallelism", "bad-parallelism", "Item concurrency must be a positive integer, unbounded, or null."));
  }

  const duty = request.machine?.dutyCycle;
  if (duty !== null && (typeof duty !== "number" || !Number.isFinite(duty) || duty <= 0 || duty > 1)) {
    issues.push(issue("machine.dutyCycle", "bad-duty-cycle", "Duty cycle must be in (0, 1] or null."));
  }
  const pause = request.machine?.plannedPauseMs;
  if (pause !== null && !isSafeNonNegInt(pause)) {
    issues.push(issue("machine.plannedPauseMs", "bad-pause", "Planned pause must be a non-negative integer or null."));
  }
  if (request.startAtMs !== null && !isSafeNonNegInt(request.startAtMs)) {
    issues.push(issue("startAtMs", "bad-time", "Start time must be an integer epoch millisecond or null."));
  }

  checkMoney(issues, "budget.maxAdditionalSpend", request.budget?.maxAdditionalSpend ?? null);
  if (!Array.isArray(request.budget?.allowedPaidServices)) {
    issues.push(issue("budget.allowedPaidServices", "malformed", "Allowed paid services must be an array."));
  }

  if (!Array.isArray(request.exchangeRates)) {
    issues.push(issue("exchangeRates", "malformed", "Exchange rates must be an array."));
  } else {
    if (request.exchangeRates.length > ESTIMATION_LIMITS.maxExchangeRates) {
      issues.push(issue("exchangeRates", "too-large", "Too many exchange rates."));
    }
    for (const rate of request.exchangeRates) {
      checkCurrency(issues, "exchangeRates.from", rate?.from);
      checkCurrency(issues, "exchangeRates.to", rate?.to);
      if (rate && rate.from === rate.to) {
        issues.push(issue("exchangeRates", "bad-rate", "An exchange rate must cross two currencies."));
      }
      if (!rate || typeof rate.rate !== "number" || !Number.isFinite(rate.rate) || rate.rate <= 0) {
        issues.push(issue("exchangeRates", "bad-rate", "An exchange rate must be a positive finite number."));
      }
      if (rate?.origin === "unknown") {
        issues.push(issue("exchangeRates", "bad-origin", "Omit a rate instead of marking it unknown."));
      }
    }
  }

  const allocation = request.allocation;
  if (!allocation || allocation.mode === "none") {
    // nothing to check
  } else if (allocation.mode === "fixed-share") {
    const seen = new Set<string>();
    for (const share of allocation.shares ?? []) {
      if (!share || !subIds.has(share.subscriptionId)) {
        issues.push(issue("allocation", "unknown-subscription", "A fixed share names a subscription that is not in the request."));
      }
      if (share && seen.has(share.subscriptionId)) {
        issues.push(issue("allocation", "duplicate-id", `More than one share for ${share.subscriptionId}.`));
      }
      if (share) seen.add(share.subscriptionId);
      if (!share || typeof share.share !== "number" || !Number.isFinite(share.share) || share.share <= 0 || share.share > 1) {
        issues.push(issue("allocation", "bad-share", "A fixed share must be in (0, 1]."));
      }
    }
  } else if (allocation.mode === "usage-weighted") {
    for (const weight of allocation.weights ?? []) {
      if (!weight || typeof weight.weight !== "number" || !Number.isFinite(weight.weight) || weight.weight <= 0) {
        issues.push(issue("allocation", "bad-weight", "A usage weight must be a positive finite number."));
      }
    }
  } else {
    issues.push(issue("allocation", "malformed", "Unknown allocation mode."));
  }

  if (request.apiRates !== null) {
    if (!Array.isArray(request.apiRates)) {
      issues.push(issue("apiRates", "malformed", "API rates must be an array or null."));
    } else {
      if (request.apiRates.length > ESTIMATION_LIMITS.maxApiRates) {
        issues.push(issue("apiRates", "too-large", "Too many API rates."));
      }
      for (const rate of request.apiRates) {
        checkId(issues, "apiRates", rate?.id);
        if (!rate || !isSafeNonNegInt(rate.perAgentMs) || rate.perAgentMs <= 0) {
          issues.push(issue("apiRates", "bad-price", "An API rate must name a positive agent-time denominator."));
        }
        checkMoney(issues, "apiRates", rate?.money ?? null);
        if (rate?.origin === "unknown") {
          issues.push(issue("apiRates", "bad-origin", "Omit an API rate instead of marking it unknown."));
        }
      }
    }
  }

  if (request.history !== null) {
    if (!Array.isArray(request.history)) {
      issues.push(issue("history", "malformed", "History must be an array or null."));
    } else if (request.history.length > ESTIMATION_LIMITS.maxHistory) {
      issues.push(issue("history", "too-large", "Too many history samples."));
    } else {
      for (const sample of request.history) {
        if (!sample || sample.origin !== "observed" || !isSafeNonNegInt(sample.agentMs) || !isSafeNonNegInt(sample.sampleCount) || sample.sampleCount < 1) {
          issues.push(issue("history", "bad-history", "A history sample must be observed, with a non-negative duration and a positive sample count."));
        }
      }
    }
  }

  return issues;
}
