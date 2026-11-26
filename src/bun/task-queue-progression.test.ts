import { afterAll, beforeAll, beforeEach, expect, test } from "bun:test";
import { mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { PlanView } from "../shared/task-plan.ts";
import type { QueueView } from "../shared/task-queue.ts";
import { parseProposal, type ProposalItem, type TaskProposal } from "../shared/project-manager.ts";

/**
 * FO-ORCH06 controlled queue progression (read-only preparation of the next task). Fake codex driver behind a /bin/echo stub, a
 * disposable SQLite and temp project folders: no real AI CLI runs and no
 * provider is reached. The plan routes are read-only, so most tests also
 * assert that nothing was written (runs, assignments, journal, tasks).
 */
const isolated = realpathSync(mkdtempSync(path.join(tmpdir(), "foorch06-")));
process.env.AGETOR_DATA_DIR = isolated;
process.env.FORGEORBIT_DATA_DIR = isolated;
process.env.CODEX_HOME = path.join(isolated, ".codex");
process.env.HOME = isolated;
process.env.AGETOR_API_PORT = "4746";
process.env.AGETOR_USAGE_OFFLINE = "1";
process.env.AGETOR_CODEX_DRIVER = "fake";
process.env.AGETOR_CODEX_BIN = "/bin/echo";
process.env.AGETOR_TMUX_BIN = "/bin/echo";
for (const kind of ["CLAUDE", "CURSOR", "GEMINI", "FX", "ANTIGRAVITY"]) process.env["AGETOR_" + kind + "_BIN"] = "/nonexistent/foorch06";

let store: typeof import("./db.ts");
let backend: typeof import("./server.ts");
let server: ReturnType<(typeof import("./server.ts"))["startApiServer"]>;
let orchestrator: typeof import("./orchestrator.ts");
let manager: typeof import("./project-manager.ts");
let plans: typeof import("./task-plan.ts");
let queues: typeof import("./task-queue.ts");
let scheduling: typeof import("./task-scheduling.ts");
let batches: typeof import("./execution-batches.ts");
let exec: typeof import("./employee-execution.ts");
let AccountCore: typeof import("./account-core.ts").AccountCore;
let EmployeeCore: typeof import("./employee-core.ts").EmployeeCore;
let AssignmentCore: typeof import("./assignment-core.ts").AssignmentCore;
let AssignmentProposalCore: typeof import("./assignment-proposals.ts").AssignmentProposalCore;
const base = "http://127.0.0.1:4746";
let counter = 0;

beforeAll(async () => {
  store = await import("./db.ts");
  orchestrator = await import("./orchestrator.ts");
  manager = await import("./project-manager.ts");
  plans = await import("./task-plan.ts");
  queues = await import("./task-queue.ts");
  scheduling = await import("./task-scheduling.ts");
  batches = await import("./execution-batches.ts");
  exec = await import("./employee-execution.ts");
  ({ AccountCore } = await import("./account-core.ts"));
  backend = await import("./server.ts");
  ({ EmployeeCore } = await import("./employee-core.ts"));
  ({ AssignmentCore } = await import("./assignment-core.ts"));
  ({ AssignmentProposalCore } = await import("./assignment-proposals.ts"));
  server = backend.startApiServer();
  store.harnesses.setEnabled("codex", true);
  store.harnesses.setEnabled("claude-code", true);
  store.harnesses.setEnabled("cursor", false);
});
afterAll(() => server?.stop(true));
beforeEach(() => store.preferences.set("executorRoutingPreferences", ""));

const present = { recommendations: { cli: () => ({ available: true, loggedIn: null as boolean | null }) } };

function project(name: string): string {
  const dir = realpathSync(mkdtempSync(path.join(isolated, `${name}-`)));
  writeFileSync(path.join(dir, "README.md"), `# ${name}\n`);
  store.projects.upsert(dir, name);
  return dir;
}

function item(id: string, title: string, deps: string[] = [], extra: Partial<ProposalItem> = {}): ProposalItem {
  return {
    id, title, description: `${title} description`, priority: "medium", acceptanceCriteria: [`${title} works`],
    dependsOn: deps.map((itemId) => ({ kind: "item" as const, itemId })), parentFeature: null, taskType: "task",
    rationale: "", include: true, duplicate: null, duplicateAction: "use-existing", warnings: [], result: null, ...extra,
  };
}

function storeProposal(dir: string, items: ProposalItem[], title = "Build the API"): TaskProposal {
  const proposal: TaskProposal = {
    id: crypto.randomUUID(), projectPath: dir, messageId: "m1", title, summary: "A goal", status: "pending",
    items, createdAt: Date.now(), updatedAt: Date.now(), revision: 1,
  };
  store.projectManagers.putProposal(dir, proposal.id, proposal.status, JSON.stringify(proposal), proposal.createdAt);
  return proposal;
}

async function approved(dir: string, items: ProposalItem[], title?: string) {
  const proposal = storeProposal(dir, items, title);
  const result = await manager.approveProposal(dir, proposal.id, { revision: proposal.revision });
  if (!result.ok) throw new Error(result.error);
  const taskOf = (itemId: string) => {
    const stored = result.value.proposal.items.find((i) => i.id === itemId)!;
    return stored.result!.taskId!;
  };
  return { proposal: result.value.proposal, taskOf };
}

async function plan(dir: string, id: string, skipRecommendations = true): Promise<PlanView> {
  const out = await plans.getPlan(dir, id, { skipRecommendations, ...present });
  if (!out.ok) throw new Error(out.error);
  return out.value;
}
const node = (view: PlanView, title: string) => view.nodes.find((n) => n.title === title)!;

function snapshot() {
  const n = (sql: string) => store.db.query<{ n: number }, []>(sql).get()!.n;
  return {
    runs: n("SELECT COUNT(*) AS n FROM runs"),
    assignments: n("SELECT COUNT(*) AS n FROM employee_task_assignments"),
    journal: n("SELECT COUNT(*) AS n FROM activity_events"),
    executions: n("SELECT COUNT(*) AS n FROM employee_executions"),
    tasks: JSON.stringify(store.tasks.list().map((t) => [t.id, t.column, t.updatedAt, t.runId])),
    proposals: JSON.stringify(store.projectManagers.listProposals.call(store.projectManagers, "")),
  };
}

// ----- helpers --------------------------------------------------------------------------------------

const deps = { skipRecommendations: true, ...present };
const batchDeps = { envNames: () => [] as string[] };

const assignmentIds = () => store.db.query<{ n: number }, []>("SELECT COUNT(*) AS n FROM employee_task_assignments").get()!.n;

function counts() {
  const n = (sql: string) => store.db.query<{ n: number }, []>(sql).get()!.n;
  return {
    runs: n("SELECT COUNT(*) AS n FROM runs"),
    executions: n("SELECT COUNT(*) AS n FROM employee_executions"),
    journal: n("SELECT COUNT(*) AS n FROM activity_events"),
    accounts: n("SELECT COUNT(*) AS n FROM resource_accounts"),
    observations: n("SELECT COUNT(*) AS n FROM quota_observations"),
    assignments: assignmentIds(),
  };
}

function assign(taskId: string, dir: string) {
  const person = new EmployeeCore(store.db).createWorker({ name: `Worker ${++counter}`, jobTitle: "QA", projectPath: dir });
  new AssignmentCore(store.db).assign(taskId, person.id);
  return person;
}

async function planOf(dir: string, id: string, withRecs = false): Promise<PlanView> {
  const out = await plans.getPlan(dir, id, withRecs ? present : deps);
  if (!out.ok) throw new Error(out.error);
  return out.value;
}

async function saveQueue(dir: string, proposalId: string, taskIds: string[], revision?: number) {
  const view = await planOf(dir, proposalId);
  return queues.saveQueue(dir, proposalId, { taskIds, planKey: view.planKey, ...(revision ? { revision } : {}) }, deps);
}

function must<T>(r: { ok: true; value: T } | { ok: false; error: string }): T {
  if (!r.ok) throw new Error(r.error);
  return r.value;
}

async function synthetic() {
  const dir = project("queue");
  const made = await approved(dir, [item("a", "Task A"), item("b", "Task B", ["a"]), item("c", "Task C")]);
  return { dir, ...made, A: made.taskOf("a"), B: made.taskOf("b"), C: made.taskOf("c") };
}


// ----- progression ----------------------------------------------------------------------------------

const progress = (q: QueueView) => q.progression;
const changeKinds = (q: QueueView) => q.progression.changes.map((c) => c.kind);

async function queueOf(dir: string, proposalId: string, withRecs = false): Promise<QueueView> {
  return must(await queues.getQueue(dir, proposalId, withRecs ? present : deps)).queue!;
}

async function saveWith(dir: string, proposalId: string, taskIds: string[], revision?: number, withRecs = false) {
  const view = await planOf(dir, proposalId, withRecs);
  return queues.saveQueue(dir, proposalId, { taskIds, planKey: view.planKey, ...(revision ? { revision } : {}) }, withRecs ? present : deps);
}

const journalCount = () => store.db.query<{ n: number }, []>("SELECT COUNT(*) AS n FROM activity_events").get()!.n;

test("A→B with C independent: the queue is ready to review C, B is not a candidate, and opt-in is off by default", async () => {
  const { dir, proposal, A, B, C } = await synthetic();
  assign(A, dir);
  assign(B, dir);
  assign(C, dir);
  const saved = must(await saveWith(dir, proposal.id, [C, A]));
  const q = saved.queue;
  expect(q.autoPrepare).toBe(false);
  expect(progress(q).phase).toBe("ready-to-review");
  expect(progress(q).candidate).toMatchObject({ title: "Task C", position: 1, inQueue: true });
  expect(progress(q).canOpenReview).toBe(true);
  expect(progress(q).changes).toEqual([]);
  expect(progress(q).stillBlocked.map((b) => b.title)).toEqual(["Task B"]);
  expect(progress(q).stillBlocked[0]!.reasons.join(" ")).toContain("Task A");
  // The database default is off as well.
  expect(store.taskQueues.forProposal(dir, proposal.id)!.autoPrepare).toBe(false);
});

test("A Run that succeeded and sits in Review is not Done: B stays blocked and no candidate appears for it", async () => {
  const { dir, proposal, A, B } = await synthetic();
  assign(A, dir);
  assign(B, dir);
  const saved = must(await saveWith(dir, proposal.id, [A]));
  const on = must(await queues.setAutoPrepare(dir, saved.queue.id, { enabled: true, revision: saved.queue.revision }, deps));
  store.tasks.update(A, { column: "review" });
  const q = await queueOf(dir, proposal.id);
  expect(q.entries[0]!.state).toBe("waiting-owner");
  expect(progress(q).phase).toBe("waiting-owner");
  expect(progress(q).candidate).toBeNull();
  expect(progress(q).stillBlocked.map((b) => b.title)).toContain("Task B");
  expect(on.queue.autoPrepare).toBe(true);
  // B is also refused at the start gate.
  const start = await orchestrator.startTask(B);
  expect("error" in start && start.error).toContain("dependencies are not satisfied");
});

test("A Done makes B a candidate only with the opt-in; the old plan key never authorizes it", async () => {
  const { dir, proposal, A, B } = await synthetic();
  assign(A, dir);
  assign(B, dir);
  const saved = must(await saveWith(dir, proposal.id, [A]));
  store.tasks.update(A, { column: "review" });
  store.tasks.update(A, { column: "done" });

  // Opt-in off: the plan moved, the Owner is told, but nothing is proposed.
  const off = await queueOf(dir, proposal.id);
  expect(off.needsReview).toBe(true);
  expect(progress(off).phase).toBe("stale");
  expect(progress(off).candidate).toBeNull();
  expect(progress(off).becameReady.map((r) => r.title)).toEqual(["Task B"]);
  expect(progress(off).canOpenReview).toBe(false);

  // Opt-in on: B is prepared as a candidate outside the queue.
  const enabled = must(await queues.setAutoPrepare(dir, saved.queue.id, { enabled: true, revision: saved.queue.revision }, deps));
  const on = await queueOf(dir, proposal.id);
  expect(on.autoPrepare).toBe(true);
  expect(progress(on).phase).toBe("stale");
  expect(progress(on).candidate).toMatchObject({ title: "Task B", inQueue: false, position: null });
  expect(progress(on).needsPlanConfirmation).toBe(true);
  expect(progress(on).canOpenReview).toBe(false);

  // The reviewed plan key is refused for "next": opt-in does not confirm anything.
  const refused = await queues.nextQueueTask(dir, on.id, { revision: on.revision, planKey: saved.queue.planKey }, deps);
  expect(!refused.ok && refused.status).toBe(409);
  const current = await queues.nextQueueTask(dir, on.id, { revision: on.revision, planKey: (await planOf(dir, proposal.id)).planKey }, deps);
  expect(!current.ok && current.status).toBe(409);
  expect(!current.ok && (current.body as { stale?: boolean }).stale).toBe(true);
  expect(enabled.queue.revision).toBe(saved.queue.revision + 1);

  // Only the Owner's save (the existing confirmation) adds B and makes it next.
  const confirmed = must(await saveWith(dir, proposal.id, [A, B], on.revision));
  expect(progress(confirmed.queue).phase).toBe("ready-to-review");
  expect(progress(confirmed.queue).candidate).toMatchObject({ title: "Task B", inQueue: true, position: 2 });
  expect(progress(confirmed.queue).canOpenReview).toBe(true);
  const next = must(await queues.nextQueueTask(dir, confirmed.queue.id, { revision: confirmed.queue.revision, planKey: confirmed.queue.planKey }, deps));
  expect(next.next.taskId).toBe(B);
});

test("the Owner sees what changed: expected progress is reported apart from material changes", async () => {
  const { dir, proposal, A, B, C } = await synthetic();
  assign(A, dir);
  assign(B, dir);
  assign(C, dir);
  must(await saveWith(dir, proposal.id, [A, C]));
  store.tasks.update(A, { column: "done" });
  const q = await queueOf(dir, proposal.id);
  expect(q.needsReview).toBe(true);
  const kinds = changeKinds(q);
  expect(kinds).toContain("state");
  expect(progress(q).materialChange).toBe(false);
  expect(progress(q).changes.find((c) => c.title === "Task B")?.message).toContain("blocked → ready");
  expect(progress(q).changes.every((c) => !c.material)).toBe(true);
  expect(progress(q).becameReady.map((r) => r.title)).toEqual(["Task B"]);
  expect(progress(q).stillBlocked).toEqual([]);
  // Nothing was written by reading it, repeatedly.
  const before = counts();
  await queueOf(dir, proposal.id);
  await queueOf(dir, proposal.id);
  expect(counts()).toEqual(before);
});

test("a changed assignment is a material change and blocks the old review", async () => {
  const { dir, proposal, A, C } = await synthetic();
  assign(A, dir);
  assign(C, dir);
  const saved = must(await saveWith(dir, proposal.id, [A, C]));
  new AssignmentCore(store.db).reassign(C, new EmployeeCore(store.db).createWorker({ name: `Other ${++counter}`, jobTitle: "QA", projectPath: dir }).id, 1);
  const q = await queueOf(dir, proposal.id);
  expect(changeKinds(q)).toContain("assignment");
  expect(progress(q).materialChange).toBe(true);
  expect(progress(q).canOpenReview).toBe(false);
  const next = await queues.nextQueueTask(dir, q.id, { revision: q.revision, planKey: q.planKey }, deps);
  expect(!next.ok && next.status).toBe(409);
  expect(saved.queue.needsReview).toBe(false);
});

test("a changed permission mode or task setting is a material change and blocks the old review", async () => {
  const { dir, proposal, A, C } = await synthetic();
  assign(A, dir);
  assign(C, dir);
  const saved = must(await saveWith(dir, proposal.id, [A, C], undefined, true));
  expect(progress(saved.queue).candidate!.executor).not.toBeNull();
  store.tasks.update(A, { mode: "ask" as never });
  const q = await queueOf(dir, proposal.id, true);
  const kinds = changeKinds(q);
  expect(kinds).toContain("task");
  expect(progress(q).materialChange).toBe(true);
  const next = await queues.nextQueueTask(dir, q.id, { revision: q.revision, planKey: saved.queue.planKey }, present);
  expect(!next.ok && next.status).toBe(409);
});

test("Unknown quota stays Unknown and a Full-access preference does not broaden project-bound execution", async () => {
  const { dir, proposal, A, C } = await synthetic();
  assign(A, dir);
  assign(C, dir);
  const saved = must(await saveWith(dir, proposal.id, [A, C], undefined, true));
  const candidate = progress(saved.queue).candidate!;
  expect(candidate.executor!.availability).toBe("unknown");
  expect(candidate.executor!.classification).toBe("potential-unknown");
  expect(progress(saved.queue).reason).not.toMatch(/available/i);

  store.tasks.update(A, { agent: "codex", mode: "full-access" as never });
  const full = await queueOf(dir, proposal.id, true);
  const fullCandidate = progress(full).candidate!;
  expect(fullCandidate.executor!.fullAccess).toBe(false);
  expect(fullCandidate.executor!.modeId).toBe("auto");
  expect(progress(full).materialChange).toBe(true);
  // The queue neither acknowledged nor applied anything: the task keeps its own mode and no run exists.
  expect(store.tasks.get(A)!.mode).toBe("full-access");
  expect(counts().runs).toBe(0);
});

test("verified exhausted evidence is reported as a quota change and keeps blocking launch", async () => {
  const { dir, proposal, A, C } = await synthetic();
  assign(A, dir);
  assign(C, dir);
  const saved = must(await saveWith(dir, proposal.id, [A, C], undefined, true));
  const core = new AccountCore(store.db);
  const account = core.createAccount({ provider: "anthropic", displayName: "Synthetic exhaustion 06" });
  core.bindHarness(account.id, "claude-code");
  const expiresAt = Date.now() + 60_000;
  core.setModelCapability(account.id, "claude-code", "opus-5.5", { support: "supported", expiresAt });
  const quota = core.createDefinition({ accountId: account.id, subscriptionId: null, scope: "model:opus-5.5", unit: { kind: "requests" }, window: "week" });
  core.recordTrustedObservations("anthropic-admin", [{
    quotaId: quota.id,
    values: { remaining: 0, limit: 1, used: 1, expiresAt },
    evidence: {
      provider: "anthropic", accountId: account.id, subject: "synthetic-subject-06", method: "provider-account", sourceId: "anthropic-admin",
      officialUrl: "https://platform.claude.com/docs/en/manage-claude/usage-cost-api", checkedAt: "2026-10-28", receivedAt: Date.now(),
      sharedPool: null, limitations: "synthetic acceptance evidence",
    },
  }]);
  const q = await queueOf(dir, proposal.id, true);
  expect(q.needsReview).toBe(true);
  expect(changeKinds(q)).toContain("quota");
  expect(progress(q).materialChange).toBe(true);
  expect(progress(q).canOpenReview).toBe(false);
  const pre = exec.prepareEmployeeExecution({ taskId: A, expectedAssignmentRevision: null, harnessId: "claude-code", model: "opus-5.5" });
  expect(pre.outcome).toBe("blocked");
  expect(pre.blockingErrors.map((e) => e.code)).toContain("resource-excluded");
  expect(saved.queue.id).toBe(q.id);
});

test("a paused or stopped queue does not advance, even with the opt-in on", async () => {
  const { dir, proposal, A, C } = await synthetic();
  assign(A, dir);
  assign(C, dir);
  const saved = must(await saveWith(dir, proposal.id, [A]));
  let q = must(await queues.setAutoPrepare(dir, saved.queue.id, { enabled: true, revision: saved.queue.revision }, deps)).queue;
  q = must(await queues.setQueueStatus(dir, q.id, "pause", q.revision, deps)).queue;
  expect(progress(q).phase).toBe("paused");
  expect(progress(q).candidate).toBeNull();
  const pausedNext = await queues.nextQueueTask(dir, q.id, { revision: q.revision, planKey: q.planKey }, deps);
  expect(!pausedNext.ok && pausedNext.error).toContain("paused");
  q = must(await queues.setQueueStatus(dir, q.id, "resume", q.revision, deps)).queue;
  expect(progress(q).phase).toBe("ready-to-review");
  q = must(await queues.setQueueStatus(dir, q.id, "stop", q.revision, deps)).queue;
  expect(progress(q).phase).toBe("stopped");
  expect(progress(q).candidate).toBeNull();
  const stoppedNext = await queues.nextQueueTask(dir, q.id, { revision: q.revision, planKey: q.planKey }, deps);
  expect(!stoppedNext.ok && stoppedNext.error).toContain("stopped");
  // A stopped queue can't be re-armed by the switch either.
  const toggled = await queues.setAutoPrepare(dir, q.id, { enabled: false, revision: q.revision }, deps);
  expect(!toggled.ok && toggled.status).toBe(409);
});

test("a running task holds the queue (in progress); a second run is never prepared", async () => {
  const { dir, proposal, A, C } = await synthetic();
  assign(A, dir);
  assign(C, dir);
  const saved = must(await saveWith(dir, proposal.id, [A, C]));
  must(await queues.setAutoPrepare(dir, saved.queue.id, { enabled: true, revision: saved.queue.revision }, deps));
  store.tasks.update(A, { column: "running" });
  const q = await queueOf(dir, proposal.id);
  expect(progress(q).phase).toBe("in-progress");
  expect(progress(q).current).toMatchObject({ title: "Task A" });
  expect(progress(q).candidate).toBeNull();
  expect(progress(q).canOpenReview).toBe(false);
  expect(counts().runs).toBe(0);
});

test("waiting phases: dependency, assignment and Owner decisions are told apart", async () => {
  const { dir, proposal, A, B, C } = await synthetic();
  assign(A, dir);
  assign(B, dir);
  // C has no worker.
  const noWorker = must(await saveWith(dir, proposal.id, [C]));
  expect(progress(noWorker.queue).phase).toBe("waiting-assignment");
  expect(progress(noWorker.queue).candidate).toBeNull();

  const queued = must(await saveWith(dir, proposal.id, [A, C], noWorker.queue.revision));
  store.tasks.update(A, { column: "review" });
  store.tasks.update(C, { column: "done" });
  const review = await queueOf(dir, proposal.id);
  expect(progress(review).phase).toBe("waiting-owner");

  // A queue holding only a task that waits on a dependency.
  const { dir: dir2, proposal: p2, A: A2, B: B2 } = await synthetic();
  assign(A2, dir2);
  const only = must(await saveWith(dir2, p2.id, [A2]));
  scheduling.updateScheduling(dir2, A2, { dependsOn: [B2] });
  const waiting = await queueOf(dir2, p2.id);
  // B2 depends on A2 already, so the Owner's edit is refused as a cycle; the queue is unchanged.
  expect(progress(waiting).phase).toBe("ready-to-review");
  expect(only.queue.id).toBe(waiting.id);
  expect(queued.queue.id).toBe(review.id);

  // All done.
  store.tasks.update(A2, { column: "done" });
  const doneQ = await queueOf(dir2, p2.id);
  expect(progress(doneQ).phase === "completed" || progress(doneQ).phase === "stale").toBe(true);
});

test("a deleted dependency keeps B blocked, with no candidate even with the opt-in", async () => {
  const { dir, proposal, A, B } = await synthetic();
  assign(A, dir);
  assign(B, dir);
  const saved = must(await saveWith(dir, proposal.id, [A]));
  must(await queues.setAutoPrepare(dir, saved.queue.id, { enabled: true, revision: saved.queue.revision }, deps));
  store.tasks.update(A, { column: "done" });
  await orchestrator.deleteTask(A);
  const q = await queueOf(dir, proposal.id);
  expect(progress(q).candidate).toBeNull();
  expect(progress(q).stillBlocked.map((b) => b.title)).toContain("Task B");
  expect(progress(q).stillBlocked.find((b) => b.title === "Task B")!.reasons.join(" ")).toContain("deleted");
  expect(progress(q).phase).not.toBe("ready-to-review");
});

test("an Execution Batch that owns a task keeps it out of the queue's next; no second run is prepared", async () => {
  const { dir, proposal, A, C } = await synthetic();
  assign(A, dir);
  assign(C, dir);
  const saved = must(await saveWith(dir, proposal.id, [A, C]));
  const batch = must(await batches.createBatch(dir, { taskIds: [A], policy: { noOverageHarnessIds: ["codex"] } }, batchDeps));
  // Mark the draft as approved so it owns the task (the same test seam the batch tests use: the stored status).
  const raw = JSON.parse(store.executionBatches.get(dir, batch.id)!);
  raw.status = "approved";
  store.executionBatches.put({ id: batch.id, projectPath: dir, status: "approved", data: JSON.stringify(raw), createdAt: raw.createdAt });
  expect(scheduling.activeBatchesFor(dir, A)).toEqual([batch.id]);

  const q = await queueOf(dir, proposal.id);
  expect(q.entries.find((e) => e.taskId === A)!.batchIds).toEqual([batch.id]);
  expect(q.entries.find((e) => e.taskId === A)!.reasons.join(" ")).toContain("Execution Batch");
  expect(q.next).toMatchObject({ title: "Task C" });
  expect(progress(q).candidate).toMatchObject({ title: "Task C" });

  // If only the batch task is ready, the queue shows the batch instead of offering a second run.
  const only = must(await queues.saveQueue(dir, proposal.id, { taskIds: [A], planKey: (await planOf(dir, proposal.id)).planKey, revision: saved.queue.revision }, deps));
  expect(only.queue.next).toBeNull();
  expect(progress(only.queue).phase).toBe("waiting-owner");
  expect(progress(only.queue).reason).toContain("Execution Batch");
  const refused = await queues.nextQueueTask(dir, only.queue.id, { revision: only.queue.revision, planKey: only.queue.planKey }, deps);
  expect(!refused.ok && refused.status).toBe(409);

  // A batch-owned task can't be added to a queue either.
  const adding = await queues.saveQueue(dir, proposal.id, { taskIds: [A, C], planKey: only.queue.planKey, revision: only.queue.revision }, deps);
  expect(adding.ok).toBe(true); // A was already queued; C is free
  const second = await synthetic();
  assign(second.A, second.dir);
  const b2 = must(await batches.createBatch(second.dir, { taskIds: [second.A], policy: { noOverageHarnessIds: ["codex"] } }, batchDeps));
  const raw2 = JSON.parse(store.executionBatches.get(second.dir, b2.id)!);
  raw2.status = "running";
  store.executionBatches.put({ id: b2.id, projectPath: second.dir, status: "running", data: JSON.stringify(raw2), createdAt: raw2.createdAt });
  const owned = await saveWith(second.dir, second.proposal.id, [second.A]);
  expect(!owned.ok && owned.status).toBe(409);
  expect(!owned.ok && owned.error).toContain("Execution Batch");
  expect(counts().runs).toBe(0);
});

test("the opt-in is audited once per change and survives a reload; repeated delivery adds nothing", async () => {
  const { dir, proposal, A } = await synthetic();
  assign(A, dir);
  const saved = must(await saveWith(dir, proposal.id, [A]));
  const j0 = journalCount();

  const on = must(await queues.setAutoPrepare(dir, saved.queue.id, { enabled: true, revision: saved.queue.revision }, deps));
  expect(on.changed).toBe(true);
  expect(journalCount()).toBe(j0 + 1);
  // The same request delivered again, even with a stale revision, records nothing and bumps nothing.
  const again = must(await queues.setAutoPrepare(dir, saved.queue.id, { enabled: true, revision: saved.queue.revision }, deps));
  expect(again.changed).toBe(false);
  expect(again.queue.revision).toBe(on.queue.revision);
  expect(journalCount()).toBe(j0 + 1);
  // Reads and plan refreshes are silent.
  await queueOf(dir, proposal.id);
  await queueOf(dir, proposal.id, true);
  expect(journalCount()).toBe(j0 + 1);

  const off = must(await queues.setAutoPrepare(dir, saved.queue.id, { enabled: false, revision: on.queue.revision }, deps));
  expect(off.queue.autoPrepare).toBe(false);
  expect(journalCount()).toBe(j0 + 2);
  const events = store.db.query<{ event_type: string; actor_type: string; target_type: string; target_id: string; payload_json: string }, []>(
    "SELECT event_type, actor_type, target_type, target_id, payload_json FROM activity_events WHERE event_type LIKE 'queue.preparation.%' ORDER BY sequence_id DESC LIMIT 2").all();
  expect(events.map((e) => e.event_type)).toEqual(["queue.preparation.disabled", "queue.preparation.enabled"]);
  expect(events[0]).toMatchObject({ actor_type: "owner", target_type: "proposal", target_id: proposal.id });
  expect(JSON.parse(events[1]!.payload_json)).toMatchObject({ queueId: saved.queue.id, proposalId: proposal.id });
  // A stale revision on a real change is refused and records nothing.
  const stale = await queues.setAutoPrepare(dir, saved.queue.id, { enabled: true, revision: saved.queue.revision }, deps);
  expect(!stale.ok && stale.status).toBe(409);
  expect(journalCount()).toBe(j0 + 2);
  // Validation.
  expect((await queues.setAutoPrepare(dir, saved.queue.id, { enabled: "yes", revision: 1 }, deps)).ok).toBe(false);
  expect((await queues.setAutoPrepare(dir, "missing", { enabled: true, revision: 1 }, deps)).ok).toBe(false);
  expect((await queues.setAutoPrepare("/not/registered", saved.queue.id, { enabled: true, revision: 1 }, deps)).ok).toBe(false);
});

test("restart: the opt-in, the reviewed snapshot and the changes are rebuilt from the database", async () => {
  const { dir, proposal, A, B } = await synthetic();
  assign(A, dir);
  assign(B, dir);
  const saved = must(await saveWith(dir, proposal.id, [A]));
  must(await queues.setAutoPrepare(dir, saved.queue.id, { enabled: true, revision: saved.queue.revision }, deps));
  store.tasks.update(A, { column: "done" });
  // Everything below is read from the database row only (no in-memory state is kept by the queue module).
  const row = store.taskQueues.forProposal(dir, proposal.id)!;
  expect(row.autoPrepare).toBe(true);
  expect((row.reviewedSnapshot as { planKey: string }).planKey).toBe(saved.queue.planKey);
  const q = await queueOf(dir, proposal.id);
  expect(progress(q).candidate).toMatchObject({ title: "Task B", inQueue: false });
  expect(changeKinds(q)).toContain("state");
  // A queue saved before this migration has no snapshot: it says so instead of inventing changes.
  store.db.run("UPDATE task_plan_queues SET reviewed_snapshot = NULL WHERE id = ?", [saved.queue.id]);
  const legacy = await queueOf(dir, proposal.id);
  expect(progress(legacy).changesUnavailable).toBe(true);
  expect(progress(legacy).changes).toEqual([]);
  store.db.run("UPDATE task_plan_queues SET reviewed_snapshot = '{broken' WHERE id = ?", [saved.queue.id]);
  expect(progress(await queueOf(dir, proposal.id)).changesUnavailable).toBe(true);
});

test("preparation never starts, assigns, retries or infers: only the Owner's own writes change anything", async () => {
  const { dir, proposal, A, B, C } = await synthetic();
  assign(A, dir);
  assign(B, dir);
  assign(C, dir);
  const saved = must(await saveWith(dir, proposal.id, [A], undefined, true));
  must(await queues.setAutoPrepare(dir, saved.queue.id, { enabled: true, revision: saved.queue.revision }, present));
  store.tasks.update(A, { column: "done" });
  const before = { ...counts(), tasks: JSON.stringify(store.tasks.list().map((t) => [t.id, t.column, t.mode, t.model, t.agent, t.runId])) };
  for (let i = 0; i < 3; i++) {
    const q = await queueOf(dir, proposal.id, true);
    // Plan order: the independent Task C (wave 1) comes before B (wave 2). Never in the queue until the Owner confirms.
    expect(progress(q).candidate).toMatchObject({ title: "Task C", inQueue: false });
  }
  const after = { ...counts(), tasks: JSON.stringify(store.tasks.list().map((t) => [t.id, t.column, t.mode, t.model, t.agent, t.runId])) };
  expect(after).toEqual(before);
  expect(before.runs).toBe(0);
  expect(before.executions).toBe(0);
});
