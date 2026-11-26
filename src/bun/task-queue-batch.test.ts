import { afterAll, beforeAll, beforeEach, expect, test } from "bun:test";
import { mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { PlanView } from "../shared/task-plan.ts";
import type { QueueView } from "../shared/task-queue.ts";
import type { BatchView } from "../shared/task-scheduling.ts";
import { parseProposal, type ProposalItem, type TaskProposal } from "../shared/project-manager.ts";

/**
 * FO-ORCH07 queue-to-batch handoff and bounded authorization. Fake codex driver behind a /bin/echo stub, a
 * disposable SQLite and temp project folders: no real AI CLI runs and no
 * provider is reached. The plan routes are read-only, so most tests also
 * assert that nothing was written (runs, assignments, journal, tasks).
 */
const isolated = realpathSync(mkdtempSync(path.join(tmpdir(), "foorch07-")));
process.env.AGETOR_DATA_DIR = isolated;
process.env.FORGEORBIT_DATA_DIR = isolated;
process.env.CODEX_HOME = path.join(isolated, ".codex");
process.env.HOME = isolated;
process.env.AGETOR_API_PORT = "4748";
process.env.AGETOR_USAGE_OFFLINE = "1";
process.env.AGETOR_CODEX_DRIVER = "fake";
process.env.AGETOR_CODEX_BIN = "/bin/echo";
process.env.AGETOR_TMUX_BIN = "/bin/echo";
for (const kind of ["CLAUDE", "CURSOR", "GEMINI", "FX", "ANTIGRAVITY"]) process.env["AGETOR_" + kind + "_BIN"] = "/nonexistent/foorch07";

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
const base = "http://127.0.0.1:4748";
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


// ----- helpers (ORCH07) -----------------------------------------------------------------------------

const policy = { noOverageHarnessIds: ["codex"] };
const journalCount = () => store.db.query<{ n: number }, []>("SELECT COUNT(*) AS n FROM activity_events").get()!.n;
const rawJournalOf = (type: string) => store.db.query<{ n: number }, [string]>("SELECT COUNT(*) AS n FROM activity_events WHERE event_type = ?").get(type)!.n;
// One database serves every test, so journal counts are read relative to the start of the test.
const marks = new Map<string, number>();
const TYPES = ["queue.plan.confirmed", "queue.paused", "queue.resumed", "queue.stopped", "queue.handoff.prepared", "queue.authorization.granted", "queue.authorization.revoked", "run.completed", "run.failed", "employee.assigned"];
const mark = () => { for (const type of TYPES) marks.set(type, rawJournalOf(type)); };
const journalOf = (type: string) => rawJournalOf(type) - (marks.get(type) ?? 0);

async function queueOf(dir: string, proposalId: string): Promise<QueueView> {
  return must(await queues.getQueue(dir, proposalId, deps)).queue!;
}

async function saveWith(dir: string, proposalId: string, taskIds: string[], revision?: number) {
  const view = await planOf(dir, proposalId);
  return queues.saveQueue(dir, proposalId, { taskIds, planKey: view.planKey, ...(revision ? { revision } : {}) }, deps);
}

async function prepare(dir: string, q: QueueView, extra: Record<string, unknown> = {}) {
  const view = await planOf(dir, q.proposalId);
  return queues.prepareQueueBatch(dir, q.id, { revision: q.revision, planKey: view.planKey, policy, ...extra }, { ...deps, ...batchDeps });
}

async function ready(resetMarks = true) {
  if (resetMarks) mark();
  const s = await synthetic();
  for (const id of [s.A, s.B, s.C]) {
    assign(id, s.dir);
    store.tasks.update(id, { agent: "codex", model: "gpt-6.1-sol", mode: "ask" as never });
  }
  return s;
}

function approveInput(batch: BatchView, extra: Record<string, unknown> = {}) {
  return { revision: batch.revision, previewKey: batch.preview!.key, acknowledgedHarnessIds: batch.preview!.spendingHarnessIds, ...extra };
}

const runsOf = (taskId: string) => store.runs.listForTask(taskId).length;

// ----- handoff --------------------------------------------------------------------------------------

test("A→B with C independent: B can't be handed over, C and A go in the Owner's queue order as a draft; nothing starts", async () => {
  const { dir, proposal, A, B, C } = await ready();
  const saved = must(await saveWith(dir, proposal.id, [C, A]));
  expect(journalOf("queue.plan.confirmed")).toBeGreaterThanOrEqual(1);
  expect(saved.queue.handoff.canPrepare).toBe(true);
  expect(saved.queue.handoff.eligible.map((e) => e.taskId)).toEqual([C, A]);

  const before = { ...counts(), tasks: JSON.stringify(store.tasks.list().map((t) => [t.id, t.column, t.runId, t.mode])) };
  // B was never in the queue (it is blocked by A), so it is refused by name.
  const refusedB = await prepare(dir, saved.queue, { taskIds: [B] });
  expect(!refusedB.ok && refusedB.status).toBe(409);
  expect(!refusedB.ok && refusedB.error).toContain("not in this queue");

  // The request lists A first; the batch still follows the queue: C, then A.
  const out = must(await prepare(dir, saved.queue, { taskIds: [A, C] }));
  expect(out.alreadyPrepared).toBe(false);
  expect(out.batch.status).toBe("draft");
  expect(out.batch.entries.map((e) => e.taskId)).toEqual([C, A]);
  expect(out.batch.sourceQueue).toMatchObject({ queueId: saved.queue.id, proposalId: proposal.id, planKey: saved.queue.planKey, taskIds: [C, A] });
  expect(out.batch.queueOrder?.guaranteed).toBe(true);
  expect(out.queue.batches[0]).toMatchObject({ id: out.batch.id, status: "draft", orderGuaranteed: true });
  expect(journalOf("queue.handoff.prepared")).toBe(1);
  const after = { ...counts(), tasks: JSON.stringify(store.tasks.list().map((t) => [t.id, t.column, t.runId, t.mode])) };
  expect({ ...after, journal: 0 }).toEqual({ ...before, journal: 0 });
  expect(after.runs).toBe(0);
  expect(after.executions).toBe(0);
  expect(scheduling.activeBatchesFor(dir, C)).toEqual([]); // a draft owns nothing
});

test("different priorities or parallelism: the batch does not promise the queue's order", async () => {
  const { dir, proposal, A, C } = await ready();
  const saved = must(await saveWith(dir, proposal.id, [C, A]));
  store.taskScheduling.setPriority(A, "high");
  const viewKey = (await planOf(dir, proposal.id)).planKey;
  const q = await queueOf(dir, proposal.id);
  expect(q.needsReview).toBe(true); // priority change is material: re-confirm first
  const again = must(await saveWith(dir, proposal.id, [C, A], q.revision));
  const out = must(await prepare(dir, again.queue));
  expect(out.batch.queueOrder?.guaranteed).toBe(false);
  expect(out.batch.queueOrder?.note).toContain("priorit");
  expect(viewKey).not.toBe(saved.queue.planKey);
});

test("a stale plan key or an unconfirmed plan is refused and nothing is created", async () => {
  const { dir, proposal, A, C } = await ready();
  const saved = must(await saveWith(dir, proposal.id, [C, A]));
  store.tasks.update(A, { column: "done" });
  const old = await queues.prepareQueueBatch(dir, saved.queue.id, { revision: saved.queue.revision, planKey: saved.queue.planKey, policy }, { ...deps, ...batchDeps });
  expect(!old.ok && old.status).toBe(409);
  const q = await queueOf(dir, proposal.id);
  expect(q.needsReview).toBe(true);
  expect(q.handoff.canPrepare).toBe(false);
  const current = await prepare(dir, q);
  expect(!current.ok && current.status).toBe(409);
  expect(!current.ok && (current.body as { stale?: boolean }).stale).toBe(true);
  expect(batchesOf(dir, saved.queue.id)).toHaveLength(0);
  expect(journalOf("queue.handoff.prepared")).toBe(0);
  // A wrong queue revision is refused too.
  const wrong = await queues.prepareQueueBatch(dir, q.id, { revision: q.revision + 5, planKey: q.planKey }, deps);
  expect(!wrong.ok && wrong.status).toBe(409);
});

const batchesOf = (dir: string, queueId: string) => batches.batchesOfQueue(dir, queueId);

test("a repeated handoff returns the same batch and records nothing new; different tasks are refused; racing requests create one", async () => {
  const { dir, proposal, A, C } = await ready();
  const saved = must(await saveWith(dir, proposal.id, [C, A]));
  const first = must(await prepare(dir, saved.queue));
  const j = journalCount();
  const second = must(await prepare(dir, first.queue));
  expect(second.alreadyPrepared).toBe(true);
  expect(second.batch.id).toBe(first.batch.id);
  expect(journalCount()).toBe(j);
  const subset = await prepare(dir, first.queue, { taskIds: [C] });
  expect(!subset.ok && subset.status).toBe(409);
  expect(batchesOf(dir, saved.queue.id)).toHaveLength(1);
  expect(first.queue.handoff.canPrepare).toBe(false);
  expect(first.queue.handoff.openBatchId).toBe(first.batch.id);

  const other = await ready(false);
  const s2 = must(await saveWith(other.dir, other.proposal.id, [other.C, other.A]));
  const [x, y] = await Promise.all([prepare(other.dir, s2.queue), prepare(other.dir, s2.queue)]);
  expect([x.ok, y.ok].filter(Boolean).length).toBeGreaterThanOrEqual(1);
  expect(batchesOf(other.dir, s2.queue.id)).toHaveLength(1);
  expect(journalOf("queue.handoff.prepared")).toBe(2);
});

test("a task owned by an active batch can't be handed to a second one", async () => {
  const { dir, proposal, A, C } = await ready();
  const saved = must(await saveWith(dir, proposal.id, [C, A]));
  const other = must(await batches.createBatch(dir, { taskIds: [A], policy }, batchDeps));
  const raw = JSON.parse(store.executionBatches.get(dir, other.id)!);
  raw.status = "approved";
  store.executionBatches.put({ id: other.id, projectPath: dir, status: "approved", data: JSON.stringify(raw), createdAt: raw.createdAt });
  const q = await queueOf(dir, proposal.id);
  expect(q.handoff.eligible.map((e) => e.taskId)).toEqual([C]);
  expect(q.handoff.excluded.map((e) => e.taskId)).toEqual([A]);
  expect(q.handoff.excluded[0]!.reasons.join(" ")).toContain("Execution Batch");
  const refused = await prepare(dir, q, { taskIds: [A] });
  expect(!refused.ok && refused.status).toBe(409);
  expect(saved.queue.revision).toBe(q.revision);
  expect(counts().runs).toBe(0);
});

test("a task without a worker, a paused queue and a stopped queue are not handed over", async () => {
  mark();
  const s = await synthetic();
  assign(s.A, s.dir);
  assign(s.C, s.dir); // B is blocked anyway
  const saved = must(await saveWith(s.dir, s.proposal.id, [s.C, s.A]));
  // Remove C's worker: it is ready but has nobody to run it.
  store.db.run("DELETE FROM employee_task_assignments WHERE task_id = ?", [s.C]);
  const q = await queueOf(s.dir, s.proposal.id);
  expect(q.handoff.excluded.map((e) => e.taskId)).toContain(s.C);

  const paused = must(await queues.setQueueStatus(s.dir, q.id, "pause", q.revision, deps));
  expect(paused.queue.handoff.canPrepare).toBe(false);
  expect(paused.queue.handoff.reason).toContain("paused");
  const refused = await prepare(s.dir, paused.queue);
  expect(!refused.ok && refused.status).toBe(409);
  const resumed = must(await queues.setQueueStatus(s.dir, q.id, "resume", paused.queue.revision, deps));
  const stopped = must(await queues.setQueueStatus(s.dir, q.id, "stop", resumed.queue.revision, deps));
  expect(stopped.queue.handoff.reason).toContain("stopped");
  expect(journalOf("queue.paused")).toBe(1);
  expect(journalOf("queue.resumed")).toBe(1);
  expect(journalOf("queue.stopped")).toBe(1);
  // A stale revision adds no journal row.
  const j = journalCount();
  const stale = await queues.setQueueStatus(s.dir, q.id, "pause", q.revision, deps);
  expect(stale.ok).toBe(false);
  expect(journalCount()).toBe(j);
  expect(saved.queue.id).toBe(q.id);
});

test("a deleted prerequisite keeps B out of every handoff (tombstone)", async () => {
  const { dir, proposal, A, B } = await ready();
  must(await saveWith(dir, proposal.id, [A]));
  store.tasks.update(A, { column: "done" });
  const mid = await queueOf(dir, proposal.id);
  const confirmed = must(await saveWith(dir, proposal.id, [A, B], mid.revision));
  await orchestrator.deleteTask(A);
  const q = await queueOf(dir, proposal.id);
  expect(confirmed.queue.id).toBe(q.id);
  const entry = q.entries.find((e) => e.taskId === B)!;
  expect(entry.state).not.toBe("ready");
  expect(q.handoff.eligible.map((e) => e.taskId)).not.toContain(B);
  const view = await planOf(dir, proposal.id);
  const forced = await queues.prepareQueueBatch(dir, q.id, { revision: q.revision, planKey: view.planKey, taskIds: [B], policy }, { ...deps, ...batchDeps });
  expect(!forced.ok && forced.status).toBe(409);
  expect(batchesOf(dir, q.id)).toHaveLength(0);
});

test("a disabled harness and Unknown quota: the draft can't be approved on a disabled harness, and limits stay Unknown", async () => {
  const { dir, proposal, A, C } = await ready();
  const saved = must(await saveWith(dir, proposal.id, [C, A]));
  const out = must(await prepare(dir, saved.queue));
  const unknown = out.batch.preview!.issues.find((i) => i.code === "limits-unknown");
  expect(unknown?.message).toContain("can't see any account's remaining limits");
  expect(out.batch.preview!.issues.map((i) => i.message).join(" ")).not.toMatch(/verified|quota available/i);
  expect(counts().observations).toBe(0);

  store.harnesses.setEnabled("codex", false);
  try {
    const re = must(await batches.previewBatch(dir, out.batch.id, batchDeps));
    expect(re.preview!.canApprove).toBe(false);
    const approve = await batches.approveBatch(dir, out.batch.id, approveInput(re), batchDeps);
    expect(!approve.ok && approve.status).toBe(409);
  } finally {
    store.harnesses.setEnabled("codex", true);
  }
  expect(counts().runs).toBe(0);
});

// ----- authorization --------------------------------------------------------------------------------

test("approval is the Owner's authorization: journaled once, expires, and cancelling revokes it and frees the tasks", async () => {
  const { dir, proposal, A, C } = await ready();
  const saved = must(await saveWith(dir, proposal.id, [C, A]));
  const out = must(await prepare(dir, saved.queue));
  const bad = await batches.approveBatch(dir, out.batch.id, approveInput(out.batch, { authorizationMinutes: 1 }), batchDeps);
  expect(!bad.ok && bad.status).toBe(400);
  const ok = must(await batches.approveBatch(dir, out.batch.id, approveInput(out.batch, { authorizationMinutes: 30 }), batchDeps));
  expect(ok.batch.status).toBe("approved");
  const approval = ok.batch.approval!;
  expect(approval.expiresAt!).toBeGreaterThan(Date.now() + 29 * 60_000);
  expect(approval.expiresAt!).toBeLessThanOrEqual(Date.now() + 30 * 60_000);
  expect(approval.fullAccessTaskIds).toEqual([]);
  expect(journalOf("queue.authorization.granted")).toBe(1);
  // A replayed approval adds nothing.
  must(await batches.approveBatch(dir, out.batch.id, approveInput(ok.batch), batchDeps));
  expect(journalOf("queue.authorization.granted")).toBe(1);
  expect(scheduling.activeBatchesFor(dir, A)).toEqual([out.batch.id]);
  expect(counts().runs).toBe(0);

  const q = await queueOf(dir, proposal.id);
  expect(q.batches[0]).toMatchObject({ status: "approved", expired: false });
  expect(q.handoff.eligible).toEqual([]);

  const revoked = must(await batches.cancelBatch(dir, out.batch.id));
  expect(revoked.status).toBe("cancelled");
  expect(journalOf("queue.authorization.revoked")).toBe(1);
  must(await batches.cancelBatch(dir, out.batch.id)); // idempotent
  expect(journalOf("queue.authorization.revoked")).toBe(1);
  expect(scheduling.activeBatchesFor(dir, A)).toEqual([]);
  expect(counts().runs).toBe(0);
  const after = await queueOf(dir, proposal.id);
  expect(after.handoff.eligible.map((e) => e.taskId)).toContain(A);
});

test("an expired approval can't start and a started batch pauses instead of launching", async () => {
  const { dir, proposal, A, C } = await ready();
  const saved = must(await saveWith(dir, proposal.id, [C, A]));
  const out = must(await prepare(dir, saved.queue));
  const ok = must(await batches.approveBatch(dir, out.batch.id, approveInput(out.batch, { authorizationMinutes: 30 }), batchDeps));
  const raw = JSON.parse(store.executionBatches.get(dir, out.batch.id)!);
  raw.approval.expiresAt = Date.now() - 1000;
  store.executionBatches.put({ id: out.batch.id, projectPath: dir, status: "approved", data: JSON.stringify(raw), createdAt: raw.createdAt });
  const started = await batches.startBatch(dir, out.batch.id, batchDeps);
  expect(!started.ok && started.status).toBe(409);
  expect(!started.ok && started.error).toContain("expired");
  expect(runsOf(C) + runsOf(A)).toBe(0);
  const q = await queueOf(dir, proposal.id);
  expect(q.batches[0]!.expired).toBe(true);
  expect(ok.batch.id).toBe(out.batch.id);

  // Expiry while running: the next tick pauses and launches nothing.
  const other = await ready(false);
  const s2 = must(await saveWith(other.dir, other.proposal.id, [other.C, other.A]));
  const o2 = must(await prepare(other.dir, s2.queue));
  must(await batches.approveBatch(other.dir, o2.batch.id, approveInput(o2.batch), batchDeps));
  const r2 = JSON.parse(store.executionBatches.get(other.dir, o2.batch.id)!);
  r2.status = "running";
  r2.approval.expiresAt = Date.now() - 1000;
  store.executionBatches.put({ id: o2.batch.id, projectPath: other.dir, status: "running", data: JSON.stringify(r2), createdAt: r2.createdAt });
  await batches.requestTick(o2.batch.id, batchDeps);
  const paused = batches.getBatch(other.dir, o2.batch.id);
  expect(paused.ok && paused.value.status).toBe("paused");
  expect(paused.ok && paused.value.reason?.code).toBe("authorization-expired");
  expect(runsOf(other.C) + runsOf(other.A)).toBe(0);
});

test("full access needs its own acknowledgement per task; without it the approval is refused, and later escalation is held", async () => {
  const { dir, proposal, A, C } = await ready();
  store.tasks.update(A, { agent: "codex", mode: "full-access" as never });
  const saved = must(await saveWith(dir, proposal.id, [C, A]));
  const out = must(await prepare(dir, saved.queue));
  const warn = out.batch.preview!.issues.filter((i) => i.code === "queue-full-access");
  expect(warn.map((w) => w.taskId)).toEqual([A]);
  const refused = await batches.approveBatch(dir, out.batch.id, approveInput(out.batch), batchDeps);
  expect(!refused.ok && refused.status).toBe(400);
  expect(!refused.ok && (refused.body as { missingFullAccessTaskIds?: string[] }).missingFullAccessTaskIds).toEqual([A]);
  // Acknowledging a different task doesn't count.
  const wrong = await batches.approveBatch(dir, out.batch.id, approveInput(out.batch, { acknowledgeFullAccess: [C] }), batchDeps);
  expect(!wrong.ok && wrong.status).toBe(400);
  const ok = must(await batches.approveBatch(dir, out.batch.id, approveInput(out.batch, { acknowledgeFullAccess: [A] }), batchDeps));
  expect(ok.batch.approval!.fullAccessTaskIds).toEqual([A]);
  expect(ok.batch.approval!.maxAccessLevel).toBeGreaterThanOrEqual(3);
  expect(counts().runs).toBe(0);
});

test("no hidden permission escalation: a task whose mode is raised after approval is held, not started", async () => {
  const { dir, proposal, A, C } = await ready();
    const saved = must(await saveWith(dir, proposal.id, [C, A]));
  const out = must(await prepare(dir, saved.queue));
  must(await batches.approveBatch(dir, out.batch.id, approveInput(out.batch), batchDeps));
  store.tasks.update(C, { mode: "full-access" as never });
  const started = must(await batches.startBatch(dir, out.batch.id, batchDeps));
  const entryC = started.batch.entries.find((e) => e.taskId === C)!;
  expect(runsOf(C)).toBe(0);
  expect(entryC.hold?.code).toMatch(/task-changed|configuration-changed|access-broadened|full-access/);
  const q = await queueOf(dir, proposal.id);
  expect(q.batches[0]!.fullAccessTaskIds).toEqual([]);
});

// ----- execution ownership, pause/stop, recovery ----------------------------------------------------

test("Queue → Batch → Running → Paused → recovery: one run, the batch keeps ownership, the queue can't start it again", async () => {
  process.env.AGETOR_FAKE_CODEX_RESOLVE_DELAY_MS = "60000";
  try {
    const { dir, proposal, A, C } = await ready();
        const saved = must(await saveWith(dir, proposal.id, [C, A]));
    const out = must(await prepare(dir, saved.queue));
    must(await batches.approveBatch(dir, out.batch.id, approveInput(out.batch), batchDeps));
    const started = must(await batches.startBatch(dir, out.batch.id, batchDeps));
    expect(started.batch.status).toBe("running");
    // Owner order, one at a time: C runs, A waits.
    expect(runsOf(C)).toBe(1);
    expect(runsOf(A)).toBe(0);

    let q = await queueOf(dir, proposal.id);
    expect(q.batches[0]).toMatchObject({ status: "running" });
    expect(q.entries.find((e) => e.taskId === C)!.batchIds).toEqual([out.batch.id]);
    expect(q.next?.taskId).not.toBe(C);
    const again = await prepare(dir, q, { taskIds: [C] });
    expect(!again.ok && again.status).toBe(409);

    must(await batches.pauseBatch(dir, out.batch.id));
    q = await queueOf(dir, proposal.id);
    expect(q.batches[0]!.status).toBe("paused");
    expect(scheduling.activeBatchesFor(dir, C)).toEqual([out.batch.id]);

    batches.__testing.simulateRestart();
    q = await queueOf(dir, proposal.id);
    expect(q.batches[0]!.status).toBe("paused");
    expect(runsOf(C)).toBe(1);
    expect(runsOf(A)).toBe(0);

    const stopped = must(await batches.cancelBatch(dir, out.batch.id));
    expect(stopped.status).toBe("cancelled");
    expect(journalOf("queue.authorization.revoked")).toBeGreaterThanOrEqual(1);
    expect(scheduling.activeBatchesFor(dir, C)).toEqual([]);
    expect(runsOf(C)).toBe(1); // cancelling a batch starts nothing and stops nothing else
  } finally {
    delete process.env.AGETOR_FAKE_CODEX_RESOLVE_DELAY_MS;
  }
});

test("a running batch survives a restart as paused and the queue still shows its ownership", async () => {
  process.env.AGETOR_FAKE_CODEX_RESOLVE_DELAY_MS = "60000";
  try {
    const { dir, proposal, A, C } = await ready();
        const saved = must(await saveWith(dir, proposal.id, [C, A]));
    const out = must(await prepare(dir, saved.queue));
    must(await batches.approveBatch(dir, out.batch.id, approveInput(out.batch), batchDeps));
    must(await batches.startBatch(dir, out.batch.id, batchDeps));
    batches.__testing.simulateRestart();
    const q = await queueOf(dir, proposal.id);
    expect(q.batches[0]!.status).toBe("paused");
    expect(q.batches[0]!.reason).toContain("restarted");
    expect(runsOf(C)).toBe(1);
    expect(runsOf(A)).toBe(0);
    must(await batches.cancelBatch(dir, out.batch.id));
  } finally {
    delete process.env.AGETOR_FAKE_CODEX_RESOLVE_DELAY_MS;
  }
});

// ----- journal --------------------------------------------------------------------------------------

test("Owner actions are journaled once; reads, previews and replays write nothing", async () => {
  const { dir, proposal, A, C } = await ready();
  const saved = must(await saveWith(dir, proposal.id, [C, A]));
  expect(journalOf("queue.plan.confirmed")).toBe(1);
  const j = journalCount();
  for (let i = 0; i < 3; i++) await queueOf(dir, proposal.id);
  expect(journalCount()).toBe(j);
  // Saving the same queue again with the old revision is a conflict and records nothing.
  const conflict = await saveWith(dir, proposal.id, [C, A], saved.queue.revision + 3);
  expect(conflict.ok).toBe(false);
  expect(journalCount()).toBe(j);
  const out = must(await prepare(dir, saved.queue));
  expect(journalCount()).toBe(j + 1);
  must(await batches.previewBatch(dir, out.batch.id, batchDeps));
  expect(journalCount()).toBe(j + 1);
  // Only audit rows were added: no run or assignment events were invented.
  // (The test setup's own worker assignments are real events; the handoff adds none.)
  expect(journalOf("run.completed") + journalOf("run.failed")).toBe(0);
  const ev = store.db.query<{ payload_json: string }, [string]>("SELECT payload_json FROM activity_events WHERE event_type = 'queue.handoff.prepared' AND target_id = ?").get(proposal.id)!;
  expect(JSON.parse(ev.payload_json)).toMatchObject({ queueId: saved.queue.id, batchId: out.batch.id, count: 2 });
  // The journal core itself refuses a duplicate key.
  const { ActivityJournalCore } = await import("./activity-journal-core.ts");
  const core = new ActivityJournalCore(store.db);
  const input = { eventType: "queue.stopped" as const, projectPath: dir, actorType: "owner" as const, actorId: "owner", targetType: "proposal" as const, targetId: proposal.id, idempotencyKey: "dup-key", payload: { queueId: "q", proposalId: proposal.id, queueRevision: 1 } };
  core.record(input);
  core.record(input);
  expect(store.db.query<{ n: number }, []>("SELECT COUNT(*) AS n FROM activity_events WHERE idempotency_key = 'dup-key'").get()!.n).toBe(1);
});
