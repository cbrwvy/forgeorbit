import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test, expect, type APIRequestContext, type E2EBackend } from "./fixtures";
import { gotoBoard } from "./helpers";

function auth(backend: E2EBackend): { authorization: string } {
  return { authorization: `Bearer ${backend.apiToken}` };
}

async function registerProject(request: APIRequestContext, backend: E2EBackend, name: string): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), `fo-qc-${name.replace(/\W+/g, "-")}-`));
  await mkdir(path.join(dir, "docs"), { recursive: true });
  await writeFile(path.join(dir, "docs/IDEA.md"), "# Idea\n");
  const res = await request.post(`${backend.apiBase}/projects`, { headers: auth(backend), data: { path: dir, name } });
  expect(res.ok(), await res.text()).toBeTruthy();
  return (await res.json()).path as string;
}

test.use({ backendEnv: { AGETOR_FAKE_QC_VERDICT: "PASS" } });

test.describe.configure({ timeout: 60_000 });

test("supervised QC review surfaces in run panel", async ({ page, request, freshBackend: b }) => {
  const projectPath = await registerProject(request, b, "QC UI");
  const create = await request.post(`${b.apiBase}/tasks`, {
    headers: auth(b),
    data: {
      title: "QC e2e task",
      prompt: "Say hello in a comment",
      workdir: projectPath,
      agent: "claude-code",
      model: "opus-5.5",
      effort: "high",
      isolation: "none",
      column: "ready",
    },
  });
  expect(create.ok(), await create.text()).toBeTruthy();
  const task = (await create.json()) as { id: string };
  const start = await request.post(`${b.apiBase}/tasks/${task.id}/start`, { headers: auth(b) });
  expect(start.ok(), await start.text()).toBeTruthy();
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    const row = await request.get(`${b.apiBase}/tasks/${task.id}`, { headers: auth(b) });
    const t = (await row.json()) as { column: string };
    if (t.column === "review") break;
    await new Promise((r) => setTimeout(r, 200));
  }
  const afterImpl = await request.get(`${b.apiBase}/tasks/${task.id}`, { headers: auth(b) });
  expect((await afterImpl.json()).column).toBe("review");

  await gotoBoard(page, b.bootBase);
  await page.locator(`[data-testid="project-nav-item"][data-path="${projectPath}"]`).click();
  await page.getByRole("button", { name: "Review QC e2e task", exact: true }).click();
  await expect(page.getByTestId("task-quality-control")).toBeVisible();
  await page.getByTestId("task-qc-request").click();
  while (Date.now() < deadline) {
    const qc = await request.get(`${b.apiBase}/tasks/${task.id}/qc`, { headers: auth(b) });
    const bundle = (await qc.json()) as { state: { latestVerdict?: string } };
    if (bundle.state.latestVerdict === "PASS") break;
    await new Promise((r) => setTimeout(r, 200));
  }
  await expect(page.getByTestId("task-qc-awaiting-owner")).toBeVisible({ timeout: 15_000 });
  await expect(page.getByTestId("task-qc-history")).toContainText("PASS");
});
