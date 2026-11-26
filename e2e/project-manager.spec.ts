import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test, expect, type APIRequestContext, type E2EBackend, type Page } from "./fixtures";
import { gotoApp, putPreference } from "./helpers";

/**
 * FO-005A project manager tab. Every agent is the fake codex driver (no real
 * CLI, no AI quota). Each test gets a fresh backend so chats, proposals and
 * tasks never leak between tests.
 */

test.describe.configure({ mode: "serial" });
test.use({
  backendEnv: {
    AGETOR_CODEX_DRIVER: "fake",
    AGETOR_CODEX_BIN: "/bin/echo",
    AGETOR_FAKE_MANAGER_DELAY_MS: "300",
  },
});

function auth(backend: E2EBackend): { authorization: string } {
  return { authorization: `Bearer ${backend.apiToken}` };
}

async function enableCodex(request: APIRequestContext, backend: E2EBackend): Promise<void> {
  const res = await request.patch(`${backend.apiBase}/harnesses/codex`, { headers: auth(backend), data: { enabled: true } });
  expect(res.ok(), await res.text()).toBeTruthy();
}

async function registerProject(
  request: APIRequestContext,
  backend: E2EBackend,
  name: string,
  files: Record<string, string> = {},
): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), `fo005-${name.replace(/\W+/g, "-")}-`));
  for (const [rel, text] of Object.entries(files)) {
    await mkdir(path.dirname(path.join(dir, rel)), { recursive: true });
    await writeFile(path.join(dir, rel), text);
  }
  const res = await request.post(`${backend.apiBase}/projects`, { headers: auth(backend), data: { path: dir, name } });
  expect(res.ok(), await res.text()).toBeTruthy();
  return (await res.json()).path as string;
}

async function projectTasks(request: APIRequestContext, backend: E2EBackend, dir: string): Promise<any[]> {
  const res = await request.get(`${backend.apiBase}/tasks`, { headers: auth(backend) });
  return ((await res.json()) as any[]).filter((task) => task.workdir === dir);
}

/** Counts message posts, to prove nothing reaches an agent without Send. */
function countSends(page: Page): () => number {
  let sends = 0;
  page.on("request", (req) => {
    if (req.method() === "POST" && req.url().includes("/project-manager/messages")) sends += 1;
  });
  return () => sends;
}

async function openManager(page: Page, dir: string): Promise<void> {
  await page.locator(`[data-testid="project-nav-item"][data-path="${dir}"]`).click();
  await expect(page.getByTestId("project-header-name")).toBeVisible();
  await page.getByTestId("project-page-manager").click();
  await expect(page.getByTestId("manager-page")).toBeVisible();
}

async function setUpAgent(page: Page): Promise<void> {
  // The harness list (with its CLI probes) can take a while on a busy machine.
  await expect(page.getByTestId("manager-harness")).toHaveValue("codex", { timeout: 20_000 });
  await expect(page.getByTestId("manager-isolation")).toBeVisible();
  await expect(page.getByTestId("manager-connection")).toHaveText("Confirm the agent to start");
  await expect(page.getByTestId("manager-send")).toBeDisabled();
  await page.getByTestId("manager-consent").check();
  await expect(page.getByTestId("manager-connection")).toHaveText("Ready");
}

async function send(page: Page, text: string): Promise<void> {
  await page.getByTestId("manager-composer").fill(text);
  await page.getByTestId("manager-send").click();
  await expect(page.getByTestId("manager-busy")).toBeVisible();
  await expect(page.getByTestId("manager-busy")).toHaveCount(0);
}

test("pending proposals list in Project inbox, not on the kanban board", async ({ page, request, freshBackend: backend }) => {
  await enableCodex(request, backend);
  const dir = await registerProject(request, backend, "Inbox Lane", { "docs/IDEA.md": "# Inbox\n" });
  await gotoApp(page, backend.bootBase);
  await openManager(page, dir);
  await setUpAgent(page);
  await send(page, "Break user authentication into tasks");
  await expect(page.getByTestId("manager-proposal")).toHaveAttribute("data-status", "pending");
  expect(await projectTasks(request, backend, dir)).toEqual([]);

  await page.getByTestId("manager-tab-inbox").click();
  await expect(page.getByTestId("manager-inbox-section")).toBeVisible();
  await expect(page.getByTestId("manager-inbox-entry")).toHaveCount(1);
  await expect(page.getByTestId("manager-inbox-badge")).toHaveText("1");

  await page.getByTestId("project-page-board").click();
  await expect(page.locator('[data-testid="task-card"]')).toHaveCount(0);
});

test("chat about the project, propose tasks, edit, approve into the backlog", async ({ page, request, freshBackend: backend }) => {
  // A long end-to-end flow (four turns, a reload); give it room on a busy machine.
  test.slow();
  await enableCodex(request, backend);
  const dir = await registerProject(request, backend, "Orbit Notes", {
    "docs/IDEA.md": "# Orbit Notes\n\nShared notes for teams.\n",
    "docs/PRD.md": "# PRD\n\n## Functional Requirements\n- FR-1: notes\n",
    ".env": "SECRET=1",
  });
  const sends = countSends(page);

  await gotoApp(page, backend.bootBase);
  await openManager(page, dir);
  await expect(page.getByTestId("manager-empty")).toBeVisible();
  await expect(page.getByTestId("manager-project-name")).toContainText("Orbit Notes");
  await expect(page.locator('[data-testid="manager-source"][data-source="idea"]')).toHaveAttribute("data-status", "included");
  await expect(page.locator('[data-testid="manager-source"][data-source="prd"]')).toHaveAttribute("data-status", "included");
  await setUpAgent(page);
  // Opening the tab and confirming the agent sends nothing.
  expect(sends()).toBe(0);

  await send(page, "What is this project?");
  expect(sends()).toBe(1);
  await expect(page.getByTestId("manager-reply").last()).toContainText("IDEA: docs/IDEA.md (Orbit Notes)");
  await expect(page.getByTestId("manager-reply").last()).toContainText("Backlog: 0 tasks");

  await send(page, "Break user authentication into tasks");
  const proposal = page.getByTestId("manager-proposal");
  await expect(proposal).toHaveAttribute("data-status", "pending");
  await expect(proposal.getByTestId("manager-proposal-item")).toHaveCount(5);
  // Nothing exists before approval.
  expect(await projectTasks(request, backend, dir)).toEqual([]);

  const first = proposal.locator('[data-testid="manager-proposal-item"][data-item-id="i1"]');
  await first.getByTestId("manager-item-title").fill("Create the users table");
  await first.getByTestId("manager-item-priority").selectOption("low");
  const fourth = proposal.locator('[data-testid="manager-proposal-item"][data-item-id="i4"]');
  await fourth.getByTestId("manager-item-include").uncheck();
  await expect(proposal.getByTestId("manager-proposal-summary")).toContainText("Approve adds 4 tasks");
  // An emptied criteria list blocks approval.
  const second = proposal.locator('[data-testid="manager-proposal-item"][data-item-id="i2"]');
  const criteria = await second.getByTestId("manager-item-criteria").inputValue();
  await second.getByTestId("manager-item-criteria").fill("");
  await expect(proposal.getByTestId("manager-proposal-approve")).toBeDisabled();
  await second.getByTestId("manager-item-criteria").fill(criteria);

  await proposal.getByTestId("manager-proposal-approve").dblclick();
  await expect(proposal).toHaveAttribute("data-status", "approved");
  await expect(proposal.locator('[data-testid="manager-item-result"][data-result="created"]')).toHaveCount(4);
  await expect(proposal.locator('[data-testid="manager-item-result"][data-result="skipped"]')).toHaveCount(1);
  await expect(page.getByTestId("manager-decision")).toHaveCount(1);

  const tasks = await projectTasks(request, backend, dir);
  expect(tasks.map((task) => task.title).sort()).toEqual([
    "Add authentication tests",
    "Create the users table",
    "Implement registration",
    "Implement user login",
  ]);
  for (const task of tasks) {
    expect(task.column).toBe("backlog");
    expect(task.runId).toBeNull();
    expect(task.worktreePath).toBeNull();
  }
  expect(tasks.find((task) => task.title === "Create the users table").prompt).toContain("Priority: Low");

  // The next question sees the real backlog.
  await send(page, "What should we do next?");
  await expect(page.getByTestId("manager-reply").last()).toContainText("Start with #");

  // History and proposal state survive a reload.
  await page.reload();
  await openManager(page, dir);
  await expect(page.locator('[data-testid="manager-message"][data-role="owner"]')).toHaveCount(3);
  await expect(page.getByTestId("manager-proposal")).toHaveAttribute("data-status", "approved");
  await expect(page.getByTestId("manager-connection")).toHaveText("Ready", { timeout: 20_000 });

  // Board shows the new backlog tasks.
  await page.getByTestId("project-page-board").click();
  await expect(page.getByTestId("manager-page")).toHaveCount(0);
  await expect(page.getByText("Create the users table", { exact: true })).toBeVisible();
});

test("reject, invalid reply with retry, cancel, and separate chats per project", async ({ page, request, freshBackend: backend }) => {
  test.slow();
  await enableCodex(request, backend);
  const a = await registerProject(request, backend, "Alpha");
  const b = await registerProject(request, backend, "Beta");

  await gotoApp(page, backend.bootBase);
  await openManager(page, a);
  await expect(page.locator('[data-testid="manager-source"][data-source="idea"]')).toHaveAttribute("data-status", "missing");
  await setUpAgent(page);

  await send(page, "Break login into tasks");
  const proposal = page.getByTestId("manager-proposal");
  await proposal.getByTestId("manager-proposal-reject").click();
  await proposal.getByTestId("manager-proposal-reject-confirm").click();
  await expect(proposal).toHaveAttribute("data-status", "rejected");
  await expect(page.locator('[data-testid="manager-message"][data-role="system"]').last()).toContainText("No tasks were created");
  expect(await projectTasks(request, backend, a)).toEqual([]);

  await send(page, "tasks __fake_pm_garbage__");
  await expect(page.getByTestId("manager-turn-error")).toContainText("could not be read");
  await expect(page.getByTestId("manager-retry")).toBeEnabled();
  await page.getByTestId("manager-retry").click();
  await expect(page.getByTestId("manager-turn-error")).toBeVisible();

  await page.getByTestId("manager-composer").fill("__fake_pm_slow__ hello");
  await page.getByTestId("manager-send").click();
  await expect(page.getByTestId("manager-cancel")).toBeVisible();
  await page.getByTestId("manager-cancel").click();
  await expect(page.getByTestId("manager-turn-error")).toContainText("Request cancelled");
  await send(page, "What is this project?");
  await expect(page.getByTestId("manager-reply").last()).toContainText("Project Alpha.");

  await page.locator(`[data-testid="project-nav-item"][data-path="${b}"]`).click();
  await page.getByTestId("project-page-manager").click();
  await expect(page.getByTestId("manager-empty")).toBeVisible();
  // A project's consent is its own.
  await expect(page.getByTestId("manager-connection")).toHaveText("Confirm the agent to start", { timeout: 20_000 });
});

test("manager tab holds up in dark mode, reduced motion and a narrow window", async ({ page, request, freshBackend: backend }) => {
  await enableCodex(request, backend);
  const dir = await registerProject(request, backend, "Narrow");
  await putPreference(request, backend, "theme", "dark");
  await page.emulateMedia({ reducedMotion: "reduce" });
  await gotoApp(page, backend.bootBase);
  await openManager(page, dir);
  const sidebar = page.getByRole("button", { name: "Collapse project sidebar" });
  if (await sidebar.count()) await sidebar.click();
  const taskPanel = page.getByRole("button", { name: "Collapse new task panel" });
  if (await taskPanel.count()) await taskPanel.click();
  await page.setViewportSize({ width: 390, height: 760 });
  await expect(page.getByTestId("manager-composer")).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.classList.contains("dark"))).toBe(true);
  const fits = await page.getByTestId("manager-page").evaluate((node) => node.scrollWidth <= node.clientWidth + 1);
  expect(fits).toBe(true);
  // Keyboard: the composer is reachable and Cmd+Enter is the send shortcut.
  await page.getByTestId("manager-consent").check();
  await page.getByTestId("manager-composer").focus();
  await page.keyboard.type("What is this project?");
  await page.keyboard.press("Meta+Enter");
  await expect(page.getByTestId("manager-reply").last()).toContainText("Project Narrow.");
});
