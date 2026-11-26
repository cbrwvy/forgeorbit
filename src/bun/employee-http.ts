/**
 * Employee HTTP API, mounted by the existing Bun server (FO-010A).
 * Bearer auth is required before a body is read. Query tokens are not accepted.
 * No route starts, stops, or configures an agent, and none accepts a model,
 * account, harness, or profile.
 */

import { EmployeeCore, EmployeeCoreError } from "./employee-core.ts";
import { EmployeeProfileCore, EmployeeProfileError } from "./catalog/employee-profile-core.ts";
import { db } from "./db.ts";

const MAX_BODY_BYTES = 16 * 1024;
const MAX_PROFILE_BODY_BYTES = 600 * 1024;

export interface EmployeeHttpDeps {
  core?: EmployeeCore;
  profileCore?: EmployeeProfileCore;
}

async function readBody(req: Request, allowEmpty = false, maxBytes = MAX_BODY_BYTES): Promise<unknown> {
  if (!req.body) {
    if (allowEmpty) return {};
    throw new EmployeeCoreError("JSON body required.");
  }
  const reader = req.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const part = await reader.read();
      if (part.done) break;
      size += part.value.length;
      if (size > maxBytes) {
        await reader.cancel();
        throw new EmployeeCoreError("Body too large.", 413);
      }
      chunks.push(part.value);
    }
    const bytes = new Uint8Array(size);
    let offset = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, offset);
      offset += chunk.length;
    }
    if (size === 0 && allowEmpty) return {};
    try {
      return JSON.parse(new TextDecoder().decode(bytes));
    } catch {
      throw new EmployeeCoreError("Invalid JSON.");
    }
  } finally {
    reader.releaseLock();
  }
}

function projectPathFromBody(value: unknown): unknown {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new EmployeeCoreError("Expected an object.");
  const record = value as Record<string, unknown>;
  if (Object.keys(record).length !== 1 || !("projectPath" in record)) throw new EmployeeCoreError("Expected projectPath.");
  return record.projectPath;
}

function requiredQuery(url: URL, key: string): string {
  const value = url.searchParams.get(key);
  if (!value) throw new EmployeeCoreError(`${key} is required.`);
  return value;
}

export async function employeeHttp(req: Request, bearerAuthorized: boolean, deps: EmployeeHttpDeps = {}): Promise<Response> {
  const reply = (value: unknown, status = 200) => Response.json(value, { status, headers: { "cache-control": "no-store" } });
  if (!bearerAuthorized) return reply({ error: "unauthorized" }, 401);
  try {
    const core = deps.core ?? new EmployeeCore(db);
    const profileCore = deps.profileCore ?? new EmployeeProfileCore(db);
    const url = new URL(req.url);
    const segments = url.pathname.split("/").filter(Boolean).map((segment) => {
      try {
        return decodeURIComponent(segment);
      } catch {
        throw new EmployeeCoreError("Invalid path.");
      }
    });
    if (segments[0] !== "employees") return reply({ error: "not found" }, 404);
    const method = req.method;
    const head = segments[1];
    const tail = segments[2];

    // Professional profile routes for an employee: /employees/:id/professional-profile/...
    if (head && tail === "professional-profile") {
      const sub = segments[3];
      const revParam = segments[4];

      if (segments.length === 3) {
        if (method === "GET") {
          const profile = profileCore.getProfile(head);
          return reply({ profile });
        }
        if (method === "POST") {
          const body = (await readBody(req, false, MAX_PROFILE_BODY_BYTES)) as any;
          const profile = profileCore.assignRole(head, body, "owner");
          return reply({ profile }, 200);
        }
        if (method === "PUT") {
          const body = (await readBody(req, false, MAX_PROFILE_BODY_BYTES)) as any;
          const profile = profileCore.updatePrompt(head, body, "owner");
          return reply({ profile }, 200);
        }
        return reply({ error: "not found" }, 404);
      }

      if (segments.length === 4) {
        if (sub === "reset" && method === "POST") {
          const body = (await readBody(req, false, MAX_BODY_BYTES)) as any;
          const profile = profileCore.resetToTemplate(head, body?.expectedRevision, "owner");
          return reply({ profile }, 200);
        }
        if (sub === "revisions" && method === "GET") {
          const revisions = profileCore.listRevisions(head);
          return reply({ revisions });
        }
        return reply({ error: "not found" }, 404);
      }

      if (segments.length === 5 && sub === "revisions" && method === "GET") {
        const revNum = parseInt(revParam!, 10);
        if (isNaN(revNum) || revNum <= 0) {
          throw new EmployeeProfileError("Invalid revision number.", 400);
        }
        const revision = profileCore.getRevision(head, revNum);
        return reply({ revision });
      }

      return reply({ error: "not found" }, 404);
    }

    if (segments.length > 3) return reply({ error: "not found" }, 404);

    if (!head) {
      if (method === "GET") {
        return reply({
          employees: core.list({
            projectPath: url.searchParams.get("projectPath"),
            kind: url.searchParams.get("kind"),
            status: url.searchParams.get("status"),
            includeArchived: url.searchParams.get("archived") === "true",
          }),
        });
      }
      if (method === "POST") return reply(core.createWorker(await readBody(req)), 201);
      return reply({ error: "not found" }, 404);
    }

    // Literal paths first. Anything else must be an employee id.
    if (head === "organization" && !tail) return method === "GET" ? reply(core.organization()) : reply({ error: "not found" }, 404);

    if (head === "head" && !tail) {
      if (method === "GET") return reply({ head: core.head() });
      if (method === "PUT") {
        const result = core.setHead(await readBody(req));
        return reply(result, result.created ? 201 : 200);
      }
      return reply({ error: "not found" }, 404);
    }

    if (head === "project-team" && !tail && method === "GET") return reply(core.projectTeam(requiredQuery(url, "projectPath")));

    if (head === "project-managers") {
      if (!tail) {
        if (method === "GET") return reply(core.projectManager(requiredQuery(url, "projectPath")));
        if (method === "POST") {
          const body = await readBody(req);
          if (!body || typeof body !== "object" || Array.isArray(body)) throw new EmployeeCoreError("Expected an object.");
          const { projectPath, ...rest } = body as Record<string, unknown>;
          const result = core.ensureProjectManager(projectPath, rest);
          return reply(result, result.created ? 201 : 200);
        }
        return reply({ error: "not found" }, 404);
      }
      if (tail === "initialize-existing" && method === "POST") {
        await readBody(req, true);
        return reply(core.initializeExistingProjectManagers());
      }
      return reply({ error: "not found" }, 404);
    }

    if (!tail) {
      if (method === "GET") return reply(core.get(head));
      if (method === "PATCH") return reply(core.update(head, await readBody(req)));
      if (method === "DELETE") return reply(core.archive(head));
      return reply({ error: "not found" }, 404);
    }

    if (method === "GET" && tail === "history") return reply(core.history(head));
    if (method === "POST") {
      if (tail === "regenerate-name") {
        await readBody(req, true);
        return reply(core.regenerateName(head));
      }
      if (tail === "assign") return reply(core.assign(head, projectPathFromBody(await readBody(req))));
      if (tail === "unassign") {
        await readBody(req, true);
        return reply(core.unassign(head));
      }
      if (tail === "unarchive") {
        await readBody(req, true);
        return reply(core.unarchive(head));
      }
    }
    return reply({ error: "not found" }, 404);
  } catch (error) {
    const status =
      error instanceof EmployeeProfileError
        ? error.status
        : error instanceof EmployeeCoreError
          ? error.status
          : 500;
    const message =
      error instanceof EmployeeProfileError
        ? error.message
        : error instanceof EmployeeCoreError
          ? error.message
          : "Employee operation failed.";
    return reply({ error: message }, status);
  }
}
