import { countLabel, formatNumber, t as tr } from "@/i18n/core";
import { I18nText, useLocale as useUILocale } from "@/i18n/react";
import { Cpu, Folder, Search, Shapes, Tag, X } from "lucide-react";
import { AgentIcon } from "@/components/kanban/AgentIcon";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { MultiSearchSelect } from "@/components/ui/multi-search-select";
import { Select } from "@/components/ui/select";
import { cn } from "@/lib/utils";
import { IDENTIFIER_INPUT_PROPS } from "@/lib/identifier-input";
import { taskTypeIcon } from "@/lib/task-type-icon";
import { columnLabel } from "@/lib/status-presenters";
import { COLUMNS, TASK_TYPES, type ColumnId, type Harness, type Project, type TaskType } from "@/i18n/options";

export type ArchivedView = "active" | "all" | "archived";

interface Props {
  textQuery: string;
  onTextQueryChange: (v: string) => void;
  repoFilter: string[];
  onRepoFilterChange: (v: string[]) => void;
  statusFilter: ColumnId[];
  onStatusFilterChange: (v: ColumnId[]) => void;
  archivedView: ArchivedView;
  onArchivedViewChange: (v: ArchivedView) => void;
  harnessFilter: string[];
  onHarnessFilterChange: (v: string[]) => void;
  typeFilter: TaskType[];
  onTypeFilterChange: (v: TaskType[]) => void;
  projects: Project[];
  harnesses: Harness[];
  /** Distinct harness ids referenced by any current task. Used to surface
   *  orphan ids (referenced by tasks but no longer registered) as filter
   *  options, so users can still narrow to historical runs of a removed
   *  harness. */
  taskAgentIds: string[];
  /** Attaches directly to the free-text search `<Input>` — App.tsx's
   *  Cmd/Ctrl+F handler focuses (and selects) the box through it when no
   *  task details panel is open. */
  searchInputRef?: React.Ref<HTMLInputElement>;
  /** Project workspace already chose the directory, so the repo multi-select
   *  would fight that scope. The control (and its "active filter" bit) hide;
   *  the stored `repoFilter` is left alone for the all-projects board. */
  hideRepoFilter?: boolean;
  visibleCount?: number;
  totalCount?: number;
  decisionFilter?: React.ReactNode;
}

const basename = (p: string) => {
  const trimmed = p.replace(/\/+$/, "");
  const idx = trimmed.lastIndexOf("/");
  return idx >= 0 ? trimmed.slice(idx + 1) : trimmed;
};

/** Filter pickers share the row: they grow and shrink between 8rem and 14rem
 *  instead of wrapping the last one onto a row of its own. */
const FILTER_FLUID = "min-w-[8rem] max-w-[14rem] flex-[1_1_9rem]";

export function KanbanFilters({
  textQuery,
  onTextQueryChange,
  repoFilter,
  onRepoFilterChange,
  statusFilter,
  onStatusFilterChange,
  archivedView,
  onArchivedViewChange,
  harnessFilter,
  onHarnessFilterChange,
  typeFilter,
  onTypeFilterChange,
  projects,
  harnesses,
  taskAgentIds,
  searchInputRef,
  hideRepoFilter = false,
  visibleCount,
  totalCount,
  decisionFilter,
}: Props) {
  useUILocale();
  const repoItems = projects.map((p) => ({
    value: p.path,
    label: p.name || basename(p.path) || p.path,
    hint: p.path,
  }));
  const statusItems = COLUMNS.map((c) => ({ value: c.id, label: columnLabel(c.id) } as const));
  // Order: enabled harnesses first, then disabled (marked with a hint), then
  // orphan ids referenced by tasks but no longer registered as a harness — so
  // historical runs of a removed harness stay filterable.
  const known = new Set(harnesses.map((h) => h.id));
  const enabledItems = harnesses.filter((h) => h.enabled).map((h) => ({
    value: h.id,
    label: h.label,
    icon: <AgentIcon kind={h.kind} className="size-3.5" />,
  }));
  const disabledItems = harnesses.filter((h) => !h.enabled).map((h) => ({
    value: h.id,
    label: h.label,
    hint: tr("common.disabled"),
    icon: <AgentIcon kind={h.kind} className="size-3.5" />,
  }));
  const orphanItems = taskAgentIds
    .filter((id) => !known.has(id))
    .map((id) => ({ value: id, label: id, hint: "removed" }));
  const harnessItems = [...enabledItems, ...disabledItems, ...orphanItems];
  const typeItems = TASK_TYPES.map((t) => {
    const Icon = taskTypeIcon(t.icon);
    return {
      value: t.id,
      label: t.label,
      icon: <Icon className={cn("size-3.5", t.iconClass)} />,
    };
  });
  const anyActive =
    textQuery !== ""
    || (!hideRepoFilter && repoFilter.length > 0)
    || statusFilter.length > 0
    || archivedView !== "active"
    || harnessFilter.length > 0
    || typeFilter.length > 0;

  // Active filters as removable chips: what narrows the board is visible at a glance, and each
  // one can be dropped on its own (FO-UX02-D stage 2). "Clear filters" resets all of them.
  const labelOf = (items: { value: string; label: string }[], value: string) => items.find((item) => item.value === value)?.label ?? value;
  const chips: { key: string; group: string; label: string; remove: () => void }[] = [
    ...(textQuery !== "" ? [{ key: "text", group: tr("tasks.search_tasks"), label: `“${textQuery}”`, remove: () => onTextQueryChange("") }] : []),
    ...harnessFilter.map((v) => ({ key: `h:${v}`, group: tr("uxfix.filter.harness"), label: labelOf(harnessItems, v), remove: () => onHarnessFilterChange(harnessFilter.filter((x) => x !== v)) })),
    ...(!hideRepoFilter ? repoFilter.map((v) => ({ key: `r:${v}`, group: tr("uxfix.filter.project"), label: labelOf(repoItems, v), remove: () => onRepoFilterChange(repoFilter.filter((x) => x !== v)) })) : []),
    ...statusFilter.map((v) => ({ key: `s:${v}`, group: tr("uxfix.filter.status"), label: labelOf(statusItems as { value: string; label: string }[], v), remove: () => onStatusFilterChange(statusFilter.filter((x) => x !== v)) })),
    ...typeFilter.map((v) => ({ key: `t:${v}`, group: tr("uxfix.filter.type"), label: labelOf(typeItems, v), remove: () => onTypeFilterChange(typeFilter.filter((x) => x !== v)) })),
    ...(archivedView !== "active" ? [{ key: "archived", group: tr("uxfix.filter.archive"), label: archivedView === "all" ? tr("common.all") : tr("tasks.archived_only"), remove: () => onArchivedViewChange("active") }] : []),
  ];
  const clearAll = () => {
    onTextQueryChange("");
    onRepoFilterChange([]);
    onStatusFilterChange([]);
    onArchivedViewChange("active");
    onHarnessFilterChange([]);
    onTypeFilterChange([]);
  };

  return (
    <div className="relative z-10 flex shrink-0 flex-col border-b border-[hsl(var(--glass-border)/var(--glass-border-alpha))]">
    <div className="flex flex-wrap items-center gap-2 px-4 py-2">
      <details data-testid="board-technical-filters" className="shrink-0">
        <summary className="cursor-pointer text-xs text-muted-foreground">{tr("manager.details")}</summary>
        <div className="mt-2">
      <MultiSearchSelect
        values={harnessFilter}
        onChange={onHarnessFilterChange}
        items={harnessItems}
        emptyLabel={tr("tasks.all_harnesses")}
        placeholder={tr("tasks.search_harnesses")}
        leadingIcon={<Cpu className="size-3.5" />}
        className={FILTER_FLUID}
      />
        </div>
      </details>
      <div className="relative min-w-[10rem] max-w-md flex-1">
        <Search className="pointer-events-none absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" aria-hidden />
        <Input
          {...IDENTIFIER_INPUT_PROPS}
          ref={searchInputRef}
          value={textQuery}
          onChange={(e) => onTextQueryChange(e.target.value)}
          placeholder={tr("uxfix.filter.searchPlaceholder")}
          title={tr("tasks.search_title_prompt_workdir_branch")}
          aria-label={tr("tasks.search_tasks")}
          className="pl-8"
          onKeyDown={(e) => {
            // Owner decision: Escape leaves the field but keeps the query
            // (no clear) — just blur so focus returns to the board.
            // `preventDefault` only, no `stopPropagation`: document-level
            // Escape listeners in this app coordinate through DOM markers
            // (see the comment block in RunPanel.tsx ~line 381-392), and
            // `ui/dialog.tsx` already honors `defaultPrevented`.
            if (e.key !== "Escape") return;
            // A dismissable layer above the board — any dialog (modal or
            // not, e.g. the usage popover, which carries no marker at all),
            // an open popover, or the floating quote pill — owns this
            // Escape first: the box yields WITHOUT `preventDefault` so that
            // layer's own listener closes it, and the NEXT Escape blurs the
            // box. Without this bail, a chord that focused the box while
            // such a layer was open would blur the box AND close the layer
            // on one keypress.
            if (document.querySelector('[role="dialog"], [data-popover-open], [data-quote-open]')) return;
            e.preventDefault();
            e.currentTarget.blur();
          }}
        />
      </div>
      {!hideRepoFilter && (
        <MultiSearchSelect
          values={repoFilter}
          onChange={onRepoFilterChange}
          items={repoItems}
          emptyLabel={tr("tasks.all_repos")}
          placeholder={tr("common.search_projects")}
          leadingIcon={<Folder className="size-3.5" />}
          className={FILTER_FLUID}
        />
      )}
      <MultiSearchSelect
        values={statusFilter}
        onChange={onStatusFilterChange}
        items={statusItems}
        emptyLabel={tr("common.all_statuses")}
        placeholder={tr("common.search_statuses")}
        leadingIcon={<Tag className="size-3.5" />}
        className={FILTER_FLUID}
      />
      <MultiSearchSelect
        values={typeFilter}
        onChange={onTypeFilterChange}
        items={typeItems}
        emptyLabel={tr("tasks.all_types")}
        placeholder={tr("tasks.search_types")}
        leadingIcon={<Shapes className="size-3.5" />}
        className={FILTER_FLUID}
      />
      <Select
        value={archivedView}
        onChange={(e) => onArchivedViewChange(e.target.value as ArchivedView)}
        className="w-auto max-w-full"
        title={tr("tasks.filter_by_archive_state")}
        aria-label={tr("tasks.filter_by_archive_state")}
      >
        <option value="active"><I18nText id="tasks.active_only" /></option>
        <option value="all"><I18nText id="common.all" /></option>
        <option value="archived"><I18nText id="tasks.archived_only" /></option>
      </Select>
      {anyActive && (
        <Button variant="ghost" size="sm" onClick={clearAll} data-testid="kanban-clear-filters">
          {tr("uxfix.filter.clear", { count: chips.length })}
        </Button>
      )}
      {decisionFilter}
      {visibleCount !== undefined && totalCount !== undefined && (
        <span className="ml-auto whitespace-nowrap text-xs text-muted-foreground" data-testid="board-task-count">
          {visibleCount === totalCount
            ? countLabel(totalCount, "task")
            : tr("common.of_tasks", { p0: formatNumber(visibleCount), p1: formatNumber(totalCount) })}
        </span>
      )}
    </div>
    {chips.length > 0 && (
      <ul className="flex flex-wrap items-center gap-1.5 px-4 pb-2" aria-label={tr("uxfix.filter.active")} data-testid="kanban-active-filters">
        {chips.map((chip) => (
          <li key={chip.key} className="inline-flex max-w-full items-center gap-1 rounded-full border border-border bg-muted/50 py-0.5 pl-2 pr-1 text-xs" data-testid="kanban-filter-chip">
            <span className="min-w-0 truncate"><span className="text-muted-foreground">{chip.group}:</span> {chip.label}</span>
            <button
              type="button"
              className="glass-nav-item grid size-4 shrink-0 place-items-center rounded-full"
              onClick={chip.remove}
              aria-label={tr("uxfix.filter.remove", { group: chip.group, label: chip.label })}
            >
              <X className="size-3" aria-hidden />
            </button>
          </li>
        ))}
      </ul>
    )}
    </div>
  );
}
