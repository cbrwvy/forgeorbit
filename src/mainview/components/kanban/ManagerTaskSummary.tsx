import { TaskComputerResult } from "./TaskComputerWorkflow";
import { EmployeeRunReviewDialog } from "./EmployeeRunPanel";
import { buildPreflightBody, canOfferRun, reviewedRevisionOf } from "@/lib/employee-execution";
import type { EmployeeRunView } from "../../../shared/execution/run";
import type { TaskWorkspaceView } from "../../../shared/task-workspace";
import { useEffect, useRef, useState } from "react";
import { currentOutcomeReview, outcomeExcerpt, verifiedOutcomeTestCounts, type OutcomeTestEvidence } from "@/lib/manager-outcome";
import type { Task, TaskQcReview } from "../../../shared/types";
import { Badge } from "@/components/ui/badge";
import { managerStageTone, managerTaskView } from "@/lib/manager-task";
import { t as tr } from "@/i18n/core";
import { api } from "@/lib/api";
import { Button } from "@/components/ui/button";

export function ManagerTaskSummary({ task, onTaskChanged, onNext, onSetup }: {
  task: Task;
  onTaskChanged?: (taskId: string, patch: Partial<Task>) => void;
  onNext: (action: "setup" | "answer" | "review") => void;
  onSetup: (kind: "assignment" | "execution") => void;
}) {
  const view = managerTaskView(task);
  const [reviewInfo, setReviewInfo] = useState<{ key: string; review: TaskQcReview | null } | null>(null);
  const [testEvidence, setTestEvidence] = useState<{ key: string; evidence: OutcomeTestEvidence } | null>(null);
  const [workspace, setWorkspace] = useState<TaskWorkspaceView | null>(null);
  const workspaceRevision = useRef<string | undefined>(undefined);
  const [selectedPaths, setSelectedPaths] = useState<string[]>([]);
  const [applyApproved, setApplyApproved] = useState(false);
  const [busy, setBusy] = useState(false);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const [attempt, setAttempt] = useState<EmployeeRunView | null>(null);
  const [setupNeeded, setSetupNeeded] = useState<"assignment" | "execution" | null>(null);
  const [reviewConfirmation, setReviewConfirmation] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const stateKey = `${task.id}:${task.column}:${task.updatedAt}:${task.runId}:${task.qcState?.latestVerdict}:${task.qcState?.activeReviewId}`;
  useEffect(() => {
    let cancelled = false;
    setError(null);
    setSetupNeeded(null);
    setReviewConfirmation(false);
    // Only the latest review covering this output may describe the current result.
    void api.getTaskQc(task.id).then((bundle) => {
      if (cancelled) return;
      setReviewInfo({ key: stateKey, review: currentOutcomeReview(task.qcState, bundle.reviews) });
    }).catch(() => { if (!cancelled) setReviewInfo(null); });
    void api.getTaskWorkspace(task.id).then((ws) => {
      if (cancelled) return;
      setWorkspace(ws);
      const eligible = ws?.changes.filter(entry => entry.scope === "output" && entry.kind !== "unchanged") ?? [];
      const revision = JSON.stringify(ws && [ws.id, ws.status, ws.developerRunId, ws.publications.length,
        eligible.map(entry => [entry.path, entry.beforeSha256, entry.afterSha256])]);
      if (workspaceRevision.current !== revision) {
        workspaceRevision.current = revision;
        setApplyApproved(false);
        setSelectedPaths(eligible.map(entry => entry.path));
      }
    }).catch(() => { if (!cancelled) setWorkspace(null); });
    if (view.stage === "acceptance" || view.stage === "accepted") {
      void api.getTaskQcEvidence(task.id).then((evidence) => {
        if (!cancelled) setTestEvidence({ key: stateKey, evidence });
      }).catch(() => { if (!cancelled) setTestEvidence(null); });
    }
    return () => { cancelled = true; };
  }, [stateKey]);

  async function applyWorkingCopy() {
    if (busy || !applyApproved || selectedPaths.length === 0) return;
    setBusy(true);
    setError(null);
    try {
      const updatedWs = await api.publishTaskWorkspace({ taskId: task.id, approve: true, paths: selectedPaths });
      setWorkspace(updatedWs);
      setApplyApproved(false);
      const updated = await api.getTask(task.id);
      onTaskChanged?.(task.id, updated);
    } catch (e) { setError(e instanceof Error ? e.message : String(e)); }
    finally { setBusy(false); }
  }

  async function discardWorkingCopy() {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      const updatedWs = await api.abandonTaskWorkspace(task.id);
      setWorkspace(updatedWs);
      setSelectedPaths([]);
      setApplyApproved(false);
    } catch (e) { setError(e instanceof Error ? e.message : String(e)); }
    finally { setBusy(false); }
  }

  async function advance(action: "admit" | "ready" | "accept" | "return") {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      // Existing endpoints retain all workflow, permission and acceptance gates.
      const updated = action === "admit" ? await api.admitTaskToInbox(task.id)
        : await api.moveTask(task.id, action === "accept" ? "done" : "ready");
      onTaskChanged?.(task.id, updated);
    } catch (e) { setError(e instanceof Error ? e.message : String(e)); }
    finally { setBusy(false); }
  }

  async function prepareWork() {
    setBusy(true);
    setError(null);
    try {
      if (!task.agent || !task.model) { setSetupNeeded("execution"); return; }
      const draft = { harnessId: task.agent, model: task.model, effort: task.effort ?? "", complexity: "" as const };
      const result = await api.employeeExecutionPreflight(buildPreflightBody(task.id, draft, null));
      if (!canOfferRun(result.preflight, false)) {
        if (task.computerWorkflowRevision) setError(result.preflight.blockingErrors.map(issue => issue.message).join("\n") || null);
        setSetupNeeded(result.preflight.blockingErrors.some((issue) => ["no-assignment", "employee-missing", "employee-inactive"].includes(issue.code)) ? "assignment" : "execution");
        return;
      }
      const prepared = await api.employeeExecutionReview(buildPreflightBody(task.id, draft, reviewedRevisionOf(result.preflight)));
      if (prepared.attempt) setAttempt(prepared.attempt);
      else {
        if (task.computerWorkflowRevision) setError(prepared.blockingErrors.map(issue => issue.message).join("\n") || null);
        setSetupNeeded("execution");
      }
    } catch (e) { setError(e instanceof Error ? e.message : String(e)); }
    finally { setBusy(false); }
  }
  async function startReview() {
    setBusy(true);
    setError(null);
    try {
      if (!task.agent || !task.model) { setSetupNeeded("execution"); return; }
      const prepared = await api.prepareTaskQcReview(task.id, { reviewerHarness: task.agent, reviewerModel: task.model });
      await api.startTaskQcReview(task.id, prepared.review.id);
      setReviewConfirmation(false);
      const updated = await api.getTask(task.id);
      onTaskChanged?.(task.id, updated);
    } catch (e) { setError(e instanceof Error ? e.message : String(e)); }
    finally { setBusy(false); }
  }
  const review = reviewInfo?.key === stateKey ? reviewInfo.review : null;
  const summary = outcomeExcerpt(review?.summary);
  const delivered = view.stage === "acceptance" || view.stage === "accepted";
  const blockedForReply = view.stage === "blocked" && task.pendingInteractionCount > 0;
  const testCounts = delivered ? verifiedOutcomeTestCounts(task.id, review, testEvidence?.key === stateKey ? testEvidence.evidence : null) : null;
  const managedAction = task.objectiveMissionId && (view.action === "ready" || view.action === "admit" ||
    view.action === "setup" || view.action === "review" || view.action === "answer");
  const action = task.archivedAt == null && !task.pipelineId && !task.pipelineParentId && !managedAction ? view.action : null;
  const workingCopyReady = workspace?.writeScope === "working-copy"
    && (workspace.status === "settled" || workspace.status === "publication-partial" || workspace.status === "published");
  const workingCopyChanges = workingCopyReady
    ? workspace.changes.filter((entry) => entry.scope === "output" && entry.kind !== "unchanged")
    : [];
  const workingCopyChecks = workingCopyReady ? (workspace.checks ?? []) : [];
  const workingCopySummary = workingCopyReady ? workspace.checkSummary : undefined;
  return (
    <section className="shrink-0 space-y-3 border-b border-border/60 p-4" data-testid="manager-task-summary" data-stage={view.stage}>
      <h2 className="break-words text-lg font-semibold [overflow-wrap:anywhere]">{task.title}</h2>
      <Badge variant={managerStageTone[view.stage]} role="status" data-testid="manager-task-status">
        {tr(blockedForReply ? "manager.stage.reply" : `manager.stage.${view.stage}`)}
      </Badge>
      {delivered ? <div className="space-y-2" data-testid="manager-task-outcome">
        <h3 className="text-sm font-semibold">{tr("manager.outcome.title")}</h3>
        <p className="break-words text-sm [overflow-wrap:anywhere]" data-testid="manager-task-result">{summary ?? tr("manager.outcome.unavailable")}</p>
        {testCounts && <p className="text-xs text-muted-foreground" data-testid="manager-outcome-tests">
          {tr("manager.outcome.tests", { passed: testCounts.passed, failed: testCounts.failed })}{testCounts.skipped > 0 ? ` · ${tr("manager.outcome.skipped", { count: testCounts.skipped })}` : ""}
        </p>}
        {review && Array.isArray(review.findings) && <div className="text-xs text-muted-foreground" data-testid="manager-outcome-findings">
          <p>{tr(review.findings.length === 0 ? "manager.outcome.no-findings" : "manager.outcome.findings", { count: review.findings.length })}</p>
          {review.findings.length > 0 && <ul className="mt-1 space-y-1">
            {review.findings.slice(0, 2).map((finding, index) => <li className="line-clamp-1" key={index}>{outcomeExcerpt(finding.text)}</li>)}
          </ul>}
        </div>}
      </div> : <p className="line-clamp-3 text-sm text-muted-foreground" data-testid="manager-task-result">
        {view.stage === "blocked" && task.qcState?.latestVerdict === "BLOCKED" && summary ? summary : tr(blockedForReply ? "manager.summary.reply" : `manager.summary.${view.stage}`)}
      </p>}
      <TaskComputerResult task={task} />
      {managedAction && <p className="text-xs text-muted-foreground">{tr("objective.managedTask")}</p>}
      {workingCopyReady && workspace && (
        <div className="space-y-2 rounded-lg border border-border/70 bg-muted/20 p-3 text-xs" data-testid="manager-working-copy" data-status={workspace.status}>
          <div className="flex flex-wrap items-center justify-between gap-2">
            <h3 className="font-semibold">{tr("manager.workingCopy.title")}</h3>
            <span className="text-muted-foreground">
              {workingCopyChanges.length > 0
                ? tr("manager.workingCopy.files_count", { count: workingCopyChanges.length })
                : tr("manager.workingCopy.no_changes")}
            </span>
          </div>
          <p className="text-muted-foreground">
            {tr(workspace.status === "published" ? "manager.workingCopy.applied" : "manager.workingCopy.unchanged_original")}
          </p>
          <div className="space-y-1" data-testid="manager-working-copy-checks">
            <p className="font-medium text-muted-foreground">{tr("manager.workingCopy.checks_title")}</p>
            {workingCopyChecks.length === 0 ? (
              <p className="text-muted-foreground" data-testid="manager-working-copy-checks-not-run">{tr("manager.workingCopy.checks_not_run")}</p>
            ) : (
              <>
                {workingCopySummary && (
                  <p className="text-muted-foreground">
                    {tr("manager.workingCopy.checks_summary", {
                      passed: workingCopySummary.passed,
                      failed: workingCopySummary.failed,
                      blocked: workingCopySummary.blocked,
                    })}
                  </p>
                )}
                <ul className="space-y-1">
                  {workingCopyChecks.slice(-6).map((check) => (
                    <li key={check.id} className="flex flex-wrap items-center justify-between gap-2 rounded border border-border/50 px-2 py-1">
                      <code className="break-all text-[11px]">{check.command}</code>
                      <span className={check.status === "passed" ? "font-medium text-success" : check.status === "failed" || check.status === "blocked" ? "font-medium text-destructive" : "font-medium text-warning"}>
                        {tr(`taskWorkspace.workingCopy.check_status.${check.status}`)}
                        {check.exitCode != null ? ` (${check.exitCode})` : ""}
                      </span>
                    </li>
                  ))}
                </ul>
              </>
            )}
          </div>
          {workspace.interruption && (
            <p className="text-warning" data-testid="manager-working-copy-interrupted">{tr("manager.workingCopy.interrupted")}</p>
          )}
          {workingCopyChanges.length > 0 && (
            <div className="space-y-1.5">
              {workspace.status !== "published" && !workspace.interruption && workingCopyChanges.length > 1 && (
                <div className="flex gap-2">
                  <Button type="button" size="sm" variant="ghost" className="h-6 px-2 text-[11px]" onClick={() => setSelectedPaths(workingCopyChanges.map((entry) => entry.path))}>
                    {tr("manager.workingCopy.select_all")}
                  </Button>
                  <Button type="button" size="sm" variant="ghost" className="h-6 px-2 text-[11px]" onClick={() => setSelectedPaths([])}>
                    {tr("manager.workingCopy.clear_selection")}
                  </Button>
                </div>
              )}
              <ul className="max-h-32 space-y-1 overflow-y-auto">
                {workingCopyChanges.map((entry) => (
                  <li key={entry.path} className="flex items-center gap-2 font-mono text-[11px]">
                    {workspace.status !== "published" && !workspace.interruption ? (
                      <input
                        type="checkbox"
                        checked={selectedPaths.includes(entry.path)}
                        onChange={(e) => setSelectedPaths((prev) => e.target.checked ? [...prev, entry.path] : prev.filter((p) => p !== entry.path))}
                      />
                    ) : null}
                    <span className="truncate">{entry.kind} {entry.path}</span>
                  </li>
                ))}
              </ul>
              {workspace.diff && (
                <details data-testid="manager-working-copy-diff">
                  <summary className="cursor-pointer font-medium text-muted-foreground">{tr("manager.workingCopy.view_diff")}</summary>
                  <pre className="mt-1.5 max-h-56 overflow-auto whitespace-pre-wrap break-all rounded border border-border/60 bg-background p-2 font-mono text-[11px]">{workspace.diff}</pre>
                </details>
              )}
              {(workspace.status === "settled" || workspace.status === "publication-partial") && !workspace.interruption && (
                <div className="space-y-2 pt-1">
                  <label className="flex items-start gap-2">
                    <input
                      type="checkbox"
                      className="mt-0.5"
                      checked={applyApproved}
                      data-testid="manager-working-copy-approve"
                      onChange={(e) => setApplyApproved(e.target.checked)}
                    />
                    <span>{tr("manager.workingCopy.apply_confirm")}</span>
                  </label>
                  <div className="flex flex-wrap gap-2">
                    <Button type="button" size="sm" disabled={busy || !applyApproved || selectedPaths.length === 0} data-testid="manager-working-copy-apply" onClick={() => void applyWorkingCopy()}>
                      {tr("manager.workingCopy.apply_button")}
                    </Button>
                    <Button type="button" size="sm" variant="outline" disabled={busy} data-testid="manager-working-copy-discard" onClick={() => void discardWorkingCopy()}>
                      {tr("manager.workingCopy.discard_button")}
                    </Button>
                  </div>
                </div>
              )}
            </div>
          )}
          {workspace.status === "settled" && (workingCopyChanges.length === 0 || workspace.interruption) && (
            <Button type="button" size="sm" variant="outline" disabled={busy} data-testid="manager-working-copy-discard" onClick={() => void discardWorkingCopy()}>
              {tr("manager.workingCopy.discard_button")}
            </Button>
          )}
        </div>
      )}
      {action === "accept" && <p className="text-xs text-muted-foreground">{tr("manager.accept.explain")}</p>}
      {setupNeeded && <p className="text-sm text-muted-foreground" data-testid="manager-task-setup">{tr(setupNeeded === "assignment" ? "manager.setup.assignment" : "manager.setup.execution")}</p>}
      {reviewConfirmation && <p className="text-xs text-muted-foreground">{tr("manager.review.explain")}</p>}
      {action && (
        <div className="flex flex-wrap gap-2">
          <Button ref={triggerRef} size="sm" disabled={busy} data-testid="manager-task-primary" onClick={() => {
            if (setupNeeded) onSetup(setupNeeded);
            else if (action === "setup") void prepareWork();
            else if (action === "answer") onNext(action);
            else if (action === "review") { if (reviewConfirmation) void startReview(); else setReviewConfirmation(true); }
            else void advance(action);
          }}>{tr(setupNeeded ? (setupNeeded === "assignment" ? "manager.setup.team" : "manager.setup.action") : reviewConfirmation ? "manager.review.start" : blockedForReply ? "manager.action.reply" : `manager.action.${action}`)}</Button>
          {action === "accept" && <Button size="sm" variant="outline" disabled={busy} title={tr("manager.return.explain")} data-testid="manager-task-return" onClick={() => void advance("return")}>{tr("manager.return")}</Button>}
        </div>
      )}
      {attempt && <EmployeeRunReviewDialog attempt={attempt} returnFocusRef={triggerRef} onClose={() => setAttempt(null)} onStarted={() => { setAttempt(null); void api.getTask(task.id).then((updated) => onTaskChanged?.(task.id, updated)); }} />}
      {error && <div className="space-y-1 text-xs" role="alert">
        <p className="text-destructive">{tr("manager.operation.failed")}</p>
        <details><summary className="cursor-pointer text-muted-foreground">{tr("manager.details")}</summary><p className="max-h-32 overflow-y-auto whitespace-pre-wrap break-words">{error}</p></details>
      </div>}
    </section>
  );
}
