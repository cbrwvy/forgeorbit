import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test, expect, type APIRequestContext, type E2EBackend, type Page } from "./fixtures";
import { Database } from "bun:sqlite";
import { gotoApp } from "./helpers";
import { clickProjectPage } from "./project-nav";

/**
 * FO-UX02-D stage 2 (variant A): one source of facts for "Needs you" and the Head of PM,
 * plain-language owner actions, shorter project headers, Manager sections with deep links,
 * board filter chips, and New task vs the Head of PM. Fake drivers only; nothing here starts
 * a run or approves anything on the Owner's behalf except where a test clicks Approve itself.
 */

test.describe.configure({ mode: "serial" });
test.use({
  backendEnv: {
    AGETOR_CODEX_DRIVER: "fake",
    AGETOR_CODEX_BIN: "/bin/echo",
    AGETOR_FAKE_MANAGER_DELAY_MS: "200",
    AGETOR_FAKE_PORTFOLIO_DELAY_MS: "200",
  },
});

const auth = (b: E2EBackend) => ({ authorization: `Bearer ${b.apiToken}` });

async function enableCodex(request: APIRequestContext, b: E2EBackend) {
  const res = await request.patch(`${b.apiBase}/harnesses/codex`, { headers: auth(b), data: { enabled: true } });
  expect(res.ok(), await res.text()).toBeTruthy();
}
async function registerProject(request: APIRequestContext, b: E2EBackend, name: string): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), `ux02d2-${name.replace(/\W+/g, "-")}-`));
  const res = await request.post(`${b.apiBase}/projects`, { headers: auth(b), data: { path: dir, name } });
  expect(res.ok(), await res.text()).toBeTruthy();
  return (await res.json()).path as string;
}
async function createTask(request: APIRequestContext, b: E2EBackend, title: string, workdir: string, column = "backlog") {
  const res = await request.post(`${b.apiBase}/tasks`, { headers: auth(b), data: { title, prompt: title, isolation: "none", workdir, column } });
  expect(res.ok(), await res.text()).toBeTruthy();
  return (await res.json()) as { id: string };
}
async function configureManager(request: APIRequestContext, b: E2EBackend, dir: string) {
  const pre = await request.post(`${b.apiBase}/project-interviews/preflight`, { headers: auth(b), data: { harness: "codex", model: "gpt-5.6-sol" } });
  expect(pre.ok(), await pre.text()).toBeTruthy();
  const consentKey = (await pre.json()).isolation.consentKey;
  const config = { harness: "codex", model: "gpt-5.6-sol", effort: "low", consentKey };
  expect((await request.put(`${b.apiBase}/project-manager/config`, { headers: auth(b), data: { path: dir, config } })).ok()).toBeTruthy();
  expect((await request.put(`${b.apiBase}/portfolio-manager/config`, { headers: auth(b), data: { config } })).ok()).toBeTruthy();
}
async function pmTurn(request: APIRequestContext, b: E2EBackend, dir: string, text: string) {
  const sent = await request.post(`${b.apiBase}/project-manager/messages`, { headers: auth(b), data: { path: dir, text } });
  expect(sent.ok(), await sent.text()).toBeTruthy();
  const id = (await sent.json()).turn.id as string;
  await expect.poll(async () => (await (await request.get(`${b.apiBase}/project-manager/turns/${id}`, { headers: auth(b) })).json()).status, { timeout: 20_000 }).not.toBe("running");
}
const openProject = async (page: Page, dir: string, section?: string) => {
  await page.locator(`[data-testid="project-nav-item"][data-path="${dir}"]`).click();
  await expect(page.getByTestId("project-header-name")).toBeVisible();
  if (section) await clickProjectPage(page, section);
};
const orb = (page: Page) => page.getByTestId("head-pm-orb");

/** Arrange-only: a batch the Owner approved but has not started (a hold). Written the way the core would store it. */
function seedBatchHold(b: E2EBackend, projectPath: string, status: "paused" | "approved" | "stopped", title: string) {
  const db = new Database(path.join(b.dataDir, "agetor.sqlite"));
  try {
    db.exec("PRAGMA busy_timeout = 5000");
    const now = Date.now();
    db.run(`INSERT INTO project_execution_batches (id, project_path, status, data, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)`, [`hold-${now}`, projectPath, status, JSON.stringify({ title }), now, now]);
  } finally { db.close(); }
}

test("Needs you and the Head of PM state the same facts; a blocked task is never called an approval", async ({ page, request, freshBackend: b }) => {
  test.slow();
  await enableCodex(request, b);
  const dir = await registerProject(request, b, "Facts");
  const other = await registerProject(request, b, "Other");
  await configureManager(request, b, dir);
  await createTask(request, b, "Stuck migration", dir, "blocked");
  await createTask(request, b, "Result to review", dir, "review");
  await createTask(request, b, "Other blocked", other, "blocked");
  // A task that only waits for something else (backlog) is not an Owner action and must not be counted.
  await createTask(request, b, "Waits for the schema", dir, "backlog");
  seedBatchHold(b, other, "paused", "Nightly import");
  await gotoApp(page, b.bootBase);

  // Rail: 3 tasks + 1 batch on hold wait on the Owner globally.
  await expect(page.getByTestId("workspace-attention")).toHaveAccessibleName("Needs you, 4");
  await expect(orb(page)).toHaveAttribute("data-status", "needs-owner");
  await expect(page.getByTestId("head-pm-orb-dot")).toHaveText("4");
  await orb(page).click();
  await expect(page.getByTestId("head-pm-pending")).toHaveText("3 tasks need you · 1 batch on hold");
  await expect(page.getByTestId("head-pm-owner-actions")).not.toContainText("approval");
  await page.getByTestId("head-pm-close").click();

  // Current project: only that project's two tasks, and no hold (the batch belongs to the other project).
  await openProject(page, dir);
  await orb(page).click();
  await expect(page.getByTestId("head-pm-pending")).toHaveText("2 tasks need you");
  await page.getByTestId("head-pm-close").click();

  // A real approval (a pending task proposal) is added on top and named as such.
  await pmTurn(request, b, dir, "Break user authentication into tasks");
  await orb(page).click();
  await expect(page.getByTestId("head-pm-pending")).toHaveText("2 tasks need you · 1 approval waiting");
  await expect(page.getByTestId("head-pm-orb-dot")).toHaveText("3");
  await expect(page.getByTestId("workspace-overview")).toHaveAccessibleName("Home, 5");

  // One click to the page the rail points at; each group says what is asked of the Owner.
  await page.getByTestId("head-pm-open-needs-you").click();
  await expect(page.getByTestId("attention-page")).toBeVisible();
  await expect(page.getByTestId("attention-count")).toHaveText("5 waiting");
  await expect(page.getByTestId("attention-row")).toHaveCount(3);
  const review = page.locator('[data-testid="attention-row"][data-kind="review"]');
  await expect(review.getByTestId("attention-hint")).toContainText("Review it, then accept it or send it back");
  await expect(review.getByTestId("attention-open")).toHaveText("Review");
  const blocked = page.locator('[data-testid="attention-row"][data-kind="blocked"]').first();
  await expect(blocked.getByTestId("attention-hint")).toContainText("needs a decision");
  await expect(blocked.getByTestId("attention-open")).toHaveText("Open");
  await expect(page.getByTestId("attention-approval")).toHaveCount(1);
  await expect(page.getByTestId("attention-approval")).toContainText("Task proposal");
  await expect(page.getByTestId("attention-batch")).toHaveAttribute("data-status", "paused");
  await expect(page.getByTestId("attention-batch")).toContainText("Nightly import");
  await expect(page.getByTestId("attention-deps-note")).toBeVisible();
  // Resources/quotas are information (never counted) and say so; nothing says "available" about unknown data.
  await expect(page.getByTestId("attention-resources")).toBeVisible();

  // The approval row goes to the card in the Manager chat; the batch row to the Runs section of its project.
  await page.getByTestId("attention-batch-open").click();
  await expect(page.getByTestId("project-header-name")).toHaveText("Other");
  await expect(page.getByTestId("manager-tab-autonomy")).toHaveAttribute("aria-selected", "true");
  await page.getByTestId("workspace-overview").click(); await page.getByTestId("workspace-attention").click();
  await page.getByTestId("attention-approval-open").click();
  await expect(page.getByTestId("project-header-name")).toHaveText("Facts");
  await expect(page.getByTestId("manager-tab-chat")).toHaveAttribute("aria-selected", "true");
  await expect(page.getByTestId("manager-proposal")).toHaveAttribute("data-status", "pending");
});

test("project header and overview: short path with full path on hover/copy, no bare 'Unassigned', correct plurals", async ({ page, request, freshBackend: b }) => {
  const dir = await registerProject(request, b, "Header Orbit");
  await createTask(request, b, "Only task", dir, "backlog");
  await gotoApp(page, b.bootBase);
  const row = page.getByTestId("overview-project");
  await expect(row).toContainText("1 task");
  await expect(row).not.toContainText("1 tasks");
  await openProject(page, dir);
  await page.getByTestId("project-header-details-toggle").click();
  const shown = page.getByTestId("project-header-path");
  await expect(shown).toContainText("…/");
  await expect(shown).toHaveAttribute("title", dir);
  expect((await shown.textContent())!.length).toBeLessThan(dir.length);
  await expect(page.getByTestId("project-header-copy-path")).toBeVisible();
  await expect(page.getByTestId("project-cluster-unassigned")).toHaveText("Space: No space");
  await expect(page.getByText("Unassigned", { exact: true })).toHaveCount(0);
});

test("Manager has Conversation history, Plan & queue and Runs; the Head of PM links straight into them and keeps the project", async ({ page, request, freshBackend: b }) => {
  test.slow();
  await enableCodex(request, b);
  const dir = await registerProject(request, b, "Sections");
  const other = await registerProject(request, b, "Elsewhere");
  await configureManager(request, b, dir);
  await createTask(request, b, "Ready to run", dir, "ready");
  await gotoApp(page, b.bootBase);
  await openProject(page, dir, "manager");
  // The shipped label is `headPm.unified.history`; the tab kept its
  // manager-tab-chat id when 7db741f5 renamed the visible copy.
  await expect(page.getByTestId("manager-tab-chat")).toHaveText("Conversation history");
  await expect(page.getByTestId("manager-tab-plan")).toHaveText("Plan & queue");
  await expect(page.getByTestId("manager-tab-autonomy")).toHaveText("Runs");
  await page.getByTestId("manager-tab-plan").click();
  await expect(page.getByTestId("manager-plan-empty")).toBeVisible();
  await page.getByTestId("manager-plan-open-chat").click();
  await expect(page.getByTestId("manager-tab-chat")).toHaveAttribute("aria-selected", "true");

  // A proposal with several tasks → its plan is listed in Plan & queue (nothing is approved by listing it).
  await pmTurn(request, b, dir, "Break user authentication into tasks");
  await openProject(page, other); // leave the project...
  await openProject(page, dir); // ...and come back: the proposal is still there
  await orb(page).click();
  const card = page.getByTestId("head-pm-panel").getByTestId("manager-proposal");
  await expect(card).toHaveAttribute("data-status", "pending");
  // From the Head of PM card straight to the plan, same project.
  await card.getByTestId("proposal-open-plan-section").click();
  await expect(page.getByTestId("head-pm-panel")).toHaveCount(0);
  await expect(page.getByTestId("project-header-name")).toHaveText("Sections");
  await expect(page.getByTestId("manager-tab-plan")).toHaveAttribute("aria-selected", "true");
  await expect(page.getByTestId("manager-plan-entry")).toHaveCount(1);
  await expect(page.getByTestId("task-plan-body")).toBeVisible();
  // The card in the chat points at the same plan (one source, two entrances).
  await page.getByTestId("manager-tab-chat").click();
  await expect(page.getByTestId("proposal-open-plan-section").first()).toBeVisible();

  // A run proposed in the Head of PM opens the Runs section, not the top of the Manager.
  await pmTurn(request, b, dir, "Please execute the ready task");
  await page.getByTestId("project-page-overview").click();
  await orb(page).click();
  await expect(page.getByTestId("head-pm-execution-note")).toBeVisible();
  await page.getByTestId("head-pm-execution-note").getByRole("button").click();
  await expect(page.getByTestId("manager-tab-autonomy")).toHaveAttribute("aria-selected", "true");
  await expect(page.getByTestId("project-header-name")).toHaveText("Sections");
});

test("board filters: visible chips, one-click removal, Clear filters, and no overflow at 760px", async ({ page, request, freshBackend: b }) => {
  const dir = await registerProject(request, b, "Filters");
  await createTask(request, b, "Write the docs", dir, "backlog");
  await createTask(request, b, "Ship it", dir, "ready");
  for (const width of [1440, 760]) {
    await page.setViewportSize({ width, height: 800 });
    await gotoApp(page, b.bootBase);
    await openProject(page, dir, "board");
    const search = page.getByRole("textbox", { name: "Search tasks" });
    await expect(search).toHaveAttribute("placeholder", "Search tasks…");
    await expect(search).toHaveAttribute("title", /title, prompt, workdir, branch/);
    await expect(page.getByTestId("kanban-active-filters")).toHaveCount(0);
    await search.fill("docs");
    const chips = page.getByTestId("kanban-filter-chip");
    await expect(chips).toHaveCount(1);
    await expect(chips.first()).toContainText("Search tasks:");
    await expect(page.getByText("Ship it", { exact: true })).toHaveCount(0);
    await page.getByRole("button", { name: /Remove filter Search tasks/ }).click();
    await expect(page.getByTestId("kanban-active-filters")).toHaveCount(0);
    await expect(search).toHaveValue("");
    await expect(page.getByText("Ship it", { exact: true }).first()).toBeVisible();
    await search.fill("ship");
    await page.getByLabel("Filter by archive state").selectOption("all");
    await expect(chips).toHaveCount(2);
    await page.getByTestId("kanban-clear-filters").click();
    await expect(page.getByTestId("kanban-active-filters")).toHaveCount(0);
    await expect(search).toHaveValue("");
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), `no overflow at ${width}`).toBe(true);
  }
});

test("New task (⌘N or the button) takes over from the Head of PM instead of competing with it", async ({ page, freshBackend: b }) => {
  await gotoApp(page, b.bootBase, { newTaskPinned: false });
  await orb(page).click();
  await expect(page.getByTestId("head-pm-composer")).toBeFocused();
  await page.keyboard.press("Control+n");
  const sheet = page.getByRole("dialog").locator('[data-testid="new-task-panel"][data-presentation="sheet"]');
  await expect(sheet).toBeVisible();
  await expect(page.getByTestId("head-pm-panel")).toHaveCount(0);
  await expect(sheet.getByPlaceholder("Short description")).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(page.getByRole("dialog")).toHaveCount(0);
  // The orb is still there and works; the button route behaves the same.
  await orb(page).click();
  await expect(page.getByTestId("head-pm-panel")).toBeVisible();
  await page.getByTestId("header-new-task").click();
  await expect(sheet).toBeVisible();
  await expect(page.getByTestId("head-pm-panel")).toHaveCount(0);
});

test("returning: Needs you → task → back to Needs you; project → task → breadcrumb back", async ({ page, request, freshBackend: b }) => {
  test.slow();
  const dir = await registerProject(request, b, "Return");
  await createTask(request, b, "Stuck thing", dir, "blocked");
  await gotoApp(page, b.bootBase);
  await page.getByTestId("workspace-overview").click(); await page.getByTestId("workspace-attention").click();
  await expect(page.getByTestId("attention-page")).toBeVisible();
  await page.getByTestId("attention-open").click();
  const close = page.getByRole("button", { name: "Close task details" });
  await expect(close).toBeVisible();
  await close.click();
  await expect(close).toHaveCount(0);
  await expect(page.getByTestId("attention-page")).toBeVisible(); // exactly where we were
  await openProject(page, dir, "board");
  await page.getByText("Stuck thing", { exact: true }).first().click();
  await expect(page.getByRole("button", { name: "Close task details" })).toBeVisible();
  await page.getByRole("button", { name: "Close task details" }).click();
  await page.getByTestId("project-breadcrumb-root").click();
  await expect(page.getByTestId("overview-project-list")).toBeVisible();
});

test("the stage-2 surfaces fit at 760/1024/1440 in light and dark, with the Head of PM and a RunPanel", async ({ page, request, freshBackend: b }) => {
  test.slow();
  await enableCodex(request, b);
  const dir = await registerProject(request, b, "Matrix Orbit With A Fairly Long Project Name");
  await configureManager(request, b, dir);
  await createTask(request, b, "A blocked task with a rather long title that must truncate instead of overflowing the row", dir, "blocked");
  await createTask(request, b, "Review me", dir, "review");
  await pmTurn(request, b, dir, "Break user authentication into tasks");
  const fits = async (label: string) => {
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), `${label}: no horizontal overflow`).toBe(true);
  };
  for (const scheme of ["light", "dark"] as const) {
    await page.emulateMedia({ colorScheme: scheme });
    for (const width of [1440, 1024, 760]) {
      await page.setViewportSize({ width, height: 800 });
      await gotoApp(page, b.bootBase);
      const tag = `${scheme}/${width}`;
      await page.getByTestId("workspace-overview").click(); await page.getByTestId("workspace-attention").click();
      await expect(page.getByTestId("attention-row")).toHaveCount(2);
      await fits(`${tag} needs you`);
      await openProject(page, dir);
      await fits(`${tag} project header`);
      await page.getByTestId("project-page-manager").click();
      await page.getByTestId("manager-tab-plan").click();
      await expect(page.getByTestId("manager-plan-section")).toBeVisible();
      await fits(`${tag} plan & queue`);
      await orb(page).click();
      const panel = await page.getByTestId("head-pm-panel").boundingBox();
      expect(panel!.x, `${tag} panel left edge`).toBeGreaterThanOrEqual(0);
      expect(panel!.x + panel!.width, `${tag} panel right edge`).toBeLessThanOrEqual(width);
      await fits(`${tag} head of pm`);
      await page.getByTestId("head-pm-close").click();
      await page.getByTestId("project-page-board").click();
      await page.getByText("Review me", { exact: true }).first().click();
      await expect(page.getByRole("button", { name: "Close task details" })).toBeVisible();
      await fits(`${tag} run panel`);
      await page.getByRole("button", { name: "Close task details" }).click();
    }
  }
});

test("the open Head of PM never covers the project tabs, at 760/1024/1440 and with a RunPanel", async ({ page, request, freshBackend: b }) => {
  test.slow();
  const dir = await registerProject(request, b, "Placement Orbit");
  await createTask(request, b, "A card", dir, "backlog");
  for (const [width, height] of [[1440, 900], [1440, 700], [1024, 768], [760, 800], [760, 640]] as const) {
    await page.setViewportSize({ width, height });
    await gotoApp(page, b.bootBase);
    await openProject(page, dir, "board");
    const tabs = page.getByRole("group", { name: "Project pages" });
    await orb(page).click();
    const panel = (await page.getByTestId("head-pm-panel").boundingBox())!;
    const tabBox = (await tabs.boundingBox())!;
    expect(panel.y, `${width}x${height}: panel top is below the tab bar`).toBeGreaterThanOrEqual(tabBox.y + tabBox.height - 1);
    expect(panel.y + panel.height).toBeLessThanOrEqual(height);
    await page.getByTestId("head-pm-close").click();
  }
  // With a RunPanel open the panel sits left of it and still clears the tabs.
  await page.setViewportSize({ width: 1440, height: 800 });
  await gotoApp(page, b.bootBase);
  await openProject(page, dir, "board");
  await page.getByText("A card", { exact: true }).first().click();
  const run = (await page.locator("aside").last().boundingBox())!;
  await orb(page).click();
  const panel = (await page.getByTestId("head-pm-panel").boundingBox())!;
  expect(panel.x + panel.width).toBeLessThanOrEqual(run.x + 1);
});
