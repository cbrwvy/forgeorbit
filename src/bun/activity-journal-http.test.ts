import { beforeAll, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const isolated = realpathSync(mkdtempSync(path.join(tmpdir(), "fo015a1-http-env-")));
process.env.AGETOR_DATA_DIR = isolated;
process.env.HOME = isolated;
process.env.AGETOR_USAGE_OFFLINE = "1";

import { migrate } from "./migrate.ts";
import { migrations } from "./migrations/index.ts";
import { ActivityJournalCore } from "./activity-journal-core.ts";

let activityHttp: typeof import("./activity-http.ts").activityHttp;

beforeAll(async () => {
  ({ activityHttp } = await import("./activity-http.ts"));
});

function setup() {
  const db = new Database(":memory:");
  migrate(db, migrations);
  const core = new ActivityJournalCore(db, { now: () => 1000 });
  return { db, core };
}

test("19. Authenticated API: rejects unauthenticated requests with 401", async () => {
  const { db, core } = setup();
  try {
    const req = new Request("http://localhost:4318/activity", { method: "GET" });
    const res = await activityHttp(req, false, { core });
    expect(res.status).toBe(401);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe("unauthorized");
  } finally {
    db.close();
  }
});

test("19. Authenticated API: authorized GET /activity returns events and pagination", async () => {
  const { db, core } = setup();
  try {
    core.record({
      eventType: "task.proposal.created",
      projectPath: "/tmp/proj",
      actorType: "project-manager",
      targetType: "proposal",
      targetId: "prop-1",
      idempotencyKey: "key-1",
      createdAt: 1000,
    });
    core.record({
      eventType: "task.assignment.approved",
      projectPath: "/tmp/proj",
      actorType: "owner",
      targetType: "proposal",
      targetId: "prop-1",
      taskId: "task-1",
      employeeId: "emp-1",
      idempotencyKey: "key-2",
      createdAt: 2000,
    });

    const req = new Request("http://localhost:4318/activity?projectPath=%2Ftmp%2Fproj&limit=10", {
      method: "GET",
    });
    const res = await activityHttp(req, true, { core });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { events: unknown[]; hasMore: boolean; nextCursor: string | null };
    expect(body.events.length).toBe(2);
    expect(body.hasMore).toBe(false);

    // Filter using `from` and `to` aliases
    const reqRange = new Request("http://localhost:4318/activity?from=1500&to=2500", { method: "GET" });
    const resRange = await activityHttp(reqRange, true, { core });
    expect(resRange.status).toBe(200);
    const bodyRange = (await resRange.json()) as { events: { eventType: string }[] };
    expect(bodyRange.events.length).toBe(1);
    expect(bodyRange.events[0]!.eventType).toBe("task.assignment.approved");

    // Filter using `since` and `until`
    const reqSince = new Request("http://localhost:4318/activity?since=500&until=1500", { method: "GET" });
    const resSince = await activityHttp(reqSince, true, { core });
    expect(resSince.status).toBe(200);
    const bodySince = (await resSince.json()) as { events: { eventType: string }[] };
    expect(bodySince.events.length).toBe(1);
    expect(bodySince.events[0]!.eventType).toBe("task.proposal.created");
  } finally {
    db.close();
  }
});

test("19. Authenticated API: GET /activity/:id returns single event, 404 if not found", async () => {
  const { db, core } = setup();
  try {
    const recorded = core.record({
      eventType: "employee.hired",
      actorType: "owner",
      targetType: "employee",
      targetId: "emp-abc",
      employeeId: "emp-abc",
      idempotencyKey: "key-hired",
    });

    const reqFound = new Request(`http://localhost:4318/activity/${recorded.event.id}`, { method: "GET" });
    const resFound = await activityHttp(reqFound, true, { core });
    expect(resFound.status).toBe(200);
    const bodyFound = (await resFound.json()) as { event: { id: string; eventType: string } };
    expect(bodyFound.event.id).toBe(recorded.event.id);
    expect(bodyFound.event.eventType).toBe("employee.hired");

    const reqNotFound = new Request(`http://localhost:4318/activity/non-existent-id`, { method: "GET" });
    const resNotFound = await activityHttp(reqNotFound, true, { core });
    expect(resNotFound.status).toBe(404);
  } finally {
    db.close();
  }
});

test("20. No arbitrary client event writes: POST, PUT, DELETE, PATCH return 405 Method Not Allowed", async () => {
  const { db, core } = setup();
  try {
    const methods = ["POST", "PUT", "DELETE", "PATCH"] as const;
    for (const method of methods) {
      const req = new Request("http://localhost:4318/activity", {
        method,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ eventType: "arbitrary.client.event" }),
      });
      const res = await activityHttp(req, true, { core });
      expect(res.status).toBe(405);
      const body = (await res.json()) as { error: string };
      expect(body.error).toContain("Method not allowed");
    }

    expect(core.count()).toBe(0);
  } finally {
    db.close();
  }
});

test("25. [P2-1] Strict HTTP query validation rejects invalid cursor, actorType, targetType, limit, since/until, from/to, direction, eventType, and unknown params with 400", async () => {
  const { db, core } = setup();
  try {
    const invalidUrls = [
      "http://localhost:4318/activity?cursor=invalid",
      "http://localhost:4318/activity?cursor=0",
      "http://localhost:4318/activity?cursor=-5",
      "http://localhost:4318/activity?cursor=1729939900000:41",
      "http://localhost:4318/activity?cursor=",
      "http://localhost:4318/activity?actorType=hacker",
      "http://localhost:4318/activity?actorType=",
      "http://localhost:4318/activity?targetType=invalid-target",
      "http://localhost:4318/activity?targetType=",
      "http://localhost:4318/activity?limit=0",
      "http://localhost:4318/activity?limit=-10",
      "http://localhost:4318/activity?limit=101",
      "http://localhost:4318/activity?limit=abc",
      "http://localhost:4318/activity?limit=1.5",
      "http://localhost:4318/activity?limit=",
      "http://localhost:4318/activity?since=abc",
      "http://localhost:4318/activity?since=-1",
      "http://localhost:4318/activity?until=xyz",
      "http://localhost:4318/activity?until=-100",
      "http://localhost:4318/activity?from=not-a-timestamp",
      "http://localhost:4318/activity?to=-5",
      "http://localhost:4318/activity?since=2000&until=1000",
      "http://localhost:4318/activity?from=2000&to=1000",
      "http://localhost:4318/activity?since=1000&from=2000",
      "http://localhost:4318/activity?until=1000&to=2000",
      "http://localhost:4318/activity?direction=sideways",
      "http://localhost:4318/activity?eventType=nonexistent.event",
      "http://localhost:4318/activity?unknownParam=123",
    ];

    for (const url of invalidUrls) {
      const req = new Request(url, { method: "GET" });
      const res = await activityHttp(req, true, { core });
      expect(res.status).toBe(400);
      const body = (await res.json()) as { error: string };
      expect(typeof body.error).toBe("string");
      expect(body.error.length).toBeGreaterThan(0);
    }
  } finally {
    db.close();
  }
});
