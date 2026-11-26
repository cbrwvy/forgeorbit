/**
 * Bounded autonomous execution (FO-ORCH08): the enforcement side.
 *
 * `src/shared/autonomy.ts` holds the grant and the pure decision. This module
 * gathers the facts for a task that is about to get a Run and exposes three
 * things:
 *
 *  - `withAutonomyOrigin`: ForgeOrbit's own automatic paths (batch start,
 *    pipeline step, handoff reminder, fx auto-resume, session continuation)
 *    mark the async call chain they run in. The Owner's own clicks and
 *    messages never do, so they are never refused here.
 *  - `autonomyRunRefusal`: the explicit check those paths make up front, with
 *    a readable reason.
 *  - A guard installed on `runs.insert`. It runs synchronously in the same
 *    tick as the write, so what was checked is what is recorded: between the
 *    check and the insert nothing else can run, and the Run budget is read
 *    from the `runs` table itself (not a second counter that could drift).
 *    It is the last gate for every path above, including the ones that had no
 *    verify hook before.
 *
 * Counting: a Run is any `runs` row recorded for a granted task, or for a
 * hidden step of a granted pipeline task, since the grant — failed and
 * cancelled starts included. Retries, step runs and reminders that mint a Run
 * therefore all count. A Run that finishes is not an accepted result; the
 * Owner's review is what makes a task Done.
 *
 * Nothing here switches an executor, an account or a model, and nothing
 * extends a grant.
 */

import { AutonomyRefusedError, currentAutonomyOrigin, withAutonomyOrigin } from "./autonomy-origin.ts";
import { projectLifecycleTaskRefusal } from "./project-lifecycle.ts";
import {
  AUTONOMY_ORIGIN_LABEL,
  autonomyModeVerdict,
  evaluateAutonomousRun,
  type AutonomyGrant,
  type AutonomyPlanEvidence,
  type AutonomyResource,
  type GrantBlocker,
  type AutonomyOrigin,
  type RunGateFacts,
  type RunGateVerdict,
} from "../shared/autonomy.ts";
import { launchFingerprint, sanitizeStoredBatch, isActiveBatch, type BatchEntry, type ExecutionBatch } from "../shared/task-scheduling.ts";
import { modeAccessLevel } from "../shared/project-execution.ts";
import { DEFAULT_MODEL, defaultModeFor, type Run, type Task } from "../shared/types.ts";
import { AccountCore } from "./account-core.ts";
import { db, executionBatches, harnesses, pipelines, runs, setRunInsertGuard, taskScheduling, tasks } from "./db.ts";
import { agentsOf, executionSignature } from "./execution-config.ts";
import { normalizeConfig } from "./project-execution.ts";
import { ownershipOf } from "./project-ownership.ts";
import { eligibilityRefusal, evaluateResourceEligibility } from "./resource-eligibility.ts";

/* ────────────────────────────────────────────────────────────────────────── *
 * Origin context.
 * ────────────────────────────────────────────────────────────────────────── */

export { AutonomyRefusedError, currentAutonomyOrigin, withAutonomyOrigin };

export interface AutonomyRefusal {
  batchId: string;
  grantId: string;
  taskId: string;
  rootTaskId: string;
  origin: AutonomyOrigin;
  code: string;
  reason: string;
}

type RefusalListener = (refusal: AutonomyRefusal) => void;
const listeners = new Set<RefusalListener>();

/** The batch layer subscribes to turn refusals into a pause and a Journal entry. */
export function onAutonomyRefusal(listener: RefusalListener): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/* ────────────────────────────────────────────────────────────────────────── *
 * Scope: which grant, if any, covers a task.
 * ────────────────────────────────────────────────────────────────────────── */

export interface AutonomyScope {
  batch: ExecutionBatch;
  grant: AutonomyGrant;
  rootTaskId: string;
  entry: BatchEntry | null;
  competing: number;
}

function parseBatch(raw: string): ExecutionBatch | null {
  try {
    return sanitizeStoredBatch(JSON.parse(raw));
  } catch {
    return null;
  }
}

/** A task and its hidden pipeline steps belong to the batch entry that names the root. */
export function rootTaskIdOf(task: Pick<Task, "id" | "pipelineParentId">): string {
  return task.pipelineParentId ?? task.id;
}

/**
 * The grant that covers a task, or null when it isn't in a granted batch.
 * A completed batch has nothing left to bound; a cancelled or stopped one
 * still does (its pipelines must not carry on by themselves).
 */
export function findAutonomyScope(taskId: string): AutonomyScope | null {
  const task = tasks.get(taskId);
  if (!task) return null;
  const rootTaskId = rootTaskIdOf(task);
  const batches = executionBatches.listContainingTask(rootTaskId).map(parseBatch).filter((b): b is ExecutionBatch => b != null);
  const granted = batches.filter((b) => b.autonomy && b.status !== "completed" && b.status !== "draft");
  if (granted.length === 0) return null;
  const chosen = granted.find((b) => isActiveBatch(b.status)) ?? granted[granted.length - 1]!;
  return scopeOf(chosen, rootTaskId, batches);
}

function scopeOf(batch: ExecutionBatch, rootTaskId: string, siblings: readonly ExecutionBatch[]): AutonomyScope {
  return {
    batch,
    grant: batch.autonomy!,
    rootTaskId,
    entry: batch.entries.find((entry) => entry.taskId === rootTaskId) ?? null,
    competing: siblings.filter((b) => b.id !== batch.id && isActiveBatch(b.status)).length,
  };
}

/** The same decision for a batch the caller already holds in memory (a tick, a grant). */
export function checkGrantForBatch(batch: ExecutionBatch, taskId: string, origin: AutonomyOrigin, now = Date.now()): RunGateVerdict & { scope: AutonomyScope | null } {
  const task = tasks.get(taskId);
  if (!task || !batch.autonomy) return { allowed: true, scope: null };
  const rootTaskId = rootTaskIdOf(task);
  const siblings = executionBatches.listContainingTask(rootTaskId).map(parseBatch).filter((b): b is ExecutionBatch => b != null);
  const scope = scopeOf(batch, rootTaskId, siblings);
  return { ...evaluateAutonomousRun(scope.grant, gateFacts(scope, task, origin, now)), scope };
}

/** Every task whose Runs the grant counts: its entries and the hidden steps of pipeline entries. */
export function grantScopeTaskIds(batch: Pick<ExecutionBatch, "entries">, grant: Pick<AutonomyGrant, "taskIds">): string[] {
  const ids = new Set(grant.taskIds);
  for (const id of grant.taskIds) {
    for (const step of tasks.stepsForParent(id)) ids.add(step.id);
  }
  return [...ids];
}

export function grantCounters(batch: Pick<ExecutionBatch, "entries">, grant: AutonomyGrant): { used: number; live: number; scope: string[] } {
  const scope = grantScopeTaskIds(batch, grant);
  return { used: runs.countForTasksSince(scope, grant.approvedAt), live: runs.countRunningForTasks(scope), scope };
}

const sameList = (a: readonly string[], b: readonly string[]) => {
  const x = [...a].sort();
  const y = [...b].sort();
  return x.length === y.length && x.every((id, i) => id === y[i]);
};

/** The agent a Run for this task would use, as the grant describes it. Null for a pipeline task itself. */
export function currentAgentOf(task: Task): NonNullable<RunGateFacts["current"]> | null {
  if (task.pipelineId && !task.pipelineParentId) return null;
  const harness = harnesses.getByIdOrKind(task.agent);
  const kind = harness?.kind ?? null;
  const mode = task.mode ?? (harness ? defaultModeFor(harness.kind) : "auto");
  return {
    harnessId: harness?.id ?? task.agent,
    kind,
    model: task.model || (harness ? DEFAULT_MODEL[harness.kind] ?? null : null),
    mode,
    accessLevel: kind ? modeAccessLevel(kind, mode) : 4,
    accountId: harness ? new AccountCore(db).resolveIdentity(harness.id, task.agentProfileId ?? null).accountId : null,
  };
}

export function gateFacts(scope: AutonomyScope, task: Task, origin: AutonomyOrigin, now: number): RunGateFacts {
  const { batch, grant, entry, rootTaskId } = scope;
  const root = tasks.get(rootTaskId);
  const config = entry ? normalizeConfig(entry.config) : null;
  const dependsOn = taskScheduling.dependenciesOf(rootTaskId);
  const counters = grantCounters(batch, grant);
  const expected = entry ? entry.appliedFingerprint ?? entry.approved?.fingerprint ?? null : null;
  return {
    origin,
    now,
    batchStatus: batch.status,
    rootTaskId,
    competingBatches: scope.competing,
    approvalPreviewKey: batch.approval?.previewKey ?? null,
    entry: {
      present: entry != null,
      signatureNow: config ? executionSignature(config) : null,
      approvedSignature: entry?.approved?.signature ?? null,
      // While the batch is writing its config onto the task the fingerprint is
      // legitimately in flux; the launch compares it itself (expectFingerprint).
      fingerprintOk: !entry || !!entry.launching || (root != null && expected != null && (launchFingerprint(root) === expected || launchFingerprint(root) === entry.approved?.fingerprint)),
      dependenciesSame: !entry?.approved || sameList(entry.approved.dependsOn, dependsOn),
      dependenciesDone: (entry?.approved?.dependsOn ?? []).every((id) => tasks.get(id)?.column === "done"),
      tombstones: taskScheduling.tombstonesOf(rootTaskId).length > 0,
    },
    used: counters.used,
    live: counters.live,
    current: currentAgentOf(task),
  };
}

/**
 * May one more Run be recorded for this task? Unscoped tasks (not in any granted
 * batch) are not this module's business and are allowed. The scope is returned
 * so callers can name the batch.
 */
export function checkAutonomousRun(
  taskId: string,
  origin: AutonomyOrigin,
  now = Date.now(),
): (RunGateVerdict & { scope: AutonomyScope | null }) {
  const task = tasks.get(taskId);
  if (!task) return { allowed: true, scope: null };
  const scope = findAutonomyScope(taskId);
  if (!scope) return { allowed: true, scope: null };
  return { ...evaluateAutonomousRun(scope.grant, gateFacts(scope, task, origin, now)), scope };
}

/** Violations that are ordinary throttling, not a reason to pause the batch. */
const QUIET_CODES = new Set(["parallelism-reached", "batch-not-running"]);

function announce(scope: AutonomyScope, taskId: string, origin: AutonomyOrigin, code: string, reason: string): void {
  if (QUIET_CODES.has(code)) return;
  const refusal: AutonomyRefusal = { batchId: scope.batch.id, grantId: scope.grant.id, taskId, rootTaskId: scope.rootTaskId, origin, code, reason };
  for (const listener of listeners) {
    try {
      listener(refusal);
    } catch (err) {
      console.warn("[agetor] autonomy listener failed:", err);
    }
  }
}

/**
 * The explicit pre-check an automatic path makes: a readable reason, or null.
 * Also tells the batch layer so it can pause and record why.
 */
export function autonomyRunRefusal(taskId: string, origin: AutonomyOrigin): string | null {
  const lifecycleRefusal = projectLifecycleTaskRefusal(taskId);
  if (lifecycleRefusal) return `Autonomous execution: ${lifecycleRefusal}`;
  const verdict = checkAutonomousRun(taskId, origin);
  if (verdict.allowed || !verdict.scope) return null;
  announce(verdict.scope, taskId, origin, verdict.code, verdict.reason);
  return `Autonomous execution: ${verdict.reason}`;
}

/** Resource eligibility for any task, asked about the agent its next Run will use. */
export function taskResourceRefusal(taskId: string): string | null {
  const task = tasks.get(taskId);
  const root = task ? (task.pipelineParentId ? tasks.get(task.pipelineParentId) : task) : null;
  if (!task || !root) return null;
  const harness = harnesses.getByIdOrKind(task.agent);
  if (!harness) return null;
  // A task outside every registered project still has Owner prohibitions and
  // disabled harnesses; the router just has no project facts to narrow by.
  const owner = ownershipOf(root.workdir, { fresh: true });
  const verdict = evaluateResourceEligibility({
    task: root,
    projectPath: owner.kind === "owned" ? owner.projectPath : root.workdir,
    harness,
    model: task.model || DEFAULT_MODEL[harness.kind] || null,
    profileId: task.agentProfileId ?? null,
  });
  return verdict.blocked ? eligibilityRefusal(verdict) : null;
}

/** Origins whose Runs have no other eligibility check on their way in. */
const NEEDS_ELIGIBILITY: readonly AutonomyOrigin[] = ["handoff-reminder", "fx-auto-resume"];

function guard(run: Run): void {
  const origin = currentAutonomyOrigin();
  if (!origin) return;
  const lifecycleRefusal = projectLifecycleTaskRefusal(run.taskId);
  if (lifecycleRefusal) {
    throw new AutonomyRefusedError("project-paused", `Autonomous execution: ${lifecycleRefusal}`, null);
  }
  const verdict = checkAutonomousRun(run.taskId, origin);
  if (!verdict.allowed) {
    if (verdict.scope) announce(verdict.scope, run.taskId, origin, verdict.code, verdict.reason);
    throw new AutonomyRefusedError(verdict.code, `Autonomous execution: ${verdict.reason}`, verdict.scope?.batch.id ?? null);
  }
  if (NEEDS_ELIGIBILITY.includes(origin)) {
    const refusal = taskResourceRefusal(run.taskId);
    if (refusal) throw new AutonomyRefusedError("resource-refused", `${AUTONOMY_ORIGIN_LABEL[origin]} refused: ${refusal}`);
  }
}

/* ────────────────────────────────────────────────────────────────────────── *
 * Building a grant from an approved batch.
 * ────────────────────────────────────────────────────────────────────────── */

export interface GrantDraft {
  taskIds: string[];
  resources: AutonomyResource[];
  planEvidence: AutonomyPlanEvidence;
  blockers: GrantBlocker[];
  /** Resources whose quota is not Verified (Unknown, Conditional, Conflicting…). */
  unknownQuota: { harnessId: string; model: string | null; evidence: string }[];
}

/**
 * Reads what a grant would bind from the batch's frozen approval and the live
 * router/AccountCore evidence. Writes nothing and probes no provider. A
 * blocker means the grant can't be made as things stand; unknown quota is not
 * a blocker, it needs the Owner's explicit acknowledgement.
 */
export function buildGrantDraft(batch: ExecutionBatch, now = Date.now()): GrantDraft {
  const blockers: GrantBlocker[] = [];
  const resources: AutonomyResource[] = [];
  const unknown = new Map<string, { harnessId: string; model: string | null; evidence: string }>();
  const evidence: AutonomyPlanEvidence = {
    previewKey: batch.approval?.previewKey ?? "",
    entries: [],
    queue: batch.sourceQueue ? { queueId: batch.sourceQueue.queueId, planKey: batch.sourceQueue.planKey, queueRevision: batch.sourceQueue.queueRevision } : null,
  };
  if (!batch.approval) blockers.push({ taskId: null, code: "not-approved", message: "Approve the batch first; a grant only narrows an approved batch." });
  for (const entry of batch.entries) {
    const task = tasks.get(entry.taskId);
    if (!entry.approved) {
      blockers.push({ taskId: entry.taskId, code: "not-approved", message: `“${entry.title}” isn't part of the approval.` });
    } else {
      evidence.entries.push({ taskId: entry.taskId, signature: entry.approved.signature, fingerprint: entry.approved.fingerprint, dependsOn: [...entry.approved.dependsOn] });
    }
    const config = normalizeConfig(entry.config);
    const agents = agentsOf(config);
    if (agents.length === 0) blockers.push({ taskId: entry.taskId, code: "no-agent", message: `“${entry.title}” has no resolvable agent.` });
    for (const [index, agent] of agents.entries()) {
      const kind = agent.harness?.kind ?? null;
      if (!agent.harness) {
        blockers.push({ taskId: entry.taskId, code: "unknown-harness", message: `“${entry.title}”: harness ${agent.harnessId} isn't set up.` });
        continue;
      }
      const verdict = autonomyModeVerdict(kind, agent.mode);
      if (!verdict.allowed) {
        blockers.push({ taskId: entry.taskId, code: "mode-not-allowed", message: `“${entry.title}” runs ${agent.harness.label} in mode “${agent.mode}”. ${verdict.reason} Change its mode, or run it by hand.` });
      }
      const identity = new AccountCore(db, () => now).resolveIdentity(agent.harness.id, agent.profileId);
      let quotaEvidence = "unknown";
      if (task) {
        const owned = ownershipOf(task.workdir, { fresh: true });
        const eligibility = evaluateResourceEligibility({
          task,
          projectPath: owned.kind === "owned" ? owned.projectPath : batch.projectPath,
          harness: agent.harness,
          model: agent.model,
          profileId: agent.profileId,
          now,
        });
        quotaEvidence = eligibility.evidence;
        if (eligibility.blocked) blockers.push({ taskId: entry.taskId, code: `quota:${eligibility.code}`, message: eligibilityRefusal(eligibility) });
      }
      if (quotaEvidence !== "verified") {
        unknown.set(`${agent.harness.id}\u0000${agent.model ?? ""}`, { harnessId: agent.harness.id, model: agent.model, evidence: quotaEvidence });
      }
      resources.push({
        taskId: entry.taskId,
        stepName: config.pipelineId ? (pipelines.get(config.pipelineId)?.graph.steps[index]?.name ?? null) : null,
        harnessId: agent.harness.id,
        model: agent.model,
        mode: agent.mode,
        accessLevel: kind ? modeAccessLevel(kind, agent.mode) : 4,
        profileId: agent.profileId,
        accountId: identity.accountId,
        quotaEvidence,
      });
    }
  }
  return { taskIds: batch.entries.map((entry) => entry.taskId), resources, planEvidence: evidence, blockers, unknownQuota: [...unknown.values()] };
}

let installed = false;
/** Idempotent; called at boot and by tests that exercise the gate. */
export function installAutonomyGuard(): void {
  if (installed) return;
  installed = true;
  setRunInsertGuard(guard);
}

export function uninstallAutonomyGuardForTest(): void {
  installed = false;
  setRunInsertGuard(null);
}

installAutonomyGuard();
