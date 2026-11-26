import { spawn, type ChildProcess } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test, expect, type APIRequestContext, type Page } from "./fixtures";
import { REPO_ROOT, isolatedCoreEnv, seedIsolatedHarnessHomes, writeFxStubBin } from "./isolated-env";
import { gotoApp } from "./helpers";
import { E2E_BASE_URL } from "../playwright.config";

/**
 * FO-ORCH04 task plan view in the Manager tab. The project manager is the
 * fake codex driver (no real CLI, no AI quota) on an isolated backend + data
 * dir. The plan is a read-only view: every test also checks that nothing was
 * started, and that the only road to a run is the existing review.
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
  const dir = await mkdtemp(path.join(tmpdir(), `foorch04-${name.replace(/\W+/g, "-")}-`));
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

test("the Owner reads a pending plan, approves it, follows readiness, and reaches a run only through the existing review", async ({ page, request, freshBackend: backend }) => {
  test.slow();
  await enableCodex(request, backend);
  const dir = await registerProject(request, backend, "Plan Orbit");
  const seen = watch(page);
  await gotoApp(page, backend.bootBase);
  await openManager(page, dir);
  await setUpAgent(page);
  await send(page, "Break user authentication into tasks");

  const proposal = page.getByTestId("manager-proposal");
  await expect(proposal).toHaveAttribute("data-status", "pending");
  await proposal.getByTestId("task-plan-toggle").click();
  const body = proposal.getByTestId("task-plan-body");
  await expect(body).toBeVisible();
  await expect(proposal.getByTestId("task-plan-goal")).toContainText("Goal:");
  await expect(proposal.getByTestId("task-plan-node")).toHaveCount(5);
  // Order is dependency order; before approval only the first task could start.
  await expect(proposal.getByTestId("task-plan-node").first().getByTestId("task-plan-node-title")).toHaveText("Create the user model");
  await expect(proposal.locator('[data-testid="task-plan-node"][data-state="ready"]')).toHaveCount(1);
  await expect(proposal.locator('[data-testid="task-plan-node"][data-state="blocked"]')).toHaveCount(4);
  await expect(proposal.locator('[data-testid="task-plan-node"][data-stage="proposed"]')).toHaveCount(5);
  expect(await tasksOf(request, backend, dir)).toEqual([]);

  // Approve: the plan re-reads and shows real tasks.
  await proposal.getByTestId("manager-proposal-approve").click();
  await expect(proposal).toHaveAttribute("data-status", "approved");
  await expect(proposal.locator('[data-testid="task-plan-node"][data-stage="created"]')).toHaveCount(5);
  await expect(proposal.locator('[data-testid="task-plan-node"][data-state="ready"]')).toHaveCount(1);
  const login = nodeByTitle(proposal.page(), "Implement user login");
  await expect(login).toHaveAttribute("data-state", "blocked");
  await expect(login.getByTestId("task-plan-reasons")).toContainText("Create the user model");
  await expect(login.getByTestId("task-plan-depends")).toContainText("Create the user model");

  // Executor recommendation: from the existing recommender, Unknown stays Unknown.
  const first = nodeByTitle(proposal.page(), "Create the user model");
  const option = first.getByTestId("executor-option").first();
  await expect(option).toBeVisible();
  await expect(option.getByTestId("executor-evidence")).not.toHaveAttribute("data-state", "verified");
  await expect(first.getByTestId("task-plan-executor")).toContainText("Unknown");
  await expect(login.getByTestId("task-plan-executor")).toHaveCount(0);
  expect(seen.starts()).toBe(0);
  expect(seen.assignments()).toBe(0);

  // A reload keeps the plan: it is derived from stored rows.
  await page.reload();
  await openManager(page, dir);
  await page.getByTestId("manager-proposal").getByTestId("task-plan-toggle").click();
  await expect(page.locator('[data-testid="task-plan-node"][data-state="ready"]')).toHaveCount(1);

  // The prerequisite becomes Done (the Owner's decision, here through the API): its dependents become ready.
  const tasks = await tasksOf(request, backend, dir);
  const model = tasks.find((task) => task.title === "Create the user model");
  const patched = await request.patch(`${backend.apiBase}/tasks/${model.id}`, { headers: auth(backend), data: { column: "done" } });
  expect(patched.ok(), await patched.text()).toBeTruthy();
  await expect(page.locator('[data-testid="task-plan-node"][data-state="completed"]')).toHaveCount(1, { timeout: 10_000 });
  await expect(page.locator('[data-testid="task-plan-node"][data-state="ready"]')).toHaveCount(2);
  await expect(nodeByTitle(page, "Add authentication tests")).toHaveAttribute("data-state", "blocked");

  // A changed plan is refreshed instead of acted on: nothing is reviewed until the Owner looks again.
  const registration = tasks.find((task) => task.title === "Implement registration");
  const staleKey = await page.getByTestId("task-plan-body").getAttribute("data-plan-key");
  const prio = await request.put(`${backend.apiBase}/project-manager/tasks/${registration.id}/scheduling`, { headers: auth(backend), data: { path: dir, priority: "critical" } });
  expect(prio.ok(), await prio.text()).toBeTruthy();
  const planId = (await (await request.get(`${backend.apiBase}/project-manager/plans?path=${encodeURIComponent(dir)}`, { headers: auth(backend) })).json()).plans[0].proposalId as string;
  const verify = await request.post(`${backend.apiBase}/project-manager/plans/${planId}/verify`, {
    headers: auth(backend), data: { path: dir, planKey: staleKey },
  });
  expect(verify.status()).toBe(409);
  expect((await verify.json()).stale).toBe(true);
  expect(seen.executions()).toBe(0);

  // The page still shows the plan read before the priority change. Reviewing a run from it is refused:
  // the plan is re-read and the Owner looks again. Nothing reaches the review or the agent.
  const review = nodeByTitle(page, "Implement registration").getByTestId("task-plan-review-run");
  await review.click();
  await expect(page.getByTestId("task-plan-stale")).toBeVisible();
  await expect(page.getByTestId("task-plan-body")).not.toHaveAttribute("data-plan-key", staleKey!);
  expect(seen.executions()).toBe(0);
  expect(seen.starts()).toBe(0);

  // After looking again, the existing supervised review opens, and it prepares and starts nothing.
  await nodeByTitle(page, "Implement registration").getByTestId("task-plan-review-run").click();
  await expect(page.getByTestId("execution-card")).toBeVisible({ timeout: 15_000 });
  expect(seen.executions()).toBe(1);
  expect(seen.starts()).toBe(0);
  const after = await tasksOf(request, backend, dir);
  expect(after.every((task) => task.runId == null)).toBe(true);
  expect((await request.get(`${backend.apiBase}/tasks/${registration.id}/runs`, { headers: auth(backend) }).then((r) => r.json())).length).toBe(0);
});

test("a rejected plan shows nothing runnable and creates nothing", async ({ page, request, freshBackend: backend }) => {
  test.slow();
  await enableCodex(request, backend);
  const dir = await registerProject(request, backend, "Rejected Orbit");
  const seen = watch(page);
  await gotoApp(page, backend.bootBase);
  await openManager(page, dir);
  await setUpAgent(page);
  await send(page, "Break user authentication into tasks");
  const proposal = page.getByTestId("manager-proposal");
  await proposal.getByTestId("task-plan-toggle").click();
  await expect(proposal.getByTestId("task-plan-node")).toHaveCount(5);
  await proposal.getByTestId("manager-proposal-reject").click();
  await proposal.getByTestId("manager-proposal-reject-confirm").click();
  await expect(proposal).toHaveAttribute("data-status", "rejected");
  await expect(proposal.getByTestId("task-plan")).toHaveCount(0);
  expect(await tasksOf(request, backend, dir)).toEqual([]);
  expect(seen.starts()).toBe(0);
  expect(seen.assignments()).toBe(0);
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

test("after a restart the plan reads the same from stored rows and still starts nothing", async ({ request }, testInfo) => {
  test.slow();
  const dataDir = await mkdtemp(path.join(tmpdir(), "foorch04-restart-"));
  const port = 4860 + testInfo.parallelIndex;
  const token = `foorch04-${crypto.randomUUID()}`;
  const core: Core = { apiBase: `http://127.0.0.1:${port}`, apiToken: token };
  let child = await startHeadless(dataDir, port, token);
  try {
    await enableCodex(request, core);
    const dir = await registerProject(request, core, "Restart Plan");
    const call = async (method: "get" | "post" | "put", route: string, data?: unknown) => {
      const res = await request[method](`${core.apiBase}${route}`, { headers: auth(core), ...(data === undefined ? {} : { data }) });
      expect(res.ok(), `${method} ${route}: ${await res.text()}`).toBeTruthy();
      return res.json();
    };
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
    const before = await call("get", `/project-manager/plans/${stored.id}?path=${encodeURIComponent(dir)}`);
    expect(before.nodes).toHaveLength(5);

    await stopHeadless(child);
    child = await startHeadless(dataDir, port, token);

    const after = await call("get", `/project-manager/plans/${stored.id}?path=${encodeURIComponent(dir)}`);
    const shape = (plan: any) => plan.nodes.map((n: any) => [n.title, n.state, n.stage, n.order, n.wave, n.dependsOn.map((d: any) => d.title)]);
    expect(shape(after)).toEqual(shape(before));
    expect(after.planKey).toBe(before.planKey);
    const tasks = await tasksOf(request, core, dir);
    expect(tasks).toHaveLength(5);
    for (const task of tasks) {
      expect(task.runId).toBeNull();
      const runs = await call("get", `/tasks/${task.id}/runs`);
      expect(runs).toHaveLength(0);
    }
  } finally {
    await stopHeadless(child);
    await rm(dataDir, { recursive: true, force: true }).catch(() => {});
  }
});
