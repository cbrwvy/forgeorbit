import { afterAll, expect, spyOn, test } from "bun:test";
import { mkdtempSync, mkdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Database } from "bun:sqlite";
import { RUN_USAGE_STATUS_PREFIX } from "../../shared/usage-analytics.ts";
import { writeSyntheticCodexProfile } from "../../../e2e/codex-profile-fixture.ts";
import type { MissionPlan } from "../../shared/orchestration/types.ts";
import { computeMissionPlanDigest } from "../../shared/orchestration/plan-digest.ts";
import { scheduleItems } from "../../shared/estimation/schedule.ts";

const root = realpathSync(mkdtempSync(join(tmpdir(), "fo-usage-")));
const localHome = join(root, "home");
mkdirSync(localHome);
process.env.HOME = localHome;
process.env.FORGEORBIT_DATA_DIR = join(root, "data");
process.env.AGETOR_USAGE_OFFLINE = "1";
process.env.AGETOR_CODEX_DRIVER = "fake";
process.env.AGETOR_CLAUDE_DRIVER = "fake";
process.env.AGETOR_DISABLE_UPDATES = "1";

const { db, harnesses, projects, runs, tasks, dataDir } = await import("../db.ts");
const { BackupManager } = await import("../backup-manager.ts");
const { restoreBackupSnapshot } = await import("../backup-restore.ts");
const { AccountCore } = await import("../account-core.ts");
const { CodexProfiles } = await import("../codex-profiles.ts");
const { taskActuals, summarizeRuns, unionMs } = await import("./actuals.ts");
const { taskBreakdown, analytics } = await import("./analytics.ts");
const { recordAdjustment } = await import("./adjustments.ts");
const { quotaConsumption } = await import("./quota-consumption.ts");
const { renderAnalyticsExport } = await import("./export.ts");
const { quotaHistory, usageResources, pricingAt } = await import("./resources.ts");
const { compareQuotaDemand, forecast, estimateVersions } = await import("./forecast.ts");
const { usageAnalyticsHttp } = await import("./http.ts");
const { routingQuota } = await import("../router-v2/router-v2-quota-adapters.ts");
const { setProjectAccountPreference } = await import("../multiaccount/registry.ts");
const { headUsageEvidence } = await import("./head.ts");
const { missionStore } = await import("../orchestration/mission-store.ts");
const { createAutonomyPolicy, activateAutonomyPolicy, authorizeAutonomyAction } = await import("../autonomy/policy-engine.ts");

const core = new AccountCore(db);
const profiles = new CodexProfiles(core);
const project = join(root, "sample");
mkdirSync(project);
writeFileSync(join(project, "package.json"), "{}");
projects.upsert(project, "Usage sample");
const model = "gpt-6.1-sol";
const model2 = "gpt-6-luna";
const account = (name: string) => {
  const directory = join(localHome, name);
  writeSyntheticCodexProfile(directory, "synthetic-" + name);
  return profiles.register({ displayName: name, directory });
};
const a = account("Usage A");
const b = account("Usage B");
const createdAt = Date.now() - 3_600_000;

function task(title: string, prompt = "Add an example. Acceptance: add tests.", harness = a.harnessId, workdir = project, selectedModel = model) {
  const id = crypto.randomUUID();
  db.run(`INSERT INTO tasks(id,title,prompt,"column",agent,workdir,model,mode,created_at,updated_at)
    VALUES (?,?,?,'backlog',?,?,?,'auto',?,?)`, [id, title, prompt, harness, workdir, selectedModel, createdAt, createdAt]);
  return id;
}

function record(taskId: string, start: number, end: number, options: {
  qc?: string; execution?: "real-provider" | "synthetic"; input?: number; withTokens?: boolean; accountId?: string;
  harnessId?: string; modelId?: string; mode?: string; sessionId?: string; billed?: { amount: number; currency: string }; status?: "succeeded" | "failed" | "orphaned";
} = {}) {
  const id = crypto.randomUUID();
  runs.insert({
    id, taskId, agent: options.harnessId ?? a.harnessId, status: options.status ?? "succeeded", startedAt: start, endedAt: end, exitCode: 0,
    qcReviewId: options.qc, tmuxSession: null, claudeSessionId: null, codexSessionId: options.sessionId ?? id,
    cursorSessionId: null, geminiSessionId: null, fxSessionId: null,
  });
  const event = (payload: string) => db.run("INSERT INTO run_events(run_id,stream,data,ts) VALUES (?,'status',?,?)", [id, payload, end]);
  event(JSON.stringify({ kind: "execution-identity", executionType: options.execution ?? "real-provider",
    provider: "codex", model: options.modelId ?? model, mode: options.mode ?? "auto", accountProfile: { id: options.accountId ?? a.accountId } }));
  if (options.withTokens !== false) event(RUN_USAGE_STATUS_PREFIX + JSON.stringify({
    input: options.input ?? 100_000, output: 50_000, cacheRead: 30_000, cacheWrite: 0, billed: options.billed,
  }));
  return id;
}

const complete = (id: string, at: number) => {
  tasks.update(id, { column: "done" });
  db.run("UPDATE usage_task_transitions SET at = ? WHERE task_id = ? AND destination = 'done'", [at, id]);
};

const revision = (harnessId: string, accountId: string, billing: string, at: number, input = 2) =>
  db.run("INSERT INTO usage_pricing(harness_id,account_id,model_id,created_at,terms) VALUES (?,?,?,?,?)", [
    harnessId, accountId, model, at, JSON.stringify({ billing, currency: "USD", inputPerMillion: input,
      outputPerMillion: 8, cacheReadPerMillion: 1, cacheWritePerMillion: 0 }),
  ]);
afterAll(() => { db.close(); rmSync(root, { recursive: true, force: true }); });

test("verified quota, configured limits, and unknown reset are separate and credential-free", async () => {
  const known = core.createDefinition({ accountId: a.accountId, scope: "account", unit: { kind: "requests" }, window: "5h" });
  const manual = core.createDefinition({ accountId: b.accountId, scope: "account", unit: { kind: "tokens" }, window: "monthly" });
  const now = Date.now();
  core.recordObservation(manual.id, { remaining: 800, limit: 1000, expiresAt: now + 10000 });
  core.recordTrustedObservations("synthetic-fixture", [{ quotaId: known.id, values: {
    remaining: 20, used: 80, limit: 100, expiresAt: now + 3600_000,
  }, evidence: { provider: "openai", accountId: a.accountId, subject: "synthetic-private-subject", method: "provider-account",
    sourceId: "synthetic-fixture", officialUrl: "https://example.invalid", checkedAt: "2026-11-10", receivedAt: now, sharedPool: null, limitations: "fixture" } }]);
  const snapshot = usageResources();
  expect(snapshot.accounts.find(row => row.id === a.accountId)?.quota[0]?.current).toMatchObject({ remaining: 20, resetAt: null, verification: "verified" });
  expect(snapshot.accounts.find(row => row.id === b.accountId)?.quota[0]).toMatchObject({ current: null, observations: [{ limit: 1000, provenance: "user-provided" }] });
  expect(JSON.stringify(snapshot)).not.toMatch(/synthetic-private-subject|access_token|auth\.json|CODEX_HOME/);
  expect((await usageAnalyticsHttp(new Request("http://localhost/api/usage-analytics/resources"), false)).status).toBe(401);
});

test("resource inventory separates installed, authenticated, bound and executable facts", () => {
  const stub = join(localHome, "installed-cursor-fixture");
  writeFileSync(stub, "#!/bin/sh\nexit 1\n", { mode: 0o700 });
  const previous = process.env.AGETOR_CURSOR_BIN;
  process.env.AGETOR_CURSOR_BIN = stub;
  try {
    expect(harnesses.get("cursor")).not.toBeNull();
    const snapshot = usageResources();
    expect(snapshot.inventory.map(p => p.kind)).toEqual(expect.arrayContaining([
      "codex", "claude-code", "cursor", "antigravity", "gemini", "fx", "deepseek-dsh",
    ]));
    expect(snapshot.inventory.find(p => p.kind === "cursor")).toMatchObject({
      installed: true, harnesses: expect.arrayContaining([expect.objectContaining({ auth: null })]), blockers: expect.any(Array),
    });
    expect(snapshot.resources.find(r => r.harnessId === "cursor")?.blocks).toContain("cursor-internal-sandbox-unavailable");
    expect(snapshot.accounts.find(row => row.id === a.accountId)?.identity).toBe("unverified");
    expect(snapshot.resources.find(r => r.harnessId === a.harnessId)?.binding).toBe("exact");
  } finally {
    if (previous === undefined) delete process.env.AGETOR_CURSOR_BIN;
    else process.env.AGETOR_CURSOR_BIN = previous;
  }
});

test("backlog comparison revisions freeze transactionally and cannot authorize execution", () => {
  const id = task("Revisioned task");
  const first = forecast({ taskIds: [id], save: true }).estimates[0]!;
  expect(first).toMatchObject({ confidence: "low", subscriptionUsage: null, roles: ["developer", "reviewer"] });
  expect(first.completion.optimistic).toBeLessThan(first.completion.expected);
  expect(first.completion.expected).toBeLessThan(first.completion.conservative);
  expect(first.developerOptions.some(o => o.accountId === b.accountId && o.modelId === model2)).toBe(true);
  expect(first.developerOptions.every(o => !["cursor", "deepseek-dsh"].includes(o.provider))).toBe(true);
  expect(first.developer).toMatchObject({ accountId: a.accountId, modelId: model });
  expect(runs.countForTask(id)).toBe(0);
  expect(forecast({ taskIds: [id], save: true }).estimates[0]?.estimateId).toBe(first.estimateId);
  tasks.update(id, { prompt: "Refactor authentication, concurrency and migrations. Add tests." });
  expect(estimateVersions(id)[0]?.stale).toBe(true);
  const next = forecast({ taskIds: [id], save: true }).estimates[0]!;
  expect(next.estimateId).not.toBe(first.estimateId);
  expect(next.completion.expected).toBeGreaterThan(first.completion.expected);
  const start = Date.now();
  record(id, start, start + 1500, { execution: "synthetic" });
  expect(taskBreakdown(id)?.estimate?.estimateId).toBe(next.estimateId!);
  tasks.update(id, { prompt: "Further change after work starts." });
  expect(taskBreakdown(id)?.estimate?.estimateId).toBe(next.estimateId!);
  expect(authorizeAutonomyAction({ routerRecommended: true, target: { action: "launch_task", taskId: id, projectPath: project } }).decision.allow).toBe(false);
  const terms = {
    mode: "full-autonomy", scopeKind: "project", scopeRef: project, projects: [project],
    permittedActions: ["launch_task"], specialistRoles: ["developer"], providers: ["codex"], models: [model],
    accounts: [b.accountId], maxConcurrentWorkers: 1, maxLaunches: 2, maxDurationMs: 60000,
  };
  const cap = createAutonomyPolicy({ ...terms, spending: { limitUsd: 1, requireEnforceableCap: true } });
  expect(() => activateAutonomyPolicy(cap.id)).toThrow(/not enforceable/);
  const strict = createAutonomyPolicy({ ...terms, requireVerifiedQuota: true });
  activateAutonomyPolicy(strict.id);
  expect(authorizeAutonomyAction({ target: { projectPath: project, taskId: id, action: "launch_task", role: "developer",
    provider: "codex", model, accountId: b.accountId } }).decision).toMatchObject({ allow: false, reason: expect.stringContaining("verified quota") });
});

test("accounting separates overlapping wall time, reviewer cost, rework, and missing costs", () => {
  const base = Date.now() - 40_000;
  revision(a.harnessId, a.accountId, "api", base - 10);
  const id = task("Recorded execution");
  const qid = crypto.randomUUID();
  db.run("INSERT INTO usage_task_transitions(task_id,destination,at) VALUES (?,'ready',?)", [id, base - 4000]);
  const dev = record(id, base, base + 10_000);
  const reviewer = record(id, base + 5000, base + 15_000, { qc: qid, billed: { amount: 0.8, currency: "USD" } });
  db.run(`INSERT INTO task_quality_reviews(id,task_id,project_path,round,status,verdict,reviewer_harness,reviewer_model,
    implementation_run_id,review_run_id,saved_task_json,requested_at,started_at,completed_at)
    VALUES (?,?,?,1,'completed','CHANGES_REQUESTED',?,?,?,?,'{}',?,?,?)`,
    [qid, id, project, a.harnessId, model, dev, reviewer, base + 5000, base + 5000, base + 15_000]);
  db.run(`INSERT INTO practical_test_attempts(id,task_id,project_path,workspace_path,rework_epoch,command,command_fingerprint,
    source_fingerprint,status,isolation,implementation_execution,started_at,finished_at)
    VALUES ('test-fixture',?,?,?,0,'bun test','cmd','source','failed','offline','provider',?,?)`,
    [id, project, project, base + 10_000, base + 13_000]);
  record(id, base + 16_000, base + 20_000, { withTokens: false });
  complete(id, base + 25_000);
  const actual = taskActuals(id)!;
  expect(actual).toMatchObject({ queueMs: 4000, executionElapsedMs: 25000, totalElapsedMs: base + 25_000 - createdAt,
    workerMs: 24000, activeWallMs: 19000, qcMs: 10000, testMs: 3000, reworkMs: 4000, reworks: 1, humanMs: null });
  expect(actual.runs.map(r => r.role)).toEqual(["developer", "reviewer", "developer"]);
  expect(actual.runs[0]).toMatchObject({ taskId: id, mode: "auto", accountId: a.accountId, provider: "openai",
    model, start: expect.any(Number), scope: { projectPath: project } });
  expect(actual.runs[0]?.cost.money?.amount).toBeCloseTo(.57);
  expect(actual.runs[1]?.cost).toMatchObject({ kind: "reported-api", money: { amount: .8 } });
  expect(actual.runs[2]?.cost.money).toBeNull();
  revision(a.harnessId, a.accountId, "subscription", base + 35_000, 99);
  expect(taskActuals(id)?.runs[0]?.cost.money?.amount).toBeCloseTo(.57);
  const subscribed = task("Subscription fixture");
  record(subscribed, base + 35_010, base + 36_000);
  complete(subscribed, base + 37_000);
  expect(taskActuals(subscribed)?.runs[0]?.cost).toMatchObject({ kind: "subscription", money: null });
  const projectResult = analytics({ projectPath: project, from: base - 1, until: base + 38_000 });
  expect(projectResult.completed).toBe(2);
  expect(projectResult.usage).toMatchObject({ realRuns: 4, subscriptionRuns: 1, unknownCostRuns: 1 });
  expect(projectResult.reviewer.costTotals[0]?.amount).toBeCloseTo(.8);
  expect(headUsageEvidence("How much money did Developer and Reviewer consume?", {
    scope: { kind: "project", path: project }, label: project, projectPath: project, projectAddedAt: null, clusterId: null,
  }, path => path === project).join("\n")).toContain('"reported-api"');
});

test("approved mission forecast respects dependencies and account capacity", () => {
  const first = task("First");
  const second = task("Second");
  const independent = task("Independent", "Add an example. Acceptance: add tests.", b.harnessId);
  const items = [first, second, independent].map((id, index) => ({
    taskId: id, taskTitle: id, projectPath: project, specialistRole: "developer", phase: "planned" as const, priority: "normal" as const,
    dependencies: index === 1 ? [{ taskId: first, projectPath: project, condition: "done" as const }] : [],
    harnessId: index === 2 ? b.harnessId : a.harnessId, accountId: index === 2 ? b.accountId : a.accountId, modelId: model, mode: "auto",
    qcRequired: false,
  }));
  const limits = { globalMax: 2, perProjectMax: 2, perAccountMax: 1 };
  const mission = missionStore.createMission({ title: "Usage mission", goal: "offline forecast", status: "planned", clusters: [], projects: [project],
    plan: { clusters: [], projects: [project], tasks: items, concurrencyLimits: limits, executionPolicy: {
      qcRequired: false, autoResumeOnQcPass: false, maxRetriesPerTask: 0,
    } }, planDigest: "fixture-digest" });
  expect(() => forecast({ missionId: mission.id })).toThrow("approved");
  missionStore.updateMissionAuthorization(mission.id, { authorizedAt: Date.now(), authorizedBy: "owner", digest: mission.planDigest });
  const plan = forecast({ missionId: mission.id, save: true });
  expect(plan.estimates.length).toBe(3);
  expect(plan.calendar!.expected).toBeGreaterThanOrEqual(plan.criticalPathMs!);
  expect(plan.calendar?.expected).toBeLessThan(plan.estimates.reduce((sum, e) => sum + e.completion.expected, 0));
  const developer = plan.stages.find(stage => stage.taskId === first && stage.kind === "developer")!;
  const successor = plan.stages.find(stage => stage.taskId === second && stage.kind === "developer")!;
  const completed = plan.stages.find(stage => stage.taskId === first && stage.kind === "completion")!;
  expect(developer.resources).toContain("account/" + a.accountId);
  expect(successor.startMs).toBeGreaterThanOrEqual(completed.endMs);
  expect(plan.revision).not.toBeNull();
  expect(runs.countForTask(first)).toBe(0);
  missionStore.createReservation({ taskId: first, missionId: mission.id, projectPath: project, employeeId: "fixture",
    harnessId: a.harnessId, modelId: model, accountId: a.accountId, status: "starting" });
  const at = Date.now();
  const run = record(first, at, at + 200);
  complete(first, at + 300);
  missionStore.releaseReservations(mission.id);
  const aggregate = analytics({ missionId: mission.id }, at + 500);
  expect(aggregate.completed).toBe(1);
  expect(aggregate.elapsedMs).toBe(300);
  expect(taskActuals(first)?.runs.find(r => r.id === run)?.scope?.missionId).toBe(mission.id);
  expect(taskBreakdown(first)?.estimate?.estimateId).toBe(plan.estimates.find(e => e.taskId === first)?.estimateId ?? undefined);
  const graph = new Map([["b", ["a"]], ["c", []]]);
  expect(scheduleItems(["a", "b", "c"], new Map([["a", 4], ["b", 4], ["c", 4]]), graph, 2).scheduleMs).toBe(8);
});

test("three separate matching recorded genuine outcomes calibrate; synthetic stays excluded", () => {
  const base = Date.now() - 300_000;
  for (let n = 0; n < 4; n++) {
    const id = task("Training " + n, "Write a concise fixture.");
    const start = base + 50_000 * n;
    const duration = n === 3 ? 200 : 10_000 + n * 5000;
    record(id, start, start + duration, { execution: n === 3 ? "synthetic" : "real-provider", input: n === 3 ? 1 : 20_000 + n * 1000 });
    complete(id, start + duration + 1000);
  }
  const next = task("Calibrate", "Write a concise fixture.");
  const modelForecast = forecast({ taskIds: [next] }).estimates[0];
  const candidate = modelForecast?.developer;
  expect(candidate).not.toBeNull();
  expect(candidate!.samples).toBeGreaterThanOrEqual(3);
  expect(candidate!.duration.expected).toBeGreaterThan(200);
  expect(candidate!.tokens.input).not.toBe(1);
});

test("ambiguous Codex resume totals are not added to the initial run", () => {
  const at = Date.now() - 10_000;
  const id = task("Resumed Codex usage");
  const sessionId = crypto.randomUUID();
  record(id, at, at + 1000, { sessionId });
  record(id, at + 2000, at + 3000, { sessionId, input: 200_000 });
  complete(id, at + 4000);
  const actual = taskActuals(id)!;
  expect(actual.runs[1]).toMatchObject({ tokenSource: "codex-resumed-unattributable", tokens: { input: null } });
  expect(summarizeRuns(actual.runs).tokens.input).toBe(100_000);
});

test("durable records survive a reopened database and isolated profile backup and restore", async () => {
  const id = task("Persisted");
  const estimate = forecast({ taskIds: [id], save: true }).estimates[0]!;
  const start = Date.now();
  record(id, start, start + 500, { execution: "synthetic" });
  recordAdjustment({ taskId: id, amount: 1.25, currency: "EUR", note: "Owner-reported fixture adjustment" });
  const { definition, observation } = core.recordOwnerPool(a.accountId, {
    definition: { scope: "account", window: "Backup revision fixture", unit: { kind: "percentage" } },
    observation: { observedAt: start, indicator: { kind: "percent-used", value: 10 } },
  });
  const replacement = core.recordObservation(definition.id, {
    revises: observation.id, observedAt: start, indicator: { kind: "percent-used", value: 20 },
  });
  const snapshots = join(root, "snapshots");
  const restored = join(root, "restored");
  const snapshot = await new BackupManager({ db, dataDir }).createSnapshot({
    destinationDir: snapshots, createDirectory: true, manifestVersion: 4,
  });
  await restoreBackupSnapshot(snapshot.path, restored, { requireCompleteProfile: true, rebindInternalReferences: true });
  for (const filename of [join(dataDir, "agetor.sqlite"), join(restored, "agetor.sqlite")]) {
    using saved = new Database(filename, { readonly: true });
    expect(saved.query<{ usage_estimate_id: number }, [string]>("SELECT usage_estimate_id FROM runs WHERE task_id = ?").get(id)?.usage_estimate_id).toBe(estimate.estimateId!);
    const restoredCore = new AccountCore(saved);
    expect(restoredCore.history(definition.id).map(o => [o.id, o.revises ?? null, o.verification])).toEqual([
      [replacement.id, observation.id, "unverified"], [observation.id, null, "unverified"],
    ]);
    expect(saved.query("SELECT COUNT(*) FROM usage_pricing").values()[0]![0]).toBeGreaterThan(0);
    expect(saved.query<{ amount: number; currency: string }, [string]>("SELECT amount, currency FROM usage_cost_adjustments WHERE task_id = ?").get(id)).toEqual({ amount: 1.25, currency: "EUR" });
  }
  expect(pricingAt({ harnessId: a.harnessId, accountId: a.accountId, modelId: model }, Date.now())?.terms.billing).toBe("subscription");
  expect(summarizeRuns(taskActuals(id)!.runs).realRuns).toBe(0);
});

test("Owner revision, exact pool scope, trusted exhaustion, forecast and scoped Head share the journal", async () => {
  const named = account("Quota Revision Fixture");
  const neighboring = account("Unrelated Fixture");
  const now = Date.now();
  const reset = now + 86_400_000;
  const config = {
    scope: "group:shared-codex", modelIds: [model, model2], unit: { kind: "percentage" }, window: "weekly",
    windowMs: 604_800_000, category: "subscription", warnAtRemainingPercent: 30,
  };
  const first = core.recordOwnerPool(named.accountId, { definition: config, observation: {
    observedAt: now - 2000, expiresAt: reset, resetAt: reset, indicator: { kind: "percent-used", value: 50 },
    sourceNote: "Official settings page", evidenceReference: "reading 1",
  } });
  const old = core.recordObservation(first.definition.id, {
    observedAt: now - 500, expiresAt: reset, resetAt: reset, indicator: { kind: "percent-used", value: 75 },
  });
  const correction = core.recordObservation(first.definition.id, {
    revises: old.id, observedAt: old.observedAt, expiresAt: reset, resetAt: reset, indicator: { kind: "percent-used", value: 80 },
  });
  expect(() => core.recordObservation(first.definition.id, { revises: old.id, used: 5 })).toThrow("already has a correction");
  expect(() => core.recordObservation(first.definition.id, { verification: "verified" })).toThrow("Unsupported metadata");
  expect(quotaHistory(first.definition.id, null).observations.find(o => o.id === old.id)?.superseded).toBeTrue();
  expect(core.getAccount(named.accountId).verification).not.toBe("verified");
  const accountQuota = () => usageResources().accounts.find(r => r.id === named.accountId)!;
  expect(accountQuota().quota[0]).toMatchObject({ current: null, ownerReported: { id: correction.id, verification: "unverified" },
    warning: true, changes: [{ percent: 30, amount: null, provenance: "user-provided" }] });
  const route = (m: string) => routingQuota(core.currentQuotas(named.accountId), named.accountId, "openai", named.harnessId, m, Date.now());
  expect(route(model)).toMatchObject({ isUnknown: true, capacityEvidence: "owner-reported" });
  expect(route("not-in-group")).toMatchObject({ isUnknown: true, capacityEvidence: "unknown" });
  const id = task("Quota evidence backlog", undefined, named.harnessId);
  const estimate = forecast({ taskIds: [id] }).estimates[0]!;
  expect(estimate.developer).toMatchObject({ accountId: named.accountId, quotaPlan: [{ fit: "unknown" }] });
  expect(estimate.developer?.nativeQuota[0]?.ownerReported?.indicator).toEqual({ kind: "percent-used", value: 80 });
  const otherModel = task("Same quota pool, other model", undefined, named.harnessId);
  tasks.update(otherModel, { model: model2 });
  expect(forecast({ taskIds: [otherModel] }).estimates[0]?.developer?.nativeQuota[0]?.id).toBe(first.definition.id);
  const definition = core.createDefinition({ accountId: named.accountId, scope: "account", window: "daily", unit: { kind: "requests" } });
  for (const [q, remaining] of [[first.definition, null], [definition, 0]] as const) {
    core.recordTrustedObservations("recorded-app-server", [{ quotaId: q.id, values: { observedAt: now,
      expiresAt: reset, resetAt: reset, remaining, indicator: remaining === null ? { kind: "percent-used", value: 5 } : null },
      evidence: { sourceId: "recorded-app-server", provider: "openai", accountId: named.accountId, subject: "offline-fixture-subject",
        method: "provider-account", officialUrl: "https://learn.chatgpt.com/docs/app-server", checkedAt: "2026-11-10",
        receivedAt: now, limitations: "Synthetic test only", sharedPool: null } }]);
  }
  expect(route(model)).toMatchObject({ isExhausted: true, capacityEvidence: "verified-exhausted", remainingUnits: null });
  expect(route(model2)).toMatchObject({ isExhausted: true });
  expect(core.hasVerifiedHeadroom(named.accountId, named.harnessId, model)).toBeFalse();
  const exhausted = forecast({ taskIds: [id] });
  expect(exhausted.estimates[0]?.developer?.eligibility).toBe("blocked");
  expect(exhausted.capacity.rows.some(pool => pool.status === "exhausted")).toBeTrue();
  expect(exhausted.completionWindow).toBeNull();
  setProjectAccountPreference(db, { projectPath: project, role: "developer", accountId: named.accountId });
  try {
    const head = headUsageEvidence("What changed in my quota and when is the reset?", {
      scope: { kind: "project", path: project }, label: project, projectPath: project, projectAddedAt: null, clusterId: null,
    }, path => path === project).join("\n");
    expect(head).toContain('"ownerReported":');
    expect(head).toContain('"remaining":0');
    expect(head).not.toContain(neighboring.displayName);
    expect(head).not.toContain("offline-fixture-subject");
    expect(head).not.toContain("Official settings page");
  } finally {
    setProjectAccountPreference(db, { projectPath: project, role: "developer", accountId: null });
  }
  core.recordObservation(first.definition.id, { observedAt: now, resetAt: reset + 1000, expiresAt: reset + 1000,
    indicator: { kind: "percent-used", value: 10 } });
  expect(accountQuota().quota.find(q => q.id === first.definition.id)?.changes).toHaveLength(1);
  const credit = core.recordOwnerPool(named.accountId, { definition: { scope: "account", window: "credit", category: "api-credit",
    unit: { kind: "money", currency: "USD" } }, observation: { remaining: 300, expiresAt: reset } });
  const creditView = accountQuota().quota.find(q => q.id === credit.definition.id)!;
  expect(compareQuotaDemand(creditView, { kind: "calculated-api", money: { amount: 2, currency: "USD" },
    pricingId: null, source: "fixture" }, now, 1000)).toMatchObject({ fit: "fits", demand: 200 });
  expect(compareQuotaDemand(creditView, { kind: "calculated-api", money: { amount: 2, currency: "EUR" },
    pricingId: null, source: "fixture" }, now, 1000)).toMatchObject({ fit: "unknown", demand: null });
  core.updateAccount(named.accountId, { displayName: "Renamed quota fixture" });
  core.archiveAccount(named.accountId);
  expect(accountQuota()).toMatchObject({ archived: true, label: "Renamed quota fixture" });
  expect(quotaHistory(first.definition.id, null).observations).toHaveLength(5);
});

test("three-project portfolio uses one typed shared balance and counts each occupied slot once", async () => {
  const { routerV2Service } = await import("../router-v2/router-v2-service.ts");
  const { optionKey } = await import("./forecast.ts");
  const { approveAllocationPlan, applyAllocationPlan } = await import("../allocation-plans.ts");
  const capacityA = account("Capacity A");
  const capacityB = account("Capacity B");
  const now = Date.now();
  const paths = ["Planner one", "Planner two", "Planner paused"].map(name => {
    const path = join(root, name);
    mkdirSync(path);
    writeFileSync(join(path, "package.json"), "{}");
    projects.upsert(path, name);
    return path;
  });
  const prompt = "Implement a parser. Acceptance: run tests.";
  const ids = Array.from({ length: 10 }, (_, index) =>
    task("Portfolio item " + index, prompt, index < 5 ? capacityA.harnessId : capacityB.harnessId, paths[index % 3]));
  db.run("INSERT INTO task_dependencies(task_id, depends_on_id, created_at) VALUES (?, ?, ?)", [ids[1]!, ids[0]!, now]);
  db.run("INSERT INTO task_dependencies(task_id, depends_on_id, created_at) VALUES (?, ?, ?)", [ids[2]!, ids[1]!, now]);
  projects.setLifecycleState(paths[2]!, "paused", "Owner paused");

  const pool = (accountId: string, window: string, remaining: number | null, id?: string, stale = false) => {
    const def = core.createDefinition({ accountId, scope: "account", category: "api-credit", unit: { kind: "money", currency: "USD" }, window });
    const observedAt = now - 1000;
    core.recordTrustedObservations("recorded-contract", [{ quotaId: def.id, values: {
      observedAt, expiresAt: stale ? now - 10 : now + 43_200_000, resetAt: window === "exhausted" ? now + 10_000 : null,
      limit: 100_000, used: null, remaining, indicator: null, confidence: "high",
    }, evidence: {
      provider: "openai", accountId, subject: "offline-sample", method: "provider-account",
      sourceId: "recorded-contract", officialUrl: "https://example.invalid", checkedAt: "2026-11-11", receivedAt: now,
      sharedPool: id ? { id, scope: "account", window, verified: true } : null, limitations: "Recorded QA evidence",
    } }]);
    return def;
  };
  pool(capacityA.accountId, "shared", 2000, "shared-credit");
  pool(capacityB.accountId, "shared", 2000, "shared-credit");
  pool(capacityB.accountId, "independent", 3000);
  const exhausted = pool(capacityA.accountId, "exhausted", 0);
  pool(capacityB.accountId, "stale", 3000, undefined, true);
  core.createDefinition({ accountId: capacityB.accountId, scope: "account", category: "subscription", unit: { kind: "requests" }, window: "unknown" });

  const fixtures = routerV2Service.gatherCandidatesSync("developer");
  const selectCandidates = routerV2Service.gatherCandidatesSync.bind(routerV2Service);
  const routing = spyOn(routerV2Service, "gatherCandidatesSync").mockImplementation(role => selectCandidates(role)
    .filter(row => row.accountId === capacityA.accountId && row.modelId === model ||
      row.accountId === capacityB.accountId && [model, model2].includes(row.modelId))
    .map(row => ({ ...row, simulated: false, cliInstalled: true, cliLoggedIn: true })));
  try {
    expect(fixtures.some(row => row.accountId === capacityA.accountId)).toBeTrue();
    revision(capacityA.harnessId, capacityA.accountId, "api", now - 360_000);
    for (let i = 0; i < 3; i++) {
      const id = task("Historical portfolio " + i, prompt, capacityA.harnessId, paths[0]);
      const at = now - 240_000 + i * 40_000;
      record(id, at, at + 12_000, { harnessId: capacityA.harnessId, accountId: capacityA.accountId });
      complete(id, at + 14_000);
    }
    const live = task("Existing reserved work", prompt, capacityB.harnessId, project);
    const limits = { globalMax: 2, perProjectMax: 2, perAccountMax: 1 };
    const items = ids.map((id, i) => ({
      taskId: id, taskTitle: id, projectPath: paths[i % 3]!, specialistRole: "developer", phase: "authorized" as const, priority: "normal" as const,
      dependencies: [], harnessId: i < 5 ? capacityA.harnessId : capacityB.harnessId, accountId: i < 5 ? capacityA.accountId : capacityB.accountId,
      modelId: model, mode: "auto", qcRequired: false,
    }));
    const plan = { clusters: [], projects: paths, tasks: items, concurrencyLimits: limits, executionPolicy: {
      qcRequired: false, autoResumeOnQcPass: false, maxRetriesPerTask: 0,
    } };
    const mission = missionStore.createMission({ title: "Portfolio capacity fixture", goal: "offline", status: "authorized",
      projects: paths, clusters: [], plan, planDigest: computeMissionPlanDigest(plan) });
    const other = missionStore.createMission({ title: "Other mission", goal: "offline", status: "running", projects: [project],
      clusters: [], plan: { ...plan, projects: [project], tasks: [] }, planDigest: "other-fixture" });
    missionStore.updateMissionAuthorization(mission.id, { authorizedAt: now, authorizedBy: "owner", digest: mission.planDigest });
    missionStore.createReservation({ taskId: live, missionId: other.id, projectPath: project, employeeId: "active-worker",
      harnessId: capacityB.harnessId, modelId: model, accountId: capacityB.accountId, status: "running" });
    db.run("INSERT INTO runs(id,task_id,agent,status,started_at) VALUES ('capacity-live',?,?,'running',?)", [live, capacityB.harnessId, now]);
    const group = forecast({ missionId: mission.id, save: true }, now);
    expect(group.estimates).toHaveLength(10);
    expect(group.estimates[0]?.activeDeveloper?.expected).toBe(12_000);
    expect(group.estimates[1]?.confidence).toBe("low");
    expect(group.active).toEqual({ competing: 1, selected: 0, missions: 1 });
    expect(group.criticalPath).toContain(ids[0]!);
    expect(group.criticalPath).toContain(ids[2]!);
    expect(group.elapsed).toBeNull();
    expect(group.blockers).toContain("project-hold");
    expect(group.blockers).toContain("active-work");
    expect(group.completionWindow).toBeNull();
    const shared = group.capacity.rows.find(row => row.shared)!;
    expect(shared.accountIds.toSorted()).toEqual([capacityA.accountId, capacityB.accountId].toSorted());
    expect(shared.remaining).toBe(2000);
    expect(shared.knownDemand).toBe(114);
    expect(shared.active).toBeTrue();
    expect(group.capacity.rows.find(row => row.window === "independent")?.remaining).toBe(3000);
    expect(group.capacity.rows.find(row => row.window === "exhausted")?.status).toBe("exhausted");
    expect(group.capacity.rows.find(row => row.window === "unknown")?.status).toBe("unknown");
    expect(group.capacity.rows.find(row => row.window === "stale")?.freshness).toBe("stale-or-conflicting");
    expect(group.worker.expected).toBe(group.estimates.reduce((sum, e) => sum + e.worker.expected, 0));
    expect(group.worker.expected).toBe(10_824_000);
    expect(group.calendar!.expected).toBeLessThan(9_150_000);
    expect(group.stages.some(stage => stage.conditional && stage.kind === "rework")).toBeTrue();
    expect(group.estimates.every(e => runs.countForTask(e.taskId) === 0)).toBeTrue();
    const withRelease = forecast({ missionId: mission.id, assumptions: { activeReleaseMs: 3_600_000, unknownCapacity: true } }, now);
    expect(withRelease.elapsed?.expected).toBeGreaterThan(group.calendar!.expected);
    expect(withRelease.resourceWait!.expected).toBeGreaterThan(0);
    expect(withRelease.activeWall!.expected).toBeLessThan(withRelease.worker.expected);
    const resetTask = forecast({ missionId: mission.id, assumptions: { refillAtReset: true, unknownCapacity: true } }, now);
    expect(resetTask.capacity.rows.find(row => row.window === "exhausted")?.status).toBe("exhausted");
    // The multi-task pool also has uncovered stages, so a refill is only a
    // valid scenario for the measured task on its own.
    const { planCapacity } = await import("./capacity.ts");
    const stage = group.estimates[0]?.developer!;
    const scenario = [{ taskId: ids[0]!, quotas: stage.nativeQuota, cost: stage.cost, runs: 1 }];
    const ready = planCapacity(scenario, [], now, { refillAtReset: true }, false);
    expect(ready.rows.find(row => row.window === "exhausted")).toMatchObject({ resetAt: now + 10_000, status: "reset-assumed" });
    const strict = planCapacity(scenario, [], now, { refillAtReset: true, unknownCapacity: true }, true);
    expect(strict.rows.find(row => row.window === "exhausted")).toMatchObject({ status: "exhausted", blocker: true });
    const exhaustedPool = ready.rows.find(row => row.window === "exhausted")!;
    const multiWindow = planCapacity([{ ...scenario[0]!, stageId: "first" }, { ...scenario[0]!, stageId: "second" }], [], now, {
      quotaWindows: [
        { poolId: exhaustedPool.id, startsAt: now + 10_000, endsAt: now + 30_000, allowance: exhaustedPool.knownDemand },
        { poolId: exhaustedPool.id, startsAt: now + 40_000, endsAt: now + 60_000, allowance: exhaustedPool.knownDemand },
      ],
    }, false);
    expect(multiWindow.rows.find(row => row.window === "exhausted")?.allocations).toEqual([
      { stageId: "first", startsAt: now + 10_000, endsAt: now + 30_000, assumed: true },
      { stageId: "second", startsAt: now + 40_000, endsAt: now + 60_000, assumed: true },
    ]);
    const finishedTask = task("Completed mission with rework", "Refactor architecture.", capacityA.harnessId, paths[2]);
    const finished = missionStore.createMission({ title: "Completed capacity fixture", goal: "offline", status: "planned",
      projects: [paths[2]!], clusters: [], plan: { ...plan, projects: [paths[2]!], tasks: [
        { ...items[2]!, taskId: finishedTask, taskTitle: "Completed capacity fixture", qcRequired: true },
      ] }, planDigest: "completed-fixture" });
    missionStore.updateMissionAuthorization(finished.id, { authorizedAt: now - 40_000, authorizedBy: "owner", digest: finished.planDigest });
    const frozen = forecast({ missionId: finished.id, save: true }, now - 39_000).estimates[0]?.estimateId;
    missionStore.createReservation({ taskId: finishedTask, missionId: finished.id, projectPath: paths[2]!, employeeId: "recorded",
      harnessId: capacityA.harnessId, accountId: capacityA.accountId, modelId: model, status: "running" });
    const evidence = { harnessId: capacityA.harnessId, accountId: capacityA.accountId };
    const dev = record(finishedTask, now - 30_000, now - 20_000, evidence);
    const qcId = crypto.randomUUID();
    const review = record(finishedTask, now - 25_000, now - 15_000, { ...evidence, qc: qcId, mode: "ask" });
    db.run(`INSERT INTO task_quality_reviews(id,task_id,project_path,round,status,verdict,reviewer_harness,reviewer_model,
      implementation_run_id,review_run_id,saved_task_json,requested_at,started_at,completed_at)
      VALUES (?,?,?,1,'completed','CHANGES_REQUESTED',?,?,?,?,'{}',?,?,?)`,
      [qcId, finishedTask, paths[2]!, capacityA.harnessId, model, dev, review, now - 25_000, now - 25_000, now - 15_000]);
    record(finishedTask, now - 14_000, now - 10_000, evidence);
    complete(finishedTask, now - 8000);
    missionStore.releaseReservations(finished.id);
    missionStore.updateMissionStatus(finished.id, "completed", "recorded QA completion");
    const actual = taskBreakdown(finishedTask);
    expect(actual?.estimate?.estimateId).toBe(frozen!);
    expect(actual?.actual).toMatchObject({ workerMs: 24_000, activeWallMs: 19_000, reworks: 1 });
    expect(analytics({ missionId: finished.id }, now).usage.realRuns).toBe(3);
    expect(forecast({ missionId: finished.id }, now).estimates).toHaveLength(0);

    const workspace = forecast({ projectPaths: paths }, now);
    expect(workspace.estimates).toHaveLength(10);

    const standby = task("Standalone alternative", prompt, capacityA.harnessId, paths[0]);
    const baseline = forecast({ taskIds: [standby] }, now);
    const choice = baseline.estimates[0]?.developerOptions.find(o => o.accountId === capacityB.accountId && o.modelId === model2)!;
    expect(choice.eligibility).toBe("eligible");
    const alternative = { taskId: standby, optionKey: optionKey(choice) };
    const comparison = forecast({ taskIds: [standby], alternative, assumptions: { startAuthorized: true, unknownCapacity: true, activeReleaseMs: 30_000 } }, now);
    expect(comparison.estimates[0]?.developer?.accountId).toBe(capacityB.accountId);
    expect(tasks.get(standby)?.agent).toBe(capacityA.harnessId);
    const withoutApproval = forecast({ taskIds: [standby], alternative, assumptions: { unknownCapacity: true, activeReleaseMs: 30_000 } }, now);
    expect(withoutApproval.completionWindow).toBeNull();
    expect(withoutApproval.blockers).toContain("start-approval");
    expect(comparison.completionWindow?.expected).toBe(now + comparison.elapsed!.expected);
    expect(baseline.capacity.rows.find(q => q.quotaIds.includes(exhausted.id))?.resetAt).toBe(now + 10_000);
    const request = new Request("http://localhost/api/usage-analytics/fallback-proposal", { method: "POST", body: JSON.stringify(alternative) });
    const response = await usageAnalyticsHttp(request, true);
    expect(response.status, await response.clone().text()).toBe(201);
    const proposed = await response.json();
    expect(proposed.record.plan.forecastChange.original.accountId).toBe(capacityA.accountId);
    expect(() => approveAllocationPlan(proposed.record.id, "incorrect-digest")).toThrow();
    await expect(applyAllocationPlan(proposed.record.id, proposed.planDigest)).rejects.toThrow();
    const approved = approveAllocationPlan(proposed.record.id, proposed.planDigest);
    expect(tasks.get(standby)?.agent).toBe(capacityA.harnessId);
    expect((await applyAllocationPlan(approved.record.id, approved.record.approvedDigest)).record.status).toBe("applied");
    expect(tasks.get(standby)).toMatchObject({ agent: capacityB.harnessId, model: model2, column: "backlog", mode: "auto" });
    expect(runs.countForTask(standby)).toBe(0);

    const policy = createAutonomyPolicy({
      mode: "full-autonomy", scopeKind: "workspace", scopeRef: "workspace", projects: paths,
      specialistRoles: ["developer", "reviewer"], providers: ["codex"], models: [model, model2],
      accounts: [capacityA.accountId, capacityB.accountId], maxConcurrentWorkers: 3, maxLaunches: 12,
      maxDurationMs: 300_000, expiresAt: Date.now() + 300_000,
      permittedActions: ["plan_task", "launch_task", "run_qc", "run_observed_test"], qc: { required: true, requireObservedTest: true },
      completion: { autoComplete: false },
      authorizedTests: [{ projectPath: paths[1], taskId: ids[4], command: "bun test ./check.test.ts", outputPaths: ["src.ts"] }],
    });
    const activation = activateAutonomyPolicy(policy.id);
    const { autonomyPolicyStore } = await import("../autonomy/policy-store.ts");
    autonomyPolicyStore.upsertBinding({ missionId: mission.id, policyId: policy.id, revision: policy.revision,
      activationId: activation.id, digest: policy.digest, mode: "full-autonomy", outcome: "active", summary: null, emergencyTaskIds: [] });
    const { missionResourceOptions, prepareMissionResourceProposal, settleMissionResourceProposal, missionResourceProposals } = await import("../orchestration/mission-replan.ts");
    const { recordMissionWait } = await import("../orchestration/mission-wait.ts");
    const reviewTask = ids[4]!;
    const devTask = ids[3]!;
    const pendingPlan: MissionPlan = structuredClone(plan);
    const reviewPlan = pendingPlan.tasks.find(item => item.taskId === reviewTask)!;
    reviewPlan.qcRequired = true;
    const completedPlan = pendingPlan.tasks.at(-1)!;
    completedPlan.phase = "completed";
    const initialDigest = computeMissionPlanDigest(pendingPlan);
    db.run("UPDATE orchestration_missions SET plan_json=?,plan_digest=?,authorization_json=?,status='paused' WHERE id=?", [
      JSON.stringify(pendingPlan), initialDigest, JSON.stringify({ authorizedAt: now, authorizedBy: "owner", digest: initialDigest }), mission.id,
    ]);
    const initial = forecast({ missionId: mission.id, save: true, assumptions: { activeReleaseMs: 1 } }, now - 10_000);
    const initialEstimate = initial.estimates.find(item => item.taskId === reviewTask)!.estimateId;
    expect(initial.stages.some(stage => stage.taskId === reviewTask && stage.kind === "testing" && stage.resources.includes("local-testing") &&
      stage.resources.every(key => !key.startsWith("account/")))).toBeTrue();
    missionStore.createReservation({ missionId: mission.id, taskId: reviewTask, projectPath: paths[1]!, employeeId: "developer",
      accountId: capacityA.accountId, harnessId: capacityA.harnessId, modelId: model, status: "running" });
    const implementationRun = record(reviewTask, now - 8000, now - 6000, { ...evidence, execution: "synthetic" });
    missionStore.releaseTaskReservation(reviewTask);
    tasks.update(reviewTask, { column: "review", runId: implementationRun });
    tasks.update(devTask, { column: "ready" });
    db.run(`UPDATE orchestration_missions SET plan_json=json_set(plan_json,'$.tasks[4].phase','blocked','$.tasks[4].runId',?,
      '$.tasks[4].phaseReason','Reviewer blocked') WHERE id=?`, [implementationRun, mission.id]);
    recordMissionWait(mission.id, reviewTask, "account-capacity", now - 5000);
    recordMissionWait(mission.id, reviewTask, "owner", now - 3000);
    recordMissionWait(mission.id, reviewTask, null, now - 1000);
    expect(taskActuals(reviewTask, now)?.waiting).toMatchObject({
      measured: { "account-capacity": 2000, owner: 2000 }, measuredMs: 4000,
      runtimeInternalUnknownMs: 2000, unknownMs: 2000, providerReportedMs: null,
    });
    const developer = missionResourceOptions(mission.id, devTask, "developer").find(option => option.modelId === model2)!;
    expect(developer.resource.accountId).toBe(capacityB.accountId);
    const reviewer = missionResourceOptions(mission.id, reviewTask, "reviewer").find(option => option.modelId === model2)!;
    expect(reviewer.resource).toMatchObject({ accountId: capacityB.accountId, mode: "ask" });
    const requestInput = { taskId: reviewTask, role: "reviewer" as const, resource: reviewer.resource, reason: "Use an eligible Reviewer while preserving implementation." };
    expect(() => prepareMissionResourceProposal(mission.id, { ...requestInput, resource: {
      ...reviewer.resource, harnessId: "cursor",
    } })).toThrow(/Router cannot admit/);
    missionStore.createReservation({ missionId: mission.id, taskId: reviewTask, projectPath: paths[1]!, employeeId: "reviewer",
      accountId: reviewer.resource.accountId, harnessId: reviewer.harnessId, modelId: reviewer.modelId, status: "qc_running" });
    expect(() => prepareMissionResourceProposal(mission.id, requestInput)).toThrow(/in flight/);
    missionStore.releaseTaskReservation(reviewTask);
    const rejected = prepareMissionResourceProposal(mission.id, requestInput);
    expect(() => settleMissionResourceProposal(mission.id, rejected.id, "wrong", "approve")).toThrow(/digest/);
    expect(missionStore.getMission(mission.id)?.planDigest).toBe(initialDigest);
    expect(settleMissionResourceProposal(mission.id, rejected.id, rejected.digest, "reject").status).toBe("rejected");
    expect(missionStore.getMission(mission.id)?.revision).toBe(1);

    const { gatherScopedHeadContext, resolveHeadScope } = await import("../head-pm-scope.ts");
    const { readHeadBoardDraft, saveHeadBoardDraft, resolveHeadBoardProposal } = await import("../head-board-proposals.ts");
    const headScope = resolveHeadScope({ kind: "workspace" });
    const projectScope = resolveHeadScope({ kind: "project", path: paths[1]! });
    if (!headScope.ok || !projectScope.ok) throw new Error("Fixture scope failed");
    const markup = `<reply>Prepared</reply><head_board_action>${JSON.stringify({
      kind: "replan_mission", missionId: mission.id, projectPath: paths[1], taskId: reviewTask, role: "reviewer",
      ...reviewer.resource, reason: requestInput.reason,
    })}</head_board_action>`;
    expect(readHeadBoardDraft(markup, gatherScopedHeadContext(projectScope.value), false).ok).toBeFalse();
    const draft = readHeadBoardDraft(markup, gatherScopedHeadContext(headScope.value), false);
    if (!draft.ok || !draft.value) throw new Error(draft.ok ? "Draft missing" : draft.error);
    const messageId = crypto.randomUUID();
    saveHeadBoardDraft(messageId, headScope.value, draft.value);
    const headProposal = missionResourceProposals(mission.id).proposals.find(proposal => proposal.headMessageId === messageId)!;
    expect(headProposal.status).toBe("pending");
    expect(() => settleMissionResourceProposal(mission.id, headProposal.id, headProposal.digest, "approve")).toThrow(/original Owner review/);
    expect((await resolveHeadBoardProposal(messageId, { confirm: true, resourceDigest: "wrong" }, "approve")).ok).toBeFalse();
    expect((await resolveHeadBoardProposal(messageId, { confirm: true, resourceDigest: headProposal.digest }, "approve")).ok).toBeTrue();
    const updated = missionStore.getMission(mission.id)!;
    expect(updated.revision).toBe(2);
    expect(updated.plan.tasks[4]).toMatchObject({ runId: implementationRun, reviewerBinding: reviewer.resource });
    expect(updated.plan.tasks.at(-1)).toMatchObject({ phase: "completed" });
    expect(missionResourceProposals(mission.id).revisions[0]?.planDigest).toBe(initialDigest);
    expect(taskBreakdown(reviewTask)?.estimate?.estimateId).toBe(initialEstimate!);
    expect(taskBreakdown(reviewTask)?.resourceRevisions[0]).toMatchObject({ revision: 2, expectedAfter: expect.any(Number) });
    expect(db.query("SELECT 1 FROM usage_group_forecasts WHERE json_extract(snapshot, '$.missionId') = ? AND json_extract(snapshot, '$.missionRevision') = 2").get(mission.id)).not.toBeNull();
    const revised = forecast({ missionId: mission.id, assumptions: { activeReleaseMs: 1 } }, now);
    expect(revised.estimates.find(item => item.taskId === reviewTask)?.remainingRoles).toEqual(["reviewer"]);
    expect(revised.stages.find(stage => stage.taskId === reviewTask && stage.kind === "reviewer")?.resources).toContain("account/" + capacityB.accountId);
    expect(revised.stages.some(stage => stage.taskId === reviewTask && stage.kind === "developer")).toBeFalse();
    expect(revised.estimates.some(item => item.taskId === completedPlan.taskId)).toBeFalse();
    const { autonomyReviewDecision } = await import("../autonomy/gate.ts");
    expect(autonomyReviewDecision(updated, updated.plan.tasks[4]!).kind).toBe("allow");
    using reopened = new Database(join(dataDir, "agetor.sqlite"), { readonly: true });
    expect(reopened.query("SELECT revision FROM orchestration_missions WHERE id=?").get(mission.id)).toEqual({ revision: 2 });
    expect(autonomyReviewDecision(updated, updated.plan.tasks[4]!)).toMatchObject({ kind: "deny", reason: "This QC launch was already consumed." });
    expect(runs.countForTask(reviewTask)).toBe(1);

    db.run("INSERT INTO clusters(id,name,created_at,updated_at) VALUES ('capacity-cluster','Capacity cluster',?,?)", [now, now]);
    for (const path of paths.slice(0, 2)) db.run(
      "INSERT INTO cluster_project_memberships VALUES (?,'capacity-cluster',?,?)", [path, now, now],
    );
    const revisedDeveloper = prepareMissionResourceProposal(mission.id, {
      taskId: devTask, role: "developer", resource: developer.resource, reason: "Reallocate untouched Developer work",
      limits: { globalMax: 3, perClusterMax: 1 },
    });
    settleMissionResourceProposal(mission.id, revisedDeveloper.id, revisedDeveloper.digest, "approve");
    expect(missionStore.getMission(mission.id)?.plan.tasks[3]?.developerBinding).toMatchObject({ accountId: capacityB.accountId, modelId: model2 });
    expect(runs.countForTask(devTask)).toBe(0);
    expect(estimateVersions(devTask)[0]?.estimate.plannedResource).toMatchObject({ accountId: capacityB.accountId, modelId: model2 });
    const withClusterLimit = forecast({ missionId: mission.id, assumptions: { activeReleaseMs: 1 } }, now);
    expect(withClusterLimit.stages.find(stage => stage.taskId === devTask && stage.kind === "developer")?.resources)
      .toContain("cluster/capacity-cluster");
    expect(withClusterLimit.stages.find(stage => stage.kind === "preparation")?.durationKnown).toBe(false);

    const { recordPreparation, preparationActual } = await import("../orchestration/mission-preparation.ts");
    const { missionResourceBlock } = await import("../orchestration/mission-resource.ts");
    recordPreparation({ missionId: mission.id, taskId: devTask, revision: missionStore.getMission(mission.id)!.revision, role: "developer", status: "started", at: now - 4000 });
    recordMissionWait(mission.id, devTask, "account-capacity", now - 3500);
    recordMissionWait(mission.id, devTask, null, now - 2500);
    recordPreparation({ missionId: mission.id, taskId: devTask, revision: missionStore.getMission(mission.id)!.revision, role: "developer", status: "completed", at: now - 2000 });
    expect(preparationActual(devTask, now)).toMatchObject({ status: "completed", durationMs: 2000, samples: 1 });
    expect(taskBreakdown(devTask)?.preparation.durationMs).toBe(2000);
    const prepared = forecast({ missionId: mission.id, assumptions: { activeReleaseMs: 1 } }, now);
    expect(prepared.stages.find(stage => stage.taskId === devTask && stage.kind === "preparation")).toMatchObject({ durationKnown: true, duration: { expected: 2000 } });
    expect(prepared.worker.expected).toBe(withClusterLimit.worker.expected);

    for (const id of [ids[0]!, ids[1]!]) tasks.update(id, { column: "ready" });
    const replacement = missionResourceOptions(mission.id, ids[0]!, "developer").find(option => option.accountId === capacityB.accountId && option.modelId === model2)!;
    expect(() => prepareMissionResourceProposal(mission.id, {
      reason: "Reject conflicting stages together",
      changes: [
        { taskId: ids[0]!, role: "developer", resource: replacement.resource },
        { taskId: ids[0]!, role: "developer", resource: replacement.resource },
      ],
    })).toThrow(/same task stage/);
    missionStore.createReservation({ missionId: mission.id, taskId: ids[0]!, projectPath: paths[0]!, employeeId: "developer",
      accountId: capacityA.accountId, harnessId: capacityA.harnessId, modelId: model, status: "running" });
    const beforeConflict = missionStore.getMission(mission.id)!.revision;
    expect(() => prepareMissionResourceProposal(mission.id, {
      reason: "Do not apply a partial amendment",
      changes: [
        { taskId: ids[0]!, role: "developer", resource: replacement.resource },
        { taskId: ids[1]!, role: "developer", resource: replacement.resource },
      ],
    })).toThrow(/in flight/);
    expect(missionStore.getMission(mission.id)!.revision).toBe(beforeConflict);
    missionStore.releaseTaskReservation(ids[0]!);
    const rejectedAtomic = prepareMissionResourceProposal(mission.id, {
      reason: "Keep the original plan",
      changes: [
        { taskId: ids[0]!, role: "developer", resource: replacement.resource },
        { taskId: ids[1]!, role: "developer", resource: replacement.resource },
      ],
    });
    expect(rejectedAtomic.amendments).toHaveLength(2);
    expect(new Set(rejectedAtomic.amendments.map(item => item.taskId))).toEqual(new Set([ids[0]!, ids[1]!]));
    expect(rejectedAtomic.seal).toHaveLength(2);
    settleMissionResourceProposal(mission.id, rejectedAtomic.id, rejectedAtomic.digest, "reject");
    expect(missionStore.getMission(mission.id)!.plan.tasks[0]?.accountId).toBe(capacityA.accountId);
    const stale = prepareMissionResourceProposal(mission.id, {
      reason: "This digest must not apply after another revision",
      changes: [
        { taskId: ids[0]!, role: "developer", resource: replacement.resource },
        { taskId: ids[1]!, role: "developer", resource: replacement.resource },
      ],
    });
    tasks.update(ids[6]!, { column: "ready" });
    const otherDeveloper = missionResourceOptions(mission.id, ids[6]!, "developer").find(option => option.modelId === model2)!;
    const intervening = prepareMissionResourceProposal(mission.id, {
      taskId: ids[6]!, role: "developer", resource: otherDeveloper.resource, reason: "Move one other stage first",
    });
    settleMissionResourceProposal(mission.id, intervening.id, intervening.digest, "approve");
    expect(() => settleMissionResourceProposal(mission.id, stale.id, stale.digest, "approve")).toThrow(/changed/);
    expect(missionStore.getMission(mission.id)!.plan.tasks[0]?.accountId).toBe(capacityA.accountId);
    const approvedAtomic = prepareMissionResourceProposal(mission.id, {
      reason: "Reallocate the remaining Developer stages together",
      changes: [
        { taskId: ids[0]!, role: "developer", resource: replacement.resource },
        { taskId: ids[1]!, role: "developer", resource: replacement.resource },
      ],
    });
    const approvedRevision = missionStore.getMission(mission.id)!.revision;
    settleMissionResourceProposal(mission.id, approvedAtomic.id, approvedAtomic.digest, "approve");
    expect(settleMissionResourceProposal(mission.id, approvedAtomic.id, approvedAtomic.digest, "approve").status).toBe("approved");
    const atomicMission = missionStore.getMission(mission.id)!;
    expect(atomicMission.revision).toBe(approvedRevision + 1);
    expect(atomicMission.plan.tasks[0]?.developerBinding).toMatchObject({ accountId: capacityB.accountId, modelId: model2, mode: "auto" });
    expect(atomicMission.plan.tasks[1]?.developerBinding).toMatchObject({ accountId: capacityB.accountId, modelId: model2 });
    expect(atomicMission.plan.tasks[4]?.runId).toBe(implementationRun);
    expect(runs.listForTask(reviewTask).map(run => run.id)).toEqual([implementationRun]);
    expect(taskBreakdown(reviewTask)?.resourceRevisions[0]?.resource.accountId).toBe(capacityB.accountId);
    expect(taskBreakdown(ids[0]!)?.resourceRevisions.at(-1)?.previous?.accountId).toBe(capacityA.accountId);
    expect(missionResourceBlock(atomicMission, atomicMission.plan.tasks[0]!, "developer", {
      ...replacement.resource, harnessId: "cursor", fingerprint: "blocked", revision: atomicMission.revision,
    })).toBeTruthy();
    const compared = forecast({ missionId: mission.id, compareAllocations: true, assumptions: { activeReleaseMs: 1, unknownCapacity: true } }, now);
    const allocationRows = compared.allocationComparison ?? [];
    expect(allocationRows.map(row => row.objective)).toEqual(["fastest", "lowest-charge", "balanced", "quota-preserving", "minimum-wait"]);
    expect(allocationRows.every(row => row.feasible || !!row.reason)).toBe(true);
    expect(allocationRows.some(row => row.feasible)).toBe(true);
    expect(allocationRows.filter(row => row.feasible && !row.optimal).every(row => row.reason?.includes("not proven optimal"))).toBe(true);
    const objectiveMarkup = `<reply>Prepared</reply><head_board_action>${JSON.stringify({
      kind: "replan_mission", missionId: mission.id, objective: "minimum-wait", reason: "Replan around the recorded account wait",
    })}</head_board_action>`;
    const objectiveDraft = readHeadBoardDraft(objectiveMarkup, gatherScopedHeadContext(headScope.value), false);
    expect(objectiveDraft.ok, objectiveDraft.ok ? "" : objectiveDraft.error).toBe(true);
    if (objectiveDraft.ok && objectiveDraft.value?.kind === "replan_mission") {
      expect(objectiveDraft.value.changes?.length).toBeGreaterThan(0);
      expect(objectiveDraft.value.allocation?.feasible).toBe(true);
    }
    db.run(`INSERT INTO autonomy_action_reservations(
      id, activation_id, policy_id, revision, action, target_key, mission_id, task_id, project_path, status, created_at, updated_at
    ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`, [
      crypto.randomUUID(), activation.id, policy.id, policy.revision, "launch_task", `launch_task:${ids[6]}:0`,
      mission.id, ids[6]!, paths[0]!, "consumed", now, now,
    ]);
    expect(() => prepareMissionResourceProposal(mission.id, {
      taskId: ids[6]!, role: "developer", resource: otherDeveloper.resource, reason: "A consumed Developer grant cannot be reused",
    })).toThrow(/already launched/);
    db.run("UPDATE autonomy_activations SET expires_at = ? WHERE id = ?", [now - 1, activation.id]);
    expect(() => prepareMissionResourceProposal(mission.id, {
      taskId: ids[0]!, role: "developer", resource: replacement.resource, reason: "An expired policy cannot be extended",
    })).toThrow(/active mission policy/);

  } finally {
    routing.mockRestore();
  }
});

test("company analytics keeps lifecycle, money, quota and rankings distinct", () => {
  const base = Date.now() - 120_000;
  const paths = [0, 1, 2, 3, 4].map(index => {
    const dir = join(root, `company-${index}`);
    mkdirSync(dir);
    writeFileSync(join(dir, "package.json"), "{}");
    projects.upsert(dir, `Company ${index}`);
    return dir;
  });
  const clusters = ["cluster-a", "cluster-b", "cluster-c"].map((id, index) => {
    db.run("INSERT INTO clusters(id,name,description,created_at,updated_at) VALUES (?,?,?,?,?)", [id, `Cluster ${index}`, "", base, base]);
    return id;
  });
  paths.forEach((dir, index) => db.run(
    "INSERT INTO cluster_project_memberships(project_path,cluster_id,assigned_at,updated_at) VALUES (?,?,?,?)",
    [dir, clusters[index % 3]!, base, base],
  ));
  const employee = crypto.randomUUID();
  db.run(`INSERT INTO ai_employees(id,kind,name,name_source,job_title,role_category,specializations,description,status,created_at,updated_at)
    VALUES (?,'worker','Ada Fixture','owner','Developer','developer','[]','', 'active',?,?)`, [employee, base, base]);
  const ids = Array.from({ length: 20 }, (_, index) => task(`Company task ${index}`, "Add an example. Acceptance: add tests.", a.harnessId, paths[index % 5]!));
  const parallel = ids[0]!;
  const dev = record(parallel, base, base + 10_000, { accountId: a.accountId });
  const overlap = record(parallel, base + 4_000, base + 12_000, { accountId: a.accountId });
  expect(unionMs([{ start: base, end: base + 10_000 }, { start: base + 4_000, end: base + 12_000 }])).toBe(12_000);
  db.run(`INSERT INTO employee_executions(id,task_id,task_title,project_path,employee_id,employee_name,assignment_id,assignment_revision,status,revision,
    requested_harness_id,requested_policy,requested_mode,inputs_key,task_fingerprint,config_json,review_json,actual_provenance,run_id,actual_harness_id,actual_model,actual_account_id,
    created_at,updated_at,expires_at,approved_at,started_at)
    VALUES (?,?,?,?,?,'Ada Fixture','assign',1,'started',1,?, 'balanced','auto','k','f','{}','{}','runtime',?,?,?,?,?,?,?,?,?)`,
    [crypto.randomUUID(), parallel, "Company task 0", paths[0]!, employee, a.harnessId, dev, a.harnessId, model, a.accountId, base, base, base + 10_000, base, base]);
  record(parallel, base + 13_000, base + 14_000, { status: "orphaned", withTokens: false });
  const qid = crypto.randomUUID();
  const reviewer = record(parallel, base + 15_000, base + 18_000, { qc: qid, billed: { amount: 1.5, currency: "EUR" } });
  db.run(`INSERT INTO task_quality_reviews(id,task_id,project_path,round,status,verdict,reviewer_harness,reviewer_model,implementation_run_id,review_run_id,saved_task_json,requested_at,started_at,completed_at)
    VALUES (?,?,?,1,'completed','CHANGES_REQUESTED',?,?,?,?,'{}',?,?,?)`,
    [qid, parallel, paths[0]!, a.harnessId, model, dev, reviewer, base + 15_000, base + 15_000, base + 18_000]);
  record(parallel, base + 19_000, base + 21_000);
  db.run("INSERT INTO usage_task_transitions(task_id,destination,at) VALUES (?,'inbox',?),(?,'ready',?)", [parallel, base - 8_000, parallel, base - 3_000]);
  complete(parallel, base + 25_000);
  const actual = taskActuals(parallel)!;
  expect(actual.lifecycle).toMatchObject({
    complete: true, createdToDoneMs: actual.totalElapsedMs, firstExecutionToDoneMs: actual.executionElapsedMs,
    workerMs: 10_000 + 8_000 + 1_000 + 3_000 + 2_000, activeWallMs: 12_000 + 1_000 + 3_000 + 2_000,
    developerMs: 10_000 + 8_000 + 1_000 + 2_000, reviewerMs: 3_000, attempts: 5, completedRuns: 4, interruptions: 1, qcRounds: 1,
  });
  expect(actual.lifecycle.inboxAt).toBe(base - 8_000);
  expect(actual.lifecycle.readyAt).toBe(base - 3_000);
  expect(actual.runs[1]?.id).toBe(overlap);
  expect(actual.subscriptionQuota.statement).toBe("Per-task subscription quota consumption: Unknown");
  expect(actual.runs.find(run => run.id === reviewer)?.cost).toMatchObject({ kind: "reported-api", money: { amount: 1.5, currency: "EUR" } });
  const running = ids[1]!;
  const live = record(running, base + 1_000, base + 2_000, { withTokens: false });
  db.run("UPDATE runs SET ended_at = NULL, status = 'running' WHERE id = ?", [live]);
  db.run(`UPDATE tasks SET "column" = 'running' WHERE id = ?`, [running]);
  const open = taskActuals(running)!;
  expect(open.lifecycle.complete).toBe(false);
  expect(open.lifecycle.createdToDoneMs).toBeNull();
  expect(open.lifecycle.partialCreatedMs).toBeGreaterThan(0);
  db.run(`UPDATE tasks SET "column" = 'blocked' WHERE id = ?`, [ids[2]!]);
  const quotaAccount = account("Company quota");
  const pool = core.createDefinition({ accountId: quotaAccount.accountId, scope: "group:shared-company", unit: { kind: "requests" }, window: "weekly" });
  const reset = base + 86_400_000;
  const evidence = { provider: "openai", accountId: quotaAccount.accountId, subject: "synthetic-company-subject", method: "provider-account" as const,
    sourceId: "synthetic-company-fixture", officialUrl: "https://example.invalid", checkedAt: "2026-11-11", receivedAt: base, limitations: "Synthetic fixture",
    sharedPool: { id: "shared-company", scope: "account", window: "weekly", verified: true as const } };
  core.recordTrustedObservations("synthetic-company-fixture", [{ quotaId: pool.id, values: { observedAt: base, used: 10, remaining: 90, limit: 100, resetAt: reset, expiresAt: reset }, evidence }]);
  core.recordTrustedObservations("synthetic-company-fixture", [{ quotaId: pool.id, values: { observedAt: base + 30_000, used: 40, remaining: 60, limit: 100, resetAt: reset, expiresAt: reset }, evidence: { ...evidence, receivedAt: base + 30_000 } }]);
  core.recordTrustedObservations("synthetic-company-fixture", [{ quotaId: pool.id, values: { observedAt: base + 40_000, used: 5, remaining: 95, limit: 100, resetAt: reset + 86_400_000, expiresAt: reset + 86_400_000 }, evidence: { ...evidence, receivedAt: base + 40_000 } }]);
  db.run("INSERT INTO run_events(run_id,stream,data,ts) VALUES (?,'status',?,?)", [dev, RUN_USAGE_STATUS_PREFIX + JSON.stringify({ quota: { quotaId: "other-pool", amount: 3, unit: "requests" } }), base + 10_000]);
  const consumption = quotaConsumption({ accountId: quotaAccount.accountId, from: base - 1, until: base + 50_000 });
  const row = consumption.pools.find(item => item.quotaId === pool.id)!;
  expect(row.poolDelta).toBe(30);
  expect(row.attributed).toBeNull();
  expect(row.unattributed).toBe(30);
  expect(row.resets).toBe(1);
  expect(row.synthetic).toBe(true);
  expect(row.statement).toContain("Unknown");
  expect(JSON.stringify(consumption)).not.toContain("synthetic-company-subject");
  db.run("UPDATE runs SET usage_scope = ? WHERE task_id = ?", [JSON.stringify({
    projectPath: paths[0], clusterId: clusters[0], missionId: null, category: "task", technology: "PHP", complexity: null,
  }), parallel]);
  const report = analytics({ clusterId: clusters[0], from: base - 1, until: base + 80_000 }, Date.now(), undefined, { timeZone: "UTC", grain: "day" });
  const projectReport = analytics({ projectPath: paths[0], from: base - 1, until: base + 80_000 });
  const selected = analytics({ taskIds: [parallel, running] });
  expect(report.company.counts.running).toBeGreaterThanOrEqual(0);
  expect(projectReport.tasks.some(item => item.id === parallel)).toBe(true);
  expect(selected.tasks.map(item => item.id).sort()).toEqual([parallel, running].sort());
  expect(report.company.aggregation).toContain("counted once");
  const person = report.company.employees.find(item => item.id === employee) ?? projectReport.company.employees.find(item => item.id === employee);
  expect(person?.developerCompletedTasks).toBe(1);
  expect(person?.reviewerParticipations).toBe(0);
  expect(person?.comparison).toBe("insufficient");
  record(ids[3]!, base + 2_000, base + 3_000, { execution: "synthetic" });
  complete(ids[3]!, base + 4_000);
  const syntheticReport = analytics({ taskId: ids[3] });
  expect(syntheticReport.usage.syntheticRuns).toBe(1);
  expect(syntheticReport.usage.realRuns).toBe(0);
  expect(syntheticReport.company.models).toEqual([]);
  const head = headUsageEvidence("How much did the company spend this month, and how much subscription quota did this task consume?", {
    scope: { kind: "project", path: paths[0]! }, label: "Company 0", projectPath: paths[0]!, projectAddedAt: null, clusterId: null,
  }, path => path === paths[0]).join("\n");
  expect(head).toContain('"perTaskSubscriptionQuota":"Unknown"');
  expect(head).toContain("unattributed");
  const exported = renderAnalyticsExport(projectReport, "tasks", "csv", { timeZone: "UTC", grain: "day" });
  expect(exported.body).toContain("createdToDoneMs");
  expect(exported.body).toContain("Unknown");
  expect(exported.body).not.toContain("Add an example");
  const json = renderAnalyticsExport(projectReport, "tasks", "json", { timeZone: "UTC", grain: "day" });
  expect(json.body).toContain("forgeorbit-analytics");
  expect(JSON.parse(json.body).coverage.timezone).toBe("UTC");
});
