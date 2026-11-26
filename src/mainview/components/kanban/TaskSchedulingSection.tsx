import { englishPluralSuffix, t as tr } from "@/i18n/core";

import { I18nText, useLocale as useUILocale } from "@/i18n/react";
import { useCallback, useEffect, useId, useState } from "react";
import { AlertTriangle, Link2, Loader2, X } from "lucide-react";
import { ApiError, api } from "@/lib/api";
import { PRIORITY_OPTIONS, PRIORITY_TONE } from "@/lib/batches";
import { Select } from "@/components/ui/select";
import { cn } from "@/lib/utils";
import { taskProjectPath } from "@/lib/workspace";
import type { TaskPriority, TaskSchedulingView } from "../../../shared/task-scheduling.ts";
import type { Task } from "../../../shared/types.ts";

function messageOf(reason: unknown): string {
  if (reason instanceof ApiError || reason instanceof Error) return reason.message;
  return String(reason);
}

/** "Ready" / "Waiting for …" / "Blocked: …", straight from the core. */
export function ReadinessLine({ view, titleOf }: { view: TaskSchedulingView; titleOf: (id: string) => string }) {
  useUILocale();
  const readiness = view.readiness;
  if (readiness.state === "ready") {
    return <p className="text-[11px] text-success" data-testid="scheduling-readiness" data-state="ready"><I18nText id="tasks.ready_every_dependency_is_done" /></p>;
  }
  if (readiness.state === "waiting") {
    return (
      <p className="text-[11px] text-muted-foreground" data-testid="scheduling-readiness" data-state="waiting"><I18nText id="tasks.waiting_for" />{" "}{readiness.on.map(titleOf).map((title) => `“${title}”`).join(", ")}{" "}<I18nText id="tasks.to_be_done" />{" "}</p>
    );
  }
  return (
    <ul className="space-y-0.5 text-[11px] text-danger" data-testid="scheduling-readiness" data-state="blocked">
      {readiness.by.map((item) => (
        <li key={item.taskId} className="flex items-start gap-1">
          <AlertTriangle className="mt-0.5 size-3 shrink-0" aria-hidden />
          <span className="min-w-0 break-words"><I18nText id="tasks.blocked" />{" "}{item.reason}</span>
        </li>
      ))}
    </ul>
  );
}

/**
 * Priority and structured dependencies of one task. Every change is a
 * `PUT …/scheduling`: the core validates it against the whole project
 * (self, other projects, cycles) and its answer is what's shown — a refused
 * link shows the core's message, a cycle with its path. Candidates are this
 * project's tasks only, never the task itself. Markdown "Depends on" text
 * is only flagged, never treated as a link.
 */
export function TaskSchedulingEditor({
  projectPath,
  taskId,
  schedule,
  onUpdated,
  compact = false,
}: {
  projectPath: string;
  taskId: string;
  /** The project's scheduling rows (`GET /project-manager/scheduling`). */
  schedule: TaskSchedulingView[];
  onUpdated: (view: TaskSchedulingView, affectsBatches: string[]) => void;
  compact?: boolean;
}) {
  useUILocale();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [adding, setAdding] = useState("");
  const ids = useId();
  const view = schedule.find((row) => row.taskId === taskId) ?? null;
  const titleOf = useCallback((id: string) => schedule.find((row) => row.taskId === id)?.title
    ?? view?.dependsOn.find((dep) => dep.taskId === id)?.title
    ?? id.slice(0, 8), [schedule, view]);

  if (!view) {
    return <p className="text-[11px] text-muted-foreground" data-testid="scheduling-unavailable"><I18nText id="tasks.this_task_isn_t_scheduled_in_this_project" /></p>;
  }

  const save = async (change: { priority?: TaskPriority; dependsOn?: string[] }) => {
    if (busy) return;
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      const result = await api.updateScheduling(projectPath, taskId, change);
      onUpdated(result.task, result.affectsBatches);
      if (result.affectsBatches.length > 0 && change.dependsOn) {
        setNotice("This task is in an approved batch. Its links no longer match what was approved, so the batch will hold it until you prepare a new batch.");
      }
    } catch (caught) {
      setError(messageOf(caught));
    } finally {
      setBusy(false);
    }
  };

  const linked = new Set(view.dependsOn.map((dep) => dep.taskId));
  const candidates = schedule.filter((row) => row.taskId !== taskId && !linked.has(row.taskId));
  const dependents = view.dependents.map((id) => ({ id, title: titleOf(id) }));

  return (
    <div className={cn("space-y-2 text-[11px]", compact && "space-y-1.5")} data-testid="scheduling-editor" data-task-id={taskId}>
      <div className="flex flex-wrap items-center gap-2">
        <label htmlFor={`${ids}-priority`} className="text-muted-foreground"><I18nText id="common.priority" /></label>
        <Select
          id={`${ids}-priority`}
          className={cn("h-7 w-auto min-w-[7rem] text-[11px]", PRIORITY_TONE[view.priority])}
          value={view.priority}
          disabled={busy}
          onChange={(event) => void save({ priority: event.target.value as TaskPriority })}
          data-testid="scheduling-priority"
        >
          {PRIORITY_OPTIONS.map((option) => <option key={option.id} value={option.id}>{option.label}</option>)}
        </Select>
        {busy && <Loader2 className="size-3 motion-safe:animate-spin text-muted-foreground" aria-label={tr("common.saving")} />}
      </div>

      <div>
        <p className="text-muted-foreground" id={`${ids}-deps`}><I18nText id="common.depends_on" /></p>
        {view.dependsOn.length === 0 ? (
          <p className="text-muted-foreground" data-testid="scheduling-no-deps"><I18nText id="tasks.no_dependencies" /></p>
        ) : (
          <ul className="mt-0.5 space-y-0.5" aria-labelledby={`${ids}-deps`}>
            {view.dependsOn.map((dep) => (
              <li key={dep.taskId} className="flex items-center gap-1.5" data-testid="scheduling-dep" data-dep-id={dep.taskId}>
                <Link2 className="size-3 shrink-0 text-muted-foreground" aria-hidden />
                <span className="min-w-0 flex-1 break-words">
                  {dep.title}
                  <span className={cn("ml-1", dep.done ? "text-success" : "text-muted-foreground")}>
                    {!dep.exists ? tr("common.deleted") : !dep.inProject ? tr("common.other_project") : dep.done ? tr("common.done_2ca002") : `(${dep.column ?? "?"})`}
                  </span>
                </span>
                <button
                  type="button"
                  className="shrink-0 rounded p-0.5 text-muted-foreground hover:text-foreground focus-visible:outline focus-visible:outline-2 focus-visible:outline-ring"
                  onClick={() => void save({ dependsOn: view.dependsOn.map((item) => item.taskId).filter((id) => id !== dep.taskId) })}
                  disabled={busy}
                  aria-label={tr("common.remove_dependency_on", { p0: String(dep.title) })}
                  data-testid="scheduling-dep-remove"
                >
                  <X className="size-3" aria-hidden />
                </button>
              </li>
            ))}
          </ul>
        )}
        {candidates.length > 0 && (
          <form
            className="mt-1 flex flex-wrap gap-1.5"
            onSubmit={(event) => {
              event.preventDefault();
              if (!adding) return;
              const next = [...view.dependsOn.map((dep) => dep.taskId), adding];
              setAdding("");
              void save({ dependsOn: next });
            }}
          >
            <label htmlFor={`${ids}-add`} className="sr-only"><I18nText id="tasks.add_a_dependency" /></label>
            <Select
              id={`${ids}-add`}
              className="h-7 min-w-0 flex-1 text-[11px]"
              value={adding}
              onChange={(event) => setAdding(event.target.value)}
              disabled={busy}
              data-testid="scheduling-add-select"
            >
              <option value=""><I18nText id="tasks.add_a_task_this_one_waits_for" /></option>
              {candidates.map((row) => <option key={row.taskId} value={row.taskId}>{row.title}</option>)}
            </Select>
            <button
              type="submit"
              className="h-7 rounded-md border border-input px-2 text-[11px] hover:bg-muted disabled:opacity-50"
              disabled={busy || !adding}
              data-testid="scheduling-add"
            ><I18nText id="common.add" />{" "}</button>
          </form>
        )}
      </div>

      {!compact && (
        <div>
          <p className="text-muted-foreground"><I18nText id="tasks.blocking" /></p>
          {dependents.length === 0 ? (
            <p className="text-muted-foreground"><I18nText id="tasks.no_task_waits_for_this_one" /></p>
          ) : (
            <p className="break-words" data-testid="scheduling-dependents">{dependents.map((item) => `“${item.title}”`).join(", ")}{" "}<I18nText id="common.wait" />{dependents.length === 1 ? englishPluralSuffix() : ""}{" "}<I18nText id="tasks.for_this_task" /></p>
          )}
        </div>
      )}

      <ReadinessLine view={view} titleOf={titleOf} />

      {view.markdownDependencies && (
        <p className="flex items-start gap-1 rounded-md border border-warning/40 bg-warning/10 px-2 py-1 text-warning" data-testid="scheduling-markdown-warning">
          <AlertTriangle className="mt-0.5 size-3 shrink-0" aria-hidden />
          <span><I18nText id="tasks.the_description_lists_dependencies_in_text_they_don" /></span>
        </p>
      )}
      {error && (
        <p role="alert" className="break-words rounded-md border border-danger/40 bg-danger/10 px-2 py-1 text-danger" data-testid="scheduling-error">{error}</p>
      )}
      {notice && (
        <p role="status" className="break-words text-warning" data-testid="scheduling-notice">{notice}</p>
      )}
    </div>
  );
}

/**
 * The scheduling section of Task Details. Fetched only when opened, so a
 * panel switch costs no request; a task outside a registered project says
 * so instead of guessing.
 */
export function TaskSchedulingSection({ task }: { task: Task }) {
  useUILocale();
  const [open, setOpen] = useState(false);
  const [schedule, setSchedule] = useState<TaskSchedulingView[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  // The owning project (a subfolder or worktree task schedules within it).
  const projectPath = taskProjectPath(task);

  const load = useCallback(async () => {
    if (!projectPath) {
      setSchedule(null);
      setError(tr("common.priorities_and_dependencies_are_available_for_tasks_of"));
      return;
    }
    try {
      const result = await api.listScheduling(projectPath);
      setSchedule(result.tasks);
      setError(null);
    } catch (caught) {
      setSchedule(null);
      setError(caught instanceof ApiError && (caught.status === 400 || caught.status === 404)
        ? tr("common.priorities_and_dependencies_are_available_for_tasks_of")
        : messageOf(caught));
    }
  }, [projectPath]);

  useEffect(() => {
    setSchedule(null);
    setError(null);
    if (open) void load();
  }, [task.id, projectPath, open, load]);

  if (task.pipelineParentId) return null;
  return (
    <details
      className="rounded-md border border-border/60 px-2 py-1.5"
      onToggle={(event) => setOpen((event.currentTarget as HTMLDetailsElement).open)}
      data-testid="task-scheduling-section"
    >
      <summary className="cursor-pointer text-[10px] uppercase tracking-wide text-muted-foreground"><I18nText id="common.priority_dependencies" /></summary>
      <div className="mt-2">
        {error ? (
          <p className="text-[11px] text-muted-foreground" data-testid="scheduling-load-error">{error}</p>
        ) : schedule == null ? (
          <p className="flex items-center gap-1 text-[11px] text-muted-foreground">
            <Loader2 className="size-3 motion-safe:animate-spin" aria-hidden /><I18nText id="common.loading" />{" "}</p>
        ) : (
          <TaskSchedulingEditor
            projectPath={projectPath ?? task.workdir}
            taskId={task.id}
            schedule={schedule}
            onUpdated={() => void load()}
          />
        )}
      </div>
    </details>
  );
}
