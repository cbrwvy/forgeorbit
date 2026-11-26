/**
 * FO-AUTO03 fact gathering for one gated workflow tick.
 * Evidence preview reads stored files and observations. It does not spawn a
 * test, a Developer, or a Reviewer.
 */
import { buildImplementationEvidence } from "./implementation-evidence.ts";
import { db, runs } from "./db.ts";
import { getTaskWorkspace, publicationAlignmentForRun } from "./task-workspace.ts";
import type { ReviewTestAuthorization } from "../shared/review-evidence.ts";
import {
  evaluateQueueStep,
  isGatedPolicy,
  type QueuePhaseGrantInput,
  type QueueStepFacts,
} from "../shared/queue-gates.ts";
import type { OrchestratedWorkflowGrant } from "../shared/pm-orchestrated-workflow.ts";
import type { Task } from "../shared/types.ts";

export interface QueueFactInput {
  grant: OrchestratedWorkflowGrant;
  batchStatus: string;
  task: Task;
  live: boolean;
  implementation: { id: string; status: string } | null;
  grants: QueuePhaseGrantInput[];
  now: number;
}

function pickGrant(grants: QueuePhaseGrantInput[], phase: "developer" | "reviewer", taskId: string, runId: string | null): QueuePhaseGrantInput | null {
  const matches = grants.filter((grant) => grant.phase === phase && grant.taskId === taskId && (phase === "developer" || grant.implementationRunId === runId));
  return matches.find((grant) => grant.status === "active") ?? matches.at(-1) ?? null;
}

export function readBatchGateState(batchId: string): { status: string; grants: QueuePhaseGrantInput[] } | null {
  const row = db.query<{ status: string; data_json: string }, [string]>(
    `SELECT status, data_json FROM pm_orchestrated_batches WHERE id = ?`,
  ).get(batchId);
  if (!row) return null;
  try {
    const data = JSON.parse(row.data_json) as { phaseGrants?: QueuePhaseGrantInput[] };
    return { status: row.status, grants: Array.isArray(data.phaseGrants) ? data.phaseGrants : [] };
  } catch {
    return { status: row.status, grants: [] };
  }
}

function latestTest(taskId: string, runId: string | null): { observed: boolean; exitCode: number | null; runId: string | null } {
  const rows = db.query<{ authorization_json: string; status: string }, [string]>(
    `SELECT authorization_json, status FROM review_test_authorizations WHERE task_id = ? ORDER BY created_at DESC`,
  ).all(taskId);
  for (const row of rows) {
    let auth: ReviewTestAuthorization | null = null;
    try { auth = JSON.parse(row.authorization_json) as ReviewTestAuthorization; } catch { auth = null; }
    if (!auth || (runId && auth.developerRunId !== runId)) continue;
    if (row.status !== "consumed" || !auth.observationId) continue;
    const observation = db.query<{ observation_json: string }, [string]>(
      `SELECT observation_json FROM review_test_observations WHERE id = ?`,
    ).get(auth.observationId);
    if (!observation) continue;
    try {
      const test = JSON.parse(observation.observation_json) as { exitCode?: unknown; provenance?: unknown };
      const exitCode = typeof test.exitCode === "number" ? test.exitCode : null;
      return { observed: test.provenance === "forgeorbit-observed-test" && exitCode != null, exitCode, runId: auth.developerRunId };
    } catch {
      return { observed: false, exitCode: null, runId: auth.developerRunId };
    }
  }
  return { observed: false, exitCode: null, runId: null };
}

export async function loadQueueStepFacts(input: QueueFactInput): Promise<QueueStepFacts> {
  const workspace = getTaskWorkspace(input.task.id);
  const impl = input.implementation;
  const alignment = impl ? publicationAlignmentForRun(impl.id) : { status: null, blocker: null };
  let publicationBlocker = alignment.blocker;
  if (input.grant.requireTaskWorkspace && impl?.status === "succeeded") {
    if (!workspace || workspace.developerRunId !== impl.id) {
      publicationBlocker = "The Developer run has no task-owned workspace bound to this run.";
    } else if (workspace.violation) {
      publicationBlocker = "The task workspace recorded an unauthorized change.";
    }
  }
  const test = latestTest(input.task.id, impl?.id ?? null);
  let evidenceStatus: QueueStepFacts["evidenceStatus"] = "absent";
  let evidenceBlocker: string | null = null;
  let evidenceRunId: string | null = null;
  const published = !input.grant.requireTaskWorkspace || !publicationBlocker;
  if (impl?.status === "succeeded" && published && input.grant.evidencePolicy === "observed-test" && test.observed && test.exitCode === 0) {
    const run = runs.get(impl.id);
    if (run?.endedAt) {
      try {
        const bundle = await buildImplementationEvidence({
          task: input.task,
          requirements: input.task.prompt,
          developerRunId: impl.id,
          developerEndedAt: run.endedAt,
          projectPath: input.grant.projectPath,
          resourceFingerprint: null,
        });
        evidenceStatus = bundle.status;
        evidenceBlocker = bundle.blocker;
        evidenceRunId = bundle.developerRunId;
        if (bundle.test?.provenance !== "forgeorbit-observed-test") {
          evidenceStatus = bundle.status === "complete" ? "preview" : bundle.status;
          evidenceBlocker = evidenceBlocker ?? "No ForgeOrbit-observed test is bound to this implementation run.";
        }
      } catch (error) {
        evidenceStatus = "blocked";
        evidenceBlocker = error instanceof Error ? error.message : "Evidence could not be collected.";
      }
    }
  }
  const developerGrant = pickGrant(input.grants, "developer", input.grant.taskId, null);
  const reviewerGrant = pickGrant(input.grants, "reviewer", input.grant.taskId, impl?.id ?? null);
  return {
    gated: isGatedPolicy(input.grant),
    evidencePolicy: input.grant.evidencePolicy ?? null,
    requireTaskWorkspace: input.grant.requireTaskWorkspace === true,
    autoReview: input.grant.autoReviewAfterImplementation,
    batchStatus: input.batchStatus,
    taskId: input.grant.taskId,
    liveProcess: input.live,
    taskColumn: input.task.column,
    implementation: impl,
    workspace: workspace ? { status: workspace.status, developerRunId: workspace.developerRunId, violation: workspace.violation } : null,
    publicationBlocker,
    evidenceStatus,
    evidenceBlocker,
    evidenceRunId,
    observedTest: test.observed,
    testExitCode: test.exitCode,
    developerGrant,
    reviewerGrant,
    planDeveloperHarness: input.grant.implementerHarnessId,
    planReviewerHarness: input.grant.reviewerHarness,
    qcVerdict: input.task.qcState?.latestVerdict ?? null,
    now: input.now,
  };
}

export async function decideQueueStep(input: QueueFactInput) {
  return evaluateQueueStep(await loadQueueStepFacts(input));
}

/** Ask the active evidence-gated workflow to look again. Does not grant or launch by itself. */
export function notifyGatedTask(taskId: string): void {
  void import("./pm-orchestrated-workflow.ts").then(async (workflow) => {
    const record = workflow.getWorkflowForTask(taskId);
    if (!record || record.status !== "active" || !isGatedPolicy(record.grant)) return;
    await workflow.scheduleOrchestratedTick(record.id);
  });
}
