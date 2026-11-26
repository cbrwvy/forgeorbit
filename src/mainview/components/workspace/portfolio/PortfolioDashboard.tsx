import { availabilityText, quotaOriginText } from "@/lib/status-presenters";
import { shortenPath } from "@/lib/path-display";
import { PageHeader } from "../PageHeader";
import { codeLabel } from "@/i18n/presentation";
import { intlLocale, t as tr } from "@/i18n/core";

import { I18nText, useLocale as useUILocale } from "@/i18n/react";
/**
 * Global portfolio dashboard (FO-008B).
 *
 * Displays `GET /portfolio/analysis`. What-if recalculates a copy with
 * `analyzeWhatIf` and is not saved. There is no control that starts an
 * agent, switches an account, or edits a project.
 *
 * Head settings and historical approvals remain available from Portfolio.
 */

import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from "react";
import { api } from "@/lib/api";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { subscribePortfolioRefresh } from "@/lib/portfolio-events";
import {
  attentionLinks,
  buildWhatIfPatch,
  type AttentionLink,
  comparisonRows,
  environmentPhaseLabel,
  filterComparison,
  formatCount,
  formatMinor,
  formatPortfolioDuration,
  formatPortfolioMoney,
  isCurrentPortfolioRequest,
  isPortfolioRefreshEvent,
  sortComparison,
  type PortfolioFilter,
  type PortfolioSort,
  type WhatIfDraft,
} from "@/lib/portfolio";
import { analyzeWhatIf, type PortfolioAnalysis, type PortfolioSnapshotInput, type ProjectSummary } from "../../../../shared/portfolio/index.ts";

import type { TaskPriority } from "../../../../shared/task-scheduling.ts";
import type { ProjectSurfacePage } from "@/lib/workspace";
import { PortfolioManagerPanel } from "./PortfolioManagerPanel";
import { PortfolioProposalSummary } from "./PortfolioProposalSummary";
import { PortfolioRouterPreview } from "../../router/PortfolioRouterPreview";

interface Props {
  onOpenHead: () => void;
  initialTab?: "overview" | "manager";
  onOpenProject: (path: string, page: ProjectSurfacePage) => void;
  onOpenTask: (taskId: string) => void;
  onOpenSettingsAgents?: () => void;
  onOpenAccounts?: () => void;
  onOpenBrowser?: () => void;
  onOpenNativeComputer?: () => void;
}

type PortfolioTab = "overview" | "manager";
const TABS: { id: PortfolioTab; label: string }[] = [
  { id: "overview", get label() { return tr("common.overview"); } },
  { id: "manager", get label() { return tr("headPm.unified.settings"); } },
];

interface Payload {
  analysis: PortfolioAnalysis;
  snapshot: PortfolioSnapshotInput;
  adapterWarnings: string[];
  capturedAtMs: number;
  accountResources?: import("@/lib/account-api").AccountResources;
}

const PRIORITIES: Array<TaskPriority | ""> = ["", "critical", "high", "normal", "low"];

export function PortfolioDashboard({ onOpenHead, initialTab = "overview", onOpenProject, onOpenTask, onOpenSettingsAgents, onOpenAccounts, onOpenBrowser, onOpenNativeComputer }: Props) {
  const { locale: uiLocale } = useUILocale();
  const [tab, setTab] = useState<PortfolioTab>(initialTab);
  const tabRefs = useRef<Record<PortfolioTab, HTMLButtonElement | null>>({ overview: null, manager: null });
  const onTabKey = (event: KeyboardEvent<HTMLButtonElement>) => {
    if (event.key !== "ArrowRight" && event.key !== "ArrowLeft" && event.key !== "Home" && event.key !== "End") return;
    event.preventDefault();
    const at = TABS.findIndex((item) => item.id === tab);
    const next = event.key === "Home" ? 0 : event.key === "End" ? TABS.length - 1 : (at + (event.key === "ArrowRight" ? 1 : -1) + TABS.length) % TABS.length;
    const id = TABS[next]!.id;
    setTab(id);
    tabRefs.current[id]?.focus();
  };
  const [payload, setPayload] = useState<Payload | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [sort, setSort] = useState<PortfolioSort>("name");
  const [filter, setFilter] = useState<PortfolioFilter>("all");
  const [draft, setDraft] = useState<WhatIfDraft>({ excludedProjectIds: [], priorities: [], concurrency: [] });

  useEffect(() => {
    const seq = { current: 0 };
    let timer: ReturnType<typeof setTimeout> | null = null;
    let disposed = false;
    const load = () => {
      const requestId = ++seq.current;
      setRefreshing(true);
      void api.getPortfolioAnalysis().then((body) => {
        if (disposed || !isCurrentPortfolioRequest(requestId, seq.current)) return;
        setPayload(body);
        setError(null);
      }).catch((err: unknown) => {
        if (disposed || !isCurrentPortfolioRequest(requestId, seq.current)) return;
        setError(err instanceof Error ? err.message : tr("common.portfolio_data_could_not_be_loaded"));
      }).finally(() => {
        if (disposed || !isCurrentPortfolioRequest(requestId, seq.current)) return;
        setLoading(false);
        setRefreshing(false);
      });
    };
    const schedule = () => {
      if (timer) clearTimeout(timer);
      timer = setTimeout(load, 400);
    };
    load();
    const unsubscribe = subscribePortfolioRefresh((reason) => {
      if (isPortfolioRefreshEvent(reason)) schedule();
    });
    const onFocus = () => schedule();
    const onVisible = () => {
      if (document.visibilityState === "visible") schedule();
    };
    const onRefresh = () => schedule();
    window.addEventListener("focus", onFocus);
    window.addEventListener("portfolio-refresh", onRefresh);
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      disposed = true;
      seq.current += 1;
      if (timer) clearTimeout(timer);
      unsubscribe();
      window.removeEventListener("focus", onFocus);
      window.removeEventListener("portfolio-refresh", onRefresh);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, []);

  const patch = useMemo(() => buildWhatIfPatch(draft), [draft, uiLocale]);
  const view = useMemo(() => {
    if (!payload) return null;
    if (!patch) return { analysis: payload.analysis, note: null as string | null };
    const next = analyzeWhatIf(payload.snapshot, patch);
    return { analysis: next.analysis, note: next.notes[0] ?? tr("common.what_if_changed_a_copy") };
  }, [payload, patch, uiLocale]);

  const rows = useMemo(() => {
    if (!view?.analysis.aggregate) return [];
    return sortComparison(filterComparison(comparisonRows(view.analysis), filter, view.analysis.aggregate.attentionProjectIds), sort);
  }, [view, filter, sort, uiLocale]);

  return (
    <div className={cn("flex min-h-0 min-w-0 flex-1 flex-col", tab === "overview" ? "overflow-y-auto" : "overflow-hidden")} data-testid="portfolio-dashboard">
      <PageHeader
        sticky
        title={<I18nText id="common.portfolio" />}
        subtitle={tab === "overview"
          ? tr("common.read_only_view_across_registered_projects_recommendations_are")
          : tr("common.ask_about_every_project_at_once_plans_and")}
      >
        {onOpenAccounts && <Button type="button" variant="outline" size="sm" onClick={onOpenAccounts}><I18nText id="common.accounts_resources" /></Button>}
        <div role="tablist" aria-label={tr("common.portfolio")} className="ds-tabs">
          {TABS.map((item) => (
            <button
              key={item.id}
              ref={(node) => { tabRefs.current[item.id] = node; }}
              type="button"
              role="tab"
              id={`portfolio-tab-${item.id}`}
              aria-selected={tab === item.id}
              aria-controls={`portfolio-panel-${item.id}`}
              tabIndex={tab === item.id ? 0 : -1}
              onClick={() => setTab(item.id)}
              onKeyDown={onTabKey}
              className={cn("glass-nav-item ds-tab", tab === item.id && "glass-selected")}
              data-testid={`portfolio-tab-${item.id}`}
            >
              {item.label}
            </button>
          ))}
        </div>
        {tab === "overview" && (
          <div className="flex items-center gap-2">
            {refreshing && <span className="text-xs text-muted-foreground"><I18nText id="portfolio.updating" /></span>}
            <Button type="button" variant="ghost" size="sm" data-testid="portfolio-refresh" onClick={() => window.dispatchEvent(new Event("portfolio-refresh"))}><I18nText id="common.refresh" />{" "}</Button>
          </div>
        )}
      </PageHeader>

      {tab === "manager" ? (
        <div role="tabpanel" id="portfolio-panel-manager" aria-labelledby="portfolio-tab-manager" className="flex min-h-0 min-w-0 flex-1 flex-col">
          <PortfolioManagerPanel
            onOpenHead={onOpenHead}
            onOpenProject={(path) => onOpenProject(path, "board")}
            onOpenProjectManager={(path) => onOpenProject(path, "manager")}
            onOpenSettingsAgents={onOpenSettingsAgents ?? (() => {})}
            onOpenBrowser={onOpenBrowser}
            onOpenNativeComputer={onOpenNativeComputer}
          />
        </div>
      ) : (
      <div role="tabpanel" id="portfolio-panel-overview" aria-labelledby="portfolio-tab-overview" className="flex w-full min-w-0 flex-col gap-6 px-4 py-4">
        <PortfolioProposalSummary onOpenProject={(path) => onOpenProject(path, "overview")} />
        {loading && !payload && <p className="text-sm text-muted-foreground" data-testid="portfolio-loading"><I18nText id="portfolio.loading_portfolio" /></p>}
        {error && (
          <p className="rounded-lg border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm" role="alert" data-testid="portfolio-error">
            {error}
          </p>
        )}
        {payload && view?.analysis.aggregate && (
          <DashboardBody
            payload={payload}
            analysis={view.analysis}
            whatIfNote={view.note}
            rows={rows}
            sort={sort}
            filter={filter}
            draft={draft}
            onSort={setSort}
            onFilter={setFilter}
            onDraft={setDraft}
            onOpenProject={onOpenProject}
            onOpenTask={onOpenTask}
          />
        )}
        {payload && view && !view.analysis.ok && (
          <p className="text-sm" role="alert" data-testid="portfolio-rejected">
            {view.analysis.issues.find((issue) => issue.severity === "error")?.message ?? tr("common.the_portfolio_snapshot_was_rejected")}
          </p>
        )}
      </div>
      )}
    </div>
  );
}

function DashboardBody({
  payload,
  analysis,
  whatIfNote,
  rows,
  sort,
  filter,
  draft,
  onSort,
  onFilter,
  onDraft,
  onOpenProject,
  onOpenTask,
}: {
  payload: Payload;
  analysis: PortfolioAnalysis;
  whatIfNote: string | null;
  rows: ReturnType<typeof comparisonRows>;
  sort: PortfolioSort;
  filter: PortfolioFilter;
  draft: WhatIfDraft;
  onSort: (sort: PortfolioSort) => void;
  onFilter: (filter: PortfolioFilter) => void;
  onDraft: (draft: WhatIfDraft) => void;
  onOpenProject: Props["onOpenProject"];
  onOpenTask: Props["onOpenTask"];
}) {
  useUILocale();
  const aggregate = analysis.aggregate;
  if (!aggregate) return null;
  const links = attentionLinks(analysis);
  const empty = aggregate.projectCount === 0;

  return (
    <>
      <p className="text-xs text-muted-foreground" data-testid="portfolio-captured" data-captured={payload.capturedAtMs}><I18nText id="common.observed" />{" "}{new Date(payload.capturedAtMs).toLocaleString(intlLocale())}
        {aggregate.staleProjectCount > 0 ? tr("common.stale", { p0: String(aggregate.staleProjectCount) }) : ""}
        {aggregate.unprovenProjectCount > 0 ? tr("common.not_current", { p0: String(aggregate.unprovenProjectCount) }) : ""}
        {analysis.completeness?.status === "partial" ? tr("common.partial_7af3c6") : ""}
        {analysis.completeness?.status === "unknown" ? tr("common.unknown_coverage") : ""}
      </p>
      {whatIfNote && (
        <p className="rounded-lg border border-border bg-muted/40 px-3 py-2 text-sm" data-testid="portfolio-what-if-note">
          {whatIfNote}{" "}<I18nText id="portfolio.this_is_not_saved_and_running_agents_are" />{" "}<button type="button" className="ml-2 underline" data-testid="portfolio-what-if-reset" onClick={() => onDraft({ excludedProjectIds: [], priorities: [], concurrency: [] })}><I18nText id="common.reset" />{" "}</button>
        </p>
      )}
      {payload.adapterWarnings.length > 0 && (
        <ul className="flex flex-col gap-1 text-xs text-muted-foreground" data-testid="portfolio-warnings">
          {payload.adapterWarnings.slice(0, 8).map((warning) => <li key={warning}>{warning}</li>)}
        </ul>
      )}

      <section aria-label={tr("portfolio.portfolio_overview")} className="grid grid-cols-2 gap-2 md:grid-cols-4 xl:grid-cols-8">
        <Metric label={tr("common.projects")} value={String(aggregate.projectCount)} testId="portfolio-metric-projects" />
        <Metric label={tr("common.active_projects")} value={String(aggregate.activeProjectIds.length)} testId="portfolio-metric-active" />
        <Metric label={tr("common.tasks_b3a60e")} value={formatCount(aggregate.taskCount)} testId="portfolio-metric-tasks" title={aggregate.taskCount.note} />
        <Metric label={tr("common.active_runs")} value={formatCount(aggregate.activeRunCount)} testId="portfolio-metric-runs" title={aggregate.activeRunCount.note} />
        <Metric label={tr("common.waiting_for_review")} value={formatCount(aggregate.reviewCount)} testId="portfolio-metric-review" title={aggregate.reviewCount.note} />
        <Metric label={tr("portfolio.blocked_tasks")} value={formatCount(aggregate.blockedCount)} testId="portfolio-metric-blocked" title={aggregate.blockedCount.note} />
        <Metric label={tr("portfolio.paused_batches")} value={formatCount(aggregate.pausedBatchCount)} testId="portfolio-metric-paused" title={aggregate.pausedBatchCount.note} />
        <Metric label={tr("portfolio.need_attention")} value={String(aggregate.attentionProjectIds.length)} testId="portfolio-metric-attention" />
      </section>

      {empty && (
        <p className="rounded-xl border border-dashed px-4 py-8 text-center text-sm text-muted-foreground" data-testid="portfolio-empty"><I18nText id="portfolio.no_registered_projects_add_one_from_the_sidebar" />{" "}</p>
      )}

      <section aria-label={tr("portfolio.project_cards")} className="grid grid-cols-1 gap-3 lg:grid-cols-2">
        {payload.analysis.projects.map((project) => (
          <ProjectCard
            key={project.projectId}
            project={project}
            signals={payload.analysis.health.find((item) => item.projectId === project.projectId)?.signals ?? []}
            snapshot={payload.snapshot}
            excluded={draft.excludedProjectIds.includes(project.projectId)}
            priority={draft.priorities.find((item) => item.projectId === project.projectId)?.priority ?? ""}
            onExclude={(excluded) => onDraft({
              ...draft,
              excludedProjectIds: excluded
                ? [...draft.excludedProjectIds, project.projectId]
                : draft.excludedProjectIds.filter((id) => id !== project.projectId),
            })}
            onPriority={(priority) => onDraft({
              ...draft,
              priorities: [
                ...draft.priorities.filter((item) => item.projectId !== project.projectId),
                ...(priority ? [{ projectId: project.projectId, priority }] : []),
              ],
            })}
            onOpenProject={onOpenProject}
            onOpenTask={onOpenTask}
          />
        ))}
      </section>

      <section aria-label={tr("portfolio.attention_required")} className="flex flex-col gap-2" data-testid="portfolio-attention">
        <h2 className="text-sm font-semibold"><I18nText id="portfolio.attention_required" /></h2>
        {links.length === 0 && <p className="text-sm text-muted-foreground"><I18nText id="portfolio.nothing_in_the_current_snapshot_needs_attention" /></p>}
        <ul className="flex flex-col gap-2">
          {links.map((link) => (
            <li key={link.id} className="glass-surface flex min-w-0 flex-wrap items-center gap-2 rounded-lg border px-3 py-2">
              <div className="min-w-0 flex-1">
                <p className="text-sm font-medium">{link.title}</p>
                <p className="break-words text-xs text-muted-foreground">{link.detail}</p>
              </div>
              {link.page === "portfolio" ? (
                <a href="#portfolio-resources" className="glass-nav-item rounded-md border px-2 py-1 text-xs"><I18nText id="portfolio.view_resources" /></a>
              ) : link.taskId ? (
                <button type="button" className="glass-nav-item rounded-md border px-2 py-1 text-xs" onClick={() => onOpenTask(link.taskId!)}><I18nText id="common.open_task" /></button>
              ) : link.projectId ? (
                <button type="button" className="glass-nav-item rounded-md border px-2 py-1 text-xs" onClick={() => openAttention(link, onOpenProject)}><I18nText id="common.open" />{" "}{link.page}
                </button>
              ) : null}
            </li>
          ))}
        </ul>
      </section>

      <section id="portfolio-resources" aria-label={tr("portfolio.resources")} className="flex flex-col gap-2" data-testid="portfolio-resources">
        <h2 className="text-sm font-semibold"><I18nText id="portfolio.resources" /></h2>
        {payload.analysis.resources.some((item) => item.warnings.includes(UNIDENTIFIED_ACCOUNT_WARNING)) && (
          <p className="text-xs text-muted-foreground" data-testid="portfolio-unidentified-note">{tr("m0.portfolio.unidentifiedOnce")}</p>
        )}
        <ul className="grid grid-cols-1 gap-2 lg:grid-cols-2">
          {payload.snapshot.resources.map((resource) => {
            const view = analysis.resources.find((item) => item.id === resource.id);
            const conflicts = analysis.conflicts.filter((conflict) => conflict.resourceId === resource.id);
            const account = payload.accountResources?.accounts.find(row => row.account.id === resource.accountId);
            return (
              <li key={resource.id} className="min-w-0 rounded-lg border px-3 py-2 text-sm" data-testid="portfolio-resource">
                <p className="font-medium">{resource.harnessId}</p>
                <p className="break-all text-xs text-muted-foreground"><I18nText id="portfolio.account" />{" "}{resource.accountId ?? tr("common.not_identified")}</p>
                <p className="break-all text-xs text-muted-foreground"><I18nText id="portfolio.shared_subscription_identity" />{" "}{account?.subscriptionIds.join(", ") || resource.subscriptionId || tr("common.unknown_inspect_accounts_resources")}</p>
                {account && <p className="text-xs text-muted-foreground"><I18nText id="portfolio.identity_provenance" />{" "}{codeLabel(account.account.provenance)} · {codeLabel(account.account.verification)}</p>}
                <p className="text-xs text-muted-foreground"><I18nText id="portfolio.quota_provenance" />{" "}{quotaOriginText(resource.quotaOrigin)}</p>
                <p className="text-xs"><I18nText id="portfolio.availability" />{" "}{availabilityText(resource.availability.value)}</p>
                <p className="text-xs"><I18nText id="portfolio.occupied_slots" />{" "}{resource.occupiedSlots.value ?? tr("common.unknown")}</p>
                <p className="text-xs"><I18nText id="common.concurrency" />{" "}{resource.concurrencyLimit.value ?? tr("common.unknown")}</p>
                <p className="text-xs"><I18nText id="portfolio.quota" />{" "}{quotaLabel(resource.quota)}</p>
                {view?.warnings.filter((warning) => warning !== UNIDENTIFIED_ACCOUNT_WARNING).map((warning) => <p key={warning} className="text-xs text-muted-foreground">{warning}</p>)}
                {conflicts.map((conflict) => (
                  <p key={conflict.id} className="text-xs">{conflict.class}: {conflict.explanation}</p>
                ))}
                <label className="mt-2 flex items-center gap-2 text-xs"><I18nText id="portfolio.hypothetical_concurrency" />{" "}<input
                    className="w-20 rounded-md border bg-transparent px-2 py-1"
                    inputMode="numeric"
                    aria-label={tr("common.hypothetical_concurrency_for", { p0: String(resource.harnessId) })}
                    data-testid="portfolio-concurrency"
                    value={draft.concurrency.find((item) => item.resourceId === resource.id)?.limit ?? ""}
                    onChange={(event) => {
                      const parsed = Number(event.target.value);
                      onDraft({
                        ...draft,
                        concurrency: [
                          ...draft.concurrency.filter((item) => item.resourceId !== resource.id),
                          ...(Number.isInteger(parsed) && parsed >= 1 ? [{ resourceId: resource.id, limit: parsed }] : []),
                        ],
                      });
                    }}
                  />
                </label>
              </li>
            );
          })}
        </ul>
      </section>

      <section aria-label={tr("common.estimates")} className="flex flex-col gap-2" data-testid="portfolio-estimates">
        <h2 className="text-sm font-semibold"><I18nText id="common.estimates" /></h2>
        <dl className="grid grid-cols-1 gap-2 sm:grid-cols-2 xl:grid-cols-3">
          <EstimateItem label={tr("common.agent_time")} value={formatPortfolioDuration(analysis.estimation?.agent)} note={analysis.estimation?.agent.note} />
          <EstimateItem label={tr("portfolio.portfolio_calendar")} value={calendarText(analysis)} note={analysis.estimation?.calendar.note} />
          <EstimateItem label={tr("common.additional_cash")} value={formatPortfolioMoney(analysis.estimation?.additionalCash)} note={analysis.estimation?.additionalCash.note} />
          <EstimateItem label={tr("common.subscriptions")} value={formatPortfolioMoney(analysis.estimation?.subscriptions)} note={analysis.estimation?.subscriptions.note} />
          <EstimateItem label={tr("portfolio.api_equivalent")} value={formatPortfolioMoney(analysis.estimation?.apiEquivalent)} note={analysis.estimation?.apiEquivalent.note} />
          <EstimateItem label={tr("common.confidence")} value={analysis.estimation?.confidence ?? tr("common.unknown")} note={analysis.estimation?.confidenceNote ?? null} />
        </dl>
      </section>

      <section aria-label={tr("portfolio.recommendations")} className="flex flex-col gap-2" data-testid="portfolio-recommendations">
        <h2 className="text-sm font-semibold"><I18nText id="portfolio.recommendations" /></h2>
        <p className="text-xs text-muted-foreground"><I18nText id="portfolio.proposals_only_nothing_here_changes_a_task_batch" /></p>
        {analysis.proposals.length === 0 && <p className="text-sm text-muted-foreground"><I18nText id="portfolio.no_proposal_for_this_snapshot" /></p>}
        <ul className="flex flex-col gap-2">
          {analysis.proposals.map((proposal) => (
            <li key={proposal.id} className="min-w-0 rounded-lg border px-3 py-2" data-testid="portfolio-proposal">
              <p className="text-sm font-medium">{proposal.actions.map((action) => action.summary).join(" ")}</p>
              <ul className="mt-1 list-disc pl-4 text-xs text-muted-foreground">
                {proposal.rationale.map((line) => <li key={line}>{line}</li>)}
              </ul>
              {proposal.requiredApprovals.length > 0 && (
                <p className="mt-1 text-xs"><I18nText id="portfolio.needs_owner_approval" />{" "}{proposal.requiredApprovals.map((item) => item.reason).join(" ")}</p>
              )}
              <p className="text-xs text-muted-foreground"><I18nText id="portfolio.read_only" />{" "}{proposal.execution}</p>
            </li>
          ))}
        </ul>
      </section>

      <section aria-label={tr("portfolio.project_comparison")} className="flex min-w-0 flex-col gap-2">
        <div className="flex flex-wrap items-center gap-2">
          <h2 className="text-sm font-semibold"><I18nText id="common.comparison" /></h2>
          <label className="text-xs"><I18nText id="portfolio.sort" />{" "}<select className="ml-1 rounded-md border bg-transparent px-2 py-1" data-testid="portfolio-sort" value={sort} onChange={(event) => onSort(event.target.value as PortfolioSort)}>
              <option value="name"><I18nText id="common.name" /></option>
              <option value="tasks"><I18nText id="common.tasks_b3a60e" /></option>
              <option value="runs"><I18nText id="common.active_runs" /></option>
              <option value="blocked"><I18nText id="common.blockers" /></option>
              <option value="review"><I18nText id="portfolio.owner_review" /></option>
              <option value="calendar"><I18nText id="common.calendar" /></option>
              <option value="cash"><I18nText id="common.additional_cash" /></option>
              <option value="confidence"><I18nText id="common.confidence" /></option>
              <option value="conflicts"><I18nText id="common.conflicts" /></option>
            </select>
          </label>
          <label className="text-xs"><I18nText id="portfolio.filter" />{" "}<select className="ml-1 rounded-md border bg-transparent px-2 py-1" data-testid="portfolio-filter" value={filter} onChange={(event) => onFilter(event.target.value as PortfolioFilter)}>
              <option value="all"><I18nText id="common.all_projects" /></option>
              <option value="attention"><I18nText id="common.needs_attention" /></option>
              <option value="review"><I18nText id="common.waiting_for_review" /></option>
              <option value="blocked"><I18nText id="common.blocked" /></option>
              <option value="running"><I18nText id="common.active_runs" /></option>
            </select>
          </label>
        </div>
        <div className="max-w-full overflow-x-auto">
          <table className="w-full min-w-[640px] border-collapse text-left text-xs">
            <caption className="sr-only"><I18nText id="portfolio.comparison_of_registered_projects" /></caption>
            <thead>
              <tr className="border-b text-muted-foreground">
                <th className="py-1 pr-2 font-medium"><I18nText id="common.project_985959" /></th>
                <th className="py-1 pr-2 font-medium"><I18nText id="common.tasks_b3a60e" /></th>
                <th className="py-1 pr-2 font-medium"><I18nText id="common.runs" /></th>
                <th className="py-1 pr-2 font-medium"><I18nText id="common.blocked" /></th>
                <th className="py-1 pr-2 font-medium"><I18nText id="common.review" /></th>
                <th className="py-1 pr-2 font-medium"><I18nText id="common.calendar" /></th>
                <th className="py-1 pr-2 font-medium"><I18nText id="portfolio.cash" /></th>
                <th className="py-1 pr-2 font-medium"><I18nText id="common.confidence" /></th>
                <th className="py-1 font-medium"><I18nText id="common.conflicts" /></th>
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => (
                <tr key={row.project.projectId} className="border-b border-border/60" data-testid="portfolio-comparison-row">
                  <td className="max-w-48 truncate py-1 pr-2" title={row.project.path}>{row.project.name || row.project.path}</td>
                  <td className="py-1 pr-2">{nullable(row.project.taskCount)}</td>
                  <td className="py-1 pr-2">{nullable(row.project.activeRunCount)}</td>
                  <td className="py-1 pr-2">{nullable(row.project.blockedCount)}</td>
                  <td className="py-1 pr-2">{nullable(row.project.reviewCount)}</td>
                  <td className="py-1 pr-2">{row.calendarMs == null ? tr("common.unknown") : formatPortfolioDuration({ status: "known", ms: row.calendarMs, knownMs: row.calendarMs, origin: "estimated", note: null })}</td>
                  <td className="py-1 pr-2">{row.cashMinor == null ? tr("common.unknown") : formatMinor({ currency: row.cashCurrency ?? tr("common.usd"), minor: row.cashMinor })}</td>
                  <td className="py-1 pr-2">{row.confidence ?? tr("common.unknown")}</td>
                  <td className="py-1">{row.conflictCount}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      <PortfolioRouterPreview
        projects={payload.snapshot.projects.map((project) => ({
          path: project.path,
          name: project.name.value,
          tasks: project.tasks
            .filter((task) => !task.archived && task.pipelineParentId == null)
            .map((task) => ({ id: task.id, title: task.title })),
        }))}
      />
    </>
  );
}

function ProjectCard({
  project,
  signals,
  snapshot,
  excluded,
  priority,
  onExclude,
  onPriority,
  onOpenProject,
  onOpenTask,
}: {
  project: ProjectSummary;
  signals: string[];
  snapshot: PortfolioSnapshotInput;
  excluded: boolean;
  priority: TaskPriority | "";
  onExclude: (excluded: boolean) => void;
  onPriority: (priority: TaskPriority | "") => void;
  onOpenProject: Props["onOpenProject"];
  onOpenTask: Props["onOpenTask"];
}) {
  useUILocale();
  const source = snapshot.projects.find((item) => item.id === project.projectId);
  const current = project.freshness === "current" && project.countsAreCurrent;
  const running = source?.tasks.filter((task) => !task.archived && task.column === "running") ?? [];
  const health = project.freshness === "current" ? tr("common.current") : project.freshness === "stale" ? tr("common.stale_not_the_current_state") : tr("common.not_current_faf61c");
  return (
    <article className="glass-surface flex min-w-0 flex-col gap-2 rounded-xl border p-3" data-testid="portfolio-project-card" data-path={project.path}>
      <div className="flex min-w-0 items-start gap-2">
        <h3 className="min-w-0 flex-1 truncate text-sm font-semibold" title={project.name ?? project.path}>{project.name || project.path}</h3>
        <span className="shrink-0 text-xs text-muted-foreground">{health}</span>
      </div>
      <p className="truncate text-xs text-muted-foreground" title={project.path} data-testid="portfolio-project-path">{shortenPath(project.path)}</p>
      {current ? (
        <>
          <p className="text-[length:var(--text-secondary)]">{project.description.value ?? tr("common.description_unknown")}</p>
          {/* The numbers an Owner scans first; the technical detail folds away below. */}
          <dl className="flex flex-wrap gap-x-4 gap-y-1 text-[length:var(--text-secondary)] tabular-nums" data-testid="portfolio-card-stats">
            <div className="flex gap-1"><dt className="text-muted-foreground">{tr("portfolio.tasks").replace(/^[^\p{L}]+/u, "")}</dt><dd>{nullable(project.taskCount)}</dd></div>
            <div className="flex gap-1"><dt className="text-muted-foreground">{tr("portfolio.review").replace(/^[^\p{L}]+/u, "")}</dt><dd>{nullable(project.reviewCount)}</dd></div>
            <div className="flex gap-1"><dt className="text-muted-foreground">{tr("portfolio.blocked").replace(/^[^\p{L}]+/u, "")}</dt><dd>{nullable(project.blockedCount)}</dd></div>
            <div className="flex gap-1"><dt className="text-muted-foreground">{tr("common.runs").replace(/^[^\p{L}]+/u, "")}</dt><dd>{nullable(project.activeRunCount)}</dd></div>
            <div className="flex gap-1"><dt className="text-muted-foreground">{tr("portfolio.paused_batches_16d7c4").replace(/^[^\p{L}]+/u, "")}</dt><dd>{nullable(project.pausedBatchCount)}</dd></div>
          </dl>
          <details className="text-[length:var(--text-secondary)]" data-testid="portfolio-card-details">
            <summary className="cursor-pointer text-muted-foreground">{tr("uxfix.portfolio.details")}</summary>
            <div className="mt-1 space-y-1">
              <p><I18nText id="portfolio.stack" />{" "}{project.stack.value?.join(", ") || (project.stack.origin === "unknown" ? tr("common.unknown") : tr("common.none_detected"))}</p>
              <p><I18nText id="portfolio.signals" />{" "}{signals.join(", ") || tr("common.none")}</p>
              <p><I18nText id="portfolio.environment" />{" "}<span title={project.environmentPhaseNote ?? undefined} data-testid="portfolio-environment-phase" data-freshness={project.environmentPhaseFreshness ?? tr("common.none")}>{environmentPhaseLabel(project.environmentRecordedPhase, project.environmentPhaseObservedAtMs, snapshot.capturedAtMs, snapshot.stalenessAfterMs)}</span></p>
              <p><I18nText id="portfolio.harnesses" />{" "}{project.harnessIds.join(", ") || tr("common.none")}</p>
            </div>
          </details>
          {running.length > 0 && (
            <ul className="text-xs">
              {running.slice(0, 4).map((task) => (
                <li key={task.id}>
                  <button type="button" className="truncate text-left underline" onClick={() => onOpenTask(task.id)}>{task.title}</button>
                </li>
              ))}
            </ul>
          )}
        </>
      ) : (
        <p className="text-xs"><I18nText id="portfolio.this_snapshot_is_not_the_current_state_so" /></p>
      )}
      <div className="flex flex-wrap gap-1">
        <CardLink label={tr("common.project_985959")} page="overview" path={project.path} onOpen={onOpenProject} primary />
        <CardLink label={tr("common.board")} page="board" path={project.path} onOpen={onOpenProject} primary />
        <CardLink label={tr("common.manager")} page="manager" path={project.path} onOpen={onOpenProject} />
        <CardLink label={tr("common.estimates")} page="estimates" path={project.path} onOpen={onOpenProject} />
        <CardLink label={tr("common.environment")} page="environment" path={project.path} onOpen={onOpenProject} />
      </div>
      <div className="flex flex-wrap items-center gap-2 text-xs">
        <label className="flex items-center gap-1">
          <input type="checkbox" data-testid="portfolio-exclude" checked={excluded} onChange={(event) => onExclude(event.target.checked)} /><I18nText id="portfolio.exclude_in_what_if" />{" "}</label>
        <label><I18nText id="portfolio.hypothetical_priority" />{" "}<select className="ml-1 rounded-md border bg-transparent px-1 py-0.5" data-testid="portfolio-priority" value={priority} onChange={(event) => onPriority(event.target.value as TaskPriority | "")}>
            {PRIORITIES.map((item) => <option key={item || "unset"} value={item}>{item || tr("common.unchanged")}</option>)}
          </select>
        </label>
      </div>
    </article>
  );
}

/** Open and Board are the usual next steps (bordered); the rest are quiet links. */
function CardLink({ label, page, path, onOpen, primary = false }: { label: string; page: ProjectSurfacePage; path: string; onOpen: Props["onOpenProject"]; primary?: boolean }) {
  useUILocale();
  return (
    <button type="button" className={cn("glass-nav-item rounded-md px-2 py-1 text-[length:var(--text-secondary)]", primary ? "border font-medium" : "text-muted-foreground")} data-testid={`portfolio-open-${page}`} onClick={() => onOpen(path, page)}>
      {label}
    </button>
  );
}

function Metric({ label, value, testId, title }: { label: string; value: string; testId: string; title?: string | null }) {
  useUILocale();
  return (
    <div className="min-w-0 rounded-lg border px-2 py-2" data-testid={testId} title={title ?? undefined}>
      <p className="truncate text-xs text-muted-foreground">{label}</p>
      <p className="truncate text-sm font-semibold tabular-nums">{value}</p>
    </div>
  );
}

function EstimateItem({ label, value, note }: { label: string; value: string; note?: string | null }) {
  useUILocale();
  return (
    <div className="min-w-0 rounded-lg border px-3 py-2" title={note ?? undefined}>
      <dt className="text-xs text-muted-foreground">{label}</dt>
      <dd className="truncate text-sm font-medium">{value}</dd>
    </div>
  );
}

/** Canonical sentence from `shared/portfolio/resources.ts`; shown once above the list instead of once per resource. */
const UNIDENTIFIED_ACCOUNT_WARNING = "The account behind this harness is not identified. It may share an account with another harness, so shared capacity is unknown.";

function quotaLabel(quota: PortfolioSnapshotInput["resources"][number]["quota"]): string {
  if (quota.kind === "unknown") return tr("common.unknown_c1c4dc", { p0: quota.reason === "No valid stored quota snapshot." ? tr("m0.portfolio.noQuotaSnapshot") : String(quota.reason) });
  if (quota.kind === "percent-used") return tr("common.used_not_remaining_capacity", { p0: String(quota.usedPercent) });
  if (quota.kind === "remaining") return tr("common.remaining", { p0: String(quota.remaining), p1: String(quota.unit) });
  if (quota.kind === "exhausted") return tr("common.exhausted");
  return quota.label;
}

function openAttention(link: AttentionLink, onOpenProject: Props["onOpenProject"]): void {
  if (link.page === "portfolio" || link.page === "clusters" || link.page === "company" || link.page === "attention" || link.page === "browser" || link.page === "native-computer" || link.page === "missions" || link.page === "usage" || link.page === "projects" || !link.projectId) return;
  onOpenProject(link.projectId, link.page);
}

function calendarText(analysis: PortfolioAnalysis): string {
  const calendar = analysis.estimation?.calendar;
  if (!calendar || calendar.status === "unknown" || calendar.ms == null) return calendar?.status === "incomplete" ? tr("common.partial") : tr("common.unknown");
  return formatPortfolioDuration({ status: calendar.status, ms: calendar.ms, knownMs: calendar.ms, origin: "estimated", note: calendar.note });
}

function nullable(value: number | null): string {
  return value == null ? tr("common.unknown") : String(value);
}
