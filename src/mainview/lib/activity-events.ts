/** Fan-out from App's existing SSE connection. Never a transport of journal rows. */
export type ActivitySignal = "changed" | "connected" | "disconnected";
const listeners = new Set<(signal: ActivitySignal) => void>();
let connection: ActivitySignal = "disconnected";
export function publishActivitySignal(signal: ActivitySignal) {
  if (signal !== "changed") connection = signal;
  for (const listener of [...listeners]) listener(signal);
}
export function activityConnection() { return connection; }
export function subscribeActivitySignal(listener: (signal: ActivitySignal) => void) {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}
