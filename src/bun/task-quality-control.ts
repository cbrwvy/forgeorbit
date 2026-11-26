import { objectiveAcceptanceBlock, objectiveTaskIsManaged, objectiveTaskOperation } from "./orchestration/objective-mission.ts";
/**
 * Supervised quality control orchestration (FO-QC01).
 *
 * Review runs use the existing task runtime (`startTask`) with a one-shot
 * prompt override and a linked `task_quality_reviews` row. Verdicts are parsed
 * from structured assistant output — never from free-form Owner text alone.
 */
import { providerRefusalsForRuns } from "./provider-refusals.ts";
import { readFileSync, writeFileSync } from "node:fs";
import { workflowResourceBlock } from "./orchestrated-resources.ts";
import { noteOrchestratedLaunchCommitted } from "./pm-orchestrated-workflow.ts";
import { supplementalCoveringRecordedLaunch, supplementalRecoveryAuthIfNeeded } from "./pm-provider-recovery.ts";
import { effectiveLaunchesRemaining } from "../shared/pm-provider-recovery.ts";
import { db } from "./db.ts";
import { randomUUID } from "node:crypto";
import type { Task, AgentProfileSnapshot } from "../shared/types.ts";
import {
  FAKE_QC_REVIEW_PROMPT_MARKER,
  FAKE_QC_SUMMARY_PROMPT_MARKER,
  QC_LIMITS,
  type QcReviewEvidenceState,
  type TaskQcReview,
  type TaskQcState,
  parseQcState,
  canOwnerApproveDone,
  qcExtensionEligibility,
  withExtensionOutcome,
  EMPTY_QC_STATE,
} from "../shared/task-quality-control.ts";
import { ActivityJournalCore } from "./activity-journal-core.ts";
import { buildQcReviewPrompt } from "../shared/qc-review-prompt.ts";
import { readOnlyReviewerContract } from "../shared/qc-recovery.ts";
import { renderEvidenceForReviewer, renderEvidenceLimitation, type ReviewEvidenceBundle } from "../shared/review-evidence.ts";
import { buildImplementationEvidence, describeMissingEvidence } from "./implementation-evidence.ts";
import { recheckReviewEvidence, recordedSourceAlignment } from "./review-evidence.ts";
import { getTaskWorkspace, publicationAlignmentForRun } from "./task-workspace.ts";
import { snapshotProjectRules } from "../shared/project-rules.ts";
import { harnesses, projectRules, projects, runs, taskQualityReviews, tasks } from "./db.ts";
import { ownershipOf } from "./project-ownership.ts";
import { checkProjectLaunchAdmission } from "./project-lifecycle.ts";
import { loadEffectiveKnowledgeForProject } from "./knowledge-effective.ts";
import { moveTaskColumn, startTask } from "./orchestrator.ts";
import {
  authorizeSupervisedLaunch,
  buildQcReviewOperation,
  discardUnconsumedLaunchTicket,
  isProductionOwnerGateActive,
} from "./owner-trust/launch-gate.ts";
import { runTerminations } from "./run-terminations.ts";
import { supervisedRunLimitSeconds } from "./supervised-run-limit.ts";
import { getTaskDiff } from "./worktree.ts";

export class QcError extends Error {
  constructor(message: string, readonly status = 400, readonly code = "invalid") {
    super(message);
    this.name = "QcError";
  }
}

interface SavedTaskConfig {
  prompt: string;
  agent: string;
  model: string;
  effort: string | null;
  mode: string;
  fast: boolean;
  maxMode: boolean;
  agentProfileId: string | null;
  agentProfile: AgentProfileSnapshot | null;
}

function saveConfig(task: Task): SavedTaskConfig {
  return {
    prompt: task.prompt,
    agent: task.agent,
    model: task.model ?? "",
    effort: task.effort,
    mode: task.mode ?? "auto",
    fast: task.fast,
    maxMode: task.maxMode,
    agentProfileId: task.agentProfileId ?? null,
    agentProfile: task.agentProfile ?? null,
  };
}

function restoreConfig(taskId: string, saved: SavedTaskConfig): void {
  tasks.update(taskId, {
    prompt: saved.prompt,
    agent: saved.agent,
    model: saved.model,
    effort: saved.effort,
    mode: saved.mode,
    fast: saved.fast,
    maxMode: saved.maxMode,
  });
  tasks.setAgentProfile(taskId, saved.agentProfileId, saved.agentProfile);
}

function writeQcState(taskId: string, state: TaskQcState): void {
  tasks.setQcState(taskId, state);
}

function activeReviewForTask(taskId: string): TaskQcReview | null {
  return taskQualityReviews.getActive(taskId);
}

export function getTaskQcBundle(taskId: string): { state: TaskQcState; reviews: TaskQcReview[]; timeLimitSeconds: number | null } {
  const task = tasks.get(taskId);
  if (!task) throw new QcError("Task not found.", 404, "not-found");
  const reviews = taskQualityReviews.listForTask(taskId);
  // Read-only provider observation of each Reviewer's own run. It changes no verdict, round or Done rule.
  const runIds = reviews.flatMap((review) => (review.reviewRunId ? [review.reviewRunId] : []));
  const refusals = providerRefusalsForRuns(runIds);
  // Read-only: what a Stop or a time limit did to the Reviewer's own run, when one applied.
  const terminations = runTerminations.forRuns(runIds);
  // Which attempt each round reviewed, and whether a later implementation run exists (then the verdict is old evidence).
  const attempts = runs.listForTask(taskId).filter((run) => !run.qcReviewId).map((run) => run.id).reverse();
  const latestAttempt = attempts.at(-1) ?? null;
  return {
    state: task.qcState ?? { ...EMPTY_QC_STATE },
    // The opt-in limit a review the Owner starts would run under (null: none).
    timeLimitSeconds: supervisedRunLimitSeconds(),
    reviews: reviews.map((review) => {
      const termination = review.reviewRunId ? terminations.get(review.reviewRunId) : undefined;
      const attempt = review.implementationRunId ? attempts.indexOf(review.implementationRunId) + 1 : 0;
      const labelled = {
        ...review,
        implementationAttempt: attempt > 0 ? attempt : null,
        coversLatestOutput: !!review.implementationRunId && review.implementationRunId === latestAttempt,
      };
      const base = termination ? { ...labelled, reviewRunTermination: termination } : labelled;
      return review.reviewRunId && refusals.has(review.reviewRunId) ? { ...base, providerRefusal: refusals.get(review.reviewRunId)! } : base;
    }),
  };
}

export function recommendQcReviewers(projectPath: string): { roleSlug: string; label: string }[] {
  return [
    { roleSlug: "engineering-code-reviewer", label: "Code Reviewer" },
    { roleSlug: "design-ui-finish-gate-reviewer", label: "UI finish gate reviewer" },
    { roleSlug: "testing-reality-checker", label: "Reality checker" },
  ].filter(() => projects.get(projectPath) != null);
}

/** The fixture reviewer's summary for the verdict token just consumed (verdict file line `TOKEN|summary`). */
let fakeQcSummary: string | null = null;

function fakeQcVerdictToken(): string | null {
  fakeQcSummary = null;
  if (process.env.AGETOR_CLAUDE_DRIVER !== "fake" && process.env.AGETOR_CODEX_DRIVER !== "fake") return null;
  const file = process.env.AGETOR_FAKE_QC_VERDICT_FILE;
  if (file) {
    try {
      const text = readFileSync(file, "utf8").trim();
      const lines = text.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
      const [token, ...summaryParts] = (lines[0] ?? "").split("|");
      if (summaryParts.length > 0) fakeQcSummary = summaryParts.join("|").trim().slice(0, 300) || null;
      if (token === "PASS" || token === "CHANGES_REQUESTED" || token === "BLOCKED" || token === "MODEL_NOT_FOUND" || token === "USAGE_LIMIT") {
        if (lines.length > 1) writeFileSync(file, `${lines.slice(1).join("\n")}\n`);
        return token;
      }
    } catch {
      // Fall through to the process env used by in-process tests.
    }
  }
  return process.env.AGETOR_FAKE_QC_VERDICT ?? "PASS";
}

export function prepareQcReview(body: {
  taskId?: unknown;
  reviewerHarness?: unknown;
  reviewerModel?: unknown;
  reviewerEmployeeId?: unknown;
  reviewerRoleSlug?: unknown;
}, opts?: { implementationRunId?: string; allowColumns?: Array<"review" | "blocked">; objectiveMission?: true }): { review: TaskQcReview; promptPreview: string; blockedReason: string | null } {
  const taskId = typeof body.taskId === "string" ? body.taskId : "";
  const task = tasks.get(taskId);
  if (!task) throw new QcError("Task not found.", 404, "not-found");
  if (objectiveTaskIsManaged(taskId) && !opts?.objectiveMission) {
    throw new QcError("The mission prepares the independent review for this task.", 409, "mission-review");
  }
  if (task.archivedAt != null) throw new QcError("Task is archived.", 409, "archived");
  if (task.pipelineParentId) throw new QcError("Pipeline step tasks use the pipeline review flow.", 409, "pipeline-step");
  const allowColumns = opts?.allowColumns ?? ["review"];
  if (!allowColumns.includes(task.column as "review" | "blocked")) throw new QcError("Move the task to Review after implementation succeeds.", 409, "wrong-column");
  if (activeReviewForTask(taskId)) throw new QcError("A quality review is already in progress.", 409, "active-review");

  const owner = ownershipOf(task.workdir, { fresh: true });
  if (owner.kind !== "owned") throw new QcError("Task project ownership is ambiguous.", 409, "ownership");
  const projectPath = owner.projectPath;
  const lifecycle = checkProjectLaunchAdmission(projectPath);
  if (!lifecycle.allowed) throw new QcError(lifecycle.reason!, 409, "project-lifecycle");
  const state = task.qcState ?? { ...EMPTY_QC_STATE };
  const usedRound = taskQualityReviews.listForTask(taskId).reduce((max, review) => Math.max(max, review.round), 0);
  const round = Math.max(state.roundCount, usedRound) + 1;
  // The base limit, plus one round while the Owner's single extension exists (and is not yet consumed).
  if (round > state.maxRounds) {
    throw new QcError(`Maximum ${state.maxRounds} review rounds reached.`, 409, "max-rounds");
  }
  const extraRound = round > QC_LIMITS.maxRounds;
  if (extraRound && (!state.extension || state.extension.reviewId)) {
    throw new QcError(`Maximum ${QC_LIMITS.maxRounds} review rounds reached.`, 409, "max-rounds");
  }

  const harnessId = typeof body.reviewerHarness === "string" ? body.reviewerHarness.trim() : "";
  const model = typeof body.reviewerModel === "string" ? body.reviewerModel.trim() : "";
  if (!harnessId || !model) throw new QcError("reviewerHarness and reviewerModel are required.", 400, "invalid");
  if (!harnesses.getByIdOrKind(harnessId)) throw new QcError(`Unknown harness "${harnessId}".`, 400, "invalid");

  const implRun = runs.get(opts?.implementationRunId ?? task.runId ?? "");
  if (!implRun || implRun.taskId !== taskId || implRun.status !== "succeeded" || implRun.qcReviewId) {
    throw new QcError("Quality review requires a succeeded implementation run.", 409, "no-implementation");
  }

  // The additional round reviews NEW output only: an implementation attempt that started after the Owner authorized
  // it and that no earlier round reviewed. A review of the old output is refused, and nothing is started here.
  if (extraRound) {
    const reviewedBefore = taskQualityReviews.listForTask(taskId).some((review) => review.implementationRunId === implRun.id);
    if (reviewedBefore || implRun.startedAt < (state.extension?.authorizedAt ?? Number.MAX_SAFE_INTEGER)) {
      throw new QcError(
        "The additional review round needs a new implementation attempt after the Owner's authorization. The latest output was already reviewed or predates it.",
        409,
        "extension-needs-new-output",
      );
    }
  }

  const saved = saveConfig(task);
  const reviewId = randomUUID();
  const now = Date.now();
  const review = taskQualityReviews.insert({
    id: reviewId,
    taskId,
    projectPath,
    round,
    status: "pending",
    findings: [],
    reviewerEmployeeId: typeof body.reviewerEmployeeId === "string" ? body.reviewerEmployeeId : null,
    reviewerRoleSlug: typeof body.reviewerRoleSlug === "string" ? body.reviewerRoleSlug : null,
    reviewerHarness: harnessId,
    reviewerModel: model,
    reviewerProfileId: null,
    implementationRunId: implRun.id,
    savedTaskJson: JSON.stringify(saved),
    requestedAt: now,
  });

  writeQcState(taskId, {
    ...state,
    activeReviewId: reviewId,
    awaitingOwnerApproval: false,
    // The extension is spent by the review it enables, in the same step that records that review.
    extension: extraRound && state.extension ? { ...state.extension, reviewId } : state.extension,
  });
  if (extraRound) {
    journalExtension(taskId, projectPath, "qc.extension.used", { taskId, reviewId, round, implementationRunId: implRun.id }, "used");
  }

  const prior = taskQualityReviews.listForTask(taskId).filter((r) => r.status === "complete");
  const rulesSnap = snapshotProjectRules(projectPath, projectRules.list(projectPath));
  const promptPreview = buildQcReviewPrompt({
    taskTitle: task.title,
    taskPrompt: task.prompt,
    priorFeedback: state.latestVerdict === "CHANGES_REQUESTED" ? prior.at(-1)?.feedback ?? null : null,
    priorRounds: prior,
    projectRules: rulesSnap.rules.length > 0 ? rulesSnap : null,
    diffSummary: null,
    artifactsNote: "Use the task run transcript and repository diff in the worktree.",
  });

  return { review, promptPreview, blockedReason: null };
}

interface OrdinaryEvidenceCheck {
  section: string;
  evidenceState: QcReviewEvidenceState;
  bundle: ReviewEvidenceBundle | null;
  blocker: string | null;
  howToSupply: string | null;
}

async function evaluateOrdinaryEvidence(
  task: Task,
  requirements: string,
  developerRunId: string,
): Promise<OrdinaryEvidenceCheck> {
  const run = runs.get(developerRunId);
  if (!run?.endedAt) {
    const blocker = "The Developer run has no workspace or finish time, so file contents were not attached.";
    return {
      section: renderEvidenceLimitation(blocker),
      evidenceState: "missing-source",
      bundle: null,
      blocker,
      howToSupply: describeMissingEvidence({ blocker, bundle: null }).howToSupply,
    };
  }
  const owner = ownershipOf(task.workdir, { fresh: true });
  if (owner.kind !== "owned") {
    const blocker = "Task project ownership is ambiguous, so evidence was not read.";
    return {
      section: renderEvidenceLimitation(blocker),
      evidenceState: "missing-source",
      bundle: null,
      blocker,
      howToSupply: describeMissingEvidence({ blocker, bundle: null }).howToSupply,
    };
  }
  try {
    const bundle = await buildImplementationEvidence({
      task,
      requirements,
      developerRunId,
      developerEndedAt: run.endedAt,
      projectPath: owner.projectPath,
      resourceFingerprint: null,
    });
    const alignmentBlocker = publicationAlignmentForRun(developerRunId).blocker
      ?? recordedSourceAlignment(developerRunId, bundle);
    if (alignmentBlocker) {
      return {
        section: renderEvidenceLimitation(alignmentBlocker),
        evidenceState: "missing-source",
        bundle,
        blocker: alignmentBlocker,
        howToSupply: describeMissingEvidence({ blocker: alignmentBlocker, bundle }).howToSupply,
      };
    }
    if (bundle.status === "complete" && bundle.test?.provenance === "forgeorbit-observed-test" && bundle.test.sourceFingerprint === bundle.sourceFingerprint) {
      return {
        section: renderEvidenceForReviewer(bundle),
        evidenceState: "complete",
        bundle,
        blocker: null,
        howToSupply: null,
      };
    }
    if (bundle.status === "preview") {
      const missing = describeMissingEvidence({ blocker: null, bundle });
      return {
        section: renderEvidenceForReviewer(bundle),
        evidenceState: "missing-test",
        bundle,
        blocker: missing.missingReason,
        howToSupply: missing.howToSupply,
      };
    }
    const reason = bundle.blocker ?? "Evidence could not be included.";
    return {
      section: renderEvidenceForReviewer(bundle),
      evidenceState: "missing-source",
      bundle,
      blocker: reason,
      howToSupply: describeMissingEvidence({ blocker: reason, bundle }).howToSupply,
    };
  } catch (error) {
    const blocker = error instanceof Error ? error.message : "Evidence could not be included.";
    return {
      section: renderEvidenceLimitation(blocker),
      evidenceState: "missing-source",
      bundle: null,
      blocker,
      howToSupply: describeMissingEvidence({ blocker, bundle: null }).howToSupply,
    };
  }
}

function taskHasEmployeeExecution(taskId: string, implementationRunId: string | null): boolean {
  const row = db.query<{ n: number }, [string, string]>(
    `SELECT 1 AS n FROM employee_executions WHERE task_id = ? OR run_id = ? LIMIT 1`,
  ).get(taskId, implementationRunId ?? "");
  return row != null;
}

function workflowRequiresObservedTest(input: {
  task: Task;
  review: TaskQcReview;
  ordinary: OrdinaryEvidenceCheck | null;
  workflowEvidencePolicy: string | null | undefined;
  hasCustomRecovery: boolean;
  ownerGateActive: boolean;
}): boolean {
  if (input.hasCustomRecovery) return false;
  if (input.workflowEvidencePolicy === "review-without-observed-test") return false;
  if (input.workflowEvidencePolicy === "observed-test") return true;
  if (!input.ownerGateActive) return false;
  const staged = getTaskWorkspace(input.task.id);
  if (staged && staged.status !== "abandoned") return true;
  if (taskHasEmployeeExecution(input.task.id, input.review.implementationRunId)) return true;
  return input.ordinary?.bundle?.proposedTest != null;
}

export async function objectiveQcEvidenceProblem(taskId: string, implementationRunId: string): Promise<string | null> {
  const task = tasks.get(taskId);
  if (!task) return "Task not found.";
  const evidence = await evaluateOrdinaryEvidence(task, task.prompt, implementationRunId);
  return evidence.evidenceState === "complete" && !evidence.blocker ? null :
    evidence.blocker ?? evidence.howToSupply ?? "The recorded offline test is required before review.";
}

const startingQcReviewIds = new Set<string>();

export async function startQcReview(reviewId: string, orchestratedWorkflowId?: string, recovery?: {
  mode: string;
  effort: string | null;
  allowColumns: Array<"review" | "blocked">;
  evidenceNote: string;
  requireOrdinaryEvidence?: boolean;
  objectiveMission?: true;
  evidenceSection?: string | null;
  expectedEvidenceBundle?: ReviewEvidenceBundle | null;
  verify: (committed?: boolean) => string | null;
  onRunRecorded: (runId: string) => void;
}, ownerOptions?: { ownerProof?: unknown; locale?: "en" | "ru"; recoveryGrantId?: string; handsoffLaunch?: import("./owner-trust/launch-gate.ts").ProjectGrantClaim }): Promise<{ runId: string } | { error: string; code?: string }> {
  if (startingQcReviewIds.has(reviewId)) {
    throw new QcError("This QC review is already starting.", 409, "already-starting");
  }
  startingQcReviewIds.add(reviewId);
  let ownerLaunchGrantId: string | undefined;
  try {
  const review = taskQualityReviews.get(reviewId);
  if (!review) throw new QcError("Review not found.", 404, "not-found");
  if (objectiveTaskIsManaged(review.taskId) && (!recovery?.objectiveMission || !objectiveTaskOperation(review.taskId, reviewId))) {
    throw new QcError("Confirm this review from the mission.", 409, "mission-review");
  }
  if (review.status !== "pending") throw new QcError("Review is not pending.", 409, "not-pending");
  const lifecycle = checkProjectLaunchAdmission(review.projectPath);
  if (!lifecycle.allowed) return { error: lifecycle.reason! };

  const task = tasks.get(review.taskId);
  if (!task) throw new QcError("Task not found.", 404, "not-found");
  const allowColumns = recovery?.allowColumns ?? ["review"];
  if (!allowColumns.includes(task.column as "review" | "blocked")) throw new QcError("Task must stay in Review to start a QC run.", 409, "wrong-column");

  let saved: SavedTaskConfig;
  try {
    saved = JSON.parse(review.savedTaskJson) as SavedTaskConfig;
  } catch {
    throw new QcError("Corrupt review record.", 500, "corrupt");
  }

  const prior = taskQualityReviews.listForTask(review.taskId).filter((r) => r.status === "complete" && r.id !== reviewId);
  const rulesSnap = snapshotProjectRules(review.projectPath, projectRules.list(review.projectPath));
  const knowledgeBundle = await loadEffectiveKnowledgeForProject(review.projectPath);
  let diffSummary: string | null = null;
  try {
    const diff = await getTaskDiff(task);
    if (diff.files.length > 0) {
      diffSummary = diff.files.slice(0, 40).map((f) => `${f.status} ${f.path}`).join("\n");
    }
  } catch {
    diffSummary = null;
  }

  const ordinary = recovery && Object.hasOwn(recovery, "evidenceSection")
    ? null
    : await evaluateOrdinaryEvidence(task, saved.prompt, review.implementationRunId ?? "");
  const verdictToken = fakeQcVerdictToken();
  const launchPrompt = buildQcReviewPrompt({
    taskTitle: task.title,
    taskPrompt: saved.prompt,
    priorFeedback: prior.at(-1)?.feedback ?? null,
    priorRounds: prior,
    projectRules: rulesSnap.rules.length > 0 ? rulesSnap : null,
    knowledgeSnapshot: knowledgeBundle?.snapshot ?? null,
    knowledgeBodies: knowledgeBundle?.preview.documents,
    diffSummary,
    artifactsNote: recovery?.evidenceNote ?? "The review evidence bundle is authoritative. Do not use a shell. Do not deploy or push.",
    evidenceSection: recovery && Object.hasOwn(recovery, "evidenceSection")
      ? (recovery.evidenceSection ?? null)
      : ordinary!.section,
  })
    + (verdictToken ? `\n\n${FAKE_QC_REVIEW_PROMPT_MARKER}:${verdictToken}` : "")
    + (verdictToken && fakeQcSummary ? `\n${FAKE_QC_SUMMARY_PROMPT_MARKER}:${encodeURIComponent(fakeQcSummary)}` : "");

  const workflow = orchestratedWorkflowId ? (await import("./pm-orchestrated-workflow.ts")).getWorkflow(orchestratedWorkflowId) : null;
  const verify = (committed = false) => {
    if (!orchestratedWorkflowId) return null;
    // Read the durable grant again at each existing runtime gate.
    const row = db.query<{status: string; grant_json: string; data_json: string}, [string]>("SELECT status, grant_json, data_json FROM pm_orchestrated_workflows WHERE id = ?").get(orchestratedWorkflowId);
    if (!row || row.status !== "active") return "Orchestrated grant is not active.";
    const g = JSON.parse(row.grant_json), data = JSON.parse(row.data_json);
    if (g.taskId !== review.taskId || g.projectPath !== review.projectPath || g.reviewerHarness !== review.reviewerHarness || g.reviewerModel !== review.reviewerModel || (g.reviewerEmployeeId ?? null) !== review.reviewerEmployeeId) return "Reviewer differs from the approved grant.";
    if (g.expiresAt != null && Date.now() >= g.expiresAt) return "Grant expired.";
    const counters = data.counters ?? { launchesUsed: 0, implementationRuns: 0, reviewRuns: 0, reworkCount: 0 };
    // authorizeSubmission runs after onRunRecorded has already counted this
    // launch. Judge the budget as it was before that increment, including a
    // supplemental slot this same launch just consumed.
    const budgetCounters = committed
      ? { ...counters, launchesUsed: Math.max(0, Number(counters.launchesUsed ?? 0) - 1) }
      : counters;
    let supplemental = supplementalRecoveryAuthIfNeeded(review.taskId, g, budgetCounters);
    if (committed && !supplemental && effectiveLaunchesRemaining(g, budgetCounters, null) <= 0) {
      supplemental = supplementalCoveringRecordedLaunch(review.taskId);
    }
    const remaining = effectiveLaunchesRemaining(g, budgetCounters, supplemental);
    if (remaining <= 0) return "Launch limit reached.";
    return workflowResourceBlock(g, true);
  };
  const blocked = (recovery?.verify ?? verify)();
  if (blocked) return { error: blocked };

  const ownerGate = isProductionOwnerGateActive() || ownerOptions?.ownerProof !== undefined;
  const needsObservedTest = recovery?.requireOrdinaryEvidence || workflowRequiresObservedTest({
    task,
    review,
    ordinary,
    workflowEvidencePolicy: workflow?.grant.evidencePolicy,
    hasCustomRecovery: recovery != null,
    ownerGateActive: ownerGate,
  });
  if (needsObservedTest && (!ordinary || ordinary.evidenceState !== "complete" || !ordinary.bundle || ordinary.blocker)) {
    taskQualityReviews.markCancelled(reviewId, Date.now());
    closeCancelledReview(review);
    const missing = ordinary?.blocker ?? "QC evidence is incomplete.";
    const supply = ordinary?.howToSupply ?? "Run the approved offline test for the current source fingerprint first.";
    return { error: `${missing} ${supply}`, code: "incomplete-evidence" };
  }
  // An ordinary review (no recovery grant, no frozen workflow mode) used to
  // inherit the Developer's mode, so a Codex Reviewer ran `--sandbox
  // workspace-write` with the project folder writable. A Codex Reviewer is
  // read-only (`ask`); `savedTaskJson` restores the Developer's mode at settle.
  const reviewerContract = readOnlyReviewerContract(harnesses.getByIdOrKind(review.reviewerHarness)?.kind ?? "");
  const ordinaryReviewerMode = !recovery && !workflow?.grant.execution && harnesses.getByIdOrKind(review.reviewerHarness)?.kind === "codex"
    ? reviewerContract!.mode
    : null;
  const effectiveReviewerMode = recovery
    ? recovery.mode
    : workflow?.grant.execution
      ? workflow.grant.execution.reviewerMode
      : (ordinaryReviewerMode ?? reviewerContract?.mode ?? task.mode);
  const effectiveReviewerEffort = recovery ? recovery.effort : task.effort;

  if (ownerGate) {
    const built = buildQcReviewOperation({
      review,
      task,
      projectPath: review.projectPath,
      harnessId: review.reviewerHarness,
      modelId: review.reviewerModel,
      mode: effectiveReviewerMode ?? reviewerContract?.mode ?? "ask",
      effort: effectiveReviewerEffort,
      recoveryGrantId: ownerOptions?.recoveryGrantId ?? null,
    });
    if (!built.ok) {
      taskQualityReviews.markCancelled(reviewId, Date.now());
      closeCancelledReview(review);
      return { error: built.reason };
    }
    const auth = await authorizeSupervisedLaunch({
      built: built.built,
      proofOverride: ownerOptions?.ownerProof,
      locale: ownerOptions?.locale ?? "en",
      ...(ownerOptions?.handsoffLaunch ? { projectGrant: ownerOptions.handsoffLaunch } : {}),
    });
    if (!auth.ok) {
      taskQualityReviews.markCancelled(reviewId, Date.now());
      closeCancelledReview(review);
      return { error: auth.reason, code: auth.code };
    }
    ownerLaunchGrantId = auth.grantId;
  }

  // Revalidate evidence right before spawning so any source change made before
  // or during macOS authorization invalidates old test results and approvals.
  if (needsObservedTest && ordinary?.bundle) {
    const stale = await recheckReviewEvidence(ordinary.bundle, ordinary.bundle.workspacePath);
    const fresh = await evaluateOrdinaryEvidence(task, saved.prompt, review.implementationRunId ?? "");
    if (
      stale
      || fresh.evidenceState !== "complete"
      || !fresh.bundle
      || fresh.blocker != null
      || fresh.bundle.sourceFingerprint !== ordinary.bundle.sourceFingerprint
      || fresh.bundle.digest !== ordinary.bundle.digest
      || fresh.bundle.test?.sourceFingerprint !== fresh.bundle.sourceFingerprint
    ) {
      taskQualityReviews.markCancelled(reviewId, Date.now());
      closeCancelledReview(review);
      return {
        error: stale ?? fresh.blocker ?? "Source or test files changed after evidence check or launch approval. The earlier test observation and approval cannot be reused.",
        code: "evidence-stale",
      };
    }
  } else if (recovery?.expectedEvidenceBundle) {
    const expected = recovery.expectedEvidenceBundle;
    const stale = await recheckReviewEvidence(expected, expected.workspacePath);
    const fresh = await evaluateOrdinaryEvidence(task, saved.prompt, review.implementationRunId ?? "");
    if (
      stale
      || fresh.evidenceState !== "complete"
      || !fresh.bundle
      || fresh.bundle.sourceFingerprint !== expected.sourceFingerprint
      || fresh.bundle.digest !== expected.digest
    ) {
      taskQualityReviews.markCancelled(reviewId, Date.now());
      closeCancelledReview(review);
      return {
        error: stale ?? fresh.blocker ?? "Source or test files changed after evidence refresh approval. The earlier test observation and approval cannot be reused.",
        code: "evidence-stale",
      };
    }
  }

  const resolvedEvidenceState: QcReviewEvidenceState | null = ordinary
    ? ordinary.evidenceState
    : recovery?.expectedEvidenceBundle?.status === "complete"
      ? "complete"
      : null;
  if (resolvedEvidenceState) {
    taskQualityReviews.setEvidenceState(reviewId, resolvedEvidenceState);
  }

  tasks.update(review.taskId, {
    ...(recovery
      ? { mode: recovery.mode, effort: recovery.effort }
      : workflow?.grant.execution ? { mode: workflow.grant.execution.reviewerMode }
      : ordinaryReviewerMode ? { mode: ordinaryReviewerMode } : {}),
    agent: review.reviewerHarness,
    model: review.reviewerModel,
  });
  tasks.setAgentProfile(review.taskId, null, null);

  taskQualityReviews.markRunning(reviewId, Date.now());

  let started: Awaited<ReturnType<typeof startTask>>;
  try {
    started = await startTask(review.taskId, {
      launchPromptOverride: launchPrompt,
      qcReviewId: reviewId,
      ...(ownerLaunchGrantId ? { ownerLaunchGrantId } : {}),
      // An Owner-started review is supervised; one started by an orchestrated workflow is not.
      supervisedRun: !orchestratedWorkflowId,
      verifyBeforeRun: () => (recovery?.verify ?? verify)(),
      authorizeSubmission: () => (recovery?.verify ?? verify)(true) === null,
      onRunRecorded: (runId) => {
        recovery?.onRunRecorded(runId);
        if (orchestratedWorkflowId && workflow) noteOrchestratedLaunchCommitted(workflow, "review", runId);
      },
    });
  } catch (error) {
    restoreConfig(review.taskId, saved);
    taskQualityReviews.markCancelled(reviewId, Date.now());
    closeCancelledReview(review);
    return { error: error instanceof Error ? error.message : "Review launch failed." };
  }

  if ("error" in started) {
    restoreConfig(review.taskId, saved);
    taskQualityReviews.markCancelled(reviewId, Date.now());
    closeCancelledReview(review);
    return { error: started.error };
  }

  taskQualityReviews.linkReviewRun(reviewId, started.runId);
  return { runId: started.runId };
  } finally {
    discardUnconsumedLaunchTicket(ownerLaunchGrantId);
    startingQcReviewIds.delete(reviewId);
  }
}

function assistantTextForRun(runId: string): string {
  const events = runs.events(runId);
  const chunks: string[] = [];
  for (const e of events) {
    if (e.stream === "assistant") chunks.push(e.data);
  }
  return chunks.join("\n");
}

/**
 * A review that never produced a verdict (cancelled before it ran, or its launch failed) clears the active marker.
 * For the additional round the round number is spent (UNIQUE per task and round) and so is the Owner's single
 * extension: the task goes back to Blocked, with the rounds shown as used, and no second extension is offered.
 */
function closeCancelledReview(review: TaskQcReview): void {
  const state = parseQcState(tasks.get(review.taskId)?.qcState ?? null);
  if (review.round > QC_LIMITS.maxRounds) {
    writeQcState(review.taskId, withExtensionOutcome({ ...state, activeReviewId: null, awaitingOwnerApproval: false, roundCount: Math.max(state.roundCount, review.round) }, review.id, "none"));
    const current = tasks.get(review.taskId);
    if (current && current.column !== "blocked" && current.column !== "done") moveTaskColumn(review.taskId, "blocked");
    return;
  }
  writeQcState(review.taskId, { ...state, activeReviewId: null });
}

/** A mission restart may leave QC marked running before its worker started or after it was orphaned. */
export function reconcileInterruptedObjectiveReview(reviewId: string): void {
  const review = taskQualityReviews.get(reviewId);
  if (review?.status !== "running" || startingQcReviewIds.has(reviewId)) return;
  const recorded = runs.listForTask(review.taskId).find(run => run.qcReviewId === review.id);
  if (recorded?.status === "running" || recorded?.status === "succeeded") return;
  restoreConfig(review.taskId, JSON.parse(review.savedTaskJson) as SavedTaskConfig);
  taskQualityReviews.markCancelled(reviewId, Date.now());
  closeCancelledReview(review);
}

function journalExtension(
  taskId: string,
  projectPath: string,
  eventType: "qc.extension.authorized" | "qc.extension.used",
  payload: Record<string, string | number>,
  key: string,
): void {
  new ActivityJournalCore(db).record({
    eventType,
    projectPath,
    actorType: "owner",
    actorId: "owner",
    targetType: "task",
    targetId: taskId,
    taskId,
    idempotencyKey: `qc-extension:${taskId}:${key}`,
    payload,
  });
}

/**
 * The Owner's one explicit authorization of ONE additional review round, after every round is used without a PASS.
 * It starts nothing, runs no test, publishes nothing and does not approve any output: it only lets one more review be
 * prepared for new implementation output. Synchronous end to end (no await between the check and the write), so a
 * duplicate click or a concurrent request cannot mint a second extension; a repeat of an unused one is a replay.
 */
export function authorizeQcExtension(taskId: string, body: { confirm?: unknown; expectedRound?: unknown }): { state: TaskQcState; replayed: boolean } {
  if (body.confirm !== true) throw new QcError("Confirm the additional review round.", 400, "confirmation");
  const task = tasks.get(taskId);
  if (!task) throw new QcError("Task not found.", 404, "not-found");
  if (task.archivedAt != null) throw new QcError("Task is archived.", 409, "archived");
  if (task.pipelineParentId) throw new QcError("Pipeline step tasks use the pipeline review flow.", 409, "pipeline-step");
  const owner = ownershipOf(task.workdir, { fresh: true });
  if (owner.kind !== "owned") throw new QcError("Task project ownership is ambiguous.", 409, "ownership");
  return db.transaction((): { state: TaskQcState; replayed: boolean } => {
    const current = tasks.get(taskId);
    const state = parseQcState(current?.qcState ?? null);
    if (body.expectedRound !== undefined && body.expectedRound !== state.roundCount) {
      throw new QcError("The review rounds changed since this was shown. Reload the task.", 409, "stale");
    }
    if (state.extension && !state.extension.reviewId) return { state, replayed: true };
    const eligibility = qcExtensionEligibility(state, current!.column);
    if (!eligibility.eligible) throw new QcError(eligibility.reason ?? "Not eligible.", 409, state.extension ? "extension-used" : "ineligible");
    const next: TaskQcState = {
      ...state,
      maxRounds: QC_LIMITS.maxRounds + 1,
      extension: { authorizedAt: Date.now(), authorizedBy: "owner", baseRound: state.roundCount, baseVerdict: state.latestVerdict, reviewId: null },
    };
    writeQcState(taskId, next);
    journalExtension(taskId, owner.projectPath, "qc.extension.authorized", {
      taskId, baseRound: state.roundCount, maxRounds: next.maxRounds, previousVerdict: state.latestVerdict ?? "none",
    }, "authorized");
    return { state: next, replayed: false };
  }).immediate();
}

export function assertCanMoveTaskToDone(task: Task): string | null {
  const missionBlock = objectiveAcceptanceBlock(task);
  if (missionBlock) return missionBlock === "accept" ? "An independent Reviewer must pass this mission task before acceptance."
    : missionBlock === "publish" ? "Publish the task working copy before accepting this result." : "The approved mission output is unavailable.";
  return canOwnerApproveDone(task.qcState ?? null, task.column);
}

export function cancelPendingQcReview(reviewId: string): TaskQcReview {
  const review = taskQualityReviews.get(reviewId);
  if (!review) throw new QcError("Review not found.", 404, "not-found");
  if (review.status !== "pending") throw new QcError("Only pending reviews can be cancelled.", 409, "not-pending");
  taskQualityReviews.markCancelled(reviewId, Date.now());
  closeCancelledReview(review);
  return taskQualityReviews.get(reviewId)!;
}

/**
 * The same Done transition the Owner PATCH uses: QC gate, column update,
 * owner-approval acknowledgement, and orchestrated batch notification.
 * Callers must not write the column directly.
 */
export function acceptAuthorizedTaskDone(taskId: string): { ok: true; task: Task } | { ok: false; reason: string } {
  const before = tasks.get(taskId);
  if (!before) return { ok: false, reason: "Task not found." };
  if (before.column === "done") return { ok: true, task: before };
  const block = assertCanMoveTaskToDone(before);
  if (block) return { ok: false, reason: block };
  if (before.column !== "review" || before.qcState?.latestVerdict !== "PASS") {
    return { ok: false, reason: "Automatic completion requires a finished review column and QC PASS." };
  }
  const updated = tasks.update(taskId, { column: "done" });
  if (!updated) return { ok: false, reason: "Task not found." };
  let finalized = updated;
  if (updated.qcState?.awaitingOwnerApproval && updated.qcState.latestVerdict === "PASS") {
    acknowledgeQcOwnerReview(updated.id);
    finalized = tasks.get(updated.id) ?? updated;
  }
  if (finalized.column === "done") {
    void import("./pm-orchestrated-batch.ts").then((batch) => batch.onOrchestratedOwnerDone(finalized.id));
  }
  if (finalized.column !== "done") return { ok: false, reason: "The task did not reach Done." };
  return { ok: true, task: finalized };
}

export function acknowledgeQcOwnerReview(taskId: string): TaskQcState {
  const task = tasks.get(taskId);
  if (!task) throw new QcError("Task not found.", 404, "not-found");
  const state = parseQcState(task.qcState ?? null);
  if (!state.awaitingOwnerApproval || state.latestVerdict !== "PASS") {
    throw new QcError("No owner approval is pending for this task.", 409, "not-pending");
  }
  const next = { ...state, awaitingOwnerApproval: false };
  writeQcState(taskId, next);
  return next;
}

/**
 * The Owner returned an unaccepted QC PASS (moved it out of Review without
 * Done): the PASS no longer waits for acceptance. Only the acceptance flag is
 * cleared — the verdict, round count and review history stay as recorded, and
 * the Done gates are unchanged. A no-op unless a PASS is actually pending.
 */
export function withdrawQcOwnerAcceptance(taskId: string): boolean {
  const task = tasks.get(taskId);
  if (!task) return false;
  const state = parseQcState(task.qcState ?? null);
  if (!state.awaitingOwnerApproval || state.latestVerdict !== "PASS" || state.activeReviewId) return false;
  writeQcState(taskId, { ...state, awaitingOwnerApproval: false });
  return true;
}
