import { afterAll, beforeAll, beforeEach, expect, test } from "bun:test";
import { mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { startableNodes, type PlanView } from "../shared/task-plan.ts";
import { parseProposal, type ProposalItem, type TaskProposal } from "../shared/project-manager.ts";

/**
 * FO-ORCH05 controlled execution queue and dependency safety. Fake codex driver behind a /bin/echo stub, a
 * disposable SQLite and temp project folders: no real AI CLI runs and no
 * provider is reached. The plan routes are read-only, so most tests also
 * assert that nothing was written (runs, assignments, journal, tasks).
 */
const isolated = realpathSync(mkdtempSync(path.join(tmpdir(), "foorch05-")));
process.env.AGETOR_DATA_DIR = isolated;
process.env.FORGEORBIT_DATA_DIR = isolated;
process.env.CODEX_HOME = path.join(isolated, ".codex");
process.env.HOME = isolated;
process.env.AGETOR_API_PORT = "4745";
process.env.AGETOR_USAGE_OFFLINE = "1";
process.env.AGETOR_CODEX_DRIVER = "fake";
process.env.AGETOR_CODEX_BIN = "/bin/echo";
process.env.AGETOR_TMUX_BIN = "/bin/echo";
for (const kind of ["CLAUDE", "CURSOR", "GEMINI", "FX", "ANTIGRAVITY"]) process.env["AGETOR_" + kind + "_BIN"] = "/nonexistent/foorch05";

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
const base = "http://127.0.0.1:4745";
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


/** Queue saves, pauses and stops are Owner decisions and are journaled (FO-ORCH07); nothing else may be. */
const nonQueueJournal = () => store.db.query<{ n: number }, []>("SELECT COUNT(*) AS n FROM activity_events WHERE event_type NOT LIKE 'queue.%'").get()!.n;
const withoutQueueJournal = <T extends { journal: number }>(c: T) => ({ ...c, journal: nonQueueJournal() });

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

// ----- queue planning ---------------------------------------------------------------------------------

test("A and C can be queued, B is blocked and can't be; the Owner's order decides what is next", async () => {
  const { dir, proposal, A, B, C } = await synthetic();
  const refused = await saveQueue(dir, proposal.id, [A, B]);
  expect(refused.ok).toBe(false);
  expect(!refused.ok && refused.status).toBe(409);
  expect(!refused.ok && refused.error).toContain("Task B");

  assign(A, dir);
  assign(C, dir);
  const before = withoutQueueJournal(counts());
  const journalBefore = counts().journal;
  const saved = must(await saveQueue(dir, proposal.id, [C, A]));
  expect(saved.queue.entries.map((e) => [e.title, e.state])).toEqual([["Task C", "ready"], ["Task A", "ready"]]);
  expect(saved.queue.next).toMatchObject({ title: "Task C", position: 1 });
  expect(saved.queue.readOnly).toBe(true);
  expect(saved.queue.needsReview).toBe(false);

  const reordered = must(await saveQueue(dir, proposal.id, [A, C], saved.queue.revision));
  expect(reordered.queue.next).toMatchObject({ title: "Task A" });
  expect(reordered.queue.revision).toBe(saved.queue.revision + 1);
  // A queue is only the Owner's order: no run, review, account or assignment was written, and the
  // journal gained only the two Owner confirmations (FO-ORCH07).
  expect(withoutQueueJournal(counts())).toEqual(before);
  expect(counts().journal).toBe(journalBefore + 2);
});

test("a Run that succeeded but sits in Review does not unblock B; Done does", async () => {
  const { dir, proposal, A, B, C } = await synthetic();
  assign(A, dir);
  assign(B, dir);
  assign(C, dir);
  must(await saveQueue(dir, proposal.id, [A, C]));

  store.tasks.update(A, { column: "review" });
  let view = must(await queues.getQueue(dir, proposal.id, deps)).queue!;
  expect(view.entries.find((e) => e.taskId === A)!.state).toBe("waiting-owner");
  expect((await planOf(dir, proposal.id)).nodes.find((n) => n.taskId === B)!.state).toBe("blocked");
  // B stays refused at every gate while A is in Review.
  const start = await orchestrator.startTask(B);
  expect("error" in start && start.error).toContain("dependencies are not satisfied");
  const pre = exec.prepareEmployeeExecution({ taskId: B, expectedAssignmentRevision: null });
  expect(pre.blockingErrors.map((e) => e.code)).toContain("dependency-not-done");
  expect(pre.outcome).toBe("blocked");
  // C is independent: it is still the queue's next.
  expect(view.next).toMatchObject({ title: "Task C" });

  store.tasks.update(A, { column: "done" });
  expect((await planOf(dir, proposal.id)).nodes.find((n) => n.taskId === B)!.state).toBe("ready");
  const withB = must(await saveQueue(dir, proposal.id, [A, C, B], view.revision));
  view = withB.queue;
  expect(view.entries.map((e) => [e.title, e.state])).toEqual([["Task A", "completed"], ["Task C", "ready"], ["Task B", "ready"]]);
  expect(exec.prepareEmployeeExecution({ taskId: B, expectedAssignmentRevision: null }).blockingErrors.map((e) => e.code)).not.toContain("dependency-not-done");
});

test("a queued task that becomes blocked is skipped, and nothing is next when none is ready", async () => {
  const { dir, proposal, A, C } = await synthetic();
  assign(A, dir);
  assign(C, dir);
  const saved = must(await saveQueue(dir, proposal.id, [A, C]));
  // The Owner makes C wait for A after queueing it.
  const changed = scheduling.updateScheduling(dir, C, { dependsOn: [A] });
  expect(changed.ok).toBe(true);
  const view = must(await queues.getQueue(dir, proposal.id, deps)).queue!;
  expect(view.entries.find((e) => e.taskId === C)!.state).toBe("blocked");
  expect(view.next).toMatchObject({ title: "Task A" });
  expect(view.needsReview).toBe(true);
  store.tasks.update(A, { column: "review" });
  const waiting = must(await queues.getQueue(dir, proposal.id, deps)).queue!;
  expect(waiting.next).toBeNull();
  expect(waiting.nextBlockedReason).toContain("No task of this queue is ready");
  expect(saved.queue.id).toBe(waiting.id);
});

test("a task without a worker is not next until someone is assigned, and the plan change asks for a new review", async () => {
  const { dir, proposal, C } = await synthetic();
  const saved = must(await saveQueue(dir, proposal.id, [C]));
  expect(saved.queue.entries[0]).toMatchObject({ state: "waiting-owner", needsAssignment: true });
  expect(saved.queue.next).toBeNull();

  const person = assign(C, dir);
  expect(person.id).toBeTruthy();
  const stale = await queues.nextQueueTask(dir, saved.queue.id, { revision: saved.queue.revision, planKey: saved.queue.planKey }, deps);
  expect(!stale.ok && stale.status).toBe(409);
  expect(!stale.ok && stale.error).toContain("changed");
  const fresh = must(await saveQueue(dir, proposal.id, [C], saved.queue.revision));
  expect(fresh.queue.next).toMatchObject({ title: "Task C" });
  const next = must(await queues.nextQueueTask(dir, fresh.queue.id, { revision: fresh.queue.revision, planKey: fresh.queue.planKey }, deps));
  expect(next.next.taskId).toBe(C);
});

test("a stale plan key, a stale queue revision, a changed assignment or a changed permission mode are refused", async () => {
  const { dir, proposal, A, C } = await synthetic();
  assign(A, dir);
  assign(C, dir);
  const first = await planOf(dir, proposal.id);
  must(await queues.saveQueue(dir, proposal.id, { taskIds: [A, C], planKey: first.planKey }, deps));
  const saved = must(await queues.getQueue(dir, proposal.id, deps)).queue!;
  const before = counts();

  // Stale plan key on save.
  store.taskScheduling.setPriority(C, "critical");
  const staleSave = await queues.saveQueue(dir, proposal.id, { taskIds: [A], planKey: first.planKey, revision: saved.revision }, deps);
  expect(!staleSave.ok && staleSave.status).toBe(409);
  expect(!staleSave.ok && (staleSave.body as { stale?: boolean }).stale).toBe(true);
  // Stale revision.
  const keyNow = (await planOf(dir, proposal.id)).planKey;
  const staleRev = await queues.saveQueue(dir, proposal.id, { taskIds: [A], planKey: keyNow, revision: saved.revision + 5 }, deps);
  expect(!staleRev.ok && staleRev.status).toBe(409);
  // Changed assignment: another worker takes C.
  const reviewed = must(await queues.saveQueue(dir, proposal.id, { taskIds: [A, C], planKey: keyNow, revision: saved.revision }, deps));
  let q = reviewed.queue;
  new AssignmentCore(store.db).reassign(C, new EmployeeCore(store.db).createWorker({ name: `Other ${++counter}`, jobTitle: "QA", projectPath: dir }).id, 1);
  let next = await queues.nextQueueTask(dir, q.id, { revision: q.revision, planKey: (await planOf(dir, proposal.id)).planKey }, deps);
  expect(!next.ok && next.status).toBe(409);
  expect(!next.ok && next.error).toContain("changed since you last reviewed");
  // Changed permission mode.
  q = must(await saveQueue(dir, proposal.id, [A, C], q.revision)).queue;
  expect(must(await queues.nextQueueTask(dir, q.id, { revision: q.revision, planKey: q.planKey }, deps)).next.taskId).toBe(A);
  store.tasks.update(A, { mode: "plan" as never });
  next = await queues.nextQueueTask(dir, q.id, { revision: q.revision, planKey: q.planKey }, deps);
  expect(!next.ok && next.status).toBe(409);
  // A wrong planKey is refused outright.
  expect((await queues.nextQueueTask(dir, q.id, { revision: q.revision, planKey: "x".repeat(32) }, deps)).ok).toBe(false);
  expect(counts().runs).toBe(before.runs);
  expect(counts().executions).toBe(before.executions);
});

test("unknown quota stays Unknown in the queue and nothing is chosen automatically", async () => {
  const { dir, proposal, A, C } = await synthetic();
  assign(A, dir);
  assign(C, dir);
  const view = await planOf(dir, proposal.id, true);
  must(await queues.saveQueue(dir, proposal.id, { taskIds: [A, C], planKey: view.planKey }, present));
  const queue = must(await queues.getQueue(dir, proposal.id, present)).queue!;
  const entry = queue.entries[0]!;
  expect(entry.node!.executor).not.toBeNull();
  expect(entry.node!.executor!.automaticSelection).toBe("none");
  expect(entry.node!.executor!.proposed!.classification).toBe("potential-unknown");
  expect(entry.node!.executor!.proposed!.availability).toBe("unknown");
  expect(queue.needsReview).toBe(false);
});

test("verified exhausted quota still blocks the launch at Employee Preflight; the queue never bypasses it", async () => {
  const { dir, proposal, A, C } = await synthetic();
  assign(A, dir);
  assign(C, dir);
  const saved = must(await saveQueue(dir, proposal.id, [A, C]));
  const core = new AccountCore(store.db);
  const account = core.createAccount({ provider: "anthropic", displayName: "Synthetic exhaustion" });
  core.bindHarness(account.id, "claude-code");
  const expiresAt = Date.now() + 60_000;
  core.setModelCapability(account.id, "claude-code", "opus-5.5", { support: "supported", expiresAt });
  const quota = core.createDefinition({ accountId: account.id, subscriptionId: null, scope: "model:opus-5.5", unit: { kind: "requests" }, window: "week" });
  core.recordTrustedObservations("anthropic-admin", [{
    quotaId: quota.id,
    values: { remaining: 0, limit: 1, used: 1, expiresAt },
    evidence: {
      provider: "anthropic", accountId: account.id, subject: "synthetic-subject", method: "provider-account", sourceId: "anthropic-admin",
      officialUrl: "https://platform.claude.com/docs/en/manage-claude/usage-cost-api", checkedAt: "2026-10-28", receivedAt: Date.now(),
      sharedPool: null, limitations: "synthetic acceptance evidence",
    },
  }]);
  // New evidence makes the reviewed queue stale.
  const stale = await queues.nextQueueTask(dir, saved.queue.id, { revision: saved.queue.revision, planKey: (await planOf(dir, proposal.id, true)).planKey }, present);
  expect(stale.ok).toBe(false);
  const pre = exec.prepareEmployeeExecution({ taskId: A, expectedAssignmentRevision: null, harnessId: "claude-code", model: "opus-5.5" });
  expect(pre.outcome).toBe("blocked");
  expect(pre.blockingErrors.map((e) => e.code)).toContain("resource-excluded");
});

// ----- pause / stop / duplicate guard --------------------------------------------------------------

test("pause and stop hold the queue without touching a running task; resume and restart are explicit", async () => {
  const { dir, proposal, A, C } = await synthetic();
  assign(A, dir);
  assign(C, dir);
  const saved = must(await saveQueue(dir, proposal.id, [A, C]));
  const next = (q: { id: string; revision: number }, key: string) => queues.nextQueueTask(dir, q.id, { revision: q.revision, planKey: key }, deps);

  const paused = must(await queues.setQueueStatus(dir, saved.queue.id, "pause", saved.queue.revision, deps));
  expect(paused.queue.status).toBe("paused");
  const pausedNext = await next(paused.queue, paused.queue.planKey);
  expect(!pausedNext.ok && pausedNext.error).toContain("paused");
  expect((await queues.setQueueStatus(dir, saved.queue.id, "pause", paused.queue.revision, deps)).ok).toBe(false);
  expect((await queues.setQueueStatus(dir, saved.queue.id, "resume", saved.queue.revision, deps)).ok).toBe(false); // stale revision

  const resumed = must(await queues.setQueueStatus(dir, saved.queue.id, "resume", paused.queue.revision, deps));
  expect(resumed.queue.status).toBe("active");
  expect(must(await next(resumed.queue, resumed.queue.planKey)).next.taskId).toBe(A);

  // A running task of the queue holds the next one back (no duplicate or parallel advance).
  store.tasks.update(A, { column: "running" });
  const busyKey = (await planOf(dir, proposal.id)).planKey;
  const running = must(await queues.getQueue(dir, proposal.id, deps)).queue!;
  expect(running.next).toBeNull();
  expect(running.nextBlockedReason).toContain("running");
  store.tasks.update(A, { column: "ready" });

  const stopped = must(await queues.setQueueStatus(dir, saved.queue.id, "stop", resumed.queue.revision, deps));
  expect(stopped.queue.status).toBe("stopped");
  expect(busyKey).toBeTruthy();
  const stoppedNext = await next(stopped.queue, stopped.queue.planKey);
  expect(!stoppedNext.ok && stoppedNext.error).toContain("stopped");
  expect((await queues.setQueueStatus(dir, saved.queue.id, "resume", stopped.queue.revision, deps)).ok).toBe(false);
  // Saving again is the Owner's explicit decision to start over.
  const restarted = must(await saveQueue(dir, proposal.id, [C], stopped.queue.revision));
  expect(restarted.queue.status).toBe("active");
  expect(restarted.queue.entries.map((e) => e.taskId)).toEqual([C]);
});

test("the queue persists in the database and is rebuilt from the plan after a reload", async () => {
  const { dir, proposal, A, C } = await synthetic();
  assign(A, dir);
  assign(C, dir);
  const saved = must(await saveQueue(dir, proposal.id, [C, A]));
  const row = store.taskQueues.forProposal(dir, proposal.id)!;
  expect(row).toMatchObject({ id: saved.queue.id, taskIds: [C, A], status: "active", revision: 1 });
  // Only the Owner's decision is stored; states are derived.
  expect(Object.keys(row).sort()).toEqual(["autoPrepare", "createdAt", "id", "projectPath", "proposalId", "reviewedPlanKey", "reviewedSnapshot", "revision", "status", "taskIds", "updatedAt"]);
  store.tasks.update(C, { column: "done" });
  const reread = must(await queues.getQueue(dir, proposal.id, deps)).queue!;
  expect(reread.entries.map((e) => e.state)).toEqual(["completed", "ready"]);
  expect(reread.next).toMatchObject({ title: "Task A" });
  // A deleted task shows as removed, never as ready.
  await orchestrator.deleteTask(A);
  const afterDelete = must(await queues.getQueue(dir, proposal.id, deps)).queue!;
  expect(afterDelete.entries.map((e) => e.state)).toEqual(["completed", "removed"]);
  expect(afterDelete.next).toBeNull();
});

test("the queue reads and writes only for a registered project and its own plans", async () => {
  const { dir, proposal, C } = await synthetic();
  assign(C, dir);
  expect((await queues.getQueue("/not/registered", proposal.id, deps)).ok).toBe(false);
  expect((await queues.getQueue(dir, "missing-plan", deps)).ok).toBe(false);
  const other = project("other-queue");
  expect((await queues.saveQueue(other, proposal.id, { taskIds: [C], planKey: "abc" }, deps)).ok).toBe(false);
  const v = await planOf(dir, proposal.id);
  expect((await queues.saveQueue(dir, proposal.id, { taskIds: [], planKey: v.planKey }, deps)).ok).toBe(false);
  expect((await queues.saveQueue(dir, proposal.id, { taskIds: [C, C], planKey: v.planKey }, deps)).ok).toBe(false);
  expect((await queues.saveQueue(dir, proposal.id, { taskIds: ["nope"], planKey: v.planKey }, deps)).ok).toBe(false);
});

// ----- dependency safety ----------------------------------------------------------------------------

test("deleting A does not make B startable at any gate until the Owner clears the link", async () => {
  const { dir, proposal, A, B } = await synthetic();
  assign(B, dir);
  expect(store.taskScheduling.dependenciesOf(B)).toEqual([A]);
  await orchestrator.deleteTask(A);
  // The dependency row is gone, the tombstone is not.
  expect(store.taskScheduling.dependenciesOf(B)).toEqual([]);
  expect(store.taskScheduling.tombstonesOf(B).map((t) => [t.missingId, t.title])).toEqual([[A, "Task A"]]);

  // Task Plan View.
  const node = (await planOf(dir, proposal.id)).nodes.find((n) => n.taskId === B)!;
  expect(node.state).toBe("blocked");
  expect(node.reasons.join(" ")).toContain("Task A");
  expect(node.reasons.join(" ")).toContain("deleted");
  expect(node.reasons.filter((r) => r.includes("deleted"))).toHaveLength(1);
  // Scheduling view.
  const view = scheduling.listScheduling(dir);
  const row = view.ok ? view.value.tasks.find((t) => t.taskId === B)! : null;
  expect(row!.readiness.state).toBe("blocked");
  expect(row!.deletedDependencies).toMatchObject([{ taskId: A, title: "Task A" }]);
  // Queue.
  expect((await saveQueue(dir, proposal.id, [B])).ok).toBe(false);
  // Direct start, re-run and every caller of startTask.
  const start = await orchestrator.startTask(B);
  expect("error" in start && start.error).toContain("deleted");
  // Employee preflight.
  const pre = exec.prepareEmployeeExecution({ taskId: B, expectedAssignmentRevision: null });
  expect(pre.blockingErrors.map((e) => e.code)).toContain("dependency-deleted");
  // Execution batches: the preview refuses to approve it.
  const batch = must(await batches.createBatch(dir, { taskIds: [B], policy: { noOverageHarnessIds: ["codex"] } }, batchDeps));
  expect(batch.preview!.issues.map((i) => i.code)).toContain("dependency-deleted");
  expect(batch.preview!.canApprove).toBe(false);
  expect(store.db.query<{ n: number }, [string]>("SELECT COUNT(*) AS n FROM runs WHERE task_id = ?").get(B)!.n).toBe(0);

  // The Owner clears the link explicitly; editing other links does not.
  const other = scheduling.updateScheduling(dir, B, { priority: "high" });
  expect(other.ok).toBe(true);
  expect(store.taskScheduling.tombstonesOf(B)).toHaveLength(1);
  const wrong = scheduling.updateScheduling(dir, B, { acknowledgeMissing: ["not-recorded"] });
  expect(!wrong.ok && wrong.status).toBe(404);
  const cleared = scheduling.updateScheduling(dir, B, { acknowledgeMissing: [A] });
  expect(cleared.ok).toBe(true);
  expect(store.taskScheduling.tombstonesOf(B)).toEqual([]);
  expect(store.taskScheduling.clearedMissingOf(B)).toEqual([A]);
  expect((await planOf(dir, proposal.id)).nodes.find((n) => n.taskId === B)!.state).toBe("ready");
  expect(exec.prepareEmployeeExecution({ taskId: B, expectedAssignmentRevision: null }).blockingErrors.map((e) => e.code)).not.toContain("dependency-deleted");
});

test("a task that never had a dependency gets none invented, and a deleted task without dependents leaves no tombstone", async () => {
  const dir = project("plain");
  const one = await orchestrator.createTask({ title: "Plain one", prompt: "p", workdir: dir, isolation: "none" } as never);
  const two = await orchestrator.createTask({ title: "Plain two", prompt: "p", workdir: dir, isolation: "none" } as never);
  if ("error" in one || "error" in two) throw new Error("create failed");
  await orchestrator.deleteTask(one.task.id);
  expect(store.taskScheduling.tombstonesOf(two.task.id)).toEqual([]);
  expect(store.taskScheduling.blockingDependenciesOf(two.task.id)).toEqual([]);
  expect(store.db.query<{ n: number }, []>("SELECT COUNT(*) AS n FROM task_dependency_tombstones WHERE missing_id = '" + one.task.id + "'").get()!.n).toBe(0);
  const done = await orchestrator.startTask(two.task.id);
  expect("error" in done ? done.error : "").not.toContain("dependenc");
});

test("deleting a dependent removes its tombstones with it", async () => {
  const { A, B } = await synthetic();
  await orchestrator.deleteTask(A);
  expect(store.taskScheduling.tombstonesOf(B)).toHaveLength(1);
  await orchestrator.deleteTask(B);
  expect(store.db.query<{ n: number }, [string]>("SELECT COUNT(*) AS n FROM task_dependency_tombstones WHERE task_id = ?").get(B)!.n).toBe(0);
});

test("no automatic start, retry or account change happens while queues are read, saved, paused or advanced", async () => {
  const { dir, proposal, A, C } = await synthetic();
  assign(A, dir);
  assign(C, dir);
  const before = withoutQueueJournal(counts());
  const saved = must(await saveQueue(dir, proposal.id, [A, C]));
  must(await queues.nextQueueTask(dir, saved.queue.id, { revision: saved.queue.revision, planKey: saved.queue.planKey }, deps));
  const paused = must(await queues.setQueueStatus(dir, saved.queue.id, "pause", saved.queue.revision, deps));
  must(await queues.setQueueStatus(dir, saved.queue.id, "resume", paused.queue.revision, deps));
  expect(withoutQueueJournal(counts())).toEqual(before);
  expect(store.tasks.get(A)!.column).toBe("backlog");
  expect(store.tasks.get(A)!.runId).toBeNull();
});
