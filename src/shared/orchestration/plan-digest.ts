import { createHash } from "node:crypto";
import type { MissionPlan, MissionTaskPlan, MissionTaskDependencyRef } from "./types.js";

function normalizeDependency(dep: MissionTaskDependencyRef) {
  return {
    condition: dep.condition,
    projectPath: dep.projectPath,
    taskId: dep.taskId,
  };
}

function normalizeTask(task: MissionTaskPlan) {
  const deps = [...(task.dependencies || [])]
    .map(normalizeDependency)
    .sort((a, b) => a.taskId.localeCompare(b.taskId) || a.projectPath.localeCompare(b.projectPath));

  return {
    accountId: task.accountId ?? null,
    assignedEmployeeId: task.assignedEmployeeId ?? null,
    clusterId: task.clusterId ?? null,
    dependencies: deps,
    harnessId: task.harnessId,
    mode: task.mode,
    ...(task.developerBinding ? { developerBinding: task.developerBinding } : {}),
    ...(task.reviewerBinding ? { reviewerBinding: task.reviewerBinding } : {}),
    modelId: task.modelId,
    priority: task.priority,
    projectPath: task.projectPath,
    qcRequired: Boolean(task.qcRequired),
    specialistRole: task.specialistRole,
    taskId: task.taskId,
    taskTitle: task.taskTitle,
    ...(task.objectiveTask ? { objectiveTask: task.objectiveTask } : {}),
  };
}

export function normalizeMissionPlan(plan: MissionPlan) {
  const clusters = [...(plan.clusters || [])].sort();
  const projects = [...(plan.projects || [])].sort();
  const tasks = [...(plan.tasks || [])]
    .map(normalizeTask)
    .sort((a, b) => a.taskId.localeCompare(b.taskId) || a.projectPath.localeCompare(b.projectPath));

  return {
    ...(plan.objective ? { objective: plan.objective } : {}),
    clusters,
    concurrencyLimits: {
      globalMax: plan.concurrencyLimits?.globalMax ?? 8,
      perAccountMax: plan.concurrencyLimits?.perAccountMax ?? 3,
      perProjectMax: plan.concurrencyLimits?.perProjectMax ?? 2,
      ...(plan.concurrencyLimits?.perClusterMax !== undefined ? { perClusterMax: plan.concurrencyLimits.perClusterMax } : {}),
    },
    executionPolicy: {
      autoResumeOnQcPass: Boolean(plan.executionPolicy?.autoResumeOnQcPass),
      maxRetriesPerTask: plan.executionPolicy?.maxRetriesPerTask ?? 0,
      qcRequired: Boolean(plan.executionPolicy?.qcRequired ?? true),
    },
    projects,
    spendingLimitUsd: plan.spendingLimitUsd ?? null,
    tasks,
  };
}

export function computeMissionPlanDigest(plan: MissionPlan): string {
  const normalized = normalizeMissionPlan(plan);
  return createHash("sha256").update(JSON.stringify(normalized)).digest("hex");
}
