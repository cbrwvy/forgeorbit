import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test, expect, type APIRequestContext, type E2EBackend } from "./fixtures";
import { gotoBoard } from "./helpers";

test.use({ backendEnv: {
  AGETOR_CLAUDE_DRIVER: "fake",
  AGETOR_FAKE_QC_VERDICT: "PASS",
  // Keep the existing fake handoff turn running while the Owner clicks Pause.
  AGETOR_FAKE_CLAUDE_RESOLVE_DELAY_MS: "10000",
} });
test.describe.configure({ timeout: 180_000, mode: "serial" });

function auth(backend: E2EBackend): { authorization: string } {
  return { authorization: `Bearer ${backend.apiToken}` };
}

async function registerProject(request: APIRequestContext, backend: E2EBackend, name: string): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), `fo-auto02-${name}-`));
  await mkdir(path.join(dir, "docs"), { recursive: true });
  await writeFile(path.join(dir, "README.md"), "# test\n");
  const res = await request.post(`${backend.apiBase}/projects`, { headers: auth(backend), data: { path: dir, name } });
  expect(res.ok(), await res.text()).toBeTruthy();
  return (await res.json()).path as string;
}

test("FO-AUTO02 Owner prepares, approves, starts, pauses bounded multi-task batch", async ({ page, request, freshBackend: b }) => {
  const projectPath = await registerProject(request, b, "Multi");
  const ids: string[] = [];
  for (const title of ["Alpha", "Beta", "Gamma"]) {
    const create = await request.post(`${b.apiBase}/tasks`, {
      headers: auth(b),
      data: { title, prompt: "Do work __agetor_fake_claude_handoff__:done", workdir: projectPath, agent: "claude-code", model: "opus-5.5", column: "ready", isolation: "none" },
    });
    ids.push(((await create.json()) as { id: string }).id);
  }
  const employee = await request.post(`${b.apiBase}/employees`, {
    headers: auth(b),
    data: { name: "BatchDev", jobTitle: "Dev", projectPath },
  });
  const dev = (await employee.json()) as { id: string };
  for (const id of ids) {
    await request.post(`${b.apiBase}/task-assignments`, { headers: auth(b), data: { taskId: id, employeeId: dev.id } });
  }

  await gotoBoard(page, b.bootBase);
  await page.locator(`[data-testid="project-nav-item"][data-path="${projectPath}"]`).click();
  await page.getByTestId("project-page-manager").click();
  await page.getByTestId("manager-tab-autonomy").click();
  await expect(page.getByTestId("orchestrated-batch-section")).toBeVisible();

  for (const id of ids.slice(0, 2)) {
    await page.getByTestId(`orchestrated-batch-pick-${id}`).check();
  }
  await page.getByTestId("orchestrated-batch-create").click();
  await page.getByTestId("orchestrated-batch-row").first().click();
  await page.getByTestId("orchestrated-batch-approve").click();
  await page.getByTestId("orchestrated-batch-start").click();

  await expect.poll(async () => {
    const detail = page.getByTestId("orchestrated-batch-detail");
    return detail.locator("[data-testid='orchestrated-batch-task-list'] li").count();
  }).toBeGreaterThan(0);

  await expect.poll(async () => {
    const res = await request.get(`${b.apiBase}/tasks/${ids[0]}/runs`, { headers: auth(b) });
    return (await res.json()).some((run: { status: string }) => run.status === "running");
  }).toBe(true);
  await page.getByTestId("orchestrated-batch-pause").click();
  await expect(page.getByTestId("orchestrated-batch-status")).toContainText("paused");
  await expect(page.getByTestId("orchestrated-batch-task-list").locator('[data-execution-type="synthetic"]').first()).toBeVisible();
});
