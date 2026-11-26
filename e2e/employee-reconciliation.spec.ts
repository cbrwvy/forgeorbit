import { execFileSync } from "node:child_process";
import { sanitizedParentEnv } from "./isolated-env";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test, expect, type APIRequestContext, type E2EBackend, type Page } from "./fixtures";
import { gotoApp, openAllTasks } from "./helpers";

/**
 * FO-010E3 employee supervised execution. Each test has its own backend, HOME
 * and SQLite; every harness is a fake driver behind a stub binary, so no real
 * AI CLI runs. The spec proves the owner's confirmation is the only way a run
 * starts, that the run is attributed to the assigned worker, and that unknown
 * resources stay Unknown.
 */

test.describe.configure({ mode: "serial" });

const headers = (backend: E2EBackend) => ({ authorization: `Bearer ${backend.apiToken}` });

async function api(request: APIRequestContext, backend: E2EBackend, method: "get" | "post", route: string, data?: unknown, expected = 200) {
  const res = await request[method](`${backend.apiBase}${route}`, { headers: headers(backend), ...(data === undefined ? {} : { data }) });
  const text = await res.text();
  expect(res.status(), `${method} ${route}: ${text}`).toBe(expected);
  return text ? JSON.parse(text) : null;
}

async function noOverflow(page: Page): Promise<boolean> {
  return page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth + 1);
}

async function setup(request: APIRequestContext, backend: E2EBackend) {
  const dir = await mkdtemp(path.join(tmpdir(), "fo010e3-e2e-"));
  await api(request, backend, "post", "/projects", { path: dir, name: "Gate" });
  const ada = await api(request, backend, "post", "/employees", { name: "Ada Runner", jobTitle: "QA Engineer", projectPath: dir }, 201);
  const bea = await api(request, backend, "post", "/employees", { name: "Bea Runner", jobTitle: "QA Engineer", projectPath: dir }, 201);
  const task = await api(request, backend, "post", "/tasks", {
    title: "Repair the gate", prompt: "inspect the gate", isolation: "none", workdir: dir, agent: "claude-code", model: "opus", mode: "auto", column: "ready",
  });
  await api(request, backend, "post", "/task-assignments", { taskId: task.id, employeeId: ada.id }, 201);
  return { dir, ada, bea, task };
}

async function openPrepared(page: Page, backend: E2EBackend) {
  await gotoApp(page, backend.bootBase);
  await openAllTasks(page);
  await page.getByRole("button", { name: "Repair the gate" }).click();
  const section = page.getByTestId("employee-execution");
  await expect(section).toBeVisible();
  await section.locator("summary").click();
  await page.getByTestId("employee-execution-harness").selectOption("claude-code");
  await page.getByTestId("employee-execution-prepare").click();
  await expect(page.getByTestId("employee-execution-outcome")).toHaveAttribute("data-outcome", "prepared");
  return section;
}

const attemptsFor = async (request: APIRequestContext, backend: E2EBackend, taskId: string) =>
  (await api(request, backend, "get", `/employee-execution/attempts?taskId=${taskId}`)).attempts as any[];
const runsFor = (request: APIRequestContext, backend: E2EBackend, taskId: string) => api(request, backend, "get", `/tasks/${taskId}/runs`);

/** Only the fixture's temporary SQLite; no application mutation endpoint or real CLI. */
function sql(backend: E2EBackend, statement: string, params: unknown[] = []) {
  if (!backend.dataDir.includes("agetor-e2e-")) throw new Error("Expected an isolated fixture");
  execFileSync("bun", ["-e", `
    import { Database } from "bun:sqlite";
    const db = new Database(process.env.FO010E3_DB);
    db.run("PRAGMA busy_timeout = 5000");
    db.run(process.env.FO010E3_SQL, JSON.parse(process.env.FO010E3_PARAMS));
    db.close();
  `], { env: { ...sanitizedParentEnv(), FO010E3_DB: path.join(backend.dataDir, "agetor.sqlite"), FO010E3_SQL: statement, FO010E3_PARAMS: JSON.stringify(params) } });
}
async function openCard(page: Page, name = "Ada Runner", archived = false) {
  await page.getByTestId("workspace-company").click();
  await page.getByTestId("company-tab-staff").click();
  if (archived) await page.getByTestId("staff-filter-status").selectOption("archived");
  await page.getByTestId("staff-search").fill(name);
  await page.getByTestId("staff-row").filter({ hasText: name }).click();
  await expect(page.getByTestId("employee-execution-history")).toBeVisible();
}

test("fake Runtime run appears in employee history with provenance, then links to Task / Run", async ({ page, request, freshBackend: backend }) => {
  const { task, ada } = await setup(request, backend);
  await openPrepared(page, backend);
  await page.getByTestId("employee-execution-run").click();
  await page.getByTestId("employee-run-confirm").click();
  await expect(page.getByTestId("employee-run-dialog")).toHaveCount(0);
  await expect(page.getByTestId("employee-run-status").getByTestId("employee-run-phase")).toHaveAttribute("data-phase", "completed", { timeout: 20_000 });
  const [attempt] = await attemptsFor(request, backend, task.id);
  await page.keyboard.press("Escape");
  await openCard(page);
  const entry = page.getByTestId("execution-history-entry").first();
  await entry.locator("summary").click();
  await expect(entry).toContainText(attempt.assignment.id);
  await expect(entry).toContainText(attempt.runId);
  await expect(entry).toContainText("model Unknown");
  await expect(entry).toContainText("account Unknown");
  await expect(entry).toContainText("Owner approval provenance");
  await entry.getByTestId("execution-history-open-task").focus();
  await page.keyboard.press("Enter");
  await expect(page.getByTestId("runs-list")).toBeVisible();
  expect(await runsFor(request, backend, task.id)).toHaveLength(1);
  expect((await api(request, backend, "get", `/employee-execution/attempts?employeeId=${ada.id}`)).attempts).toHaveLength(1);
});

test("unknown process after a lost claim: Reconcile stays unknown, then confirms runtime completion without another launch", async ({ page, request, freshBackend: backend }) => {
  const { task } = await setup(request, backend);
  const { attempt } = await api(request, backend, "post", "/employee-execution/reviews", { taskId: task.id, harnessId: "claude-code" });
  const runId = "e3-fixture-run";
  const at = Date.now();
  sql(backend, "UPDATE employee_executions SET status='starting', approved_at=?, claimed_at=?, approval_provenance='owner', run_id=?, execution_id=? WHERE id=?", [at, at, runId, "e3-fixture-exec", attempt.id]);
  sql(backend, "INSERT INTO runs (id, task_id, agent, status, started_at) VALUES (?, ?, 'claude-code', 'running', ?)", [runId, task.id, at]);
  await openPrepared(page, backend);
  const status = page.getByTestId("employee-run-status");
  await expect(status.getByTestId("employee-run-phase")).toHaveAttribute("data-phase", "unknown-outcome");
  await expect(status.getByTestId("employee-run-process-unknown")).toContainText("does not prove");
  const starts: string[] = [];
  page.on("request", (req) => { if (/\/attempts\/[^/]+\/start$/.test(new URL(req.url()).pathname)) starts.push(req.url()); });
  await status.getByTestId("employee-run-reconcile").focus();
  await page.keyboard.press("Enter");
  await expect(status.getByTestId("employee-run-reconcile-result")).toContainText("remains unknown");
  await expect(status).toContainText(runId);
  await page.getByTestId("employee-execution-run").click();
  await expect(page.getByTestId("employee-run-dialog")).toHaveCount(0);
  await expect(page.getByTestId("employee-execution-errors")).toContainText("Reconcile Status");
  sql(backend, "UPDATE runs SET status='succeeded', ended_at=?, exit_code=0 WHERE id=?", [at + 100, runId]);
  await status.getByTestId("employee-run-reconcile").click();
  await expect(status.getByTestId("employee-run-phase")).toHaveAttribute("data-phase", "completed");
  await expect(status.getByTestId("employee-run-reconcile")).toHaveCount(0);
  expect(await runsFor(request, backend, task.id)).toHaveLength(1);
  expect(starts).toEqual([]);
});

test("long history, rename/archive, loading/error/retry, themes, four viewports and keyboard", async ({ page, request, freshBackend: backend }, testInfo) => {
  const { ada, task } = await setup(request, backend);
  await gotoApp(page, backend.bootBase);
  await openCard(page);
  await expect(page.getByTestId("execution-history-empty")).toBeVisible();
  for (let i = 0; i < 23; i++) {
    const { attempt } = await api(request, backend, "post", "/employee-execution/reviews", { taskId: task.id, harnessId: "claude-code", effort: i % 2 ? "high" : "low" });
    await api(request, backend, "post", `/employee-execution/attempts/${attempt.id}/cancel`, { revision: attempt.revision });
  }
  await page.getByTestId("execution-history-refresh").click();
  await expect(page.getByTestId("execution-history-entry")).toHaveCount(20);
  await page.getByTestId("execution-history-more").focus();
  await page.keyboard.press("Enter");
  await expect(page.getByTestId("execution-history-entry")).toHaveCount(23);
  await expect(page.getByTestId("execution-history-more")).toHaveCount(0);
  const summary = page.getByTestId("execution-history-entry").first().locator("summary");
  await summary.focus(); await page.keyboard.press("Enter");
  await expect(page.getByTestId("execution-history-status").first()).toBeVisible();
  for (const theme of ["dark", "light"] as const) {
    await page.emulateMedia({ colorScheme: theme, reducedMotion: "reduce" });
    await expect.poll(() => page.locator("html").evaluate((node) => node.classList.contains("dark"))).toBe(theme === "dark");
    for (const width of [390, 768, 1024, 1440]) {
      await page.setViewportSize({ width, height: 900 });
      expect(await noOverflow(page)).toBe(true);
      await summary.scrollIntoViewIfNeeded();
      await expect(summary).toBeInViewport();
      await page.screenshot({ path: testInfo.outputPath(`history-${theme}-${width}.png`) });
    }
  }
  // Rename, unassign and archive through the canonical APIs; snapshots survive.
  const renamed = await request.patch(`${backend.apiBase}/employees/${ada.id}`, { headers: headers(backend), data: { name: "Ada Archived" } });
  expect(renamed.ok()).toBe(true);
  await api(request, backend, "post", "/task-assignments/unassign", { taskId: task.id, expectedRevision: 1 });
  const archived = await request.delete(`${backend.apiBase}/employees/${ada.id}`, { headers: headers(backend) });
  expect(archived.ok()).toBe(true);
  await page.getByTestId("company-refresh").click();
  await expect(page.getByTestId("employee-card-name")).toHaveText("Ada Archived");
  await page.getByTestId("employee-card-back").click();
  await page.getByTestId("staff-filter-status").selectOption("archived");
  await page.getByTestId("staff-search").fill("Ada Archived");
  await page.getByTestId("staff-row").click();
  await expect(page.getByTestId("execution-history-entry")).toHaveCount(20);
  await page.getByTestId("execution-history-entry").first().locator("summary").click();
  await expect(page.getByTestId("execution-history-status").first()).toContainText("Ada Runner");

  let release!: () => void;
  const hold = new Promise<void>((resolve) => { release = resolve; });
  await page.route("**/employee-execution/attempts?employeeId=**", async (route) => {
    await hold;
    await route.fulfill({ status: 503, contentType: "application/json", body: '{"error":"history unavailable"}' });
  });
  await page.getByTestId("execution-history-refresh").click();
  await expect(page.getByTestId("execution-history-loading")).toBeVisible();
  release();
  await expect(page.getByTestId("execution-history-error")).toBeVisible();
  await page.unroute("**/employee-execution/attempts?employeeId=**");
  await page.getByTestId("execution-history-error").getByRole("button", { name: "Retry" }).click();
  await expect(page.getByTestId("execution-history-error")).toHaveCount(0);
  await expect(page.getByTestId("execution-history-entry")).toHaveCount(20);
});

test("terminal polling and unmount cleanup do not keep requesting employee status", async ({ page, request, freshBackend: backend }) => {
  await setup(request, backend);
  await openPrepared(page, backend);
  await page.getByTestId("employee-execution-run").click();
  await page.getByTestId("employee-run-confirm").click();
  await expect(page.getByTestId("employee-run-status").getByTestId("employee-run-phase")).toHaveAttribute("data-phase", "completed", { timeout: 20_000 });
  await page.clock.install();
  let reads = 0;
  page.on("request", (req) => { if (req.method() === "GET" && new URL(req.url()).pathname === "/employee-execution/attempts") reads++; });
  await page.clock.runFor(6100);
  expect(reads).toBe(0);
  await page.keyboard.press("Escape");
  await page.getByTestId("workspace-company").click();
  await page.clock.runFor(6100);
  expect(reads).toBe(0);
});

test.describe("bounded pending Runtime spawn", () => {
  test.use({ backendEnv: { AGETOR_FAKE_CLAUDE_SPAWN_DELAY_MS: "3000" } });
  test("Starting continues polling until the fake Runtime confirms completion", async ({ page, request, freshBackend: backend }) => {
    await setup(request, backend);
    await openPrepared(page, backend);
    await page.getByTestId("employee-execution-run").click();
    const response = page.waitForResponse((r) => /\/attempts\/[^/]+\/start$/.test(new URL(r.url()).pathname));
    await page.getByTestId("employee-run-confirm").click();
    expect((await (await response).json()).attempt.phase).toBe("starting");
    const phase = page.getByTestId("employee-run-status").getByTestId("employee-run-phase");
    await expect(phase).toHaveAttribute("data-phase", "starting");
    await expect(phase).toHaveAttribute("data-phase", "completed", { timeout: 20_000 });
  });
});
