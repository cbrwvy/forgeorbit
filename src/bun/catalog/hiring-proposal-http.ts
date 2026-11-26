/**
 * Hiring Proposal HTTP API (FO-014C).
 * Mounted by the Bun server with Bearer auth and strict input validation.
 */

import { HIRING_PROPOSAL_LIMITS } from "../../shared/hiring/types.ts";
import { db } from "../db.ts";
import { HiringProposalCore, HiringProposalError } from "./hiring-proposal-core.ts";

export interface HiringProposalHttpDeps {
  core?: HiringProposalCore;
}

async function readBody(req: Request): Promise<unknown> {
  if (!req.body) throw new HiringProposalError("JSON body required.", 400);
  const reader = req.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const part = await reader.read();
      if (part.done) break;
      size += part.value.byteLength;
      if (size > HIRING_PROPOSAL_LIMITS.bodyBytes) {
        await reader.cancel();
        throw new HiringProposalError("Body too large.", 413);
      }
      chunks.push(part.value);
    }
    if (size === 0) throw new HiringProposalError("JSON body required.", 400);
    const bytes = new Uint8Array(size);
    let offset = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, offset);
      offset += chunk.byteLength;
    }
    try {
      return JSON.parse(new TextDecoder().decode(bytes));
    } catch {
      throw new HiringProposalError("Invalid JSON.", 400);
    }
  } finally {
    reader.releaseLock();
  }
}

function object(value: unknown, allowedKeys: readonly string[]): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new HiringProposalError("Expected an object body.", 400);
  }
  const record = value as Record<string, unknown>;
  for (const key of Object.keys(record)) {
    if (!allowedKeys.includes(key)) {
      throw new HiringProposalError(`Unsupported field: "${key}".`, 400);
    }
  }
  return record;
}

function optionalString(record: Record<string, unknown>, key: string): string | undefined {
  const val = record[key];
  if (val === undefined || val === null) return undefined;
  if (typeof val !== "string") {
    throw new HiringProposalError(`Field "${key}" must be a string.`, 400);
  }
  return val;
}

function requiredString(record: Record<string, unknown>, key: string): string {
  const val = record[key];
  if (typeof val !== "string") {
    throw new HiringProposalError(`Field "${key}" is required and must be a string.`, 400);
  }
  return val;
}

function requiredInteger(record: Record<string, unknown>, key: string): number {
  const val = record[key];
  if (typeof val !== "number" || !Number.isInteger(val)) {
    throw new HiringProposalError(`Field "${key}" is required and must be an integer.`, 400);
  }
  return val;
}

function optionalStringArray(record: Record<string, unknown>, key: string): string[] | undefined {
  const val = record[key];
  if (val === undefined || val === null) return undefined;
  if (!Array.isArray(val) || !val.every((item) => typeof item === "string")) {
    throw new HiringProposalError(`Field "${key}" must be an array of strings.`, 400);
  }
  return val;
}

export async function hiringProposalHttp(
  req: Request,
  bearerAuthorized: boolean,
  deps: HiringProposalHttpDeps = {},
): Promise<Response> {
  const reply = (value: unknown, status = 200) =>
    Response.json(value, { status, headers: { "cache-control": "no-store" } });

  if (!bearerAuthorized) {
    return reply({ error: "unauthorized" }, 401);
  }

  try {
    const core = deps.core ?? new HiringProposalCore(db);
    const url = new URL(req.url);
    const segments = url.pathname
      .split("/")
      .filter(Boolean)
      .map((segment) => {
        try {
          return decodeURIComponent(segment);
        } catch {
          throw new HiringProposalError("Invalid path.", 400);
        }
      });

    if (segments[0] !== "hiring-proposals" || segments.length > 3) {
      return reply({ error: "not found" }, 404);
    }

    const head = segments[1];
    const tail = segments[2];
    const method = req.method;

    // Collection route: /hiring-proposals
    if (!head) {
      if (method === "GET") {
        const projectPath = url.searchParams.get("projectPath") ?? undefined;
        const status = (url.searchParams.get("status") as any) ?? undefined;
        const catalogRoleSlug = url.searchParams.get("catalogRoleSlug") ?? undefined;
        const result = core.list({ projectPath, status, catalogRoleSlug });
        return reply(result);
      }

      if (method === "POST") {
        const body = object(await readBody(req), [
          "projectPath",
          "roleSlug",
          "proposedName",
          "professionalTitle",
          "promptMarkdown",
          "justification",
          "competencies",
          "relatedTasks",
        ]);
        const projectPath = requiredString(body, "projectPath");
        const roleSlug = requiredString(body, "roleSlug");
        const justification = requiredString(body, "justification");
        const proposedName = optionalString(body, "proposedName");
        const professionalTitle = optionalString(body, "professionalTitle");
        const promptMarkdown = optionalString(body, "promptMarkdown");
        const competencies = optionalStringArray(body, "competencies");
        const relatedTasks = optionalStringArray(body, "relatedTasks");

        const proposal = core.create(projectPath, {
          roleSlug,
          proposedName,
          professionalTitle,
          promptMarkdown,
          justification,
          competencies,
          relatedTasks,
        });
        return reply({ proposal }, 201);
      }

      return reply({ error: "method not allowed" }, 405);
    }

    // Summary route: /hiring-proposals/summary
    if (head === "summary") {
      if (tail) return reply({ error: "not found" }, 404);
      if (method !== "GET") return reply({ error: "method not allowed" }, 405);
      return reply(core.summary());
    }

    // Item route: /hiring-proposals/:id
    if (!tail) {
      if (method === "GET") {
        const proposal = core.get(head);
        if (!proposal) return reply({ error: "not found" }, 404);
        return reply({ proposal });
      }

      if (method === "PATCH") {
        const body = object(await readBody(req), [
          "expectedRevision",
          "proposedName",
          "professionalTitle",
          "promptMarkdown",
          "justification",
          "competencies",
          "relatedTasks",
          "changeNote",
        ]);
        const expectedRevision = requiredInteger(body, "expectedRevision");
        const proposedName = optionalString(body, "proposedName");
        const professionalTitle = optionalString(body, "professionalTitle");
        const promptMarkdown = optionalString(body, "promptMarkdown");
        const justification = optionalString(body, "justification");
        const competencies = optionalStringArray(body, "competencies");
        const relatedTasks = optionalStringArray(body, "relatedTasks");
        const changeNote = optionalString(body, "changeNote");

        const result = core.update(head, {
          expectedRevision,
          proposedName,
          professionalTitle,
          promptMarkdown,
          justification,
          competencies,
          relatedTasks,
          changeNote,
        });
        return reply(result);
      }

      return reply({ error: "method not allowed" }, 405);
    }

    // Action subroutes: /hiring-proposals/:id/...
    if (tail === "history") {
      if (method !== "GET") return reply({ error: "method not allowed" }, 405);
      return reply(core.history(head));
    }

    if (tail === "approve") {
      if (method !== "POST") return reply({ error: "method not allowed" }, 405);
      const body = object(await readBody(req), [
        "expectedRevision",
        "proposedName",
        "professionalTitle",
        "promptMarkdown",
        "changeNote",
      ]);
      const expectedRevision = requiredInteger(body, "expectedRevision");
      const proposedName = optionalString(body, "proposedName");
      const professionalTitle = optionalString(body, "professionalTitle");
      const promptMarkdown = optionalString(body, "promptMarkdown");
      const changeNote = optionalString(body, "changeNote");

      const result = core.approve(head, {
        expectedRevision,
        proposedName,
        professionalTitle,
        promptMarkdown,
        changeNote,
      });
      return reply(result);
    }

    if (tail === "reject") {
      if (method !== "POST") return reply({ error: "method not allowed" }, 405);
      const body = object(await readBody(req), ["expectedRevision", "note"]);
      const expectedRevision = requiredInteger(body, "expectedRevision");
      const note = optionalString(body, "note");
      const result = core.reject(head, {
        expectedRevision,
        note,
      });
      return reply(result);
    }

    if (tail === "withdraw") {
      if (method !== "POST") return reply({ error: "method not allowed" }, 405);
      const body = object(await readBody(req), ["expectedRevision", "note"]);
      const expectedRevision = requiredInteger(body, "expectedRevision");
      const note = optionalString(body, "note");
      const result = core.withdraw(
        head,
        expectedRevision,
        note,
      );
      return reply(result);
    }

    return reply({ error: "not found" }, 404);
  } catch (error) {
    if (error instanceof HiringProposalError) {
      return reply(
        { error: error.message, ...(error.proposal ? { proposal: error.proposal } : {}) },
        error.status,
      );
    }
    return reply({ error: "Hiring proposal operation failed." }, 500);
  }
}
