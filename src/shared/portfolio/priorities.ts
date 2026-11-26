/**
 * Cross-project ordering. Declared project priority is never invented, and
 * a task with no priority row is not treated as normal. Deadlines order two
 * tasks only when both deadlines were confirmed. A missing deadline is not
 * overdue.
 */

import type { TaskPriority } from "../task-scheduling.ts";
import type { IndexedPortfolio, IndexedProject } from "./snapshot.ts";
import { deadlineKey } from "./snapshot.ts";
import { matchTaskResource } from "./resources.ts";
import { priorityRank, type PriorityAnalysis, type RankedTask } from "./types.ts";

export function analyzePriorities(indexed: IndexedPortfolio): PriorityAnalysis {
  const compared: RankedTask[] = [];
  const taskPriorityOnly: RankedTask[] = [];
  for (const project of indexed.projects) {
    if (project.freshness !== "current" || !project.project.coverage.board) continue;
    const unblocks = unblockCounts(project);
    const declared = indexed.priorityByProject.get(project.project.id) ?? null;
    for (const task of project.boardTasks) {
      if (task.archived || task.column === "done") continue;
      const ranked = rankTask(indexed, project, task, declared?.priority ?? null, unblocks);
      if (declared) compared.push(ranked);
      else taskPriorityOnly.push(ranked);
    }
  }
  compared.sort(compareRanked);
  taskPriorityOnly.sort(compareRanked);
  const deadlines = [...indexed.deadlineByTask.values()]
    .filter((deadline) => {
      const project = indexed.projects.find((entry) => entry.project.id === deadline.projectId);
      const task = project?.tasksById.get(deadline.taskId);
      return project?.freshness === "current" && task != null && !task.archived && !task.pipelineParentId && task.column !== "done";
    })
    .map((deadline) => ({
      projectId: deadline.projectId,
      taskId: deadline.taskId,
      atMs: deadline.atMs,
      remainingMs: deadline.atMs - indexed.input.capturedAtMs,
    }))
    .sort((a, b) => a.atMs - b.atMs || (a.taskId < b.taskId ? -1 : 1));
  const deadlineIds = new Set(deadlines.map((deadline) => deadline.taskId));
  const missingDeadlineTaskIds = [...compared, ...taskPriorityOnly]
    .map((task) => task.taskId)
    .filter((taskId) => !deadlineIds.has(taskId));
  return {
    compared,
    taskPriorityOnly,
    deadlines,
    missingDeadlineTaskIds,
    notes: [
      "Project priority is used only where the owner declared it. Undeclared projects are listed apart and are not placed below Low.",
      "Task priority is used only where a priority was supplied. A missing priority is not read as Normal.",
      "A dependency counts as done only when that task is in the done column. A finished run is not enough.",
      "A confirmed deadline orders two tasks only when both have one. A task with no deadline is not treated as overdue.",
    ],
  };
}

function rankTask(
  indexed: IndexedPortfolio,
  project: IndexedProject,
  task: IndexedProject["boardTasks"][number],
  projectPriority: TaskPriority | null,
  unblocks: ReadonlyMap<string, number> | null,
): RankedTask {
  const taskPriority = task.priority.origin === "unknown" ? null : task.priority.value;
  const blockedBy = project.dependencies
    .filter((edge) => edge.taskId === task.id)
    .filter((edge) => {
      const dependency = project.tasksById.get(edge.dependsOn);
      return !dependency || dependency.archived || dependency.pipelineParentId != null || dependency.column !== "done";
    })
    .map((edge) => edge.dependsOn);
  const deadline = indexed.deadlineByTask.get(deadlineKey(project.project.id, task.id)) ?? null;
  const match = matchTaskResource(task, indexed.resources);
  let executableNow = task.column === "ready" && blockedBy.length === 0;
  let executableReason: string | null = null;
  if (task.column !== "ready") executableReason = `The task is in ${task.column}, not ready.`;
  else if (blockedBy.length > 0) executableReason = `Waiting on ${blockedBy.join(", ")}.`;
  if (match.kind === "one" && match.resource && match.resource.availability.origin !== "unknown" && match.resource.availability.value === "unavailable") {
    executableNow = false;
    executableReason = `Harness ${match.resource.harnessId} is unavailable.`;
  }
  const reasons: string[] = [];
  if (projectPriority) reasons.push(`Project priority is ${projectPriority}, declared by the owner.`);
  else reasons.push("No project priority was declared, so this task is not ranked against prioritized projects.");
  if (taskPriority) reasons.push(`Task priority is ${taskPriority}.`);
  else reasons.push("No task priority was supplied. It was not assumed to be normal.");
  if (unblocks) {
    const count = unblocks.get(task.id) ?? 0;
    reasons.push(count > 0 ? `Unblocks ${count} not-done task(s).` : "Unblocks no other not-done task.");
  } else {
    reasons.push("Dependencies were not observed, so unblock count is unknown.");
  }
  if (deadline) reasons.push(`Confirmed deadline at ${deadline.atMs}.`);
  else reasons.push("No confirmed deadline.");
  if (blockedBy.length > 0) reasons.push(`Blocked by ${blockedBy.join(", ")} until those tasks are in the done column.`);
  return {
    projectId: project.project.id,
    taskId: task.id,
    title: task.title,
    projectPriority,
    taskPriority,
    unblockCount: unblocks ? unblocks.get(task.id) ?? 0 : null,
    deadlineAtMs: deadline?.atMs ?? null,
    blockedBy,
    executableNow,
    executableReason,
    reasons,
  };
}

function compareRanked(a: RankedTask, b: RankedTask): number {
  const byProject = compareDeclared(a.projectPriority, b.projectPriority);
  if (byProject !== 0) return byProject;
  const byTask = compareDeclared(a.taskPriority, b.taskPriority);
  if (byTask !== 0) return byTask;
  if (a.unblockCount != null && b.unblockCount != null && a.unblockCount !== b.unblockCount) {
    return b.unblockCount - a.unblockCount;
  }
  if (a.deadlineAtMs != null && b.deadlineAtMs != null && a.deadlineAtMs !== b.deadlineAtMs) {
    return a.deadlineAtMs - b.deadlineAtMs;
  }
  if (a.projectId !== b.projectId) return a.projectId < b.projectId ? -1 : 1;
  return a.taskId < b.taskId ? -1 : a.taskId > b.taskId ? 1 : 0;
}

function compareDeclared(a: TaskPriority | null, b: TaskPriority | null): number {
  if (a == null && b == null) return 0;
  if (a == null) return 1;
  if (b == null) return -1;
  return priorityRank(a) - priorityRank(b);
}

function unblockCounts(project: IndexedProject): Map<string, number> | null {
  if (!project.project.coverage.dependencies) return null;
  const tasks = project.boardTasks.filter((task) => !task.archived && task.column !== "done");
  const index = new Map<string, number>();
  tasks.forEach((task, position) => index.set(task.id, position));
  const dependents: number[][] = tasks.map(() => []);
  for (const edge of project.dependencies) {
    const prerequisite = index.get(edge.dependsOn);
    const waiter = index.get(edge.taskId);
    if (prerequisite == null || waiter == null) continue;
    dependents[prerequisite]?.push(waiter);
  }
  const counts = new Map<string, number>();
  const seen = new Int32Array(tasks.length);
  let stamp = 1;
  for (let start = 0; start < tasks.length; start++) {
    stamp += 1;
    if (stamp === 0x7fffffff) {
      seen.fill(0);
      stamp = 1;
    }
    let count = 0;
    const queue = [...(dependents[start] ?? [])];
    for (let cursor = 0; cursor < queue.length; cursor++) {
      const node = queue[cursor];
      if (node == null || seen[node] === stamp) continue;
      seen[node] = stamp;
      count += 1;
      for (const next of dependents[node] ?? []) queue.push(next);
    }
    const task = tasks[start];
    if (task) counts.set(task.id, count);
  }
  return counts;
}
