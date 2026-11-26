import { LaunchTarget } from "@/components/ui/launch-target";
import { PermissionDisclosureView } from "../../kanban/PermissionDisclosure";
import { AccessModeDisclosure } from "../../kanban/AccessModeDisclosure";
import { I18nText, UsageNotice, useLocale as useUILocale } from "@/i18n/react";
import { englishPluralSuffix, intlLocale, t as tr } from "@/i18n/core";
import { codeLabel } from "@/i18n/presentation";

import { useEffect, useRef, useState } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import {
  AlertTriangle,
  Check,
  CircleAlert,
  ExternalLink,
  Info,
  Loader2,
  Pencil,
  Play,
  RefreshCw,
  RotateCcw,
  Square,
  Undo2,
  Wrench,
  X,
} from "lucide-react";
import { ApiError, api } from "@/lib/api";
import { usePipelines } from "@/lib/pipelines";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { cn } from "@/lib/utils";
import { ASSISTANT_MD_COMPONENTS, MD_URL_TRANSFORM } from "../../kanban/md-components";
import { TaskLaunchPickers, useTaskLaunch } from "../../kanban/TaskLaunchPickers";
import { PipelinePicker } from "../../pipelines/PipelinePicker";
import {
  EXECUTION_LIMITS,
  PHASE_TEXT,
  hasBlockingCheck,
  isSettledPhase,
  type ExecutionCheck,
  type ExecutionConfig,
  type ExecutionPhase,
  type ExecutionResult,
  type ExecutionView,
} from "../../../../shared/project-execution.ts";
import type { Task } from "../../../../shared/types.ts";

interface Props {
  projectPath: string;
  execution: ExecutionView;
  tasks: Task[];
  onChanged: (execution: ExecutionView) => void;
  onOpenTask: (task: Task) => void;
  onManageAgents: () => void;
}

function messageOf(reason: unknown): string {
  if (reason instanceof ApiError || reason instanceof Error) return reason.message;
  return String(reason);
}

/** A newer view carried in an error body (409s return the refreshed card). */
function executionIn(reason: unknown): ExecutionView | null {
  if (!(reason instanceof ApiError)) return null;
  const body = reason.body as { execution?: ExecutionView } | null;
  return body?.execution ?? null;
}

const PHASE_TONE: Record<ExecutionPhase, string> = {
  proposed: "bg-info/15 text-info",
  starting: "bg-info/15 text-info",
  running: "bg-info/15 text-info",
  waiting: "bg-warning/15 text-warning",
  review: "bg-warning/15 text-warning",
  failed: "bg-danger/15 text-danger",
  stopped: "bg-muted text-muted-foreground",
  accepted: "bg-success/15 text-success",
  returned: "bg-muted text-muted-foreground",
  "start-failed": "bg-danger/15 text-danger",
  dismissed: "bg-muted text-muted-foreground",
  missing: "bg-muted text-muted-foreground",
};

/** Card buttons wrap their label instead of overflowing a narrow chat column. */
const ACTION = "h-auto min-h-8 max-w-full whitespace-normal text-left";

const ACCESS_TEXT = [tr("common.read_only_plan"), "Asks before acting", "Accepts edits, asks for commands", "Hands-off", "No permission checks"];

export function CheckLine({ check }: { check: ExecutionCheck }) {
  useUILocale();
  const Icon = check.level === "error" ? CircleAlert : check.level === "warning" ? AlertTriangle : Info;
  return (
    <li
      className={cn(
        "relative flex items-start gap-1.5",
        check.level === "error" && "text-danger",
        check.level === "warning" && "text-warning",
        check.level === "info" && "text-muted-foreground",
      )}
      data-testid="execution-check"
      data-level={check.level}
      data-code={check.code}
    >
      <Icon className="mt-0.5 size-3 shrink-0" aria-hidden />
      <span className="relative min-w-0">
        <span className="sr-only">{check.level === "error" ? tr("common.problem") : check.level === "warning" ? tr("common.warning") : tr("common.note_4ced86")}</span>
        {check.message}
      </span>
    </li>
  );
}

function when(at: number | null): string {
  if (!at) return "—";
  return new Date(at).toLocaleString(intlLocale(), { hour: "2-digit", minute: "2-digit", month: "short", day: "numeric" });
}

function duration(from: number, to: number | null): string {
  const ms = Math.max(0, (to ?? Date.now()) - from);
  const minutes = Math.floor(ms / 60_000);
  if (minutes < 1) return tr("common.under_a_minute");
  if (minutes < 60) return tr("common.min", { p0: String(minutes) });
  return tr("common.h_min", { p0: String(Math.floor(minutes / 60)), p1: String(minutes % 60) });
}

/**
 * A supervised run of one task (FO-005B): the proposed configuration and
 * its checks, the owner's approval, then the live state of the run read
 * from the board, and the result to review. Nothing starts until the owner
 * presses "Approve & execute"; the run itself happens in the board's normal
 * runtime and is always reachable through "Open run".
 */
export function ExecutionCard({ projectPath, execution, tasks, onChanged, onOpenTask, onManageAgents }: Props) {
  useUILocale();
  const [busy, setBusy] = useState<string | null>(null);
  const busyRef = useRef<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [editing, setEditing] = useState(false);
  const [fullAccessAck, setFullAccessAck] = useState(false);
  const [acknowledged, setAcknowledged] = useState(false);
  const [fixOpen, setFixOpen] = useState(false);
  const [fixText, setFixText] = useState("");
  const [result, setResult] = useState<ExecutionResult | null>(null);
  const [resultError, setResultError] = useState<string | null>(null);
  const [alreadyRunning, setAlreadyRunning] = useState<string | null>(null);

  const task = tasks.find((item) => item.id === execution.taskId) ?? null;
  // A batch's own failed start is retried by the batch, not approved here.
  const reviewable = execution.source !== "batch" && (execution.status === "proposed" || execution.status === "start-failed");
  const blocking = hasBlockingCheck(execution.checks);
  const settled = isSettledPhase(execution.phase);
  const title = execution.live.title ?? execution.taskTitle;

  // A new usage notice needs a new acknowledgement.
  useEffect(() => {
    setAcknowledged(false);
    setFullAccessAck(false);
  }, [execution.usageNotice, execution.revision]);

  // Load the result once the run settles (and again after each later run:
  // a fix request produces a new run of the same task).
  const resultKey = settled ? `${execution.phase}:${execution.live.run?.id ?? ""}:${execution.live.run?.status ?? ""}:${execution.live.pipeline?.status ?? ""}` : null;
  useEffect(() => {
    if (!resultKey) {
      setResult(null);
      return;
    }
    let cancelled = false;
    setResultError(null);
    api.executionResult(projectPath, execution.id).then(
      (next) => { if (!cancelled) setResult(next); },
      (reason: unknown) => { if (!cancelled) setResultError(messageOf(reason)); },
    );
    return () => { cancelled = true; };
  }, [resultKey, projectPath, execution.id]);

  const run = async (label: string, action: () => Promise<ExecutionView | null>) => {
    if (busyRef.current) return;
    busyRef.current = label;
    setBusy(label);
    setError(null);
    try {
      const next = await action();
      if (next) onChanged(next);
    } catch (caught) {
      const fresh = executionIn(caught);
      if (fresh) onChanged(fresh);
      if (caught instanceof ApiError && (caught.body as { alreadyRunning?: boolean } | null)?.alreadyRunning) {
        setAlreadyRunning(messageOf(caught));
      } else {
        setError(messageOf(caught));
      }
    } finally {
      busyRef.current = null;
      setBusy(null);
    }
  };

  const approve = () => run("approve", async () => {
    const res = await api.approveExecution(projectPath, execution.id, execution.revision, acknowledged, fullAccessAck);
    return res.execution;
  });
  const recheck = () => run("check", () => api.recheckExecution(projectPath, execution.id));
  const dismiss = () => run("dismiss", () => api.dismissExecution(projectPath, execution.id));
  const review = (action: "accept" | "return" | "fix" | "stop", text?: string) =>
    run(action, async () => {
      const next = await api.reviewExecution(projectPath, execution.id, action, text);
      if (action === "fix") {
        setFixText("");
        setFixOpen(false);
      }
      return next;
    });
  const saveConfig = (config: Partial<ExecutionConfig>) =>
    run("save", async () => {
      const next = await api.updateExecution(projectPath, execution.id, execution.revision, config);
      setEditing(false);
      return next;
    });

  const live = execution.live;
  const running = execution.phase === "running" || execution.phase === "waiting" || execution.phase === "starting";
  const executor = execution.resolved.pipelineName
    ? tr("common.pipeline_d1e480", { p0: String(execution.resolved.pipelineName) })
    : execution.resolved.profileName
      ? `${execution.resolved.profileName} (${execution.resolved.harnessLabel})`
      : execution.resolved.harnessLabel;
  const errors = execution.checks.filter((item) => item.level === "error");
  const warnings = execution.checks.filter((item) => item.level === "warning");
  const notes = execution.checks.filter((item) => item.level === "info");
  const otherRunTask = live.otherRun ? task : null;

  return (
    <section
      id={`execution-${execution.id}`}
      className="space-y-2 rounded-xl border border-primary/30 bg-primary/5 p-3 text-xs"
      aria-label={`${reviewable ? tr("common.ready_to_execute") : tr("common.supervised_run")}: ${title}`}
      data-testid="execution-card"
      data-execution-id={execution.id}
      data-phase={execution.phase}
      data-status={execution.status}
    >
      <header className="flex flex-wrap items-start justify-between gap-2">
        <div className="min-w-0">
          <p className="text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
            {reviewable ? tr("common.ready_to_execute_580f5f") : tr("common.supervised_run")}
            {execution.source === "manager" ? tr("common.suggested_by_the_manager") : ""}
            {execution.source === "batch" ? tr("common.started_by_an_approved_batch") : ""}
          </p>
          <h4 className="break-words text-sm font-semibold" data-testid="execution-title">{title}</h4>
          <p className="text-[11px] text-muted-foreground"><I18nText id="approvals.task" />{execution.taskId.slice(0, 8)}</p>
        </div>
        <span
          className={cn("inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[11px] font-medium", PHASE_TONE[execution.phase])}
          role="status"
          data-testid="execution-phase"
        >
          {(execution.phase === "running" || execution.phase === "starting") && (
            <Loader2 className="size-3 motion-safe:animate-spin" aria-hidden />
          )}
          {PHASE_TEXT[execution.phase]}
        </span>
      </header>

      {reviewable && <p className="text-muted-foreground" data-testid="execution-reason">{execution.reason}</p>}

      <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-1" data-testid="execution-config">
        <dt className="text-muted-foreground"><I18nText id="approvals.executor" /></dt>
        <dd className="min-w-0 break-words" data-testid="execution-executor">{executor}</dd>
        {execution.resolved.pipelineSteps.length > 0 && (
          <>
            <dt className="text-muted-foreground"><I18nText id="common.steps" /></dt>
            <dd className="min-w-0">
              <ol className="list-decimal pl-4">
                {execution.resolved.pipelineSteps.map((step, index) => (
                  <li key={`${index}-${step.name}`} className="break-words">{step.name} — {step.agent}</li>
                ))}
              </ol>
            </dd>
          </>
        )}
        {!execution.resolved.pipelineName && (
          <>
            <dt className="text-muted-foreground"><I18nText id="common.model" /></dt>
            <dd className="min-w-0 break-words" data-testid="execution-model">
              {execution.resolved.modelLabel}
              {execution.config.effort ? tr("common.effort_654293", { p0: String(execution.config.effort) }) : ""}
            </dd>
            <dt className="text-muted-foreground"><I18nText id="approvals.access" /></dt>
            <dd className={cn("min-w-0 break-words", execution.resolved.accessLevel >= 3 && "text-warning")} data-testid="execution-mode">
              {execution.resolved.modeLabel}
              {!execution.resolved.permission && <span className="text-muted-foreground"> — {ACCESS_TEXT[execution.resolved.accessLevel] ?? tr("common.hands_off")}</span>}
            </dd>
          </>
        )}
        <dt className="text-muted-foreground"><I18nText id="common.workspace" /></dt>
        <dd className="min-w-0 break-all" data-testid="execution-workspace">
          {execution.resolved.workspace}
          <span className="text-muted-foreground"> · {execution.resolved.isolation === "worktree" ? tr("common.git_worktree") : tr("common.no_isolation")}</span>
        </dd>
      </dl>

      {reviewable && (errors.length > 0 || warnings.length > 0) && (
        <ul className="space-y-1" aria-label={tr("approvals.checks_before_running")}>
          {[...errors, ...warnings].map((item, index) => <CheckLine key={`${item.code}-${index}`} check={item} />)}
        </ul>
      )}
      {reviewable && notes.length > 0 && (
        <details className="text-[11px]">
          <summary className="cursor-pointer text-muted-foreground"><I18nText id="approvals.notes" />{notes.length})</summary>
          <ul className="mt-1 space-y-1">
            {notes.map((item, index) => <CheckLine key={`${item.code}-${index}`} check={item} />)}
          </ul>
        </details>
      )}

      {execution.status === "start-failed" && execution.error && (
        <p role="alert" className="rounded-md border border-danger/40 bg-danger/10 px-2 py-1 text-danger" data-testid="execution-start-error"><I18nText id="approvals.couldn_t_start" />{" "}{execution.error}
        </p>
      )}

      {reviewable && live.otherRun && (
        <div className="flex flex-wrap items-center gap-2 rounded-md border border-info/40 bg-info/10 px-2 py-1.5 text-info" data-testid="execution-other-run">
          <span className="min-w-0 flex-1"><I18nText id="approvals.this_task_is_already_running_it_was_started" /></span>
          {otherRunTask && (
            <Button className={ACTION} type="button" size="sm" variant="outline" onClick={() => onOpenTask(otherRunTask)}>
              <ExternalLink className="size-3.5" aria-hidden /><I18nText id="approvals.open_run" />{" "}</Button>
          )}
        </div>
      )}

      {alreadyRunning && (
        <div className="flex flex-wrap items-center gap-2 rounded-md border border-info/40 bg-info/10 px-2 py-1.5 text-info" data-testid="execution-already-running">
          <span className="min-w-0 flex-1">{alreadyRunning}</span>
          {task && (
            <Button className={ACTION} type="button" size="sm" variant="outline" onClick={() => onOpenTask(task)}>
              <ExternalLink className="size-3.5" aria-hidden /><I18nText id="approvals.open_run" />{" "}</Button>
          )}
        </div>
      )}

      {reviewable && editing && (
        <ExecutionEditor
          config={execution.config}
          busy={busy != null}
          onCancel={() => setEditing(false)}
          onSave={(config) => void saveConfig(config)}
          onManageAgents={onManageAgents}
        />
      )}

      {execution.resolved.launchTarget && <LaunchTarget facts={execution.resolved.launchTarget} testId="execution-launch-target" />}
      {execution.resolved.permission && <PermissionDisclosureView disclosure={execution.resolved.permission} />}
      {execution.resolved.accessDiagnostics && <AccessModeDisclosure diagnostics={execution.resolved.accessDiagnostics} testId="execution-access-diagnostics" compact />}
      {reviewable && !editing && execution.resolved.permission?.sandbox === "danger-full-access" && <label className="flex gap-2 text-xs text-warning"><input type="checkbox" checked={fullAccessAck} onChange={(e) => setFullAccessAck(e.target.checked)} />{tr("permission.full-access-consent")}</label>}
      {reviewable && !editing && execution.usageNotice && (
        <label className="flex items-start gap-2 rounded-md border border-warning/40 bg-warning/10 px-2 py-1.5 text-warning">
          <input
            type="checkbox"
            className="mt-0.5"
            checked={acknowledged}
            onChange={(event) => setAcknowledged(event.target.checked)}
            data-testid="execution-acknowledge"
          />
          <span><I18nText id="approvals.i_understand_this_run_may_be_billed_to" /></span>
        </label>
      )}

      {reviewable && !editing && (
        <footer className="flex flex-wrap items-center gap-2 pt-1">
          <Button className={ACTION}
            type="button"
            size="sm"
            onClick={() => void approve()}
            disabled={busy != null || blocking || (execution.resolved.permission?.sandbox === "danger-full-access" && !fullAccessAck) || (execution.usageNotice != null && !acknowledged)}
            data-testid="execution-approve"
          >
            {busy === "approve" ? <Loader2 className="size-3.5 motion-safe:animate-spin" aria-hidden /> : <Play className="size-3.5" aria-hidden />}
            {busy === "approve" ? tr("common.starting") : execution.status === "start-failed" ? tr("common.retry") : tr("common.approve_execute")}
          </Button>
          <Button className={ACTION} type="button" size="sm" variant="outline" onClick={() => setEditing(true)} disabled={busy != null} data-testid="execution-edit">
            <Pencil className="size-3.5" aria-hidden /><I18nText id="approvals.edit_configuration" />{" "}</Button>
          <Button className={ACTION} type="button" size="sm" variant="ghost" onClick={() => void recheck()} disabled={busy != null} data-testid="execution-recheck">
            <RefreshCw className={cn("size-3.5", busy === "check" && "motion-safe:animate-spin")} aria-hidden /><I18nText id="approvals.check_again" />{" "}</Button>
          <Button className={ACTION} type="button" size="sm" variant="ghost" onClick={() => void dismiss()} disabled={busy != null} data-testid="execution-cancel">
            <X className="size-3.5" aria-hidden /><I18nText id="common.cancel" />{" "}</Button>
          <span className="w-full text-[11px] text-muted-foreground sm:ml-auto sm:w-auto">
            {blocking ? tr("common.fix_the_problems_above_to_run") : tr("common.nothing_runs_until_you_approve")}
          </span>
        </footer>
      )}

      {execution.status === "started" && (
        <div className="space-y-2" data-testid="execution-monitor">
          <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-1">
            <dt className="text-muted-foreground"><I18nText id="common.run" /></dt>
            <dd className="min-w-0 break-all" data-testid="execution-run-id">
              {live.run ? `#${live.run.id.slice(0, 8)} · ${live.run.status}` : live.pipeline ? tr("common.pipeline_run") : "—"}
              {live.runCount > 1 ? tr("common.runs_4236b7", { p0: String(live.runCount) }) : ""}
            </dd>
            <dt className="text-muted-foreground"><I18nText id="common.started" /></dt>
            <dd>
              {when(execution.startedAt)}
              {execution.startedAt ? ` · ${running ? tr("common.running_for") : "took"} ${duration(execution.startedAt, running ? null : live.run?.endedAt ?? null)}` : ""}
            </dd>
            {live.pipeline && (
              <>
                <dt className="text-muted-foreground"><I18nText id="common.pipeline" /></dt>
                <dd className="min-w-0 break-words" data-testid="execution-pipeline">
                  {codeLabel(live.pipeline.status)} · {live.pipeline.completed}{" "}<I18nText id="common.of" />{" "}{live.pipeline.total}{" "}<I18nText id="approvals.steps_finished" />{" "}{live.pipeline.activeSteps.length > 0 ? tr("common.now", { p0: String(live.pipeline.activeSteps.join(", ")) }) : ""}
                </dd>
              </>
            )}
            {live.pendingQuestions > 0 && (
              <>
                <dt className="text-muted-foreground"><I18nText id="approvals.questions" /></dt>
                <dd className="text-warning">{live.pendingQuestions}{" "}<I18nText id="approvals.waiting_for_your_answer_open_the_run" /></dd>
              </>
            )}
          </dl>

          {settled && (
            <ExecutionResultView result={result} error={resultError} />
          )}

          <div className="flex flex-wrap items-center gap-2">
            {task && (
              <Button className={ACTION} type="button" size="sm" variant="outline" onClick={() => onOpenTask(task)} data-testid="execution-open-run">
                <ExternalLink className="size-3.5" aria-hidden /><I18nText id="approvals.open_run" />{" "}</Button>
            )}
            {running && execution.phase !== "starting" && (
              <Button className={ACTION} type="button" size="sm" variant="ghost" onClick={() => void review("stop")} disabled={busy != null} data-testid="execution-stop">
                <Square className="size-3.5" aria-hidden /><I18nText id="common.stop" />{" "}</Button>
            )}
            {settled && execution.phase !== "accepted" && (
              <>
                {!live.pipeline && live.run && (
                  <Button className={ACTION} type="button" size="sm" variant="outline" onClick={() => setFixOpen((open) => !open)} disabled={busy != null} data-testid="execution-fix">
                    <Wrench className="size-3.5" aria-hidden /><I18nText id="approvals.request_fix" />{" "}</Button>
                )}
                {!live.pipeline && execution.phase !== "returned" && (
                  <Button className={ACTION} type="button" size="sm" variant="ghost" onClick={() => void review("return")} disabled={busy != null} data-testid="execution-return">
                    <Undo2 className="size-3.5" aria-hidden /><I18nText id="approvals.return_to_backlog" />{" "}</Button>
                )}
                {(!live.pipeline || live.pipeline.status === "done") && (
                  <Button className={ACTION} type="button" size="sm" onClick={() => void review("accept")} disabled={busy != null} data-testid="execution-accept">
                    <Check className="size-3.5" aria-hidden /><I18nText id="approvals.accept_result" />{" "}</Button>
                )}
              </>
            )}
          </div>

          {fixOpen && (
            <form
              className="space-y-1.5"
              onSubmit={(event) => {
                event.preventDefault();
                const text = fixText.trim();
                if (text) void review("fix", text);
              }}
            >
              <label htmlFor={`fix-${execution.id}`} className="text-[11px] text-muted-foreground"><I18nText id="approvals.what_should_the_agent_fix_this_is_sent" />{" "}</label>
              <Textarea
                id={`fix-${execution.id}`}
                value={fixText}
                rows={3}
                maxLength={EXECUTION_LIMITS.fixChars}
                onChange={(event) => setFixText(event.target.value)}
                data-testid="execution-fix-text"
              />
              <div className="flex gap-2">
                <Button className={ACTION} type="submit" size="sm" disabled={busy != null || !fixText.trim()} data-testid="execution-fix-send">
                  <RotateCcw className="size-3.5" aria-hidden /><I18nText id="approvals.send_fix_request" />{" "}</Button>
                <Button className={ACTION} type="button" size="sm" variant="ghost" onClick={() => setFixOpen(false)}><I18nText id="common.cancel" /></Button>
              </div>
            </form>
          )}
        </div>
      )}

      {error && (
        <p role="alert" className="rounded-md border border-danger/40 bg-danger/10 px-2 py-1 text-danger" data-testid="execution-error">
          {error}
        </p>
      )}
    </section>
  );
}

function ExecutionResultView({ result, error }: { result: ExecutionResult | null; error: string | null }) {
  useUILocale();
  if (error) return <p className="text-danger" data-testid="execution-result-error"><I18nText id="approvals.couldn_t_load_the_result" />{" "}{error}</p>;
  if (!result) {
    return (
      <p className="flex items-center gap-1.5 text-muted-foreground">
        <Loader2 className="size-3 motion-safe:animate-spin" aria-hidden /><I18nText id="approvals.loading_the_result" />{" "}</p>
    );
  }
  const files = result.changes.files;
  return (
    <div className="space-y-2 rounded-lg border border-border bg-background/40 p-2" data-testid="execution-result">
      <p>
        <span className="font-medium"><I18nText id="approvals.result" /></span>{" "}
        {result.runStatus ?? tr("common.unknown_b23a6a")}
        {result.exitCode != null && result.exitCode !== 0 ? tr("common.exit_code", { p0: String(result.exitCode) }) : ""}
      </p>
      <div>
        <p className="font-medium"><I18nText id="approvals.changed_files" /></p>
        {files.length === 0 ? (
          <p className="text-muted-foreground" data-testid="execution-result-no-changes">{result.changes.note ?? tr("common.no_changes")}</p>
        ) : (
          <ul className="mt-0.5 space-y-0.5" data-testid="execution-result-files">
            {files.slice(0, 12).map((file) => (
              <li key={file.path} className="flex min-w-0 items-baseline gap-2">
                <span className="w-14 shrink-0 text-muted-foreground">{codeLabel(file.status)}</span>
                <span className="min-w-0 break-all font-mono text-[11px]">{file.path}</span>
                <span className="ml-auto shrink-0 text-[11px]">
                  <span className="text-success">+{file.additions}</span> <span className="text-danger">−{file.deletions}</span>
                </span>
              </li>
            ))}
            {(files.length > 12 || result.changes.truncated) && (
              <li className="text-muted-foreground"><I18nText id="approvals.and_more_open_the_run_to_see_the" /></li>
            )}
          </ul>
        )}
      </div>
      {result.errors.length > 0 && (
        <div>
          <p className="font-medium text-danger"><I18nText id="approvals.errors_and_warnings" /></p>
          <ul className="mt-0.5 list-disc space-y-0.5 pl-4 text-danger" data-testid="execution-result-errors">
            {result.errors.map((line, index) => <li key={index} className="break-words">{line}</li>)}
          </ul>
        </div>
      )}
      {result.pipeline && (
        <div data-testid="execution-result-pipeline">
          <p className="font-medium"><I18nText id="approvals.pipeline" />{" "}{codeLabel(result.pipeline.status)}</p>
          <ol className="mt-0.5 list-decimal space-y-0.5 pl-4">
            {result.pipeline.steps.map((step, index) => (
              <li key={index} className="break-words">
                {step.name} — {step.outcome ?? tr("common.running_c071cf")}
                {step.summary ? `: ${step.summary}` : ""}
                {step.openQuestions.length > 0 && (
                  <span className="text-warning">{" "}<I18nText id="approvals.open_questions" />{" "}{step.openQuestions.join("; ")}</span>
                )}
              </li>
            ))}
          </ol>
          {result.pipeline.blocked.map((message, index) => <p key={index} className="text-warning">{message}</p>)}
        </div>
      )}
      <p className="text-muted-foreground" data-testid="execution-result-tests">{result.tests.note}</p>
      {result.pendingQuestions > 0 && (
        <p className="text-warning">{result.pendingQuestions}{" "}<I18nText id="common.question" />{result.pendingQuestions === 1 ? "" : englishPluralSuffix()}{" "}<I18nText id="approvals.still_waiting_for_your_answer" /></p>
      )}
      {result.finalMessage && (
        <details>
          <summary className="cursor-pointer font-medium"><I18nText id="approvals.the_agent_s_last_message" /></summary>
          <div className="agetor-md mt-1 max-h-72 overflow-y-auto text-xs" data-testid="execution-result-message">
            <ReactMarkdown remarkPlugins={[remarkGfm]} components={ASSISTANT_MD_COMPONENTS} urlTransform={MD_URL_TRANSFORM}>
              {result.finalMessage}
            </ReactMarkdown>
          </div>
        </details>
      )}
    </div>
  );
}

/**
 * Edit the proposed configuration with the same pickers the New Task form
 * uses: a pipeline, or an agent profile, or harness / mode / model / effort.
 * Saving only updates the proposal; the task changes when the owner
 * approves.
 */
export function ExecutionEditor({
  config,
  busy,
  onCancel,
  onSave,
  onManageAgents,
  note = "Saving updates this proposal only. The task's settings change when you approve.",
}: {
  config: ExecutionConfig;
  busy: boolean;
  onCancel: () => void;
  onSave: (config: Partial<ExecutionConfig>) => void;
  onManageAgents: () => void;
  /** What saving does, under the pickers. */
  note?: string;
}) {
  useUILocale();
  const launch = useTaskLaunch(true, {
    withProfiles: true,
    initial: {
      agent: config.harness,
      mode: config.mode,
      model: config.model,
      effort: config.effort,
      fast: config.fast,
      maxMode: config.maxMode,
    },
  });
  const { pipelines } = usePipelines();
  const [pipelineId, setPipelineId] = useState<string | null>(config.pipelineId);
  const seeded = useRef(false);
  useEffect(() => {
    if (seeded.current || launch.loading || launch.harnesses.length === 0) return;
    seeded.current = true;
    if (config.profileId && launch.profiles.some((profile) => profile.id === config.profileId)) {
      launch.setAgentProfileId(config.profileId);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [launch.loading, launch.harnesses.length, launch.profiles.length]);

  const save = () => {
    if (pipelineId) return onSave({ pipelineId, profileId: null });
    if (launch.agentProfileId) return onSave({ pipelineId: null, profileId: launch.agentProfileId });
    onSave({
      pipelineId: null,
      profileId: null,
      harness: launch.agent,
      model: launch.model,
      effort: launch.effort,
      mode: launch.mode,
      fast: launch.fast,
      maxMode: launch.maxMode,
    });
  };

  return (
    <fieldset className="space-y-2 rounded-lg border border-border bg-background/60 p-2" disabled={busy} data-testid="execution-editor">
      <legend className="px-1 text-[11px] font-medium"><I18nText id="approvals.edit_configuration" /></legend>
      {launch.loadError && <p className="text-danger"><I18nText id="approvals.couldn_t_load_agents" />{" "}{launch.loadError}</p>}
      <div className="space-y-1">
        <span className="text-muted-foreground"><I18nText id="common.pipeline" /></span>
        <PipelinePicker value={pipelineId} onChange={setPipelineId} pipelines={pipelines} />
      </div>
      {/* The pickers seed from the proposal once the harness list loads;
          showing them earlier would let that seed overwrite a pick. */}
      {!pipelineId && launch.loading && (
        <p className="flex items-center gap-1.5 text-muted-foreground">
          <Loader2 className="size-3 motion-safe:animate-spin" aria-hidden /><I18nText id="common.loading_agents" />{" "}</p>
      )}
      {!pipelineId && !launch.loading && (
        <div className="space-y-2" data-testid="execution-editor-agent">
          <TaskLaunchPickers launch={launch} onManageProfiles={onManageAgents} />
        </div>
      )}
      <p className="text-[11px] text-muted-foreground">{note}</p>
      <div className="flex flex-wrap gap-2">
        <Button className={ACTION} type="button" size="sm" onClick={save} disabled={busy || launch.loading} data-testid="execution-editor-save">
          {busy ? <Loader2 className="size-3.5 motion-safe:animate-spin" aria-hidden /> : <Check className="size-3.5" aria-hidden />}<I18nText id="approvals.save_and_check" />{" "}</Button>
        <Button className={ACTION} type="button" size="sm" variant="ghost" onClick={onCancel} data-testid="execution-editor-cancel"><I18nText id="common.cancel" />{" "}</Button>
      </div>
    </fieldset>
  );
}
