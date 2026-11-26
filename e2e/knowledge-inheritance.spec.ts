import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test, expect, type APIRequestContext, type E2EBackend } from "./fixtures";
import { gotoApp } from "./helpers";

function auth(backend: E2EBackend): { authorization: string } {
  return { authorization: `Bearer ${backend.apiToken}` };
}

async function registerProject(request: APIRequestContext, backend: E2EBackend, name: string): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), `fo011e-${name.replace(/\W+/g, "-")}-`));
  await mkdir(path.join(dir, "docs"), { recursive: true });
  await writeFile(path.join(dir, "docs/IDEA.md"), "# Idea\n");
  const res = await request.post(`${backend.apiBase}/projects`, { headers: auth(backend), data: { path: dir, name } });
  expect(res.ok(), await res.text()).toBeTruthy();
  return (await res.json()).path as string;
}

test("FO-011E project settings preview effective knowledge context", async ({ page, request, backend: b }) => {
  const projectPath = await registerProject(request, b, "Inherit");
  await gotoApp(page, b.bootBase);
  await page.locator(`[data-testid="project-nav-item"][data-path="${projectPath}"]`).click();
  await page.getByTestId("project-more").click(); await page.getByTestId("project-page-settings").click();
  await expect(page.getByTestId("project-knowledge-inheritance")).toBeVisible();
  await page.getByTestId("project-knowledge-effective-preview").click();
  await expect(page.getByTestId("project-knowledge-effective-list")).toBeVisible();
});
