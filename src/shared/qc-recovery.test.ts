import { describe, expect, test } from "bun:test";
import {
  assessQcRecovery,
  clampRecoveryMinutes,
  readOnlyReviewerContract,
  recoveryTreeFingerprint,
} from "./qc-recovery.ts";

const ready = {
  archived: false,
  column: "blocked",
  liveRun: false,
  activeReview: false,
  developerRunId: "dev",
  developerSucceeded: true,
  failedReviewId: "rev",
  failedReviewVerdict: null,
  failedReviewComplete: true,
  failedReviewImplementationRunId: "dev",
  failedRunStatus: "failed",
  latestVerdict: null,
  workflowStatus: "paused",
  batchStatus: "paused",
  requirementsMatch: true,
};

describe("qc recovery rules", () => {
  test("a finished failed review with a successful Developer run is eligible", () => {
    expect(assessQcRecovery(ready)).toEqual({ eligible: true, reconciliationRequired: false, blockers: [] });
  });

  test("an active workflow or a running column needs reconciliation and is not eligible", () => {
    expect(assessQcRecovery({ ...ready, workflowStatus: "active" }).reconciliationRequired).toBe(true);
    expect(assessQcRecovery({ ...ready, column: "running" }).eligible).toBe(false);
  });

  test("a verdict, a live run, a running batch, or changed requirements block recovery", () => {
    expect(assessQcRecovery({ ...ready, latestVerdict: "PASS" }).eligible).toBe(false);
    expect(assessQcRecovery({ ...ready, liveRun: true }).blockers.join(" ")).toContain("still running");
    expect(assessQcRecovery({ ...ready, batchStatus: "running" }).eligible).toBe(false);
    expect(assessQcRecovery({ ...ready, requirementsMatch: false }).eligible).toBe(false);
  });

  test("Codex ask and Claude bounded-print are the only read-only contracts", () => {
    expect(readOnlyReviewerContract("codex")).toEqual({
      mode: "ask",
      sandbox: "read-only",
      permission: "Codex ask launches with --sandbox read-only.",
    });
    expect(readOnlyReviewerContract("claude-code")?.mode).toBe("bounded-print");
    expect(readOnlyReviewerContract("deepseek")).toBeNull();
    expect(readOnlyReviewerContract("cursor")).toBeNull();
  });

  test("tree fingerprint changes when a file hash changes and the minute clamp stays bounded", () => {
    const base = recoveryTreeFingerprint("a".repeat(40), [{ path: "src/shift.ts", sha256: "1" }]);
    expect(recoveryTreeFingerprint("a".repeat(40), [{ path: "src/shift.ts", sha256: "2" }])).not.toBe(base);
    expect(clampRecoveryMinutes(undefined)).toBe(30);
    expect(clampRecoveryMinutes(1)).toBe(5);
    expect(clampRecoveryMinutes(999)).toBe(240);
  });
});
