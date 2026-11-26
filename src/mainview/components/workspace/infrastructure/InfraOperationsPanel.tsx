import { useEffect, useState } from "react";
import { t as tr } from "@/i18n/core";
import { api } from "@/lib/api";
import { Button } from "@/components/ui/button";
import type { InfraSnapshot } from "../../../../shared/infra-auto/model.ts";

function stateLabel(state: string): string {
  switch (state) {
    case "simulated": return tr("infra.state.simulated");
    case "configuration-verified": return tr("infra.state.configuration-verified");
    case "execution-authorized": return tr("infra.state.execution-authorized");
    case "dispatched": return tr("infra.state.dispatched");
    case "running": return tr("infra.state.running");
    case "failed": return tr("infra.state.failed");
    case "succeeded": return tr("infra.state.succeeded");
    case "blocked": return tr("infra.state.blocked");
    case "unknown": return tr("infra.state.unknown");
    case "cancelled": return tr("infra.state.cancelled");
    default: return state;
  }
}

export function InfraOperationsPanel({
  snapshot,
  onPause,
  onCancel,
  onResume,
}: {
  snapshot: InfraSnapshot;
  onPause?: () => void;
  onCancel?: () => void;
  onResume?: () => void;
}) {
  return (
    <section className="rounded-lg border border-border bg-card/60 p-4 space-y-4" data-testid="infra-operations-panel">
      <div>
        <h2 className="text-sm font-semibold">{tr("infra.panel.title")}</h2>
        <p className="text-xs text-muted-foreground">{tr("infra.panel.note")}</p>
      </div>
      <p className="text-xs" data-testid="infra-channel-blocked">{tr("infra.channel.blocked")}</p>
      <div className="flex flex-wrap gap-2 text-xs">
        {snapshot.paused ? <span data-testid="infra-paused">{tr("infra.paused")}</span> : null}
        {snapshot.cancelled ? <span data-testid="infra-cancelled">{tr("infra.cancelled")}</span> : null}
        {onPause ? <Button type="button" variant="outline" size="sm" onClick={onPause} data-testid="infra-pause">{tr("infra.pause")}</Button> : null}
        {onCancel ? <Button type="button" variant="outline" size="sm" onClick={onCancel} data-testid="infra-cancel">{tr("infra.cancel")}</Button> : null}
        {onResume ? <Button type="button" variant="outline" size="sm" onClick={onResume} data-testid="infra-resume">{tr("infra.resume")}</Button> : null}
      </div>
      {snapshot.clusters.map((cluster) => (
        <div key={cluster.id} data-testid="infra-cluster" data-cluster={cluster.name}>
          <h3 className="text-sm font-medium">{cluster.name}</h3>
          {cluster.servers.length === 0 ? <p className="text-xs text-muted-foreground">{tr("infra.servers.empty")}</p> : (
            <ul>
              {cluster.servers.map((server) => (
                <li key={server.id} data-testid="infra-server">{server.name} — {tr("infra.servers.unverified")}</li>
              ))}
            </ul>
          )}
          <ul className="text-xs">
            {cluster.projects.map((project) => (
              <li key={project.path} data-testid="infra-project">
                {project.name} · {project.role ?? "—"} · {project.gitBranch ?? tr("infra.git.unknown")} · {project.gitSha ?? "—"} · {tr("infra.ci")} {project.ciPassing}/{project.ciFailing}
                {project.gitError ? ` · ${project.gitError}` : ""}
              </li>
            ))}
          </ul>
        </div>
      ))}
      <div>
        <h3 className="text-sm font-medium">{tr("infra.plans")}</h3>
        {snapshot.plans.length === 0 ? <p className="text-xs text-muted-foreground">{tr("infra.plans.empty")}</p> : (
          <ul className="space-y-2">
            {snapshot.plans.map((plan) => (
              <li key={plan.id} data-testid="infra-plan" data-operation-state={plan.state}>
                <span>{plan.projectName} · {plan.environment} · {plan.branch} · {plan.sha}</span>
                <span data-testid="infra-plan-state">{stateLabel(plan.state)}</span>
                <span> · {tr("infra.health")}: {plan.health} · {plan.provenance}</span>
                {plan.failure ? <span data-testid="infra-plan-failure"> · {plan.failure}</span> : null}
              </li>
            ))}
          </ul>
        )}
      </div>
      <div data-testid="infra-dependencies">
        <h3 className="text-sm font-medium">{tr("infra.dependencies")}</h3>
        {snapshot.dependencies.map((item) => (
          <p key={`${item.projectName}-${item.dependsOn}`} className="text-xs">{item.projectName} → {item.dependsOn}{item.blocked ? ` · ${item.reason}` : ""}</p>
        ))}
      </div>
      <div data-testid="infra-production">
        <h3 className="text-sm font-medium">{tr("infra.production")}</h3>
        <p className="text-xs">{tr("infra.production.denied")}</p>
        <p className="text-xs text-muted-foreground">{tr("infra.rollback")}</p>
      </div>
    </section>
  );
}

export function InfraOperationsSection() {
  const [snapshot, setSnapshot] = useState<InfraSnapshot | null>(null);
  const [error, setError] = useState<string | null>(null);
  const load = () => {
    void api.getInfraAutoSnapshot().then(setSnapshot).catch((reason: unknown) => {
      setError(reason instanceof Error ? reason.message : "Infrastructure snapshot failed.");
    });
  };
  useEffect(() => {
    load();
  }, []);
  if (error) return <p data-testid="infra-operations-error">{error}</p>;
  if (!snapshot) return null;
  return (
    <InfraOperationsPanel
      snapshot={snapshot}
      onPause={() => void api.setInfraAutoControl({ paused: true }).then(load)}
      onCancel={() => void api.setInfraAutoControl({ cancelled: true }).then(load)}
      onResume={() => void api.setInfraAutoControl({ paused: false, cancelled: false }).then(load)}
    />
  );
}
