import { useCallback, useEffect, useState } from "react";
import { Loader2 } from "lucide-react";
import type { QcRecoveryGrant, QcRecoveryView } from "../../../shared/qc-recovery.ts";
import type { ReviewEvidenceBundle } from "../../../shared/review-evidence.ts";
import { api } from "@/lib/api";
import { t as tr } from "@/i18n/core";
import { Button } from "@/components/ui/button";

export function QcRecoveryPanel({ taskId, refreshKey }: { taskId: string; refreshKey: string }) {
  const [view, setView] = useState<QcRecoveryView | null>(null);
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [harnessId, setHarnessId] = useState("");
  const [model, setModel] = useState("");
  const [effort, setEffort] = useState("low");
  const [minutes, setMinutes] = useState(30);

  const load = useCallback(async () => {
    try {
      const next = await api.getQcRecovery(taskId);
      setView(next);
      setHarnessId((current) => current || next.candidates.find((item) => !item.unavailableReason)?.harnessId || "");
    } catch {
      setView(null);
    }
  }, [taskId]);

  useEffect(() => {
    void load();
  }, [load, refreshKey]);

  useEffect(() => {
    if (!view?.grant || view.grant.status !== "consumed" || view.grant.outcome) return;
    const timer = setInterval(() => { void load(); }, 500);
    return () => clearInterval(timer);
  }, [load, view?.grant?.status, view?.grant?.outcome]);

  if (!view) return null;
  const refresh = view.evidenceRefresh;
  const showRecovery = view.reconciliationRequired || view.eligible || view.grant != null || !!view.evidenceReason || !!refresh?.eligible || !!refresh?.blockedSummary;
  const showFirst = !!view.firstReview?.applicable && !refresh?.blockedSummary;
  if (!showRecovery && !showFirst) return null;
  const grant = view.grant;
  const openGrant = grant && (grant.status === "prepared" || grant.status === "approved") ? grant : null;
  const evidenceGrant = openGrant?.purpose === "evidence-refresh" ? openGrant : null;
  const recoveryOpen = openGrant && openGrant.purpose !== "evidence-refresh" ? openGrant : null;
  const selected = view.candidates.find((item) => item.harnessId === (openGrant?.reviewerHarnessId ?? harnessId)) ?? null;

  const run = async (action: () => Promise<unknown>) => {
    setBusy(true);
    setError(null);
    try {
      await action();
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
    {showRecovery && <section className="space-y-2 rounded-md border border-border p-3" data-testid="qc-recovery-panel">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h4 className="text-xs font-semibold">{tr("qc.recovery_title")}</h4>
        {view.reconciliationRequired && (
          <Button type="button" size="sm" variant="secondary" disabled={busy} data-testid="qc-recovery-reconcile" onClick={() => { void run(() => api.reconcileQcRecovery(taskId)); }}>
            {busy ? <Loader2 className="size-3.5 animate-spin" /> : null}
            {tr("qc.recovery_reconcile")}
          </Button>
        )}
        {view.eligible && !recoveryOpen && !evidenceGrant && (
          <Button type="button" size="sm" variant="secondary" data-testid="qc-recovery-open" onClick={() => setOpen(true)}>
            {tr("qc.recovery_review_again")}
          </Button>
        )}
      </div>
      {view.developerRunId && (
        <p className="text-xs" data-testid="qc-recovery-developer-run">{tr("qc.recovery_developer_run")}: {view.developerRunId}</p>
      )}
      {view.failedReviewRunId && (
        <p className="text-xs" data-testid="qc-recovery-failed-run">{tr("qc.recovery_failed_run")}: {view.failedReviewRunId}</p>
      )}
      {view.failureSummary && <p className="text-xs text-warning" data-testid="qc-recovery-failure">{view.failureSummary}</p>}
      {view.evidence && (
        <p className="text-xs text-muted-foreground" data-testid="qc-recovery-evidence">{view.evidence.note}</p>
      )}
      {view.evidenceReason && <p className="text-xs text-destructive" data-testid="qc-recovery-evidence-error">{view.evidenceReason}</p>}
      <p className="text-xs text-muted-foreground" data-testid="qc-recovery-runs">
        {tr("qc.recovery_implementation_runs")}: {view.implementationRunCount}. {tr("qc.recovery_review_runs")}: {view.reviewRunCount}.
      </p>
      {(open || openGrant) && view.eligible && !openGrant && (
        <div className="space-y-2 text-xs" data-testid="qc-recovery-form">
          <label className="flex flex-col gap-0.5">
            <span className="text-muted-foreground">{tr("qc.recovery_harness")}</span>
            <select className="rounded border border-border bg-background px-2 py-1" value={harnessId} data-testid="qc-recovery-harness" onChange={(e) => setHarnessId(e.target.value)}>
              {view.candidates.filter((item) => !item.unavailableReason).map((item) => (
                <option key={item.harnessId} value={item.harnessId}>{item.label}{item.accountLabel ? ` · ${item.accountLabel}` : ""}</option>
              ))}
            </select>
          </label>
          {selected && selected.unsupportedModels.length > 0 && (
            <ul className="text-warning" data-testid="qc-recovery-unsupported">
              {selected.unsupportedModels.map((item) => (
                <li key={item.modelId}>{tr("qc.recovery_unsupported")}: {item.modelId}</li>
              ))}
            </ul>
          )}
          <label className="flex flex-col gap-0.5">
            <span className="text-muted-foreground">{tr("qc.reviewer_model")}</span>
            <input className="rounded border border-border bg-background px-2 py-1" value={model} data-testid="qc-recovery-model" onChange={(e) => setModel(e.target.value)} />
          </label>
          <label className="flex flex-col gap-0.5">
            <span className="text-muted-foreground">{tr("qc.recovery_effort")}</span>
            <input className="rounded border border-border bg-background px-2 py-1" value={effort} data-testid="qc-recovery-effort" onChange={(e) => setEffort(e.target.value)} />
          </label>
          <label className="flex flex-col gap-0.5">
            <span className="text-muted-foreground">{tr("qc.recovery_expiry")}</span>
            <input className="rounded border border-border bg-background px-2 py-1" type="number" min={5} max={240} value={minutes} data-testid="qc-recovery-minutes" onChange={(e) => setMinutes(Number(e.target.value))} />
          </label>
          {selected && (
            <p data-testid="qc-recovery-preview">
              {tr("qc.recovery_account")}: {selected.accountLabel ?? "—"}. {tr("qc.recovery_mode")}: {selected.mode}. {tr("qc.recovery_sandbox")}: {selected.sandbox}. {selected.permission}
            </p>
          )}
          <p data-testid="qc-recovery-quota">{tr("qc.recovery_quota")}: {tr("qc.recovery_unknown")}. {tr("qc.recovery_cost")}: {tr("qc.recovery_unknown")}.</p>
          <p data-testid="qc-recovery-scope">{tr("qc.recovery_scope")}</p>
          <Button type="button" size="sm" disabled={busy || !harnessId || !model.trim()} data-testid="qc-recovery-prepare" onClick={() => { void run(async () => { await api.prepareQcRecovery(taskId, { reviewerHarness: harnessId, reviewerModel: model.trim(), reviewerEffort: effort.trim() || undefined, validMinutes: minutes }); }); }}>
            {tr("qc.recovery_prepare")}
          </Button>
        </div>
      )}
      {grant && grant.purpose !== "evidence-refresh" && <GrantFacts grant={grant} />}
      {recoveryOpen?.status === "prepared" && (
        <Button type="button" size="sm" disabled={busy} data-testid="qc-recovery-approve" onClick={() => { if (!recoveryOpen) return; void run(() => api.approveQcRecovery(taskId, recoveryOpen.id)); }}>
          {tr("qc.recovery_approve")}
        </Button>
      )}
      {recoveryOpen?.status === "approved" && (
        <Button type="button" size="sm" disabled={busy} data-testid="qc-recovery-start" onClick={() => { if (!recoveryOpen) return; void run(() => api.startQcRecovery(taskId, recoveryOpen.id)); }}>
          {tr("qc.recovery_start")}
        </Button>
      )}
      {recoveryOpen && (
        <Button type="button" size="sm" variant="ghost" disabled={busy} data-testid="qc-recovery-cancel" onClick={() => { if (!recoveryOpen) return; void run(() => api.cancelQcRecovery(taskId, recoveryOpen.id)); }}>
          {tr("qc.recovery_cancel")}
        </Button>
      )}
      {grant?.outcome === "pass" && <p className="text-xs text-warning" data-testid="qc-recovery-pass">{tr("qc.recovery_pass")}</p>}
      {grant?.outcome === "changes_requested" && <p className="text-xs" data-testid="qc-recovery-changes">{tr("qc.recovery_changes")}</p>}
      {grant?.outcome === "process_failure" && <p className="text-xs text-warning" data-testid="qc-recovery-process">{tr("qc.recovery_process")}</p>}
      {view.historicalBatchId && (
        <p className="text-xs text-muted-foreground" data-testid="qc-recovery-batch">{tr("qc.recovery_batch_paused")}: {view.historicalBatchStatus ?? "—"}{view.historicalBatchPauseReason ? ` — ${view.historicalBatchPauseReason}` : ""}</p>
      )}
      {refresh?.blockedSummary && (
        <EvidenceRefresh
          refresh={refresh}
          grant={evidenceGrant}
          busy={busy}
          harnessId={harnessId}
          model={model}
          effort={effort}
          minutes={minutes}
          candidates={view.candidates}
          onHarness={setHarnessId}
          onModel={setModel}
          onEffort={setEffort}
          onMinutes={setMinutes}
          onPrepare={() => { void run(async () => { await api.prepareQcRecovery(taskId, { reviewerHarness: harnessId, reviewerModel: model.trim(), reviewerEffort: effort.trim() || undefined, validMinutes: minutes, purpose: "evidence-refresh" }); }); }}
          onApprove={(id) => { void run(() => api.approveQcRecovery(taskId, id)); }}
          onStart={(id) => { void run(() => api.startQcRecovery(taskId, id)); }}
          onCancel={(id) => { void run(() => api.cancelQcRecovery(taskId, id)); }}
          onAuthorize={() => { void run(async () => { await api.prepareReviewTest(taskId, { acknowledgeRisk: true, validMinutes: minutes, purpose: "evidence-refresh" }); }); }}
          onApproveTest={(id) => { void run(() => api.approveReviewTest(taskId, id)); }}
          onRunTest={(id) => { void run(() => api.executeReviewTest(taskId, id)); }}
          onCancelTest={(id) => { void run(() => api.cancelReviewTest(taskId, id)); }}
        />
      )}
      {error && <p className="text-xs text-destructive" data-testid="qc-recovery-error">{error}</p>}
    </section>}
    {showFirst && view.firstReview && (
      <FirstReviewEvidence
        review={view.firstReview}
        busy={busy}
        error={error}
        minutes={minutes}
        onMinutes={setMinutes}
        onAuthorize={() => { void run(async () => { await api.prepareReviewTest(taskId, { acknowledgeRisk: true, validMinutes: minutes, purpose: "first-review" }); }); }}
        onApproveTest={(id) => { void run(() => api.approveReviewTest(taskId, id)); }}
        onRunTest={(id) => { void run(() => api.executeReviewTest(taskId, id)); }}
        onCancelTest={(id) => { void run(() => api.cancelReviewTest(taskId, id)); }}
      />
    )}
    </>
  );
}

function FirstReviewEvidence({
  review,
  busy,
  error,
  minutes,
  onMinutes,
  onAuthorize,
  onApproveTest,
  onRunTest,
  onCancelTest,
}: {
  review: QcRecoveryView["firstReview"];
  busy: boolean;
  error: string | null;
  minutes: number;
  onMinutes: (value: number) => void;
  onAuthorize: () => void;
  onApproveTest: (id: string) => void;
  onRunTest: (id: string) => void;
  onCancelTest: (id: string) => void;
}) {
  const bundle = review.bundle;
  const testAuth = review.testAuthorization;
  const openTest = testAuth && (testAuth.status === "prepared" || testAuth.status === "approved") ? testAuth : null;
  const [acknowledged, setAcknowledged] = useState(false);
  return (
    <section className="space-y-2 rounded-md border border-border p-3" data-testid="qc-first-review-panel">
      <h4 className="text-xs font-semibold">{tr("qc.first_review_title")}</h4>
      {review.developerRunId && <p className="text-xs" data-testid="qc-first-review-run">{tr("qc.first_review_run")}: {review.developerRunId}</p>}
      <p className="text-xs" data-testid="qc-first-review-publication">{tr("qc.first_review_publication")}: {review.publicationStatus ?? "—"}</p>
      <p className="text-xs" data-testid="qc-first-review-status">{tr("qc.first_review_status")}: {bundle?.status ?? "unavailable"}</p>
      {review.blockers.map((item) => <p key={item} className="text-xs text-destructive" data-testid="qc-first-review-blocker">{item}</p>)}
      {bundle?.status === "complete" && <p className="text-xs" data-testid="qc-first-review-complete">{tr("qc.first_review_complete")}</p>}
      {bundle && <p className="max-h-24 overflow-auto whitespace-pre-wrap text-xs" data-testid="qc-first-review-requirements">{bundle.requirements}</p>}
      {bundle && <EvidenceFiles bundle={bundle} />}
      {review.eligible && bundle?.status === "preview" && bundle.proposedTest && !openTest && (
        <div className="space-y-2 text-xs" data-testid="qc-evidence-test-auth">
          <label className="flex items-start gap-2">
            <input type="checkbox" className="mt-0.5" checked={acknowledged} data-testid="qc-evidence-acknowledge" onChange={(e) => setAcknowledged(e.target.checked)} />
            <span>{tr("qc.evidence_acknowledge")}</span>
          </label>
          <p data-testid="qc-evidence-test-scope">{tr("qc.evidence_test_scope")}</p>
          <label className="flex flex-col gap-0.5">
            <span className="text-muted-foreground">{tr("qc.recovery_expiry")}</span>
            <input className="rounded border border-border bg-background px-2 py-1" type="number" min={5} max={240} value={minutes} data-testid="qc-first-review-minutes" onChange={(e) => onMinutes(Number(e.target.value))} />
          </label>
          <Button type="button" size="sm" disabled={busy || !acknowledged} data-testid="qc-evidence-authorize" onClick={onAuthorize}>{tr("qc.evidence_authorize")}</Button>
        </div>
      )}
      {testAuth && (
        <p className="text-xs" data-testid="qc-evidence-test-status">{testAuth.status}. {tr("qc.recovery_launches")}: {testAuth.maxInvocations}. {tr("qc.recovery_used")}: {testAuth.invocationsUsed}. {tr("qc.first_review_purpose")}: {testAuth.purpose}</p>
      )}
      {openTest && (
        <div className="space-y-1 text-xs" data-testid="qc-evidence-test-grant">
          {openTest.status === "prepared" && <Button type="button" size="sm" disabled={busy} data-testid="qc-evidence-approve-test" onClick={() => onApproveTest(openTest.id)}>{tr("qc.evidence_approve_test")}</Button>}
          {openTest.status === "approved" && <Button type="button" size="sm" disabled={busy} data-testid="qc-evidence-run-test" onClick={() => onRunTest(openTest.id)}>{tr("qc.evidence_run_test")}</Button>}
          <Button type="button" size="sm" variant="ghost" disabled={busy} data-testid="qc-evidence-cancel-test" onClick={() => onCancelTest(openTest.id)}>{tr("qc.evidence_cancel_test")}</Button>
        </div>
      )}
      {testAuth?.failureReason && <p className="text-xs text-destructive" data-testid="qc-evidence-test-failure">{testAuth.failureReason}</p>}
      <p className="text-xs text-muted-foreground" data-testid="qc-first-review-reviewer">{tr("qc.first_review_reviewer")}</p>
      {error && <p className="text-xs text-destructive" data-testid="qc-first-review-error">{error}</p>}
    </section>
  );
}

function EvidenceRefresh({
  refresh,
  grant,
  busy,
  harnessId,
  model,
  effort,
  minutes,
  candidates,
  onHarness,
  onModel,
  onEffort,
  onMinutes,
  onPrepare,
  onApprove,
  onStart,
  onCancel,
  onAuthorize,
  onApproveTest,
  onRunTest,
  onCancelTest,
}: {
  refresh: QcRecoveryView["evidenceRefresh"];
  grant: QcRecoveryGrant | null;
  busy: boolean;
  harnessId: string;
  model: string;
  effort: string;
  minutes: number;
  candidates: QcRecoveryView["candidates"];
  onHarness: (value: string) => void;
  onModel: (value: string) => void;
  onEffort: (value: string) => void;
  onMinutes: (value: number) => void;
  onPrepare: () => void;
  onApprove: (id: string) => void;
  onStart: (id: string) => void;
  onCancel: (id: string) => void;
  onAuthorize: () => void;
  onApproveTest: (id: string) => void;
  onRunTest: (id: string) => void;
  onCancelTest: (id: string) => void;
}) {
  const bundle = grant?.evidenceBundle ?? refresh.bundle;
  const selected = candidates.find((item) => item.harnessId === harnessId) ?? null;
  const testAuth = refresh.testAuthorization;
  const openTest = testAuth && (testAuth.status === "prepared" || testAuth.status === "approved") ? testAuth : null;
  const [acknowledged, setAcknowledged] = useState(false);
  return (
    <section className="space-y-2 rounded-md border border-border p-2" data-testid="qc-evidence-panel">
      <h5 className="text-xs font-semibold">{tr("qc.evidence_title")}</h5>
      <p className="text-xs text-warning" data-testid="qc-evidence-reason">{refresh.blockedSummary}</p>
      {refresh.bundleReason && <p className="text-xs text-destructive" data-testid="qc-evidence-blocker">{refresh.bundleReason}</p>}
      {bundle && <EvidenceFiles bundle={bundle} />}
      {bundle?.status === "preview" && bundle.proposedTest && !openTest && (
        <div className="space-y-2 text-xs" data-testid="qc-evidence-test-auth">
          <label className="flex items-start gap-2">
            <input type="checkbox" className="mt-0.5" checked={acknowledged} data-testid="qc-evidence-acknowledge" onChange={(e) => setAcknowledged(e.target.checked)} />
            <span>{tr("qc.evidence_acknowledge")}</span>
          </label>
          <p data-testid="qc-evidence-test-scope">{tr("qc.evidence_test_scope")}</p>
          <Button type="button" size="sm" disabled={busy || !acknowledged} data-testid="qc-evidence-authorize" onClick={onAuthorize}>{tr("qc.evidence_authorize")}</Button>
        </div>
      )}
      {testAuth && (
        <p className="text-xs" data-testid="qc-evidence-test-status">{testAuth.status}. {tr("qc.recovery_launches")}: {testAuth.maxInvocations}. {tr("qc.recovery_used")}: {testAuth.invocationsUsed}. {tr("qc.first_review_purpose")}: {testAuth.purpose}</p>
      )}
      {openTest && (
        <div className="space-y-1 text-xs" data-testid="qc-evidence-test-grant">
          {openTest.status === "prepared" && <Button type="button" size="sm" disabled={busy} data-testid="qc-evidence-approve-test" onClick={() => onApproveTest(openTest.id)}>{tr("qc.evidence_approve_test")}</Button>}
          {openTest.status === "approved" && <Button type="button" size="sm" disabled={busy} data-testid="qc-evidence-run-test" onClick={() => onRunTest(openTest.id)}>{tr("qc.evidence_run_test")}</Button>}
          <Button type="button" size="sm" variant="ghost" disabled={busy} data-testid="qc-evidence-cancel-test" onClick={() => onCancelTest(openTest.id)}>{tr("qc.evidence_cancel_test")}</Button>
        </div>
      )}
      {testAuth?.failureReason && <p className="text-xs text-destructive" data-testid="qc-evidence-test-failure">{testAuth.failureReason}</p>}
      {refresh.eligible && !grant && (
        <div className="space-y-2 text-xs" data-testid="qc-evidence-form">
          <label className="flex flex-col gap-0.5">
            <span className="text-muted-foreground">{tr("qc.recovery_harness")}</span>
            <select className="rounded border border-border bg-background px-2 py-1" value={harnessId} data-testid="qc-evidence-harness" onChange={(e) => onHarness(e.target.value)}>
              {candidates.filter((item) => !item.unavailableReason).map((item) => (
                <option key={item.harnessId} value={item.harnessId}>{item.label}{item.accountLabel ? ` · ${item.accountLabel}` : ""}</option>
              ))}
            </select>
          </label>
          <label className="flex flex-col gap-0.5">
            <span className="text-muted-foreground">{tr("qc.reviewer_model")}</span>
            <input className="rounded border border-border bg-background px-2 py-1" value={model} data-testid="qc-evidence-model" onChange={(e) => onModel(e.target.value)} />
          </label>
          <label className="flex flex-col gap-0.5">
            <span className="text-muted-foreground">{tr("qc.recovery_effort")}</span>
            <input className="rounded border border-border bg-background px-2 py-1" value={effort} data-testid="qc-evidence-effort" onChange={(e) => onEffort(e.target.value)} />
          </label>
          <label className="flex flex-col gap-0.5">
            <span className="text-muted-foreground">{tr("qc.recovery_expiry")}</span>
            <input className="rounded border border-border bg-background px-2 py-1" type="number" min={5} max={240} value={minutes} data-testid="qc-evidence-minutes" onChange={(e) => onMinutes(Number(e.target.value))} />
          </label>
          {selected && (
            <p data-testid="qc-evidence-preview">{tr("qc.recovery_mode")}: {selected.mode}. {tr("qc.recovery_sandbox")}: {selected.sandbox}. {selected.permission}</p>
          )}
          <p data-testid="qc-evidence-scope">{tr("qc.evidence_scope")}</p>
          <Button type="button" size="sm" disabled={busy || !harnessId || !model.trim()} data-testid="qc-evidence-prepare" onClick={onPrepare}>{tr("qc.evidence_prepare")}</Button>
        </div>
      )}
      {grant && (
        <div className="space-y-1 text-xs" data-testid="qc-evidence-grant">
          <p data-testid="qc-evidence-account">{tr("qc.recovery_account")}: {grant.reviewerAccountLabel ?? "—"}</p>
          <p data-testid="qc-evidence-model-frozen">{tr("qc.reviewer_model")}: {grant.reviewerModel}</p>
          <p data-testid="qc-evidence-mode">{tr("qc.recovery_mode")}: {grant.reviewerMode}. {tr("qc.recovery_sandbox")}: {grant.reviewerSandbox}</p>
          <p data-testid="qc-evidence-launches">{tr("qc.recovery_launches")}: {grant.maxLaunches}. {tr("qc.recovery_used")}: {grant.launchesUsed}</p>
        </div>
      )}
      {grant?.status === "prepared" && <Button type="button" size="sm" disabled={busy} data-testid="qc-evidence-approve" onClick={() => onApprove(grant.id)}>{tr("qc.evidence_approve")}</Button>}
      {grant?.status === "approved" && <Button type="button" size="sm" disabled={busy} data-testid="qc-evidence-start" onClick={() => onStart(grant.id)}>{tr("qc.evidence_start")}</Button>}
      {grant && <Button type="button" size="sm" variant="ghost" disabled={busy} data-testid="qc-evidence-cancel" onClick={() => onCancel(grant.id)}>{tr("qc.recovery_cancel")}</Button>}
    </section>
  );
}

function EvidenceFiles({ bundle }: { bundle: ReviewEvidenceBundle }) {
  const source = bundle.files.find((file) => file.role === "implementation");
  const testFile = bundle.files.find((file) => file.role === "test");
  const proposed = bundle.proposedTest;
  const bound = bundle.status === "complete" && bundle.test != null && bundle.test.sourceFingerprint === bundle.sourceFingerprint;
  return (
    <div className="space-y-1 text-xs">
      <p data-testid="qc-evidence-digest">{tr("qc.evidence_digest")}: {bundle.digest}</p>
      <p data-testid="qc-evidence-fingerprint">{tr("qc.evidence_fingerprint")}: {bundle.sourceFingerprint}</p>
      <p data-testid="qc-evidence-git-head">{tr("qc.evidence_git")}: {bundle.gitHead ?? "—"}</p>
      <p data-testid="qc-evidence-developer-run">{tr("qc.first_review_run")}: {bundle.developerRunId}</p>
      <p data-testid="qc-evidence-workspace">{tr("qc.evidence_workspace")}: {bundle.projectPath} · {bundle.workspacePath}</p>
      <p data-testid="qc-evidence-basis">{bundle.sourceBasis}{bundle.historicalLimitation ? ` — ${bundle.historicalLimitation}` : ""}</p>
      {bundle.status === "preview" && (
        <>
          <p className="text-warning" data-testid="qc-evidence-missing-test">{tr("qc.evidence_missing_test")}</p>
          <p data-testid="qc-evidence-not-ready">{tr("qc.evidence_not_ready")}</p>
        </>
      )}
      {bound && <p data-testid="qc-evidence-bound">{tr("qc.evidence_bound")}</p>}
      {bundle.rulesText && <pre className="max-h-24 overflow-auto whitespace-pre-wrap" data-testid="qc-evidence-rules">{bundle.rulesText}</pre>}
      {source && (
        <div>
          <p data-testid="qc-evidence-hash">{source.path} {source.sha256}</p>
          <pre className="max-h-40 overflow-auto whitespace-pre-wrap" data-testid="qc-evidence-source">{source.text}</pre>
        </div>
      )}
      {testFile && (
        <div>
          <p data-testid="qc-evidence-test-hash">{testFile.path} {testFile.sha256}</p>
          <pre className="max-h-40 overflow-auto whitespace-pre-wrap" data-testid="qc-evidence-test-source">{testFile.text}</pre>
        </div>
      )}
      {proposed && (
        <pre className="max-h-40 overflow-auto whitespace-pre-wrap" data-testid="qc-evidence-proposed-command">{tr("qc.evidence_proposed")}: {proposed.command}{"\n"}{tr("qc.evidence_executable")}: {proposed.executable}{"\n"}{tr("qc.evidence_argv")}: {JSON.stringify(proposed.argv)}{"\n"}{tr("qc.evidence_timeout")}: {tr("m0.qcMs", { value: proposed.timeoutMs })}{"\n"}{tr("qc.evidence_output_limit")}: {proposed.maxOutputBytes}{"\n"}<span data-testid="qc-evidence-isolation">{proposed.limitation}</span>{"\n"}<span data-testid="qc-evidence-permissions">{proposed.permissions}</span></pre>
      )}
      {bundle.test && (
        <pre className="max-h-40 overflow-auto whitespace-pre-wrap" data-testid="qc-evidence-test-output">{bundle.test.command}{"\n"}{tr("m0.qcTestRow", { exit: String(bundle.test.exitCode) })}{"\n"}{tr("m0.qcStarted", { at: String(bundle.test.startedAt) })}{"\n"}{tr("m0.qcEnded", { at: String(bundle.test.executedAt) })}{"\n"}{tr("m0.qcProvenance", { value: String(bundle.test.provenance) })}{"\n"}{bundle.test.limitation ?? ""}{"\n"}{bundle.test.stdout}{bundle.test.stderr}</pre>
      )}
      {bundle.omitted.length > 0 && (
        <ul data-testid="qc-evidence-omitted">
          {bundle.omitted.map((item) => <li key={item.path}>{item.path}: {item.reason}</li>)}
        </ul>
      )}
    </div>
  );
}

function GrantFacts({ grant }: { grant: QcRecoveryGrant }) {
  return (
    <div className="space-y-1 text-xs" data-testid="qc-recovery-grant">
      <p data-testid="qc-recovery-account">{tr("qc.recovery_account")}: {grant.reviewerAccountLabel ?? "—"}</p>
      <p data-testid="qc-recovery-model-frozen">{tr("qc.reviewer_model")}: {grant.reviewerModel}</p>
      <p data-testid="qc-recovery-mode">{tr("qc.recovery_mode")}: {grant.reviewerMode}. {tr("qc.recovery_sandbox")}: {grant.reviewerSandbox}</p>
      <p data-testid="qc-recovery-fingerprint">{tr("qc.recovery_fingerprint")}: {grant.resourceFingerprint}</p>
      <p data-testid="qc-recovery-launches">{tr("qc.recovery_launches")}: {grant.maxLaunches}. {tr("qc.recovery_used")}: {grant.launchesUsed}</p>
      <p data-testid="qc-recovery-expiry">{tr("qc.recovery_expiry")}: {grant.expiresAt ? new Date(grant.expiresAt).toISOString() : `${grant.validMinutes}m`}</p>
      <p data-testid="qc-recovery-quota">{tr("qc.recovery_quota")}: {tr("qc.recovery_unknown")}. {tr("qc.recovery_cost")}: {tr("qc.recovery_unknown")}.</p>
      <p data-testid="qc-recovery-scope">{tr("qc.recovery_scope")}</p>
      {grant.reviewRunId && <p data-testid="qc-recovery-new-run">{tr("qc.recovery_new_run")}: {grant.reviewRunId}</p>}
    </div>
  );
}
