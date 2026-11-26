import { ProviderRefusalNotice } from "@/components/ui/provider-refusal-notice";
import { requestOpenAccounts } from "@/lib/open-accounts";
import { QcRecoveryPanel } from "./QcRecoveryPanel";
import { ProjectTestEvidence } from "../permissions/ProjectTestEvidence";
import { RunExecutionDetails } from "./RunExecutionDetails";
import { RunTerminationNotice } from "./RunTerminationNotice";
import { useCallback, useEffect, useMemo, useState } from "react";
import { Loader2 } from "lucide-react";
import type { Task, TaskQcReview, TaskQcState } from "../../../shared/types.ts";
import { qcExtensionEligibility, qcRoundLimitReached } from "../../../shared/task-quality-control.ts";
import { useConfirm } from "@/components/ui/confirm";
import { api } from "@/lib/api";
import { t as tr } from "@/i18n/core";
import { Button } from "@/components/ui/button";

export function TaskQualityControl({
  task,
  harnesses,
  refreshEpoch = 0,
}: {
  task: Task;
  harnesses: readonly { id: string; label: string }[];
  /** Changes when something this panel reads changed without moving the task (a publication). */
  refreshEpoch?: number;
}) {
  const [bundle, setBundle] = useState<{ state: TaskQcState; reviews: TaskQcReview[]; timeLimitSeconds?: number | null } | null>(null);
  const confirm = useConfirm();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const harnessOptions = useMemo(() => (harnesses.length > 0 ? harnesses : [{ id: task.agent, label: task.agent }]), [harnesses, task.agent]);
  const [reviewerHarness, setReviewerHarness] = useState(task.agent);
  const [reviewerModel, setReviewerModel] = useState(task.model ?? "opus-5.5");

  const load = useCallback(async () => {
    try {
      setBundle(await api.getTaskQc(task.id));
    } catch {
      setBundle(null);
    }
  }, [task.id]);

  useEffect(() => {
    void load();
  }, [load, task.column, task.updatedAt, task.qcState?.latestVerdict, refreshEpoch]);

  if (task.column !== "review" && task.column !== "ready" && task.column !== "blocked" && (bundle?.reviews.length ?? 0) === 0) {
    return null;
  }

  const state = bundle?.state ?? task.qcState ?? null;
  const reviews = bundle?.reviews ?? [];
  // Every round is used and the last verdict is not a PASS: no further review will start.
  const limitReached = qcRoundLimitReached(state);
  const extensionOffer = qcExtensionEligibility(state, task.column).eligible;
  const extensionPending = !!state?.extension && !state.extension.reviewId;
  const extensionSpent = !!state?.extension?.reviewId;

  // The Owner's one explicit authorization of one more review round. It starts nothing and approves nothing.
  const authorizeExtension = async () => {
    const ok = await confirm(() => ({
      title: tr("d8.qc.extension_title"),
      description: tr("d8.qc.extension_body"),
      confirmLabel: tr("d8.qc.extension_confirm"),
    }));
    if (!ok) return;
    setBusy(true);
    setError(null);
    try {
      await api.authorizeQcExtension(task.id, state?.roundCount ?? 0);
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      await load();
    } finally {
      setBusy(false);
    }
  };

  const requestReview = async () => {
    setBusy(true);
    setError(null);
    try {
      const out = await api.prepareTaskQcReview(task.id, {
        reviewerHarness,
        reviewerModel,
      });
      await api.startTaskQcReview(task.id, out.review.id);
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="space-y-2 rounded-md border border-border p-3" data-testid="task-quality-control">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h4 className="text-xs font-semibold">{tr("qc.section_title")}</h4>
        {task.column === "review" && state?.latestVerdict !== "BLOCKED" && !state?.activeReviewId && !state?.awaitingOwnerApproval && !limitReached && (
          <Button type="button" size="sm" variant="secondary" disabled={busy} onClick={() => { void requestReview(); }} data-testid="task-qc-request">
            {busy ? <Loader2 className="size-3.5 animate-spin" /> : null}
            {tr("qc.request_review")}
          </Button>
        )}
      </div>
      {task.column === "review" && state?.latestVerdict !== "BLOCKED" && !state?.activeReviewId && !state?.awaitingOwnerApproval && !limitReached && (
        <div className="flex flex-wrap gap-2 text-xs" data-testid="task-qc-reviewer-pickers">
          <label className="flex flex-col gap-0.5">
            <span className="text-muted-foreground">{tr("qc.reviewer_harness")}</span>
            <select
              className="rounded border border-border bg-background px-2 py-1"
              value={reviewerHarness}
              onChange={(e) => setReviewerHarness(e.target.value)}
              data-testid="task-qc-reviewer-harness"
            >
              {harnessOptions.map((h) => (
                <option key={h.id} value={h.id}>{h.label}</option>
              ))}
            </select>
          </label>
          <label className="flex flex-col gap-0.5">
            <span className="text-muted-foreground">{tr("qc.reviewer_model")}</span>
            <input
              className="rounded border border-border bg-background px-2 py-1"
              value={reviewerModel}
              onChange={(e) => setReviewerModel(e.target.value)}
              data-testid="task-qc-reviewer-model"
            />
          </label>
        </div>
      )}
      {task.column === "review" && state?.awaitingOwnerApproval && state.latestVerdict === "PASS" && (
        <p className="text-xs text-warning" data-testid="task-qc-awaiting-owner">{tr("qc.awaiting_owner")}</p>
      )}
      {limitReached && (state?.roundCount ?? 0) > 0 && (
        <p className="text-xs text-warning" data-testid="task-qc-limit-reached">{tr(state?.latestVerdict == null ? "d8.qc.limit_no_verdict" : "d8.qc.limit_reached", { max: String(state?.maxRounds ?? 0) })}</p>
      )}
      {extensionOffer && (
        <div className="space-y-1" data-testid="task-qc-extension-offer">
          <p className="text-xs text-muted-foreground">{tr("d8.qc.extension_explain")}</p>
          <Button type="button" size="sm" variant="secondary" disabled={busy} onClick={() => { void authorizeExtension(); }} data-testid="task-qc-extension-authorize">
            {busy ? <Loader2 className="size-3.5 animate-spin" /> : null}
            {tr("d8.qc.extension_button")}
          </Button>
        </div>
      )}
      {extensionPending && (
        <p className="text-xs text-warning" data-testid="task-qc-extension-authorized">{tr("d8.qc.extension_authorized")}</p>
      )}
      {extensionSpent && limitReached && (
        <p className="text-xs text-warning" data-testid="task-qc-extension-spent">{tr("d8.qc.extension_spent")}</p>
      )}
      {state?.latestVerdict === "BLOCKED" && (
        <p className="text-xs text-warning" data-testid="task-qc-blocked">{tr("qc.blocked")}</p>
      )}
      {state?.latestVerdict === "CHANGES_REQUESTED" && task.column === "ready" && (
        <p className="text-xs text-muted-foreground" data-testid="task-qc-rework">{tr("qc.rework_ready")}</p>
      )}
      {task.column === "review" && state?.latestVerdict !== "BLOCKED" && !state?.activeReviewId && !state?.awaitingOwnerApproval && !limitReached && bundle?.timeLimitSeconds != null && (
        <p className="text-xs text-muted-foreground" data-testid="task-qc-time-limit">{tr("stop.limit.qc", { seconds: String(bundle.timeLimitSeconds) })}</p>
      )}
      {task.column === "review" && !state?.activeReviewId && !state?.awaitingOwnerApproval && state?.latestVerdict == null && !limitReached && (state?.roundCount ?? 0) > 0 && (
        <p className="text-xs text-warning" data-testid="task-qc-no-verdict-latest">{tr("d4.qc.no_verdict_latest")}</p>
      )}
      {reviews.some((r) => r.status === "complete" && r.verdict == null && r.reviewRunTermination?.requestedAt == null) && (
        <p className="text-xs text-warning" data-testid="task-qc-process-failure">{tr("qc.process_failure")}</p>
      )}
      {/* Read-only evidence of the fixed project test. It is shown next to QC and never feeds the verdict. */}
      <ProjectTestEvidence key={`project-test-evidence-${task.id}`} task={task} />
      {task.column !== "done" && !state?.awaitingOwnerApproval && <QcRecoveryPanel taskId={task.id} refreshKey={`${task.column}:${task.updatedAt}:${task.qcState?.latestVerdict ?? ""}:${refreshEpoch}`} />}
      {error && <p className="text-xs text-destructive" data-testid="task-qc-error">{error}</p>}
      {reviews.length > 0 && (
        <ul className="max-h-40 space-y-2 overflow-y-auto text-xs" data-testid="task-qc-history">
          {reviews.map((r) => (
            <li key={r.id} className="rounded border border-border/60 p-2">
              <div className="font-medium">
                {tr("qc.round")} {r.round} · {r.verdict ?? r.status}
                {r.reviewerHarness !== task.agent && (
                  <span className="ml-1 text-muted-foreground">({r.reviewerHarness})</span>
                )}
              </div>
              {r.status === "complete" && r.implementationAttempt != null && (
                <p className="text-muted-foreground" data-testid="qc-round-coverage" data-latest={r.coversLatestOutput ? "true" : "false"}>
                  {tr(r.coversLatestOutput ? "d4.qc.attempt_latest" : "d4.qc.attempt_earlier", { n: String(r.implementationAttempt) })}
                </p>
              )}
              <RunExecutionDetails runId={r.reviewRunId} />
              <RunTerminationNotice
                termination={r.reviewRunTermination}
                runStatus={r.status === "running" ? "running" : "settled"}
                role="reviewer"
                testId="qc-termination"
                className="mt-1"
              />
              {r.providerRefusal && (
                <ProviderRefusalNotice
                  refusal={r.providerRefusal}
                  modelLabel={r.reviewerModel}
                  testId="qc-provider-refusal"
                  className="mt-1 space-y-1 rounded-md border border-warning/40 bg-warning/10 px-2 py-1.5"
                  onOpenAccount={requestOpenAccounts}
                />
              )}
              {r.summary && <p className="mt-1 whitespace-pre-wrap text-muted-foreground">{r.summary}</p>}
              {(r.findings?.length ?? 0) > 0 && <ul className="mt-1 list-inside list-disc space-y-1" data-testid="task-qc-findings">
                {r.findings.map((finding, index) => <li key={index} className="whitespace-pre-wrap">{finding.text}</li>)}
              </ul>}
              {r.feedback && <p className="mt-1 whitespace-pre-wrap">{r.feedback}</p>}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
