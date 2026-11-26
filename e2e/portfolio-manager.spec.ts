import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test, expect, type APIRequestContext, type E2EBackend, type Page } from "./fixtures";
import { gotoApp, openPortfolio } from "./helpers";

/**
 * FO-008C global portfolio manager. Every agent is the fake codex driver (no
 * real CLI, no AI quota). Each test gets a fresh backend so the global chat,
 * plans and delegations never leak between tests.
 */

test.describe.configure({ mode: "serial" });
test.use({
  backendEnv: {
    AGETOR_CODEX_DRIVER: "fake",
    AGETOR_CODEX_BIN: "/bin/echo",
    AGETOR_FAKE_PORTFOLIO_DELAY_MS: "300",
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

async function registerProject(request: APIRequestContext, backend: E2EBackend, name: string): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), `fo008c-${name.replace(/\W+/g, "-")}-`));
  const res = await request.post(`${backend.apiBase}/projects`, { headers: auth(backend), data: { path: dir, name } });
  expect(res.ok(), await res.text()).toBeTruthy();
  return (await res.json()).path as string;
}

async function createTask(request: APIRequestContext, backend: E2EBackend, title: string, workdir: string, column: string): Promise<void> {
  const res = await request.post(`${backend.apiBase}/tasks`, {
    headers: auth(backend),
    data: { title, prompt: title, isolation: "none", workdir, column },
  });
  expect(res.ok(), await res.text()).toBeTruthy();
}

/** Give a project's own manager an agent, as the owner would in its tab. */
async function configureProjectManager(request: APIRequestContext, backend: E2EBackend, dir: string): Promise<void> {
  const preflight = await request.post(`${backend.apiBase}/project-interviews/preflight`, {
    headers: auth(backend),
    data: { harness: "codex", model: "gpt-6.1-sol" },
  });
  expect(preflight.ok(), await preflight.text()).toBeTruthy();
  const consentKey = (await preflight.json()).isolation.consentKey;
  const res = await request.put(`${backend.apiBase}/project-manager/config`, {
    headers: auth(backend),
    data: { path: dir, config: { harness: "codex", model: "gpt-6.1-sol", effort: "low", consentKey } },
  });
  expect(res.ok(), await res.text()).toBeTruthy();
}

async function projectManagerMessages(request: APIRequestContext, backend: E2EBackend, dir: string): Promise<any[]> {
  const res = await request.get(`${backend.apiBase}/project-manager?path=${encodeURIComponent(dir)}`, { headers: auth(backend) });
  return (await res.json()).messages as any[];
}

function countRequests(page: Page, needle: string): () => number {
  let count = 0;
  page.on("request", (req) => {
    if (req.method() === "POST" && req.url().includes(needle)) count += 1;
  });
  return () => count;
}

async function openPortfolioManager(page: Page): Promise<void> {
  await openPortfolio(page);
  await expect(page.getByTestId("portfolio-dashboard")).toBeVisible();
  await page.getByTestId("portfolio-tab-manager").click();
  await expect(page.getByTestId("portfolio-manager")).toBeVisible();
}

async function setUpAgent(page: Page): Promise<void> {
  await expect(page.getByTestId("portfolio-manager-harness")).toHaveValue("codex", { timeout: 20_000 });
  await expect(page.getByTestId("portfolio-manager-isolation")).toBeVisible();
  await expect(page.getByTestId("portfolio-manager-isolation")).toContainText("not a guaranteed sandbox");
  await expect(page.getByTestId("portfolio-manager-connection")).toHaveText("Confirm the agent to start");
  await expect(page.getByTestId("portfolio-manager-send")).toBeDisabled();
  await page.getByTestId("portfolio-manager-consent").check();
  await expect(page.getByTestId("portfolio-manager-connection")).toHaveText("Ready");
}

async function send(page: Page, text: string): Promise<void> {
  await page.getByTestId("portfolio-manager-composer").fill(text);
  await page.getByTestId("portfolio-manager-send").click();
  await expect(page.getByTestId("portfolio-manager-busy")).toBeVisible();
  await expect(page.getByTestId("portfolio-manager-busy")).toHaveCount(0);
}

test("global chat, a plan, and one approved request to a project manager", async ({ page, request, freshBackend: backend }) => {
  test.slow();
  await enableCodex(request, backend);
  const exampleProject = await registerProject(request, backend, "ExampleApp");
  const exampleService = await registerProject(request, backend, "ExampleService");
  await createTask(request, backend, "Fix upload crash", exampleProject, "blocked");
  await createTask(request, backend, "Finish migrations", exampleService, "ready");
  await configureProjectManager(request, backend, exampleService);
  const portfolioSends = countRequests(page, "/portfolio-manager/messages");
  const managerSends = countRequests(page, "/project-manager/messages");

  await gotoApp(page, backend.bootBase);
  await openPortfolioManager(page);
  await expect(page.getByTestId("portfolio-manager-empty")).toBeVisible();
  await expect(page.locator('[data-testid="portfolio-manager-source"][data-source="projects"]')).toContainText("All 2 projects");
  // Opening the tab calls no model.
  expect(portfolioSends()).toBe(0);
  await setUpAgent(page);

  await send(page, "What is happening in all my projects?");
  await expect(page.getByTestId("portfolio-manager-reply").last()).toContainText("Portfolio: 2 project(s)");

  await send(page, "Составь план работы на сегодня");
  const plan = page.getByTestId("portfolio-plan");
  await expect(plan).toBeVisible();
  await expect(plan.getByTestId("portfolio-plan-project")).toHaveCount(2);
  await expect(plan.getByTestId("portfolio-plan-notes")).toContainText("ghost-harness");
  await plan.getByTestId("portfolio-plan-accept").click();
  await expect(plan).toHaveAttribute("data-status", "accepted");
  await expect(page.getByTestId("portfolio-manager-decision").first()).toContainText("Accepted the portfolio plan");

  await send(page, "Попроси менеджера ExampleService проверить блокировки");
  const card = page.getByTestId("portfolio-delegation");
  await expect(card).toHaveAttribute("data-status", "proposed");
  await expect(card).toHaveAttribute("data-project", exampleService);
  await expect(card.getByTestId("portfolio-delegation-request")).toContainText("ExampleService");
  await expect(card.getByTestId("portfolio-delegation-agent")).toContainText("gpt-6.1-sol");
  await expect(page.getByTestId("portfolio-manager-pending")).toContainText("ExampleService");
  // Nothing reached the project manager before approval.
  expect(await projectManagerMessages(request, backend, exampleService)).toEqual([]);

  await card.getByTestId("portfolio-delegation-approve").click();
  const dialog = page.getByRole("dialog");
  await expect(dialog).toContainText("Send this request to the manager of ExampleService?");
  await dialog.getByRole("button", { name: "Send request" }).click();
  await expect(card).toHaveAttribute("data-status", /sent|answered/);
  await expect(card).toHaveAttribute("data-status", "answered", { timeout: 15_000 });
  await expect(card.getByTestId("portfolio-delegation-result")).toBeVisible();

  const messages = await projectManagerMessages(request, backend, exampleService);
  expect(messages.map((m) => m.role)).toEqual(["owner", "manager"]);
  expect(messages[0].delegationId).toBeTruthy();
  expect(await projectManagerMessages(request, backend, exampleProject)).toEqual([]);
  // Three global turns (one per Send); the delegation never went through the
  // project-manager message route from the page, and no extra global turn ran.
  expect(portfolioSends()).toBe(3);
  expect(managerSends()).toBe(0);

  await card.getByTestId("portfolio-delegation-open").click();
  await expect(page.getByTestId("manager-page")).toBeVisible();
  const delegated = page.locator('[data-testid="manager-message"][data-role="owner"]').first();
  await expect(delegated).toHaveAttribute("data-delegation", /.+/);
  await expect(delegated).toContainText("Portfolio manager request, approved by you");
});

test("delegation updates come from events: no polling, focus and reconnect resync", async ({ page, request, freshBackend: backend }) => {
  test.slow();
  await enableCodex(request, backend);
  const alpha = await registerProject(request, backend, "Alpha Events");
  const beta = await registerProject(request, backend, "Beta Events");
  await configureProjectManager(request, backend, alpha);
  await configureProjectManager(request, backend, beta);
  // The shared event stream stays down until the end of the test.
  await page.route("**/app/events**", (route) => route.abort());
  let stateReads = 0;
  page.on("request", (req) => {
    if (req.method() === "GET" && /\/portfolio-manager(\?|$)/.test(req.url())) stateReads += 1;
  });
  const delegationStatus = async (id: string) => {
    const res = await request.get(`${backend.apiBase}/portfolio-manager`, { headers: auth(backend) });
    return ((await res.json()).delegations as any[]).find((item) => item.id === id)?.status;
  };

  await gotoApp(page, backend.bootBase);
  await openPortfolioManager(page);
  await setUpAgent(page);
  await send(page, "delegate __fake_portfolio_two__");
  const cards = page.getByTestId("portfolio-delegation");
  await expect(cards).toHaveCount(2);

  const approve = async (index: number): Promise<string> => {
    const card = cards.nth(index);
    const id = (await card.locator("h4").getAttribute("id"))!.replace(/^delegation-/, "").replace(/-title$/, "");
    await card.getByTestId("portfolio-delegation-approve").click();
    await page.getByRole("dialog").getByRole("button", { name: "Send request" }).click();
    await expect(card).toHaveAttribute("data-status", "sent");
    await expect.poll(() => delegationStatus(id), { timeout: 15_000 }).toBe("answered");
    return id;
  };

  // 1. Answered in the core, but with no event and no focus the tab does
  //    not poll: it keeps showing "sent".
  await approve(0);
  const readsBefore = stateReads;
  await page.waitForTimeout(3500);
  await expect(cards.nth(0)).toHaveAttribute("data-status", "sent");
  expect(stateReads).toBe(readsBefore);
  // 2. Regaining focus re-reads the state once.
  await page.evaluate(() => window.dispatchEvent(new Event("focus")));
  await expect(cards.nth(0)).toHaveAttribute("data-status", "answered");

  // 3. A reconnect of the event stream re-syncs what was missed.
  await approve(1);
  await expect(cards.nth(1)).toHaveAttribute("data-status", "sent");
  await page.unroute("**/app/events**");
  await expect(cards.nth(1)).toHaveAttribute("data-status", "answered", { timeout: 20_000 });
  await expect(cards.nth(0)).toHaveAttribute("data-status", "answered");
  // Each project manager answered exactly once; nothing was re-sent.
  expect((await projectManagerMessages(request, backend, alpha)).filter((m) => m.role === "owner")).toHaveLength(1);
  expect((await projectManagerMessages(request, backend, beta)).filter((m) => m.role === "owner")).toHaveLength(1);
});

test("failures, invalid output, retry and reject", async ({ page, request, freshBackend: backend }) => {
  test.slow();
  await enableCodex(request, backend);
  const dir = await registerProject(request, backend, "Solo");
  await gotoApp(page, backend.bootBase);
  await openPortfolioManager(page);
  await setUpAgent(page);

  await send(page, "status __fake_portfolio_fail__");
  await expect(page.getByTestId("portfolio-manager-turn-error")).toBeVisible();
  await expect(page.getByTestId("portfolio-manager-retry")).toBeEnabled();

  await send(page, "plan __fake_portfolio_badplan__");
  await expect(page.getByTestId("portfolio-manager-protocol-error")).toContainText("not in the portfolio");
  await expect(page.getByTestId("portfolio-plan")).toHaveCount(0);

  await send(page, "delegate to the manager of Solo");
  const card = page.getByTestId("portfolio-delegation");
  // The project's manager has no agent yet: approval is blocked and says why.
  await expect(card.getByTestId("portfolio-delegation-problem")).toContainText("no agent");
  await expect(card.getByTestId("portfolio-delegation-approve")).toBeDisabled();
  await card.getByTestId("portfolio-delegation-reject").click();
  await expect(card).toHaveAttribute("data-status", "rejected");
  expect(await projectManagerMessages(request, backend, dir)).toEqual([]);
});

test("tabs work from the keyboard and the manager fits every width", async ({ page, request, freshBackend: backend }) => {
  await enableCodex(request, backend);
  for (let i = 0; i < 12; i += 1) await registerProject(request, backend, `Long project name number ${i} with extra words`);
  await page.emulateMedia({ reducedMotion: "reduce", colorScheme: "dark" });
  await gotoApp(page, backend.bootBase);
  await openPortfolio(page);
  const overviewTab = page.getByTestId("portfolio-tab-overview");
  await overviewTab.focus();
  await page.keyboard.press("ArrowRight");
  await expect(page.getByTestId("portfolio-tab-manager")).toBeFocused();
  await expect(page.getByTestId("portfolio-tab-manager")).toHaveAttribute("aria-selected", "true");
  await expect(page.getByTestId("portfolio-manager")).toBeVisible();
  await expect(page.getByRole("log", { name: "Portfolio manager messages" })).toBeVisible();
  for (const width of [390, 768, 1024, 1440]) {
    await page.setViewportSize({ width, height: 800 });
    const box = await page.getByTestId("portfolio-manager").boundingBox();
    expect(box?.width ?? 0).toBeLessThanOrEqual(width);
    const fits = await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth + 1);
    expect(fits).toBe(true);
  }
  await page.keyboard.press("ArrowLeft");
  await expect(page.getByTestId("portfolio-tab-overview")).toHaveAttribute("aria-selected", "true");
  await expect(page.getByTestId("portfolio-metric-projects")).toContainText("12");
});
