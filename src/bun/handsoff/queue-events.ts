/**
 * Lightweight event bus for waking the hands-off smart queue whenever Kanban
 * order (`board_rank`), urgency, dependencies, assignments, or project
 * lifecycle state changes — avoids circular imports with `kanban-order.ts`
 * and `project-lifecycle.ts`.
 */

type QueueChangeListener = (projectPath: string | null, reason: string) => void;
const listeners = new Set<QueueChangeListener>();

export function onSmartQueueChange(listener: QueueChangeListener): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

export function notifySmartQueueChanged(projectPath: string | null, reason: string): void {
  for (const listener of [...listeners]) {
    try { listener(projectPath, reason); } catch { /* isolate listener failures */ }
  }
}
