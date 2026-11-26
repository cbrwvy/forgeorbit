/**
 * Canonical backend scheduled-availability gate (FO-KANBAN-SCHEDULE01).
 *
 * Every execution path (hands-off driver, mission scheduler, approved batches,
 * PM orchestrated batches/workflows, employee preflight/run, Owner Trust
 * admission, and `orchestrator.startTask`) asks this one module before
 * reserving slots, consuming launch budget, or spawning any provider process.
 */
import { tasks } from "./db.ts";
import {
  evaluateTaskAvailability,
  type TaskAvailabilityEvaluation,
} from "../shared/task-availability.ts";
import type { Task } from "../shared/types.ts";

let clock: (() => number) | null = null;

/** Deterministic test seam for backend scheduling & enforcement tests. */
export function setTaskAvailabilityClockForTest(next: (() => number) | null): void {
  clock = next;
}

export function taskAvailabilityNow(): number {
  return clock ? clock() : Date.now();
}

export function taskAvailabilityFor(
  task: Pick<Task, "availableFromUtc"> | null | undefined,
  nowMs: number = taskAvailabilityNow(),
): TaskAvailabilityEvaluation {
  return evaluateTaskAvailability(task, nowMs);
}

export interface TaskAvailabilityRefusal {
  code: "scheduled-not-yet-available";
  reason: string;
  availableFromUtc: string;
  availableFromMs: number | null;
}

/**
 * Fresh DB check: returns a refusal object if the task has an earliest-start
 * timestamp strictly in the future (or corrupt), or `null` when time-eligible.
 */
export function taskAvailabilityRefusal(
  taskId: string,
  nowMs: number = taskAvailabilityNow(),
): TaskAvailabilityRefusal | null {
  const task = tasks.get(taskId);
  if (!task) return null;
  const evaluation = evaluateTaskAvailability(task, nowMs);
  if (evaluation.available) return null;
  const ts = evaluation.availableFromUtc ?? "configured time";
  return {
    code: "scheduled-not-yet-available",
    reason: evaluation.corrupt
      ? `Task has an invalid scheduled availability timestamp (${ts}). Edit or clear it before launching.`
      : `Task is scheduled to be available from ${ts}. Waiting for scheduled time.`,
    availableFromUtc: ts,
    availableFromMs: evaluation.availableFromMs,
  };
}

/** Plain-text refusal message for `startTask` and admission paths, or `null` when eligible. */
export function taskAvailabilityRefusalMessage(
  taskId: string,
  nowMs: number = taskAvailabilityNow(),
): string | null {
  return taskAvailabilityRefusal(taskId, nowMs)?.reason ?? null;
}

type AvailabilityChangeListener = (taskId: string, availableFromUtc: string | null) => void;
const listeners = new Set<AvailabilityChangeListener>();

/** Subscribe schedulers to task availability edits without circular imports. */
export function onTaskAvailabilityChange(listener: AvailabilityChangeListener): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** Called after `available_from_utc` changes on a task so waiting schedulers re-evaluate immediately. */
export function notifyTaskAvailabilityChanged(taskId: string, availableFromUtc: string | null): void {
  for (const listener of listeners) {
    try {
      listener(taskId, availableFromUtc);
    } catch {
      // One scheduler's error must not block others from re-evaluating.
    }
  }
}
