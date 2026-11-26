/**
 * FO-AUTO03-RECOVERY-FIX01 — in-campaign provider quota recovery for gated batches.
 */
import { randomUUID } from "node:crypto";
import { db, runs, taskQualityReviews, tasks } from "./db.ts";
import { ActivityJournalCore } from "./activity-journal-core.ts";
import { buildImplementationEvidence } from "./implementation-evidence.ts";
import { publicationAlignmentForRun } from "./task-workspace.ts";
import { getWorkflowForTask } from "./pm-orchestrated-workflow.ts";
import {
  clampProviderRecoveryMinutes,
  isPreparationFailureText,
  ordinaryLaunchesRemaining,
  supplementalLaunchesRemaining,
  trustedCodexQuotaProof,
  type CodexQuotaProofDetail,
  type PrelaunchClaimClassification,
  type ProviderRecoveryAuthorization,
  type ProviderRecoveryPreview,
  type ProviderRecoveryStatus,
  PROVIDER_RECOVERY_LIMITS,
} from "../shared/pm-provider-recovery.ts";
import { isGatedPolicy } from "../shared/queue-gates.ts";
import { QUEUE_POLICY_SCHEMA_V1, type OrchestratedBatchRecord, type QueuePhaseGrant } from "../shared/pm-orchestrated-batch.ts";
import { isTaskRunLive, moveTaskColumn } from "./orchestrator.ts";
import type { TaskQcReview } from "../shared/types.ts";
import type { ReviewEvidenceBundle } from "../shared/review-evidence.ts";

export class ProviderRecoveryError extends Error {
  constructor(message: string, readonly status = 400, readonly code = "invalid") {
    super(message);
    this.name = "ProviderRecoveryError";
  }
}

interface RecoveryRow {
  id: string;
  batch_id: string;
  task_id: string;
  project_path: string;
  status: string;
  recovery_json: string;
  created_at: number;
  updated_at: number;
}

function parseAuth(raw: string): ProviderRecoveryAuthorization | null {
  try {
    const auth = JSON.parse(raw) as ProviderRecoveryAuthorization;
    if (!auth?.id || auth.supplementalMaxLaunches !== 1) return null;
    return auth;
  } catch {
    return null;
  }
}

function rowAuth(row: RecoveryRow): ProviderRecoveryAuthorization | null {
  const auth = parseAuth(row.recovery_json);
  if (!auth) return null;
  auth.status = row.status as ProviderRecoveryStatus;
  return auth;
}

function loadAuth(id: string): ProviderRecoveryAuthorization | null {
  const row = db.query<RecoveryRow, [string]>(`SELECT * FROM pm_provider_recoveries WHERE id = ?`).get(id);
  return row ? rowAuth(row) : null;
}

function loadAuthForFailedRun(failedReviewerRunId: string): ProviderRecoveryAuthorization | null {
  const row = db.query<RecoveryRow, [string]>(
    `SELECT * FROM pm_provider_recoveries
     WHERE json_extract(recovery_json, '$.failedReviewerRunId') = ?
     ORDER BY created_at DESC LIMIT 1`,
  ).get(failedReviewerRunId);
  return row ? rowAuth(row) : null;
}

export function activeProviderRecoveryForTask(taskId: string, now = Date.now()): ProviderRecoveryAuthorization | null {
  const row = db.query<RecoveryRow, [string]>(
    `SELECT * FROM pm_provider_recoveries
     WHERE task_id = ? AND status IN ('approved', 'applied')
     ORDER BY created_at DESC LIMIT 1`,
  ).get(taskId);
  const auth = row ? rowAuth(row) : null;
  if (!auth) return null;
  if (auth.expiresAt <= now) return null;
  return auth;
}

function parseBatch(raw: string | null): OrchestratedBatchRecord | null {
  if (!raw) return null;
  try {
    return JSON.parse(raw) as OrchestratedBatchRecord;
  } catch {
    return null;
  }
}

function saveBatch(record: OrchestratedBatchRecord): void {
  db.run(
    `UPDATE pm_orchestrated_batches SET status = ?, data_json = ?, updated_at = ? WHERE id = ?`,
    [record.status, JSON.stringify(record), Date.now(), record.id],
  );
}

function loadBatch(projectPath: string, batchId: string): OrchestratedBatchRecord | null {
  const row = db.query<{ data_json: string; status: string }, [string, string]>(
    `SELECT data_json, status FROM pm_orchestrated_batches WHERE id = ? AND project_path = ?`,
  ).get(batchId, projectPath);
  if (!row) return null;
  const record = parseBatch(row.data_json);
  if (record) record.status = row.status as OrchestratedBatchRecord["status"];
  return record;
}

function failedQuotaReview(taskId: string): {
  review: TaskQcReview;
  runId: string;
  proof: CodexQuotaProofDetail;
} | null {
  const reviews = taskQualityReviews.listForTask(taskId);
  const review = [...reviews].reverse().find((item) => item.status === "complete" && item.verdict == null && item.reviewRunId);
  if (!review?.reviewRunId) return null;
  const run = runs.get(review.reviewRunId);
  if (!run) return null;
  const proof = trustedCodexQuotaProof(run, runs.events(review.reviewRunId));
  if (!proof) return null;
  return { review, runId: review.reviewRunId, proof: proof.detail };
}

function reviewerPhaseGrant(
  record: OrchestratedBatchRecord,
  taskId: string,
  implementationRunId: string,
  reviewRunId: string,
): QueuePhaseGrant | null {
  const grants = record.phaseGrants ?? [];
  return grants.find((item) =>
    item.taskId === taskId
    && item.phase === "reviewer"
    && item.implementationRunId === implementationRunId
    && item.status === "consumed"
    && item.consumedRunId === reviewRunId,
  ) ?? grants.find((item) =>
    item.taskId === taskId
    && item.phase === "reviewer"
    && item.implementationRunId === implementationRunId
    && item.status === "consumed",
  ) ?? null;
}

async function currentEvidenceBundle(taskId: string, developerRunId: string, projectPath: string): Promise<ReviewEvidenceBundle | null> {
  const task = tasks.get(taskId);
  const developer = runs.get(developerRunId);
  if (!task || !developer?.endedAt) return null;
  const pub = publicationAlignmentForRun(developerRunId);
  if (pub.blocker) return null;
  try {
    return await buildImplementationEvidence({
      task,
      requirements: task.prompt,
      developerRunId,
      developerEndedAt: developer.endedAt,
      projectPath,
      resourceFingerprint: null,
    });
  } catch {
    return null;
  }
}

function audit(auth: ProviderRecoveryAuthorization, event: string, detail?: string): void {
  auth.audit.push({ event, at: Date.now(), ...(detail ? { detail } : {}) });
}

function persistAuth(auth: ProviderRecoveryAuthorization): ProviderRecoveryAuthorization {
  auth.updatedAt = Date.now();
  db.run(
    `INSERT INTO pm_provider_recoveries (id, batch_id, task_id, project_path, status, recovery_json, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET status = excluded.status, recovery_json = excluded.recovery_json, updated_at = excluded.updated_at`,
    [auth.id, auth.batchId, auth.taskId, auth.projectPath, auth.status, JSON.stringify(auth), auth.createdAt, auth.updatedAt],
  );
  return auth;
}

export async function assessProviderRecovery(projectPath: string, batchId: string, taskId: string): Promise<ProviderRecoveryPreview> {
  const blockers: string[] = [];
  const record = loadBatch(projectPath, batchId);
  if (!record) throw new ProviderRecoveryError("Batch not found.", 404, "not-found");
  if (!isGatedPolicy(record.policy) || record.policy?.queuePolicySchemaVersion !== QUEUE_POLICY_SCHEMA_V1) {
    blockers.push("Recovery is only supported for gated batches using the current safe policy schema.");
  }
  const task = tasks.get(taskId);
  if (!task) throw new ProviderRecoveryError("Task not found.", 404, "not-found");
  const wf = getWorkflowForTask(taskId);
  if (!wf || wf.grant.orchestratedBatchId !== batchId) blockers.push("This task is not part of that batch grant.");
  if (record.policy?.expiresAt != null && Date.now() >= record.policy.expiresAt) {
    blockers.push("The batch grant has expired. Recovery does not extend it.");
  }
  if (record.status !== "paused") blockers.push("The batch must be paused due to the provider failure.");
  if (task.column !== "blocked") blockers.push("The task must be blocked due to that failure.");
  if (isTaskRunLive(taskId)) blockers.push("A run is still live for this task.");
  if (task.qcState?.latestVerdict) blockers.push("A QC verdict already exists for this task.");
  const failed = failedQuotaReview(taskId);
  if (!failed) blockers.push("No finished Reviewer run with a confirmed Codex usage-limit failure was found.");
  const implId = failed?.review.implementationRunId ?? wf?.progress.completedImplementationRunIds.at(-1) ?? null;
  const impl = implId ? runs.get(implId) : null;
  if (!impl || impl.status !== "succeeded") blockers.push("The successful Developer run is missing.");
  let phaseGrantId: string | null = null;
  if (failed && implId) {
    const grant = reviewerPhaseGrant(record, taskId, implId, failed.runId);
    if (!grant) blockers.push("The consumed Reviewer phase grant for this attempt was not found.");
    else phaseGrantId = grant.id;
  }
  if (wf && failed && ordinaryLaunchesRemaining(wf.grant, wf.counters) > 0) {
    blockers.push("Recovery is only for an exhausted frozen launch budget.");
  }
  if (wf && wf.status !== "paused") blockers.push("The orchestrated workflow must be paused from the provider failure.");
  const existing = failed ? loadAuthForFailedRun(failed.runId) : null;
  if (existing && existing.status === "consumed") blockers.push("The supplemental recovery allowance is already consumed.");
  if (existing && (existing.status === "approved" || existing.status === "applied") && existing.supplementalLaunchesConsumed > 0) {
    blockers.push("A supplemental recovery allowance was already used for this failure.");
  }
  if (existing && (existing.status === "expired" || existing.status === "cancelled")) {
    blockers.push("A recovery authorization already exists for this provider failure.");
  }
  const bundle = implId ? await currentEvidenceBundle(taskId, implId, projectPath) : null;
  if (!bundle || bundle.status !== "complete") blockers.push("The evidence bundle is not complete.");
  const plan = record.tasks.find((item) => item.taskId === taskId);
  return {
    eligible: blockers.length === 0,
    blockers,
    batchId,
    taskId,
    failedReviewerRunId: failed?.runId ?? null,
    failedReviewerPhaseGrantId: phaseGrantId,
    failedQcReviewId: failed?.review.id ?? null,
    developerRunId: implId,
    evidenceBundleDigest: bundle?.digest ?? null,
    sourceFingerprint: bundle?.sourceFingerprint ?? null,
    reviewerHarnessId: plan?.reviewerHarness ?? wf?.grant.reviewerHarness ?? null,
    reviewerModel: plan?.reviewerModel ?? wf?.grant.reviewerModel ?? null,
    failureClass: failed ? "quota-exhausted" : null,
    failureDetail: failed ? failed.proof : null,
    frozenMaxLaunches: wf?.grant.maxLaunches ?? record.policy?.maxLaunchesPerTask ?? null,
    launchesUsed: wf?.counters.launchesUsed ?? null,
    remainingOrdinaryLaunches: wf ? ordinaryLaunchesRemaining(wf.grant, wf.counters) : null,
    authorization: existing,
  };
}

export async function approveProviderRecovery(
  projectPath: string,
  batchId: string,
  taskId: string,
  opts?: { validMinutes?: unknown; reason?: unknown },
): Promise<ProviderRecoveryAuthorization> {
  const preview = await assessProviderRecovery(projectPath, batchId, taskId);
  if (preview.authorization?.status === "consumed") {
    throw new ProviderRecoveryError(preview.blockers[0] ?? "The supplemental recovery allowance is already consumed.", 409, "consumed");
  }
  if (preview.authorization && (preview.authorization.status === "approved" || preview.authorization.status === "applied")) {
    if (preview.authorization.expiresAt <= Date.now()) {
      throw new ProviderRecoveryError("Recovery authorization expired. It was not extended.", 409, "expired");
    }
    return preview.authorization;
  }
  if (preview.authorization) {
    throw new ProviderRecoveryError("A recovery authorization already exists for this provider failure.", 409, "exists");
  }
  if (!preview.eligible) {
    throw new ProviderRecoveryError(preview.blockers[0] ?? "Recovery is not eligible.", 409, "ineligible");
  }
  if (!preview.failedReviewerRunId || !preview.failedQcReviewId || !preview.developerRunId) {
    throw new ProviderRecoveryError("Recovery facts are incomplete.", 409, "ineligible");
  }
  const record = loadBatch(projectPath, batchId)!;
  if (record.policy?.expiresAt != null && Date.now() >= record.policy.expiresAt) {
    throw new ProviderRecoveryError("The batch grant has expired. Recovery does not extend it.", 409, "expired");
  }
  const bundle = await currentEvidenceBundle(taskId, preview.developerRunId, projectPath);
  if (!bundle || bundle.status !== "complete") throw new ProviderRecoveryError("The evidence bundle is incomplete.", 409, "evidence");
  const now = Date.now();
  const minutes = clampProviderRecoveryMinutes(opts?.validMinutes);
  const reason = typeof opts?.reason === "string" && opts.reason.trim()
    ? opts.reason.trim().slice(0, 400)
    : "Owner-approved supplemental Reviewer launch after provider quota failure.";
  const auth: ProviderRecoveryAuthorization = {
    id: randomUUID(),
    batchId,
    taskId,
    projectPath,
    status: "approved",
    failedReviewerRunId: preview.failedReviewerRunId,
    failedReviewerPhaseGrantId: preview.failedReviewerPhaseGrantId ?? "",
    failedQcReviewId: preview.failedQcReviewId,
    developerRunId: preview.developerRunId,
    evidenceBundleDigest: bundle.digest,
    sourceFingerprint: bundle.sourceFingerprint,
    reviewerHarnessId: preview.reviewerHarnessId ?? "",
    reviewerModel: preview.reviewerModel ?? "",
    failureClass: "quota-exhausted",
    failureDetail: preview.failureDetail ?? "usage_limit_exceeded",
    reason,
    approvedAt: now,
    approvedBy: "owner",
    expiresAt: now + minutes * 60_000,
    supplementalMaxLaunches: 1,
    supplementalLaunchesConsumed: 0,
    recoveryPhaseGrantId: null,
    appliedAt: null,
    audit: [],
    createdAt: now,
    updatedAt: now,
  };
  audit(auth, "approved", reason);
  persistAuth(auth);
  new ActivityJournalCore(db).record({
    eventType: "qc.recovery.approved",
    projectPath,
    actorType: "owner",
    actorId: "owner",
    targetType: "task",
    targetId: taskId,
    taskId,
    idempotencyKey: `provider-recovery:approve:${auth.id}`,
    payload: { batchId, recoveryId: auth.id, failedReviewerRunId: auth.failedReviewerRunId },
  });
  return auth;
}

export async function applyProviderRecovery(projectPath: string, batchId: string, recoveryId: string): Promise<ProviderRecoveryAuthorization> {
  const auth = loadAuth(recoveryId);
  if (!auth || auth.batchId !== batchId || auth.projectPath !== projectPath) {
    throw new ProviderRecoveryError("Recovery authorization not found.", 404, "not-found");
  }
  if (auth.status === "consumed" || auth.status === "cancelled" || auth.status === "expired") {
    throw new ProviderRecoveryError(`Recovery authorization is ${auth.status}.`, 409, "terminal");
  }
  if (auth.expiresAt <= Date.now()) {
    auth.status = "expired";
    audit(auth, "expired");
    persistAuth(auth);
    throw new ProviderRecoveryError("Recovery authorization expired.", 409, "expired");
  }
  if (auth.status === "applied" && auth.appliedAt) return auth;
  const preview = await assessProviderRecovery(projectPath, batchId, auth.taskId);
  if (!preview.evidenceBundleDigest || preview.evidenceBundleDigest !== auth.evidenceBundleDigest) {
    throw new ProviderRecoveryError(
      preview.evidenceBundleDigest ? "Evidence changed since approval." : "The evidence bundle is incomplete.",
      409,
      preview.evidenceBundleDigest ? "evidence-changed" : "evidence",
    );
  }
  if (!preview.sourceFingerprint || preview.sourceFingerprint !== auth.sourceFingerprint) {
    throw new ProviderRecoveryError(
      preview.sourceFingerprint ? "Source fingerprint changed since approval." : "The evidence bundle is incomplete.",
      409,
      preview.sourceFingerprint ? "evidence-changed" : "evidence",
    );
  }
  const record = loadBatch(projectPath, batchId);
  if (!record || record.status !== "paused") throw new ProviderRecoveryError("The batch is not paused.", 409, "batch");
  const wf = getWorkflowForTask(auth.taskId);
  if (!wf) throw new ProviderRecoveryError("Workflow not found.", 404, "not-found");
  if (record.policy?.expiresAt != null && Date.now() >= record.policy.expiresAt) {
    throw new ProviderRecoveryError("The batch grant has expired.", 409, "expired");
  }
  const wfRow = db.query<{ id: string; grant_json: string; data_json: string }, [string]>(
    `SELECT id, grant_json, data_json FROM pm_orchestrated_workflows WHERE task_id = ? ORDER BY updated_at DESC LIMIT 1`,
  ).get(auth.taskId);
  if (wfRow) {
    const data = JSON.parse(wfRow.data_json) as { progress: Record<string, unknown>; counters: Record<string, unknown> };
    data.progress = {
      ...data.progress,
      pauseReason: null,
      activeReviewId: null,
      phase: "awaiting_review",
      failureClass: "quota-exhausted",
      waitReason: "Owner recovery applied. Authorize one supplemental Reviewer launch.",
    };
    db.run(
      `UPDATE pm_orchestrated_workflows SET status = 'active', phase = 'awaiting_review', data_json = ?, updated_at = ? WHERE id = ?`,
      [JSON.stringify(data), Date.now(), wfRow.id],
    );
  }
  const task = tasks.get(auth.taskId);
  if (task && task.column === "blocked") moveTaskColumn(auth.taskId, "review");
  const prog = record.progress.byTask[auth.taskId];
  if (prog) {
    prog.phase = "paused";
    prog.pauseReason = null;
    prog.failureClass = "quota-exhausted";
    prog.authorizationPhase = "reviewer";
    prog.waitReason = "Authorize the supplemental Reviewer phase grant.";
    prog.lastCompletedStep = prog.lastCompletedStep ?? "Evidence complete";
  }
  record.progress.pauseReason = "Provider recovery applied. Resume the batch after minting a supplemental Reviewer grant.";
  saveBatch(record);
  auth.status = "applied";
  auth.appliedAt = Date.now();
  audit(auth, "applied");
  persistAuth(auth);
  return auth;
}

export async function mintRecoveryPhaseGrant(projectPath: string, batchId: string, recoveryId: string): Promise<{ authorization: ProviderRecoveryAuthorization; phaseGrantId: string; scheduledReview: boolean }> {
  const auth = loadAuth(recoveryId);
  if (!auth || auth.batchId !== batchId || auth.projectPath !== projectPath) {
    throw new ProviderRecoveryError("Recovery authorization not found.", 404, "not-found");
  }
  if (auth.status !== "applied") throw new ProviderRecoveryError("Apply recovery before minting a phase grant.", 409, "not-applied");
  if (auth.recoveryPhaseGrantId) throw new ProviderRecoveryError("A recovery phase grant already exists.", 409, "duplicate");
  if (auth.expiresAt <= Date.now()) {
    auth.status = "expired";
    persistAuth(auth);
    throw new ProviderRecoveryError("Recovery authorization expired.", 409, "expired");
  }
  const { approveRecoveryPhaseGrant } = await import("./pm-orchestrated-batch.ts");
  const { phaseGrantId } = await approveRecoveryPhaseGrant(projectPath, batchId, {
    taskId: auth.taskId,
    implementationRunId: auth.developerRunId,
    recoveryAuthorizationId: auth.id,
    harnessId: auth.reviewerHarnessId,
  });
  auth.recoveryPhaseGrantId = phaseGrantId;
  audit(auth, "phase-grant", phaseGrantId);
  persistAuth(auth);
  const scheduledReview = await scheduleRecoveryReview(projectPath, batchId);
  return { authorization: auth, phaseGrantId, scheduledReview };
}

/**
 * A running batch gets one gated evaluation after the grant is durable.
 * A paused batch does not launch until the Owner resume path runs.
 * Duplicate requests never reach this: the recovery already has a grant id.
 */
async function scheduleRecoveryReview(projectPath: string, batchId: string): Promise<boolean> {
  const record = loadBatch(projectPath, batchId);
  if (!record || record.status !== "running") return false;
  const { tickOrchestratedBatch } = await import("./pm-orchestrated-batch.ts");
  await tickOrchestratedBatch(batchId);
  return true;
}

export function getProviderRecovery(recoveryId: string): ProviderRecoveryAuthorization | null {
  return loadAuth(recoveryId);
}

/**
 * Budget check after onRunRecorded has already counted this launch.
 * A consumed one-slot recovery still covers that in-flight launch. It does
 * not cover a later one: callers must use this only for the launch that just
 * incremented the counter.
 */
export function supplementalCoveringRecordedLaunch(taskId: string, now = Date.now()): ProviderRecoveryAuthorization | null {
  const live = recoveryAuthForSupplementalLaunch(taskId, now);
  if (live) return live;
  const rows = db.query<RecoveryRow, [string]>(
    `SELECT * FROM pm_provider_recoveries WHERE task_id = ? ORDER BY updated_at DESC`,
  ).all(taskId);
  for (const row of rows) {
    const auth = rowAuth(row);
    if (!auth || auth.status !== "consumed" || auth.supplementalLaunchesConsumed !== 1) continue;
    return { ...auth, status: "applied", supplementalLaunchesConsumed: 0, expiresAt: Math.max(auth.expiresAt, now + 60_000) };
  }
  return null;
}

function recoveryAuthForSupplementalLaunch(taskId: string, now: number): ProviderRecoveryAuthorization | null {
  const rows = db.query<RecoveryRow, [string]>(
    `SELECT * FROM pm_provider_recoveries WHERE task_id = ? ORDER BY created_at DESC`,
  ).all(taskId);
  for (const row of rows) {
    const auth = rowAuth(row);
    if (auth && supplementalLaunchesRemaining(auth, now) > 0) return auth;
  }
  return null;
}

export function noteSupplementalLaunchConsumed(taskId: string, runId: string): void {
  const now = Date.now();
  const auth = recoveryAuthForSupplementalLaunch(taskId, now);
  if (!auth || auth.supplementalLaunchesConsumed >= auth.supplementalMaxLaunches) return;
  const reauth = auth.prelaunchReauthorization;
  const reauthLive = !!reauth && reauth.status === "applied" && reauth.expiresAt > now;
  const originalLive = auth.status === "applied" && auth.expiresAt > now;
  if (!reauthLive && !originalLive) return;
  auth.supplementalLaunchesConsumed = 1;
  auth.status = "consumed";
  audit(auth, "supplemental-launch-consumed", runId);
  persistAuth(auth);
}

export function providerRecoveryAllowsRetry(taskId: string, failedRunId: string | null): boolean {
  const auth = recoveryAuthForSupplementalLaunch(taskId, Date.now());
  if (!auth) return false;
  if (failedRunId && auth.failedReviewerRunId !== failedRunId) return false;
  return supplementalLaunchesRemaining(auth, Date.now()) > 0;
}

export function supplementalRecoveryAuthIfNeeded(
  taskId: string,
  grant: import("../shared/pm-orchestrated-workflow.ts").OrchestratedWorkflowGrant,
  counters: import("../shared/pm-orchestrated-workflow.ts").OrchestratedWorkflowCounters,
  now = Date.now(),
): ProviderRecoveryAuthorization | null {
  if (ordinaryLaunchesRemaining(grant, counters) > 0) return null;
  return recoveryAuthForSupplementalLaunch(taskId, now);
}

export function recoveryCoversUnresolvedReview(taskId: string, reviewId: string, now = Date.now()): boolean {
  const row = db.query<RecoveryRow, [string, string]>(
    `SELECT * FROM pm_provider_recoveries
     WHERE task_id = ? AND json_extract(recovery_json, '$.failedQcReviewId') = ?
     ORDER BY created_at DESC LIMIT 1`,
  ).get(taskId, reviewId);
  const auth = row ? rowAuth(row) : null;
  if (!auth || auth.failedQcReviewId !== reviewId) return false;
  if (auth.status === "cancelled" || auth.supplementalLaunchesConsumed > 0) return false;
  const reauth = auth.prelaunchReauthorization;
  if (reauth?.status === "applied" && reauth.expiresAt > now) return true;
  return (auth.status === "approved" || auth.status === "applied") && auth.expiresAt > now;
}

export async function managerPreview(path: unknown, batchId: string, taskId: string) {
  const project = typeof path === "string" ? path : "";
  if (!project) throw new ProviderRecoveryError("path is required.", 400, "invalid");
  return assessProviderRecovery(project, batchId, taskId);
}

export async function managerApprove(path: unknown, batchId: string, body: { taskId?: unknown; validMinutes?: unknown; reason?: unknown }) {
  const project = typeof path === "string" ? path : "";
  const taskId = typeof body.taskId === "string" ? body.taskId : "";
  if (!project || !taskId) throw new ProviderRecoveryError("path and taskId are required.", 400, "invalid");
  return approveProviderRecovery(project, batchId, taskId, body);
}

export async function managerApply(path: unknown, batchId: string, recoveryId: string) {
  const project = typeof path === "string" ? path : "";
  if (!project) throw new ProviderRecoveryError("path is required.", 400, "invalid");
  return applyProviderRecovery(project, batchId, recoveryId);
}

export function recoverProviderRecoveries(): void {
  const now = Date.now();
  // Do not repair phase grants. A consumed grant with no Run stays as recorded
  // until an explicit classification says the pre-launch failure is proved.
  const rows = db.query<RecoveryRow, []>(
    `SELECT * FROM pm_provider_recoveries WHERE status IN ('approved', 'applied', 'expired')`,
  ).all();
  for (const row of rows) {
    const auth = rowAuth(row);
    if (!auth) continue;
    let changed = false;
    const approvedAt = auth.approvedAt;
    const expiresAt = auth.expiresAt;
    if ((auth.status === "approved" || auth.status === "applied") && auth.expiresAt <= now) {
      auth.status = "expired";
      audit(auth, "expired", "boot");
      changed = true;
    }
    const reauth = auth.prelaunchReauthorization;
    if (reauth && (reauth.status === "approved" || reauth.status === "applied") && reauth.expiresAt <= now) {
      reauth.status = "expired";
      audit(auth, "prelaunch-reauthorization-expired", "boot");
      changed = true;
    }
    if (auth.approvedAt !== approvedAt || auth.expiresAt !== expiresAt) continue;
    if (changed) persistAuth(auth);
  }
}

export async function managerMintGrant(path: unknown, batchId: string, recoveryId: string) {
  const project = typeof path === "string" ? path : "";
  if (!project) throw new ProviderRecoveryError("path is required.", 400, "invalid");
  return mintRecoveryPhaseGrant(project, batchId, recoveryId);
}

export async function classifyPrelaunchClaim(projectPath: string, batchId: string, recoveryId: string): Promise<PrelaunchClaimClassification> {
  const auth = loadAuth(recoveryId);
  if (!auth || auth.projectPath !== projectPath || auth.batchId !== batchId) {
    return { kind: "manual-review", recoveryId, grantId: null, reason: "Recovery authorization was not found for this batch." };
  }
  const record = loadBatch(projectPath, batchId);
  const grant = record?.phaseGrants?.find((item) => item.id === auth.recoveryPhaseGrantId) ?? null;
  if (!record || !grant) {
    return { kind: "manual-review", recoveryId, grantId: auth.recoveryPhaseGrantId, reason: "The recovery phase grant was not found." };
  }
  if (grant.taskId !== auth.taskId || (grant.recoveryAuthorizationId != null && grant.recoveryAuthorizationId !== auth.id)) {
    return { kind: "manual-review", recoveryId, grantId: grant.id, reason: "The phase grant is not bound to this recovery." };
  }
  if (grant.consumedRunId) return { kind: "launched", recoveryId, grantId: grant.id, runId: grant.consumedRunId };
  if (auth.supplementalLaunchesConsumed > 0 || auth.status === "consumed" || auth.status === "cancelled") {
    return { kind: "manual-review", recoveryId, grantId: grant.id, reason: "Supplemental allowance is already consumed or the recovery was cancelled." };
  }
  if (isTaskRunLive(auth.taskId)) {
    return { kind: "manual-review", recoveryId, grantId: grant.id, reason: "A process is still active for this task." };
  }
  const laterRun = db.query<{ id: string }, [string, number]>(
    `SELECT id FROM runs WHERE task_id = ? AND started_at >= ? LIMIT 1`,
  ).get(auth.taskId, grant.approvedAt);
  if (laterRun) {
    return { kind: "manual-review", recoveryId, grantId: grant.id, reason: "A Run was recorded after the phase grant was issued, so absence of a provider launch cannot be proved." };
  }
  const execution = db.query<{ id: string }, [string, number]>(
    `SELECT id FROM employee_executions
     WHERE task_id = ? AND created_at >= ? AND status IN ('starting', 'started', 'indeterminate') LIMIT 1`,
  ).get(auth.taskId, grant.approvedAt);
  if (execution) {
    return { kind: "manual-review", recoveryId, grantId: grant.id, reason: "An employee execution was in progress after the phase grant was issued." };
  }
  const linkedReview = db.query<{ id: string }, [string, number]>(
    `SELECT id FROM task_quality_reviews WHERE task_id = ? AND requested_at >= ? AND review_run_id IS NOT NULL LIMIT 1`,
  ).get(auth.taskId, grant.approvedAt);
  if (linkedReview) {
    return { kind: "manual-review", recoveryId, grantId: grant.id, reason: "A quality review created after the grant is linked to a Run." };
  }
  const wf = getWorkflowForTask(auth.taskId);
  const extraLaunch = (wf?.progress.launchedRuns ?? []).some((item) => item.runId !== auth.developerRunId && item.runId !== auth.failedReviewerRunId);
  if (extraLaunch) {
    return { kind: "manual-review", recoveryId, grantId: grant.id, reason: "Launch history names a Run other than the original Developer and failed Reviewer." };
  }
  if (grant.implementationRunId !== auth.developerRunId) {
    return { kind: "manual-review", recoveryId, grantId: grant.id, reason: "The phase grant does not name the recovery's Developer run." };
  }
  const developer = runs.get(auth.developerRunId);
  const failed = runs.get(auth.failedReviewerRunId);
  if (!developer || developer.taskId !== auth.taskId || developer.status !== "succeeded" || developer.qcReviewId) {
    return { kind: "manual-review", recoveryId, grantId: grant.id, reason: "The original Developer run is no longer a succeeded implementation." };
  }
  if (!failed || failed.taskId !== auth.taskId || failed.id !== auth.failedReviewerRunId) {
    return { kind: "manual-review", recoveryId, grantId: grant.id, reason: "The original failed Reviewer run is missing." };
  }
  const bundle = await currentEvidenceBundle(auth.taskId, auth.developerRunId, projectPath);
  if (!bundle || bundle.status !== "complete" || bundle.digest !== auth.evidenceBundleDigest || bundle.sourceFingerprint !== auth.sourceFingerprint) {
    return { kind: "manual-review", recoveryId, grantId: grant.id, reason: "The evidence bundle does not match the recovery approval, or it could not be read." };
  }
  if (grant.status === "claimed" || (grant.status !== "prelaunch-failed" && grant.status !== "consumed")) {
    return { kind: "manual-review", recoveryId, grantId: grant.id, reason: "The grant is not a finished pre-launch failure. A launch may still have been in progress." };
  }
  let operation: "bind-implementation" | "prepare-qc-review" | null = null;
  let message: string | null = null;
  if (grant.status === "prelaunch-failed" && grant.prelaunchFailure?.message) {
    operation = grant.prelaunchFailure.operation;
    message = grant.prelaunchFailure.message;
  } else if (grant.status === "consumed") {
    const events = db.query<{ text: string }, [string, number]>(
      `SELECT text FROM pm_orchestrated_batch_events WHERE batch_id = ? AND at >= ? ORDER BY at ASC`,
    ).all(batchId, grant.approvedAt);
    const hit = events.find((event) => isPreparationFailureText(event.text));
    if (!hit) {
      return { kind: "manual-review", recoveryId, grantId: grant.id, reason: "The grant is consumed without a Run, and no persisted preparation failure proves the claim." };
    }
    operation = hit.text.includes("bind-implementation") ? "bind-implementation" : "prepare-qc-review";
    message = hit.text;
  }
  if (!operation || !message) {
    return { kind: "manual-review", recoveryId, grantId: grant.id, reason: "The failed preparation operation was not recorded." };
  }
  return {
    kind: "proven-prelaunch-failure",
    recoveryId,
    grantId: grant.id,
    operation,
    message,
    implementationRunId: grant.implementationRunId,
    developerRunId: auth.developerRunId,
    failedReviewerRunId: auth.failedReviewerRunId,
  };
}

function assertBatchUnexpired(projectPath: string, batchId: string): void {
  const record = loadBatch(projectPath, batchId);
  if (!record) throw new ProviderRecoveryError("Batch not found.", 404, "not-found");
  if (record.policy?.expiresAt != null && Date.now() >= record.policy.expiresAt) {
    throw new ProviderRecoveryError("The batch grant has expired. Recovery does not extend it.", 409, "expired");
  }
}

export async function approvePrelaunchReauthorization(
  projectPath: string,
  batchId: string,
  recoveryId: string,
  opts?: { validMinutes?: unknown; reason?: unknown },
): Promise<ProviderRecoveryAuthorization> {
  const auth = loadAuth(recoveryId);
  if (!auth || auth.batchId !== batchId || auth.projectPath !== projectPath) {
    throw new ProviderRecoveryError("Recovery authorization not found.", 404, "not-found");
  }
  if (auth.prelaunchReauthorization) {
    throw new ProviderRecoveryError("A pre-launch reauthorization already exists for this recovery.", 409, "duplicate");
  }
  if (auth.supplementalLaunchesConsumed > 0 || auth.status === "consumed") {
    throw new ProviderRecoveryError("The supplemental recovery allowance is already consumed.", 409, "consumed");
  }
  const classification = await classifyPrelaunchClaim(projectPath, batchId, recoveryId);
  if (classification.kind !== "proven-prelaunch-failure") {
    const reason = classification.kind === "launched"
      ? "A Reviewer run is already bound to this grant."
      : classification.reason;
    throw new ProviderRecoveryError(reason, 409, classification.kind === "manual-review" ? "manual-review" : "launched");
  }
  assertBatchUnexpired(projectPath, batchId);
  const approvedAt = auth.approvedAt;
  const expiresAt = auth.expiresAt;
  const status = auth.status;
  const now = Date.now();
  const minutes = clampProviderRecoveryMinutes(opts?.validMinutes);
  const reason = typeof opts?.reason === "string" && opts.reason.trim()
    ? opts.reason.trim().slice(0, 400)
    : "Owner reauthorized one Reviewer launch after a verified pre-launch failure.";
  auth.prelaunchReauthorization = {
    id: randomUUID(),
    status: "approved",
    approvedAt: now,
    approvedBy: "owner",
    expiresAt: now + minutes * 60_000,
    reason,
    failedGrantId: classification.grantId,
    classification: "proven-prelaunch-failure",
    replacementPhaseGrantId: null,
    appliedAt: null,
  };
  if (auth.approvedAt !== approvedAt || auth.expiresAt !== expiresAt || auth.status !== status) {
    throw new ProviderRecoveryError("Refusing to rewrite the original recovery approval.", 409, "immutable");
  }
  audit(auth, "prelaunch-reauthorization-approved", classification.grantId);
  persistAuth(auth);
  new ActivityJournalCore(db).record({
    eventType: "qc.recovery.approved",
    projectPath,
    actorType: "owner",
    actorId: "owner",
    targetType: "task",
    targetId: auth.taskId,
    taskId: auth.taskId,
    idempotencyKey: `provider-recovery:prelaunch-reauth:${auth.prelaunchReauthorization.id}`,
    payload: { batchId, recoveryId: auth.id, failedGrantId: classification.grantId },
  });
  return auth;
}

export async function applyPrelaunchReauthorization(projectPath: string, batchId: string, recoveryId: string): Promise<ProviderRecoveryAuthorization> {
  const auth = loadAuth(recoveryId);
  if (!auth || auth.batchId !== batchId || auth.projectPath !== projectPath) {
    throw new ProviderRecoveryError("Recovery authorization not found.", 404, "not-found");
  }
  const reauth = auth.prelaunchReauthorization;
  if (!reauth) throw new ProviderRecoveryError("No pre-launch reauthorization exists.", 409, "missing");
  if (reauth.status === "applied" && reauth.appliedAt) return auth;
  if (reauth.status !== "approved") throw new ProviderRecoveryError(`Pre-launch reauthorization is ${reauth.status}.`, 409, "terminal");
  if (reauth.expiresAt <= Date.now()) {
    reauth.status = "expired";
    audit(auth, "prelaunch-reauthorization-expired");
    persistAuth(auth);
    throw new ProviderRecoveryError("Pre-launch reauthorization expired. It was not extended.", 409, "expired");
  }
  const classification = await classifyPrelaunchClaim(projectPath, batchId, recoveryId);
  if (classification.kind !== "proven-prelaunch-failure" || classification.grantId !== reauth.failedGrantId) {
    throw new ProviderRecoveryError(
      classification.kind === "proven-prelaunch-failure" ? "The failed grant no longer matches the reauthorization." : classification.kind === "launched" ? "A Reviewer run is already bound to this grant." : classification.reason,
      409,
      "not-proven",
    );
  }
  assertBatchUnexpired(projectPath, batchId);
  const record = loadBatch(projectPath, batchId);
  if (!record || (record.status !== "paused" && record.status !== "running")) {
    throw new ProviderRecoveryError("The batch cannot accept a pre-launch reauthorization.", 409, "batch");
  }
  const approvedAt = auth.approvedAt;
  const expiresAt = auth.expiresAt;
  const wfRow = db.query<{ id: string; data_json: string }, [string]>(
    `SELECT id, data_json FROM pm_orchestrated_workflows WHERE task_id = ? ORDER BY updated_at DESC LIMIT 1`,
  ).get(auth.taskId);
  if (!wfRow) throw new ProviderRecoveryError("Workflow not found.", 404, "not-found");
  const data = JSON.parse(wfRow.data_json) as { progress: Record<string, unknown> };
  data.progress = {
    ...data.progress,
    pauseReason: null,
    activeReviewId: null,
    phase: "awaiting_review",
    failureClass: "unknown",
    waitReason: "Pre-launch reauthorization applied. Mint the replacement Reviewer grant.",
  };
  db.run(
    `UPDATE pm_orchestrated_workflows SET status = 'active', phase = 'awaiting_review', data_json = ?, updated_at = ? WHERE id = ?`,
    [JSON.stringify(data), Date.now(), wfRow.id],
  );
  const task = tasks.get(auth.taskId);
  if (task && task.column === "blocked") moveTaskColumn(auth.taskId, "review");
  const prog = record.progress.byTask[auth.taskId];
  if (prog) {
    prog.pauseReason = null;
    prog.failureClass = "unknown";
    prog.authorizationPhase = "reviewer";
    prog.waitReason = "Mint the replacement Reviewer phase grant.";
  }
  if (record.status === "paused") {
    record.progress.pauseReason = "Pre-launch reauthorization applied. Resume the batch, then mint the replacement Reviewer grant.";
    saveBatch(record);
  }
  reauth.status = "applied";
  reauth.appliedAt = Date.now();
  if (auth.approvedAt !== approvedAt || auth.expiresAt !== expiresAt) {
    throw new ProviderRecoveryError("Refusing to rewrite the original recovery approval.", 409, "immutable");
  }
  audit(auth, "prelaunch-reauthorization-applied");
  persistAuth(auth);
  return auth;
}

export async function mintPrelaunchReplacementGrant(projectPath: string, batchId: string, recoveryId: string): Promise<{ authorization: ProviderRecoveryAuthorization; phaseGrantId: string; scheduledReview: boolean }> {
  const auth = loadAuth(recoveryId);
  if (!auth || auth.batchId !== batchId || auth.projectPath !== projectPath) {
    throw new ProviderRecoveryError("Recovery authorization not found.", 404, "not-found");
  }
  const reauth = auth.prelaunchReauthorization;
  if (!reauth || reauth.status !== "applied") throw new ProviderRecoveryError("Apply the pre-launch reauthorization before minting a replacement grant.", 409, "not-applied");
  if (reauth.replacementPhaseGrantId) throw new ProviderRecoveryError("A replacement Reviewer grant already exists.", 409, "duplicate");
  if (reauth.expiresAt <= Date.now()) {
    reauth.status = "expired";
    persistAuth(auth);
    throw new ProviderRecoveryError("Pre-launch reauthorization expired. It was not extended.", 409, "expired");
  }
  const classification = await classifyPrelaunchClaim(projectPath, batchId, recoveryId);
  if (classification.kind !== "proven-prelaunch-failure" || classification.grantId !== reauth.failedGrantId) {
    throw new ProviderRecoveryError("The pre-launch failure is no longer proved.", 409, "not-proven");
  }
  assertBatchUnexpired(projectPath, batchId);
  const { approveReplacementRecoveryPhaseGrant } = await import("./pm-orchestrated-batch.ts");
  const { phaseGrantId } = await approveReplacementRecoveryPhaseGrant(projectPath, batchId, {
    taskId: auth.taskId,
    implementationRunId: auth.developerRunId,
    recoveryAuthorizationId: auth.id,
    reauthorizationId: reauth.id,
    replacesGrantId: reauth.failedGrantId,
    harnessId: auth.reviewerHarnessId,
    expiresAt: reauth.expiresAt,
  });
  reauth.replacementPhaseGrantId = phaseGrantId;
  audit(auth, "prelaunch-replacement-grant", phaseGrantId);
  persistAuth(auth);
  const scheduledReview = await scheduleRecoveryReview(projectPath, batchId);
  return { authorization: auth, phaseGrantId, scheduledReview };
}

export async function managerClassifyPrelaunch(path: unknown, batchId: string, recoveryId: string) {
  const project = typeof path === "string" ? path : "";
  if (!project) throw new ProviderRecoveryError("path is required.", 400, "invalid");
  return classifyPrelaunchClaim(project, batchId, recoveryId);
}

export async function managerApprovePrelaunch(path: unknown, batchId: string, recoveryId: string, body: { validMinutes?: unknown; reason?: unknown }) {
  const project = typeof path === "string" ? path : "";
  if (!project) throw new ProviderRecoveryError("path is required.", 400, "invalid");
  return approvePrelaunchReauthorization(project, batchId, recoveryId, body);
}

export async function managerApplyPrelaunch(path: unknown, batchId: string, recoveryId: string) {
  const project = typeof path === "string" ? path : "";
  if (!project) throw new ProviderRecoveryError("path is required.", 400, "invalid");
  return applyPrelaunchReauthorization(project, batchId, recoveryId);
}

export async function managerMintPrelaunch(path: unknown, batchId: string, recoveryId: string) {
  const project = typeof path === "string" ? path : "";
  if (!project) throw new ProviderRecoveryError("path is required.", 400, "invalid");
  return mintPrelaunchReplacementGrant(project, batchId, recoveryId);
}
