/**
 * Controlled execution queue of a task plan (FO-ORCH05).
 *
 * The Owner picks ready tasks of a plan and puts them in order. That choice
 * (the order, paused or stopped, the plan key last reviewed) is all that is
 * stored. Which entry is ready, blocked, running or done, who is recommended
 * and which entry comes next are derived from the plan on every read, so the
 * queue can't disagree with the board.
 *
 * A queue is not a permission. It never starts, assigns or retries anything;
 * "next" only names the task whose existing Employee Review the Owner may
 * open. Pure and shared: the Bun core, the webview and tests.
 *
 * FO-ORCH06 adds a read-only *progression* on top: which phase the queue is in,
 * which task the Owner could review next (and why others can't be), and what
 * changed since the Owner last confirmed the plan. Progression never confirms
 * a plan, assigns, starts or retries: a changed plan key always needs the
 * Owner's explicit confirmation, however expected the change looks.
 */

import type { PlanNode, PlanTaskState, PlanView } from "./task-plan.ts";
import type { BatchEntryState, BatchStatus } from "./task-scheduling.ts";
import type { ColumnId } from "./types.ts";

export const QUEUE_LIMITS = {
  /** Tasks in one queue. */
  entries: 50,
} as const;

export type QueueStatus = "active" | "paused" | "stopped";

export type QueueEntryState = "ready" | "blocked" | "waiting-owner" | "in-progress" | "completed" | "removed";

export const QUEUE_ENTRY_STATES: readonly QueueEntryState[] = ["ready", "in-progress", "waiting-owner", "blocked", "completed", "removed"];

export interface StoredQueue {
  id: string;
  projectPath: string;
  proposalId: string;
  taskIds: string[];
  status: QueueStatus;
  revision: number;
  reviewedPlanKey: string;
  /** The plan as the Owner last confirmed it, for "what changed". Null before FO-ORCH06. */
  reviewedSnapshot: PlanSnapshot | null;
  /** Owner opt-in to keep the next task's review prepared (read-only). Default off. */
  autoPrepare: boolean;
  createdAt: number;
  updatedAt: number;
}

export interface QueueEntryView {
  position: number;
  taskId: string;
  title: string;
  state: QueueEntryState;
  reasons: string[];
  /** Ready by the plan but without a worker: Employee Review needs one. */
  needsAssignment: boolean;
  /** The plan's node, with its recommended executor. Null when removed. */
  node: PlanNode | null;
  /** Active Execution Batches that own this task. A batch, not the queue, runs it. */
  batchIds: string[];
}

export interface QueueNext {
  taskId: string;
  title: string;
  position: number;
}

export interface QueueView {
  id: string;
  proposalId: string;
  projectPath: string;
  status: QueueStatus;
  revision: number;
  entries: QueueEntryView[];
  /** The one task whose Employee Review may be opened now, or null. */
  next: QueueNext | null;
  /** Why there is no next task. Null when there is one, or when finished. */
  nextBlockedReason: string | null;
  /** The plan changed since the Owner last reviewed this queue. */
  needsReview: boolean;
  /** The plan key this view was derived under; send it back to continue. */
  planKey: string;
  /** Always true: a queue starts, assigns and retries nothing. */
  readOnly: true;
  counts: Record<QueueEntryState, number>;
  autoPrepare: boolean;
  progression: QueueProgression;
  /** Execution Batches prepared from this queue, newest first (FO-ORCH07). */
  batches: QueueBatchView[];
  /** What the Owner may hand to a new Execution Batch right now. */
  handoff: QueueHandoff;
}

/* ──────────────────── queue → Execution Batch handoff (FO-ORCH07) ──────────────────── */

/**
 * A summary of one batch prepared from a queue. The batch is the only thing
 * that runs tasks; this is what the queue shows about it, read from the batch
 * on every request.
 */
export interface QueueBatchView {
  id: string;
  title: string;
  status: BatchStatus;
  /** The Owner's queue order at handoff. */
  taskIds: string[];
  entryStates: Record<string, BatchEntryState>;
  approvedAt: number | null;
  /** The approval stops allowing new starts at this time. */
  expiresAt: number | null;
  expired: boolean;
  maxParallel: number;
  maxStarts: number;
  launchesUsed: number;
  maxRetriesPerTask: number;
  spending: string;
  /** Tasks whose full-access run the Owner acknowledged. */
  fullAccessTaskIds: string[];
  orderGuaranteed: boolean;
  orderNote: string;
  /** The queue's plan or order moved on since this batch was prepared. */
  stale: boolean;
  reason: string | null;
}

export interface QueueHandoffEntry {
  taskId: string;
  title: string;
  position: number;
}

export interface QueueHandoff {
  /** True when at least one task can be handed over and the queue allows it. */
  canPrepare: boolean;
  /** Why not, when it can't. */
  reason: string | null;
  eligible: QueueHandoffEntry[];
  excluded: (QueueHandoffEntry & { reasons: string[] })[];
  /** A draft, approved, running or paused batch of this queue already exists. */
  openBatchId: string | null;
}

export function isOpenQueueBatch(status: BatchStatus): boolean {
  return status === "draft" || status === "approved" || status === "running" || status === "paused";
}

/* ───────────────────────── progression (FO-ORCH06) ───────────────────────── */

export type QueuePhase =
  | "ready-to-review"
  | "waiting-dependency"
  | "waiting-assignment"
  | "waiting-owner"
  | "in-progress"
  | "completed"
  | "paused"
  | "stopped"
  | "stale";

export const QUEUE_PHASES: readonly QueuePhase[] = [
  "ready-to-review", "waiting-dependency", "waiting-assignment", "waiting-owner", "in-progress", "completed", "paused", "stopped", "stale",
];

/** What the Owner would see when opening the existing Employee Review. */
export interface QueueCandidate {
  taskId: string;
  title: string;
  /** Position in the Owner's queue, or null for a ready plan task outside it. */
  position: number | null;
  inQueue: boolean;
  assignee: { employeeId: string; employeeName: string | null } | null;
  executor: {
    harnessLabel: string;
    modelLabel: string;
    /** "unknown" stays "unknown": nothing here upgrades it to available. */
    availability: string;
    classification: string;
    modeId: string | null;
    modeLabel: string | null;
    /** Full access needs its own acknowledgement at the existing launch confirmation. */
    fullAccess: boolean;
  } | null;
}

export type ChangeKind = "state" | "assignment" | "executor" | "quota" | "permission" | "preferences" | "dependencies" | "task" | "priority" | "plan";

export interface PlanChange {
  kind: ChangeKind;
  taskId: string | null;
  title: string;
  from: string | null;
  to: string | null;
  message: string;
  /**
   * False only for the expected progression of work (a task started, finished
   * or became ready). Everything else changes who runs what, with which
   * permissions or under which evidence.
   */
  material: boolean;
}

export interface QueueProgression {
  phase: QueuePhase;
  /** One sentence for the Owner. */
  reason: string | null;
  /** The entry that is running right now. */
  current: QueueNext | null;
  /** The task the Owner could review next, or null. Naming it opens nothing. */
  candidate: QueueCandidate | null;
  /** True only when the queue is active, current and the candidate is in it. */
  canOpenReview: boolean;
  /** The candidate is not in the queue: confirming the updated plan adds it. */
  needsPlanConfirmation: boolean;
  /** Changes since the Owner last confirmed the plan. Empty when nothing changed. */
  changes: PlanChange[];
  materialChange: boolean;
  /** The earlier review wasn't stored, so the changes can't be listed. */
  changesUnavailable: boolean;
  becameReady: { taskId: string; title: string }[];
  stillBlocked: { taskId: string; title: string; reasons: string[] }[];
}

export interface PlanSnapshotNode {
  taskId: string;
  title: string;
  state: PlanTaskState | null;
  column: ColumnId | null;
  assigneeId: string | null;
  assigneeRevision: number | null;
  executorId: string | null;
  availability: string | null;
  modeId: string | null;
  /** Sorted ids of what the task depends on (not their status). */
  deps: string[];
  /** Digest of the task's prompt and agent settings, without column/run. */
  config: string | null;
  priority: string;
}

/** Compact copy of a plan as the Owner confirmed it. Never authorizes anything. */
export interface PlanSnapshot {
  planKey: string;
  proposalRevision: number;
  proposalStatus: string;
  evidence: string;
  preferences: string;
  nodes: PlanSnapshotNode[];
}

export function snapshotOfPlan(plan: PlanView, configOf: (taskId: string) => string | null): PlanSnapshot {
  return {
    planKey: plan.planKey,
    proposalRevision: plan.proposalRevision,
    proposalStatus: plan.proposalStatus,
    evidence: plan.basis?.evidence ?? "",
    preferences: plan.basis?.preferences ?? "",
    nodes: plan.nodes.filter((node) => node.taskId && node.stage === "created").map((node) => ({
      taskId: node.taskId!,
      title: node.title,
      state: node.state,
      column: node.column,
      assigneeId: node.assignment?.employeeId ?? null,
      assigneeRevision: node.assignment?.revision ?? null,
      executorId: node.executor?.proposed?.id ?? null,
      availability: node.executor?.proposed?.availability ?? null,
      modeId: node.executor?.proposed?.mode?.id ?? null,
      deps: node.dependsOn.map((dep) => `${dep.kind}:${dep.taskId ?? dep.itemId ?? dep.title}`).sort(),
      config: configOf(node.taskId!),
      priority: node.priority,
    })),
  };
}

/** Defensive reader for the stored JSON; anything malformed reads as "not stored". */
export function sanitizeSnapshot(raw: unknown): PlanSnapshot | null {
  if (!raw || typeof raw !== "object") return null;
  const value = raw as Record<string, unknown>;
  if (typeof value.planKey !== "string" || !Array.isArray(value.nodes)) return null;
  const str = (v: unknown) => (typeof v === "string" ? v : null);
  const nodes: PlanSnapshotNode[] = [];
  for (const entry of value.nodes.slice(0, QUEUE_LIMITS.entries * 4)) {
    if (!entry || typeof entry !== "object") continue;
    const n = entry as Record<string, unknown>;
    if (typeof n.taskId !== "string") continue;
    nodes.push({
      taskId: n.taskId,
      title: typeof n.title === "string" ? n.title.slice(0, 300) : n.taskId.slice(0, 8),
      state: (str(n.state) as PlanTaskState | null),
      column: (str(n.column) as ColumnId | null),
      assigneeId: str(n.assigneeId),
      assigneeRevision: typeof n.assigneeRevision === "number" ? n.assigneeRevision : null,
      executorId: str(n.executorId),
      availability: str(n.availability),
      modeId: str(n.modeId),
      deps: Array.isArray(n.deps) ? n.deps.filter((d): d is string => typeof d === "string").slice(0, 100) : [],
      config: str(n.config),
      priority: typeof n.priority === "string" ? n.priority : "normal",
    });
  }
  return {
    planKey: value.planKey,
    proposalRevision: typeof value.proposalRevision === "number" ? value.proposalRevision : 0,
    proposalStatus: typeof value.proposalStatus === "string" ? value.proposalStatus : "",
    evidence: typeof value.evidence === "string" ? value.evidence : "",
    preferences: typeof value.preferences === "string" ? value.preferences : "",
    nodes,
  };
}

const q = (title: string) => `“${title}”`;

/**
 * What changed between the plan the Owner confirmed and the plan now. Only a
 * task's own progress (state/column) is non-material; assignments, executors,
 * availability, permission modes, preferences, evidence, dependency links,
 * the task's own settings and the plan itself are material. Both kinds still
 * need the Owner's confirmation: this report explains, it doesn't approve.
 */
export function diffSnapshots(reviewed: PlanSnapshot, current: PlanSnapshot): PlanChange[] {
  const changes: PlanChange[] = [];
  const add = (change: PlanChange) => changes.push(change);
  if (reviewed.proposalRevision !== current.proposalRevision || reviewed.proposalStatus !== current.proposalStatus) {
    add({ kind: "plan", taskId: null, title: "", from: reviewed.proposalStatus, to: current.proposalStatus, material: true, message: "The plan itself was changed." });
  }
  if (reviewed.evidence && current.evidence && reviewed.evidence !== current.evidence) {
    add({ kind: "quota", taskId: null, title: "", from: null, to: null, material: true, message: "Provider or quota evidence changed since you reviewed the plan." });
  }
  if (reviewed.preferences && current.preferences && reviewed.preferences !== current.preferences) {
    add({ kind: "preferences", taskId: null, title: "", from: null, to: null, material: true, message: "Your executor preferences changed since you reviewed the plan." });
  }
  const before = new Map(reviewed.nodes.map((node) => [node.taskId, node]));
  const now = new Map(current.nodes.map((node) => [node.taskId, node]));
  for (const node of current.nodes) {
    const old = before.get(node.taskId);
    if (!old) {
      add({ kind: "plan", taskId: node.taskId, title: node.title, from: null, to: node.state, material: true, message: `${q(node.title)} joined the plan.` });
      continue;
    }
    const t = node.title;
    if (old.state !== node.state || old.column !== node.column) {
      add({ kind: "state", taskId: node.taskId, title: t, from: old.state ?? old.column, to: node.state ?? node.column, material: false,
        message: old.state !== node.state ? `${q(t)}: ${old.state ?? "—"} → ${node.state ?? "—"}.` : `${q(t)} moved to ${node.column ?? "—"}.` });
    }
    if (old.assigneeId !== node.assigneeId || old.assigneeRevision !== node.assigneeRevision) {
      add({ kind: "assignment", taskId: node.taskId, title: t, from: old.assigneeId, to: node.assigneeId, material: true, message: `${q(t)}: the assigned worker changed.` });
    }
    // The recommender only answers for tasks that could run, so a task that
    // finished, started or became ready loses or gains its executor with its
    // progress. That is reported as the state change above; executors, availability
    // and modes are compared only where the Owner reviewed one and one is still shown.
    const comparable = old.state === "ready" && node.state === "ready";
    if (comparable && old.executorId !== node.executorId) {
      add({ kind: "executor", taskId: node.taskId, title: t, from: old.executorId, to: node.executorId, material: true, message: `${q(t)}: the recommended executor or model changed.` });
    }
    if (comparable && old.availability !== node.availability) {
      add({ kind: "quota", taskId: node.taskId, title: t, from: old.availability, to: node.availability, material: true, message: `${q(t)}: executor availability changed (${old.availability ?? "—"} → ${node.availability ?? "—"}).` });
    }
    if (comparable && old.modeId !== node.modeId) {
      add({ kind: "permission", taskId: node.taskId, title: t, from: old.modeId, to: node.modeId, material: true, message: `${q(t)}: the permission mode changed (${old.modeId ?? "—"} → ${node.modeId ?? "—"}).` });
    }
    if (old.deps.join("|") !== node.deps.join("|")) {
      add({ kind: "dependencies", taskId: node.taskId, title: t, from: null, to: null, material: true, message: `${q(t)}: its dependency links changed.` });
    }
    if (old.config !== node.config) {
      add({ kind: "task", taskId: node.taskId, title: t, from: null, to: null, material: true, message: `${q(t)}: the task's prompt or settings changed.` });
    }
    if (old.priority !== node.priority) {
      add({ kind: "priority", taskId: node.taskId, title: t, from: old.priority, to: node.priority, material: true, message: `${q(t)}: its priority changed.` });
    }
  }
  for (const old of reviewed.nodes) {
    if (!now.has(old.taskId)) add({ kind: "plan", taskId: old.taskId, title: old.title, from: old.state, to: null, material: true, message: `${q(old.title)} left the plan.` });
  }
  return changes;
}

function stateOf(node: PlanNode): { state: QueueEntryState; reasons: string[]; needsAssignment: boolean } {
  if (node.stage !== "created" || node.state == null) {
    return { state: "blocked", reasons: ["This task is not on the board."], needsAssignment: false };
  }
  if (node.state === "ready") {
    if (!node.assignment) {
      return { state: "waiting-owner", reasons: ["Assign a worker first: Employee Review needs one."], needsAssignment: true };
    }
    return { state: "ready", reasons: [], needsAssignment: false };
  }
  return { state: node.state, reasons: [...node.reasons], needsAssignment: false };
}

/** What the core knows that the pure plan doesn't. All optional. */
export interface QueueContext {
  /** Active Execution Batches that include a task. */
  batchOwners?: (taskId: string) => string[];
  /** The plan as it is now, for "what changed since the Owner confirmed it". */
  snapshot?: PlanSnapshot;
  /** Batches prepared from this queue. */
  batches?: QueueBatchView[];
}

function candidateOf(node: PlanNode, position: number | null): QueueCandidate {
  const option = node.executor?.proposed ?? null;
  return {
    taskId: node.taskId!,
    title: node.title,
    position,
    inQueue: position != null,
    assignee: node.assignment ? { employeeId: node.assignment.employeeId, employeeName: node.assignment.employeeName } : null,
    executor: option
      ? {
          harnessLabel: option.harnessLabel,
          modelLabel: option.modelLabel,
          availability: option.availability,
          classification: option.classification,
          modeId: option.mode?.id ?? null,
          modeLabel: option.mode?.label ?? null,
          fullAccess: option.permission?.escalated === true,
        }
      : null,
  };
}

export function deriveQueue(stored: StoredQueue, plan: PlanView, ctx: QueueContext = {}): QueueView {
  const byTask = new Map(plan.nodes.filter((node) => node.taskId).map((node) => [node.taskId!, node]));
  const entries: QueueEntryView[] = stored.taskIds.map((taskId, index) => {
    const node = byTask.get(taskId) ?? null;
    if (!node) {
      return { position: index + 1, taskId, title: taskId.slice(0, 8), state: "removed", reasons: ["This task is no longer part of the plan."], needsAssignment: false, node: null, batchIds: [] };
    }
    const derived = stateOf(node);
    const batchIds = ctx.batchOwners?.(taskId) ?? [];
    const reasons = derived.state === "ready" && batchIds.length > 0
      ? ["An Execution Batch owns this task. Run it there; the queue won't start a second run."]
      : derived.reasons;
    return { position: index + 1, taskId, title: node.title, state: derived.state, reasons, needsAssignment: derived.needsAssignment, node, batchIds };
  });

  const counts = Object.fromEntries(QUEUE_ENTRY_STATES.map((state) => [state, 0])) as Record<QueueEntryState, number>;
  for (const entry of entries) counts[entry.state] += 1;

  const needsReview = stored.reviewedPlanKey !== plan.planKey;
  let next: QueueNext | null = null;
  let nextBlockedReason: string | null = null;
  const open = entries.filter((entry) => entry.state !== "completed" && entry.state !== "removed");
  if (stored.status === "stopped") nextBlockedReason = "This queue was stopped. Nothing advances from it.";
  else if (stored.status === "paused") nextBlockedReason = "This queue is paused. Resume it to continue.";
  else if (open.length === 0) nextBlockedReason = null;
  else if (entries.some((entry) => entry.state === "in-progress")) nextBlockedReason = "A task of this queue is running. The next one waits until it finishes.";
  else {
    const first = entries.find((entry) => entry.state === "ready" && entry.batchIds.length === 0);
    if (first) next = { taskId: first.taskId, title: first.title, position: first.position };
    else if (entries.some((entry) => entry.state === "ready" && entry.batchIds.length > 0)) {
      nextBlockedReason = "The ready task of this queue belongs to an Execution Batch, which owns its run.";
    } else nextBlockedReason = "No task of this queue is ready: each one is blocked or waits for you.";
  }

  const progression = progressionOf(stored, plan, entries, next, needsReview, ctx);
  const batches = ctx.batches ?? [];
  const handoff = handoffOf(stored, entries, needsReview, batches);

  return {
    id: stored.id,
    proposalId: stored.proposalId,
    projectPath: stored.projectPath,
    status: stored.status,
    revision: stored.revision,
    entries,
    next,
    nextBlockedReason,
    needsReview,
    planKey: plan.planKey,
    readOnly: true,
    counts,
    autoPrepare: stored.autoPrepare,
    progression,
    batches,
    handoff,
  };
}

/**
 * Which queue entries could go into a new batch now. The same facts the queue
 * already shows, applied to the handoff: ready by the plan (which includes the
 * dependency gate and tombstones), has a worker, owned by no batch, on a plan
 * the Owner has confirmed, on a queue that is active.
 */
function handoffOf(stored: StoredQueue, entries: QueueEntryView[], needsReview: boolean, batches: QueueBatchView[]): QueueHandoff {
  const eligible: QueueHandoffEntry[] = [];
  const excluded: (QueueHandoffEntry & { reasons: string[] })[] = [];
  for (const entry of entries) {
    if (entry.state === "completed" || entry.state === "removed") continue;
    const base = { taskId: entry.taskId, title: entry.title, position: entry.position };
    if (entry.state === "ready" && !entry.needsAssignment && entry.batchIds.length === 0) eligible.push(base);
    else excluded.push({ ...base, reasons: entry.reasons.length > 0 ? entry.reasons : ["It can't start yet."] });
  }
  const open = batches.find((batch) => isOpenQueueBatch(batch.status)) ?? null;
  let reason: string | null = null;
  if (stored.status !== "active") reason = stored.status === "paused" ? "This queue is paused. Resume it first." : "This queue was stopped. Save a new queue to start over.";
  else if (needsReview) reason = "The plan changed since you last confirmed this queue. Confirm the updated plan first.";
  else if (open) reason = "This queue already has an open Execution Batch. Finish or cancel it before preparing another.";
  else if (eligible.length === 0) reason = "No task of this queue is ready with a worker and free of other batches.";
  return { canPrepare: reason == null, reason, eligible, excluded, openBatchId: open?.id ?? null };
}

function progressionOf(
  stored: StoredQueue,
  plan: PlanView,
  entries: QueueEntryView[],
  next: QueueNext | null,
  needsReview: boolean,
  ctx: QueueContext,
): QueueProgression {
  const open = entries.filter((entry) => entry.state !== "completed" && entry.state !== "removed");
  const running = entries.find((entry) => entry.state === "in-progress") ?? null;
  const current: QueueNext | null = running ? { taskId: running.taskId, title: running.title, position: running.position } : null;
  const nodeOf = (taskId: string) => entries.find((entry) => entry.taskId === taskId)?.node ?? null;

  // What changed since the Owner confirmed the plan: reported only when the key moved.
  let changes: PlanChange[] = [];
  let changesUnavailable = false;
  if (needsReview) {
    if (stored.reviewedSnapshot && ctx.snapshot) changes = diffSnapshots(stored.reviewedSnapshot, ctx.snapshot);
    else changesUnavailable = true;
  }
  const reviewedState = new Map(stored.reviewedSnapshot?.nodes.map((node) => [node.taskId, node.state]) ?? []);
  const becameReady = needsReview
    ? plan.nodes
        .filter((node) => node.taskId && node.stage === "created" && node.state === "ready" && reviewedState.get(node.taskId) !== "ready")
        .map((node) => ({ taskId: node.taskId!, title: node.title }))
    : [];
  const stillBlocked = plan.nodes
    .filter((node) => node.taskId && node.stage === "created" && node.state === "blocked")
    .slice(0, 20)
    .map((node) => ({ taskId: node.taskId!, title: node.title, reasons: [...node.reasons] }));

  // The candidate: the queue's own next task; with the opt-in, otherwise the
  // first ready, assigned plan task outside the queue (it needs the plan to be
  // confirmed with it, which only the Owner can do).
  let candidate: QueueCandidate | null = null;
  let outside = false;
  const live = stored.status === "active" && !running;
  if (live && next) {
    const node = nodeOf(next.taskId);
    if (node) candidate = candidateOf(node, next.position);
  } else if (live && stored.autoPrepare && !next) {
    const inQueue = new Set(entries.map((entry) => entry.taskId));
    const extra = plan.nodes.find((node) =>
      node.taskId && node.stage === "created" && node.state === "ready" && node.assignment && !inQueue.has(node.taskId)
      && (ctx.batchOwners?.(node.taskId) ?? []).length === 0);
    if (extra) {
      candidate = candidateOf(extra, null);
      outside = true;
    }
  }

  let phase: QueuePhase;
  let reason: string | null = null;
  if (stored.status === "stopped") {
    phase = "stopped";
    reason = "This queue was stopped. Nothing advances from it.";
  } else if (stored.status === "paused") {
    phase = "paused";
    reason = "This queue is paused. Resume it to continue.";
  } else if (running) {
    phase = "in-progress";
    reason = `“${running.title}” is running. The next task waits until it finishes.`;
  } else if (needsReview && (candidate || becameReady.length > 0)) {
    // Only a plan change that opens something to review is "stale"; a change that
    // leaves the Owner waiting (a result in Review, a blocked dependency) is
    // reported as that wait, with the changes listed beside it.
    phase = "stale";
    reason = "The plan changed since you last confirmed it. Read what changed, then confirm the updated plan. Nothing was started.";
  } else if (candidate && next) {
    phase = "ready-to-review";
    reason = `“${candidate.title}” is ready. Open its Employee Review to continue; nothing starts until you confirm there.`;
  } else if (candidate && outside) {
    phase = "stale";
    reason = `“${candidate.title}” became ready but is not in your queue. Confirm the updated plan to add it.`;
  } else if (open.length === 0) {
    phase = "completed";
    reason = entries.length > 0 ? "Every task of this queue is done." : null;
  } else if (entries.some((entry) => entry.state === "ready" && entry.batchIds.length > 0)) {
    phase = "waiting-owner";
    reason = "The ready task belongs to an Execution Batch, which owns its run.";
  } else if (open.some((entry) => entry.needsAssignment)) {
    phase = "waiting-assignment";
    reason = "A ready task needs a worker before Employee Review can open.";
  } else if (open.some((entry) => entry.state === "waiting-owner")) {
    phase = "waiting-owner";
    reason = "A task waits for your decision (a review or an answer).";
  } else {
    phase = "waiting-dependency";
    reason = "Every open task waits for a dependency that is not Done yet. Review is not Done.";
  }

  const canOpenReview = phase === "ready-to-review" && !needsReview && candidate != null && candidate.inQueue;
  return {
    phase,
    reason,
    current,
    candidate,
    canOpenReview,
    needsPlanConfirmation: outside || (needsReview && stored.status === "active"),
    changes,
    materialChange: changes.some((change) => change.material),
    changesUnavailable,
    becameReady,
    stillBlocked,
  };
}
