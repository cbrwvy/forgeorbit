import { expect, type APIRequestContext, type Page } from "@playwright/test";
import { Database } from "bun:sqlite";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type ProductBackend } from "./head-auto-fixture";
import { gotoApp, openExecutionPlans } from "./helpers";
import { writeCodexProfileFixture, writeSyntheticCodexProfile } from "./codex-profile-fixture";
import type { MissionRecord } from "../src/shared/orchestration/types";
import type { Run, Task } from "../src/shared/types";

const fixture = realpathSync(mkdtempSync(join(tmpdir(), "fo-objective-driver-")));
const fixtureHome = join(fixture, "home");
mkdirSync(fixtureHome);
test.use({
  productEnv: {
    HOME: fixtureHome,
    AGETOR_CODEX_BIN: writeCodexProfileFixture(fixture, process.execPath),
    AGETOR_FAKE_CODEX_RESOLVE_DELAY_MS: "5000",
    AGETOR_FAKE_QC_DELAY_MS: "2500",
    FORGEORBIT_EMBEDDING_MODEL_ROOT: join(fixture, "no-embedding-model"),
  },
});

async function setup(request: APIRequestContext, backend: ProductBackend, autonomous = true) {
  const headers = { authorization: `Bearer ${backend.apiToken}` };
  async function call<T>(method: string, path: string, data?: unknown, status = 200): Promise<T> {
    const result = await request.fetch(backend.apiBase + path, { method, headers, data });
    const body = await result.text();
    expect(result.status(), `${method} ${path}: ${body}`).toBe(status);
    return (body ? JSON.parse(body) : null) as T;
  }
  await call("PUT", "/preferences/locale", { value: "en" }, 204);
  const projects = [join(backend.dataDir, "contract"), join(backend.dataDir, "consumer")];
  for (const [index, projectPath] of projects.entries()) {
    mkdirSync(projectPath);
    writeFileSync(join(projectPath, "README.md"), "# Disposable mission");
    execFileSync("git", ["init", "-q", projectPath]);
    execFileSync("git", ["-C", projectPath, "add", "README.md"]);
    execFileSync("git", ["-C", projectPath, "-c", "user.name=QA", "-c", "user.email=qa@invalid", "commit", "-qm", "Baseline"]);
    await call("POST", "/projects", { path: projectPath, name: index === 0 ? "Contract project" : "Consumer project" });
    await call("POST", "/employees", { name: `Developer ${index}`, jobTitle: "Developer", roleCategory: "engineering", projectPath }, 201);
    await call("POST", "/employees", { name: `Reviewer ${index}`, jobTitle: "Reviewer", roleCategory: "quality", projectPath }, 201);
    await call("PUT", "/project-permissions/workspace-development", { projectPath, enabled: true });
  }
  const profileDir = join(fixtureHome, `mission-profile-${crypto.randomUUID()}`);
  writeSyntheticCodexProfile(profileDir, "disposable-mission");
  await call("PATCH", "/harnesses/codex", { enabled: true });
  const profile = await call<{ accountId: string; harnessId: string }>("POST", "/account-core/codex-profiles", { displayName: "Mission fixture", directory: profileDir }, 201);
  const model = "gpt-6.1-sol";
  const { policy: router } = await call<{ policy: { constraints: object } }>("GET", "/api/router-v2/config");
  await call("POST", "/api/router-v2/config", { ...router, constraints: {
    ...router.constraints, allowedHarnessIds: [profile.harnessId], allowedAccountIds: [profile.accountId], allowedModels: [model],
  } });
  if (autonomous) {
    const { policy } = await call<{ policy: { id: string } }>("POST", "/api/autonomy/policies", {
      mode: "autonomous", scopeKind: "workspace", scopeRef: "workspace", projects,
      specialistRoles: ["developer", "reviewer"], providers: ["codex"], models: [model], accounts: [profile.accountId],
      maxConcurrentWorkers: 3, maxLaunches: 8, maxDurationMs: 300_000, expiresAt: Date.now() + 300_000,
      permittedActions: ["launch_task", "run_qc"], qc: { required: true }, completion: { autoComplete: false },
    });
    await call("POST", `/api/autonomy/policies/${policy.id}/activate`, {});
  }
  const pre = await call<{ isolation: { consentKey: string } }>("POST", "/project-interviews/preflight", { harness: "codex", model, effort: "low" });
  await call("PUT", "/portfolio-manager/config", { config: { harness: "codex", model, effort: "low", consentKey: pre.isolation.consentKey } });
  return {
    call, projects,
    missions: async () => (await call<{ missions: MissionRecord[] }>("GET", "/api/orchestration/missions")).missions,
    mission: async (id: string) => (await call<{ mission: MissionRecord }>("GET", `/api/orchestration/missions/${id}`)).mission,
    runs: (id: string) => call<Run[]>("GET", `/tasks/${id}/runs`),
  };
}

async function draftFromUi(page: Page, projects: string[]) {
  await page.getByTestId("new-objective-mission").click();
  const form = page.getByTestId("objective-mission-form");
  await form.getByLabel("Objective").fill("Roll out a versioned contract to the consumer.");
  await form.getByLabel("First project").selectOption(projects[0]!);
  await form.getByLabel("Second project").selectOption(projects[1]!);
  await form.getByRole("button", { name: "Ask Head of PM for a plan" }).click();
  await expect(page.getByTestId("objective-mission-tasks")).toContainText("Produce shared contract", { timeout: 30_000 });
}

test("Owner approves one plan and the mission schedules only accepted and published handoffs", async ({ page, request, product }) => {
  test.setTimeout(120_000);
  const { call, projects, missions, mission, runs } = await setup(request, product);
  await gotoApp(page, product.bootBase);
  await openExecutionPlans(page);
  await draftFromUi(page, projects);
  const proposal = (await missions())[0]!;
  const [contract, prep, consumer] = proposal.plan.tasks;
  expect(proposal.status).toBe("draft");
  expect(await call("GET", "/tasks")).toEqual([]);
  await call("POST", `/api/orchestration/missions/${proposal.id}/authorize`, { digest: proposal.planDigest }, 409);
  await call("POST", `/api/orchestration/missions/${proposal.id}/approve-objective`, { digest: "stale", confirm: true }, 409);
  await expect(page.getByTestId(`objective-task-${contract!.taskId}`)).toContainText("Developer 0");
  await expect(page.getByTestId(`objective-task-${prep!.taskId}`)).toContainText("Can start in parallel");
  await expect(page.getByTestId(`objective-task-${consumer!.taskId}`)).toContainText("After the accepted result from Contract project / Produce shared contract");
  const approve = () => call("POST", `/api/orchestration/missions/${proposal.id}/approve-objective`, { digest: proposal.planDigest, confirm: true });

  const uiApproval = page.waitForResponse(response => response.url().endsWith("approve-objective"));
  await page.getByTestId("approve-objective-mission").click();
  await Promise.all([uiApproval, approve(), approve()]);
  expect(await call<Task[]>("GET", "/tasks")).toHaveLength(3);
  using db = new Database(join(product.dataDir, "agetor.sqlite"), { readonly: true });
  expect(db.query("SELECT id FROM employee_task_assignments").all()).toHaveLength(3);

  await expect.poll(async () => {
    const [a, b] = await Promise.all([runs(contract!.taskId), runs(prep!.taskId)]);
    return [a[0]?.status, b[0]?.status];
  }, { timeout: 25_000 }).toEqual(["running", "running"]);
  const dependentCard = page.getByTestId(`objective-task-${consumer!.taskId}`);
  await expect(dependentCard.getByTestId(`objective-state-${consumer!.taskId}`)).toHaveText("Waiting for a dependency");
  await expect(dependentCard).toContainText("Waiting for the approved result from Contract project / Produce shared contract");
  expect(await runs(consumer!.taskId)).toEqual([]);
  expect(existsSync(join(projects[0]!, "mission-contract.json"))).toBe(false);
  await call("PATCH", `/tasks/${contract!.taskId}`, { column: "done" }, 409);
  await expect.poll(async () => (await mission(proposal.id)).plan.tasks[0]?.phase, { timeout: 25_000 }).toBe("qc_running");
  expect(await runs(consumer!.taskId)).toEqual([]);
  await expect.poll(async () => (await mission(proposal.id)).plan.tasks[0]?.objectiveBlockers, { timeout: 25_000 }).toEqual(["publish", "accept"]);
  expect(await runs(consumer!.taskId)).toEqual([]);
  await call("PATCH", `/tasks/${contract!.taskId}`, { column: "done" }, 409);

  expect(existsSync(join(projects[0]!, "mission-contract.json"))).toBe(false);
  const contractRuns = await runs(contract!.taskId);
  const review = contractRuns.find(run => run.qcReviewId)!;
  expect(review).toBeTruthy();
  const reviewerIdentity = db.query<{ data: string }, [string]>(
    `SELECT data FROM run_events WHERE run_id = ? AND data LIKE '%"kind":"execution-identity"%'`,
  ).get(review.id);
  expect(JSON.parse(reviewerIdentity!.data)).toMatchObject({ mode: "ask", executionType: "synthetic" });
  await call("POST", "/task-workspace/publish", { taskId: contract!.taskId, paths: ["mission-contract.json"] }, 400);
  await page.getByTestId(`objective-task-${contract!.taskId}`).getByRole("button", { name: "Open task" }).click();
  const taskSummary = page.getByTestId("manager-task-summary");
  await expect(taskSummary.getByTestId("manager-working-copy")).toHaveAttribute("data-status", "settled");
  await taskSummary.getByTestId("manager-working-copy-approve").check();
  await taskSummary.getByTestId("manager-working-copy-apply").click();
  await expect(taskSummary.getByTestId("manager-working-copy")).toHaveAttribute("data-status", "published");
  expect(await runs(consumer!.taskId)).toEqual([]);
  expect(readFileSync(join(projects[0]!, "mission-contract.json"), "utf8")).toContain("mission-handoff");

  await call("PATCH", `/tasks/${prep!.taskId}`, { column: "done" });
  await taskSummary.getByRole("button", { name: "Accept result", exact: true }).click();
  await expect(taskSummary).toHaveAttribute("data-stage", "accepted");
  await page.getByRole("button", { name: "Close task details", exact: true }).click();
  await openExecutionPlans(page);
  await expect.poll(async () => (await runs(consumer!.taskId)).length, { timeout: 25_000 }).toBeGreaterThan(0);
  const downstream = await call<Task>("GET", `/tasks/${consumer!.taskId}`);
  expect(downstream.prompt).toContain("mission-handoff");
  expect(downstream.prompt).not.toContain(projects[0]!);
  expect(downstream.references).toEqual([]);
  expect(downstream.workdir).toBe(projects[1]);
  await expect.poll(async () => (await mission(proposal.id)).plan.tasks[2]?.phase, { timeout: 25_000 }).toBe("awaiting_owner");
  await call("PATCH", `/tasks/${consumer!.taskId}`, { column: "done" });
  await expect.poll(async () => (await mission(proposal.id)).status).toBe("completed");
  await expect(dependentCard).toContainText("Accepted result");
  await product.restart();
  await approve();
  expect((await mission(proposal.id)).status).toBe("completed");
  expect(await runs(consumer!.taskId)).toHaveLength(2);
  expect(await call<Task[]>("GET", "/tasks")).toHaveLength(3);
});

test("a stopped project holds its dependent chain while the other project works, including after restart", async ({ page, request, product }) => {
  test.setTimeout(120_000);
  const { call, projects, missions, mission, runs } = await setup(request, product);
  for (const [objective, error] of [["__outside__", "outside the selected scope"], ["__cycle__", "dependency cycles"]] as const) {
    const { turn } = await call<{ turn: { id: string } }>("POST", "/portfolio-manager/messages", { text: objective, objectiveProjectPaths: projects }, 202);
    await expect.poll(async () => (await call<{ error: string | null }>("GET", `/portfolio-manager/turns/${turn.id}`)).error).toContain(error);
  }
  expect(await call<Task[]>("GET", "/tasks")).toEqual([]);
  expect(await missions()).toEqual([]);

  await gotoApp(page, product.bootBase);
  await openExecutionPlans(page);
  await draftFromUi(page, projects);
  const proposal = (await missions())[0]!;
  const [contract, prep, consumer] = proposal.plan.tasks;
  await call("POST", "/projects/lifecycle/stop", { path: projects[0] });
  await page.getByTestId("approve-objective-mission").click();
  await expect.poll(async () => (await runs(prep!.taskId))[0]?.status, { timeout: 25_000 }).toBe("running");
  await expect(page.getByTestId(`objective-task-${contract!.taskId}`)).toContainText("This project is stopped");
  await expect(page.getByTestId(`objective-task-${consumer!.taskId}`)).toContainText("Waiting for the approved result");
  expect(await runs(contract!.taskId)).toEqual([]);
  expect(await runs(consumer!.taskId)).toEqual([]);

  await page.getByTestId("cancel-mission-button").click();
  await expect.poll(async () => (await mission(proposal.id)).status).toBe("cancelled");
  await product.restart();
  await call("POST", "/projects/lifecycle/start", { path: projects[0] });
  await call("POST", `/api/orchestration/missions/${proposal.id}/approve-objective`, { digest: proposal.planDigest, confirm: true });
  expect((await mission(proposal.id)).status).toBe("cancelled");
  expect(await runs(contract!.taskId)).toEqual([]);
  expect(await runs(consumer!.taskId)).toEqual([]);
  expect(await runs(prep!.taskId)).toHaveLength(1);
});

test("supervised operations wait independently for exact confirmation and never replay after restart", async ({ page, request, product }) => {
  test.setTimeout(120_000);
  const { call, projects, missions, mission, runs } = await setup(request, product, false);
  await gotoApp(page, product.bootBase);
  await openExecutionPlans(page);
  await draftFromUi(page, projects);
  const proposal = (await missions())[0]!;
  expect(proposal.plan.objective?.activationId).toBeUndefined();
  const [contract, prep, consumer] = proposal.plan.tasks;
  await page.getByTestId("approve-objective-mission").click();
  const prepLaunch = page.getByTestId(`objective-confirm-${prep!.taskId}`);
  await expect(prepLaunch).toHaveText("Confirm Developer launch", { timeout: 25_000 });
  await expect(page.getByTestId(`objective-state-${prep!.taskId}`)).toHaveText("Waiting for your approval");
  await expect(page.getByTestId(`objective-confirm-${contract!.taskId}`)).toBeVisible();
  expect(await runs(prep!.taskId)).toEqual([]);
  expect(await runs(contract!.taskId)).toEqual([]);

  await call("POST", `/api/orchestration/missions/${proposal.id}/confirm-launch`, {
    taskId: prep!.taskId, operationId: "wrong-operation", confirm: true,
  }, 409);
  await prepLaunch.click();
  await expect.poll(async () => (await runs(prep!.taskId))[0]?.status, { timeout: 25_000 }).toBe("running");
  expect(await runs(contract!.taskId)).toEqual([]);
  expect(await runs(consumer!.taskId)).toEqual([]);
  await expect(prepLaunch).toHaveText("Confirm Reviewer launch", { timeout: 25_000 });
  expect(await runs(prep!.taskId)).toHaveLength(1);

  await product.restart();
  await page.reload();
  await openExecutionPlans(page);
  await expect(prepLaunch).toHaveText("Confirm Reviewer launch", { timeout: 20_000 });
  expect(await runs(prep!.taskId)).toHaveLength(1);
  await prepLaunch.click();
  await expect.poll(async () => (await mission(proposal.id)).plan.tasks[1]?.objectiveBlockers, { timeout: 25_000 }).toEqual(["accept"]);
  expect(await runs(prep!.taskId)).toHaveLength(2);
  expect(await runs(contract!.taskId)).toEqual([]);
  expect(await runs(consumer!.taskId)).toEqual([]);
});

test("a project's Work independently policy replaces every launch, publication and acceptance click of an approved mission", async ({ page, request, product }) => {
  test.setTimeout(200_000);
  const { call, projects, missions, mission, runs } = await setup(request, product, false);
  for (const projectPath of projects) {
    const view = await call<{ available: { harnessId: string; accountKey: string }[] }>("GET", `/handsoff/policy?projectPath=${encodeURIComponent(projectPath)}`);
    expect(view.available.length).toBeGreaterThan(0);
    await call("PUT", "/handsoff/policy", { projectPath, policy: {
      enabled: true, autoApply: true, autoDone: true,
      harnessIds: [...new Set(view.available.map(option => option.harnessId))], accountIds: [...new Set(view.available.map(option => option.accountKey))],
    } });
  }
  await gotoApp(page, product.bootBase);
  await openExecutionPlans(page);
  await draftFromUi(page, projects);
  const proposal = (await missions())[0]!;
  expect(proposal.plan.objective?.activationId).toBeUndefined();
  const [contract, prep, consumer] = proposal.plan.tasks;
  const mutating: string[] = [];
  page.on("request", request => {
    if (["POST", "PUT", "PATCH", "DELETE"].includes(request.method()) && request.url().startsWith(product.apiBase)) mutating.push(`${request.method()} ${new URL(request.url()).pathname.replace(/[0-9a-f-]{36}/g, ":id")}`);
  });
  await page.getByTestId("approve-objective-mission").click();

  // The Owner approved the plan once. From here no launch, publication or acceptance control may ever appear.
  await expect.poll(async () => {
    for (const task of [contract, prep, consumer]) expect(await page.getByTestId(`objective-confirm-${task!.taskId}`).count()).toBe(0);
    return (await mission(proposal.id)).status;
  }, { timeout: 170_000, intervals: [500] }).toBe("completed");

  expect(mutating.filter(entry => !entry.endsWith("/approve-objective"))).toEqual([]);
  const tasks = await call<Task[]>("GET", "/tasks");
  expect(tasks.map(task => task.column)).toEqual(["done", "done", "done"]);
  expect(readFileSync(join(projects[0]!, "mission-contract.json"), "utf8")).toContain("mission-handoff");
  expect((await runs(consumer!.taskId)).filter(run => !run.qcReviewId)).toHaveLength(1);
  const downstream = await call<Task>("GET", `/tasks/${consumer!.taskId}`);
  expect(downstream.prompt).toContain("mission-handoff");
});
