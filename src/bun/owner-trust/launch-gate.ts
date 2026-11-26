/**
 * Single-use, operation-bound macOS Owner launch gate for supervised execution.
 *
 * Settings preview/enrollment (`requestId` starting with `"review:"` or
 * `externalProcess === false`) never authorizes a live provider spawn.
 * Every supervised Developer and independent read-only Reviewer launch must:
 *   1. Build its exact `OwnerOperation` on the server from prepared state.
 *   2. Collect and consume a fresh single-use proof via `trust.admit(..., { consume: true })`
 *      after explicit macOS confirmation (or an explicit in-process test seam).
 *   3. Enforce the single-use ticket and record `owner_trust_grant_uses` inside
 *      the orchestrator's atomic run-creation transaction before spawning.
 *   4. Verify and consume the final spawn token inside `spawnAgentImpl`.
 */
import { randomUUID } from "node:crypto";
import { realpathSync } from "node:fs";
import path from "node:path";
import type { Database } from "bun:sqlite";
import {
  OWNER_TRUST_SCHEMA,
  SINGLE_OPERATION_MAX_MS,
  canonicalize,
  expectedScope,
  parseOwnerOperation,
  sha256Hex,
  type OwnerOperation,
  type OwnerProofPayload,
} from "../../shared/owner-trust/protocol.ts";
import { localOwnerIdentityEstablished, sameCertPin } from "../../shared/owner-trust/signing-policy.ts";
import type { ExecutionConfig } from "../../shared/project-execution.ts";
import type { EmployeeRunReviewFacts } from "../../shared/execution/run.ts";
import type { Task, TaskQcReview } from "../../shared/types.ts";
import { readOnlyReviewerContract } from "../../shared/qc-recovery.ts";
import { isClaudeProfile, selectedClaudeAccount } from "../claude-profiles.ts";
import { isCodexProfile, selectedCodexAccount } from "../codex-profiles.ts";
import { currentReadScope } from "../codex-read-scope.ts";
import { db, harnesses } from "../db.ts";
import type { EmployeeRunRow } from "../employee-run-core.ts";
import { supervisedRunLimitSeconds } from "../supervised-run-limit.ts";
import { getTaskWorkspace, stagingCwdForTask } from "../task-workspace.ts";
import { missionBindingDigest, taskBindingDigest } from "./admission.ts";
import { authorizeOperationWithHelper, enrollAndAuthorizeProjectEnvelope } from "./native-bridge.ts";
import { ownerTrust, type OwnerTrustService } from "./service.ts";

export type SupervisedLaunchRole = "developer" | "reviewer" | "head-of-pm";

export interface BuiltLaunchOperation {
  operation: OwnerOperation;
  canonical: string;
  digest: string;
  role: SupervisedLaunchRole;
  taskId: string;
  attemptOrReviewId: string;
  /** Bound runId for isolated turns (e.g. Head of PM) whose runId is deterministic pre-spawn. */
  boundRunId?: string;
  projectPath: string;
  workspace: string;
  /** True when the effective workspace may be created lazily inside prepareWorkdir. */
  allowsLazyWorktree: boolean;
  accountId: string;
  harnessId: string;
  providerId: "codex" | "claude-code";
  modelId: string;
  mode: string;
}

export interface SupervisedLaunchTicket {
  grantId: string;
  operationDigest: string;
  role: SupervisedLaunchRole;
  taskId: string;
  attemptOrReviewId: string;
  boundRunId?: string;
  projectPath: string;
  workspace: string;
  allowsLazyWorktree: boolean;
  accountId: string;
  harnessId: string;
  providerId: "codex" | "claude-code";
  modelId: string;
  mode: string;
  taskStateDigest: string;
  expiresAt: number;
  consumed: boolean;
}

interface PendingSpawnAuthorization {
  grantId: string;
  taskId: string;
  runId: string;
  role: SupervisedLaunchRole;
  harnessId: string;
  mode: string;
  workspace: string;
  allowsLazyWorktree: boolean;
  projectPath: string;
  operationDigest: string;
  expiresAt: number;
}

export type NativeLaunchApproveReply =
  | {
    decision: "signed";
    payload: OwnerProofPayload;
    signature: string;
    publicKeySpki?: string;
  }
  | {
    decision: "refused" | "cancelled";
    code?: string;
    reason?: string;
  };

export type NativeLaunchApprover = (params: {
  operation: OwnerOperation;
  canonical: string;
  digest: string;
  nonce: string;
  enrollmentId: string;
  trust: OwnerTrustService;
  locale: "en" | "ru";
}) => Promise<NativeLaunchApproveReply>;

export interface OwnerTrustLaunchGateTestHooks {
  trust?: OwnerTrustService;
  nativeApprove?: NativeLaunchApprover;
  now?: () => number;
}

let testHooks: OwnerTrustLaunchGateTestHooks | null = null;
const activeTickets = new Map<string, SupervisedLaunchTicket>();
const activeSpawns = new Map<string, PendingSpawnAuthorization>();

/**
 * In-process test seam only (never exposed over HTTP or env vars).
 * Passing `null` clears overrides and clears in-memory launch/spawn tickets.
 */
export function setOwnerTrustLaunchGateForTest(hooks: OwnerTrustLaunchGateTestHooks | null): void {
  testHooks = hooks;
  activeTickets.clear();
  activeSpawns.clear();
}

export function currentOwnerTrustService(): OwnerTrustService {
  return testHooks?.trust ?? ownerTrust();
}

function nowMs(): number {
  return testHooks?.now?.() ?? Date.now();
}

/** True whenever the running process establishes the production app.forgeorbit Owner identity. */
export function isProductionOwnerGateActive(): boolean {
  return localOwnerIdentityEstablished(currentOwnerTrustService().identity);
}

function normalizePath(target: string): string {
  const resolved = path.resolve(target);
  try {
    return realpathSync.native(resolved);
  } catch {
    // Resolve the nearest existing ancestor so paths inside macOS symlinked
    // roots (e.g. /var -> /private/var) normalize identically before and after mkdir.
    const suffix: string[] = [];
    let cursor = resolved;
    for (;;) {
      const parent = path.dirname(cursor);
      if (parent === cursor) return resolved;
      suffix.unshift(path.basename(cursor));
      cursor = parent;
      try {
        return path.join(realpathSync.native(cursor), ...suffix);
      } catch {
        // Keep walking upward.
      }
    }
  }
}

function resolveProviderAndAccount(harnessId: string, database: Database = db):
  | { ok: true; providerId: "codex" | "claude-code"; accountId: string }
  | { ok: false; code: string; reason: string } {
  const harness = harnesses.get(harnessId) ?? harnesses.getByIdOrKind(harnessId);
  if (!harness || !harness.enabled) {
    return { ok: false, code: "owner-router-ineligible", reason: "The selected execution resource is missing or disabled." };
  }
  const providerId = harness.kind === "codex" ? "codex" : harness.kind === "claude-code" ? "claude-code" : null;
  if (!providerId) {
    return { ok: false, code: "owner-provider-blocked", reason: "Only Codex and Claude can be authorized for Owner-gated launches." };
  }
  if (isCodexProfile(harness)) {
    const account = selectedCodexAccount(harness);
    if (!account) {
      return { ok: false, code: "owner-account-unbound", reason: "The selected Codex profile does not have a registered account." };
    }
    return { ok: true, providerId, accountId: account.id };
  }
  if (isClaudeProfile(harness)) {
    const account = selectedClaudeAccount(harness);
    if (!account) {
      return { ok: false, code: "owner-account-unbound", reason: "The selected Claude profile does not have a registered account." };
    }
    return { ok: true, providerId, accountId: account.id };
  }
  try {
    const row = database.query<{ account_id: string }, [string]>(
      "SELECT account_id FROM account_harness_bindings WHERE harness_id = ? LIMIT 1",
    ).get(harness.id);
    if (row?.account_id?.trim()) {
      return { ok: true, providerId, accountId: row.account_id.trim() };
    }
  } catch {
    // Table may not exist in minimal unit test DBs.
  }
  return { ok: false, code: "owner-account-unbound", reason: "Supervised Owner launches require a bound registered account. No fallback account was used." };
}

function missionContextForTask(database: Database, taskId: string): { id: string; revision: string; digest: string } {
  try {
    const rows = database.query<{ id: string; plan_digest: string; plan_json: string }, []>(
      `SELECT id, plan_digest, plan_json FROM orchestration_missions
       WHERE status NOT IN ('completed', 'failed', 'cancelled') ORDER BY updated_at DESC LIMIT 8`,
    ).all();
    const hit = rows.find((row) => row.plan_json.includes(taskId));
    if (hit) {
      return {
        id: hit.id,
        revision: hit.plan_digest || "none",
        digest: missionBindingDigest({ id: hit.id, planDigest: hit.plan_digest }),
      };
    }
  } catch {
    // Orchestration mission tables may be absent in unit tests.
  }
  return { id: "none", revision: "none", digest: sha256Hex("none") };
}

/** Builds the canonical live launch operation for a prepared Employee Execution Developer attempt. */
export function buildEmployeeAttemptOperation(params: {
  attempt: EmployeeRunRow;
  task: Task;
  config: ExecutionConfig;
  reviewFacts: EmployeeRunReviewFacts;
  database?: Database;
  now?: number;
}): { ok: true; built: BuiltLaunchOperation } | { ok: false; code: string; reason: string } {
  const database = params.database ?? db;
  const now = params.now ?? nowMs();
  const resolved = resolveProviderAndAccount(params.config.harness, database);
  if (!resolved.ok) return resolved;

  const staged = stagingCwdForTask(params.task.id);
  if (staged.block) {
    return { ok: false, code: "owner-sandbox", reason: staged.block };
  }
  const openStaging = getTaskWorkspace(params.task.id);
  const hasExistingWorktree = Boolean(params.task.worktreePath?.trim());
  const workspace = staged.cwd ?? params.task.worktreePath?.trim() ?? params.task.workdir;
  const allowsLazyWorktree = !staged.cwd && params.task.isolation === "worktree" && !hasExistingWorktree;

  const mode = (params.config.mode || "auto").trim();
  const mission = missionContextForTask(database, params.task.id);
  const codexReadScope = resolved.providerId === "codex" ? currentReadScope() : "default";
  const runLimitSeconds = supervisedRunLimitSeconds();
  const envelopeDigest = sha256Hex(canonicalize({
    accountId: resolved.accountId,
    accessMode: params.task.accessMode ?? "workspace",
    codexReadScope,
    effort: params.config.effort ?? null,
    executionId: params.attempt.execution_id ?? null,
    filesystem: "workspace-write",
    harnessId: params.config.harness,
    isolation: params.task.isolation,
    mode,
    modelId: params.config.model,
    permissionIdentity: params.reviewFacts.permissionIdentity ?? null,
    permissionSandbox: params.reviewFacts.permission?.sandbox ?? null,
    providerId: resolved.providerId,
    role: "developer",
    runLimitSeconds,
    stagingDir: staged.cwd ?? null,
    stagingId: openStaging?.id ?? null,
    stagingStatus: openStaging?.status ?? null,
    taskFingerprint: params.attempt.task_fingerprint,
    ...(params.reviewFacts.computerWorkflow ? {
      computerWorkflowScope: params.reviewFacts.computerWorkflow,
      computerWorkflowDocumentDigest: params.reviewFacts.computerWorkflowDocumentDigest ?? null,
      computerWorkflowLockdownArgs: params.reviewFacts.computerWorkflowLockdownArgs ?? [],
    } : {}),
    workspace,
    ...(openStaging?.writeScope === "working-copy" ? {
      workingCopyScratchDir: openStaging.scratchPath ?? null,
      workingCopyWriteScope: "working-copy",
    } : {}),
  }));

  const raw = {
    schema: OWNER_TRUST_SCHEMA,
    requestId: `launch:attempt:${params.attempt.id}:${randomUUID()}`,
    kind: "single-operation",
    projectPath: params.attempt.project_path,
    taskId: params.task.id,
    missionId: mission.id,
    missionRevision: mission.revision,
    role: "developer",
    providerId: resolved.providerId,
    harnessId: params.config.harness,
    modelId: params.config.model,
    accountId: resolved.accountId,
    mode,
    workspace,
    filesystem: "workspace-write",
    terminalAllowed: false,
    browserAllowed: false,
    computerUseAllowed: false,
    gitRead: true,
    gitPublish: false,
    deploymentAllowed: false,
    envelopeId: "supervised-developer",
    envelopeDigest,
    policyRevision: "none",
    scope: expectedScope({
      kind: "single-operation",
      role: "developer",
      providerId: resolved.providerId,
      accountId: resolved.accountId,
      modelId: params.config.model,
      missionId: mission.id,
      policyRevision: "none",
    }),
    runId: "none",
    attemptId: params.attempt.id,
    knownCost: "unknown",
    costCoverage: "unknown-subscription",
    expiresAt: now + SINGLE_OPERATION_MAX_MS,
    cancellationAvailable: true,
    externalProcess: true,
    taskStateDigest: taskBindingDigest({
      id: params.task.id,
      prompt: params.task.prompt,
      workdir: params.task.workdir,
      column: params.task.column,
    }),
    missionStateDigest: mission.digest,
  };

  const parsed = parseOwnerOperation(raw, now);
  if (!parsed.ok) return { ok: false, code: parsed.code, reason: parsed.reason };
  return {
    ok: true,
    built: {
      operation: parsed.operation,
      canonical: parsed.canonical,
      digest: parsed.digest,
      role: "developer",
      taskId: params.task.id,
      attemptOrReviewId: params.attempt.id,
      projectPath: params.attempt.project_path,
      workspace,
      allowsLazyWorktree,
      accountId: resolved.accountId,
      harnessId: params.config.harness,
      providerId: resolved.providerId,
      modelId: params.config.model,
      mode,
    },
  };
}

/** Builds the canonical live launch operation for an independent read-only QC Reviewer. */
export function buildQcReviewOperation(params: {
  review: TaskQcReview;
  task: Task;
  projectPath: string;
  harnessId: string;
  modelId: string;
  mode: string;
  effort?: string | null;
  recoveryGrantId?: string | null;
  database?: Database;
  now?: number;
}): { ok: true; built: BuiltLaunchOperation } | { ok: false; code: string; reason: string } {
  const database = params.database ?? db;
  const now = params.now ?? nowMs();
  const resolved = resolveProviderAndAccount(params.harnessId, database);
  if (!resolved.ok) return resolved;

  const contract = readOnlyReviewerContract(resolved.providerId);
  if (!contract || params.mode !== contract.mode) {
    return {
      ok: false,
      code: "owner-sandbox",
      reason: `Independent Reviewer requires read-only mode (${contract?.mode ?? "unsupported"}); got ${params.mode}.`,
    };
  }

  const workspace = params.task.worktreePath?.trim() || params.task.workdir;
  const mission = missionContextForTask(database, params.task.id);
  const codexReadScope = resolved.providerId === "codex" ? currentReadScope() : "default";
  const runLimitSeconds = supervisedRunLimitSeconds();
  const envelopeDigest = sha256Hex(canonicalize({
    accountId: resolved.accountId,
    accessMode: params.task.accessMode ?? "workspace",
    codexReadScope,
    effort: params.effort ?? null,
    filesystem: "read-only",
    harnessId: params.harnessId,
    isolation: params.task.isolation,
    mode: params.mode,
    modelId: params.modelId,
    providerId: resolved.providerId,
    recoveryGrantId: params.recoveryGrantId ?? null,
    reviewId: params.review.id,
    role: "reviewer",
    runLimitSeconds,
    workspace,
  }));

  const raw = {
    schema: OWNER_TRUST_SCHEMA,
    requestId: `launch:qc-review:${params.review.id}:${randomUUID()}`,
    kind: "single-operation",
    projectPath: params.projectPath,
    taskId: params.task.id,
    missionId: mission.id,
    missionRevision: mission.revision,
    role: "reviewer",
    providerId: resolved.providerId,
    harnessId: params.harnessId,
    modelId: params.modelId,
    accountId: resolved.accountId,
    mode: params.mode,
    workspace,
    filesystem: "read-only",
    terminalAllowed: false,
    browserAllowed: false,
    computerUseAllowed: false,
    gitRead: true,
    gitPublish: false,
    deploymentAllowed: false,
    envelopeId: "supervised-reviewer",
    envelopeDigest,
    policyRevision: "none",
    scope: expectedScope({
      kind: "single-operation",
      role: "reviewer",
      providerId: resolved.providerId,
      accountId: resolved.accountId,
      modelId: params.modelId,
      missionId: mission.id,
      policyRevision: "none",
    }),
    runId: "none",
    attemptId: params.review.id,
    knownCost: "unknown",
    costCoverage: "unknown-subscription",
    expiresAt: now + SINGLE_OPERATION_MAX_MS,
    cancellationAvailable: true,
    externalProcess: true,
    taskStateDigest: taskBindingDigest({
      id: params.task.id,
      prompt: params.task.prompt,
      workdir: params.task.workdir,
      column: params.task.column,
    }),
    missionStateDigest: mission.digest,
  };

  const parsed = parseOwnerOperation(raw, now);
  if (!parsed.ok) return { ok: false, code: parsed.code, reason: parsed.reason };
  return {
    ok: true,
    built: {
      operation: parsed.operation,
      canonical: parsed.canonical,
      digest: parsed.digest,
      role: "reviewer",
      taskId: params.task.id,
      attemptOrReviewId: params.review.id,
      projectPath: params.projectPath,
      workspace,
      // A worktree-isolated task whose worktree does not exist yet gets one when the Reviewer starts, exactly as a
      // Developer attempt does. The ticket's lazy-worktree rule only accepts the task's own folder as that origin.
      allowsLazyWorktree: params.task.isolation === "worktree" && !params.task.worktreePath?.trim(),
      accountId: resolved.accountId,
      harnessId: params.harnessId,
      providerId: resolved.providerId,
      modelId: params.modelId,
      mode: params.mode,
    },
  };
}

/** Builds the canonical live launch operation for a single isolated Head of PM model turn. */
export function buildHeadTurnOperation(params: {
  turnId: string;
  messageId: string;
  taskId: string;
  runId: string;
  workspace: string;
  harnessId: string;
  modelId: string;
  mode: string;
  effort?: string | null;
  lockdownArgs: readonly string[];
  scope: {
    kind: string;
    projectPath: string | null;
    clusterId: string | null;
    taskId?: string | null;
    projectPaths: readonly string[];
  };
  messageText: string;
  prompt: string;
  grants?: {
    knowledge?: boolean;
    brain?: boolean;
    browser?: boolean;
    native?: boolean;
  };
  database?: Database;
  now?: number;
}): { ok: true; built: BuiltLaunchOperation } | { ok: false; code: string; reason: string } {
  const database = params.database ?? db;
  const now = params.now ?? nowMs();
  const resolved = resolveProviderAndAccount(params.harnessId, database);
  if (!resolved.ok) return resolved;

  const projectPath = params.scope.projectPath?.trim()
    || (params.scope.clusterId ? `head-scope:cluster:${params.scope.clusterId}` : "head-scope:workspace");
  const normalizedWorkspace = normalizePath(params.workspace);
  const sortedProjectPaths = [...params.scope.projectPaths].sort();
  const mode = params.mode.trim();
  const taskStateDigest = sha256Hex(canonicalize({
    clusterId: params.scope.clusterId ?? null,
    kind: "head-turn",
    messageId: params.messageId,
    messageSha256: sha256Hex(params.messageText),
    projectPath: params.scope.projectPath ?? null,
    projectPaths: sortedProjectPaths,
    scopeKind: params.scope.kind,
    scopeTaskId: params.scope.taskId ?? null,
    turnId: params.turnId,
  }));
  const envelopeDigest = sha256Hex(canonicalize({
    accountId: resolved.accountId,
    effort: params.effort ?? null,
    filesystem: "read-only",
    grants: {
      brain: Boolean(params.grants?.brain),
      browser: Boolean(params.grants?.browser),
      knowledge: Boolean(params.grants?.knowledge),
      native: Boolean(params.grants?.native),
    },
    harnessId: params.harnessId,
    lockdownArgs: [...params.lockdownArgs],
    messageId: params.messageId,
    mode,
    modelId: params.modelId,
    projectPath,
    projectPaths: sortedProjectPaths,
    promptSha256: sha256Hex(params.prompt),
    providerId: resolved.providerId,
    role: "head-of-pm",
    runId: params.runId,
    scopeKind: params.scope.kind,
    taskId: params.taskId,
    turnId: params.turnId,
    workspace: normalizedWorkspace,
  }));

  const raw = {
    schema: OWNER_TRUST_SCHEMA,
    requestId: `launch:head-turn:${params.turnId}:${randomUUID()}`,
    kind: "single-operation",
    projectPath,
    taskId: params.taskId,
    missionId: "none",
    missionRevision: "none",
    role: "head-of-pm",
    providerId: resolved.providerId,
    harnessId: params.harnessId,
    modelId: params.modelId,
    accountId: resolved.accountId,
    mode,
    workspace: normalizedWorkspace,
    filesystem: "read-only",
    terminalAllowed: false,
    browserAllowed: false,
    computerUseAllowed: false,
    gitRead: false,
    gitPublish: false,
    deploymentAllowed: false,
    envelopeId: "head-of-pm-isolated-turn",
    envelopeDigest,
    policyRevision: "none",
    scope: expectedScope({
      kind: "single-operation",
      role: "head-of-pm",
      providerId: resolved.providerId,
      accountId: resolved.accountId,
      modelId: params.modelId,
      missionId: "none",
      policyRevision: "none",
    }),
    runId: params.runId,
    attemptId: params.turnId,
    knownCost: "unknown",
    costCoverage: "unknown-subscription",
    expiresAt: now + SINGLE_OPERATION_MAX_MS,
    cancellationAvailable: true,
    externalProcess: true,
    taskStateDigest,
    missionStateDigest: sha256Hex("none"),
  };

  const parsed = parseOwnerOperation(raw, now);
  if (!parsed.ok) return { ok: false, code: parsed.code, reason: parsed.reason };
  return {
    ok: true,
    built: {
      operation: parsed.operation,
      canonical: parsed.canonical,
      digest: parsed.digest,
      role: "head-of-pm",
      taskId: params.taskId,
      attemptOrReviewId: params.turnId,
      boundRunId: params.runId,
      projectPath,
      workspace: normalizedWorkspace,
      allowsLazyWorktree: false,
      accountId: resolved.accountId,
      harnessId: params.harnessId,
      providerId: resolved.providerId,
      modelId: params.modelId,
      mode,
    },
  };
}

function isPreviewOperation(operation: OwnerOperation): boolean {
  return !operation.externalProcess || operation.requestId.startsWith("review:");
}

function checkProofIsNotPreview(trust: OwnerTrustService, proof: unknown, expectedDigest: string): { ok: true } | { ok: false; code: string; reason: string } {
  if (!proof || typeof proof !== "object" || Array.isArray(proof)) {
    return { ok: false, code: "owner-proof-absent", reason: "Owner proof is missing." };
  }
  const payload = (proof as { payload?: { operationDigest?: unknown } }).payload;
  const proofDigest = typeof payload?.operationDigest === "string" ? payload.operationDigest : null;
  if (proofDigest && proofDigest !== expectedDigest) {
    const grant = trust.store.database.query<{ operation_canonical: string }, [string]>(
      "SELECT operation_canonical FROM owner_trust_grants WHERE operation_digest = ? ORDER BY created_at DESC LIMIT 1",
    ).get(proofDigest);
    if (grant && (grant.operation_canonical.includes('"externalProcess":false') || grant.operation_canonical.includes('"requestId":"review:'))) {
      return { ok: false, code: "owner-preview-not-launch", reason: "A Settings enrollment or preview confirmation cannot authorize a real provider launch." };
    }
    const ch = trust.store.database.query<{ operation_canonical: string }, [string]>(
      "SELECT operation_canonical FROM owner_trust_challenges WHERE operation_digest = ? ORDER BY created_at DESC LIMIT 1",
    ).get(proofDigest);
    if (ch && (ch.operation_canonical.includes('"externalProcess":false') || ch.operation_canonical.includes('"requestId":"review:'))) {
      return { ok: false, code: "owner-preview-not-launch", reason: "A Settings enrollment or preview confirmation cannot authorize a real provider launch." };
    }
  }
  return { ok: true };
}

function verifyEnrollmentActive(trust: OwnerTrustService): { ok: true; enrollmentId: string } | { ok: false; code: string; reason: string } {
  if (!localOwnerIdentityEstablished(trust.identity)) {
    return { ok: false, code: "application-identity-unestablished", reason: "This process is not signed by the pinned local Owner certificate." };
  }
  const profile = trust.store.database.query<{ sealed: number }, []>("SELECT sealed FROM owner_trust_profile WHERE id = 1").get();
  if (profile?.sealed === 1) {
    return { ok: false, code: "owner-restored-inactive", reason: "This profile is sealed and cannot authorize provider launches." };
  }
  const active = trust.store.activeByClass("production");
  if (active.length === 0) {
    const anyRow = trust.store.database.query<{ authority_state: string }, []>(
      "SELECT authority_state FROM owner_trust_enrollments ORDER BY created_at DESC, rowid DESC LIMIT 1",
    ).get();
    if (anyRow?.authority_state === "removed" || anyRow?.authority_state === "rotated") {
      return { ok: false, code: "owner-revoked", reason: "Owner enrollment was revoked or rotated. Enroll in Settings before launching." };
    }
    return { ok: false, code: "owner-not-enrolled", reason: "Owner Secure Enclave identity is not enrolled. Enroll in Settings before launching." };
  }
  const matched = active.find((row) => sameCertPin(row.signing_cert_sha256, trust.identity.certSha256));
  if (!matched) {
    return { ok: false, code: "owner-revoked", reason: "Active Owner enrollment is pinned to a different signing certificate." };
  }
  return { ok: true, enrollmentId: matched.id };
}

/**
 * A launch that asks to be covered by a project's hands-off envelope instead of its own native confirmation.
 * It never causes a prompt: when the envelope does not cover the launch, the launch is refused and the caller shows
 * one project-level blocker.
 */
export interface ProjectGrantClaim {
  handsoffRunId: string;
  round: number;
  /** The launch intent timestamp the driver recorded before starting. Part of the claim key, so a replay is refused. */
  intentAt: number;
}

export type ProjectGrantAuthorizer = (input: {
  built: BuiltLaunchOperation;
  claim: ProjectGrantClaim;
  mintTicket: (grantId: string) => { ok: true; grantId: string; operationDigest: string } | { ok: false; code: string; reason: string };
}) => { ok: true; grantId: string; operationDigest: string } | { ok: false; code: string; reason: string };

let projectGrantAuthorizer: ProjectGrantAuthorizer | null = null;
export function registerProjectGrantAuthorizer(fn: ProjectGrantAuthorizer | null): void { projectGrantAuthorizer = fn; }

/** Called when a ticket is thrown away unused (the launch aborted before a run was recorded). */
let ticketDiscardObserver: ((grantId: string) => void) | null = null;
export function registerTicketDiscardObserver(fn: ((grantId: string) => void) | null): void { ticketDiscardObserver = fn; }

/** Signed parent: one native confirmation for a project envelope. Returns the issued grant; starts nothing. */
export async function authorizeProjectEnvelopeOperation(params: {
  operation: OwnerOperation;
  canonical: string;
  digest: string;
  locale?: "en" | "ru";
}): Promise<{ ok: true; grantId: string; operationDigest: string } | { ok: false; code: string; reason: string }> {
  const trust = currentOwnerTrustService();
  if (params.operation.kind !== "project-envelope") return { ok: false, code: "owner-operation-mismatch", reason: "That is not a project envelope." };
  const enrolled = verifyEnrollmentActive(trust);
  // A profile that has never enrolled enrolls in this same native confirmation (key creation and first signature are one
  // act). A revoked, rotated, restored or differently pinned enrollment is not re-created here.
  if (!enrolled.ok && enrolled.code === "owner-not-enrolled" && !testHooks) {
    const decision = await enrollAndAuthorizeProjectEnvelope(trust, params.operation, params.canonical, params.digest, params.locale ?? "en");
    if (!decision.ok || !decision.executionReady || !decision.grantId) return { ok: false, code: decision.code, reason: decision.reason };
    return { ok: true, grantId: decision.grantId, operationDigest: decision.operationDigest ?? params.digest };
  }
  if (!enrolled.ok) return enrolled;
  if (testHooks) {
    if (!testHooks.nativeApprove) {
      return { ok: false, code: "owner-proof-absent", reason: "macOS Owner confirmation is required. A bearer request alone is refused." };
    }
    const issued = trust.issueChallenge(params.operation, enrolled.enrollmentId);
    if (!issued.ok) return { ok: false, code: issued.code, reason: issued.reason };
    const reply = await testHooks.nativeApprove({
      operation: params.operation, canonical: issued.canonical, digest: issued.digest, nonce: issued.nonce,
      enrollmentId: enrolled.enrollmentId, trust, locale: params.locale ?? "en",
    });
    const cancelOpenChallenge = () => {
      trust.store.database.run("UPDATE owner_trust_challenges SET status = 'cancelled', consumed_at = COALESCE(consumed_at, ?) WHERE id = ? AND status = 'open'", [nowMs(), issued.challengeId]);
    };
    if (reply.decision !== "signed") {
      cancelOpenChallenge();
      return { ok: false, code: reply.code ?? "authentication-cancelled", reason: reply.reason ?? "The confirmation was cancelled. Nothing was authorized." };
    }
    const proof = { schema: OWNER_TRUST_SCHEMA, payload: reply.payload, signature: reply.signature };
    const admitted = trust.admit(proof, params.operation, { trustClasses: ["production"], consume: true });
    if (!admitted.ok || !admitted.executionReady || !admitted.grantId) {
      cancelOpenChallenge();
      return { ok: false, code: admitted.code, reason: admitted.reason };
    }
    return { ok: true, grantId: admitted.grantId, operationDigest: admitted.operationDigest ?? params.digest };
  }
  const decision = await authorizeOperationWithHelper(trust, params.operation, params.canonical, params.digest, params.locale ?? "en");
  if (!decision.ok || !decision.executionReady || !decision.grantId) return { ok: false, code: decision.code, reason: decision.reason };
  return { ok: true, grantId: decision.grantId, operationDigest: decision.operationDigest ?? params.digest };
}

/**
 * Authorizes a real supervised provider launch, consuming one fresh macOS Owner
 * proof bound to `built` and minting one single-use launch ticket in memory.
 */
export async function authorizeSupervisedLaunch(params: {
  built: BuiltLaunchOperation;
  proofOverride?: unknown;
  locale?: "en" | "ru";
  /** Ask the project's envelope for a single-use child grant instead of a native confirmation. Never prompts. */
  projectGrant?: ProjectGrantClaim;
}): Promise<{ ok: true; grantId: string; operationDigest: string } | { ok: false; code: string; reason: string }> {
  const trust = currentOwnerTrustService();
  if (params.projectGrant) {
    if (isPreviewOperation(params.built.operation)) {
      return { ok: false, code: "owner-preview-not-launch", reason: "Preview operations cannot authorize provider launches." };
    }
    const enrolledForProject = verifyEnrollmentActive(trust);
    if (!enrolledForProject.ok) return enrolledForProject;
    if (!projectGrantAuthorizer) return { ok: false, code: "handsoff-authorization-missing", reason: "Project authorization is not available in this process." };
    return projectGrantAuthorizer({ built: params.built, claim: params.projectGrant, mintTicket: (grantId) => mintSingleUseTicket(params.built, grantId) });
  }
  if (isPreviewOperation(params.built.operation)) {
    return { ok: false, code: "owner-preview-not-launch", reason: "Preview operations cannot authorize provider launches." };
  }
  const enrolled = verifyEnrollmentActive(trust);
  if (!enrolled.ok) return enrolled;

  if (params.proofOverride !== undefined) {
    const notPreview = checkProofIsNotPreview(trust, params.proofOverride, params.built.digest);
    if (!notPreview.ok) return notPreview;
    const admitted = trust.admit(params.proofOverride, params.built.operation, {
      trustClasses: ["production"],
      consume: true,
    });
    if (!admitted.ok || !admitted.executionReady || !admitted.grantId) {
      return { ok: false, code: admitted.code, reason: admitted.reason };
    }
    return mintSingleUseTicket(params.built, admitted.grantId);
  }

  if (testHooks) {
    if (!testHooks.nativeApprove) {
      return {
        ok: false,
        code: "owner-proof-absent",
        reason: "macOS Owner confirmation is required before launching a provider. Bearer confirmation alone is refused.",
      };
    }
    const issued = trust.issueChallenge(params.built.operation, enrolled.enrollmentId);
    if (!issued.ok) {
      return { ok: false, code: issued.code, reason: issued.reason };
    }
    const reply = await testHooks.nativeApprove({
      operation: params.built.operation,
      canonical: issued.canonical,
      digest: issued.digest,
      nonce: issued.nonce,
      enrollmentId: enrolled.enrollmentId,
      trust,
      locale: params.locale ?? "en",
    });
    const cancelOpenChallenge = () => {
      trust.store.database.run(
        "UPDATE owner_trust_challenges SET status = 'cancelled', consumed_at = COALESCE(consumed_at, ?) WHERE id = ? AND status = 'open'",
        [nowMs(), issued.challengeId],
      );
    };
    if (reply.decision !== "signed") {
      cancelOpenChallenge();
      const code = reply.code ?? "authentication-cancelled";
      const reason = reply.reason ?? "macOS Owner confirmation was cancelled or refused. No provider was launched.";
      return { ok: false, code, reason };
    }
    const proof = { schema: OWNER_TRUST_SCHEMA, payload: reply.payload, signature: reply.signature };
    const notPreview = checkProofIsNotPreview(trust, proof, params.built.digest);
    if (!notPreview.ok) {
      cancelOpenChallenge();
      return notPreview;
    }
    const admitted = trust.admit(proof, params.built.operation, {
      trustClasses: ["production"],
      consume: true,
    });
    if (!admitted.ok || !admitted.executionReady || !admitted.grantId) {
      cancelOpenChallenge();
      return { ok: false, code: admitted.code, reason: admitted.reason };
    }
    return mintSingleUseTicket(params.built, admitted.grantId);
  }

  const decision = await authorizeOperationWithHelper(
    trust,
    params.built.operation,
    params.built.canonical,
    params.built.digest,
    params.locale ?? "en",
  );
  if (!decision.ok || !decision.executionReady || !decision.grantId) {
    return { ok: false, code: decision.code, reason: decision.reason };
  }
  return mintSingleUseTicket(params.built, decision.grantId);
}

function mintSingleUseTicket(
  built: BuiltLaunchOperation,
  grantId: string,
): { ok: true; grantId: string; operationDigest: string } | { ok: false; code: string; reason: string } {
  const trust = currentOwnerTrustService();
  const usedCount = trust.store.database.query<{ n: number }, [string]>(
    "SELECT COUNT(*) AS n FROM owner_trust_grant_uses WHERE grant_id = ?",
  ).get(grantId)?.n ?? 0;
  if (usedCount > 0 || activeTickets.has(grantId)) {
    return { ok: false, code: "owner-already-consumed", reason: "This Owner confirmation was already consumed for a launch." };
  }
  activeTickets.set(grantId, {
    grantId,
    operationDigest: built.digest,
    role: built.role,
    taskId: built.taskId,
    attemptOrReviewId: built.attemptOrReviewId,
    ...(built.boundRunId ? { boundRunId: built.boundRunId } : {}),
    projectPath: built.projectPath,
    workspace: built.workspace,
    allowsLazyWorktree: built.allowsLazyWorktree,
    accountId: built.accountId,
    harnessId: built.harnessId,
    providerId: built.providerId,
    modelId: built.modelId,
    mode: built.mode,
    taskStateDigest: built.operation.taskStateDigest,
    expiresAt: built.operation.expiresAt,
    consumed: false,
  });
  return { ok: true, grantId, operationDigest: built.digest };
}

/** Revokes an unused in-memory ticket when launch preparation aborts before run recording. */
export function discardUnconsumedLaunchTicket(grantId: string | undefined | null): void {
  if (!grantId) return;
  const ticket = activeTickets.get(grantId);
  if (ticket) ticket.consumed = true;
  activeTickets.delete(grantId);
  if (ticket) { try { ticketDiscardObserver?.(grantId); } catch { /* accounting is re-reconciled at the next claim and at boot */ } }
}

/** Ensures a grant row is still active, live-enrolled, non-preview, and never yet used to spawn. */
function verifyTicketMatchesStart(params: {
  grantId: string | undefined;
  task: Task;
  role: SupervisedLaunchRole;
  harnessId: string;
  modelId: string;
  mode: string;
  resolvedWorkspace?: string;
}): { ok: true; ticket: SupervisedLaunchTicket } | { ok: false; reason: string } {
  if (!params.grantId) {
    return {
      ok: false,
      reason: "macOS Owner confirmation for this exact operation is required. Direct or unconfirmed launches are blocked.",
    };
  }
  const ticket = activeTickets.get(params.grantId);
  if (!ticket || ticket.consumed) {
    return {
      ok: false,
      reason: "No unused Owner launch confirmation exists for this attempt. Confirm the exact operation again instead of replaying.",
    };
  }
  const now = nowMs();
  if (ticket.expiresAt <= now) {
    return { ok: false, reason: "The Owner launch confirmation expired before execution started." };
  }
  const trust = currentOwnerTrustService();
  const enrolled = verifyEnrollmentActive(trust);
  if (!enrolled.ok) {
    return { ok: false, reason: enrolled.reason };
  }
  const grant = trust.store.grant(params.grantId);
  if (!grant || grant.status !== "consumed" || grant.expires_at <= now || grant.operation_digest !== ticket.operationDigest || grant.task_id !== params.task.id) {
    return { ok: false, reason: "The Owner grant does not match an active consumed launch confirmation." };
  }
  if (grant.operation_canonical.includes('"externalProcess":false') || grant.operation_canonical.includes('"requestId":"review:')) {
    return { ok: false, reason: "A Settings preview grant cannot authorize a live provider launch." };
  }
  const priorUses = trust.store.database.query<{ n: number }, [string]>(
    "SELECT COUNT(*) AS n FROM owner_trust_grant_uses WHERE grant_id = ?",
  ).get(params.grantId)?.n ?? 0;
  if (priorUses > 0) {
    return { ok: false, reason: "This Owner launch confirmation was already used. Replays are refused." };
  }
  if (ticket.taskId !== params.task.id || ticket.role !== params.role) {
    return { ok: false, reason: "Owner launch confirmation does not match this task or role." };
  }
  if (ticket.harnessId !== params.harnessId || ticket.modelId !== params.modelId || ticket.mode !== params.mode) {
    return { ok: false, reason: "Owner launch confirmation does not match the execution harness, model, or mode." };
  }
  const currentDigest = taskBindingDigest({
    id: params.task.id,
    prompt: params.task.prompt,
    workdir: params.task.workdir,
    column: params.task.column,
  });
  if (ticket.taskStateDigest !== currentDigest) {
    return { ok: false, reason: "Task details changed after Owner confirmation. Confirm again for the updated task." };
  }
  const resolved = resolveProviderAndAccount(params.harnessId, db);
  if (!resolved.ok || resolved.accountId !== ticket.accountId || resolved.providerId !== ticket.providerId) {
    return { ok: false, reason: "Account binding or provider changed after Owner confirmation." };
  }
  if (params.resolvedWorkspace !== undefined) {
    const actual = normalizePath(params.resolvedWorkspace);
    const expected = normalizePath(ticket.workspace);
    const matchesExact = actual === expected;
    const matchesNewWorktree = ticket.allowsLazyWorktree
      && params.task.isolation === "worktree"
      && normalizePath(params.task.workdir) === expected;
    if (!matchesExact && !matchesNewWorktree) {
      return { ok: false, reason: "Effective workspace changed after Owner confirmation." };
    }
  }
  return { ok: true, ticket };
}

/** Early pre-flight inside `startTaskInner` before worktree materialization or run creation. */
export function verifyLaunchTicketBeforeStart(params: {
  grantId: string | undefined;
  task: Task;
  role: SupervisedLaunchRole;
  harnessId: string;
  modelId: string;
  mode: string;
  stagedOrResolvedWorkspace?: string;
}): string | null {
  const checked = verifyTicketMatchesStart({
    grantId: params.grantId,
    task: params.task,
    role: params.role,
    harnessId: params.harnessId,
    modelId: params.modelId,
    mode: params.mode,
    resolvedWorkspace: params.stagedOrResolvedWorkspace,
  });
  return checked.ok ? null : checked.reason;
}

/**
 * Atomically consumes the single-use launch ticket and records `owner_trust_grant_uses`
 * inside the orchestrator's `persist` SQLite transaction alongside the new `runs` row,
 * then mints a single-use spawn token for `spawnAgentImpl`.
 */
export function consumeLaunchTicketInRunTransaction(params: {
  grantId: string | undefined;
  task: Task;
  role: SupervisedLaunchRole;
  runId: string;
  harnessId: string;
  modelId: string;
  mode: string;
  resolvedWorkspace: string;
}): void {
  const checked = verifyTicketMatchesStart({
    grantId: params.grantId,
    task: params.task,
    role: params.role,
    harnessId: params.harnessId,
    modelId: params.modelId,
    mode: params.mode,
    resolvedWorkspace: params.resolvedWorkspace,
  });
  if (!checked.ok) {
    throw new Error(checked.reason);
  }
  const ticket = checked.ticket;
  ticket.consumed = true;
  activeTickets.delete(ticket.grantId);

  const trust = currentOwnerTrustService();
  trust.store.database.transaction(() => {
    const used = trust.store.database.query<{ n: number }, [string]>(
      "SELECT COUNT(*) AS n FROM owner_trust_grant_uses WHERE grant_id = ?",
    ).get(ticket.grantId)?.n ?? 0;
    if (used > 0) {
      throw new Error("This Owner launch confirmation was already used. Replays are refused.");
    }
    trust.store.database.run(
      `INSERT INTO owner_trust_grant_uses (id, grant_id, task_id, role, run_id, operation_digest, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [randomUUID(), ticket.grantId, params.task.id, ticket.role, params.runId, ticket.operationDigest, nowMs()],
    );
  }).immediate();
  activeSpawns.set(params.runId, {
    grantId: ticket.grantId,
    taskId: params.task.id,
    runId: params.runId,
    role: ticket.role,
    harnessId: params.harnessId,
    mode: params.mode,
    workspace: params.resolvedWorkspace,
    allowsLazyWorktree: ticket.allowsLazyWorktree,
    projectPath: ticket.projectPath,
    operationDigest: ticket.operationDigest,
    expiresAt: ticket.expiresAt,
  });
}

/** Enforces and consumes the single-use spawn authorization right at the `spawnAgentImpl` boundary. */
export function claimSpawnAuthorizationOrThrow(params: {
  runId: string;
  taskId: string;
  harnessId: string;
  mode: string;
  cwd: string;
}): void {
  const pending = activeSpawns.get(params.runId);
  activeSpawns.delete(params.runId);
  if (!pending) {
    throw new Error("Blocked: provider spawn requires a single-use macOS Owner launch confirmation.");
  }
  if (pending.expiresAt <= nowMs()) {
    throw new Error("Blocked: the macOS Owner launch confirmation expired before spawn.");
  }
  if (pending.taskId !== params.taskId || pending.harnessId !== params.harnessId || pending.mode !== params.mode) {
    throw new Error("Blocked: spawn parameters changed after Owner confirmation.");
  }
  if (normalizePath(pending.workspace) !== normalizePath(params.cwd)) {
    throw new Error("Blocked: spawn workspace changed after Owner confirmation.");
  }
  const trust = currentOwnerTrustService();
  const enrolled = verifyEnrollmentActive(trust);
  if (!enrolled.ok) {
    throw new Error(enrolled.reason);
  }
  const used = trust.store.database.query<{ n: number }, [string, string, string]>(
    "SELECT COUNT(*) AS n FROM owner_trust_grant_uses WHERE grant_id = ? AND run_id = ? AND task_id = ?",
  ).get(pending.grantId, params.runId, params.taskId)?.n ?? 0;
  if (used !== 1) {
    throw new Error("Blocked: Owner grant consumption record is missing for this spawn.");
  }
}

/**
 * Atomically consumes a single-use Head of PM isolated-turn launch ticket,
 * records `owner_trust_grant_uses`, and mints one single-use spawn token for
 * `spawnAgentImpl`.
 */
export function consumeHeadTurnLaunchTicket(params: {
  grantId: string | undefined;
  turnId: string;
  taskId: string;
  runId: string;
  harnessId: string;
  modelId: string;
  mode: string;
  resolvedWorkspace: string;
  taskStateDigest: string;
}): void {
  if (!params.grantId) {
    throw new Error("macOS Owner confirmation for this exact Head of PM turn is required. Direct or unconfirmed launches are blocked.");
  }
  const ticket = activeTickets.get(params.grantId);
  if (!ticket || ticket.consumed) {
    throw new Error("No unused Owner launch confirmation exists for this Head of PM turn. Confirm the exact turn again instead of replaying.");
  }
  const now = nowMs();
  if (ticket.expiresAt <= now) {
    throw new Error("The Owner launch confirmation expired before the Head of PM turn started.");
  }
  const trust = currentOwnerTrustService();
  const enrolled = verifyEnrollmentActive(trust);
  if (!enrolled.ok) {
    throw new Error(enrolled.reason);
  }
  const grant = trust.store.grant(params.grantId);
  if (!grant || grant.status !== "consumed" || grant.expires_at <= now || grant.operation_digest !== ticket.operationDigest || grant.task_id !== params.taskId) {
    throw new Error("The Owner grant does not match an active consumed Head of PM launch confirmation.");
  }
  if (grant.operation_canonical.includes('"externalProcess":false') || grant.operation_canonical.includes('"requestId":"review:')) {
    throw new Error("A Settings preview grant cannot authorize a live provider launch.");
  }
  if (
    ticket.role !== "head-of-pm"
    || ticket.attemptOrReviewId !== params.turnId
    || ticket.taskId !== params.taskId
    || ticket.boundRunId !== params.runId
  ) {
    throw new Error("Owner launch confirmation does not match this Head of PM turn.");
  }
  if (ticket.harnessId !== params.harnessId || ticket.modelId !== params.modelId || ticket.mode !== params.mode) {
    throw new Error("Owner launch confirmation does not match the Head of PM harness, model, or mode.");
  }
  if (ticket.taskStateDigest !== params.taskStateDigest) {
    throw new Error("Head of PM turn scope or message changed after Owner confirmation.");
  }
  const resolved = resolveProviderAndAccount(params.harnessId, db);
  if (!resolved.ok || resolved.accountId !== ticket.accountId || resolved.providerId !== ticket.providerId) {
    throw new Error("Account binding or provider changed after Owner confirmation.");
  }
  if (normalizePath(params.resolvedWorkspace) !== normalizePath(ticket.workspace)) {
    throw new Error("Head of PM isolated workspace changed after Owner confirmation.");
  }

  ticket.consumed = true;
  activeTickets.delete(ticket.grantId);

  trust.store.database.transaction(() => {
    const used = trust.store.database.query<{ n: number }, [string]>(
      "SELECT COUNT(*) AS n FROM owner_trust_grant_uses WHERE grant_id = ?",
    ).get(ticket.grantId)?.n ?? 0;
    if (used > 0) {
      throw new Error("This Owner launch confirmation was already used. Replays are refused.");
    }
    trust.store.database.run(
      `INSERT INTO owner_trust_grant_uses (id, grant_id, task_id, role, run_id, operation_digest, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [randomUUID(), ticket.grantId, params.taskId, "head-of-pm", params.runId, ticket.operationDigest, nowMs()],
    );
  }).immediate();

  activeSpawns.set(params.runId, {
    grantId: ticket.grantId,
    taskId: params.taskId,
    runId: params.runId,
    role: "head-of-pm",
    harnessId: params.harnessId,
    mode: params.mode,
    workspace: normalizePath(params.resolvedWorkspace),
    allowsLazyWorktree: false,
    projectPath: ticket.projectPath,
    operationDigest: ticket.operationDigest,
    expiresAt: ticket.expiresAt,
  });
}

/** Clears an unconsumed spawn token when spawn preparation fails cleanly before `spawnAgent`. */
export function discardUnconsumedSpawnAuthorization(runId: string): void {
  activeSpawns.delete(runId);
}
