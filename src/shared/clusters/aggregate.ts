/**
 * Read-only cluster rollup (FO-011A).
 *
 * Membership chooses which registered projects are in the cluster. Counts,
 * estimates, environments, and resource warnings come from Portfolio Core
 * on that subset. This module does not read SQLite, start an agent, or
 * replace an unknown with zero.
 */

import type { ColumnId } from "../types.ts";
import { analyzePortfolio } from "../portfolio/index.ts";
import { matchTaskResource } from "../portfolio/resources.ts";
import type {
  CountFact,
  PortfolioAggregate,
  PortfolioAnalysis,
  PortfolioEstimation,
  PortfolioSnapshotInput,
  ProjectSnapshotInput,
  QuotaKnowledge,
  ResourceConflict,
  ResourceSnapshotInput,
  ResourceView,
} from "../portfolio/types.ts";
import { CLUSTER_RUN_NOTE } from "./types.ts";

export interface SharedSubscription {
  id: string;
  clusterProjectPaths: string[];
  beyondClusterProjectPaths: string[];
}

export interface ClusterQuotaFact {
  resourceId: string;
  quota: QuotaKnowledge;
  concurrencyLimit: ResourceSnapshotInput["concurrencyLimit"];
  capacity: ResourceView["capacity"] | null;
  quotaTreatment: string | null;
}

export interface ClusterProjectEnvironment {
  path: string;
  phase: string | null;
  recordedPhase: string | null;
  freshness: string | null;
}

export interface ClusterAggregate {
  memberPaths: string[];
  observedPaths: string[];
  omittedPaths: string[];
  completeness: "complete" | "partial" | "unknown";
  notes: string[];
  runNote: typeof CLUSTER_RUN_NOTE;
  counts: {
    tasks: CountFact;
    runningTasks: CountFact;
    pendingReviews: CountFact;
    blockers: CountFact;
    doneTasks: CountFact;
    activeRuns: CountFact;
    activeBatches: CountFact;
  };
  /** Projects whose current health includes the signal. A stale project stays unknown. */
  activeProjects: CountFact;
  blockedProjects: CountFact;
  environments: PortfolioAggregate["environments"] | null;
  projectEnvironments: ClusterProjectEnvironment[];
  estimation: PortfolioEstimation | null;
  /** Engine total of itemized fees inside this cluster, each subscription id once. */
  dedupedSubscriptionFees: PortfolioEstimation["subscriptions"] | null;
  /**
   * `unknown` when a subscription also appears outside the cluster: the
   * deduped figure must not be treated as this cluster's exclusive cost
   * and must not be added to another cluster's copy. `none` when no member
   * reported an existing subscription.
   */
  exclusiveSubscriptionFees: "exclusive" | "unknown" | "none";
  sharedSubscriptions: SharedSubscription[];
  resources: ResourceView[];
  conflicts: ResourceConflict[];
  quotas: ClusterQuotaFact[];
  duplicateTaskIds: string[];
}

const UNKNOWN_COUNT: CountFact = {
  status: "unknown",
  value: null,
  knownValue: null,
  note: "Cluster counts are unknown and were not treated as zero.",
};

export function aggregateCluster(snapshot: PortfolioSnapshotInput | null, memberPaths: readonly string[]): ClusterAggregate {
  const members = [...memberPaths];
  const notes: string[] = [];
  if (!snapshot) {
    return emptyAggregate(members, members, "unknown", [
      "Portfolio snapshot could not be read. Cluster counts are unknown and were not treated as zero.",
    ]);
  }

  const memberSet = new Set(members);
  const seen = new Set<string>();
  const observed: ProjectSnapshotInput[] = [];
  for (const project of snapshot.projects) {
    if (!memberSet.has(project.path)) continue;
    if (seen.has(project.path)) {
      notes.push("A project path was repeated in the portfolio snapshot. The first copy was kept so its tasks are not counted twice.");
      continue;
    }
    seen.add(project.path);
    observed.push(project);
  }
  const omitted = members.filter((path) => !seen.has(path));
  const sharedSubscriptions = collectSubscriptions(snapshot.projects, memberSet);
  const sharedBeyond = sharedSubscriptions.some((row) => row.beyondClusterProjectPaths.length > 0);
  const memberSubs = sharedSubscriptions.length;
  const resources = referencedResources(snapshot.resources, observed);
  const filtered: PortfolioSnapshotInput = {
    ...snapshot,
    projects: observed,
    resources,
    projectPriorities: snapshot.projectPriorities.filter((row) => observed.some((project) => project.id === row.projectId)),
    deadlines: snapshot.deadlines.filter((row) => observed.some((project) => project.id === row.projectId)),
  };
  const analysis = analyzePortfolio(filtered);
  if (!analysis.ok || !analysis.aggregate || !analysis.completeness) {
    return {
      ...emptyAggregate(members, omitted, "unknown", [
        ...notes,
        "Portfolio core rejected the cluster snapshot. Counts are unknown and were not treated as zero.",
      ]),
      sharedSubscriptions,
      exclusiveSubscriptionFees: exclusiveFees(memberSubs, sharedBeyond),
      quotas: rawQuotas(resources, null),
    };
  }

  if (analysis.aggregate.duplicateTaskIds.length > 0) {
    notes.push("A task id appeared more than once. Portfolio core counted it once, and the cluster total does not add it again.");
  }
  if (sharedBeyond) {
    notes.push("A subscription is also reported by a project outside this cluster. The fee was counted once inside the cluster and is not an exclusive cluster cost. Do not add it to another cluster's copy.");
  }
  if (omitted.length > 0) {
    notes.push(`${omitted.length} cluster project(s) were missing from the portfolio snapshot. Their counts are unknown and were not treated as zero.`);
  }

  const aggregate = analysis.aggregate;
  const downgradeAll = (fact: CountFact) => downgrade(fact, omitted.length);
  return {
    memberPaths: members,
    observedPaths: observed.map((project) => project.path),
    omittedPaths: omitted,
    completeness: clusterCompleteness(analysis, omitted.length),
    notes,
    runNote: CLUSTER_RUN_NOTE,
    counts: {
      tasks: downgradeAll(aggregate.taskCount),
      runningTasks: downgradeAll(columnFact(aggregate.columns, "running", "Running tasks")),
      pendingReviews: downgradeAll(aggregate.reviewCount),
      blockers: downgradeAll(aggregate.blockedCount),
      doneTasks: downgradeAll(aggregate.doneCount),
      activeRuns: downgradeAll(aggregate.activeRunCount),
      activeBatches: downgradeAll(aggregate.activeBatchCount),
    },
    activeProjects: downgradeAll(signalCount(analysis.health, "active")),
    blockedProjects: downgradeAll(signalCount(analysis.health, "blocked")),
    environments: aggregate.environments,
    projectEnvironments: analysis.projects.map((project) => ({
      path: project.path,
      phase: project.environmentPhase,
      recordedPhase: project.environmentRecordedPhase,
      freshness: project.environmentPhaseFreshness,
    })),
    estimation: analysis.estimation,
    dedupedSubscriptionFees: analysis.estimation?.subscriptions ?? null,
    exclusiveSubscriptionFees: exclusiveFees(memberSubs, sharedBeyond),
    sharedSubscriptions,
    resources: analysis.resources,
    conflicts: analysis.conflicts.filter((conflict) =>
      conflict.projectIds.length === 0 || conflict.projectIds.some((id) => observed.some((project) => project.id === id)),
    ),
    quotas: rawQuotas(resources, analysis),
    duplicateTaskIds: aggregate.duplicateTaskIds,
  };
}

function exclusiveFees(memberSubs: number, sharedBeyond: boolean): ClusterAggregate["exclusiveSubscriptionFees"] {
  if (memberSubs === 0) return "none";
  if (sharedBeyond) return "unknown";
  return "exclusive";
}

function clusterCompleteness(analysis: PortfolioAnalysis, omitted: number): ClusterAggregate["completeness"] {
  const status = analysis.completeness?.status ?? "unknown";
  if (!analysis.ok) return "unknown";
  if (omitted > 0) return status === "unknown" ? "unknown" : "partial";
  return status;
}

function downgrade(fact: CountFact, omitted: number): CountFact {
  if (omitted === 0) return fact;
  const extra = `${omitted} cluster project(s) were missing from the portfolio snapshot. Their counts are unknown and were not treated as zero.`;
  const note = fact.note ? `${fact.note} ${extra}` : extra;
  if (fact.status === "unknown") return { ...fact, note };
  return { status: "incomplete", value: null, knownValue: fact.status === "known" ? fact.value : fact.knownValue, note };
}

function signalCount(health: readonly { freshness: string; signals: readonly string[] }[], signal: "active" | "blocked"): CountFact {
  if (health.length === 0) return { status: "known", value: 0, knownValue: 0, note: null };
  let matched = 0;
  let unknown = 0;
  for (const row of health) {
    if (row.freshness !== "current") {
      unknown += 1;
      continue;
    }
    if (row.signals.includes(signal)) matched += 1;
  }
  if (unknown === health.length) {
    return {
      status: "unknown",
      value: null,
      knownValue: null,
      note: `Project ${signal} status is unknown because no member snapshot is current. It was not treated as zero.`,
    };
  }
  if (unknown > 0) {
    return {
      status: "incomplete",
      value: null,
      knownValue: matched,
      note: `${unknown} project(s) are not current. The known ${signal} count is not the total.`,
    };
  }
  return { status: "known", value: matched, knownValue: matched, note: null };
}

function columnFact(columns: PortfolioAggregate["columns"], column: ColumnId, noun: string): CountFact {
  if (columns.status === "known" && columns.counts) {
    return { status: "known", value: columns.counts[column], knownValue: columns.counts[column], note: null };
  }
  if (columns.status === "unknown") {
    return { status: "unknown", value: null, knownValue: null, note: columns.note ?? `${noun} is unknown.` };
  }
  return {
    status: "incomplete",
    value: null,
    knownValue: columns.knownCounts[column],
    note: columns.note ?? `${noun} is incomplete. The known portion is not the total.`,
  };
}

function collectSubscriptions(projects: readonly ProjectSnapshotInput[], members: ReadonlySet<string>): SharedSubscription[] {
  const rows = new Map<string, SharedSubscription>();
  for (const project of projects) {
    const ids = new Set(
      (project.estimate?.subscriptions ?? []).filter((subscription) => subscription.commitment === "existing").map((subscription) => subscription.id),
    );
    for (const id of ids) {
      const row = rows.get(id) ?? { id, clusterProjectPaths: [], beyondClusterProjectPaths: [] };
      const bucket = members.has(project.path) ? row.clusterProjectPaths : row.beyondClusterProjectPaths;
      if (!bucket.includes(project.path)) bucket.push(project.path);
      rows.set(id, row);
    }
  }
  return [...rows.values()].filter((row) => row.clusterProjectPaths.length > 0);
}

function referencedResources(resources: readonly ResourceSnapshotInput[], projects: readonly ProjectSnapshotInput[]): ResourceSnapshotInput[] {
  const ids = new Set<string>();
  const subscriptionIds = new Set<string>();
  for (const project of projects) {
    for (const task of project.tasks) {
      for (const id of matchTaskResource(task, resources).resourceIds) ids.add(id);
    }
    for (const subscription of project.estimate?.subscriptions ?? []) {
      if (subscription.commitment === "existing") subscriptionIds.add(subscription.id);
    }
  }
  return resources.filter((resource) => ids.has(resource.id) || (resource.subscriptionId != null && subscriptionIds.has(resource.subscriptionId)));
}

function rawQuotas(resources: readonly ResourceSnapshotInput[], analysis: PortfolioAnalysis | null): ClusterQuotaFact[] {
  return resources.map((resource) => {
    const view = analysis?.resources.find((row) => row.id === resource.id);
    return {
      resourceId: resource.id,
      quota: resource.quota,
      concurrencyLimit: resource.concurrencyLimit,
      capacity: view?.capacity ?? null,
      quotaTreatment: view?.quotaTreatment ?? null,
    };
  });
}

function emptyAggregate(
  memberPaths: readonly string[],
  omittedPaths: readonly string[],
  completeness: ClusterAggregate["completeness"],
  notes: string[],
): ClusterAggregate {
  return {
    memberPaths: [...memberPaths],
    observedPaths: [],
    omittedPaths: [...omittedPaths],
    completeness,
    notes,
    runNote: CLUSTER_RUN_NOTE,
    counts: {
      tasks: UNKNOWN_COUNT,
      runningTasks: UNKNOWN_COUNT,
      pendingReviews: UNKNOWN_COUNT,
      blockers: UNKNOWN_COUNT,
      doneTasks: UNKNOWN_COUNT,
      activeRuns: UNKNOWN_COUNT,
      activeBatches: UNKNOWN_COUNT,
    },
    activeProjects: UNKNOWN_COUNT,
    blockedProjects: UNKNOWN_COUNT,
    environments: null,
    projectEnvironments: [],
    estimation: null,
    dedupedSubscriptionFees: null,
    exclusiveSubscriptionFees: "none",
    sharedSubscriptions: [],
    resources: [],
    conflicts: [],
    quotas: [],
    duplicateTaskIds: [],
  };
}
