import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const isolated = realpathSync(mkdtempSync(path.join(tmpdir(), "fo015a1-core-env-")));
process.env.AGETOR_DATA_DIR = isolated;
process.env.HOME = isolated;
process.env.AGETOR_USAGE_OFFLINE = "1";

import { migrate } from "./migrate.ts";
import { migrations } from "./migrations/index.ts";
import {
  ActivityJournalCore,
  ActivityJournalError,
  EVENT_PAYLOAD_SCHEMAS,
  PAYLOAD_LIMITS,
  sanitizePayload,
} from "./activity-journal-core.ts";
import { subscribeAppEvents } from "./quit-guard.ts";
import { ACTIVITY_EVENT_TYPES, type ActivityEventType } from "../shared/activity/types.ts";
import type { AppEvent } from "../shared/types.ts";

function createTestDb(): Database {
  const db = new Database(":memory:");
  migrate(db, migrations);
  return db;
}

test("5. Idempotent event insertion returns existing record with created: false and emits SSE only once", async () => {
  const db = createTestDb();
  const sseEvents: Extract<AppEvent, { type: "activity_event" }>[] = [];
  const unsubscribe = subscribeAppEvents((e) => {
    if (e.type === "activity_event") sseEvents.push(e);
  });
  try {
    const core = new ActivityJournalCore(db, { now: () => 1000 });

    const first = core.record({
      eventType: "task.assignment.approved",
      actorType: "owner",
      actorId: "owner",
      targetType: "proposal",
      targetId: "prop-123",
      taskId: "task-456",
      employeeId: "emp-789",
      idempotencyKey: "assignment_proposal:prop-123:approved",
      payload: { note: "Approved initial" },
    });

    expect(first.created).toBe(true);
    expect(first.event.eventType).toBe("task.assignment.approved");
    expect(first.event.idempotencyKey).toBe("assignment_proposal:prop-123:approved");
    expect(first.event.sequenceId).toBe(1);

    // Replay with exact same idempotency_key
    const second = core.record({
      eventType: "task.assignment.approved",
      actorType: "owner",
      actorId: "owner",
      targetType: "proposal",
      targetId: "prop-123",
      taskId: "task-456",
      employeeId: "emp-789",
      idempotencyKey: "assignment_proposal:prop-123:approved",
      payload: { note: "Attempted duplicate" },
    });

    expect(second.created).toBe(false);
    expect(second.event.id).toBe(first.event.id);
    expect(second.event.sequenceId).toBe(1);
    expect(second.event.payload.note).toBe("Approved initial");

    expect(core.count()).toBe(1);

    await Bun.sleep(10);
    expect(sseEvents.filter((e) => e.eventId === first.event.id).length).toBe(1);
  } finally {
    unsubscribe();
    db.close();
  }
});

test("6. Concurrent writes across two WAL connections serialize cleanly with unique sequence numbers", async () => {
  const file = path.join(mkdtempSync(path.join(tmpdir(), "fo015a1-concurrent-")), "fixture.sqlite");
  const connA = new Database(file);
  connA.exec("PRAGMA journal_mode=WAL");
  connA.exec("PRAGMA busy_timeout=5000");
  migrate(connA, migrations);

  const connB = new Database(file);
  connB.exec("PRAGMA busy_timeout=5000");

  try {
    const coreA = new ActivityJournalCore(connA, { now: () => 1000 });
    const coreB = new ActivityJournalCore(connB, { now: () => 1000 });

    const e1 = coreA.record({
      eventType: "execution.reviewed",
      actorType: "owner",
      targetType: "execution",
      targetId: "exec-1",
      idempotencyKey: "key-1",
    });
    const e2 = coreB.record({
      eventType: "execution.approved",
      actorType: "owner",
      targetType: "execution",
      targetId: "exec-1",
      idempotencyKey: "key-2",
    });
    const e3 = coreA.record({
      eventType: "execution.started",
      actorType: "system",
      targetType: "execution",
      targetId: "exec-1",
      idempotencyKey: "key-3",
    });
    const e4 = coreB.record({
      eventType: "run.completed",
      actorType: "employee",
      targetType: "task",
      targetId: "task-1",
      idempotencyKey: "key-4",
    });

    expect(e1.event.sequenceId).toBe(1);
    expect(e2.event.sequenceId).toBe(2);
    expect(e3.event.sequenceId).toBe(3);
    expect(e4.event.sequenceId).toBe(4);

    const list = coreB.list({ direction: "forward" });
    expect(list.events.map((e) => e.sequenceId)).toEqual([1, 2, 3, 4]);
  } finally {
    connA.close();
    connB.close();
  }
});

test("7. [P1-2] Transaction rollback, nested savepoints, sequence reuse, and fault injection never emit phantom SSE events", async () => {
  const db = createTestDb();
  const sseEvents: Extract<AppEvent, { type: "activity_event" }>[] = [];
  const unsubscribe = subscribeAppEvents((e) => {
    if (e.type === "activity_event") sseEvents.push(e);
  });

  try {
    const core = new ActivityJournalCore(db, { now: () => 2000 });

    // Case A: Outer transaction rolls back
    expect(() => {
      db.transaction(() => {
        core.record({
          id: "evt-rollback-outer",
          eventType: "task.proposal.created",
          actorType: "project-manager",
          targetType: "proposal",
          targetId: "prop-fail",
          idempotencyKey: "key-fail",
        });
        // Attempting manual flush while transaction is still open must emit 0 events
        expect(core.flushNotifications()).toBe(0);
        throw new Error("Simulated business operation crash");
      })();
    }).toThrow("Simulated business operation crash");

    await Bun.sleep(10);
    expect(core.count()).toBe(0);
    expect(sseEvents.length).toBe(0);

    // Case B: Sequence ID reuse immediately after rollback before microtask runs
    expect(() => {
      db.transaction(() => {
        core.record({
          id: "evt-rolled-back-seq",
          eventType: "employee.hired",
          actorType: "owner",
          targetType: "employee",
          targetId: "emp-phantom",
          idempotencyKey: "key-phantom",
        });
        throw new Error("Abort phantom");
      })();
    }).toThrow("Abort phantom");

    const realAfterRollback = db.transaction(() => {
      return core.record({
        id: "evt-real-committed",
        eventType: "employee.hired",
        actorType: "owner",
        targetType: "employee",
        targetId: "emp-real",
        idempotencyKey: "key-real",
      });
    })();

    await Bun.sleep(10);
    expect(sseEvents.map((e) => e.eventId)).toEqual([realAfterRollback.event.id]);
    expect(sseEvents.some((e) => e.eventId === "evt-rolled-back-seq")).toBe(false);

    // Case C: Nested transaction (SAVEPOINT) rolls back while outer transaction commits
    sseEvents.length = 0;
    db.transaction(() => {
      core.record({
        id: "evt-outer-kept",
        eventType: "employee.assigned",
        actorType: "owner",
        targetType: "task",
        targetId: "task-outer",
        idempotencyKey: "key-outer-kept",
      });

      try {
        db.transaction(() => {
          core.record({
            id: "evt-inner-aborted",
            eventType: "employee.unassigned",
            actorType: "owner",
            targetType: "task",
            targetId: "task-inner",
            idempotencyKey: "key-inner-aborted",
          });
          throw new Error("Abort inner savepoint");
        })();
      } catch {
        // Outer transaction catches inner error and continues to commit
      }
    })();

    await Bun.sleep(10);
    expect(sseEvents.map((e) => e.eventId)).toEqual(["evt-outer-kept"]);
    expect(core.get("evt-inner-aborted")).toBeNull();
    expect(core.get("evt-outer-kept")?.id).toBe("evt-outer-kept");

    // Case D: Inner savepoint succeeds, but outer transaction later throws and rolls back
    sseEvents.length = 0;
    expect(() => {
      db.transaction(() => {
        db.transaction(() => {
          core.record({
            id: "evt-inner-committed-outer-aborted",
            eventType: "turn.proposed",
            actorType: "owner",
            targetType: "turn",
            targetId: "turn-nested-fail",
            idempotencyKey: "key-nested-fail",
          });
        })();
        throw new Error("Outer failed after inner savepoint");
      })();
    }).toThrow("Outer failed after inner savepoint");

    await Bun.sleep(10);
    expect(sseEvents.length).toBe(0);
    expect(core.get("evt-inner-committed-outer-aborted")).toBeNull();

    // Case E: Fault injection in SSE listener does not affect SQLite persistence
    const throwingUnsub = subscribeAppEvents(() => {
      throw new Error("Simulated SSE subscriber failure");
    });
    try {
      const faultEvent = core.record({
        id: "evt-survives-sse-throw",
        eventType: "employee.archived",
        actorType: "owner",
        targetType: "employee",
        targetId: "emp-survive",
        idempotencyKey: "key-survive",
      });
      await Bun.sleep(10);
      expect(core.get(faultEvent.event.id)?.id).toBe("evt-survives-sse-throw");
    } finally {
      throwingUnsub();
    }
  } finally {
    unsubscribe();
    db.close();
  }
});

test("13. Correct Actor and Target attribution", () => {
  const db = createTestDb();
  try {
    const core = new ActivityJournalCore(db);

    const pmEvent = core.record({
      eventType: "task.proposal.created",
      projectPath: "/code/proj-a",
      actorType: "project-manager",
      actorId: "pm-alice",
      targetType: "proposal",
      targetId: "prop-10",
      idempotencyKey: "pm-event-1",
    }).event;

    expect(pmEvent.actorType).toBe("project-manager");
    expect(pmEvent.actorId).toBe("pm-alice");
    expect(pmEvent.targetType).toBe("proposal");
    expect(pmEvent.targetId).toBe("prop-10");
    expect(pmEvent.projectPath).toBe("/code/proj-a");

    const ownerEvent = core.record({
      eventType: "execution.approved",
      projectPath: "/code/proj-a",
      actorType: "owner",
      actorId: "owner",
      targetType: "execution",
      targetId: "exec-20",
      taskId: "task-30",
      employeeId: "emp-40",
      idempotencyKey: "owner-event-1",
    }).event;

    expect(ownerEvent.actorType).toBe("owner");
    expect(ownerEvent.actorId).toBe("owner");
    expect(ownerEvent.targetType).toBe("execution");
    expect(ownerEvent.targetId).toBe("exec-20");
    expect(ownerEvent.taskId).toBe("task-30");
    expect(ownerEvent.employeeId).toBe("emp-40");
  } finally {
    db.close();
  }
});

test("14. No invented completion: start event is strictly separate from run completion", () => {
  const db = createTestDb();
  try {
    const core = new ActivityJournalCore(db);

    core.record({
      eventType: "execution.started",
      actorType: "system",
      targetType: "execution",
      targetId: "exec-100",
      taskId: "task-100",
      runId: "run-100",
      idempotencyKey: "start-100",
    });

    const events = core.list().events;
    expect(events.length).toBe(1);
    expect(events[0]!.eventType).toBe("execution.started");

    const completed = core.list({ eventType: "run.completed" }).events;
    expect(completed.length).toBe(0);
  } finally {
    db.close();
  }
});

test("15. Indeterminate semantics are clearly distinguished from failed or succeeded", () => {
  const db = createTestDb();
  try {
    const core = new ActivityJournalCore(db);

    core.record({
      eventType: "delivery.indeterminate",
      actorType: "system",
      targetType: "turn",
      targetId: "turn-crash",
      runId: "run-1",
      idempotencyKey: "indet-1",
      payload: { reason: "Transport disconnected; delivery unconfirmed", status: "indeterminate" },
    });

    const event = core.list().events[0]!;
    expect(event.eventType).toBe("delivery.indeterminate");
    expect(event.payload.reason).toBe("Transport disconnected; delivery unconfirmed");

    expect(core.list({ eventType: "run.completed" }).events.length).toBe(0);
    expect(core.list({ eventType: "run.failed" }).events.length).toBe(0);
  } finally {
    db.close();
  }
});

test("16. [P1-1] Cursor-based pagination traverses 25 events without duplicates or omissions", () => {
  const db = createTestDb();
  try {
    const core = new ActivityJournalCore(db);

    for (let i = 1; i <= 25; i++) {
      core.record({
        eventType: "turn.proposed",
        actorType: "owner",
        targetType: "turn",
        targetId: `turn-${i}`,
        idempotencyKey: `p-key-${i}`,
        payload: { index: i },
        createdAt: 1000 + i,
      });
    }

    const page1 = core.list({ limit: 10 });
    expect(page1.events.length).toBe(10);
    expect(page1.hasMore).toBe(true);
    expect(page1.events[0]!.sequenceId).toBe(25);
    expect(page1.events[9]!.sequenceId).toBe(16);
    expect(page1.nextCursor).toBe(String(page1.events[9]!.sequenceId));

    const page2 = core.list({ limit: 10, cursor: page1.nextCursor });
    expect(page2.events.length).toBe(10);
    expect(page2.hasMore).toBe(true);
    expect(page2.events[0]!.sequenceId).toBe(15);
    expect(page2.events[9]!.sequenceId).toBe(6);
    expect(page2.nextCursor).toBe(String(page2.events[9]!.sequenceId));

    const page3 = core.list({ limit: 10, cursor: page2.nextCursor });
    expect(page3.events.length).toBe(5);
    expect(page3.hasMore).toBe(false);
    expect(page3.events[0]!.sequenceId).toBe(5);
    expect(page3.events[4]!.sequenceId).toBe(1);
    expect(page3.nextCursor).toBeNull();

    const allRetrieved = [...page1.events, ...page2.events, ...page3.events];
    expect(allRetrieved.length).toBe(25);
    const seenSeq = new Set(allRetrieved.map((e) => e.sequenceId));
    expect(seenSeq.size).toBe(25);
  } finally {
    db.close();
  }
});

test("17. Project filtering isolates project events", () => {
  const db = createTestDb();
  try {
    const core = new ActivityJournalCore(db);

    core.record({
      eventType: "task.proposal.created",
      projectPath: "/code/project-alpha",
      actorType: "project-manager",
      targetType: "proposal",
      targetId: "prop-alpha",
      idempotencyKey: "alpha-1",
    });

    core.record({
      eventType: "task.proposal.created",
      projectPath: "/code/project-beta",
      actorType: "project-manager",
      targetType: "proposal",
      targetId: "prop-beta",
      idempotencyKey: "beta-1",
    });

    const alphaOnly = core.list({ projectPath: "/code/project-alpha" });
    expect(alphaOnly.events.length).toBe(1);
    expect(alphaOnly.events[0]!.projectPath).toBe("/code/project-alpha");

    const betaOnly = core.list({ projectPath: "/code/project-beta" });
    expect(betaOnly.events.length).toBe(1);
    expect(betaOnly.events[0]!.projectPath).toBe("/code/project-beta");
  } finally {
    db.close();
  }
});

test("18. Actor, Employee, and employee.unassigned [P2-2] filtering", () => {
  const db = createTestDb();
  try {
    const core = new ActivityJournalCore(db);

    core.record({
      eventType: "employee.hired",
      actorType: "owner",
      targetType: "employee",
      targetId: "emp-alice",
      employeeId: "emp-alice",
      idempotencyKey: "hired-alice",
    });

    core.record({
      eventType: "employee.assigned",
      actorType: "owner",
      targetType: "task",
      targetId: "task-1",
      employeeId: "emp-bob",
      idempotencyKey: "assigned-bob",
    });

    core.record({
      eventType: "employee.unassigned",
      actorType: "owner",
      targetType: "task",
      targetId: "task-1",
      employeeId: "emp-bob",
      idempotencyKey: "unassigned-bob",
      payload: {
        assignmentId: "assign-1",
        taskId: "task-1",
        employeeId: "emp-bob",
        revision: 2,
      },
    });

    const aliceEvents = core.list({ employeeId: "emp-alice" });
    expect(aliceEvents.events.length).toBe(1);
    expect(aliceEvents.events[0]!.employeeId).toBe("emp-alice");

    const bobEvents = core.list({ employeeId: "emp-bob" });
    expect(bobEvents.events.length).toBe(2);
    expect(bobEvents.events.map((e) => e.eventType)).toEqual(["employee.unassigned", "employee.assigned"]);

    const ownerActions = core.list({ actorType: "owner" });
    expect(ownerActions.events.length).toBe(3);
  } finally {
    db.close();
  }
});

test("21. [P1-4] Strict event-type-specific allowlist schemas, forbidden key stripping, secret redaction, and bounds", () => {
  const db = createTestDb();
  try {
    const core = new ActivityJournalCore(db);

    // 1. Verify every ActivityEventType has an explicit schema in EVENT_PAYLOAD_SCHEMAS
    for (const eventType of ACTIVITY_EVENT_TYPES) {
      expect(EVENT_PAYLOAD_SCHEMAS[eventType]).toBeDefined();
    }

    // 2. Reject unknown event types explicitly
    expect(() => {
      core.record({
        eventType: "unknown.forged.event" as ActivityEventType,
        actorType: "owner",
        targetType: "company",
        targetId: "comp-1",
      });
    }).toThrow(ActivityJournalError);

    // 3. Test standalone sanitizePayload with all forbidden keys, embedded secrets, arrays, and deep nesting
    const dirty = {
      taskId: "task-1",
      employeeName: "Alice",
      prompt: "This is a super sensitive prompt with internal secrets and user instructions",
      promptMarkdown: "# Full Professional Role Markdown\nSecret system instructions...",
      adaptedPrompt: "Adapted prompt for CLI execution",
      password: "super_secret_password_123",
      token: "github_pat_11AAAAAA000000000000000000",
      apiKey: "sk-proj-99999999999999999999",
      api_key: "sk-ant-api03-1234567890abcdef12345678",
      access_token: "ghp_1234567890abcdefghijklmnopqrstuv",
      private_key: "-----BEGIN RSA PRIVATE KEY-----\nMIIEpAIBAAKCAQEA...\n-----END RSA PRIVATE KEY-----",
      authorization: "Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c",
      keyChain: "sensitive keychain ref",
      message: "Turn message text from user",
      content: "Full file or message content",
      metadata: { internalSecret: "hidden" },
      description: "Task description with secret details",
      error: "Error: CLI failed\n    at ChildProcess.exithandler (node:child_process:422:12)",
      stdout: "CLI stdout dump",
      stderr: "CLI stderr dump",
      reason:
        "Failed with key sk-proj-1234567890abcdef12345678 and Bearer secret_bearer_token_999999 and api_key=my_secret_key_val\n    at Object.run (/app/src/runner.ts:10:5)",
      nested: {
        safeField: "safe value",
        secret: "nested secret",
        token: "nested token",
        promptMarkdown: "nested markdown",
        api_key: "nested api key",
        level2: {
          allowedAtDepth2: "ok",
          level3ExceedsMaxDepth: {
            dropped: "must not survive depth limit",
          },
        },
      },
      longArray: Array.from({ length: 35 }, (_, i) => (i === 0 ? `item-${i}-${"x".repeat(250)}` : `item-${i}`)),
    };

    const clean = sanitizePayload(dirty);

    // Raw prompt is replaced with SHA256 and length only
    expect(clean.prompt).toBeUndefined();
    expect(typeof clean.promptSha256).toBe("string");
    expect((clean.promptSha256 as string).length).toBe(64);
    expect(clean.promptLength).toBe(dirty.prompt.length);

    // All sensitive and unvalidated prose keys stripped
    expect(clean.promptMarkdown).toBeUndefined();
    expect(clean.adaptedPrompt).toBeUndefined();
    expect(clean.password).toBeUndefined();
    expect(clean.token).toBeUndefined();
    expect(clean.apiKey).toBeUndefined();
    expect(clean.api_key).toBeUndefined();
    expect(clean.access_token).toBeUndefined();
    expect(clean.private_key).toBeUndefined();
    expect(clean.authorization).toBeUndefined();
    expect(clean.keyChain).toBeUndefined();
    expect(clean.message).toBeUndefined();
    expect(clean.content).toBeUndefined();
    expect(clean.metadata).toBeUndefined();
    expect(clean.description).toBeUndefined();
    expect(clean.error).toBeUndefined();
    expect(clean.stdout).toBeUndefined();
    expect(clean.stderr).toBeUndefined();

    // Embedded secrets and stack traces inside allowed string fields are redacted
    expect(typeof clean.reason).toBe("string");
    expect(clean.reason as string).not.toContain("sk-proj-1234567890abcdef12345678");
    expect(clean.reason as string).not.toContain("secret_bearer_token_999999");
    expect(clean.reason as string).not.toContain("my_secret_key_val");
    expect(clean.reason as string).not.toContain("at Object.run");
    expect(clean.reason as string).toContain("[redacted]");

    // Nested sensitive keys stripped and maxDepth (3) enforced
    const nested = clean.nested as Record<string, unknown>;
    expect(nested.safeField).toBe("safe value");
    expect(nested.secret).toBeUndefined();
    expect(nested.token).toBeUndefined();
    expect(nested.promptMarkdown).toBeUndefined();
    expect(nested.api_key).toBeUndefined();
    const level2 = nested.level2 as Record<string, unknown>;
    expect(level2.allowedAtDepth2).toBe("ok");
    expect(level2.level3ExceedsMaxDepth).toBeUndefined();

    // Array length capped at 20 and item strings capped at 200 chars (+ ellipsis)
    const arr = clean.longArray as string[];
    expect(arr.length).toBe(PAYLOAD_LIMITS.maxArrayItems);
    expect(arr[0]!.length).toBeLessThanOrEqual(PAYLOAD_LIMITS.maxArrayStringChars + 1);
    expect(Buffer.byteLength(JSON.stringify(clean), "utf8")).toBeLessThanOrEqual(PAYLOAD_LIMITS.maxPayloadBytes);

    // 4. Test per-event allowlist enforcement in core.record()
    const recorded = core.record({
      eventType: "run.failed",
      actorType: "employee",
      actorId: "emp-1",
      targetType: "task",
      targetId: "task-1",
      idempotencyKey: "run-failed-allowlist-test",
      payload: {
        attemptId: "att-1",
        taskId: "task-1",
        taskTitle: "Build Auth",
        employeeId: "emp-1",
        employeeName: "Alice",
        runId: "run-1",
        result: "failed",
        reason: "Auth failed with token ghp_1234567890abcdefghijklmnopqrstuv and -----BEGIN PRIVATE KEY-----\nabc\n-----END PRIVATE KEY-----",
        finishedAt: 5000,
        // Disallowed fields for run.failed:
        promptMarkdown: "# Secret Markdown",
        adaptedPrompt: "Secret prompt",
        api_key: "sk-1234567890abcdef12345678",
        access_token: "tok-123",
        private_key: "priv-123",
        message: "user message",
        content: "raw content",
        metadata: { nested: true },
        description: "desc",
        error: "raw error stack",
        unexpectedField: "should be dropped by allowlist",
        unexpectedArray: ["a", "b"],
        unexpectedObject: { foo: "bar" },
      },
    });

    const p = recorded.event.payload;
    expect(Object.keys(p).sort()).toEqual(
      ["attemptId", "employeeId", "employeeName", "finishedAt", "reason", "result", "runId", "taskId", "taskTitle"].sort(),
    );
    expect(p.promptMarkdown).toBeUndefined();
    expect(p.adaptedPrompt).toBeUndefined();
    expect(p.api_key).toBeUndefined();
    expect(p.access_token).toBeUndefined();
    expect(p.private_key).toBeUndefined();
    expect(p.message).toBeUndefined();
    expect(p.content).toBeUndefined();
    expect(p.metadata).toBeUndefined();
    expect(p.description).toBeUndefined();
    expect(p.error).toBeUndefined();
    expect(p.unexpectedField).toBeUndefined();
    expect(p.unexpectedArray).toBeUndefined();
    expect(p.unexpectedObject).toBeUndefined();
    expect(String(p.reason)).not.toContain("ghp_1234567890abcdefghijklmnopqrstuv");
    expect(String(p.reason)).not.toContain("BEGIN PRIVATE KEY");
    expect(String(p.reason)).toContain("[redacted");
  } finally {
    db.close();
  }
});
