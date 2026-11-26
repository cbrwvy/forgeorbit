/**
 * Legal phase changes for one environment.
 *
 * Commands are idempotent one layer up: a second Start while `running` does
 * not transition, and Stop while `stopped` does not either. This table only
 * lists changes that mean something new happened.
 *
 * `unknown → stopping` is legal only when a probe just proved the process is
 * still the one ForgeOrbit started. Without that flag the transition is
 * refused so a stale PID cannot be signalled.
 */

import type { EnvironmentPhase } from "./types.ts";

export const ENVIRONMENT_TRANSITIONS: Record<EnvironmentPhase, readonly EnvironmentPhase[]> = {
  stopped: ["starting"],
  starting: ["running", "degraded", "stopping", "error", "stopped", "unknown"],
  running: ["degraded", "stopping", "error", "stopped", "unknown"],
  degraded: ["running", "stopping", "error", "stopped", "unknown"],
  stopping: ["stopped", "error"],
  error: ["starting", "stopping", "stopped", "unknown"],
  unknown: ["starting", "running", "degraded", "stopped", "error", "stopping"],
};

export interface TransitionContext {
  /** Set only after ownership was re-proven for this call, not from a stored PID alone. */
  provenOwnership?: boolean;
}

export function canTransition(
  from: EnvironmentPhase,
  to: EnvironmentPhase,
  context: TransitionContext = {},
): boolean {
  if (from === to) return false;
  if (!(ENVIRONMENT_TRANSITIONS[from] as readonly string[]).includes(to)) return false;
  if (from === "unknown" && to === "stopping" && context.provenOwnership !== true) return false;
  return true;
}

export function transitionRefusal(
  from: EnvironmentPhase,
  to: EnvironmentPhase,
  context: TransitionContext = {},
): string | null {
  if (canTransition(from, to, context)) return null;
  if (from === "unknown" && to === "stopping") {
    return "cannot stop an environment whose ownership is not proven";
  }
  return `cannot transition from ${from} to ${to}`;
}
