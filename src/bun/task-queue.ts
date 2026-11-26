/**
 * Controlled execution queue, server side (FO-ORCH05).
 *
 * Stores the Owner's choice for one task plan: which ready tasks, in which
 * order, paused or stopped, and the plan key last reviewed (migration 094).
 * Everything else is derived from the plan (`task-plan.ts`) on every read.
 *
 * A queue never starts, assigns, retries or switches anything and writes no
 * run, review, journal or quota row. `next` only names the task whose
 * existing Employee Review the Owner may open; that review, its permission
 * review and its confirmation are unchanged and still required for every
 * start. A stale plan key, a changed queue revision or a plan that changed
 * since the Owner reviewed it is refused (409) with the fresh state.
 */

import { QUEUE_LIMITS, deriveQueue, sanitizeSnapshot, snapshotOfPlan, type QueueBatchView, type QueueView, type StoredQueue } from "../shared/task-queue.ts";
import { queueOrderGuarantee, type BatchView, type ExecutionBatch } from "../shared/task-scheduling.ts";
import type { PlanView } from "../shared/task-plan.ts";
import { stableHash } from "../shared/project-execution.ts";
import { ActivityJournalCore } from "./activity-journal-core.ts";
import { db, taskQueues, tasks, type TaskQueueRow } from "./db.ts";
import { resolveProject } from "./environment/http.ts";
import { getPlan, verifyPlan, type PlanDeps, type PlanResult } from "./task-plan.ts";
import { activeBatchesFor } from "./task-scheduling.ts";
import { batchView, batchesOfQueue, createQueueBatch, type BatchDeps } from "./execution-batches.ts";
import { dependencyGateFor } from "./dependency-gate.ts";

/** The stored row with its snapshot read defensively (malformed reads as "not stored"). */
function toStored(row: TaskQueueRow): StoredQueue {
  return { ...row, reviewedSnapshot: sanitizeSnapshot(row.reviewedSnapshot) };
}

/** Digest of what a task will run as, without its column or run (those are progress, not config). */
function configOf(taskId: string): string | null {
  const task = tasks.get(taskId);
  if (!task) return null;
  return stableHash([
    task.title, task.prompt, task.agent, task.model ?? "", task.effort ?? "", task.mode ?? "", task.fast ? "1" : "0",
    task.maxMode ? "1" : "0", task.agentProfileId ?? "", task.pipelineId ?? "", task.workdir, task.isolation,
  ].join("\u0000"));
}

/** Derive a queue with what only the core knows: batch ownership and the plan snapshot. */
function toBatchView(batch: ExecutionBatch, planKey: string): QueueBatchView {
  const view = batchView(batch);
  const priorities = view.entries.filter((entry) => entry.state === "pending").map((entry) => entry.priority);
  const order = queueOrderGuarantee(priorities, batch.policy.maxParallel);
  return {
    id: batch.id,
    title: batch.title,
    status: batch.status,
    taskIds: batch.sourceQueue?.taskIds ?? batch.entries.map((entry) => entry.taskId),
    entryStates: Object.fromEntries(view.entries.map((entry) => [entry.taskId, entry.state])),
    approvedAt: batch.approval?.at ?? null,
    expiresAt: batch.approval?.expiresAt ?? null,
    expired: view.authorizationExpired === true,
    maxParallel: batch.policy.maxParallel,
    maxStarts: batch.policy.maxStarts,
    launchesUsed: view.launchesUsed,
    maxRetriesPerTask: batch.policy.maxRetriesPerTask,
    spending: batch.policy.spending,
    fullAccessTaskIds: batch.approval?.fullAccessTaskIds ?? [],
    orderGuaranteed: order.guaranteed,
    orderNote: order.note,
    stale: batch.sourceQueue != null && batch.sourceQueue.planKey !== planKey,
    reason: batch.reason?.text ?? null,
  };
}

function derive(stored: TaskQueueRow, projectPath: string, plan: PlanView): QueueView {
  const owners = new Map<string, string[]>();
  return deriveQueue(toStored(stored), plan, {
    batchOwners: (taskId) => {
      if (!owners.has(taskId)) owners.set(taskId, activeBatchesFor(projectPath, taskId));
      return owners.get(taskId)!;
    },
    snapshot: snapshotOfPlan(plan, configOf),
    batches: batchesOfQueue(projectPath, stored.id).map((batch) => toBatchView(batch, plan.planKey)),
  });
}

/** One Owner act on a queue, recorded with the state change it describes. */
function journalQueue(
  row: TaskQueueRow,
  eventType: "queue.plan.confirmed" | "queue.paused" | "queue.resumed" | "queue.stopped",
  keyPart: string,
  extra: Record<string, unknown> = {},
): void {
  new ActivityJournalCore(db).record({
    eventType,
    projectPath: row.projectPath,
    actorType: "owner",
    actorId: "owner",
    targetType: "proposal",
    targetId: row.proposalId,
    idempotencyKey: `task_queue:${row.id}:${keyPart}:${row.revision}`,
    payload: { queueId: row.id, proposalId: row.proposalId, queueRevision: row.revision, ...extra },
    createdAt: row.updatedAt,
  });
}

function fail<T>(status: number, error: string, body?: Record<string, unknown>): PlanResult<T> {
  return { ok: false, status, error, ...(body ? { body } : {}) };
}

function registered(rawPath: unknown): PlanResult<string> {
  const resolved = resolveProject(typeof rawPath === "string" ? rawPath : "");
  if (!resolved.ok) return fail(resolved.status, resolved.error);
  return { ok: true, value: resolved.path };
}

const MAX_ID = 200;

function revisionOf(value: unknown): number | null {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 1 ? value : null;
}

/** The queue of a plan with its derived state, or null before one is saved. */
export async function getQueue(rawPath: unknown, proposalId: string, deps: PlanDeps = {}): Promise<PlanResult<{ queue: QueueView | null }>> {
  const project = registered(rawPath);
  if (!project.ok) return project;
  const stored = taskQueues.forProposal(project.value, proposalId);
  if (!stored) {
    const exists = await getPlan(project.value, proposalId, { ...deps, skipRecommendations: true });
    return exists.ok ? { ok: true, value: { queue: null } } : exists;
  }
  const plan = await getPlan(project.value, proposalId, deps);
  if (!plan.ok) return plan;
  return { ok: true, value: { queue: derive(stored, project.value, plan.value) } };
}

/**
 * Create or replace the queue of a plan. The Owner must have read the
 * current plan (`planKey`); only ready tasks can be added, in the order sent.
 * Saving on a paused queue keeps it paused; saving on a stopped one is the
 * Owner's explicit decision to start over.
 */
export async function saveQueue(
  rawPath: unknown,
  proposalId: string,
  body: { taskIds?: unknown; planKey?: unknown; revision?: unknown },
  deps: PlanDeps = {},
): Promise<PlanResult<{ queue: QueueView }>> {
  const project = registered(rawPath);
  if (!project.ok) return project;
  const ids = body.taskIds;
  if (!Array.isArray(ids) || ids.length === 0 || ids.some((id) => typeof id !== "string" || !id || id.length > MAX_ID)) {
    return fail(400, "taskIds must be a non-empty list of task ids.");
  }
  if (ids.length > QUEUE_LIMITS.entries) return fail(400, `A queue holds at most ${QUEUE_LIMITS.entries} tasks.`);
  if (new Set(ids).size !== ids.length) return fail(400, "A task can appear in a queue only once.");

  const verified = await verifyPlan(project.value, proposalId, body.planKey, deps);
  if (!verified.ok) return verified;
  const plan: PlanView = verified.value.plan;

  const existing = taskQueues.forProposal(project.value, proposalId);
  if (existing) {
    const revision = revisionOf(body.revision);
    if (revision == null) return fail(400, "revision is required to change an existing queue.");
    if (revision !== existing.revision) {
      return fail(409, "The queue changed since you loaded it. Reload it before editing.", { queue: derive(existing, project.value, plan) });
    }
  }
  const already = new Set(existing?.taskIds ?? []);
  const byTask = new Map(plan.nodes.filter((node) => node.taskId).map((node) => [node.taskId!, node]));
  for (const id of ids as string[]) {
    const node = byTask.get(id);
    if (!node || node.stage !== "created") return fail(409, "A selected task is not part of this plan's board tasks. Nothing was saved.");
    if (!already.has(id) && node.state !== "ready") {
      const why = node.reasons[0] ?? "it is not ready";
      return fail(409, `“${node.title}” can't be queued: ${why} Nothing was saved.`);
    }
    if (!already.has(id) && activeBatchesFor(project.value, id).length > 0) {
      return fail(409, `“${node.title}” belongs to an Execution Batch, which owns its run. Nothing was saved.`);
    }
  }

  const now = Date.now();
  if (!existing) {
    const row: TaskQueueRow = {
      id: crypto.randomUUID(), projectPath: project.value, proposalId, taskIds: ids as string[],
      status: "active", revision: 1, reviewedPlanKey: plan.planKey, reviewedSnapshot: snapshotOfPlan(plan, configOf),
      autoPrepare: false, createdAt: now, updatedAt: now,
    };
    try {
      db.transaction(() => {
        taskQueues.insert(row);
        journalQueue(row, "queue.plan.confirmed", "confirmed", { planKey: plan.planKey, taskIds: row.taskIds });
      })();
    } catch {
      return fail(409, "A queue for this plan was just created. Reload it before editing.");
    }
    return { ok: true, value: { queue: derive(row, project.value, plan) } };
  }
  const row: TaskQueueRow = {
    ...existing,
    taskIds: ids as string[],
    status: existing.status === "paused" ? "paused" : "active",
    revision: existing.revision + 1,
    reviewedPlanKey: plan.planKey,
    reviewedSnapshot: snapshotOfPlan(plan, configOf),
    updatedAt: now,
  };
  const saved = db.transaction(() => {
    if (!taskQueues.update(row, existing.revision)) return false;
    journalQueue(row, "queue.plan.confirmed", "confirmed", { planKey: plan.planKey, taskIds: row.taskIds });
    return true;
  })();
  if (!saved) return fail(409, "The queue changed since you loaded it. Reload it before editing.");
  return { ok: true, value: { queue: derive(row, project.value, plan) } };
}

export type QueueAction = "pause" | "resume" | "stop";

/** Pause, resume or stop further advancing. Never touches a running task. */
export async function setQueueStatus(
  rawPath: unknown,
  queueId: string,
  action: QueueAction,
  rawRevision: unknown,
  deps: PlanDeps = {},
): Promise<PlanResult<{ queue: QueueView }>> {
  const project = registered(rawPath);
  if (!project.ok) return project;
  const stored = taskQueues.get(project.value, queueId);
  if (!stored) return fail(404, "Queue not found for this project.");
  const revision = revisionOf(rawRevision);
  if (revision == null) return fail(400, "revision is required.");
  if (revision !== stored.revision) return fail(409, "The queue changed since you loaded it. Reload it first.");
  const allowed =
    (action === "pause" && stored.status === "active") ||
    (action === "resume" && stored.status === "paused") ||
    (action === "stop" && stored.status !== "stopped");
  if (!allowed) return fail(409, `A ${stored.status} queue can't be ${action === "stop" ? "stopped" : action === "pause" ? "paused" : "resumed"}.`);
  const row: TaskQueueRow = {
    ...stored,
    status: action === "pause" ? "paused" : action === "resume" ? "active" : "stopped",
    revision: stored.revision + 1,
    updatedAt: Date.now(),
  };
  const changed = db.transaction(() => {
    if (!taskQueues.update(row, stored.revision)) return false;
    journalQueue(row, action === "pause" ? "queue.paused" : action === "resume" ? "queue.resumed" : "queue.stopped", action);
    return true;
  })();
  if (!changed) return fail(409, "The queue changed since you loaded it. Reload it first.");
  // Same deps as every other read, so the plan key (which covers the
  // recommendations) matches what the Owner reviewed.
  const plan = await getPlan(project.value, stored.proposalId, deps);
  if (!plan.ok) return plan;
  return { ok: true, value: { queue: derive(row, project.value, plan.value) } };
}

/**
 * Owner opt-in: keep the next task's review prepared (read-only). Off by
 * default. Turning it on or off is the Owner's durable decision, so it is a
 * compare-and-set on the queue revision and is recorded in the Activity
 * Journal once per change (a repeated call with the same value records nothing
 * and bumps nothing). It never touches the reviewed plan key: the Owner's
 * confirmation of the plan is a separate act.
 */
export async function setAutoPrepare(
  rawPath: unknown,
  queueId: string,
  body: { enabled?: unknown; revision?: unknown },
  deps: PlanDeps = {},
): Promise<PlanResult<{ queue: QueueView; changed: boolean }>> {
  const project = registered(rawPath);
  if (!project.ok) return project;
  const stored = taskQueues.get(project.value, queueId);
  if (!stored) return fail(404, "Queue not found for this project.");
  if (typeof body.enabled !== "boolean") return fail(400, "enabled must be true or false.");
  const revision = revisionOf(body.revision);
  if (revision == null) return fail(400, "revision is required.");
  const planOf = async () => getPlan(project.value, stored.proposalId, deps);
  if (stored.status === "stopped") return fail(409, "This queue was stopped. Save a new queue to start over.");
  if (stored.autoPrepare === body.enabled) {
    // Idempotent: same value, nothing to write or record. A stale revision
    // doesn't matter when the stored state already is what was asked for.
    const plan = await planOf();
    if (!plan.ok) return plan;
    return { ok: true, value: { queue: derive(stored, project.value, plan.value), changed: false } };
  }
  if (revision !== stored.revision) return fail(409, "The queue changed since you loaded it. Reload it first.");
  const row: TaskQueueRow = { ...stored, autoPrepare: body.enabled, revision: stored.revision + 1, updatedAt: Date.now() };
  const committed = db.transaction(() => {
    if (!taskQueues.update(row, stored.revision)) return false;
    new ActivityJournalCore(db).record({
      eventType: body.enabled ? "queue.preparation.enabled" : "queue.preparation.disabled",
      projectPath: project.value,
      actorType: "owner",
      actorId: "owner",
      targetType: "proposal",
      targetId: stored.proposalId,
      idempotencyKey: `task_queue:${stored.id}:auto-prepare:${row.revision}`,
      payload: { queueId: stored.id, proposalId: stored.proposalId, queueRevision: row.revision },
      createdAt: row.updatedAt,
    });
    return true;
  })();
  if (!committed) return fail(409, "The queue changed since you loaded it. Reload it first.");
  const plan = await planOf();
  if (!plan.ok) return plan;
  return { ok: true, value: { queue: derive(row, project.value, plan.value), changed: true } };
}

/**
 * The next task the Owner may open an Employee Review for. Read-only: it
 * checks that the queue and the plan are exactly what the Owner reviewed
 * (so changed assignments, permissions, preferences or quota evidence send
 * the Owner back to re-review) and then names the task. It creates no
 * review, run, assignment or retry.
 */
export async function nextQueueTask(
  rawPath: unknown,
  queueId: string,
  body: { revision?: unknown; planKey?: unknown },
  deps: PlanDeps = {},
): Promise<PlanResult<{ next: NonNullable<QueueView["next"]>; queue: QueueView }>> {
  const project = registered(rawPath);
  if (!project.ok) return project;
  const stored = taskQueues.get(project.value, queueId);
  if (!stored) return fail(404, "Queue not found for this project.");
  const revision = revisionOf(body.revision);
  if (revision == null) return fail(400, "revision is required.");
  const verified = await verifyPlan(project.value, stored.proposalId, body.planKey, deps);
  if (!verified.ok) return verified;
  const queue = derive(stored, project.value, verified.value.plan);
  if (revision !== stored.revision) return fail(409, "The queue changed since you loaded it. Reload it first.", { queue });
  if (queue.status !== "active") return fail(409, queue.nextBlockedReason ?? "This queue is not active.", { queue });
  if (queue.needsReview) {
    return fail(409, "The plan changed since you last reviewed this queue. Review it and save the queue again. Nothing was started.", { stale: true, queue });
  }
  if (!queue.next) return fail(409, queue.nextBlockedReason ?? "There is no task to continue with.", { queue });
  return { ok: true, value: { next: queue.next, queue } };
}

/** Queues whose handoff is being prepared right now (guards two racing requests). */
const preparing = new Set<string>();

const sameOrder = (a: readonly string[], b: readonly string[]) => a.length === b.length && a.every((id, i) => id === b[i]);

/**
 * Hand tasks of the queue to a new Execution Batch (FO-ORCH07). Creates a
 * draft only: the Owner then reviews, approves and starts it through the
 * existing batch controls, so no run, assignment, review or permission is
 * created here. Refused when the plan key, queue revision or queue status is
 * not what the Owner reviewed, when a task is not ready with a worker, is
 * owned by an active batch, or has an unsatisfied dependency (checked again
 * through the dependency gate). A repeat request for the same tasks returns
 * the batch already prepared.
 */
export async function prepareQueueBatch(
  rawPath: unknown,
  queueId: string,
  body: { revision?: unknown; planKey?: unknown; taskIds?: unknown; title?: unknown; policy?: unknown },
  deps: PlanDeps & BatchDeps = {},
): Promise<PlanResult<{ batch: BatchView; queue: QueueView; alreadyPrepared: boolean }>> {
  const project = registered(rawPath);
  if (!project.ok) return project;
  const stored = taskQueues.get(project.value, queueId);
  if (!stored) return fail(404, "Queue not found for this project.");
  const revision = revisionOf(body.revision);
  if (revision == null) return fail(400, "revision is required.");
  if (body.taskIds !== undefined && (!Array.isArray(body.taskIds) || body.taskIds.some((id) => typeof id !== "string" || !id || id.length > MAX_ID))) {
    return fail(400, "taskIds must be a list of task ids.");
  }
  if (preparing.has(stored.id)) return fail(409, "A batch is already being prepared from this queue.");
  preparing.add(stored.id);
  try {
    const verified = await verifyPlan(project.value, stored.proposalId, body.planKey, deps);
    if (!verified.ok) return verified;
    const queue = derive(stored, project.value, verified.value.plan);
    if (revision !== stored.revision) return fail(409, "The queue changed since you loaded it. Reload it first.", { queue });
    if (queue.needsReview) return fail(409, "The plan changed since you last confirmed this queue. Confirm it again. Nothing was prepared.", { stale: true, queue });
    if (queue.status !== "active") return fail(409, queue.handoff.reason ?? "This queue is not active.", { queue });

    const eligible = new Map(queue.handoff.eligible.map((entry) => [entry.taskId, entry]));
    const requested = body.taskIds === undefined ? queue.handoff.eligible.map((entry) => entry.taskId) : [...new Set(body.taskIds as string[])];
    if (requested.length === 0) return fail(409, queue.handoff.reason ?? "There is nothing to hand over.", { queue });
    if (requested.length > QUEUE_LIMITS.entries) return fail(400, `A batch holds at most ${QUEUE_LIMITS.entries} tasks.`);
    const problems: string[] = [];
    for (const id of requested) {
      const entry = queue.entries.find((item) => item.taskId === id);
      if (!entry) { problems.push(`${id.slice(0, 8)} is not in this queue.`); continue; }
      if (!eligible.has(id)) { problems.push(`“${entry.title}”: ${entry.reasons[0] ?? "it can't start yet."}`); continue; }
      const task = tasks.get(id);
      const gate = task ? dependencyGateFor(task, { fresh: true }) : null;
      if (!task || !gate?.open) problems.push(`“${entry.title}”: ${gate?.reasons[0]?.message ?? "the task no longer exists."}`);
    }
    if (problems.length > 0) return fail(409, `${problems[0]} Nothing was prepared.`, { problems, queue });

    // Owner's queue order, whatever order the request listed them in.
    const ordered = queue.entries.filter((entry) => requested.includes(entry.taskId)).map((entry) => entry.taskId);
    const open = batchesOfQueue(project.value, stored.id).find((batch) => batch.status === "draft" || batch.status === "approved" || batch.status === "running" || batch.status === "paused");
    if (open) {
      if (open.sourceQueue && open.sourceQueue.planKey === queue.planKey && sameOrder(open.sourceQueue.taskIds, ordered)) {
        return { ok: true, value: { batch: batchView(open), queue, alreadyPrepared: true } };
      }
      return fail(409, "This queue already has an open Execution Batch with different tasks. Cancel it first.", { batchId: open.id, queue });
    }

    const created = await createQueueBatch(project.value, {
      taskIds: ordered,
      title: body.title ?? queue.entries.find((entry) => entry.taskId === ordered[0])?.title,
      policy: body.policy,
      sourceQueue: { queueId: stored.id, proposalId: stored.proposalId, queueRevision: stored.revision, planKey: queue.planKey, taskIds: ordered, preparedAt: Date.now() },
      afterSave: (batch) => {
        new ActivityJournalCore(db).record({
          eventType: "queue.handoff.prepared",
          projectPath: project.value,
          actorType: "owner",
          actorId: "owner",
          targetType: "proposal",
          targetId: stored.proposalId,
          idempotencyKey: `queue_batch:${batch.id}:prepared`,
          payload: { queueId: stored.id, proposalId: stored.proposalId, queueRevision: stored.revision, batchId: batch.id, taskIds: ordered, count: ordered.length },
          createdAt: batch.createdAt,
        });
      },
    }, deps);
    if (!created.ok) return fail(created.status, created.error, created.body);
    const fresh = await getPlan(project.value, stored.proposalId, deps);
    return { ok: true, value: { batch: created.value, queue: fresh.ok ? derive(stored, project.value, fresh.value) : queue, alreadyPrepared: false } };
  } finally {
    preparing.delete(stored.id);
  }
}
