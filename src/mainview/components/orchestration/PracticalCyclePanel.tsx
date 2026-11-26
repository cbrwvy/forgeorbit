/**
 * Observed-test and rework status for the existing Mission Control page.
 * Pause, resume, cancel, and emergency stop stay on the controls already mounted here.
 */
import { useCallback, useEffect, useState } from "react";
import { t as tr } from "@/i18n/core";
import { api } from "@/lib/api";
import { missionPhaseText } from "@/lib/status-presenters";

type Status = Awaited<ReturnType<typeof api.practicalCycleStatus>>;

function stageLabel(status: string): string {
  if (status === "passed") return tr("practical.passed");
  if (status === "failed") return tr("practical.failed");
  if (status === "blocked") return tr("practical.blocked");
  if (status === "running") return tr("practical.running");
  return status;
}

export function PracticalCyclePanel({ missionId, tasks = [] }: {
  missionId?: string | null;
  tasks?: Array<{ taskId: string; title: string; phase: string }>;
}) {
  const [status, setStatus] = useState<Status | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      setStatus(await api.practicalCycleStatus(missionId ?? undefined));
      setError(null);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Practical cycle status unavailable.");
    }
  }, [missionId]);

  useEffect(() => {
    void load();
    const timer = setInterval(() => void load(), 3000);
    return () => clearInterval(timer);
  }, [load]);

  const latest = status?.attempts[0] ?? null;

  return (
    <section className="rounded-lg border border-border/80 bg-card/60 p-4 space-y-3" data-testid="practical-cycle-panel">
      <div>
        <h2 className="text-sm font-semibold">{tr("practical.title")}</h2>
        <p className="text-xs text-muted-foreground" data-testid="practical-cycle-stage">
          {tr("practical.stage")}: {latest ? stageLabel(latest.status) : tr("practical.empty")}
        </p>
        <p className="text-[11px] text-muted-foreground">{tr("practical.controls")}</p>
      </div>
      {error && <p className="text-xs text-danger" role="alert" data-testid="practical-cycle-error">{error}</p>}
      {tasks.length > 0 && (
        <ul className="space-y-1 text-xs" data-testid="practical-cycle-tasks">
          {tasks.map((task) => (
            <li key={task.taskId} data-testid="practical-task-phase" data-phase={task.phase}>
              {task.title}: {missionPhaseText(task.phase)}
            </li>
          ))}
        </ul>
      )}
      <div className="grid gap-3 md:grid-cols-3 text-xs">
        <div className="rounded-md border border-border/70 p-3" data-testid="practical-cycle-test">
          <div className="font-medium">{tr("practical.test")}</div>
          <p className="text-muted-foreground" data-testid="practical-cycle-latest">
            {latest
              ? `${stageLabel(latest.status)} · ${latest.command} · exit ${latest.exitCode ?? "—"} · ${latest.summary ?? latest.isolationReason ?? "—"}`
              : tr("practical.empty")}
          </p>
          <ul className="mt-2 space-y-1">
            {(status?.attempts ?? []).slice(0, 6).map((attempt) => (
              <li key={attempt.id} data-testid="practical-attempt" data-status={attempt.status} data-exit={attempt.exitCode ?? ""}>
                {tr("m0.attemptRow", { stage: stageLabel(attempt.status), epoch: attempt.reworkEpoch, exit: attempt.exitCode ?? "—", detail: attempt.failureKind ?? attempt.isolation })}
              </li>
            ))}
          </ul>
          <p className="text-muted-foreground">
            {latest?.implementationExecution === "provider" ? tr("practical.provider") : tr("practical.synthetic")}
          </p>
        </div>
        <div className="rounded-md border border-border/70 p-3" data-testid="practical-cycle-rework">
          <div className="font-medium">{tr("practical.rework")}</div>
          <p className="text-muted-foreground">{latest ? String(latest.reworkEpoch) : "—"} · {latest?.failureKind ?? "—"}</p>
          <p className="text-muted-foreground">{tr("practical.developer")} / {tr("practical.reviewer")}</p>
          <p className="text-muted-foreground">{tr("practical.qc")}</p>
        </div>
        <div className="rounded-md border border-border/70 p-3" data-testid="practical-cycle-policy">
          <div className="font-medium">{tr("practical.policy")}</div>
          <p className="text-muted-foreground">
            {latest ? `${latest.policyId} · r${latest.policyRevision}` : "—"}
          </p>
          <p className="text-muted-foreground">
            {tr("practical.model")}: {latest ? `${latest.model ?? "—"} · ${latest.accountId ?? "—"}` : "—"}
          </p>
          <p className="text-muted-foreground">
            {tr("practical.limits")}: {status ? tr("m0.limitsRow", { concurrency: status.limits.testConcurrency, seconds: status.limits.timeoutMs / 1000, bytes: status.limits.maxOutputBytes.toLocaleString() }) : "—"}
          </p>
          <p className="text-muted-foreground">
            {tr("practical.evidence")}: {latest?.evidenceDigest ? latest.evidenceDigest.slice(0, 12) : "—"}
          </p>
        </div>
      </div>
    </section>
  );
}
