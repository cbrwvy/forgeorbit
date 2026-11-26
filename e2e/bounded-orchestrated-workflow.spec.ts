import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test, expect, type APIRequestContext, type E2EBackend } from "./fixtures";
import { gotoBoard } from "./helpers";

test.use({ backendEnv: { AGETOR_CLAUDE_DRIVER: "fake", AGETOR_FAKE_QC_VERDICT: "PASS" } });
test.describe.configure({ timeout: 120_000, mode: "serial" });

function auth(backend: E2EBackend): { authorization: string } {
  return { authorization: `Bearer ${backend.apiToken}` };
}

async function registerProject(request: APIRequestContext, backend: E2EBackend, name: string): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), `fo-auto01-${name.replace(/\W+/g, "-")}-`));
  await mkdir(path.join(dir, "docs"), { recursive: true });
  await writeFile(path.join(dir, "README.md"), "export const x = 1;\n");
  const res = await request.post(`${backend.apiBase}/projects`, { headers: auth(backend), data: { path: dir, name } });
  expect(res.ok(), await res.text()).toBeTruthy();
  return (await res.json()).path as string;
}

test("FO-AUTO01 UI shows bounded workflow through PASS", async ({ page, request, freshBackend: b }) => {
  const projectPath = await registerProject(request, b, "AutoUI");
  const create = await request.post(`${b.apiBase}/tasks`, {
    headers: auth(b),
    data: {
      title: "Bounded orchestration",
      prompt: "Add comment",
      workdir: projectPath,
      agent: "claude-code",
      model: "opus-5.5",
      column: "ready",
      isolation: "none",
    },
  });
  const task = (await create.json()) as { id: string };
  const employee = await request.post(`${b.apiBase}/employees`, {
    headers: auth(b),
    data: { name: "Bot", jobTitle: "Dev", projectPath },
  });
  const dev = (await employee.json()) as { id: string };
  await request.post(`${b.apiBase}/task-assignments`, { headers: auth(b), data: { taskId: task.id, employeeId: dev.id } });

  await request.post(`${b.apiBase}/tasks/${task.id}/orchestrated-workflow`, {
    headers: auth(b),
    data: {
      implementerEmployeeId: dev.id,
      implementerHarnessId: "claude-code",
      implementerModel: "opus-5.5",
      reviewerHarness: "claude-code",
      reviewerModel: "haiku-5.5",
      maxLaunches: 2,
    },
  });

  const deadline = Date.now() + 90_000;
  while (Date.now() < deadline) {
    const view = await request.get(`${b.apiBase}/tasks/${task.id}/orchestrated-workflow`, { headers: auth(b) });
    if ((await view.json()).workflow?.status === "awaiting_owner") break;
    await new Promise((r) => setTimeout(r, 300));
  }

  await gotoBoard(page, b.bootBase);
  await page.locator(`[data-testid="project-nav-item"][data-path="${projectPath}"]`).click();
  await page.getByRole("button", { name: "Review Bounded orchestration", exact: true }).click();
  await expect(page.getByTestId("orchestrated-workflow")).toBeVisible();
  // Provenance now comes from the persisted Run, not the removed global driver badge.
  await expect(page.getByTestId("orchestrated-workflow").getByTestId("run-execution")).toHaveAttribute("data-execution-type", "synthetic");
  await expect(page.getByTestId("orchestrated-status")).toContainText("awaiting_owner");
  await expect(page.getByTestId("task-qc-awaiting-owner")).toBeVisible();
});
