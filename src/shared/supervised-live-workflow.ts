/**
 * FO-LIVE01 — supervised Owner → PM → implementer → reviewer → Owner workflow.
 * Pure derivation from persisted task state; never invents transitions.
 */
import { columnBlockReason } from "./project-execution.ts";
import { qcAttentionKind, type TaskQcState } from "./task-quality-control.ts";
import type { ColumnId, Task } from "./types.ts";
import type { EmployeeRunPhase } from "./execution/run.ts";

export const SUPERVISED_LIVE_STEPS = [
  "intake",
  "inbox",
  "ready",
  "implementer",
  "authorize-run",
  "implement",
  "request-qc",
  "qc-run",
  "owner-accept",
  "done",
] as const;
export type SupervisedLiveStepId = (typeof SUPERVISED_LIVE_STEPS)[number];

export type SupervisedLiveStepStatus = "done" | "current" | "upcoming" | "blocked";

export interface SupervisedLiveStep {
  id: SupervisedLiveStepId;
  status: SupervisedLiveStepStatus;
}

export type SupervisedLivePhase =
  | "backlog-draft"
  | "inbox-triage"
  | "ready-prepare"
  | "awaiting-owner-confirm"
  | "implementation-active"
  | "awaiting-qc"
  | "qc-active"
  | "awaiting-owner-acceptance"
  | "rework-ready"
  | "done"
  | "blocked";

export interface SupervisedLiveInputs {
  task: Pick<
    Task,
    "id" | "column" | "archivedAt" | "agent" | "model" | "runId" | "qcState"
  >;
  hasAssignment: boolean;
  employeeRunPhase: EmployeeRunPhase | null;
  runLive: boolean;
  runStarting: boolean;
}

export interface SupervisedLiveView {
  phase: SupervisedLivePhase;
  ownerAction: string | null;
  columnBlock: string | null;
  steps: SupervisedLiveStep[];
  qcAttention: ReturnType<typeof qcAttentionKind>;
}

function qcOf(task: SupervisedLiveInputs["task"]): TaskQcState | null {
  return task.qcState ?? null;
}

export function deriveSupervisedLivePhase(input: SupervisedLiveInputs): SupervisedLivePhase {
  const { task } = input;
  if (task.archivedAt != null) return "done";
  if (task.column === "done") return "done";
  if (task.column === "blocked") return "blocked";
  const qc = qcOf(task);
  if (task.column === "backlog") return "backlog-draft";
  if (task.column === "inbox") return "inbox-triage";
  if (task.column === "running" || input.runLive || input.runStarting) return "implementation-active";
  if (task.column === "review") {
    if (qc?.activeReviewId) return "qc-active";
    if (qc?.awaitingOwnerApproval && qc.latestVerdict === "PASS") return "awaiting-owner-acceptance";
    if ((qc?.roundCount ?? 0) === 0) return "awaiting-qc";
    if (qc?.latestVerdict === "CHANGES_REQUESTED") return "awaiting-qc";
    if (qc?.latestVerdict === "BLOCKED") return "awaiting-qc";
    return "awaiting-qc";
  }
  if (task.column === "ready") {
    if (qc?.latestVerdict === "CHANGES_REQUESTED") return "rework-ready";
    if (input.employeeRunPhase === "awaiting-approval") return "awaiting-owner-confirm";
    if (input.employeeRunPhase === "starting" || input.employeeRunPhase === "running") return "implementation-active";
    return "ready-prepare";
  }
  return "ready-prepare";
}

export function ownerActionForSupervisedLive(phase: SupervisedLivePhase, input: SupervisedLiveInputs): string | null {
  switch (phase) {
    case "backlog-draft":
      return "Admit this task to the project inbox or approve a PM proposal into Backlog first.";
    case "inbox-triage":
      return "Triage with the project manager, then move the task to Ready when it should run.";
    case "ready-prepare":
      if (!input.hasAssignment) return "Assign an implementer (AI employee) before authorized execution.";
      return "Choose harness and model, run preflight, then confirm to start implementation.";
    case "awaiting-owner-confirm":
      return "Confirm the prepared employee run to start implementation.";
    case "rework-ready":
      return "Address review feedback, then authorize a new implementation run.";
    case "awaiting-qc":
      return "Request an independent AI quality review when implementation succeeded.";
    case "qc-active":
      return null;
    case "awaiting-owner-acceptance":
      return "Inspect the QC verdict and mark the task done when you accept the result.";
    case "implementation-active":
      return null;
    case "blocked":
      return "Open the run and answer or unblock the agent.";
    case "done":
      return null;
  }
}

function stepStatus(index: number, currentIndex: number, blockedBefore: boolean): SupervisedLiveStepStatus {
  if (blockedBefore && index >= currentIndex) return "blocked";
  if (index < currentIndex) return "done";
  if (index === currentIndex) return "current";
  return "upcoming";
}

export function supervisedLiveSteps(phase: SupervisedLivePhase): SupervisedLiveStep[] {
  const indexFor: Record<SupervisedLivePhase, number> = {
    "backlog-draft": 0,
    "inbox-triage": 1,
    "ready-prepare": 2,
    "awaiting-owner-confirm": 4,
    "implementation-active": 5,
    "awaiting-qc": 6,
    "qc-active": 7,
    "awaiting-owner-acceptance": 8,
    "rework-ready": 4,
    done: 9,
    blocked: 5,
  };
  const current = indexFor[phase];
  const blocked = phase === "blocked";
  return SUPERVISED_LIVE_STEPS.map((id, i) => ({
    id,
    status: stepStatus(i, current, blocked && i >= 5),
  }));
}

export function buildSupervisedLiveView(input: SupervisedLiveInputs): SupervisedLiveView {
  const phase = deriveSupervisedLivePhase(input);
  const columnBlock =
    phase === "backlog-draft" || phase === "inbox-triage"
      ? columnBlockReason(input.task.column as ColumnId)
      : phase === "ready-prepare" || phase === "rework-ready"
        ? null
        : null;
  return {
    phase,
    ownerAction: ownerActionForSupervisedLive(phase, input),
    columnBlock,
    steps: supervisedLiveSteps(phase),
    qcAttention: qcAttentionKind(input.task.qcState ?? null, input.task.column),
  };
}
