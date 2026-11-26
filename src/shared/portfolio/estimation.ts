/**
 * Portfolio totals over FO-006A forecasts. This file does not estimate.
 * Project calendars are not added together to invent a portfolio finish
 * time, and a subscription fee is counted once per subscription id.
 */

import { combineMoney, weakerOrigin } from "../estimation/money.ts";
import type { CashForecast, ConfidenceLevel, DataOrigin, Money } from "../estimation/types.ts";
import type { IndexedPortfolio, IndexedProject } from "./snapshot.ts";
import { matchTaskResource } from "./resources.ts";
import type { PortfolioCalendar, PortfolioDuration, PortfolioEstimation, PortfolioMoney } from "./types.ts";

const CONFIDENCE_RANK: Record<ConfidenceLevel, number> = { none: 0, low: 1, medium: 2, high: 3 };

export function aggregateEstimation(indexed: IndexedPortfolio): PortfolioEstimation {
  const current = indexed.projects.filter((project) => project.freshness === "current");
  const contended = contendedResourceIds(current, indexed.resources);
  const scenarios = new Set(current.map((project) => project.project.estimate?.scenario).filter((scenario) => scenario != null));
  return {
    scenarioNote: scenarios.size > 1
      ? "Projects were estimated under different scenarios. A mixed sum is not one scenario."
      : "Project forecasts are reused as given. Nothing was re-estimated.",
    agent: sumAgent(indexed.projects, current, scenarios.size > 1),
    calendar: sumCalendar(indexed.projects, current, contended, indexed.input.policy.calendarCombination),
    additionalCash: sumAdditionalCash(indexed, current),
    apiEquivalent: sumApi(indexed, current),
    subscriptions: sumSubscriptions(indexed, current),
    proposedSubscriptionIds: proposedIds(current),
    confidence: confidenceOf(indexed.projects, current).level,
    confidenceNote: confidenceOf(indexed.projects, current).note,
    closestProject: closest(current, contended),
    remainingWindow: {
      status: "unknown",
      note: "No remaining-time window or per-task durations were supplied, so what fits today is unknown.",
    },
    projects: indexed.projects.map(sliceOf),
    simplifications: [
      "Agent time is a sum of project forecasts. A missing project is not zero.",
      "Calendar time is not the sum of project calendars when accounts are shared.",
      "Existing subscription fees are counted once per subscription id.",
      "API-equivalent cost is not additional cash.",
      "No minute-by-minute portfolio schedule is built.",
    ],
  };
}

function sumAgent(all: readonly IndexedProject[], current: readonly IndexedProject[], mixedScenarios: boolean): PortfolioDuration {
  if (all.length === 0) return { status: "known", ms: 0, knownMs: 0, origin: "known", note: "The portfolio has no projects." };
  if (current.length === 0) return { status: "unknown", ms: null, knownMs: null, origin: "unknown", note: "No project snapshot is current, so agent time is unknown." };
  let knownMs = 0;
  let headline = 0;
  let headlineOk = true;
  let gap = false;
  let estimated = mixedScenarios;
  let origin: DataOrigin = "known";
  let sawNumber = false;
  for (const project of current) {
    const agent = project.project.estimate?.agent ?? null;
    if (!agent) {
      gap = true;
      headlineOk = false;
      continue;
    }
    origin = weakerOrigin(origin, agent.origin);
    if (agent.status === "estimated") estimated = true;
    if (agent.status === "unknown" || agent.status === "incomplete") {
      gap = true;
      headlineOk = false;
    }
    const partial = agent.knownMs ?? (agent.status === "known" || agent.status === "estimated" ? agent.ms : null);
    if (partial != null) {
      const next = knownMs + partial;
      if (!Number.isSafeInteger(next)) {
        return { status: "unknown", ms: null, knownMs: null, origin: "unknown", note: "Agent time does not fit in a safe integer." };
      }
      knownMs = next;
      sawNumber = true;
    }
    if (headlineOk && agent.ms != null && (agent.status === "known" || agent.status === "estimated")) {
      const next = headline + agent.ms;
      if (!Number.isSafeInteger(next)) headlineOk = false;
      else headline = next;
    } else {
      headlineOk = false;
    }
  }
  if (!gap && headlineOk) {
    return {
      status: estimated ? "estimated" : "known",
      ms: headline,
      knownMs: headline,
      origin: estimated ? weakerOrigin(origin, "estimated") : origin,
      note: mixedScenarios ? "The sum mixes scenarios and is not a single forecast." : null,
    };
  }
  if (sawNumber) {
    return {
      status: "incomplete",
      ms: null,
      knownMs,
      origin,
      note: "At least one current project has an incomplete or missing agent forecast. The known portion is not the total.",
    };
  }
  return { status: "unknown", ms: null, knownMs: null, origin: "unknown", note: "Agent time is unknown." };
}

function sumCalendar(
  all: readonly IndexedProject[],
  current: readonly IndexedProject[],
  contended: readonly string[],
  combination: IndexedPortfolio["input"]["policy"]["calendarCombination"],
): PortfolioCalendar {
  if (all.length === 0) {
    return { status: "known", ms: 0, method: "none", exact: true, note: "The portfolio has no projects, so there is nothing to finish." };
  }
  if (current.length === 0) {
    return { status: "unknown", ms: null, method: "none", exact: false, note: "No project snapshot is current, so the portfolio calendar is unknown." };
  }
  const calendars = current.map((project) => project.project.estimate?.calendar ?? null);
  if (calendars.some((calendar) => calendar == null || calendar.status === "unknown")) {
    return { status: "unknown", ms: null, method: "none", exact: false, note: "A current project has no known calendar. The gap was not filled with zero." };
  }
  if (calendars.some((calendar) => calendar != null && (calendar.status === "incomplete" || calendar.ms == null))) {
    return { status: "incomplete", ms: null, method: "none", exact: false, note: "A current project calendar is incomplete, so the portfolio calendar is incomplete." };
  }
  const values = calendars.map((calendar) => calendar?.ms ?? null);
  if (values.some((value) => value == null)) {
    return { status: "unknown", ms: null, method: "none", exact: false, note: "A calendar number was missing." };
  }
  const numbers = values.filter((value): value is number => value != null);
  if (contended.length > 0) {
    return {
      status: "unknown",
      ms: null,
      method: "none",
      exact: false,
      note: `Projects share constrained resource(s) ${contended.join(", ")}. Their calendars were computed separately and were not summed or treated as a portfolio finish time.`,
    };
  }
  if (current.length === 1) {
    const only = calendars[0];
    return {
      status: only?.status === "estimated" ? "estimated" : "known",
      ms: numbers[0] ?? null,
      method: "none",
      exact: only?.exact ?? false,
      note: "One current project. Its calendar stands for the portfolio. No second calendar was added.",
    };
  }
  if (combination === "serial") {
    const total = numbers.reduce((sum, value) => sum + value, 0);
    if (!Number.isSafeInteger(total)) {
      return { status: "unknown", ms: null, method: "none", exact: false, note: "The serial bound does not fit in a safe integer." };
    }
    return {
      status: "estimated",
      ms: total,
      method: "serial-sum",
      exact: false,
      note: "The owner asked for a serial bound across projects that do not share a constrained account. This is not a schedule.",
    };
  }
  if (combination === "concurrent-if-uncontended") {
    return {
      status: "estimated",
      ms: Math.max(...numbers),
      method: "slowest-project",
      exact: false,
      note: "No shared constrained account was found. The bound is the slowest project's own calendar. This is not a schedule.",
    };
  }
  return {
    status: "unknown",
    ms: null,
    method: "none",
    exact: false,
    note: "No rule was given for combining project calendars, so a portfolio finish time was not invented.",
  };
}

function closest(current: readonly IndexedProject[], contended: readonly string[]): PortfolioEstimation["closestProject"] {
  if (contended.length > 0) {
    return {
      status: "unknown",
      projectId: null,
      calendarMs: null,
      note: "Projects share a constrained resource, so independent calendars do not say which project finishes first.",
    };
  }
  const known = current.filter((project) => project.project.estimate?.calendar.status === "known" && project.project.estimate.calendar.ms != null);
  if (known.length === 0 || known.length !== current.length) {
    return { status: "unknown", projectId: null, calendarMs: null, note: "A current project has no known calendar, so the closest project is unknown." };
  }
  let best = known[0];
  for (const project of known) {
    const ms = project.project.estimate?.calendar.ms;
    const bestMs = best?.project.estimate?.calendar.ms;
    if (best && ms != null && bestMs != null && ms < bestMs) best = project;
  }
  if (!best || best.project.estimate?.calendar.ms == null) {
    return { status: "unknown", projectId: null, calendarMs: null, note: "No known calendar was usable." };
  }
  return {
    status: "known",
    projectId: best.project.id,
    calendarMs: best.project.estimate.calendar.ms,
    note: "Shortest known project calendar among current projects that do not share a constrained account. Not a joint schedule.",
  };
}

function sumAdditionalCash(indexed: IndexedPortfolio, current: readonly IndexedProject[]): PortfolioMoney {
  if (indexed.projects.length === 0) return noMoney("The portfolio has no projects.");
  const shared = sharedPositiveSubscription(current);
  if (shared) {
    return {
      status: "unknown",
      money: null,
      knownPortion: null,
      origin: "unknown",
      note: `Projects report additional cash against shared subscription ${shared}. The figures were estimated separately and were not added, because that would count the same quota twice.`,
    };
  }
  return sumCash(current.map((project) => project.project.estimate?.additionalCash ?? null), indexed, "cash");
}

function sumApi(indexed: IndexedPortfolio, current: readonly IndexedProject[]): PortfolioMoney {
  if (indexed.projects.length === 0) return noMoney("The portfolio has no projects.");
  const money = sumCash(current.map((project) => project.project.estimate?.apiEquivalent ?? null), indexed, "api");
  if (money.note == null && money.status === "known") {
    return { ...money, note: "API-equivalent cost is not additional cash." };
  }
  return money;
}

function sumCash(parts: Array<CashForecast | null>, indexed: IndexedPortfolio, mode: "cash" | "api"): PortfolioMoney {
  if (parts.length === 0) return { status: "unknown", money: null, knownPortion: null, origin: "unknown", note: "No current project estimate was available." };
  if (parts.some((part) => part == null)) {
    return { status: "unknown", money: null, knownPortion: null, origin: "unknown", note: "A current project has no estimate. The missing estimate was not treated as zero." };
  }
  const forecasts = parts.filter((part): part is CashForecast => part != null);
  if (forecasts.every((part) => part.status === "not-requested")) {
    return { status: "not-requested", money: null, knownPortion: null, origin: "unknown", note: "The figure was not requested." };
  }
  if (forecasts.some((part) => part.status === "mixed-currency")) {
    return { status: "mixed-currency", money: null, knownPortion: null, origin: "unknown", note: "A project estimate was already mixed-currency. Currencies were not combined." };
  }
  const reportCurrency = indexed.input.reportCurrency;
  if (!reportCurrency) {
    return { status: "unknown", money: null, knownPortion: null, origin: "unknown", note: "Report currency was not set, so amounts were not combined and no currency was assumed." };
  }
  const priced: Money[] = [];
  const origins: DataOrigin[] = [];
  let unpriced = 0;
  for (const part of forecasts) {
    if (mode === "cash" && part.money && part.countsAsAdditionalCash === false) {
      unpriced += 1;
      continue;
    }
    if ((part.status === "known" || part.status === "incomplete") && (part.money ?? part.knownPortion)) {
      const money = part.status === "known" ? part.money : part.knownPortion;
      if (money) {
        priced.push(money);
        origins.push(part.origin);
      }
      if (part.status !== "known" || part.money == null) unpriced += 1;
    } else {
      unpriced += 1;
    }
  }
  const combined = combineMoney(priced, unpriced, origins, reportCurrency, indexed.input.exchangeRates);
  return {
    status: combined.status,
    money: combined.money,
    knownPortion: combined.knownPortion,
    origin: combined.origin,
    note: combined.note,
  };
}

function sumSubscriptions(indexed: IndexedPortfolio, current: readonly IndexedProject[]): PortfolioMoney {
  if (indexed.projects.length === 0) return noMoney("The portfolio has no projects.");
  if (current.length === 0) {
    return { status: "unknown", money: null, knownPortion: null, origin: "unknown", note: "No current project was available, so subscription fees are unknown." };
  }
  if (current.some((project) => project.project.estimate == null)) {
    return { status: "unknown", money: null, knownPortion: null, origin: "unknown", note: "A current project has no estimate, so its subscriptions are unknown and were not assumed to be free." };
  }
  const fees = new Map<string, { fee: Money | null; origin: DataOrigin; conflict: boolean }>();
  let unitemized = false;
  for (const project of current) {
    const estimate = project.project.estimate;
    if (!estimate) continue;
    const existing = estimate.subscriptions.filter((subscription) => subscription.commitment === "existing");
    if (existing.length === 0 && estimate.subscriptionFees.money && estimate.subscriptionFees.money.minor > 0) unitemized = true;
    for (const subscription of existing) {
      const prior = fees.get(subscription.id);
      if (!prior) {
        fees.set(subscription.id, { fee: subscription.recurringFee, origin: subscription.priceOrigin, conflict: false });
        continue;
      }
      if (!sameMoney(prior.fee, subscription.recurringFee)) prior.conflict = true;
      prior.origin = weakerOrigin(prior.origin, subscription.priceOrigin);
    }
  }
  if (unitemized) {
    return {
      status: "unknown",
      money: null,
      knownPortion: null,
      origin: "unknown",
      note: "A project reported a subscription fee without naming the subscription, so a shared subscription could have been counted twice. No total was published.",
    };
  }
  const conflicted = [...fees.entries()].filter(([, row]) => row.conflict).map(([id]) => id);
  if (conflicted.length > 0) {
    return {
      status: "unknown",
      money: null,
      knownPortion: null,
      origin: "unknown",
      note: `Subscription ${conflicted.join(", ")} was given different fees. Neither fee was chosen.`,
    };
  }
  if (fees.size === 0) return noMoney("No existing subscription fee was reported.");
  if (!indexed.input.reportCurrency) {
    return { status: "unknown", money: null, knownPortion: null, origin: "unknown", note: "Report currency was not set, so subscription fees were not combined." };
  }
  const priced: Money[] = [];
  const origins: DataOrigin[] = [];
  let unpriced = 0;
  for (const row of fees.values()) {
    origins.push(row.origin);
    if (row.fee) priced.push(row.fee);
    else unpriced += 1;
  }
  const combined = combineMoney(priced, unpriced, origins, indexed.input.reportCurrency, indexed.input.exchangeRates);
  const note = combined.note ?? "Each subscription id is counted once, even when several projects use it.";
  return { status: combined.status, money: combined.money, knownPortion: combined.knownPortion, origin: combined.origin, note };
}

function proposedIds(current: readonly IndexedProject[]): string[] {
  const ids = new Set<string>();
  for (const project of current) {
    for (const subscription of project.project.estimate?.subscriptions ?? []) {
      if (subscription.commitment === "proposed") ids.add(subscription.id);
    }
  }
  return [...ids];
}

function sharedPositiveSubscription(current: readonly IndexedProject[]): string | null {
  const users = new Map<string, string[]>();
  for (const project of current) {
    const cash = project.project.estimate?.additionalCash;
    if (!cash || cash.status !== "known" || cash.money == null || cash.money.minor <= 0) continue;
    for (const subscription of project.project.estimate?.subscriptions ?? []) {
      if (subscription.commitment !== "existing") continue;
      const list = users.get(subscription.id) ?? [];
      list.push(project.project.id);
      users.set(subscription.id, list);
    }
  }
  for (const [id, projects] of users) {
    if (new Set(projects).size > 1) return id;
  }
  return null;
}

function confidenceOf(all: readonly IndexedProject[], current: readonly IndexedProject[]): { level: ConfidenceLevel; note: string } {
  if (all.length === 0) return { level: "high", note: "The portfolio is empty, so there is no forecast to doubt." };
  if (current.length === 0) return { level: "none", note: "No current project snapshot is available." };
  let level: ConfidenceLevel = "high";
  let gap = false;
  for (const project of current) {
    const estimate = project.project.estimate;
    if (!estimate) {
      gap = true;
      level = "none";
      continue;
    }
    if (
      estimate.missing.length > 0 ||
      estimate.agent.status === "incomplete" ||
      estimate.agent.status === "unknown" ||
      estimate.calendar.status === "incomplete" ||
      estimate.calendar.status === "unknown"
    ) {
      gap = true;
    }
    if (CONFIDENCE_RANK[estimate.confidence] < CONFIDENCE_RANK[level]) level = estimate.confidence;
  }
  if (gap) {
    return { level: "none", note: "A current project estimate is missing or incomplete. Portfolio confidence is none, not an average of the others." };
  }
  return { level, note: "Portfolio confidence is the weakest current project confidence. It is not an average." };
}

function contendedResourceIds(projects: readonly IndexedProject[], resources: IndexedPortfolio["resources"]): string[] {
  const users = new Map<string, Set<string>>();
  for (const project of projects) {
    for (const task of project.boardTasks) {
      if (task.archived || task.column === "done") continue;
      const match = matchTaskResource(task, resources);
      if (match.kind !== "one" || !match.resource) continue;
      const limit = match.resource.concurrencyLimit;
      const unbounded = limit.origin !== "unknown" && limit.value === "unbounded" && !match.resource.exclusive;
      if (unbounded) continue;
      const set = users.get(match.resource.id) ?? new Set<string>();
      set.add(project.project.id);
      users.set(match.resource.id, set);
    }
  }
  return [...users.entries()].filter(([, ids]) => ids.size > 1).map(([id]) => id);
}

function sliceOf(project: IndexedProject): PortfolioEstimation["projects"][number] {
  const estimate = project.project.estimate;
  return {
    projectId: project.project.id,
    current: project.freshness === "current",
    scenario: estimate?.scenario ?? null,
    agent: estimate?.agent ?? null,
    calendar: estimate?.calendar ?? null,
    additionalCash: estimate?.additionalCash ?? null,
    apiEquivalent: estimate?.apiEquivalent ?? null,
    subscriptionFees: estimate?.subscriptionFees ?? null,
    confidence: estimate?.confidence ?? null,
    missing: estimate?.missing ?? (estimate ? [] : ["estimate"]),
  };
}

function sameMoney(a: Money | null, b: Money | null): boolean {
  if (a == null || b == null) return a == null && b == null;
  return a.currency === b.currency && a.minor === b.minor;
}

function noMoney(note: string): PortfolioMoney {
  return { status: "known", money: null, knownPortion: null, origin: "known", note };
}
