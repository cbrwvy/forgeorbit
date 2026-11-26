import { test as base, expect, type APIRequestContext, type Page } from "@playwright/test";
import { spawn, type ChildProcess } from "node:child_process";
import { createWriteStream } from "node:fs";
import { mkdir, mkdtemp, readFile, realpath, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { createServer } from "node:net";
import path from "node:path";
import { Database } from "bun:sqlite";
import { E2E_BASE_URL } from "../playwright.config";
import { REPO_ROOT, isolatedCoreEnv, seedIsolatedHarnessHomes, writeFxStubBin } from "./isolated-env";
import { gotoApp, openPortfolio } from "./helpers";
import { clickProjectPage } from "./project-nav";

/** FO-012: one company/project/worker/task/run chain, not independent page fixtures.
 * Local lifecycle permits an actual backend restart without modifying shared fixtures.
 * Data and logs are retained under the system temp dir; logs are also attached.
 */
interface OrganizationBackend {
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

const test = base.extend<{ organization: OrganizationBackend; organizationEnv: Record<string, string> }>({
  organizationEnv: [{}, { option: true }],
  organization: async ({ organizationEnv }, use, testInfo) => {
    const dataDir = await realpath(await mkdtemp(path.join(tmpdir(), "fo012-organization-")));
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
      CI: "1", AGETOR_FAKE_MANAGER_DELAY_MS: "300", AGETOR_FAKE_PORTFOLIO_DELAY_MS: "300", ...organizationEnv,
    } });
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

test.use({ actionTimeout: 12_000 });

const auth = (b: OrganizationBackend) => ({ authorization: `Bearer ${b.apiToken}` });
async function api(request: APIRequestContext, b: OrganizationBackend, method: "get" | "post" | "put" | "patch", route: string, data?: unknown, status = 200): Promise<any> {
  const r = await request[method](b.apiBase + route, { headers: auth(b), ...(data === undefined ? {} : { data }) });
  const text = await r.text();
  expect(r.status(), `${method} ${route}: ${text}`).toBe(status);
  return text ? JSON.parse(text) : null;
}
function rows(b: OrganizationBackend, sql: string): any[] {
  const db = new Database(path.join(b.dataDir, "agetor.sqlite"), { readonly: true });
  try { return db.query(sql).all(); } finally { db.close(); }
}
const attempts = async (request: APIRequestContext, b: OrganizationBackend, taskId: string) =>
  (await api(request, b, "get", `/employee-execution/attempts?taskId=${taskId}`)).attempts as any[];
const runs = (request: APIRequestContext, b: OrganizationBackend, taskId: string) => api(request, b, "get", `/tasks/${taskId}/runs`);
async function project(page: Page, dir: string, surface = "overview") {
  await page.locator(`[data-testid="project-nav-item"][data-path="${dir}"]`).click();
  await clickProjectPage(page, surface);
}
async function company(page: Page) {
  await page.getByTestId("workspace-company").click();
  await expect(page.getByTestId("company-page")).toBeVisible();
}
async function employee(page: Page, name: string) {
  await company(page);
  await page.getByTestId("company-tab-staff").click();
  await page.getByTestId("staff-row").filter({ hasText: name }).click();
  await expect(page.getByTestId("employee-execution-history")).toBeVisible();
}
async function send(page: Page, kind: "manager" | "portfolio-manager", text: string) {
  await page.getByTestId(`${kind}-composer`).fill(text);
  await page.getByTestId(`${kind}-send`).click();
  await expect(page.getByTestId(`${kind}-busy`)).toBeVisible();
  await expect(page.getByTestId(`${kind}-busy`)).toHaveCount(0);
}

test("Owner → Portfolio delegation → PM proposal → Employee → real fake Runtime result → history → restart", async ({ page, request, organization: b }, info) => {
  test.setTimeout(120_000);
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  const writes: string[] = [];
  page.on("request", (r) => {
    if (!["GET", "HEAD", "OPTIONS"].includes(r.method())) writes.push(`${r.method()} ${new URL(r.url()).pathname}`);
  });
  // Arrange only: real registry APIs, permanent identities and a task in an isolated project.
  const dir = path.join(b.dataDir, "projects", "organization");
  await mkdir(dir, { recursive: true });
  await api(request, b, "post", "/projects", { path: dir, name: "Organization Orbit" });
  const cluster = await api(request, b, "post", "/clusters", { name: "Acceptance Cluster" }, 201);
  await api(request, b, "post", `/clusters/${cluster.id}/projects`, { projectPath: dir }, 201);
  const { employee: head } = await api(request, b, "put", "/employees/head", { name: "Owner Named Head" }, 201);
  const { employee: pm } = await api(request, b, "post", "/employees/project-managers", { projectPath: dir }, 201);
  const ada = await api(request, b, "post", "/employees", { name: "Ada Orbit", jobTitle: "QA Engineer", projectPath: dir }, 201);
  const bea = await api(request, b, "post", "/employees", { name: "Bea Orbit", jobTitle: "Backend Engineer", projectPath: dir }, 201);
  expect(new Set([head.id, pm.id, ada.id, bea.id]).size).toBe(4);
  for (const id of [head.id, pm.id, ada.id, bea.id]) expect(id).toMatch(/^[0-9a-f-]{36}$/);
  const task = await api(request, b, "post", "/tasks", { title: "Organization result", prompt: "Produce the organization acceptance result", workdir: dir,
    isolation: "none", agent: "claude-code", model: "opus", mode: "auto", column: "ready" });
  await api(request, b, "patch", "/harnesses/codex", { enabled: true });
  const note = await api(request, b, "post", "/knowledge/documents", { ownerKind: "company", ownerId: "company:forgeorbit",
    title: "Organization conventions", content: "ORG_CONTEXT_SENT_ONCE: Keep Review distinct from Done." }, 201);
  const transmissionRoute = `/knowledge/context/transmissions?managerKind=project&projectPath=${encodeURIComponent(dir)}`;
  const transmissions = async () => (await api(request, b, "get", transmissionRoute)).transmissions;

  await gotoApp(page, b.bootBase);
  await company(page);
  await page.getByTestId("company-tab-chart").click();
  await expect(page.getByTestId("org-chart-toggle-all")).toHaveText("Collapse all");
  for (const id of [head.id, pm.id, ada.id, bea.id]) {
    await expect(page.locator(`[data-testid="org-chart-node"][data-employee-id="${id}"]`)).toHaveCount(1);
  }
  await expect(page.getByTestId("org-chart-note")).toContainText("identity record, not a running process");

  // The real project manager config is set in its UI, independently of its Employee UUID.
  await project(page, dir, "manager");
  await expect(page.getByTestId("manager-harness")).toHaveValue("codex", { timeout: 20_000 });
  await page.getByTestId("manager-consent").check();
  await expect(page.getByTestId("manager-connection")).toHaveText("Ready");
  const managerBefore = await api(request, b, "get", `/project-manager?path=${encodeURIComponent(dir)}`);
  expect(managerBefore.messages).toEqual([]);

  // Global Portfolio Manager sees the same project. Its delegation requires Owner review.
  await openPortfolio(page);
  await expect(page.getByTestId("portfolio-project-card")).toHaveCount(1);
  await expect(page.getByTestId("portfolio-project-card")).toContainText("Organization Orbit");
  await page.getByTestId("portfolio-tab-manager").click();
  await expect(page.getByTestId("portfolio-manager-harness")).toHaveValue("codex", { timeout: 20_000 });
  await page.getByTestId("portfolio-manager-consent").check();
  await expect(page.getByTestId("portfolio-manager-source").filter({ hasText: "All 1 projects" })).toBeVisible();
  await send(page, "portfolio-manager", "Delegate to the manager of Organization Orbit");
  const delegation = page.getByTestId("portfolio-delegation");
  await expect(delegation).toHaveAttribute("data-status", "proposed");
  expect((await api(request, b, "get", `/project-manager?path=${encodeURIComponent(dir)}`)).messages).toEqual([]);
  expect(await runs(request, b, task.id)).toEqual([]);
  await delegation.getByTestId("portfolio-delegation-approve").click();
  await page.getByRole("dialog").getByRole("button", { name: "Send request" }).click();
  await expect(delegation).toHaveAttribute("data-status", "answered", { timeout: 15_000 });
  const delegated = await api(request, b, "get", `/project-manager?path=${encodeURIComponent(dir)}`);
  expect(delegated.messages.map((m: any) => m.role)).toEqual(["owner", "manager"]);
  expect(delegated.messages[0].delegationId).toBeTruthy();
  await delegation.getByTestId("portfolio-delegation-open").click();
  await expect(page.getByTestId("manager-message").first()).toContainText("approved by you");

  // A fake PM proposes; no employee assignment or execution is implicit in this turn.
  await send(page, "manager", "Please assign the open task to a worker");
  const proposal = page.getByTestId("assignment-proposal");
  await expect(proposal).toHaveCount(1);
  await expect(proposal.getByTestId("assignment-proposal-status")).toHaveText("Pending review");
  await expect(proposal.getByTestId("assignment-proposal-task")).toHaveText(task.title);
  await page.getByTestId("project-page-team").click();
  await expect(proposal).toHaveCount(1);
  await company(page);
  await page.getByTestId("company-tab-dashboard").click();
  await expect(proposal).toHaveCount(1);
  await expect(proposal.getByTestId("assignment-proposal-status")).toHaveText("Pending review");
  expect((await api(request, b, "get", `/task-assignments/task?taskId=${task.id}`)).assignment).toBeNull();
  expect(await transmissions()).toEqual([]);
  expect(await attempts(request, b, task.id)).toEqual([]);
  // A PM-proposed assignment can only be approved after the Owner has loaded the executor review (a deliberate gate).
  await expect(proposal.getByTestId("assignment-proposal-approve")).toBeDisabled();
  await proposal.getByTestId("pm-executor-load").click();
  await expect(proposal.getByTestId("pm-executor-options")).toBeVisible();
  await proposal.getByTestId("pm-executor-consent").check();
  await expect(proposal.getByTestId("assignment-proposal-approve")).toBeEnabled();
  await proposal.getByTestId("assignment-proposal-approve").focus();
  await page.keyboard.press("Enter");
  await expect(page.getByTestId("assignment-proposals-status")).toContainText("Nothing was started");
  const { assignment } = await api(request, b, "get", `/task-assignments/task?taskId=${task.id}`);
  expect(assignment).toMatchObject({ employeeId: ada.id, revision: 1, provenance: "owner" });
  expect(await runs(request, b, task.id)).toEqual([]);
  expect(await attempts(request, b, task.id)).toEqual([]);

  // Explicit Knowledge grant goes into exactly one later manager turn.
  await project(page, dir, "manager");
  await page.getByTestId("manager-knowledge-toggle").click();
  const knowledge = page.getByTestId("manager-knowledge");
  await knowledge.getByTestId("manager-knowledge-row").filter({ hasText: note.title }).getByTestId("manager-knowledge-check").check();
  await page.getByTestId("manager-knowledge-preview-button").click();
  await expect(page.getByTestId("manager-knowledge-preview")).toContainText("rev 1");
  await page.getByTestId("manager-knowledge-approve").click();
  expect(await transmissions()).toMatchObject([{ status: "approved" }]);
  const grantBeforePreview = rows(b, "SELECT * FROM knowledge_context_grants");
  expect(grantBeforePreview).toHaveLength(1);
  // Preview while grant is unconsumed: neither approval may consume or alter the other.
  const previewPage = await page.context().newPage();
  await gotoApp(previewPage, b.bootBase);
  await project(previewPage, dir, "board");
  await previewPage.locator('[data-testid="task-card"]').filter({ has: previewPage.getByText(task.title, { exact: true }) }).click();
  const router = previewPage.getByTestId("ai-resource-recommendation");
  await router.locator(":scope > summary").click();
  await router.getByTestId("find-ai-resource").click();
  await expect(router.getByTestId("router-no-verified")).toBeVisible();
  await expect(router.getByTestId("router-verified")).toHaveCount(0);
  expect(rows(b, "SELECT * FROM knowledge_context_grants")).toEqual(grantBeforePreview);
  expect((await api(request, b, "get", `/task-assignments/task?taskId=${task.id}`)).assignment).toEqual(assignment);
  expect(await attempts(request, b, task.id)).toEqual([]);
  expect(await runs(request, b, task.id)).toEqual([]);
  await previewPage.close();
  // The original manager remains mounted: the capability is held only by its UI,
  // never restored from audit metadata after navigating away.
  await expect(page.getByTestId("manager-knowledge-summary")).toHaveText("1 note approved for the next message");
  await send(page, "manager", "Summarize the conventions");
  expect(await transmissions()).toMatchObject([{ status: "consumed" }]);
  const consumed = rows(b, "SELECT * FROM knowledge_context_grants");
  await expect(page.getByTestId("manager-knowledge-summary")).toHaveText("None selected");
  await send(page, "manager", "Summarize the project again without attached notes");
  expect(rows(b, "SELECT * FROM knowledge_context_grants")).toEqual(consumed);
  expect(await transmissions()).toHaveLength(1);
  expect(await runs(request, b, task.id)).toEqual([]);

  await project(page, dir, "board");
  await page.locator('[data-testid="task-card"]').filter({ has: page.getByText(task.title, { exact: true }) }).click();
  const execution = page.getByTestId("employee-execution");
  await execution.locator(":scope > summary").click();
  await page.getByTestId("employee-execution-harness").selectOption("claude-code");
  await page.getByTestId("employee-execution-prepare").click();
  await expect(page.getByTestId("employee-execution-outcome")).toHaveAttribute("data-outcome", "prepared");
  await expect(execution).toContainText(ada.name);
  await page.getByTestId("employee-execution-run").click();
  const review = page.getByTestId("employee-run-dialog");
  await expect(page.getByTestId("employee-run-worker")).toHaveText(ada.name);
  await expect(page.getByTestId("employee-run-revision")).toHaveText("1");
  await expect(page.getByTestId("employee-run-account")).toContainText("Unknown");
  await expect(page.getByTestId("employee-run-cancel")).toBeFocused();
  expect(await runs(request, b, task.id)).toEqual([]);
  // Owner cancels the first review. Keyboard confirmation of the next review is explicit.
  await page.keyboard.press("Escape");
  await expect(review).toHaveCount(0);
  await expect.poll(async () => (await attempts(request, b, task.id))[0].status).toBe("cancelled");
  expect(await runs(request, b, task.id)).toEqual([]);
  await page.getByTestId("employee-execution-run").click();
  await page.getByTestId("employee-run-confirm").focus();
  await page.keyboard.press("Enter");
  await expect(review).toHaveCount(0);
  await expect(page.getByTestId("employee-run-status").getByTestId("employee-run-phase")).toHaveAttribute("data-phase", "completed", { timeout: 20_000 });
  const allRuns = await runs(request, b, task.id);
  expect(allRuns).toHaveLength(1);
  expect(allRuns[0]).toMatchObject({ status: "succeeded", exitCode: 0 });
  const history = await attempts(request, b, task.id);
  expect(history).toHaveLength(2);
  const completed = history.find((a) => a.runId === allRuns[0].id)!;
  expect(completed).toMatchObject({ employee: { id: ada.id }, assignment: { id: assignment.id, revision: 1 }, taskId: task.id,
    projectPath: dir, phase: "completed", result: "succeeded", provenance: { approval: "owner" }, actual: { model: null, accountId: null } });
  await page.getByTestId("employee-run-open-runs").click();
  await expect(page.getByTestId("runs-list")).toBeVisible();
  await expect(page.getByTestId("transcript-log")).toContainText("fake response to: Produce the organization acceptance result");
  await page.getByRole("button", { name: "Close task details", exact: true }).click();

  await employee(page, ada.name);
  const entry = page.getByTestId("execution-history-entry").filter({ hasText: task.title }).first();
  await entry.locator("summary").click();
  await expect(entry).toContainText(completed.runId);
  await expect(entry).toContainText(assignment.id);
  await expect(entry).toContainText("model Unknown");
  await expect(entry).toContainText("account Unknown");
  // Real layouts on the completed chain in both themes, rather than synthetic cards.
  for (const theme of ["light", "dark"] as const) {
    await page.emulateMedia({ colorScheme: theme, reducedMotion: "reduce" });
    await expect.poll(() => page.locator("html").evaluate((n) => n.classList.contains("dark"))).toBe(theme === "dark");
    for (const width of [390, 768, 1024, 1440]) {
      await page.setViewportSize({ width, height: 900 });
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth + 1)).toBe(true);
      await entry.getByTestId("execution-history-open-task").scrollIntoViewIfNeeded();
      await expect(entry.getByTestId("execution-history-open-task")).toBeInViewport();
      await page.screenshot({ path: info.outputPath(`organization-${theme}-${width}.png`) });
    }
  }
  await page.setViewportSize({ width: 1440, height: 900 });
  await entry.getByTestId("execution-history-open-task").focus();
  await page.keyboard.press("Enter");
  await expect(page.getByTestId("runs-list")).toBeVisible();
  await page.getByRole("button", { name: "Close task details", exact: true }).click();

  // Restart the actual isolated backend, same HOME and SQLite, no fabricated terminal rows.
  await b.restart();
  await page.reload();
  await employee(page, ada.name);
  expect(await attempts(request, b, task.id)).toEqual(history);
  expect(await runs(request, b, task.id)).toEqual(allRuns);
  expect(rows(b, "SELECT * FROM knowledge_context_grants")).toEqual(consumed);
  expect((await api(request, b, "get", "/employees/head")).head.id).toBe(head.id);
  expect((await api(request, b, "get", `/employees/project-managers?projectPath=${encodeURIComponent(dir)}`)).projectManager.id).toBe(pm.id);
  const restartedEntry = page.getByTestId("execution-history-entry").first();
  await restartedEntry.locator("summary").click();
  await expect(restartedEntry).toContainText(completed.runId);
  // Result is reachable from both Project and Portfolio through the existing Board.
  await page.getByTestId("employee-open-project").click();
  await page.getByTestId("project-page-board").click();
  await page.locator('[data-testid="task-card"]').filter({ has: page.getByText(task.title, { exact: true }) }).click();
  await expect(page.getByTestId("runs-list")).toBeVisible();
  await page.getByRole("button", { name: "Close task details", exact: true }).click();
  await openPortfolio(page);
  await page.getByTestId("portfolio-tab-overview").click();
  await page.getByTestId("portfolio-project-card").getByTestId("portfolio-open-board").click();
  await page.locator('[data-testid="task-card"]').filter({ has: page.getByText(task.title, { exact: true }) }).click();
  await expect(page.getByTestId("runs-list")).toBeVisible();
  expect(await runs(request, b, task.id)).toEqual(allRuns);
  expect(rows(b, "SELECT id FROM tasks")).toHaveLength(1);
  expect(rows(b, "SELECT id FROM ai_employees")).toHaveLength(4);
  expect(rows(b, "SELECT id FROM runs")).toHaveLength(1);
  expect(errors).toEqual([]);
  expect(writes.filter((w) => /\/attempts\/[^/]+\/start$/.test(w))).toHaveLength(1);
  expect(writes.filter((w) => /\/tasks\/[^/]+\/(start|cancel)$|\/usage\/refresh|\/account-core\//.test(w))).toEqual([]);
  const logs = await readFile(path.join(b.dataDir, "backend.log"), "utf8");
  expect(logs).not.toMatch(/SQLITE_ERROR|SQLITE_BUSY|ORG_CONTEXT_SENT_ONCE/);
  const chainArtifact = info.outputPath("organization-chain.json");
  await writeFile(chainArtifact, JSON.stringify({ project: dir, cluster: cluster.id, head: head.id, manager: pm.id,
    workers: [ada.id, bea.id], assignment, task: task.id, attempt: completed, run: allRuns[0], writes }, null, 2));
  await info.attach("organization-chain", { path: chainArtifact, contentType: "application/json" });
});

test.describe("restart during Running", () => {
  test.use({ organizationEnv: { AGETOR_FAKE_CLAUDE_RESOLVE_DELAY_MS: "60000" } });
  test("lost runtime handle stays Unknown and repeated reconciliation never relaunches", async ({ page, request, organization: b }) => {
    test.setTimeout(60_000);
    const dir = path.join(b.dataDir, "active-project");
    await mkdir(dir);
    await api(request, b, "post", "/projects", { path: dir, name: "Active Organization" });
    const ada = await api(request, b, "post", "/employees", { name: "Ada Recovery", jobTitle: "QA Engineer", projectPath: dir }, 201);
    // Existing fake handoff scenario honors the Claude resolve delay. The default
    // fake echo response completes after 20ms regardless of that delay setting.
    const task = await api(request, b, "post", "/tasks", { title: "Active organization result", prompt: "Work until the fixture restarts __agetor_fake_claude_handoff__:done", workdir: dir,
      isolation: "none", agent: "claude-code", model: "opus", mode: "auto", column: "ready" });
    await api(request, b, "post", "/task-assignments", { taskId: task.id, employeeId: ada.id }, 201);
    await gotoApp(page, b.bootBase);
    await project(page, dir, "board");
    await page.locator('[data-testid="task-card"]').filter({ has: page.getByText(task.title, { exact: true }) }).click();
    await page.getByTestId("employee-execution").locator(":scope > summary").click();
    await page.getByTestId("employee-execution-harness").selectOption("claude-code");
    await page.getByTestId("employee-execution-prepare").click();
    await expect(page.getByTestId("employee-execution-outcome")).toHaveAttribute("data-outcome", "prepared");
    await page.getByTestId("employee-execution-run").click();
    const start = page.waitForRequest((r) => /\/attempts\/[^/]+\/start$/.test(new URL(r.url()).pathname));
    await page.getByTestId("employee-run-confirm").click();
    const originalStart = await start;
    await expect.poll(async () => (await attempts(request, b, task.id))[0].phase).toBe("running");
    const [attempt] = await attempts(request, b, task.id);
    expect(attempt).toMatchObject({ employee: { id: ada.id }, phase: "running" });
    const [run] = await runs(request, b, task.id);
    expect(run.id).toBe(attempt.runId);
    await b.restart();
    await page.reload();
    await project(page, dir, "board");
    await page.locator('[data-testid="task-card"]').filter({ has: page.getByText(task.title, { exact: true }) }).click();
    await page.getByTestId("employee-execution").locator(":scope > summary").click();
    const status = page.getByTestId("employee-run-status");
    await expect(status.getByTestId("employee-run-phase")).toHaveAttribute("data-phase", "unknown-outcome");
    await expect(status.getByTestId("employee-run-process-unknown")).toBeVisible();
    for (let i = 0; i < 2; i++) {
      await status.getByTestId("employee-run-reconcile").click();
      await expect(status.getByTestId("employee-run-reconcile-result")).toContainText("remains unknown");
    }
    const replay = await request.post(originalStart.url(), { headers: auth(b), data: originalStart.postDataJSON() });
    expect(replay.status()).toBe(200);
    expect((await replay.json()).replayed).toBe(true);
    const refused = await api(request, b, "post", "/employee-execution/reviews", { taskId: task.id, harnessId: "claude-code" });
    expect(refused.attempt).toBeNull();
    expect(refused.blockingErrors.length).toBeGreaterThan(0);
    const finalRuns = await runs(request, b, task.id);
    expect(finalRuns).toHaveLength(1);
    expect(finalRuns[0]).toMatchObject({ id: run.id, status: "orphaned" });
    const [historical] = await attempts(request, b, task.id);
    expect(historical).toMatchObject({ employee: { id: ada.id }, assignment: attempt.assignment, runId: run.id, phase: "unknown-outcome" });
  });
});
