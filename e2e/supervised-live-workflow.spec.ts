import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test, expect, type APIRequestContext, type E2EBackend, type Page } from "./fixtures";
import { gotoApp, gotoBoard } from "./helpers";

test.describe.configure({ mode: "serial", timeout: 120_000 });
test.use({ backendEnv: { AGETOR_CLAUDE_DRIVER: "fake", AGETOR_FAKE_QC_VERDICT: "PASS" } });

function auth(backend: E2EBackend): { authorization: string } {
  return { authorization: `Bearer ${backend.apiToken}` };
}

async function registerProject(request: APIRequestContext, backend: E2EBackend, name: string): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), `fo-live-${name.replace(/\W+/g, "-")}-`));
  await mkdir(path.join(dir, "docs"), { recursive: true });
  await writeFile(path.join(dir, "docs/IDEA.md"), "# Idea\n");
  await writeFile(path.join(dir, "README.md"), "// sample\nexport const hello = () => 'hi';\n");
  const res = await request.post(`${backend.apiBase}/projects`, { headers: auth(backend), data: { path: dir, name } });
  expect(res.ok(), await res.text()).toBeTruthy();
  return (await res.json()).path as string;
}

async function employeeRun(request: APIRequestContext, backend: E2EBackend, taskId: string) {
  await request.post(`${backend.apiBase}/employee-execution/preflight`, {
    headers: auth(backend),
    data: { taskId, harnessId: "claude-code" },
  });
  const review = await request.post(`${backend.apiBase}/employee-execution/reviews`, {
    headers: auth(backend),
    data: { taskId, harnessId: "claude-code" },
  });
  expect(review.ok(), await review.text()).toBeTruthy();
  const attempt = (await review.json()) as { attempt: { id: string; revision: number } };
  const start = await request.post(`${backend.apiBase}/employee-execution/attempts/${attempt.attempt.id}/start`, {
    headers: auth(backend),
    data: { revision: attempt.attempt.revision, confirm: true, acknowledgeUsage: true },
  });
  expect(start.ok(), await start.text()).toBeTruthy();
}

test("FO-LIVE01 supervised chain: intake → employee run → QC → owner done", async ({ page, request, freshBackend: b }) => {
  const projectPath = await registerProject(request, b, "LiveChain");
  await request.post(`${b.apiBase}/projects/rules`, {
    headers: auth(b),
    data: { path: projectPath, title: "Guidance", body: "Keep changes minimal." },
  });

  const create = await request.post(`${b.apiBase}/tasks`, {
    headers: auth(b),
    data: {
      title: "Supervised live task",
      prompt: "Add a comment to README",
      workdir: projectPath,
      agent: "claude-code",
      model: "opus-5.5",
      effort: "high",
      isolation: "none",
      column: "backlog",
    },
  });
  expect(create.ok()).toBeTruthy();
  const task = (await create.json()) as { id: string };

  expect((await request.post(`${b.apiBase}/tasks/${task.id}/start`, { headers: auth(b) })).status()).toBe(400);
  await request.post(`${b.apiBase}/tasks/${task.id}/admit-inbox`, { headers: auth(b) });
  await request.patch(`${b.apiBase}/tasks/${task.id}`, { headers: auth(b), data: { column: "ready" } });

  const employee = await request.post(`${b.apiBase}/employees`, {
    headers: auth(b),
    data: { name: "Dev Bot", jobTitle: "Engineer", projectPath },
  });
  expect(employee.status()).toBe(201);
  const dev = (await employee.json()) as { id: string };
  await request.post(`${b.apiBase}/task-assignments`, { headers: auth(b), data: { taskId: task.id, employeeId: dev.id } });

  await employeeRun(request, b, task.id);

  const deadline = Date.now() + 45_000;
  while (Date.now() < deadline) {
    const row = await request.get(`${b.apiBase}/tasks/${task.id}`, { headers: auth(b) });
    if ((await row.json()).column === "review") break;
    await new Promise((r) => setTimeout(r, 200));
  }
  expect((await (await request.get(`${b.apiBase}/tasks/${task.id}`, { headers: auth(b) })).json()).column).toBe("review");

  const wf = await request.get(`${b.apiBase}/tasks/${task.id}/supervised-workflow`, { headers: auth(b) });
  expect(wf.ok()).toBeTruthy();
  expect((await wf.json()).usesFakeDriver).toBe(true);

  const prep = await request.post(`${b.apiBase}/tasks/${task.id}/qc/reviews`, {
    headers: auth(b),
    data: { reviewerHarness: "claude-code", reviewerModel: "haiku-5.5" },
  });
  const { review } = (await prep.json()) as { review: { id: string; reviewerModel: string } };
  expect(review.reviewerModel).toBe("haiku-5.5");
  await request.post(`${b.apiBase}/tasks/${task.id}/qc/reviews/${review.id}/start`, { headers: auth(b) });

  while (Date.now() < deadline) {
    const qc = await request.get(`${b.apiBase}/tasks/${task.id}/qc`, { headers: auth(b) });
    if ((await qc.json()).state.latestVerdict === "PASS") break;
    await new Promise((r) => setTimeout(r, 200));
  }

  await gotoBoard(page, b.bootBase);
  await page.locator(`[data-testid="project-nav-item"][data-path="${projectPath}"]`).click();
  await page.getByRole("button", { name: "Review Supervised live task", exact: true }).click();
  await expect(page.getByTestId("supervised-live-workflow")).toBeVisible();
  await expect(page.getByTestId("supervised-live-fake-badge")).toBeVisible();
  await expect(page.getByTestId("task-qc-awaiting-owner")).toBeVisible();

  const qc = await request.get(`${b.apiBase}/tasks/${task.id}/qc`, { headers: auth(b) });
  expect((await qc.json()).state.awaitingOwnerApproval).toBe(true);

  const done = await request.patch(`${b.apiBase}/tasks/${task.id}`, { headers: auth(b), data: { column: "done" } });
  expect(done.ok()).toBeTruthy();
});

test("backlog start remains blocked", async ({ request, freshBackend: b }) => {
  const projectPath = await registerProject(request, b, "Block");
  const create = await request.post(`${b.apiBase}/tasks`, {
    headers: auth(b),
    data: { title: "Blocked", prompt: "x", workdir: projectPath, agent: "claude-code", model: "opus-5.5", column: "backlog" },
  });
  const task = (await create.json()) as { id: string };
  expect((await request.post(`${b.apiBase}/tasks/${task.id}/start`, { headers: auth(b) })).status()).toBe(400);
});
