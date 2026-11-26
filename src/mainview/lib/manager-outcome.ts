import type { TaskQcReview, TaskQcState } from "../../shared/types";
import type { ReviewEvidenceTest } from "../../shared/review-evidence";

/** The read-only slice of the existing QC evidence preview used by the card. */
export interface OutcomeTestEvidence {
  taskId: string;
  developerRunId: string | null;
  sourceFingerprint: string | null;
  observedTestStatus: "observed" | "missing" | "blocked";
  test: ReviewEvidenceTest | null;
}
export interface OutcomeTestCounts { passed: number; failed: number; skipped: number }

export function currentOutcomeReview(qc: TaskQcState | null | undefined, reviews: readonly TaskQcReview[]): TaskQcReview | null {
  const latest = [...reviews].sort((a, b) => b.round - a.round)[0];
  return latest?.coversLatestOutput && latest.status === "complete" && latest.verdict === qc?.latestVerdict ? latest : null;
}

/** Keep the recorded summary's words; remove formatting and bound the everyday excerpt. */
export function outcomeExcerpt(summary: string | null | undefined): string | null {
  const introduction = summary?.trim().replace(/^(?:#{1,6} [^\n]*\n\s*\n)+/, "").split(/\n\s*\n/)[0];
  const plain = introduction?.replace(/\[([^\]]+)\]\([^\n)]+\)/g, "$1")
    .replace(/^[ \t]*(?:#{1,6} |[-*>] )/gm, "")
    .replace(/`([^`]+)`/g, "$1").replace(/\*\*([^*]+)\*\*/g, "$1").replace(/__([^_]+)__/g, "$1")
    .replace(/\s+/g, " ").trim();
  if (!plain) return null;
  if (plain.length <= 280) return plain;
  const end = plain.lastIndexOf(" ", 280);
  return `${plain.slice(0, end > 0 ? end : 280).trimEnd()}…`;
}

/** Counts come only from a current, ForgeOrbit-observed Bun test footer, never review prose or exit 0 alone. */
export function verifiedOutcomeTestCounts(taskId: string, review: TaskQcReview | null, evidence: OutcomeTestEvidence | null): OutcomeTestCounts | null {
  const test = evidence?.test;
  if (!review || review.taskId !== taskId || !review.coversLatestOutput || review.status !== "complete" || review.verdict !== "PASS"
    || evidence?.taskId !== taskId || evidence.observedTestStatus !== "observed"
    || !review.implementationRunId || evidence.developerRunId !== review.implementationRunId
    || !evidence.sourceFingerprint || !test || test.sourceFingerprint !== evidence.sourceFingerprint
    || test.provenance !== "forgeorbit-observed-test") return null;
  for (const output of [test.stderr, test.stdout]) {
    const plain = output.replace(/\x1b\[[0-9;]*m/g, "").replace(/\r/g, "");
    const footer = plain.match(/(?:^|\n)\s*(\d+) pass\n(?:\s*(\d+) skip\n)?\s*(\d+) fail\n(?:\s*\d+ expect\(\) calls\n)?\s*Ran (\d+) tests? across \d+ files?\.[^\n]*\s*$/);
    if (!footer) continue;
    const counts = { passed: Number(footer[1]), failed: Number(footer[3]), skipped: Number(footer[2] ?? 0) };
    if (Object.values(counts).every(Number.isSafeInteger)
      && counts.passed + counts.failed + counts.skipped === Number(footer[4])
      && (test.exitCode !== 0 || counts.failed === 0)) return counts;
  }
  return null;
}
