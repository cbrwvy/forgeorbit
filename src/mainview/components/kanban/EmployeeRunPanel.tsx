import { TaskComputerReviewSummary } from "./TaskComputerWorkflow";
import { launchTargetNote, publishablePaths } from "../../../shared/execution/launch-target.ts";
import { RunExecutionDetails } from "./RunExecutionDetails";
import { PermissionDisclosureView } from "./PermissionDisclosure";
import { AccessModeDisclosure } from "./AccessModeDisclosure";
import { LaunchTarget } from "@/components/ui/launch-target";
import { I18nText, UsageNotice, useLocale as useUILocale } from "@/i18n/react";
import { QuotaFactNote } from "@/components/ui/quota-fact-note";
import { codeLabel, issueText, preflightLabel, staticLabel } from "@/i18n/presentation";

import { intlLocale, t as tr } from "@/i18n/core";

import { ProfessionalTurns } from "./ProfessionalTurns";
import { useEffect, useId, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { X } from "lucide-react";
import { ApiError, api } from "@/lib/api";
import { Button } from "@/components/ui/button";
import { Dialog } from "@/components/ui/dialog";
import {
  PHASE_TONE,
  accessText,
  accountStateLabel,
  actualText,
  antigravityAutoAcceptsFileEdits,
  buildStartBody,
  canConfirm,
  phaseLabel,
} from "@/lib/employee-execution";
import { type EmployeeRunView } from "../../../shared/execution/run.ts";

function messageOf(reason: unknown): string {
  if (reason instanceof ApiError || reason instanceof Error) return reason.message;
  return tr("common.the_request_could_not_be_completed");
}

const time = (value: number | null) => (value == null ? "—" : new Date(value).toLocaleString(intlLocale()));

function Row({ label, children, testId }: { label: string; children: React.ReactNode; testId?: string }) {
  useUILocale();
  return (
    <>
      <dt className="text-muted-foreground">{label}</dt>
      <dd className="min-w-0 break-words" data-testid={testId}>{children}</dd>
    </>
  );
}

export function PhaseChip({ attempt }: { attempt: Pick<EmployeeRunView, "phase"> }) {
  useUILocale();
  return (
    <span
      className={`inline-block rounded px-1.5 py-0.5 text-[10px] font-medium ${PHASE_TONE[attempt.phase]}`}
      data-testid="employee-run-phase"
      data-phase={attempt.phase}
    >
      {phaseLabel(attempt.phase)}
    </span>
  );
}

/** Render only the historical snapshot, never the employee's current profile. */
export function ProfessionalAttribution({ attempt }: { attempt: EmployeeRunView }) {
  useUILocale();
  const professional = attempt.professional;
  if (!professional) return <p className="text-muted-foreground" data-testid="professional-attribution"><I18nText id="execution.professional_runtime_attribution_unknown_historical_attempt" /></p>;
  if (professional.binding.kind === "legacy") return <p className="text-muted-foreground" data-testid="professional-attribution"><I18nText id="execution.no_professional_profile_at_review_legacy_execution" /></p>;
  const b = professional.binding;
  return (
    <details className="my-2 rounded-md border border-border/70 px-2 py-1.5 text-[11px]" data-testid="professional-attribution" data-revision={b.revision}>
      <summary className="cursor-pointer break-words">{b.professionalTitle}{" "}<I18nText id="execution.prompt_revision" />{" "}{b.revision}{" "}<I18nText id="execution.runtime" />{" "}{codeLabel(professional.payloadStatus)}</summary>
      <dl className="mt-2 grid grid-cols-1 gap-1 sm:grid-cols-[9rem_minmax(0,1fr)]">
        <Row label={tr("execution.catalog_role")}>{b.catalogRoleSlug}</Row>
        <Row label={tr("execution.employee_uuid")}>{b.employeeId}</Row>
        <Row label={tr("execution.profile_revision")}>{b.revision} · {b.revisionId}</Row>
        <Row label={tr("execution.prompt_sha_256")}><code className="break-all">{b.promptSha256}</code></Row>
        <Row label={tr("execution.original_template_sha")}><code className="break-all">{b.originalTemplateSha256}</code></Row>
        <Row label={tr("execution.bound_at")}>{time(b.boundAt)}</Row>
        <Row label={tr("execution.runtime_payload")}>{codeLabel(professional.payloadStatus)} · {time(professional.payloadAt)}</Row>
        <Row label={tr("common.payload_sha_256")}><code className="break-all">{professional.payloadSha256 ?? tr("common.not_constructed")}</code></Row>
      </dl>
      <p className="mt-2 text-muted-foreground"><I18nText id="execution.profile_edits_require_a_new_review_before_start" /></p>
      <pre className="mt-2 max-h-60 overflow-auto whitespace-pre-wrap break-words rounded bg-muted/40 p-2" data-testid="professional-historical-prompt">{b.promptMarkdown}</pre>
    </details>
  );
}

/**
 * The exact run the owner is about to start. Nothing starts until the
 * Confirm button; closing or cancelling withdraws the review. The server
 * re-reads every fact when Confirm is pressed, so this view is a summary of
 * the moment of review, not a promise.
 */
export function EmployeeRunReviewDialog({
  attempt,
  onClose,
  onStarted,
  returnFocusRef,
}: {
  attempt: EmployeeRunView;
  onClose: () => void;
  onStarted: (attempt: EmployeeRunView) => void;
  returnFocusRef?: React.RefObject<HTMLButtonElement | null>;
}) {
  useUILocale();
  const titleId = useId();
  const cancelRef = useRef<HTMLButtonElement>(null);
  const [current, setCurrent] = useState(attempt);
  const [ack, setAck] = useState({ usage: false, unconfirmed: false, fullAccess: false });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [now, setNow] = useState(Date.now);
  const settled = useRef(false);

  useEffect(() => {
    const wait = Math.max(0, attempt.expiresAt - Date.now());
    const timer = setInterval(() => setNow(Date.now()), Math.min(1000, wait + 1));
    return () => clearInterval(timer);
  }, [attempt.expiresAt]);

  const expired = now >= current.expiresAt;
  const confirmable = !busy && canConfirm(current, ack, now);
  const facts = current.review;
  const target = launchTargetNote(facts);
  const publishPaths = publishablePaths(facts);
  const requested = current.requested;

  const withdraw = () => {
    if (busy) return;
    if (!settled.current && current.status === "awaiting-approval") {
      settled.current = true;
      void api.employeeExecutionCancel(current.id, current.revision).catch(() => undefined);
    }
    onClose();
  };

  const confirm = () => {
    if (!confirmable) return;
    setBusy(true);
    setError(null);
    void api.employeeExecutionStart(current.id, buildStartBody(current, ack)).then((response) => {
      settled.current = true;
      onStarted(response.attempt);
    }).catch((caught: unknown) => {
      setBusy(false);
      if (caught instanceof ApiError) {
        const body = caught.body as { attempt?: EmployeeRunView } | null;
        if (body?.attempt) setCurrent(body.attempt);
        setError(caught.message);
        return;
      }
      // No answer at all: the start may have happened. Look before suggesting a retry.
      setError(tr("common.the_connection_dropped_the_run_may_have_started"));
      void api.employeeExecutionAttempt(current.id).then((r) => {
        if (r.attempt.status !== "awaiting-approval") {
          settled.current = true;
          onStarted(r.attempt);
        }
      }).catch(() => undefined);
    });
  };

  return createPortal(
    <Dialog open onClose={withdraw} labelledBy={titleId} initialFocusRef={cancelRef} returnFocusRef={returnFocusRef} className="flex max-h-[88vh] w-full max-w-2xl flex-col p-0">
      <div data-testid="employee-run-dialog" className="flex min-h-0 flex-1 flex-col">
        <header className="flex items-start justify-between gap-3 border-b border-border/60 p-3">
          <div className="min-w-0">
            <h2 id={titleId} className="text-sm font-semibold"><I18nText id="execution.review_and_confirm_run" /></h2>
            <p className="mt-1 text-[11px] text-muted-foreground" data-testid="employee-run-banner">{tr("execution.reviewBanner")}</p>
          </div>
          <Button variant="ghost" size="icon" onClick={withdraw} aria-label={tr("execution.close_and_withdraw_this_review")}><X className="size-4" /></Button>
        </header>

        <div className="min-h-0 flex-1 overflow-y-auto p-3 text-xs">
          <p className="mb-3 text-sm">{tr("manager.approval")}</p>
          <p className="mb-3 font-medium">{current.taskTitle} · {current.employee.name}</p>
          {facts.computerWorkflow && <TaskComputerReviewSummary review={facts.computerWorkflow} />}
          <details data-testid="employee-run-details">
            <summary className="cursor-pointer text-muted-foreground">{tr("manager.details")}</summary>
          <dl className="grid grid-cols-1 gap-x-3 gap-y-1.5 sm:grid-cols-[9rem_minmax(0,1fr)]">
            <Row label={tr("common.task_4bc74b")} testId="employee-run-task">{current.taskTitle}</Row>
            <Row label={tr("common.project_985959")} testId="employee-run-project"><span className="break-all">{current.projectPath}</span></Row>
            <Row label={tr("execution.assigned_worker")} testId="employee-run-worker">{current.employee.name}</Row>
            <Row label={tr("common.assignment_revision")} testId="employee-run-revision">{current.assignment.revision}</Row>
            <Row label={tr("common.harness")} testId="employee-run-harness">{facts.harnessLabel} <span className="text-muted-foreground">({requested.harnessId})</span></Row>
            <Row label={tr("execution.requested_model")} testId="employee-run-model">{facts.modelLabel}</Row>
            <Row label={tr("execution.requested_effort")}>{requested.effort ?? tr("common.harness_default")}</Row>
            <Row label={tr("common.permissions")} testId="employee-run-permissions">
              <span className="font-medium">{staticLabel(facts.modeLabel)}</span>
              {" — "}
              {facts.permission
                ? <PermissionDisclosureView disclosure={facts.permission} />
                : antigravityAutoAcceptsFileEdits(requested.harnessId, requested.mode)
                  ? tr("models.auto_accept_file_edits_ask_before_executing_commands")
                  : accessText(facts.accessLevel)}
            </Row>
            {facts.launchTarget && <div className="sm:col-span-2"><LaunchTarget facts={facts.launchTarget} testId="employee-run-launch-target" /></div>}
            {facts.accessDiagnostics && <div className="sm:col-span-2"><AccessModeDisclosure diagnostics={facts.accessDiagnostics} testId="employee-run-access-diagnostics" compact /></div>}
            <Row label={tr("common.workspace")}><span className="break-all">{facts.workspace}</span></Row>
            <Row label={tr("tasks.isolation")} testId="employee-run-isolation">
              {target?.valueId ? tr(target.valueId) : (facts.isolation ?? tr("common.unknown"))}
              {target && <span className={target.tone === "warning" ? "block text-warning" : "block text-muted-foreground"} data-testid="employee-run-target" data-target={facts.workspaceKind}>{tr(target.noteId)}</span>}
            </Row>
            {(facts.workingCopyWriteScope === "working-copy" || facts.workspaceDevelopment) && (
              <Row label={tr("execution.working_copy_scope")} testId="employee-run-working-copy-scope">
                <span>{tr("execution.working_copy_scope_value")}</span>
                {facts.workingCopyScratchPath && (
                  <span className="mt-1 block break-all font-mono text-[11px] text-muted-foreground">
                    {tr("execution.working_copy_scratch")}: {facts.workingCopyScratchPath}
                  </span>
                )}
              </Row>
            )}
            {publishPaths.length > 0 && (
              <Row label={tr("execution.publish_paths")} testId="employee-run-publish-paths">
                <span className="break-all font-mono">{publishPaths.join(", ")}</span>
                <span className="block text-muted-foreground">{tr("execution.publish_paths_note")}</span>
              </Row>
            )}
            <Row label={tr("common.account")} testId="employee-run-account"><span className="font-medium">{accountStateLabel(facts.account.state as never)}.</span> <span title={facts.account.label}>{preflightLabel("account", facts.account.state, facts.account.label)}</span></Row>
            <Row label={tr("execution.quota")} testId="employee-run-quota"><span title={facts.quota.label}>{preflightLabel("quota", facts.quota.state, facts.quota.label)}</span><QuotaFactNote facts={facts.quota.facts} testId="employee-run-quota-facts" /></Row>
            <Row label={tr("execution.model_capability")}><span title={facts.model.label}>{preflightLabel("model", facts.model.state, facts.model.label)}</span></Row>
            <Row label={tr("execution.owner_restrictions")} testId="employee-run-owner"><I18nText id="execution.spending" />{" "}{facts.ownerRestrictions.spending ?? tr("common.unknown")}.{" "}
              {facts.ownerRestrictions.allowedHarnesses ? tr("common.allowed_harnesses_b45d9e", { p0: String(facts.ownerRestrictions.allowedHarnesses.join(", ") || tr("common.none")) }) : tr("common.no_harness_restriction_recorded")}
            </Row>
          </dl>

          <ProfessionalAttribution attempt={current} />

          <p className="mt-3 rounded-md border border-warning/50 bg-warning/10 px-2 py-1.5 text-warning" data-testid="employee-run-unverified"><I18nText id="execution.resources_are_not_verified_the_account_remaining_quota" />{" "}</p>

          {facts.warnings.length > 0 && (
            <section className="mt-3 rounded-md border border-border/70 px-2 py-1.5" data-testid="employee-run-warnings">
              <h3 className="text-[10px] uppercase tracking-wide text-warning"><I18nText id="common.warnings" /></h3>
              <ul className="mt-1 flex flex-col gap-1">
                {facts.warnings.map((w) => <li key={w.code + w.message} className="break-words">{issueText(w)}<small className="block text-muted-foreground">{w.code}: {w.message}</small></li>)}
              </ul>
            </section>
          )}
          {facts.checks.filter((c) => c.level !== "info").length > 0 && (
            <section className="mt-3 rounded-md border border-border/70 px-2 py-1.5" data-testid="employee-run-checks">
              <h3 className="text-[10px] uppercase tracking-wide text-muted-foreground"><I18nText id="common.checks" /></h3>
              <ul className="mt-1 flex flex-col gap-1">
                {facts.checks.filter((c) => c.level !== "info").map((c) => <li key={c.code + c.message} className="break-words">{issueText(c)}<small className="block text-muted-foreground">{c.code}: {c.message}</small></li>)}
              </ul>
            </section>
          )}

          </details>
          {current.usageNotice && (
            <label className="mt-3 flex items-start gap-2" data-testid="employee-run-usage">
              <input type="checkbox" className="mt-0.5" checked={ack.usage} onChange={(e) => setAck((a) => ({ ...a, usage: e.target.checked }))} />
              <span><UsageNotice text={current.usageNotice} />{" "}<I18nText id="execution.i_understand_and_accept_this" /></span>
            </label>
          )}
          {facts.permission?.sandbox === "danger-full-access" && (
            <label className="mt-3 flex items-start gap-2 text-warning" data-testid="employee-run-full-access">
              <input type="checkbox" checked={ack.fullAccess} onChange={(e) => setAck((a) => ({ ...a, fullAccess: e.target.checked }))} />
              <span>{tr("permission.full-access-consent")}</span>
            </label>
          )}
          {current.requiresUnconfirmedAck && (
            <label className="mt-3 flex items-start gap-2" data-testid="employee-run-unconfirmed">
              <input type="checkbox" className="mt-0.5" checked={ack.unconfirmed} onChange={(e) => setAck((a) => ({ ...a, unconfirmed: e.target.checked }))} />
              <span><I18nText id="execution.an_earlier_process_has_an_unconfirmed_outcome_acknowledging" /></span>
            </label>
          )}

          <div role="status" aria-live="polite" className="mt-3">
            {expired && <p className="text-warning" data-testid="employee-run-expired"><I18nText id="execution.this_review_expired_close_it_and_review_again" /></p>}
            {busy && <p data-testid="employee-run-starting"><I18nText id="common.starting" /></p>}
            {error && <p className="text-danger" data-testid="employee-run-error">{error}</p>}
            {!expired && !busy && !error && current.status !== "awaiting-approval" && (
              <p className="text-warning" data-testid="employee-run-closed"><I18nText id="execution.this_review_is" />{" "}{phaseLabel(current.phase).toLowerCase()}<I18nText id="execution.close_it_and_review_again" /></p>
            )}
          </div>
        </div>

        <footer className="flex flex-wrap items-center justify-end gap-2 border-t border-border/60 p-3">
          <Button ref={cancelRef} type="button" variant="outline" size="sm" data-testid="employee-run-cancel" disabled={busy} onClick={withdraw}><I18nText id="execution.cancel_start_nothing" />{" "}</Button>
          <Button type="button" size="sm" data-testid="employee-run-confirm" disabled={!confirmable} onClick={confirm}>
            {busy ? tr("common.starting") : tr("common.confirm_and_start")}
          </Button>
        </footer>
      </div>
    </Dialog>,
    document.body,
  );
}

/** What happened to one attempt, with the link into the existing run history. */
export function EmployeeRunStatus({ attempt, testId = "employee-run-status", onUpdated, onOpenRuns }: { attempt: EmployeeRunView; testId?: string; onUpdated?: (attempt: EmployeeRunView) => void; onOpenRuns?: () => void }) {
  useUILocale();
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const request = useRef<AbortController | null>(null);
  useEffect(() => () => request.current?.abort(), [attempt.id]);
  const reconcile = () => {
    if (busy) return;
    const controller = new AbortController();
    request.current = controller;
    setBusy(true);
    setMessage(null);
    void api.employeeExecutionReconcile(attempt.id, controller.signal).then((response) => {
      if (controller.signal.aborted) return;
      onUpdated?.(response.attempt);
      setMessage(response.outcome === "indeterminate" ? tr("common.reconciled_the_outcome_remains_unknown_another_employee_launch") : tr("common.reconciled_with_the_confirmed_runtime_state"));
    }).catch((error) => { if (!controller.signal.aborted) setMessage(messageOf(error)); })
      .finally(() => { if (!controller.signal.aborted) setBusy(false); });
  };
  const openRuns = () => {
    if (onOpenRuns) { onOpenRuns(); return; }
    document.querySelector('[data-testid="runs-list"]')?.scrollIntoView({ block: "nearest", behavior: "smooth" });
  };
  return (
    <section className="rounded-md border border-border/70 px-2 py-1.5 text-[11px]" data-testid={testId} data-attempt={attempt.id} data-status={attempt.status}>
      <div className="flex flex-wrap items-center gap-2">
        <PhaseChip attempt={attempt} />
        <span className="text-muted-foreground">{attempt.employee.name}{" "}<I18nText id="execution.assignment_revision" />{" "}{attempt.assignment.revision}</span>
      </div>
      <dl className="mt-1 grid grid-cols-1 gap-1 sm:grid-cols-[9rem_minmax(0,1fr)]">
        <Row label={tr("execution.requested")}>
          {attempt.requested.harnessId} · {attempt.requested.model ?? tr("common.default_model")}{attempt.requested.effort ? ` · ${attempt.requested.effort}` : ""}{" "}<I18nText id="execution.mode" />{" "}{staticLabel(attempt.review.modeLabel)}
          {antigravityAutoAcceptsFileEdits(attempt.requested.harnessId, attempt.requested.mode) && (
            <span className="mt-1 block text-muted-foreground" data-testid="employee-run-antigravity-edits">{tr("models.auto_accept_file_edits_ask_before_executing_commands")}</span>
          )}
        </Row>
        <Row label={tr("execution.confirmed_by_runtime")} testId="employee-run-actual"><I18nText id="common.harness_49f756" />{" "}{actualText(attempt.actual.harnessId)}{" "}<I18nText id="execution.model" />{" "}{actualText(attempt.actual.model)}{" "}<I18nText id="execution.account" />{" "}{actualText(attempt.actual.accountId)}
        </Row>
        <Row label="Run ID">{attempt.runId ?? tr("common.unknown")}</Row>
        <Row label={tr("execution.owner_approval_provenance")}>{attempt.provenance.approval} · {attempt.id}</Row>
        <Row label={tr("common.confirmed_by_you")}>{attempt.provenance.approval === "owner" ? time(attempt.approvedAt) : tr("common.no")}</Row>
        <Row label={tr("common.started")}>{time(attempt.startedAt)}</Row>
        <Row label={tr("common.finished")}>{time(attempt.finishedAt)}</Row>
        {attempt.reason && <Row label={tr("execution.outcome")} testId="employee-run-reason">{attempt.reason}</Row>}
      </dl>
      <ProfessionalAttribution attempt={attempt} />
      <RunExecutionDetails runId={attempt.runId} />
      {attempt.runId && attempt.professional?.binding.kind === "professional" && (
        <ProfessionalTurns
          key={attempt.runId}
          runId={attempt.runId}
          harnessId={attempt.requested.harnessId}
          modeLabel={attempt.review.modeLabel}
        />
      )}
      {attempt.phase === "unknown-outcome" && (
        <div className="mt-2 flex flex-col items-start gap-2">
          <p role="alert" className="text-warning" data-testid="employee-run-process-unknown"><I18nText id="execution.process_fate_unknown_a_run_record_or_an" /></p>
          <Button type="button" size="sm" variant="outline" data-testid="employee-run-reconcile" disabled={busy} onClick={reconcile}>{busy ? tr("common.reconciling") : tr("common.reconcile_status")}</Button>
        </div>
      )}
      {message && <p role="status" aria-live="polite" className="mt-2" data-testid="employee-run-reconcile-result">{message}</p>}
      {attempt.runId && (
        <button type="button" className="mt-1 text-info underline-offset-2 hover:underline" data-testid="employee-run-open-runs" onClick={openRuns}><I18nText id="execution.open_run_history" />{" "}</button>
      )}
    </section>
  );
}

/** Earlier attempts for this task, newest first. */
export function EmployeeRunHistory({ attempts, currentId }: { attempts: EmployeeRunView[]; currentId: string | null }) {
  useUILocale();
  const older = attempts.filter((a) => a.id !== currentId);
  if (older.length === 0) return null;
  return (
    <details className="rounded-md border border-border/70 px-2 py-1.5 text-[11px]" data-testid="employee-run-history">
      <summary className="cursor-pointer text-[10px] uppercase tracking-wide text-muted-foreground"><I18nText id="execution.execution_history" />{older.length})</summary>
      <ul className="mt-1 flex flex-col gap-1">
        {older.map((a) => (
          <li key={a.id} data-attempt={a.id} data-phase={a.phase} className="break-words">
            <span className="font-medium">{phaseLabel(a.phase)}</span> · {a.employee.name}{" "}<I18nText id="common.revision" />{" "}{a.assignment.revision} · {a.requested.harnessId} · {time(a.createdAt)}
            <ProfessionalAttribution attempt={a} />
          </li>
        ))}
      </ul>
    </details>
  );
}
