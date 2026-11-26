/**
 * What-if replans a copy. The caller's snapshot is not modified, nothing is
 * stored, and no agent, harness, or model call is made.
 */

import type { PortfolioSnapshotInput, PortfolioWhatIfPatch } from "./types.ts";

export function applyPortfolioWhatIf(
  input: PortfolioSnapshotInput,
  patch: PortfolioWhatIfPatch,
): { snapshot: PortfolioSnapshotInput; notes: string[] } {
  const snapshot = structuredClone(input);
  const notes: string[] = ["What-if changed a copy. The original snapshot was not written, and no task was started."];
  if (patch.excludeProjectIds) {
    const drop = new Set(patch.excludeProjectIds);
    for (const id of drop) {
      if (!snapshot.projects.some((project) => project.id === id)) notes.push(`No project ${id} to exclude.`);
    }
    snapshot.projects = snapshot.projects.filter((project) => !drop.has(project.id));
    snapshot.projectPriorities = snapshot.projectPriorities.filter((priority) => !drop.has(priority.projectId));
    snapshot.deadlines = snapshot.deadlines.filter((deadline) => !drop.has(deadline.projectId));
  }
  if (patch.selectedTaskIds) {
    const keep = new Set(patch.selectedTaskIds);
    for (const project of snapshot.projects) {
      project.tasks = project.tasks.filter((task) => keep.has(task.id));
      project.runs = project.runs.filter((run) => keep.has(run.taskId));
      project.dependencies = project.dependencies.filter((edge) => keep.has(edge.taskId) && keep.has(edge.dependsOn));
      for (const batch of project.batches) batch.taskIds = batch.taskIds.filter((taskId) => keep.has(taskId));
    }
  }
  if (patch.projectPriorities) snapshot.projectPriorities = structuredClone(patch.projectPriorities);
  if (patch.dropResourceIds) {
    const drop = new Set(patch.dropResourceIds);
    snapshot.resources = snapshot.resources.filter((resource) => !drop.has(resource.id));
  }
  if (patch.upsertResources) {
    for (const resource of patch.upsertResources) {
      const index = snapshot.resources.findIndex((current) => current.id === resource.id);
      const copy = structuredClone(resource);
      if (index >= 0) snapshot.resources[index] = copy;
      else snapshot.resources.push(copy);
    }
  }
  for (const change of patch.concurrency ?? []) {
    const resource = snapshot.resources.find((current) => current.id === change.resourceId);
    if (!resource) {
      notes.push(`Concurrency target ${change.resourceId} was not found.`);
      continue;
    }
    resource.concurrencyLimit = { value: change.limit, origin: change.origin, observedAtMs: snapshot.capturedAtMs };
  }
  if (patch.policy) snapshot.policy = { ...snapshot.policy, ...structuredClone(patch.policy) };
  for (const allocation of patch.allocations ?? []) {
    const resource = snapshot.resources.find((current) => current.id === allocation.resourceId);
    if (!resource) {
      notes.push(`Allocation resource ${allocation.resourceId} was not found.`);
      continue;
    }
    let found = false;
    for (const project of snapshot.projects) {
      const task = project.tasks.find((current) => current.id === allocation.taskId);
      if (!task) continue;
      found = true;
      task.harnessId = resource.harnessId;
      task.accountId = resource.accountId;
    }
    if (!found) notes.push(`Allocation task ${allocation.taskId} was not found.`);
  }
  return { snapshot, notes };
}
