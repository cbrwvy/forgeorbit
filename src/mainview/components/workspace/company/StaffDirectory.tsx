import { t as tr } from "@/i18n/core";
import { I18nText, useLocale as useUILocale } from "@/i18n/react";
import { useMemo, useState } from "react";
import { Search } from "lucide-react";
import {
  DEFAULT_STAFF_FILTERS,
  NO_CLUSTER,
  ROLE_CATEGORY_LABELS,
  filterStaff,
  projectEntries,
  specializationOptions,
  staffFiltersActive,
  staffRows,
  type StaffFilters,
} from "@/lib/employees";
import { Button } from "@/components/ui/button";
import { EmptyState } from "@/components/ui/state";
import { Input } from "@/components/ui/input";
import { Select } from "@/components/ui/select";
import { ROLE_CATEGORIES, type Employee, type OrganizationTree } from "../../../../shared/employees/types.ts";
import { KindBadge, StatusBadge } from "./bits";

interface Props {
  employees: Employee[];
  tree: OrganizationTree;
  filters: StaffFilters;
  onFiltersChange: (filters: StaffFilters) => void;
  onOpenEmployee: (id: string) => void;
  onCreate: () => void;
}

const PAGE = 100;

/** Searchable staff list. Large teams show 100 rows at a time. */
export function StaffDirectory({ employees, tree, filters, onFiltersChange, onOpenEmployee, onCreate }: Props) {
  const { locale: uiLocale } = useUILocale();
  const [shown, setShown] = useState(PAGE);
  const rows = useMemo(() => staffRows(employees, tree), [employees, tree, uiLocale]);
  const matches = useMemo(() => filterStaff(rows, filters), [rows, filters, uiLocale]);
  const specializations = useMemo(() => specializationOptions(rows), [rows, uiLocale]);
  const projects = useMemo(() => projectEntries(tree), [tree, uiLocale]);
  const set = <K extends keyof StaffFilters>(key: K, value: StaffFilters[K]) => {
    setShown(PAGE);
    onFiltersChange({ ...filters, [key]: value });
  };

  return (
    <section aria-label={tr("employees.staff_directory")} data-testid="staff-directory" className="flex flex-col gap-3">
      <div className="grid grid-cols-1 gap-2 sm:grid-cols-2 lg:grid-cols-4">
        <label className="relative flex flex-col gap-1 text-xs sm:col-span-2">
          <span className="font-medium"><I18nText id="common.search_49c266" /></span>
          <Search className="pointer-events-none absolute bottom-2.5 left-2.5 size-4 text-muted-foreground" aria-hidden />
          <Input
            data-testid="staff-search"
            className="pl-8"
            value={filters.query}
            placeholder={tr("employees.name_title_specialization_project")}
            onChange={(e) => set("query", e.target.value)}
          />
        </label>
        <Filter label={tr("common.status")} id="status">
          <Select data-testid="staff-filter-status" value={filters.status} onChange={(e) => set("status", e.target.value as StaffFilters["status"])}>
            <option value="current"><I18nText id="employees.active_and_paused" /></option>
            <option value="active"><I18nText id="common.active" /></option>
            <option value="paused"><I18nText id="common.paused" /></option>
            <option value="archived"><I18nText id="common.archived_bdb865" /></option>
            <option value="all"><I18nText id="common.all" /></option>
          </Select>
        </Filter>
        <Filter label={tr("employees.assignment")} id="assignment">
          <Select data-testid="staff-filter-assignment" value={filters.assignment} onChange={(e) => set("assignment", e.target.value as StaffFilters["assignment"])}>
            <option value="all"><I18nText id="employees.assigned_and_unassigned" /></option>
            <option value="assigned"><I18nText id="common.assigned_to_a_project" /></option>
            <option value="unassigned"><I18nText id="common.unassigned" /></option>
          </Select>
        </Filter>
        <Filter label={tr("employees.role_category")} id="role">
          <Select data-testid="staff-filter-role" value={filters.roleCategory} onChange={(e) => set("roleCategory", e.target.value)}>
            <option value=""><I18nText id="employees.any_role" /></option>
            {ROLE_CATEGORIES.map((category) => <option key={category} value={category}>{ROLE_CATEGORY_LABELS[category]}</option>)}
          </Select>
        </Filter>
        <Filter label={tr("common.project_985959")} id="project">
          <Select data-testid="staff-filter-project" value={filters.projectPath} onChange={(e) => set("projectPath", e.target.value)}>
            <option value=""><I18nText id="common.any_project" /></option>
            {projects.map((entry) => <option key={entry.team.projectPath} value={entry.team.projectPath}>{entry.team.projectName}</option>)}
          </Select>
        </Filter>
        <Filter label={tr("common.cluster")} id="cluster">
          <Select data-testid="staff-filter-cluster" value={filters.cluster} onChange={(e) => set("cluster", e.target.value)}>
            <option value=""><I18nText id="common.any_cluster" /></option>
            <option value={NO_CLUSTER}><I18nText id="common.no_cluster" /></option>
            {tree.clusters.map((group) => <option key={group.cluster.id} value={group.cluster.id}>{group.cluster.name}</option>)}
          </Select>
        </Filter>
        <Filter label={tr("employees.specialization")} id="specialization">
          <Select data-testid="staff-filter-specialization" value={filters.specialization} onChange={(e) => set("specialization", e.target.value)}>
            <option value=""><I18nText id="employees.any_specialization" /></option>
            {specializations.map((item) => <option key={item} value={item}>{item}</option>)}
          </Select>
        </Filter>
      </div>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-xs text-muted-foreground" data-testid="staff-count" aria-live="polite">{tr("employees.staff_count", { shown: Math.min(shown, matches.length), total: matches.length })}
          {matches.length !== rows.length ? tr("common.on_record", { p0: String(rows.length) }) : ""}
        </p>
        <div className="flex gap-2">
          {staffFiltersActive(filters) && (
            <Button type="button" variant="ghost" size="sm" data-testid="staff-clear-filters" onClick={() => { setShown(PAGE); onFiltersChange(DEFAULT_STAFF_FILTERS); }}><I18nText id="employees.clear_filters" />{" "}</Button>
          )}
          <Button type="button" size="sm" data-testid="staff-create" onClick={onCreate}><I18nText id="employees.new_employee" /></Button>
        </div>
      </div>
      {rows.length === 0 ? (
        <EmptyState
          className="rounded-xl border"
          testId="staff-empty"
          title={tr("m7.empty.team.title")}
          description={tr("m7.empty.team.description")}
          action={<Button type="button" size="sm" data-testid="staff-empty-create" onClick={onCreate}>{tr("m7.empty.team.create")}</Button>}
        />
      ) : matches.length === 0 ? (
        <EmptyState
          className="rounded-xl border"
          testId="staff-no-match"
          title={tr("employees.no_one_matches_these_filters")}
          action={<Button type="button" size="sm" variant="outline" data-testid="staff-no-match-clear" onClick={() => { setShown(PAGE); onFiltersChange(DEFAULT_STAFF_FILTERS); }}>{tr("employees.clear_filters")}</Button>}
        />
      ) : (
        <ul className="flex flex-col gap-1.5" data-testid="staff-list">
          {matches.slice(0, shown).map(({ employee, clusterName }) => (
            <li key={employee.id}>
              <button
                type="button"
                data-testid="staff-row"
                data-employee-id={employee.id}
                onClick={() => onOpenEmployee(employee.id)}
                className="glass-nav-item flex w-full min-w-0 flex-wrap items-center gap-x-3 gap-y-1 rounded-xl border px-3 py-2 text-left"
              >
                <span className="min-w-0 flex-1 basis-40">
                  <span className="block truncate text-sm font-medium" title={employee.name}>{employee.name}{employee.displayName ? ` · ${employee.displayName}` : ""}</span>
                  <span className="block truncate text-xs text-muted-foreground" title={employee.jobTitle}>{employee.jobTitle}</span>
                </span>
                <span className="min-w-0 basis-40 truncate text-xs text-muted-foreground" title={employee.projectPath ?? undefined}>
                  {employee.projectPath
                    ? `${employee.projectName ?? tr("common.project_not_registered")}${clusterName ? ` · ${clusterName}` : ""}`
                    : tr("common.no_project")}
                </span>
                <span className="flex shrink-0 items-center gap-1.5">
                  <KindBadge employee={employee} />
                  <StatusBadge employee={employee} />
                </span>
              </button>
            </li>
          ))}
        </ul>
      )}
      {matches.length > shown && (
        <Button type="button" variant="outline" size="sm" className="self-center" data-testid="staff-show-more" onClick={() => setShown((n) => n + PAGE)}><I18nText id="common.show" />{" "}{Math.min(PAGE, matches.length - shown)}{" "}<I18nText id="employees.more" />{" "}</Button>
      )}
    </section>
  );
}

function Filter({ label, id, children }: { label: string; id: string; children: React.ReactNode }) {
  useUILocale();
  return (
    <label className="flex flex-col gap-1 text-xs" data-testid={`staff-filter-${id}-label`}>
      <span className="font-medium">{label}</span>
      {children}
    </label>
  );
}
