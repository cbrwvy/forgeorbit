import { AccountResourceComparison } from "@/components/router/AccountResourceComparison";
import { Button } from "@/components/ui/button";
import { t as tr } from "@/i18n/core";
import { api, ApiError } from "@/lib/api";
import { useCallback, useEffect, useState } from "react";
import type { AllocationPlanView, AllocationResourcePick } from "../../../shared/allocation/types.ts";

function messageOf(reason: unknown): string {
  if (reason instanceof ApiError || reason instanceof Error) return reason.message;
  return String(reason);
}

interface Props {
  projectPath: string;
  taskIds: string[];
  reviewerHarnessId?: string;
  reviewerModel?: string;
  reviewerMode?: string;
  onApplied?: (view: AllocationPlanView) => void;
  onReviewerPick?: (pick: AllocationResourcePick | null) => void;
}

/** FO-ROUTING03 compact allocation review (no apply on open). */
export function AllocationPlanReview({ projectPath, taskIds, reviewerHarnessId, reviewerModel, reviewerMode, onApplied, onReviewerPick }: Props) {
  const [view, setView] = useState<AllocationPlanView | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async (id: string) => {
    setView(await api.getAllocationPlan(id));
  }, []);

  async function propose() {
    if (!taskIds.length) return;
    setBusy(true);
    setError(null);
    try {
      const next = await api.proposeProjectAllocationPlan({
        projectPath,
        taskIds,
        reviewerHarnessId,
        reviewerModel,
        reviewerMode,
      });
      setView(next);
    } catch (e) {
      setError(messageOf(e));
    } finally {
      setBusy(false);
    }
  }

  async function recalculate() {
    if (!view) return;
    setBusy(true);
    setError(null);
    try {
      setView(await api.recalculateAllocationPlan(view.record.id, { reviewerHarnessId, reviewerModel, reviewerMode }));
    } catch (e) {
      setError(messageOf(e));
    } finally {
      setBusy(false);
    }
  }

  async function approve() {
    if (!view?.canApprove) return;
    setBusy(true);
    setError(null);
    try {
      setView(await api.approveAllocationPlan(view.record.id, view.planDigest));
    } catch (e) {
      setError(messageOf(e));
    } finally {
      setBusy(false);
    }
  }

  async function apply() {
    if (!view?.record.approvedDigest) return;
    setBusy(true);
    setError(null);
    try {
      const next = await api.applyAllocationPlan(view.record.id, view.record.approvedDigest);
      setView(next);
      onApplied?.(next);
    } catch (e) {
      setError(messageOf(e));
    } finally {
      setBusy(false);
    }
  }

  const slice = view?.record.plan.projects[0];
  const reviewerPick = slice?.reviewer.reviewer ?? null;
  const reviewerDrift = !!reviewerPick && (
    (!!reviewerModel && reviewerPick.modelId !== reviewerModel)
    || (!!reviewerHarnessId && reviewerPick.harnessId !== reviewerHarnessId)
    || (!!reviewerMode && reviewerPick.modeId !== reviewerMode)
  );
  useEffect(() => { onReviewerPick?.(reviewerPick); }, [onReviewerPick, reviewerPick]);

  return (
    <div className="rounded-md border border-border bg-card/40 p-3 text-sm" data-testid="allocation-plan-review">
      <p className="font-medium">{tr("routing03.title")}</p>
      <p className="mt-1 text-xs text-muted-foreground">{tr("routing03.advisory")}</p>
      {error ? <p className="mt-2 text-xs text-destructive" role="alert">{error}</p> : null}
      {!view ? (
        <Button className="mt-3" size="sm" disabled={busy || taskIds.length === 0} data-testid="allocation-plan-propose" onClick={() => void propose()}>
          {tr("routing03.propose")}
        </Button>
      ) : (
        <>
          <p className="mt-2 break-all font-mono text-xs text-muted-foreground" data-testid="allocation-plan-digest">
            {tr("routing03.digest")} {view.planDigest.slice(0, 16)}…
          </p>
          {!view.valid && view.validityBlocker ? (
            <p className="mt-1 text-xs text-warning" data-testid="allocation-plan-invalid">{view.validityBlocker}</p>
          ) : null}
          {slice?.tasks.map((row) => (
            <div key={row.taskId} className="mt-3 rounded border border-border/60 p-2" data-testid={`allocation-plan-task-${row.taskId}`}>
              <p className="font-medium">{row.title}</p>
              <p className="text-xs text-muted-foreground">{tr("routing03.developer")}: {row.developerEmployeeName ?? tr("routing03.unassigned")}</p>
              {row.developer ? (
                <p className="text-xs" data-testid="allocation-plan-developer" data-account={row.developer.accountId ?? ""} data-harness={row.developer.harnessId} data-mode={row.developer.modeId} data-model={row.developer.modelId}>
                  {row.developer.harnessLabel} · {row.developer.modelLabel} · {row.developer.modeLabel}
                  {row.developer.accountLabel ? ` · ${row.developer.accountLabel}` : ""}
                </p>
              ) : null}
              {row.developer?.unknownFacts.length ? (
                <p className="text-xs text-warning">{tr("routing03.unknown")}: {row.developer.unknownFacts.join(", ")}</p>
              ) : null}
              {row.blockers[0] ? <p className="text-xs text-destructive">{row.blockers[0]}</p> : null}
              {view.record.status === "proposed" && row.developer ? (
                <AccountResourceComparison
                  taskId={row.taskId}
                  role="developer"
                  harnessId={row.developer.harnessId}
                  model={row.developer.modelId}
                  mode={row.developer.modeId}
                  kind={row.developer.kind}
                  onChoose={(o) => {
                    void api.patchAllocationPlanTaskResource(view.record.id, row.taskId, o.id).then(setView).catch((e) => setError(messageOf(e)));
                  }}
                />
              ) : null}
            </div>
          ))}
          {slice?.reviewer.reviewer ? (
            <div className="mt-3 rounded border border-border/60 p-2" data-testid="allocation-plan-reviewer">
              <p className="text-xs font-medium">{tr("routing03.reviewer")}</p>
              <p className="text-xs" data-testid="allocation-plan-reviewer-resource" data-account={slice.reviewer.reviewer.accountId ?? ""} data-fingerprint={slice.reviewer.reviewer.resourceFingerprint ?? ""} data-harness={slice.reviewer.reviewer.harnessId} data-mode={slice.reviewer.reviewer.modeId} data-model={slice.reviewer.reviewer.modelId}>
                {slice.reviewer.reviewer.harnessLabel} · {slice.reviewer.reviewer.modelLabel} · {slice.reviewer.reviewer.modeLabel}
                {slice.reviewer.reviewer.accountLabel ? ` · ${slice.reviewer.reviewer.accountLabel}` : ""}
              </p>
              {reviewerDrift ? (
                <p className="text-xs text-warning" data-testid="allocation-reviewer-drift">{tr("routing03.reviewer_drift", { proposed: reviewerPick?.modelId ?? "", selected: reviewerModel ?? "" })}</p>
              ) : null}
            </div>
          ) : null}
          <div className="mt-3 flex flex-wrap gap-2">
            <Button size="sm" variant="outline" disabled={busy} data-testid="allocation-plan-recalculate" onClick={() => void recalculate()}>
              {tr("routing03.recalculate")}
            </Button>
            <Button size="sm" variant="outline" disabled={busy || !view.canApprove || reviewerDrift} data-testid="allocation-plan-approve" onClick={() => void approve()}>
              {tr("routing03.approve")}
            </Button>
            <Button size="sm" disabled={busy || !view.canApply || reviewerDrift} data-testid="allocation-plan-apply" onClick={() => void apply()}>
              {tr("routing03.apply")}
            </Button>
          </div>
          <p className="mt-2 text-xs text-muted-foreground" data-testid="allocation-plan-status">
            {tr("routing03.status")}: {view.record.status}
          </p>
        </>
      )}
    </div>
  );
}
