/**
 * Project Analytics selection. The numbers themselves come from the existing
 * usage and forecast services. This only decides which project and which
 * tasks those services are asked about. Nothing here saves, authorizes or starts work.
 */
import type { AnalyticsFilter, ForecastSelection } from "../../shared/usage-analytics.ts";

/** The forecast service rejects more than this many task ids. */
export const FORECAST_TASK_CAP = 100;

export interface AnalyticsTaskRef {
  id: string;
  title?: string;
  column: string;
  archivedAt?: number | null;
  pipelineParentId?: string | null;
}

/** Tasks that are still ahead of Done. Archived rows and pipeline steps are not estimated here. */
export function remainingTaskIds(tasks: readonly AnalyticsTaskRef[]): string[] {
  return tasks
    .filter((task) => task.pipelineParentId == null && task.archivedAt == null && task.column !== "done")
    .map((task) => task.id);
}

/**
 * A read-only forecast for one project. `save` is always false: calculating
 * the summary must not write an estimate. A list longer than the service cap
 * is cut and reported as partial rather than sent and rejected.
 */
export function forecastSelectionForProject(
  projectPath: string,
  taskIds: readonly string[],
): { selection: ForecastSelection; partial: boolean } | null {
  if (!projectPath || taskIds.length === 0) return null;
  return {
    partial: taskIds.length > FORECAST_TASK_CAP,
    selection: { projectPath, taskIds: taskIds.slice(0, FORECAST_TASK_CAP), save: false },
  };
}

/** Keep a filter on one project. A later edit cannot drop or replace that project. */
export function lockProjectFilter(projectPath: string, filter: AnalyticsFilter = {}): AnalyticsFilter {
  return { ...filter, projectPath };
}

export function tasksInProject<T extends { projectPath?: string | null }>(
  tasks: readonly T[],
  projectPath: string,
): { rows: T[]; foreign: number } {
  const rows: T[] = [];
  let foreign = 0;
  for (const task of tasks) {
    if (task.projectPath && task.projectPath !== projectPath) foreign += 1;
    else rows.push(task);
  }
  return { rows, foreign };
}
