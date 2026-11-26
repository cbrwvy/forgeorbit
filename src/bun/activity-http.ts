/**
 * FO-015A.1 Company Activity Journal HTTP API.
 *
 * Exposes a read-only, authenticated endpoint for querying the company activity journal.
 * Arbitrary event writes over HTTP are strictly forbidden.
 */

import {
  ActivityJournalCore,
  ActivityJournalError,
  VALID_ACTOR_TYPES,
  VALID_TARGET_TYPES,
} from "./activity-journal-core.ts";
import type { ActivityActorType, ActivityQueryFilter, ActivityTargetType } from "../shared/activity/types.ts";

export interface ActivityHttpDeps {
  core?: ActivityJournalCore;
}

const SUPPORTED_QUERY_PARAMS = new Set<string>([
  "projectPath",
  "actorType",
  "actorId",
  "employeeId",
  "eventType",
  "targetType",
  "targetId",
  "taskId",
  "runId",
  "since",
  "until",
  "from",
  "to",
  "limit",
  "cursor",
  "direction",
]);

function parseNonNegativeTimestamp(raw: string, name: string): number {
  if (!/^\d+$/.test(raw)) {
    throw new ActivityJournalError(`Invalid '${name}' parameter: must be a non-negative integer timestamp (ms).`, 400);
  }
  const parsed = Number(raw);
  if (!Number.isSafeInteger(parsed) || parsed < 0) {
    throw new ActivityJournalError(`Invalid '${name}' parameter: must be a safe non-negative integer timestamp (ms).`, 400);
  }
  return parsed;
}

function parseNonEmptyParam(searchParams: URLSearchParams, name: string): string | undefined {
  if (!searchParams.has(name)) {
    return undefined;
  }
  const value = searchParams.get(name) ?? "";
  if (!value.trim()) {
    throw new ActivityJournalError(`Invalid '${name}' parameter: must be a non-empty string.`, 400);
  }
  return value;
}

export async function activityHttp(
  req: Request,
  bearerAuthorized: boolean,
  deps: ActivityHttpDeps = {},
): Promise<Response> {
  const reply = (value: unknown, status = 200) =>
    Response.json(value, { status, headers: { "cache-control": "no-store" } });

  if (!bearerAuthorized) {
    return reply({ error: "unauthorized" }, 401);
  }

  // Reject all mutative methods with 405
  if (req.method !== "GET" && req.method !== "HEAD") {
    return reply(
      { error: "Method not allowed. Activity journal is append-only and can only be recorded by trusted backend logic." },
      405,
    );
  }

  try {
    const core = deps.core ?? new ActivityJournalCore((await import("./db.ts")).db);
    const url = new URL(req.url);
    const segments = url.pathname
      .split("/")
      .filter(Boolean)
      .map((segment) => {
        try {
          return decodeURIComponent(segment);
        } catch {
          throw new ActivityJournalError("Invalid path.", 400);
        }
      });

    // Valid paths: /activity or /activity/:id
    if (segments[0] !== "activity" && segments[0] !== "activity-events") {
      return reply({ error: "not found" }, 404);
    }

    if (segments.length > 2) {
      return reply({ error: "not found" }, 404);
    }

    const eventId = segments[1];

    // Single event lookup: GET /activity/:id
    if (eventId) {
      const event = core.get(eventId);
      if (!event) {
        return reply({ error: "not found" }, 404);
      }
      return reply({ event }, 200);
    }

    // List events: GET /activity
    const searchParams = url.searchParams;
    for (const key of searchParams.keys()) {
      if (!SUPPORTED_QUERY_PARAMS.has(key)) {
        throw new ActivityJournalError(`Unsupported query parameter: '${key}'.`, 400);
      }
    }

    const filter: ActivityQueryFilter = {};

    const projectPath = parseNonEmptyParam(searchParams, "projectPath");
    if (projectPath !== undefined) filter.projectPath = projectPath;

    const actorType = parseNonEmptyParam(searchParams, "actorType");
    if (actorType !== undefined) {
      if (!VALID_ACTOR_TYPES.has(actorType as ActivityActorType)) {
        throw new ActivityJournalError(`Invalid actorType: '${actorType}'.`, 400);
      }
      filter.actorType = actorType as ActivityActorType;
    }

    const actorId = parseNonEmptyParam(searchParams, "actorId");
    if (actorId !== undefined) filter.actorId = actorId;

    const employeeId = parseNonEmptyParam(searchParams, "employeeId");
    if (employeeId !== undefined) filter.employeeId = employeeId;

    const eventType = parseNonEmptyParam(searchParams, "eventType");
    if (eventType !== undefined) filter.eventType = eventType;

    const targetType = parseNonEmptyParam(searchParams, "targetType");
    if (targetType !== undefined) {
      if (!VALID_TARGET_TYPES.has(targetType as ActivityTargetType)) {
        throw new ActivityJournalError(`Invalid targetType: '${targetType}'.`, 400);
      }
      filter.targetType = targetType as ActivityTargetType;
    }

    const targetId = parseNonEmptyParam(searchParams, "targetId");
    if (targetId !== undefined) filter.targetId = targetId;

    const taskId = parseNonEmptyParam(searchParams, "taskId");
    if (taskId !== undefined) filter.taskId = taskId;

    const runId = parseNonEmptyParam(searchParams, "runId");
    if (runId !== undefined) filter.runId = runId;

    if (searchParams.has("since")) {
      filter.since = parseNonNegativeTimestamp(searchParams.get("since") ?? "", "since");
    }
    if (searchParams.has("from")) {
      filter.from = parseNonNegativeTimestamp(searchParams.get("from") ?? "", "from");
    }
    if (searchParams.has("until")) {
      filter.until = parseNonNegativeTimestamp(searchParams.get("until") ?? "", "until");
    }
    if (searchParams.has("to")) {
      filter.to = parseNonNegativeTimestamp(searchParams.get("to") ?? "", "to");
    }

    if (searchParams.has("limit")) {
      const rawLimit = searchParams.get("limit") ?? "";
      if (!/^\d+$/.test(rawLimit)) {
        throw new ActivityJournalError("Invalid 'limit' parameter: must be an integer between 1 and 100.", 400);
      }
      const parsedLimit = Number(rawLimit);
      if (!Number.isSafeInteger(parsedLimit) || parsedLimit < 1 || parsedLimit > 100) {
        throw new ActivityJournalError("Invalid 'limit' parameter: must be an integer between 1 and 100.", 400);
      }
      filter.limit = parsedLimit;
    }

    if (searchParams.has("cursor")) {
      const rawCursor = searchParams.get("cursor") ?? "";
      if (!/^[1-9]\d*$/.test(rawCursor) || !Number.isSafeInteger(Number(rawCursor))) {
        throw new ActivityJournalError("Invalid 'cursor' parameter: must be a positive integer sequenceId.", 400);
      }
      filter.cursor = rawCursor;
    }

    if (searchParams.has("direction")) {
      const direction = searchParams.get("direction") ?? "";
      if (direction !== "forward" && direction !== "backward") {
        throw new ActivityJournalError("Invalid 'direction' parameter: must be 'forward' or 'backward'.", 400);
      }
      filter.direction = direction;
    }

    const response = core.list(filter);
    return reply(response, 200);
  } catch (error) {
    if (error instanceof ActivityJournalError) {
      return reply({ error: error.message }, error.status);
    }
    return reply({ error: "Internal server error." }, 500);
  }
}
