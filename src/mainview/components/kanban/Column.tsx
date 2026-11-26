import { staticLabel } from "@/i18n/presentation";
import { useLocale as useUILocale } from "@/i18n/react";
import { memo } from "react";
import { useDroppable } from "@dnd-kit/core";
import { SortableContext, verticalListSortingStrategy } from "@dnd-kit/sortable";
import { t as tr } from "@/i18n/core";
import { cn } from "@/lib/utils";
import { Badge } from "@/components/ui/badge";
import type { ColumnId, Task } from "../../../shared/types.ts";
import { TaskCard } from "./TaskCard";
import { groupByUrgency, sortBoardTasks, urgencyLabelKey } from "../../../shared/board-order.ts";

interface Props {
  id: ColumnId;
  label: string;
  tasks: Task[];
  homeDir: string;
  assignees?: ReadonlyMap<string, string>;
  onStart: (t: Task) => void;
  onAdmitInbox?: (t: Task) => void;
  onCancel: (t: Task) => void;
  onDelete: (t: Task) => void;
  onOpen: (t: Task) => void;
  /** Forwarded to each `TaskCard` as its amber "waiting on you" button's
   *  callback — see `TaskCard`'s own doc for why it's separate from
   *  `onOpen`. Must be `useCallback`-stable (compared below). */
  onOpenAttention: (t: Task) => void;
  onDiff: (t: Task) => void;
  onMarkDone: (t: Task) => void;
  onArchive: (t: Task) => void;
  onUnarchive: (t: Task) => void;
  /** Muted one-line hint shown in place of the (empty) task list, while
   *  onboarding's checklist is visible. Only rendered when `tasks.length ===
   *  0` — never overlays real cards. Non-interactive (`pointer-events-none`)
   *  and stays inside the existing droppable container so dnd-kit's drop
   *  zone is unaffected. */
  emptyHint?: string;
  /** Id of the task currently open in the run panel (App.tsx's `selected`),
   *  or null/undefined when no panel is open. Threaded down to each
   *  `TaskCard` as `isOpen` so the unread dot is suppressed for the task
   *  being actively watched. */
  selectedTaskId?: string | null;
  /** Right-click on a card within this column — forwarded verbatim to every
   *  `TaskCard`. See `TaskCard`'s doc comment for the payload shape. */
  onContextMenu?: (t: Task, pos: { x: number; y: number }) => void;
  /** Keyboard reorder from a card's handle; see `TaskCard`. Must be `useCallback`-stable. */
  onKeyboardReorder?: (t: Task, move: -1 | 1 | "start" | "end") => void;
}

/** Array is considered unchanged when same length and every element is the
 *  same object reference at the same index. Relies on the caller (App.tsx's
 *  `reconcileById`) preserving task identity across polls for tasks that
 *  didn't actually change — that's what lets an unaffected column bail out
 *  below even though `visibleTasks.filter(...)` in App.tsx produces a new
 *  array reference on every render. */
function sameTasks(a: Task[], b: Task[]): boolean {
  if (a === b) return true;
  if (a.length !== b.length) return false;
  return a.every((t, i) => t === b[i]);
}

function ColumnImpl({ id, label, tasks, homeDir, assignees, onStart, onAdmitInbox, onCancel, onDelete, onOpen, onOpenAttention, onDiff, onMarkDone, onArchive, onUnarchive, emptyHint, selectedTaskId, onContextMenu, onKeyboardReorder }: Props) {
  useUILocale();
  // The column is always shown in the one board order: urgency descending, then the saved order inside each urgency.
  const groups = groupByUrgency(sortBoardTasks(tasks));
  const { setNodeRef, isOver } = useDroppable({ id });
  return (
    <div
      ref={setNodeRef}
      className={cn(
        "glass-column flex w-64 shrink-0 flex-col gap-3 rounded-xl border p-3",
        isOver && "ring-2 ring-inset ring-primary/50",
      )}
    >
      <div className="flex items-center justify-between">
        <h2 className="text-sm font-semibold text-muted-foreground">
          {label}
        </h2>
        <Badge variant="outline">{tasks.length}</Badge>
      </div>
      <div className="flex flex-col gap-2" data-testid="column-tasks">
        {tasks.length === 0 && emptyHint && (
          <p className="pointer-events-none px-1 text-xs text-muted-foreground">{emptyHint ? staticLabel(emptyHint) : null}</p>
        )}
        {groups.map((group) => (
          <div key={group.urgency} className="flex flex-col gap-2" data-testid="urgency-group" data-urgency={group.urgency}>
            {groups.length > 1 && (
              <div role="separator" aria-label={tr("kanban.order.group", { n: group.urgency, label: tr(urgencyLabelKey(group.urgency)) })} className="flex items-center gap-2 px-0.5 pt-1 text-[10px] font-medium uppercase tracking-wide text-muted-foreground/80" data-testid="urgency-separator">
                <span className="shrink-0">{tr("kanban.order.group", { n: group.urgency, label: tr(urgencyLabelKey(group.urgency)) })}</span>
                <span className="h-px flex-1 bg-border/60" aria-hidden="true" />
              </div>
            )}
            <SortableContext items={group.tasks.map((t) => t.id)} strategy={verticalListSortingStrategy}>
              {group.tasks.map((t) => (
                <TaskCard
                  key={t.id}
                  task={t}
                  homeDir={homeDir}
                  assignee={assignees?.get(t.id)}
                  onStart={onStart}
                  onAdmitInbox={onAdmitInbox}
                  onCancel={onCancel}
                  onDelete={onDelete}
                  onOpen={onOpen}
                  onOpenAttention={onOpenAttention}
                  onDiff={onDiff}
                  onMarkDone={onMarkDone}
                  onArchive={onArchive}
                  onUnarchive={onUnarchive}
                  isOpen={t.id === selectedTaskId}
                  onContextMenu={onContextMenu}
                  onKeyboardReorder={onKeyboardReorder}
                />
              ))}
            </SortableContext>
          </div>
        ))}
      </div>
    </div>
  );
}

/** Custom comparator instead of the default shallow-props compare: `tasks`
 *  is an array, so the default `Object.is` per-prop check would see a new
 *  reference on every render (App.tsx's `visibleTasks.filter(...)` always
 *  allocates a fresh array) and re-render every column on every tick. With
 *  `sameTasks` doing an element-wise identity check instead, a column whose
 *  member tasks are all reference-unchanged bails out — so a single task
 *  update (which only changes that one task's object identity, per
 *  App.tsx's `reconcileById`) only re-renders the column(s) that actually
 *  contain the changed task.
 *
 *  `selectedTaskId` is compared explicitly (primitive, cheap). App passes
 *  the same value to every column, so opening/switching/closing the run
 *  panel re-renders every column — the inner `TaskCard` memo then keeps the
 *  actual DOM work to the card(s) whose `isOpen` flips. */
export const Column = memo(ColumnImpl, (prev, next) => {  return (
  prev.id === next.id &&
  prev.label === next.label &&
  prev.homeDir === next.homeDir &&
  prev.assignees === next.assignees &&
  prev.onStart === next.onStart &&
  prev.onAdmitInbox === next.onAdmitInbox &&
  prev.onCancel === next.onCancel &&
  prev.onDelete === next.onDelete &&
  prev.onOpen === next.onOpen &&
  prev.onOpenAttention === next.onOpenAttention &&
  prev.onDiff === next.onDiff &&
  prev.onMarkDone === next.onMarkDone &&
  prev.onArchive === next.onArchive &&
  prev.onUnarchive === next.onUnarchive &&
  prev.emptyHint === next.emptyHint &&
  prev.selectedTaskId === next.selectedTaskId &&
  prev.onContextMenu === next.onContextMenu &&
  prev.onKeyboardReorder === next.onKeyboardReorder &&
  sameTasks(prev.tasks, next.tasks)
); });
