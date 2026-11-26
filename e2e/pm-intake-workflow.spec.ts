import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test, expect, type APIRequestContext, type E2EBackend, type Page } from "./fixtures";
import { gotoApp } from "./helpers";
import { FAKE_PM_INTAKE_MARKER } from "../src/bun/project-manager-fake.ts";

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

async function registerProject(request: APIRequestContext, backend: E2EBackend, name: string): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), `fo-intake-${name.replace(/\W+/g, "-")}-`));
  await mkdir(path.join(dir, "docs"), { recursive: true });
  await writeFile(path.join(dir, "docs/IDEA.md"), "# Idea\n");
  const res = await request.post(`${backend.apiBase}/projects`, { headers: auth(backend), data: { path: dir, name } });
  expect(res.ok(), await res.text()).toBeTruthy();
  return (await res.json()).path as string;
}

async function enableCodex(request: APIRequestContext, backend: E2EBackend): Promise<void> {
  const res = await request.patch(`${backend.apiBase}/harnesses/codex`, { headers: auth(backend), data: { enabled: true } });
  expect(res.ok(), await res.text()).toBeTruthy();
}

async function openManager(page: Page, dir: string): Promise<void> {
  await page.locator(`[data-testid="project-nav-item"][data-path="${dir}"]`).click();
  await expect(page.getByTestId("project-header-name")).toBeVisible();
  await page.getByTestId("project-page-manager").click();
  await expect(page.getByTestId("manager-page")).toBeVisible();
}

async function setUpAgent(page: Page): Promise<void> {
  await expect(page.getByTestId("manager-harness")).toHaveValue("codex", { timeout: 20_000 });
  await expect(page.getByTestId("manager-isolation")).toBeVisible();
  await expect(page.getByTestId("manager-connection")).toHaveText("Confirm the agent to start");
  await expect(page.getByTestId("manager-send")).toBeDisabled();
  await page.getByTestId("manager-consent").check();
  await expect(page.getByTestId("manager-connection")).toHaveText("Ready");
}

test("backlog draft → admit → project inbox → ready without auto-run", async ({ page, request, freshBackend: backend }) => {
  test.slow();
  const dir = await registerProject(request, backend, "Intake");
  const create = await request.post(`${backend.apiBase}/tasks`, {
    headers: auth(backend),
    data: {
      title: "Intake draft task",
      prompt: "Work.\n\n## Acceptance criteria\n- ok",
      workdir: dir,
      agent: "codex",
      model: "gpt-6.1-sol",
      isolation: "none",
      column: "backlog",
    },
  });
  expect(create.ok()).toBeTruthy();
  const task = await create.json();

  const startBlocked = await request.post(`${backend.apiBase}/tasks/${task.id}/start`, { headers: auth(backend) });
  expect(startBlocked.status()).toBe(400);

  const admit = await request.post(`${backend.apiBase}/tasks/${task.id}/admit-inbox`, { headers: auth(backend) });
  expect(admit.ok()).toBeTruthy();
  expect((await admit.json()).column).toBe("inbox");

  await gotoApp(page, backend.bootBase);
  await openManager(page, dir);
  await page.getByTestId("manager-tab-inbox").click();
  await expect(page.getByTestId("manager-inbox-task-entry")).toHaveCount(1);

  const ready = await request.patch(`${backend.apiBase}/tasks/${task.id}`, {
    headers: auth(backend),
    data: { column: "ready" },
  });
  expect(ready.ok()).toBeTruthy();
});

test("PM chat promotes backlog when owner grants intake on the message", async ({ page, request, freshBackend: backend }) => {
  test.slow();
  await enableCodex(request, backend);
  const dir = await registerProject(request, backend, "PM promote");
  const create = await request.post(`${backend.apiBase}/tasks`, {
    headers: auth(backend),
    data: {
      title: "Promote me",
      prompt: "Work.\n\n## Acceptance criteria\n- ok",
      workdir: dir,
      agent: "codex",
      model: "gpt-6.1-sol",
      isolation: "none",
      column: "backlog",
    },
  });
  const task = await create.json();

  await gotoApp(page, backend.bootBase);
  await openManager(page, dir);
  await setUpAgent(page);
  await page.getByTestId("manager-intake-grant").locator("input").check();
  await page.getByTestId("manager-composer").fill(`${FAKE_PM_INTAKE_MARKER} please admit`);
  await page.getByTestId("manager-send").click();
  await expect(page.getByTestId("manager-busy")).toBeVisible();
  await expect(page.getByTestId("manager-busy")).toHaveCount(0, { timeout: 30_000 });

  const refreshed = await request.get(`${backend.apiBase}/tasks/${task.id}`, { headers: auth(backend) });
  expect((await refreshed.json()).column).toBe("inbox");
});
