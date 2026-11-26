/**
 * FO-UX-SIMPLIFY02-M1: one shared view of the autonomy emergency stop for the title bar and
 * Mission Control. It only calls the existing endpoints (`/api/autonomy/status`,
 * `/api/autonomy/emergency-stop`, `/api/autonomy/emergency-stop/clear`); there is no second stop
 * implementation here.
 *
 * What the backend stop does (src/bun/autonomy/coordinator.ts): it sets the global emergency flag,
 * cancels unclaimed autonomous reservations, cancels the running tasks of policy-bound missions and
 * pauses those missions. `outstanding` lists run ids that were still alive after the cancel request.
 * It does not stop tasks the Owner started by hand. The UI must describe exactly that.
 */
import { api } from "@/lib/api";

export type EmergencyPhase =
  | "unknown"   // never loaded, or the status call failed before any answer
  | "clear"
  | "stopping"  // stop request sent, no answer yet
  | "active";

export interface EmergencyState {
  phase: EmergencyPhase;
  /** Run ids the core reported as still alive after the stop. Empty does not mean "everything is dead" — only "none reported". */
  outstanding: readonly string[];
  /**
   * Running tasks the stop did not stop (tasks the Owner started by hand). Read from the core while the stop is on;
   * 0 also when the core did not report it, so it is only ever shown when positive.
   */
  leftRunning: number;
  /** The stop request failed: the stop is NOT confirmed. */
  stopFailed: boolean;
  /** Last status/clear error text, raw (shown in technical details / tooltip). */
  error: string | null;
}

export const INITIAL_EMERGENCY: EmergencyState = { phase: "unknown", outstanding: [], leftRunning: 0, stopFailed: false, error: null };

interface StatusLike { emergency: { active: boolean; outstanding: string[]; leftRunning?: number } }

/** Pure transitions, unit-tested. */
export function applyStatus(state: EmergencyState, status: StatusLike): EmergencyState {
  // A status read never downgrades an in-flight stop: the stop's own answer settles it.
  if (state.phase === "stopping" && !status.emergency.active) return state;
  return {
    phase: status.emergency.active ? "active" : "clear",
    outstanding: status.emergency.active ? status.emergency.outstanding : [],
    leftRunning: status.emergency.active ? status.emergency.leftRunning ?? 0 : 0,
    stopFailed: status.emergency.active ? false : state.stopFailed,
    error: null,
  };
}
export function applyStatusError(state: EmergencyState, message: string): EmergencyState {
  // Keep the last known phase; an unreachable core proves nothing either way.
  return { ...state, error: message };
}
export function beginStop(state: EmergencyState): EmergencyState {
  return { ...state, phase: "stopping", stopFailed: false, error: null };
}
export function stopSucceeded(_state: EmergencyState, outstanding: readonly string[], leftRunning = 0): EmergencyState {
  return { phase: "active", outstanding, leftRunning, stopFailed: false, error: null };
}
export function stopFailed(state: EmergencyState, message: string, previous: EmergencyPhase): EmergencyState {
  return { ...state, phase: previous, stopFailed: true, error: message };
}

let state: EmergencyState = INITIAL_EMERGENCY;
const listeners = new Set<() => void>();
function set(next: EmergencyState): void {
  if (next === state) return;
  state = next;
  for (const listener of listeners) listener();
}
export const emergencyStore = {
  getSnapshot: () => state,
  subscribe(listener: () => void) { listeners.add(listener); return () => { listeners.delete(listener); }; },
};

let refreshing: Promise<void> | null = null;
/** Re-read the stored flag. Single-flight; never throws. */
export function refreshEmergency(): Promise<void> {
  refreshing ??= api.autonomyStatus()
    .then((status) => set(applyStatus(state, status)), (cause: unknown) => set(applyStatusError(state, cause instanceof Error ? cause.message : String(cause))))
    .finally(() => { refreshing = null; });
  return refreshing;
}

/** One click, no confirmation. Resolves true only when the core confirmed the stop. */
export async function requestEmergencyStop(reason: string): Promise<boolean> {
  const previous = state.phase;
  set(beginStop(state));
  try {
    const result = await api.emergencyStopAutonomy(reason);
    set(stopSucceeded(state, result.outstanding ?? [], result.status?.emergency.leftRunning ?? 0));
    return true;
  } catch (cause) {
    set(stopFailed(state, cause instanceof Error ? cause.message : String(cause), previous));
    // The request may have landed even though the answer was lost: ask the core what is stored.
    void refreshEmergency();
    return false;
  }
}

/** Clears the flag. Callers must have the Owner's explicit confirmation first. Resolves true when the core confirmed. */
export async function clearEmergency(): Promise<boolean> {
  try {
    await api.clearEmergencyStop();
    set({ phase: "clear", outstanding: [], leftRunning: 0, stopFailed: false, error: null });
    return true;
  } catch (cause) {
    set(applyStatusError(state, cause instanceof Error ? cause.message : String(cause)));
    void refreshEmergency();
    return false;
  }
}

/** Test seam. */
export function __resetEmergencyForTest(next: EmergencyState = INITIAL_EMERGENCY): void { state = next; }
