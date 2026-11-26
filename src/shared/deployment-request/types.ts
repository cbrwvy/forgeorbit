/**
 * FO-DEPLOY01 / FO-DEPLOY02 — deployment request workflow (proposal → Owner approval → dry-run → execution auth).
 */

import { createHash } from "node:crypto";
import { validateProjectPath } from "../clusters/paths.ts";

export const DEPLOYMENT_TARGET_ENVIRONMENTS = ["staging", "production"] as const;
export type DeploymentTargetEnvironment = (typeof DEPLOYMENT_TARGET_ENVIRONMENTS)[number];

export const DEPLOYMENT_REQUESTER_ROLES = ["owner", "project-manager", "head-of-pm"] as const;
export type DeploymentRequesterRole = (typeof DEPLOYMENT_REQUESTER_ROLES)[number];

export const DEPLOYMENT_REQUEST_STATUSES = [
  "preflight_failed",
  "awaiting_owner",
  "approved",
  "rejected",
  "dry_run_complete",
  "dry_run_not_configured",
  "dry_run_failed",
  "dry_run_unsupported",
] as const;
export type DeploymentRequestStatus = (typeof DEPLOYMENT_REQUEST_STATUSES)[number];

export const DEPLOYMENT_EXECUTION_STATES = [
  "none",
  "awaiting_execution_auth",
  "ready_to_execute",
  "running",
  "succeeded",
  "failed",
  "cancelled",
  "reconciliation_required",
] as const;
export type DeploymentExecutionState = (typeof DEPLOYMENT_EXECUTION_STATES)[number];

export const DRY_RUN_OUTCOMES = [
  "SIMULATED",
  "CONFIG_VERIFIED",
  "REAL_PREFLIGHT_VERIFIED",
  "REAL_DRY_RUN_VERIFIED",
  "NOT_CONFIGURED",
  "UNSUPPORTED",
  "FAILED",
] as const;
export type DryRunOutcome = (typeof DRY_RUN_OUTCOMES)[number];

export type DryRunEvidence = "none" | "synthetic" | "config" | "local-preflight" | "local-dry-run";

export type PreflightSeverity = "error" | "warning" | "info";

export interface PreflightFinding {
  code: string;
  severity: PreflightSeverity;
  message: string;
}

import type { DeploymentImageArtifact } from "./image-artifacts.ts";

export interface DeploymentPlanStep {
  kind: "validate" | "prepare" | "simulate";
  label: string;
  detail: string;
}

export interface DeploymentPlan {
  projectPath: string;
  projectName: string;
  clusterId: string;
  clusterName: string;
  environment: DeploymentTargetEnvironment;
  revision: string;
  revisionResolved: string | null;
  integrationResourceId: string | null;
  integrationResourceName: string | null;
  stagingIntegrationId: string | null;
  stagingIntegrationType: string | null;
  stagingIntegrationLabel: string | null;
  stagingProjectSlug: string | null;
  entrypointRef: string | null;
  imagesCatalogRef: string | null;
  imageArtifacts: DeploymentImageArtifact[] | null;
  imageCatalogDigest: string | null;
  planDigest: string | null;
  steps: DeploymentPlanStep[];
  note: string;
}

export interface DryRunResult {
  outcome: DryRunOutcome;
  simulated: boolean;
  remoteCommandsExecuted: number;
  message: string;
  evidence?: DryRunEvidence;
  plan: DeploymentPlan;
}

export interface DeploymentExecutionAttemptRecord {
  id: string;
  requestId: string;
  integrationId: string | null;
  planDigest: string;
  revision: string;
  revisionResolved: string | null;
  state: DeploymentExecutionState;
  exitCode: number | null;
  logSanitized: string | null;
  errorMessage: string | null;
  startedAt: number | null;
  finishedAt: number | null;
  createdAt: number;
}

export interface DeploymentRequestRecord {
  id: string;
  projectPath: string;
  projectName: string;
  clusterId: string;
  clusterName: string;
  environment: DeploymentTargetEnvironment;
  revision: string;
  revisionResolved: string | null;
  requestedByRole: DeploymentRequesterRole;
  status: DeploymentRequestStatus;
  approvalDigest: string | null;
  approvalGeneration: number;
  approvedAt: number | null;
  rejectedAt: number | null;
  preflight: { findings: PreflightFinding[]; plan: DeploymentPlan | null; passed: boolean };
  dryRun: DryRunResult | null;
  planDigest: string | null;
  integrationId: string | null;
  executionAuthDigest: string | null;
  executionAuthGeneration: number;
  executionAuthAt: number | null;
  /** Public capability status, never a credential or proof of user presence. */
  ownerConfirmation: import("./owner-authorization.ts").DeploymentOwnerConfirmation;
  executionState: DeploymentExecutionState;
  activeAttemptId: string | null;
  attempts: DeploymentExecutionAttemptRecord[];
  errorMessage: string | null;
  createdAt: number;
  updatedAt: number;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export type DeploymentParse<T> = { ok: true; value: T } | { ok: false; error: string; status: number };

function fail(error: string, status = 400): DeploymentParse<never> {
  return { ok: false, error, status };
}

const CREATE_KEYS = ["projectPath", "clusterId", "environment", "revision", "requestedByRole"] as const;
const PATCH_KEYS = ["clusterId", "environment", "revision"] as const;
const APPROVE_KEYS = ["approvalDigest", "confirmProduction"] as const;
const REJECT_KEYS = ["approvalDigest"] as const;
const EXEC_AUTH_KEYS = ["executionAuthDigest", "confirmOwner"] as const;

export interface DeploymentRequestCreate {
  projectPath: string;
  clusterId: string;
  environment: DeploymentTargetEnvironment;
  revision: string;
  requestedByRole: DeploymentRequesterRole;
}

export interface DeploymentRequestPatch {
  clusterId?: string;
  environment?: DeploymentTargetEnvironment;
  revision?: string;
}

export interface DeploymentRequestApprove {
  approvalDigest: string;
  confirmProduction?: boolean;
}

export interface DeploymentRequestReject {
  approvalDigest: string;
}

export interface DeploymentExecutionAuthorize {
  executionAuthDigest: string;
  /** Legacy compatibility field. Never authenticates Owner; real authorization is blocked. */
  confirmOwner?: boolean;
}

export function deploymentEnvironmentLabel(environment: DeploymentTargetEnvironment): string {
  return environment === "production" ? "Production" : "Staging";
}

export function computeApprovalDigest(input: {
  id: string;
  projectPath: string;
  clusterId: string;
  environment: DeploymentTargetEnvironment;
  revision: string;
  revisionResolved: string | null;
  approvalGeneration: number;
}): string {
  const payload = JSON.stringify({
    id: input.id,
    projectPath: input.projectPath,
    clusterId: input.clusterId,
    environment: input.environment,
    revision: input.revision,
    revisionResolved: input.revisionResolved,
    approvalGeneration: input.approvalGeneration,
  });
  return createHash("sha256").update(payload).digest("hex");
}

function parseUuid(value: unknown, label: string): DeploymentParse<string> {
  if (typeof value !== "string" || !UUID_RE.test(value.toLowerCase())) return fail(`Invalid ${label}.`, 400);
  return { ok: true, value: value.toLowerCase() };
}

function parseEnvironment(value: unknown): DeploymentParse<DeploymentTargetEnvironment> {
  if (typeof value !== "string" || !DEPLOYMENT_TARGET_ENVIRONMENTS.includes(value as DeploymentTargetEnvironment)) {
    return fail("Environment must be staging or production.", 400);
  }
  return { ok: true, value: value as DeploymentTargetEnvironment };
}

function parseRole(value: unknown): DeploymentParse<DeploymentRequesterRole> {
  if (typeof value !== "string" || !DEPLOYMENT_REQUESTER_ROLES.includes(value as DeploymentRequesterRole)) {
    return fail("Invalid requestedByRole.", 400);
  }
  return { ok: true, value: value as DeploymentRequesterRole };
}

function parseRevision(value: unknown): DeploymentParse<string> {
  if (typeof value !== "string") return fail("Invalid revision.", 400);
  const revision = value.trim();
  if (revision.length < 1 || revision.length > 120 || /[\u0000-\u001f\u007f]/.test(revision)) {
    return fail("Invalid revision.", 400);
  }
  return { ok: true, value: revision };
}

function recordWithKeys(input: unknown, keys: readonly string[]): DeploymentParse<Record<string, unknown>> {
  if (!input || typeof input !== "object" || Array.isArray(input)) return fail("Expected an object.", 400);
  const record = input as Record<string, unknown>;
  for (const key of Object.keys(record)) {
    if (!keys.includes(key)) return fail("Unexpected field.", 400);
  }
  return { ok: true, value: record };
}

export function parseDeploymentRequestCreate(input: unknown): DeploymentParse<DeploymentRequestCreate> {
  const record = recordWithKeys(input, CREATE_KEYS);
  if (!record.ok) return record;
  const path = validateProjectPath(record.value.projectPath);
  if (!path.ok) return fail(path.error, 400);
  const clusterId = parseUuid(record.value.clusterId, "clusterId");
  if (!clusterId.ok) return clusterId;
  const environment = parseEnvironment(record.value.environment);
  if (!environment.ok) return environment;
  const revision = parseRevision(record.value.revision);
  if (!revision.ok) return revision;
  const requestedByRole = parseRole(record.value.requestedByRole);
  if (!requestedByRole.ok) return requestedByRole;
  return {
    ok: true,
    value: {
      projectPath: path.path,
      clusterId: clusterId.value,
      environment: environment.value,
      revision: revision.value,
      requestedByRole: requestedByRole.value,
    },
  };
}

export function parseDeploymentRequestPatch(input: unknown): DeploymentParse<DeploymentRequestPatch> {
  const record = recordWithKeys(input, PATCH_KEYS);
  if (!record.ok) return record;
  const value: DeploymentRequestPatch = {};
  if ("clusterId" in record.value) {
    const clusterId = parseUuid(record.value.clusterId, "clusterId");
    if (!clusterId.ok) return clusterId;
    value.clusterId = clusterId.value;
  }
  if ("environment" in record.value) {
    const environment = parseEnvironment(record.value.environment);
    if (!environment.ok) return environment;
    value.environment = environment.value;
  }
  if ("revision" in record.value) {
    const revision = parseRevision(record.value.revision);
    if (!revision.ok) return revision;
    value.revision = revision.value;
  }
  if (Object.keys(value).length === 0) return fail("Nothing to change.", 400);
  return { ok: true, value };
}

export function parseDeploymentRequestApprove(input: unknown): DeploymentParse<DeploymentRequestApprove> {
  const record = recordWithKeys(input, APPROVE_KEYS);
  if (!record.ok) return record;
  if (typeof record.value.approvalDigest !== "string" || !/^[0-9a-f]{64}$/.test(record.value.approvalDigest)) {
    return fail("Invalid approvalDigest.", 400);
  }
  const confirmProduction = record.value.confirmProduction;
  if (confirmProduction != null && typeof confirmProduction !== "boolean") {
    return fail("Invalid confirmProduction.", 400);
  }
  return {
    ok: true,
    value: {
      approvalDigest: record.value.approvalDigest,
      confirmProduction: confirmProduction ?? false,
    },
  };
}

export function parseDeploymentRequestReject(input: unknown): DeploymentParse<DeploymentRequestReject> {
  const record = recordWithKeys(input, REJECT_KEYS);
  if (!record.ok) return record;
  if (typeof record.value.approvalDigest !== "string" || !/^[0-9a-f]{64}$/.test(record.value.approvalDigest)) {
    return fail("Invalid approvalDigest.", 400);
  }
  return { ok: true, value: { approvalDigest: record.value.approvalDigest } };
}

export function parseDeploymentExecutionAuthorize(input: unknown): DeploymentParse<DeploymentExecutionAuthorize> {
  const record = recordWithKeys(input, EXEC_AUTH_KEYS);
  if (!record.ok) return record;
  if (typeof record.value.executionAuthDigest !== "string" || !/^[0-9a-f]{64}$/.test(record.value.executionAuthDigest)) {
    return fail("Invalid executionAuthDigest.", 400);
  }
  const confirmOwner = record.value.confirmOwner;
  if (confirmOwner != null && typeof confirmOwner !== "boolean") {
    return fail("Invalid confirmOwner.", 400);
  }
  return { ok: true, value: { executionAuthDigest: record.value.executionAuthDigest, confirmOwner: confirmOwner ?? false } };
}

export function parseDeploymentRequestId(value: string): DeploymentParse<string> {
  return parseUuid(value, "request id");
}
