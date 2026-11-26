import { englishPluralSuffix, t as tr } from "@/i18n/core";

import { I18nText, useLocale as useUILocale } from "@/i18n/react";
import { useMemo, useRef, useState } from "react";
import { Check, ListChecks, ListTree, Loader2, Play, X } from "lucide-react";
import { ApiError, api } from "@/lib/api";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select } from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { cn } from "@/lib/utils";
import { columnLabel } from "@/lib/status-presenters";
import {
  MANAGER_LIMITS,
  PROPOSAL_PRIORITIES,
  approvalSummary,
  plannedAction,
  priorityLabel,
  type DuplicateAction,
  type ProposalItem,
  type ProposalItemEdit,
  type ProposalPriority,
  type TaskProposal,
} from "../../../../shared/project-manager.ts";
import type { Task } from "../../../../shared/types.ts";
import { TaskPlanView } from "./TaskPlanView";

interface Draft {
  title: string;
  description: string;
  priority: ProposalPriority;
  criteria: string;
  include: boolean;
  duplicateAction: DuplicateAction;
}

function draftOf(item: ProposalItem): Draft {
  return {
    title: item.title,
    description: item.description,
    priority: item.priority,
    criteria: item.acceptanceCriteria.join("\n"),
    include: item.include,
    duplicateAction: item.duplicateAction,
  };
}

function criteriaOf(text: string): string[] {
  return text.split("\n").map((line) => line.replace(/^\s*[-*•]\s*/, "").trim()).filter(Boolean);
}

function editsOf(items: ProposalItem[], drafts: Record<string, Draft>): ProposalItemEdit[] {
  const out: ProposalItemEdit[] = [];
  for (const item of items) {
    const draft = drafts[item.id];
    if (!draft) continue;
    out.push({
      id: item.id,
      title: draft.title,
      description: draft.description,
      priority: draft.priority,
      acceptanceCriteria: criteriaOf(draft.criteria),
      include: draft.include,
      duplicateAction: draft.duplicateAction,
    });
  }
  return out;
}

/** Client mirror of the server's "an included item needs…" rule. */
function draftProblem(draft: Draft): string | null {
  if (!draft.include) return null;
  if (!draft.title.trim()) return tr("common.needs_a_title");
  if (!draft.description.trim()) return tr("common.needs_a_description");
  if (criteriaOf(draft.criteria).length === 0) return tr("common.needs_at_least_one_acceptance_criterion");
  return null;
}

const STATUS_LABELS: Record<TaskProposal["status"], string> = {
  get pending() { return tr("common.waiting_for_your_review_b5dd9c"); },
  get approved() { return tr("common.approved"); },
  get partial() { return tr("common.partly_created"); },
  get rejected() { return tr("common.rejected"); },
};

interface Props {
  projectPath: string;
  proposal: TaskProposal;
  tasks: Task[];
  onChanged: (proposal: TaskProposal) => void;
  onOpenTask: (task: Task) => void;
  /** Prepare a supervised run of a created task (FO-005B). Never starts it. */
  onExecute?: (taskId: string) => void;
  /** Prepare a draft execution batch from the created tasks (starts nothing). */
  onPrepareBatch?: (proposalId: string) => Promise<void>;
  /** Open a batch in the Autonomous Execution tab (approve and start live there). */
  onOpenBatch?: (batchId: string) => void;
  /** Jump to this plan in the Manager's Plan & queue section (same data, one place). */
  onOpenPlanSection?: () => void;
}

/**
 * A task proposal from the manager. Nothing exists on the board until the
 * owner approves; until then every item can be edited, left out, or (when it
 * repeats an existing task) linked to that task instead. Approve sends the
 * reviewed revision, so the server refuses to act on something the owner
 * didn't see.
 */
export function ProposalCard({ projectPath, proposal, tasks, onChanged, onOpenTask, onExecute, onPrepareBatch, onOpenBatch, onOpenPlanSection }: Props) {
  const { locale: uiLocale } = useUILocale();
  const [batchBusy, setBatchBusy] = useState(false);
  const [batchError, setBatchError] = useState<string | null>(null);
  const [drafts, setDrafts] = useState<Record<string, Draft>>({});
  const [busy, setBusy] = useState<"approve" | "reject" | null>(null);
  const [savingDraft, setSavingDraft] = useState(false);
  const busyRef = useRef(busy);
  busyRef.current = busy;
  const [error, setError] = useState<string | null>(null);
  const [confirmReject, setConfirmReject] = useState(false);
  const saving = useRef<Promise<TaskProposal | null> | null>(null);
  // The newest revision the server confirmed: a blur-save can land between
  // this render and an approve click.
  const latest = useRef(proposal);
  if (latest.current.id !== proposal.id || latest.current.revision < proposal.revision) latest.current = proposal;
  const editable = proposal.status === "pending" || proposal.status === "partial";

  const items = useMemo(() => proposal.items.map((item) => {
    const draft = drafts[item.id];
    if (!draft) return item;
    return {
      ...item,
      title: draft.title,
      description: draft.description,
      priority: draft.priority,
      acceptanceCriteria: criteriaOf(draft.criteria),
      include: draft.include,
      duplicateAction: draft.duplicateAction,
    };
  }), [proposal.items, drafts, uiLocale]);
  const summary = approvalSummary(items);
  // An open plan re-reads when the proposal or any of its tasks moved.
  const planRefreshToken = useMemo(() => {
    const ids = new Set(proposal.items.flatMap((item) => (item.result?.taskId ? [item.result.taskId] : [])));
    const moved = tasks.filter((task) => ids.has(task.id)).map((task) => `${task.id}:${task.column}:${task.updatedAt}`).join("|");
    return `${proposal.revision}:${proposal.status}:${moved}`;
  }, [proposal.items, proposal.revision, proposal.status, tasks]);
  const problems = proposal.items
    .map((item) => {
      const draft = drafts[item.id] ?? draftOf(item);
      const locked = item.result?.status === "created" || item.result?.status === "linked";
      return !locked && plannedAction({ ...item, include: draft.include, duplicateAction: draft.duplicateAction }) === "create"
        ? draftProblem(draft)
        : null;
    })
    .filter((problem): problem is string => problem != null);

  const update = (item: ProposalItem, patch: Partial<Draft>) => {
    setDrafts((current) => ({ ...current, [item.id]: { ...(current[item.id] ?? draftOf(item)), ...patch } }));
  };

  const applyServer = (next: TaskProposal, keepDrafts = false) => {
    latest.current = next;
    if (!keepDrafts) setDrafts({});
    onChanged(next);
  };

  /** Persist edits so they survive a reload. Serialized; returns the saved proposal. */
  const saveDrafts = async (): Promise<TaskProposal | null> => {
    const edits = editsOf(proposal.items, drafts);
    if (edits.length === 0 || !editable || busyRef.current) return latest.current;
    if (edits.some((edit) => {
      const draft = drafts[edit.id]!;
      return draftProblem(draft) != null;
    })) return null;
    const run = async () => {
      setSavingDraft(true);
      try {
        const saved = await api.saveProposalEdits(projectPath, proposal.id, latest.current.revision, edits);
        // Keep the drafts: the owner may have typed on since this save left.
        applyServer(saved, true);
        return saved;
      } catch (caught) {
        handleError(caught);
        return null;
      } finally {
        setSavingDraft(false);
      }
    };
    saving.current = (saving.current ?? Promise.resolve(null)).then(run);
    return saving.current;
  };

  const handleError = (caught: unknown) => {
    if (caught instanceof ApiError) {
      const fresh = (caught.body as { proposal?: TaskProposal } | null)?.proposal;
      if (fresh) applyServer(fresh);
      setError(caught.message);
      return;
    }
    setError((caught as Error).message);
  };

  const approve = async () => {
    // A double click lands here twice; the ref sees the first one at once.
    if (busyRef.current || problems.length > 0) return;
    busyRef.current = "approve";
    setError(null);
    setBusy("approve");
    try {
      if (saving.current) await saving.current;
      const result = await api.approveProposal(projectPath, proposal.id, latest.current.revision, editsOf(proposal.items, drafts));
      applyServer(result.proposal);
      if (result.proposal.status === "partial") setError(tr("common.some_tasks_couldn_t_be_created_approve_again"));
    } catch (caught) {
      handleError(caught);
    } finally {
      setBusy(null);
    }
  };

  const reject = async () => {
    if (busyRef.current) return;
    busyRef.current = "reject";
    setError(null);
    setBusy("reject");
    try {
      applyServer(await api.rejectProposal(projectPath, proposal.id));
      setConfirmReject(false);
    } catch (caught) {
      handleError(caught);
    } finally {
      setBusy(null);
    }
  };

  const taskById = (id: string | null) => (id ? tasks.find((task) => task.id === id) ?? null : null);

  return (
    <section
      className="space-y-2 rounded-xl border border-info/40 bg-info/5 p-3"
      aria-label={tr("common.task_proposal", { p0: String(proposal.title) })}
      data-testid="manager-proposal"
      data-status={proposal.status}
      data-proposal-id={proposal.id}
    >
      <header className="flex flex-wrap items-start justify-between gap-2">
        <div className="min-w-0">
          <h4 className="flex items-center gap-1.5 text-sm font-semibold">
            <ListChecks className="size-4 text-info" aria-hidden />
            {proposal.title}
          </h4>
          {proposal.summary && <p className="mt-0.5 text-xs text-muted-foreground">{proposal.summary}</p>}
        </div>
        <span
          className={cn(
            "rounded-full px-2 py-0.5 text-[11px] font-medium",
            proposal.status === "approved" && "bg-success/15 text-success",
            proposal.status === "partial" && "bg-warning/15 text-warning",
            proposal.status === "rejected" && "bg-muted text-muted-foreground",
            proposal.status === "pending" && "bg-info/15 text-info",
          )}
          data-testid="manager-proposal-status"
        >
          {STATUS_LABELS[proposal.status]}
        </span>
      </header>

      <ol className="space-y-2">
        {proposal.items.map((item, index) => {
          const draft = drafts[item.id] ?? draftOf(item);
          const locked = !editable || item.result?.status === "created" || item.result?.status === "linked";
          const action = plannedAction({ ...item, include: draft.include, duplicateAction: draft.duplicateAction });
          const createdTask = taskById(item.result?.taskId ?? null);
          const problem = !locked && action === "create" ? draftProblem(draft) : null;
          return (
            <li
              key={item.id}
              className={cn("surface-solid space-y-1.5 rounded-lg border p-2 text-xs", !draft.include && "opacity-60")}
              data-testid="manager-proposal-item"
              data-item-id={item.id}
              data-action={item.result ? item.result.status : action}
            >
              <div className="flex flex-wrap items-center gap-2">
                <span className="text-muted-foreground tabular-nums">{index + 1}.</span>
                {!locked && (
                  <label className="flex items-center gap-1 text-[11px]">
                    <input
                      type="checkbox"
                      checked={draft.include}
                      onChange={(event) => update(item, { include: event.target.checked })}
                      onBlur={() => void saveDrafts()}
                      aria-label={tr("common.include", { p0: String(draft.title || item.title) })}
                      data-testid="manager-item-include"
                    /><I18nText id="approvals.include" />{" "}</label>
                )}
                {locked ? (
                  <span className="min-w-0 flex-1 font-medium">{item.title}</span>
                ) : (
                  <Input
                    value={draft.title}
                    maxLength={MANAGER_LIMITS.taskTitleChars}
                    onChange={(event) => update(item, { title: event.target.value })}
                    onBlur={() => void saveDrafts()}
                    className="h-7 min-w-0 flex-1 text-xs font-medium"
                    aria-label={tr("common.title_of_task", { p0: String(index + 1) })}
                    data-testid="manager-item-title"
                  />
                )}
                {locked ? (
                  <span className="rounded bg-muted px-1.5 py-0.5 text-[11px]">{priorityLabel(item.priority)}</span>
                ) : (
                  <Select
                    value={draft.priority}
                    onChange={(event) => update(item, { priority: event.target.value as ProposalPriority })}
                    onBlur={() => void saveDrafts()}
                    className="h-7 w-24 text-xs"
                    aria-label={tr("common.priority_of_task", { p0: String(index + 1) })}
                    data-testid="manager-item-priority"
                  >
                    {PROPOSAL_PRIORITIES.map((priority) => <option key={priority} value={priority}>{priorityLabel(priority)}</option>)}
                  </Select>
                )}
                <span className="rounded bg-muted px-1.5 py-0.5 text-[11px] capitalize">{item.taskType}</span>
              </div>

              {locked ? (
                <p className="whitespace-pre-wrap text-muted-foreground">{item.description}</p>
              ) : (
                <Textarea
                  value={draft.description}
                  rows={2}
                  maxLength={MANAGER_LIMITS.taskDescriptionChars}
                  onChange={(event) => update(item, { description: event.target.value })}
                  onBlur={() => void saveDrafts()}
                  className="text-xs"
                  aria-label={tr("common.description_of_task", { p0: String(index + 1) })}
                  data-testid="manager-item-description"
                />
              )}

              <div>
                <p className="font-medium"><I18nText id="approvals.acceptance_criteria" /></p>
                {locked ? (
                  <ul className="list-disc pl-4">
                    {item.acceptanceCriteria.map((criterion) => <li key={criterion}>{criterion}</li>)}
                  </ul>
                ) : (
                  <Textarea
                    value={draft.criteria}
                    rows={Math.min(5, Math.max(2, draft.criteria.split("\n").length))}
                    onChange={(event) => update(item, { criteria: event.target.value })}
                    onBlur={() => void saveDrafts()}
                    className="text-xs"
                    aria-label={tr("common.acceptance_criteria_of_task_one_per_line", { p0: String(index + 1) })}
                    data-testid="manager-item-criteria"
                  />
                )}
              </div>

              {(item.dependsOn.length > 0 || item.parentFeature || item.rationale) && (
                <dl className="grid gap-x-3 gap-y-0.5 text-[11px] text-muted-foreground sm:grid-cols-[auto_minmax(0,1fr)]">
                  {item.dependsOn.length > 0 && (
                    <>
                      <dt><I18nText id="common.depends_on" /></dt>
                      <dd data-testid="manager-item-deps">
                        {item.dependsOn.map((dep) => dep.kind === "task"
                          ? `#${dep.taskId.slice(0, 8)} ${dep.title}`
                          : proposal.items.find((other) => other.id === dep.itemId)?.title ?? dep.itemId).join(" · ")}
                      </dd>
                    </>
                  )}
                  {item.parentFeature && (<><dt><I18nText id="approvals.feature" /></dt><dd>{item.parentFeature}</dd></>)}
                  {item.rationale && (<><dt><I18nText id="common.why" /></dt><dd>{item.rationale}</dd></>)}
                </dl>
              )}
              {item.warnings.map((warning) => <p key={warning} className="text-[11px] text-warning">{warning}</p>)}

              {item.duplicate && !item.result && (
                <div className="flex flex-wrap items-center gap-2 rounded-md border border-warning/40 bg-warning/10 px-2 py-1 text-[11px]" data-testid="manager-item-duplicate">
                  <span className="min-w-0 flex-1">
                    {item.duplicate.kind === "task"
                      ? tr("common.looks_like_the_existing_task", { p0: String(item.duplicate.title), p1: String(columnLabel(item.duplicate.column)) })
                      : tr("common.repeats_in_this_proposal", { p0: String(item.duplicate.title) })}
                  </span>
                  {!locked && (
                    <Select
                      value={draft.duplicateAction}
                      onChange={(event) => update(item, { duplicateAction: event.target.value as DuplicateAction })}
                      onBlur={() => void saveDrafts()}
                      className="h-7 w-44 text-[11px]"
                      aria-label={tr("approvals.what_to_do_with_the_duplicate")}
                      data-testid="manager-item-duplicate-action"
                    >
                      <option value="use-existing"><I18nText id="approvals.use_the_existing_task" /></option>
                      <option value="skip"><I18nText id="approvals.skip_it" /></option>
                      <option value="create"><I18nText id="approvals.create_anyway" /></option>
                    </Select>
                  )}
                </div>
              )}

              {problem && <p className="text-[11px] text-danger">{problem}</p>}

              {item.result && (
                <p
                  className={cn(
                    "flex flex-wrap items-center gap-1.5 text-[11px]",
                    item.result.status === "failed" ? "text-danger" : item.result.status === "skipped" ? "text-muted-foreground" : "text-success",
                  )}
                  data-testid="manager-item-result"
                  data-result={item.result.status}
                >
                  {item.result.status === "created" && <><Check className="size-3" aria-hidden /><I18nText id="approvals.added_to_the_backlog" /></>}
                  {item.result.status === "linked" && <><Check className="size-3" aria-hidden /><I18nText id="approvals.uses_the_existing_task" /></>}
                  {item.result.status === "skipped" && tr("common.left_out")}
                  {item.result.status === "creating" && tr("common.was_being_created_when_it_stopped_approve_again")}
                  {item.result.status === "failed" && tr("common.not_created_2e2fc4", { p0: String(item.result.error ?? tr("common.unknown_error")) })}
                  {createdTask && (
                    <button type="button" className="underline underline-offset-2" onClick={() => onOpenTask(createdTask)} data-testid="manager-item-open-task"><I18nText id="common.open_task" />{" "}</button>
                  )}
                  {createdTask && onExecute && createdTask.column === "ready" && !createdTask.archivedAt && (
                    <button
                      type="button"
                      className="inline-flex items-center gap-0.5 underline underline-offset-2"
                      onClick={() => onExecute(createdTask.id)}
                      data-testid="manager-item-execute"
                    >
                      <Play className="size-3" aria-hidden /><I18nText id="approvals.execute" />{" "}</button>
                  )}
                </p>
              )}
            </li>
          );
        })}
      </ol>

      {editable && (
        <footer className="flex flex-wrap items-center gap-2 pt-1">
          <p className="min-w-0 flex-1 text-[11px] text-muted-foreground" data-testid="manager-proposal-summary"><I18nText id="approvals.approve_adds" />{" "}{summary.create}{" "}<I18nText id="common.task" />{summary.create === 1 ? "" : englishPluralSuffix()}{" "}<I18nText id="approvals.to_the_backlog" />{" "}{summary.link > 0 ? tr("common.links_to_existing", { p0: String(summary.link) }) : ""}
            {summary.skip > 0 ? tr("common.leaves_out", { p0: String(summary.skip) }) : ""}<I18nText id="approvals.no_agent_is_started" />{" "}{savingDraft ? tr("common.saving_edits") : ""}
          </p>
          {confirmReject ? (
            <>
              <Button type="button" size="sm" variant="destructive" onClick={() => void reject()} disabled={busy != null} data-testid="manager-proposal-reject-confirm"><I18nText id="approvals.reject_proposal" />{" "}</Button>
              <Button type="button" size="sm" variant="ghost" onClick={() => setConfirmReject(false)} disabled={busy != null}><I18nText id="approvals.keep_it" />{" "}</Button>
            </>
          ) : (
            <Button type="button" size="sm" variant="outline" onClick={() => setConfirmReject(true)} disabled={busy != null} data-testid="manager-proposal-reject">
              <X className="size-3.5" aria-hidden /><I18nText id="common.reject" />{" "}</Button>
          )}
          <Button
            type="button"
            size="sm"
            onClick={() => void approve()}
            disabled={busy != null || problems.length > 0 || summary.create + summary.link + summary.skip === 0}
            data-testid="manager-proposal-approve"
          >
            {busy === "approve" ? <Loader2 className="size-3.5 motion-safe:animate-spin" aria-hidden /> : <Check className="size-3.5" aria-hidden />}
            {busy === "approve" ? tr("common.creating") : proposal.status === "partial" ? tr("common.retry_the_rest") : tr("common.approve")}
          </Button>
        </footer>
      )}
      {error && (
        <p role="alert" className="rounded-md border border-danger/40 bg-danger/10 px-2 py-1 text-[11px] text-danger" data-testid="manager-proposal-error">
          {error}
        </p>
      )}
      {proposal.status !== "rejected" && proposal.items.length > 1 && (
        <TaskPlanView
          projectPath={projectPath}
          proposalId={proposal.id}
          refreshToken={planRefreshToken}
          tasks={tasks}
          onOpenTask={onOpenTask}
          onExecute={onExecute}
          onOpenBatch={onOpenBatch}
        />
      )}
      {onOpenPlanSection && proposal.status !== "rejected" && proposal.items.length > 1 && (
        <Button type="button" size="sm" variant="ghost" onClick={onOpenPlanSection} data-testid="proposal-open-plan-section">
          <ListTree className="size-3.5" aria-hidden />{tr("uxfix.plan.openSection")}
        </Button>
      )}
      {onPrepareBatch && (proposal.status === "approved" || proposal.status === "partial") && (
        <footer className="flex flex-wrap items-center gap-2 pt-1">
          <p className="min-w-0 flex-1 text-[11px] text-muted-foreground"><I18nText id="approvals.run_these_tasks_with_one_approval_a_batch" /></p>
          <Button
            type="button"
            size="sm"
            variant="outline"
            disabled={batchBusy}
            onClick={() => {
              setBatchBusy(true);
              setBatchError(null);
              onPrepareBatch(proposal.id).catch((caught: unknown) => setBatchError(caught instanceof Error ? caught.message : String(caught))).finally(() => setBatchBusy(false));
            }}
            data-testid="manager-proposal-batch"
          >
            {batchBusy ? <Loader2 className="size-3.5 motion-safe:animate-spin" aria-hidden /> : <ListChecks className="size-3.5" aria-hidden />}<I18nText id="approvals.prepare_batch" />{" "}</Button>
          {batchError && <p role="alert" className="w-full break-words text-[11px] text-danger" data-testid="manager-proposal-batch-error">{batchError}</p>}
        </footer>
      )}
    </section>
  );
}
