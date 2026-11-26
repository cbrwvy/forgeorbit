import { mkdir, mkdtemp, realpath, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test, expect, type APIRequestContext, type E2EBackend, type Page } from "./fixtures";
import { gotoApp, openSettingsGeneral, getPreferences, openWorkspaces } from "./helpers";

/**
 * FO-UX-SIMPLIFY02-M7: the one getting-started block on Home (Add a project, Set up an AI tool,
 * Give the Head of PM a goal). Replaces the welcome dialog and the board checklist.
 *
 * Every test uses `freshBackend` (a virgin headless core + SQLite per test): the block branches on
 * whether `onboardingDismissed` was ever written, and there is no "unset preference" API. Providers
 * are never started — the harness binaries are stubs and every driver is fake. `gotoApp`'s default
 * seeds the dismissal, which is wrong here, so every navigation passes `{ seedOnboardingDismissed: false }`.
 */

test.describe.configure({ timeout: 90_000 });

/** No harness binary resolves: a profile with no AI tool installed at all. */
const NO_TOOLS = {
  AGETOR_CLAUDE_BIN: "/nonexistent/claude",
  AGETOR_CODEX_BIN: "/nonexistent/codex",
  AGETOR_CURSOR_BIN: "/nonexistent/cursor-agent",
  AGETOR_GEMINI_BIN: "/nonexistent/gemini",
  AGETOR_ANTIGRAVITY_BIN: "/nonexistent/agy",
  AGETOR_FX_BIN: "/nonexistent/fx",
};
/** Only the tools that ship switched off resolve (codex, cursor, gemini): installed, but disabled. */
const ONLY_DISABLED_TOOLS = {
  AGETOR_CLAUDE_BIN: "/nonexistent/claude",
  AGETOR_ANTIGRAVITY_BIN: "/nonexistent/agy",
  AGETOR_FX_BIN: "/nonexistent/fx",
};

function auth(b: E2EBackend): { authorization: string } {
  return { authorization: `Bearer ${b.apiToken}` };
}

async function projectDir(b: E2EBackend, name: string): Promise<string> {
  const dir = await realpath(await mkdtemp(path.join(tmpdir(), `m7-${name}-`)));
  await mkdir(path.join(dir, "docs"), { recursive: true });
  await writeFile(path.join(dir, "docs", "IDEA.md"), "# Idea\n");
  await writeFile(path.join(dir, "docs", "PRD.md"), "# PRD\n");
  await writeFile(path.join(dir, "README.md"), "# Readme\n");
  return dir;
}

async function register(request: APIRequestContext, b: E2EBackend, dir: string, name: string): Promise<void> {
  const res = await request.post(`${b.apiBase}/projects`, { headers: auth(b), data: { path: dir, name } });
  expect(res.ok(), `POST /projects -> ${res.status()}: ${await res.text()}`).toBeTruthy();
}

async function createTask(request: APIRequestContext, b: E2EBackend, title: string): Promise<{ id: string }> {
  const res = await request.post(`${b.apiBase}/tasks`, { headers: auth(b), data: { title, prompt: title, isolation: "none", workdir: tmpdir() } });
  expect(res.ok(), `POST /tasks -> ${res.status()}: ${await res.text()}`).toBeTruthy();
  return (await res.json()) as { id: string };
}

/** Non-GET requests the page makes (UI preferences and read-only discovery are not project state). */
function recordWrites(page: Page): { all: () => string[] } {
  const writes: string[] = [];
  page.on("request", (req) => {
    if (["GET", "HEAD", "OPTIONS"].includes(req.method())) return;
    const url = new URL(req.url());
    // /api/router-v2/evaluate is a read-only preview (POST only to carry a body) the AI tool settings panel asks for.
    if (url.pathname.startsWith("/preferences/") || url.pathname === "/projects/discover" || url.pathname === "/api/router-v2/evaluate") return;
    writes.push(`${req.method()} ${url.pathname}`);
  });
  return { all: () => writes };
}

const block = (page: Page) => page.getByTestId("getting-started");
const step = (page: Page, id: "project" | "ai-tool" | "goal") => page.getByTestId(`getting-started-step-${id}`);

async function advance(page: Page, testId: "wizard-next" | "wizard-submit" = "wizard-next"): Promise<void> {
  await page.getByTestId(testId).click();
}

test.describe("getting started: fresh profile", () => {
  test.use({ backendEnv: NO_TOOLS });

  test("no AI tool: a project is added first, the blocker is explained and links to AI tool settings, nothing is sent", async ({ page, request, freshBackend: b }) => {
    await gotoApp(page, b.bootBase, { seedOnboardingDismissed: false });
    const writes = recordWrites(page);

    // One block, no welcome dialog, no old checklist.
    await expect(block(page)).toBeVisible();
    await expect(page.getByTestId("onboarding-welcome")).toHaveCount(0);
    await expect(page.getByTestId("onboarding-checklist")).toHaveCount(0);
    await expect(page.getByRole("dialog")).toHaveCount(0);
    await expect(step(page, "project")).toHaveAttribute("data-status", "todo");
    await expect(step(page, "ai-tool")).toHaveAttribute("data-status", "todo");
    await expect(step(page, "goal")).toHaveAttribute("data-status", "blocked");
    await expect(page.getByTestId("getting-started-detail-ai-tool")).toContainText("No AI tool was found");
    await expect(page.getByTestId("getting-started-progress")).toContainText("0 of 3");

    // 1. Add a project: no provider is needed.
    await page.getByTestId("getting-started-add-project").click();
    await expect(page.getByTestId("project-wizard")).toBeVisible();
    const dir = await projectDir(b, "fresh");
    await page.getByTestId("wizard-name").fill("First Orbit");
    await page.getByTestId("wizard-directory").fill(dir);
    for (let i = 0; i < 5; i++) await advance(page);
    await advance(page, "wizard-submit");
    await expect(page.getByTestId("project-header-name")).toHaveText("First Orbit");

    // Back on Home the project step is done; the goal step is open but names the real blocker.
    await page.getByTestId("workspace-overview").click();
    await expect(block(page)).toBeVisible();
    await expect(step(page, "project")).toHaveAttribute("data-status", "done");
    await expect(step(page, "ai-tool")).toHaveAttribute("data-status", "todo");
    await expect(step(page, "goal")).toHaveAttribute("data-status", "todo");
    await expect(page.getByTestId("getting-started-goal-blocker")).toHaveAttribute("data-blocker", "not-installed");

    // 2. The blocker links to the AI tools panel of Settings and changes nothing.
    const mark = writes.all().length;
    await page.getByTestId("getting-started-goal-blocker-settings").click();
    const dialog = page.getByRole("dialog");
    await expect(dialog.getByTestId("settings-sub-harnesses")).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(page.getByRole("dialog")).toHaveCount(0);

    // 3. The goal step only focuses the existing target select; it picks nothing.
    await page.getByTestId("getting-started-choose-target").click();
    await expect(page.getByTestId("home-goal-target")).toBeFocused();
    await expect(page.getByTestId("home-goal-target")).toHaveValue("");
    await expect(page.getByTestId("home-ask-head")).toBeDisabled();
    await page.getByTestId("home-goal-target").selectOption({ label: "First Orbit" });
    await page.getByTestId("home-ask-head").click();
    await expect(page.getByTestId("head-pm-panel")).toBeVisible();
    await expect(page.getByTestId("head-pm-scope")).toHaveValue(`project:${dir}`);

    // Nothing was sent, granted or started by any of that.
    expect(writes.all().slice(mark)).toEqual([]);
    const forbidden = writes.all().filter((w) => /portfolio-manager\/messages|\/start$|grant|\/runs/.test(w));
    expect(forbidden).toEqual([]);
    expect(await (await request.get(`${b.apiBase}/tasks`, { headers: auth(b) })).json()).toEqual([]);
  });

  test("the block is dismissible, the dismissal survives a reload, and Settings brings it back on Home", async ({ page, request, freshBackend: b }) => {
    await gotoApp(page, b.bootBase, { seedOnboardingDismissed: false });
    await expect(block(page)).toBeVisible();
    await page.getByTestId("getting-started-dismiss").click();
    await expect(block(page)).toHaveCount(0);

    await gotoApp(page, b.bootBase, { seedOnboardingDismissed: false });
    await expect(page.getByTestId("global-overview")).toBeVisible();
    await expect(block(page)).toHaveCount(0);
    expect((await getPreferences(request, b)).onboardingDismissed).toBe("true");

    // Replay from another page: it lands on Home with the block visible.
    await openWorkspaces(page);
    const dialog = await openSettingsGeneral(page);
    await dialog.getByTestId("settings-replay-onboarding").click();
    await expect(page.getByRole("dialog")).toHaveCount(0);
    await expect(page.getByTestId("global-overview")).toBeVisible();
    await expect(block(page)).toBeVisible();
    expect((await getPreferences(request, b)).onboardingDismissed).toBe("false");

    // It survives a reload while replaying, and dismissing again hides it.
    await gotoApp(page, b.bootBase, { seedOnboardingDismissed: false });
    await expect(block(page)).toBeVisible();
    await page.getByTestId("getting-started-dismiss").click();
    await expect(block(page)).toHaveCount(0);
    expect((await getPreferences(request, b)).onboardingDismissed).toBe("true");
  });
});

test.describe("getting started: keyboard and neighbours", () => {
  test.use({ backendEnv: NO_TOOLS });

  test("every action is a real button reachable by keyboard; the attention feed and Emergency Stop stay available at 800 px", async ({ page, freshBackend: b }) => {
    await page.setViewportSize({ width: 800, height: 900 });
    await gotoApp(page, b.bootBase, { seedOnboardingDismissed: false });
    await expect(block(page)).toBeVisible();
    await expect(page.getByTestId("home-attention")).toBeVisible();
    await expect(page.getByTestId("workspace-attention")).toBeVisible();
    await expect(page.getByRole("button", { name: "Emergency stop" })).toBeVisible();

    // The steps are an ordered list and each action is reachable with Tab and activates with Enter.
    await expect(block(page).getByRole("list")).toBeVisible();
    await page.getByTestId("getting-started-dismiss").focus();
    await page.keyboard.press("Tab");
    await expect(page.getByTestId("getting-started-add-project")).toBeFocused();
    await page.keyboard.press("Tab");
    await expect(page.getByTestId("getting-started-open-ai-settings")).toBeFocused();
    await page.keyboard.press("Enter");
    await expect(page.getByRole("dialog").getByTestId("settings-sub-harnesses")).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(page.getByRole("dialog")).toHaveCount(0);
    await page.getByTestId("getting-started-add-project").focus();
    await page.keyboard.press("Enter");
    await expect(page.getByTestId("project-wizard")).toBeVisible();
  });
});

test.describe("getting started: installed but switched off", () => {
  test.use({ backendEnv: ONLY_DISABLED_TOOLS });

  test("an installed but disabled tool is not called ready", async ({ page, request, freshBackend: b }) => {
    const dir = await projectDir(b, "disabled");
    await register(request, b, dir, "Disabled Orbit");
    await gotoApp(page, b.bootBase, { seedOnboardingDismissed: false });
    await expect(block(page)).toBeVisible();
    await expect(step(page, "project")).toHaveAttribute("data-status", "done");
    await expect(step(page, "ai-tool")).toHaveAttribute("data-status", "todo");
    await expect(page.getByTestId("getting-started-detail-ai-tool")).toContainText("switched off");
    await expect(page.getByTestId("getting-started-goal-blocker")).toHaveAttribute("data-blocker", "disabled");
  });
});

test.describe("getting started: a tool whose sign-in cannot be read", () => {
  test("is shown as installed, never as done, and does not block the goal", async ({ page, request, freshBackend: b }) => {
    const dir = await projectDir(b, "unchecked");
    await register(request, b, dir, "Unchecked Orbit");
    await gotoApp(page, b.bootBase, { seedOnboardingDismissed: false });
    await expect(block(page)).toBeVisible();
    await expect(step(page, "ai-tool")).toHaveAttribute("data-status", "unchecked");
    await expect(page.getByTestId("getting-started-status-ai-tool")).toContainText("sign-in not checked");
    await expect(page.getByTestId("getting-started-goal-blocker")).toHaveCount(0);
    await expect(step(page, "goal")).toHaveAttribute("data-status", "todo");
  });
});

test.describe("getting started: established profile", () => {
  test("a profile that already has a project and a task is never sent through setup, and the dismissal is stored once", async ({ page, request, freshBackend: b }) => {
    await register(request, b, tmpdir(), "Existing");
    await createTask(request, b, `m7-existing-${Date.now()}`);

    await gotoApp(page, b.bootBase, { seedOnboardingDismissed: false });
    await expect(page.getByTestId("global-overview")).toBeVisible();
    await expect(block(page)).toHaveCount(0);
    await expect(page.getByTestId("onboarding-welcome")).toHaveCount(0);
    await expect
      .poll(() => getPreferences(request, b).then((p) => p.onboardingDismissed), { timeout: 10_000 })
      .toBe("true");
  });

  test("an explicit dismissal is honored even when no tool is set up", async ({ page, request, freshBackend: b }) => {
    await request.put(`${b.apiBase}/preferences/onboardingDismissed`, { headers: auth(b), data: { value: "true" } });
    await gotoApp(page, b.bootBase, { seedOnboardingDismissed: false });
    await expect(page.getByTestId("global-overview")).toBeVisible();
    await expect(block(page)).toHaveCount(0);
  });
});
