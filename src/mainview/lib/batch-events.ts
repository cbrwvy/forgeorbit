/**
 * Execution-batch events (FO-005C) forwarded from App's single
 * `/app/events` stream. The Manager tab's Autonomous Execution view
 * subscribes here and re-reads the batch from the core on each one; it
 * never opens its own EventSource (WKWebView's per-host connection cap,
 * see `lib/pipeline-events.ts`).
 */

import type { AppEvent } from "../../shared/types.ts";

export type BatchAppEvent = Extract<AppEvent, { type: "execution_batch" }>;

type Listener = (event: BatchAppEvent) => void;

const listeners = new Set<Listener>();

export function publishBatchEvent(event: BatchAppEvent): void {
  for (const listener of [...listeners]) {
    try {
      listener(event);
    } catch (err) {
      console.warn("[agetor] batch event listener threw", err);
    }
  }
}

export function subscribeBatchEvents(listener: Listener): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}
