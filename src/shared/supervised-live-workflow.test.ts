import { describe, expect, test } from "bun:test";
import { buildSupervisedLiveView, deriveSupervisedLivePhase } from "./supervised-live-workflow.ts";
import type { Task } from "./types.ts";

const baseTask = (): Pick<Task, "id" | "column" | "archivedAt" | "agent" | "model" | "runId" | "qcState"> => ({
  id: "t1",
  column: "ready",
  archivedAt: null,
  agent: "claude-code",
  model: "opus-5.5",
  runId: null,
  qcState: null,
});

describe("deriveSupervisedLivePhase", () => {
  test("backlog and inbox intake phases", () => {
    expect(deriveSupervisedLivePhase({ task: { ...baseTask(), column: "backlog" }, hasAssignment: false, employeeRunPhase: null, runLive: false, runStarting: false })).toBe("backlog-draft");
    expect(deriveSupervisedLivePhase({ task: { ...baseTask(), column: "inbox" }, hasAssignment: false, employeeRunPhase: null, runLive: false, runStarting: false })).toBe("inbox-triage");
  });

  test("employee confirmation and QC owner acceptance", () => {
    expect(
      deriveSupervisedLivePhase({
        task: baseTask(),
        hasAssignment: true,
        employeeRunPhase: "awaiting-approval",
        runLive: false,
        runStarting: false,
      }),
    ).toBe("awaiting-owner-confirm");
    expect(
      deriveSupervisedLivePhase({
        task: {
          ...baseTask(),
          column: "review",
          qcState: { activeReviewId: null, awaitingOwnerApproval: true, latestVerdict: "PASS", reworkCount: 0, roundCount: 1, maxRounds: 5 },
        },
        hasAssignment: true,
        employeeRunPhase: null,
        runLive: false,
        runStarting: false,
      }),
    ).toBe("awaiting-owner-acceptance");
  });

  test("rework returns to ready-prepare path", () => {
    const view = buildSupervisedLiveView({
      task: {
        ...baseTask(),
        column: "ready",
        qcState: { activeReviewId: null, awaitingOwnerApproval: false, latestVerdict: "CHANGES_REQUESTED", reworkCount: 1, roundCount: 1, maxRounds: 5 },
      },
      hasAssignment: true,
      employeeRunPhase: null,
      runLive: false,
      runStarting: false,
    });
    expect(view.phase).toBe("rework-ready");
    expect(view.ownerAction).toContain("review feedback");
  });
});
