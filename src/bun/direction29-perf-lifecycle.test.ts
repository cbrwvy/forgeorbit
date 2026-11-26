import { afterAll, beforeAll, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

/**
 * Direction 29 focused regression tests for multi-project lifecycle scanning,
 * launch admission, and fresh per-snapshot ownership resolution at scale.
 */
const root = realpathSync(mkdtempSync(path.join(tmpdir(), "fo-d29-perf-")));
process.env.AGETOR_DATA_DIR = path.join(root, "data");
process.env.AGETOR_USAGE_OFFLINE = "1";
process.env.AGETOR_DISABLE_UPDATES = "1";

let dbModule: typeof import("./db.ts");
let ownershipModule: typeof import("./project-ownership.ts");
let lifecycleModule: typeof import("./project-lifecycle.ts");

beforeAll(async () => {
  dbModule = await import("./db.ts");
  ownershipModule = await import("./project-ownership.ts");
  lifecycleModule = await import("./project-lifecycle.ts");
});

afterAll(() => {
  lifecycleModule?.stopProjectDrainWatch?.();
  dbModule?.db?.close?.();
  rmSync(root, { recursive: true, force: true });
});

test("40 projects / 400 tasks: listProjectsWithLifecycle and reconcileProjectLifecyclesOnBoot preserve exact counts and run fast", () => {
  const { db, projects, runs } = dbModule;
  const {
    listProjectsWithLifecycle,
    reconcileProjectLifecyclesOnBoot,
    registerProjectLifecycleTaskProbe,
    registerProjectLifecycleProcessProbe,
    checkProjectLaunchAdmission,
  } = lifecycleModule;

  const projectDirs: string[] = [];
  for (let i = 0; i < 40; i++) {
    const dir = path.join(root, "projects", `p-${String(i).padStart(2, "0")}`);
    mkdirSync(path.join(dir, "packages/web"), { recursive: true });
    projects.upsert(dir, `Project ${i}`);
    projectDirs.push(dir);
  }

  let liveTaskId = "";
  let pipelineParentId = "";
  let pipelineStepId = "";
  let unconfirmedTaskId = "";
  const now = Date.now();
  const insertTask = db.prepare(`
    INSERT INTO tasks(id,title,prompt,"column",agent,workdir,model,mode,isolation,pipeline_parent_id,created_at,updated_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?)
  `);

  db.transaction(() => {
    for (let i = 0; i < 400; i++) {
      const pIdx = i % 40;
      const dir = i === 0 ? path.join(projectDirs[0]!, "packages/web") : projectDirs[pIdx]!;
      const id = randomUUID();
      if (i === 0) liveTaskId = id;
      if (i === 1) pipelineParentId = id;
      if (i === 41) pipelineStepId = id;
      if (i === 2) unconfirmedTaskId = id;

      insertTask.run(
        id,
        `Task ${i}`,
        `Work ${i}`,
        i === 0 || i === 41 ? "running" : "ready",
        "codex",
        dir,
        "gpt-6.1-sol",
        "auto",
        "none",
        i === 41 ? pipelineParentId : null,
        now,
        now,
      );
    }

    runs.insert({
      id: randomUUID(),
      taskId: liveTaskId,
      agent: "codex",
      status: "running",
      startedAt: now,
      endedAt: null,
      exitCode: null,
      tmuxSession: null,
      claudeSessionId: null,
      codexSessionId: "codex-live-1",
      cursorSessionId: null,
      geminiSessionId: null,
      fxSessionId: null,
    });
  })();

  const liveSet = new Set([liveTaskId, pipelineStepId]);
  registerProjectLifecycleTaskProbe((id) => liveSet.has(id));
  registerProjectLifecycleProcessProbe(() => [unconfirmedTaskId]);

  // Set Project 2 (unconfirmedTaskId), Project 3 (idle draining), Project 4 (idle recovering), Project 5 (paused)
  projects.setLifecycleState(projectDirs[2]!, "draining", "stop requested", now);
  projects.setLifecycleState(projectDirs[3]!, "draining", "idle drain", now);
  projects.setLifecycleState(projectDirs[4]!, "recovering", "interrupted recovery", now);
  projects.setLifecycleState(projectDirs[5]!, "paused", "already paused", now);

  // Admission fail-closed checks
  expect(checkProjectLaunchAdmission(projectDirs[0]!).allowed).toBe(true);
  expect(checkProjectLaunchAdmission(projectDirs[2]!).allowed).toBe(false);
  expect(checkProjectLaunchAdmission(projectDirs[5]!).allowed).toBe(false);

  // Measure listProjectsWithLifecycle on 40p / 400t
  const t0 = performance.now();
  const listed = listProjectsWithLifecycle();
  const listMs = performance.now() - t0;

  expect(listed).toHaveLength(40);
  // Pre-optimization baseline on 40p/400t took ~12.5 seconds; single-pass attribution must stay well under 250ms.
  expect(listMs).toBeLessThan(250);

  const byPath = new Map(listed.map((p) => [p.path, p.lifecycle!]));
  expect(byPath.get(projectDirs[0]!)?.activeBreakdown).toEqual({
    taskRuns: 1,
    managerTurns: 0,
    interviewTurns: 0,
    unconfirmedProcesses: 0,
  });
  expect(byPath.get(projectDirs[1]!)?.activeBreakdown).toEqual({
    taskRuns: 1,
    managerTurns: 0,
    interviewTurns: 0,
    unconfirmedProcesses: 0,
  });
  expect(byPath.get(projectDirs[2]!)?.state).toBe("draining");
  expect(byPath.get(projectDirs[2]!)?.activeBreakdown.unconfirmedProcesses).toBe(1);
  // Project 3 had draining with 0 executions, so listProjectsWithLifecycle settled it to paused.
  expect(byPath.get(projectDirs[3]!)?.state).toBe("paused");

  // Re-arm draining & recovering to verify reconcileProjectLifecyclesOnBoot
  projects.setLifecycleState(projectDirs[3]!, "draining", "boot drain", now);
  projects.setLifecycleState(projectDirs[4]!, "recovering", "boot recov", now);
  const tBoot = performance.now();
  const changed = reconcileProjectLifecyclesOnBoot();
  const bootMs = performance.now() - tBoot;

  expect(changed).toBe(2);
  expect(bootMs).toBeLessThan(250);
  expect(projects.getLifecycleRaw(projectDirs[3]!)?.lifecycleState).toBe("paused");
  expect(projects.getLifecycleRaw(projectDirs[4]!)?.lifecycleState).toBe("paused");
  // Project 2 stays draining with unconfirmed process still present
  expect(projects.getLifecycleRaw(projectDirs[2]!)?.lifecycleState).toBe("draining");
});

test("createFreshOwnershipResolver sees newly registered projects across calls", () => {
  const { projects } = dbModule;
  const { createFreshOwnershipResolver } = ownershipModule;

  const extra = path.join(root, "projects", "newly-added");
  const sub = path.join(extra, "src");
  mkdirSync(sub, { recursive: true });

  const before = createFreshOwnershipResolver();
  expect(before(sub).kind).toBe("unattributed");

  projects.upsert(extra, "Newly added");
  const after = createFreshOwnershipResolver();
  expect(after(sub)).toMatchObject({ kind: "owned", projectPath: extra, via: "subfolder" });
});

test("routingEvidenceKey ignores transient local run occupancy while invalidating on real quota or account changes", async () => {
  const { db, runs } = dbModule;
  const { AccountCore } = await import("./account-core.ts");
  const { buildRoutingSnapshot } = await import("./model-router.ts");
  const { routingEvidenceKey } = await import("./routing-evidence-key.ts");

  const core = new AccountCore(db, () => 5000);
  const account = core.createAccount({ provider: "codex", displayName: "Concurrent Account", availability: "available" });
  core.bindHarness(account.id, "codex");
  const qDef = core.createDefinition({ accountId: account.id, scope: "account", unit: { kind: "concurrency" }, window: "instant" });
  core.recordObservation(qDef.id, { limit: 4, remaining: 4, used: 0, expiresAt: 60_000 });

  const taskRowId = randomUUID();
  const runRowId = randomUUID();
  const dir = path.join(root, "projects", "p-00");
  db.run(
    `INSERT INTO tasks(id,title,prompt,"column",agent,workdir,model,mode,isolation,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
    [taskRowId, "Concurrent sibling", "work", "ready", "codex", dir, "gpt-6.1-sol", "auto", "none", 5000, 5000],
  );

  const keyIdle = routingEvidenceKey(buildRoutingSnapshot(db, 5000));
  runs.insert({
    id: runRowId,
    taskId: taskRowId,
    agent: "codex",
    status: "running",
    startedAt: 5000,
    endedAt: null,
    exitCode: null,
    tmuxSession: null,
    claudeSessionId: null,
    codexSessionId: null,
    cursorSessionId: null,
    geminiSessionId: null,
    fxSessionId: null,
  });
  const keyActive = routingEvidenceKey(buildRoutingSnapshot(db, 5005));
  expect(keyActive).toBe(keyIdle);

  runs.update(runRowId, { status: "succeeded", endedAt: 5100, exitCode: 0 });
  const keySettled = routingEvidenceKey(buildRoutingSnapshot(db, 5100));
  expect(keySettled).toBe(keyIdle);

  // Real quota change must still invalidate the routing evidence key.
  core.recordObservation(qDef.id, { limit: 4, remaining: 0, used: 4, expiresAt: 60_000 });
  const keyQuotaExhausted = routingEvidenceKey(buildRoutingSnapshot(db, 5200));
  expect(keyQuotaExhausted).not.toBe(keyIdle);
});
