import { t as tr } from "@/i18n/core";
import { useLocale as useUILocale } from "@/i18n/react";
import { useEffect, useState } from "react";
import { AlertTriangle, Bot, CircleAlert, Loader2, ShieldCheck, Undo2 } from "lucide-react";
import { api } from "@/lib/api";
import { formatTime } from "@/lib/batches";
import { Button } from "@/components/ui/button";
import { useConfirm } from "@/components/ui/confirm";
import { cn } from "@/lib/utils";
import type { AutonomyPreview } from "../../../../shared/autonomy.ts";
import type { BatchView } from "../../../../shared/task-scheduling.ts";

/** Buttons wrap their label instead of overflowing a narrow column. */
const ACTION = "h-auto min-h-8 max-w-full whitespace-normal text-left";

type Runner = (label: string, fn: () => Promise<void>) => Promise<void>;

/** What kind of batch this is, for the badge and for tests. */
export type AutonomyMode = "manual" | "bounded" | "expired" | "exhausted" | "revoked";

export function autonomyModeOf(batch: Pick<BatchView, "autonomy" | "autonomyView">): AutonomyMode {
  const view = batch.autonomyView;
  if (!batch.autonomy || !view) return "manual";
  return view.effectiveStatus === "active" ? "bounded" : view.effectiveStatus;
}

const MODE_LABEL: Record<AutonomyMode, Parameters<typeof tr>[0]> = {
  manual: "autonomy.mode_manual",
  bounded: "autonomy.mode_bounded",
  expired: "autonomy.mode_expired",
  exhausted: "autonomy.mode_exhausted",
  revoked: "autonomy.mode_revoked",
};
const MODE_TONE: Record<AutonomyMode, string> = {
  manual: "bg-muted text-muted-foreground",
  bounded: "bg-info/15 text-info",
  expired: "bg-warning/15 text-warning",
  exhausted: "bg-warning/15 text-warning",
  revoked: "bg-danger/10 text-danger",
};

export function AutonomyBadge({ batch }: { batch: Pick<BatchView, "autonomy" | "autonomyView"> }) {
  useUILocale();
  const mode = autonomyModeOf(batch);
  return (
    <span className={cn("shrink-0 rounded-full px-2 py-0.5 text-[length:var(--text-caption)] font-medium", MODE_TONE[mode])} data-testid="autonomy-mode" data-mode={mode}>
      {tr(MODE_LABEL[mode])}
    </span>
  );
}

/**
 * The Owner's bounded autonomous grant for one batch (FO-ORCH08), kept as a
 * compact section inside the batch. It shows what the core froze and counts;
 * it never decides what may run. Every button is checked again by the core.
 */
export function AutonomySection({
  projectPath, batch, busy, run, onBatch, titleOf,
}: {
  projectPath: string;
  batch: BatchView;
  busy: string | null;
  run: Runner;
  onBatch: (batch: BatchView) => void;
  titleOf: (taskId: string) => string;
}) {
  useUILocale();
  const confirm = useConfirm();
  const grant = batch.autonomy ?? null;
  const view = batch.autonomyView ?? null;
  const mode = autonomyModeOf(batch);
  const canOffer = batch.status === "approved" || batch.status === "paused";
  const [open, setOpen] = useState(false);

  useEffect(() => setOpen(false), [batch.id]);
  if (batch.status === "draft") return null;
  if (!grant && !canOffer) return null;

  return (
    <section className="space-y-2 rounded-lg border border-border p-3 text-[length:var(--text-secondary)]" aria-label={tr("autonomy.title")} data-testid="autonomy-section" data-mode={mode}>
      <header className="flex flex-wrap items-center justify-between gap-2">
        <h4 className="flex items-center gap-1.5 text-[length:var(--text-base)] font-semibold"><Bot className="size-3.5" aria-hidden />{tr("autonomy.title")}</h4>
        <AutonomyBadge batch={batch} />
      </header>

      {!grant && (
        <>
          <p className="text-[length:var(--text-caption)] text-muted-foreground" data-testid="autonomy-off">{tr("autonomy.off_note")}</p>
          {!open && (
            <Button className={ACTION} type="button" size="sm" variant="outline" disabled={busy != null} onClick={() => setOpen(true)} data-testid="autonomy-enable">
              <ShieldCheck className="size-3.5" aria-hidden />{tr("autonomy.enable")}
            </Button>
          )}
          {open && (
            <GrantReview
              projectPath={projectPath} batch={batch} busy={busy} run={run} titleOf={titleOf}
              onCancel={() => setOpen(false)}
              onGranted={(next) => { setOpen(false); onBatch(next); }}
            />
          )}
        </>
      )}

      {grant && view && (
        <>
          <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-0.5 text-[length:var(--text-caption)]">
            <dt className="text-muted-foreground">{tr("autonomy.runs_used")}</dt>
            <dd data-testid="autonomy-runs">{view.runsUsed} / {grant.maxRuns}</dd>
            <dt className="text-muted-foreground">{tr("autonomy.max_parallel")}</dt>
            <dd data-testid="autonomy-parallel">{view.runsLive} / {grant.maxParallelism}</dd>
            <dt className="text-muted-foreground">{tr("uxfix.autonomy.providerQuota")}</dt>
            <dd data-testid="autonomy-provider-quota">{view.unknownQuotaText ? tr("uxfix.autonomy.quotaUnknown") : tr("uxfix.autonomy.quotaNotMeasured")}</dd>
            <dt className="text-muted-foreground">{tr("autonomy.expires")}</dt>
            <dd data-testid="autonomy-expires">{formatTime(grant.expiresAt)}</dd>
            <dt className="text-muted-foreground">{tr("autonomy.now_running")}</dt>
            <dd data-testid="autonomy-current">
              {view.currentTaskIds.length > 0 ? view.currentTaskIds.map(titleOf).join(", ") : tr("autonomy.nothing_running")}
            </dd>
          </dl>
          <p className="text-[length:var(--text-caption)] text-muted-foreground" data-testid="autonomy-runs-note">{tr("uxfix.autonomy.runsNote")}</p>
          <ul className="space-y-0.5" aria-label={tr("autonomy.allowed_tasks")} data-testid="autonomy-tasks">
            {grant.taskIds.map((id) => (
              <li key={id} className="min-w-0 break-words rounded-md border border-border/70 px-2 py-1" data-testid="autonomy-task" data-task-id={id}>
                <span className="font-medium">{titleOf(id)}</span>
                <ResourceLines resources={grant.resources.filter((r) => r.taskId === id)} />
              </li>
            ))}
          </ul>
          {view.unknownQuotaText && (
            <p className="flex items-start gap-1 text-[length:var(--text-caption)] text-warning" data-testid="autonomy-unknown-quota">
              <AlertTriangle className="mt-0.5 size-3 shrink-0" aria-hidden /><span className="min-w-0 break-words">{view.unknownQuotaText}</span>
            </p>
          )}
          {grant.endReason && (
            <p className="flex items-start gap-1 text-[length:var(--text-caption)] text-warning" role="status" data-testid="autonomy-ended" data-code={grant.endReason.code}>
              <CircleAlert className="mt-0.5 size-3 shrink-0" aria-hidden /><span className="min-w-0 break-words"><b>{tr("autonomy.why_stopped")}:</b> {grant.endReason.text}</span>
            </p>
          )}
          {batch.reason?.code.startsWith("autonomy:") && !grant.endReason && (
            <p className="flex items-start gap-1 text-[length:var(--text-caption)] text-warning" role="status" data-testid="autonomy-blocked" data-code={batch.reason.code}>
              <CircleAlert className="mt-0.5 size-3 shrink-0" aria-hidden /><span className="min-w-0 break-words"><b>{tr("autonomy.why_stopped")}:</b> {batch.reason.text}</span>
            </p>
          )}
          <p className="text-[length:var(--text-caption)] text-muted-foreground">{tr("autonomy.granted_at")} {formatTime(grant.approvedAt)}.</p>
          {view.effectiveStatus === "active" && (
            <Button
              className={cn(ACTION, "border-danger/40 text-danger hover:bg-danger/10 hover:text-danger")} type="button" size="sm" variant="outline" disabled={busy != null} data-testid="autonomy-revoke"
              onClick={() => void (async () => {
                const ok = await confirm(() => ({
                  title: tr("autonomy.revoke_title"),
                  description: tr("autonomy.revoke_body"),
                  confirmLabel: tr("autonomy.revoke"),
                  variant: "destructive",
                }));
                if (!ok) return;
                await run("autonomy-revoke", async () => {
                  const out = await api.revokeAutonomy(projectPath, batch.id);
                  onBatch(out.batch);
                });
              })()}
            >
              {busy === "autonomy-revoke" ? <Loader2 className="size-3.5 motion-safe:animate-spin" aria-hidden /> : <Undo2 className="size-3.5" aria-hidden />}{tr("autonomy.revoke")}
            </Button>
          )}
          {view.effectiveStatus !== "active" && canOffer && (
            <>
              {!open && (
                <Button className={ACTION} type="button" size="sm" variant="outline" disabled={busy != null} onClick={() => setOpen(true)} data-testid="autonomy-enable">
                  <ShieldCheck className="size-3.5" aria-hidden />{tr("autonomy.enable")}
                </Button>
              )}
              {open && (
                <GrantReview
                  projectPath={projectPath} batch={batch} busy={busy} run={run} titleOf={titleOf}
                  onCancel={() => setOpen(false)}
                  onGranted={(next) => { setOpen(false); onBatch(next); }}
                />
              )}
            </>
          )}
        </>
      )}
    </section>
  );
}

function ResourceLines({ resources }: { resources: NonNullable<BatchView["autonomy"]>["resources"] }) {
  return (
    <ul className="text-[length:var(--text-caption)] text-muted-foreground">
      {resources.map((r, i) => (
        <li key={i} className="break-words" data-testid="autonomy-resource">
          {r.stepName ? `${tr("autonomy.step")} ${r.stepName} · ` : ""}{r.harnessId}{r.model ? ` · ${r.model}` : ""} · {r.mode}{r.accountId ? ` · ${r.accountId.slice(0, 8)}` : ""}
        </li>
      ))}
    </ul>
  );
}

function GrantReview({
  projectPath, batch, busy, run, titleOf, onCancel, onGranted,
}: {
  projectPath: string; batch: BatchView; busy: string | null; run: Runner; titleOf: (taskId: string) => string;
  onCancel: () => void; onGranted: (batch: BatchView) => void;
}) {
  const [preview, setPreview] = useState<AutonomyPreview | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [maxRuns, setMaxRuns] = useState(1);
  const [maxParallelism, setMaxParallelism] = useState(1);
  const [ttl, setTtl] = useState(240);
  const [ackUnknown, setAckUnknown] = useState(false);
  const [confirmed, setConfirmed] = useState(false);

  useEffect(() => {
    let live = true;
    void api.previewAutonomy(projectPath, batch.id).then((p) => {
      if (!live) return;
      setPreview(p);
      setMaxRuns(p.defaults.maxRuns);
      setMaxParallelism(p.defaults.maxParallelism);
      setTtl(p.defaults.ttlMinutes);
    }).catch((caught) => live && setError(caught instanceof Error ? caught.message : String(caught)));
    return () => { live = false; };
  }, [projectPath, batch.id, batch.approval?.previewKey]);

  if (error) return <p role="alert" className="text-[length:var(--text-caption)] text-danger" data-testid="autonomy-error">{error}</p>;
  if (!preview) return <Loader2 className="size-3.5 motion-safe:animate-spin" aria-hidden />;
  const needsAck = preview.unknownQuota.length > 0;
  const blocked = preview.blockers.length > 0;
  const ready = !blocked && confirmed && (!needsAck || ackUnknown) && preview.previewKey != null;

  return (
    <div className="space-y-2 rounded-md border border-info/40 bg-info/5 p-2" data-testid="autonomy-review">
      <h5 className="text-[length:var(--text-secondary)] font-semibold">{tr("autonomy.review_heading")}</h5>
      {blocked && (
        <div role="alert" className="space-y-0.5 text-[length:var(--text-caption)] text-danger" data-testid="autonomy-blockers">
          <p className="font-medium">{tr("autonomy.cannot_grant")}</p>
          <ul className="list-disc pl-4">{preview.blockers.map((b, i) => <li key={i} className="break-words" data-code={b.code}>{b.message}</li>)}</ul>
        </div>
      )}
      <ul className="space-y-0.5" aria-label={tr("autonomy.allowed_tasks")} data-testid="autonomy-review-tasks">
        {preview.taskIds.map((id) => (
          <li key={id} className="min-w-0 break-words rounded-md border border-border/70 px-2 py-1">
            <span className="font-medium">{titleOf(id)}</span>
            <ResourceLines resources={preview.resources.filter((r) => r.taskId === id)} />
          </li>
        ))}
      </ul>
      <div className="grid gap-2 sm:grid-cols-3">
        <label className="flex flex-col gap-0.5">
          <span className="text-muted-foreground">{tr("autonomy.max_runs")}</span>
          <input type="number" min={preview.limits.maxRuns.min} max={preview.limits.maxRuns.max} className="h-8 rounded-md border border-input bg-transparent px-2 text-[length:var(--text-secondary)]" value={maxRuns}
            onChange={(e) => setMaxRuns(Math.trunc(Number(e.target.value) || 1))} data-testid="autonomy-max-runs" />
        </label>
        <label className="flex flex-col gap-0.5">
          <span className="text-muted-foreground">{tr("autonomy.max_parallel")}</span>
          <input type="number" min={preview.limits.maxParallelism.min} max={batch.policy.maxParallel} className="h-8 rounded-md border border-input bg-transparent px-2 text-[length:var(--text-secondary)]" value={maxParallelism}
            onChange={(e) => setMaxParallelism(Math.trunc(Number(e.target.value) || 1))} data-testid="autonomy-max-parallel" />
        </label>
        <label className="flex flex-col gap-0.5">
          <span className="text-muted-foreground">{tr("autonomy.valid_minutes")}</span>
          <input type="number" min={preview.limits.ttlMinutes.min} max={preview.limits.ttlMinutes.max} className="h-8 rounded-md border border-input bg-transparent px-2 text-[length:var(--text-secondary)]" value={ttl}
            onChange={(e) => setTtl(Math.trunc(Number(e.target.value) || preview.limits.ttlMinutes.min))} data-testid="autonomy-ttl" />
        </label>
      </div>
      {needsAck && (
        <div className="space-y-1" data-testid="autonomy-unknown-quota-review">
          <p className="flex items-start gap-1 text-[length:var(--text-caption)] text-warning"><AlertTriangle className="mt-0.5 size-3 shrink-0" aria-hidden /><span className="min-w-0 break-words">{preview.unknownQuotaText}</span></p>
          <label className="flex items-start gap-1.5">
            <input type="checkbox" className="mt-0.5" checked={ackUnknown} onChange={(e) => setAckUnknown(e.target.checked)} data-testid="autonomy-ack-unknown" />
            <span>{tr("autonomy.ack_unknown")}</span>
          </label>
        </div>
      )}
      <p className="text-[length:var(--text-caption)] text-muted-foreground" data-testid="autonomy-cost-note">{preview.costNote}</p>
      <div className="text-[length:var(--text-caption)] text-muted-foreground">
        <p className="font-medium">{tr("autonomy.stops_when")}</p>
        <ul className="list-disc pl-4">{preview.stopConditions.map((s) => <li key={s} className="break-words">{s}</li>)}</ul>
      </div>
      <label className="flex items-start gap-1.5">
        <input type="checkbox" className="mt-0.5" checked={confirmed} onChange={(e) => setConfirmed(e.target.checked)} data-testid="autonomy-confirm" />
        <span>{tr("autonomy.confirm_scope")}</span>
      </label>
      <div className="flex flex-wrap items-center gap-2">
        <Button className={ACTION} type="button" size="sm" disabled={!ready || busy != null} data-testid="autonomy-grant"
          onClick={() => void run("autonomy-grant", async () => {
            const out = await api.grantAutonomy(projectPath, batch.id, { previewKey: preview.previewKey!, maxRuns, maxParallelism, ttlMinutes: ttl, acknowledgeUnknownQuota: needsAck && ackUnknown });
            onGranted(out.batch);
          })}>
          {busy === "autonomy-grant" ? <Loader2 className="size-3.5 motion-safe:animate-spin" aria-hidden /> : <ShieldCheck className="size-3.5" aria-hidden />}{tr("autonomy.grant")}
        </Button>
        <Button className={ACTION} type="button" size="sm" variant="outline" onClick={onCancel} data-testid="autonomy-cancel">{tr("autonomy.cancel")}</Button>
      </div>
    </div>
  );
}
