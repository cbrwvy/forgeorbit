import { describe, expect, test } from "bun:test";
import { deriveContributionProgress, deriveInitiativeStatus } from "./head-pm-initiative.ts";

describe("FO-HEAD02 progress derivation", () => {
  test("QC PASS awaiting Owner is needs_owner, not completed", () => {
    const progress = deriveContributionProgress({
      delegationStatus: "answered",
      pendingProposalCount: 0,
      tasks: [{ id: "t1", column: "review", awaitingOwnerQc: true }],
      batchStatuses: [],
      manuallyClosed: false,
      projectRegistered: true,
    });
    expect(progress).toBe("needs_owner");
  });

  test("done column counts as completed contribution", () => {
    const progress = deriveContributionProgress({
      delegationStatus: "answered",
      pendingProposalCount: 0,
      tasks: [{ id: "t1", column: "done", awaitingOwnerQc: false }],
      batchStatuses: [],
      manuallyClosed: false,
      projectRegistered: true,
    });
    expect(progress).toBe("completed");
  });

  test("paused batch flags needs_owner", () => {
    const progress = deriveContributionProgress({
      delegationStatus: "answered",
      pendingProposalCount: 0,
      tasks: [{ id: "t1", column: "ready", awaitingOwnerQc: false }],
      batchStatuses: [{ id: "b1", status: "paused", needsAttention: true }],
      manuallyClosed: false,
      projectRegistered: true,
    });
    expect(progress).toBe("needs_owner");
  });

  test("initiative completes when every contribution is done", () => {
    const status = deriveInitiativeStatus(null, [
      { progress: "completed" },
      { progress: "closed_by_owner" },
    ]);
    expect(status).toBe("completed");
  });
});
