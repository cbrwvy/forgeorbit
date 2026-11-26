/**
 * Portfolio analysis entry. Pure: the input is not mutated, and the result
 * is a proposal. It does not read the database or talk to an agent.
 */

import type { ColumnId } from "../types.ts";
import type { MissingDatum, ProvenanceEntry } from "../estimation/types.ts";
import { aggregateEstimation } from "./estimation.ts";
import { assessHealth } from "./health.ts";
import { planPortfolio } from "./planning.ts";
import { analyzePriorities } from "./priorities.ts";
import { assessResources } from "./resources.ts";
import {
  deadlineKey,
  preparePortfolio,
  rollupColumns,
  rollupCount,
  summarizeProject,
  type IndexedPortfolio,
} from "./snapshot.ts";
import {
  PORTFOLIO_LIMITS,
  type CompletenessReport,
  type PortfolioAggregate,
  type PortfolioAnalysis,
  type PortfolioSnapshotInput,
  type PortfolioWhatIfPatch,
  type ProjectHealth,
  type ResourceConflict,
} from "./types.ts";
import { applyPortfolioWhatIf } from "./what-if.ts";

export function analyzePortfolio(input: unknown): PortfolioAnalysis {
  const prepared = preparePortfolio(input);
  if (!prepared.ok || !prepared.indexed) {
    return {
      ok: false,
      issues: prepared.issues,
      projects: [],
      aggregate: null,
      health: [],
      resources: [],
      conflicts: [],
      priorities: null,
      proposals: [],
      estimation: null,
      completeness: null,
      execution: "proposal-only",
      runningAgents: "unchanged",
    };
  }
  const indexed = prepared.indexed;
  const health = assessHealth(indexed.projects);
  const resources = assessResources(indexed);
  const priorities = analyzePriorities(indexed);
  const estimation = aggregateEstimation(indexed);
  const proposals = planPortfolio({ indexed, conflicts: resources.conflicts, priorities });
  return {
    ok: true,
    issues: prepared.issues,
    projects: indexed.projects.map(summarizeProject),
    aggregate: aggregatePortfolio(indexed, health, resources.conflicts),
    health,
    resources: resources.resources,
    conflicts: resources.conflicts,
    priorities,
    proposals,
    estimation,
    completeness: completenessOf(indexed, prepared.issues),
    execution: "proposal-only",
    runningAgents: "unchanged",
  };
}

export function analyzeWhatIf(input: PortfolioSnapshotInput, patch: PortfolioWhatIfPatch): {
  analysis: PortfolioAnalysis;
  notes: string[];
  snapshot: PortfolioSnapshotInput;
} {
  const applied = applyPortfolioWhatIf(input, patch);
  return { analysis: analyzePortfolio(applied.snapshot), notes: applied.notes, snapshot: applied.snapshot };
}

function aggregatePortfolio(
  indexed: IndexedPortfolio,
  health: readonly ProjectHealth[],
  conflicts: readonly ResourceConflict[],
): PortfolioAggregate {
  const projects = indexed.projects;
  const activeProjectIds = health.filter((item) => item.signals.includes("active")).map((item) => item.projectId);
  const idleProjectIds = health.filter((item) => item.signals.includes("idle")).map((item) => item.projectId);
  const attention = new Set<string>();
  for (const item of health) {
    if (item.signals.some((signal) => signal === "blocked" || signal === "waiting-for-owner" || signal === "degraded" || signal === "needs-attention" || signal === "unknown")) {
      attention.add(item.projectId);
    }
  }
  for (const conflict of conflicts) {
    if (conflict.class === "confirmed") {
      for (const projectId of conflict.projectIds) attention.add(projectId);
    }
  }
  return {
    projectCount: projects.length,
    currentProjectCount: projects.filter((project) => project.freshness === "current").length,
    staleProjectCount: projects.filter((project) => project.freshness === "stale").length,
    unprovenProjectCount: projects.filter((project) => project.freshness === "unproven").length,
    activeProjectIds,
    idleProjectIds,
    attentionProjectIds: [...attention],
    taskCount: rollupCount(projects, (project) => (project.project.coverage.board ? project.boardTasks.filter((task) => !task.archived).length : null), "Task count"),
    pipelineStepCount: rollupCount(projects, (project) => (project.project.coverage.board ? project.pipelineSteps.length : null), "Pipeline step count"),
    archivedCount: rollupCount(projects, (project) => (project.project.coverage.board ? project.boardTasks.filter((task) => task.archived).length + project.pipelineSteps.filter((task) => task.archived).length : null), "Archived count"),
    columns: rollupColumns(projects),
    reviewCount: rollupCount(projects, (project) => columnCount(project, "review"), "Review count"),
    blockedCount: rollupCount(projects, (project) => columnCount(project, "blocked"), "Blocked count"),
    doneCount: rollupCount(projects, (project) => columnCount(project, "done"), "Done count"),
    activeRunCount: rollupCount(projects, (project) => (project.project.coverage.runs ? project.project.runs.filter((run) => run.status === "running").length : null), "Active run count"),
    failedRunCount: rollupCount(projects, (project) => (project.project.coverage.runs ? project.project.runs.filter((run) => run.status === "failed").length : null), "Failed run count"),
    orphanedRunCount: rollupCount(projects, (project) => (project.project.coverage.runs ? project.project.runs.filter((run) => run.status === "orphaned").length : null), "Orphaned run count"),
    pausedBatchCount: rollupCount(projects, (project) => (project.project.coverage.batches ? project.project.batches.filter((batch) => batch.status === "paused").length : null), "Paused batch count"),
    runningBatchCount: rollupCount(projects, (project) => (project.project.coverage.batches ? project.project.batches.filter((batch) => batch.status === "running").length : null), "Running batch count"),
    activeBatchCount: rollupCount(projects, (project) => (project.project.coverage.batches ? project.project.batches.filter((batch) => batch.status === "approved" || batch.status === "running" || batch.status === "paused").length : null), "Active batch count"),
    runningPipelineCount: rollupCount(projects, (project) => (project.project.coverage.pipelines ? project.project.pipelines.filter((pipeline) => pipeline.status === "running").length : null), "Running pipeline count"),
    harnesses: harnessCounts(projects),
    environments: environmentCounts(projects),
    duplicateTaskIds: indexed.duplicateTaskIds,
    warnings: indexed.warnings.map((issue) => issue.message),
  };
}

function columnCount(project: IndexedPortfolio["projects"][number], column: ColumnId): number | null {
  if (!project.project.coverage.board) return null;
  return project.boardTasks.filter((task) => !task.archived && task.column === column).length;
}

function harnessCounts(projects: readonly IndexedPortfolio["projects"][number][]): PortfolioAggregate["harnesses"] {
  if (projects.length === 0) return { status: "known", activeRuns: {}, note: null };
  const activeRuns: Record<string, number> = {};
  let seen = 0;
  let skipped = 0;
  for (const project of projects) {
    if (project.freshness !== "current" || !project.project.coverage.runs) {
      skipped += 1;
      continue;
    }
    seen += 1;
    for (const run of project.project.runs) {
      if (run.status !== "running") continue;
      activeRuns[run.harnessId] = (activeRuns[run.harnessId] ?? 0) + 1;
    }
  }
  if (skipped === 0) return { status: "known", activeRuns, note: null };
  if (seen === 0) return { status: "unknown", activeRuns: {}, note: "Active harness use is unknown because no current runs were observed." };
  return { status: "incomplete", activeRuns, note: "Harness counts omit projects whose runs were not currently observed. The map is not a total." };
}

function environmentCounts(projects: readonly IndexedPortfolio["projects"][number][]): PortfolioAggregate["environments"] {
  const counts: Record<string, number> = {};
  if (projects.length === 0) return { status: "known", counts, note: null };
  let seen = 0;
  let skipped = 0;
  for (const project of projects) {
    if (project.freshness !== "current") {
      skipped += 1;
      continue;
    }
    const configured = project.project.environment.configured;
    if (configured.origin === "unknown" || configured.value == null) {
      skipped += 1;
      continue;
    }
    seen += 1;
    if (!configured.value) {
      counts["not-configured"] = (counts["not-configured"] ?? 0) + 1;
      continue;
    }
    const phase = project.project.environment.phase;
    // A phase recorded outside the staleness window is not counted as now.
    const key = phase.origin === "unknown" || phase.value == null || project.environmentFreshness !== "current" ? "phase-unknown" : phase.value;
    counts[key] = (counts[key] ?? 0) + 1;
  }
  if (skipped === 0) return { status: "known", counts, note: null };
  if (seen === 0) return { status: "unknown", counts: {}, note: "Environment state is unknown." };
  return { status: "incomplete", counts, note: "Environment counts omit projects that were not currently observed." };
}

function completenessOf(indexed: IndexedPortfolio, issues: PortfolioAnalysis["issues"]): CompletenessReport {
  const missing: MissingDatum[] = [];
  const provenance: ProvenanceEntry[] = [];
  const staleProjectIds = indexed.projects.filter((project) => project.freshness === "stale").map((project) => project.project.id);
  const unprovenProjectIds = indexed.projects.filter((project) => project.freshness === "unproven").map((project) => project.project.id);
  for (const project of indexed.projects) {
    const source = project.project;
    pushProvenance(provenance, `projects.${source.id}.name`, source.name.origin, "Project name.");
    pushProvenance(provenance, `projects.${source.id}.stack`, source.stack.origin, "Technology stack.");
    pushProvenance(provenance, `projects.${source.id}.manager`, source.managerAvailable.origin, "Project manager availability.");
    pushProvenance(provenance, `projects.${source.id}.environment`, source.environment.phase.origin, "Environment phase.");
    if (!source.coverage.board) missing.push({ code: "board", path: source.id, message: "The board was not observed." });
    if (!source.coverage.runs) missing.push({ code: "runs", path: source.id, message: "Runs were not observed." });
    if (source.stack.origin === "unknown") missing.push({ code: "stack", path: source.id, message: "Technology stack was not observed." });
    if (source.environment.phase.origin === "unknown") missing.push({ code: "environment", path: source.id, message: "Environment phase was not observed." });
    else if (project.environmentFreshness != null && project.environmentFreshness !== "current") {
      missing.push({ code: "environment-stale", path: source.id, message: "The recorded environment phase is not current. Its present state is unknown." });
    }
    if (project.freshness === "current" && !source.estimate) {
      missing.push({ code: "estimate", path: source.id, message: "No FO-006A estimate was supplied for this project." });
    }
    if (source.estimate) {
      pushProvenance(provenance, `projects.${source.id}.estimate.agent`, source.estimate.agent.origin, `Agent forecast scenario ${source.estimate.scenario}.`);
    }
    for (const task of source.tasks) {
      if (provenance.length >= PORTFOLIO_LIMITS.maxProvenance) break;
      pushProvenance(provenance, `tasks.${task.id}.priority`, task.priority.origin, "Task priority.");
    }
  }
  for (const priority of indexed.input.projectPriorities) {
    pushProvenance(provenance, `projectPriorities.${priority.projectId}`, priority.origin, "Declared project priority.");
  }
  for (const resource of indexed.resources) {
    pushProvenance(provenance, `resources.${resource.id}.quota`, resource.quotaOrigin, resource.quota.kind === "percent-used" ? "Percent-used is not capacity." : "Quota fact.");
    pushProvenance(provenance, `resources.${resource.id}.concurrency`, resource.concurrencyLimit.origin, "Concurrency limit.");
  }
  for (const deadline of indexed.input.deadlines) {
    pushProvenance(provenance, `deadlines.${deadlineKey(deadline.projectId, deadline.taskId)}`, deadline.origin, "Confirmed deadline.");
  }
  const warnings = issues.filter((issue) => issue.severity === "warning").map((issue) => issue.message);
  let status: CompletenessReport["status"] = "complete";
  if (indexed.projects.length > 0 && indexed.projects.every((project) => project.freshness !== "current" && !project.project.coverage.board)) {
    status = "unknown";
  } else if (missing.length > 0 || staleProjectIds.length > 0 || unprovenProjectIds.length > 0 || warnings.length > 0) {
    status = "partial";
  }
  return {
    status,
    missing,
    warnings,
    staleProjectIds,
    unprovenProjectIds,
    provenance: provenance.slice(0, PORTFOLIO_LIMITS.maxProvenance),
  };
}

function pushProvenance(target: ProvenanceEntry[], path: string, origin: ProvenanceEntry["origin"], detail: string): void {
  if (target.length >= PORTFOLIO_LIMITS.maxProvenance) return;
  target.push({ path, origin, detail });
}

export type * from "./types.ts";
export {
  COLUMN_IDS,
  DATA_ORIGINS,
  FO008B_INTEGRATION,
  HEALTH_SIGNALS,
  PORTFOLIO_LIMITS,
  PORTFOLIO_QUESTION_CONTRACTS,
  emptyColumns,
  priorityRank,
} from "./types.ts";
export { validatePortfolio } from "./validate.ts";
export { preparePortfolio, projectFreshness } from "./snapshot.ts";
export { applyPortfolioWhatIf } from "./what-if.ts";
