/**
 * Owner controls for versioned instruction and skill improvements.
 * Enabling the engine does not activate a candidate or grant a permission.
 */
import { useCallback, useEffect, useState } from "react";
import { ShieldAlert } from "lucide-react";
import { Button } from "@/components/ui/button";
import { t as tr } from "@/i18n/core";
import { api } from "@/lib/api";

type Status = Awaited<ReturnType<typeof api.selfImprovementStatus>>;

export function SelfImprovementPanel() {
  const [status, setStatus] = useState<Status | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    try {
      const next = await api.selfImprovementStatus();
      setStatus(next);
      setError(null);
      setSelected((current) => current ?? next.candidates[0]?.id ?? null);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Self-improvement status unavailable.");
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const control = status?.control;
  const selectedCandidate = status?.candidates.find((candidate) => candidate.id === selected) ?? status?.candidates[0] ?? null;
  const stateLabel = !control?.enabled
    ? tr("selfImprove.off")
    : control.stopped
      ? tr("selfImprove.stopped")
      : control.paused
        ? tr("selfImprove.paused")
        : tr("selfImprove.on");

  async function update(body: { enabled?: boolean; paused?: boolean; stopped?: boolean }) {
    setError(null);
    setBusy(true);
    try {
      await api.setSelfImprovementControl(body);
      await load();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Control update failed.");
    } finally {
      setBusy(false);
    }
  }

  async function act(action: "approve" | "reject" | "activate" | "rollback" | "discover" | "prepare" | "evaluate" | "evaluate-fixtures" | "retain") {
    if (action !== "discover" && !selectedCandidate) return;
    setError(null);
    setBusy(true);
    try {
      if (action === "discover") await api.discoverSelfImprovements();
      else if (action === "prepare" && selectedCandidate) await api.prepareSelfImprovement(selectedCandidate.id);
      else if (action === "evaluate-fixtures" && selectedCandidate) await api.evaluateSelfImprovement(selectedCandidate.id, {});
      else if (action === "evaluate" && selectedCandidate) {
        await api.evaluateSelfImprovement(selectedCandidate.id, { provider: "claude-code", model: "haiku-4.5", policyTest: true });
      } else if (selectedCandidate && (action === "approve" || action === "reject" || action === "activate" || action === "rollback" || action === "retain")) {
        await api.selfImprovementAction(selectedCandidate.id, action);
      }
      await load();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Action failed.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="rounded-lg border border-border/80 bg-card/60 p-4 space-y-3" data-testid="self-improvement-panel">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 className="text-sm font-semibold">{tr("selfImprove.title")}</h2>
          <p className="text-xs text-muted-foreground" data-testid="self-improvement-status">{stateLabel}</p>
          <p className="text-[11px] text-muted-foreground">{tr("selfImprove.notTraining")}</p>
        </div>
        <div className="flex flex-wrap gap-2">
          <Button type="button" size="sm" variant="outline" disabled={busy} data-testid="self-improvement-enable" onClick={() => void update({ enabled: true, paused: false, stopped: false })}>
            {tr("selfImprove.enable")}
          </Button>
          <Button type="button" size="sm" variant="outline" disabled={busy || !control?.enabled} data-testid="self-improvement-discover" onClick={() => void act("discover")}>
            {tr("selfImprove.discover")}
          </Button>
          <Button type="button" size="sm" variant="outline" data-testid="self-improvement-pause" onClick={() => void update({ paused: !control?.paused })}>
            {control?.paused ? tr("selfImprove.resume") : tr("selfImprove.pause")}
          </Button>
          <Button type="button" size="sm" variant="outline" data-testid="self-improvement-stop" onClick={() => void update({ stopped: true, paused: false })}>
            {tr("selfImprove.stop")}
          </Button>
        </div>
      </div>

      {error && (
        <div className="flex items-center gap-2 rounded-md border border-danger/40 bg-danger/10 p-2 text-xs text-danger" role="alert" data-testid="self-improvement-error">
          <ShieldAlert className="size-3.5 shrink-0" />
          <span>{error}</span>
        </div>
      )}

      <div className="grid gap-3 md:grid-cols-3 text-xs">
        <div className="rounded-md border border-border/70 p-3" data-testid="self-improvement-budget">
          <div className="font-medium">{tr("selfImprove.budget")}</div>
          <p className="text-muted-foreground">
            {status ? tr("m0.budgetCandidates", { used: status.budget.candidatesUsed, max: status.budget.candidatesMax }) : "—"}
            {" · "}
            {status ? tr("m0.budgetActivations", { used: status.budget.activationAttempts, max: status.budget.activationMax }) : "—"}
          </p>
          <p className="text-muted-foreground">{tr("selfImprove.quota")}</p>
        </div>
        <div className="rounded-md border border-border/70 p-3" data-testid="self-improvement-policy">
          <div className="font-medium">{tr("selfImprove.policy")}</div>
          <p className="text-muted-foreground">
            {status && status.autonomy.permitting > 0
              ? tr("selfImprove.policyOn", { count: status.autonomy.permitting })
              : tr("selfImprove.policyOff")}
          </p>
        </div>
        <div className="rounded-md border border-border/70 p-3" data-testid="self-improvement-active">
          <div className="font-medium">{tr("selfImprove.active")}</div>
          {status && status.activeVersions.length > 0 ? (
            <ul className="mt-1 space-y-1">
              {status.activeVersions.map((version) => (
                <li key={`${version.artifactKey}:${version.version}`}>
                  {version.role} v{version.version} · {version.projectPath ?? version.scope}
                </li>
              ))}
            </ul>
          ) : (
            <p className="text-muted-foreground">{tr("selfImprove.noneActive")}</p>
          )}
        </div>
      </div>

      <div className="grid gap-3 lg:grid-cols-[16rem_1fr]">
        <div data-testid="self-improvement-candidates">
          <div className="text-xs font-medium">{tr("selfImprove.candidates")}</div>
          {status && status.candidates.length > 0 ? (
            <ul className="mt-2 space-y-1">
              {status.candidates.map((candidate) => (
                <li key={candidate.id}>
                  <button
                    type="button"
                    className="w-full rounded border border-border/70 px-2 py-1 text-left text-xs hover:bg-accent"
                    onClick={() => setSelected(candidate.id)}
                  >
                    <span className="font-medium">{candidate.role}</span>
                    <span className="text-muted-foreground"> · {candidate.status}</span>
                  </button>
                </li>
              ))}
            </ul>
          ) : (
            <p className="mt-1 text-xs text-muted-foreground">{tr("selfImprove.empty")}</p>
          )}
        </div>
        {selectedCandidate && (
          <div className="space-y-2 text-xs" data-testid="self-improvement-detail">
            <div className="font-medium">{selectedCandidate.role} · {selectedCandidate.projectPath}</div>
            <p>{selectedCandidate.hypothesis}</p>
            <div>
              <div className="font-medium">{tr("selfImprove.evidence")}</div>
              <pre className="mt-1 max-h-24 overflow-auto whitespace-pre-wrap rounded bg-muted/40 p-2">{JSON.stringify(selectedCandidate.evidence, null, 2)}</pre>
            </div>
            <div>
              <div className="font-medium">{tr("selfImprove.diff")}</div>
              <pre className="mt-1 max-h-32 overflow-auto whitespace-pre-wrap rounded bg-muted/40 p-2" data-testid="self-improvement-diff">{selectedCandidate.diffText || "—"}</pre>
            </div>
            <div data-testid="self-improvement-metrics">
              <div className="font-medium">{tr("selfImprove.metrics")}</div>
              <p className="text-muted-foreground">
                {selectedCandidate.metrics
                  ? `errors ${selectedCandidate.metrics.baselineErrors ?? "—"} → ${selectedCandidate.metrics.candidateErrors ?? "—"} · ${selectedCandidate.metrics.attribution ?? ""} · quota ${selectedCandidate.metrics.quota ?? "unknown"}`
                  : selectedCandidate.decisionReason || "—"}
              </p>
              {selectedCandidate.metrics?.sampleSize && (
                <p className="text-muted-foreground" data-testid="self-improvement-sample">
                  {tr("selfImprove.sample", {
                    fixtures: selectedCandidate.metrics.sampleSize.fixtures,
                    training: selectedCandidate.metrics.sampleSize.training,
                    heldOut: selectedCandidate.metrics.sampleSize.heldOut,
                  })}
                  {selectedCandidate.metrics.baselineVersion != null && selectedCandidate.metrics.candidateVersion != null
                    ? ` · ${tr("selfImprove.revisions", { from: selectedCandidate.metrics.baselineVersion, to: selectedCandidate.metrics.candidateVersion })}`
                    : ""}
                </p>
              )}
              {selectedCandidate.metrics && (
                <p className="text-muted-foreground" data-testid="self-improvement-execution">
                  {tr("selfImprove.execution")}: {
                    selectedCandidate.metrics.inferenceCompleted
                      ? tr("selfImprove.provider")
                      : selectedCandidate.metrics.generation === "deterministic-fallback" || selectedCandidate.metrics.execution === "refused-real"
                        ? tr("selfImprove.fallback")
                        : selectedCandidate.metrics.execution === "synthetic-driver" || selectedCandidate.metrics.generation === "synthetic-driver"
                          ? tr("selfImprove.synthetic")
                          : selectedCandidate.metrics.execution === "deterministic-text"
                            ? tr("selfImprove.textCheck")
                            : tr("selfImprove.refused")
                  }
                </p>
              )}
              {selectedCandidate.decisionReason && (
                <p className="text-muted-foreground" data-testid="self-improvement-decision-reason" data-status={selectedCandidate.status}>
                  {selectedCandidate.status === "rolled_back" ? tr("selfImprove.rollbackReason") : tr("selfImprove.decisionReason")}: {selectedCandidate.decisionReason}
                </p>
              )}
            </div>
            <div className="flex flex-wrap gap-2">
              <Button type="button" size="sm" variant="outline" disabled={busy} data-testid="self-improvement-prepare" onClick={() => void act("prepare")}>{tr("selfImprove.prepare")}</Button>
              <Button type="button" size="sm" variant="outline" disabled={busy} data-testid="self-improvement-evaluate" onClick={() => void act("evaluate")}>{tr("selfImprove.evaluate")}</Button>
              <Button type="button" size="sm" variant="outline" disabled={busy} data-testid="self-improvement-evaluate-fixtures" onClick={() => void act("evaluate-fixtures")}>{tr("selfImprove.evaluateFixtures")}</Button>
              <Button type="button" size="sm" variant="outline" disabled={busy} data-testid="self-improvement-approve" onClick={() => void act("approve")}>{tr("selfImprove.approve")}</Button>
              <Button type="button" size="sm" variant="outline" disabled={busy} data-testid="self-improvement-reject" onClick={() => void act("reject")}>{tr("selfImprove.reject")}</Button>
              <Button type="button" size="sm" variant="outline" disabled={busy} data-testid="self-improvement-activate" onClick={() => void act("activate")}>{tr("selfImprove.activate")}</Button>
              <Button type="button" size="sm" variant="outline" disabled={busy} data-testid="self-improvement-retain" onClick={() => void act("retain")}>{tr("selfImprove.retain")}</Button>
              <Button type="button" size="sm" variant="outline" disabled={busy} data-testid="self-improvement-rollback" onClick={() => void act("rollback")}>{tr("selfImprove.rollback")}</Button>
            </div>
          </div>
        )}
      </div>

      <div data-testid="self-improvement-launches">
        <div className="text-xs font-medium">{tr("selfImprove.launches")}</div>
        <p className="text-[11px] text-muted-foreground">{tr("selfImprove.notIntelligence")}</p>
        {status && status.launches.length > 0 ? (
          <ul className="mt-1 space-y-1 text-xs text-muted-foreground">
            {status.launches.map((launch) => (
              <li key={launch.runId} data-testid="self-improvement-launch">
                {launch.role} · {launch.runId.slice(0, 8)} · {launch.versions.map((version) => `${version.artifactKey} v${version.version}`).join(", ") || tr("selfImprove.noneActive")}
              </li>
            ))}
          </ul>
        ) : (
          <p className="text-xs text-muted-foreground">{tr("selfImprove.launchesEmpty")}</p>
        )}
      </div>
      <div data-testid="self-improvement-regressions">
        <div className="text-xs font-medium">{tr("selfImprove.regressions")}</div>
        {status && status.regressions.length > 0 ? (
          <ul className="mt-1 space-y-1 text-xs text-warning">
            {status.regressions.map((item) => (
              <li key={item.id}>{item.role}: {item.decisionReason}</li>
            ))}
          </ul>
        ) : (
          <p className="text-xs text-muted-foreground">{tr("selfImprove.noRegressions")}</p>
        )}
      </div>
    </section>
  );
}
