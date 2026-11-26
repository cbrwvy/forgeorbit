/**
 * FO-DEPLOY01 deployment requests — persisted workflow, preflight, Owner approval, synthetic dry-run.
 */

import type { Database } from "bun:sqlite";
import { randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";
import { ClusterCore } from "./cluster-core.ts";
import { InfrastructureCore } from "./infrastructure-core.ts";
import { ActivityJournalCore } from "./activity-journal-core.ts";
import {
  computeApprovalDigest,
  parseDeploymentRequestApprove,
  parseDeploymentRequestCreate,
  parseDeploymentRequestId,
  parseDeploymentRequestPatch,
  parseDeploymentRequestReject,
  parseDeploymentExecutionAuthorize,
  type DeploymentPlan,
  type DeploymentRequestApprove,
  type DeploymentRequestCreate,
  type DeploymentRequestPatch,
  type DeploymentRequestRecord,
  type DeploymentRequestReject,
  type DeploymentRequestStatus,
  type DeploymentExecutionAttemptRecord,
  type DeploymentExecutionState,
  type DryRunResult,
  type PreflightFinding,
} from "../shared/deployment-request/types.ts";
import { runDeploymentPreflight, type PreflightContext } from "../shared/deployment-request/preflight.ts";
import { normalizeDryRunResult } from "../shared/deployment-request/dry-run-display.ts";
import { computeExecutionAuthDigest, computePlanDigest } from "../shared/deployment-request/plan-digest.ts";
import { sanitizeDeploymentLog } from "../shared/deployment-request/log-sanitize.ts";
import { StagingIntegrationCore } from "./deployment-staging-integration-core.ts";
import type { StagingIntegrationRecord } from "../shared/deployment-request/integration.ts";
import { fakeStagingDryRun, fakeStagingExecute, fakeStagingPreflight } from "./deployment-fake-staging-adapter.ts";
import { externalStagingAdapterPreflight, externalStagingConfigPreflight, externalStagingDryRun } from "./deployment-external-staging-adapter.ts";
import { resolveExternalImageArtifacts } from "./deployment-external-staging-executor.ts";

import { OWNER_CHANNEL_BLOCKER, SYNTHETIC_AUTH_TTL_MS, unsupportedOwnerConfirmation, type DeploymentManualHandoff } from "../shared/deployment-request/owner-authorization.ts";

export class DeploymentRequestError extends Error {
  constructor(message: string, readonly status = 400, readonly code = "invalid") {
    super(message);
    this.name = "DeploymentRequestError";
  }
}

export interface DeploymentRequestCoreOptions {
  now?: () => number;
  adapterEnabled?: () => boolean;
  executionEnabled?: () => boolean;
  executeTimeoutMs?: number;
}

interface Row {
  id: string;
  project_path: string;
  cluster_id: string;
  environment: "staging" | "production";
  revision: string;
  revision_resolved: string | null;
  requested_by_role: string;
  status: string;
  approval_digest: string | null;
  approval_generation: number;
  approved_at: number | null;
  rejected_at: number | null;
  preflight_json: string;
  dry_run_json: string | null;
  error_message: string | null;
  plan_digest: string | null;
  integration_id: string | null;
  execution_auth_digest: string | null;
  execution_auth_generation: number;
  execution_auth_at: number | null;
  execution_state: string;
  active_attempt_id: string | null;
  created_at: number;
  updated_at: number;
}

interface StoredPreflight {
  findings: PreflightFinding[];
  plan: DeploymentPlan | null;
  passed: boolean;
}

function take<T>(result: { ok: true; value: T } | { ok: false; error: string; status: number }): T {
  if (!result.ok) throw new DeploymentRequestError(result.error, result.status);
  return result.value;
}

function adapterConfigured(): boolean {
  return (
    process.env.FORGEORBIT_DEPLOYMENT_DRY_RUN_ADAPTER === "1" ||
    process.env.FORGEORBIT_DEPLOYMENT_STAGING_ADAPTER === "fake" ||
    process.env.FORGEORBIT_DEPLOYMENT_STAGING_ADAPTER === "external"
  );
}

function stagingAdapterKind(): "fake" | "external" | "legacy" | null {
  const kind = process.env.FORGEORBIT_DEPLOYMENT_STAGING_ADAPTER;
  if (kind === "fake" || kind === "external") return kind;
  if (process.env.FORGEORBIT_DEPLOYMENT_DRY_RUN_ADAPTER === "1") return "legacy";
  return null;
}

function executionRuntimeEnabled(): boolean {
  return process.env.FORGEORBIT_DEPLOYMENT_STAGING_EXECUTE === "1";
}

const EXECUTE_TIMEOUT_MS = 120_000;

function resolveRevision(projectPath: string, revision: string): { resolved: string | null; error: string | null } {
  const proc = spawnSync("git", ["rev-parse", "--verify", `${revision}^{commit}`], {
    cwd: projectPath,
    encoding: "utf8",
    timeout: 5000,
  });
  if (proc.status === 0 && proc.stdout?.trim()) {
    return { resolved: proc.stdout.trim(), error: null };
  }
  const err = (proc.stderr || proc.stdout || "Revision not found.").trim().split("\n")[0] ?? "Revision not found.";
  return { resolved: null, error: err.slice(0, 200) };
}

function findIntegrationResource(
  db: Database,
  projectPath: string,
  environment: string,
): { id: string; name: string; resourceType: string } | null {
  const row = db.query<{ id: string; name: string; resource_type: string }, [string, string]>(
    `SELECT r.id, r.name, r.resource_type
       FROM infrastructure_resources r
       JOIN infrastructure_environment_links el ON el.resource_id = r.id
      WHERE el.project_path = ?
        AND el.environment = ?
        AND el.custom_label = ''
        AND r.archived_at IS NULL
        AND r.resource_type IN ('cicd', 'deployment-environment')
      ORDER BY r.updated_at DESC
      LIMIT 1`,
  ).get(projectPath, environment);
  return row ? { id: row.id, name: row.name, resourceType: row.resource_type } : null;
}

export class DeploymentRequestCore {
  private readonly now: () => number;
  private readonly adapterEnabled: () => boolean;
  private readonly executionEnabled: () => boolean;
  private readonly executeTimeoutMs: number;
  private readonly clusters: ClusterCore;
  private readonly infrastructure: InfrastructureCore;
  private readonly journal: ActivityJournalCore;
  private readonly integrations: StagingIntegrationCore;
  private readonly activeExecutions = new Map<string, AbortController>();

  constructor(private readonly db: Database, options: DeploymentRequestCoreOptions = {}) {
    this.now = options.now ?? Date.now;
    this.adapterEnabled = options.adapterEnabled ?? adapterConfigured;
    this.executionEnabled = options.executionEnabled ?? executionRuntimeEnabled;
    this.executeTimeoutMs = options.executeTimeoutMs ?? EXECUTE_TIMEOUT_MS;
    this.clusters = new ClusterCore(db, { now: this.now });
    this.infrastructure = new InfrastructureCore(db, { now: this.now });
    this.journal = new ActivityJournalCore(db);
    this.integrations = new StagingIntegrationCore(db, this.now);
  }

  list(projectPath?: string): DeploymentRequestRecord[] {
    const rows = projectPath
      ? this.db.query<Row, [string]>(
          `SELECT * FROM deployment_requests WHERE project_path = ? ORDER BY updated_at DESC`,
        ).all(projectPath)
      : this.db.query<Row, []>(`SELECT * FROM deployment_requests ORDER BY updated_at DESC`).all();
    return rows.map((row) => this.toRecord(row));
  }

  get(id: string): DeploymentRequestRecord {
    take(parseDeploymentRequestId(id));
    const row = this.db.query<Row, [string]>(`SELECT * FROM deployment_requests WHERE id = ?`).get(id);
    if (!row) throw new DeploymentRequestError("Deployment request not found.", 404, "not-found");
    return this.toRecord(row);
  }

  create(input: unknown): DeploymentRequestRecord {
    const value = take(parseDeploymentRequestCreate(input));
    this.assertProject(value.projectPath);
    const id = randomUUID();
    const now = this.now();
    const preflight = this.buildPreflight(value);
    const status: DeploymentRequestStatus = preflight.passed ? "awaiting_owner" : "preflight_failed";
    const generation = 0;
    const revisionResolved = preflight.plan?.revisionResolved ?? null;
    const digest = preflight.passed
      ? computeApprovalDigest({
          id,
          projectPath: value.projectPath,
          clusterId: value.clusterId,
          environment: value.environment,
          revision: value.revision,
          revisionResolved,
          approvalGeneration: generation,
        })
      : null;
    this.db.run(
      `INSERT INTO deployment_requests (
         id, project_path, cluster_id, environment, revision, revision_resolved,
         requested_by_role, status, approval_digest, approval_generation,
         approved_at, rejected_at, preflight_json, dry_run_json, error_message,
         plan_digest, integration_id, execution_state,
         created_at, updated_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL, ?, NULL, NULL, ?, ?, 'none', ?, ?)`,
      [
        id,
        value.projectPath,
        value.clusterId,
        value.environment,
        value.revision,
        revisionResolved,
        value.requestedByRole,
        status,
        digest,
        generation,
        JSON.stringify(preflight),
        preflight.plan?.planDigest ?? null,
        preflight.plan?.stagingIntegrationId ?? null,
        now,
        now,
      ],
    );
    this.journal.record({
      eventType: "deployment.request.created",
      actorType: value.requestedByRole === "owner" ? "owner" : "project-manager",
      actorId: value.requestedByRole,
      targetType: "project",
      targetId: value.projectPath,
      projectPath: value.projectPath,
      idempotencyKey: `deployment.request.created:${id}`,
      payload: {
        requestId: id,
        clusterId: value.clusterId,
        environment: value.environment,
        revision: value.revision,
        requestedByRole: value.requestedByRole,
        status,
      },
    });
    return this.get(id);
  }

  patch(id: string, input: unknown): DeploymentRequestRecord {
    const patch = take(parseDeploymentRequestPatch(input));
    const existing = this.getRow(id);
    if (existing.status !== "awaiting_owner" && existing.status !== "preflight_failed") {
      throw new DeploymentRequestError("Only pending requests can be edited.", 409, "locked");
    }
    const next: DeploymentRequestCreate = {
      projectPath: existing.project_path,
      clusterId: patch.clusterId ?? existing.cluster_id,
      environment: patch.environment ?? existing.environment,
      revision: patch.revision ?? existing.revision,
      requestedByRole: existing.requested_by_role as DeploymentRequestCreate["requestedByRole"],
    };
    const preflight = this.buildPreflight(next);
    const status: DeploymentRequestStatus = preflight.passed ? "awaiting_owner" : "preflight_failed";
    const generation = existing.approval_generation + 1;
    const revisionResolved = preflight.plan?.revisionResolved ?? null;
    const digest = preflight.passed
      ? computeApprovalDigest({
          id,
          projectPath: next.projectPath,
          clusterId: next.clusterId,
          environment: next.environment,
          revision: next.revision,
          revisionResolved,
          approvalGeneration: generation,
        })
      : null;
    const now = this.now();
    this.db.run(
      `UPDATE deployment_requests SET
         cluster_id = ?, environment = ?, revision = ?, revision_resolved = ?,
         status = ?, approval_digest = ?, approval_generation = ?,
         approved_at = NULL, rejected_at = NULL, preflight_json = ?,
         dry_run_json = NULL, error_message = NULL,
         plan_digest = ?, integration_id = ?, execution_auth_digest = NULL,
         execution_auth_at = NULL, execution_auth_generation = execution_auth_generation + 1,
         execution_state = 'none', active_attempt_id = NULL, updated_at = ?
       WHERE id = ?`,
      [
        next.clusterId,
        next.environment,
        next.revision,
        revisionResolved,
        status,
        digest,
        generation,
        JSON.stringify(preflight),
        preflight.plan?.planDigest ?? null,
        preflight.plan?.stagingIntegrationId ?? null,
        now,
        id,
      ],
    );
    return this.get(id);
  }

  approve(id: string, input: unknown): DeploymentRequestRecord {
    const body = take(parseDeploymentRequestApprove(input));
    return this.approveInner(id, body);
  }

  reject(id: string, input: unknown): DeploymentRequestRecord {
    const body = take(parseDeploymentRequestReject(input));
    const row = this.getRow(id);
    if (row.status !== "awaiting_owner") {
      throw new DeploymentRequestError("Request is not awaiting Owner approval.", 409, "state");
    }
    const expected = row.approval_digest;
    if (!expected || body.approvalDigest !== expected) {
      throw new DeploymentRequestError("Approval digest does not match this request.", 409, "stale");
    }
    const now = this.now();
    this.db.run(
      `UPDATE deployment_requests SET status = 'rejected', rejected_at = ?, updated_at = ? WHERE id = ? AND status = 'awaiting_owner'`,
      [now, now, id],
    );
    this.journal.record({
      eventType: "deployment.request.rejected",
      actorType: "owner",
      actorId: "owner",
      targetType: "project",
      targetId: row.project_path,
      projectPath: row.project_path,
      idempotencyKey: `deployment.request.rejected:${id}:${row.approval_generation}`,
      payload: { requestId: id, environment: row.environment, clusterId: row.cluster_id },
    });
    return this.get(id);
  }

  /** Plan acknowledgement only. The shared HTTP Bearer does not authenticate Owner. */
  approveInner(id: string, body: DeploymentRequestApprove): DeploymentRequestRecord {
    const row = this.getRow(id);
    if (
      row.status === "dry_run_complete" ||
      row.status === "dry_run_not_configured" ||
      row.status === "dry_run_unsupported" ||
      row.status === "dry_run_failed" ||
      row.status === "approved"
    ) {
      throw new DeploymentRequestError("Request was already approved and processed.", 409, "duplicate");
    }
    if (row.status !== "awaiting_owner") {
      throw new DeploymentRequestError("Request is not awaiting Owner approval.", 409, "state");
    }
    const expected = row.approval_digest;
    if (!expected || body.approvalDigest !== expected) {
      throw new DeploymentRequestError("Approval digest does not match this request.", 409, "stale");
    }
    if (row.environment === "production" && !body.confirmProduction) {
      throw new DeploymentRequestError("Production deployment requires confirmProduction.", 400, "confirm");
    }
    const preflight = parseStoredPreflight(row.preflight_json);
    if (!preflight.plan) {
      throw new DeploymentRequestError("Preflight plan is missing.", 409, "preflight");
    }
    const now = this.now();
    const claimed = this.db.run(
      `UPDATE deployment_requests SET status = 'approved', approved_at = ?, updated_at = ? WHERE id = ? AND status = 'awaiting_owner'`,
      [now, now, id],
    );
    if (claimed.changes !== 1) {
      throw new DeploymentRequestError("Request was already approved.", 409, "duplicate");
    }
    this.journal.record({
      eventType: "deployment.request.approved",
      actorType: "owner",
      actorId: "owner",
      targetType: "project",
      targetId: row.project_path,
      projectPath: row.project_path,
      idempotencyKey: `deployment.request.approved:${id}:${row.approval_generation}`,
      payload: {
        requestId: id,
        environment: row.environment,
        clusterId: row.cluster_id,
        revision: row.revision,
        approvalDigest: body.approvalDigest,
      },
    });
    const dryRun = this.runDryRun(preflight.plan);
    const finalStatus: DeploymentRequestStatus =
      dryRun.outcome === "SIMULATED" ||
      dryRun.outcome === "CONFIG_VERIFIED" ||
      dryRun.outcome === "REAL_DRY_RUN_VERIFIED"
        ? "dry_run_complete"
        : dryRun.outcome === "NOT_CONFIGURED"
          ? "dry_run_not_configured"
          : dryRun.outcome === "UNSUPPORTED"
            ? "dry_run_unsupported"
            : "dry_run_failed";
    const executionState: DeploymentExecutionState =
      finalStatus === "dry_run_complete" && row.environment === "staging" ? "awaiting_execution_auth" : "none";
    this.db.run(
      `UPDATE deployment_requests SET status = ?, dry_run_json = ?, error_message = ?,
         plan_digest = ?, integration_id = ?, execution_state = ?, updated_at = ? WHERE id = ?`,
      [
        finalStatus,
        JSON.stringify(dryRun),
        dryRun.outcome === "FAILED" ? dryRun.message : null,
        preflight.plan.planDigest,
        preflight.plan.stagingIntegrationId,
        executionState,
        this.now(),
        id,
      ],
    );
    this.journal.record({
      eventType: "deployment.dry_run.completed",
      actorType: "system",
      actorId: null,
      targetType: "project",
      targetId: row.project_path,
      projectPath: row.project_path,
      idempotencyKey: `deployment.dry_run.completed:${id}:${row.approval_generation}`,
      payload: {
        requestId: id,
        outcome: dryRun.outcome,
        simulated: dryRun.simulated,
        remoteCommandsExecuted: dryRun.remoteCommandsExecuted,
      },
    });
    return this.get(id);
  }

  listAwaitingOwner(): { projectPath: string; id: string; title: string; environment: "staging" | "production"; clusterId: string }[] {
    return this.db.query<Row, []>(
      `SELECT * FROM deployment_requests WHERE status = 'awaiting_owner' ORDER BY updated_at DESC`,
    ).all().map((row) => this.toHoldRow(row));
  }

  listAwaitingExecutionAuth(): { projectPath: string; id: string; title: string; environment: "staging"; clusterId: string }[] {
    return this.db.query<Row, []>(
      `SELECT * FROM deployment_requests WHERE execution_state = 'awaiting_execution_auth' ORDER BY updated_at DESC`,
    ).all().map((row) => ({
      ...this.toHoldRow(row),
      environment: "staging" as const,
    }));
  }

  authorizeExecution(id: string, input: unknown): DeploymentRequestRecord {
    const body = take(parseDeploymentExecutionAuthorize(input));
    const row = this.getRow(id);
    if (row.execution_state !== "awaiting_execution_auth") {
      throw new DeploymentRequestError("Request is not awaiting execution authorization.", 409, "state");
    }
    if (row.environment !== "staging") {
      throw new DeploymentRequestError("Production deployment execution is not supported.", 403, "production");
    }
    // No API field, environment flag, or injected core option can enable real authorization.
    const integration = this.requireSyntheticIntegration(row);
    this.assertBoundPlan(row, integration);
    const expected = this.expectedExecutionAuthDigest(row);
    if (!expected || body.executionAuthDigest !== expected) {
      throw new DeploymentRequestError("Execution authorization digest does not match this plan.", 409, "stale");
    }
    const now = this.now();
    const claimed = this.db.run(
      `UPDATE deployment_requests SET execution_auth_digest = ?, execution_auth_at = ?, execution_state = 'ready_to_execute', error_message = NULL, updated_at = ?
       WHERE id = ? AND execution_state = 'awaiting_execution_auth' AND execution_auth_at IS NULL`,
      [body.executionAuthDigest, now, now, id],
    );
    if (claimed.changes !== 1) {
      throw new DeploymentRequestError("Execution authorization was already consumed or is stale.", 409, "duplicate");
    }
    this.journal.record({
      eventType: "deployment.execution.authorized",
      actorType: "system",
      actorId: null,
      targetType: "project",
      targetId: row.project_path,
      projectPath: row.project_path,
      idempotencyKey: `deployment.execution.authorized:${id}:${row.execution_auth_generation}`,
      payload: {
        requestId: id,
        planDigest: row.plan_digest,
        executionAuthDigest: body.executionAuthDigest,
        runtimeEnabled: this.executionEnabled(),
      },
    });
    return this.get(id);
  }

  async executeStaging(id: string): Promise<DeploymentRequestRecord> {
    const row = this.getRow(id);
    if (row.environment !== "staging") {
      throw new DeploymentRequestError("Production deployment execution is not supported.", 403, "production");
    }
    // Also reject legacy ready rows and forged local DB approvals before any adapter dispatch.
    const integration = this.requireSyntheticIntegration(row);
    if (row.execution_state !== "ready_to_execute") {
      throw new DeploymentRequestError("Request is not ready to execute.", 409, "state");
    }
    if (row.execution_auth_at == null || !row.execution_auth_digest) {
      throw new DeploymentRequestError("Execution authorization is missing or already consumed.", 409, "state");
    }
    if (row.execution_auth_at > this.now() || this.now() >= row.execution_auth_at + SYNTHETIC_AUTH_TTL_MS) {
      throw new DeploymentRequestError("Synthetic execution authorization expired; cancel it and authorize again.", 409, "expired");
    }
    const expectedAuth = this.expectedExecutionAuthDigest(row);
    if (!expectedAuth || row.execution_auth_digest !== expectedAuth) {
      throw new DeploymentRequestError("Execution authorization digest is stale.", 409, "stale");
    }
    if (!this.executionEnabled()) {
      throw new DeploymentRequestError(
        "Real staging execution is disabled on this instance (FORGEORBIT_DEPLOYMENT_STAGING_EXECUTE).",
        403,
        "disabled",
      );
    }
    const plan = this.assertBoundPlan(row, integration);
    if (stagingAdapterKind() !== "fake") {
      throw new DeploymentRequestError("Only the explicit in-process fake adapter can execute.", 403, "adapter");
    }
    return this.executeStagingFake(id, row, plan, integration);
  }

  private async executeStagingFake(
    id: string,
    row: Row,
    plan: DeploymentPlan,
    integration: StagingIntegrationRecord,
  ): Promise<DeploymentRequestRecord> {
    this.assertExecutionSlot(id);
    const attemptId = randomUUID();
    const now = this.now();
    this.claimExecutionStart(id, attemptId, row, integration.id, now);
    const controller = new AbortController();
    this.activeExecutions.set(id, controller);
    this.journal.record({
      eventType: "deployment.execution.started",
      actorType: "system",
      actorId: null,
      targetType: "project",
      targetId: row.project_path,
      projectPath: row.project_path,
      idempotencyKey: `deployment.execution.started:${attemptId}`,
      payload: { requestId: id, attemptId, planDigest: row.plan_digest, adapter: "fake" },
    });
    const result = await fakeStagingExecute(plan, integration, {
      timeoutMs: this.executeTimeoutMs,
      signal: controller.signal,
    });
    this.activeExecutions.delete(id);
    return this.finishExecutionAttempt(id, row, attemptId, result.exitCode, result.log, result.errorMessage, result.state);
  }

  private requireSyntheticIntegration(row: Row): StagingIntegrationRecord {
    const integration = row.integration_id ? this.integrations.get(row.integration_id) : null;
    const plan = parseStoredPreflight(row.preflight_json).plan;
    if (integration?.integrationType !== "forgeorbit-fake-staging-v1" ||
        plan?.stagingIntegrationType !== "forgeorbit-fake-staging-v1") {
      throw new DeploymentRequestError(OWNER_CHANNEL_BLOCKER, 403, "owner-channel-unsupported");
    }
    return integration;
  }

  private assertBoundPlan(row: Row, integration: StagingIntegrationRecord): DeploymentPlan {
    const plan = parseStoredPreflight(row.preflight_json).plan;
    if (!plan || !row.plan_digest || plan.planDigest !== row.plan_digest ||
        computePlanDigest(plan, integration.id, integration.integrationType) !== row.plan_digest ||
        plan.projectPath !== row.project_path || plan.clusterId !== row.cluster_id ||
        plan.environment !== row.environment || plan.revision !== row.revision ||
        plan.revisionResolved !== row.revision_resolved || plan.stagingIntegrationId !== integration.id ||
        plan.stagingIntegrationType !== integration.integrationType ||
        integration.projectPath !== row.project_path || integration.clusterId !== row.cluster_id ||
        integration.environment !== row.environment || plan.stagingProjectSlug !== integration.projectSlug ||
        plan.entrypointRef !== integration.entrypointRef || plan.imagesCatalogRef !== integration.imagesCatalogRef) {
      throw new DeploymentRequestError("Approved plan or integration changed; create a new request.", 409, "plan");
    }
    return plan;
  }

  /** Read-only review packet. It never authorizes or launches any command. */
  manualHandoff(id: string): DeploymentManualHandoff {
    const row = this.getRow(id);
    if (row.environment !== "staging") {
      throw new DeploymentRequestError("Production handoff is prohibited.", 403, "production");
    }
    const integration = row.integration_id ? this.integrations.get(row.integration_id) : null;
    if (integration?.integrationType !== "external-staging-v1") {
      throw new DeploymentRequestError("Manual handoff requires an external staging integration.", 409, "integration");
    }
    const preflight = parseStoredPreflight(row.preflight_json);
    if (!["dry_run_complete", "dry_run_unsupported"].includes(row.status) || row.approved_at == null || !preflight.passed) {
      throw new DeploymentRequestError("An acknowledged valid plan without a failed dry-run is required for handoff.", 409, "state");
    }
    const plan = this.assertBoundPlan(row, integration);
    const images = resolveExternalImageArtifacts(plan, integration);
    if (!images.ok || !plan.imageCatalogDigest || plan.imageCatalogDigest !== images.value.catalogDigest ||
        JSON.stringify(plan.imageArtifacts) !== JSON.stringify(images.value.artifacts)) {
      throw new DeploymentRequestError("Image catalog changed or is unavailable; create a new request.", 409, "artifacts");
    }
    return {
      schema: "forgeorbit-deployment-review-v1", requestId: id, action: "deploy-staging",
      reviewOnly: true, executionAuthorized: false, generatedAt: this.now(), planDigest: row.plan_digest!,
      target: { projectPath: row.project_path, projectName: plan.projectName, clusterId: row.cluster_id,
        clusterName: plan.clusterName, environment: "staging" },
      revisionResolved: plan.revisionResolved!,
      integration: { id: integration.id, type: integration.integrationType, label: integration.integrationLabel,
        projectSlug: integration.projectSlug, entrypointRef: integration.entrypointRef },
      imagesCatalogRef: integration.imagesCatalogRef!, imageCatalogDigest: plan.imageCatalogDigest,
      imageArtifacts: images.value.artifacts,
      dryRunOutcome: row.dry_run_json ? normalizeDryRunResult(JSON.parse(row.dry_run_json)).outcome : "UNSUPPORTED",
      instructions: "Review this untrusted proposal independently on an Owner-controlled execution surface with credentials unavailable to agents. Revalidate target, SHA, image digests, controller provenance and plan digest there. This packet is not approval, a capability, or evidence of deployment. No command is provided or run by ForgeOrbit; real execution remains blocked.",
    };
  }

  private assertExecutionSlot(requestId: string): void {
    const running = this.db.query<{ id: string }, [string]>(
      `SELECT id FROM deployment_execution_attempts WHERE request_id = ? AND state = 'running' LIMIT 1`,
    ).get(requestId);
    if (running) {
      throw new DeploymentRequestError("An execution attempt is already running.", 409, "concurrent");
    }
    const priorSuccess = this.db.query<{ id: string }, [string]>(
      `SELECT id FROM deployment_execution_attempts WHERE request_id = ? AND state = 'succeeded' LIMIT 1`,
    ).get(requestId);
    if (priorSuccess) {
      throw new DeploymentRequestError("A successful execution attempt already exists.", 409, "duplicate");
    }
  }

  private claimExecutionStart(
    requestId: string,
    attemptId: string,
    row: Row,
    integrationId: string,
    now: number,
  ): void {
    this.db.transaction(() => {
      this.assertExecutionSlot(requestId);
      const claimed = this.db.run(
        `UPDATE deployment_requests SET execution_state = 'running', active_attempt_id = ?, execution_auth_digest = NULL, updated_at = ?
         WHERE id = ? AND execution_state = 'ready_to_execute' AND execution_auth_digest = ?
           AND execution_auth_generation = ? AND execution_auth_at = ? AND execution_auth_at > ?`,
        [attemptId, now, requestId, row.execution_auth_digest, row.execution_auth_generation,
          row.execution_auth_at, now - SYNTHETIC_AUTH_TTL_MS],
      );
      if (claimed.changes !== 1) {
        throw new DeploymentRequestError("Execution start could not be claimed.", 409, "concurrent");
      }
      this.db.run(
        `INSERT INTO deployment_execution_attempts (
           id, request_id, integration_id, plan_digest, revision, revision_resolved,
           state, exit_code, log_sanitized, error_message, started_at, finished_at, created_at
         ) VALUES (?, ?, ?, ?, ?, ?, 'running', NULL, NULL, NULL, ?, NULL, ?)`,
        [attemptId, requestId, integrationId, row.plan_digest!, row.revision, row.revision_resolved, now, now],
      );
    }).immediate();
  }

  private finishExecutionAttempt(
    requestId: string,
    row: Row,
    attemptId: string,
    exitCode: number | null,
    logRaw: string,
    errorMessage: string | null,
    finalState: DeploymentExecutionState,
  ): DeploymentRequestRecord {
    const finished = this.now();
    const log = sanitizeDeploymentLog(logRaw);
    this.db.run(
      `UPDATE deployment_execution_attempts SET state = ?, exit_code = ?, log_sanitized = ?, error_message = ?, finished_at = ? WHERE id = ?`,
      [finalState, exitCode, log, errorMessage, finished, attemptId],
    );
    this.db.run(
      `UPDATE deployment_requests SET execution_state = ?, active_attempt_id = NULL, execution_auth_generation = execution_auth_generation + 1, error_message = ?, updated_at = ? WHERE id = ?`,
      [finalState, errorMessage, finished, requestId],
    );
    this.journal.record({
      eventType: "deployment.execution.finished",
      actorType: "system",
      actorId: null,
      targetType: "project",
      targetId: row.project_path,
      projectPath: row.project_path,
      idempotencyKey: `deployment.execution.finished:${attemptId}`,
      payload: { requestId, attemptId, state: finalState, exitCode },
    });
    return this.get(requestId);
  }

  cancelExecution(id: string): DeploymentRequestRecord {
    const row = this.getRow(id);
    if (row.execution_state === "ready_to_execute" || row.execution_state === "awaiting_execution_auth") {
      this.db.run(
        `UPDATE deployment_requests SET execution_auth_digest = NULL, execution_auth_at = NULL,
           execution_auth_generation = execution_auth_generation + 1, execution_state = 'awaiting_execution_auth',
           error_message = 'Execution authorization revoked.', updated_at = ? WHERE id = ?`,
        [this.now(), id],
      );
      return this.get(id);
    }
    if (row.execution_state !== "running") {
      throw new DeploymentRequestError("No running execution to cancel.", 409, "state");
    }
    const controller = this.activeExecutions.get(id);
    controller?.abort();
    return this.get(id);
  }

  reconcileExecution(id: string): DeploymentRequestRecord {
    const row = this.getRow(id);
    if (row.execution_state !== "running" && row.execution_state !== "reconciliation_required") {
      throw new DeploymentRequestError("Request does not require reconciliation.", 409, "state");
    }
    const attempt = row.active_attempt_id
      ? this.db.query<{ id: string; state: string }, [string]>(`SELECT id, state FROM deployment_execution_attempts WHERE id = ?`).get(row.active_attempt_id)
      : null;
    if (attempt?.state === "running") {
      this.db.run(
        `UPDATE deployment_execution_attempts SET state = 'reconciliation_required', error_message = ?, finished_at = ? WHERE id = ?`,
        ["Outcome unknown after restart — manual reconciliation required.", this.now(), attempt.id],
      );
    }
    this.db.run(
      `UPDATE deployment_requests SET execution_state = 'reconciliation_required', active_attempt_id = NULL, updated_at = ? WHERE id = ?`,
      [this.now(), id],
    );
    this.journal.record({
      eventType: "deployment.execution.reconciliation_required",
      actorType: "owner",
      actorId: "owner",
      targetType: "project",
      targetId: row.project_path,
      projectPath: row.project_path,
      idempotencyKey: `deployment.execution.reconciliation_required:${id}:${this.now()}`,
      payload: { requestId: id },
    });
    return this.get(id);
  }

  private toHoldRow(row: Row) {
    const project = this.db.query<{ name: string }, [string]>(`SELECT name FROM projects WHERE path = ?`).get(row.project_path);
    const envLabel = row.environment === "production" ? "Production" : "Staging";
    return {
      projectPath: row.project_path,
      id: row.id,
      title: `Deploy ${envLabel} · ${project?.name ?? row.project_path}`,
      environment: row.environment,
      clusterId: row.cluster_id,
    };
  }

  private runDryRun(plan: DeploymentPlan): DryRunResult {
    const integration = plan.stagingIntegrationId
      ? this.integrations.get(plan.stagingIntegrationId)
      : null;
    const kind = stagingAdapterKind();
    if (integration && kind === "fake" && integration.integrationType === "forgeorbit-fake-staging-v1") {
      const result = fakeStagingDryRun(plan, integration);
      return { ...result, plan };
    }
    if (integration && kind === "external" && integration.integrationType === "external-staging-v1") {
      const result = externalStagingDryRun(plan, integration);
      return { ...result, plan };
    }
    if (!this.adapterEnabled()) {
      return {
        outcome: "NOT_CONFIGURED",
        simulated: false,
        remoteCommandsExecuted: 0,
        message: "NOT_CONFIGURED — staging adapter is not enabled on this instance.",
        plan,
      };
    }
    return {
      outcome: "SIMULATED",
      simulated: true,
      remoteCommandsExecuted: 0,
      message: "SIMULATED — legacy dry-run completed without remote commands.",
      plan,
    };
  }

  private adapterPreflightForPlan(
    plan: DeploymentPlan,
    integration: StagingIntegrationRecord | null,
  ): PreflightFinding[] {
    if (!integration) return [];
    const kind = stagingAdapterKind();
    if (kind === "fake" && integration.integrationType === "forgeorbit-fake-staging-v1") {
      return fakeStagingPreflight(plan, integration).findings;
    }
    if (kind === "external" && integration.integrationType === "external-staging-v1") {
      return externalStagingAdapterPreflight(plan, integration);
    }
    return [];
  }

  private buildPreflight(value: DeploymentRequestCreate): StoredPreflight {
    const resolved = this.clusters.resolve(value.projectPath);
    const clusterRow = this.db.query<{ name: string; archived_at: number | null }, [string]>(
      `SELECT name, archived_at FROM clusters WHERE id = ?`,
    ).get(value.clusterId);
    const revision = resolveRevision(value.projectPath, value.revision);
    const stagingIntegration =
      value.environment === "staging"
        ? this.integrations.findForTarget(value.clusterId, value.projectPath, value.environment)
        : null;
    const draftPlan: DeploymentPlan = {
      projectPath: value.projectPath,
      projectName: resolved.name,
      clusterId: value.clusterId,
      clusterName: clusterRow?.name ?? value.clusterId,
      environment: value.environment,
      revision: value.revision,
      revisionResolved: revision.resolved,
      integrationResourceId: null,
      integrationResourceName: null,
      stagingIntegrationId: stagingIntegration?.id ?? null,
      stagingIntegrationType: stagingIntegration?.integrationType ?? null,
      stagingIntegrationLabel: stagingIntegration?.integrationLabel ?? null,
      stagingProjectSlug: stagingIntegration?.projectSlug ?? null,
      entrypointRef: stagingIntegration?.entrypointRef ?? null,
      imagesCatalogRef: stagingIntegration?.imagesCatalogRef ?? null,
      imageArtifacts: null,
      imageCatalogDigest: null,
      planDigest: null,
      steps: [],
      note: "",
    };
    const adapterFindings = this.adapterPreflightForPlan(draftPlan, stagingIntegration);
    const ctx: PreflightContext = {
      projectPath: value.projectPath,
      projectName: resolved.name,
      clusterId: value.clusterId,
      clusterName: clusterRow?.name ?? null,
      clusterArchived: clusterRow?.archived_at != null,
      membershipClusterId: resolved.clusterId,
      declaredEnvironments: this.infrastructure.listProjectEnvironments(value.projectPath).map((d) => ({
        environment: d.environment,
        customLabel: d.customLabel,
      })),
      integrationResource: findIntegrationResource(this.db, value.projectPath, value.environment),
      revisionResolved: revision.resolved,
      revisionError: revision.error,
      adapterConfigured: this.adapterEnabled(),
      stagingIntegration,
      adapterPreflightFindings: adapterFindings,
    };
    const result = runDeploymentPreflight({
      projectPath: value.projectPath,
      projectName: resolved.name,
      clusterId: value.clusterId,
      clusterName: clusterRow?.name ?? null,
      environment: value.environment,
      revision: value.revision,
      context: ctx,
    });
    if (result.plan && stagingIntegration?.integrationType === "external-staging-v1") {
      const enriched = this.bindExternalImageArtifacts(result.plan, stagingIntegration, result.findings);
      if (!enriched.plan) {
        return { findings: enriched.findings, plan: null, passed: false };
      }
      result.plan = enriched.plan;
      result.findings = enriched.findings;
    }
    if (result.plan && adapterFindings.some((f) => f.severity === "error")) {
      return { findings: result.findings, plan: null, passed: false };
    }
    return result;
  }

  private bindExternalImageArtifacts(
    plan: DeploymentPlan,
    integration: StagingIntegrationRecord,
    findings: PreflightFinding[],
  ): { plan: DeploymentPlan | null; findings: PreflightFinding[] } {
    const nextFindings = [...findings];
    if (!integration.imagesCatalogRef) {
      nextFindings.push({
        code: "catalog.optional",
        severity: "warning",
        message: "No images catalog configured — external controller preflight/execute will fail until published-images.env is mapped.",
      });
      const planDigest = computePlanDigest(plan, integration.id, integration.integrationType);
      return { plan: { ...plan, planDigest }, findings: nextFindings };
    }
    const resolved = resolveExternalImageArtifacts(plan, integration);
    if (!resolved.ok) {
      nextFindings.push({ code: resolved.finding.code, severity: "error", message: resolved.finding.message });
      return { plan: null, findings: nextFindings };
    }
    const bound: DeploymentPlan = {
      ...plan,
      imagesCatalogRef: integration.imagesCatalogRef,
      imageArtifacts: resolved.value.artifacts,
      imageCatalogDigest: resolved.value.catalogDigest,
      planDigest: null,
    };
    bound.planDigest = computePlanDigest(bound, integration.id, integration.integrationType);
    nextFindings.push({
      code: "catalog.bound",
      severity: "info",
      message: `Immutable image catalog bound (${resolved.value.artifacts.length} reference(s)).`,
    });
    return { plan: bound, findings: nextFindings };
  }

  private assertProject(projectPath: string): void {
    const row = this.db.query<{ path: string }, [string]>(`SELECT path FROM projects WHERE path = ?`).get(projectPath);
    if (!row) throw new DeploymentRequestError("Project is not registered.", 404, "not-found");
  }

  private getRow(id: string): Row {
    take(parseDeploymentRequestId(id));
    const row = this.db.query<Row, [string]>(`SELECT * FROM deployment_requests WHERE id = ?`).get(id);
    if (!row) throw new DeploymentRequestError("Deployment request not found.", 404, "not-found");
    return row;
  }

  private expectedExecutionAuthDigest(row: Row): string | null {
    if (!row.plan_digest) return null;
    const integration = row.integration_id
      ? this.db.query<{ integration_type: string }, [string]>(
          `SELECT integration_type FROM deployment_staging_integrations WHERE id = ?`,
        ).get(row.integration_id)
      : null;
    const preflight = parseStoredPreflight(row.preflight_json);
    return computeExecutionAuthDigest({
      requestId: row.id,
      projectPath: row.project_path,
      clusterId: row.cluster_id,
      environment: row.environment,
      revision: row.revision,
      revisionResolved: row.revision_resolved,
      planDigest: row.plan_digest,
      integrationId: row.integration_id,
      integrationType: integration?.integration_type ?? null,
      imageCatalogDigest: preflight.plan?.imageCatalogDigest ?? null,
      executionAuthGeneration: row.execution_auth_generation,
    });
  }

  private loadAttempts(requestId: string): DeploymentExecutionAttemptRecord[] {
    return this.db.query<
      {
        id: string;
        request_id: string;
        integration_id: string | null;
        plan_digest: string;
        revision: string;
        revision_resolved: string | null;
        state: string;
        exit_code: number | null;
        log_sanitized: string | null;
        error_message: string | null;
        started_at: number | null;
        finished_at: number | null;
        created_at: number;
      },
      [string]
    >(
      `SELECT * FROM deployment_execution_attempts WHERE request_id = ? ORDER BY created_at DESC`,
    ).all(requestId).map((a) => ({
      id: a.id,
      requestId: a.request_id,
      integrationId: a.integration_id,
      planDigest: a.plan_digest,
      revision: a.revision,
      revisionResolved: a.revision_resolved,
      state: a.state as DeploymentExecutionAttemptRecord["state"],
      exitCode: a.exit_code,
      logSanitized: a.log_sanitized,
      errorMessage: a.error_message,
      startedAt: a.started_at,
      finishedAt: a.finished_at,
      createdAt: a.created_at,
    }));
  }

  private toRecord(row: Row): DeploymentRequestRecord {
    const preflight = parseStoredPreflight(row.preflight_json);
    const dryRunRaw = row.dry_run_json ? (JSON.parse(row.dry_run_json) as DryRunResult) : null;
    const dryRun = dryRunRaw ? normalizeDryRunResult(dryRunRaw) : null;
    const project = this.db.query<{ name: string }, [string]>(`SELECT name FROM projects WHERE path = ?`).get(row.project_path);
    const cluster = this.db.query<{ name: string }, [string]>(`SELECT name FROM clusters WHERE id = ?`).get(row.cluster_id);
    let approvalDigest = row.approval_digest;
    if (row.status === "awaiting_owner" && approvalDigest) {
      approvalDigest = computeApprovalDigest({
        id: row.id,
        projectPath: row.project_path,
        clusterId: row.cluster_id,
        environment: row.environment,
        revision: row.revision,
        revisionResolved: row.revision_resolved,
        approvalGeneration: row.approval_generation,
      });
    }
    let executionAuthDigest = row.execution_auth_digest;
    if (row.execution_state === "awaiting_execution_auth") {
      executionAuthDigest = this.expectedExecutionAuthDigest(row);
    }
    return {
      id: row.id,
      projectPath: row.project_path,
      projectName: project?.name ?? row.project_path,
      clusterId: row.cluster_id,
      clusterName: cluster?.name ?? row.cluster_id,
      environment: row.environment,
      revision: row.revision,
      revisionResolved: row.revision_resolved,
      requestedByRole: row.requested_by_role as DeploymentRequestRecord["requestedByRole"],
      status: row.status as DeploymentRequestStatus,
      approvalDigest,
      approvalGeneration: row.approval_generation,
      approvedAt: row.approved_at,
      rejectedAt: row.rejected_at,
      preflight,
      dryRun,
      planDigest: row.plan_digest,
      integrationId: row.integration_id,
      executionAuthDigest,
      executionAuthGeneration: row.execution_auth_generation,
      executionAuthAt: row.execution_auth_at,
      ownerConfirmation: unsupportedOwnerConfirmation(),
      executionState: row.execution_state as DeploymentExecutionState,
      activeAttemptId: row.active_attempt_id,
      attempts: this.loadAttempts(row.id),
      errorMessage: row.error_message,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }
}

function parseStoredPreflight(raw: string): StoredPreflight {
  try {
    const value = JSON.parse(raw) as StoredPreflight;
    return {
      findings: Array.isArray(value.findings) ? value.findings : [],
      plan: value.plan ?? null,
      passed: !!value.passed,
    };
  } catch {
    return { findings: [], plan: null, passed: false };
  }
}

export function listDeploymentRequestHolds(db: Database): ReturnType<DeploymentRequestCore["listAwaitingOwner"]> {
  return new DeploymentRequestCore(db).listAwaitingOwner();
}

export function listDeploymentExecutionAuthHolds(
  db: Database,
): ReturnType<DeploymentRequestCore["listAwaitingExecutionAuth"]> {
  return new DeploymentRequestCore(db).listAwaitingExecutionAuth();
}
