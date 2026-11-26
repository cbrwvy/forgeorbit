import { Database } from "bun:sqlite";
import { writeCodexProfileFixture, writeSyntheticCodexProfile } from "./codex-profile-fixture";
import { test as base, expect, type APIRequestContext, type Page } from "@playwright/test";
import { spawn, type ChildProcess } from "node:child_process";
import { createWriteStream } from "node:fs";
import { mkdir, mkdtemp, readFile, realpath, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { createServer } from "node:net";
import path from "node:path";
import { E2E_BASE_URL } from "../playwright.config";
import { REPO_ROOT, isolatedCoreEnv, seedIsolatedHarnessHomes, writeFxStubBin } from "./isolated-env";
import { gotoApp, openPortfolio } from "./helpers";
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
    const root = await realpath(await mkdtemp(path.join(tmpdir(), "fo-multiaccount01-chromium-")));
    const dataDir = path.join(root, "data"); await mkdir(dataDir);
    const profileHome = path.join(root, "owner"); await mkdir(profileHome);
    const codexBin = writeCodexProfileFixture(root, process.execPath);
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
        HOME: profileHome,
        AGETOR_CODEX_BIN: codexBin,
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
  method: "get" | "post" | "put" | "patch" | "delete",
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


test("FO-ROUTING02: advisory account comparisons, explicit profiles, AUTO02, restart, QC and Owner Done", async ({ page, request, product: b }, info) => {
  test.setTimeout(240_000);
  const errors: string[] = []; page.on("pageerror", e => errors.push(e.message));
  const call = <T = any>(method: "get" | "post" | "put" | "patch" | "delete", route: string, data?: unknown, status = 200) => api<T>(request,b,method,route,data,status);
  const ownerHome = path.join(path.dirname(b.dataDir),"owner");
  const dirs = [path.join(ownerHome,"profile-a"),path.join(ownerHome,"profile-b")];
  dirs.forEach((dir,i) => writeSyntheticCodexProfile(dir,`independent-subject-${i}`));
  await gotoApp(page,b.bootBase);
  const openAccounts = async () => {
    await page.getByRole("button", { name: "Settings", exact: true }).click();
    await page.getByRole("navigation", { name: "Settings sections" }).getByRole("button", { name: "AI providers and accounts", exact: true }).click();
    await expect(page.getByTestId("codex-profiles")).toBeVisible();
  };
  await openAccounts();
  for (let i=0;i<2;i++) {
    await page.getByTestId("codex-profile-add").click();
    await page.getByTestId("codex-profile-name").fill(`Profile ${i===0?"A":"B"}`);
    await page.getByTestId("codex-profile-directory").fill(dirs[i]!);
    await page.getByTestId("codex-profile-save").click();
    await expect(page.getByTestId("codex-profile-card")).toHaveCount(i+1);
  }
  for (const name of ["Profile A","Profile B"]) {
    const card=page.getByTestId("codex-profile-card").filter({hasText:name});
    const checkResponse = page.waitForResponse(r => r.url().endsWith("/check") && r.request().method() === "POST");
    await card.getByTestId("codex-profile-check").click();
    const checked = await (await checkResponse).json();
    expect(checked.availability, JSON.stringify(checked)).toBe("ready");
    await expect(card.getByTestId("codex-profile-status")).toContainText("Ready");
    await expect(card).toContainText("Remaining quota: Unknown");
  }
  const registered=await call("get","/account-core/codex-profiles");
  const profiles=[registered.find((p:any)=>p.displayName==="Profile A"),registered.find((p:any)=>p.displayName==="Profile B")];
  // Trusted catalog facts are OFFLINE FIXTURES, seeded internally rather than
  // granting verification to any public/manual or diagnostic writer.
  const fixtureDb = new Database(path.join(b.dataDir,"agetor.sqlite"));
  for (const p of profiles) fixtureDb.run("INSERT INTO account_model_capabilities VALUES (?, ?, ?, ?)",[p.accountId,p.harnessId,"gpt-6.1-sol",JSON.stringify({accountId:p.accountId,harnessId:p.harnessId,modelId:"gpt-6.1-sol",support:"supported",verification:"verified",provenance:"verified",source:"offline:fo-routing02-model-catalog-fixture",observedAt:Date.now(),expiresAt:Date.now()+600_000})]);
  fixtureDb.close();
  await page.getByRole("button",{name:"Close",exact:true}).click();
  const projectDir=path.join(path.dirname(b.dataDir),"project"); await mkdir(projectDir);
  await call("post","/projects",{path:projectDir,name:"Multiaccount Co"});
  await call("patch","/harnesses/codex",{enabled:true});
  const employees=await Promise.all(["Developer A","Developer B"].map(name=>call("post","/employees",{name,jobTitle:"Developer",projectPath:projectDir},201)));
  const preflight=await call("post","/project-interviews/preflight",{harness:"codex",model:"gpt-6.1-sol"});
  await call("put","/project-manager/config",{path:projectDir,config:{harness:"codex",model:"gpt-6.1-sol",effort:"low",consentKey:preflight.isolation.consentKey}});
  const tasks:any[]=[];
  for (let i=0;i<2;i++) {
    const result=await call("post","/tasks",{title:`Profile task ${i}`,prompt:"Synthetic task",workdir:projectDir,agent:profiles[i].harnessId,model:"gpt-6.1-sol",effort:"low",mode:"auto",isolation:"none",column:"backlog"});
    const task=result.task??result; tasks.push(task);
    await call("post",`/tasks/${task.id}/admit-inbox`);
    await call("patch",`/tasks/${task.id}`,{column:"ready"});
  }
  await page.reload();
  await page.locator(`[data-testid="project-nav-item"][data-path="${projectDir}"]`).click();
  await page.getByTestId("project-page-board").click();
  for (let i=0;i<2;i++) {
    await assignDeveloperOnTask(page,tasks[i].title,employees[i].name);
    await page.getByRole("button",{name:tasks[i].title,exact:true}).click();
    await page.getByTestId("employee-execution").locator("summary").click();
    await page.getByTestId("employee-execution-harness").selectOption(profiles[i].harnessId);
    await page.getByTestId("employee-execution-model").fill("gpt-6.1-sol");
    await page.getByTestId("executor-suggest").click();
    const current = page.locator(`[data-testid="executor-option"][data-harness="${profiles[i].harnessId}"][data-model="gpt-6.1-sol"]`).first();
    await expect(current.getByTestId("account-resource-comparison")).toHaveAttribute("data-account", profiles[i].accountId);
    await expect(current).toContainText("Quota: Unknown");
    await expect(current).toContainText("comparable verified prices/performance unavailable");
    // A recommendation and its explicit draft selection create no launch or grant.
    await current.getByTestId("executor-use").click();
    expect(await call("get",`/tasks/${tasks[i].id}/runs`)).toEqual([]);
    if (i === 0) {
      await current.screenshot({path:info.outputPath("account-candidate-en.png")});
      await page.keyboard.press("Alt+Shift+L");
      await expect(current).toContainText("Настроенный аккаунт");
      await current.screenshot({path:info.outputPath("account-candidate-ru.png")});
      await page.keyboard.press("Alt+Shift+L");
      await page.getByTestId("executor-role").selectOption("reviewer");
      await expect(current).toContainText("QC Reviewer");
      await expect(current.getByTestId("executor-use")).toHaveCount(0);
      for (const role of ["project-manager","head"]) {
        await page.getByTestId("executor-role").selectOption(role);
        await expect(current.getByTestId("account-resource-comparison")).toHaveAttribute("data-account",profiles[i].accountId);
        await expect(current.getByTestId("executor-use")).toHaveCount(0);
      }
      await page.getByTestId("executor-role").selectOption("developer");
    }
    await page.getByTestId("employee-execution-prepare").click();
    await expect(page.getByTestId("employee-execution-worker-name")).toHaveText(employees[i].name);
    await expect(page.getByTestId("employee-execution-account")).toContainText(profiles[i].displayName);
    await closeRun(page);
  }
  // Fresh explicit checks of each fixture profile, with no model inference.
  await openAccounts();
  for (const name of ["Profile A","Profile B"]) {
    const check = page.waitForResponse(r=>r.url().endsWith("/check") && r.request().method()==="POST");
    await page.getByTestId("codex-profile-card").filter({hasText:name}).getByTestId("codex-profile-check").click();
    expect((await (await check).json()).availability).toBe("ready");
  }
  await page.getByRole("button",{name:"Close",exact:true}).click();
  await page.getByTestId("project-page-manager").click();
  const pmComparison = page.getByTestId("manager-resource-comparison-project-manager");
  await pmComparison.getByTestId("resource-comparison-toggle").click();
  const pmCard = pmComparison.locator(`[data-testid="executor-option"][data-harness="${profiles[1].harnessId}"][data-model="gpt-6.1-sol"]`);
  await expect(pmCard.getByTestId("account-resource-comparison")).toHaveAttribute("data-eligibility","eligible");
  await pmCard.getByTestId("executor-use").click();
  await expect(page.getByTestId("manager-harness")).toHaveValue(profiles[1].harnessId);
  await pmComparison.getByTestId("resource-comparison-toggle").click();
  await page.getByTestId("manager-consent").check();
  await expect(page.getByTestId("manager-connection")).toHaveText("Ready");
  await page.getByTestId("manager-tab-autonomy").click();
  for (const task of tasks) await page.getByTestId(`orchestrated-batch-pick-${task.id}`).check();
  await page.getByTestId("orchestrated-batch-create").click();
  await page.getByTestId("batch-resource").selectOption(profiles[0].harnessId);
  for (let i=0;i<2;i++) {
    const comparison = page.getByTestId("orchestrated-batch-task-list").locator("li").filter({has:page.getByTestId(`batch-task-resource-${tasks[i].id}`)}).getByTestId("resource-comparison-developer");
    await comparison.getByTestId("resource-comparison-toggle").click();
    const card = comparison.locator(`[data-testid="executor-option"][data-harness="${profiles[i].harnessId}"]`);
    await expect(card.getByTestId("account-resource-comparison")).toHaveAttribute("data-eligibility","eligible");
    await expect(card).toContainText("Quota: Unknown");
    await card.getByTestId("executor-use").click();
    await expect(page.getByTestId(`batch-task-resource-${tasks[i].id}`)).toHaveValue(profiles[i].harnessId);
    await comparison.getByTestId("resource-comparison-toggle").click();
  }
  const qcComparison = page.getByTestId("resource-comparison-reviewer");
  await qcComparison.getByTestId("resource-comparison-toggle").click();
  const qcCard = qcComparison.locator(`[data-testid="executor-option"][data-harness="${profiles[1].harnessId}"]`);
  await expect(qcCard.getByTestId("account-resource-comparison")).toHaveAttribute("data-eligibility","eligible");
  await qcCard.getByTestId("executor-use").click();
  await expect(page.getByTestId("batch-reviewer-resource")).toHaveValue(profiles[1].harnessId);
  await qcComparison.getByTestId("resource-comparison-toggle").click();
  await page.getByTestId("batch-plan-summary").screenshot({path:info.outputPath("account-aware-plan.png")});
  await expect(page.getByTestId("batch-plan-tasks")).toContainText("Profile A");
  await expect(page.getByTestId("batch-plan-tasks")).toContainText("Profile B");
  await page.getByTestId("orchestrated-batch-approve").click();
  await expect(page.getByTestId("orchestrated-batch-status")).toHaveText("approved");
  const approvedViews = await call("get",`/project-manager/orchestrated-batches?path=${encodeURIComponent(projectDir)}`);
  const approved = approvedViews[0].batch;
  expect(approved.tasks.every((t:any)=>t.execution.reviewerAccountProfile.id===profiles[1].accountId && t.execution.reviewerMode==="ask")).toBe(true);
  expect(approved.tasks.map((p:any)=>p.execution.implementerAccountProfile.id)).toEqual(profiles.map((p:any)=>p.accountId));
  await b.restart(); await page.reload();
  const restoredViews = await call("get",`/project-manager/orchestrated-batches?path=${encodeURIComponent(projectDir)}`);
  expect(restoredViews[0].batch.tasks).toEqual(approved.tasks);
  const afterRestart = await call("post","/employee-execution/recommendations",{taskId:tasks[0].id,harnessId:profiles[0].harnessId,model:"gpt-6.1-sol"});
  const passive = Object.values(afterRestart.recommendations.groups).flat().find((o:any)=>o.harnessId===profiles[0].harnessId && o.modelId==="gpt-6.1-sol") as any;
  expect(passive.resource.evidence.authentication).toBe("unknown");
  expect(passive.resource.state).toBe("unknown");
  await page.getByTestId("project-page-manager").click();
  await page.getByTestId("manager-tab-autonomy").click();
  await page.locator(`[data-testid="orchestrated-batch-row"][data-batch-id="${approved.id}"]`).click();
  await expect(page.getByTestId("orchestrated-batch-status")).toHaveText("approved");
  await expect(page.getByTestId("batch-plan-tasks")).toContainText("Profile A");
  await expect(page.getByTestId("batch-plan-tasks")).toContainText("Profile B");
  await page.getByTestId("orchestrated-batch-start").click();
  await expect(page.getByTestId("orchestrated-batch-status")).toHaveText("completed",{timeout:120_000});
  const evidence:any[]=[];
  for (let i=0;i<2;i++) {
    const runs=await call<Run[]>("get",`/tasks/${tasks[i].id}/runs`);
    expect(runs.length).toBe(2);
    const impl=runs.find(r=>r.agent===profiles[i].harnessId)!;
    expect(impl).toBeTruthy();
    const execution=await call("get",`/runs/${impl.id}/execution`);
    expect(execution.accountProfile).toEqual({id:profiles[i].accountId,displayName:profiles[i].displayName,harnessId:profiles[i].harnessId});
    const qc = await call("get",`/tasks/${tasks[i].id}/qc`);
    expect(qc.state.latestVerdict).toBe("PASS");
    expect((await call("get",`/tasks/${tasks[i].id}`)).column).toBe("review");
    const reviewExecution = await call("get",`/runs/${qc.reviews[0].reviewRunId}/execution`);
    expect(reviewExecution.accountProfile.id).toBe(profiles[1].accountId);
    evidence.push({taskId:tasks[i].id,execution,runId:impl.id,reviewExecution,qc});
  }
  await b.restart(); await page.reload();
  expect((await call("get","/account-core/codex-profiles")).length).toBe(2);
  for (const e of evidence) expect(await call("get",`/runs/${e.runId}/execution`)).toMatchObject({accountProfile:e.execution.accountProfile});
  await page.getByTestId("project-page-board").click();
  for (const task of tasks) {
    await page.getByRole("button",{name:task.title,exact:true}).click();
    await expect(page.getByTestId("task-qc-history")).toContainText("PASS");
    await page.getByTestId("supervised-live-done").click();
    await closeRun(page);
    expect((await call("get",`/tasks/${task.id}`)).column).toBe("done");
  }
  await openPortfolio(page);
  await page.getByTestId("portfolio-tab-manager").click();
  const headComparison = page.getByTestId("manager-resource-comparison-head");
  await headComparison.getByTestId("resource-comparison-toggle").click();
  const headCard = headComparison.locator(`[data-testid="executor-option"][data-harness="${profiles[0].harnessId}"][data-model="gpt-6.1-sol"]`);
  await expect(headCard).toContainText("Head of PM");
  await headCard.getByTestId("executor-use").click();
  await expect(page.getByTestId("portfolio-manager-harness")).toHaveValue(profiles[0].harnessId);
  await expect(page.getByTestId("portfolio-manager-send")).toBeDisabled();
  await page.screenshot({path:info.outputPath("head-resource-comparison.png"),fullPage:true});
  await openAccounts();
  const card=page.getByTestId("codex-profile-card").filter({hasText:"Profile A"});
  await card.getByTestId("codex-profile-edit").click();
  await page.getByTestId("codex-profile-name").fill("Renamed A");
  await page.getByTestId("codex-profile-save").click();
  await expect(page.getByTestId("codex-profile-card").filter({hasText:"Renamed A"})).toBeVisible();
  expect((await call("get",`/runs/${evidence[0].runId}/execution`)).accountProfile.displayName).toBe("Profile A");
  await page.getByTestId("codex-profile-card").filter({hasText:"Profile B"}).getByTestId("codex-profile-remove").click();
  await expect(page.getByTestId("codex-profile-card")).toHaveCount(1);
  expect(await readFile(path.join(dirs[1]!,"synthetic-authenticated"),"utf8")).toBe("independent-subject-1");
  const hs=await call("get","/harnesses"); expect(hs.harnesses.find((h:any)=>h.id===profiles[1].harnessId).enabled).toBe(false);
  await page.screenshot({path:info.outputPath("accounts.png"),fullPage:true});
  expect(errors).toEqual([]);
  await writeFile(info.outputPath("multiaccount-evidence.json"),JSON.stringify({profiles,evidence,removedCredentialsPreserved:true},null,2));
});
