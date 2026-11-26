/**
 * Knowledge HTTP API, mounted by the existing Bun server.
 * Bearer auth is required before a body is read. Query tokens are not accepted.
 * Clients cannot name a filesystem path for a Markdown file.
 */

import path from "node:path";
import {
  KNOWLEDGE_LIMITS,
  isKnowledgeDocumentId,
  knowledgeExportFilename,
  parseKnowledgeCreate,
  parseKnowledgeDelete,
  parseKnowledgeOwnerQuery,
  parseKnowledgeRevisionBody,
  parseKnowledgeUpdate,
  parseResultLimit,
  parseSearchQuery,
} from "../shared/knowledge/document.ts";
import {
  KNOWLEDGE_CONTEXT_LIMITS,
  isGrantId,
  parseContextRequest,
  parseContextTarget,
} from "../shared/knowledge/context.ts";
import { KnowledgeCore } from "./knowledge-core.ts";
import { KnowledgeError } from "./knowledge-error.ts";
import { loadKnowledgeContext, type ContextResult, type KnowledgeContextService } from "./knowledge-context.ts";
import { loadEffectiveKnowledgeForProject } from "./knowledge-effective.ts";
import {
  getProjectInheritanceSettings,
  setProjectInheritanceSettings,
  setDocumentInheritToProjects,
} from "./knowledge-inheritance-store.ts";
import { resolveProject } from "./environment/http.ts";

export interface KnowledgeHttpDeps {
  core?: KnowledgeCore;
  context?: KnowledgeContextService;
}

let defaultCore: KnowledgeCore | null = null;

async function coreFor(deps: KnowledgeHttpDeps): Promise<KnowledgeCore> {
  if (deps.core) return deps.core;
  if (defaultCore) return defaultCore;
  const [{ db, dataDir }, { KnowledgeCore: Core }, { createKnowledgeFiles: files }] = await Promise.all([
    import("./db.ts"),
    import("./knowledge-core.ts"),
    import("./knowledge-files.ts"),
  ]);
  defaultCore = new Core(db, files(path.join(dataDir, "knowledge")));
  return defaultCore;
}

export async function knowledgeHttp(req: Request, bearerAuthorized: boolean, deps: KnowledgeHttpDeps = {}): Promise<Response> {
  const response = await handleKnowledge(req, bearerAuthorized, deps);
  response.headers.set("cache-control", "no-store");
  return response;
}

async function handleKnowledge(req: Request, bearerAuthorized: boolean, deps: KnowledgeHttpDeps): Promise<Response> {
  if (!bearerAuthorized) return Response.json({ error: "unauthorized" }, { status: 401 });
  try {
    const core = await coreFor(deps);
    const url = new URL(req.url);
    rejectPathQuery(url);
    const segments = url.pathname.split("/").filter(Boolean).map((segment) => {
      try {
        return decodeURIComponent(segment);
      } catch {
        throw new KnowledgeError("Invalid path.", 400);
      }
    });
    if (segments[0] !== "knowledge") return Response.json({ error: "not found" }, { status: 404 });
    const method = req.method;
    const head = segments[1];
    if (head === "search" && segments.length === 2 && method === "GET") return Response.json(search(core, url));
    if (head === "scope" && segments.length === 2 && method === "GET") {
      const projectPath = url.searchParams.get("projectPath");
      if (!projectPath) throw new KnowledgeError("projectPath is required.", 400);
      return Response.json(core.scope(projectPath));
    }
    if (head === "context") return await handleContext(req, url, segments, deps);
    if (head === "effective" && segments.length === 2 && method === "GET") {
      const projectPath = url.searchParams.get("projectPath");
      if (!projectPath) throw new KnowledgeError("projectPath is required.", 400);
      const resolved = resolveProject(projectPath);
      if (!resolved.ok) throw new KnowledgeError(resolved.error, resolved.status);
      const bundle = await loadEffectiveKnowledgeForProject(resolved.path);
      if (!bundle) throw new KnowledgeError("Project is not registered.", 404);
      return Response.json({
        preview: bundle.preview,
        note: "This is the exact resolver output used for new PM replies and new task launches.",
      });
    }
    if (head === "inheritance" && segments.length === 2) {
      const projectPath = url.searchParams.get("projectPath");
      if (!projectPath) throw new KnowledgeError("projectPath is required.", 400);
      const resolved = resolveProject(projectPath);
      if (!resolved.ok) throw new KnowledgeError(resolved.error, resolved.status);
      if (method === "GET") {
        return Response.json({ settings: getProjectInheritanceSettings((await import("./db.ts")).db, resolved.path) });
      }
      if (method === "PATCH") {
        const body = await readBody(req) as { acceptCompany?: unknown; acceptCluster?: unknown };
        const settings = setProjectInheritanceSettings(
          (await import("./db.ts")).db,
          resolved.path,
          {
            acceptCompany: body.acceptCompany === true ? true : body.acceptCompany === false ? false : undefined,
            acceptCluster: body.acceptCluster === true ? true : body.acceptCluster === false ? false : undefined,
          },
          Date.now(),
        );
        return Response.json({ settings });
      }
    }
    if (head !== "documents") return Response.json({ error: "not found" }, { status: 404 });
    const id = segments[2];
    const action = segments[3];
    if (segments.length > 4) return Response.json({ error: "not found" }, { status: 404 });
    if (!id) {
      if (method === "GET") return Response.json(list(core, url));
      if (method === "POST") return Response.json(create(core, await readBody(req)), { status: 201 });
      return Response.json({ error: "not found" }, { status: 404 });
    }
    if (!isKnowledgeDocumentId(id)) throw new KnowledgeError("Invalid document id.", 400);
    if (!action) {
      if (method === "GET") return read(core, id, url);
      if (method === "PATCH") return Response.json(update(core, id, await readBody(req)));
      if (method === "DELETE") {
        const parsed = parseKnowledgeDelete(await readBody(req));
        if (!parsed.ok) throw new KnowledgeError(parsed.error, parsed.status);
        core.remove(id, parsed.value.expectedRevision);
        return Response.json({ deleted: true, id });
      }
      return Response.json({ error: "not found" }, { status: 404 });
    }
    if (segments.length !== 4) return Response.json({ error: "not found" }, { status: 404 });
    if (action === "export" && method === "GET") return exportDocument(core, id, url);
    if (action === "inherit" && method === "PATCH") {
      const body = await readBody(req) as { inheritToProjects?: unknown };
      if (typeof body.inheritToProjects !== "boolean") throw new KnowledgeError("inheritToProjects must be a boolean.", 400);
      const row = core.read(id);
      if (row.owner.kind === "project") throw new KnowledgeError("Project notes are always local; sharing applies to company and cluster notes.", 400);
      setDocumentInheritToProjects((await import("./db.ts")).db, id, body.inheritToProjects);
      return Response.json(core.read(id));
    }
    if (action === "revisions" && method === "GET") return Response.json({ revisions: core.revisions(id) });
    if ((action === "archive" || action === "restore") && method === "POST") {
      const parsed = parseKnowledgeRevisionBody(await readBody(req));
      if (!parsed.ok) throw new KnowledgeError(parsed.error, parsed.status);
      const document = action === "archive"
        ? core.archive(id, parsed.value.expectedRevision)
        : core.restore(id, parsed.value.expectedRevision);
      return Response.json(document);
    }
    return Response.json({ error: "not found" }, { status: 404 });
  } catch (error) {
    const status = error instanceof KnowledgeError ? error.status : 500;
    const message = error instanceof KnowledgeError ? error.message : "Knowledge operation failed.";
    return Response.json({ error: message }, { status });
  }
}

/**
 * Context for AI managers (FO-011E). Every answer is metadata. Markdown is
 * read by the server when a manager turn consumes an approved grant; no route
 * here returns note text, accepts note text, or starts a model.
 */
async function handleContext(req: Request, url: URL, segments: string[], deps: KnowledgeHttpDeps): Promise<Response> {
  const service = deps.context ?? await loadKnowledgeContext();
  const method = req.method;
  const action = segments[2];
  const respond = <T>(result: ContextResult<T>, status = 200): Response =>
    result.ok
      ? Response.json(result.value, { status })
      : Response.json({ error: result.error, ...(result.issues ? { issues: result.issues } : {}) }, { status: result.status });
  const targetOf = () => {
    const parsed = parseContextTarget(url.searchParams.get("managerKind"), url.searchParams.get("projectPath"));
    if (!parsed.ok) throw new KnowledgeError(parsed.error, parsed.status);
    return parsed.value;
  };
  if (action === "eligible" && segments.length === 3 && method === "GET") {
    const kind = url.searchParams.get("ownerKind");
    const ownerId = url.searchParams.get("ownerId");
    let owner;
    if (kind || ownerId) {
      const parsed = parseKnowledgeOwnerQuery(kind, ownerId);
      if (!parsed.ok) throw new KnowledgeError(parsed.error, parsed.status);
      owner = parsed.value;
    }
    return respond(service.eligible(targetOf(), owner));
  }
  if (action === "preview" && segments.length === 3 && method === "POST") {
    const parsed = parseContextRequest(await readBody(req, KNOWLEDGE_CONTEXT_LIMITS.bodyBytes), "preview");
    if (!parsed.ok) throw new KnowledgeError(parsed.error, parsed.status);
    return respond(service.preview(parsed.value.target, parsed.value.documents));
  }
  if (action === "grants" && segments.length === 3 && method === "POST") {
    const parsed = parseContextRequest(await readBody(req, KNOWLEDGE_CONTEXT_LIMITS.bodyBytes), "approve");
    if (!parsed.ok) throw new KnowledgeError(parsed.error, parsed.status);
    return respond(service.approve(parsed.value.target, parsed.value.documents, parsed.value.previewKey!), 201);
  }
  if (action === "grants" && segments.length === 4 && method === "DELETE") {
    const grantId = segments[3]!;
    if (!isGrantId(grantId)) throw new KnowledgeError("Invalid grant id.", 400);
    return respond(service.revoke(targetOf(), grantId));
  }
  if (action === "transmissions" && segments.length === 3 && method === "GET") {
    return respond(service.transmissions(targetOf()));
  }
  return Response.json({ error: "not found" }, { status: 404 });
}

function list(core: KnowledgeCore, url: URL): { documents: ReturnType<KnowledgeCore["list"]>["documents"]; truncated: boolean } {
  const owner = parseKnowledgeOwnerQuery(url.searchParams.get("ownerKind"), url.searchParams.get("ownerId"));
  if (!owner.ok) throw new KnowledgeError(owner.error, owner.status);
  const limit = parseResultLimit(url.searchParams.get("limit"), KNOWLEDGE_LIMITS.listDefault, KNOWLEDGE_LIMITS.listLimit);
  if (!limit.ok) throw new KnowledgeError(limit.error, limit.status);
  return core.list(owner.value, {
    includeArchived: url.searchParams.get("includeArchived") === "true",
    category: url.searchParams.get("category"),
    tag: tagParam(url),
    limit: limit.value,
  });
}

function create(core: KnowledgeCore, body: unknown) {
  const parsed = parseKnowledgeCreate(body);
  if (!parsed.ok) throw new KnowledgeError(parsed.error, parsed.status);
  return core.create(parsed.value);
}

function update(core: KnowledgeCore, id: string, body: unknown) {
  const parsed = parseKnowledgeUpdate(body);
  if (!parsed.ok) throw new KnowledgeError(parsed.error, parsed.status);
  return core.update(id, parsed.value);
}

function read(core: KnowledgeCore, id: string, url: URL): Response {
  const raw = url.searchParams.get("revision");
  let revision: number | undefined;
  if (raw != null) {
    const parsed = parseResultLimit(raw, 1, 1_000_000_000);
    if (!parsed.ok) throw new KnowledgeError("Invalid revision.", 400);
    revision = parsed.value;
  }
  return Response.json(core.read(id, revision));
}

function search(core: KnowledgeCore, url: URL) {
  const query = parseSearchQuery(url.searchParams.get("q"));
  if (!query.ok) throw new KnowledgeError(query.error, query.status);
  const limit = parseResultLimit(url.searchParams.get("limit"), KNOWLEDGE_LIMITS.searchDefault, KNOWLEDGE_LIMITS.searchLimit);
  if (!limit.ok) throw new KnowledgeError(limit.error, limit.status);
  const projectPath = url.searchParams.get("projectPath");
  const kind = url.searchParams.get("ownerKind");
  const ownerId = url.searchParams.get("ownerId");
  if (projectPath && (kind || ownerId)) throw new KnowledgeError("Search one owner or one project scope, not both.", 400);
  const owner = projectPath ? undefined : parseKnowledgeOwnerQuery(kind, ownerId);
  if (owner && !owner.ok) throw new KnowledgeError(owner.error, owner.status);
  return core.search({
    query: query.value,
    owner: owner?.ok ? owner.value : undefined,
    projectPath: projectPath ?? undefined,
    includeArchived: url.searchParams.get("includeArchived") === "true",
    category: url.searchParams.get("category"),
    tag: tagParam(url),
    limit: limit.value,
  });
}

function exportDocument(core: KnowledgeCore, id: string, url: URL): Response {
  const raw = url.searchParams.get("revision");
  let revision: number | undefined;
  if (raw != null) {
    const parsed = parseResultLimit(raw, 1, 1_000_000_000);
    if (!parsed.ok) throw new KnowledgeError("Invalid revision.", 400);
    revision = parsed.value;
  }
  const document = core.read(id, revision);
  const filename = knowledgeExportFilename(document.title);
  if (url.searchParams.get("format") === "markdown") {
    const ascii = filename.replace(/[^\x20-\x7e]/g, "_").replace(/["\\]/g, "_");
    return new Response(document.content, {
      status: 200,
      headers: {
        "content-type": "text/markdown; charset=utf-8",
        "content-disposition": `attachment; filename="${ascii}"`,
        "x-content-type-options": "nosniff",
        "content-security-policy": "sandbox; default-src 'none'",
      },
    });
  }
  return Response.json({
    filename,
    markdown: document.content,
    revision: revision ?? document.revision,
    document: {
      id: document.id,
      owner: document.owner,
      title: document.title,
      description: document.description,
      category: document.category,
      tags: document.tags,
      sensitive: document.sensitive,
      revision: document.revision,
      createdAt: document.createdAt,
      updatedAt: document.updatedAt,
      archivedAt: document.archivedAt,
      byteLength: document.byteLength,
    },
  });
}

function tagParam(url: URL): string | null {
  const raw = url.searchParams.get("tag");
  if (!raw) return null;
  const tag = raw.trim().toLowerCase();
  return tag.length > 0 ? tag : null;
}

function rejectPathQuery(url: URL): void {
  for (const key of url.searchParams.keys()) {
    const name = key.toLowerCase();
    if (name === "projectpath" || name === "ownerkind" || name === "ownerid" || name === "managerkind") continue;
    if (name.includes("path") || name === "file" || name === "filename") {
      throw new KnowledgeError("A document path cannot be set by the client.", 400);
    }
  }
}

async function readBody(req: Request, maxBytes: number = KNOWLEDGE_LIMITS.bodyBytes): Promise<unknown> {
  if (!req.body) throw new KnowledgeError("JSON body required.", 400);
  const reader = req.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const part = await reader.read();
      if (part.done) break;
      size += part.value.byteLength;
      if (size > maxBytes) {
        await reader.cancel();
        throw new KnowledgeError("Body too large.", 413);
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
    throw new KnowledgeError("Invalid JSON.", 400);
  }
}
