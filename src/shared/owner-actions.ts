// Shape of GET /owner-actions (FO-UX02-E). Shared so the webview and the core agree.
export interface OwnerActionRow {
  projectPath: string;
  id: string;
  title: string;
}
export interface BatchHoldRow extends OwnerActionRow {
  status: "paused" | "approved" | "stopped";
}
export interface OrchestratedWorkflowHoldRow extends OwnerActionRow {
  status: "paused" | "awaiting_owner" | "exhausted" | "expired";
  taskId: string;
}
export interface DeploymentRequestHoldRow extends OwnerActionRow {
  environment: "staging" | "production";
  clusterId: string;
}
export interface DeploymentExecutionAuthHoldRow extends OwnerActionRow {
  environment: "staging";
  clusterId: string;
}
export interface OrchestratedBatchHoldRow extends OwnerActionRow {
  status: "paused" | "approved" | "stopped";
  reason: string | null;
}
export interface MemoryProposalActionRow extends OwnerActionRow {
  managerKind: "project-manager" | "head-of-pm";
  scopeKind: "company" | "project";
}
/** A hands-off ("Work independently") task that stopped on a real decision. One row per blocked task. */
export interface HandsoffAttentionRow extends OwnerActionRow {
  taskId: string;
  code: string;
  message: string;
  action: "retry" | "open-settings" | "open-task" | "open-accounts";
}
export interface OwnerActionsPayload {
  /** Hands-off tasks waiting on a real Owner decision. Work in progress or waiting for a slot is not listed. */
  handsoffBlockers?: HandsoffAttentionRow[];
  /** Pending project permission requests (run one project test). Allow once / Deny happen on these rows. */
  projectPermissionRequests?: import("./project-permissions.ts").ProjectPermissionRequestRow[];
  proposals: OwnerActionRow[];
  memoryProposals?: MemoryProposalActionRow[];
  delegations: OwnerActionRow[];
  batchHolds: BatchHoldRow[];
  orchestratedWorkflowHolds?: OrchestratedWorkflowHoldRow[];
  orchestratedBatchHolds?: OrchestratedBatchHoldRow[];
  deploymentRequestHolds?: DeploymentRequestHoldRow[];
  deploymentExecutionAuthHolds?: DeploymentExecutionAuthHoldRow[];
}
