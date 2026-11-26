/**
 * FO-NATIVE-CU01 Owner API. Every route requires the existing bearer token.
 * There is no shell, AppleScript, coordinate, or arbitrary accessibility action.
 */

import { NativeComputerError } from "./native-computer-error.ts";
import { defaultNativeComputerSessionManager, type NativeComputerSessionManager } from "./native-computer-session.ts";
import { loadNativeAgentGrants, type NativeAgentGrantService } from "./native-computer-agent.ts";
import { isNativeGrantId, isNativeSessionId, type NativeAgentTarget } from "../shared/native-computer/agent.ts";
import { isClaimId, isSessionId, parseIdentity } from "../shared/native-computer/policy.ts";
import { OPEN_MENU_ACTION, PRESS_ACTION, SCROLL_ACTION, SELECT_MENU_ITEM_ACTION, SELECT_TAB_ACTION, SET_TEXT_ACTION } from "../shared/native-computer/types.ts";
import { validateProjectPath } from "../shared/clusters/paths.ts";

export interface NativeComputerHttpDeps {
  manager?: NativeComputerSessionManager;
}

const BODY_BYTES = 16_384;

export async function nativeComputerHttp(req: Request, bearerAuthorized: boolean, deps: NativeComputerHttpDeps = {}): Promise<Response> {
  if (!bearerAuthorized) return json({ error: "unauthorized", code: "unauthorized" }, 401);
  try {
    const manager = deps.manager ?? await defaultNativeComputerSessionManager();
    const url = new URL(req.url);
    const segments = url.pathname.split("/").filter(Boolean).map((segment) => decodeURIComponent(segment));
    if (segments[0] !== "native-computer") return json({ error: "not found", code: "not_found" }, 404);
    if (segments[1] === "permissions" && segments.length === 2 && req.method === "GET") return json(await manager.permissions(), 200);
    if (segments[1] === "permissions" && segments[2] === "open" && segments.length === 3 && req.method === "POST") {
      const body = await readJson(req);
      if (!isRecord(body) || (body.kind !== "accessibility" && body.kind !== "screen-recording") || Object.keys(body).some((key) => key !== "kind")) {
        return json({ error: "Choose Accessibility or Screen Recording settings.", code: "invalid_request" }, 400);
      }
      return json(await manager.openSettings(body.kind), 200);
    }
    if (segments[1] === "applications" && segments.length === 2 && req.method === "GET") return json(await manager.listApplications(), 200);
    if (segments[1] === "windows" && segments.length === 2 && req.method === "POST") {
      const body = await readJson(req);
      const identity = identityFrom(body);
      if (!identity) return json({ error: "The application identity was not valid.", code: "invalid_request" }, 400);
      return json(await manager.listWindows(identity), 200);
    }
    if (segments[1] === "agent-grants") return await nativeAgentGrantHttp(req, manager, segments.slice(2));
    if (segments[1] !== "sessions") return json({ error: "not found", code: "not_found" }, 404);
    if (!segments[2]) {
      if (req.method === "GET") {
        return json({ sessions: await manager.listActive(), lastInterrupted: await manager.lastInterrupted() }, 200);
      }
      if (req.method !== "POST") return json({ error: "not found", code: "not_found" }, 404);
      const body = await readJson(req);
      const identity = identityFrom(body);
      const windowId = isRecord(body) ? windowIdFrom(body.windowId) : null;
      if (!identity || windowId === null || !onlyKeys(body, ["bundleId", "executablePath", "pid", "startSec", "startUsec", "windowId", "displayName"])) {
        return json({ error: "A native session needs an application and a window.", code: "invalid_request" }, 400);
      }
      return json(await manager.create(identity, windowId), 201);
    }
    const id = segments[2];
    if (!isSessionId(id)) return json({ error: "That native session was not found.", code: "not_found" }, 404);
    if (segments.length === 3 && req.method === "GET") return json(await manager.inspect(id), 200);
    if (segments.length === 4 && segments[3] === "observation" && req.method === "GET") {
      const current = await manager.currentObservation(id);
      if (!current) return json({ error: "No observation has been captured for this session yet.", code: "not_found" }, 404);
      return json(current, 200);
    }
    if (segments.length === 4 && segments[3] === "observation" && req.method === "POST") return json(await manager.observe(id), 200);
    if (segments.length === 4 && segments[3] === "screenshot" && req.method === "POST") {
      const captured = await manager.captureScreenshot(id);
      if (captured.info.state !== "available" || !captured.bytes) {
        return json({ error: "No screenshot is available.", code: captured.info.state === "permission_required" ? "screen_recording_denied" : "screenshot_unavailable", screenshot: captured.info }, captured.info.state === "permission_required" ? 403 : 409);
      }
      return new Response(Buffer.from(captured.bytes), { status: 200, headers: pngHeaders() });
    }
    if (segments.length === 4 && segments[3] === "screenshot" && req.method === "GET") {
      const bytes = await manager.screenshotBytes(id);
      return new Response(Buffer.from(bytes), { status: 200, headers: pngHeaders() });
    }
    if (segments.length === 4 && segments[3] === "close" && req.method === "POST") return json(await manager.close(id), 200);
    if (segments.length === 4 && segments[3] === "actions" && req.method === "POST") {
      const body = await readJson(req);
      const identity = identityFrom(body);
      const windowId = isRecord(body) ? windowIdFrom(body.windowId) : null;
      const action = isRecord(body) ? body.action : null;
      const validAction = action === PRESS_ACTION || action === SCROLL_ACTION || action === SELECT_TAB_ACTION || action === SET_TEXT_ACTION || action === OPEN_MENU_ACTION || action === SELECT_MENU_ITEM_ACTION;
      const allowedKeys = ["observationId", "elementId", "action", "bundleId", "executablePath", "pid", "startSec", "startUsec", "windowId", "direction", "increment", "text", "displayName"];
      if (!isRecord(body) || !identity || windowId === null || typeof body.observationId !== "string" || typeof body.elementId !== "string" || !validAction || !onlyKeys(body, allowedKeys)) {
        return json({ error: "The action confirmation was not valid.", code: "invalid_request" }, 400);
      }
      const direction = body.direction === "up" || body.direction === "down" ? body.direction : undefined;
      const increment = typeof body.increment === "number" ? body.increment : undefined;
      const text = typeof body.text === "string" ? body.text : undefined;
      return json(await manager.requestAction(id, { observationId: body.observationId, elementId: body.elementId, action, direction, increment, text, identity, windowId }), 201);
    }
    if (segments.length === 6 && segments[3] === "actions" && segments[5] === "confirm" && req.method === "POST") {
      if (!isClaimId(segments[4] ?? "")) return json({ error: "That action confirmation was not found.", code: "not_found" }, 404);
      const body = await readJson(req);
      const identity = identityFrom(body);
      const windowId = isRecord(body) ? windowIdFrom(body.windowId) : null;
      if (!isRecord(body) || body.confirm !== true || !identity || windowId === null || !onlyKeys(body, ["confirm", "bundleId", "executablePath", "pid", "startSec", "startUsec", "windowId", "displayName"])) {
        return json({ error: "Confirm the application, window, and action together.", code: "invalid_request" }, 400);
      }
      return json(await manager.confirmAction(id, segments[4] ?? "", { identity, windowId }), 200);
    }
    return json({ error: "not found", code: "not_found" }, 404);
  } catch (error) {
    if (error instanceof NativeComputerError) return json({ error: error.message, code: error.code }, error.status);
    if (error instanceof URIError) return json({ error: "Invalid path.", code: "invalid_request" }, 400);
    return json({ error: "The native session failed.", code: "helper_failed" }, 500);
  }
}

function identityFrom(body: unknown): ReturnType<typeof parseIdentity> {
  if (!isRecord(body)) return null;
  return parseIdentity(body);
}

function windowIdFrom(value: unknown): number | null {
  return typeof value === "number" && Number.isInteger(value) && value > 0 && value <= 4_294_967_295 ? value : null;
}

function onlyKeys(body: unknown, keys: string[]): boolean {
  return isRecord(body) && Object.keys(body).every((key) => keys.includes(key));
}

async function readJson(req: Request): Promise<unknown> {
  const text = await req.text();
  if (Buffer.byteLength(text) > BODY_BYTES) throw new NativeComputerError("The request body is too large.", 400, "invalid_request");
  if (!text.trim()) return {};
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new NativeComputerError("The request body must be JSON.", 400, "invalid_request");
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function json(body: unknown, status: number): Response {
  return Response.json(body, { status, headers: { "cache-control": "no-store" } });
}

function pngHeaders(): HeadersInit {
  return {
    "content-type": "image/png",
    "content-security-policy": "sandbox; default-src 'none'",
    "x-content-type-options": "nosniff",
    "cache-control": "no-store",
  };
}

async function nativeAgentGrantHttp(req: Request, manager: NativeComputerSessionManager, segments: string[]): Promise<Response> {
  const grants = await loadNativeAgentGrants();
  const id = segments[0];
  if (!id && req.method === "POST" && segments.length === 0) return await createNativeAgentGrant(req, manager, grants);
  if (id && segments.length === 1 && isNativeGrantId(id) && req.method === "GET") {
    const target = targetFromUrl(new URL(req.url));
    if (!target.ok) return json({ error: target.error }, target.status);
    const got = grants.get(target.value, id);
    if (!got.ok) return json({ error: got.error }, got.status);
    return json(got.value, 200);
  }
  if (id && segments.length === 1 && isNativeGrantId(id) && req.method === "DELETE") {
    const target = targetFromUrl(new URL(req.url));
    if (!target.ok) return json({ error: target.error }, target.status);
    const revoked = grants.revoke(target.value, id);
    if (!revoked.ok) return json({ error: revoked.error }, revoked.status);
    return json(revoked.value, 200);
  }
  return json({ error: "not found", code: "not_found" }, 404);
}

async function createNativeAgentGrant(req: Request, manager: NativeComputerSessionManager, grants: NativeAgentGrantService): Promise<Response> {
  const body = await readJson(req);
  if (!isRecord(body)) return json({ error: "The request body must be an object.", code: "invalid_request" }, 400);
  const unknown = Object.keys(body).filter((key) => key !== "managerKind" && key !== "projectPath" && key !== "sessionId");
  if (unknown.length > 0) return json({ error: "Unsupported native permission field.", code: "invalid_request" }, 400);
  const target = targetFromBody(body);
  if (!target.ok) return json({ error: target.error }, target.status);
  if (target.value.managerKind === "project-manager") {
    const { projects } = await import("./db.ts");
    if (!projects.get(target.value.projectPath)) return json({ error: "That project is not registered.", code: "not_found" }, 404);
  }
  if (!isNativeSessionId(body.sessionId)) return json({ error: "Unknown native session.", code: "not_found" }, 404);
  const session = await manager.inspect(body.sessionId);
  if (session.status !== "active") return json({ error: "The native session is not running.", code: "session_closed" }, 409);
  const observation = await manager.observe(body.sessionId);
  const created = grants.approve(target.value, body.sessionId, observation);
  if (!created.ok) return json({ error: created.error }, created.status);
  return json(created.value, 201);
}

function targetFromBody(body: Record<string, unknown>): { ok: true; value: NativeAgentTarget } | { ok: false; status: number; error: string } {
  if (body.managerKind === "head-of-pm") {
    if (body.projectPath != null) return { ok: false, status: 400, error: "Head of PM native access is not tied to one project." };
    return { ok: true, value: { managerKind: "head-of-pm", projectPath: null } };
  }
  if (body.managerKind === "project-manager") {
    const checked = validateProjectPath(body.projectPath);
    if (!checked.ok) return { ok: false, status: 400, error: checked.error };
    return { ok: true, value: { managerKind: "project-manager", projectPath: checked.path } };
  }
  return { ok: false, status: 400, error: "Native access can be allowed for Head of PM or a Project Manager." };
}

function targetFromUrl(url: URL): { ok: true; value: NativeAgentTarget } | { ok: false; status: number; error: string } {
  return targetFromBody({
    managerKind: url.searchParams.get("managerKind"),
    projectPath: url.searchParams.get("projectPath"),
  });
}
