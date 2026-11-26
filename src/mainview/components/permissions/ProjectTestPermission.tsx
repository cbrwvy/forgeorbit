import { t as tr } from "@/i18n/core";
import { useLocale as useUILocale } from "@/i18n/react";
import { useCallback, useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { TechnicalDetails } from "@/components/ui/technical-details";
import { ApiError, api } from "@/lib/api";
import { formatTime } from "@/lib/batches";
import { subscribeProjectPermissionEvents } from "@/lib/project-permission-events";
import { permissionAuthorityText, permissionOutcomeText, permissionStatusText } from "@/lib/project-permissions";
import type { PermissionEffect, ProjectPermissionRequest, ProjectTestPreview } from "../../../shared/project-permissions.ts";
import type { Task } from "../../../shared/types.ts";

const UNAVAILABLE_CODES = new Set(["task", "project", "emergency-stop", "project-stopped", "workspace", "test", "open"]);

function effectText(effect: PermissionEffect | null): string {
  return effect === "allow" ? tr("perm.task.effect.allow") : effect === "deny" ? tr("perm.task.effect.deny") : tr("perm.task.effect.ask");
}

/**
 * Task panel: Request project test. Eligibility, the command, the directory and what a
 * submission would do all come from the core (`GET /project-permissions/tasks/:id`, read-only).
 * The UI cannot choose or edit the target: it shows what the core derived and submits the
 * fingerprint it showed, so a target that changed after review is refused and re-reviewed.
 * Opening or reloading a task never creates a request and never runs anything.
 */
export function ProjectTestPermission({ task }: { task: Task }) {
  useUILocale();
  const [preview, setPreview] = useState<ProjectTestPreview | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [review, setReview] = useState<ProjectTestPreview | null>(null);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const seq = useRef(0);

  const load = useCallback(async (): Promise<ProjectTestPreview | null> => {
    const mine = ++seq.current;
    try {
      const next = await api.getProjectTestPreview(task.id);
      if (mine !== seq.current) return null;
      setPreview(next);
      setError(null);
      return next;
    } catch (e) {
      if (mine === seq.current) setError(e instanceof Error ? e.message : String(e));
      return null;
    }
  }, [task.id]);

  // Re-read on mount, task state changes, the app's own permission events and window focus. No timer.
  useEffect(() => { void load(); }, [load, task.column, task.runId]);
  useEffect(() => subscribeProjectPermissionEvents(() => { void load(); }), [load]);
  useEffect(() => {
    const onFocus = () => { void load(); };
    window.addEventListener("focus", onFocus);
    return () => window.removeEventListener("focus", onFocus);
  }, [load]);

  // A review that no longer matches what the core derives now is withdrawn, not silently resubmitted.
  useEffect(() => {
    if (!review || !preview) return;
    if (review.target?.commandFingerprint !== preview.target?.commandFingerprint || review.target?.sourceFingerprint !== preview.target?.sourceFingerprint || review.target?.projectPath !== preview.target?.projectPath) {
      setReview(null);
      setNotice(tr("perm.task.changed"));
    }
  }, [preview, review]);

  async function openReview() {
    setNotice(null);
    const fresh = await load();
    if (fresh?.eligible && fresh.target) setReview(fresh);
  }

  async function submit() {
    if (!review?.target || busy) return;
    const reviewed = { projectPath: review.target.projectPath, commandFingerprint: review.target.commandFingerprint, sourceFingerprint: review.target.sourceFingerprint };
    setBusy(true);
    setNotice(null);
    try {
      await api.requestProjectTest(task.id, reviewed);
      setReview(null);
    } catch (e) {
      const code = e instanceof ApiError && e.body && typeof e.body === "object" ? (e.body as { code?: string }).code : undefined;
      setReview(null);
      setNotice(code === "target-changed" ? tr("perm.task.changed") : e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
      void load();
    }
  }

  const latest: ProjectPermissionRequest | null = preview?.requests[0] ?? null;
  const open = latest != null && (latest.status === "pending" || latest.status === "running");
  const headline = preview && !preview.eligible
    ? (preview.code && UNAVAILABLE_CODES.has(preview.code) ? tr(`perm.task.unavail.${preview.code}` as "perm.task.unavail.task") : tr("perm.task.unavailable"))
    : null;

  return (
    <section className="space-y-2 rounded-md border border-border p-2 text-xs" data-testid="project-test-panel" aria-label={tr("perm.task.title")}>
      <h3 className="text-sm font-medium">{tr("perm.task.title")}</h3>
      <p className="text-muted-foreground" data-testid="project-test-hint">{tr("perm.task.hint")}</p>

      {preview === null && !error && <p role="status" className="text-muted-foreground" data-testid="project-test-loading">{tr("perm.task.loading")}</p>}
      {error && <p role="alert" className="text-danger" data-testid="project-test-error">{tr("perm.task.failed", { message: error })}</p>}

      {latest && (
        <div className="space-y-1 rounded-md border border-border/60 p-2" data-testid="project-test-latest" data-status={latest.status} data-request-id={latest.id} tabIndex={-1}>
          <p className="font-medium">
            {tr("perm.task.latest")}: <span data-testid="project-test-status">{permissionStatusText(latest.status)}</span>
            <span className="font-normal text-muted-foreground">{" · "}{formatTime(latest.createdAt)}</span>
          </p>
          <p data-testid="project-test-outcome">
            {permissionOutcomeText(latest)}
            {latest.authority ? ` ${permissionAuthorityText(latest.authority)}.` : ""}
          </p>
          {latest.status === "pending" && <p className="text-muted-foreground" data-testid="project-test-pending-where">{tr("perm.task.pending_where")}</p>}
          <TechnicalDetails
            testId="project-test-technical"
            rows={[
              { label: tr("perm.tech.request"), value: latest.id },
              { label: tr("perm.tech.command"), value: latest.command },
              { label: tr("perm.tech.cwd"), value: latest.cwd },
              { label: tr("perm.tech.source"), value: latest.sourceFingerprint },
              { label: tr("perm.tech.operation"), value: latest.commandFingerprint },
              { label: tr("perm.tech.message"), value: latest.reason },
              { label: tr("perm.tech.exit"), value: latest.exitCode == null ? null : String(latest.exitCode) },
              { label: tr("perm.tech.isolation"), value: latest.isolation },
              { label: tr("perm.tech.output"), value: latest.summary },
            ]}
          />
        </div>
      )}

      {preview && preview.requests.length > 1 && (
        <details className="rounded-md border border-border/60 p-2" data-testid="project-test-earlier">
          <summary className="cursor-pointer font-medium">{tr("perm.task.earlier")} ({preview.requests.length - 1})</summary>
          <ul className="mt-1 space-y-1">
            {preview.requests.slice(1).map((request) => (
              <li key={request.id} className="space-y-1 rounded border border-border/60 p-1.5" data-testid="project-test-earlier-item" data-status={request.status} data-request-id={request.id} tabIndex={-1}>
                <p className="font-medium">
                  {permissionStatusText(request.status)}
                  <span className="font-normal text-muted-foreground">{" · "}{formatTime(request.createdAt)}</span>
                </p>
                <p>{permissionOutcomeText(request)}</p>
                <TechnicalDetails
                  testId="project-test-earlier-technical"
                  rows={[
                    { label: tr("perm.tech.request"), value: request.id },
                    { label: tr("perm.tech.command"), value: request.command },
                    { label: tr("perm.tech.cwd"), value: request.cwd },
                    { label: tr("perm.tech.source"), value: request.sourceFingerprint },
                    { label: tr("perm.tech.message"), value: request.reason },
                    { label: tr("perm.tech.exit"), value: request.exitCode == null ? null : String(request.exitCode) },
                    { label: tr("perm.tech.output"), value: request.summary },
                  ]}
                />
              </li>
            ))}
          </ul>
        </details>
      )}

      {preview && !preview.eligible && !open && (
        <div className="space-y-0.5" data-testid="project-test-unavailable" data-code={preview.code ?? ""}>
          <p className="font-medium">{headline}</p>
          {preview.reason && <p className="text-muted-foreground">{tr("perm.task.reason")}: <span data-testid="project-test-reason">{preview.reason}</span></p>}
        </div>
      )}

      {preview?.eligible && !review && !open && (
        <Button type="button" size="sm" variant="outline" onClick={() => void openReview()} data-testid="project-test-review">
          {latest ? tr("perm.task.again") : tr("perm.task.review")}
        </Button>
      )}

      {review?.target && (
        <div className="space-y-2 rounded-md border border-warning/50 bg-warning/5 p-2" data-testid="project-test-review-box" data-effect={review.effect ?? ""}>
          <p className="font-medium">{tr("perm.task.review_title")}</p>
          <p className="text-muted-foreground">{tr("perm.task.review_hint")}</p>
          <p>{tr("perm.attn.command")}: <code className="break-all rounded bg-muted px-1 py-0.5" data-testid="project-test-command">{review.target.command}</code></p>
          <p>{tr("perm.attn.cwd")}: <code className="break-all rounded bg-muted px-1 py-0.5" data-testid="project-test-cwd">{review.target.cwd}</code></p>
          <p className="font-medium" data-testid="project-test-effect">{effectText(review.effect)}</p>
          <div className="flex gap-2">
            <Button type="button" size="sm" disabled={busy} onClick={() => void submit()} data-testid="project-test-submit">
              {busy ? tr("perm.task.submitting") : review.effect === "allow" ? tr("perm.task.submit_run") : tr("perm.task.submit")}
            </Button>
            <Button type="button" size="sm" variant="outline" disabled={busy} onClick={() => { setReview(null); }} data-testid="project-test-cancel">{tr("perm.task.cancel")}</Button>
          </div>
        </div>
      )}

      {notice && <p role="status" className="text-warning" data-testid="project-test-notice">{notice}</p>}
      <p className="text-muted-foreground" data-testid="project-test-stop-note">{tr("perm.task.stop_note")}</p>
      <p className="text-muted-foreground" data-testid="project-test-approval-note">{tr("perm.task.approval_note")}</p>
    </section>
  );
}
