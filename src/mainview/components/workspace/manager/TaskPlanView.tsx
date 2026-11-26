import { t as tr } from "@/i18n/core";
import { useLocale as useUILocale } from "@/i18n/react";
import { useCallback, useEffect, useRef, useState } from "react";
import { ListTree, Loader2, Play, RefreshCw } from "lucide-react";
import { ApiError, api } from "@/lib/api";
import { Button } from "@/components/ui/button";
import { OptionCard } from "@/components/kanban/ExecutorSuggestions";
import { TaskQueuePanel } from "./TaskQueuePanel";
import { PRIORITY_LABELS } from "../../../../shared/task-scheduling.ts";
import { PLAN_STATES, type PlanNode, type PlanTaskState, type PlanView } from "../../../../shared/task-plan.ts";
import type { Task } from "../../../../shared/types.ts";

const STATE_TONE: Record<PlanTaskState | "skipped", string> = {
  ready: "bg-success/10 text-success",
  blocked: "bg-warning/10 text-warning",
  "in-progress": "bg-info/10 text-info",
  "waiting-owner": "bg-warning/10 text-warning",
  completed: "bg-muted text-muted-foreground",
  skipped: "bg-muted text-muted-foreground",
};

interface Props {
  projectPath: string;
  proposalId: string;
  /** Changes when the proposal or its tasks change, so an open plan re-reads. */
  refreshToken: string;
  tasks: Task[];
  onOpenTask: (task: Task) => void;
  /** The existing supervised-run review (FO-005B). Prepares a review; never starts a run. */
  onExecute?: (taskId: string) => void;
  /** Open a batch prepared from the queue in the Autonomous Execution tab. */
  onOpenBatch?: (batchId: string) => void;
  /** Start expanded (the Plan & queue section shows plans open). */
  defaultOpen?: boolean;
}

/**
 * Read-only view of a task proposal as a plan: order, dependencies, what is
 * ready or blocked and why, and the recommender's executor options. Every
 * action leads into an existing flow; the plan itself starts and assigns
 * nothing. "Review a run" first checks the reviewed plan key, so a plan that
 * changed meanwhile is refreshed instead of acted on.
 */
export function TaskPlanView({ projectPath, proposalId, refreshToken, tasks, onOpenTask, onExecute, onOpenBatch, defaultOpen = false }: Props) {
  useUILocale();
  const [open, setOpen] = useState(defaultOpen);
  const [plan, setPlan] = useState<PlanView | null>(null);
  const [busy, setBusy] = useState(false);
  const [checking, setChecking] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [stale, setStale] = useState(false);
  const epoch = useRef(0);

  const load = useCallback(async () => {
    const mine = ++epoch.current;
    setBusy(true);
    setError(null);
    try {
      const next = await api.getTaskPlan(projectPath, proposalId);
      if (epoch.current === mine) setPlan(next);
    } catch (caught) {
      if (epoch.current === mine) setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      if (epoch.current === mine) setBusy(false);
    }
  }, [projectPath, proposalId]);

  useEffect(() => {
    if (open) void load();
    return () => { epoch.current += 1; };
  }, [open, load, refreshToken]);

  const review = async (node: PlanNode) => {
    if (!plan || !node.taskId || !onExecute) return;
    setChecking(node.itemId);
    setError(null);
    try {
      await api.verifyTaskPlan(projectPath, proposalId, plan.planKey);
      setStale(false);
      onExecute(node.taskId);
    } catch (caught) {
      if (caught instanceof ApiError && caught.status === 409) {
        const fresh = (caught.body as { plan?: PlanView } | null)?.plan;
        if (fresh) setPlan(fresh);
        setStale(true);
      } else {
        setError(caught instanceof Error ? caught.message : String(caught));
      }
    } finally {
      setChecking(null);
    }
  };

  return (
    <div className="space-y-2 border-t border-border/60 pt-2" data-testid="task-plan">
      <div className="flex flex-wrap items-center gap-2">
        <Button type="button" size="sm" variant="outline" onClick={() => setOpen((v) => !v)} aria-expanded={open} data-testid="task-plan-toggle">
          <ListTree className="size-3.5" aria-hidden />{open ? tr("plan.hide") : tr("plan.view")}
        </Button>
        {open && (
          <Button type="button" size="sm" variant="ghost" onClick={() => { setStale(false); void load(); }} disabled={busy} data-testid="task-plan-refresh">
            {busy ? <Loader2 className="size-3.5 motion-safe:animate-spin" aria-hidden /> : <RefreshCw className="size-3.5" aria-hidden />}{tr("plan.refresh")}
          </Button>
        )}
        {open && <p className="min-w-0 flex-1 text-[11px] text-muted-foreground">{tr("plan.read_only_note")}</p>}
      </div>
      {open && stale && (
        <p role="alert" className="rounded-md border border-warning/40 bg-warning/10 px-2 py-1 text-[11px] text-warning" data-testid="task-plan-stale">{tr("plan.stale")}</p>
      )}
      {open && error && <p role="alert" className="break-words text-[11px] text-danger" data-testid="task-plan-error">{error}</p>}
      {open && !plan && busy && <p role="status" className="text-xs text-muted-foreground">{tr("plan.loading")}</p>}
      {open && plan && (
        <div className="space-y-2" data-testid="task-plan-body" data-plan-key={plan.planKey}>
          <p className="text-xs font-medium" data-testid="task-plan-goal">{tr("plan.goal")}: {plan.title}</p>
          <ul className="flex flex-wrap gap-1.5" aria-label={tr("plan.summary")} data-testid="task-plan-counts">
            {PLAN_STATES.map((state) => (
              <li key={state} className={`rounded px-1.5 py-0.5 text-[10px] font-medium ${STATE_TONE[state]}`} data-state={state}>
                {tr(`plan.state.${state}`)}: {plan.counts[state]}
              </li>
            ))}
            {plan.counts.skipped > 0 && <li className={`rounded px-1.5 py-0.5 text-[10px] font-medium ${STATE_TONE.skipped}`}>{tr("plan.state.skipped")}: {plan.counts.skipped}</li>}
          </ul>
          {plan.issues.filter((issue) => issue.code === "cycle" || issue.code === "rejected").map((issue) => (
            <p key={issue.code} role="alert" className="rounded-md border border-danger/40 bg-danger/10 px-2 py-1 text-[11px] text-danger" data-testid={`task-plan-issue-${issue.code}`}>{issue.message}</p>
          ))}
          {plan.proposalStatus !== "rejected" && plan.nodes.some((node) => node.stage === "created") && (
            <TaskQueuePanel
              projectPath={projectPath}
              proposalId={proposalId}
              plan={plan}
              tasks={tasks}
              onOpenTask={onOpenTask}
              onExecute={onExecute}
              onOpenBatch={onOpenBatch}
              onStalePlan={(fresh) => { if (fresh) setPlan(fresh); setStale(true); }}
            />
          )}
          <ol className="space-y-2" data-testid="task-plan-nodes">
            {plan.nodes.map((node) => {
              const task = node.taskId ? tasks.find((candidate) => candidate.id === node.taskId) ?? null : null;
              const state = node.state ?? "skipped";
              return (
                <li key={node.itemId} className="min-w-0 space-y-1 rounded-md border border-border/70 px-2 py-1.5 text-xs" data-testid="task-plan-node" data-state={state} data-stage={node.stage} data-wave={node.wave} data-order={node.order}>
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="text-[10px] text-muted-foreground">{node.order}.</span>
                    <span className="min-w-0 break-words font-medium" data-testid="task-plan-node-title">{node.title}</span>
                    <span className={`rounded px-1.5 py-0.5 text-[10px] font-medium ${STATE_TONE[state]}`} data-testid="task-plan-node-state">{tr(`plan.state.${state}`)}</span>
                    {node.stage === "proposed" && <span className="text-[10px] text-muted-foreground">{tr("plan.after_approval")}</span>}
                    <span className="text-[10px] text-muted-foreground">{tr("plan.wave")} {node.wave} · {PRIORITY_LABELS[node.priority]}</span>
                  </div>
                  {node.reasons.length > 0 && (
                    <ul className="list-disc pl-4 text-muted-foreground" data-testid="task-plan-reasons">
                      {node.reasons.map((reason, index) => <li key={index} className="break-words">{reason}</li>)}
                    </ul>
                  )}
                  {node.dependsOn.length > 0 && (
                    <p className="break-words text-muted-foreground" data-testid="task-plan-depends">
                      {tr("plan.depends_on")}: {node.dependsOn.map((dep) => `${dep.title} (${tr(`plan.dep.${dep.status}`)})`).join(", ")}
                    </p>
                  )}
                  {node.warnings.map((warning, index) => <p key={index} className="break-words text-[11px] text-warning" data-testid="task-plan-warning">{warning}</p>)}
                  {node.assignment && <p className="text-muted-foreground" data-testid="task-plan-assignee">{tr("plan.assignee")}: {node.assignment.employeeName ?? node.assignment.employeeId.slice(0, 8)}</p>}
                  {node.pendingAssignmentProposalId && <p className="text-warning" data-testid="task-plan-assignment-pending">{tr("plan.assignment_pending")}</p>}
                  {node.executor && (
                    <div className="space-y-1" data-testid="task-plan-executor">
                      <p className="font-medium">{tr("plan.executor")}</p>
                      {node.executor.error && <p className="text-muted-foreground">{node.executor.error}</p>}
                      {!node.executor.error && !node.executor.proposed && <p className="text-muted-foreground" data-testid="task-plan-no-executor">{tr("plan.no_executor")}</p>}
                      {node.executor.proposed && (
                        <ul className="space-y-1">
                          <OptionCard option={node.executor.proposed} chosen={false} />
                          {node.executor.alternatives.map((option) => <OptionCard key={option.id} option={option} chosen={false} />)}
                        </ul>
                      )}
                      <p className="text-[10px] text-muted-foreground">{tr("plan.unknown_note")}</p>
                    </div>
                  )}
                  <div className="flex flex-wrap items-center gap-2">
                    {task && (
                      <button type="button" className="underline underline-offset-2" onClick={() => onOpenTask(task)} data-testid="task-plan-open-task">{tr("common.open_task")}</button>
                    )}
                    {task && onExecute && node.state === "ready" && task.column === "ready" && !task.archivedAt && (
                      <Button type="button" size="sm" variant="outline" disabled={checking != null} onClick={() => void review(node)} data-testid="task-plan-review-run">
                        {checking === node.itemId ? <Loader2 className="size-3.5 motion-safe:animate-spin" aria-hidden /> : <Play className="size-3.5" aria-hidden />}{tr("plan.review_run")}
                      </Button>
                    )}
                  </div>
                </li>
              );
            })}
          </ol>
        </div>
      )}
    </div>
  );
}
