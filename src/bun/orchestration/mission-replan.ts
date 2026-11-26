import { createHash, randomUUID } from "node:crypto";
import { db, harnesses, runs, taskQualityReviews, tasks } from "../db.ts";
import { EmployeeRunCore } from "../employee-run-core.ts";
import { explainBinding, reservationBlocksRelaunch } from "../multiaccount/binding.ts";
import { isTaskRunLive } from "../orchestrator.ts";
import { taskInProject } from "../project-ownership.ts";
import { checkProjectLaunchAdmission } from "../project-lifecycle.ts";
import { existingWork } from "../usage-analytics/occupancy.ts";
import { routerV2Service } from "../router-v2/router-v2-service.ts";
import { taskActuals } from "../usage-analytics/actuals.ts";
import { poolKey, quotaDemand } from "../usage-analytics/capacity.ts";
import { forecast, optionKey } from "../usage-analytics/forecast.ts";
import { launchFingerprint } from "../../shared/task-scheduling.ts";
import { computeMissionPlanDigest } from "../../shared/orchestration/plan-digest.ts";
import { ALLOCATION_OBJECTIVES, searchAllocation, type AllocationObjective, type AllocationStage } from "../../shared/orchestration/allocation-search.ts";
import type { MissionConcurrencyLimits, MissionRecord, MissionStageResource, MissionTaskPlan } from "../../shared/orchestration/types.ts";
import { activeMissionPolicy, missionResourceBlock, settledMissionImplementation } from "./mission-resource.ts";
import { missionScheduler, OrchestrationError } from "./mission-scheduler.ts";
import { missionStore } from "./mission-store.ts";

type Role = "developer" | "reviewer";
type ExactSelection = Pick<MissionStageResource, "harnessId" | "modelId" | "accountId" | "mode">;
export type ReplanChange = { taskId: string; role: Role; resource: ExactSelection };
export type ReplanAllocation = { objective: string; optimal: boolean; explored: number; limit: number; feasible: boolean };
export type ReplanInput = {
  taskId?: string;
  role?: Role;
  resource?: ExactSelection;
  changes?: ReplanChange[];
  reason: string;
  limits?: Partial<MissionConcurrencyLimits>;
  allocation?: ReplanAllocation;
};
type ProposalRow = {
  id: string; mission_id: string; revision: number; digest: string; snapshot: string;
  status: "pending" | "approved" | "rejected"; created_at: number; settled_at: number | null; head_message_id: string | null;
};
const conflict = (message: string): never => { throw new OrchestrationError(message, 409); };
const sha = (value: string) => createHash("sha256").update(value).digest("hex");
const validId = (value: unknown): value is string => typeof value === "string" && value.length > 0 && value.length <= 256;
const capacityKeys = ["globalMax", "perProjectMax", "perAccountMax", "perClusterMax"] as const;

function checkMission(id: string) {
  const mission = missionStore.getMission(id);
  if (!mission) throw new OrchestrationError("Mission not found.", 404);
  if (mission.plan.objective) conflict("This mission uses the exact account and assignee reviewed in its objective plan.");
  const policy = activeMissionPolicy(mission);
  if (!policy) conflict("An active mission policy is required. Prepare a new Owner-authorized mission for unstarted tasks or use the existing QC-only recovery for a completed implementation.");
  if (!["authorized", "paused"].includes(mission.status) || missionScheduler.isTickingMission(id)) {
    conflict("Pause the mission and let the current dispatch settle before preparing a resource change.");
  }
  if (mission.authorization?.authorizedBy !== "owner" || mission.authorization.digest !== mission.planDigest || computeMissionPlanDigest(mission.plan) !== mission.planDigest) {
    conflict("The mission no longer matches its approved revision.");
  }
  return { mission, policy: policy! };
}

function checkTask(mission: MissionRecord, taskId: string, role: Role, reviewerCovered = false) {
  const plan = mission.plan.tasks.find(item => item.taskId === taskId);
  const task = tasks.get(taskId);
  if (!plan || !task || !taskInProject(task, plan.projectPath, { fresh: true }) || task.archivedAt != null ||
    task.pipelineId || task.pipelineParentId || ["completed", "cancelled"].includes(plan.phase) || task.column === "done") {
    throw new OrchestrationError("Select remaining work in this mission.", 409);
  }
  if (isTaskRunLive(taskId) || runs.listForTask(taskId).some(run => run.status === "running") ||
    reservationBlocksRelaunch(missionStore.getReservation(taskId)?.status) ||
    new EmployeeRunCore(db).hasUnconfirmed(taskId) ||
    taskQualityReviews.listForTask(taskId).some(review => review.status === "running" || review.status === "pending")) {
    conflict("Execution or QC is still in flight or its outcome is unresolved. Reconcile it before changing resources.");
  }
  if (db.query("SELECT 1 FROM pm_orchestrated_workflows WHERE task_id = ? AND status = 'active'").get(taskId)) {
    conflict("An independent workflow still owns this task.");
  }
  const priorRuns = runs.listForTask(taskId);
  const implementation = settledMissionImplementation(plan);
  if (role === "developer") {
    if (plan.qcRequired && !plan.reviewerBinding && !reviewerCovered) {
      conflict("Freeze the Reviewer resource first to preserve an independent Reviewer binding when the Developer changes.");
    }
    const binding = activeMissionPolicy(mission)!.binding;
    const epoch = plan.reworkEpoch ?? 0;
    const launch = autonomyPolicyReservation(binding.activationId, taskId, epoch);
    if (!["planned", "authorized", "blocked", "failed", "awaiting_owner"].includes(plan.phase) ||
      (task.column !== "ready" || plan.specialistRole !== "developer") ||
      (priorRuns.length && !epoch) || launch) {
      conflict("The current Developer epoch has already launched or is ineligible. Continue with its evidence, or prepare a separately authorized task.");
    }
  } else if (!plan.qcRequired || !(priorRuns.length === 0 && ["planned", "authorized", "blocked"].includes(plan.phase) ||
    ["running", "awaiting_qc", "qc_running", "blocked", "failed"].includes(plan.phase) && plan.blockedStage !== "developer" &&
    ["review", "blocked"].includes(task.column) && implementation &&
    !taskQualityReviews.listForTask(taskId).some(review => review.implementationRunId === implementation.id && review.verdict === "PASS"))) {
    conflict("Choose an unstarted review stage or a settled successful Developer run in Review without a passing QC verdict. Independent recovery is available through QC-only recovery.");
  }
  return { task, plan, implementation };
}

function autonomyPolicyReservation(activationId: string, taskId: string, epoch: number) {
  return db.query("SELECT 1 FROM autonomy_action_reservations WHERE activation_id = ? AND (target_key = ? OR target_key GLOB ?) AND status <> 'cancelled' ")
    .get(activationId, `launch_task:${taskId}:${epoch}`, `launch_task:${taskId}:${epoch}:r[0-9]*`);
}

export function missionResourceOptions(id: string, taskId: string, role: Role, reviewerCovered = false) {
  const { mission } = checkMission(id);
  const { plan, task } = checkTask(mission, taskId, role, reviewerCovered);
  const candidates = routerV2Service.gatherCandidatesSync(role);
  const evaluated = routerV2Service.evaluateTaskSync({ taskId, projectId: plan.projectPath, title: task.title, role }, { candidates });
  return evaluated.eligible.flatMap(candidate => {
    const { harnessId, modelId, accountId, mode } = candidate;
    const input = candidates.find(row => row.id === candidate.candidateId);
    if (!accountId || !input || input.cliInstalled !== true || input.cliLoggedIn === false) return [];
    const exact = explainBinding({ harnessId, modelId, accountId, mode, provider: candidate.kind });
    if (!exact.ok || !exact.frozen) return [];
    const resource = { harnessId, modelId, accountId, mode, fingerprint: exact.frozen.fingerprint, revision: mission.revision + 1 };
    if (missionResourceBlock(mission, plan, role, resource)) return [];
    return [{ ...candidate, resource, authenticated: input.cliLoggedIn === true, simulated: input.simulated === true }];
  });
}

function selectionOf(value: ExactSelection): ExactSelection {
  return { harnessId: value.harnessId, modelId: value.modelId, accountId: value.accountId, mode: value.mode };
}

function normalizeChanges(input: ReplanInput): ReplanChange[] {
  const listed = input.changes;
  if (listed) {
    if (!Array.isArray(listed) || listed.length < 1 || listed.length > 12) {
      throw new OrchestrationError("An atomic proposal needs 1–12 exact stage changes.", 400);
    }
    return listed.map(change => ({ taskId: change.taskId, role: change.role, resource: selectionOf(change.resource) }));
  }
  if (!input.taskId || !input.role || !input.resource) throw new OrchestrationError("Choose an exact task, stage, resource and reason.", 400);
  return [{ taskId: input.taskId, role: input.role, resource: selectionOf(input.resource) }];
}

function currentBinding(plan: MissionTaskPlan, role: Role) {
  return role === "developer" ? plan.developerBinding ?? {
    harnessId: plan.harnessId, modelId: plan.modelId, mode: plan.mode, accountId: plan.accountId ?? null,
  } : plan.reviewerBinding ?? { harnessId: plan.harnessId, modelId: plan.modelId, mode: null, accountId: null };
}

function snapshot(id: string, input: ReplanInput) {
  const { mission, policy } = checkMission(id);
  const reason = typeof input.reason === "string" ? input.reason.trim() : "";
  if (!reason || reason.length > 500) throw new OrchestrationError("Choose an exact task, stage, resource and reason.", 400);
  const changes = normalizeChanges(input);
  const seen = new Set<string>();
  for (const change of changes) {
    if ((change.role !== "developer" && change.role !== "reviewer") || !validId(change.taskId) ||
      !change.resource || ![change.resource.harnessId, change.resource.modelId, change.resource.accountId, change.resource.mode].every(validId)) {
      throw new OrchestrationError("Choose an exact task, stage, resource and reason.", 400);
    }
    const key = `${change.taskId}\0${change.role}`;
    if (seen.has(key)) conflict("A proposal cannot list the same task stage twice.");
    seen.add(key);
  }
  const reviewerCovered = new Set(changes.filter(change => change.role === "reviewer").map(change => change.taskId));
  const evaluated = changes.map(change => {
    const covered = change.role === "developer" && reviewerCovered.has(change.taskId);
    const { task, plan, implementation } = checkTask(mission, change.taskId, change.role, covered);
    const candidate = missionResourceOptions(id, change.taskId, change.role, covered).find(item =>
      item.harnessId === change.resource.harnessId && item.modelId === change.resource.modelId &&
      item.accountId === change.resource.accountId && item.mode === change.resource.mode);
    if (!candidate) throw new OrchestrationError("Router cannot admit that exact resource under the mission policy.", 409);
    const current = currentBinding(plan, change.role);
    return { change, task, plan, implementation, candidate, current };
  });
  const nextLimits = { ...mission.concurrencyLimits };
  for (const key of capacityKeys) {
    const value = input.limits?.[key];
    if (value === undefined) continue;
    if (!Number.isSafeInteger(value) || value < 1 || value > policy.policy.body.maxConcurrentWorkers) {
      conflict("Capacity must be a positive integer within the original policy limit.");
    }
    nextLimits[key] = value;
  }
  const limitsChanged = capacityKeys.some(key => nextLimits[key] !== mission.concurrencyLimits[key]);
  if (limitsChanged && missionStore.listActiveReservations(id).length) conflict("Settle all mission reservations before changing shared mission capacity.");
  const bindingChanged = evaluated.some(item => item.current.harnessId !== item.change.resource.harnessId ||
    item.current.modelId !== item.change.resource.modelId || item.current.accountId !== item.change.resource.accountId ||
    item.current.mode !== item.change.resource.mode);
  if (!bindingChanged && !limitsChanged) conflict("Choose a change to resources or capacity.");
  const replacement = structuredClone(mission.plan);
  for (const item of [...evaluated.filter(item => item.change.role === "reviewer"), ...evaluated.filter(item => item.change.role === "developer")]) {
    const changed = replacement.tasks.find(row => row.taskId === item.task.id);
    if (!changed) throw new OrchestrationError("Select remaining work in this mission.", 409);
    changed.accountLimit = undefined;
    if (changed.waitingOn === "quota") changed.waitingOn = undefined;
    if (item.change.role === "developer") {
      changed.developerBinding = item.candidate.resource;
      changed.harnessId = item.candidate.harnessId;
      changed.modelId = item.candidate.modelId;
      changed.accountId = item.candidate.resource.accountId;
      changed.mode = item.candidate.mode;
      changed.phase = "authorized";
      changed.recovery = undefined;
    } else {
      changed.reviewerBinding = item.candidate.resource;
      if (item.implementation) changed.phase = "running";
      changed.qcReviewId = undefined;
    }
    changed.phaseReason = undefined;
    changed.blockedStage = undefined;
  }
  replacement.concurrencyLimits = nextLimits;
  const first = evaluated[0]!;
  const storedLimits = input.limits && Object.fromEntries(capacityKeys.filter(key => input.limits![key] !== undefined).map(key => [key, input.limits![key]]));
  return {
    mission, replacement, nextLimits, evaluated, first,
    task: first.task, implementation: first.implementation, current: first.current, candidate: first.candidate,
    taskFingerprint: launchFingerprint(first.task),
    sourceReviews: taskQualityReviews.listForTask(first.task.id).map(review => [review.id, review.status, review.verdict, review.reviewRunId]),
    policy: { activationId: policy.activation.id, digest: policy.policy.digest, expiresAt: policy.activation.expiresAt },
    storedInput: {
      taskId: first.task.id, role: first.change.role, reason, resource: first.change.resource,
      ...(changes.length > 1 ? { changes } : {}),
      ...(storedLimits ? { limits: storedLimits } : {}),
      ...(input.allocation ? { allocation: input.allocation } : {}),
    } satisfies ReplanInput,
  };
}

function impact(plan: ReturnType<typeof forecast>, taskId: string) {
  return {
    elapsed: plan.elapsed, cost: plan.cost, quota: plan.capacity, blockers: plan.blockers, worker: plan.worker,
    taskRemaining: plan.estimates.find(estimate => estimate.taskId === taskId)?.remaining ?? null,
  };
}

type StageAmendment = {
  missionId: string;
  taskId: string;
  stage: Role;
  previous: ReturnType<typeof currentBinding>;
  proposed: MissionStageResource & { provider: string; accountLabel: string | null; sandbox: string; authenticated: boolean; simulated: boolean };
  previousMode: string | null;
  proposedMode: string;
  taskFingerprint: string;
  implementationRunId: string | null;
  sourceReviews: Array<Array<string | null>>;
  expected: { durationBefore: number | null; durationAfter: number | null; costBefore: ReturnType<typeof impact>["cost"]; costAfter: ReturnType<typeof impact>["cost"] };
  quota: { before: ReturnType<typeof impact>["quota"]; after: ReturnType<typeof impact>["quota"] };
  authorizationScope: { activationId: string; policyDigest: string; expiresAt: number; widensPolicy: false };
  eligibility: "eligible";
  compatibility: "same-provider" | "cross-provider";
  capacity: { previous: MissionConcurrencyLimits; proposed: MissionConcurrencyLimits };
};

type ProposalSnapshot = {
  input: ReplanInput;
  oldPlanDigest: string;
  newPlanDigest: string;
  taskFingerprint: string;
  policy: ReturnType<typeof snapshot>["policy"];
  sourceReviews: ReturnType<typeof snapshot>["sourceReviews"];
  implementationRunId: string | null;
  original: ReturnType<typeof snapshot>["current"];
  replacement: StageAmendment["proposed"];
  oldLimits: MissionConcurrencyLimits;
  newLimits: MissionConcurrencyLimits;
  before: ReturnType<typeof impact>;
  after: ReturnType<typeof impact>;
  amendments: StageAmendment[];
  seal: Array<{ taskId: string; stage: Role; fingerprint: string; reviews: StageAmendment["sourceReviews"]; runId: string | null }>;
  allocation: ReplanAllocation | null;
};

const read = (row: ProposalRow) => ({ id: row.id, missionId: row.mission_id, revision: row.revision, digest: row.digest,
  status: row.status, createdAt: row.created_at, settledAt: row.settled_at, headMessageId: row.head_message_id, ...JSON.parse(row.snapshot) as ProposalSnapshot });

export function getMissionResourceProposal(id: string, proposalId: string) {
  const row = db.query<ProposalRow, [string, string]>(
    "SELECT * FROM mission_resource_proposals WHERE id = ? AND mission_id = ?",
  ).get(proposalId, id);
  return row ? read(row) : null;
}

export function missionResourceProposals(id: string) {
  const proposals = db.query<ProposalRow, [string]>(
    "SELECT * FROM mission_resource_proposals WHERE mission_id = ? ORDER BY created_at DESC LIMIT 50",
  ).all(id).map(read);
  const revisions = db.query<{ snapshot: string }, [string]>(
    "SELECT snapshot FROM mission_plan_revisions WHERE mission_id = ? ORDER BY revision DESC",
  ).all(id).map(row => JSON.parse(row.snapshot) as Pick<MissionRecord, "revision" | "planDigest" | "plan" | "authorization">);
  return { proposals, revisions };
}

function describeCandidate(item: ReturnType<typeof snapshot>["evaluated"][number]): StageAmendment["proposed"] {
  return { ...item.candidate.resource, provider: item.candidate.kind, accountLabel: item.candidate.accountLabel,
    sandbox: item.change.role === "reviewer" ? "read-only" : "project-bound",
    authenticated: item.candidate.authenticated, simulated: item.candidate.simulated };
}

export function prepareMissionResourceProposal(id: string, input: ReplanInput, headMessageId: string | null = null) {
  return db.transaction(() => {
    const s = snapshot(id, input);
    const proposalId = randomUUID();
    const now = Date.now();
    const selection = { missionId: id };
    const beforePlan = forecast(selection, now);
    const afterPlan = forecast(selection, now, s.replacement);
    const before = impact(beforePlan, s.task.id);
    const after = impact(afterPlan, s.task.id);
    const amendments: StageAmendment[] = s.evaluated.map(item => {
      const proposed = describeCandidate(item);
      const previousKind = harnesses.get(item.current.harnessId ?? "")?.kind ?? null;
      const reviews = taskQualityReviews.listForTask(item.task.id).map(review => [review.id, review.status, review.verdict, review.reviewRunId]);
      return {
        missionId: id, taskId: item.task.id, stage: item.change.role, previous: item.current, proposed,
        previousMode: item.current.mode ?? null, proposedMode: item.change.resource.mode,
        taskFingerprint: launchFingerprint(item.task), implementationRunId: item.implementation?.id ?? null, sourceReviews: reviews,
        expected: {
          durationBefore: beforePlan.estimates.find(estimate => estimate.taskId === item.task.id)?.remaining?.expected ?? null,
          durationAfter: afterPlan.estimates.find(estimate => estimate.taskId === item.task.id)?.remaining?.expected ?? null,
          costBefore: before.cost, costAfter: after.cost,
        },
        quota: { before: before.quota, after: after.quota },
        authorizationScope: { activationId: s.policy.activationId, policyDigest: s.policy.digest, expiresAt: s.policy.expiresAt, widensPolicy: false },
        eligibility: "eligible",
        compatibility: previousKind && previousKind !== item.candidate.kind ? "cross-provider" : "same-provider",
        capacity: { previous: s.mission.concurrencyLimits, proposed: s.nextLimits },
      };
    });
    const body: ProposalSnapshot = {
      input: s.storedInput, oldPlanDigest: s.mission.planDigest, newPlanDigest: computeMissionPlanDigest(s.replacement),
      taskFingerprint: s.taskFingerprint, policy: s.policy, sourceReviews: s.sourceReviews,
      implementationRunId: s.implementation?.id ?? null, original: s.current, replacement: amendments[0]!.proposed,
      oldLimits: s.mission.concurrencyLimits, newLimits: s.nextLimits, before, after, amendments,
      seal: amendments.map(item => ({ taskId: item.taskId, stage: item.stage, fingerprint: item.taskFingerprint, reviews: item.sourceReviews, runId: item.implementationRunId })),
      allocation: input.allocation ?? null,
    };
    const serialized = JSON.stringify(body);
    const digest = sha(JSON.stringify([proposalId, id, s.mission.revision, serialized]));
    db.run("INSERT INTO mission_resource_proposals VALUES (?, ?, ?, ?, ?, 'pending', ?, NULL, ?)",
      [proposalId, id, s.mission.revision, digest, serialized, now, headMessageId]);
    return read({ id: proposalId, mission_id: id, revision: s.mission.revision, digest, snapshot: serialized,
      status: "pending", created_at: now, settled_at: null, head_message_id: headMessageId });
  }).immediate();
}

export function settleMissionResourceProposal(id: string, proposalId: string, digest: string, decision: "approve" | "reject", headMessageId: string | null = null) {
  return db.transaction(() => {
    const row = db.query<ProposalRow, [string, string]>(
      "SELECT * FROM mission_resource_proposals WHERE id = ? AND mission_id = ?",
    ).get(proposalId, id);
    if (!row) throw new OrchestrationError("Resource proposal not found.", 404);
    if (row.head_message_id !== headMessageId) conflict("Settle the proposal in its original Owner review surface.");
    if (row.digest !== digest || sha(JSON.stringify([row.id, id, row.revision, row.snapshot])) !== digest) conflict("Resource proposal digest mismatch.");
    const status = decision === "approve" ? "approved" : "rejected";
    if (row.status === status) return read(row);
    if (row.status !== "pending") conflict("This resource proposal is already settled.");
    const now = Date.now();
    const p = read(row);
    if (decision === "approve") {
      const s = snapshot(id, p.input);
      const m = s.mission;
      const seal = s.evaluated.map(item => ({
        taskId: item.task.id, stage: item.change.role, fingerprint: launchFingerprint(item.task),
        reviews: taskQualityReviews.listForTask(item.task.id).map(review => [review.id, review.status, review.verdict, review.reviewRunId]),
        runId: item.implementation?.id ?? null,
      }));
      if (m.revision !== row.revision || m.planDigest !== p.oldPlanDigest ||
        computeMissionPlanDigest(s.replacement) !== p.newPlanDigest || JSON.stringify(s.policy) !== JSON.stringify(p.policy) ||
        JSON.stringify(seal) !== JSON.stringify(p.seal)) {
        conflict("The mission, task, evidence or eligibility changed. Review a new proposal.");
      }
      db.run("INSERT INTO mission_plan_revisions VALUES (?, ?, ?)", [id, m.revision, JSON.stringify({
        revision: m.revision, plan: m.plan, planDigest: m.planDigest, authorization: m.authorization,
      })]);
      const authorization = { authorizedAt: now, authorizedBy: "owner", digest: p.newPlanDigest };
      const history = [...m.history, { timestamp: now, event: "resource_reauthorized", details: {
        proposalId, revision: m.revision + 1, previousDigest: m.planDigest, planDigest: p.newPlanDigest,
        taskId: s.task.id, role: p.input.role, reason: p.input.reason,
        stages: (p.amendments ?? []).map(item => ({ taskId: item.taskId, role: item.stage, accountId: item.proposed.accountId, modelId: item.proposed.modelId, mode: item.proposedMode })),
      } }];
      db.run(`UPDATE orchestration_missions SET revision = revision + 1, plan_json = ?, plan_digest = ?, authorization_json = ?,
        concurrency_limits_json = ?, history_json = ?, updated_at = ? WHERE id = ?`,
        [JSON.stringify(s.replacement), p.newPlanDigest, JSON.stringify(authorization), JSON.stringify(s.nextLimits), JSON.stringify(history), now, id]);
      // Capture the approved remaining-work forecast before a first Developer
      // run can freeze an older, same-harness estimate.
      forecast({ missionId: id, save: true }, now);
    }
    db.run("UPDATE mission_resource_proposals SET status = ?, settled_at = ? WHERE id = ?", [status, now, proposalId]);
    return read({ ...row, status, settled_at: now });
  }).immediate();
}

export function planMissionReallocation(id: string, objective: string): { changes: ReplanChange[]; allocation: ReplanAllocation; limitations: string[] } {
  if (!ALLOCATION_OBJECTIVES.includes(objective as AllocationObjective)) {
    throw new OrchestrationError("Choose fastest, lowest-charge, balanced, quota-preserving, or minimum-wait.", 400);
  }
  const { mission, policy } = checkMission(id);
  const view = forecast({ missionId: id });
  const stages: AllocationStage[] = [];
  const pools = new Map<string, { id: string; remaining: number | null }>();
  const included = new Set<string>();
  const byStage = new Map<string, Map<string, ReplanChange["resource"]>>();
  for (const estimate of view.estimates) {
    const roles = estimate.remainingRoles ?? estimate.roles;
    for (const role of roles) {
      const covered = role === "developer" && roles.includes("reviewer");
      try { checkTask(mission, estimate.taskId, role, covered); } catch { continue; }
      const options = (role === "developer" ? estimate.developerOptions : estimate.reviewerOptions)
        .filter(option => option.planningEligible && option.eligibility === "eligible" && option.accountId && option.mode);
      if (!options.length) continue;
      const stageId = `${estimate.taskId}:${role}`;
      included.add(stageId);
      const wait = taskActuals(estimate.taskId)?.waiting.measured["account-capacity"] ?? 0;
      const current = role === "developer" ? estimate.developer : estimate.reviewer;
      const choices = new Map<string, ReplanChange["resource"]>();
      const mapped = options.map(option => {
        const resource = { harnessId: option.harnessId, modelId: option.modelId, accountId: option.accountId!, mode: option.mode };
        const key = optionKey(option);
        choices.set(key, resource);
        const quota = option.nativeQuota.find(item => quotaDemand(item, option.cost) !== null);
        const pool = quota ? poolKey(quota) : null;
        if (quota && pool && !pools.has(pool)) pools.set(pool, { id: pool, remaining: quota.current?.remaining ?? null });
        return {
          id: key, accountId: option.accountId!, durationMs: option.duration.expected, charge: option.cost.money?.amount ?? null,
          waitMs: current?.accountId === option.accountId ? wait : 0, poolId: pool, demand: quota ? quotaDemand(quota, option.cost) : null,
          concurrency: Math.max(1, option.capacity ?? 1),
          provider: harnesses.get(option.harnessId)?.kind ?? option.harnessId,
        };
      });
      byStage.set(stageId, choices);
      const dependsOn = [
        ...(role === "reviewer" && roles.includes("developer") ? [`${estimate.taskId}:developer`] : []),
        ...estimate.dependsOn.map(dependency => `${dependency}:developer`),
      ].filter(item => item !== stageId);
      const plan = mission.plan.tasks.find(item => item.taskId === estimate.taskId);
      if (!plan) continue;
      const admission = checkProjectLaunchAdmission(plan.projectPath);
      stages.push({
        id: stageId, dependsOn, options: mapped, projectId: plan.projectPath, clusterId: plan.clusterId, role,
        withheld: admission.allowed ? null : (admission.reason ?? "Project is paused or draining."),
      });
    }
  }
  for (const stage of stages) stage.dependsOn = stage.dependsOn.filter(item => included.has(item));
  if (!stages.length) conflict("No remaining stage can take a different eligible resource.");
  const strict = policy.policy.body.requireVerifiedQuota === true;
  const result = searchAllocation(stages, objective as AllocationObjective, [...pools.values()], strict, undefined, {
    globalMax: mission.concurrencyLimits.globalMax,
    perProjectMax: mission.concurrencyLimits.perProjectMax,
    perClusterMax: mission.concurrencyLimits.perClusterMax ?? null,
    occupied: existingWork().filter(row => row.missionId !== id).map(row => ({
      accountId: row.accountId,
      projectId: row.projectPath,
      clusterId: row.keys.find(key => key.startsWith("cluster/"))?.slice("cluster/".length) ?? null,
      role: row.qcId ? "reviewer" : "developer",
      untilMs: 86_400_000,
    })),
    unmeasured: mission.concurrencyLimits.perClusterMax == null ? ["Cluster concurrency is not set on this mission."] : [],
  });
  if (!result.feasible) conflict(result.reason ?? "No feasible allocation was found.");
  const changes: ReplanChange[] = [];
  for (const stage of stages) {
    if (result.withheld[stage.id]) continue;
    const selected = result.assignment[stage.id];
    const resource = selected ? byStage.get(stage.id)?.get(selected) : undefined;
    if (!resource) throw new OrchestrationError("The allocation search did not return an exact resource.", 409);
    const [taskId, role] = stage.id.split(":") as [string, Role];
    const plan = mission.plan.tasks.find(item => item.taskId === taskId)!;
    const bound = currentBinding(plan, role);
    if (bound.harnessId === resource.harnessId && bound.modelId === resource.modelId && bound.accountId === resource.accountId && bound.mode === resource.mode) continue;
    changes.push({ taskId, role, resource });
  }
  if (!changes.length) conflict("The current allocation already matches this objective.");
  if (changes.length > 12) conflict("The bounded search found more stage changes than one proposal can carry.");
  return {
    changes,
    allocation: {
      objective: objective as AllocationObjective, optimal: result.optimal, explored: result.explored, limit: result.limit, feasible: true,
    },
    limitations: result.limitations,
  };
}

export const RECORDED_RESOURCE_FAILURES = [
  "provider-unavailable",
  "model-rejected",
  "account-unavailable",
  "account-authorization-expired",
  "quota-exhausted",
  "shared-pool-unavailable",
  "reviewer-blocked",
  "developer-blocked",
  "execution-interrupted",
  "resource-revoked",
] as const;
export type RecordedResourceFailure = (typeof RECORDED_RESOURCE_FAILURES)[number];

/** Records an eligible replacement proposal. It does not approve, retry, or launch. */
export function proposeRecordedFallback(missionId: string, input: {
  taskId: string;
  role: Role;
  failure: RecordedResourceFailure;
  runId: string | null;
}) {
  if (!RECORDED_RESOURCE_FAILURES.includes(input.failure)) {
    throw new OrchestrationError("The failure reason is not a recorded resource failure.", 400);
  }
  const options = missionResourceOptions(missionId, input.taskId, input.role);
  const mission = missionStore.getMission(missionId);
  const plan = mission?.plan.tasks.find(item => item.taskId === input.taskId);
  const frozen = input.role === "reviewer" ? plan?.reviewerBinding : plan?.developerBinding;
  const currentKey = frozen
    ? `${frozen.harnessId}/${frozen.modelId}/${frozen.accountId}/${frozen.mode}`
    : `${plan?.harnessId ?? ""}/${plan?.modelId ?? ""}/${plan?.accountId ?? ""}/${plan?.mode ?? ""}`;
  const alternative = options.find(option => {
    const resource = option.resource;
    return `${resource.harnessId}/${resource.modelId}/${resource.accountId}/${resource.mode}` !== currentKey;
  });
  if (!alternative) {
    return {
      proposal: null,
      blocked: `No eligible ${input.role} replacement is recorded after ${input.failure}. Nothing was invented. Run ${input.runId ?? "none"} remains the original evidence.`,
    };
  }
  const proposal = prepareMissionResourceProposal(missionId, {
    taskId: input.taskId,
    role: input.role,
    reason: `${input.failure}; preserved run ${input.runId ?? "none"}`,
    resource: {
      harnessId: alternative.resource.harnessId,
      modelId: alternative.resource.modelId,
      accountId: alternative.resource.accountId,
      mode: alternative.resource.mode,
    },
  }, null);
  return { proposal, blocked: null };
}
