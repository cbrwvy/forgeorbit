/**
 * Approved execution batches (FO-005C.1): the owner approves a bounded set
 * of a project's tasks once, and the batch then starts them one after
 * another (or a few at a time) within that approval.
 *
 * Lifecycle: draft (editable, previewed) → approved (scope frozen) →
 * running ⇄ paused → completed | stopped | cancelled. Approving starts
 * nothing; only the owner's explicit Start does. Nothing outside the
 * approved task list ever starts, and every start is re-checked against
 * what was approved: the task's prompt and settings (fingerprint), the
 * agents it runs as (signature, permission level, allowed harnesses and
 * profiles), its dependency links, the spending policy, and the same
 * supervised checks as a single "Approve & Execute".
 *
 * There is no second runtime here. A start goes through
 * `launchBatchTask` (project-execution.ts) — the same claims, checks,
 * config write and board `startTask` the owner's approval uses — and every
 * run's progress is read back from the task and run rows. A finished run
 * never counts as accepted: a dependency is satisfied only once its task is
 * Done, which only the owner (or the owner's review) does.
 *
 * Mutations of one batch are serialized through a per-batch promise chain.
 * After a restart a batch that was running comes back paused, and a start
 * that was in flight is adopted if its run exists, otherwise held as
 * unconfirmed until the owner releases it — never relaunched blindly.
 */

import { agentProfiles, db, executionBatches, harnesses, pipelines, projectManagers, runs, taskScheduling, tasks } from "./db.ts";
import { ActivityJournalCore } from "./activity-journal-core.ts";
import { AutonomyRefusedError, withAutonomyOrigin } from "./autonomy-origin.ts";
import { buildGrantDraft, checkAutonomousRun, checkGrantForBatch, grantCounters, onAutonomyRefusal, type AutonomyRefusal } from "./autonomy.ts";
import { configEligibility, eligibilityRefusal } from "./resource-eligibility.ts";
import { resolveProject } from "./environment/http.ts";
import { cancelRun, isTaskRunLive, subscribeGlobal } from "./orchestrator.ts";
import { broadcastAppEvent } from "./quit-guard.ts";
import { cancelPipelineRun } from "./pipeline-runner.ts";
import {
  appendManagerSystemMessage,
  configFromTask,
  launchBatchTask,
  normalizeConfig,
  readConfig,
  reconcileExecution,
  runChecks,
  type Checked,
  type ExecutionDeps,
} from "./project-execution.ts";
import { accessLevelOf, agentsOf, executionSignature, harnessOf, type ConfigAgent } from "./execution-config.ts";
import { activeBatchesFor, dependencyInfo } from "./task-scheduling.ts";
import { taskInProject, verifyLaunchScope } from "./project-ownership.ts";
import { checkProjectLaunchAdmission } from "./project-lifecycle.ts";
import { onTaskAvailabilityChange, taskAvailabilityFor, taskAvailabilityNow } from "./task-availability.ts";
import { capText } from "../shared/project-interview.ts";
import {
  AUTONOMY_LIMITS,
  AUTONOMY_STOP_CONDITIONS,
  effectiveGrantStatus,
  unknownQuotaText,
  type AutonomyGrant,
  type AutonomyOrigin,
  type AutonomyPreview,
  type AutonomyStatus,
} from "../shared/autonomy.ts";
import { modeAccessLevel, modeLabel, stableHash, type ExecutionCheck, type ExecutionConfig } from "../shared/project-execution.ts";
import { sanitizeStoredProposal } from "../shared/project-manager.ts";
import {
  SCHEDULING_LIMITS,
  assessCost,
  defaultBatchPolicy,
  dependencyReadiness,
  deriveEntryState,
  findCycle,
  hasMarkdownDependencies,
  isActiveBatch,
  isStuckEntry,
  isTerminalBatch,
  launchFingerprint,
  launchesUsed,
  occupiesSlot,
  planTick,
  plannedOrder,
  previewKeyOf,
  QUEUE_AUTHORIZATION,
  queueOrderGuarantee,
  readBatchPolicy,
  sanitizeStoredBatch,
  spendingChecks,
  type BatchApprovedTask,
  type BatchSourceQueue,
  type BatchEntry,
  type BatchEntryState,
  type BatchEntryView,
  type BatchView,
  type BatchIssue,
  type BatchPreview,
  type BatchPreviewTask,
  type CostAssessment,
  type AutonomyView,
  type ExecutionBatch,
  type Readiness,
  type TaskPriority,
  type TickDecision,
} from "../shared/task-scheduling.ts";
import { DEFAULT_MODEL, defaultModeFor, type AgentKind, type Harness, type Run, type Task } from "../shared/types.ts";

export type BatchResult<T> =
  | { ok: true; value: T }
  | { ok: false; status: number; error: string; body?: Record<string, unknown> };

function fail<T>(status: number, error: string, body?: Record<string, unknown>): BatchResult<T> {
  return { ok: false, status, error, ...(body ? { body } : {}) };
}

export interface BatchDeps extends ExecutionDeps {
  now?: () => number;
}

/** Deps for ticks triggered by run events (tests inject fakes here). */
let eventDeps: BatchDeps = {};

const nowOf = (deps: BatchDeps) => (deps.now ?? taskAvailabilityNow)();

/* ────────────────────────────────────────────────────────────────────────── *
 * Storage.
 * ────────────────────────────────────────────────────────────────────────── */

function parse(raw: string | null): ExecutionBatch | null {
  if (raw == null) return null;
  try {
    return sanitizeStoredBatch(JSON.parse(raw));
  } catch {
    return null;
  }
}

function save(batch: ExecutionBatch, at = Date.now()): ExecutionBatch {
  batch.updatedAt = at;
  executionBatches.put({ id: batch.id, projectPath: batch.projectPath, status: batch.status, data: JSON.stringify(batch), createdAt: batch.createdAt });
  // Ids only: the Manager tab re-reads the batch, which stays the truth.
  broadcastAppEvent({ type: "execution_batch", projectPath: batch.projectPath, batchId: batch.id, status: batch.status, ts: Date.now() });
  return batch;
}

function record(batch: ExecutionBatch, kind: string, text: string, taskId: string | null = null, at = Date.now()): void {
  executionBatches.appendEvent(batch.id, kind, capText(text, SCHEDULING_LIMITS.eventTextChars), taskId, at);
}

/** True when a queue-sourced batch's approval no longer allows new starts. */
function authorizationExpired(batch: ExecutionBatch, now: number): boolean {
  return !!batch.sourceQueue && batch.approval?.expiresAt != null && now >= batch.approval.expiresAt;
}

/**
 * One Owner act on a queue-sourced batch, recorded in the Activity Journal.
 * Called inside the same transaction as the batch write, so the audit row and
 * the state it describes exist together or not at all; the key makes a replay
 * a no-op. Batches without a source queue write nothing.
 */
function journalQueueBatch(
  batch: ExecutionBatch,
  eventType: "queue.authorization.granted" | "queue.authorization.revoked",
  extra: Record<string, unknown>,
  keySuffix: string,
  at: number,
): void {
  const source = batch.sourceQueue;
  if (!source) return;
  new ActivityJournalCore(db).record({
    eventType,
    projectPath: batch.projectPath,
    actorType: "owner",
    actorId: "owner",
    targetType: "proposal",
    targetId: source.proposalId,
    idempotencyKey: `queue_batch:${batch.id}:${keySuffix}`,
    payload: { queueId: source.queueId, proposalId: source.proposalId, batchId: batch.id, taskIds: batch.entries.map((entry) => entry.taskId), ...extra },
    createdAt: at,
  });
}

function registered(rawPath: unknown): BatchResult<string> {
  const resolved = resolveProject(typeof rawPath === "string" ? rawPath : "");
  if (!resolved.ok) return fail(resolved.status, resolved.error);
  return { ok: true, value: resolved.path };
}

/* ────────────────────────────────────────────────────────────────────────── *
 * Process state: locks, stop requests, recovery.
 * ────────────────────────────────────────────────────────────────────────── */

const chains = new Map<string, Promise<unknown>>();
/** Pause/cancel requested while a tick holds the lock: no further launch. */
const stopRequested = new Set<string>();
/** Batches this process created or already recovered. */
const knownThisProcess = new Set<string>();
const tickQueued = new Set<string>();

function withLock<T>(id: string, fn: () => Promise<T>): Promise<T> {
  const prev = chains.get(id) ?? Promise.resolve();
  const run = prev.then(fn, fn);
  const tail = run.then(() => undefined, () => undefined);
  chains.set(id, tail);
  void tail.then(() => {
    if (chains.get(id) === tail) chains.delete(id);
  });
  return run;
}

/**
 * The first time this process sees a batch: adopt a start that was in
 * flight when the app closed (its run exists), or hold it as unconfirmed;
 * and bring a running batch back paused. Nothing is started here.
 */
function adopt(batch: ExecutionBatch): ExecutionBatch {
  if (knownThisProcess.has(batch.id)) return batch;
  knownThisProcess.add(batch.id);
  let changed = false;
  const now = Date.now();
  for (const entry of batch.entries) {
    if (!entry.launching) continue;
    changed = true;
    const { at, executionId } = entry.launching;
    entry.launching = null;
    const proposal = reconcileExecution(batch.projectPath, executionId);
    const run = runs.listForTask(entry.taskId)
      .filter((item) => item.startedAt >= at - 1000)
      .sort((a, b) => a.startedAt - b.startedAt)[0];
    const task = tasks.get(entry.taskId);
    const pipelineStarted = task?.pipelineRun?.startedAt != null && task.pipelineRun.startedAt >= at - 1000;
    if (proposal?.status === "started" || run || pipelineStarted) {
      entry.attempts.push({ at, executionId, runId: proposal?.runId ?? run?.id ?? null, outcome: "started", error: null });
      record(batch, "task-started", "A start that was in flight when the app closed was found running; adopted, not started again.", entry.taskId, now);
    } else {
      entry.attempts.push({ at, executionId, runId: null, outcome: "unconfirmed", error: null });
      entry.hold = {
        code: "unconfirmed",
        reason: "The app closed while this task was starting and its start can't be confirmed. Check the task, then release it to let the batch start it.",
        at: now,
        seen: false,
      };
      record(batch, "task-held", "Start unconfirmed after a restart; held until you release it.", entry.taskId, now);
    }
  }
  if (batch.status === "running") {
    changed = true;
    batch.status = "paused";
    batch.reason = { code: "restart", text: "ForgeOrbit restarted. The batch was paused; resume it to continue.", at: now };
    record(batch, "recovered", "Restored after a restart and paused. Nothing was started automatically.", null, now);
  }
  if (changed) save(batch, now);
  return batch;
}

function loadIn(projectPath: string, id: string): ExecutionBatch | null {
  const batch = parse(executionBatches.get(projectPath, id));
  return batch && batch.projectPath === projectPath ? adopt(batch) : null;
}

function locate(rawPath: unknown, id: string): BatchResult<ExecutionBatch> {
  const project = registered(rawPath);
  if (!project.ok) return project;
  const batch = loadIn(project.value, id);
  if (!batch) return fail(404, "Batch not found for this project.");
  return { ok: true, value: batch };
}

/** Boot: restore every unfinished batch (running ones come back paused). */
export function recoverExecutionBatches(): number {
  let count = 0;
  for (const raw of executionBatches.listByStatus(["approved", "running", "paused"])) {
    const batch = parse(raw);
    if (!batch || knownThisProcess.has(batch.id)) continue;
    adopt(batch);
    count += 1;
  }
  return count;
}

/* ────────────────────────────────────────────────────────────────────────── *
 * Configuration analysis.
 * ────────────────────────────────────────────────────────────────────────── */

function envNames(deps: BatchDeps): string[] {
  return deps.envNames ? deps.envNames() : Object.keys(process.env);
}

function costOf(harness: Harness | null, harnessId: string, deps: BatchDeps): CostAssessment {
  return assessCost(harness?.kind ?? null, harness?.label ?? harnessId, envNames(deps), Object.keys(harness?.env ?? {}));
}

function spendingFor(batch: ExecutionBatch, harnessId: string, harness: Harness | null, deps: BatchDeps): ExecutionCheck[] {
  return spendingChecks(batch.policy.spending, batch.policy.noOverageHarnessIds, {
    id: harnessId,
    label: harness?.label ?? harnessId,
    cost: costOf(harness, harnessId, deps),
  });
}

/* ────────────────────────────────────────────────────────────────────────── *
 * Preview.
 * ────────────────────────────────────────────────────────────────────────── */

interface Inspected {
  preview: BatchPreview;
  approved: Map<string, BatchApprovedTask>;
  configs: Map<string, ExecutionConfig>;
  spendingAccepted: string[];
}

function issue(level: ExecutionCheck["level"], code: string, message: string, taskId: string | null = null): BatchIssue {
  return { level, code, message: capText(message, 600), taskId };
}

/**
 * Check every task as a single supervised run would be checked, plus what
 * only a batch needs: its dependency links, the spending policy for every
 * harness it may use, overlap with other batches, and when it stops.
 */
async function inspect(batch: ExecutionBatch, deps: BatchDeps, freshAuth: boolean): Promise<Inspected> {
  const issues: BatchIssue[] = [];
  const previewTasks: BatchPreviewTask[] = [];
  const approved = new Map<string, BatchApprovedTask>();
  const configs = new Map<string, ExecutionConfig>();
  const inBatch = new Set(batch.entries.map((entry) => entry.taskId));
  const harnessModes = new Map<string, { harness: Harness | null; modes: Set<string> }>();
  const priorities = new Map<string, TaskPriority>();
  const liveDeps = new Map<string, string[]>();

  if (batch.entries.length === 0) issues.push(issue("error", "no-tasks", "The batch has no tasks."));

  for (const entry of [...batch.entries].sort((a, b) => a.order - b.order)) {
    const task = tasks.get(entry.taskId);
    const config = normalizeConfig(entry.config);
    configs.set(entry.taskId, config);
    const checked: Checked = await runChecks(batch.projectPath, task && taskInProject(task, batch.projectPath, { fresh: true }) ? task : null, config, deps, freshAuth);
    const dependsOn = taskScheduling.dependenciesOf(entry.taskId);
    liveDeps.set(entry.taskId, dependsOn);
    const priority = taskScheduling.priorityOf(entry.taskId);
    priorities.set(entry.taskId, priority);
    const agents = agentsOf(config);
    for (const agent of agents) {
      const slot = harnessModes.get(agent.harnessId) ?? { harness: agent.harness, modes: new Set<string>() };
      slot.modes.add(agent.harness ? modeLabel(agent.harness.kind, agent.mode) : agent.mode);
      harnessModes.set(agent.harnessId, slot);
    }
    const title = task?.title ?? entry.title;
    for (const check of checked.checks) {
      if (check.level === "error") issues.push(issue("error", `task:${check.code}`, `“${title}”: ${check.message}`, entry.taskId));
    }
    const depRows = dependsOn.map((id) => {
      const info = dependencyInfo(batch.projectPath, id);
      return { taskId: id, title: info.title, inBatch: inBatch.has(id), done: info.column === "done", info };
    });
    for (const gone of taskScheduling.tombstonesOf(entry.taskId)) {
      issues.push(issue("error", "dependency-deleted", `“${title}” waited for “${gone.title}”, which was deleted. Clear that link on the task before approving.`, entry.taskId));
    }
    for (const dep of depRows) {
      if (!dep.info.exists || !dep.info.inProject) {
        issues.push(issue("error", "dependency-invalid", `“${title}” depends on “${dep.title}”, which isn't a task of this project.`, entry.taskId));
      } else if (!dep.inBatch && !dep.done) {
        issues.push(issue("warning", "dependency-outside", `“${title}” waits for “${dep.title}”, which isn't in this batch. It starts only once that task is Done.`, entry.taskId));
      }
    }
    if (task && dependsOn.length === 0 && hasMarkdownDependencies(task.prompt)) {
      issues.push(issue("warning", "markdown-dependencies", `“${title}” lists dependencies only in its description. They aren't used for scheduling; link the real tasks first if the order matters.`, entry.taskId));
    }
    if (task) {
      const others = activeBatchesFor(batch.projectPath, task.id).filter((id) => id !== batch.id);
      if (others.length > 0) issues.push(issue("error", "task-in-other-batch", `“${title}” is already in another approved batch. Cancel that batch first.`, entry.taskId));
    }
    const harnessIds = [...new Set(agents.map((agent) => agent.harnessId))];
    const accessLevel = accessLevelOf(config);
    {
      const early = quotaHold(batch, entry, task ?? null, deps);
      if (early) issues.push(issue("warning", "quota-blocked", `“${title}”: ${early.reason} Approving doesn't override this: it is checked again before every start.`, entry.taskId));
    }
    if (batch.sourceQueue && (accessLevel >= 4 || checked.resolved.permission?.sandbox === "danger-full-access")) {
      issues.push(issue("warning", "queue-full-access", `“${title}” would run with full access (no sandbox, your user's permissions). A batch prepared from a queue starts it only if you acknowledge that task by name when approving.`, entry.taskId));
    }
    previewTasks.push({
      taskId: entry.taskId,
      title,
      order: entry.order,
      priority,
      column: task?.column ?? null,
      dependsOn: depRows.map(({ info: _info, ...row }) => row),
      config,
      harnessLabel: checked.resolved.harnessLabel,
      harnessKind: checked.resolved.harnessKind,
      modelLabel: checked.resolved.modelLabel,
      modeLabel: checked.resolved.modeLabel,
      accessLevel,
      profileName: checked.resolved.profileName,
      pipelineName: checked.resolved.pipelineName,
      pipelineSteps: checked.resolved.pipelineSteps,
      workspace: checked.resolved.workspace,
      isolation: checked.resolved.isolation,
      harnessIds,
      checks: checked.checks,
    });
    if (task) {
      approved.set(entry.taskId, { fingerprint: launchFingerprint(task), signature: executionSignature(config), dependsOn, accessLevel, harnessIds });
    }
  }

  const edges = batch.entries.flatMap((entry) => (liveDeps.get(entry.taskId) ?? []).map((dependsOn) => ({ taskId: entry.taskId, dependsOn })));
  const cycle = findCycle(edges);
  if (cycle) issues.push(issue("error", "dependency-cycle", `The tasks' dependencies form a cycle (${cycle.map((id) => id.slice(0, 8)).join(" → ")}).`));
  for (const note of batch.mappingNotes) {
    issues.push(issue("warning", "dependency-mapping-required", `“${note.title}” was proposed with dependencies (${note.mentioned.join(", ")}) that aren't linked to real tasks. Link them, or accept that they don't control the order.`, note.taskId));
  }

  const harnessSummary: BatchPreview["harnesses"] = [];
  const spendingAccepted: string[] = [];
  const spendingHarnessIds = new Set<string>();
  for (const task of previewTasks) {
    if (task.checks.some((check) => check.code === "paid-api")) for (const id of task.harnessIds) spendingHarnessIds.add(id);
  }
  for (const [harnessId, { harness, modes }] of [...harnessModes.entries()].sort(([a], [b]) => a.localeCompare(b))) {
    const cost = costOf(harness, harnessId, deps);
    harnessSummary.push({ id: harnessId, label: harness?.label ?? harnessId, kind: (harness?.kind ?? null) as AgentKind | null, modes: [...modes], cost });
    for (const check of spendingFor(batch, harnessId, harness, deps)) {
      issues.push(issue(check.level, check.code, check.message));
      if (check.level === "warning") {
        spendingAccepted.push(`${harnessId}:${check.code}`);
        spendingHarnessIds.add(harnessId);
      }
    }
  }

  const policy = batch.policy;
  if (policy.maxStarts < batch.entries.length) {
    issues.push(issue("warning", "start-limit-low", `The batch may start at most ${policy.maxStarts} times, fewer than its ${batch.entries.length} tasks.`));
  }
  if (policy.maxParallel > 1 && previewTasks.some((task) => task.isolation !== "worktree")) {
    issues.push(issue("warning", "parallel-shared-folder", "Some tasks run directly in the project folder, without a worktree. Running them in parallel can make them edit the same files."));
  }
  issues.push(issue("info", "limits-unknown", "ForgeOrbit can't see any account's remaining limits. The batch may stop before every task has run; it never promises to finish."));
  issues.push(issue("info", "no-account-switch", "Each task runs on the harness shown. If one is unavailable, the task waits; the batch never switches to another account or harness."));
  issues.push(issue("info", "no-push", "Nothing is pushed or merged. Changes stay local until you commit or push them yourself."));

  const stopConditions = [
    "Every task is Done (accepted by you).",
    `${policy.maxStarts} agent start${policy.maxStarts === 1 ? "" : "s"} used (retries included).`,
    policy.maxDurationMinutes ? `${policy.maxDurationMinutes} minutes after Start: no new task starts.` : "No time limit.",
    policy.onFailure === "pause" ? "A task fails, is stopped, or can't start: the batch pauses for you." : "A task fails: tasks that depend on it wait; the rest continue.",
    policy.reviewPolicy === "wait-for-review"
      ? "A finished task waits for your review; nothing new starts until you accept it."
      : "A finished task waits for your review; independent tasks keep starting, dependent ones wait.",
    "You pause or cancel it. Running agents keep running unless you stop them.",
    "ForgeOrbit restarts: the batch comes back paused.",
  ];

  const isDone = (id: string) => tasks.get(id)?.column === "done";
  const order = plannedOrder(batch.entries, (id) => liveDeps.get(id) ?? [], priorities, isDone);
  const needsSpendingAck = spendingHarnessIds.size > 0;
  const canApprove = !issues.some((item) => item.level === "error");
  const key = previewKeyOf({
    tasks: previewTasks.map((task) => [task.taskId, task.order, task.priority, task.config, task.accessLevel, task.harnessIds,
      task.dependsOn.map((dep) => [dep.taskId, dep.done]), task.checks.map((check) => [check.level, check.code, check.message]),
      approved.get(task.taskId) ?? null]),
    issues: issues.map((item) => [item.level, item.code, item.message, item.taskId]),
    harnesses: harnessSummary,
    policy,
  });
  return {
    preview: {
      key,
      checkedAt: Date.now(),
      tasks: previewTasks,
      harnesses: harnessSummary,
      issues,
      order,
      stopConditions,
      canApprove,
      needsSpendingAck,
      spendingHarnessIds: [...spendingHarnessIds].sort(),
    },
    approved,
    configs,
    spendingAccepted,
  };
}

/* ────────────────────────────────────────────────────────────────────────── *
 * Views.
 * ────────────────────────────────────────────────────────────────────────── */

interface Snapshot {
  states: Map<string, BatchEntryState>;
  readiness: Map<string, Readiness>;
  priorities: Map<string, TaskPriority>;
  scheduledWait: Map<string, number>;
}

function dependsOnFor(entry: BatchEntry): string[] {
  const frozen = entry.approved?.dependsOn ?? taskScheduling.dependenciesOf(entry.taskId);
  // A deleted prerequisite keeps blocking, whatever the frozen list says.
  const deleted = taskScheduling.tombstonesOf(entry.taskId).map((row) => row.missingId).filter((id) => !frozen.includes(id));
  return [...frozen, ...deleted];
}

/** `skip`: tasks this tick already tried and couldn't start; read as
 *  external so the scheduler picks something else. */
function snapshot(batch: ExecutionBatch, skip: ReadonlySet<string> = new Set(), now: number = taskAvailabilityNow()): Snapshot {
  const states = new Map<string, BatchEntryState>();
  const priorities = new Map<string, TaskPriority>();
  const scheduledWait = new Map<string, number>();
  for (const entry of batch.entries) {
    const task = tasks.get(entry.taskId);
    const availability = task ? taskAvailabilityFor(task, now) : null;
    if (availability && !availability.available) {
      scheduledWait.set(entry.taskId, availability.availableFromMs ?? Number.POSITIVE_INFINITY);
    }
    const lastStarted = [...entry.attempts].reverse().find((attempt) => attempt.outcome === "started");
    const ownRun = lastStarted?.runId ? runs.get(lastStarted.runId) : null;
    states.set(entry.taskId, deriveEntryState(entry, {
      exists: !!task,
      inProject: !!task && taskInProject(task, batch.projectPath),
      column: task?.column ?? null,
      archived: task?.archivedAt != null,
      live: !!task && (isTaskRunLive(task.id) || task.pipelineRun?.status === "running"),
      runId: task?.runId ?? null,
      pipelineStatus: task?.pipelineId ? task.pipelineRun?.status ?? null : null,
      ownRunStatus: ownRun?.status ?? null,
      claimed: false,
    }));
    if (skip.has(entry.taskId) && states.get(entry.taskId) === "pending") states.set(entry.taskId, "external");
    priorities.set(entry.taskId, taskScheduling.priorityOf(entry.taskId));
  }
  const byId = new Map(batch.entries.map((entry) => [entry.taskId, entry]));
  const readiness = new Map<string, Readiness>();
  for (const entry of batch.entries) {
    readiness.set(entry.taskId, dependencyReadiness(
      dependsOnFor(entry),
      (id) => dependencyInfo(batch.projectPath, id),
      (id) => {
        const other = byId.get(id);
        if (!other) return null;
        const state = states.get(id) ?? "pending";
        return { state, stuck: isStuckEntry(state, other, batch.policy) };
      },
    ));
  }
  return { states, readiness, priorities, scheduledWait };
}

function decide(batch: ExecutionBatch, snap: Snapshot, now: number): TickDecision {
  // A live grant may narrow the batch's parallelism ("a grant can only narrow that"). The scheduler plans with
  // the narrower value, so it waits for a slot instead of attempting a start the Run guard would refuse and
  // pausing the batch over ordinary throttling.
  const grant = batch.autonomy;
  const policy = grant && grant.status === "active" && grant.maxParallelism < batch.policy.maxParallel
    ? { ...batch.policy, maxParallel: grant.maxParallelism }
    : batch.policy;
  return planTick({
    status: batch.status,
    policy,
    entries: batch.entries,
    states: snap.states,
    priorities: snap.priorities,
    readiness: snap.readiness,
    scheduledWait: snap.scheduledWait,
    now,
    deadlineAt: batch.deadlineAt,
  });
}

function sameList(a: readonly string[], b: readonly string[]): boolean {
  const x = [...a].sort();
  const y = [...b].sort();
  return x.length === y.length && x.every((id, i) => id === y[i]);
}

function viewOf(batch: ExecutionBatch): BatchView {
  const snap = snapshot(batch);
  const counts: Partial<Record<BatchEntryState, number>> = {};
  const entries = batch.entries.map((entry): BatchEntryView => {
    const state = snap.states.get(entry.taskId) ?? "pending";
    counts[state] = (counts[state] ?? 0) + 1;
    const task = tasks.get(entry.taskId);
    const lastStarted = [...entry.attempts].reverse().find((attempt) => attempt.outcome === "started");
    const steps = task?.pipelineRun?.snapshot?.graph.steps ?? [];
    return {
      ...entry,
      runStatus: lastStarted?.runId ? runs.get(lastStarted.runId)?.status ?? null : null,
      pipeline: task?.pipelineId && task.pipelineRun
        ? { status: task.pipelineRun.status, activeSteps: task.pipelineRun.active.map((item) => steps.find((step) => step.id === item.stepId)?.name ?? item.stepId) }
        : null,
      state,
      readiness: snap.readiness.get(entry.taskId) ?? { state: "ready" },
      priority: snap.priorities.get(entry.taskId) ?? "normal",
      column: task?.column ?? null,
      currentTitle: task?.title ?? null,
      dependenciesChanged: entry.approved != null && !sameList(entry.approved.dependsOn, taskScheduling.dependenciesOf(entry.taskId)),
      runId: task?.runId ?? null,
    };
  });
  const ownedLive = entries.filter((entry) => entry.state === "running" || entry.state === "waiting").map((entry) => entry.taskId);
  return {
    ...batch,
    entries,
    counts,
    launchesUsed: launchesUsed(batch.entries),
    next: batch.status === "running" ? decide(batch, snap, Date.now()) : null,
    ownedLive,
    queueOrder: batch.sourceQueue
      ? queueOrderGuarantee(batch.entries.filter((entry) => !entry.attempts.some((attempt) => attempt.outcome === "started")).map((entry) => snap.priorities.get(entry.taskId) ?? "normal"), batch.policy.maxParallel)
      : null,
    authorizationExpired: authorizationExpired(batch, Date.now()),
    autonomyView: autonomyViewOf(batch, entries.filter((entry) => entry.state === "running" || entry.state === "waiting").map((entry) => entry.taskId)),
  };
}

/* ────────────────────────────────────────────────────────────────────────── *
 * Scheduling: one tick.
 * ────────────────────────────────────────────────────────────────────────── */

const OBSERVED_EVENTS: Partial<Record<BatchEntryState, string>> = {
  running: "Running.",
  waiting: "Waiting for your answer.",
  review: "Finished. Waiting for your review.",
  done: "Done.",
  failed: "Failed.",
  cancelled: "Stopped.",
  missing: "The task was deleted, archived or moved out of the project.",
  external: "Started from outside the batch; the batch won't start it.",
};

function observe(batch: ExecutionBatch, snap: Snapshot, now: number): boolean {
  let changed = false;
  for (const entry of batch.entries) {
    const state = snap.states.get(entry.taskId) ?? "pending";
    if (state === entry.observed) continue;
    const text = OBSERVED_EVENTS[state];
    if (text) record(batch, `task-${state}`, `“${entry.title}”: ${text}`, entry.taskId, now);
    entry.observed = state;
    changed = true;
  }
  return changed;
}

/** Synchronous checks before a launch: what approval froze still holds. */
function preLaunchHold(batch: ExecutionBatch, entry: BatchEntry): { code: string; reason: string } | null {
  const approval = batch.approval;
  const approved = entry.approved;
  if (!approval || !approved) return { code: "not-approved", reason: "This task wasn't part of the approval." };
  if (authorizationExpired(batch, Date.now())) return { code: "authorization-expired", reason: "The approval for this batch expired. Cancel it and prepare a new one." };
  if (!sameList(approved.dependsOn, taskScheduling.dependenciesOf(entry.taskId))) {
    return { code: "dependencies-changed", reason: "Its dependency links changed since the batch was approved." };
  }
  for (const id of approved.dependsOn) {
    const dep = dependencyInfo(batch.projectPath, id, { fresh: true });
    if (!dep.exists || !dep.inProject) return { code: "dependency-invalid", reason: `Its dependency “${dep.title}” is no longer a task of this project.` };
  }
  const gone = taskScheduling.tombstonesOf(entry.taskId)[0];
  if (gone) return { code: "dependency-deleted", reason: `Its prerequisite “${gone.title}” was deleted and the link has not been cleared.` };
  const config = normalizeConfig(entry.config);
  if (executionSignature(config) !== approved.signature) {
    return { code: "configuration-changed", reason: "Its agent configuration (harness, model, mode, profile or pipeline) changed since the batch was approved." };
  }
  for (const agent of agentsOf(config)) {
    if (!approval.allowedHarnessIds.includes(agent.harnessId)) return { code: "harness-not-allowed", reason: `Harness ${agent.harnessId} wasn't approved for this batch.` };
  }
  if (config.profileId && !approval.allowedProfileIds.includes(config.profileId)) return { code: "profile-not-allowed", reason: "Its agent profile wasn't approved for this batch." };
  if (config.pipelineId && !approval.allowedPipelineIds.includes(config.pipelineId)) return { code: "pipeline-not-allowed", reason: "Its pipeline wasn't approved for this batch." };
  const access = accessLevelOf(config);
  if (access > approved.accessLevel || access > approval.maxAccessLevel) {
    return { code: "access-broadened", reason: "It would run with broader permissions than were approved." };
  }
  return autonomyHold(batch, entry);
}

/** The bounded grant's verdict for a start of this entry (FO-ORCH08). Manual batches have none. */
function autonomyHold(batch: ExecutionBatch, entry: BatchEntry): { code: string; reason: string } | null {
  if (!batch.autonomy) return null;
  const verdict = checkGrantForBatch(batch, entry.taskId, "batch");
  return verdict.allowed ? null : { code: `autonomy:${verdict.code}`, reason: verdict.reason };
}

/**
 * AccountCore / router eligibility for every agent this task runs as (FO-ORCH07.1).
 * The same decision Employee preflight uses. Only CONFIRMED exhaustion, denial,
 * an unavailable or unsupported resource, a disabled harness or an Owner
 * prohibition blocks; Unknown, stale and unverified evidence never does, and
 * never counts as available. Nothing is switched, retried or substituted.
 */
function quotaHold(batch: ExecutionBatch, entry: BatchEntry, task: Task | null, deps: BatchDeps): { code: string; reason: string } | null {
  if (!task) return null;
  const verdict = configEligibility({ task, projectPath: batch.projectPath, config: normalizeConfig(entry.config), now: nowOf(deps) });
  if (!verdict) return null;
  return { code: `quota:${verdict.code}`, reason: `${eligibilityRefusal(verdict)} Resolve it, then release the task to check again.` };
}

/** Checks inside the launch, after the supervised checks passed. */
function launchVerifier(batch: ExecutionBatch, entry: BatchEntry, deps: BatchDeps) {
  return (checked: Checked, task: Task): { code: string; reason: string } | null => {
    if (batch.autonomy) {
      // Asked again inside the transaction that records the run, against the
      // stored batch (saved before every launch), so nothing can slip in between.
      const verdict = checkAutonomousRun(task.id, "batch");
      if (!verdict.allowed) return { code: `autonomy:${verdict.code}`, reason: verdict.reason };
      const permission = checked.resolved.permission;
      if (permission && (permission.sandbox === "danger-full-access" || permission.launchAllowed === false)) {
        return { code: "autonomy:mode-not-allowed", reason: permission.blockReason ?? "It would run without a sandbox, which a bounded grant never allows." };
      }
    }
    if (batch.sourceQueue) {
      const full = accessLevelOf(normalizeConfig(entry.config)) >= 4 || checked.resolved.permission?.sandbox === "danger-full-access";
      if (full && !(batch.approval?.fullAccessTaskIds ?? []).includes(task.id)) {
        return { code: "full-access-not-acknowledged", reason: "It would run with full access, which wasn't acknowledged for this task when the batch was approved." };
      }
    }
    for (const id of entry.approved?.dependsOn ?? []) {
      if (tasks.get(id)?.column !== "done") return { code: "dependency-not-done", reason: "A dependency is no longer Done." };
    }
    // Re-checked fresh right before a launch (FO-008D): ownership, the real
    // folder and the task's own worktree, not just what the list showed.
    const scope = verifyLaunchScope(task, batch.projectPath);
    if (!scope.ok) {
      return scope.code === "task-outside-project"
        ? { code: "task-moved", reason: "The task moved to another project." }
        : { code: `scope:${scope.code}`, reason: scope.reason };
    }
    const accepted = new Set(batch.approval?.spendingAccepted ?? []);
    for (const agent of agentsOf(normalizeConfig(entry.config))) {
      for (const check of spendingFor(batch, agent.harnessId, agent.harness, deps)) {
        if (check.level === "error") return { code: `spending:${check.code}`, reason: check.message };
        if (check.level === "warning" && !accepted.has(`${agent.harnessId}:${check.code}`)) {
          return { code: "spending-changed", reason: `A spending notice appeared that wasn't approved: ${check.message}` };
        }
      }
    }
    // Asked again right before the run is recorded: this verifier also runs inside
    // the transaction that creates the run, so evidence can't change in between.
    return quotaHold(batch, entry, task, deps);
  };
}

async function launchEntry(batch: ExecutionBatch, entry: BatchEntry, deps: BatchDeps): Promise<"started" | "start-failed" | "held" | "busy"> {
  const now = nowOf(deps);
  const currentTask = tasks.get(entry.taskId);
  const scheduled = currentTask ? taskAvailabilityFor(currentTask, now) : null;
  if (scheduled && !scheduled.available) {
    return "busy";
  }
  const hold = preLaunchHold(batch, entry);
  if (hold) {
    entry.hold = { ...hold, at: now, seen: false };
    record(batch, "task-held", `“${entry.title}” can't start: ${hold.reason}`, entry.taskId, now);
    if (hold.code.startsWith("autonomy:")) autonomyDenied(batch, hold.code.slice("autonomy:".length), hold.reason, "batch", entry.taskId, now);
    save(batch);
    return "held";
  }
  const executionId = crypto.randomUUID();
  entry.launching = { at: now, executionId };
  save(batch);
  const outcome = await withAutonomyOrigin("batch", () => launchBatchTask({
    projectPath: batch.projectPath,
    taskId: entry.taskId,
    batchId: batch.id,
    batchTitle: batch.title,
    executionId,
    config: entry.config,
    expectFingerprint: entry.appliedFingerprint ?? entry.approved!.fingerprint,
    fingerprintOf: launchFingerprint,
    verify: launchVerifier(batch, entry, deps),
  }, deps)).catch((err): Awaited<ReturnType<typeof launchBatchTask>> => {
    if (err instanceof AutonomyRefusedError) return { kind: "held", code: `autonomy:${err.code}`, reason: err.reason };
    throw err;
  });
  const end = nowOf(deps);
  entry.launching = null;
  switch (outcome.kind) {
    case "started":
      entry.attempts.push({ at: now, executionId: outcome.executionId, runId: outcome.runId, outcome: "started", error: null });
      entry.appliedFingerprint = outcome.appliedFingerprint;
      entry.observed = "running";
      record(batch, "task-started", `Started “${entry.title}” (attempt ${entry.attempts.length}).`, entry.taskId, end);
      break;
    case "start-failed":
      entry.attempts.push({ at: now, executionId: outcome.executionId, runId: null, outcome: "start-failed", error: outcome.error });
      entry.observed = "failed";
      record(batch, "task-start-failed", `“${entry.title}” couldn't start: ${outcome.error}`, entry.taskId, end);
      break;
    case "held":
      if (outcome.code === "scheduled-not-yet-available") {
        save(batch, end);
        return "busy";
      }
      entry.hold = { code: outcome.code, reason: outcome.reason, at: end, seen: false };
      record(batch, "task-held", `“${entry.title}” can't start: ${outcome.reason}`, entry.taskId, end);
      if (outcome.code.startsWith("autonomy:")) autonomyDenied(batch, outcome.code.slice("autonomy:".length), outcome.reason, "batch", entry.taskId, end);
      break;
    case "busy":
      record(batch, "task-skipped", `“${entry.title}” wasn't started: ${outcome.reason}`, entry.taskId, end);
      break;
  }
  save(batch, end);
  return outcome.kind;
}

function finish(batch: ExecutionBatch, status: "completed" | "stopped", text: string, code: string, now: number): void {
  batch.status = status;
  batch.finishedAt = now;
  batch.reason = status === "stopped" ? { code, text, at: now } : null;
  record(batch, status, text, null, now);
  save(batch, now);
  appendManagerSystemMessage(batch.projectPath, `Batch “${batch.title}”: ${text}`);
}

async function tickLocked(id: string, deps: BatchDeps): Promise<void> {
  const skip = new Set<string>();
  for (let round = 0; round < SCHEDULING_LIMITS.batchTasks + 4; round++) {
    const raw = parse(executionBatches.getAny(id));
    if (!raw) return;
    const batch = adopt(raw);
    if (batch.status !== "running" || stopRequested.has(id)) return;
    const now = nowOf(deps);
    if (authorizationExpired(batch, now)) {
      batch.status = "paused";
      batch.reason = { code: "authorization-expired", text: "The approval for this batch expired. No new task starts; running agents keep running.", at: now };
      record(batch, "paused", batch.reason.text, null, now);
      save(batch, now);
      appendManagerSystemMessage(batch.projectPath, `Batch “${batch.title}” paused: its approval expired.`);
      return;
    }
    const snap = snapshot(batch, skip, now);
    const observed = observe(batch, snapshot(batch, new Set(), now), now);
    const decision = decide(batch, snap, now);
    if (enforceGrant(batch, decision.kind, now)) return;
    switch (decision.kind) {
      case "complete":
        finish(batch, "completed", "Every task is Done.", "completed", now);
        return;
      case "stop":
        finish(batch, "stopped", decision.text, decision.code, now);
        return;
      case "pause":
        batch.status = "paused";
        batch.reason = { code: decision.code, text: decision.text, at: now };
        record(batch, "paused", decision.text, null, now);
        save(batch, now);
        appendManagerSystemMessage(batch.projectPath, `Batch “${batch.title}” paused: ${decision.text}`);
        return;
      case "idle":
        if (observed) save(batch, now);
        scheduleBatchAvailabilityWake(batch.id, snap.scheduledWait, now);
        return;
      case "start": {
        const lifecycle = checkProjectLaunchAdmission(batch.projectPath);
        if (!lifecycle.allowed) {
          batch.status = "paused";
          batch.reason = { code: "project-paused", text: lifecycle.reason!, at: now };
          record(batch, "paused", lifecycle.reason!, null, now);
          save(batch, now);
          appendManagerSystemMessage(batch.projectPath, `Batch “${batch.title}” paused: ${lifecycle.reason}`);
          return;
        }
        for (const taskId of decision.taskIds) {
          if (stopRequested.has(id)) break;
          const entry = batch.entries.find((item) => item.taskId === taskId)!;
          const outcome = await launchEntry(batch, entry, deps);
          if (outcome === "busy") skip.add(taskId);
        }
        // Re-plan: a start that failed or was held may free a slot.
        continue;
      }
    }
  }
}

/** Run one scheduling pass for a batch, queued behind its other mutations. */
export function requestTick(id: string, deps: BatchDeps = eventDeps): Promise<void> {
  if (tickQueued.has(id)) return chains.get(id)?.then(() => undefined) ?? Promise.resolve();
  tickQueued.add(id);
  return withLock(id, async () => {
    tickQueued.delete(id);
    await tickLocked(id, deps);
  });
}

/* ────────────────────────────────────────────────────────────────────────── *
 * Drafts.
 * ────────────────────────────────────────────────────────────────────────── */

function projectTasks(projectPath: string, ids: unknown): BatchResult<Task[]> {
  if (!Array.isArray(ids) || ids.some((id) => typeof id !== "string" || !id)) return fail(400, "taskIds must be a list of task ids.");
  const unique = [...new Set(ids as string[])];
  if (unique.length === 0) return fail(400, "Pick at least one task.");
  if (unique.length > SCHEDULING_LIMITS.batchTasks) return fail(400, `A batch holds at most ${SCHEDULING_LIMITS.batchTasks} tasks.`);
  const out: Task[] = [];
  for (const id of unique) {
    const task = tasks.get(id);
    // Another project's task reads as missing, so ids can't be probed.
    if (!task || !taskInProject(task, projectPath, { fresh: true })) return fail(404, `Task ${id.slice(0, 8)} not found in this project.`);
    if (task.pipelineParentId) return fail(409, `“${task.title}” is a step of a pipeline run. Add the pipeline task instead.`);
    out.push(task);
  }
  return { ok: true, value: out };
}

function entryFor(task: Task, order: number): BatchEntry {
  return {
    taskId: task.id,
    title: task.title,
    order,
    config: normalizeConfig(configFromTask(task)),
    approved: null,
    appliedFingerprint: null,
    attempts: [],
    launching: null,
    hold: null,
    failureSeen: 0,
    observed: null,
  };
}

function titleOf(value: unknown, fallback: string): string {
  const text = typeof value === "string" ? value.replace(/\s+/g, " ").trim() : "";
  return capText(text || fallback, SCHEDULING_LIMITS.titleChars);
}

async function refreshPreview(batch: ExecutionBatch, deps: BatchDeps, freshAuth = false): Promise<void> {
  batch.preview = (await inspect(batch, deps, freshAuth)).preview;
}

interface DraftInput {
  taskIds: unknown;
  title?: unknown;
  policy?: unknown;
  sourceProposalId?: string | null;
  sourceQueue?: BatchSourceQueue | null;
  mappingNotes?: ExecutionBatch["mappingNotes"];
  /** Runs inside the transaction that stores the draft. */
  afterSave?: (batch: ExecutionBatch) => void;
}

async function createDraft(projectPath: string, input: DraftInput, deps: BatchDeps): Promise<BatchResult<BatchView>> {
  const found = projectTasks(projectPath, input.taskIds);
  if (!found.ok) return found;
  const policy = readBatchPolicy(input.policy, defaultBatchPolicy(found.value.length));
  if (typeof policy === "string") return fail(400, policy);
  const now = nowOf(deps);
  const batch: ExecutionBatch = {
    id: crypto.randomUUID(),
    projectPath,
    title: titleOf(input.title, found.value.length === 1 ? found.value[0]!.title : `${found.value.length} tasks`),
    status: "draft",
    revision: 1,
    entries: found.value.map((task, index) => entryFor(task, index)),
    policy,
    preview: null,
    approval: null,
    reason: null,
    sourceProposalId: input.sourceProposalId ?? null,
    sourceQueue: input.sourceQueue ?? null,
    mappingNotes: input.mappingNotes ?? [],
    createdAt: now,
    updatedAt: now,
    startedAt: null,
    deadlineAt: null,
    finishedAt: null,
  };
  knownThisProcess.add(batch.id);
  await refreshPreview(batch, deps);
  db.transaction(() => {
    save(batch, now);
    record(batch, "created", `Draft with ${batch.entries.length} task${batch.entries.length === 1 ? "" : "s"}. Nothing runs until you approve and start it.`, null, now);
    input.afterSave?.(batch);
  })();
  return { ok: true, value: viewOf(batch) };
}

/**
 * A draft batch prepared from a Task Queue (FO-ORCH07). The caller has already
 * verified the queue, its plan key and each task; this stores the draft with
 * its provenance in the Owner's queue order. It starts, assigns and approves
 * nothing: the batch still needs the Owner's own approve and start.
 */
export async function createQueueBatch(
  projectPath: string,
  input: { taskIds: string[]; title?: unknown; policy?: unknown; sourceQueue: BatchSourceQueue; afterSave?: (batch: ExecutionBatch) => void },
  deps: BatchDeps = {},
): Promise<BatchResult<BatchView>> {
  return createDraft(projectPath, { taskIds: input.taskIds, title: input.title, policy: input.policy, sourceQueue: input.sourceQueue, afterSave: input.afterSave }, deps);
}

/** Batches prepared from one queue, newest first (any status). */
export function batchesOfQueue(projectPath: string, queueId: string): ExecutionBatch[] {
  return executionBatches.list(projectPath, SCHEDULING_LIMITS.batchesListed)
    .map(parse)
    .filter((batch): batch is ExecutionBatch => batch != null && batch.projectPath === projectPath && batch.sourceQueue?.queueId === queueId)
    .map(adopt);
}

/** The full view of a stored batch, for read models outside this module. */
export function batchView(batch: ExecutionBatch): BatchView {
  return viewOf(batch);
}

/** A draft batch from tasks of the project. Starts nothing. */
export async function createBatch(
  rawPath: unknown,
  body: { taskIds?: unknown; title?: unknown; policy?: unknown },
  deps: BatchDeps = {},
): Promise<BatchResult<BatchView>> {
  const project = registered(rawPath);
  if (!project.ok) return project;
  return createDraft(project.value, { taskIds: body.taskIds, title: body.title, policy: body.policy }, deps);
}

/**
 * A draft batch from the tasks an approved task proposal created or linked.
 * Approving the proposal never did this, and this never starts anything.
 * Dependencies the proposal named that aren't structured links (proposals
 * approved before structured dependencies existed, or links the owner
 * removed) are listed for manual mapping instead of being guessed.
 */
export async function createBatchFromProposal(
  rawPath: unknown,
  proposalId: string,
  body: { title?: unknown; policy?: unknown },
  deps: BatchDeps = {},
): Promise<BatchResult<BatchView>> {
  const project = registered(rawPath);
  if (!project.ok) return project;
  let parsed: unknown = null;
  try {
    parsed = JSON.parse(projectManagers.getProposal(project.value, proposalId) ?? "null");
  } catch {
    parsed = null;
  }
  const proposal = sanitizeStoredProposal(parsed);
  if (!proposal || proposal.projectPath !== project.value) return fail(404, "Proposal not found for this project.");
  if (proposal.status !== "approved" && proposal.status !== "partial") return fail(409, "Approve the task proposal first. Approving it doesn't start anything either.");
  const taskIds: string[] = [];
  const mappingNotes: ExecutionBatch["mappingNotes"] = [];
  for (const item of proposal.items) {
    const taskId = item.result && (item.result.status === "created" || item.result.status === "linked") ? item.result.taskId : null;
    if (!taskId || taskIds.includes(taskId)) continue;
    const task = tasks.get(taskId);
    if (!task || !taskInProject(task, project.value, { fresh: true }) || task.archivedAt != null || task.column === "done") continue;
    taskIds.push(taskId);
    const live = taskScheduling.dependenciesOf(taskId);
    const missing: string[] = [];
    for (const dep of item.dependsOn) {
      if (dep.kind === "task") {
        if (!live.includes(dep.taskId)) missing.push(dep.title);
        continue;
      }
      const target = proposal.items.find((other) => other.id === dep.itemId);
      const targetTask = target?.result && (target.result.status === "created" || target.result.status === "linked") ? target.result.taskId : null;
      if (!targetTask || !live.includes(targetTask)) missing.push(target?.title ?? dep.itemId);
    }
    if (missing.length > 0) mappingNotes.push({ taskId, title: task.title, mentioned: missing });
  }
  if (taskIds.length === 0) return fail(409, "None of the proposal's tasks is left to run.");
  return createDraft(project.value, {
    taskIds,
    title: body.title ?? proposal.title,
    policy: body.policy,
    sourceProposalId: proposal.id,
    mappingNotes,
  }, deps);
}

function parseRevision(value: unknown): number | null {
  return typeof value === "number" && Number.isInteger(value) && value > 0 ? value : null;
}

/**
 * Edit a draft: its tasks, their configuration, the policy, the title.
 * Refused once approved — an approved batch's scope never grows.
 */
export async function updateBatch(
  rawPath: unknown,
  id: string,
  body: { revision?: unknown; taskIds?: unknown; configs?: unknown; policy?: unknown; title?: unknown },
  deps: BatchDeps = {},
): Promise<BatchResult<BatchView>> {
  const located = locate(rawPath, id);
  if (!located.ok) return located;
  return withLock(id, async () => {
    const batch = loadIn(located.value.projectPath, id)!;
    if (batch.status !== "draft") {
      return fail<BatchView>(409, "An approved batch can't be changed. Cancel it and prepare a new one.", { batch: viewOf(batch) });
    }
    if (parseRevision(body.revision) !== batch.revision) {
      return fail<BatchView>(409, "The batch changed since you opened it. Review it again.", { batch: viewOf(batch) });
    }
    const changes: string[] = [];
    if (body.taskIds !== undefined) {
      const found = projectTasks(batch.projectPath, body.taskIds);
      if (!found.ok) return found;
      const previous = new Map(batch.entries.map((entry) => [entry.taskId, entry]));
      batch.entries = found.value.map((task, index) => {
        const kept = previous.get(task.id);
        return kept ? { ...kept, order: index } : entryFor(task, index);
      });
      batch.mappingNotes = batch.mappingNotes.filter((note) => previous.has(note.taskId) && batch.entries.some((entry) => entry.taskId === note.taskId));
      changes.push("tasks");
    }
    if (body.configs !== undefined) {
      if (!body.configs || typeof body.configs !== "object" || Array.isArray(body.configs)) return fail<BatchView>(400, "configs must map task ids to configurations.");
      for (const [taskId, value] of Object.entries(body.configs as Record<string, unknown>)) {
        const entry = batch.entries.find((item) => item.taskId === taskId);
        if (!entry) return fail<BatchView>(400, `Task ${taskId.slice(0, 8)} isn't in this batch.`);
        const read = readConfig(value, entry.config);
        if (typeof read === "string") return fail<BatchView>(400, read);
        if (read.profileId && !agentProfiles.get(read.profileId)) return fail<BatchView>(400, "That agent profile no longer exists.");
        if (read.pipelineId && !pipelines.get(read.pipelineId)) return fail<BatchView>(400, "That pipeline no longer exists.");
        if (!read.pipelineId && !read.profileId && !harnessOf(read.harness)) return fail<BatchView>(400, `Harness "${read.harness}" was not found.`);
        entry.config = normalizeConfig(read);
      }
      changes.push("configuration");
    }
    if (body.policy !== undefined) {
      const policy = readBatchPolicy(body.policy, batch.policy);
      if (typeof policy === "string") return fail<BatchView>(400, policy);
      batch.policy = policy;
      changes.push("policy");
    }
    if (body.title !== undefined) {
      batch.title = titleOf(body.title, batch.title);
      changes.push("title");
    }
    batch.revision += 1;
    await refreshPreview(batch, deps);
    save(batch);
    if (changes.length > 0) record(batch, "edited", `Edited: ${changes.join(", ")}.`);
    return { ok: true as const, value: viewOf(batch) };
  });
}

/** Re-run every check (after installing a CLI, logging in, linking tasks…). */
export async function previewBatch(rawPath: unknown, id: string, deps: BatchDeps = {}): Promise<BatchResult<BatchView>> {
  const located = locate(rawPath, id);
  if (!located.ok) return located;
  return withLock(id, async () => {
    const batch = loadIn(located.value.projectPath, id)!;
    if (batch.status !== "draft") return { ok: true as const, value: viewOf(batch) };
    const before = batch.preview?.key ?? null;
    await refreshPreview(batch, deps, true);
    if (batch.preview?.key !== before) batch.revision += 1;
    save(batch);
    return { ok: true as const, value: viewOf(batch) };
  });
}

/* ────────────────────────────────────────────────────────────────────────── *
 * Approval and lifecycle.
 * ────────────────────────────────────────────────────────────────────────── */

/**
 * The owner's approval of exactly the previewed batch. Re-checks
 * everything first; a different result than the owner saw is refused with
 * the new preview. Freezes the task list, each task's fingerprint,
 * configuration, dependency links and permission level, the allowed
 * harnesses, profiles and pipelines, and the accepted spending notices.
 * Starts nothing.
 */
export async function approveBatch(
  rawPath: unknown,
  id: string,
  body: { revision?: unknown; previewKey?: unknown; acknowledgedHarnessIds?: unknown; acknowledgeFullAccess?: unknown; authorizationMinutes?: unknown },
  deps: BatchDeps = {},
): Promise<BatchResult<{ batch: BatchView; alreadyApproved: boolean }>> {
  const located = locate(rawPath, id);
  if (!located.ok) return located;
  return withLock(id, async () => {
    const batch = loadIn(located.value.projectPath, id)!;
    if (batch.status !== "draft") {
      if (batch.approval && batch.approval.previewKey === body.previewKey) {
        return { ok: true as const, value: { batch: viewOf(batch), alreadyApproved: true } };
      }
      return fail<{ batch: BatchView; alreadyApproved: boolean }>(409, `This batch is ${batch.status}, not a draft.`, { batch: viewOf(batch) });
    }
    if (parseRevision(body.revision) !== batch.revision || typeof body.previewKey !== "string" || body.previewKey !== batch.preview?.key) {
      return fail<{ batch: BatchView; alreadyApproved: boolean }>(409, "The batch changed since you reviewed it. Review the preview again.", { batch: viewOf(batch) });
    }
    const inspected = await inspect(batch, deps, true);
    if (inspected.preview.key !== body.previewKey) {
      batch.preview = inspected.preview;
      batch.revision += 1;
      save(batch);
      return fail<{ batch: BatchView; alreadyApproved: boolean }>(409, "Something changed since you reviewed this batch. Check the updated preview and approve again.", { batch: viewOf(batch) });
    }
    if (!inspected.preview.canApprove) {
      const first = inspected.preview.issues.find((item) => item.level === "error");
      return fail<{ batch: BatchView; alreadyApproved: boolean }>(409, `Can't approve: ${first?.message ?? "a check failed."}`, { batch: viewOf(batch) });
    }
    const acknowledged = Array.isArray(body.acknowledgedHarnessIds)
      ? body.acknowledgedHarnessIds.filter((id): id is string => typeof id === "string")
      : [];
    const missingAck = inspected.preview.spendingHarnessIds.filter((id) => !acknowledged.includes(id));
    if (missingAck.length > 0) {
      return fail<{ batch: BatchView; alreadyApproved: boolean }>(400, `This batch may incur paid usage on ${missingAck.join(", ")}. Confirm the spending notice for each of them to approve.`, {
        batch: viewOf(batch),
        missingHarnessIds: missingAck,
      });
    }
    // Queue-sourced batches: full access is acknowledged task by task, never
    // implied by approving the rest; the approval also expires.
    let fullAccessTaskIds: string[] = [];
    let expiryMinutes: number = QUEUE_AUTHORIZATION.defaultMinutes;
    if (batch.sourceQueue) {
      const needed = [...new Set(inspected.preview.issues.filter((item) => item.code === "queue-full-access" && item.taskId).map((item) => item.taskId!))];
      const given = Array.isArray(body.acknowledgeFullAccess) ? body.acknowledgeFullAccess.filter((id): id is string => typeof id === "string") : [];
      const missingFull = needed.filter((id) => !given.includes(id));
      if (missingFull.length > 0) {
        return fail<{ batch: BatchView; alreadyApproved: boolean }>(400, "Some tasks would run with full access. Acknowledge each of them by name to approve, or change their permission mode.", {
          batch: viewOf(batch),
          missingFullAccessTaskIds: missingFull,
        });
      }
      fullAccessTaskIds = needed;
      if (body.authorizationMinutes !== undefined) {
        const minutes = body.authorizationMinutes;
        if (typeof minutes !== "number" || !Number.isInteger(minutes) || minutes < QUEUE_AUTHORIZATION.minMinutes || minutes > QUEUE_AUTHORIZATION.maxMinutes) {
          return fail<{ batch: BatchView; alreadyApproved: boolean }>(400, `authorizationMinutes must be a whole number from ${QUEUE_AUTHORIZATION.minMinutes} to ${QUEUE_AUTHORIZATION.maxMinutes}.`, { batch: viewOf(batch) });
        }
        expiryMinutes = minutes;
      }
    }
    const now = nowOf(deps);
    for (const entry of batch.entries) {
      entry.config = inspected.configs.get(entry.taskId) ?? entry.config;
      entry.approved = inspected.approved.get(entry.taskId) ?? null;
    }
    const configs = batch.entries.map((entry) => entry.config);
    batch.approval = {
      at: now,
      previewKey: inspected.preview.key,
      acknowledgedSpending: inspected.preview.spendingHarnessIds.length > 0,
      acknowledgedHarnessIds: inspected.preview.spendingHarnessIds,
      allowedHarnessIds: [...new Set(batch.entries.flatMap((entry) => entry.approved?.harnessIds ?? []))].sort(),
      allowedProfileIds: [...new Set(configs.map((config) => config.profileId).filter((value): value is string => !!value))].sort(),
      allowedPipelineIds: [...new Set(configs.map((config) => config.pipelineId).filter((value): value is string => !!value))].sort(),
      maxAccessLevel: Math.max(0, ...batch.entries.map((entry) => entry.approved?.accessLevel ?? 0)),
      spendingAccepted: inspected.spendingAccepted,
      ...(batch.sourceQueue ? { expiresAt: now + expiryMinutes * 60_000, fullAccessTaskIds } : {}),
    };
    batch.preview = inspected.preview;
    batch.status = "approved";
    batch.revision += 1;
    db.transaction(() => {
      save(batch, now);
      journalQueueBatch(batch, "queue.authorization.granted", {
        maxStarts: batch.policy.maxStarts,
        maxParallel: batch.policy.maxParallel,
        expiresAt: batch.approval!.expiresAt ?? 0,
      }, "granted", now);
    })();
    record(batch, "approved", `Approved by you: ${batch.entries.length} task${batch.entries.length === 1 ? "" : "s"}, up to ${batch.policy.maxParallel} at a time, ${batch.policy.maxStarts} start${batch.policy.maxStarts === 1 ? "" : "s"} at most. Not started yet.`, null, now);
    return { ok: true as const, value: { batch: viewOf(batch), alreadyApproved: false } };
  });
}

/** The owner's Start. Idempotent; only an approved batch starts. */
export async function startBatch(rawPath: unknown, id: string, deps: BatchDeps = {}): Promise<BatchResult<{ batch: BatchView; alreadyRunning: boolean }>> {
  const located = locate(rawPath, id);
  if (!located.ok) return located;
  return withLock(id, async () => {
    const batch = loadIn(located.value.projectPath, id)!;
    if (batch.status === "running") return { ok: true as const, value: { batch: viewOf(batch), alreadyRunning: true } };
    if (batch.status === "draft") return fail<{ batch: BatchView; alreadyRunning: boolean }>(409, "Approve the batch before starting it.", { batch: viewOf(batch) });
    if (batch.status === "paused") return fail<{ batch: BatchView; alreadyRunning: boolean }>(409, "The batch is paused. Resume it instead.", { batch: viewOf(batch) });
    if (batch.status !== "approved") return fail<{ batch: BatchView; alreadyRunning: boolean }>(409, `This batch is ${batch.status}.`, { batch: viewOf(batch) });
    const lifecycle = checkProjectLaunchAdmission(batch.projectPath);
    if (!lifecycle.allowed) {
      return fail<{ batch: BatchView; alreadyRunning: boolean }>(409, lifecycle.reason!, { batch: viewOf(batch) });
    }
    const now = nowOf(deps);
    if (authorizationExpired(batch, now)) {
      return fail<{ batch: BatchView; alreadyRunning: boolean }>(409, "The approval for this batch expired. Cancel it and prepare a new one from the queue.", { batch: viewOf(batch) });
    }
    if (batch.autonomy) {
      const { used } = grantCounters(batch, batch.autonomy);
      const effective = effectiveGrantStatus(batch.autonomy, now, used);
      if (effective !== "active") {
        return fail<{ batch: BatchView; alreadyRunning: boolean }>(409, `The autonomous grant is ${effective}. Grant it again to start, or cancel the batch.`, { batch: viewOf(batch) });
      }
    }
    batch.status = "running";
    batch.startedAt = now;
    batch.deadlineAt = batch.policy.maxDurationMinutes ? now + batch.policy.maxDurationMinutes * 60_000 : null;
    batch.reason = null;
    db.transaction(() => {
      save(batch, now);
      if (batch.autonomy) {
        journalAutonomy(batch, batch.autonomy, "autonomy.execution.started", "owner", "started", { maxRuns: batch.autonomy.maxRuns, expiresAt: batch.autonomy.expiresAt }, now);
      }
    })();
    record(batch, "started", "Started by you.", null, now);
    appendManagerSystemMessage(batch.projectPath, `Started the batch “${batch.title}” (${batch.entries.length} task${batch.entries.length === 1 ? "" : "s"}).`);
    stopRequested.delete(id);
    await tickLocked(id, deps);
    return { ok: true as const, value: { batch: viewOf(loadIn(batch.projectPath, id)!), alreadyRunning: false } };
  });
}

/** No new task starts; running agents keep running. */
export async function pauseBatch(rawPath: unknown, id: string): Promise<BatchResult<BatchView>> {
  const located = locate(rawPath, id);
  if (!located.ok) return located;
  if (located.value.status === "running") stopRequested.add(id);
  return withLock(id, async () => {
    try {
      const batch = loadIn(located.value.projectPath, id)!;
      if (batch.status === "paused") return { ok: true as const, value: viewOf(batch) };
      if (batch.status !== "running") return fail<BatchView>(409, `Only a running batch can be paused; this one is ${batch.status}.`, { batch: viewOf(batch) });
      const now = Date.now();
      batch.status = "paused";
      batch.reason = { code: "owner", text: "Paused by you.", at: now };
      db.transaction(() => {
        save(batch, now);
        if (batch.autonomy) {
          journalAutonomy(batch, batch.autonomy, "autonomy.execution.blocked", "owner", `blocked:${batch.autonomy.epoch}:owner-paused:batch`, { code: "owner-paused", reason: "Paused by you.", origin: "owner", runsUsed: grantCounters(batch, batch.autonomy).used }, now);
        }
      })();
      record(batch, "paused", "Paused by you. Running agents keep running.", null, now);
      return { ok: true as const, value: viewOf(batch) };
    } finally {
      stopRequested.delete(id);
    }
  });
}

/**
 * Continue a paused batch. Re-checks what the approval allowed — the time
 * limit, and for every task still to run its links, configuration and the
 * spending policy; a task that no longer matches is held, the rest go on.
 * Failures and holds the owner has now seen don't pause it again.
 */
export async function resumeBatch(rawPath: unknown, id: string, deps: BatchDeps = {}): Promise<BatchResult<{ batch: BatchView; held: string[] }>> {
  const located = locate(rawPath, id);
  if (!located.ok) return located;
  return withLock(id, async () => {
    const batch = loadIn(located.value.projectPath, id)!;
    if (batch.status === "running") return { ok: true as const, value: { batch: viewOf(batch), held: [] } };
    if (batch.status !== "paused") return fail<{ batch: BatchView; held: string[] }>(409, `Only a paused batch can be resumed; this one is ${batch.status}.`, { batch: viewOf(batch) });
    const lifecycle = checkProjectLaunchAdmission(batch.projectPath);
    if (!lifecycle.allowed) {
      return fail<{ batch: BatchView; held: string[] }>(409, lifecycle.reason!, { batch: viewOf(batch) });
    }
    const now = nowOf(deps);
    if (batch.deadlineAt != null && now >= batch.deadlineAt) {
      return fail<{ batch: BatchView; held: string[] }>(409, "The batch's time limit has passed. Cancel it and prepare a new one.", { batch: viewOf(batch) });
    }
    if (authorizationExpired(batch, now)) {
      return fail<{ batch: BatchView; held: string[] }>(409, "The approval for this batch expired. Cancel it and prepare a new one from the queue.", { batch: viewOf(batch) });
    }
    if (batch.autonomy) {
      const { used } = grantCounters(batch, batch.autonomy);
      const effective = effectiveGrantStatus(batch.autonomy, now, used);
      if (effective !== "active") {
        return fail<{ batch: BatchView; held: string[] }>(409, `The autonomous grant is ${effective}. Grant it again to resume, or cancel the batch.`, { batch: viewOf(batch) });
      }
    }
    const snap = snapshot(batch);
    const held: string[] = [];
    for (const entry of batch.entries) {
      const state = snap.states.get(entry.taskId) ?? "pending";
      if (state === "failed" || state === "cancelled") entry.failureSeen = entry.attempts.length;
      if (entry.hold) entry.hold = { ...entry.hold, seen: true };
      if (state !== "pending" && state !== "failed") continue;
      const problem = preLaunchHold(batch, entry) ?? (() => {
        const accepted = new Set(batch.approval?.spendingAccepted ?? []);
        for (const agent of agentsOf(normalizeConfig(entry.config))) {
          for (const check of spendingFor(batch, agent.harnessId, agent.harness, deps)) {
            if (check.level === "error") return { code: `spending:${check.code}`, reason: check.message };
            if (check.level === "warning" && !accepted.has(`${agent.harnessId}:${check.code}`)) {
              return { code: "spending-changed", reason: `A spending notice appeared that wasn't approved: ${check.message}` };
            }
          }
        }
        return quotaHold(batch, entry, tasks.get(entry.taskId) ?? null, deps);
      })();
      if (problem && !entry.hold) {
        entry.hold = { ...problem, at: now, seen: true };
        held.push(entry.taskId);
        record(batch, "task-held", `“${entry.title}” held on resume: ${problem.reason}`, entry.taskId, now);
      }
    }
    batch.status = "running";
    batch.reason = null;
    db.transaction(() => {
      if (batch.autonomy) batch.autonomy.epoch += 1;
      save(batch, now);
      if (batch.autonomy) {
        journalAutonomy(batch, batch.autonomy, "autonomy.execution.resumed", "owner", `resumed:${batch.autonomy.epoch}`, { runsUsed: grantCounters(batch, batch.autonomy).used, epoch: batch.autonomy.epoch }, now);
      }
    })();
    record(batch, "resumed", held.length > 0 ? `Resumed by you; ${held.length} task${held.length === 1 ? "" : "s"} held.` : "Resumed by you.", null, now);
    knownThisProcess.add(id);
    stopRequested.delete(id);
    await tickLocked(id, deps);
    return { ok: true as const, value: { batch: viewOf(loadIn(batch.projectPath, id)!), held } };
  });
}

/**
 * Stop assigning tasks, for good. Results stay; running agents keep
 * running — `stopBatchRuns` stops the ones this batch started, separately.
 */
export async function cancelBatch(rawPath: unknown, id: string): Promise<BatchResult<BatchView>> {
  const located = locate(rawPath, id);
  if (!located.ok) return located;
  stopRequested.add(id);
  return withLock(id, async () => {
    try {
      const batch = loadIn(located.value.projectPath, id)!;
      if (batch.status === "cancelled") return { ok: true as const, value: viewOf(batch) };
      if (isTerminalBatch(batch.status)) return fail<BatchView>(409, `This batch already ${batch.status === "completed" ? "completed" : "stopped"}.`, { batch: viewOf(batch) });
      const now = Date.now();
      const previousStatus = batch.status;
      batch.status = "cancelled";
      batch.finishedAt = now;
      batch.reason = { code: "owner", text: "Cancelled by you.", at: now };
      db.transaction(() => {
        endGrant(batch, "revoked", "batch-cancelled", "The batch was cancelled, which ends its autonomous grant.", "owner", now);
        save(batch, now);
        // Cancelling an approved batch is the Owner withdrawing its approval.
        if (isActiveBatch(previousStatus)) journalQueueBatch(batch, "queue.authorization.revoked", { previousStatus }, "revoked", now);
      })();
      const view = viewOf(batch);
      record(batch, "cancelled", view.ownedLive.length > 0
        ? `Cancelled by you. ${view.ownedLive.length} agent${view.ownedLive.length === 1 ? " is" : "s are"} still running; stop ${view.ownedLive.length === 1 ? "it" : "them"} separately if needed.`
        : "Cancelled by you.", null, now);
      return { ok: true as const, value: view };
    } finally {
      stopRequested.delete(id);
    }
  });
}

/** Stop the live runs this batch started — never another run of a task. */
export async function stopBatchRuns(rawPath: unknown, id: string): Promise<BatchResult<{ batch: BatchView; stopped: string[]; failed: string[] }>> {
  const located = locate(rawPath, id);
  if (!located.ok) return located;
  return withLock(id, async () => {
    const batch = loadIn(located.value.projectPath, id)!;
    if (batch.status === "running") {
      return fail<{ batch: BatchView; stopped: string[]; failed: string[] }>(409, "Pause or cancel the batch before stopping its runs.", { batch: viewOf(batch) });
    }
    const view = viewOf(batch);
    const stopped: string[] = [];
    const failed: string[] = [];
    for (const taskId of view.ownedLive) {
      const task = tasks.get(taskId);
      if (!task) continue;
      let ok = false;
      if (task.pipelineId) ok = !("error" in (await cancelPipelineRun(task.id)));
      else if (task.runId) ok = await cancelRun(task.runId);
      (ok ? stopped : failed).push(taskId);
    }
    if (stopped.length + failed.length > 0) {
      record(batch, "runs-stopped", `Stopped ${stopped.length} run${stopped.length === 1 ? "" : "s"} started by this batch${failed.length ? `; ${failed.length} couldn't be stopped` : ""}.`);
    }
    return { ok: true as const, value: { batch: viewOf(batch), stopped, failed } };
  });
}

/** Clear a task's hold (after checking an unconfirmed start, say). The next
 *  start is still checked like any other. */
export async function releaseBatchTask(rawPath: unknown, id: string, taskId: string, deps: BatchDeps = {}): Promise<BatchResult<BatchView>> {
  const located = locate(rawPath, id);
  if (!located.ok) return located;
  return withLock(id, async () => {
    const batch = loadIn(located.value.projectPath, id)!;
    const entry = batch.entries.find((item) => item.taskId === taskId);
    if (!entry) return fail<BatchView>(404, "That task isn't in this batch.");
    if (isTerminalBatch(batch.status)) return fail<BatchView>(409, `This batch is ${batch.status}.`);
    if (!entry.hold) return { ok: true as const, value: viewOf(batch) };
    const reason = entry.hold.reason;
    // Releasing an unconfirmed start is the owner's word that it didn't
    // run: it no longer counts against the start budget.
    if (entry.hold.code === "unconfirmed") entry.attempts = entry.attempts.filter((attempt) => attempt.outcome !== "unconfirmed");
    entry.hold = null;
    save(batch);
    record(batch, "task-released", `Released “${entry.title}” (${reason})`, taskId);
    if (batch.status === "running") await tickLocked(id, deps);
    return { ok: true as const, value: viewOf(loadIn(batch.projectPath, id)!) };
  });
}

/* ────────────────────────────────────────────────────────────────────────── *
 * Bounded autonomous grant (FO-ORCH08).
 *
 * A separate, explicit Owner act on an APPROVED batch. It freezes the exact
 * tasks, harness/model/account/permission bindings, a Run budget, a parallelism
 * cap and a deadline; `autonomy.ts` enforces them before every Run is recorded.
 * Nothing here extends a grant: a new budget is a new grant by the Owner.
 * ────────────────────────────────────────────────────────────────────────── */

function autonomyViewOf(batch: ExecutionBatch, currentTaskIds: string[]): AutonomyView | null {
  const grant = batch.autonomy;
  if (!grant) return null;
  const { used, live } = grantCounters(batch, grant);
  return {
    grant,
    effectiveStatus: effectiveGrantStatus(grant, Date.now(), used),
    runsUsed: used,
    runsLive: live,
    currentTaskIds,
    unknownQuotaText: unknownQuotaText(grant.acknowledgedUnknownQuota),
  };
}

type AutonomyEventType =
  | "autonomy.grant.approved"
  | "autonomy.execution.started"
  | "autonomy.grant.exhausted"
  | "autonomy.grant.expired"
  | "autonomy.grant.revoked"
  | "autonomy.execution.blocked"
  | "autonomy.execution.resumed";

/**
 * One audit row for a grant. Always called inside the transaction that writes
 * the state it describes; the key makes a replay a no-op, and everything is
 * keyed to the grant id (the durable identity), never to a request.
 */
function journalAutonomy(
  batch: ExecutionBatch,
  grant: AutonomyGrant,
  eventType: AutonomyEventType,
  actor: "owner" | "system",
  keySuffix: string,
  extra: Record<string, unknown>,
  at: number,
): void {
  new ActivityJournalCore(db).record({
    eventType,
    projectPath: batch.projectPath,
    actorType: actor,
    actorId: actor,
    targetType: "execution",
    targetId: grant.id,
    idempotencyKey: `autonomy:${grant.id}:${keySuffix}`,
    payload: { grantId: grant.id, batchId: batch.id, taskIds: grant.taskIds, ...extra },
    createdAt: at,
  });
}

/** Ends an active grant (exhausted / expired / revoked) and records it. Caller saves, in a transaction. */
function endGrant(batch: ExecutionBatch, status: Exclude<AutonomyStatus, "active">, code: string, text: string, actor: "owner" | "system", now: number): void {
  const grant = batch.autonomy;
  if (!grant || grant.status !== "active") return;
  const { used } = grantCounters(batch, grant);
  grant.status = status;
  grant.endedAt = now;
  grant.endReason = { code, text };
  const type = status === "exhausted" ? "autonomy.grant.exhausted" : status === "expired" ? "autonomy.grant.expired" : "autonomy.grant.revoked";
  const extra: Record<string, unknown> = status === "exhausted"
    ? { maxRuns: grant.maxRuns, runsUsed: used }
    : status === "expired" ? { expiresAt: grant.expiresAt, runsUsed: used } : { previousStatus: "active", runsUsed: used };
  journalAutonomy(batch, grant, type, actor, status, extra, now);
  record(batch, `autonomy-${status}`, text, null, now);
}

/** Pauses a running batch because autonomy stopped, and records why. Caller saves, in a transaction. */
function pauseForAutonomy(batch: ExecutionBatch, grant: AutonomyGrant, code: string, text: string, origin: string, now: number, taskId: string | null): void {
  const { used } = grantCounters(batch, grant);
  if (batch.status === "running") {
    batch.status = "paused";
    batch.reason = { code: `autonomy:${code}`, text, at: now };
    record(batch, "paused", text, taskId, now);
  }
  journalAutonomy(batch, grant, "autonomy.execution.blocked", "system", `blocked:${grant.epoch}:${code}:${taskId ?? "batch"}`, { code, reason: capText(text, 300), origin, runsUsed: used }, now);
}

/**
 * A Run was refused (or a start held) because of the grant. Ending conditions
 * end the grant; every significant violation pauses the batch and is recorded
 * once per epoch. Never starts anything, never retries, never substitutes.
 */
function autonomyDenied(batch: ExecutionBatch, code: string, text: string, origin: AutonomyOrigin | "owner", taskId: string | null, now: number): void {
  const grant = batch.autonomy;
  if (!grant) return;
  const wasRunning = batch.status === "running";
  db.transaction(() => {
    if (code === "grant-expired") endGrant(batch, "expired", code, text, "system", now);
    else if (code === "grant-exhausted") endGrant(batch, "exhausted", code, text, "system", now);
    pauseForAutonomy(batch, grant, code, text, origin, now, taskId);
    save(batch, now);
  })();
  if (wasRunning && batch.status === "paused") appendManagerSystemMessage(batch.projectPath, `Batch “${batch.title}” paused: ${text}`);
}

/**
 * The tick's check of the grant's clock and budget. Returns true when it
 * ended the grant and paused the batch (the tick stops there). A finished or
 * stopped batch is left alone; an exhausted budget only matters when another
 * Run would be needed.
 */
function enforceGrant(batch: ExecutionBatch, decision: TickDecision["kind"], now: number): boolean {
  const grant = batch.autonomy;
  if (!grant || decision === "complete" || decision === "stop") return false;
  if (grant.status !== "active") {
    if (decision === "start" || decision === "idle") {
      autonomyDenied(batch, `grant-${grant.status}`, `The autonomous grant is ${grant.status}. No further Run starts without a new decision from you.`, "batch", null, now);
      return true;
    }
    return false;
  }
  const { used } = grantCounters(batch, grant);
  const effective = effectiveGrantStatus(grant, now, used);
  if (effective === "expired") {
    autonomyDenied(batch, "grant-expired", "The autonomous grant expired. No new task starts; running agents keep running.", "batch", null, now);
    return true;
  }
  if (effective === "exhausted" && decision === "start") {
    autonomyDenied(batch, "grant-exhausted", `The grant's Run budget (${grant.maxRuns}) is used up. No new task starts; running agents keep running.`, "batch", null, now);
    return true;
  }
  return false;
}

/** A refusal raised outside the batch's own tick (pipeline step, reminder, fx resume). */
function handleRefusal(refusal: AutonomyRefusal): void {
  void withLock(refusal.batchId, async () => {
    const batch = parse(executionBatches.getAny(refusal.batchId));
    if (!batch?.autonomy || batch.autonomy.id !== refusal.grantId) return;
    autonomyDenied(batch, refusal.code, refusal.reason, refusal.origin, refusal.rootTaskId, Date.now());
  });
}
onAutonomyRefusal(handleRefusal);

const COST_NOTE = "ForgeOrbit enforces the number of Runs and how many run at once. It does not measure money, and provider quota is only what AccountCore has verified — no price or remaining balance is promised.";

function autonomyDefaults(batch: ExecutionBatch): AutonomyPreview["defaults"] {
  return {
    maxRuns: Math.min(AUTONOMY_LIMITS.maxRuns.max, Math.max(batch.entries.length, batch.policy.maxStarts)),
    maxParallelism: Math.min(batch.policy.maxParallel, AUTONOMY_LIMITS.maxParallelism.max),
    ttlMinutes: AUTONOMY_LIMITS.ttlMinutes.default,
  };
}

/** Read-only: what a grant would bind, and what stops it. Writes nothing. */
export function previewAutonomy(rawPath: unknown, id: string): BatchResult<AutonomyPreview> {
  const located = locate(rawPath, id);
  if (!located.ok) return located;
  const batch = located.value;
  const draft = buildGrantDraft(batch);
  const blockers = [...draft.blockers];
  if (batch.status !== "approved" && batch.status !== "paused") {
    blockers.unshift({ taskId: null, code: "batch-status", message: `A grant is made on an approved or paused batch; this one is ${batch.status}.` });
  }
  return {
    ok: true,
    value: {
      batchId: batch.id,
      limits: AUTONOMY_LIMITS,
      defaults: autonomyDefaults(batch),
      taskIds: draft.taskIds,
      resources: draft.resources,
      blockers,
      unknownQuota: draft.unknownQuota,
      unknownQuotaText: unknownQuotaText(draft.unknownQuota),
      stopConditions: AUTONOMY_STOP_CONDITIONS,
      costNote: COST_NOTE,
      previewKey: batch.approval?.previewKey ?? null,
    },
  };
}

function wholeNumber(value: unknown, min: number, max: number): number | null {
  return typeof value === "number" && Number.isInteger(value) && value >= min && value <= max ? value : null;
}

/**
 * The Owner enables bounded autonomous execution for an approved batch. It
 * needs an explicit confirmation naming the approval it was reviewed against,
 * never widens the batch approval, and refuses while the batch has a live grant:
 * a larger budget or a later deadline is a NEW grant after a revoke, not an edit.
 */
export async function grantAutonomy(
  rawPath: unknown,
  id: string,
  body: { previewKey?: unknown; confirm?: unknown; maxRuns?: unknown; maxParallelism?: unknown; ttlMinutes?: unknown; acknowledgeUnknownQuota?: unknown },
  deps: BatchDeps = {},
): Promise<BatchResult<{ batch: BatchView }>> {
  const located = locate(rawPath, id);
  if (!located.ok) return located;
  return withLock(id, async () => {
    const batch = loadIn(located.value.projectPath, id)!;
    const refuse = (status: number, error: string, extra?: Record<string, unknown>) => fail<{ batch: BatchView }>(status, error, { batch: viewOf(batch), ...extra });
    if (body.confirm !== true) return refuse(400, "Confirm the grant explicitly. Nothing was enabled.");
    if (batch.status !== "approved" && batch.status !== "paused") return refuse(409, `A grant is made on an approved or paused batch; this one is ${batch.status}.`);
    if (!batch.approval) return refuse(409, "Approve the batch first.");
    if (typeof body.previewKey !== "string" || body.previewKey !== batch.approval.previewKey) {
      return refuse(409, "The batch approval changed since you reviewed it. Review the grant again.");
    }
    const now = nowOf(deps);
    if (batch.autonomy) {
      const { used } = grantCounters(batch, batch.autonomy);
      if (effectiveGrantStatus(batch.autonomy, now, used) === "active") {
        return refuse(409, "This batch already has an active grant. It is never extended: revoke it, then grant again.");
      }
    }
    const defaults = autonomyDefaults(batch);
    const maxRuns = body.maxRuns === undefined ? defaults.maxRuns : wholeNumber(body.maxRuns, AUTONOMY_LIMITS.maxRuns.min, AUTONOMY_LIMITS.maxRuns.max);
    const maxParallelism = body.maxParallelism === undefined ? defaults.maxParallelism : wholeNumber(body.maxParallelism, AUTONOMY_LIMITS.maxParallelism.min, AUTONOMY_LIMITS.maxParallelism.max);
    const ttl = body.ttlMinutes === undefined ? defaults.ttlMinutes : wholeNumber(body.ttlMinutes, AUTONOMY_LIMITS.ttlMinutes.min, AUTONOMY_LIMITS.ttlMinutes.max);
    if (maxRuns == null) return refuse(400, `maxRuns must be a whole number from ${AUTONOMY_LIMITS.maxRuns.min} to ${AUTONOMY_LIMITS.maxRuns.max}.`);
    if (maxParallelism == null) return refuse(400, `maxParallelism must be a whole number from ${AUTONOMY_LIMITS.maxParallelism.min} to ${AUTONOMY_LIMITS.maxParallelism.max}.`);
    if (maxParallelism > batch.policy.maxParallel) return refuse(400, `The batch itself allows ${batch.policy.maxParallel} at a time; a grant can only narrow that.`);
    if (ttl == null) return refuse(400, `ttlMinutes must be a whole number from ${AUTONOMY_LIMITS.ttlMinutes.min} to ${AUTONOMY_LIMITS.ttlMinutes.max}.`);

    const draft = buildGrantDraft(batch, now);
    const blockers = [...draft.blockers];
    for (const entry of batch.entries) {
      for (const other of activeBatchesFor(batch.projectPath, entry.taskId)) {
        if (other !== batch.id) blockers.push({ taskId: entry.taskId, code: "competing-batch", message: `“${entry.title}” is also held by another active batch.` });
      }
    }
    if (blockers.length > 0) return refuse(409, `Can't grant: ${blockers[0]!.message}`, { blockers });
    if (draft.unknownQuota.length > 0 && body.acknowledgeUnknownQuota !== true) {
      return refuse(400, "Provider quota isn't verified for some of these agents. Acknowledge that to grant; it won't make the quota known.", { unknownQuota: draft.unknownQuota, unknownQuotaText: unknownQuotaText(draft.unknownQuota) });
    }
    // A grant never outlives the approval it narrows.
    const expiresAt = Math.min(now + ttl * 60_000, batch.approval.expiresAt ?? Number.POSITIVE_INFINITY);
    if (expiresAt <= now) return refuse(409, "The batch approval has already expired. Prepare a new one.");
    const grant: AutonomyGrant = {
      id: crypto.randomUUID(),
      batchId: batch.id,
      status: "active",
      approvedAt: now,
      approvedBy: "owner",
      expiresAt,
      taskIds: draft.taskIds,
      resources: draft.resources,
      maxRuns,
      maxParallelism,
      acknowledgedUnknownQuota: draft.unknownQuota,
      planEvidence: draft.planEvidence,
      stopConditions: [...AUTONOMY_STOP_CONDITIONS],
      cost: "run-count-only",
      endedAt: null,
      endReason: null,
      epoch: 0,
    };
    batch.autonomy = grant;
    if (batch.status === "paused" && batch.reason?.code.startsWith("autonomy:")) batch.reason = null;
    db.transaction(() => {
      save(batch, now);
      journalAutonomy(batch, grant, "autonomy.grant.approved", "owner", "approved", {
        maxRuns, maxParallelism, expiresAt, unknownQuotaAcknowledged: draft.unknownQuota.length,
      }, now);
    })();
    record(batch, "autonomy-granted", `You allowed autonomous execution: up to ${maxRuns} Run${maxRuns === 1 ? "" : "s"}, ${maxParallelism} at a time, until ${new Date(expiresAt).toLocaleString()}.`, null, now);
    return { ok: true as const, value: { batch: viewOf(batch) } };
  });
}

/** The Owner takes the grant back. Pauses a running batch; running agents keep running. Idempotent. */
export async function revokeAutonomy(rawPath: unknown, id: string): Promise<BatchResult<{ batch: BatchView; alreadyEnded: boolean }>> {
  const located = locate(rawPath, id);
  if (!located.ok) return located;
  if (located.value.status === "running") stopRequested.add(id);
  return withLock(id, async () => {
    try {
      const batch = loadIn(located.value.projectPath, id)!;
      const grant = batch.autonomy;
      if (!grant) return fail<{ batch: BatchView; alreadyEnded: boolean }>(409, "This batch has no autonomous grant.", { batch: viewOf(batch) });
      if (grant.status !== "active") return { ok: true as const, value: { batch: viewOf(batch), alreadyEnded: true } };
      const now = Date.now();
      db.transaction(() => {
        endGrant(batch, "revoked", "owner", "You revoked the autonomous grant.", "owner", now);
        if (batch.status === "running") {
          batch.status = "paused";
          batch.reason = { code: "autonomy:revoked", text: "You revoked the autonomous grant. The batch is paused.", at: now };
          record(batch, "paused", batch.reason.text, null, now);
        }
        save(batch, now);
      })();
      return { ok: true as const, value: { batch: viewOf(batch), alreadyEnded: false } };
    } finally {
      stopRequested.delete(id);
    }
  });
}

/* ────────────────────────────────────────────────────────────────────────── *
 * Reading.
 * ────────────────────────────────────────────────────────────────────────── */

export function listBatches(rawPath: unknown): BatchResult<BatchView[]> {
  const project = registered(rawPath);
  if (!project.ok) return project;
  const views = executionBatches.list(project.value, SCHEDULING_LIMITS.batchesListed)
    .map(parse)
    .filter((batch): batch is ExecutionBatch => batch != null && batch.projectPath === project.value)
    .map((batch) => viewOf(adopt(batch)));
  return { ok: true, value: views };
}

export function getBatch(rawPath: unknown, id: string): BatchResult<BatchView> {
  const located = locate(rawPath, id);
  if (!located.ok) return located;
  return { ok: true, value: viewOf(located.value) };
}

export function batchEvents(rawPath: unknown, id: string): BatchResult<{ events: ReturnType<typeof executionBatches.events> }> {
  const located = locate(rawPath, id);
  if (!located.ok) return located;
  return { ok: true, value: { events: executionBatches.events(id, SCHEDULING_LIMITS.eventsListed) } };
}

/* ────────────────────────────────────────────────────────────────────────── *
 * Wiring.
 * ────────────────────────────────────────────────────────────────────────── */

let initialized = false;
let sweepTimer: ReturnType<typeof setInterval> | null = null;
let unsubBatchAvailability: (() => void) | null = null;
const scheduledWakeTimers = new Map<string, ReturnType<typeof setTimeout>>();

function scheduleBatchAvailabilityWake(batchId: string, scheduledWait: ReadonlyMap<string, number>, now: number): void {
  const existing = scheduledWakeTimers.get(batchId);
  if (existing) {
    clearTimeout(existing);
    scheduledWakeTimers.delete(batchId);
  }
  let earliest = Number.POSITIVE_INFINITY;
  for (const until of scheduledWait.values()) {
    if (Number.isFinite(until) && until > now && until < earliest) earliest = until;
  }
  if (!Number.isFinite(earliest)) return;
  const delay = Math.min(60_000, Math.max(50, earliest - now));
  const timer = setTimeout(() => {
    scheduledWakeTimers.delete(batchId);
    void requestTick(batchId);
  }, delay);
  timer.unref?.();
  scheduledWakeTimers.set(batchId, timer);
}

function runningBatchesWith(taskId: string | null): string[] {
  return executionBatches.listByStatus(["running"])
    .map(parse)
    .filter((batch): batch is ExecutionBatch => batch != null && (taskId == null || batch.entries.some((entry) => entry.taskId === taskId)))
    .map((batch) => batch.id);
}

/** A task changed outside a run (the board's own edit or column move):
 *  let every running batch that holds it re-plan. */
export function notifyBatchTaskChanged(taskId: string): void {
  for (const id of runningBatchesWith(taskId)) void requestTick(id);
}

/**
 * Tick a running batch when one of its tasks changes column or a run
 * settles, plus a slow sweep for time limits. Idempotent.
 */
export function initExecutionBatches(): void {
  if (initialized) return;
  initialized = true;
  unsubBatchAvailability = onTaskAvailabilityChange((taskId) => {
    for (const id of runningBatchesWith(taskId)) void requestTick(id);
  });
  subscribeGlobal((event) => {
    if (event.kind !== "run-status" && event.kind !== "column") return;
    for (const id of runningBatchesWith(event.taskId)) void requestTick(id);
  });
  sweepTimer = setInterval(() => {
    for (const id of runningBatchesWith(null)) void requestTick(id);
  }, 15_000);
  sweepTimer.unref?.();
}

export function stopExecutionBatchTimers(): void {
  if (sweepTimer) clearInterval(sweepTimer);
  sweepTimer = null;
  unsubBatchAvailability?.();
  unsubBatchAvailability = null;
  for (const timer of scheduledWakeTimers.values()) clearTimeout(timer);
  scheduledWakeTimers.clear();
  initialized = false;
}

export const __testing = {
  setEventDeps(deps: BatchDeps): void {
    eventDeps = deps;
  },
  /** Forget everything this process knows, as a restart would. */
  simulateRestart(): void {
    knownThisProcess.clear();
    stopRequested.clear();
    tickQueued.clear();
    chains.clear();
  },
  isActive: isActiveBatch,
  occupiesSlot,
  /** Await every queued mutation. */
  async settle(): Promise<void> {
    for (let i = 0; i < 50; i++) {
      const pending = [...chains.values()];
      if (pending.length === 0) return;
      await Promise.all(pending);
    }
  },
};
