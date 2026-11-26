/**
 * FO-QC-RECOVERY01 — one new read-only Reviewer launch for an existing Developer run.
 * Does not create a Developer run, does not rewrite the failed review, and does not
 * resume the historical batch.
 */
import { randomUUID } from "node:crypto";
import { AccountCore } from "./account-core.ts";
import { ActivityJournalCore } from "./activity-journal-core.ts";
import { selectedCodexAccount } from "./codex-profiles.ts";
import { db, harnesses, runs, taskQualityReviews, tasks } from "./db.ts";
import { DEEPSEEK_EXECUTION_BLOCKER } from "./deepseek-execution-policy.ts";
import { isTaskRunLive, moveTaskColumn } from "./orchestrator.ts";
import { unsupportedModelReason, resourceKey } from "./orchestrated-resources.ts";
import { getWorkflowForTask, reconcileStuckFailedReview } from "./pm-orchestrated-workflow.ts";
import { QcError, prepareQcReview, startQcReview } from "./task-quality-control.ts";
import { collectRecoveryEvidence, QcRecoveryEvidenceError } from "./qc-recovery-evidence.ts";
import {
  isMateriallyImproved,
  isMissingEvidenceReview,
  MISSING_EVIDENCE_SUMMARY,
  MISSING_OBSERVED_TEST,
  renderEvidenceForReviewer,
  renderEvidenceLimitation,
  type ReviewEvidenceBundle,
  type ReviewTestAuthorization,
  type ReviewTestPurpose,
} from "../shared/review-evidence.ts";
import { buildImplementationEvidence } from "./implementation-evidence.ts";
import { recordedSourceAlignment, recheckReviewEvidence } from "./review-evidence.ts";
import { gatedEvidenceWaitAllowsTest } from "../shared/queue-gates.ts";
import { publicationAlignmentForRun } from "./task-workspace.ts";
import { ownershipOf } from "./project-ownership.ts";
import { checkProjectLaunchAdmission } from "./project-lifecycle.ts";
import {
  approveTestAuthorization,
  cancelTestAuthorization,
  executeTestAuthorization,
  invalidateTestAuthorization,
  latestTestAuthorization,
  openTestAuthorization,
  prepareTestAuthorization,
  recoverTestAuthorizations,
  requireTestAuthorization,
  ReviewTestAuthorizationError,
} from "./review-test-authorization.ts";
import { DEEPSEEK_INSTALLATION_ID } from "../shared/harness-installation.ts";
import {
  QC_RECOVERY_LIMITS,
  assessQcRecovery,
  clampRecoveryMinutes,
  readOnlyReviewerContract,
  recoveryIdentityHash,
  type QcRecoveryCandidate,
  type QcRecoveryEvidence,
  type QcRecoveryGrant,
  type QcRecoveryStatus,
  type QcRecoveryView,
} from "../shared/qc-recovery.ts";
import type { Task } from "../shared/types.ts";

export class QcRecoveryError extends Error {
  constructor(message: string, readonly status = 400, readonly code = "invalid") {
    super(message);
    this.name = "QcRecoveryError";
  }
}

interface GrantRow {
  id: string;
  task_id: string;
  project_path: string;
  status: string;
  review_id: string | null;
  review_run_id: string | null;
  grant_json: string;
  created_at: number;
  updated_at: number;
}

function parseGrant(raw: string): QcRecoveryGrant | null {
  try {
    const grant = JSON.parse(raw) as QcRecoveryGrant;
    if (!grant || grant.authorizesDeveloper !== false || grant.maxLaunches !== 1) return null;
    if (typeof grant.taskId !== "string" || typeof grant.developerRunId !== "string") return null;
    return grant;
  } catch {
    return null;
  }
}

function rowGrant(row: GrantRow): QcRecoveryGrant | null {
  const grant = parseGrant(row.grant_json);
  if (!grant) return null;
  grant.status = row.status as QcRecoveryStatus;
  grant.reviewId = row.review_id;
  grant.reviewRunId = row.review_run_id;
  return grant;
}

function loadGrant(id: string): QcRecoveryGrant | null {
  const row = db.query<GrantRow, [string]>(`SELECT * FROM qc_recovery_grants WHERE id = ?`).get(id);
  return row ? rowGrant(row) : null;
}

function saveGrant(grant: QcRecoveryGrant): void {
  grant.updatedAt = Date.now();
  db.run(
    `UPDATE qc_recovery_grants SET status = ?, review_id = ?, review_run_id = ?, grant_json = ?, updated_at = ? WHERE id = ?`,
    [grant.status, grant.reviewId, grant.reviewRunId, JSON.stringify(grant), grant.updatedAt, grant.id],
  );
}

function insertGrant(grant: QcRecoveryGrant): void {
  db.run(
    `INSERT INTO qc_recovery_grants (id, task_id, project_path, status, review_id, review_run_id, grant_json, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [grant.id, grant.taskId, grant.projectPath, grant.status, grant.reviewId, grant.reviewRunId, JSON.stringify(grant), grant.createdAt, grant.updatedAt],
  );
}

function openGrant(taskId: string): QcRecoveryGrant | null {
  const row = db.query<GrantRow, [string]>(
    `SELECT * FROM qc_recovery_grants WHERE task_id = ? AND status IN ('prepared', 'approved') ORDER BY created_at DESC LIMIT 1`,
  ).get(taskId);
  return row ? rowGrant(row) : null;
}

function latestGrant(taskId: string): QcRecoveryGrant | null {
  const row = db.query<GrantRow, [string]>(
    `SELECT * FROM qc_recovery_grants WHERE task_id = ? ORDER BY created_at DESC LIMIT 1`,
  ).get(taskId);
  return row ? rowGrant(row) : null;
}

function journal(grant: Pick<QcRecoveryGrant, "id" | "taskId" | "projectPath">, eventType: "qc.recovery.reconciled" | "qc.recovery.approved" | "qc.recovery.started" | "qc.recovery.cancelled", payload: Record<string, unknown>): void {
  new ActivityJournalCore(db).record({
    eventType,
    projectPath: grant.projectPath,
    actorType: "owner",
    actorId: "owner",
    targetType: "task",
    targetId: grant.taskId,
    taskId: grant.taskId,
    idempotencyKey: `qc-recovery:${grant.id}:${eventType}:${grant.taskId}`,
    payload,
  });
}

interface RecoveryFacts {
  task: Task;
  developerRunId: string;
  developerEndedAt: number | null;
  failedReviewId: string;
  failedReviewRunId: string;
  failureSummary: string;
  requirements: string;
  projectPath: string;
  historicalBatchId: string | null;
  batchStatus: string | null;
  batchPauseReason: string | null;
  workflowStatus: string | null;
  situationBlockers: string[];
  reconciliationRequired: boolean;
}

function batchFacts(batchId: string | null): { status: string | null; pauseReason: string | null } {
  if (!batchId) return { status: null, pauseReason: null };
  const row = db.query<{ status: string; data_json: string }, [string]>(
    `SELECT status, data_json FROM pm_orchestrated_batches WHERE id = ?`,
  ).get(batchId);
  if (!row) return { status: null, pauseReason: null };
  let pauseReason: string | null = null;
  try {
    const data = JSON.parse(row.data_json) as { progress?: { pauseReason?: string | null } };
    pauseReason = typeof data.progress?.pauseReason === "string" ? data.progress.pauseReason : null;
  } catch {
    pauseReason = null;
  }
  return { status: row.status, pauseReason };
}

function factsFor(taskId: string): RecoveryFacts {
  const task = tasks.get(taskId);
  if (!task) throw new QcRecoveryError("Task not found.", 404, "not-found");
  const reviews = taskQualityReviews.listForTask(taskId);
  const failed = [...reviews].reverse().find((review) => review.status === "complete" && review.verdict == null && review.reviewRunId);
  const developer = failed?.implementationRunId ? runs.get(failed.implementationRunId) : null;
  const failedRun = failed?.reviewRunId ? runs.get(failed.reviewRunId) : null;
  const workflow = getWorkflowForTask(taskId);
  const batch = batchFacts(workflow?.grant.orchestratedBatchId ?? null);
  let requirements = task.prompt;
  let requirementsMatch = true;
  if (failed) {
    const stored = taskQualityReviews.get(failed.id);
    try {
      const saved = JSON.parse(stored?.savedTaskJson ?? "{}") as { prompt?: string };
      if (typeof saved.prompt === "string") {
        requirements = saved.prompt;
        requirementsMatch = saved.prompt === task.prompt;
      }
    } catch {
      requirementsMatch = false;
    }
  }
  const assessed = assessQcRecovery({
    archived: task.archivedAt != null,
    column: task.column,
    liveRun: isTaskRunLive(taskId),
    activeReview: !!taskQualityReviews.getActive(taskId),
    developerRunId: developer?.id ?? null,
    developerSucceeded: developer?.status === "succeeded" && !developer.qcReviewId && developer.taskId === taskId,
    failedReviewId: failed?.id ?? null,
    failedReviewVerdict: failed?.verdict ?? null,
    failedReviewComplete: failed?.status === "complete",
    failedReviewImplementationRunId: failed?.implementationRunId ?? null,
    failedRunStatus: failedRun?.status ?? null,
    latestVerdict: task.qcState?.latestVerdict ?? null,
    workflowStatus: workflow?.status ?? null,
    batchStatus: batch.status,
    requirementsMatch,
  });
  return {
    task,
    developerRunId: developer?.id ?? "",
    developerEndedAt: developer?.endedAt ?? null,
    failedReviewId: failed?.id ?? "",
    failedReviewRunId: failed?.reviewRunId ?? "",
    failureSummary: failed?.summary ?? "Reviewer process failed before a QC verdict.",
    requirements,
    projectPath: failed?.projectPath ?? workflow?.projectPath ?? task.workdir,
    historicalBatchId: workflow?.grant.orchestratedBatchId ?? null,
    batchStatus: batch.status,
    batchPauseReason: batch.pauseReason,
    workflowStatus: workflow?.status ?? null,
    situationBlockers: assessed.blockers,
    reconciliationRequired: assessed.reconciliationRequired,
  };
}

function reviewUserPrompt(reviewRunId: string | null): string | null {
  if (!reviewRunId) return null;
  const text = runs.events(reviewRunId).filter((event) => event.stream === "user").map((event) => event.data).join("\n");
  return text || null;
}

async function bundleForTask(input: {
  task: Task;
  requirements: string;
  developerRunId: string;
  developerEndedAt: number;
  projectPath: string;
  resourceFingerprint: string | null;
  reuseTest?: ReviewEvidenceBundle["test"];
}): Promise<ReviewEvidenceBundle> {
  try {
    return await buildImplementationEvidence(input);
  } catch (error) {
    if (error instanceof Error && error.message === "The implementation workspace was not recorded.") {
      throw new QcRecoveryError(error.message, 409, "evidence");
    }
    throw error;
  }
}

interface EvidenceRefreshFacts {
  task: Task;
  developerRunId: string;
  developerEndedAt: number;
  blockedReviewId: string;
  blockedSummary: string;
  requirements: string;
  projectPath: string;
  priorPrompt: string | null;
  blockers: string[];
}

function evidenceRefreshFacts(taskId: string): EvidenceRefreshFacts | null {
  const task = tasks.get(taskId);
  if (!task) throw new QcRecoveryError("Task not found.", 404, "not-found");
  const reviews = taskQualityReviews.listForTask(taskId);
  const latestComplete = [...reviews].reverse().find((review) => review.status === "complete");
  const blocked = latestComplete && latestComplete.verdict === "BLOCKED" && isMissingEvidenceReview({
    verdict: latestComplete.verdict,
    evidenceState: latestComplete.evidenceState ?? null,
    summary: latestComplete.summary,
    feedback: latestComplete.feedback,
    findingsText: latestComplete.findings.map((finding) => finding.text).join("\n"),
  })
    ? latestComplete
    : null;
  if (!blocked) return null;
  const developer = blocked.implementationRunId ? runs.get(blocked.implementationRunId) : null;
  const workflow = getWorkflowForTask(taskId);
  const batch = batchFacts(workflow?.grant.orchestratedBatchId ?? null);
  let requirements = task.prompt;
  let requirementsMatch = true;
  try {
    const saved = JSON.parse(taskQualityReviews.get(blocked.id)?.savedTaskJson ?? "{}") as { prompt?: string };
    if (typeof saved.prompt === "string") {
      requirements = saved.prompt;
      requirementsMatch = saved.prompt === task.prompt;
    }
  } catch {
    requirementsMatch = false;
  }
  const blockers: string[] = [];
  if (task.archivedAt != null) blockers.push("Task is archived.");
  if (isTaskRunLive(taskId)) blockers.push("An implementation or review is still running for this task.");
  if (taskQualityReviews.getActive(taskId)) blockers.push("A quality review is already in progress.");
  if (task.qcState?.latestVerdict !== "BLOCKED") blockers.push("Evidence refresh needs a QC BLOCKED verdict.");
  if (task.qcState?.latestVerdict === "CHANGES_REQUESTED") blockers.push("CHANGES_REQUESTED is not a missing-evidence block.");
  if (!developer || developer.status !== "succeeded" || developer.qcReviewId || developer.taskId !== taskId || developer.endedAt == null) {
    blockers.push("Evidence refresh needs the original successful Developer run.");
  }
  if (!requirementsMatch) blockers.push("Task requirements changed after the blocked review.");
  if (batch.status === "running") blockers.push("The batch is still running. Evidence refresh does not stop or resume a batch.");
  if (workflow?.status === "active") blockers.push("The original workflow is still active. Reconcile it before a new grant. The original grant is not reused.");
  return {
    task,
    developerRunId: developer?.id ?? "",
    developerEndedAt: developer?.endedAt ?? 0,
    blockedReviewId: blocked.id,
    blockedSummary: blocked.summary ?? MISSING_EVIDENCE_SUMMARY,
    requirements,
    projectPath: blocked.projectPath,
    priorPrompt: reviewUserPrompt(blocked.reviewRunId),
    blockers,
  };
}

async function loadEvidence(facts: RecoveryFacts): Promise<QcRecoveryEvidence> {
  try {
    return await collectRecoveryEvidence({
      taskId: facts.task.id,
      title: facts.task.title,
      prompt: facts.requirements,
      workdir: facts.task.workdir,
      projectPath: facts.projectPath,
      isolation: facts.task.isolation,
      worktreePath: facts.task.worktreePath,
      developerRunId: facts.developerRunId,
      developerEndedAt: facts.developerEndedAt,
    });
  } catch (error) {
    if (error instanceof QcRecoveryEvidenceError) throw new QcRecoveryError(error.message, 409, "evidence");
    throw error;
  }
}

function candidatesFor(): QcRecoveryCandidate[] {
  const core = new AccountCore(db);
  const now = Date.now();
  const out: QcRecoveryCandidate[] = [];
  for (const harness of harnesses.list()) {
    if (!harness.enabled) continue;
    const contract = readOnlyReviewerContract(harness.kind);
    if (!contract) continue;
    if (harness.id === DEEPSEEK_INSTALLATION_ID) continue;
    // This is a read-only listing. `selectedCodexAccount` is the launch-time check ("directory was
    // replaced", "registration changed", ...) and throws when one profile needs the Owner's attention;
    // that must mark this candidate unavailable with its reason, never fail the whole view (an
    // exception here used to escape the route and, before the request boundary, stop the app).
    let account: ReturnType<typeof selectedCodexAccount> = null;
    let unavailableReason: string | null = null;
    if (harness.kind === "codex") {
      try {
        account = selectedCodexAccount(harness);
      } catch (error) {
        unavailableReason = error instanceof Error ? error.message : "Codex profile registration is unavailable.";
      }
    }
    try {
      resourceKey(harness);
    } catch (error) {
      unavailableReason ??= error instanceof Error ? error.message : "Resource fingerprint is unavailable.";
    }
    const unsupportedModels = account
      ? core.modelCapabilities(account.id)
        .filter((row) => row.harnessId === harness.id && row.support === "unsupported" && row.verification === "verified" && row.expiresAt != null && row.expiresAt > now && !!row.source)
        .map((row) => ({ modelId: row.modelId, expiresAt: row.expiresAt as number }))
      : [];
    out.push({
      harnessId: harness.id,
      label: harness.label,
      kind: harness.kind,
      accountId: account?.id ?? null,
      accountLabel: account?.displayName ?? null,
      mode: contract.mode,
      sandbox: contract.sandbox,
      permission: contract.permission,
      unavailableReason,
      unsupportedModels,
    });
  }
  return out;
}

export async function getQcRecoveryView(taskId: string): Promise<QcRecoveryView> {
  const facts = factsFor(taskId);
  let evidence: QcRecoveryEvidence | null = null;
  let evidenceReason: string | null = null;
  if (facts.developerRunId && facts.situationBlockers.every((item) => !item.startsWith("Recovery needs"))) {
    try {
      evidence = await loadEvidence(facts);
      if (facts.situationBlockers.length === 0 && facts.developerEndedAt != null) {
        const bundle = await bundleForTask({
          task: facts.task,
          requirements: facts.requirements,
          developerRunId: facts.developerRunId,
          developerEndedAt: facts.developerEndedAt,
          projectPath: facts.projectPath,
          resourceFingerprint: null,
        });
        if (bundle.status === "blocked") evidenceReason = bundle.blocker ?? "Evidence is incomplete.";
        else evidenceReason = recordedSourceAlignment(facts.developerRunId, bundle);
      }
    } catch (error) {
      evidenceReason = error instanceof QcRecoveryError ? error.message : error instanceof Error ? error.message : "Implementation evidence is unavailable.";
    }
  }
  const blockers = evidenceReason ? [...facts.situationBlockers, evidenceReason] : facts.situationBlockers;
  const runsForTask = runs.listForTask(taskId);
  const evidenceRefresh = await evidenceRefreshView(taskId);
  const firstReview = await firstReviewView(taskId);
  return {
    eligible: blockers.length === 0,
    reconciliationRequired: facts.reconciliationRequired,
    blockers,
    developerRunId: facts.developerRunId || null,
    failedReviewId: facts.failedReviewId || null,
    failedReviewRunId: facts.failedReviewRunId || null,
    failureSummary: facts.failureSummary,
    historicalBatchId: facts.historicalBatchId,
    historicalBatchStatus: facts.batchStatus,
    historicalBatchPauseReason: facts.batchPauseReason,
    evidence,
    evidenceReason,
    candidates: candidatesFor(),
    grant: openGrant(taskId) ?? latestGrant(taskId),
    implementationRunCount: runsForTask.filter((run) => run.status === "succeeded" && !run.qcReviewId).length,
    reviewRunCount: runsForTask.filter((run) => !!run.qcReviewId).length,
    quota: "unknown",
    cost: "unknown",
    authorizesDeveloper: false,
    authorizesRework: false,
    authorizesOtherTasks: false,
    authorizesBatchResume: false,
    maxLaunches: 1,
    evidenceRefresh,
    firstReview,
  };
}

async function evidenceRefreshView(taskId: string): Promise<QcRecoveryView["evidenceRefresh"]> {
  const refresh = evidenceRefreshFacts(taskId);
  if (!refresh) {
    return { eligible: false, blockers: [], blockedReviewId: null, blockedSummary: null, bundle: null, bundleReason: null, testAuthorization: null };
  }
  let bundle: ReviewEvidenceBundle | null = null;
  let bundleReason: string | null = null;
  if (refresh.blockers.length === 0 && refresh.developerEndedAt > 0) {
    try {
      bundle = await bundleForTask({
        task: refresh.task,
        requirements: refresh.requirements,
        developerRunId: refresh.developerRunId,
        developerEndedAt: refresh.developerEndedAt,
        projectPath: refresh.projectPath,
        resourceFingerprint: null,
      });
      if (bundle.status === "blocked") bundleReason = bundle.blocker ?? "Evidence is incomplete.";
      else if (bundle.status === "complete" && !isMateriallyImproved(refresh.priorPrompt, bundle)) bundleReason = "The evidence bundle is not materially different from the review already sent.";
      else if (latestGrant(taskId)?.purpose === "evidence-refresh" && latestGrant(taskId)?.status === "consumed" && latestGrant(taskId)?.evidenceBundle?.digest === bundle.digest) {
        bundleReason = "This evidence bundle was already used. A repeated review needs new evidence and a new Owner grant.";
      }
    } catch (error) {
      bundleReason = error instanceof Error ? error.message : "Evidence could not be collected.";
    }
  }
  const blockers = bundleReason ? [...refresh.blockers, bundleReason] : refresh.blockers;
  return {
    eligible: blockers.length === 0 && bundle?.status === "complete",
    blockers,
    blockedReviewId: refresh.blockedReviewId,
    blockedSummary: refresh.blockedSummary,
    bundle,
    bundleReason,
    testAuthorization: testAuthorizationFor(taskId, "evidence-refresh", "refresh"),
  };
}

export async function reconcileQcRecovery(taskId: string): Promise<QcRecoveryView> {
  const facts = factsFor(taskId);
  if (!facts.reconciliationRequired) {
    throw new QcRecoveryError(facts.situationBlockers[0] ?? "This failed review does not need reconciliation.", 409, "not-legacy");
  }
  if (facts.batchStatus === "running") {
    throw new QcRecoveryError("The batch is still running. Recovery does not stop or resume a batch.", 409, "batch-running");
  }
  const batchJsonBefore = facts.historicalBatchId
    ? db.query<{ data_json: string; status: string }, [string]>(`SELECT data_json, status FROM pm_orchestrated_batches WHERE id = ?`).get(facts.historicalBatchId)
    : null;
  const reason = `Owner reconciled a finished failed review (${facts.failedReviewId}). No QC verdict was added. The original grant is not reused.`;
  reconcileStuckFailedReview(taskId, reason);
  const task = tasks.get(taskId);
  if (task?.column === "running" && (task.runId === facts.failedReviewRunId || task.runId == null)) {
    const run = facts.failedReviewRunId ? runs.get(facts.failedReviewRunId) : null;
    if (!run || run.status === "failed" || run.status === "cancelled" || run.status === "orphaned") {
      moveTaskColumn(taskId, "blocked");
    }
  }
  if (batchJsonBefore && facts.historicalBatchId) {
    const after = db.query<{ data_json: string; status: string }, [string]>(`SELECT data_json, status FROM pm_orchestrated_batches WHERE id = ?`).get(facts.historicalBatchId);
    if (!after || after.status !== batchJsonBefore.status || after.data_json !== batchJsonBefore.data_json) {
      throw new QcRecoveryError("Reconciliation tried to change the historical batch. It was left untouched.", 500, "batch-mutated");
    }
  }
  const stamp = latestGrant(taskId)?.id ?? `reconcile:${taskId}`;
  journal({ id: stamp, taskId, projectPath: facts.projectPath }, "qc.recovery.reconciled", {
    taskId,
    grantId: stamp,
    developerRunId: facts.developerRunId,
    failedReviewId: facts.failedReviewId,
    batchId: facts.historicalBatchId ?? "",
  });
  return getQcRecoveryView(taskId);
}

function selectionFrom(body: { reviewerHarness?: unknown; reviewerModel?: unknown; reviewerEffort?: unknown; reviewerMode?: unknown; validMinutes?: unknown }) {
  const harnessId = typeof body.reviewerHarness === "string" ? body.reviewerHarness.trim() : "";
  const model = typeof body.reviewerModel === "string" ? body.reviewerModel.trim() : "";
  const effort = typeof body.reviewerEffort === "string" && body.reviewerEffort.trim() ? body.reviewerEffort.trim() : null;
  if (!harnessId || !model) throw new QcRecoveryError("Choose a Reviewer harness and model. Nothing is selected automatically.", 400, "invalid");
  const harness = harnesses.getByIdOrKind(harnessId);
  if (!harness?.enabled) throw new QcRecoveryError("That Reviewer harness is missing or disabled.", 400, "invalid");
  if (harness.id === DEEPSEEK_INSTALLATION_ID) {
    throw new QcRecoveryError(DEEPSEEK_EXECUTION_BLOCKER, 409, "deepseek");
  }
  const contract = readOnlyReviewerContract(harness.kind);
  if (!contract) throw new QcRecoveryError("That harness has no supported read-only Reviewer mode.", 409, "read-only");
  if (typeof body.reviewerMode === "string" && body.reviewerMode.trim() && body.reviewerMode.trim() !== contract.mode) {
    throw new QcRecoveryError("That mode can change files. Review-only recovery requires the read-only mode for this harness.", 409, "read-only");
  }
  const unsupported = unsupportedModelReason(harness, model);
  if (unsupported) throw new QcRecoveryError(unsupported, 409, "model-unsupported");
  let fingerprint: string;
  try {
    fingerprint = resourceKey(harness);
  } catch (error) {
    throw new QcRecoveryError(error instanceof Error ? error.message : "Resource fingerprint is unavailable.", 409, "resource");
  }
  const account = harness.kind === "codex" ? selectedCodexAccount(harness) : null;
  return {
    harness,
    model,
    effort,
    contract,
    fingerprint,
    accountId: account?.id ?? null,
    accountLabel: account?.displayName ?? null,
    validMinutes: clampRecoveryMinutes(body.validMinutes),
  };
}

function assertSameEvidence(frozen: QcRecoveryEvidence, fresh: QcRecoveryEvidence): void {
  if (fresh.treeFingerprint !== frozen.treeFingerprint || fresh.gitHead !== frozen.gitHead || fresh.identityHash !== frozen.identityHash || fresh.requirementsHash !== frozen.requirementsHash || fresh.workspacePath !== frozen.workspacePath) {
    throw new QcRecoveryEvidenceError("Implementation evidence changed after it was frozen. Approve a new grant for the current tree. No source snapshot was captured at the Developer run.");
  }
}

export async function prepareQcRecovery(taskId: string, body: { reviewerHarness?: unknown; reviewerModel?: unknown; reviewerEffort?: unknown; reviewerMode?: unknown; validMinutes?: unknown; purpose?: unknown }): Promise<QcRecoveryGrant> {
  if (body.purpose === "evidence-refresh") return prepareEvidenceRefresh(taskId, body);
  const facts = factsFor(taskId);
  if (facts.reconciliationRequired) throw new QcRecoveryError(facts.situationBlockers.at(-1) ?? "Reconcile the failed review first.", 409, "needs-reconciliation");
  if (facts.situationBlockers.length > 0) throw new QcRecoveryError(facts.situationBlockers[0]!, 409, "ineligible");
  if (openGrant(taskId)) throw new QcRecoveryError("A QC-only grant is already open. Approve, start, or cancel it.", 409, "open-grant");
  const evidence = await loadEvidence(facts);
  const selected = selectionFrom(body);
  if (facts.developerEndedAt == null) {
    throw new QcRecoveryError("The Developer run has no finish time, so later file edits cannot be distinguished.", 409, "evidence");
  }
  const evidenceBundle = await bundleForTask({
    task: facts.task,
    requirements: facts.requirements,
    developerRunId: facts.developerRunId,
    developerEndedAt: facts.developerEndedAt,
    projectPath: facts.projectPath,
    resourceFingerprint: selected.fingerprint,
  });
  if (evidenceBundle.status === "blocked") {
    throw new QcRecoveryError(evidenceBundle.blocker ?? "Evidence is incomplete.", 409, "evidence");
  }
  const aligned = recordedSourceAlignment(facts.developerRunId, evidenceBundle);
  if (aligned) throw new QcRecoveryError(aligned, 409, "evidence");
  const now = Date.now();
  const grant: QcRecoveryGrant = {
    id: randomUUID(),
    taskId,
    projectPath: facts.projectPath,
    status: "prepared",
    developerRunId: facts.developerRunId,
    failedReviewId: facts.failedReviewId,
    failedReviewRunId: facts.failedReviewRunId,
    failureSummary: facts.failureSummary,
    historicalBatchId: facts.historicalBatchId,
    evidence,
    reviewerHarnessId: selected.harness.id,
    reviewerKind: selected.harness.kind,
    reviewerModel: selected.model,
    reviewerEffort: selected.effort,
    reviewerMode: selected.contract.mode,
    reviewerSandbox: selected.contract.sandbox,
    reviewerAccountId: selected.accountId,
    reviewerAccountLabel: selected.accountLabel,
    resourceFingerprint: selected.fingerprint,
    maxLaunches: 1,
    launchesUsed: 0,
    validMinutes: selected.validMinutes,
    expiresAt: null,
    approvedAt: null,
    approvedBy: null,
    reviewId: null,
    reviewRunId: null,
    outcome: null,
    authorizesDeveloper: false,
    authorizesRework: false,
    authorizesOtherTasks: false,
    authorizesBatchResume: false,
    quota: "unknown",
    cost: "unknown",
    purpose: "process-failure",
    blockedReviewId: null,
    evidenceBundle,
    createdAt: now,
    updatedAt: now,
  };
  insertGrant(grant);
  return grant;
}

export async function approveQcRecovery(taskId: string, grantId: string): Promise<QcRecoveryGrant> {
  const grant = loadGrant(grantId);
  if (!grant || grant.taskId !== taskId) throw new QcRecoveryError("QC recovery grant not found.", 404, "not-found");
  if (grant.purpose === "evidence-refresh") return approveEvidenceRefresh(grant);
  if (grant.status === "approved") return grant;
  if (grant.status !== "prepared") throw new QcRecoveryError(`QC recovery grant is ${grant.status}.`, 409, grant.status);
  const facts = factsFor(taskId);
  if (facts.reconciliationRequired || facts.situationBlockers.length > 0) {
    throw new QcRecoveryError(facts.situationBlockers[0] ?? "This task can no longer take a QC-only grant.", 409, "ineligible");
  }
  try {
    const fresh = await loadEvidence(facts);
    assertSameEvidence(grant.evidence, fresh);
    if (grant.evidenceBundle) {
      const stale = await recheckReviewEvidence(grant.evidenceBundle, grant.evidenceBundle.workspacePath);
      if (stale) throw new QcRecoveryEvidenceError(stale);
    }
    const selected = selectionFrom({
      reviewerHarness: grant.reviewerHarnessId,
      reviewerModel: grant.reviewerModel,
      reviewerEffort: grant.reviewerEffort,
      reviewerMode: grant.reviewerMode,
    });
    if (selected.fingerprint !== grant.resourceFingerprint) {
      grant.status = "invalidated";
      saveGrant(grant);
      throw new QcRecoveryError("Approved execution resource changed or is unavailable. No fallback.", 409, "resource");
    }
  } catch (error) {
    if (error instanceof QcRecoveryError) throw error;
    if (error instanceof QcRecoveryEvidenceError) {
      grant.status = "invalidated";
      saveGrant(grant);
      throw new QcRecoveryError(error.message, 409, "evidence");
    }
    throw error;
  }
  const now = Date.now();
  grant.status = "approved";
  grant.approvedAt = now;
  grant.approvedBy = "owner";
  grant.expiresAt = now + grant.validMinutes * 60_000;
  saveGrant(grant);
  journal(grant, "qc.recovery.approved", {
    taskId,
    grantId: grant.id,
    developerRunId: grant.developerRunId,
    reviewerHarness: grant.reviewerHarnessId,
    reviewerModel: grant.reviewerModel,
    resourceFingerprint: grant.resourceFingerprint,
    maxLaunches: 1,
    expiresAt: grant.expiresAt,
  });
  return loadGrant(grantId)!;
}

export function noteRecoveryLaunchCommitted(grantId: string, reviewId: string, runId: string): void {
  const grant = loadGrant(grantId);
  if (!grant || grant.status !== "approved" || grant.launchesUsed !== 0) {
    throw new Error("QC recovery grant cannot be consumed.");
  }
  grant.status = "consumed";
  grant.launchesUsed = 1;
  grant.reviewId = reviewId;
  grant.reviewRunId = runId;
  saveGrant(grant);
}

export function noteRecoverySettled(grantId: string, verdict: string | null, runStatus: string): void {
  const grant = loadGrant(grantId);
  if (!grant || grant.outcome) return;
  grant.outcome = runStatus !== "succeeded" || !verdict
    ? "process_failure"
    : verdict === "PASS"
      ? "pass"
      : verdict === "CHANGES_REQUESTED"
        ? "changes_requested"
        : "blocked";
  if (grant.launchesUsed < 1) grant.launchesUsed = 1;
  if (grant.status === "approved" || grant.status === "prepared") grant.status = "consumed";
  saveGrant(grant);
}

function recoveryPrompt(grant: QcRecoveryGrant): string {
  return [
    "Frozen implementation identity for this QC-only recovery.",
    `Developer run: ${grant.developerRunId}`,
    `Requirements hash: ${grant.evidence.requirementsHash}`,
    `Git HEAD: ${grant.evidence.gitHead}`,
    `Tree fingerprint: ${grant.evidence.treeFingerprint}`,
    `Reviewer permission: ${grant.reviewerMode}, sandbox ${grant.reviewerSandbox}.`,
    grant.evidence.publishedPaths?.length
      ? `Published after the Developer run and verified against that run's task workspace: ${grant.evidence.publishedPaths.join(", ")}.`
      : "",
    "No source snapshot was stored when the Developer run finished. Review only this workspace state.",
    "Do not modify files, deploy, or push.",
    grant.evidence.paths.slice(0, 40).join("\n"),
  ].join("\n");
}

function verifyGrant(grantId: string, committed: boolean): string | null {
  const grant = loadGrant(grantId);
  if (!grant) return "QC recovery grant is missing.";
  if (grant.status === "expired") return "QC recovery grant expired.";
  if (grant.status === "cancelled") return "QC recovery grant was cancelled.";
  if (grant.status === "invalidated") return "QC recovery grant was invalidated.";
  if (!committed && grant.status !== "approved") return "QC recovery grant is not approved.";
  if (committed && grant.status !== "consumed") return "QC recovery launch was not recorded.";
  if (!committed && grant.launchesUsed >= QC_RECOVERY_LIMITS.maxLaunches) return "QC recovery grant is already consumed.";
  if (committed && grant.launchesUsed > QC_RECOVERY_LIMITS.maxLaunches) return "QC recovery grant is already consumed.";
  if (grant.expiresAt != null && Date.now() >= grant.expiresAt) return "QC recovery grant expired.";
  const harness = harnesses.getByIdOrKind(grant.reviewerHarnessId);
  if (!harness?.enabled) return "Approved Reviewer resource is missing. No fallback.";
  const contract = readOnlyReviewerContract(harness.kind);
  if (!contract || grant.reviewerMode !== contract.mode || grant.reviewerSandbox !== contract.sandbox) {
    return "Approved Reviewer is not the read-only mode for this harness. No fallback.";
  }
  try {
    if (resourceKey(harness) !== grant.resourceFingerprint) return "Approved execution resource changed or is unavailable. No fallback.";
  } catch {
    return "Approved execution resource changed or is unavailable. No fallback.";
  }
  if (unsupportedModelReason(harness, grant.reviewerModel)) return "Approved account/model is confirmed unsupported. No fallback.";
  const task = tasks.get(grant.taskId);
  if (!task) return "Task is missing.";
  const identity = recoveryIdentityHash({
    taskId: task.id,
    title: task.title,
    prompt: task.prompt,
    workdir: task.workdir,
    projectPath: grant.projectPath,
    developerRunId: grant.developerRunId,
    isolation: task.isolation,
  });
  if (identity !== grant.evidence.identityHash) return "Task identity changed since approval. No fallback.";
  if (getWorkflowForTask(task.id)?.status === "active") return "The original workflow is still active. Reconcile it before launching. The original grant is not reused.";
  return null;
}

export async function startQcRecovery(taskId: string, grantId: string): Promise<{ runId: string }> {
  const grant = loadGrant(grantId);
  if (!grant || grant.taskId !== taskId) throw new QcRecoveryError("QC recovery grant not found.", 404, "not-found");
  const lifecycle = checkProjectLaunchAdmission(grant.projectPath);
  if (!lifecycle.allowed) throw new QcRecoveryError(lifecycle.reason!, 409, "project-lifecycle");
  if (grant.purpose === "evidence-refresh") return startEvidenceRefresh(grant);
  if (grant.launchesUsed > 0 || grant.status === "consumed") {
    throw new QcRecoveryError("This QC-only grant was already used. It does not launch again.", 409, "consumed");
  }
  const pre = verifyGrant(grantId, false);
  if (pre) {
    if (pre.includes("expired")) {
      grant.status = "expired";
      saveGrant(grant);
    } else if (pre.includes("changed") || pre.includes("unsupported") || pre.includes("identity")) {
      grant.status = "invalidated";
      saveGrant(grant);
    }
    throw new QcRecoveryError(pre, 409, "refused");
  }
  let fresh: QcRecoveryEvidence;
  try {
    fresh = await loadEvidence(factsFor(taskId));
    assertSameEvidence(grant.evidence, fresh);
    if (grant.evidenceBundle) {
      const stale = await recheckReviewEvidence(grant.evidenceBundle, grant.evidenceBundle.workspacePath);
      if (stale) throw new QcRecoveryEvidenceError(stale);
    }
  } catch (error) {
    grant.status = "invalidated";
    saveGrant(grant);
    if (error instanceof QcRecoveryError) throw error;
    throw new QcRecoveryError(error instanceof QcRecoveryEvidenceError ? error.message : "Implementation evidence changed.", 409, "evidence");
  }
  const task = tasks.get(taskId);
  if (!task || (task.column !== "blocked" && task.column !== "review")) {
    throw new QcRecoveryError("Move the stuck review to blocked before launching. Recovery does not start from a running implementation.", 409, "wrong-column");
  }
  let reviewId = grant.reviewId;
  if (reviewId) {
    const existing = taskQualityReviews.get(reviewId);
    if (!existing || existing.status === "cancelled") reviewId = null;
    else if (existing.status !== "pending") throw new QcRecoveryError("This grant already has a review.", 409, "review");
  }
  if (!reviewId) {
    let prepared;
    try {
      prepared = prepareQcReview({
        taskId,
        reviewerHarness: grant.reviewerHarnessId,
        reviewerModel: grant.reviewerModel,
      }, { implementationRunId: grant.developerRunId, allowColumns: ["blocked", "review"] });
    } catch (error) {
      if (error instanceof QcError) throw new QcRecoveryError(error.message, error.status, error.code);
      throw error;
    }
    reviewId = prepared.review.id;
  }
  const started = await startQcReview(reviewId, undefined, {
    mode: grant.reviewerMode,
    effort: grant.reviewerEffort,
    allowColumns: ["blocked", "review"],
    evidenceNote: recoveryPrompt(grant),
    evidenceSection: await evidenceSectionForGrant(grant),
    verify: (committed = false) => verifyGrant(grantId, committed),
    onRunRecorded: (runId) => noteRecoveryLaunchCommitted(grantId, reviewId!, runId),
  }, { recoveryGrantId: grantId });
  if ("error" in started) throw new QcRecoveryError(started.error, 409, "launch");
  const consumed = loadGrant(grantId);
  if (consumed) {
    journal(consumed, "qc.recovery.started", {
      taskId,
      grantId,
      developerRunId: consumed.developerRunId,
      reviewerHarness: consumed.reviewerHarnessId,
      reviewerModel: consumed.reviewerModel,
      resourceFingerprint: consumed.resourceFingerprint,
      maxLaunches: 1,
      expiresAt: consumed.expiresAt ?? 0,
    });
  }
  return { runId: started.runId };
}

export async function cancelQcRecovery(taskId: string, grantId: string): Promise<QcRecoveryGrant> {
  const grant = loadGrant(grantId);
  if (!grant || grant.taskId !== taskId) throw new QcRecoveryError("QC recovery grant not found.", 404, "not-found");
  if (grant.status === "cancelled") return grant;
  if (grant.reviewRunId) {
    const run = runs.get(grant.reviewRunId);
    if (run?.status === "running") {
      const { cancelRun } = await import("./orchestrator.ts");
      await cancelRun(grant.reviewRunId);
      return loadGrant(grantId) ?? grant;
    }
  }
  if (grant.status !== "prepared" && grant.status !== "approved") {
    throw new QcRecoveryError(`QC recovery grant is ${grant.status} and can no longer be cancelled.`, 409, grant.status);
  }
  grant.status = "cancelled";
  saveGrant(grant);
  journal(grant, "qc.recovery.cancelled", { taskId, grantId: grant.id, developerRunId: grant.developerRunId, failedReviewId: grant.failedReviewId, batchId: grant.historicalBatchId ?? "" });
  return loadGrant(grantId)!;
}

/**
 * Restart hook. Expires an unused approval whose clock has run out, and
 * settles a recovery review whose run is already terminal. Never launches
 * a Reviewer and never resumes a batch.
 */
export async function recoverQcRecoveryGrants(): Promise<number> {
  const expiredTests = recoverTestAuthorizations();
  const approved = db.query<GrantRow, []>(`SELECT * FROM qc_recovery_grants WHERE status = 'approved'`).all();
  let expired = 0;
  const now = Date.now();
  for (const row of approved) {
    const grant = rowGrant(row);
    if (!grant?.expiresAt || grant.expiresAt > now) continue;
    grant.status = "expired";
    saveGrant(grant);
    expired += 1;
  }
  const consumed = db.query<GrantRow, []>(`SELECT * FROM qc_recovery_grants WHERE status = 'consumed' AND review_id IS NOT NULL`).all();
  for (const row of consumed) {
    const grant = rowGrant(row);
    if (!grant?.reviewId || !grant.reviewRunId || grant.outcome) continue;
    const review = taskQualityReviews.get(grant.reviewId);
    const run = runs.get(grant.reviewRunId);
    if (review?.status !== "running" || !run) continue;
    if (run.status !== "orphaned" && run.status !== "failed" && run.status !== "cancelled") continue;
    const { settleQcReviewRun } = await import("./task-quality-control-settle.ts");
    await settleQcReviewRun(run.id, run.status);
  }
  return expired + expiredTests;
}

async function evidenceSectionForGrant(grant: QcRecoveryGrant): Promise<string> {
  if (grant.evidenceBundle?.status === "complete") return renderEvidenceForReviewer(grant.evidenceBundle);
  const task = tasks.get(grant.taskId);
  const endedAt = runs.get(grant.developerRunId)?.endedAt;
  if (!task || endedAt == null) return renderEvidenceLimitation("The Developer run has no finish time, so file contents were not attached.");
  try {
    const bundle = await bundleForTask({
      task,
      requirements: task.prompt,
      developerRunId: grant.developerRunId,
      developerEndedAt: endedAt,
      projectPath: grant.projectPath,
      resourceFingerprint: grant.resourceFingerprint,
    });
    return renderEvidenceForReviewer(bundle);
  } catch (error) {
    return renderEvidenceLimitation(error instanceof Error ? error.message : "Evidence could not be included.");
  }
}

async function prepareEvidenceRefresh(taskId: string, body: { reviewerHarness?: unknown; reviewerModel?: unknown; reviewerEffort?: unknown; reviewerMode?: unknown; validMinutes?: unknown }): Promise<QcRecoveryGrant> {
  const refresh = evidenceRefreshFacts(taskId);
  if (!refresh) throw new QcRecoveryError("This task has no missing-evidence QC BLOCKED review.", 409, "ineligible");
  if (refresh.blockers.length > 0) throw new QcRecoveryError(refresh.blockers[0]!, 409, "ineligible");
  if (openGrant(taskId)) throw new QcRecoveryError("A QC-only grant is already open. Approve, start, or cancel it.", 409, "open-grant");
  const selected = selectionFrom(body);
  const bundle = await bundleForTask({
    task: refresh.task,
    requirements: refresh.requirements,
    developerRunId: refresh.developerRunId,
    developerEndedAt: refresh.developerEndedAt,
    projectPath: refresh.projectPath,
    resourceFingerprint: selected.fingerprint,
  });
  if (bundle.status !== "complete") {
    throw new QcRecoveryError(bundle.status === "preview" ? MISSING_OBSERVED_TEST : (bundle.blocker ?? "Evidence is incomplete."), 409, "evidence");
  }
  if (!isMateriallyImproved(refresh.priorPrompt, bundle)) {
    throw new QcRecoveryError("The evidence bundle is not materially different from the review already sent.", 409, "evidence");
  }
  const previous = latestGrant(taskId);
  if (previous?.purpose === "evidence-refresh" && previous.status === "consumed" && previous.evidenceBundle?.digest === bundle.digest) {
    throw new QcRecoveryError("This evidence bundle was already used. A repeated review needs new evidence and a new Owner grant.", 409, "evidence");
  }
  let evidence;
  try {
    evidence = await collectRecoveryEvidence({
      taskId,
      title: refresh.task.title,
      prompt: refresh.requirements,
      workdir: refresh.task.workdir,
      projectPath: refresh.projectPath,
      isolation: refresh.task.isolation,
      worktreePath: refresh.task.worktreePath,
      developerRunId: refresh.developerRunId,
      developerEndedAt: refresh.developerEndedAt,
    });
  } catch (error) {
    if (error instanceof QcRecoveryEvidenceError) throw new QcRecoveryError(error.message, 409, "evidence");
    throw error;
  }
  const failed = taskQualityReviews.listForTask(taskId).find((review) => review.status === "complete" && review.verdict == null);
  const workflow = getWorkflowForTask(taskId);
  const now = Date.now();
  const grant: QcRecoveryGrant = {
    id: randomUUID(),
    taskId,
    projectPath: refresh.projectPath,
    status: "prepared",
    developerRunId: refresh.developerRunId,
    failedReviewId: failed?.id ?? refresh.blockedReviewId,
    failedReviewRunId: failed?.reviewRunId ?? "",
    failureSummary: refresh.blockedSummary,
    historicalBatchId: workflow?.grant.orchestratedBatchId ?? null,
    evidence,
    reviewerHarnessId: selected.harness.id,
    reviewerKind: selected.harness.kind,
    reviewerModel: selected.model,
    reviewerEffort: selected.effort,
    reviewerMode: selected.contract.mode,
    reviewerSandbox: selected.contract.sandbox,
    reviewerAccountId: selected.accountId,
    reviewerAccountLabel: selected.accountLabel,
    resourceFingerprint: selected.fingerprint,
    maxLaunches: 1,
    launchesUsed: 0,
    validMinutes: selected.validMinutes,
    expiresAt: null,
    approvedAt: null,
    approvedBy: null,
    reviewId: null,
    reviewRunId: null,
    outcome: null,
    authorizesDeveloper: false,
    authorizesRework: false,
    authorizesOtherTasks: false,
    authorizesBatchResume: false,
    quota: "unknown",
    cost: "unknown",
    purpose: "evidence-refresh",
    blockedReviewId: refresh.blockedReviewId,
    evidenceBundle: bundle,
    createdAt: now,
    updatedAt: now,
  };
  insertGrant(grant);
  return grant;
}

async function approveEvidenceRefresh(grant: QcRecoveryGrant): Promise<QcRecoveryGrant> {
  if (grant.status === "approved") return grant;
  if (grant.status !== "prepared") throw new QcRecoveryError(`QC recovery grant is ${grant.status}.`, 409, grant.status);
  const refresh = evidenceRefreshFacts(grant.taskId);
  if (!refresh || refresh.blockers.length > 0 || !grant.evidenceBundle) {
    grant.status = "invalidated";
    saveGrant(grant);
    throw new QcRecoveryError(refresh?.blockers[0] ?? "This evidence refresh is no longer valid.", 409, "ineligible");
  }
  try {
    const fresh = await collectRecoveryEvidence({
      taskId: grant.taskId,
      title: refresh.task.title,
      prompt: refresh.requirements,
      workdir: refresh.task.workdir,
      projectPath: grant.projectPath,
      isolation: refresh.task.isolation,
      worktreePath: refresh.task.worktreePath,
      developerRunId: grant.developerRunId,
      developerEndedAt: refresh.developerEndedAt,
    });
    assertSameEvidence(grant.evidence, fresh);
    const stale = await recheckReviewEvidence(grant.evidenceBundle, grant.evidenceBundle.workspacePath);
    if (stale) throw new QcRecoveryEvidenceError(stale);
    const selected = selectionFrom({
      reviewerHarness: grant.reviewerHarnessId,
      reviewerModel: grant.reviewerModel,
      reviewerEffort: grant.reviewerEffort,
      reviewerMode: grant.reviewerMode,
    });
    if (selected.fingerprint !== grant.resourceFingerprint) {
      grant.status = "invalidated";
      saveGrant(grant);
      throw new QcRecoveryError("Approved execution resource changed or is unavailable. No fallback.", 409, "resource");
    }
  } catch (error) {
    if (error instanceof QcRecoveryError) throw error;
    grant.status = "invalidated";
    saveGrant(grant);
    throw new QcRecoveryError(error instanceof QcRecoveryEvidenceError ? error.message : "Implementation evidence changed.", 409, "evidence");
  }
  const now = Date.now();
  grant.status = "approved";
  grant.approvedAt = now;
  grant.approvedBy = "owner";
  grant.expiresAt = now + grant.validMinutes * 60_000;
  saveGrant(grant);
  journal(grant, "qc.recovery.approved", {
    taskId: grant.taskId,
    grantId: grant.id,
    developerRunId: grant.developerRunId,
    reviewerHarness: grant.reviewerHarnessId,
    reviewerModel: grant.reviewerModel,
    resourceFingerprint: grant.resourceFingerprint,
    maxLaunches: 1,
    expiresAt: grant.expiresAt,
  });
  return loadGrant(grant.id)!;
}

async function startEvidenceRefresh(grant: QcRecoveryGrant): Promise<{ runId: string }> {
  if (grant.launchesUsed > 0 || grant.status === "consumed") {
    throw new QcRecoveryError("This QC-only grant was already used. It does not launch again.", 409, "consumed");
  }
  if (!grant.evidenceBundle || grant.evidenceBundle.status !== "complete") {
    throw new QcRecoveryError("The approved evidence bundle is incomplete. No review was started.", 409, "evidence");
  }
  const pre = verifyGrant(grant.id, false);
  if (pre) {
    if (pre.includes("expired")) grant.status = "expired";
    else if (pre.includes("changed") || pre.includes("unsupported") || pre.includes("identity")) grant.status = "invalidated";
    if (grant.status !== "approved") saveGrant(grant);
    throw new QcRecoveryError(pre, 409, "refused");
  }
  const refresh = evidenceRefreshFacts(grant.taskId);
  if (!refresh || refresh.blockers.length > 0) {
    grant.status = "invalidated";
    saveGrant(grant);
    throw new QcRecoveryError(refresh?.blockers[0] ?? "This evidence refresh is no longer valid.", 409, "ineligible");
  }
  try {
    const fresh = await collectRecoveryEvidence({
      taskId: grant.taskId,
      title: refresh.task.title,
      prompt: refresh.requirements,
      workdir: refresh.task.workdir,
      projectPath: grant.projectPath,
      isolation: refresh.task.isolation,
      worktreePath: refresh.task.worktreePath,
      developerRunId: grant.developerRunId,
      developerEndedAt: refresh.developerEndedAt,
    });
    assertSameEvidence(grant.evidence, fresh);
    const stale = await recheckReviewEvidence(grant.evidenceBundle, grant.evidenceBundle.workspacePath);
    if (stale) throw new QcRecoveryEvidenceError(stale);
  } catch (error) {
    grant.status = "invalidated";
    saveGrant(grant);
    throw new QcRecoveryError(error instanceof QcRecoveryEvidenceError ? error.message : "Implementation evidence changed.", 409, "evidence");
  }
  const task = tasks.get(grant.taskId);
  if (!task || (task.column !== "blocked" && task.column !== "review")) {
    throw new QcRecoveryError("Evidence refresh starts from review or blocked. It does not start an implementation.", 409, "wrong-column");
  }
  let reviewId = grant.reviewId;
  if (reviewId) {
    const existing = taskQualityReviews.get(reviewId);
    if (!existing || existing.status === "cancelled") reviewId = null;
    else if (existing.status !== "pending") throw new QcRecoveryError("This grant already has a review.", 409, "review");
  }
  if (!reviewId) {
    try {
      reviewId = prepareQcReview({
        taskId: grant.taskId,
        reviewerHarness: grant.reviewerHarnessId,
        reviewerModel: grant.reviewerModel,
      }, { implementationRunId: grant.developerRunId, allowColumns: ["blocked", "review"] }).review.id;
    } catch (error) {
      if (error instanceof QcError) throw new QcRecoveryError(error.message, error.status, error.code);
      throw error;
    }
  }
  const started = await startQcReview(reviewId, undefined, {
    mode: grant.reviewerMode,
    effort: grant.reviewerEffort,
    allowColumns: ["blocked", "review"],
    evidenceNote: [
      "QC-only evidence refresh of the original Developer run.",
      `Developer run: ${grant.developerRunId}`,
      `Blocked review kept: ${grant.blockedReviewId ?? ""}`,
      `Reviewer permission: ${grant.reviewerMode}, sandbox ${grant.reviewerSandbox}.`,
      "This launch does not start a Developer, another task, or a paused batch.",
    ].join("\n"),
    evidenceSection: renderEvidenceForReviewer(grant.evidenceBundle),
    expectedEvidenceBundle: grant.evidenceBundle,
    verify: (committed = false) => verifyGrant(grant.id, committed),
    onRunRecorded: (runId) => noteRecoveryLaunchCommitted(grant.id, reviewId!, runId),
  });
  if ("error" in started) throw new QcRecoveryError(started.error, 409, "launch");
  const consumed = loadGrant(grant.id);
  if (consumed) {
    journal(consumed, "qc.recovery.started", {
      taskId: grant.taskId,
      grantId: grant.id,
      developerRunId: consumed.developerRunId,
      reviewerHarness: consumed.reviewerHarnessId,
      reviewerModel: consumed.reviewerModel,
      resourceFingerprint: consumed.resourceFingerprint,
      maxLaunches: 1,
      expiresAt: consumed.expiresAt ?? 0,
    });
  }
  return { runId: started.runId };
}

function rethrowTestAuthorization(error: unknown): never {
  if (error instanceof ReviewTestAuthorizationError) throw new QcRecoveryError(error.message, error.status, error.code);
  throw error;
}

function testAuthorizationFor(taskId: string, purpose: ReviewTestPurpose, mode: "refresh" | "first"): ReviewTestAuthorization | null {
  const open = openTestAuthorization(taskId);
  const latest = latestTestAuthorization(taskId);
  if (open?.purpose === purpose) return open;
  if (latest?.purpose !== purpose) return null;
  if (mode === "refresh") return latest.failureReason ? latest : null;
  return latest;
}

function blockerCode(message: string): "evidence" | "ineligible" {
  if (message.startsWith("Publish the approved")) return "ineligible";
  if (
    message.includes("no longer matches")
    || message.includes("Recorded hash")
    || message.includes("unauthorized")
    || message.includes("incomplete")
    || message.includes("unreadable")
    || message.includes("symlink")
    || message.includes("secret")
    || message.includes("escapes")
    || message.includes("Evidence")
  ) return "evidence";
  return "ineligible";
}

interface FirstReviewFacts {
  task: Task;
  developerRunId: string;
  developerEndedAt: number;
  requirements: string;
  projectPath: string;
  publicationStatus: string | null;
  structural: string[];
  publication: string[];
}

function firstReviewFacts(taskId: string): FirstReviewFacts {
  const task = tasks.get(taskId);
  if (!task) throw new QcRecoveryError("Task not found.", 404, "not-found");
  const structural: string[] = [];
  const owner = ownershipOf(task.workdir, { fresh: true });
  const projectPath = owner.kind === "owned" ? owner.projectPath : task.workdir;
  if (owner.kind !== "owned") structural.push("Task project ownership is ambiguous.");
  if (task.archivedAt != null) structural.push("Task is archived.");
  if (task.column !== "review") structural.push("First-review evidence is available only while the task is in Review.");
  if (task.pipelineParentId) structural.push("Pipeline step tasks use the pipeline review flow.");
  if (taskQualityReviews.listForTask(taskId).some((review) => review.status !== "cancelled")) {
    structural.push("A QC review already exists. First-review preparation does not invent or replace it.");
  }
  const live = isTaskRunLive(taskId) || runs.listForTask(taskId).some((run) => run.status === "running");
  if (live) structural.push("An implementation or review is still running for this task.");
  const current = task.runId ? runs.get(task.runId) : null;
  const currentOk = !!current && current.taskId === taskId && current.status === "succeeded" && !current.qcReviewId && current.endedAt != null;
  if (!current) structural.push("First review needs the current successful implementation run.");
  else if (current.status !== "succeeded" || current.qcReviewId || current.taskId !== taskId || current.endedAt == null) {
    structural.push(current.status !== "succeeded"
      ? "A failed implementation run is not eligible for first-review evidence."
      : "First review needs the current successful implementation run.");
  }
  const workflow = getWorkflowForTask(taskId);
  const batch = batchFacts(workflow?.grant.orchestratedBatchId ?? null);
  const evidenceWait = gatedEvidenceWaitAllowsTest({
    evidencePolicy: workflow?.grant.evidencePolicy,
    workflowStatus: workflow?.status,
    phase: workflow?.progress.phase,
    activeReviewId: workflow?.progress.activeReviewId,
    batchStatus: batch.status,
    implementationSettled: (workflow?.progress.completedImplementationRunIds.length ?? 0) > 0,
  });
  if (batch.status === "running" && !evidenceWait) structural.push("The batch is still running. First-review preparation does not stop or resume a batch.");
  if (workflow?.status === "active" && !evidenceWait) structural.push("An orchestrated workflow is still active. First-review preparation does not resume it.");
  let publicationStatus: string | null = null;
  const publication: string[] = [];
  if (currentOk && current) {
    const alignment = publicationAlignmentForRun(current.id);
    publicationStatus = alignment.status;
    if (alignment.blocker) publication.push(alignment.blocker);
  }
  return {
    task,
    developerRunId: currentOk && current ? current.id : "",
    developerEndedAt: currentOk && current ? current.endedAt ?? 0 : 0,
    requirements: task.prompt,
    projectPath,
    publicationStatus,
    structural,
    publication,
  };
}

async function firstReviewView(taskId: string): Promise<QcRecoveryView["firstReview"]> {
  const facts = firstReviewFacts(taskId);
  const nonCancelled = taskQualityReviews.listForTask(taskId).filter((review) => review.status !== "cancelled");
  const applicable = facts.task.column === "review" && nonCancelled.length === 0;
  let bundle: ReviewEvidenceBundle | null = null;
  let bundleReason: string | null = null;
  if (facts.structural.length === 0 && facts.developerEndedAt > 0) {
    try {
      bundle = await bundleForTask({
        task: facts.task,
        requirements: facts.requirements,
        developerRunId: facts.developerRunId,
        developerEndedAt: facts.developerEndedAt,
        projectPath: facts.projectPath,
        resourceFingerprint: null,
      });
      if (bundle.status === "blocked") bundleReason = bundle.blocker ?? "Evidence is incomplete.";
      else bundleReason = recordedSourceAlignment(facts.developerRunId, bundle);
    } catch (error) {
      bundleReason = error instanceof Error ? error.message : "Evidence could not be collected.";
    }
  }
  const blockers = [...facts.structural, ...facts.publication, ...(bundleReason ? [bundleReason] : [])];
  return {
    applicable,
    eligible: applicable && blockers.length === 0 && (bundle?.status === "preview" || bundle?.status === "complete"),
    blockers,
    developerRunId: facts.developerRunId || null,
    publicationStatus: facts.publicationStatus,
    bundle,
    bundleReason,
    testAuthorization: testAuthorizationFor(taskId, "first-review", "first"),
  };
}

async function evidenceRefreshBundle(taskId: string): Promise<{ bundle: ReviewEvidenceBundle; developerRunId: string }> {
  const refresh = evidenceRefreshFacts(taskId);
  if (!refresh) throw new QcRecoveryError("This task has no missing-evidence QC BLOCKED review.", 409, "ineligible");
  if (refresh.blockers.length > 0) throw new QcRecoveryError(refresh.blockers[0]!, 409, "ineligible");
  const bundle = await bundleForTask({
    task: refresh.task,
    requirements: refresh.requirements,
    developerRunId: refresh.developerRunId,
    developerEndedAt: refresh.developerEndedAt,
    projectPath: refresh.projectPath,
    resourceFingerprint: null,
  });
  return { bundle, developerRunId: refresh.developerRunId };
}

async function firstReviewBundle(taskId: string): Promise<{ bundle: ReviewEvidenceBundle; developerRunId: string }> {
  const facts = firstReviewFacts(taskId);
  const first = facts.structural[0] ?? facts.publication[0];
  if (first) throw new QcRecoveryError(first, 409, blockerCode(first));
  const bundle = await bundleForTask({
    task: facts.task,
    requirements: facts.requirements,
    developerRunId: facts.developerRunId,
    developerEndedAt: facts.developerEndedAt,
    projectPath: facts.projectPath,
    resourceFingerprint: null,
  });
  const hash = bundle.status === "blocked" ? (bundle.blocker ?? "Evidence is incomplete.") : recordedSourceAlignment(facts.developerRunId, bundle);
  if (hash || bundle.status === "blocked") throw new QcRecoveryError(hash ?? "Evidence is incomplete.", 409, "evidence");
  return { bundle, developerRunId: facts.developerRunId };
}

function requestedPurpose(value: unknown): ReviewTestPurpose | undefined {
  if (value == null || value === "") return undefined;
  if (value === "first-review" || value === "evidence-refresh") return value;
  throw new QcRecoveryError("Test authorization purpose must be first-review or evidence-refresh.", 400, "invalid");
}

async function currentEvidenceBundle(taskId: string, purpose: ReviewTestPurpose | undefined): Promise<{ bundle: ReviewEvidenceBundle; developerRunId: string; purpose: ReviewTestPurpose }> {
  if (purpose === "evidence-refresh") {
    const current = await evidenceRefreshBundle(taskId);
    return { ...current, purpose: "evidence-refresh" };
  }
  if (purpose === "first-review") {
    const current = await firstReviewBundle(taskId);
    return { ...current, purpose: "first-review" };
  }
  if (evidenceRefreshFacts(taskId)) {
    const current = await evidenceRefreshBundle(taskId);
    return { ...current, purpose: "evidence-refresh" };
  }
  const current = await firstReviewBundle(taskId);
  return { ...current, purpose: "first-review" };
}

async function evidenceForExistingAuthorization(taskId: string, authId: string): Promise<{ bundle: ReviewEvidenceBundle; developerRunId: string; purpose: ReviewTestPurpose }> {
  const existing = requireTestAuthorization(taskId, authId);
  try {
    return await currentEvidenceBundle(taskId, existing.purpose);
  } catch (error) {
    if (error instanceof QcRecoveryError && error.code === "evidence") invalidateTestAuthorization(taskId, authId);
    throw error;
  }
}

export async function prepareReviewTestAuthorization(taskId: string, body: { acknowledgeRisk?: unknown; validMinutes?: unknown; purpose?: unknown }): Promise<ReviewTestAuthorization> {
  try {
    const current = await currentEvidenceBundle(taskId, requestedPurpose(body.purpose));
    return prepareTestAuthorization({
      bundle: current.bundle,
      developerRunId: current.developerRunId,
      purpose: current.purpose,
      acknowledgeRisk: body.acknowledgeRisk === true,
      validMinutes: body.validMinutes,
    });
  } catch (error) {
    rethrowTestAuthorization(error);
  }
}

export async function approveReviewTestAuthorization(taskId: string, authId: string): Promise<ReviewTestAuthorization> {
  try {
    const current = await evidenceForExistingAuthorization(taskId, authId);
    return approveTestAuthorization(taskId, authId, current.bundle);
  } catch (error) {
    rethrowTestAuthorization(error);
  }
}

export async function executeReviewTestAuthorization(taskId: string, authId: string): Promise<{ authorization: ReviewTestAuthorization; bundle: ReviewEvidenceBundle }> {
  try {
    const current = await evidenceForExistingAuthorization(taskId, authId);
    return await executeTestAuthorization(taskId, authId, current.bundle).then((result) => {
      void import("./queue-gates.ts").then((gates) => gates.notifyGatedTask(taskId));
      return result;
    });
  } catch (error) {
    rethrowTestAuthorization(error);
  }
}

export function cancelReviewTestAuthorization(taskId: string, authId: string): ReviewTestAuthorization {
  try {
    return cancelTestAuthorization(taskId, authId);
  } catch (error) {
    rethrowTestAuthorization(error);
  }
}
