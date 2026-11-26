/**
 * Task-assignment HTTP API (FO-010C), mounted by the existing Bun server.
 * Bearer auth is required before a body is read. Query tokens are not accepted.
 * No route starts a run, calls the model router, or accepts a model, account,
 * harness, command, or filesystem path as a write field.
 */

import { ASSIGNMENT_LIMITS, ASSIGNMENT_ROUTER_HANDOFF } from "../shared/assignments/types.ts";
import { AssignmentCore, AssignmentCoreError } from "./assignment-core.ts";
import { db } from "./db.ts";

export interface AssignmentHttpDeps {
  core?: AssignmentCore;
}

const handoff = { routerHandoff: ASSIGNMENT_ROUTER_HANDOFF };

async function readBody(req: Request): Promise<unknown> {
  if (!req.body) throw new AssignmentCoreError("JSON body required.");
  const reader = req.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const part = await reader.read();
      if (part.done) break;
      size += part.value.byteLength;
      if (size > ASSIGNMENT_LIMITS.bodyBytes) {
        await reader.cancel();
        throw new AssignmentCoreError("Body too large.", 413);
      }
      chunks.push(part.value);
    }
    const bytes = new Uint8Array(size);
    let offset = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, offset);
      offset += chunk.byteLength;
    }
    if (size === 0) throw new AssignmentCoreError("JSON body required.");
    try {
      return JSON.parse(new TextDecoder().decode(bytes));
    } catch {
      throw new AssignmentCoreError("Invalid JSON.");
    }
  } finally {
    reader.releaseLock();
  }
}

function object(value: unknown, keys: readonly string[]): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new AssignmentCoreError("Expected an object.");
  const record = value as Record<string, unknown>;
  if (Object.keys(record).some((key) => !keys.includes(key))) throw new AssignmentCoreError("Unsupported field.");
  for (const key of keys) {
    if (!(key in record)) throw new AssignmentCoreError(`Missing ${key}.`);
  }
  return record;
}

function onlyQuery(url: URL, keys: readonly string[]): void {
  for (const key of keys) {
    if (url.searchParams.getAll(key).length > 1) throw new AssignmentCoreError("Unsupported field.");
  }
  for (const key of url.searchParams.keys()) {
    if (!keys.includes(key)) throw new AssignmentCoreError("Unsupported field.");
  }
}

function one(url: URL, key: string): string {
  onlyQuery(url, [key]);
  const value = url.searchParams.get(key);
  if (!value) throw new AssignmentCoreError(`${key} is required.`);
  return value;
}

export async function assignmentHttp(req: Request, bearerAuthorized: boolean, deps: AssignmentHttpDeps = {}): Promise<Response> {
  const reply = (value: unknown, status = 200) => Response.json(value, { status, headers: { "cache-control": "no-store" } });
  if (!bearerAuthorized) return reply({ error: "unauthorized" }, 401);
  try {
    const core = deps.core ?? new AssignmentCore(db);
    const url = new URL(req.url);
    const segments = url.pathname.split("/").filter(Boolean).map((segment) => {
      try {
        return decodeURIComponent(segment);
      } catch {
        throw new AssignmentCoreError("Invalid path.");
      }
    });
    if (segments[0] !== "task-assignments" || segments.length > 2) return reply({ error: "not found" }, 404);
    const head = segments[1];
    const method = req.method;

    if (!head) {
      if (method === "GET") {
        return reply({ assignments: core.forEmployee(one(url, "employeeId")), ...handoff });
      }
      if (method === "POST") {
        const body = object(await readBody(req), ["taskId", "employeeId"]);
        const result = core.assign(body.taskId, body.employeeId);
        return reply({ assignment: result.assignment, created: result.created, ...handoff }, result.created ? 201 : 200);
      }
      return reply({ error: "not found" }, 405);
    }

    if (head === "task" && method === "GET") {
      return reply({ assignment: core.forTask(one(url, "taskId")), ...handoff });
    }
    if (head === "project" && method === "GET") {
      const projectPath = one(url, "projectPath");
      return reply({ projectPath, assignments: core.forProject(projectPath), ...handoff });
    }
    if (head === "candidates" && method === "GET") {
      const result = core.candidates(one(url, "employeeId"));
      return reply({ ...result, ...handoff });
    }
    if (head === "history" && method === "GET") {
      onlyQuery(url, ["taskId", "employeeId", "projectPath"]);
      const present = ["taskId", "employeeId", "projectPath"].filter((key) => url.searchParams.get(key));
      if (present.length !== 1) throw new AssignmentCoreError("History needs exactly one of taskId, employeeId, or projectPath.");
      const key = present[0]!;
      return reply({ ...core.history({ [key]: url.searchParams.get(key) }), ...handoff });
    }
    if (head === "reassign" && method === "POST") {
      const body = object(await readBody(req), ["taskId", "employeeId", "expectedRevision"]);
      return reply({ assignment: core.reassign(body.taskId, body.employeeId, body.expectedRevision), ...handoff });
    }
    if (head === "unassign" && method === "POST") {
      const body = object(await readBody(req), ["taskId", "expectedRevision"]);
      return reply({ assignment: core.unassign(body.taskId, body.expectedRevision), ...handoff });
    }
    if (head === "task" || head === "project" || head === "candidates" || head === "history" || head === "reassign" || head === "unassign") {
      return reply({ error: "not found" }, 405);
    }
    return reply({ error: "not found" }, 404);
  } catch (error) {
    const status = error instanceof AssignmentCoreError ? error.status : 500;
    const message = error instanceof AssignmentCoreError ? error.message : "Assignment operation failed.";
    return reply({ error: message }, status);
  }
}
