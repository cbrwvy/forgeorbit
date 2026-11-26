import { getLocale, plural, t as tr } from "@/i18n/core";
import { I18nText, useLocale as useUILocale } from "@/i18n/react";
import { Clock, Columns3 } from "lucide-react";
import { useMemo } from "react";
import { EnvironmentCard } from "@/components/workspace/environment/EnvironmentCard";
import { ProjectDocsCard } from "@/components/workspace/docs/ProjectDocsCard";
import { ProjectQueueSummary } from "@/components/handsoff/ProjectQueueSummary";
import { shortenPath } from "@/lib/path-display";
import { useHandsoffOverview } from "@/lib/handsoff-events";
import { evaluateTaskAvailability, formatUtcTimestamp, isTaskScheduledWaiting } from "../../../shared/task-availability.ts";
import {
  emptyProjectStats,
  isProjectTask,
  projectInitial,
  projectLabel,
  type ProjectStats,
  type WorkspaceTask,
} from "@/lib/workspace";
import { Button } from "@/components/ui/button";
import { EmptyState } from "@/components/ui/state";
import { columnLabel } from "@/lib/status-presenters";
import { COLUMNS, type ColumnId, type Project, type Task } from "../../../shared/types.ts";

const STAT_COLUMNS: { id: ColumnId }[] = COLUMNS.map((column) => ({ id: column.id }));

interface ProjectOverviewProps {
  project: Project;
  stats: ProjectStats<Task>;
  tasks?: readonly Task[];
  homeDir: string;
  onOpenBoard: () => void;
  onOpenEnvironment: () => void;
  onOpenTask: (task: Task) => void;
  onOpenActivity?: (projectPath: string) => void;
  /** Opens the project's Team tab (team and assignment proposals live there). */
  onOpenProjectTeam?: () => void;
}

/** Compact start page for one project. Every number comes from the tasks
 *  already loaded for the board — nothing here is estimated. */
export function ProjectOverview({ project, stats, tasks = [], homeDir, onOpenBoard, onOpenEnvironment, onOpenTask, onOpenActivity, onOpenProjectTeam }: ProjectOverviewProps) {
  const { locale: uiLocale } = useUILocale();
  const localeTag: "en" | "ru" = uiLocale === "ru" ? "ru" : "en";
  const handsoffOverview = useHandsoffOverview();
  const scheduledSummary = useMemo(() => {
    const submittedIds = new Set(
      (handsoffOverview?.runs ?? [])
        .filter((run) => run.finishedAt == null && run.status === "waiting" && run.state.waitKind === "scheduled")
        .map((run) => run.taskId),
    );
    const now = Date.now();
    const candidates = tasks.length > 0 ? tasks : stats.recent;
    let count = 0;
    let earliestMs = Number.POSITIVE_INFINITY;
    let earliestUtc: string | null = null;
    for (const task of candidates) {
      if (task.archivedAt != null || task.pipelineParentId != null) continue;
      if (!isProjectTask(task, project.path)) continue;
      if (!task.availableFromUtc) continue;
      if (task.column !== "ready" && !submittedIds.has(task.id)) continue;
      const evaluation = evaluateTaskAvailability(task, now);
      if (!evaluation.available && evaluation.availableFromUtc && evaluation.availableFromMs != null) {
        count += 1;
        if (evaluation.availableFromMs < earliestMs) {
          earliestMs = evaluation.availableFromMs;
          earliestUtc = evaluation.availableFromUtc;
        }
      }
    }
    return { count, earliestUtc };
  }, [tasks, stats.recent, project.path, handsoffOverview]);
  // `[&>*]:shrink-0`: the sections below are `overflow-hidden`, whose automatic
  // flex minimum height is 0 — without it they shrink to fit this container
  // (clipping the stat numbers and every card) instead of it scrolling.
  return (
    <div className="flex min-h-0 flex-1 flex-col gap-stack overflow-y-auto px-page pb-[calc(1.25rem+var(--shell-dock-clearance))] pt-5 [&>*]:shrink-0" data-testid="project-overview">
      <StatGrid stats={stats} />
      <ProjectQueueSummary
        projectPath={project.path}
        variant="card"
        onOpenTaskId={(taskId) => {
          const found = tasks.find((t) => t.id === taskId) ?? stats.recent.find((t) => t.id === taskId);
          if (found) onOpenTask(found);
        }}
      />
      {scheduledSummary.count > 0 && (
        <div
          className="surface-solid flex flex-wrap items-center gap-x-3 gap-y-1 rounded-xl border px-4 py-2.5 text-xs"
          data-testid="project-scheduled-summary"
        >
          <span className="inline-flex items-center gap-1.5 font-medium text-foreground">
            <Clock className="size-3.5 shrink-0 text-info" aria-hidden />
            {tr("kanban.schedule.dashboard_waiting", { count: String(scheduledSummary.count) })}
          </span>
          {scheduledSummary.earliestUtc && (
            <span className="text-muted-foreground" data-testid="project-scheduled-next">
              {tr("kanban.schedule.dashboard_next", { time: formatUtcTimestamp(scheduledSummary.earliestUtc, localeTag) })}
            </span>
          )}
        </div>
      )}
      {(onOpenActivity || onOpenProjectTeam) && (
        <div className="flex flex-wrap gap-2">
          {onOpenProjectTeam && <Button type="button" variant="outline" data-testid="project-open-team" onClick={onOpenProjectTeam}><I18nText id="m5.overview.open_team" /></Button>}
          {onOpenActivity && <Button type="button" variant="outline" data-testid="project-open-activity" onClick={() => onOpenActivity(project.path)}><I18nText id="activity.title" /></Button>}
        </div>
      )}
      <EnvironmentCard project={project} onOpen={onOpenEnvironment} />
      <ProjectDocsCard project={project} />
      {stats.archived > 0 && (
        <p className="text-xs text-muted-foreground" data-testid="project-stat-archived">
          {stats.archived}{" "}<I18nText id="common.archived" />{" "}{stats.archived === 1 ? tr("common.task_is") : tr("common.tasks_are")}{" "}<I18nText id="projects.hidden_from_the_active_board" />{" "}</p>
      )}
      <section className="surface-solid overflow-hidden rounded-xl border">
        <div className="flex items-center justify-between gap-3 border-b border-[hsl(var(--glass-border)/var(--glass-border-alpha))] px-4 py-2.5">
          <h3 className="text-sm font-medium"><I18nText id="projects.recent_tasks" /></h3>
          <Button type="button" variant="ghost" size="sm" onClick={onOpenBoard} data-testid="project-open-board">
            <Columns3 className="size-3.5" aria-hidden /><I18nText id="projects.open_board" />{" "}</Button>
        </div>
        {stats.recent.length === 0 ? (
          <EmptyState title={<I18nText id="projects.no_active_tasks_in_this_project" />} />
        ) : (
          <ul>
            {stats.recent.map((task) => (
              <li key={task.id} className="border-b border-[hsl(var(--glass-border)/var(--glass-border-alpha))] last:border-b-0">
                <button
                  type="button"
                  onClick={() => onOpenTask(task)}
                  data-testid="project-recent-task"
                  className="glass-nav-item flex w-full items-center gap-3 px-4 py-row text-left"
                >
                  <span className="w-16 shrink-0 text-[11px] uppercase tracking-wide text-muted-foreground">
                    {columnLabel(task.column)}
                  </span>
                  <span className="min-w-0 flex-1 truncate text-sm">{task.title}</span>
                  {task.column === "ready" && isTaskScheduledWaiting(task.availableFromUtc) && (
                    <span className="inline-flex shrink-0 items-center gap-1 text-[11px] text-muted-foreground" data-testid="project-recent-task-scheduled">
                      <Clock className="size-3 text-info" aria-hidden />
                      {tr("kanban.schedule.waiting")}
                    </span>
                  )}
                </button>
              </li>
            ))}
          </ul>
        )}
      </section>
      <p className="truncate text-xs text-muted-foreground" title={project.path}>
        {shortenPath(project.path, homeDir)}
      </p>
    </div>
  );
}

interface ProjectDirectoryListProps {
  projects: readonly Project[];
  summaries: ReadonlyMap<string, ProjectStats<WorkspaceTask>>;
  homeDir: string;
  onOpenProject: (path: string) => void;
  onAddFolder: () => void;
}

/** Registered projects with the task counts already on the board. Shared by
 *  Home and the Projects directory; nothing here is estimated. */
export function ProjectDirectoryList({ projects, summaries = new Map(), homeDir, onOpenProject, onAddFolder }: ProjectDirectoryListProps) {
  useUILocale();
  return (
    <>
      {projects.length === 0 ? (
        <EmptyState
          className="surface-solid rounded-xl border"
          title={<I18nText id="m7.empty.projects.title" />}
          description={<I18nText id="m7.empty.projects.description" />}
          testId="projects-empty"
          action={<Button type="button" size="sm" onClick={onAddFolder} data-testid="overview-add-project"><I18nText id="common.add_project" />{" "}</Button>}
        />
      ) : (
        <ul className="surface-solid overflow-hidden rounded-xl border" data-testid="overview-project-list">
          {projects.map((project) => {
            const label = projectLabel(project);
            const stats = summaries.get(project.path) ?? emptyProjectStats();
            const lifecycleState = project.lifecycle?.state;
            const nonRunningState = lifecycleState && lifecycleState !== "running" ? lifecycleState : null;
            return (
              <li key={project.path} className="border-b border-[hsl(var(--glass-border)/var(--glass-border-alpha))] last:border-b-0">
                <button
                  type="button"
                  onClick={() => onOpenProject(project.path)}
                  data-testid="overview-project"
                  data-path={project.path}
                  data-lifecycle={lifecycleState ?? undefined}
                  className="glass-nav-item flex w-full items-center gap-3 px-4 py-row text-left"
                >
                  <span className="flex size-8 shrink-0 items-center justify-center rounded-lg bg-foreground/5 text-xs font-semibold">
                    {projectInitial(label)}
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="flex items-center gap-2">
                      <span className="truncate text-sm font-medium">{label}</span>
                      {project.existsOnDisk === false && (
                        <span
                          className="shrink-0 rounded px-1.5 py-0.5 text-[10px] font-medium bg-warning/20 text-warning border border-warning/40"
                          data-testid="overview-project-missing-badge"
                        >
                          <I18nText id="projects.missing_badge" />
                        </span>
                      )}
                      {nonRunningState && (
                        <span
                          className={
                            nonRunningState === "invalid"
                              ? "shrink-0 rounded px-1.5 py-0.5 text-[10px] font-medium bg-destructive/15 text-destructive"
                              : nonRunningState === "draining" || nonRunningState === "recovering"
                                ? "shrink-0 rounded px-1.5 py-0.5 text-[10px] font-medium bg-warning/15 text-warning"
                                : "shrink-0 rounded px-1.5 py-0.5 text-[10px] font-medium bg-muted text-muted-foreground"
                          }
                          data-testid="overview-project-lifecycle-badge"
                        >
                          {tr(`project_lifecycle.state.${nonRunningState}`)}
                        </span>
                      )}
                    </span>
                    <span className="block truncate text-xs text-muted-foreground" title={project.path}>
                      {shortenPath(project.path, homeDir)}
                    </span>
                  </span>
                  <span className="hidden shrink-0 items-center gap-3 text-xs tabular-nums text-muted-foreground sm:flex">
                    <Count label={plural(getLocale(), stats.total, { one: tr("common.task"), few: tr("uxfix.tasks_few"), many: tr("uxfix.tasks_many"), other: tr("common.tasks") })} value={stats.total} />
                    {stats.columns.running > 0 && <Count label={tr("common.running_c071cf")} value={stats.columns.running} tone="success" />}
                    {stats.columns.blocked > 0 && <Count label={tr("common.blocked_6973dd")} value={stats.columns.blocked} tone="warning" />}
                  </span>
                </button>
              </li>
            );
          })}
        </ul>
      )}
    </>
  );
}

function Count({ label, value, tone }: { label: string; value: number; tone?: "success" | "warning" }) {
  useUILocale();
  return (
    <span className={tone === "success" ? "text-success" : tone === "warning" ? "text-warning" : undefined}>
      {value} {label}
    </span>
  );
}

function StatGrid({ stats }: { stats: ProjectStats }) {
  useUILocale();
  return (
    <dl
      className="surface-solid grid grid-cols-2 overflow-hidden rounded-xl border sm:grid-cols-3 lg:grid-cols-7"
      data-testid="project-stat-grid"
    >
      <Stat label={tr("common.tasks_b3a60e")} value={stats.total} testId="project-stat-total" />
      {STAT_COLUMNS.map((column) => (
        <Stat
          key={column.id}
          label={columnLabel(column.id)}
          value={stats.columns[column.id]}
          testId={`project-stat-${column.id}`}
        />
      ))}
    </dl>
  );
}

function Stat({ label, value, testId }: { label: string; value: number; testId: string }) {
  useUILocale();
  return (
    <div className="border-b border-r border-[hsl(var(--glass-border)/var(--glass-border-alpha))] px-3 py-2.5 last:border-r-0" data-testid={testId}>
      <dt className="text-[11px] text-muted-foreground">{label}</dt>
      <dd className="text-lg font-semibold tabular-nums tracking-tight">{value}</dd>
    </div>
  );
}
