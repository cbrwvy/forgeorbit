import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";

const DATA_DIR = mkdtempSync(path.join(tmpdir(), "agetor-portfolio-"));
process.env.AGETOR_DATA_DIR = DATA_DIR;

type DbModule = typeof import("./db.ts");
type AdapterModule = typeof import("./portfolio-adapter.ts");
type HttpModule = typeof import("./portfolio-http.ts");

let dbMod: DbModule;
let buildPortfolioSnapshot: AdapterModule["buildPortfolioSnapshot"];
let getPortfolioAnalysis: HttpModule["getPortfolioAnalysis"];
let PORTFOLIO_STALENESS_MS: number;

beforeAll(async () => {
  dbMod = await import("./db.ts");
  const adapter = await import("./portfolio-adapter.ts");
  const http = await import("./portfolio-http.ts");
  buildPortfolioSnapshot = adapter.buildPortfolioSnapshot;
  PORTFOLIO_STALENESS_MS = adapter.PORTFOLIO_STALENESS_MS;
  getPortfolioAnalysis = http.getPortfolioAnalysis;
});

afterAll(() => {
  dbMod.harnesses.setEnabled("claude-code", true);
});

function clearRegistry(): void {
  for (const project of dbMod.projects.list()) dbMod.projects.delete(project.path);
}

function projectDir(name: string): string {
  return mkdtempSync(path.join(tmpdir(), `fo008b-${name}-`));
}

function addProject(name: string): string {
  const dir = projectDir(name);
  dbMod.projects.upsert(dir, name);
  return dir;
}

function addTask(workdir: string, title: string, column: "backlog" | "ready" | "running" | "blocked" | "review" | "done" = "backlog", agent = "claude-code") {
  const now = Date.now();
  const id = `task-${randomUUID()}`;
  dbMod.tasks.insert({
    id,
    title,
    prompt: title,
    column,
    agent,
    workdir,
    isolation: "none",
    taskType: "task",
    branch: null,
    branchSource: "created",
    worktreePath: null,
    baseRef: null,
    prUrl: null,
    mode: null,
    model: null,
    effort: null,
    fast: false,
    maxMode: false,
    references: [],
    backlog: [],
    plans: [],
    draft: null,
    runId: null,
    hasOpenableRun: false,
    pendingInteractionCount: 0,
    openTerminalCount: 0,
    archivedAt: null,
    createdAt: now,
    updatedAt: now,
  });
  return id;
}

function addRun(taskId: string, status: "running" | "succeeded" | "failed" | "cancelled" | "orphaned") {
  const now = Date.now();
  const id = `run-${randomUUID()}`;
  dbMod.runs.insert({
    id,
    taskId,
    agent: "claude-code",
    status,
    startedAt: now - 1000,
    endedAt: status === "running" ? null : now,
    exitCode: status === "failed" ? 1 : status === "running" ? null : 0,
    tmuxSession: null,
    claudeSessionId: null,
    codexSessionId: null,
    cursorSessionId: null,
    geminiSessionId: null,
    fxSessionId: null,
  });
  return id;
}

function settingsJson(taskId: string, currency: string, subscriptionId: string): string {
  return JSON.stringify({
    version: 1,
    reportCurrency: currency,
    scope: { kind: "project" },
    includeArchived: false,
    stages: {
      [taskId]: [{
        id: "impl",
        kind: "implementation",
        effort: { optimisticMs: 1_000, expectedMs: 2_000, conservativeMs: 3_000 },
        repetitions: null,
        harnessFromTask: true,
        harnessId: null,
        modelFromTask: true,
        modelId: null,
        consumption: null,
      }],
    },
    dependencies: {},
    parallelism: { maxConcurrentItems: null },
    machine: { dutyCycle: null, plannedPauseMs: null },
    budgetMode: "unset",
    maxAdditionalSpend: null,
    allowedPaidServices: [],
    subscriptionUpgradeAllowed: false,
    subscriptions: [{
      id: subscriptionId,
      provider: "test",
      commitment: "existing",
      planLabel: "Pro",
      recurringFee: { currency, minor: 2_000 },
      purchasePrice: null,
      billingPeriod: "monthly",
      capacity: null,
      overageEnabled: false,
      overagePrices: null,
    }],
    pinnedSubscriptionId: subscriptionId,
    accountConcurrency: null,
    apiRates: null,
    exchangeRates: [],
  });
}

test("empty portfolio is a known zero", () => {
  clearRegistry();
  const result = getPortfolioAnalysis();
  expect(result.status).toBe(200);
  if (!("analysis" in result.body)) throw new Error("expected analysis");
  expect(result.body.analysis.aggregate?.projectCount).toBe(0);
  expect(result.body.analysis.aggregate?.taskCount).toEqual({ status: "known", value: 0, knownValue: 0, note: null });
  expect(result.body.snapshot.stalenessAfterMs).toBe(PORTFOLIO_STALENESS_MS);
});

test("one project keeps a missing priority unknown", () => {
  clearRegistry();
  const dir = addProject("One");
  const id = addTask(dir, "loose");
  const { snapshot } = buildPortfolioSnapshot();
  const project = snapshot.projects.find((item) => item.path === dir);
  const task = project?.tasks.find((item) => item.id === id);
  expect(task?.priority).toMatchObject({ value: null, origin: "unknown" });
  expect(project?.coverage.board).toBe(true);
  expect(project?.observedAtMs).toBe(snapshot.capturedAtMs);
});

test("projects stay isolated", () => {
  clearRegistry();
  const alpha = addProject("Alpha");
  const beta = addProject("Beta");
  const alphaTask = addTask(alpha, "alpha-only");
  addTask(beta, "beta-only");
  const { snapshot } = buildPortfolioSnapshot();
  const alphaProject = snapshot.projects.find((item) => item.path === alpha);
  const betaProject = snapshot.projects.find((item) => item.path === beta);
  expect(alphaProject?.tasks.map((task) => task.id)).toEqual([alphaTask]);
  expect(betaProject?.tasks.some((task) => task.id === alphaTask)).toBe(false);
});

test("tasks in a subfolder of a project are counted on that project", () => {
  clearRegistry();
  const dir = addProject("Mono");
  mkdirSync(path.join(dir, "packages", "web"), { recursive: true });
  const rootTask = addTask(dir, "root task");
  const subTask = addTask(path.join(dir, "packages", "web"), "sub task", "running");
  addRun(subTask, "running");
  const { snapshot } = buildPortfolioSnapshot();
  const project = snapshot.projects.find((item) => item.path === dir);
  expect(project?.tasks.map((task) => task.id).sort()).toEqual([rootTask, subTask].sort());
  expect(project?.runs.map((run) => run.taskId)).toEqual([subTask]);
});

test("a sibling folder that shares a name prefix is not a subfolder", () => {
  clearRegistry();
  const parent = mkdtempSync(path.join(tmpdir(), "fo008c-prefix-"));
  const app = path.join(parent, "app");
  const app2 = path.join(parent, "app2");
  mkdirSync(app);
  mkdirSync(app2);
  dbMod.projects.upsert(app, "App");
  const stray = addTask(app2, "belongs elsewhere");
  const own = addTask(app, "own");
  const { snapshot } = buildPortfolioSnapshot();
  const project = snapshot.projects.find((item) => item.path === app);
  expect(project?.tasks.map((task) => task.id)).toEqual([own]);
  expect(project?.tasks.some((task) => task.id === stray)).toBe(false);
});

test("a task in a nested registered project counts only on the nested project", () => {
  clearRegistry();
  const outer = addProject("Outer");
  const inner = path.join(outer, "services", "api");
  mkdirSync(path.join(inner, "src"), { recursive: true });
  dbMod.projects.upsert(inner, "Inner");
  const innerTask = addTask(path.join(inner, "src"), "inner work");
  const outerTask = addTask(path.join(outer, "services"), "outer work");
  const { snapshot } = buildPortfolioSnapshot();
  const outerProject = snapshot.projects.find((item) => item.path === outer);
  const innerProject = snapshot.projects.find((item) => item.path === inner);
  expect(outerProject?.tasks.map((task) => task.id)).toEqual([outerTask]);
  expect(innerProject?.tasks.map((task) => task.id)).toEqual([innerTask]);
});

test("review is not done and a failed run does not complete the card", () => {
  clearRegistry();
  const dir = addProject("Review");
  const reviewId = addTask(dir, "needs review", "review");
  const failedId = addTask(dir, "failed run", "ready");
  addRun(failedId, "failed");
  const body = getPortfolioAnalysis();
  if (!("analysis" in body.body)) throw new Error("expected analysis");
  const project = body.body.analysis.projects.find((item) => item.path === dir);
  expect(project?.reviewCount).toBe(1);
  expect(project?.doneCount).toBe(0);
  expect(project?.failedRunCount).toBe(1);
  expect(project?.columns?.review).toBe(1);
  expect(project?.columns?.done).toBe(0);
  const health = body.body.analysis.health.find((item) => item.projectId === dir);
  expect(health?.signals).toContain("waiting-for-owner");
  expect(health?.signals).toContain("needs-attention");
  void reviewId;
});

test("a blocked project and a paused batch count the task once", () => {
  clearRegistry();
  const dir = addProject("Blocked");
  const blocked = addTask(dir, "stuck", "blocked");
  const queued = addTask(dir, "queued", "ready");
  dbMod.executionBatches.put({
    id: `batch-${randomUUID()}`,
    projectPath: dir,
    status: "paused",
    data: JSON.stringify({
      id: "batch-paused",
      status: "paused",
      entries: [{ taskId: queued }, { taskId: blocked }],
    }),
    createdAt: Date.now(),
  });
  const body = getPortfolioAnalysis();
  if (!("analysis" in body.body)) throw new Error("expected analysis");
  const project = body.body.analysis.projects.find((item) => item.path === dir);
  expect(project?.taskCount).toBe(2);
  expect(project?.blockedCount).toBe(1);
  expect(project?.pausedBatchCount).toBe(1);
  expect(body.body.analysis.health.find((item) => item.projectId === dir)?.signals).toContain("blocked");
});

test("several running runs stay on their project", () => {
  clearRegistry();
  const dir = addProject("Running");
  addRun(addTask(dir, "a", "running"), "running");
  addRun(addTask(dir, "b", "running"), "running");
  const body = getPortfolioAnalysis();
  if (!("analysis" in body.body)) throw new Error("expected analysis");
  const project = body.body.analysis.projects.find((item) => item.path === dir);
  expect(project?.activeRunCount).toBe(2);
  expect(body.body.analysis.aggregate?.activeRunCount.status).toBe("known");
  expect(body.body.analysis.aggregate?.activeRunCount.value).toBe(2);
});

test("a missing environment is not a guessed phase", () => {
  clearRegistry();
  const dir = addProject("No env");
  const { snapshot } = buildPortfolioSnapshot();
  const project = snapshot.projects.find((item) => item.path === dir);
  expect(project?.environment.configured).toMatchObject({ value: false, origin: "observed" });
  expect(project?.environment.phase.origin).toBe("unknown");
  expect(project?.environment.phase.value).toBeNull();
});

test("a freshly recorded degraded phase is shown and not probed", () => {
  clearRegistry();
  const dir = addProject("Degraded");
  const at = Date.now() - 1000;
  dbMod.db.run(
    `INSERT INTO environment_profiles (id, project_path, data, updated_at) VALUES (?, ?, ?, ?)`,
    [`env-degraded-${randomUUID()}`, dir, JSON.stringify({ runtime: { phase: "degraded", updatedAt: at } }), at],
  );
  const body = getPortfolioAnalysis();
  if (!("analysis" in body.body)) throw new Error("expected analysis");
  const project = body.body.analysis.projects.find((item) => item.path === dir);
  expect(project?.environmentPhase).toBe("degraded");
  expect(project?.environmentPhaseFreshness).toBe("current");
  expect(body.body.analysis.health.find((item) => item.projectId === dir)?.signals).toContain("degraded");
});

test("an old stored degraded phase is history, and the current state is unknown", () => {
  clearRegistry();
  const dir = addProject("Old degraded");
  const at = Date.now() - 2 * 24 * 3600_000;
  dbMod.db.run(
    `INSERT INTO environment_profiles (id, project_path, data, updated_at) VALUES (?, ?, ?, ?)`,
    [`env-old-${randomUUID()}`, dir, JSON.stringify({ runtime: { phase: "error", updatedAt: at } }), at],
  );
  const body = getPortfolioAnalysis();
  if (!("analysis" in body.body)) throw new Error("expected analysis");
  const project = body.body.analysis.projects.find((item) => item.path === dir);
  // The observation is kept, but it is not presented as the current phase.
  expect(project?.environmentPhase).toBeNull();
  expect(project?.environmentRecordedPhase).toBe("error");
  expect(project?.environmentPhaseObservedAtMs).toBe(at);
  expect(project?.environmentPhaseFreshness).toBe("stale");
  expect(project?.environmentPhaseNote).toContain("current state is unknown");
  const health = body.body.analysis.health.find((item) => item.projectId === dir);
  expect(health?.signals).not.toContain("degraded");
  expect(health?.signals).toContain("unknown");
  expect(health?.historicalFindings.some((item) => item.signal === "degraded" && !item.current)).toBe(true);
  expect(body.body.analysis.aggregate?.environments.counts["error"]).toBeUndefined();
  expect(body.body.analysis.aggregate?.environments.counts["phase-unknown"]).toBe(1);
});

test("percent used is not remaining quota", () => {
  clearRegistry();
  const dir = addProject("Quota");
  addTask(dir, "uses claude");
  dbMod.harnessUsage.upsert({
    harnessId: "claude-code",
    kind: "claude-code",
    planType: "Pro",
    status: "ok",
    source: "cache",
    fetchedAtMs: Date.now(),
    meters: [{ id: "session", label: "Session", usedPercent: 100, resetsAtMs: null }],
    reason: null,
  });
  const { snapshot } = buildPortfolioSnapshot();
  const resource = snapshot.resources.find((item) => item.id === "harness:claude-code");
  expect(resource?.quota).toMatchObject({ kind: "percent-used", usedPercent: 100 });
  const body = getPortfolioAnalysis();
  if (!("analysis" in body.body)) throw new Error("expected analysis");
  expect(body.body.analysis.conflicts.some((conflict) => conflict.code.includes("exhausted"))).toBe(false);
  expect(body.body.analysis.resources.find((item) => item.id === "harness:claude-code")?.quotaTreatment).toBe("percent-used-not-capacity");
});

test("an old quota snapshot is not shown as current", () => {
  clearRegistry();
  const dir = addProject("Old quota");
  addTask(dir, "uses claude");
  dbMod.harnessUsage.upsert({
    harnessId: "claude-code",
    kind: "claude-code",
    planType: "Pro",
    status: "ok",
    source: "cache",
    fetchedAtMs: Date.now() - 24 * 60 * 60 * 1000,
    meters: [{ id: "session", label: "Session", usedPercent: 40, resetsAtMs: null }],
    reason: null,
  });
  const { snapshot } = buildPortfolioSnapshot();
  const resource = snapshot.resources.find((item) => item.id === "harness:claude-code");
  expect(resource?.quota.kind).toBe("unknown");
  expect(resource?.quotaOrigin).toBe("unknown");
  dbMod.harnessUsage.delete("claude-code");
});

test("a harness without an account id carries an unidentified-account warning", () => {
  clearRegistry();
  addProject("Accounts");
  const body = getPortfolioAnalysis();
  if (!("analysis" in body.body)) throw new Error("expected analysis");
  const view = body.body.analysis.resources.find((item) => item.id === "harness:claude-code");
  expect(view?.accountId).toBeNull();
  expect(view?.warnings.some((warning) => warning.includes("account behind this harness is not identified"))).toBe(true);
});

test("unknown quota does not confirm a block when unknown limits are allowed", () => {
  clearRegistry();
  dbMod.harnessUsage.delete("claude-code");
  const dir = addProject("Unknown quota");
  addTask(dir, "open");
  const body = getPortfolioAnalysis();
  if (!("analysis" in body.body)) throw new Error("expected analysis");
  const resource = body.body.snapshot.resources.find((item) => item.id === "harness:claude-code");
  expect(resource?.quota.kind).toBe("unknown");
  const quotaConflicts = body.body.analysis.conflicts.filter((conflict) => conflict.resourceId === "harness:claude-code" && conflict.code.includes("quota"));
  expect(quotaConflicts.every((conflict) => conflict.class === "insufficient-data")).toBe(true);
  expect(quotaConflicts.every((conflict) => conflict.blocksAutomaticExecution === false)).toBe(true);
  expect(quotaConflicts.every((conflict) => conflict.runningAgents === "unchanged")).toBe(true);
});

test("a disabled harness is a confirmed conflict and does not stop agents", () => {
  clearRegistry();
  dbMod.harnesses.setEnabled("claude-code", false);
  const dir = addProject("Disabled");
  addTask(dir, "blocked by harness");
  const body = getPortfolioAnalysis();
  dbMod.harnesses.setEnabled("claude-code", true);
  if (!("analysis" in body.body)) throw new Error("expected analysis");
  const conflict = body.body.analysis.conflicts.find((item) => item.class === "confirmed");
  expect(conflict?.runningAgents).toBe("unchanged");
  expect(conflict?.blocksAutomaticExecution).toBe(true);
  expect(body.body.analysis.projects.find((item) => item.path === dir)?.taskCount).toBe(1);
});

test("two projects share one harness resource", () => {
  clearRegistry();
  const alpha = addProject("Share A");
  const beta = addProject("Share B");
  addTask(alpha, "a");
  addTask(beta, "b");
  const body = getPortfolioAnalysis();
  if (!("analysis" in body.body)) throw new Error("expected analysis");
  const resource = body.body.analysis.resources.find((item) => item.id === "harness:claude-code");
  expect(resource?.projectIds.sort()).toEqual([alpha, beta].sort());
  expect(body.body.snapshot.resources.filter((item) => item.harnessId === "claude-code")).toHaveLength(1);
});

test("a shared subscription fee is counted once", () => {
  clearRegistry();
  const alpha = addProject("Sub A");
  const beta = addProject("Sub B");
  const alphaTask = addTask(alpha, "priced a");
  const betaTask = addTask(beta, "priced b");
  dbMod.projectEstimation.set(alpha, settingsJson(alphaTask, "USD", "shared-sub"), "fp");
  dbMod.projectEstimation.set(beta, settingsJson(betaTask, "USD", "shared-sub"), "fp");
  const body = getPortfolioAnalysis();
  if (!("analysis" in body.body)) throw new Error("expected analysis");
  expect(body.body.analysis.estimation?.subscriptions.money).toEqual({ currency: "USD", minor: 2_000 });
  expect(body.body.analysis.estimation?.subscriptions.status).toBe("known");
});

test("mixed report currencies are not converted", () => {
  clearRegistry();
  const alpha = addProject("USD");
  const beta = addProject("EUR");
  const alphaTask = addTask(alpha, "usd");
  const betaTask = addTask(beta, "eur");
  dbMod.projectEstimation.set(alpha, settingsJson(alphaTask, "USD", "sub-usd"), "fp");
  dbMod.projectEstimation.set(beta, settingsJson(betaTask, "EUR", "sub-eur"), "fp");
  const body = getPortfolioAnalysis();
  if (!("analysis" in body.body)) throw new Error("expected analysis");
  expect(body.body.snapshot.reportCurrency).toBeNull();
  expect(body.body.analysis.estimation?.subscriptions.money).toBeNull();
  expect(body.body.analysis.estimation?.subscriptions.status).not.toBe("known");
  expect(body.body.adapterWarnings.some((warning) => warning.includes("currencies"))).toBe(true);
});

test("a project without saved inputs has no invented estimate", () => {
  clearRegistry();
  const dir = addProject("No estimate");
  addTask(dir, "unpriced");
  const body = getPortfolioAnalysis();
  if (!("analysis" in body.body)) throw new Error("expected analysis");
  expect(body.body.snapshot.projects.find((item) => item.path === dir)?.estimate).toBeNull();
  expect(body.body.analysis.estimation?.agent.status).toBe("unknown");
  expect(body.body.analysis.estimation?.agent.ms).toBeNull();
});

test("saved inputs produce an estimate through the existing engine", () => {
  clearRegistry();
  const dir = addProject("Estimated");
  const taskId = addTask(dir, "sized");
  dbMod.projectEstimation.set(dir, settingsJson(taskId, "USD", "solo-sub"), "fp");
  const body = getPortfolioAnalysis();
  if (!("analysis" in body.body)) throw new Error("expected analysis");
  const estimate = body.body.snapshot.projects.find((item) => item.path === dir)?.estimate;
  expect(estimate?.agent.ms).toBe(2_000);
  expect(estimate?.agent.status === "known" || estimate?.agent.status === "estimated").toBe(true);
  expect(body.body.analysis.estimation?.agent.ms).toBe(2_000);
});

test("an unreadable board row is not counted as zero", () => {
  clearRegistry();
  const dir = addProject("Partial");
  const id = addTask(dir, "good", "ready");
  addTask(dir, "also", "backlog");
  dbMod.db.run(`UPDATE tasks SET column = ? WHERE id = ?`, ["nope", id]);
  const body = getPortfolioAnalysis();
  if (!("analysis" in body.body)) throw new Error("expected analysis");
  const project = body.body.analysis.projects.find((item) => item.path === dir);
  expect(project?.boardObserved).toBe(false);
  expect(project?.taskCount).toBeNull();
  expect(body.body.analysis.aggregate?.taskCount.status).toBe("unknown");
  expect(body.body.analysis.aggregate?.taskCount.value).toBeNull();
});

test("a declared priority is kept and an absent one is not Normal", () => {
  clearRegistry();
  const dir = addProject("Priority");
  const critical = addTask(dir, "critical");
  const plain = addTask(dir, "plain");
  dbMod.taskScheduling.setPriority(critical, "critical");
  const { snapshot } = buildPortfolioSnapshot();
  const project = snapshot.projects.find((item) => item.path === dir);
  expect(project?.tasks.find((task) => task.id === critical)?.priority).toMatchObject({ value: "critical", origin: "user-provided" });
  expect(project?.tasks.find((task) => task.id === plain)?.priority.origin).toBe("unknown");
});

test("reading the snapshot does not write tasks or spawn a CLI", () => {
  clearRegistry();
  const dir = addProject("Stable");
  addTask(dir, "still");
  const before = dbMod.db.query<{ n: number }, []>(`SELECT COUNT(*) AS n FROM tasks`).get()?.n;
  const source = readFileSync(new URL("./portfolio-adapter.ts", import.meta.url), "utf8");
  expect(source.includes("Bun.spawn")).toBe(false);
  expect(source.includes("child_process")).toBe(false);
  expect(source.includes(".which(")).toBe(false);
  expect(source.includes("model-discovery")).toBe(false);
  const changesBefore = dbMod.db.query<{ n: number }, []>(`SELECT total_changes() AS n`).get()?.n;
  buildPortfolioSnapshot();
  getPortfolioAnalysis();
  expect(dbMod.db.query<{ n: number }, []>(`SELECT total_changes() AS n`).get()?.n).toBe(changesBefore);
  expect(dbMod.db.query<{ n: number }, []>(`SELECT COUNT(*) AS n FROM tasks`).get()?.n).toBe(before);
});

test("more projects than the core allows is a 422, not a trimmed total", () => {
  clearRegistry();
  for (let i = 0; i < 81; i += 1) addProject(`Cap ${i}`);
  const result = getPortfolioAnalysis();
  expect(result.status).toBe(422);
  expect("error" in result.body && result.body.error.includes("Portfolio analysis")).toBe(true);
});


test("account identity applies to declared planning profiles but never rewrites run history", async () => {
  clearRegistry();
  const { AccountCore } = await import("./account-core.ts");
  const core = new AccountCore(dbMod.db);
  const a = core.createAccount({ provider: "fixture", displayName: "Fixture" });
  const dir = addProject("Account planning");
  const taskId = addTask(dir, "declared", "ready");
  const runningId = addTask(dir, "historical", "running");
  const profile = dbMod.agentProfiles.insert({ name: "FO009 planning", harness: "claude-code", model: "fake-model" });
  core.bindHarness(a.id, "claude-code"); core.bindProfile(a.id, profile.id);
  dbMod.db.run("UPDATE tasks SET agent_profile_id = ? WHERE id IN (?, ?)", [profile.id, taskId, runningId]);
  addRun(runningId, "running");
  const before = dbMod.db.query("SELECT * FROM runs WHERE task_id = ?").all(runningId);
  try {
    const result = getPortfolioAnalysis();
    expect(result.status).toBe(200);
    if (!("snapshot" in result.body)) throw new Error("analysis missing");
    const project = result.body.snapshot.projects.find(p => p.path === dir)!;
    expect(project.tasks.find(t => t.id === taskId)?.accountId).toBe(a.id);
    expect(project.tasks.find(t => t.id === runningId)?.accountId).toBeNull();
    expect(project.runs[0]?.accountId).toBeNull();
    expect(result.body.snapshot.resources.find(r => r.accountId === a.id)?.occupiedSlots.value).toBeNull();
    expect(dbMod.db.query("SELECT * FROM runs WHERE task_id = ?").all(runningId)).toEqual(before);
  } finally { core.archiveAccount(a.id); }
});

test("independent legacy windows, passed resets and failed evidence do not invent current capacity", () => {
  clearRegistry();
  const now = Date.now();
  const original = { harnessId: "claude-code", kind: "claude-code" as const, planType: null, status: "ok" as const,
    source: "cache" as const, fetchedAtMs: now, reason: "SECRET", meters: [{ id: "session", label: "session", usedPercent: 10, resetsAtMs: null as number | null }] };
  try {
    for (const quota of [
      { ...original, meters: [...original.meters, { id: "weekly", label: "weekly", usedPercent: 100, resetsAtMs: null }] },
      { ...original, meters: [{ ...original.meters[0]!, resetsAtMs: now - 1 }] },
      { ...original, status: "error" as const },
    ]) {
      dbMod.harnessUsage.upsert(quota);
      const resource = buildPortfolioSnapshot(now).snapshot.resources.find(r => r.id === "harness:claude-code")!;
      expect(resource.quota.kind).toBe("unknown");
      expect(JSON.stringify(resource)).not.toContain("SECRET");
    }
  } finally { dbMod.harnessUsage.delete("claude-code"); }
});
