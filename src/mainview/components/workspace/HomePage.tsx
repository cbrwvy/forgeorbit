import { countLabel, t as tr } from "@/i18n/core";
import { useLocale as useUILocale } from "@/i18n/react";
import { ArrowRight, Clock, MessageSquare } from "lucide-react";
import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { Button } from "@/components/ui/button";
import { api } from "@/lib/api";
import { collectAttention, type AttentionTask } from "@/lib/attention";
import { shortenPath } from "@/lib/path-display";
import { columnLabel } from "@/lib/status-presenters";
import { cn } from "@/lib/utils";
import { useHandsoffOverview } from "@/lib/handsoff-events";
import { evaluateTaskAvailability, formatUtcTimestamp } from "../../../shared/task-availability.ts";
import { outsideProjectCount, projectLabel, taskProjectPath, type ProjectStats, type WorkspaceTask } from "@/lib/workspace";
import { attentionActionLabel, attentionKindLabel } from "./attention/AttentionPage";
import { PageHeader } from "./PageHeader";
import { ProjectDirectoryList } from "./WorkspaceOverview";
import { PlansWaiting } from "./manager/PlansWaiting";
import { GettingStarted } from "@/components/onboarding/GettingStarted";
import type { AiToolReadiness, GettingStartedStep } from "@/lib/getting-started";
import type { OwnerActionsPayload } from "../../../shared/owner-actions.ts";
import type { Project, Task } from "../../../shared/types.ts";

const ROW_LIMIT = 5;

interface Props {
  tasks: readonly Task[];
  projects: readonly Project[];
  summaries: ReadonlyMap<string, ProjectStats<WorkspaceTask>>;
  homeDir: string;
  /** Everything waiting on the Owner: the number the title bar and the rail show. */
  attentionCount: number;
  onOpenAttention: () => void;
  /** Opens a task that needs the Owner (same landing as the "Needs you" list). */
  onOpenAttentionTask: (task: Task) => void;
  onOpenTask: (task: Task) => void;
  onOpenProject: (path: string) => void;
  onOpenProjects: () => void;
  onOpenAllTasks: () => void;
  onOpenMissions: () => void;
  onAddFolder: () => void;
  /** Opens Head of PM for one project (a path) or for All projects (null). Sends nothing. */
  onOpenHead: (projectPath: string | null) => void;
  /** What the core holds for the Owner beyond the board; its pending plans are listed here. */
  ownerRows?: OwnerActionsPayload | null;
  /** Opens the plan card of a project (Plan and Execution → Project inbox). Approves nothing. */
  onReviewPlan?: (projectPath: string) => void;
  /** The one getting-started block (M7). Null/absent hides it. The goal step only focuses the target select below. */
  gettingStarted?: {
    steps: readonly GettingStartedStep[];
    ai: AiToolReadiness;
    onAddProject: () => void;
    onOpenAiSettings: () => void;
    onDismiss: () => void;
  } | null;
}

/**
 * Home (FO-UX-SIMPLIFY02-M3): what needs the Owner, what is running, the
 * projects, what finished, and the Head of PM entry. Every row is a task or a
 * project the app already holds; nothing is estimated and no progress is made up.
 * The running-mission count is one read of the missions list — when that read
 * fails the line is simply absent.
 */
export function HomePage({ tasks, projects, summaries, homeDir, attentionCount, onOpenAttention, onOpenAttentionTask, onOpenTask, onOpenProject, onOpenProjects, onOpenAllTasks, onOpenMissions, onAddFolder, onOpenHead, ownerRows = null, onReviewPlan, gettingStarted = null }: Props) {
  const { locale: uiLocale } = useUILocale();
  const localeTag: "en" | "ru" = uiLocale === "ru" ? "ru" : "en";
  const handsoffOverview = useHandsoffOverview();
  const board = useMemo(() => tasks.filter((task) => task.archivedAt == null && task.pipelineParentId == null), [tasks]);
  const scheduledSummary = useMemo(() => {
    const submittedTaskIds = new Set(
      (handsoffOverview?.runs ?? [])
        .filter((run) => run.finishedAt == null && run.status === "waiting" && run.state.waitKind === "scheduled")
        .map((run) => run.taskId),
    );
    const now = Date.now();
    let count = 0;
    let earliestMs = Number.POSITIVE_INFINITY;
    let earliestUtc: string | null = null;
    for (const task of board) {
      if (!task.availableFromUtc) continue;
      if (task.column !== "ready" && !submittedTaskIds.has(task.id)) continue;
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
  }, [board, handsoffOverview]);
  const attention = useMemo(() => collectAttention(tasks as readonly AttentionTask[]), [tasks]);
  const byId = useMemo(() => new Map(tasks.map((task) => [task.id, task])), [tasks]);
  const running = useMemo(() => board.filter((task) => task.column === "running").sort((a, b) => b.updatedAt - a.updatedAt), [board]);
  const finished = useMemo(() => board.filter((task) => task.column === "done" || task.column === "review").sort((a, b) => b.updatedAt - a.updatedAt).slice(0, ROW_LIMIT), [board]);
  const outside = outsideProjectCount(summaries, projects.map((project) => project.path));
  const nameOf = (task: Task) => {
    const path = taskProjectPath(task) ?? task.workdir;
    const project = projects.find((p) => p.path === path);
    return project ? projectLabel(project) : shortenPath(path, homeDir);
  };

  // The goal's target is always chosen, never guessed: nothing opens until a project (or All projects) is picked.
  const [target, setTarget] = useState("");
  const targetRef = useRef<HTMLSelectElement>(null);
  const askHead = () => {
    if (!target) { targetRef.current?.focus(); return; }
    onOpenHead(target === "__all__" ? null : target);
  };
  const planRows = ownerRows?.proposals ?? [];
  const projectName = (path: string) => { const project = projects.find((p) => p.path === path); return project ? projectLabel(project) : shortenPath(path, homeDir); };

  const [runningMissions, setRunningMissions] = useState<number | null>(null);
  useEffect(() => {
    let cancelled = false;
    void api.getOrchestrationMissions().then(
      (result) => { if (!cancelled) setRunningMissions(result.missions.filter((mission) => mission.status === "running").length); },
      () => { if (!cancelled) setRunningMissions(null); },
    );
    return () => { cancelled = true; };
  }, []);

  // Approvals, holds and memory proposals are not tasks; they are counted here and listed on the full page.
  const otherAttention = Math.max(0, attentionCount - attention.length);

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-stack overflow-y-auto px-4 pb-[calc(1.25rem+var(--shell-dock-clearance))] pt-5 sm:px-page [&>*]:shrink-0" data-testid="global-overview">
      <PageHeader className="px-0 pb-0 pt-0 sm:px-0" title={tr("nav.home")} titleTestId="home-title" subtitle={tr("home.subtitle")}>
        <Button type="button" size="sm" variant="outline" onClick={askHead} data-testid="home-ask-head-top">
          <MessageSquare className="size-3.5" aria-hidden />{tr("home.ask_head")}
        </Button>
      </PageHeader>

      {gettingStarted && (
        <GettingStarted {...gettingStarted} onChooseTarget={() => targetRef.current?.focus()} />
      )}

      <section className="surface-solid flex flex-wrap items-center justify-between gap-3 rounded-xl border px-4 py-3" data-testid="home-head" aria-labelledby="home-head-heading">
        <div className="min-w-0 flex-1 basis-56">
          <h2 id="home-head-heading" className="text-sm font-semibold">{tr("home.head_title")}</h2>
          <p className="text-[length:var(--text-secondary)] text-muted-foreground">{tr("home.head_hint")}</p>
        </div>
        <div className="flex min-w-0 flex-wrap items-end gap-2">
          <label className="flex min-w-0 flex-col gap-1 text-xs font-medium">
            {tr("m6.home.target")}
            <select
              ref={targetRef}
              value={target}
              onChange={(event) => setTarget(event.target.value)}
              className="min-w-0 max-w-64 rounded-md border border-border bg-background px-2 py-1.5 text-sm font-normal"
              data-testid="home-goal-target"
            >
              <option value="" disabled>{tr("m6.home.target_placeholder")}</option>
              {projects.map((project) => <option key={project.path} value={project.path}>{projectLabel(project)}</option>)}
              <option value="__all__">{tr("m6.home.target_all")}</option>
            </select>
          </label>
          <Button type="button" size="sm" onClick={askHead} disabled={!target} data-testid="home-ask-head">
            <MessageSquare className="size-3.5" aria-hidden />{tr("home.ask_head")}
          </Button>
        </div>
        {!target && <p className="basis-full text-[length:var(--text-secondary)] text-muted-foreground" data-testid="home-goal-target-hint">{tr("m6.home.target_needed")}</p>}
      </section>

      {planRows.length > 0 && onReviewPlan && (
        <div data-testid="home-plans">
          <PlansWaiting rows={planRows} projectName={projectName} onReview={onReviewPlan} />
        </div>
      )}

      <Section
        testId="home-attention"
        title={tr("home.attention")}
        action={
          <Button
            type="button" size="sm" variant="outline" onClick={onOpenAttention}
            data-testid="workspace-attention"
            aria-label={attentionCount > 0 ? `${tr("attention.title")}, ${attentionCount}` : tr("attention.title")}
          >
            {tr("home.see_all")}
            {attentionCount > 0 && <span className="min-w-5 rounded-full bg-warning/15 px-1.5 text-center text-[11px] font-semibold tabular-nums text-foreground ring-1 ring-warning/60" aria-hidden data-testid="workspace-attention-badge">{attentionCount}</span>}
            <ArrowRight className="size-3.5" aria-hidden />
          </Button>
        }
      >
        {attentionCount === 0 ? (
          <Empty testId="home-attention-empty">{tr("home.attention_empty")}</Empty>
        ) : (
          <>
            {attention.length > 0 && (
              <ul>
                {attention.slice(0, ROW_LIMIT).map((item) => {
                  const task = byId.get(item.taskId);
                  return (
                    <Row key={item.taskId} testId="home-attention-row">
                      <span className={cn("shrink-0 rounded-md px-2 py-0.5 text-xs font-medium ring-1", item.kind === "review" ? "bg-success/10 ring-success/50" : item.kind === "fx-paused" ? "bg-info/10 ring-info/50" : "bg-warning/10 ring-warning/60")}>{attentionKindLabel(item)}</span>
                      <RowText title={item.title} detail={task ? nameOf(task) : shortenPath(item.projectPath, homeDir)} />
                      <Button type="button" size="sm" variant="outline" disabled={!task} onClick={() => task && onOpenAttentionTask(task)} data-testid="home-attention-open">{attentionActionLabel(item.kind)}</Button>
                    </Row>
                  );
                })}
              </ul>
            )}
            {(attention.length > ROW_LIMIT || otherAttention > 0) && (
              <p className="px-4 py-2 text-xs text-muted-foreground" data-testid="home-attention-more">
                {attention.length > ROW_LIMIT && tr("home.more_tasks", { count: String(attention.length - ROW_LIMIT) })}
                {attention.length > ROW_LIMIT && otherAttention > 0 && " "}
                {otherAttention > 0 && tr("home.more_other", { count: String(otherAttention) })}
              </p>
            )}
          </>
        )}
      </Section>

      <Section
        testId="home-active"
        title={tr("home.active")}
        action={
          <div className="flex items-center gap-2">
            <span className="text-xs text-muted-foreground" data-testid="home-task-count">
              {countLabel(board.length, "task")}
            </span>
            <Button type="button" size="sm" variant="ghost" onClick={onOpenAllTasks} data-testid="global-open-board">{tr("home.open_tasks")}<ArrowRight className="size-3.5" aria-hidden /></Button>
          </div>
        }
      >
        {runningMissions != null && runningMissions > 0 && (
          <Row testId="home-missions-running">
            <RowText title={tr("home.missions_running", { count: String(runningMissions) })} />
            <Button type="button" size="sm" variant="ghost" onClick={onOpenMissions} data-testid="home-open-missions">{tr("home.open_missions")}</Button>
          </Row>
        )}
        {scheduledSummary.count > 0 && (
          <Row testId="home-scheduled-waiting">
            <Clock className="size-3.5 shrink-0 text-info" aria-hidden />
            <RowText
              title={tr("kanban.schedule.dashboard_waiting", { count: String(scheduledSummary.count) })}
              detail={scheduledSummary.earliestUtc ? tr("kanban.schedule.dashboard_next", { time: formatUtcTimestamp(scheduledSummary.earliestUtc, localeTag) }) : undefined}
            />
          </Row>
        )}
        {running.length === 0 ? (
          <Empty testId="home-active-empty">{tr("home.active_empty")}</Empty>
        ) : (
          <ul>
            {running.slice(0, ROW_LIMIT).map((task) => (
              <Row key={task.id} testId="home-active-row">
                <span className="size-1.5 shrink-0 rounded-full bg-success-solid" aria-hidden />
                <RowText title={task.title} detail={nameOf(task)} />
                <Button type="button" size="sm" variant="ghost" onClick={() => onOpenTask(task)} data-testid="home-active-open">{tr("home.open")}</Button>
              </Row>
            ))}
          </ul>
        )}
        {running.length > ROW_LIMIT && <p className="px-4 py-2 text-xs text-muted-foreground">{tr("home.more_tasks", { count: String(running.length - ROW_LIMIT) })}</p>}
      </Section>

      <section className="flex flex-col gap-2" data-testid="home-projects" aria-labelledby="home-projects-heading">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h2 id="home-projects-heading" className="ds-section-title">{tr("nav.projects")}</h2>
          <Button type="button" size="sm" variant="ghost" onClick={onOpenProjects} data-testid="home-open-projects">{tr("nav.workspaces")}<ArrowRight className="size-3.5" aria-hidden /></Button>
        </div>
        {outside > 0 && <p className="text-xs text-muted-foreground" data-testid="overview-outside-projects">{tr("home.outside", { count: String(outside) })}</p>}
        <ProjectDirectoryList projects={projects} summaries={summaries} homeDir={homeDir} onOpenProject={onOpenProject} onAddFolder={onAddFolder} />
      </section>

      <Section testId="home-recent" title={tr("home.recent")}>
        {finished.length === 0 ? (
          <Empty testId="home-recent-empty">{tr("home.recent_empty")}</Empty>
        ) : (
          <ul>
            {finished.map((task) => (
              <Row key={task.id} testId="home-recent-row">
                <span className="w-24 shrink-0 truncate text-[11px] uppercase tracking-wide text-muted-foreground">{columnLabel(task.column)}</span>
                <RowText title={task.title} detail={nameOf(task)} />
                <Button type="button" size="sm" variant="ghost" onClick={() => onOpenTask(task)} data-testid="home-recent-open">{tr("home.open")}</Button>
              </Row>
            ))}
          </ul>
        )}
      </Section>
    </div>
  );
}

function Section({ title, action, children, testId }: { title: string; action?: ReactNode; children: ReactNode; testId: string }) {
  const headingId = `${testId}-heading`;
  return (
    <section className="flex flex-col gap-2" data-testid={testId} aria-labelledby={headingId}>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 id={headingId} className="ds-section-title">{title}</h2>
        {action}
      </div>
      <div className="surface-solid overflow-hidden rounded-xl border">{children}</div>
    </section>
  );
}

function Row({ children, testId }: { children: ReactNode; testId: string }) {
  return <li className="flex list-none flex-wrap items-center gap-3 border-b border-[hsl(var(--glass-border)/var(--glass-border-alpha))] px-4 py-row last:border-b-0" data-testid={testId}>{children}</li>;
}

function RowText({ title, detail }: { title: string; detail?: string }) {
  return (
    <div className="min-w-0 flex-1 basis-40">
      <p className="truncate text-sm font-medium" title={title}>{title}</p>
      {detail && <p className="truncate text-[length:var(--text-secondary)] text-muted-foreground">{detail}</p>}
    </div>
  );
}

function Empty({ children, testId }: { children: ReactNode; testId: string }) {
  return <p className="px-4 py-3 text-sm text-muted-foreground" data-testid={testId}>{children}</p>;
}
