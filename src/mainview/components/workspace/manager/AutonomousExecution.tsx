import { AutonomyBadge } from "./AutonomySection";
import { englishPluralSuffix, t as tr } from "@/i18n/core";

import { I18nText, useLocale as useUILocale } from "@/i18n/react";
import { useCallback, useEffect, useId, useMemo, useRef, useState } from "react";
import { ListChecks, Loader2, Plus, RotateCcw, Search, X } from "lucide-react";
import { ApiError, api } from "@/lib/api";
import { subscribeBatchEvents } from "@/lib/batch-events";
import { subscribePipelineGlobalEvents } from "@/lib/pipeline-events";
import { BATCH_STATUS_LABEL, BATCH_STATUS_TONE, MONITOR_GROUPS, batchCounts, formatTime } from "@/lib/batches";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { isProjectTask } from "@/lib/workspace";
import { BatchDetail } from "./BatchDetail";
import { SCHEDULING_LIMITS, type BatchView, type TaskSchedulingView } from "../../../../shared/task-scheduling.ts";
import type { TaskProposal } from "../../../../shared/project-manager.ts";
import { type Project, type Task } from "../../../../shared/types.ts";
import { columnLabel } from "@/lib/status-presenters";

function messageOf(reason: unknown): string {
  if (reason instanceof ApiError || reason instanceof Error) return reason.message;
  return String(reason);
}

interface Props {
  project: Project;
  tasks: Task[];
  proposals: TaskProposal[];
  /** A batch to show (one just prepared from a proposal in the chat). */
  focusBatchId: string | null;
  onOpenTask: (task: Task) => void;
  onManageAgents: () => void;
}

/**
 * Autonomous Execution (FO-005C.2): the project's execution batches. The
 * list and every detail are read from the core; this view re-reads them on
 * the core's own `execution_batch` events (via App's single `/app/events`
 * stream), on board changes of the batches' tasks, and when the window
 * regains focus — so a missed event is caught up without a poll of its own.
 */
export function AutonomousExecution({ project, tasks, proposals, focusBatchId, onOpenTask, onManageAgents }: Props) {
  const { locale: uiLocale } = useUILocale();
  const [batches, setBatches] = useState<BatchView[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(focusBatchId);
  const [creating, setCreating] = useState(false);
  const [schedule, setSchedule] = useState<TaskSchedulingView[] | null>(null);

  const reload = useCallback(async () => {
    try {
      const next = await api.listBatches(project.path);
      setBatches(next);
      setLoadError(null);
    } catch (caught) {
      setLoadError(messageOf(caught));
    }
  }, [project.path]);

  const reloadSchedule = useCallback(() => {
    void api.listScheduling(project.path).then((result) => setSchedule(result.tasks), () => setSchedule(null));
  }, [project.path]);

  useEffect(() => {
    setBatches(null);
    void reload();
    reloadSchedule();
  }, [reload, reloadSchedule]);

  useEffect(() => {
    if (focusBatchId) {
      setSelectedId(focusBatchId);
      setCreating(false);
      void reload();
    }
  }, [focusBatchId, reload]);

  // One coalesced re-read per burst of changes.
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const scheduleReload = useCallback(() => {
    if (timer.current) return;
    timer.current = setTimeout(() => {
      timer.current = null;
      void reload();
    }, 250);
  }, [reload]);
  useEffect(() => () => { if (timer.current) clearTimeout(timer.current); }, []);

  useEffect(() => subscribeBatchEvents((event) => {
    if (event.projectPath === project.path) scheduleReload();
  }), [project.path, scheduleReload]);

  const trackedTaskIds = useMemo(() => new Set((batches ?? [])
    .filter((batch) => batch.status !== "draft")
    .flatMap((batch) => batch.entries.map((entry) => entry.taskId))), [batches, uiLocale]);
  useEffect(() => subscribePipelineGlobalEvents((event) => {
    if (!("taskId" in event)) return;
    const parent = (event as { pipelineParentId?: string }).pipelineParentId;
    if (trackedTaskIds.has(event.taskId) || (parent && trackedTaskIds.has(parent))) scheduleReload();
  }), [trackedTaskIds, scheduleReload]);

  // The board's own task poll: a column or run moved without an event we saw.
  const boardSignature = useMemo(() => tasks
    .filter((task) => trackedTaskIds.has(task.id))
    .map((task) => `${task.id}:${task.column}:${task.runId ?? ""}:${task.pendingInteractionCount}:${task.pipelineRun?.status ?? ""}`)
    .sort()
    .join("|"), [tasks, trackedTaskIds, uiLocale]);
  const firstSignature = useRef(true);
  useEffect(() => {
    if (firstSignature.current) {
      firstSignature.current = false;
      return;
    }
    scheduleReload();
  }, [boardSignature, scheduleReload]);

  useEffect(() => {
    const onFocus = () => scheduleReload();
    window.addEventListener("focus", onFocus);
    return () => window.removeEventListener("focus", onFocus);
  }, [scheduleReload]);

  const replace = useCallback((view: BatchView) => {
    setBatches((current) => {
      if (!current) return [view];
      const at = current.findIndex((item) => item.id === view.id);
      if (at < 0) return [view, ...current];
      const next = [...current];
      next[at] = view;
      return next;
    });
  }, []);

  const selected = batches?.find((batch) => batch.id === selectedId) ?? null;

  return (
    <div className="grid min-h-0 min-w-0 flex-1 gap-4 lg:grid-cols-[minmax(16rem,20rem)_minmax(0,1fr)]" data-testid="autonomous-execution">
      <section className="surface-solid flex min-w-0 flex-col gap-2 rounded-xl border px-4 py-3 lg:min-h-0 lg:overflow-y-auto" aria-labelledby="batches-heading">
        <header className="flex items-center justify-between gap-2">
          <h3 id="batches-heading" className="flex items-center gap-1.5 text-sm font-semibold">
            <ListChecks className="size-4" aria-hidden /><I18nText id="approvals.execution_batches" />{" "}</h3>
          <Button
            type="button"
            size="sm"
            variant="outline"
            onClick={() => { setCreating(true); setSelectedId(null); }}
            data-testid="batch-new"
          >
            <Plus className="size-3.5" aria-hidden /><I18nText id="approvals.new_batch" />{" "}</Button>
        </header>
        <p className="text-[length:var(--text-caption)] text-muted-foreground"><I18nText id="approvals.approve_a_set_of_tasks_once_the_batch" />{" "}</p>
        {loadError && (
          <p role="alert" className="flex flex-wrap items-center gap-2 text-[length:var(--text-caption)] text-danger" data-testid="batches-load-error">
            <span className="min-w-0 break-words">{loadError}</span>
            <button type="button" className="inline-flex items-center gap-0.5 underline" onClick={() => void reload()}>
              <RotateCcw className="size-3" aria-hidden /><I18nText id="common.retry" />{" "}</button>
          </p>
        )}
        {batches == null && !loadError && (
          <p className="flex items-center gap-1.5 text-xs text-muted-foreground">
            <Loader2 className="size-3.5 motion-safe:animate-spin" aria-hidden /><I18nText id="approvals.loading_batches" />{" "}</p>
        )}
        {batches && batches.length === 0 && (
          <p className="text-xs text-muted-foreground" data-testid="batches-empty"><I18nText id="approvals.no_batches_yet_for_this_project" /></p>
        )}
        {batches && batches.length > 0 && (
          <ul className="space-y-1.5" aria-label={tr("approvals.batches")} data-testid="batch-list">
            {batches.map((batch) => (
              <li key={batch.id}>
                <BatchRow batch={batch} selected={batch.id === selectedId && !creating} onSelect={() => { setSelectedId(batch.id); setCreating(false); }} />
              </li>
            ))}
          </ul>
        )}
      </section>

      <div className="min-w-0 lg:min-h-0 lg:overflow-y-auto">
        {creating ? (
          <NewBatch
            project={project}
            tasks={tasks}
            proposals={proposals}
            onCancel={() => setCreating(false)}
            onCreated={(view) => {
              replace(view);
              setSelectedId(view.id);
              setCreating(false);
            }}
          />
        ) : selected ? (
          <BatchDetail
            key={selected.id}
            projectPath={project.path}
            batch={selected}
            tasks={tasks}
            schedule={schedule}
            onBatch={replace}
            onScheduleChanged={reloadSchedule}
            onOpenTask={onOpenTask}
            onManageAgents={onManageAgents}
          />
        ) : (
          <div className="surface-solid rounded-xl border px-4 py-6 text-sm text-muted-foreground" data-testid="batch-none-selected">
            {batches && batches.length > 0 ? tr("common.select_a_batch_to_see_its_preview_or") : tr("common.create_a_batch_to_run_several_tasks_with")}
          </div>
        )}
      </div>
    </div>
  );
}

function BatchRow({ batch, selected, onSelect }: { batch: BatchView; selected: boolean; onSelect: () => void }) {
  useUILocale();
  const counts = batchCounts(batch);
  const parts = MONITOR_GROUPS.filter((group) => counts[group.id] > 0).map((group) => `${counts[group.id]} ${group.label.toLowerCase()}`);
  return (
    <button
      type="button"
      onClick={onSelect}
      aria-current={selected ? "true" : undefined}
      className={cn("glass-nav-item w-full rounded-lg border border-border px-2 py-1.5 text-left text-xs", selected && "glass-selected")}
      data-testid="batch-row"
      data-batch-id={batch.id}
      data-status={batch.status}
    >
      <span className="flex items-start justify-between gap-2">
        <span className="min-w-0 break-words font-medium">{batch.title}</span>
        <span className={cn("shrink-0 rounded-full px-1.5 py-0.5 text-[10px] font-medium", BATCH_STATUS_TONE[batch.status])}>{BATCH_STATUS_LABEL[batch.status]}</span>
      </span>
      {batch.autonomy && <span className="mt-0.5 block"><AutonomyBadge batch={batch} /></span>}
      <span className="mt-0.5 block text-[length:var(--text-caption)] text-muted-foreground">
        {batch.entries.length}{" "}<I18nText id="common.task" />{batch.entries.length === 1 ? "" : englishPluralSuffix()}{batch.status !== "draft" && parts.length > 0 ? ` · ${parts.join(", ")}` : ""}
      </span>
      <span className="block text-[10px] text-muted-foreground">
        {batch.approval ? tr("common.approved_a4ad51", { p0: String(formatTime(batch.approval.at)) }) : tr("common.created_30c82c", { p0: String(formatTime(batch.createdAt)) })}
        {batch.status === "paused" && batch.reason ? ` · ${batch.reason.text}` : ""}
      </span>
    </button>
  );
}

/** Pick tasks (or an approved proposal) for a new draft. Starts nothing. */
function NewBatch({
  project,
  tasks,
  proposals,
  onCancel,
  onCreated,
}: {
  project: Project;
  tasks: Task[];
  proposals: TaskProposal[];
  onCancel: () => void;
  onCreated: (view: BatchView) => void;
}) {
  useUILocale();
  const ids = useId();
  const [picked, setPicked] = useState<string[]>([]);
  const [query, setQuery] = useState("");
  const [title, setTitle] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const candidates = tasks.filter((task) => isProjectTask(task, project.path) && !task.pipelineParentId && task.archivedAt == null
    && (task.column === "inbox" || task.column === "ready"));
  const shown = query.trim()
    ? candidates.filter((task) => task.title.toLowerCase().includes(query.trim().toLowerCase()))
    : candidates;
  const approvedProposals = proposals.filter((proposal) => proposal.status === "approved" || proposal.status === "partial");
  const toggle = (id: string) => setPicked((current) => current.includes(id) ? current.filter((item) => item !== id) : [...current, id]);

  const submit = async (fn: () => Promise<BatchView>) => {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      onCreated(await fn());
    } catch (caught) {
      setError(messageOf(caught));
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="surface-solid space-y-3 rounded-xl border px-4 py-3 text-xs" aria-labelledby={`${ids}-heading`} data-testid="batch-create">
      <header className="flex items-center justify-between gap-2">
        <h3 id={`${ids}-heading`} className="text-sm font-semibold"><I18nText id="approvals.new_batch" /></h3>
        <button type="button" className="rounded p-1 text-muted-foreground hover:text-foreground focus-visible:outline focus-visible:outline-2 focus-visible:outline-ring" onClick={onCancel} aria-label={tr("approvals.close_new_batch")}>
          <X className="size-4" aria-hidden />
        </button>
      </header>
      <p className="text-[length:var(--text-caption)] text-muted-foreground"><I18nText id="approvals.creating_a_draft_starts_nothing_you_ll_see" /></p>

      {approvedProposals.length > 0 && (
        <div className="space-y-1" data-testid="batch-from-proposals">
          <p className="font-medium"><I18nText id="approvals.from_an_approved_task_proposal" /></p>
          <ul className="space-y-1">
            {approvedProposals.map((proposal) => (
              <li key={proposal.id} className="flex flex-wrap items-center justify-between gap-2 rounded-md border border-border px-2 py-1">
                <span className="min-w-0 break-words">{proposal.title}</span>
                <Button type="button" size="sm" variant="outline" disabled={busy} onClick={() => void submit(() => api.createBatchFromProposal(project.path, proposal.id))} data-testid="batch-from-proposal" data-proposal-id={proposal.id}><I18nText id="approvals.use_its_tasks" />{" "}</Button>
              </li>
            ))}
          </ul>
        </div>
      )}

      <div className="space-y-1">
        <p className="font-medium"><I18nText id="approvals.or_pick_tasks" /></p>
        {candidates.length === 0 ? (
          <p className="text-muted-foreground" data-testid="batch-create-empty"><I18nText id="approvals.no_backlog_or_ready_tasks_in_this_project" /></p>
        ) : (
          <>
            <div className="relative">
              <Search className="pointer-events-none absolute left-2 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" aria-hidden />
              <input
                type="search"
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                placeholder={tr("approvals.filter_tasks")}
                aria-label={tr("approvals.filter_tasks")}
                className="h-8 w-full rounded-md border border-input bg-transparent pl-7 pr-2 text-xs"
                data-testid="batch-create-filter"
              />
            </div>
            <div className="flex flex-wrap gap-2 text-[length:var(--text-caption)]">
              <button type="button" className="underline" onClick={() => setPicked((current) => [...new Set([...current, ...shown.map((task) => task.id)])].slice(0, SCHEDULING_LIMITS.batchTasks))}><I18nText id="approvals.select_shown" /></button>
              <button type="button" className="underline" onClick={() => setPicked([])}><I18nText id="common.clear" /></button>
              <span className="text-muted-foreground">{picked.length}{" "}<I18nText id="approvals.selected_max" />{" "}{SCHEDULING_LIMITS.batchTasks})</span>
            </div>
            <ul className="max-h-72 space-y-0.5 overflow-y-auto rounded-md border border-border p-1" aria-label={tr("common.tasks_b3a60e")} data-testid="batch-create-tasks">
              {shown.map((task) => (
                <li key={task.id}>
                  <label className="flex items-start gap-2 rounded px-1 py-0.5 hover:bg-muted/60">
                    <input
                      type="checkbox"
                      className="mt-0.5"
                      checked={picked.includes(task.id)}
                      onChange={() => toggle(task.id)}
                      disabled={!picked.includes(task.id) && picked.length >= SCHEDULING_LIMITS.batchTasks}
                      data-testid="batch-create-task"
                      data-task-id={task.id}
                    />
                    <span className="min-w-0 flex-1 break-words">{task.title}</span>
                    <span className="shrink-0 text-[10px] text-muted-foreground">{columnLabel(task.column)}</span>
                  </label>
                </li>
              ))}
            </ul>
            {picked.length > 0 && (
              <p className="break-words text-[length:var(--text-caption)] text-muted-foreground" data-testid="batch-create-picked"><I18nText id="approvals.order" />{" "}{picked.map((id) => candidates.find((task) => task.id === id)?.title ?? id.slice(0, 8)).map((t, i) => `${i + 1}. ${t}`).join("  ")}
              </p>
            )}
          </>
        )}
        <label className="flex flex-col gap-0.5">
          <span className="text-muted-foreground"><I18nText id="approvals.name_optional" /></span>
          <input
            value={title}
            maxLength={SCHEDULING_LIMITS.titleChars}
            onChange={(event) => setTitle(event.target.value)}
            className="h-8 rounded-md border border-input bg-transparent px-2 text-xs"
            data-testid="batch-create-title"
          />
        </label>
      </div>

      {error && <p role="alert" className="break-words rounded-md border border-danger/40 bg-danger/10 px-2 py-1 text-[length:var(--text-caption)] text-danger" data-testid="batch-create-error">{error}</p>}
      <div className="flex flex-wrap gap-2">
        <Button
          type="button"
          size="sm"
          disabled={busy || picked.length === 0}
          onClick={() => void submit(() => api.createBatch(project.path, picked, title.trim() || undefined))}
          data-testid="batch-create-submit"
        >
          {busy ? <Loader2 className="size-3.5 motion-safe:animate-spin" aria-hidden /> : <Plus className="size-3.5" aria-hidden />}<I18nText id="approvals.create_draft" />{" "}</Button>
        <Button type="button" size="sm" variant="ghost" onClick={onCancel}><I18nText id="common.cancel" /></Button>
      </div>
    </section>
  );
}
