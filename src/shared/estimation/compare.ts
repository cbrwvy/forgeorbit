/**
 * Estimate versus actual. Pure, JSON-serializable, and inert: it does not
 * update a model and it does not invent the missing side of a comparison.
 */

import { convertMoney } from "./money.ts";
import type {
  ActualSnapshot,
  EstimateSnapshot,
  EstimateVsActual,
  ExchangeRate,
  Money,
  Variance,
} from "./types.ts";

function unknown(reason: string): Variance {
  return { status: "unknown", absolute: null, relative: null, reason };
}

function numericVariance(estimated: number | null, actual: number | null, label: string): Variance {
  if (estimated === null || actual === null) return unknown(`${label} is missing on the estimate or the actual.`);
  if (!Number.isFinite(estimated) || !Number.isFinite(actual)) return unknown(`${label} is not a finite number.`);
  const absolute = actual - estimated;
  if (estimated === 0) {
    return {
      status: "known",
      absolute,
      relative: actual === 0 ? 0 : null,
      reason: actual === 0 ? null : "The estimated baseline is zero, so a relative variance was not computed.",
    };
  }
  return { status: "known", absolute, relative: (actual - estimated) / estimated, reason: null };
}

function cashVariance(estimated: Money | null, actual: Money | null, rates: readonly ExchangeRate[]): Variance {
  if (!estimated || !actual) return unknown("Additional cash is missing on the estimate or the actual.");
  if (estimated.currency === actual.currency) return numericVariance(estimated.minor, actual.minor, "Additional cash");
  const converted = convertMoney(actual, estimated.currency, rates);
  if (!converted) {
    return unknown(`Additional cash is in ${actual.currency} and ${estimated.currency}, and no exchange rate was provided.`);
  }
  return numericVariance(estimated.minor, converted.minor, "Additional cash");
}

export function compareEstimateToActual(input: {
  id: string;
  scopeId: string;
  estimate: EstimateSnapshot;
  actual: ActualSnapshot;
  exchangeRates?: readonly ExchangeRate[];
}): EstimateVsActual {
  const rates = input.exchangeRates ?? [];
  const missing: string[] = [];
  if (
    input.actual.agentMs === null &&
    input.actual.calendarMs === null &&
    input.actual.additionalCash === null &&
    input.actual.agentRuns === null &&
    input.actual.reviewReworkCount === null
  ) {
    missing.push("No actual observations were provided.");
  }
  if (input.actual.agentMs === null) missing.push("Actual agent duration was not provided.");
  if (input.actual.calendarMs === null) missing.push("Actual calendar duration was not provided.");
  if (input.actual.additionalCash === null) missing.push("Actual additional cash was not provided.");
  if (input.actual.agentRuns === null) missing.push("Actual agent runs were not provided.");
  if (input.actual.reviewReworkCount === null) missing.push("Actual review rework count was not provided.");
  if (input.estimate.agentMs === null) missing.push("Estimated agent duration was not known.");
  if (input.estimate.calendarMs === null) missing.push("Estimated calendar duration was not known.");
  if (input.estimate.additionalCash === null) missing.push("Estimated additional cash was not known.");

  return {
    id: input.id,
    scopeId: input.scopeId,
    estimate: input.estimate,
    actual: input.actual,
    durationVariance: numericVariance(input.estimate.agentMs, input.actual.agentMs, "Agent duration"),
    calendarVariance: numericVariance(input.estimate.calendarMs, input.actual.calendarMs, "Calendar duration"),
    cashVariance: cashVariance(input.estimate.additionalCash, input.actual.additionalCash, rates),
    runsVariance: numericVariance(input.estimate.agentRuns, input.actual.agentRuns, "Agent runs"),
    reworkVariance: numericVariance(input.estimate.reworkRuns, input.actual.reviewReworkCount, "Review rework"),
    reviewReworkCount: input.actual.reviewReworkCount,
    missing,
  };
}
