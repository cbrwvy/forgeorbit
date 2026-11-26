import { staticLabel } from "@/i18n/presentation";
import { t as tr } from "@/i18n/core";
import { I18nText, useLocale as useUILocale } from "@/i18n/react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { api } from "@/lib/api";
import { cn } from "@/lib/utils";
import { formatEmployeeTime, isCurrentRequest } from "@/lib/employees";
import { subscribePortfolioRefresh } from "@/lib/portfolio-events";
import {
  PROPOSAL_NOTE,
  approveRequestFor,
  canApprove,
  groupProposals,
  proposalAuthorLabel,
  proposalErrorText,
  proposalEventLabel,
  proposalFromError,
  proposalStatusLabel,
  proposalStatusTone,
  reassignConsentLabel,
} from "@/lib/assignment-proposals";
import { Button } from "@/components/ui/button";
import type { AssignmentProposal, AssignmentProposalEvent } from "../../../../shared/assignments/proposals.ts";

import type { AssignmentExecutorReview } from "../../../../shared/execution/executor-routing.ts";
import { OptionCard } from "../../kanban/ExecutorSuggestions";

function ExecutorReview({ proposal, onReview }: { proposal: AssignmentProposal; onReview: (review: AssignmentExecutorReview | null) => void }) {
  const [review, setReview] = useState<AssignmentExecutorReview | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => { setReview(null); onReview(null); }, [proposal.revision, proposal.updatedAt]);
  const load = async () => {
    setBusy(true); setError(null); onReview(null); setReview(null);
    try { setReview((await api.assignmentExecutorReview(proposal.id)).review); }
    catch (error) { setError(proposalErrorText(error)); }
    finally { setBusy(false); }
  };
  return <section className="rounded border p-2 text-xs" data-testid="pm-executor-review">
    <h4>{tr("pmRouting.title")}</h4>
    <p className="text-muted-foreground">{tr("pmRouting.note")}</p>
    <Button size="sm" variant="outline" disabled={busy} onClick={() => void load()} data-testid="pm-executor-load">{tr("pmRouting.load")}</Button>
    {error && <p role="alert">{error}</p>}
    {review && <>
      <ul data-testid="pm-executor-options">
        {review.proposed ? <OptionCard option={review.proposed} chosen /> : <li>{tr("pmRouting.none")}</li>}
        {review.alternatives.map((option) => <OptionCard key={option.id} option={option} chosen={false} />)}
      </ul>
      <label className="flex gap-2"><input type="checkbox" data-testid="pm-executor-consent" onChange={(e) => onReview(e.target.checked ? review : null)} />{tr("pmRouting.confirm")}</label>
    </>}
  </section>;
}

interface Props {
  /** Set for one project's list. Omitted for the company-wide list. */
  projectPath?: string;
  /** Changes when the surrounding page knows something new (a manager reply, a reload). */
  refreshToken?: number | string;
  onOpenTask?: (taskId: string) => void;
  onOpenProject?: (projectPath: string) => void;
  onOpenEmployee?: (employeeId: string) => void;
  /** Called after a decision changed anything, so assigned-task lists can re-read. */
  onChanged?: () => void;
}

const HISTORY_SHOWN = 20;

function StatusPill({ proposal }: { proposal: Pick<AssignmentProposal, "status"> }) {
  useUILocale();
  const tone = proposalStatusTone(proposal.status);
  return (
    <span
      data-testid="assignment-proposal-status"
      data-status={proposal.status}
      className={cn(
        "inline-flex shrink-0 items-center rounded-full border px-2 py-0.5 text-[11px] font-medium",
        tone === "success" && "border-success/40 text-success",
        tone === "warning" && "border-warning/40 text-warning",
        tone === "danger" && "border-danger/40 text-danger",
        tone === "info" && "border-info/40 text-info",
        tone === "muted" && "text-muted-foreground",
      )}
    >
      {proposalStatusLabel(proposal.status)}
    </span>
  );
}

/**
 * Assignment proposals waiting for the owner, plus recent out-of-date ones
 * and the decided history. Approve calls the proposal API, which assigns
 * through the FO-010C core; nothing here starts a run or picks a model.
 * Proposals written by a manager look the same as owner-entered ones except
 * for the author line, and they never approve themselves.
 */
export function AssignmentProposals({ projectPath, refreshToken, onOpenTask, onOpenProject, onOpenEmployee, onChanged }: Props) {
  const { locale: uiLocale } = useUILocale();
  const scope = projectPath ? "project" : "company";
  const [proposals, setProposals] = useState<AssignmentProposal[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [status, setStatus] = useState<{ tone: "ok" | "error"; text: string } | null>(null);
  const [consent, setConsent] = useState<Record<string, boolean>>({});
  const [executorReviews, setExecutorReviews] = useState<Record<string, AssignmentExecutorReview | null>>({});
  const [busyId, setBusyId] = useState<string | null>(null);
  const requestRef = useRef(0);

  const load = useCallback(() => {
    const requestId = ++requestRef.current;
    void api.listAssignmentProposals(projectPath ? { projectPath } : {}).then(
      (result) => {
        if (!isCurrentRequest(requestId, requestRef.current)) return;
        setProposals(result.proposals);
        setError(null);
        setLoading(false);
      },
      (err: unknown) => {
        if (!isCurrentRequest(requestId, requestRef.current)) return;
        setError(proposalErrorText(err));
        setLoading(false);
      },
    );
  }, [projectPath]);

  useEffect(() => {
    setProposals([]);
    setLoading(true);
    setStatus(null);
    setConsent({});
  }, [projectPath]);

  useEffect(() => {
    load();
  }, [load, refreshToken]);

  useEffect(() => {
    const unsubscribe = subscribePortfolioRefresh(() => load());
    const onVisible = () => { if (document.visibilityState === "visible") load(); };
    window.addEventListener("focus", load);
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      unsubscribe();
      window.removeEventListener("focus", load);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [load]);

  // `Date.now()` is read when the list changes, not on every render.
  const groups = useMemo(() => groupProposals(proposals, Date.now()), [proposals, uiLocale]);

  const decide = async (proposal: AssignmentProposal, action: "approve" | "reject") => {
    setBusyId(proposal.id);
    setStatus(null);
    const title = proposal.task.title ?? tr("common.the_task");
    const worker = proposal.worker.name ?? tr("common.the_worker");
    try {
      if (action === "approve") {
        const result = await api.approveAssignmentProposal(proposal.id, { ...approveRequestFor(proposal, consent[proposal.id] === true), ...(executorReviews[proposal.id] ? { routingReviewToken: executorReviews[proposal.id]!.reviewToken } : {}) });
        setStatus({
          tone: "ok",
          text: result.alreadyApplied
            ? tr("common.this_proposal_was_already_approved_nothing_changed")
            : tr("common.assigned_to_nothing_was_started", { p0: String(title), p1: String(worker) }),
        });
      } else {
        await api.rejectAssignmentProposal(proposal.id, proposal.revision);
        setStatus({ tone: "ok", text: `Rejected the proposal for ${title}. Nothing was assigned.` });
      }
      onChanged?.();
    } catch (err) {
      const current = proposalFromError(err);
      setStatus({
        tone: "error",
        text: current?.status === "stale"
          ? tr("common.nothing_was_assigned", { p0: String(current.staleReason ?? tr("common.this_proposal_is_out_of_date")) })
          : proposalErrorText(err),
      });
    } finally {
      setBusyId(null);
      load();
    }
  };

  return (
    <section
      className="surface-solid min-w-0 overflow-hidden rounded-xl border"
      aria-label={tr("employees.assignment_proposals")}
      data-testid="assignment-proposals"
      data-scope={scope}
    >
      <div className="flex items-center justify-between gap-3 border-b border-[hsl(var(--glass-border)/var(--glass-border-alpha))] px-4 py-2.5">
        <h3 className="text-sm font-medium"><I18nText id="employees.assignment_proposals" /></h3>
        <span
          className="rounded-full border px-2 py-0.5 text-[11px] font-medium tabular-nums text-muted-foreground"
          data-testid="assignment-proposals-count"
          aria-label={tr("common.pending_522549", { p0: String(groups.pending.length) })}
        >
          {groups.pending.length}{" "}<I18nText id="common.pending" />{" "}</span>
      </div>
      <div className="flex flex-col gap-3 px-4 py-3">
        <p className="text-xs text-muted-foreground" data-testid="assignment-proposals-note">{staticLabel(PROPOSAL_NOTE)}</p>
        <p
          role="status"
          aria-live="polite"
          data-testid="assignment-proposals-status"
          className={cn("break-words text-sm", status?.tone === "error" ? "text-destructive" : "text-success")}
        >
          {status?.text ?? ""}
        </p>
        {error && <p role="alert" data-testid="assignment-proposals-error" className="text-sm text-destructive">{error}</p>}
        {loading && !error && <p data-testid="assignment-proposals-loading" className="text-sm text-muted-foreground"><I18nText id="employees.loading_proposals" /></p>}
        {!loading && !error && groups.pending.length === 0 && (
          <p data-testid="assignment-proposals-empty" className="text-sm text-muted-foreground"><I18nText id="employees.no_proposals_waiting_for_your_review" /></p>
        )}

        {groups.pending.length > 0 && (
          <ul className="flex flex-col gap-2" data-testid="assignment-proposal-list" aria-label={tr("employees.pending_proposals")}>
            {groups.pending.map((proposal) => {
              const consentId = `proposal-consent-${proposal.id}`;
              const busy = busyId === proposal.id;
              return (
                <li
                  key={proposal.id}
                  className="flex min-w-0 flex-col gap-2 rounded-lg border px-3 py-2"
                  data-testid="assignment-proposal"
                  data-status={proposal.status}
                  data-proposal-id={proposal.id}
                  data-task-id={proposal.taskId}
                >
                  <div className="flex min-w-0 flex-wrap items-start justify-between gap-2">
                    <div className="min-w-0 flex-1 basis-56">
                      <p className="break-words text-sm font-medium" data-testid="assignment-proposal-task">
                        {proposal.task.title ?? tr("common.task_4bc74b")}
                      </p>
                      <p className="break-words text-xs text-muted-foreground" data-testid="assignment-proposal-meta">
                        {scope === "company" && (
                          <>
                            {onOpenProject ? (
                              <button type="button" className="underline-offset-2 hover:underline" data-testid="assignment-proposal-project" onClick={() => onOpenProject(proposal.projectPath)}>
                                {proposal.projectName ?? proposal.projectPath}
                              </button>
                            ) : (proposal.projectName ?? proposal.projectPath)}
                            {" · "}
                          </>
                        )}<I18nText id="common.proposed" />{" "}{formatEmployeeTime(proposal.createdAt)}
                      </p>
                    </div>
                    <StatusPill proposal={proposal} />
                  </div>
                  <dl className="grid grid-cols-1 gap-x-4 gap-y-1 text-xs sm:grid-cols-[auto_1fr]">
                    <dt className="text-muted-foreground"><I18nText id="common.worker" /></dt>
                    <dd className="min-w-0 break-words" data-testid="assignment-proposal-worker">
                      {onOpenEmployee ? (
                        <button type="button" className="underline-offset-2 hover:underline" onClick={() => onOpenEmployee(proposal.worker.id)}>{proposal.worker.name ?? tr("common.unknown_employee")}</button>
                      ) : (proposal.worker.name ?? tr("common.unknown_employee"))}
                      {proposal.worker.jobTitle ? <span className="text-muted-foreground"> · {proposal.worker.jobTitle}</span> : null}
                    </dd>
                    <dt className="text-muted-foreground"><I18nText id="employees.proposed_by" /></dt>
                    <dd className="min-w-0 break-words" data-testid="assignment-proposal-author">{proposalAuthorLabel(proposal)}</dd>
                    <dt className="text-muted-foreground"><I18nText id="employees.reason" /></dt>
                    <dd className="min-w-0 break-words" data-testid="assignment-proposal-rationale">{proposal.rationale}</dd>
                    <dt className="text-muted-foreground"><I18nText id="employees.now_assigned_to" /></dt>
                    <dd className="min-w-0 break-words" data-testid="assignment-proposal-current">
                      {proposal.currentAssignment
                        ? tr("common.assignment_revision_3748ba", { p0: String(proposal.currentAssignment.employeeName ?? tr("common.unknown_employee")), p1: String(proposal.currentAssignment.revision) })
                        : tr("common.no_one")}
                    </dd>
                  </dl>
                  {proposal.proposedBy.kind === "project-manager" && <ExecutorReview proposal={proposal} onReview={(review) => setExecutorReviews((current) => ({ ...current, [proposal.id]: review }))} />}
                  {proposal.conflicts.length > 0 && (
                    <ul className="flex flex-col gap-0.5 text-xs text-warning" data-testid="assignment-proposal-conflicts">
                      {proposal.conflicts.map((line) => <li key={line} className="break-words">{line}</li>)}
                    </ul>
                  )}
                  {proposal.needsReassign && (
                    <label htmlFor={consentId} className="flex items-start gap-2 text-xs" data-testid="assignment-proposal-consent-label">
                      <input
                        id={consentId}
                        type="checkbox"
                        className="mt-0.5 size-4 shrink-0 accent-[hsl(var(--primary))]"
                        data-testid="assignment-proposal-consent"
                        checked={consent[proposal.id] === true}
                        disabled={busy}
                        onChange={(event) => setConsent((current) => ({ ...current, [proposal.id]: event.target.checked }))}
                      />
                      <span>{reassignConsentLabel(proposal)}</span>
                    </label>
                  )}
                  <div className="flex flex-wrap items-center gap-2">
                    <Button
                      type="button"
                      size="sm"
                      data-testid="assignment-proposal-approve"
                      disabled={busy || !canApprove(proposal, consent[proposal.id] === true) || (proposal.proposedBy.kind === "project-manager" && !executorReviews[proposal.id])}
                      onClick={() => void decide(proposal, "approve")}
                    >
                      {proposal.needsReassign ? tr("common.approve_and_replace") : tr("common.approve")}
                    </Button>
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      data-testid="assignment-proposal-reject"
                      disabled={busy}
                      onClick={() => void decide(proposal, "reject")}
                    ><I18nText id="common.reject" />{" "}</Button>
                    {onOpenTask && proposal.task.visibility === "in-project" && (
                      <Button type="button" variant="ghost" size="sm" data-testid="assignment-proposal-open-task" onClick={() => onOpenTask(proposal.taskId)}><I18nText id="common.open_task" />{" "}</Button>
                    )}
                  </div>
                </li>
              );
            })}
          </ul>
        )}

        {groups.recentStale.length > 0 && (
          <ul className="flex flex-col gap-2" data-testid="assignment-proposal-stale-list" aria-label={tr("employees.out_of_date_proposals")}>
            {groups.recentStale.map((proposal) => (
              <li
                key={proposal.id}
                className="flex min-w-0 flex-col gap-1 rounded-lg border border-warning/40 px-3 py-2"
                data-testid="assignment-proposal"
                data-status="stale"
                data-proposal-id={proposal.id}
              >
                <div className="flex min-w-0 flex-wrap items-center justify-between gap-2">
                  <p className="min-w-0 break-words text-sm font-medium">{proposal.task.title ?? tr("common.task_4bc74b")}</p>
                  <StatusPill proposal={proposal} />
                </div>
                <p className="break-words text-xs text-muted-foreground">
                  {proposal.worker.name ?? tr("common.unknown_employee")}<I18nText id="employees.this_proposal_is_out_of_date_and_was" />{" "}</p>
                <p className="break-words text-xs text-warning" data-testid="assignment-proposal-stale-reason">{proposal.staleReason}</p>
              </li>
            ))}
          </ul>
        )}

        {groups.history.length > 0 && <ProposalHistory proposals={groups.history} scope={scope} />}
      </div>
    </section>
  );
}

function ProposalHistory({ proposals, scope }: { proposals: AssignmentProposal[]; scope: "project" | "company" }) {
  useUILocale();
  const shown = proposals.slice(0, HISTORY_SHOWN);
  return (
    <details className="rounded-lg border px-3 py-2" data-testid="assignment-proposal-history">
      <summary className="cursor-pointer text-sm font-medium" data-testid="assignment-proposal-history-toggle"><I18nText id="employees.proposal_history" />{proposals.length})
      </summary>
      <ol className="mt-2 flex flex-col gap-1.5">
        {shown.map((proposal) => (
          <HistoryRow key={proposal.id} proposal={proposal} scope={scope} />
        ))}
      </ol>
      {proposals.length > shown.length && <p className="mt-2 text-xs text-muted-foreground"><I18nText id="employees.older_proposals_are_not_shown" /></p>}
    </details>
  );
}

function HistoryRow({ proposal, scope }: { proposal: AssignmentProposal; scope: "project" | "company" }) {
  useUILocale();
  const [events, setEvents] = useState<AssignmentProposalEvent[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const load = () => {
    if (events || error) return;
    void api.assignmentProposalHistory(proposal.id).then(
      (result) => setEvents(result.events),
      (err: unknown) => setError(proposalErrorText(err)),
    );
  };
  return (
    <li className="rounded-lg border px-3 py-1.5" data-testid="assignment-proposal-history-row" data-status={proposal.status} data-proposal-id={proposal.id}>
      <details onToggle={(event) => { if ((event.currentTarget as HTMLDetailsElement).open) load(); }}>
        <summary className="flex min-w-0 cursor-pointer flex-wrap items-center gap-x-2 gap-y-1 text-sm">
          <span className="min-w-0 break-words">{proposal.task.title ?? tr("common.task_4bc74b")}</span>
          <span className="text-xs text-muted-foreground">→ {proposal.worker.name ?? tr("common.unknown_employee")}</span>
          {scope === "company" && <span className="text-xs text-muted-foreground">· {proposal.projectName ?? proposal.projectPath}</span>}
          <StatusPill proposal={proposal} />
          <span className="text-xs text-muted-foreground">{formatEmployeeTime(proposal.decidedAt ?? proposal.updatedAt)}</span>
        </summary>
        <div className="mt-2 flex flex-col gap-1 text-xs">
          <p className="break-words text-muted-foreground"><I18nText id="employees.reason_3425d1" />{" "}{proposal.rationale}</p>
          {proposal.staleReason && <p className="break-words text-warning">{proposal.staleReason}</p>}
          {proposal.result && (
            <p className="break-words text-muted-foreground">
              {proposal.result.reassigned ? tr("common.replaced_the_previous_worker") : tr("common.assigned_16603b")}{" "}<I18nText id="common.assignment_revision" />{" "}{proposal.result.assignmentRevision ?? "?"}.
            </p>
          )}
          {error && <p role="alert" className="text-destructive">{error}</p>}
          {events && (
            <ol className="flex flex-col gap-0.5" data-testid="assignment-proposal-events">
              {events.map((event) => (
                <li key={event.id} data-action={event.action}>
                  {proposalEventLabel(event)} <span className="text-muted-foreground">{formatEmployeeTime(event.at)}</span>
                </li>
              ))}
            </ol>
          )}
        </div>
      </details>
    </li>
  );
}
