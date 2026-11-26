/**
 * Run attribution contract (FO-010E1 types, written by FO-010E2).
 *
 * The persisted form is the `employee_executions` row (migration 085); the
 * view the API returns is `EmployeeRunView` in `run.ts`. The start step fills `requested` from the confirmed preflight
 * inputs and `actual` only from facts the runtime itself established.
 * `null` means Unknown; it is never replaced by the requested value, by the
 * router recommendation, by the argv this process built, or by a CLI field
 * that only echoes that argv. Antigravity `init.model` and Claude Code's
 * session JSONL `model` are CLI-reported. In the checked live runs both
 * matched the `--model` flag already sent, and Antigravity's same init
 * object reported a permission mode that did not match the flag or the
 * file write, so those fields are not `actual.model`. A guess from an
 * email, plan, or display name is not actual either.
 * Runs that started before this stage are never back-filled.
 */

export type AttributionProvenance = "runtime" | "owner" | "unknown";

export interface RunAttributionRequested {
  harnessId: string | null;
  model: string | null;
  effort: string | null;
}

export interface RunAttributionActual {
  harnessId: string | null;
  model: string | null;
  /** AccountCore account id, only when the runtime established it. */
  accountId: string | null;
}

export interface RunAttribution {
  runId: string;
  taskId: string;
  employeeId: string;
  assignmentId: string;
  /** Revision read under the start lock, not copied from a client. */
  assignmentRevision: number;
  requested: RunAttributionRequested;
  actual: RunAttributionActual;
  /** Owner confirmation immediately before start (existing supervised approval). */
  ownerExecutionApprovalId: string | null;
  startedAt: number;
  finishedAt: number | null;
  result: "succeeded" | "failed" | "cancelled" | "orphaned" | null;
  provenance: { actual: AttributionProvenance; approval: AttributionProvenance };
}
