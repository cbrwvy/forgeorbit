import { spawn, type ChildProcess } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test, expect, type APIRequestContext, type Page } from "./fixtures";
import { REPO_ROOT, isolatedCoreEnv, seedIsolatedHarnessHomes, writeFxStubBin } from "./isolated-env";
import { gotoApp } from "./helpers";
import { newStep } from "../src/shared/pipeline";
import { E2E_BASE_URL } from "../playwright.config";

/**
 * FO-ORCH09 end-to-end acceptance of the multi-agent orchestration chain:
 * Owner goal -> PM plan -> tasks -> dependencies -> recommendations ->
 * assignments -> queue -> Execution Batch -> bounded grant -> Runs -> results
 * -> Owner acceptance. Real HTTP API, real UI where a UI step exists, real
 * orchestrator, SQLite and batch engine on a disposable backend. Every agent is
 * a fake driver (no CLI, no provider call, no AI quota). The Owner gates are
 * never bypassed: every approve / grant / start / accept below is the same
 * explicit call the UI makes.
 */

test.describe.configure({ mode: "serial" });

const GOAL = "Разработать небольшой REST API с авторизацией, тестами и документацией";
const HANDOFF = "__agetor_fake_claude_handoff__";

const BASE_ENV = {
  AGETOR_CODEX_DRIVER: "fake",
  AGETOR_CODEX_BIN: "/bin/echo",
  AGETOR_CURSOR_BIN: "/nonexistent/cursor-agent",
  AGETOR_FAKE_MANAGER_DELAY_MS: "100",
  AGETOR_FAKE_CODEX_RESOLVE_DELAY_MS: "700",
};

type Core = { apiBase: string; apiToken: string };
type Ctx = { request: APIRequestContext; core: Core };
const headers = (core: Core) => ({ authorization: `Bearer ${core.apiToken}` });

async function call(ctx: Ctx, method: "get" | "post" | "put" | "patch" | "delete", route: string, data?: unknown, expected?: number | "ok"): Promise<any> {
  const res = await ctx.request[method](`${ctx.core.apiBase}${route}`, { headers: headers(ctx.core), ...(data === undefined ? {} : { data }) });
  const text = await res.text();
  if (typeof expected === "number") expect(res.status(), `${method} ${route}: ${text}`).toBe(expected);
  else if (expected === "ok") expect(res.ok(), `${method} ${route}: ${text}`).toBeTruthy();
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}
const ok = (ctx: Ctx, method: "get" | "post" | "put" | "patch" | "delete", route: string, data?: unknown) => call(ctx, method, route, data, "ok");

async function registerProject(ctx: Ctx, name: string): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), `foorch09-${name.replace(/\W+/g, "-")}-`));
  await mkdir(path.join(dir, "docs"), { recursive: true });
  await writeFile(path.join(dir, "README.md"), `# ${name}\n`);
  const project = await ok(ctx, "post", "/projects", { path: dir, name });
  return project.path as string;
}

async function enable(ctx: Ctx, harness: string): Promise<void> {
  await ok(ctx, "patch", `/harnesses/${harness}`, { enabled: true });
}

async function createTask(ctx: Ctx, dir: string, title: string, fields: Record<string, unknown> = {}): Promise<string> {
  const task = await ok(ctx, "post", "/tasks", {
    title,
    prompt: `${title}.\n\n## Acceptance criteria\n- It works`,
    workdir: dir,
    agent: "codex",
    model: "gpt-6.1-sol",
    mode: "ask",
    isolation: "none",
    column: "backlog",
    ...fields,
  });
  return task.id as string;
}

const runsOf = async (ctx: Ctx, taskId: string): Promise<any[]> => ok(ctx, "get", `/tasks/${taskId}/runs`);
const q = (dir: string) => `path=${encodeURIComponent(dir)}`;
const journal = async (ctx: Ctx, eventType: string): Promise<any[]> => {
  const body = await ok(ctx, "get", `/activity?eventType=${encodeURIComponent(eventType)}`);
  return ((body.events ?? body) as any[]).filter((event) => event.eventType === eventType);
};

/** A batch draft -> approved (all spend acknowledgements named). */
async function approvedBatch(ctx: Ctx, dir: string, taskIds: string[], policy: Record<string, unknown> = {}): Promise<any> {
  const draft = await call(ctx, "post", "/project-manager/batches", { path: dir, taskIds, title: "Acceptance batch", policy: { noOverageHarnessIds: ["codex"], ...policy } }, 201);
  const approved = await call(ctx, "post", `/project-manager/batches/${draft.id}/approve`, {
    path: dir, revision: draft.revision, previewKey: draft.preview.key, acknowledgedHarnessIds: draft.preview.spendingHarnessIds,
  }, 200);
  return approved.batch;
}

const grantBody = (dir: string, batch: any, extra: Record<string, unknown> = {}) => ({
  path: dir, confirm: true, previewKey: batch.approval.previewKey, acknowledgeUnknownQuota: true, maxRuns: 2, maxParallelism: 1, ttlMinutes: 60, ...extra,
});

async function grantedBatch(ctx: Ctx, dir: string, taskIds: string[], policy: Record<string, unknown> = {}, grant: Record<string, unknown> = {}): Promise<any> {
  const approved = await approvedBatch(ctx, dir, taskIds, policy);
  const granted = await call(ctx, "post", `/project-manager/batches/${approved.id}/autonomy`, grantBody(dir, approved, grant), 200);
  return granted.batch;
}

const startBatch = (ctx: Ctx, dir: string, id: string, expected?: number) => call(ctx, "post", `/project-manager/batches/${id}/start`, { path: dir }, expected);
const getBatch = (ctx: Ctx, dir: string, id: string): Promise<any> => ok(ctx, "get", `/project-manager/batches/${id}?${q(dir)}`);

async function waitFor<T>(fn: () => Promise<T | null | undefined | false>, timeoutMs = 20_000, label = "condition"): Promise<T> {
  const start = Date.now();
  for (;;) {
    const value = await fn();
    if (value) return value;
    if (Date.now() - start > timeoutMs) throw new Error(`timed out waiting for ${label}`);
    await new Promise((resolve) => setTimeout(resolve, 120));
  }
}

async function settle(ms = 2500): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

// ---------------------------------------------------------------------------------------------------------------
// UI helpers (same selectors the existing FO-ORCH05..08 specs use)
// ---------------------------------------------------------------------------------------------------------------

async function openManager(page: Page, dir: string): Promise<void> {
  await page.locator(`[data-testid="project-nav-item"][data-path="${dir}"]`).click();
  await expect(page.getByTestId("project-header-name")).toBeVisible();
  await page.getByTestId("project-page-manager").click();
  await expect(page.getByTestId("manager-page")).toBeVisible();
}

async function setUpAgent(page: Page): Promise<void> {
  await expect(page.getByTestId("manager-harness")).toHaveValue("codex", { timeout: 20_000 });
  await expect(page.getByTestId("manager-isolation")).toBeVisible();
  await page.getByTestId("manager-consent").check();
  await expect(page.getByTestId("manager-connection")).toHaveText("Ready");
}

async function send(page: Page, text: string): Promise<void> {
  await page.getByTestId("manager-composer").fill(text);
  await page.getByTestId("manager-send").click();
  await expect(page.getByTestId("manager-busy")).toBeVisible();
  await expect(page.getByTestId("manager-busy")).toHaveCount(0);
}

/** Counts every request that could run an agent. */
function countStarts(page: Page): () => number {
  let starts = 0;
  page.on("request", (req) => {
    if (req.method() !== "POST") return;
    const url = req.url();
    if (/\/project-manager\/batches\/[^/]+\/(start|resume)$/.test(url)) starts += 1;
    if (/\/project-manager\/executions\/[^/]+\/approve$/.test(url)) starts += 1;
    if (/\/tasks\/[^/]+\/start$/.test(url)) starts += 1;
  });
  return () => starts;
}

// ---------------------------------------------------------------------------------------------------------------
// 1. The whole chain, Owner gates intact
// ---------------------------------------------------------------------------------------------------------------

test.describe("end-to-end workflow", () => {
  test.use({ backendEnv: BASE_ENV });

  test("Owner goal -> PM plan -> tasks -> assignments -> queue -> batch -> grant -> runs -> acceptance -> unblocking", async ({ page, request, freshBackend: backend }) => {
    test.setTimeout(240_000);
    const ctx: Ctx = { request, core: backend };
    await enable(ctx, "codex");
    const dir = await registerProject(ctx, "REST API");
    const starts = countStarts(page);
    const byTitle = async (title: string) => {
      const tasks = ((await ok(ctx, "get", "/tasks")) as any[]).filter((task) => task.workdir === dir);
      return tasks.find((task) => task.title === title)!;
    };

    // 1. PM proposes a plan (UI): nothing is created before the Owner approves.
    await gotoApp(page, backend.bootBase);
    await openManager(page, dir);
    await setUpAgent(page);
    await send(page, GOAL);
    const proposal = page.getByTestId("manager-proposal");
    await expect(proposal).toBeVisible({ timeout: 20_000 });
    expect(((await ok(ctx, "get", "/tasks")) as any[]).filter((task) => task.workdir === dir)).toHaveLength(0);

    // 2./3. The Owner reviews and approves: four board tasks, in Backlog, no run.
    await proposal.getByTestId("manager-proposal-approve").click();
    await expect(proposal).toHaveAttribute("data-status", "approved");
    const taskIds: Record<string, string> = {};
    for (const title of ["Design the API", "Implement the API", "Write the API tests", "Prepare the API documentation"]) {
      const task = await byTitle(title);
      expect(task, title).toBeTruthy();
      expect(task.column).toBe("backlog");
      expect(await runsOf(ctx, task.id)).toHaveLength(0);
      taskIds[title] = task.id;
    }
    const A = taskIds["Design the API"]!;
    const B = taskIds["Implement the API"]!;
    const C = taskIds["Write the API tests"]!;
    const D = taskIds["Prepare the API documentation"]!;

    // 2b. Structured dependencies: B<-A, C<-B, D<-A, nothing else.
    const scheduling = await ok(ctx, "get", `/project-manager/scheduling?${q(dir)}`);
    const deps = (id: string) => (scheduling.tasks.find((task: any) => task.taskId === id).dependsOn as any[]).map((dep) => dep.taskId).sort();
    expect(deps(A)).toEqual([]);
    expect(deps(B)).toEqual([A]);
    expect(deps(C)).toEqual([B]);
    expect(deps(D)).toEqual([A]);

    // The Owner chooses the executor: first the harness, then model and mode (a single PATCH that also
    // changes the harness has its model/mode reset asynchronously, see the report, P3).
    for (const id of [A, B, C, D]) await ok(ctx, "patch", `/tasks/${id}`, { agent: "codex" });
    await settle(600);
    for (const id of [A, B, C, D]) await ok(ctx, "patch", `/tasks/${id}`, { model: "gpt-6.1-sol", mode: "ask" });

    // 4. Plan view: only A is ready; B, C, D are blocked on dependencies.
    const projectPlans = await ok(ctx, "get", `/project-manager/plans?${q(dir)}`);
    const proposalId = projectPlans.plans[0].proposalId as string;
    const planNode = (plan: any, id: string) => plan.nodes.find((node: any) => node.taskId === id);
    const plan0 = await ok(ctx, "get", `/project-manager/plans/${proposalId}?${q(dir)}`);
    expect(plan0.readOnly).toBe(true);
    expect(plan0.counts.completed).toBe(0);
    expect(planNode(plan0, B).state).toBe("blocked");
    expect(planNode(plan0, C).state).toBe("blocked");
    expect(planNode(plan0, D).state).toBe("blocked");
    expect(planNode(plan0, A).assignment ?? null).toBeNull(); // no worker yet

    // 5. Recommendations: the router proposes an executor but proves nothing; nothing is assigned or run.
    const recommendation = planNode(plan0, A).executor.proposed;
    expect(recommendation.evidence).not.toBe("verified");
    expect(recommendation.requiresOwnerConfirmation).toBe(true);

    // 6. Assignments: the PM proposes a worker for the first task (UI message), the Owner reviews the
    // executor options and approves; the other tasks are assigned by the Owner directly.
    const ada = await call(ctx, "post", "/employees", { name: "Ada", jobTitle: "API Architect", projectPath: dir }, 201);
    const bob = await call(ctx, "post", "/employees", { name: "Bob", jobTitle: "Backend Engineer", projectPath: dir }, 201);
    await send(page, "Assign a worker to the first task");
    const proposals = (await ok(ctx, "get", `/assignment-proposals?projectPath=${encodeURIComponent(dir)}`)).proposals as any[];
    const assignmentProposal = proposals.find((item) => item.status === "pending");
    expect(assignmentProposal, "the PM must propose an assignment").toBeTruthy();
    expect(["Ada", "Bob"]).toContain(assignmentProposal.worker.name);
    const review = (await ok(ctx, "get", `/assignment-proposals/${assignmentProposal.id}/recommendations`)).review;
    // Without the review token the approval is refused: an Owner gate, not a formality.
    await call(ctx, "post", `/assignment-proposals/${assignmentProposal.id}/approve`, { expectedRevision: assignmentProposal.revision, expectedAssignmentRevision: null, allowReassign: false }, 409);
    await call(ctx, "post", `/assignment-proposals/${assignmentProposal.id}/approve`, {
      expectedRevision: assignmentProposal.revision, expectedAssignmentRevision: null, allowReassign: false, routingReviewToken: review.reviewToken,
    }, 200);
    // The PM picked one task (whichever it lists first); the Owner assigns the rest, A included, by hand.
    for (const id of [A, B, C, D]) {
      if (id === assignmentProposal.taskId) continue;
      await call(ctx, "post", "/task-assignments", { taskId: id, employeeId: id === C ? ada.id : bob.id }, 201);
    }
    for (const id of [A, B, C, D]) expect(await runsOf(ctx, id)).toHaveLength(0);

    // 7. Queue: only A can be queued; blocked work is refused (Review/dependencies are not bypassed).
    const plan1 = await ok(ctx, "get", `/project-manager/plans/${proposalId}?${q(dir)}`);
    expect(planNode(plan1, A).state).toBe("ready");
    const blockedQueue = await call(ctx, "put", `/project-manager/plans/${proposalId}/queue`, { path: dir, taskIds: [B], planKey: plan1.planKey }, 409);
    expect(JSON.stringify(blockedQueue)).toContain("can't be queued");
    const saved = (await call(ctx, "put", `/project-manager/plans/${proposalId}/queue`, { path: dir, taskIds: [A], planKey: plan1.planKey }, 200)).queue;
    expect(saved.status).toBe("active");
    expect((await journal(ctx, "queue.plan.confirmed")).length).toBe(1);

    // 8. Queue -> Execution Batch draft (nothing starts).
    const handoff = (await call(ctx, "post", `/project-manager/queues/${saved.id}/batch`, { path: dir, revision: saved.revision, planKey: plan1.planKey, policy: { noOverageHarnessIds: ["codex"] } }, 201)).batch;
    expect(handoff.status).toBe("draft");
    expect(handoff.entries.map((entry: any) => entry.taskId)).toEqual([A]);
    expect(await runsOf(ctx, A)).toHaveLength(0);
    expect(starts()).toBe(0);

    // 9./10. UI: approve (API), then the Owner reviews and confirms the bounded grant in the UI.
    const approved = await call(ctx, "post", `/project-manager/batches/${handoff.id}/approve`, {
      path: dir, revision: handoff.revision, previewKey: handoff.preview.key, acknowledgedHarnessIds: handoff.preview.spendingHarnessIds,
    }, 200);
    await page.getByTestId("manager-tab-autonomy").click();
    await expect(page.getByTestId("autonomous-execution")).toBeVisible();
    await page.locator(`[data-testid="batch-row"][data-batch-id="${approved.batch.id}"]`).click();
    const section = page.getByTestId("autonomy-section");
    await expect(section).toHaveAttribute("data-mode", "manual");
    await page.getByTestId("autonomy-enable").click();
    await expect(page.getByTestId("autonomy-grant")).toBeDisabled();
    await page.getByTestId("autonomy-confirm").check();
    await page.getByTestId("autonomy-ack-unknown").check();
    await page.getByTestId("autonomy-max-runs").fill("2");
    await page.getByTestId("autonomy-max-parallel").fill("1");
    await page.getByTestId("autonomy-grant").click();
    await expect(section).toHaveAttribute("data-mode", "bounded");
    await expect(page.getByTestId("autonomy-runs")).toHaveText("0 / 2");
    expect(await runsOf(ctx, A)).toHaveLength(0); // a grant starts nothing
    expect(starts()).toBe(0);
    expect((await journal(ctx, "autonomy.grant.approved")).length).toBe(1);

    // 11./12. Start is the Owner's separate action. The fake driver runs; the run lands in Review.
    await page.getByTestId("batch-start").click();
    await expect(page.getByTestId("batch-detail")).toHaveAttribute("data-status", "running");
    await waitFor(async () => (await getBatch(ctx, dir, approved.batch.id)).entries[0].state === "review", 30_000, "A in review");
    expect(await runsOf(ctx, A)).toHaveLength(1);
    expect((await runsOf(ctx, A))[0].status).toBe("succeeded");
    expect((await journal(ctx, "autonomy.execution.started")).length).toBe(1);

    // Review is not Done: B and D stay blocked, and cannot be queued.
    const plan2 = await ok(ctx, "get", `/project-manager/plans/${proposalId}?${q(dir)}`);
    for (const id of [B, D]) expect(planNode(plan2, id).state, "dependents of a task in Review").toBe("blocked");
    await call(ctx, "put", `/project-manager/plans/${proposalId}/queue`, { path: dir, taskIds: [A, B], planKey: plan2.planKey, revision: saved.revision }, 409);
    for (const id of [B, C, D]) expect(await runsOf(ctx, id)).toHaveLength(0);

    // 13. The Owner accepts A through the existing review (UI).
    await page.locator(`[data-testid="batch-entry"][data-task-id="${A}"] [data-testid="batch-entry-review"]`).click();
    await page.locator(`[data-testid="batch-entry"][data-task-id="${A}"] [data-testid="execution-accept"]`).click();
    await expect.poll(async () => (await byTitle("Design the API")).column).toBe("done");
    await waitFor(async () => (await getBatch(ctx, dir, approved.batch.id)).status === "completed", 20_000, "batch 1 completed");
    expect(starts()).toBe(1);

    // 14. Accepting unblocked B and D (not C: it waits for B).
    const plan3 = await ok(ctx, "get", `/project-manager/plans/${proposalId}?${q(dir)}`);
    expect(planNode(plan3, B).state).toBe("ready");
    expect(planNode(plan3, D).state).toBe("ready");
    expect(planNode(plan3, C).state).toBe("blocked");

    // Stage 2: queue B + D, hand off, approve, grant (bounded to 2 Runs), start, accept each.
    const queue2 = (await call(ctx, "put", `/project-manager/plans/${proposalId}/queue`, { path: dir, taskIds: [A, B, D], planKey: plan3.planKey, revision: saved.revision }, 200)).queue;
    const batch2 = (await call(ctx, "post", `/project-manager/queues/${queue2.id}/batch`, { path: dir, revision: queue2.revision, planKey: plan3.planKey, taskIds: [B, D], policy: { noOverageHarnessIds: ["codex"], reviewPolicy: "wait-for-review" } }, 201)).batch;
    expect(batch2.entries.map((entry: any) => entry.taskId).sort()).toEqual([B, D].sort());
    const approved2 = (await call(ctx, "post", `/project-manager/batches/${batch2.id}/approve`, { path: dir, revision: batch2.revision, previewKey: batch2.preview.key, acknowledgedHarnessIds: batch2.preview.spendingHarnessIds }, 200)).batch;
    await call(ctx, "post", `/project-manager/batches/${approved2.id}/autonomy`, grantBody(dir, approved2, { maxRuns: 2 }), 200);
    await startBatch(ctx, dir, approved2.id, 200);
    const acceptEntry = async (batchId: string, taskId: string) => {
      await waitFor(async () => (await getBatch(ctx, dir, batchId)).entries.find((entry: any) => entry.taskId === taskId)?.state === "review", 30_000, `${taskId} in review`);
      const executions = (await ok(ctx, "get", `/project-manager/executions?${q(dir)}`)) as any[];
      const execution = executions.find((item) => item.taskId === taskId && item.batchId === batchId);
      await call(ctx, "post", `/project-manager/executions/${execution.id}/review`, { path: dir, action: "accept" }, 200);
    };
    await acceptEntry(approved2.id, B);
    await acceptEntry(approved2.id, D);
    await waitFor(async () => (await getBatch(ctx, dir, approved2.id)).status === "completed", 30_000, "batch 2 completed");
    expect(await runsOf(ctx, B)).toHaveLength(1);
    expect(await runsOf(ctx, D)).toHaveLength(1);
    expect(await runsOf(ctx, C)).toHaveLength(0);

    // Stage 3: C became ready only after B was Done.
    const plan4 = await ok(ctx, "get", `/project-manager/plans/${proposalId}?${q(dir)}`);
    expect(planNode(plan4, C).state).toBe("ready");
    const queue3 = (await call(ctx, "put", `/project-manager/plans/${proposalId}/queue`, { path: dir, taskIds: [A, B, D, C], planKey: plan4.planKey, revision: queue2.revision }, 200)).queue;
    const batch3 = (await call(ctx, "post", `/project-manager/queues/${queue3.id}/batch`, { path: dir, revision: queue3.revision, planKey: plan4.planKey, taskIds: [C], policy: { noOverageHarnessIds: ["codex"] } }, 201)).batch;
    const approved3 = (await call(ctx, "post", `/project-manager/batches/${batch3.id}/approve`, { path: dir, revision: batch3.revision, previewKey: batch3.preview.key, acknowledgedHarnessIds: batch3.preview.spendingHarnessIds }, 200)).batch;
    await call(ctx, "post", `/project-manager/batches/${approved3.id}/autonomy`, grantBody(dir, approved3, { maxRuns: 1 }), 200);
    await startBatch(ctx, dir, approved3.id, 200);
    await acceptEntry(approved3.id, C);
    await waitFor(async () => (await getBatch(ctx, dir, approved3.id)).status === "completed", 30_000, "batch 3 completed");

    // Final accounting: exactly one Run per task, all Done, one Run in total per accepted task.
    for (const id of [A, B, C, D]) {
      expect(await runsOf(ctx, id), `runs of ${id}`).toHaveLength(1);
      expect((await ok(ctx, "get", `/tasks/${id}`)).column).toBe("done");
    }
    const finalPlan = await ok(ctx, "get", `/project-manager/plans/${proposalId}?${q(dir)}`);
    expect(finalPlan.counts.completed).toBe(4);
    // Journal: the grants, the starts and the queue confirmations are all recorded, once each.
    expect((await journal(ctx, "autonomy.grant.approved")).length).toBe(3);
    expect((await journal(ctx, "queue.handoff.prepared")).length).toBe(3);
    expect((await journal(ctx, "autonomy.execution.started")).length).toBe(3);
  });
});

// ---------------------------------------------------------------------------------------------------------------
// 2. Autonomous safety, over HTTP
// ---------------------------------------------------------------------------------------------------------------

test.describe("autonomous safety", () => {
  test.use({ backendEnv: { ...BASE_ENV, AGETOR_FAKE_CODEX_RESOLVE_DELAY_MS: "1200" } });

  test("maxRuns=2 blocks the third Run, maxParallelism=1 holds, exhausted grants stay exhausted", async ({ request, freshBackend: backend }) => {
    test.setTimeout(120_000);
    const ctx: Ctx = { request, core: backend };
    await enable(ctx, "codex");
    const dir = await registerProject(ctx, "Limits");
    const tasks = [await createTask(ctx, dir, "Limit one"), await createTask(ctx, dir, "Limit two"), await createTask(ctx, dir, "Limit three")];
    const batch = await grantedBatch(ctx, dir, tasks, { maxParallel: 2, reviewPolicy: "continue-independent" }, { maxRuns: 2, maxParallelism: 1 });
    expect(batch.autonomy.maxRuns).toBe(2);
    expect(batch.autonomy.maxParallelism).toBe(1);
    for (const id of tasks) expect(await runsOf(ctx, id)).toHaveLength(0);

    await startBatch(ctx, dir, batch.id, 200);
    let maxLive = 0;
    const view = await waitFor(async () => {
      let live = 0;
      for (const id of tasks) live += (await runsOf(ctx, id)).filter((run) => run.status === "running").length;
      maxLive = Math.max(maxLive, live);
      const current = await getBatch(ctx, dir, batch.id);
      return current.autonomy?.status === "exhausted" && current.status === "paused" ? current : null;
    }, 30_000, "exhausted grant").catch(async (error) => {
      const current = await getBatch(ctx, dir, batch.id);
      throw new Error(`${error.message}: ${JSON.stringify({ status: current.status, reason: current.reason, autonomy: current.autonomy?.status, view: current.autonomyView, entries: current.entries.map((e: any) => [e.state, e.hold, e.readiness]) })}`);
    });
    await settle(2000);

    expect(maxLive).toBeLessThanOrEqual(1);
    const counts = await Promise.all(tasks.map(async (id) => (await runsOf(ctx, id)).length));
    expect(counts.reduce((a, b) => a + b, 0)).toBe(2);
    expect(counts[2]).toBe(0); // the third autonomous Run never exists
    expect(view.autonomyView.runsUsed).toBe(2);
    expect((await ok(ctx, "get", `/tasks/${tasks[2]}`)).column).toBe("backlog");
    // No automatic retry, no fallback: resume and start are refused, the counters don't move.
    await call(ctx, "post", `/project-manager/batches/${batch.id}/resume`, { path: dir }, 409);
    await startBatch(ctx, dir, batch.id, 409);
    await settle(1500);
    expect((await runsOf(ctx, tasks[2]!)).length).toBe(0);
    expect((await journal(ctx, "autonomy.grant.exhausted")).length).toBe(1);
    // An exhausted grant is not extended either: only a NEW grant by the Owner (new id, own counter) can
    // allow more Runs, and granting alone starts nothing.
    const exhaustedId = view.autonomy.id as string;
    const renewed = (await call(ctx, "post", `/project-manager/batches/${batch.id}/autonomy`, grantBody(dir, await getBatch(ctx, dir, batch.id), { maxRuns: 1 }), 200)).batch;
    expect(renewed.autonomy.id).not.toBe(exhaustedId);
    await settle(1500);
    expect((await runsOf(ctx, tasks[2]!)).length).toBe(0);
  });

  test("grant gates: confirmation, Unknown quota acknowledgement, Full access, no extension, revoke, mode change", async ({ request, freshBackend: backend }) => {
    test.setTimeout(120_000);
    const ctx: Ctx = { request, core: backend };
    await enable(ctx, "codex");
    const dir = await registerProject(ctx, "Gates");
    const a = await createTask(ctx, dir, "Gate task A");
    const approved = await approvedBatch(ctx, dir, [a]);
    const base = grantBody(dir, approved);

    // Preview is read only and carries the honest cost note; no confirmation / no acknowledgement -> refused.
    const preview = await call(ctx, "post", `/project-manager/batches/${approved.id}/autonomy/preview`, { path: dir }, 200);
    expect(preview.costNote).toContain("does not measure money");
    expect(preview.unknownQuota.length).toBeGreaterThan(0);
    expect((await call(ctx, "post", `/project-manager/batches/${approved.id}/autonomy`, { ...base, confirm: false })).error).toContain("Confirm");
    const noAck = await call(ctx, "post", `/project-manager/batches/${approved.id}/autonomy`, { ...base, acknowledgeUnknownQuota: false });
    expect(noAck.error).toBeTruthy();
    expect((await getBatch(ctx, dir, approved.id)).autonomy ?? null).toBeNull();
    expect(await runsOf(ctx, a)).toHaveLength(0);

    // Grant, then a second grant on a live grant is refused (never extended).
    const granted = (await call(ctx, "post", `/project-manager/batches/${approved.id}/autonomy`, base, 200)).batch;
    const first = granted.autonomy.id;
    await call(ctx, "post", `/project-manager/batches/${approved.id}/autonomy`, { ...base, maxRuns: 50 }, 409);

    // A broader permission mode after the grant holds the start: no Run, nothing substituted.
    await ok(ctx, "patch", `/tasks/${a}`, { mode: "auto" });
    await startBatch(ctx, dir, approved.id);
    await settle(2500);
    expect(await runsOf(ctx, a)).toHaveLength(0);
    expect((await ok(ctx, "get", `/tasks/${a}`)).model).toBe("gpt-6.1-sol");
    expect((await ok(ctx, "get", `/tasks/${a}`)).agent).toBe("codex");

    // Revoke: idempotent; after it a NEW grant has a new id and its own counter.
    const revoked = await call(ctx, "post", `/project-manager/batches/${approved.id}/autonomy/revoke`, { path: dir }, 200);
    expect(revoked.alreadyEnded).toBe(false);
    expect((await call(ctx, "post", `/project-manager/batches/${approved.id}/autonomy/revoke`, { path: dir }, 200)).alreadyEnded).toBe(true);
    expect((await journal(ctx, "autonomy.grant.revoked")).length).toBe(1);
    const view = await getBatch(ctx, dir, approved.id);
    expect(view.autonomy.status).toBe("revoked");
    expect(["paused", "approved"]).toContain(view.status);
    await call(ctx, "post", `/project-manager/batches/${approved.id}/resume`, { path: dir }, 409);
    expect(await runsOf(ctx, a)).toHaveLength(0);
    expect(first).toBeTruthy();

    // Full access (and any mode without sandbox) can't be granted; the Owner could still run it by hand.
    const full = await createTask(ctx, dir, "Full access task", { mode: "full-access" });
    const fullDraft = await call(ctx, "post", "/project-manager/batches", { path: dir, taskIds: [full], title: "Full", policy: { noOverageHarnessIds: ["codex"] } }, 201);
    const fullApproved = (await call(ctx, "post", `/project-manager/batches/${fullDraft.id}/approve`, {
      path: dir, revision: fullDraft.revision, previewKey: fullDraft.preview.key, acknowledgedHarnessIds: fullDraft.preview.spendingHarnessIds,
    }, 200)).batch;
    const fullPreview = await call(ctx, "post", `/project-manager/batches/${fullApproved.id}/autonomy/preview`, { path: dir }, 200);
    expect(fullPreview.blockers.map((blocker: any) => blocker.code)).toContain("mode-not-allowed");
    const grantFull = await call(ctx, "post", `/project-manager/batches/${fullApproved.id}/autonomy`, grantBody(dir, fullApproved));
    expect(grantFull.error).toBeTruthy();
    expect((await getBatch(ctx, dir, fullApproved.id)).autonomy ?? null).toBeNull();
    expect(await runsOf(ctx, full)).toHaveLength(0);
  });

  test("a deleted prerequisite leaves a tombstone; Review does not unblock; nothing starts", async ({ request, freshBackend: backend }) => {
    test.setTimeout(90_000);
    const ctx: Ctx = { request, core: backend };
    await enable(ctx, "codex");
    const dir = await registerProject(ctx, "Tombstone");
    const prerequisite = await createTask(ctx, dir, "Prerequisite");
    const dependent = await createTask(ctx, dir, "Dependent");
    await call(ctx, "put", `/project-manager/tasks/${dependent}/scheduling`, { path: dir, dependsOn: [prerequisite] }, 200);

    // A batch approved and granted while the prerequisite still exists (and is not Done): the dependent waits.
    const batch = await grantedBatch(ctx, dir, [dependent], {}, { maxRuns: 2 });
    await startBatch(ctx, dir, batch.id);
    await settle(1500);
    expect(await runsOf(ctx, dependent)).toHaveLength(0);

    // The prerequisite is deleted afterwards: a tombstone remains, the dependent is never started or unlinked.
    await ok(ctx, "delete", `/tasks/${prerequisite}`);
    const scheduling = await ok(ctx, "get", `/project-manager/scheduling?${q(dir)}`);
    const row = scheduling.tasks.find((task: any) => task.taskId === dependent);
    expect(row.deletedDependencies.length).toBe(1);
    expect(row.readiness.state).not.toBe("ready");
    await call(ctx, "post", `/project-manager/batches/${batch.id}/resume`, { path: dir });
    await settle(3000);
    expect(await runsOf(ctx, dependent)).toHaveLength(0);
    expect((await ok(ctx, "get", `/tasks/${dependent}`)).column).toBe("backlog");

    // A NEW batch containing the dependent can't even be approved while the tombstone stands.
    const draft = await call(ctx, "post", "/project-manager/batches", { path: dir, taskIds: [dependent], title: "After the delete", policy: { noOverageHarnessIds: ["codex"] } }, 201);
    const refused = await call(ctx, "post", `/project-manager/batches/${draft.id}/approve`, { path: dir, revision: draft.revision, previewKey: draft.preview.key, acknowledgedHarnessIds: draft.preview.spendingHarnessIds }, 409);
    expect(refused.error).toContain("was deleted");
  });

  test("a three-step pipeline under a two-Run grant: the third step gets no Run; the handoff reminder can't mint one", async ({ request, freshBackend: backend }) => {
    test.setTimeout(150_000);
    const ctx: Ctx = { request, core: backend };
    await enable(ctx, "claude-code");
    const dir = await registerProject(ctx, "Pipeline Budget");
    const profile = async () => (await call(ctx, "post", "/agent-profiles", { name: `pb-${Math.random().toString(36).slice(2, 8)}`, harness: "claude-code", model: "opus-5.5", mode: "acceptEdits", instructions: "" }, 200)).id as string;
    const build = async (instructions: string, steps: number) => {
      const built = [] as ReturnType<typeof newStep>[];
      for (let i = 0; i < steps; i++) built.push(newStep({ name: `S${i + 1}`, agentProfileId: await profile(), instructions: `Do S${i + 1}. ${instructions}` }));
      const edges = built.slice(1).map((step, i) => ({ id: `e${i}`, from: built[i]!.id, to: step.id, label: "" }));
      const pipeline = await call(ctx, "post", "/pipelines", { name: `pipe-${Math.random().toString(36).slice(2, 8)}`, graph: { steps: built, edges, startStepId: built[0]!.id }, maxSteps: 25 }, 201);
      const task = await ok(ctx, "post", "/tasks", { title: "Pipeline task", prompt: "goal", workdir: dir, isolation: "none", pipelineId: pipeline.id });
      return { taskId: task.id as string, steps: built };
    };
    const stepRuns = async (parentId: string) => {
      const all = ((await ok(ctx, "get", "/tasks")) as any[]).filter((task) => task.pipelineParentId === parentId);
      let total = 0;
      for (const step of all) total += (await runsOf(ctx, step.id)).length;
      return { total, steps: all.length };
    };

    // Three steps, budget two: S1 and S2 run, S3 never gets a Run, the pipeline reads Blocked.
    const { taskId } = await build(`${HANDOFF}:done`, 3);
    const batch = await grantedBatch(ctx, dir, [taskId], { noOverageHarnessIds: ["claude-code"], maxStarts: 6 }, { maxRuns: 2 });
    expect(batch.autonomy.resources.length).toBe(3);
    await startBatch(ctx, dir, batch.id, 200);
    await waitFor(async () => (await ok(ctx, "get", `/tasks/${taskId}`)).pipelineRun?.status === "blocked", 60_000, "pipeline blocked at the budget");
    await settle(2000);
    const used = await stepRuns(taskId);
    expect(used.total).toBe(2);
    expect(used.steps).toBeLessThanOrEqual(3); // the third step's row may exist, but it never gets a Run (total above)
    const run = (await ok(ctx, "get", `/tasks/${taskId}`)).pipelineRun;
    expect(JSON.stringify(run.blocked)).toContain("Autonomous execution");
    const ended = await waitFor(async () => { const view = await getBatch(ctx, dir, batch.id); return view.autonomy.status === "exhausted" ? view : null; }, 20_000, "grant exhausted");
    expect(ended.status).toBe("paused");
    // A manual Retry of the pipeline step is blocked while the (exhausted) grant covers the scope; counters hold.
    await settle(1500);
    expect((await stepRuns(taskId)).total).toBe(2);

    // A step that answers without a handoff would trigger the automatic reminder (a second Run): with a
    // one-Run budget that Run is refused, so exactly one Run exists for the step.
    const missing = await build(`${HANDOFF}:missing`, 1);
    const batch2 = await grantedBatch(ctx, dir, [missing.taskId], { noOverageHarnessIds: ["claude-code"], maxStarts: 4 }, { maxRuns: 1 });
    await startBatch(ctx, dir, batch2.id, 200);
    await waitFor(async () => (await stepRuns(missing.taskId)).total >= 1, 40_000, "first step Run");
    await settle(5000);
    expect((await stepRuns(missing.taskId)).total).toBe(1);
    const missingRun = (await ok(ctx, "get", `/tasks/${missing.taskId}`)).pipelineRun;
    expect(missingRun.status).toBe("blocked");
    expect(JSON.stringify(missingRun.blocked)).toContain("automatic reminder could not be sent");
    expect(JSON.stringify(missingRun.blocked)).toContain("Run budget (1) is used up");
  });
});

// ---------------------------------------------------------------------------------------------------------------
// 3. Restart: counts survive, no duplicate Run
// ---------------------------------------------------------------------------------------------------------------

async function startHeadless(dataDir: string, port: number, token: string): Promise<ChildProcess> {
  const fxBin = writeFxStubBin(dataDir);
  const seeded = seedIsolatedHarnessHomes(dataDir, fxBin);
  if (!seeded.ok) throw new Error(`could not initialize isolated test accounts: ${seeded.stderr}`);
  const child = spawn("bun", ["src/bun/headless.ts"], {
    cwd: REPO_ROOT,
    env: isolatedCoreEnv({ dataDir, apiPort: port, apiToken: token, fxBin, extra: { ...BASE_ENV, AGETOR_FAKE_CODEX_RESOLVE_DELAY_MS: "60000" } }),
    stdio: "ignore",
  });
  for (let i = 0; i < 300; i++) {
    try {
      if ((await fetch(`http://127.0.0.1:${port}/health`)).ok) return child;
    } catch {
      /* not up yet */
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  child.kill("SIGKILL");
  throw new Error("headless backend didn't start");
}

async function stopHeadless(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null) return;
  const exited = new Promise((resolve) => child.once("exit", resolve));
  child.kill("SIGTERM");
  await Promise.race([exited, new Promise((resolve) => setTimeout(resolve, 10_000))]);
  if (child.exitCode === null) child.kill("SIGKILL");
}

test("restart: the grant survives, Runs already made are counted once, resume never duplicates a Run", async ({ request }, testInfo) => {
  test.setTimeout(150_000);
  const dataDir = await mkdtemp(path.join(tmpdir(), "foorch09-restart-"));
  const port = 4900 + testInfo.parallelIndex;
  const token = `foorch09-${crypto.randomUUID()}`;
  const core: Core = { apiBase: `http://127.0.0.1:${port}`, apiToken: token };
  const ctx: Ctx = { request, core };
  let child = await startHeadless(dataDir, port, token);
  try {
    await enable(ctx, "codex");
    const dir = await registerProject(ctx, "Restart");
    const first = await createTask(ctx, dir, "Restart one");
    const second = await createTask(ctx, dir, "Restart two");
    const batch = await grantedBatch(ctx, dir, [first, second], {}, { maxRuns: 3 });
    await startBatch(ctx, dir, batch.id, 200);
    expect(await runsOf(ctx, first)).toHaveLength(1);

    await stopHeadless(child);
    child = await startHeadless(dataDir, port, token);

    const view = await getBatch(ctx, dir, batch.id);
    expect(view.status).toBe("paused");
    expect(view.autonomy.status).toBe("active"); // the Owner's grant is intact, but running is up to the Owner
    expect(view.autonomyView.runsUsed).toBe((await runsOf(ctx, first)).length + (await runsOf(ctx, second)).length);
    expect(await runsOf(ctx, first)).toHaveLength(1);
    await settle(1500);
    expect(await runsOf(ctx, second)).toHaveLength(0); // nothing started by itself after the restart
    await call(ctx, "post", `/project-manager/batches/${batch.id}/resume`, { path: dir }, 200);
    await settle(1500);
    expect(await runsOf(ctx, first)).toHaveLength(1); // the interrupted task is not launched twice
  } finally {
    await stopHeadless(child);
    await rm(dataDir, { recursive: true, force: true }).catch(() => {});
  }
});
