import { spawn, type ChildProcess } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test, expect, type APIRequestContext, type Page } from "./fixtures";
import { REPO_ROOT, isolatedCoreEnv, seedIsolatedHarnessHomes, writeFxStubBin } from "./isolated-env";
import { gotoApp } from "./helpers";
import { E2E_BASE_URL } from "../playwright.config";

/**
 * FO-ORCH05 controlled execution queue inside the plan view of the Manager tab. The project manager is the
 * fake codex driver (no real CLI, no AI quota) on an isolated backend + data
 * dir. The queue stores the Owner's order only: every test also checks that nothing
 * was started, and that the only road to a run is the existing review.
 */

test.describe.configure({ mode: "serial" });

const BASE_ENV = {
  AGETOR_CODEX_DRIVER: "fake",
  AGETOR_CODEX_BIN: "/bin/echo",
  AGETOR_CURSOR_BIN: "/nonexistent/cursor-agent",
  AGETOR_FAKE_MANAGER_DELAY_MS: "200",
};
test.use({ backendEnv: BASE_ENV });

type Core = { apiBase: string; apiToken: string };
const auth = (core: Core) => ({ authorization: `Bearer ${core.apiToken}` });

async function enableCodex(request: APIRequestContext, core: Core): Promise<void> {
  const res = await request.patch(`${core.apiBase}/harnesses/codex`, { headers: auth(core), data: { enabled: true } });
  expect(res.ok(), await res.text()).toBeTruthy();
}

async function registerProject(request: APIRequestContext, core: Core, name: string): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), `foorch05-${name.replace(/\W+/g, "-")}-`));
  await mkdir(path.join(dir, "docs"), { recursive: true });
  await writeFile(path.join(dir, "README.md"), `# ${name}\n`);
  const res = await request.post(`${core.apiBase}/projects`, { headers: auth(core), data: { path: dir, name } });
  expect(res.ok(), await res.text()).toBeTruthy();
  return (await res.json()).path as string;
}

async function tasksOf(request: APIRequestContext, core: Core, dir: string): Promise<any[]> {
  const res = await request.get(`${core.apiBase}/tasks`, { headers: auth(core) });
  return ((await res.json()) as any[]).filter((task) => task.workdir === dir);
}

/** Requests that could run something or assign someone. None may appear from the plan itself. */
function watch(page: Page): { starts: () => number; executions: () => number; assignments: () => number } {
  let starts = 0;
  let executions = 0;
  let assignments = 0;
  page.on("request", (req) => {
    if (req.method() === "GET") return;
    const url = new URL(req.url());
    if (/\/tasks\/[^/]+\/start$/.test(url.pathname) || /\/employee-execution\/.*\/start$/.test(url.pathname) || /\/batches\/[^/]+\/start$/.test(url.pathname)) starts += 1;
    if (url.pathname === "/project-manager/executions") executions += 1;
    if (url.pathname.startsWith("/task-assignments") || /\/assignment-proposals\/[^/]+\/approve$/.test(url.pathname)) assignments += 1;
  });
  return { starts: () => starts, executions: () => executions, assignments: () => assignments };
}

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

const nodeByTitle = (page: Page, title: string) =>
  page.locator('[data-testid="task-plan-node"]').filter({ has: page.locator('[data-testid="task-plan-node-title"]', { hasText: new RegExp(`^${title}$`) }) });


async function api(request: APIRequestContext, core: Core, method: "get" | "post" | "put" | "patch" | "delete", route: string, data?: unknown, status?: number): Promise<any> {
  const res = await request[method](`${core.apiBase}${route}`, { headers: auth(core), ...(data === undefined ? {} : { data }) });
  if (status) expect(res.status(), `${method} ${route}: ${await res.text()}`).toBe(status);
  else expect(res.ok(), `${method} ${route}: ${await res.text()}`).toBeTruthy();
  return res.json();
}

async function assignWorker(request: APIRequestContext, core: Core, dir: string, taskIds: string[]): Promise<void> {
  const worker = await api(request, core, "post", "/employees", { name: `Worker ${Math.random().toString(36).slice(2, 6)}`, jobTitle: "QA Engineer", projectPath: dir }, 201);
  for (const taskId of taskIds) await api(request, core, "post", "/task-assignments", { taskId, employeeId: worker.id }, 201);
}

const queue = (page: Page) => page.getByTestId("task-queue");
const entry = (page: Page, title: string) =>
  queue(page).locator('[data-testid="task-queue-entry"]').filter({ has: page.locator('[data-testid="task-queue-entry-title"]', { hasText: new RegExp(`^${title}$`) }) });

test("the Owner builds an ordered queue, blocked work can't be queued, pause and stop hold it, and a next task only opens the existing review", async ({ page, request, freshBackend: backend }) => {
  test.slow();
  await enableCodex(request, backend);
  const dir = await registerProject(request, backend, "Queue Orbit");
  const seen = watch(page);
  await gotoApp(page, backend.bootBase);
  await openManager(page, dir);
  await setUpAgent(page);
  await send(page, "Break user authentication into tasks");
  const proposal = page.getByTestId("manager-proposal");
  await proposal.getByTestId("manager-proposal-approve").click();
  await expect(proposal).toHaveAttribute("data-status", "approved");
  await proposal.getByTestId("task-plan-toggle").click();
  await expect(queue(page)).toBeVisible();
  await expect(page.getByTestId("task-queue-empty")).toBeVisible();

  // Only the one ready task is a candidate; blocked work can't be queued.
  const candidates = page.getByTestId("task-queue-candidates");
  await expect(candidates.getByTestId("task-queue-add")).toHaveCount(1);
  await expect(candidates).toContainText("Create the user model");
  await candidates.getByTestId("task-queue-add").click();
  await expect(page.getByTestId("task-queue-unsaved")).toBeVisible();
  await page.getByTestId("task-queue-save").click();
  await expect(queue(page)).toHaveAttribute("data-queue-status", "active");
  const modelEntry = entry(page, "Create the user model");
  await expect(modelEntry).toHaveAttribute("data-state", "waiting-owner");
  await expect(modelEntry.getByTestId("task-queue-reasons")).toContainText("Assign a worker first");
  await expect(page.getByTestId("task-queue-review-next")).toBeDisabled();

  // Assigning a worker changes the plan: the queue asks for a new review before it can advance.
  const tasks = await tasksOf(request, backend, dir);
  const model = tasks.find((task) => task.title === "Create the user model");
  await assignWorker(request, backend, dir, [model.id]);
  await page.getByTestId("task-plan-refresh").click();
  await expect(page.getByTestId("task-queue-needs-review")).toBeVisible();
  await expect(page.getByTestId("task-queue-review-next")).toBeDisabled();
  await page.getByTestId("task-queue-review-again").click();
  await expect(page.getByTestId("task-queue-needs-review")).toHaveCount(0);
  await expect(modelEntry).toHaveAttribute("data-state", "ready");
  await expect(modelEntry.getByTestId("task-queue-entry-next")).toBeVisible();
  await expect(modelEntry.getByTestId("task-queue-executor")).toContainText("availability unknown");

  // Pause holds it; resume restores it.
  await page.getByTestId("task-queue-pause").click();
  await expect(queue(page)).toHaveAttribute("data-queue-status", "paused");
  await expect(page.getByTestId("task-queue-review-next")).toBeDisabled();
  await page.getByTestId("task-queue-resume").click();
  await expect(queue(page)).toHaveAttribute("data-queue-status", "active");

  // Review next: the existing review opens. Nothing was started, no run exists.
  await page.getByTestId("task-queue-review-next").click();
  await expect(page.getByTestId("execution-card")).toBeVisible({ timeout: 15_000 });
  expect(seen.starts()).toBe(0);
  expect((await api(request, backend, "get", `/tasks/${model.id}/runs`)).length).toBe(0);

  // The prerequisite is only Review: the dependent stays blocked and unqueueable. Done unblocks it.
  await api(request, backend, "patch", `/tasks/${model.id}`, { column: "review" });
  await page.getByTestId("task-plan-refresh").click();
  await expect(modelEntry).toHaveAttribute("data-state", "waiting-owner");
  await expect(page.getByTestId("task-queue-candidates")).toHaveCount(0);
  await api(request, backend, "patch", `/tasks/${model.id}`, { column: "done" });
  await page.getByTestId("task-plan-refresh").click();
  await expect(modelEntry).toHaveAttribute("data-state", "completed");
  await expect(page.getByTestId("task-queue-candidates").getByTestId("task-queue-add")).toHaveCount(2);

  // Stop: nothing advances from a stopped queue.
  await page.getByTestId("task-queue-stop").click();
  await expect(queue(page)).toHaveAttribute("data-queue-status", "stopped");
  await expect(page.getByTestId("task-queue-review-next")).toBeDisabled();
  await expect(page.getByTestId("task-queue-no-next")).toContainText("stopped");
  expect(seen.starts()).toBe(0);
  expect(seen.assignments()).toBe(0);
});

test("a stale plan can't be queued, and deleting a prerequisite keeps its dependent blocked", async ({ page, request, freshBackend: backend }) => {
  test.slow();
  await enableCodex(request, backend);
  const dir = await registerProject(request, backend, "Queue Safety");
  const seen = watch(page);
  await gotoApp(page, backend.bootBase);
  await openManager(page, dir);
  await setUpAgent(page);
  await send(page, "Break user authentication into tasks");
  const proposal = page.getByTestId("manager-proposal");
  await proposal.getByTestId("manager-proposal-approve").click();
  await expect(proposal).toHaveAttribute("data-status", "approved");
  await proposal.getByTestId("task-plan-toggle").click();
  await expect(page.getByTestId("task-queue-candidates")).toBeVisible();

  const tasks = await tasksOf(request, backend, dir);
  const model = tasks.find((task) => task.title === "Create the user model");
  const login = tasks.find((task) => task.title === "Implement user login");
  const planId = (await api(request, backend, "get", `/project-manager/plans?path=${encodeURIComponent(dir)}`)).plans[0].proposalId as string;

  // A plan key read before a change is refused with the fresh plan; nothing is saved.
  const staleKey = await page.getByTestId("task-plan-body").getAttribute("data-plan-key");
  await api(request, backend, "put", `/project-manager/tasks/${model.id}/scheduling`, { path: dir, priority: "critical" });
  const stale = await request.put(`${backend.apiBase}/project-manager/plans/${planId}/queue`, { headers: auth(backend), data: { path: dir, taskIds: [model.id], planKey: staleKey } });
  expect(stale.status()).toBe(409);
  expect((await stale.json()).stale).toBe(true);
  expect((await api(request, backend, "get", `/project-manager/plans/${planId}/queue?path=${encodeURIComponent(dir)}`)).queue).toBeNull();

  // The dependent can't be queued while its prerequisite is not Done...
  const keyNow = (await api(request, backend, "get", `/project-manager/plans/${planId}?path=${encodeURIComponent(dir)}`)).planKey as string;
  const blocked = await request.put(`${backend.apiBase}/project-manager/plans/${planId}/queue`, { headers: auth(backend), data: { path: dir, taskIds: [login.id], planKey: keyNow } });
  expect(blocked.status()).toBe(409);
  // ...and deleting the prerequisite does not make it startable.
  const del = await request.delete(`${backend.apiBase}/tasks/${model.id}`, { headers: auth(backend) });
  expect(del.ok(), await del.text()).toBeTruthy();
  const after = await api(request, backend, "get", `/project-manager/plans/${planId}?path=${encodeURIComponent(dir)}`);
  const node = after.nodes.find((n: any) => n.taskId === login.id);
  expect(node.state).toBe("blocked");
  expect(node.reasons.join(" ")).toContain("deleted");
  const start = await request.post(`${backend.apiBase}/tasks/${login.id}/start`, { headers: auth(backend) });
  expect(start.ok()).toBeFalsy();
  expect(await start.text()).toContain("deleted");
  expect((await api(request, backend, "get", `/tasks/${login.id}/runs`)).length).toBe(0);
  expect(seen.starts()).toBe(0);
});

/* ────────────────────────────────────────────────────────────────────────── *
 * Restart: two headless backends, one after the other, on one data dir.
 * ────────────────────────────────────────────────────────────────────────── */

async function startHeadless(dataDir: string, port: number, token: string): Promise<ChildProcess> {
  const fxBin = writeFxStubBin(dataDir);
  const seeded = seedIsolatedHarnessHomes(dataDir, fxBin);
  if (!seeded.ok) throw new Error(`could not initialize isolated test accounts: ${seeded.stderr}`);
  const child = spawn("bun", ["src/bun/headless.ts"], {
    cwd: REPO_ROOT,
    env: isolatedCoreEnv({ dataDir, apiPort: port, apiToken: token, fxBin, extra: BASE_ENV }),
    stdio: "ignore",
  });
  for (let i = 0; i < 300; i++) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/health`);
      if (res.ok) return child;
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

test("after a restart the queue, its order and its pause survive, the next task needs a fresh review, and nothing starts", async ({ request }, testInfo) => {
  test.slow();
  const dataDir = await mkdtemp(path.join(tmpdir(), "foorch05-restart-"));
  const port = 4870 + testInfo.parallelIndex;
  const token = `foorch05-${crypto.randomUUID()}`;
  const core: Core = { apiBase: `http://127.0.0.1:${port}`, apiToken: token };
  let child = await startHeadless(dataDir, port, token);
  try {
    await enableCodex(request, core);
    const dir = await registerProject(request, core, "Restart Queue");
    const call = (method: "get" | "post" | "put", route: string, data?: unknown) => api(request, core, method, route, data);
    const pre = await call("post", "/project-interviews/preflight", { harness: "codex", model: "gpt-6.1-sol" });
    await call("put", "/project-manager/config", { path: dir, config: { harness: "codex", model: "gpt-6.1-sol", effort: "low", consentKey: pre.isolation.consentKey } });
    const sent = await call("post", "/project-manager/messages", { path: dir, text: "Break user authentication into tasks" });
    for (let i = 0; i < 200; i++) {
      const turn = await call("get", `/project-manager/turns/${sent.turn.id}`);
      if (turn.status !== "running") break;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    const state = await call("get", `/project-manager?path=${encodeURIComponent(dir)}`);
    const stored = state.proposals[0];
    await call("post", `/project-manager/proposals/${stored.id}/approve`, { path: dir, revision: stored.revision });
    const tasks = await tasksOf(request, core, dir);
    const model = tasks.find((task) => task.title === "Create the user model");
    await assignWorker(request, core, dir, [model.id]);
    const plan = await call("get", `/project-manager/plans/${stored.id}?path=${encodeURIComponent(dir)}`);
    const saved = await call("put", `/project-manager/plans/${stored.id}/queue`, { path: dir, taskIds: [model.id], planKey: plan.planKey });
    const paused = await call("post", `/project-manager/queues/${saved.queue.id}/pause`, { path: dir, revision: saved.queue.revision });
    expect(paused.queue.status).toBe("paused");

    await stopHeadless(child);
    child = await startHeadless(dataDir, port, token);

    const after = await call("get", `/project-manager/plans/${stored.id}/queue?path=${encodeURIComponent(dir)}`);
    expect(after.queue).toMatchObject({ id: saved.queue.id, status: "paused", revision: paused.queue.revision, needsReview: false });
    expect(after.queue.entries.map((e: any) => [e.taskId, e.state])).toEqual([[model.id, "ready"]]);
    // Paused: nothing advances, and the refusal says why.
    const refused = await request.post(`${core.apiBase}/project-manager/queues/${saved.queue.id}/next`, {
      headers: auth(core), data: { path: dir, revision: paused.queue.revision, planKey: after.queue.planKey },
    });
    expect(refused.status()).toBe(409);
    expect((await refused.json()).error).toContain("paused");
    const resumed = await call("post", `/project-manager/queues/${saved.queue.id}/resume`, { path: dir, revision: paused.queue.revision });
    const next = await call("post", `/project-manager/queues/${saved.queue.id}/next`, { path: dir, revision: resumed.queue.revision, planKey: resumed.queue.planKey });
    expect(next.next.taskId).toBe(model.id);
    for (const task of await tasksOf(request, core, dir)) {
      expect(task.runId).toBeNull();
      expect(await call("get", `/tasks/${task.id}/runs`)).toHaveLength(0);
    }
  } finally {
    await stopHeadless(child);
    await rm(dataDir, { recursive: true, force: true }).catch(() => {});
  }
});
