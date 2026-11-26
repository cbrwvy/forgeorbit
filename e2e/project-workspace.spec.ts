import { mkdtemp } from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { test, expect, type APIRequestContext, type E2EBackend, type Page } from "./fixtures";
import { gotoApp, openAllTasks } from "./helpers";

/**
 * FO-001 project workspace. Uses test-scoped headless backends (`freshBackend`,
 * each with its own SQLite under a dedicated dataDir) to ensure full test
 * isolation without cross-test or cross-spec project leakage.
 * Tasks are created through the API and rendered by the real webview.
 */

test.describe.configure({ mode: "parallel" });

function auth(backend: E2EBackend): { authorization: string } {
  return { authorization: `Bearer ${backend.apiToken}` };
}

async function registerProject(
  request: APIRequestContext,
  backend: E2EBackend,
  name: string,
): Promise<string> {
  const dir = await mkdtemp(path.join(backend.dataDir, `fo001-${name}-`));
  const res = await request.post(`${backend.apiBase}/projects`, {
    headers: auth(backend),
    data: { path: dir, name },
  });
  expect(res.ok(), `POST /projects -> ${res.status()}: ${await res.text()}`).toBeTruthy();
  return dir;
}

async function createTask(
  request: APIRequestContext,
  backend: E2EBackend,
  title: string,
  workdir: string,
  extra: Record<string, unknown> = {},
): Promise<{ id: string; column: string }> {
  const res = await request.post(`${backend.apiBase}/tasks`, {
    headers: auth(backend),
    data: { title, prompt: title, isolation: "none", workdir, ...extra },
  });
  expect(res.ok(), `POST /tasks -> ${res.status()}: ${await res.text()}`).toBeTruthy();
  return (await res.json()) as { id: string; column: string };
}

async function listTasks(
  request: APIRequestContext,
  backend: E2EBackend,
): Promise<{ id: string; column: string; title: string }[]> {
  const res = await request.get(`${backend.apiBase}/tasks`, { headers: auth(backend) });
  expect(res.ok()).toBeTruthy();
  return (await res.json()) as { id: string; column: string; title: string }[];
}

async function deleteProject(request: APIRequestContext, backend: E2EBackend, projectPath: string): Promise<void> {
  const res = await request.delete(`${backend.apiBase}/projects`, {
    headers: auth(backend),
    data: { path: projectPath },
  });
  expect(res.status()).toBe(204);
}

function projectButton(page: Page, projectPath: string) {
  return page.locator(`[data-testid="project-nav-item"][data-path="${projectPath}"]`);
}

function taskCard(page: Page, title: string) {
  return page.getByRole("button", { name: title });
}

// UX02-A (docs/design/fo-ux01-audit.md P0-1): the overview's sections are
// `overflow-hidden` flex children of a scrolling column; without `shrink-0`
// they were squeezed to roughly half height (stat numbers and card bodies cut).
test("project overview sections keep their full height and the page scrolls instead", async ({ page, request, freshBackend: backend }) => {
  const dir = await registerProject(request, backend, "Overview Orbit");
  for (const n of [1, 2, 3, 4, 5]) await createTask(request, backend, `overview-task-${n}`, dir);
  await page.setViewportSize({ width: 1440, height: 900 });

  await gotoApp(page, backend.bootBase);
  await projectButton(page, dir).click();
  await page.getByTestId("project-page-overview").click();
  const overview = page.getByTestId("project-overview");
  await expect(overview).toBeVisible();
  await expect(page.getByTestId("project-stat-total")).toContainText("5");
  await expect(page.getByTestId("project-recent-task")).toHaveCount(5);

  const squeezed = await overview.evaluate((root) =>
    Array.from(root.children)
      .map((el) => ({ tag: el.tagName, testId: el.getAttribute("data-testid"), client: el.clientHeight, scroll: el.scrollHeight }))
      .filter((c) => c.scroll > c.client + 1),
  );
  expect(squeezed, `children clipped by flex shrink: ${JSON.stringify(squeezed)}`).toEqual([]);

  // The column itself must be what scrolls (content taller than the viewport).
  const scrolls = await overview.evaluate((root) => root.scrollHeight > root.clientHeight);
  expect(scrolls).toBe(true);
});

// UX02-C: the project header carries a breadcrumb (Projects › project › page)
// that mirrors the selected page and leads back to the global overview.
test("project breadcrumb follows the page and returns to the global overview", async ({ page, request, freshBackend: backend }) => {
  const dir = await registerProject(request, backend, "Crumb Orbit");
  await gotoApp(page, backend.bootBase);
  await projectButton(page, dir).click();
  const crumb = page.getByTestId("project-breadcrumb");
  await expect(crumb).toContainText("Crumb Orbit");
  await expect(page.getByTestId("project-breadcrumb-page")).toHaveText("Tasks");
  await expect(page.getByTestId("project-breadcrumb-page")).toHaveAttribute("aria-current", "page");
  await page.getByTestId("project-page-overview").click();
  await expect(page.getByTestId("project-breadcrumb-page")).toHaveText("Overview");
  await page.getByTestId("project-breadcrumb-project").click();
  await expect(page.getByTestId("project-breadcrumb-page")).toHaveText("Tasks");
  await page.getByTestId("project-breadcrumb-root").click();
  await expect(page.getByTestId("clusters-page")).toBeVisible();
  await expect(page.getByTestId("project-header")).toHaveCount(0);
});

// UX02-B/C: control density changes the real control heights (32/36/40px) and
// the page rhythm together, never the 14px body text.
test("density mode resizes controls and rhythm together and keeps the body text at 14px", async ({ page, request, freshBackend: backend }) => {
  const dir = await registerProject(request, backend, "Density Orbit");
  const measure = async () => page.evaluate(() => {
    const btn = document.querySelector<HTMLElement>('[data-testid="project-new-task"]')!.getBoundingClientRect().height;
    const tab = document.querySelector<HTMLElement>('[data-testid="project-page-board"]')!.getBoundingClientRect().height;
    const root = getComputedStyle(document.documentElement);
    return { btn: Math.round(btn), tab: Math.round(tab), gap: root.getPropertyValue("--space-stack").trim(), body: getComputedStyle(document.body).fontSize };
  });
  const expected = { compact: { btn: 32, tab: 32, gap: "1rem" }, default: { btn: 32, tab: 32, gap: "1.5rem" }, comfortable: { btn: 36, tab: 36, gap: "2rem" } } as const;
  for (const density of ["compact", "default", "comfortable"] as const) {
    await gotoApp(page, backend.bootBase);
    await page.evaluate((d) => localStorage.setItem("agetor:density", d), density);
    await page.reload();
    await expect(projectButton(page, dir)).toBeVisible();
    await projectButton(page, dir).click();
    await expect(page.getByTestId("project-new-task")).toBeVisible();
    const m = await measure();
    expect({ btn: m.btn, tab: m.tab, gap: m.gap }, density).toEqual(expected[density]);
    expect(m.body, density).toBe("14px");
  }
});

test("sidebar lists projects and a project workspace filters the board", async ({ page, request, freshBackend: backend }) => {
  const alpha = await registerProject(request, backend, "Alpha Orbit");
  const beta = await registerProject(request, backend, "Beta Orbit");
  const alphaTitle = `alpha-task-${randomUUID().slice(0, 8)}`;
  const betaTitle = `beta-task-${randomUUID().slice(0, 8)}`;
  await createTask(request, backend, alphaTitle, alpha);
  await createTask(request, backend, betaTitle, beta);

  await gotoApp(page, backend.bootBase);
  await expect(page.getByTestId("global-overview")).toBeVisible();
  await expect(projectButton(page, alpha)).toContainText("Alpha Orbit");
  await expect(projectButton(page, beta)).toContainText("Beta Orbit");

  await projectButton(page, alpha).click();
  await expect(page.getByTestId("project-header-name")).toHaveText("Alpha Orbit");
  await page.getByTestId("project-page-overview").click();
  await expect(page.getByTestId("project-stat-total")).toContainText("1");
  await expect(page.getByTestId("project-stat-backlog")).toContainText("1");
  await expect(page.getByTestId("project-recent-task")).toContainText(alphaTitle);

  await page.getByTestId("project-page-board").click();
  await expect(taskCard(page, alphaTitle)).toBeVisible();
  await expect(taskCard(page, betaTitle)).toHaveCount(0);

  await projectButton(page, beta).click();
  await page.getByTestId("project-page-board").click();
  await expect(taskCard(page, betaTitle)).toBeVisible();
  await expect(taskCard(page, alphaTitle)).toHaveCount(0);
  await expect(page.getByTestId("new-task-project")).toContainText(path.basename(beta));

  await openAllTasks(page);
  await expect(page.getByTestId("all-tasks-bar")).toBeVisible();
  await expect(taskCard(page, alphaTitle)).toBeVisible();
  await expect(taskCard(page, betaTitle)).toBeVisible();

  await taskCard(page, betaTitle).click();
  await expect(page.getByRole("button", { name: "Close task panel" })).toBeVisible();
});

test("the open project and a collapsed sidebar survive a reload", async ({ page, request, freshBackend: backend }) => {
  const dir = await registerProject(request, backend, "Reload Orbit");
  await gotoApp(page, backend.bootBase);
  await projectButton(page, dir).click();
  await expect(page.getByTestId("project-header-name")).toHaveText("Reload Orbit");

  await page.reload();
  await expect(page.getByRole("button", { name: "Settings" })).toBeVisible();
  await expect(page.getByTestId("project-header-name")).toHaveText("Reload Orbit");

  await page.getByTestId("project-sidebar-toggle").click();
  await expect(page.getByTestId("project-sidebar")).toHaveAttribute("data-collapsed", "true");
  await expect.poll(async () => (await page.getByTestId("project-sidebar").boundingBox())?.width ?? 999).toBeLessThan(80);
  await page.reload();
  await expect(page.getByRole("button", { name: "Settings" })).toBeVisible();
  await expect(page.getByTestId("project-sidebar")).toHaveAttribute("data-collapsed", "true");
  await page.getByTestId("project-sidebar-toggle").click();
  await expect(page.getByTestId("project-sidebar")).toHaveAttribute("data-collapsed", "false");
});

test("a removed project returns to the overview instead of a blank workspace", async ({ page, request, freshBackend: backend }) => {
  const dir = await registerProject(request, backend, "Gone Orbit");
  await gotoApp(page, backend.bootBase);
  await projectButton(page, dir).click();
  await expect(page.getByTestId("project-header-name")).toHaveText("Gone Orbit");
  await deleteProject(request, backend, dir);
  await page.reload();
  await expect(page.getByTestId("global-overview")).toBeVisible();
  await expect(page.getByTestId("project-header-name")).toHaveCount(0);
  await expect(projectButton(page, dir)).toHaveCount(0);
});

test("a started task is not cancelled when the workspace changes", async ({ page, request, freshBackend: backend }) => {
  const dir = await registerProject(request, backend, "Live Orbit");
  const title = `live-task-${randomUUID().slice(0, 8)}`;
  const created = await createTask(request, backend, title, dir);
  const started = await request.post(`${backend.apiBase}/tasks/${created.id}/start`, { headers: auth(backend) });
  expect(started.ok(), await started.text()).toBeTruthy();

  await gotoApp(page, backend.bootBase);
  await projectButton(page, dir).click();
  await page.getByTestId("workspace-overview").click();
  await openAllTasks(page);

  const row = (await listTasks(request, backend)).find((task) => task.id === created.id);
  expect(row).toBeTruthy();
  expect(["running", "blocked", "review", "done"]).toContain(row!.column);
});

test("a pipeline parent stays on its project board", async ({ page, request, freshBackend: backend }) => {
  const dir = await registerProject(request, backend, "Pipe Orbit");
  const profile = await request.post(`${backend.apiBase}/agent-profiles`, {
    headers: auth(backend),
    data: {
      name: `Pipe Profile ${randomUUID().slice(0, 8)}`,
      harness: "claude-code",
      model: "opus-5",
      instructions: "",
      skills: [],
    },
  });
  expect(profile.ok(), await profile.text()).toBeTruthy();
  const profileId = ((await profile.json()) as { id: string }).id;
  const stepId = randomUUID();
  const pipeline = await request.post(`${backend.apiBase}/pipelines`, {
    headers: auth(backend),
    data: {
      name: `Pipe ${randomUUID().slice(0, 8)}`,
      description: "",
      maxSteps: 25,
      graph: {
        steps: [{
          id: stepId,
          name: "Do the work",
          instructions: "",
          agentProfileId: profileId,
          position: { x: 0, y: 0 },
          subagents: { profileIds: [], cap: null },
          transition: "choose",
          join: "any",
        }],
        edges: [],
        startStepId: stepId,
      },
    },
  });
  expect(pipeline.ok(), await pipeline.text()).toBeTruthy();
  const pipelineId = ((await pipeline.json()) as { id: string }).id;
  const title = `pipe-task-${randomUUID().slice(0, 8)}`;
  await createTask(request, backend, title, dir, { pipelineId });

  await gotoApp(page, backend.bootBase);
  await projectButton(page, dir).click();
  await page.getByTestId("project-page-board").click();
  await expect(taskCard(page, title)).toBeVisible();
  await taskCard(page, title).click();
  await expect(page.getByTestId("pipeline-run-view")).toBeVisible();
});

test("light and dark themes keep the sidebar readable, and a narrow window does not throw", async ({ page, request, freshBackend: backend }) => {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  const dir = await registerProject(request, backend, "Theme Orbit With A Very Long Project Name");

  await page.emulateMedia({ colorScheme: "dark" });
  await gotoApp(page, backend.bootBase);
  await expect(page.locator("html")).toHaveClass(/dark/);
  await expect(projectButton(page, dir)).toBeVisible();

  await page.emulateMedia({ colorScheme: "light" });
  await page.reload();
  await expect(page.getByRole("button", { name: "Settings" })).toBeVisible();
  await expect(page.locator("html")).not.toHaveClass(/dark/);
  await expect(projectButton(page, dir)).toBeVisible();

  const contrast = await projectButton(page, dir).evaluate((el) => {
    const color = getComputedStyle(el).color;
    const surface = getComputedStyle(el.closest("aside")!).backgroundColor;
    return { color, surface };
  });
  expect(contrast.color).not.toBe(contrast.surface);
  expect(contrast.color).not.toBe("rgba(0, 0, 0, 0)");

  await page.setViewportSize({ width: 880, height: 640 });
  await expect(page.getByTestId("project-sidebar")).toBeVisible();
  await expect(page.getByTestId("global-overview")).toBeVisible();
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth + 1);
  expect(overflow).toBe(true);
  expect(errors).toEqual([]);
});

test("a task in a project subfolder shows on that project; a look-alike sibling folder does not (FO-008D)", async ({ page, request, freshBackend: backend }) => {
  const { mkdir } = await import("node:fs/promises");
  const dir = await registerProject(request, backend, "Mono Orbit");
  await mkdir(path.join(dir, "packages", "web"), { recursive: true });
  const sibling = `${dir}-copy`;
  await mkdir(sibling, { recursive: true });
  const subTitle = `sub-${randomUUID().slice(0, 8)}`;
  const siblingTitle = `sibling-${randomUUID().slice(0, 8)}`;
  const sub = await createTask(request, backend, subTitle, path.join(dir, "packages", "web"));
  await createTask(request, backend, siblingTitle, sibling);
  const listed = (await (await request.get(`${backend.apiBase}/tasks`, { headers: auth(backend) })).json()) as any[];
  const subRow = listed.find((task) => task.id === sub.id);
  expect(subRow.ownerProjectPath).toBe(dir);
  expect(subRow.projectOwnership).toBe("subfolder");
  expect(listed.find((task) => task.title === siblingTitle).ownerProjectPath).toBeNull();

  await gotoApp(page, backend.bootBase);
  await projectButton(page, dir).click();
  await page.getByTestId("project-page-board").click();
  await expect(taskCard(page, subTitle)).toBeVisible();
  await expect(taskCard(page, siblingTitle)).toHaveCount(0);
});
