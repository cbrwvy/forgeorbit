import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { TechnicalDisclosure } from "@/components/ui/technical-details";
import { useLocale } from "@/i18n/react";
import { t, type TranslationKey } from "@/i18n/core";
import { api } from "@/lib/api";
import {
  BASELINE_ABSENCE_KEYS, COMPARISON_REASON_KEYS, type ComparisonRange, type ComparisonRow, type CostRow, type DeltaReason,
  type ForecastComparison, type MoneyEntry,
} from "../../../shared/forecast-comparison.ts";
import { date, duration, money, notesClass, number, unknown } from "./presentation";

const key = (value: string) => value as TranslationKey;

function signedDuration(value: number): string {
  return `${value > 0 ? "+" : value < 0 ? "−" : ""}${duration(Math.abs(value))}`;
}

function plannedDuration(range: ComparisonRange | null): string {
  if (!range) return unknown();
  return `${duration(range.expected)} (${duration(range.optimistic)} – ${duration(range.conservative)})`;
}

const moneyEntries = (items: MoneyEntry[]) => items.length
  ? items.map(item => `${t(key(`usage.${item.kind}`))} · ${money(item)}`).join("; ")
  : t("comparison.costNone");

function CostCells({ row }: { row: CostRow }) {
  const planned = row.planned;
  return <>
    <td className="px-2 py-1.5 align-top" data-testid="comparison-cost-planned">
      {planned ? <>
        {moneyEntries(planned.totals)}
        <small className="block text-muted-foreground">{t("comparison.plannedStages", { subscription: planned.subscriptionStages, unknown: planned.unknownStages })}</small>
      </> : unknown()}
    </td>
    <td className="px-2 py-1.5 align-top" data-testid="comparison-cost-actual">
      {moneyEntries(row.actual.totals)}
      <small className="block text-muted-foreground">{t("comparison.actualCost", {
        subscription: row.actual.subscriptionRuns, unknown: row.actual.unknownCostRuns,
      })}</small>
      {row.actual.reportedTelemetry.length > 0 && <small className="block text-muted-foreground">
        {t("usage.reportedTelemetry")} · {row.actual.reportedTelemetry.map(item => money(item)).join("; ")}
      </small>}
    </td>
  </>;
}

function Delta({ row }: { row: ComparisonRow }) {
  if (row.kind === "actual-only") return <td className="px-2 py-1.5" colSpan={1}><Reason reason={row.reason} /></td>;
  const delta = row.delta;
  return <td className="px-2 py-1.5 align-top" data-testid={`comparison-delta-${row.key}`}>
    {delta === null ? <Reason reason={row.reason} /> : typeof delta === "number"
      ? (row.kind === "count" ? `${delta > 0 ? "+" : delta < 0 ? "−" : ""}${number(Math.abs(delta))}` : signedDuration(delta))
      : `${delta.amount > 0 ? "+" : delta.amount < 0 ? "−" : ""}${money({ amount: Math.abs(delta.amount), currency: delta.currency })}`}
  </td>;
}

function Reason({ reason }: { reason: DeltaReason | null }) {
  if (!reason) return null;
  return <span className="text-muted-foreground" data-reason={reason}>{t(key(COMPARISON_REASON_KEYS[reason]))}</span>;
}

function Row({ row }: { row: ComparisonRow }) {
  const label = <th scope="row" className="px-2 py-1.5 text-left font-medium align-top">{t(key(`comparison.row.${row.key}`))}</th>;
  if (row.kind === "cost") {
    return <tr className="border-t" data-testid="comparison-row-cost">{label}<CostCells row={row} /><Delta row={row} /></tr>;
  }
  if (row.kind === "actual-only") {
    return <tr className="border-t" data-testid={`comparison-row-${row.key}`}>
      {label}
      <td className="px-2 py-1.5 text-muted-foreground">—</td>
      <td className="px-2 py-1.5 tabular-nums">{duration(row.actual)}</td>
      <Delta row={row} />
    </tr>;
  }
  const actual = row.kind === "count" ? number(row.actual) : duration(row.actual);
  const planned = row.kind === "count"
    ? row.planned ? `${number(row.planned.expected)} (${number(row.planned.optimistic)} – ${number(row.planned.conservative)})` : unknown()
    : plannedDuration(row.planned);
  return <tr className="border-t" data-testid={`comparison-row-${row.key}`}>
    {label}
    <td className="px-2 py-1.5 tabular-nums align-top" data-testid={`comparison-planned-${row.key}`}>{planned}</td>
    <td className="px-2 py-1.5 tabular-nums align-top" data-testid={`comparison-actual-${row.key}`}>
      {actual}
      {row.kind === "duration" && row.coverage && row.coverage.missing > 0 && <small className="block text-muted-foreground">
        {t("comparison.coverage", { known: row.coverage.known, total: row.coverage.known + row.coverage.missing })}
      </small>}
    </td>
    <Delta row={row} />
  </tr>;
}

/** Read-only planned-versus-actual table for one task. Nothing here acts on the task. */
export function ComparisonView({ comparison, compact }: { comparison: ForecastComparison; compact?: boolean }) {
  useLocale();
  const b = comparison.baseline;
  const rows = compact
    ? comparison.rows.filter(row => ["developer", "reviewer", "worker", "elapsed", "runs", "cost"].includes(row.key))
    : comparison.rows;
  const stateKey = comparison.state === "complete" ? "comparison.state.complete"
    : comparison.state === "interim" ? "comparison.state.interim" : "comparison.state.none";
  return <section className="space-y-2" data-testid="forecast-comparison" data-state={comparison.state}
    data-baseline-id={b?.estimateId ?? ""}>
    <header className="flex flex-wrap items-center gap-2">
      <h3 className="text-sm font-semibold">{t("comparison.title")}</h3>
      <span className="rounded-full border px-2 py-0.5 text-xs text-muted-foreground" data-testid="comparison-state">{t(key(stateKey))}</span>
    </header>
    {b ? <p className={notesClass} data-testid="comparison-baseline">
      {b.boundAt !== null
        ? t("comparison.baselineLine", { id: b.estimateId, saved: date(b.savedAt), bound: date(b.boundAt) })
        : t("comparison.baselineUnboundRun", { id: b.estimateId, saved: date(b.savedAt) })}
    </p> : comparison.absence && <p className={notesClass} data-testid="comparison-absence" data-absence={comparison.absence}>
      {t(key(BASELINE_ABSENCE_KEYS[comparison.absence]))}
    </p>}
    {b && b.laterRevisions.length > 0 && <p className={notesClass} data-testid="comparison-later">
      {t("comparison.laterRevisions", { count: b.laterRevisions.length })}
    </p>}
    <div className="overflow-x-auto rounded-md border">
      <table className="w-full min-w-[34rem] text-xs" data-testid="comparison-table">
        <thead className="bg-muted/60 text-muted-foreground"><tr>
          <th scope="col" className="px-2 py-1.5 text-left font-medium">{t("comparison.col.measure")}</th>
          <th scope="col" className="px-2 py-1.5 text-left font-medium">{t("comparison.col.planned")}</th>
          <th scope="col" className="px-2 py-1.5 text-left font-medium">{t("comparison.col.actual")}</th>
          <th scope="col" className="px-2 py-1.5 text-left font-medium">{t("comparison.col.delta")}</th>
        </tr></thead>
        <tbody>{rows.map(row => <Row key={row.key} row={row} />)}</tbody>
      </table>
    </div>
    {!comparison.genuineOnly && comparison.runCounts.total > 0 && <p className={notesClass} data-testid="comparison-not-genuine">{t("comparison.notGenuine")}</p>}
    {comparison.quotaStatement && <p className={notesClass} data-testid="comparison-quota">{t("comparison.quota")} · {comparison.quotaStatement}</p>}
    <TechnicalDisclosure summary={t("comparison.details")} testId="comparison-details">
      <div className="space-y-2">
        <p className={notesClass}>{t("comparison.runs", comparison.runCounts)}</p>
        {b && <dl className="grid gap-1 text-xs sm:grid-cols-2">
          <div><dt className="text-muted-foreground">{t("comparison.method")}</dt><dd>{b.method ?? unknown()}</dd></div>
          <div><dt className="text-muted-foreground">{t("comparison.confidence")}</dt><dd>{b.confidence ?? unknown()}</dd></div>
          <div className="sm:col-span-2"><dt className="text-muted-foreground">{t("comparison.plannedResource")}</dt>
            <dd>{b.plannedResource ? [b.plannedResource.harnessId, b.plannedResource.modelId, b.plannedResource.accountId, b.plannedResource.mode]
              .map(part => part ?? unknown()).join(" / ") : unknown()}</dd></div>
        </dl>}
        <h4 className="text-xs font-semibold">{t("comparison.attempts")}</h4>
        <ul className="space-y-1 text-xs" data-testid="comparison-attempts">
          {comparison.attempts.map(attempt => <li key={attempt.runId} data-run-id={attempt.runId} data-role={attempt.role}
            className="rounded border px-2 py-1">
            <span className="font-medium">{t("comparison.attempt", { role: t(key(`usage.${attempt.role}`)), n: attempt.attempt })}</span>
            {" · "}{attempt.status}{attempt.interrupted && ` · ${t("comparison.interrupted")}`}
            {attempt.boundToBaseline && ` · ${t("comparison.baselineRun")}`}
            {" · "}{duration(attempt.durationMs)}
            {attempt.stop && ` · ${t(key(`comparison.stop.${attempt.stop.reason}`))} · ${t(attempt.stop.outcome === "exited" ? "comparison.stop.exited" : "comparison.stop.notConfirmed")}`}
            {" · "}{attempt.workerName ? t("comparison.worker", { name: attempt.workerName }) : t("comparison.workerUnknown")}
            {" · "}{[attempt.harnessId, attempt.model, attempt.mode].map(part => part ?? unknown()).join(" / ")}
            {" · "}{attempt.accountLabel ?? attempt.accountId ?? unknown()}
            {" · "}{attempt.projectPath ? attempt.projectPath.split("/").filter(Boolean).at(-1) : unknown()}
            {attempt.execution === "synthetic" && ` · ${t("usage.synthetic")}`}
            <small className="block text-muted-foreground">{attempt.runId} · {date(attempt.startedAt)}</small>
          </li>)}
        </ul>
      </div>
    </TechnicalDisclosure>
    {!compact && <p className={notesClass}>{t("comparison.readOnly")}</p>}
  </section>;
}

/** Loads one task's comparison. Used by the task panel and by Analytics. */
export function ForecastActualComparison({ taskId, compact, refreshKey, onOpenAnalytics }: {
  taskId: string; compact?: boolean; refreshKey?: string | number; onOpenAnalytics?: () => void;
}) {
  useLocale();
  const [data, setData] = useState<ForecastComparison | null>(null);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    let current = true;
    setData(null);
    setFailed(false);
    api.usageTask(taskId).then(
      detail => { if (current) setData(detail.comparison); },
      () => { if (current) setFailed(true); },
    );
    return () => { current = false; };
  }, [taskId, refreshKey]);
  if (failed) return <p role="alert" className="text-xs text-destructive">{t("comparison.loadFailed")}</p>;
  if (!data) return <p role="status" className={notesClass}>{t("comparison.loading")}</p>;
  return <div className="space-y-2">
    <ComparisonView comparison={data} compact={compact} />
    {compact && <div className="flex items-center gap-2">
      {onOpenAnalytics && <Button size="sm" variant="outline" data-testid="comparison-open-analytics" onClick={onOpenAnalytics}>{t("comparison.open")}</Button>}
      <span className={notesClass}>{t("comparison.readOnly")}</span>
    </div>}
  </div>;
}
