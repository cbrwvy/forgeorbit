import type { BadgeProps } from "@/components/ui/badge";
import type { Task } from "../../shared/types";
import { canOwnerApproveDone, qcRoundLimitReached } from "../../shared/task-quality-control";

export type ManagerTaskStage = "draft" | "triage" | "ready" | "running" | "reviewing" | "needs-review" | "acceptance" | "blocked" | "returned" | "accepted" | "archived";
export type ManagerTaskAction = "admit" | "ready" | "setup" | "answer" | "review" | "accept" | null;
export interface ManagerTaskView { stage: ManagerTaskStage; action: ManagerTaskAction; needsDecision: boolean }

export const managerStageTone: Record<ManagerTaskStage, BadgeProps["variant"]> = {
  draft: "secondary",
  triage: "warning",
  ready: "secondary",
  running: "info",
  reviewing: "info",
  "needs-review": "warning",
  acceptance: "warning",
  blocked: "warning",
  returned: "warning",
  accepted: "success",
  archived: "secondary",
};

/** Presentation only. Never infers a review verdict from process success. */
export function managerTaskView(task: Pick<Task, "column" | "archivedAt" | "qcState" | "pendingInteractionCount">): ManagerTaskView {
  const view = (stage: ManagerTaskStage, action: ManagerTaskAction = null, needsDecision = false): ManagerTaskView => ({ stage, action, needsDecision });
  if (task.archivedAt != null) return view("archived");
  if (task.column === "done") return view("accepted");
  const qc = task.qcState;
  if (task.pendingInteractionCount > 0) return view("blocked", "answer", true);
  if (qc?.activeReviewId) return view("reviewing");
  if (task.column === "running") return view("running");
  if (task.column === "blocked" || (task.column === "review" && (qc?.latestVerdict === "BLOCKED" || qcRoundLimitReached(qc)))) return view("blocked", "answer", true);
  if (task.column === "review") {
    if (qc?.awaitingOwnerApproval && qc.latestVerdict === "PASS" && !canOwnerApproveDone(qc, task.column)) return view("acceptance", "accept", true);
    return view("needs-review", "review", true);
  }
  if (task.column === "ready") {
    // Moving an unaccepted result back to Ready is the existing return transition. It clears the
    // acceptance flag, so a PASS in Ready is a returned result (rows returned before that still carry the flag).
    if (qc?.latestVerdict === "CHANGES_REQUESTED" || (qc?.latestVerdict === "PASS" && (qc.roundCount ?? 0) > 0)) return view("returned", "setup", true);
    return view("ready", "setup");
  }
  return task.column === "backlog" ? view("draft", "admit") : view("triage", "ready", true);
}
