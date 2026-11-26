/**
 * FO-AUTO-PRACTICAL01 — pure rules for the connected development cycle.
 * Failure kinds stay distinct. A command string is not an isolation boundary.
 */
import { createHash } from "node:crypto";
import { REVIEW_EVIDENCE_LIMITS } from "./review-evidence.ts";

export const PRACTICAL_FAILURE_KINDS = [
  "test_failed",
  "qc_changes_requested",
  "missing_evidence",
  "implementation_defect",
  "provider_failure",
  "account_unavailable",
  "model_unavailable",
  "expired_grant",
  "workspace_conflict",
] as const;
export type PracticalFailureKind = (typeof PRACTICAL_FAILURE_KINDS)[number];

export const PRACTICAL_TEST_CONCURRENCY = 1;
export const PRACTICAL_TEST_TIMEOUT_MS = REVIEW_EVIDENCE_LIMITS.testTimeoutMs;
export const PRACTICAL_TEST_OUTPUT_BYTES = REVIEW_EVIDENCE_LIMITS.maxTestOutputBytes;

export const FAKE_PRACTICAL_IMPL_MARKER = "__fo_practical_impl__";
export const FAKE_PRACTICAL_DRAFT_MARKER = "__fo_practical_draft__";
export const PRACTICAL_REWORK_HEADING = "Practical rework context";

const REWORKABLE = new Set<PracticalFailureKind>([
  "test_failed",
  "qc_changes_requested",
  "missing_evidence",
  "implementation_defect",
]);

export function practicalFailureReworkable(kind: PracticalFailureKind): boolean {
  return REWORKABLE.has(kind);
}

export function practicalFailureNeedsOwner(kind: PracticalFailureKind): boolean {
  return kind === "provider_failure" || kind === "account_unavailable" || kind === "model_unavailable" || kind === "expired_grant";
}

export function commandFingerprint(input: { command: string; argv: string[]; cwd: string; executable: string }): string {
  return createHash("sha256").update(JSON.stringify({
    command: input.command,
    argv: input.argv,
    cwd: input.cwd,
    executable: input.executable,
  })).digest("hex");
}

export function practicalEvidenceDigest(input: {
  sourceFingerprint: string;
  commandFingerprint: string;
  exitCode: number | null;
  stdout: string;
  stderr: string;
}): string {
  return createHash("sha256").update(JSON.stringify(input)).digest("hex");
}

export function classifyLaunchFailure(message: string): PracticalFailureKind | null {
  const text = message.toLowerCase();
  if (!text.trim()) return null;
  if (text.includes("expired") || text.includes("grant")) return "expired_grant";
  if (text.includes("account") || text.includes("unauthorized") || text.includes("401") || text.includes("profile")) return "account_unavailable";
  if (text.includes("model not found") || text.includes("unknown model") || text.includes("model_not_found")) return "model_unavailable";
  if (text.includes("usage limit") || text.includes("rate limit") || text.includes("429") || text.includes("provider")) return "provider_failure";
  if (text.includes("workspace") || text.includes("staging")) return "workspace_conflict";
  return null;
}

export function classifyReviewFailure(summary: string | null): PracticalFailureKind {
  const text = summary ?? "";
  if (/implement|defect|incorrect|bug/i.test(text)) return "implementation_defect";
  if (/evidence|missing test|no test/i.test(text)) return "missing_evidence";
  return "qc_changes_requested";
}

export function testSummary(stdout: string, stderr: string, exitCode: number | null): string {
  const lines = `${stdout}\n${stderr}`.split("\n").map((line) => line.trim()).filter(Boolean);
  const tail = lines.slice(-12).join("\n");
  const head = exitCode == null ? "No exit code was observed." : `Exit code ${exitCode}.`;
  return `${head}${tail ? `\n${tail}` : ""}`.slice(0, 2000);
}

export function composePracticalReworkPrompt(brief: string | null, taskPrompt: string): string {
  if (!brief) return taskPrompt;
  return [
    brief,
    "",
    "Approved task:",
    taskPrompt,
  ].join("\n");
}

export interface ReworkBriefInput {
  kind: PracticalFailureKind;
  requirements: string;
  diff: string | null;
  testErrors: string | null;
  reviewerFindings: string | null;
  projectRules: string | null;
  brainContext: string | null;
}

export function buildReworkBrief(input: ReworkBriefInput): string {
  const section = (label: string, value: string | null) => `${label}:\n${(value ?? "none").slice(0, 2000)}`;
  return [
    PRACTICAL_REWORK_HEADING,
    `Failure kind: ${input.kind}`,
    "This is a bounded rework of the same task. Do not repeat steps the evidence already shows are correct.",
    "Re-run only the authorized test after the correction. This text grants no permissions.",
    section("Original requirements", input.requirements),
    section("Previous implementation diff", input.diff),
    section("Observed test errors", input.testErrors),
    section("Reviewer findings", input.reviewerFindings),
    section("Project rules", input.projectRules),
    section("Authorized Brain context", input.brainContext),
  ].join("\n\n").slice(0, 12_000);
}

export interface ProviderDraft {
  proposedContent: string;
  hypothesis: string;
  expectedResult: string;
}

export function parseProviderImprovementDraft(text: string): ProviderDraft | { error: string } {
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start < 0 || end <= start) return { error: "The provider draft was not JSON. No skill text was applied." };
  try {
    const parsed = JSON.parse(text.slice(start, end + 1)) as Record<string, unknown>;
    if (typeof parsed.proposedContent !== "string" || typeof parsed.hypothesis !== "string" || typeof parsed.expectedResult !== "string") {
      return { error: "The provider draft is missing proposedContent, hypothesis, or expectedResult." };
    }
    return {
      proposedContent: parsed.proposedContent,
      hypothesis: parsed.hypothesis,
      expectedResult: parsed.expectedResult,
    };
  } catch {
    return { error: "The provider draft JSON could not be parsed. No skill text was applied." };
  }
}
