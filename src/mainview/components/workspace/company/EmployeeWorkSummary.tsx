import { t as tr, formatNumber } from "@/i18n/core";
import { I18nText, useLocale as useUILocale } from "@/i18n/react";
import { useEffect, useState } from "react";
import { api } from "@/lib/api";
import { employeeErrorText } from "@/lib/employees";
import { costLines, formatRunTime, summaryIsEmpty } from "@/lib/employee-summary";
import { Button } from "@/components/ui/button";
import type { EmployeeWorkSummary as Summary } from "../../../../shared/execution/employee-summary.ts";

/**
 * Read-only roll-up of the records for one employee (Direction 2). It starts nothing,
 * grants nothing and polls nothing: it reads when the card opens and when the
 * history is refreshed. Unknown stays a word; a QC PASS and Owner acceptance are
 * separate lines; costs are grouped by category and currency.
 */
export function EmployeeWorkSummary({ employeeId, refreshToken }: { employeeId: string; refreshToken?: unknown }) {
  useUILocale();
  const [summary, setSummary] = useState<Summary | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [reload, setReload] = useState(0);

  useEffect(() => {
    const controller = new AbortController();
    setLoading(true);
    setError(null);
    void api.employeeWorkSummary(employeeId, controller.signal)
      .then((response) => { if (!controller.signal.aborted) setSummary(response.summary); })
      .catch((caught) => { if (!controller.signal.aborted) setError(employeeErrorText(caught)); })
      .finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => controller.abort();
  }, [employeeId, reload, refreshToken]);

  const n = (value: number) => formatNumber(value);
  return (
    <section aria-label={tr("d2.summary.title")} className="flex min-w-0 flex-col gap-2 rounded-xl border p-3" data-testid="employee-work-summary">
      <h3 className="text-sm font-medium"><I18nText id="d2.summary.title" /></h3>
      <p className="text-xs text-muted-foreground"><I18nText id="d2.summary.note" /></p>
      {loading && !summary && <p role="status" className="text-xs text-muted-foreground" data-testid="work-summary-loading"><I18nText id="d2.summary.loading" /></p>}
      {error && <div role="alert" className="text-xs text-destructive" data-testid="work-summary-error">{error}{" "}
        <Button type="button" size="sm" variant="outline" onClick={() => setReload((r) => r + 1)}><I18nText id="d2.summary.retry" /></Button></div>}
      {summary && summaryIsEmpty(summary) && <p className="text-sm text-muted-foreground" data-testid="work-summary-empty"><I18nText id="d2.summary.empty" /></p>}
      {summary && !summaryIsEmpty(summary) && (
        <dl className="grid grid-cols-1 gap-x-4 gap-y-2 sm:grid-cols-2" data-testid="work-summary-body">
          <Row id="runs-started" label={tr("d2.summary.runs_started")} value={n(summary.runsStarted)} />
          <Row id="runs-completed" label={tr("d2.summary.runs_completed")} value={n(summary.outcomes.completed)} />
          <Row id="runs-failed" label={tr("d2.summary.runs_failed")} value={n(summary.outcomes.failed)} />
          <Row id="runs-cancelled" label={tr("d2.summary.runs_cancelled")} value={n(summary.outcomes.cancelled)} />
          <Row id="runs-unknown" label={tr("d2.summary.runs_unknown")} value={n(summary.outcomes.unknown)} />
          <Row id="runs-in-progress" label={tr("d2.summary.runs_in_progress")} value={n(summary.outcomes.inProgress)} />
          <Row id="review-pass" label={tr("d2.summary.review_pass")} value={n(summary.review.passed)} />
          <Row id="review-changes" label={tr("d2.summary.review_changes")} value={n(summary.review.changesRequested)} />
          <Row id="review-blocked" label={tr("d2.summary.review_blocked")} value={n(summary.review.blocked)} />
          <Row id="review-in-progress" label={tr("d2.summary.review_in_progress")} value={n(summary.review.inProgress)} />
          <Row id="review-none" label={tr("d2.summary.review_none")} value={n(summary.review.notReviewed)} />
          <Row id="owner-accepted" label={tr("d2.summary.accepted")} value={n(summary.ownerAccepted)} />
          <Row id="awaiting-owner" label={tr("d2.summary.awaiting_owner")} value={n(summary.awaitingOwner)} />
          <Row id="time" label={tr("d2.summary.time")} value={formatRunTime(summary.time.totalMs)} />
          <div className="min-w-0 sm:col-span-2" data-testid="work-summary-cost">
            <dt className="text-[11px] uppercase tracking-wide text-muted-foreground"><I18nText id="d2.summary.cost" /></dt>
            <dd className="flex flex-col gap-0.5 break-words text-sm">
              {costLines(summary).map((line) => <span key={line.key} data-testid="work-summary-cost-line">{line.label}: {line.value}</span>)}
              {summary.cost.unknownRuns > 0 && <span data-testid="work-summary-cost-unknown">{tr("d2.summary.cost_unknown", { n: n(summary.cost.unknownRuns) })}</span>}
              {summary.cost.fixtureRuns > 0 && <span className="text-muted-foreground" data-testid="work-summary-cost-fixture">{tr("d2.summary.cost_fixture", { n: n(summary.cost.fixtureRuns) })}</span>}
              {summary.cost.lines.length === 0 && summary.cost.unknownRuns === 0 && <span className="text-muted-foreground">{tr("d2.summary.cost_none")}</span>}
            </dd>
          </div>
          <div className="min-w-0 sm:col-span-2" data-testid="work-summary-performed">
            <dt className="text-[11px] uppercase tracking-wide text-muted-foreground"><I18nText id="d2.summary.performed_title" /></dt>
            <dd className="text-sm">
              {summary.reviewsPerformed.total === 0
                ? <span className="text-muted-foreground">{tr("d2.summary.performed_none")}</span>
                : `${tr("d2.summary.review_pass")}: ${n(summary.reviewsPerformed.passed)} · ${tr("d2.summary.review_changes")}: ${n(summary.reviewsPerformed.changesRequested)} · ${tr("d2.summary.review_blocked")}: ${n(summary.reviewsPerformed.blocked)} · ${tr("d2.summary.review_in_progress")}: ${n(summary.reviewsPerformed.inProgress)}`}
            </dd>
          </div>
          <Row id="quality" label={tr("d2.summary.quality")} value={tr("d2.summary.quality_unknown")} wide />
        </dl>
      )}
      {summary && !summaryIsEmpty(summary) && (
        <div className="flex flex-col gap-1 text-xs text-muted-foreground">
          <p><I18nText id="d2.summary.accept_note" /></p>
          {summary.time.runsWithoutTime > 0 && <p data-testid="work-summary-time-missing">{tr("d2.summary.time_missing", { n: n(summary.time.runsWithoutTime) })}</p>}
          {summary.notStarted > 0 && <p>{tr("d2.summary.not_started", { n: n(summary.notStarted) })}</p>}
          {summary.truncated && <p data-testid="work-summary-truncated">{tr("d2.summary.truncated", { n: n(summary.attemptsRead) })}</p>}
        </div>
      )}
    </section>
  );
}

function Row({ id, label, value, wide }: { id: string; label: string; value: string; wide?: boolean }) {
  return (
    <div className={wide ? "min-w-0 sm:col-span-2" : "min-w-0"} data-testid={`work-summary-${id}`}>
      <dt className="text-[11px] uppercase tracking-wide text-muted-foreground">{label}</dt>
      <dd className="break-words text-sm" data-testid={`work-summary-${id}-value`}>{value}</dd>
    </div>
  );
}
