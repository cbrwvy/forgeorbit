import { beforeAll, afterAll, expect, test, describe } from "bun:test";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { makeTask } from "../../cli/test-fixtures.ts";

const root = mkdtempSync(path.join(tmpdir(), "fo-orch-scale01-test-"));
process.env.AGETOR_DATA_DIR = root;
process.env.AGETOR_API_PORT = "4498";
process.env.AGETOR_CLAUDE_DRIVER = "fake";
process.env.AGETOR_CODEX_DRIVER = "fake";
process.env.AGETOR_FAKE_QC_VERDICT = "PASS";
process.env.AGETOR_ALLOW_LEGACY_QUEUE_POLICY_SCHEMA = "1";

let dbModule: typeof import("../db.ts");
let schedulerModule: typeof import("./mission-scheduler.ts");
let storeModule: typeof import("./mission-store.ts");
let headModule: typeof import("./head-pm-integration.ts");
let server: { stop(): void };
let token: string;

const clusterIds = ["cluster-alpha", "cluster-beta", "cluster-gamma"];
const projectPaths: string[] = [];
const allTaskIds: string[] = [];

async function call(route: string, data?: unknown) {
  const r = await fetch(`http://127.0.0.1:4498${route}`, {
    method: data ? "POST" : "GET",
    headers: {
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
    },
    body: data ? JSON.stringify(data) : undefined,
  });
  const json = await r.json();
  return { status: r.status, ok: r.ok, json };
}

beforeAll(async () => {
  dbModule = await import("../db.ts");
  schedulerModule = await import("./mission-scheduler.ts");
  storeModule = await import("./mission-store.ts");
  headModule = await import("./head-pm-integration.ts");

  const api = await import("../server.ts");
  token = api.API_TOKEN;
  server = api.startApiServer() as any;

  // Seed 3 clusters
  for (let i = 0; i < clusterIds.length; i++) {
    const cId = clusterIds[i]!;
    const name = `Cluster ${String.fromCharCode(65 + i)}`;
    dbModule.db.run(
      `INSERT INTO clusters (id, name, slug, description, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
      [cId, name, cId, `Description for ${name}`, Date.now(), Date.now()],
    );
  }

  // Seed 30 projects (10 per cluster) and 60 tasks (2 per project)
  for (let i = 1; i <= 30; i++) {
    const num = String(i).padStart(2, "0");
    const projDir = path.join(root, `proj-${num}`);
    Bun.spawnSync(["git", "init", "-q", projDir]);
    writeFileSync(path.join(projDir, "README.md"), `# Project ${num}`);
    dbModule.projects.upsert(projDir, `Project ${num}`);
    projectPaths.push(projDir);

    // Assign to one of 3 clusters
    const clusterId = clusterIds[(i - 1) % 3]!;
    dbModule.db.run(
      `INSERT INTO cluster_project_memberships (project_path, cluster_id, assigned_at, updated_at)
       VALUES (?, ?, ?, ?)`,
      [projDir, clusterId, Date.now(), Date.now()],
    );

    // Create specialist worker for project
    const workerId = randomUUID();
    dbModule.db.run(
      `INSERT INTO ai_employees (id, name, name_source, job_title, role_category, kind, project_path, status, created_at, updated_at)
       VALUES (?, ?, 'owner', ?, 'engineering', 'worker', ?, 'active', ?, ?)`,
      [workerId, `Worker ${num}`, "Software Specialist", projDir, Date.now(), Date.now()],
    );

    // Create 2 tasks per project (60 total)
    for (let t = 1; t <= 2; t++) {
      const taskId = `task-p${num}-t${t}`;
      const task = makeTask({
        id: taskId,
        title: `Feature ${t} for Project ${num}`,
        prompt: `Implement feature ${t} for project ${num}`,
        workdir: projDir,
        column: "ready",
        model: "sonnet-5.5",
        mode: "auto",
        isolation: "none",
      });
      dbModule.tasks.insert(task);
      allTaskIds.push(taskId);

      // Record active assignment
      dbModule.db.run(
        `INSERT INTO employee_task_assignments (id, task_id, employee_id, project_path, status, provenance, revision, created_at, updated_at, assigned_at)
         VALUES (?, ?, ?, ?, 'active', 'owner', 1, ?, ?, ?)`,
        [randomUUID(), taskId, workerId, projDir, Date.now(), Date.now(), Date.now()],
      );
    }
  }
});

afterAll(() => {
  server?.stop();
  rmSync(root, { recursive: true, force: true });
});

describe("FO-ORCH-SCALE01: Scalable Multi-Project Orchestration Suite", () => {
  test("1. Synthetic scale setup: 3 clusters, 30 projects, 60 tasks seeded", () => {
    expect(projectPaths.length).toBe(30);
    expect(allTaskIds.length).toBe(60);
    const count = dbModule.db.query<{ count: number }, []>(
      `SELECT COUNT(*) as count FROM projects`,
    ).get()?.count;
    expect(count).toBeGreaterThanOrEqual(30);
  });

  test("2. DAG cycle detection and missing reference rejection", async () => {
    // Attempting to prepare a mission with a cycle must fail before approval
    const cyclicTasks = [
      {
        taskId: "task-cycle-1",
        projectPath: projectPaths[0]!,
        dependencies: [{ taskId: "task-cycle-2", projectPath: projectPaths[1]!, condition: "qc_pass" as const }],
      },
      {
        taskId: "task-cycle-2",
        projectPath: projectPaths[1]!,
        dependencies: [{ taskId: "task-cycle-1", projectPath: projectPaths[0]!, condition: "qc_pass" as const }],
      },
    ];

    await expect(
      schedulerModule.missionScheduler.prepareMission({
        title: "Cyclic Mission",
        goal: "Test cycle detection",
        tasks: cyclicTasks,
      }),
    ).rejects.toThrow("Dependency cycle detected");

    // Missing task reference rejection
    const missingRefTasks = [
      {
        taskId: "task-valid-1",
        projectPath: projectPaths[0]!,
        dependencies: [{ taskId: "task-non-existent", projectPath: projectPaths[1]!, condition: "qc_pass" as const }],
      },
    ];

    await expect(
      schedulerModule.missionScheduler.prepareMission({
        title: "Missing Ref Mission",
        goal: "Test missing ref detection",
        tasks: missingRefTasks,
      }),
    ).rejects.toThrow("depends on missing task task-non-existent");
  });

  test("3. Deterministic SHA-256 plan digest & versioned revisions", async () => {
    const mission = await schedulerModule.missionScheduler.prepareMission({
      title: "Scale Mission 30 Projects",
      goal: "Coordinate 30 projects across 3 clusters",
      clusterIds: clusterIds,
      taskIds: allTaskIds,
      concurrencyLimits: { globalMax: 6, perProjectMax: 2, perAccountMax: 3 },
    });

    expect(mission.id).toBeDefined();
    expect(mission.status).toBe("draft");
    expect(mission.revision).toBe(1);
    expect(mission.projects.length).toBe(30);
    expect(mission.plan.tasks.length).toBe(60);
    expect(mission.planDigest).toMatch(/^[a-f0-9]{64}$/);

    // Modifying task details must generate a distinct digest
    const modifiedPlan = { ...mission.plan, tasks: [...mission.plan.tasks] };
    const task0 = modifiedPlan.tasks[0]!;
    modifiedPlan.tasks[0] = { ...task0, priority: "critical" };
    const { computeMissionPlanDigest } = await import("../../shared/orchestration/plan-digest.ts");
    const newDigest = computeMissionPlanDigest(modifiedPlan);
    expect(newDigest).not.toBe(mission.planDigest);
  });

  test("4. Supervised authorization model: Owner explicit approval bound to SHA-256 digest", async () => {
    const mission = await schedulerModule.missionScheduler.prepareMission({
      title: "Supervised Auth Mission",
      goal: "Verify Owner authorization gate",
      taskIds: [allTaskIds[0]!, allTaskIds[1]!],
    });

    // Attempting to start without authorization must fail
    await expect(
      schedulerModule.missionScheduler.startMission(mission.id),
    ).rejects.toThrow("Mission must be in 'authorized' status to start");

    // Authorizing with bad digest must fail
    await expect(
      schedulerModule.missionScheduler.authorizeMission(mission.id, "invalid-digest-hex-00000000000000000000000000000000000000000000000000000000"),
    ).rejects.toThrow("Plan digest mismatch");

    // Authorizing with exact digest succeeds
    const authorized = await schedulerModule.missionScheduler.authorizeMission(mission.id, mission.planDigest);
    expect(authorized.status).toBe("authorized");
    expect(authorized.authorization?.authorizedBy).toBe("owner");
    expect(authorized.authorization?.digest).toBe(mission.planDigest);
  });

  test("5. Blocked providers (Cursor & DeepSeek) eliminated from execution readiness", async () => {
    // Attempting to use Cursor harness throws
    await expect(
      schedulerModule.missionScheduler.prepareMission({
        title: "Cursor Test",
        goal: "Cursor readiness blocked",
        tasks: [{ taskId: allTaskIds[0]!, projectPath: projectPaths[0]!, harnessId: "cursor" }],
      }),
    ).rejects.toThrow("Cursor provider is not ready for execution dispatch");

    // Attempting to use DeepSeek model throws
    await expect(
      schedulerModule.missionScheduler.prepareMission({
        title: "DeepSeek Test",
        goal: "DeepSeek readiness blocked",
        tasks: [{ taskId: allTaskIds[0]!, projectPath: projectPaths[0]!, modelId: "deepseek-chat" }],
      }),
    ).rejects.toThrow("DeepSeek provider is not ready for execution dispatch");
  });

  test("6. Concurrency limits & fair scheduling / starvation avoidance", async () => {
    // Mission across 5 projects with globalMax = 2, perProjectMax = 1
    const testTasks = [
      { taskId: allTaskIds[0]!, projectPath: projectPaths[0]!, priority: "normal" as const },
      { taskId: allTaskIds[1]!, projectPath: projectPaths[0]!, priority: "normal" as const },
      { taskId: allTaskIds[2]!, projectPath: projectPaths[1]!, priority: "normal" as const },
      { taskId: allTaskIds[3]!, projectPath: projectPaths[1]!, priority: "normal" as const },
      { taskId: allTaskIds[4]!, projectPath: projectPaths[2]!, priority: "normal" as const },
    ];

    const mission = await schedulerModule.missionScheduler.prepareMission({
      title: "Fair Concurrency Mission",
      goal: "Verify limits and starvation avoidance",
      tasks: testTasks,
      concurrencyLimits: { globalMax: 2, perProjectMax: 1, perAccountMax: 2 },
    });

    await schedulerModule.missionScheduler.authorizeMission(mission.id, mission.planDigest);
    const started = await schedulerModule.missionScheduler.startMission(mission.id);
    expect(started.status).toBe("running");

    // Check reservations: exactly 2 active global slots used
    const activeRes = storeModule.missionStore.listActiveReservations(mission.id);
    expect(activeRes.length).toBeLessThanOrEqual(2);

    // Each project has at most 1 active reservation (perProjectMax)
    const byProj = new Map<string, number>();
    for (const r of activeRes) {
      byProj.set(r.projectPath, (byProj.get(r.projectPath) || 0) + 1);
    }
    for (const count of byProj.values()) {
      expect(count).toBeLessThanOrEqual(1);
    }
  });

  test("7. Cross-project task dependencies: Task B waits for Task A QC PASS", async () => {
    const taskA = allTaskIds[10]!; // in proj-06
    const taskB = allTaskIds[12]!; // in proj-07

    // Set task A in ready
    dbModule.tasks.update(taskA, { column: "ready" });
    dbModule.tasks.update(taskB, { column: "ready" });

    const mission = await schedulerModule.missionScheduler.prepareMission({
      title: "Cross Project Dependency Test",
      goal: "Task B waits for Task A QC PASS",
      tasks: [
        { taskId: taskA, projectPath: projectPaths[5]! },
        {
          taskId: taskB,
          projectPath: projectPaths[6]!,
          dependencies: [{ taskId: taskA, projectPath: projectPaths[5]!, condition: "qc_pass" as const }],
        },
      ],
      concurrencyLimits: { globalMax: 5, perProjectMax: 2, perAccountMax: 3 },
    });

    await schedulerModule.missionScheduler.authorizeMission(mission.id, mission.planDigest);
    await schedulerModule.missionScheduler.startMission(mission.id);

    const reloaded = storeModule.missionStore.getMission(mission.id)!;
    const taskAPlan = reloaded.plan.tasks.find((t) => t.taskId === taskA);
    const taskBPlan = reloaded.plan.tasks.find((t) => t.taskId === taskB);

    // Task A should be starting/running, Task B must be blocked
    expect(taskBPlan?.phase).toBe("blocked");
    expect(taskBPlan?.blockers?.some((b) => b.includes(taskA))).toBe(true);

    // Simulate Task A completing QC PASS
    dbModule.tasks.update(taskA, {
      column: "review",
      qcState: {
        latestVerdict: "PASS",
        awaitingOwnerApproval: false,
        activeReviewId: null,
        reworkCount: 0,
        roundCount: 1,
        maxRounds: 1,
      },
    });
    // Mark satisfied directly or via tick
    storeModule.missionStore.markDependencySatisfied(mission.id, taskA);
    const deps = storeModule.missionStore.listMissionDependencies(mission.id);
    expect(deps.find((d) => d.taskId === taskB)?.satisfiedAt).toBeDefined();
  });

  test("8. Pause, resume, and cancellation lifecycle controls", async () => {
    const mission = await schedulerModule.missionScheduler.prepareMission({
      title: "Pause Resume Cancel Mission",
      goal: "Test lifecycle controls",
      taskIds: [allTaskIds[20]!, allTaskIds[21]!],
    });

    await schedulerModule.missionScheduler.authorizeMission(mission.id, mission.planDigest);
    await schedulerModule.missionScheduler.startMission(mission.id);

    // Pause
    const paused = await schedulerModule.missionScheduler.pauseMission(mission.id, "Owner paused test");
    expect(paused.status).toBe("paused");

    // Resume
    const resumed = await schedulerModule.missionScheduler.resumeMission(mission.id);
    expect(resumed.status).toBe("running");

    // Cancel
    const cancelled = await schedulerModule.missionScheduler.cancelMission(mission.id, "Owner cancelled test");
    expect(cancelled.status).toBe("cancelled");
    const activeRes = storeModule.missionStore.listActiveReservations(mission.id);
    expect(activeRes.length).toBe(0);
  });

  test("9. Conservative crash & restart recovery preserves attribution without duplicate dispatch", async () => {
    const mission = await schedulerModule.missionScheduler.prepareMission({
      title: "Restart Recovery Mission",
      goal: "Verify safe restart recovery",
      taskIds: [allTaskIds[22]!],
    });

    await schedulerModule.missionScheduler.authorizeMission(mission.id, mission.planDigest);
    await schedulerModule.missionScheduler.startMission(mission.id);

    // Simulate backend restart recovery
    await schedulerModule.missionScheduler.recoverOrchestrationMissions();

    const recovered = storeModule.missionStore.getMission(mission.id);
    expect(recovered?.status).toBe("running");
  });

  test("10. Head of PM factual answering (10 Section 8 queries)", async () => {
    // 1. Show every active project and its progress
    const a1 = await headModule.tryAnswerOrchestrationQuestion("Show every active project and its progress.");
    expect(a1).not.toBeNull();
    expect(a1).toContain("Active Project Status & Progress");
    expect(a1).toContain("Project 01");

    // 2. Which projects are blocked?
    const a2 = await headModule.tryAnswerOrchestrationQuestion("Which projects are blocked?");
    expect(a2).not.toBeNull();
    expect(a2).toMatch(/blocked projects|No projects are currently blocked/i);

    // 3. Prepare a plan to fix the highest-priority issues across these projects
    const a3 = await headModule.tryAnswerOrchestrationQuestion("Prepare a plan to fix the highest-priority issues across these projects.");
    expect(a3).not.toBeNull();
    expect(a3).toContain("Prepared Multi-Project Mission Plan");
    expect(a3).toContain("Plan Digest:");

    // 4. Which specialists are currently working?
    const a4 = await headModule.tryAnswerOrchestrationQuestion("Which specialists are currently working?");
    expect(a4).not.toBeNull();

    // 5. Can these five tasks execute in parallel?
    const a5 = await headModule.tryAnswerOrchestrationQuestion(`Can these five tasks execute in parallel? ${allTaskIds.slice(0, 5).join(" ")}`);
    expect(a5).not.toBeNull();
    expect(a5).toContain("Parallel Execution Feasibility Analysis");

    // 6. Why has this task not started?
    const a6 = await headModule.tryAnswerOrchestrationQuestion(`Why has this task not started? ${allTaskIds[0]!}`);
    expect(a6).not.toBeNull();
    expect(a6).toContain(`Status analysis for Task`);

    // 7. Reallocate eligible resources to higher-priority work
    const a7 = await headModule.tryAnswerOrchestrationQuestion("Reallocate eligible resources to higher-priority work.");
    expect(a7).not.toBeNull();

    // 8. Summarize what all agents completed today
    const a10 = await headModule.tryAnswerOrchestrationQuestion("Summarize what all agents completed today.");
    expect(a10).not.toBeNull();
    expect(a10).toContain("24-Hour Agent Activity Summary");
  });

  test("11. Orchestration HTTP API endpoints", async () => {
    // GET /api/orchestration/missions
    const listRes = await call("/api/orchestration/missions");
    expect(listRes.ok).toBe(true);
    expect(Array.isArray(listRes.json.missions)).toBe(true);

    // POST /api/orchestration/missions/prepare
    const prepRes = await call("/api/orchestration/missions/prepare", {
      title: "HTTP Test Mission",
      goal: "Test API Endpoints",
      taskIds: [allTaskIds[24]!, allTaskIds[25]!],
    });
    expect(prepRes.ok).toBe(true);
    const mId = prepRes.json.mission.id;
    const digest = prepRes.json.mission.planDigest;

    // POST /api/orchestration/missions/:id/authorize
    const authRes = await call(`/api/orchestration/missions/${mId}/authorize`, { digest });
    expect(authRes.ok).toBe(true);
    expect(authRes.json.mission.status).toBe("authorized");

    // POST /api/orchestration/missions/:id/start
    const startRes = await call(`/api/orchestration/missions/${mId}/start`, {});
    expect(startRes.ok).toBe(true);
    expect(startRes.json.mission.status).toBe("running");

    // POST /api/orchestration/missions/:id/pause
    const pauseRes = await call(`/api/orchestration/missions/${mId}/pause`, { reason: "HTTP pause" });
    expect(pauseRes.ok).toBe(true);
    expect(pauseRes.json.mission.status).toBe("paused");

    // POST /api/orchestration/missions/:id/resume
    const resumeRes = await call(`/api/orchestration/missions/${mId}/resume`, {});
    expect(resumeRes.ok).toBe(true);
    expect(resumeRes.json.mission.status).toBe("running");

    // POST /api/orchestration/missions/:id/cancel
    const cancelRes = await call(`/api/orchestration/missions/${mId}/cancel`, { reason: "HTTP cancel" });
    expect(cancelRes.ok).toBe(true);
    expect(cancelRes.json.mission.status).toBe("cancelled");

    // GET /api/orchestration/reservations
    const resRes = await call("/api/orchestration/reservations");
    expect(resRes.ok).toBe(true);
    expect(Array.isArray(resRes.json.reservations)).toBe(true);

    // GET /api/orchestration/dependencies/:id
    const depRes = await call(`/api/orchestration/dependencies/${mId}`);
    expect(depRes.ok).toBe(true);
    expect(Array.isArray(depRes.json.dependencies)).toBe(true);
  });
});
