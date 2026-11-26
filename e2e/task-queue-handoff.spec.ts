import { spawn, type ChildProcess } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test, expect, type APIRequestContext, type Page } from "./fixtures";
import { REPO_ROOT, isolatedCoreEnv, seedIsolatedHarnessHomes, writeFxStubBin } from "./isolated-env";
import { gotoApp } from "./helpers";
import { E2E_BASE_URL } from "../playwright.config";

/**
 * FO-ORCH07 queue-to-batch handoff inside the plan view of the Manager tab. The project manager is the
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
  const dir = await mkdtemp(path.join(tmpdir(), `foorch07-${name.replace(/\W+/g, "-")}-`));
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

const handoff = (page: Page) => page.getByTestId("task-queue-handoff");

test("the Owner hands the queue to an Execution Batch draft: nothing starts, a repeat is refused, the batch is opened in its own tab and can be cancelled", async ({ page, request, freshBackend: backend }) => {
  test.slow();
  const { dir, tasks, byTitle } = await approvePlan(page, request, backend, "Handoff Orbit");
  const seen = watch(page);
  await assignWorker(request, backend, dir, tasks.map((task) => task.id));
  const model = byTitle("Create the user model");
  await page.getByTestId("task-plan-refresh").click();
  await queue(page).getByTestId("task-queue-candidates").getByTestId("task-queue-add").click();
  await page.getByTestId("task-queue-save").click();
  await expect(progression(page)).toHaveAttribute("data-phase", "ready-to-review");

  // The queue's own save was journaled as the Owner's confirmation.
  const confirmed = await api(request, backend, "get", `/activity?eventType=queue.plan.confirmed`);
  expect((confirmed.events ?? confirmed).filter((e: any) => e.eventType === "queue.plan.confirmed")).toHaveLength(1);

  await expect(handoff(page)).toHaveAttribute("data-can-prepare", "true");
  await expect(handoff(page).getByTestId("task-queue-handoff-pick")).toBeChecked();
  await handoff(page).getByTestId("task-queue-handoff-prepare").click();
  await expect(handoff(page).getByTestId("task-queue-handoff-notice")).toBeVisible();
  const row = page.getByTestId("task-queue-batch");
  await expect(row).toHaveCount(1);
  await expect(row).toHaveAttribute("data-status", "draft");
  await expect(row.getByTestId("task-queue-batch-unapproved")).toBeVisible();
  await expect(row.getByTestId("task-queue-batch-limits")).toContainText("1 at a time");
  await expect(row.getByTestId("task-queue-batch-order")).toHaveAttribute("data-guaranteed", "true");

  // A second handoff is not offered while the queue has an open batch.
  await expect(handoff(page)).toHaveAttribute("data-can-prepare", "false");
  await expect(handoff(page).getByTestId("task-queue-handoff-prepare")).toBeDisabled();
  await expect(handoff(page).getByTestId("task-queue-handoff-reason")).toContainText("open Execution Batch");

  // Nothing started, assigned or run; exactly one handoff event.
  expect(seen.starts()).toBe(0);
  expect(seen.assignments()).toBe(0);
  expect(await api(request, backend, "get", `/tasks/${model.id}/runs`)).toHaveLength(0);
  const prepared = await api(request, backend, "get", `/activity?eventType=queue.handoff.prepared`);
  expect((prepared.events ?? prepared).filter((e: any) => e.eventType === "queue.handoff.prepared")).toHaveLength(1);

  // Approve and start live in the batch's own tab.
  await row.getByTestId("task-queue-batch-open").click();
  await expect(page.getByTestId("manager-tab-autonomy")).toHaveAttribute("aria-selected", "true");
  await page.getByTestId("manager-tab-chat").click();
  await page.getByTestId("manager-proposal").getByTestId("task-plan-toggle").click();
  await expect(page.getByTestId("task-queue-batch")).toHaveCount(1);

  // Cancel it: the tasks are free again and the handoff is offered once more.
  await page.getByTestId("task-queue-batch-cancel").click();
  await expect(page.getByTestId("task-queue-batch")).toHaveAttribute("data-status", "cancelled");
  await expect(handoff(page)).toHaveAttribute("data-can-prepare", "true");
  expect(seen.starts()).toBe(0);
});

test("a paused queue offers no handoff and says why", async ({ page, request, freshBackend: backend }) => {
  test.slow();
  const { dir, tasks } = await approvePlan(page, request, backend, "Handoff Paused");
  await assignWorker(request, backend, dir, tasks.map((task) => task.id));
  await page.getByTestId("task-plan-refresh").click();
  await queue(page).getByTestId("task-queue-candidates").getByTestId("task-queue-add").click();
  await page.getByTestId("task-queue-save").click();
  await expect(handoff(page)).toHaveAttribute("data-can-prepare", "true");
  await page.getByTestId("task-queue-pause").click();
  await expect(handoff(page)).toHaveAttribute("data-can-prepare", "false");
  await expect(handoff(page).getByTestId("task-queue-handoff-reason")).toContainText("paused");
  await expect(handoff(page).getByTestId("task-queue-handoff-prepare")).toBeDisabled();
  const paused = await api(request, backend, "get", `/activity?eventType=queue.paused`);
  expect((paused.events ?? paused).filter((e: any) => e.eventType === "queue.paused")).toHaveLength(1);
});
