import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test, expect, type APIRequestContext, type E2EBackend, type Page } from "./fixtures";
import { gotoApp, putPreference } from "./helpers";

/**
 * Workspaces navigation: Home, Workspaces, AI Team and Knowledge, plus Settings.
 * Analytics is a project tab. Execution plans are in Settings. Fake drivers only.
 */
test.describe.configure({ mode: "serial" });

const auth = (b: E2EBackend) => ({ authorization: `Bearer ${b.apiToken}` });

async function registerProject(request: APIRequestContext, b: E2EBackend, name: string): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), "m3-nav-"));
  const res = await request.post(`${b.apiBase}/projects`, { headers: auth(b), data: { path: dir, name } });
  expect(res.ok(), await res.text()).toBeTruthy();
  return (await res.json()).path as string;
}
async function createTask(request: APIRequestContext, b: E2EBackend, title: string, workdir: string, column: string) {
  const res = await request.post(`${b.apiBase}/tasks`, { headers: auth(b), data: { title, prompt: title, isolation: "none", workdir, column } });
  expect(res.ok(), await res.text()).toBeTruthy();
  return (await res.json()) as { id: string };
}
async function storeWorkspace(page: Page, value: unknown) {
  await page.addInitScript((stored) => { localStorage.setItem("agetor:workspace", JSON.stringify(stored)); }, value);
}
const current = (page: Page) => page.locator('[data-primary-nav][aria-current="page"]');

test("the rail is Home, Workspaces, AI Team and Knowledge, with Settings apart", async ({ page, freshBackend: backend }) => {
  await gotoApp(page, backend.bootBase);
  const rail = page.locator("[data-primary-nav]");
  await expect(rail).toHaveCount(4);
  await expect(rail).toHaveText(["Home", "Workspaces", "AI Team", "Knowledge"]);
  await expect(current(page)).toHaveAttribute("data-primary-nav", "home");
  const sidebar = page.getByTestId("project-sidebar");
  for (const id of ["workspace-projects", "workspace-all-tasks", "workspace-missions", "workspace-usage", "workspace-browser", "workspace-native-computer"]) {
    await expect(sidebar.getByTestId(id)).toHaveCount(0);
  }
  await expect(page.getByTestId("emergency-stop-button")).toBeVisible();

  const pages: [string, string, string][] = [
    ["workspace-workspaces", "workspaces", "clusters-page"],
    ["workspace-company", "team", "company-page"],
    ["workspace-knowledge", "knowledge", "section-tabs"],
    ["workspace-overview", "home", "global-overview"],
  ];
  for (const [testId, nav, landmark] of pages) {
    await page.getByTestId(testId).click();
    await expect(current(page)).toHaveAttribute("data-primary-nav", nav);
    await expect(page.getByTestId(landmark)).toBeVisible();
    await expect(page.getByTestId("emergency-stop-button")).toBeVisible();
  }

  // Settings: separate entry at the bottom of the rail, and the title-bar gear still works.
  // Settings: one entry, at the bottom of the rail and outside the seven destinations.
  await expect(page.getByRole("button", { name: "Settings", exact: true })).toHaveCount(1);
  await expect(sidebar.getByTestId("open-settings")).not.toHaveAttribute("data-primary-nav");
  await page.getByTestId("open-settings").click();
  await expect(page.getByTestId("settings-nav-general")).toBeVisible();
  await expect(page.getByTestId("settings-nav-tools")).toBeVisible();
});

test("Home shows the same attention count as the title bar, running work, projects and results", async ({ page, request, freshBackend: backend }) => {
  const dir = await registerProject(request, backend, "Orbit Shop");
  await createTask(request, backend, "Blocked on a decision", dir, "blocked");
  await createTask(request, backend, "Result to review", dir, "review");
  await createTask(request, backend, "Finished work", dir, "done");
  await createTask(request, backend, "Not started", dir, "backlog");
  await gotoApp(page, backend.bootBase);

  await expect(page.getByTestId("home-title")).toHaveText("Home");
  await expect(page.getByTestId("header-attention-badge")).toHaveText("2");
  await expect(page.getByTestId("workspace-attention-badge")).toHaveText("2");
  await expect(page.getByTestId("workspace-overview")).toHaveAccessibleName("Home, 2");
  await expect(page.getByTestId("home-attention-row")).toHaveCount(2);
  // Nothing runs: the section says so instead of inventing activity.
  await expect(page.getByTestId("home-active-empty")).toBeVisible();
  await expect(page.getByTestId("home-missions-running")).toHaveCount(0);
  await expect(page.getByTestId("overview-project")).toHaveCount(1);
  await expect(page.getByTestId("home-recent-row")).toHaveCount(2);
  await expect(page.getByTestId("home-recent")).not.toContainText("Not started");
  await expect(page.getByTestId("home-ask-head")).toBeVisible();

  // The full list is one click from Home and from the title bar; both stay under Home.
  await page.getByTestId("workspace-attention").click();
  await expect(page.getByTestId("attention-page")).toBeVisible();
  await expect(page.getByTestId("attention-row")).toHaveCount(2);
  await expect(current(page)).toHaveAttribute("data-primary-nav", "home");
  await page.getByTestId("attention-back-home").click();
  await expect(page.getByTestId("global-overview")).toBeVisible();
  await page.getByTestId("header-attention").click();
  await expect(page.getByTestId("attention-page")).toBeVisible();

  // A project shortcut opens that project's board, under Workspaces.
  await page.getByTestId("workspace-overview").click();
  await page.getByTestId("home-attention-row").filter({ hasText: "Result to review" }).getByTestId("home-attention-open").click();
  await expect(page.getByTestId("project-header-name")).toHaveText("Orbit Shop");
  await page.keyboard.press("Escape");
  await expect(page.getByTestId("project-page-board")).toHaveAttribute("aria-pressed", "true");
  await expect(page.getByTestId("project-context-project")).toHaveText("Orbit Shop");
  await page.getByTestId("workspace-overview").click();
  await page.getByTestId("overview-project").click();
  await expect(page.getByTestId("project-page-board")).toHaveAttribute("aria-pressed", "true");
  await expect(page.getByTestId("project-context-project")).toHaveText("Orbit Shop");
  await expect(current(page)).toHaveAttribute("data-primary-nav", "workspaces");
});

test("Workspaces lists spaces and a project without a space, then opens its board", async ({ page, request, freshBackend: backend }) => {
  await registerProject(request, backend, "Orbit Shop");
  const created = await request.post(`${backend.apiBase}/clusters`, { headers: auth(backend), data: { name: "Storefronts" } });
  expect(created.ok(), await created.text()).toBeTruthy();
  await gotoApp(page, backend.bootBase);

  await page.getByTestId("workspace-workspaces").click();
  await expect(page.getByTestId("clusters-page")).toBeVisible();
  await expect(page.getByTestId("clusters-create")).toBeVisible();
  await expect(page.getByTestId("cluster-card").filter({ hasText: "Storefronts" })).toBeVisible();
  await expect(page.getByTestId("cluster-unassigned-project").filter({ hasText: "Orbit Shop" })).toBeVisible();
  await page.getByTestId("cluster-open-unassigned").click();
  await expect(page.getByTestId("project-page-board")).toHaveAttribute("aria-pressed", "true");
  await expect(page.getByTestId("project-context-space")).toHaveText("No space");
  await expect(page.getByTestId("project-context-project")).toHaveText("Orbit Shop");
  await page.getByTestId("project-breadcrumb-root").click();
  await expect(page.getByTestId("clusters-page")).toBeVisible();
  await expect(page.getByTestId("cluster-unassigned-project").filter({ hasText: "Orbit Shop" })).toBeVisible();
});

test("Knowledge keeps Notes and Memory apart", async ({ page, freshBackend: backend }) => {
  await gotoApp(page, backend.bootBase);
  await page.getByTestId("workspace-knowledge").click();
  await expect(page.getByTestId("knowledge-tab-notes")).toHaveAttribute("aria-current", "page");
  await expect(page.getByTestId("knowledge-heading")).toBeVisible();
  await expect(page.getByTestId("brain-heading")).toHaveCount(0);
  await page.getByTestId("workspace-brain").click();
  await expect(page.getByTestId("brain-heading")).toBeVisible();
  await expect(page.getByTestId("knowledge-heading")).toHaveCount(0);
  await expect(current(page)).toHaveAttribute("data-primary-nav", "knowledge");
});

test("Execution plans live in Settings and keep start and review; AI Team keeps the company tabs", async ({ page, freshBackend: backend }) => {
  await gotoApp(page, backend.bootBase);
  await page.getByTestId("open-settings").click();
  await page.getByTestId("settings-nav-plans").click();
  await expect(page.getByTestId("settings-nav-plans")).toHaveAttribute("aria-current", "page");
  await expect(page.getByTestId("mission-control-page")).toBeVisible();
  await expect(page.getByTestId("missions-empty")).toBeVisible();
  const controls = page.getByTestId("mission-controls");
  await page.getByTestId("mission-jump-controls").click();
  await expect(controls).toBeVisible();
  // M4: start-a-mission and the operation review stay here; the policy and Owner confirmation moved to Settings.
  await expect(controls.getByTestId("autonomy-mission-form")).toBeVisible();
  await expect(controls.getByTestId("missions-setup-in-settings")).toBeVisible();
  for (const id of ["autonomy-control-panel", "owner-trust-panel", "self-improvement-panel"]) await expect(controls.getByTestId(id)).toHaveCount(0);
  // The empty-state note comes before the administrative panels in the document.
  expect(await page.evaluate(() => {
    const note = document.querySelector('[data-testid="missions-empty"]');
    const panels = document.querySelector('[data-testid="mission-controls"]');
    return !!note && !!panels && (note.compareDocumentPosition(panels) & Node.DOCUMENT_POSITION_FOLLOWING) !== 0;
  })).toBe(true);

  await page.keyboard.press("Escape");
  await page.getByTestId("workspace-company").click();
  await expect(page.getByTestId("company-title")).toHaveText("AI Team");
  await expect(page.getByTestId("company-page").getByRole("tab").first()).toBeVisible();
});

test("Browser and Native Computer are reached from Settings and from old stored values", async ({ page, freshBackend: backend }) => {
  await gotoApp(page, backend.bootBase);
  await page.getByTestId("open-settings").click();
  await page.getByTestId("settings-nav-tools").click();
  await page.getByTestId("settings-tools").getByTestId("workspace-browser").click();
  await expect(page.getByTestId("settings-tools")).toHaveCount(0);
  await expect(page.getByTestId("browser-title")).toBeVisible();
  // No primary destination claims a tool page; the Settings entry is the current one.
  await expect(current(page)).toHaveCount(0);
  await expect(page.getByTestId("open-settings")).toHaveAttribute("aria-current", "page");
  await page.getByTestId("workspace-native-computer").click();
  await expect(page.getByTestId("native-title")).toBeVisible();
  await page.getByTestId("tools-back-to-settings").click();
  await expect(page.getByTestId("settings-tools")).toBeVisible();
});

const STORED: { stored: unknown; nav: string | null; landmark: string }[] = [
  { stored: { scope: "all", page: "overview" }, nav: "home", landmark: "global-overview" },
  { stored: { scope: "all", page: "attention" }, nav: "home", landmark: "attention-page" },
  { stored: { scope: "all", page: "portfolio" }, nav: "workspaces", landmark: "portfolio-dashboard" },
  { stored: { scope: "all", page: "clusters" }, nav: "workspaces", landmark: "clusters-page" },
  { stored: { scope: "all", page: "projects" }, nav: "workspaces", landmark: "projects-directory" },
  { stored: { scope: "all", page: "company" }, nav: "team", landmark: "company-page" },
  { stored: { scope: "all", page: "knowledge" }, nav: "knowledge", landmark: "knowledge-heading" },
  { stored: { scope: "all", page: "brain" }, nav: "knowledge", landmark: "brain-heading" },
  { stored: { scope: "all", page: "usage" }, nav: "home", landmark: "global-overview" },
  { stored: { scope: "all", page: "missions" }, nav: "home", landmark: "mission-control-page" },
  { stored: { scope: "all", page: "browser" }, nav: null, landmark: "browser-title" },
  { stored: { scope: "all", page: "native-computer" }, nav: null, landmark: "native-title" },
  // Never valid: must fall back to Home, not to some other page.
  { stored: { scope: "all", page: "insights" }, nav: "home", landmark: "global-overview" },
];

for (const { stored, nav, landmark } of STORED) {
  test(`stored destination ${JSON.stringify(stored)} resolves to ${nav ?? "Settings tools"}`, async ({ page, backend }) => {
    await storeWorkspace(page, stored);
    await gotoApp(page, backend.bootBase);
    await expect(page.getByTestId(landmark)).toBeVisible();
    if (nav) await expect(current(page)).toHaveAttribute("data-primary-nav", nav);
    else {
      await expect(current(page)).toHaveCount(0);
      await expect(page.getByTestId("open-settings")).toHaveAttribute("aria-current", "page");
    }
  });
}

test("a stored project selection still opens that project", async ({ page, request, freshBackend: backend }) => {
  const dir = await registerProject(request, backend, "Orbit Shop");
  await storeWorkspace(page, { scope: "project", path: dir, page: "board" });
  await gotoApp(page, backend.bootBase);
  await expect(page.locator(`[data-testid="project-nav-item"][data-path="${dir}"]`)).toHaveAttribute("aria-current", "page");
  await expect(current(page)).toHaveAttribute("data-primary-nav", "workspaces");
});

test("Russian labels, and the rail at 1024 and 800 px", async ({ page, request, freshBackend: backend }) => {
  await putPreference(request, backend, "locale", "ru");
  await page.setViewportSize({ width: 1280, height: 800 });
  await gotoApp(page, backend.bootBase);
  const rail = page.locator("[data-primary-nav]");
  await expect(rail).toHaveText(["Главная", "Пространства", "AI-команда", "Знания"]);
  await expect(page.getByTestId("open-settings")).toHaveText("Настройки");
  await expect(page.getByTestId("home-title")).toHaveText("Главная");
  // No label is cut off on the expanded rail.
  const clipped = () => page.evaluate(() => Array.from(document.querySelectorAll<HTMLElement>("[data-primary-nav] span.truncate, [data-testid='open-settings'] span.truncate"))
    .filter((el) => el.scrollWidth > el.clientWidth + 1).map((el) => el.textContent));
  expect(await clipped()).toEqual([]);

  await page.getByTestId("workspace-knowledge").click();
  await expect(page.getByTestId("knowledge-tab-notes")).toHaveText("Заметки");
  await expect(page.getByTestId("workspace-brain")).toHaveText("Память");
  await page.getByTestId("open-settings").click();
  await expect(page.getByTestId("settings-nav-plans")).toHaveText("Планы выполнения");
  await page.keyboard.press("Escape");

  for (const width of [1024, 800]) {
    await page.setViewportSize({ width, height: 800 });
    await expect(rail).toHaveCount(4);
    for (const name of ["Главная", "Пространства", "AI-команда", "Знания"]) {
      await expect(page.locator(`[data-primary-nav][aria-label^="${name}"]`)).toBeVisible();
    }
    await expect(page.getByTestId("open-settings")).toBeVisible();
    await expect(current(page)).toHaveAttribute("data-primary-nav", "knowledge");
    expect(await clipped()).toEqual([]);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    await page.getByTestId("workspace-overview").focus();
    await page.keyboard.press("ArrowDown");
    await expect(page.getByTestId("workspace-workspaces")).toBeFocused();
  }
});
