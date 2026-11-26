/**
 * FO-ROUTING03 durable allocation plans: propose, approve, apply — never grants or Runs.
 */
import { createHash } from "node:crypto";
import { allocationPlanDigest } from "../shared/allocation/digest.ts";
import type { AllocationPlanRecord, AllocationPlanView } from "../shared/allocation/types.ts";
import { resourceKey } from "./orchestrated-resources.ts";
import { launchFingerprint } from "../shared/task-scheduling.ts";
import type { ExecutionConfig } from "../shared/project-execution.ts";
import { applyTaskExecutionConfig } from "./project-execution.ts";
import { db, harnesses, projects, tasks } from "./db.ts";
import { broadcastAppEvent } from "./quit-guard.ts";
import { getOrchestratedBatch } from "./pm-orchestrated-batch.ts";
import {
  AllocationPlannerError,
  newPlanId,
  proposeHeadAllocation,
  proposeProjectAllocation,
  replaceTaskResource,
  type ProposeHeadInput,
  type ProposeProjectInput,
} from "./allocation-planner-service.ts";
import { loadAllocationPlanPolicy } from "./allocation-plan-policy.ts";
import { explainBinding } from "./multiaccount/binding.ts";
import { listProjectAccountPreferences } from "./multiaccount/registry.ts";
import { ownerProjectOf } from "./project-ownership.ts";
import { routerV2Service } from "./router-v2/router-v2-service.ts";
import { defaultModeFor } from "../shared/types.ts";
import type { AllocationPlanBody, AllocationResourcePick } from "../shared/allocation/types.ts";

export class AllocationPlanError extends Error {
  constructor(message: string, readonly status = 400) {
    super(message);
    this.name = "AllocationPlanError";
  }
}

function parseRecord(raw: string | null): AllocationPlanRecord | null {
  if (!raw) return null;
  try {
    return JSON.parse(raw) as AllocationPlanRecord;
  } catch {
    return null;
  }
}

function save(record: AllocationPlanRecord, note?: string): AllocationPlanRecord {
  const at = Date.now();
  record.updatedAt = at;
  if (note) record.history.push({ at, text: note });
  record.planDigest = allocationPlanDigest(record.plan);
  db.run(
    `INSERT INTO allocation_plans (id, scope_kind, scope_ref, status, revision, plan_digest, approved_digest, data_json, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET status = excluded.status, revision = excluded.revision, plan_digest = excluded.plan_digest,
       approved_digest = excluded.approved_digest, data_json = excluded.data_json, updated_at = excluded.updated_at`,
    [
      record.id,
      record.scopeKind,
      record.scopeRef,
      record.status,
      record.revision,
      record.planDigest,
      record.approvedDigest,
      JSON.stringify(record),
      record.createdAt,
      at,
    ],
  );
  broadcastAppEvent({ type: "allocation_plan", planId: record.id, scopeRef: record.scopeRef, status: record.status, ts: at });
  return record;
}

function load(id: string): AllocationPlanRecord | null {
  const row = db.query<{ data_json: string }, [string]>("SELECT data_json FROM allocation_plans WHERE id = ?").get(id);
  return parseRecord(row?.data_json ?? null);
}

/**
 * FO-DIRECTION13. The quota readings (by id) recorded for the accounts a forecast alternative compared: the current and the proposed
 * one. A shared pool is recorded under each of its accounts, so either account's reading is enough. A new reading, or a correction,
 * adds an id and changes this key; nothing is read from a provider here.
 */
export function quotaEvidenceKey(accountIds: Array<string | null | undefined>): string {
  const ids = [...new Set(accountIds.filter((id): id is string => !!id))].sort();
  const rows = ids.length ? db.query<{ quota_id: string; id: string }, string[]>(
    `SELECT o.quota_id, o.id FROM quota_observations o JOIN quota_definitions d ON d.id = o.quota_id
      WHERE d.account_id IN (${ids.map(() => "?").join(",")}) ORDER BY o.quota_id, o.id`,
  ).all(...ids) : [];
  return createHash("sha256").update(JSON.stringify([ids, rows.map(row => `${row.quota_id}:${row.id}`)])).digest("hex");
}

function freshnessBlocker(record: AllocationPlanRecord): string | null {
  if (record.status === "invalidated") return record.invalidateReason ?? "Plan was invalidated.";
  const digestNow = allocationPlanDigest(record.plan);
  if (digestNow !== record.planDigest) return "Plan content changed; recalculate or review again.";
  for (const project of record.plan.projects) {
    if (project.batchFrozen && project.batchId) {
      const batch = getOrchestratedBatch(project.projectPath, project.batchId)?.batch;
      if (batch && batch.status !== project.batchStatus) return "Referenced batch changed; review again.";
    }
    for (const slot of project.tasks) {
      const task = tasks.get(slot.taskId);
      if (!task) return `Task ${slot.title} was removed.`;
      if (launchFingerprint(task) !== slot.taskFingerprint) {
        return `“${slot.title}” changed since the plan was captured.`;
      }
      if (record.plan.forecastChange && slot.developer) {
        const fallbackBlocker = forecastChangeBlocker(task, slot.developer, project.projectPath);
        if (fallbackBlocker) return fallbackBlocker;
        const reviewed = record.plan.forecastChange.evidenceKey;
        if (reviewed && reviewed !== quotaEvidenceKey([record.plan.forecastChange.original.accountId, slot.developer.accountId])) {
          return "Quota evidence changed since this alternative was reviewed; review it again.";
        }
      }
      if (!slot.developer?.harnessId) continue;
      const harness = harnesses.getByIdOrKind(slot.developer.harnessId);
      if (!harness?.enabled) return `Resource ${slot.developer.harnessLabel} is unavailable.`;
      try {
        if (slot.developer.resourceFingerprint && resourceKey(harness) !== slot.developer.resourceFingerprint) {
          return `Resource fingerprint changed for ${slot.developer.harnessLabel}.`;
        }
      } catch {
        return "Codex profile configuration changed.";
      }
    }
  }
  return null;
}

function buildView(record: AllocationPlanRecord): AllocationPlanView {
  const blocker = freshnessBlocker(record);
  const valid = blocker === null && record.status !== "invalidated";
  const canApprove = valid && record.status === "proposed";
  const canApply =
    valid &&
    record.status === "approved" &&
    record.approvedDigest === record.planDigest;
  let applyBlocker: string | null = null;
  if (record.status === "approved" && record.approvedDigest !== record.planDigest) applyBlocker = "Approved digest does not match the current plan.";
  if (record.plan.projects.some((p) => p.batchFrozen)) applyBlocker = applyBlocker ?? "Frozen batch resources cannot be changed by this plan; approve a new batch plan first.";
  return {
    record,
    planDigest: record.planDigest,
    valid,
    validityBlocker: blocker,
    canApprove,
    canApply: canApply && !applyBlocker,
    applyBlocker,
  };
}

export function getAllocationPlan(id: string): AllocationPlanView | null {
  const record = load(id);
  return record ? buildView(record) : null;
}

export function listAllocationPlans(scopeRef: string): AllocationPlanView[] {
  return db
    .query<{ data_json: string }, [string]>(
      `SELECT data_json FROM allocation_plans WHERE scope_ref = ? ORDER BY updated_at DESC LIMIT 20`,
    )
    .all(scopeRef)
    .map((row) => buildView(parseRecord(row.data_json)!));
}

export async function createAllocationPlanProject(body: Omit<ProposeProjectInput, "policy"> & { policy?: ProposeProjectInput["policy"] }): Promise<AllocationPlanView> {
  const policy = body.policy ?? loadAllocationPlanPolicy();
  const plan = await proposeProjectAllocation({ ...body, policy });
  const now = Date.now();
  const record: AllocationPlanRecord = {
    id: newPlanId(),
    scopeKind: "project-manager",
    scopeRef: plan.projects[0]!.projectPath,
    status: "proposed",
    revision: 1,
    planDigest: allocationPlanDigest(plan),
    approvedDigest: null,
    approvedAt: null,
    appliedAt: null,
    invalidatedAt: null,
    invalidateReason: null,
    plan,
    history: [{ at: now, text: "Proposed allocation plan; no execution grant created." }],
    createdAt: now,
    updatedAt: now,
  };
  save(record);
  return buildView(record);
}

function forecastChangeBlocker(task: NonNullable<ReturnType<typeof tasks.get>>, pick: AllocationResourcePick, projectPath: string) {
  if (task.column !== "backlog" || task.archivedAt != null || task.pipelineId || task.pipelineParentId || task.agentProfileId ||
    ownerProjectOf(task.workdir) !== projectPath || db.query("SELECT 1 FROM runs WHERE task_id = ? LIMIT 1").get(task.id) ||
    db.query(`SELECT 1 FROM orchestration_missions m, json_each(m.plan_json,'$.tasks') item
      WHERE m.authorization_json IS NOT NULL AND m.status IN ('authorized','running','paused')
        AND json_extract(item.value,'$.taskId') = ? LIMIT 1`).get(task.id)) {
    return "Only unstarted Backlog tasks outside a frozen mission can change resources here.";
  }
  const source = harnesses.getByIdOrKind(task.agent);
  if (!source || source.kind !== harnesses.get(pick.harnessId)?.kind || (task.mode ?? defaultModeFor(source.kind)) !== pick.modeId) return "The alternative must preserve the task's execution mode.";
  const account = listProjectAccountPreferences(db).find(p => p.projectPath === projectPath && p.role === "developer");
  if (account && account.accountId !== pick.accountId) return "The alternative conflicts with the project's pinned account.";
  const policy = loadAllocationPlanPolicy();
  if (policy.allowedHarnessIds?.length && !policy.allowedHarnessIds.includes(pick.harnessId) ||
    policy.allowedAccountIds?.length && (!pick.accountId || !policy.allowedAccountIds.includes(pick.accountId))) {
    return "The alternative is excluded by the Owner allocation policy.";
  }
  const binding = explainBinding({ harnessId: pick.harnessId, modelId: pick.modelId, accountId: pick.accountId, mode: pick.modeId });
  if (!binding.ok || !binding.frozen) return "The alternative needs an exact registered execution profile.";
  const candidates = routerV2Service.gatherCandidatesSync("developer");
  const result = routerV2Service.evaluateTaskSync({ taskId: task.id, projectId: projectPath, role: "developer" }, { candidates });
  if (!result.eligible.some(row => row.candidateId === pick.optionId) ||
    !candidates.some(row => row.id === pick.optionId && !row.simulated && row.cliInstalled === true && row.cliLoggedIn === true)) {
    return "The reviewed alternative is currently unavailable.";
  }
  return null;
}

export function createForecastAllocation(taskId: string, pick: AllocationResourcePick, change: NonNullable<AllocationPlanBody["forecastChange"]>) {
  const task = tasks.get(taskId);
  const projectPath = task && ownerProjectOf(task.workdir);
  if (!task || !projectPath) throw new AllocationPlanError("A registered project task is required.", 409);
  const blocker = forecastChangeBlocker(task, pick, projectPath);
  if (blocker) throw new AllocationPlanError(blocker, 409);
  const harness = harnesses.get(pick.harnessId)!;
  const now = Date.now();
  const reviewed = { ...change, evidenceKey: quotaEvidenceKey([change.original.accountId, pick.accountId]) };
  const plan: AllocationPlanBody = {
    scopeKind: "project-manager", title: task.title, initiativeId: null, capturedAt: now,
    policy: loadAllocationPlanPolicy(), ownerApprovalRequired: true, executionAvailable: false, forecastChange: reviewed,
    projects: [{ projectPath, projectLabel: projects.get(projectPath)?.name ?? projectPath, batchId: null, batchStatus: null, batchFrozen: false,
      reviewer: { projectPath, batchId: null, reviewerEmployeeId: null, reviewerEmployeeName: null, reviewer: null, blockers: [] },
      tasks: [{ taskId, projectPath, title: task.title, taskFingerprint: launchFingerprint(task), taskUpdatedAt: task.updatedAt,
        developerEmployeeId: null, developerEmployeeName: null, developer: { ...pick, resourceFingerprint: resourceKey(harness) }, blockers: [] }],
    }],
  };
  const record: AllocationPlanRecord = {
    id: newPlanId(), scopeKind: plan.scopeKind, scopeRef: projectPath, status: "proposed", revision: 1,
    planDigest: allocationPlanDigest(plan), approvedDigest: null, approvedAt: null, appliedAt: null, invalidatedAt: null,
    invalidateReason: null, plan, history: [{ at: now, text: "Forecast alternative awaiting Owner resource approval." }], createdAt: now, updatedAt: now,
  };
  save(record);
  return buildView(record);
}

export async function createAllocationPlanHead(body: Omit<ProposeHeadInput, "policy"> & { policy?: ProposeHeadInput["policy"] }): Promise<AllocationPlanView> {
  const policy = body.policy ?? loadAllocationPlanPolicy();
  const plan = await proposeHeadAllocation({ ...body, policy });
  const now = Date.now();
  const record: AllocationPlanRecord = {
    id: newPlanId(),
    scopeKind: "head-initiative",
    scopeRef: body.initiativeId,
    status: "proposed",
    revision: 1,
    planDigest: allocationPlanDigest(plan),
    approvedDigest: null,
    approvedAt: null,
    appliedAt: null,
    invalidatedAt: null,
    invalidateReason: null,
    plan,
    history: [{ at: now, text: "Proposed Head allocation plan; batches remain separately authorized." }],
    createdAt: now,
    updatedAt: now,
  };
  save(record);
  return buildView(record);
}

function overlayOwnerSelections(previous: import("../shared/allocation/types.ts").AllocationPlanBody, next: import("../shared/allocation/types.ts").AllocationPlanBody, preserveReviewer = true) {
  for (const project of next.projects) {
    if (project.batchFrozen) continue;
    const prev = previous.projects.find((p) => p.projectPath === project.projectPath);
    if (!prev) continue;
    for (const slot of project.tasks) {
      const chosen = prev.tasks.find((t) => t.taskId === slot.taskId)?.developer;
      if (chosen?.harnessId) {
        slot.developer = chosen;
        slot.blockers = chosen.blockers;
      }
    }
    if (preserveReviewer && prev.reviewer.reviewer?.harnessId) project.reviewer.reviewer = prev.reviewer.reviewer;
  }
  return next;
}

export async function recalculateAllocationPlan(id: string, deps?: ProposeProjectInput["deps"], reviewer?: { reviewerHarnessId?: string; reviewerModel?: string; reviewerMode?: string }): Promise<AllocationPlanView> {
  const existing = load(id);
  if (!existing) throw new AllocationPlanError("Plan not found.", 404);
  if (existing.status === "applied" || existing.plan.forecastChange) throw new AllocationPlanError("Generate a fresh proposal for this plan.", 409);
  const policy = existing.plan.policy;
  const reviewerChanged = !!(reviewer?.reviewerHarnessId || reviewer?.reviewerModel || reviewer?.reviewerMode);
  const plan =
    existing.scopeKind === "head-initiative"
      ? await proposeHeadAllocation({ initiativeId: existing.scopeRef, batchIds: existing.plan.projects.map((p) => p.batchId!).filter(Boolean) as [string, string], policy, deps })
      : await proposeProjectAllocation({
          projectPath: existing.scopeRef,
          taskIds: existing.plan.projects[0]!.tasks.map((t) => t.taskId),
          policy,
          title: existing.plan.title,
          deps,
          ...(reviewerChanged ? reviewer : {}),
        });
  existing.plan = overlayOwnerSelections(existing.plan, plan, !reviewerChanged);
  existing.revision += 1;
  existing.status = "proposed";
  existing.approvedDigest = null;
  existing.approvedAt = null;
  existing.planDigest = allocationPlanDigest(plan);
  save(existing, "Recalculated eligibility from current resources.");
  return buildView(existing);
}

export function patchAllocationTaskResource(id: string, taskId: string, option: import("../shared/execution/executor-routing.ts").ExecutorOption): AllocationPlanView {
  const existing = load(id);
  if (!existing) throw new AllocationPlanError("Plan not found.", 404);
  if (existing.status !== "proposed" || existing.plan.forecastChange) throw new AllocationPlanError("This proposal cannot be edited.", 409);
  try {
    existing.plan = replaceTaskResource(existing.plan, taskId, option);
  } catch (e) {
    if (e instanceof AllocationPlannerError) throw new AllocationPlanError(e.message, e.status);
    throw e;
  }
  existing.revision += 1;
  existing.planDigest = allocationPlanDigest(existing.plan);
  save(existing, "Owner replaced a proposed resource.");
  return buildView(existing);
}

export function approveAllocationPlan(id: string, approvedDigest: unknown): AllocationPlanView {
  const existing = load(id);
  if (!existing) throw new AllocationPlanError("Plan not found.", 404);
  if (existing.status !== "proposed") throw new AllocationPlanError("Plan is not awaiting approval.", 409);
  const blocker = freshnessBlocker(existing);
  if (blocker) throw new AllocationPlanError(blocker, 409);
  if (typeof approvedDigest !== "string" || approvedDigest !== existing.planDigest) {
    throw new AllocationPlanError("Approve the exact reviewed plan digest.", 409);
  }
  const now = Date.now();
  existing.status = "approved";
  existing.approvedDigest = existing.planDigest;
  existing.approvedAt = now;
  save(existing, "Owner approved resource selections; execution still requires separate grants.");
  return buildView(existing);
}

async function applySlot(taskId: string, pick: NonNullable<import("../shared/allocation/types.ts").AllocationResourcePick>): Promise<void> {
  const config: ExecutionConfig = {
    pipelineId: null,
    profileId: null,
    harness: pick.harnessId,
    model: pick.modelId,
    effort: null,
    mode: pick.modeId,
    fast: false,
    maxMode: false,
  };
  await applyTaskExecutionConfig(taskId, config);
}

export async function applyAllocationPlan(id: string, approvedDigest: unknown): Promise<AllocationPlanView> {
  const existing = load(id);
  if (!existing) throw new AllocationPlanError("Plan not found.", 404);
  if (existing.status !== "approved") throw new AllocationPlanError("Plan must be approved before apply.", 409);
  if (typeof approvedDigest !== "string" || approvedDigest !== existing.approvedDigest) {
    throw new AllocationPlanError("Apply bound to the approved plan digest.", 409);
  }
  const view = buildView(existing);
  if (!view.canApply) throw new AllocationPlanError(view.applyBlocker ?? "Plan cannot be applied.", 409);
  if (existing.plan.forecastChange) return db.transaction(() => {
    const slot = existing.plan.projects[0]!.tasks[0]!;
    const pick = slot.developer!;
    tasks.update(slot.taskId, { agent: pick.harnessId, model: pick.modelId, mode: pick.modeId });
    existing.status = "applied";
    existing.appliedAt = Date.now();
    save(existing, "Applied Owner-approved Backlog resource selection.");
    return buildView(existing);
  })();
  const errors: string[] = [];
  let applied = 0;
  for (const project of existing.plan.projects) {
    if (project.batchFrozen) {
      errors.push(`${project.projectLabel}: batch is frozen.`);
      continue;
    }
    for (const slot of project.tasks) {
      if (!slot.developer?.selectable) {
        errors.push(`“${slot.title}”: ${slot.blockers[0] ?? "blocked"}`);
        continue;
      }
      try {
        await applySlot(slot.taskId, slot.developer);
        applied += 1;
      } catch (e) {
        errors.push(`“${slot.title}”: ${e instanceof Error ? e.message : String(e)}`);
      }
    }
  }
  const now = Date.now();
  if (errors.length && applied === 0) {
    existing.status = "partial";
    save(existing, `Apply failed: ${errors[0]}`);
    throw new AllocationPlanError(errors.join(" "), 409);
  }
  existing.status = errors.length ? "partial" : "applied";
  existing.appliedAt = now;
  save(existing, errors.length ? `Partial apply: ${errors.join("; ")}` : "Applied approved resource selections to tasks.");
  return buildView(existing);
}

export function invalidateAllocationPlansForTask(taskId: string, reason: string): void {
  const rows = db.query<{ data_json: string }, []>("SELECT data_json FROM allocation_plans WHERE status IN ('proposed','approved')").all();
  for (const row of rows) {
    const record = parseRecord(row.data_json);
    if (!record) continue;
    if (!record.plan.projects.some((p) => p.tasks.some((t) => t.taskId === taskId))) continue;
    record.status = "invalidated";
    record.invalidatedAt = Date.now();
    record.invalidateReason = reason;
    save(record, reason);
  }
}

export function initAllocationPlans(): void {
  /* schema via migration */
}
