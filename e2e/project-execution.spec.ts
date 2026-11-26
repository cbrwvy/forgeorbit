import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test, expect, type APIRequestContext, type E2EBackend, type Page } from "./fixtures";
import { gotoApp } from "./helpers";

/**
 * FO-005B supervised task execution from the Manager tab. Every agent is a
 * fake driver (no real CLI, no AI quota). Cursor points at a missing binary
 * to show an unavailable harness. Each test gets a fresh backend.
 */

test.describe.configure({ mode: "serial" });
test.use({
  backendEnv: {
    AGETOR_CODEX_DRIVER: "fake",
    AGETOR_CODEX_BIN: "/bin/echo",
    AGETOR_CURSOR_BIN: "/nonexistent/cursor-agent",
    AGETOR_FAKE_MANAGER_DELAY_MS: "300",
    // Keep the fake run going long enough to see "Running".
    AGETOR_FAKE_CODEX_RESOLVE_DELAY_MS: "1500",
  },
});

function auth(backend: E2EBackend): { authorization: string } {
  return { authorization: `Bearer ${backend.apiToken}` };
}

async function enable(request: APIRequestContext, backend: E2EBackend, harness: string): Promise<void> {
  const res = await request.patch(`${backend.apiBase}/harnesses/${harness}`, { headers: auth(backend), data: { enabled: true } });
  expect(res.ok(), await res.text()).toBeTruthy();
}

async function registerProject(request: APIRequestContext, backend: E2EBackend, name: string): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), `fo005b-${name.replace(/\W+/g, "-")}-`));
  await writeFile(path.join(dir, "README.md"), `# ${name}\n`);
  const res = await request.post(`${backend.apiBase}/projects`, { headers: auth(backend), data: { path: dir, name } });
  expect(res.ok(), await res.text()).toBeTruthy();
  return (await res.json()).path as string;
}

async function createTask(
  request: APIRequestContext,
  backend: E2EBackend,
  dir: string,
  fields: Record<string, unknown> = {},
): Promise<string> {
  const res = await request.post(`${backend.apiBase}/tasks`, {
    headers: auth(backend),
    data: {
      title: "Add a health endpoint",
      prompt: "Add GET /health returning ok.\n\n## Acceptance criteria\n- GET /health answers 200",
      workdir: dir,
      agent: "codex",
      model: "gpt-6.1-sol",
      isolation: "none",
      column: "backlog",
      ...fields,
    },
  });
  expect(res.ok(), await res.text()).toBeTruthy();
  return (await res.json()).id as string;
}

async function runsOf(request: APIRequestContext, backend: E2EBackend, taskId: string): Promise<any[]> {
  const res = await request.get(`${backend.apiBase}/tasks/${taskId}/runs`, { headers: auth(backend) });
  return (await res.json()) as any[];
}

async function taskOf(request: APIRequestContext, backend: E2EBackend, taskId: string): Promise<any> {
  const res = await request.get(`${backend.apiBase}/tasks/${taskId}`, { headers: auth(backend) });
  return res.json();
}

/** Counts task starts, to prove nothing starts without approval. */
function countStarts(page: Page): () => number {
  let starts = 0;
  page.on("request", (req) => {
    if (req.method() !== "POST") return;
    const url = req.url();
    if (url.includes("/project-manager/executions/") && url.endsWith("/approve")) starts += 1;
    if (/\/tasks\/[^/]+\/start$/.test(url)) starts += 1;
  });
  return () => starts;
}

async function openManager(page: Page, dir: string): Promise<void> {
  await page.locator(`[data-testid="project-nav-item"][data-path="${dir}"]`).click();
  await expect(page.getByTestId("project-header-name")).toBeVisible();
  await page.getByTestId("project-page-manager").click();
  await expect(page.getByTestId("manager-page")).toBeVisible();
}

test("prepare, edit, approve, follow and accept a supervised run", async ({ page, request, freshBackend: backend }) => {
  test.slow();
  await enable(request, backend, "codex");
  const dir = await registerProject(request, backend, "Exec Orbit");
  const other = await registerProject(request, backend, "Other Orbit");
  const taskId = await createTask(request, backend, dir);
  await createTask(request, backend, other, { title: "Someone else's task" });
  const starts = countStarts(page);

  await gotoApp(page, backend.bootBase);
  await openManager(page, dir);

  // Only this project's Backlog/Ready tasks can be picked.
  const picker = page.getByTestId("manager-execute-task");
  await expect(picker.locator("option")).toHaveCount(1);
  await expect(picker.locator("option")).toContainText("Add a health endpoint");

  await page.getByTestId("manager-execute-prepare").click();
  const card = page.getByTestId("execution-card");
  await expect(card).toHaveAttribute("data-phase", "proposed");
  await expect(card.getByTestId("execution-phase")).toHaveText("Ready to execute");
  await expect(card.getByTestId("execution-executor")).toContainText("Codex");
  await expect(card.getByTestId("execution-model")).toContainText("GPT-6.1 Sol");
  await expect(card.getByTestId("execution-workspace")).toContainText(dir);
  await expect(card.locator('[data-testid="execution-check"][data-code="codex-sandbox"]')).toBeVisible();
  await expect(card.locator('[data-testid="execution-check"][data-code="no-isolation"]')).toBeVisible();
  // Preparing started nothing.
  expect(starts()).toBe(0);
  expect(await runsOf(request, backend, taskId)).toEqual([]);

  // Edit: switch to the read-only mode. The card is re-checked and the
  // permission change is called out.
  await card.getByTestId("execution-edit").click();
  const editor = card.getByTestId("execution-editor");
  const modeSelect = editor.locator("div.space-y-1", { has: page.locator("label", { hasText: /^Mode$/ }) }).locator("select");
  await expect(modeSelect).toBeVisible({ timeout: 20_000 });
  await modeSelect.selectOption("ask");
  await editor.getByTestId("execution-editor-save").click();
  await expect(card.getByTestId("execution-editor")).toHaveCount(0);
  await expect(card.getByTestId("execution-mode")).toContainText("Read-only");
  await expect(card.locator('[data-testid="execution-check"][data-code="mode-change"]')).toBeVisible();
  await expect(card.locator('[data-testid="execution-check"][data-code="full-access"]')).toHaveCount(0);
  // Still nothing ran, and the task itself is unchanged until approval.
  expect(starts()).toBe(0);
  expect((await taskOf(request, backend, taskId)).mode).toBeNull();

  // Approve twice in a row: one run.
  const approve = card.getByTestId("execution-approve");
  await approve.dblclick();
  await expect(card).toHaveAttribute("data-phase", /running|starting/);
  await expect(card.getByTestId("execution-monitor")).toBeVisible();
  await expect(card.getByTestId("execution-run-id")).toContainText("#");
  await expect.poll(async () => (await runsOf(request, backend, taskId)).length).toBe(1);
  expect((await taskOf(request, backend, taskId)).mode).toBe("ask");

  // The run settles on the board; the card follows without a page poll of its own.
  await expect(card).toHaveAttribute("data-phase", "review", { timeout: 20_000 });
  await expect(card.getByTestId("execution-phase")).toHaveText("Needs your review");
  await expect(card.getByTestId("execution-result")).toBeVisible();
  await expect(card.getByTestId("execution-result-tests")).toContainText("No test step");
  // Finishing the process doesn't mark the task done.
  expect((await taskOf(request, backend, taskId)).column).toBe("review");

  // Open the ordinary run panel.
  await card.getByTestId("execution-open-run").click();
  const closePanel = page.getByRole("button", { name: "Close task details" });
  await expect(closePanel).toBeVisible();
  await closePanel.click();
  await expect(closePanel).toHaveCount(0);

  // Accept.
  await card.getByTestId("execution-accept").click();
  await expect(card).toHaveAttribute("data-phase", "accepted");
  expect((await taskOf(request, backend, taskId)).column).toBe("done");
  expect((await runsOf(request, backend, taskId)).length).toBe(1);

  // The link between the task and its run survives a reload.
  await page.reload();
  await openManager(page, dir);
  const reloaded = page.getByTestId("execution-card");
  await expect(reloaded).toHaveAttribute("data-phase", "accepted");
  await expect(reloaded.getByTestId("execution-run-id")).toContainText("#");
  await expect(page.getByTestId("manager-run").first()).toContainText("Accepted");
});

test("an unavailable harness blocks approval, and cancel starts nothing", async ({ page, request, freshBackend: backend }) => {
  await enable(request, backend, "cursor");
  const dir = await registerProject(request, backend, "Cursor Orbit");
  const taskId = await createTask(request, backend, dir, { agent: "cursor", model: "grok-4.7", title: "Cursor task" });
  const starts = countStarts(page);

  await gotoApp(page, backend.bootBase);
  await openManager(page, dir);
  await page.getByTestId("manager-execute-prepare").click();
  const card = page.getByTestId("execution-card");
  const problem = card.locator('[data-testid="execution-check"][data-code="harness-unavailable"]');
  await expect(problem).toBeVisible();
  await expect(problem).toHaveAttribute("data-level", "error");
  await expect(card.getByTestId("execution-approve")).toBeDisabled();

  await card.getByTestId("execution-cancel").click();
  await expect(card).toHaveAttribute("data-phase", "dismissed");
  await expect(card.getByTestId("execution-approve")).toHaveCount(0);
  expect(starts()).toBe(0);
  expect(await runsOf(request, backend, taskId)).toEqual([]);
  expect((await taskOf(request, backend, taskId)).agent).toBe("cursor");
});

test("a run suggested in the chat waits for approval and works in a narrow window", async ({ page, request, freshBackend: backend }) => {
  test.slow();
  await enable(request, backend, "codex");
  const dir = await registerProject(request, backend, "Chat Orbit");
  const taskId = await createTask(request, backend, dir, { title: "Write the changelog" });
  const starts = countStarts(page);
  await page.setViewportSize({ width: 760, height: 900 });

  await gotoApp(page, backend.bootBase);
  await openManager(page, dir);
  await expect(page.getByTestId("manager-harness")).toHaveValue("codex", { timeout: 20_000 });
  await page.getByTestId("manager-consent").check();
  await expect(page.getByTestId("manager-connection")).toHaveText("Ready");

  await page.getByTestId("manager-composer").fill("Please execute the next one __fake_pm_exec_bad__");
  await page.getByTestId("manager-send").click();
  await expect(page.getByTestId("manager-busy")).toHaveCount(0, { timeout: 20_000 });

  const card = page.getByTestId("execution-card");
  await expect(card).toHaveAttribute("data-phase", "proposed");
  await expect(card).toContainText("suggested by the manager");
  await expect(card.getByTestId("execution-title")).toHaveText("Write the changelog");
  // Names the manager made up are dropped and shown; the mode is the task's own.
  const adjusted = card.locator('[data-testid="execution-check"][data-code="suggestion-adjusted"]');
  await expect(adjusted).toHaveCount(2);
  await expect(adjusted.filter({ hasText: "ghost-harness" })).toHaveCount(1);
  await expect(adjusted.filter({ hasText: "Ghost profile" })).toHaveCount(1);
  await expect(card.getByTestId("execution-executor")).toContainText("Codex");
  expect(starts()).toBe(0);
  expect(await runsOf(request, backend, taskId)).toEqual([]);

  // Nothing overflows sideways at this width.
  const overflow = await card.evaluate((el) => el.scrollWidth - el.clientWidth);
  expect(overflow).toBeLessThanOrEqual(1);

  await card.getByTestId("execution-approve").click();
  await expect(card).toHaveAttribute("data-phase", /running|starting|review/);
  await expect.poll(async () => (await runsOf(request, backend, taskId)).length).toBe(1);
  await expect(card).toHaveAttribute("data-phase", "review", { timeout: 20_000 });

  // Request a fix: it goes to the task's own run.
  await card.getByTestId("execution-fix").click();
  await card.getByTestId("execution-fix-text").fill("Also mention the new endpoint.");
  await card.getByTestId("execution-fix-send").click();
  await expect.poll(async () => (await runsOf(request, backend, taskId)).length, { timeout: 20_000 }).toBe(2);
  await expect(card).toHaveAttribute("data-phase", "review", { timeout: 20_000 });
  await expect(card.getByTestId("execution-run-id")).toContainText("2 runs");
});
