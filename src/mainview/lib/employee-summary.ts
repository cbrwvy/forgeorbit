import { t as tr, formatNumber, intlLocale } from "@/i18n/core";
import { formatDurationMs } from "@/i18n/estimation";
import type { EmployeeWorkSummary } from "../../shared/execution/employee-summary.ts";

/** Pure presentation of the recorded-work summary. Unknown is a word, never a zero. */

export function formatRunTime(ms: number | null): string {
  if (ms == null || !Number.isFinite(ms) || ms < 0) return tr("d2.summary.time_unknown");
  if (ms < 60_000) return `${formatNumber(Math.round(ms / 1000))} ${intlLocale().startsWith("ru") ? "с" : "s"}`;
  return formatDurationMs(ms);
}

export function formatCostAmount(amount: number, currency: string): string {
  try {
    return new Intl.NumberFormat(intlLocale(), { style: "currency", currency }).format(amount);
  } catch {
    return `${amount} ${currency}`;
  }
}

const KIND_KEY = {
  "reported-api": "d2.summary.cost_reported",
  "calculated-api": "d2.summary.cost_calculated",
  subscription: "d2.summary.cost_subscription",
  internal: "d2.summary.cost_internal",
} as const;

export interface CostLineView { key: string; label: string; value: string }

/** One line per evidence category and currency; never summed across either. */
export function costLines(summary: EmployeeWorkSummary): CostLineView[] {
  return summary.cost.lines.map((line) => ({
    key: `${line.kind}|${line.currency ?? ""}`,
    label: tr(KIND_KEY[line.kind]),
    value: line.amount !== null && line.currency
      ? `${formatCostAmount(line.amount, line.currency)} · ${tr("d2.summary.cost_runs", { n: String(line.runs) })}`
      : tr("d2.summary.cost_runs", { n: String(line.runs) }),
  }));
}

/** True when the summary has nothing to show: no attempt reached the runtime. */
export function summaryIsEmpty(summary: EmployeeWorkSummary): boolean {
  return summary.runsStarted === 0 && summary.reviewsPerformed.total === 0;
}
