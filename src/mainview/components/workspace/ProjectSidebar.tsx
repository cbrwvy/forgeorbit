import { t as tr } from "@/i18n/core";
import { I18nText, useLocale as useUILocale } from "@/i18n/react";
import { useState, type KeyboardEvent, type ReactNode } from "react";
import { BookOpen, FolderGit2, FolderPlus, Home, Layers, PanelLeft, Settings, Users } from "lucide-react";
import { CloneProjectDialog } from "@/components/kanban/CloneProjectDialog";
import { cn } from "@/lib/utils";
import {
  moveNavIndex,
  projectInitial,
  projectLabel,
  type WorkdirActivity,
  type WorkspaceSelection,
} from "@/lib/workspace";
import { PRIMARY_NAV, type NavTarget, type PrimaryNav } from "@/lib/navigation";
import type { Project } from "../../../shared/types.ts";

interface Props {
  compact?: boolean;
  projects: Project[];
  selection: WorkspaceSelection;
  /** The rail item that owns what is on screen; null when none does (Settings tools, pipelines). */
  active: NavTarget | null;
  collapsed: boolean;
  onCollapsedChange: (collapsed: boolean) => void;
  activity?: ReadonlyMap<string, WorkdirActivity>;
  /** Shown on Home: the same count as the title-bar "Needs you" indicator. */
  attentionCount?: number;
  onNavigate: (id: PrimaryNav) => void;
  onOpenSettings: () => void;
  onOpenProject: (path: string) => void;
  onAddFolder: () => void;
  onProjectsChanged: () => void;
}

const NAV_ICON: Record<PrimaryNav, ReactNode> = {
  home: <Home className="size-4 shrink-0" aria-hidden />,
  workspaces: <Layers className="size-4 shrink-0" aria-hidden />,
  team: <Users className="size-4 shrink-0" aria-hidden />,
  knowledge: <BookOpen className="size-4 shrink-0" aria-hidden />,
};

/**
 * Global rail: Home, Workspaces, AI Team and Knowledge, the project shortcuts,
 * and Settings at the bottom. Glass surface, one blur for the whole rail — rows
 * themselves are flat so a long list does not pay for per-row backdrop
 * filters. Collapsed state is an icon rail; names stay available as
 * accessible names and tooltips.
 */
export function ProjectSidebar({
  compact = false,
  projects,
  selection,
  active,
  collapsed,
  onCollapsedChange,
  activity = new Map(),
  attentionCount = 0,
  onNavigate,
  onOpenSettings,
  onOpenProject,
  onAddFolder,
  onProjectsChanged,
}: Props) {
  useUILocale();
  const [cloneOpen, setCloneOpen] = useState(false);

  const onNavKeyDown = (event: KeyboardEvent<HTMLElement>) => {
    const items = Array.from(event.currentTarget.querySelectorAll<HTMLButtonElement>("[data-workspace-nav]"));
    const current = items.indexOf(document.activeElement as HTMLButtonElement);
    const next = moveNavIndex(current, items.length, event.key);
    if (next == null) return;
    event.preventDefault();
    items[next]?.focus();
  };

  return (
    <>
    <div className={cn("relative h-full shrink-0", compact && "w-14")}>
    <aside
      className={cn(
        "shell-sidebar relative flex h-full shrink-0 flex-col",
        "transition-[width] duration-200 ease-out motion-reduce:transition-none",
        collapsed ? "w-14" : "w-60",
        compact && !collapsed && "absolute inset-y-0 left-0 z-40",
      )}
      data-testid="project-sidebar"
      data-overlay={compact && !collapsed ? "true" : undefined}
      data-collapsed={collapsed ? "true" : "false"}
    >
      <button
        type="button"
        onClick={() => onCollapsedChange(!collapsed)}
        aria-expanded={!collapsed}
        aria-label={collapsed ? tr("common.expand_project_sidebar") : tr("common.collapse_project_sidebar")}
        title={collapsed ? tr("common.expand_project_sidebar") : tr("common.collapse_project_sidebar")}
        data-testid="project-sidebar-toggle"
        className="glass-nav-item absolute -right-2.5 top-3 z-20 flex size-5 items-center justify-center rounded-full border bg-card text-muted-foreground shadow-sm hover:text-foreground"
      >
        <PanelLeft className="size-3.5" />
      </button>

      <nav
        aria-label={tr("nav.main")}
        className="flex min-h-0 flex-1 flex-col gap-1 overflow-hidden p-2 pt-3"
        onKeyDown={onNavKeyDown}
      >
        {PRIMARY_NAV.map((item) => (
          <SidebarItem
            key={item.id}
            icon={NAV_ICON[item.id]}
            label={tr(item.labelKey)}
            collapsed={collapsed}
            current={active === item.id}
            onClick={() => onNavigate(item.id)}
            testId={item.testId}
            nav={item.id}
            badge={item.id === "home" ? attentionCount : 0}
          />
        ))}

        <div className={cn("mt-3 px-2 pb-1 text-[11px] font-medium uppercase tracking-wider text-muted-foreground", collapsed && "sr-only")}><I18nText id="common.projects" />{" "}</div>
        <div className="flex min-h-0 flex-1 flex-col gap-0.5 overflow-y-auto">
          {projects.length === 0 && !collapsed && (
            <p className="px-2 py-1 text-xs text-muted-foreground"><I18nText id="navigation.no_projects_yet" /></p>
          )}
          {projects.map((project) => {
            const label = projectLabel(project);
            const signals = activity?.get?.(project.path);
            const running = signals?.running ?? 0;
            const blocked = signals?.blocked ?? 0;
            const current = selection.scope === "project" && selection.path === project.path;
            const lifecycleState = project.lifecycle?.state;
            const nonRunningState = lifecycleState && lifecycleState !== "running" ? lifecycleState : null;
            const nonRunningLabel = nonRunningState
              ? tr(`project_lifecycle.state.${nonRunningState}`)
              : "";
            const detail = [
              label,
              nonRunningLabel,
              running > 0 ? tr("common.running_2bf9aa", { p0: String(running) }) : "",
              blocked > 0 ? tr("common.blocked_f78fba", { p0: String(blocked) }) : "",
            ].filter(Boolean).join(", ");
            return (
              <button
                key={project.path}
                type="button"
                data-workspace-nav=""
                data-testid="project-nav-item"
                data-path={project.path}
                data-lifecycle={lifecycleState ?? undefined}
                aria-current={current ? "page" : undefined}
                aria-label={detail}
                title={project.path}
                onClick={() => onOpenProject(project.path)}
                className={cn(
                  "glass-nav-item flex min-h-control-sm w-full items-center gap-2 rounded-lg px-2 py-1 text-left text-sm",
                  collapsed && "justify-center px-0",
                )}
              >
                <span className="relative flex size-6 shrink-0 items-center justify-center rounded-md bg-foreground/5 text-[11px] font-semibold text-foreground">
                  {projectInitial(label)}
                  {collapsed && (running > 0 || blocked > 0 || nonRunningState) && (
                    <span
                      className={cn(
                        "absolute -right-0.5 -top-0.5 size-1.5 rounded-full",
                        nonRunningState === "invalid"
                          ? "bg-destructive"
                          : blocked > 0 || nonRunningState === "draining"
                            ? "bg-warning-solid"
                            : running > 0
                              ? "bg-success-solid"
                              : "bg-muted-foreground",
                      )}
                    />
                  )}
                </span>
                {!collapsed && (
                  <>
                    <span className="min-w-0 flex-1 truncate">{label}</span>
                    {nonRunningState && (
                      <span
                        className={cn(
                          "shrink-0 rounded px-1.5 py-0.5 text-[10px] font-medium",
                          nonRunningState === "invalid"
                            ? "bg-destructive/15 text-destructive"
                            : nonRunningState === "draining" || nonRunningState === "recovering"
                              ? "bg-warning/15 text-warning"
                              : "bg-muted text-muted-foreground",
                        )}
                        data-testid="project-nav-lifecycle-badge"
                      >
                        {nonRunningLabel}
                      </span>
                    )}
                    <ActivityDots running={running} blocked={blocked} />
                  </>
                )}
              </button>
            );
          })}
        </div>

        <div className="mt-1 flex shrink-0 flex-col gap-0.5 border-t border-[hsl(var(--glass-border)/var(--glass-border-alpha))] pt-1">
          <SidebarItem
            icon={<FolderPlus className="size-4 shrink-0" aria-hidden />}
            label={tr("common.add_project")}
            collapsed={collapsed}
            current={false}
            onClick={onAddFolder}
            testId="workspace-add-project"
          />
          <SidebarItem
            icon={<FolderGit2 className="size-4 shrink-0" aria-hidden />}
            label={tr("common.clone_repository")}
            collapsed={collapsed}
            current={false}
            onClick={() => setCloneOpen(true)}
            testId="workspace-clone"
          />
          <SidebarItem
            icon={<Settings className="size-4 shrink-0" aria-hidden />}
            label={tr("common.settings")}
            collapsed={collapsed}
            current={active === "tools"}
            onClick={onOpenSettings}
            testId="open-settings"
          />
        </div>
      </nav>
    </aside>
    </div>
    <CloneProjectDialog
      open={cloneOpen}
      onClose={() => setCloneOpen(false)}
      onCloned={() => onProjectsChanged()}
    />
    </>
  );
}

function ActivityDots({ running, blocked }: { running: number; blocked: number }) {
  useUILocale();
  if (running === 0 && blocked === 0) return null;
  return (
    <span className="flex shrink-0 items-center gap-1.5">
      {blocked > 0 && (
        <span className="flex items-center gap-1 text-[10px] tabular-nums text-warning" title={tr("common.blocked_f78fba", { p0: String(blocked) })}>
          <span className="size-1.5 rounded-full bg-warning-solid" aria-hidden />
          {blocked}
        </span>
      )}
      {running > 0 && (
        <span className="flex items-center gap-1 text-[10px] tabular-nums text-success" title={tr("common.running_2bf9aa", { p0: String(running) })}>
          <span className="size-1.5 rounded-full bg-success-solid" aria-hidden />
          {running}
        </span>
      )}
    </span>
  );
}

function SidebarItem({
  icon,
  label,
  collapsed,
  current,
  onClick,
  testId,
  nav,
  badge = 0,
}: {
  /** Set on the primary destinations; tests count these. */
  nav?: string;
  icon: ReactNode;
  label: string;
  collapsed: boolean;
  current: boolean;
  onClick: () => void;
  testId: string;
  /** Count shown at the right (a dot on the collapsed rail); 0 hides it. */
  badge?: number;
}) {
  useUILocale();
  return (
    <button
      type="button"
      data-workspace-nav=""
      data-testid={testId}
      data-primary-nav={nav}
      aria-current={current ? "page" : undefined}
      aria-label={badge > 0 ? `${label}, ${badge}` : label}
      title={badge > 0 ? `${label}, ${badge}` : label}
      onClick={onClick}
      className={cn(
        "glass-nav-item shell-nav-item relative flex min-h-control-sm w-full items-center gap-2.5 rounded-lg px-2 py-1 text-left text-sm text-foreground/85 hover:text-foreground aria-[current=page]:text-foreground [&>svg]:text-muted-foreground aria-[current=page]:[&>svg]:text-primary",
        collapsed && "justify-center px-0",
      )}
    >
      {icon}
      {!collapsed && <span className="min-w-0 flex-1 truncate">{label}</span>}
      {badge > 0 && (collapsed
        ? <span className="absolute right-1 top-1 size-2 rounded-full bg-warning-solid ring-2 ring-background" aria-hidden data-testid={`${testId}-badge`} />
        : <span className="min-w-5 rounded-full bg-warning/15 px-1.5 text-center text-[11px] font-semibold tabular-nums text-foreground ring-1 ring-warning/60" aria-hidden data-testid={`${testId}-badge`}>{badge}</span>)}
      {collapsed && <span className="sr-only">{label}</span>}
    </button>
  );
}
