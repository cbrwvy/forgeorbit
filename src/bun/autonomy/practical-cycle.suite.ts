import { afterAll, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { FAKE_PRACTICAL_IMPL_MARKER } from "../../shared/practical-cycle.ts";
import { canonicalPolicyBody, policyDigest } from "../../shared/autonomy-policy.ts";

const isolated = realpathSync(mkdtempSync(path.join(tmpdir(), "fo-auto-practical01-")));
process.env.AGETOR_DATA_DIR = isolated;
process.env.HOME = isolated;
process.env.AGETOR_API_PORT = "4593";
process.env.AGETOR_USAGE_OFFLINE = "1";
process.env.AGETOR_CLAUDE_DRIVER = "fake";
process.env.AGETOR_CLAUDE_BIN = "/bin/echo";
process.env.AGETOR_CODEX_DRIVER = "fake";
process.env.AGETOR_CODEX_BIN = "/bin/echo";
process.env.AGETOR_TMUX_BIN = "/bin/echo";
process.env.AGETOR_FAKE_QC_VERDICT = "PASS";
process.env.AGETOR_FAKE_CLAUDE_RESOLVE_DELAY_MS = "20";
delete process.env.AGETOR_ALLOW_REAL_IMPROVEMENT_INFERENCE;
for (const kind of ["CURSOR", "GEMINI", "FX", "ANTIGRAVITY"]) process.env["AGETOR_" + kind + "_BIN"] = "/nonexistent/fo-auto-practical01";

const TEST_SOURCE = `import { expect, test } from "bun:test";
import { add } from "./add.ts";
test("add", () => { expect(add(1, 2)).toBe(3); });
`;

const ACTIONS = [
  "create_task", "assign_specialist", "plan_task", "launch_task", "run_qc",
  "request_rework", "select_model", "retrieve_brain", "save_observation",
  "complete_task", "update_mission_status", "coordinate_projects", "run_observed_test",
];

let engine: typeof import("./policy-engine.ts");
let store: typeof import("../db.ts");
let coordinator: typeof import("./coordinator.ts");
let scheduler: typeof import("../orchestration/mission-scheduler.ts");

function git(dir: string, args: string[]) {
  const result = Bun.spawnSync(["git", ...args], { cwd: dir, stdout: "pipe", stderr: "pipe" });
  if (result.exitCode !== 0) throw new Error(new TextDecoder().decode(result.stderr));
}

function fixtureRepo(dir: string) {
  mkdirSync(path.join(dir, "src"), { recursive: true });
  writeFileSync(path.join(dir, "src", "add.test.ts"), TEST_SOURCE);
  writeFileSync(path.join(dir, "README.md"), "fixture\n");
  git(dir, ["init", "-q"]);
  git(dir, ["add", "."]);
  git(dir, ["-c", "user.email=fixture@example.com", "-c", "user.name=Fixture", "commit", "-q", "-m", "fixture"]);
}

async function load() {
  store = await import("../db.ts");
  engine = await import("./policy-engine.ts");
  coordinator = await import("./coordinator.ts");
  scheduler = await import("../orchestration/mission-scheduler.ts");
  (await import("../employee-run.ts")).initEmployeeExecutionTracking();
  store.harnesses.setEnabled("claude-code", true);
  store.harnesses.setEnabled("cursor", false);
  coordinator.resetAutonomyLoopForTest();
  engine.setAutonomyClock(() => Date.now());
  (await import("../self-improve/engine.ts")).setImprovementControl({ enabled: true, paused: false, stopped: false });
}

test("empty test grants keep the previous policy digest, and an agent cannot invent a command", async () => {
  await load();
  const bare = engine.createAutonomyPolicy({
    mode: "full-autonomy",
    scopeKind: "workspace",
    scopeRef: "workspace",
    projects: ["/synthetic/digest"],
    clusters: [],
    specialistRoles: ["developer"],
    providers: ["claude-code"],
    models: ["haiku-4.5"],
    allowUnscopedAccount: true,
    maxConcurrentWorkers: 1,
    maxLaunches: 4,
    maxDurationMs: 60_000,
    maxReworkAttempts: 1,
    permittedActions: ["launch_task"],
    qc: { required: true, requireIndependentReviewer: true, requireObservedTest: false },
    completion: { autoComplete: false, conditions: ["qc_pass"] },
    memory: { approval: "propose" },
    routerPreset: "balanced",
    spending: { limitUsd: 1, requireEnforceableCap: false },
    expiresAt: Date.now() + 60_000,
    selfImprovement: { enabled: true, lowRiskActivation: false },
  });
  const listed = engine.createAutonomyPolicy({
    mode: "full-autonomy",
    scopeKind: "workspace",
    scopeRef: "workspace",
    projects: ["/synthetic/digest"],
    clusters: [],
    specialistRoles: ["developer"],
    providers: ["claude-code"],
    models: ["haiku-4.5"],
    allowUnscopedAccount: true,
    maxConcurrentWorkers: 1,
    maxLaunches: 4,
    maxDurationMs: 60_000,
    maxReworkAttempts: 1,
    permittedActions: ["launch_task"],
    qc: { required: true, requireIndependentReviewer: true, requireObservedTest: false },
    completion: { autoComplete: false, conditions: ["qc_pass"] },
    memory: { approval: "propose" },
    routerPreset: "balanced",
    spending: { limitUsd: 1, requireEnforceableCap: false },
    expiresAt: bare.body.expiresAt,
    authorizedTests: [],
    selfImprovement: { enabled: true, lowRiskActivation: false },
  });
  expect(policyDigest(canonicalPolicyBody(bare.body))).toBe(policyDigest(canonicalPolicyBody(listed.body)));
  expect(bare.body.authorizedTests).toEqual([]);
  expect(bare.body.selfImprovement?.enabled).toBe(true);
  expect(() => engine.createAutonomyPolicy({
    ...{
      mode: "full-autonomy",
      scopeKind: "workspace",
      scopeRef: "workspace",
      projects: ["/synthetic/digest"],
      clusters: [],
      specialistRoles: ["developer"],
      providers: ["claude-code"],
      models: ["haiku-4.5"],
      allowUnscopedAccount: true,
      maxConcurrentWorkers: 1,
      maxLaunches: 4,
      maxDurationMs: 60_000,
      maxReworkAttempts: 1,
      permittedActions: ["launch_task"],
      qc: { required: true, requireIndependentReviewer: true, requireObservedTest: false },
      completion: { autoComplete: false, conditions: ["qc_pass"] },
      memory: { approval: "propose" },
      routerPreset: "balanced",
      spending: { limitUsd: 1, requireEnforceableCap: false },
      expiresAt: Date.now() + 60_000,
    },
    authorizedTests: [{ projectPath: "/synthetic/digest", command: "bun test ./src/add.ts", outputPaths: ["src/other.ts"] }],
  })).toThrow(/fixed command/);
});

test("a full autonomy mission runs an observed test, one rework, QC, and a dependent task", async () => {
  if (!store) await load();
  const root = path.join(isolated, "workspace");
  mkdirSync(root, { recursive: true });
  const names = ["alpha", "beta", "excluded"] as const;
  const dirs = {} as Record<(typeof names)[number], string>;
  for (const name of names) {
    const dir = path.join(root, name);
    fixtureRepo(dir);
    dirs[name] = realpathSync(dir);
    store.projects.upsert(dirs[name], name);
  }
  for (const id of ["cluster-alpha", "cluster-beta"]) {
    store.db.run(
      `INSERT INTO clusters (id, name, slug, description, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)`,
      [id, id, id, id, Date.now(), Date.now()],
    );
  }
  store.db.run(
    `INSERT INTO cluster_project_memberships (project_path, cluster_id, assigned_at, updated_at) VALUES (?, ?, ?, ?)`,
    [dirs.alpha, "cluster-alpha", Date.now(), Date.now()],
  );
  store.db.run(
    `INSERT INTO cluster_project_memberships (project_path, cluster_id, assigned_at, updated_at) VALUES (?, ?, ?, ?)`,
    [dirs.beta, "cluster-beta", Date.now(), Date.now()],
  );
  const tiersBefore = store.db.query<{ n: number }, []>("SELECT COUNT(*) AS n FROM router_v2_quality_tiers").get()!.n;
  const excluded = await (await import("../orchestrator.ts")).createTask({
    title: "Excluded",
    prompt: "Do not touch this project.",
    workdir: dirs.excluded,
    isolation: "none",
    column: "ready",
    agent: "claude-code",
    model: "haiku-4.5",
    mode: "auto",
  });
  if ("error" in excluded) throw new Error(excluded.error);

  for (const row of engine.autonomyStatus().activations) {
    if (row.status === "active" || row.status === "paused") engine.revokeAutonomyPolicy(row.policyId);
  }
  const grant = (projectPath: string) => ({
    projectPath,
    command: "bun test ./src/add.test.ts",
    outputPaths: ["src/add.ts"],
  });
  const policy = engine.createAutonomyPolicy({
    mode: "full-autonomy",
    scopeKind: "workspace",
    scopeRef: "workspace",
    projects: [dirs.alpha, dirs.beta],
    clusters: ["cluster-alpha", "cluster-beta"],
    specialistRoles: ["developer", "reviewer", "head"],
    providers: ["claude-code"],
    models: ["haiku-4.5"],
    allowUnscopedAccount: true,
    maxConcurrentWorkers: 2,
    maxLaunches: 40,
    maxDurationMs: 60 * 60 * 1000,
    maxReworkAttempts: 1,
    permittedActions: ACTIONS,
    qc: { required: true, requireIndependentReviewer: true, requireObservedTest: true },
    completion: { autoComplete: true, conditions: ["qc_pass", "observed_test"] },
    memory: { approval: "propose" },
    routerPreset: "balanced",
    spending: { limitUsd: 25, requireEnforceableCap: false },
    expiresAt: Date.now() + 60 * 60 * 1000,
    selfImprovement: { enabled: true, lowRiskActivation: true },
    authorizedTests: [grant(dirs.alpha), grant(dirs.beta)],
  });
  engine.activateAutonomyPolicy(policy.id);
  const cursor = engine.authorizeAutonomyAction({
    targetKey: "launch_task:cursor:0",
    target: { action: "launch_task", projectPath: dirs.alpha, role: "developer", provider: "cursor", model: "composer" },
  });
  expect(cursor.decision.allow).toBe(false);

  const impl = `${FAKE_PRACTICAL_IMPL_MARKER}\nFO_PRACTICAL_OUTPUT src/add.ts\nImplement add so the authorized test passes.`;
  const prepared = await coordinator.prepareAutonomousMission({
    policyId: policy.id,
    title: "Practical development",
    goal: "Implement add, observe the test, and finish only after QC.",
    proposals: [
      { title: "Alpha backend", projectPath: dirs.alpha, clusterId: "cluster-alpha", specialistRole: "developer", prompt: impl },
      { title: "Alpha repeat", projectPath: dirs.alpha, clusterId: "cluster-alpha", specialistRole: "developer", prompt: impl },
      { title: "Beta follow-up", projectPath: dirs.beta, clusterId: "cluster-beta", specialistRole: "developer", prompt: `${impl}\nFO_PRACTICAL_CORRECT`, dependsOnTitles: [{ title: "Alpha backend" }] },
    ],
  });
  const mission = prepared.mission;
  const byTitle = new Map(mission.plan.tasks.map((task) => [task.taskTitle, task]));
  let betaStartedEarly = false;
  const started = Date.now();
  while (Date.now() - started < 120_000) {
    const alpha = store.tasks.get(byTitle.get("Alpha backend")!.taskId);
    const beta = store.tasks.get(byTitle.get("Beta follow-up")!.taskId);
    if ((beta?.runId || store.runs.listForTask(beta!.id).length > 0) && alpha?.column !== "done") betaStartedEarly = true;
    await scheduler.missionScheduler.tickAllRunningMissions();
    await coordinator.finalizeAutonomyTick();
    const current = (await import("../orchestration/mission-store.ts")).missionStore.getMission(mission.id);
    if (current?.status === "completed" || current?.status === "failed") break;
    await Bun.sleep(30);
  }
  const finished = (await import("../orchestration/mission-store.ts")).missionStore.getMission(mission.id)!;
  const columns = finished.plan.tasks.map((task) => ({
    title: task.taskTitle,
    phase: task.phase,
    reason: task.phaseReason,
    column: store.tasks.get(task.taskId)?.column,
    verdict: store.tasks.get(task.taskId)?.qcState?.latestVerdict,
  }));
  const debug = {
    columns,
    attempts: store.db.query<Record<string, unknown>, []>("SELECT task_id, status, exit_code, failure_kind, isolation, substr(isolation_reason, 1, 180) AS reason, substr(summary, 1, 180) AS summary FROM practical_test_attempts").all(),
    decisions: store.db.query<Record<string, unknown>, []>("SELECT action, verdict, substr(reason, 1, 180) AS reason FROM autonomy_decisions ORDER BY rowid DESC LIMIT 12").all(),
  };
  expect(finished.status, JSON.stringify(debug, null, 2)).toBe("completed");
  expect(betaStartedEarly).toBe(false);
  for (const task of columns) {
    expect(task.column).toBe("done");
    expect(task.verdict).toBe("PASS");
  }
  expect(store.tasks.get(excluded.task.id)!.column).toBe("ready");
  expect(store.runs.listForTask(excluded.task.id)).toHaveLength(0);

  const alphaId = byTitle.get("Alpha backend")!.taskId;
  const attempts = store.db.query<{ status: string; exit_code: number | null; evidence_digest: string | null; isolation: string; implementation_execution: string; failure_kind: string | null }, [string]>(
    `SELECT status, exit_code, evidence_digest, isolation, implementation_execution, failure_kind
     FROM practical_test_attempts WHERE task_id = ? ORDER BY rework_epoch ASC, started_at ASC`,
  ).all(alphaId);
  expect(attempts.map((row) => row.status)).toEqual(["failed", "passed"]);
  expect(attempts[0]!.exit_code).not.toBe(0);
  expect(attempts[1]!.exit_code).toBe(0);
  expect(attempts[1]!.evidence_digest).toBeTruthy();
  expect(attempts[1]!.isolation).toBe("macos-offline-seatbelt");
  expect(attempts[1]!.implementation_execution).toBe("synthetic-driver");
  expect(attempts[0]!.failure_kind).toBe("test_failed");

  const before = finished.plan.tasks.map((task) => store.runs.listForTask(task.taskId).map((run) => run.id).join(","));
  const passesBefore = store.db.query<{ n: number }, []>(
    "SELECT COUNT(*) AS n FROM practical_test_attempts WHERE status = 'passed'",
  ).get()!.n;
  await coordinator.recoverAutonomy();
  await scheduler.missionScheduler.recoverOrchestrationMissions();
  await scheduler.missionScheduler.tickAllRunningMissions();
  const after = finished.plan.tasks.map((task) => store.runs.listForTask(task.taskId).map((run) => run.id).join(","));
  expect(after).toEqual(before);
  expect(store.db.query<{ n: number }, []>("SELECT COUNT(*) AS n FROM practical_test_attempts WHERE status = 'passed'").get()!.n).toBe(passesBefore);

  const brain = store.db.query<{ n: number }, []>(
    "SELECT COUNT(*) AS n FROM brain_extraction_candidates WHERE source_event_kind = 'practical-test'",
  ).get()!.n;
  expect(brain).toBeGreaterThan(0);
  expect(store.db.query<{ n: number }, []>("SELECT COUNT(*) AS n FROM router_v2_quality_tiers").get()!.n).toBe(tiersBefore);

  const observations = store.db.query<{ n: number }, []>(
    "SELECT COUNT(*) AS n FROM improvement_observations WHERE fingerprint = 'validation-step-missing' AND origin = 'production'",
  ).get()!.n;
  expect(observations).toBeGreaterThanOrEqual(2);
  const improve = await import("../self-improve/engine.ts");
  const discovered = improve.discoverImprovementCandidates();
  expect(discovered).toHaveLength(1);
  const drafted = await improve.prepareImprovementFromHarness(discovered[0]!.id, { provider: "claude-code", model: "haiku-4.5" });
  expect(drafted.status).toBe("proposed");
  expect((drafted.metrics as { generation?: string; inferenceCompleted?: boolean }).generation).toBe("synthetic-driver");
  expect((drafted.metrics as { inferenceCompleted?: boolean }).inferenceCompleted).toBe(false);
  const evaluated = await improve.evaluateImprovementWithHarness(drafted.id, {
    provider: "claude-code",
    model: "haiku-4.5",
    tasks: [
      { name: "train", requirements: "Implement add.", files: { "src/add.test.ts": TEST_SOURCE }, outputPath: "src/add.ts", testPath: "src/add.test.ts", heldOut: false },
      { name: "held", requirements: "Implement add.", files: { "src/add.test.ts": TEST_SOURCE }, outputPath: "src/add.ts", testPath: "src/add.test.ts", heldOut: true },
    ],
  });
  expect(evaluated.decision, evaluated.decisionReason ?? "").toBe("pass");
  const metrics = evaluated.metrics as { execution?: string; inferenceCompleted?: boolean };
  expect(metrics.execution).toBe("synthetic-driver");
  expect(metrics.inferenceCompleted).toBe(false);
  const active = improve.activateImprovementCandidate(evaluated.id, { actor: "head" });
  expect(active.status).toBe("monitoring");
  const follow = await (await import("../orchestrator.ts")).createTask({
    title: "Use the activated skill",
    prompt: impl,
    workdir: dirs.alpha,
    isolation: "none",
    column: "ready",
    agent: "claude-code",
    model: "haiku-4.5",
    mode: "auto",
  });
  if ("error" in follow) throw new Error(follow.error);
  const startedFollow = await (await import("../orchestrator.ts")).startTask(follow.task.id);
  if ("error" in startedFollow) throw new Error(startedFollow.error);
  const followFile = path.join(dirs.alpha, "src", "add.ts");
  let followBody = "";
  for (let i = 0; i < 100 && !followBody.includes("return a + b"); i++) {
    await Bun.sleep(30);
    try { followBody = readFileSync(followFile, "utf8"); } catch { /* the fake driver writes on its timer */ }
  }
  expect(followBody).toContain("return a + b");
  const published = readFileSync(followFile, "utf8");
  expect(published).toContain("return a + b");
  const rolled = improve.rollbackImprovementCandidate(active.id, "Acceptance rollback of the activated skill.", "owner");
  expect(rolled.status).toBe("rolled_back");
  // Rollback restores the instruction snapshot only. The accepted project file stays until a later launch.
  expect(readFileSync(followFile, "utf8")).toBe(published);
  const afterRollback = improve.activeImprovementSnapshot({ projectPath: dirs.alpha, role: "developer" });
  expect(afterRollback.versions.some((version) => version.content.includes("Required validation step:"))).toBe(false);
  const reverted = await (await import("../orchestrator.ts")).createTask({
    title: "After rollback",
    prompt: impl,
    workdir: dirs.alpha,
    isolation: "none",
    column: "ready",
    agent: "claude-code",
    model: "haiku-4.5",
    mode: "auto",
  });
  if ("error" in reverted) throw new Error(reverted.error);
  const startedReverted = await (await import("../orchestrator.ts")).startTask(reverted.task.id);
  if ("error" in startedReverted) throw new Error(startedReverted.error);
  let revertedBody = "";
  for (let i = 0; i < 100 && !revertedBody.includes("return a - b"); i++) {
    await Bun.sleep(30);
    try { revertedBody = readFileSync(followFile, "utf8"); } catch { /* wait for the rolled-back launch */ }
  }
  expect(revertedBody).toContain("return a - b");

  const harness = await import("../self-improve/harness-eval.ts");
  const refused = await harness.requestImprovementDraft({
    currentContent: "Implement the requested change and describe the result.",
    weakness: "validation qc finding",
    provider: "cursor",
    model: "composer",
    accountId: null,
  });
  expect(refused).toEqual({ error: "Cursor and DeepSeek stay execution-blocked. No improvement draft was requested." });
  const { runSeatbeltBunTest, setPracticalBoundaryFactoryForTest } = await import("./observed-test.ts");
  const outside = runSeatbeltBunTest({
    workspacePath: dirs.alpha,
    testPath: "../excluded/src/add.test.ts",
    command: "bun test ./../excluded/src/add.test.ts",
    executable: process.execPath,
    argv: ["test", "./../excluded/src/add.test.ts"],
  });
  expect((await outside).isolation).toBe("blocked");
  expect((await outside).exitCode).toBe(null);
  setPracticalBoundaryFactoryForTest(() => { throw new Error("seatbelt probe refused"); });
  const blocked = await runSeatbeltBunTest({
    workspacePath: dirs.alpha,
    testPath: "src/add.test.ts",
    command: "bun test ./src/add.test.ts",
    executable: process.execPath,
    argv: ["test", "./src/add.test.ts"],
  });
  setPracticalBoundaryFactoryForTest(null);
  expect(blocked.isolation).toBe("blocked");
  expect(blocked.reason).toContain("seatbelt probe refused");
  expect(blocked.exitCode).toBe(null);
}, { timeout: 180_000 });

afterAll(() => {
  coordinator?.resetAutonomyLoopForTest();
  engine?.setAutonomyClock(() => Date.now());
});
