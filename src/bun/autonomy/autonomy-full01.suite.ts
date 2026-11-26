import { afterAll, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { FAKE_QC_REVIEW_PROMPT_MARKER } from "../../shared/task-quality-control.ts";

const isolated = realpathSync(mkdtempSync(path.join(tmpdir(), "fo-autonomy-full01-")));
process.env.AGETOR_DATA_DIR = isolated;
process.env.HOME = isolated;
process.env.AGETOR_API_PORT = "4591";
process.env.AGETOR_USAGE_OFFLINE = "1";
process.env.AGETOR_CLAUDE_DRIVER = "fake";
process.env.AGETOR_CLAUDE_BIN = "/bin/echo";
process.env.AGETOR_CODEX_DRIVER = "fake";
process.env.AGETOR_CODEX_BIN = "/bin/echo";
process.env.AGETOR_TMUX_BIN = "/bin/echo";
process.env.AGETOR_FAKE_QC_VERDICT = "PASS";
process.env.AGETOR_FAKE_CLAUDE_RESOLVE_DELAY_MS = "350";
for (const kind of ["CURSOR", "GEMINI", "FX", "ANTIGRAVITY"]) process.env["AGETOR_" + kind + "_BIN"] = "/nonexistent/fo-autonomy-full01";

const ACTIONS = [
  "create_task", "assign_specialist", "plan_task", "launch_task", "run_qc",
  "request_rework", "select_model", "retrieve_brain", "save_observation",
  "complete_task", "update_mission_status", "coordinate_projects",
];

let engine: typeof import("./policy-engine.ts");
let store: typeof import("../db.ts");
let coordinator: typeof import("./coordinator.ts");
let gate: typeof import("./gate.ts");
let scheduler: typeof import("../orchestration/mission-scheduler.ts");

async function load() {
  store = await import("../db.ts");
  engine = await import("./policy-engine.ts");
  coordinator = await import("./coordinator.ts");
  gate = await import("./gate.ts");
  scheduler = await import("../orchestration/mission-scheduler.ts");
  (await import("../employee-run.ts")).initEmployeeExecutionTracking();
  store.harnesses.setEnabled("claude-code", true);
  store.harnesses.setEnabled("cursor", false);
  coordinator.resetAutonomyLoopForTest();
  engine.setAutonomyClock(() => Date.now());
}

function policyInput(projects: string[], overrides: Record<string, unknown> = {}) {
  return {
    mode: "full-autonomy",
    scopeKind: "workspace",
    scopeRef: "workspace",
    projects,
    clusters: [],
    specialistRoles: ["developer", "reviewer", "head"],
    providers: ["claude-code"],
    models: ["haiku-4.5", "sonnet-5"],
    allowUnscopedAccount: true,
    maxConcurrentWorkers: 2,
    maxLaunches: 40,
    maxDurationMs: 60 * 60 * 1000,
    maxReworkAttempts: 1,
    permittedActions: ACTIONS,
    qc: { required: true, requireIndependentReviewer: true, requireObservedTest: false },
    completion: { autoComplete: true, conditions: ["qc_pass"] },
    memory: { approval: "propose" },
    routerPreset: "balanced",
    spending: { limitUsd: 25, requireEnforceableCap: false },
    expiresAt: Date.now() + 60 * 60 * 1000,
    ...overrides,
  };
}

function launch(projectPath: string, taskId: string, key: string) {
  return engine.authorizeAutonomyAction({
    targetKey: key,
    target: {
      action: "launch_task",
      projectPath,
      taskId,
      role: "developer",
      provider: "claude-code",
      model: "haiku-4.5",
    },
  });
}

test("policy activation, limits, and revocation are enforced before any worker starts", async () => {
  await load();
  const projects = ["/synthetic/alpha", "/synthetic/beta"];
  const created = engine.createAutonomyPolicy(policyInput(projects, { maxConcurrentWorkers: 1, maxLaunches: 2 }));
  const activation = engine.activateAutonomyPolicy(created.id, created.revision);
  expect(activation.activatedBy).toBe("owner");
  expect(activation.provenance).toMatchObject({ actor: "owner", digest: created.digest });

  const first = launch(projects[0]!, "task-a", "launch_task:task-a:0");
  expect(first.launch).toBe(true);
  engine.consumeAutonomyReservation(first.reservationId!);
  const replay = launch(projects[0]!, "task-a", "launch_task:task-a:0");
  expect(replay.replayed).toBe(true);
  expect(replay.launch).toBe(false);
  expect(store.db.query<{ n: number }, [string]>(
    "SELECT COUNT(*) AS n FROM autonomy_action_reservations WHERE activation_id = ? AND action = 'launch_task'",
  ).get(activation.id)!.n).toBe(1);

  const second = launch(projects[1]!, "task-b", "launch_task:task-b:0");
  expect(second.decision.allow).toBe(false);
  expect(second.decision.reason).toContain("concurrency");

  engine.releaseAutonomyReservation(first.reservationId!);
  const uncapped = engine.authorizeAutonomyAction({
    routerRecommended: true,
    target: { action: "launch_task", projectPath: "/synthetic/outside", role: "developer", provider: "claude-code", model: "opus-5.5" },
  });
  expect(uncapped.decision.allow).toBe(false);
  expect(uncapped.decision.reason).toContain("not authority");

  const projectPolicy = engine.createAutonomyPolicy(policyInput(["/synthetic/alpha"], {
    scopeKind: "project",
    scopeRef: "/synthetic/alpha",
    permittedActions: ["plan_task"],
    completion: { autoComplete: false, conditions: ["qc_pass"] },
  }));
  engine.activateAutonomyPolicy(projectPolicy.id);
  const narrowed = launch("/synthetic/alpha", "task-c", "launch_task:task-c:0");
  expect(narrowed.decision.allow).toBe(false);
  expect(narrowed.decision.intersectedPolicyIds).toContain(projectPolicy.id);

  const expanded = engine.reviseAutonomyPolicy(created.id, policyInput([...projects, "/synthetic/gamma"], { maxLaunches: 8 }));
  expect(expanded.expandsExisting.length).toBeGreaterThan(0);
  expect(() => engine.activateAutonomyPolicy(created.id, expanded.policy.revision)).toThrow(/expands the active authorization/);

  const spend = engine.createAutonomyPolicy(policyInput(projects, { spending: { limitUsd: 5, requireEnforceableCap: true } }));
  expect(spend.body.spending.enforceable).toBe(false);
  expect(() => engine.activateAutonomyPolicy(spend.id)).toThrow(/not enforceable/);

  engine.pauseAutonomyPolicy(created.id);
  expect(launch(projects[1]!, "task-d", "launch_task:task-d:0").decision.reason).toContain("paused");
  engine.resumeAutonomyPolicy(created.id);
  engine.revokeAutonomyPolicy(created.id);
  expect(() => engine.resumeAutonomyPolicy(created.id)).toThrow(/cannot resume/);
  expect(launch(projects[1]!, "task-e", "launch_task:task-e:0").decision.reason).toContain("revoked");

  const stopped = engine.createAutonomyPolicy(policyInput(["/synthetic/stop"]));
  engine.activateAutonomyPolicy(stopped.id);
  await coordinator.emergencyStopAutonomy("acceptance stop");
  expect(launch("/synthetic/stop", "task-f", "launch_task:task-f:0").decision.reason).toContain("Emergency stop");
  coordinator.clearEmergencyStop();
  expect(engine.autonomyStatus().emergency.active).toBe(false);
  engine.setAutonomyClock(() => Date.now());
});

test("full autonomy plans, reviews, reworks, and completes only inside the Owner policy", async () => {
  if (!store) await load();
  engine.setAutonomyClock(() => Date.now());
  coordinator.resetAutonomyLoopForTest();
  const root = path.join(isolated, "workspace");
  mkdirSync(root, { recursive: true });
  const names = ["alpha", "beta", "gamma", "excluded"] as const;
  const dirs: Record<(typeof names)[number], string> = {} as never;
  for (const name of names) {
    mkdirSync(path.join(root, name), { recursive: true });
    const dir = realpathSync(path.join(root, name));
    Bun.spawnSync(["git", "init", "-q", dir]);
    writeFileSync(path.join(dir, "README.md"), `# ${name}\n`);
    store.projects.upsert(dir, name);
    dirs[name] = dir;
  }
  const clusters = ["cluster-alpha", "cluster-beta"];
  for (const id of clusters) {
    store.db.run(
      `INSERT INTO clusters (id, name, slug, description, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)`,
      [id, id, id, id, Date.now(), Date.now()],
    );
  }
  const membership: Array<[string, string]> = [
    [dirs.alpha, "cluster-alpha"],
    [dirs.gamma, "cluster-alpha"],
    [dirs.beta, "cluster-beta"],
    [dirs.excluded, "cluster-beta"],
  ];
  for (const [projectPath, clusterId] of membership) {
    store.db.run(
      `INSERT INTO cluster_project_memberships (project_path, cluster_id, assigned_at, updated_at) VALUES (?, ?, ?, ?)`,
      [projectPath, clusterId, Date.now(), Date.now()],
    );
  }
  const excluded = await (await import("../orchestrator.ts")).createTask({
    title: "Excluded defect",
    prompt: "Do not touch this project.",
    workdir: dirs.excluded,
    isolation: "none",
    column: "ready",
    agent: "claude-code",
    model: "haiku-4.5",
    mode: "auto",
  });
  if ("error" in excluded) throw new Error(excluded.error);

  const supervised = engine.createAutonomyPolicy(policyInput([dirs.alpha], { mode: "supervised", permittedActions: ["plan_task"] }));
  engine.activateAutonomyPolicy(supervised.id);
  await expect(coordinator.prepareAutonomousMission({
    policyId: supervised.id,
    title: "Supervised stays manual",
    goal: "Do not auto-dispatch.",
    proposals: [{ title: "Manual", projectPath: dirs.alpha, clusterId: "cluster-alpha" }],
  })).rejects.toThrow(/per-step Owner approval/);

  coordinator.clearEmergencyStop();
  for (const row of engine.autonomyStatus().activations) {
    if (row.status === "active" || row.status === "paused") engine.revokeAutonomyPolicy(row.policyId);
  }
  const policy = engine.createAutonomyPolicy(policyInput([dirs.alpha, dirs.beta, dirs.gamma], {
    clusters: clusters,
    scopeKind: "workspace",
  }));
  expect(engine.autonomyStatus().enforcement.fullAutonomyActive).toBe(false);
  engine.activateAutonomyPolicy(policy.id);
  expect(engine.autonomyStatus().enforcement.fullAutonomyActive).toBe(true);

  const prepared = await coordinator.prepareAutonomousMission({
    policyId: policy.id,
    title: "Repair the authorized example-infrastructure projects",
    goal: "Review the authorized projects, fix important defects, run QC, and finish approved work.",
    proposals: [
      { title: "Alpha defect", projectPath: dirs.alpha, clusterId: "cluster-alpha", specialistRole: "developer" },
      { title: "Beta defect", projectPath: dirs.beta, clusterId: "cluster-beta", specialistRole: "developer", prompt: `${FAKE_QC_REVIEW_PROMPT_MARKER}:CHANGES_REQUESTED\nFix the beta defect.` },
      { title: "Alpha follow-up", projectPath: dirs.alpha, clusterId: "cluster-alpha", dependsOnTitles: [{ title: "Alpha defect" }] },
      { title: "Gamma close", projectPath: dirs.gamma, clusterId: "cluster-alpha", dependsOnTitles: [{ title: "Alpha follow-up" }, { title: "Beta defect" }] },
      { title: "Beta notes", projectPath: dirs.beta, clusterId: "cluster-beta", specialistRole: "developer" },
    ],
  });
  const mission = prepared.mission;
  expect(mission.projects).not.toContain(dirs.excluded);
  expect(mission.plan.tasks).toHaveLength(5);
  const byTitle = new Map(mission.plan.tasks.map((task) => [task.taskTitle, task]));
  expect(byTitle.get("Alpha follow-up")!.dependencies.map((item) => item.taskId)).toContain(byTitle.get("Alpha defect")!.taskId);
  for (const task of mission.plan.tasks) {
    expect(["haiku-4.5", "sonnet-5"]).toContain(task.modelId);
    expect(task.harnessId).toBe("claude-code");
  }

  const unbound = await scheduler.missionScheduler.prepareMission({
    title: "Unbound supervised mission",
    goal: "Owner still approves each step.",
    projectPaths: [dirs.excluded],
    tasks: [{
      taskId: excluded.task.id,
      taskTitle: "Excluded defect",
      projectPath: dirs.excluded,
      specialistRole: "developer",
      harnessId: "claude-code",
      modelId: "haiku-4.5",
      qcRequired: true,
    }],
  });
  expect(gate.autonomyLaunchDecision(unbound, unbound.plan.tasks[0]!).kind).toBe("legacy");

  let peakRunning = 0;
  let followUpStartedEarly = false;
  const started = Date.now();
  let stripped = false;
  let sawRework = false;
  while (Date.now() - started < 90_000) {
    const running = mission.plan.tasks.filter((task) => store.tasks.get(task.taskId)?.column === "running").length;
    peakRunning = Math.max(peakRunning, running);
    const alpha = store.tasks.get(byTitle.get("Alpha defect")!.taskId);
    const follow = store.tasks.get(byTitle.get("Alpha follow-up")!.taskId);
    if ((follow?.runId || store.runs.listForTask(follow!.id).length > 0) && alpha?.column !== "done") followUpStartedEarly = true;
    const beta = store.tasks.get(byTitle.get("Beta defect")!.taskId);
    if (!stripped && beta?.qcState?.latestVerdict === "CHANGES_REQUESTED") {
      sawRework = true;
      store.tasks.update(beta.id, { prompt: "Fix the beta defect." });
      stripped = true;
    }
    await scheduler.missionScheduler.tickAllRunningMissions();
    await coordinator.finalizeAutonomyTick();
    const current = (await import("../orchestration/mission-store.ts")).missionStore.getMission(mission.id);
    if (current?.status === "completed") break;
    await Bun.sleep(40);
  }

  const finished = (await import("../orchestration/mission-store.ts")).missionStore.getMission(mission.id)!;
  const columns = finished.plan.tasks.map((task) => ({
    title: task.taskTitle,
    phase: task.phase,
    reason: task.phaseReason,
    column: store.tasks.get(task.taskId)?.column,
    verdict: store.tasks.get(task.taskId)?.qcState?.latestVerdict,
    runs: store.runs.listForTask(task.taskId).length,
  }));
  expect(finished.status, JSON.stringify(columns)).toBe("completed");
  expect(sawRework).toBe(true);
  expect(followUpStartedEarly).toBe(false);
  expect(peakRunning).toBeGreaterThanOrEqual(2);
  expect(peakRunning).toBeLessThanOrEqual(2);
  for (const task of columns) {
    expect(task.column).toBe("done");
    expect(task.verdict).toBe("PASS");
  }
  const betaRow = store.tasks.get(byTitle.get("Beta defect")!.taskId)!;
  expect(betaRow.qcState?.reworkCount).toBe(1);
  expect(store.tasks.get(excluded.task.id)!.column).toBe("ready");
  expect(store.runs.listForTask(excluded.task.id)).toHaveLength(0);

  const beforeRestart = finished.plan.tasks.map((task) => store.runs.listForTask(task.taskId).map((run) => run.id).join(","));
  await coordinator.recoverAutonomy();
  await scheduler.missionScheduler.recoverOrchestrationMissions();
  await scheduler.missionScheduler.tickAllRunningMissions();
  const afterRestart = finished.plan.tasks.map((task) => store.runs.listForTask(task.taskId).map((run) => run.id).join(","));
  expect(afterRestart).toEqual(beforeRestart);

  const summary = (await import("./policy-store.ts")).autonomyPolicyStore.getBinding(mission.id)?.summary ?? "";
  expect(summary).toContain(policy.id);
  expect(summary).toContain("5 of 5 tasks are Done with QC PASS");
  expect(summary).not.toContain("Excluded");

  const events = store.db.query<{ event_type: string; payload_json: string }, []>(
    "SELECT event_type, payload_json FROM activity_events WHERE event_type LIKE 'autonomy.%'",
  ).all();
  expect(events.some((event) => event.payload_json.includes(policy.id))).toBe(true);

  const blocked = gate.autonomyQcDecision(finished, finished.plan.tasks[0]!, "BLOCKED");
  expect(blocked.kind).toBe("block");
  expect(store.tasks.get(finished.plan.tasks[0]!.taskId)!.column).toBe("done");

  const expiring = engine.createAutonomyPolicy(policyInput(["/synthetic/expire"], { expiresAt: Date.now() + 60_000, maxDurationMs: 60_000 }));
  engine.activateAutonomyPolicy(expiring.id);
  engine.setAutonomyClock(() => Date.now() + 120_000);
  engine.expireDuePolicies();
  expect(launch("/synthetic/expire", "after-expiry", "launch_task:after-expiry:0").decision.reason).toContain("expired");

  engine.setAutonomyClock(() => Date.now());
  const revocable = engine.createAutonomyPolicy(policyInput(["/synthetic/revoke"], { expiresAt: Date.now() + 60 * 60 * 1000 }));
  engine.activateAutonomyPolicy(revocable.id);
  engine.revokeAutonomyPolicy(revocable.id);
  expect(launch("/synthetic/revoke", "after-revoke", "launch_task:after-revoke:0").decision.reason).toContain("revoked");

  const live = engine.createAutonomyPolicy(policyInput(["/synthetic/stop-late"]));
  engine.activateAutonomyPolicy(live.id);
  await coordinator.emergencyStopAutonomy("stop the remaining mission");
  expect(launch("/synthetic/stop-late", "after-stop", "launch_task:after-stop:0").decision.allow).toBe(false);
  coordinator.clearEmergencyStop();
  expect(engine.autonomyStatus().enforcement.fullAutonomyActive).toBe(true);
});

afterAll(() => {
  coordinator?.resetAutonomyLoopForTest();
  engine?.setAutonomyClock(() => Date.now());
});
