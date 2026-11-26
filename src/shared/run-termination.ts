/**
 * What the Owner is told after a supervised run was stopped or reached its time limit. Pure: both the core
 * and the webview import it. The record states what the core observed; it never turns a request into proof.
 */

export type TerminationReason = "manual" | "time-limit";

/**
 * - `exited`: the recorded process id and its process group were gone when checked.
 * - `no-process`: no live session or pane process was found to stop (nothing alive that the core knew of).
 * - `unconfirmed`: signals were sent and the process was still alive when the core stopped waiting.
 * - `unverified`: the harness does not report process exit; a stop was requested and nothing more is known.
 * - `not-launched`: the stop arrived before the agent was launched.
 * - `recovered-*`: after a restart, the recorded process id was checked once: gone, still alive, or unknown.
 */
export type TerminationOutcome =
  | "exited" | "no-process" | "unconfirmed" | "unverified" | "not-launched"
  | "recovered-gone" | "recovered-alive" | "recovered-unknown";

export interface RunTermination {
  runId: string;
  /** Set when a time limit applies to this run (shown before launch, enforced by the core). */
  limitSeconds: number | null;
  deadlineAt: number | null;
  /** Null while the row only records an armed limit. */
  reason: TerminationReason | null;
  requestedAt: number | null;
  attempts: number;
  outcome: TerminationOutcome | null;
  processId: number | null;
  methods: Array<"session-kill" | "sigterm" | "sigkill">;
  checkedAt: number | null;
  exitedAt: number | null;
  note: string | null;
}

/** The Owner-facing state of a run's stop, derived from the record and the run's own status. */
export type TerminationState =
  | "armed"          // a time limit is set; nothing requested
  | "stopping"       // requested, no outcome yet
  | "exited"         // the core observed the process gone
  | "unconfirmed"    // still alive after every signal: the slot stays occupied
  | "not-reported"   // the harness does not report exit
  | "not-launched"
  | "recovered-gone" | "recovered-alive" | "recovered-unknown";

export function terminationState(t: RunTermination | null | undefined, runStatus: string): TerminationState | null {
  if (!t) return null;
  if (t.requestedAt == null) return t.limitSeconds != null && runStatus === "running" ? "armed" : null;
  switch (t.outcome) {
    case "exited": case "no-process": return "exited";
    case "unconfirmed": return runStatus === "running" ? "unconfirmed" : "exited";
    case "unverified": return "not-reported";
    case "not-launched": return "not-launched";
    case "recovered-gone": return "recovered-gone";
    case "recovered-alive": return "recovered-alive";
    case "recovered-unknown": return "recovered-unknown";
    default: return "stopping";
  }
}

export const SUPERVISED_RUN_LIMIT_ENV = "FORGEORBIT_SUPERVISED_RUN_LIMIT_SECONDS";
export const SUPERVISED_RUN_LIMIT_BOUNDS = { min: 1, max: 86_400 } as const;

/** Unset or blank is "no new limit". Anything else must be a whole number of seconds inside the bounds. */
export function parseSupervisedRunLimit(raw: string | undefined | null): { ok: true; seconds: number | null } | { ok: false; error: string } {
  if (raw == null || raw.trim() === "") return { ok: true, seconds: null };
  const text = raw.trim();
  if (!/^[0-9]{1,6}$/.test(text)) return { ok: false, error: `${SUPERVISED_RUN_LIMIT_ENV} must be a whole number of seconds from ${SUPERVISED_RUN_LIMIT_BOUNDS.min} to ${SUPERVISED_RUN_LIMIT_BOUNDS.max}.` };
  const seconds = Number(text);
  if (seconds < SUPERVISED_RUN_LIMIT_BOUNDS.min || seconds > SUPERVISED_RUN_LIMIT_BOUNDS.max) {
    return { ok: false, error: `${SUPERVISED_RUN_LIMIT_ENV} must be a whole number of seconds from ${SUPERVISED_RUN_LIMIT_BOUNDS.min} to ${SUPERVISED_RUN_LIMIT_BOUNDS.max}.` };
  }
  return { ok: true, seconds };
}

/**
 * The summary stored on a QC review whose reviewer run ended without a verdict because it was stopped.
 * It states the facts and the next step; it never carries a verdict.
 */
export function stoppedReviewSummary(t: RunTermination | null, runStatus: string): string | null {
  if (!t || t.requestedAt == null) return null;
  const why = t.reason === "time-limit"
    ? `The review reached its time limit${t.limitSeconds != null ? ` of ${t.limitSeconds} s` : ""} and was stopped.`
    : "The review was stopped by the Owner.";
  const state = terminationState(t, runStatus);
  const exit = state === "exited" ? "The reviewer process was observed to exit."
    : state === "not-reported" ? "This harness does not report process exit, so exit was not verified."
    : state === "not-launched" ? "The reviewer had not launched yet."
    : state === "recovered-gone" ? "After a restart the reviewer process was no longer found."
    : state === "recovered-alive" ? "After a restart the reviewer process was still running."
    : state === "recovered-unknown" ? "After a restart the reviewer process could not be checked."
    : "Whether the reviewer process exited is not confirmed.";
  return `${why} ${exit} No verdict was recorded and the task did not move to Done. Start a new review, or use QC recovery if it is offered.`;
}
