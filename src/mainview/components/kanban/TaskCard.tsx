import { managerStageTone, managerTaskView } from "@/lib/manager-task";
import { staticLabel } from "@/i18n/presentation";
import { englishPluralSuffix, t as tr } from "@/i18n/core";

import { I18nText, useLocale as useUILocale } from "@/i18n/react";
import { UsageTaskDialog } from "@/components/usage/UsageTaskDialog";
import { memo, useState } from "react";
import { useSortable } from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { Archive, ArchiveRestore, Bot, FolderOpen, GitBranch, GitCompare, GripVertical, ListTodo, Paperclip, PauseCircle, Square, Terminal, Trash2 } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { abbreviateHome, cn } from "@/lib/utils";
import { AWAITING_RING_CLASS } from "@/lib/awaiting";
import { AwaitingGlow } from "@/components/ui/awaiting-glow";
import { taskTypeIcon } from "@/lib/task-type-icon";
import { driftOf, driftTitle } from "@/lib/branch-drift";
import { useCountdown, fxPausedBadgeText, fxPausedBadgeTitle } from "@/lib/fx-auto-resume";
import { taskTypeMeta, type Task } from "../../../shared/types.ts";
import { sentFileBasename } from "../../../shared/sent-files.ts";
import { isTaskFxPaused } from "../../../shared/fx-recovery.ts";
import { AgentIcon } from "./AgentIcon";
import { PipelineBadge } from "@/components/pipelines";
import { HandsoffChip, HandsoffSubmitButton } from "@/components/handsoff/HandsoffCardControls";
import { UrgencyBadge } from "./UrgencyBadge";
import { ScheduledAvailabilityBadge } from "./ScheduledAvailability";
import { RecurringCardBadge } from "../recurring/RecurringCardBadge";
import { normalizeUrgency } from "../../../shared/board-order.ts";
import { runForTask, useHandsoffOverview } from "@/lib/handsoff-events";

interface Props {
  task: Task;
  homeDir: string;
  assignee?: string;
  onStart: (t: Task) => void;
  onAdmitInbox?: (t: Task) => void;
  onCancel: (t: Task) => void;
  onDelete: (t: Task) => void;
  onOpen: (t: Task) => void;
  /** The amber "waiting on you" button (Answer / Answer (N) / Review). Kept
   *  separate from `onOpen` because the two land differently for a
   *  pipeline parent: the card body and the plain Open button browse the
   *  run view, while this one also opens the step that needs the user
   *  (App.tsx's `openAttention`). For any other task App routes both to the
   *  same `openTask`. */
  onOpenAttention: (t: Task) => void;
  onDiff: (t: Task) => void;
  onMarkDone: (t: Task) => void;
  onArchive: (t: Task) => void;
  onUnarchive: (t: Task) => void;
  /** True when this task is the one currently open in the run panel — App.tsx
   *  passes `task.id === selected?.id`. Suppresses the unread dot while the
   *  user is actively watching the task (messages streamed while open are
   *  marked seen on close, not shown as unread in the meantime). */
  isOpen?: boolean;
  /** Right-click (or keyboard menu-key) on the card. `pos` is where App.tsx's
   *  task context menu should anchor — omitted entirely when the caller
   *  doesn't wire it up (no menu to open). */
  onContextMenu?: (t: Task, pos: { x: number; y: number }) => void;
  /** Keyboard reorder from the card's drag handle (ArrowUp/ArrowDown one place, Home/End to the ends of the urgency
   *  group). Never changes urgency or status. Must be `useCallback`-stable (compared by `Column`). */
  onKeyboardReorder?: (t: Task, move: -1 | 1 | "start" | "end") => void;
}

function TaskCardImpl({ task, homeDir, assignee, onStart, onAdmitInbox, onCancel, onDelete, onOpen, onOpenAttention, onDiff, onMarkDone, onArchive, onUnarchive, isOpen, onContextMenu, onKeyboardReorder }: Props) {
  useUILocale();
  const [estimateOpen, setEstimateOpen] = useState(false);
  const archived = task.archivedAt != null;
  const manager = managerTaskView(task);
  // Last-seen worktree checkout (server-recorded; no git spawn on the 2 s
  // poll) vs the branch agetor created. Drift is tolerated — just shown.
  const branchDrift = driftOf(task.branch ?? null, task.checkoutBranch);
  // `fx-paused-badge`'s live countdown (see the badge below) — called
  // unconditionally, before any conditional return, so hook order stays
  // stable whether or not this task is actually paused right now; ticks
  // only while `task.fxRecovery.autoResume.at` is actually set (see
  // `useCountdown`'s own doc comment). `task.fxRecovery` is server-managed
  // — this card never inspects `task.agent` to decide whether to show it.
  const fxAutoResumeAt = task.fxRecovery?.autoResume?.at ?? null;
  const fxAutoResumeCountdown = useCountdown(fxAutoResumeAt);
  const urgency = normalizeUrgency(task.urgency);
  // The card sorts inside its own (column, urgency) group; the board's collision detection keeps the drag inside that
  // group (or hands it to another column). Only the handle starts a drag, so clicking text or buttons never does.
  const { attributes, listeners, setNodeRef, setActivatorNodeRef, transform, transition, isDragging } = useSortable({
    id: task.id,
    data: { column: task.column, urgency },
    // Archived cards are immutable until unarchived — block drag-to-column so
    // the user has to take the explicit unarchive action first.
    disabled: archived,
  });

  const style = {
    transform: transform ? CSS.Translate.toString(transform) : undefined,
    transition: isDragging ? undefined : transition,
    zIndex: isDragging ? 30 : undefined,
  };

  const active = task.column === "running" || task.column === "blocked";
  const stoppable = task.pipelineId ? task.pipelineRun?.status === "running" : active;
  const awaiting = manager.needsDecision;
  const blockedForReply = manager.stage === "blocked" && task.pendingInteractionCount > 0;
  const handsoffRun = runForTask(useHandsoffOverview(), task.id);
  const isWaitingForScheduledTime =
    !archived &&
    (handsoffRun?.status === "waiting" && handsoffRun.state.waitKind === "scheduled"
      ? true
      : task.column === "ready" && handsoffRun?.status !== "needs-owner");

  const type = taskTypeMeta(task.taskType);
  const TypeIcon = taskTypeIcon(type.icon);
  const runningSubagents = task.runningSubagents ?? 0;

  return (
    <Card
      ref={setNodeRef}
      data-testid="task-card"
      data-task-id={task.id}
      data-urgency={urgency}
      data-column={task.column}
      style={style}
      className={cn(
        "group/card relative select-none border-border/70 border-l-[3px] shadow-sm hover:border-border hover:shadow-md transition-[border-color,box-shadow] duration-fast",
        type.borderClass,
        isDragging && "opacity-70 shadow-lg ring-1 ring-primary/40",
        awaiting && AWAITING_RING_CLASS,
        archived && "cursor-default opacity-60",
      )}
      // `onClick` (open) stays untouched by the addition below — a
      // right-click never opens the panel, only `onContextMenu` fires for it.
      onClick={() => onOpen(task)}
      // dnd-kit's `useDraggable` above is unaffected by right-click: its
      // `PointerSensor` bails on `event.button !== 0`, so a right-click can
      // never arm a drag — `{...listeners}` and this handler don't fight.
      onContextMenu={(e) => {
        e.preventDefault();
        if (!onContextMenu) return;
        // Keyboard-invoked context menus (Shift+F10 / the menu key) report
        // clientX/Y = 0,0 — anchor those to the card instead of the
        // viewport corner.
        const fromKeyboard = e.clientX === 0 && e.clientY === 0;
        const r = e.currentTarget.getBoundingClientRect();
        onContextMenu(task, fromKeyboard ? { x: r.left, y: r.top } : { x: e.clientX, y: e.clientY });
      }}
      // The card is focusable (dnd-kit's `attributes` below add
      // `tabIndex=0`), so a right-click would otherwise focus it and WebKit
      // scrolls a partially-visible card into view inside `.kanban-scroll`;
      // the board would visibly jump (and focus would land on the card)
      // under the freshly-opened menu. Only suppress the default for the
      // right button — left-click focus/drag
      // behavior (dnd-kit's `PointerSensor`, wired via `{...listeners}`
      // below as `onPointerDown`, so there's no prop collision here) is
      // untouched, and `contextmenu` still fires after a default-prevented
      // `mousedown`.
      onMouseDown={(e) => {
        if (e.button === 2) e.preventDefault();
      }}
      // A button containing Run/Stop/etc. is ambiguous to WebKit AXPress:
      // it can activate a descendant action instead of opening the task.
      // Keep drag/pointer behavior on the card and expose a separate button.
      role="group"
      tabIndex={-1}
      aria-label={task.title}
      // Only pointer dragging is enabled on this board. Do not announce
      // dnd-kit's keyboard pickup instructions for the Open shortcut.
      aria-describedby={undefined}
      aria-roledescription={undefined}
      aria-disabled={undefined}
    >
      {task.unread && !isOpen && (
        // Static dot for "has assistant messages you haven't read yet" —
        // deliberately unanimated (the amber awaiting-pulse ring is the only
        // animated attention state). Pinned to the corner so it coexists
        // with that ring (an outline) without visual conflict, and sits
        // above the header's row-1 harness badge in the DOM/paint order.
        <span
          // -1.5 offsets keep the dot's background halo clear of the
          // awaiting state's ring-offset outline instead of notching it.
          className="absolute -top-1.5 -right-1.5 size-2.5 rounded-full bg-info ring-2 ring-background"
          title={tr("tasks.new_messages")}
          role="img"
          aria-label={tr("tasks.new_messages")}
        />
      )}
      <CardHeader className="pb-1.5 space-y-1.5">
        <CardTitle className="flex items-start gap-1.5 text-sm break-words">
          {!archived && (
            <button
              type="button"
              ref={setActivatorNodeRef}
              data-testid="task-card-handle"
              aria-label={tr("kanban.order.handle")}
              aria-keyshortcuts="ArrowUp ArrowDown Home End"
              title={tr("kanban.order.handle_hint")}
              className="-ml-1 mt-px flex h-5 w-4 shrink-0 cursor-grab touch-none items-center justify-center rounded-sm text-muted-foreground/60 hover:text-foreground focus-visible:text-foreground focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-ring active:cursor-grabbing"
              onClick={(event) => event.stopPropagation()}
              {...attributes}
              {...listeners}
              // dnd-kit's own keyboard sensor is not used: arrow keys on the focused handle reorder inside the group.
              aria-roledescription={undefined}
              aria-describedby={`task-title-${task.id}`}
              role="button"
              tabIndex={0}
              onKeyDown={(event) => {
                if (event.altKey || event.ctrlKey || event.metaKey || event.shiftKey || !onKeyboardReorder) return;
                const move = event.key === "ArrowUp" ? -1 : event.key === "ArrowDown" ? 1 : event.key === "Home" ? "start" : event.key === "End" ? "end" : null;
                if (move === null) return;
                event.preventDefault();
                event.stopPropagation();
                onKeyboardReorder(task, move);
              }}
            >
              <GripVertical className="size-3.5" aria-hidden="true" />
            </button>
          )}
          <TypeIcon
            className={cn("mt-0.5 size-3.5 shrink-0", type.iconClass)}
            aria-label={staticLabel(type.label)}
          />
          <button type="button" id={`task-title-${task.id}`} aria-label={task.title} title={task.title} onClick={(event) => event.currentTarget.focus({ preventScroll: true })} className="min-w-0 flex-1 rounded-sm text-left [overflow-wrap:anywhere] focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring">
            {task.title}
          </button>
        </CardTitle>
        {/* Status as words, not just a colour: the column name, or "Waiting for you". */}
        <div className="flex min-w-0 flex-wrap items-center gap-1.5" data-testid="task-card-status-row">
          <Badge variant={managerStageTone[manager.stage]}
            data-testid="task-card-status"
            data-column={task.column}
          >
            {tr(blockedForReply ? "manager.stage.reply" : `manager.stage.${manager.stage}`)}
          </Badge>
          <UrgencyBadge urgency={urgency} />
          <HandsoffChip task={task} />

        </div>
        <RecurringCardBadge recurring={task.recurring} />
        <ScheduledAvailabilityBadge
          availableFromUtc={task.availableFromUtc}
          isWaitingForTime={isWaitingForScheduledTime}
        />
        {assignee && <p className="break-words text-xs text-muted-foreground [overflow-wrap:anywhere]" data-testid="task-card-assignee">{assignee}</p>}
      </CardHeader>
      <CardContent className="space-y-2">
        <div className="flex flex-wrap gap-1" onClick={(e) => e.stopPropagation()}>
          <Button size="sm" variant={manager.needsDecision ? "default" : "secondary"} data-testid="task-card-primary" onClick={(event) => {
            event.currentTarget.focus({ preventScroll: true });
            if (manager.action === "answer") onOpenAttention(task); else onOpen(task);
          }}>
            {tr(blockedForReply ? "manager.action.reply" : manager.needsDecision ? "manager.card.review" : "common.open")}
          </Button>
          {!archived && <HandsoffSubmitButton task={task} />}
          {!archived && stoppable && <Button size="sm" variant="destructive" onClick={() => onCancel(task)} aria-label={`${tr("common.stop")}: ${task.title}`}><Square className="size-3" />{tr("common.stop")}</Button>}
        </div>
        <details onClick={(e) => e.stopPropagation()}>
          <summary className="cursor-pointer text-xs text-muted-foreground">{tr("manager.details")}</summary>
          <div className="mt-2 space-y-2">
            <div className="flex flex-wrap gap-1">
              {!archived && task.column === "backlog" && !task.pipelineId && !task.pipelineParentId && <Button size="sm" variant="outline" onClick={() => setEstimateOpen(true)} data-testid="task-estimate">{tr("usage.estimate")}</Button>}
              {estimateOpen && <UsageTaskDialog taskId={task.id} backlog={task.column === "backlog"} onClose={() => setEstimateOpen(false)} />}
              {!archived && (task.column === "done" || active) && <Button size="icon" variant="ghost" onClick={() => onArchive(task)} title={tr("common.archive_task")}><Archive className="size-3" /></Button>}
              {archived && <Button size="icon" variant="ghost" onClick={() => onUnarchive(task)} title={tr("tasks.unarchive_task")}><ArchiveRestore className="size-3" /></Button>}
              <Button size="icon" variant="ghost" onClick={() => onDiff(task)} title={tr("tasks.view_changes_git_diff")}><GitCompare className="size-3" /></Button>
              <Button size="icon" variant="ghost" onClick={() => onDelete(task)} title={tr("tasks.delete_task")}><Trash2 className="size-3" /></Button>
            </div>
            {runningSubagents > 0 && (
              <Badge
                variant="outline"
                className="gap-1 text-[10px] shrink-0"
                title={tr("common.background_task_running", { p0: String(runningSubagents), p1: String(runningSubagents > 1 ? englishPluralSuffix() : "") })}
              >
                <Bot className="size-3" />
                {runningSubagents}
              </Badge>
            )}
            {task.openTerminalCount > 0 && (
              <Badge
                variant="outline"
                className="gap-1 text-[10px] shrink-0"
                title={tr("common.open_terminal", { p0: String(task.openTerminalCount), p1: String(task.openTerminalCount > 1 ? englishPluralSuffix() : "") })}
              >
                <Terminal className="size-3" />
                {task.openTerminalCount}
              </Badge>
            )}
            {task.todoProgress && task.todoProgress.total > 0 && (
              <Badge
                variant="outline"
                className={cn(
                  "gap-1 text-[10px] shrink-0",
                  task.todoProgress.completed === task.todoProgress.total
                    ? "text-success"
                    : "text-muted-foreground",
                )}
                title={tr("common.of_tasks_done", { p0: String(task.todoProgress.completed), p1: String(task.todoProgress.total) })}
              >
                <ListTodo className="size-3" />
                {task.todoProgress.completed}/{task.todoProgress.total}
              </Badge>
            )}
            {task.sentFiles && task.sentFiles.length > 0 && (
              <Badge
                variant="outline"
                className="gap-1 text-[10px] shrink-0"
                data-testid="sent-files-badge"
                title={tr("common.file_sent", { p0: String(task.sentFiles.length), p1: String(task.sentFiles.length === 1 ? "" : englishPluralSuffix()), p2: String([...task.sentFiles]
                  .sort((a, b) => b.sentAt - a.sentAt)
                  .slice(0, 5)
                  .map((f) => sentFileBasename(f.path))
                  .join(", ")) })}
              >
                <Paperclip className="size-3" />
                {task.sentFiles.length}
              </Badge>
            )}
            {/* fx's response is paused on a resumable Gateway checkpoint
             *  (`Task.fxRecovery`, server-managed — see `TaskFxRecovery` in
             *  shared/types.ts). Gated on the shared `isTaskFxPaused` helper,
             *  never on `task.agent`, so it stays correct if fx is ever
             *  aliased under a different harness id. Text/title come from
             *  `fxPausedBadgeText`/`fxPausedBadgeTitle` (`@/lib/fx-auto-resume`)
             *  — "paused" or a live "auto-resume m:ss" countdown, with a
             *  tooltip explaining why (or why not) an auto-resume is pending. */}
            {isTaskFxPaused(task) && task.fxRecovery && (
              <Badge
                variant="outline"
                className="gap-1 text-[10px] shrink-0 text-warning border-warning/40"
                data-testid="fx-paused-badge"
                title={fxPausedBadgeTitle(task.fxRecovery)}
              >
                <PauseCircle className="size-3" />
                {fxPausedBadgeText(task.fxRecovery, fxAutoResumeCountdown)}
              </Badge>
            )}
        {/* Secondary detail: harness/agent, model, folder and branch. The full path,
         *  branch and model stay in the tooltips and in the task details. */}
        <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1 text-[10px] text-muted-foreground" data-testid="task-card-meta">
          {task.pipelineRun ? (
            <PipelineBadge run={task.pipelineRun} className="shrink-0" />
          ) : task.agentProfile ? (
            <Badge
              variant="secondary"
              className="gap-1 shrink-0"
              data-testid="task-card-agent-profile"
              title={task.agent}
            >
              <AgentIcon kind={task.agentProfile.harnessKind} className="size-3" />
              {task.agentProfile.name}
            </Badge>
          ) : (
            <Badge variant="secondary" className="gap-1 shrink-0" data-testid="task-card-harness">
              <AgentIcon kind={task.agent} className="size-3" />
              {task.agent}
            </Badge>
          )}
          {(task.model || task.mode) && (
            <span className="font-mono" title={[task.model, task.mode].filter(Boolean).join(" · ")}>
              {[task.model, task.mode].filter(Boolean).join(" · ")}
            </span>
          )}
          <span className="min-w-0 truncate font-mono" title={tr("m5.card.folder", { path: task.workdir })} data-testid="task-card-folder">
            <FolderOpen className="mr-1 inline size-3 align-[-2px]" aria-hidden />
            {abbreviateHome(task.workdir, homeDir).split("/").filter(Boolean).pop() ?? task.workdir}
          </span>
          {(task.branch || task.baseRef) && !branchDrift.drifted && (
            <span className="inline-flex min-w-0 items-center gap-1 font-mono" title={tr("m5.card.branch", { branch: String(task.checkoutBranch ?? task.branch ?? tr("common.not_yet_created")) })} data-testid="task-card-branch">
              <GitBranch className="size-3 shrink-0" aria-hidden />
              <span className="truncate">{task.checkoutBranch ?? task.branch ?? tr("common.not_yet_created")}</span>
            </span>
          )}
          {branchDrift.drifted && (
            <span
              data-testid="task-card-branch-drift"
              title={driftTitle(task.branch)}
              className={cn(
                "shrink-0 rounded px-1 font-sans font-medium",
                task.branchSource === "existing" ? "bg-warning/15 text-warning" : "bg-info/15 text-info",
              )}
            >
              {task.branchSource === "existing" ? tr("common.not_on_pr_head") : tr("common.drifted")}
            </span>
          )}
        </div>
          </div>
        </details>
      </CardContent>
      {/* The "waiting on you" glow — an opacity-pulsed overlay (see
          `AwaitingGlow` for why it isn't a filter/box-shadow animation). */}
      {awaiting && <AwaitingGlow />}
    </Card>
  );
}

// Default shallow-props comparator is correct here (unlike Column, which
// needs a custom comparator for its array prop): `task` is a single object
// whose identity App.tsx's `reconcileById` preserves across polls when
// unchanged, and every other prop is either a primitive (`homeDir`) or a
// `useCallback`-stabilized handler. dnd-kit's `useDraggable` lives inside
// the component body, so memoizing the outer function doesn't interfere
// with drag state — that's driven by dnd-kit's own context, not props.
export const TaskCard = memo(TaskCardImpl);
