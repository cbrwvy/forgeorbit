import { ListOrdered, PauseCircle, ShieldAlert } from "lucide-react";
import { t as tr } from "@/i18n/core";
import { useLocale as useUILocale } from "@/i18n/react";
import { Badge } from "@/components/ui/badge";
import { useHandsoffOverview } from "@/lib/handsoff-events";
import { smartQueueForProject, type SmartQueueProjectSummary } from "../../../shared/smart-queue.ts";
import { cn } from "@/lib/utils";

interface ProjectQueueSummaryProps {
  projectPath: string;
  /** Optional click handler to open the next eligible task directly. */
  onOpenTaskId?: (taskId: string) => void;
  /** Compact banner for above the Kanban board vs slightly roomier card for Overview/Settings. */
  variant?: "board" | "card";
  className?: string;
}

/**
 * Compact project execution queue summary driven exclusively by the backend's
 * canonical `evaluateProjectQueue` state (never a simulated frontend calculation).
 */
export function ProjectQueueSummary({
  projectPath,
  onOpenTaskId,
  variant = "board",
  className,
}: ProjectQueueSummaryProps) {
  useUILocale();
  const overview = useHandsoffOverview();
  const queue: SmartQueueProjectSummary | null = smartQueueForProject(overview?.queues, projectPath);

  if (!queue) return null;
  const hasItems = queue.items.length > 0;
  // On the Kanban board strip, stay quiet when hands-off is off and nothing is queued/running.
  if (variant === "board" && !queue.enabled && !hasItems) return null;
  if (variant === "board" && !hasItems && queue.lifecycleState === "running" && !queue.emergencyStop) {
    return null;
  }

  const blockedCount = queue.counts.blocked + queue.counts.waitingDependency + queue.counts.waitingResource;
  const authBlocked =
    queue.enabled &&
    queue.authorizationState !== "active" &&
    queue.authorizationState !== "not-required";
  const paused = queue.lifecycleState === "paused" || queue.lifecycleState === "draining";

  return (
    <section
      aria-label={tr("kanban.queue.title")}
      data-testid={variant === "board" ? "board-queue-summary" : "project-queue-summary"}
      data-project-path={projectPath}
      className={cn(
        variant === "board"
          ? "flex flex-wrap items-center gap-x-3 gap-y-1 border-b border-border/60 bg-muted/25 px-4 py-2 text-xs"
          : "surface-solid flex flex-col gap-2 rounded-xl border px-4 py-3 text-xs",
        className,
      )}
    >
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
        <span className="inline-flex items-center gap-1.5 font-medium text-foreground">
          <ListOrdered className="size-3.5 shrink-0 text-primary" aria-hidden="true" />
          {tr("kanban.queue.title")}
        </span>

        <div className="flex flex-wrap items-center gap-x-2.5 gap-y-1 text-muted-foreground">
          <span data-testid="queue-count-running" className={queue.counts.running > 0 ? "font-medium text-foreground" : undefined}>
            {tr("kanban.queue.running", { count: queue.counts.running })}
          </span>
          <span data-testid="queue-count-eligible" className={queue.counts.eligible > 0 ? "font-medium text-foreground" : undefined}>
            {tr("kanban.queue.eligible", { count: queue.counts.eligible })}
          </span>
          {queue.counts.waitingScheduled > 0 && (
            <span data-testid="queue-count-scheduled">
              {tr("kanban.queue.waiting_time", { count: queue.counts.waitingScheduled })}
            </span>
          )}
          {blockedCount > 0 && (
            <span data-testid="queue-count-blocked">
              {tr("kanban.queue.blocked", { count: blockedCount })}
            </span>
          )}
        </div>

        {queue.emergencyStop && (
          <Badge variant="destructive" data-testid="queue-status-estop">
            <ShieldAlert className="mr-1 size-3" aria-hidden="true" />
            {tr("kanban.queue.status.emergency_stop")}
          </Badge>
        )}
        {!queue.emergencyStop && paused && (
          <Badge variant="secondary" data-testid="queue-status-paused">
            <PauseCircle className="mr-1 size-3" aria-hidden="true" />
            {tr("kanban.queue.status.project_paused")}
          </Badge>
        )}
        {!queue.emergencyStop && !paused && authBlocked && (
          <Badge variant="warning" data-testid="queue-status-auth">
            {tr("kanban.queue.status.authorization")}
          </Badge>
        )}
      </div>

      {queue.expectedNext ? (
        <div className="flex min-w-0 items-center gap-1 text-muted-foreground" data-testid="queue-next-task" data-task-id={queue.expectedNext.taskId}>
          {onOpenTaskId ? (
            <button
              type="button"
              onClick={() => onOpenTaskId(queue.expectedNext!.taskId)}
              className="truncate text-left font-medium text-foreground underline-offset-2 hover:underline"
            >
              {tr(queue.expectedNext.uncertain ? "kanban.queue.expected_next" : "kanban.queue.next_eligible", {
                title: queue.expectedNext.title,
              })}
            </button>
          ) : (
            <span className="truncate font-medium text-foreground">
              {tr(queue.expectedNext.uncertain ? "kanban.queue.expected_next" : "kanban.queue.next_eligible", {
                title: queue.expectedNext.title,
              })}
            </span>
          )}
        </div>
      ) : (
        variant === "card" && (
          <p className="text-muted-foreground" data-testid="queue-next-empty">
            {tr("kanban.queue.none_eligible")}
          </p>
        )
      )}

      {variant === "card" && queue.totalDevelopers > 0 && (
        <p className="text-[11px] text-muted-foreground" data-testid="queue-workers-info">
          {tr("kanban.queue.workers_info", {
            idle: queue.idleDevelopers,
            total: queue.totalDevelopers,
            parallel: queue.maxParallel,
          })}
        </p>
      )}
    </section>
  );
}
