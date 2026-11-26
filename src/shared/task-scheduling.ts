/**
 * Structured task scheduling and approved execution batches (FO-005C.1).
 * Pure, shared by the Bun runner, the tests and the future Manager UI:
 * priorities, dependency validation (self, other project, cycles),
 * dependency readiness, the batch model and its policy, the cost
 * assessment behind the spending policy, and the scheduler that picks what
 * an approved batch may start next.
 *
 * Nothing here starts an agent. `src/bun/execution-batches.ts` owns the
 * lifecycle and starts tasks only through the supervised-execution path
 * (`launchBatchTask` → the board's `startTask`).
 *
 * Dependencies come only from the structured `task_dependencies` rows. The
 * "## Depends on" Markdown a proposal writes into a task's prompt is for
 * the agent to read and is never used to decide what may run.
 */

import type { ExecutionCheck, ExecutionConfig } from "./project-execution.ts";
import { PAID_API_ENV, stableHash } from "./project-execution.ts";
import type { AgentKind, ColumnId, Run, RunStatus, Task } from "./types.ts";
import { sanitizeGrant, type AutonomyGrant, type AutonomyStatus } from "./autonomy.ts";

/* ────────────────────────────────────────────────────────────────────────── *
 * Priority.
 * ────────────────────────────────────────────────────────────────────────── */

export type TaskPriority = "critical" | "high" | "normal" | "low";

export const TASK_PRIORITIES: readonly TaskPriority[] = ["critical", "high", "normal", "low"];

export const PRIORITY_LABELS: Record<TaskPriority, string> = {
  critical: "Critical",
  high: "High",
  normal: "Normal",
  low: "Low",
};

/** Lower runs first. */
export function priorityRank(priority: TaskPriority): number {
  return TASK_PRIORITIES.indexOf(priority);
}

export function normalizeTaskPriority(value: unknown): TaskPriority | null {
  if (typeof value !== "string") return null;
  const lower = value.trim().toLowerCase();
  return (TASK_PRIORITIES as readonly string[]).includes(lower) ? (lower as TaskPriority) : null;
}

/** A task proposal's three-level priority on the four-level scale. */
export function priorityFromProposal(priority: "high" | "medium" | "low"): TaskPriority {
  return priority === "medium" ? "normal" : priority;
}

/* ────────────────────────────────────────────────────────────────────────── *
 * Dependencies.
 * ────────────────────────────────────────────────────────────────────────── */

export const SCHEDULING_LIMITS = {
  /** Direct dependencies of one task. */
  dependenciesPerTask: 30,
  /** Tasks in one batch. */
  batchTasks: 50,
  maxParallel: 4,
  maxStarts: 200,
  maxRetriesPerTask: 3,
  /** 7 days. */
  maxDurationMinutes: 10_080,
  titleChars: 120,
  eventsListed: 200,
  batchesListed: 40,
  eventTextChars: 400,
} as const;

/** "Task `taskId` waits for task `dependsOn`." */
export interface DependencyEdge {
  taskId: string;
  dependsOn: string;
}

/**
 * The first cycle found in the graph, as a path that starts and ends on the
 * same task (`[a, b, a]`), or null. Iterative, so a long chain can't blow
 * the stack; deterministic, so the same graph always reports the same path.
 */
export function findCycle(edges: readonly DependencyEdge[]): string[] | null {
  const next = new Map<string, string[]>();
  for (const edge of edges) {
    const list = next.get(edge.taskId) ?? [];
    list.push(edge.dependsOn);
    next.set(edge.taskId, list);
  }
  for (const list of next.values()) list.sort();
  const state = new Map<string, "open" | "done">();
  const roots = [...next.keys()].sort();
  for (const root of roots) {
    if (state.has(root)) continue;
    const stack: { id: string; i: number }[] = [{ id: root, i: 0 }];
    const path: string[] = [root];
    state.set(root, "open");
    while (stack.length > 0) {
      const top = stack[stack.length - 1]!;
      const targets = next.get(top.id) ?? [];
      if (top.i >= targets.length) {
        state.set(top.id, "done");
        stack.pop();
        path.pop();
        continue;
      }
      const target = targets[top.i++]!;
      const seen = state.get(target);
      if (seen === "open") return [...path.slice(path.indexOf(target)), target];
      if (seen === "done") continue;
      state.set(target, "open");
      stack.push({ id: target, i: 0 });
      path.push(target);
    }
  }
  return null;
}

export interface DependencyTaskRef {
  id: string;
  projectPath: string;
  title: string;
  /** A hidden pipeline step task can't be depended on. */
  pipelineStep: boolean;
}

export type DependencyErrorCode = "self" | "missing" | "other-project" | "pipeline-step" | "cycle" | "too-many";

/**
 * Check a task's new dependency list against the rest of its project's
 * graph. Returns the deduplicated list, or the first problem. Cross-project
 * dependencies are refused: a batch, its approval and its checks are all
 * scoped to one project.
 */
export function validateDependencies(
  task: DependencyTaskRef,
  requested: readonly string[],
  lookup: (id: string) => DependencyTaskRef | null,
  projectEdges: readonly DependencyEdge[],
): { ok: true; dependsOn: string[] } | { ok: false; code: DependencyErrorCode; error: string; cycle?: string[] } {
  const dependsOn = [...new Set(requested)];
  if (dependsOn.length > SCHEDULING_LIMITS.dependenciesPerTask) {
    return { ok: false, code: "too-many", error: `A task can depend on at most ${SCHEDULING_LIMITS.dependenciesPerTask} tasks.` };
  }
  for (const id of dependsOn) {
    if (id === task.id) return { ok: false, code: "self", error: "A task can't depend on itself." };
    const target = lookup(id);
    if (!target) return { ok: false, code: "missing", error: `Task ${id.slice(0, 8)} doesn't exist.` };
    if (target.projectPath !== task.projectPath) {
      return { ok: false, code: "other-project", error: `“${target.title}” belongs to another project. Dependencies stay inside one project.` };
    }
    if (target.pipelineStep) {
      return { ok: false, code: "pipeline-step", error: `“${target.title}” is a step of a pipeline run. Depend on the pipeline task instead.` };
    }
  }
  const edges = [
    ...projectEdges.filter((edge) => edge.taskId !== task.id),
    ...dependsOn.map((dependsOnId) => ({ taskId: task.id, dependsOn: dependsOnId })),
  ];
  let cycle = findCycle(edges);
  if (cycle) {
    // Read it from the task being edited: "A → C → B → A".
    const at = cycle.indexOf(task.id);
    if (at > 0) cycle = [...cycle.slice(at, -1), ...cycle.slice(0, at), task.id];
    const names = cycle.map((id) => (id === task.id ? task.title : lookup(id)?.title ?? id.slice(0, 8)));
    return { ok: false, code: "cycle", error: `That would make a cycle: ${names.join(" → ")}.`, cycle };
  }
  return { ok: true, dependsOn };
}

/** A dependency is satisfied only when its task is Done — the owner's
 *  decision, never just a finished agent run. */
export function isDependencyDone(column: ColumnId | null): boolean {
  return column === "done";
}

/** True when a prompt carries the Markdown "Depends on" section a task
 *  proposal writes. Shown as a hint only; never scheduled from. */
export function hasMarkdownDependencies(prompt: string): boolean {
  return /^##\s+Depends on\s*$/im.test(prompt);
}

/* ────────────────────────────────────────────────────────────────────────── *
 * Cost and the spending policy.
 * ────────────────────────────────────────────────────────────────────────── */

/**
 * - `no-extra` (default): only subscription CLIs, and only harnesses whose
 *   account the owner confirmed has no paid usage beyond its plan.
 * - `allow-overage`: subscription CLIs may draw paid extra usage once the
 *   plan's limits run out; per-request APIs are still refused.
 * - `allow-paid`: per-request APIs too. Every paid path must be
 *   acknowledged at approval.
 */
export type SpendingPolicy = "no-extra" | "allow-overage" | "allow-paid";

export const SPENDING_POLICIES: readonly SpendingPolicy[] = ["no-extra", "allow-overage", "allow-paid"];

export interface CostAssessment {
  /** Bills per request (an API key, a gateway). `unknown` counts as yes. */
  paidApi: "yes" | "no" | "unknown";
  /** A subscription can usually buy usage past its limits, and ForgeOrbit
   *  can't see whether the account allows that. */
  overage: "none" | "possible";
  reasons: string[];
}

/** Variables that route a CLI to an endpoint ForgeOrbit can't classify
 *  (a proxy or another provider may bill per request). Names only. */
export const UNKNOWN_BILLING_ENV: Record<AgentKind, string[]> = {
  "claude-code": ["ANTHROPIC_BASE_URL", "ANTHROPIC_BEDROCK_BASE_URL", "ANTHROPIC_VERTEX_PROJECT_ID"],
  codex: ["OPENAI_BASE_URL", "OPENAI_API_BASE"],
  cursor: [],
  gemini: ["GOOGLE_GEMINI_BASE_URL", "GOOGLE_CLOUD_PROJECT"],
  fx: [],
  antigravity: [],
  custom: [],
};

const CREDENTIAL_LIKE = /(API_KEY|_TOKEN|_SECRET|BASE_URL|ENDPOINT)$/i;

/**
 * How a run on this harness may be billed, from the CLI kind and the
 * *names* of the variables it sees (values are never read). Anything not
 * known to be subscription-only is reported as paid or unknown — never as
 * free.
 */
export function assessCost(
  kind: AgentKind | null,
  label: string,
  envNames: readonly string[],
  harnessEnvNames: readonly string[] = [],
): CostAssessment {
  if (!kind) return { paidApi: "unknown", overage: "possible", reasons: [`${label}: the CLI kind isn't known, so its billing can't be checked.`] };
  if (kind === "fx") {
    return { paidApi: "yes", overage: "none", reasons: [`${label} bills every request to your Vercel AI Gateway account.`] };
  }
  const all = [...new Set([...envNames, ...harnessEnvNames])];
  const paid = PAID_API_ENV[kind].filter((name) => all.includes(name));
  if (paid.length > 0) {
    return { paidApi: "yes", overage: "none", reasons: [`${label} has ${paid.join(", ")} set, so it may bill per request to that API account.`] };
  }
  const unknown = [
    ...UNKNOWN_BILLING_ENV[kind].filter((name) => all.includes(name)),
    ...harnessEnvNames.filter((name) => CREDENTIAL_LIKE.test(name) && !PAID_API_ENV[kind].includes(name)),
  ];
  if (unknown.length > 0) {
    return {
      paidApi: "unknown",
      overage: "possible",
      reasons: [`${label} has ${[...new Set(unknown)].join(", ")} set, which may route it to an endpoint that bills per request. ForgeOrbit can't tell.`],
    };
  }
  return {
    paidApi: "no",
    overage: "possible",
    reasons: [`${label} uses its subscription login. ForgeOrbit can't see the remaining limits or whether the account buys extra usage past them.`],
  };
}

export interface SpendingHarness {
  id: string;
  label: string;
  cost: CostAssessment;
}

/**
 * What the spending policy says about one harness: errors block approval
 * and every start; warnings must be acknowledged at approval.
 */
export function spendingChecks(policy: SpendingPolicy, noOverageHarnessIds: readonly string[], harness: SpendingHarness): ExecutionCheck[] {
  const out: ExecutionCheck[] = [];
  const { cost } = harness;
  const reason = cost.reasons.join(" ");
  if (cost.paidApi === "yes") {
    if (policy === "allow-paid") out.push({ level: "warning", code: "spend-paid-api", message: `${reason} Allowed by the batch's spending policy.` });
    else out.push({ level: "error", code: "spend-paid-api-forbidden", message: `${reason} The batch's spending policy doesn't allow paid API usage.` });
  } else if (cost.paidApi === "unknown") {
    if (policy === "allow-paid") out.push({ level: "warning", code: "spend-unknown", message: `${reason} Treated as paid.` });
    else out.push({ level: "error", code: "spend-unknown-forbidden", message: `${reason} Unknown billing is treated as paid, which the spending policy doesn't allow.` });
  }
  if (cost.overage === "possible" && cost.paidApi === "no") {
    if (policy === "no-extra") {
      if (noOverageHarnessIds.includes(harness.id)) {
        out.push({ level: "info", code: "spend-no-overage-confirmed", message: `You confirmed ${harness.label}'s account has no paid usage beyond its plan. ForgeOrbit can't verify it.` });
      } else {
        out.push({
          level: "error",
          code: "spend-overage-unverified",
          message: `${reason} Confirm that this account has no paid extra usage, or allow possible overage in the spending policy.`,
        });
      }
    } else {
      out.push({ level: "warning", code: "spend-overage-possible", message: `${reason} The batch may draw paid extra usage once the plan's limits run out.` });
    }
  }
  return out;
}

/* ────────────────────────────────────────────────────────────────────────── *
 * Batch model.
 * ────────────────────────────────────────────────────────────────────────── */

/**
 * draft → approved (owner approval freezes the scope) → running ⇄ paused →
 * completed | stopped (a limit) | cancelled. Nothing starts before
 * `running`, and only the owner moves a batch to `running`.
 */
export type BatchStatus = "draft" | "approved" | "running" | "paused" | "completed" | "stopped" | "cancelled";

export const TERMINAL_BATCH_STATUSES: readonly BatchStatus[] = ["completed", "stopped", "cancelled"];

export function isTerminalBatch(status: BatchStatus): boolean {
  return TERMINAL_BATCH_STATUSES.includes(status);
}

/** A batch that holds its tasks: no other batch may include them. */
export function isActiveBatch(status: BatchStatus): boolean {
  return status === "approved" || status === "running" || status === "paused";
}

/** While a task waits for review: start nothing new, or keep starting
 *  tasks that don't depend on it. Review is never skipped either way. */
export type ReviewPolicy = "wait-for-review" | "continue-independent";
/** After a task fails for good: pause the batch, or keep going with the
 *  tasks that don't depend on it. */
export type FailurePolicy = "pause" | "continue";

export interface BatchPolicy {
  maxParallel: number;
  /** Agent launches the batch may make in total, retries included. */
  maxStarts: number;
  maxRetriesPerTask: number;
  /** Measured from Start. No new task starts after it. */
  maxDurationMinutes: number | null;
  spending: SpendingPolicy;
  /** Harnesses whose account the owner confirmed has no paid overage. */
  noOverageHarnessIds: string[];
  reviewPolicy: ReviewPolicy;
  onFailure: FailurePolicy;
}

export function defaultBatchPolicy(taskCount: number): BatchPolicy {
  return {
    maxParallel: 1,
    maxStarts: Math.max(1, Math.min(SCHEDULING_LIMITS.maxStarts, taskCount)),
    maxRetriesPerTask: 0,
    maxDurationMinutes: null,
    spending: "no-extra",
    noOverageHarnessIds: [],
    reviewPolicy: "wait-for-review",
    onFailure: "pause",
  };
}

function intIn(value: unknown, min: number, max: number): number | null {
  return typeof value === "number" && Number.isInteger(value) && value >= min && value <= max ? value : null;
}

/** Apply a submitted policy patch. Returns the error for the first bad field. */
export function readBatchPolicy(value: unknown, base: BatchPolicy): BatchPolicy | string {
  if (value === undefined) return base;
  if (!value || typeof value !== "object" || Array.isArray(value)) return "policy must be an object";
  const rec = value as Record<string, unknown>;
  const next: BatchPolicy = { ...base, noOverageHarnessIds: [...base.noOverageHarnessIds] };
  if ("maxParallel" in rec) {
    const n = intIn(rec.maxParallel, 1, SCHEDULING_LIMITS.maxParallel);
    if (n == null) return `maxParallel must be an integer from 1 to ${SCHEDULING_LIMITS.maxParallel}`;
    next.maxParallel = n;
  }
  if ("maxStarts" in rec) {
    const n = intIn(rec.maxStarts, 1, SCHEDULING_LIMITS.maxStarts);
    if (n == null) return `maxStarts must be an integer from 1 to ${SCHEDULING_LIMITS.maxStarts}`;
    next.maxStarts = n;
  }
  if ("maxRetriesPerTask" in rec) {
    const n = intIn(rec.maxRetriesPerTask, 0, SCHEDULING_LIMITS.maxRetriesPerTask);
    if (n == null) return `maxRetriesPerTask must be an integer from 0 to ${SCHEDULING_LIMITS.maxRetriesPerTask}`;
    next.maxRetriesPerTask = n;
  }
  if ("maxDurationMinutes" in rec) {
    if (rec.maxDurationMinutes === null) next.maxDurationMinutes = null;
    else {
      const n = intIn(rec.maxDurationMinutes, 1, SCHEDULING_LIMITS.maxDurationMinutes);
      if (n == null) return `maxDurationMinutes must be null or an integer from 1 to ${SCHEDULING_LIMITS.maxDurationMinutes}`;
      next.maxDurationMinutes = n;
    }
  }
  if ("spending" in rec) {
    if (!SPENDING_POLICIES.includes(rec.spending as SpendingPolicy)) return `spending must be one of ${SPENDING_POLICIES.join(", ")}`;
    next.spending = rec.spending as SpendingPolicy;
  }
  if ("noOverageHarnessIds" in rec) {
    if (!Array.isArray(rec.noOverageHarnessIds) || rec.noOverageHarnessIds.some((id) => typeof id !== "string" || !id || id.length > 200)) {
      return "noOverageHarnessIds must be a list of harness ids";
    }
    next.noOverageHarnessIds = [...new Set(rec.noOverageHarnessIds as string[])].slice(0, 20);
  }
  if ("reviewPolicy" in rec) {
    if (rec.reviewPolicy !== "wait-for-review" && rec.reviewPolicy !== "continue-independent") {
      return "reviewPolicy must be wait-for-review or continue-independent";
    }
    next.reviewPolicy = rec.reviewPolicy;
  }
  if ("onFailure" in rec) {
    if (rec.onFailure !== "pause" && rec.onFailure !== "continue") return "onFailure must be pause or continue";
    next.onFailure = rec.onFailure;
  }
  return next;
}

/** One agent launch made by the batch. */
export interface BatchAttempt {
  at: number;
  /** The supervised-execution row (`project_manager_executions`) it used. */
  executionId: string | null;
  runId: string | null;
  outcome: "started" | "start-failed" | "unconfirmed";
  error: string | null;
}

/** Frozen at approval; every start is checked against it. */
export interface BatchApprovedTask {
  /** `launchFingerprint` of the task the owner reviewed. */
  fingerprint: string;
  /** `executionSignature` of the agents it may run as. */
  signature: string;
  dependsOn: string[];
  /** Highest permission level (0–4) any of its agents runs with. */
  accessLevel: number;
  harnessIds: string[];
}

export interface BatchHold {
  code: string;
  reason: string;
  at: number;
  /** The batch already paused for it once (set on resume). */
  seen: boolean;
}

export interface BatchEntry {
  taskId: string;
  /** Title when added (the task can be renamed later). */
  title: string;
  /** Owner's order, the tie-break after priority. */
  order: number;
  config: ExecutionConfig;
  approved: BatchApprovedTask | null;
  /** Fingerprint after the batch wrote its config onto the task; retries
   *  compare against this one. */
  appliedFingerprint: string | null;
  attempts: BatchAttempt[];
  /** Set while a start is in flight. Survives a crash so recovery can tell
   *  an unconfirmed start apart from a task that never started. */
  launching: { at: number; executionId: string } | null;
  /** A start this batch must not make until the owner looks. */
  hold: BatchHold | null;
  /** Attempts the owner already saw fail (set on resume), so the same
   *  failure doesn't pause the batch twice. */
  failureSeen: number;
  /** Last derived state an event was written for. */
  observed: BatchEntryState | null;
}

export interface BatchIssue extends ExecutionCheck {
  taskId: string | null;
}

export interface BatchPreviewTask {
  taskId: string;
  title: string;
  order: number;
  priority: TaskPriority;
  column: ColumnId | null;
  dependsOn: { taskId: string; title: string; inBatch: boolean; done: boolean }[];
  config: ExecutionConfig;
  harnessLabel: string;
  harnessKind: AgentKind | null;
  modelLabel: string;
  modeLabel: string;
  accessLevel: number;
  profileName: string | null;
  pipelineName: string | null;
  pipelineSteps: { name: string; agent: string }[];
  workspace: string;
  isolation: Task["isolation"];
  harnessIds: string[];
  checks: ExecutionCheck[];
}

export interface BatchPreview {
  /** Approval must name this key: it covers everything shown. */
  key: string;
  checkedAt: number;
  tasks: BatchPreviewTask[];
  harnesses: { id: string; label: string; kind: AgentKind | null; modes: string[]; cost: CostAssessment }[];
  issues: BatchIssue[];
  /** Planned start order if every task succeeds and is accepted. */
  order: string[];
  stopConditions: string[];
  canApprove: boolean;
  /** Approval needs an acknowledgement when any spending warning shows. */
  needsSpendingAck: boolean;
  /** The harnesses whose spending warnings must each be acknowledged by
   *  name (`acknowledgedHarnessIds` on approve). */
  spendingHarnessIds: string[];
}

export interface BatchApproval {
  at: number;
  previewKey: string;
  acknowledgedSpending: boolean;
  /** Harnesses whose spending notices the owner acknowledged by name. */
  acknowledgedHarnessIds?: string[];
  allowedHarnessIds: string[];
  allowedProfileIds: string[];
  allowedPipelineIds: string[];
  maxAccessLevel: number;
  /** Spending warnings the owner accepted, as `harnessId:code`. A start
   *  that would need any other one is held. */
  spendingAccepted: string[];
  /**
   * Queue-sourced batches only (FO-ORCH07): the approval stops allowing new
   * starts at this time. Null/absent for every other batch.
   */
  expiresAt?: number | null;
  /**
   * Queue-sourced batches only: the tasks whose full-access run the Owner
   * acknowledged by id. Any other task that would run with full access is held.
   */
  fullAccessTaskIds?: string[];
}

/**
 * Where a batch prepared from a Task Queue came from (FO-ORCH07). The batch
 * stays the only runtime: this is provenance and the Owner's reviewed order,
 * never a permission.
 */
export interface BatchSourceQueue {
  queueId: string;
  proposalId: string;
  /** Queue revision and plan key the Owner had confirmed at handoff. */
  queueRevision: number;
  planKey: string;
  /** The Owner's queue order at handoff. */
  taskIds: string[];
  preparedAt: number;
}

/** How long a queue-sourced approval allows new starts, and its bounds (minutes). */
export const QUEUE_AUTHORIZATION = { defaultMinutes: 240, minMinutes: 5, maxMinutes: 24 * 60 } as const;

export interface BatchReason {
  code: string;
  text: string;
  at: number;
}

export interface ExecutionBatch {
  id: string;
  projectPath: string;
  title: string;
  status: BatchStatus;
  revision: number;
  entries: BatchEntry[];
  policy: BatchPolicy;
  preview: BatchPreview | null;
  approval: BatchApproval | null;
  /** Why it's paused / stopped. */
  reason: BatchReason | null;
  sourceProposalId: string | null;
  /** Set when the batch was prepared from a Task Queue (FO-ORCH07). */
  sourceQueue?: BatchSourceQueue | null;
  /** The Owner's bounded autonomous grant (FO-ORCH08). Absent = a manual batch. */
  autonomy?: AutonomyGrant | null;
  /** Dependencies a proposal named that aren't structured links. */
  mappingNotes: { taskId: string; title: string; mentioned: string[] }[];
  createdAt: number;
  updatedAt: number;
  startedAt: number | null;
  deadlineAt: number | null;
  finishedAt: number | null;
}

/* ────────────────────────────────────────────────────────────────────────── *
 * Fingerprints.
 * ────────────────────────────────────────────────────────────────────────── */

/**
 * The task fields a launch depends on — the prompt, the agent settings and
 * the workspace — without the run state (column, run id) that every run
 * changes. A start refuses when this differs from what was approved.
 */
export function launchFingerprint(task: Pick<Task,
  "title" | "prompt" | "agent" | "model" | "effort" | "mode" | "fast" | "maxMode" | "agentProfileId"
  | "pipelineId" | "workdir" | "isolation" | "archivedAt">): string {
  return stableHash([
    task.title, task.prompt, task.agent, task.model ?? "", task.effort ?? "", task.mode ?? "",
    task.fast ? "1" : "0", task.maxMode ? "1" : "0", task.agentProfileId ?? "", task.pipelineId ?? "",
    task.workdir, task.isolation, task.archivedAt == null ? "" : "a",
  ].join("\u0000"));
}

export function previewKeyOf(parts: unknown): string {
  return stableHash(JSON.stringify(parts));
}

/* ────────────────────────────────────────────────────────────────────────── *
 * Derived entry state.
 * ────────────────────────────────────────────────────────────────────────── */

export type BatchEntryState =
  | "pending"
  | "starting"
  | "running"
  | "waiting"
  | "review"
  | "done"
  | "failed"
  | "cancelled"
  | "held"
  | "missing"
  | "external";

/** What the runtime says about one task right now. */
export interface EntrySnapshot {
  exists: boolean;
  /** The task is still in this batch's project. */
  inProject: boolean;
  column: ColumnId | null;
  archived: boolean;
  /** Spawning, running, or held by background agents (`isTaskRunLive`), or
   *  a pipeline run in progress. */
  live: boolean;
  /** `task.runId`. */
  runId: string | null;
  pipelineStatus: string | null;
  /** Status of the latest run this batch started, read from `runs`. */
  ownRunStatus: RunStatus | null;
  /** A start is in flight in this process. */
  claimed: boolean;
}

function ownRunIds(entry: BatchEntry): string[] {
  return entry.attempts.filter((a) => a.outcome === "started" && a.runId).map((a) => a.runId!);
}

function hasStarted(entry: BatchEntry): boolean {
  return entry.attempts.some((a) => a.outcome === "started");
}

/**
 * One task's state in the batch, derived from the stored entry and the
 * live task/run rows — never stored as its own truth.
 */
export function deriveEntryState(entry: BatchEntry, snap: EntrySnapshot): BatchEntryState {
  if (!snap.exists || !snap.inProject) return "missing";
  if (snap.column === "done") return "done";
  if (snap.claimed || entry.launching) return "starting";
  const owned = (snap.runId != null && ownRunIds(entry).includes(snap.runId)) || (snap.pipelineStatus != null && hasStarted(entry));
  if (snap.live || snap.column === "running") return owned ? "running" : "external";
  if (snap.column === "blocked") return owned ? "waiting" : "external";
  if (snap.column === "review") return "review";
  if (entry.hold) return "held";
  if (snap.archived) return "missing";
  const last = entry.attempts[entry.attempts.length - 1];
  if (!last) return "pending";
  if (last.outcome === "start-failed") return "failed";
  if (snap.pipelineStatus === "cancelled" || snap.ownRunStatus === "cancelled") return "cancelled";
  if (snap.ownRunStatus === "failed" || snap.ownRunStatus === "orphaned") return "failed";
  return "pending";
}

/** States that take one of the batch's parallel slots. */
export function occupiesSlot(state: BatchEntryState): boolean {
  return state === "starting" || state === "running" || state === "waiting";
}

/** Every attempt counts, an unconfirmed one too: it may have launched. */
export function launchesUsed(entries: readonly BatchEntry[]): number {
  return entries.reduce((sum, entry) => sum + entry.attempts.length, 0);
}

/** One more launch is within the task's retry allowance. */
export function retriesLeft(entry: BatchEntry, policy: BatchPolicy): boolean {
  return entry.attempts.length <= policy.maxRetriesPerTask;
}

/** A dependency in the batch that won't reach Done without the owner. */
export function isStuckEntry(state: BatchEntryState, entry: BatchEntry, policy: BatchPolicy): boolean {
  return isStuck(state, entry, policy);
}

/** A state that won't move on without the owner. */
function isStuck(state: BatchEntryState, entry: BatchEntry, policy: BatchPolicy): boolean {
  if (state === "failed") return !retriesLeft(entry, policy);
  return state === "cancelled" || state === "held" || state === "missing";
}

/* ────────────────────────────────────────────────────────────────────────── *
 * Readiness.
 * ────────────────────────────────────────────────────────────────────────── */

export interface DependencyInfo {
  exists: boolean;
  inProject: boolean;
  title: string;
  column: ColumnId | null;
  archived: boolean;
}

export type Readiness =
  | { state: "ready" }
  | { state: "waiting"; on: string[] }
  | { state: "blocked"; by: { taskId: string; reason: string }[] };

/**
 * Can this task start as far as its dependencies go? Every dependency must
 * be Done. A missing or foreign dependency, or one the batch can't finish
 * (failed for good, cancelled, held), blocks it; anything else is waiting.
 */
export function dependencyReadiness(
  dependsOn: readonly string[],
  info: (taskId: string) => DependencyInfo,
  batchState?: (taskId: string) => { state: BatchEntryState; stuck: boolean } | null,
): Readiness {
  const waiting: string[] = [];
  const blocked: { taskId: string; reason: string }[] = [];
  for (const id of dependsOn) {
    const dep = info(id);
    if (!dep.exists) {
      blocked.push({ taskId: id, reason: `Task ${id.slice(0, 8)} was deleted.` });
      continue;
    }
    if (!dep.inProject) {
      blocked.push({ taskId: id, reason: `“${dep.title}” is no longer in this project.` });
      continue;
    }
    if (isDependencyDone(dep.column)) continue;
    const inBatch = batchState?.(id) ?? null;
    if (inBatch?.stuck) {
      blocked.push({ taskId: id, reason: `“${dep.title}” can't finish in this batch (${inBatch.state}).` });
      continue;
    }
    if (!inBatch && dep.archived) {
      blocked.push({ taskId: id, reason: `“${dep.title}” is archived without being done.` });
      continue;
    }
    waiting.push(id);
  }
  if (blocked.length > 0) return { state: "blocked", by: blocked };
  if (waiting.length > 0) return { state: "waiting", on: waiting };
  return { state: "ready" };
}

/* ────────────────────────────────────────────────────────────────────────── *
 * Scheduler.
 * ────────────────────────────────────────────────────────────────────────── */

export interface TickInput {
  status: BatchStatus;
  policy: BatchPolicy;
  entries: readonly BatchEntry[];
  states: ReadonlyMap<string, BatchEntryState>;
  priorities: ReadonlyMap<string, TaskPriority>;
  readiness: ReadonlyMap<string, Readiness>;
  /** Tasks whose earliest-start UTC timestamp (`availableFromMs`) is strictly after `now`. */
  scheduledWait?: ReadonlyMap<string, number>;
  now: number;
  deadlineAt: number | null;
}

export type TickDecision =
  | { kind: "idle"; reason: string }
  | { kind: "start"; taskIds: string[]; reason: string }
  | { kind: "pause"; code: string; text: string }
  | { kind: "stop"; code: string; text: string }
  | { kind: "complete" };

/** Ready entries in the order they'd start: priority, then the owner's
 *  order, then the task id. Deterministic for equal priorities. */
export function orderCandidates(
  entries: readonly BatchEntry[],
  priorities: ReadonlyMap<string, TaskPriority>,
): BatchEntry[] {
  return [...entries].sort((a, b) => {
    const pa = priorityRank(priorities.get(a.taskId) ?? "normal");
    const pb = priorityRank(priorities.get(b.taskId) ?? "normal");
    if (pa !== pb) return pa - pb;
    if (a.order !== b.order) return a.order - b.order;
    return a.taskId < b.taskId ? -1 : a.taskId > b.taskId ? 1 : 0;
  });
}

/**
 * What a running batch should do now. Pure: the runtime re-checks every
 * start against the approval before it launches anything.
 */
export function planTick(input: TickInput): TickDecision {
  const { policy, entries, states } = input;
  if (input.status !== "running") return { kind: "idle", reason: `The batch is ${input.status}.` };
  const stateOf = (entry: BatchEntry) => states.get(entry.taskId) ?? "pending";
  if (entries.length > 0 && entries.every((entry) => stateOf(entry) === "done")) return { kind: "complete" };

  const active = entries.filter((entry) => occupiesSlot(stateOf(entry))).length;
  const unseenFailure = entries.find((entry) => {
    const state = stateOf(entry);
    if (state !== "failed" && state !== "cancelled") return false;
    if (state === "failed" && retriesLeft(entry, policy)) return false;
    return entry.attempts.length > entry.failureSeen;
  });
  if (unseenFailure && policy.onFailure === "pause") {
    return {
      kind: "pause",
      code: "failure",
      text: `“${unseenFailure.title}” ${stateOf(unseenFailure) === "cancelled" ? "was stopped" : "failed"}. Review it, then resume the batch.`,
    };
  }
  const held = entries.find((entry) => stateOf(entry) === "held" && entry.hold && !entry.hold.seen);
  if (held && policy.onFailure === "pause") return { kind: "pause", code: "held", text: `“${held.title}” can't start: ${held.hold!.reason}` };

  if (input.deadlineAt != null && input.now >= input.deadlineAt) {
    return { kind: "stop", code: "deadline", text: "The batch's time limit passed. No new tasks start." };
  }

  const reviewing = entries.filter((entry) => stateOf(entry) === "review");
  const isTimeBlocked = (entry: BatchEntry) => {
    const until = input.scheduledWait?.get(entry.taskId);
    return until != null && until > input.now;
  };
  const candidates = orderCandidates(
    entries.filter((entry) => {
      const state = stateOf(entry);
      const startable = state === "pending" || (state === "failed" && retriesLeft(entry, policy));
      return startable && input.readiness.get(entry.taskId)?.state === "ready" && !isTimeBlocked(entry);
    }),
    input.priorities,
  );
  const scheduledWaiting = entries.filter((entry) => {
    const state = stateOf(entry);
    const startable = state === "pending" || (state === "failed" && retriesLeft(entry, policy));
    return startable && input.readiness.get(entry.taskId)?.state === "ready" && isTimeBlocked(entry);
  });
  const used = launchesUsed(entries);
  if (candidates.length > 0 && used >= policy.maxStarts) {
    if (active === 0) return { kind: "stop", code: "start-limit", text: `The batch used all ${policy.maxStarts} allowed starts.` };
    return { kind: "idle", reason: "The start limit is reached; waiting for running tasks." };
  }
  if (reviewing.length > 0 && policy.reviewPolicy === "wait-for-review") {
    return { kind: "idle", reason: `Waiting for your review of “${reviewing[0]!.title}”.` };
  }
  const slots = Math.min(policy.maxParallel - active, policy.maxStarts - used);
  if (candidates.length > 0 && slots > 0) {
    return { kind: "start", taskIds: candidates.slice(0, slots).map((entry) => entry.taskId), reason: "Ready by dependencies and priority." };
  }
  if (active > 0) return { kind: "idle", reason: "Running tasks occupy every slot." };
  if (reviewing.length > 0) return { kind: "idle", reason: `Waiting for your review of “${reviewing[0]!.title}”.` };
  const stuck = entries.filter((entry) => isStuck(stateOf(entry), entry, policy));
  if (stuck.length > 0) return { kind: "idle", reason: `Waiting for you: “${stuck[0]!.title}” can't continue on its own.` };
  if (scheduledWaiting.length > 0) return { kind: "idle", reason: "Waiting for scheduled time." };
  return { kind: "idle", reason: "Waiting for dependencies outside this batch." };
}

/**
 * The order tasks would start in if every one succeeds and is accepted —
 * for the preview. Simulates the scheduler with sequential completion.
 */
export function plannedOrder(
  entries: readonly BatchEntry[],
  dependsOn: (taskId: string) => readonly string[],
  priorities: ReadonlyMap<string, TaskPriority>,
  isDone: (taskId: string) => boolean,
): string[] {
  const inBatch = new Set(entries.map((entry) => entry.taskId));
  const finished = new Set<string>();
  const out: string[] = [];
  let remaining = entries.filter((entry) => !isDone(entry.taskId));
  while (remaining.length > 0) {
    const ready = orderCandidates(
      remaining.filter((entry) => dependsOn(entry.taskId).every((id) => finished.has(id) || isDone(id) || !inBatch.has(id))),
      priorities,
    );
    if (ready.length === 0) break;
    const next = ready[0]!;
    out.push(next.taskId);
    finished.add(next.taskId);
    remaining = remaining.filter((entry) => entry.taskId !== next.taskId);
  }
  return out;
}

/* ────────────────────────────────────────────────────────────────────────── *
 * Views (what the API returns; the webview renders these as-is).
 * ────────────────────────────────────────────────────────────────────────── */

export interface TaskSchedulingView {
  taskId: string;
  title: string;
  column: ColumnId;
  archived: boolean;
  priority: TaskPriority;
  dependsOn: { taskId: string; title: string; column: ColumnId | null; done: boolean; exists: boolean; inProject: boolean }[];
  dependents: string[];
  readiness: Readiness;
  /** Prerequisites that were deleted. They keep this task blocked until the
   *  Owner clears them (FO-ORCH05). */
  deletedDependencies?: { taskId: string; title: string; deletedAt: number }[];
  /** The prompt has a Markdown "Depends on" section. It is not used for
   *  scheduling; link the real tasks instead. */
  markdownDependencies: boolean;
}

export interface BatchEntryView extends BatchEntry {
  state: BatchEntryState;
  readiness: Readiness;
  priority: TaskPriority;
  column: Task["column"] | null;
  currentTitle: string | null;
  /** Live links differ from the approved ones (a start would be held). */
  dependenciesChanged: boolean;
  runId: string | null;
  /** Status of the latest run this batch started, read from `runs`. */
  runStatus: Run["status"] | null;
  /** The live pipeline run's state, for a pipeline task. */
  pipeline: { status: string; activeSteps: string[] } | null;
}

export interface BatchView extends Omit<ExecutionBatch, "entries"> {
  entries: BatchEntryView[];
  counts: Partial<Record<BatchEntryState, number>>;
  launchesUsed: number;
  /** What the scheduler would do now (running batches). */
  next: TickDecision | null;
  /** Tasks whose live run this batch started — what "stop runs" would stop. */
  ownedLive: string[];
  /** Queue-sourced batches: whether the Owner's queue order is what will run. */
  queueOrder?: { guaranteed: boolean; note: string } | null;
  /** Queue-sourced batches: the approval's expiry has passed. */
  authorizationExpired?: boolean;
  /** The bounded grant with its live counters (FO-ORCH08); null for a manual batch. */
  autonomyView?: AutonomyView | null;
}

/** A grant as the UI sees it: stored fields plus what is derived on read. */
export interface AutonomyView {
  grant: AutonomyGrant;
  /** `grant.status` adjusted for the clock and the counter; nothing is written for this. */
  effectiveStatus: AutonomyStatus;
  runsUsed: number;
  runsLive: number;
  currentTaskIds: string[];
  unknownQuotaText: string;
}

/**
 * Whether the queue's order is what a batch will follow. The scheduler orders
 * ready tasks by priority first and the Owner's order second, and starts up
 * to `maxParallel` at once, so the order is a guarantee only when every
 * unstarted task has the same priority and one runs at a time. Dependencies
 * only ever delay a task, never reorder the others.
 */
export function queueOrderGuarantee(priorities: readonly string[], maxParallel: number): { guaranteed: boolean; note: string } {
  if (maxParallel > 1) {
    return { guaranteed: false, note: `Up to ${maxParallel} tasks start at once, so your queue order is not a guaranteed sequence.` };
  }
  if (new Set(priorities).size > 1) {
    return { guaranteed: false, note: "Tasks have different priorities. The batch starts a higher-priority task first; your queue order only breaks ties." };
  }
  return { guaranteed: true, note: "One task at a time, all with the same priority: ready tasks start in your queue order. A task waiting for a dependency is skipped until it is Done." };
}

export interface BatchEventRow {
  id: number;
  at: number;
  kind: string;
  taskId: string | null;
  text: string;
}

/* ────────────────────────────────────────────────────────────────────────── *
 * Stored-row sanitizer.
 * ────────────────────────────────────────────────────────────────────────── */

const BATCH_STATUSES: BatchStatus[] = ["draft", "approved", "running", "paused", "completed", "stopped", "cancelled"];

function sanitizeSourceQueue(value: unknown): BatchSourceQueue | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const v = value as Record<string, unknown>;
  if (typeof v.queueId !== "string" || typeof v.proposalId !== "string" || typeof v.planKey !== "string") return null;
  if (!Array.isArray(v.taskIds)) return null;
  return {
    queueId: v.queueId,
    proposalId: v.proposalId,
    queueRevision: typeof v.queueRevision === "number" ? v.queueRevision : 0,
    planKey: v.planKey,
    taskIds: v.taskIds.filter((id): id is string => typeof id === "string").slice(0, SCHEDULING_LIMITS.batchTasks),
    preparedAt: typeof v.preparedAt === "number" ? v.preparedAt : 0,
  };
}

export function sanitizeStoredBatch(value: unknown): ExecutionBatch | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const rec = value as Record<string, unknown>;
  if (typeof rec.id !== "string" || typeof rec.projectPath !== "string" || !Array.isArray(rec.entries)) return null;
  if (!BATCH_STATUSES.includes(rec.status as BatchStatus)) return null;
  const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : null);
  const entries = (rec.entries as unknown[]).filter((item): item is BatchEntry => {
    if (!item || typeof item !== "object") return false;
    const e = item as Record<string, unknown>;
    return typeof e.taskId === "string" && !!e.config && typeof e.config === "object" && Array.isArray(e.attempts);
  }).map((entry) => ({
    ...entry,
    approved: entry.approved ?? null,
    appliedFingerprint: entry.appliedFingerprint ?? null,
    launching: entry.launching ?? null,
    hold: entry.hold ?? null,
    failureSeen: num(entry.failureSeen) ?? 0,
    observed: entry.observed ?? null,
  }));
  const policy = readBatchPolicy(rec.policy ?? {}, defaultBatchPolicy(entries.length));
  return {
    id: rec.id,
    projectPath: rec.projectPath,
    title: typeof rec.title === "string" ? rec.title : "Execution batch",
    status: rec.status as BatchStatus,
    revision: num(rec.revision) ?? 1,
    entries,
    policy: typeof policy === "string" ? defaultBatchPolicy(entries.length) : policy,
    preview: rec.preview && typeof rec.preview === "object" ? (rec.preview as BatchPreview) : null,
    approval: rec.approval && typeof rec.approval === "object" ? (rec.approval as BatchApproval) : null,
    reason: rec.reason && typeof rec.reason === "object" ? (rec.reason as BatchReason) : null,
    sourceProposalId: typeof rec.sourceProposalId === "string" ? rec.sourceProposalId : null,
    sourceQueue: sanitizeSourceQueue(rec.sourceQueue),
    autonomy: sanitizeGrant(rec.autonomy),
    mappingNotes: Array.isArray(rec.mappingNotes) ? (rec.mappingNotes as ExecutionBatch["mappingNotes"]) : [],
    createdAt: num(rec.createdAt) ?? 0,
    updatedAt: num(rec.updatedAt) ?? 0,
    startedAt: num(rec.startedAt),
    deadlineAt: num(rec.deadlineAt),
    finishedAt: num(rec.finishedAt),
  };
}
