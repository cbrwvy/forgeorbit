import { afterAll, afterEach, beforeAll, beforeEach, expect, test } from "bun:test";
import { mkdtempSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";

/**
 * FO-ORCH07.2 pipeline and Approve & Execute resource eligibility. Fake claude
 * driver behind a /bin/echo stub, a disposable SQLite and synthetic AccountCore
 * records: no real AI CLI runs and no provider is reached. A hidden step row is
 * checked against the SAME contract batches and Employee Execution use.
 */
const isolated = realpathSync(mkdtempSync(path.join(tmpdir(), "foorch072-")));
process.env.AGETOR_DATA_DIR = isolated;
process.env.FORGEORBIT_DATA_DIR = isolated;
process.env.HOME = isolated;
process.env.AGETOR_USAGE_OFFLINE = "1";
process.env.AGETOR_CLAUDE_DRIVER = "fake";
process.env.AGETOR_CLAUDE_BIN = "/bin/echo";
process.env.AGETOR_CLAUDE_ARGS = "";
process.env.AGETOR_TMUX_BIN = "/bin/echo";
for (const kind of ["CODEX", "CURSOR", "GEMINI", "FX", "ANTIGRAVITY"]) process.env["AGETOR_" + kind + "_BIN"] = "/nonexistent/foorch072";

let store: typeof import("./db.ts");
let orchestrator: typeof import("./orchestrator.ts");
let runner: typeof import("./pipeline-runner.ts");
let execution: typeof import("./project-execution.ts");
let eligibility: typeof import("./resource-eligibility.ts");
let employee: typeof import("./employee-execution.ts");
let prefsModule: typeof import("./executor-preferences.ts");
let AccountCore: typeof import("./account-core.ts").AccountCore;
let newStep: typeof import("../shared/pipeline.ts").newStep;
let MARK: string;
let counter = 0;

beforeAll(async () => {
  store = await import("./db.ts");
  orchestrator = await import("./orchestrator.ts");
  runner = await import("./pipeline-runner.ts");
  execution = await import("./project-execution.ts");
  eligibility = await import("./resource-eligibility.ts");
  employee = await import("./employee-execution.ts");
  prefsModule = await import("./executor-preferences.ts");
  ({ AccountCore } = await import("./account-core.ts"));
  ({ newStep } = await import("../shared/pipeline.ts"));
  ({ FAKE_CLAUDE_HANDOFF_PROMPT_MARKER: MARK } = await import("./agents.ts"));
  runner.initPipelineRunner();
  store.harnesses.setEnabled("claude-code", true);
});

let live: string[] = [];
afterEach(async () => {
  for (const id of live) if (store.tasks.get(id)) await orchestrator.deleteTask(id).catch(() => {});
  live = [];
  delete process.env.AGETOR_FAKE_CLAUDE_RESOLVE_DELAY_MS;
});
afterAll(() => new Promise((r) => setTimeout(r, 100)));

/** Retire every synthetic account (append-only evidence stays) so one test can't leak into the next. */
beforeEach(() => {
  prefsModule.saveExecutorPreferences({});
  const core = new AccountCore(store.db);
  for (const account of core.listAccounts(true)) {
    for (const binding of core.bindings(account.id)) core.unbindHarness(account.id, binding.harnessId);
    for (const association of core.associations(account.id)) core.unbindProfile(account.id, association.profileId);
    for (const definition of core.definitions(account.id)) core.archiveDefinition(definition.id);
    if (account.archivedAt === null) core.archiveAccount(account.id);
  }
});

async function waitFor<T>(fn: () => T | null | undefined | false, timeoutMs = 6000): Promise<T> {
  const start = Date.now();
  for (;;) {
    const v = fn();
    if (v) return v as T;
    if (Date.now() - start > timeoutMs) throw new Error(`waitFor timed out after ${timeoutMs}ms`);
    await new Promise((r) => setTimeout(r, 15));
  }
}

function project(): string {
  const dir = realpathSync(mkdtempSync(path.join(isolated, "proj-")));
  store.projects.upsert(dir, `P${++counter}`);
  return dir;
}

function profile(model: string) {
  return store.agentProfiles.insert({ name: `pq-${model}-${randomUUID()}`, harness: "claude-code", model, effort: null, mode: null, fast: false, maxMode: false, instructions: "", skills: [] });
}

interface Seeded { core: InstanceType<typeof AccountCore>; accountId: string; quotaId: string }
/** A synthetic Anthropic account bound to claude-code with a model-scoped quota reading. */
function seed(model: string, opts: { remaining: number | null; verified?: boolean; scope?: string; name?: string; expiresInMs?: number; profileId?: string }): Seeded {
  const core = new AccountCore(store.db);
  const account = core.createAccount({ provider: "anthropic", displayName: opts.name ?? `Synthetic ${++counter}` });
  core.bindHarness(account.id, "claude-code");
  if (opts.profileId) core.bindProfile(account.id, opts.profileId);
  const expiresAt = Date.now() + (opts.expiresInMs ?? 600_000);
  core.setModelCapability(account.id, "claude-code", model, { support: "supported", expiresAt });
  const quota = core.createDefinition({ accountId: account.id, subscriptionId: null, scope: opts.scope ?? `model:${model}`, unit: { kind: "requests" }, window: "week" });
  const values = opts.remaining === null ? { limit: 100, used: 10, expiresAt } : { remaining: opts.remaining, limit: 100, used: 100 - opts.remaining, expiresAt };
  if (opts.verified === false) core.recordObservation(quota.id, values);
  else {
    core.recordTrustedObservations("anthropic-admin", [{
      quotaId: quota.id, values,
      evidence: {
        provider: "anthropic", accountId: account.id, subject: `synthetic-${account.id}`, method: "provider-account", sourceId: "anthropic-admin",
        officialUrl: "https://platform.claude.com/docs/en/manage-claude/usage-cost-api", checkedAt: "2026-10-29", receivedAt: Date.now(), sharedPool: null, limitations: "synthetic acceptance evidence",
      },
    }]);
  }
  return { core, accountId: account.id, quotaId: quota.id };
}

const counts = () => {
  const n = (sql: string) => store.db.query<{ n: number }, []>(sql).get()!.n;
  return { runs: n("SELECT COUNT(*) AS n FROM runs"), executions: n("SELECT COUNT(*) AS n FROM employee_executions"), accounts: n("SELECT COUNT(*) AS n FROM resource_accounts"), observations: n("SELECT COUNT(*) AS n FROM quota_observations") };
};

/** A linear pipeline whose steps run the given profiles, each ending its turn with a plain handoff. */
async function pipelineOf(dir: string, profiles: { id: string }[], instructions = `${MARK}:done`) {
  const steps = profiles.map((p, i) => newStep({ name: `S${i + 1}`, agentProfileId: p.id, instructions: `Do S${i + 1}. ${instructions}` }));
  const edges = steps.slice(1).map((s, i) => ({ id: `e${i}`, from: steps[i]!.id, to: s.id, label: "" }));
  const pipeline = store.pipelines.insert({ name: `pq-${randomUUID()}`, graph: { steps, edges, startStepId: steps[0]!.id }, maxSteps: 25 });
  const created = await orchestrator.createTask({ title: "pq run", prompt: "goal", workdir: dir, isolation: "none", pipelineId: pipeline.id });
  if ("error" in created) throw new Error(created.error);
  live.push(created.task.id);
  return { parentId: created.task.id, steps };
}

const parentOf = (id: string) => store.tasks.get(id)!;
const stepTask = (parentId: string, stepId: string) => store.tasks.stepsForParent(parentId).find((s) => s.pipelineStepId === stepId);
const runsOfStep = (parentId: string, stepId: string) => { const t = stepTask(parentId, stepId); return t ? store.runs.listForTask(t.id).length : 0; };
const done = (id: string) => store.tasks.get(id)?.pipelineRun?.status === "done";
const blockedRun = (id: string) => store.tasks.get(id)?.pipelineRun?.status === "blocked";
/** Starting a pipeline whose very first step is held answers with an error; the run is then blocked, which the tests read. */
async function start(id: string) {
  const out = await orchestrator.startTask(id);
  if ("error" in out && !out.error.startsWith("pipeline failed to start")) throw new Error(out.error);
}

// ----- blocking at a step -------------------------------------------------------------------------

test("two executors: the first step runs, the second is verified exhausted and is held with no Run", async () => {
  const dir = project();
  const p1 = profile("sonnet-5.5");
  const p2 = profile("opus-5.5");
  seed("opus-5.5", { remaining: 0, name: "Opus Pro" });
  const { parentId, steps } = await pipelineOf(dir, [p1, p2]);
  const runsBefore = counts().runs;
  const accountsBefore = counts().accounts;
  await start(parentId);
  await waitFor(() => blockedRun(parentId));
  const run = parentOf(parentId).pipelineRun!;
  expect(runsOfStep(parentId, steps[0]!.id)).toBe(1);
  expect(run.history.find((h) => h.stepId === steps[0]!.id)?.outcome).toBe("succeeded");
  expect(runsOfStep(parentId, steps[1]!.id)).toBe(0);
  const block = run.blocked.find((b) => b.stepId === steps[1]!.id)!;
  expect(block.kind).toBe("step-failed");
  expect(block.message).toContain("held");
  expect(block.message).toContain("opus-5.5");
  expect(block.message).toContain("Opus Pro");
  expect(block.message).toContain("no other account or model was tried");
  // Nothing else was created or changed: one Run in total, same accounts, same observations, same agent/model on the step.
  expect(counts().runs - runsBefore).toBe(1);
  expect(counts().accounts).toBe(accountsBefore);
  const held = stepTask(parentId, steps[1]!.id)!;
  expect([held.agent, held.model]).toEqual(["claude-code", "opus-5.5"]);
  expect(held.column).not.toBe("running");
});

test("the first step is checked too, and another model's exhaustion is not applied", async () => {
  const dir = project();
  const opus = profile("opus-5.5");
  const sonnet = profile("sonnet-5.5");
  seed("opus-5.5", { remaining: 0 });
  const blocked = await pipelineOf(dir, [opus, sonnet]);
  await start(blocked.parentId);
  await waitFor(() => blockedRun(blocked.parentId));
  expect(runsOfStep(blocked.parentId, blocked.steps[0]!.id)).toBe(0);
  expect(stepTask(blocked.parentId, blocked.steps[1]!.id)).toBeUndefined(); // the next step was never reached

  // A pipeline that only uses the other model is untouched by the exhausted one.
  const other = await pipelineOf(dir, [sonnet, sonnet]);
  await start(other.parentId);
  await waitFor(() => done(other.parentId));
  expect(runsOfStep(other.parentId, other.steps[0]!.id)).toBe(1);
});

test("quota changed between steps: the quota is read again for the later step, not carried over", async () => {
  process.env.AGETOR_FAKE_CLAUDE_RESOLVE_DELAY_MS = "400";
  const dir = project();
  const p = profile("opus-5.5");
  const { parentId, steps } = await pipelineOf(dir, [p, p]);
  await start(parentId);
  await waitFor(() => { const t = stepTask(parentId, steps[0]!.id); return t && store.runs.listForTask(t.id).length === 1; });
  seed("opus-5.5", { remaining: 0, name: "Drained mid-run" }); // S1 is already running; this lands before S2
  await waitFor(() => blockedRun(parentId), 8000);
  const run = parentOf(parentId).pipelineRun!;
  expect(run.history.find((h) => h.stepId === steps[0]!.id)?.outcome).toBe("succeeded"); // finished work is untouched
  expect(runsOfStep(parentId, steps[1]!.id)).toBe(0);
  expect(run.blocked.find((b) => b.stepId === steps[1]!.id)?.message).toContain("Drained mid-run");
});

test("different accounts: only the account the step's profile names decides", async () => {
  const dir = project();
  const px = profile("opus-5.5");
  const py = profile("opus-5.5");
  seed("opus-5.5", { remaining: 0, name: "Account X", profileId: px.id });
  seed("opus-5.5", { remaining: 40, name: "Account Y", profileId: py.id });
  const bad = await pipelineOf(dir, [px]);
  await start(bad.parentId);
  await waitFor(() => blockedRun(bad.parentId));
  expect(runsOfStep(bad.parentId, bad.steps[0]!.id)).toBe(0);
  expect(parentOf(bad.parentId).pipelineRun!.blocked[0]!.message).toContain("Account X");

  const good = await pipelineOf(dir, [py, py]);
  await start(good.parentId);
  await waitFor(() => done(good.parentId));
});

test("model and bucket mismatch: another bucket's exhaustion does not block the step", async () => {
  const dir = project();
  const p = profile("opus-5.5");
  seed("opus-5.5", { remaining: 0, scope: "model:some-other-model" });
  const { parentId } = await pipelineOf(dir, [p]);
  await start(parentId);
  await waitFor(() => done(parentId));
});

test("Unknown, unverified and percent-only evidence stay Unknown and do not block", async () => {
  const dir = project();
  const p = profile("opus-5.5");
  const none = await pipelineOf(dir, [p]);
  await start(none.parentId);
  await waitFor(() => done(none.parentId));
  seed("opus-5.5", { remaining: 0, verified: false });
  const manual = await pipelineOf(dir, [p]);
  await start(manual.parentId);
  await waitFor(() => done(manual.parentId));
  seed("sonnet-5.5", { remaining: null });
  const q = profile("sonnet-5.5");
  const pct = await pipelineOf(dir, [q]);
  await start(pct.parentId);
  await waitFor(() => done(pct.parentId));
  const task = store.tasks.get(none.parentId)!;
  const verdict = eligibility.evaluateResourceEligibility({ task, projectPath: dir, harness: store.harnesses.getByIdOrKind("claude-code")!, model: "sonnet-5.5", profileId: null });
  expect(verdict.blocked).toBe(false);
  expect(verdict.evidence).not.toBe("verified");
});

test("an Owner prohibition holds the step", async () => {
  const dir = project();
  const p = profile("opus-5.5");
  prefsModule.saveExecutorPreferences({ forbiddenModels: ["opus-5.5"] });
  const { parentId, steps } = await pipelineOf(dir, [p]);
  await start(parentId);
  await waitFor(() => blockedRun(parentId));
  expect(runsOfStep(parentId, steps[0]!.id)).toBe(0);
  expect(parentOf(parentId).pipelineRun!.blocked[0]!.message).toContain("forbid");
});

// ----- holds, retry, recovery -----------------------------------------------------------------------

test("retry and restart recovery re-check: still exhausted stays held, cleared evidence runs the step exactly once, no fallback", async () => {
  const dir = project();
  const p = profile("opus-5.5");
  const seeded = seed("opus-5.5", { remaining: 0 });
  const { parentId, steps } = await pipelineOf(dir, [p, p]);
  const accounts = counts().accounts;
  await start(parentId);
  await waitFor(() => blockedRun(parentId));
  await new Promise((r) => setTimeout(r, 300)); // nothing retries or falls back on its own
  expect(runsOfStep(parentId, steps[0]!.id)).toBe(0);

  const stepId = stepTask(parentId, steps[0]!.id)!.id;
  await runner.retryPipelineStep(parentId, { taskId: stepId }); // still exhausted: held again
  await runner.reconcilePipelineRuns(); // what boot does after a restart
  expect(blockedRun(parentId)).toBe(true);
  expect(runsOfStep(parentId, steps[0]!.id)).toBe(0);
  expect(counts().accounts).toBe(accounts); // no account was created, switched or changed

  seeded.core.archiveDefinition(seeded.quotaId); // the exhaustion evidence is gone
  const ok = await runner.retryPipelineStep(parentId, { taskId: stepId });
  expect("error" in ok).toBe(false);
  await waitFor(() => done(parentId));
  expect(runsOfStep(parentId, steps[0]!.id)).toBe(1); // exactly one Run for the step, however often it was retried while held
  expect(runsOfStep(parentId, steps[1]!.id)).toBe(1);
});

test("a handoff reminder is a Run the runner chooses to make, so it is checked too", async () => {
  process.env.AGETOR_FAKE_CLAUDE_RESOLVE_DELAY_MS = "400";
  const dir = project();
  const p = profile("opus-5.5");
  const { parentId, steps } = await pipelineOf(dir, [p], `${MARK}:missing-then-done`);
  await start(parentId);
  await waitFor(() => { const t = stepTask(parentId, steps[0]!.id); return t && store.runs.listForTask(t.id).length === 1; });
  seed("opus-5.5", { remaining: 0, name: "Drained before reminder" });
  await waitFor(() => blockedRun(parentId), 8000);
  const run = parentOf(parentId).pipelineRun!;
  const record = run.history.find((h) => h.stepId === steps[0]!.id)!;
  expect(record.reminder ?? null).toBeNull(); // no reminder was delivered
  expect(run.blocked[0]!.message).toContain("Drained before reminder");
});

// ----- direct Approve & Execute and the shared contract ------------------------------------------

async function newBoardTask(dir: string, model = "opus-5.5") {
  const created = await orchestrator.createTask({ title: "single run", prompt: "Do it.\n\n## Acceptance criteria\n- ok", workdir: dir, column: "backlog", agent: "claude-code", model, isolation: "none" } as never);
  if ("error" in created) throw new Error(created.error);
  live.push(created.task.id);
  return created.task.id;
}

test("direct Approve & Execute refuses a verified exhausted resource and starts nothing; Unknown stays the Owner's call", async () => {
  const dir = project();
  const unknownTask = await newBoardTask(dir);
  const prepared0 = await execution.prepareExecution(dir, { taskId: unknownTask });
  if (!prepared0.ok) throw new Error(prepared0.error);
  const ok = await execution.approveExecution(dir, prepared0.value.execution.id, { revision: prepared0.value.execution.revision });
  expect(ok.ok).toBe(true); // no evidence: the existing contract lets the Owner proceed

  seed("opus-5.5", { remaining: 0, name: "Single run account" });
  const taskId = await newBoardTask(dir);
  const prepared = await execution.prepareExecution(dir, { taskId });
  if (!prepared.ok) throw new Error(prepared.error);
  const before = counts();
  const refused = await execution.approveExecution(dir, prepared.value.execution.id, { revision: prepared.value.execution.revision });
  expect(refused.ok).toBe(false);
  if (!refused.ok) {
    expect(refused.status).toBe(409);
    expect(refused.error).toContain("Single run account");
    expect(refused.error).toContain("no other account or model was tried");
  }
  expect(store.runs.listForTask(taskId)).toHaveLength(0);
  expect(counts()).toEqual(before);
  expect(store.tasks.get(taskId)!.model).toBe("opus-5.5"); // no substitution
});

test("batches, pipeline steps, Approve & Execute and Employee preflight all reach the same verdict for the same resource", async () => {
  const dir = project();
  const p = profile("opus-5.5");
  seed("opus-5.5", { remaining: 0, name: "Shared contract" });
  const task = store.tasks.get(await newBoardTask(dir))!;
  const config = execution.normalizeConfig(execution.configFromTask(task));
  const shared = eligibility.configEligibility({ task, projectPath: dir, config })!;
  expect(shared.blocked).toBe(true);
  expect(shared.code).toBe("resource-excluded");

  const { parentId, steps } = await pipelineOf(dir, [p]);
  await start(parentId);
  await waitFor(() => blockedRun(parentId));
  const stepMessage = parentOf(parentId).pipelineRun!.blocked.find((b) => b.stepId === steps[0]!.id)!.message;
  expect(stepMessage).toContain(shared.reasons[0]!);

  const pre = employee.prepareEmployeeExecution({ taskId: task.id, expectedAssignmentRevision: null, harnessId: "claude-code", model: "opus-5.5" });
  expect(pre.blockingErrors.map((e) => e.code)).toContain("resource-excluded");
  expect(pre.blockingErrors.map((e) => e.message).join(" ")).toContain(shared.reasons[0]!);
});
