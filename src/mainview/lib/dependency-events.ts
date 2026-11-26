/**
 * Structured-dependency events (FO-005C `task_dependencies`) forwarded from
 * App's single `/app/events` stream. Estimates subscribes here and re-reads
 * the links from the core; it never opens its own EventSource (WKWebView's
 * per-host connection cap, see `lib/pipeline-events.ts`).
 *
 * `projectPath: null` is a resync: the stream (re)connected, so an event may
 * have been missed while it was down and every listener should re-read.
 */

type Listener = (signal: { projectPath: string | null }) => void;

const listeners = new Set<Listener>();

function publish(signal: { projectPath: string | null }): void {
  for (const listener of [...listeners]) {
    try {
      listener(signal);
    } catch (err) {
      console.warn("[agetor] dependency event listener threw", err);
    }
  }
}

export function publishDependencyChange(projectPath: string): void {
  publish({ projectPath });
}

export function publishDependencyResync(): void {
  publish({ projectPath: null });
}

export function subscribeDependencyEvents(listener: Listener): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}
