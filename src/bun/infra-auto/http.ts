/**
 * FO-INFRA-AUTO01 HTTP API. Bearer auth is required by the server.
 * It does not establish trusted Owner intent for remote execution.
 */
import { InfraAutoError, InfraAutoService, type InfraActor } from "./service.ts";
import type { InfraEnvironment } from "../../shared/infra-auto/model.ts";

const MAX_BODY = 32 * 1024;

export interface InfraAutoHttpDeps {
  service?: InfraAutoService;
}

let defaultService: InfraAutoService | null = null;

async function serviceFor(deps: InfraAutoHttpDeps): Promise<InfraAutoService> {
  if (deps.service) return deps.service;
  if (defaultService) return defaultService;
  const { db } = await import("../db.ts");
  defaultService = new InfraAutoService(db);
  return defaultService;
}

async function readBody(req: Request): Promise<Record<string, unknown>> {
  if (!req.body) return {};
  const reader = req.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const part = await reader.read();
      if (part.done) break;
      size += part.value.byteLength;
      if (size > MAX_BODY) {
        await reader.cancel();
        throw new InfraAutoError("Body too large.", 413);
      }
      chunks.push(part.value);
    }
  } finally {
    reader.releaseLock();
  }
  if (size === 0) return {};
  const text = new TextDecoder().decode(Buffer.concat(chunks));
  const parsed = JSON.parse(text) as unknown;
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new InfraAutoError("JSON object required.");
  return parsed as Record<string, unknown>;
}

function actorOf(body: Record<string, unknown>): InfraActor {
  const actor = body.actor;
  if (actor === "agent" || actor === "head" || actor === "autonomy") return actor;
  return "api";
}

export async function infraAutoHttp(req: Request, authorized: boolean, deps: InfraAutoHttpDeps = {}): Promise<Response> {
  if (!authorized) return Response.json({ error: "Unauthorized." }, { status: 401 });
  const url = new URL(req.url);
  const path = url.pathname;
  try {
    const service = await serviceFor(deps);
    if (req.method === "GET" && path === "/infra-auto/snapshot") {
      return Response.json(service.snapshot());
    }
    if (req.method === "GET" && path === "/infra-auto/channel") {
      return Response.json(service.channel());
    }
    const body = req.method === "GET" ? {} : await readBody(req);
    const actor = actorOf(body);
    if (req.method === "POST" && path === "/infra-auto/bindings") {
      return Response.json(service.upsertBinding(body, actor === "api" ? "owner" : actor));
    }
    if (req.method === "POST" && path === "/infra-auto/production-policy") {
      return Response.json(service.saveProductionPolicy(body, actor === "api" ? "owner" : actor));
    }
    if (req.method === "POST" && path === "/infra-auto/git/inspect") {
      return Response.json(service.inspectGit(String(body.projectPath ?? ""), actor === "api" ? "api" : actor));
    }
    if (req.method === "POST" && path === "/infra-auto/git/mutate") {
      const op = body.op;
      if (op !== "fetch" && op !== "push") throw new InfraAutoError("Only fetch and push are available.", 403, "destructive");
      return Response.json(service.mutateGit({
        projectPath: String(body.projectPath ?? ""),
        op,
        remote: String(body.remote ?? ""),
        branch: String(body.branch ?? ""),
        authorizationId: String(body.authorizationId ?? ""),
      }, actor === "api" ? "api" : actor));
    }
    if (req.method === "POST" && path === "/infra-auto/ci/record") {
      return Response.json(service.recordCiRun({
        projectPath: String(body.projectPath ?? ""),
        workflowName: String(body.workflowName ?? ""),
        runKey: String(body.runKey ?? ""),
        sha: String(body.sha ?? ""),
        branch: typeof body.branch === "string" ? body.branch : undefined,
        status: String(body.status ?? ""),
        conclusion: typeof body.conclusion === "string" ? body.conclusion : null,
        failedJobs: Array.isArray(body.failedJobs) ? body.failedJobs : [],
        logExcerpt: typeof body.logExcerpt === "string" ? body.logExcerpt : "",
      }, actor === "api" ? "owner" : actor));
    }
    if (req.method === "POST" && path === "/infra-auto/plans/prepare") {
      const environment = body.environment;
      if (environment !== "development" && environment !== "staging" && environment !== "production" && environment !== "custom") {
        throw new InfraAutoError("Unknown environment.");
      }
      return Response.json(service.preparePlan({
        projectPath: String(body.projectPath ?? ""),
        environment: environment as InfraEnvironment,
        sha: typeof body.sha === "string" ? body.sha : undefined,
      }, actor === "api" ? "api" : actor));
    }
    const planMatch = path.match(/^\/infra-auto\/plans\/([^/]+)\/(authorize-synthetic|dispatch|handoff|rollback|settle)$/);
    if (planMatch && req.method === "POST") {
      const id = decodeURIComponent(planMatch[1]!);
      const action = planMatch[2];
      if (action === "authorize-synthetic") return Response.json(service.authorizeSynthetic(id, actor === "api" ? "owner" : actor));
      if (action === "dispatch") {
        return Response.json(service.dispatch(id, String(body.authorizationId ?? ""), actor === "api" ? "api" : actor, { defer: body.defer === true }));
      }
      if (action === "handoff") return Response.json(service.manualHandoff(id));
      if (action === "rollback") return Response.json(service.prepareRollback(id, actor === "api" ? "api" : actor));
      return Response.json(service.settle(id));
    }
    if (req.method === "POST" && path === "/infra-auto/control") {
      return Response.json(service.setControl({
        paused: typeof body.paused === "boolean" ? body.paused : undefined,
        cancelled: typeof body.cancelled === "boolean" ? body.cancelled : undefined,
      }, actor === "api" ? "owner" : actor));
    }
    return Response.json({ error: "Not found." }, { status: 404 });
  } catch (error) {
    if (error instanceof InfraAutoError) return Response.json({ error: error.message, code: error.code }, { status: error.status });
    if (error instanceof SyntaxError) return Response.json({ error: "Invalid JSON." }, { status: 400 });
    return Response.json({ error: "Infrastructure request failed." }, { status: 500 });
  }
}
