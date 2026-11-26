/**
 * FO-DEPLOY02 — staging integration configuration HTTP API.
 */

import { StagingIntegrationCore, StagingIntegrationError } from "./deployment-staging-integration-core.ts";

const MAX_BODY_BYTES = 16 * 1024;

export interface StagingIntegrationHttpDeps {
  core?: StagingIntegrationCore;
}

let defaultCore: StagingIntegrationCore | null = null;

async function coreFor(deps: StagingIntegrationHttpDeps): Promise<StagingIntegrationCore> {
  if (deps.core) return deps.core;
  if (defaultCore) return defaultCore;
  const { db } = await import("./db.ts");
  defaultCore = new StagingIntegrationCore(db);
  return defaultCore;
}

async function readBody(req: Request): Promise<unknown> {
  if (!req.body) throw new StagingIntegrationError("JSON body required.");
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
        throw new StagingIntegrationError("Body too large.", 413);
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
    throw new StagingIntegrationError("Invalid JSON.");
  }
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json; charset=utf-8" },
  });
}

export async function stagingIntegrationHttp(
  req: Request,
  bearerAuthorized: boolean,
  deps: StagingIntegrationHttpDeps = {},
): Promise<Response> {
  if (!bearerAuthorized) return json({ error: "unauthorized" }, 401);
  try {
    return await handle(req, await coreFor(deps));
  } catch (error) {
    const status = error instanceof StagingIntegrationError ? error.status : 500;
    const message = error instanceof StagingIntegrationError ? error.message : "Staging integration failed.";
    const code = error instanceof StagingIntegrationError ? error.code : "error";
    return json({ error: message, code }, status);
  }
}

async function handle(req: Request, core: StagingIntegrationCore): Promise<Response> {
  const url = new URL(req.url);
  const segments = url.pathname.split("/").filter(Boolean).map((segment) => {
    try {
      return decodeURIComponent(segment);
    } catch {
      throw new StagingIntegrationError("Invalid path.");
    }
  });
  if (segments[0] !== "deployment-staging-integrations" || segments.length > 2) {
    return json({ error: "not found" }, 404);
  }
  const id = segments[1];
  if (!id) {
    if (req.method === "GET") {
      const projectPath = url.searchParams.get("projectPath");
      return json({ integrations: core.list(projectPath ?? undefined) });
    }
    if (req.method === "POST") return json(core.create(await readBody(req)), 201);
    return json({ error: "not found" }, 404);
  }
  if (req.method === "GET") return json(core.get(id));
  if (req.method === "DELETE") return json(core.delete(id));
  return json({ error: "not found" }, 404);
}
