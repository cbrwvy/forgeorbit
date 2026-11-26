import { t as tr } from "@/i18n/core";
import { useLocale as useUILocale } from "@/i18n/react";
import { useCallback, useEffect, useRef, useState } from "react";
import { ArrowDown, ArrowUp, ListOrdered, Loader2, Pause, Play, Square, X } from "lucide-react";
import { ApiError, api } from "@/lib/api";
import { Button } from "@/components/ui/button";
import type { PlanView } from "../../../../shared/task-plan.ts";
import type { QueueBatchView, QueueEntryState, QueuePhase, QueueView } from "../../../../shared/task-queue.ts";
import type { Task } from "../../../../shared/types.ts";

const STATE_TONE: Record<QueueEntryState, string> = {
  ready: "bg-success/10 text-success",
  blocked: "bg-warning/10 text-warning",
  "in-progress": "bg-info/10 text-info",
  "waiting-owner": "bg-warning/10 text-warning",
  completed: "bg-muted text-muted-foreground",
  removed: "bg-muted text-muted-foreground",
};

const PHASE_TONE: Record<QueuePhase, string> = {
  "ready-to-review": "bg-success/10 text-success",
  "waiting-dependency": "bg-warning/10 text-warning",
  "waiting-assignment": "bg-warning/10 text-warning",
  "waiting-owner": "bg-warning/10 text-warning",
  "in-progress": "bg-info/10 text-info",
  completed: "bg-muted text-muted-foreground",
  paused: "bg-muted text-muted-foreground",
  stopped: "bg-muted text-muted-foreground",
  stale: "bg-warning/10 text-warning",
};

interface Props {
  projectPath: string;
  proposalId: string;
  plan: PlanView;
  tasks: Task[];
  onOpenTask: (task: Task) => void;
  /** The existing Employee Review for a task. The queue only points at it. */
  onExecute?: (taskId: string) => void;
  /** Open a batch in the Autonomous Execution tab, where it is approved and started. */
  onOpenBatch?: (batchId: string) => void;
  /** The core answered 409 with a fresher plan. */
  onStalePlan: (plan: PlanView | null) => void;
}

/**
 * The Owner's execution queue for a plan: which ready tasks, in which order,
 * paused or stopped. It stores that choice and nothing else; ready, blocked,
 * running and done are derived from the plan. "Review next task" asks the
 * core to confirm that the queue and plan are still what was reviewed, then
 * opens the existing Employee Review for that one task. The queue never
 * starts, assigns or retries anything.
 */
export function TaskQueuePanel({ projectPath, proposalId, plan, tasks, onOpenTask, onExecute, onOpenBatch, onStalePlan }: Props) {
  useUILocale();
  const [queue, setQueue] = useState<QueueView | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [order, setOrder] = useState<string[]>([]);
  const [dirty, setDirty] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const epoch = useRef(0);
  // The queue reload resolves after the Owner may have started editing, so it must read the live flag.
  const dirtyRef = useRef(false);
  dirtyRef.current = dirty;

  const adopt = useCallback((next: QueueView | null) => {
    setQueue(next);
    setOrder(next ? next.entries.map((entry) => entry.taskId) : []);
    setDirty(false);
  }, []);

  useEffect(() => {
    const mine = ++epoch.current;
    void api.getPlanQueue(projectPath, proposalId)
      .then(({ queue: next }) => {
        if (epoch.current !== mine) return;
        setLoaded(true);
        // Keep the Owner's unsaved edits across a plan refresh; the saved
        // queue itself is always re-derived.
        setQueue(next);
        if (!dirtyRef.current) setOrder(next ? next.entries.map((entry) => entry.taskId) : []);
      })
      .catch((caught) => {
        if (epoch.current === mine) setError(caught instanceof Error ? caught.message : String(caught));
      });
    return () => { epoch.current += 1; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectPath, proposalId, plan.planKey]);

  const run = async (work: () => Promise<void>) => {
    setBusy(true);
    setError(null);
    try {
      await work();
    } catch (caught) {
      if (caught instanceof ApiError && caught.status === 409) {
        const body = caught.body as { plan?: PlanView; queue?: QueueView } | null;
        if (body?.plan) onStalePlan(body.plan);
        else onStalePlan(null);
        if (body?.queue) setQueue(body.queue);
      }
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setBusy(false);
    }
  };

  const nodeOf = (taskId: string) => plan.nodes.find((node) => node.taskId === taskId) ?? null;
  const candidates = plan.nodes.filter((node) =>
    node.stage === "created" && node.state === "ready" && node.taskId && !order.includes(node.taskId));
  const move = (index: number, by: -1 | 1) => {
    const target = index + by;
    if (target < 0 || target >= order.length) return;
    const copy = [...order];
    [copy[index], copy[target]] = [copy[target]!, copy[index]!];
    setOrder(copy);
    setDirty(true);
  };

  const save = () => run(async () => {
    const saved = await api.savePlanQueue(projectPath, proposalId, { taskIds: order, planKey: plan.planKey, ...(queue ? { revision: queue.revision } : {}) });
    adopt(saved.queue);
  });
  const status = (action: "pause" | "resume" | "stop") => run(async () => {
    if (!queue) return;
    adopt((await api.setPlanQueueStatus(projectPath, queue.id, action, queue.revision)).queue);
  });
  const setAuto = (enabled: boolean) => run(async () => {
    if (!queue) return;
    adopt((await api.setPlanQueueAutoPrepare(projectPath, queue.id, enabled, queue.revision)).queue);
  });
  // The Owner's explicit confirmation of the updated plan: the same save the
  // queue always used, with the plan key the Owner is looking at. A candidate
  // outside the queue is added only by this click.
  const confirmPlan = (addTaskId?: string) => run(async () => {
    const taskIds = addTaskId && !order.includes(addTaskId) ? [...order, addTaskId] : order;
    const saved = await api.savePlanQueue(projectPath, proposalId, { taskIds, planKey: plan.planKey, ...(queue ? { revision: queue.revision } : {}) });
    adopt(saved.queue);
  });
  const batchAction = (batchId: string, action: "pause" | "cancel") => run(async () => {
    await api.batchAction(projectPath, batchId, action);
    const fresh = await api.getPlanQueue(projectPath, proposalId);
    if (fresh.queue) setQueue(fresh.queue);
  });
  const [notice, setNotice] = useState<string | null>(null);
  const prepareBatch = (taskIds: string[]) => run(async () => {
    if (!queue) return;
    setNotice(null);
    const result = await api.prepareQueueBatch(projectPath, queue.id, { revision: queue.revision, planKey: plan.planKey, taskIds });
    setQueue(result.queue);
    setNotice(tr(result.alreadyPrepared ? "queue.handoff.already" : "queue.handoff.prepared"));
  });
  const reviewNext = () => run(async () => {
    if (!queue) return;
    const { next } = await api.nextPlanQueueTask(projectPath, queue.id, queue.revision, plan.planKey);
    const task = tasks.find((candidate) => candidate.id === next.taskId);
    if (onExecute) onExecute(next.taskId);
    else if (task) onOpenTask(task);
  });

  if (!loaded && !error) return null;
  const entries = queue?.entries ?? [];
  const entryOf = (taskId: string) => entries.find((entry) => entry.taskId === taskId) ?? null;
  const active = queue?.status === "active";

  return (
    <div className="space-y-2 rounded-md border border-border/70 px-2 py-2 text-xs" data-testid="task-queue" data-queue-status={queue?.status ?? "none"}>
      <div className="flex flex-wrap items-center gap-2">
        <ListOrdered className="size-3.5" aria-hidden />
        <span className="font-medium">{tr("queue.title")}</span>
        {queue && (
          <span className="rounded bg-muted px-1.5 py-0.5 text-[10px] font-medium" data-testid="task-queue-status">{tr(`queue.status.${queue.status}`)}</span>
        )}
        {dirty && <span className="text-[10px] text-warning" data-testid="task-queue-unsaved">{tr("queue.unsaved")}</span>}
      </div>
      <p className="text-[11px] text-muted-foreground">{tr("queue.note")}</p>
      {error && <p role="alert" className="break-words text-[11px] text-danger" data-testid="task-queue-error">{error}</p>}
      {queue?.needsReview && !dirty && (
        <div className="flex flex-wrap items-center gap-2 rounded-md border border-warning/40 bg-warning/10 px-2 py-1 text-warning" role="alert" data-testid="task-queue-needs-review">
          <span className="min-w-0 flex-1 text-[11px]">{tr("queue.needs_review")}</span>
          <Button type="button" size="sm" variant="outline" disabled={busy} onClick={() => { void save(); }} data-testid="task-queue-review-again">{tr("queue.review_again")}</Button>
        </div>
      )}

      {queue && <Progression
        queue={queue}
        dirty={dirty}
        busy={busy}
        onConfirm={confirmPlan}
        onAuto={setAuto}
      />}

      {queue && !dirty && (
        <Handoff queue={queue} busy={busy} notice={notice} onPrepare={prepareBatch} onOpenBatch={onOpenBatch} onBatchAction={batchAction} />
      )}

      {order.length === 0 ? (
        <p className="text-muted-foreground" data-testid="task-queue-empty">{tr("queue.empty")}</p>
      ) : (
        <ol className="space-y-1.5" data-testid="task-queue-entries">
          {order.map((taskId, index) => {
            const entry = entryOf(taskId);
            const node = nodeOf(taskId);
            const state: QueueEntryState = entry?.state ?? "ready";
            const title = entry?.title ?? node?.title ?? taskId.slice(0, 8);
            const option = (entry?.node ?? node)?.executor?.proposed ?? null;
            const task = tasks.find((candidate) => candidate.id === taskId) ?? null;
            return (
              <li key={taskId} className="min-w-0 space-y-1 rounded-md border border-border/60 px-2 py-1" data-testid="task-queue-entry" data-state={state} data-task-id={taskId} data-position={index + 1}>
                <div className="flex flex-wrap items-center gap-2">
                  <span className="text-[10px] text-muted-foreground">{index + 1}.</span>
                  <span className="min-w-0 break-words font-medium" data-testid="task-queue-entry-title">{title}</span>
                  <span className={`rounded px-1.5 py-0.5 text-[10px] font-medium ${STATE_TONE[state]}`} data-testid="task-queue-entry-state">
                    {state === "removed" ? tr("queue.state.removed") : tr(`plan.state.${state}`)}
                  </span>
                  {queue?.next?.taskId === taskId && !dirty && <span className="rounded bg-success/10 px-1.5 py-0.5 text-[10px] font-medium text-success" data-testid="task-queue-entry-next">{tr("queue.next")}</span>}
                  <span className="ml-auto flex items-center gap-1">
                    <Button type="button" size="icon" variant="ghost" className="size-6" aria-label={tr("queue.up")} disabled={busy || index === 0} onClick={() => move(index, -1)} data-testid="task-queue-up"><ArrowUp className="size-3" aria-hidden /></Button>
                    <Button type="button" size="icon" variant="ghost" className="size-6" aria-label={tr("queue.down")} disabled={busy || index === order.length - 1} onClick={() => move(index, 1)} data-testid="task-queue-down"><ArrowDown className="size-3" aria-hidden /></Button>
                    <Button type="button" size="icon" variant="ghost" className="size-6" aria-label={tr("queue.remove")} disabled={busy} onClick={() => { setOrder(order.filter((id) => id !== taskId)); setDirty(true); }} data-testid="task-queue-remove"><X className="size-3" aria-hidden /></Button>
                  </span>
                </div>
                {entry && entry.reasons.length > 0 && (
                  <ul className="list-disc pl-4 text-muted-foreground" data-testid="task-queue-reasons">
                    {entry.reasons.map((reason, i) => <li key={i} className="break-words">{reason}</li>)}
                  </ul>
                )}
                {entry && entry.state === "ready" && (
                  <p className="break-words text-muted-foreground" data-testid="task-queue-executor">
                    {tr("queue.executor")}: {option ? `${option.harnessLabel} · ${option.modelLabel} (${option.availability === "unknown" ? tr("queue.availability_unknown") : option.availability})` : tr("queue.no_executor")}
                  </p>
                )}
                {task && <button type="button" className="underline underline-offset-2" onClick={() => onOpenTask(task)} data-testid="task-queue-open-task">{tr("common.open_task")}</button>}
              </li>
            );
          })}
        </ol>
      )}

      {candidates.length > 0 && (
        <div className="space-y-1" data-testid="task-queue-candidates">
          <p className="font-medium">{tr("queue.candidates")}</p>
          <ul className="space-y-1">
            {candidates.map((node) => (
              <li key={node.itemId} className="flex flex-wrap items-center gap-2">
                <span className="min-w-0 break-words">{node.title}</span>
                <Button type="button" size="sm" variant="outline" disabled={busy} onClick={() => { setOrder([...order, node.taskId!]); setDirty(true); }} data-testid="task-queue-add">{tr("queue.add")}</Button>
              </li>
            ))}
          </ul>
        </div>
      )}

      <div className="flex flex-wrap items-center gap-2">
        {(dirty || (!queue && order.length > 0)) && (
          <Button type="button" size="sm" disabled={busy || order.length === 0} onClick={() => { void save(); }} data-testid="task-queue-save">
            {busy && <Loader2 className="size-3.5 motion-safe:animate-spin" aria-hidden />}{tr("queue.save")}
          </Button>
        )}
        {queue && !dirty && (
          <>
            <Button type="button" size="sm" variant="outline" disabled={busy || !active || !queue.next || queue.needsReview} onClick={() => { void reviewNext(); }} data-testid="task-queue-review-next">
              <Play className="size-3.5" aria-hidden />{tr("queue.review_next")}
            </Button>
            {queue.status === "active" && <Button type="button" size="sm" variant="ghost" disabled={busy} onClick={() => { void status("pause"); }} data-testid="task-queue-pause"><Pause className="size-3.5" aria-hidden />{tr("queue.pause")}</Button>}
            {queue.status === "paused" && <Button type="button" size="sm" variant="ghost" disabled={busy} onClick={() => { void status("resume"); }} data-testid="task-queue-resume"><Play className="size-3.5" aria-hidden />{tr("queue.resume")}</Button>}
            {queue.status !== "stopped" && <Button type="button" size="sm" variant="ghost" disabled={busy} onClick={() => { void status("stop"); }} data-testid="task-queue-stop"><Square className="size-3.5" aria-hidden />{tr("queue.stop")}</Button>}
          </>
        )}
      </div>
      {queue && !dirty && !queue.next && queue.nextBlockedReason && (
        <p className="break-words text-[11px] text-muted-foreground" data-testid="task-queue-no-next">{queue.nextBlockedReason}</p>
      )}
    </div>
  );
}


interface ProgressionProps {
  queue: QueueView;
  dirty: boolean;
  busy: boolean;
  onConfirm: (addTaskId: string) => Promise<void>;
  onAuto: (enabled: boolean) => Promise<void>;
}

/**
 * Where the queue stands and what the Owner can do next. Everything here is
 * derived by the core; the only writes are the Owner's own clicks: confirm the
 * updated plan (the existing save) and the opt-in switch.
 */
function Progression({ queue, dirty, busy, onConfirm, onAuto }: ProgressionProps) {
  const p = queue.progression;
  const candidate = p.candidate;
  const executor = candidate?.executor ?? null;
  return (
    <div className="space-y-1.5 rounded-md border border-border/60 px-2 py-1.5" data-testid="task-queue-progression" data-phase={p.phase} data-can-open-review={p.canOpenReview ? "true" : "false"}>
      <div className="flex flex-wrap items-center gap-2">
        <span className="font-medium">{tr("queue.progress.title")}</span>
        <span className={`rounded px-1.5 py-0.5 text-[10px] font-medium ${PHASE_TONE[p.phase]}`} data-testid="task-queue-phase">{tr(`queue.phase.${p.phase}`)}</span>
        {queue.autoPrepare && <span className="rounded bg-info/10 px-1.5 py-0.5 text-[10px] text-info" data-testid="task-queue-auto-badge">{tr("queue.auto.label")}</span>}
      </div>
      {p.reason && <p className="break-words text-[11px] text-muted-foreground" data-testid="task-queue-phase-reason">{p.reason}</p>}
      {p.current && (
        <p className="break-words text-[11px]" data-testid="task-queue-current">{tr("queue.progress.current")}: <span className="font-medium">{p.current.title}</span></p>
      )}

      {candidate && (
        <div className="space-y-0.5 rounded border border-border/50 px-2 py-1" data-testid="task-queue-candidate" data-task-id={candidate.taskId} data-in-queue={candidate.inQueue ? "true" : "false"}>
          <p className="break-words font-medium">{tr("queue.progress.candidate")}: {candidate.title}</p>
          {candidate.position != null && <p className="text-[11px] text-muted-foreground">{tr("queue.progress.position")}: {candidate.position}</p>}
          {!candidate.inQueue && <p className="text-[11px] text-warning" data-testid="task-queue-candidate-outside">{tr("queue.progress.outside")}</p>}
          <p className="break-words text-[11px] text-muted-foreground" data-testid="task-queue-candidate-worker">
            {tr("queue.progress.worker")}: {candidate.assignee ? (candidate.assignee.employeeName ?? candidate.assignee.employeeId) : tr("queue.progress.no_worker")}
          </p>
          <p className="break-words text-[11px] text-muted-foreground" data-testid="task-queue-candidate-executor">
            {tr("queue.executor")}: {executor ? `${executor.harnessLabel} · ${executor.modelLabel}` : tr("queue.no_executor")}
          </p>
          {executor && (
            <p className="break-words text-[11px] text-muted-foreground" data-testid="task-queue-candidate-availability" data-availability={executor.availability}>
              {tr("queue.progress.availability")}: {executor.availability === "unknown" ? tr("queue.progress.availability_unknown") : executor.availability}
            </p>
          )}
          {executor?.modeLabel && (
            <p className="break-words text-[11px] text-muted-foreground" data-testid="task-queue-candidate-mode" data-mode={executor.modeId ?? ""}>
              {tr("queue.progress.permission")}: {executor.modeLabel}
            </p>
          )}
          {executor?.fullAccess && <p className="text-[11px] text-warning" data-testid="task-queue-candidate-full-access">{tr("queue.progress.full_access")}</p>}
        </div>
      )}

      {p.changes.length > 0 && (
        <div className="space-y-0.5" data-testid="task-queue-changes" data-material={p.materialChange ? "true" : "false"}>
          <p className="font-medium">{tr("queue.progress.changes")}</p>
          <p className={`text-[11px] ${p.materialChange ? "text-warning" : "text-muted-foreground"}`} data-testid="task-queue-changes-note">
            {tr(p.materialChange ? "queue.progress.material" : "queue.progress.expected")}
          </p>
          <ul className="list-disc space-y-0.5 pl-4">
            {p.changes.map((change, i) => (
              <li key={i} className="break-words text-[11px]" data-testid="task-queue-change" data-kind={change.kind} data-material={change.material ? "true" : "false"}>
                <span className="mr-1 rounded bg-muted px-1 py-0.5 text-[10px]">{tr(`queue.change.${change.kind}`)}</span>{change.message}
              </li>
            ))}
          </ul>
        </div>
      )}
      {p.changesUnavailable && <p className="text-[11px] text-muted-foreground" data-testid="task-queue-changes-unavailable">{tr("queue.progress.unavailable")}</p>}
      {p.becameReady.length > 0 && (
        <p className="break-words text-[11px]" data-testid="task-queue-became-ready">{tr("queue.progress.became_ready")}: {p.becameReady.map((item) => item.title).join(", ")}</p>
      )}
      {p.stillBlocked.length > 0 && (
        <div data-testid="task-queue-still-blocked">
          <p className="text-[11px] font-medium">{tr("queue.progress.still_blocked")}</p>
          <ul className="list-disc pl-4 text-[11px] text-muted-foreground">
            {p.stillBlocked.map((item) => <li key={item.taskId} className="break-words" data-task-id={item.taskId}>{item.title}{item.reasons[0] ? `: ${item.reasons[0]}` : ""}</li>)}
          </ul>
        </div>
      )}

      <div className="flex flex-wrap items-center gap-2">
        {/* Re-confirming a plan whose queued tasks are unchanged is the banner's "Review again"; this adds a ready task from outside the queue. */}
        {candidate && !candidate.inQueue && queue.status === "active" && !dirty && (
          <Button type="button" size="sm" variant="outline" disabled={busy} onClick={() => { void onConfirm(candidate.taskId); }} data-testid="task-queue-confirm-plan">
            {tr("queue.confirm_plan_add")}
          </Button>
        )}
        {queue.status !== "stopped" && (
          <label className="flex min-w-0 items-center gap-1.5 text-[11px]">
            <input type="checkbox" checked={queue.autoPrepare} disabled={busy} onChange={(event) => { void onAuto(event.target.checked); }} data-testid="task-queue-auto-prepare" />
            <span>{tr("queue.auto.label")}</span>
          </label>
        )}
      </div>
      <p className="text-[10px] text-muted-foreground">{tr("queue.auto.help")}</p>
    </div>
  );
}


const BATCH_TONE: Record<string, string> = {
  draft: "bg-muted text-muted-foreground",
  approved: "bg-info/10 text-info",
  running: "bg-info/10 text-info",
  paused: "bg-warning/10 text-warning",
  completed: "bg-success/10 text-success",
  stopped: "bg-muted text-muted-foreground",
  cancelled: "bg-muted text-muted-foreground",
};

interface HandoffProps {
  queue: QueueView;
  busy: boolean;
  notice: string | null;
  onPrepare: (taskIds: string[]) => Promise<void>;
  onOpenBatch?: (batchId: string) => void;
  onBatchAction: (batchId: string, action: "pause" | "cancel") => Promise<void>;
}

/**
 * Queue → Execution Batch. Prepares a draft only; the batch's own approve and
 * start controls (in Autonomous Execution) are the Owner's authorization, and
 * the batch, not the queue, owns every run. Everything shown is derived by the
 * core on each read.
 */
function Handoff({ queue, busy, notice, onPrepare, onOpenBatch, onBatchAction }: HandoffProps) {
  const { handoff, batches } = queue;
  const [picked, setPicked] = useState<string[] | null>(null);
  const eligibleIds = handoff.eligible.map((entry) => entry.taskId);
  const selected = (picked ?? eligibleIds).filter((id) => eligibleIds.includes(id));
  if (handoff.eligible.length === 0 && handoff.excluded.length === 0 && batches.length === 0) return null;
  const toggle = (id: string) => setPicked(selected.includes(id) ? selected.filter((item) => item !== id) : [...selected, id]);
  return (
    <div className="space-y-1.5 rounded-md border border-border/60 px-2 py-1.5" data-testid="task-queue-handoff" data-can-prepare={handoff.canPrepare ? "true" : "false"}>
      <p className="font-medium">{tr("queue.handoff.title")}</p>
      <p className="text-[11px] text-muted-foreground">{tr("queue.handoff.note")}</p>
      {notice && <p role="status" className="text-[11px] text-success" data-testid="task-queue-handoff-notice">{notice}</p>}
      {handoff.eligible.length > 0 && (
        <div data-testid="task-queue-handoff-eligible">
          <p className="text-[11px] font-medium">{tr("queue.handoff.eligible")}</p>
          <ul className="space-y-0.5">
            {handoff.eligible.map((entry) => (
              <li key={entry.taskId}>
                <label className="flex min-w-0 items-center gap-1.5 text-[11px]">
                  <input type="checkbox" checked={selected.includes(entry.taskId)} disabled={busy || !handoff.canPrepare} onChange={() => toggle(entry.taskId)} data-testid="task-queue-handoff-pick" data-task-id={entry.taskId} />
                  <span className="break-words">{entry.position}. {entry.title}</span>
                </label>
              </li>
            ))}
          </ul>
        </div>
      )}
      {handoff.excluded.length > 0 && (
        <div data-testid="task-queue-handoff-excluded">
          <p className="text-[11px] font-medium">{tr("queue.handoff.excluded")}</p>
          <ul className="list-disc pl-4 text-[11px] text-muted-foreground">
            {handoff.excluded.map((entry) => (
              <li key={entry.taskId} className="break-words" data-task-id={entry.taskId}>{entry.position}. {entry.title}: {entry.reasons[0]}</li>
            ))}
          </ul>
        </div>
      )}
      {!handoff.canPrepare && handoff.reason && <p className="break-words text-[11px] text-muted-foreground" data-testid="task-queue-handoff-reason">{handoff.reason}</p>}
      <Button type="button" size="sm" variant="outline" disabled={busy || !handoff.canPrepare || selected.length === 0} onClick={() => { void onPrepare(selected).then(() => setPicked(null)); }} data-testid="task-queue-handoff-prepare">
        {tr("queue.handoff.prepare")}
      </Button>

      {batches.length > 0 && (
        <div className="space-y-1" data-testid="task-queue-batches">
          <p className="font-medium">{tr("queue.batch.title")}</p>
          {batches.map((batch) => <BatchRow key={batch.id} batch={batch} busy={busy} onOpenBatch={onOpenBatch} onBatchAction={onBatchAction} />)}
        </div>
      )}
    </div>
  );
}

function BatchRow({ batch, busy, onOpenBatch, onBatchAction }: { batch: QueueBatchView; busy: boolean; onOpenBatch?: (id: string) => void; onBatchAction: HandoffProps["onBatchAction"] }) {
  const open = batch.status === "draft" || batch.status === "approved" || batch.status === "running" || batch.status === "paused";
  return (
    <div className="space-y-0.5 rounded border border-border/50 px-2 py-1" data-testid="task-queue-batch" data-batch-id={batch.id} data-status={batch.status} data-stale={batch.stale ? "true" : "false"} data-expired={batch.expired ? "true" : "false"}>
      <div className="flex flex-wrap items-center gap-2">
        <span className="min-w-0 break-words font-medium">{batch.title}</span>
        <span className={`rounded px-1.5 py-0.5 text-[10px] font-medium ${BATCH_TONE[batch.status] ?? ""}`} data-testid="task-queue-batch-status">{tr(`queue.batch.status.${batch.status}`)}</span>
      </div>
      {open && <p className="text-[11px] text-muted-foreground">{tr("queue.batch.owns")}</p>}
      <p className="break-words text-[11px] text-muted-foreground" data-testid="task-queue-batch-limits">
        {tr("queue.batch.limits")}: {batch.maxParallel} {tr("queue.batch.parallel")} · {batch.launchesUsed}/{batch.maxStarts} {tr("queue.batch.starts")} · {tr("queue.batch.spending")}: {batch.spending}
      </p>
      <p className="break-words text-[11px] text-muted-foreground" data-testid="task-queue-batch-order" data-guaranteed={batch.orderGuaranteed ? "true" : "false"}>{batch.orderNote}</p>
      {batch.status === "draft" && <p className="text-[11px] text-muted-foreground" data-testid="task-queue-batch-unapproved">{tr("queue.batch.unapproved")}</p>}
      {batch.expiresAt != null && open && <p className="text-[11px] text-muted-foreground" data-testid="task-queue-batch-expires">{tr("queue.batch.expires")}: {new Date(batch.expiresAt).toLocaleString()}</p>}
      {batch.expired && open && <p role="alert" className="text-[11px] text-warning" data-testid="task-queue-batch-expired">{tr("queue.batch.expired")}</p>}
      {batch.stale && open && <p role="alert" className="text-[11px] text-warning" data-testid="task-queue-batch-stale">{tr("queue.batch.stale")}</p>}
      {batch.fullAccessTaskIds.length > 0 && <p className="text-[11px] text-warning" data-testid="task-queue-batch-full-access">{tr("queue.batch.full_access")}: {batch.fullAccessTaskIds.length}</p>}
      {batch.reason && <p className="break-words text-[11px] text-muted-foreground" data-testid="task-queue-batch-reason">{batch.reason}</p>}
      <ul className="flex flex-wrap gap-1 text-[10px]" data-testid="task-queue-batch-tasks">
        {batch.taskIds.map((id) => <li key={id} className="rounded bg-muted px-1 py-0.5" data-task-id={id} data-state={batch.entryStates[id] ?? "pending"}>{batch.entryStates[id] ?? "pending"}</li>)}
      </ul>
      <div className="flex flex-wrap items-center gap-1">
        {onOpenBatch && open && <Button type="button" size="sm" variant="outline" onClick={() => onOpenBatch(batch.id)} data-testid="task-queue-batch-open">{tr("queue.batch.open")}</Button>}
        {batch.status === "running" && <Button type="button" size="sm" variant="ghost" disabled={busy} onClick={() => { void onBatchAction(batch.id, "pause"); }} data-testid="task-queue-batch-pause"><Pause className="size-3.5" aria-hidden />{tr("queue.batch.pause")}</Button>}
        {open && <Button type="button" size="sm" variant="ghost" disabled={busy} onClick={() => { void onBatchAction(batch.id, "cancel"); }} data-testid="task-queue-batch-cancel"><Square className="size-3.5" aria-hidden />{tr("queue.batch.cancel")}</Button>}
      </div>
    </div>
  );
}
