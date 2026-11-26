import { describe, expect, test } from "bun:test";
import {
  FAKE_QC_REVIEW_PROMPT_MARKER,
  formatQcVerdictBlock,
  parseQcVerdictFromText,
  canOwnerApproveDone,
  qcRoundLimitReached,
  qcExtensionEligibility,
  parseQcState,
  withExtensionOutcome,
  EMPTY_QC_STATE,
} from "./task-quality-control.ts";

describe("parseQcVerdictFromText", () => {
  test("parses structured block", () => {
    const block = formatQcVerdictBlock({
      verdict: "CHANGES_REQUESTED",
      summary: "Missing tests",
      findings: [{ severity: "blocker", text: "No unit tests" }],
      feedback: "Add coverage for the happy path.",
    });
    const parsed = parseQcVerdictFromText(block);
    expect(parsed.verdict).toBe("CHANGES_REQUESTED");
    expect(parsed.summary).toBe("Missing tests");
    expect(parsed.findings).toHaveLength(1);
    expect(parsed.feedback).toContain("happy path");
  });

  test("returns null verdict when tag missing", () => {
    expect(parseQcVerdictFromText("Looks fine to me").verdict).toBeNull();
  });
});

describe("canOwnerApproveDone", () => {
  test("blocks done after CHANGES_REQUESTED", () => {
    expect(
      canOwnerApproveDone(
        { ...EMPTY_QC_STATE, roundCount: 1, latestVerdict: "CHANGES_REQUESTED" },
        "review",
      ),
    ).toMatch(/changes/i);
  });

  test("allows done after PASS awaiting owner", () => {
    expect(
      canOwnerApproveDone(
        { ...EMPTY_QC_STATE, roundCount: 1, latestVerdict: "PASS", awaitingOwnerApproval: true },
        "review",
      ),
    ).toBeNull();
  });

  test("blocks done after BLOCKED from review and from any other column", () => {
    const qc = { ...EMPTY_QC_STATE, roundCount: 1, latestVerdict: "BLOCKED" as const };
    expect(canOwnerApproveDone(qc, "review")).toMatch(/could not verify/i);
    expect(canOwnerApproveDone(qc, "ready")).toMatch(/could not verify/i);
    expect(canOwnerApproveDone(qc, "blocked")).toMatch(/could not verify/i);
  });

  test("blocks done after CHANGES_REQUESTED even when the card is not in review", () => {
    const qc = { ...EMPTY_QC_STATE, roundCount: 1, latestVerdict: "CHANGES_REQUESTED" as const };
    expect(canOwnerApproveDone(qc, "ready")).toMatch(/changes/i);
  });
});

describe("round limit", () => {
  const used = { ...EMPTY_QC_STATE, roundCount: EMPTY_QC_STATE.maxRounds };
  test("only a used-up budget without a PASS (and no review in progress) is a limit", () => {
    expect(qcRoundLimitReached(null)).toBe(false);
    expect(qcRoundLimitReached({ ...used, roundCount: used.maxRounds - 1, latestVerdict: "CHANGES_REQUESTED" })).toBe(false);
    expect(qcRoundLimitReached({ ...used, latestVerdict: "CHANGES_REQUESTED" })).toBe(true);
    expect(qcRoundLimitReached({ ...used, latestVerdict: "BLOCKED" })).toBe(true);
    expect(qcRoundLimitReached({ ...used, latestVerdict: "PASS", awaitingOwnerApproval: true })).toBe(false);
    expect(qcRoundLimitReached({ ...used, latestVerdict: "CHANGES_REQUESTED", activeReviewId: "x" })).toBe(false);
  });
  test("at the limit the Done refusal names the limit, not a rework that can no longer be reviewed", () => {
    expect(canOwnerApproveDone({ ...used, latestVerdict: "CHANGES_REQUESTED" }, "blocked")).toMatch(/review rounds are used/);
    expect(canOwnerApproveDone({ ...used, latestVerdict: "BLOCKED" }, "blocked")).toMatch(/review rounds are used/);
    expect(canOwnerApproveDone({ ...used, roundCount: 2, latestVerdict: "CHANGES_REQUESTED" }, "ready")).toMatch(/Address the requested changes/);
  });
});

describe("Owner extension of one review round", () => {
  const blocked = { ...EMPTY_QC_STATE, roundCount: 5, reworkCount: 5, latestVerdict: "CHANGES_REQUESTED" as const };
  const ext = { authorizedAt: 10, authorizedBy: "owner" as const, baseRound: 5, baseVerdict: "CHANGES_REQUESTED" as const, reviewId: null };
  test("eligible only when Blocked at the limit with no PASS, no review running and no earlier extension", () => {
    expect(qcExtensionEligibility(blocked, "blocked").eligible).toBe(true);
    expect(qcExtensionEligibility(blocked, "review").eligible).toBe(true);   // e.g. a PASS withdrawn by new output at the limit
    expect(qcExtensionEligibility(blocked, "ready").eligible).toBe(false);
    expect(qcExtensionEligibility({ ...blocked, latestVerdict: null }, "blocked").eligible).toBe(true);   // the last Reviewer produced no verdict
    expect(qcExtensionEligibility({ ...blocked, roundCount: 4 }, "blocked").eligible).toBe(false);
    expect(qcExtensionEligibility({ ...blocked, latestVerdict: "PASS", awaitingOwnerApproval: true }, "blocked").eligible).toBe(false);
    expect(qcExtensionEligibility({ ...blocked, activeReviewId: "r" }, "blocked").eligible).toBe(false);
    expect(qcExtensionEligibility(null, "blocked").eligible).toBe(false);
    expect(qcExtensionEligibility({ ...blocked, maxRounds: 6, extension: ext }, "blocked").eligible).toBe(false);
    expect(qcExtensionEligibility({ ...blocked, maxRounds: 6, extension: { ...ext, reviewId: "x" } }, "blocked").reason).toMatch(/already used/);
  });
  test("an extension raises the limit by exactly one, survives parsing, and records how its review ended", () => {
    const parsed = parseQcState({ ...blocked, extension: ext });
    expect(parsed.maxRounds).toBe(6);
    expect(parsed.extension).toMatchObject({ authorizedBy: "owner", baseRound: 5, reviewId: null });
    expect(qcRoundLimitReached(parsed)).toBe(false);
    expect(parseQcState({ ...blocked, extension: { authorizedAt: "x" } }).extension).toBeNull();
    expect(parseQcState({ ...blocked, extension: { ...ext, authorizedBy: "agent" } }).extension?.authorizedBy).toBe("owner");
    const used = withExtensionOutcome({ ...parsed, roundCount: 6, extension: { ...ext, reviewId: "r6" } }, "r6", "BLOCKED");
    expect(used.extension?.outcome).toBe("BLOCKED");
    expect(qcRoundLimitReached(used)).toBe(true);
    expect(withExtensionOutcome(used, "other", "PASS")).toBe(used);
  });
  test("an additional round that ended without a PASS, even with no verdict at all, refuses Done", () => {
    const base = { ...blocked, roundCount: 6, maxRounds: 6 };
    for (const outcome of ["CHANGES_REQUESTED", "BLOCKED", "none"] as const) {
      expect(canOwnerApproveDone({ ...base, latestVerdict: outcome === "none" ? null : outcome, extension: { ...ext, reviewId: "r6", outcome } }, "blocked")).toMatch(/without a PASS/);
    }
    expect(canOwnerApproveDone({ ...base, latestVerdict: "PASS", awaitingOwnerApproval: true, extension: { ...ext, reviewId: "r6", outcome: "PASS" } }, "review")).toBeNull();
  });
});

describe("common acceptance rule (Direction 8)", () => {
  const entered = { ...EMPTY_QC_STATE, roundCount: 2, reworkCount: 1 };
  test("a task that never entered QC is the Owner's own decision, as before", () => {
    expect(canOwnerApproveDone(null, "review")).toBeNull();
    expect(canOwnerApproveDone({ ...EMPTY_QC_STATE }, "blocked")).toBeNull();
  });
  test("no verdict is not a pass: a failed Reviewer or a withdrawn PASS refuses Done from every column", () => {
    for (const column of ["review", "blocked", "ready", "running"] as const) {
      expect(canOwnerApproveDone({ ...entered, latestVerdict: null }, column)).toMatch(/no verdict/);
    }
    const limit = canOwnerApproveDone({ ...EMPTY_QC_STATE, roundCount: 5, latestVerdict: null }, "blocked");
    expect(limit).toMatch(/last review produced no verdict/);
    expect(limit).toMatch(/fresh PASS/);
  });
  test("only a PASS covering the current output allows Done", () => {
    expect(canOwnerApproveDone({ ...entered, latestVerdict: "PASS", awaitingOwnerApproval: true }, "review")).toBeNull();
    expect(canOwnerApproveDone({ ...entered, latestVerdict: "PASS" }, "done")).toBeNull();
    expect(canOwnerApproveDone({ ...entered, latestVerdict: "CHANGES_REQUESTED" }, "review")).not.toBeNull();
    expect(canOwnerApproveDone({ ...entered, latestVerdict: "BLOCKED" }, "review")).not.toBeNull();
    expect(canOwnerApproveDone({ ...entered, activeReviewId: "r" }, "review")).not.toBeNull();
  });
});

describe("fake marker export", () => {
  test("marker is stable", () => {
    expect(FAKE_QC_REVIEW_PROMPT_MARKER).toBe("__agetor_fake_qc_review__");
  });
});
