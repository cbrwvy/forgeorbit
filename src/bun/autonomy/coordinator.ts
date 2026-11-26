/**
 * Head of PM autonomy coordinator.
 * One Owner activation prepares a mission through the existing scheduler.
 * Later ticks only consume that activation.
 */
import { randomUUID } from "node:crypto";
import { AssignmentCore } from "../assignment-core.ts";
import { EmployeeCore } from "../employee-core.ts";
import { db, tasks } from "../db.ts";
import { createTask, isTaskRunLive, cancelRun } from "../orchestrator.ts";
import { missionScheduler } from "../orchestration/mission-scheduler.ts";
import { missionStore } from "../orchestration/mission-store.ts";
import { routerV2Service } from "../router-v2/router-v2-service.ts";
import { isBlockedProvider, missionSummaryFromFacts, type AutonomyPolicyBody } from "../../shared/autonomy-policy.ts";
import { explainBinding } from "../multiaccount/binding.ts";
import { autonomyEnvelopeOverride } from "../orchestration/mission-resource.ts";
import { DEFAULT_PRESET_WEIGHTS } from "../../shared/router-v2/types.ts";
import type { DependencyCondition, MissionTaskPriority } from "../../shared/orchestration/types.ts";
import { autonomyPolicyStore } from "./policy-store.ts";
import {
  AutonomyPolicyError,
  authorizeAutonomyAction,
  autonomyNow,
  expireDuePolicies,
} from "./policy-engine.ts";

export interface MissionProposal {
  title: string;
  prompt?: string;
  projectPath: string;
  clusterId?: string;
  specialistRole?: string;
  priority?: MissionTaskPriority;
  taskId?: string;
  dependsOnTitles?: Array<{ title: string; condition?: DependencyCondition }>;
}

export interface PrepareAutonomousMissionInput {
  policyId: string;
  title: string;
  goal: string;
  proposals: MissionProposal[];
}

const MAX_PLAN_NOTES = 3;

function policyOrThrow(policyId: string) {
  const policy = autonomyPolicyStore.latestPolicy(policyId);
  if (!policy) throw new AutonomyPolicyError("Policy not found.", 404);
  const activation = autonomyPolicyStore.activationForPolicy(policy.id, policy.revision);
  if (!activation || activation.status !== "active") throw new AutonomyPolicyError("Full and autonomous execution require an active Owner policy.", 409);
  if (activation.digest !== policy.digest) throw new AutonomyPolicyError("Activation does not match the policy revision.", 409);
  if (autonomyNow() >= activation.expiresAt) throw new AutonomyPolicyError("The Owner policy is expired.", 409);
  if (autonomyPolicyStore.readEmergency().active) throw new AutonomyPolicyError("Emergency stop is active.", 409);
  return { policy, activation, body: policy.body };
}

function assertInside(body: AutonomyPolicyBody, projectPath: string): void {
  if (!body.projects.includes(projectPath)) {
    throw new AutonomyPolicyError(`Project ${projectPath} is outside the Owner policy. A broader plan cannot add it.`, 409);
  }
}

async function selectResource(body: AutonomyPolicyBody, projectPath: string, taskId: string, role: string) {
  const preset = body.routerPreset;
  const envelope = autonomyEnvelopeOverride(body);
  const evaluation = routerV2Service.evaluateTaskSync(
    { taskId, projectId: projectPath, role: role === "reviewer" ? "reviewer" : "developer", title: taskId },
    {
      policyOverride: {
        ...envelope,
        preset,
        weights: DEFAULT_PRESET_WEIGHTS[preset],
        constraints: { ...envelope.constraints },
      },
    },
  );
  const eligible = evaluation.eligible.filter((candidate) => {
    if (isBlockedProvider(candidate.harnessId, candidate.modelId) || isBlockedProvider(candidate.kind, candidate.modelId)) return false;
    const providerOk = body.providers.includes(candidate.harnessId.toLowerCase()) || body.providers.includes(candidate.kind.toLowerCase());
    const modelOk = body.models.includes(candidate.modelId);
    const accountOk = candidate.accountId ? body.accounts.includes(candidate.accountId) : body.allowUnscopedAccount;
    return providerOk && modelOk && accountOk;
  });
  const selected = eligible[0];
  if (!selected) {
    throw new AutonomyPolicyError(
      `Router 2.0 has no eligible ${role} resource inside the Owner policy for ${projectPath}. No model outside the policy was substituted.`,
      409,
    );
  }
  const decision = authorizeAutonomyAction({
    targetKey: `select_model:${taskId}:${role}`,
    target: {
      action: "select_model",
      projectPath,
      taskId,
      role,
      provider: selected.kind || selected.harnessId,
      model: selected.modelId,
      accountId: selected.accountId,
    },
    routerRecommended: true,
  });
  if (!decision.decision.allow) throw new AutonomyPolicyError(decision.decision.reason, 409);
  const binding = explainBinding({
    harnessId: selected.harnessId,
    accountId: selected.accountId,
    modelId: selected.modelId,
    mode: selected.mode,
    provider: selected.kind,
  });
  if (!binding.ok) throw new AutonomyPolicyError(`${binding.reason} No unapproved profile was substituted.`, 409);
  return selected;
}

export async function prepareAutonomousMission(input: PrepareAutonomousMissionInput) {
  const { policy, activation, body } = policyOrThrow(input.policyId);
  if (body.mode === "supervised") {
    throw new AutonomyPolicyError("Supervised mode keeps per-step Owner approval. It does not auto-dispatch a mission.", 409);
  }
  if (!input.proposals.length) throw new AutonomyPolicyError("A mission needs at least one proposed task.", 400);
  for (const proposal of input.proposals) assertInside(body, proposal.projectPath);
  const planCheck = authorizeAutonomyAction({
    target: {
      action: "plan_task",
      projectPath: input.proposals[0]!.projectPath,
      role: "head",
      provider: body.providers[0],
      model: body.models[0],
    },
  });
  if (!planCheck.decision.allow) throw new AutonomyPolicyError(planCheck.decision.reason, 409);

  let brainCitations: string[] = [];
  const brain = authorizeAutonomyAction({
    target: {
      action: "retrieve_brain",
      projectPath: input.proposals[0]!.projectPath,
      role: "head",
      provider: body.providers[0],
      model: body.models[0],
    },
  });
  if (brain.decision.allow) {
    try {
      const { queryHeadBrainMemories } = await import("../head-brain-retrieval.ts");
      const { brainProposalStore } = await import("../brain-proposals.ts");
      const retrieved = await queryHeadBrainMemories(
        { scope: { kind: "workspace" }, label: "workspace", projectPath: null, projectAddedAt: null, clusterId: null },
        input.goal,
        brainProposalStore(),
        { maxMemories: 4 },
      );
      brainCitations = retrieved.hits
        .filter((hit) => hit.memory.scope.kind === "project" && body.projects.includes(hit.memory.scope.id))
        .map((hit) => hit.memory.id);
    } catch {
      brainCitations = [];
    }
  }

  const assignments = new AssignmentCore(db);
  const created: Array<MissionProposal & { taskId: string; harnessId: string; modelId: string; accountId?: string }> = [];
  for (const proposal of input.proposals) {
    const role = (proposal.specialistRole ?? "developer").toLowerCase();
    if (!body.specialistRoles.includes(role)) {
      throw new AutonomyPolicyError(`Role ${role} is not allowed by the Owner policy.`, 409);
    }
    const selected = await selectResource(body, proposal.projectPath, proposal.taskId ?? randomUUID(), role);
    let taskId = proposal.taskId;
    if (!taskId) {
      const create = authorizeAutonomyAction({
        targetKey: `create_task:${proposal.projectPath}:${proposal.title}`,
        target: {
          action: "create_task",
          projectPath: proposal.projectPath,
          clusterId: proposal.clusterId,
          role,
          provider: selected.kind || selected.harnessId,
          model: selected.modelId,
          accountId: selected.accountId,
        },
      });
      if (!create.decision.allow) throw new AutonomyPolicyError(create.decision.reason, 409);
      const made = await createTask({
        title: proposal.title,
        prompt: proposal.prompt ?? proposal.title,
        workdir: proposal.projectPath,
        isolation: "none",
        column: "ready",
        agent: selected.harnessId,
        model: selected.modelId,
        mode: "auto",
      });
      if ("error" in made) throw new AutonomyPolicyError(made.error, 409);
      taskId = made.task.id;
    } else {
      const existing = tasks.get(taskId);
      if (!existing) throw new AutonomyPolicyError(`Task ${taskId} was not found.`, 404);
      if (existing.workdir !== proposal.projectPath && existing.ownerProjectPath !== proposal.projectPath) {
        throw new AutonomyPolicyError(`Task ${taskId} is not in an authorized project.`, 409);
      }
    }
    let worker = db.query<{ id: string }, [string]>(
      `SELECT id FROM ai_employees WHERE kind = 'worker' AND status = 'active' AND project_path = ? LIMIT 1`,
    ).get(proposal.projectPath);
    if (!worker) {
      const createdWorker = new EmployeeCore(db).createWorker({
        name: `Specialist ${proposal.projectPath.split("/").pop()}`,
        jobTitle: role === "reviewer" ? "Reviewer" : "Developer",
        projectPath: proposal.projectPath,
      });
      worker = { id: createdWorker.id };
    }
    if (worker) {
      const assign = authorizeAutonomyAction({
        targetKey: `assign_specialist:${taskId}`,
        target: {
          action: "assign_specialist",
          projectPath: proposal.projectPath,
          taskId,
          role,
          provider: selected.kind || selected.harnessId,
          model: selected.modelId,
          accountId: selected.accountId,
        },
      });
      if (!assign.decision.allow) throw new AutonomyPolicyError(assign.decision.reason, 409);
      try {
        assignments.assign(taskId, worker.id);
      } catch (error) {
        const message = error instanceof Error ? error.message : "Assignment failed.";
        if (!message.includes("already has a worker")) throw new AutonomyPolicyError(message, 409);
      }
    }
    created.push({
      ...proposal,
      taskId,
      specialistRole: role,
      harnessId: selected.harnessId,
      modelId: selected.modelId,
      accountId: selected.accountId ?? undefined,
    });
  }

  const titleToId = new Map(created.map((task) => [task.title, task.taskId]));
  const mission = await missionScheduler.prepareMission({
    title: input.title,
    goal: input.goal,
    clusterIds: [],
    projectPaths: [...new Set(created.map((task) => task.projectPath))],
    concurrencyLimits: {
      globalMax: Math.min(body.maxConcurrentWorkers, 8),
      perProjectMax: Math.min(body.maxConcurrentWorkers, 2),
      perAccountMax: Math.min(body.maxConcurrentWorkers, 3),
    },
    spendingLimitUsd: body.spending.limitUsd ?? undefined,
    policyOverride: {
      qcRequired: body.qc.required,
      autoResumeOnQcPass: false,
      maxRetriesPerTask: body.maxReworkAttempts,
    },
    tasks: created.map((task) => ({
      taskId: task.taskId,
      taskTitle: task.title,
      projectPath: task.projectPath,
      clusterId: task.clusterId,
      specialistRole: task.specialistRole,
      priority: task.priority ?? "normal",
      harnessId: task.harnessId,
      modelId: task.modelId,
      accountId: task.accountId,
      mode: "auto",
      qcRequired: body.qc.required,
      dependencies: (task.dependsOnTitles ?? []).map((dep) => {
        const dependencyId = titleToId.get(dep.title);
        if (!dependencyId) throw new AutonomyPolicyError(`Dependency “${dep.title}” is not in this mission.`, 400);
        const dependency = created.find((item) => item.taskId === dependencyId)!;
        return {
          taskId: dependencyId,
          projectPath: dependency.projectPath,
          condition: dep.condition ?? "qc_pass",
        };
      }),
    })),
  });
  for (const projectPath of mission.projects) assertInside(body, projectPath);
  const authorized = await missionScheduler.authorizeMission(mission.id, mission.planDigest);
  autonomyPolicyStore.upsertBinding({
    missionId: authorized.id,
    policyId: policy.id,
    revision: policy.revision,
    activationId: activation.id,
    digest: policy.digest,
    mode: body.mode,
    outcome: "active",
    summary: null,
    emergencyTaskIds: [],
  });
  const started = await missionScheduler.startMission(authorized.id);
  autonomyPolicyStore.journal("mission_prepared", {
    missionId: started.id,
    policyId: policy.id,
    revision: policy.revision,
    brainCitations,
    planNotes: Math.min(MAX_PLAN_NOTES, brainCitations.length + 1),
  });
  return { mission: missionStore.getMission(started.id) ?? started, brainCitations, policyId: policy.id, revision: policy.revision };
}

export async function finalizeAutonomyTick(): Promise<void> {
  expireDuePolicies();
  const emergency = autonomyPolicyStore.readEmergency().active;
  for (const binding of autonomyPolicyStore.listBindings()) {
    const mission = missionStore.getMission(binding.missionId);
    if (!mission) continue;
    const activation = autonomyPolicyStore.getActivation(binding.activationId);
    if (activation && (activation.status === "expired" || autonomyNow() >= activation.expiresAt) && mission.status === "running") {
      missionScheduler.pauseMission(mission.id, "Policy expired").catch(() => undefined);
      autonomyPolicyStore.upsertBinding({ ...binding, outcome: "expired" });
      continue;
    }
    if (activation && activation.status === "revoked" && mission.status === "running") {
      await missionScheduler.cancelMission(mission.id, "Policy revoked");
      autonomyPolicyStore.upsertBinding({ ...binding, outcome: "cancelled" });
      continue;
    }
    if (emergency && mission.status === "running") {
      await missionScheduler.pauseMission(mission.id, "Emergency stop");
    }
    if (mission.status === "completed" || mission.status === "failed" || mission.status === "cancelled") {
      const summary = buildSummary(mission.id, binding.policyId, binding.revision);
      autonomyPolicyStore.upsertBinding({
        ...binding,
        outcome: mission.status === "completed" ? "completed" : mission.status === "cancelled" ? "cancelled" : "blocked",
        summary,
      });
    }
  }
}

function buildSummary(missionId: string, policyId: string, revision: number): string {
  const mission = missionStore.getMission(missionId);
  if (!mission) return "Mission record is missing.";
  return missionSummaryFromFacts({
    title: mission.title,
    goal: mission.goal,
    policyId,
    revision,
    tasks: mission.plan.tasks.map((task) => {
      const row = tasks.get(task.taskId);
      return {
        title: task.taskTitle,
        phase: task.phase,
        column: row?.column ?? null,
        verdict: row?.qcState?.latestVerdict ?? null,
        projectPath: task.projectPath,
      };
    }),
    excludedUntouched: [],
  });
}

export async function emergencyStopAutonomy(reason: string): Promise<{ outstanding: string[] }> {
  autonomyPolicyStore.writeEmergency(true, reason, []);
  autonomyPolicyStore.cancelUnclaimed();
  try {
    const { cancelPendingPermissionRequests } = await import("../project-permissions.ts");
    cancelPendingPermissionRequests("Emergency stop withdrew this request.");
  } catch { /* nothing pending can start while the stop flag is set */ }
  const outstanding: string[] = [];
  for (const mission of missionStore.listMissions({ status: "running" })) {
    if (!mission.plan.objective) continue;
    await missionScheduler.pauseMission(mission.id, reason);
    for (const reservation of missionStore.listActiveReservations(mission.id)) {
      if (!reservation.runId || !isTaskRunLive(reservation.taskId)) continue;
      await cancelRun(reservation.runId);
      if (isTaskRunLive(reservation.taskId)) outstanding.push(reservation.runId);
    }
  }
  const held = new Map<string, string[]>();
  for (const binding of autonomyPolicyStore.listBindings()) {
    const mission = missionStore.getMission(binding.missionId);
    if (!mission) continue;
    const stopped: string[] = [...binding.emergencyTaskIds];
    for (const task of mission.plan.tasks) {
      if (task.phase === "running" || task.phase === "starting" || task.phase === "qc_running") {
        stopped.push(task.taskId);
        if (task.runId && !mission.plan.objective) {
          await cancelRun(task.runId);
          if (isTaskRunLive(task.taskId)) outstanding.push(task.runId);
        }
      }
    }
    held.set(binding.missionId, [...new Set(stopped)]);
    if (mission.status === "running") {
      try { await missionScheduler.pauseMission(mission.id, reason); } catch { /* already paused */ }
    }
    autonomyPolicyStore.upsertBinding({ ...binding, outcome: "paused", emergencyTaskIds: held.get(binding.missionId) ?? [] });
  }
  try {
    // Hands-off runs: marked stopped first, then their live processes are asked to stop. Nothing resumes on its own.
    const { stopHandsoffForEmergency } = await import("../handsoff/driver.ts");
    outstanding.push(...(await stopHandsoffForEmergency(reason)).outstanding);
  } catch { /* the flag above already refuses every new launch */ }
  try {
    const { haltRecurringSubmissionsForEmergency } = await import("../recurring/scheduler.ts");
    haltRecurringSubmissionsForEmergency(reason);
  } catch { /* the flag above already refuses every new automatic submission */ }
  autonomyPolicyStore.writeEmergency(true, reason, outstanding);
  autonomyPolicyStore.journal("emergency_stop", { reason, outstanding });
  try {
    const { ActivityJournalCore } = await import("../activity-journal-core.ts");
    const { db: database } = await import("../db.ts");
    new ActivityJournalCore(database).record({
      eventType: "autonomy.emergency.stopped",
      actorType: "owner",
      actorId: "owner",
      targetType: "company",
      targetId: "autonomy",
      idempotencyKey: `autonomy-emergency:${Date.now()}:${randomUUID()}`,
      payload: { policyId: "global", reasonCode: "emergency-stop", outstanding: outstanding.length },
    });
  } catch {
    // The recovery journal above is the durable record if the activity schema rejects a row.
  }
  return { outstanding };
}

/**
 * What an active Emergency Stop did NOT stop: board tasks (including hidden pipeline steps) that are live right now and
 * whose run was not one the stop itself cancelled and is still waiting on. Autonomous work was cancelled; a task the
 * Owner started by hand is left running by design. A read, never a signal.
 */
export function runningTasksNotStopped(): number {
  const waitingOn = new Set(autonomyPolicyStore.readEmergency().outstanding);
  let count = 0;
  for (const task of tasks.list()) {
    if (!isTaskRunLive(task.id)) continue;
    if (task.runId && waitingOn.has(task.runId)) continue;
    count += 1;
  }
  return count;
}

export function clearEmergencyStop(): void {
  autonomyPolicyStore.writeEmergency(false, null, []);
  autonomyPolicyStore.journal("emergency_cleared", {});
}

export async function recoverAutonomy(): Promise<void> {
  const { recoverInterruptedPracticalTests } = await import("./observed-test.ts");
  recoverInterruptedPracticalTests();
  try {
    const { recoverProjectPermissionRequests } = await import("../project-permissions.ts");
    recoverProjectPermissionRequests();
  } catch { /* the request table is the durable record; the next read still shows it */ }
  expireDuePolicies();
  autonomyPolicyStore.journal("restart", {
    emergency: autonomyPolicyStore.readEmergency().active,
    bindings: autonomyPolicyStore.listBindings().map((binding) => binding.missionId),
  });
  if (autonomyPolicyStore.readEmergency().active) return;
  await finalizeAutonomyTick();
}

let timer: ReturnType<typeof setTimeout> | null = null;
let loops = 0;

export function scheduleAutonomyTick(delayMs = 400): void {
  if (timer) return;
  timer = setTimeout(() => {
    timer = null;
    void tickAutonomy().catch((error) => {
      console.warn("[autonomy] tick failed:", error instanceof Error ? error.message : error);
    });
  }, delayMs);
}

export async function tickAutonomy(): Promise<void> {
  loops += 1;
  if (loops > 500) return;
  await missionScheduler.tickAllRunningMissions();
  await finalizeAutonomyTick();
  const running = autonomyPolicyStore.listBindings().some((binding) => {
    const mission = missionStore.getMission(binding.missionId);
    return mission?.status === "running" && binding.outcome === "active";
  });
  if (running && !autonomyPolicyStore.readEmergency().active) scheduleAutonomyTick(500);
}

export function resetAutonomyLoopForTest(): void {
  loops = 0;
  if (timer) clearTimeout(timer);
  timer = null;
}
