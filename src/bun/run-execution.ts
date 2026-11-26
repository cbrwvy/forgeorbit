import { db, runs } from "./db.ts";
import { executionFromEvents, type RunExecution } from "../shared/run-execution.ts";
export function getRunExecution(runId: string): RunExecution | null {
  const run = runs.get(runId);
  if (!run) return null;
  const events = db.query<{stream: string; data: string}, [string]>(`SELECT stream, data FROM run_events INDEXED BY idx_run_events_run
    WHERE run_id = ? AND stream = 'status' AND subagent_id IS NULL ORDER BY id`).all(runId);
  return executionFromEvents(events, run.status);
}
