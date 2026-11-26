/**
 * Assignment-proposal HTTP API (FO-010D), mounted by the existing Bun server.
 * Bearer auth is required before a body is read. Query tokens are not accepted.
 *
 * Every write field is strictly validated. No route accepts a project path as
 * authority for a write (the project comes from the task), and none starts a
 * run, or accepts a model, account, harness, command,
 * or filesystem path. Proposals written by a project manager do not come in
 * through this API: the manager runner records them in-process after
 * validating its own reply. Executor review reads the deterministic router and
 * binds PM approval to the evidence shown to the Owner.
 */

import { PROPOSAL_EXECUTION_NOTE, PROPOSAL_LIMITS } from "../shared/assignments/proposals.ts";
import { AssignmentCore } from "./assignment-core.ts";
import { AssignmentProposalCore, AssignmentProposalError } from "./assignment-proposals.ts";
import { assignmentExecutorReview, verifyAssignmentExecutorReview } from "./assignment-executor-review.ts";
import { db } from "./db.ts";

export interface AssignmentProposalHttpDeps {
  core?: AssignmentProposalCore;
}

const note = { execution: PROPOSAL_EXECUTION_NOTE };

async function readBody(req: Request): Promise<unknown> {
  if (!req.body) throw new AssignmentProposalError("JSON body required.");
  const reader = req.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const part = await reader.read();
      if (part.done) break;
      size += part.value.byteLength;
      if (size > PROPOSAL_LIMITS.bodyBytes) {
        await reader.cancel();
        throw new AssignmentProposalError("Body too large.", 413);
      }
      chunks.push(part.value);
    }
    if (size === 0) throw new AssignmentProposalError("JSON body required.");
    const bytes = new Uint8Array(size);
    let offset = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, offset);
      offset += chunk.byteLength;
    }
    try {
      return JSON.parse(new TextDecoder().decode(bytes));
    } catch {
      throw new AssignmentProposalError("Invalid JSON.");
    }
  } finally {
    reader.releaseLock();
  }
}

function object(value: unknown, keys: readonly string[]): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new AssignmentProposalError("Expected an object.");
  const record = value as Record<string, unknown>;
  if (Object.keys(record).some((key) => !keys.includes(key))) throw new AssignmentProposalError("Unsupported field.");
  for (const key of keys) {
    if (!(key in record)) throw new AssignmentProposalError(`Missing ${key}.`);
  }
  return record;
}

function onlyQuery(url: URL, keys: readonly string[]): void {
  for (const key of keys) {
    if (url.searchParams.getAll(key).length > 1) throw new AssignmentProposalError("Unsupported field.");
  }
  for (const key of url.searchParams.keys()) {
    if (!keys.includes(key)) throw new AssignmentProposalError("Unsupported field.");
  }
}

export async function assignmentProposalHttp(
  req: Request,
  bearerAuthorized: boolean,
  deps: AssignmentProposalHttpDeps = {},
): Promise<Response> {
  const reply = (value: unknown, status = 200) => Response.json(value, { status, headers: { "cache-control": "no-store" } });
  if (!bearerAuthorized) return reply({ error: "unauthorized" }, 401);
  try {
    const core = deps.core ?? new AssignmentProposalCore(db, new AssignmentCore(db));
    const url = new URL(req.url);
    const segments = url.pathname.split("/").filter(Boolean).map((segment) => {
      try {
        return decodeURIComponent(segment);
      } catch {
        throw new AssignmentProposalError("Invalid path.");
      }
    });
    if (segments[0] !== "assignment-proposals" || segments.length > 3) return reply({ error: "not found" }, 404);
    const head = segments[1];
    const tail = segments[2];
    const method = req.method;

    if (!head) {
      if (method === "GET") {
        onlyQuery(url, ["projectPath", "status", "taskId", "employeeId"]);
        const result = core.list({
          projectPath: url.searchParams.get("projectPath") ?? undefined,
          status: url.searchParams.get("status") ?? undefined,
          taskId: url.searchParams.get("taskId") ?? undefined,
          employeeId: url.searchParams.get("employeeId") ?? undefined,
        });
        return reply({ ...result, ...note });
      }
      if (method === "POST") {
        const body = object(await readBody(req), ["taskId", "employeeId", "rationale"]);
        return reply({ proposal: core.create(body.taskId, body.employeeId, body.rationale), ...note }, 201);
      }
      return reply({ error: "not found" }, 405);
    }

    if (head === "summary") {
      if (tail) return reply({ error: "not found" }, 404);
      if (method !== "GET") return reply({ error: "not found" }, 405);
      onlyQuery(url, []);
      return reply({ ...core.summary(), ...note });
    }

    if (!tail) {
      if (method !== "GET") return reply({ error: "not found" }, 405);
      onlyQuery(url, []);
      return reply({ proposal: core.get(head), ...note });
    }

    if (tail === "recommendations") {
      if (method !== "GET") return reply({ error: "not found" }, 405);
      onlyQuery(url, []);
      const { stateKey: _stateKey, ...review } = await assignmentExecutorReview(core.get(head));
      return reply({ review, ...note });
    }
    if (tail === "history") {
      if (method !== "GET") return reply({ error: "not found" }, 405);
      onlyQuery(url, []);
      return reply({ ...core.history(head), ...note });
    }
    if (tail === "approve") {
      if (method !== "POST") return reply({ error: "not found" }, 405);
      const raw = await readBody(req);
      const { routingReviewToken, ...fields } = raw && typeof raw === "object" && !Array.isArray(raw) ? raw as Record<string, unknown> : {};
      const body = object(fields, ["expectedRevision", "expectedAssignmentRevision", "allowReassign"]);
      const proposal = core.get(head);
      if (proposal.status === "stale") return reply({ error: proposal.staleReason ?? "This proposal is out of date.", proposal, ...note }, 409);
      // A replay of an already approved assignment has no new side effects.
      const fresh = proposal.status === "pending" && proposal.proposedBy.kind === "project-manager"
        ? await assignmentExecutorReview(proposal) : null;
      if (fresh && !verifyAssignmentExecutorReview(proposal, routingReviewToken, fresh)) {
        return reply({ error: "Executor evidence or permissions changed, or were not reviewed. Review executor options again. Nothing was assigned.", ...note }, 409);
      }
      const result = core.approve(head, {
        expectedRevision: body.expectedRevision,
        expectedAssignmentRevision: body.expectedAssignmentRevision,
        allowReassign: body.allowReassign,
      }, () => fresh && !verifyAssignmentExecutorReview(core.get(head), routingReviewToken, fresh)
        ? "Executor review changed. Review again." : null);
      return reply({ ...result, ...note });
    }
    if (tail === "reject" || tail === "cancel") {
      if (method !== "POST") return reply({ error: "not found" }, 405);
      const body = object(await readBody(req), ["expectedRevision"]);
      const result = tail === "reject" ? core.reject(head, body.expectedRevision) : core.cancel(head, body.expectedRevision);
      return reply({ ...result, ...note });
    }
    return reply({ error: "not found" }, 404);
  } catch (error) {
    if (error instanceof AssignmentProposalError) {
      return reply({ error: error.message, ...(error.proposal ? { proposal: error.proposal } : {}), ...note }, error.status);
    }
    return reply({ error: "Assignment proposal operation failed." }, 500);
  }
}
