/**
 * Task plan view (FO-ORCH04).
 *
 * A plan is a task proposal from the project manager (FO-005A) seen through
 * the structures that already exist: the board's tasks, the structured
 * dependency rows (FO-005C.1), assignments (FO-010C) and assignment proposals
 * (FO-010D). Nothing here is stored. The view is derived on every read, so it
 * survives a restart and can't disagree with the board.
 *
 * Readiness reuses `dependencyReadiness`: a dependency counts only when its
 * task is Done. A finished run waiting in Review is not Done.
 *
 * Pure and shared: the Bun core, the webview and tests.
 */

import type { ExecutorOption } from "./execution/executor-routing.ts";
import { plannedAction, type ProposalItem, type TaskProposal } from "./project-manager.ts";
import {
  dependencyReadiness,
  findCycle,
  priorityFromProposal,
  priorityRank,
  type DependencyInfo,
  type Readiness,
  type TaskPriority,
} from "./task-scheduling.ts";
import type { ColumnId } from "./types.ts";

export const PLAN_LIMITS = {
  /** Ready tasks that get executor recommendations in one plan read. */
  recommendations: 12,
} as const;

/** The five states an Owner sees. `skipped` is a node left out of the plan. */
export type PlanTaskState = "ready" | "blocked" | "in-progress" | "waiting-owner" | "completed";

export type PlanNodeStage =
  /** Not on the board yet (the proposal is pending or the item wasn't created). */
  | "proposed"
  /** A board task exists (created or linked). */
  | "created"
  /** Left out by the Owner or the manager's duplicate rule. */
  | "skipped"
  /** The create attempt failed. */
  | "failed";

export interface PlanDependency {
  kind: "item" | "task";
  /** Title as the Owner knows it. */
  title: string;
  taskId: string | null;
  itemId: string | null;
  status: "done" | "pending" | "in-review" | "missing" | "deleted" | "foreign" | "left-out" | "cycle";
  /** One sentence for the Owner. Empty when the dependency is done. */
  note: string;
}

export interface PlanAssignmentRef {
  employeeId: string;
  employeeName: string | null;
  revision: number;
}

/** What the recommender said for a task. Read-only; starts nothing. */
export interface PlanExecutorHint {
  proposed: ExecutorOption | null;
  alternatives: ExecutorOption[];
  automaticSelection: "none" | "router-verified-only";
  routingAvailable: boolean;
  /** Set when the recommender couldn't answer for this task. */
  error: string | null;
}

export interface PlanNode {
  itemId: string;
  taskId: string | null;
  title: string;
  description: string;
  /** The live priority row once the task exists, else the proposal's. */
  priority: TaskPriority;
  stage: PlanNodeStage;
  /** Position in the suggested order (1-based). */
  order: number;
  /** Tasks in the same wave don't depend on each other. */
  wave: number;
  /** null for a skipped node, or for every node of a rejected plan. */
  state: PlanTaskState | null;
  /** Why the task is blocked or waiting for the Owner. Empty when ready. */
  reasons: string[];
  dependsOn: PlanDependency[];
  /** Dependencies the manager named that matched nothing. */
  warnings: string[];
  column: ColumnId | null;
  assignment: PlanAssignmentRef | null;
  pendingAssignmentProposalId: string | null;
  executor: PlanExecutorHint | null;
}

export type PlanIssueCode = "cycle" | "rejected" | "partial" | "no-tasks";

export interface PlanIssue {
  code: PlanIssueCode;
  message: string;
  itemIds: string[];
}

export interface PlanCounts {
  ready: number;
  blocked: number;
  "in-progress": number;
  "waiting-owner": number;
  completed: number;
  skipped: number;
}

export interface PlanView {
  proposalId: string;
  projectPath: string;
  /** The goal as the manager stated it. */
  title: string;
  summary: string;
  proposalStatus: TaskProposal["status"];
  proposalRevision: number;
  nodes: PlanNode[];
  issues: PlanIssue[];
  counts: PlanCounts;
  /** Changes whenever anything the Owner reviewed changes. */
  planKey: string;
  /**
   * Digests of the evidence and Owner preferences the recommender read, set
   * only when recommendations were computed. They are part of `planKey`; here
   * they let a later review say *which* of the two changed (FO-ORCH06).
   */
  basis?: { evidence: string; preferences: string };
  /** Always true: reading a plan starts nothing and changes nothing. */
  readOnly: true;
  executionAvailable: false;
}

/** The board facts of one task, read fresh by the caller. */
export interface PlanTaskFacts {
  exists: boolean;
  inProject: boolean;
  title: string;
  column: ColumnId;
  archived: boolean;
  live: boolean;
  priority: TaskPriority;
  /** Structured dependency rows. */
  dependsOn: string[];
  /** Deleted prerequisites the Owner cleared on purpose (FO-ORCH05). */
  clearedMissing?: string[];
  assignment: PlanAssignmentRef | null;
  pendingAssignmentProposalId: string | null;
}

export interface PlanInput {
  proposal: TaskProposal;
  task: (taskId: string) => PlanTaskFacts | null;
  /** Dependency view of any task id (same shape the scheduler uses). */
  dependency: (taskId: string) => DependencyInfo;
}

const COLUMN_LABEL: Record<ColumnId, string> = {
  backlog: "Backlog",
  inbox: "Project inbox",
  ready: "Ready",
  running: "Running",
  blocked: "Blocked",
  review: "Review",
  done: "Done",
};

function emptyCounts(): PlanCounts {
  return { ready: 0, blocked: 0, "in-progress": 0, "waiting-owner": 0, completed: 0, skipped: 0 };
}

/** The board task an item stands for, if any. */
function resolvedTaskId(item: ProposalItem): string | null {
  const result = item.result;
  if (result && (result.status === "created" || result.status === "linked")) return result.taskId;
  // Not decided yet: approving would link to the existing task.
  if (!result && item.include && item.duplicate?.kind === "task" && item.duplicateAction === "use-existing") return item.duplicate.taskId;
  return null;
}

function stageOf(item: ProposalItem, taskId: string | null): PlanNodeStage {
  if (item.result?.status === "failed") return "failed";
  if (item.result?.status === "skipped") return "skipped";
  if (!item.result && plannedAction(item) === "skip") return "skipped";
  return taskId ? "created" : "proposed";
}

/** Item ids that sit on a dependency cycle among the plan's own items. */
export function planCycle(items: readonly ProposalItem[]): string[] | null {
  const ids = new Set(items.map((item) => item.id));
  const edges = items.flatMap((item) =>
    item.dependsOn.flatMap((dep) => (dep.kind === "item" && ids.has(dep.itemId) ? [{ taskId: item.id, dependsOn: dep.itemId }] : [])));
  return findCycle(edges);
}

function columnNote(column: ColumnId | null): string {
  return column ? COLUMN_LABEL[column] : "unknown";
}

/**
 * Derive the plan. Item-to-item links come from the proposal; once a task
 * exists its dependencies come from the structured rows (the contract the
 * scheduler and batches already use), so a link that never became a row is
 * reported, not assumed.
 */
export function derivePlan(input: PlanInput): Omit<PlanView, "planKey"> {
  const { proposal } = input;
  const items = proposal.items;
  const byId = new Map(items.map((item) => [item.id, item]));
  const rejected = proposal.status === "rejected";
  const issues: PlanIssue[] = [];

  const cycle = planCycle(items);
  const onCycle = new Set<string>(cycle ?? []);
  if (cycle) {
    const titles = cycle.map((id) => `“${byId.get(id)?.title ?? id}”`);
    issues.push({
      code: "cycle",
      message: `These tasks wait for each other, so none could start first: ${titles.join(" → ")}. Remove one link and propose the plan again.`,
      itemIds: [...cycle],
    });
  }
  if (rejected) issues.push({ code: "rejected", message: "This plan was rejected. Nothing from it is on the board.", itemIds: [] });
  if (proposal.status === "partial") {
    issues.push({ code: "partial", message: "Some tasks of this plan were not created. Approve again to retry them.", itemIds: [] });
  }

  // Wave = 1 + the deepest in-plan dependency. A cycle member gets wave 1.
  const waveMemo = new Map<string, number>();
  const visiting = new Set<string>();
  const waveOf = (id: string): number => {
    const known = waveMemo.get(id);
    if (known != null) return known;
    if (visiting.has(id)) return 1;
    visiting.add(id);
    const item = byId.get(id);
    let wave = 1;
    for (const dep of item?.dependsOn ?? []) {
      if (dep.kind === "item" && byId.has(dep.itemId) && byId.get(dep.itemId)!.include) wave = Math.max(wave, waveOf(dep.itemId) + 1);
    }
    visiting.delete(id);
    waveMemo.set(id, wave);
    return wave;
  };

  const nodes: PlanNode[] = items.map((item) => {
    const taskId = resolvedTaskId(item);
    const facts = taskId ? input.task(taskId) : null;
    const stage = stageOf(item, facts?.exists ? taskId : null);
    const dependsOn: PlanDependency[] = [];
    const reasons: string[] = [];
    let state: PlanTaskState | null = null;

    const itemStatus = (target: ProposalItem): { status: PlanDependency["status"]; note: string } => {
      if (onCycle.has(item.id) && onCycle.has(target.id)) return { status: "cycle", note: `“${target.title}” waits for this task in return.` };
      if (!target.include && !target.result) return { status: "left-out", note: `“${target.title}” is left out of the plan, so this task would not wait for it.` };
      if (target.result?.status === "skipped" || target.result?.status === "failed") {
        return { status: "left-out", note: `“${target.title}” was not created.` };
      }
      const targetTask = resolvedTaskId(target);
      if (!targetTask) return { status: "pending", note: `“${target.title}” is not on the board yet.` };
      const info = input.dependency(targetTask);
      if (!info.exists) return { status: "missing", note: `“${target.title}” was deleted.` };
      if (!info.inProject) return { status: "foreign", note: `“${target.title}” is no longer in this project.` };
      if (info.column === "done") return { status: "done", note: "" };
      if (info.column === "review") return { status: "in-review", note: `“${target.title}” finished a run but is in Review: you haven't accepted it.` };
      return { status: "pending", note: `“${target.title}” is in ${columnNote(info.column)}.` };
    };

    if (facts?.exists && stage === "created") {
      // The structured rows are the truth once the task exists.
      const live = facts.dependsOn;
      for (const depId of live) {
        const info = input.dependency(depId);
        // A deleted prerequisite keeps its tombstone row (migration 093), so
        // it is listed here and blocks until the Owner clears the link.
        const status: PlanDependency["status"] = !info.exists ? "deleted"
          : !info.inProject ? "foreign"
          : info.column === "done" ? "done"
          : info.column === "review" ? "in-review" : "pending";
        const note = status === "done" ? ""
          : status === "deleted" ? `“${info.title}” was deleted. This task stays blocked until you clear that link.`
          : status === "foreign" ? `“${info.title}” is no longer in this project.`
          : status === "in-review" ? `“${info.title}” finished a run but is in Review: you haven't accepted it.`
          : `“${info.title}” is in ${columnNote(info.column)}.`;
        dependsOn.push({ kind: "task", title: info.title, taskId: depId, itemId: null, status, note });
      }
      // A link the manager proposed that never became a dependency row.
      for (const dep of item.dependsOn) {
        const target = dep.kind === "item" ? byId.get(dep.itemId) : null;
        const targetTask = dep.kind === "item" ? (target ? resolvedTaskId(target) : null) : dep.taskId;
        if (targetTask && live.includes(targetTask)) continue;
        if (dep.kind === "item" && target && !target.include && !target.result) continue;
        const title = dep.kind === "item" ? (target?.title ?? dep.itemId) : dep.title;
        // Deleting a task removes its dependency rows. A prerequisite that was
        // on the board and is gone must not quietly make its dependent ready.
        const gone = targetTask != null && !input.dependency(targetTask).exists;
        if (gone && facts.clearedMissing?.includes(targetTask!)) continue;
        dependsOn.push({
          kind: dep.kind,
          title,
          taskId: targetTask,
          itemId: dep.kind === "item" ? dep.itemId : null,
          status: gone ? "deleted" : "missing",
          note: gone
            ? `“${title}” was deleted, so its link was removed. Decide whether this task still makes sense.`
            : `The link to “${title}” was proposed but is not a dependency of the task, so it is not enforced.`,
        });
      }
    } else if (stage === "proposed" || stage === "failed") {
      for (const dep of item.dependsOn) {
        if (dep.kind === "item") {
          const target = byId.get(dep.itemId);
          if (!target) continue;
          const { status, note } = itemStatus(target);
          dependsOn.push({ kind: "item", title: target.title, taskId: resolvedTaskId(target), itemId: target.id, status, note });
        } else {
          const info = input.dependency(dep.taskId);
          const status: PlanDependency["status"] = !info.exists ? "missing"
            : !info.inProject ? "foreign"
            : info.column === "done" ? "done"
            : info.column === "review" ? "in-review" : "pending";
          const note = status === "done" ? ""
            : status === "missing" ? `“${dep.title}” was deleted.`
            : status === "foreign" ? `“${dep.title}” is no longer in this project.`
            : status === "in-review" ? `“${dep.title}” finished a run but is in Review: you haven't accepted it.`
            : `“${dep.title}” is in ${columnNote(info.column)}.`;
          dependsOn.push({ kind: "task", title: dep.title, taskId: dep.taskId, itemId: null, status, note });
        }
      }
    }

    if (rejected || stage === "skipped") {
      state = null;
    } else if (stage === "created" && facts?.exists) {
      if (facts.column === "done") state = "completed";
      else if (facts.archived) {
        state = "blocked";
        reasons.push("The task is archived.");
      } else if (facts.column === "running" || facts.live) state = "in-progress";
      else if (facts.column === "review") {
        state = "waiting-owner";
        reasons.push("A run finished. Review the result and accept it: Review is not Done.");
      } else if (facts.column === "blocked") {
        state = "waiting-owner";
        reasons.push("The agent is blocked and needs your answer.");
      } else {
        const readiness = dependencyReadiness(facts.dependsOn, input.dependency);
        const unmet = dependsOn.filter((dep) => dep.status !== "done" && dep.status !== "missing" && dep.note);
        const deleted = dependsOn.filter((dep) => dep.status === "deleted");
        if (readiness.state !== "ready" || deleted.length > 0) {
          state = "blocked";
          const deletedIds = new Set(deleted.map((dep) => dep.taskId));
          const shown: Readiness = readiness.state === "blocked"
            ? { state: "blocked", by: readiness.by.filter((entry) => !deletedIds.has(entry.taskId)) }
            : readiness;
          reasons.push(...describeReadiness(shown, unmet.filter((dep) => dep.status !== "deleted")), ...deleted.map((dep) => dep.note));
        } else if (onCycle.has(item.id)) {
          state = "blocked";
          reasons.push("This task is part of a dependency cycle.");
        } else if (facts.pendingAssignmentProposalId) {
          state = "waiting-owner";
          reasons.push("An assignment proposal waits for your decision.");
        } else {
          state = "ready";
        }
      }
    } else {
      // Not on the board: judge by the plan's own links.
      const unmet = dependsOn.filter((dep) => dep.status !== "done");
      if (stage === "failed") {
        state = "blocked";
        reasons.push(item.result?.error ? `Creating the task failed: ${item.result.error}` : "Creating the task failed.");
      } else if (unmet.length > 0) {
        state = "blocked";
        reasons.push(...unmet.map((dep) => dep.note || `Waits for “${dep.title}”.`));
      } else state = "ready";
    }

    return {
      itemId: item.id,
      taskId: facts?.exists ? taskId : null,
      title: facts?.exists && stage === "created" ? facts.title : item.title,
      description: item.description,
      priority: facts?.exists && stage === "created" ? facts.priority : priorityFromProposal(item.priority),
      stage,
      order: 0,
      wave: waveOf(item.id),
      state,
      reasons,
      dependsOn,
      warnings: [...item.warnings],
      column: facts?.exists ? facts.column : null,
      assignment: facts?.exists ? facts.assignment : null,
      pendingAssignmentProposalId: facts?.exists ? facts.pendingAssignmentProposalId : null,
      executor: null,
    };
  });
  const listed = new Map(nodes.map((node, index) => [node, index]));

  const ordered = [...nodes].sort((a, b) =>
    a.wave - b.wave || priorityRank(a.priority) - priorityRank(b.priority) || listed.get(a)! - listed.get(b)!);
  ordered.forEach((node, i) => {
    node.order = i + 1;
  });

  const counts = emptyCounts();
  for (const node of ordered) counts[node.state ?? "skipped"] += 1;
  if (ordered.every((node) => node.state == null) && !rejected) {
    issues.push({ code: "no-tasks", message: "Every task of this plan is left out.", itemIds: [] });
  }

  return {
    proposalId: proposal.id,
    projectPath: proposal.projectPath,
    title: proposal.title,
    summary: proposal.summary,
    proposalStatus: proposal.status,
    proposalRevision: proposal.revision,
    nodes: ordered,
    issues,
    counts,
    readOnly: true,
    executionAvailable: false,
  };
}

function describeReadiness(readiness: Readiness, unmet: PlanDependency[]): string[] {
  if (readiness.state === "ready") return [];
  if (readiness.state === "blocked") return readiness.by.map((entry) => entry.reason);
  const notes = unmet.map((dep) => dep.note).filter(Boolean);
  return notes.length > 0 ? notes : [`Waits for ${readiness.on.length} task${readiness.on.length === 1 ? "" : "s"} to be Done.`];
}

/**
 * Which tasks the Owner may consider for a run right now: ready ones, plus
 * the ones only waiting for an assignment decision. Never starts anything.
 */
export function startableNodes(plan: Pick<PlanView, "nodes">): PlanNode[] {
  return plan.nodes.filter((node) => node.stage === "created" && node.state === "ready");
}

/** Keep the type list honest for UI code that iterates the states. */
export const PLAN_STATES: readonly PlanTaskState[] = ["ready", "in-progress", "waiting-owner", "blocked", "completed"];
