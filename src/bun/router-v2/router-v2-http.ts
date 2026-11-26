/**
 * FO-ROUTING04: AI Router 2.0 — HTTP Endpoints
 */

import { routerV2Service } from "./router-v2-service.ts";
import type { TaskRequirementsInput, ProjectRouterPolicyConfig, MultiProjectAllocationPlan } from "../../shared/router-v2/types.ts";

export async function routerV2Http(req: Request, authorized: boolean): Promise<Response> {
  const json = (body: unknown, status = 200) =>
    Response.json(body, { status, headers: { "cache-control": "no-store" } });

  if (!authorized) return json({ error: "unauthorized" }, 401);

  const url = new URL(req.url);
  const pathname = url.pathname;

  // GET /api/router-v2/config
  if (pathname === "/api/router-v2/config" && req.method === "GET") {
    const scopeId = url.searchParams.get("scopeId") ?? url.searchParams.get("projectId") ?? "global";
    return json({ policy: routerV2Service.getPolicy(scopeId) });
  }

  // POST /api/router-v2/config
  if (pathname === "/api/router-v2/config" && req.method === "POST") {
    try {
      const body = (await req.json()) as ProjectRouterPolicyConfig;
      if (!body || !body.preset || !body.quotaPolicy) {
        return json({ error: "Invalid router policy configuration." }, 400);
      }
      routerV2Service.savePolicy(body);
      return json({ ok: true, policy: routerV2Service.getPolicy(body.scopeId) });
    } catch (e) {
      return json({ error: (e as Error).message }, 400);
    }
  }

  // POST /api/router-v2/evaluate
  if (pathname === "/api/router-v2/evaluate" && req.method === "POST") {
    try {
      const body = (await req.json()) as {
        requirements: TaskRequirementsInput;
        policyOverride?: Partial<ProjectRouterPolicyConfig>;
      };
      if (!body?.requirements?.taskId) {
        return json({ error: "Task requirements with taskId required." }, 400);
      }
      const evaluation = await routerV2Service.evaluateTask(body.requirements, {
        policyOverride: body.policyOverride,
      });
      return json(evaluation);
    } catch (e) {
      return json({ error: (e as Error).message }, 500);
    }
  }

  // POST /api/router-v2/plans/propose
  if (pathname === "/api/router-v2/plans/propose" && req.method === "POST") {
    try {
      const body = (await req.json()) as {
        projectTasks: { projectPath: string; taskIds: string[] }[];
        policyOverride?: Partial<ProjectRouterPolicyConfig>;
      };
      if (!Array.isArray(body?.projectTasks) || body.projectTasks.length === 0) {
        return json({ error: "projectTasks list required." }, 400);
      }
      const plan = await routerV2Service.planMultiProject(body.projectTasks, {
        policyOverride: body.policyOverride,
      });
      return json({ plan });
    } catch (e) {
      return json({ error: (e as Error).message }, 500);
    }
  }

  // POST /api/router-v2/plans/apply
  if (pathname === "/api/router-v2/plans/apply" && req.method === "POST") {
    try {
      const body = (await req.json()) as {
        plan: MultiProjectAllocationPlan;
        approvedDigest: string;
      };
      if (!body?.plan || !body.approvedDigest) {
        return json({ error: "Plan and approvedDigest required." }, 400);
      }
      const result = routerV2Service.applyPlan(body.plan, body.approvedDigest, { recheck: true });
      return json(result, result.success ? 200 : 409);
    } catch (e) {
      return json({ error: (e as Error).message }, 500);
    }
  }

  // GET /api/router-v2/history
  if (pathname === "/api/router-v2/history" && req.method === "GET") {
    const limit = parseInt(url.searchParams.get("limit") ?? "50", 10);
    const history = routerV2Service.listDecisions(Number.isFinite(limit) ? limit : 50);
    return json({ history });
  }

  if (pathname === "/api/router-v2/recommendations" && req.method === "POST") {
    try {
      const body = (await req.json()) as { requirements: TaskRequirementsInput; policyOverride?: Partial<ProjectRouterPolicyConfig> };
      if (!body?.requirements?.taskId) return json({ error: "Task requirements with taskId required." }, 400);
      const result = routerV2Service.recordRecommendation(body.requirements, body.policyOverride);
      return json(result);
    } catch (e) {
      return json({ error: (e as Error).message }, 400);
    }
  }

  if (pathname === "/api/router-v2/plans/capacity" && req.method === "POST") {
    try {
      const body = (await req.json()) as { projectTasks: { projectPath: string; taskIds: string[] }[]; policyOverride?: Partial<ProjectRouterPolicyConfig> };
      if (!Array.isArray(body?.projectTasks) || body.projectTasks.length === 0) return json({ error: "projectTasks list required." }, 400);
      const result = await routerV2Service.planPortfolio(body.projectTasks, { policyOverride: body.policyOverride });
      return json(result);
    } catch (e) {
      return json({ error: (e as Error).message }, 400);
    }
  }

  return json({ error: "not found" }, 404);
}
