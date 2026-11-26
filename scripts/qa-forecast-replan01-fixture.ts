import { Database } from "bun:sqlite";
import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { join } from "node:path";

type QaCall = (method: string, route: string, body?: unknown, status?: number) => Promise<any>;

/** Disposable Owner UI fixture. Records a Developer result and leaves the mission paused. */
export async function seedMissionReplanFixture(call: QaCall, dataDir: string, profileHome: string) {
  await call("PATCH", "/harnesses/codex", { enabled: true });
  const root = realpathSync(mkdtempSync(join(dataDir, "mission-replan-")));
  const projectPath = join(root, "project");
  mkdirSync(projectPath);
  await call("POST", "/projects", { path: projectPath, name: "Mission replan fixture" });
  const task = await call("POST", "/tasks", {
    title: "Review recorded implementation", prompt: "Read the fixture evidence.", workdir: projectPath, isolation: "none",
  });
  const profiles = [];
  for (const name of ["Original fixture", "Replacement fixture"]) {
    const directory = join(profileHome, name);
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    writeFileSync(join(directory, "synthetic-authenticated"), name, { mode: 0o600 });
    profiles.push(await call("POST", "/account-core/codex-profiles", { displayName: name, directory }, 201));
  }
  const [a, b] = profiles;
  const model = "gpt-6.1-sol";
  const now = Date.now();
  const { policy } = await call("POST", "/api/autonomy/policies", {
    mode: "full-autonomy", scopeKind: "project", scopeRef: projectPath, projects: [projectPath],
    specialistRoles: ["developer", "reviewer"], providers: ["codex"], models: [model], accounts: [a.accountId, b.accountId],
    maxConcurrentWorkers: 2, maxLaunches: 8, maxDurationMs: 300_000, expiresAt: now + 300_000,
    permittedActions: ["plan_task", "launch_task", "run_qc"], qc: { required: true }, completion: { autoComplete: false },
  });
  const { activation } = await call("POST", `/api/autonomy/policies/${policy.id}/activate`, {});
  const { mission } = await call("POST", "/api/orchestration/missions/prepare", {
    title: "Frozen Reviewer fixture", goal: "Preserve implementation",
    tasks: [{ taskId: task.id, taskTitle: task.title, projectPath, harnessId: a.harnessId, modelId: model, accountId: a.accountId, mode: "auto" }],
    concurrencyLimits: { globalMax: 2, perProjectMax: 2, perAccountMax: 1 },
  });
  await call("POST", `/api/orchestration/missions/${mission.id}/authorize`, { digest: mission.planDigest });
  using db = new Database(join(dataDir, "agetor.sqlite"));
  db.run("PRAGMA busy_timeout = 3000");
  db.transaction(() => {
    db.run(`INSERT INTO autonomy_mission_bindings
      (mission_id,policy_id,revision,activation_id,digest,mode,outcome,emergency_task_ids_json,created_at,updated_at)
      VALUES (?,?,?,?,?,'full-autonomy','active','[]',?,?)`, [mission.id, policy.id, policy.revision, activation.id, policy.digest, now, now]);
    db.run(`INSERT INTO runs(id,task_id,agent,status,started_at,ended_at)
      VALUES ('reviewer-fixture-dev',?,?,'succeeded',?,?)`, [task.id, a.harnessId, now - 3000, now - 2000]);
    db.run(`UPDATE tasks SET "column"='review',run_id='reviewer-fixture-dev' WHERE id=?`, [task.id]);
    db.run(`UPDATE orchestration_missions SET status='paused',plan_json=json_set(plan_json,
      '$.tasks[0].phase','blocked','$.tasks[0].runId','reviewer-fixture-dev','$.tasks[0].phaseReason','Recorded resource blocker') WHERE id=?`, [mission.id]);
  }).immediate();

  return { projectPath, task, mission, replacement: b, model };
}

/** Two unstarted Developer stages in one paused mission. No runs are recorded. */
export async function seedAtomicReplanFixture(call: QaCall, dataDir: string, profileHome: string) {
  await call("PATCH", "/harnesses/codex", { enabled: true });
  const root = realpathSync(mkdtempSync(join(dataDir, "mission-atomic-")));
  const projectPath = join(root, "project");
  mkdirSync(projectPath);
  await call("POST", "/projects", { path: projectPath, name: "Atomic replan fixture" });
  const created: Array<{ id: string; title: string }> = [];
  for (const title of ["Remaining parser", "Remaining tests"]) {
    created.push(await call("POST", "/tasks", {
      title, prompt: "Keep this stage unstarted.", workdir: projectPath, isolation: "none",
    }));
  }
  const profiles = [];
  for (const name of ["Atomic original", "Atomic replacement"]) {
    const directory = join(profileHome, `${name}-${crypto.randomUUID()}`);
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    writeFileSync(join(directory, "synthetic-authenticated"), name, { mode: 0o600 });
    profiles.push(await call("POST", "/account-core/codex-profiles", { displayName: name, directory }, 201));
  }
  const [a, b] = profiles;
  const model = "gpt-6.1-sol";
  const now = Date.now();
  const { policy } = await call("POST", "/api/autonomy/policies", {
    mode: "full-autonomy", scopeKind: "project", scopeRef: projectPath, projects: [projectPath],
    specialistRoles: ["developer", "reviewer"], providers: ["codex"], models: [model], accounts: [a.accountId, b.accountId],
    maxConcurrentWorkers: 2, maxLaunches: 8, maxDurationMs: 300_000, expiresAt: now + 300_000,
    permittedActions: ["plan_task", "launch_task", "run_qc"], qc: { required: false }, completion: { autoComplete: false },
  });
  const { activation } = await call("POST", `/api/autonomy/policies/${policy.id}/activate`, {});
  const { mission } = await call("POST", "/api/orchestration/missions/prepare", {
    title: "Atomic Developer fixture", goal: "Amend both remaining stages",
    tasks: created.map(task => ({
      taskId: task.id, taskTitle: task.title, projectPath, harnessId: a.harnessId, modelId: model, accountId: a.accountId, mode: "auto", qcRequired: false,
    })),
    concurrencyLimits: { globalMax: 2, perProjectMax: 2, perAccountMax: 1 },
  });
  await call("POST", `/api/orchestration/missions/${mission.id}/authorize`, { digest: mission.planDigest });
  using db = new Database(join(dataDir, "agetor.sqlite"));
  db.run("PRAGMA busy_timeout = 3000");
  db.transaction(() => {
    db.run(`INSERT INTO autonomy_mission_bindings
      (mission_id,policy_id,revision,activation_id,digest,mode,outcome,emergency_task_ids_json,created_at,updated_at)
      VALUES (?,?,?,?,?,'full-autonomy','active','[]',?,?)`, [mission.id, policy.id, policy.revision, activation.id, policy.digest, now, now]);
    for (const task of created) db.run(`UPDATE tasks SET "column"='ready' WHERE id=?`, [task.id]);
    db.run(`UPDATE orchestration_missions SET status='paused' WHERE id=?`, [mission.id]);
  }).immediate();
  return { projectPath, tasks: created, mission, replacement: b, model };
}
