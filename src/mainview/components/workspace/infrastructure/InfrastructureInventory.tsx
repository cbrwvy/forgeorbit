import { staticLabel } from "@/i18n/presentation";
import { t as tr } from "@/i18n/core";
import { I18nText, useLocale as useUILocale } from "@/i18n/react";
import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { api } from "@/lib/api";
import { Button } from "@/components/ui/button";
import { useConfirm } from "@/components/ui/confirm";
import { cn } from "@/lib/utils";
import type { Cluster } from "../../../../shared/clusters/types.ts";
import type { KnowledgeDocument } from "../../../../shared/knowledge/document.ts";
import {
  INFRASTRUCTURE_COST_NOTE,
  INFRASTRUCTURE_EMPTY_NOTE,
  INFRASTRUCTURE_ENVIRONMENTS,
  INFRASTRUCTURE_ENVIRONMENT_LABELS,
  INFRASTRUCTURE_KNOWLEDGE_CATEGORIES,
  INFRASTRUCTURE_KNOWLEDGE_NOTE,
  INFRASTRUCTURE_STATUS_NOTE,
  INFRASTRUCTURE_TYPES,
  INFRASTRUCTURE_TYPE_LABELS,
  formatRecordedCost,
  infrastructureEnvironmentLabel,
  infrastructureStatusLabel,
  matchesInfrastructureQuery,
  type ClusterInfrastructureView,
  type InfrastructureEnvironment,
  type InfrastructureListQuery,
  type InfrastructureResource,
  type InfrastructureType,
} from "@/i18n/infrastructure";
import { ResourceFormDialog } from "./ResourceFormDialog";
import { DeploymentRequestsPanel } from "./DeploymentRequestsPanel";
import { InfraOperationsSection } from "./InfraOperationsPanel";

interface NamedProject {
  path: string;
  name: string;
}

interface Props {
  mode: "global" | "cluster";
  clusterId?: string;
  clusterName?: string;
  onBack?: () => void;
  onOpenKnowledge?: () => void;
  onShowKnowledge?: () => void;
}

const STANDARD_ENVIRONMENTS = INFRASTRUCTURE_ENVIRONMENTS.filter((environment) => environment !== "custom");

function errorText(error: unknown): string {
  if (error && typeof error === "object" && "message" in error && typeof error.message === "string" && error.message) {
    return error.message;
  }
  return tr("common.couldn_t_reach_the_infrastructure_inventory");
}

function isKnowledgeCategory(category: string): boolean {
  return (INFRASTRUCTURE_KNOWLEDGE_CATEGORIES as readonly string[]).includes(category);
}

/**
 * Organization inventory, and the same records scoped to one cluster.
 * Filters stay on this page. The sidebar does not gain a new section.
 */
export function InfrastructureInventory({
  mode,
  clusterId,
  clusterName,
  onBack,
  onOpenKnowledge,
  onShowKnowledge,
}: Props) {
  useUILocale();
  const confirm = useConfirm();
  const requestRef = useRef(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [resources, setResources] = useState<InfrastructureResource[]>([]);
  const [truncated, setTruncated] = useState(false);
  const [view, setView] = useState<ClusterInfrastructureView | null>(null);
  const [clusters, setClusters] = useState<Cluster[]>([]);
  const [projects, setProjects] = useState<NamedProject[]>([]);
  const [knowledge, setKnowledge] = useState<KnowledgeDocument[] | "error" | null>(null);
  const [query, setQuery] = useState("");
  const [type, setType] = useState("");
  const [clusterFilter, setClusterFilter] = useState("");
  const [projectFilter, setProjectFilter] = useState("");
  const [environment, setEnvironment] = useState("");
  const [provider, setProvider] = useState("");
  const [archived, setArchived] = useState<InfrastructureListQuery["archived"]>("active");
  const [form, setForm] = useState<InfrastructureResource | null | "new" | false>(false);
  const [environmentProject, setEnvironmentProject] = useState("");
  const [declared, setDeclared] = useState<{ environment: InfrastructureEnvironment; customLabel: string }[]>([]);
  const [customLabel, setCustomLabel] = useState("");
  const searchRef = useRef<HTMLInputElement>(null);

  const load = useCallback(() => {
    const requestId = ++requestRef.current;
    setLoading(true);
    void (async () => {
      try {
        const [clusterList, projectList] = await Promise.all([
          api.listClusters({ archived: true }),
          api.listProjects(),
        ]);
        let nextResources: InfrastructureResource[] = [];
        let nextTruncated = false;
        let nextView: ClusterInfrastructureView | null = null;
        let nextKnowledge: KnowledgeDocument[] | "error" | null = null;
        if (mode === "cluster" && clusterId) {
          const [clusterInventory, notes] = await Promise.all([
            api.getClusterInfrastructure(clusterId),
            api.listKnowledge({ kind: "cluster", id: clusterId }).then(
              (listed) => listed.documents,
              () => "error" as const,
            ),
          ]);
          nextView = clusterInventory;
          nextResources = clusterInventory.resources;
          nextKnowledge = notes;
        } else {
          const listed = await api.listInfrastructure({ archived: "all" });
          nextResources = listed.resources;
          nextTruncated = listed.truncated;
        }
        if (requestId !== requestRef.current) return;
        setClusters(clusterList.clusters);
        setProjects(projectList.map((project) => ({ path: project.path, name: project.name })));
        setResources(nextResources);
        setTruncated(nextTruncated);
        setView(nextView);
        setKnowledge(nextKnowledge);
        setError(null);
      } catch (err) {
        if (requestId !== requestRef.current) return;
        setError(errorText(err));
      } finally {
        if (requestId === requestRef.current) setLoading(false);
      }
    })();
  }, [clusterId, mode]);

  useEffect(() => {
    load();
  }, [load]);

  useEffect(() => {
    if (mode === "cluster" || !environmentProject) {
      setDeclared([]);
      return;
    }
    let cancelled = false;
    void api.listProjectEnvironments(environmentProject).then(
      (result) => {
        if (!cancelled) setDeclared(result.environments);
      },
      (err: unknown) => {
        if (!cancelled) setError(errorText(err));
      },
    );
    return () => {
      cancelled = true;
    };
  }, [environmentProject, mode, resources]);

  const filter: InfrastructureListQuery = {
    q: query,
    resourceType: type ? type as InfrastructureType : undefined,
    clusterId: mode === "global" && clusterFilter ? clusterFilter : undefined,
    projectPath: projectFilter || undefined,
    environment: environment ? environment as InfrastructureEnvironment : undefined,
    provider: provider || undefined,
    archived,
  };
  const visible = resources.filter((resource) => matchesInfrastructureQuery(resource, filter));
  const providers = [...new Set(resources.map((resource) => resource.provider).filter((value): value is string => !!value))].sort((a, b) => a.localeCompare(b));
  const summaryResources = mode === "cluster" ? resources.filter((resource) => resource.archivedAt == null) : visible.filter((resource) => resource.archivedAt == null);
  const domains = mode === "cluster" && view
    ? view.domains
    : summaryResources.filter((resource) => resource.resourceType === "domain").map((resource) => ({
      id: resource.id,
      name: resource.name,
      hostname: resource.hostname,
    }));
  const knownCosts = mode === "cluster" && view
    ? view.costs
    : summaryResources.filter((resource) => resource.costAmount || resource.currency).map((resource) => ({
      resourceId: resource.id,
      name: resource.name,
      amount: resource.costAmount,
      currency: resource.currency,
    }));
  const providerRows = mode === "cluster" && view
    ? view.providers
    : [...summaryResources.reduce((map, resource) => {
      if (!resource.provider) return map;
      map.set(resource.provider, [...(map.get(resource.provider) ?? []), resource.id]);
      return map;
    }, new Map<string, string[]>())].map(([name, resourceIds]) => ({ name, resourceIds }));
  const notes = Array.isArray(knowledge) ? knowledge.filter((document) => isKnowledgeCategory(document.category) && document.archivedAt == null) : [];

  const declare = (projectPath: string, nextEnvironment: InfrastructureEnvironment, label = "") => {
    void api.declareProjectEnvironment({
      projectPath,
      environment: nextEnvironment,
      customLabel: label || undefined,
    }).then(() => load(), (err: unknown) => setError(errorText(err)));
  };

  const undeclare = (projectPath: string, nextEnvironment: InfrastructureEnvironment, label = "") => {
    void api.removeProjectEnvironment({
      projectPath,
      environment: nextEnvironment,
      customLabel: label || undefined,
    }).then(() => load(), (err: unknown) => setError(errorText(err)));
  };

  const archive = async (resource: InfrastructureResource) => {
    const ok = await confirm(() => ({
      title: tr("common.archive_c39c49", { p0: String(resource.name) }),
      description: tr("common.archiving_keeps_the_record_and_its_links_it"),
      confirmLabel: tr("common.archive_resource"),
      variant: "destructive",
    }));
    if (!ok) return;
    void api.archiveInfrastructure(resource.id).then(() => load(), (err: unknown) => setError(errorText(err)));
  };

  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col overflow-y-auto" data-testid="infrastructure-inventory">
      <header className="flex flex-col gap-3 px-4 py-4 sm:px-6">
        <div className="flex min-w-0 flex-wrap items-end justify-between gap-3">
          <div className="min-w-0">
            <h2 className="break-words text-lg font-semibold tracking-tight">
              {mode === "cluster" ? tr("common.infrastructure_9844cf", { p0: String(clusterName ?? tr("common.cluster")) }) : tr("common.infrastructure")}
            </h2>
            <p className="mt-1 max-w-3xl text-xs text-muted-foreground" data-testid={mode === "cluster" ? "cluster-infrastructure-status" : "infrastructure-status-note"}>
              {staticLabel(INFRASTRUCTURE_STATUS_NOTE)}
            </p>
          </div>
          <div className="flex flex-wrap gap-2">
            {onBack && (
              <Button type="button" variant="outline" size="sm" data-testid="infrastructure-back" onClick={onBack}><I18nText id="common.clusters" /></Button>
            )}
            {onOpenKnowledge && (
              <Button type="button" variant="outline" size="sm" data-testid="infrastructure-open-knowledge" onClick={onOpenKnowledge}><I18nText id="common.company_knowledge" /></Button>
            )}
            <Button type="button" size="sm" data-testid="infrastructure-create" onClick={() => setForm("new")}><I18nText id="projects.new_resource" /></Button>
          </div>
        </div>
        <div className="grid grid-cols-1 gap-2 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-6">
          <label className="flex min-w-0 flex-col gap-1 text-xs sm:col-span-2 xl:col-span-2"><I18nText id="common.search_49c266" />{" "}<input ref={searchRef} data-testid="infrastructure-search" className={fieldClass} value={query} onChange={(event) => setQuery(event.target.value)} placeholder={tr("projects.name_host_provider")} />
          </label>
          <Filter label={tr("common.type")} testId="infrastructure-filter-type" value={type} onChange={setType}>
            <option value=""><I18nText id="projects.any_type" /></option>
            {INFRASTRUCTURE_TYPES.map((item) => <option key={item} value={item}>{INFRASTRUCTURE_TYPE_LABELS[item]}</option>)}
          </Filter>
          {mode === "global" && (
            <Filter label={tr("common.cluster")} testId="infrastructure-filter-cluster" value={clusterFilter} onChange={setClusterFilter}>
              <option value=""><I18nText id="common.any_cluster" /></option>
              {clusters.map((cluster) => <option key={cluster.id} value={cluster.id}>{cluster.name}</option>)}
            </Filter>
          )}
          <Filter label={tr("common.project_985959")} testId="infrastructure-filter-project" value={projectFilter} onChange={setProjectFilter}>
            <option value=""><I18nText id="common.any_project" /></option>
            {projects.map((project) => <option key={project.path} value={project.path}>{project.name || project.path}</option>)}
          </Filter>
          <Filter label={tr("common.environment")} testId="infrastructure-filter-environment" value={environment} onChange={setEnvironment}>
            <option value=""><I18nText id="projects.any_environment" /></option>
            {INFRASTRUCTURE_ENVIRONMENTS.map((item) => <option key={item} value={item}>{INFRASTRUCTURE_ENVIRONMENT_LABELS[item]}</option>)}
          </Filter>
          <Filter label={tr("common.provider")} testId="infrastructure-filter-provider" value={provider} onChange={setProvider}>
            <option value=""><I18nText id="projects.any_provider" /></option>
            {providers.map((item) => <option key={item} value={item}>{item}</option>)}
          </Filter>
          <Filter label={tr("common.archived_bdb865")} testId="infrastructure-filter-archived" value={archived} onChange={(value) => setArchived(value as InfrastructureListQuery["archived"])}>
            <option value="active"><I18nText id="common.active" /></option>
            <option value="archived"><I18nText id="common.archived_bdb865" /></option>
            <option value="all"><I18nText id="projects.active_and_archived" /></option>
          </Filter>
        </div>
      </header>

      <div className={cn("flex flex-col gap-4 px-4 pb-8 sm:px-6", mode === "cluster" && "pt-1")} data-testid={mode === "cluster" ? "cluster-infrastructure" : undefined}>
        {error && (
          <p role="alert" data-testid="infrastructure-error" className="rounded-lg border border-destructive/40 px-3 py-2 text-sm text-destructive">
            {error}
            <Button type="button" variant="outline" size="sm" className="ml-2" onClick={() => load()}><I18nText id="common.retry" /></Button>
          </p>
        )}
        <section className="glass-surface grid grid-cols-1 gap-3 rounded-xl border p-4 md:grid-cols-2 xl:grid-cols-4">
          <Summary title={tr("projects.domains")} testId="infrastructure-domains" empty="No domain records.">
            {domains.map((domain) => (
              <li key={domain.id} className="break-words" title={domain.hostname ?? domain.name}>{domain.name}{domain.hostname ? ` · ${domain.hostname}` : ""}</li>
            ))}
          </Summary>
          <Summary title={tr("projects.providers")} testId="infrastructure-providers" empty="No provider is recorded.">
            {providerRows.map((row) => <li key={row.name} className="break-words">{row.name} · {row.resourceIds.length}</li>)}
          </Summary>
          <Summary title={tr("projects.known_costs")} testId="infrastructure-costs" empty="No cost is recorded.">
            {knownCosts.map((cost) => (
              <li key={cost.resourceId} className="break-words">{cost.name}: {formatRecordedCost(cost.amount, cost.currency)}</li>
            ))}
          </Summary>
          <div data-testid="infrastructure-unverified">
            <h3 className="text-xs font-semibold"><I18nText id="projects.unverified_status" /></h3>
            <p className="mt-1 text-sm text-muted-foreground">{staticLabel(INFRASTRUCTURE_STATUS_NOTE)}</p>
            {mode === "cluster" && view && (
              <p className="mt-1 text-xs text-muted-foreground">
                {view.unverified.notVerified}{" "}<I18nText id="projects.not_verified" />{" "}{view.unverified.unknown}{" "}<I18nText id="common.unknown_b23a6a" />{" "}</p>
            )}
          </div>
        </section>
        <p className="text-xs text-muted-foreground" data-testid="infrastructure-cost-note">{staticLabel(INFRASTRUCTURE_COST_NOTE)}</p>
        {truncated && <p className="text-xs text-muted-foreground"><I18nText id="projects.the_inventory_list_is_capped_narrow_the_search" /></p>}

        {mode === "cluster" && view && (
          <section className="rounded-xl border p-4" data-testid="infrastructure-projects">
            <h3 className="text-sm font-semibold"><I18nText id="projects.projects_and_expected_environments" /></h3>
            <p className="mt-1 text-xs text-muted-foreground"><I18nText id="projects.an_environment_here_is_where_you_expect_the" /></p>
            {view.projects.length === 0 ? (
              <p className="mt-2 text-sm text-muted-foreground"><I18nText id="projects.no_projects_are_linked_to_this_cluster_or" /></p>
            ) : view.projects.map((project) => (
              <ProjectEnvironments
                key={project.projectPath}
                projectPath={project.projectPath}
                name={project.name}
                membership={project.membership}
                environments={project.environments}
                resources={resources.filter((resource) => project.resourceIds.includes(resource.id) && resource.archivedAt == null)}
                customLabel={customLabel}
                onCustomLabel={setCustomLabel}
                onDeclare={(next, label) => declare(project.projectPath, next, label)}
                onRemove={(next, label) => undeclare(project.projectPath, next, label)}
                onLink={(resourceId, next, label) => {
                  void api.linkInfrastructureEnvironment(resourceId, {
                    projectPath: project.projectPath,
                    environment: next,
                    customLabel: label || undefined,
                  }).then(() => load(), (err: unknown) => setError(errorText(err)));
                }}
              />
            ))}
          </section>
        )}

        {mode === "global" && (
          <section className="rounded-xl border p-4" data-testid="infrastructure-environments">
            <h3 className="text-sm font-semibold"><I18nText id="projects.expected_environments" /></h3>
            <p className="mt-1 text-xs text-muted-foreground"><I18nText id="projects.choose_a_registered_project_and_record_where_you" /></p>
            <label className="mt-3 flex max-w-md flex-col gap-1 text-xs"><I18nText id="common.project_985959" />{" "}<select data-testid="infrastructure-environment-project" className={fieldClass} value={environmentProject} onChange={(event) => setEnvironmentProject(event.target.value)}>
                <option value=""><I18nText id="projects.choose_a_project" /></option>
                {projects.map((project) => <option key={project.path} value={project.path}>{project.name || project.path}</option>)}
              </select>
            </label>
            {environmentProject && (
              <EnvironmentControls
                environments={declared}
                customLabel={customLabel}
                onCustomLabel={setCustomLabel}
                onDeclare={(next, label) => declare(environmentProject, next, label)}
                onRemove={(next, label) => undeclare(environmentProject, next, label)}
              />
            )}
          </section>
        )}

        {mode === "cluster" && (
          <section className="rounded-xl border p-4" data-testid="infrastructure-knowledge">
            <h3 className="text-sm font-semibold"><I18nText id="common.knowledge" /></h3>
            <p className="mt-1 text-xs text-muted-foreground" data-testid="infrastructure-knowledge-note">{staticLabel(INFRASTRUCTURE_KNOWLEDGE_NOTE)}</p>
            {knowledge === "error" ? (
              <p className="mt-2 text-sm text-muted-foreground"><I18nText id="projects.knowledge_list_unavailable_that_does_not_confirm_or" /></p>
            ) : notes.length === 0 ? (
              <p className="mt-2 text-sm text-muted-foreground"><I18nText id="projects.no_architecture_or_deployment_notes_for_this_cluster" /></p>
            ) : (
              <ul className="mt-2 flex flex-col gap-1">
                {notes.map((document) => (
                  <li key={document.id}>
                    <button type="button" className="glass-nav-item max-w-full truncate rounded-md px-2 py-1 text-left text-sm" data-testid="infrastructure-knowledge-link" title={document.title} onClick={onShowKnowledge}>
                      {document.title}
                      <span className="ml-2 text-xs text-muted-foreground">{document.category}</span>
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </section>
        )}

        {loading && resources.length === 0 ? (
          <p data-testid="infrastructure-loading" className="text-sm text-muted-foreground"><I18nText id="projects.loading_infrastructure" /></p>
        ) : visible.length === 0 ? (
          <p data-testid="infrastructure-empty" className="rounded-xl border px-4 py-8 text-sm text-muted-foreground">{staticLabel(INFRASTRUCTURE_EMPTY_NOTE)}</p>
        ) : (
          <ul className="flex flex-col gap-3">
            {visible.map((resource) => (
              <ResourceCard
                key={resource.id}
                resource={resource}
                clusters={clusters}
                projects={projects}
                onEdit={() => setForm(resource)}
                onArchive={() => void archive(resource)}
                onRestore={() => void api.restoreInfrastructure(resource.id).then(() => load(), (err: unknown) => setError(errorText(err)))}
                onChanged={load}
                onError={(message) => setError(message)}
              />
            ))}
          </ul>
        )}
      </div>

      <div className="px-4 pb-6 sm:px-6 space-y-4">
        <InfraOperationsSection />
        <DeploymentRequestsPanel
          projects={projects}
          clusters={clusters}
          defaultClusterId={mode === "cluster" ? clusterId : undefined}
        />
      </div>

      <ResourceFormDialog
        open={form !== false}
        resource={form && form !== "new" ? form : null}
        clusterId={form === "new" ? clusterId : undefined}
        clusterName={form === "new" ? clusterName : undefined}
        onClose={() => setForm(false)}
        onSaved={() => {
          setForm(false);
          load();
        }}
      />
    </div>
  );
}

function ResourceCard({
  resource,
  clusters,
  projects,
  onEdit,
  onArchive,
  onRestore,
  onChanged,
  onError,
}: {
  resource: InfrastructureResource;
  clusters: Cluster[];
  projects: NamedProject[];
  onEdit: () => void;
  onArchive: () => void;
  onRestore: () => void;
  onChanged: () => void;
  onError: (message: string) => void;
}) {
  useUILocale();
  const [clusterPick, setClusterPick] = useState("");
  const [projectPick, setProjectPick] = useState("");
  const linkedClusters = new Set(resource.clusters.map((cluster) => cluster.id));
  const linkedProjects = new Set(resource.projects.map((project) => project.path));
  const fail = (err: unknown) => onError(errorText(err));
  return (
    <li className="glass-surface min-w-0 rounded-xl border p-4" data-testid="resource-card" data-resource-id={resource.id}>
      <div className="flex min-w-0 flex-wrap items-start justify-between gap-2">
        <div className="min-w-0">
          <h3 data-testid="resource-name" className="break-words text-sm font-semibold" title={resource.name}>{resource.name}</h3>
          <p data-testid="resource-type" className="text-xs text-muted-foreground">{INFRASTRUCTURE_TYPE_LABELS[resource.resourceType]}</p>
        </div>
        <p data-testid="resource-status" data-status={resource.status} className="rounded-md border px-2 py-1 text-xs text-muted-foreground">
          {infrastructureStatusLabel(resource.status)}
          <span className="sr-only"><I18nText id="projects.no_live_check" /></span>
        </p>
      </div>
      <dl className="mt-3 grid grid-cols-1 gap-2 text-xs sm:grid-cols-2">
        <div><dt className="text-muted-foreground"><I18nText id="common.provider" /></dt><dd className="break-words">{resource.provider ?? tr("projects.not_recorded")}</dd></div>
        <div><dt className="text-muted-foreground"><I18nText id="common.environment" /></dt><dd className="break-words">{infrastructureEnvironmentLabel(resource.environment, resource.environmentCustom)}</dd></div>
        <div><dt className="text-muted-foreground"><I18nText id="projects.hostname" /></dt><dd className="break-all">{resource.hostname ?? tr("projects.not_recorded")}</dd></div>
        <div><dt className="text-muted-foreground"><I18nText id="projects.ip_address" /></dt><dd className="break-all">{resource.ipAddress ?? tr("projects.not_recorded")}</dd></div>
        <div><dt className="text-muted-foreground"><I18nText id="projects.region" /></dt><dd className="break-words">{resource.region ?? tr("projects.not_recorded")}</dd></div>
        <div><dt className="text-muted-foreground"><I18nText id="projects.cost" /></dt><dd data-testid="resource-cost">{formatRecordedCost(resource.costAmount, resource.currency)}</dd></div>
      </dl>
      {resource.description && <p className="mt-2 break-words text-xs text-muted-foreground">{resource.description}</p>}
      {resource.clusters.length === 0 && <p className="mt-2 text-xs text-muted-foreground"><I18nText id="common.no_cluster" /></p>}
      <div className="mt-3 flex flex-wrap gap-1">
        {resource.clusters.map((cluster) => (
          <span key={cluster.id} data-testid="resource-cluster-chip" className="inline-flex max-w-full items-center gap-1 rounded-md border px-2 py-0.5 text-xs">
            <span className="truncate" title={cluster.name}>{cluster.name}</span>
            <button type="button" data-testid="resource-remove-cluster" className="focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring" aria-label={tr("common.remove_55fbe4", { p0: String(cluster.name) })} onClick={() => void api.unlinkInfrastructureCluster(resource.id, cluster.id).then(onChanged, fail)}><I18nText id="common.remove" />{" "}</button>
          </span>
        ))}
      </div>
      <div className="mt-2 flex flex-wrap gap-1">
        {resource.projects.map((project) => (
          <span key={project.path} data-testid="resource-project-chip" className="inline-flex max-w-full items-center gap-1 rounded-md border px-2 py-0.5 text-xs">
            <span className="truncate" title={project.name}>{project.name || project.path}</span>
            <button type="button" data-testid="resource-remove-project" className="focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring" aria-label={tr("common.remove_55fbe4", { p0: String(project.name || project.path) })} onClick={() => void api.unlinkInfrastructureProject(resource.id, project.path).then(onChanged, fail)}><I18nText id="common.remove" />{" "}</button>
          </span>
        ))}
      </div>
      {resource.environmentLinks.length > 0 && (
        <ul className="mt-2 text-xs text-muted-foreground">
          {resource.environmentLinks.map((link) => (
            <li key={`${link.projectPath}:${link.environment}:${link.customLabel}`}><I18nText id="projects.expected_with" />{" "}{link.projectName} · {infrastructureEnvironmentLabel(link.environment, link.customLabel)}
            </li>
          ))}
        </ul>
      )}
      {resource.archivedAt == null && (
        <div className="mt-3 flex flex-col gap-2 sm:flex-row sm:flex-wrap">
          <div className="flex min-w-0 flex-1 gap-1">
            <select data-testid="resource-assign-cluster" className={fieldClass} value={clusterPick} onChange={(event) => setClusterPick(event.target.value)} aria-label={tr("common.assign_to_a_cluster", { p0: String(resource.name) })}>
              <option value=""><I18nText id="projects.assign_to_cluster" /></option>
              {clusters.filter((cluster) => !linkedClusters.has(cluster.id)).map((cluster) => (
                <option key={cluster.id} value={cluster.id}>{cluster.name}</option>
              ))}
            </select>
            <Button type="button" size="sm" variant="outline" data-testid="resource-assign-cluster-submit" disabled={!clusterPick} onClick={() => void api.linkInfrastructureCluster(resource.id, clusterPick).then(() => { setClusterPick(""); onChanged(); }, fail)}><I18nText id="common.assign" />{" "}</Button>
          </div>
          <div className="flex min-w-0 flex-1 gap-1">
            <select data-testid="resource-assign-project" className={fieldClass} value={projectPick} onChange={(event) => setProjectPick(event.target.value)} aria-label={tr("common.assign_to_a_project", { p0: String(resource.name) })}>
              <option value=""><I18nText id="projects.assign_to_project" /></option>
              {projects.filter((project) => !linkedProjects.has(project.path)).map((project) => (
                <option key={project.path} value={project.path}>{project.name || project.path}</option>
              ))}
            </select>
            <Button type="button" size="sm" variant="outline" data-testid="resource-assign-project-submit" disabled={!projectPick} onClick={() => void api.linkInfrastructureProject(resource.id, projectPick).then(() => { setProjectPick(""); onChanged(); }, fail)}><I18nText id="common.assign" />{" "}</Button>
          </div>
        </div>
      )}
      <div className="mt-3 flex flex-wrap gap-2">
        <Button type="button" size="sm" variant="outline" data-testid="resource-edit" disabled={resource.archivedAt != null} onClick={onEdit}><I18nText id="common.edit" /></Button>
        {resource.archivedAt == null ? (
          <Button type="button" size="sm" variant="outline" data-testid="resource-archive" onClick={onArchive}><I18nText id="common.archive" /></Button>
        ) : (
          <Button type="button" size="sm" variant="outline" data-testid="resource-restore" onClick={onRestore}><I18nText id="common.restore" /></Button>
        )}
      </div>
    </li>
  );
}

function ProjectEnvironments({
  projectPath,
  name,
  membership,
  environments,
  resources,
  customLabel,
  onCustomLabel,
  onDeclare,
  onRemove,
  onLink,
}: {
  projectPath: string;
  name: string;
  membership: "cluster" | "resource-only";
  environments: { environment: InfrastructureEnvironment; customLabel: string }[];
  resources: InfrastructureResource[];
  customLabel: string;
  onCustomLabel: (value: string) => void;
  onDeclare: (environment: InfrastructureEnvironment, label?: string) => void;
  onRemove: (environment: InfrastructureEnvironment, label?: string) => void;
  onLink: (resourceId: string, environment: InfrastructureEnvironment, label?: string) => void;
}) {
  useUILocale();
  const [link, setLink] = useState("");
  const [linkEnvironment, setLinkEnvironment] = useState("");
  return (
    <div className="mt-3 rounded-lg border p-3" data-testid="infrastructure-project" data-path={projectPath}>
      <h4 className="break-words text-sm font-medium" title={name}>{name || projectPath}</h4>
      <p className="text-[11px] text-muted-foreground">{membership === "cluster" ? tr("m0.clusterProject") : tr("m0.linkedByResource")}</p>
      <EnvironmentControls
        environments={environments}
        customLabel={customLabel}
        onCustomLabel={onCustomLabel}
        onDeclare={onDeclare}
        onRemove={onRemove}
      />
      {environments.length > 0 && resources.length > 0 && (
        <div className="mt-2 flex flex-wrap items-end gap-1">
          <select data-testid="project-environment-link" className={fieldClass} value={link} onChange={(event) => setLink(event.target.value)} aria-label={`Link a resource for ${name}`}>
            <option value=""><I18nText id="projects.link_a_resource" /></option>
            {resources.map((resource) => <option key={resource.id} value={resource.id}>{resource.name}</option>)}
          </select>
          <select className={fieldClass} value={linkEnvironment} onChange={(event) => setLinkEnvironment(event.target.value)} aria-label={`Environment for ${name}`}>
            <option value=""><I18nText id="projects.declared_environment" /></option>
            {environments.map((item) => (
              <option key={`${item.environment}:${item.customLabel}`} value={`${item.environment}\t${item.customLabel}`}>
                {infrastructureEnvironmentLabel(item.environment, item.customLabel)}
              </option>
            ))}
          </select>
          <Button
            type="button"
            size="sm"
            variant="outline"
            data-testid="project-environment-link-submit"
            disabled={!link || !linkEnvironment}
            onClick={() => {
              const tab = linkEnvironment.indexOf("\t");
              const next = linkEnvironment.slice(0, tab);
              const label = linkEnvironment.slice(tab + 1);
              onLink(link, next as InfrastructureEnvironment, label);
              setLink("");
            }}
          ><I18nText id="projects.link" />{" "}</Button>
        </div>
      )}
    </div>
  );
}

function EnvironmentControls({
  environments,
  customLabel,
  onCustomLabel,
  onDeclare,
  onRemove,
}: {
  environments: { environment: InfrastructureEnvironment; customLabel: string }[];
  customLabel: string;
  onCustomLabel: (value: string) => void;
  onDeclare: (environment: InfrastructureEnvironment, label?: string) => void;
  onRemove: (environment: InfrastructureEnvironment, label?: string) => void;
}) {
  useUILocale();
  return (
    <div className="mt-2 flex flex-col gap-2">
      <div className="flex flex-wrap gap-1">
        {environments.map((item) => (
          <span key={`${item.environment}:${item.customLabel}`} data-testid="project-environment-chip" className="inline-flex items-center gap-1 rounded-md border px-2 py-0.5 text-xs">
            {infrastructureEnvironmentLabel(item.environment, item.customLabel)}
            <button type="button" className="focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring" aria-label={`Remove ${infrastructureEnvironmentLabel(item.environment, item.customLabel)}`} onClick={() => onRemove(item.environment, item.customLabel)}><I18nText id="common.remove" />{" "}</button>
          </span>
        ))}
        {environments.length === 0 && <span className="text-xs text-muted-foreground"><I18nText id="projects.no_expected_environment_recorded" /></span>}
      </div>
      <div className="flex flex-wrap gap-1">
        {STANDARD_ENVIRONMENTS.map((item) => (
          <Button key={item} type="button" size="sm" variant="outline" data-testid="project-environment-add" data-environment={item} onClick={() => onDeclare(item)}>
            {INFRASTRUCTURE_ENVIRONMENT_LABELS[item]}
          </Button>
        ))}
      </div>
      <div className="flex max-w-md gap-1">
        <input className={fieldClass} value={customLabel} onChange={(event) => onCustomLabel(event.target.value)} placeholder={tr("projects.custom_environment")} aria-label={tr("projects.custom_environment")} data-testid="project-environment-custom" />
        <Button type="button" size="sm" variant="outline" data-testid="project-environment-add-custom" disabled={!customLabel.trim()} onClick={() => onDeclare("custom", customLabel.trim())}><I18nText id="projects.add_custom" />{" "}</Button>
      </div>
    </div>
  );
}

function Summary({ title, testId, empty, children }: { title: string; testId: string; empty: string; children: ReactNode }) {
  useUILocale();
  const items = Array.isArray(children) ? children.filter(Boolean) : [children];
  const present = items.some((item) => item);
  return (
    <div data-testid={testId} className="min-w-0">
      <h3 className="text-xs font-semibold">{title}</h3>
      {present ? <ul className="mt-1 space-y-1 text-sm">{children}</ul> : <p className="mt-1 text-sm text-muted-foreground">{empty}</p>}
    </div>
  );
}

function Filter({
  label,
  testId,
  value,
  onChange,
  children,
}: {
  label: string;
  testId: string;
  value: string;
  onChange: (value: string) => void;
  children: ReactNode;
}) {
  useUILocale();
  return (
    <label className="flex min-w-0 flex-col gap-1 text-xs">
      {label}
      <select data-testid={testId} className={fieldClass} value={value} onChange={(event) => onChange(event.target.value)}>
        {children}
      </select>
    </label>
  );
}

const fieldClass = "h-9 w-full min-w-0 rounded-md border border-input bg-transparent px-2 text-sm focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring";
