/**
 * Read-only portfolio proposals. Every proposal says what the owner could
 * confirm later. None of them edit a task, a batch, an account, or a profile.
 */

import type { IndexedPortfolio, IndexedProject } from "./snapshot.ts";
import { isActiveBatchStatus } from "./snapshot.ts";
import type { PriorityAnalysis, RankedTask } from "./types.ts";
import {
  PORTFOLIO_LIMITS,
  type PortfolioProposal,
  type ResourceConflict,
  type ResourceSnapshotInput,
  type TaskFactInput,
} from "./types.ts";

export function planPortfolio(input: {
  indexed: IndexedPortfolio;
  conflicts: readonly ResourceConflict[];
  priorities: PriorityAnalysis;
}): PortfolioProposal[] {
  const proposals: PortfolioProposal[] = [];
  const { indexed, conflicts, priorities } = input;
  for (const project of indexed.projects) {
    if (project.freshness !== "current") continue;
    const review = project.boardTasks.filter((task) => !task.archived && task.column === "review");
    if (review.length === 0) continue;
    proposals.push(proposal({
      id: `proposal:review:${project.project.id}`,
      targetProjectIds: [project.project.id],
      actions: review.map((task) => ({
        kind: "request-owner-review",
        projectId: project.project.id,
        taskId: task.id,
        summary: `Ask the owner to review “${task.title}”.`,
      })),
      rationale: ["These tasks are in the review column. A finished agent run is not the done column."],
      expectedEffect: null,
      conflictIds: conflictIdsFor(conflicts, [project.project.id]),
      risks: [],
      unknowns: [],
      requiredApprovals: review.map((task) => ({
        id: `approval:review:${task.id}`,
        reason: `“${task.title}” is waiting for the owner.`,
        wouldChange: "The owner would accept or return the task. This core does not move the card.",
      })),
    }));
  }

  const focus = priorities.compared[0];
  if (focus) {
    proposals.push(proposal({
      id: `proposal:focus:${focus.projectId}`,
      targetProjectIds: [focus.projectId],
      actions: [{
        kind: "focus-project",
        projectId: focus.projectId,
        taskId: focus.taskId,
        summary: `Focus agents on ${focus.projectId}, starting from “${focus.title}”.`,
      }],
      rationale: focus.reasons,
      expectedEffect: focus.unblockCount != null && focus.unblockCount > 0
        ? {
            kind: "unblocked-tasks",
            note: "The count is how many not-done tasks wait on this one. It is not a time saving.",
            unblockedTaskCount: focus.unblockCount,
            conflictCount: null,
          }
        : null,
      conflictIds: conflictIdsFor(conflicts, [focus.projectId]),
      risks: [],
      unknowns: [],
      requiredApprovals: [{
        id: `approval:focus:${focus.projectId}`,
        reason: "Focus decides which project the agents should prefer.",
        wouldChange: "A later stage could tell that project's manager to prefer this work. No manager was contacted.",
      }],
    }));
    const blockerId = focus.blockedBy[0];
    if (blockerId) {
      const blocker = [...priorities.compared, ...priorities.taskPriorityOnly].find((task) => task.taskId === blockerId);
      proposals.push(proposal({
        id: `proposal:prioritize:${blockerId}`,
        targetProjectIds: [focus.projectId],
        actions: [{
          kind: "prioritize-task",
          projectId: blocker?.projectId ?? focus.projectId,
          taskId: blockerId,
          summary: `Ask the project manager to take “${blocker?.title ?? blockerId}” before the work it blocks.`,
        }],
        rationale: [
          `“${focus.title}” is ahead by the owner's declared priority and cannot start until “${blocker?.title ?? blockerId}” is in the done column.`,
          "The portfolio manager does not reorder work inside the project. This asks the project manager.",
        ],
        expectedEffect: blocker?.unblockCount != null
          ? {
              kind: "unblocked-tasks",
              note: "Unblock count of the dependency. The task priority was not changed.",
              unblockedTaskCount: blocker.unblockCount,
              conflictCount: null,
            }
          : null,
        conflictIds: [],
        risks: ["The owner's task priority still stands until they confirm a change."],
        unknowns: [],
        requiredApprovals: [{
          id: `approval:priority:${blockerId}`,
          reason: "Changing a task priority is the owner's decision.",
          wouldChange: "The task priority would be updated only after confirmation. It was not updated.",
        }],
      }));
    }
  }

  for (const project of indexed.projects) {
    if (project.freshness !== "current") continue;
    const ready = readyForBatch(project);
    if (ready.length === 0) continue;
    proposals.push(proposal({
      id: `proposal:batch:${project.project.id}`,
      targetProjectIds: [project.project.id],
      actions: [{
        kind: "suggest-execution-batch",
        projectId: project.project.id,
        taskId: ready[0]?.id ?? null,
        summary: `Suggest an execution batch of ${ready.length} ready task(s) in ${project.project.id}.`,
      }],
      rationale: ["These tasks are in the ready column, their structured dependencies are in the done column, and they are not already in an active batch."],
      expectedEffect: null,
      conflictIds: conflictIdsFor(conflicts, [project.project.id]),
      risks: conflictIdsFor(conflicts, [project.project.id]).length > 0 ? ["A resource conflict touches this project. The batch was not approved."] : [],
      unknowns: [],
      requiredApprovals: [{
        id: `approval:batch:${project.project.id}`,
        reason: "A batch starts only after the owner approves its tasks, harnesses, and spending.",
        wouldChange: "No batch was created and no task was started.",
      }],
    }));
  }

  const assignment = assignmentProposal(indexed, conflicts);
  if (assignment) proposals.push(assignment);

  const deferral = deferProposal(priorities);
  if (deferral) proposals.push(deferral);

  return proposals.slice(0, PORTFOLIO_LIMITS.maxProposals);
}

function assignmentProposal(indexed: IndexedPortfolio, conflicts: readonly ResourceConflict[]): PortfolioProposal | null {
  const conflict = conflicts.find((entry) => entry.class === "confirmed" && (entry.code === "concurrency-exceeded" || entry.code === "exclusive-resource"));
  if (!conflict?.resourceId) return null;
  const taskId = conflict.taskIds[1] ?? conflict.taskIds[0];
  if (!taskId) return null;
  const located = findTask(indexed, taskId);
  if (!located) return null;
  const alternative = indexed.resources.find((resource) => resourceFits(resource, located.task, conflict.resourceId));
  if (!alternative) return null;
  return proposal({
    id: `proposal:assign:${conflict.id}`,
    targetProjectIds: conflict.projectIds,
    actions: [{
      kind: "suggest-agent-assignment",
      projectId: located.project.project.id,
      taskId,
      summary: `Suggest running “${located.task.title}” on ${alternative.id} instead of ${conflict.resourceId}.`,
    }],
    resourceAssignments: [{
      taskId,
      projectId: located.project.project.id,
      resourceId: alternative.id,
      harnessId: alternative.harnessId,
      accountId: alternative.accountId,
    }],
    rationale: [
      conflict.explanation,
      `${alternative.id} is available and was not given this task. The assignment is a suggestion.`,
    ],
    expectedEffect: {
      kind: "conflict-count",
      note: "The suggestion addresses one confirmed conflict. It was not applied, so the conflict is still present.",
      unblockedTaskCount: null,
      conflictCount: 1,
    },
    conflictIds: [conflict.id],
    risks: ["The account was not switched. A later confirmation would be required before any harness change."],
    unknowns: alternative.supportedModels.origin === "unknown" ? ["Supported models for the suggested resource were not listed."] : [],
    requiredApprovals: [{
      id: `approval:assign:${taskId}`,
      reason: "Moving a task to another account or harness is the owner's decision.",
      wouldChange: "The task's harness and account would change only after confirmation. They were not changed.",
    }],
  });
}

function deferProposal(priorities: PriorityAnalysis): PortfolioProposal | null {
  const high = priorities.compared.find((task) => task.projectPriority === "critical" || task.projectPriority === "high");
  if (!high) return null;
  const lowProjects = new Map<string, RankedTask[]>();
  for (const task of priorities.compared) {
    if (task.projectPriority !== "low") continue;
    const list = lowProjects.get(task.projectId) ?? [];
    list.push(task);
    lowProjects.set(task.projectId, list);
  }
  for (const [projectId, tasks] of lowProjects) {
    if (projectId === high.projectId) continue;
    if (tasks.some((task) => task.taskPriority === "critical")) continue;
    return proposal({
      id: `proposal:defer:${projectId}`,
      targetProjectIds: [projectId, high.projectId],
      actions: [{
        kind: "defer-project",
        projectId,
        taskId: null,
        summary: `Defer ${projectId} while ${high.projectId} has declared priority ${high.projectPriority}.`,
      }],
      rationale: [
        `${high.projectId} is declared ${high.projectPriority}. ${projectId} is declared low and has no critical task.`,
        "Deferral does not archive the project or stop its agents.",
      ],
      expectedEffect: null,
      conflictIds: [],
      risks: ["Agents already running there keep running."],
      unknowns: [],
      requiredApprovals: [{
        id: `approval:defer:${projectId}`,
        reason: "Deferring a project is the owner's decision.",
        wouldChange: "The project would be marked deferred only after confirmation. It was not.",
      }],
    });
  }
  return null;
}

function readyForBatch(project: IndexedProject): TaskFactInput[] {
  if (!project.project.coverage.board || !project.project.coverage.dependencies || !project.project.coverage.batches) return [];
  const committed = new Set<string>();
  for (const batch of project.project.batches) {
    if (!isActiveBatchStatus(batch.status)) continue;
    for (const taskId of batch.taskIds) committed.add(taskId);
  }
  return project.boardTasks.filter((task) => {
    if (task.archived || task.column !== "ready" || committed.has(task.id)) return false;
    return !project.dependencies.some((edge) => {
      if (edge.taskId !== task.id) return false;
      const dependency = project.tasksById.get(edge.dependsOn);
      return !dependency || dependency.archived || dependency.column !== "done";
    });
  });
}

function resourceFits(resource: ResourceSnapshotInput, task: TaskFactInput, currentResourceId: string | null): boolean {
  if (resource.id === currentResourceId) return false;
  if (resource.availability.origin === "unknown" || resource.availability.value !== "available") return false;
  const limit = resource.concurrencyLimit;
  if (limit.origin === "unknown" || limit.value == null) return false;
  if (typeof limit.value === "number") {
    const occupied = resource.occupiedSlots.origin !== "unknown" && resource.occupiedSlots.value != null ? resource.occupiedSlots.value : 0;
    if (occupied + 1 > limit.value) return false;
  }
  if (task.modelId && resource.supportedModels.origin !== "unknown" && resource.supportedModels.value && !resource.supportedModels.value.includes(task.modelId)) {
    return false;
  }
  return true;
}

function findTask(indexed: IndexedPortfolio, taskId: string): { project: IndexedProject; task: TaskFactInput } | null {
  for (const project of indexed.projects) {
    const task = project.tasksById.get(taskId);
    if (task) return { project, task };
  }
  return null;
}

function conflictIdsFor(conflicts: readonly ResourceConflict[], projectIds: readonly string[]): string[] {
  return conflicts.filter((entry) => entry.projectIds.some((id) => projectIds.includes(id))).map((entry) => entry.id);
}

function proposal(
  value: Omit<PortfolioProposal, "readOnly" | "execution" | "resourceAssignments"> & {
    resourceAssignments?: PortfolioProposal["resourceAssignments"];
  },
): PortfolioProposal {
  return {
    ...value,
    resourceAssignments: value.resourceAssignments ?? [],
    readOnly: true,
    execution: "proposal-only",
  };
}
