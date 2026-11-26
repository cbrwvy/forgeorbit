/**
 * Infrastructure HTTP API, mounted by the existing Bun server.
 * Bearer auth is required before a body is read. Query tokens are not accepted.
 * There is no route that opens a shell, a container runtime, or a network probe.
 */

import { InfrastructureCore, InfrastructureError } from "./infrastructure-core.ts";

const MAX_BODY_BYTES = 32 * 1024;

export interface InfrastructureHttpDeps {
  core?: InfrastructureCore;
}

let defaultCore: InfrastructureCore | null = null;

async function coreFor(deps: InfrastructureHttpDeps): Promise<InfrastructureCore> {
  if (deps.core) return deps.core;
  if (defaultCore) return defaultCore;
  const { db } = await import("./db.ts");
  defaultCore = new InfrastructureCore(db);
  return defaultCore;
}

async function readBody(req: Request): Promise<unknown> {
  if (!req.body) throw new InfrastructureError("JSON body required.");
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
        throw new InfrastructureError("Body too large.", 413);
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
    throw new InfrastructureError("Invalid JSON.");
  }
}

export async function infrastructureHttp(
  req: Request,
  bearerAuthorized: boolean,
  deps: InfrastructureHttpDeps = {},
): Promise<Response> {
  if (!bearerAuthorized) return json({ error: "unauthorized" }, 401);
  try {
    return await handle(req, await coreFor(deps));
  } catch (error) {
    const status = error instanceof InfrastructureError ? error.status : 500;
    const message = error instanceof InfrastructureError ? error.message : "Infrastructure operation failed.";
    return json({ error: message }, status);
  }
}

async function handle(req: Request, core: InfrastructureCore): Promise<Response> {
  const url = new URL(req.url);
  const segments = url.pathname.split("/").filter(Boolean).map((segment) => {
    try {
      return decodeURIComponent(segment);
    } catch {
      throw new InfrastructureError("Invalid path.");
    }
  });
  if (segments[0] !== "infrastructure" || segments.length > 5) return json({ error: "not found" }, 404);
  const method = req.method;
  const head = segments[1];
  const id = segments[2];
  const action = segments[3];
  const tail = segments[4];

  if (head === "resources" && !id) {
    if (method === "GET") return json(core.list(url.searchParams));
    if (method === "POST") return json(core.create(await readBody(req)), 201);
    return json({ error: "not found" }, 404);
  }

  if (head === "resources" && id && !action) {
    if (method === "GET") return json(core.get(id));
    if (method === "PATCH") return json(core.update(id, await readBody(req)));
    return json({ error: "not found" }, 404);
  }

  if (head === "resources" && id && action && !tail) {
    if (action === "archive" && method === "POST") return json(core.archive(id));
    if (action === "restore" && method === "POST") return json(core.restore(id));
    if (action === "clusters" && method === "POST") return json(core.linkCluster(id, await readBody(req)), 201);
    if (action === "projects" && method === "POST") return json(core.linkProject(id, await readBody(req)), 201);
    if (action === "projects" && method === "DELETE") {
      const projectPath = url.searchParams.get("projectPath");
      if (!projectPath) throw new InfrastructureError("Expected projectPath.");
      return json(core.unlinkProject(id, projectPath));
    }
    if (action === "environment-links" && method === "POST") return json(core.linkEnvironment(id, await readBody(req)), 201);
    if (action === "environment-links" && method === "DELETE") {
      const projectPath = url.searchParams.get("projectPath");
      const environment = url.searchParams.get("environment");
      if (!projectPath || !environment) throw new InfrastructureError("Expected projectPath and environment.");
      return json(core.unlinkEnvironment(id, projectPath, environment, url.searchParams.get("customLabel") ?? ""));
    }
    return json({ error: "not found" }, 404);
  }

  if (head === "resources" && id && action === "clusters" && tail && method === "DELETE") {
    return json(core.unlinkCluster(id, tail));
  }

  if (head === "clusters" && id && !action && method === "GET") return json(core.clusterView(id));

  if (head === "project-environments" && !id) {
    if (method === "GET") {
      const projectPath = url.searchParams.get("projectPath");
      if (!projectPath) throw new InfrastructureError("Expected projectPath.");
      return json({ environments: core.listProjectEnvironments(projectPath) });
    }
    if (method === "POST") {
      const result = core.declareEnvironment(await readBody(req));
      return json(result.declaration, result.created ? 201 : 200);
    }
    if (method === "DELETE") {
      const projectPath = url.searchParams.get("projectPath");
      const environment = url.searchParams.get("environment");
      if (!projectPath || !environment) throw new InfrastructureError("Expected projectPath and environment.");
      core.removeEnvironment(projectPath, environment, url.searchParams.get("customLabel") ?? "");
      return json({ removed: true });
    }
  }

  return json({ error: "not found" }, 404);
}

function json(value: unknown, status = 200): Response {
  const response = Response.json(value, { status });
  response.headers.set("cache-control", "no-store");
  return response;
}
