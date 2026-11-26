/**
 * Canonical smart execution queue evaluator & selector (FO-KANBAN-SMARTQUEUE01).
 *
 * Single source of truth shared by:
 *  - `src/bun/handsoff/driver.ts` (actual dispatch selection and worker assignment)
 *  - `GET /handsoff/queue` and `GET /handsoff/overview` (Kanban card statuses and project summary)
 *
 * Ordering policy for eligible ordinary hands-off tasks within one project:
 *   1. Active lifecycle continuations (`applying`, `testing`, `reviewing`, `fixing`, `developing`)
 *      are driven before brand-new `queued` tasks so active work never starves for QC or rework.
 *   2. Among `queued` tasks, canonical Kanban board order (`compareBoardTasks`):
 *      urgency descending (5..1) → persistent `board_rank` ascending → `created_at` ascending → `id`.
 *   3. Blocked or incompatible tasks (future `available_from_utc`, unfinished dependencies,
 *      busy pinned worker, provider rate limit) are skipped without blocking lower-ranked eligible tasks.
 *
 * Never mutates `task_priorities` or approved batch / mission snapshots.
 */
import { db, projects, runs, taskScheduling, tasks } from "../db.ts";
import { AssignmentCore } from "../assignment-core.ts";
import { autonomyPolicyStore } from "../autonomy/policy-store.ts";
import { missionAccountLimit } from "../orchestration/mission-resource.ts";
import { isTaskRunLive } from "../orchestrator.ts";
import { isProductionOwnerGateActive } from "../owner-trust/launch-gate.ts";
import { checkProjectLaunchAdmission, getProjectLifecycle } from "../project-lifecycle.ts";
import { ownerProjectOf, verifyLaunchScope } from "../project-ownership.ts";
import { isWorkspaceDevelopmentEnabled } from "../project-permissions.ts";
import { taskAvailabilityFor, taskAvailabilityNow } from "../task-availability.ts";
import { compareBoardTasks, normalizeUrgency } from "../../shared/board-order.ts";
import {
  DEFAULT_HANDSOFF_POLICY,
  effectiveHandsoffPolicy,
  type HandsoffBlockerCode,
  type HandsoffPolicy,
  type HandsoffRun,
} from "../../shared/handsoff.ts";
import type {
  SmartQueueCounts,
  SmartQueueNextCandidate,
  SmartQueueOverview,
  SmartQueueProjectSummary,
  SmartQueueTaskItem,
  SmartQueueWaitKind,
} from "../../shared/smart-queue.ts";
import type { Task } from "../../shared/types.ts";
import { authorizationView } from "./authorization.ts";
import { chooseResource } from "./resources.ts";
import { handsoffStore } from "./store.ts";

export interface TeamWorker {
  id: string;
  name: string;
  role_category: string;
  job_title: string;
}

export function projectTeam(projectPath: string): TeamWorker[] {
  return db
    .query<TeamWorker, [string]>(
      `SELECT id, name, role_category, job_title FROM ai_employees
         WHERE kind = 'worker' AND status = 'active' AND archived_at IS NULL AND project_path = ?
         ORDER BY created_at, id LIMIT 50`,
    )
    .all(projectPath);
}

export const isDeveloperWorker = (m: Pick<TeamWorker, "role_category" | "job_title">): boolean =>
  ["engineering", "architecture"].includes(m.role_category) || /developer|engineer|разработчик/i.test(m.job_title);

export const isReviewerWorker = (m: Pick<TeamWorker, "role_category" | "job_title">): boolean =>
  m.role_category === "quality" || /reviewer|ревьюер/i.test(m.job_title);

const AUTH_BLOCKER_CODES = new Set<HandsoffBlockerCode>([
  "authorization-missing",
  "authorization-expired",
  "authorization-exhausted",
  "authorization-renewal",
  "authorization-revoked",
  "owner-device-proof",
]);

/** Dependency check mirroring `driver.ts`: every prerequisite must be genuinely Done. */
export function dependencyHoldFor(taskId: string): { kind: "wait" | "block"; reason: string } | null {
  for (const id of taskScheduling.dependenciesOf(taskId)) {
    const dependency = tasks.get(id);
    if (!dependency) {
      return {
        kind: "block",
        reason: "A prerequisite task no longer exists. Clear or replace that dependency before this task can start.",
      };
    }
    if (dependency.column !== "done") {
      return { kind: "wait", reason: `Waiting for "${dependency.title}" to be done.` };
    }
  }
  return null;
}

/**
 * Employees currently executing a live Developer run in `projectPath`.
 * Used to avoid double-allocating one busy Developer while allowing multiple
 * Developers on the same project to work on distinct tasks in parallel.
 */
export function busyDeveloperEmployeeIds(
  projectPath: string,
  extraClaimedEmployeeIds?: ReadonlySet<string>,
  exceptRunId?: string,
): Set<string> {
  const busy = new Set<string>(extraClaimedEmployeeIds ? [...extraClaimedEmployeeIds] : []);
  const assignments = new AssignmentCore(db);
  const openRuns = handsoffStore.listOpenRuns(projectPath);
  for (const run of openRuns) {
    if (run.id === exceptRunId) continue;
    if (run.status !== "active") continue;
    if (run.stage === "developing" || run.state.launchIntent?.kind === "developer") {
      const empId = run.state.developer?.employeeId ?? assignments.forTask(run.taskId)?.employeeId;
      if (empId) busy.add(empId);
    }
  }
  // Also include any live non-QC runs started outside hands-off in the same project.
  const activeRunTasks = db
    .query<{ task_id: string }, []>(
      `SELECT DISTINCT task_id FROM runs WHERE status = 'running' AND qc_review_id IS NULL`,
    )
    .all();
  for (const row of activeRunTasks) {
    const task = tasks.get(row.task_id);
    if (!task) continue;
    if (ownerProjectOf(task.workdir) !== projectPath) continue;
    const assigned = assignments.forTask(task.id);
    if (assigned?.employeeId) busy.add(assigned.employeeId);
  }
  return busy;
}

/** Employees currently executing an active independent Reviewer run in `projectPath`. */
export function busyReviewerEmployeeIds(projectPath: string, exceptRunId?: string): Set<string> {
  const busy = new Set<string>();
  for (const run of handsoffStore.listOpenRuns(projectPath)) {
    if (run.id === exceptRunId || run.status !== "active" || run.stage !== "reviewing") continue;
    if (run.state.reviewer?.employeeId) busy.add(run.state.reviewer.employeeId);
  }
  return busy;
}

export interface QueueEvalOptions {
  now?: number;
  accountLimit?: typeof missionAccountLimit;
  /** Runs currently being claimed in-process (treated as active slots to prevent double dispatch). */
  claimingRunIds?: ReadonlySet<string>;
  /** Employees currently being claimed in-process for a Developer launch. */
  claimingEmployeeIds?: ReadonlySet<string>;
  /** Total count of enabled hands-off projects (used to report honest uncertainty across competing projects). */
  activeProjectCount?: number;
}

export interface DispatchCandidate {
  run: HandsoffRun;
  task: Task;
  /** Assigned or selected idle Developer id when available. */
  developerId: string | null;
}

export interface EvaluatedProjectQueue {
  summary: SmartQueueProjectSummary;
  /** Active lifecycle continuations (`applying`, `testing`, `reviewing`, `fixing`, `developing`) to drive first. */
  continuations: HandsoffRun[];
  /** Immediately dispatchable `queued` candidates in canonical Kanban order (`compareBoardTasks`). */
  dispatchable: DispatchCandidate[];
  /** Remaining `queued` runs that should be synced to waiting/blocked state if needed. */
  waitingQueued: Array<{ run: HandsoffRun; waitKind: SmartQueueWaitKind; reason: string | null; waitUntil: number | null }>;
}

const STAGE_CONTINUATION_PRIORITY: Record<string, number> = {
  applying: 0,
  testing: 1,
  reviewing: 2,
  fixing: 3,
  developing: 4,
};

export function evaluateProjectQueue(projectPath: string, options: QueueEvalOptions = {}): EvaluatedProjectQueue {
  const now = options.now ?? taskAvailabilityNow();
  const limitFn = options.accountLimit ?? missionAccountLimit;
  const claimingRunIds = options.claimingRunIds ?? new Set<string>();
  const stored = handsoffStore.getPolicy(projectPath);
  const livePolicy: HandsoffPolicy = stored?.policy ?? { ...DEFAULT_HANDSOFF_POLICY };
  const auth = authorizationView(projectPath);
  const lifecycleSnap = getProjectLifecycle(projectPath);
  const admission = checkProjectLaunchAdmission(projectPath);
  const emergencyStop = autonomyPolicyStore.readEmergency().active;
  const workingCopyEnabled = isWorkspaceDevelopmentEnabled(projectPath);
  const productionGate = isProductionOwnerGateActive();
  const authActive = !productionGate || auth.state === "active" || auth.state === "not-required";

  const members = projectTeam(projectPath);
  const developers = members.filter(isDeveloperWorker);
  const devById = new Map(developers.map((m) => [m.id, m]));
  const busyDevs = busyDeveloperEmployeeIds(projectPath, options.claimingEmployeeIds);
  const idleDevs = developers.filter((d) => !busyDevs.has(d.id));
  const assignments = new AssignmentCore(db);

  const openRuns = handsoffStore.listOpenRuns(projectPath);
  const activeSlots = openRuns.filter((r) => {
    if (claimingRunIds.has(r.id)) return true;
    if (r.stage !== "developing" && r.stage !== "reviewing" && r.stage !== "fixing") return false;
    if (r.status === "active") return true;
    if (r.status === "waiting" && admission.allowed && (r.state.waitUntil == null || r.state.waitUntil <= now)) return true;
    return false;
  }).length;

  const continuations: HandsoffRun[] = [];
  const queuedEntries: Array<{ run: HandsoffRun; task: Task }> = [];
  const activeItems: SmartQueueTaskItem[] = [];

  for (const run of openRuns) {
    const task = tasks.get(run.taskId);
    if (!task || task.archivedAt != null) continue;
    const assigned = assignments.forTask(task.id);
    const assignedEmployeeId = run.state.developer?.employeeId ?? assigned?.employeeId ?? null;
    const assignedEmployeeName =
      run.state.developer?.employeeName ??
      (assignedEmployeeId ? (devById.get(assignedEmployeeId)?.name ?? null) : null);

    if (run.stage !== "queued") {
      // Active lifecycle stage (developing, testing, reviewing, fixing, applying)
      if (run.status === "active" || run.status === "waiting") {
        continuations.push(run);
      }
      let category: SmartQueueTaskItem["category"] = "running";
      let waitKind: SmartQueueWaitKind = null;
      let reason: string | null = null;
      if (emergencyStop || run.status === "stopped") {
        category = "stopped";
        waitKind = emergencyStop ? "emergency-stop" : !livePolicy.enabled ? "policy-off" : null;
        reason = emergencyStop ? "Emergency Stop is active." : "Stopped.";
      } else if (run.status === "needs-owner") {
        category = "blocked";
        waitKind = run.blocker && AUTH_BLOCKER_CODES.has(run.blocker.code) ? "authorization" : "needs-owner";
        reason = run.blocker?.message ?? "Needs Owner attention.";
      } else if (run.status === "waiting") {
        // Still part of active lifecycle (e.g., waiting for provider reset before review, or project paused before review/fix)
        if (!admission.allowed) {
          category = "waiting";
          waitKind = "project-paused";
          reason = admission.reason ?? "The project is paused.";
        } else if (run.state.waitKind === "provider-limit" || (run.state.waitUntil != null && run.state.waitKind !== "scheduled")) {
          category = "waiting";
          waitKind = "provider-limit";
          reason = run.state.waitReason;
        } else {
          category = "running";
          waitKind = run.state.waitKind ?? null;
          reason = run.state.waitReason;
        }
      }
      activeItems.push({
        taskId: task.id,
        runId: run.id,
        projectPath,
        title: task.title,
        urgency: normalizeUrgency(task.urgency),
        boardRank: task.boardRank ?? 0,
        availableFromUtc: task.availableFromUtc ?? null,
        stage: run.stage,
        runStatus: run.status,
        category,
        waitKind,
        waitUntil: run.state.waitUntil,
        reason,
        queuePosition: null,
        uncertainNext: false,
        assignedEmployeeId,
        assignedEmployeeName,
      });
      continue;
    }

    queuedEntries.push({ run, task });
  }

  // Sort active continuations so completion stages (`applying` -> `testing` -> `reviewing` -> `fixing`) come first.
  continuations.sort((a, b) => {
    const pa = STAGE_CONTINUATION_PRIORITY[a.stage] ?? 9;
    const pb = STAGE_CONTINUATION_PRIORITY[b.stage] ?? 9;
    if (pa !== pb) return pa - pb;
    const ta = tasks.get(a.taskId);
    const tb = tasks.get(b.taskId);
    if (ta && tb) return compareBoardTasks(ta, tb);
    return a.createdAt - b.createdAt;
  });

  // Sort ALL queued entries strictly by canonical Kanban order: urgency DESC -> boardRank ASC -> createdAt ASC -> id ASC.
  queuedEntries.sort((a, b) => compareBoardTasks(a.task, b.task));

  const queuedItems: SmartQueueTaskItem[] = [];
  const dispatchable: DispatchCandidate[] = [];
  const waitingQueued: EvaluatedProjectQueue["waitingQueued"] = [];
  const simulatedIdle = [...idleDevs];
  const simulatedBusy = new Set<string>(busyDevs);
  let simulatedSlots = activeSlots;
  let eligibleRank = 0;

  const activeProjectCount =
    options.activeProjectCount ??
    handsoffStore.listPolicies().filter((p) => p.policy.enabled).length;
  const hasMultipleCompetingProjects = activeProjectCount > 1;
  const hasExplicitPins = queuedEntries.some(({ task }) => Boolean(assignments.forTask(task.id)));

  for (const { run, task } of queuedEntries) {
    const policy = effectiveHandsoffPolicy(run.policy, stored?.policy ?? null);
    const assigned = assignments.forTask(task.id);
    const assignedEmployeeId = assigned?.employeeId ?? null;
    const assignedEmployeeName = assignedEmployeeId ? (devById.get(assignedEmployeeId)?.name ?? null) : null;

    const baseItem = {
      taskId: task.id,
      runId: run.id,
      projectPath,
      title: task.title,
      urgency: normalizeUrgency(task.urgency),
      boardRank: task.boardRank ?? 0,
      availableFromUtc: task.availableFromUtc ?? null,
      stage: run.stage,
      runStatus: run.status,
      assignedEmployeeId,
      assignedEmployeeName,
    };

    // If this run is already actively claiming in-process or has a live run, treat as running.
    if (claimingRunIds.has(run.id) || isTaskRunLive(task.id)) {
      queuedItems.push({
        ...baseItem,
        category: "running",
        waitKind: null,
        waitUntil: null,
        reason: null,
        queuePosition: null,
        uncertainNext: false,
      });
      continue;
    }

    // Gate 1: Emergency Stop
    if (emergencyStop) {
      queuedItems.push({
        ...baseItem,
        category: "stopped",
        waitKind: "emergency-stop",
        waitUntil: null,
        reason: "Emergency Stop is active. Nothing new will start.",
        queuePosition: null,
        uncertainNext: false,
      });
      continue;
    }

    // Gate 2: Explicitly stopped run or policy turned off
    if (run.status === "stopped" || !policy.enabled) {
      queuedItems.push({
        ...baseItem,
        category: "stopped",
        waitKind: !policy.enabled ? "policy-off" : null,
        waitUntil: null,
        reason: !policy.enabled ? "Work independently is off for this project." : "Stopped.",
        queuePosition: null,
        uncertainNext: false,
      });
      continue;
    }

    // Gate 3: Existing needs-owner blocker on this run
    if (run.status === "needs-owner") {
      const waitKind: SmartQueueWaitKind =
        run.blocker && AUTH_BLOCKER_CODES.has(run.blocker.code) ? "authorization" : "needs-owner";
      queuedItems.push({
        ...baseItem,
        category: "blocked",
        waitKind,
        waitUntil: null,
        reason: run.blocker?.message ?? "Needs Owner attention.",
        queuePosition: null,
        uncertainNext: false,
      });
      continue;
    }

    // Gate 4: Project lifecycle (paused / draining / recovering / invalid)
    if (!admission.allowed) {
      const reason = admission.reason ?? "The project is paused. Nothing was started.";
      queuedItems.push({
        ...baseItem,
        category: "waiting",
        waitKind: "project-paused",
        waitUntil: null,
        reason,
        queuePosition: null,
        uncertainNext: false,
      });
      waitingQueued.push({ run, waitKind: "project-paused", reason, waitUntil: null });
      continue;
    }

    // Gate 5: Scheduled UTC availability (checked BEFORE auth/slots/provider so waiting consumes 0 resources)
    const availability = taskAvailabilityFor(task, now);
    if (!availability.available) {
      const reason = "Waiting for scheduled time.";
      queuedItems.push({
        ...baseItem,
        category: "waiting",
        waitKind: "scheduled",
        waitUntil: availability.availableFromMs,
        reason,
        queuePosition: null,
        uncertainNext: false,
      });
      waitingQueued.push({ run, waitKind: "scheduled", reason, waitUntil: availability.availableFromMs });
      continue;
    }

    // Gate 6: Working copy enabled
    if (!workingCopyEnabled) {
      queuedItems.push({
        ...baseItem,
        category: "blocked",
        waitKind: "needs-owner",
        waitUntil: null,
        reason: "Development in a working copy is off for this project.",
        queuePosition: null,
        uncertainNext: false,
      });
      continue;
    }

    // Gate 7: Project-level Owner authorization (active + remaining budget)
    if (!authActive) {
      queuedItems.push({
        ...baseItem,
        category: "blocked",
        waitKind: "authorization",
        waitUntil: null,
        reason: `Project hands-off authorization is ${auth.state}.`,
        queuePosition: null,
        uncertainNext: false,
      });
      continue;
    }

    // Gate 8: Project ownership scope
    const scope = verifyLaunchScope(task, projectPath);
    if (!scope.ok) {
      queuedItems.push({
        ...baseItem,
        category: "blocked",
        waitKind: "needs-owner",
        waitUntil: null,
        reason: scope.reason ?? "The task is outside this project.",
        queuePosition: null,
        uncertainNext: false,
      });
      continue;
    }

    // Gate 9: Task dependencies
    const depHold = dependencyHoldFor(task.id);
    if (depHold) {
      queuedItems.push({
        ...baseItem,
        category: depHold.kind === "wait" ? "waiting" : "blocked",
        waitKind: depHold.kind === "wait" ? "dependency" : "needs-owner",
        waitUntil: null,
        reason: depHold.reason,
        queuePosition: null,
        uncertainNext: false,
      });
      if (depHold.kind === "wait") {
        waitingQueued.push({ run, waitKind: "dependency", reason: depHold.reason, waitUntil: null });
      }
      continue;
    }

    // Gate 10: Covered resource & provider rate limits
    const chosen = chooseResource({
      taskId: task.id,
      projectPath,
      title: task.title,
      role: "developer",
      policy,
      requested: run.state.requested,
    });
    if (!chosen.ok) {
      queuedItems.push({
        ...baseItem,
        category: "blocked",
        waitKind: "needs-owner",
        waitUntil: null,
        reason: chosen.message,
        queuePosition: null,
        uncertainNext: false,
      });
      continue;
    }
    const limit = limitFn(
      { harnessId: chosen.resource.harnessId, accountId: chosen.resource.accountId, modelId: chosen.resource.modelId },
      "developer",
      now,
    );
    if (limit) {
      const knownReset = limit.resetAt != null && limit.resetAt > now;
      const reason = knownReset
        ? `The account ${limit.accountLabel} reached its provider limit. Work continues when it resets.`
        : `The account ${limit.accountLabel} reached its provider limit and its reset time is unknown.`;
      queuedItems.push({
        ...baseItem,
        category: knownReset ? "waiting" : "blocked",
        waitKind: "provider-limit",
        waitUntil: knownReset ? limit.resetAt : null,
        reason,
        queuePosition: null,
        uncertainNext: false,
      });
      if (knownReset) {
        waitingQueued.push({ run, waitKind: "provider-limit", reason, waitUntil: limit.resetAt });
      }
      continue;
    }

    // Gate 11: Worker compatibility & occupancy
    if (assignedEmployeeId) {
      if (simulatedBusy.has(assignedEmployeeId)) {
        const reason = "Waiting for an available worker.";
        queuedItems.push({
          ...baseItem,
          category: "waiting",
          waitKind: "worker",
          waitUntil: null,
          reason,
          queuePosition: null,
          uncertainNext: false,
        });
        waitingQueued.push({ run, waitKind: "worker", reason, waitUntil: null });
        continue;
      }
    } else if (!policy.autoAssign || developers.length === 0) {
      queuedItems.push({
        ...baseItem,
        category: "blocked",
        waitKind: "needs-owner",
        waitUntil: null,
        reason: developers.length === 0
          ? "This project has no active Developer on its team."
          : "The task has no assigned worker and automatic assignment is off.",
        queuePosition: null,
        uncertainNext: false,
      });
      continue;
    }

    // Task passed ALL prerequisite gates! It is genuinely eligible in Kanban order.
    eligibleRank += 1;
    const isNext = eligibleRank === 1;
    const uncertainNext = hasMultipleCompetingProjects || (developers.length > 1 && hasExplicitPins);

    // Check whether capacity + a compatible idle worker exist right now to dispatch this candidate.
    let selectedDevId: string | null = null;
    if (simulatedSlots < policy.maxParallel) {
      if (assignedEmployeeId) {
        const idx = simulatedIdle.findIndex((d) => d.id === assignedEmployeeId);
        if (idx >= 0) {
          selectedDevId = assignedEmployeeId;
          simulatedIdle.splice(idx, 1);
          simulatedBusy.add(selectedDevId);
          simulatedSlots += 1;
        } else if (!simulatedBusy.has(assignedEmployeeId)) {
          // Assigned worker may have a non-standard job title (valid explicit assignment) and is not busy.
          selectedDevId = assignedEmployeeId;
          simulatedBusy.add(selectedDevId);
          simulatedSlots += 1;
        }
      } else if (simulatedIdle.length > 0) {
        const picked = simulatedIdle.shift()!;
        selectedDevId = picked.id;
        simulatedBusy.add(selectedDevId);
        simulatedSlots += 1;
      }
    }

    if (selectedDevId !== null) {
      dispatchable.push({ run, task, developerId: selectedDevId });
    }

    const waitKind: SmartQueueWaitKind =
      selectedDevId !== null
        ? null
        : activeSlots >= policy.maxParallel
          ? "slot"
          : idleDevs.length === 0
            ? "worker"
            : "slot";

    const reason =
      selectedDevId !== null
        ? null
        : waitKind === "worker"
          ? "Waiting for an available worker."
          : "Waiting for a free slot in this project.";

    queuedItems.push({
      ...baseItem,
      category: isNext ? "next" : "queued",
      waitKind,
      waitUntil: null,
      reason,
      queuePosition: eligibleRank,
      uncertainNext: isNext && uncertainNext,
    });
    if (selectedDevId === null && reason) {
      waitingQueued.push({ run, waitKind, reason, waitUntil: null });
    }
  }

  const allItems = [...activeItems, ...queuedItems];
  const counts: SmartQueueCounts = {
    running: 0,
    eligible: 0,
    waitingScheduled: 0,
    waitingDependency: 0,
    waitingResource: 0,
    blocked: 0,
    waitingTotal: 0,
  };

  for (const item of allItems) {
    if (item.category === "running") {
      counts.running += 1;
    } else if (item.category === "next" || item.category === "queued") {
      counts.eligible += 1;
      counts.waitingTotal += 1;
    } else if (item.waitKind === "scheduled") {
      counts.waitingScheduled += 1;
      counts.waitingTotal += 1;
    } else if (item.waitKind === "dependency") {
      counts.waitingDependency += 1;
      counts.waitingTotal += 1;
    } else if (item.waitKind === "worker" || item.waitKind === "provider-limit" || item.waitKind === "slot") {
      counts.waitingResource += 1;
      counts.waitingTotal += 1;
    } else {
      counts.blocked += 1;
      counts.waitingTotal += 1;
    }
  }

  const firstEligible = queuedItems.find((item) => item.category === "next") ?? null;
  const expectedNext: SmartQueueNextCandidate | null = firstEligible
    ? {
        taskId: firstEligible.taskId,
        title: firstEligible.title,
        urgency: firstEligible.urgency,
        uncertain: firstEligible.uncertainNext,
      }
    : null;

  const summary: SmartQueueProjectSummary = {
    projectPath,
    enabled: livePolicy.enabled,
    authorizationState: auth.state,
    launchesRemaining: auth.launchesRemaining,
    lifecycleState: lifecycleSnap?.state ?? "running",
    emergencyStop,
    maxParallel: livePolicy.maxParallel,
    activeSlots,
    totalDevelopers: developers.length,
    idleDevelopers: idleDevs.length,
    counts,
    expectedNext,
    items: allItems,
  };

  return { summary, continuations, dispatchable, waitingQueued };
}

/** Build canonical smart queue summaries for all projects that have an enabled policy or open runs. */
export function buildSmartQueueOverview(options: Omit<QueueEvalOptions, "activeProjectCount"> = {}): SmartQueueOverview {
  const now = options.now ?? taskAvailabilityNow();
  const projectPaths = new Set<string>();
  const policies = handsoffStore.listPolicies();
  let enabledCount = 0;
  for (const stored of policies) {
    if (stored.policy.enabled) {
      enabledCount += 1;
      projectPaths.add(stored.projectPath);
    }
  }
  for (const run of handsoffStore.listOpenRuns()) {
    projectPaths.add(run.projectPath);
  }
  const orderedPaths = [...projectPaths].filter((p) => Boolean(projects.get(p))).sort();
  return {
    generatedAt: now,
    projects: orderedPaths.map(
      (projectPath) =>
        evaluateProjectQueue(projectPath, { ...options, now, activeProjectCount: enabledCount }).summary,
    ),
  };
}
