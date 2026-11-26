import { useEffect, useId, useRef, useState } from "react";
import { Dialog } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { useLocale } from "@/i18n/react";
import { t } from "@/i18n/core";
import { api } from "@/lib/api";
import type { TaskForecast } from "../../../bun/usage-analytics/forecast.ts";
import { costText, DataTable, date, duration, Metrics, money, notesClass, number, unknown } from "./presentation";
import { EstimateView } from "./UsageForecast";
import { ComparisonView } from "./ForecastActualComparison";

type Detail = Awaited<ReturnType<typeof api.usageTask>>;
function Actuals({ detail, runId }: { detail: Detail; runId?: string }) {
  const { actual: a, actualUsage: u } = detail;
  const section = useRef<HTMLElement>(null);
  // Opened from a record: the run table sits below the summary tiles, so bring the highlighted run into view.
  useEffect(() => {
    if (!runId) return;
    section.current?.querySelector('[data-testid="usage-task-run"][data-highlight="true"]')?.scrollIntoView({ block: "center", inline: "nearest" });
  }, [detail, runId]);
  return <section ref={section} className="space-y-3" data-testid="usage-task-actual">
    <h3 className="font-semibold">{t("usage.actuals")}</h3>
    <Metrics items={[
      [t("usage.created"), date(a.createdAt)], [t("usage.firstRun"), date(a.firstRunAt)], [t("usage.done"), date(a.doneAt)],
      [t("usage.totalElapsed"), duration(a.lifecycle.createdToDoneMs)], [t("usage.elapsed"), duration(a.lifecycle.firstExecutionToDoneMs)],
      [t("usage.partialElapsed"), duration(a.lifecycle.partialCreatedMs ?? a.lifecycle.partialExecutionMs)],
      [t("usage.queue"), duration(a.queueMs)], [t("usage.active"), duration(a.activeWallMs)],
      [t("usage.worker"), duration(a.workerMs)], [t("usage.developerTime"), duration(a.lifecycle.developerMs)], [t("usage.reviewerTime"), duration(a.lifecycle.reviewerMs)],
      [t("usage.testing"), duration(a.testMs)], [t("usage.qc"), duration(a.qcMs)],
      [t("usage.rework"), `${number(a.reworks)} · ${duration(a.reworkMs)}`], [t("usage.realRuns"), number(u.realRuns)], [t("usage.human"), unknown()],
      [t("usage.attempts"), number(a.lifecycle.attempts)], [t("usage.completedRuns"), number(a.lifecycle.completedRuns)],
      [t("usage.qcRounds"), number(a.lifecycle.qcRounds)],
      [t("usage.failures"), number(a.failed)], [t("usage.interruptions"), number(a.interrupted)],
      [t("usage.unclassified"), duration(a.lifecycle.unclassifiedMs)],
      [t("usage.subscriptionQuota"), a.subscriptionQuota.statement ?? a.subscriptionQuota.receipts.map(item => `${item.amount} ${item.unit}`).join(", ")],
    ]} />
    {a.finishedUnrecorded && <p className={notesClass} data-testid="usage-done-unrecorded">{t("usage.doneUnrecorded")}</p>}
    {([["developer", a.lifecycle.developerCoverage], ["reviewer", a.lifecycle.reviewerCoverage]] as const).filter(([, c]) => c.missing > 0).map(([role, c]) =>
      <p key={role} className={notesClass} data-testid={`usage-coverage-${role}`}>{t("usage.coveragePartial", { role: t(`usage.${role}`), known: c.known, total: c.known + c.missing })}</p>)}
    <Metrics items={[
      [t("usage.waitMeasured"), duration(a.waiting.measuredMs)],
      [t("usage.waitCoverage"), duration(a.waiting.coverageMs)],
      [t("usage.waitUnknown"), duration(a.waiting.unknownMs)],
      [t("usage.waitRuntime"), duration(a.waiting.runtimeInternalUnknownMs)],
      [t("usage.waitProvider"), duration(a.waiting.providerReportedMs)],
      ...Object.entries(a.waiting.measured).map(([kind, ms]) =>
        [t(`usage.wait.${kind as keyof typeof a.waiting.measured}`), duration(ms)] as [string, string]),
    ]} />
    <DataTable headings={[t("trace.col.run"), t("trace.col.project"), t("usage.specialist"), t("usage.model"), t("usage.account"), t("usage.firstRun"), t("usage.done"), t("usage.worker"), t("usage.input"), t("usage.output"), t("usage.cacheRead"), t("usage.cacheWrite"), t("usage.cost")]}
      rows={a.runs.map(r => ({ id: r.id, cells: [
        <span data-testid="usage-task-run" data-run-id={r.id} data-highlight={r.id === runId ? "true" : "false"}
          className={r.id === runId ? "rounded bg-primary/10 px-1 font-mono" : "font-mono"} title={r.id}>{r.id.slice(0, 8)}</span>,
        <span data-testid="usage-task-run-project">{r.scope?.projectPath ?? unknown()}</span>,
        <span>{t(`usage.${r.role}`)}<small className="block text-muted-foreground">{r.workerName ?? r.specialist ?? ""}</small></span>,
        <span>{r.provider ?? unknown()} · {r.model ?? unknown()}<small className="block text-muted-foreground">{r.mode ?? unknown()} · {r.status}{r.execution === "synthetic" ? ` · ${t("usage.synthetic")}` : ""}</small></span>,
        r.accountId ?? unknown(), date(r.start), date(r.end), duration(r.durationMs), number(r.rawTokens.input), number(r.tokens.output), number(r.tokens.cacheRead), number(r.tokens.cacheWrite),
        <span>{costText(r.cost)}{r.reportedTelemetry && <small className="block text-muted-foreground">{t("usage.reportedTelemetry")} · {money(r.reportedTelemetry)}</small>}</span>,
      ] }))} />
    {a.reviews.length > 0 && <DataTable headings={[t("usage.qc"), t("usage.done")]} rows={a.reviews.map(q => ({
      id: q.id, cells: [`#${q.round} · ${q.verdict ?? unknown()}`, date(q.completed_at)],
    }))} />}
    {a.tests.length > 0 && <DataTable headings={[t("usage.testing"), t("usage.done")]} rows={a.tests.map(q => ({
      id: q.id, cells: [q.status, date(q.finished_at)],
    }))} />}
    <ComparisonView comparison={detail.comparison} />
    <h3 className="font-semibold">{t("usage.comparison")}</h3>
    <Metrics items={[
      [t("usage.preparationMeasured"), detail.preparation?.durationMs != null ? duration(detail.preparation.durationMs) : unknown()],
      [t("usage.preparationWaiting"), detail.preparation?.waitingMs != null ? duration(detail.preparation.waitingMs) : unknown()],
      [t("usage.originalEstimate"), detail.original ? `#${detail.original.estimateId}` : unknown()],
      [t("usage.frozen"), detail.estimate ? `#${detail.estimate.estimateId}` : unknown()],
    ]} />
    <p className={notesClass}>{t("usage.comparisonNote")}</p>
    {a.subscriptionQuota.status === "unknown" && <p className={notesClass} data-testid="usage-task-quota">{t("usage.perTaskQuotaUnknown")}</p>}
    {detail.adjustments.current.length > 0 && <DataTable headings={[t("usage.ownerAdjustments"), t("usage.cost"), t("usage.note")]}
      rows={detail.adjustments.history.map(row => ({ id: String(row.id), cells: [row.current ? t("usage.owner-reported") : t("usage.staleEstimate"), money(row), row.note] }))} />}
    {detail.forecastComparison && <p className={notesClass}>{detail.forecastComparison.delayEvidence.note}</p>}
    {detail.preparation?.durationMs == null && <p className={notesClass}>{t("usage.preparationUnknown")}</p>}
    {detail.resourceRevisions.map(revision => <p key={`${revision.missionId}:${revision.revision}:${revision.role}`} className={notesClass}>
      {t("usage.replanTitle")} #{revision.revision} · {date(revision.at)} · {revision.reason}
      {revision.previous && <> · {t("usage.replanPrevious")} {revision.previous.harnessId} / {revision.previous.modelId} / {revision.previous.accountId ?? unknown()} / {revision.previous.mode ?? unknown()}</>}
      {" · "}{revision.resource.harnessId} / {revision.resource.modelId} / {revision.resource.accountId} / {revision.resource.mode}
      {" · "}{t("usage.remainingEstimate")} {duration(revision.expectedBefore)} → {duration(revision.expectedAfter)}
      {revision.authorization && ` · ${t("usage.amendmentProvenance")} ${revision.authorization.policyDigest.slice(0, 12)}`}
      {revision.elapsedAfterApproval !== null && ` · ${t("usage.elapsedAfterApproval")} ${duration(revision.elapsedAfterApproval)}`}
      {revision.allocation && !revision.allocation.optimal && ` · ${t("usage.allocationUnproven")}`}
    </p>)}
    {detail.remaining && <p className={notesClass}>{t("usage.remainingEstimate")} · {duration(detail.remaining.duration.optimistic)}
      {" / "}{duration(detail.remaining.duration.expected)}{" / "}{duration(detail.remaining.duration.conservative)}</p>}
    {detail.original && detail.original.estimateId !== detail.estimate?.estimateId && <details>
      <summary className="cursor-pointer text-sm font-medium">{t("usage.originalEstimate")}</summary>
      <div className="mt-2"><EstimateView estimate={detail.original} /></div>
    </details>}
    {(detail.deviation.interrupted > 0 || detail.deviation.failed > 0 || detail.deviation.reworks > 0 || detail.deviation.differentResources) &&
      <p className={notesClass}>{t("usage.deviation")} · {t("usage.failures")} {detail.deviation.failed}
        {" · "}{t("usage.interruptions")} {detail.deviation.interrupted} · {t("usage.rework")} {detail.deviation.reworks}
        {detail.deviation.differentResources && ` · ${t("usage.resourceDrift")}`}</p>}
    {detail.estimate && <details><summary className="cursor-pointer text-sm font-medium">{t("usage.frozen")}</summary>
      <div className="mt-2"><EstimateView estimate={detail.estimate} /></div>
    </details>}
  </section>;
}

export function UsageTaskDialog({ taskId, backlog, runId, onClose, onOpenTask }: {
  taskId: string; backlog?: boolean; runId?: string; onClose: () => void; onOpenTask?: (id: string) => void;
}) {
  useLocale();
  const titleId = useId();
  const descriptionId = useId();
  const [refresh, setRefresh] = useState(0);
  const [data, setData] = useState<Detail | null>(null);
  const [estimate, setEstimate] = useState<TaskForecast | null>(null);
  const [scope, setScope] = useState("");
  const [savedScope, setSavedScope] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(true);
  useEffect(() => {
    let current = true;
    async function load() {
      setError("");
      setBusy(true);
      try {
        const result = backlog ? await api.usageForecast({ taskIds: [taskId], save: true }) : null;
        if (!current) return;
        setEstimate(result?.estimates[0] ?? null);
        const detail = await api.usageTask(taskId);
        if (!current) return;
        setData(detail);
        if (backlog) {
          const task = await api.getTask(taskId);
          if (!current) return;
          setScope(task.prompt);
          setSavedScope(task.prompt);
        }
      } catch (cause) {
        if (current) setError(cause instanceof Error ? cause.message : String(cause));
      } finally {
        if (current) setBusy(false);
      }
    }
    void load();
    return () => { current = false; };
  }, [taskId, backlog, refresh]);
  async function regenerate() {
    const next = scope.trim();
    if (!next) return;
    setBusy(true);
    setError("");
    try {
      if (next !== savedScope) await api.updateTask(taskId, { prompt: next });
      setRefresh(n => n + 1);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
      setBusy(false);
    }
  }
  return <Dialog open onClose={onClose} labelledBy={titleId} describedBy={descriptionId} className="w-[95vw] max-w-5xl">
    <div className="flex max-h-[82vh] flex-col gap-3" data-testid="usage-task-dialog">
      <header>
        <h2 id={titleId} className="text-lg font-semibold">{backlog ? t("usage.estimate") : t("usage.actuals")}{data && ` · ${data.actual.title}`}</h2>
        <p id={descriptionId} className={notesClass}>{backlog ? t("usage.assumptions") : t("usage.periodNote")}</p>
      </header>
      <div className="min-h-0 space-y-4 overflow-auto pr-2">
        {busy && <p role="status">{t("usage.loading")}</p>}
        {error && <p role="alert" className="text-destructive">{error}</p>}
        {backlog && savedScope && <label className="block space-y-1 text-xs text-muted-foreground">{t("usage.scope")}
          <textarea aria-label={t("usage.scope")} data-testid="usage-task-scope" value={scope} rows={5}
            onChange={e => setScope(e.target.value)}
            className="w-full rounded-md border bg-background px-2 py-1.5 text-sm text-foreground" />
          <span className={notesClass}>{t("usage.scopeNote")}</span>
        </label>}
        {!busy && backlog && !estimate && <p className={notesClass}>{t("usage.empty")}</p>}
        {estimate && <p className={notesClass} data-testid="router-task-boundary">{t("routing_v2.recommendation_boundary")}</p>}
        {estimate && <EstimateView estimate={estimate} selection={{ taskIds: [taskId] }} onApplied={() => setRefresh(n => n + 1)} />}
        {data && !backlog && <Actuals detail={data} runId={runId} />}
        {data && data.revisions.length > 0 && <details>
          <summary className="cursor-pointer text-sm font-medium">{t("usage.revisions")}</summary>
          <div className="mt-2 space-y-2">{data.revisions.map(r => <details key={r.id} className="rounded-md border p-2">
            <summary className="cursor-pointer text-xs">#{r.id} · {date(r.at)}{r.stale && ` · ${t("usage.staleEstimate")}`}</summary>
            <div className="mt-2"><EstimateView estimate={r.estimate} /></div>
          </details>)}</div>
        </details>}
      </div>
      <div className="flex gap-2">
        <Button variant="ghost" onClick={onClose}>{t("common.close")}</Button>
        <Button variant="outline" disabled={busy} onClick={() => setRefresh(n => n + 1)}>{t("usage.refresh")}</Button>
        {backlog && <Button variant="outline" data-testid="usage-regenerate" disabled={busy || !scope.trim()} onClick={() => void regenerate()}>{t("usage.regenerate")}</Button>}
        {onOpenTask && <Button onClick={() => { onClose(); onOpenTask(taskId); }}>{t("usage.openTask")}</Button>}
      </div>
    </div>
  </Dialog>;
}
