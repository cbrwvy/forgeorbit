/**
 * Shared evidence builder for one implementation run.
 * First-review and evidence-refresh both call this. It reads source, hashes,
 * and a stored observation. It does not spawn a test or create a QC review.
 */
import { projectRules, runs, taskQualityReviews, tasks } from "./db.ts";
import { loadEffectiveKnowledgeForProject } from "./knowledge-effective.ts";
import { ownershipOf } from "./project-ownership.ts";
import { snapshotProjectRules } from "../shared/project-rules.ts";
import type { ReviewEvidenceBundle, ReviewEvidenceTest, ReviewTestAuthorization } from "../shared/review-evidence.ts";
import { collectReviewEvidence, readRunSourceSnapshot, recordedSourceAlignment, workspaceForTask } from "./review-evidence.ts";
import { latestTestAuthorization, openTestAuthorization, withStoredObservation } from "./review-test-authorization.ts";
import { publicationAlignmentForRun } from "./task-workspace.ts";

export class QcEvidencePreviewError extends Error {
  constructor(message: string, readonly status = 400, readonly code = "invalid") {
    super(message);
    this.name = "QcEvidencePreviewError";
  }
}

export interface TaskQcEvidencePreview {
  taskId: string;
  developerRunId: string | null;
  publicationStatus: string | null;
  sourceFingerprint: string | null;
  observedTestStatus: "observed" | "missing" | "blocked";
  readyForReviewer: boolean;
  files: ReviewEvidenceBundle["files"];
  diff: string | null;
  diffOmission: string | null;
  omitted: ReviewEvidenceBundle["omitted"];
  proposedTest: ReviewEvidenceBundle["proposedTest"];
  test: ReviewEvidenceTest | null;
  missingReason: string | null;
  howToSupply: string | null;
  testAuthorization: ReviewTestAuthorization | null;
  bundle: ReviewEvidenceBundle | null;
}

export async function buildImplementationEvidence(input: {
  task: { id: string; workdir: string; isolation: string; worktreePath: string | null };
  requirements: string;
  developerRunId: string;
  developerEndedAt: number;
  projectPath: string;
  resourceFingerprint: string | null;
  reuseTest?: ReviewEvidenceTest | null;
}): Promise<ReviewEvidenceBundle> {
  const workspace = workspaceForTask(input.task);
  if (!workspace) throw new Error("The implementation workspace was not recorded.");
  const rules = snapshotProjectRules(input.projectPath, projectRules.list(input.projectPath));
  const knowledge = await loadEffectiveKnowledgeForProject(input.projectPath);
  const preview = await collectReviewEvidence({
    taskId: input.task.id,
    requirements: input.requirements,
    workspacePath: workspace,
    projectPath: input.projectPath,
    developerRunId: input.developerRunId,
    developerEndedAt: input.developerEndedAt,
    snapshot: readRunSourceSnapshot(input.developerRunId),
    rulesText: rules.rules.length > 0 ? rules.rules.map((rule) => `${rule.name}\n${rule.body}`).join("\n\n") : null,
    knowledgeRefs: knowledge?.snapshot.items.map((item) => ({ id: item.id, title: item.title })) ?? [],
    resourceFingerprint: input.resourceFingerprint,
    reuseTest: input.reuseTest,
  });
  return withStoredObservation(preview);
}

function resolveImplementationRunForPreview(taskId: string, preferredRunId: string | null): { id: string; endedAt: number } | null {
  const tryRun = (id: string | null | undefined) => {
    if (!id) return null;
    const run = runs.get(id);
    if (!run || run.taskId !== taskId || run.qcReviewId || run.status !== "succeeded" || run.endedAt == null) return null;
    return { id: run.id, endedAt: run.endedAt };
  };
  const direct = tryRun(preferredRunId);
  if (direct) return direct;
  const reviews = taskQualityReviews.listForTask(taskId);
  for (let i = reviews.length - 1; i >= 0; i -= 1) {
    const rev = tryRun(reviews[i]?.implementationRunId);
    if (rev) return rev;
  }
  const taskRuns = runs.listForTask(taskId);
  for (let i = taskRuns.length - 1; i >= 0; i -= 1) {
    const candidate = taskRuns[i];
    if (candidate && !candidate.qcReviewId && candidate.status === "succeeded" && candidate.endedAt != null) {
      return { id: candidate.id, endedAt: candidate.endedAt };
    }
  }
  return null;
}

export function describeMissingEvidence(input: {
  blocker: string | null;
  bundle: ReviewEvidenceBundle | null;
}): { missingReason: string | null; howToSupply: string | null } {
  if (input.blocker) {
    return {
      missingReason: input.blocker,
      howToSupply: input.blocker.includes("Publish")
        ? "Publish the approved task-workspace files first, then run the offline test authorization flow."
        : "Restore or capture valid implementation source and run the offline test authorization flow for the current source fingerprint.",
    };
  }
  if (!input.bundle) {
    return {
      missingReason: "No implementation evidence bundle is available.",
      howToSupply: "Complete a supervised Developer run and publish its approved output before running the offline test.",
    };
  }
  if (input.bundle.status === "blocked") {
    return {
      missingReason: input.bundle.blocker ?? "Implementation evidence is incomplete.",
      howToSupply: "Resolve the workspace or source issue above, then run the offline test authorization flow.",
    };
  }
  if (input.bundle.status === "preview") {
    const fp = input.bundle.sourceFingerprint;
    const cmd = input.bundle.proposedTest?.command ?? "bun test";
    return {
      missingReason: `No ForgeOrbit-observed test result is bound to the current source fingerprint (${fp.slice(0, 12)}).`,
      howToSupply: `Prepare, approve, and execute the fixed offline test (${cmd}) in the task's QC evidence panel (/tasks/${input.bundle.taskId}/qc-evidence/test-authorization) for this exact source fingerprint.`,
    };
  }
  return { missingReason: null, howToSupply: null };
}

/**
 * Bounded read-only QC evidence preview for a task. Preserves project ownership
 * and secret-redaction guarantees and never executes tests or opens dialogs.
 */
export async function getTaskQcEvidencePreview(taskId: string): Promise<TaskQcEvidencePreview> {
  const task = tasks.get(taskId);
  if (!task) throw new QcEvidencePreviewError("Task not found.", 404, "not-found");
  const owner = ownershipOf(task.workdir, { fresh: true });
  if (owner.kind !== "owned") {
    throw new QcEvidencePreviewError("Task project ownership is ambiguous.", 409, "ownership");
  }
  const impl = resolveImplementationRunForPreview(task.id, task.runId ?? null);
  const testAuthorization = openTestAuthorization(task.id) ?? latestTestAuthorization(task.id);
  if (!impl) {
    const { missingReason, howToSupply } = describeMissingEvidence({ blocker: "No succeeded Developer implementation run is recorded for this task.", bundle: null });
    return {
      taskId: task.id,
      developerRunId: null,
      publicationStatus: null,
      sourceFingerprint: null,
      observedTestStatus: "blocked",
      readyForReviewer: false,
      files: [],
      diff: null,
      diffOmission: null,
      omitted: [],
      proposedTest: null,
      test: null,
      missingReason,
      howToSupply,
      testAuthorization,
      bundle: null,
    };
  }

  const alignment = publicationAlignmentForRun(impl.id);
  let bundle: ReviewEvidenceBundle | null = null;
  let blocker: string | null = alignment.blocker;
  try {
    bundle = await buildImplementationEvidence({
      task,
      requirements: task.prompt,
      developerRunId: impl.id,
      developerEndedAt: impl.endedAt,
      projectPath: owner.projectPath,
      resourceFingerprint: null,
    });
    if (!blocker) {
      blocker = bundle.status === "blocked"
        ? (bundle.blocker ?? "Evidence is incomplete.")
        : recordedSourceAlignment(impl.id, bundle);
    }
  } catch (error) {
    blocker = error instanceof Error ? error.message : "Implementation evidence could not be collected.";
  }

  const observed = !blocker
    && bundle?.status === "complete"
    && bundle.test?.provenance === "forgeorbit-observed-test"
    && bundle.test.sourceFingerprint === bundle.sourceFingerprint;
  const observedTestStatus: TaskQcEvidencePreview["observedTestStatus"] = observed
    ? "observed"
    : (!blocker && bundle?.status === "preview")
      ? "missing"
      : "blocked";
  const { missingReason, howToSupply } = observed
    ? { missingReason: null, howToSupply: null }
    : describeMissingEvidence({ blocker, bundle });

  return {
    taskId: task.id,
    developerRunId: impl.id,
    publicationStatus: alignment.status,
    sourceFingerprint: bundle?.sourceFingerprint ?? null,
    observedTestStatus,
    readyForReviewer: observed,
    files: bundle?.files ?? [],
    diff: bundle?.diff ?? null,
    diffOmission: bundle?.diffOmission ?? null,
    omitted: bundle?.omitted ?? [],
    proposedTest: bundle?.proposedTest ?? null,
    test: observed ? bundle!.test : null,
    missingReason,
    howToSupply,
    testAuthorization,
    bundle,
  };
}
