import { QuotaFactNote } from "@/components/ui/quota-fact-note";
import { ProviderRefusalNotice } from "@/components/ui/provider-refusal-notice";
import { requestOpenAccounts } from "@/lib/open-accounts";
import { codeLabel, evidenceLabel, issueText, preflightLabel, staticLabel } from "@/i18n/presentation";

import { intlLocale, t as tr } from "@/i18n/core";

import { I18nText, useLocale as useUILocale } from "@/i18n/react";
import { useEffect, useId, useMemo, useRef, useState, type ReactNode } from "react";
import { ApiError, api } from "@/lib/api";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select } from "@/components/ui/select";
import { presentAssignment, type EmployeeRecommendation } from "@/lib/model-router-preview";
import { createPreviewSession } from "@/lib/model-router-api";
import {
  EMPTY_EXECUTION_DRAFT,
  EVIDENCE_TONE,
  accountStateLabel,
  buildPreflightBody,
  canOfferRun,
  executionInputKey,
  isPreflightStale,
  outcomeLabel,
  reviewedRevisionOf,
  type ExecutionDraft,
} from "@/lib/employee-execution";
import { type EvidenceState, type PreflightResult } from "../../../shared/execution/preflight.ts";
import type { EmployeeRunView } from "../../../shared/execution/run.ts";
import { watchEmployeeExecutions } from "@/lib/employee-execution-poll";
import { ExecutorSuggestions } from "./ExecutorSuggestions";
import { AccessModeDisclosure } from "./AccessModeDisclosure";
import { EmployeeRunHistory, EmployeeRunReviewDialog, EmployeeRunStatus } from "./EmployeeRunPanel";
import type { Task } from "../../../shared/types.ts";

function messageOf(reason: unknown): string {
  if (reason instanceof ApiError || reason instanceof Error) return reason.message;
  return tr("common.the_preflight_could_not_be_prepared");
}

function Field({ label, children }: { label: string; children: ReactNode }) {
  useUILocale();
  return (
    <label className="flex min-w-0 flex-col gap-1 text-[length:var(--text-caption)]">
      <span className="text-muted-foreground">{label}</span>
      {children}
    </label>
  );
}

function Chip({ state }: { state: EvidenceState }) {
  useUILocale();
  return (
    <span className={`inline-block rounded px-1.5 py-0.5 text-[length:var(--text-caption)] font-medium ${EVIDENCE_TONE[state]}`} data-testid="employee-execution-evidence" data-state={state}>
      {evidenceLabel(state)}
    </span>
  );
}

function IssueList({ title, items, tone, testId }: { title: string; items: { code: string; message: string }[]; tone: string; testId: string }) {
  useUILocale();
  if (items.length === 0) return null;
  return (
    <section data-testid={testId} className="rounded-md border border-border/70 px-2 py-1.5">
      <h3 className={`text-xs uppercase tracking-wide ${tone}`}>{title}</h3>
      <ul className="mt-1 flex flex-col gap-1 text-[length:var(--text-caption)]">
        {items.map((item) => (
          <li key={item.code + item.message} data-code={item.code} className="break-words">{issueText(item)}<small className="block break-words text-muted-foreground" data-testid="issue-diagnostic">{item.code}: {item.message}</small></li>
        ))}
      </ul>
    </section>
  );
}

/**
 * Employee Execution (FO-010E1 preflight, FO-010E2 supervised start).
 *
 * Preflight reads current server state and describes a possible future run:
 * it starts nothing and is not permission. "Run Employee" only opens a review
 * of that exact run; the task starts solely when the owner presses Confirm in
 * the review, and the server re-checks everything at that moment.
 */
export function EmployeeExecution({ task, harnesses }: { task: Task; harnesses: readonly { id: string; label: string }[] }) {
  const runTriggerRef = useRef<HTMLButtonElement>(null);
  const { locale: uiLocale } = useUILocale();
  const ids = useId();
  const session = useRef(createPreviewSession());
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState<ExecutionDraft>(EMPTY_EXECUTION_DRAFT);
  const [employee, setEmployee] = useState<EmployeeRecommendation>({ status: "loading", note: tr("common.loading_assignment") });
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [shown, setShown] = useState<{ result: PreflightResult; key: string } | null>(null);
  const [now, setNow] = useState(Date.now);
  const [attempts, setAttempts] = useState<EmployeeRunView[]>([]);
  const [review, setReview] = useState<EmployeeRunView | null>(null);
  const [reviewing, setReviewing] = useState(false);

  const blocked = task.pipelineParentId != null;
  const currentKey = useMemo(() => executionInputKey(task, draft), [task.id, task.column, task.updatedAt, task.archivedAt, task.ownerProjectPath, task.agent, draft, uiLocale]);
  const stale = isPreflightStale(shown ? { key: shown.key, validUntil: shown.result.validUntil } : null, currentKey, now);

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    setEmployee({ status: "loading", note: tr("common.loading_assignment") });
    void api.getTaskAssignment(task.id).then(async (body) => {
      if (cancelled) return;
      if (!body.assignment) {
        setEmployee(presentAssignment(null, null));
        return;
      }
      const assignment = { employeeName: body.assignment.employeeName, revision: body.assignment.revision };
      try {
        const person = await api.getEmployee(body.assignment.employeeId);
        if (!cancelled) setEmployee(presentAssignment(assignment, person));
      } catch {
        if (!cancelled) setEmployee(presentAssignment(assignment, "error"));
      }
    }).catch(() => {
      if (!cancelled) setEmployee(presentAssignment("error", null));
    });
    return () => { cancelled = true; };
  }, [open, task.id, task.updatedAt]);

  // Attempts for this task: loaded when the section opens, refreshed with the board's own task polling,
  // and followed every 2 s only while a run is starting or running.
  const latest = attempts[0] ?? null;
  const latestPhase = latest?.phase;
  useEffect(() => {
    if (!open) return;
    return watchEmployeeExecutions(
      (signal) => api.employeeExecutionAttempts({ taskId: task.id }, signal),
      setAttempts,
    );
  }, [open, task.id, task.updatedAt, task.column, latestPhase]);

  const openReview = () => {
    if (!canRun || reviewing) return;
    const run = session.current.begin();
    setReviewing(true);
    setError(null);
    const body = buildPreflightBody(task.id, draft, reviewedRevisionOf(shown?.result ?? null));
    void api.employeeExecutionReview(body, run.signal).then((response) => {
      if (!run.isCurrent()) return;
      setReviewing(false);
      if (response.attempt) {
        setReview(response.attempt);
        return;
      }
      // Something changed since the preflight: show what the server found instead.
      setShown({ result: { ...response.preflight, blockingErrors: response.blockingErrors, outcome: "blocked" }, key: currentKey });
      setNow(Date.now());
    }).catch((caught: unknown) => {
      if (!run.isCurrent()) return;
      setReviewing(false);
      setError(messageOf(caught));
    });
  };

  const closeReview = () => {
    setReview(null);
    void api.employeeExecutionAttempts({ taskId: task.id }).then((response) => setAttempts(response.attempts)).catch(() => undefined);
  };

  // Re-evaluate staleness at the result's own deadline.
  useEffect(() => {
    if (!shown) return;
    const wait = shown.result.validUntil - Date.now();
    setNow(Date.now());
    if (wait <= 0) return;
    const timer = setTimeout(() => setNow(Date.now()), Math.min(2_147_483_647, wait + 1));
    return () => clearTimeout(timer);
  }, [shown]);

  useEffect(() => {
    const current = session.current;
    return () => current.invalidate();
  }, [task.id]);

  const patch = (partial: Partial<ExecutionDraft>) => {
    // Any change to the inputs replaces what the owner is looking at.
    session.current.invalidate();
    setLoading(false);
    setError(null);
    setDraft((current) => ({ ...current, ...partial }));
  };

  const prepare = () => {
    if (blocked) return;
    const run = session.current.begin();
    setLoading(true);
    setError(null);
    const body = buildPreflightBody(task.id, draft, reviewedRevisionOf(shown?.result ?? null));
    const key = currentKey;
    void api.employeeExecutionPreflight(body, run.signal).then((response) => {
      if (!run.isCurrent()) return;
      if (response.preflight.taskId !== task.id) throw new Error(tr("common.the_preflight_does_not_match_the_selected_task"));
      const fresh = response.preflight;
      setShown({ result: fresh, key });
      // The server's answer is the current truth about the worker; keep the card above in step with it.
      setEmployee((previous) => {
        const note = "note" in previous ? previous.note : "";
        if (fresh.employee && fresh.assignment) {
          return { status: "assigned", name: fresh.employee.name, role: fresh.employee.jobTitle, project: fresh.canonicalProject?.name ?? tr("common.unknown"), revision: fresh.assignment.revision, note };
        }
        return { status: "unassigned", note: tr("common.no_employee_is_assigned_to_this_task_e66a43") };
      });
      setNow(Date.now());
      setLoading(false);
    }).catch((caught: unknown) => {
      if (!run.isCurrent()) return;
      setError(messageOf(caught));
      setLoading(false);
    });
  };

  const result = shown?.result ?? null;
  const canRun = canOfferRun(result, stale);
  const optionState = (id: string) => result?.harnessOptions.find((option) => option.harnessId === id)?.evidence ?? null;

  return (
    <details
      className="surface-solid mx-3 my-2 rounded-lg border px-3 py-2 text-xs"
      data-testid="employee-execution"
      onToggle={(event) => {
        const expanded = (event.currentTarget as HTMLDetailsElement).open;
        setOpen(expanded);
        if (!expanded) {
          session.current.invalidate();
          setLoading(false);
        }
      }}
    >
      <summary className="cursor-pointer text-xs uppercase tracking-wide text-muted-foreground"><I18nText id="execution.employee_execution" /></summary>
      <div className="mt-2 flex min-w-0 flex-col gap-3" data-testid="employee-execution-scroll">
        <p className="rounded-md border border-border/70 px-2 py-1.5 text-[length:var(--text-caption)] font-medium" data-testid="employee-execution-banner">{tr("execution.preflightBanner")}</p>
        <p className="text-[length:var(--text-caption)] text-muted-foreground"><I18nText id="execution.a_preflight_reads_current_state_and_describes_a" />{" "}</p>

        <section data-testid="employee-execution-worker" className="rounded-md border border-border/70 px-2 py-1.5 text-[length:var(--text-caption)]">
          <h3 className="text-xs uppercase tracking-wide text-muted-foreground"><I18nText id="execution.assigned_worker" /></h3>
          {(employee.status === "loading" || employee.status === "unknown" || employee.status === "unassigned") && <p>{employee.note}</p>}
          {employee.status === "unassigned" && <p className="text-muted-foreground"><I18nText id="execution.assign_a_worker_from_the_company_staff_page" /></p>}
          {employee.status === "assigned" && (
            <dl className="mt-1 grid grid-cols-1 gap-1 sm:grid-cols-[8rem_minmax(0,1fr)]">
              <dt className="text-muted-foreground"><I18nText id="common.worker" /></dt><dd className="break-words" data-testid="employee-execution-worker-name">{employee.name}</dd>
              <dt className="text-muted-foreground"><I18nText id="common.role" /></dt><dd className="break-words">{employee.role}</dd>
              <dt className="text-muted-foreground"><I18nText id="common.assignment_revision" /></dt><dd data-testid="employee-execution-revision">{employee.revision}</dd>
              <dt className="text-muted-foreground"><I18nText id="common.task_4bc74b" /></dt><dd className="break-words">{task.title}</dd>
              <dt className="text-muted-foreground"><I18nText id="common.project_985959" /></dt><dd className="break-all">{result?.canonicalProject?.path ?? task.ownerProjectPath ?? tr("common.unknown")}</dd>
            </dl>
          )}
        </section>

        {blocked ? (
          <p><I18nText id="execution.pipeline_steps_are_prepared_through_their_pipeline_task" /></p>
        ) : (
          <>
            <div className="grid grid-cols-1 gap-2 md:grid-cols-2">
              <Field label={tr("common.harness")}>
                <Select
                  id={`${ids}-harness`}
                  className="h-8 text-xs"
                  data-testid="employee-execution-harness"
                  value={draft.harnessId}
                  onChange={(event) => patch({ harnessId: event.target.value })}
                >
                  <option value=""><I18nText id="execution.review_only_no_harness_chosen" /></option>
                  {harnesses.map((harness) => {
                    const state = optionState(harness.id);
                    return <option key={harness.id} value={harness.id}>{harness.label}{state ? ` · ${evidenceLabel(state)}` : ""}</option>;
                  })}
                </Select>
              </Field>
              <Field label={tr("execution.model_optional")}>
                <Input className="h-8 text-xs" data-testid="employee-execution-model" value={draft.model} onChange={(event) => patch({ model: event.target.value })} placeholder={tr("common.not_requested")} />
              </Field>
              <Field label={tr("execution.effort_optional")}>
                <Input className="h-8 text-xs" data-testid="employee-execution-effort" value={draft.effort} onChange={(event) => patch({ effort: event.target.value })} placeholder={tr("common.not_requested")} />
              </Field>
              <Field label={tr("execution.task_complexity")}>
                <Select
                  id={`${ids}-complexity`}
                  className="h-8 text-xs"
                  data-testid="employee-execution-complexity"
                  value={draft.complexity}
                  onChange={(event) => patch({ complexity: event.target.value as ExecutionDraft["complexity"] })}
                >
                  <option value=""><I18nText id="common.unknown" /></option>
                  <option value="low"><I18nText id="common.low" /></option>
                  <option value="medium"><I18nText id="execution.medium" /></option>
                  <option value="high"><I18nText id="common.high" /></option>
                  <option value="very-high"><I18nText id="common.very_high" /></option>
                </Select>
              </Field>
            </div>
            <p className="text-[length:var(--text-caption)] text-muted-foreground"><I18nText id="execution.choices_here_are_used_only_for_this_calculation" /></p>
            <div className="flex flex-wrap items-center gap-2">
              <Button type="button" size="sm" data-testid="employee-execution-prepare" disabled={loading} onClick={prepare}>
                {loading ? tr("common.preparing") : tr("common.prepare_execution")}
              </Button>
              {canRun && (
                <Button ref={runTriggerRef} type="button" size="sm" variant="outline" data-testid="employee-execution-run" disabled={reviewing} onClick={openReview}>
                  {reviewing ? tr("common.preparing_review") : tr("common.run_employee")}
                </Button>
              )}
              <span className="text-[length:var(--text-caption)] text-muted-foreground" data-testid="employee-execution-start-note"><I18nText id="execution.run_employee_opens_a_review_nothing_starts_until" />{" "}</span>
            </div>
            <ExecutorSuggestions
              taskId={task.id}
              draft={draft}
              harnesses={harnesses}
              refreshKey={shown?.result.stateKey ?? ""}
              onChoose={(harnessId, model) => patch({ harnessId, model })}
            />
          </>
        )}

        {latest && <EmployeeRunStatus key={latest.id} attempt={latest} onUpdated={(updated) => setAttempts((list) => list.map((a) => a.id === updated.id ? updated : a))} />}
        <EmployeeRunHistory attempts={attempts} currentId={latest?.id ?? null} />

        <div role="status" aria-live="polite" className="text-[length:var(--text-caption)]">
          {error && <p className="text-danger" data-testid="employee-execution-error">{error}</p>}
        </div>

        {result && (
          <div className={stale ? "flex flex-col gap-3 opacity-60" : "flex flex-col gap-3"} data-testid="employee-execution-result" data-stale={stale ? "true" : "false"} data-state-key={result.stateKey}>
            {stale && (
              <p className="rounded-md border border-warning/50 bg-warning/10 px-2 py-1.5 text-[length:var(--text-caption)] text-warning" data-testid="employee-execution-stale"><I18nText id="execution.stale_this_result_may_no_longer_match_the" />{" "}</p>
            )}
            <section className="rounded-md border border-border/70 px-2 py-1.5 text-[length:var(--text-caption)]">
              <div className="flex flex-wrap items-center gap-2">
                <span className="font-medium" data-testid="employee-execution-outcome" data-outcome={result.outcome}>{outcomeLabel(result.outcome)}</span>
                {result.selection && <Chip state={result.selection.evidence} />}
                <span className="text-muted-foreground"><I18nText id="execution.prepared" />{" "}{new Date(result.capturedAt).toLocaleTimeString(intlLocale())}</span>
              </div>
              <dl className="mt-1 grid grid-cols-1 gap-1 sm:grid-cols-[8rem_minmax(0,1fr)]">
                <dt className="text-muted-foreground"><I18nText id="common.worker" /></dt>
                <dd className="break-words" data-testid="employee-execution-result-worker">
                  {result.employee ? `${result.employee.name} · ${result.employee.jobTitle}` : tr("common.none_assigned")}
                  {result.assignment ? tr("common.revision_0a9423", { p0: String(result.assignment.revision) }) : ""}
                </dd>
                <dt className="text-muted-foreground"><I18nText id="common.project_985959" /></dt>
                <dd className="break-all">{result.canonicalProject?.path ?? tr("common.no_registered_project")}</dd>
                <dt className="text-muted-foreground"><I18nText id="execution.selected_harness" /></dt>
                <dd data-testid="employee-execution-selected">{result.selection ? result.selection.label : tr("common.none_selected")}</dd>
                <dt className="text-muted-foreground"><I18nText id="execution.requested_model" /></dt>
                <dd data-testid="employee-execution-requested-model">{result.requested.model ?? tr("common.not_requested")}</dd>
                <dt className="text-muted-foreground"><I18nText id="execution.requested_effort" /></dt>
                <dd>{result.requested.effort ?? tr("common.not_requested")}</dd>
                <dt className="text-muted-foreground"><I18nText id="execution.task_mode" /></dt>
                <dd>{result.executionMode.taskMode ?? tr("common.task_default")} <span className="text-muted-foreground"><I18nText id="execution.unchanged" /></span></dd>
                {result.selection && (
                  <>
                    <dt className="text-muted-foreground"><I18nText id="common.account" /></dt>
                    <dd data-testid="employee-execution-account" data-state={result.selection.account.state}>
                      <span className="font-medium">{result.selection.account.accounts.map(a => a.displayName).join(", ")} · {accountStateLabel(result.selection.account.state)}.</span> <span title={result.selection.account.label}>{preflightLabel("account", result.selection.account.state, result.selection.account.label)}</span>
                    </dd>
                    <dt className="text-muted-foreground"><I18nText id="execution.quota" /></dt>
                    <dd data-testid="employee-execution-quota" data-state={result.selection.quota.state}><span title={result.selection.quota.label}>{preflightLabel("quota", result.selection.quota.state, result.selection.quota.label)}</span><QuotaFactNote facts={result.selection.quota.facts} testId="employee-execution-quota-facts" /></dd>
                    <dt className="text-muted-foreground"><I18nText id="execution.model_capability" /></dt>
                    <dd data-testid="employee-execution-model-evidence" data-state={result.selection.model.state}><span title={result.selection.model.label}>{preflightLabel("model", result.selection.model.state, result.selection.model.label)}</span></dd>
                  </>
                )}
              </dl>
            </section>

            {result.selection?.providerRefusal && (
              <ProviderRefusalNotice
                refusal={result.selection.providerRefusal}
                accountLabel={result.selection.account.accounts.map((a) => a.displayName).join(", ") || null}
                testId="employee-execution-provider-refusal"
                className="space-y-1 rounded-md border border-warning/40 bg-warning/10 px-2 py-1.5 text-[length:var(--text-caption)]"
                onOpenAccount={requestOpenAccounts}
              />
            )}
            <IssueList title={tr("execution.blocking_errors")} items={result.blockingErrors} tone="text-danger" testId="employee-execution-errors" />
            <IssueList title={tr("common.warnings")} items={result.warnings} tone="text-warning" testId="employee-execution-warnings" />
            {result.accessDiagnostics && (
              <AccessModeDisclosure diagnostics={result.accessDiagnostics} testId="employee-execution-access-diagnostics" compact />
            )}

            <section className="rounded-md border border-border/70 px-2 py-1.5 text-[length:var(--text-caption)]" data-testid="employee-execution-recommendation">
              <h3 className="text-xs uppercase tracking-wide text-muted-foreground"><I18nText id="execution.router_recommendation" /></h3>
              <p>
                {result.routerRecommendation.harnessId
                  ? tr("common.the_router_prefers", { p0: String(result.routerRecommendation.harnessId), p1: String(result.routerRecommendation.modelId ? ` / ${result.routerRecommendation.modelId}` : "") })
                  : tr("common.the_router_has_no_verified_recommendation")}
              </p>
              <p className="text-muted-foreground">{result.routerRecommendation.note}</p>
              <details className="mt-1">
                <summary className="cursor-pointer text-muted-foreground"><I18nText id="execution.registered_harnesses" />{result.harnessOptions.length})</summary>
                <ul className="mt-1 flex flex-col gap-1" data-testid="employee-execution-options">
                  {result.harnessOptions.map((option) => (
                    <li key={option.harnessId} data-harness={option.harnessId} className="min-w-0">
                      <span className="font-medium">{option.label}</span>{" "}
                      <Chip state={option.evidence} />
                      {option.notRecommendedBecause.length > 0 && (
                        <span className="block break-words text-muted-foreground"><I18nText id="execution.not_recommended_automatically" />{" "}{option.notRecommendedBecause.slice(0, 4).join(" ")}</span>
                      )}
                    </li>
                  ))}
                </ul>
              </details>
            </section>

            {result.missingEvidence.length > 0 && (
              <details className="rounded-md border border-border/70 px-2 py-1.5 text-[length:var(--text-caption)]" data-testid="employee-execution-missing">
                <summary className="cursor-pointer text-xs uppercase tracking-wide text-muted-foreground"><I18nText id="execution.missing_evidence" />{result.missingEvidence.length})</summary>
                <ul className="mt-1 list-disc pl-4">{result.missingEvidence.map((line) => <li key={line}>{staticLabel(line)}</li>)}</ul>
              </details>
            )}

            <section className="rounded-md border border-border/70 px-2 py-1.5 text-[length:var(--text-caption)]" data-testid="employee-execution-owner">
              <h3 className="text-xs uppercase tracking-wide text-muted-foreground"><I18nText id="execution.owner_restrictions" /></h3>
              <ul className="mt-1 list-disc pl-4">
                <li><I18nText id="execution.spending_policy" />{" "}{result.ownerRestrictions.spending ?? tr("common.unknown")}</li>
                <li><I18nText id="execution.allowed_harnesses" />{" "}{result.ownerRestrictions.allowedHarnesses ? result.ownerRestrictions.allowedHarnesses.join(", ") || tr("common.none") : tr("common.no_restriction_recorded")}</li>
                {result.ownerRestrictions.requiredApprovals.map((line) => <li key={line}>{staticLabel(line)}</li>)}
              </ul>
            </section>

            <p className="text-[length:var(--text-caption)]" data-testid="employee-execution-next">{result.proposedNextAction.text}</p>
          </div>
        )}
      </div>
      {review && <EmployeeRunReviewDialog attempt={review} returnFocusRef={runTriggerRef} onClose={closeReview} onStarted={(attempt) => { setAttempts((list) => [attempt, ...list.filter((a) => a.id !== attempt.id)]); setReview(null); }} />}
    </details>
  );
}
