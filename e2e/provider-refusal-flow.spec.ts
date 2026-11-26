import { createWriteStream } from "node:fs";
import { mkdir, mkdtemp, readFile, realpath, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawn, type ChildProcess } from "node:child_process";
import { test as base, expect, type APIRequestContext, type Page } from "@playwright/test";
import { E2E_BASE_URL } from "../playwright.config";
import { REPO_ROOT, isolatedCoreEnv, seedIsolatedHarnessHomes, writeFxStubBin } from "./isolated-env";
import { writeCodexProfileFixture, writeSyntheticCodexProfile } from "./codex-profile-fixture";
import { gotoApp, openAllTasks, openExecutionPlans } from "./helpers";

/**
 * One provider usage-limit refusal, rendered end to end with two synthetic Codex accounts. The fake
 * Codex driver ends a Developer or Reviewer run the way a Codex process ends on a usage-limit refusal.
 * No provider, credential, Keychain item, real profile or live model is involved.
 */
interface Backend { dataDir: string; apiBase: string; apiToken: string; bootBase: string; restart(): Promise<void> }

async function stop(child: ChildProcess) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const exited = new Promise<void>((resolve) => child.once("exit", () => resolve()));
  child.kill("SIGTERM");
  await Promise.race([exited, new Promise((resolve) => setTimeout(resolve, 4000))]);
  if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
  await exited;
}

const test = base.extend<{ product: Backend }>({
  product: async ({}, use, testInfo) => {
    const root = await realpath(await mkdtemp(path.join(tmpdir(), "provider-refusal-e2e-")));
    const dataDir = path.join(root, "data"); await mkdir(dataDir);
    const ownerHome = path.join(root, "owner"); await mkdir(ownerHome);
    const codexBin = writeCodexProfileFixture(root, process.execPath);
    const reservation = createServer();
    await new Promise<void>((resolve) => reservation.listen(0, "127.0.0.1", resolve));
    const port = (reservation.address() as { port: number }).port;
    await new Promise<void>((resolve) => reservation.close(() => resolve()));
    const apiToken = crypto.randomUUID();
    const apiBase = `http://127.0.0.1:${port}`;
    const fxBin = writeFxStubBin(dataDir);
    expect(seedIsolatedHarnessHomes(dataDir, fxBin).ok).toBe(true);
    const verdicts = path.join(root, "qc-verdicts.txt");
    await writeFile(verdicts, "");
    const env = isolatedCoreEnv({
      dataDir, apiPort: port, apiToken, fxBin,
      extra: { CI: "1", HOME: ownerHome, AGETOR_CODEX_BIN: codexBin, AGETOR_FAKE_QC_VERDICT_FILE: verdicts },
    });
    const logPath = path.join(dataDir, "backend.log");
    const log = createWriteStream(logPath, { flags: "a" });
    let child: ChildProcess | undefined;
    async function start() {
      child = spawn("bun", ["src/bun/headless.ts"], { cwd: REPO_ROOT, env, stdio: ["ignore", "pipe", "pipe"] });
      child.stdout!.pipe(log, { end: false });
      child.stderr!.pipe(log, { end: false });
      await expect.poll(async () => {
        if (child!.exitCode !== null) throw new Error(`Backend exited: ${await readFile(logPath, "utf8")}`);
        return fetch(`${apiBase}/health`, { signal: AbortSignal.timeout(1000) }).then((r) => r.ok, () => false);
      }, { timeout: 30_000 }).toBe(true);
    }
    try {
      await start();
      await use({ dataDir: root, apiBase, apiToken, bootBase: `${E2E_BASE_URL}/#api=${port}&token=${apiToken}`, restart: async () => { await stop(child!); await start(); } });
    } finally {
      if (child) await stop(child);
      await new Promise<void>((resolve) => log.end(resolve));
      await testInfo.attach("backend.log", { path: logPath, contentType: "text/plain" });
    }
  },
});
test.use({ actionTimeout: 15_000 });

const NOV = "Nov 16th, 2026 9:31 PM";

async function api<T = any>(request: APIRequestContext, b: Backend, method: "get" | "post" | "put" | "patch", route: string, data?: unknown, status = 200): Promise<T> {
  const res = await request[method](b.apiBase + route, { headers: { authorization: `Bearer ${b.apiToken}` }, ...(data === undefined ? {} : { data }) });
  const text = await res.text();
  expect(res.status(), `${method} ${route}: ${text}`).toBe(status);
  return text ? JSON.parse(text) : (null as T);
}

async function openAccounts(page: Page) {
  await page.locator('button[aria-label="Settings"][title="Settings"]').click();
  await page.getByTestId("settings-nav-providers").click();
  await expect(page.getByTestId("codex-profiles")).toBeVisible();
}

/** The notice fits the viewport and none of its own content spills out of it. */
const noticeFits = (page: Page, testId: string) => page.getByTestId(testId).evaluate((el) => {
  const box = el.getBoundingClientRect();
  const spill = [el, ...Array.from(el.querySelectorAll("*"))].some((node) => node.scrollWidth > node.clientWidth + 1 && getComputedStyle(node).overflowX === "visible" && node.clientWidth > 0 && node.getBoundingClientRect().right > box.right + 1);
  return box.left >= 0 && box.right <= window.innerWidth + 1 && !spill;
});

test("a usage-limit refusal is one story across the task, the account, the Router and the preflight", async ({ page, request, product: b }, info) => {
  test.setTimeout(300_000);
  const errors: string[] = []; page.on("pageerror", (e) => errors.push(e.message));
  const writes: string[] = [];
  page.on("request", (req) => {
    if (["GET", "HEAD", "OPTIONS"].includes(req.method())) return;
    const url = new URL(req.url());
    if (url.pathname.startsWith("/preferences") || url.pathname.endsWith("/seen") || url.pathname.endsWith("/check")) return;
    writes.push(`${req.method()} ${url.pathname}`);
  });
  const call = <T = any>(method: "get" | "post" | "put" | "patch", route: string, data?: unknown, status = 200) => api<T>(request, b, method, route, data, status);

  // Two synthetic accounts, signed in through the fixture's login check.
  const ownerHome = path.join(b.dataDir, "owner");
  const profiles: { accountId: string; harnessId: string; name: string }[] = [];
  for (const [i, name] of ["Account A", "Account B"].entries()) {
    const directory = path.join(ownerHome, `profile-${i}`);
    writeSyntheticCodexProfile(directory, `subject-${i}`);
    const created = await call("post", "/account-core/codex-profiles", { displayName: name, directory }, 201);
    const checked = await call("post", `/account-core/codex-profiles/${created.accountId}/check`);
    expect(checked.availability).toBe("ready");
    await call("patch", `/harnesses/${created.harnessId}`, { enabled: true });
    profiles.push({ accountId: created.accountId, harnessId: created.harnessId, name });
  }
  const [A, B] = profiles as [typeof profiles[0], typeof profiles[0]];
  const project = path.join(b.dataDir, "project"); await mkdir(project);
  await call("post", "/projects", { path: project, name: "Refusal project" });
  const worker = await call("post", "/employees", { name: "Ada Developer", jobTitle: "Developer", projectPath: project }, 201);

  const newTask = async (title: string, prompt: string, agent: string) => {
    const created = await call("post", "/tasks", { title, prompt, workdir: project, agent, model: "gpt-6.1-sol", effort: "low", mode: "auto", isolation: "none", column: "ready" });
    return created.task ?? created;
  };
  const runTask = async (id: string) => {
    const started = await call("post", `/tasks/${id}/start`);
    await expect.poll(async () => (await call("get", `/tasks/${id}/runs`)).find((r: any) => r.id === started.runId)?.status, { timeout: 20_000 }).not.toBe("running");
    return started.runId as string;
  };
  const queued = await newTask("Waiting on Account A", "Use the approved account.", A.harnessId);
  const missions = "/api/orchestration/missions";
  const { mission } = await call("post", `${missions}/prepare`, {
    title: "Account limit mission", goal: "Keep the approved task queued.",
    tasks: [{ taskId: queued.id, taskTitle: queued.title, projectPath: project, harnessId: A.harnessId,
      modelId: "gpt-6.1-sol", accountId: A.accountId, mode: "auto", qcRequired: false }],
  });
  await call("post", `${missions}/${mission.id}/authorize`, { digest: mission.planDigest });

  // 1. Developer run on A is refused by the provider.
  const dev = await newTask("Refused developer task", "Implement it __fake_provider__:usage-limit", A.harnessId);
  await call("post", "/task-assignments", { taskId: dev.id, employeeId: worker.id }, 201);
  const devRun = await runTask(dev.id);
  const runsBefore = (await call("get", `/tasks/${dev.id}/runs`)).length;
  expect((await call("get", `/tasks/${dev.id}/runs`))[0].providerRefusal).toMatchObject({ surface: "developer-run", accountId: A.accountId });
  await call("post", `${missions}/${mission.id}/start`, {});

  await gotoApp(page, b.bootBase);
  await openAllTasks(page);
  await page.getByRole("button", { name: "Refused developer task" }).click();
  await page.getByTestId("manager-task-details").click();

  // The task result: the Developer run's refusal, on the account that ran it.
  const runNotice = page.getByTestId("run-provider-refusal");
  await expect(runNotice).toBeVisible();
  await expect(runNotice.getByTestId("run-provider-refusal-title")).toContainText("usage limit");
  await expect(runNotice.getByTestId("run-provider-refusal-source")).toContainText("Developer run");
  await expect(runNotice.getByTestId("run-provider-refusal-hint")).toContainText(NOV);
  await expect(runNotice.getByTestId("run-provider-refusal-unconfirmed")).toContainText("exact reset time are unknown");
  await expect(runNotice.getByTestId("run-provider-refusal-hint")).not.toContainText(/local time|UTC/i);

  // The launch preflight shows the same observation and still blocks nothing.
  const section = page.getByTestId("employee-execution");
  await section.locator("summary").click();
  await page.getByTestId("employee-execution-harness").selectOption(A.harnessId);
  await page.getByTestId("employee-execution-prepare").click();
  await expect(page.getByTestId("employee-execution-result")).toBeVisible();
  const preflightNotice = page.getByTestId("employee-execution-provider-refusal");
  await expect(preflightNotice).toBeVisible();
  await expect(preflightNotice).toContainText(NOV);
  await expect(page.getByTestId("employee-execution-outcome")).not.toHaveAttribute("data-outcome", "blocked");
  await expect(page.getByTestId("employee-execution-warnings")).toContainText("readiness to run is unconfirmed");
  // The neighbour is not presented as guaranteed to work.
  await page.getByTestId("employee-execution-harness").selectOption(B.harnessId);
  await page.getByTestId("employee-execution-prepare").click();
  await expect(page.getByTestId("employee-execution-provider-refusal")).toHaveCount(0);
  await expect(page.getByTestId("employee-execution-quota")).toContainText(/unknown|not verified|unverified/i);
  await page.getByRole("button", { name: "Close task details", exact: true }).click();

  // 2. The account card: signed in, but refused. The other account is untouched.
  await openAccounts(page);
  const cardA = page.getByTestId("codex-profile-card").filter({ hasText: "Account A" });
  const cardB = page.getByTestId("codex-profile-card").filter({ hasText: "Account B" });
  await cardA.getByTestId("codex-profile-check").click();
  await expect(cardA.getByTestId("codex-profile-status")).toContainText("provider refused");
  await expect(cardA.getByTestId("codex-profile-refusal")).toBeVisible();
  await expect(cardA.getByTestId("codex-profile-refusal-hint")).toContainText(NOV);
  await cardB.getByTestId("codex-profile-check").click();
  await expect(cardB.getByTestId("codex-profile-status")).toContainText("Ready");
  await expect(cardB.getByTestId("codex-profile-refusal")).toHaveCount(0);
  await expect(cardB).toContainText("Remaining quota: Unknown");
  const accountLimit = page.getByTestId("account-provider-limit").filter({ hasText: "Account A" });
  await expect(accountLimit).toContainText("Account A reported a usage limit without a confirmed reset time.");
  const accountReason = await accountLimit.getByTestId("account-provider-limit-title").innerText();
  await accountLimit.getByTestId("account-provider-limit-details").locator("summary").click();
  const source = await accountLimit.getByTestId("account-provider-limit-source").innerText();

  // 3. Router 2.0 shows it on exactly that candidate; B is only "eligible, capacity not verified".
  const dashboard = page.getByTestId("ai-router-v2-dashboard");
  await dashboard.scrollIntoViewIfNeeded();
  await expect(dashboard).toBeVisible();
  const refused = dashboard.locator('[data-testid^="ineligible-limit-"][data-kind="usage-limit"]').first();
  await expect(refused).toBeVisible();
  await expect(refused).toContainText(NOV);
  await expect(refused).toHaveAttribute("data-account", A.accountId);
  await expect(refused).toContainText("without a confirmed reset time");
  // Every refusal the Router shows belongs to A; no candidate of B carries one.
  await expect(dashboard.locator(`[data-testid*="provider-refusal"][data-account="${B.accountId}"]`)).toHaveCount(0);
  await expect(dashboard.locator('[data-testid$="-state"][data-state="unverified"]').first()).toContainText("capacity not verified");
  // Nothing was selected, retried or launched for the Owner.
  await expect(dashboard.getByTestId("router-account-frozen")).toBeVisible();
  await openExecutionPlans(page);
  await page.getByTestId("tab-queue").click();
  const wait = page.getByTestId(`mission-task-${queued.id}`).getByTestId("mission-account-limit");
  await expect(wait.getByTestId("mission-account-limit-title")).toHaveText(accountReason);
  await expect(wait.getByTestId("mission-account-limit-hint")).toContainText(NOV);
  await wait.getByTestId("mission-account-limit-details").locator("summary").click();
  await expect(wait.getByTestId("mission-account-limit-source")).toHaveText(source);
  expect(await call("get", `/tasks/${queued.id}/runs`)).toEqual([]);
  await call("post", `${missions}/${mission.id}/cancel`, {});

  // 4. Reload and a login check: the observation persists, B is still unaffected.
  await page.reload();
  await openAccounts(page);
  await expect(page.getByTestId("codex-profile-card").filter({ hasText: "Account A" }).getByTestId("codex-profile-refusal")).toBeVisible();
  await page.getByTestId("codex-profile-card").filter({ hasText: "Account A" }).getByTestId("codex-profile-check").click();
  await expect(page.getByTestId("codex-profile-card").filter({ hasText: "Account A" }).getByTestId("codex-profile-refusal")).toBeVisible();
  await expect(page.getByTestId("codex-profile-card").filter({ hasText: "Account B" }).getByTestId("codex-profile-refusal")).toHaveCount(0);
  await page.getByRole("button", { name: "Close", exact: true }).click();

  // No automatic retry, account switch or extra run happened anywhere in this flow.
  expect((await call("get", `/tasks/${dev.id}/runs`)).length).toBe(runsBefore);
  expect((await call("get", `/tasks/${dev.id}`)).agent).toBe(A.harnessId);
  expect(writes.filter((w) => /\/(start|input|qc\/reviews)/.test(w))).toEqual([]);

  // 5. Same-scope success: a successful Developer run on A for the same model ends A's observation only.
  const ok = await newTask("Successful developer task", "Implement the fix", A.harnessId);
  await runTask(ok.id);
  await expect.poll(async () => (await call("get", "/account-core/codex-profiles")).find((p: any) => p.accountId === A.accountId).providerRefusal ?? null).toBeNull();

  // 6. A Reviewer on the OTHER account is refused. The Developer's account is not blamed.
  await expect.poll(async () => (await call("get", `/tasks/${ok.id}`)).column, { timeout: 20_000 }).toBe("review");
  await writeFile(path.join(b.dataDir, "qc-verdicts.txt"), "USAGE_LIMIT\n");
  const prep = await call("post", `/tasks/${ok.id}/qc/reviews`, { reviewerHarness: B.harnessId, reviewerModel: "gpt-6.1-sol" });
  await call("post", `/tasks/${ok.id}/qc/reviews/${prep.review.id}/start`);
  await expect.poll(async () => (await call("get", `/tasks/${ok.id}/qc`)).reviews[0]?.providerRefusal?.accountId ?? null, { timeout: 20_000 }).toBe(B.accountId);
  const accounts = await call("get", "/account-core/codex-profiles");
  expect(accounts.find((p: any) => p.accountId === A.accountId).providerRefusal ?? null).toBeNull();
  expect(accounts.find((p: any) => p.accountId === B.accountId).providerRefusal).toMatchObject({ surface: "reviewer-run" });

  await page.goto(b.bootBase);
  await openAllTasks(page);
  await page.getByRole("button", { name: "Successful developer task", exact: true }).click();
  await page.getByTestId("manager-task-details").click();
  const qcNotice = page.getByTestId("qc-provider-refusal");
  await expect(qcNotice).toBeVisible();
  await expect(qcNotice.getByTestId("qc-provider-refusal-source")).toContainText("Reviewer");
  await expect(qcNotice.getByTestId("qc-provider-refusal-hint")).toContainText(NOV);
  await expect(qcNotice).toContainText("Account B");
  // QC and Done rules are what they were: no verdict was invented.
  await expect(page.getByTestId("task-qc-process-failure")).toBeVisible();
  expect((await call("get", `/tasks/${ok.id}/qc`)).state.latestVerdict ?? null).toBeNull();

  // 7. Compact width, English then Russian: the main notice stays readable with no horizontal overflow.
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(qcNotice).toBeVisible();
  expect(await noticeFits(page, "qc-provider-refusal")).toBe(true);
  await qcNotice.scrollIntoViewIfNeeded();
  await qcNotice.screenshot({ path: info.outputPath("notice-en-390.png") });
  await call("put", "/preferences/locale", { value: "ru" }).catch(() => null);
  await page.reload();
  await openAllTasks(page);
  await page.getByRole("button", { name: "Successful developer task", exact: true }).click();
  await page.getByTestId("manager-task-details").click();
  const qcRu = page.getByTestId("qc-provider-refusal");
  await expect(qcRu).toBeVisible();
  await expect(qcRu.getByTestId("qc-provider-refusal-title")).toContainText("лимит использования");
  await expect(qcRu.getByTestId("qc-provider-refusal-hint")).toContainText(NOV);
  expect(await noticeFits(page, "qc-provider-refusal")).toBe(true);
  await qcRu.scrollIntoViewIfNeeded();
  await qcRu.screenshot({ path: info.outputPath("notice-ru-390.png") });

  expect(errors).toEqual([]);
  expect(devRun).toBeTruthy();
});
