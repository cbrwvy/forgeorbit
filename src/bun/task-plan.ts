/**
 * Task plan view, server side (FO-ORCH04).
 *
 * Reads a project manager's task proposal and the board it produced, and
 * answers what is ready, blocked, running, waiting for the Owner or done,
 * with the existing executor recommender's opinion for tasks that could run.
 *
 * Read-only by construction: no table is written, no Activity Journal event
 * is recorded, no run starts, no assignment is created, no quota is probed.
 * Assignment, execution review and run approval stay with their own routes.
 */

import { createHash } from "node:crypto";
import {
  PLAN_LIMITS,
  derivePlan,
  type PlanExecutorHint,
  type PlanTaskFacts,
  type PlanView,
} from "../shared/task-plan.ts";
import { pickProposedExecutor } from "../shared/execution/executor-routing.ts";
import { sanitizeStoredProposal, type TaskProposal } from "../shared/project-manager.ts";
import { taskFingerprint } from "../shared/project-execution.ts";
import { AssignmentCore } from "./assignment-core.ts";
import { db, projectManagers, taskScheduling, tasks } from "./db.ts";
import { resolveProject } from "./environment/http.ts";
import { recommendExecutors, type RecommendationDeps } from "./executor-recommendations.ts";
import { loadExecutorPreferences } from "./executor-preferences.ts";
import { buildRoutingSnapshot } from "./model-router.ts";
import { isTaskRunLive } from "./orchestrator.ts";
import { dependencyInfo } from "./task-scheduling.ts";
import { routingEvidenceKey } from "./routing-evidence-key.ts";
import { taskInProject } from "./project-ownership.ts";

export type PlanResult<T> =
  | { ok: true; value: T }
  | { ok: false; status: number; error: string; body?: Record<string, unknown> };

function fail<T>(status: number, error: string, body?: Record<string, unknown>): PlanResult<T> {
  return { ok: false, status, error, ...(body ? { body } : {}) };
}

export interface PlanDeps {
  recommendations?: RecommendationDeps;
  /** Test seam: skip the recommender entirely. */
  skipRecommendations?: boolean;
}

export interface PlanSummary {
  proposalId: string;
  title: string;
  status: TaskProposal["status"];
  taskCount: number;
  counts: PlanView["counts"];
  cycle: boolean;
  updatedAt: number;
}

function loadProposal(projectPath: string, id: string): TaskProposal | null {
  try {
    const parsed = sanitizeStoredProposal(JSON.parse(projectManagers.getProposal(projectPath, id) ?? "null"));
    return parsed && parsed.projectPath === projectPath ? parsed : null;
  } catch {
    return null;
  }
}

const assignments = new AssignmentCore(db);

function pendingAssignmentProposalFor(taskId: string): string | null {
  return db.query<{ id: string }, [string]>(
    `SELECT id FROM assignment_proposals WHERE task_id = ? AND status = 'pending' ORDER BY created_at ASC, id ASC LIMIT 1`,
  ).get(taskId)?.id ?? null;
}

function factsOf(projectPath: string, taskId: string): PlanTaskFacts | null {
  const task = tasks.get(taskId);
  if (!task) return { exists: false, inProject: false, title: taskId.slice(0, 8), column: "backlog", archived: false, live: false, priority: "normal", dependsOn: [], assignment: null, pendingAssignmentProposalId: null };
  let assignment: PlanTaskFacts["assignment"] = null;
  try {
    const active = assignments.forTask(taskId);
    if (active) assignment = { employeeId: active.employeeId, employeeName: active.employeeName, revision: active.revision };
  } catch {
    assignment = null;
  }
  return {
    exists: true,
    inProject: taskInProject(task, projectPath, { fresh: true }),
    title: task.title,
    column: task.column,
    archived: task.archivedAt != null,
    live: isTaskRunLive(taskId),
    priority: taskScheduling.priorityOf(taskId),
    dependsOn: taskScheduling.blockingDependenciesOf(taskId),
    clearedMissing: taskScheduling.clearedMissingOf(taskId),
    assignment,
    pendingAssignmentProposalId: pendingAssignmentProposalFor(taskId),
  };
}

async function hintFor(taskId: string, deps: PlanDeps): Promise<PlanExecutorHint> {
  try {
    const response = await recommendExecutors({ taskId }, deps.recommendations ?? {});
    const { proposed, alternatives } = pickProposedExecutor(response.recommendations);
    return {
      proposed,
      alternatives,
      automaticSelection: response.recommendations.automaticSelection,
      routingAvailable: response.routingAvailable,
      error: null,
    };
  } catch (error) {
    return { proposed: null, alternatives: [], automaticSelection: "none", routingAvailable: false, error: (error as Error).message || "Recommendations are unavailable." };
  }
}

const digest = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex").slice(0, 32);

/** The evidence and preferences a recommendation was read under. */
function planBasis(): { evidence: string; preferences: unknown } {
  return { evidence: routingEvidenceKey(buildRoutingSnapshot(db)), preferences: loadExecutorPreferences() };
}

/**
 * The key an Owner review is bound to. It covers everything the view shows
 * (task state, links, priority, assignment, executor options) plus the
 * evidence and preferences the recommender read, so a change to any of them
 * makes the reviewed plan stale. Volatile timestamps are not part of it.
 */
function planKeyOf(plan: Omit<PlanView, "planKey">, evidence: ReturnType<typeof planBasis> | null): string {
  const nodes = plan.nodes.map((node) => {
    const task = node.taskId ? tasks.get(node.taskId) : null;
    const option = (o: { id: string; classification: string; availability: unknown; evidence: unknown; selectable: boolean; mode: { id: string } | null } | null) =>
      o ? { id: o.id, classification: o.classification, availability: o.availability, evidence: o.evidence, selectable: o.selectable, mode: o.mode?.id ?? null } : null;
    return {
      itemId: node.itemId,
      taskId: node.taskId,
      stage: node.stage,
      state: node.state,
      reasons: node.reasons,
      priority: node.priority,
      order: node.order,
      column: node.column,
      fingerprint: task ? taskFingerprint(task) : null,
      dependsOn: node.dependsOn.map((dep) => [dep.taskId, dep.itemId, dep.status]),
      assignment: node.assignment,
      pending: node.pendingAssignmentProposalId,
      executor: node.executor
        ? { proposed: option(node.executor.proposed), alternatives: node.executor.alternatives.map(option), routing: node.executor.routingAvailable, error: node.executor.error }
        : null,
    };
  });
  return digest({ proposal: [plan.proposalId, plan.proposalStatus, plan.proposalRevision], nodes, issues: plan.issues.map((i) => i.code), evidence });
}

function registered(rawPath: unknown): PlanResult<string> {
  const resolved = resolveProject(typeof rawPath === "string" ? rawPath : "");
  if (!resolved.ok) return fail(resolved.status, resolved.error);
  return { ok: true, value: resolved.path };
}

function derive(projectPath: string, proposal: TaskProposal) {
  const memo = new Map<string, PlanTaskFacts | null>();
  const facts = (taskId: string) => {
    if (!memo.has(taskId)) memo.set(taskId, factsOf(projectPath, taskId));
    return memo.get(taskId)!;
  };
  return derivePlan({
    proposal,
    task: facts,
    dependency: (taskId) => dependencyInfo(projectPath, taskId, { fresh: true }),
  });
}

/** Cheap list: no recommendations, so it can be polled. */
export function listPlans(rawPath: unknown): PlanResult<{ plans: PlanSummary[] }> {
  const project = registered(rawPath);
  if (!project.ok) return project;
  const plans: PlanSummary[] = [];
  for (const raw of projectManagers.listProposals(project.value)) {
    let proposal: TaskProposal | null = null;
    try {
      proposal = sanitizeStoredProposal(JSON.parse(raw));
    } catch {
      proposal = null;
    }
    if (!proposal || proposal.projectPath !== project.value) continue;
    const view = derive(project.value, proposal);
    plans.push({
      proposalId: proposal.id,
      title: proposal.title,
      status: proposal.status,
      taskCount: view.nodes.length,
      counts: view.counts,
      cycle: view.issues.some((issue) => issue.code === "cycle"),
      updatedAt: proposal.updatedAt,
    });
  }
  return { ok: true, value: { plans } };
}

/**
 * One plan with recommendations for the tasks the Owner could consider
 * running. Each recommendation is the existing deterministic recommender's
 * answer; unknown quota stays unknown, and nothing is applied.
 */
export async function getPlan(rawPath: unknown, proposalId: string, deps: PlanDeps = {}): Promise<PlanResult<PlanView>> {
  const project = registered(rawPath);
  if (!project.ok) return project;
  const proposal = loadProposal(project.value, proposalId);
  if (!proposal) return fail(404, "Plan not found for this project.");
  const plan = derive(project.value, proposal);
  let withExecutors = false;
  if (!deps.skipRecommendations) {
    const wanted = plan.nodes.filter((node) =>
      node.taskId && node.stage === "created" && (node.state === "ready" || (node.state === "waiting-owner" && node.pendingAssignmentProposalId)));
    for (const node of wanted.slice(0, PLAN_LIMITS.recommendations)) {
      node.executor = await hintFor(node.taskId!, deps);
      withExecutors = true;
    }
  }
  const basis = withExecutors ? planBasis() : null;
  return {
    ok: true,
    value: {
      ...plan,
      planKey: planKeyOf(plan, basis),
      ...(basis ? { basis: { evidence: basis.evidence, preferences: digest(basis.preferences) } } : {}),
    },
  };
}

/**
 * Re-derive the plan and compare with the key the Owner reviewed. A stale
 * key answers 409 with the fresh plan, so the Owner re-reads before going on
 * to the existing assignment and execution reviews. Writes nothing.
 */
export async function verifyPlan(
  rawPath: unknown,
  proposalId: string,
  planKey: unknown,
  deps: PlanDeps = {},
): Promise<PlanResult<{ fresh: true; plan: PlanView }>> {
  if (typeof planKey !== "string" || !planKey || planKey.length > 128) return fail(400, "planKey is required.");
  const current = await getPlan(rawPath, proposalId, deps);
  if (!current.ok) return current;
  if (current.value.planKey !== planKey) {
    return fail(409, "The plan changed since you reviewed it. Review it again before continuing. Nothing was started or assigned.", { stale: true, plan: current.value });
  }
  return { ok: true, value: { fresh: true, plan: current.value } };
}
