import { spawn, type ChildProcess } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test, expect, type APIRequestContext, type Page } from "./fixtures";
import { REPO_ROOT, isolatedCoreEnv, seedIsolatedHarnessHomes, writeFxStubBin } from "./isolated-env";
import { gotoApp } from "./helpers";
import { E2E_BASE_URL } from "../playwright.config";

/**
 * FO-ORCH06 queue progression inside the plan view of the Manager tab. The project manager is the
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
  const dir = await mkdtemp(path.join(tmpdir(), `foorch06-${name.replace(/\W+/g, "-")}-`));
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


const progression = (page: Page) => page.getByTestId("task-queue-progression");

async function approvePlan(page: Page, request: APIRequestContext, backend: Core & { bootBase: string }, name: string) {
  await enableCodex(request, backend);
  const dir = await registerProject(request, backend, name);
  await gotoApp(page, backend.bootBase);
  await openManager(page, dir);
  await setUpAgent(page);
  await send(page, "Break user authentication into tasks");
  const proposal = page.getByTestId("manager-proposal");
  await proposal.getByTestId("manager-proposal-approve").click();
  await expect(proposal).toHaveAttribute("data-status", "approved");
  await proposal.getByTestId("task-plan-toggle").click();
  await expect(queue(page)).toBeVisible();
  const tasks = await tasksOf(request, backend, dir);
  return { dir, tasks, byTitle: (title: string) => tasks.find((task) => task.title === title)! };
}

test("after A is Done the next task is prepared only with the opt-in, the Owner sees what changed, and only the Owner's confirmation lets Review open", async ({ page, request, freshBackend: backend }) => {
  test.slow();
  const { dir, tasks, byTitle } = await approvePlan(page, request, backend, "Progression Orbit");
  const seen = watch(page);
  await assignWorker(request, backend, dir, tasks.map((task) => task.id));
  const model = byTitle("Create the user model");
  await page.getByTestId("task-plan-refresh").click();

  // Queue the one ready task.
  await queue(page).getByTestId("task-queue-candidates").getByTestId("task-queue-add").click();
  await page.getByTestId("task-queue-save").click();
  await expect(progression(page)).toHaveAttribute("data-phase", "ready-to-review");
  await expect(progression(page).getByTestId("task-queue-candidate")).toContainText("Create the user model");
  await expect(progression(page).getByTestId("task-queue-candidate-availability")).toHaveAttribute("data-availability", "unknown");
  await expect(progression(page).getByTestId("task-queue-candidate-mode")).toBeVisible();
  // The opt-in is off by default.
  await expect(page.getByTestId("task-queue-auto-prepare")).not.toBeChecked();

  // Run succeeded but not accepted: Review is not Done, dependents stay blocked.
  await api(request, backend, "patch", `/tasks/${model.id}`, { column: "review" });
  await page.getByTestId("task-plan-refresh").click();
  await expect(progression(page)).toHaveAttribute("data-phase", "waiting-owner");
  await expect(progression(page).getByTestId("task-queue-still-blocked")).toContainText("Implement user login");
  await expect(progression(page).getByTestId("task-queue-candidate")).toHaveCount(0);

  // Accepting A as Done changes the plan. Without the opt-in nothing is proposed, but the Owner is told.
  await api(request, backend, "patch", `/tasks/${model.id}`, { column: "done" });
  await page.getByTestId("task-plan-refresh").click();
  await expect(progression(page)).toHaveAttribute("data-phase", "stale");
  await expect(progression(page).getByTestId("task-queue-candidate")).toHaveCount(0);
  await expect(progression(page).getByTestId("task-queue-became-ready")).toContainText("Implement user login");
  await expect(progression(page).getByTestId("task-queue-changes")).toHaveAttribute("data-material", "false");
  await expect(page.getByTestId("task-queue-review-next")).toBeDisabled();

  // Opt in: the next ready task is prepared, outside the queue, and Review still cannot open.
  // The switch follows the core's answer, so click and wait for the stored state.
  await page.getByTestId("task-queue-auto-prepare").click();
  await expect(page.getByTestId("task-queue-auto-prepare")).toBeChecked();
  const candidate = progression(page).getByTestId("task-queue-candidate");
  await expect(candidate).toHaveAttribute("data-in-queue", "false");
  await expect(progression(page).getByTestId("task-queue-candidate-outside")).toBeVisible();
  await expect(page.getByTestId("task-queue-review-next")).toBeDisabled();
  await expect(progression(page)).toHaveAttribute("data-can-open-review", "false");
  expect(seen.starts()).toBe(0);

  // Journal: exactly one Owner event for the switch.
  const events = await api(request, backend, "get", `/activity?eventType=queue.preparation.enabled`);
  expect((events.events ?? events).filter((e: any) => e.eventType === "queue.preparation.enabled")).toHaveLength(1);

  // The Owner's confirmation (the existing save) adds it; only then can Review open.
  const preparedId = (await candidate.getAttribute("data-task-id"))!;
  await page.getByTestId("task-queue-confirm-plan").click();
  await expect(progression(page)).toHaveAttribute("data-phase", "ready-to-review");
  await expect(progression(page)).toHaveAttribute("data-can-open-review", "true");
  await expect(candidate).toHaveAttribute("data-in-queue", "true");
  await expect(candidate).toHaveAttribute("data-task-id", preparedId);
  await expect(page.getByTestId("task-queue-review-next")).toBeEnabled();
  await page.getByTestId("task-queue-review-next").click();
  await expect(page.getByTestId("execution-card")).toBeVisible({ timeout: 15_000 });

  // Nothing started, assigned or retried anywhere.
  expect(seen.starts()).toBe(0);
  expect(seen.assignments()).toBe(0);
  for (const task of await tasksOf(request, backend, dir)) {
    expect(await api(request, backend, "get", `/tasks/${task.id}/runs`)).toHaveLength(0);
  }
});

test("a changed assignment is shown as a material change, and a paused queue does not advance", async ({ page, request, freshBackend: backend }) => {
  test.slow();
  const { dir, tasks, byTitle } = await approvePlan(page, request, backend, "Progression Material");
  await assignWorker(request, backend, dir, tasks.map((task) => task.id));
  const model = byTitle("Create the user model");
  await page.getByTestId("task-plan-refresh").click();
  await queue(page).getByTestId("task-queue-candidates").getByTestId("task-queue-add").click();
  await page.getByTestId("task-queue-save").click();
  await expect(progression(page)).toHaveAttribute("data-phase", "ready-to-review");

  // Another worker takes the task: the old review is stale and the change is material.
  const other = await api(request, backend, "post", "/employees", { name: "Replacement Worker", jobTitle: "QA Engineer", projectPath: dir }, 201);
  await api(request, backend, "post", "/task-assignments/reassign", { taskId: model.id, employeeId: other.id, expectedRevision: 1 });
  await page.getByTestId("task-plan-refresh").click();
  await expect(page.getByTestId("task-queue-needs-review")).toBeVisible();
  await expect(page.getByTestId("task-queue-review-next")).toBeDisabled();

  // Pause: the phase says so and Review cannot open.
  await page.getByTestId("task-queue-review-again").click();
  await page.getByTestId("task-queue-pause").click();
  await expect(progression(page)).toHaveAttribute("data-phase", "paused");
  await expect(page.getByTestId("task-queue-review-next")).toBeDisabled();
});

/* ────────────────────────────────────────────────────────────────────────── *
 * Restart: the opt-in and the prepared candidate survive.
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

test("after a restart the opt-in and the prepared next task are rebuilt, the old plan key is still refused, and nothing starts", async ({ request }, testInfo) => {
  test.slow();
  const dataDir = await mkdtemp(path.join(tmpdir(), "foorch06-restart-"));
  const port = 4880 + testInfo.parallelIndex;
  const token = `foorch06-${crypto.randomUUID()}`;
  const core: Core = { apiBase: `http://127.0.0.1:${port}`, apiToken: token };
  let child = await startHeadless(dataDir, port, token);
  try {
    await enableCodex(request, core);
    const dir = await registerProject(request, core, "Restart Progression");
    const call = (method: "get" | "post" | "put", route: string, data?: unknown) => api(request, core, method, route, data);
    const pre = await call("post", "/project-interviews/preflight", { harness: "codex", model: "gpt-6.1-sol" });
    await call("put", "/project-manager/config", { path: dir, config: { harness: "codex", model: "gpt-6.1-sol", effort: "low", consentKey: pre.isolation.consentKey } });
    const sent = await call("post", "/project-manager/messages", { path: dir, text: "Break user authentication into tasks" });
    for (let i = 0; i < 200; i++) {
      const turn = await call("get", `/project-manager/turns/${sent.turn.id}`);
      if (turn.status !== "running") break;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    const stored = (await call("get", `/project-manager?path=${encodeURIComponent(dir)}`)).proposals[0];
    await call("post", `/project-manager/proposals/${stored.id}/approve`, { path: dir, revision: stored.revision });
    const tasks = await tasksOf(request, core, dir);
    const model = tasks.find((task) => task.title === "Create the user model");
    await assignWorker(request, core, dir, tasks.map((task) => task.id));
    const plan = await call("get", `/project-manager/plans/${stored.id}?path=${encodeURIComponent(dir)}`);
    const saved = await call("put", `/project-manager/plans/${stored.id}/queue`, { path: dir, taskIds: [model.id], planKey: plan.planKey });
    const on = await call("post", `/project-manager/queues/${saved.queue.id}/auto-prepare`, { path: dir, enabled: true, revision: saved.queue.revision });
    expect(on.queue.autoPrepare).toBe(true);
    await call("post", `/project-manager/queues/${saved.queue.id}/auto-prepare`, { path: dir, enabled: true, revision: saved.queue.revision });
    await request.patch(`${core.apiBase}/tasks/${model.id}`, { headers: auth(core), data: { column: "done" } });

    await stopHeadless(child);
    child = await startHeadless(dataDir, port, token);

    const after = (await call("get", `/project-manager/plans/${stored.id}/queue?path=${encodeURIComponent(dir)}`)).queue;
    expect(after.autoPrepare).toBe(true);
    expect(after.needsReview).toBe(true);
    expect(after.progression.phase).toBe("stale");
    expect(after.progression.candidate).toMatchObject({ inQueue: false });
    expect(after.progression.candidate.executor.availability).toBe("unknown");
    expect(after.progression.changes.some((c: any) => c.kind === "state")).toBe(true);
    // The plan key the Owner reviewed before the restart is still refused.
    const refused = await request.post(`${core.apiBase}/project-manager/queues/${saved.queue.id}/next`, {
      headers: auth(core), data: { path: dir, revision: after.revision, planKey: saved.queue.planKey },
    });
    expect(refused.status()).toBe(409);
    const journal = await call("get", `/activity?eventType=queue.preparation.enabled`);
    expect((journal.events ?? journal).filter((e: any) => e.eventType === "queue.preparation.enabled")).toHaveLength(1);
    for (const task of await tasksOf(request, core, dir)) expect(await call("get", `/tasks/${task.id}/runs`)).toHaveLength(0);
  } finally {
    await stopHeadless(child);
    await rm(dataDir, { recursive: true, force: true }).catch(() => {});
  }
});
