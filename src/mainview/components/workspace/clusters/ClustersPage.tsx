import { codeLabel, staticLabel } from "@/i18n/presentation";

import { t as tr } from "@/i18n/core";
import { I18nText, useLocale as useUILocale } from "@/i18n/react";
import { useCallback, useEffect, useRef, useState, type KeyboardEvent } from "react";
import { Layers } from "lucide-react";
import { api } from "@/lib/api";
import { subscribePortfolioRefresh } from "@/lib/portfolio-events";
import {
  additionalCostText,
  archiveConfirmCopy,
  clusterCardMetrics,
  clusterErrorText,
  compareClusters,
  completenessLabel,
  countOrUnknown,
  environmentLabel,
  estimateLabel,
  formatClusterCalendar,
  isCurrentClusterRequest,
  moveConfirmCopy,
  resourceWarningLines,
  unassignConfirmCopy,
  COMPARISON_FOOTNOTE,
} from "@/lib/clusters";
import { cn } from "@/lib/utils";
import type { ProjectSurfacePage } from "@/lib/workspace";
import { Button } from "@/components/ui/button";
import { useConfirm } from "@/components/ui/confirm";
import { KnowledgeBrowser } from "../knowledge/KnowledgeBrowser";
import { InfrastructureInventory } from "../infrastructure/InfrastructureInventory";
import { ClusterFormDialog } from "./ClusterFormDialog";
import { PageHeader } from "../PageHeader";
import { Select } from "@/components/ui/select";
import { ActionsMenu } from "@/components/ui/actions-menu";
import { TechnicalDetails } from "@/components/ui/technical-details";
import type { ClusterAggregate } from "../../../../shared/clusters/aggregate.ts";
import {
  FORGEORBIT_COMPANY,
  type Cluster,
  type ClusterDetails,
  type ClusterProject,
} from "../../../../shared/clusters/types.ts";

interface Props {
  clusterId: string | null;
  onOpenCluster: (id: string) => void;
  onOpenDirectory: () => void;
  onOpenProject: (path: string, page: ProjectSurfacePage) => void;
  onOpenPortfolio: () => void;
  onOpenCompany: () => void;
  onOpenKnowledge: () => void;
}

type DashboardTab = "overview" | "projects" | "organization" | "knowledge" | "infrastructure";

const TABS: { id: DashboardTab; label: string }[] = [
  { id: "overview", get label() { return tr("common.overview"); } },
  { id: "projects", get label() { return tr("common.projects"); } },
  { id: "organization", get label() { return tr("common.organization"); } },
  { id: "knowledge", get label() { return tr("common.knowledge"); } },
  { id: "infrastructure", get label() { return tr("common.infrastructure"); } },
];

interface MoveChoice {
  path: string;
  projectName: string;
  fromId: string;
  fromName: string;
}

/**
 * Cluster directory and one cluster dashboard. Both read the cluster API.
 * Portfolio events already published by the app refresh the open page.
 * There is no second event stream and no polling timer.
 */
export function ClustersPage(props: Props) {
  useUILocale();
  const [inventory, setInventory] = useState(false);
  if (props.clusterId) return <ClusterDashboard {...props} clusterId={props.clusterId} />;
  if (inventory) {
    return (
      <div className="glass-surface flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden" data-testid="clusters-page">
        <InfrastructureInventory mode="global" onBack={() => setInventory(false)} onOpenKnowledge={props.onOpenKnowledge} />
      </div>
    );
  }
  return <ClusterDirectory {...props} onOpenInventory={() => setInventory(true)} />;
}

function useClusterReload(load: () => void): void {
  const loadRef = useRef(load);
  loadRef.current = load;
  useEffect(() => {
    let disposed = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const run = () => {
      if (!disposed) loadRef.current();
    };
    const schedule = () => {
      if (timer) clearTimeout(timer);
      timer = setTimeout(run, 400);
    };
    run();
    const unsubscribe = subscribePortfolioRefresh(() => schedule());
    const onFocus = () => schedule();
    const onVisible = () => {
      if (document.visibilityState === "visible") schedule();
    };
    window.addEventListener("focus", onFocus);
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      disposed = true;
      if (timer) clearTimeout(timer);
      unsubscribe();
      window.removeEventListener("focus", onFocus);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [load]);
}

function ClusterDirectory({
  onOpenCluster,
  onOpenCompany,
  onOpenKnowledge,
  onOpenInventory,
  onOpenPortfolio,
  onOpenProject,
}: Props & { onOpenInventory: () => void }) {
  useUILocale();
  const [filter, setFilter] = useState<"active" | "archived">("active");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [clusters, setClusters] = useState<Cluster[]>([]);
  const [assignTargets, setAssignTargets] = useState<Cluster[]>([]);
  const [unassigned, setUnassigned] = useState<ClusterProject[]>([]);
  const [summaries, setSummaries] = useState<Record<string, ClusterAggregate>>({});
  const [failed, setFailed] = useState<Record<string, string>>({});
  const [creating, setCreating] = useState(false);
  const [assignTo, setAssignTo] = useState("");
  const requestRef = useRef(0);
  const filterRefs = useRef<Record<"active" | "archived", HTMLButtonElement | null>>({ active: null, archived: null });

  const load = useCallback(() => {
    const requestId = ++requestRef.current;
    const archived = filter === "archived";
    void (async () => {
      try {
        const [listed, free, active] = await Promise.all([
          api.listClusters({ archived }),
          api.listUnassignedProjects(),
          archived ? api.listClusters() : Promise.resolve(null),
        ]);
        if (!isCurrentClusterRequest(requestId, requestRef.current)) return;
        const visible = archived ? listed.clusters.filter((item) => item.archivedAt != null) : listed.clusters;
        setClusters(visible);
        setAssignTargets(active ? active.clusters : visible);
        setUnassigned(free);
        setError(null);
        const results = await Promise.all(visible.map(async (item) => {
          try {
            const summary = await api.getClusterSummary(item.id);
            return { id: item.id, aggregate: summary.aggregate, error: null as string | null };
          } catch (err) {
            return { id: item.id, aggregate: null, error: clusterErrorText(err) };
          }
        }));
        if (!isCurrentClusterRequest(requestId, requestRef.current)) return;
        const next: Record<string, ClusterAggregate> = {};
        const errors: Record<string, string> = {};
        for (const row of results) {
          if (row.aggregate) next[row.id] = row.aggregate;
          if (row.error) errors[row.id] = row.error;
        }
        setSummaries(next);
        setFailed(errors);
      } catch (err) {
        if (!isCurrentClusterRequest(requestId, requestRef.current)) return;
        setError(clusterErrorText(err));
      } finally {
        if (isCurrentClusterRequest(requestId, requestRef.current)) setLoading(false);
      }
    })();
  }, [filter]);

  useClusterReload(load);

  const onFilterKey = (event: KeyboardEvent<HTMLButtonElement>) => {
    if (event.key !== "ArrowRight" && event.key !== "ArrowLeft" && event.key !== "Home" && event.key !== "End") return;
    event.preventDefault();
    const order = ["active", "archived"] as const;
    const at = order.indexOf(filter);
    const next = event.key === "Home" ? 0 : event.key === "End" ? 1 : (at + (event.key === "ArrowRight" ? 1 : -1) + 2) % 2;
    const id = order[next]!;
    setFilter(id);
    setLoading(true);
    filterRefs.current[id]?.focus();
  };

  const comparison = compareClusters(clusters.map((item) => ({
    cluster: item,
    aggregate: summaries[item.id] ?? null,
    unavailableReason: failed[item.id] ?? null,
  })));

  const assign = (path: string) => {
    if (!assignTo) return;
    void api.assignClusterProject(assignTo, path).then(
      () => load(),
      (err: unknown) => setError(clusterErrorText(err)),
    );
  };

  return (
    <div className="glass-surface flex min-h-0 min-w-0 max-w-full flex-1 flex-col overflow-y-auto" data-testid="clusters-page">
      <PageHeader
        title={<I18nText id="nav.workspaces" />}
        eyebrow={
          <nav aria-label={tr("clusters.cluster_location")} className="flex flex-wrap items-center gap-1 text-xs text-muted-foreground">
            <button type="button" className="glass-nav-item rounded-md px-1.5 py-0.5" data-testid="cluster-breadcrumb-company" onClick={onOpenCompany}>
              {FORGEORBIT_COMPANY.name}
            </button>
            <span aria-hidden>/</span>
            <span><I18nText id="nav.workspaces" /></span>
          </nav>
        }
      >
          <div role="tablist" aria-label={tr("clusters.cluster_visibility")} className="flex rounded-lg border border-[hsl(var(--glass-border)/var(--glass-border-alpha))] p-0.5">
            {(["active", "archived"] as const).map((id) => (
              <button
                key={id}
                type="button"
                role="tab"
                ref={(node) => { filterRefs.current[id] = node; }}
                aria-selected={filter === id}
                data-testid={`clusters-filter-${id}`}
                className={cn("glass-nav-item rounded-md px-2.5 py-1 text-xs", filter === id && "glass-selected")}
                onClick={() => { setFilter(id); setLoading(true); }}
                onKeyDown={onFilterKey}
              >
                {id === "active" ? tr("common.active") : tr("common.archived_bdb865")}
              </button>
            ))}
          </div>
          <Button type="button" variant="ghost" size="sm" data-testid="clusters-refresh" onClick={() => load()}><I18nText id="common.refresh" />{" "}</Button>
          <ActionsMenu
            testId="clusters-more"
            label={tr("uxfix.more.label")}
            items={[
              { id: "portfolio", label: tr("nav.tab.portfolio"), onSelect: onOpenPortfolio },
              { id: "company-knowledge", label: tr("common.company_knowledge"), onSelect: onOpenKnowledge },
              { id: "infrastructure", label: tr("common.infrastructure"), onSelect: onOpenInventory },
            ]}
          />
          <Button type="button" size="sm" data-testid="clusters-create" onClick={() => setCreating(true)}><I18nText id="spaces.new" /></Button>
      </PageHeader>

      <div className="flex min-w-0 max-w-full flex-col gap-6 px-4 pb-8 sm:px-page">
        {error && (
          <p role="alert" data-testid="clusters-error" className="rounded-lg border border-destructive/40 px-3 py-2 text-sm text-destructive">
            {error}
          </p>
        )}
        {loading && clusters.length === 0 ? (
          <p data-testid="clusters-loading" className="text-sm text-muted-foreground"><I18nText id="clusters.loading_clusters" /></p>
        ) : clusters.length === 0 && !error ? (
          <p data-testid="clusters-empty" className="rounded-xl border px-4 py-8 text-sm text-muted-foreground">
            {filter === "archived" ? tr("common.no_archived_clusters") : tr("common.no_clusters_yet_create_one_before_assigning_projects")}
          </p>
        ) : (
          <ul className="grid grid-cols-1 gap-3 md:grid-cols-2 xl:grid-cols-3">
            {clusters.map((item) => {
              const metrics = clusterCardMetrics(item, summaries[item.id] ?? null, Boolean(failed[item.id]));
              return (
                <li key={item.id} className="min-w-0 rounded-xl border p-4" data-testid="cluster-card" data-cluster-id={item.id}>
                  <div className="flex items-start gap-2">
                    <Swatch color={item.color} />
                    <div className="min-w-0 flex-1">
                      <h2 className="truncate text-sm font-semibold" title={item.name}>{item.name}</h2>
                      {(item.icon || item.priority != null) && (
                        <p className="truncate text-[11px] text-muted-foreground">
                          {[item.icon, item.priority != null ? `${tr("common.priority")} ${item.priority}` : ""].filter(Boolean).join(" · ")}
                        </p>
                      )}
                    </div>
                  </div>
                  <p className="mt-2 line-clamp-3 break-words text-xs text-muted-foreground" title={item.description || undefined}>
                    {item.description || tr("common.no_description")}
                  </p>
                  <dl className="mt-3 grid grid-cols-2 gap-2">
                    <Metric label={tr("common.projects")} value={metrics.projects} testId="cluster-card-projects" />
                    <Metric label={tr("common.active_projects")} value={metrics.active} testId="cluster-card-active" />
                    <Metric label={tr("common.tasks_b3a60e")} value={metrics.tasks} testId="cluster-card-tasks" />
                    <Metric label={tr("common.runs")} value={metrics.runs} testId="cluster-card-runs" />
                    <Metric label={tr("common.blockers")} value={metrics.blockers} testId="cluster-card-blockers" />
                    <Metric label={tr("clusters.pending_reviews")} value={metrics.reviews} testId="cluster-card-reviews" />
                    <Metric label={tr("clusters.known_estimate")} value={metrics.estimate} testId="cluster-card-estimate" />
                    <Metric label={tr("common.data_quality")} value={metrics.quality} testId="cluster-card-quality" />
                  </dl>
                  {failed[item.id] && <p className="mt-2 text-xs text-warning">{failed[item.id]}</p>}
                  <Button type="button" size="sm" variant="outline" className="mt-3 max-w-full" data-testid="cluster-open" onClick={() => onOpenCluster(item.id)}><I18nText id="spaces.open" /></Button>
                </li>
              );
            })}
          </ul>
        )}

        <section aria-labelledby="unassigned-heading" data-testid="clusters-unassigned">
          <h2 id="unassigned-heading" className="text-sm font-semibold"><I18nText id="spaces.unassigned_title" /></h2>
          <p className="mt-1 text-xs text-muted-foreground"><I18nText id="spaces.unassigned_hint" /></p>
          {unassigned.length === 0 ? (
            <p className="mt-2 text-sm text-muted-foreground" data-testid="clusters-unassigned-empty"><I18nText id="clusters.every_registered_project_is_in_a_cluster" /></p>
          ) : (
            <>
              <label className="mt-2 flex max-w-sm flex-col gap-1 text-xs"><I18nText id="clusters.assign_to" />{" "}<Select
                  data-testid="cluster-assign-target"
                  value={assignTo}
                  onChange={(event) => setAssignTo(event.target.value)}
                >
                  <option value=""><I18nText id="clusters.choose_a_cluster" /></option>
                  {assignTargets.map((item) => (
                    <option key={item.id} value={item.id}>{item.name}</option>
                  ))}
                </Select>
              </label>
              <ul className="mt-2 flex max-h-80 flex-col gap-2 overflow-y-auto">
                {unassigned.map((project) => (
                  <li key={project.projectPath} className="flex min-w-0 flex-wrap items-center gap-2 rounded-lg border px-3 py-2" data-testid="cluster-unassigned-project" data-path={project.projectPath}>
                    <span className="min-w-0 flex-1 truncate text-sm" title={project.projectPath}>{project.name || project.projectPath}</span>
                    <Button type="button" size="sm" data-testid="cluster-open-unassigned" onClick={() => onOpenProject(project.projectPath, "board")}><I18nText id="spaces.open_board" /></Button>
                    <Button type="button" size="sm" variant="outline" data-testid="cluster-assign-unassigned" disabled={!assignTo} onClick={() => assign(project.projectPath)}><I18nText id="common.assign" /></Button>
                  </li>
                ))}
              </ul>
            </>
          )}
        </section>

        <section aria-labelledby="comparison-heading" className="min-w-0 w-full overflow-hidden" data-testid="clusters-comparison">
          <h2 id="comparison-heading" className="text-sm font-semibold"><I18nText id="common.comparison" /></h2>
          <p className="mt-1 text-xs text-muted-foreground" data-testid="clusters-comparison-note">{comparison.reason}</p>
          {comparison.rows.length === 0 ? (
            <p className="mt-2 text-sm text-muted-foreground"><I18nText id="clusters.nothing_to_compare_in_this_filter" /></p>
          ) : (
            <div className="mt-2 w-full overflow-x-auto">
              <table className="w-max min-w-[52rem] border-collapse text-left text-xs">
                <thead>
                  <tr className="border-b text-muted-foreground">
                    {[tr("spaces.column"), tr("common.projects"), tr("common.active"), tr("clusters.blocked_projects"), tr("common.reviews"), tr("common.runs"), tr("common.agent_time"), tr("common.calendar"), tr("common.additional_costs"), tr("common.confidence")].map((heading) => (
                      <th key={heading} scope="col" className="px-2 py-2 font-medium">{heading}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {comparison.rows.map((row) => (
                    <tr key={row.id} className="border-b align-top" data-testid="cluster-comparison-row">
                      <th scope="row" className="max-w-[12rem] truncate px-2 py-2 font-medium" title={row.name}>{row.name}</th>
                      <td className="px-2 py-2">{row.projects}</td>
                      <td className="px-2 py-2">{row.activeProjects}</td>
                      <td className="px-2 py-2">{row.blockedProjects}</td>
                      <td className="px-2 py-2">{row.pendingReviews}</td>
                      <td className="px-2 py-2">{row.activeRuns}</td>
                      <td className="px-2 py-2">{row.agentTime}</td>
                      <td className="px-2 py-2">{row.calendar}</td>
                      <td className="px-2 py-2">
                        <div>{row.additionalCosts}</div>
                        {row.additionalReason && <div className="mt-1 text-muted-foreground">{row.additionalReason}</div>}
                      </td>
                      <td className="px-2 py-2">
                        <div>{codeLabel(row.confidence)}</div>
                        {row.confidenceReason && <div className="mt-1 text-muted-foreground">{row.confidenceReason}</div>}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          {/* The empty-state reason is the same sentence: say it once. */}
          {comparison.reason !== staticLabel(COMPARISON_FOOTNOTE) && <p className="mt-2 text-xs text-muted-foreground">{staticLabel(COMPARISON_FOOTNOTE)}</p>}
        </section>
      </div>

      <ClusterFormDialog
        open={creating}
        cluster={null}
        onClose={() => setCreating(false)}
        onSaved={(saved) => {
          setCreating(false);
          onOpenCluster(saved.id);
        }}
      />
    </div>
  );
}

function ClusterDashboard({
  clusterId,
  onOpenDirectory,
  onOpenProject,
  onOpenPortfolio,
  onOpenCompany,
}: Props & { clusterId: string }) {
  useUILocale();
  const confirm = useConfirm();
  const [tab, setTab] = useState<DashboardTab>("projects");
  const [loading, setLoading] = useState(true);
  const [fatal, setFatal] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [details, setDetails] = useState<ClusterDetails | null>(null);
  const [aggregate, setAggregate] = useState<ClusterAggregate | null>(null);
  const [projects, setProjects] = useState<ClusterProject[]>([]);
  const [unassigned, setUnassigned] = useState<ClusterProject[]>([]);
  const [moves, setMoves] = useState<MoveChoice[]>([]);
  const [editing, setEditing] = useState(false);
  const [knowledgeDirty, setKnowledgeDirty] = useState(false);
  const knowledgeDirtyRef = useRef(false);
  knowledgeDirtyRef.current = knowledgeDirty;
  const [assignPath, setAssignPath] = useState("");
  const [movePath, setMovePath] = useState("");
  const requestRef = useRef(0);
  const tabRefs = useRef<Record<DashboardTab, HTMLButtonElement | null>>({
    overview: null, projects: null, organization: null, knowledge: null, infrastructure: null,
  });

  const load = useCallback(() => {
    const requestId = ++requestRef.current;
    void (async () => {
      try {
        const nextDetails = await api.getCluster(clusterId);
        if (!isCurrentClusterRequest(requestId, requestRef.current)) return;
        const [summaryResult, memberProjects, free, everyone] = await Promise.all([
          api.getClusterSummary(clusterId).then(
            (summary) => ({ aggregate: summary.aggregate, error: null as string | null }),
            (err: unknown) => ({ aggregate: null, error: clusterErrorText(err) }),
          ),
          api.listClusterProjects(clusterId),
          api.listUnassignedProjects(),
          api.listClusters({ archived: true }),
        ]);
        if (!isCurrentClusterRequest(requestId, requestRef.current)) return;
        const others = everyone.clusters.filter((item) => item.id !== clusterId);
        const memberships = await Promise.all(others.map(async (item) => {
          try {
            return { cluster: item, projects: await api.listClusterProjects(item.id) };
          } catch {
            return { cluster: item, projects: [] as ClusterProject[] };
          }
        }));
        if (!isCurrentClusterRequest(requestId, requestRef.current)) return;
        setDetails(nextDetails);
        setAggregate(summaryResult.aggregate);
        setProjects(memberProjects);
        setUnassigned(free);
        setMoves(memberships.flatMap((row) => row.projects.map((project) => ({
          path: project.projectPath,
          projectName: project.name || project.projectPath,
          fromId: row.cluster.id,
          fromName: row.cluster.name,
        }))));
        setFatal(null);
        setNotice(summaryResult.error);
      } catch (err) {
        if (!isCurrentClusterRequest(requestId, requestRef.current)) return;
        setFatal(clusterErrorText(err));
        setDetails(null);
      } finally {
        if (isCurrentClusterRequest(requestId, requestRef.current)) setLoading(false);
      }
    })();
  }, [clusterId]);

  useClusterReload(load);

  const selectTab = async (id: DashboardTab) => {
    if (id !== tab && tab === "knowledge" && knowledgeDirtyRef.current) {
      const ok = await confirm(() => ({
        title: tr("common.discard_unsaved_note_changes"),
        description: tr("common.the_markdown_in_the_editor_has_not_been"),
        confirmLabel: tr("common.discard"),
        cancelLabel: tr("common.keep_editing"),
        variant: "destructive",
      }));
      if (!ok) {
        tabRefs.current.knowledge?.focus();
        return;
      }
    }
    setTab(id);
    tabRefs.current[id]?.focus();
  };

  const onTabKey = (event: KeyboardEvent<HTMLButtonElement>) => {
    if (event.key !== "ArrowRight" && event.key !== "ArrowLeft" && event.key !== "Home" && event.key !== "End") return;
    event.preventDefault();
    const at = TABS.findIndex((item) => item.id === tab);
    const next = event.key === "Home" ? 0 : event.key === "End" ? TABS.length - 1 : (at + (event.key === "ArrowRight" ? 1 : -1) + TABS.length) % TABS.length;
    const id = TABS[next]!.id;
    void selectTab(id);
  };

  const assign = () => {
    if (!assignPath || !details || details.archivedAt != null) return;
    void api.assignClusterProject(details.id, assignPath).then(
      () => { setAssignPath(""); load(); },
      (err: unknown) => setNotice(clusterErrorText(err)),
    );
  };

  const move = async () => {
    if (!movePath || !details || details.archivedAt != null) return;
    const choice = moves.find((item) => item.path === movePath);
    if (!choice) return;
    const copy = moveConfirmCopy(choice.projectName, choice.fromName, details.name);
    const ok = await confirm(() => ({ title: copy.title, description: copy.body, confirmLabel: tr("common.move_project") }));
    if (!ok) return;
    void api.moveClusterProject(details.id, choice.path).then(
      () => { setMovePath(""); load(); },
      (err: unknown) => setNotice(clusterErrorText(err)),
    );
  };

  const unassign = async (project: ClusterProject) => {
    if (!details) return;
    const copy = unassignConfirmCopy(project.name || project.projectPath, details.name);
    const ok = await confirm(() => ({
      title: copy.title,
      description: copy.body,
      confirmLabel: tr("common.remove_membership"),
      variant: "destructive",
    }));
    if (!ok) return;
    void api.unassignClusterProject(details.id, project.projectPath).then(
      () => load(),
      (err: unknown) => setNotice(clusterErrorText(err)),
    );
  };

  const archive = async () => {
    if (!details) return;
    const copy = archiveConfirmCopy(details.name, details.projectCount);
    const ok = await confirm(() => ({
      title: copy.title,
      description: copy.body,
      confirmLabel: tr("common.archive_cluster"),
      variant: "destructive",
    }));
    if (!ok) return;
    void api.archiveCluster(details.id).then(
      () => load(),
      (err: unknown) => setNotice(clusterErrorText(err)),
    );
  };

  if (fatal && !details) {
    return (
      <div className="glass-surface flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto px-4 py-6 sm:px-page" data-testid="cluster-dashboard">
        <p role="alert" data-testid="cluster-dashboard-error" className="text-sm text-destructive">{fatal}</p>
        <Button type="button" variant="outline" size="sm" data-testid="cluster-back" onClick={onOpenDirectory}><I18nText id="clusters.all_clusters" /></Button>
      </div>
    );
  }

  const archived = details?.archivedAt != null;
  const env = environmentLabel(aggregate);
  const warnings = resourceWarningLines(aggregate);

  return (
    <div className="glass-surface flex min-h-0 min-w-0 flex-1 flex-col overflow-y-auto" data-testid="cluster-dashboard" data-cluster-id={details?.id ?? clusterId}>
      <header className="flex flex-col gap-3 px-4 py-4 sm:px-page">
        <nav aria-label={tr("clusters.cluster_location")} className="flex flex-wrap items-center gap-1 text-xs text-muted-foreground">
          <button type="button" className="glass-nav-item rounded-md px-1.5 py-0.5" data-testid="cluster-breadcrumb-company" onClick={onOpenCompany}>
            {FORGEORBIT_COMPANY.name}
          </button>
          <span aria-hidden>/</span>
          <button type="button" className="glass-nav-item rounded-md px-1.5 py-0.5" data-testid="cluster-breadcrumb-clusters" onClick={onOpenDirectory}><I18nText id="spaces.back" /></button>
          <span aria-hidden>/</span>
          <span className="max-w-[16rem] truncate" title={details?.name}>{details?.name ?? tr("spaces.column")}</span>
        </nav>
        <div className="flex min-w-0 flex-wrap items-start justify-between gap-3">
          <div className="min-w-0">
            <div className="flex items-center gap-2">
              <Swatch color={details?.color ?? null} />
              <h1 className="break-words text-lg font-semibold tracking-tight" data-testid="cluster-dashboard-name">{details?.name ?? (loading ? tr("common.loading") : tr("spaces.column"))}</h1>
            </div>
            {details?.id && (
              <TechnicalDetails
                className="mt-2 max-w-xl"
                testId="cluster-technical-id"
                rows={[{ label: tr("spaces.identifier"), value: details.id, testId: "cluster-id-value" }]}
              />
            )}
          </div>
          <div className="flex flex-wrap gap-2">
            <Button type="button" variant="outline" size="sm" onClick={onOpenPortfolio} data-testid="cluster-open-portfolio"><I18nText id="common.portfolio" /></Button>
            <Button type="button" variant="outline" size="sm" data-testid="cluster-edit" disabled={!details} onClick={() => setEditing(true)}><I18nText id="common.edit" /></Button>
            <Button type="button" variant="outline" size="sm" data-testid="cluster-archive" disabled={!details || archived} onClick={() => void archive()}>
              {archived ? tr("common.archived_bdb865") : tr("common.archive")}
            </Button>
          </div>
        </div>
        {archived && (
          <p className="rounded-lg border px-3 py-2 text-xs text-muted-foreground" data-testid="cluster-archived-note"><I18nText id="clusters.this_cluster_is_archived_its_projects_tasks_agents" />{" "}</p>
        )}
        {notice && <p role="status" data-testid="cluster-dashboard-notice" className="text-sm text-warning">{notice}</p>}
        <div role="tablist" aria-label={tr("clusters.cluster_sections")} className="flex max-w-full flex-wrap gap-1">
          {TABS.map((item) => (
            <button
              key={item.id}
              type="button"
              role="tab"
              ref={(node) => { tabRefs.current[item.id] = node; }}
              aria-selected={tab === item.id}
              data-testid={`cluster-tab-${item.id}`}
              className={cn("glass-nav-item rounded-md px-2.5 py-1 text-xs", tab === item.id && "glass-selected")}
              onClick={() => void selectTab(item.id)}
              onKeyDown={onTabKey}
            >
              {item.label}
            </button>
          ))}
        </div>
      </header>

      <div className="px-4 pb-8 sm:px-page">
        {loading && !details ? (
          <p data-testid="cluster-dashboard-loading" className="text-sm text-muted-foreground"><I18nText id="clusters.loading_cluster" /></p>
        ) : tab === "overview" && details ? (
          <Overview details={details} aggregate={aggregate} environmentLabel={env.label} environmentReason={env.reason} warnings={warnings} />
        ) : tab === "projects" && details ? (
          <Projects
            details={details}
            projects={projects}
            unassigned={unassigned}
            moves={moves}
            archived={archived}
            assignPath={assignPath}
            movePath={movePath}
            onAssignPath={setAssignPath}
            onMovePath={setMovePath}
            onAssign={assign}
            onMove={() => void move()}
            onUnassign={(project) => void unassign(project)}
            onOpenProject={onOpenProject}
          />
        ) : tab === "organization" && details ? (
          <Organization details={details} projects={projects} />
        ) : tab === "knowledge" && details ? (
          <Knowledge details={details} onDirtyChange={setKnowledgeDirty} />
        ) : tab === "infrastructure" && details ? (
          <InfrastructureInventory
            mode="cluster"
            clusterId={details.id}
            clusterName={details.name}
            onShowKnowledge={() => void selectTab("knowledge")}
          />
        ) : null}
      </div>

      <ClusterFormDialog
        open={editing}
        cluster={details}
        onClose={() => setEditing(false)}
        onSaved={() => {
          setEditing(false);
          load();
        }}
      />
    </div>
  );
}

function Overview({
  details,
  aggregate,
  environmentLabel: envLabel,
  environmentReason,
  warnings,
}: {
  details: ClusterDetails;
  aggregate: ClusterAggregate | null;
  environmentLabel: string;
  environmentReason: string;
  warnings: string[];
}) {
  useUILocale();
  return (
    <div className="flex flex-col gap-4" data-testid="cluster-overview">
      <section className="rounded-xl border p-4">
        <h2 className="text-sm font-semibold"><I18nText id="common.identity" /></h2>
        <p className="mt-2 break-words text-sm text-muted-foreground">{details.description || tr("common.no_description")}</p>
        <dl className="mt-3 grid grid-cols-2 gap-3 md:grid-cols-4">
          {details.priority != null && <Metric label={tr("common.priority")} value={String(details.priority)} testId="cluster-metric-priority" />}
          <Metric label={tr("common.projects")} value={String(details.projectCount)} testId="cluster-metric-projects" />
          {details.icon ? <Metric label={tr("clusters.icon")} value={details.icon} testId="cluster-metric-icon" /> : null}
          <Metric label={tr("common.data_quality")} value={completenessLabel(aggregate?.completeness)} testId="cluster-metric-quality" />
          <Metric label={tr("common.tasks_b3a60e")} value={countOrUnknown(aggregate?.counts.tasks)} testId="cluster-metric-tasks" />
          <Metric label={tr("common.active_runs")} value={countOrUnknown(aggregate?.counts.activeRuns)} testId="cluster-metric-runs" />
          <Metric label={tr("common.waiting_for_review")} value={countOrUnknown(aggregate?.counts.pendingReviews)} testId="cluster-metric-reviews" />
          <Metric label={tr("clusters.blocked_projects")} value={countOrUnknown(aggregate?.blockedProjects)} testId="cluster-metric-blocked" />
        </dl>
      </section>
      <section className="rounded-xl border p-4" data-testid="cluster-environment">
        <h2 className="text-sm font-semibold"><I18nText id="clusters.environment_status" /></h2>
        <p className="mt-1 text-sm font-medium">{envLabel}</p>
        <p className="mt-1 text-xs text-muted-foreground">{environmentReason}</p>
      </section>
      <section className="rounded-xl border p-4" data-testid="cluster-estimates">
        <h2 className="text-sm font-semibold"><I18nText id="common.estimates" /></h2>
        <dl className="mt-3 grid grid-cols-1 gap-3 sm:grid-cols-3">
          <Metric label={tr("common.agent_time")} value={estimateLabel(aggregate?.estimation)} testId="cluster-metric-agent" />
          <Metric label={tr("common.calendar")} value={formatClusterCalendar(aggregate?.estimation?.calendar)} testId="cluster-metric-calendar" />
          <Metric label={tr("clusters.known_additional_cost")} value={additionalCostText(aggregate).text} testId="cluster-metric-cost" />
        </dl>
        {additionalCostText(aggregate).reason && (
          <p className="mt-2 text-xs text-muted-foreground">{additionalCostText(aggregate).reason}</p>
        )}
        {aggregate?.notes.map((note) => (
          <p key={note} className="mt-2 text-xs text-muted-foreground">{note}</p>
        ))}
      </section>
      <section className="rounded-xl border p-4" data-testid="cluster-resource-warnings">
        <h2 className="text-sm font-semibold"><I18nText id="clusters.resource_warnings" /></h2>
        {warnings.length === 0 ? (
          <p className="mt-1 text-sm text-muted-foreground"><I18nText id="clusters.no_resource_warnings_in_the_recorded_snapshot" /></p>
        ) : (
          <ul className="mt-2 flex flex-col gap-1 text-sm">
            {warnings.map((line) => <li key={line}>{line}</li>)}
          </ul>
        )}
      </section>
    </div>
  );
}

function Projects({
  details,
  projects,
  unassigned,
  moves,
  archived,
  assignPath,
  movePath,
  onAssignPath,
  onMovePath,
  onAssign,
  onMove,
  onUnassign,
  onOpenProject,
}: {
  details: ClusterDetails;
  projects: ClusterProject[];
  unassigned: ClusterProject[];
  moves: MoveChoice[];
  archived: boolean;
  assignPath: string;
  movePath: string;
  onAssignPath: (path: string) => void;
  onMovePath: (path: string) => void;
  onAssign: () => void;
  onMove: () => void;
  onUnassign: (project: ClusterProject) => void;
  onOpenProject: (path: string, page: ProjectSurfacePage) => void;
}) {
  useUILocale();
  return (
    <div className="flex flex-col gap-4" data-testid="cluster-projects">
      {archived ? (
        <p className="text-sm text-muted-foreground"><I18nText id="clusters.an_archived_cluster_does_not_accept_projects" /></p>
      ) : (
        <div className="flex flex-col gap-3 rounded-xl border p-4">
          <div className="flex flex-wrap items-end gap-2">
            <label className="flex min-w-0 flex-1 flex-col gap-1 text-xs"><I18nText id="clusters.add_a_registered_project" />{" "}<select className="rounded-md border bg-transparent px-2 py-1 text-sm" data-testid="cluster-assign-project" value={assignPath} onChange={(event) => onAssignPath(event.target.value)}>
                <option value=""><I18nText id="clusters.unassigned_projects" /></option>
                {unassigned.map((project) => (
                  <option key={project.projectPath} value={project.projectPath}>{project.name || project.projectPath}</option>
                ))}
              </select>
            </label>
            <Button type="button" size="sm" data-testid="cluster-assign" disabled={!assignPath} onClick={onAssign}><I18nText id="clusters.add_to_cluster" /></Button>
          </div>
          <div className="flex flex-wrap items-end gap-2">
            <label className="flex min-w-0 flex-1 flex-col gap-1 text-xs"><I18nText id="clusters.move_from_another_cluster" />{" "}<select className="rounded-md border bg-transparent px-2 py-1 text-sm" data-testid="cluster-move-project" value={movePath} onChange={(event) => onMovePath(event.target.value)}>
                <option value=""><I18nText id="clusters.projects_in_other_clusters" /></option>
                {moves.map((choice) => (
                  <option key={choice.path} value={choice.path}>{choice.projectName} — {choice.fromName}</option>
                ))}
              </select>
            </label>
            <Button type="button" size="sm" variant="outline" data-testid="cluster-move" disabled={!movePath} onClick={onMove}><I18nText id="clusters.move_here" /></Button>
          </div>
        </div>
      )}
      {projects.length === 0 ? (
        <p data-testid="cluster-projects-empty" className="text-sm text-muted-foreground"><I18nText id="clusters.this_cluster_has_no_projects" /></p>
      ) : (
        <ul className="flex max-h-[32rem] flex-col gap-2 overflow-y-auto">
          {projects.map((project) => (
            <li key={project.projectPath} className="min-w-0 rounded-xl border p-3" data-testid="cluster-project" data-path={project.projectPath}>
              <div className="flex min-w-0 flex-wrap items-center justify-between gap-2">
                <div className="min-w-0">
                  <h3 className="truncate text-sm font-medium" title={project.name}>
                    <button type="button" className="max-w-full truncate text-left hover:underline" data-testid="cluster-open-board" onClick={() => onOpenProject(project.projectPath, "board")}>
                      {project.name || project.projectPath}
                    </button>
                  </h3>
                  <p className="truncate text-[11px] text-muted-foreground" title={project.projectPath}>{project.projectPath}</p>
                </div>
                <Button type="button" size="sm" variant="outline" data-testid="cluster-unassign" onClick={() => onUnassign(project)}><I18nText id="clusters.remove_from" />{" "}{details.name}
                </Button>
              </div>
              <div className="mt-2 flex flex-wrap gap-1">
                <ProjectLink label={tr("common.workspace")} page="overview" path={project.projectPath} onOpen={onOpenProject} />
                <ProjectLink label={tr("common.board")} page="board" path={project.projectPath} onOpen={onOpenProject} />
                <ProjectLink label={tr("common.project_manager")} page="manager" path={project.projectPath} onOpen={onOpenProject} />
                <ProjectLink label={tr("common.estimates")} page="estimates" path={project.projectPath} onOpen={onOpenProject} />
                <ProjectLink label={tr("common.environment")} page="environment" path={project.projectPath} onOpen={onOpenProject} />
              </div>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function ProjectLink({
  label,
  page,
  path,
  onOpen,
}: {
  label: string;
  page: ProjectSurfacePage;
  path: string;
  onOpen: (path: string, page: ProjectSurfacePage) => void;
}) {
  useUILocale();
  return (
    <button type="button" className="glass-nav-item rounded-md border px-2 py-1 text-xs" data-testid={`cluster-open-${page}`} onClick={() => onOpen(path, page)}>
      {label}
    </button>
  );
}

function Organization({ details, projects }: { details: ClusterDetails; projects: ClusterProject[] }) {
  useUILocale();
  return (
    <section className="rounded-xl border p-4" data-testid="cluster-organization">
      <h2 className="text-sm font-semibold"><I18nText id="clusters.hierarchy" /></h2>
      <ul className="mt-3 text-sm">
        <li>
          {FORGEORBIT_COMPANY.name}
          <ul className="ml-4 mt-1 list-disc">
            <li>
              <span className="break-words">{details.name}</span>
              <ul className="ml-4 mt-1 list-disc">
                {projects.length === 0 ? (
                  <li className="text-muted-foreground"><I18nText id="common.no_projects" /></li>
                ) : projects.map((project) => (
                  <li key={project.projectPath} className="truncate" title={project.projectPath}>{project.name || project.projectPath}</li>
                ))}
              </ul>
            </li>
          </ul>
        </li>
      </ul>
      <p className="mt-4 break-words text-xs text-muted-foreground" data-testid="cluster-manager-note"><I18nText id="clusters.cluster_manager_not_assigned" />{" "}<I18nText id="spaces.manager_note" />
      </p>
    </section>
  );
}

function Knowledge({ details, onDirtyChange }: { details: ClusterDetails; onDirtyChange: (dirty: boolean) => void }) {
  useUILocale();
  return (
    <div className="flex flex-col gap-3" data-testid="cluster-knowledge">
      {details.notesSummary && (
        <p className="text-sm" data-testid="cluster-notes-summary">{details.notesSummary}</p>
      )}
      <KnowledgeBrowser
        layout="embedded"
        owner={details.knowledgeOwner}
        heading={tr("common.knowledge_7c44c5", { p0: String(details.name) })}
        contextNote="These notes stay with this cluster. Moving a project does not move them, and archiving the cluster does not delete them."
        onDirtyChange={onDirtyChange}
      />
    </div>
  );
}

function Swatch({ color }: { color: string | null }) {
  useUILocale();
  const safe = color && /^#[0-9a-f]{3}(?:[0-9a-f]{3})?$/i.test(color) ? color : null;
  return (
    <span className="relative inline-flex size-7 shrink-0 items-center justify-center rounded-md border bg-foreground/5" aria-hidden>
      <Layers className="size-3.5 text-muted-foreground" />
      {safe && <span className="absolute -bottom-0.5 -right-0.5 size-2.5 rounded-full border border-background" style={{ backgroundColor: safe }} />}
    </span>
  );
}

function Metric({ label, value, testId }: { label: string; value: string; testId: string }) {
  useUILocale();
  return (
    <div className="min-w-0" data-testid={testId}>
      <dt className="text-[11px] text-muted-foreground">{label}</dt>
      <dd className="truncate text-sm font-medium" title={value}>{value}</dd>
    </div>
  );
}
