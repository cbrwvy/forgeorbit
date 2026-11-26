/**
 * FO-HEAD01 — read-only cross-project coordination facts for Head of PM.
 * Bounded summaries only; no task bodies or run logs.
 */

import type { ColumnId } from "./types.ts";
import type { DelegationStatus } from "./portfolio-manager.ts";

export interface HeadPmClusterRow {
  id: string;
  name: string;
  projectPaths: string[];
}

export interface HeadPmProjectManagerRow {
  employeeId: string;
  name: string;
  jobTitle: string;
}

export interface HeadPmProjectRow {
  projectPath: string;
  projectName: string;
  clusterId: string | null;
  clusterName: string | null;
  projectManager: HeadPmProjectManagerRow | null;
  managerConfigured: boolean;
  managerProblem: string | null;
  columns: Partial<Record<ColumnId, number>>;
  pendingProposals: number;
  activeWorkflows: HeadPmActiveWorkflowRow[];
}

export interface HeadPmActiveWorkflowRow {
  id: string;
  taskId: string;
  title: string;
  status: string;
  phase: string;
}

export interface HeadPmDelegationRow {
  id: string;
  projectPath: string;
  projectName: string;
  objective: string;
  status: DelegationStatus;
}

export interface HeadPmOwnerQueueRow {
  pendingProposals: number;
  pendingDelegations: number;
  batchHolds: number;
  orchestratedHolds: number;
}

export interface HeadPmCoordinationSnapshot {
  capturedAt: number;
  headBound: boolean;
  headName: string | null;
  clusters: HeadPmClusterRow[];
  unassignedProjectPaths: string[];
  projects: HeadPmProjectRow[];
  delegations: HeadPmDelegationRow[];
  ownerQueue: HeadPmOwnerQueueRow;
}
