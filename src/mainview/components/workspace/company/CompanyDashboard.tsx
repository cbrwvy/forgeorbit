import { t as tr } from "@/i18n/core";
import { I18nText, useLocale as useUILocale } from "@/i18n/react";
import { HeadPortfolioBinding } from "./HeadPortfolioBinding";
import { useMemo, useState } from "react";
import { companyMetrics, projectEntries } from "@/lib/employees";
import { Button } from "@/components/ui/button";
import { FORGEORBIT_COMPANY } from "../../../../shared/clusters/types.ts";
import { OWNER_NODE } from "../../../../shared/employees/types.ts";
import { AssignmentProposals } from "./AssignmentProposals";
import { HiringProposals } from "./HiringProposals";
import { Metric } from "./bits";
import { HeadFormDialog } from "./HeadFormDialog";
import { RoleCatalog } from "./RoleCatalog";
import type { CompanyData } from "./useCompanyData";

interface Props {
  onOpenPortfolioManager: () => void;
  data: CompanyData;
  onChanged: () => void;
  onOpenEmployee: (id: string) => void;
  onOpenProject: (path: string) => void;
  onOpenCluster: (id: string) => void;
  onOpenTeam: (projectPath: string) => void;
  onCreateEmployee: () => void;
  onOpenRoleCatalog?: () => void;
}

/**
 * Counts and structure read from the employee and cluster APIs. A count of
 * employees is a count of identity records, never of running AI processes.
 * Nothing here is estimated, scored, or ranked.
 */
export function CompanyDashboard({
  onOpenPortfolioManager,
  data,
  onChanged,
  onOpenEmployee,
  onOpenProject,
  onOpenCluster,
  onOpenTeam,
  onCreateEmployee,
  onOpenRoleCatalog,
}: Props) {
  const { locale: uiLocale } = useUILocale();
  const { tree, all } = data;
  const [headOpen, setHeadOpen] = useState(false);
  const metrics = useMemo(() => (tree ? companyMetrics(all, tree) : null), [all, tree, uiLocale]);
  const entries = useMemo(() => (tree ? projectEntries(tree) : []), [tree, uiLocale]);
  if (!tree || !metrics) return null;

  return (
    <div className="flex flex-col gap-6" data-testid="company-dashboard">
      <div className="grid grid-cols-[repeat(auto-fit,minmax(min(100%,14rem),1fr))] gap-3">
        <section className="min-w-0 rounded-xl border p-4" aria-label={tr("common.company")} data-testid="company-card">
          <h2 className="text-[11px] uppercase tracking-wide text-muted-foreground"><I18nText id="common.company" /></h2>
          <p className="mt-1 truncate text-lg font-semibold" data-testid="company-name" title={tree.company.name}>{tree.company.name || FORGEORBIT_COMPANY.name}</p>
          <p className="mt-1 text-xs text-muted-foreground">{tr("employees.company_scope_counts", { clusters: metrics.clusters, projects: metrics.projects })}</p>
        </section>
        <section className="min-w-0 rounded-xl border p-4" aria-label={tr("common.owner")} data-testid="company-owner">
          <h2 className="text-[11px] uppercase tracking-wide text-muted-foreground"><I18nText id="common.owner_ceo" /></h2>
          <p className="mt-1 text-lg font-semibold"><I18nText id="common.you" /></p>
          <p className="mt-1 text-xs text-muted-foreground" data-testid="company-owner-note">{tree.owner.note === OWNER_NODE.note ? tr("m0.ownerNote") : tree.owner.note}</p>
        </section>
        <section className="min-w-0 rounded-xl border p-4" aria-label={tr("common.head_of_project_management")} data-testid="company-head">
          <h2 className="text-[11px] uppercase tracking-wide text-muted-foreground"><I18nText id="common.head_of_project_management" /></h2>
          {tree.head ? (
            <>
              <p className="mt-1 break-words text-lg font-semibold" data-testid="company-head-name">{tree.head.name}</p>
              {tree.head.description && <p className="mt-1 line-clamp-3 break-words text-xs text-muted-foreground" data-testid="company-head-description">{tree.head.description}</p>}
              <div className="mt-2 flex flex-wrap gap-2">
                <Button type="button" variant="outline" size="sm" data-testid="company-head-open" onClick={() => onOpenEmployee(tree.head!.id)}><I18nText id="employees.open_card" /></Button>
                <Button type="button" variant="outline" size="sm" data-testid="company-head-edit" onClick={() => setHeadOpen(true)}><I18nText id="common.edit" /></Button>
              </div>
            </>
          ) : (
            <>
              <p className="mt-1 text-lg font-semibold text-muted-foreground" data-testid="company-head-empty"><I18nText id="employees.not_appointed" /></p>
              <p className="mt-1 text-xs text-muted-foreground"><I18nText id="employees.you_name_the_head_yourself_the_name_is" /></p>
              <Button type="button" size="sm" className="mt-2" data-testid="company-appoint-head" onClick={() => setHeadOpen(true)}><I18nText id="employees.appoint_head" /></Button>
            </>
          )}
          <HeadPortfolioBinding head={tree.head} refreshToken={data.version} onOpenManager={onOpenPortfolioManager} />
        </section>
      </div>

      <p className="text-xs text-muted-foreground" data-testid="company-identity-note"><I18nText id="employees.employees_are_identity_records_a_name_a_title" />{" "}</p>

      <dl className="grid grid-cols-2 gap-3 sm:grid-cols-3 xl:grid-cols-5" data-testid="company-metrics">
        <Metric id="managers" label={tr("headPm.unified.legacy")} value={metrics.projectManagers} />
        <Metric id="workers" label={tr("employees.ai_employees")} value={metrics.workers} />
        <Metric id="active" label={tr("common.active")} value={metrics.active} />
        <Metric id="paused" label={tr("common.paused")} value={metrics.paused} />
        <Metric id="archived" label={tr("common.archived_bdb865")} value={metrics.archived} />
        <Metric id="unassigned" label={tr("common.employees_without_a_project")} value={metrics.unassigned} />
        <Metric id="detached" label={tr("employees.detached_employees")} value={metrics.detached} hint={tr("common.project_no_longer_registered")} />
        <Metric id="projects" label={tr("common.projects")} value={metrics.projects} />
      </dl>

      <HiringProposals refreshToken={data.version} onOpenProject={onOpenProject} onOpenEmployee={onOpenEmployee} onChanged={onChanged} />

      <AssignmentProposals refreshToken={data.version} onOpenProject={onOpenProject} onOpenEmployee={onOpenEmployee} onChanged={onChanged} />

      <section className="flex flex-col gap-4 rounded-xl border p-4" aria-label={tr("employees.role_catalog")} data-testid="company-role-catalog">
        <RoleCatalog
          employees={all}
          onOpenEmployee={onOpenEmployee}
          onRefreshCompany={onChanged}
        />
      </section>

      <div>
        <Button type="button" variant="outline" size="sm" data-testid="company-create-employee" onClick={onCreateEmployee}><I18nText id="employees.new_employee" /></Button>
      </div>

      <section className="flex flex-col gap-2" aria-label={tr("employees.structure")} data-testid="company-structure">
        <h2 className="text-sm font-semibold"><I18nText id="employees.clusters_and_projects" /></h2>
        {entries.length === 0 ? (
          <p data-testid="company-structure-empty" className="rounded-xl border px-4 py-6 text-sm text-muted-foreground"><I18nText id="employees.no_registered_projects_yet_add_a_project_to" /></p>
        ) : (
          <ul className="flex flex-col gap-1.5">
            {entries.map((entry) => (
              <li key={entry.team.projectPath} className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1 rounded-xl border px-3 py-2" data-testid="company-project-row" data-project-path={entry.team.projectPath}>
                <div className="min-w-0 flex-1 basis-48">
                  <button type="button" className="glass-nav-item block max-w-full truncate rounded px-1 text-sm font-medium" title={entry.team.projectPath} data-testid="company-project-open" onClick={() => onOpenProject(entry.team.projectPath)}>
                    {entry.team.projectName}
                  </button>
                  <p className="truncate px-1 text-xs text-muted-foreground">
                    {entry.cluster ? (
                      <button type="button" className="underline-offset-2 hover:underline" data-testid="company-project-cluster" onClick={() => onOpenCluster(entry.cluster!.id)}>{entry.cluster.name}</button>
                    ) : tr("common.no_cluster")}
                  </p>
                </div>
                <div className="min-w-0 basis-44 text-sm">
                  {entry.team.projectManager ? (
                    <button type="button" className="glass-nav-item max-w-full truncate rounded px-1" data-testid="company-project-manager" onClick={() => onOpenEmployee(entry.team.projectManager!.id)}>
                      {entry.team.projectManager.name} · {tr("headPm.unified.legacy")}
                    </button>
                  ) : null}
                  <p className="px-1 text-xs text-muted-foreground">{entry.team.employees.length} {entry.team.employees.length === 1 ? "employee" : "employees"}</p>
                </div>
                <div className="flex shrink-0 gap-1.5">
                  <Button type="button" variant="outline" size="sm" data-testid="company-project-team" onClick={() => onOpenTeam(entry.team.projectPath)}><I18nText id="employees.team" /></Button>
                </div>
              </li>
            ))}
          </ul>
        )}
      </section>

      <HeadFormDialog
        open={headOpen}
        head={tree.head}
        onClose={() => setHeadOpen(false)}
        onSaved={() => {
          setHeadOpen(false);
          onChanged();
        }}
      />
    </div>
  );
}
