/**
 * FO-AUTO03-RECOVERY-LAUNCH-FIX03 — authoritative Developer run for a gated Reviewer.
 * The grant's implementationRunId is the only selector. task.runId is not consulted.
 */
import { db, runs } from "./db.ts";
import { buildImplementationEvidence } from "./implementation-evidence.ts";
import type { Task } from "../shared/types.ts";
import type { OrchestratedBatchRecord, QueuePhaseGrant } from "../shared/pm-orchestrated-batch.ts";
import type { ProviderRecoveryAuthorization } from "../shared/pm-provider-recovery.ts";

export type ReviewerBinding =
  | { ok: true; implementationRunId: string; recoveryAuthorizationId: string | null }
  | { ok: false; operation: "bind-implementation"; message: string };

function loadBatch(batchId: string): OrchestratedBatchRecord | null {
  const row = db.query<{ data_json: string }, [string]>(
    `SELECT data_json FROM pm_orchestrated_batches WHERE id = ?`,
  ).get(batchId);
  if (!row) return null;
  try {
    return JSON.parse(row.data_json) as OrchestratedBatchRecord;
  } catch {
    return null;
  }
}

function loadRecovery(id: string): ProviderRecoveryAuthorization | null {
  const row = db.query<{ recovery_json: string; status: string }, [string]>(
    `SELECT recovery_json, status FROM pm_provider_recoveries WHERE id = ?`,
  ).get(id);
  if (!row) return null;
  try {
    const auth = JSON.parse(row.recovery_json) as ProviderRecoveryAuthorization;
    auth.status = row.status as ProviderRecoveryAuthorization["status"];
    return auth;
  } catch {
    return null;
  }
}

export async function resolveGatedReviewerTarget(input: {
  task: Task;
  batchId: string;
  grantId: string;
  completedImplementationRunIds: readonly string[];
  projectPath: string;
}): Promise<ReviewerBinding> {
  const record = loadBatch(input.batchId);
  const grant = record?.phaseGrants?.find((item) => item.id === input.grantId) ?? null;
  if (!record || !grant) return { ok: false, operation: "bind-implementation", message: "Reviewer phase grant was not found." };
  if (grant.taskId !== input.task.id || grant.phase !== "reviewer") {
    return { ok: false, operation: "bind-implementation", message: "Reviewer phase grant is not for this task." };
  }
  if (!grant.implementationRunId) {
    return { ok: false, operation: "bind-implementation", message: "Reviewer phase grant does not name an implementation run." };
  }
  const implementationRunId = grant.implementationRunId;
  if (!input.completedImplementationRunIds.includes(implementationRunId)) {
    return { ok: false, operation: "bind-implementation", message: "The granted implementation run is not a completed Developer run for this task." };
  }
  const run = runs.get(implementationRunId);
  if (!run || run.taskId !== input.task.id) {
    return { ok: false, operation: "bind-implementation", message: "The granted implementation run does not belong to this task." };
  }
  if (run.status !== "succeeded") {
    return { ok: false, operation: "bind-implementation", message: "The granted implementation run did not succeed." };
  }
  if (run.qcReviewId) {
    return { ok: false, operation: "bind-implementation", message: "The granted run is a Reviewer run, not a Developer implementation." };
  }
  const recoveryId = grant.recoveryAuthorizationId ?? null;
  if (recoveryId) {
    const recoveryBlock = await recoveryBinding(grant, input.task, input.projectPath, implementationRunId, recoveryId);
    if (recoveryBlock) return { ok: false, operation: "bind-implementation", message: recoveryBlock };
  } else {
    const bundleBlock = await evidenceBlock(input.task, input.projectPath, implementationRunId, null);
    if (bundleBlock) return { ok: false, operation: "bind-implementation", message: bundleBlock };
  }
  return { ok: true, implementationRunId, recoveryAuthorizationId: recoveryId };
}

async function recoveryBinding(
  grant: QueuePhaseGrant,
  task: Task,
  projectPath: string,
  implementationRunId: string,
  recoveryId: string,
): Promise<string | null> {
  const auth = loadRecovery(recoveryId);
  if (!auth || auth.taskId !== task.id) return "Recovery authorization for this Reviewer grant was not found.";
  if (auth.developerRunId !== implementationRunId) return "Recovery authorization is bound to a different Developer run.";
  if (auth.failedReviewerRunId && implementationRunId === auth.failedReviewerRunId) {
    return "The failed Reviewer run cannot be used as the implementation.";
  }
  if (grant.reauthorizationId) {
    const reauth = auth.prelaunchReauthorization;
    if (!reauth || reauth.id !== grant.reauthorizationId) return "Replacement Reviewer grant has no matching Owner reauthorization.";
    if (reauth.status !== "applied") return "Pre-launch reauthorization has not been applied.";
    if (reauth.expiresAt <= Date.now()) return "Pre-launch reauthorization expired. It was not extended.";
    if (reauth.failedGrantId && grant.replacesGrantId && reauth.failedGrantId !== grant.replacesGrantId) {
      return "Replacement Reviewer grant does not match the failed pre-launch claim.";
    }
  } else if (auth.status !== "applied" || auth.expiresAt <= Date.now()) {
    return "Recovery authorization is not an active applied approval. It was not extended.";
  }
  if (auth.supplementalLaunchesConsumed >= auth.supplementalMaxLaunches) {
    return "The supplemental Reviewer allowance is already consumed.";
  }
  return evidenceBlock(task, projectPath, implementationRunId, auth);
}

async function evidenceBlock(
  task: Task,
  projectPath: string,
  implementationRunId: string,
  auth: ProviderRecoveryAuthorization | null,
): Promise<string | null> {
  const developer = runs.get(implementationRunId);
  if (!developer?.endedAt) return "The Developer run has no finish time, so its evidence cannot be reviewed.";
  let bundle;
  try {
    bundle = await buildImplementationEvidence({
      task,
      requirements: task.prompt,
      developerRunId: implementationRunId,
      developerEndedAt: developer.endedAt,
      projectPath,
      resourceFingerprint: null,
    });
  } catch (error) {
    return error instanceof Error ? error.message : "Evidence could not be collected.";
  }
  if (bundle.status !== "complete" || bundle.developerRunId !== implementationRunId) {
    return bundle.blocker ?? "The evidence bundle for the granted Developer run is not complete.";
  }
  if (auth && (bundle.digest !== auth.evidenceBundleDigest || bundle.sourceFingerprint !== auth.sourceFingerprint)) {
    return "Evidence fingerprint changed since the recovery approval.";
  }
  return null;
}
