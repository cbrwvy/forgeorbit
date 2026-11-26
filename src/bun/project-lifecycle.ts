/**
 * FO-PROJECT-LIFECYCLE01 — Project-wide Start / Stop AI execution lifecycle.
 *
 * Enforces one shared project-scoped launch admission contract across board
 * task starts, follow-up turns, professional multi-turn runtime, fx recovery,
 * supervised execution, Employee execution, QC Reviewer / QC recovery runs,
 * PM-orchestrated workflows & batches, Execution Batches, Head-of-PM
 * sequential coordination, Project Manager turns, and Project Interviews.
 *
 * Never kills active provider processes on Stop, never deletes tasks/runs/QC/
 * workspaces/grants, and never touches local dev servers, Docker, Caddy, or
 * cluster deployments.
 */

import { existsSync, realpathSync, statSync } from "node:fs";
import path from "node:path";
import { ActivityJournalCore } from "./activity-journal-core.ts";
import { db, projects, runs, tasks } from "./db.ts";
import { notifySmartQueueChanged } from "./handsoff/queue-events.ts";
import { createFreshOwnershipResolver, ownerProjectOf } from "./project-ownership.ts";
import { broadcastAppEvent } from "./quit-guard.ts";
import { capText } from "../shared/project-interview.ts";
import {
  isValidProjectLifecycleState,
  type EffectiveProjectLifecycleState,
  type ProjectLifecycleActionResult,
  type ProjectLifecycleActiveBreakdown,
  type ProjectLifecycleSnapshot,
  type ProjectLifecycleUnavailableCode,
} from "../shared/project-lifecycle.ts";
import type { Project, Task } from "../shared/types.ts";

export class ProjectLifecycleError extends Error {
  constructor(
    message: string,
    readonly status: 400 | 404 | 409 = 409,
    readonly code = "project-lifecycle",
  ) {
    super(message);
    this.name = "ProjectLifecycleError";
  }
}

type TaskLiveProbe = (taskId: string) => boolean;
type ManagerLiveProbe = (projectPath: string) => boolean;
type InterviewLiveProbe = (projectPath: string) => number;
type ReconcileStartingProbe = (projectPath: string) => number;

let taskLiveProbe: TaskLiveProbe | null = null;
let managerLiveProbe: ManagerLiveProbe | null = null;
let interviewLiveProbe: InterviewLiveProbe | null = null;
let reconcileStartingProbe: ReconcileStartingProbe | null = null;

/** Registered by `orchestrator.ts` on load. */
export function registerProjectLifecycleTaskProbe(probe: TaskLiveProbe): void {
  taskLiveProbe = probe;
}

/** Registered by `project-manager.ts` on load. */
/** Task ids whose earlier run left a recorded process that is not observed gone (read-only; never signals). */
type ProcessLiveProbe = () => string[];
let processLiveProbe: ProcessLiveProbe | null = null;
export function registerProjectLifecycleProcessProbe(probe: ProcessLiveProbe): void {
  processLiveProbe = probe;
}

export function registerProjectLifecycleManagerProbe(probe: ManagerLiveProbe): void {
  managerLiveProbe = probe;
}

/** Registered by `project-interview.ts` on load. */
export function registerProjectLifecycleInterviewProbe(probe: InterviewLiveProbe): void {
  interviewLiveProbe = probe;
}

/** Registered by `project-execution.ts` on load. */
export function registerProjectLifecycleStartingReconciler(probe: ReconcileStartingProbe): void {
  reconcileStartingProbe = probe;
}

/** Tracks projects actively executing bounded `startProjectLifecycle` reconciliation in this process. */
const activeRecoveringProjects = new Set<string>();

/** Per-project serialized promise chain so concurrent Start and Stop never race. */
const projectLocks = new Map<string, Promise<void>>();

function withProjectLifecycleLock<T>(projectPath: string, fn: () => Promise<T> | T): Promise<T> {
  const previous = projectLocks.get(projectPath) ?? Promise.resolve();
  const current = previous.then(() => fn(), () => fn());
  const tail = current.then(() => undefined, () => undefined);
  projectLocks.set(projectPath, tail);
  void tail.then(() => {
    if (projectLocks.get(projectPath) === tail) projectLocks.delete(projectPath);
  });
  return current;
}

/** Resolve an input path to a registered project's canonical stored `path` key. */
export function resolveRegisteredProjectPath(rawPath: unknown):
  | { ok: true; projectPath: string }
  | { ok: false; status: 400 | 404; error: string } {
  if (typeof rawPath !== "string" || !rawPath.trim()) {
    return { ok: false, status: 400, error: "projectPath is required." };
  }
  const trimmed = rawPath.trim();
  if (!path.isAbsolute(trimmed) || trimmed.includes("\0")) {
    return { ok: false, status: 400, error: "projectPath must be an absolute path." };
  }
  const normalized = path.resolve(trimmed);
  const direct = projects.get(trimmed) ?? projects.get(normalized);
  if (direct) return { ok: true, projectPath: direct.path };
  let targetReal: string | null = null;
  try {
    targetReal = realpathSync(normalized);
  } catch {
    targetReal = null;
  }
  if (targetReal) {
    for (const candidate of projects.list()) {
      try {
        if (realpathSync(candidate.path) === targetReal) {
          return { ok: true, projectPath: candidate.path };
        }
      } catch {
        // Ignore missing directories while matching realpaths.
      }
    }
  }
  return { ok: false, status: 404, error: "Project is not registered in ForgeOrbit." };
}

function isTaskCurrentlyLive(taskId: string): boolean {
  if (taskLiveProbe) return taskLiveProbe(taskId);
  return runs.listForTask(taskId).some((run) => run.status === "running");
}

function computeActiveExecutionsByProject(
  projectPaths: readonly string[],
): Map<string, { total: number; breakdown: ProjectLifecycleActiveBreakdown }> {
  const want = new Set(projectPaths);
  const taskRunCounts = new Map<string, number>();
  const unconfirmedCounts = new Map<string, number>();

  if (want.size > 0) {
    const allTasks = tasks.list();
    const byId = new Map<string, Task>(allTasks.map((task) => [task.id, task]));
    const liveTasks: Task[] = [];
    const liveIds = new Set<string>();
    for (const task of allTasks) {
      if (isTaskCurrentlyLive(task.id)) {
        liveTasks.push(task);
        liveIds.add(task.id);
      }
    }
    const unconfirmedTaskIds = processLiveProbe
      ? [...new Set(processLiveProbe())].filter((id) => !liveIds.has(id) && byId.has(id))
      : [];

    // Avoid filesystem realpath scans altogether when zero tasks or unconfirmed processes are live.
    if (liveTasks.length > 0 || unconfirmedTaskIds.length > 0) {
      const resolveOwner = createFreshOwnershipResolver();
      for (const task of liveTasks) {
        const root = task.pipelineParentId ? byId.get(task.pipelineParentId) ?? task : task;
        const owner = resolveOwner(root.workdir);
        if (owner.kind === "owned" && want.has(owner.projectPath)) {
          taskRunCounts.set(owner.projectPath, (taskRunCounts.get(owner.projectPath) ?? 0) + 1);
        }
      }
      for (const taskId of unconfirmedTaskIds) {
        const task = byId.get(taskId)!;
        const root = task.pipelineParentId ? byId.get(task.pipelineParentId) ?? task : task;
        const owner = resolveOwner(root.workdir);
        if (owner.kind === "owned" && want.has(owner.projectPath)) {
          unconfirmedCounts.set(owner.projectPath, (unconfirmedCounts.get(owner.projectPath) ?? 0) + 1);
        }
      }
    }
  }

  const out = new Map<string, { total: number; breakdown: ProjectLifecycleActiveBreakdown }>();
  for (const projectPath of projectPaths) {
    const taskRuns = taskRunCounts.get(projectPath) ?? 0;
    const unconfirmedProcesses = unconfirmedCounts.get(projectPath) ?? 0;
    const managerTurns = managerLiveProbe?.(projectPath) ? 1 : 0;
    const interviewTurns = interviewLiveProbe ? Math.max(0, interviewLiveProbe(projectPath)) : 0;
    out.set(projectPath, {
      total: taskRuns + unconfirmedProcesses + managerTurns + interviewTurns,
      breakdown: { taskRuns, managerTurns, interviewTurns, unconfirmedProcesses },
    });
  }
  return out;
}

/**
 * Count active AI executions belonging to `projectPath` from trustworthy
 * runtime/persisted records only (task runs including hidden pipeline step
 * runs, Project Manager turn, and Project Interview turns).
 */
export function countActiveProjectExecutions(projectPath: string): {
  total: number;
  breakdown: ProjectLifecycleActiveBreakdown;
} {
  return (
    computeActiveExecutionsByProject([projectPath]).get(projectPath) ?? {
      total: 0,
      breakdown: { taskRuns: 0, managerTurns: 0, interviewTurns: 0, unconfirmedProcesses: 0 },
    }
  );
}

function effectiveStateOf(persistedState: string, projectPath: string): EffectiveProjectLifecycleState {
  if (!isValidProjectLifecycleState(persistedState)) return "invalid";
  // A persisted `recovering` row with no in-flight recovery call in this process
  // means a prior transition was interrupted; fail closed until reconciled.
  if (persistedState === "recovering" && !activeRecoveringProjects.has(projectPath)) {
    return "invalid";
  }
  return persistedState;
}

function blockerMessageFor(
  state: EffectiveProjectLifecycleState,
  activeExecutions: number,
  persistedState: string,
): string | null {
  switch (state) {
    case "running":
      return null;
    case "draining":
      return `Project Stop was requested; draining ${activeExecutions} active AI execution${activeExecutions === 1 ? "" : "s"}. New AI launches are blocked.`;
    case "paused":
      return "Project AI execution is paused. Resume the project before launching new AI work.";
    case "recovering":
      return "Project is reconciling run state before resuming. New AI launches remain blocked until recovery completes.";
    case "invalid":
      return `Persisted project lifecycle state "${capText(String(persistedState), 40)}" is invalid or interrupted and fails closed. New AI launches are blocked.`;
  }
}

function recordLifecycleJournal(
  projectPath: string,
  actorType: "owner" | "system",
  eventType:
    | "project.lifecycle.draining"
    | "project.lifecycle.paused"
    | "project.lifecycle.resumed"
    | "project.lifecycle.reconciled",
  payload: Record<string, unknown>,
  at: number,
  keySuffix: string,
): void {
  try {
    new ActivityJournalCore(db).record({
      eventType,
      projectPath,
      actorType,
      actorId: actorType === "owner" ? "owner" : "runtime",
      targetType: "project",
      targetId: projectPath,
      idempotencyKey: `project-lifecycle:${projectPath}:${eventType}:${at}:${keySuffix}`,
      payload: { projectPath, ...payload },
      createdAt: at,
    });
  } catch (error) {
    console.warn(`[project-lifecycle] failed to append activity journal event ${eventType}:`, error);
  }
}

function emitLifecycleEvent(projectPath: string, state: EffectiveProjectLifecycleState, activeExecutions: number, ts = Date.now()): void {
  broadcastAppEvent({
    type: "project_lifecycle",
    projectPath,
    state,
    activeExecutions,
    ts,
  });
}

function buildSnapshot(
  projectPath: string,
  persistedState: string,
  updatedAt: number | null,
  reason: string | null,
  counts = countActiveProjectExecutions(projectPath),
): ProjectLifecycleSnapshot {
  const state = effectiveStateOf(persistedState, projectPath);
  const activeExecutions = counts.total;
  const launchesBlocked = state !== "running";
  const waitingForActiveWork = state === "draining" && activeExecutions > 0;

  let canStart = false;
  let startUnavailableCode: ProjectLifecycleUnavailableCode | null = null;
  let startUnavailableReason: string | null = null;
  let canStop = false;
  let stopUnavailableCode: ProjectLifecycleUnavailableCode | null = null;
  let stopUnavailableReason: string | null = null;

  switch (state) {
    case "running":
      canStart = false;
      startUnavailableCode = "already-running";
      startUnavailableReason = "Project is already running.";
      canStop = true;
      break;
    case "draining":
      canStart = false;
      startUnavailableCode = "draining-active-work";
      startUnavailableReason = `Waiting for ${activeExecutions} active AI execution${activeExecutions === 1 ? "" : "s"} to finish before the project can be resumed.`;
      canStop = false;
      stopUnavailableCode = "already-draining";
      stopUnavailableReason = `Stop was already requested; waiting for ${activeExecutions} active AI execution${activeExecutions === 1 ? "" : "s"} to finish.`;
      break;
    case "paused":
      canStart = true;
      canStop = false;
      stopUnavailableCode = "already-paused";
      stopUnavailableReason = "Project is already paused.";
      break;
    case "recovering":
      canStart = false;
      startUnavailableCode = "recovering";
      startUnavailableReason = "Project is reconciling run state before resuming.";
      canStop = false;
      stopUnavailableCode = "recovering";
      stopUnavailableReason = "Project is reconciling run state.";
      break;
    case "invalid":
      canStart = false;
      startUnavailableCode = "invalid-state";
      startUnavailableReason = "Persisted project lifecycle state is invalid and fails closed. Stop the project first to reset it safely.";
      canStop = true;
      break;
  }

  return {
    projectPath,
    state,
    persistedState,
    launchesBlocked,
    waitingForActiveWork,
    activeExecutions,
    activeBreakdown: counts.breakdown,
    canStart,
    canStop,
    startUnavailableCode,
    startUnavailableReason,
    stopUnavailableCode,
    stopUnavailableReason,
    blockerReason: blockerMessageFor(state, activeExecutions, persistedState),
    updatedAt,
    reason,
  };
}

/**
 * Settle `draining` → `paused` if and only if the project is currently persisted
 * as `draining` and all active AI executions in this project have finished.
 */
export function reconcileProjectDrain(
  projectPath: string,
  precomputedCounts?: { total: number; breakdown: ProjectLifecycleActiveBreakdown },
  rawRow?: ReturnType<typeof projects.getLifecycleRaw>,
): ProjectLifecycleSnapshot | null {
  const row = rawRow ?? projects.getLifecycleRaw(projectPath);
  if (!row) return null;
  const counts = precomputedCounts ?? countActiveProjectExecutions(projectPath);
  if (row.lifecycleState === "draining" && counts.total === 0) {
    const now = Date.now();
    const reason = row.lifecycleReason ?? "Stopped by the owner; active AI work finished.";
    const updated = projects.setLifecycleState(projectPath, "paused", reason, now) ?? row;
    recordLifecycleJournal(
      projectPath,
      "system",
      "project.lifecycle.paused",
      { previousState: "draining", activeExecutions: 0, reason },
      now,
      "drain-settled",
    );
    emitLifecycleEvent(projectPath, "paused", 0, now);
    return buildSnapshot(projectPath, updated.lifecycleState, updated.lifecycleUpdatedAt, updated.lifecycleReason, counts);
  }
  if (row.lifecycleState === "draining" && (counts.breakdown.unconfirmedProcesses ?? 0) > 0) ensureDrainWatch();
  return buildSnapshot(projectPath, row.lifecycleState, row.lifecycleUpdatedAt, row.lifecycleReason, counts);
}

/**
 * A drain held only by a process that is not observed gone has no run event to settle it. While one exists, look again
 * on a short interval (reads only) so the project settles to Paused once the process is gone, and not before.
 */
let drainWatch: ReturnType<typeof setInterval> | null = null;
const DRAIN_WATCH_MS = 3000;
function ensureDrainWatch(): void {
  if (drainWatch) return;
  drainWatch = setInterval(() => {
    let still = false;
    for (const row of projects.listLifecycleRaw()) {
      if (row.lifecycleState !== "draining") continue;
      const snap = reconcileProjectDrain(row.path);
      if (snap && snap.state === "draining" && (snap.activeBreakdown.unconfirmedProcesses ?? 0) > 0) still = true;
    }
    if (!still && drainWatch) { clearInterval(drainWatch); drainWatch = null; }
  }, DRAIN_WATCH_MS);
  (drainWatch as unknown as { unref?: () => void }).unref?.();
}
export function stopProjectDrainWatch(): void {
  if (drainWatch) { clearInterval(drainWatch); drainWatch = null; }
}

/** Sweep every registered project currently persisted in `draining`. */
export function reconcileAllDrainingProjects(): void {
  for (const row of projects.listLifecycleRaw()) {
    if (row.lifecycleState === "draining") {
      reconcileProjectDrain(row.path);
    }
  }
}

/** Settle drain for the project owning `taskId`, if any. */
export function reconcileProjectDrainForTask(taskId: string): void {
  const task = tasks.get(taskId);
  if (!task) {
    reconcileAllDrainingProjects();
    return;
  }
  const root = task.pipelineParentId ? tasks.get(task.pipelineParentId) ?? task : task;
  const projectPath = ownerProjectOf(root.workdir, { fresh: true });
  if (projectPath) reconcileProjectDrain(projectPath);
}

/** Authoritative snapshot for one registered project path (or null if unregistered). */
export function getProjectLifecycle(projectPath: string): ProjectLifecycleSnapshot | null {
  return reconcileProjectDrain(projectPath);
}

/** List all registered projects enriched with their live `ProjectLifecycleSnapshot`. */
export function listProjectsWithLifecycle(): Project[] {
  const projectRows = projects.list();
  const countsByProject = computeActiveExecutionsByProject(projectRows.map((p) => p.path));
  const rawByProject = new Map(projects.listLifecycleRaw().map((r) => [r.path, r]));
  return projectRows.map((project) => {
    let existsOnDisk = false;
    try {
      existsOnDisk = existsSync(project.path) && statSync(project.path).isDirectory();
    } catch {
      existsOnDisk = false;
    }
    return {
      ...project,
      existsOnDisk,
      requiresUserIntervention: !existsOnDisk,
      lifecycle:
        reconcileProjectDrain(
          project.path,
          countsByProject.get(project.path),
          rawByProject.get(project.path),
        ) ?? undefined,
    };
  });
}

export interface ProjectLaunchAdmission {
  allowed: boolean;
  projectPath: string | null;
  state: EffectiveProjectLifecycleState | null;
  reason: string | null;
}

/**
 * Shared project lifecycle launch admission check for a known registered
 * `projectPath`. Fails closed on `draining`, `paused`, `recovering`, and any
 * unknown/corrupted persisted state (`invalid`).
 */
export function checkProjectLaunchAdmission(projectPath: string): ProjectLaunchAdmission {
  const resolved = resolveRegisteredProjectPath(projectPath);
  const canonicalKey = resolved.ok ? resolved.projectPath : projectPath;
  const row = projects.getLifecycleRaw(canonicalKey);
  if (!row) {
    return { allowed: true, projectPath: null, state: null, reason: null };
  }
  // Fast path: when persisted state is active `running`, admission is allowed
  // without paying a full task/process scan per candidate task on every tick.
  if (effectiveStateOf(row.lifecycleState, row.path) === "running") {
    return { allowed: true, projectPath: row.path, state: "running", reason: null };
  }
  const snapshot = reconcileProjectDrain(row.path)!;
  if (snapshot.state === "running") {
    return { allowed: true, projectPath: row.path, state: "running", reason: null };
  }
  return {
    allowed: false,
    projectPath: row.path,
    state: snapshot.state,
    reason: snapshot.blockerReason ?? "Project AI execution is not running.",
  };
}

/**
 * Shared launch admission check for an arbitrary task `workdir` (resolving
 * subfolders and linked Git worktrees through `project-ownership.ts`).
 * Unregistered standalone folders are unaffected.
 */
export function checkWorkdirLaunchAdmission(workdir: string): ProjectLaunchAdmission {
  const projectPath = ownerProjectOf(workdir, { fresh: true });
  if (!projectPath) {
    return { allowed: true, projectPath: null, state: null, reason: null };
  }
  return checkProjectLaunchAdmission(projectPath);
}

/**
 * Convenience launch refusal string for a `taskId` (resolving pipeline step
 * tasks through their root parent task), or `null` when allowed.
 */
export function projectLifecycleTaskRefusal(taskId: string): string | null {
  const task = tasks.get(taskId);
  if (!task) return null;
  const root = task.pipelineParentId ? tasks.get(task.pipelineParentId) ?? task : task;
  const verdict = checkWorkdirLaunchAdmission(root.workdir);
  return verdict.allowed ? null : verdict.reason;
}

/**
 * Owner action: request Stop for one registered project.
 *  - Blocks new AI launches immediately.
 *  - Preserves active provider processes (`draining` until they settle, then `paused`).
 *  - Preserves task queues, completed Runs, QC verdicts, pending approvals,
 *    phase grants, frozen batch policies, and task workspaces.
 *  - Idempotent across repeated calls.
 */
export async function stopProjectLifecycle(
  rawPath: unknown,
  rawReason?: unknown,
): Promise<ProjectLifecycleActionResult> {
  const resolved = resolveRegisteredProjectPath(rawPath);
  if (!resolved.ok) {
    throw new ProjectLifecycleError(resolved.error, resolved.status, "not-found");
  }
  const { projectPath } = resolved;
  const customReason = typeof rawReason === "string" && rawReason.trim()
    ? capText(rawReason.trim(), 240)
    : null;

  return withProjectLifecycleLock(projectPath, () => {
    const row = projects.getLifecycleRaw(projectPath);
    if (!row) throw new ProjectLifecycleError("Project is not registered in ForgeOrbit.", 404, "not-found");

    const previousState = effectiveStateOf(row.lifecycleState, projectPath);
    const counts = countActiveProjectExecutions(projectPath);

    // Idempotent no-ops when already in the target stopped/draining state.
    if (previousState === "paused" && counts.total === 0) {
      return {
        lifecycle: buildSnapshot(projectPath, row.lifecycleState, row.lifecycleUpdatedAt, row.lifecycleReason, counts),
        changed: false,
        previousState,
      };
    }
    if (previousState === "draining") {
      if (counts.total > 0) {
        return {
          lifecycle: buildSnapshot(projectPath, row.lifecycleState, row.lifecycleUpdatedAt, row.lifecycleReason, counts),
          changed: false,
          previousState,
        };
      }
      const settled = reconcileProjectDrain(projectPath)!;
      return {
        lifecycle: settled,
        changed: true,
        previousState,
      };
    }

    const now = Date.now();
    const nextState = counts.total > 0 ? "draining" : "paused";
    const reason = customReason ?? (nextState === "draining"
      ? "Owner requested project Stop; waiting for active AI work to finish."
      : "Paused by the owner.");
    const updated = projects.setLifecycleState(projectPath, nextState, reason, now)!;

    recordLifecycleJournal(
      projectPath,
      "owner",
      nextState === "draining" ? "project.lifecycle.draining" : "project.lifecycle.paused",
      {
        previousState: String(row.lifecycleState),
        activeExecutions: counts.total,
        reason,
      },
      now,
      nextState,
    );
    emitLifecycleEvent(projectPath, nextState, counts.total, now);
    notifySmartQueueChanged(projectPath, "project-paused");

    return {
      lifecycle: buildSnapshot(projectPath, updated.lifecycleState, updated.lifecycleUpdatedAt, updated.lifecycleReason, counts),
      changed: true,
      previousState,
    };
  });
}

/**
 * Owner action: resume (`Start`) a safely paused project.
 *  - Verifies persisted state (refuses corrupt/invalid states fail-closed, and
 *    refuses `draining` while active executions remain in flight).
 *  - Transitions through bounded `recovering` reconciliation without launching
 *    any tasks or batches, resetting consumed grants, renewing expired grants,
 *    or bypassing QC / Owner Done gates.
 *  - Restores project launch eligibility (`running`).
 */
export async function startProjectLifecycle(rawPath: unknown): Promise<ProjectLifecycleActionResult> {
  const resolved = resolveRegisteredProjectPath(rawPath);
  if (!resolved.ok) {
    throw new ProjectLifecycleError(resolved.error, resolved.status, "not-found");
  }
  const { projectPath } = resolved;

  return withProjectLifecycleLock(projectPath, () => {
    // Settle a completed drain first if active work already reached 0.
    reconcileProjectDrain(projectPath);

    const row = projects.getLifecycleRaw(projectPath);
    if (!row) throw new ProjectLifecycleError("Project is not registered in ForgeOrbit.", 404, "not-found");

    const previousState = effectiveStateOf(row.lifecycleState, projectPath);
    const counts = countActiveProjectExecutions(projectPath);

    if (previousState === "invalid") {
      throw new ProjectLifecycleError(
        `Project lifecycle state "${capText(String(row.lifecycleState), 40)}" is invalid and fails closed. Stop the project first to reset its state safely before resuming.`,
        409,
        "invalid-state",
      );
    }
    if (previousState === "draining" || counts.total > 0 && previousState !== "running") {
      throw new ProjectLifecycleError(
        `Project is still draining ${counts.total} active AI execution${counts.total === 1 ? "" : "s"}. Wait for active work to finish before resuming.`,
        409,
        "draining-active-work",
      );
    }
    if (previousState === "running") {
      return {
        lifecycle: buildSnapshot(projectPath, row.lifecycleState, row.lifecycleUpdatedAt, row.lifecycleReason, counts),
        changed: false,
        previousState,
      };
    }

    const recoveryAt = Date.now();
    activeRecoveringProjects.add(projectPath);
    let reconciledStartingProposals = 0;
    try {
      projects.setLifecycleState(projectPath, "recovering", "Reconciling project execution state before resume.", recoveryAt);
      emitLifecycleEvent(projectPath, "recovering", counts.total, recoveryAt);

      // Reconcile any interrupted supervised-execution starting proposals for
      // this project against durable `runs` rows without launching new runs.
      if (reconcileStartingProbe) {
        reconciledStartingProposals = reconcileStartingProbe(projectPath);
      }

      const postCounts = countActiveProjectExecutions(projectPath);
      const resumedAt = Date.now();
      const updated = projects.setLifecycleState(projectPath, "running", null, resumedAt)!;
      recordLifecycleJournal(
        projectPath,
        "owner",
        "project.lifecycle.resumed",
        {
          previousState,
          reconciledStartingProposals,
        },
        resumedAt,
        "resumed",
      );
      emitLifecycleEvent(projectPath, "running", postCounts.total, resumedAt);
      notifySmartQueueChanged(projectPath, "project-resumed");
      return {
        lifecycle: buildSnapshot(projectPath, updated.lifecycleState, updated.lifecycleUpdatedAt, updated.lifecycleReason, postCounts),
        changed: true,
        previousState,
        reconciledStartingProposals,
      };
    } finally {
      activeRecoveringProjects.delete(projectPath);
    }
  });
}

/**
 * Boot-time project lifecycle reconciliation.
 * Must run AFTER `reconcileOrphans()` (so surviving tmux sessions are reattached
 * and dead runs are marked `orphaned`) and BEFORE batch/workflow/fx recovery:
 *  - `paused` projects remain `paused`.
 *  - `draining` projects with 0 live runs settle cleanly to `paused`; with
 *    reattached live runs > 0 they remain `draining`.
 *  - Interrupted `recovering` rows fail closed to `draining` (if live runs > 0)
 *    or `paused` (never auto-returning to `running` without an Owner Start).
 *  - Unknown/corrupted `lifecycle_state` values are left untouched so runtime
 *    inspection continues to report `state: "invalid"` fail-closed.
 */
export function reconcileProjectLifecyclesOnBoot(): number {
  let changed = 0;
  const rawRows = projects.listLifecycleRaw();
  const countsByProject = computeActiveExecutionsByProject(rawRows.map((row) => row.path));
  for (const row of rawRows) {
    const counts = countsByProject.get(row.path)!;
    if (row.lifecycleState === "draining" && counts.total === 0) {
      reconcileProjectDrain(row.path, counts, row);
      changed += 1;
      continue;
    }
    if (row.lifecycleState === "recovering") {
      const now = Date.now();
      const nextState = counts.total > 0 ? "draining" : "paused";
      const reason = "Interrupted recovery on restart; project kept paused until Owner resumes.";
      projects.setLifecycleState(row.path, nextState, reason, now);
      recordLifecycleJournal(
        row.path,
        "system",
        "project.lifecycle.reconciled",
        {
          previousState: "recovering",
          nextState,
          activeExecutions: counts.total,
          reason,
        },
        now,
        "boot-recovering",
      );
      changed += 1;
    }
  }
  return changed;
}
