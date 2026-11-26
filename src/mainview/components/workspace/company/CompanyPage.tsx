import { ActivityJournal } from "./activity/ActivityJournal";
import { t as tr } from "@/i18n/core";
import { I18nText, useLocale as useUILocale } from "@/i18n/react";
import { useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent } from "react";
import { DEFAULT_STAFF_FILTERS, projectEntries, type StaffFilters } from "@/lib/employees";
import { cn } from "@/lib/utils";
import type { ProjectSurfacePage } from "@/lib/workspace";
import { Button } from "@/components/ui/button";
import { CompanyDashboard } from "./CompanyDashboard";
import { EmployeeCard } from "./EmployeeCard";
import { EmployeeFormDialog } from "./EmployeeFormDialog";
import { HeadFormDialog } from "./HeadFormDialog";
import { OrgChart } from "./OrgChart";
import { StaffDirectory } from "./StaffDirectory";
import { RoleCatalog } from "./RoleCatalog";
import { useCompanyData } from "./useCompanyData";
import { PageHeader } from "../PageHeader";

export interface CompanyFocus {
  activity?: boolean;
  employeeId?: string;
  projectPath?: string;
  /** Back to the dashboard: the sidebar entry was chosen again. */
  reset?: boolean;
  nonce: number;
}

interface Props {
  onOpenPortfolioManager: () => void;
  focus: CompanyFocus | null;
  onOpenProject: (path: string, page: ProjectSurfacePage) => void;
  onOpenCluster: (id: string) => void;
  onOpenTask: (taskId: string) => void;
}

type Tab = "dashboard" | "chart" | "staff" | "activity";

const TABS: { id: Tab; label: string }[] = [
  { id: "dashboard", get label() { return tr("common.dashboard"); } },
  { id: "chart", get label() { return tr("common.organization"); } },
  { id: "staff", get label() { return tr("common.staff"); } },
  { id: "activity", get label() { return tr("activity.title"); } },
];

/**
 * The Company page: dashboard, organization chart, staff directory, and one
 * employee card, plus the read-only Activity Journal. Other tabs read and write the employee API (FO-010A), task
 * assignments (FO-010C), and the cluster data it already exposes. No
 * employee action starts an AI process.
 */
export function CompanyPage({ onOpenPortfolioManager, focus, onOpenProject, onOpenCluster, onOpenTask }: Props) {
  const { locale: uiLocale } = useUILocale();
  const data = useCompanyData();
  const [tab, setTab] = useState<Tab>(focus?.activity ? "activity" : focus?.projectPath && !focus.employeeId ? "staff" : "dashboard");
  const [activityScope, setActivityScope] = useState<string | undefined>(focus?.activity ? focus.projectPath : undefined);
  const [employeeId, setEmployeeId] = useState<string | null>(focus?.employeeId ?? null);
  const [filters, setFilters] = useState<StaffFilters>(() => ({ ...DEFAULT_STAFF_FILTERS, projectPath: focus?.employeeId ? "" : focus?.projectPath ?? "" }));
  const [creating, setCreating] = useState(false);
  const [appointing, setAppointing] = useState(false);
  const tabRefs = useRef<Record<Tab, HTMLButtonElement | null>>({ dashboard: null, chart: null, staff: null, activity: null });
  const appliedNonce = useRef(focus?.nonce ?? -1);

  // A link from another page (a project's team, the project overview) can
  // arrive while this page is already open.
  useEffect(() => {
    if (!focus || focus.nonce === appliedNonce.current) return;
    appliedNonce.current = focus.nonce;
    if (focus.activity) {
      setEmployeeId(null);
      setActivityScope(focus.projectPath);
      setTab("activity");
    } else if (focus.reset) {
      setActivityScope(undefined);
      setEmployeeId(null);
      setTab("dashboard");
      setFilters(DEFAULT_STAFF_FILTERS);
    } else if (focus.employeeId) {
      setEmployeeId(focus.employeeId);
    } else if (focus.projectPath) {
      setEmployeeId(null);
      setTab("staff");
      setFilters({ ...DEFAULT_STAFF_FILTERS, projectPath: focus.projectPath });
    }
  }, [focus]);

  const projects = useMemo(() => (data.tree ? projectEntries(data.tree).map((entry) => entry.team) : []), [data.tree, uiLocale]);
  const openProject = useCallback((path: string) => onOpenProject(path, "overview"), [onOpenProject]);
  const openTeam = useCallback((path: string) => {
    setEmployeeId(null);
    setFilters({ ...DEFAULT_STAFF_FILTERS, projectPath: path });
    setTab("staff");
  }, []);

  const chooseTab = (next: Tab) => {
    setEmployeeId(null);
    setTab(next);
  };

  const onTabKey = (event: KeyboardEvent<HTMLButtonElement>) => {
    if (event.key !== "ArrowRight" && event.key !== "ArrowLeft" && event.key !== "Home" && event.key !== "End") return;
    event.preventDefault();
    const at = TABS.findIndex((item) => item.id === tab);
    const next = event.key === "Home" ? 0 : event.key === "End" ? TABS.length - 1 : (at + (event.key === "ArrowRight" ? 1 : -1) + TABS.length) % TABS.length;
    const id = TABS[next]!.id;
    chooseTab(id);
    tabRefs.current[id]?.focus();
  };

  const tree = data.tree;

  return (
    <div className="glass-surface flex min-h-0 min-w-0 flex-1 flex-col overflow-y-auto" data-testid="company-page">
      <PageHeader
        title={<I18nText id="team.title" />}
        titleTestId="company-title"
        subtitle={<I18nText id="headPm.unified.companyStructure" />}
      >
          <div role="tablist" aria-label={tr("employees.company_views")} className="ds-tabs">
            {TABS.map((item) => (
              <button
                key={item.id}
                type="button"
                role="tab"
                id={`company-tab-${item.id}`}
                aria-selected={tab === item.id}
                aria-controls="company-panel"
                tabIndex={tab === item.id ? 0 : -1}
                ref={(node) => { tabRefs.current[item.id] = node; }}
                data-testid={`company-tab-${item.id}`}
                className={cn("glass-nav-item ds-tab", tab === item.id && "glass-selected")}
                onClick={() => chooseTab(item.id)}
                onKeyDown={onTabKey}
              >
                {item.label}
              </button>
            ))}
          </div>
          {(tab !== "activity" || employeeId) && <Button type="button" variant="ghost" size="sm" data-testid="company-refresh" onClick={() => data.reload()}><I18nText id="common.refresh" /></Button>}
      </PageHeader>

      <div id="company-panel" role="tabpanel" aria-labelledby={`company-tab-${tab}`} className="flex flex-col gap-6 px-4 pb-8 sm:px-page">
        {data.error && (
          <p role="alert" data-testid="company-error" className="rounded-lg border border-destructive/40 px-3 py-2 text-sm text-destructive">{tab === "activity" ? tr("activity.unavailable") : data.error}</p>
        )}
        {!employeeId && tab === "activity" ? (
          <ActivityJournal key={activityScope ?? "company"} projectPath={activityScope} employees={data.all} projects={projects} onOpenEmployee={setEmployeeId} onOpenProject={onOpenProject} onOpenTask={onOpenTask} />
        ) : data.loading && !tree ? (
          <p data-testid="company-loading" className="text-sm text-muted-foreground"><I18nText id="employees.loading_the_organization" /></p>
        ) : !tree ? null : employeeId ? (
          <EmployeeCard
            employeeId={employeeId}
            data={data}
            onBack={() => setEmployeeId(null)}
            onChanged={data.reload}
            onOpenEmployee={setEmployeeId}
            onOpenProject={openProject}
            onOpenCluster={onOpenCluster}
            onOpenTask={onOpenTask}
            onOpenRoleCatalog={() => {
              setEmployeeId(null);
              chooseTab("dashboard");
            }}
          />
        ) : tab === "dashboard" ? (
          <CompanyDashboard
            onOpenPortfolioManager={onOpenPortfolioManager}
            data={data}
            onChanged={data.reload}
            onOpenEmployee={setEmployeeId}
            onOpenProject={openProject}
            onOpenCluster={onOpenCluster}
            onOpenTeam={openTeam}
            onCreateEmployee={() => setCreating(true)}
          />
        ) : tab === "chart" ? (
          <OrgChart
            tree={tree}
            selectedEmployeeId={null}
            onOpenEmployee={setEmployeeId}
            onOpenProject={openProject}
            onOpenCluster={onOpenCluster}
            onAppointHead={() => setAppointing(true)}
          />
        ) : (
          <StaffDirectory
            employees={data.all}
            tree={tree}
            filters={filters}
            onFiltersChange={setFilters}
            onOpenEmployee={setEmployeeId}
            onCreate={() => setCreating(true)}
          />
        )}
      </div>

      <EmployeeFormDialog
        open={creating}
        employee={null}
        projects={projects}
        defaultProjectPath={filters.projectPath}
        onClose={() => setCreating(false)}
        onSaved={(employee) => {
          setCreating(false);
          data.reload();
          setEmployeeId(employee.id);
        }}
      />
      <HeadFormDialog
        open={appointing}
        head={tree?.head ?? null}
        onClose={() => setAppointing(false)}
        onSaved={(head) => {
          setAppointing(false);
          data.reload();
          setEmployeeId(head.id);
        }}
      />
    </div>
  );
}
