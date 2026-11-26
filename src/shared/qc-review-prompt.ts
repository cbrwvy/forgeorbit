/**
 * Assembles the reviewer agent prompt for a supervised QC round.
 */
import type { ProjectRulesSnapshot } from "./types.ts";
import { composeProjectRulesPrompt } from "./project-rules.ts";
import {
  composeEffectiveKnowledgeLaunchPrompt,
  embedEffectiveKnowledgeBodies,
  type KnowledgeSnapshot,
} from "./knowledge/effective.ts";
import type { QcFinding, TaskQcReview } from "./task-quality-control.ts";
import { QC_FEEDBACK_TAG, QC_FINDINGS_TAG, QC_SUMMARY_TAG, QC_VERDICT_TAG } from "./task-quality-control.ts";

export function buildQcReviewPrompt(input: {
  taskTitle: string;
  taskPrompt: string;
  priorFeedback: string | null;
  priorRounds: Array<Pick<TaskQcReview, "round" | "verdict" | "summary" | "feedback">>;
  projectRules: ProjectRulesSnapshot | null;
  knowledgeSnapshot?: KnowledgeSnapshot | null;
  knowledgeBodies?: import("./knowledge/context.ts").KnowledgePromptDocument[];
  diffSummary: string | null;
  artifactsNote: string | null;
  evidenceSection?: string | null;
}): string {
  const rules = input.projectRules
    ? composeProjectRulesPrompt(input.projectRules, "").replace(/\n\nYour task:\n\s*$/, "").trim()
    : null;
  let knowledgeBlock: string | null = null;
  if (input.knowledgeSnapshot && input.knowledgeBodies && input.knowledgeBodies.length > 0) {
    knowledgeBlock = embedEffectiveKnowledgeBodies(
      composeEffectiveKnowledgeLaunchPrompt(input.knowledgeSnapshot, "").replace(/\n\nYour task:\n\s*$/, "").trim(),
      input.knowledgeBodies,
    );
  }
  const prior =
    input.priorRounds.length === 0
      ? "None."
      : input.priorRounds
          .map(
            (r) =>
              `Round ${r.round}: ${r.verdict ?? "unknown"} — ${r.summary ?? "(no summary)"}${r.feedback ? `\nFeedback: ${r.feedback}` : ""}`,
          )
          .join("\n\n");

  return [
    "You are an independent code reviewer for a supervised quality-control round.",
    "Review the implementation against the original task requirements and project rules.",
    "Do not modify files, run shell commands, or start work — produce a structured verdict only.",
    "",
    "Respond with ONLY the following XML-tagged block (no markdown fences):",
    `<${QC_VERDICT_TAG}>PASS|CHANGES_REQUESTED|BLOCKED</${QC_VERDICT_TAG}>`,
    `<${QC_SUMMARY_TAG}>One short paragraph.</${QC_SUMMARY_TAG}>`,
    `<${QC_FINDINGS_TAG}>JSON array of {"severity":"blocker|suggestion|nit|info","text":"..."}</${QC_FINDINGS_TAG}>`,
    `<${QC_FEEDBACK_TAG}>Actionable rework instructions when verdict is CHANGES_REQUESTED; otherwise brief notes.</${QC_FEEDBACK_TAG}>`,
    "",
    "## Task title",
    input.taskTitle,
    "",
    "## Original requirements",
    input.taskPrompt,
    "",
    "## Prior review rounds",
    prior,
    input.priorFeedback
      ? `\n## Open rework feedback (must address)\n${input.priorFeedback}\n`
      : "",
    rules ? `\n## Project rules\n${rules}\n` : "",
    knowledgeBlock ? `\n## Permitted knowledge\n${knowledgeBlock}\n` : "",
    input.diffSummary ? `\n## Implementation diff (summary)\n${input.diffSummary}\n` : "",
    input.artifactsNote ? `\n## Artifacts\n${input.artifactsNote}\n` : "",
    input.evidenceSection ? `\n${input.evidenceSection}\n` : "",
  ].join("\n");
}

export function findingsToBullets(findings: QcFinding[]): string {
  if (findings.length === 0) return "";
  return findings.map((f) => `- [${f.severity}] ${f.text}`).join("\n");
}
