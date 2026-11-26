import { t as tr } from "@/i18n/core";
import { useLocale as useUILocale } from "@/i18n/react";
import { useMemo } from "react";
import { MessageSquare } from "lucide-react";
import { Button } from "@/components/ui/button";
import { EmptyState } from "@/components/ui/state";
import { GoalJourney } from "./GoalJourney";
import { TaskPlanView } from "./TaskPlanView";
import type { TaskProposal } from "../../../../shared/project-manager.ts";
import type { Task } from "../../../../shared/types.ts";

interface Props {
  projectPath: string;
  proposals: readonly TaskProposal[];
  tasks: Task[];
  onOpenTask: (task: Task) => void;
  onExecute: (taskId: string) => void;
  onOpenBatch: (batchId: string) => void;
  onOpenChat: () => void;
}

/**
 * Manager → "Plan & queue" (FO-UX02-D stage 2, variant A). The plans and queues
 * that used to be reachable only from inside a proposal card in the chat, listed
 * per project in one place. It is the same `TaskPlanView` (same data, same
 * flows): read-only, every action leads into an existing review or batch flow,
 * and nothing here starts or assigns anything.
 */
export function ManagerPlanSection({ projectPath, proposals, tasks, onOpenTask, onExecute, onOpenBatch, onOpenChat }: Props) {
  useUILocale();
  const withPlan = useMemo(
    () => proposals.filter((item) => item.status !== "rejected" && item.items.length > 1).sort((a, b) => b.updatedAt - a.updatedAt),
    [proposals],
  );
  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col gap-3 overflow-y-auto" data-testid="manager-plan-section">
      <GoalJourney tasks={tasks} projectPath={projectPath} onOpenTask={onOpenTask} />
      <p className="text-xs text-muted-foreground">{tr("uxfix.plan.intro")}</p>
      {withPlan.length === 0 ? (
        <EmptyState
          className="surface-solid rounded-xl border"
          testId="manager-plan-empty"
          title={tr("uxfix.tab.plan")}
          description={tr("uxfix.plan.empty")}
          action={<Button type="button" size="sm" variant="outline" onClick={onOpenChat} data-testid="manager-plan-open-chat"><MessageSquare className="size-3.5" aria-hidden />{tr("uxfix.plan.goChat")}</Button>}
        />
      ) : (
        <ul className="space-y-3">
          {withPlan.map((proposal) => {
            const ids = new Set(proposal.items.flatMap((item) => (item.result?.taskId ? [item.result.taskId] : [])));
            const moved = tasks.filter((task) => ids.has(task.id)).map((task) => `${task.id}:${task.column}:${task.updatedAt}`).join("|");
            return (
              <li key={proposal.id} className="surface-solid space-y-2 rounded-xl border px-4 py-3" data-testid="manager-plan-entry" data-proposal-id={proposal.id} data-status={proposal.status}>
                <div className="min-w-0">
                  <h3 className="truncate text-sm font-medium" title={proposal.title}>{proposal.title}</h3>
                  <p className="text-[11px] text-muted-foreground">{tr("uxfix.plan.proposal")} · {proposal.status} · {proposal.items.length}</p>
                </div>
                <TaskPlanView
                  projectPath={projectPath}
                  proposalId={proposal.id}
                  refreshToken={`${proposal.revision}:${proposal.status}:${moved}`}
                  tasks={tasks}
                  onOpenTask={onOpenTask}
                  onExecute={onExecute}
                  onOpenBatch={onOpenBatch}
                  defaultOpen
                />
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
