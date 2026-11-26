import { t as tr } from "@/i18n/core";
import { useLocale as useUILocale } from "@/i18n/react";
import { MessageSquare } from "lucide-react";
import { Button } from "@/components/ui/button";
import { EmptyState } from "@/components/ui/state";
import { pendingProjectInboxProposals } from "../../../../shared/pm-intake.ts";
import type { TaskProposal } from "../../../../shared/project-manager.ts";
import type { Task } from "../../../../shared/types.ts";
import { isProjectTask } from "@/lib/workspace";
import { ProposalCard } from "./ProposalCard";

interface Props {
  projectPath: string;
  proposals: readonly TaskProposal[];
  tasks: Task[];
  onProposalChanged: (proposal: TaskProposal) => void;
  onOpenTask: (task: Task) => void;
  onExecute: (taskId: string) => void;
  onPrepareBatch: (proposalId: string) => Promise<void>;
  onOpenBatch: (batchId: string) => void;
  onOpenPlanSection: () => void;
  onOpenChat: () => void;
}

/**
 * Manager → Project inbox: admitted kanban tasks (inbox column) plus a
 * separate Pending proposals block. Distinct from Needs you.
 */
export function ManagerInboxSection({
  projectPath,
  proposals,
  tasks,
  onProposalChanged,
  onOpenTask,
  onExecute,
  onPrepareBatch,
  onOpenBatch,
  onOpenPlanSection,
  onOpenChat,
}: Props) {
  useUILocale();
  const pending = pendingProjectInboxProposals(proposals);
  const inboxTasks = tasks
    .filter((t) => t.column === "inbox" && t.archivedAt == null && isProjectTask(t, projectPath) && !t.pipelineParentId)
    .sort((a, b) => b.updatedAt - a.updatedAt);

  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col gap-4 overflow-y-auto" data-testid="manager-inbox-section">
      <p className="text-xs text-muted-foreground">{tr("uxfix.inbox.intro")}</p>

      <section className="space-y-2" aria-labelledby="manager-inbox-tasks-heading">
        <h3 id="manager-inbox-tasks-heading" className="text-sm font-medium">
          {tr("uxfix.inbox.tasksHeading")}
        </h3>
        {inboxTasks.length === 0 ? (
          <p className="text-xs text-muted-foreground" data-testid="manager-inbox-tasks-empty">
            {tr("uxfix.inbox.tasksEmpty")}
          </p>
        ) : (
          <ul className="space-y-2" data-testid="manager-inbox-tasks">
            {inboxTasks.map((task) => (
              <li key={task.id}>
                <button
                  type="button"
                  className="w-full rounded-lg border bg-card px-3 py-2 text-left text-sm hover:bg-muted/40"
                  data-testid="manager-inbox-task-entry"
                  data-task-id={task.id}
                  onClick={() => onOpenTask(task)}
                >
                  <span className="font-medium">{task.title}</span>
                  <span className="mt-0.5 block text-xs text-muted-foreground">#{task.id.slice(0, 8)}</span>
                </button>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section className="space-y-2" aria-labelledby="manager-inbox-proposals-heading">
        <h3 id="manager-inbox-proposals-heading" className="text-sm font-medium">
          {tr("uxfix.inbox.proposalsHeading")}
          {pending.length > 0 ? (
            <span className="ml-2 text-xs font-normal text-muted-foreground" data-testid="manager-inbox-proposals-count">
              {pending.length}
            </span>
          ) : null}
        </h3>
        {pending.length === 0 ? (
          <EmptyState
            className="surface-solid rounded-xl border"
            testId="manager-inbox-proposals-empty"
            title={tr("uxfix.inbox.proposalsHeading")}
            description={tr("uxfix.inbox.proposalsEmpty")}
            action={
              <Button type="button" size="sm" variant="outline" onClick={onOpenChat} data-testid="manager-inbox-open-chat">
                <MessageSquare className="size-3.5" aria-hidden />
                {tr("uxfix.plan.goChat")}
              </Button>
            }
          />
        ) : (
          <ul className="space-y-3" data-testid="manager-inbox-proposals">
            {pending.map((proposal) => (
              <li key={proposal.id} data-testid="manager-inbox-entry" data-proposal-id={proposal.id}>
                <ProposalCard
                  projectPath={projectPath}
                  proposal={proposal}
                  tasks={tasks}
                  onChanged={onProposalChanged}
                  onOpenTask={onOpenTask}
                  onExecute={onExecute}
                  onPrepareBatch={onPrepareBatch}
                  onOpenBatch={onOpenBatch}
                  onOpenPlanSection={onOpenPlanSection}
                />
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}
