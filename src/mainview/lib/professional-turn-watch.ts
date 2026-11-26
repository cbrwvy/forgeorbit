import type { TurnHistory } from "../../shared/execution/turn.ts";
import { subscribePipelineGlobalEvents } from "./pipeline-events.ts";

/** One mounted Run. Events share App's SSE; polling only bridges missed events. */
export function watchProfessionalTurns(
  runId: string,
  read: (signal: AbortSignal) => Promise<TurnHistory>,
  receive: (history: TurnHistory) => void,
  fail: (error: unknown) => void,
  timers = { set: (fn: () => void) => setTimeout(fn, 1500), clear: (id: ReturnType<typeof setTimeout>) => clearTimeout(id) },
) {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  let inFlight: Promise<void> | undefined;
  let dirty = false;
  let remaining = 20;
  const clear = () => { if (timer !== undefined) timers.clear(timer); timer = undefined; };
  const load = (): Promise<void> => {
    if (controller.signal.aborted) return Promise.resolve();
    if (inFlight) { dirty = true; return inFlight; }
    clear();
    inFlight = Promise.resolve().then(async () => {
      try {
        if (controller.signal.aborted) return;
        const history = await read(controller.signal);
        if (controller.signal.aborted) return;
        receive(history);
        // Parent status can miss an entire fast turn. Only backend evidence
        // determines settlement; Indeterminate is never promoted locally.
        const pending = history.session.state === "attached" || history.turns.some(t =>
          ["approved", "claimed", "prepared"].includes(t.status)
          || (t.status === "included" && t.observed_run_status === null));
        if ((pending || dirty) && remaining-- > 0) timer = timers.set(() => { void load(); });
      } catch (error) {
        if (!controller.signal.aborted) fail(error);
        // Stop on failure. Explicit refresh, a lifecycle event or remount
        // may try again; there is no recurring offline retry loop.
      } finally { inFlight = undefined; dirty = false; }
    });
    return inFlight;
  };
  const refresh = () => { remaining = 20; return load(); };
  const unsubscribe = subscribePipelineGlobalEvents(event => {
    if ((event.kind === "run-status" || (event.kind === "column" && event.column === "running"))
      && event.runId === runId) void refresh();
  });
  void load();
  return {
    signal: controller.signal,
    refresh,
    stop: () => { controller.abort(); clear(); unsubscribe(); },
  };
}
