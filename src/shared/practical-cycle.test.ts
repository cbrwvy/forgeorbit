import { expect, test } from "bun:test";
import {
  buildReworkBrief,
  classifyLaunchFailure,
  classifyReviewFailure,
  composePracticalReworkPrompt,
  parseProviderImprovementDraft,
  practicalFailureNeedsOwner,
  practicalFailureReworkable,
} from "./practical-cycle.ts";

test("failure kinds stay separate for rework and owner attention", () => {
  expect(practicalFailureReworkable("test_failed")).toBe(true);
  expect(practicalFailureReworkable("qc_changes_requested")).toBe(true);
  expect(practicalFailureReworkable("missing_evidence")).toBe(true);
  expect(practicalFailureReworkable("implementation_defect")).toBe(true);
  expect(practicalFailureReworkable("provider_failure")).toBe(false);
  expect(practicalFailureNeedsOwner("provider_failure")).toBe(true);
  expect(practicalFailureNeedsOwner("account_unavailable")).toBe(true);
  expect(practicalFailureNeedsOwner("model_unavailable")).toBe(true);
  expect(practicalFailureNeedsOwner("expired_grant")).toBe(true);
  expect(practicalFailureNeedsOwner("workspace_conflict")).toBe(false);
  expect(classifyReviewFailure("The implementation has a bug")).toBe("implementation_defect");
  expect(classifyReviewFailure("missing test evidence")).toBe("missing_evidence");
  expect(classifyReviewFailure("Please revise the names")).toBe("qc_changes_requested");
  expect(classifyLaunchFailure("the grant expired")).toBe("expired_grant");
  expect(classifyLaunchFailure("workspace staging missing")).toBe("workspace_conflict");
  expect(classifyLaunchFailure("ordinary crash")).toBe(null);
});

test("a rework brief keeps the original request and the observed errors", () => {
  const brief = buildReworkBrief({
    kind: "test_failed",
    requirements: "Implement add.",
    diff: "src/add.ts",
    testErrors: "Exit code 1.",
    reviewerFindings: null,
    projectRules: "Keep the tests.",
    brainContext: null,
  });
  expect(brief).toContain("Practical rework context");
  expect(brief).toContain("Failure kind: test_failed");
  expect(brief).toContain("Implement add.");
  expect(brief).toContain("Exit code 1.");
  expect(composePracticalReworkPrompt(null, "Implement add.")).toBe("Implement add.");
  expect(composePracticalReworkPrompt(brief, "Implement add.")).toContain("Approved task:");
});

test("a provider draft must be structured JSON", () => {
  expect(parseProviderImprovementDraft("notes only")).toEqual({ error: "The provider draft was not JSON. No skill text was applied." });
  const parsed = parseProviderImprovementDraft('{"proposedContent":"Do the check.","hypothesis":"It helps.","expectedResult":"Fewer misses."}');
  expect(parsed).toEqual({
    proposedContent: "Do the check.",
    hypothesis: "It helps.",
    expectedResult: "Fewer misses.",
  });
});
