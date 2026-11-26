import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { t, type TranslationKey } from "@/i18n/core";
import { api } from "@/lib/api";
import type { ForecastSelection, QuotaPlanningWindow } from "../../../shared/usage-analytics.ts";
import type { AllocationPlanView } from "../../../shared/allocation/types.ts";
import type { TaskForecast } from "../../../bun/usage-analytics/forecast.ts";
import { describeEstimateBasis } from "../../../shared/estimate-basis.ts";
import type { ProviderRefusalSummary } from "../../../shared/provider-refusal.ts";
import { ProviderRefusalNotice } from "@/components/ui/provider-refusal-notice";
import { AlternativeComparison, ConstraintsPanel } from "./PortfolioPlanning";
import { costText, DataTable, date, duration, Metrics, money, notesClass, number, Picker, QuotaTable, unknown } from "./presentation";

type Selection = Awaited<ReturnType<typeof api.usageSelectors>>;
type Forecast = Awaited<ReturnType<typeof api.usageForecast>>;
const scenarios = ["optimistic", "expected", "conservative"] as const;
const sorts = ["balanced", "fastest", "cheapest", "quality", "quotaFirst", "feasibility", "leastRework"] as const;
type Sort = typeof sorts[number];
const quality = ["economy", "standard", "advanced", "flagship"];
type Option = TaskForecast["developerOptions"][number];
const optionKey = (o: Option) => JSON.stringify([o.harnessId, o.accountId, o.modelId, o.mode]);
const rangeText = (r: TaskForecast["worker"] | null | undefined, format = duration) =>
  r ? scenarios.map(k => format(r[k])).join(" / ") : unknown();
export const reasonText = (reason: string) => t(`usage.block.${reason}` as TranslationKey);

function optionsFor(options: Option[], sort: Sort) {
  const price = (o: Option) => o.cost.kind === "calculated-api" ? o.cost.money : null;
  return options.slice().sort((a, b) => {
    const readiness = (o: Option) => o.eligibility === "eligible" ? 2 : o.planningEligible ? 1 : 0;
    const readinessDelta = readiness(b) - readiness(a);
    if (readinessDelta) return readinessDelta;
    if (sort === "fastest") {
      const measured = Number(b.samples >= 3) - Number(a.samples >= 3);
      return measured || (a.samples >= 3 && b.samples >= 3 ? a.duration.expected - b.duration.expected : 0) || b.score - a.score;
    }
    if (sort === "cheapest") {
      const x = price(a), y = price(b);
      if (!x || !y) return Number(!!y) - Number(!!x) || b.score - a.score;
      return x.currency.localeCompare(y.currency) || x.amount - y.amount;
    }
    if (sort === "quality") return quality.indexOf(b.tier) - quality.indexOf(a.tier) || b.score - a.score;
    if (sort === "quotaFirst" || sort === "feasibility") {
      const fit = (o: Option) => o.quotaPlan?.some(q => q.fit === "exceeds") ? -1
        : o.quotaPlan?.length && o.quotaPlan.every(q => q.fit === "fits") ? 1 : 0;
      return fit(b) - fit(a) || (sort === "quotaFirst" && a.provider === b.provider && price(a)?.currency === price(b)?.currency
        ? (price(a)?.amount ?? Infinity) - (price(b)?.amount ?? Infinity) : 0) || b.score - a.score;
    }
    if (sort === "leastRework") return (a.reworkRisk ?? Infinity) - (b.reworkRisk ?? Infinity) || b.score - a.score;
    return b.score - a.score;
  });
}

function Options({ options, selected, role, onAlternative, refusals }: {
  options: Option[]; selected: Option | null; role: "developer" | "reviewer"; onAlternative?: (option: Option) => void;
  refusals?: Record<string, ProviderRefusalSummary>;
}) {
  const [sort, setSort] = useState<Sort>("balanced");
  return <div className="space-y-2">
    <h4 className="text-sm font-semibold">{t(`usage.${role}`)}</h4>
    <Picker label={t("usage.compare")} value={sort} options={sorts.map(id => ({ id, label: t(`usage.${id}`) }))}
      onChange={value => setSort((value || "balanced") as Sort)} />
    <DataTable headings={[t("usage.model"), t("usage.account"), t("usage.calendar"), t("usage.input"), t("usage.output"), t("usage.runCost"), t("usage.quota"), t("usage.samples")]}
      rows={optionsFor(options, sort).map(o => ({
        id: optionKey(o), cells: [
          <span>{o.modelId}<small className="block text-muted-foreground">{o.provider} · {o.label} · {o.tier}</small>
            {selected?.harnessId === o.harnessId && selected.modelId === o.modelId && selected.accountId === o.accountId && selected.mode === o.mode &&
              <small className="block text-primary">{t("usage.selected")}</small>}</span>,
          <span>{o.accountLabel ?? unknown()}<small className="block text-muted-foreground">{o.eligibility === "blocked" ? t("usage.blocked") :
            o.eligibility === "eligible" ? t("usage.eligible") : t("usage.preflight")}</small>
            {o.eligibilityReason && <small className="block text-muted-foreground">{o.eligibilityReason}</small>}
            {refusals?.[optionKey(o)] && <details className="mt-1" data-testid="usage-option-refusal">
              <summary className="cursor-pointer text-warning">{t("refusal.title.usage-limit")}</summary>
              <ProviderRefusalNotice refusal={refusals[optionKey(o)]!} testId="usage-option-refusal-notice" className="mt-1 space-y-1 text-xs" />
            </details>}</span>,
          rangeText(o.duration),
          <span>{number(o.tokens.input)}<small className="block">{t("usage.cacheRead")} {number(o.tokens.cacheRead)} · {t("usage.cacheWrite")} {number(o.tokens.cacheWrite)}</small></span>,
          number(o.tokens.output), <span>{costText(o.cost)}{o.pricingEffectiveAt && <small className="block">{date(o.pricingEffectiveAt)}</small>}</span>,
          o.nativeQuota.length
            ? <details><summary className="cursor-pointer">{t("usage.quotaEvidence")}</summary><QuotaTable quota={o.nativeQuota} />
              <p className={notesClass}>{t("usage.quotaFitBasis")}</p>
              {o.quotaPlan?.map(q => <p key={q.id} className={notesClass}>
                {o.nativeQuota.find(p => p.id === q.id)?.window} · {t(q.fit === "fits" ? "usage.quotaFit" : q.fit === "exceeds" ? "usage.quotaExceeds" : "usage.quotaFitUnknown")}
                {q.demand !== null && ` · ${number(q.demand)} (${t("usage.moneyMinor")})`}
                {q.reset !== "unknown" && ` · ${t(q.reset === "elapsed" ? "usage.quotaResetElapsed" : q.reset === "during-if-started-now" ? "usage.quotaResetDuring" : "usage.quotaResetAfter")}`}
              </p>)}</details> : unknown(),
          <span>{number(o.samples)} · {t(o.basis === "historical" ? "usage.historical" : "usage.heuristic")}
            {o.reworkRisk != null && <small className="block">{t("usage.rework")} {number(o.reworkRisk * 100)}%</small>}
            {onAlternative && o.eligibility === "eligible" && (!selected || optionKey(o) !== optionKey(selected)) &&
              <Button size="sm" variant="outline" onClick={() => onAlternative(o)}>{t("usage.comparePlan")}</Button>}
          </span>,
        ],
      }))} />
  </div>;
}

/** What the ranges rest on and what they cannot know. Derived from the saved estimate, so older revisions explain themselves too. */
function EstimateBasis({ estimate }: { estimate: TaskForecast }) {
  const basis = describeEstimateBasis(estimate);
  const resource = estimate.plannedResource;
  // A saved estimate only ever carries low / medium / high; anything else is shown as stored.
  const level = ["low", "medium", "high"].includes(estimate.complexity) ? t(`usage.basis.level.${estimate.complexity}` as TranslationKey) : estimate.complexity;
  const resourceText = resource ? [resource.harnessId, resource.modelId ?? unknown(), resource.mode ?? unknown()].join(" / ") : unknown();
  const inputText = (input: typeof basis.inputs[number]) => input === "scope"
    ? t("usage.basis.input.scope", { category: estimate.category, complexity: level, technology: estimate.technology === "unknown" ? unknown() : estimate.technology })
    : input === "resource" ? t("usage.basis.input.resource", { resource: resourceText })
    : input === "worker" ? t("usage.basis.input.worker") : t("usage.basis.input.dependencies", { count: estimate.dependsOn.length });
  return <div className="space-y-1 rounded-md border bg-muted/30 p-3" data-testid="estimate-basis" data-basis={basis.kind}>
    <h4 className="text-sm font-semibold">{t("usage.basis.title")}</h4>
    <p className="text-sm">{t(`usage.basis.${basis.kind}` as TranslationKey, { required: basis.required, complexity: level })}</p>
    <ul className={notesClass} data-testid="estimate-basis-stages">
      {basis.stages.map(stage => <li key={stage.role} data-role={stage.role} data-samples={stage.samples}>
        {t("usage.basis.stage", { role: t(`usage.${stage.role}`), samples: stage.samples, required: basis.required })}{" · "}
        {stage.basis === "historical" ? t("usage.historical") : t("usage.heuristic")}
      </li>)}
    </ul>
    <p className={notesClass} data-testid="estimate-basis-inputs">{t("usage.basis.informed")}: {basis.inputs.map(inputText).join("; ")}</p>
    <p className={notesClass} data-testid="estimate-basis-unknowns">{t("usage.basis.unknown")}: {basis.unknowns.map(item => t(`usage.basis.unknown.${item}` as TranslationKey)).join(", ")}</p>
  </div>;
}

export function EstimateView({ estimate, selection, onApplied, refusals }: {
  estimate: TaskForecast; selection?: ForecastSelection; onApplied?: () => void; refusals?: Record<string, ProviderRefusalSummary>;
}) {
  const [preview, setPreview] = useState<Forecast | null>(null);
  const [proposal, setProposal] = useState<AllocationPlanView | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const alternative = preview?.alternative;
  const change = proposal?.record.plan.forecastChange;
  const target = proposal?.record.plan.projects[0]?.tasks[0]?.developer;
  async function action(work: () => Promise<void>) {
    setBusy(true); setError("");
    try { await work(); }
    catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); }
    finally { setBusy(false); }
  }
  const choose = (option: Option) => void action(async () => {
    setProposal(null);
    setPreview(await api.usageForecast({ ...selection, save: false,
      alternative: { taskId: estimate.taskId, optionKey: optionKey(option) } }));
  });
  const usage = estimate.plannedUsage;
  const rows = ([
    ["usage.calendar", estimate.completion], ["usage.worker", estimate.worker], ["usage.testing", estimate.testing],
    ["usage.qc", estimate.qc], ["usage.rework", estimate.rework],
    ...(estimate.activeDeveloper ? [["usage.developer", estimate.activeDeveloper] as const] : []),
  ] as const).map(([key, range]) => ({ id: key, cells: [t(key), ...scenarios.map(k => duration(range[k]))] }));
  return <section className="space-y-3" data-testid="usage-task-estimate">
    <div>
      <h3 className="font-semibold">{estimate.title}{estimate.estimateId !== null ? ` · ${t("usage.revision")} #${estimate.estimateId}` : ""}</h3>
      <p className={notesClass}>{estimate.technology === "unknown" ? unknown() : estimate.technology} · {estimate.category} · {estimate.complexity} · {t("usage.confidence")} {t(`usage.${estimate.confidence}`)}</p>
    </div>
    <EstimateBasis estimate={estimate} />
    <DataTable headings={[t("usage.estimated"), ...scenarios.map(k => t(`usage.${k}`))]}
      rows={[...rows, { id: "runs", cells: [t("usage.runs"), ...scenarios.map(k => number(estimate.runs[k]))] }]} />
    <Metrics items={[
      [t("usage.input"), `${number(usage.input)} (${usage.inputStages}/${estimate.roles.length})`],
      [t("usage.output"), `${number(usage.output)} (${usage.outputStages}/${estimate.roles.length})`],
      [t("usage.subscriptionQuota"), unknown()],
      [t("usage.cost"), usage.totals.length ? usage.totals.map(c => `${t(`usage.${c.kind}` as TranslationKey)} ${money(c)}`).join(" · ") : unknown()],
      [t("usage.coverage"), `${t("usage.unknown")} ${usage.unknown} · ${t("usage.subscription")} ${usage.subscription}`],
    ]} />
    <p className={notesClass}>{t("usage.assumptions")}</p>
    <p className={notesClass}>{t("usage.forecastMethods")} {estimate.methodology}</p>
    {estimate.stageEvidence && <p className={notesClass}>{t("usage.stageSamples")} · {t("usage.developer")} {estimate.stageEvidence.developer}
      {" · "}{t("usage.reviewer")} {estimate.stageEvidence.reviewer} · {t("usage.testing")} {estimate.stageEvidence.test}
      {" · "}{t("usage.rework")} {estimate.stageEvidence.rework} · {t("usage.active")} {estimate.stageEvidence.wall}</p>}
    {estimate.historicalMeasuredWait && <p className={notesClass}>{t("usage.waitMeasured")} · {rangeText(estimate.historicalMeasuredWait)}</p>}
    {estimate.historicalWall && <p className={notesClass}>{t("usage.historicalWall")} · {rangeText(estimate.historicalWall)}</p>}
    {estimate.schedule && <Metrics items={[
      [t("usage.constrained"), duration(estimate.schedule.elapsed)], [t("usage.resourceWait"), duration(estimate.schedule.wait)],
      [t("usage.finishWindow"), date(estimate.schedule.completionAt)],
    ]} />}
    {estimate.schedule?.blockers.map(reason => <p key={reason} className={notesClass}>{reasonText(reason)}</p>)}
    {(estimate.pinnedUnavailable || estimate.reviewerPinnedUnavailable) && <p className="text-sm text-warning">{t("usage.pinned")}</p>}
    {estimate.expectedBudgetMs !== null && <p className={notesClass}>{t("usage.expectedBudget")} · {duration(estimate.expectedBudgetMs)}</p>}
    {estimate.dependsOn.length > 0 && <p className={notesClass}>{t("usage.external")} · {estimate.dependsOn.join(", ")}</p>}
    {estimate.optionsTruncated && <p className={notesClass}>{t("usage.truncated")}</p>}
    {preview && <div className="space-y-2 rounded-md border p-3" data-testid="usage-alternative">
      <h4 className="font-semibold">{t("usage.alternative")}</h4>
      {preview.comparison
        ? <AlternativeComparison comparison={preview.comparison} reasonText={reasonText} />
        : <Metrics items={[
          [t("usage.constrained"), rangeText(preview.elapsed)], [t("usage.finishWindow"), rangeText(preview.completionWindow, date)],
          [t("usage.cost"), preview.cost.totals.map(c => money(c)).join(" · ") || unknown()],
        ]} />}
      {preview.blockers.map(reason => <p key={reason} className={notesClass}>{reasonText(reason)}</p>)}
      <CapacityView data={preview} />
      {alternative && !proposal && !selection?.missionId && <Button variant="outline" disabled={busy} onClick={() => void action(async () => {
        setProposal(await api.usageFallbackProposal(alternative));
      })}>{t("usage.fallback")}</Button>}
      {proposal && change && target && <div className="space-y-2">
        <p>{change.original.harnessId} · {change.original.modelId ?? unknown()} · {change.original.accountId ?? unknown()} → {target.harnessLabel} · {target.modelId} · {target.accountId}</p>
        <p className={notesClass}>{t(change.reason === "resource-unavailable" ? "usage.fallbackUnavailable" : "usage.fallbackComparison")}</p>
        <Metrics items={[[t("usage.completionDelta"), duration(change.timeDeltaMs)], [t("usage.costDelta"), money(change.costDelta)],
          [t("usage.confidence"), t(`usage.${change.confidence}`)]]} />
        <p className={notesClass}>{t("usage.fallbackBound")}</p>
        {proposal.canApprove && <Button disabled={busy} onClick={() => void action(async () => {
          setProposal(await api.approveAllocationPlan(proposal.record.id, proposal.planDigest));
        })}>{t("usage.approveChange")}</Button>}
        {proposal.canApply && <Button disabled={busy} onClick={() => void action(async () => {
          setProposal(await api.applyAllocationPlan(proposal.record.id, proposal.record.approvedDigest!));
          onApplied?.();
        })}>{t("usage.applyChange")}</Button>}
        {proposal.record.status === "applied" && <p role="status">{t("usage.fallbackApplied")}</p>}
      </div>}
    </div>}
    {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
    <Options options={estimate.developerOptions} selected={estimate.developer} role="developer" onAlternative={selection && !busy ? choose : undefined} refusals={refusals} />
    {estimate.roles.includes("reviewer") && <Options options={estimate.reviewerOptions} selected={estimate.reviewer} role="reviewer" refusals={refusals} />}
  </section>;
}

export function CapacityView({ data }: { data: Pick<Forecast, "capacity"> }) {
  return <section className="space-y-2" data-testid="usage-capacity">
    <p className={notesClass}>{t("usage.capacityNote")} {t("usage.poolCoverage")} · {data.capacity.uncoveredStages}</p>
    {data.capacity.rows.length > 0 && <DataTable headings={[
      t("usage.quota"), t("usage.evidence"), t("usage.remaining"), t("usage.poolDemand"), t("usage.poolCoverage"), t("usage.shortfall"), t("usage.reset"),
    ]} rows={data.capacity.rows.map(pool => ({ id: pool.id, cells: [
      <span>{pool.window} · {pool.unit.kind}{"currency" in pool.unit ? ` · ${pool.unit.currency}` : "name" in pool.unit ? ` · ${pool.unit.name}` : ""}
        <small className="block">{pool.shared ? `${t("usage.quotaShared")} · ` : ""}{pool.accountIds.join(", ")}</small></span>,
      <span>{t(pool.evidence === "owner-reported" ? "usage.ownerReported" : `usage.${pool.evidence}` as TranslationKey)} · {t(pool.status === "insufficient" ? "usage.poolShortfall" : `usage.${pool.status}` as TranslationKey)}
        {pool.freshness === "stale-or-conflicting" && <small className="block">{t("usage.stale-or-conflicting")}</small>}
        {pool.provenance?.map((row, index) => <small className="block" key={index}>{row.source} · {date(row.observedAt)}</small>)}</span>,
      number(pool.remaining), pool.unknownStages && !pool.knownDemand ? unknown() : number(pool.knownDemand), number(pool.unknownStages),
      pool.shortfall === null ? "—" : number(pool.shortfall),
      <span>{date(pool.resetAt)}{[...new Set(pool.allocations?.filter(window => window.assumed).map(window =>
        `${date(window.startsAt)} – ${date(window.endsAt)}`))].map(window =>
        <small className="block" key={window}>{t("usage.assumedWindows")} · {window}</small>)}</span>,
    ] }))} />}
  </section>;
}

export function ScheduleStages({ data }: { data: Forecast }) {
  const labels: Record<Forecast["stages"][number]["kind"], TranslationKey> = {
    developer: "usage.developer", preparation: "usage.stagePreparation", testing: "usage.testing", reviewer: "usage.reviewer", rework: "usage.rework",
    retesting: "usage.stageRetesting", "final-review": "usage.stageFinalReview", completion: "usage.stageCompletion",
  };
  return <section className="space-y-2" data-testid="usage-stage-schedule">
    <Metrics items={[[t("usage.active"), rangeText(data.activeWall)], [t("usage.worker"), rangeText(data.worker)],
      [t("usage.resourceWait"), rangeText(data.resourceWait)], [t("usage.finishWindow"), rangeText(data.completionWindow, date)]]} />
    <p className={notesClass}>{t("usage.stagePreparationNote")}</p>
    {data.allocationComparison && data.allocationComparison.length > 0 && <div data-testid="usage-allocation-comparison">
      <p className="font-medium">{t("usage.allocationComparison")}</p>
      {data.allocationComparison.map(row => <p key={row.objective}>
        {t(`usage.allocation.${row.objective}` as TranslationKey)} · {row.feasible ? Object.values(row.assignment).length : t("usage.unknown")}
        {row.feasible && !row.optimal && ` · ${t("usage.allocationUnproven")}`}
      </p>)}
    </div>}
    <Metrics items={[[t("usage.wait.owner"), duration(data.ownerWaiting)], [t("usage.waitProvider"), duration(data.providerWaiting)]]} />
    {data.stageTimingIsBaseline && <p className={notesClass}>{t("usage.stageBaseline")}</p>}
    <details>
      <summary className="cursor-pointer text-sm">{t("usage.stageSchedule")}</summary>
      <DataTable headings={[t("usage.task"), t("usage.replanStage"), t("usage.stageOffset"), t("usage.resourceWait")]}
        rows={data.stages.map(stage => ({ id: stage.id, cells: [
          data.estimates.find(row => row.taskId === stage.taskId)?.title ?? stage.taskId,
          <span>{t(labels[stage.kind])}{stage.conditional && <small className="block">{t("usage.stageConditional")}</small>}
            <small className="block">{stage.resources.join(" · ")}</small></span>,
          stage.kind === "preparation" && stage.durationKnown === false ? unknown() : `${duration(stage.startMs)} / ${duration(stage.endMs)}`,
          `${duration(stage.startMs - stage.readyMs)} ${stage.delayedBy.join(" · ")}`,
        ] }))} />
    </details>
  </section>;
}

function PortfolioForecast({ data, selection, onApplied }: { data: Forecast; selection: ForecastSelection; onApplied: () => void }) {
  const [expanded, setExpanded] = useState<string | null>(null);
  const { cost, assumptions } = data;
  const usedAssumptions = [
    assumptions.startAuthorized && t("usage.startAssumption"),
    assumptions.unknownCapacity && t("usage.unknownCapacityAssumption"),
    assumptions.refillAtReset && t("usage.resetAssumption"),
    !!assumptions.quotaWindows?.length && `${t("usage.assumedWindows")} · ${assumptions.quotaWindows.length}`,
    assumptions.activeReleaseMs !== undefined && `${t("usage.activeRelease")} · ${duration(assumptions.activeReleaseMs)}`,
  ].filter(Boolean);
  return <div className="space-y-4" data-testid="usage-group-result">
    <Metrics items={[
      [t("usage.baseline"), rangeText(data.calendar)], [t("usage.constrained"), rangeText(data.elapsed)],
      [t("usage.resourceWait"), rangeText(data.resourceWait)], [t("usage.finishWindow"), rangeText(data.completionWindow, date)],
      [t("usage.activeWork"), `${data.active.competing} / ${data.active.selected} / ${data.active.missions}`],
      [t("usage.criticalPath"), duration(data.criticalPathMs)],
      [t("usage.worker"), duration(data.worker.expected)], [t("usage.runs"), number(data.expectedRuns)],
      [t("usage.concurrency"), number(data.concurrency)],
      [t("usage.revision"), data.revision == null ? unknown() : `#${data.revision}`],
      [t("usage.input"), number(cost.input)], [t("usage.output"), number(cost.output)],
      [t("usage.subscriptionQuota"), unknown()],
    ]} />
    <p className={notesClass}>{t("usage.assumptions")}</p>
    {usedAssumptions.length > 0 && <p className={notesClass}>{t("usage.ownerAssumptions")} · {usedAssumptions.join(" · ")}</p>}
    <ConstraintsPanel data={data} />
    {data.criticalPath.length > 0 && <p className={notesClass}>{t("usage.criticalPath")} · {data.criticalPath.map(id => data.estimates.find(e => e.taskId === id)?.title ?? id).join(" → ")}</p>}
    {data.blockers.map(reason => <p key={reason} className="text-sm text-warning">{reasonText(reason)}</p>)}
    <ScheduleStages data={data} />
    <CapacityView data={data} />
    {data.unallocated > 0 && <p className="text-sm text-warning">{t("usage.conditional")}</p>}
    {data.budget && <Metrics items={[
      [t("usage.expectedBudget"), duration(data.budget.expectedMs)],
      [t("usage.maxDuration"), duration(data.budget.maxDurationMs)],
      [t("autonomy.launches"), number(data.budget.maxLaunches)],
      [t("usage.spendBudget"), data.budget.apiUsd == null ? unknown() : money({ amount: data.budget.apiUsd, currency: "USD" })],
      ...(data.budget.requireVerifiedQuota ? [[t("usage.verifiedQuota"), t("usage.required")] as [string, string]] : []),
    ]} />}
    {data.bottlenecks.length > 0 && <p className={notesClass}>{t("usage.bottlenecks")} · {data.bottlenecks.map(([key, cap]) => `${key} (${cap})`).join(", ")}</p>}
    {data.outsideDependencies.length > 0 && <p className="text-sm text-warning">{t("usage.external")} · {data.outsideDependencies.join(", ")}</p>}
    {data.ownerGates.length > 0 && <p className="text-sm text-warning">{t("usage.ownerGate")} · {data.ownerGates.join(", ")}</p>}
    {data.cycles.length > 0 && <p className="text-sm text-warning">{t("usage.cycles")} · {data.cycles.map(c => c.join(" → ")).join(", ")}</p>}
    {data.omitted > 0 && <p className="text-sm text-warning">{t("usage.omitted")} · {data.omitted}</p>}
    <Metrics items={[
      [t("usage.cost"), cost.totals.length ? cost.totals.map(c => `${t(`usage.${c.kind}` as TranslationKey)} ${money(c)}`).join(" · ") : unknown()],
      [t("usage.coverage"), `${t("usage.unknown")} ${cost.unknown} · ${t("usage.subscription")} ${cost.subscription}`],
    ]} />
    <DataTable headings={[t("usage.task"), t("usage.calendar"), t("usage.confidence")]}
      rows={data.estimates.map(e => ({ id: e.taskId, cells: [
        <button className="text-left text-primary underline-offset-2 hover:underline" onClick={() => setExpanded(expanded === e.taskId ? null : e.taskId)}>{e.title}</button>,
        duration(e.completion.expected), t(`usage.${e.confidence}`),
      ] }))} />
    {data.estimates.filter(e => e.taskId === expanded).map(e => <EstimateView key={e.taskId} estimate={e} selection={selection} onApplied={onApplied} refusals={data.candidateRefusals} />)}
  </div>;
}

export function UsageForecastPage({ selectors, lockedProjectPath }: { selectors: Selection; lockedProjectPath?: string }) {
  const [projectPath, project] = useState(lockedProjectPath ?? "");
  useEffect(() => { if (lockedProjectPath) project(lockedProjectPath); }, [lockedProjectPath]);
  const [clusterId, cluster] = useState("");
  const [missionId, mission] = useState("");
  const [taskIds, tasks] = useState<string[]>([]);
  const [projectPaths, setProjects] = useState<string[]>([]);
  const [startAuthorized, setStartAuthorized] = useState(false);
  const [unknownCapacity, setUnknownCapacity] = useState(false);
  const [refillAtReset, setRefill] = useState(false);
  const [release, setRelease] = useState("");
  const [quotaWindows, setQuotaWindows] = useState<QuotaPlanningWindow[]>([]);
  const [poolId, setPool] = useState("");
  const [starts, setStarts] = useState("");
  const [ends, setEnds] = useState("");
  const [allowance, setAllowance] = useState("");
  const [submitted, setSubmitted] = useState<ForecastSelection>({});
  const [concurrency, setConcurrency] = useState("1");
  const [data, setData] = useState<Forecast | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  async function estimate() {
    setBusy(true);
    setError("");
    setData(null);
    try {
      const assumptions = { startAuthorized, unknownCapacity, refillAtReset, quotaWindows, activeReleaseMs: release === "" ? undefined : Math.round(Number(release) * 60_000) };
      const selection: ForecastSelection = missionId ? { missionId, save: true, assumptions } : {
        projectPath: lockedProjectPath || projectPath || undefined, projectPaths: lockedProjectPath ? undefined : projectPaths.length ? projectPaths : undefined,
        clusterId: clusterId || undefined, taskIds: taskIds.length ? taskIds : undefined,
        concurrency: Number(concurrency), save: true, assumptions,
      };
      setData(await api.usageForecast(selection));
      setSubmitted(selection);
    } catch (cause) {
      setError(String(cause instanceof Error ? cause.message : cause));
    } finally {
      setBusy(false);
    }
  }
  return <div className="space-y-4">
    <div className="grid gap-3 rounded-md border bg-card p-3 sm:grid-cols-2 lg:grid-cols-4">
      <Picker label={t("usage.mission")} value={missionId} options={selectors.missions.filter(m => m.approved)} onChange={mission} />
      {!missionId && <>
        {lockedProjectPath
          ? <p className="self-end text-sm" data-testid="usage-forecast-project">{t("analytics.project.scope", { project: selectors.projects.find((item) => item.id === lockedProjectPath)?.label ?? lockedProjectPath })}</p>
          : <Picker label={t("usage.project")} value={projectPath} options={selectors.projects} onChange={project} />}
        <Picker label={t("usage.cluster")} value={clusterId} options={selectors.clusters} onChange={cluster} />
        <label className="space-y-1 text-xs text-muted-foreground">{t("usage.concurrency")}
          <Input type="number" min={1} max={32} value={concurrency} onChange={e => setConcurrency(e.target.value)} />
        </label>
      </>}
    </div>
    {!missionId && !lockedProjectPath && selectors.projects.length > 1 && <details className="rounded-md border p-3">
      <summary className="cursor-pointer text-sm font-medium">{t("usage.projects")} · {projectPaths.length}</summary>
      <div className="mt-2 grid max-h-40 gap-1 overflow-auto sm:grid-cols-2">{selectors.projects.map(p => <label key={p.id} className="flex items-center gap-2 text-sm">
        <input type="checkbox" checked={projectPaths.includes(p.id)} onChange={e => setProjects(ids => e.target.checked ? [...ids, p.id] : ids.filter(id => id !== p.id))} />{p.label}
      </label>)}</div>
    </details>}
    <fieldset className="space-y-2 rounded-md border p-3 text-sm">
      <label className="flex items-center gap-2"><input type="checkbox" checked={startAuthorized} onChange={e => setStartAuthorized(e.target.checked)} />{t("usage.startAssumption")}</label>
      <label className="flex items-center gap-2"><input type="checkbox" checked={unknownCapacity} onChange={e => setUnknownCapacity(e.target.checked)} />{t("usage.unknownCapacityAssumption")}</label>
      <label className="flex items-center gap-2"><input type="checkbox" checked={refillAtReset} onChange={e => setRefill(e.target.checked)} />{t("usage.resetAssumption")}</label>
      <label className="block max-w-sm text-xs">{t("usage.activeRelease")}<Input type="number" min={0} max={10080} value={release} onChange={e => setRelease(e.target.value)} /></label>
      {data?.capacity.rows.some(pool => pool.evidence === "verified") && <details className="space-y-2">
        <summary>{t("usage.assumedWindows")}</summary>
        <p className={notesClass}>{t("usage.assumedWindowsNote")}</p>
        <div className="grid gap-2 sm:grid-cols-2">
          <Picker label={t("usage.selectPool")} value={poolId} onChange={setPool}
            options={data.capacity.rows.filter(pool => pool.evidence === "verified").map(pool => ({
              id: pool.id, label: `${pool.window} · ${pool.unit.kind} · ${pool.accountIds.join(", ")}`,
            }))} />
          <label className={notesClass}>{t("usage.assumedAllowance")}<Input type="number" min={1} step={1} value={allowance} onChange={e => setAllowance(e.target.value)} /></label>
          <label className={notesClass}>{t("usage.assumedWindowStart")}<Input type="datetime-local" value={starts} onChange={e => setStarts(e.target.value)} /></label>
          <label className={notesClass}>{t("usage.assumedWindowEnd")}<Input type="datetime-local" value={ends} onChange={e => setEnds(e.target.value)} /></label>
        </div>
        <Button size="sm" variant="outline" disabled={!poolId || !starts || !ends || Number(allowance) < 1 || quotaWindows.length >= 8}
          onClick={() => setQuotaWindows(windows => [...windows, { poolId, startsAt: Date.parse(starts), endsAt: Date.parse(ends), allowance: Number(allowance) }])}>
          {t("usage.assumedWindowAdd")}
        </Button>
      </details>}
      {quotaWindows.map((window, index) => <div className="flex items-center gap-2" key={index}>
        <span className={notesClass}>{data?.capacity.rows.find(pool => pool.id === window.poolId)?.window ?? window.poolId}
          {" · "}{date(window.startsAt)} – {date(window.endsAt)} · {number(window.allowance)}</span>
        <Button size="sm" variant="ghost" onClick={() => setQuotaWindows(windows => windows.filter((_, at) => at !== index))}>{t("usage.assumedWindowRemove")}</Button>
      </div>)}
    </fieldset>
    {!missionId && selectors.backlog.length > 0 && <details className="rounded-md border p-3">
      <summary className="cursor-pointer text-sm font-medium">{t("usage.backlog")} · {taskIds.length ? number(taskIds.length) : t("usage.all")}</summary>
      <div className="mt-2 grid max-h-56 gap-1 overflow-auto sm:grid-cols-2">
        {selectors.backlog.map(task => <label key={task.id} className="flex items-center gap-2 text-sm">
          <input type="checkbox" checked={taskIds.includes(task.id)} onChange={e => tasks(ids => e.target.checked ? [...ids, task.id] : ids.filter(id => id !== task.id))} />
          <span>{task.label}</span>
        </label>)}
      </div>
    </details>}
    <Button disabled={busy} onClick={() => void estimate()}>{t("usage.estimate")}</Button>
    {busy && <p role="status">{t("usage.loading")}</p>}
    {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
    {data && <PortfolioForecast data={data} selection={submitted} onApplied={() => void estimate()} />}
  </div>;
}
