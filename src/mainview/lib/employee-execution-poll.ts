import type { EmployeeRunView } from "../../shared/execution/run.ts";
import { isLivePhase } from "./employee-execution.ts";

/** One mounted task only. No overlapping requests, stale responses or global timer. */
export function watchEmployeeExecutions(
  read: (signal: AbortSignal) => Promise<{ attempts: EmployeeRunView[] }>,
  receive: (attempts: EmployeeRunView[]) => void,
  timers = { set: (callback: () => void) => setTimeout(callback, 2000), clear: (id: ReturnType<typeof setTimeout>) => clearTimeout(id) },
): () => void {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const load = async () => {
    try {
      const response = await read(controller.signal);
      if (controller.signal.aborted) return;
      receive(response.attempts);
      if (response.attempts.some((attempt) => isLivePhase(attempt.phase))) timer = timers.set(() => { void load(); });
    } catch {
      // A failed status read has no new evidence. Stop until the mounted
      // task changes or the owner explicitly refreshes; never infer success.
    }
  };
  void load();
  return () => { controller.abort(); if (timer !== undefined) timers.clear(timer); };
}
