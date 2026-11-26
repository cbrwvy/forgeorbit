export const OBJECTIVE_MISSION_PROMPT_PREFIX = "You are ForgeOrbit’s Head of PM. Propose a two-project development mission.";

export type MissionStatus =
  | "draft"
  | "planned"
  | "authorized"
  | "running"
  | "paused"
  | "completed"
  | "failed"
  | "cancelled";

export type MissionTaskPhase =
  | "planned"
  | "authorized"
  | "blocked"
  | "reserved"
  | "starting"
  | "running"
  | "awaiting_qc"
  | "qc_running"
  | "awaiting_owner"
  | "completed"
  | "failed"
  | "cancelled";

export type MissionTaskPriority = "critical" | "high" | "normal" | "low";

export type DependencyCondition = "qc_pass" | "done" | "awaiting_owner";

export interface MissionTaskDependencyRef {
  taskId: string;
  projectPath: string;
  condition: DependencyCondition;
}

export interface MissionTaskDependency {
  id?: string;
  missionId: string;
  taskId: string;
  projectPath: string;
  dependsOnTaskId: string;
  dependsOnProjectPath: string;
  condition: DependencyCondition;
  satisfiedAt?: number | null;
  createdAt?: number;
}

export interface MissionConcurrencyLimits {
  globalMax: number;
  perProjectMax: number;
  perAccountMax: number;
  perClusterMax?: number;
}

export interface MissionExecutionPolicy {
  qcRequired: boolean;
  autoResumeOnQcPass: boolean;
  maxRetriesPerTask: number;
}

export interface MissionStageResource {
  harnessId: string;
  modelId: string;
  accountId: string;
  mode: string;
  fingerprint: string;
  revision: number;
}

export type ObjectiveBlocker = "developer" | "reviewer" | "developer-account" | "reviewer-account" | "working-copy" | "project" | "artifact" | "accept" | "publish" | "test" | "permission" | "source" | "stopped" | "account-slot" | "worker-slot";

export interface ObjectiveTaskSpec {
  description: string;
  deliverable: string;
  artifactPath?: string;
  projectAddedAt: number;
  developerName?: string;
  reviewerName?: string;
  reviewerId?: string;
}

export type MissionAccountLimit = {
  role: "developer" | "reviewer";
  accountId: string | null;
  accountLabel: string;
  resetAt: number | null;
} & (
  | { refusal: import("../provider-refusal.ts").ProviderRefusalSummary }
  | { windows: import("../accounts/resolve.ts").ExhaustedQuotaWindow[] }
);

export interface MissionTaskPlan {
  taskId: string;
  taskTitle: string;
  projectPath: string;
  clusterId?: string;
  specialistRole: string; // e.g. "developer", "reviewer", "devops", "research"
  assignedEmployeeId?: string;
  priority: MissionTaskPriority;
  dependencies: MissionTaskDependencyRef[];
  harnessId: string;
  modelId: string;
  accountId?: string;
  mode: string;
  qcRequired: boolean;
  developerBinding?: MissionStageResource;
  reviewerBinding?: MissionStageResource;
  objectiveTask?: ObjectiveTaskSpec;
  objectiveBlockers?: ObjectiveBlocker[];
  resultSummary?: string;
  pendingLaunch?: { role: "developer" | "reviewer"; operationId: string; usageNotice?: boolean };
  phase: MissionTaskPhase;
  phaseReason?: string;
  accountLimit?: MissionAccountLimit;
  blockedStage?: "developer" | "reviewer";
  /**
   * Recovery required after a restart or interruption, recorded by the scheduler and cleared only when the Owner
   * re-arms the task: `interrupted-launch` = a launch was reserved but no run was recorded; `uncertain-outcome` =
   * a run was recorded and its outcome is unknown. Neither is retried by the scheduler.
   */
  recovery?: "interrupted-launch" | "uncertain-outcome";
  /**
   * Why the task is not running, recorded by the scheduler at the point it decides (never inferred from the reason text):
   * a dependency, a worker slot, a stopped project, the Owner, or a recovery that needs the Owner.
   */
  waitingOn?: "dependency" | "slot" | "project-stopped" | "owner" | "recovery" | "quota" | "scheduled";
  runId?: string;
  qcReviewId?: string;
  blockers?: string[];
  startedAt?: number;
  completedAt?: number;
  /** Runtime-only. Omitted from the plan digest so rework does not expand authorization. */
  reworkEpoch?: number;
}

export interface MissionPlan {
  objective?: { title: string; goal: string; activationId?: string };
  clusters: string[];
  projects: string[];
  tasks: MissionTaskPlan[];
  concurrencyLimits: MissionConcurrencyLimits;
  spendingLimitUsd?: number;
  executionPolicy: MissionExecutionPolicy;
}

export interface MissionAuthorization {
  authorizedAt: number;
  authorizedBy: string; // "owner"
  digest: string;
}

export interface MissionRuntimeState {
  totalTasks: number;
  completedTasks: number;
  runningTasks: number;
  blockedTasks: number;
  failedTasks: number;
  awaitingQcTasks: number;
  awaitingOwnerTasks: number;
  activeSpecialists: string[];
  resourceUsage: Record<string, number>; // accountId -> count
}

export interface MissionHistoryEvent {
  timestamp: number;
  event: string;
  details?: Record<string, unknown>;
}

export interface MissionRecord {
  id: string;
  title: string;
  goal: string;
  initiativeId?: string | null;
  status: MissionStatus;
  revision: number;
  clusters: string[];
  projects: string[];
  plan: MissionPlan;
  planDigest: string;
  authorization?: MissionAuthorization | null;
  concurrencyLimits: MissionConcurrencyLimits;
  state: MissionRuntimeState;
  history: MissionHistoryEvent[];
  createdAt: number;
  updatedAt: number;
}

export interface MissionReservation {
  id: string;
  missionId: string;
  taskId: string;
  projectPath: string;
  employeeId: string;
  accountId?: string | null;
  harnessId: string;
  modelId: string;
  status:
    | "reserved"
    | "starting"
    | "running"
    | "awaiting_qc"
    | "qc_running"
    | "released"
    | "failed"
    | "cancelled";
  runId?: string | null;
  qcReviewId?: string | null;
  createdAt: number;
  updatedAt: number;
}
