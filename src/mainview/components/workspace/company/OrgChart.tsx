import { t as tr } from "@/i18n/core";
import { I18nText, useLocale as useUILocale } from "@/i18n/react";
import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from "react";
import { ChevronRight, CircleDashed, Crown, Folder, Layers, UserRound, Users } from "lucide-react";
import { allBranchIds, buildChart, chartKey, flattenChart, initialCollapsed, type ChartKind, type ChartRow } from "@/lib/employees";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import type { OrganizationTree } from "../../../../shared/employees/types.ts";

interface Props {
  tree: OrganizationTree;
  selectedEmployeeId: string | null;
  onOpenEmployee: (id: string) => void;
  onOpenProject: (path: string) => void;
  onOpenCluster: (id: string) => void;
  onAppointHead: () => void;
}

const ICON: Record<ChartKind, typeof Crown> = {
  owner: Crown,
  head: UserRound,
  "missing-head": CircleDashed,
  cluster: Layers,
  "no-cluster": Layers,
  project: Folder,
  manager: UserRound,
  worker: UserRound,
  unassigned: Users,
  detached: Users,
};

/**
 * Owner → Head → clusters → projects → workers as an indented
 * tree. A tree list reads the same at 390 px and at 1440 px, so there is no
 * wide diagram to scroll. It follows the WAI-ARIA tree keyboard model.
 * Clusters group projects for display. They are not managers.
 */
export function OrgChart({ tree, selectedEmployeeId, onOpenEmployee, onOpenProject, onOpenCluster, onAppointHead }: Props) {
  const { locale: uiLocale } = useUILocale();
  const root = useMemo(() => buildChart(tree), [tree, uiLocale]);
  const [collapsed, setCollapsed] = useState<Set<string>>(() => initialCollapsed(root));
  const [activeId, setActiveId] = useState("owner");
  const rowRefs = useRef(new Map<string, HTMLDivElement>());
  const pendingFocus = useRef<string | null>(null);

  const rows = useMemo(() => flattenChart(root, collapsed), [root, collapsed, uiLocale]);
  const ids = useMemo(() => new Set(rows.map((row) => row.node.id)), [rows, uiLocale]);
  const current = ids.has(activeId) ? activeId : "owner";

  useEffect(() => {
    if (pendingFocus.current && ids.has(pendingFocus.current)) {
      rowRefs.current.get(pendingFocus.current)?.focus();
      pendingFocus.current = null;
    }
  });

  const toggle = (id: string, expand: boolean) => {
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (expand) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const activate = (row: ChartRow) => {
    const { node } = row;
    if (node.employeeId) onOpenEmployee(node.employeeId);
    else if (node.kind === "project" && node.projectPath) onOpenProject(node.projectPath);
    else if (node.kind === "cluster" && node.clusterId) onOpenCluster(node.clusterId);
    else if (node.kind === "missing-head") onAppointHead();
    else if (row.expandable) toggle(node.id, !row.expanded);
  };

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>, row: ChartRow) => {
    const result = chartKey(rows, row.node.id, event.key);
    if (!result) return;
    event.preventDefault();
    if (result.focus) {
      setActiveId(result.focus);
      pendingFocus.current = result.focus;
      rowRefs.current.get(result.focus)?.focus();
    }
    if (result.expand) toggle(result.expand, true);
    if (result.collapse) toggle(result.collapse, false);
    if (result.activate) activate(row);
  };

  const branchIds = useMemo(() => allBranchIds(root), [root, uiLocale]);
  const anyClosed = branchIds.some((id) => collapsed.has(id));

  return (
    <section aria-label={tr("employees.organization_chart")} data-testid="org-chart" className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-xs text-muted-foreground" data-testid="org-chart-note"><I18nText id="employees.clusters_only_group_projects_they_have_no_manager" />{" "}</p>
        <Button
          type="button"
          variant="outline"
          size="sm"
          data-testid="org-chart-toggle-all"
          onClick={() => setCollapsed(anyClosed ? new Set() : new Set(branchIds.filter((id) => id !== "owner")))}
        >
          {anyClosed ? tr("common.expand_all") : tr("common.collapse_all")}
        </Button>
      </div>
      <div role="tree" aria-label={tr("common.organization")} className="flex flex-col rounded-xl border py-1" data-testid="org-chart-tree">
        {rows.map((row) => {
          const { node } = row;
          const Icon = ICON[node.kind];
          const selected = node.employeeId != null && node.employeeId === selectedEmployeeId;
          const placeholder = node.kind === "missing-head";
          return (
            <div
              key={node.id}
              role="treeitem"
              aria-level={row.depth + 1}
              aria-expanded={row.expandable ? row.expanded : undefined}
              aria-selected={selected}
              tabIndex={node.id === current ? 0 : -1}
              ref={(element) => { if (element) rowRefs.current.set(node.id, element); else rowRefs.current.delete(node.id); }}
              data-testid="org-chart-node"
              data-node-id={node.id}
              data-kind={node.kind}
              data-employee-id={node.employeeId ?? undefined}
              onFocus={() => setActiveId(node.id)}
              onKeyDown={(event) => onKeyDown(event, row)}
              className={cn(
                "glass-nav-item mx-1 flex min-w-0 items-center gap-1.5 rounded-lg py-1.5 pr-2 outline-none focus-visible:ring-2 focus-visible:ring-ring",
                selected && "glass-selected",
              )}
              style={{ paddingLeft: `${row.depth * 16 + 6}px` }}
            >
              {row.expandable ? (
                <button
                  type="button"
                  tabIndex={-1}
                  aria-label={`${row.expanded ? tr("common.collapse") : tr("common.expand")} ${node.label}`}
                  data-testid="org-chart-toggle"
                  className="flex size-5 shrink-0 items-center justify-center rounded text-muted-foreground hover:text-foreground"
                  onClick={() => toggle(node.id, !row.expanded)}
                >
                  <ChevronRight className={cn("size-3.5 transition-transform motion-reduce:transition-none", row.expanded && "rotate-90")} aria-hidden />
                </button>
              ) : <span className="size-5 shrink-0" aria-hidden />}
              <Icon className={cn("size-4 shrink-0", placeholder ? "text-warning" : "text-muted-foreground")} aria-hidden />
              <button
                type="button"
                tabIndex={-1}
                data-testid="org-chart-open"
                onClick={() => activate(row)}
                className={cn("min-w-0 flex-1 text-left", placeholder && "italic")}
              >
                <span className="block truncate text-sm font-medium" title={node.label}>{node.label}</span>
                {node.detail && <span className="block truncate text-xs text-muted-foreground" title={node.detail}>{node.detail}</span>}
              </button>
              {node.archived && <span className="shrink-0 rounded-full border px-1.5 text-[10px] text-muted-foreground"><I18nText id="common.archived" /></span>}
              {row.expandable && node.count > 0 && (
                <span className="shrink-0 text-[11px] tabular-nums text-muted-foreground" title={tr("employees.people_in_this_branch")} data-testid="org-chart-count">
                  {node.count}
                </span>
              )}
            </div>
          );
        })}
      </div>
    </section>
  );
}
