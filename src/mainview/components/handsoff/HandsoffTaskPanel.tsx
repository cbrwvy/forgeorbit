import { useCallback, useEffect, useState } from "react";
import { toast } from "sonner";
import { t as tr } from "@/i18n/core";
import { useLocale as useUILocale } from "@/i18n/react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { TechnicalDetails } from "@/components/ui/technical-details";
import { api, type HandsoffTaskView } from "@/lib/api";
import { blockerText, changeKindText, eventText, handsoffHeadline, testText, verdictText } from "@/lib/handsoff";
import { policyEnabledFor, refreshHandsoff, requestOpenProjectSettings, useHandsoffOverview } from "@/lib/handsoff-events";
import { requestOpenAccounts } from "@/lib/open-accounts";
import { canSubmitForWork } from "@/lib/handsoff";
import type { HandsoffRun } from "../../../shared/handsoff.ts";
import type { Task } from "../../../shared/types.ts";

interface Props {
  task: Task;
  /** Opens the project's settings page (where the one-time setup lives). */
  onOpenSettings?: (projectPath: string) => void;
}

const toneClass = { info: "info", warning: "warning", success: "success", muted: "secondary", danger: "destructive" } as const;

/** Which of the run's facts to show: where it is, what happened, and, once finished, what the result is. */
export function HandsoffTaskPanel({ task, onOpenSettings }: Props) {
  useUILocale();
  const overview = useHandsoffOverview();
  const [view, setView] = useState<HandsoffTaskView | null>(null);
  const [busy, setBusy] = useState(false);
  const mine = overview?.runs.find((run) => run.taskId === task.id) ?? null;
  const enabled = policyEnabledFor(overview, task.workdir);

  const load = useCallback(async () => {
    try { setView(await api.getHandsoffTask(task.id)); } catch { /* keep what was shown */ }
  }, [task.id]);
  useEffect(() => { setView(null); void load(); }, [load]);
  // The overview already carries the live status; re-read the history when it changes.
  useEffect(() => { void load(); }, [mine?.updatedAt, mine?.status, mine?.stage, load]);

  const run: HandsoffRun | null = mine ?? view?.run ?? null;
  const events = view?.events ?? [];
  if (!run && !canSubmitForWork(task, enabled, null)) return null;

  async function act(fn: () => Promise<unknown>, success?: string) {
    if (busy) return;
    setBusy(true);
    try { await fn(); if (success) toast.success(success); }
    catch (error) { toast.error(tr("handsoff.action_failed", { message: error instanceof Error ? error.message : String(error) })); }
    finally { setBusy(false); refreshHandsoff(); void load(); }
  }

  const headline = run ? handsoffHeadline(run) : null;
  const blocker = run?.status === "needs-owner" ? run.blocker : null;
  const open = run != null && run.finishedAt == null;
  const result = run?.result ?? null;

  return (
    <section className="space-y-2 rounded-lg border bg-card p-3" data-testid="handsoff-panel" data-status={run?.status ?? "idle"} data-stage={run?.stage ?? "none"} aria-label={tr("handsoff.panel_title")}>
      <div className="flex flex-wrap items-center gap-2">
        <h3 className="text-sm font-medium">{tr("handsoff.panel_title")}</h3>
        {headline && <Badge variant={toneClass[headline.tone] as never} data-testid="handsoff-headline">{headline.text}</Badge>}
        <div className="ml-auto flex flex-wrap gap-1.5">
          {!run && canSubmitForWork(task, enabled, null) && (
            <Button size="sm" disabled={busy} data-testid="handsoff-submit" title={tr("handsoff.submit_title")}
              onClick={() => void act(() => api.submitHandsoff(task.id), tr("handsoff.submitted"))}>{tr("handsoff.submit")}</Button>
          )}
          {run && run.finishedAt != null && canSubmitForWork(task, enabled, run) && (
            <Button size="sm" disabled={busy} data-testid="handsoff-submit" onClick={() => void act(() => api.submitHandsoff(task.id), tr("handsoff.submitted"))}>{tr("handsoff.submit")}</Button>
          )}
          {open && run.status === "stopped" && <Button size="sm" disabled={busy} data-testid="handsoff-resume" onClick={() => void act(() => api.resumeHandsoff(run.id))}>{tr("handsoff.resume")}</Button>}
          {open && run.status !== "stopped" && run.status !== "needs-owner" && (
            <Button size="sm" variant="outline" disabled={busy} data-testid="handsoff-cancel" onClick={() => { if (window.confirm(tr("handsoff.cancel_confirm"))) void act(() => api.cancelHandsoff(run.id)); }}>{tr("handsoff.cancel")}</Button>
          )}
        </div>
      </div>

      {!run && <p className="text-xs text-muted-foreground">{tr("handsoff.panel_idle")}</p>}
      {run?.status === "waiting" && (
        <p className="text-xs text-muted-foreground" data-testid="handsoff-waiting">
          {run.state.waitKind === "scheduled"
            ? tr("kanban.schedule.waiting")
            : tr("handsoff.waiting_why", { reason: run.state.waitReason ?? "" })}
        </p>
      )}
      {run?.status === "stopped" && <p className="text-xs text-muted-foreground" data-testid="handsoff-stopped">{tr("handsoff.stopped_why")}</p>}

      {blocker && (
        <div className="space-y-1.5 rounded-md border border-warning/60 bg-warning/10 p-2" data-testid="handsoff-blocker" data-code={blocker.code}>
          <p className="text-xs font-medium">{tr("handsoff.needs_you")}</p>
          <p className="text-xs">{blockerText(blocker)}</p>
          <div className="flex flex-wrap gap-1.5">
            {blocker.action === "retry" && <Button size="sm" disabled={busy} data-testid="handsoff-action" onClick={() => void act(() => api.retryHandsoff(run!.id))}>{tr("handsoff.retry")}</Button>}
            {blocker.action === "open-settings" && <Button size="sm" data-testid="handsoff-action" onClick={() => (onOpenSettings ?? requestOpenProjectSettings)(run!.projectPath)}>{tr("handsoff.open_settings")}</Button>}
            {blocker.action === "open-accounts" && <Button size="sm" data-testid="handsoff-action" onClick={() => requestOpenAccounts()}>{tr("handsoff.open_accounts")}</Button>}
            {blocker.action === "open-task" && <Button size="sm" disabled={busy} data-testid="handsoff-action" onClick={() => void act(() => api.retryHandsoff(run!.id))}>{tr("handsoff.retry")}</Button>}
            <Button size="sm" variant="outline" disabled={busy} data-testid="handsoff-cancel" onClick={() => { if (window.confirm(tr("handsoff.cancel_confirm"))) void act(() => api.cancelHandsoff(run!.id)); }}>{tr("handsoff.cancel")}</Button>
          </div>
          <TechnicalDetails testId="handsoff-blocker-tech" rows={[
            { label: tr("handsoff.tech.code"), value: blocker.code },
            { label: tr("handsoff.tech.message"), value: blocker.message },
          ]} />
        </div>
      )}

      {result && run && (
        <div className="space-y-1 text-xs" data-testid="handsoff-result" data-delivery={result.delivery}>
          <h4 className="font-medium">{tr("handsoff.result.title")}</h4>
          <p data-testid="handsoff-result-files"><span className="font-medium">{tr("handsoff.result.files")}: </span>
            {result.changedFiles.length === 0 ? tr("handsoff.result.no_files") : result.changedFiles.map((file) => `${file.path} (${changeKindText(file.kind)})`).join(", ")}</p>
          <p data-testid="handsoff-result-tests" data-state={result.tests.state}><span className="font-medium">{tr("handsoff.result.tests")}: </span>{testText(result.tests.state)}</p>
          <p data-testid="handsoff-result-review"><span className="font-medium">{tr("handsoff.result.review")}: </span>{verdictText(result.review.verdict)}{result.review.summary ? ` — ${result.review.summary}` : ""}</p>
          <p data-testid="handsoff-result-delivery"><span className="font-medium">{tr("handsoff.result.delivery")}: </span>{tr(`handsoff.delivery.${result.delivery}` as never)}</p>
          {result.fixRounds > 0 && <p><span className="font-medium">{tr("handsoff.result.fix_rounds")}: </span>{result.fixRounds}</p>}
          {result.developer?.employeeName && <p><span className="font-medium">{tr("handsoff.result.worker")}: </span>{result.developer.employeeName}</p>}
        </div>
      )}

      {run && (
        <details className="rounded-md border border-border/60 px-2 py-1" data-testid="handsoff-history">
          <summary className="cursor-pointer text-xs font-medium">{tr("handsoff.history")}</summary>
          {events.length === 0 ? <p className="mt-1 text-xs text-muted-foreground">{tr("handsoff.no_history")}</p> : (
            <ol className="mt-1 space-y-0.5 text-xs">
              {events.map((event) => (
                <li key={event.id} data-kind={event.kind} title={tr("handsoff.event.by", { revision: String(event.detail.policyRevision) })}>
                  <span className="text-muted-foreground">{new Date(event.ts).toLocaleTimeString()} · </span>{eventText(event.kind)}
                  {event.detail.employeeName ? <span className="text-muted-foreground"> · {String(event.detail.employeeName)}</span> : null}
                </li>
              ))}
            </ol>
          )}
          <TechnicalDetails className="mt-1" testId="handsoff-run-tech" rows={[
            { label: tr("handsoff.tech.run"), value: run.id },
            { label: tr("handsoff.tech.revision"), value: String(run.policyRevision) },
          ]} />
        </details>
      )}
    </section>
  );
}
