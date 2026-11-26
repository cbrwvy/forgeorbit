import { t as tr } from "@/i18n/core";
import { useLocale as useUILocale } from "@/i18n/react";
import { useCallback, useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { api } from "@/lib/api";
import { formatTime } from "@/lib/batches";
import { subscribeProjectPermissionEvents } from "@/lib/project-permission-events";
import { evidenceDescriptionText, evidenceFreshnessReasonText, evidenceFreshnessText, evidenceKindText } from "@/lib/project-permissions";
import type { ProjectTestEvidence as Evidence, ProjectTestEvidenceEntry } from "../../../shared/project-test-evidence.ts";
import type { Task } from "../../../shared/types.ts";

/** Colour follows what the Owner may rely on, not just the exit code: a stale pass is never green. */
function toneOf(entry: ProjectTestEvidenceEntry): string {
  if (entry.kind === "passed") return entry.freshness === "current" ? "bg-success/15 text-success" : "bg-warning/15 text-warning";
  if (entry.kind === "failed") return "bg-danger/15 text-danger";
  if (entry.kind === "pending" || entry.kind === "running") return "bg-info/15 text-info";
  if (entry.kind === "interrupted") return "bg-warning/15 text-warning";
  return "bg-muted text-muted-foreground";
}

/**
 * Open the stored request's own details in the Project test panel of this task. Pure navigation:
 * it scrolls, opens a <details> and moves focus. It submits nothing and starts nothing.
 */
function showRequestDetails(requestId: string): void {
  const panel = document.querySelector('[data-testid="project-test-panel"]');
  const target = panel?.querySelector<HTMLElement>(`[data-request-id="${requestId.replace(/["\\]/g, "")}"]`);
  if (!target) {
    panel?.scrollIntoView({ block: "center" });
    return;
  }
  for (let el: Element | null = target; el && el !== panel; el = el.parentElement) {
    if (el instanceof HTMLDetailsElement) el.open = true;
  }
  target.querySelectorAll("details").forEach((d) => { d.open = true; });
  target.scrollIntoView({ block: "center" });
  target.focus({ preventScroll: true });
}

function Entry({ entry, testId }: { entry: ProjectTestEvidenceEntry; testId: string }) {
  const ran = entry.kind === "passed" || entry.kind === "failed";
  return (
    <div className="space-y-1" data-testid={testId} data-kind={entry.kind} data-freshness={entry.freshness ?? ""} data-request-id={entry.requestId}>
      <p className="flex flex-wrap items-center gap-2">
        <span className={`rounded px-1.5 py-0.5 font-medium ${toneOf(entry)}`} data-testid={`${testId}-kind`}>{evidenceKindText(entry.kind)}</span>
        {ran && entry.freshness && (
          <span className="font-medium" data-testid={`${testId}-freshness`}>{evidenceFreshnessText(entry.freshness)}</span>
        )}
      </p>
      <p data-testid={`${testId}-description`}>{evidenceDescriptionText(entry)}</p>
      {ran && entry.freshnessReason && (
        <p className="text-muted-foreground" data-testid={`${testId}-freshness-reason`}>{evidenceFreshnessReasonText(entry.freshnessReason)}</p>
      )}
      <p className="text-muted-foreground">
        {tr("perm.ev.command")}: <code className="break-all rounded bg-muted px-1 py-0.5" data-testid={`${testId}-command`}>{entry.command}</code>
        {" · "}
        {tr("perm.ev.recorded", { time: formatTime(entry.finishedAt ?? entry.decidedAt ?? entry.createdAt) })}
      </p>
    </div>
  );
}

/**
 * Compact Project test summary next to QC in the task review. Read-only evidence: one GET that
 * the core answers from the stored permission requests and the task's current workspace bytes.
 * Opening, refreshing or following the details link submits no request, starts no test, issues no
 * grant and changes no task state. It is not an input to the QC verdict, Done or a mission.
 */
export function ProjectTestEvidence({ task }: { task: Task }) {
  useUILocale();
  const [evidence, setEvidence] = useState<Evidence | null>(null);
  const [error, setError] = useState<string | null>(null);
  const seq = useRef(0);

  const load = useCallback(async () => {
    const mine = ++seq.current;
    try {
      const next = await api.getProjectTestEvidence(task.id);
      if (mine !== seq.current) return;
      setEvidence(next);
      setError(null);
    } catch (e) {
      if (mine === seq.current) setError(e instanceof Error ? e.message : String(e));
    }
  }, [task.id]);

  // Same cadence as the Project test panel: mount, task state changes, permission events, window focus. No timer.
  useEffect(() => { void load(); }, [load, task.column, task.runId, task.updatedAt]);
  useEffect(() => subscribeProjectPermissionEvents(() => { void load(); }), [load]);
  useEffect(() => {
    const onFocus = () => { void load(); };
    window.addEventListener("focus", onFocus);
    return () => window.removeEventListener("focus", onFocus);
  }, [load]);

  const latest = evidence?.latest ?? null;
  const earlier = evidence && evidence.lastResult && evidence.lastResult !== evidence.latest ? evidence.lastResult : null;
  const headlineKind = evidence?.kind ?? null;

  return (
    <div className="space-y-1.5 rounded border border-border/60 p-2 text-xs" data-testid="project-test-evidence" data-kind={headlineKind ?? ""} data-current-pass={evidence?.currentPass ? "true" : "false"}>
      <h5 className="font-semibold">{tr("perm.ev.title")}</h5>
      {evidence === null && !error && <p role="status" className="text-muted-foreground" data-testid="project-test-evidence-loading">{tr("perm.ev.loading")}</p>}
      {error && <p role="alert" className="text-danger" data-testid="project-test-evidence-error">{tr("perm.ev.failed", { message: error })}</p>}
      {evidence && !latest && (
        <div className="space-y-1" data-testid="project-test-evidence-empty" data-kind="not-run">
          <p><span className="rounded bg-muted px-1.5 py-0.5 font-medium text-muted-foreground" data-testid="project-test-evidence-empty-kind">{evidenceKindText("not-run")}</span></p>
          <p data-testid="project-test-evidence-empty-description">{evidenceDescriptionText({ kind: "not-run", exitCode: null })}</p>
        </div>
      )}
      {latest && <Entry entry={latest} testId="project-test-evidence-latest" />}
      {earlier && (
        <div className="space-y-1 rounded border border-border/60 p-1.5" data-testid="project-test-evidence-earlier-box">
          <p className="font-medium">{tr("perm.ev.earlier_title")}</p>
          <p className="text-muted-foreground">{tr("perm.ev.earlier_hint")}</p>
          <Entry entry={earlier} testId="project-test-evidence-earlier" />
        </div>
      )}
      {(latest || earlier) && (
        <Button
          type="button"
          size="sm"
          variant="outline"
          onClick={() => showRequestDetails((latest ?? earlier)!.requestId)}
          data-testid="project-test-evidence-details"
        >
          {tr("perm.ev.details")}
        </Button>
      )}
      <p className="text-muted-foreground" data-testid="project-test-evidence-note">{tr("perm.ev.note")}</p>
    </div>
  );
}
