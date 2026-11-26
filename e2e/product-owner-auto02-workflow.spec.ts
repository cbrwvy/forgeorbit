import { test as base, expect, type APIRequestContext, type Page } from "@playwright/test";
import { spawn, type ChildProcess } from "node:child_process";
import { createWriteStream } from "node:fs";
import { mkdir, mkdtemp, readFile, realpath, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { createServer } from "node:net";
import path from "node:path";
import { E2E_BASE_URL } from "../playwright.config";
import { REPO_ROOT, isolatedCoreEnv, seedIsolatedHarnessHomes, writeFxStubBin } from "./isolated-env";
import { gotoApp } from "./helpers";
import type { Task, Run, TaskQcReview, TaskQcState } from "../src/shared/types.ts";

/** FO-PRODUCT03: Owner UI assignment + two-task FO-AUTO02 batch (fake drivers only). */
interface ProductBackend {
  dataDir: string;
  apiBase: string;
  apiToken: string;
  bootBase: string;
  restart(): Promise<void>;
}

async function stop(child: ChildProcess) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const exited = new Promise<void>((resolve) => child.once("exit", () => resolve()));
  child.kill("SIGTERM");
  await Promise.race([exited, new Promise((resolve) => setTimeout(resolve, 4000))]);
  if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
  await exited;
}

const test = base.extend<{ product: ProductBackend; productEnv: Record<string, string> }>({
  productEnv: [{}, { option: true }],
  product: async ({ productEnv }, use, testInfo) => {
    const dataDir = await realpath(await mkdtemp(path.join(tmpdir(), "fo-product02-")));
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
        AGETOR_FAKE_MANAGER_DELAY_MS: "300",
        AGETOR_ALLOW_LEGACY_QUEUE_POLICY_SCHEMA: "1",
        ...productEnv,
      },
    });
    const logPath = path.join(dataDir, "backend.log");
    const log = createWriteStream(logPath, { flags: "a" });
    let child: ChildProcess | undefined;
    async function start() {
      child = spawn("bun", ["src/bun/headless.ts"], { cwd: REPO_ROOT, env, stdio: ["ignore", "pipe", "pipe"] });
      await writeFile(path.join(dataDir, "backend-pids.log"), `${child.pid}\n`, { flag: "a" });
      child.stdout!.pipe(log, { end: false });
      child.stderr!.pipe(log, { end: false });
      await expect.poll(async () => {
        if (child!.exitCode !== null) throw new Error(`Backend exited: ${await readFile(logPath, "utf8")}`);
        return fetch(`${apiBase}/health`, { signal: AbortSignal.timeout(1000) }).then((r) => r.ok, () => false);
      }, { timeout: 30_000 }).toBe(true);
    }
    try {
      await start();
      await use({
        dataDir,
        apiBase,
        apiToken,
        bootBase: `${E2E_BASE_URL}/#api=${port}&token=${apiToken}`,
        restart: async () => {
          await stop(child!);
          await start();
        },
      });
    } finally {
      if (child) await stop(child);
      await new Promise<void>((resolve) => log.end(resolve));
      for (const name of ["backend.log", "daemon.log"]) {
        await testInfo.attach(name, { path: path.join(dataDir, name), contentType: "text/plain" });
      }
      const directoryArtifact = testInfo.outputPath("isolated-data-directory.txt");
      await writeFile(directoryArtifact, dataDir);
      await testInfo.attach("isolated-data-directory", { path: directoryArtifact, contentType: "text/plain" });
    }
  },
});

test.use({ actionTimeout: 15_000 });

async function api<T>(
  request: APIRequestContext,
  b: ProductBackend,
  method: "get" | "post" | "put" | "patch",
  route: string,
  data?: unknown,
  status = 200,
): Promise<T> {
  const r = await request[method](b.apiBase + route, { headers: { authorization: `Bearer ${b.apiToken}` }, ...(data === undefined ? {} : { data }) });
  const text = await r.text();
  expect(r.status(), `${method} ${route}: ${text}`).toBe(status);
  return JSON.parse(text) as T;
}

async function openWizard(page: Page) {
  await page.getByTestId("workspace-add-project").click();
  await expect(page.getByTestId("project-wizard")).toBeVisible();
}

async function createTaskBacklog(page: Page, title: string, prompt: string) {
  await page.getByTestId("project-new-task").click();
  const panel = page.getByTestId("new-task-panel");
  await expect(panel).toBeVisible();
  await expect(panel.getByTestId("worktree-non-git-notice")).toBeVisible();
  const isolate = panel.getByTestId("isolate-toggle");
  await expect(isolate).not.toBeChecked();
  await expect(isolate).toBeDisabled();
  await panel.getByPlaceholder("Short description").fill(title);
  await panel.locator("textarea").first().fill(prompt);
  await panel.getByRole("button", { name: "To backlog" }).click();
}

async function assignDeveloperOnTask(page: Page, title: string, devName: string) {
  await page.getByRole("button", { name: title, exact: true }).click();
  const panel = page.getByTestId("task-assignment-panel");
  await expect(panel).toBeVisible();
  await panel.getByTestId("task-assignment-pick").selectOption({ label: devName });
  await panel.getByTestId("task-assignment-save").click();
  await expect(panel.getByTestId("task-assignment-current")).toContainText(devName);
  await closeRun(page);
}

async function closeRun(page: Page) {
  await page.getByRole("button", { name: "Close task details", exact: true }).click();
  await expect(page.getByTestId("supervised-live-workflow")).toHaveCount(0);
}

test("FO-PRODUCT03 Owner UI: assign developers, two-task FO-AUTO02 batch, restart, Mark Done", async ({ page, request, product: b }, info) => {
  test.setTimeout(240_000);
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  const writes: string[] = [];
  page.on("request", (r) => {
    if (!["GET", "HEAD", "OPTIONS"].includes(r.method())) writes.push(`${r.method()} ${new URL(r.url()).pathname}`);
  });

  const call = <T>(method: "get" | "post" | "put" | "patch", route: string, data?: unknown, status = 200) =>
    api<T>(request, b, method, route, data, status);

  const projectDir = path.join(b.dataDir, "projects", "batch-co");
  await mkdir(path.join(projectDir, "docs"), { recursive: true });
  await writeFile(path.join(projectDir, "docs", "IDEA.md"), "# Batch Co\nSynthetic FO-PRODUCT02 acceptance.\n");
  await writeFile(path.join(projectDir, "README.md"), "# Batch Co\n");

  await call("patch", "/harnesses/codex", { enabled: true });
  await call("patch", "/harnesses/claude-code", { enabled: true });

  await gotoApp(page, b.bootBase);
  await openWizard(page);
  await page.getByTestId("wizard-name").fill("Batch Co");
  await page.getByTestId("wizard-directory").fill(projectDir);
  await page.getByTestId("wizard-next").click();
  await page.getByTestId("wizard-next").click();
  await page.getByTestId("wizard-next").click();
  await page.getByTestId("wizard-next").click();
  await page.getByTestId("wizard-next").click();
  await page.getByTestId("wizard-submit").click();
  await expect(page.getByTestId("project-header-name")).toHaveText("Batch Co", { timeout: 20_000 });

  const dev = await call<{ id: string; name: string }>("post", "/employees", {
    name: "Batch Developer",
    jobTitle: "Backend Engineer",
    projectPath: projectDir,
  }, 201);

  const preflight = await call<{ isolation: { consentKey: string } }>("post", "/project-interviews/preflight", {
    harness: "codex",
    model: "gpt-6.1-sol",
  });
  await call("put", "/project-manager/config", {
    path: projectDir,
    config: { harness: "codex", model: "gpt-6.1-sol", effort: "low", consentKey: preflight.isolation.consentKey },
  });

  await page.locator(`[data-testid="project-nav-item"][data-path="${projectDir}"]`).click();
  await page.getByTestId("project-page-team").click();
  await expect(page.getByTestId("project-team")).toContainText(dev.name);

  await page.getByTestId("project-page-board").click();
  const prompts = ["Implement feature A", "Implement feature B"];
  const titles = ["Batch Task A", "Batch Task B"];
  for (let i = 0; i < titles.length; i++) {
    await createTaskBacklog(page, titles[i]!, prompts[i]!);
  }

  const allTasks = () => call<Task[]>("get", "/tasks");
  await expect.poll(async () => (await allTasks()).filter((t) => t.workdir === projectDir).length).toBe(2);
  const taskRows = async () => (await allTasks()).filter((t) => t.workdir === projectDir).sort((a, b) => a.title.localeCompare(b.title));

  for (const title of titles) {
    const task = (await taskRows()).find((t) => t.title === title)!;
    await page.getByRole("button", { name: title, exact: true }).click();
    await page.getByTestId("supervised-live-admit").click();
    await expect.poll(async () => (await call<Task>("get", `/tasks/${task.id}`)).column).toBe("inbox");
    await closeRun(page);
    await page.getByRole("button", { name: title, exact: true }).click();
    await page.getByTestId("supervised-live-ready").click();
    await expect.poll(async () => (await call<Task>("get", `/tasks/${task.id}`)).column).toBe("ready");
    await closeRun(page);
  }

  for (const title of titles) {
    await assignDeveloperOnTask(page, title, dev.name);
    const task = (await taskRows()).find((t) => t.title === title)!;
    await expect.poll(async () => (await call<{ assignment: { employeeId: string } | null }>("get", `/task-assignments/task?taskId=${task.id}`)).assignment?.employeeId).toBe(dev.id);
  }

  await page.getByTestId("project-page-manager").click();
  await expect(page.getByTestId("manager-harness")).toHaveValue("codex", { timeout: 20_000 });
  await page.getByTestId("manager-consent").check();
  await expect(page.getByTestId("manager-connection")).toHaveText("Ready", { timeout: 20_000 });

  const rows = await taskRows();
  await page.getByTestId("manager-tab-autonomy").click();
  await expect(page.getByTestId("orchestrated-batch-section")).toBeVisible();

  for (const task of rows) {
    await page.getByTestId(`orchestrated-batch-pick-${task.id}`).check();
  }
  await page.getByTestId("orchestrated-batch-create").click();
  await expect(page.getByTestId("batch-plan-summary")).toBeVisible();
  // Native keyboard focus exposed a second, short scrollport under the legacy
  // batch panel. The complete Owner plan must share Manager's normal scrolling.
  await page.getByTestId("batch-plan-summary").scrollIntoViewIfNeeded();
  await expect(page.getByTestId("batch-plan-summary")).toBeInViewport({ ratio: 1 });

  await expect(page.getByTestId("batch-plan-tasks")).toContainText("Batch Task A");
  await expect(page.getByTestId("batch-plan-tasks")).toContainText("Batch Task B");
  await expect(page.getByTestId("batch-plan-tasks")).toContainText(dev.name);
  await expect(page.getByTestId("batch-reviewer-model")).toHaveValue("haiku-5.5");
  await expect(page.getByTestId("batch-reviewer-role")).toContainText("Code Reviewer");
  await expect(page.getByTestId("batch-reviewer-role-note")).toBeVisible();

  const drafts = await call<{ batch: { id: string; revision: number } }[]>(
    "get",
    `/project-manager/orchestrated-batches?path=${encodeURIComponent(projectDir)}`,
  );
  const draftBatch = drafts[0]?.batch;
  expect(draftBatch, "orchestrated batch draft").toBeTruthy();
  await call(
    "post",
    `/project-manager/orchestrated-batches/${draftBatch!.id}/approve`,
    {
      path: projectDir,
      revision: draftBatch!.revision,
      queuePolicySchema: "legacy-auto02",
      defaults: {
        implementerEmployeeId: dev.id,
        implementerHarnessId: "claude-code",
        implementerModel: "opus-5.5",
        implementerMode: "auto",
        reviewerHarness: "claude-code",
        reviewerModel: "haiku-5.5",
        reviewerMode: "auto",
        autoReviewAfterImplementation: true,
        autoReworkOnChanges: false,
        maxLaunches: 2,
        maxReworkIterations: 0,
      },
      perTask: Object.fromEntries(rows.map((t) => [t.id, {
        implementerEmployeeId: dev.id,
        implementerHarnessId: "claude-code",
        implementerModel: "opus-5.5",
        implementerMode: "auto",
      }])),
      validMinutes: 240,
    },
  );
  await expect.poll(async () => (await call<{ batch: { status: string } }[]>(
    "get",
    `/project-manager/orchestrated-batches?path=${encodeURIComponent(projectDir)}`,
  ))[0]?.batch.status).toBe("approved");
  await page.reload();
  await page.locator(`[data-testid="project-nav-item"][data-path="${projectDir}"]`).click();
  await page.getByTestId("project-page-manager").click();
  await page.getByTestId("manager-tab-autonomy").click();
  const batchRowAfterReload = page.locator(`[data-testid="orchestrated-batch-row"]`).filter({ hasText: "Bounded employee batch" });
  await expect(batchRowAfterReload).toBeVisible({ timeout: 15_000 });
  await batchRowAfterReload.first().click();

  await expect(page.getByTestId("orchestrated-batch-status")).toHaveText("approved", { timeout: 15_000 });
  await expect(page.getByTestId("orchestrated-batch-start-hint")).toHaveCount(0);
  await page.getByTestId("orchestrated-batch-start").click();

  await expect.poll(async () => {
    const views = await call<{ batch: { status: string }; tasks: { phase: string }[] }[]>(
      "get",
      `/project-manager/orchestrated-batches?path=${encodeURIComponent(projectDir)}`,
    );
    const view = views[0];
    if (!view) return "";
    if (view.batch.status === "completed") return "completed";
    if (view.tasks.every((t) => t.phase === "awaiting_owner")) return "awaiting";
    return view.batch.status;
  }, { timeout: 120_000 }).toMatch(/completed|awaiting/);

  await expect(page.getByTestId("orchestrated-batch-status")).toHaveText(/completed|paused|running/);
  await expect.poll(async () => page.getByTestId("orchestrated-batch-status").textContent()).toContain("completed");
  await expect(page.getByTestId("orchestrated-batch-fake-badge")).toBeVisible();

  for (const task of rows) {
    await expect.poll(async () => (await call<Task>("get", `/tasks/${task.id}`)).column).toBe("review");
    const qc = await call<{ state: TaskQcState; reviews: TaskQcReview[] }>("get", `/tasks/${task.id}/qc`);
    expect(qc.state.latestVerdict).toBe("PASS");
    expect(qc.state.awaitingOwnerApproval).toBe(true);
    const runs = await call<Run[]>("get", `/tasks/${task.id}/runs`);
    expect(runs.length).toBe(2);
  }

  await b.restart();
  await page.reload();
  for (const task of rows) {
    expect((await call<Task>("get", `/tasks/${task.id}`)).column).toBe("review");
    expect((await call<{ state: TaskQcState }>("get", `/tasks/${task.id}/qc`)).state.awaitingOwnerApproval).toBe(true);
  }

  await page.getByTestId("workspace-overview").click(); await page.getByTestId("workspace-attention").click();
  for (const title of titles) {
    const row = page.getByTestId("attention-row").filter({ hasText: title });
    await expect(row).toHaveAttribute("data-kind", "qc-owner");
    await row.getByTestId("attention-open").click();
    await expect(page.getByTestId("task-qc-history")).toContainText("PASS");
    await expect(page.getByTestId("task-qc-awaiting-owner")).toBeVisible();
    await page.getByTestId("runs-list").getByRole("button").click();
    await expect(page.getByTestId("runs-list")).toContainText("Run #2");
    await page.getByTestId("supervised-live-done").click();
    await expect.poll(async () => {
      const t = (await allTasks()).find((x) => x.title === title)!;
      return t.column;
    }).toBe("done");
    await closeRun(page);
  }

  await expect(page.getByTestId("attention-row").filter({ hasText: titles[0]! })).toHaveCount(0);
  await expect(page.getByTestId("attention-row").filter({ hasText: titles[1]! })).toHaveCount(0);
  await expect(page.getByTestId("attention-empty")).toBeVisible();
  await page.locator(`[data-testid="project-nav-item"][data-path="${projectDir}"]`).click();
  await page.getByTestId("project-page-overview").click();
  await expect(page.getByTestId("project-stat-done")).toContainText("2");

  expect(errors).toEqual([]);
  const assignmentApiWrites = writes.filter((line) => line.startsWith("POST /task-assignments"));
  expect(assignmentApiWrites.length, assignmentApiWrites.join("\n")).toBeGreaterThanOrEqual(2);
  const writesPath = info.outputPath("owner-ui-writes.txt");
  await writeFile(writesPath, writes.join("\n"));
  await info.attach("owner-ui-writes", { path: writesPath, contentType: "text/plain" });
});
