/**
 * FO-AUTO03 — evidence-gated queue decisions.
 * Pure. No filesystem, process, clock, or database access. Callers pass `now`.
 * For persisted batch policy: absent gate fields mean the legacy FO-AUTO02 path
 * (unless the row has `queuePolicySchemaVersion`, set on new approvals in
 * FO-AUTO03-SAFE-DEFAULT01 — see `batchPolicyFromApprove`). Not an implicit
 * exemption from observed tests.
 */
import { runStderrProvesQuotaExhausted } from "./codex-quota-failure.ts";

export type EvidencePolicy = "observed-test" | "review-without-observed-test";
export type CompletionGate = "owner-done" | "qc-pass";

export type QueueFailureClass =
  | "implementation-failed"
  | "test-failed"
  | "incomplete-evidence"
  | "changes-requested"
  | "qc-blocked"
  | "provider-failure"
  | "missing-authorization"
  | "quota-exhausted"
  | "publication-conflict"
  | "project-paused"
  | "workspace-missing"
  | "unknown";

export interface QueuePolicyInput {
  evidencePolicy?: EvidencePolicy;
  completionGate?: CompletionGate;
  requireTaskWorkspace?: boolean;
  autoReviewAfterImplementation?: boolean;
}

export interface QueuePhaseGrantInput {
  id: string;
  taskId: string;
  phase: "developer" | "reviewer";
  implementationRunId: string | null;
  harnessId: string;
  status: "active" | "claimed" | "prelaunch-failed" | "consumed" | "expired";
  expiresAt: number;
}

export interface QueueStepFacts {
  gated: boolean;
  evidencePolicy: EvidencePolicy | null;
  requireTaskWorkspace: boolean;
  autoReview: boolean;
  batchStatus: string;
  taskId: string;
  liveProcess: boolean;
  taskColumn: string;
  implementation: { id: string; status: string } | null;
  workspace: { status: string; developerRunId: string | null; violation: boolean } | null;
  publicationBlocker: string | null;
  evidenceStatus: "complete" | "preview" | "blocked" | "absent";
  evidenceBlocker: string | null;
  evidenceRunId: string | null;
  observedTest: boolean;
  testExitCode: number | null;
  developerGrant: QueuePhaseGrantInput | null;
  reviewerGrant: QueuePhaseGrantInput | null;
  planDeveloperHarness: string;
  planReviewerHarness: string;
  qcVerdict: string | null;
  now: number;
}

export type QueueAuthorizationPhase = "developer" | "publication" | "test" | "reviewer" | "owner-done";

export type QueueStepAction =
  | { kind: "legacy" }
  | { kind: "noop"; reason: string }
  | {
      kind: "wait";
      reason: string;
      failureClass: QueueFailureClass | null;
      authorization: string | null;
      authorizationPhase: QueueAuthorizationPhase | null;
      lastCompletedStep: string | null;
    }
  | { kind: "pause"; reason: string; failureClass: QueueFailureClass }
  | { kind: "launch-developer"; grantId: string }
  | { kind: "launch-reviewer"; grantId: string | null };

export function isGatedPolicy(policy: QueuePolicyInput | null | undefined): boolean {
  if (!policy) return false;
  return policy.evidencePolicy != null || policy.completionGate != null || policy.requireTaskWorkspace === true;
}

export function readEvidencePolicy(value: unknown): EvidencePolicy | undefined {
  if (value == null) return undefined;
  if (value === "observed-test" || value === "review-without-observed-test") return value;
  return undefined;
}

export function evidencePolicyIsExplicit(value: unknown): boolean {
  return value == null || value === "observed-test" || value === "review-without-observed-test";
}

/** A waiting evidence-gated workflow may prepare a first-review test. It does not launch a Reviewer. */
export function gatedEvidenceWaitAllowsTest(input: {
  evidencePolicy?: EvidencePolicy | null;
  workflowStatus?: string | null;
  phase?: string | null;
  activeReviewId?: string | null;
  batchStatus?: string | null;
  implementationSettled?: boolean;
}): boolean {
  return input.evidencePolicy === "observed-test"
    && input.workflowStatus === "active"
    && input.batchStatus === "running"
    && !input.activeReviewId
    && input.implementationSettled === true
    && (input.phase === "awaiting_review" || input.phase === "implementing");
}

export function classifyQueueFailure(input: {
  text: string | null;
  qcVerdict: string | null;
  testExit: number | null;
}): { failureClass: QueueFailureClass; quota: "unknown" | "exhausted"; qualityVerdict: boolean } {
  const text = input.text ?? "";
  if (runStderrProvesQuotaExhausted(text)) {
    return { failureClass: "quota-exhausted", quota: "exhausted", qualityVerdict: false };
  }
  if (input.qcVerdict === "CHANGES_REQUESTED" || text.includes("Review requested changes")) {
    return { failureClass: "changes-requested", quota: "unknown", qualityVerdict: true };
  }
  if (input.qcVerdict === "BLOCKED" || text.includes("Quality review blocked")) {
    return { failureClass: "qc-blocked", quota: "unknown", qualityVerdict: true };
  }
  if (input.testExit != null && input.testExit !== 0) {
    return { failureClass: "test-failed", quota: "unknown", qualityVerdict: false };
  }
  if (/fingerprint|no longer matches|publication/i.test(text)) {
    return { failureClass: "publication-conflict", quota: "unknown", qualityVerdict: false };
  }
  if (/evidence|observed test/i.test(text)) {
    return { failureClass: "incomplete-evidence", quota: "unknown", qualityVerdict: false };
  }
  if (/workspace|staging/i.test(text)) {
    return { failureClass: "workspace-missing", quota: "unknown", qualityVerdict: false };
  }
  if (/authoriz|expired|not authorized/i.test(text)) {
    return { failureClass: "missing-authorization", quota: "unknown", qualityVerdict: false };
  }
  if (/paused|draining/i.test(text)) {
    return { failureClass: "project-paused", quota: "unknown", qualityVerdict: false };
  }
  if (text.includes("Implementation run")) {
    return { failureClass: "implementation-failed", quota: "unknown", qualityVerdict: false };
  }
  if (/did not succeed|No QC verdict|provider/i.test(text)) {
    return { failureClass: "provider-failure", quota: "unknown", qualityVerdict: false };
  }
  return { failureClass: "unknown", quota: "unknown", qualityVerdict: false };
}

function grantUsable(
  grant: QueuePhaseGrantInput | null,
  now: number,
  taskId: string,
  harnessId: string,
): "ok" | "missing" | "expired" | "consumed" | "claimed" | "prelaunch-failed" | "mismatch" {
  if (!grant || grant.taskId !== taskId) return "missing";
  if (grant.harnessId !== harnessId) return "mismatch";
  if (grant.status === "claimed") return "claimed";
  if (grant.status === "prelaunch-failed") return "prelaunch-failed";
  if (grant.status === "consumed") return "consumed";
  if (grant.status === "expired" || now >= grant.expiresAt) return "expired";
  if (grant.status !== "active") return "missing";
  return "ok";
}

function wait(
  reason: string,
  failureClass: QueueFailureClass | null,
  authorization: string | null,
  authorizationPhase: QueueAuthorizationPhase | null,
  lastCompletedStep: string | null,
): QueueStepAction {
  return { kind: "wait", reason, failureClass, authorization, authorizationPhase, lastCompletedStep };
}

/**
 * One scheduler decision. A legacy grant returns `legacy` so the caller keeps
 * the FO-AUTO02 path. A gated grant never treats a Developer exit, a transcript,
 * or an incomplete bundle as permission to start a Reviewer.
 */
export function evaluateQueueStep(facts: QueueStepFacts): QueueStepAction {
  if (!facts.gated) return { kind: "legacy" };
  if (facts.batchStatus === "paused") {
    return wait("The batch is paused. No new process will start.", "project-paused", null, null, null);
  }
  if (facts.batchStatus === "draining") {
    return wait("The project is draining. The current process may settle. No new process will start.", "project-paused", null, null, null);
  }
  if (facts.batchStatus !== "running") {
    return { kind: "pause", reason: "The batch is not running.", failureClass: "project-paused" };
  }
  if (facts.liveProcess) return { kind: "noop", reason: "A process is still running." };
  if (facts.qcVerdict === "PASS" && facts.taskColumn !== "done") {
    return wait(
      "Quality review passed. Mark the task Done before the next task can start.",
      null,
      "Accept the task with Owner Done.",
      "owner-done",
      "QC PASS",
    );
  }

  const impl = facts.implementation;
  if (!impl || impl.status !== "succeeded") {
    if (impl && impl.status !== "succeeded" && impl.status !== "running") {
      const classified = classifyQueueFailure({ text: `Implementation run ${impl.status}.`, qcVerdict: null, testExit: null });
      return { kind: "pause", reason: `Implementation run ${impl.status}.`, failureClass: classified.failureClass };
    }
    if (facts.requireTaskWorkspace && facts.workspace?.status !== "armed") {
      return wait(
        "Prepare a task-owned workspace before Developer execution. The project folder will not be used.",
        "workspace-missing",
        "Prepare the task-owned workspace for this task.",
        null,
        null,
      );
    }
    const grant = grantUsable(facts.developerGrant, facts.now, facts.taskId, facts.planDeveloperHarness);
    if (grant === "expired") {
      return wait(
        "The Developer authorization is expired. It was not renewed.",
        "missing-authorization",
        "Approve a new Developer authorization for this task.",
        "developer",
        null,
      );
    }
    if (grant === "consumed") {
      return wait(
        "The Developer authorization is already consumed. It was not renewed.",
        "missing-authorization",
        "A consumed Developer authorization cannot start another run.",
        null,
        null,
      );
    }
    if (grant === "claimed") return { kind: "noop", reason: "A Developer authorization is already claimed." };
    if (grant === "prelaunch-failed") {
      return wait(
        "Developer preparation failed before a run existed. It was not retried.",
        "unknown",
        "Owner intervention is required before another Developer authorization.",
        null,
        null,
      );
    }
    if (grant !== "ok" || !facts.developerGrant) {
      return wait(
        "Developer execution needs an authorization for this task. Another task's authorization is not reused.",
        "missing-authorization",
        "Authorize the Developer for this task.",
        "developer",
        null,
      );
    }
    return { kind: "launch-developer", grantId: facts.developerGrant.id };
  }

  const settled = "Developer implementation settled";
  if (facts.requireTaskWorkspace) {
    if (!facts.workspace || facts.workspace.developerRunId !== impl.id) {
      return wait(
        "The Developer run has no task-owned workspace bound to this run.",
        "workspace-missing",
        "Prepare and bind a task-owned workspace before any further automatic step.",
        null,
        settled,
      );
    }
    if (facts.workspace.violation) {
      return wait(
        "The task workspace recorded an unauthorized change. It is not a QC verdict and it does not start a Reviewer.",
        "publication-conflict",
        "Inspect the change set. An unauthorized path cannot be published or reviewed from this queue.",
        null,
        settled,
      );
    }
    if (facts.publicationBlocker) {
      return wait(
        facts.publicationBlocker,
        "publication-conflict",
        "Approve publication of the named task output paths.",
        "publication",
        settled,
      );
    }
  }

  if (facts.evidencePolicy === "review-without-observed-test") {
    if (!facts.autoReview) {
      return wait(
        "Automatic review was not authorized.",
        "missing-authorization",
        "Automatic review is off for this batch.",
        null,
        facts.requireTaskWorkspace ? "Publication applied" : settled,
      );
    }
    return { kind: "launch-reviewer", grantId: null };
  }

  if (facts.testExitCode != null && facts.testExitCode !== 0) {
    return wait(
      "The ForgeOrbit-observed test failed. This is not an implementation failure and not a QC verdict.",
      "test-failed",
      "The observed test failed. A Reviewer was not started.",
      null,
      "Observed test failed",
    );
  }
  if (!facts.observedTest || facts.evidenceStatus !== "complete" || facts.evidenceRunId !== impl.id) {
    const published = facts.requireTaskWorkspace ? "Publication applied" : settled;
    if (!facts.observedTest) {
      return wait(
        "A ForgeOrbit-observed test is required. A result written in the Developer transcript is not that test.",
        "incomplete-evidence",
        "Authorize and run one ForgeOrbit-observed test for this implementation run.",
        "test",
        published,
      );
    }
    return wait(
      facts.evidenceBlocker ?? "The evidence bundle is incomplete. It is not a QC PASS and not an implementation failure.",
      "incomplete-evidence",
      "Complete the evidence bundle for this implementation run before review.",
      "test",
      published,
    );
  }

  const reviewer = facts.reviewerGrant;
  const reviewerState = grantUsable(reviewer, facts.now, facts.taskId, facts.planReviewerHarness);
  if (reviewerState === "expired") {
    return wait(
      "The Reviewer authorization is expired. It was not renewed.",
      "missing-authorization",
      "Approve a new Reviewer authorization for this implementation run.",
      "reviewer",
      "Evidence complete",
    );
  }
  if (reviewerState === "consumed") {
    return wait(
      "The Reviewer authorization is already consumed. It was not renewed.",
      "missing-authorization",
      "A consumed Reviewer authorization cannot start another review.",
      null,
      "Evidence complete",
    );
  }
  if (reviewerState === "claimed") return { kind: "noop", reason: "A Reviewer authorization is already claimed." };
  if (reviewerState === "prelaunch-failed") {
    return wait(
      "Reviewer preparation failed before a run existed. It was not retried.",
      "unknown",
      "Owner intervention is required before another Reviewer attempt.",
      null,
      "Evidence complete",
    );
  }
  if (reviewerState !== "ok" || !reviewer || reviewer.implementationRunId !== impl.id) {
    return wait(
      "Reviewer execution needs an authorization for this task and this implementation run.",
      "missing-authorization",
      "Authorize the Reviewer for this implementation run.",
      "reviewer",
      "Evidence complete",
    );
  }
  return { kind: "launch-reviewer", grantId: reviewer.id };
}

export interface QueueGateView {
  mode: "legacy" | "gated";
  disposition: "running" | "waiting" | "paused" | "blocked" | "legacy";
  phase: string;
  nextAuthorization: string | null;
  nextAuthorizationPhase: QueueAuthorizationPhase | null;
  nextTaskId: string | null;
  lastCompletedStep: string | null;
  developer: string | null;
  reviewer: string | null;
  providerFailure: string | null;
  nextTaskEligible: boolean;
  failureClass: string | null;
  quota: "unknown" | "exhausted";
  drainingSupported: false;
}

export function buildQueueGateView(input: {
  gated: boolean;
  batchStatus: string;
  pauseReason: string | null;
  waitReason: string | null;
  activeTaskId: string | null;
  activePhase: string | null;
  failureClass: string | null;
  lastCompletedStep: string | null;
  developer: string | null;
  reviewer: string | null;
  nextAuthorization: string | null;
  nextAuthorizationPhase: QueueAuthorizationPhase | null;
  nextTaskId: string | null;
  nextTaskEligible: boolean;
}): QueueGateView {
  if (!input.gated) {
    return {
      mode: "legacy",
      disposition: "legacy",
      phase: input.activePhase ?? "queued",
      nextAuthorization: null,
      nextAuthorizationPhase: null,
      nextTaskId: input.nextTaskId,
      lastCompletedStep: null,
      developer: input.developer,
      reviewer: input.reviewer,
      providerFailure: null,
      nextTaskEligible: false,
      failureClass: null,
      quota: "unknown",
      drainingSupported: false,
    };
  }
  const ownerPause = input.pauseReason === "Paused by the owner.";
  let disposition: QueueGateView["disposition"] = "running";
  if (input.batchStatus === "paused" && ownerPause) disposition = "paused";
  else if (input.batchStatus === "paused" || input.batchStatus === "stopped") disposition = "blocked";
  else if (input.waitReason) disposition = "waiting";
  const providerFailure = input.failureClass === "provider-failure" || input.failureClass === "quota-exhausted"
    ? input.waitReason ?? input.pauseReason
    : null;
  return {
    mode: "gated",
    disposition,
    phase: input.activePhase ?? "queued",
    nextAuthorization: input.nextAuthorization ?? input.waitReason,
    nextAuthorizationPhase: input.nextAuthorizationPhase,
    nextTaskId: input.nextTaskId,
    lastCompletedStep: input.lastCompletedStep,
    developer: input.developer,
    reviewer: input.reviewer,
    providerFailure,
    nextTaskEligible: input.nextTaskEligible,
    failureClass: input.failureClass,
    quota: input.failureClass === "quota-exhausted" ? "exhausted" : "unknown",
    drainingSupported: false,
  };
}
