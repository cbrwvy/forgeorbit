import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test, expect, type APIRequestContext, type E2EBackend, type Page } from "./fixtures";
import { gotoApp, openPortfolio } from "./helpers";

/**
 * FO-010D assignment proposals. The project manager is the fake codex driver
 * (no real CLI, no AI quota). Each test has its own backend, HOME and SQLite.
 * Nothing here starts a run: every test also checks that no start, cancel or
 * model-router request was made.
 */

test.describe.configure({ mode: "serial" });
test.use({
  backendEnv: {
    AGETOR_CODEX_DRIVER: "fake",
    AGETOR_CODEX_BIN: "/bin/echo",
    AGETOR_FAKE_MANAGER_DELAY_MS: "200",
  },
});

const headers = (backend: E2EBackend) => ({ authorization: `Bearer ${backend.apiToken}` });

async function api(request: APIRequestContext, backend: E2EBackend, method: "get" | "post" | "patch", route: string, data?: unknown, expected = 200) {
  const res = await request[method](`${backend.apiBase}${route}`, { headers: headers(backend), ...(data === undefined ? {} : { data }) });
  const text = await res.text();
  expect(res.status(), `${method} ${route}: ${text}`).toBe(expected);
  return text ? JSON.parse(text) : null;
}

async function registerProject(request: APIRequestContext, backend: E2EBackend, name: string): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), `fo010d-${name.replace(/\W+/g, "-")}-`));
  await api(request, backend, "post", "/projects", { path: dir, name });
  return dir;
}

async function worker(request: APIRequestContext, backend: E2EBackend, dir: string, name: string, jobTitle = "QA Engineer") {
  return api(request, backend, "post", "/employees", { name, jobTitle, projectPath: dir }, 201);
}

async function addTask(request: APIRequestContext, backend: E2EBackend, dir: string, title: string) {
  return api(request, backend, "post", "/tasks", {
    title, prompt: `${title} prompt`, isolation: "none", workdir: dir, agent: "claude-code", taskType: "task", model: "opus", mode: "auto",
  });
}

/** Requests that could run something or ask the router. None may appear. */
function watchForbidden(page: Page): string[] {
  const seen: string[] = [];
  page.on("request", (req) => {
    const url = new URL(req.url());
    const forbidden =
      /\/tasks\/[^/]+\/(start|cancel)$/.test(url.pathname) ||
      /\/runs\//.test(url.pathname) && req.method() !== "GET" ||
      url.pathname.startsWith("/model-router") ||
      url.pathname.startsWith("/account-core") && req.method() !== "GET";
    if (forbidden) seen.push(`${req.method()} ${url.pathname}`);
  });
  return seen;
}

async function noOverflow(page: Page): Promise<boolean> {
  return page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth + 1);
}

async function openProject(page: Page, dir: string): Promise<void> {
  await page.locator(`[data-testid="project-nav-item"][data-path="${dir}"]`).click();
  await expect(page.getByTestId("project-header-name")).toBeVisible();
}

async function openCompany(page: Page): Promise<void> {
  await page.getByTestId("workspace-company").click();
  await expect(page.getByTestId("company-page")).toBeVisible();
}

const proposal = (page: Page, text?: string) => {
  const rows = page.getByTestId("assignment-proposal");
  return text ? rows.filter({ hasText: text }) : rows;
};

test("a manager suggestion is reviewed by the owner and only then assigns", async ({ page, request, freshBackend: backend }) => {
  test.slow();
  await api(request, backend, "patch", "/harnesses/codex", { enabled: true });
  const dir = await registerProject(request, backend, "Suggest");
  const ada = await worker(request, backend, dir, "Ada Review", "Technical Writer");
  const task = await addTask(request, backend, dir, "Write the release notes");
  const forbidden = watchForbidden(page);

  await gotoApp(page, backend.bootBase);
  await openProject(page, dir);
  await page.getByTestId("project-page-manager").click();
  await expect(page.getByTestId("manager-page")).toBeVisible();
  await expect(page.getByTestId("manager-harness")).toHaveValue("codex", { timeout: 20_000 });
  await page.getByTestId("manager-consent").check();
  await expect(page.getByTestId("manager-connection")).toHaveText("Ready");

  await expect(page.getByTestId("assignment-proposals-empty")).toBeVisible();
  expect((await api(request, backend, "get", `/assignment-proposals?projectPath=${encodeURIComponent(dir)}`)).proposals).toEqual([]);

  await page.getByTestId("manager-composer").fill("Please assign the open task to someone");
  await page.getByTestId("manager-send").click();
  await expect(page.getByTestId("manager-busy")).toBeVisible();
  await expect(page.getByTestId("manager-busy")).toHaveCount(0);

  // Created: visible, pending, with the reason, and not an assignment.
  const row = proposal(page);
  await expect(row).toHaveCount(1);
  await expect(row.getByTestId("assignment-proposal-task")).toHaveText("Write the release notes");
  await expect(row.getByTestId("assignment-proposal-worker")).toContainText("Ada Review");
  await expect(row.getByTestId("assignment-proposal-worker")).toContainText("Technical Writer");
  await expect(row.getByTestId("assignment-proposal-author")).toContainText("Project Manager");
  await expect(row.getByTestId("assignment-proposal-rationale")).toContainText("title fits this task");
  await expect(row.getByTestId("assignment-proposal-current")).toHaveText("No one");
  await expect(row.getByTestId("assignment-proposal-status")).toHaveText("Pending review");
  await expect(page.getByTestId("assignment-proposals-count")).toHaveText("1 pending");
  await expect(page.getByTestId("assignment-proposals-note")).toContainText("does not start a run");
  expect((await api(request, backend, "get", `/task-assignments/task?taskId=${task.id}`)).assignment).toBeNull();

  // The project's Team tab shows the same proposal.
  await page.getByTestId("project-page-team").click();
  await expect(proposal(page)).toHaveCount(1);
  await expect(page.getByTestId("assignment-proposals")).toHaveAttribute("data-scope", "project");

  // Routing is read-only; the Owner must inspect it before assignment.
  await expect(proposal(page).getByTestId("assignment-proposal-approve")).toBeDisabled();
  await proposal(page).getByTestId("pm-executor-load").click();
  await expect(proposal(page).getByTestId("pm-executor-options")).toBeVisible();
  await expect(proposal(page).getByTestId("pm-executor-options").getByTestId("executor-option")).toHaveCount(4);
  await expect(proposal(page).getByTestId("pm-executor-options").getByTestId("executor-use")).toHaveCount(0);
  expect((await api(request, backend, "get", `/task-assignments/task?taskId=${task.id}`)).assignment).toBeNull();
  await proposal(page).getByTestId("pm-executor-consent").check();
  // Keyboard: Tab to Approve and press Enter.
  const approve = proposal(page).getByTestId("assignment-proposal-approve");
  await approve.focus();
  await expect(approve).toBeFocused();
  await expect(approve).toBeEnabled();
  await page.keyboard.press("Enter");
  await expect(page.getByTestId("assignment-proposals-status")).toContainText("Nothing was started");
  await expect(page.getByTestId("assignment-proposals-empty")).toBeVisible();

  const assignment = (await api(request, backend, "get", `/task-assignments/task?taskId=${task.id}`)).assignment;
  expect(assignment).toMatchObject({ employeeId: ada.id, provenance: "owner" });

  // History keeps the decision and its audit trail.
  await page.getByTestId("assignment-proposal-history-toggle").click();
  const history = page.getByTestId("assignment-proposal-history-row");
  await expect(history).toHaveCount(1);
  await expect(history.getByTestId("assignment-proposal-status")).toHaveText("Approved");
  await history.locator("summary").click();
  await expect(history.getByTestId("assignment-proposal-events").locator("li")).toHaveCount(2);

  // Approving assigned; it did not run anything.
  expect(forbidden).toEqual([]);
  const refreshed = (await api(request, backend, "get", `/tasks/${task.id}`));
  expect(refreshed.column).not.toBe("running");
});

test("rejecting leaves the task unassigned; the Company page lists and links it", async ({ page, request, freshBackend: backend }) => {
  const alpha = await registerProject(request, backend, "Alpha");
  const beta = await registerProject(request, backend, "Beta");
  const ada = await worker(request, backend, alpha, "Ada Alpha");
  const bea = await worker(request, backend, beta, "Bea Beta");
  const a = await addTask(request, backend, alpha, "Alpha chore");
  const b = await addTask(request, backend, beta, "Beta chore");
  await api(request, backend, "post", "/assignment-proposals", { taskId: a.id, employeeId: ada.id, rationale: "Ada knows Alpha" }, 201);
  await api(request, backend, "post", "/assignment-proposals", { taskId: b.id, employeeId: bea.id, rationale: "Bea knows Beta" }, 201);
  const forbidden = watchForbidden(page);

  await gotoApp(page, backend.bootBase);
  await openCompany(page);
  await expect(page.getByTestId("assignment-proposals")).toHaveAttribute("data-scope", "company");
  await expect(proposal(page)).toHaveCount(2);
  await expect(page.getByTestId("assignment-proposals-count")).toHaveText("2 pending");
  await expect(proposal(page, "Alpha chore").getByTestId("assignment-proposal-project")).toHaveText(/Alpha/);

  await proposal(page, "Beta chore").getByTestId("assignment-proposal-reject").click();
  await expect(page.getByTestId("assignment-proposals-status")).toContainText("Nothing was assigned");
  await expect(proposal(page)).toHaveCount(1);
  expect((await api(request, backend, "get", `/task-assignments/task?taskId=${b.id}`)).assignment).toBeNull();

  await page.getByTestId("assignment-proposal-history-toggle").click();
  await expect(page.getByTestId("assignment-proposal-history-row").getByTestId("assignment-proposal-status")).toHaveText("Rejected");

  // Company → project navigation.
  await proposal(page, "Alpha chore").getByTestId("assignment-proposal-project").click();
  await expect(page.getByTestId("project-header-name")).toContainText("Alpha");
  expect(forbidden).toEqual([]);
});

test("replacing another worker needs explicit consent, by keyboard", async ({ page, request, freshBackend: backend }) => {
  const dir = await registerProject(request, backend, "Reassign");
  const ada = await worker(request, backend, dir, "Ada First");
  const bea = await worker(request, backend, dir, "Bea Second");
  const task = await addTask(request, backend, dir, "Held task");
  await api(request, backend, "post", "/task-assignments", { taskId: task.id, employeeId: ada.id }, 201);
  await api(request, backend, "post", "/assignment-proposals", { taskId: task.id, employeeId: bea.id, rationale: "Bea has spare time" }, 201);
  const forbidden = watchForbidden(page);

  await gotoApp(page, backend.bootBase);
  await openProject(page, dir);
  const row = proposal(page);
  await expect(row.getByTestId("assignment-proposal-current")).toContainText("Ada First");
  await expect(row.getByTestId("assignment-proposal-conflicts")).toContainText("explicit consent");
  const approve = row.getByTestId("assignment-proposal-approve");
  await expect(approve).toHaveText("Approve and replace");
  await expect(approve).toBeDisabled();

  const consent = row.getByTestId("assignment-proposal-consent");
  await consent.focus();
  await page.keyboard.press("Space");
  await expect(consent).toBeChecked();
  await expect(approve).toBeEnabled();
  await page.keyboard.press("Tab");
  await expect(approve).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(page.getByTestId("assignment-proposals-status")).toContainText("Nothing was started");

  const assignment = (await api(request, backend, "get", `/task-assignments/task?taskId=${task.id}`)).assignment;
  expect(assignment).toMatchObject({ employeeId: bea.id, revision: 2 });
  const events = (await api(request, backend, "get", `/task-assignments/history?taskId=${task.id}`)).events;
  expect(events.map((event: { action: string }) => event.action)).toEqual(["assigned", "reassigned"]);
  expect(forbidden).toEqual([]);
});

test("a proposal made out of date by another change is refused and shown as out of date", async ({ page, request, freshBackend: backend }) => {
  const dir = await registerProject(request, backend, "Stale");
  const ada = await worker(request, backend, dir, "Ada Stale");
  const bea = await worker(request, backend, dir, "Bea Stale");
  const task = await addTask(request, backend, dir, "Contested task");
  await api(request, backend, "post", "/assignment-proposals", { taskId: task.id, employeeId: ada.id, rationale: "Ada can do it" }, 201);
  const forbidden = watchForbidden(page);

  await gotoApp(page, backend.bootBase);
  await openProject(page, dir);
  await expect(proposal(page)).toHaveCount(1);

  // Someone assigns the task directly while the owner is still reading.
  await api(request, backend, "post", "/task-assignments", { taskId: task.id, employeeId: bea.id }, 201);

  await proposal(page).getByTestId("assignment-proposal-approve").click();
  await expect(page.getByTestId("assignment-proposals-status")).toContainText("assignment changed");
  await expect(page.getByTestId("assignment-proposals-status")).toContainText("Nothing was assigned");
  const stale = page.getByTestId("assignment-proposal-stale-list").getByTestId("assignment-proposal");
  await expect(stale).toHaveCount(1);
  await expect(stale.getByTestId("assignment-proposal-status")).toHaveText("Out of date");
  await expect(stale.getByTestId("assignment-proposal-stale-reason")).toContainText("assignment changed");
  await expect(stale.getByTestId("assignment-proposal-approve")).toHaveCount(0);
  await expect(page.getByTestId("assignment-proposals-count")).toHaveText("0 pending");

  // The direct assignment was not touched.
  expect((await api(request, backend, "get", `/task-assignments/task?taskId=${task.id}`)).assignment).toMatchObject({ employeeId: bea.id, revision: 1 });
  expect(forbidden).toEqual([]);
});

test("the Portfolio summarizes pending proposals per project and links to the project", async ({ page, request, freshBackend: backend }) => {
  const dir = await registerProject(request, backend, "Portfolio One");
  const ada = await worker(request, backend, dir, "Ada Portfolio");
  const task = await addTask(request, backend, dir, "Portfolio task");
  await api(request, backend, "post", "/assignment-proposals", { taskId: task.id, employeeId: ada.id, rationale: "Fits" }, 201);
  const forbidden = watchForbidden(page);

  await gotoApp(page, backend.bootBase);
  await openPortfolio(page);
  await expect(page.getByTestId("portfolio-proposals")).toBeVisible();
  await expect(page.getByTestId("portfolio-proposals-total")).toContainText("1 in 1 project");
  await expect(page.getByTestId("portfolio-proposals")).toContainText("Nothing is assigned or started until you approve");
  await page.getByTestId("portfolio-proposals-project").click();
  await expect(page.getByTestId("project-header-name")).toContainText("Portfolio One");
  await expect(proposal(page)).toHaveCount(1);
  // The Portfolio itself has no approve control.
  expect(forbidden).toEqual([]);
});

test("light and dark themes and four viewports keep proposals readable without overflow", async ({ page, request, freshBackend: backend }) => {
  const dir = await registerProject(request, backend, "Responsive");
  const ada = await worker(request, backend, dir, "Ada With A Rather Long Display Name For Narrow Screens", "Senior Backend Engineer With A Long Title");
  const bea = await worker(request, backend, dir, "Bea Second");
  const held = await addTask(request, backend, dir, "A task with a considerably long title that must wrap instead of overflowing the narrow phone layout");
  await api(request, backend, "post", "/task-assignments", { taskId: held.id, employeeId: bea.id }, 201);
  await api(request, backend, "post", "/assignment-proposals", {
    taskId: held.id, employeeId: ada.id,
    rationale: "A long reason that keeps going to make sure the text wraps inside the card instead of pushing the page wider than the viewport. ".repeat(3),
  }, 201);
  await gotoApp(page, backend.bootBase);
  await openProject(page, dir);
  await expect(proposal(page)).toHaveCount(1);

  for (const scheme of ["light", "dark"] as const) {
    await page.emulateMedia({ colorScheme: scheme, reducedMotion: "reduce" });
    await expect.poll(() => page.locator("html").evaluate((node) => node.classList.contains("dark"))).toBe(scheme === "dark");
    for (const width of [390, 768, 1024, 1440]) {
      await page.setViewportSize({ width, height: 900 });
      const box = await proposal(page).boundingBox();
      expect(box, `${scheme} ${width}`).not.toBeNull();
      expect(box!.x + box!.width, `${scheme} ${width}`).toBeLessThanOrEqual(width + 1);
      expect(await noOverflow(page), `${scheme} ${width}`).toBe(true);
      await expect(proposal(page).getByTestId("assignment-proposal-reject")).toBeVisible();
    }
  }
});
