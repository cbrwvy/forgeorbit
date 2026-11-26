/**
 * Build allocation proposals using the existing recommendation engine.
 */
import { randomUUID } from "node:crypto";
import { capText } from "../shared/project-interview.ts";
import {
  ALLOCATION_PLAN_LIMITS,
  type AllocationPlanBody,
  type AllocationPlanPolicy,
  type AllocationProjectSlice,
  type AllocationReviewerSlot,
  type AllocationTaskSlot,
  taskFingerprintOf,
} from "../shared/allocation/types.ts";
import { allocationPlanDigest } from "../shared/allocation/digest.ts";
import { executorOptionToPick, findOptionById, pickAllocationResource, rankAllocationOptions } from "../shared/allocation/planner.ts";
import type { ExecutorOption } from "../shared/execution/executor-routing.ts";
import type { Task } from "../shared/types.ts";
import { AssignmentCore } from "./assignment-core.ts";
import { db, projects, tasks } from "./db.ts";
import { resolveProject } from "./environment/http.ts";
import { recommendExecutors, type RecommendationDeps } from "./executor-recommendations.ts";
import { getOrchestratedBatch } from "./pm-orchestrated-batch.ts";
import { taskInProject } from "./project-ownership.ts";
import { columnBlockReason } from "../shared/project-execution.ts";
import { getHeadPmInitiative } from "./head-pm-initiative.ts";

export class AllocationPlannerError extends Error {
  constructor(message: string, readonly status = 400) {
    super(message);
    this.name = "AllocationPlannerError";
  }
}

const FROZEN_BATCH_STATUSES = new Set(["approved", "running", "paused", "completed"]);

function assertReady(task: Task, projectPath: string): void {
  if (!taskInProject(task, projectPath, { fresh: true })) throw new AllocationPlannerError("Task not in this project.", 404);
  if (task.archivedAt != null) throw new AllocationPlannerError("Archived tasks cannot be planned.", 409);
  if (task.column !== "ready") {
    throw new AllocationPlannerError(columnBlockReason(task.column) ?? `Task must be Ready (currently ${task.column}).`, 409);
  }
}

async function optionsForTask(
  task: Task,
  role: "developer" | "reviewer",
  harnessId: string | undefined,
  model: string | undefined,
  mode: string | undefined,
  deps: RecommendationDeps,
): Promise<{ options: ExecutorOption[]; response: Awaited<ReturnType<typeof recommendExecutors>> }> {
  const response = await recommendExecutors(
    {
      taskId: task.id,
      harnessId: harnessId ?? task.agent,
      model: model ?? task.model ?? undefined,
      role,
      mode,
      effort: null,
      complexity: null,
      expectedAssignmentRevision: null,
    },
    deps,
  );
  const options = Object.values(response.recommendations.groups).flat();
  return { options, response };
}

function slotFromPick(
  task: Task,
  projectPath: string,
  pick: ReturnType<typeof pickAllocationResource>,
  employee: { id: string; name: string } | null,
): AllocationTaskSlot {
  const fp = taskFingerprintOf(task);
  return {
    taskId: task.id,
    title: task.title,
    projectPath,
    taskFingerprint: fp.fingerprint,
    taskUpdatedAt: fp.updatedAt,
    developerEmployeeId: employee?.id ?? null,
    developerEmployeeName: employee?.name ?? null,
    developer: pick.pick,
    blockers: pick.pick ? pick.pick.blockers : [pick.blockingReason ?? "No Developer resource."],
  };
}

function reviewerSlot(
  projectPath: string,
  batchId: string | null,
  pick: ReturnType<typeof pickAllocationResource>,
  employee: { id: string; name: string } | null,
): AllocationReviewerSlot {
  return {
    projectPath,
    batchId,
    reviewerEmployeeId: employee?.id ?? null,
    reviewerEmployeeName: employee?.name ?? null,
    reviewer: pick.pick,
    blockers: pick.pick ? pick.pick.blockers : [pick.blockingReason ?? "No Reviewer resource."],
  };
}

export interface ProposeProjectInput {
  projectPath: string;
  taskIds: string[];
  reviewerHarnessId?: string;
  reviewerModel?: string;
  reviewerMode?: string;
  policy: AllocationPlanPolicy;
  title?: string;
  deps?: RecommendationDeps;
}

export async function proposeProjectAllocation(input: ProposeProjectInput): Promise<AllocationPlanBody> {
  const resolved = resolveProject(input.projectPath);
  if (!resolved.ok) throw new AllocationPlannerError(resolved.error, resolved.status);
  const projectPath = resolved.path;
  if (!input.taskIds.length) throw new AllocationPlannerError("Pick at least one Ready task.");
  if (input.taskIds.length > Math.min(input.policy.maxTasks, ALLOCATION_PLAN_LIMITS.maxTasks)) {
    throw new AllocationPlannerError(`At most ${input.policy.maxTasks} tasks per plan.`);
  }
  const unique = [...new Set(input.taskIds)];
  const assignment = new AssignmentCore(db);
  const taskRows: Task[] = [];
  for (const id of unique) {
    const task = tasks.get(id);
    if (!task) throw new AllocationPlannerError(`Task ${id.slice(0, 8)} not found.`, 404);
    assertReady(task, projectPath);
    taskRows.push(task);
  }
  const label = projects.get(projectPath)?.name ?? projectPath;
  const slots: AllocationTaskSlot[] = [];
  for (const task of taskRows) {
    const a = assignment.forTask(task.id);
    const employee = a
      ? { id: a.employeeId, name: db.query<{ name: string }, [string]>("SELECT name FROM ai_employees WHERE id = ?").get(a.employeeId)?.name ?? a.employeeId }
      : null;
    const { options, response } = await optionsForTask(task, "developer", task.agent, task.model ?? undefined, task.mode ?? undefined, input.deps ?? {});
    const pick = pickAllocationResource(response.recommendations, input.policy, "developer", task.agent);
    slots.push(slotFromPick(task, projectPath, pick, employee));
    void options;
  }
  const reviewerTask = taskRows[0]!;
  const reviewerHarness = input.reviewerHarnessId ?? reviewerTask.agent;
  const reviewerModel = input.reviewerModel ?? reviewerTask.model ?? "gpt-6.1-sol";
  const reviewerMode = input.reviewerMode ?? (reviewerHarness.includes("codex") ? "ask" : undefined);
  const { response: reviewerResponse } = await optionsForTask(reviewerTask, "reviewer", reviewerHarness, reviewerModel, reviewerMode, input.deps ?? {});
  const reviewerPick = pickAllocationResource(reviewerResponse.recommendations, input.policy, "reviewer", reviewerHarness, reviewerModel);
  const slice: AllocationProjectSlice = {
    projectPath,
    projectLabel: label,
    batchId: null,
    batchStatus: null,
    batchFrozen: false,
    tasks: slots,
    reviewer: reviewerSlot(projectPath, null, reviewerPick, null),
  };
  const now = Date.now();
  return {
    scopeKind: "project-manager",
    title: capText(input.title ?? `Allocation (${slots.length} tasks)`, ALLOCATION_PLAN_LIMITS.titleChars),
    initiativeId: null,
    projects: [slice],
    policy: input.policy,
    capturedAt: now,
    ownerApprovalRequired: true,
    executionAvailable: false,
  };
}

export interface ProposeHeadInput {
  initiativeId: string;
  batchIds: [string, string];
  policy: AllocationPlanPolicy;
  deps?: RecommendationDeps;
}

export async function proposeHeadAllocation(input: ProposeHeadInput): Promise<AllocationPlanBody> {
  const initiative = getHeadPmInitiative(input.initiativeId);
  if (!initiative || initiative.cancelledAt != null) throw new AllocationPlannerError("Initiative unavailable.", 404);
  const slices: AllocationProjectSlice[] = [];
  const assignment = new AssignmentCore(db);
  for (const batchId of input.batchIds) {
    const contribution = initiative.contributions.find((c) => getOrchestratedBatch(c.projectPath, batchId));
    if (!contribution) throw new AllocationPlannerError("Batch does not belong to this initiative.", 400);
    const view = getOrchestratedBatch(contribution.projectPath, batchId);
    if (!view) throw new AllocationPlannerError("Batch not found.", 404);
    const batch = view.batch;
    const frozen = FROZEN_BATCH_STATUSES.has(batch.status);
    const taskSlots: AllocationTaskSlot[] = [];
    for (const plan of batch.tasks) {
      const task = tasks.get(plan.taskId);
      if (!task) throw new AllocationPlannerError("Batch task missing.", 404);
      const a = assignment.forTask(task.id);
      const employee = a
        ? { id: a.employeeId, name: db.query<{ name: string }, [string]>("SELECT name FROM ai_employees WHERE id = ?").get(a.employeeId)?.name ?? a.employeeId }
        : { id: plan.implementerEmployeeId, name: plan.implementerEmployeeId };
      if (frozen) {
        taskSlots.push({
          taskId: task.id,
          title: task.title,
          projectPath: contribution.projectPath,
          taskFingerprint: plan.fingerprint,
          taskUpdatedAt: plan.taskUpdatedAt,
          developerEmployeeId: employee.id,
          developerEmployeeName: employee.name,
          developer: {
            optionId: JSON.stringify([plan.implementerHarnessId, null, plan.implementerModel, plan.execution?.implementerMode ?? task.mode ?? "auto"]),
            harnessId: plan.implementerHarnessId,
            harnessLabel: plan.implementerHarnessId,
            kind: "codex",
            modelId: plan.implementerModel,
            modelLabel: plan.implementerModel,
            modeId: plan.execution?.implementerMode ?? task.mode ?? "auto",
            modeLabel: plan.execution?.implementerMode ?? task.mode ?? "auto",
            accountId: plan.execution?.implementerAccountProfile?.id ?? null,
            accountLabel: plan.execution?.implementerAccountProfile?.displayName ?? null,
            resourceFingerprint: plan.execution?.implementerHarnessKey ?? null,
            eligibility: "eligible",
            eligibilityReasons: [],
            limitations: [],
            unknownFacts: [],
            blockers: [],
            selectable: true,
          },
          blockers: frozen ? ["batch-frozen-read-only"] : [],
        });
        continue;
      }
      const { response } = await optionsForTask(task, "developer", plan.implementerHarnessId, plan.implementerModel, plan.execution?.implementerMode, input.deps ?? {});
      const pick = pickAllocationResource(response.recommendations, input.policy, "developer", task.agent);
      taskSlots.push(slotFromPick(task, contribution.projectPath, pick, employee));
    }
    const reviewerTask = tasks.get(batch.tasks[0]!.taskId)!;
    const { response: reviewerResponse } = await optionsForTask(
      reviewerTask,
      "reviewer",
      batch.tasks[0]!.reviewerHarness,
      batch.tasks[0]!.reviewerModel,
      batch.tasks[0]!.execution?.reviewerMode ?? "ask",
      input.deps ?? {},
    );
    const reviewerPick = frozen
      ? {
          pick: {
            optionId: "frozen-reviewer",
            harnessId: batch.tasks[0]!.reviewerHarness,
            harnessLabel: batch.tasks[0]!.reviewerHarness,
            kind: "codex",
            modelId: batch.tasks[0]!.reviewerModel,
            modelLabel: batch.tasks[0]!.reviewerModel,
            modeId: batch.tasks[0]!.execution?.reviewerMode ?? "ask",
            modeLabel: batch.tasks[0]!.execution?.reviewerMode ?? "ask",
            accountId: batch.tasks[0]!.execution?.reviewerAccountProfile?.id ?? null,
            accountLabel: batch.tasks[0]!.execution?.reviewerAccountProfile?.displayName ?? null,
            resourceFingerprint: batch.tasks[0]!.execution?.reviewerHarnessKey ?? null,
            eligibility: "eligible" as const,
            eligibilityReasons: [],
            limitations: [],
            unknownFacts: [],
            blockers: [],
            selectable: true,
          },
          blockingReason: null,
        }
      : pickAllocationResource(reviewerResponse.recommendations, input.policy, "reviewer", batch.tasks[0]!.reviewerHarness, batch.tasks[0]!.reviewerModel);
    slices.push({
      projectPath: contribution.projectPath,
      projectLabel: contribution.projectName,
      batchId: batch.id,
      batchStatus: batch.status,
      batchFrozen: frozen,
      tasks: taskSlots,
      reviewer: reviewerSlot(contribution.projectPath, batch.id, reviewerPick, null),
    });
  }
  const now = Date.now();
  const body: AllocationPlanBody = {
    scopeKind: "head-initiative",
    title: capText(`Head allocation (${initiative.title})`, ALLOCATION_PLAN_LIMITS.titleChars),
    initiativeId: initiative.id,
    projects: slices,
    policy: input.policy,
    capturedAt: now,
    ownerApprovalRequired: true,
    executionAvailable: false,
  };
  void allocationPlanDigest(body);
  return body;
}

export function replaceTaskResource(
  plan: AllocationPlanBody,
  taskId: string,
  option: ExecutorOption,
): AllocationPlanBody {
  const next = structuredClone(plan);
  for (const project of next.projects) {
    const slot = project.tasks.find((t) => t.taskId === taskId);
    if (!slot) continue;
    if (project.batchFrozen) throw new AllocationPlannerError("Batch is frozen; replace requires new Owner approval on the batch.", 409);
    slot.developer = executorOptionToPick(option, "developer");
    slot.blockers = slot.developer.blockers.length ? slot.developer.blockers : [];
    return next;
  }
  throw new AllocationPlannerError("Task not in plan.", 404);
}

export function rankOptionsForTask(options: ExecutorOption[], policy: AllocationPlanPolicy, role: "developer" | "reviewer"): ExecutorOption[] {
  return rankAllocationOptions(options, policy, role);
}

export function newPlanId(): string {
  return randomUUID();
}

export { findOptionById };
