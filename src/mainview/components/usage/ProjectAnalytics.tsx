import { useEffect, useMemo, useState } from "react";
import { Button } from "@/components/ui/button";
import { useLocale } from "@/i18n/react";
import { t, type TranslationKey } from "@/i18n/core";
import { api } from "@/lib/api";
import { columnLabel } from "@/lib/status-presenters";
import {
  forecastSelectionForProject,
  lockProjectFilter,
  remainingTaskIds,
  tasksInProject,
  type AnalyticsTaskRef,
} from "@/lib/project-analytics";
import type { AnalyticsFilter } from "../../../shared/usage-analytics.ts";
import { duration, money, notesClass, number, unknown } from "./presentation";
import { UsageAnalyticsPage } from "./UsageAnalyticsPage";
import { UsageTaskDialog } from "./UsageTaskDialog";

type Result = Awaited<ReturnType<typeof api.usageAnalytics>>;
type Forecast = Awaited<ReturnType<typeof api.usageForecast>>;

const costTotal = (value: Result["usage"]) => value.costTotals.length
  ? value.costTotals.map((row) => `${t(`usage.${row.kind}` as TranslationKey)} ${money(row)}`).join(" · ")
  : unknown();

/**
 * Analytics for the project that is already open. Recorded usage and the
 * remaining-work estimate come first. Filters and exports stay behind a
 * disclosure and keep the same project on every request.
 */
export function ProjectAnalytics({
  projectPath,
  projectLabel,
  tasks,
  onOpenTask,
}: {
  projectPath: string;
  projectLabel: string;
  tasks: readonly AnalyticsTaskRef[];
  onOpenTask: (id: string) => void;
}) {
  useLocale();
  const remaining = useMemo(() => remainingTaskIds(tasks), [tasks]);
  const [selected, setSelected] = useState<string[] | null>(null);
  const taskIds = selected ?? remaining;
  const taskKey = taskIds.join("\0");
  const [usage, setUsage] = useState<Result | null>(null);
  const [forecast, setForecast] = useState<Forecast | null>(null);
  const [forecastPartial, setForecastPartial] = useState(false);
  const [usageError, setUsageError] = useState("");
  const [forecastError, setForecastError] = useState("");
  const [busy, setBusy] = useState(true);
  const [drill, setDrill] = useState<string | null>(null);

  useEffect(() => {
    let current = true;
    setBusy(true);
    setUsageError("");
    setForecastError("");
    const usageQuery = lockProjectFilter(projectPath);
    const forecastQuery = forecastSelectionForProject(projectPath, taskIds);
    setForecastPartial(forecastQuery?.partial ?? false);
    const usageRequest = api.usageAnalytics(usageQuery).then(
      (data) => { if (current) setUsage(data); },
      (cause: unknown) => { if (current) { setUsage(null); setUsageError(cause instanceof Error ? cause.message : String(cause)); } },
    );
    const forecastRequest = forecastQuery
      ? api.usageForecast(forecastQuery.selection).then(
        (data) => { if (current) setForecast(data); },
        (cause: unknown) => { if (current) { setForecast(null); setForecastError(cause instanceof Error ? cause.message : String(cause)); } },
      )
      : Promise.resolve().then(() => { if (current) setForecast(null); });
    void Promise.all([usageRequest, forecastRequest]).finally(() => { if (current) setBusy(false); });
    return () => { current = false; };
  }, [projectPath, taskKey]);

  const scopedTasks = usage ? tasksInProject(usage.tasks, projectPath) : { rows: [], foreign: 0 };
  const recorded = usage ? hasActivity(usage) : false;
  const limited = (forecast?.estimates ?? []).some((estimate) => estimate.confidence === "low");
  const forecastTasks = (forecast?.estimates ?? []).filter((estimate) => !estimate.projectPath || estimate.projectPath === projectPath);
  const forecastForeign = (forecast?.estimates.length ?? 0) - forecastTasks.length;

  return (
    <div className="min-h-0 flex-1 overflow-auto pb-[calc(1rem+var(--shell-dock-clearance))]" data-testid="project-analytics">
      <div className="mx-auto flex max-w-[88rem] flex-col gap-4 p-4 sm:p-6">
        <p className="text-sm text-muted-foreground" data-testid="project-analytics-scope">{t("analytics.project.scope", { project: projectLabel })}</p>
        {busy && <p role="status">{t("usage.loading")}</p>}
        {usageError && <p role="alert" className="text-sm text-destructive">{usageError}</p>}

        <section className="space-y-2 rounded-xl border bg-card p-4" data-testid="project-analytics-recorded">
          <h2 className="text-base font-semibold">{t("analytics.project.recorded")}</h2>
          <p className={notesClass}>{t("analytics.project.recorded_hint")}</p>
          {usage && !recorded && <p data-testid="project-analytics-nothing-recorded">{t("analytics.project.nothing_recorded")}</p>}
          {usage && recorded && (
            <dl className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
              <Fact label={t("usage.worker")} value={duration(usage.company.time.workerMs)} />
              <Fact label={t("usage.cost")} value={costTotal(usage.usage)} />
              <Fact label={t("usage.realRuns")} value={number(usage.usage.realRuns)} />
              <Fact label={t("usage.unknownCost")} value={number(usage.usage.unknownCostRuns)} />
              <Fact label={t("usage.subscription")} value={number(usage.usage.subscriptionRuns)} />
              <Fact label={t("usage.completed")} value={number(usage.company.counts.completed)} />
            </dl>
          )}
        </section>

        <section className="space-y-2 rounded-xl border bg-card p-4" data-testid="project-analytics-forecast">
          <h2 className="text-base font-semibold">{selected ? t("analytics.project.forecast_selected") : t("analytics.project.forecast")}</h2>
          <p className={notesClass}>{t("analytics.project.forecast_hint")}</p>
          <p className="text-sm" data-testid="project-analytics-remaining-count">{t("analytics.project.remaining_count", { count: String(remaining.length) })}</p>
          {!taskIds.length && <p data-testid="project-analytics-no-estimate">{selected ? t("analytics.project.none_selected") : t("analytics.project.no_remaining")}</p>}
          {forecastError && <p role="alert" className="text-sm text-destructive">{forecastError}</p>}
          {(forecastPartial || (forecast?.blockers.length ?? 0) > 0 || forecast?.omitted) && (
            <p className="text-sm text-warning" data-testid="project-analytics-partial">{t("analytics.project.partial")}</p>
          )}
          {limited && <p className="text-sm text-muted-foreground" data-testid="project-analytics-limited">{t("analytics.project.limited")}</p>}
          {forecast && taskIds.length > 0 && (
            <dl className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
              <Fact label={t("usage.worker")} value={estimateDuration(forecast.worker?.expected, forecastPartial || (forecast.blockers.length ?? 0) > 0 || !!forecast.omitted)} />
              <Fact label={t("usage.cost")} value={forecast.cost.totals.length
                ? forecast.cost.totals.map((row) => `${t(`usage.${row.kind}` as TranslationKey)} ${money(row)}`).join(" · ")
                : unknown()} />
              <Fact label={t("usage.unknownCost")} value={number(forecast.cost.unknown)} />
              <Fact label={t("usage.subscription")} value={number(forecast.cost.subscription)} />
            </dl>
          )}
          {forecastForeign > 0 && <p className="text-sm text-warning">{t("analytics.project.foreign")}</p>}
          <details className="rounded-md border p-3">
            <summary className="cursor-pointer text-sm font-medium">{t("analytics.project.choose")}</summary>
            <div className="mt-2 flex max-h-48 flex-col gap-1 overflow-y-auto">
              {tasks.filter((task) => task.pipelineParentId == null).map((task) => (
                <label key={task.id} className="flex min-w-0 items-center gap-2 text-sm">
                  <input
                    type="checkbox"
                    checked={taskIds.includes(task.id)}
                    onChange={(event) => {
                      const next = new Set(taskIds);
                      if (event.target.checked) next.add(task.id);
                      else next.delete(task.id);
                      setSelected([...next]);
                    }}
                  />
                  <span className="min-w-0 flex-1 truncate">{task.title || task.id}</span>
                  <span className="shrink-0 text-xs text-muted-foreground">{columnLabel(task.column)}</span>
                </label>
              ))}
              {selected && (
                <Button type="button" size="sm" variant="outline" className="mt-2 self-start" onClick={() => setSelected(null)}>
                  {t("analytics.project.forecast")}
                </Button>
              )}
            </div>
          </details>
        </section>

        <section className="space-y-2 rounded-xl border bg-card p-4" data-testid="project-analytics-quota">
          <h2 className="text-base font-semibold">{t("analytics.project.quota")}</h2>
          <p className={notesClass}>{t("analytics.project.quota_hint")}</p>
          {usage && <p className={notesClass}>{usage.company.quota.note}</p>}
          {usage && usage.company.quota.pools.length === 0 && <p data-testid="project-analytics-no-quota">{t("analytics.project.no_quota")}</p>}
          {usage && usage.company.quota.pools.length > 0 && (
            <div className="overflow-x-auto">
              <table className="w-full min-w-[36rem] text-left text-xs">
                <thead className="text-muted-foreground">
                  <tr>
                    {[t("usage.account"), t("analytics.project.pool"), t("analytics.project.attributed"), t("analytics.project.unattributed"), t("usage.coverage")].map((heading) => (
                      <th key={heading} scope="col" className="px-2 py-2 font-medium">{heading}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {usage.company.quota.pools.map((pool) => (
                    <tr key={pool.quotaId} className="border-t align-top" data-testid="project-analytics-quota-row">
                      <th scope="row" className="px-2 py-2 font-medium">{pool.accountLabel}</th>
                      <td className="px-2 py-2">{number(pool.poolDelta)}</td>
                      <td className="px-2 py-2">{number(pool.attributed)}</td>
                      <td className="px-2 py-2">{number(pool.unattributed)}</td>
                      <td className="px-2 py-2">
                        <div>{pool.ownerReported ? t("usage.ownerReported") : pool.synthetic ? t("usage.synthetic") : pool.verification}</div>
                        {(pool.ownerReported || pool.provenance === "unknown" || pool.verification === "unknown" || pool.truncated) && (
                          <div className="text-muted-foreground">{t("analytics.project.old")}</div>
                        )}
                        <div className="text-muted-foreground">{pool.statement}</div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </section>

        {scopedTasks.foreign > 0 && <p className="text-sm text-warning" data-testid="project-analytics-foreign">{t("analytics.project.foreign")}</p>}
        {scopedTasks.rows.length > 0 && (
          <div className="overflow-x-auto rounded-xl border">
            <table className="w-full min-w-[32rem] text-left text-xs">
              <thead className="bg-muted/60 text-muted-foreground">
                <tr>{[t("usage.task"), t("usage.worker"), t("usage.realRuns"), t("usage.cost")].map((heading) => (
                  <th key={heading} scope="col" className="px-3 py-2 font-medium">{heading}</th>
                ))}</tr>
              </thead>
              <tbody>
                {scopedTasks.rows.map((task) => (
                  <tr key={task.id} className="border-t" data-testid="project-analytics-task">
                    <th scope="row" className="px-3 py-2 font-medium">
                      <button type="button" className="text-left text-primary hover:underline" onClick={() => setDrill(task.id)}>{task.title}</button>
                    </th>
                    <td className="px-3 py-2">{duration(task.workerMs)}</td>
                    <td className="px-3 py-2">{number(task.usage.realRuns)}</td>
                    <td className="px-3 py-2">{costTotal(task.usage)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}

        <details className="rounded-xl border bg-card p-4" data-testid="project-analytics-details">
          <summary className="cursor-pointer text-sm font-semibold">{t("analytics.project.details")}</summary>
          <div className="mt-3">
            <UsageAnalyticsPage
              embedded
              lockedProjectPath={projectPath}
              onOpenTask={onOpenTask}
            />
          </div>
        </details>
      </div>
      {drill && <UsageTaskDialog taskId={drill} onClose={() => setDrill(null)} onOpenTask={onOpenTask} />}
    </div>
  );
}

function Fact({ label, value }: { label: string; value: string }) {
  return (
    <div className="min-w-0 rounded-md border px-3 py-2">
      <dt className="text-xs text-muted-foreground">{label}</dt>
      <dd className="break-words font-medium tabular-nums">{value}</dd>
    </div>
  );
}

function estimateDuration(ms: number | null | undefined, partial: boolean): string {
  if (ms == null || (partial && ms === 0)) return unknown();
  return duration(ms);
}

function hasActivity(data: Result): boolean {
  return data.usage.realRuns > 0 || data.usage.syntheticRuns > 0 || data.usage.unknownRuns > 0
    || data.usage.costTotals.length > 0 || data.usage.unknownCostRuns > 0 || data.usage.subscriptionRuns > 0
    || (data.company.time.workerMs ?? 0) > 0 || (data.elapsedMs ?? 0) > 0;
}

/** Present so a caller can build the same filter the page sends. */
export function projectAnalyticsQuery(projectPath: string, extra: AnalyticsFilter = {}): AnalyticsFilter {
  return lockProjectFilter(projectPath, extra);
}
