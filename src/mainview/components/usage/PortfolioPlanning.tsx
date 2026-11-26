import { t, type TranslationKey } from "@/i18n/core";
import type { api } from "@/lib/api";
import { date, duration, money, notesClass, number, unknown } from "./presentation";

type Forecast = Awaited<ReturnType<typeof api.usageForecast>>;
type Constraint = NonNullable<Forecast["constraints"][number]["first"]>;
type Comparison = NonNullable<Forecast["comparison"]>;
type Unit = Forecast["capacity"]["rows"][number]["unit"];
const key = (value: string) => value as TranslationKey;
const scenarios = ["optimistic", "expected", "conservative"] as const;

/** A pool's demand is in its own typed unit. Money pools are recorded in minor units (for example cents). */
export function unitText(unit: Unit): string {
  return "currency" in unit ? `${unit.currency} · ${t("portfolio.minorUnits")}` : "name" in unit ? `${unit.kind} · ${unit.name}` : unit.kind;
}

export function slotLabel(resource: string): string {
  const [kind] = resource.split("/");
  const labels: Record<string, TranslationKey> = {
    global: "portfolio.slot.global", project: "portfolio.slot.project", account: "portfolio.slot.account", provider: "portfolio.slot.provider",
    specialist: "portfolio.slot.specialist", cluster: "portfolio.slot.cluster", "local-testing": "portfolio.slot.testing", "unknown-account": "portfolio.slot.unknownAccount",
  };
  return t(labels[kind!] ?? "portfolio.slot.other");
}

export const stageLabel = (kind: string | null): string => {
  const labels: Record<string, TranslationKey> = {
    developer: "usage.developer", preparation: "usage.stagePreparation", testing: "usage.testing", reviewer: "usage.reviewer", rework: "usage.rework",
    retesting: "usage.stageRetesting", "final-review": "usage.stageFinalReview", completion: "usage.stageCompletion",
  };
  return kind && labels[kind] ? t(labels[kind]) : "";
};

const poolDemand = (value: number | null, unit: Unit) => value === null ? unknown() : `${number(value)} (${unitText(unit)})`;

export function constraintText(constraint: Constraint): string {
  const label = stageLabel(constraint.stageKind);
  const stage = label ? `${label}: ` : "";
  const tasks = constraint.waitingOn.map(row => row.title ?? row.taskId).join(", ");
  switch (constraint.kind) {
    case "project-hold": return t("portfolio.constraint.projectHold", { state: constraint.reason ?? "" });
    case "owner-decision": return t("portfolio.constraint.ownerDecision", { tasks });
    case "dependency": return t("portfolio.constraint.dependency", { tasks });
    case "dependency-outside": return t("portfolio.constraint.dependencyOutside");
    case "resource-evidence": return t("portfolio.constraint.resourceEvidence");
    case "busy-slot": return t("portfolio.constraint.busySlot", { resources: constraint.resources.map(slotLabel).join(", ") });
    case "quota-unknown": return constraint.pool
      ? t("portfolio.constraint.quotaUnknownPool", { stage })
      : t("portfolio.constraint.quotaUnknownNone", { stage });
    case "quota-shortfall": {
      const pool = constraint.pool!;
      return t("portfolio.constraint.quotaShortfall", {
        stage, demand: poolDemand(pool.knownDemand, pool.unit), remaining: poolDemand(pool.remaining, pool.unit), shortfall: poolDemand(pool.shortfall, pool.unit),
      });
    }
  }
}

/** The first meaningful constraint on each selected task, read from the scheduler and capacity results. */
export function ConstraintsPanel({ data }: { data: Forecast }) {
  const first = data.firstConstraint;
  const title = first ? data.estimates.find(estimate => estimate.taskId === first.taskId)?.title ?? first.taskId : null;
  return <section className="space-y-2" data-testid="forecast-constraints" data-first-task={first?.taskId ?? ""} data-first-kind={first?.kind ?? ""}>
    <h3 className="text-sm font-semibold">{t("portfolio.constraints")}</h3>
    <p className="text-sm text-warning" data-testid="forecast-boundary">{t("portfolio.boundary")}</p>
    {first && title && <p className="text-sm font-medium" data-testid="forecast-first-constraint">{t("portfolio.firstConstraint", { task: title })} {t(key(`portfolio.kind.${first.kind}`))}</p>}
    {!first && data.estimates.length > 0 && <p className={notesClass} data-testid="forecast-first-constraint">{t("portfolio.noResourceConstraint")}</p>}
    <div className="overflow-x-auto rounded-md border">
      <table className="w-full min-w-[30rem] text-left text-xs">
        <thead className="bg-muted/60 text-muted-foreground"><tr>
          <th scope="col" className="px-3 py-2 font-medium">{t("usage.task")}</th>
          <th scope="col" className="px-3 py-2 font-medium">{t("portfolio.firstConstraintColumn")}</th>
          <th scope="col" className="px-3 py-2 font-medium">{t("portfolio.alsoColumn")}</th>
        </tr></thead>
        <tbody>{data.constraints.map(item => <tr key={item.taskId} className="border-t align-top" data-testid="forecast-constraint-row"
          data-task-id={item.taskId} data-kind={item.first?.kind ?? "none"}>
          <th scope="row" className="px-3 py-2 text-left font-medium">{item.title}</th>
          <td className="px-3 py-2" data-testid="forecast-constraint-first">{item.first
            ? <><span className="font-medium">{t(key(`portfolio.kind.${item.first.kind}`))}</span>
              <small className="block text-muted-foreground">{constraintText(item.first)}</small></>
            : <span className="text-muted-foreground">{t("portfolio.noConstraint")}</span>}</td>
          <td className="px-3 py-2 text-muted-foreground" data-testid="forecast-constraint-also">{item.also.length
            ? item.also.map(row => <small className="block" key={row.kind}>{t(key(`portfolio.kind.${row.kind}`))}</small>)
            : "—"}</td>
        </tr>)}</tbody>
      </table>
    </div>
  </section>;
}

const signed = (value: number, format: (n: number) => string) => `${value > 0 ? "+" : value < 0 ? "−" : ""}${format(Math.abs(value))}`;
const resourceText = (resource: Comparison["current"]) => resource
  ? [resource.harnessLabel, resource.accountLabel ?? unknown(), resource.modelId, resource.mode].join(" · ") : unknown();
const rangeText = (range: Record<typeof scenarios[number], number> | null, format: (n: number) => string = duration) =>
  range ? scenarios.map(k => format(range[k])).join(" / ") : unknown();

/** Current allocation versus one explicit alternative. Read-only: it starts nothing and selects nothing. */
export function AlternativeComparison({ comparison, reasonText }: { comparison: Comparison; reasonText: (reason: string) => string }) {
  const row = (id: string, label: string, current: React.ReactNode, proposed: React.ReactNode, difference: React.ReactNode, reason?: string | null) =>
    <tr className="border-t align-top" key={id} data-testid={`alternative-row-${id}`}>
      <th scope="row" className="px-3 py-2 text-left font-medium">{label}</th>
      <td className="px-3 py-2 tabular-nums" data-testid={`alternative-${id}-current`}>{current}</td>
      <td className="px-3 py-2 tabular-nums" data-testid={`alternative-${id}-proposed`}>{proposed}</td>
      <td className="px-3 py-2" data-testid={`alternative-${id}-difference`}>{reason ? <span className="text-muted-foreground" data-reason={reason}>{t(key(`portfolio.reason.${reason}`))}</span> : difference}</td>
    </tr>;
  const assumed = [
    comparison.assumptions.startAuthorized && t("usage.startAssumption"),
    comparison.assumptions.unknownCapacity && t("usage.unknownCapacityAssumption"),
    comparison.assumptions.refillAtReset && t("usage.resetAssumption"),
    !!comparison.assumptions.quotaWindows?.length && `${t("usage.assumedWindows")} · ${comparison.assumptions.quotaWindows.length}`,
    comparison.assumptions.activeReleaseMs !== undefined && `${t("usage.activeRelease")} · ${duration(comparison.assumptions.activeReleaseMs)}`,
  ].filter(Boolean);
  const changed = Object.entries(comparison.changed).filter(([, on]) => on).map(([name]) => t(key(`portfolio.changed.${name}`)));
  const completion = comparison.completionWindow;
  const cost = comparison.cost;
  const costText = (totals: typeof cost.current) => totals.length ? totals.map(item => `${t(key(`usage.${item.kind}`))} ${money(item)}`).join(" · ") : unknown();
  return <section className="space-y-3" data-testid="alternative-comparison">
    <h4 className="font-semibold">{t("portfolio.comparison", { task: comparison.title })}</h4>
    <div className="grid gap-2 sm:grid-cols-2">
      <div className="rounded-md border px-3 py-2"><p className="text-xs text-muted-foreground">{t("portfolio.currentAllocation")}</p>
        <p className="break-words font-medium" data-testid="alternative-current-resource">{resourceText(comparison.current)}</p></div>
      <div className="rounded-md border px-3 py-2"><p className="text-xs text-muted-foreground">{t("portfolio.proposedAllocation")}</p>
        <p className="break-words font-medium" data-testid="alternative-proposed-resource">{resourceText(comparison.proposed)}</p></div>
    </div>
    <p className={notesClass} data-testid="alternative-changed">{t("portfolio.changed")} · {changed.length ? changed.join(", ") : t("portfolio.nothingChanged")}</p>
    <div className="overflow-x-auto rounded-md border">
      <table className="w-full min-w-[34rem] text-left text-xs">
        <thead className="bg-muted/60 text-muted-foreground"><tr>
          <th scope="col" className="px-3 py-2 font-medium">{t("comparison.col.measure")}</th>
          <th scope="col" className="px-3 py-2 font-medium">{t("portfolio.currentAllocation")}</th>
          <th scope="col" className="px-3 py-2 font-medium">{t("portfolio.proposedAllocation")}</th>
          <th scope="col" className="px-3 py-2 font-medium">{t("comparison.col.delta")}</th>
        </tr></thead>
        <tbody>
          {row("elapsed", t("usage.constrained"), rangeText(comparison.elapsed.current), rangeText(comparison.elapsed.proposed),
            comparison.elapsed.delta === null ? null : signed(comparison.elapsed.delta, duration), comparison.elapsed.reason)}
          {row("wait", t("usage.resourceWait"), rangeText(comparison.resourceWait.current), rangeText(comparison.resourceWait.proposed),
            comparison.resourceWait.delta === null ? null : signed(comparison.resourceWait.delta, duration), comparison.resourceWait.reason)}
          {row("completion", t("usage.finishWindow"), rangeText(completion.current, date), rangeText(completion.proposed, date), null,
            completion.current && completion.proposed ? null : "completion-unresolved")}
          {row("bottlenecks", t("usage.bottlenecks"), comparison.bottlenecks.current.map(slotLabel).join(", ") || "—",
            comparison.bottlenecks.proposed.map(slotLabel).join(", ") || "—", null)}
          {row("cost", t("usage.cost"), costText(cost.current), costText(cost.proposed),
            cost.delta ? signed(cost.delta.amount, amount => money({ amount, currency: cost.delta!.currency })) : null, cost.delta ? null : cost.reason)}
          {comparison.pools.map(pool => row(`pool-${pool.id}`, `${pool.window} · ${unitText(pool.unit)}${pool.shared ? ` · ${t("usage.quotaShared")}` : ""}`,
            pool.current ? <PoolSide side={pool.current} unit={pool.unit} /> : t("portfolio.poolNotCharged"),
            pool.proposed ? <PoolSide side={pool.proposed} unit={pool.unit} /> : t("portfolio.poolNotCharged"),
            pool.knownDemandDelta === null ? null : <>{signed(pool.knownDemandDelta, n => poolDemand(n, pool.unit))}<small className="block text-muted-foreground">{t("portfolio.knownOnly")}</small></>,
            pool.knownDemandDelta === null ? "no-pool-baseline" : null))}
        </tbody>
      </table>
    </div>
    {completion.blockers.length > 0 && <p className={notesClass} data-testid="alternative-completion-blockers">{t("portfolio.completionBlockedBy")} · {completion.blockers.map(reasonText).join(" · ")}</p>}
    {assumed.length > 0 && <p className="text-xs text-warning" data-testid="alternative-assumptions">{t("portfolio.assumedNotMeasured")} · {assumed.join(" · ")}</p>}
    <div className="space-y-1" data-testid="alternative-affected">
      <p className="text-sm font-medium">{t("portfolio.affected")}</p>
      {comparison.affected.map(item => <p key={item.taskId} className="text-xs" data-testid="alternative-affected-task" data-task-id={item.taskId}>
        <span className="font-medium">{item.title}</span>
        {" · "}{item.why.map(reason => t(key(`portfolio.why.${reason}`))).join(", ")}
        {" · "}{item.current ? t(key(`portfolio.kind.${item.current.kind}`)) : t("portfolio.noConstraint")} → {item.proposed ? t(key(`portfolio.kind.${item.proposed.kind}`)) : t("portfolio.noConstraint")}
      </p>)}
    </div>
    <p className={notesClass}>{t("portfolio.previewBoundary")}</p>
  </section>;
}

function PoolSide({ side, unit }: { side: NonNullable<Comparison["pools"][number]["current"]>; unit: Unit }) {
  return <span>{t(side.status === "insufficient" ? "usage.poolShortfall" : key(`usage.${side.status}`))}
    <small className="block text-muted-foreground">{t("usage.remaining")} {poolDemand(side.remaining, unit)} · {t("usage.poolDemand")} {poolDemand(side.knownDemand, unit)}</small>
    <small className="block text-muted-foreground">{t("usage.poolCoverage")} · {number(side.unknownStages)}</small>
    {side.shortfall !== null && <small className="block text-warning">{t("portfolio.shortBy", { amount: poolDemand(side.shortfall, unit) })}</small>}</span>;
}
