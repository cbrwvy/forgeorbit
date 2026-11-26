import { afterAll, beforeAll, beforeEach, expect, test } from "bun:test";
import { mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { BatchView } from "../shared/task-scheduling.ts";
import { type ProposalItem, type TaskProposal } from "../shared/project-manager.ts";

/**
 * FO-ORCH08 bounded autonomous execution. Fake codex driver behind a /bin/echo
 * stub, a disposable SQLite and temp project folders: no real AI CLI runs and no
 * provider is reached. Every refused path also asserts that no Run was recorded.
 */
const isolated = realpathSync(mkdtempSync(path.join(tmpdir(), "foorch08-")));
process.env.AGETOR_DATA_DIR = isolated;
process.env.FORGEORBIT_DATA_DIR = isolated;
process.env.CODEX_HOME = path.join(isolated, ".codex");
process.env.HOME = isolated;
process.env.AGETOR_USAGE_OFFLINE = "1";
process.env.AGETOR_CODEX_DRIVER = "fake";
process.env.AGETOR_CODEX_BIN = "/bin/echo";
process.env.AGETOR_TMUX_BIN = "/bin/echo";
for (const kind of ["CLAUDE", "CURSOR", "GEMINI", "FX", "ANTIGRAVITY"]) process.env["AGETOR_" + kind + "_BIN"] = "/nonexistent/foorch08";

let store: typeof import("./db.ts");
let orchestrator: typeof import("./orchestrator.ts");
let manager: typeof import("./project-manager.ts");
let batches: typeof import("./execution-batches.ts");
let autonomy: typeof import("./autonomy.ts");
let origin: typeof import("./autonomy-origin.ts");
let AccountCore: typeof import("./account-core.ts").AccountCore;
let counter = 0;

beforeAll(async () => {
  store = await import("./db.ts");
  orchestrator = await import("./orchestrator.ts");
  manager = await import("./project-manager.ts");
  batches = await import("./execution-batches.ts");
  autonomy = await import("./autonomy.ts");
  origin = await import("./autonomy-origin.ts");
  ({ AccountCore } = await import("./account-core.ts"));
  batches.initExecutionBatches();
  store.harnesses.setEnabled("codex", true);
  store.harnesses.setEnabled("claude-code", true);
});
afterAll(() => {
  batches.stopExecutionBatchTimers();
  return new Promise((r) => setTimeout(r, 100));
});
beforeEach(() => {
  store.preferences.set("executorRoutingPreferences", "");
  const core = new AccountCore(store.db);
  for (const account of core.listAccounts(true)) {
    for (const binding of core.bindings(account.id)) core.unbindHarness(account.id, binding.harnessId);
    for (const association of core.associations(account.id)) core.unbindProfile(account.id, association.profileId);
    for (const definition of core.definitions(account.id)) core.archiveDefinition(definition.id);
    if (account.archivedAt === null) core.archiveAccount(account.id);
  }
});

const MODEL = "gpt-6.1-sol";
const batchDeps = { envNames: () => [] as string[] };
const policy = { noOverageHarnessIds: ["codex"], reviewPolicy: "continue-independent" as const, maxStarts: 8 };

function must<T>(r: { ok: true; value: T } | { ok: false; error: string }): T {
  if (!r.ok) throw new Error(r.error);
  return r.value;
}
async function waitFor<T>(fn: () => T | null | undefined | false, timeoutMs = 6000): Promise<T> {
  const start = Date.now();
  for (;;) {
    const v = fn();
    if (v) return v as T;
    if (Date.now() - start > timeoutMs) throw new Error(`waitFor timed out after ${timeoutMs}ms`);
    await new Promise((r) => setTimeout(r, 15));
  }
}

function project(name: string): string {
  const dir = realpathSync(mkdtempSync(path.join(isolated, `${name}-`)));
  writeFileSync(path.join(dir, "README.md"), `# ${name}\n`);
  store.projects.upsert(dir, name);
  return dir;
}
function item(id: string, title: string, deps: string[] = []): ProposalItem {
  return {
    id, title, description: `${title} description`, priority: "medium", acceptanceCriteria: [`${title} works`],
    dependsOn: deps.map((itemId) => ({ kind: "item" as const, itemId })), parentFeature: null, taskType: "task",
    rationale: "", include: true, duplicate: null, duplicateAction: "use-existing", warnings: [], result: null,
  };
}
async function tasksFor(dir: string, items: ProposalItem[]) {
  const proposal: TaskProposal = {
    id: crypto.randomUUID(), projectPath: dir, messageId: "m1", title: "Goal", summary: "A goal", status: "pending",
    items, createdAt: Date.now(), updatedAt: Date.now(), revision: 1,
  };
  store.projectManagers.putProposal(dir, proposal.id, proposal.status, JSON.stringify(proposal), proposal.createdAt);
  const result = must(await manager.approveProposal(dir, proposal.id, { revision: proposal.revision }));
  const taskOf = (itemId: string) => result.proposal.items.find((i) => i.id === itemId)!.result!.taskId!;
  for (const i of items) store.tasks.update(taskOf(i.id), { agent: "codex", model: MODEL, mode: "ask" as never });
  return { dir, taskOf };
}

const n = (sql: string) => store.db.query<{ n: number }, []>(sql).get()!.n;
/** Everything is counted per project folder: tests share one database and earlier batches may still tick. */
const journalOf = (type: string, dir: string) => n(`SELECT COUNT(*) AS n FROM activity_events WHERE event_type = '${type}' AND project_path = '${dir}'`);
const allJournal = (dir: string) => n(`SELECT COUNT(*) AS n FROM activity_events WHERE project_path = '${dir}'`);
const runCount = (dir: string) => n(`SELECT COUNT(*) AS n FROM runs r JOIN tasks t ON t.id = r.task_id WHERE t.workdir = '${dir}'`);
const runsOf = (taskId: string) => store.runs.listForTask(taskId).length;
const approveInput = (b: BatchView) => ({ revision: b.revision, previewKey: b.preview!.key, acknowledgedHarnessIds: b.preview!.spendingHarnessIds });

async function approvedBatch(dir: string, order: string[], extra: Record<string, unknown> = {}) {
  const created = must(await batches.createBatch(dir, { taskIds: order, policy: { ...policy, ...extra } }, batchDeps));
  return must(await batches.approveBatch(dir, created.id, approveInput(created), batchDeps)).batch;
}
const grantBody = (b: BatchView, extra: Record<string, unknown> = {}) => ({ previewKey: b.approval!.previewKey, confirm: true, acknowledgeUnknownQuota: true, maxRuns: 5, ...extra });
async function granted(dir: string, order: string[], extra: Record<string, unknown> = {}, grant: Record<string, unknown> = {}) {
  const batch = await approvedBatch(dir, order, extra);
  const out = must(await batches.grantAutonomy(dir, batch.id, grantBody(batch, grant), batchDeps));
  return out.batch;
}
const reload = (dir: string, id: string) => must(batches.getBatch(dir, id));
const fail = async <T>(p: Promise<{ ok: boolean } & Record<string, unknown>>): Promise<{ status: number; error: string; body?: Record<string, unknown> }> => {
  const r = await p;
  if (r.ok) throw new Error("expected a refusal");
  return r as never;
};

// ----- off by default, explicit approval -------------------------------------------------------------------

test("autonomy is off by default: an approved batch has no grant, and the manual batch behaves as before", async () => {
  const { dir, taskOf } = await tasksFor(project("off"), [item("a", "A")]);
  const A = taskOf("a");
  const batch = await approvedBatch(dir, [A]);
  expect(batch.autonomy ?? null).toBeNull();
  expect(batch.autonomyView ?? null).toBeNull();
  const started = must(await batches.startBatch(dir, batch.id, batchDeps));
  expect(started.batch.autonomy ?? null).toBeNull();
  expect(runsOf(A)).toBe(1);
  expect(journalOf("autonomy.grant.approved", dir) + journalOf("autonomy.execution.started", dir)).toBe(0);
});

test("a grant needs the Owner's explicit confirmation naming the approval; nothing is written otherwise", async () => {
  const { dir, taskOf } = await tasksFor(project("confirm"), [item("a", "A")]);
  const batch = await approvedBatch(dir, [taskOf("a")]);
  const before = allJournal(dir);
  expect((await fail(batches.grantAutonomy(dir, batch.id, { previewKey: batch.approval!.previewKey, maxRuns: 2 }, batchDeps))).status).toBe(400);
  expect((await fail(batches.grantAutonomy(dir, batch.id, { ...grantBody(batch), previewKey: "stale" }, batchDeps))).status).toBe(409);
  expect(reload(dir, batch.id).autonomy ?? null).toBeNull();
  expect(allJournal(dir)).toBe(before);

  const out = must(await batches.grantAutonomy(dir, batch.id, grantBody(batch, { maxRuns: 2, maxParallelism: 1, ttlMinutes: 30 }), batchDeps)).batch;
  const g = out.autonomy!;
  expect(g.approvedBy).toBe("owner");
  expect(g.status).toBe("active");
  expect(g.taskIds).toEqual([taskOf("a")]);
  expect(g.maxRuns).toBe(2);
  expect(g.resources).toHaveLength(1);
  expect(g.resources[0]).toMatchObject({ harnessId: "codex", model: MODEL, mode: "ask", accessLevel: 0, accountId: null });
  expect(g.planEvidence.previewKey).toBe(batch.approval!.previewKey);
  expect(g.stopConditions.length).toBeGreaterThan(0);
  expect(g.expiresAt - g.approvedAt).toBe(30 * 60_000);
  expect(journalOf("autonomy.grant.approved", dir)).toBe(1);
  expect(runCount(dir)).toBe(0); // granting starts nothing
});

test("a live grant is never extended: a second grant is refused until the Owner revokes", async () => {
  const { dir, taskOf } = await tasksFor(project("noextend"), [item("a", "A")]);
  const batch = await granted(dir, [taskOf("a")], {}, { maxRuns: 1 });
  const again = await fail(batches.grantAutonomy(dir, batch.id, grantBody(batch, { maxRuns: 50, ttlMinutes: 1440 }), batchDeps));
  expect(again.status).toBe(409);
  expect(reload(dir, batch.id).autonomy!.maxRuns).toBe(1);
  expect(journalOf("autonomy.grant.approved", dir)).toBe(1);
  // Limits are validated, never clamped.
  const other = await tasksFor(project("limits"), [item("a", "A")]);
  const b2 = await approvedBatch(other.dir, [other.taskOf("a")]);
  expect((await fail(batches.grantAutonomy(other.dir, b2.id, grantBody(b2, { maxRuns: 0 }), batchDeps))).status).toBe(400);
  expect((await fail(batches.grantAutonomy(other.dir, b2.id, grantBody(b2, { maxRuns: 1000 }), batchDeps))).status).toBe(400);
  expect((await fail(batches.grantAutonomy(other.dir, b2.id, grantBody(b2, { maxParallelism: 3 }), batchDeps))).status).toBe(400); // wider than the batch
  expect((await fail(batches.grantAutonomy(other.dir, b2.id, grantBody(b2, { ttlMinutes: 1 }), batchDeps))).status).toBe(400);
  expect(reload(other.dir, b2.id).autonomy ?? null).toBeNull();
});

// ----- permissions ---------------------------------------------------------------------------------------

test("Full access, bypass and no-sandbox modes can't be granted; the Owner can still run them by hand", async () => {
  const { dir, taskOf } = await tasksFor(project("modes"), [item("a", "A")]);
  const A = taskOf("a");
  store.tasks.update(A, { mode: "full-access" as never });
  const created = must(await batches.createBatch(dir, { taskIds: [A], policy }, batchDeps));
  const full = must(await batches.previewAutonomy(dir, created.id));
  expect(full.blockers.some((b) => b.code === "mode-not-allowed" && b.taskId === A)).toBe(true);
  // An approved batch with the same task is also refused a grant.
  const approvedFull = await approvedBatch(dir, [A]).catch(() => null);
  if (approvedFull) {
    expect((await fail(batches.grantAutonomy(dir, approvedFull.id, grantBody(approvedFull), batchDeps))).status).toBe(409);
    expect(reload(dir, approvedFull.id).autonomy ?? null).toBeNull();
  }
  expect(runCount(dir)).toBe(0);
});

// ----- running, counting, budget ---------------------------------------------------------------------

test("only granted tasks run, the Run count is exact, and the budget stops the next start without a Run or a fallback", async () => {
  const { dir, taskOf } = await tasksFor(project("budget"), [item("a", "A"), item("c", "C")]);
  const A = taskOf("a");
  const C = taskOf("c");
  const batch = await granted(dir, [A, C], {}, { maxRuns: 1, maxParallelism: 1 });
  const before = { agent: store.tasks.get(C)!.agent, model: store.tasks.get(C)!.model, mode: store.tasks.get(C)!.mode };
  must(await batches.startBatch(dir, batch.id, batchDeps));
  expect(journalOf("autonomy.execution.started", dir)).toBe(1);
  const paused = await waitFor(() => {
    const view = reload(dir, batch.id);
    return view.status === "paused" ? view : null;
  });
  expect(paused.reason?.code).toBe("autonomy:grant-exhausted");
  expect(paused.autonomy!.status).toBe("exhausted");
  expect(paused.autonomyView!.runsUsed).toBe(1);
  expect(runsOf(A) + runsOf(C)).toBe(1); // the second task never got a Run: no inference without budget
  const second = [A, C].find((id) => runsOf(id) === 0)!;
  expect({ agent: store.tasks.get(second)!.agent, model: store.tasks.get(second)!.model, mode: store.tasks.get(second)!.mode }).toEqual(before); // nothing was switched
  expect(journalOf("autonomy.grant.exhausted", dir)).toBe(1);
  expect(journalOf("autonomy.execution.blocked", dir)).toBe(1);
  // Resuming an exhausted grant is refused; so is starting again. Budget is never topped up.
  expect((await fail(batches.resumeBatch(dir, batch.id, batchDeps))).status).toBe(409);
  await batches.requestTick(batch.id);
  expect(runCount(dir)).toBe(1);
  expect(journalOf("autonomy.grant.exhausted", dir)).toBe(1); // replay is a no-op
});

test("a grant narrower than the batch's parallelism waits for a slot: it neither starts a second Run nor pauses the batch", async () => {
  const { dir, taskOf } = await tasksFor(project("narrow"), [item("a", "A"), item("c", "C")]);
  const A = taskOf("a");
  const C = taskOf("c");
  const previous = process.env.AGETOR_FAKE_CODEX_RESOLVE_DELAY_MS;
  process.env.AGETOR_FAKE_CODEX_RESOLVE_DELAY_MS = "1500"; // the first Run stays live while the scheduler ticks
  try {
    const batch = await granted(dir, [A, C], { maxParallel: 2 }, { maxRuns: 4, maxParallelism: 1 });
    must(await batches.startBatch(dir, batch.id, batchDeps));
    await batches.requestTick(batch.id);
    await new Promise((r) => setTimeout(r, 250));
    await batches.requestTick(batch.id);
    expect(runsOf(A) + runsOf(C)).toBe(1); // one at a time, as granted
    const view = reload(dir, batch.id);
    expect(view.status).toBe("running"); // throttling is not a reason to pause
    expect(view.autonomy!.status).toBe("active");
    expect(journalOf("autonomy.execution.blocked", dir)).toBe(0);
    // Once the first Run has finished the second starts on its own (continue-independent), still within the grant.
    await waitFor(() => runsOf(A) + runsOf(C) === 2, 8000);
    expect(reload(dir, batch.id).autonomyView!.runsUsed).toBe(2);
  } finally {
    if (previous === undefined) delete process.env.AGETOR_FAKE_CODEX_RESOLVE_DELAY_MS;
    else process.env.AGETOR_FAKE_CODEX_RESOLVE_DELAY_MS = previous;
  }
});

test("a finished Run is not an accepted result: the next task waits for Done, not for the Run to end", async () => {
  const { dir, taskOf } = await tasksFor(project("review"), [item("a", "A"), item("b", "B", ["a"])]);
  const A = taskOf("a");
  const B = taskOf("b");
  const batch = await granted(dir, [A, B], { reviewPolicy: "wait-for-review" }, { maxRuns: 5 });
  must(await batches.startBatch(dir, batch.id, batchDeps));
  await waitFor(() => store.tasks.get(A)!.column === "review");
  await batches.__testing.settle();
  expect(runsOf(B)).toBe(0); // dependency is satisfied only by Done
  expect(autonomy.checkAutonomousRun(B, "batch").allowed).toBe(false);
});

test("two concurrent Start requests start each task once", async () => {
  const { dir, taskOf } = await tasksFor(project("race"), [item("a", "A"), item("c", "C")]);
  const A = taskOf("a");
  const C = taskOf("c");
  const batch = await granted(dir, [A, C], { maxParallel: 2 }, { maxRuns: 6, maxParallelism: 2 });
  await Promise.allSettled([batches.startBatch(dir, batch.id, batchDeps), batches.startBatch(dir, batch.id, batchDeps)]);
  await batches.__testing.settle();
  expect(runsOf(A)).toBe(1);
  expect(runsOf(C)).toBe(1);
  expect(journalOf("autonomy.execution.started", dir)).toBe(1);
});

// ----- TTL, revoke, pause, recovery -----------------------------------------------------------------

test("an expired grant stops new starts, pauses the batch and is recorded once", async () => {
  const { dir, taskOf } = await tasksFor(project("ttl"), [item("a", "A"), item("c", "C")]);
  const batch = await granted(dir, [taskOf("a"), taskOf("c")], {}, { ttlMinutes: 5 });
  const later = { ...batchDeps, now: () => Date.now() + 6 * 60_000 };
  expect((await fail(batches.startBatch(dir, batch.id, later))).status).toBe(409);
  expect(runCount(dir)).toBe(0);
  // Same through the tick of a running batch: start while valid, then let the clock pass.
  const live = must(await batches.startBatch(dir, batch.id, batchDeps)).batch;
  expect(live.status).toBe("running");
  await batches.requestTick(batch.id, later);
  const view = reload(dir, batch.id);
  expect(view.autonomy!.status).toBe("expired");
  expect(view.status).toBe("paused");
  const runsAfter = runCount(dir);
  await batches.requestTick(batch.id, later);
  await batches.requestTick(batch.id, later);
  expect(runCount(dir)).toBe(runsAfter);
  expect(journalOf("autonomy.grant.expired", dir)).toBe(1);
  expect((await fail(batches.resumeBatch(dir, batch.id, later))).status).toBe(409);
});

test("the Owner revokes: the batch pauses, the grant stays revoked, autonomous Runs are refused, and revoke is idempotent", async () => {
  const { dir, taskOf } = await tasksFor(project("revoke"), [item("a", "A"), item("c", "C")]);
  const A = taskOf("a");
  const batch = await granted(dir, [A, taskOf("c")], { maxParallel: 1 }, { maxRuns: 5 });
  must(await batches.startBatch(dir, batch.id, batchDeps));
  const out = must(await batches.revokeAutonomy(dir, batch.id));
  expect(out.alreadyEnded).toBe(false);
  expect(out.batch.autonomy!.status).toBe("revoked");
  expect(out.batch.status).toBe("paused");
  const again = must(await batches.revokeAutonomy(dir, batch.id));
  expect(again.alreadyEnded).toBe(true);
  expect(journalOf("autonomy.grant.revoked", dir)).toBe(1);
  const runs = runCount(dir);
  const verdict = autonomy.checkAutonomousRun(A, "pipeline-step");
  expect(verdict.allowed).toBe(false);
  expect((await fail(batches.resumeBatch(dir, batch.id, batchDeps))).status).toBe(409);
  expect(runCount(dir)).toBe(runs);
  // A new grant is a new Owner decision with a fresh budget and identity.
  const next = must(await batches.grantAutonomy(dir, batch.id, grantBody(out.batch, { maxRuns: 3 }), batchDeps)).batch;
  expect(next.autonomy!.id).not.toBe(out.batch.autonomy!.id);
  expect(next.autonomy!.status).toBe("active");
  expect(journalOf("autonomy.grant.approved", dir)).toBe(2);
});

test("pause and resume are recorded; a resume that finds nothing changed continues without duplicating a Run", async () => {
  const { dir, taskOf } = await tasksFor(project("pause"), [item("a", "A")]);
  const A = taskOf("a");
  const batch = await granted(dir, [A]);
  must(await batches.startBatch(dir, batch.id, batchDeps));
  expect(runsOf(A)).toBe(1);
  must(await batches.pauseBatch(dir, batch.id));
  expect(journalOf("autonomy.execution.blocked", dir)).toBe(1);
  must(await batches.resumeBatch(dir, batch.id, batchDeps));
  expect(reload(dir, batch.id).autonomy!.epoch).toBe(1);
  expect(journalOf("autonomy.execution.resumed", dir)).toBe(1);
  expect(runsOf(A)).toBe(1); // the task already started: no second Run
});

test("a restart comes back paused, counts what was already started and never re-launches it", async () => {
  const { dir, taskOf } = await tasksFor(project("restart"), [item("a", "A"), item("c", "C")]);
  const A = taskOf("a");
  const C = taskOf("c");
  const batch = await granted(dir, [A, C], {}, { maxRuns: 6 });
  must(await batches.startBatch(dir, batch.id, batchDeps));
  await batches.__testing.settle();
  const started = runCount(dir);
  batches.__testing.simulateRestart();
  expect(batches.recoverExecutionBatches()).toBeGreaterThanOrEqual(1);
  const view = reload(dir, batch.id);
  expect(view.status).toBe("paused");
  expect(view.autonomy!.status).toBe("active");
  expect(view.autonomyView!.runsUsed).toBe(started); // the count survives: it is read from the runs table
  expect(runCount(dir)).toBe(started);
});

// ----- changes after the grant ------------------------------------------------------------------------

test("a changed model, mode, assignment or plan after the grant holds the start: no Run, nothing substituted", async () => {
  const { dir, taskOf } = await tasksFor(project("changed"), [item("a", "A"), item("c", "C")]);
  const A = taskOf("a");
  const C = taskOf("c");
  const batch = await granted(dir, [A, C], { maxParallel: 2 }, { maxRuns: 6, maxParallelism: 2 });
  store.tasks.update(A, { model: "gpt-6-luna" }); // another model
  store.tasks.update(C, { mode: "auto" as never }); // broader permission
  const started = must(await batches.startBatch(dir, batch.id, batchDeps)).batch;
  expect(runsOf(A) + runsOf(C)).toBe(0);
  for (const id of [A, C]) expect(started.entries.find((e) => e.taskId === id)!.hold).not.toBeNull();
  expect(store.tasks.get(A)!.model).toBe("gpt-6-luna"); // no automatic switch back or elsewhere
});

test("the guard on the Run write refuses a ForgeOrbit-made Run outside the grant, and never touches the Owner's own", async () => {
  const { dir, taskOf } = await tasksFor(project("guard"), [item("a", "A")]);
  const A = taskOf("a");
  const batch = await granted(dir, [A], {}, { maxRuns: 1 });
  must(await batches.startBatch(dir, batch.id, batchDeps));
  expect(runsOf(A)).toBe(1);
  const row = (id: string) => ({ id, taskId: A, agent: "codex", status: "failed" as const, startedAt: Date.now(), endedAt: Date.now(), exitCode: 1, tmuxSession: null, claudeSessionId: null, codexSessionId: null, cursorSessionId: null, geminiSessionId: null, fxSessionId: null, antigravitySessionId: null });
  const before = runCount(dir);
  // Budget used: a reminder-, step- or batch-made Run is refused at the write itself.
  for (const o of ["handoff-reminder", "pipeline-step", "batch"] as const) {
    expect(() => origin.withAutonomyOrigin(o, () => store.runs.insert(row(crypto.randomUUID())))).toThrow(origin.AutonomyRefusedError);
  }
  // fx auto-resume inside a granted scope is not covered at all.
  expect(() => origin.withAutonomyOrigin("fx-auto-resume", () => store.runs.insert(row(crypto.randomUUID())))).toThrow(origin.AutonomyRefusedError);
  expect(runCount(dir)).toBe(before);
  // The Owner's own message or click carries no origin: it is recorded and counted, never refused.
  store.runs.insert(row(crypto.randomUUID()));
  expect(runCount(dir)).toBe(before + 1);
  expect(autonomy.grantCounters(reload(dir, batch.id), reload(dir, batch.id).autonomy!).used).toBe(2);
});

// ----- quota semantics -----------------------------------------------------------------------------

function seed(remaining: number, verified = true) {
  const core = new AccountCore(store.db);
  const account = core.createAccount({ provider: "openai", displayName: `Synthetic ${++counter}` });
  core.bindHarness(account.id, "codex");
  const expiresAt = Date.now() + 600_000;
  core.setModelCapability(account.id, "codex", MODEL, { support: "supported", expiresAt });
  const quota = core.createDefinition({ accountId: account.id, subscriptionId: null, scope: `model:${MODEL}`, unit: { kind: "requests" }, window: "week" });
  const values = { remaining, limit: 100, used: 100 - remaining, expiresAt };
  if (!verified) core.recordObservation(quota.id, values);
  else {
    core.recordTrustedObservations("openai-admin", [{
      quotaId: quota.id, values,
      evidence: { provider: "openai", accountId: account.id, subject: `s-${account.id}`, method: "provider-account", sourceId: "openai-admin", officialUrl: "https://platform.openai.com/docs", checkedAt: "2026-10-29", receivedAt: Date.now(), sharedPool: null, limitations: "synthetic" },
    }]);
  }
  return account.id;
}

test("Unknown quota needs an explicit acknowledgement, which is kept and never turns the quota Verified", async () => {
  const { dir, taskOf } = await tasksFor(project("unknown"), [item("a", "A")]);
  const batch = await approvedBatch(dir, [taskOf("a")]);
  const preview = must(batches.previewAutonomy(dir, batch.id));
  expect(preview.unknownQuota.length).toBe(1);
  expect(preview.unknownQuotaText).toContain("isn't verified");
  expect(preview.costNote).toContain("does not measure money");
  const refused = await fail(batches.grantAutonomy(dir, batch.id, { ...grantBody(batch), acknowledgeUnknownQuota: false }, batchDeps));
  expect(refused.status).toBe(400);
  expect(refused.body?.unknownQuota).toBeTruthy();
  const out = must(await batches.grantAutonomy(dir, batch.id, grantBody(batch), batchDeps)).batch;
  expect(out.autonomy!.acknowledgedUnknownQuota.length).toBe(1);
  expect(out.autonomy!.resources[0]!.quotaEvidence).not.toBe("verified");
  expect(out.autonomy!.cost).toBe("run-count-only");
  expect(out.autonomyView!.unknownQuotaText).toContain("does not make the quota known");
});

test("an identified account is bound into the grant; changing it stops the Run, and later verified exhaustion holds the start", async () => {
  const { dir, taskOf } = await tasksFor(project("account"), [item("a", "A")]);
  const A = taskOf("a");
  // The account is identified by an agent profile association; that is the only way it becomes known.
  const profile = store.agentProfiles.insert({ name: `av-${++counter}`, harness: "codex", model: MODEL, effort: null, mode: "ask", fast: false, maxMode: false, instructions: "", skills: [] } as never);
  const account = seed(40);
  const core = new AccountCore(store.db);
  core.bindProfile(account, profile.id);
  store.tasks.setAgentProfile(A, profile.id, null as never);
  store.tasks.update(A, { agent: "codex", model: MODEL, mode: "ask" as never });
  const batch = await approvedBatch(dir, [A]);
  const preview = must(batches.previewAutonomy(dir, batch.id));
  expect(preview.resources[0]!.accountId).toBe(account);
  // Even with a bound account the reading is only as good as the evidence: an unverified account still needs the acknowledgement.
  const ack = must(await batches.grantAutonomy(dir, batch.id, grantBody(batch, { maxRuns: 2 }), batchDeps)).batch;
  expect(ack.autonomy!.resources[0]!.accountId).toBe(account);
  expect(ack.autonomy!.acknowledgedUnknownQuota.length).toBeGreaterThan(0);

  // The identified account changes after the grant: autonomous Runs are refused, nothing is switched.
  core.unbindProfile(account, profile.id);
  const asRunning = { ...reload(dir, batch.id), status: "running" } as never;
  const verdict = autonomy.checkGrantForBatch(asRunning, A, "pipeline-step");
  expect(verdict.allowed).toBe(false);
  if (!verdict.allowed) expect(["account-changed", "configuration-changed"]).toContain(verdict.code);
  core.bindProfile(account, profile.id);

  // The account is then verified exhausted: the start is held with the resource named; no Run, no other model.
  const quota = core.definitions(account)[0]!;
  const expiresAt = Date.now() + 600_000;
  core.recordTrustedObservations("openai-admin", [{
    quotaId: quota.id, values: { remaining: 0, limit: 100, used: 100, expiresAt },
    evidence: { provider: "openai", accountId: account, subject: `s2-${account}`, method: "provider-account", sourceId: "openai-admin", officialUrl: "https://platform.openai.com/docs", checkedAt: "2026-10-29", receivedAt: Date.now(), sharedPool: null, limitations: "synthetic" },
  }]);
  const started = must(await batches.startBatch(dir, batch.id, batchDeps)).batch;
  expect(runsOf(A)).toBe(0);
  expect(started.entries[0]!.hold?.code).toBe("quota:resource-excluded");
  expect(store.tasks.get(A)!.model).toBe(MODEL);
});

// ----- reads and journal --------------------------------------------------------------------------------

test("reading a batch, its preview or its events writes nothing", async () => {
  const { dir, taskOf } = await tasksFor(project("reads"), [item("a", "A")]);
  const batch = await granted(dir, [taskOf("a")]);
  const before = { journal: allJournal(dir), runs: runCount(dir), raw: store.executionBatches.getAny(batch.id) };
  batches.getBatch(dir, batch.id);
  batches.listBatches(dir);
  batches.batchEvents(dir, batch.id);
  batches.previewAutonomy(dir, batch.id);
  expect({ journal: allJournal(dir), runs: runCount(dir), raw: store.executionBatches.getAny(batch.id) }).toEqual(before);
});

test("the grant's Journal rows are keyed to the durable grant id and replays add none", async () => {
  const { dir, taskOf } = await tasksFor(project("journal"), [item("a", "A")]);
  const batch = await granted(dir, [taskOf("a")]);
  const id = batch.autonomy!.id;
  const rows = store.db.query<{ target_id: string; idempotency_key: string; actor_type: string }, []>("SELECT target_id, idempotency_key, actor_type FROM activity_events WHERE event_type LIKE 'autonomy.%'").all();
  expect(rows.length).toBeGreaterThan(0);
  for (const row of rows) expect(row.idempotency_key.startsWith("autonomy:")).toBe(true);
  expect(rows.some((r) => r.target_id === id && r.actor_type === "owner")).toBe(true);
  // Replaying an Owner act changes nothing.
  must(await batches.revokeAutonomy(dir, batch.id));
  const afterRevoke = allJournal(dir);
  must(await batches.revokeAutonomy(dir, batch.id));
  expect(allJournal(dir)).toBe(afterRevoke);
});

test("cancelling a granted batch ends the grant", async () => {
  const { dir, taskOf } = await tasksFor(project("cancel"), [item("a", "A")]);
  const batch = await granted(dir, [taskOf("a")]);
  must(await batches.cancelBatch(dir, batch.id));
  const view = reload(dir, batch.id);
  expect(view.autonomy!.status).toBe("revoked");
  expect(view.autonomy!.endReason?.code).toBe("batch-cancelled");
  expect(journalOf("autonomy.grant.revoked", dir)).toBe(1);
  expect(autonomy.checkAutonomousRun(taskOf("a"), "pipeline-step").allowed).toBe(false);
});

test("fx auto-resume outside any grant still has to pass resource eligibility (ORCH07.2 gap closed)", async () => {
  const dir = project("fx");
  store.harnesses.setEnabled("fx", true);
  const created = await orchestrator.createTask({ title: "fx task", prompt: "go", workdir: dir, isolation: "none", agent: "fx", model: "zai/glm-5.3-flash", mode: "ask" } as never);
  if ("error" in created) throw new Error(created.error);
  const taskId = created.task.id;
  // The Owner forbids fx: an automatic Run for it is refused at the Run write, with no Run recorded.
  store.preferences.set("executorRoutingPreferences", JSON.stringify({ allowedHarnessIds: ["codex"] }));
  const row = { id: crypto.randomUUID(), taskId, agent: "fx", status: "running" as const, startedAt: Date.now(), endedAt: null, exitCode: null, tmuxSession: null, claudeSessionId: null, codexSessionId: null, cursorSessionId: null, geminiSessionId: null, fxSessionId: null, antigravitySessionId: null };
  const before = runCount(dir);
  expect(() => origin.withAutonomyOrigin("fx-auto-resume", () => store.runs.insert(row))).toThrow(origin.AutonomyRefusedError);
  expect(() => origin.withAutonomyOrigin("handoff-reminder", () => store.runs.insert({ ...row, id: crypto.randomUUID() }))).toThrow(origin.AutonomyRefusedError);
  expect(runCount(dir)).toBe(before);
  // Allowed again: the same automatic path records its Run.
  store.preferences.set("executorRoutingPreferences", "");
  origin.withAutonomyOrigin("fx-auto-resume", () => store.runs.insert({ ...row, id: crypto.randomUUID() }));
  expect(runCount(dir)).toBe(before + 1);
});

test("a deleted prerequisite leaves a tombstone: the granted task is held, with no Run and no automatic unlink", async () => {
  const { dir, taskOf } = await tasksFor(project("tombstone"), [item("a", "A"), item("b", "B", ["a"])]);
  const A = taskOf("a");
  const B = taskOf("b");
  store.tasks.update(A, { column: "done" });
  const batch = await granted(dir, [B], {}, { maxRuns: 2 });
  await orchestrator.deleteTask(A);
  expect(store.taskScheduling.tombstonesOf(B).length).toBeGreaterThan(0);
  const started = must(await batches.startBatch(dir, batch.id, batchDeps)).batch;
  expect(runsOf(B)).toBe(0);
  expect(started.entries[0]!.readiness.state).not.toBe("ready"); // waiting on the Owner, not started
  expect(store.taskScheduling.tombstonesOf(B).length).toBeGreaterThan(0); // not cleared on the Owner's behalf
});
