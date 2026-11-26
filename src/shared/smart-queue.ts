/**
 * Smart execution queue model (FO-KANBAN-SMARTQUEUE01).
 *
 * Pure types and helpers shared by the backend scheduler (`src/bun/handsoff/queue.ts`),
 * the HTTP API, the Kanban UI, and tests. The backend computes every queue state using
 * the exact same canonical eligibility and Kanban-ordering policy (`compareBoardTasks`)
 * that drives actual dispatch — the webview never simulates a disconnected queue.
 */
import type { Urgency } from "./board-order.ts";
import type { HandsoffStage, HandsoffStatus } from "./handsoff.ts";
import type { HandsoffAuthorizationState } from "./handsoff-authorization.ts";

export type SmartQueueWaitKind =
  | "scheduled"
  | "dependency"
  | "worker"
  | "slot"
  | "provider-limit"
  | "authorization"
  | "project-paused"
  | "emergency-stop"
  | "policy-off"
  | "needs-owner"
  | null;

export type SmartQueueTaskCategory =
  | "running"
  | "next"
  | "queued"
  | "waiting"
  | "blocked"
  | "stopped";

export interface SmartQueueTaskItem {
  taskId: string;
  runId: string;
  projectPath: string;
  title: string;
  urgency: Urgency;
  boardRank: number;
  availableFromUtc: string | null;
  stage: HandsoffStage;
  runStatus: HandsoffStatus;
  /** Canonical presentation state derived from live backend admission + Kanban order. */
  category: SmartQueueTaskCategory;
  /** Specific wait or block reason when not actively running or immediately next. */
  waitKind: SmartQueueWaitKind;
  /** Optional wait target timestamp (scheduled UTC instant or provider limit reset). */
  waitUntil: number | null;
  /** Canonical English explanation from the backend (kept for tooltips / technical details). */
  reason: string | null;
  /**
   * Honest 1-based position within this project's eligible queued tasks.
   * Null for tasks that are running, blocked, waiting on prerequisites, or unsubmitted.
   * Never a global cross-project position.
   */
  queuePosition: number | null;
  /**
   * True when competing projects or multiple heterogeneous resources make the exact
   * next dispatch non-deterministic ("Expected next task" rather than a guarantee).
   */
  uncertainNext: boolean;
  assignedEmployeeId: string | null;
  assignedEmployeeName: string | null;
}

export interface SmartQueueCounts {
  running: number;
  /** Eligible queued tasks ready to launch as soon as capacity is available. */
  eligible: number;
  /** Queued tasks waiting specifically for their future `available_from_utc`. */
  waitingScheduled: number;
  /** Queued tasks waiting for a dependency to reach Done. */
  waitingDependency: number;
  /** Queued tasks waiting on a busy pinned worker or provider limit reset. */
  waitingResource: number;
  /** Queued or active tasks blocked by authorization, pause, E-stop, or a needs-owner blocker. */
  blocked: number;
  /** Total non-running open submitted tasks in this project. */
  waitingTotal: number;
}

export interface SmartQueueNextCandidate {
  taskId: string;
  title: string;
  urgency: Urgency;
  uncertain: boolean;
}

export interface SmartQueueProjectSummary {
  projectPath: string;
  enabled: boolean;
  authorizationState: HandsoffAuthorizationState;
  launchesRemaining: number | null;
  lifecycleState: "running" | "paused" | "draining" | "recovering" | "invalid";
  emergencyStop: boolean;
  maxParallel: number;
  activeSlots: number;
  totalDevelopers: number;
  idleDevelopers: number;
  counts: SmartQueueCounts;
  /** Highest-ranked eligible task expected to start next when capacity permits. */
  expectedNext: SmartQueueNextCandidate | null;
  /** Open submitted tasks in canonical display/dispatch order (active lifecycle first, then Kanban order). */
  items: SmartQueueTaskItem[];
}

export interface SmartQueueOverview {
  generatedAt: number;
  projects: SmartQueueProjectSummary[];
}

/** Find a project's smart queue summary from an overview list. */
export function smartQueueForProject(
  queues: readonly SmartQueueProjectSummary[] | null | undefined,
  projectPath: string | null | undefined,
): SmartQueueProjectSummary | null {
  if (!queues || !projectPath) return null;
  return queues.find((q) => q.projectPath === projectPath) ?? null;
}

/** Find a specific task's smart queue item across project summaries. */
export function smartQueueItemForTask(
  queues: readonly SmartQueueProjectSummary[] | null | undefined,
  taskId: string,
): SmartQueueTaskItem | null {
  if (!queues) return null;
  for (const project of queues) {
    const found = project.items.find((item) => item.taskId === taskId);
    if (found) return found;
  }
  return null;
}
