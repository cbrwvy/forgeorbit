/**
 * Supervised quality control (FO-QC01) — shared verdict shape, parsing, and limits.
 * Review runs must emit a machine-readable block; prompts alone never change task state.
 */
import type { ColumnId, QcExtension } from "./types.ts";
export type { QcExtension } from "./types.ts";

export const QC_VERDICTS = ["PASS", "CHANGES_REQUESTED", "BLOCKED"] as const;
export type QcVerdict = (typeof QC_VERDICTS)[number];

export const QC_LIMITS = {
  maxRounds: 5,
  summaryMax: 4000,
  findingMax: 2000,
  maxFindings: 30,
} as const;

export const QC_VERDICT_TAG = "qc_verdict";
export const QC_SUMMARY_TAG = "qc_summary";
export const QC_FINDINGS_TAG = "qc_findings";
export const QC_FEEDBACK_TAG = "qc_feedback";

/** Marker for the fake claude driver — suffix `:PASS`, `:CHANGES_REQUESTED`, or `:BLOCKED`. */
export const FAKE_QC_REVIEW_PROMPT_MARKER = "__agetor_fake_qc_review__";
/** Fixture reviewers only: an optional summary line for the fake verdict (percent-encoded). A real reviewer writes its own. */
export const FAKE_QC_SUMMARY_PROMPT_MARKER = "__agetor_fake_qc_summary__";

export interface QcFinding {
  severity: "blocker" | "suggestion" | "nit" | "info";
  text: string;
}

export type QcReviewEvidenceState = "complete" | "missing-test" | "missing-source";

export interface TaskQcReview {
  id: string;
  taskId: string;
  projectPath: string;
  round: number;
  status: "pending" | "running" | "complete" | "cancelled";
  verdict: QcVerdict | null;
  summary: string | null;
  findings: QcFinding[];
  feedback: string | null;
  reviewerEmployeeId: string | null;
  reviewerRoleSlug: string | null;
  reviewerHarness: string;
  reviewerModel: string;
  reviewerProfileId: string | null;
  implementationRunId: string | null;
  reviewRunId: string | null;
  evidenceState?: QcReviewEvidenceState | null;
  requestedAt: number;
  startedAt: number | null;
  completedAt: number | null;
}

/** Denormalized task-level QC summary (persisted JSON on the task row). */
export interface TaskQcState {
  activeReviewId: string | null;
  awaitingOwnerApproval: boolean;
  latestVerdict: QcVerdict | null;
  reworkCount: number;
  roundCount: number;
  /** The base limit, plus one while an Owner extension exists. */
  maxRounds: number;
  extension?: QcExtension | null;
}

export const EMPTY_QC_STATE: TaskQcState = {
  activeReviewId: null,
  awaitingOwnerApproval: false,
  latestVerdict: null,
  reworkCount: 0,
  roundCount: 0,
  maxRounds: QC_LIMITS.maxRounds,
  extension: null,
};

export function parseQcExtension(raw: unknown): QcExtension | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const r = raw as Record<string, unknown>;
  if (typeof r.authorizedAt !== "number" || !Number.isFinite(r.authorizedAt)) return null;
  if (typeof r.baseRound !== "number" || r.baseRound < 0) return null;
  const verdict = r.baseVerdict;
  return {
    authorizedAt: r.authorizedAt,
    authorizedBy: "owner",
    baseRound: Math.trunc(r.baseRound),
    baseVerdict: QC_VERDICTS.includes(verdict as QcVerdict) ? (verdict as QcVerdict) : null,
    reviewId: typeof r.reviewId === "string" && r.reviewId ? r.reviewId : null,
    outcome: r.outcome === "none" ? "none" : QC_VERDICTS.includes(r.outcome as QcVerdict) ? (r.outcome as QcVerdict) : null,
  };
}

/** Record how the additional review ended on the state, when `reviewId` is the review that consumed the extension. */
export function withExtensionOutcome(state: TaskQcState, reviewId: string, outcome: QcVerdict | "none"): TaskQcState {
  if (!state.extension || state.extension.reviewId !== reviewId) return state;
  return { ...state, extension: { ...state.extension, outcome } };
}

export function parseQcState(raw: unknown): TaskQcState {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return { ...EMPTY_QC_STATE };
  const r = raw as Record<string, unknown>;
  const latest = r.latestVerdict;
  const extension = parseQcExtension(r.extension);
  return {
    activeReviewId: typeof r.activeReviewId === "string" ? r.activeReviewId : null,
    awaitingOwnerApproval: r.awaitingOwnerApproval === true,
    latestVerdict: QC_VERDICTS.includes(latest as QcVerdict) ? (latest as QcVerdict) : null,
    reworkCount: typeof r.reworkCount === "number" && r.reworkCount >= 0 ? Math.trunc(r.reworkCount) : 0,
    roundCount: typeof r.roundCount === "number" && r.roundCount >= 0 ? Math.trunc(r.roundCount) : 0,
    maxRounds: QC_LIMITS.maxRounds + (extension ? 1 : 0),
    extension,
  };
}

export function parseQcFinding(raw: unknown): QcFinding | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const r = raw as Record<string, unknown>;
  if (typeof r.text !== "string" || !r.text.trim()) return null;
  const sev = r.severity;
  const severity =
    sev === "blocker" || sev === "suggestion" || sev === "nit" || sev === "info" ? sev : "suggestion";
  return { severity, text: r.text.trim().slice(0, QC_LIMITS.findingMax) };
}

export function parseQcVerdictFromText(text: string): {
  verdict: QcVerdict | null;
  summary: string | null;
  findings: QcFinding[];
  feedback: string | null;
} {
  const verdictMatch = text.match(new RegExp(`<${QC_VERDICT_TAG}>\\s*(PASS|CHANGES_REQUESTED|BLOCKED)\\s*</${QC_VERDICT_TAG}>`, "i"));
  const verdict = verdictMatch?.[1]?.toUpperCase() as QcVerdict | undefined;
  const normalized = verdict && QC_VERDICTS.includes(verdict) ? verdict : null;

  const summaryMatch = text.match(new RegExp(`<${QC_SUMMARY_TAG}>([\\s\\S]*?)</${QC_SUMMARY_TAG}>`, "i"));
  const summary = summaryMatch?.[1]?.trim().slice(0, QC_LIMITS.summaryMax) ?? null;

  const feedbackMatch = text.match(new RegExp(`<${QC_FEEDBACK_TAG}>([\\s\\S]*?)</${QC_FEEDBACK_TAG}>`, "i"));
  const feedback = feedbackMatch?.[1]?.trim().slice(0, QC_LIMITS.summaryMax) ?? null;

  const findings: QcFinding[] = [];
  const findingsMatch = text.match(new RegExp(`<${QC_FINDINGS_TAG}>([\\s\\S]*?)</${QC_FINDINGS_TAG}>`, "i"));
  if (findingsMatch?.[1]) {
    const body = findingsMatch[1].trim();
    try {
      const parsed = JSON.parse(body) as unknown;
      if (Array.isArray(parsed)) {
        for (const item of parsed) {
          const f = parseQcFinding(item);
          if (f) findings.push(f);
          if (findings.length >= QC_LIMITS.maxFindings) break;
        }
      }
    } catch {
      for (const line of body.split("\n").map((l) => l.trim()).filter(Boolean)) {
        findings.push({ severity: "suggestion", text: line.slice(0, QC_LIMITS.findingMax) });
        if (findings.length >= QC_LIMITS.maxFindings) break;
      }
    }
  }

  return { verdict: normalized, summary, findings, feedback };
}

export function formatQcVerdictBlock(input: {
  verdict: QcVerdict;
  summary: string;
  findings?: QcFinding[];
  feedback?: string | null;
}): string {
  const findingsJson = JSON.stringify(input.findings ?? [], null, 2);
  const parts = [
    `<${QC_VERDICT_TAG}>${input.verdict}</${QC_VERDICT_TAG}>`,
    `<${QC_SUMMARY_TAG}>${input.summary.trim()}</${QC_SUMMARY_TAG}>`,
    `<${QC_FINDINGS_TAG}>${findingsJson}</${QC_FINDINGS_TAG}>`,
  ];
  if (input.feedback?.trim()) {
    parts.push(`<${QC_FEEDBACK_TAG}>${input.feedback.trim()}</${QC_FEEDBACK_TAG}>`);
  }
  return parts.join("\n");
}

/**
 * True when every review round is used and the last word is not a PASS: no further review will start,
 * so the task needs the Owner's decision instead of another loop. A PASS waiting for the Owner is not a limit case.
 */
export function qcRoundLimitReached(qc: TaskQcState | null | undefined): boolean {
  if (!qc || qc.activeReviewId) return false;
  return qc.roundCount >= qc.maxRounds && qc.latestVerdict !== "PASS";
}

/**
 * Whether the Owner may authorize one additional review round: the task is Blocked because every round is used
 * without a PASS, and no extension was ever authorized for it. The result says why not when it is not eligible.
 */
export function qcExtensionEligibility(qc: TaskQcState | null | undefined, column: ColumnId): { eligible: boolean; reason: string | null } {
  if (!qc || qc.roundCount === 0) return { eligible: false, reason: "This task has not used its review rounds." };
  if (qc.extension) return { eligible: false, reason: qc.extension.reviewId ? "The one additional review round was already used for this task." : "One additional review round is already authorized for this task." };
  if (qc.activeReviewId) return { eligible: false, reason: "A quality review is still in progress." };
  if (!qcRoundLimitReached(qc)) return { eligible: false, reason: "The review rounds are not used up." };
  if (column !== "blocked" && column !== "review") return { eligible: false, reason: "The task is not Blocked or in Review." };
  return { eligible: true, reason: null };
}

/**
 * The common acceptance rule. A task that never entered QC (no review round) is the Owner's own decision, as before.
 * A task that entered QC reaches Done only with a fresh PASS covering the current output:
 *  - a review in progress, or CHANGES_REQUESTED / BLOCKED, refuses Done from every column;
 *  - so does the absence of a verdict (the Reviewer process failed, or new output withdrew an earlier PASS): no verdict
 *    is never read as a pass, and none is invented;
 *  - the one additional round, if it ended without a PASS, refuses Done too.
 * A Reviewer process that exited 0 is not acceptance. Every route to Done calls this one function.
 */
export function canOwnerApproveDone(qc: TaskQcState | null | undefined, _column?: ColumnId): string | null {
  if (qc?.activeReviewId) return "A quality review is still in progress.";
  // The one additional round ended without a PASS (a verdict that is not PASS, or no verdict at all): no override.
  if (qc?.extension?.reviewId && qc.extension.outcome && qc.extension.outcome !== "PASS") {
    return "The one additional review round ended without a PASS. No further review will start; this task needs your decision.";
  }
  if (qc && qcRoundLimitReached(qc)) {
    return qc.latestVerdict === null
      ? `All ${qc.maxRounds} review rounds are used and the last review produced no verdict. Done needs a fresh PASS; this task needs your decision.`
      : `All ${qc.maxRounds} review rounds are used and the last verdict is not a PASS. No further review will start; this task needs your decision.`;
  }
  if (qc?.latestVerdict === "CHANGES_REQUESTED") return "Address the requested changes and run implementation again before marking done.";
  if (qc?.latestVerdict === "BLOCKED") return "The last review could not verify the work. Request another review or inspect manually.";
  if (!qc || qc.roundCount === 0) return null;
  if (qc.latestVerdict === "PASS") return null;
  return "No review verdict covers the current output (the last review produced no verdict, or the output changed after a PASS). Done needs a fresh PASS.";
}

export function qcAttentionKind(qc: TaskQcState | null | undefined, column: ColumnId): "qc-owner" | null {
  if (column !== "review" || !qc?.awaitingOwnerApproval || qc.activeReviewId) return null;
  if (qc.latestVerdict === "PASS") return "qc-owner";
  return null;
}
