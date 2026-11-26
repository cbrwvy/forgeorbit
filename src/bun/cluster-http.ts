/**
 * Cluster HTTP API, mounted by the existing Bun server.
 * Bearer auth is required before a body is read. Query tokens are not accepted.
 */

import { ClusterCore, ClusterCoreError } from "./cluster-core.ts";
import { db } from "./db.ts";
import { buildPortfolioSnapshot } from "./portfolio-adapter.ts";
import { FORGEORBIT_COMPANY } from "../shared/clusters/types.ts";
import type { PortfolioSnapshotInput } from "../shared/portfolio/types.ts";

const MAX_BODY_BYTES = 16 * 1024;

export interface ClusterHttpDeps {
  core?: ClusterCore;
  snapshot?: () => PortfolioSnapshotInput;
}

async function readBody(req: Request): Promise<unknown> {
  if (!req.body) throw new ClusterCoreError("JSON body required.");
  const reader = req.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const part = await reader.read();
      if (part.done) break;
      size += part.value.length;
      if (size > MAX_BODY_BYTES) {
        await reader.cancel();
        throw new ClusterCoreError("Body too large.", 413);
      }
      chunks.push(part.value);
    }
    const bytes = new Uint8Array(size);
    let offset = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, offset);
      offset += chunk.length;
    }
    try {
      return JSON.parse(new TextDecoder().decode(bytes));
    } catch {
      throw new ClusterCoreError("Invalid JSON.");
    }
  } finally {
    reader.releaseLock();
  }
}

function projectPathFromBody(value: unknown): unknown {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new ClusterCoreError("Expected an object.");
  const record = value as Record<string, unknown>;
  if (Object.keys(record).length !== 1 || !("projectPath" in record)) throw new ClusterCoreError("Expected projectPath.");
  return record.projectPath;
}

export async function clusterHttp(req: Request, bearerAuthorized: boolean, deps: ClusterHttpDeps = {}): Promise<Response> {
  const reply = (value: unknown, status = 200) => Response.json(value, { status });
  if (!bearerAuthorized) return reply({ error: "unauthorized" }, 401);
  try {
    const core = deps.core ?? new ClusterCore(db);
    const url = new URL(req.url);
    const segments = url.pathname.split("/").filter(Boolean).map((segment) => {
      try {
        return decodeURIComponent(segment);
      } catch {
        throw new ClusterCoreError("Invalid path.");
      }
    });
    if (segments[0] !== "clusters" || segments.length > 4) return reply({ error: "not found" }, 404);
    const method = req.method;
    const id = segments[1];
    const child = segments[2];
    const tail = segments[3];

    if (!id) {
      if (method === "GET") {
        const archived = url.searchParams.get("archived") === "true";
        const slug = url.searchParams.get("slug");
        return reply({ company: FORGEORBIT_COMPANY, clusters: core.list({ includeArchived: archived, slug }) });
      }
      if (method === "POST") return reply(core.create(await readBody(req)), 201);
      return reply({ error: "not found" }, 404);
    }

    if (id === "unassigned-projects" && !child && method === "GET") return reply(core.listUnassigned());
    if (id === "membership" && !child && method === "GET") {
      return reply(core.resolve(url.searchParams.get("path") ?? ""));
    }
    if (id === "unassigned-projects" || id === "membership") return reply({ error: "not found" }, 404);

    if (!child) {
      if (method === "GET") return reply(core.get(id));
      if (method === "PATCH") return reply(core.update(id, await readBody(req)));
      if (method === "DELETE") return reply(core.archive(id));
      return reply({ error: "not found" }, 404);
    }

    if (child === "summary" && !tail && method === "GET") {
      core.get(id);
      let snapshot: PortfolioSnapshotInput | null = null;
      try {
        snapshot = (deps.snapshot ?? (() => buildPortfolioSnapshot().snapshot))();
      } catch {
        snapshot = null;
      }
      return reply(core.summary(id, snapshot));
    }

    if (child === "projects" && !tail) {
      if (method === "GET") return reply(core.listProjects(id));
      if (method === "POST") return reply(core.assign(id, projectPathFromBody(await readBody(req))), 201);
      if (method === "DELETE") {
        const queryPath = url.searchParams.get("path");
        if (!queryPath) throw new ClusterCoreError("Expected projectPath.");
        return reply(core.unassign(id, queryPath));
      }
      return reply({ error: "not found" }, 404);
    }

    if (child === "projects" && tail === "move" && method === "POST") {
      return reply(core.move(id, projectPathFromBody(await readBody(req))));
    }

    if (child === "projects" && tail && tail !== "move" && method === "DELETE") {
      const queryPath = url.searchParams.get("path");
      if (queryPath != null && queryPath !== tail) throw new ClusterCoreError("projectPath does not match.");
      return reply(core.unassign(id, queryPath ?? tail));
    }

    return reply({ error: "not found" }, 404);
  } catch (error) {
    const status = error instanceof ClusterCoreError ? error.status : 500;
    const message = error instanceof ClusterCoreError ? error.message : "Cluster operation failed.";
    return reply({ error: message }, status);
  }
}
