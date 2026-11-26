import { afterAll, afterEach, beforeAll, expect, test } from "bun:test";
import { mkdtempSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";

/**
 * FO-ORCH08 pipeline accounting. A pipeline's hidden step tasks and a handoff
 * reminder are Runs ForgeOrbit chooses to make, so a bounded grant counts and
 * limits them. Fake claude driver behind a /bin/echo stub, disposable SQLite:
 * no real AI CLI runs and no provider is reached.
 */
const isolated = realpathSync(mkdtempSync(path.join(tmpdir(), "foorch08p-")));
process.env.AGETOR_DATA_DIR = isolated;
process.env.FORGEORBIT_DATA_DIR = isolated;
process.env.HOME = isolated;
process.env.AGETOR_USAGE_OFFLINE = "1";
process.env.AGETOR_CLAUDE_DRIVER = "fake";
process.env.AGETOR_CLAUDE_BIN = "/bin/echo";
process.env.AGETOR_CLAUDE_ARGS = "";
process.env.AGETOR_TMUX_BIN = "/bin/echo";
for (const kind of ["CODEX", "CURSOR", "GEMINI", "FX", "ANTIGRAVITY"]) process.env["AGETOR_" + kind + "_BIN"] = "/nonexistent/foorch08p";

let store: typeof import("./db.ts");
let orchestrator: typeof import("./orchestrator.ts");
let runner: typeof import("./pipeline-runner.ts");
let batches: typeof import("./execution-batches.ts");
let newStep: typeof import("../shared/pipeline.ts").newStep;
let MARK: string;
let counter = 0;
const batchDeps = { envNames: () => [] as string[] };

beforeAll(async () => {
  store = await import("./db.ts");
  orchestrator = await import("./orchestrator.ts");
  runner = await import("./pipeline-runner.ts");
  batches = await import("./execution-batches.ts");
  ({ newStep } = await import("../shared/pipeline.ts"));
  ({ FAKE_CLAUDE_HANDOFF_PROMPT_MARKER: MARK } = await import("./agents.ts"));
  runner.initPipelineRunner();
  batches.initExecutionBatches();
  store.harnesses.setEnabled("claude-code", true);
});
let live: string[] = [];
afterEach(async () => {
  for (const id of live) if (store.tasks.get(id)) await orchestrator.deleteTask(id).catch(() => {});
  live = [];
  delete process.env.AGETOR_FAKE_CLAUDE_RESOLVE_DELAY_MS;
});
afterAll(() => {
  batches.stopExecutionBatchTimers();
  return new Promise((r) => setTimeout(r, 100));
});

function must<T>(r: { ok: true; value: T } | { ok: false; error: string }): T {
  if (!r.ok) throw new Error(r.error);
  return r.value;
}
async function waitFor<T>(fn: () => T | null | undefined | false, timeoutMs = 8000): Promise<T> {
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
function profile() {
  return store.agentProfiles.insert({ name: `ap-${randomUUID()}`, harness: "claude-code", model: "opus-5.5", effort: null, mode: "acceptEdits", fast: false, maxMode: false, instructions: "", skills: [] });
}
const n = (sql: string) => store.db.query<{ n: number }, []>(sql).get()!.n;
const journalOf = (type: string, dir: string) => n(`SELECT COUNT(*) AS n FROM activity_events WHERE event_type = '${type}' AND project_path = '${dir}'`);

/** A granted batch whose single entry is a linear two-step pipeline. */
async function grantedPipeline(instructions: string, maxRuns: number, steps = 2) {
  const dir = project();
  const profiles = Array.from({ length: steps }, () => profile());
  const built = profiles.map((p, i) => newStep({ name: `S${i + 1}`, agentProfileId: p.id, instructions: `Do S${i + 1}. ${instructions}` }));
  const edges = built.slice(1).map((s, i) => ({ id: `e${i}`, from: built[i]!.id, to: s.id, label: "" }));
  const pipeline = store.pipelines.insert({ name: `ap-${randomUUID()}`, graph: { steps: built, edges, startStepId: built[0]!.id }, maxSteps: 25 });
  const created = await orchestrator.createTask({ title: "ap run", prompt: "goal", workdir: dir, isolation: "none", pipelineId: pipeline.id });
  if ("error" in created) throw new Error(created.error);
  live.push(created.task.id);
  const taskId = created.task.id;
  const draft = must(await batches.createBatch(dir, { taskIds: [taskId], policy: { noOverageHarnessIds: ["claude-code"], maxStarts: 4 } }, batchDeps));
  const approved = must(await batches.approveBatch(dir, draft.id, { revision: draft.revision, previewKey: draft.preview!.key, acknowledgedHarnessIds: draft.preview!.spendingHarnessIds }, batchDeps)).batch;
  const batch = must(await batches.grantAutonomy(dir, approved.id, { previewKey: approved.approval!.previewKey, confirm: true, acknowledgeUnknownQuota: true, maxRuns }, batchDeps)).batch;
  return { dir, taskId, batch, steps: built };
}
const stepTask = (parentId: string, stepId: string) => store.tasks.stepsForParent(parentId).find((s) => s.pipelineStepId === stepId);
const runsOfStep = (parentId: string, stepId: string) => { const t = stepTask(parentId, stepId); return t ? store.runs.listForTask(t.id).length : 0; };
const totalStepRuns = (parentId: string) => store.tasks.stepsForParent(parentId).reduce((sum, t) => sum + store.runs.listForTask(t.id).length, 0);

test("a grant lists one resource per pipeline step, and every step Run counts against the budget", async () => {
  const { dir, taskId, batch, steps } = await grantedPipeline(`${MARK}:done`, 2);
  expect(batch.autonomy!.resources.map((r) => r.stepName)).toEqual(["S1", "S2"]);
  must(await batches.startBatch(dir, batch.id, batchDeps));
  await waitFor(() => store.tasks.get(taskId)?.pipelineRun?.status === "done");
  expect(runsOfStep(taskId, steps[0]!.id)).toBe(1);
  expect(runsOfStep(taskId, steps[1]!.id)).toBe(1);
  const view = must(batches.getBatch(dir, batch.id));
  expect(view.autonomyView!.runsUsed).toBe(2);
  expect(view.autonomy!.status).toBe("active");
});

test("the budget ends mid-pipeline: the next step gets no Run, the batch pauses, the block names the grant", async () => {
  const { dir, taskId, batch, steps } = await grantedPipeline(`${MARK}:done`, 1);
  must(await batches.startBatch(dir, batch.id, batchDeps));
  await waitFor(() => store.tasks.get(taskId)?.pipelineRun?.status === "blocked");
  expect(runsOfStep(taskId, steps[0]!.id)).toBe(1);
  expect(runsOfStep(taskId, steps[1]!.id)).toBe(0); // no inference past the budget
  const run = store.tasks.get(taskId)!.pipelineRun!;
  expect(run.blocked.some((b) => b.message.includes("Autonomous execution"))).toBe(true);
  const view = await waitFor(() => { const v = must(batches.getBatch(dir, batch.id)); return v.status === "paused" ? v : null; });
  expect(view.autonomy!.status).toBe("exhausted");
  expect(view.reason?.code).toBe("autonomy:grant-exhausted");
  expect(journalOf("autonomy.grant.exhausted", dir)).toBe(1);
  // A Retry by hand doesn't bypass it: the grant is spent and only the Owner can grant again.
  const retried = await runner.retryPipelineStep(taskId);
  expect("error" in retried ? "refused" : "ran").toBeDefined();
  expect(runsOfStep(taskId, steps[1]!.id)).toBe(0);
  expect(totalStepRuns(taskId)).toBe(1);
});

test("a handoff reminder that would mint a Run is refused once the budget is used; it never extends the grant", async () => {
  process.env.AGETOR_FAKE_CLAUDE_RESOLVE_DELAY_MS = "200";
  const { dir, taskId, batch, steps } = await grantedPipeline(`${MARK}:missing-then-done`, 1, 1);
  must(await batches.startBatch(dir, batch.id, batchDeps));
  await waitFor(() => store.tasks.get(taskId)?.pipelineRun?.status === "blocked", 10000);
  const record = store.tasks.get(taskId)!.pipelineRun!.history.find((h) => h.stepId === steps[0]!.id)!;
  expect(record.reminder ?? null).toBeNull(); // not delivered
  expect(totalStepRuns(taskId)).toBe(1);
  expect(must(batches.getBatch(dir, batch.id)).autonomy!.maxRuns).toBe(1);
});

test("with budget left a reminder is delivered and counted like any other Run", async () => {
  process.env.AGETOR_FAKE_CLAUDE_RESOLVE_DELAY_MS = "200";
  const { dir, taskId, batch } = await grantedPipeline(`${MARK}:missing-then-done`, 5, 1);
  must(await batches.startBatch(dir, batch.id, batchDeps));
  await waitFor(() => store.tasks.get(taskId)?.pipelineRun?.status === "done", 10000);
  const view = must(batches.getBatch(dir, batch.id));
  expect(view.autonomyView!.runsUsed).toBe(totalStepRuns(taskId)); // what is counted is what was recorded
  expect(view.autonomyView!.runsUsed).toBeLessThanOrEqual(5);
});
