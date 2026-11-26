/**
 * Environment events forwarded from App's single `/app/events` stream.
 *
 * The environment page and the overview card subscribe here. Neither opens
 * its own EventSource.
 */

import type { AppEvent } from "../../shared/types.ts";

export type EnvironmentAppEvent = Extract<AppEvent, { type: "environment_status" | "environment_log" }>;

type Listener = (event: EnvironmentAppEvent) => void;

const listeners = new Set<Listener>();

export function publishEnvironmentEvent(event: EnvironmentAppEvent): void {
  for (const listener of listeners) listener(event);
}

export function subscribeEnvironmentEvents(listener: Listener): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function isEnvironmentEvent(event: AppEvent): event is EnvironmentAppEvent {
  return event.type === "environment_status" || event.type === "environment_log";
}
