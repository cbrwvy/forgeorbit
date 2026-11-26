/**
 * Owner-facing execution labels derived from mission and task facts.
 * A completed Developer run is not a completed task. A text result is not QC PASS.
 */
export type OwnerExecutionState =
  | "resource-recommended"
  | "resource-allocated"
  | "owner-approval-pending"
  | "execution-authorized"
  | "execution-blocked"
  | "provider-starting"
  | "provider-running"
  | "developer-completed"
  | "reviewer-pending"
  | "reviewer-running"
  | "qc-failed"
  | "changes-requested"
  | "rework-running"
  | "qc-passed"
  | "owner-acceptance-pending"
  | "task-done"
  | "provider-interrupted"
  | "provider-cancelled"
  | "provider-failed";

export function ownerExecutionState(input: {
  phase?: string | null;
  column?: string | null;
  reworkEpoch?: number | null;
  runStatus?: string | null;
  qcVerdict?: string | null;
  live?: boolean;
}): OwnerExecutionState {
  const phase = input.phase ?? "";
  const column = input.column ?? "";
  const epoch = input.reworkEpoch ?? 0;
  if (column === "done" || phase === "completed") return "task-done";
  if (phase === "cancelled" || input.runStatus === "cancelled") return "provider-cancelled";
  if (input.runStatus === "orphaned" || phase === "interrupted") return "provider-interrupted";
  if (input.qcVerdict === "CHANGES_REQUESTED" && phase !== "running" && phase !== "qc_running" && phase !== "starting") return "changes-requested";
  if (phase === "failed") return input.qcVerdict && input.qcVerdict !== "PASS" ? "qc-failed" : "provider-failed";
  if (phase === "blocked") return "execution-blocked";
  if (phase === "awaiting_owner") return "owner-acceptance-pending";
  if (phase === "qc_running") return "reviewer-running";
  if (phase === "awaiting_qc") return "reviewer-pending";
  if ((phase === "running" || input.live) && epoch > 0) return "rework-running";
  if (phase === "running" || input.live) return "provider-running";
  if (phase === "starting" || phase === "reserved") return "provider-starting";
  if (input.qcVerdict === "PASS" && column === "review") return "qc-passed";
  if (column === "review") return "developer-completed";
  if (epoch > 0 && (phase === "authorized" || phase === "planned" || column === "ready")) return "changes-requested";
  if (phase === "authorized") return "execution-authorized";
  if (phase === "planned") return "resource-allocated";
  return "resource-recommended";
}
