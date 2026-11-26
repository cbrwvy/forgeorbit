/**
 * FO-ROUTING04: AI Router 2.0 — Multi-Project Resource Planner
 */

import { createHash } from "node:crypto";
import {
  type EvaluatorCandidateInput,
  evaluateCandidates,
} from "./evaluator.ts";
import {
  type CandidateEvaluation,
  type MultiProjectAllocationPlan,
  type MultiProjectAllocationSlot,
  type ProjectRouterPolicyConfig,
  type RouterPolicyPreset,
  type RouterRole,
  type TaskRequirementsInput,
} from "./types.ts";
import { ALLOCATION_SEARCH_LIMIT, searchAllocation, type AllocationLimits, type AllocationObjective, type AllocationPool, type AllocationStage } from "../orchestration/allocation-search.ts";

export interface ProjectTaskPlanningItem {
  projectPath: string;
  projectPriority: "critical" | "high" | "normal" | "low";
  task: TaskRequirementsInput;
  candidates: EvaluatorCandidateInput[];
  clusterId?: string;
  paused?: boolean;
}

export function computePlanDigest(plan: Omit<MultiProjectAllocationPlan, "planDigest" | "status" | "approvedAt" | "appliedAt">): string {
  const normalized = {
    id: plan.id,
    policyPreset: plan.policyPreset,
    quotaPolicy: plan.quotaPolicy,
    autonomyMode: plan.autonomyMode,
    createdAt: plan.createdAt,
    slots: plan.slots.map((s) => ({
      projectPath: s.projectPath,
      taskId: s.taskId,
      taskTitle: s.taskTitle,
      role: s.role,
      selected: s.selectedCandidate
        ? {
            candidateId: s.selectedCandidate.candidateId,
            harnessId: s.selectedCandidate.harnessId,
            modelId: s.selectedCandidate.modelId,
            accountId: s.selectedCandidate.accountId,
            mode: s.selectedCandidate.mode,
            score: s.selectedCandidate.scores.totalScore,
          }
        : null,
      blockers: [...s.blockers].sort(),
    })),
    ...(plan.allocation ? { allocation: plan.allocation } : {}),
  };
  return createHash("sha256").update(JSON.stringify(normalized)).digest("hex");
}

export function planMultiProjectAllocation(
  items: ProjectTaskPlanningItem[],
  globalPolicy: ProjectRouterPolicyConfig,
  options: {
    planId?: string;
    maxGlobalConcurrency?: number | null;
    accountConcurrencyLimits?: Record<string, number>;
  } = {},
): MultiProjectAllocationPlan {
  const planId = options.planId ?? crypto.randomUUID();
  const maxConcurrency = options.maxGlobalConcurrency ?? null;
  const accountLimits = options.accountConcurrencyLimits ?? {};

  // Track shared occupancies during planning simulation
  const occupiedAccounts = new Map<string, number>();
  let occupiedGlobal = 0;

  // Priority ranking
  const priorityRank: Record<string, number> = {
    critical: 0,
    high: 1,
    normal: 2,
    low: 3,
  };

  // Group items by project
  const byProject = new Map<string, ProjectTaskPlanningItem[]>();
  for (const item of items) {
    const list = byProject.get(item.projectPath) ?? [];
    list.push(item);
    byProject.set(item.projectPath, list);
  }

  // Starvation avoidance:
  // Instead of allocating ALL tasks of highest-priority project first and starving lower-priority projects,
  // we do a round-robin weighted dispatch: each active project gets at least 1 task slot allocated in round 1,
  // ordered by project priority, then remaining tasks by project priority.
  const orderedProjects = [...byProject.entries()].sort((a, b) => {
    const pA = a[1][0]?.projectPriority ?? "normal";
    const pB = b[1][0]?.projectPriority ?? "normal";
    return (priorityRank[pA] ?? 2) - (priorityRank[pB] ?? 2) || a[0].localeCompare(b[0]);
  });

  const plannedSlots: MultiProjectAllocationSlot[] = [];

  // Round 1: Give each project 1 fair slot (starvation avoidance)
  const remainingItemsByProject = new Map<string, ProjectTaskPlanningItem[]>();
  for (const [projPath, projItems] of orderedProjects) {
    // Sort project's tasks by task priority
    const sortedProjTasks = [...projItems].sort((a, b) => {
      const tA = a.task.priority ?? "normal";
      const tB = b.task.priority ?? "normal";
      return (priorityRank[tA] ?? 2) - (priorityRank[tB] ?? 2) || a.task.taskId.localeCompare(b.task.taskId);
    });

    const first = sortedProjTasks.shift();
    if (first) {
      planSlot(first);
    }
    remainingItemsByProject.set(projPath, sortedProjTasks);
  }

  // Round 2: Allocate remaining tasks in strict project priority order
  for (const [projPath] of orderedProjects) {
    const remaining = remainingItemsByProject.get(projPath) ?? [];
    for (const item of remaining) {
      planSlot(item);
    }
  }

  function planSlot(item: ProjectTaskPlanningItem): void {
    const blockers: string[] = [];

    // Check global concurrency
    if (maxConcurrency !== null && occupiedGlobal >= maxConcurrency) {
      blockers.push(`global-concurrency-exhausted: Max global concurrency (${maxConcurrency}) reached.`);
    }

    // Filter or adjust candidates based on current simulation occupancy
    const simulationCandidates: EvaluatorCandidateInput[] = item.candidates.map((c) => {
      const acctId = c.accountId;
      const occupiedSoFar = acctId ? occupiedAccounts.get(acctId) ?? 0 : 0;
      const limit = acctId && accountLimits[acctId] !== undefined ? accountLimits[acctId] : c.concurrency.limit;
      return {
        ...c,
        concurrency: {
          occupied: c.concurrency.occupied + occupiedSoFar,
          limit,
        },
      };
    });

    const evaluated = evaluateCandidates(simulationCandidates, item.task, globalPolicy);
    let selected = evaluated.selected;

    if (blockers.length > 0) {
      selected = null;
    } else if (selected && selected.accountId) {
      // Reserve in simulation
      occupiedAccounts.set(selected.accountId, (occupiedAccounts.get(selected.accountId) ?? 0) + 1);
      occupiedGlobal += 1;
    } else if (selected) {
      occupiedGlobal += 1;
    }

    plannedSlots.push({
      projectPath: item.projectPath,
      taskId: item.task.taskId,
      taskTitle: item.task.title ?? item.task.taskId,
      role: item.task.role ?? "developer",
      selectedCandidate: selected,
      alternatives: evaluated.eligible.filter((e) => e.candidateId !== selected?.candidateId),
      blockers: selected ? [] : blockers.length ? blockers : ["No eligible candidate meets all constraints."],
    });
  }

  const basePlan = {
    id: planId,
    policyPreset: globalPolicy.preset,
    quotaPolicy: globalPolicy.quotaPolicy,
    autonomyMode: globalPolicy.autonomyMode,
    slots: plannedSlots,
    createdAt: Date.now(),
    approvedAt: null,
    appliedAt: null,
  };

  const planDigest = computePlanDigest(basePlan);

  return {
    ...basePlan,
    planDigest,
    status: "proposed",
  };
}

export function verifyPlanFreshness(
  plan: MultiProjectAllocationPlan,
  currentFingerprints: Map<string, string>, // taskId -> currentFingerprint
): { valid: boolean; reason?: string } {
  if (plan.status === "invalidated") return { valid: false, reason: "Plan was explicitly invalidated." };
  if (plan.status === "stale") return { valid: false, reason: plan.staleReason ?? "Plan is stale." };

  for (const slot of plan.slots) {
    const currentFp = currentFingerprints.get(slot.taskId);
    if (!currentFp) {
      return { valid: false, reason: `Task ${slot.taskId} (${slot.taskTitle}) was removed or no longer found.` };
    }
    // Check if task fingerprint changed
    if (slot.selectedCandidate && (slot.selectedCandidate as unknown as { taskFingerprint?: string }).taskFingerprint) {
      const expected = (slot.selectedCandidate as unknown as { taskFingerprint?: string }).taskFingerprint;
      if (expected !== currentFp) {
        return { valid: false, reason: `Task ${slot.taskTitle} modified since plan capture.` };
      }
    }
  }

  return { valid: true };
}

export function capacityObjective(preset: RouterPolicyPreset): AllocationObjective {
  if (preset === "fastest") return "fastest";
  if (preset === "lowest-cost") return "lowest-charge";
  if (preset === "quota-saver") return "quota-preserving";
  return "balanced";
}

/**
 * Bounded portfolio assignment. Later tasks in a project wait for that project's first task,
 * so a larger project does not take every slot before a smaller project is considered.
 * More than 12 stages, or a search that hits its limit, is reported as unproven.
 */
export function planCapacityAwareAllocation(
  items: ProjectTaskPlanningItem[],
  globalPolicy: ProjectRouterPolicyConfig,
  options: {
    planId?: string;
    maxGlobalConcurrency?: number | null;
    perProjectMax?: number | null;
    perClusterMax?: number | null;
    perRoleMax?: number | null;
    accountConcurrencyLimits?: Record<string, number>;
    blockedProviders?: string[];
    occupied?: AllocationLimits["occupied"];
    unmeasured?: string[];
    limit?: number;
  } = {},
): MultiProjectAllocationPlan {
  const objective = capacityObjective(globalPolicy.preset);
  const unproven = (reason: string, explored = 0): MultiProjectAllocationPlan["allocation"] => ({
    objective, optimal: false, explored, limit: options.limit ?? ALLOCATION_SEARCH_LIMIT, feasible: false, reason,
  });
  if (items.length > 12) {
    const fair = planMultiProjectAllocation(items, globalPolicy, options);
    const allocation = unproven("Too many stages for a bounded allocation search. The fair round-robin plan is a candidate and global optimality is unproven.");
    const next = { ...fair, allocation, authorizesExecution: false as const };
    return { ...next, planDigest: computePlanDigest(next) };
  }

  const priorityRank: Record<string, number> = { critical: 0, high: 1, normal: 2, low: 3 };
  const byProject = new Map<string, ProjectTaskPlanningItem[]>();
  for (const item of items) {
    const list = byProject.get(item.projectPath) ?? [];
    list.push(item);
    byProject.set(item.projectPath, list);
  }
  const ordered = [...byProject.entries()].sort((a, b) => {
    const rank = (row: ProjectTaskPlanningItem[]) => priorityRank[row[0]?.projectPriority ?? "normal"] ?? 2;
    return rank(a[1]) - rank(b[1]) || a[0].localeCompare(b[0]);
  });
  const orderedItems: ProjectTaskPlanningItem[] = [];
  const firstOfProject = new Map<string, string>();
  for (const [projectPath, rows] of ordered) {
    const sorted = [...rows].sort((a, b) => (priorityRank[a.task.priority ?? "normal"] ?? 2) - (priorityRank[b.task.priority ?? "normal"] ?? 2) || a.task.taskId.localeCompare(b.task.taskId));
    const first = sorted[0];
    if (first) firstOfProject.set(projectPath, first.task.taskId);
    orderedItems.push(...sorted);
  }

  const eligibleByTask = new Map<string, CandidateEvaluation[]>();
  const stages: AllocationStage[] = [];
  const poolRemaining = new Map<string, number | null>();

  for (const item of orderedItems) {
    const evaluation = evaluateCandidates(item.candidates, item.task, globalPolicy);
    eligibleByTask.set(item.task.taskId, evaluation.eligible);
    const pinned = Boolean(item.task.requestedAccountId || item.task.requestedModelId || item.task.requestedHarnessId || item.task.requestedMode);
    const bandSource = pinned ? evaluation.eligible.filter(row =>
      (!item.task.requestedAccountId || row.accountId === item.task.requestedAccountId) &&
      (!item.task.requestedModelId || row.modelId === item.task.requestedModelId) &&
      (!item.task.requestedHarnessId || row.harnessId === item.task.requestedHarnessId) &&
      (!item.task.requestedMode || row.mode === item.task.requestedMode)) : evaluation.eligible;
    const quality = globalPolicy.preset === "best-quality";
    const best = bandSource.reduce((max, row) => Math.max(max, quality ? row.scores.quality.score : row.scores.totalScore), 0);
    const band = !pinned && (quality || globalPolicy.preset === "custom")
      ? bandSource.filter(row => (quality ? row.scores.quality.score : row.scores.totalScore) >= best - 10)
      : bandSource;
    const optionsForStage = (band.length ? band : bandSource).flatMap(row => {
      const input = item.candidates.find(candidate => candidate.id === row.candidateId);
      if (!input) return [];
      if (input.poolId) {
        const verified = row.scores.quota.capacityClass === "verified-sufficient" && input.quotaState.remainingUnits != null;
        const prior = poolRemaining.get(input.poolId);
        poolRemaining.set(input.poolId, input.poolExhausted ? 0 : !verified || prior === null ? null : Math.min(prior ?? input.quotaState.remainingUnits!, input.quotaState.remainingUnits!));
      }
      const limit = input.accountId && options.accountConcurrencyLimits?.[input.accountId] != null
        ? options.accountConcurrencyLimits[input.accountId]! : input.concurrency.limit;
      return [{
        id: row.candidateId,
        accountId: input.accountId ?? `unscoped:${input.harnessId}:${input.modelId}`,
        durationMs: Math.max(1, input.measuredLatencyMs ?? 60_000),
        charge: row.scores.cost.comparable ? row.scores.cost.estimatedCostMinor ?? null : null,
        waitMs: Math.max(0, input.queueWaitMs ?? 0),
        poolId: input.poolId ?? null,
        demand: input.quotaDemand ?? null,
        concurrency: Math.max(1, limit ?? 1),
        provider: input.kind,
      }];
    });
    const firstId = firstOfProject.get(item.projectPath);
    const fairness = firstId && firstId !== item.task.taskId ? [firstId] : [];
    stages.push({
      id: item.task.taskId,
      dependsOn: [...new Set([...(item.task.dependsOn ?? []), ...fairness])],
      options: optionsForStage,
      projectId: item.projectPath,
      clusterId: item.clusterId,
      role: item.task.role,
      withheld: item.paused ? "Project is paused or draining." : null,
    });
  }

  const pools: AllocationPool[] = [...poolRemaining].map(([id, remaining]) => ({ id, remaining }));
  const caps: AllocationLimits = {
    globalMax: options.maxGlobalConcurrency,
    perProjectMax: options.perProjectMax,
    perClusterMax: options.perClusterMax,
    perRoleMax: options.perRoleMax,
    blockedProviders: options.blockedProviders,
    occupied: options.occupied,
    unmeasured: options.unmeasured,
  };
  const search = stages.length === 0
    ? { objective, feasible: false, optimal: true, explored: 0, limit: options.limit ?? ALLOCATION_SEARCH_LIMIT, score: null, assignment: {}, reason: "No tasks were supplied.", limitations: [] as string[], withheld: {} as Record<string, string> }
    : searchAllocation(stages, objective, pools, globalPolicy.quotaPolicy === "strict", options.limit ?? ALLOCATION_SEARCH_LIMIT, caps);

  const slots: MultiProjectAllocationSlot[] = orderedItems.map(item => {
    const optionId = search.assignment[item.task.taskId];
    const selected = optionId ? (eligibleByTask.get(item.task.taskId) ?? []).find(row => row.candidateId === optionId) ?? null : null;
    const blockers = selected ? [] : [search.reason ?? "No eligible resource respects the evidenced capacity and concurrency limits."];
    return {
      projectPath: item.projectPath,
      taskId: item.task.taskId,
      taskTitle: item.task.title ?? item.task.taskId,
      role: item.task.role ?? "developer",
      selectedCandidate: selected,
      alternatives: (eligibleByTask.get(item.task.taskId) ?? []).filter(row => row.candidateId !== selected?.candidateId),
      blockers,
    };
  });

  const allocation = {
    objective, optimal: search.optimal, explored: search.explored, limit: search.limit, feasible: search.feasible,
    reason: search.optimal ? null : (search.reason ?? "The best feasible allocation found so far is not proven globally optimal."),
    limitations: search.limitations,
    withheld: search.withheld,
  };
  const base = {
    id: options.planId ?? crypto.randomUUID(),
    policyPreset: globalPolicy.preset,
    quotaPolicy: globalPolicy.quotaPolicy,
    autonomyMode: globalPolicy.autonomyMode,
    slots,
    createdAt: Date.now(),
    approvedAt: null,
    appliedAt: null,
    allocation,
    authorizesExecution: false as const,
  };
  return { ...base, planDigest: computePlanDigest(base), status: "proposed" };
}
