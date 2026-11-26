/**
 * QC run settlement — separated so `orchestrator.ts` can dynamic-import without a static cycle.
 */
import type { Run, AgentProfileSnapshot } from "../shared/types.ts";
import {
  parseQcState,
  withExtensionOutcome,
  parseQcVerdictFromText,
  type TaskQcState,
} from "../shared/task-quality-control.ts";
import { db, harnesses, runs, taskQualityReviews, tasks } from "./db.ts";
import { moveTaskColumn } from "./orchestrator.ts";
import { AccountCore } from "./account-core.ts";
import { selectedCodexAccount } from "./codex-profiles.ts";
import {
  classifyCodexModelRejection,
  CODEX_MODEL_REJECTION_SOURCE,
  CODEX_MODEL_REJECTION_TTL_MS,
} from "../shared/codex-model-rejection.ts";
import { recoveryGrantIdForReview } from "./qc-recovery-link.ts";
import { runTerminations } from "./run-terminations.ts";
import { stoppedReviewSummary } from "../shared/run-termination.ts";

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

function textForRun(runId: string, stream: "assistant" | "stderr"): string {
  const chunks: string[] = [];
  for (const e of runs.events(runId)) {
    if (e.stream === stream) chunks.push(e.data);
  }
  return chunks.join("\n");
}

function reviewerProcessFailure(reviewHarness: string, reviewModel: string, runId: string): string {
  const rejection = classifyCodexModelRejection(textForRun(runId, "stderr"));
  const harness = harnesses.get(reviewHarness);
  let accountLabel = reviewHarness;
  if (harness) {
    try {
      const account = selectedCodexAccount(harness);
      if (account && rejection) {
        new AccountCore(db).observeProviderModelRejection(account.id, harness.id, reviewModel, {
          source: CODEX_MODEL_REJECTION_SOURCE,
          expiresAt: Date.now() + CODEX_MODEL_REJECTION_TTL_MS,
        });
      }
      if (account) accountLabel = account.displayName;
    } catch {
      // A missing registration still leaves the provider sentence on the review.
    }
  }
  const detail = rejection?.message ?? "The review process exited before producing a verdict.";
  return `Reviewer process failed before a QC verdict. ${accountLabel} · ${reviewModel}. ${detail} Login status does not prove this model is usable on this account. No other model or account was selected.`;
}

export async function settleQcReviewRun(runId: string, runStatus: Run["status"]): Promise<void> {
  const row = db.query<{ qc_review_id: string | null }, [string]>(
    `SELECT qc_review_id FROM runs WHERE id = ?`,
  ).get(runId);
  const reviewId = row?.qc_review_id;
  if (!reviewId) return;

  const review = taskQualityReviews.get(reviewId);
  if (!review || review.status !== "running") return;

  let saved: SavedTaskConfig;
  try {
    saved = JSON.parse(review.savedTaskJson) as SavedTaskConfig;
  } catch {
    return;
  }

  const task = tasks.get(review.taskId);
  if (!task) return;

  if (runStatus !== "succeeded") {
    // A reviewer the Owner stopped, or that hit its time limit, did not fail: say so, and never invent a verdict.
    const summary = stoppedReviewSummary(runTerminations.get(runId), runStatus)
      ?? reviewerProcessFailure(review.reviewerHarness, review.reviewerModel, runId);
    taskQualityReviews.complete(reviewId, {
      verdict: null,
      summary,
      findings: [],
      feedback: null,
      completedAt: Date.now(),
      status: "complete",
    });
    restoreConfig(review.taskId, saved);
    const state = parseQcState(tasks.get(review.taskId)?.qcState ?? null);
    writeQcState(review.taskId, withExtensionOutcome({
      ...state,
      activeReviewId: null,
      awaitingOwnerApproval: false,
      latestVerdict: null,
      roundCount: Math.max(state.roundCount, review.round),
    }, reviewId, "none"));
    const recoveryId = recoveryGrantIdForReview(reviewId);
    if (recoveryId) {
      const current = tasks.get(review.taskId);
      if (current && current.column !== "blocked" && current.column !== "done") moveTaskColumn(review.taskId, "blocked");
      const { noteRecoverySettled } = await import("./qc-recovery.ts");
      noteRecoverySettled(recoveryId, null, runStatus);
      return;
    }
    if (task.runId === runId) moveTaskColumn(review.taskId, "blocked");
    const workflow = await import("./pm-orchestrated-workflow.ts");
    await workflow.onOrchestratedQcSettled(review.taskId, reviewId, null, runStatus, summary);
    return;
  }

  const parsed = parseQcVerdictFromText(textForRun(runId, "assistant"));
  const verdict = parsed.verdict ?? "BLOCKED";
  const completedAt = Date.now();

  taskQualityReviews.complete(reviewId, {
    verdict,
    summary: parsed.summary,
    findings: parsed.findings,
    feedback: parsed.feedback,
    completedAt,
    status: "complete",
  });

  restoreConfig(review.taskId, saved);

  const prevState = parseQcState(task.qcState ?? null);
  const roundCount = review.round;
  let nextColumn = task.column;
  let reworkCount = prevState.reworkCount;
  let awaitingOwnerApproval = false;

  if (verdict === "PASS") {
    nextColumn = "review";
    awaitingOwnerApproval = true;
  } else if (verdict === "CHANGES_REQUESTED") {
    // The last round that may run: rework would only loop into a refused review, so the task waits for the Owner.
    nextColumn = roundCount >= prevState.maxRounds ? "blocked" : "ready";
    reworkCount += 1;
  } else {
    nextColumn = roundCount >= prevState.maxRounds ? "blocked" : "review";
  }

  writeQcState(review.taskId, withExtensionOutcome({
    ...prevState,
    activeReviewId: null,
    awaitingOwnerApproval,
    latestVerdict: verdict,
    reworkCount,
    roundCount,
  }, reviewId, verdict));

  // Brain 2.0 automatic knowledge extraction hook
  void (async () => {
    try {
      const { ingestExtractionEvent } = await import("./brain-extractor.ts");
      await ingestExtractionEvent({
        kind: "qc_review",
        taskId: review.taskId,
        runId,
        reviewId,
        verdict: verdict === "PASS" ? "approved" : "rework",
        summary: parsed.summary || `QC review verdict: ${verdict}`,
        failurePattern: verdict !== "PASS" ? (parsed.feedback ?? parsed.summary ?? undefined) : undefined,
        projectPath: task.workdir,
        reviewedAt: completedAt,
      });
      if (prevState.reworkCount > 0 && verdict === "PASS") {
        await ingestExtractionEvent({
          kind: "rework_resolved",
          taskId: review.taskId,
          priorError: `Task required rework (${prevState.reworkCount} rounds)`,
          fixSummary: parsed.summary || `Resolved defects and passed review in round ${roundCount}`,
          projectPath: task.workdir,
          resolvedAt: completedAt,
        });
      }
    } catch {
      // nonblocking extraction
    }
  })();

  if (task.runId === runId && task.column !== nextColumn) {
    moveTaskColumn(review.taskId, nextColumn);
  }

  const recoveryId = recoveryGrantIdForReview(reviewId);
  if (recoveryId) {
    const { noteRecoverySettled } = await import("./qc-recovery.ts");
    noteRecoverySettled(recoveryId, verdict, runStatus);
    return;
  }

  void import("./pm-orchestrated-workflow.ts").then((m) =>
    m.onOrchestratedQcSettled(review.taskId, reviewId, verdict, runStatus),
  );
}
