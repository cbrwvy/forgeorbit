import type { OrchestratedBatchRecord } from "./pm-orchestrated-batch.ts";

export type HeadAutoStatus = "draft" | "approved" | "running" | "paused" | "blocked" | "completed" | "cancelled";
export interface HeadAutoPlan {
  initiativeId: string;
  title: string;
  projects: {
    projectPath: string; projectName: string; pmName: string | null; delegationId: string;
    batchId: string; revision: number;
    assignments: { taskId: string; employeeId: string; employeeName: string; revision: number }[];
    tasks: OrchestratedBatchRecord["tasks"];
    policy: NonNullable<OrchestratedBatchRecord["policy"]>;
  }[];
  maxLaunches: number;
  expiresAt: number;
  globalConcurrency: 1;
  continuation: "all_tasks_qc_pass";
  failurePolicy: "stop_no_retry_no_rework";
  quota: "unknown";
}
export interface HeadAutoRecord {
  id: string; initiativeId: string; status: HeadAutoStatus;
  plan: HeadAutoPlan; digest: string;
  authorization: { approvedBy: "owner"; approvedAt: number; digest: string; expiresAt: number } | null;
  currentIndex: number; completedBatchIds: string[]; blocker: string | null;
  reservations: { batchId: string; state: "reserved" | "dispatched" | "completed"; at: number }[];
  history: { at: number; text: string }[];
  createdAt: number; updatedAt: number;
}
export interface HeadAutoView {
  record: HeadAutoRecord | null;
  batches: import("./pm-orchestrated-batch.ts").OrchestratedBatchView[];
}
