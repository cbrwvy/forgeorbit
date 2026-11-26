import { Database } from "bun:sqlite";
import { test as base, expect, type APIRequestContext, type Page } from "@playwright/test";
import { spawn, type ChildProcess } from "node:child_process";
import { createWriteStream } from "node:fs";
import { mkdir, mkdtemp, readFile, realpath, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { createServer } from "node:net";
import path from "node:path";
import { E2E_BASE_URL } from "../playwright.config";
import { REPO_ROOT, isolatedCoreEnv, seedIsolatedHarnessHomes, writeFxStubBin } from "./isolated-env";
import { writeCodexProfileFixture, writeSyntheticCodexProfile } from "./codex-profile-fixture";
import { gotoApp } from "./helpers";

/** Browser UI acceptance for FO-ROUTING03. API calls only seed fixtures and read results. */
interface Backend {
  dataDir: string;
  apiBase: string;
  apiToken: string;
  bootBase: string;
  restart(): Promise<void>;
}

const test = base.extend<{ backend: Backend }>({
  backend: async ({}, use, info) => {
    const root = await realpath(await mkdtemp(path.join(tmpdir(), "fo-routing03-accept-")));
    const dataDir = path.join(root, "data");
    await mkdir(dataDir);
    const owner = path.join(root, "owner");
    await mkdir(owner);
    const port = await new Promise<number>((resolve) => {
      const server = createServer();
      server.listen(0, "127.0.0.1", () => {
        const address = server.address();
        const value = address && typeof address !== "string" ? address.port : 0;
        server.close(() => resolve(value));
      });
    });
    const apiToken = crypto.randomUUID();
    const apiBase = `http://127.0.0.1:${port}`;
    const fxBin = writeFxStubBin(dataDir);
    expect(seedIsolatedHarnessHomes(dataDir, fxBin).ok).toBe(true);
    const env = isolatedCoreEnv({
      dataDir,
      apiPort: port,
      apiToken,
      fxBin,
      extra: {
        CI: "1",
        HOME: owner,
        AGETOR_CODEX_BIN: writeCodexProfileFixture(root, process.execPath),
        AGETOR_CODEX_DRIVER: "fake",
        AGETOR_CLAUDE_DRIVER: "fake",
        AGETOR_FAKE_QC_VERDICT: "PASS",
        AGETOR_FAKE_MANAGER_DELAY_MS: "200",
      },
    });
    const log = createWriteStream(path.join(dataDir, "backend.log"), { flags: "a" });
    let child: ChildProcess | undefined;
    async function start() {
      child = spawn("bun", ["src/bun/headless.ts"], { cwd: REPO_ROOT, env, stdio: ["ignore", "pipe", "pipe"] });
      child.stdout?.pipe(log, { end: false });
      child.stderr?.pipe(log, { end: false });
      await expect.poll(async () => fetch(`${apiBase}/health`).then((r) => r.ok, () => false), { timeout: 30_000 }).toBe(true);
    }
    async function stop(proc: ChildProcess) {
      if (proc.exitCode !== null) return;
      proc.kill("SIGTERM");
      await new Promise((resolve) => proc.once("exit", resolve));
    }
    try {
      await start();
      await use({ dataDir, apiBase, apiToken, bootBase: `${E2E_BASE_URL}/#api=${port}&token=${apiToken}`, restart: async () => { await stop(child!); await start(); } });
    } finally {
      if (child) await stop(child);
      await info.attach("backend-log", { path: path.join(dataDir, "backend.log"), contentType: "text/plain" });
    }
  },
});

async function call(request: APIRequestContext, b: Backend, method: "get" | "post" | "put" | "patch", route: string, data?: unknown) {
  const response = await request[method](b.apiBase + route, { headers: { authorization: `Bearer ${b.apiToken}` }, ...(data === undefined ? {} : { data }) });
  expect(response.ok(), await response.text()).toBeTruthy();
  return response.json();
}

test("FO-ROUTING03-ACCEPT01 Owner allocation UI, AUTO02 execution and restart", async ({ page, request, backend }) => {
  test.setTimeout(240_000);
  const owner = path.join(path.dirname(backend.dataDir), "owner");
  const dirs = [path.join(owner, "profile-a"), path.join(owner, "profile-b")];
  dirs.forEach((dir, i) => writeSyntheticCodexProfile(dir, `subject-${i}`));
  await gotoApp(page, backend.bootBase);
  await page.locator('button[aria-label="Settings"][title="Settings"]').click();
  await page.getByRole("navigation", { name: "Settings sections" }).getByRole("button", { name: "AI providers and accounts", exact: true }).click();
  for (let i = 0; i < 2; i++) {
    await page.getByTestId("codex-profile-add").click();
    await page.getByTestId("codex-profile-name").fill(i === 0 ? "Profile A" : "Profile B");
    await page.getByTestId("codex-profile-directory").fill(dirs[i]!);
    await page.getByTestId("codex-profile-save").click();
  }
  for (const name of ["Profile A", "Profile B"]) {
    const card = page.getByTestId("codex-profile-card").filter({ hasText: name });
    await card.getByTestId("codex-profile-check").click();
    await expect(card.getByTestId("codex-profile-status")).toContainText("Ready");
  }
  const profiles = await call(request, backend, "get", "/account-core/codex-profiles") as Array<{ accountId: string; harnessId: string; displayName: string; directory: string }>;
  const profileA = profiles.find((p) => p.displayName === "Profile A")!;
  const profileB = profiles.find((p) => p.displayName === "Profile B")!;
  const db = new Database(path.join(backend.dataDir, "agetor.sqlite"));
  for (const profile of [profileA, profileB]) {
    db.run("INSERT INTO account_model_capabilities VALUES (?, ?, ?, ?)", [profile.accountId, profile.harnessId, "gpt-6.1-sol", JSON.stringify({ accountId: profile.accountId, harnessId: profile.harnessId, modelId: "gpt-6.1-sol", support: "supported", verification: "verified", provenance: "verified", source: "offline:fo-routing03-accept01", observedAt: Date.now(), expiresAt: Date.now() + 600_000 })]);
  }
  db.close();
  await page.getByRole("button", { name: "Close", exact: true }).click();
  const projectDir = path.join(path.dirname(backend.dataDir), "project");
  await mkdir(projectDir);
  await call(request, backend, "post", "/projects", { path: projectDir, name: "Accept Co" });
  await call(request, backend, "patch", "/harnesses/codex", { enabled: true });
  const developer = await call(request, backend, "post", "/employees", { name: "Developer A", jobTitle: "Developer", projectPath: projectDir });
  const preflight = await call(request, backend, "post", "/project-interviews/preflight", { harness: "codex", model: "gpt-6.1-sol" });
  await call(request, backend, "put", "/project-manager/config", { path: projectDir, config: { harness: profileA.harnessId, model: "gpt-6.1-sol", effort: "low", consentKey: preflight.isolation.consentKey } });
  const tasks = [];
  for (const [title, profile] of [["Alloc A", profileA], ["Alloc B", profileB]] as const) {
    const created = await call(request, backend, "post", "/tasks", { title, prompt: "Synthetic", workdir: projectDir, agent: profile.harnessId, model: "gpt-6.1-sol", effort: "low", mode: "auto", isolation: "none", column: "backlog" });
    const task = created.task ?? created;
    await call(request, backend, "post", `/tasks/${task.id}/admit-inbox`);
    await call(request, backend, "patch", `/tasks/${task.id}`, { column: "ready" });
    await call(request, backend, "post", "/task-assignments", { taskId: task.id, employeeId: developer.id });
    tasks.push(task);
  }
  await page.reload();
  await page.locator(`[data-testid="project-nav-item"][data-path="${projectDir}"]`).click();
  await page.getByTestId("project-page-manager").click();
  await page.getByTestId("manager-consent").check();
  await page.getByTestId("manager-tab-autonomy").click();
  for (const task of tasks) await page.getByTestId(`orchestrated-batch-pick-${task.id}`).check();
  await page.getByTestId("orchestrated-batch-create").click();
  await page.getByTestId("batch-resource").selectOption(profileA.harnessId);
  await page.getByTestId("batch-reviewer-resource").selectOption(profileB.harnessId);
  const plan = page.getByTestId("allocation-plan-review");
  await plan.getByTestId("allocation-plan-propose").click();
  await expect(plan.getByTestId("allocation-plan-task-" + tasks[0].id).getByTestId("allocation-plan-developer")).toHaveAttribute("data-account", profileA.accountId);
  await expect(plan.getByTestId("allocation-plan-task-" + tasks[1].id).getByTestId("allocation-plan-developer")).toHaveAttribute("data-account", profileB.accountId);
  await expect(plan.getByTestId("allocation-plan-reviewer-resource")).toHaveAttribute("data-account", profileB.accountId);
  await expect(plan.getByTestId("allocation-plan-reviewer-resource")).toHaveAttribute("data-mode", "ask");
  await expect(plan.getByTestId("allocation-plan-reviewer-resource")).toHaveAttribute("data-model", "gpt-6.1-sol");
  await expect(page.getByTestId("batch-plan-reviewer")).toContainText("gpt-6.1-sol");
  await expect(page.getByTestId("batch-plan-reviewer")).toContainText("ask");
  await expect(page.getByTestId("batch-plan-reviewer")).toContainText("low");
  await page.getByTestId("batch-reviewer-model").fill("gpt-5");
  await expect(page.getByTestId("allocation-reviewer-drift")).toBeVisible();
  await expect(page.getByTestId("batch-plan-reviewer-drift")).toBeVisible();
  await expect(plan.getByTestId("allocation-plan-approve")).toBeDisabled();
  await expect(page.getByTestId("orchestrated-batch-approve")).toBeDisabled();
  await plan.getByTestId("allocation-plan-recalculate").click();
  await expect(plan.getByTestId("allocation-plan-reviewer-resource")).toHaveAttribute("data-model", "gpt-5");
  await expect(plan.getByTestId("allocation-plan-status")).toContainText("proposed");
  await page.getByTestId("batch-reviewer-model").fill("gpt-6.1-sol");
  await plan.getByTestId("allocation-plan-recalculate").click();
  await expect(plan.getByTestId("allocation-plan-reviewer-resource")).toHaveAttribute("data-model", "gpt-6.1-sol");
  await expect(plan.getByTestId("allocation-plan-approve")).toBeEnabled();
  const first = plan.getByTestId(`allocation-plan-task-${tasks[0].id}`);
  await first.getByTestId("resource-comparison-toggle").click();
  await first.locator(`[data-testid="executor-option"][data-harness="${profileB.harnessId}"]`).getByTestId("executor-use").click();
  await expect(first.getByTestId("allocation-plan-developer")).toHaveAttribute("data-account", profileB.accountId);
  await plan.getByTestId("allocation-plan-recalculate").click();
  await expect(first.getByTestId("allocation-plan-developer")).toHaveAttribute("data-harness", profileB.harnessId);
  await plan.getByTestId("allocation-plan-approve").click();
  await expect(plan.getByTestId("allocation-plan-status")).toContainText("approved");
  await plan.getByTestId("allocation-plan-apply").click();
  await expect(plan.getByTestId("allocation-plan-status")).toContainText("applied");
  const appliedA = await call(request, backend, "get", `/tasks/${tasks[0].id}`);
  const appliedB = await call(request, backend, "get", `/tasks/${tasks[1].id}`);
  expect(appliedA.agent).toBe(profileB.harnessId);
  expect(appliedB.agent).toBe(profileB.harnessId);
  const harnesses = await call(request, backend, "get", "/harnesses");
  expect(harnesses.harnesses.find((h: { id: string }) => h.id === profileB.harnessId).env.CODEX_HOME).toBe(profileB.directory);
  expect((await call(request, backend, "get", `/tasks/${tasks[0].id}/runs`)).length ?? 0).toBe(0);
  expect((await call(request, backend, "get", "/project-manager/orchestrated-batches?path=" + encodeURIComponent(projectDir)))[0].batch.status).toBe("draft");
  await page.getByTestId("orchestrated-batch-approve").click();
  await expect(page.getByTestId("orchestrated-batch-status")).toHaveText("approved");
  await page.getByTestId("orchestrated-batch-start").click();
  await expect(page.getByTestId("orchestrated-batch-status")).toHaveText("completed", { timeout: 120_000 });
  await backend.restart();
  await page.reload();
  await page.locator(`[data-testid="project-nav-item"][data-path="${projectDir}"]`).click();
  await page.getByTestId("project-page-board").click();
  for (const task of tasks) {
    const runs = await call(request, backend, "get", `/tasks/${task.id}/runs`);
    expect(runs.length).toBeGreaterThan(0);
    await page.getByRole("button", { name: task.title, exact: true }).click();
    await page.getByTestId("supervised-live-done").click();
    await page.getByRole("button", { name: "Close task details", exact: true }).click();
  }
});
