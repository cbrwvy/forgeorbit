/**
 * FO-PROJECT-LIFECYCLE01 — Project-wide AI execution lifecycle contract.
 *
 * Governs whether a registered project may admit new AI executions while
 * preserving active work, completed Runs, QC verdicts, pending Owner approvals,
 * phase grants, frozen batch policies, and task workspaces.
 *
 * Distinct from:
 *  - `EnvironmentManager` (local dev server / Docker Compose lifecycle), and
 *  - `ExecutionBatch` / `OrchestratedBatch` (per-batch approval & pause state).
 */

export const PROJECT_LIFECYCLE_STATES = ["running", "draining", "paused", "recovering"] as const;

export type ProjectLifecycleState = (typeof PROJECT_LIFECYCLE_STATES)[number];

/**
 * Runtime effective state. `"invalid"` is surfaced fail-closed whenever a
 * persisted `lifecycle_state` is unknown, corrupted, or left in an interrupted
 * recovery state that has not yet been reconciled.
 */
export type EffectiveProjectLifecycleState = ProjectLifecycleState | "invalid";

export function isValidProjectLifecycleState(value: unknown): value is ProjectLifecycleState {
  return typeof value === "string" && (PROJECT_LIFECYCLE_STATES as readonly string[]).includes(value);
}

export interface ProjectLifecycleActiveBreakdown {
  taskRuns: number;
  managerTurns: number;
  interviewTurns: number;
  /**
   * Tasks whose earlier run was stopped (or orphaned) and whose recorded process was not observed to exit. They hold the
   * project in Draining until each is observed gone. Optional so older payloads and fixtures stay valid.
   */
  unconfirmedProcesses?: number;
}

export type ProjectLifecycleUnavailableCode =
  | "already-running"
  | "draining-active-work"
  | "recovering"
  | "invalid-state"
  | "already-paused"
  | "already-draining";

export interface ProjectLifecycleSnapshot {
  projectPath: string;
  state: EffectiveProjectLifecycleState;
  persistedState: string;
  launchesBlocked: boolean;
  waitingForActiveWork: boolean;
  activeExecutions: number;
  activeBreakdown: ProjectLifecycleActiveBreakdown;
  canStart: boolean;
  canStop: boolean;
  startUnavailableCode: ProjectLifecycleUnavailableCode | null;
  startUnavailableReason: string | null;
  stopUnavailableCode: ProjectLifecycleUnavailableCode | null;
  stopUnavailableReason: string | null;
  blockerReason: string | null;
  updatedAt: number | null;
  reason: string | null;
}

export interface ProjectLifecycleActionResult {
  lifecycle: ProjectLifecycleSnapshot;
  changed: boolean;
  previousState: EffectiveProjectLifecycleState;
  reconciledStartingProposals?: number;
}
