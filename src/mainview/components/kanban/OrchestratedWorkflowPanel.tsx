import { RunExecutionDetails } from "./RunExecutionDetails";
import { useCallback, useEffect, useState } from "react";
import type { Task } from "../../../shared/types.ts";
import type { OrchestratedWorkflowApproveBody, OrchestratedWorkflowView } from "../../../shared/pm-orchestrated-workflow.ts";
import { api } from "@/lib/api";
import { Button } from "@/components/ui/button";
import { t as tr } from "@/i18n/core";

type Payload = OrchestratedWorkflowView;

const DEFAULT_APPROVE: OrchestratedWorkflowApproveBody = {
  implementerEmployeeId: "",
  implementerHarnessId: "claude-code",
  implementerModel: "opus-5.5",
  reviewerHarness: "claude-code",
  reviewerModel: "haiku-5.5",
  autoReviewAfterImplementation: true,
  autoReworkOnChanges: false,
  maxReworkIterations: 0,
  maxLaunches: 2,
};

export function OrchestratedWorkflowPanel({ task, implementerEmployeeId }: { task: Task; implementerEmployeeId?: string | null }) {
  const [view, setView] = useState<Payload | null>(null);
  const [draft, setDraft] = useState<OrchestratedWorkflowApproveBody>(() => ({
    ...DEFAULT_APPROVE,
    implementerEmployeeId: implementerEmployeeId ?? "",
  }));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      setView(await api.getTaskOrchestratedWorkflow(task.id));
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, [task.id]);

  useEffect(() => {
    void load();
  }, [load, task.column, task.updatedAt, task.runId, task.qcState?.latestVerdict, task.qcState?.awaitingOwnerApproval]);

  useEffect(() => {
    void api.getTaskAssignment(task.id).then((r) => {
      if (r.assignment?.employeeId) setDraft((d) => ({ ...d, implementerEmployeeId: r.assignment!.employeeId }));
    }).catch(() => {});
  }, [task.id]);

  const wf = view?.workflow;
  const canApprove = task.column === "ready" && !task.archivedAt && !wf;

  async function approve() {
    setBusy(true);
    try {
      setView(await api.approveOrchestratedWorkflow(task.id, draft));
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  async function cancel() {
    setBusy(true);
    try {
      setView(await api.cancelOrchestratedWorkflow(task.id));
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  async function resume() {
    setBusy(true);
    try {
      setView(await api.resumeOrchestratedWorkflow(task.id));
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  if (!wf && !canApprove) return null;
  const currentActions = task.column !== "done" && !task.qcState?.awaitingOwnerApproval;
  return (
    <section className="space-y-2 rounded-md border border-border/80 bg-muted/20 p-3" data-testid="orchestrated-workflow">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h4 className="text-xs font-semibold">{tr("auto01.section_title")}</h4>
        <RunExecutionDetails runId={task.runId} compact />
      </div>
      {error && <p className="text-xs text-destructive">{error}</p>}
      {wf ? (
        <>
          <p className="text-xs text-muted-foreground" data-testid="orchestrated-status">
            {tr("auto01.status")}: {wf.status} · {wf.progress.phase}
          </p>
          <p className="text-xs" data-testid="orchestrated-limits">
            {tr("auto01.launches_remaining", { p0: String(view?.remainingLaunches ?? 0), p1: String(view?.remainingRework ?? 0) })}
          </p>
          {currentActions && view?.ownerAction && (
            <p className="text-xs text-warning" data-testid="orchestrated-owner-action">
              {view.ownerAction}
            </p>
          )}
          {wf.progress.pauseReason && (
            <p className="text-xs text-muted-foreground" data-testid="orchestrated-pause-reason">
              {wf.progress.pauseReason}
            </p>
          )}
          <div className="flex flex-wrap gap-2">
            {currentActions && wf.status === "paused" && (
              <Button type="button" size="sm" variant="outline" disabled={busy} data-testid="orchestrated-resume" onClick={() => void resume()}>
                {tr("auto01.resume")}
              </Button>
            )}
            {currentActions && wf.status !== "cancelled" && wf.status !== "awaiting_owner" && (
              <Button type="button" size="sm" variant="ghost" disabled={busy} data-testid="orchestrated-cancel" onClick={() => void cancel()}>
                {tr("auto01.cancel")}
              </Button>
            )}
          </div>
        </>
      ) : canApprove ? (
        <div className="space-y-2" data-testid="orchestrated-approve-form">
          <label className="flex items-center gap-2 text-xs">
            <input
              type="checkbox"
              checked={draft.autoReviewAfterImplementation !== false}
              onChange={(e) => setDraft({ ...draft, autoReviewAfterImplementation: e.target.checked })}
            />
            {tr("auto01.auto_review")}
          </label>
          <label className="flex items-center gap-2 text-xs">
            <input
              type="checkbox"
              checked={draft.autoReworkOnChanges === true}
              onChange={(e) => setDraft({ ...draft, autoReworkOnChanges: e.target.checked, maxReworkIterations: e.target.checked ? 1 : 0 })}
            />
            {tr("auto01.auto_rework")}
          </label>
          <Button type="button" size="sm" disabled={busy || !draft.implementerEmployeeId} data-testid="orchestrated-approve" onClick={() => void approve()}>
            {tr("auto01.approve")}
          </Button>
        </div>
      ) : (
        <p className="text-xs text-muted-foreground">{tr("auto01.not_ready")}</p>
      )}
    </section>
  );
}
