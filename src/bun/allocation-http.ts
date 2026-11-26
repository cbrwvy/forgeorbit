import {
  AllocationPlanError,
  approveAllocationPlan,
  applyAllocationPlan,
  createAllocationPlanHead,
  createAllocationPlanProject,
  getAllocationPlan,
  listAllocationPlans,
  patchAllocationTaskResource,
  recalculateAllocationPlan,
} from "./allocation-plans.ts";
import { loadAllocationPlanPolicy, saveAllocationPlanPolicy } from "./allocation-plan-policy.ts";
import { recommendExecutors } from "./executor-recommendations.ts";
import { AllocationPlannerError, findOptionById } from "./allocation-planner-service.ts";
import { PreflightError } from "./employee-execution.ts";

const MAX_BODY = 128 * 1024;

async function readJson(req: Request): Promise<unknown> {
  const text = await req.text();
  if (text.length > MAX_BODY) throw new AllocationPlanError("Request too large.", 413);
  return text ? JSON.parse(text) : {};
}

export async function allocationPlanHttp(req: Request, authorized: boolean): Promise<Response> {
  if (!authorized) return Response.json({ error: "Unauthorized" }, { status: 401 });
  const url = new URL(req.url);
  const path = url.pathname.replace(/\/$/, "");
  try {
    if (path === "/allocation-plans/policy") {
      if (req.method === "GET") return Response.json({ policy: loadAllocationPlanPolicy() });
      if (req.method === "PUT") {
        const body = await readJson(req);
        return Response.json({ policy: saveAllocationPlanPolicy(body) });
      }
      return Response.json({ error: "Method not allowed" }, { status: 405 });
    }
    if (path === "/allocation-plans" && req.method === "GET") {
      const scopeRef = url.searchParams.get("scopeRef");
      if (!scopeRef) return Response.json({ error: "scopeRef required" }, { status: 400 });
      return Response.json({ plans: listAllocationPlans(scopeRef) });
    }
    if (path === "/allocation-plans/project" && req.method === "POST") {
      const body = (await readJson(req)) as Record<string, unknown>;
      const view = await createAllocationPlanProject({
        projectPath: String(body.projectPath ?? ""),
        taskIds: Array.isArray(body.taskIds) ? body.taskIds.filter((id): id is string => typeof id === "string") : [],
        title: typeof body.title === "string" ? body.title : undefined,
        reviewerHarnessId: typeof body.reviewerHarnessId === "string" ? body.reviewerHarnessId : undefined,
        reviewerModel: typeof body.reviewerModel === "string" ? body.reviewerModel : undefined,
        reviewerMode: typeof body.reviewerMode === "string" ? body.reviewerMode : undefined,
      });
      return Response.json(view, { status: 201 });
    }
    if (path === "/allocation-plans/head" && req.method === "POST") {
      const body = (await readJson(req)) as Record<string, unknown>;
      const batchIds = Array.isArray(body.batchIds) ? body.batchIds : [];
      if (batchIds.length !== 2) return Response.json({ error: "Exactly two batchIds required." }, { status: 400 });
      const view = await createAllocationPlanHead({
        initiativeId: String(body.initiativeId ?? ""),
        batchIds: [String(batchIds[0]), String(batchIds[1])] as [string, string],
      });
      return Response.json(view, { status: 201 });
    }
    const match = path.match(/^\/allocation-plans\/([^/]+)(\/[^/]+)?$/);
    if (!match) return Response.json({ error: "Not found" }, { status: 404 });
    const id = decodeURIComponent(match[1]!);
    const action = match[2];
    if (!action && req.method === "GET") {
      const view = getAllocationPlan(id);
      if (!view) return Response.json({ error: "Not found" }, { status: 404 });
      return Response.json(view);
    }
    if (action === "/recalculate" && req.method === "POST") {
      const body = (await readJson(req)) as Record<string, unknown>;
      return Response.json(await recalculateAllocationPlan(id, undefined, {
        reviewerHarnessId: typeof body.reviewerHarnessId === "string" ? body.reviewerHarnessId : undefined,
        reviewerModel: typeof body.reviewerModel === "string" ? body.reviewerModel : undefined,
        reviewerMode: typeof body.reviewerMode === "string" ? body.reviewerMode : undefined,
      }));
    }
    if (action === "/approve" && req.method === "POST") {
      const body = (await readJson(req)) as Record<string, unknown>;
      return Response.json(approveAllocationPlan(id, body.planDigest));
    }
    if (action === "/apply" && req.method === "POST") {
      const body = (await readJson(req)) as Record<string, unknown>;
      return Response.json(await applyAllocationPlan(id, body.approvedDigest));
    }
    if (action === "/task-resource" && req.method === "PATCH") {
      const body = (await readJson(req)) as Record<string, unknown>;
      const taskId = typeof body.taskId === "string" ? body.taskId : "";
      const optionId = typeof body.optionId === "string" ? body.optionId : "";
      if (!taskId || !optionId) return Response.json({ error: "taskId and optionId required" }, { status: 400 });
      const plan = getAllocationPlan(id);
      if (!plan) return Response.json({ error: "Not found" }, { status: 404 });
      const slot = plan.record.plan.projects.flatMap((p) => p.tasks).find((t) => t.taskId === taskId);
      if (!slot?.developer) return Response.json({ error: "Task not in plan" }, { status: 404 });
      const response = await recommendExecutors({
        taskId,
        harnessId: slot.developer.harnessId,
        model: slot.developer.modelId,
        role: "developer",
        mode: slot.developer.modeId,
        effort: null,
        complexity: null,
        expectedAssignmentRevision: null,
      });
      const options = Object.values(response.recommendations.groups).flat();
      const option = findOptionById(options, optionId);
      if (!option) return Response.json({ error: "Unknown resource option" }, { status: 400 });
      return Response.json(patchAllocationTaskResource(id, taskId, option));
    }
    return Response.json({ error: "Method not allowed" }, { status: 405 });
  } catch (e) {
    if (e instanceof AllocationPlanError) return Response.json({ error: e.message }, { status: e.status });
    if (e instanceof AllocationPlannerError) return Response.json({ error: e.message }, { status: e.status });
    if (e instanceof PreflightError) return Response.json({ error: e.message }, { status: e.status ?? 400 });
    if (e instanceof SyntaxError) return Response.json({ error: "Invalid JSON" }, { status: 400 });
    throw e;
  }
}
