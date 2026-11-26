import { afterAll, beforeAll, beforeEach, expect, test } from "bun:test";
import { mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { PlanView } from "../shared/task-plan.ts";
import type { QueueView } from "../shared/task-queue.ts";
import type { BatchView } from "../shared/task-scheduling.ts";
import { parseProposal, type ProposalItem, type TaskProposal } from "../shared/project-manager.ts";

/**
 * FO-ORCH07.1 AccountCore quota enforcement for Execution Batches. Fake codex driver behind a /bin/echo stub, a
 * disposable SQLite and temp project folders: no real AI CLI runs and no
 * provider is reached. The plan routes are read-only, so most tests also
 * assert that nothing was written (runs, assignments, journal, tasks).
 */
const isolated = realpathSync(mkdtempSync(path.join(tmpdir(), "foorch071-")));
process.env.AGETOR_DATA_DIR = isolated;
process.env.FORGEORBIT_DATA_DIR = isolated;
process.env.CODEX_HOME = path.join(isolated, ".codex");
process.env.HOME = isolated;
process.env.AGETOR_API_PORT = "4749";
process.env.AGETOR_USAGE_OFFLINE = "1";
process.env.AGETOR_CODEX_DRIVER = "fake";
process.env.AGETOR_CODEX_BIN = "/bin/echo";
process.env.AGETOR_TMUX_BIN = "/bin/echo";
for (const kind of ["CLAUDE", "CURSOR", "GEMINI", "FX", "ANTIGRAVITY"]) process.env["AGETOR_" + kind + "_BIN"] = "/nonexistent/foorch071";

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
const base = "http://127.0.0.1:4749";
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


// ----- helpers (ORCH07.1) --------------------------------------------------------------------------

const policy = { noOverageHarnessIds: ["codex"] };
const MODEL = "gpt-6.1-sol";
const rawCounts = () => ({ ...counts() });

async function ready() {
  const s = await synthetic();
  for (const id of [s.A, s.B, s.C]) {
    assign(id, s.dir);
    store.tasks.update(id, { agent: "codex", model: MODEL, mode: "ask" as never });
  }
  return s;
}

function approveInput(batch: BatchView) {
  return { revision: batch.revision, previewKey: batch.preview!.key, acknowledgedHarnessIds: batch.preview!.spendingHarnessIds };
}

const runsOf = (taskId: string) => store.runs.listForTask(taskId).length;
const stateOf = (view: BatchView, taskId: string) => view.entries.find((e) => e.taskId === taskId)!;

interface Seeded { core: InstanceType<typeof AccountCore>; accountId: string; quotaId: string }

/** A synthetic account bound to codex with a verified, model-scoped quota reading. */
function seed(opts: { remaining: number | null; scope?: string; supported?: "supported" | "unsupported" | null; expiresInMs?: number; verified?: boolean; name?: string }): Seeded {
  const core = new AccountCore(store.db);
  const account = core.createAccount({ provider: "openai", displayName: opts.name ?? `Synthetic quota ${++counter}` });
  core.bindHarness(account.id, "codex");
  const expiresAt = Date.now() + (opts.expiresInMs ?? 600_000);
  if (opts.supported !== null) core.setModelCapability(account.id, "codex", MODEL, { support: opts.supported ?? "supported", expiresAt });
  const quota = core.createDefinition({ accountId: account.id, subscriptionId: null, scope: opts.scope ?? `model:${MODEL}`, unit: { kind: "requests" }, window: "week" });
  const values = opts.remaining === null ? { limit: 100, used: 10, expiresAt } : { remaining: opts.remaining, limit: 100, used: 100 - opts.remaining, expiresAt };
  if (opts.verified === false) core.recordObservation(quota.id, values);
  else {
    core.recordTrustedObservations("openai-admin", [{
      quotaId: quota.id, values,
      evidence: {
        provider: "openai", accountId: account.id, subject: `synthetic-${account.id}`, method: "provider-account", sourceId: "openai-admin",
        officialUrl: "https://platform.openai.com/docs", checkedAt: "2026-10-29", receivedAt: Date.now(), sharedPool: null, limitations: "synthetic acceptance evidence",
      },
    }]);
  }
  return { core, accountId: account.id, quotaId: quota.id };
}

/** Retire every synthetic account (append-only evidence stays) so one test can't leak into the next. */
beforeEach(() => {
  const core = new AccountCore(store.db);
  for (const account of core.listAccounts(true)) {
    for (const binding of core.bindings(account.id)) core.unbindHarness(account.id, binding.harnessId);
    for (const association of core.associations(account.id)) core.unbindProfile(account.id, association.profileId);
    for (const definition of core.definitions(account.id)) core.archiveDefinition(definition.id);
    if (account.archivedAt === null) core.archiveAccount(account.id);
  }
});

async function approvedBatch(s: Awaited<ReturnType<typeof ready>>, order: string[], extra: Record<string, unknown> = {}) {
  const created = must(await batches.createBatch(s.dir, { taskIds: order, policy: { ...policy, ...extra } }, batchDeps));
  const ok = must(await batches.approveBatch(s.dir, created.id, approveInput(created), batchDeps));
  return ok.batch;
}

const eligibility = (taskId: string, profileId: string | null = null, extra: { now?: number } = {}) => {
  const task = store.tasks.get(taskId)!;
  return exec_.evaluateResourceEligibility({ task, projectPath: task.workdir, harness: store.harnesses.getByIdOrKind("codex")!, model: MODEL, profileId, ...extra });
};

let exec_: typeof import("./employee-execution.ts");
beforeAll(async () => { exec_ = await import("./employee-execution.ts"); });

// ----- blocking -------------------------------------------------------------------------------------

test("verified exhausted quota blocks the batch start: no run, no inference, no fallback, the batch pauses and names the resource", async () => {
  const s = await ready();
  const seeded = seed({ remaining: 0, name: "Exhausted Pro" });
  const batch = await approvedBatch(s, [s.C, s.A]);
  expect(batch.preview!.issues.some((i) => i.code === "quota-blocked")).toBe(true); // an early warning, not the gate
  const before = { ...rawCounts(), tasks: JSON.stringify([s.A, s.C].map((id) => { const t = store.tasks.get(id)!; return [t.agent, t.model, t.mode, t.column]; })) };

  const started = must(await batches.startBatch(s.dir, batch.id, batchDeps));
  expect(runsOf(s.C) + runsOf(s.A)).toBe(0);
  const c = stateOf(started.batch, s.C);
  expect(c.hold?.code).toBe("quota:resource-excluded");
  expect(c.hold?.reason).toContain("Exhausted Pro");
  expect(c.hold?.reason).toContain(MODEL);
  expect(c.hold?.reason).toContain("no other account or model was tried");
  expect(started.batch.status).toBe("paused");
  expect(started.batch.reason?.code).toBe("held");
  const after = { ...rawCounts(), tasks: JSON.stringify([s.A, s.C].map((id) => { const t = store.tasks.get(id)!; return [t.agent, t.model, t.mode, t.column]; })) };
  expect(after).toEqual(before); // no run, no execution, no account/observation change, no model or harness switch
  expect(seeded.accountId).toBeTruthy();
});

test("denied: an Owner prohibition and an unavailable account block; an unverified 'unsupported' declaration does not", async () => {
  const s = await ready();
  // An unsupported-model flag nobody verified is still Unknown, never a denial.
  seed({ remaining: 50, supported: "unsupported" });
  expect(eligibility(s.C).blocked).toBe(false);

  // The Owner's own prohibition is a denial.
  const task = store.tasks.get(s.C)!;
  const codex = store.harnesses.getByIdOrKind("codex")!;
  const denied = exec_.evaluateResourceEligibility({ task, projectPath: task.workdir, harness: codex, model: MODEL, profileId: null, owner: (saved) => ({ ...saved, allowedHarnesses: ["claude-code"] }) });
  expect(denied.blocked).toBe(true);
  expect(denied.code).toBe("owner-policy");

  // So is an account the Owner marked unavailable (bound, with a reading for this model).
  const gone = seed({ remaining: 50, name: "Marked unavailable" });
  gone.core.updateAccount(gone.accountId, { availability: "unavailable" });
  const profile = store.agentProfiles.insert({ name: `pu-${++counter}`, harness: "codex", model: MODEL, effort: null, mode: "ask", fast: false, maxMode: false, instructions: "", skills: [] } as never);
  gone.core.bindProfile(gone.accountId, profile.id);
  const named = eligibility(s.C, profile.id);
  expect(named.blocked).toBe(true);
  expect(named.resource.accountName).toBe("Marked unavailable");
  // Without a profile the account is unknown, so another account's state is never applied.
  expect(eligibility(s.C, null).blocked).toBe(false);
});

test("verified remaining capacity is not blocked and starts under the existing contract", async () => {
  const s = await ready();
  seed({ remaining: 40 });
  const verdict = eligibility(s.C);
  expect(verdict.blocked).toBe(false);
  expect(verdict.evaluated).toBe(true);
  const batch = await approvedBatch(s, [s.C]);
  must(await batches.startBatch(s.dir, batch.id, batchDeps));
  expect(runsOf(s.C)).toBe(1);
});

test("Unknown stays Unknown: no evidence is neither blocked nor verified, and the existing Owner policy still starts it", async () => {
  const s = await ready();
  const verdict = eligibility(s.C);
  expect(verdict.blocked).toBe(false);
  expect(verdict.evidence).not.toBe("verified");
  const observations = rawCounts().observations;
  const batch = await approvedBatch(s, [s.C]);
  must(await batches.startBatch(s.dir, batch.id, batchDeps));
  expect(runsOf(s.C)).toBe(1);
  expect(rawCounts().observations).toBe(observations); // nothing invented
});

test("an unverified (manual or observed) zero reading is not exhaustion; percent-only is not exhaustion", async () => {
  const s = await ready();
  seed({ remaining: 0, verified: false });
  expect(eligibility(s.C).blocked).toBe(false);
  // A reading with no remaining count (percent / limit alone) never blocks either.
  const other = await ready();
  seed({ remaining: null });
  expect(eligibility(other.C).blocked).toBe(false);
  const batch = await approvedBatch(s, [s.C]);
  must(await batches.startBatch(s.dir, batch.id, batchDeps));
  expect(runsOf(s.C)).toBe(1);
});

test("stale evidence is not exhaustion", async () => {
  const s = await ready();
  seed({ remaining: 0, expiresInMs: 1000 });
  expect(eligibility(s.C).blocked).toBe(true); // current
  const later = eligibility(s.C, null, { now: Date.now() + 60_000 });
  expect(later.blocked).toBe(false); // the reading expired
  expect(later.evidence).not.toBe("verified");
});

test("account mismatch: only the identified account's exhaustion blocks, another account's never does", async () => {
  const s = await ready();
  const bad = seed({ remaining: 0, name: "Account X" });
  const good = seed({ remaining: 40, name: "Account Y" });
  const profileFor = (name: string) => store.agentProfiles.insert({ name, harness: "codex", model: MODEL, effort: null, mode: "ask", fast: false, maxMode: false, instructions: "", skills: [] } as never);
  const px = profileFor(`px-${++counter}`);
  const py = profileFor(`py-${++counter}`);
  bad.core.bindProfile(bad.accountId, px.id);
  good.core.bindProfile(good.accountId, py.id);
  // No profile: the account is unknown and one healthy candidate exists, so nothing is proven exhausted.
  expect(eligibility(s.C, null).blocked).toBe(false);
  // The profile that names the exhausted account is blocked, the one naming the healthy account is not.
  const x = eligibility(s.C, px.id);
  expect(x.blocked).toBe(true);
  expect(x.resource.accountName).toBe("Account X");
  expect(eligibility(s.C, py.id).blocked).toBe(false);
});

test("model and bucket mismatch: exhaustion of another model or an unproven scope is not applied", async () => {
  const s = await ready();
  seed({ remaining: 0, scope: "model:some-other-model" });
  expect(eligibility(s.C).blocked).toBe(false);
  const t = await ready();
  const core = new AccountCore(store.db);
  const account = core.createAccount({ provider: "openai", displayName: "Other model only" });
  core.bindHarness(account.id, "codex");
  core.setModelCapability(account.id, "codex", "some-other-model", { support: "supported", expiresAt: Date.now() + 600_000 });
  const quota = core.createDefinition({ accountId: account.id, subscriptionId: null, scope: "model:some-other-model", unit: { kind: "requests" }, window: "week" });
  core.recordTrustedObservations("openai-admin", [{ quotaId: quota.id, values: { remaining: 0, limit: 1, used: 1, expiresAt: Date.now() + 600_000 }, evidence: { provider: "openai", accountId: account.id, subject: "s", method: "provider-account", sourceId: "openai-admin", officialUrl: "https://platform.openai.com/docs", checkedAt: "2026-10-29", receivedAt: Date.now(), sharedPool: null, limitations: "synthetic" } }]);
  // Every candidate of the harness is exhausted, but none of them is the launch model.
  expect(eligibility(t.C).blocked).toBe(false);
});

// ----- timing: approval, between tasks, pause/resume, restart --------------------------------------

test("quota changed after approval: the start is held, and approving never overrode it", async () => {
  const s = await ready();
  const batch = await approvedBatch(s, [s.C]); // approved with no evidence at all
  seed({ remaining: 0 });
  const started = must(await batches.startBatch(s.dir, batch.id, batchDeps));
  expect(runsOf(s.C)).toBe(0);
  expect(stateOf(started.batch, s.C).hold?.code).toBe("quota:resource-excluded");
});

test("quota changed between two tasks of one batch: the first ran, the second is held", async () => {
  process.env.AGETOR_FAKE_CODEX_RESOLVE_DELAY_MS = "60000";
  try {
    const s = await ready();
    const batch = await approvedBatch(s, [s.C, s.A]);
    must(await batches.startBatch(s.dir, batch.id, batchDeps));
    expect(runsOf(s.C)).toBe(1);
    seed({ remaining: 0 });
    store.tasks.update(s.C, { column: "done" });
    await batches.requestTick(batch.id, batchDeps);
    const view = batches.getBatch(s.dir, batch.id);
    expect(view.ok).toBe(true);
    if (!view.ok) return;
    expect(runsOf(s.A)).toBe(0);
    expect(runsOf(s.C)).toBe(1); // the finished task is untouched
    expect(stateOf(view.value, s.A).hold?.code).toBe("quota:resource-excluded");
    expect(view.value.status).toBe("paused");
  } finally {
    delete process.env.AGETOR_FAKE_CODEX_RESOLVE_DELAY_MS;
  }
});

test("pause/resume: resuming while exhausted starts nothing; after the evidence is gone the Owner releases it and it is checked again", async () => {
  const s = await ready();
  const seeded = seed({ remaining: 0 });
  const batch = await approvedBatch(s, [s.C], { maxRetriesPerTask: 2 });
  must(await batches.startBatch(s.dir, batch.id, batchDeps));
  expect(runsOf(s.C)).toBe(0);
  for (let i = 0; i < 3; i++) must(await batches.resumeBatch(s.dir, batch.id, batchDeps));
  await batches.requestTick(batch.id, batchDeps);
  expect(runsOf(s.C)).toBe(0); // no retry, no duplicate run
  expect(stateOf(must(batches.getBatch(s.dir, batch.id)), s.C).hold).not.toBeNull();

  seeded.core.archiveDefinition(seeded.quotaId); // the exhaustion evidence is gone: Unknown again
  must(await batches.releaseBatchTask(s.dir, batch.id, s.C, batchDeps));
  must(await batches.resumeBatch(s.dir, batch.id, batchDeps));
  await batches.requestTick(batch.id, batchDeps);
  expect(runsOf(s.C)).toBe(1);
});

test("restart/recovery: the hold, the pause and the check all survive a restart", async () => {
  const s = await ready();
  seed({ remaining: 0 });
  const batch = await approvedBatch(s, [s.C]);
  must(await batches.startBatch(s.dir, batch.id, batchDeps));
  batches.__testing.simulateRestart();
  const view = must(batches.getBatch(s.dir, batch.id));
  expect(view.status).toBe("paused");
  expect(stateOf(view, s.C).hold?.code).toBe("quota:resource-excluded");
  must(await batches.releaseBatchTask(s.dir, batch.id, s.C, batchDeps));
  must(await batches.resumeBatch(s.dir, batch.id, batchDeps));
  await batches.requestTick(batch.id, batchDeps);
  expect(runsOf(s.C)).toBe(0); // checked again after the restart, still exhausted
});

// ----- no other road --------------------------------------------------------------------------------

test("no bypass: releasing, ticking and the queue handoff cannot start an exhausted resource, and Employee preflight agrees", async () => {
  const s = await ready();
  seed({ remaining: 0 });
  const saved = must(await queues.saveQueue(s.dir, s.proposal.id, { taskIds: [s.C, s.A], planKey: (await planOf(s.dir, s.proposal.id)).planKey }, deps));
  const out = must(await queues.prepareQueueBatch(s.dir, saved.queue.id, { revision: saved.queue.revision, planKey: (await planOf(s.dir, s.proposal.id)).planKey, policy }, { ...deps, ...batchDeps }));
  expect(out.batch.preview!.issues.some((i) => i.code === "quota-blocked")).toBe(true); // warned at handoff
  must(await batches.approveBatch(s.dir, out.batch.id, approveInput(out.batch), batchDeps));
  const started = must(await batches.startBatch(s.dir, out.batch.id, batchDeps));
  must(await batches.releaseBatchTask(s.dir, out.batch.id, s.C, batchDeps));
  await batches.requestTick(out.batch.id, batchDeps);
  expect(runsOf(s.C) + runsOf(s.A)).toBe(0);
  expect(started.batch.status).toBe("paused");
  // Employee Execution reaches the same verdict for the same resource.
  const pre = exec_.prepareEmployeeExecution({ taskId: s.C, expectedAssignmentRevision: null, harnessId: "codex", model: MODEL });
  expect(pre.outcome).toBe("blocked");
  expect(pre.blockingErrors.map((e) => e.code)).toContain("resource-excluded");
  expect(counts().executions).toBe(0);
});

test("compatibility: with no exhaustion Employee preflight is prepared and a queue handoff runs end to end as before", async () => {
  const s = await ready();
  seed({ remaining: 40 });
  const pre = exec_.prepareEmployeeExecution({ taskId: s.C, expectedAssignmentRevision: null, harnessId: "codex", model: MODEL });
  expect(pre.blockingErrors.map((e) => e.code)).not.toContain("resource-excluded");
  const saved = must(await queues.saveQueue(s.dir, s.proposal.id, { taskIds: [s.C], planKey: (await planOf(s.dir, s.proposal.id)).planKey }, deps));
  const out = must(await queues.prepareQueueBatch(s.dir, saved.queue.id, { revision: saved.queue.revision, planKey: (await planOf(s.dir, s.proposal.id)).planKey, policy }, { ...deps, ...batchDeps }));
  expect(out.batch.preview!.issues.some((i) => i.code === "quota-blocked")).toBe(false);
  must(await batches.approveBatch(s.dir, out.batch.id, approveInput(out.batch), batchDeps));
  must(await batches.startBatch(s.dir, out.batch.id, batchDeps));
  expect(runsOf(s.C)).toBe(1);
});
