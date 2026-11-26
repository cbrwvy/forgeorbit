import { t as tr } from "@/i18n/core";
import { useLocale as useUILocale } from "@/i18n/react";
import { useCallback, useEffect, useState } from "react";
import { api } from "@/lib/api";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import type { Cluster } from "../../../../shared/clusters/types.ts";
import type { DeploymentRequestRecord } from "../../../../shared/deployment-request/types.ts";
import { SYNTHETIC_AUTH_TTL_MS, type DeploymentManualHandoff } from "../../../../shared/deployment-request/owner-authorization.ts";
import { dryRunOutcomeDescription, normalizeDryRunResult } from "../../../../shared/deployment-request/dry-run-display.ts";

interface NamedProject {
  path: string;
  name: string;
}

interface Props {
  projects: NamedProject[];
  clusters: Cluster[];
  defaultProjectPath?: string;
  defaultClusterId?: string;
}

function statusLabel(status: DeploymentRequestRecord["status"]): string {
  switch (status) {
    case "awaiting_owner":
      return "Awaiting Owner";
    case "preflight_failed":
      return "Preflight failed";
    case "dry_run_complete":
      return "Dry-run complete";
    case "dry_run_unsupported":
      return "Dry-run unsupported";
    case "dry_run_not_configured":
      return "NOT_CONFIGURED";
    case "rejected":
      return "Rejected";
    default:
      return status;
  }
}

export function DeploymentRequestsPanel({ projects, clusters, defaultProjectPath, defaultClusterId }: Props) {
  useUILocale();
  const [requests, setRequests] = useState<DeploymentRequestRecord[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [projectPath, setProjectPath] = useState(defaultProjectPath ?? projects[0]?.path ?? "");
  const [clusterId, setClusterId] = useState(defaultClusterId ?? clusters[0]?.id ?? "");
  const [environment, setEnvironment] = useState<"staging" | "production">("staging");
  const [revision, setRevision] = useState("HEAD");
  const [actorRole, setActorRole] = useState<"owner" | "project-manager" | "head-of-pm">("owner");
  const [confirmProduction, setConfirmProduction] = useState(false);
  const [handoff, setHandoff] = useState<DeploymentManualHandoff | null>(null);
  const [now, setNow] = useState(Date.now());
  const [busyId, setBusyId] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const result = await api.listDeploymentRequests();
      setRequests(result.requests);
    } catch (e) {
      setError(e instanceof Error ? e.message : tr("common.couldn_t_reach_the_infrastructure_inventory"));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, []);

  async function submitRequest() {
    if (!projectPath || !clusterId) return;
    setError(null);
    try {
      await api.createDeploymentRequest({
        projectPath,
        clusterId,
        environment,
        revision,
        requestedByRole: actorRole,
      });
      await refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : tr("common.couldn_t_reach_the_infrastructure_inventory"));
    }
  }

  async function authorizeExecution(request: DeploymentRequestRecord) {
    if (!request.executionAuthDigest || actorRole !== "owner" ||
        request.preflight.plan?.stagingIntegrationType !== "forgeorbit-fake-staging-v1") return;
    setBusyId(request.id);
    try {
      await api.authorizeDeploymentExecution(request.id, {
        executionAuthDigest: request.executionAuthDigest,
      });
      await refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : tr("common.couldn_t_reach_the_infrastructure_inventory"));
    } finally {
      setBusyId(null);
    }
  }

  async function reviewHandoff(request: DeploymentRequestRecord) {
    setBusyId(request.id);
    setError(null);
    setHandoff(null);
    try {
      setHandoff(await api.getDeploymentManualHandoff(request.id));
    } catch (e) {
      setError(e instanceof Error ? e.message : "Manual handoff is unavailable.");
    } finally {
      setBusyId(null);
    }
  }

  async function revokeSyntheticGrant(request: DeploymentRequestRecord) {
    setBusyId(request.id);
    try {
      await api.cancelDeploymentExecution(request.id);
      await refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not revoke synthetic grant.");
    } finally {
      setBusyId(null);
    }
  }

  async function approve(request: DeploymentRequestRecord) {
    if (!request.approvalDigest) return;
    setBusyId(request.id);
    setError(null);
    try {
      await api.approveDeploymentRequest(request.id, {
        approvalDigest: request.approvalDigest,
        confirmProduction: request.environment === "production" ? confirmProduction : undefined,
      });
      await refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : tr("common.couldn_t_reach_the_infrastructure_inventory"));
    } finally {
      setBusyId(null);
    }
  }

  async function reject(request: DeploymentRequestRecord) {
    if (!request.approvalDigest) return;
    setBusyId(request.id);
    try {
      await api.rejectDeploymentRequest(request.id, { approvalDigest: request.approvalDigest });
      await refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : tr("common.couldn_t_reach_the_infrastructure_inventory"));
    } finally {
      setBusyId(null);
    }
  }

  return (
    <section className="space-y-3 rounded-xl border border-border bg-card p-4" data-testid="deployment-requests-panel">
      <div>
        <h2 className="text-sm font-semibold">{tr("dep.title")}</h2>
        <p className="text-xs text-muted-foreground">
          {tr("dep.intro")}
        </p>
      </div>

      <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
        <label className="flex flex-col gap-1 text-xs">
          {tr("dep.project")}
          <select className="rounded-md border bg-background px-2 py-1.5 text-sm" value={projectPath} onChange={(e) => setProjectPath(e.target.value)} data-testid="deployment-project">
            {projects.map((p) => (
              <option key={p.path} value={p.path}>{p.name}</option>
            ))}
          </select>
        </label>
        <label className="flex flex-col gap-1 text-xs">
          {tr("dep.cluster")}
          <select className="rounded-md border bg-background px-2 py-1.5 text-sm" value={clusterId} onChange={(e) => setClusterId(e.target.value)} data-testid="deployment-cluster">
            {clusters.map((c) => (
              <option key={c.id} value={c.id}>{c.name}</option>
            ))}
          </select>
        </label>
        <label className="flex flex-col gap-1 text-xs">
          {tr("dep.environment")}
          <select
            className={cn(
              "rounded-md border bg-background px-2 py-1.5 text-sm font-medium",
              environment === "production" ? "border-destructive/60 text-destructive" : "border-warning/50",
            )}
            value={environment}
            onChange={(e) => setEnvironment(e.target.value as "staging" | "production")}
            data-testid="deployment-environment"
          >
            <option value="staging">{tr("dep.staging")}</option>
            <option value="production">{tr("dep.production")}</option>
          </select>
        </label>
        <label className="flex flex-col gap-1 text-xs">
          {tr("dep.revision")}
          <input className="rounded-md border bg-background px-2 py-1.5 text-sm" value={revision} onChange={(e) => setRevision(e.target.value)} data-testid="deployment-revision" />
        </label>
        <label className="flex flex-col gap-1 text-xs">
          {tr("dep.role")}
          <select className="rounded-md border bg-background px-2 py-1.5 text-sm" value={actorRole} onChange={(e) => setActorRole(e.target.value as typeof actorRole)} data-testid="deployment-actor-role">
            <option value="owner">{tr("dep.roleOwner")}</option>
            <option value="project-manager">{tr("dep.rolePm")}</option>
            <option value="head-of-pm">{tr("dep.roleHead")}</option>
          </select>
        </label>
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <Button type="button" size="sm" onClick={() => void submitRequest()} data-testid="deployment-submit">
          {tr("dep.request")}
        </Button>
        {environment === "production" && (
          <label className="flex items-center gap-2 text-xs text-destructive">
            <input type="checkbox" checked={confirmProduction} onChange={(e) => setConfirmProduction(e.target.checked)} data-testid="deployment-confirm-production" />
            {tr("dep.confirmProd")}
          </label>
        )}
      </div>

      {error ? <p className="text-xs text-destructive" role="alert">{error}</p> : null}
      {loading ? <p className="text-xs text-muted-foreground">{tr("dep.loading")}</p> : null}

      {handoff && (
        <div className="space-y-2 rounded-md border p-3" data-testid="deployment-manual-handoff">
          <p className="text-sm font-medium">{tr("dep.handoffTitle")}</p>
          <p className="text-xs">{handoff.instructions}</p>
          <pre className="max-h-96 overflow-auto whitespace-pre-wrap break-all text-xs" tabIndex={0}>{JSON.stringify(handoff, null, 2)}</pre>
          <Button type="button" size="sm" variant="outline" onClick={() => setHandoff(null)}>{tr("dep.closePacket")}</Button>
        </div>
      )}
      <ul className="space-y-2" data-testid="deployment-request-list">
        {requests.map((request) => {
          const dryRun = request.dryRun ? normalizeDryRunResult(request.dryRun) : null;
          const synthetic = request.preflight.plan?.stagingIntegrationType === "forgeorbit-fake-staging-v1";
          const syntheticExpiresAt = request.executionAuthAt == null ? null : request.executionAuthAt + SYNTHETIC_AUTH_TTL_MS;
          return (
          <li
            key={request.id}
            className="rounded-lg border p-3 text-sm"
            data-testid="deployment-request-row"
            data-status={request.status}
            data-environment={request.environment}
            data-execution-state={request.executionState}
          >
            <div className="flex flex-wrap items-start justify-between gap-2">
              <div>
                <p className="font-medium">{request.projectName} → {request.clusterName}</p>
                <p className={cn("text-xs", request.environment === "production" ? "text-destructive font-semibold" : "text-warning")} data-testid="deployment-row-environment">
                  {request.environment === "production" ? tr("dep.production") : tr("dep.staging")} · {request.revision}
                </p>
                <p className="text-xs text-muted-foreground">
                  {tr("dep.proposedBy", { role: request.requestedByRole, status: statusLabel(request.status) })}
                  {request.executionState !== "none" ? tr("dep.execution", { state: request.executionState }) : ""}
                </p>
                {request.planDigest ? (
                  <p className="break-all text-xs font-mono text-muted-foreground" data-testid="deployment-plan-digest">
                    {tr("dep.plan", { digest: request.planDigest })}
                  </p>
                ) : null}
                {request.preflight.plan?.stagingIntegrationLabel ? (
                  <p className="text-xs text-muted-foreground" data-testid="deployment-integration">
                    {tr("dep.integration", { label: request.preflight.plan.stagingIntegrationLabel })}
                    {request.preflight.plan.stagingProjectSlug ? ` (${request.preflight.plan.stagingProjectSlug})` : ""}
                  </p>
                ) : null}
                {request.revisionResolved ? (
                  <p className="break-all text-xs font-mono text-muted-foreground" data-testid="deployment-revision-sha">
                    {tr("dep.sha", { value: request.revisionResolved })}
                  </p>
                ) : null}
                {request.preflight.plan?.imageArtifacts && request.preflight.plan.imageArtifacts.length > 0 ? (
                  <ul className="mt-1 space-y-0.5 text-xs font-mono text-muted-foreground" data-testid="deployment-image-artifacts">
                    {request.preflight.plan.imageArtifacts.map((artifact) => (
                      <li className="break-all" key={artifact.key} title={artifact.reference}>
                        {artifact.key}: {artifact.reference}
                      </li>
                    ))}
                  </ul>
                ) : null}
                {request.preflight.plan?.imageCatalogDigest ? (
                  <p className="break-all text-xs font-mono text-muted-foreground" data-testid="deployment-image-catalog-digest">
                    {tr("dep.artifacts", { digest: request.preflight.plan.imageCatalogDigest })}
                  </p>
                ) : null}
                <div className="mt-2 space-y-1 text-xs" data-testid="deployment-owner-confirmation">
                  <p>{tr("dep.trusted", { result: request.ownerConfirmation.result, method: request.ownerConfirmation.method })}</p>
                  <p>{tr("dep.readiness")}</p>
                  <p>{request.ownerConfirmation.reason}</p>
                  <p className="break-all">{tr("dep.target", { path: request.projectPath, cluster: request.clusterId, action: request.environment === "staging" ? tr("dep.actionStaging") : tr("dep.actionProd") })}</p>
                  <p className="break-all">{tr("dep.identity", { value: request.integrationId ?? tr("dep.notConfigured") })}</p>
                </div>
                {synthetic && (
                  <p className="mt-1 text-xs" data-testid="deployment-synthetic-authorization">
                    {tr("dep.synth", {
                      state: request.executionAuthDigest && request.executionAuthAt != null
                        ? (syntheticExpiresAt! <= now ? tr("dep.synthExpired") : tr("dep.synthIssued"))
                        : request.executionAuthAt != null ? tr("dep.synthConsumed") : tr("dep.synthNone"),
                      expiry: syntheticExpiresAt != null ? tr("dep.expires", { at: new Date(syntheticExpiresAt).toISOString() }) : tr("dep.noExpiry"),
                    })}
                  </p>
                )}
                {request.errorMessage ? <p className="text-xs text-destructive">{request.errorMessage}</p> : null}
              </div>
              {request.status === "awaiting_owner" && actorRole === "owner" && (
                <div className="flex gap-2">
                  <Button type="button" size="sm" variant="outline" disabled={busyId === request.id} onClick={() => void reject(request)} data-testid="deployment-reject">
                    {tr("dep.reject")}
                  </Button>
                  <Button
                    type="button"
                    size="sm"
                    disabled={busyId === request.id || (request.environment === "production" && !confirmProduction)}
                    onClick={() => void approve(request)}
                    data-testid="deployment-approve"
                  >
                    {tr("dep.ack")}
                  </Button>
                </div>
              )}
              {!synthetic && request.environment === "staging" && ["dry_run_complete", "dry_run_unsupported"].includes(request.status) && (
                <Button type="button" size="sm" variant="outline" disabled={busyId === request.id}
                  onClick={() => void reviewHandoff(request)} data-testid="deployment-review-handoff">
                  {tr("dep.reviewHandoff")}
                </Button>
              )}
              {synthetic && request.executionState === "awaiting_execution_auth" && actorRole === "owner" && (
                <div className="flex gap-2">
                  <Button
                    type="button"
                    size="sm"
                    disabled={busyId === request.id}
                    onClick={() => void authorizeExecution(request)}
                    data-testid="deployment-authorize-execution"
                  >
                    {tr("dep.authorize")}
                  </Button>
                </div>
              )}
              {synthetic && request.executionState === "ready_to_execute" && (
                <Button type="button" size="sm" variant="outline" disabled={busyId === request.id}
                  onClick={() => void revokeSyntheticGrant(request)} data-testid="deployment-revoke-execution">
                  {tr("dep.revoke")}
                </Button>
              )}
            </div>
            {request.preflight.findings.length > 0 && (
              <ul className="mt-2 space-y-1 text-xs" data-testid="deployment-preflight">
                {request.preflight.findings.map((f) => (
                  <li key={f.code} data-severity={f.severity}>{f.message}</li>
                ))}
              </ul>
            )}
            {request.preflight.plan && (
              <ol className="mt-2 list-decimal pl-4 text-xs text-muted-foreground" data-testid="deployment-plan">
                {request.preflight.plan.steps.map((step) => (
                  <li key={step.label}>{step.label}: {step.detail}</li>
                ))}
              </ol>
            )}
            {dryRun && (
              <p className="mt-2 text-xs font-medium" data-testid="deployment-dry-run-result" data-outcome={dryRun.outcome} data-simulated={dryRun.simulated ? "1" : "0"}>
                <span className="font-mono">{dryRun.outcome}</span> — {dryRunOutcomeDescription(dryRun)}
              </p>
            )}
            {request.executionState === "reconciliation_required" && (
              <p className="mt-1 text-xs text-warning" data-testid="deployment-reconciliation-required">
                {tr("dep.reconcile")}
              </p>
            )}
            {request.executionState === "awaiting_execution_auth" && (
              <p className="mt-1 text-xs text-muted-foreground" data-testid="deployment-execution-readiness">
                {tr("dep.pendingOwner")}
              </p>
            )}
            {synthetic && request.executionState === "ready_to_execute" && (
              <p className="mt-1 text-xs text-muted-foreground" data-testid="deployment-execution-authorized">
                {tr("dep.syntheticBound")}
              </p>
            )}
            {request.attempts.length > 0 && (
              <ul className="mt-2 space-y-1 text-xs" data-testid="deployment-attempt-history">
                {request.attempts.map((attempt) => (
                  <li key={attempt.id} data-state={attempt.state}>
                    {tr("dep.attempt", { id: attempt.id.slice(0, 8), state: attempt.state })}
                    {attempt.logSanitized ? ` · ${attempt.logSanitized.slice(0, 80)}` : ""}
                  </li>
                ))}
              </ul>
            )}
          </li>
          );
        })}
      </ul>
    </section>
  );
}
