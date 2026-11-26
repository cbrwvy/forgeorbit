import { RunExecutionDetails } from "./RunExecutionDetails";
import { useCallback, useEffect, useState } from "react";
import type { Task } from "../../../shared/types.ts";
import type { SupervisedLiveStepId } from "../../../shared/supervised-live-workflow.ts";
import { api } from "@/lib/api";
import { t as tr } from "@/i18n/core";
import { cn } from "@/lib/utils";
import { knownText } from "@/lib/known-text";
import { Button } from "@/components/ui/button";

type Payload = Awaited<ReturnType<typeof api.getTaskSupervisedLive>>;

const STEP_LABEL: Record<SupervisedLiveStepId, string> = {
  intake: "live.step.intake",
  inbox: "live.step.inbox",
  ready: "live.step.ready",
  implementer: "live.step.implementer",
  "authorize-run": "live.step.authorize",
  implement: "live.step.implement",
  "request-qc": "live.step.request_qc",
  "qc-run": "live.step.qc_run",
  "owner-accept": "live.step.owner_accept",
  done: "live.step.done",
};

export function SupervisedLiveWorkflow({ task, onTaskChanged }: { task: Task; onTaskChanged?: (taskId: string, patch: Partial<Task>) => void }) {
  const [payload, setPayload] = useState<Payload | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    try {
      setPayload(await api.getTaskSupervisedLive(task.id));
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, [task.id]);

  useEffect(() => {
    void load();
  }, [load, task.column, task.updatedAt, task.runId, task.qcState?.latestVerdict, task.qcState?.activeReviewId, task.qcState?.awaitingOwnerApproval]);

  if (error && !payload) return null;

  const view = payload;
  if (!view) return null;

  // The same Owner transitions as Kanban, reachable from a PM proposal or Needs you.
  const action = task.archivedAt == null && !task.pipelineId && !task.pipelineParentId
    ? view.phase === "backlog-draft" ? "admit"
      : view.phase === "inbox-triage" ? "ready"
      : view.phase === "awaiting-owner-acceptance" ? "done" : null
    : null;
  const advance = async () => {
    if (!action || busy) return;
    setBusy(true);
    setError(null);
    try {
      const updated = action === "admit" ? await api.admitTaskToInbox(task.id) : await api.moveTask(task.id, action);
      onTaskChanged?.(task.id, { column: updated.column, qcState: updated.qcState, updatedAt: updated.updatedAt });
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="space-y-2 rounded-md border border-border/80 bg-muted/20 p-3" data-testid="supervised-live-workflow">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h4 className="text-xs font-semibold">{tr("live.section_title")}</h4>
        <RunExecutionDetails runId={task.runId} compact />
      </div>
      {view.usesFakeDriver && (
        <p className="text-xs text-warning" data-testid="supervised-live-fake-badge" role="status">
          {tr("live.fake_driver_badge")}
        </p>
      )}
      <p className="text-xs text-muted-foreground" data-testid="supervised-live-phase">
        {tr(`live.phase.${view.phase}` as "live.phase.ready-prepare")}
      </p>
      {view.implementer && (
        <p className="text-xs" data-testid="supervised-live-implementer">
          {tr("live.implementer")}: {view.implementer.name}
        </p>
      )}
      {view.ownerAction && (
        <p className="text-xs text-warning" data-testid="supervised-live-owner-action">
          {knownText(view.ownerAction)}
        </p>
      )}
      {view.columnBlock && (
        <p className="text-xs text-muted-foreground" data-testid="supervised-live-column-block">
          {knownText(view.columnBlock)}
        </p>
      )}
      {action && (
        <Button type="button" size="sm" disabled={busy} onClick={() => void advance()} data-testid={`supervised-live-${action}`}>
          {tr(action === "admit" ? "uxfix.task.admitInbox" : action === "ready" ? "live.move_ready" : "common.mark_done")}
        </Button>
      )}
      {error && <p role="alert" className="text-xs text-destructive" data-testid="supervised-live-error">{error}</p>}
      <ol className="flex flex-wrap gap-1" aria-label={tr("live.steps_aria")}>
        {view.steps.map((step) => (
          <li
            key={step.id}
            className={cn(
              "rounded border px-1.5 py-0.5 text-[10px]",
              step.status === "done" && "border-success/40 bg-success/10 text-success",
              step.status === "current" && "border-primary bg-primary/10 font-medium",
              step.status === "upcoming" && "border-border text-muted-foreground",
              step.status === "blocked" && "border-destructive/40 text-destructive",
            )}
            data-testid={`supervised-live-step-${step.id}`}
            data-status={step.status}
          >
            {tr(STEP_LABEL[step.id] as "live.step.ready")}
          </li>
        ))}
      </ol>
    </section>
  );
}
