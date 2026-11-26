// FO-UX-SIMPLIFY02-M6: one plain-language reading of where a piece of delegated work stands.
// Pure: it only re-reads fields the task row already carries (column, QC state) through the
// existing supervised-workflow phase model. It never infers progress from agent prose, never
// counts an unknown as a pass, and never decides anything the server rules do not already allow.
import { deriveSupervisedLivePhase, type SupervisedLivePhase } from "../../shared/supervised-live-workflow.ts";
import type { Task } from "../../shared/types.ts";

/** What the quality check says. "not-run" is a real answer: nobody asked for one yet. */
export type QcOutcome = "not-run" | "running" | "passed" | "failed" | "blocked";

type JourneyTask = Pick<Task, "id" | "title" | "column" | "archivedAt" | "agent" | "model" | "runId" | "qcState" | "updatedAt" | "pipelineParentId">;

export function qcOutcomeOf(task: Pick<Task, "qcState">): QcOutcome {
  const qc = task.qcState;
  if (!qc) return "not-run";
  if (qc.activeReviewId) return "running";
  if (qc.latestVerdict === "PASS") return "passed";
  if (qc.latestVerdict === "CHANGES_REQUESTED") return "failed";
  if (qc.latestVerdict === "BLOCKED") return "blocked";
  return "not-run";
}

export interface JourneyRow {
  taskId: string;
  phase: SupervisedLivePhase;
  qc: QcOutcome;
  /** The Owner has to do something here (decide, confirm, unblock or accept). */
  needsYou: boolean;
  /** Something is running right now. */
  active: boolean;
  /** "Accept result" is allowed by the existing rule: QC passed and only the Owner is left. */
  canAccept: boolean;
}

export function journeyRowOf(task: JourneyTask): JourneyRow {
  const phase = deriveSupervisedLivePhase({
    task,
    hasAssignment: false,
    employeeRunPhase: null,
    runLive: task.column === "running",
    runStarting: false,
  });
  const qc = qcOutcomeOf(task);
  const canAccept = phase === "awaiting-owner-acceptance" && task.archivedAt == null && task.pipelineParentId == null;
  const needsYou = canAccept || phase === "blocked" || phase === "awaiting-owner-confirm";
  return {
    taskId: task.id,
    phase,
    qc,
    needsYou,
    active: phase === "implementation-active" || phase === "qc-active",
    canAccept,
  };
}

/** Most pressing first: needs the Owner, then running, then the rest by recency, finished last. */
export function journeyOrder<T extends JourneyTask>(tasks: readonly T[]): { task: T; row: JourneyRow }[] {
  const rank = (row: JourneyRow): number => (row.needsYou ? 0 : row.active ? 1 : row.phase === "done" ? 3 : 2);
  return tasks
    .map((task) => ({ task, row: journeyRowOf(task) }))
    .sort((a, b) => rank(a.row) - rank(b.row) || b.task.updatedAt - a.task.updatedAt);
}
