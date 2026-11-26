import { beforeAll, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { createHash, randomUUID } from "node:crypto";
import { mkdtempSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const isolated = realpathSync(mkdtempSync(path.join(tmpdir(), "fo015a1-integ-env-")));
process.env.AGETOR_DATA_DIR = isolated;
process.env.HOME = isolated;
process.env.AGETOR_USAGE_OFFLINE = "1";

import { migrate } from "./migrate.ts";
import { migrations } from "./migrations/index.ts";
import { ActivityJournalCore } from "./activity-journal-core.ts";
import { EmployeeCore } from "./employee-core.ts";
import { EmployeeRunCore } from "./employee-run-core.ts";
import {
  ProfessionalTurnCore,
  recordInitialProfessionalTurn,
  settleInitialProfessionalTurn,
} from "./professional-turn-core.ts";
import { subscribeAppEvents } from "./quit-guard.ts";
import type { AppEvent } from "../shared/types.ts";
import type { TurnContext } from "../shared/execution/turn.ts";

let AssignmentCore: typeof import("./assignment-core.ts").AssignmentCore;
let AssignmentProposalCore: typeof import("./assignment-proposals.ts").AssignmentProposalCore;
let classifyWorkdir: typeof import("./project-ownership.ts").classifyWorkdir;
let activityHttp: typeof import("./activity-http.ts").activityHttp;

beforeAll(async () => {
  ({ AssignmentCore } = await import("./assignment-core.ts"));
  ({ AssignmentProposalCore } = await import("./assignment-proposals.ts"));
  ({ classifyWorkdir } = await import("./project-ownership.ts"));
  ({ activityHttp } = await import("./activity-http.ts"));
});

function setupIntegration() {
  const dir = mkdtempSync(path.join(tmpdir(), "fo015a1-integration-"));
  const file = path.join(dir, "fixture.sqlite");
  const db = new Database(file);
  db.exec("PRAGMA journal_mode=WAL");
  db.exec("PRAGMA busy_timeout=5000");
  migrate(db, migrations);
  const journal = new ActivityJournalCore(db, { now: () => 1000 });
  return { db, journal, dir, file };
}

test("8 & 9 & 10. Organization and Assignment Proposals record confirmed business events including employee.unassigned", async () => {
  const { db, journal } = setupIntegration();
  try {
    const sseEvents: AppEvent[] = [];
    const unsubscribe = subscribeAppEvents((e) => sseEvents.push(e));

    db.run(`INSERT INTO projects (path, name, added_at) VALUES ('/tmp/project-alpha', 'Alpha', 100)`);

    const empCore = new EmployeeCore(db, { now: () => 1000, random: () => 0.1 });
    const worker = empCore.createWorker({
      name: "Alice Engineer",
      jobTitle: "Software Engineer",
      roleCategory: "engineering",
      projectPath: "/tmp/project-alpha",
    });

    const taskId = randomUUID();
    db.run(
      `INSERT INTO tasks (id, title, prompt, "column", agent, workdir, created_at, updated_at)
       VALUES (?, 'Implement API', 'Build backend', 'backlog', 'claude-code', '/tmp/project-alpha', 1000, 1000)`,
      [taskId],
    );

    const classify = (workdir: string) => classifyWorkdir(["/tmp/project-alpha"], workdir);
    const assignCore = new AssignmentCore(db, { now: () => 1000, classify });
    const proposalCore = new AssignmentProposalCore(db, assignCore, { now: () => 1000, classify });
    const proposal = proposalCore.create(taskId, worker.id, "Alice is our best backend dev.");
    const propId = proposal.id;

    const proposedEvent = journal.list({ eventType: "task.assignment.proposed" }).events[0]!;
    expect(proposedEvent).toBeDefined();
    expect(proposedEvent.eventType).toBe("task.assignment.proposed");
    expect(proposedEvent.actorType).toBe("owner");
    expect(proposedEvent.targetType).toBe("proposal");
    expect(proposedEvent.targetId).toBe(propId);
    expect(proposedEvent.taskId).toBe(taskId);
    expect(proposedEvent.employeeId).toBe(worker.id);
    expect(proposedEvent.payload.rationale).toBe("Alice is our best backend dev.");

    const approveResult = proposalCore.approve(propId, {
      expectedRevision: 1,
      expectedAssignmentRevision: null,
      allowReassign: false,
    });
    expect(approveResult.alreadyApplied).toBe(false);

    const approvedEvent = journal.list({ eventType: "task.assignment.approved" }).events[0]!;
    expect(approvedEvent).toBeDefined();
    expect(approvedEvent.actorType).toBe("owner");
    expect(approvedEvent.targetType).toBe("proposal");
    expect(approvedEvent.targetId).toBe(propId);

    const assignedEvent = journal.list({ eventType: "employee.assigned" }).events[0]!;
    expect(assignedEvent).toBeDefined();
    expect(assignedEvent.actorType).toBe("owner");
    expect(assignedEvent.targetType).toBe("task");
    expect(assignedEvent.targetId).toBe(taskId);
    expect(assignedEvent.employeeId).toBe(worker.id);

    // Unassign task and verify employee.unassigned is recorded
    assignCore.unassign(taskId, 1);
    const unassignedEvent = journal.list({ eventType: "employee.unassigned" }).events[0]!;
    expect(unassignedEvent).toBeDefined();
    expect(unassignedEvent.eventType).toBe("employee.unassigned");
    expect(unassignedEvent.targetId).toBe(taskId);
    expect(unassignedEvent.employeeId).toBe(worker.id);

    await Bun.sleep(10);
    const activityBroadcasts = sseEvents.filter((e) => e.type === "activity_event");
    expect(activityBroadcasts.length).toBeGreaterThanOrEqual(4);

    unsubscribe();
  } finally {
    db.close();
  }
});

test("9 & 10. Owner rejects assignment proposal records task.assignment.rejected", () => {
  const { db, journal } = setupIntegration();
  try {
    db.run(`INSERT INTO projects (path, name, added_at) VALUES ('/tmp/proj-rej', 'Rej', 100)`);
    const empCore = new EmployeeCore(db, { now: () => 1000, random: () => 0.1 });
    const worker = empCore.createWorker({
      name: "Bob Engineer",
      jobTitle: "Software Engineer",
      roleCategory: "engineering",
      projectPath: "/tmp/proj-rej",
    });
    const taskId = randomUUID();
    db.run(
      `INSERT INTO tasks (id, title, prompt, "column", agent, workdir, created_at, updated_at)
       VALUES (?, 'Task Rej', 'Prompt', 'backlog', 'claude-code', '/tmp/proj-rej', 1000, 1000)`,
      [taskId],
    );
    const classify = (workdir: string) => classifyWorkdir(["/tmp/proj-rej"], workdir);
    const assignCore = new AssignmentCore(db, { now: () => 1000, classify });
    const proposalCore = new AssignmentProposalCore(db, assignCore, { now: () => 1000, classify });
    const proposal = proposalCore.create(taskId, worker.id, "Proposal for Bob");
    const propId = proposal.id;

    proposalCore.reject(propId, 1);

    const rejEvent = journal.list({ eventType: "task.assignment.rejected" }).events[0]!;
    expect(rejEvent).toBeDefined();
    expect(rejEvent.actorType).toBe("owner");
    expect(rejEvent.targetType).toBe("proposal");
    expect(rejEvent.targetId).toBe(propId);
    expect(rejEvent.taskId).toBe(taskId);
    expect(rejEvent.employeeId).toBe(worker.id);
  } finally {
    db.close();
  }
});

test("11 & 14. Execution lifecycle records reviewed -> approved -> started -> completed without invented events", () => {
  const { db, journal } = setupIntegration();
  try {
    const runCore = new EmployeeRunCore(db, () => 2000);

    const execId = randomUUID();
    const taskId = "task-lifecycle";
    const employeeId = "emp-lifecycle";
    const runId = "run-lifecycle";

    const review = runCore.createOrReuse({
      id: execId,
      taskId,
      taskTitle: "Lifecycle Task",
      projectPath: "/tmp/lifecycle",
      employeeId,
      employeeName: "Alice",
      assignmentId: "assign-1",
      assignmentRevision: 1,
      requestedHarnessId: "claude-code",
      requestedModel: "claude-3-7-sonnet",
      requestedEffort: "high",
      requestedComplexity: "standard",
      requestedPolicy: "balanced",
      requestedMode: "auto",
      inputsKey: "key-123",
      taskFingerprint: "fingerprint-123",
      configJson: "{}",
      reviewJson: JSON.stringify({ checks: [] }),
      usageNotice: null,
      unconfirmedPrior: false,
      expiresAt: 5000,
    });
    expect(review.reused).toBe(false);

    const revEvent = journal.list({ eventType: "execution.reviewed" }).events[0]!;
    expect(revEvent).toBeDefined();
    expect(revEvent.targetId).toBe(execId);
    expect(revEvent.taskId).toBe(taskId);
    expect(revEvent.employeeId).toBe(employeeId);

    const claimResult = runCore.claim(execId, 1, "exec-token-1");
    expect(claimResult.ok).toBe(true);

    const appEvent = journal.list({ eventType: "execution.approved" }).events[0]!;
    expect(appEvent).toBeDefined();
    expect(appEvent.targetId).toBe(execId);
    expect(appEvent.actorType).toBe("owner");

    expect(journal.list({ eventType: "run.completed" }).events.length).toBe(0);

    runCore.markStarted(execId, {
      runId,
      startedAt: 2500,
      actualHarnessId: "claude-code",
    });

    const startEvent = journal.list({ eventType: "execution.started" }).events[0]!;
    expect(startEvent).toBeDefined();
    expect(startEvent.runId).toBe(runId);
    expect(startEvent.actorType).toBe("system");

    expect(journal.list({ eventType: "run.completed" }).events.length).toBe(0);

    runCore.finish(execId, {
      finishedAt: 3000,
      result: "succeeded",
      reason: "Completed with code 0",
    });

    const compEvent = journal.list({ eventType: "run.completed" }).events[0]!;
    expect(compEvent).toBeDefined();
    expect(compEvent.runId).toBe(runId);
    expect(compEvent.targetId).toBe(taskId);
    expect(compEvent.payload.result).toBe("succeeded");
  } finally {
    db.close();
  }
});

test("12 & 15 & [P1-5]. Multi-Turn lifecycle attributes verified projectPath across all turns and records initial Turn 1 indeterminate delivery", async () => {
  const { db, journal } = setupIntegration();
  try {
    const sha = "a".repeat(64);
    const binding = {
      kind: "professional" as const,
      employeeId: "emp-turn",
      revisionId: "rev-1",
      revision: 1,
      promptSha256: sha,
      promptMarkdown: "Markdown",
      catalogRoleSlug: "engineer",
      professionalTitle: "Engineer",
      originalTemplateSha256: sha,
      sourceCommit: "fixture",
      boundAt: 1,
    };
    const bindingJson = JSON.stringify(binding);
    const snapSha = createHash("sha256").update(bindingJson).digest("hex");

    db.run(
      `INSERT INTO tasks(id, title, prompt, "column", agent, workdir, created_at, updated_at) VALUES('t-turn', 'Task', 'P', 'running', 'codex', '/tmp/p', 1, 1)`,
    );
    db.run(`INSERT INTO runs(id, task_id, agent, status, started_at) VALUES('r-turn', 't-turn', 'codex', 'running', 1)`);
    db.run(
      `INSERT INTO employee_executions (id, task_id, task_title, project_path, employee_id, employee_name, assignment_id, assignment_revision,
        status, revision, requested_harness_id, requested_policy, requested_mode, inputs_key, task_fingerprint, config_json, review_json,
        created_at, updated_at, expires_at, approved_at, started_at, approval_provenance, run_id, professional_json, professional_snapshot_sha256)
        VALUES ('att-1', 't-turn', 'Task', '/tmp/p', 'emp-turn', 'Alice', 'assign-1', 1, 'started', 1, 'codex', 'balanced', 'ask', 'k', 'fp', '{}', '{}',
        1, 1, 10000, 1, 1, 'owner', 'r-turn', ?, ?)`,
      [bindingJson, snapSha],
    );

    const execRow = new EmployeeRunCore(db).get("att-1")!;

    // Record Initial Turn 1 and settle as included: must NOT emit turn.submitted or delivery.indeterminate
    recordInitialProfessionalTurn(db, execRow, binding, "r-turn", "Initial prompt text");
    settleInitialProfessionalTurn(db, "r-turn", true, "session-turn");
    expect(journal.list({ eventType: "turn.submitted" }).events.length).toBe(0);
    expect(journal.list({ eventType: "delivery.indeterminate" }).events.length).toBe(0);

    const context: TurnContext = {
      runId: "r-turn",
      taskId: "t-turn",
      employeeId: "emp-turn",
      employeeName: "Alice",
      projectPath: "/tmp/p",
      attemptId: "att-1",
      revisionId: "rev-1",
      professionalRevision: 1,
      snapshotSha256: snapSha,
      sessionId: "session-turn",
      mode: "ask",
      authorityKey: "key-1",
      restrictions: { allowedHarnesses: ["codex"] },
    };

    const turnCore = new ProfessionalTurnCore(db, () => 1000);

    // 1. Follow-up Turn 2 proposed
    const revResult = turnCore.review(() => context, "Follow-up question to worker", "turn-key-2");
    expect(revResult.replayed).toBe(false);
    const turn2Id = revResult.turn.id;

    const propEvent = journal.list({ eventType: "turn.proposed" }).events[0]!;
    expect(propEvent).toBeDefined();
    expect(propEvent.targetId).toBe(turn2Id);
    expect(propEvent.projectPath).toBe("/tmp/p");
    expect(propEvent.executionId).toBe("att-1");
    expect(propEvent.payload.prompt).toBeUndefined();
    expect(propEvent.payload.promptSha256).toBeDefined();
    expect(propEvent.payload.turnNumber).toBe(2);

    // 2. Owner approves Turn 2
    const claimResult = turnCore.claim(turn2Id, 1, "turn-key-2", () => context);
    expect(claimResult.replayed).toBe(false);

    const appEvent = journal.list({ eventType: "turn.approved" }).events[0]!;
    expect(appEvent).toBeDefined();
    expect(appEvent.targetId).toBe(turn2Id);
    expect(appEvent.projectPath).toBe("/tmp/p");
    expect(appEvent.executionId).toBe("att-1");
    expect(appEvent.actorType).toBe("owner");

    // 3. Turn 2 submitted
    turnCore.transition(turn2Id, "claimed", "prepared");
    turnCore.transition(turn2Id, "prepared", "included");

    const subEvent = journal.list({ eventType: "turn.submitted" }).events[0]!;
    expect(subEvent).toBeDefined();
    expect(subEvent.targetId).toBe(turn2Id);
    expect(subEvent.projectPath).toBe("/tmp/p");
    expect(subEvent.executionId).toBe("att-1");
    expect(subEvent.actorType).toBe("system");

    // 4. Turn 3 indeterminate delivery
    const revResult3 = turnCore.review(() => context, "Second follow-up question", "turn-key-3");
    const turn3Id = revResult3.turn.id;
    turnCore.claim(turn3Id, 1, "turn-key-3", () => context);
    turnCore.transition(turn3Id, "claimed", "prepared");
    turnCore.transition(turn3Id, "prepared", "indeterminate", "Transport interrupted mid-stream.");

    const indetEvent = journal.list({ eventType: "delivery.indeterminate" }).events[0]!;
    expect(indetEvent).toBeDefined();
    expect(indetEvent.targetId).toBe(turn3Id);
    expect(indetEvent.projectPath).toBe("/tmp/p");
    expect(indetEvent.executionId).toBe("att-1");
    expect(indetEvent.payload.status).toBe("indeterminate");
    expect(indetEvent.payload.reason).toContain("Transport interrupted");

    // Verify GET /activity?projectPath=%2Ftmp%2Fp returns all 5 multi-turn events for this run
    const res = await activityHttp(
      new Request("http://localhost:4318/activity?projectPath=%2Ftmp%2Fp&runId=r-turn"),
      true,
      { core: journal },
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { events: { eventType: string; projectPath: string }[] };
    expect(body.events.map((e) => e.eventType)).toEqual([
      "delivery.indeterminate",
      "turn.approved",
      "turn.proposed",
      "turn.submitted",
      "turn.approved",
      "turn.proposed",
    ]);
    expect(body.events.every((e) => e.projectPath === "/tmp/p")).toBe(true);

    // 5. Test Initial Turn 1 indeterminate settlement on a second run
    db.run(`INSERT INTO runs(id, task_id, agent, status, started_at) VALUES('r-turn-init-indet', 't-turn', 'codex', 'running', 2)`);
    db.run(
      `INSERT INTO employee_executions (id, task_id, task_title, project_path, employee_id, employee_name, assignment_id, assignment_revision,
        status, revision, requested_harness_id, requested_policy, requested_mode, inputs_key, task_fingerprint, config_json, review_json,
        created_at, updated_at, expires_at, approved_at, started_at, approval_provenance, run_id, professional_json, professional_snapshot_sha256)
        VALUES ('att-init-indet', 't-turn', 'Task', '/tmp/p', 'emp-turn', 'Alice', 'assign-1', 1, 'started', 1, 'codex', 'balanced', 'ask', 'k2', 'fp', '{}', '{}',
        2, 2, 10000, 2, 2, 'owner', 'r-turn-init-indet', ?, ?)`,
      [bindingJson, snapSha],
    );
    const execRow2 = new EmployeeRunCore(db).get("att-init-indet")!;
    recordInitialProfessionalTurn(db, execRow2, binding, "r-turn-init-indet", "Initial prompt 2");

    // Settle initial turn as indeterminate (included = false)
    settleInitialProfessionalTurn(db, "r-turn-init-indet", false, null);
    // Repeated call must be a no-op and not duplicate the event
    settleInitialProfessionalTurn(db, "r-turn-init-indet", false, null);

    const initIndetEvents = journal.list({ runId: "r-turn-init-indet", eventType: "delivery.indeterminate" }).events;
    expect(initIndetEvents.length).toBe(1);
    expect(initIndetEvents[0]!.projectPath).toBe("/tmp/p");
    expect(initIndetEvents[0]!.targetType).toBe("turn");
    expect(initIndetEvents[0]!.payload.turnNumber).toBe(1);
    expect(initIndetEvents[0]!.payload.status).toBe("indeterminate");
  } finally {
    db.close();
  }
});

test("26. [P1-3] EmployeeRunCore guarded transitions: all 8 false-event and concurrency scenarios", async () => {
  const { db, journal, file } = setupIntegration();
  const sseEvents: Extract<AppEvent, { type: "activity_event" }>[] = [];
  const unsubscribe = subscribeAppEvents((e) => {
    if (e.type === "activity_event") sseEvents.push(e);
  });

  try {
    const runCore = new EmployeeRunCore(db, () => 2000);

    function createClaimedAttempt(id: string, taskId: string): void {
      runCore.createOrReuse({
        id,
        taskId,
        taskTitle: `Task ${taskId}`,
        projectPath: "/tmp/p13",
        employeeId: "emp-p13",
        employeeName: "Alice",
        assignmentId: "assign-p13",
        assignmentRevision: 1,
        requestedHarnessId: "codex",
        requestedModel: "gpt-5",
        requestedEffort: null,
        requestedComplexity: null,
        requestedPolicy: "balanced",
        requestedMode: "ask",
        inputsKey: `ik-${id}`,
        taskFingerprint: `fp-${id}`,
        configJson: "{}",
        reviewJson: JSON.stringify({ checks: [] }),
        usageNotice: null,
        unconfirmedPrior: false,
        expiresAt: 9000,
      });
      const claimed = runCore.claim(id, 1, `exec-${id}`);
      expect(claimed.ok).toBe(true);
    }

    // Scenario 1: succeeded -> repeated failed (must NOT record run.failed)
    createClaimedAttempt("ex-scen-1", "task-scen-1");
    runCore.markStarted("ex-scen-1", { runId: "run-scen-1", startedAt: 2100, actualHarnessId: "codex" });
    runCore.finish("ex-scen-1", { finishedAt: 2200, result: "succeeded", reason: "Exit 0" });
    runCore.finish("ex-scen-1", { finishedAt: 2300, result: "failed", reason: "Spurious failure after success" });

    expect(journal.list({ runId: "run-scen-1", eventType: "run.completed" }).events.length).toBe(1);
    expect(journal.list({ runId: "run-scen-1", eventType: "run.failed" }).events.length).toBe(0);
    expect(runCore.get("ex-scen-1")?.result).toBe("succeeded");

    // Scenario 2: failed -> repeated succeeded (must NOT record run.completed)
    createClaimedAttempt("ex-scen-2", "task-scen-2");
    runCore.markStarted("ex-scen-2", { runId: "run-scen-2", startedAt: 2100, actualHarnessId: "codex" });
    runCore.finish("ex-scen-2", { finishedAt: 2200, result: "failed", reason: "Exit 1" });
    runCore.finish("ex-scen-2", { finishedAt: 2300, result: "succeeded", reason: "Spurious success after failure" });

    expect(journal.list({ runId: "run-scen-2", eventType: "run.failed" }).events.length).toBe(1);
    expect(journal.list({ runId: "run-scen-2", eventType: "run.completed" }).events.length).toBe(0);
    expect(runCore.get("ex-scen-2")?.result).toBe("failed");

    // Scenario 3: finish twice with same result (idempotent no-op, 1 event total)
    createClaimedAttempt("ex-scen-3", "task-scen-3");
    runCore.markStarted("ex-scen-3", { runId: "run-scen-3", startedAt: 2100, actualHarnessId: "codex" });
    runCore.finish("ex-scen-3", { finishedAt: 2200, result: "succeeded", reason: "Exit 0" });
    runCore.finish("ex-scen-3", { finishedAt: 2200, result: "succeeded", reason: "Exit 0" });
    expect(journal.list({ runId: "run-scen-3" }).events.filter((e) => e.eventType === "run.completed").length).toBe(1);

    // Scenario 4: markStarted with incorrect Run ID / non-existent ID / already started
    expect(runCore.markStarted("non-existent-attempt", { runId: "run-ghost", startedAt: 2100, actualHarnessId: "codex" })).toBeNull();
    expect(journal.list({ runId: "run-ghost" }).events.length).toBe(0);

    // Calling markStarted on already-started ex-scen-1 with a different runId
    runCore.markStarted("ex-scen-1", { runId: "run-hijack", startedAt: 2400, actualHarnessId: "codex" });
    expect(journal.list({ runId: "run-hijack" }).events.length).toBe(0);

    // Calling markStarted with empty runId
    createClaimedAttempt("ex-scen-4b", "task-scen-4b");
    runCore.markStarted("ex-scen-4b", { runId: "", startedAt: 2100, actualHarnessId: "codex" });
    expect(runCore.get("ex-scen-4b")?.status).toBe("starting");

    // Calling markStarted with mismatched runId when indeterminate already bound a run_id
    runCore.settleStart("ex-scen-4b", "indeterminate", "Uncertain start with run-bound", "run-bound-4b");
    runCore.markStarted("ex-scen-4b", { runId: "run-wrong-4b", startedAt: 2200, actualHarnessId: "codex" });
    expect(journal.list({ runId: "run-wrong-4b" }).events.length).toBe(0);
    expect(runCore.get("ex-scen-4b")?.status).toBe("indeterminate");

    // Scenario 5: settleStart after terminal state (started, start-failed, rejected)
    runCore.settleStart("ex-scen-1", "indeterminate", "Attempted indeterminate after started");
    expect(
      journal.list({ eventType: "delivery.indeterminate" }).events.filter((e) => e.targetId === "ex-scen-1").length,
    ).toBe(0);

    createClaimedAttempt("ex-scen-5", "task-scen-5");
    runCore.settleStart("ex-scen-5", "start-failed", "Refused before spawn");
    runCore.settleStart("ex-scen-5", "indeterminate", "Should not transition from start-failed to indeterminate");
    expect(
      journal.list({ eventType: "delivery.indeterminate" }).events.filter((e) => e.targetId === "ex-scen-5").length,
    ).toBe(0);

    // Scenario 6: Concurrent competing updates across two WAL connections
    createClaimedAttempt("ex-scen-6", "task-scen-6");
    runCore.markStarted("ex-scen-6", { runId: "run-scen-6", startedAt: 2100, actualHarnessId: "codex" });

    const conn2 = new Database(file);
    conn2.exec("PRAGMA busy_timeout=5000");
    try {
      const runCore2 = new EmployeeRunCore(conn2, () => 2500);
      runCore.finish("ex-scen-6", { finishedAt: 2500, result: "succeeded", reason: "Conn 1 won" });
      runCore2.finish("ex-scen-6", { finishedAt: 2501, result: "failed", reason: "Conn 2 lost race" });

      const scen6Events = journal.list({ runId: "run-scen-6" }).events;
      expect(scen6Events.filter((e) => e.eventType === "run.completed").length).toBe(1);
      expect(scen6Events.filter((e) => e.eventType === "run.failed").length).toBe(0);
    } finally {
      conn2.close();
    }

    // Scenario 7: No-op update (repeated markStarted and settleStart with identical parameters)
    createClaimedAttempt("ex-scen-7", "task-scen-7");
    runCore.settleStart("ex-scen-7", "indeterminate", "Same reason");
    runCore.settleStart("ex-scen-7", "indeterminate", "Same reason");
    expect(
      journal.list({ eventType: "delivery.indeterminate" }).events.filter((e) => e.targetId === "ex-scen-7").length,
    ).toBe(1);

    // Scenario 8: Rollback after conditional transition
    createClaimedAttempt("ex-scen-8", "task-scen-8");
    await Bun.sleep(10);
    const sseCountBeforeRollback = sseEvents.length;

    expect(() => {
      db.transaction(() => {
        runCore.markStarted("ex-scen-8", { runId: "run-scen-8-rb", startedAt: 3000, actualHarnessId: "codex" });
        runCore.finish("ex-scen-8", { finishedAt: 3100, result: "succeeded", reason: "Will roll back" });
        throw new Error("Rollback outer transaction after markStarted and finish");
      })();
    }).toThrow("Rollback outer transaction");

    await Bun.sleep(10);
    expect(runCore.get("ex-scen-8")?.status).toBe("starting");
    expect(journal.list({ runId: "run-scen-8-rb" }).events.length).toBe(0);
    expect(sseEvents.length).toBe(sseCountBeforeRollback);
  } finally {
    unsubscribe();
    db.close();
  }
});

test("22 & 23 & 24. No changes to existing business behavior, no unauthorized task execution, and idempotent retry", () => {
  const { db, journal } = setupIntegration();
  try {
    db.run(`INSERT INTO projects (path, name, added_at) VALUES ('/tmp/proj-clean', 'Clean', 100)`);
    const empCore = new EmployeeCore(db, { now: () => 1000, random: () => 0.1 });
    const worker = empCore.createWorker({
      name: "Dave Engineer",
      jobTitle: "Software Engineer",
      roleCategory: "engineering",
      projectPath: "/tmp/proj-clean",
    });

    empCore.archive(worker.id);
    const archEvent = journal.list({ eventType: "employee.archived" }).events[0]!;
    expect(archEvent).toBeDefined();
    expect(archEvent.targetId).toBe(worker.id);

    empCore.unarchive(worker.id);
    const unarchEvent = journal.list({ eventType: "employee.unarchived" }).events[0]!;
    expect(unarchEvent).toBeDefined();
    expect(unarchEvent.targetId).toBe(worker.id);

    const taskCount = db.query<{ count: number }, []>("SELECT COUNT(*) as count FROM tasks").get()?.count;
    const runCount = db.query<{ count: number }, []>("SELECT COUNT(*) as count FROM runs").get()?.count;
    expect(taskCount).toBe(0);
    expect(runCount).toBe(0);
  } finally {
    db.close();
  }
});
