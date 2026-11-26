import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { test, expect, type APIRequestContext, type E2EBackend, type Page } from "./fixtures";
import { gotoApp, openAllTasks } from "./helpers";

/**
 * FO-009F acceptance — honest router context, fail-closed automatic routing,
 * manual selection with warnings. Fake backend only; no provider calls.
 */

const auth = (backend: E2EBackend) => ({ authorization: `Bearer ${backend.apiToken}` });

async function registerProject(request: APIRequestContext, backend: E2EBackend): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), "fo009f-"));
  const response = await request.post(`${backend.apiBase}/projects`, { headers: auth(backend), data: { path: dir, name: "FO-009F" } });
  expect(response.ok(), await response.text()).toBeTruthy();
  return dir;
}

async function createTask(request: APIRequestContext, backend: E2EBackend, workdir: string) {
  const title = `fo009f-${randomUUID().slice(0, 8)}`;
  const response = await request.post(`${backend.apiBase}/tasks`, {
    headers: auth(backend),
    data: { title, prompt: "Routing acceptance.", isolation: "none", workdir, column: "ready", agent: "claude-code" },
  });
  expect(response.ok(), await response.text()).toBeTruthy();
  return { title, ...(await response.json()) };
}

test("FO-009F router shows harness status, trusted quota posture, and manual-only policy", async ({ page, request, freshBackend: backend }) => {
  test.setTimeout(90_000);
  let refreshes = 0;
  page.on("request", (call) => {
    if (/quota-refresh|usage\/refresh/.test(new URL(call.url()).pathname)) refreshes++;
  });
  const dir = await registerProject(request, backend);
  const { title } = await createTask(request, backend, dir);
  await request.patch(`${backend.apiBase}/harnesses/codex`, { headers: auth(backend), data: { enabled: true } });
  const contextRes = await request.get(`${backend.apiBase}/model-router/resource-context`, { headers: auth(backend) });
  expect(contextRes.ok(), await contextRes.text()).toBeTruthy();
  const context = await contextRes.json() as { automaticRouting: { available: boolean }; harnesses: { id: string; enabled: boolean }[] };
  expect(context.automaticRouting.available).toBe(false);
  expect(context.harnesses.some((h) => h.id === "codex" && h.enabled)).toBe(true);

  await gotoApp(page, backend.bootBase);
  await openAllTasks(page);
  await page.getByRole("button", { name: title }).click();
  const section = page.getByTestId("ai-resource-recommendation");
  await section.locator("> summary").click();
  await expect(section.getByTestId("router-resource-context")).toBeVisible({ timeout: 15_000 });
  await expect(section.getByTestId("router-automatic-policy")).toContainText("Unavailable");
  await expect(section.getByTestId("router-harness-row-codex")).toHaveAttribute("data-enabled", "true");
  await expect(section.getByTestId("router-manual-policy")).toContainText("automatic router chooses nothing");
  await section.getByTestId("find-ai-resource").click();
  await expect(section.getByTestId("router-no-verified")).toBeVisible();
  await expect(section).not.toContainText(/\b\d+% remaining\b/i);
  expect(refreshes).toBe(0);
});

test("FO-009F disabled harness is visible as blocked for automatic and manual launch via router context", async ({ page, request, freshBackend: backend }) => {
  const dir = await registerProject(request, backend);
  const { title } = await createTask(request, backend, dir);
  await request.patch(`${backend.apiBase}/harnesses/codex`, { headers: auth(backend), data: { enabled: false } });
  await gotoApp(page, backend.bootBase);
  await openAllTasks(page);
  await page.getByRole("button", { name: title }).click();
  const section = page.getByTestId("ai-resource-recommendation");
  await section.locator("> summary").click();
  await expect(section.getByTestId("router-harness-row-codex")).toHaveAttribute("data-enabled", "false");
  await expect(section.getByTestId("router-harness-row-codex")).toContainText("blocked-disabled");
});
