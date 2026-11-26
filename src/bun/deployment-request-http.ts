/**
 * FO-DEPLOY01 HTTP API. Bearer auth required. No remote execution routes.
 */

import { DeploymentRequestCore, DeploymentRequestError } from "./deployment-request-core.ts";

const MAX_BODY_BYTES = 16 * 1024;

export interface DeploymentRequestHttpDeps {
  core?: DeploymentRequestCore;
}

let defaultCore: DeploymentRequestCore | null = null;

async function coreFor(deps: DeploymentRequestHttpDeps): Promise<DeploymentRequestCore> {
  if (deps.core) return deps.core;
  if (defaultCore) return defaultCore;
  const { db } = await import("./db.ts");
  defaultCore = new DeploymentRequestCore(db);
  return defaultCore;
}

async function readBody(req: Request): Promise<unknown> {
  if (!req.body) throw new DeploymentRequestError("JSON body required.");
  const reader = req.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const part = await reader.read();
      if (part.done) break;
      size += part.value.byteLength;
      if (size > MAX_BODY_BYTES) {
        await reader.cancel();
        throw new DeploymentRequestError("Body too large.", 413);
      }
      chunks.push(part.value);
    }
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try {
    return JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    throw new DeploymentRequestError("Invalid JSON.");
  }
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json; charset=utf-8" },
  });
}

export async function deploymentRequestHttp(
  req: Request,
  bearerAuthorized: boolean,
  deps: DeploymentRequestHttpDeps = {},
): Promise<Response> {
  if (!bearerAuthorized) return json({ error: "unauthorized" }, 401);
  try {
    return await handle(req, await coreFor(deps));
  } catch (error) {
    const status = error instanceof DeploymentRequestError ? error.status : 500;
    const message = error instanceof DeploymentRequestError ? error.message : "Deployment request failed.";
    const code = error instanceof DeploymentRequestError ? error.code : "error";
    return json({ error: message, code }, status);
  }
}

async function handle(req: Request, core: DeploymentRequestCore): Promise<Response> {
  const url = new URL(req.url);
  const segments = url.pathname.split("/").filter(Boolean).map((segment) => {
    try {
      return decodeURIComponent(segment);
    } catch {
      throw new DeploymentRequestError("Invalid path.");
    }
  });
  if (segments[0] !== "deployment-requests" || segments.length > 3) {
    return json({ error: "not found" }, 404);
  }
  const method = req.method;
  const id = segments[1];
  const action = segments[2];

  if (id && action === "manual-handoff" && method === "GET") {
    return json(core.manualHandoff(id));
  }

  if (!id) {
    if (method === "GET") {
      const projectPath = url.searchParams.get("projectPath");
      return json({ requests: core.list(projectPath ?? undefined) });
    }
    if (method === "POST") return json(core.create(await readBody(req)), 201);
    return json({ error: "not found" }, 404);
  }

  if (action === "approve" && method === "POST") {
    return json(core.approve(id, await readBody(req)));
  }
  if (action === "reject" && method === "POST") {
    return json(core.reject(id, await readBody(req)));
  }
  if (action === "authorize-execution" && method === "POST") {
    return json(core.authorizeExecution(id, await readBody(req)));
  }
  if (action === "execute" && method === "POST") {
    return json(await core.executeStaging(id));
  }
  if (action === "cancel-execution" && method === "POST") {
    return json(core.cancelExecution(id));
  }
  if (action === "reconcile-execution" && method === "POST") {
    return json(core.reconcileExecution(id));
  }
  if (!action) {
    if (method === "GET") return json(core.get(id));
    if (method === "PATCH") return json(core.patch(id, await readBody(req)));
    return json({ error: "not found" }, 404);
  }
  return json({ error: "not found" }, 404);
}
