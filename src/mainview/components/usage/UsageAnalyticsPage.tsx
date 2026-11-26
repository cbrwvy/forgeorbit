import { RuntimeSafetyNotice } from "@/components/ui/runtime-safety-notice";
import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { EmptyState } from "@/components/ui/state";
import { useLocale } from "@/i18n/react";
import { t, type TranslationKey } from "@/i18n/core";
import { api } from "@/lib/api";
import { rangeBounds, type RangePreset, type TrendGrain } from "../../../shared/company-analytics.ts";
import type { AnalyticsFilter } from "../../../shared/usage-analytics.ts";
import { DataTable, date, duration, Metrics, money, notesClass, number, Picker, QuotaTable, unknown } from "./presentation";
import { AmountButton, RecordsPanel, type Bucket } from "./UsageRecords";
import { UsageForecastPage } from "./UsageForecast";
import { UsageResources } from "./UsageResources";
import { UsageTaskDialog } from "./UsageTaskDialog";

type Result = Awaited<ReturnType<typeof api.usageAnalytics>>;
type Resources = Awaited<ReturnType<typeof api.usageResources>>;
type Selectors = Awaited<ReturnType<typeof api.usageSelectors>>;
type Usage = Result["usage"];

// M3: one page title, three tabs in Owner order. Ids (and test ids) are unchanged.
const sections = ["analytics", "forecasts", "resources"] as const;
const SECTION_LABEL = { analytics: "analytics.tab.usage", forecasts: "analytics.tab.forecasts", resources: "analytics.tab.capacity" } as const;
const views = ["overview", "time", "costs", "quota", "performance"] as const;
const presets = ["today", "yesterday", "last7", "last30", "month", "all"] as const;
const costTotal = (value: Usage) => value.costTotals.length ? value.costTotals.map(c =>
  `${t(`usage.${c.kind}` as TranslationKey)} ${money(c)}`).join(" · ") : unknown();
const zone = () => Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
const dayInput = (ms: number, timeZone: string) => new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" }).format(ms);

/** True when the result holds any recorded activity or run usage. No activity is "nothing recorded", never "zero usage". */
export function hasRecordedActivity(data: Pick<Result, "company" | "usage">): boolean {
  const counts = data.company.counts;
  return counts.created > 0 || counts.started > 0 || counts.completed > 0 || counts.running > 0 || counts.blocked > 0
    || data.usage.costTotals.length > 0 || data.usage.unknownCostRuns > 0 || data.usage.subscriptionRuns > 0;
}

function UsageResults({ data, view, open, query }: { data: Result; view: typeof views[number]; open: (id: string, runId?: string) => void; query: AnalyticsFilter }) {
  const company = data.company;
  // undefined: records closed; null: every counted run; otherwise one amount bucket.
  const [bucket, setBucket] = useState<Bucket | undefined>(undefined);
  useEffect(() => setBucket(undefined), [data]);
  const amounts = (rows: Usage["costTotals"]) => rows.map(row => <AmountButton key={`${row.kind}/${row.currency}`} bucket={`${row.kind}/${row.currency}`} active={bucket === `${row.kind}/${row.currency}`} onOpen={setBucket}>
    {t(`usage.${row.kind}` as TranslationKey)} {money(row)}</AmountButton>);
  const costTile = data.usage.costTotals.length ? <span className="flex flex-wrap gap-x-3 gap-y-1">{amounts(data.usage.costTotals)}</span> : unknown();
  const counted = (value: number, target: string) => value > 0
    ? <AmountButton bucket={target} active={bucket === target} onOpen={setBucket}>{number(value)}</AmountButton> : number(value);
  const excludedRuns = data.usage.syntheticRuns + data.usage.unknownRuns;
  const priced = data.usage.realRuns - data.usage.unknownCostRuns - data.usage.subscriptionRuns;
  const bucketLabels = ["< 15 min", "15–60 min", "1–4 h", "≥ 4 h"];
  const counts = company.counts;
  return <div className="space-y-4" data-testid="usage-analytics-results">
    <p className={notesClass}>{t("usage.periodNote")}</p>
    {data.truncated && <p className="text-sm text-warning" data-testid="usage-scope-truncated">{t("trace.scopeTruncated", { limit: data.taskScopeLimit })}</p>}
    <p className={notesClass} data-testid="usage-timezone">{t("usage.timezone")}: {company.timezone}</p>
    {bucket !== undefined && <RecordsPanel query={query} bucket={bucket} onBucket={setBucket} onClose={() => setBucket(undefined)} open={open} />}
    {view === "overview" && data.usage.realRuns > 0 && <p className={notesClass} data-testid="usage-cost-coverage">{t("trace.costCoverage", {
      priced, counted: data.usage.realRuns, unknown: data.usage.unknownCostRuns, subscription: data.usage.subscriptionRuns, excluded: excludedRuns,
    })}</p>}
    {view === "overview" && <Metrics items={[
      [t("usage.completed"), number(counts.completed)], [t("usage.createdCount"), number(counts.created)], [t("usage.started"), number(counts.started)],
      [t("usage.runningNow"), number(counts.running)], [t("usage.blockedNow"), number(counts.blocked)],
      [t("usage.average"), duration(company.durations.averageMs)], [t("usage.median"), duration(company.durations.medianMs)], [t("usage.p85"), duration(company.durations.p85Ms)],
      [t("usage.worker"), duration(company.time.workerMs)], [t("usage.cost"), costTile],
      [t("usage.unknownCost"), counted(data.usage.unknownCostRuns, "unknown-cost")],
      [t("usage.firstPass"), data.firstPass === null ? unknown() : `${number(data.firstPass * 100)}% (${data.firstPassSamples})`],
      [t("usage.perTaskQuotaUnknown"), t("usage.perTaskQuotaUnknown")],
    ]} />}
    {view === "time" && <Metrics items={[
      [t("usage.worker"), duration(company.time.workerMs)], [t("usage.activeWallSum"), duration(company.time.activeWallMs)],
      [t("usage.developerTime"), duration(company.time.developerMs)], [t("usage.reviewerTime"), duration(company.time.reviewerMs)],
      [t("usage.preparationMeasured"), duration(company.time.preparationMs)], [t("usage.testing"), duration(company.time.testMs)],
      [t("usage.qc"), duration(company.time.qcMs)], [t("usage.rework"), duration(company.time.reworkMs)],
      [t("usage.waitingTotal"), duration(company.time.waitingMs)], [t("usage.unclassified"), duration(company.time.unclassifiedMs)],
      [t("usage.elapsed"), duration(data.elapsedMs)], [t("usage.legacy"), number(data.legacyDoneWithoutTimestamp)],
    ]} />}
    {view === "costs" && <>
      <Metrics items={[
        ...data.usage.costTotals.map(row => [`${t(`usage.${row.kind}` as TranslationKey)} · ${row.currency}`, amounts([row])[0]] as [string, React.ReactNode]),
        [t("usage.unknownCost"), counted(data.usage.unknownCostRuns, "unknown-cost")], [t("usage.subscription"), counted(data.usage.subscriptionRuns, "subscription")],
        [t("usage.excludedRuns"), counted(excludedRuns, "excluded")],
        ...company.costs.ownerAdjustments.map(row => [t("usage.ownerAdjustments") + " · " + row.currency, money(row)] as [string, string]),
      ]} />
      <p className={notesClass} data-testid="usage-cost-coverage">{t("trace.costCoverage", {
        priced, counted: data.usage.realRuns, unknown: data.usage.unknownCostRuns, subscription: data.usage.subscriptionRuns, excluded: excludedRuns,
      })}</p>
      <DataTable headings={[t("usage.project"), t("usage.realRuns"), t("usage.input"), t("usage.output"), t("usage.cost")]}
        rows={company.projects.map(row => ({ id: row.projectPath, cells: [row.projectPath, row.realRuns, number(row.tokens.input), number(row.tokens.output), costTotal(row)] }))} />
    </>}
    {view === "quota" && <>
      <p className={notesClass}>{t("usage.perTaskQuotaUnknown")}</p>
      <p className={notesClass}>{company.quota.note}</p>
      <DataTable headings={[t("usage.account"), t("usage.quota"), t("usage.poolDelta"), t("usage.unattributedQuota"), t("usage.reset"), t("usage.coverage")]}
        rows={company.quota.pools.map(pool => ({ id: pool.quotaId, cells: [
          pool.accountLabel, `${pool.scope} · ${pool.window} · ${pool.unit}`, number(pool.poolDelta), number(pool.unattributed), number(pool.resets),
          `${pool.synthetic ? t("usage.synthetic") : pool.ownerReported ? t("usage.ownerReported") : pool.verification} · ${pool.statement}`,
        ] }))} />
    </>}
    {view === "performance" && <>
      <p className={notesClass}>{t("usage.syntheticExcluded")}</p>
      <h3 className="font-semibold">{t("usage.employeeEffectiveness")}</h3>
      <DataTable headings={[t("usage.specialist"), t("usage.role"), t("usage.implemented"), t("usage.participation"), t("usage.realRuns"), t("usage.firstPass"), t("usage.worker"), t("usage.comparisonLabel")]}
        rows={company.employees.map(row => ({ id: row.id, cells: [
          row.name, row.role, row.developerCompletedTasks, row.participatedTasks, row.genuineAttempts,
          row.developerFirstPass.rate === null ? unknown() : `${number(row.developerFirstPass.rate * 100)}% (${row.developerFirstPass.samples})`,
          duration(row.workerMs), row.comparison === "comparable" ? t("usage.comparable") : t("usage.insufficient"),
        ] }))} />
      <h3 className="font-semibold">{t("usage.modelEffectiveness")}</h3>
      <DataTable headings={[t("usage.role"), t("usage.model"), t("usage.account"), t("usage.realRuns"), t("usage.median"), t("usage.cost"), t("usage.comparisonLabel")]}
        rows={company.models.map(row => ({ id: `${row.role}:${row.provider}:${row.model}:${row.accountId ?? "none"}`, cells: [
          t(`usage.${row.role}`), `${row.provider ?? unknown()} · ${row.model ?? unknown()}`, row.accountId ?? unknown(), row.genuineRuns,
          duration(row.medianDurationMs), row.averageCharge ? money(row.averageCharge) : costTotal({ ...data.usage, costTotals: row.costs }),
          row.comparison === "comparable" ? t("usage.comparable") : t("usage.insufficient"),
        ] }))} />
    </>}
    {view === "overview" && <Metrics items={[
      [t("usage.elapsed"), duration(data.elapsedMs)], [t("usage.legacy"), number(data.legacyDoneWithoutTimestamp)],
      [t("usage.reworkedTasks"), number(data.tasksWithRework)],
      [t("usage.realRuns"), number(data.usage.realRuns)],
      [t("usage.synthetic"), counted(data.usage.syntheticRuns, "excluded")], [t("usage.unknownRuns"), counted(data.usage.unknownRuns, "excluded")],
    ]} />}
    {(view === "overview" || view === "time") && <section className="space-y-2">
      <h3 className="font-semibold">{t("usage.distribution")}</h3>
      <div className="grid gap-2 text-xs">
        {data.distribution.map((count, index) => <div key={index} className="grid grid-cols-[5rem_1fr_3rem] items-center gap-2">
          <span>{bucketLabels[index]}</span>
          <progress className="h-2 w-full accent-primary" max={Math.max(1, ...data.distribution)} value={count} aria-label={bucketLabels[index]} />
          <span className="text-right tabular-nums">{number(count)}</span>
        </div>)}
      </div>
    </section>}
    {(view === "overview" || view === "time" || view === "costs") && <DataTable headings={[t("usage.specialist"), t("usage.realRuns"), t("usage.worker"), t("usage.input"), t("usage.output"), t("usage.cost"), t("usage.coverage")]}
      rows={([["all", data.usage], ["developer", data.developer], ["reviewer", data.reviewer]] as const).map(([role, u]) => ({
        id: role, cells: [t(`usage.${role}`), u.realRuns, duration(u.workerMs),
          `${number(u.tokens.input)} (${u.tokenCoverage.input}/${u.realRuns})`, `${number(u.tokens.output)} (${u.tokenCoverage.output}/${u.realRuns})`,
          costTotal(u), `${t("usage.unknown")} ${u.unknownCostRuns} · ${t("usage.subscription")} ${u.subscriptionRuns}`],
      }))} />}
    {(view === "overview" || view === "time") && <details open={view === "time"}><summary className="cursor-pointer font-semibold">{t("usage.trends")} · {company.timezone} · {t(`usage.grain.${company.grain}`)}</summary>
      <div className="mt-2"><DataTable headings={[t("usage.observed"), t("usage.completed"), t("usage.median"), t("usage.p85"), t("usage.realRuns"), t("usage.cost")]}
        rows={company.trends.map(d => ({ id: d.date, cells: [d.date, d.completed, duration(d.medianMs), duration(d.p85Ms), d.realRuns, costTotal(d)] }))} /></div>
    </details>}
    {(view === "overview" || view === "performance") && <details><summary className="cursor-pointer font-semibold">{t("usage.comparison")}</summary>
      <div className="mt-2"><DataTable headings={[t("usage.task"), t("usage.workDelta"), t("usage.completionDelta"), t("usage.costDelta")]}
        rows={data.accuracy.map(d => ({ id: d.taskId, cells: [
          <button className="text-left text-primary hover:underline" onClick={() => open(d.taskId)}>{data.tasks.find(t => t.id === d.taskId)?.title ?? d.taskId}</button>,
          duration(d.workerDeltaMs), duration(d.completionDeltaMs), money(d.costDelta),
        ] }))} /></div>
    </details>}
    {data.quotas.some(a => a.quota.length > 0) && <details>
      <summary className="cursor-pointer font-semibold">{t("usage.quota")}</summary>
      {data.quotas.filter(a => a.quota.length).map(a => <div className="mt-2 space-y-1" key={a.id}><p className="text-sm">{a.label}</p><QuotaTable quota={a.quota} /></div>)}
    </details>}
    <p className={notesClass} data-testid="usage-task-list-note">{data.tasksInScopeIsLowerBound
      ? t("trace.taskListNoteMore", { listed: data.tasks.length, limit: data.taskScopeLimit })
      : t("trace.taskListNote", { listed: data.tasks.length, total: data.tasksInScope })}</p>
    <DataTable headings={[t("usage.task"), t("usage.done"), t("usage.totalElapsed"), t("usage.rework"), t("usage.realRuns"), t("usage.cost"), t("comparison.forecastColumn")]}
      rows={data.tasks.map(a => ({
        id: a.id, cells: [
          <button className="text-left text-primary hover:underline" onClick={() => open(a.id)}>{a.title}</button>,
          date(a.doneAt), duration(a.elapsedMs), a.reworks, a.usage.realRuns, costTotal(a.usage),
          <button className="text-left text-primary hover:underline" data-testid="usage-task-baseline" data-task-id={a.id}
            data-baseline-id={a.baselineEstimateId ?? ""} onClick={() => open(a.id)}>
            {a.baselineEstimateId !== null ? t("comparison.hasBaseline", { id: a.baselineEstimateId }) : t("comparison.noBaselineShort")}
          </button>,
        ],
      }))} />
  </div>;
}

function UsageAnalytics({ resources, selectors, open, onOpenTasks, lockedProjectPath }: { resources: Resources; selectors: Selectors; open: (id: string, runId?: string) => void; onOpenTasks?: () => void; lockedProjectPath?: string }) {
  const lock = (filter: AnalyticsFilter): AnalyticsFilter => lockedProjectPath ? { ...filter, projectPath: lockedProjectPath } : filter;
  const [filter, setFilter] = useState<AnalyticsFilter>(() => lock({}));
  const [from, setFrom] = useState("");
  const [until, setUntil] = useState("");
  const [grain, setGrain] = useState<TrendGrain>("day");
  const [view, setView] = useState<typeof views[number]>("overview");
  const [result, setResult] = useState<Result | null>(null);
  const [query, setQuery] = useState<AnalyticsFilter>(() => lock({}));
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [busy, setBusy] = useState(true);
  const timeZone = zone();
  useEffect(() => {
    setFilter(lock({}));
    setFrom("");
    setUntil("");
    setQuery(lock({}));
  }, [lockedProjectPath]);
  useEffect(() => {
    let current = true;
    setBusy(true);
    setError("");
    api.usageAnalytics(query, { timeZone, grain }).then(data => { if (current) setResult(data); }, cause => {
      if (current) { setResult(null); setError(cause instanceof Error ? cause.message : String(cause)); }
    }).finally(() => { if (current) setBusy(false); });
    return () => { current = false; };
  }, [query, grain, timeZone]);
  const pick = (key: keyof AnalyticsFilter, label: TranslationKey, options: Array<{ id: string; label: string }>) =>
    <Picker id={`usage-filter-${key}`} label={t(label)} value={String(filter[key] ?? "")} options={options} onChange={value =>
      setFilter(old => ({ ...old, [key]: value || undefined }))} />;
  const unique = (items: string[]) => [...new Set(items)].sort().map(id => ({ id, label: id }));
  const draft = () => Object.fromEntries(Object.entries(filter).filter(([, v]) => v !== undefined)) as AnalyticsFilter;
  const apply = () => {
    const next = draft();
    if (from) next.from = new Date(from + "T00:00:00").getTime();
    if (until) {
      const end = new Date(until + "T00:00:00");
      end.setDate(end.getDate() + 1);
      next.until = end.getTime();
    }
    setQuery(lock(next));
  };
  const applyPreset = (preset: RangePreset) => {
    const bounds = rangeBounds(preset, Date.now(), timeZone);
    setFrom(bounds.from === undefined ? "" : dayInput(bounds.from, timeZone));
    setUntil(bounds.until === undefined ? "" : dayInput(bounds.until - 1, timeZone));
    const next = draft();
    if (bounds.from !== undefined) next.from = bounds.from;
    if (bounds.until !== undefined) next.until = bounds.until;
    setQuery(lock(next));
  };
  const download = async (report: "tasks" | "models" | "runs", format: "csv" | "json") => {
    setError("");
    setNotice("");
    try {
      const file = await api.usageExportSave(query, { timeZone, grain, format, report });
      setNotice(t("usage.exportSaved", { path: file.path }));
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  };
  return <div className="space-y-4">
    <div className="flex flex-wrap gap-2" data-testid="usage-presets">
      {presets.map(preset => <Button key={preset} size="sm" variant="outline" data-testid={`usage-range-${preset}`} onClick={() => applyPreset(preset)}>{t(`usage.preset.${preset}`)}</Button>)}
    </div>
    <div className="flex flex-wrap gap-2" aria-label={t("usage.analytics")}>
      {views.map(item => <Button key={item} size="sm" variant={view === item ? "default" : "outline"} aria-pressed={view === item}
        data-testid={`usage-view-${item}`} onClick={() => setView(item)}>{t(`usage.${item === "time" ? "timeView" : item === "costs" ? "costView" : item === "quota" ? "quotaView" : item}`)}</Button>)}
    </div>
    <div className="grid gap-2 rounded-md border bg-card p-3 sm:grid-cols-2 lg:grid-cols-4">
      <label className="space-y-1 text-xs text-muted-foreground">{t("usage.from")}<Input type="date" value={from} onChange={e => setFrom(e.target.value)} /></label>
      <label className="space-y-1 text-xs text-muted-foreground">{t("usage.through")}<Input type="date" value={until} onChange={e => setUntil(e.target.value)} /></label>
      <Picker label={t("usage.grain")} value={grain} options={(["day", "week", "month"] as const).map(id => ({ id, label: t(`usage.grain.${id}`) }))} onChange={value => setGrain((value || "day") as TrendGrain)} />
      {pick("clusterId", "usage.cluster", selectors.clusters)}
      {!lockedProjectPath && pick("projectPath", "usage.project", selectors.projects)}
      {pick("missionId", "usage.mission", selectors.missions)}
      {pick("specialist", "usage.specialist", [
        { id: "developer", label: t("usage.developer") }, { id: "reviewer", label: t("usage.reviewer") }, ...selectors.specialists,
      ])}
      {pick("provider", "usage.provider", unique([...resources.resources.map(r => r.provider), ...resources.accounts.map(a => a.provider)]))}
      {pick("model", "usage.model", unique(resources.resources.map(r => r.modelId)))}
      {pick("accountId", "usage.account", resources.accounts.map(a => ({ id: a.id, label: a.label })))}
      {pick("category", "usage.category", unique(["task", "bug", "spike"]))}
      <label className="space-y-1 text-xs text-muted-foreground">{t("usage.task")}
        <Input value={filter.taskId ?? ""} onChange={e => setFilter(old => ({ ...old, taskId: e.target.value.trim() || undefined }))} />
      </label>
      <label className="space-y-1 text-xs text-muted-foreground">{t("usage.taskIds")}
        <Input value={(filter.taskIds ?? []).join(",")} onChange={e => {
          const ids = e.target.value.split(/[\s,]+/).map(value => value.trim()).filter(Boolean);
          setFilter(old => ({ ...old, taskIds: ids.length ? ids : undefined }));
        }} />
      </label>
      <Button className="self-end" disabled={busy} onClick={apply}>{t("usage.apply")}</Button>
    </div>
    <div className="flex flex-wrap gap-2">
      <Button size="sm" variant="outline" data-testid="usage-export-tasks" disabled={busy} onClick={() => void download("tasks", "csv")}>{t("usage.exportTasks")}</Button>
      <Button size="sm" variant="outline" data-testid="usage-export-models" disabled={busy} onClick={() => void download("models", "csv")}>{t("usage.exportModels")}</Button>
      <Button size="sm" variant="outline" data-testid="usage-export-json" disabled={busy} onClick={() => void download("tasks", "json")}>{t("usage.exportJson")}</Button>
      <Button size="sm" variant="outline" data-testid="usage-export-runs-csv" disabled={busy} onClick={() => void download("runs", "csv")}>{t("trace.exportRunsCsv")}</Button>
      <Button size="sm" variant="outline" data-testid="usage-export-runs-json" disabled={busy} onClick={() => void download("runs", "json")}>{t("trace.exportRunsJson")}</Button>
    </div>
    {busy && <p role="status">{t("usage.loading")}</p>}
    {notice && <p role="status">{notice}</p>}
    {error && <p role="alert" className="text-destructive">{error}</p>}
    {result && !busy && (hasRecordedActivity(result)
      ? <UsageResults data={result} view={view} open={open} query={query} />
      : Object.entries(query).some(([key, value]) => value != null && value !== "" && !(lockedProjectPath && key === "projectPath"))
        ? <EmptyState className="rounded-md border bg-card" testId="usage-empty-filtered" title={t("m7.empty.analytics.filtered_title")} description={t("m7.empty.analytics.filtered_description")}
            action={<Button size="sm" variant="outline" data-testid="usage-empty-reset" onClick={() => { setFilter(lock({})); setFrom(""); setUntil(""); setQuery(lock({})); }}>{t("m7.empty.analytics.reset")}</Button>} />
        : <EmptyState className="rounded-md border bg-card" testId="usage-empty" title={t("m7.empty.analytics.title")} description={t("m7.empty.analytics.description")}
            action={onOpenTasks ? <Button size="sm" variant="outline" data-testid="usage-empty-open-tasks" onClick={onOpenTasks}>{t("m7.empty.analytics.open_tasks")}</Button> : undefined} />)}
  </div>;
}

export function UsageAnalyticsPage({ onOpenTask, onOpenTasks, lockedProjectPath, embedded = false }: { onOpenTask: (id: string) => void; onOpenTasks?: () => void; lockedProjectPath?: string; embedded?: boolean }) {
  useLocale();
  const [tab, setTab] = useState<typeof sections[number]>("analytics");
  const [resources, setResources] = useState<Resources | null>(null);
  const [selectors, setSelectors] = useState<Selectors | null>(null);
  const [task, setTask] = useState<{ id: string; runId?: string } | null>(null);
  const [error, setError] = useState("");
  async function load() {
    setError("");
    try {
      const [resources, selectors] = await Promise.all([api.usageResources(), api.usageSelectors()]);
      setResources(resources);
      setSelectors(selectors);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  }
  useEffect(() => { void load(); }, []);
  return <div className={embedded ? "space-y-4" : "min-h-0 flex-1 overflow-auto pb-[calc(1rem+var(--shell-dock-clearance))]"} data-testid="usage-page" data-project={lockedProjectPath}>
    <div className={embedded ? "space-y-4" : "mx-auto max-w-[88rem] space-y-4 p-4 sm:p-6"}>
      {!embedded && <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <h1 className="text-xl font-semibold" data-testid="usage-title">{t("analytics.title")}</h1>
          <RuntimeSafetyNotice liveTestId="usage-live-launch" channelTestId="usage-owner-channel" className="text-sm" />
        </div>
        <Button size="sm" variant="outline" onClick={() => void load()}>{t("usage.refresh")}</Button>
      </div>}
      {embedded && <div className="flex flex-wrap items-start justify-between gap-2">
        <RuntimeSafetyNotice liveTestId="usage-live-launch" channelTestId="usage-owner-channel" className="min-w-0 flex-1 text-sm" />
        <Button size="sm" variant="outline" onClick={() => void load()}>{t("usage.refresh")}</Button>
      </div>}
      <nav className="flex flex-wrap gap-2" aria-label={t("analytics.title")}>
        {sections.map(section => <Button key={section} size="sm" variant={tab === section ? "default" : "outline"}
          aria-pressed={tab === section} data-testid={`usage-tab-${section}`} onClick={() => setTab(section)}>{t(SECTION_LABEL[section])}</Button>)}
      </nav>
      {error && <p role="alert" className="text-destructive">{error}</p>}
      {!error && (!resources || !selectors) && <p role="status">{t("usage.loading")}</p>}
      {resources && tab === "resources" && <UsageResources data={resources} onChange={load} />}
      {selectors && tab === "forecasts" && <UsageForecastPage selectors={selectors} lockedProjectPath={lockedProjectPath} />}
      {resources && selectors && tab === "analytics" && <UsageAnalytics resources={resources} selectors={selectors} open={(id, runId) => setTask({ id, runId })} onOpenTasks={onOpenTasks} lockedProjectPath={lockedProjectPath} />}
      {task && <UsageTaskDialog taskId={task.id} runId={task.runId} onClose={() => setTask(null)} onOpenTask={onOpenTask} />}
    </div>
  </div>;
}
