/**
 * FO-AUTO03-SAFE-DEFAULT01. Manager UI: gated policy summary on draft; no /tasks/:id/start without grant.
 * Isolated fake backend only.
 */
import { spawn, type ChildProcess } from "node:child_process";
import { createWriteStream } from "node:fs";
import { mkdir, mkdtemp, readFile, realpath, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { expect, test, type APIRequestContext } from "@playwright/test";
import { E2E_BASE_URL } from "../playwright.config";
import { REPO_ROOT, isolatedCoreEnv, seedIsolatedHarnessHomes, writeFxStubBin } from "./isolated-env";
import { gotoApp } from "./helpers";

interface MiniBackend {
  dataDir: string;
  apiBase: string;
  apiToken: string;
  bootBase: string;
}

async function stop(child: ChildProcess) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const exited = new Promise<void>((resolve) => child.once("exit", () => resolve()));
  child.kill("SIGTERM");
  await Promise.race([exited, new Promise((resolve) => setTimeout(resolve, 4000))]);
  if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
  await exited;
}

async function api<T>(
  request: APIRequestContext,
  b: MiniBackend,
  method: "get" | "post" | "patch",
  route: string,
  data?: unknown,
  status = 200,
): Promise<T> {
  const r = await request[method](b.apiBase + route, {
    headers: { authorization: `Bearer ${b.apiToken}` },
    ...(data === undefined ? {} : { data }),
  });
  const text = await r.text();
  expect(r.status(), `${method} ${route}: ${text}`).toBe(status);
  return JSON.parse(text) as T;
}

test("FO-AUTO03-SAFE-DEFAULT01 Manager: policy summary and wait for developer grant", async ({ page, request }, info) => {
  test.setTimeout(120_000);
  const dataDir = await realpath(await mkdtemp(path.join(tmpdir(), "fo-safe-default01-")));
  const reservation = createServer();
  await new Promise<void>((resolve) => reservation.listen(0, "127.0.0.1", resolve));
  const port = (reservation.address() as { port: number }).port;
  await new Promise<void>((resolve) => reservation.close(() => resolve()));

  const apiToken = crypto.randomUUID();
  const apiBase = `http://127.0.0.1:${port}`;
  const fxBin = writeFxStubBin(dataDir);
  const seeded = seedIsolatedHarnessHomes(dataDir, fxBin);
  expect(seeded.ok, JSON.stringify(seeded)).toBe(true);
  const env = isolatedCoreEnv({
    dataDir,
    apiPort: port,
    apiToken,
    fxBin,
    extra: {
      CI: "1",
      AGETOR_CLAUDE_DRIVER: "fake",
      AGETOR_FAKE_QC_VERDICT: "PASS",
      AGETOR_USAGE_OFFLINE: "1",
      AGETOR_DISABLE_UPDATES: "1",
    },
  });
  const logPath = path.join(dataDir, "backend.log");
  const log = createWriteStream(logPath, { flags: "a" });
  const child = spawn("bun", ["src/bun/headless.ts"], { cwd: REPO_ROOT, env, stdio: ["ignore", "pipe", "pipe"] });
  child.stdout!.pipe(log, { end: false });
  child.stderr!.pipe(log, { end: false });
  try {
    await expect.poll(async () => {
      if (child.exitCode !== null) throw new Error(`Backend exited: ${await readFile(logPath, "utf8")}`);
      return fetch(`${apiBase}/health`, { signal: AbortSignal.timeout(1000) }).then((r) => r.ok, () => false);
    }, { timeout: 30_000 }).toBe(true);

    const b: MiniBackend = {
      dataDir,
      apiBase,
      apiToken,
      bootBase: `${E2E_BASE_URL}/#api=${port}&token=${apiToken}`,
    };

    const projectDir = path.join(dataDir, "proj");
    await mkdir(path.join(projectDir, "docs"), { recursive: true });
    await writeFile(path.join(projectDir, "README.md"), "# SD01\n");
    await api(request, b, "post", "/projects", { path: projectDir, name: "Safe defaults" }, 200);

    await api(request, b, "patch", "/harnesses/claude-code", { enabled: true });

    const task = await api<{ id: string }>(request, b, "post", "/tasks", {
      title: "SD01 task",
      prompt: "Wait.",
      workdir: projectDir,
      column: "ready",
      agent: "claude-code",
      mode: "auto",
      model: "opus-5.5",
      effort: "low",
      isolation: "none",
    }, 200);

    const dev = await api<{ id: string }>(request, b, "post", "/employees", {
      name: "SD01 Dev",
      jobTitle: "Eng",
      projectPath: projectDir,
    }, 201);

    await api(request, b, "post", "/task-assignments", { taskId: task.id, employeeId: dev.id }, 201);

    const draft = await api<{ batch: { id: string; revision: number } }>(request, b, "post", "/project-manager/orchestrated-batches", {
      path: projectDir,
      taskIds: [task.id],
      title: "SD01",
    }, 201);

    const taskStarts: string[] = [];
    page.on("request", (req) => {
      if (req.method() === "POST" && /\/tasks\/[^/]+\/start$/.test(new URL(req.url()).pathname)) taskStarts.push(req.url());
    });

    await gotoApp(page, b.bootBase);
    await page.locator(`[data-testid="project-nav-item"][data-path="${projectDir}"]`).click();
    await page.getByTestId("project-page-manager").click();
    await page.getByTestId("manager-consent").check();
    await expect(page.getByTestId("manager-connection")).toHaveText("Ready", { timeout: 20_000 });
    await page.getByTestId("manager-tab-autonomy").click();
    await page.locator(`[data-testid="orchestrated-batch-row"][data-batch-id="${draft.batch.id}"]`).click();

    await expect(page.getByTestId("batch-policy-evidence")).toContainText("observed-test");
    await expect(page.getByTestId("batch-policy-completion")).toContainText("owner-done");
    await expect(page.getByTestId("batch-policy-workspace")).toContainText("true");
    await expect(page.getByTestId("batch-review-without-observed-test")).not.toBeChecked();

    await page.getByTestId("orchestrated-batch-approve").click();
    await expect(page.getByTestId("orchestrated-batch-status")).toHaveText("approved", { timeout: 20_000 });
    await page.getByTestId("orchestrated-batch-start").click();
    await expect(page.getByTestId("orchestrated-queue-gate")).toBeVisible({ timeout: 15_000 });
    await expect(page.getByTestId("orchestrated-queue-disposition")).toHaveText("Waiting");
    expect(taskStarts).toEqual([]);
    const runs = await api<unknown[]>(request, b, "get", `/tasks/${task.id}/runs`);
    expect(runs).toEqual([]);
  } finally {
    await stop(child);
    await new Promise<void>((resolve) => log.end(resolve));
    await info.attach("backend.log", { path: logPath, contentType: "text/plain" });
  }
});
