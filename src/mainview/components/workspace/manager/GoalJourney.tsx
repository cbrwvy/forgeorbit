import { t as tr } from "@/i18n/core";
import { useLocale as useUILocale } from "@/i18n/react";
import { useMemo, useState } from "react";
import { Check, ExternalLink, Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { api } from "@/lib/api";
import { journeyOrder, type QcOutcome } from "@/lib/goal-journey";
import { isProjectTask } from "@/lib/workspace";
import { cn } from "@/lib/utils";
import type { Task } from "../../../../shared/types.ts";

const QC_TONE: Record<QcOutcome, string> = {
  "not-run": "bg-muted text-muted-foreground",
  running: "bg-info/10 text-info",
  passed: "bg-success/10 text-success",
  failed: "bg-danger/10 text-danger",
  blocked: "bg-warning/10 text-warning",
};

interface Props {
  tasks: readonly Task[];
  /** Whole-project list when set; ignored when `taskIds` is given. */
  projectPath?: string;
  /** Only these tasks (the compact view under an approval card). */
  taskIds?: readonly string[];
  onOpenTask: (task: Task) => void;
  /** Rows to show before pointing at the Tasks board. */
  limit?: number;
  compact?: boolean;
}

/**
 * Work and results (FO-UX-SIMPLIFY02-M6): per task, where it stands in plain words, what the
 * quality check actually said (passed / failed / blocked / not run), what is next, a link to the
 * task where the evidence lives, and "Accept result" only when the existing rule allows it
 * (QC passed and only the Owner is left). It reads the polled task rows; it starts nothing, and
 * "Accept result" is the same board move the task panel's Done button makes.
 */
export function GoalJourney({ tasks, projectPath, taskIds, onOpenTask, limit = 6, compact = false }: Props) {
  useUILocale();
  const [accepting, setAccepting] = useState<string | null>(null);
  const [accepted, setAccepted] = useState<ReadonlySet<string>>(new Set());
  const [errors, setErrors] = useState<Readonly<Record<string, string>>>({});

  const ordered = useMemo(() => {
    const scoped = taskIds
      ? tasks.filter((task) => taskIds.includes(task.id))
      : tasks.filter((task) => projectPath != null && isProjectTask(task, projectPath));
    return journeyOrder(scoped.filter((task) => task.archivedAt == null && task.pipelineParentId == null));
  }, [tasks, projectPath, taskIds]);

  const accept = async (task: Task) => {
    if (accepting) return;
    setAccepting(task.id);
    setErrors((current) => ({ ...current, [task.id]: "" }));
    try {
      await api.moveTask(task.id, "done");
      setAccepted((current) => new Set(current).add(task.id));
    } catch (caught) {
      const message = caught instanceof Error ? caught.message : String(caught);
      setErrors((current) => ({ ...current, [task.id]: tr("m6.work.accept_failed", { message }) }));
    } finally {
      setAccepting(null);
    }
  };

  const shown = ordered.slice(0, limit);
  return (
    <section className={cn("space-y-2", !compact && "surface-solid rounded-xl border px-4 py-3")} data-testid="goal-journey" aria-label={tr("m6.work.title")}>
      {!compact && (
        <div className="min-w-0">
          <h3 className="text-sm font-medium">{tr("m6.work.title")}</h3>
          <p className="text-xs text-muted-foreground">{tr("m6.work.intro")}</p>
        </div>
      )}
      {shown.length === 0 ? (
        <p className="text-xs text-muted-foreground" data-testid="goal-journey-empty">{tr("m6.work.empty")}</p>
      ) : (
        <ul className="space-y-2">
          {shown.map(({ task, row }) => {
            const done = accepted.has(task.id) && row.phase !== "done" ? { ...row, phase: "done" as const, canAccept: false, needsYou: false } : row;
            const error = errors[task.id];
            return (
              <li
                key={task.id}
                className={cn("min-w-0 space-y-1 rounded-md border px-2.5 py-2 text-xs", done.needsYou ? "border-warning/60 bg-warning/5" : "border-border/70")}
                data-testid="goal-journey-row"
                data-task-id={task.id}
                data-phase={done.phase}
                data-qc={row.qc}
                data-needs-you={done.needsYou ? "true" : "false"}
              >
                <div className="flex flex-wrap items-center gap-2">
                  <span className="min-w-0 break-words text-sm font-medium" data-testid="goal-journey-title">{task.title}</span>
                  <span className="rounded bg-muted px-1.5 py-0.5 text-[11px] font-medium" data-testid="goal-journey-stage">{tr(`m6.stage.${done.phase}` as "m6.stage.done")}</span>
                </div>
                <p className="flex flex-wrap items-center gap-1.5 text-[11px] text-muted-foreground">
                  <span>{tr("m6.work.qc")}:</span>
                  <span className={cn("rounded px-1.5 py-0.5 font-medium", QC_TONE[row.qc])} data-testid="goal-journey-qc">{tr(`m6.qc.${row.qc}` as "m6.qc.passed")}</span>
                </p>
                <p className="text-[11px] text-muted-foreground" data-testid="goal-journey-next">
                  <span className="font-medium text-foreground">{tr("m6.work.next")}:</span> {tr(`m6.next.${done.phase}` as "m6.next.done")}
                </p>
                {done.canAccept && <p className="text-[11px] text-muted-foreground" data-testid="goal-journey-accept-note">{tr("m6.work.accept_note")}</p>}
                <div className="flex flex-wrap items-center gap-2 pt-0.5">
                  <Button type="button" size="sm" variant="outline" onClick={() => onOpenTask(task)} data-testid="goal-journey-open">
                    <ExternalLink className="size-3.5" aria-hidden />{tr("m6.work.open")}
                  </Button>
                  {done.canAccept && (
                    <Button type="button" size="sm" disabled={accepting != null} onClick={() => void accept(task)} data-testid="goal-journey-accept">
                      {accepting === task.id ? <Loader2 className="size-3.5 motion-safe:animate-spin" aria-hidden /> : <Check className="size-3.5" aria-hidden />}
                      {accepting === task.id ? tr("m6.work.accepting") : tr("m6.work.accept")}
                    </Button>
                  )}
                </div>
                {error && <p role="alert" className="break-words text-[11px] text-danger" data-testid="goal-journey-error">{error}</p>}
              </li>
            );
          })}
        </ul>
      )}
      {ordered.length > limit && <p className="text-[11px] text-muted-foreground" data-testid="goal-journey-more">{tr("m6.work.more", { count: String(ordered.length - limit) })}</p>}
    </section>
  );
}
