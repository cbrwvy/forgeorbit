import type { MissionTaskPlan, MissionTaskDependencyRef } from "./types.js";

export interface DependencyValidationResult {
  valid: boolean;
  errors: string[];
  cycles: string[][];
}

export function findDependencyCycle(tasks: MissionTaskPlan[]): string[] | null {
  const taskMap = new Map<string, MissionTaskPlan>();
  for (const t of tasks) {
    taskMap.set(t.taskId, t);
  }

  // 0 = unvisited, 1 = visiting (in current DFS stack), 2 = visited
  const visited = new Map<string, number>();
  const parent = new Map<string, string>();

  for (const task of tasks) {
    if (visited.get(task.taskId)) continue;

    const stack: { id: string; depIndex: number }[] = [{ id: task.taskId, depIndex: 0 }];
    visited.set(task.taskId, 1);

    while (stack.length > 0) {
      const top = stack[stack.length - 1];
      if (!top) break;
      const currentTask = taskMap.get(top.id);
      const deps = currentTask?.dependencies || [];

      if (top.depIndex < deps.length) {
        const dep = deps[top.depIndex];
        top.depIndex++;
        if (!dep) continue;
        const nextDepId = dep.taskId;

        // Only check dependencies present in the task set
        if (!taskMap.has(nextDepId)) continue;

        const depState = visited.get(nextDepId);
        if (depState === 1) {
          // Cycle found! Reconstruct cycle path
          const cycle: string[] = [nextDepId];
          for (let i = stack.length - 1; i >= 0; i--) {
            const item = stack[i];
            if (!item) continue;
            cycle.push(item.id);
            if (item.id === nextDepId) break;
          }
          cycle.reverse();
          return cycle;
        }

        if (!depState) {
          visited.set(nextDepId, 1);
          stack.push({ id: nextDepId, depIndex: 0 });
        }
      } else {
        visited.set(top.id, 2);
        stack.pop();
      }
    }
  }

  return null;
}

export function validatePlanDependencies(
  tasks: MissionTaskPlan[],
  knownExternalTaskIds?: Set<string>,
): DependencyValidationResult {
  const errors: string[] = [];
  const cycles: string[][] = [];
  const taskIds = new Set(tasks.map((t) => t.taskId));

  for (const task of tasks) {
    if (!task.taskId || typeof task.taskId !== "string") {
      errors.push(`Task is missing a valid taskId`);
      continue;
    }

    const seenDeps = new Set<string>();

    for (const dep of task.dependencies || []) {
      if (!dep.taskId) {
        errors.push(`Task ${task.taskId} has a dependency with empty taskId`);
        continue;
      }

      if (dep.taskId === task.taskId) {
        errors.push(`Task ${task.taskId} cannot depend on itself`);
      }

      if (seenDeps.has(dep.taskId)) {
        errors.push(`Task ${task.taskId} has duplicate dependency on ${dep.taskId}`);
      }
      seenDeps.add(dep.taskId);

      const existsInPlan = taskIds.has(dep.taskId);
      const existsInKnown = knownExternalTaskIds?.has(dep.taskId) ?? false;

      if (!existsInPlan && !existsInKnown) {
        errors.push(
          `Task ${task.taskId} depends on missing task ${dep.taskId} (${dep.projectPath})`,
        );
      }
    }
  }

  const cycle = findDependencyCycle(tasks);
  if (cycle) {
    cycles.push(cycle);
    errors.push(`Dependency cycle detected: ${cycle.join(" -> ")}`);
  }

  return {
    valid: errors.length === 0,
    errors,
    cycles,
  };
}

export interface TaskDependencyEvaluation {
  isReady: boolean;
  isBlocked: boolean;
  blockers: string[];
}

export function evaluateTaskDependencies(
  task: MissionTaskPlan,
  satisfiedTaskIds: Set<string>,
  failedTaskIds: Set<string> = new Set(),
  cancelledTaskIds: Set<string> = new Set(),
): TaskDependencyEvaluation {
  const blockers: string[] = [];
  const deps = task.dependencies || [];

  for (const dep of deps) {
    if (failedTaskIds.has(dep.taskId)) {
      blockers.push(`Dependency ${dep.taskId} (${dep.projectPath}) has failed`);
      continue;
    }

    if (cancelledTaskIds.has(dep.taskId)) {
      blockers.push(`Dependency ${dep.taskId} (${dep.projectPath}) was cancelled`);
      continue;
    }

    if (!satisfiedTaskIds.has(dep.taskId)) {
      blockers.push(
        `Awaiting dependency ${dep.taskId} (${dep.projectPath}) condition ${dep.condition}`,
      );
    }
  }

  const isBlocked = blockers.length > 0;
  const isReady = !isBlocked;

  return {
    isReady,
    isBlocked,
    blockers,
  };
}

/**
 * Topologically sort tasks. If cycles exist, leaves remaining tasks in original order.
 */
export function topologicalSortTasks(tasks: MissionTaskPlan[]): MissionTaskPlan[] {
  const inDegree = new Map<string, number>();
  const graph = new Map<string, string[]>();
  const taskMap = new Map<string, MissionTaskPlan>();

  for (const task of tasks) {
    taskMap.set(task.taskId, task);
    inDegree.set(task.taskId, 0);
    graph.set(task.taskId, []);
  }

  for (const task of tasks) {
    for (const dep of task.dependencies || []) {
      if (taskMap.has(dep.taskId)) {
        graph.get(dep.taskId)!.push(task.taskId);
        inDegree.set(task.taskId, (inDegree.get(task.taskId) || 0) + 1);
      }
    }
  }

  const queue: string[] = [];
  for (const [id, deg] of inDegree.entries()) {
    if (deg === 0) {
      queue.push(id);
    }
  }

  const sorted: MissionTaskPlan[] = [];
  while (queue.length > 0) {
    const currentId = queue.shift()!;
    const task = taskMap.get(currentId);
    if (task) {
      sorted.push(task);
    }

    for (const dependentId of graph.get(currentId) || []) {
      const nextDeg = (inDegree.get(dependentId) || 1) - 1;
      inDegree.set(dependentId, nextDeg);
      if (nextDeg === 0) {
        queue.push(dependentId);
      }
    }
  }

  // If there were unreachable or cyclic nodes, append them at the end
  if (sorted.length < tasks.length) {
    const included = new Set(sorted.map((t) => t.taskId));
    for (const task of tasks) {
      if (!included.has(task.taskId)) {
        sorted.push(task);
      }
    }
  }

  return sorted;
}
