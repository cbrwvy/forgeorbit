/**
 * Owner Brain HTTP API.
 *
 * Bearer auth is required before a body is read. Clients cannot name a
 * filesystem path for a memory file. Responses are data, not instructions.
 */

import {
  BRAIN_INHERITANCE_RULE,
  BRAIN_LIMITS,
  isBrainMemoryId,
  parseBrainArchive,
  parseBrainCreate,
  parseBrainListQuery,
  parseBrainUpdate,
} from "../shared/brain/document.ts";
import {
  BRAIN_CONTEXT_LIMITS,
  isBrainGrantId,
  parseBrainContextRequest,
  parseBrainContextTarget,
  parseBrainEligibleQuery,
} from "../shared/brain/context.ts";
import { loadBrainContext, type ContextResult } from "./brain-context.ts";
import { BrainError } from "./brain-error.ts";
import {
  approveMemoryProposal,
  editMemoryProposal,
  listMemoryProposals,
  readMemoryProposal,
  rejectMemoryProposal,
} from "./brain-proposals.ts";
import { brainDirectory, openBrainStore, type BrainStore } from "./brain-store.ts";
import {
  parseMemoryProposalDecision,
  parseMemoryProposalEdit,
  type MemoryProposalManager,
  type MemoryProposalStatus,
} from "../shared/brain/proposals.ts";
import {
  approveExtractionCandidate,
  editExtractionCandidate,
  listExtractionCandidates,
  readExtractionCandidate,
  rejectExtractionCandidate,
} from "./brain-extractor.ts";
import type { CandidateListQuery, CandidateStatus, ExtractionEventKind } from "../shared/brain/extraction.ts";
import type { SearchMode, SemanticSearchQuery } from "../shared/brain/embeddings.ts";

export interface BrainHttpDeps {
  store?: BrainStore;
}

let defaultStore: BrainStore | null = null;

async function storeFor(deps: BrainHttpDeps): Promise<BrainStore> {
  if (deps.store) return deps.store;
  if (defaultStore) return defaultStore;
  const { dataDir, projects } = await import("./db.ts");
  defaultStore = openBrainStore(brainDirectory(dataDir), {
    isRegistered(projectPath) {
      return projects.get(projectPath) != null;
    },
  });
  return defaultStore;
}

export async function brainHttp(req: Request, bearerAuthorized: boolean, deps: BrainHttpDeps = {}): Promise<Response> {
  const response = await handle(req, bearerAuthorized, deps);
  response.headers.set("cache-control", "no-store");
  return response;
}

async function handle(req: Request, bearerAuthorized: boolean, deps: BrainHttpDeps): Promise<Response> {
  if (!bearerAuthorized) return Response.json({ error: "unauthorized", code: "unauthorized" }, { status: 401 });
  try {
    const store = await storeFor(deps);
    const url = new URL(req.url);
    const segments = url.pathname.split("/").filter(Boolean).map((segment) => {
      try {
        return decodeURIComponent(segment);
      } catch {
        throw new BrainError("Invalid path.", 400, "invalid_request");
      }
    });
    if (segments[0] !== "brain") return Response.json({ error: "not found", code: "not_found" }, { status: 404 });
    if (segments[1] === "context") return await handleBrainContext(req, url, segments);
    if (segments[1] === "proposals") return await handleMemoryProposals(req, url, segments);
    if (segments[1] === "candidates") return await handleExtractionCandidates(req, url, segments, store);
    if (segments[1] === "embeddings") return await handleEmbeddings(req, url, segments, store);
    if (segments[1] === "status" && segments.length === 2 && req.method === "GET") {
      return Response.json(store.status());
    }
    if (segments[1] !== "memories") return Response.json({ error: "not found", code: "not_found" }, { status: 404 });
    const id = segments[2];
    const action = segments[3];
    if (id === "search" && req.method === "GET") {
      const q = url.searchParams.get("q") ?? url.searchParams.get("text") ?? "";
      const scopeKind = (url.searchParams.get("scopeKind") ?? "company") as any;
      const projectPath = url.searchParams.get("projectPath") ?? undefined;
      const inheritCompany = url.searchParams.get("inherit") === "company" || url.searchParams.get("inheritCompany") === "true";
      const mode = (url.searchParams.get("mode") ?? "hybrid") as SearchMode;
      const status = (url.searchParams.get("status") ?? "active") as any;
      const limit = parseInt(url.searchParams.get("limit") ?? "20", 10);
      const report = await store.searchReport({
        scopeKind,
        projectPath,
        inheritCompany,
        text: q,
        mode,
        status,
        limit,
      });
      return Response.json({ results: report.results, mode: report.mode, total: report.total });
    }
    if (id && action === "related" && req.method === "GET") {
      if (!isBrainMemoryId(id)) throw new BrainError("Invalid memory id.", 400, "invalid_request");
      return Response.json({ related: store.findRelated(id) });
    }
    if (segments.length > 4) return Response.json({ error: "not found", code: "not_found" }, { status: 404 });
    if (!id) {
      if (req.method === "GET") {
        const parsed = parseBrainListQuery(url.searchParams);
        if (!parsed.ok) throw new BrainError(parsed.error, parsed.status, parsed.code);
        const page = store.list(parsed.value);
        return Response.json({
          memories: page.memories,
          truncated: page.truncated,
          inheritance: { applied: parsed.value.inheritCompany, rule: BRAIN_INHERITANCE_RULE },
        });
      }
      if (req.method === "POST") {
        const parsed = parseBrainCreate(await readBody(req));
        if (!parsed.ok) throw new BrainError(parsed.error, parsed.status, parsed.code);
        const created = store.create(parsed.value);
        return Response.json(created.memory, { status: created.replayed ? 200 : 201 });
      }
      return Response.json({ error: "not found", code: "not_found" }, { status: 404 });
    }
    if (!isBrainMemoryId(id)) throw new BrainError("Invalid memory id.", 400, "invalid_request");
    if (!action) {
      if (req.method === "GET") return Response.json(store.read(id));
      if (req.method === "PATCH") {
        const parsed = parseBrainUpdate(await readBody(req));
        if (!parsed.ok) throw new BrainError(parsed.error, parsed.status, parsed.code);
        return Response.json(store.update(id, parsed.value));
      }
      return Response.json({ error: "not found", code: "not_found" }, { status: 404 });
    }
    if (action === "archive" && segments.length === 4 && req.method === "POST") {
      const parsed = parseBrainArchive(await readBody(req));
      if (!parsed.ok) throw new BrainError(parsed.error, parsed.status, parsed.code);
      return Response.json(store.archive(id, parsed.value.expectedRevision));
    }
    return Response.json({ error: "not found", code: "not_found" }, { status: 404 });
  } catch (error) {
    const status = error instanceof BrainError ? error.status : 500;
    const code = error instanceof BrainError ? error.code : "server";
    const message = error instanceof BrainError ? error.message : "Brain operation failed.";
    return Response.json({ error: message, code }, { status });
  }
}

/**
 * Owner preview and one-turn grants. Markdown is read when a manager turn
 * consumes a grant. This handler does not start a model and does not write
 * a memory.
 */
async function handleBrainContext(req: Request, url: URL, segments: string[]): Promise<Response> {
  const service = await loadBrainContext();
  const action = segments[2];
  const respond = <T>(result: ContextResult<T>, status = 200): Response =>
    result.ok
      ? Response.json(result.value, { status })
      : Response.json({ error: result.error, ...(result.issues ? { issues: result.issues } : {}) }, { status: result.status });
  if (action === "eligible" && segments.length === 3 && req.method === "GET") {
    const parsed = parseBrainEligibleQuery(url.searchParams);
    if (!parsed.ok) throw new BrainError(parsed.error, parsed.status, "invalid_request");
    return respond(service.eligible(parsed.value.target, parsed.value.access, parsed.value.text));
  }
  if (action === "preview" && segments.length === 3 && req.method === "POST") {
    const parsed = parseBrainContextRequest(await readBody(req), "preview");
    if (!parsed.ok) throw new BrainError(parsed.error, parsed.status, "invalid_request");
    if (JSON.stringify(parsed.value).length > BRAIN_CONTEXT_LIMITS.bodyBytes) {
      throw new BrainError("Body too large.", 413, "invalid_request");
    }
    return respond(service.preview(parsed.value.target, parsed.value.access, parsed.value.memories));
  }
  if (action === "grants" && segments.length === 3 && req.method === "POST") {
    const parsed = parseBrainContextRequest(await readBody(req), "approve");
    if (!parsed.ok) throw new BrainError(parsed.error, parsed.status, "invalid_request");
    return respond(service.approve(parsed.value.target, parsed.value.access, parsed.value.memories, parsed.value.previewKey!), 201);
  }
  const targetOf = () => {
    const parsed = parseBrainContextTarget(url.searchParams.get("managerKind"), url.searchParams.get("projectPath"));
    if (!parsed.ok) throw new BrainError(parsed.error, parsed.status, "invalid_request");
    return parsed.value;
  };
  if (action === "grants" && segments.length === 4 && req.method === "DELETE") {
    const grantId = segments[3] ?? "";
    if (!isBrainGrantId(grantId)) throw new BrainError("Invalid grant id.", 400, "invalid_request");
    return respond(service.revoke(targetOf(), grantId));
  }
  if (action === "transmissions" && segments.length === 3 && req.method === "GET") {
    return respond(service.transmissions(targetOf()));
  }
  return Response.json({ error: "not found", code: "not_found" }, { status: 404 });
}

async function handleMemoryProposals(req: Request, url: URL, segments: string[]): Promise<Response> {
  const id = segments[2];
  const action = segments[3];
  if (!id) {
    if (req.method !== "GET" || segments.length !== 2) {
      return Response.json({ error: "not found", code: "not_found" }, { status: 404 });
    }
    const status = url.searchParams.get("status");
    const managerKind = url.searchParams.get("managerKind");
    if (status && status !== "all" && status !== "pending" && status !== "approved" && status !== "rejected" && status !== "invalidated") {
      throw new BrainError("Unknown proposal status.", 400, "invalid_request");
    }
    if (managerKind && managerKind !== "project-manager" && managerKind !== "head-of-pm") {
      throw new BrainError("Unknown manager.", 400, "invalid_request");
    }
    return Response.json({
      proposals: listMemoryProposals({
        status: (status ?? undefined) as MemoryProposalStatus | "all" | undefined,
        managerKind: (managerKind ?? undefined) as MemoryProposalManager | undefined,
        sourceProjectPath: url.searchParams.get("sourceProjectPath") ?? undefined,
        messageId: url.searchParams.get("messageId") ?? undefined,
      }),
    });
  }
  if (!/^[0-9a-f-]{36}$/i.test(id)) throw new BrainError("Invalid proposal id.", 400, "invalid_request");
  if (!action && req.method === "GET") return Response.json(readMemoryProposal(id));
  if (!action && req.method === "PATCH") {
    const parsed = parseMemoryProposalEdit(await readBody(req));
    if (!parsed.ok) throw new BrainError(parsed.error, parsed.status, "invalid_request");
    return Response.json(editMemoryProposal(id, parsed.value));
  }
  if (action === "approve" && segments.length === 4 && req.method === "POST") {
    const parsed = parseMemoryProposalDecision(await readBody(req));
    if (!parsed.ok) throw new BrainError(parsed.error, 400, "invalid_request");
    const result = await approveMemoryProposal(id, parsed.expectedRevision);
    return Response.json(result, { status: result.replayed ? 200 : 201 });
  }
  if (action === "reject" && segments.length === 4 && req.method === "POST") {
    const parsed = parseMemoryProposalDecision(await readBody(req));
    if (!parsed.ok) throw new BrainError(parsed.error, 400, "invalid_request");
    return Response.json(rejectMemoryProposal(id, parsed.expectedRevision, parsed.reason));
  }
  return Response.json({ error: "not found", code: "not_found" }, { status: 404 });
}

async function handleExtractionCandidates(req: Request, url: URL, segments: string[], store: BrainStore): Promise<Response> {
  const id = segments[2];
  const action = segments[3];
  if (!id) {
    if (req.method !== "GET" || segments.length !== 2) {
      return Response.json({ error: "not found", code: "not_found" }, { status: 404 });
    }
    const status = url.searchParams.get("status") as CandidateStatus | "all" | undefined;
    const scopeKind = url.searchParams.get("scopeKind") as any;
    const projectPath = url.searchParams.get("projectPath") ?? undefined;
    const sourceEventKind = url.searchParams.get("sourceEventKind") as ExtractionEventKind | undefined;
    const limit = parseInt(url.searchParams.get("limit") ?? "50", 10);
    return Response.json({
      candidates: listExtractionCandidates({
        status,
        scopeKind,
        projectPath,
        sourceEventKind,
        limit,
      }),
    });
  }
  if (!/^[0-9a-f-]{36}$/i.test(id)) throw new BrainError("Invalid candidate id.", 400, "invalid_request");
  if (!action && req.method === "GET") {
    const candidate = readExtractionCandidate(id);
    if (!candidate) throw new BrainError("Candidate not found.", 404, "not_found");
    return Response.json(candidate);
  }
  if (!action && req.method === "PATCH") {
    const body = (await readBody(req)) as any;
    return Response.json(editExtractionCandidate(id, {
      title: body.title,
      kind: body.kind,
      content: body.content,
    }));
  }
  if (action === "approve" && segments.length === 4 && req.method === "POST") {
    let body: any = {};
    try {
      body = await readBody(req);
    } catch {
      // optional
    }
    const result = await approveExtractionCandidate(id, {
      title: body.title,
      kind: body.kind,
      content: body.content,
    });
    return Response.json(result, { status: 201 });
  }
  if (action === "reject" && segments.length === 4 && req.method === "POST") {
    let reason: string | undefined;
    try {
      const body = (await readBody(req)) as any;
      reason = body.reason;
    } catch {
      // optional
    }
    return Response.json(rejectExtractionCandidate(id, reason));
  }
  return Response.json({ error: "not found", code: "not_found" }, { status: 404 });
}

async function handleEmbeddings(req: Request, url: URL, segments: string[], store: BrainStore): Promise<Response> {
  const action = segments[2];
  if (action === "status" && req.method === "GET") {
    return Response.json(store.getEmbeddingStatus());
  }
  if (action === "rebuild" && req.method === "POST") {
    const res = await store.rebuildEmbeddings();
    return Response.json(res);
  }
  return Response.json({ error: "not found", code: "not_found" }, { status: 404 });
}

async function readBody(req: Request): Promise<unknown> {
  if (!req.body) throw new BrainError("JSON body required.", 400, "invalid_request");
  const reader = req.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const part = await reader.read();
      if (part.done) break;
      size += part.value.byteLength;
      if (size > BRAIN_LIMITS.bodyBytes) {
        await reader.cancel();
        throw new BrainError("Body too large.", 413, "invalid_request");
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
    throw new BrainError("Invalid JSON.", 400, "invalid_request");
  }
}
