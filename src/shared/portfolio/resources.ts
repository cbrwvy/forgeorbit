/**
 * Shared harness and account capacity. A percent-used meter is stored as a
 * warning and is never read as remaining quota. Conflicts are detected only.
 * No running agent is stopped.
 */

import type { IndexedPortfolio, IndexedProject } from "./snapshot.ts";
import { isActiveBatchStatus } from "./snapshot.ts";
import type { ResourceConflict, ResourceSnapshotInput, ResourceView, TaskFactInput } from "./types.ts";

export interface TaskMatch {
  kind: "one" | "none" | "ambiguous";
  resource: ResourceSnapshotInput | null;
  resourceIds: string[];
}

interface Use {
  projectId: string;
  taskId: string;
  current: boolean;
  active: boolean;
  committed: boolean;
  ready: boolean;
  modelId: string | null;
  requiredPermissions: string[];
  spending: TaskFactInput["spending"];
}

export function matchTaskResource(task: Pick<TaskFactInput, "harnessId" | "accountId">, resources: readonly ResourceSnapshotInput[]): TaskMatch {
  if (!task.harnessId) return { kind: "none", resource: null, resourceIds: [] };
  const byHarness = resources.filter((resource) => resource.harnessId === task.harnessId);
  const hits = task.accountId ? byHarness.filter((resource) => resource.accountId === task.accountId) : byHarness;
  if (hits.length === 1) {
    const resource = hits[0];
    if (!resource) return { kind: "none", resource: null, resourceIds: [] };
    return { kind: "one", resource, resourceIds: [resource.id] };
  }
  if (hits.length === 0) return { kind: "none", resource: null, resourceIds: [] };
  return { kind: "ambiguous", resource: null, resourceIds: hits.map((resource) => resource.id) };
}

export function assessResources(indexed: IndexedPortfolio): { resources: ResourceView[]; conflicts: ResourceConflict[] } {
  const usesByResource = new Map<string, Use[]>();
  const conflicts: ResourceConflict[] = [];
  for (const resource of indexed.resources) usesByResource.set(resource.id, []);

  for (const project of indexed.projects) {
    const committed = committedIds(project);
    for (const task of project.boardTasks) {
      if (task.archived || task.column === "done") continue;
      const match = matchTaskResource(task, indexed.resources);
      const use = toUse(project, task, committed);
      if (match.kind === "ambiguous") {
        conflicts.push(conflict({
          id: `conflict:ambiguous:${task.id}`,
          class: "insufficient-data",
          code: "ambiguous-account",
          resourceId: null,
          projectIds: [project.project.id],
          taskIds: [task.id],
          waivable: true,
          severity: "warning",
          explanation: `Task ${task.id} matches more than one account on harness ${task.harnessId}. The plan cannot be confirmed.`,
          evidence: match.resourceIds,
          policy: indexed.input.policy,
        }));
        continue;
      }
      if (match.kind !== "one" || !match.resource) {
        if (task.harnessId) {
          conflicts.push(conflict({
            id: `conflict:missing-resource:${task.id}`,
            class: "insufficient-data",
            code: "resource-not-in-snapshot",
            resourceId: null,
            projectIds: [project.project.id],
            taskIds: [task.id],
            waivable: true,
            severity: "warning",
            explanation: `Task ${task.id} names harness ${task.harnessId}, and no matching resource was in the snapshot.`,
            evidence: [task.harnessId],
            policy: indexed.input.policy,
          }));
        }
        continue;
      }
      usesByResource.get(match.resource.id)?.push(use);
    }
  }

  const views: ResourceView[] = [];
  for (const resource of indexed.resources) {
    const uses = usesByResource.get(resource.id) ?? [];
    const current = uses.filter((use) => use.current);
    const projectIds = unique(current.map((use) => use.projectId));
    const warnings: string[] = [];
    if (resource.accountId == null) {
      warnings.push("The account behind this harness is not identified. It may share an account with another harness, so shared capacity is unknown.");
    }
    if (resource.quota.kind === "percent-used") {
      warnings.push("A used-percent meter is not remaining capacity. It was not converted into a balance and was not treated as exhaustion, including at 100%.");
    }
    const occupied = resource.occupiedSlots.origin !== "unknown" ? resource.occupiedSlots.value : null;
    views.push({
      id: resource.id,
      harnessId: resource.harnessId,
      accountId: resource.accountId,
      subscriptionId: resource.subscriptionId,
      projectIds,
      capacity: capacityOf(resource),
      concurrencyLimit: resource.concurrencyLimit.origin === "unknown" ? null : resource.concurrencyLimit.value,
      occupiedSlots: occupied,
      quotaTreatment: quotaTreatment(resource),
      warnings,
    });
    if (current.length === 0) {
      if (uses.length > 0) {
        conflicts.push(conflict({
          id: `conflict:stale:${resource.id}`,
          class: "insufficient-data",
          code: "stale-occupancy",
          resourceId: resource.id,
          projectIds: unique(uses.map((use) => use.projectId)),
          taskIds: uses.map((use) => use.taskId),
          waivable: true,
          severity: "warning",
          explanation: `Resource ${resource.id} is only referenced by stale or unproven snapshots, so current contention is unknown.`,
          evidence: [],
          policy: indexed.input.policy,
        }));
      }
      continue;
    }
    conflicts.push(...resourceConflicts(resource, current, indexed));
  }

  conflicts.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  return { resources: views, conflicts };
}

function resourceConflicts(resource: ResourceSnapshotInput, uses: readonly Use[], indexed: IndexedPortfolio): ResourceConflict[] {
  const out: ResourceConflict[] = [];
  const policy = indexed.input.policy;
  const projectIds = unique(uses.map((use) => use.projectId));
  const taskIds = uses.map((use) => use.taskId);
  const active = uses.filter((use) => use.active);
  const committed = uses.filter((use) => use.active || use.committed);
  const planned = uses.filter((use) => use.active || use.committed || use.ready);

  if (resource.availability.origin !== "unknown" && resource.availability.value === "unavailable") {
    out.push(conflict({
      id: `conflict:unavailable:${resource.id}`,
      class: "confirmed",
      code: "harness-unavailable",
      resourceId: resource.id,
      projectIds,
      taskIds,
      waivable: false,
      severity: "critical",
      explanation: `Harness ${resource.harnessId} is unavailable. Tasks that name it cannot be started automatically. Running agents were not stopped.`,
      evidence: [`availability:${resource.availability.origin}`],
      policy,
    }));
  }

  const models = resource.supportedModels;
  if (models.origin !== "unknown" && models.value) {
    for (const use of uses) {
      if (use.modelId == null) continue;
      if (!models.value.includes(use.modelId)) {
        out.push(conflict({
          id: `conflict:model:${resource.id}:${use.taskId}`,
          class: "confirmed",
          code: "unsupported-model",
          resourceId: resource.id,
          projectIds: [use.projectId],
          taskIds: [use.taskId],
          waivable: false,
          severity: "critical",
          explanation: `Model ${use.modelId} is not in the supported list for ${resource.id}. The list was ${models.origin}. Running agents were not stopped.`,
          evidence: models.value,
          policy,
        }));
      }
    }
  }

  const limitFact = resource.concurrencyLimit;
  if (limitFact.origin === "unknown" || limitFact.value == null) {
    if (uses.length > 1 || resource.exclusive) {
      out.push(conflict({
        id: `conflict:concurrency-unknown:${resource.id}`,
        class: "insufficient-data",
        code: "concurrency-unknown",
        resourceId: resource.id,
        projectIds,
        taskIds,
        waivable: true,
        severity: "warning",
        explanation: `Concurrency for ${resource.id} is unknown, so a shared plan cannot be confirmed. This is not a confirmed overflow.`,
        evidence: [],
        policy,
      }));
    }
  } else if (typeof limitFact.value === "number") {
    const limit = limitFact.value;
    const occupied = resource.occupiedSlots.origin !== "unknown" && resource.occupiedSlots.value != null
      ? resource.occupiedSlots.value
      : active.length;
    const occupancyDisagrees = resource.occupiedSlots.origin !== "unknown"
      && resource.occupiedSlots.value != null
      && resource.occupiedSlots.value !== active.length;
    if (occupancyDisagrees && occupied > limit && active.length <= limit) {
      out.push(conflict({
        id: `conflict:concurrency:${resource.id}`,
        class: "potential",
        code: "concurrency-disagreement",
        resourceId: resource.id,
        projectIds,
        taskIds,
        waivable: false,
        severity: "warning",
        explanation: `Occupied slots (${occupied}) and observed running tasks (${active.length}) disagree against a limit of ${limit}. The overflow is not confirmed.`,
        evidence: [`limit:${limit}`, `occupied:${occupied}`, `active:${active.length}`],
        policy,
      }));
    } else if (occupied > limit || active.length > limit) {
      out.push(conflict({
        id: `conflict:concurrency:${resource.id}`,
        class: "confirmed",
        code: "concurrency-exceeded",
        resourceId: resource.id,
        projectIds,
        taskIds: active.map((use) => use.taskId),
        waivable: false,
        severity: "critical",
        explanation: `${resource.id} allows ${limit} concurrent slot(s) and ${Math.max(occupied, active.length)} are in use across ${projectIds.length} project(s). Running agents were not stopped.`,
        evidence: [`limit:${limit}`, `occupied:${occupied}`, `active:${active.length}`],
        policy,
      }));
    } else if (committed.length > limit) {
      out.push(conflict({
        id: `conflict:plan:${resource.id}`,
        class: "confirmed",
        code: "plan-exceeds-concurrency",
        resourceId: resource.id,
        projectIds: unique(committed.map((use) => use.projectId)),
        taskIds: committed.map((use) => use.taskId),
        waivable: false,
        severity: "critical",
        explanation: `An approved batch plan for ${resource.id} needs ${committed.length} slot(s) and the limit is ${limit}. The plan was not changed.`,
        evidence: [`limit:${limit}`, `committed:${committed.length}`],
        policy,
      }));
    } else if (planned.length > limit) {
      out.push(conflict({
        id: `conflict:potential:${resource.id}`,
        class: "potential",
        code: "plan-might-exceed",
        resourceId: resource.id,
        projectIds,
        taskIds: planned.map((use) => use.taskId),
        waivable: false,
        severity: "warning",
        explanation: `If every ready task on ${resource.id} started, ${planned.length} slot(s) would be needed and the limit is ${limit}. Nothing was started.`,
        evidence: [`limit:${limit}`, `planned:${planned.length}`, `active:${active.length}`],
        policy,
      }));
    }
  }

  if (resource.exclusive && active.length > 1) {
    out.push(conflict({
      id: `conflict:exclusive:${resource.id}`,
      class: "confirmed",
      code: "exclusive-resource",
      resourceId: resource.id,
      projectIds,
      taskIds: active.map((use) => use.taskId),
      waivable: false,
      severity: "critical",
      explanation: `${resource.id} is an exclusive local resource and ${active.length} tasks hold it. Running agents were not stopped.`,
      evidence: active.map((use) => use.taskId),
      policy,
    }));
  } else if (resource.exclusive && planned.length > 1) {
    out.push(conflict({
      id: `conflict:exclusive:${resource.id}`,
      class: "potential",
      code: "exclusive-resource",
      resourceId: resource.id,
      projectIds,
      taskIds: planned.map((use) => use.taskId),
      waivable: false,
      severity: "warning",
      explanation: `${resource.id} is exclusive. ${planned.length} not-done tasks name it, so they cannot all run.`,
      evidence: planned.map((use) => use.taskId),
      policy,
    }));
  }

  if (resource.quota.kind === "exhausted" || (resource.quota.kind === "remaining" && resource.quota.remaining === 0)) {
    out.push(conflict({
      id: `conflict:quota:${resource.id}`,
      class: "confirmed",
      code: "quota-exhausted",
      resourceId: resource.id,
      projectIds,
      taskIds,
      waivable: false,
      severity: "critical",
      explanation: resource.quota.kind === "exhausted"
        ? `Quota for ${resource.id} is exhausted: ${resource.quota.evidence} Running agents were not stopped.`
        : `Quota for ${resource.id} has a remaining count of 0. A usage percentage was not used. Running agents were not stopped.`,
      evidence: [resource.quota.kind],
      policy,
    }));
  } else if (resource.quota.kind === "unknown" || resource.quota.kind === "opaque" || resource.quota.kind === "percent-used") {
    const code = resource.quota.kind === "percent-used" ? "quota-percent-not-capacity" : "quota-unknown";
    out.push(conflict({
      id: `conflict:quota-unknown:${resource.id}`,
      class: "insufficient-data",
      code,
      resourceId: resource.id,
      projectIds,
      taskIds,
      waivable: true,
      severity: "warning",
      explanation: code === "quota-percent-not-capacity"
        ? `Quota for ${resource.id} is only a used-percent meter. Feasibility of the plan cannot be confirmed from it.`
        : `Quota for ${resource.id} is unknown, so feasibility of the plan cannot be confirmed. Unknown was not turned into a confirmed block.`,
      evidence: [resource.quota.kind],
      policy,
    }));
  }

  for (const projectId of projectIds) {
    const project = indexed.projects.find((entry) => entry.project.id === projectId);
    if (project?.project.estimate?.coverageStatus === "insufficient") {
      out.push(conflict({
        id: `conflict:coverage:${resource.id}:${projectId}`,
        class: "confirmed",
        code: "quota-coverage",
        resourceId: resource.id,
        projectIds: [projectId],
        taskIds: uses.filter((use) => use.projectId === projectId).map((use) => use.taskId),
        waivable: false,
        severity: "critical",
        explanation: `The existing estimate for ${projectId} reports insufficient quota coverage on work that uses ${resource.id}.`,
        evidence: ["coverage:insufficient"],
        policy,
      }));
    }
  }

  if (resource.permissions.origin !== "unknown" && resource.permissions.value) {
    const allowed = new Set(resource.permissions.value);
    for (const use of uses) {
      for (const code of use.requiredPermissions) {
        if (allowed.has(code)) continue;
        out.push(conflict({
          id: `conflict:permission:${resource.id}:${use.taskId}:${code}`,
          class: "confirmed",
          code: "permission-denied",
          resourceId: resource.id,
          projectIds: [use.projectId],
          taskIds: [use.taskId],
          waivable: false,
          severity: "critical",
          explanation: `Task ${use.taskId} requires permission ${code}, which ${resource.id} does not grant. Automatic execution stays blocked.`,
          evidence: [code],
          policy,
        }));
      }
    }
  }

  if (resource.extraSpending.origin !== "unknown" && resource.extraSpending.value === "forbidden") {
    for (const use of uses) {
      if (use.spending !== "allow-overage" && use.spending !== "allow-paid") continue;
      out.push(conflict({
        id: `conflict:spending:${resource.id}:${use.taskId}`,
        class: "confirmed",
        code: "spending-forbidden",
        resourceId: resource.id,
        projectIds: [use.projectId],
        taskIds: [use.taskId],
        waivable: false,
        severity: "critical",
        explanation: `Task ${use.taskId} would spend beyond the plan, and ${resource.id} forbids extra spending. Automatic execution stays blocked.`,
        evidence: [use.spending],
        policy,
      }));
    }
  }

  return out;
}

function toUse(project: IndexedProject, task: TaskFactInput, committed: ReadonlySet<string>): Use {
  const runningRun = project.project.coverage.runs && project.project.runs.some((run) => run.taskId === task.id && run.status === "running");
  const active = task.column === "running" || runningRun;
  const inBatch = committed.has(task.id);
  return {
    projectId: project.project.id,
    taskId: task.id,
    current: project.freshness === "current",
    active,
    committed: inBatch,
    ready: task.column === "ready" && !active && !inBatch,
    modelId: task.modelId,
    requiredPermissions: task.requiredPermissions,
    spending: task.spending,
  };
}

function committedIds(project: IndexedProject): Set<string> {
  const ids = new Set<string>();
  if (!project.project.coverage.batches) return ids;
  for (const batch of project.project.batches) {
    if (!isActiveBatchStatus(batch.status)) continue;
    for (const taskId of batch.taskIds) ids.add(taskId);
  }
  return ids;
}

function capacityOf(resource: ResourceSnapshotInput): ResourceView["capacity"] {
  if (resource.concurrencyLimit.origin === "unknown" || resource.concurrencyLimit.value == null) return "unknown";
  if (resource.concurrencyLimit.value === "unbounded") return "explicit-unbounded";
  return "known";
}

function quotaTreatment(resource: ResourceSnapshotInput): string {
  switch (resource.quota.kind) {
    case "unknown":
      return "unknown";
    case "percent-used":
      return "percent-used-not-capacity";
    case "remaining":
      return resource.quota.remaining === 0 ? "remaining-zero" : "remaining-count";
    case "exhausted":
      return "exhausted";
    case "opaque":
      return "opaque";
    default:
      return "unknown";
  }
}

function conflict(input: {
  id: string;
  class: ResourceConflict["class"];
  code: string;
  resourceId: string | null;
  projectIds: string[];
  taskIds: string[];
  waivable: boolean;
  severity: ResourceConflict["severity"];
  explanation: string;
  evidence: string[];
  policy: IndexedPortfolio["input"]["policy"];
}): ResourceConflict {
  const blocksAutomaticExecution = input.waivable ? !input.policy.allowWorkWithUnknownLimits : true;
  return {
    id: input.id,
    class: input.class,
    code: input.code,
    resourceId: input.resourceId,
    projectIds: unique(input.projectIds),
    taskIds: unique(input.taskIds),
    severity: input.severity,
    blocksAutomaticExecution,
    runningAgents: "unchanged",
    explanation: input.explanation,
    evidence: input.evidence,
  };
}

function unique(values: readonly string[]): string[] {
  return [...new Set(values)];
}
