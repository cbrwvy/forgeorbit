import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test, expect, type APIRequestContext, type E2EBackend, type Page } from "./fixtures";
import { gotoApp, openProjectAnalytics } from "./helpers";

/**
 * FO-FORECAST-ACTUAL01: one supervised task from a saved estimate to a recorded
 * Developer and Reviewer result, compared on the task and in Analytics. Every
 * agent is a fake driver; no provider, quota or real CLI is used. The fake
 * runs are labelled synthetic, so the comparison must show actuals beside the
 * baseline and explain why no difference is claimed.
 */

test.describe.configure({ mode: "serial", timeout: 150_000 });
test.use({
  backendEnv: {
    AGETOR_FAKE_QC_VERDICT: "PASS",
  },
});

const auth = (b: E2EBackend) => ({ authorization: `Bearer ${b.apiToken}` });

async function call<T>(request: APIRequestContext, b: E2EBackend, method: string, route: string, data?: unknown): Promise<T> {
  const response = await request.fetch(b.apiBase + route, { method, data, headers: auth(b) });
  const body = await response.text();
  expect(response.ok(), `${method} ${route}: ${body}`).toBeTruthy();
  return (body ? JSON.parse(body) : null) as T;
}

async function project(request: APIRequestContext, b: E2EBackend, name: string): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), `fa01-${name}-`));
  await writeFile(path.join(dir, "README.md"), `# ${name}\n`);
  return (await call<{ path: string }>(request, b, "POST", "/projects", { path: dir, name })).path;
}

async function backlogTask(request: APIRequestContext, b: E2EBackend, dir: string, title: string): Promise<string> {
  return (await call<{ id: string }>(request, b, "POST", "/tasks", {
    title, prompt: "Add GET /health returning ok.\n\n## Acceptance criteria\n- GET /health answers 200",
    workdir: dir, agent: "claude-code", model: "opus-5.5", isolation: "none", column: "backlog",
  })).id;
}

async function openPlan(page: Page, dir: string) {
  await page.locator(`[data-testid="project-nav-item"][data-path="${dir}"]`).click();
  await expect(page.getByTestId("project-header-name")).toBeVisible();
  await page.getByTestId("project-page-manager").click();
  await expect(page.getByTestId("manager-page")).toBeVisible();
  await page.getByTestId("manager-tab-plan").click();
  await expect(page.getByTestId("manager-plan-section")).toBeVisible();
}

/** The existing supervised steps: admit, ready, assign a worker, prepare and confirm the run. */
async function superviseRun(page: Page, request: APIRequestContext, b: E2EBackend, taskId: string, worker: string) {
  const status = async () => (await call<{ column: string }>(request, b, "GET", `/tasks/${taskId}`)).column;
  await page.getByTestId("supervised-live-admit").click();
  await expect.poll(status).toBe("inbox");
  await page.getByTestId("supervised-live-ready").click();
  await expect.poll(status).toBe("ready");
  const assignment = page.getByTestId("task-assignment-panel");
  await assignment.getByTestId("task-assignment-pick").selectOption({ label: worker });
  await assignment.getByTestId("task-assignment-save").click();
  await expect(assignment.getByTestId("task-assignment-current")).toContainText(worker);
  const execution = page.getByTestId("employee-execution");
  await execution.locator(":scope > summary").click();
  await page.getByTestId("employee-execution-harness").selectOption("claude-code");
  await page.getByTestId("employee-execution-model").fill("opus-5.5");
  await page.getByTestId("employee-execution-prepare").click();
  await expect(page.getByTestId("employee-execution-outcome")).toHaveAttribute("data-outcome", "prepared");
  await page.getByTestId("employee-execution-run").click();
  if (await page.getByTestId("employee-run-usage").count()) await page.getByTestId("employee-run-usage").getByRole("checkbox").check();
  await page.getByTestId("employee-run-confirm").click();
  await expect(page.getByTestId("employee-run-dialog")).toHaveCount(0);
  await expect.poll(status, { timeout: 40_000 }).toBe("review");
}

const revisionOf = async (scope: ReturnType<Page["locator"]>) =>
  Number(/Revision #(\d+)/.exec(await scope.innerText())?.[1]);

test("an estimate, a supervised run with Developer and Reviewer actuals, and the same comparison in Analytics", async ({ page, request, freshBackend: b }, info) => {
  const alpha = await project(request, b, "Alpha");
  const beta = await project(request, b, "Beta");
  const taskId = await backlogTask(request, b, alpha, "Add a health endpoint");
  const otherId = await backlogTask(request, b, beta, "Unrelated task");
  const writes: string[] = [];
  page.on("request", (req) => {
    if (["GET", "HEAD", "OPTIONS"].includes(req.method())) return;
    const url = new URL(req.url());
    if (url.pathname.startsWith("/preferences/") || /^\/tasks\/[^/]+\/seen$/.test(url.pathname) || url.pathname === "/projects/discover") return;
    writes.push(`${req.method()} ${url.pathname}`);
  });

  // 1. The Owner saves an estimate from the Backlog card before any work starts.
  await gotoApp(page, b.bootBase);
  await page.locator(`[data-testid="project-nav-item"][data-path="${alpha}"]`).click();
  await page.getByTestId("project-page-board").click();
  await page.getByTestId("task-estimate").click();
  const dialog = page.getByTestId("usage-task-dialog");
  const estimate = dialog.getByTestId("usage-task-estimate").filter({ visible: true });
  await expect(estimate).toContainText("Revision #");
  const ownerRevision = await revisionOf(estimate);
  expect(ownerRevision).toBeGreaterThan(0);
  await dialog.getByRole("button", { name: "Close", exact: true }).click();

  // Before any run nothing is frozen yet: no baseline, no actuals, and no invented zero.
  const before = await call<any>(request, b, "GET", `/api/usage-analytics/task?taskId=${taskId}`);
  expect(before.comparison).toMatchObject({ state: "no-baseline", absence: "not-started", baseline: null, attempts: [] });

  // 2. Supervised path through the task panel: the run settles in Review.
  await call(request, b, "POST", "/employees", { projectPath: alpha, name: "Ada", jobTitle: "Backend Engineer" });
  await page.reload();
  await openPlan(page, alpha);
  const row = page.locator(`[data-testid="goal-journey-row"][data-task-id="${taskId}"]`);
  await row.getByTestId("goal-journey-open").click();
  await superviseRun(page, request, b, taskId, "Ada");

  // 3. Independent review through the same panel, then the Owner's explicit acceptance.
  await page.getByTestId("task-qc-reviewer-harness").selectOption("claude-code");
  await page.getByTestId("task-qc-reviewer-model").fill("haiku-5.5");
  await page.getByTestId("task-qc-request").click();
  await expect.poll(async () => (await call<any>(request, b, "GET", `/tasks/${taskId}/qc`)).state.latestVerdict, { timeout: 40_000 }).toBe("PASS");
  await page.getByRole("button", { name: "Close task details", exact: true }).click();
  await row.getByTestId("goal-journey-accept").click();
  await expect.poll(async () => (await call<{ column: string }>(request, b, "GET", `/tasks/${taskId}`)).column).toBe("done");

  // The baseline is the revision frozen to the first Developer run. Assigning the worker
  // changed the plan, so Start saved a fresh revision; the Owner's earlier one stays in history.
  const frozen = await call<any>(request, b, "GET", `/api/usage-analytics/task?taskId=${taskId}`);
  const baselineId: number = frozen.comparison.baseline.estimateId;
  expect(baselineId).toBeGreaterThanOrEqual(ownerRevision);
  expect(Math.max(...frozen.revisions.map((r: any) => r.id))).toBe(baselineId);
  expect(frozen.comparison.baseline.savedAt).toBeLessThanOrEqual(frozen.comparison.baseline.boundAt);
  expect(frozen.comparison.baseline.laterRevisions).toEqual([]);

  // 4. The compact comparison on the completed task.
  const mark = writes.length;
  await row.getByTestId("goal-journey-open").click();
  const compact = page.getByTestId("task-forecast-actual");
  await compact.scrollIntoViewIfNeeded();
  const comparison = compact.getByTestId("forecast-comparison");
  await expect(comparison).toHaveAttribute("data-state", "complete");
  await expect(comparison).toHaveAttribute("data-baseline-id", String(baselineId));
  await expect(comparison.getByTestId("comparison-baseline")).toContainText(`Estimate #${baselineId}`);
  await expect(comparison.getByTestId("comparison-planned-developer")).not.toHaveText("Unknown");
  await expect(comparison.getByTestId("comparison-actual-developer")).not.toHaveText("Unknown");
  await expect(comparison.getByTestId("comparison-actual-reviewer")).not.toHaveText("Unknown");
  await expect(comparison.getByTestId("comparison-actual-runs")).toHaveText("2");
  // Fake runs are not genuine provider runs: no difference is claimed, and the page says why.
  await expect(comparison.getByTestId("comparison-delta-worker")).toContainText("Not a genuine provider run");
  await expect(comparison.getByTestId("comparison-delta-developer")).toContainText("Not a genuine provider run");
  await expect(comparison.getByTestId("comparison-not-genuine")).toBeVisible();
  await expect(comparison.getByTestId("comparison-quota")).toContainText("Unknown");
  // Both roles are attributable to their own run record.
  await comparison.getByTestId("comparison-details").locator("summary").click();
  const attempts = comparison.getByTestId("comparison-attempts").locator("li");
  await expect(attempts).toHaveCount(2);
  await expect(attempts.nth(0)).toHaveAttribute("data-role", "developer");
  await expect(attempts.nth(1)).toHaveAttribute("data-role", "reviewer");
  await expect(attempts.nth(0)).toContainText("baseline run");
  // Each attempt carries its recorded worker: the Developer's employee execution names Ada; the independent Reviewer has none recorded.
  await expect(attempts.nth(0)).toContainText("worker Ada");
  await expect(attempts.nth(1)).toContainText("worker not recorded");
  await page.screenshot({ path: info.outputPath("task-comparison.png") });

  // Compact layout: the table scrolls inside its own box; the section itself never overflows the panel.
  await page.setViewportSize({ width: 390, height: 800 });
  await compact.scrollIntoViewIfNeeded();
  expect(await compact.evaluate((el) => el.scrollWidth <= el.clientWidth + 1)).toBe(true);
  const box = await comparison.getByTestId("comparison-table").evaluate((el) => {
    const wrapper = el.parentElement!;
    return { scrolls: wrapper.scrollWidth > wrapper.clientWidth, fits: wrapper.getBoundingClientRect().right <= window.innerWidth + 1 };
  });
  expect(box).toEqual({ scrolls: true, fits: true });
  await page.screenshot({ path: info.outputPath("task-comparison-compact.png") });
  await page.setViewportSize({ width: 1280, height: 900 });

  // 5. The same task and baseline from Analytics, through the full task dialog.
  await compact.getByTestId("comparison-open-analytics").click();
  const full = page.getByTestId("usage-task-dialog");
  await expect(full.getByTestId("forecast-comparison")).toHaveAttribute("data-baseline-id", String(baselineId));
  await full.getByRole("button", { name: "Close", exact: true }).click();
  await page.getByRole("button", { name: "Close task details", exact: true }).click();
  await openProjectAnalytics(page, alpha);
  await page.getByTestId("usage-tab-analytics").click();
  const baselineLink = page.locator(`[data-testid="usage-task-baseline"][data-task-id="${taskId}"]`);
  await expect(baselineLink).toHaveAttribute("data-baseline-id", String(baselineId));
  await expect(baselineLink).toContainText(`Baseline #${baselineId}`);
  await baselineLink.click();
  await expect(page.getByTestId("usage-task-dialog").getByTestId("forecast-comparison")).toHaveAttribute("data-state", "complete");
  await page.getByTestId("usage-task-dialog").getByRole("button", { name: "Close", exact: true }).click();
  // Looking at the comparison, in the task and in Analytics, changed nothing.
  expect(writes.slice(mark)).toEqual([]);

  // 6. Tasks and projects are isolated.
  const other = await call<any>(request, b, "GET", `/api/usage-analytics/task?taskId=${otherId}`);
  expect(other.comparison.attempts).toEqual([]);
  expect(other.comparison.baseline).toBeNull();
  const mine = await call<any>(request, b, "GET", `/api/usage-analytics/task?taskId=${taskId}`);
  expect(mine.comparison.attempts.map((item: any) => item.role)).toEqual(["developer", "reviewer"]);
  expect(mine.comparison.attempts.every((item: any) => mine.actual.runs.some((run: any) => run.id === item.runId))).toBe(true);

  // 7. Changing the estimate later never changes the baseline.
  await call(request, b, "PATCH", `/tasks/${taskId}`, { column: "backlog" });
  await page.locator(`[data-testid="project-nav-item"][data-path="${alpha}"]`).click();
  await page.getByTestId("project-page-board").click();
  await page.getByTestId("task-estimate").click();
  await dialog.getByTestId("usage-task-scope").fill("Refactor authentication, concurrency and migrations. Add tests.");
  await dialog.getByTestId("usage-regenerate").click();
  await expect.poll(async () => revisionOf(estimate)).not.toBe(baselineId);
  const newer = await revisionOf(estimate);
  await dialog.getByRole("button", { name: "Close", exact: true }).click();
  await call(request, b, "PATCH", `/tasks/${taskId}`, { column: "done" });
  const after = await call<any>(request, b, "GET", `/api/usage-analytics/task?taskId=${taskId}`);
  expect(after.comparison.baseline.estimateId).toBe(baselineId);
  expect(after.comparison.baseline.laterRevisions.map((r: any) => r.id)).toContain(newer);

  // 8. Russian copy and the later-revision note.
  await call(request, b, "PUT", "/preferences/locale", { value: "ru" });
  await page.reload();
  await openProjectAnalytics(page, alpha);
  await page.getByTestId("usage-tab-analytics").click();
  await page.locator(`[data-testid="usage-task-baseline"][data-task-id="${taskId}"]`).click();
  const ru = page.getByTestId("usage-task-dialog").getByTestId("forecast-comparison");
  await expect(ru).toContainText("Прогноз и факт");
  await expect(ru.getByTestId("comparison-later")).toContainText("Более поздних версий оценки");
  await expect(ru.getByTestId("comparison-delta-worker")).toContainText("Не настоящий запуск у провайдера");
  await expect(ru.getByTestId("comparison-baseline")).toContainText(`Оценка №${baselineId}`);
});
