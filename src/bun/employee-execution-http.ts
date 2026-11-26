import { professionalTurnHistory, reviewProfessionalTurn, submitProfessionalTurn, cancelProfessionalTurn } from "./professional-turn.ts";
import { TurnError } from "./professional-turn-core.ts";
/**
 * Employee execution HTTP API (FO-010E1 preflight, FO-010E2 supervised start).
 *
 * Bearer auth is checked before any body is read; query tokens are not
 * accepted. Bodies carry identifiers and choices only: no path, command,
 * credential, account switch or model-run flag.
 *
 *   POST /employee-execution/preflight            read-only calculation (E1)
 *   POST /employee-execution/recommendations     read-only grouped executor options (FO-ORCH01)
 *   GET|PUT /employee-execution/executor-preferences   Owner routing preferences (FO-ORCH01)
 *   POST /employee-execution/reviews              record ONE pending review; starts nothing
 *   GET  /employee-execution/attempts?taskId=|employeeId=&limit=
 *   GET  /employee-execution/attempts/:id
 *   GET  /employee-execution/summary?employeeId=  read-only roll-up of recorded outcomes (Direction 2)
 *   POST /employee-execution/attempts/:id/start   the owner's confirmation; the only way to start
 *   POST /employee-execution/attempts/:id/cancel  withdraw an unconfirmed review
 */

import { PREFLIGHT_LIMITS } from "../shared/execution/preflight.ts";
import { recommendExecutors } from "./executor-recommendations.ts";
import { loadExecutorPreferences, saveExecutorPreferences } from "./executor-preferences.ts";
import { EXECUTOR_LIMITS } from "../shared/execution/executor-routing.ts";
import { employeeWorkSummary } from "./employee-summary.ts";
import { prepareEmployeeExecution, PreflightError, type PreflightDeps } from "./employee-execution.ts";
import {
  cancelEmployeeExecution,
  EmployeeRunError,
  getEmployeeRun,
  listEmployeeRuns,
  reconcileEmployeeExecution,
  reviewEmployeeExecution,
  startEmployeeExecution,
  type EmployeeRunDeps,
} from "./employee-run.ts";

async function readBody(req: Request, optional = false, limit: number = PREFLIGHT_LIMITS.bodyBytes): Promise<unknown> {
  const reader = req.body?.getReader();
  if (!reader) {
    if (optional) return undefined;
    throw new PreflightError("JSON body required.");
  }
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const part = await reader.read();
      if (part.done) break;
      size += part.value.byteLength;
      if (size > limit) {
        await reader.cancel();
        throw new PreflightError("Body too large.", 413);
      }
      chunks.push(part.value);
    }
  } finally {
    reader.releaseLock();
  }
  if (size === 0 && optional) return undefined;
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try {
    return JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    throw new PreflightError("Invalid JSON.");
  }
}

export interface EmployeeExecutionHttpDeps {
  preflight?: PreflightDeps;
  run?: EmployeeRunDeps;
}

export async function employeeExecutionHttp(req: Request, authorized: boolean, deps: EmployeeExecutionHttpDeps | PreflightDeps = {}): Promise<Response> {
  const reply = (value: unknown, status = 200) => Response.json(value, { status, headers: { "cache-control": "no-store" } });
  if (!authorized) return reply({ error: "unauthorized" }, 401);
  // Older callers pass PreflightDeps directly.
  const shaped = deps as EmployeeExecutionHttpDeps;
  const runDeps: EmployeeRunDeps = shaped.run ?? { preflight: shaped.preflight ?? (deps as PreflightDeps) };
  const url = new URL(req.url);
  const path = url.pathname;
  try {
    const turnRoute = /^\/employee-execution\/runs\/([a-zA-Z0-9_-]{1,200})\/(turns|turn-reviews)$/.exec(path);
    if (turnRoute) {
      if (url.search) throw new TurnError("Unsupported field.", 400);
      if (turnRoute[2] === "turns" && req.method === "GET") return reply(professionalTurnHistory(turnRoute[1]!));
      if (turnRoute[2] === "turn-reviews" && req.method === "POST") return reply(reviewProfessionalTurn(turnRoute[1]!, await readBody(req, false, 4 * 1024 * 1024)));
      return reply({ error: "Use GET for history or POST for review." }, 405);
    }
    const turnSubmit = /^\/employee-execution\/turns\/([a-zA-Z0-9_-]{1,200})\/(submit|cancel)$/.exec(path);
    if (turnSubmit) {
      if (url.search) throw new TurnError("Unsupported field.", 400);
      if (req.method !== "POST") return reply({ error: "Use POST." }, 405);
      const body = await readBody(req);
      return reply(turnSubmit[2] === "submit" ? await submitProfessionalTurn(turnSubmit[1]!, body) : cancelProfessionalTurn(turnSubmit[1]!, body));
    }
    if (path === "/employee-execution/preflight") {
      if (url.search) return reply({ error: "Unsupported field." }, 400);
      if (req.method !== "POST") return reply({ error: "Use POST for a read-only calculation." }, 405);
      return reply({ preflight: prepareEmployeeExecution(await readBody(req), runDeps.preflight) });
    }
    if (path === "/employee-execution/recommendations") {
      if (url.search) return reply({ error: "Unsupported field." }, 400);
      if (req.method !== "POST") return reply({ error: "Use POST for a read-only calculation." }, 405);
      return reply(await recommendExecutors(await readBody(req), { preflight: runDeps.preflight }));
    }
    if (path === "/employee-execution/executor-preferences") {
      if (url.search) return reply({ error: "Unsupported field." }, 400);
      if (req.method === "GET") return reply({ preferences: loadExecutorPreferences() });
      if (req.method !== "PUT") return reply({ error: "Use GET or PUT." }, 405);
      const body = await readBody(req, false, EXECUTOR_LIMITS.bodyBytes);
      try {
        return reply({ preferences: saveExecutorPreferences(body) });
      } catch (message) {
        if (typeof message === "string") return reply({ error: message }, 400);
        throw message;
      }
    }
    if (path === "/employee-execution/reviews") {
      if (url.search) return reply({ error: "Unsupported field." }, 400);
      if (req.method !== "POST") return reply({ error: "Use POST." }, 405);
      const outcome = await reviewEmployeeExecution(await readBody(req), runDeps);
      return reply(outcome);
    }
    if (path === "/employee-execution/summary") {
      if (req.method !== "GET") return reply({ error: "Use GET." }, 405);
      for (const key of url.searchParams.keys()) if (key !== "employeeId" || url.searchParams.getAll(key).length !== 1) return reply({ error: "Unsupported field." }, 400);
      const employeeId = url.searchParams.get("employeeId");
      if (!employeeId || !/^[a-zA-Z0-9_-]{1,200}$/.test(employeeId)) return reply({ error: "Invalid identifier." }, 400);
      return reply({ summary: employeeWorkSummary(employeeId, runDeps) });
    }
    if (path === "/employee-execution/attempts") {
      if (req.method !== "GET") return reply({ error: "Use GET." }, 405);
      const allowed = new Set(["taskId", "employeeId", "limit", "before"]);
      for (const key of url.searchParams.keys()) if (!allowed.has(key) || url.searchParams.getAll(key).length !== 1) return reply({ error: "Unsupported field." }, 400);
      const taskId = url.searchParams.get("taskId");
      const employeeId = url.searchParams.get("employeeId");
      if ((taskId === null) === (employeeId === null)) return reply({ error: "Pass exactly one of taskId or employeeId." }, 400);
      if ((taskId !== null && !/^[a-zA-Z0-9_-]{1,200}$/.test(taskId)) || (employeeId !== null && !/^[a-zA-Z0-9_-]{1,200}$/.test(employeeId))) return reply({ error: "Invalid identifier." }, 400);
      const before = url.searchParams.get("before") ?? undefined;
      if (before !== undefined && (!employeeId || !/^[a-zA-Z0-9_-]{1,200}$/.test(before))) return reply({ error: "Invalid cursor." }, 400);
      const limitText = url.searchParams.get("limit");
      const limit = limitText === null ? undefined : Number(limitText);
      if (limit !== undefined && (!Number.isInteger(limit) || limit < 1 || limit > 100)) return reply({ error: "Invalid limit." }, 400);
      return reply({ attempts: listEmployeeRuns({ ...(taskId ? { taskId } : {}), ...(employeeId ? { employeeId } : {}), limit, before }, runDeps) });
    }
    const match = /^\/employee-execution\/attempts\/([^/]{1,200})(?:\/(start|cancel|reconcile))?$/.exec(path);
    if (match) {
      const id = decodeURIComponent(match[1]!);
      if (!/^[a-zA-Z0-9_-]{1,200}$/.test(id)) return reply({ error: "Invalid identifier." }, 400);
      const action = match[2];
      if (url.search) return reply({ error: "Unsupported field." }, 400);
      if (!action) {
        if (req.method !== "GET") return reply({ error: "Use GET." }, 405);
        return reply({ attempt: getEmployeeRun(id, runDeps) });
      }
      if (req.method !== "POST") return reply({ error: "Use POST." }, 405);
      if (action === "start") {
        const outcome = await startEmployeeExecution(id, await readBody(req), runDeps);
        return reply(outcome);
      }
      if (action === "reconcile") return reply(reconcileEmployeeExecution(id, await readBody(req), runDeps));
      return reply({ attempt: cancelEmployeeExecution(id, await readBody(req, true), runDeps) });
    }
    return reply({ error: "not found" }, 404);
  } catch (error) {
    if (error instanceof TurnError) return reply({ error: error.message }, error.status);
    if (error instanceof EmployeeRunError) return reply({ error: error.message, code: error.code, ...error.extra }, error.status);
    if (error instanceof PreflightError) return reply({ error: error.message }, error.status);
    return reply({ error: "The request could not be completed." }, 500);
  }
}
