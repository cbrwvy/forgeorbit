import { expect, test } from "bun:test";
import { currentOutcomeReview, outcomeExcerpt, verifiedOutcomeTestCounts, type OutcomeTestEvidence } from "./manager-outcome";
import { EMPTY_QC_STATE } from "../../shared/task-quality-control";
import type { TaskQcReview } from "../../shared/types";

const review = { id: "review", taskId: "task", round: 3, status: "complete", verdict: "PASS", coversLatestOutput: true,
  implementationRunId: "implementation", summary: "Numbers below or above the allowed range now stop at the nearest boundary.", findings: [] } as unknown as TaskQcReview;
const evidence: OutcomeTestEvidence = { taskId: "task", developerRunId: "implementation", sourceFingerprint: "current-source", observedTestStatus: "observed",
  test: { provenance: "forgeorbit-observed-test", sourceFingerprint: "current-source", command: "bun test src/clamp.test.ts", exitCode: 0,
    stdout: "", stderr: "bun test v1.4.3\n\n 3 pass\n 0 fail\n 11 expect() calls\nRan 3 tests across 1 file. [6.00ms]\n", startedAt: 1, executedAt: 2, workspacePath: "/fixture", limitation: null } };

test("uses only the latest review covering this result; absence is not a fabricated outcome", () => {
  const qc = { ...EMPTY_QC_STATE, latestVerdict: "PASS" as const };
  expect(currentOutcomeReview(qc, [review])).toBe(review);
  expect(currentOutcomeReview(qc, [{ ...review, coversLatestOutput: false }])).toBeNull();
  expect(currentOutcomeReview(qc, [review, { ...review, round: 4, status: "pending" }])).toBeNull();
  expect(currentOutcomeReview(qc, [])).toBeNull();
  expect(outcomeExcerpt(null)).toBeNull();
  expect(outcomeExcerpt(" \n ")).toBeNull();
});

test("the everyday excerpt preserves prose and names; the full report is not modified", () => {
  expect(outcomeExcerpt("## Delivered\n- **Added** `clamp_value` and [boundary handling](https://example.invalid)."))
    .toBe("Delivered Added clamp_value and boundary handling.");
  expect(outcomeExcerpt("## Report\n\nNumbers stay within the requested range.\n\nDetailed test discussion follows."))
    .toBe("Numbers stay within the requested range.");
  const long = "Delivered a correct boundary check. " + "A detail for the full report. ".repeat(30);
  expect(outcomeExcerpt(long)!.length).toBeLessThanOrEqual(281);
  expect(outcomeExcerpt(long)).toEndWith("…");
  expect(long.length).toBeGreaterThan(281);
});

test("verified counts require an observed test bound to the reviewed run and current source", () => {
  expect(verifiedOutcomeTestCounts("task", review, evidence)).toEqual({ passed: 3, failed: 0, skipped: 0 });
  expect(verifiedOutcomeTestCounts("task", review, null)).toBeNull();
  expect(verifiedOutcomeTestCounts("task", null, evidence)).toBeNull();
  for (const changed of [
    { ...evidence, developerRunId: "older-implementation" },
    { ...evidence, taskId: "another-task" },
    { ...evidence, observedTestStatus: "blocked" as const },
    { ...evidence, sourceFingerprint: "changed-source" },
    { ...evidence, test: { ...evidence.test!, provenance: "owner-imported-test" as const } },
    { ...evidence, test: { ...evidence.test!, stderr: "All 3 tests passed." } },
    { ...evidence, test: { ...evidence.test!, stderr: " 3 pass\n 0 fail\nRan 5 tests across 1 file. [1ms]\n" } },
    { ...evidence, test: { ...evidence.test!, stderr: "", stdout: "" } },
  ]) expect(verifiedOutcomeTestCounts("task", review, changed)).toBeNull();
});

test("test counts preserve failures and skips, without interpreting them as review or acceptance", () => {
  const withResult = { ...evidence, test: { ...evidence.test!, exitCode: 1,
    stderr: " 2 pass\n 1 skip\n 1 fail\nRan 4 tests across 1 file. [1ms]\n" } };
  expect(verifiedOutcomeTestCounts("task", review, withResult)).toEqual({ passed: 2, failed: 1, skipped: 1 });
  expect(verifiedOutcomeTestCounts("task", { ...review, verdict: "BLOCKED" }, evidence)).toBeNull();
});
