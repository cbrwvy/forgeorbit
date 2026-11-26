/**
 * FO-BROWSER01 Owner browser API.
 * Every route requires the existing bearer token. There is no command channel
 * and no shell execution. Loopback HTTP is not accepted from the request body.
 */

import { BrowserSessionError } from "./browser-session-error.ts";
import { loadBrowserAgentGrants, type BrowserAgentGrantService } from "./browser-agent.ts";
import { defaultBrowserSessionManager, type BrowserSessionManager } from "./browser-session.ts";
import { isBrowserGrantId, isBrowserSessionId, type BrowserAgentTarget } from "../shared/browser/agent.ts";
import { validateProjectPath } from "../shared/clusters/paths.ts";

export interface BrowserHttpDeps {
  manager?: BrowserSessionManager;
}

const BODY_BYTES = 8_192;

export async function browserHttp(req: Request, bearerAuthorized: boolean, deps: BrowserHttpDeps = {}): Promise<Response> {
  if (!bearerAuthorized) return json({ error: "unauthorized", code: "unauthorized" }, 401);
  try {
    const manager = deps.manager ?? await defaultBrowserSessionManager();
    const url = new URL(req.url);
    const segments = url.pathname.split("/").filter(Boolean).map((segment) => decodeURIComponent(segment));
    if (segments[0] !== "browser") return json({ error: "not found", code: "not_found" }, 404);
    if (segments[1] === "agent-grants") return agentGrantHttp(req, manager, segments.slice(2));
    if (segments[1] !== "sessions") return json({ error: "not found", code: "not_found" }, 404);
    const id = segments[2];
    if (!id) {
      if (req.method === "GET" && segments.length === 2) return json({ sessions: await manager.listActive() }, 200);
      if (req.method !== "POST" || segments.length !== 2) return json({ error: "not found", code: "not_found" }, 404);
      const body = await readJson(req);
      if (!isRecord(body)) return json({ error: "The request body must be an object.", code: "invalid_request" }, 400);
      const unknown = Object.keys(body).filter((key) => key !== "origins");
      if (unknown.length > 0) return json({ error: "Unsupported browser session field.", code: "invalid_request" }, 400);
      const origins = body.origins === undefined ? [] : body.origins;
      if (!Array.isArray(origins) || origins.some((origin) => typeof origin !== "string")) {
        return json({ error: "Approved origins must be a list of origins.", code: "invalid_request" }, 400);
      }
      const session = await manager.create(origins);
      return json(session, 201);
    }
    if (segments.length === 3 && req.method === "GET") return json(await manager.inspect(id), 200);
    if (segments.length === 4 && segments[3] === "navigate" && req.method === "POST") {
      const body = await readJson(req);
      if (!isRecord(body) || typeof body.url !== "string" || Object.keys(body).some((key) => key !== "url")) {
        return json({ error: "Navigation requires a url.", code: "invalid_request" }, 400);
      }
      return json(await manager.navigate(id, body.url), 200);
    }
    if (segments.length === 4 && segments[3] === "observation" && req.method === "GET") return json(await manager.observe(id), 200);
    if (segments.length === 4 && segments[3] === "screenshot" && req.method === "GET") {
      const bytes = await manager.screenshot(id);
      return new Response(Buffer.from(bytes), {
        status: 200,
        headers: {
          "content-type": "image/png",
          "content-security-policy": "sandbox; default-src 'none'",
          "x-content-type-options": "nosniff",
          "cache-control": "no-store",
        },
      });
    }
    if (segments.length === 4 && segments[3] === "back" && req.method === "POST") return json(await manager.back(id), 200);
    if (segments.length === 4 && segments[3] === "close" && req.method === "POST") return json(await manager.close(id), 200);
    if (segments.length === 6 && segments[3] === "links" && segments[5] === "open" && req.method === "POST") {
      const body = await readJson(req);
      if (!isRecord(body) || typeof body.observationId !== "string" || Object.keys(body).some((key) => key !== "observationId")) {
        return json({ error: "Link navigation requires the current observation.", code: "invalid_request" }, 400);
      }
      return json(await manager.openLink(id, body.observationId, segments[4] ?? ""), 200);
    }
    return json({ error: "not found", code: "not_found" }, 404);
  } catch (error) {
    console.error("[browser-http] Error handling request:", error);
    if (error instanceof BrowserSessionError) return json({ error: error.message, code: error.code }, error.status);
    if (error instanceof URIError) return json({ error: "Invalid path.", code: "invalid_request" }, 400);
    return json({ error: "The browser session failed.", code: "browser_crashed" }, 500);
  }
}

async function readJson(req: Request): Promise<unknown> {
  const text = await req.text();
  if (Buffer.byteLength(text) > BODY_BYTES) throw new BrowserSessionError("The request body is too large.", 400, "invalid_request");
  if (!text.trim()) return {};
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new BrowserSessionError("The request body must be JSON.", 400, "invalid_request");
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function json(body: unknown, status: number): Response {
  return Response.json(body, { status, headers: { "cache-control": "no-store" } });
}

async function agentGrantHttp(req: Request, manager: BrowserSessionManager, segments: string[]): Promise<Response> {
  const grants = await loadBrowserAgentGrants();
  const id = segments[0];
  if (!id && req.method === "POST" && segments.length === 0) return createAgentGrant(req, manager, grants);
  if (id && segments.length === 1 && isBrowserGrantId(id) && req.method === "GET") {
    const target = targetFromUrl(new URL(req.url));
    if (!target.ok) return json({ error: target.error }, target.status);
    const got = grants.get(target.value, id);
    if (!got.ok) return json({ error: got.error }, got.status);
    return json(got.value, 200);
  }
  if (id && segments.length === 1 && isBrowserGrantId(id) && req.method === "DELETE") {
    const target = targetFromUrl(new URL(req.url));
    if (!target.ok) return json({ error: target.error }, target.status);
    const revoked = grants.revoke(target.value, id);
    if (!revoked.ok) return json({ error: revoked.error }, revoked.status);
    return json(revoked.value, 200);
  }
  return json({ error: "not found", code: "not_found" }, 404);
}

async function createAgentGrant(req: Request, manager: BrowserSessionManager, grants: BrowserAgentGrantService): Promise<Response> {
  const body = await readJson(req);
  if (!isRecord(body)) return json({ error: "The request body must be an object.", code: "invalid_request" }, 400);
  const unknown = Object.keys(body).filter((key) => key !== "managerKind" && key !== "projectPath" && key !== "sessionId");
  if (unknown.length > 0) return json({ error: "Unsupported browser permission field.", code: "invalid_request" }, 400);
  const target = targetFromBody(body);
  if (!target.ok) return json({ error: target.error }, target.status);
  if (target.value.managerKind === "project-manager") {
    const { projects } = await import("./db.ts");
    if (!projects.get(target.value.projectPath)) return json({ error: "That project is not registered.", code: "not_found" }, 404);
  }
  if (!isBrowserSessionId(body.sessionId)) return json({ error: "Unknown browser session.", code: "not_found" }, 404);
  const session = await manager.inspect(body.sessionId);
  if (session.state !== "active") return json({ error: "The browser session is not running.", code: "session_closed" }, 409);
  const observation = await manager.observe(body.sessionId);
  const created = grants.approve(target.value, body.sessionId, session.approvedOrigins, observation);
  if (!created.ok) return json({ error: created.error }, created.status);
  return json(created.value, 201);
}

function targetFromBody(body: Record<string, unknown>): { ok: true; value: BrowserAgentTarget } | { ok: false; status: number; error: string } {
  if (body.managerKind === "head-of-pm") {
    if (body.projectPath != null) return { ok: false, status: 400, error: "Head of PM browser access is not tied to one project." };
    return { ok: true, value: { managerKind: "head-of-pm", projectPath: null } };
  }
  if (body.managerKind === "project-manager") {
    const checked = validateProjectPath(body.projectPath);
    if (!checked.ok) return { ok: false, status: 400, error: checked.error };
    return { ok: true, value: { managerKind: "project-manager", projectPath: checked.path } };
  }
  return { ok: false, status: 400, error: "Browser access can be allowed for Head of PM or a Project Manager." };
}

function targetFromUrl(url: URL): { ok: true; value: BrowserAgentTarget } | { ok: false; status: number; error: string } {
  return targetFromBody({
    managerKind: url.searchParams.get("managerKind"),
    projectPath: url.searchParams.get("projectPath"),
  });
}
