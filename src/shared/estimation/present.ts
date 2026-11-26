/**
 * Display helpers for the estimation dashboard (FO-006B).
 *
 * Unknown stays the word "Unknown". A policy zero is labeled as policy.
 * Money is formatted from the minor units the user entered, using the
 * currency's own fraction digits. Currencies are never added together here.
 */

import { estimate, estimateWhatIf } from "./estimate.ts";
import type { EstimationRequest, WhatIfPatch } from "./types.ts";
import type { CalendarForecast, CashForecast, DurationForecast, EstimationResult, Money, ScenarioId } from "./types.ts";
import { UNSET_REPORT_CURRENCY } from "./project-adapter.ts";

export interface DisplayFigure {
  headline: string;
  detail: string | null;
  tone: "unknown" | "incomplete" | "policy" | "zero" | "amount" | "warning" | "muted" | "invalid";
}

export const PARALLELISM_CAVEAT =
  "A higher concurrency cap is only a ceiling. Dependencies, unknown durations, and account limits can keep the calendar from getting shorter. A shorter figure in this comparison is a result of the scheduling model, not a guarantee.";

export function formatDurationMs(ms: number): string {
  if (!Number.isSafeInteger(ms) || ms < 0) return "Unknown";
  const totalMinutes = Math.round(ms / 60_000);
  if (ms > 0 && totalMinutes === 0) return "< 1m";
  const days = Math.floor(totalMinutes / (60 * 24));
  const hours = Math.floor((totalMinutes % (60 * 24)) / 60);
  const minutes = totalMinutes % 60;
  const parts: string[] = [];
  if (days) parts.push(`${days}d`);
  if (hours) parts.push(`${hours}h`);
  if (minutes || parts.length === 0) parts.push(`${minutes}m`);
  return parts.join(" ");
}

export function formatDurationForecast(forecast: DurationForecast): DisplayFigure {
  if (forecast.status === "known" && forecast.ms != null) {
    return {
      headline: formatDurationMs(forecast.ms),
      detail: forecast.note,
      tone: forecast.ms === 0 ? "zero" : "amount",
    };
  }
  if (forecast.status === "estimated" && forecast.ms != null) {
    return { headline: formatDurationMs(forecast.ms), detail: forecast.note, tone: "amount" };
  }
  if (forecast.status === "incomplete") {
    const partial = forecast.knownMs != null && forecast.knownMs > 0
      ? `Known portion only: ${formatDurationMs(forecast.knownMs)}. This is not the total.`
      : null;
    return {
      headline: "Incomplete",
      detail: joinDetail(forecast.note, partial),
      tone: "incomplete",
    };
  }
  if (forecast.status === "invalid") return { headline: "Invalid", detail: forecast.note, tone: "invalid" };
  return { headline: "Unknown", detail: forecast.note, tone: "unknown" };
}

export function formatCalendar(forecast: CalendarForecast): DisplayFigure {
  if (forecast.status === "known" && forecast.ms != null) {
    return {
      headline: formatDurationMs(forecast.ms),
      detail: forecast.note,
      tone: forecast.ms === 0 ? "zero" : "amount",
    };
  }
  if (forecast.status === "incomplete") {
    const schedule = forecast.scheduleMs != null
      ? `Schedule length before availability: ${formatDurationMs(forecast.scheduleMs)}. That is not a completion time.`
      : null;
    return { headline: "Incomplete", detail: joinDetail(forecast.note, schedule), tone: "incomplete" };
  }
  if (forecast.status === "invalid") return { headline: "Invalid", detail: forecast.note, tone: "invalid" };
  return { headline: "Unknown", detail: forecast.note, tone: "unknown" };
}

export function formatCash(cash: CashForecast): DisplayFigure {
  if (cash.status === "not-requested") return { headline: "Not requested", detail: cash.note, tone: "muted" };
  if (cash.status === "unknown") return { headline: "Unknown", detail: cash.note, tone: "unknown" };
  if (cash.status === "mixed-currency") return { headline: "Mixed currencies", detail: cash.note, tone: "warning" };
  if (cash.status === "incomplete") {
    const portion = cash.knownPortion ? `Priced portion, not the total: ${formatMoney(cash.knownPortion)}.` : null;
    return { headline: "Incomplete", detail: joinDetail(cash.note, portion), tone: "incomplete" };
  }
  if (cash.basis === "policy") {
    return {
      headline: "0 (policy)",
      detail: cash.note ?? "Extra spend is turned off. This is not a measured zero.",
      tone: "policy",
    };
  }
  if (cash.money && cash.money.minor === 0 && (cash.basis === "none" || cash.basis === "capacity")) {
    return {
      headline: cash.money.currency === UNSET_REPORT_CURRENCY ? "0" : formatMoney(cash.money),
      detail: cash.note,
      tone: "zero",
    };
  }
  if (cash.money) return { headline: formatMoney(cash.money), detail: cash.note, tone: "amount" };
  return { headline: "Unknown", detail: cash.note, tone: "unknown" };
}

export function formatMoney(money: Money): string {
  if (money.currency === UNSET_REPORT_CURRENCY) return `${money.minor} (no report currency)`;
  const digits = currencyFractionDigits(money.currency);
  if (digits == null) return `${money.minor} ${money.currency} minor`;
  const major = money.minor / 10 ** digits;
  try {
    return new Intl.NumberFormat("en", {
      style: "currency",
      currency: money.currency,
      minimumFractionDigits: digits,
      maximumFractionDigits: digits,
    }).format(major);
  } catch {
    return `${money.minor} ${money.currency} minor`;
  }
}

export function currencyFractionDigits(currency: string): number | null {
  if (!/^[A-Z]{3}$/.test(currency) || currency === UNSET_REPORT_CURRENCY) return null;
  try {
    const digits = new Intl.NumberFormat("en", { style: "currency", currency }).resolvedOptions().maximumFractionDigits;
    return typeof digits === "number" && digits >= 0 && digits <= 6 ? digits : null;
  } catch {
    return null;
  }
}

/** Parse a major-unit amount the user typed into minor units. Empty is null, not zero. */
export function majorToMinor(currency: string, major: string): number | null {
  const digits = currencyFractionDigits(currency);
  if (digits == null) return null;
  const trimmed = major.trim();
  if (!trimmed) return null;
  if (!/^\d+(\.\d+)?$/.test(trimmed)) return null;
  const [whole, frac = ""] = trimmed.split(".");
  if (frac.length > digits) return null;
  const minor = Number(whole) * 10 ** digits + Number(frac.padEnd(digits, "0") || "0");
  return Number.isSafeInteger(minor) ? minor : null;
}

export function minorToMajorInput(money: Money): string {
  const digits = currencyFractionDigits(money.currency);
  if (digits == null) return String(money.minor);
  const scale = 10 ** digits;
  const whole = Math.floor(money.minor / scale);
  const frac = String(money.minor % scale).padStart(digits, "0");
  return digits === 0 ? String(whole) : `${whole}.${frac}`;
}

export interface ScenarioComparison {
  scenario: ScenarioId;
  agentBase: string;
  agentNext: string;
  calendarBase: string;
  calendarNext: string;
  cashBase: string;
  cashNext: string;
  cashComparable: boolean;
  cashDelta: string | null;
}

export function compareResults(base: EstimationResult, next: EstimationResult, parallelismChanged: boolean): {
  rows: ScenarioComparison[];
  caveat: string | null;
  nextIssues: string[];
} {
  const rows: ScenarioComparison[] = [];
  const order: ScenarioId[] = ["optimistic", "expected", "conservative"];
  for (const scenario of order) {
    const left = base.scenarios?.[scenario];
    const right = next.scenarios?.[scenario];
    if (!left || !right) continue;
    const cash = cashDelta(left.additionalCash, right.additionalCash);
    rows.push({
      scenario,
      agentBase: formatDurationForecast(left.agent).headline,
      agentNext: formatDurationForecast(right.agent).headline,
      calendarBase: formatCalendar(left.calendar).headline,
      calendarNext: formatCalendar(right.calendar).headline,
      cashBase: formatCash(left.additionalCash).headline,
      cashNext: formatCash(right.additionalCash).headline,
      cashComparable: cash.comparable,
      cashDelta: cash.text,
    });
  }
  return {
    rows,
    caveat: parallelismChanged ? PARALLELISM_CAVEAT : null,
    nextIssues: next.ok ? [] : next.issues.map((issue) => issue.message),
  };
}

export function runWhatIf(request: EstimationRequest, patch: WhatIfPatch): { base: EstimationResult; next: EstimationResult } {
  return { base: estimate(request), next: estimateWhatIf(request, patch) };
}

function cashDelta(base: CashForecast, next: CashForecast): { comparable: boolean; text: string | null } {
  if (base.basis === "policy" || next.basis === "policy") {
    return { comparable: false, text: "Not comparable — a policy zero is not a measured amount." };
  }
  if (base.status !== "known" || next.status !== "known" || !base.money || !next.money) {
    return { comparable: false, text: null };
  }
  if (base.money.currency !== next.money.currency) {
    return { comparable: false, text: "Not comparable — the currencies differ." };
  }
  const delta = next.money.minor - base.money.minor;
  const sign = delta > 0 ? "+" : delta < 0 ? "−" : "";
  return { comparable: true, text: `${sign}${formatMoney({ currency: base.money.currency, minor: Math.abs(delta) })}` };
}

function joinDetail(first: string | null, second: string | null): string | null {
  const parts = [first, second].filter((part): part is string => Boolean(part));
  return parts.length > 0 ? parts.join(" ") : null;
}
