import { expect, test } from "bun:test";
import { classifyQueueFailure, evaluateQueueStep, isGatedPolicy, type QueueStepFacts } from "./queue-gates.ts";

function facts(over: Partial<QueueStepFacts> = {}): QueueStepFacts {
  return {
    gated: true,
    evidencePolicy: "observed-test",
    requireTaskWorkspace: true,
    autoReview: true,
    batchStatus: "running",
    taskId: "task-a",
    liveProcess: false,
    taskColumn: "ready",
    implementation: null,
    workspace: { status: "armed", developerRunId: null, violation: false },
    publicationBlocker: null,
    evidenceStatus: "absent",
    evidenceBlocker: null,
    evidenceRunId: null,
    observedTest: false,
    testExitCode: null,
    developerGrant: { id: "dev", taskId: "task-a", phase: "developer", implementationRunId: null, harnessId: "claude-code", status: "active", expiresAt: 5_000 },
    reviewerGrant: null,
    planDeveloperHarness: "claude-code",
    planReviewerHarness: "claude-code",
    qcVerdict: null,
    now: 1_000,
    ...over,
  };
}

test("legacy policy is not an implicit observed-test exemption", () => {
  expect(isGatedPolicy(null)).toBe(false);
  expect(isGatedPolicy({})).toBe(false);
  expect(evaluateQueueStep(facts({ gated: false })).kind).toBe("legacy");
  expect(isGatedPolicy({ evidencePolicy: "review-without-observed-test" })).toBe(true);
});

test("developer success without observed evidence does not launch a reviewer", () => {
  const action = evaluateQueueStep(facts({
    taskColumn: "review",
    implementation: { id: "run-1", status: "succeeded" },
    workspace: { status: "published", developerRunId: "run-1", violation: false },
    evidenceStatus: "preview",
    observedTest: false,
  }));
  expect(action.kind).toBe("wait");
  if (action.kind === "wait") expect(action.authorizationPhase).toBe("test");
});

test("expired and consumed reviewer grants are not renewed", () => {
  const base = facts({
    taskColumn: "review",
    implementation: { id: "run-1", status: "succeeded" },
    workspace: { status: "published", developerRunId: "run-1", violation: false },
    evidenceStatus: "complete",
    evidenceRunId: "run-1",
    observedTest: true,
    testExitCode: 0,
  });
  const expired = evaluateQueueStep(facts({
    ...base,
    reviewerGrant: { id: "rev", taskId: "task-a", phase: "reviewer", implementationRunId: "run-1", harnessId: "claude-code", status: "active", expiresAt: 500 },
    now: 500,
  }));
  const consumed = evaluateQueueStep(facts({
    ...base,
    reviewerGrant: { id: "rev", taskId: "task-a", phase: "reviewer", implementationRunId: "run-1", harnessId: "claude-code", status: "consumed", expiresAt: 9_000 },
  }));
  expect(expired.kind).toBe("wait");
  expect(consumed.kind).toBe("wait");
  if (expired.kind === "wait") expect(expired.reason).toContain("expired");
  if (consumed.kind === "wait") expect(consumed.reason).toContain("consumed");
  const claimed = evaluateQueueStep(facts({
    ...base,
    reviewerGrant: { id: "rev", taskId: "task-a", phase: "reviewer", implementationRunId: "run-1", harnessId: "claude-code", status: "claimed", expiresAt: 9_000 },
  }));
  const failed = evaluateQueueStep(facts({
    ...base,
    reviewerGrant: { id: "rev", taskId: "task-a", phase: "reviewer", implementationRunId: "run-1", harnessId: "claude-code", status: "prelaunch-failed", expiresAt: 9_000 },
  }));
  expect(claimed).toEqual({ kind: "noop", reason: "A Reviewer authorization is already claimed." });
  expect(failed.kind).toBe("wait");
  if (failed.kind === "wait") expect(failed.reason).toContain("not retried");
});

test("draining and paused batches do not launch", () => {
  expect(evaluateQueueStep(facts({ batchStatus: "draining" })).kind).toBe("wait");
  expect(evaluateQueueStep(facts({ batchStatus: "paused" })).kind).toBe("wait");
  expect(evaluateQueueStep(facts({ batchStatus: "stopped" })).kind).toBe("pause");
});

test("usage limit is not a quality verdict and quota stays unknown without that signal", () => {
  const quota = classifyQueueFailure({ text: "provider failed: usage_limit_exceeded", qcVerdict: null, testExit: null });
  expect(quota).toMatchObject({ failureClass: "quota-exhausted", quota: "exhausted", qualityVerdict: false });
  const legacy = "You\u2019ve hit your usage limit. Upgrade to Pro (https://chatgpt.com/explore/pro), visit https://chatgpt.com/settings/usage to purchase more credits or try again at 3:50 PM.";
  expect(classifyQueueFailure({ text: legacy, qcVerdict: null, testExit: null })).toMatchObject({ failureClass: "quota-exhausted", quota: "exhausted", qualityVerdict: false });
  expect(classifyQueueFailure({ text: "rate limit exceeded", qcVerdict: null, testExit: null }).failureClass).not.toBe("quota-exhausted");
  expect(classifyQueueFailure({ text: `assistant claimed ${legacy} inside a sentence`, qcVerdict: null, testExit: null }).failureClass).not.toBe("quota-exhausted");
  const unknown = classifyQueueFailure({ text: "Quality review run did not succeed. No QC verdict was produced.", qcVerdict: null, testExit: null });
  expect(unknown).toMatchObject({ failureClass: "provider-failure", quota: "unknown", qualityVerdict: false });
  expect(classifyQueueFailure({ text: "Review requested changes.", qcVerdict: "CHANGES_REQUESTED", testExit: null }).failureClass).toBe("changes-requested");
  expect(classifyQueueFailure({ text: "Quality review blocked.", qcVerdict: "BLOCKED", testExit: null }).failureClass).toBe("qc-blocked");
  expect(classifyQueueFailure({ text: null, qcVerdict: null, testExit: 1 }).failureClass).toBe("test-failed");
});

test("a mismatched or missing developer grant does not launch", () => {
  expect(evaluateQueueStep(facts({ developerGrant: null })).kind).toBe("wait");
  const other = evaluateQueueStep(facts({
    developerGrant: { id: "dev", taskId: "task-b", phase: "developer", implementationRunId: null, harnessId: "codex", status: "active", expiresAt: 9_000 },
  }));
  expect(other.kind).toBe("wait");
});

test("explicit review without an observed test can launch a reviewer", () => {
  const action = evaluateQueueStep(facts({
    evidencePolicy: "review-without-observed-test",
    taskColumn: "review",
    implementation: { id: "run-1", status: "succeeded" },
    workspace: { status: "published", developerRunId: "run-1", violation: false },
    observedTest: false,
  }));
  expect(action).toEqual({ kind: "launch-reviewer", grantId: null });
});
