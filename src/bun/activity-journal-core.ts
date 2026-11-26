/**
 * FO-015A.1 Company Activity Journal Core.
 *
 * Append-only structured audit journal for the virtual AI company ForgeOrbit.
 * Records real, confirmed business events across:
 *   - Organization (hiring, archiving, unarchiving, task assignment/unassignment)
 *   - Project Management (task proposals, assignment proposals, approvals, rejections)
 *   - Execution Lifecycle (reviewed, approved, started, completed, failed)
 *   - Multi-Turn Interaction (proposed, approved, submitted, delivery indeterminate)
 *
 * Enforces transactional integrity, post-commit SSE notifications, strict idempotency,
 * append-only durability, event-type-specific allowlist payload schemas, cursor-based
 * pagination, and complete isolation from prompts/credentials.
 */

import type { Database } from "bun:sqlite";
import { createHash, randomUUID } from "node:crypto";
import { capText, redactSecrets } from "../shared/project-interview.ts";
import { broadcastAppEvent } from "./quit-guard.ts";
import {
  ACTIVITY_EVENT_TYPES,
  type ActivityActorType,
  type ActivityEvent,
  type ActivityEventInput,
  type ActivityEventRecord,
  type ActivityEventsResponse,
  type ActivityEventType,
  type ActivityQueryFilter,
  type ActivityTargetType,
} from "../shared/activity/types.ts";

export class ActivityJournalError extends Error {
  constructor(message: string, readonly status = 400) {
    super(message);
    this.name = "ActivityJournalError";
  }
}

export interface ActivityJournalOptions {
  now?: () => number;
  notify?: boolean;
}

export const VALID_ACTOR_TYPES = new Set<ActivityActorType>([
  "owner",
  "project-manager",
  "employee",
  "system",
]);

export const VALID_TARGET_TYPES = new Set<ActivityTargetType>([
  "company",
  "project",
  "employee",
  "task",
  "proposal",
  "execution",
  "turn",
  "browser-session",
  "native-session",
]);

export const VALID_EVENT_TYPES = new Set<ActivityEventType>(ACTIVITY_EVENT_TYPES);

export const PAYLOAD_LIMITS = {
  maxDepth: 3,
  maxObjectKeys: 20,
  maxArrayItems: 20,
  maxStringChars: 500,
  maxArrayStringChars: 200,
  maxPayloadBytes: 4096,
} as const;

type PayloadFieldType = "string" | "number" | "boolean" | "string[]";

const ownerTrustPayload = {
  requestId: "string",
  operationDigest: "string",
  enrollmentId: "string",
  method: "string",
  code: "string",
  scope: "string",
  policyRevision: "string",
  taskId: "string",
  providerId: "string",
  accountId: "string",
} as const;

/**
 * Strict per-event-type payload allowlist schema.
 * Only fields explicitly listed here with matching primitive/string-array types
 * are persisted for each supported `ActivityEventType`.
 */
export const EVENT_PAYLOAD_SCHEMAS: Readonly<
  Record<ActivityEventType, Readonly<Record<string, PayloadFieldType>>>
> = {
  "employee.hired": {
    proposalId: "string",
    employeeId: "string",
    employeeName: "string",
    jobTitle: "string",
    roleCategory: "string",
    catalogRoleSlug: "string",
    projectPath: "string",
  },
  "employee.archived": {
    employeeId: "string",
    employeeName: "string",
    jobTitle: "string",
    projectPath: "string",
  },
  "employee.unarchived": {
    employeeId: "string",
    employeeName: "string",
    jobTitle: "string",
    projectPath: "string",
  },
  "employee.assigned": {
    assignmentId: "string",
    taskId: "string",
    taskTitle: "string",
    employeeId: "string",
    employeeName: "string",
    revision: "number",
    previousEmployeeId: "string",
  },
  "employee.unassigned": {
    assignmentId: "string",
    taskId: "string",
    employeeId: "string",
    revision: "number",
  },
  "task.proposal.created": {
    proposalId: "string",
    title: "string",
    summary: "string",
    itemCount: "number",
    taskTitles: "string[]",
  },
  "task.assignment.proposed": {
    proposalId: "string",
    taskId: "string",
    employeeId: "string",
    employeeName: "string",
    rationale: "string",
    delegationId: "string",
  },
  "task.assignment.approved": {
    proposalId: "string",
    taskId: "string",
    employeeId: "string",
    employeeName: "string",
    assignmentId: "string",
    assignmentRevision: "number",
    note: "string",
  },
  "task.assignment.rejected": {
    proposalId: "string",
    taskId: "string",
    employeeId: "string",
    reason: "string",
  },
  "execution.reviewed": {
    attemptId: "string",
    taskId: "string",
    taskTitle: "string",
    employeeId: "string",
    employeeName: "string",
    harnessId: "string",
    mode: "string",
  },
  "execution.approved": {
    attemptId: "string",
    taskId: "string",
    taskTitle: "string",
    employeeId: "string",
    employeeName: "string",
    executionId: "string",
    harnessId: "string",
    approvedAt: "number",
  },
  "execution.started": {
    attemptId: "string",
    taskId: "string",
    taskTitle: "string",
    employeeId: "string",
    employeeName: "string",
    runId: "string",
    actualHarnessId: "string",
    startedAt: "number",
  },
  "run.completed": {
    attemptId: "string",
    taskId: "string",
    taskTitle: "string",
    employeeId: "string",
    employeeName: "string",
    runId: "string",
    result: "string",
    reason: "string",
    finishedAt: "number",
  },
  "run.failed": {
    attemptId: "string",
    taskId: "string",
    taskTitle: "string",
    employeeId: "string",
    employeeName: "string",
    runId: "string",
    result: "string",
    reason: "string",
    finishedAt: "number",
  },
  "queue.preparation.enabled": {
    queueId: "string",
    proposalId: "string",
    queueRevision: "number",
  },
  "queue.preparation.disabled": {
    queueId: "string",
    proposalId: "string",
    queueRevision: "number",
  },
  "queue.plan.confirmed": {
    queueId: "string",
    proposalId: "string",
    queueRevision: "number",
    planKey: "string",
    taskIds: "string[]",
  },
  "queue.paused": { queueId: "string", proposalId: "string", queueRevision: "number" },
  "queue.resumed": { queueId: "string", proposalId: "string", queueRevision: "number" },
  "queue.stopped": { queueId: "string", proposalId: "string", queueRevision: "number" },
  "queue.handoff.prepared": {
    queueId: "string",
    proposalId: "string",
    queueRevision: "number",
    batchId: "string",
    taskIds: "string[]",
    count: "number",
  },
  "queue.authorization.granted": {
    queueId: "string",
    proposalId: "string",
    batchId: "string",
    taskIds: "string[]",
    maxStarts: "number",
    maxParallel: "number",
    expiresAt: "number",
  },
  "queue.authorization.revoked": {
    queueId: "string",
    proposalId: "string",
    batchId: "string",
    taskIds: "string[]",
    previousStatus: "string",
  },
  "autonomy.grant.approved": {
    grantId: "string",
    batchId: "string",
    taskIds: "string[]",
    maxRuns: "number",
    maxParallelism: "number",
    expiresAt: "number",
    unknownQuotaAcknowledged: "number",
  },
  "autonomy.execution.started": {
    grantId: "string",
    batchId: "string",
    taskIds: "string[]",
    maxRuns: "number",
    expiresAt: "number",
  },
  "autonomy.grant.exhausted": {
    grantId: "string",
    batchId: "string",
    taskIds: "string[]",
    maxRuns: "number",
    runsUsed: "number",
  },
  "autonomy.grant.expired": {
    grantId: "string",
    batchId: "string",
    taskIds: "string[]",
    expiresAt: "number",
    runsUsed: "number",
  },
  "autonomy.grant.revoked": {
    grantId: "string",
    batchId: "string",
    taskIds: "string[]",
    previousStatus: "string",
    runsUsed: "number",
  },
  "autonomy.execution.blocked": {
    grantId: "string",
    batchId: "string",
    taskIds: "string[]",
    code: "string",
    reason: "string",
    origin: "string",
    runsUsed: "number",
  },
  "autonomy.execution.resumed": {
    grantId: "string",
    batchId: "string",
    taskIds: "string[]",
    runsUsed: "number",
    epoch: "number",
  },
  "usage.estimate.saved": { revision: "number", confidence: "string" },
  "usage.pricing.saved": { revision: "number", billing: "string", currency: "string" },
  "usage.adjustment.recorded": { revision: "number", currency: "string", supersedes: "number", label: "string" },
  "autonomy.policy.activated": {
    policyId: "string",
    revision: "number",
    activationId: "string",
    mode: "string",
    digest: "string",
  },
  "autonomy.policy.paused": {
    policyId: "string",
    revision: "number",
    activationId: "string",
    mode: "string",
  },
  "autonomy.policy.resumed": {
    policyId: "string",
    revision: "number",
    activationId: "string",
    mode: "string",
  },
  "autonomy.policy.revoked": {
    policyId: "string",
    revision: "number",
    activationId: "string",
    mode: "string",
  },
  "autonomy.action.authorized": {
    policyId: "string",
    revision: "number",
    activationId: "string",
    action: "string",
    missionId: "string",
  },
  "autonomy.action.denied": {
    policyId: "string",
    revision: "number",
    activationId: "string",
    action: "string",
    missionId: "string",
    reasonCode: "string",
  },
  "autonomy.emergency.stopped": {
    policyId: "string",
    reasonCode: "string",
    outstanding: "number",
  },
  "autonomy.test.observed": {
    policyId: "string",
    revision: "number",
    taskId: "string",
    exitCode: "number",
    command: "string",
  },
  "permission.test.finished": {
    requestId: "string",
    taskId: "string",
    status: "string",
    authority: "string",
    ruleId: "string",
    exitCode: "number",
    commandFingerprint: "string",
  },
  "permission.workspace_development.updated": {
    enabled: "number",
  },
  "handsoff.policy.updated": {
    revision: "number",
    enabled: "number",
    autoApply: "number",
    autoDone: "number",
    widened: "string",
  },
  "autonomy.test.blocked": {
    policyId: "string",
    revision: "number",
    taskId: "string",
    reasonCode: "string",
  },
  "deployment.request.created": {
    requestId: "string",
    clusterId: "string",
    environment: "string",
    revision: "string",
    requestedByRole: "string",
    status: "string",
  },
  "deployment.request.approved": {
    requestId: "string",
    clusterId: "string",
    environment: "string",
    revision: "string",
    approvalDigest: "string",
  },
  "deployment.request.rejected": {
    requestId: "string",
    clusterId: "string",
    environment: "string",
  },
  "deployment.dry_run.completed": {
    requestId: "string",
    outcome: "string",
    simulated: "boolean",
    remoteCommandsExecuted: "number",
  },
  "deployment.execution.authorized": {
    requestId: "string",
    planDigest: "string",
    executionAuthDigest: "string",
    runtimeEnabled: "boolean",
  },
  "deployment.execution.started": {
    requestId: "string",
    attemptId: "string",
    planDigest: "string",
  },
  "deployment.execution.finished": {
    requestId: "string",
    attemptId: "string",
    state: "string",
    exitCode: "number",
  },
  "deployment.execution.reconciliation_required": {
    requestId: "string",
  },
  "qc.recovery.reconciled": {
    taskId: "string",
    grantId: "string",
    developerRunId: "string",
    failedReviewId: "string",
    batchId: "string",
  },
  "qc.recovery.approved": {
    taskId: "string",
    grantId: "string",
    developerRunId: "string",
    reviewerHarness: "string",
    reviewerModel: "string",
    resourceFingerprint: "string",
    maxLaunches: "number",
    expiresAt: "number",
  },
  "qc.recovery.started": {
    taskId: "string",
    grantId: "string",
    developerRunId: "string",
    reviewerHarness: "string",
    reviewerModel: "string",
    resourceFingerprint: "string",
    maxLaunches: "number",
    expiresAt: "number",
  },
  "qc.recovery.cancelled": {
    taskId: "string",
    grantId: "string",
    developerRunId: "string",
    failedReviewId: "string",
    batchId: "string",
  },
  "qc.test.prepared": {
    taskId: "string",
    authorizationId: "string",
    command: "string",
    sourceFingerprint: "string",
    workspacePath: "string",
  },
  "qc.test.approved": {
    taskId: "string",
    authorizationId: "string",
    command: "string",
    sourceFingerprint: "string",
    expiresAt: "number",
  },
  "qc.test.executed": {
    taskId: "string",
    authorizationId: "string",
    command: "string",
    sourceFingerprint: "string",
    exitCode: "number",
  },
  "qc.test.cancelled": {
    taskId: "string",
    authorizationId: "string",
    command: "string",
    sourceFingerprint: "string",
    workspacePath: "string",
  },
  "qc.extension.authorized": {
    taskId: "string",
    baseRound: "number",
    maxRounds: "number",
    previousVerdict: "string",
  },
  "qc.extension.used": {
    taskId: "string",
    reviewId: "string",
    round: "number",
    implementationRunId: "string",
  },
  "project.lifecycle.draining": {
    projectPath: "string",
    previousState: "string",
    activeExecutions: "number",
    reason: "string",
  },
  "project.lifecycle.paused": {
    projectPath: "string",
    previousState: "string",
    activeExecutions: "number",
    reason: "string",
  },
  "project.lifecycle.resumed": {
    projectPath: "string",
    previousState: "string",
    reconciledStartingProposals: "number",
  },
  "project.lifecycle.reconciled": {
    projectPath: "string",
    previousState: "string",
    nextState: "string",
    activeExecutions: "number",
    reason: "string",
  },
  "brain.proposal.created": {
    proposalId: "string",
    title: "string",
    managerKind: "string",
    scopeKind: "string",
    claim: "string",
  },
  "brain.proposal.approved": {
    proposalId: "string",
    memoryId: "string",
    editedByOwner: "boolean",
  },
  "brain.proposal.rejected": {
    proposalId: "string",
    reason: "string",
  },
  "browser.session.created": {
    sessionId: "string",
    ownerId: "string",
  },
  "browser.navigation.requested": {
    sessionId: "string",
    destinationHost: "string",
    destinationOrigin: "string",
  },
  "browser.navigation.accepted": {
    sessionId: "string",
    destinationHost: "string",
    destinationOrigin: "string",
  },
  "browser.navigation.refused": {
    sessionId: "string",
    destinationHost: "string",
    reasonCode: "string",
  },
  "browser.session.closed": {
    sessionId: "string",
    reasonCode: "string",
  },
  "browser.session.failed": {
    sessionId: "string",
    reasonCode: "string",
  },
  "browser.session.interrupted": {
    sessionId: "string",
    reasonCode: "string",
  },
  "browser.agent.granted": {
    grantId: "string",
    sessionId: "string",
    managerKind: "string",
  },
  "browser.agent.revoked": {
    grantId: "string",
    sessionId: "string",
    managerKind: "string",
  },
  "browser.agent.action.accepted": {
    grantId: "string",
    sessionId: "string",
    managerKind: "string",
    actionKind: "string",
  },
  "browser.agent.action.refused": {
    grantId: "string",
    sessionId: "string",
    managerKind: "string",
    actionKind: "string",
    reasonCode: "string",
  },
  "browser.agent.action.interrupted": {
    grantId: "string",
    sessionId: "string",
    managerKind: "string",
    reasonCode: "string",
  },
  "native.session.created": {
    sessionId: "string",
    bundleId: "string",
    pid: "number",
    windowId: "number",
    executableHash: "string",
  },
  "native.target.selected": {
    sessionId: "string",
    bundleId: "string",
    pid: "number",
    windowId: "number",
  },
  "native.observation.requested": {
    sessionId: "string",
    observationId: "string",
  },
  "native.action.approved": {
    sessionId: "string",
    claimId: "string",
    observationId: "string",
    elementId: "string",
    action: "string",
  },
  "native.action.completed": {
    sessionId: "string",
    claimId: "string",
    action: "string",
  },
  "native.action.refused": {
    sessionId: "string",
    claimId: "string",
    action: "string",
    reasonCode: "string",
  },
  "native.action.interrupted": {
    sessionId: "string",
    claimId: "string",
    reasonCode: "string",
  },
  "native.session.closed": {
    sessionId: "string",
    reasonCode: "string",
  },
  "native.session.interrupted": {
    sessionId: "string",
    reasonCode: "string",
  },
  "native.agent.granted": {
    grantId: "string",
    sessionId: "string",
    managerKind: "string",
  },
  "native.agent.revoked": {
    grantId: "string",
    sessionId: "string",
    managerKind: "string",
  },
  "native.agent.action.accepted": {
    grantId: "string",
    sessionId: "string",
    managerKind: "string",
    actionKind: "string",
  },
  "native.agent.action.refused": {
    grantId: "string",
    sessionId: "string",
    managerKind: "string",
    actionKind: "string",
    reasonCode: "string",
  },
  "native.agent.action.interrupted": {
    grantId: "string",
    sessionId: "string",
    managerKind: "string",
    reasonCode: "string",
  },
  "improvement.candidate.proposed": {
    candidateId: "string",
    role: "string",
    scope: "string",
    verdict: "string",
    version: "number",
  },
  "improvement.evaluated": {
    candidateId: "string",
    role: "string",
    scope: "string",
    verdict: "string",
    version: "number",
  },
  "improvement.activated": {
    candidateId: "string",
    role: "string",
    scope: "string",
    verdict: "string",
    version: "number",
  },
  "improvement.rolled_back": {
    candidateId: "string",
    role: "string",
    scope: "string",
    verdict: "string",
    version: "number",
  },
  "turn.proposed": {
    turnId: "string",
    runId: "string",
    taskId: "string",
    employeeId: "string",
    employeeName: "string",
    turnNumber: "number",
    promptSha256: "string",
    promptLength: "number",
    index: "number",
  },
  "turn.approved": {
    turnId: "string",
    runId: "string",
    taskId: "string",
    employeeId: "string",
    turnNumber: "number",
    approvedAt: "number",
  },
  "turn.submitted": {
    turnId: "string",
    runId: "string",
    taskId: "string",
    employeeId: "string",
    turnNumber: "number",
    status: "string",
  },
  "delivery.indeterminate": {
    attemptId: "string",
    turnId: "string",
    runId: "string",
    taskId: "string",
    employeeId: "string",
    turnNumber: "number",
    reason: "string",
    status: "string",
  },
  "owner.trust.enrolled": ownerTrustPayload,
  "owner.trust.approved": ownerTrustPayload,
  "owner.trust.refused": ownerTrustPayload,
  "owner.trust.consumed": ownerTrustPayload,
  "owner.trust.revoked": ownerTrustPayload,
};

const FORBIDDEN_EXACT_KEYS = new Set<string>([
  "prompt",
  "promptmarkdown",
  "adaptedprompt",
  "userprompt",
  "systemprompt",
  "markdown",
  "password",
  "passwd",
  "secret",
  "clientsecret",
  "client_secret",
  "token",
  "accesstoken",
  "access_token",
  "refreshtoken",
  "refresh_token",
  "idtoken",
  "id_token",
  "apikey",
  "api_key",
  "accesskey",
  "access_key",
  "privatekey",
  "private_key",
  "authorization",
  "auth",
  "credential",
  "credentials",
  "keychain",
  "cookie",
  "sessionkey",
  "session_key",
  "bearer",
  "stdout",
  "stderr",
  "stack",
  "stacktrace",
  "rawoutput",
  "raw_output",
  "clioutput",
  "cli_output",
  "env",
  "message",
  "content",
  "metadata",
  "description",
  "error",
]);

const FORBIDDEN_SUBSTRING_PATTERN =
  /(prompt|markdown|password|passwd|secret|token|apikey|api_key|access_key|private_key|credential|keychain|stdout|stderr|stacktrace)/i;

function isForbiddenKey(key: string): boolean {
  if (key === "promptSha256" || key === "promptLength") {
    return false;
  }
  const lower = key.toLowerCase();
  return FORBIDDEN_EXACT_KEYS.has(lower) || FORBIDDEN_SUBSTRING_PATTERN.test(lower);
}

function sha256(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

/**
 * Redacts embedded credentials, bearer tokens, JWTs, connection strings,
 * private keys, and multi-line stack traces from a string value, then caps length.
 */
export function sanitizeStringValue(raw: string, maxChars: number = PAYLOAD_LIMITS.maxStringChars): string {
  // Strip stack trace frames
  let cleaned = raw.replace(/\r\n?/g, "\n").replace(/\n\s+at\s+[^\n]+/g, "");
  // Apply shared credential redactor (PEM private keys, sk-*, ghp_*, github_pat_*, AKIA*, xox*, AIza*, glpat-*, line key=value)
  cleaned = redactSecrets(cleaned);
  // Redact inline Bearer / Basic tokens, JWTs, URL user:pass, and inline key=value secret pairs
  cleaned = cleaned
    .replace(/\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]{6,}/gi, "$1 [redacted]")
    .replace(/\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g, "[redacted]")
    .replace(/\b([a-z][a-z0-9+.-]*:\/\/[^:\s/]+:)[^@\s/]+(@)/gi, "$1[redacted]$2")
    .replace(
      /\b(api[_-]?key|access[_-]?token|refresh[_-]?token|private[_-]?key|client[_-]?secret|password|passwd|secret|token|authorization|credential)\s*([:=])\s*["']?[A-Za-z0-9._~+/=-]{4,}["']?/gi,
      "$1$2[redacted]",
    );
  if (cleaned.length > maxChars) {
    return capText(cleaned, maxChars) + "…";
  }
  return cleaned;
}

function enforcePayloadByteCap(obj: Record<string, unknown>): Record<string, unknown> {
  if (Buffer.byteLength(JSON.stringify(obj), "utf8") <= PAYLOAD_LIMITS.maxPayloadBytes) {
    return obj;
  }
  const trimmed: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(obj)) {
    trimmed[k] = v;
    if (Buffer.byteLength(JSON.stringify(trimmed), "utf8") > PAYLOAD_LIMITS.maxPayloadBytes) {
      delete trimmed[k];
      break;
    }
  }
  return trimmed;
}

/**
 * Sanitizes payload objects according to:
 * 1. Event-type-specific allowlist schema when `eventType` is provided.
 * 2. Strict key denylist (`FORBIDDEN_EXACT_KEYS` & `FORBIDDEN_SUBSTRING_PATTERN`) at all depths.
 * 3. String-level secret redaction, stack-trace stripping, and character length caps.
 * 4. Recursion depth bound (`PAYLOAD_LIMITS.maxDepth`), array length bound (`PAYLOAD_LIMITS.maxArrayItems`),
 *    object key bound (`PAYLOAD_LIMITS.maxObjectKeys`), and total serialized byte bound (`PAYLOAD_LIMITS.maxPayloadBytes`).
 */
export function sanitizePayload(
  input: unknown,
  eventTypeOrSeen?: ActivityEventType | string | WeakSet<object>,
  seenArg?: WeakSet<object>,
  depth = 0,
): Record<string, unknown> {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    return {};
  }
  if (depth >= PAYLOAD_LIMITS.maxDepth) {
    return {};
  }

  const eventType = typeof eventTypeOrSeen === "string" ? eventTypeOrSeen : undefined;
  const seen =
    eventTypeOrSeen instanceof WeakSet
      ? eventTypeOrSeen
      : seenArg instanceof WeakSet
        ? seenArg
        : new WeakSet<object>();

  if (seen.has(input)) {
    return {};
  }
  seen.add(input);

  // If an eventType is specified, enforce its strict allowlist schema
  if (eventType !== undefined) {
    if (!VALID_EVENT_TYPES.has(eventType as ActivityEventType)) {
      return {};
    }
    const schema = EVENT_PAYLOAD_SCHEMAS[eventType as ActivityEventType];
    const result: Record<string, unknown> = {};
    let keptKeys = 0;

    for (const [key, value] of Object.entries(input as Record<string, unknown>)) {
      if (keptKeys >= PAYLOAD_LIMITS.maxObjectKeys) {
        break;
      }
      if (value === undefined || value === null) {
        continue;
      }
      if (key.toLowerCase() === "prompt" && typeof value === "string" && "promptSha256" in schema) {
        result.promptSha256 = sha256(value);
        result.promptLength = value.length;
        keptKeys += 2;
        continue;
      }
      if (isForbiddenKey(key)) {
        continue;
      }
      const expectedType = schema[key];
      if (!expectedType) {
        continue;
      }
      if (expectedType === "string" && typeof value === "string") {
        result[key] = sanitizeStringValue(value, PAYLOAD_LIMITS.maxStringChars);
        keptKeys += 1;
      } else if (expectedType === "number" && typeof value === "number" && Number.isFinite(value)) {
        result[key] = value;
        keptKeys += 1;
      } else if (expectedType === "boolean" && typeof value === "boolean") {
        result[key] = value;
        keptKeys += 1;
      } else if (expectedType === "string[]" && Array.isArray(value)) {
        result[key] = value
          .filter((item): item is string => typeof item === "string")
          .slice(0, PAYLOAD_LIMITS.maxArrayItems)
          .map((item) => sanitizeStringValue(item, PAYLOAD_LIMITS.maxArrayStringChars));
        keptKeys += 1;
      }
    }
    return enforcePayloadByteCap(result);
  }

  // Standalone structural sanitization (when called without eventType)
  const result: Record<string, unknown> = {};
  let keptKeys = 0;

  for (const [key, value] of Object.entries(input as Record<string, unknown>)) {
    if (keptKeys >= PAYLOAD_LIMITS.maxObjectKeys) {
      break;
    }
    if (value === undefined || value === null) {
      continue;
    }
    const lowerKey = key.toLowerCase();

    // If a raw `prompt` key is passed at top level, store only its SHA-256 digest and length
    if (lowerKey === "prompt" && typeof value === "string" && depth === 0) {
      result.promptSha256 = sha256(value);
      result.promptLength = value.length;
      keptKeys += 2;
      continue;
    }

    if (isForbiddenKey(key)) {
      continue;
    }

    if (typeof value === "string") {
      result[key] = sanitizeStringValue(value, PAYLOAD_LIMITS.maxStringChars);
      keptKeys += 1;
    } else if (typeof value === "number") {
      if (Number.isFinite(value)) {
        result[key] = value;
        keptKeys += 1;
      }
    } else if (typeof value === "boolean") {
      result[key] = value;
      keptKeys += 1;
    } else if (Array.isArray(value)) {
      if (depth + 1 >= PAYLOAD_LIMITS.maxDepth) {
        continue;
      }
      result[key] = value.slice(0, PAYLOAD_LIMITS.maxArrayItems).map((item) => {
        if (typeof item === "string") return sanitizeStringValue(item, PAYLOAD_LIMITS.maxArrayStringChars);
        if (typeof item === "number" && Number.isFinite(item)) return item;
        if (typeof item === "boolean") return item;
        if (typeof item === "object" && item !== null && !Array.isArray(item)) {
          return sanitizePayload(item, undefined, seen, depth + 1);
        }
        return null;
      });
      keptKeys += 1;
    } else if (typeof value === "object") {
      if (depth + 1 >= PAYLOAD_LIMITS.maxDepth) {
        continue;
      }
      result[key] = sanitizePayload(value, undefined, seen, depth + 1);
      keptKeys += 1;
    }
  }
  return depth === 0 ? enforcePayloadByteCap(result) : result;
}

/**
 * Post-commit SSE notification state per SQLite Database connection.
 * Events recorded while a transaction is active are held until the outermost
 * transaction commits (`!db.inTransaction`) and verified against committed
 * SQLite storage before broadcasting. Rolled-back events are discarded.
 */
interface PendingNotification {
  event: ActivityEvent;
  retries: number;
}

const pendingNotificationsByDb = new WeakMap<Database, Map<string, PendingNotification>>();
const scheduledFlushByDb = new WeakMap<Database, boolean>();
const dispatchedEventIdsByDb = new WeakMap<Database, Set<string>>();

function getPendingMap(db: Database): Map<string, PendingNotification> {
  let map = pendingNotificationsByDb.get(db);
  if (!map) {
    map = new Map();
    pendingNotificationsByDb.set(db, map);
  }
  return map;
}

function getDispatchedSet(db: Database): Set<string> {
  let set = dispatchedEventIdsByDb.get(db);
  if (!set) {
    set = new Set();
    dispatchedEventIdsByDb.set(db, set);
  }
  return set;
}

function schedulePostCommitFlush(db: Database): void {
  if (scheduledFlushByDb.get(db)) {
    return;
  }
  scheduledFlushByDb.set(db, true);
  queueMicrotask(() => {
    scheduledFlushByDb.set(db, false);
    ActivityJournalCore.flushNotifications(db);
  });
}

export class ActivityJournalCore {
  private readonly now: () => number;
  private readonly notifyEnabled: boolean;

  constructor(private readonly db: Database, options: ActivityJournalOptions = {}) {
    this.now = options.now ?? (() => Date.now());
    this.notifyEnabled = options.notify ?? true;
  }

  /**
   * Flushes pending SSE notifications for `db` only after the outermost transaction
   * has committed (`!db.inTransaction`) and only for rows confirmed present in
   * committed SQLite storage. Any event whose transaction or savepoint rolled back
   * is discarded without emitting an SSE notification.
   */
  public static flushNotifications(db: Database): number {
    const pending = pendingNotificationsByDb.get(db);
    if (!pending || pending.size === 0) {
      return 0;
    }

    try {
      if (db.inTransaction) {
        // Outer transaction is still open; defer until after commit.
        for (const [id, item] of pending.entries()) {
          if (item.retries >= 20) {
            pending.delete(id);
          } else {
            item.retries += 1;
          }
        }
        if (pending.size > 0) {
          schedulePostCommitFlush(db);
        }
        return 0;
      }
    } catch {
      // Database handle was closed before flush could inspect it.
      pending.clear();
      return 0;
    }

    const dispatched = getDispatchedSet(db);
    const snapshot = Array.from(pending.values());
    pending.clear();
    let sent = 0;

    for (const { event } of snapshot) {
      if (dispatched.has(event.id)) {
        continue;
      }
      let committedRow: { sequence_id: number } | null = null;
      try {
        if (db.inTransaction) {
          // A new transaction started concurrently; re-queue for next flush.
          pending.set(event.id, { event, retries: 0 });
          continue;
        }
        committedRow = db
          .query<{ sequence_id: number }, [string, number, string]>(
            `SELECT sequence_id FROM activity_events WHERE id = ? AND sequence_id = ? AND idempotency_key = ? LIMIT 1`,
          )
          .get(event.id, event.sequenceId, event.idempotencyKey);
      } catch {
        // DB closed or unreadable; do not emit unverified notification.
        continue;
      }

      if (!committedRow) {
        // Row was rolled back (outer transaction or savepoint aborted). Never broadcast.
        continue;
      }

      dispatched.add(event.id);
      try {
        broadcastAppEvent({
          type: "activity_event",
          eventId: event.id,
          eventType: event.eventType,
          projectPath: event.projectPath,
          actorType: event.actorType,
          actorId: event.actorId,
          targetType: event.targetType,
          targetId: event.targetId,
          sequenceId: event.sequenceId,
          ts: event.createdAt,
        });
        sent += 1;
      } catch {
        // Swallow notification errors — listener failure must never affect persistence
      }
    }

    if (pending.size > 0) {
      schedulePostCommitFlush(db);
    }
    return sent;
  }

  public flushNotifications(): number {
    return ActivityJournalCore.flushNotifications(this.db);
  }

  /**
   * Record a confirmed activity event.
   * If an event with the given idempotency_key already exists, returns the existing
   * event with { created: false } to guarantee idempotency.
   */
  public record(input: ActivityEventInput, options?: { notify?: boolean }): { event: ActivityEvent; created: boolean } {
    if (
      !input.eventType ||
      typeof input.eventType !== "string" ||
      !VALID_EVENT_TYPES.has(input.eventType as ActivityEventType)
    ) {
      throw new ActivityJournalError(`Unsupported or invalid eventType: ${String(input.eventType)}`, 400);
    }
    if (!input.actorType || !VALID_ACTOR_TYPES.has(input.actorType)) {
      throw new ActivityJournalError(`Invalid actorType: ${input.actorType}`, 400);
    }
    if (!input.targetType || !VALID_TARGET_TYPES.has(input.targetType)) {
      throw new ActivityJournalError(`Invalid targetType: ${input.targetType}`, 400);
    }
    if (!input.targetId || typeof input.targetId !== "string" || !input.targetId.trim() || input.targetId.length > 120) {
      throw new ActivityJournalError("Invalid targetId.", 400);
    }

    const idempotencyKey = input.idempotencyKey?.trim() || randomUUID();

    // Check existing by idempotency_key
    const existing = this.db
      .query<ActivityEventRecord, [string]>(`SELECT * FROM activity_events WHERE idempotency_key = ? LIMIT 1`)
      .get(idempotencyKey);

    if (existing) {
      return { event: this.mapRow(existing), created: false };
    }

    const id = input.id?.trim() || randomUUID();
    const schemaVersion = input.schemaVersion && input.schemaVersion >= 1 ? input.schemaVersion : 1;
    const projectPath = input.projectPath ?? null;
    const actorId = input.actorId ?? null;
    const taskId = input.taskId ?? null;
    const runId = input.runId ?? null;
    const executionId = input.executionId ?? null;
    const turnId = input.turnId ?? null;
    const employeeId = input.employeeId ?? null;
    const sourceEventId = input.sourceEventId ?? null;
    const createdAt = input.createdAt ?? this.now();
    const sanitized = sanitizePayload(input.payload ?? {}, input.eventType);
    const payloadJson = JSON.stringify(sanitized);

    try {
      this.db.run(
        `INSERT INTO activity_events (
          id, event_type, schema_version, project_path, actor_type, actor_id,
          target_type, target_id, task_id, run_id, execution_id, turn_id,
          employee_id, idempotency_key, source_event_id, payload_json, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          id,
          input.eventType,
          schemaVersion,
          projectPath,
          input.actorType,
          actorId,
          input.targetType,
          input.targetId,
          taskId,
          runId,
          executionId,
          turnId,
          employeeId,
          idempotencyKey,
          sourceEventId,
          payloadJson,
          createdAt,
        ],
      );
    } catch (error) {
      // Handle concurrent idempotent insert race cleanly
      const concurrent = this.db
        .query<ActivityEventRecord, [string]>(`SELECT * FROM activity_events WHERE idempotency_key = ? LIMIT 1`)
        .get(idempotencyKey);
      if (concurrent && (!input.id || concurrent.id === input.id.trim())) {
        return { event: this.mapRow(concurrent), created: false };
      }
      throw error;
    }

    const inserted = this.db
      .query<ActivityEventRecord, [string]>(`SELECT * FROM activity_events WHERE id = ? LIMIT 1`)
      .get(id);

    if (!inserted) {
      throw new ActivityJournalError("Failed to retrieve inserted activity event.", 500);
    }

    const event = this.mapRow(inserted);

    // Queue post-commit notification if enabled
    const notify = options?.notify ?? this.notifyEnabled;
    if (notify) {
      const pending = getPendingMap(this.db);
      pending.set(event.id, { event, retries: 0 });
      schedulePostCommitFlush(this.db);
    }

    return { event, created: true };
  }

  /**
   * Get an activity event by either its UUID or sequence_id.
   */
  public get(idOrSequence: string | number): ActivityEvent | null {
    if (typeof idOrSequence === "number" || /^\d+$/.test(String(idOrSequence))) {
      const seq = typeof idOrSequence === "number" ? idOrSequence : parseInt(idOrSequence, 10);
      const row = this.db
        .query<ActivityEventRecord, [number, string]>(
          `SELECT * FROM activity_events WHERE sequence_id = ? OR id = ? LIMIT 1`,
        )
        .get(seq, String(idOrSequence));
      return row ? this.mapRow(row) : null;
    }

    const row = this.db
      .query<ActivityEventRecord, [string]>(`SELECT * FROM activity_events WHERE id = ? LIMIT 1`)
      .get(String(idOrSequence));
    return row ? this.mapRow(row) : null;
  }

  /**
   * List activity events with strict filter validation and cursor-based pagination.
   */
  public list(filter: ActivityQueryFilter = {}): ActivityEventsResponse {
    let limit = 50;
    if (filter.limit !== undefined) {
      if (
        typeof filter.limit !== "number" ||
        !Number.isSafeInteger(filter.limit) ||
        filter.limit < 1 ||
        filter.limit > 100
      ) {
        throw new ActivityJournalError("Invalid limit: must be an integer between 1 and 100.", 400);
      }
      limit = filter.limit;
    }

    if (
      filter.direction !== undefined &&
      filter.direction !== "forward" &&
      filter.direction !== "backward"
    ) {
      throw new ActivityJournalError("Invalid direction: must be 'forward' or 'backward'.", 400);
    }
    const direction = filter.direction === "forward" ? "forward" : "backward";

    const conditions: string[] = [];
    const params: (string | number)[] = [];

    if (filter.projectPath !== undefined) {
      if (typeof filter.projectPath !== "string" || !filter.projectPath.trim()) {
        throw new ActivityJournalError("Invalid projectPath.", 400);
      }
      conditions.push("project_path = ?");
      params.push(filter.projectPath);
    }

    if (filter.actorType !== undefined) {
      if (!VALID_ACTOR_TYPES.has(filter.actorType)) {
        throw new ActivityJournalError(`Invalid actorType: ${String(filter.actorType)}`, 400);
      }
      conditions.push("actor_type = ?");
      params.push(filter.actorType);
    }

    if (filter.actorId !== undefined) {
      if (typeof filter.actorId !== "string" || !filter.actorId.trim()) {
        throw new ActivityJournalError("Invalid actorId.", 400);
      }
      conditions.push("actor_id = ?");
      params.push(filter.actorId);
    }

    if (filter.employeeId !== undefined) {
      if (typeof filter.employeeId !== "string" || !filter.employeeId.trim()) {
        throw new ActivityJournalError("Invalid employeeId.", 400);
      }
      conditions.push(
        "(employee_id = ? OR (actor_type = 'employee' AND actor_id = ?) OR (target_type = 'employee' AND target_id = ?))",
      );
      params.push(filter.employeeId, filter.employeeId, filter.employeeId);
    }

    if (filter.targetType !== undefined) {
      if (!VALID_TARGET_TYPES.has(filter.targetType)) {
        throw new ActivityJournalError(`Invalid targetType: ${String(filter.targetType)}`, 400);
      }
      conditions.push("target_type = ?");
      params.push(filter.targetType);
    }

    if (filter.targetId !== undefined) {
      if (typeof filter.targetId !== "string" || !filter.targetId.trim()) {
        throw new ActivityJournalError("Invalid targetId.", 400);
      }
      conditions.push("target_id = ?");
      params.push(filter.targetId);
    }

    if (filter.taskId !== undefined) {
      if (typeof filter.taskId !== "string" || !filter.taskId.trim()) {
        throw new ActivityJournalError("Invalid taskId.", 400);
      }
      conditions.push("task_id = ?");
      params.push(filter.taskId);
    }

    if (filter.runId !== undefined) {
      if (typeof filter.runId !== "string" || !filter.runId.trim()) {
        throw new ActivityJournalError("Invalid runId.", 400);
      }
      conditions.push("run_id = ?");
      params.push(filter.runId);
    }

    if (filter.eventType !== undefined) {
      const rawTypes = Array.isArray(filter.eventType)
        ? filter.eventType
        : typeof filter.eventType === "string"
          ? filter.eventType.split(",").map((s) => s.trim()).filter(Boolean)
          : [];
      if (rawTypes.length === 0) {
        throw new ActivityJournalError("Invalid eventType filter.", 400);
      }
      for (const t of rawTypes) {
        if (!VALID_EVENT_TYPES.has(t as ActivityEventType)) {
          throw new ActivityJournalError(`Unsupported eventType filter: ${t}`, 400);
        }
      }
      if (rawTypes.length === 1) {
        conditions.push("event_type = ?");
        params.push(rawTypes[0]!);
      } else {
        const placeholders = rawTypes.map(() => "?").join(", ");
        conditions.push(`event_type IN (${placeholders})`);
        params.push(...rawTypes);
      }
    }

    if (filter.since !== undefined && (!Number.isSafeInteger(filter.since) || filter.since < 0)) {
      throw new ActivityJournalError("Invalid 'since' timestamp: must be a non-negative integer.", 400);
    }
    if (filter.from !== undefined && (!Number.isSafeInteger(filter.from) || filter.from < 0)) {
      throw new ActivityJournalError("Invalid 'from' timestamp: must be a non-negative integer.", 400);
    }
    if (filter.since !== undefined && filter.from !== undefined && filter.since !== filter.from) {
      throw new ActivityJournalError("Conflicting 'since' and 'from' query parameters.", 400);
    }

    if (filter.until !== undefined && (!Number.isSafeInteger(filter.until) || filter.until < 0)) {
      throw new ActivityJournalError("Invalid 'until' timestamp: must be a non-negative integer.", 400);
    }
    if (filter.to !== undefined && (!Number.isSafeInteger(filter.to) || filter.to < 0)) {
      throw new ActivityJournalError("Invalid 'to' timestamp: must be a non-negative integer.", 400);
    }
    if (filter.until !== undefined && filter.to !== undefined && filter.until !== filter.to) {
      throw new ActivityJournalError("Conflicting 'until' and 'to' query parameters.", 400);
    }

    const effectiveSince = filter.since ?? filter.from;
    const effectiveUntil = filter.until ?? filter.to;

    if (
      effectiveSince !== undefined &&
      effectiveUntil !== undefined &&
      effectiveSince > effectiveUntil
    ) {
      throw new ActivityJournalError("Invalid time range: start timestamp must be <= end timestamp.", 400);
    }

    if (effectiveSince !== undefined) {
      conditions.push("created_at >= ?");
      params.push(effectiveSince);
    }

    if (effectiveUntil !== undefined) {
      conditions.push("created_at <= ?");
      params.push(effectiveUntil);
    }

    if (filter.cursor !== undefined && filter.cursor !== null) {
      let cursorSeq: number;
      if (typeof filter.cursor === "number") {
        if (!Number.isSafeInteger(filter.cursor) || filter.cursor <= 0) {
          throw new ActivityJournalError("Invalid cursor: must be a positive integer sequenceId.", 400);
        }
        cursorSeq = filter.cursor;
      } else if (typeof filter.cursor === "string") {
        if (!/^[1-9]\d*$/.test(filter.cursor)) {
          throw new ActivityJournalError("Invalid cursor: must be a positive integer sequenceId.", 400);
        }
        cursorSeq = Number(filter.cursor);
        if (!Number.isSafeInteger(cursorSeq) || cursorSeq <= 0) {
          throw new ActivityJournalError("Invalid cursor: must be a positive integer sequenceId.", 400);
        }
      } else {
        throw new ActivityJournalError("Invalid cursor.", 400);
      }

      if (direction === "backward") {
        conditions.push("sequence_id < ?");
        params.push(cursorSeq);
      } else {
        conditions.push("sequence_id > ?");
        params.push(cursorSeq);
      }
    }

    const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";
    const orderClause = direction === "backward" ? "ORDER BY sequence_id DESC" : "ORDER BY sequence_id ASC";

    // Fetch limit + 1 to reliably determine hasMore without a separate COUNT query
    const sql = `SELECT * FROM activity_events ${whereClause} ${orderClause} LIMIT ?`;
    params.push(limit + 1);

    const rows = this.db.query<ActivityEventRecord, typeof params>(sql).all(...params);

    const hasMore = rows.length > limit;
    const resultRows = hasMore ? rows.slice(0, limit) : rows;
    const events = resultRows.map((r) => this.mapRow(r));
    const nextCursor = hasMore && resultRows.length > 0 ? String(resultRows[resultRows.length - 1]!.sequence_id) : null;

    return {
      events,
      nextCursor,
      hasMore,
    };
  }

  /**
   * Count total events matching filter.
   */
  public count(filter: ActivityQueryFilter = {}): number {
    const conditions: string[] = [];
    const params: (string | number)[] = [];

    if (filter.projectPath) {
      conditions.push("project_path = ?");
      params.push(filter.projectPath);
    }
    if (filter.actorType) {
      conditions.push("actor_type = ?");
      params.push(filter.actorType);
    }
    if (filter.employeeId) {
      conditions.push(
        "(employee_id = ? OR (actor_type = 'employee' AND actor_id = ?) OR (target_type = 'employee' AND target_id = ?))",
      );
      params.push(filter.employeeId, filter.employeeId, filter.employeeId);
    }
    if (filter.eventType) {
      conditions.push("event_type = ?");
      params.push(String(filter.eventType));
    }

    const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";
    const row = this.db
      .query<{ count: number }, typeof params>(`SELECT COUNT(*) as count FROM activity_events ${whereClause}`)
      .get(...params);
    return row?.count ?? 0;
  }

  private mapRow(row: ActivityEventRecord): ActivityEvent {
    let payload: Record<string, unknown> = {};
    try {
      payload = JSON.parse(row.payload_json);
    } catch {
      payload = {};
    }

    return {
      sequenceId: row.sequence_id,
      id: row.id,
      eventType: row.event_type,
      schemaVersion: row.schema_version,
      projectPath: row.project_path,
      actorType: row.actor_type,
      actorId: row.actor_id,
      targetType: row.target_type,
      targetId: row.target_id,
      taskId: row.task_id,
      runId: row.run_id,
      executionId: row.execution_id,
      turnId: row.turn_id,
      employeeId: row.employee_id,
      idempotencyKey: row.idempotency_key,
      sourceEventId: row.source_event_id,
      payload,
      createdAt: row.created_at,
    };
  }
}
