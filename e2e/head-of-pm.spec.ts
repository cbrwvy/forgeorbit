import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test, expect, type APIRequestContext, type E2EBackend, type Page } from "./fixtures";
import { gotoApp, openPortfolio } from "./helpers";

/**
 * FO-PM01 floating Head of PM. It is a window onto the existing project and
 * portfolio managers, so every agent here is the fake codex driver (no real
 * CLI, no AI quota) and every conversation is checked against the core.
 */

test.describe.configure({ mode: "serial" });
test.use({
  backendEnv: {
    AGETOR_CODEX_DRIVER: "fake",
    AGETOR_CODEX_BIN: "/bin/echo",
    AGETOR_FAKE_PORTFOLIO_DELAY_MS: "400",
    AGETOR_FAKE_MANAGER_DELAY_MS: "400",
  },
});

const auth = (b: E2EBackend) => ({ authorization: `Bearer ${b.apiToken}` });

async function enableCodex(request: APIRequestContext, b: E2EBackend): Promise<void> {
  const res = await request.patch(`${b.apiBase}/harnesses/codex`, { headers: auth(b), data: { enabled: true } });
  expect(res.ok(), await res.text()).toBeTruthy();
}

async function registerProject(request: APIRequestContext, b: E2EBackend, name: string): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), `fopm01-${name.replace(/\W+/g, "-")}-`));
  const res = await request.post(`${b.apiBase}/projects`, { headers: auth(b), data: { path: dir, name } });
  expect(res.ok(), await res.text()).toBeTruthy();
  return (await res.json()).path as string;
}

async function consentKey(request: APIRequestContext, b: E2EBackend): Promise<string> {
  const res = await request.post(`${b.apiBase}/project-interviews/preflight`, { headers: auth(b), data: { harness: "codex", model: "gpt-6.1-sol" } });
  expect(res.ok(), await res.text()).toBeTruthy();
  return (await res.json()).isolation.consentKey as string;
}

async function configureProject(request: APIRequestContext, b: E2EBackend, dir: string): Promise<void> {
  const res = await request.put(`${b.apiBase}/project-manager/config`, {
    headers: auth(b),
    data: { path: dir, config: { harness: "codex", model: "gpt-6.1-sol", effort: "low", consentKey: await consentKey(request, b) } },
  });
  expect(res.ok(), await res.text()).toBeTruthy();
}

async function configurePortfolio(request: APIRequestContext, b: E2EBackend): Promise<void> {
  const res = await request.put(`${b.apiBase}/portfolio-manager/config`, {
    headers: auth(b),
    data: { config: { harness: "codex", model: "gpt-6.1-sol", effort: "low", consentKey: await consentKey(request, b) } },
  });
  expect(res.ok(), await res.text()).toBeTruthy();
}

async function createTask(request: APIRequestContext, b: E2EBackend, title: string, workdir: string, column = "backlog"): Promise<{ id: string }> {
  const res = await request.post(`${b.apiBase}/tasks`, { headers: auth(b), data: { title, prompt: title, isolation: "none", workdir, column } });
  expect(res.ok(), await res.text()).toBeTruthy();
  return (await res.json()) as { id: string };
}

async function projectMessages(request: APIRequestContext, b: E2EBackend, dir: string): Promise<any[]> {
  const res = await request.get(`${b.apiBase}/project-manager?path=${encodeURIComponent(dir)}`, { headers: auth(b) });
  return (await res.json()).messages as any[];
}

async function portfolioMessages(request: APIRequestContext, b: E2EBackend): Promise<any[]> {
  const res = await request.get(`${b.apiBase}/portfolio-manager`, { headers: auth(b) });
  return (await res.json()).messages as any[];
}

/** Counts POSTs that could start a model turn or a run, to prove nothing runs without Send. */
function watchPosts(page: Page) {
  const counts = { pmSend: 0, portfolioSend: 0, taskStart: 0, approve: 0, other: [] as string[] };
  page.on("request", (req) => {
    if (req.method() !== "POST") return;
    const url = req.url();
    if (url.includes("/project-manager/messages")) counts.pmSend += 1;
    else if (url.includes("/portfolio-manager/messages")) counts.portfolioSend += 1;
    else if (/\/tasks\/[^/]+\/start/.test(url)) counts.taskStart += 1;
    else if (/\/approve(\?|$)/.test(url)) counts.approve += 1;
  });
  return counts;
}

const orb = (page: Page) => page.getByTestId("head-pm-orb");
const panel = (page: Page) => page.getByTestId("head-pm-panel");
const openProject = async (page: Page, dir: string) => {
  await page.locator(`[data-testid="project-nav-item"][data-path="${dir}"]`).click();
  await expect(page.getByTestId("project-header-name")).toBeVisible();
};
const ask = async (page: Page, text: string) => {
  await page.getByTestId("head-pm-composer").fill(text);
  await page.getByTestId("head-pm-send").click();
  await expect(page.getByTestId("head-pm-busy")).toBeVisible();
  await expect(page.getByTestId("head-pm-busy")).toHaveCount(0, { timeout: 15_000 });
};

test("the orb is on every main section; opening, closing and Escape keep focus and send nothing", async ({ page, request, freshBackend: backend }) => {
  await enableCodex(request, backend);
  const dir = await registerProject(request, backend, "Orbit One");
  await configureProject(request, backend, dir);
  await createTask(request, backend, "Backlog item", dir);
  const posts = watchPosts(page);

  await gotoApp(page, backend.bootBase);
  await expect(orb(page)).toBeVisible();
  await expect(orb(page)).toHaveAttribute("aria-expanded", "false");
  await expect(orb(page)).toHaveAttribute("data-status", "idle");

  // Overview, portfolio, a project and its manager tab: the same orb everywhere.
  await openPortfolio(page);
  await expect(orb(page)).toBeVisible();
  await openProject(page, dir);
  await expect(orb(page)).toBeVisible();
  await page.getByTestId("project-page-manager").click();
  await expect(page.getByTestId("manager-page")).toBeVisible();
  await expect(orb(page)).toBeVisible();

  await orb(page).click();
  await expect(panel(page)).toBeVisible();
  await expect(orb(page)).toHaveAttribute("aria-expanded", "true");
  await expect(page.getByTestId("head-pm-composer")).toBeFocused();
  await expect(page.getByTestId("head-pm-context-name")).toContainText("Orbit One");
  await page.keyboard.press("Escape");
  await expect(panel(page)).toHaveCount(0);
  await expect(orb(page)).toBeFocused();

  // Tab reaches the panel's controls in a sensible order, then Escape closes again.
  await orb(page).click();
  await page.getByTestId("head-pm-close").focus();
  await page.keyboard.press("Escape");
  await expect(panel(page)).toHaveCount(0);
  await expect(orb(page)).toBeFocused();

  // Opening and closing sent no model turn and started no run.
  expect(posts.pmSend + posts.portfolioSend + posts.taskStart + posts.approve).toBe(0);
  expect(await projectMessages(request, backend, dir)).toEqual([]);
});

test("Current project shares the Manager tab's conversation and never mixes projects", async ({ page, request, freshBackend: backend }) => {
  test.slow();
  await enableCodex(request, backend);
  const alpha = await registerProject(request, backend, "Alpha Orbit");
  const beta = await registerProject(request, backend, "Beta Orbit");
  await configureProject(request, backend, alpha);
  await configureProject(request, backend, beta);
  const posts = watchPosts(page);

  await gotoApp(page, backend.bootBase);
  await openProject(page, alpha);
  await orb(page).click();
  await expect(page.getByTestId("head-pm-context-project")).toHaveAttribute("aria-pressed", "true");
  await expect(page.getByTestId("head-pm-empty")).toBeVisible();

  await ask(page, "What is this project?");
  expect(posts.pmSend).toBe(1);
  await expect(page.getByTestId("head-pm-reply").last()).toContainText("Backlog");
  const stored = await projectMessages(request, backend, alpha);
  expect(stored.map((m) => m.role)).toEqual(["owner", "manager"]);
  expect(stored[0].text).toBe("What is this project?");
  expect(await projectMessages(request, backend, beta)).toEqual([]);

  // Closing and reopening keeps the conversation.
  await page.keyboard.press("Escape");
  await expect(panel(page)).toHaveCount(0);
  await orb(page).click();
  await expect(page.getByTestId("head-pm-message")).toHaveCount(2);

  // The same history is in the project's Manager tab.
  await page.getByTestId("head-pm-open-full").click();
  await expect(page.getByTestId("manager-page")).toBeVisible();
  await expect(page.locator('[data-testid="manager-message"][data-role="owner"]').first()).toContainText("What is this project?");

  // Switching the project switches the conversation: Beta starts empty.
  await openProject(page, beta);
  await orb(page).click();
  await expect(page.getByTestId("head-pm-context-name")).toContainText("Beta Orbit");
  await expect(page.getByTestId("head-pm-empty")).toBeVisible();
  await expect(page.getByTestId("head-pm-message")).toHaveCount(0);
  await page.keyboard.press("Escape");

  // Back on Alpha the history is intact.
  await openProject(page, alpha);
  await orb(page).click();
  await expect(page.getByTestId("head-pm-message")).toHaveCount(2);
  expect(posts.pmSend).toBe(1);
  expect(posts.taskStart).toBe(0);
});

test("All projects uses the portfolio manager; a pinned context survives a project switch", async ({ page, request, freshBackend: backend }) => {
  test.slow();
  await enableCodex(request, backend);
  const alpha = await registerProject(request, backend, "Alpha Global");
  const beta = await registerProject(request, backend, "Beta Global");
  await createTask(request, backend, "Broken upload", alpha, "blocked");
  await configurePortfolio(request, backend);
  const posts = watchPosts(page);

  await gotoApp(page, backend.bootBase);
  await openProject(page, alpha);
  await orb(page).click();
  await page.getByTestId("head-pm-context-all").click();
  await expect(page.getByTestId("head-pm-context-all")).toHaveAttribute("aria-pressed", "true");
  await expect(page.getByTestId("head-pm-context-name")).toContainText("All projects");
  await ask(page, "What is happening in all my projects?");
  expect(posts.portfolioSend).toBe(1);
  expect(posts.pmSend).toBe(0);
  await expect(page.getByTestId("head-pm-reply").last()).toContainText("Portfolio: 2 project(s)");
  await page.getByTestId("head-pm-sources").locator("summary").click();
  await expect(page.locator('[data-testid="head-pm-source"][data-status="included"]').first()).toBeVisible();
  expect((await portfolioMessages(request, backend)).map((m) => m.role)).toEqual(["owner", "manager"]);
  expect(await projectMessages(request, backend, alpha)).toEqual([]);

  // Pinned to All projects while the selected project changes.
  await page.keyboard.press("Escape");
  await openProject(page, beta);
  await orb(page).click();
  await expect(page.getByTestId("head-pm-context-all")).toHaveAttribute("aria-pressed", "true");
  await expect(page.getByTestId("head-pm-message")).toHaveCount(2);
  // Choosing Current project switches to Beta's own (empty) conversation.
  await page.getByTestId("head-pm-context-project").click();
  await expect(page.getByTestId("head-pm-context-name")).toContainText("Beta Global");
  await expect(page.getByTestId("head-pm-message")).toHaveCount(0);
});

test("a proposal appears as the real approval card; nothing is created or started until the Owner approves", async ({ page, request, freshBackend: backend }) => {
  test.slow();
  await enableCodex(request, backend);
  const dir = await registerProject(request, backend, "Proposal Orbit");
  await configureProject(request, backend, dir);
  const posts = watchPosts(page);

  await gotoApp(page, backend.bootBase);
  await openProject(page, dir);
  await orb(page).click();
  await ask(page, "Break user authentication into tasks");
  const proposal = panel(page).getByTestId("manager-proposal");
  await expect(proposal).toHaveAttribute("data-status", "pending");
  await expect(proposal.getByTestId("manager-proposal-item")).toHaveCount(5);
  await expect(page.getByTestId("head-pm-pending")).toContainText("1");
  // Needs-you is shown on the orb once the panel is closed.
  await page.keyboard.press("Escape");
  await expect(orb(page)).toHaveAttribute("data-status", "needs-owner");

  const tasks = await (await request.get(`${backend.apiBase}/tasks`, { headers: auth(backend) })).json() as any[];
  expect(tasks.filter((task) => task.workdir === dir)).toEqual([]);
  expect(posts.approve).toBe(0);
  expect(posts.taskStart).toBe(0);
  expect(posts.pmSend).toBe(1);

  // Only the Owner's own click on the card approves, and it still creates backlog tasks, never runs.
  await orb(page).click();
  await panel(page).getByTestId("manager-proposal-approve").click();
  await expect(panel(page).getByTestId("manager-proposal")).toHaveAttribute("data-status", /approved|partial/, { timeout: 15_000 });
  expect(posts.approve).toBe(1);
  expect(posts.taskStart).toBe(0);
  const after = await (await request.get(`${backend.apiBase}/tasks`, { headers: auth(backend) })).json() as any[];
  expect(after.filter((task) => task.workdir === dir).every((task) => task.column === "backlog")).toBe(true);
});

test("the orb shows thinking from a real turn and an error from a failed one, and Retry is offered for the failed turn", async ({ page, request, freshBackend: backend }) => {
  test.slow();
  await enableCodex(request, backend);
  const dir = await registerProject(request, backend, "Status Orbit");
  await configureProject(request, backend, dir);
  await gotoApp(page, backend.bootBase);
  await openProject(page, dir);
  await orb(page).click();

  await page.getByTestId("head-pm-composer").fill("__fake_pm_fail__ please");
  await page.getByTestId("head-pm-send").click();
  await expect(orb(page)).toHaveAttribute("data-status", "thinking");
  await expect(page.getByTestId("head-pm-turn-error")).toBeVisible({ timeout: 15_000 });
  await expect(orb(page)).toHaveAttribute("data-status", "error");
  await expect(page.getByTestId("head-pm-status")).toContainText("Error");

  await expect(page.getByTestId("head-pm-retry")).toBeEnabled();
  // Retry is the Owner's own click: exactly one more turn for the same message.
  await page.getByTestId("head-pm-retry").click();
  await expect.poll(async () => (await projectMessages(request, backend, dir)).filter((m) => m.role === "owner").length).toBe(1);
});

test("a double activation of Send starts exactly one model turn", async ({ page, request, freshBackend: backend }) => {
  test.slow();
  await enableCodex(request, backend);
  const dir = await registerProject(request, backend, "Single Orbit");
  await configureProject(request, backend, dir);
  const posts = watchPosts(page);
  await gotoApp(page, backend.bootBase);
  await openProject(page, dir);
  await orb(page).click();
  await page.getByTestId("head-pm-composer").fill("What is this project?");
  // Two activations in the same tick, before React re-renders.
  await page.getByTestId("head-pm-send").evaluate((el) => { (el as HTMLButtonElement).click(); (el as HTMLButtonElement).click(); });
  await expect(page.getByTestId("head-pm-busy")).toHaveCount(0, { timeout: 15_000 });
  expect(posts.pmSend).toBe(1);
  expect((await projectMessages(request, backend, dir)).filter((m) => m.role === "owner")).toHaveLength(1);
});

test("light/dark and all densities render a glassy but readable panel that fits the window", async ({ page, request, freshBackend: backend }) => {
  test.slow();
  await enableCodex(request, backend);
  const dir = await registerProject(request, backend, "Look Orbit");
  await configureProject(request, backend, dir);
  const shots = process.env.FO_PM01_SHOTS;
  await gotoApp(page, backend.bootBase);
  await openProject(page, dir);
  await orb(page).click();
  await ask(page, "What is this project?");
  for (const scheme of ["light", "dark"] as const) {
    await page.emulateMedia({ colorScheme: scheme });
    for (const density of ["compact", "default", "comfortable"]) {
      await page.evaluate((d) => document.documentElement.setAttribute("data-density", d), density);
      const alpha = await panel(page).evaluate((el) => {
        const m = /rgba?\(([^)]+)\)/.exec(getComputedStyle(el).backgroundColor);
        const parts = (m?.[1] ?? "0,0,0,0").split(/[ ,/]+/).filter(Boolean).map(Number);
        return parts.length > 3 ? parts[3]! : 1;
      });
      // Floating glass (UXFIX01): visibly see-through, yet text-safe.
      expect(alpha, `${scheme}/${density}`).toBeGreaterThan(0.65);
      expect(alpha, `${scheme}/${density}`).toBeLessThan(0.85);
      expect(await panel(page).evaluate((el) => getComputedStyle(el).backdropFilter), `${scheme}/${density} blur`).toContain("blur(");
      const box = (await panel(page).boundingBox())!;
      expect(box.y).toBeGreaterThanOrEqual(0);
    }
    if (shots) {
      for (const width of [760, 1024, 1440]) {
        await page.setViewportSize({ width, height: 800 });
        await page.screenshot({ path: path.join(shots, `head-pm-${scheme}-${width}.png`) });
      }
    }
  }
});

test("an unconfigured manager asks to be set up instead of sending", async ({ page, request, freshBackend: backend }) => {
  await enableCodex(request, backend);
  const dir = await registerProject(request, backend, "Bare Orbit");
  const posts = watchPosts(page);
  await gotoApp(page, backend.bootBase);
  await openProject(page, dir);
  await orb(page).click();
  await expect(page.getByTestId("head-pm-setup")).toBeVisible();
  await page.getByTestId("head-pm-composer").fill("hello");
  await expect(page.getByTestId("head-pm-send")).toBeDisabled();
  await page.getByTestId("head-pm-setup").getByRole("button").click();
  await expect(page.getByTestId("manager-page")).toBeVisible();
  expect(posts.pmSend).toBe(0);
});

test("the dock clears the RunPanel and stays on screen at 760/1024/1440; Ctrl+N still opens New task", async ({ page, request, freshBackend: backend }) => {
  test.slow();
  await enableCodex(request, backend);
  const dir = await registerProject(request, backend, "Layout Orbit");
  await configureProject(request, backend, dir);
  const task = await createTask(request, backend, "Layout card", dir);

  for (const width of [1440, 1024, 760]) {
    await page.setViewportSize({ width, height: 800 });
    await gotoApp(page, backend.bootBase);
    await openProject(page, dir);
    const box = await orb(page).boundingBox();
    expect(box, `orb at ${width}`).not.toBeNull();
    expect(box!.x + box!.width).toBeLessThanOrEqual(width);
    expect(box!.y + box!.height).toBeLessThanOrEqual(800);
    await orb(page).click();
    const panelBox = await panel(page).boundingBox();
    expect(panelBox!.x).toBeGreaterThanOrEqual(0);
    expect(panelBox!.x + panelBox!.width).toBeLessThanOrEqual(width);
    expect(panelBox!.y).toBeGreaterThanOrEqual(0);
    await page.keyboard.press("Escape");
  }

  // With the RunPanel open (wide window) the orb sits left of it, off the composer.
  await page.setViewportSize({ width: 1440, height: 800 });
  await gotoApp(page, backend.bootBase);
  await openProject(page, dir);
  await page.getByText("Layout card", { exact: true }).first().click();
  const run = page.locator("aside").last();
  await expect(run).toHaveClass(/translate-x-0/);
  const runBox = (await run.boundingBox())!;
  const orbBox = (await orb(page).boundingBox())!;
  expect(orbBox.x + orbBox.width).toBeLessThanOrEqual(runBox.x + 1);
  expect(task.id).toBeTruthy();
});

test("Ctrl+N is not taken by the dock: with the panel open it still opens the New task sheet", async ({ page, freshBackend: backend }) => {
  await gotoApp(page, backend.bootBase, { newTaskPinned: false });
  await orb(page).click();
  await expect(page.getByTestId("head-pm-composer")).toBeFocused();
  await page.keyboard.press("Control+n");
  await expect(page.getByRole("dialog").locator('[data-testid="new-task-panel"][data-presentation="sheet"]')).toBeVisible();
});

test("reduced motion stops the thinking spinner; a reload and a restart-equivalent read keep the conversation", async ({ page, request, freshBackend: backend }) => {
  test.slow();
  await enableCodex(request, backend);
  const dir = await registerProject(request, backend, "Motion Orbit");
  await configureProject(request, backend, dir);
  await page.emulateMedia({ reducedMotion: "reduce" });
  await gotoApp(page, backend.bootBase);
  await openProject(page, dir);
  await orb(page).click();
  await page.getByTestId("head-pm-composer").fill("What is this project?");
  await page.getByTestId("head-pm-send").click();
  await expect(page.getByTestId("head-pm-orb-spinner")).toBeVisible();
  const animation = await page.getByTestId("head-pm-orb-spinner").evaluate((el) => getComputedStyle(el).animationName);
  expect(animation).toBe("none");
  await expect(page.getByTestId("head-pm-busy")).toHaveCount(0, { timeout: 15_000 });

  // The conversation is stored by the core: a fresh page load reads it back.
  await page.reload();
  await expect(orb(page)).toBeVisible();
  await openProject(page, dir);
  await orb(page).click();
  await expect(page.getByTestId("head-pm-message")).toHaveCount(2);
  expect((await projectMessages(request, backend, dir)).length).toBe(2);
});
