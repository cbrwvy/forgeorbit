/**
 * Project permission events forwarded from App's single `/app/events` stream.
 * Listeners re-read the core; they never open their own EventSource.
 */
import type { AppEvent } from "../../shared/types.ts";

export type ProjectPermissionAppEvent = Extract<AppEvent, { type: "project_permission" }>;
type Listener = (event: ProjectPermissionAppEvent) => void;
const listeners = new Set<Listener>();

export function publishProjectPermissionEvent(event: ProjectPermissionAppEvent): void {
  for (const listener of [...listeners]) {
    try { listener(event); } catch (err) { console.warn("[agetor] permission event listener threw", err); }
  }
}

export function subscribeProjectPermissionEvents(listener: Listener): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}
