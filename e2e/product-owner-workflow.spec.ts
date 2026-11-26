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

/** FO-PRODUCT01: one company/project/worker/task/run chain, not independent page fixtures.
 * Local lifecycle permits an actual backend restart without modifying shared fixtures.
 * Data and logs are retained under the system temp dir; logs are also attached.
 */
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
    const dataDir = await realpath(await mkdtemp(path.join(tmpdir(), "fo-product01-")));
    const reservation = createServer();
    await new Promise<void>((resolve) => reservation.listen(0, "127.0.0.1", resolve));
    const port = (reservation.address() as { port: number }).port;
    await new Promise<void>((resolve) => reservation.close(() => resolve()));
    const apiToken = crypto.randomUUID();
    const apiBase = `http://127.0.0.1:${port}`;
    const fxBin = writeFxStubBin(dataDir);
    const seeded = seedIsolatedHarnessHomes(dataDir, fxBin);
    expect(seeded.ok, JSON.stringify(seeded)).toBe(true);
    const env = isolatedCoreEnv({ dataDir, apiPort: port, apiToken, fxBin, extra: {
      CI: "1", AGETOR_FAKE_MANAGER_DELAY_MS: "300", AGETOR_FAKE_QC_VERDICT: "PASS", AGETOR_FAKE_PORTFOLIO_DELAY_MS: "300", ...productEnv,
    } });
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
      await use({ dataDir, apiBase, apiToken, bootBase: `${E2E_BASE_URL}/#api=${port}&token=${apiToken}`,
        restart: async () => { await stop(child!); await start(); },
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

import type { Task, Run, TaskQcReview, TaskQcState } from "../src/shared/types.ts";
import type { ManagerState } from "../src/shared/project-manager.ts";
import type { PortfolioManagerState } from "../src/shared/portfolio-manager.ts";
import type { HeadPmCoordinationSnapshot } from "../src/shared/head-pm-coordination.ts";
import type { EmployeeRunView } from "../src/shared/execution/run.ts";
import type { EffectiveKnowledgePreview } from "../src/shared/knowledge/effective.ts";
import { clickProjectPage } from "./project-nav";

async function api<T>(request: APIRequestContext, b: ProductBackend, method: "get" | "post" | "put" | "patch", route: string, data?: unknown, status = 200): Promise<T> {
  const r = await request[method](b.apiBase + route, { headers: { authorization: `Bearer ${b.apiToken}` }, ...(data === undefined ? {} : { data }) });
  const text = await r.text();
  expect(r.status(), `${method} ${route}: ${text}`).toBe(status);
  return JSON.parse(text) as T;
}

async function project(page: Page, dir: string, surface: string) {
  await page.locator(`[data-testid="project-nav-item"][data-path="${dir}"]`).click();
  await clickProjectPage(page, surface);
}
async function closeRun(page: Page) {
  await page.getByRole("button", { name: "Close task details", exact: true }).click();
  await expect(page.getByTestId("supervised-live-workflow")).toHaveCount(0);
}

// All Owner workflow transitions use UI. Registry/config/notes are fixture setup;
// every agent action uses the actual API and isolated in-process fake drivers.
test("FO-PRODUCT01 Owner → Head → PM → intake → employee → QC → restart → Owner DONE", async ({ page, request, product: b }, info) => {
  test.setTimeout(180_000);
  const errors: string[] = [];
  page.on("pageerror", e => errors.push(e.message));
  const writes: string[] = [];
  page.on("request", r => {
    if (!["GET", "HEAD", "OPTIONS"].includes(r.method())) writes.push(`${r.method()} ${new URL(r.url()).pathname}`);
  });
  const call = <T>(method: "get" | "post" | "put" | "patch", route: string, data?: unknown, status = 200) => api<T>(request, b, method, route, data, status);
  const alpha = path.join(b.dataDir, "projects", "alpha");
  const beta = path.join(b.dataDir, "projects", "beta");
  for (const [dir, name] of [[alpha, "Product Alpha"], [beta, "Product Beta"]]) {
    await mkdir(path.join(dir!, "docs"), { recursive: true });
    await writeFile(path.join(dir!, "docs", "IDEA.md"), `# ${name}\nSynthetic acceptance only.`);
    await call("post", "/projects", { path: dir, name });
  }
  const ca = await call<{ id: string }>("post", "/clusters", { name: "Product Cluster A" }, 201);
  const cb = await call<{ id: string }>("post", "/clusters", { name: "Product Cluster B" }, 201);
  for (const [cluster, dir] of [[ca.id, alpha], [cb.id, beta]]) await call("post", `/clusters/${cluster}/projects`, { projectPath: dir }, 201);
  await call("put", "/employees/head", { name: "Product Head" }, 201);
  const pms: { employee: { id: string; name: string } }[] = [];
  for (const dir of [alpha, beta]) pms.push(await call("post", "/employees/project-managers", { projectPath: dir }, 201));
  const dev = await call<{ id: string; name: string }>("post", "/employees", { name: "Product Developer", jobTitle: "Backend Engineer", projectPath: alpha }, 201);
  await call("patch", "/harnesses/codex", { enabled: true });
  const preflight = await call<{ isolation: { consentKey: string } }>("post", "/project-interviews/preflight", { harness: "codex", model: "gpt-6.1-sol" });
  const config = { harness: "codex", model: "gpt-6.1-sol", effort: "low", consentKey: preflight.isolation.consentKey };
  await call("put", "/portfolio-manager/config", { config });
  for (const dir of [alpha, beta]) await call("put", "/project-manager/config", { path: dir, config });
  await call("post", "/projects/rules", { path: alpha, name: "Alpha rule", body: "PRODUCT_ALPHA_RULE: Keep changes minimal." });
  await call("post", "/projects/rules", { path: beta, name: "Beta rule", body: "PRODUCT_BETA_RULE: Separate project." });
  const notes: { id: string; title: string }[] = [];
  for (const [ownerKind, ownerId, title] of [
    ["company", "company:forgeorbit", "Company conventions"],
    ["cluster", ca.id, "Alpha cluster conventions"],
    ["project", alpha, "Alpha local conventions"],
    ["cluster", cb.id, "Beta cluster conventions"],
    ["project", beta, "Beta local conventions"],
  ]) {
    const note = await call<{ id: string; title: string }>("post", "/knowledge/documents", { ownerKind, ownerId, title, content: `# ${title}\nSynthetic context.` }, 201);
    notes.push(note);
    if (ownerKind !== "project") await call("patch", `/knowledge/documents/${note.id}/inherit`, { inheritToProjects: true });
  }
  await call("patch", `/knowledge/inheritance?projectPath=${encodeURIComponent(alpha)}`, { acceptCompany: true, acceptCluster: true });
  const betaBefore = await call<ManagerState>("get", `/project-manager?path=${encodeURIComponent(beta)}`);
  const betaRules = await call("get", `/projects/rules?path=${encodeURIComponent(beta)}`);
  const betaKnowledge = await call("get", `/knowledge/effective?projectPath=${encodeURIComponent(beta)}`);
  const manager = () => call<ManagerState>("get", `/project-manager?path=${encodeURIComponent(alpha)}`);
  const portfolio = () => call<PortfolioManagerState>("get", "/portfolio-manager");
  const coord = () => call<HeadPmCoordinationSnapshot>("get", "/portfolio-manager/coordination");
  const allTasks = () => call<Task[]>("get", "/tasks");

  await gotoApp(page, b.bootBase);
  // Owner inspects the exact project rules and inherited knowledge before execution.
  await project(page, alpha, "settings");
  await expect(page.getByTestId("project-rules-path")).toContainText(alpha);
  await expect(page.getByText("PRODUCT_ALPHA_RULE: Keep changes minimal.", { exact: true })).toBeVisible();
  await page.getByTestId("project-knowledge-effective-preview").click();
  for (const note of notes.slice(0, 3)) await expect(page.getByTestId("project-knowledge-effective-list")).toContainText(note.title);
  await expect(page.getByTestId("project-knowledge-effective-list")).not.toContainText("Beta");
  const effective = await call<{ preview: EffectiveKnowledgePreview }>("get", `/knowledge/effective?projectPath=${encodeURIComponent(alpha)}`);
  expect(effective.preview.included.map(n => n.id).sort()).toEqual(notes.slice(0, 3).map(n => n.id).sort());

  await page.getByTestId("head-pm-orb").click();
  await page.getByTestId("head-pm-context-all").click();
  for (const name of ["Product Cluster A", "Product Cluster B", pms[0]!.employee.name, pms[1]!.employee.name])
    await expect(page.getByTestId("head-pm-coordination")).toContainText(name);
  await page.getByTestId("head-pm-composer").fill("Delegate to the manager of Product Alpha — prepare the next tasks");
  await page.getByTestId("head-pm-send").click();
  const delegation = page.getByTestId("portfolio-delegation");
  await expect(delegation).toHaveAttribute("data-status", "proposed", { timeout: 20_000 });
  expect((await portfolio()).delegations).toHaveLength(1);
  const d = (await portfolio()).delegations[0]!;
  expect(d.projectPath).toBe(alpha);
  expect((await manager()).messages).toEqual([]);
  expect(await allTasks()).toEqual([]);
  await delegation.getByTestId("portfolio-delegation-approve").click();
  await page.getByRole("dialog").getByRole("button", { name: "Send request" }).click();
  await expect(delegation).toHaveAttribute("data-status", "answered", { timeout: 20_000 });
  const pm = await manager();
  expect(pm.messages.filter(m => m.role === "owner" && m.delegationId === d.id)).toHaveLength(1);
  expect(pm.proposals).toHaveLength(1);
  expect(pm.proposals[0]!.status).toBe("pending");
  expect(await allTasks()).toEqual([]);
  expect((await coord()).projects.find(p => p.projectPath === alpha)?.pendingProposals).toBe(1);
  await delegation.getByTestId("portfolio-delegation-open").click();
  await expect(page.getByTestId("manager-page")).toBeVisible();
  await expect(page.getByTestId("manager-message").first()).toContainText("approved by you");
  const proposal = page.getByTestId("manager-proposal");
  await expect(proposal).toHaveCount(1);
  // Accept only the first proposed slice; remaining proposal work stays excluded.
  await proposal.getByTestId("manager-item-include").nth(1).uncheck();
  await proposal.getByTestId("manager-proposal-approve").click();
  await expect(proposal).toHaveAttribute("data-status", "approved");
  await expect.poll(async () => (await allTasks()).length).toBe(1);
  const task = (await allTasks())[0]!;
  expect(task).toMatchObject({ column: "backlog", workdir: alpha });
  const row = () => call<Task>("get", `/tasks/${task.id}`);
  const runs = () => call<Run[]>("get", `/tasks/${task.id}/runs`);
  const qc = () => call<{ state: TaskQcState; reviews: TaskQcReview[] }>("get", `/tasks/${task.id}/qc`);
  expect((await request.post(`${b.apiBase}/tasks/${task.id}/start`, { headers: { authorization: `Bearer ${b.apiToken}` } })).status()).toBe(400);
  await proposal.getByTestId("manager-item-open-task").click();
  await page.getByTestId("supervised-live-admit").click();
  await expect.poll(async () => (await row()).column).toBe("inbox");
  expect(await runs()).toEqual([]);
  await closeRun(page);
  await page.getByTestId("manager-tab-inbox").click();
  await expect(page.getByTestId("manager-inbox-task-entry")).toHaveCount(1);
  await page.getByTestId("manager-inbox-task-entry").click();
  await page.getByTestId("supervised-live-ready").click();
  await expect.poll(async () => (await row()).column).toBe("ready");
  expect(await runs()).toEqual([]);
  await closeRun(page);
  await page.getByTestId("manager-tab-chat").click();
  await page.getByTestId("manager-composer").fill("Please assign the open task to a worker");
  await page.getByTestId("manager-send").click();
  const assignment = page.getByTestId("assignment-proposal");
  await expect(assignment).toHaveCount(1);
  await expect(assignment.getByTestId("assignment-proposal-task")).toHaveText(task.title);
  await assignment.getByTestId("pm-executor-load").click();
  await assignment.getByTestId("pm-executor-consent").check();
  await assignment.getByTestId("assignment-proposal-approve").click();
  await expect.poll(async () => (await call<{ assignment: { employeeId: string } | null }>("get", `/task-assignments/task?taskId=${task.id}`)).assignment?.employeeId).toBe(dev.id);
  expect(await runs()).toEqual([]);

  // Open the same task from the persisted PM proposal, with no ID entry.
  await page.getByTestId("manager-item-open-task").click();
  const execution = page.getByTestId("employee-execution");
  await execution.locator(":scope > summary").click();
  await expect(page.getByTestId("employee-execution-worker-name")).toHaveText(dev.name);
  await page.getByTestId("employee-execution-harness").selectOption("claude-code");
  await page.getByTestId("employee-execution-model").fill("opus-5.5");
  await page.getByTestId("employee-execution-prepare").click();
  await expect(page.getByTestId("employee-execution-outcome")).toHaveAttribute("data-outcome", "prepared");
  await page.getByTestId("employee-execution-run").click();
  await expect(page.getByTestId("employee-run-worker")).toHaveText(dev.name);
  expect(await runs()).toEqual([]);
  if (await page.getByTestId("employee-run-usage").count()) await page.getByTestId("employee-run-usage").getByRole("checkbox").check();
  await page.getByTestId("employee-run-confirm").click();
  await expect(page.getByTestId("employee-run-dialog")).toHaveCount(0);
  await expect.poll(async () => (await row()).column, { timeout: 30_000 }).toBe("review");
  const implementation = (await runs())[0]!;
  expect(implementation.status).toBe("succeeded");
  expect(implementation.projectRulesSnapshot?.projectPath).toBe(alpha);
  expect(JSON.stringify(implementation.projectRulesSnapshot)).toContain("PRODUCT_ALPHA_RULE");
  expect(JSON.stringify(implementation.projectRulesSnapshot)).not.toContain("PRODUCT_BETA_RULE");
  expect(implementation.knowledgeSnapshot?.items.map(n => n.id).sort()).toEqual(notes.slice(0, 3).map(n => n.id).sort());
  const attempts = await call<{ attempts: EmployeeRunView[] }>("get", `/employee-execution/attempts?taskId=${task.id}`);
  expect(attempts.attempts).toHaveLength(1);
  expect(attempts.attempts[0]).toMatchObject({ runId: implementation.id, provenance: { approval: "owner" } });
  await expect(page.getByTestId("supervised-live-fake-badge")).toBeVisible();
  await page.getByTestId("task-qc-reviewer-harness").selectOption("claude-code");
  await page.getByTestId("task-qc-reviewer-model").fill("haiku-5.5");
  await page.getByTestId("task-qc-request").click();
  await expect.poll(async () => (await qc()).state.latestVerdict, { timeout: 30_000 }).toBe("PASS");
  await expect(page.getByTestId("task-qc-awaiting-owner")).toBeVisible();
  const reviewed = await qc();
  expect(reviewed.state.awaitingOwnerApproval).toBe(true);
  expect(reviewed.reviews).toHaveLength(1);
  expect(reviewed.reviews[0]).toMatchObject({ projectPath: alpha, implementationRunId: implementation.id, verdict: "PASS", reviewerModel: "haiku-5.5" });
  expect(reviewed.reviews[0]!.reviewRunId).not.toBe(implementation.id);
  const history = await runs();
  expect(history).toHaveLength(2);
  const reviewRun = history.find(r => r.id === reviewed.reviews[0]!.reviewRunId)!;
  expect(reviewRun.status).toBe("succeeded");
  expect(JSON.stringify(reviewRun.projectRulesSnapshot)).toContain("PRODUCT_ALPHA_RULE");
  expect(reviewRun.knowledgeSnapshot?.projectPath).toBe(alpha);
  expect(reviewRun.knowledgeSnapshot?.items.map(n => n.id).sort()).toEqual(notes.slice(0, 3).map(n => n.id).sort());
  expect((await row()).column).toBe("review"); // PASS never auto-DONE.

  await closeRun(page);
  // A new process reopens the same isolated SQLite after PASS, before Owner acceptance.
  await b.restart();
  expect((await row()).column).toBe("review");
  expect((await qc()).reviews).toEqual(reviewed.reviews);
  expect((await runs()).map(r => r.id).sort()).toEqual(history.map(r => r.id).sort());
  expect((await manager()).proposals[0]!.status).toBe("approved");
  expect((await portfolio()).delegations).toHaveLength(1);
  const duplicate = await call<{ alreadySent: boolean }>("post", `/portfolio-manager/delegations/${d.id}/approve`, { revision: d.revision });
  expect(duplicate.alreadySent).toBe(true);
  expect((await manager()).messages.filter(m => m.role === "owner" && m.delegationId === d.id)).toHaveLength(1);
  await page.reload();
  await page.getByTestId("workspace-overview").click(); await page.getByTestId("workspace-attention").click();
  const attention = page.getByTestId("attention-row").filter({ hasText: task.title });
  await expect(attention).toHaveAttribute("data-kind", "qc-owner");
  await expect(attention.getByTestId("attention-hint")).toContainText(/accept|done/i);
  await attention.getByTestId("attention-open").click();
  await expect(page.getByTestId("task-qc-history")).toContainText("PASS");
  const headPage = await page.context().newPage();
  await headPage.goto(b.bootBase);
  await headPage.getByTestId("head-pm-orb").click();
  await headPage.getByTestId("head-pm-context-all").click();
  const progress = headPage.locator(`[data-testid="head-pm-project-progress"][data-path="${alpha}"]`);
  await expect(progress).toContainText(/review: 1/i);
  await progress.scrollIntoViewIfNeeded();
  await expect(progress).toBeVisible();
  await page.getByTestId("supervised-live-done").click();
  await expect.poll(async () => (await row()).column).toBe("done");
  await expect(page.getByTestId("supervised-live-phase")).toHaveText("Done");
  const runList = page.getByTestId("runs-list");
  await runList.getByRole("button").click();
  await expect(runList.getByRole("listitem")).toHaveCount(1);
  await expect(runList).toContainText("#1");
  await expect(runList).toContainText("Run #2");
  await page.screenshot({ path: info.outputPath("owner-done.png") });
  expect((await qc()).state.awaitingOwnerApproval).toBe(false);
  await closeRun(page);
  await expect(attention).toHaveCount(0);
  // Head stays open while another Owner surface accepts: task polling refreshes it.
  await expect(progress).toContainText(/done: 1/i);
  await progress.scrollIntoViewIfNeeded();
  await expect(progress).toBeVisible();
  await expect(headPage.locator(`[data-testid="head-pm-project-progress"][data-path="${beta}"]`)).toHaveText("No tasks");
  await headPage.screenshot({ path: info.outputPath("head-final-status.png") });
  await headPage.close();
  expect((await coord()).projects.find(p => p.projectPath === alpha)?.columns.done).toBe(1);
  expect(await call<ManagerState>("get", `/project-manager?path=${encodeURIComponent(beta)}`)).toEqual(betaBefore);
  expect(await call("get", `/projects/rules?path=${encodeURIComponent(beta)}`)).toEqual(betaRules);
  expect(await call("get", `/knowledge/effective?projectPath=${encodeURIComponent(beta)}`)).toEqual(betaKnowledge);
  expect((await allTasks()).filter(t => t.workdir === beta)).toEqual([]);
  expect(await runs()).toHaveLength(2);
  await page.getByTestId("workspace-company").click();
  await page.getByTestId("company-tab-activity").click();
  await page.getByTestId("activity-filter-project").selectOption(alpha);
  await expect(page.getByTestId("activity-event").first()).toBeVisible();
  expect(errors).toEqual([]);
  const writesPath = info.outputPath("owner-ui-writes.txt");
  await writeFile(writesPath, writes.join("\n"));
  await info.attach("owner-ui-writes", { path: writesPath, contentType: "text/plain" });
  const evidencePath = info.outputPath("workflow-evidence.json");
  await writeFile(evidencePath, JSON.stringify({ task: await row(), delegation: (await portfolio()).delegations[0], implementation, reviewRun, qc: await qc(), coordination: await coord() }, null, 2));
  await info.attach("workflow-evidence", { path: evidencePath, contentType: "application/json" });
});
