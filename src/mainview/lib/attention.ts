/**
 * "Needs you" aggregation (FO-UX02-D groundwork) — one pure answer to
 * "what is waiting on the Owner?" from the tasks the webview already polls.
 *
 * Deliberately NOT wired into any screen yet: where it surfaces (a rail item,
 * the Head of PM orb's Needs-Owner state, a Home block) is an Owner decision
 * in `docs/design/fo-ux02d-ia-proposal.md`. Nothing here reads the network and
 * nothing here approves anything; it only classifies rows that exist.
 *
 * Sources covered today (all task-derived): pending structured questions,
 * Review column, Blocked column, paused fx recovery, blocked pipeline runs.
 * Proposals, delegations, hiring/assignment proposals and batch holds live in
 * other stores and are added by the surface that mounts this (PM01 / UX02-D).
 */

import { isTaskFxPaused } from "../../shared/fx-recovery.ts";
import { qcAttentionKind } from "../../shared/task-quality-control.ts";
import type { ColumnId, TaskFxRecovery, TaskQcState } from "../../shared/types.ts";

export type AttentionKind = "answer" | "review" | "qc-owner" | "blocked" | "fx-paused" | "pipeline-blocked";

/** The slice of a task this module reads — satisfied by `Task`. */
export interface AttentionTask {
  id: string;
  title: string;
  column: ColumnId;
  updatedAt: number;
  archivedAt: number | null;
  /** Hidden pipeline step rows are never listed; their parent is. */
  pipelineParentId?: string | null;
  pendingInteractionCount?: number;
  fxRecovery?: TaskFxRecovery | null;
  pipelineRun?: { status: string; blocked?: readonly unknown[] } | null;
  /** Registered project the task belongs to (`ownerProjectPath`, else its workdir). */
  ownerProjectPath?: string | null;
  workdir: string;
  qcState?: TaskQcState | null;
}

export interface AttentionItem {
  taskId: string;
  title: string;
  projectPath: string;
  kind: AttentionKind;
  /** Pending question count for `answer`, else 0. */
  count: number;
  updatedAt: number;
}

/** Display order: a question blocks an agent right now, a failure needs a
 *  decision, a review is a result waiting. */
const KIND_RANK: Record<AttentionKind, number> = { answer: 0, "pipeline-blocked": 1, blocked: 2, "fx-paused": 3, "qc-owner": 4, review: 5 };

function kindOf(task: AttentionTask): AttentionKind | null {
  if ((task.pendingInteractionCount ?? 0) > 0) return "answer";
  if (task.pipelineRun && task.pipelineRun.status === "blocked") return "pipeline-blocked";
  if (isTaskFxPaused({ fxRecovery: task.fxRecovery, column: task.column })) return "fx-paused";
  if (task.column === "blocked") return "blocked";
  if (task.column === "review") {
    if (task.qcState?.activeReviewId) return null;
    const qcOwner = qcAttentionKind(task.qcState ?? null, task.column);
    if (qcOwner === "qc-owner") return "qc-owner";
    return "review";
  }
  return null;
}

/**
 * Items waiting on the Owner, most urgent first (ties: newest first).
 * `projectPath` limits the result to one project (Project context); omitted,
 * it covers every project (Global context).
 */
export function collectAttention(tasks: readonly AttentionTask[], opts: { projectPath?: string | null } = {}): AttentionItem[] {
  const out: AttentionItem[] = [];
  for (const task of tasks) {
    if (task.archivedAt != null || task.pipelineParentId) continue;
    const projectPath = task.ownerProjectPath ?? task.workdir;
    if (opts.projectPath && projectPath !== opts.projectPath) continue;
    const kind = kindOf(task);
    if (!kind) continue;
    out.push({ taskId: task.id, title: task.title, projectPath, kind, count: kind === "answer" ? task.pendingInteractionCount ?? 0 : 0, updatedAt: task.updatedAt });
  }
  return out.sort((a, b) => KIND_RANK[a.kind] - KIND_RANK[b.kind] || b.updatedAt - a.updatedAt);
}

export interface AttentionSummary {
  total: number;
  byKind: Record<AttentionKind, number>;
  /** The most urgent kind, or null when nothing is waiting. */
  top: AttentionKind | null;
}

export function summarizeAttention(items: readonly AttentionItem[]): AttentionSummary {
  const byKind: Record<AttentionKind, number> = { answer: 0, "pipeline-blocked": 0, blocked: 0, "fx-paused": 0, "qc-owner": 0, review: 0 };
  for (const item of items) byKind[item.kind]++;
  const top = (Object.keys(KIND_RANK) as AttentionKind[]).sort((a, b) => KIND_RANK[a] - KIND_RANK[b]).find((k) => byKind[k] > 0) ?? null;
  return { total: items.length, byKind, top };
}
