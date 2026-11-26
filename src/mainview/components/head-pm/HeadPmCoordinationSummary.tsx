import { t as tr } from "@/i18n/core";
import { useEffect, useState } from "react";
import { api } from "@/lib/api";
import { codeLabel } from "@/i18n/presentation";
import type { HeadPmCoordinationSnapshot } from "../../../shared/head-pm-coordination.ts";

interface Props {
  /** Bumped when portfolio state changes (delegation cards, reload). */
  refreshToken: string;
  onOpenProject: (projectPath: string) => void;
}

/** FO-HEAD01: compact cross-project facts grounded in persisted state. */
export function HeadPmCoordinationSummary({ refreshToken, onOpenProject }: Props) {
  const [snapshot, setSnapshot] = useState<HeadPmCoordinationSnapshot | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let cancelled = false;
    void api.getHeadPmCoordination().then(
      (value) => { if (!cancelled) { setSnapshot(value); setFailed(false); } },
      () => { if (!cancelled) { setSnapshot(null); setFailed(true); } },
    );
    return () => { cancelled = true; };
  }, [refreshToken]);

  if (failed) {
    return (
      <p className="text-[11px] text-muted-foreground" data-testid="head-pm-coordination-error" role="status">
        {tr("headPm.coordinationFailed")}
      </p>
    );
  }
  if (!snapshot) {
    return (
      <p className="text-[11px] text-muted-foreground" data-testid="head-pm-coordination-loading" role="status">
        {tr("headPm.coordinationLoading")}
      </p>
    );
  }

  const pendingDelegations = snapshot.delegations.filter((d) => d.status === "proposed" || d.status === "failed");
  const activeDelegations = snapshot.delegations.filter((d) => d.status === "sent" || d.status === "sending" || d.status === "answered");

  return (
    <section
      className="rounded-md border border-border/80 bg-muted/30 px-2 py-1.5 text-[11px]"
      aria-label={tr("headPm.coordinationTitle")}
      data-testid="head-pm-coordination"
    >
      <h3 className="font-semibold text-foreground">{tr("headPm.coordinationTitle")}</h3>
      <ul className="mt-1 space-y-0.5 text-muted-foreground">
        {snapshot.clusters.map((cluster) => (
          <li key={cluster.id} data-testid="head-pm-coordination-cluster">
            <span className="font-medium text-foreground">{cluster.name}</span>
            {" — "}
            {cluster.projectPaths.length === 0
              ? tr("headPm.coordinationEmptyCluster")
              : cluster.projectPaths.map((path) => {
                  const project = snapshot.projects.find((p) => p.projectPath === path);
                  return (
                    <span key={path} className="mr-2 inline-block">
                      <button
                        type="button"
                        className="glass-nav-item mr-1 underline decoration-dotted"
                        onClick={() => onOpenProject(path)}
                        data-testid="head-pm-coordination-project"
                        data-path={path}
                      >
                        {project?.projectName ?? path}
                      </button>
                      <span className="block text-muted-foreground" data-testid="head-pm-project-progress" data-path={path}>
                        {Object.entries(project?.columns ?? {}).map(([column, count]) => `${codeLabel(column)}: ${count}`).join(" · ") || tr("headPm.coordinationNoTasks")}
                      </span>
                    </span>
                  );
                })}
          </li>
        ))}
        {snapshot.unassignedProjectPaths.length > 0 && (
          <li data-testid="head-pm-coordination-unassigned">
            {tr("headPm.coordinationUnassigned", { count: snapshot.unassignedProjectPaths.length })}
          </li>
        )}
      </ul>
      <p className="mt-1.5" data-testid="head-pm-coordination-delegations">
        {tr("headPm.coordinationDelegations", {
          pending: pendingDelegations.length,
          active: activeDelegations.length,
        })}
      </p>
      {(snapshot.ownerQueue.pendingProposals > 0 || snapshot.ownerQueue.orchestratedHolds > 0) && (
        <p data-testid="head-pm-coordination-owner-queue">
          {tr("headPm.coordinationOwnerQueue", {
            proposals: snapshot.ownerQueue.pendingProposals,
            workflows: snapshot.ownerQueue.orchestratedHolds,
          })}
        </p>
      )}
    </section>
  );
}
