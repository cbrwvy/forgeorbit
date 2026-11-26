import { randomUUID } from "node:crypto";
import { db, tasks, projects, harnesses, taskQualityReviews, runs } from "../db.ts";
import { missionStore, MissionStore } from "./mission-store.ts";
import { routerV2Service } from "../router-v2/router-v2-service.ts";
import { checkProjectLaunchAdmission } from "../project-lifecycle.ts";
import { deploymentGateForTask } from "../infra-auto/gate.ts";
import { cancelEmployeeExecution, getEmployeeRun, reviewEmployeeExecution, startEmployeeExecution, type EmployeeRunDeps } from "../employee-run.ts";
import { authenticateBinding, explainBinding, profileCapacityAllows, reservationBlocksRelaunch } from "../multiaccount/binding.ts";
import { prepareQcReview, startQcReview, acceptAuthorizedTaskDone, cancelPendingQcReview, objectiveQcEvidenceProblem, reconcileInterruptedObjectiveReview } from "../task-quality-control.ts";
import {
  autonomyLaunchDecision,
  autonomyQcDecision,
  autonomyReviewDecision,
  autonomyReworkDecision,
  noteAutonomousLaunchFailed,
  noteAutonomousLaunchFinished,
  noteAutonomousLaunchStarted,
  noteAutonomousReviewFinished,
  recordAutonomousObservation,
} from "../autonomy/gate.ts";
import {
  considerPracticalTest,
  consumePracticalReworkBrief,
  ensurePracticalWorkspace,
  storePracticalReworkBrief,
} from "../autonomy/observed-test.ts";
import { classifyLaunchFailure, classifyReviewFailure } from "../../shared/practical-cycle.ts";
import { closeMissionWaits, recordMissionWait } from "./mission-wait.ts";
import { recordPreparation } from "./mission-preparation.ts";
import { existingWork, projectClusters } from "../usage-analytics/occupancy.ts";
import { activeMissionPolicy, autonomousResourceHold, missionAccountLimit, settledMissionImplementation, verifyMissionStage } from "./mission-resource.ts";
import { providerRefusalsForRuns } from "../provider-refusals.ts";
import { getTaskWorkspace, getWorkspaceWriteScope, rearmSettledWorkspace } from "../task-workspace.ts";
import { cancelRun, defaultEffortFor, isTaskRunLive, subscribeGlobal } from "../orchestrator.ts";
import { dropDispatchLease, gateMissionProviderLaunch } from "../provider-runtime/pipeline.ts";
import { broadcastAppEvent } from "../quit-guard.ts";
import { redactSecrets } from "../../shared/project-interview.ts";
import { computeMissionPlanDigest } from "../../shared/orchestration/plan-digest.js";
import {
  validatePlanDependencies,
  evaluateTaskDependencies,
  topologicalSortTasks,
} from "../../shared/orchestration/dependency-engine.js";
import type {
  MissionRecord,
  MissionPlan,
  MissionTaskPlan,
  MissionConcurrencyLimits,
  MissionExecutionPolicy,
  MissionStatus,
  MissionTaskPriority,
  DependencyCondition,
  MissionRuntimeState,
  MissionStageResource,
} from "../../shared/orchestration/types.js";

import { isProductionOwnerGateActive } from "../owner-trust/launch-gate.ts";
import { handsoffCompleteMissionTask, handsoffCoversMissionStage } from "../handsoff/mission.ts";
import { autonomyPolicyStore } from "../autonomy/policy-store.ts";
import { onTaskAvailabilityChange, taskAvailabilityFor, taskAvailabilityNow } from "../task-availability.ts";
import {
  objectiveInputs, objectivePromptForTask, objectivePublicationBlock, objectiveSetupBlockers, objectiveTaskIsManaged, verifyObjectiveStage,
} from "./objective-mission.ts";

const CURSOR_MISSION_BLOCK = "Cursor provider is not ready for execution dispatch in mission.";
const DEEPSEEK_MISSION_BLOCK = "DeepSeek provider is not ready for execution dispatch in mission.";

function blockedMissionResource(harnessId: string, modelId: string): string | null {
  const row = harnesses.get(harnessId);
  const kind = (row?.kind ?? harnessId).toLowerCase();
  if (harnessId === "cursor" || kind === "cursor") return CURSOR_MISSION_BLOCK;
  if (kind === "deepseek" || kind === "deepseek-dsh" || modelId.toLowerCase().includes("deepseek")) return DEEPSEEK_MISSION_BLOCK;
  return null;
}

function admitMissionTask(input: {
  taskId: string;
  taskTitle: string;
  projectPath: string;
  clusterId?: string;
  specialistRole?: string;
  assignedEmployeeId?: string;
  priority?: MissionTaskPriority;
  dependencies?: MissionTaskPlan["dependencies"];
  harnessId?: string;
  modelId?: string;
  accountId?: string;
  mode?: string;
  qcRequired?: boolean;
}): MissionTaskPlan {
  const row = tasks.get(input.taskId);
  const harnessId = input.harnessId ?? row?.agent ?? "";
  const modelId = input.modelId ?? row?.model ?? "";
  const mode = input.mode ?? row?.mode ?? "";
  const accountId = input.accountId;
  const blocked = blockedMissionResource(harnessId, modelId);
  if (blocked) throw new OrchestrationError(blocked, 400);
  if (!harnessId || !modelId || !mode) {
    throw new OrchestrationError(
      `Task ${input.taskId} has no explicit harness, model, and mode. No default resource was substituted.`,
      409,
    );
  }
  const role = input.specialistRole === "reviewer" ? "reviewer" : "developer";
  let evaluation: ReturnType<typeof routerV2Service.evaluateTaskSync>;
  try {
    evaluation = routerV2Service.evaluateTaskSync({
      taskId: input.taskId,
      projectId: input.projectPath,
      title: input.taskTitle,
      role,
      requestedHarnessId: harnessId,
      requestedModelId: modelId,
      requestedAccountId: accountId ?? null,
      requestedMode: mode,
    });
  } catch (error) {
    throw new OrchestrationError(
      `Resource evaluation failed for task ${input.taskId}: ${error instanceof Error ? error.message : "unknown error"}. No substitute resource was selected.`,
      409,
    );
  }
  const selected = evaluation.selected;
  const matches = Boolean(
    selected && selected.harnessId === harnessId && selected.modelId === modelId && selected.mode === mode &&
    (!accountId || selected.accountId === accountId),
  );
  if (!matches) {
    const pinned = evaluation.all.find(candidate =>
      candidate.harnessId === harnessId && candidate.modelId === modelId && candidate.mode === mode &&
      (!accountId || candidate.accountId === accountId));
    const reason = pinned?.eliminationReasons[0] ?? "The pinned resource is not eligible.";
    const policy = routerV2Service.getPolicy(input.projectPath);
    if (pinned) {
      try {
        routerV2Service.recordDecision({
          projectPath: input.projectPath,
          taskId: input.taskId,
          role,
          policyPreset: policy.preset,
          quotaPolicy: policy.quotaPolicy,
          autonomyMode: policy.autonomyMode,
          selectedHarnessId: harnessId,
          selectedModelId: modelId,
          selectedAccountId: accountId ?? null,
          selectedMode: mode,
          decisionType: "manual-override",
          authority: "recommendation",
          planDigest: null,
          evaluation: pinned,
          actualAttribution: { outcome: reason },
        });
      } catch { /* The refusal below is the recorded reason. */ }
    }
    throw new OrchestrationError(
      `Task ${input.taskId} resource ${harnessId}/${modelId}/${accountId ?? "unassigned"}/${mode} was refused: ${reason} No substitute was selected.`,
      409,
    );
  }
  return {
    taskId: input.taskId,
    taskTitle: input.taskTitle,
    projectPath: input.projectPath,
    clusterId: input.clusterId,
    specialistRole: input.specialistRole || "developer",
    assignedEmployeeId: input.assignedEmployeeId,
    priority: input.priority || "normal",
    dependencies: input.dependencies || [],
    harnessId,
    modelId,
    accountId: accountId ?? selected?.accountId ?? undefined,
    mode,
    qcRequired: input.qcRequired !== false,
    phase: "planned",
  };
}

export class OrchestrationError extends Error {
  readonly status: number;
  constructor(message: string, status = 400) {
    super(message);
    this.status = status;
    this.name = "OrchestrationError";
  }
}

export interface PrepareMissionInput {
  title: string;
  goal: string;
  initiativeId?: string | null;
  clusterIds?: string[];
  projectPaths?: string[];
  taskIds?: string[];
  tasks?: Array<{
    taskId: string;
    taskTitle?: string;
    projectPath: string;
    clusterId?: string;
    specialistRole?: string;
    assignedEmployeeId?: string;
    priority?: MissionTaskPriority;
    dependencies?: Array<{
      taskId: string;
      projectPath: string;
      condition: DependencyCondition;
    }>;
    harnessId?: string;
    modelId?: string;
    accountId?: string;
    mode?: string;
    qcRequired?: boolean;
  }>;
  concurrencyLimits?: Partial<MissionConcurrencyLimits>;
  spendingLimitUsd?: number;
  policyOverride?: Partial<MissionExecutionPolicy>;
}

export class MissionScheduler {
  private ticking = false;
  private wakeupDuringPass = false;
  private tickTails = new Map<string, Promise<void>>();
  private objectiveConfirmations = new Map<string, "en" | "ru">();
  private objectiveStarts = new Set<string>();
  private objectiveSettlements = new Map<string, (task: MissionTaskPlan) => void>();
  private objectiveWakeup: ReturnType<typeof setTimeout> | undefined;
  private quotaWakeups = new Map<string, { at: number; timer: ReturnType<typeof setTimeout> }>();
  private quotaRetries = new Map<string, { missionId: string; digest: string; role: "developer" | "reviewer"; refusalId: string }>();

  retryQuotaWait(missionId: string, taskId: string, refusalId: string) {
    const mission = this.store.getMission(missionId);
    const task = mission?.plan.tasks.find(item => item.taskId === taskId);
    const limit = task?.accountLimit;
    if (!mission || mission.status !== "running" || !task || !limit || !("refusal" in limit) ||
      limit.refusal.id !== refusalId || task.waitingOn !== "quota" || !["blocked", "awaiting_qc"].includes(task.phase) ||
      this.quotaRetries.has(taskId) || isTaskRunLive(taskId) ||
      this.objectiveStarts.has(taskId) || !checkProjectLaunchAdmission(task.projectPath).allowed ||
      autonomyPolicyStore.readEmergency().active) {
      throw new OrchestrationError("The account retry is no longer available.", 409);
    }
    this.quotaRetries.set(taskId, { missionId, digest: mission.planDigest, role: limit.role, refusalId });
    void this.tickMission(missionId).catch(error => console.warn("[missions] Account retry failed:", error));
  }

  private quotaRetry(mission: MissionRecord, task: MissionTaskPlan, role: "developer" | "reviewer") {
    const retry = this.quotaRetries.get(task.taskId);
    return retry?.missionId === mission.id && retry.digest === mission.planDigest && retry.role === role ? retry.refusalId : undefined;
  }

  private holdForQuota(mission: MissionRecord, task: MissionTaskPlan, role: "developer" | "reviewer", resource: {
    harnessId: string; accountId?: string | null; modelId: string;
  }, retryRefusalId = this.quotaRetry(mission, task, role)) {
    const limit = missionAccountLimit(resource, role, this.now(), retryRefusalId);
    task.accountLimit = limit;
    if (!limit) {
      if (task.waitingOn === "quota") task.waitingOn = undefined;
      return false;
    }
    this.quotaRetries.delete(task.taskId);
    if (task.pendingLaunch) this.objectiveConfirmations.delete(task.pendingLaunch.operationId);
    task.phase = role === "developer" ? "blocked" : "awaiting_qc";
    task.blockedStage = role;
    task.phaseReason = undefined;
    task.waitingOn = "quota";
    if (mission.plan.objective) task.objectiveBlockers = [];
    recordMissionWait(mission.id, task.taskId, "quota", this.now());
    return true;
  }

  private scheduleQuotaWake(missionId: string, after = this.now()) {
    const mission = this.store.getMission(missionId);
    const now = this.now();
    const boundaries = mission?.status === "running" ? mission.plan.tasks.flatMap(task => {
      const times: number[] = [];
      const limit = task.accountLimit;
      if (task.waitingOn === "quota" && limit && "windows" in limit) {
        for (const window of limit.windows) {
          if (window.resetAt !== null && window.resetAt > after) times.push(window.resetAt);
        }
      }
      if (task.waitingOn === "scheduled") {
        const avail = taskAvailabilityFor(tasks.get(task.taskId), after);
        if (!avail.available && avail.availableFromMs !== null && avail.availableFromMs > after) {
          times.push(avail.availableFromMs);
        }
      }
      return times;
    }) : [];
    const at = Math.min(...boundaries);
    const previous = this.quotaWakeups.get(missionId);
    if (previous?.at === at) return;
    if (previous) clearTimeout(previous.timer);
    this.quotaWakeups.delete(missionId);
    if (!Number.isFinite(at)) return;
    const delay = Math.min(60_000, Math.max(1, at - now));
    const timer = setTimeout(() => {
      this.quotaWakeups.delete(missionId);
      void this.tickMission(missionId).catch(error => console.warn("[missions] Scheduled/quota wake failed:", error));
    }, delay);
    timer.unref();
    this.quotaWakeups.set(missionId, { at, timer });
  }

  wakeObjectiveMissions(): void {
    if (this.objectiveWakeup) return;
    this.objectiveWakeup = setTimeout(() => {
      this.objectiveWakeup = undefined;
      if (!this.store.listMissions({ status: "running" }).some(mission => mission.plan.objective)) return;
      void this.tickAllRunningMissions()
        .catch(error => console.warn("[missions] Scheduler tick failed:", error))
        .finally(() => this.wakeObjectiveMissions());
    }, 4000);
    this.objectiveWakeup.unref();
  }

  confirmObjectiveLaunch(missionId: string, taskId: string, operationId: string, locale: "en" | "ru") {
    const mission = this.store.getMission(missionId);
    const task = mission?.plan.tasks.find(item => item.taskId === taskId);
    if (!mission?.plan.objective || mission.status !== "running" || task?.pendingLaunch?.operationId !== operationId ||
      this.objectiveStarts.has(taskId)) throw new OrchestrationError("The launch operation is no longer waiting for confirmation.", 409);
    const admission = checkProjectLaunchAdmission(task.projectPath);
    if (!admission.allowed || autonomyPolicyStore.readEmergency().active) {
      throw new OrchestrationError(admission.reason ?? "Emergency Stop is active.", 409);
    }
    this.objectiveConfirmations.set(operationId, locale);
    void this.tickMission(missionId).catch(error => console.warn("[missions] Launch confirmation failed:", error));
  }

  private dispatchObjective(
    mission: MissionRecord,
    task: MissionTaskPlan,
    operationId: string,
    start: () => Promise<string | undefined>,
    settle: (task: MissionTaskPlan, error: string | undefined) => void,
  ) {
    db.run("UPDATE objective_mission_tasks SET operation_id = ? WHERE task_id = ?", [operationId, task.taskId]);
    this.store.saveMissionPlanState(mission.id, mission.plan, mission.state);
    this.objectiveStarts.add(task.taskId);
    void start().catch(error => error instanceof Error ? error.message : String(error)).then(error => {
      db.run("UPDATE objective_mission_tasks SET operation_id = NULL WHERE task_id = ? AND operation_id = ?", [task.taskId, operationId]);
      this.objectiveStarts.delete(task.taskId);
      if (this.store.getMission(mission.id)?.status === "cancelled") return;
      this.objectiveSettlements.set(task.taskId, current => settle(current, error));
      void this.tickMission(mission.id).catch(problem => console.warn("[missions] Launch settlement failed:", problem));
    });
  }

  constructor(
    private store: MissionStore = missionStore,
    private runDeps: EmployeeRunDeps = {},
    private now: () => number = () => taskAvailabilityNow(),
  ) {
    // Subscribe to task run events to trigger reactive progression
    try {
      subscribeGlobal((event) => {
        if (event.kind === "run-status") {
          void this.tickAllRunningMissions();
        }
      });
    } catch {
      // Test environments might not have orchestrator subscription
    }
    onTaskAvailabilityChange((taskId) => {
      const affected = this.store.listMissions({ status: "running" }).filter(mission =>
        mission.plan.tasks.some(task => task.taskId === taskId));
      for (const mission of affected) {
        void this.tickMission(mission.id).catch(error => console.warn("[missions] Availability wake failed:", error));
      }
    });
  }

  isTickingMission(missionId: string): boolean {
    return this.tickTails.has(missionId);
  }

  async prepareMission(input: PrepareMissionInput): Promise<MissionRecord> {
    if (!input.title || input.title.trim().length === 0) {
      throw new OrchestrationError("Mission title is required.", 400);
    }
    if (!input.goal || input.goal.trim().length === 0) {
      throw new OrchestrationError("Mission goal is required.", 400);
    }

    // Determine target projects
    const targetProjectPaths = new Set<string>(input.projectPaths || []);
    const targetClusterIds = new Set<string>(input.clusterIds || []);

    if (input.clusterIds && input.clusterIds.length > 0) {
      for (const clusterId of input.clusterIds) {
        const rows = db
          .query<{ project_path: string }, [string]>(
            `SELECT project_path FROM cluster_project_memberships WHERE cluster_id = ?`,
          )
          .all(clusterId);
        for (const row of rows) {
          targetProjectPaths.add(row.project_path);
        }
      }
    }

    const drafts: Array<Parameters<typeof admitMissionTask>[0]> = [];
    if (input.tasks && input.tasks.length > 0) {
      for (const t of input.tasks) {
        targetProjectPaths.add(t.projectPath);
        if (t.clusterId) targetClusterIds.add(t.clusterId);
        drafts.push({
          taskId: t.taskId,
          taskTitle: t.taskTitle || `Task ${t.taskId}`,
          projectPath: t.projectPath,
          clusterId: t.clusterId,
          specialistRole: t.specialistRole,
          assignedEmployeeId: t.assignedEmployeeId,
          priority: t.priority,
          dependencies: t.dependencies,
          harnessId: t.harnessId,
          modelId: t.modelId,
          accountId: t.accountId,
          mode: t.mode,
          qcRequired: t.qcRequired,
        });
      }
    } else if (input.taskIds && input.taskIds.length > 0) {
      for (const taskId of input.taskIds) {
        const taskObj = tasks.get(taskId);
        if (!taskObj) throw new OrchestrationError(`Task ${taskId} not found.`, 404);
        targetProjectPaths.add(taskObj.workdir);
        drafts.push({
          taskId: taskObj.id,
          taskTitle: taskObj.title,
          projectPath: taskObj.workdir,
          harnessId: taskObj.agent,
          modelId: taskObj.model ?? undefined,
          mode: taskObj.mode ?? undefined,
        });
      }
    }

    const dependencyPlans: MissionTaskPlan[] = drafts.map(draft => ({
      taskId: draft.taskId,
      taskTitle: draft.taskTitle,
      projectPath: draft.projectPath,
      clusterId: draft.clusterId,
      specialistRole: draft.specialistRole || "developer",
      priority: draft.priority || "normal",
      dependencies: draft.dependencies || [],
      harnessId: draft.harnessId || "unresolved",
      modelId: draft.modelId || "unresolved",
      mode: draft.mode || "unresolved",
      qcRequired: draft.qcRequired !== false,
      phase: "planned",
    }));
    const valResult = validatePlanDependencies(dependencyPlans);
    if (!valResult.valid) {
      throw new OrchestrationError(
        `Dependency validation failed: ${valResult.errors.join("; ")}`,
        400,
      );
    }

    if (drafts.some(draft => objectiveTaskIsManaged(draft.taskId))) {
      throw new OrchestrationError("A task is already managed by its cross-project mission.", 409);
    }
    const taskPlans = drafts.map(draft => admitMissionTask(draft));

    const concurrencyLimits: MissionConcurrencyLimits = {
      globalMax: input.concurrencyLimits?.globalMax ?? 8,
      perProjectMax: input.concurrencyLimits?.perProjectMax ?? 2,
      perAccountMax: input.concurrencyLimits?.perAccountMax ?? 3,
      ...(input.concurrencyLimits?.perClusterMax !== undefined ? { perClusterMax: input.concurrencyLimits.perClusterMax } : {}),
    };

    if (Object.values(concurrencyLimits).some(value => !Number.isSafeInteger(value) || value < 1)) {
      throw new OrchestrationError("Mission concurrency limits must be positive integers.");
    }

    const executionPolicy: MissionExecutionPolicy = {
      qcRequired: input.policyOverride?.qcRequired !== false,
      autoResumeOnQcPass: input.policyOverride?.autoResumeOnQcPass !== false,
      maxRetriesPerTask: input.policyOverride?.maxRetriesPerTask ?? 0,
    };

    const plan: MissionPlan = {
      clusters: [...targetClusterIds],
      projects: [...targetProjectPaths],
      tasks: taskPlans,
      concurrencyLimits,
      spendingLimitUsd: input.spendingLimitUsd,
      executionPolicy,
    };

    const planDigest = computeMissionPlanDigest(plan);

    return this.store.createMission({
      title: input.title,
      goal: input.goal,
      initiativeId: input.initiativeId,
      status: "draft",
      clusters: plan.clusters,
      projects: plan.projects,
      plan,
      planDigest,
    });
  }

  async authorizeMission(missionId: string, approvedDigest: string): Promise<MissionRecord> {
    const mission = this.store.getMission(missionId);
    if (!mission) {
      throw new OrchestrationError(`Mission ${missionId} not found.`, 404);
    }

    if (mission.plan.objective) throw new OrchestrationError("Use the exact objective plan confirmation.", 409);
    if (mission.status !== "draft" && mission.status !== "planned") {
      throw new OrchestrationError(
        `Mission ${missionId} is in status '${mission.status}'; cannot authorize.`,
        409,
      );
    }

    if (mission.planDigest !== approvedDigest) {
      throw new OrchestrationError(
        `Plan digest mismatch: mission has '${mission.planDigest}', received '${approvedDigest}'.`,
        409,
      );
    }

    // DAG cycle re-validation
    const valResult = validatePlanDependencies(mission.plan.tasks);
    if (!valResult.valid) {
      throw new OrchestrationError(
        `Dependency cycle or invalid reference detected: ${valResult.errors.join("; ")}`,
        409,
      );
    }

    // Verify admission for each project
    for (const projectPath of mission.projects) {
      const admission = checkProjectLaunchAdmission(projectPath);
      if (!admission.allowed) {
        throw new OrchestrationError(
          `Project admission blocked for '${projectPath}': ${admission.reason}`,
          409,
        );
      }
    }

    // Update tasks to authorized
    for (const task of mission.plan.tasks) {
      if (task.phase === "planned") {
        task.phase = "authorized";
      }
    }

    const updated = this.store.updateMissionAuthorization(
      missionId,
      {
        authorizedAt: Date.now(),
        authorizedBy: "owner",
        digest: approvedDigest,
      },
      "authorized",
    );

    if (!updated) {
      throw new OrchestrationError(`Failed to update mission authorization.`, 500);
    }

    return updated;
  }

  async startMission(missionId: string): Promise<MissionRecord> {
    const mission = this.store.getMission(missionId);
    if (!mission) {
      throw new OrchestrationError(`Mission ${missionId} not found.`, 404);
    }

    if (mission.status !== "authorized") {
      throw new OrchestrationError(
        `Mission must be in 'authorized' status to start (current: '${mission.status}').`,
        409,
      );
    }

    // Double check digest
    if (mission.authorization?.digest !== mission.planDigest) {
      throw new OrchestrationError(
        `Authorization digest does not match current plan digest.`,
        409,
      );
    }

    const running = this.store.updateMissionStatus(missionId, "running", "started");
    if (!running) {
      throw new OrchestrationError(`Failed to start mission.`, 500);
    }

    void this.tickMission(missionId);
    if (running.plan.objective) this.wakeObjectiveMissions();
    return running;
  }

  async pauseMission(missionId: string, reason = "Paused by Owner"): Promise<MissionRecord> {
    const mission = this.store.getMission(missionId);
    if (!mission) {
      throw new OrchestrationError(`Mission ${missionId} not found.`, 404);
    }

    if (mission.status !== "running") {
      throw new OrchestrationError(`Only running missions can be paused.`, 409);
    }

    for (const task of mission.plan.tasks) {
      this.quotaRetries.delete(task.taskId);
      if (task.pendingLaunch) this.objectiveConfirmations.delete(task.pendingLaunch.operationId);
    }
    const paused = this.store.updateMissionStatus(missionId, "paused", "paused", { reason });
    this.scheduleQuotaWake(missionId);
    closeMissionWaits(missionId);
    if (!paused) {
      throw new OrchestrationError(`Failed to pause mission.`, 500);
    }

    return paused;
  }

  async resumeMission(missionId: string): Promise<MissionRecord> {
    const mission = this.store.getMission(missionId);
    if (!mission) {
      throw new OrchestrationError(`Mission ${missionId} not found.`, 404);
    }

    if (mission.status !== "paused") {
      throw new OrchestrationError(`Only paused missions can be resumed.`, 409);
    }

    if (mission.authorization?.digest !== mission.planDigest) {
      throw new OrchestrationError(`Mission authorization expired or plan was modified.`, 409);
    }

    const running = this.store.updateMissionStatus(missionId, "running", "resumed");
    if (!running) {
      throw new OrchestrationError(`Failed to resume mission.`, 500);
    }

    void this.tickMission(missionId);
    if (running.plan.objective) this.wakeObjectiveMissions();
    return running;
  }

  async cancelMission(missionId: string, reason = "Cancelled by Owner"): Promise<MissionRecord> {
    const mission = this.store.getMission(missionId);
    if (!mission) {
      throw new OrchestrationError(`Mission ${missionId} not found.`, 404);
    }

    const reservations = this.store.listActiveReservations(missionId);
    const cancelled = this.store.updateMissionStatus(missionId, "cancelled", "cancelled", { reason });
    this.scheduleQuotaWake(missionId);
    for (const task of mission.plan.tasks) this.quotaRetries.delete(task.taskId);
    closeMissionWaits(missionId);
    if (!cancelled) {
      throw new OrchestrationError(`Failed to cancel mission.`, 500);
    }

    this.store.releaseReservations(missionId);
    if (mission.plan.objective) {
      db.run("UPDATE objective_mission_tasks SET operation_id = NULL WHERE mission_id = ?", [missionId]);
      for (const task of mission.plan.tasks) {
        if (task.pendingLaunch) {
          this.objectiveConfirmations.delete(task.pendingLaunch.operationId);
          if (task.pendingLaunch.role === "developer") {
            try {
              const attempt = getEmployeeRun(task.pendingLaunch.operationId, this.runDeps);
              if (attempt.status === "awaiting-approval") cancelEmployeeExecution(attempt.id, { revision: attempt.revision }, this.runDeps);
            } catch (error) {
              console.warn("[missions] Could not withdraw a stopped mission's prepared launch:", error);
            }
          }
        }
        this.objectiveSettlements.delete(task.taskId);
        const reservation = reservations.find(item => item.taskId === task.taskId);
        if (reservation?.runId) void cancelRun(reservation.runId).catch(() => undefined);
        noteAutonomousLaunchFinished(mission, task);
        noteAutonomousReviewFinished(mission, task);
        const reviewId = reservation?.qcReviewId ?? task.qcReviewId;
        if (reviewId && taskQualityReviews.get(reviewId)?.status === "pending") cancelPendingQcReview(reviewId);
      }
    }
    return cancelled;
  }

  async onOwnerTaskDone(taskId: string): Promise<void> {
    const affected = this.store.listMissions({ status: "running" }).filter(mission =>
      mission.plan.tasks.some(task => task.taskId === taskId && (task.phase === "awaiting_owner" || task.phase === "qc_running")));
    for (const mission of affected) await this.tickMission(mission.id);
  }

  /**
   * Tick every running mission. A wake-up that arrives while a pass is running (a run settling, a slot freeing) is not
   * dropped: it marks the pass as stale and one follow-up pass runs after it. Passes never overlap, and a follow-up
   * exists only because an event arrived, so nothing spins while nothing changes.
   */
  async tickAllRunningMissions(): Promise<void> {
    if (this.ticking) { this.wakeupDuringPass = true; return; }
    this.ticking = true;
    try {
      do {
        this.wakeupDuringPass = false;
        const runningMissions = this.store.listMissions({ status: "running" });
        for (const m of runningMissions) {
          await this.tickMission(m.id);
        }
      } while (this.wakeupDuringPass);
    } finally {
      this.ticking = false;
    }
  }

  async tickMission(missionId: string): Promise<void> {
    const previous = this.tickTails.get(missionId) ?? Promise.resolve();
    const run = previous.then(async () => {
      const at = this.now();
      try {
        await this.tickMissionBody(missionId);
      } finally {
        this.scheduleQuotaWake(missionId, at);
      }
    });
    const settled = run.then(() => undefined, () => undefined);
    this.tickTails.set(missionId, settled);
    void settled.then(() => {
      if (this.tickTails.get(missionId) === settled) this.tickTails.delete(missionId);
    });
    return run;
  }

  private capacityFor(mission: MissionRecord, task: MissionTaskPlan, accountId?: string, employeeId?: string) {
    const { globalMax, perProjectMax, perAccountMax, perClusterMax } = mission.concurrencyLimits;
    const active = existingWork();
    const scopeClusters = projectClusters(task.projectPath);
    if (active.length >= globalMax || active.filter(row => row.projectPath === task.projectPath).length >= perProjectMax ||
      perClusterMax !== undefined && scopeClusters.some(id => active.filter(row => row.keys.includes("cluster/" + id)).length >= perClusterMax)) {
      return { wait: "project-queue" as const, reason: "Waiting for a global, cluster, or project worker slot." };
    }
    if (employeeId && active.some(row => row.employeeId === employeeId)) {
      return { wait: "specialist-capacity" as const, reason: "Waiting for the assigned specialist." };
    }
    const counts = new Map<string, number>();
    for (const row of active) if (row.accountId) counts.set(row.accountId, (counts.get(row.accountId) ?? 0) + 1);
    const result = profileCapacityAllows(db, accountId, perAccountMax, counts);
    return result.allow ? null : { wait: "account-capacity" as const, reason: result.reason };
  }

  private async prepareObjectiveDeveloper(mission: MissionRecord, task: MissionTaskPlan, resource: MissionStageResource) {
    let grant: string | undefined;
    const retry = this.quotaRetry(mission, task, "developer");
    const verify = () => {
      const avail = taskAvailabilityFor(tasks.get(task.taskId), this.now());
      if (!avail.available) return `Task is scheduled to be available from ${avail.availableFromUtc}. Waiting for scheduled time.`;
      return missionAccountLimit(resource, "developer", this.now(), retry)
        ? "The Developer account is waiting on a provider limit."
        : verifyObjectiveStage(mission, task, "developer", resource, retry);
    };
    const runDeps: EmployeeRunDeps = {
      ...this.runDeps,
      missionStage: {
        mode: resource.mode,
        verify: () => verify(),
        onRunRecorded: runId => {
          this.store.updateReservationStatus(task.taskId, "running", { runId });
          if (grant) noteAutonomousLaunchStarted(grant);
        },
      },
    };
    const pending = task.pendingLaunch;
    const block = (reason: string) => {
      task.phase = "blocked";
      task.phaseReason = reason;
      task.objectiveBlockers = ["permission"];
      this.store.releaseTaskReservation(task.taskId);
    };
    try {
      let attempt = pending?.role === "developer" ? getEmployeeRun(pending.operationId, runDeps) : null;
      if (attempt && attempt.status !== "awaiting-approval") {
        this.objectiveConfirmations.delete(attempt.id);
        attempt = null;
      }
      if (!attempt) {
        const review = await reviewEmployeeExecution({ taskId: task.taskId, harnessId: resource.harnessId, model: resource.modelId }, runDeps);
        attempt = review.attempt;
        if (!attempt) {
          block(review.blockingErrors[0]?.message ?? "Developer preparation was refused.");
          return;
        }
      }
      if (getWorkspaceWriteScope(task.taskId) !== "working-copy") {
        block("The Developer working copy could not be prepared.");
        return;
      }
      // A project that turned on "Work independently" for this resource has already given the confirmation.
      const covered = handsoffCoversMissionStage(task.projectPath, resource, Boolean(attempt.usageNotice));
      const requiresConfirmation = isProductionOwnerGateActive() || (!covered && (!mission.plan.objective?.activationId || Boolean(attempt.usageNotice)));
      const locale = this.objectiveConfirmations.get(attempt.id);
      if (requiresConfirmation && !locale) {
        task.phase = "awaiting_owner";
        task.phaseReason = undefined;
        task.pendingLaunch = { role: "developer", operationId: attempt.id, usageNotice: Boolean(attempt.usageNotice) };
        this.store.releaseTaskReservation(task.taskId);
        return;
      }
      const policy = autonomyLaunchDecision(mission, task);
      if (policy.kind === "deny" || policy.kind === "skip") {
        block(policy.reason);
        return;
      }
      if (policy.kind === "allow") grant = policy.reservationId;
      this.objectiveConfirmations.delete(attempt.id);
      this.quotaRetries.delete(task.taskId);
      task.pendingLaunch = undefined;
      const { id, revision } = attempt;
      this.dispatchObjective(mission, task, id, async () => {
        const outcome = await startEmployeeExecution(id, { revision, confirm: true, acknowledgeUsage: Boolean(locale) || covered }, {
          ...runDeps, ownerLocale: locale,
        });
        return outcome.attempt.status === "started" ? undefined : outcome.attempt.reason ?? "Developer launch was refused.";
      }, (current, error) => {
        const recorded = this.store.getReservation(current.taskId)?.runId;
        if (recorded) {
          current.phase = "running";
          current.runId = recorded;
          current.phaseReason = undefined;
          current.objectiveBlockers = [];
          if ((current.reworkEpoch ?? 0) > 0) consumePracticalReworkBrief(current.taskId);
        } else {
          if (grant) noteAutonomousLaunchFailed(grant);
          this.store.releaseTaskReservation(current.taskId);
          if (!this.holdForQuota(mission, current, "developer", resource, retry)) {
            current.phase = "awaiting_owner";
            current.recovery = "interrupted-launch";
            current.phaseReason = error ?? "Developer launch did not record a run.";
          }
        }
      });
    } catch (error) {
      block(error instanceof Error ? error.message : String(error));
    }
  }

  private async prepareObjectiveReview(mission: MissionRecord, task: MissionTaskPlan, resource: MissionStageResource) {
    const ownerGate = isProductionOwnerGateActive();
    const requiresConfirmation = ownerGate || (!mission.plan.objective?.activationId && !handsoffCoversMissionStage(task.projectPath, resource, false));
    const policyBody = activeMissionPolicy(mission)?.policy.body;
    const evidenceRequired = ownerGate || policyBody?.qc.requireObservedTest === true || policyBody?.completion.conditions.includes("observed_test") === true;
    const evidence = evidenceRequired ? await objectiveQcEvidenceProblem(task.taskId, task.runId!) : null;
    if (evidence) {
      task.phase = "awaiting_owner";
      task.objectiveBlockers = [objectivePublicationBlock(task) ?? "test"];
      task.phaseReason = evidence;
      return;
    }
    const pending = task.pendingLaunch;
    const locale = pending && this.objectiveConfirmations.get(pending.operationId);
    if (requiresConfirmation && !locale) {
      task.phase = "awaiting_owner";
      task.objectiveBlockers = [];
      task.phaseReason = undefined;
      task.pendingLaunch = pending ?? { role: "reviewer", operationId: randomUUID() };
      return;
    }
    const retry = this.quotaRetry(mission, task, "reviewer");
    const verify = () => missionAccountLimit(resource, "reviewer", this.now(), retry)
      ? "The Reviewer account is waiting on a provider limit."
      : verifyObjectiveStage(mission, task, "reviewer", resource, retry);
    const problem = verify();
    if (problem) {
      task.phaseReason = problem;
      return;
    }
    const capacity = this.capacityFor(mission, task, resource.accountId, task.objectiveTask?.reviewerId);
    if (capacity) {
      task.phaseReason = capacity.reason;
      task.objectiveBlockers = [capacity.wait === "account-capacity" ? "account-slot" : "worker-slot"];
      return;
    }
    const reserved = this.store.tryCreateReservation({
      missionId: mission.id, taskId: task.taskId, projectPath: task.projectPath,
      employeeId: task.objectiveTask!.reviewerId!, accountId: resource.accountId, harnessId: resource.harnessId,
      modelId: resource.modelId, status: "qc_running",
    }, mission.concurrencyLimits);
    if (!reserved.ok) {
      task.phaseReason = reserved.reason;
      task.objectiveBlockers = ["worker-slot"];
      return;
    }
    const policy = autonomyReviewDecision(mission, task);
    if (policy.kind === "deny" || policy.kind === "skip") {
      task.phaseReason = policy.reason;
      task.objectiveBlockers = ["permission"];
      this.store.releaseTaskReservation(task.taskId);
      return;
    }
    if (pending) this.objectiveConfirmations.delete(pending.operationId);
    this.quotaRetries.delete(task.taskId);
    let reviewId = task.qcReviewId;
    try {
      if (!reviewId || taskQualityReviews.get(reviewId)?.status !== "pending") {
        const prepared = prepareQcReview({
          taskId: task.taskId, reviewerHarness: resource.harnessId, reviewerModel: resource.modelId,
          reviewerEmployeeId: task.objectiveTask?.reviewerId,
        }, { implementationRunId: task.runId, allowColumns: ["review", "blocked"], objectiveMission: true });
        reviewId = prepared.review.id;
      }
      this.store.updateReservationStatus(task.taskId, "qc_running", { qcReviewId: reviewId });
      task.pendingLaunch = undefined;
      task.objectiveBlockers = [];
      task.phase = "qc_running";
      task.phaseReason = undefined;
      task.qcReviewId = reviewId;
      const reservedReviewId = reviewId;
      this.dispatchObjective(mission, task, reservedReviewId, async () => {
        const started = await startQcReview(reservedReviewId, undefined, {
          mode: resource.mode,
          effort: defaultEffortFor(harnesses.get(resource.harnessId)!.kind, resource.modelId, resource.harnessId),
          allowColumns: ["review", "blocked"],
          evidenceNote: "Review with read-only tools. Do not publish or run a shell.",
          verify,
          onRunRecorded: runId => this.store.updateReservationStatus(task.taskId, "qc_running", { runId }),
          requireOrdinaryEvidence: evidenceRequired,
          objectiveMission: true,
        }, { locale });
        return "error" in started ? started.error : undefined;
      }, (current, error) => {
        if (error && !this.store.getReservation(current.taskId)?.runId) {
          noteAutonomousReviewFinished(mission, current);
          if (taskQualityReviews.get(reservedReviewId)?.status === "pending") cancelPendingQcReview(reservedReviewId);
          this.store.releaseTaskReservation(current.taskId);
          if (!this.holdForQuota(mission, current, "reviewer", resource, retry)) {
            current.phase = "awaiting_owner";
            current.recovery = "interrupted-launch";
            current.phaseReason = error;
          }
        }
      });
    } catch (error) {
      task.phase = "awaiting_owner";
      task.phaseReason = error instanceof Error ? error.message : String(error);
      noteAutonomousReviewFinished(mission, task);
      if (reviewId && taskQualityReviews.get(reviewId)?.status === "pending") cancelPendingQcReview(reviewId);
      this.store.releaseTaskReservation(task.taskId);
    }
  }

  private async tickMissionBody(missionId: string): Promise<void> {
    const mission = this.store.getMission(missionId);
    if (!mission || mission.status !== "running") return;
    const objective = Boolean(mission.plan.objective);
    if (objective && autonomyPolicyStore.readEmergency().active) return;

    // Verify authorization. The approval names a digest of the plan; the plan that is about to launch must still hash to
    // it. Comparing two stored strings is not enough: an edited resource (another allowed model or account) leaves both
    // unchanged, and would launch work the Owner never approved.
    if (mission.authorization?.digest !== mission.planDigest || computeMissionPlanDigest(mission.plan) !== mission.planDigest) {
      this.store.updateMissionStatus(
        missionId,
        "paused",
        "paused_authorization_mismatch",
        { reason: "Authorization digest does not match current plan digest." },
      );
      return;
    }

    for (const task of mission.plan.tasks) {
      const settle = this.objectiveSettlements.get(task.taskId);
      if (settle) {
        this.objectiveSettlements.delete(task.taskId);
        settle(task);
      }
    }
    const dependencies = this.store.listMissionDependencies(missionId);
    const satisfiedTaskIds = new Set<string>(
      dependencies.filter((d) => d.satisfiedAt != null).map((d) => d.dependsOnTaskId),
    );
    const failedTaskIds = new Set<string>();
    const cancelledTaskIds = new Set<string>();

    for (const t of mission.plan.tasks) {
      if (t.phase === "failed") failedTaskIds.add(t.taskId);
      if (t.phase === "cancelled") cancelledTaskIds.add(t.taskId);
      if (t.phase === "completed") satisfiedTaskIds.add(t.taskId);
    }

    // Check existing active reservations
    const allActiveReservations = this.store.listActiveReservations();
    const missionReservations = allActiveReservations.filter((r) => r.missionId === missionId);
    for (const reservation of missionReservations) {
      if (reservation.status !== "starting" || isTaskRunLive(reservation.taskId) || this.objectiveStarts.has(reservation.taskId)) continue;
      const taskPlan = mission.plan.tasks.find(item => item.taskId === reservation.taskId);
      recordPreparation({
        missionId, taskId: reservation.taskId, revision: mission.revision, role: "developer", status: "interrupted",
        detail: "Developer preparation ended before a run was recorded. It was not retried.",
      });
      if (taskPlan && taskPlan.phase !== "completed") {
        // Waiting for the Owner, not "blocked": a blocked task is re-evaluated on every tick and would be dispatched
        // again as soon as a slot is free. This one needs the Owner (an approved amendment re-arms it).
        taskPlan.phase = "awaiting_owner";
        taskPlan.blockedStage = "developer";
        taskPlan.recovery = "interrupted-launch";
        taskPlan.phaseReason = "Developer preparation was interrupted before a run existed. Owner review is required.";
      }
      if (objective && taskPlan) noteAutonomousLaunchFinished(mission, taskPlan);
      this.store.releaseTaskReservation(reservation.taskId);
    }
    const activeReservations = this.store.listActiveReservations();

    // Concurrency counts
    let occupiedGlobal = activeReservations.length;
    const occupiedByProject = new Map<string, number>();
    const occupiedByAccount = new Map<string, number>();

    for (const r of activeReservations) {
      occupiedByProject.set(r.projectPath, (occupiedByProject.get(r.projectPath) || 0) + 1);
      if (r.accountId) {
        occupiedByAccount.set(r.accountId, (occupiedByAccount.get(r.accountId) || 0) + 1);
      }
    }

    // Step 1: Reconcile in-flight tasks
    for (const taskPlan of mission.plan.tasks) {
      if (this.objectiveStarts.has(taskPlan.taskId)) continue;
      const taskRecord = tasks.get(taskPlan.taskId);
      const reservation = this.store.getReservation(taskPlan.taskId);
      if (reservation && reservation.missionId !== missionId) continue;
      if (objective && (!taskRecord || taskRecord.archivedAt != null) &&
        !["completed", "failed", "cancelled"].includes(taskPlan.phase) && !isTaskRunLive(taskPlan.taskId)) {
        taskPlan.phase = "failed";
        taskPlan.objectiveBlockers = ["source"];
        failedTaskIds.add(taskPlan.taskId);
        noteAutonomousLaunchFinished(mission, taskPlan);
        noteAutonomousReviewFinished(mission, taskPlan);
        this.store.releaseTaskReservation(taskPlan.taskId);
        continue;
      }
      if (reservation?.status === "running" && reservation.runId) {
        taskPlan.phase = "running";
        taskPlan.runId = reservation.runId;
      }
      if (objective && taskPlan.pendingLaunch) {
        const admission = checkProjectLaunchAdmission(taskPlan.projectPath);
        taskPlan.objectiveBlockers = admission.allowed ? [] : ["stopped"];
        if (!admission.allowed) {
          this.objectiveConfirmations.delete(taskPlan.pendingLaunch.operationId);
          taskPlan.phase = "awaiting_owner";
          continue;
        }
      }
      if (objective && ["awaiting_owner", "awaiting_qc"].includes(taskPlan.phase)) {
        if (taskPlan.pendingLaunch?.role === "reviewer" && this.objectiveConfirmations.has(taskPlan.pendingLaunch.operationId)) {
          taskPlan.phase = "awaiting_qc";
        } else if (!taskPlan.pendingLaunch && taskRecord?.column === "review" && taskPlan.objectiveBlockers?.some(blocker => ["test", "publish", "artifact"].includes(blocker)) && !taskPlan.objectiveBlockers.includes("accept")) {
          taskPlan.phase = "awaiting_qc";
        }
        if (taskPlan.objectiveBlockers?.includes("accept")) {
          const residue = objectivePublicationBlock(taskPlan);
          taskPlan.objectiveBlockers = residue ? [residue, "accept"] : ["accept"];
        }
        if (taskPlan.objectiveBlockers?.includes("accept") && taskRecord?.column === "ready") {
          const rounds = taskRecord.qcState;
          if (rounds && rounds.roundCount < rounds.maxRounds) {
            if (getTaskWorkspace(taskPlan.taskId)?.status !== "published") rearmSettledWorkspace(taskPlan.taskId);
            taskPlan.reworkEpoch = (taskPlan.reworkEpoch ?? 0) + 1;
            taskPlan.phase = "authorized";
            taskPlan.qcReviewId = undefined;
          }
        }
      }

      if (taskRecord?.column === "done" && ["awaiting_owner", "qc_running"].includes(taskPlan.phase) &&
        !isTaskRunLive(taskPlan.taskId) && (!taskPlan.qcRequired || taskQualityReviews.listForTask(taskPlan.taskId).some(review =>
          review.status === "complete" && review.verdict === "PASS" && review.implementationRunId === taskPlan.runId))) {
        // The board's Owner acceptance path recorded Done and acknowledged QC.
        // Reconcile it before evaluating downstream mission dependencies.
        const done = db.query<{ at: number }, [string]>(
          "SELECT at FROM usage_task_transitions WHERE task_id = ? AND destination = 'done' ORDER BY id DESC LIMIT 1",
        ).get(taskPlan.taskId);
        taskPlan.phase = "completed";
        taskPlan.phaseReason = undefined;
        taskPlan.completedAt = done?.at ?? Date.now();
        if (objective) {
          taskPlan.objectiveBlockers = [];
          const summary = taskQualityReviews.get(taskPlan.qcReviewId ?? "")?.summary;
          if (summary) taskPlan.resultSummary = redactSecrets(summary).slice(0, 600);
        }
        satisfiedTaskIds.add(taskPlan.taskId);
        noteAutonomousReviewFinished(mission, taskPlan);
        this.store.markDependencySatisfied(missionId, taskPlan.taskId);
        this.store.releaseTaskReservation(taskPlan.taskId);
        continue;
      }

      if (taskPlan.phase === "running" || taskPlan.phase === "awaiting_qc" && (taskPlan.reviewerBinding || taskPlan.blockedStage === "reviewer") || reservation?.status === "running") {
        // Check if employee run completed
        const isLive = isTaskRunLive(taskPlan.taskId);
        const column = taskRecord?.column;
        const run = !isLive && taskPlan.runId ? runs.get(taskPlan.runId) : null;
        const refusedRun = run?.status === "failed" ? providerRefusalsForRuns([run.id]).get(run.id) : undefined;

        const exactReview = taskPlan.reviewerBinding;
        if (!isLive && (column === "review" || column === "blocked" && exactReview && settledMissionImplementation(taskPlan))) {
          noteAutonomousLaunchFinished(mission, taskPlan);
          if (taskPlan.qcRequired) {
            const practical = objective ? { kind: "skip" as const } : await considerPracticalTest(missionId, taskPlan);
            if (practical.kind === "deferred") continue;
            if (practical.kind === "rework") {
              const rework = autonomyReworkDecision(mission, taskPlan);
              if (rework.kind === "rework") {
                rearmSettledWorkspace(taskPlan.taskId);
                tasks.update(taskPlan.taskId, { column: "ready", runId: null });
                taskPlan.reworkEpoch = (taskPlan.reworkEpoch ?? 0) + 1;
                taskPlan.phase = "authorized";
                taskPlan.phaseReason = practical.reason;
                taskPlan.qcReviewId = undefined;
                this.store.releaseTaskReservation(taskPlan.taskId);
              } else {
                taskPlan.phase = "failed";
                taskPlan.phaseReason = rework.kind === "block" ? rework.reason : practical.reason;
                failedTaskIds.add(taskPlan.taskId);
                this.store.releaseTaskReservation(taskPlan.taskId);
              }
              continue;
            }
            if (practical.kind === "block") {
              taskPlan.phase = practical.owner ? "awaiting_owner" : "failed";
              taskPlan.phaseReason = practical.reason;
              if (!practical.owner) failedTaskIds.add(taskPlan.taskId);
              this.store.releaseTaskReservation(taskPlan.taskId);
              continue;
            }
            const exact = taskPlan.reviewerBinding;
            const reviewResource = exact ?? taskPlan;
            const retry = this.quotaRetry(mission, taskPlan, "reviewer");
            const admission = checkProjectLaunchAdmission(taskPlan.projectPath);
            if (!admission.allowed) {
              taskPlan.phase = "awaiting_qc";
              taskPlan.blockedStage = "reviewer";
              taskPlan.phaseReason = undefined;
              taskPlan.waitingOn = "project-stopped";
              taskPlan.accountLimit = undefined;
              if (objective) taskPlan.objectiveBlockers = ["stopped"];
              this.quotaRetries.delete(taskPlan.taskId);
              this.store.releaseTaskReservation(taskPlan.taskId);
              recordMissionWait(missionId, taskPlan.taskId, null);
              continue;
            }
            if (this.holdForQuota(mission, taskPlan, "reviewer", reviewResource)) {
              this.store.releaseTaskReservation(taskPlan.taskId);
              continue;
            }
            if (!exact && taskPlan.phase === "awaiting_qc" && taskPlan.blockedStage === "reviewer") {
              const slot = this.capacityFor(mission, taskPlan, taskPlan.accountId);
              if (slot) {
                taskPlan.phaseReason = slot.reason;
                taskPlan.waitingOn = "slot";
                recordMissionWait(missionId, taskPlan.taskId, slot.wait);
                continue;
              }
            }
            if (exact) {
              const problem = (objective ? verifyObjectiveStage : verifyMissionStage)(mission, taskPlan, "reviewer", exact, retry);
              if (problem) {
                taskPlan.phase = objective ? "awaiting_qc" : "blocked";
                if (objective) taskPlan.objectiveBlockers = checkProjectLaunchAdmission(taskPlan.projectPath).allowed ? ["reviewer-account"] : ["stopped"];
                taskPlan.blockedStage = "reviewer";
                taskPlan.phaseReason = problem;
                this.store.releaseTaskReservation(taskPlan.taskId);
                continue;
              }
              // Developer has settled, and the practical test has completed.
              // Free its slot before acquiring the distinct Reviewer slot.
              this.store.releaseTaskReservation(taskPlan.taskId);
              taskPlan.phase = "awaiting_qc";
              const capacity = this.capacityFor(mission, taskPlan, exact.accountId, taskPlan.objectiveTask?.reviewerId);
              if (capacity) {
                if (objective) taskPlan.objectiveBlockers = [capacity.wait === "account-capacity" ? "account-slot" : "worker-slot"];
                taskPlan.phaseReason = capacity.reason;
                recordMissionWait(missionId, taskPlan.taskId, capacity.wait);
                continue;
              }
              const auth = await authenticateBinding(exact);
              if (this.holdForQuota(mission, taskPlan, "reviewer", exact)) continue;
              if (!auth.ok || (objective ? verifyObjectiveStage : verifyMissionStage)(mission, taskPlan, "reviewer", exact, retry)) {
                taskPlan.phase = objective ? "awaiting_qc" : "blocked";
                if (objective) taskPlan.objectiveBlockers = ["reviewer-account"];
                taskPlan.blockedStage = "reviewer";
                taskPlan.phaseReason = auth.ok ? "Reviewer authorization changed." : auth.reason;
                continue;
              }
              const refreshedCapacity = this.capacityFor(mission, taskPlan, exact.accountId, taskPlan.objectiveTask?.reviewerId);
              if (refreshedCapacity) {
                if (objective) taskPlan.objectiveBlockers = [refreshedCapacity.wait === "account-capacity" ? "account-slot" : "worker-slot"];
                taskPlan.phaseReason = refreshedCapacity.reason;
                recordMissionWait(missionId, taskPlan.taskId, refreshedCapacity.wait);
                continue;
              }
            }
            recordMissionWait(missionId, taskPlan.taskId, null);
            if (objective && exact) {
              await this.prepareObjectiveReview(mission, taskPlan, exact);
              continue;
            }
            if (this.store.getMission(missionId)?.status !== "running") return;
            const reviewerGate = gateMissionProviderLaunch({
              missionId,
              taskId: taskPlan.taskId,
              taskTitle: taskPlan.taskTitle,
              projectPath: taskPlan.projectPath,
              workspace: taskPlan.projectPath,
              role: "reviewer",
              harnessId: exact?.harnessId ?? taskPlan.harnessId,
              modelId: exact?.modelId ?? taskPlan.modelId,
              accountId: exact?.accountId ?? taskPlan.accountId,
              mode: exact?.mode ?? "ask",
              reservationId: `reviewer:${taskPlan.taskId}:${taskPlan.reworkEpoch ?? 0}`,
              employeeId: "reviewer",
              projectPaused: false,
              completedRunIds: runs.listForTask(taskPlan.taskId).filter(run => run.status === "succeeded" || run.status === "failed" || run.status === "cancelled").map(run => run.id),
            });
            if (!reviewerGate.ok) {
              taskPlan.phase = "blocked";
              taskPlan.blockedStage = "reviewer";
              taskPlan.phaseReason = reviewerGate.reason;
              this.store.releaseTaskReservation(taskPlan.taskId);
              continue;
            }
            const reviewHold = autonomousResourceHold(mission, taskPlan, "reviewer", retry);
            if (reviewHold) {
              dropDispatchLease(taskPlan.taskId);
              taskPlan.phase = "awaiting_owner";
              taskPlan.blockedStage = "reviewer";
              taskPlan.phaseReason = reviewHold;
              continue;
            }
            const reviewGate = autonomyReviewDecision(mission, taskPlan);
            if (reviewGate.kind === "deny") {
              dropDispatchLease(taskPlan.taskId);
              taskPlan.phase = "blocked";
              taskPlan.blockedStage = "reviewer";
              taskPlan.phaseReason = reviewGate.reason;
              if (!exact && reservation) this.store.updateReservationStatus(taskPlan.taskId, "failed");
              continue;
            }
            taskPlan.phase = "awaiting_qc";
            if (!exact && reservation) this.store.updateReservationStatus(taskPlan.taskId, "awaiting_qc");

            let reviewId: string | null = null;
            this.quotaRetries.delete(taskPlan.taskId);
            try {
              recordPreparation({ missionId, taskId: taskPlan.taskId, revision: mission.revision, role: "reviewer", status: "started" });
              const prep = prepareQcReview({
                taskId: taskPlan.taskId,
                reviewerHarness: exact?.harnessId ?? taskPlan.harnessId,
                reviewerModel: exact?.modelId ?? taskPlan.modelId,
              }, exact ? { implementationRunId: taskPlan.runId, allowColumns: ["review", "blocked"] } : undefined);
              reviewId = prep.review.id;
              if (exact) {
                this.store.createReservation({
                  missionId, taskId: taskPlan.taskId, projectPath: taskPlan.projectPath,
                  employeeId: "reviewer", accountId: exact.accountId, harnessId: exact.harnessId,
                  modelId: exact.modelId, status: "qc_running", qcReviewId: reviewId,
                });
                taskPlan.phase = "qc_running";
                taskPlan.qcReviewId = reviewId;
                this.store.saveMissionPlanState(missionId, mission.plan, mission.state);
              }
              const started = await startQcReview(reviewId, undefined, exact ? {
                mode: exact.mode,
                effort: defaultEffortFor(harnesses.get(exact.harnessId)!.kind, exact.modelId, exact.harnessId),
                allowColumns: ["review", "blocked"],
                evidenceNote: "Use the recorded implementation and test evidence. Review with read-only tools.",
                verify: () => missionAccountLimit(exact, "reviewer", this.now(), retry) ? "The Reviewer account is waiting on a provider limit."
                  : verifyMissionStage(mission, taskPlan, "reviewer", exact, retry),
                onRunRecorded: (runId) => {
                  this.store.updateReservationStatus(taskPlan.taskId, "qc_running", { runId });
                },
              } : undefined);
              if ("error" in started) throw new Error(started.error);
              recordPreparation({ missionId, taskId: taskPlan.taskId, revision: mission.revision, role: "reviewer", status: "completed" });
              taskPlan.phase = "qc_running";
              taskPlan.qcReviewId = reviewId;
              if (!exact && reservation) this.store.updateReservationStatus(taskPlan.taskId, "qc_running", { qcReviewId: reviewId });
            } catch (e) {
              dropDispatchLease(taskPlan.taskId);
              recordPreparation({
                missionId, taskId: taskPlan.taskId, revision: mission.revision, role: "reviewer", status: "failed",
                detail: e instanceof Error ? e.message : "QC review preparation failed",
              });
              taskPlan.phase = "blocked";
              taskPlan.blockedStage = "reviewer";
              taskPlan.phaseReason = e instanceof Error ? e.message : "QC review preparation failed";
              if (reviewId && taskQualityReviews.get(reviewId)?.status === "pending") cancelPendingQcReview(reviewId);
              if (exact) {
                noteAutonomousReviewFinished(mission, taskPlan);
                this.store.releaseTaskReservation(taskPlan.taskId);
              } else if (reservation) this.store.updateReservationStatus(taskPlan.taskId, "failed");
            }
          } else {
            // No QC required; task complete
            taskPlan.phase = "completed";
            taskPlan.completedAt = Date.now();
            satisfiedTaskIds.add(taskPlan.taskId);
            this.store.markDependencySatisfied(missionId, taskPlan.taskId);
            this.store.releaseTaskReservation(taskPlan.taskId);
            occupiedGlobal--;
            occupiedByProject.set(
              taskPlan.projectPath,
              Math.max(0, (occupiedByProject.get(taskPlan.projectPath) || 1) - 1),
            );
          }
        } else if (column === "done" && !objective) {
          taskPlan.phase = "completed";
          taskPlan.completedAt = Date.now();
          satisfiedTaskIds.add(taskPlan.taskId);
          this.store.markDependencySatisfied(missionId, taskPlan.taskId);
          this.store.releaseTaskReservation(taskPlan.taskId);
          occupiedGlobal--;
          occupiedByProject.set(
            taskPlan.projectPath,
            Math.max(0, (occupiedByProject.get(taskPlan.projectPath) || 1) - 1),
          );
        } else if (column === "blocked" && !objective && !refusedRun) {
          taskPlan.phase = "blocked";
          taskPlan.phaseReason = "Task moved to blocked column.";
          this.store.releaseTaskReservation(taskPlan.taskId);
        } else if (!isLive) {
          if (run && (run.status === "failed" || run.status === "cancelled" || run.status === "orphaned")) {
            noteAutonomousLaunchFinished(mission, taskPlan);
            if (run.status === "orphaned") taskPlan.recovery = "uncertain-outcome";
            taskPlan.phase = run.status === "cancelled" ? "cancelled" : "failed";
            taskPlan.phaseReason = run.status === "cancelled"
              ? "The run was cancelled. It was not relaunched."
              : run.status === "orphaned"
                ? "Provider outcome is indeterminate. It was not treated as success and was not retried."
                : "The provider run failed. It was not retried.";
            if (refusedRun?.accountId) {
              taskPlan.accountLimit = {
                role: "developer", accountId: refusedRun.accountId, accountLabel: refusedRun.accountLabel ?? run.agent,
                resetAt: null, refusal: refusedRun,
              };
            }
            if (run.status === "cancelled") cancelledTaskIds.add(taskPlan.taskId);
            else failedTaskIds.add(taskPlan.taskId);
            this.store.releaseTaskReservation(taskPlan.taskId);
          }
        }
      } else if (taskPlan.phase === "qc_running" || reservation?.status === "qc_running") {
        // Inspect QC review result
        const reviewId = taskPlan.qcReviewId || reservation?.qcReviewId;
        if (reviewId) {
          if (objective && !isTaskRunLive(taskPlan.taskId)) reconcileInterruptedObjectiveReview(reviewId);
          const review = taskQualityReviews.get(reviewId);
          if (objective && review?.status === "pending") {
            // A recorded QC operation with no launch after restart requires a fresh confirmation.
            taskPlan.phase = "awaiting_owner";
            taskPlan.pendingLaunch = { role: "reviewer", operationId: review.id };
            this.store.releaseTaskReservation(taskPlan.taskId);
          }
          if (taskPlan.reviewerBinding && review?.status === "cancelled" && !isTaskRunLive(taskPlan.taskId)) {
            noteAutonomousReviewFinished(mission, taskPlan);
            taskPlan.phase = objective ? "failed" : "blocked";
            if (objective) {
              taskPlan.recovery = "uncertain-outcome";
              failedTaskIds.add(taskPlan.taskId);
            }
            taskPlan.blockedStage = "reviewer";
            taskPlan.phaseReason = "Reviewer execution was interrupted. Review an exact replacement before another launch.";
            this.store.releaseTaskReservation(taskPlan.taskId);
          }
          if (review && review.status === "complete") {
            noteAutonomousReviewFinished(mission, taskPlan);
            if (objective) {
              this.store.releaseTaskReservation(taskPlan.taskId);
              taskPlan.phase = "awaiting_owner";
              if (review.verdict === "PASS") {
                const blocker = objectivePublicationBlock(taskPlan);
                taskPlan.objectiveBlockers = blocker ? [blocker, "accept"] : ["accept"];
                // A project policy that covers it applies the reviewed result and accepts it. The next tick reconciles Done.
                const completion = await handsoffCompleteMissionTask(taskPlan.taskId);
                if (completion.kind === "done") taskPlan.phaseReason = undefined;
                else taskPlan.phaseReason = completion.reason;
              } else {
                const rework = review.verdict === "CHANGES_REQUESTED" ? autonomyReworkDecision(mission, taskPlan) : null;
                const roundsRemain = review.round < (taskRecord?.qcState?.maxRounds ?? 0);
                const mayRework = roundsRemain && (rework?.kind === "rework" || rework?.kind === "legacy");
                if (mayRework && (getTaskWorkspace(taskPlan.taskId)?.status === "published" || rearmSettledWorkspace(taskPlan.taskId))) {
                  storePracticalReworkBrief({
                    taskId: taskPlan.taskId, epoch: (taskPlan.reworkEpoch ?? 0) + 1, kind: classifyReviewFailure(review.summary),
                    requirements: taskPlan.objectiveTask!.description, diff: null, testErrors: null,
                    reviewerFindings: review.feedback ?? review.summary, projectRules: null,
                  });
                  tasks.update(taskPlan.taskId, { column: "ready", runId: null });
                  taskPlan.reworkEpoch = (taskPlan.reworkEpoch ?? 0) + 1;
                  taskPlan.phase = "authorized";
                  taskPlan.qcReviewId = undefined;
                  taskPlan.objectiveBlockers = [];
                } else {
                  taskPlan.phase = "failed";
                  taskPlan.phaseReason = rework?.kind === "block" ? rework.reason : `QC: ${review.verdict ?? "BLOCKED"}`;
                  failedTaskIds.add(taskPlan.taskId);
                }
              }
              continue;
            }
            const qcGate = autonomyQcDecision(mission, taskPlan, review.verdict);
            const finish = () => {
              taskPlan.phase = "completed";
              taskPlan.completedAt = Date.now();
              satisfiedTaskIds.add(taskPlan.taskId);
              this.store.markDependencySatisfied(missionId, taskPlan.taskId);
              this.store.releaseTaskReservation(taskPlan.taskId);
              occupiedGlobal--;
              occupiedByProject.set(
                taskPlan.projectPath,
                Math.max(0, (occupiedByProject.get(taskPlan.projectPath) || 1) - 1),
              );
            };
            if (qcGate.kind === "legacy") {
              if (review.verdict === "PASS") finish();
              else {
                taskPlan.phase = "failed";
                taskPlan.phaseReason = `QC Verdict: ${review.verdict}`;
                failedTaskIds.add(taskPlan.taskId);
                this.store.releaseTaskReservation(taskPlan.taskId);
              }
            } else if (qcGate.kind === "complete") {
              const done = acceptAuthorizedTaskDone(taskPlan.taskId);
              if (!done.ok || done.task.column !== "done") {
                taskPlan.phase = "awaiting_owner";
                taskPlan.phaseReason = done.ok ? "Completion did not reach Done." : done.reason;
                this.store.releaseTaskReservation(taskPlan.taskId);
              } else {
                finish();
                void recordAutonomousObservation({
                  missionId,
                  taskTitle: taskPlan.taskTitle,
                  projectPath: taskPlan.projectPath,
                  reviewId: review.id,
                  verdict: "PASS",
                  summary: review.summary,
                }).catch(() => undefined);
              }
            } else if (qcGate.kind === "rework") {
              noteAutonomousLaunchFinished(mission, taskPlan);
              const kind = classifyReviewFailure(review.summary);
              storePracticalReworkBrief({
                taskId: taskPlan.taskId,
                epoch: (taskPlan.reworkEpoch ?? 0) + 1,
                kind,
                requirements: tasks.get(taskPlan.taskId)?.prompt ?? taskPlan.taskTitle,
                diff: null,
                testErrors: null,
                reviewerFindings: review.summary,
                projectRules: null,
              });
              rearmSettledWorkspace(taskPlan.taskId);
              taskPlan.reworkEpoch = (taskPlan.reworkEpoch ?? 0) + 1;
              taskPlan.phase = "authorized";
              taskPlan.phaseReason = qcGate.reason;
              taskPlan.qcReviewId = undefined;
              this.store.releaseTaskReservation(taskPlan.taskId);
            } else if (qcGate.kind === "await-owner") {
              taskPlan.phase = "awaiting_owner";
              taskPlan.phaseReason = qcGate.reason;
              this.store.releaseTaskReservation(taskPlan.taskId);
            } else {
              taskPlan.phase = "failed";
              taskPlan.phaseReason = qcGate.reason;
              failedTaskIds.add(taskPlan.taskId);
              this.store.releaseTaskReservation(taskPlan.taskId);
            }
          }
        }
      }
    }

    // Reservations released while reconciling this tick must not keep a slot.
    // The next dispatch reads the rows that are still reserved.
    const reservedNow = this.store.listActiveReservations();
    occupiedGlobal = reservedNow.length;
    occupiedByProject.clear();
    occupiedByAccount.clear();
    for (const reservation of reservedNow) {
      occupiedByProject.set(reservation.projectPath, (occupiedByProject.get(reservation.projectPath) || 0) + 1);
      if (reservation.accountId) {
        occupiedByAccount.set(reservation.accountId, (occupiedByAccount.get(reservation.accountId) || 0) + 1);
      }
    }

    // Step 2: Evaluate readiness and blockers for unstarted tasks
    const readyCandidates: MissionTaskPlan[] = [];
    if (objective) {
      for (const task of topologicalSortTasks(mission.plan.tasks)) {
        if (!["planned", "authorized", "blocked", "awaiting_owner"].includes(task.phase) || task.runId) continue;
        if (task.dependencies.some(dep => failedTaskIds.has(dep.taskId) || cancelledTaskIds.has(dep.taskId))) {
          if (task.pendingLaunch) this.objectiveConfirmations.delete(task.pendingLaunch.operationId);
          task.pendingLaunch = undefined;
          task.phase = "cancelled";
          task.waitingOn = "dependency";
          cancelledTaskIds.add(task.taskId);
        }
      }
    }

    for (const taskPlan of mission.plan.tasks) {
      if (this.objectiveStarts.has(taskPlan.taskId)) continue;
      const confirmedDeveloper = objective && taskPlan.pendingLaunch?.role === "developer" &&
        this.objectiveConfirmations.has(taskPlan.pendingLaunch.operationId);
      if (
        !confirmedDeveloper && taskPlan.phase !== "planned" &&
        taskPlan.phase !== "authorized" &&
        taskPlan.phase !== "blocked"
      ) {
        continue;
      }

      taskPlan.waitingOn = undefined;
      const depEval = evaluateTaskDependencies(
        taskPlan,
        satisfiedTaskIds,
        failedTaskIds,
        cancelledTaskIds,
      );

      if (taskPlan.phase === "blocked" && taskPlan.blockedStage === "reviewer" && (taskPlan.reviewerBinding || taskPlan.accountLimit)) continue;
      const unavailableInputs = objective && objectiveInputs(mission, taskPlan) === null;
      if (depEval.isBlocked || unavailableInputs) {
        taskPlan.accountLimit = undefined;
        if (objective) {
          taskPlan.objectiveBlockers = unavailableInputs && !depEval.isBlocked ? ["artifact"] : [];
          taskPlan.phaseReason = undefined;
          if (taskPlan.pendingLaunch) this.objectiveConfirmations.delete(taskPlan.pendingLaunch.operationId);
        }
        taskPlan.phase = "blocked";
        taskPlan.waitingOn = "dependency";
        taskPlan.blockers = depEval.blockers;
        recordMissionWait(missionId, taskPlan.taskId, "dependency");
        continue;
      }

      // Dependencies satisfied! Check earliest-start scheduled availability before adding to readyCandidates
      // so a time-blocked task never reserves a slot or blocks available lower-priority tasks.
      const availability = taskAvailabilityFor(tasks.get(taskPlan.taskId), this.now());
      if (!availability.available) {
        taskPlan.accountLimit = undefined;
        taskPlan.blockers = [];
        if (objective) {
          taskPlan.objectiveBlockers = [];
          if (taskPlan.pendingLaunch) this.objectiveConfirmations.delete(taskPlan.pendingLaunch.operationId);
          taskPlan.pendingLaunch = undefined;
        }
        taskPlan.phase = "blocked";
        taskPlan.waitingOn = "scheduled";
        taskPlan.phaseReason = `Waiting for scheduled time (${availability.availableFromUtc}).`;
        recordMissionWait(missionId, taskPlan.taskId, null);
        continue;
      }

      taskPlan.blockers = [];
      if (objective) taskPlan.objectiveBlockers = [];
      taskPlan.phase = "authorized";
      taskPlan.blockedStage = "developer";
      readyCandidates.push(taskPlan);
    }

    // Blocked dependencies are visible before any launch await. A caller that
    // returns while the tick is still starting workers can read them.
    this.store.saveMissionPlanState(missionId, mission.plan, mission.state);

    // Step 3: Priority & Starvation-Avoidance Scheduling
    const priorityRank: Record<MissionTaskPriority, number> = {
      critical: 0,
      high: 1,
      normal: 2,
      low: 3,
    };

    // Group ready candidates by project. Inside a project the higher priority goes first (plan order breaks ties).
    const byProject = new Map<string, MissionTaskPlan[]>();
    for (const task of readyCandidates) {
      const list = byProject.get(task.projectPath) || [];
      list.push(task);
      byProject.set(task.projectPath, list);
    }
    for (const list of byProject.values()) {
      list.sort((a, b) => (priorityRank[a.priority] ?? 2) - (priorityRank[b.priority] ?? 2));
    }

    // Projects go in priority order, then the project served least recently, then by path. The middle key is what
    // keeps the round robin fair from one tick to the next: without it every tick starts again at the same project,
    // so a project early in the alphabet takes each freed slot and a later one waits behind it indefinitely.
    const lastServed = (projectPath: string): number => mission.plan.tasks
      .filter((t) => t.projectPath === projectPath && t.startedAt != null)
      .reduce((latest, t) => Math.max(latest, t.startedAt ?? 0), 0);
    const sortedProjects = [...byProject.entries()].sort((a, b) => {
      const minPriorityA = Math.min(...a[1].map((t) => priorityRank[t.priority] ?? 2));
      const minPriorityB = Math.min(...b[1].map((t) => priorityRank[t.priority] ?? 2));
      return minPriorityA - minPriorityB || lastServed(a[0]) - lastServed(b[0]) || a[0].localeCompare(b[0]);
    });

    // Fair round-robin across projects
    const dispatchOrder: MissionTaskPlan[] = [];
    let hasRemaining = true;
    let roundIndex = 0;

    while (hasRemaining) {
      hasRemaining = false;
      for (const [, projectTasks] of sortedProjects) {
        if (roundIndex < projectTasks.length) {
          const item = projectTasks[roundIndex];
          if (item) {
            dispatchOrder.push(item);
          }
          if (roundIndex + 1 < projectTasks.length) {
            hasRemaining = true;
          }
        }
      }
      roundIndex++;
    }

    // Step 4: Dispatch eligible tasks within concurrency limits
    const limits = mission.concurrencyLimits;
    const remainingReservations = this.store.listActiveReservations();
    occupiedGlobal = remainingReservations.length;
    occupiedByProject.clear();
    occupiedByAccount.clear();
    for (const reservation of remainingReservations) {
      occupiedByProject.set(reservation.projectPath, (occupiedByProject.get(reservation.projectPath) ?? 0) + 1);
      if (reservation.accountId) occupiedByAccount.set(reservation.accountId, (occupiedByAccount.get(reservation.accountId) ?? 0) + 1);
    }

    for (const taskPlan of dispatchOrder) {
      if (this.store.getMission(missionId)?.status !== "running" || objective && autonomyPolicyStore.readEmergency().active) break;
      // A stopped project is named first: a slot wait would hide the real reason, and the task holds no slot either way.
      const stopped = checkProjectLaunchAdmission(taskPlan.projectPath);
      if (!stopped.allowed) {
        recordMissionWait(missionId, taskPlan.taskId, null);
        taskPlan.phase = "blocked";
        taskPlan.waitingOn = "project-stopped";
        taskPlan.accountLimit = undefined;
        this.quotaRetries.delete(taskPlan.taskId);
        taskPlan.phaseReason = stopped.reason ?? undefined;
        continue;
      }
      const exact = taskPlan.developerBinding;
      const retry = this.quotaRetry(mission, taskPlan, "developer");
      if (this.holdForQuota(mission, taskPlan, "developer", exact ?? taskPlan)) continue;
      // Check global limit
      if (occupiedGlobal >= limits.globalMax) {
        taskPlan.phaseReason = "Waiting for a global, cluster, or project worker slot.";
        recordMissionWait(missionId, taskPlan.taskId, "project-queue");
        taskPlan.waitingOn = "slot";
        continue;
      }

      // Check per-project limit
      const currentProjectOccupancy = occupiedByProject.get(taskPlan.projectPath) || 0;
      if (currentProjectOccupancy >= limits.perProjectMax) {
        taskPlan.phaseReason = "Waiting for a global, cluster, or project worker slot.";
        recordMissionWait(missionId, taskPlan.taskId, "project-queue");
        taskPlan.waitingOn = "slot";
        continue;
      }

      // Check per-account and shared provider limits. Do not move the task to another account.
      const capacity = profileCapacityAllows(db, taskPlan.accountId, limits.perAccountMax, occupiedByAccount);
      if (!capacity.allow) {
        if (objective) taskPlan.objectiveBlockers = ["account-slot"];
        taskPlan.phaseReason = capacity.reason;
        recordMissionWait(missionId, taskPlan.taskId, "account-capacity");
        taskPlan.waitingOn = "slot";
        continue;
      }

      // Check project lifecycle admission
      recordMissionWait(missionId, taskPlan.taskId, null);
      const admission = checkProjectLaunchAdmission(taskPlan.projectPath);
      if (!admission.allowed) {
        taskPlan.phase = "blocked";
        taskPlan.phaseReason = admission.reason ?? undefined;
        continue;
      }
      const deployGate = deploymentGateForTask(db, taskPlan.taskId);
      if (deployGate) {
        taskPlan.phase = "blocked";
        taskPlan.phaseReason = deployGate;
        continue;
      }

      const existingRes = this.store.getReservation(taskPlan.taskId);
      if (reservationBlocksRelaunch(existingRes?.status)) continue;

      const developerHold = autonomousResourceHold(mission, taskPlan, "developer", retry);
      if (developerHold) {
        taskPlan.phase = "awaiting_owner";
        taskPlan.blockedStage = "developer";
        taskPlan.phaseReason = developerHold;
        continue;
      }
      if (objective) {
        const setup = objectiveSetupBlockers(taskPlan, retry).filter(blocker => blocker !== "reviewer-account" && blocker !== "reviewer");
        if (setup.length) {
          taskPlan.phase = "blocked";
          taskPlan.objectiveBlockers = setup;
          continue;
        }
        const inputs = objectiveInputs(mission, taskPlan);
        const row = tasks.get(taskPlan.taskId);
        if (!inputs || !row || row.archivedAt != null || !["backlog", "ready"].includes(row.column)) {
          taskPlan.phase = "blocked";
          taskPlan.objectiveBlockers = [inputs ? "source" : "artifact"];
          continue;
        }
        const prompt = objectivePromptForTask(taskPlan, inputs);
        if (row.prompt !== objectivePromptForTask(taskPlan) && row.prompt !== prompt) {
          taskPlan.phase = "blocked";
          taskPlan.objectiveBlockers = ["source"];
          continue;
        }
        if (row.column === "backlog" || row.prompt !== prompt) tasks.update(taskPlan.taskId, { column: "ready", prompt });
      }
      const exactProblem = exact && (objective ? verifyObjectiveStage : verifyMissionStage)(mission, taskPlan, "developer", exact, retry);
      if (exactProblem) {
        taskPlan.phase = "blocked";
        taskPlan.phaseReason = exactProblem;
        if (objective) taskPlan.objectiveBlockers = ["permission"];
        if (exactProblem.includes("requires fresh verified headroom")) recordMissionWait(missionId, taskPlan.taskId, "quota");
        continue;
      }
      const launchGate = objective ? { kind: "legacy" as const } : autonomyLaunchDecision(mission, taskPlan);
      if (launchGate.kind === "skip") {
        taskPlan.phaseReason = launchGate.reason;
        recordMissionWait(missionId, taskPlan.taskId, "specialist-capacity");
        taskPlan.waitingOn = "slot";
        continue;
      }
      if (launchGate.kind === "deny") {
        taskPlan.phase = launchGate.reason.includes("already consumed") ? "failed" : "blocked";
        taskPlan.phaseReason = launchGate.reason;
        if (launchGate.reason.includes("requires fresh, positive, verified quota")) recordMissionWait(missionId, taskPlan.taskId, "quota");
        continue;
      }

      const structural = explainBinding({
        harnessId: taskPlan.harnessId,
        accountId: taskPlan.accountId,
        modelId: taskPlan.modelId,
        mode: taskPlan.mode, fingerprint: exact?.fingerprint,
      });
      if (structural.ok && structural.frozen) {
        const binding = await authenticateBinding({
          harnessId: taskPlan.harnessId,
          accountId: taskPlan.accountId,
          modelId: taskPlan.modelId,
          mode: taskPlan.mode, fingerprint: exact?.fingerprint,
        });
        if (!binding.ok) {
          taskPlan.phase = objective ? "blocked" : "failed";
          if (objective) taskPlan.objectiveBlockers = ["developer-account"];
          taskPlan.phaseReason = binding.reason;
          if (launchGate.kind === "allow") noteAutonomousLaunchFailed(launchGate.reservationId);
          continue;
        }
      }
      if (!structural.ok) {
        taskPlan.phase = "failed";
        taskPlan.phaseReason = structural.reason;
        if (launchGate.kind === "allow") noteAutonomousLaunchFailed(launchGate.reservationId);
        continue;
      }
      if (this.store.getMission(missionId)?.status !== "running" || !checkProjectLaunchAdmission(taskPlan.projectPath).allowed ||
        objective && autonomyPolicyStore.readEmergency().active) {
        if (launchGate.kind === "allow") noteAutonomousLaunchFailed(launchGate.reservationId);
        continue;
      }
      if (this.holdForQuota(mission, taskPlan, "developer", exact ?? taskPlan)) {
        if (launchGate.kind === "allow") noteAutonomousLaunchFailed(launchGate.reservationId);
        continue;
      }

      // Find employee ID for worker assignment
      const employeeId =
        taskPlan.assignedEmployeeId ||
        db
          .query<{ id: string }, [string]>(
            `SELECT id FROM ai_employees WHERE kind = 'worker' AND status = 'active' AND project_path = ? LIMIT 1`,
          )
          .get(taskPlan.projectPath)?.id ||
        "default-worker";

      const exactCapacity = (exact || limits.perClusterMax !== undefined) &&
        this.capacityFor(mission, taskPlan, taskPlan.accountId, employeeId === "default-worker" ? undefined : employeeId);
      if (exactCapacity) {
        if (objective && exactCapacity.wait === "account-capacity") taskPlan.objectiveBlockers = ["account-slot"];
        taskPlan.phaseReason = exactCapacity.reason;
        recordMissionWait(missionId, taskPlan.taskId, exactCapacity.wait);
        taskPlan.waitingOn = "slot";
        continue;
      }

      // Atomic reservation
      // The check above is a fast path and may be stale after any await (another mission's tick, an authentication).
      // The reservation itself re-checks both limits atomically with the insert; a refusal is a slot wait, not a launch.
      const reserved = this.store.tryCreateReservation({
        missionId,
        taskId: taskPlan.taskId,
        projectPath: taskPlan.projectPath,
        employeeId,
        accountId: taskPlan.accountId,
        harnessId: taskPlan.harnessId,
        modelId: taskPlan.modelId,
        status: "starting",
      }, { globalMax: limits.globalMax, perProjectMax: limits.perProjectMax });
      if (!reserved.ok) {
        taskPlan.phaseReason = reserved.reason;
        recordMissionWait(missionId, taskPlan.taskId, "project-queue");
        taskPlan.waitingOn = "slot";
        continue;
      }
      const res = reserved.reservation;

      taskPlan.phase = "starting";
      taskPlan.startedAt = Date.now();
      recordPreparation({ missionId, taskId: taskPlan.taskId, revision: mission.revision, role: "developer", status: "started" });

      const workspace = objective ? { ok: true as const } : await ensurePracticalWorkspace(missionId, taskPlan);
      if (!workspace.ok) {
        recordPreparation({
          missionId, taskId: taskPlan.taskId, revision: mission.revision, role: "developer", status: "failed", detail: workspace.reason,
        });
        taskPlan.phase = "failed";
        taskPlan.phaseReason = workspace.reason;
        this.store.releaseTaskReservation(taskPlan.taskId);
        if (launchGate.kind === "allow") noteAutonomousLaunchFailed(launchGate.reservationId);
        continue;
      }
      recordPreparation({ missionId, taskId: taskPlan.taskId, revision: mission.revision, role: "developer", status: "completed" });

      if (this.store.getMission(missionId)?.status !== "running" || !checkProjectLaunchAdmission(taskPlan.projectPath).allowed) {
        this.store.releaseTaskReservation(taskPlan.taskId);
        if (launchGate.kind === "allow") noteAutonomousLaunchFailed(launchGate.reservationId);
        taskPlan.phase = "authorized";
        continue;
      }
      // Recheck scheduled availability after reservation/await so an edited schedule blocks early dispatch.
      const postResAvail = taskAvailabilityFor(tasks.get(taskPlan.taskId), this.now());
      if (!postResAvail.available) {
        this.store.releaseTaskReservation(taskPlan.taskId);
        if (launchGate.kind === "allow") noteAutonomousLaunchFailed(launchGate.reservationId);
        taskPlan.phase = "blocked";
        taskPlan.waitingOn = "scheduled";
        taskPlan.phaseReason = `Waiting for scheduled time (${postResAvail.availableFromUtc}).`;
        continue;
      }
      if (this.holdForQuota(mission, taskPlan, "developer", exact ?? taskPlan)) {
        this.store.releaseTaskReservation(taskPlan.taskId);
        if (launchGate.kind === "allow") noteAutonomousLaunchFailed(launchGate.reservationId);
        continue;
      }
      if (objective && exact) {
        await this.prepareObjectiveDeveloper(mission, taskPlan, exact);
        const counts = this.store.listActiveReservations();
        occupiedGlobal = counts.length;
        occupiedByProject.set(taskPlan.projectPath, counts.filter(item => item.projectPath === taskPlan.projectPath).length);
        if (taskPlan.accountId) occupiedByAccount.set(taskPlan.accountId, counts.filter(item => item.accountId === taskPlan.accountId).length);
        continue;
      }

      this.quotaRetries.delete(taskPlan.taskId);

      const providerGate = gateMissionProviderLaunch({
        missionId,
        taskId: taskPlan.taskId,
        taskTitle: taskPlan.taskTitle,
        projectPath: taskPlan.projectPath,
        workspace: taskPlan.projectPath,
        role: "developer",
        harnessId: taskPlan.harnessId,
        modelId: taskPlan.modelId,
        accountId: taskPlan.accountId,
        mode: taskPlan.mode,
        reservationId: res.id,
        employeeId,
        projectPaused: false,
        completedRunIds: runs.listForTask(taskPlan.taskId).map(run => run.id),
      });
      if (!providerGate.ok) {
        taskPlan.phase = providerGate.code === "project-paused" ? "blocked" : "failed";
        taskPlan.phaseReason = providerGate.reason;
        this.store.releaseTaskReservation(taskPlan.taskId);
        if (launchGate.kind === "allow") noteAutonomousLaunchFailed(launchGate.reservationId);
        continue;
      }

      const runDeps: EmployeeRunDeps = exact ? {
        ...this.runDeps,
        missionStage: {
          mode: exact.mode,
          verify: () => {
            const avail = taskAvailabilityFor(tasks.get(taskPlan.taskId), this.now());
            if (!avail.available) return `Task is scheduled to be available from ${avail.availableFromUtc}. Waiting for scheduled time.`;
            return missionAccountLimit(exact, "developer", this.now(), retry) ? "The Developer account is waiting on a provider limit."
              : verifyMissionStage(mission, taskPlan, "developer", exact, retry);
          },
          onRunRecorded: (runId) => {
            this.store.updateReservationStatus(taskPlan.taskId, "running", { runId });
            if (launchGate.kind === "allow") noteAutonomousLaunchStarted(launchGate.reservationId);
          },
        },
      } : this.runDeps;
      // Launch execution
      try {
        const review = await reviewEmployeeExecution(
          {
            taskId: taskPlan.taskId,
            harnessId: taskPlan.harnessId,
            model: taskPlan.modelId,
          },
          runDeps,
        );

        if (!review.attempt) {
          // Preflight blocked
          dropDispatchLease(taskPlan.taskId);
          taskPlan.phase = "blocked";
          taskPlan.phaseReason =
            review.blockingErrors[0]?.message || "Employee preflight blocked.";
          this.store.releaseTaskReservation(taskPlan.taskId);
          if (launchGate.kind === "allow") noteAutonomousLaunchFailed(launchGate.reservationId);
          continue;
        }

        const status = this.store.getMission(missionId)?.status;
        const admitted = status === "running" && checkProjectLaunchAdmission(taskPlan.projectPath).allowed;
        const preDispatchAvail = taskAvailabilityFor(tasks.get(taskPlan.taskId), this.now());
        if (!admitted || !preDispatchAvail.available || this.holdForQuota(mission, taskPlan, "developer", exact ?? taskPlan, retry)) {
          dropDispatchLease(taskPlan.taskId);
          cancelEmployeeExecution(review.attempt.id, { revision: review.attempt.revision }, runDeps);
          this.store.releaseTaskReservation(taskPlan.taskId);
          if (launchGate.kind === "allow") noteAutonomousLaunchFailed(launchGate.reservationId);
          if (!preDispatchAvail.available) {
            taskPlan.phase = "blocked";
            taskPlan.waitingOn = "scheduled";
            taskPlan.phaseReason = `Waiting for scheduled time (${preDispatchAvail.availableFromUtc}).`;
          } else if (!admitted) {
            taskPlan.phase = "authorized";
          }
          continue;
        }

        const started = await startEmployeeExecution(
          review.attempt.id,
          {
            revision: review.attempt.revision,
            confirm: true,
            acknowledgeUsage: true,
            // A bound autonomy policy is the grant. The older orchestrated-workflow
            // id is only passed for unbound missions, which keep their existing path.
            ...(launchGate.kind === "legacy" ? { orchestratedWorkflowId: missionId } : {}),
          },
          runDeps,
        );

        const launchedRunId = started.attempt.runId ?? undefined;
        if (started.attempt.status !== "started" || !launchedRunId) {
          dropDispatchLease(taskPlan.taskId);
          taskPlan.phase = "failed";
          taskPlan.phaseReason = started.attempt.reason ?? `Employee start is ${started.attempt.status}. Nothing was left running.`;
          this.store.releaseTaskReservation(taskPlan.taskId);
          if (launchGate.kind === "allow") noteAutonomousLaunchFailed(launchGate.reservationId);
          continue;
        }
        taskPlan.phase = "running";
        taskPlan.recovery = undefined;
        taskPlan.blockedStage = undefined;
        taskPlan.phaseReason = undefined;
        taskPlan.runId = launchedRunId;
        if (launchGate.kind === "allow") noteAutonomousLaunchStarted(launchGate.reservationId);
        if ((taskPlan.reworkEpoch ?? 0) > 0) consumePracticalReworkBrief(taskPlan.taskId);
        this.store.updateReservationStatus(taskPlan.taskId, "running", {
          runId: launchedRunId,
        });

        // Update active occupancies
        occupiedGlobal++;
        occupiedByProject.set(taskPlan.projectPath, currentProjectOccupancy + 1);
        if (taskPlan.accountId) {
          occupiedByAccount.set(
            taskPlan.accountId,
            (occupiedByAccount.get(taskPlan.accountId) || 0) + 1,
          );
        }
      } catch (err) {
        dropDispatchLease(taskPlan.taskId);
        const message = err instanceof Error ? err.message : "Execution launch failed";
        const kind = classifyLaunchFailure(message);
        taskPlan.phase = kind && kind !== "workspace_conflict" ? "awaiting_owner" : "failed";
        taskPlan.phaseReason = kind ? `${kind}: ${message}` : message;
        this.store.releaseTaskReservation(taskPlan.taskId);
        if (launchGate.kind === "allow") noteAutonomousLaunchFailed(launchGate.reservationId);
      }
    }

    // Step 5: Update Mission Runtime State
    const activeSpecialists = new Set<string>();
    let completedCount = 0;
    let runningCount = 0;
    let blockedCount = 0;
    let failedCount = 0;
    let awaitingQcCount = 0;
    let awaitingOwnerCount = 0;

    for (const t of mission.plan.tasks) {
      if (t.phase === "completed") completedCount++;
      if (t.phase === "running") {
        runningCount++;
        activeSpecialists.add(t.specialistRole);
      }
      if (t.phase === "qc_running") {
        runningCount++;
        activeSpecialists.add("reviewer");
      }
      if (t.phase === "awaiting_qc") awaitingQcCount++;
      if (t.phase === "awaiting_owner") {
        awaitingOwnerCount++;
        t.waitingOn = t.recovery ? "recovery" : "owner";
        recordMissionWait(missionId, t.taskId, "owner");
      } else if (t.phase === "failed" && t.recovery) {
        t.waitingOn = "recovery";
      } else if (!["planned", "authorized", "blocked", "awaiting_qc"].includes(t.phase) && !(objective && t.phase === "cancelled" && t.waitingOn === "dependency")) {
        t.waitingOn = undefined;
      }
      if (!t.pendingLaunch && !["awaiting_qc", "authorized"].includes(t.phase)) this.quotaRetries.delete(t.taskId);
      if (["completed", "cancelled", "failed"].includes(t.phase)) recordMissionWait(missionId, t.taskId, null);
      if (t.phase === "blocked") blockedCount++;
      if (t.phase === "failed") failedCount++;
    }

    const state: MissionRuntimeState = {
      totalTasks: mission.plan.tasks.length,
      completedTasks: completedCount,
      runningTasks: runningCount,
      blockedTasks: blockedCount,
      failedTasks: failedCount,
      awaitingQcTasks: awaitingQcCount,
      awaitingOwnerTasks: awaitingOwnerCount,
      activeSpecialists: [...activeSpecialists],
      resourceUsage: Object.fromEntries(occupiedByAccount.entries()),
    };

    mission.state = state;

    // Check completion condition
    if (this.store.getMission(missionId)?.status !== "running") return;
    if (objective) {
      db.transaction(() => {
        this.store.saveMissionPlanState(missionId, mission.plan, state);
        if (completedCount === mission.plan.tasks.length) {
          this.store.releaseReservations(missionId);
          this.store.updateMissionStatus(missionId, "completed", "completed_all_tasks");
        } else if (mission.plan.tasks.every(task => ["completed", "failed", "cancelled"].includes(task.phase))) {
          this.store.releaseReservations(missionId);
          this.store.updateMissionStatus(missionId, "failed", "failed");
        }
      }).immediate();
      return;
    }
    if (completedCount === mission.plan.tasks.length && mission.plan.tasks.length > 0) {
      mission.status = "completed";
      this.store.releaseReservations(missionId);
      this.store.updateMissionStatus(missionId, "completed", "completed_all_tasks");
    }

    this.store.saveMissionPlanState(missionId, mission.plan, state);
  }

  // Crash / restart recovery
  async recoverOrchestrationMissions(): Promise<void> {
    const runningMissions = this.store.listMissions({ status: "running" });

    if (runningMissions.some(mission => mission.plan.objective)) this.wakeObjectiveMissions();
    const interrupted = db.query<{ taskId: string; runId: string | null }, []>(
      `SELECT t.task_id AS taskId, e.run_id AS runId
         FROM objective_mission_tasks t LEFT JOIN employee_executions e ON e.id = t.operation_id
        WHERE t.operation_id IS NOT NULL`,
    ).all();
    for (const { taskId, runId } of interrupted) {
      if (this.objectiveStarts.has(taskId)) continue;
      if (runId && this.store.getReservation(taskId)?.status === "starting") {
        this.store.updateReservationStatus(taskId, "running", { runId });
      }
      db.run("UPDATE objective_mission_tasks SET operation_id = NULL WHERE task_id = ?", [taskId]);
    }

    for (const m of runningMissions) {
      const reservations = this.store.listActiveReservations(m.id);

      for (const res of reservations) {
        const live = isTaskRunLive(res.taskId);
        if (!live && !m.plan.objective) {
          // If task run is not live, check if it reached review/done or was abruptly halted
          const taskObj = tasks.get(res.taskId);
          if (taskObj?.column === "review" || taskObj?.column === "done") {
            // Task completed before restart; advance to review/done on tick
          } else if (res.status === "starting") {
            // A launch was reserved and the process ended before any run was recorded. Keep the reservation: the tick
            // classifies it as an interrupted launch (the task waits for the Owner). Releasing it here would leave the
            // task looking like fresh queued work, and the next tick would dispatch it a second time.
          } else {
            // A run existed. Release the slot; the tick reads the run's recorded outcome (an orphaned run is an uncertain
            // outcome that is not retried) instead of launching again.
            this.store.releaseTaskReservation(res.taskId);
          }
        }
      }

      await this.tickMission(m.id);
    }
  }
}

export const missionScheduler = new MissionScheduler();
