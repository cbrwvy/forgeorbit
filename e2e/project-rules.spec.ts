import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test, expect, type APIRequestContext, type E2EBackend } from "./fixtures";
import { gotoApp } from "./helpers";

function auth(backend: E2EBackend): { authorization: string } {
  return { authorization: `Bearer ${backend.apiToken}` };
}

async function registerProject(request: APIRequestContext, backend: E2EBackend, name: string): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), `fo-rules-${name.replace(/\W+/g, "-")}-`));
  await mkdir(path.join(dir, "docs"), { recursive: true });
  await writeFile(path.join(dir, "docs/IDEA.md"), "# Idea\n");
  const res = await request.post(`${backend.apiBase}/projects`, { headers: auth(backend), data: { path: dir, name } });
  expect(res.ok(), await res.text()).toBeTruthy();
  return (await res.json()).path as string;
}

test("owner manages project rules in settings", async ({ page, request, backend: b }) => {
  const projectPath = await registerProject(request, b, "Rules QA");
  await gotoApp(page, b.bootBase);
  await page.locator(`[data-testid="project-nav-item"][data-path="${projectPath}"]`).click();
  await page.getByTestId("project-more").click(); await page.getByTestId("project-page-settings").click();
  await expect(page.getByTestId("project-settings-page")).toBeVisible();
  await expect(page.getByTestId("project-rules-path")).toContainText(projectPath);

  await page.getByTestId("project-rule-add").click();
  await page.getByTestId("project-rule-name").fill("Testing");
  await page.getByTestId("project-rule-body").fill("Always run bun test for this repo.");
  await page.getByTestId("project-rule-save").click();
  await expect(page.getByTestId("project-rule-row")).toHaveCount(1);

  await page.reload();
  await page.locator(`[data-testid="project-nav-item"][data-path="${projectPath}"]`).click();
  await page.getByTestId("project-more").click(); await page.getByTestId("project-page-settings").click();
  await expect(page.getByTestId("project-rule-row")).toContainText("Testing");
  await expect(page.getByTestId("project-rule-row")).toContainText("bun test");
});
