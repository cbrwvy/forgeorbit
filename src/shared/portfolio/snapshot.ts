/**
 * Index a validated snapshot and count it. Counts never treat a review
 * column as done, never treat a pipeline step as a board task, and never
 * count a batch membership as a second task.
 */

import type { ColumnId } from "../types.ts";
import type { BatchStatus, TaskPriority } from "../task-scheduling.ts";
import { validatePortfolio } from "./validate.ts";
import {
  emptyColumns,
  type ColumnCounts,
  type CountFact,
  type DeadlineInput,
  type Freshness,
  type PortfolioIssue,
  type PortfolioSnapshotInput,
  type ProjectPriorityInput,
  type ProjectSnapshotInput,
  type ProjectSummary,
  type ResourceSnapshotInput,
  type TaskFactInput,
} from "./types.ts";

const ACTIVE_BATCH: ReadonlySet<BatchStatus> = new Set(["approved", "running", "paused"]);

export interface IndexedProject {
  project: ProjectSnapshotInput;
  freshness: Freshness;
  /** Freshness of the recorded environment phase itself (FO-008C). Null
   *  when no phase was recorded. A project read now can still carry a
   *  phase recorded days ago; that phase is not the current state. */
  environmentFreshness: Freshness | null;
  boardTasks: TaskFactInput[];
  pipelineSteps: TaskFactInput[];
  tasksById: ReadonlyMap<string, TaskFactInput>;
  dependencies: { taskId: string; dependsOn: string }[];
}

export interface IndexedPortfolio {
  input: PortfolioSnapshotInput;
  projects: IndexedProject[];
  resources: ResourceSnapshotInput[];
  priorityByProject: ReadonlyMap<string, ProjectPriorityInput>;
  deadlineByTask: ReadonlyMap<string, DeadlineInput>;
  duplicateTaskIds: string[];
  warnings: PortfolioIssue[];
}

export function preparePortfolio(input: unknown): { ok: boolean; issues: PortfolioIssue[]; indexed: IndexedPortfolio | null } {
  const validated = validatePortfolio(input);
  if (!validated.value || validated.issues.some((entry) => entry.severity === "error")) {
    return { ok: false, issues: validated.issues, indexed: null };
  }
  const indexed = indexPortfolio(validated.value);
  return { ok: true, issues: [...validated.issues, ...indexed.warnings], indexed };
}

export function projectFreshness(observedAtMs: number, capturedAtMs: number, stalenessAfterMs: number | null): Freshness {
  if (stalenessAfterMs == null) return "unproven";
  if (!Number.isSafeInteger(observedAtMs) || observedAtMs > capturedAtMs) return "unproven";
  if (capturedAtMs - observedAtMs > stalenessAfterMs) return "stale";
  return "current";
}

export function indexPortfolio(input: PortfolioSnapshotInput): IndexedPortfolio {
  const warnings: PortfolioIssue[] = [];
  const seenTaskIds = new Map<string, string>();
  const duplicateTaskIds: string[] = [];
  const projects = input.projects.map((project) => indexProject(project, input, seenTaskIds, duplicateTaskIds, warnings));
  const priorityByProject = new Map<string, ProjectPriorityInput>();
  for (const priority of input.projectPriorities) {
    if (priorityByProject.has(priority.projectId)) {
      warnings.push(warning("duplicate-priority", priority.projectId, `Project ${priority.projectId} has more than one priority. The first declaration is kept.`));
      continue;
    }
    priorityByProject.set(priority.projectId, priority);
  }
  const deadlineByTask = new Map<string, DeadlineInput>();
  for (const deadline of input.deadlines) {
    const key = deadlineKey(deadline.projectId, deadline.taskId);
    if (deadlineByTask.has(key)) {
      warnings.push(warning("duplicate-deadline", key, `Task ${deadline.taskId} has more than one deadline. The first confirmed deadline is kept.`));
      continue;
    }
    const project = projects.find((entry) => entry.project.id === deadline.projectId);
    if (!project?.tasksById.has(deadline.taskId)) {
      warnings.push(warning("missing-task", key, `Deadline for ${deadline.taskId} does not match an observed task. It was not applied.`));
      continue;
    }
    deadlineByTask.set(key, deadline);
  }
  const paths = new Map<string, string>();
  for (const project of projects) {
    const previous = paths.get(project.project.path);
    if (previous && previous !== project.project.id) {
      warnings.push(warning("duplicate-path", project.project.path, `Path ${project.project.path} is used by more than one project id.`));
    }
    paths.set(project.project.path, project.project.id);
  }
  return {
    input,
    projects,
    resources: input.resources,
    priorityByProject,
    deadlineByTask,
    duplicateTaskIds,
    warnings,
  };
}

export function summarizeProject(project: IndexedProject): ProjectSummary {
  const source = project.project;
  const board = source.coverage.board ? countBoard(project.boardTasks) : null;
  return {
    projectId: source.id,
    path: source.path,
    name: source.name.value,
    nameOrigin: source.name.origin,
    description: source.description,
    stack: source.stack,
    managerConfigured: source.managerConfigured,
    managerAvailable: source.managerAvailable,
    freshness: project.freshness,
    countsAreCurrent: project.freshness === "current",
    boardObserved: source.coverage.board,
    taskCount: board ? board.tasks.length : null,
    columns: board ? board.columns : null,
    doneCount: board ? board.columns.done : null,
    reviewCount: board ? board.columns.review : null,
    blockedCount: board ? board.columns.blocked : null,
    archivedCount: board ? board.archived : null,
    pipelineStepCount: source.coverage.board ? project.pipelineSteps.length : null,
    priorityCounts: board ? board.priorities : null,
    dependencyCount: source.coverage.dependencies ? project.dependencies.length : null,
    activeRunCount: source.coverage.runs ? source.runs.filter((run) => run.status === "running").length : null,
    failedRunCount: source.coverage.runs ? source.runs.filter((run) => run.status === "failed").length : null,
    orphanedRunCount: source.coverage.runs ? source.runs.filter((run) => run.status === "orphaned").length : null,
    harnessIds: board ? unique(board.tasks.map((task) => task.harnessId).filter((id): id is string => id != null)) : [],
    agentProfileIds: board ? unique(board.tasks.map((task) => task.agentProfileId).filter((id): id is string => id != null)) : [],
    runningPipelineCount: source.coverage.pipelines ? source.pipelines.filter((pipeline) => pipeline.status === "running").length : null,
    pausedBatchCount: source.coverage.batches ? source.batches.filter((batch) => batch.status === "paused").length : null,
    runningBatchCount: source.coverage.batches ? source.batches.filter((batch) => batch.status === "running").length : null,
    activeBatchCount: source.coverage.batches ? source.batches.filter((batch) => ACTIVE_BATCH.has(batch.status)).length : null,
    environmentConfigured: source.environment.configured.origin === "unknown" ? null : source.environment.configured.value,
    environmentPhase: source.environment.phase.origin === "unknown" || project.environmentFreshness !== "current" ? null : source.environment.phase.value,
    environmentPhaseOrigin: project.environmentFreshness === "current" || project.environmentFreshness == null ? source.environment.phase.origin : "unknown",
    environmentRecordedPhase: source.environment.phase.origin === "unknown" ? null : source.environment.phase.value,
    environmentPhaseObservedAtMs: source.environment.phase.observedAtMs,
    environmentPhaseFreshness: project.environmentFreshness,
    environmentPhaseNote: environmentPhaseNote(project),
  };
}

export function rollupCount(projects: readonly IndexedProject[], select: (project: IndexedProject) => number | null, noun: string): CountFact {
  if (projects.length === 0) return { status: "known", value: 0, knownValue: 0, note: null };
  let known = 0;
  let seen = 0;
  let skipped = 0;
  for (const project of projects) {
    if (project.freshness !== "current") {
      skipped += 1;
      continue;
    }
    const value = select(project);
    if (value == null) {
      skipped += 1;
      continue;
    }
    known += value;
    seen += 1;
  }
  if (skipped === 0) return { status: "known", value: known, knownValue: known, note: null };
  if (seen === 0) {
    return { status: "unknown", value: null, knownValue: null, note: `${noun} is unknown because no current observation was available.` };
  }
  return {
    status: "incomplete",
    value: null,
    knownValue: known,
    note: `${noun} is incomplete. ${skipped} project snapshot(s) are stale, unproven, or were not observed. The known portion is not the total.`,
  };
}

export function rollupColumns(projects: readonly IndexedProject[]): ColumnCounts {
  const knownCounts = emptyColumns();
  if (projects.length === 0) return { status: "known", counts: knownCounts, knownCounts, note: null };
  let seen = 0;
  let skipped = 0;
  for (const project of projects) {
    if (project.freshness !== "current" || !project.project.coverage.board) {
      skipped += 1;
      continue;
    }
    const counts = countBoard(project.boardTasks).columns;
    for (const column of Object.keys(knownCounts) as ColumnId[]) knownCounts[column] += counts[column];
    seen += 1;
  }
  if (skipped === 0) return { status: "known", counts: knownCounts, knownCounts, note: null };
  if (seen === 0) {
    return { status: "unknown", counts: null, knownCounts: emptyColumns(), note: "Column totals are unknown because no current board was observed." };
  }
  return {
    status: "incomplete",
    counts: null,
    knownCounts,
    note: "Column totals are incomplete. The known portion is not the portfolio total.",
  };
}

export function deadlineKey(projectId: string, taskId: string): string {
  return `${projectId}\u0000${taskId}`;
}

export function isActiveBatchStatus(status: BatchStatus): boolean {
  return ACTIVE_BATCH.has(status);
}

function indexProject(
  project: ProjectSnapshotInput,
  input: PortfolioSnapshotInput,
  seenTaskIds: Map<string, string>,
  duplicateTaskIds: string[],
  warnings: PortfolioIssue[],
): IndexedProject {
  const freshness = projectFreshness(project.observedAtMs, input.capturedAtMs, input.stalenessAfterMs);
  if (freshness === "stale") {
    warnings.push(warning("stale", project.id, `Project ${project.id} was observed at ${project.observedAtMs}, which is older than the staleness window. It is not treated as the current state.`));
  } else if (freshness === "unproven") {
    warnings.push(warning("unproven", project.id, `Project ${project.id} has no proven freshness, so its snapshot is not treated as the current state.`));
  }
  const boardTasks: TaskFactInput[] = [];
  const pipelineSteps: TaskFactInput[] = [];
  const tasksById = new Map<string, TaskFactInput>();
  const droppedDuplicateIds: string[] = [];
  for (const task of project.tasks) {
    const previous = seenTaskIds.get(task.id);
    if (previous) {
      droppedDuplicateIds.push(task.id);
      if (!duplicateTaskIds.includes(task.id)) duplicateTaskIds.push(task.id);
      warnings.push(warning("duplicate-task", task.id, `Task ${task.id} appears more than once (first kept on ${previous}). It was counted once.`));
      continue;
    }
    seenTaskIds.set(task.id, project.id);
    tasksById.set(task.id, task);
    if (task.pipelineParentId) pipelineSteps.push(task);
    else boardTasks.push(task);
  }
  const dependencies = project.coverage.dependencies
    ? project.dependencies.filter((edge) => {
        if (!tasksById.has(edge.taskId) || !tasksById.has(edge.dependsOn)) {
          warnings.push(warning("dangling-dependency", project.id, `Dependency ${edge.taskId} → ${edge.dependsOn} does not stay on two observed tasks in ${project.id}.`));
          return false;
        }
        const source = tasksById.get(edge.taskId);
        const target = tasksById.get(edge.dependsOn);
        if (source?.pipelineParentId || target?.pipelineParentId) {
          warnings.push(warning("pipeline-step-dependency", project.id, `Dependency ${edge.taskId} → ${edge.dependsOn} touches a pipeline step and is not a board dependency.`));
          return false;
        }
        return true;
      })
    : [];
  if (project.coverage.batches) {
    const boardIds = new Set(boardTasks.map((task) => task.id));
    for (const batch of project.batches) {
      for (const taskId of batch.taskIds) {
        if (!boardIds.has(taskId)) {
          warnings.push(warning("batch-task", batch.id, `Batch ${batch.id} names task ${taskId}, which is not a board task. It was not added to the task total.`));
        }
      }
    }
  }
  const environmentFreshness = recordedPhaseFreshness(project, input);
  return { project, freshness, environmentFreshness, boardTasks, pipelineSteps, tasksById, dependencies };
}

/** A recorded phase is current only when its own observation time is
 *  inside the snapshot's staleness window. */
export function recordedPhaseFreshness(project: ProjectSnapshotInput, input: Pick<PortfolioSnapshotInput, "capturedAtMs" | "stalenessAfterMs">): Freshness | null {
  const phase = project.environment.phase;
  if (phase.origin === "unknown" || phase.value == null) return null;
  if (phase.observedAtMs == null) return "unproven";
  return projectFreshness(phase.observedAtMs, input.capturedAtMs, input.stalenessAfterMs);
}

/** Plain-language reason the current phase is unknown, or null. */
export function environmentPhaseNote(project: IndexedProject): string | null {
  const phase = project.project.environment.phase;
  if (phase.origin === "unknown" || phase.value == null) return phase.detail ?? "No environment phase was observed.";
  if (project.environmentFreshness === "current") return null;
  const when = phase.observedAtMs == null ? "at an unknown time" : `at ${new Date(phase.observedAtMs).toISOString()}`;
  return project.environmentFreshness === "stale"
    ? `The last recorded phase was ${phase.value} ${when}, older than the staleness window. The environment was not probed, so its current state is unknown.`
    : `The phase ${phase.value} was recorded ${when}, and nothing proves it is current. The environment was not probed, so its current state is unknown.`;
}

function countBoard(tasks: readonly TaskFactInput[]): {
  tasks: TaskFactInput[];
  columns: Record<ColumnId, number>;
  archived: number;
  priorities: Partial<Record<TaskPriority | "unknown", number>>;
} {
  const active = tasks.filter((task) => !task.archived);
  const columns = emptyColumns();
  const priorities: Partial<Record<TaskPriority | "unknown", number>> = {};
  for (const task of active) {
    columns[task.column] += 1;
    const key = task.priority.origin === "unknown" || task.priority.value == null ? "unknown" : task.priority.value;
    priorities[key] = (priorities[key] ?? 0) + 1;
  }
  return { tasks: active, columns, archived: tasks.length - active.length, priorities };
}

function unique(values: readonly string[]): string[] {
  return [...new Set(values)];
}

function warning(code: string, path: string, message: string): PortfolioIssue {
  return { severity: "warning", code, path, message };
}
