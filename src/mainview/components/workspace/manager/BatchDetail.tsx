import { englishPluralSuffix, t as tr } from "@/i18n/core";

import { I18nText, useLocale as useUILocale } from "@/i18n/react";
import { useCallback, useEffect, useId, useMemo, useRef, useState } from "react";
import {
  AlertTriangle,
  ArrowDown,
  ArrowUp,
  Ban,
  Check,
  CircleAlert,
  ExternalLink,
  Info,
  Loader2,
  Pause,
  Pencil,
  Play,
  RefreshCw,
  ShieldCheck,
  Square,
  Trash2,
  Unlock,
} from "lucide-react";
import { ApiError, api } from "@/lib/api";
import { subscribeBatchEvents } from "@/lib/batch-events";
import {
  ACCESS_TEXT,
  BATCH_STATUS_LABEL,
  BATCH_STATUS_TONE,
  ENTRY_STATE_LABEL,
  ENTRY_STATE_TONE,
  FAILURE_OPTIONS,
  MONITOR_GROUPS,
  PRIORITY_OPTIONS,
  PRIORITY_TONE,
  REVIEW_OPTIONS,
  SPENDING_OPTIONS,
  batchActions,
  batchCounts,
  batchInError,
  formatTime,
  groupEntries,
  moveId,
  policySummary,
  viewOfAction,
  type BatchAction,
} from "@/lib/batches";
import { Button } from "@/components/ui/button";
import { Select } from "@/components/ui/select";
import { useConfirm } from "@/components/ui/confirm";
import { cn } from "@/lib/utils";
import { isProjectTask } from "@/lib/workspace";
import { TaskSchedulingEditor } from "../../kanban/TaskSchedulingSection";
import { CheckLine, ExecutionCard, ExecutionEditor } from "./ExecutionCard";
import { AutonomyBadge, AutonomySection } from "./AutonomySection";
import type { ExecutionConfig, ExecutionView } from "../../../../shared/project-execution.ts";
import {
  SCHEDULING_LIMITS,
  type BatchEntryView,
  type BatchEventRow,
  type BatchIssue,
  type BatchPolicy,
  type BatchPreviewTask,
  type BatchView,
  type TaskSchedulingView,
} from "../../../../shared/task-scheduling.ts";
import type { Task } from "../../../../shared/types.ts";

function messageOf(reason: unknown): string {
  if (reason instanceof ApiError || reason instanceof Error) return reason.message;
  return String(reason);
}

/** Buttons wrap their label instead of overflowing a narrow column. */
const ACTION = "h-auto min-h-8 max-w-full whitespace-normal text-left";

interface Props {
  projectPath: string;
  batch: BatchView;
  tasks: Task[];
  schedule: TaskSchedulingView[] | null;
  onBatch: (batch: BatchView) => void;
  onScheduleChanged: () => void;
  onOpenTask: (task: Task) => void;
  onManageAgents: () => void;
}

/**
 * One execution batch (FO-005C): a draft to edit and preview, the owner's
 * approval, an explicit Start, then live monitoring. Everything shown comes
 * from the core's `BatchView`; every button is checked again there. This
 * component never decides what may run.
 */
export function BatchDetail({ projectPath, batch, tasks, schedule, onBatch, onScheduleChanged, onOpenTask, onManageAgents }: Props) {
  const { locale: uiLocale } = useUILocale();
  const [busy, setBusy] = useState<string | null>(null);
  const busyRef = useRef<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const confirm = useConfirm();

  useEffect(() => {
    setError(null);
    setNotice(null);
  }, [batch.id]);

  const run = useCallback(async (label: string, fn: () => Promise<void>) => {
    if (busyRef.current) return;
    busyRef.current = label;
    setBusy(label);
    setError(null);
    setNotice(null);
    try {
      await fn();
    } catch (caught) {
      const fresh = caught instanceof ApiError ? batchInError(caught.body) : null;
      if (fresh) onBatch(fresh);
      setError(messageOf(caught));
    } finally {
      busyRef.current = null;
      setBusy(null);
    }
  }, [onBatch]);

  const act = async (action: BatchAction) => {
    if (action === "stop-runs") {
      const ok = await confirm(() => ({
        title: tr("common.stop_the_batch_s_running_agents"),
        description: (
          <span className="space-y-1">
            <span className="block"><I18nText id="approvals.this_interrupts_the" />{" "}{batch.ownedLive.length}{" "}<I18nText id="approvals.agent_run" />{batch.ownedLive.length === 1 ? "" : englishPluralSuffix()}{" "}<I18nText id="approvals.this_batch_started" /></span>
            <span className="block font-medium">{batch.ownedLive.map((id) => titleOfEntry(batch, id)).join(", ")}</span>
            <span className="block"><I18nText id="approvals.runs_started_from_the_board_or_elsewhere_are" /></span>
          </span>
        ),
        confirmLabel: tr("common.stop_batch_runs"),
        variant: "destructive",
      }));
      if (!ok) return;
    }
    if (action === "cancel") {
      const ok = await confirm(() => ({
        title: tr("common.cancel_the_queue"),
        description: batch.ownedLive.length > 0
          ? tr("common.no_further_task_will_start_the_agent_already", { p0: String(batch.ownedLive.length), p1: String(batch.ownedLive.length === 1 ? tr("common.that_is") : tr("common.s_that_are")), p2: String(batch.ownedLive.length === 1 ? "s" : ""), p3: String(batch.ownedLive.length === 1 ? "it" : "them") })
          : tr("common.no_further_task_will_start_results_stay_on"),
        confirmLabel: tr("common.cancel_queue"),
        cancelLabel: tr("approvals.keep_it"),
      }));
      if (!ok) return;
    }
    await run(action, async () => {
      const result = await api.batchAction(projectPath, batch.id, action);
      onBatch(viewOfAction(result));
      if (action === "stop-runs") {
        const stopped = (result as { stopped?: string[] }).stopped ?? [];
        setNotice(stopped.length > 0 ? tr("common.stop_sent_to_run", { p0: String(stopped.length), p1: String(stopped.length === 1 ? "" : "s") }) : tr("common.nothing_was_running"));
      }
      if (action === "resume") {
        const held = (result as { held?: string[] }).held ?? [];
        if (held.length > 0) setNotice(`Resumed. ${held.length} task${held.length === 1 ? tr("common.is") : tr("common.s_are")} on hold — see why below.`);
      }
    });
  };

  const counts = batchCounts(batch);
  const actions = batchActions(batch);
  const previewByTask = useMemo(() => new Map((batch.preview?.tasks ?? []).map((task) => [task.taskId, task])), [batch.preview, uiLocale]);

  return (
    <section className="surface-solid flex min-w-0 flex-col gap-3 rounded-xl border px-4 py-3" aria-labelledby={`batch-title-${batch.id}`} data-testid="batch-detail" data-batch-id={batch.id} data-status={batch.status}>
      <header className="flex flex-wrap items-start justify-between gap-2">
        <div className="min-w-0">
          <h3 id={`batch-title-${batch.id}`} className="break-words text-[length:var(--text-base)] font-semibold" data-testid="batch-title">{batch.title}</h3>
          <p className="text-[length:var(--text-caption)] text-muted-foreground">
            {batch.entries.length}{" "}<I18nText id="common.task" />{batch.entries.length === 1 ? "" : englishPluralSuffix()} · {policySummary(batch.policy)}
          </p>
        </div>
        <span className="flex shrink-0 flex-wrap items-center justify-end gap-1">
          {batch.status !== "draft" && <AutonomyBadge batch={batch} />}
          <span className={cn("shrink-0 rounded-full px-2 py-0.5 text-[length:var(--text-caption)] font-medium", BATCH_STATUS_TONE[batch.status])} data-testid="batch-status">
            {BATCH_STATUS_LABEL[batch.status]}
          </span>
        </span>
      </header>

      {batch.status !== "approved" && (
        <p className="text-[length:var(--text-secondary)] text-muted-foreground" data-testid="batch-status-hint">
          {tr(`uxfix.batch.hint.${batch.status}` as Parameters<typeof tr>[0])}
        </p>
      )}

      {batch.reason && batch.status !== "running" && (
        <p
          className={cn(
            "flex items-start gap-1.5 rounded-md border px-2 py-1.5 text-[length:var(--text-secondary)]",
            batch.status === "paused" ? "border-warning/40 bg-warning/10 text-warning" : "border-border text-muted-foreground",
          )}
          role="status"
          data-testid="batch-reason"
          data-code={batch.reason.code}
        >
          <Info className="mt-0.5 size-3.5 shrink-0" aria-hidden />
          <span className="min-w-0 break-words">
            {batch.status === "paused" ? tr("common.paused_ec7059") : batch.status === "stopped" ? tr("common.stopped_093b3a") : ""}
            {batch.reason.text}
            {batch.reason.code === "restart" ? tr("common.agents_already_running_keep_running_nothing_new_starts") : ""}
          </span>
        </p>
      )}

      {batch.approval && (
        <p className="flex items-start gap-1.5 text-[length:var(--text-caption)] text-muted-foreground" data-testid="batch-approval">
          <ShieldCheck className="mt-0.5 size-3.5 shrink-0 text-success" aria-hidden />
          <span className="min-w-0 break-words"><I18nText id="approvals.approved_by_you_on" />{" "}{formatTime(batch.approval.at)}{" "}<I18nText id="approvals.for_exactly_these" />{" "}{batch.entries.length}{" "}<I18nText id="common.task" />{batch.entries.length === 1 ? "" : englishPluralSuffix()}{" "}<I18nText id="common.on" />{" "}
            {batch.approval.allowedHarnessIds.join(", ") || tr("common.no_harness")}
            {batch.approval.allowedPipelineIds.length > 0 ? tr("common.pipeline_b26e99", { p0: String(batch.approval.allowedPipelineIds.length), p1: String(batch.approval.allowedPipelineIds.length === 1 ? "" : englishPluralSuffix()) }) : ""}<I18nText id="approvals.up_to" />{ACCESS_TEXT[batch.approval.maxAccessLevel] ?? "?"}”.
            {(batch.approval.acknowledgedHarnessIds ?? []).length > 0 ? tr("common.spending_acknowledged_for", { p0: String((batch.approval.acknowledgedHarnessIds ?? []).join(", ")) }) : ""}
            {batch.startedAt ? tr("common.started_16fe8e", { p0: String(formatTime(batch.startedAt)) }) : tr("common.not_started")}
            {batch.deadlineAt ? tr("common.no_new_task_starts_after", { p0: String(formatTime(batch.deadlineAt)) }) : ""}
          </span>
        </p>
      )}

      {(actions.length > 0 || batch.status === "approved") && (
        <div className="flex flex-wrap items-center gap-2" role="group" aria-label={tr("approvals.batch_actions")} data-testid="batch-actions">
          {actions.includes("start") && (
            <Button className={ACTION} type="button" size="sm" onClick={() => void act("start")} disabled={busy != null} data-testid="batch-start">
              {busy === "start" ? <Loader2 className="size-3.5 motion-safe:animate-spin" aria-hidden /> : <Play className="size-3.5" aria-hidden />}<I18nText id="approvals.start_execution" />{" "}</Button>
          )}
          {actions.includes("resume") && (
            <Button className={ACTION} type="button" size="sm" onClick={() => void act("resume")} disabled={busy != null} data-testid="batch-resume">
              {busy === "resume" ? <Loader2 className="size-3.5 motion-safe:animate-spin" aria-hidden /> : <Play className="size-3.5" aria-hidden />}<I18nText id="common.resume" />{" "}</Button>
          )}
          {actions.includes("pause") && (
            <Button className={ACTION} type="button" size="sm" variant="outline" onClick={() => void act("pause")} disabled={busy != null} data-testid="batch-pause">
              <Pause className="size-3.5" aria-hidden /><I18nText id="approvals.pause" />{" "}</Button>
          )}
          {actions.includes("cancel") && (
            <Button className={ACTION} type="button" size="sm" variant="outline" onClick={() => void act("cancel")} disabled={busy != null} data-testid="batch-cancel">
              <Ban className="size-3.5" aria-hidden />
              {batch.status === "draft" ? tr("common.discard_draft") : tr("common.cancel_queue")}
            </Button>
          )}
          {actions.includes("stop-runs") && (
            <Button className={ACTION} type="button" size="sm" variant="destructive" onClick={() => void act("stop-runs")} disabled={busy != null} data-testid="batch-stop-runs">
              <Square className="size-3.5" aria-hidden /><I18nText id="approvals.stop_batch_runs" />{batch.ownedLive.length})
            </Button>
          )}
          {batch.status === "running" && batch.ownedLive.length > 0 && (
            <span className="text-[length:var(--text-caption)] text-muted-foreground"><I18nText id="approvals.to_stop_running_agents_pause_or_cancel_first" /></span>
          )}
        </div>
      )}
      <AutonomySection projectPath={projectPath} batch={batch} busy={busy} run={run} onBatch={onBatch} titleOf={(id) => titleOfEntry(batch, id)} />

      {batch.status === "approved" && (
        <p className="text-[length:var(--text-secondary)] text-muted-foreground" data-testid="batch-not-started"><I18nText id="approvals.approved_not_started_nothing_runs_until_you_press" /></p>
      )}

      {error && (
        <p role="alert" className="break-words rounded-md border border-danger/40 bg-danger/10 px-2 py-1 text-[length:var(--text-caption)] text-danger" data-testid="batch-error">{error}</p>
      )}
      {notice && (
        <p role="status" className="break-words text-[length:var(--text-caption)] text-info" data-testid="batch-notice">{notice}</p>
      )}

      {batch.status === "draft" ? (
        <DraftEditor
          projectPath={projectPath}
          batch={batch}
          tasks={tasks}
          schedule={schedule}
          busy={busy}
          run={run}
          onBatch={onBatch}
          onScheduleChanged={onScheduleChanged}
          onManageAgents={onManageAgents}
        />
      ) : batch.status === "approved" ? (
        batch.preview && <PreviewView batch={batch} />
      ) : (
        <Monitor
          projectPath={projectPath}
          batch={batch}
          counts={counts}
          tasks={tasks}
          previewByTask={previewByTask}
          busy={busy}
          run={run}
          onBatch={onBatch}
          onOpenTask={onOpenTask}
          onManageAgents={onManageAgents}
        />
      )}

      {batch.status !== "draft" && batch.status !== "approved" && batch.preview && (
        <details className="rounded-lg border border-border px-2 py-1.5 text-xs" data-testid="batch-approved-preview">
          <summary className="cursor-pointer text-muted-foreground"><I18nText id="approvals.what_was_approved" /></summary>
          <div className="mt-2"><PreviewView batch={batch} /></div>
        </details>
      )}

      <BatchEvents projectPath={projectPath} batch={batch} />
    </section>
  );
}

function titleOfEntry(batch: BatchView, taskId: string): string {
  const entry = batch.entries.find((item) => item.taskId === taskId);
  return entry?.currentTitle ?? entry?.title ?? taskId.slice(0, 8);
}

/* ────────────────────────────────────────────────────────────────────────── *
 * Draft: tasks, configuration, policy, preview, approval.
 * ────────────────────────────────────────────────────────────────────────── */

type Runner = (label: string, fn: () => Promise<void>) => Promise<void>;

function DraftEditor({
  projectPath,
  batch,
  tasks,
  schedule,
  busy,
  run,
  onBatch,
  onScheduleChanged,
  onManageAgents,
}: {
  projectPath: string;
  batch: BatchView;
  tasks: Task[];
  schedule: TaskSchedulingView[] | null;
  busy: string | null;
  run: Runner;
  onBatch: (batch: BatchView) => void;
  onScheduleChanged: () => void;
  onManageAgents: () => void;
}) {
  useUILocale();
  const ids = useId();
  const [adding, setAdding] = useState("");
  const [editingConfig, setEditingConfig] = useState<string | null>(null);
  const [openScheduling, setOpenScheduling] = useState<string | null>(null);
  const order = batch.entries.map((entry) => entry.taskId);
  const inBatch = new Set(order);
  const addable = tasks.filter((task) => isProjectTask(task, projectPath) && !task.pipelineParentId && task.archivedAt == null
    && (task.column === "inbox" || task.column === "ready") && !inBatch.has(task.id));

  const patch = (label: string, change: Parameters<typeof api.updateBatch>[3]) => run(label, async () => {
    onBatch(await api.updateBatch(projectPath, batch.id, batch.revision, change));
  });

  const previewByTask = new Map((batch.preview?.tasks ?? []).map((task) => [task.taskId, task]));
  const mapping = new Map(batch.mappingNotes.map((note) => [note.taskId, note]));
  const issuesByTask = new Map<string, BatchIssue[]>();
  for (const item of batch.preview?.issues ?? []) {
    if (!item.taskId) continue;
    const list = issuesByTask.get(item.taskId) ?? [];
    list.push(item);
    issuesByTask.set(item.taskId, list);
  }

  return (
    <div className="space-y-3" data-testid="batch-draft">
      <section aria-labelledby={`${ids}-tasks`} className="space-y-1.5">
        <h4 id={`${ids}-tasks`} className="text-xs font-semibold"><I18nText id="approvals.tasks_in_your_order" /></h4>
        <p className="text-[length:var(--text-caption)] text-muted-foreground"><I18nText id="approvals.priority_picks_first_among_ready_tasks_your_order" /></p>
        <ol className="space-y-1.5" data-testid="batch-draft-tasks">
          {batch.entries.map((entry, index) => {
            const preview = previewByTask.get(entry.taskId);
            const view = schedule?.find((row) => row.taskId === entry.taskId) ?? null;
            const note = mapping.get(entry.taskId);
            const taskIssues = issuesByTask.get(entry.taskId) ?? [];
            const title = entry.currentTitle ?? entry.title;
            return (
              <li key={entry.taskId} className="space-y-1 rounded-lg border border-border p-2 text-xs" data-testid="batch-draft-task" data-task-id={entry.taskId}>
                <div className="flex flex-wrap items-start gap-2">
                  <span className="mt-0.5 w-5 shrink-0 text-right text-[length:var(--text-caption)] text-muted-foreground" aria-hidden>{index + 1}.</span>
                  <div className="min-w-0 flex-1">
                    <p className="break-words font-medium" data-testid="batch-draft-task-title">{title}</p>
                    <p className="text-[length:var(--text-caption)] text-muted-foreground">
                      <span className={PRIORITY_TONE[entry.priority]}>{PRIORITY_OPTIONS.find((p) => p.id === entry.priority)?.label}</span>
                      {" · "}
                      {preview ? `${preview.pipelineName ? tr("common.pipeline_5b7717", { p0: String(preview.pipelineName) }) : preview.profileName ? tr("common.profile", { p0: String(preview.profileName), p1: String(preview.harnessLabel) }) : preview.harnessLabel} · ${preview.modelLabel} · ${preview.modeLabel}` : entry.config.harness}
                    </p>
                  </div>
                  <div className="flex shrink-0 items-center gap-1">
                    <IconButton label={tr("common.move_up", { p0: String(title) })} disabled={busy != null || index === 0} onClick={() => void patch("order", { taskIds: moveId(order, entry.taskId, -1) })} testId="batch-task-up">
                      <ArrowUp className="size-3.5" aria-hidden />
                    </IconButton>
                    <IconButton label={tr("common.move_down", { p0: String(title) })} disabled={busy != null || index === order.length - 1} onClick={() => void patch("order", { taskIds: moveId(order, entry.taskId, 1) })} testId="batch-task-down">
                      <ArrowDown className="size-3.5" aria-hidden />
                    </IconButton>
                    <IconButton label={tr("common.remove_from_the_batch", { p0: String(title) })} disabled={busy != null || order.length === 1} onClick={() => void patch("remove", { taskIds: order.filter((id) => id !== entry.taskId) })} testId="batch-task-remove">
                      <Trash2 className="size-3.5" aria-hidden />
                    </IconButton>
                  </div>
                </div>
                {taskIssues.filter((item) => item.level !== "info").length > 0 && (
                  <ul className="space-y-0.5 pl-7">
                    {taskIssues.filter((item) => item.level !== "info").map((item, i) => <CheckLine key={`${item.code}-${i}`} check={item} />)}
                  </ul>
                )}
                {note && (
                  <p className="ml-7 flex items-start gap-1 rounded-md border border-warning/40 bg-warning/10 px-2 py-1 text-[length:var(--text-caption)] text-warning" data-testid="batch-mapping-note">
                    <AlertTriangle className="mt-0.5 size-3 shrink-0" aria-hidden />
                    <span className="min-w-0 break-words"><I18nText id="approvals.the_proposal_named_dependencies_that_aren_t_linked" />{" "}{note.mentioned.map((item) => `“${item}”`).join(", ")}<I18nText id="approvals.link_the_matching_tasks_under_priority_dependencies_or" />{" "}</span>
                  </p>
                )}
                <div className="flex flex-wrap gap-2 pl-7">
                  <button
                    type="button"
                    className="text-[length:var(--text-caption)] underline underline-offset-2 disabled:opacity-50"
                    onClick={() => setOpenScheduling(openScheduling === entry.taskId ? null : entry.taskId)}
                    aria-expanded={openScheduling === entry.taskId}
                    disabled={busy != null}
                    data-testid="batch-task-scheduling-toggle"
                  ><I18nText id="common.priority_dependencies" />{" "}</button>
                  <button
                    type="button"
                    className="inline-flex items-center gap-0.5 text-[length:var(--text-caption)] underline underline-offset-2 disabled:opacity-50"
                    onClick={() => setEditingConfig(editingConfig === entry.taskId ? null : entry.taskId)}
                    aria-expanded={editingConfig === entry.taskId}
                    disabled={busy != null}
                    data-testid="batch-task-config-toggle"
                  >
                    <Pencil className="size-3" aria-hidden /><I18nText id="common.configuration" />{" "}</button>
                </div>
                {openScheduling === entry.taskId && (
                  <div className="ml-7 rounded-md border border-border/70 p-2">
                    {view && schedule ? (
                      <TaskSchedulingEditor
                        projectPath={projectPath}
                        taskId={entry.taskId}
                        schedule={schedule}
                        compact
                        onUpdated={() => {
                          onScheduleChanged();
                          // Links and priority change the preview: re-check it.
                          void run("preview", async () => onBatch(await api.previewBatch(projectPath, batch.id)));
                        }}
                      />
                    ) : (
                      <p className="text-[length:var(--text-caption)] text-muted-foreground"><I18nText id="common.loading" /></p>
                    )}
                  </div>
                )}
                {editingConfig === entry.taskId && (
                  <div className="ml-7 text-xs">
                    <ExecutionEditor
                      config={entry.config}
                      busy={busy != null}
                      onCancel={() => setEditingConfig(null)}
                      onSave={(config: Partial<ExecutionConfig>) => {
                        void patch("config", { configs: { [entry.taskId]: config } }).then(() => setEditingConfig(null));
                      }}
                      onManageAgents={onManageAgents}
                      note={tr("common.saving_updates_this_draft_only_the_task_s")}
                    />
                  </div>
                )}
              </li>
            );
          })}
        </ol>
        {addable.length > 0 && batch.entries.length < SCHEDULING_LIMITS.batchTasks && (
          <form
            className="flex flex-wrap gap-2"
            onSubmit={(event) => {
              event.preventDefault();
              if (!adding) return;
              const next = [...order, adding];
              setAdding("");
              void patch("add", { taskIds: next });
            }}
          >
            <label htmlFor={`${ids}-add`} className="sr-only"><I18nText id="approvals.add_a_task_to_the_batch" /></label>
            <Select id={`${ids}-add`} className="h-8 min-w-0 flex-1 text-xs" value={adding} onChange={(event) => setAdding(event.target.value)} disabled={busy != null} data-testid="batch-add-task-select">
              <option value=""><I18nText id="approvals.add_a_backlog_or_ready_task" /></option>
              {addable.map((task) => <option key={task.id} value={task.id}>{task.title}</option>)}
            </Select>
            <Button type="submit" size="sm" variant="outline" disabled={busy != null || !adding} data-testid="batch-add-task"><I18nText id="common.add" /></Button>
          </form>
        )}
      </section>

      <PolicyForm batch={batch} busy={busy} onSave={(policy) => void patch("policy", { policy })} />

      {batch.preview ? <PreviewView batch={batch} /> : <p className="text-xs text-muted-foreground"><I18nText id="approvals.no_preview_yet" /></p>}

      <ApprovalPanel projectPath={projectPath} batch={batch} busy={busy} run={run} onBatch={onBatch} />
    </div>
  );
}

function IconButton({ label, disabled, onClick, children, testId }: { label: string; disabled?: boolean; onClick: () => void; children: React.ReactNode; testId: string }) {
  useUILocale();
  return (
    <button
      type="button"
      className="rounded p-1 text-muted-foreground hover:bg-muted hover:text-foreground focus-visible:outline focus-visible:outline-2 focus-visible:outline-ring disabled:pointer-events-none disabled:opacity-40"
      onClick={onClick}
      disabled={disabled}
      aria-label={label}
      title={label}
      data-testid={testId}
    >
      {children}
    </button>
  );
}

function PolicyForm({ batch, busy, onSave }: { batch: BatchView; busy: string | null; onSave: (policy: Partial<BatchPolicy>) => void }) {
  useUILocale();
  const ids = useId();
  const [draft, setDraft] = useState<BatchPolicy>(batch.policy);
  const [limitOn, setLimitOn] = useState(batch.policy.maxDurationMinutes != null);
  // Reset the draft only when the stored policy really changed. Keyed on `batch.policy` itself,
  // every background re-read of the batch (an event, a board change) handed over a new object with
  // the same content and silently wiped what the Owner had just ticked but not yet saved — the cause
  // of the intermittent "clicking the checkbox did not change its state" under load.
  const policyKey = JSON.stringify(batch.policy);
  useEffect(() => {
    setDraft(batch.policy);
    setLimitOn(batch.policy.maxDurationMinutes != null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [batch.id, batch.revision, policyKey]);
  const dirty = JSON.stringify({ ...draft, maxDurationMinutes: limitOn ? draft.maxDurationMinutes ?? 60 : null }) !== JSON.stringify(batch.policy);
  const set = <K extends keyof BatchPolicy>(key: K, value: BatchPolicy[K]) => setDraft((current) => ({ ...current, [key]: value }));
  const subscriptionHarnesses = (batch.preview?.harnesses ?? []).filter((harness) => harness.cost.paidApi === "no" && harness.cost.overage === "possible");

  return (
    <fieldset className="space-y-2 rounded-lg border border-border p-2 text-xs" disabled={busy != null} data-testid="batch-policy">
      <legend className="px-1 text-xs font-semibold"><I18nText id="approvals.limits_and_policies" /></legend>
      <div className="grid gap-2 sm:grid-cols-2">
        <label className="flex flex-col gap-0.5">
          <span className="text-muted-foreground"><I18nText id="approvals.at_the_same_time" /></span>
          <Select className="h-8 text-xs" value={String(draft.maxParallel)} onChange={(event) => set("maxParallel", Number(event.target.value))} data-testid="batch-policy-parallel">
            {Array.from({ length: SCHEDULING_LIMITS.maxParallel }, (_, i) => i + 1).map((n) => <option key={n} value={n}>{n === 1 ? tr("common.1_task_one_after_another") : tr("common.tasks_8a68b5", { p0: String(n) })}</option>)}
          </Select>
        </label>
        <label className="flex flex-col gap-0.5">
          <span className="text-muted-foreground"><I18nText id="approvals.agent_starts_at_most_retries_included" /></span>
          <input
            type="number"
            min={1}
            max={SCHEDULING_LIMITS.maxStarts}
            className="h-8 rounded-md border border-input bg-transparent px-2 text-xs"
            value={draft.maxStarts}
            onChange={(event) => set("maxStarts", Math.max(1, Math.min(SCHEDULING_LIMITS.maxStarts, Math.trunc(Number(event.target.value) || 1))))}
            data-testid="batch-policy-starts"
          />
        </label>
        <label className="flex flex-col gap-0.5">
          <span className="text-muted-foreground"><I18nText id="approvals.retries_per_failed_task" /></span>
          <Select className="h-8 text-xs" value={String(draft.maxRetriesPerTask)} onChange={(event) => set("maxRetriesPerTask", Number(event.target.value))} data-testid="batch-policy-retries">
            {Array.from({ length: SCHEDULING_LIMITS.maxRetriesPerTask + 1 }, (_, i) => i).map((n) => <option key={n} value={n}>{n === 0 ? tr("common.no_retries_44666a") : String(n)}</option>)}
          </Select>
        </label>
        <div className="flex flex-col gap-0.5">
          <label className="flex items-center gap-1.5 text-muted-foreground">
            <input type="checkbox" checked={limitOn} onChange={(event) => setLimitOn(event.target.checked)} data-testid="batch-policy-limit-on" /><I18nText id="approvals.time_limit_after_start_minutes" />{" "}</label>
          <input
            type="number"
            min={1}
            max={SCHEDULING_LIMITS.maxDurationMinutes}
            aria-label={tr("approvals.time_limit_in_minutes")}
            className="h-8 rounded-md border border-input bg-transparent px-2 text-xs disabled:opacity-50"
            disabled={!limitOn}
            value={draft.maxDurationMinutes ?? 60}
            onChange={(event) => set("maxDurationMinutes", Math.max(1, Math.min(SCHEDULING_LIMITS.maxDurationMinutes, Math.trunc(Number(event.target.value) || 1))))}
            data-testid="batch-policy-minutes"
          />
        </div>
      </div>
      <RadioGroup name={`${ids}-failure`} legend="When a task fails" value={draft.onFailure} options={FAILURE_OPTIONS} onChange={(value) => set("onFailure", value)} testId="batch-policy-failure" />
      <RadioGroup name={`${ids}-review`} legend="When a task waits for your review" value={draft.reviewPolicy} options={REVIEW_OPTIONS} onChange={(value) => set("reviewPolicy", value)} testId="batch-policy-review" />
      <RadioGroup name={`${ids}-spending`} legend="Spending" value={draft.spending} options={SPENDING_OPTIONS} onChange={(value) => set("spending", value)} testId="batch-policy-spending" />
      {draft.spending === "no-extra" && subscriptionHarnesses.length > 0 && (
        <div className="space-y-1 rounded-md border border-warning/40 bg-warning/5 p-2" data-testid="batch-policy-no-overage">
          <p className="text-[length:var(--text-caption)] text-warning"><I18nText id="approvals.forgeorbit_can_t_see_whether_a_subscription_account" />{" "}</p>
          {subscriptionHarnesses.map((harness) => (
            <label key={harness.id} className="flex items-start gap-1.5 text-[length:var(--text-caption)]">
              <input
                type="checkbox"
                className="mt-0.5"
                checked={draft.noOverageHarnessIds.includes(harness.id)}
                onChange={(event) => set("noOverageHarnessIds", event.target.checked
                  ? [...draft.noOverageHarnessIds, harness.id]
                  : draft.noOverageHarnessIds.filter((id) => id !== harness.id))}
                data-testid="batch-policy-no-overage-harness"
                data-harness-id={harness.id}
              />
              <span>{harness.label}<I18nText id="approvals.its_account_has_no_paid_extra_usage_beyond" /></span>
            </label>
          ))}
        </div>
      )}
      <div className="flex flex-wrap items-center gap-2">
        <Button
          type="button"
          size="sm"
          variant="outline"
          disabled={!dirty || busy != null}
          onClick={() => onSave({ ...draft, maxDurationMinutes: limitOn ? draft.maxDurationMinutes ?? 60 : null })}
          data-testid="batch-policy-save"
        >
          {busy === "policy" ? <Loader2 className="size-3.5 motion-safe:animate-spin" aria-hidden /> : <Check className="size-3.5" aria-hidden />}<I18nText id="approvals.save_and_check" />{" "}</Button>
        {dirty && <span className="text-[length:var(--text-caption)] text-warning"><I18nText id="approvals.unsaved_the_preview_below_doesn_t_include_these" /></span>}
      </div>
    </fieldset>
  );
}

function RadioGroup<T extends string>({
  name,
  legend,
  value,
  options,
  onChange,
  testId,
}: {
  name: string;
  legend: string;
  value: T;
  options: { id: T; label: string; detail: string }[];
  onChange: (value: T) => void;
  testId: string;
}) {
  useUILocale();
  return (
    <fieldset className="space-y-1" data-testid={testId}>
      <legend className="text-muted-foreground">{legend}</legend>
      {options.map((option) => (
        <label key={option.id} className="flex items-start gap-1.5">
          <input type="radio" className="mt-0.5" name={name} value={option.id} checked={value === option.id} onChange={() => onChange(option.id)} data-option={option.id} />
          <span>
            <span className="font-medium">{option.label}</span>
            <span className="block text-[length:var(--text-caption)] text-muted-foreground">{option.detail}</span>
          </span>
        </label>
      ))}
    </fieldset>
  );
}

/** The core's preview, as it came. */
function PreviewView({ batch }: { batch: BatchView }) {
  useUILocale();
  const preview = batch.preview!;
  const errors = preview.issues.filter((item) => item.level === "error");
  const warnings = preview.issues.filter((item) => item.level === "warning");
  const notes = preview.issues.filter((item) => item.level === "info");
  const titleOf = (id: string) => preview.tasks.find((task) => task.taskId === id)?.title ?? titleOfEntry(batch, id);
  return (
    <section className="space-y-2 rounded-lg border border-border p-2 text-xs" aria-label={tr("common.preview")} data-testid="batch-preview" data-key={preview.key}>
      <header className="flex flex-wrap items-center justify-between gap-2">
        <h4 className="text-xs font-semibold"><I18nText id="approvals.preview_from_the_core" /></h4>
        <span className="text-[length:var(--text-caption)] text-muted-foreground"><I18nText id="approvals.checked" />{" "}{formatTime(preview.checkedAt)}</span>
      </header>
      <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-0.5 text-[length:var(--text-caption)]">
        <dt className="text-muted-foreground"><I18nText id="common.tasks_b3a60e" /></dt>
        <dd data-testid="batch-preview-count">{preview.tasks.length}</dd>
        <dt className="text-muted-foreground"><I18nText id="common.agents" /></dt>
        <dd className="min-w-0 break-words" data-testid="batch-preview-harnesses">
          {preview.harnesses.length === 0 ? "—" : preview.harnesses.map((harness) => `${harness.label} (${harness.modes.join(", ")})`).join("; ")}
        </dd>
        <dt className="text-muted-foreground"><I18nText id="approvals.limits" /></dt>
        <dd className="min-w-0 break-words">{policySummary(batch.policy)}</dd>
        <dt className="text-muted-foreground"><I18nText id="approvals.spending" /></dt>
        <dd className="min-w-0 break-words">{SPENDING_OPTIONS.find((option) => option.id === batch.policy.spending)?.label}</dd>
        <dt className="text-muted-foreground"><I18nText id="common.review" /></dt>
        <dd className="min-w-0 break-words">{REVIEW_OPTIONS.find((option) => option.id === batch.policy.reviewPolicy)?.label}</dd>
        <dt className="text-muted-foreground"><I18nText id="approvals.on_failure" /></dt>
        <dd className="min-w-0 break-words">{FAILURE_OPTIONS.find((option) => option.id === batch.policy.onFailure)?.label}</dd>
      </dl>

      {errors.length > 0 && (
        <div data-testid="batch-preview-errors">
          <p className="font-medium text-danger"><I18nText id="approvals.must_be_fixed_before_approval" /></p>
          <ul className="space-y-0.5">{errors.map((item, i) => <CheckLine key={`${item.code}-${i}`} check={item} />)}</ul>
        </div>
      )}
      {warnings.length > 0 && (
        <div data-testid="batch-preview-warnings">
          <p className="font-medium text-warning"><I18nText id="approvals.read_before_approving" /></p>
          <ul className="space-y-0.5">{warnings.map((item, i) => <CheckLine key={`${item.code}-${i}`} check={item} />)}</ul>
        </div>
      )}
      {notes.length > 0 && <ul className="space-y-0.5">{notes.map((item, i) => <CheckLine key={`${item.code}-${i}`} check={item} />)}</ul>}

      <ol className="space-y-1.5" aria-label={tr("approvals.tasks_in_this_batch")} data-testid="batch-preview-tasks">
        {preview.tasks.map((task) => <PreviewRow key={task.taskId} task={task} titleOf={titleOf} />)}
      </ol>

      {preview.order.length > 0 && (
        <p className="break-words text-[length:var(--text-caption)] text-muted-foreground" data-testid="batch-preview-order"><I18nText id="approvals.if_every_task_succeeds_and_you_accept_each" />{" "}{preview.order.map((id) => `“${titleOf(id)}”`).join(" → ")}.
        </p>
      )}
      <div>
        <p className="font-medium"><I18nText id="approvals.the_batch_stops_starting_tasks_when" /></p>
        <ul className="list-disc space-y-0.5 pl-4 text-[length:var(--text-caption)] text-muted-foreground" data-testid="batch-preview-stops">
          {preview.stopConditions.map((line) => <li key={line}>{line}</li>)}
        </ul>
      </div>
    </section>
  );
}

function PreviewRow({ task, titleOf }: { task: BatchPreviewTask; titleOf: (id: string) => string }) {
  useUILocale();
  const problems = task.checks.filter((check) => check.level !== "info");
  return (
    <li className="rounded-md border border-border/70 p-2" data-testid="batch-preview-task" data-task-id={task.taskId}>
      <p className="break-words font-medium">{task.title}</p>
      <dl className="mt-1 grid grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-0.5 text-[length:var(--text-caption)]">
        <dt className="text-muted-foreground"><I18nText id="common.priority" /></dt>
        <dd className={PRIORITY_TONE[task.priority]}>{PRIORITY_OPTIONS.find((p) => p.id === task.priority)?.label}</dd>
        <dt className="text-muted-foreground"><I18nText id="approvals.waits_for" /></dt>
        <dd className="break-words">
          {task.dependsOn.length === 0 ? "—" : task.dependsOn.map((dep) => `${titleOf(dep.taskId)}${dep.done ? tr("common.done_f26306") : dep.inBatch ? "" : tr("common.outside_the_batch_457f4d")}`).join(", ")}
        </dd>
        <dt className="text-muted-foreground"><I18nText id="approvals.runs_as" /></dt>
        <dd className="break-words" data-testid="batch-preview-runs-as">
          {task.pipelineName
            ? <><I18nText id="common.pipeline" />{" "}{task.pipelineName}<span className="block text-muted-foreground">{task.pipelineSteps.map((step) => `${step.name}: ${step.agent}`).join("; ")}</span></>
            : <>{task.profileName ? tr("common.profile_ac8d8d", { p0: String(task.profileName) }) : ""}{task.harnessLabel} · {task.modelLabel}</>}
        </dd>
        <dt className="text-muted-foreground"><I18nText id="common.permissions" /></dt>
        <dd className="break-words">{task.modeLabel} — {ACCESS_TEXT[task.accessLevel] ?? "?"}</dd>
        <dt className="text-muted-foreground"><I18nText id="common.workspace" /></dt>
        <dd className="break-all">
          <span className="font-mono text-[10px]">{task.workspace}</span>
          <span className="block text-muted-foreground">{task.isolation === "worktree" ? tr("common.its_own_git_worktree") : tr("common.directly_in_the_project_folder")}</span>
        </dd>
      </dl>
      {problems.length > 0 && (
        <ul className="mt-1 space-y-0.5">{problems.map((check, i) => <CheckLine key={`${check.code}-${i}`} check={check} />)}</ul>
      )}
    </li>
  );
}

function ApprovalPanel({ projectPath, batch, busy, run, onBatch }: { projectPath: string; batch: BatchView; busy: string | null; run: Runner; onBatch: (batch: BatchView) => void }) {
  useUILocale();
  const preview = batch.preview;
  const [acked, setAcked] = useState<string[]>([]);
  const [reviewed, setReviewed] = useState(false);
  const [stale, setStale] = useState(false);
  const lastKey = useRef(preview?.key ?? null);
  useEffect(() => {
    // A new preview needs a new look: reset every confirmation.
    if (preview?.key !== lastKey.current) {
      if (lastKey.current != null) setStale(true);
      lastKey.current = preview?.key ?? null;
      setAcked([]);
      setReviewed(false);
    }
  }, [preview?.key]);
  if (!preview) return null;
  const harnessLabel = (id: string) => preview.harnesses.find((harness) => harness.id === id)?.label ?? id;
  const missing = preview.spendingHarnessIds.filter((id) => !acked.includes(id));
  const ready = preview.canApprove && missing.length === 0 && reviewed;

  return (
    <section className="space-y-2 rounded-lg border border-info/40 bg-info/5 p-2 text-xs" aria-label={tr("approvals.approval")} data-testid="batch-approval-panel">
      <h4 className="text-xs font-semibold"><I18nText id="approvals.owner_approval" /></h4>
      {stale && (
        <p role="status" className="flex items-start gap-1 text-warning" data-testid="batch-preview-changed">
          <AlertTriangle className="mt-0.5 size-3 shrink-0" aria-hidden /><I18nText id="approvals.the_preview_changed_review_it_again_before_approving" />{" "}</p>
      )}
      {!preview.canApprove && (
        <p className="flex items-start gap-1 text-danger" data-testid="batch-cannot-approve">
          <CircleAlert className="mt-0.5 size-3 shrink-0" aria-hidden /><I18nText id="approvals.fix_the_problems_in_the_preview_first" />{" "}</p>
      )}
      {preview.spendingHarnessIds.length > 0 && (
        <div className="space-y-1" data-testid="batch-spending-acks">
          <p className="text-warning"><I18nText id="approvals.these_agents_may_bill_you_confirm_each_one" /></p>
          {preview.spendingHarnessIds.map((id) => (
            <label key={id} className="flex items-start gap-1.5">
              <input
                type="checkbox"
                className="mt-0.5"
                checked={acked.includes(id)}
                onChange={(event) => setAcked((current) => event.target.checked ? [...current, id] : current.filter((item) => item !== id))}
                data-testid="batch-spending-ack"
                data-harness-id={id}
              />
              <span><I18nText id="approvals.i_accept_possible_paid_usage_on" />{" "}{harnessLabel(id)}<I18nText id="approvals.forgeorbit_doesn_t_know_the_price_my_balance" /></span>
            </label>
          ))}
        </div>
      )}
      <label className="flex items-start gap-1.5">
        <input type="checkbox" className="mt-0.5" checked={reviewed} onChange={(event) => setReviewed(event.target.checked)} data-testid="batch-reviewed" />
        <span><I18nText id="approvals.i_reviewed_exactly_these" />{" "}{preview.tasks.length}{" "}<I18nText id="common.task" />{preview.tasks.length === 1 ? "" : englishPluralSuffix()}<I18nText id="approvals.the_agents_and_permission_modes_above_and_when" />{" "}</span>
      </label>
      <div className="flex flex-wrap items-center gap-2">
        <Button
          className={ACTION}
          type="button"
          size="sm"
          disabled={!ready || busy != null}
          onClick={() => void run("approve", async () => {
            const result = await api.approveBatch(projectPath, batch.id, batch.revision, preview.key, acked);
            setStale(false);
            onBatch(result.batch);
          })}
          data-testid="batch-approve"
        >
          {busy === "approve" ? <Loader2 className="size-3.5 motion-safe:animate-spin" aria-hidden /> : <ShieldCheck className="size-3.5" aria-hidden />}<I18nText id="approvals.approve_batch" />{" "}</Button>
        <Button
          className={ACTION}
          type="button"
          size="sm"
          variant="outline"
          disabled={busy != null}
          onClick={() => void run("preview", async () => {
            onBatch(await api.previewBatch(projectPath, batch.id));
          })}
          data-testid="batch-recheck"
        >
          {busy === "preview" ? <Loader2 className="size-3.5 motion-safe:animate-spin" aria-hidden /> : <RefreshCw className="size-3.5" aria-hidden />}<I18nText id="approvals.check_again" />{" "}</Button>
        <span className="text-[length:var(--text-caption)] text-muted-foreground"><I18nText id="approvals.approving_starts_nothing_you_start_the_batch_separately" /></span>
      </div>
    </section>
  );
}

/* ────────────────────────────────────────────────────────────────────────── *
 * Monitoring.
 * ────────────────────────────────────────────────────────────────────────── */

function Monitor({
  projectPath,
  batch,
  counts,
  tasks,
  previewByTask,
  busy,
  run,
  onBatch,
  onOpenTask,
  onManageAgents,
}: {
  projectPath: string;
  batch: BatchView;
  counts: ReturnType<typeof batchCounts>;
  tasks: Task[];
  previewByTask: Map<string, BatchPreviewTask>;
  busy: string | null;
  run: Runner;
  onBatch: (batch: BatchView) => void;
  onOpenTask: (task: Task) => void;
  onManageAgents: () => void;
}) {
  useUILocale();
  const groups = groupEntries(batch.entries);
  const confirm = useConfirm();
  const [reviewing, setReviewing] = useState<string | null>(null);
  const titleOf = (id: string) => titleOfEntry(batch, id);

  const release = async (entry: BatchEntryView) => {
    const ok = await confirm(() => ({
      title: tr("common.release", { p0: String(entry.currentTitle ?? entry.title) }),
      description: (
        <span className="space-y-1">
          <span className="block"><I18nText id="approvals.it_s_on_hold_because" />{" "}{entry.hold?.reason}</span>
          {entry.hold?.code === "unconfirmed" && (
            <span className="block font-medium"><I18nText id="approvals.check_the_task_and_its_runs_first_if" /></span>
          )}
          <span className="block"><I18nText id="approvals.releasing_lets_the_batch_try_it_again_every" /></span>
        </span>
      ),
      confirmLabel: tr("common.release_task"),
      cancelLabel: tr("common.keep_on_hold"),
    }));
    if (!ok) return;
    await run(`release-${entry.taskId}`, async () => onBatch(await api.releaseBatchTask(projectPath, batch.id, entry.taskId)));
  };

  return (
    <div className="space-y-3" data-testid="batch-monitor">
      <ul className="flex flex-wrap gap-1.5 text-[length:var(--text-caption)]" aria-label={tr("approvals.queue_summary")} data-testid="batch-counts">
        {MONITOR_GROUPS.filter((group) => counts[group.id] > 0).map((group) => (
          <li key={group.id} className="rounded-full border border-border px-2 py-0.5" data-testid="batch-count" data-group={group.id}>
            {group.label}: <span className="font-medium">{counts[group.id]}</span>
          </li>
        ))}
        <li className="rounded-full border border-border px-2 py-0.5 text-muted-foreground"><I18nText id="approvals.starts_used" />{" "}{batch.launchesUsed}{" "}<I18nText id="common.of" />{" "}{batch.policy.maxStarts}</li>
      </ul>
      {batch.next && batch.next.kind === "idle" && (
        <p className="flex items-start gap-1.5 text-[length:var(--text-caption)] text-muted-foreground" role="status" data-testid="batch-next">
          <Info className="mt-0.5 size-3 shrink-0" aria-hidden />
          <span className="min-w-0 break-words"><I18nText id="approvals.why_nothing_new_is_starting" />{" "}{batch.next.reason}</span>
        </p>
      )}

      {MONITOR_GROUPS.map((group) => {
        const entries = groups.get(group.id) ?? [];
        if (entries.length === 0) return null;
        return (
          <section key={group.id} aria-label={group.label} data-testid="batch-group" data-group={group.id}>
            <h4 className="mb-1 text-xs font-semibold">{group.label} <span className="font-normal text-muted-foreground">({entries.length})</span></h4>
            <ul className="space-y-1.5">
              {entries.map((entry) => {
                const task = tasks.find((item) => item.id === entry.taskId) ?? null;
                const preview = previewByTask.get(entry.taskId);
                const lastStarted = [...entry.attempts].reverse().find((attempt) => attempt.outcome === "started");
                const executionId = lastStarted?.executionId ?? [...entry.attempts].reverse().find((attempt) => attempt.executionId)?.executionId ?? null;
                const deps = entry.approved?.dependsOn ?? [];
                return (
                  <li key={entry.taskId} className="space-y-1 rounded-lg border border-border p-2 text-xs" data-testid="batch-entry" data-task-id={entry.taskId} data-state={entry.state}>
                    <div className="flex flex-wrap items-start justify-between gap-2">
                      <div className="min-w-0 flex-1">
                        <p className="break-words font-medium" data-testid="batch-entry-title">{entry.currentTitle ?? entry.title}</p>
                        <p className="text-[length:var(--text-caption)] text-muted-foreground">
                          <span className={PRIORITY_TONE[entry.priority]}>{PRIORITY_OPTIONS.find((p) => p.id === entry.priority)?.label}</span>
                          {preview ? ` · ${preview.pipelineName ? tr("common.pipeline_5b7717", { p0: String(preview.pipelineName) }) : `${preview.harnessLabel} · ${preview.modelLabel}`}` : ""}
                          {entry.pipeline && entry.pipeline.activeSteps.length > 0 ? tr("common.step_65186c", { p0: String(entry.pipeline.activeSteps.join(", ")) }) : ""}
                        </p>
                      </div>
                      <span className={cn("shrink-0 rounded-full px-2 py-0.5 text-[length:var(--text-caption)] font-medium", ENTRY_STATE_TONE[entry.state])} data-testid="batch-entry-state">
                        {ENTRY_STATE_LABEL[entry.state]}
                      </span>
                    </div>
                    <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-0.5 text-[length:var(--text-caption)]">
                      {deps.length > 0 && (
                        <>
                          <dt className="text-muted-foreground"><I18nText id="approvals.waits_for" /></dt>
                          <dd className="min-w-0 break-words">{deps.map(titleOf).join(", ")}</dd>
                        </>
                      )}
                      {entry.state === "pending" && entry.readiness.state !== "ready" && (
                        <>
                          <dt className="text-muted-foreground"><I18nText id="approvals.not_ready" /></dt>
                          <dd className="min-w-0 break-words" data-testid="batch-entry-readiness">
                            {entry.readiness.state === "waiting"
                              ? tr("common.waiting_for_to_be_done", { p0: String(entry.readiness.on.map(titleOf).map((title) => `“${title}”`).join(", ")) })
                              : entry.readiness.by.map((item) => item.reason).join(" ")}
                          </dd>
                        </>
                      )}
                      {entry.state === "review" && (
                        <>
                          <dt className="text-muted-foreground"><I18nText id="approvals.waiting" /></dt>
                          <dd className="min-w-0 break-words" data-testid="batch-entry-review-note"><I18nText id="approvals.the_agent_finished_that_isn_t_acceptance_tasks" />{" "}</dd>
                        </>
                      )}
                      <dt className="text-muted-foreground"><I18nText id="common.run" /></dt>
                      <dd className="min-w-0 break-words" data-testid="batch-entry-run">
                        {lastStarted?.runId ? <><span className="font-mono">{lastStarted.runId.slice(0, 8)}</span>{entry.runStatus ? ` · ${entry.runStatus}` : ""}</> : entry.pipeline ? `pipeline ${entry.pipeline.status}` : tr("common.not_started_by_the_batch")}
                        {entry.attempts.length > 1 ? tr("common.attempts", { p0: String(entry.attempts.length) }) : ""}
                      </dd>
                      {entry.attempts.at(-1)?.error && (
                        <>
                          <dt className="text-muted-foreground"><I18nText id="common.error" /></dt>
                          <dd className="min-w-0 break-words text-danger" data-testid="batch-entry-error">{entry.attempts.at(-1)!.error}</dd>
                        </>
                      )}
                    </dl>
                    {entry.hold && (
                      <p className="flex items-start gap-1 rounded-md border border-warning/40 bg-warning/10 px-2 py-1 text-[length:var(--text-caption)] text-warning" data-testid="batch-entry-hold" data-code={entry.hold.code}>
                        <AlertTriangle className="mt-0.5 size-3 shrink-0" aria-hidden />
                        <span className="min-w-0 break-words"><I18nText id="approvals.on_hold" />{" "}{entry.hold.reason}</span>
                      </p>
                    )}
                    <div className="flex flex-wrap gap-2">
                      {task && (lastStarted || task.runId) && (
                        <Button className={ACTION} type="button" size="sm" variant="outline" onClick={() => onOpenTask(task)} data-testid="batch-entry-open-run">
                          <ExternalLink className="size-3.5" aria-hidden /><I18nText id="approvals.open_run" />{" "}</Button>
                      )}
                      {executionId && (
                        <Button
                          className={ACTION}
                          type="button"
                          size="sm"
                          variant={entry.state === "review" ? "default" : "outline"}
                          onClick={() => setReviewing(reviewing === entry.taskId ? null : entry.taskId)}
                          aria-expanded={reviewing === entry.taskId}
                          data-testid="batch-entry-review"
                        >
                          {entry.state === "review" ? tr("common.review_result") : tr("common.result")}
                        </Button>
                      )}
                      {entry.hold && batch.status !== "cancelled" && batch.status !== "completed" && batch.status !== "stopped" && (
                        <Button className={ACTION} type="button" size="sm" variant="outline" onClick={() => void release(entry)} disabled={busy != null} data-testid="batch-entry-release">
                          <Unlock className="size-3.5" aria-hidden /><I18nText id="approvals.release" />{" "}</Button>
                      )}
                    </div>
                    {reviewing === entry.taskId && executionId && (
                      <EntryReview
                        projectPath={projectPath}
                        executionId={executionId}
                        stateKey={`${entry.state}:${entry.runStatus ?? ""}:${entry.column ?? ""}`}
                        tasks={tasks}
                        onOpenTask={onOpenTask}
                        onManageAgents={onManageAgents}
                      />
                    )}
                  </li>
                );
              })}
            </ul>
          </section>
        );
      })}
    </div>
  );
}

/** The FO-005B card of the batch's own launch: result, changed files,
 *  errors, Accept / Request fix / Return. Re-read when the entry moves. */
function EntryReview({
  projectPath,
  executionId,
  stateKey,
  tasks,
  onOpenTask,
  onManageAgents,
}: {
  projectPath: string;
  executionId: string;
  stateKey: string;
  tasks: Task[];
  onOpenTask: (task: Task) => void;
  onManageAgents: () => void;
}) {
  useUILocale();
  const [execution, setExecution] = useState<ExecutionView | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let cancelled = false;
    void api.getExecution(projectPath, executionId).then(
      (view) => { if (!cancelled) { setExecution(view); setError(null); } },
      (reason: unknown) => { if (!cancelled) setError(messageOf(reason)); },
    );
    return () => { cancelled = true; };
  }, [projectPath, executionId, stateKey]);
  if (error) return <p role="alert" className="text-[length:var(--text-caption)] text-danger">{error}</p>;
  if (!execution) return <p className="flex items-center gap-1 text-[length:var(--text-caption)] text-muted-foreground"><Loader2 className="size-3 motion-safe:animate-spin" aria-hidden /><I18nText id="approvals.loading_the_result" /></p>;
  return (
    <div data-testid="batch-entry-review-card">
      <ExecutionCard
        projectPath={projectPath}
        execution={execution}
        tasks={tasks}
        onChanged={setExecution}
        onOpenTask={onOpenTask}
        onManageAgents={onManageAgents}
      />
    </div>
  );
}

/* ────────────────────────────────────────────────────────────────────────── *
 * History.
 * ────────────────────────────────────────────────────────────────────────── */

function BatchEvents({ projectPath, batch }: { projectPath: string; batch: BatchView }) {
  useUILocale();
  const [events, setEvents] = useState<BatchEventRow[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const load = useCallback(() => {
    void api.batchEvents(projectPath, batch.id).then(
      (result) => { setEvents(result.events); setError(null); },
      (reason: unknown) => setError(messageOf(reason)),
    );
  }, [projectPath, batch.id]);
  useEffect(() => {
    setEvents(null);
  }, [batch.id]);
  // Re-read when this batch changes (its own event, or a new revision).
  useEffect(() => subscribeBatchEvents((event) => {
    if (event.batchId !== batch.id || event.projectPath !== projectPath) return;
    if (timer.current) return;
    timer.current = setTimeout(() => {
      timer.current = null;
      load();
    }, 300);
  }), [batch.id, projectPath, load]);
  useEffect(() => () => { if (timer.current) clearTimeout(timer.current); }, []);
  useEffect(() => { load(); }, [batch.updatedAt, load]);

  return (
    <details className="rounded-lg border border-border px-2 py-1.5 text-xs" data-testid="batch-events">
      <summary className="cursor-pointer text-muted-foreground"><I18nText id="common.history" />{events ? ` (${events.length})` : ""}</summary>
      {error && <p role="alert" className="mt-1 text-[length:var(--text-caption)] text-danger">{error} <button type="button" className="underline" onClick={load}><I18nText id="common.retry" /></button></p>}
      {events && events.length === 0 && <p className="mt-1 text-[length:var(--text-caption)] text-muted-foreground"><I18nText id="approvals.no_events_yet" /></p>}
      {events && events.length > 0 && (
        <ol className="mt-1 max-h-64 space-y-0.5 overflow-y-auto text-[length:var(--text-caption)]" data-testid="batch-event-list">
          {events.map((event) => (
            <li key={event.id} className="flex gap-2" data-testid="batch-event" data-kind={event.kind}>
              <time className="shrink-0 tabular-nums text-muted-foreground" dateTime={new Date(event.at).toISOString()}>{formatTime(event.at)}</time>
              <span className="min-w-0 break-words">{event.text}</span>
            </li>
          ))}
        </ol>
      )}
    </details>
  );
}
