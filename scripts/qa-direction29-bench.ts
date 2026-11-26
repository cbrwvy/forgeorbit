#!/usr/bin/env bun
/**
 * Direction 29 reproducible headless benchmark, contention, and interruption
 * harness. Strictly isolated in a throwaway temp root; uses fake drivers only.
 * Never opens ~/Library/Application Support/ForgeOrbit, ~/.agetor, or real
 * provider homes.
 *
 * Subcommands:
 *   seed-large <root>          Create the larger disposable profile (40 projects, 400 tasks, ~12.5k events)
 *   seed-scale <root>          Create the 30-project / 60-task orchestration scale profile
 *   run --phase <name>         Run the full baseline or post-fix benchmark suite and write JSON evidence
 */
import assert from "node:assert/strict";
import { Database } from "bun:sqlite";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { writeCodexProfileFixture, writeSyntheticCodexProfile } from "../e2e/codex-profile-fixture.ts";
import { computeMissionPlanDigest } from "../src/shared/orchestration/plan-digest.ts";
import type { MissionPlan } from "../src/shared/orchestration/types.ts";
import { RUN_USAGE_STATUS_PREFIX } from "../src/shared/usage-analytics.ts";

const REPO_ROOT = path.resolve(import.meta.dir, "..");
const DAY_MS = 86_400_000;

interface LatencySummary {
  samplesMs: number[];
  minMs: number;
  medianMs: number;
  p95Ms: number;
  maxMs: number;
  meanMs: number;
  bytes?: number;
}

interface ProcessSample {
  pid: number;
  ppid: number;
  command: string;
  rssKb: number;
  cpuPercent: number;
}

function summarize(samplesMs: number[], bytes?: number): LatencySummary {
  const sorted = [...samplesMs].sort((a, b) => a - b);
  const n = sorted.length;
  const medianMs =
    n === 0
      ? 0
      : n % 2 === 1
        ? sorted[(n - 1) >> 1]!
        : (sorted[n / 2 - 1]! + sorted[n / 2]!) / 2;
  const p95Idx = Math.min(n - 1, Math.floor(0.95 * (n - 1)));
  const sum = sorted.reduce((acc, v) => acc + v, 0);
  return {
    samplesMs: sorted.map((v) => Number(v.toFixed(2))),
    minMs: Number((sorted[0] ?? 0).toFixed(2)),
    medianMs: Number(medianMs.toFixed(2)),
    p95Ms: Number((sorted[p95Idx] ?? 0).toFixed(2)),
    maxMs: Number((sorted[n - 1] ?? 0).toFixed(2)),
    meanMs: Number((n ? sum / n : 0).toFixed(2)),
    ...(bytes !== undefined ? { bytes } : {}),
  };
}

function freePort(): number {
  const probe = Bun.listen({ hostname: "127.0.0.1", port: 0, socket: { data() {} } });
  const { port } = probe;
  probe.stop();
  return port;
}

function dirFileBytes(filePath: string): number {
  try {
    return statSync(filePath).size;
  } catch {
    return 0;
  }
}

function sqliteBytes(dataDir: string): { sqliteBytes: number; walBytes: number; shmBytes: number; totalBytes: number } {
  const sqlite = dirFileBytes(path.join(dataDir, "agetor.sqlite"));
  const wal = dirFileBytes(path.join(dataDir, "agetor.sqlite-wal"));
  const shm = dirFileBytes(path.join(dataDir, "agetor.sqlite-shm"));
  return { sqliteBytes: sqlite, walBytes: wal, shmBytes: shm, totalBytes: sqlite + wal + shm };
}

function isolatedEnv(root: string, extra: Record<string, string> = {}): NodeJS.ProcessEnv {
  const home = path.join(root, "home");
  const data = path.join(root, "data");
  const downloads = path.join(root, "downloads");
  mkdirSync(home, { recursive: true });
  mkdirSync(data, { recursive: true });
  mkdirSync(downloads, { recursive: true });
  return {
    ...process.env,
    HOME: home,
    FORGEORBIT_DATA_DIR: data,
    AGETOR_DATA_DIR: data,
    AGETOR_DOWNLOADS_DIR: downloads,
    AGETOR_CODEX_DRIVER: "fake",
    AGETOR_CLAUDE_DRIVER: "fake",
    AGETOR_CURSOR_DRIVER: "fake",
    AGETOR_GEMINI_DRIVER: "fake",
    AGETOR_FX_DRIVER: "fake",
    AGETOR_ANTIGRAVITY_DRIVER: "fake",
    AGETOR_USAGE_OFFLINE: "1",
    AGETOR_DISABLE_UPDATES: "1",
    AGETOR_SKIP_CLI_VERSION_FLOOR: "1",
    ...extra,
  };
}

function psForPids(pids: number[]): ProcessSample[] {
  if (pids.length === 0) return [];
  const res = spawnSync("/bin/ps", ["-o", "pid=,ppid=,rss=,%cpu=,comm=", "-p", pids.join(",")], {
    encoding: "utf8",
  });
  const rows: ProcessSample[] = [];
  for (const line of (res.stdout ?? "").split("\n")) {
    const m = line.trim().match(/^(\d+)\s+(\d+)\s+(\d+)\s+([0-9.]+)\s+(.+)$/);
    if (!m) continue;
    rows.push({
      pid: Number(m[1]),
      ppid: Number(m[2]),
      rssKb: Number(m[3]),
      cpuPercent: Number(m[4]),
      command: m[5]!.trim(),
    });
  }
  return rows;
}

function sampleChildrenTree(rootPid: number): ProcessSample[] {
  const res = spawnSync("/bin/ps", ["-axo", "pid=,ppid=,rss=,%cpu=,comm="], { encoding: "utf8" });
  const all: ProcessSample[] = [];
  for (const line of (res.stdout ?? "").split("\n")) {
    const m = line.trim().match(/^(\d+)\s+(\d+)\s+(\d+)\s+([0-9.]+)\s+(.+)$/);
    if (!m) continue;
    all.push({
      pid: Number(m[1]),
      ppid: Number(m[2]),
      rssKb: Number(m[3]),
      cpuPercent: Number(m[4]),
      command: m[5]!.trim(),
    });
  }
  const keep = new Set<number>([rootPid]);
  let added = true;
  while (added) {
    added = false;
    for (const row of all) {
      if (keep.has(row.ppid) && !keep.has(row.pid)) {
        keep.add(row.pid);
        added = true;
      }
    }
  }
  return all.filter((row) => keep.has(row.pid));
}

function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
}

async function waitPidExit(pid: number, timeoutMs = 10_000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!isPidAlive(pid)) return true;
    await Bun.sleep(50);
  }
  return !isPidAlive(pid);
}

/* ────────────────────────────────────────────────────────────────────────── *
 * Subcommand: seed-large <root>
 * ────────────────────────────────────────────────────────────────────────── */
async function seedLargeProfile(root: string) {
  const { db, projects, runs } = await import("../src/bun/db.ts");
  const { AccountCore } = await import("../src/bun/account-core.ts");
  const { CodexProfiles } = await import("../src/bun/codex-profiles.ts");
  const { writeSyntheticCodexProfile: writeSyn } = await import("../e2e/codex-profile-fixture.ts");

  const core = new AccountCore(db);
  const profiles = new CodexProfiles(core);
  const accDirs = ["Alpha", "Beta", "Gamma"].map((n) => path.join(root, "home", `codex-${n.toLowerCase()}`));
  const accs = accDirs.map((dir, i) => {
    writeSyn(dir, `bench-subject-${i}`);
    return profiles.register({ displayName: `Bench Codex ${i + 1}`, directory: dir });
  });

  const now = Date.now();
  const projectPaths: string[] = [];
  for (let i = 0; i < 40; i++) {
    const dir = path.join(root, "projects", `project-${String(i + 1).padStart(2, "0")}`);
    mkdirSync(dir, { recursive: true });
    writeFileSync(path.join(dir, "README.md"), `# Project ${i + 1}\n`);
    projects.upsert(dir, `Project ${String(i + 1).padStart(2, "0")}`);
    projectPaths.push(dir);
  }

  // Pricing revisions for analytics
  for (const acc of accs) {
    db.run(
      "INSERT INTO usage_pricing(harness_id,account_id,model_id,created_at,terms) VALUES ('codex',?,?,?,?)",
      [
        acc.accountId,
        "gpt-6.1-sol",
        now - 90 * DAY_MS,
        JSON.stringify({ billing: "api", currency: "USD", inputPerMillion: 2, outputPerMillion: 8, cacheReadPerMillion: 1, cacheWritePerMillion: 0 }),
      ],
    );
  }

  let largeTaskId = "";
  let largeRunId = "";
  let firstProjectPath = projectPaths[0]!;
  let subagentTaskId = "";

  const insertTask = db.prepare(`
    INSERT INTO tasks(id,title,prompt,"column",agent,workdir,model,mode,isolation,created_at,updated_at,archived_at,todo_progress)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)
  `);
  const insertEvent = db.prepare(`INSERT INTO run_events(run_id,stream,data,ts) VALUES (?,?,?,?)`);

  db.transaction(() => {
    // 400 tasks across 40 projects (10 per project):
    //  0..1 ready, 2..3 review, 4..5 done (with usage), 6..7 queued/backlog, 8..9 archived (45 days old, with 4x20KB tool_result)
    for (let i = 0; i < 400; i++) {
      const pIdx = i % 40;
      const workdir = projectPaths[pIdx]!;
      const taskId = randomUUID();
      const slot = Math.floor(i / 40);
      let column: string;
      let archivedAt: number | null = null;
      if (i === 0) column = "review";
      else if (slot < 2) column = "ready";
      else if (slot < 4) column = "review";
      else if (slot < 6) column = "done";
      else if (slot < 8) column = "backlog";
      else {
        column = "done";
        archivedAt = now - 45 * DAY_MS;
      }

      const createdAt = archivedAt ? archivedAt - 3_600_000 : now - (400 - i) * 60_000;
      const updatedAt = archivedAt ?? now - (400 - i) * 30_000;
      insertTask.run(
        taskId,
        `Bench task ${String(i + 1).padStart(3, "0")} [P${pIdx + 1}]`,
        `Execute work item ${i + 1} for project ${pIdx + 1}. Acceptance criteria: verify behavior.`,
        column,
        "codex",
        workdir,
        "gpt-6.1-sol",
        "auto",
        "none",
        createdAt,
        updatedAt,
        archivedAt,
        null,
      );

      // Runs & analytics for non-backlog tasks (~320 tasks * 2-3 runs ~= 850 runs)
      if (column === "review" || column === "done") {
        const runCount = i === 0 ? 1 : i % 3 === 0 ? 3 : 2;
        for (let r = 0; r < runCount; r++) {
          const rid = randomUUID();
          const acc = accs[(i + r) % accs.length]!;
          const startedAt = createdAt + r * 30_000 + 1_000;
          const endedAt = startedAt + 8_500 + (i % 7) * 500;
          runs.insert({
            id: rid,
            taskId,
            agent: acc.harnessId,
            status: r < runCount - 1 && runCount === 3 ? "failed" : "succeeded",
            startedAt,
            endedAt,
            exitCode: 0,
            tmuxSession: null,
            claudeSessionId: null,
            codexSessionId: rid,
            cursorSessionId: null,
            geminiSessionId: null,
            fxSessionId: null,
          });
          db.run(`UPDATE runs SET usage_scope = ? WHERE id = ?`, [
            JSON.stringify({ projectPath: workdir, clusterId: null, missionId: null, category: "task" }),
            rid,
          ]);
          insertEvent.run(
            rid,
            "status",
            JSON.stringify({
              kind: "execution-identity",
              executionType: "real-provider",
              provider: "codex",
              model: "gpt-6.1-sol",
              mode: "auto",
              accountProfile: { id: acc.accountId },
            }),
            endedAt,
          );
          insertEvent.run(
            rid,
            "status",
            RUN_USAGE_STATUS_PREFIX +
              JSON.stringify({
                input: 45_000 + (i % 10) * 5_000,
                output: 12_000 + (i % 5) * 2_000,
                cacheRead: 10_000,
                cacheWrite: 0,
              }),
            endedAt,
          );

          if (i === 0 && r === 0) {
            largeTaskId = taskId;
            largeRunId = rid;
          } else if (archivedAt !== null && r === 0) {
            // 2 archived tasks per project = 80 tasks, first 40 get 4x 20 KB tool_result rows = 160 rows (~3.2 MB)
            if (pIdx < 20) {
              const payload = JSON.stringify({
                type: "tool_result",
                tool_use_id: `tu_${i}`,
                content: "X".repeat(20_480),
              });
              for (let k = 0; k < 4; k++) {
                insertEvent.run(rid, "stdout", payload, endedAt - 500 + k);
              }
            }
          } else if (i > 0) {
            // 18 regular events on other tasks (~6,000 events)
            for (let k = 0; k < 8; k++) {
              insertEvent.run(rid, k === 0 ? "user" : "stdout", k === 0 ? `Prompt for task ${i + 1}` : `Output chunk ${k} for run ${rid}`, startedAt + k * 200);
            }
          }
        }
        // Estimate seeding deferred below via ensureBaselineEstimate()
      }
      if (i === 1) subagentTaskId = taskId;
    }

    // Seed 5,000 events on largeTaskId (first user event + 4,999 assistant/tool chunks)
    insertEvent.run(largeRunId, "user", "LARGE_HISTORY_PROMPT_ANCHOR: inspect 5,000 messages across runs", now - 2_000_000);
    for (let e = 1; e < 5000; e++) {
      insertEvent.run(
        largeRunId,
        e % 10 === 0 ? "tool_result" : "stdout",
        JSON.stringify({
          type: e % 10 === 0 ? "tool_result" : "assistant",
          seq: e,
          text: `Large history chunk #${e}/4999 — repeatable deterministic benchmark log line payload padding for Direction 29.`,
        }),
        now - 2_000_000 + e * 100,
      );
    }

    // Seed 60 subagents on subagentTaskId
    for (let s = 0; s < 60; s++) {
      db.run(
        `INSERT INTO subagents(id,task_id,run_id,tool_use_id,agent_type,description,source_path,status,started_at,ended_at)
         VALUES (?,?,?,?,?,?,?,'completed',?,?)`,
        [
          randomUUID(),
          subagentTaskId,
          null,
          `tu_sub_${s}`,
          "worker",
          "Subagent worker step",
          path.join(root, "home", `agent-${s}.jsonl`),
          now - 60_000 + s * 100,
          now - 55_000 + s * 100,
        ],
      );
    }
  })();

  const { ensureBaselineEstimate } = await import("../src/bun/usage-analytics/forecast.ts");
  const sampleTasks = db
    .query<{ id: string }, []>(`SELECT id FROM tasks WHERE archived_at IS NULL ORDER BY updated_at DESC LIMIT 80`)
    .all();
  for (const row of sampleTasks) ensureBaselineEstimate(row.id, now);

  const counts = {
    projects: db.query<{ n: number }, []>("SELECT COUNT(*) AS n FROM projects").get()!.n,
    tasks: db.query<{ n: number }, []>("SELECT COUNT(*) AS n FROM tasks").get()!.n,
    archivedTasks: db.query<{ n: number }, []>("SELECT COUNT(*) AS n FROM tasks WHERE archived_at IS NOT NULL").get()!.n,
    runs: db.query<{ n: number }, []>("SELECT COUNT(*) AS n FROM runs").get()!.n,
    runEvents: db.query<{ n: number }, []>("SELECT COUNT(*) AS n FROM run_events").get()!.n,
    subagents: db.query<{ n: number }, []>("SELECT COUNT(*) AS n FROM subagents").get()!.n,
  };
  writeFileSync(
    path.join(root, "seed-meta.json"),
    JSON.stringify({ largeTaskId, largeRunId, subagentTaskId, firstProjectPath, projectPaths, counts }, null, 2),
  );
  db.close();
}

/* ────────────────────────────────────────────────────────────────────────── *
 * Subcommand: scale-contention <root> (in-process 30-project / 60-task
 * reused scale profile with delayed runs + polling during sustained run)
 * ────────────────────────────────────────────────────────────────────────── */
async function runScaleContention(root: string) {
  const { db, harnesses, projects, runs, tasks } = await import("../src/bun/db.ts");
  const { AccountCore } = await import("../src/bun/account-core.ts");
  const { CodexProfiles } = await import("../src/bun/codex-profiles.ts");
  const { EmployeeCore } = await import("../src/bun/employee-core.ts");
  const { AssignmentCore } = await import("../src/bun/assignment-core.ts");
  const { initEmployeeExecutionTracking } = await import("../src/bun/employee-run.ts");
  const { missionStore } = await import("../src/bun/orchestration/mission-store.ts");
  const { missionScheduler } = await import("../src/bun/orchestration/mission-scheduler.ts");
  const { stopProjectLifecycle, startProjectLifecycle, getProjectLifecycle } = await import("../src/bun/project-lifecycle.ts");
  const { startApiServer, API_TOKEN } = await import("../src/bun/server.ts");
  const { createAutonomyPolicy, activateAutonomyPolicy } = await import("../src/bun/autonomy/policy-engine.ts");
  const { autonomyPolicyStore } = await import("../src/bun/autonomy/policy-store.ts");
  const { writeCodexProfileFixture: writeBin, writeSyntheticCodexProfile: writeSyn } = await import("../e2e/codex-profile-fixture.ts");

  initEmployeeExecutionTracking();
  harnesses.setEnabled("codex", true);
  process.env.AGETOR_CODEX_BIN = writeBin(root, process.execPath);
  const core = new AccountCore(db);
  const profiles = new CodexProfiles(core);
  const employees = new EmployeeCore(db);
  const assignments = new AssignmentCore(db);
  const accounts = ["A", "B"].map((k) => {
    const dir = path.join(root, "home", `scale-${k}`);
    writeSyn(dir, `scale-${k}`);
    return profiles.register({ displayName: `Scale ${k}`, directory: dir });
  });

  const server = startApiServer() as unknown as { stop: () => void };
  const apiPort = Number(process.env.AGETOR_API_PORT);
  const apiBase = `http://127.0.0.1:${apiPort}`;
  const auth = { authorization: `Bearer ${API_TOKEN}` };

  // Mirror orchestration-scale.suite.ts: 30 projects, 60 tasks (2 per project: T1 -> T2 dependency)
  const scaleProjects: Array<{ path: string; tasks: string[] }> = [];
  for (let i = 0; i < 30; i++) {
    const dir = path.join(root, "scale-projects", `p-${i + 1}`);
    mkdirSync(dir, { recursive: true });
    writeFileSync(path.join(dir, "README.md"), `# Scale ${i + 1}\n`);
    projects.upsert(dir, `Scale ${String(i + 1).padStart(2, "0")}`);
    const worker = employees.createWorker({ name: `Worker ${i + 1}`, jobTitle: "Developer", projectPath: dir });
    const t1 = randomUUID();
    const t2 = randomUUID();
    const now = Date.now();
    db.run(
      `INSERT INTO tasks(id,title,prompt,"column",agent,workdir,model,mode,isolation,created_at,updated_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
      [t1, `P${i + 1}-T1`, "Complete task 1", "ready", accounts[i % 2]!.harnessId, dir, "gpt-6.1-sol", "auto", "none", now, now],
    );
    db.run(
      `INSERT INTO tasks(id,title,prompt,"column",agent,workdir,model,mode,isolation,created_at,updated_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
      [t2, `P${i + 1}-T2`, "Complete task 2", "ready", accounts[i % 2]!.harnessId, dir, "gpt-6.1-sol", "auto", "none", now, now],
    );
    assignments.assign(t1, worker.id);
    assignments.assign(t2, worker.id);
    scaleProjects.push({ path: dir, tasks: [t1, t2] });
  }

  const plan: MissionPlan = {
    clusters: [],
    projects: scaleProjects.map((p) => p.path),
    concurrencyLimits: { globalMax: 4, perProjectMax: 1, perAccountMax: 4 },
    executionPolicy: { qcRequired: false, autoResumeOnQcPass: false, maxRetriesPerTask: 0 },
    tasks: scaleProjects.flatMap((p, idx) => [
      {
        taskId: p.tasks[0]!,
        taskTitle: `P${idx + 1}-T1`,
        projectPath: p.path,
        specialistRole: "developer",
        phase: "authorized",
        priority: "normal",
        dependencies: [],
        harnessId: accounts[idx % 2]!.harnessId,
        modelId: "gpt-6.1-sol",
        accountId: accounts[idx % 2]!.accountId,
        mode: "auto",
        qcRequired: false,
      },
      {
        taskId: p.tasks[1]!,
        taskTitle: `P${idx + 1}-T2`,
        projectPath: p.path,
        specialistRole: "developer",
        phase: "authorized",
        priority: "normal",
        dependencies: [{ taskId: p.tasks[0]!, projectPath: p.path, condition: "qc_pass" }],
        harnessId: accounts[idx % 2]!.harnessId,
        modelId: "gpt-6.1-sol",
        accountId: accounts[idx % 2]!.accountId,
        mode: "auto",
        qcRequired: false,
      },
    ]),
  };
  const digest = computeMissionPlanDigest(plan);
  const policy = createAutonomyPolicy({
    mode: "full-autonomy",
    scopeKind: "workspace",
    scopeRef: "workspace",
    projects: scaleProjects.map((p) => p.path),
    specialistRoles: ["developer"],
    providers: ["codex"],
    models: ["gpt-6.1-sol"],
    accounts: accounts.map((a) => a.accountId),
    maxConcurrentWorkers: 4,
    maxLaunches: 80,
    maxDurationMs: 300_000,
    expiresAt: Date.now() + 300_000,
    permittedActions: ["plan_task", "launch_task"],
    qc: { required: false },
    completion: { autoComplete: false },
  });
  const activation = activateAutonomyPolicy(policy.id);
  const mission = missionStore.createMission({
    title: "Direction 29 30-project / 60-task contention run",
    goal: "Sustained scale contention check",
    status: "authorized",
    projects: plan.projects,
    clusters: [],
    plan,
    planDigest: digest,
  });
  missionStore.updateMissionAuthorization(mission.id, {
    authorizedAt: Date.now(),
    authorizedBy: "owner",
    digest: mission.planDigest,
  });
  autonomyPolicyStore.upsertBinding({
    missionId: mission.id,
    policyId: policy.id,
    revision: policy.revision,
    activationId: activation.id,
    digest: policy.digest,
    mode: "full-autonomy",
    outcome: "active",
    summary: null,
    emergencyTaskIds: [],
  });
  missionStore.updateMissionStatus(mission.id, "running", "d29 scale bench start");

  // Event-loop 5ms lag sampler during the sustained run
  let maxGapMs = 0;
  let lastTick = performance.now();
  const gapSamples: number[] = [];
  const sampler = setInterval(() => {
    const now = performance.now();
    const gap = Math.max(0, now - lastTick - 5);
    lastTick = now;
    gapSamples.push(gap);
    if (gap > maxGapMs) maxGapMs = gap;
  }, 5);

  const projLatencies: number[] = [];
  const taskLatencies: number[] = [];
  const healthLatencies: number[] = [];
  const tickLatencies: number[] = [];
  let maxObservedRunning = 0;
  const stoppedProjectIndex = 29;
  let stoppedOnce = false;

  const tStart = performance.now();
  let inFlightTick: Promise<void> | null = null;
  const kickTick = () => {
    if (inFlightTick) return;
    const tTick = performance.now();
    inFlightTick = missionScheduler
      .tickAllRunningMissions()
      .then(() => {
        tickLatencies.push(performance.now() - tTick);
      })
      .catch(() => {})
      .finally(() => {
        inFlightTick = null;
      });
  };
  try {
    const deadline = Date.now() + 180_000;
    while (Date.now() < deadline) {
      kickTick();

      const tp = performance.now();
      const pRes = await fetch(`${apiBase}/projects`, { headers: auth });
      assert.equal(pRes.status, 200);
      await pRes.arrayBuffer();
      projLatencies.push(performance.now() - tp);

      const tt = performance.now();
      const tRes = await fetch(`${apiBase}/tasks`, { headers: auth });
      assert.equal(tRes.status, 200);
      const tJson = (await tRes.json()) as { tasks?: Array<{ column: string; id: string }> } | Array<{ column: string; id: string }>;
      taskLatencies.push(performance.now() - tt);

      const th = performance.now();
      const hRes = await fetch(`${apiBase}/health`);
      assert.equal(hRes.status, 200);
      await hRes.arrayBuffer();
      healthLatencies.push(performance.now() - th);

      const list = Array.isArray(tJson) ? tJson : tJson.tasks ?? [];
      const runningCount = list.filter((x) => x.column === "running").length;
      if (runningCount > maxObservedRunning) maxObservedRunning = runningCount;

      // Stop project 30 once runs start to verify Project Stop under contention
      if (!stoppedOnce && maxObservedRunning > 0) {
        stoppedOnce = true;
        await stopProjectLifecycle(scaleProjects[stoppedProjectIndex]!.path, { reason: "d29 bench stop" });
      }

      const settledCount = scaleProjects
        .slice(0, stoppedProjectIndex)
        .flatMap((p) => p.tasks)
        .filter((id) => {
          const t = tasks.get(id);
          return t && (t.column === "review" || t.column === "done");
        }).length;
      if (settledCount >= 58) break;
      await Bun.sleep(150);
    }
    if (inFlightTick) await inFlightTick;

    // Verify Project Stop held on stopped project, dependency ordering, and zero duplicate runs per task!
    const stoppedProj = scaleProjects[stoppedProjectIndex]!;
    const stoppedLifecycle = getProjectLifecycle(stoppedProj.path);
    let duplicateTasks = 0;
    let dependencyViolations = 0;
    let lostTasks = 0;
    for (const p of scaleProjects.slice(0, stoppedProjectIndex)) {
      const r1 = runs.listForTask(p.tasks[0]!);
      const r2 = runs.listForTask(p.tasks[1]!);
      if (r1.length > 1 || r2.length > 1) duplicateTasks++;
      if (r1.length === 0 || r2.length === 0) lostTasks++;
      if (r1[0]?.endedAt && r2[0]?.startedAt && r2[0].startedAt < r1[0].startedAt) {
        dependencyViolations++;
      }
    }
    await startProjectLifecycle(stoppedProj.path);
    const psSelf = psForPids([process.pid])[0] ?? null;

    const wallMs = performance.now() - tStart;
    const out = {
      dataset: { projects: 30, tasks: 60, maxConcurrentRuns: 4, codexDelayMs: Number(process.env.AGETOR_FAKE_CODEX_RESOLVE_DELAY_MS ?? 0) },
      wallMs: Number(wallMs.toFixed(1)),
      maxObservedConcurrentRunning: maxObservedRunning,
      duplicateDispatchTasks: duplicateTasks,
      dependencyViolations,
      lostActiveProjectTasks: lostTasks,
      stoppedProjectStateBeforeResume: stoppedLifecycle?.state ?? null,
      pollRequestsCount: projLatencies.length,
      schedulerTickMs: summarize(tickLatencies),
      getProjectsDuringRunMs: summarize(projLatencies),
      getTasksDuringRunMs: summarize(taskLatencies),
      getHealthDuringRunMs: summarize(healthLatencies),
      maxEventLoopGapMs: Number(maxGapMs.toFixed(2)),
      gapsOver50ms: gapSamples.filter((g) => g > 50).length,
      gapsOver250ms: gapSamples.filter((g) => g > 250).length,
      processSample: psSelf,
    };
    writeFileSync(path.join(root, "scale-result.json"), JSON.stringify(out, null, 2));
  } finally {
    clearInterval(sampler);
    server.stop(true);
    db.close();
  }
}

/* ────────────────────────────────────────────────────────────────────────── *
 * Headless spawn helper for cold/warm boot + endpoint & recovery measurement
 * ────────────────────────────────────────────────────────────────────────── */
interface BootedCore {
  proc: ChildProcess;
  pid: number;
  apiBase: string;
  token: string;
  bootMs: number;
  daemonLog: string;
  stopClean: () => Promise<{ cleanExit: boolean; exitCode: number | null; strayPids: number[] }>;
}

async function bootHeadlessCore(root: string, extraEnv: Record<string, string> = {}): Promise<BootedCore> {
  const port = freePort();
  const dataDir = path.join(root, "data");
  const credsPath = path.join(dataDir, "agetor-core.json");
  try { rmSync(credsPath, { force: true }); } catch {}

  const env = isolatedEnv(root, { AGETOR_API_PORT: String(port), ...extraEnv });
  const t0 = performance.now();
  const proc = spawn(process.execPath, [path.join(REPO_ROOT, "src/bun/headless.ts")], {
    cwd: REPO_ROOT,
    env,
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stderr = "";
  proc.stderr?.on("data", (d) => (stderr += d.toString()));

  const deadline = Date.now() + 30_000;
  let token = "";
  while (Date.now() < deadline) {
    if (proc.exitCode !== null) {
      throw new Error(`headless exited early (${proc.exitCode}): ${stderr}`);
    }
    try {
      const creds = JSON.parse(readFileSync(credsPath, "utf8")) as { port: number; token: string };
      if (creds.port === port && creds.token) {
        const res = await fetch(`http://127.0.0.1:${port}/health`);
        if (res.ok) {
          token = creds.token;
          break;
        }
      }
    } catch { /* wait */ }
    await Bun.sleep(25);
  }
  const bootMs = performance.now() - t0;
  if (!token) throw new Error(`headless did not become healthy in 30s: ${stderr}`);

  const pid = proc.pid!;
  const stopClean = async () => {
    const childrenBefore = sampleChildrenTree(pid);
    proc.kill("SIGTERM");
    const exitCode = await new Promise<number | null>((resolve) => {
      if (proc.exitCode !== null) return resolve(proc.exitCode);
      const timer = setTimeout(() => resolve(null), 10_000);
      proc.once("exit", (code) => {
        clearTimeout(timer);
        resolve(code);
      });
    });
    const waitDeadline = Date.now() + 2_000;
    while (Date.now() < waitDeadline && childrenBefore.some((c) => isPidAlive(c.pid))) {
      await Bun.sleep(50);
    }
    const stray = childrenBefore.filter((c) => isPidAlive(c.pid));
    return {
      cleanExit: exitCode !== null && stray.length === 0,
      exitCode,
      strayPids: stray.map((s) => ({ pid: s.pid, command: s.command })),
    };
  };

  return {
    proc,
    pid,
    apiBase: `http://127.0.0.1:${port}`,
    token,
    bootMs: Number(bootMs.toFixed(2)),
    daemonLog: path.join(dataDir, "daemon.log"),
    stopClean,
  };
}

async function timedGet(url: string, headers: Record<string, string>) {
  const t0 = performance.now();
  const res = await fetch(url, { headers });
  const buf = await res.arrayBuffer();
  const ms = performance.now() - t0;
  return { status: res.status, bytes: buf.byteLength, ms, text: new TextDecoder().decode(buf) };
}

async function timedPost(url: string, headers: Record<string, string>, payload: unknown) {
  const t0 = performance.now();
  const res = await fetch(url, {
    method: "POST",
    headers: { ...headers, "content-type": "application/json" },
    body: JSON.stringify(payload),
  });
  const buf = await res.arrayBuffer();
  const ms = performance.now() - t0;
  return { status: res.status, bytes: buf.byteLength, ms, text: new TextDecoder().decode(buf) };
}

async function measureSseReplay(apiBase: string, taskId: string, token: string) {
  const controller = new AbortController();
  const t0 = performance.now();
  const res = await fetch(`${apiBase}/tasks/${taskId}/events`, {
    headers: { authorization: `Bearer ${token}` },
    signal: controller.signal,
  });
  const reader = res.body!.getReader();
  const dec = new TextDecoder();
  let buf = "";
  let replayMeta: Record<string, unknown> | null = null;
  let dataFrames = 0;
  let lastFrameMs = t0;
  const hardDeadline = Date.now() + 10_000;
  try {
    while (Date.now() < hardDeadline) {
      const waitMs = replayMeta && dataFrames > 0 ? 150 : Math.max(50, hardDeadline - Date.now());
      const chunk = await Promise.race([
        reader.read(),
        new Promise<{ value: undefined; done: true }>((resolve) =>
          setTimeout(() => resolve({ value: undefined, done: true }), waitMs),
        ),
      ]);
      if (chunk.done) break;
      buf += dec.decode(chunk.value, { stream: true });
      let idx: number;
      while ((idx = buf.indexOf("\n\n")) !== -1) {
        const frame = buf.slice(0, idx);
        buf = buf.slice(idx + 2);
        const eventLine = frame.split("\n").find((l) => l.startsWith("event:"));
        const dataLine = frame.split("\n").find((l) => l.startsWith("data:"));
        if (!dataLine) continue;
        const eventName = eventLine ? eventLine.slice(6).trim() : "message";
        if (eventName === "replay_meta") {
          replayMeta = JSON.parse(dataLine.slice(5).trim());
        } else {
          dataFrames++;
        }
        lastFrameMs = performance.now();
      }
    }
  } finally {
    controller.abort();
  }
  return { ms: Number((lastFrameMs - t0).toFixed(2)), dataFrames, replayMeta };
}

/* ────────────────────────────────────────────────────────────────────────── *
 * Full run orchestrator
 * ────────────────────────────────────────────────────────────────────────── */
async function runAll(phase: string) {
  const outDir = path.join(REPO_ROOT, "docs/qa/evidence/fo-direction29");
  mkdirSync(outDir, { recursive: true });

  const gitHead = spawnSync("git", ["rev-parse", "HEAD"], { cwd: REPO_ROOT, encoding: "utf8" }).stdout.trim();
  const macVersion = spawnSync("/usr/bin/sw_vers", ["-productVersion"], { encoding: "utf8" }).stdout.trim();
  const macBuild = spawnSync("/usr/bin/sw_vers", ["-buildVersion"], { encoding: "utf8" }).stdout.trim();

  const realTmp = realpathSync(os.tmpdir());
  const rootScale = mkdtempSync(path.join(realTmp, `fo-d29-scale-${phase}-`));
  const rootLarge = mkdtempSync(path.join(realTmp, `fo-d29-large-${phase}-`));
  const rootRecover = mkdtempSync(path.join(realTmp, `fo-d29-recov-${phase}-`));

  try {
    // 1. Seed large profile in an isolated child process
    console.log(`[d29-bench:${phase}] seeding large profile (40 projects, 400 tasks, ~12.5k events)...`);
    const seedRun = spawnSync(process.execPath, [import.meta.filename, "seed-large", rootLarge], {
      cwd: REPO_ROOT,
      env: isolatedEnv(rootLarge),
      encoding: "utf8",
      timeout: 240_000,
    });
    if (seedRun.status !== 0) throw new Error(`seed-large failed: ${seedRun.stderr}`);
    const seedMeta = JSON.parse(readFileSync(path.join(rootLarge, "seed-meta.json"), "utf8"));
    const dbSizeBefore = sqliteBytes(path.join(rootLarge, "data"));

    // 2. Cold & warm headless boot repeats (3 boots)
    console.log(`[d29-bench:${phase}] measuring cold & warm headless boot (3 boots) + endpoint repeats...`);
    const bootTimesMs: number[] = [];
    let largeRoutesReport: Record<string, unknown> = {};
    let psDuringIdle: ProcessSample[] = [];
    let retentionResult: Record<string, unknown> = {};
    let compactBusyStatus = 0;
    let compactIdleResult: Record<string, unknown> = {};

    for (let b = 0; b < 3; b++) {
      const core = await bootHeadlessCore(rootLarge, b === 2 ? {} : { AGETOR_ARCHIVED_HISTORY_RETENTION: "0" });
      try {
        bootTimesMs.push(core.bootMs);
        console.log(`[d29-bench:${phase}] boot #${b}: ${core.bootMs.toFixed(1)} ms`);
        if (b === 0) {
          const headers = { authorization: `Bearer ${core.token}` };
          const iter = 5;
          const projectsSamples: number[] = [];
          let projBytes = 0;
          const tasksSamples: number[] = [];
          let tasksBytes = 0;
          const tasksArchSamples: number[] = [];
          const largeDetailSamples: number[] = [];
          const page1Samples: number[] = [];
          const page2Samples: number[] = [];
          const sseSamples: number[] = [];
          const switchSamples: number[] = [];
          const analyticsAllSamples: number[] = [];
          const analyticsProjSamples: number[] = [];
          const resourcesSamples: number[] = [];
          const recordsSamples: number[] = [];
          const forecastSamples: number[] = [];
          const dbStatsSamples: number[] = [];

          let lastPageMeta: Record<string, unknown> = {};
          let firstSseMeta: Record<string, unknown> = {};

          for (let k = 0; k < iter; k++) {
            const gp = await timedGet(`${core.apiBase}/projects`, headers);
            assert.equal(gp.status, 200);
            projectsSamples.push(gp.ms);
            projBytes = gp.bytes;

            const gt = await timedGet(`${core.apiBase}/tasks`, headers);
            assert.equal(gt.status, 200);
            tasksSamples.push(gt.ms);
            tasksBytes = gt.bytes;

            const gta = await timedGet(`${core.apiBase}/tasks?includeArchived=1`, headers);
            assert.equal(gta.status, 200);
            tasksArchSamples.push(gta.ms);

            const gld = await timedGet(`${core.apiBase}/tasks/${seedMeta.largeTaskId}`, headers);
            assert.equal(gld.status, 200);
            largeDetailSamples.push(gld.ms);

            const p1 = await timedGet(`${core.apiBase}/tasks/${seedMeta.largeTaskId}/events/page?beforeId=2147483647&limit=800`, headers);
            assert.equal(p1.status, 200);
            page1Samples.push(p1.ms);
            const p1Body = JSON.parse(p1.text);
            const p2 = await timedGet(`${core.apiBase}/tasks/${seedMeta.largeTaskId}/events/page?beforeId=${p1Body.earliestId}&limit=800`, headers);
            assert.equal(p2.status, 200);
            page2Samples.push(p2.ms);
            lastPageMeta = { page1Returned: p1Body.events.length, page1HasMore: p1Body.hasMore, page2Returned: JSON.parse(p2.text).events.length };

            const sse = await measureSseReplay(core.apiBase, seedMeta.largeTaskId, core.token);
            sseSamples.push(sse.ms);
            firstSseMeta = sse;

            // Project switching across 5 projects (projects list + tasks + project analytics)
            const pPath = seedMeta.projectPaths[k % 10]!;
            const ts0 = performance.now();
            const sw1 = await timedGet(`${core.apiBase}/tasks`, headers);
            const sw2 = await timedGet(`${core.apiBase}/api/usage-analytics/analytics?projectPath=${encodeURIComponent(pPath)}`, headers);
            assert.equal(sw1.status, 200);
            assert.equal(sw2.status, 200);
            switchSamples.push(performance.now() - ts0);
            analyticsProjSamples.push(sw2.ms);

            const ga = await timedGet(`${core.apiBase}/api/usage-analytics/analytics`, headers);
            assert.equal(ga.status, 200);
            analyticsAllSamples.push(ga.ms);

            const gc = await timedGet(`${core.apiBase}/api/usage-analytics/resources`, headers);
            assert.equal(gc.status, 200);
            resourcesSamples.push(gc.ms);

            const gr = await timedGet(`${core.apiBase}/api/usage-analytics/records`, headers);
            assert.equal(gr.status, 200);
            recordsSamples.push(gr.ms);

            const gf = await timedPost(`${core.apiBase}/api/usage-analytics/forecast`, headers, { projectPath: pPath });
            assert.equal(gf.status, 200);
            forecastSamples.push(gf.ms);

            const gs = await timedGet(`${core.apiBase}/db/stats`, headers);
            assert.equal(gs.status, 200);
            dbStatsSamples.push(gs.ms);

            if (k === 0) {
              console.log(
                `[d29-bench:${phase}] iter #0 ms: projects=${gp.ms.toFixed(1)}, tasks=${gt.ms.toFixed(1)}, tasksArch=${gta.ms.toFixed(1)}, page1=${p1.ms.toFixed(1)}, sse=${sse.ms.toFixed(1)}, analyticsProj=${sw2.ms.toFixed(1)}, analyticsAll=${ga.ms.toFixed(1)}, records=${gr.ms.toFixed(1)}, forecast=${gf.ms.toFixed(1)}, dbStats=${gs.ms.toFixed(1)}`,
              );
            }
          }

          psDuringIdle = sampleChildrenTree(core.pid);
          largeRoutesReport = {
            getProjectsMs: summarize(projectsSamples, projBytes),
            getTasksMs: summarize(tasksSamples, tasksBytes),
            getTasksIncludeArchivedMs: summarize(tasksArchSamples),
            getLargeTaskDetailMs: summarize(largeDetailSamples),
            getLargeTaskEventsPage1Ms: summarize(page1Samples),
            getLargeTaskEventsPage2Ms: summarize(page2Samples),
            sseLargeTaskInitialWindowMs: summarize(sseSamples),
            sseLargeTaskMeta: firstSseMeta.replayMeta,
            pagingMeta: lastPageMeta,
            projectSwitchMs: summarize(switchSamples),
            analyticsProjectMs: summarize(analyticsProjSamples),
            analyticsCompanyWideMs: summarize(analyticsAllSamples),
            usageResourcesEndpointMs: summarize(resourcesSamples),
            usageRecordsEndpointMs: summarize(recordsSamples),
            usageForecastEndpointMs: summarize(forecastSamples),
            dbStatsMs: summarize(dbStatsSamples),
          };
        } else if (b === 2) {
          const headers = { authorization: `Bearer ${core.token}`, "content-type": "application/json" };
          // Exercise retention & compact + 409 busy refusal on large profile
          const putRet = await fetch(`${core.apiBase}/preferences/archivedHistoryRetentionDays`, {
            method: "PUT",
            headers,
            body: JSON.stringify({ value: "30" }),
          });
          assert.equal(putRet.status, 204);
          await Bun.sleep(200);
          const retRes = await fetch(`${core.apiBase}/db/retention/run`, { method: "POST", headers });
          retentionResult = { status: retRes.status, body: await retRes.json() };
          if (retRes.status === 409) {
            for (let w = 0; w < 60; w++) {
              const st = (await (await fetch(`${core.apiBase}/db/stats`, { headers })).json()) as { retention: { running: boolean; lastTrimmedRows: number; lastFreedBytes: number; lastDurationMs: number } };
              if (!st.retention.running && st.retention.lastTrimmedRows > 0) {
                retentionResult = { status: 200, scheduledPassStats: st.retention };
                break;
              }
              await Bun.sleep(100);
            }
          }
          const busyProj = seedMeta.firstProjectPath;
          const created = (await (await fetch(`${core.apiBase}/tasks`, {
            method: "POST",
            headers,
            body: JSON.stringify({
              title: "Hold for compact guard",
              prompt: "__agetor_fake_claude_handoff__ __agetor_fake_claude_subagent__:2500[CompactGuard]",
              agent: "claude-code",
              workdir: busyProj,
              isolation: "none",
              column: "ready",
            }),
          })).json()) as { id: string };
          const started = await fetch(`${core.apiBase}/tasks/${created.id}/start`, { method: "POST", headers });
          assert.equal(started.status, 200);
          const cBusy = await fetch(`${core.apiBase}/db/compact`, { method: "POST", headers });
          compactBusyStatus = cBusy.status;
          await cBusy.arrayBuffer();
          for (let w = 0; w < 60; w++) {
            const td = (await (await fetch(`${core.apiBase}/tasks/${created.id}`, { headers })).json()) as { runId: string | null; column: string };
            if (!td.runId && td.column !== "running") break;
            await Bun.sleep(150);
          }
          const cIdle = await fetch(`${core.apiBase}/db/compact`, { method: "POST", headers });
          compactIdleResult = { status: cIdle.status, body: await cIdle.json() };
        }
      } finally {
        const exitStatus = await core.stopClean();
        assert.equal(exitStatus.cleanExit, true, `Large core boot ${b} failed clean exit: ${JSON.stringify(exitStatus)}`);
      }
    }

    const dbSizeAfter = sqliteBytes(path.join(rootLarge, "data"));
    let integrityAfterCompact = "";
    {
      using checkDb = new Database(path.join(rootLarge, "data/agetor.sqlite"), { readonly: true });
      integrityAfterCompact = (checkDb.query<{ integrity_check: string }, []>("PRAGMA integrity_check").get()?.integrity_check) ?? "missing";
    }
    const largeDaemonLog = existsSync(path.join(rootLarge, "data/daemon.log"))
      ? readFileSync(path.join(rootLarge, "data/daemon.log"), "utf8")
      : "";
    const lagWarnings = largeDaemonLog.split("\n").filter((l) => l.includes("core was unresponsive"));

    // 3. Reused 30-project / 60-task contention run
    console.log(`[d29-bench:${phase}] running reused 30-project / 60-task contention scenario (250ms fake delay)...`);
    const scaleRun = spawnSync(process.execPath, [import.meta.filename, "scale-contention", rootScale], {
      cwd: REPO_ROOT,
      env: isolatedEnv(rootScale, {
        AGETOR_API_PORT: String(freePort()),
        AGETOR_FAKE_CODEX_RESOLVE_DELAY_MS: "250",
      }),
      encoding: "utf8",
      timeout: 240_000,
    });
    if (scaleRun.status !== 0) throw new Error(`scale-contention failed: ${scaleRun.stderr}\n${scaleRun.stdout}`);
    const scaleResult = JSON.parse(readFileSync(path.join(rootScale, "scale-result.json"), "utf8"));

    // 4. Interruption & recovery check (SIGKILL core mid-run + reopen + integrity + clean exit)
    console.log(`[d29-bench:${phase}] verifying crash interruption & recovery (SIGKILL -> reboot)...`);
    const recProj = path.join(rootRecover, "project");
    mkdirSync(recProj, { recursive: true });
    writeFileSync(path.join(recProj, "README.md"), "# Recover\n");
    const c1 = await bootHeadlessCore(rootRecover, { AGETOR_FAKE_CODEX_RESOLVE_DELAY_MS: "15000" });
    const recHeaders = { authorization: `Bearer ${c1.token}`, "content-type": "application/json" };
    await fetch(`${c1.apiBase}/projects`, { method: "POST", headers: recHeaders, body: JSON.stringify({ path: recProj, name: "Recovery" }) });
    const tDone = (await (await fetch(`${c1.apiBase}/tasks`, {
      method: "POST", headers: recHeaders,
      body: JSON.stringify({ title: "Completed before kill", prompt: "done", workdir: recProj, isolation: "none", column: "done" }),
    })).json()) as { id: string };
    const tQueued = (await (await fetch(`${c1.apiBase}/tasks`, {
      method: "POST", headers: recHeaders,
      body: JSON.stringify({ title: "Queued ready before kill", prompt: "queued", workdir: recProj, isolation: "none", column: "ready" }),
    })).json()) as { id: string };
    const tLive = (await (await fetch(`${c1.apiBase}/tasks`, {
      method: "POST", headers: recHeaders,
      body: JSON.stringify({ title: "Interrupted running task", prompt: "__agetor_fake_claude_handoff__ __agetor_fake_claude_subagent__:20000[CrashGuard]", agent: "claude-code", workdir: recProj, isolation: "none", column: "ready" }),
    })).json()) as { id: string };
    const startLive = await fetch(`${c1.apiBase}/tasks/${tLive.id}/start`, { method: "POST", headers: recHeaders });
    assert.equal(startLive.status, 200);
    await Bun.sleep(400);
    // Hard SIGKILL crash simulation!
    process.kill(c1.pid, "SIGKILL");
    await waitPidExit(c1.pid, 5_000);

    // Reopen profile cleanly
    const c2 = await bootHeadlessCore(rootRecover);
    const recHeaders2 = { authorization: `Bearer ${c2.token}` };
    const afterDone = (await (await fetch(`${c2.apiBase}/tasks/${tDone.id}`, { headers: recHeaders2 })).json()) as { column: string; runId: string | null };
    const afterQueued = (await (await fetch(`${c2.apiBase}/tasks/${tQueued.id}`, { headers: recHeaders2 })).json()) as { column: string; runId: string | null };
    const afterLive = (await (await fetch(`${c2.apiBase}/tasks/${tLive.id}`, { headers: recHeaders2 })).json()) as { column: string; runId: string | null };
    const afterLiveRuns = (await (await fetch(`${c2.apiBase}/tasks/${tLive.id}/runs`, { headers: recHeaders2 })).json()) as Array<{ id: string; status: string }>;
    const exitRecov = await c2.stopClean();

    let recoveryIntegrity = "";
    {
      using recDb = new Database(path.join(rootRecover, "data/agetor.sqlite"), { readonly: true });
      recoveryIntegrity = (recDb.query<{ integrity_check: string }, []>("PRAGMA integrity_check").get()?.integrity_check) ?? "missing";
    }

    const report = {
      phase,
      kind: "headless-benchmark-do-not-conflate-with-packaged-PN",
      measuredAt: new Date().toISOString(),
      gitHead,
      machine: {
        os: `${os.platform()} ${macVersion} (${macBuild})`,
        arch: os.arch(),
        cpu: os.cpus()[0]?.model ?? "unknown",
        cores: os.cpus().length,
        ramGiB: Number((os.totalmem() / 1024 ** 3).toFixed(1)),
        bunVersion: Bun.version,
      },
      largeProfile: {
        counts: seedMeta.counts,
        dbSizeBefore,
        dbSizeAfter,
        coldBootMs: bootTimesMs[0],
        warmBootMs: bootTimesMs.slice(1),
        bootSummaryMs: summarize(bootTimesMs),
        lagWarningsCount: lagWarnings.length,
        lagWarnings,
        processSample: psDuringIdle,
        routes: largeRoutesReport,
        retentionResult,
        compactBusyStatus,
        compactIdleResult,
        integrityAfterCompact,
      },
      scale30Projects60Tasks: scaleResult,
      crashRecovery: {
        doneTaskAfterRestart: afterDone,
        queuedTaskAfterRestart: afterQueued,
        liveTaskAfterRestart: afterLive,
        liveRunsAfterRestart: afterLiveRuns.map((r) => ({ id: r.id, status: r.status })),
        noDuplicateDispatch: afterLiveRuns.length === 1 && afterLiveRuns[0]?.status === "orphaned",
        integrityCheck: recoveryIntegrity,
        cleanShutdown: exitRecov,
      },
    };

    const outPath = path.join(outDir, `${phase}-headless.json`);
    writeFileSync(outPath, JSON.stringify(report, null, 2) + "\n");
    console.log(`[d29-bench:${phase}] wrote ${outPath}`);
  } finally {
    rmSync(rootScale, { recursive: true, force: true });
    rmSync(rootLarge, { recursive: true, force: true });
    rmSync(rootRecover, { recursive: true, force: true });
  }
}

const cmd = process.argv[2];
if (cmd === "seed-large") {
  await seedLargeProfile(process.argv[3]!);
  process.exit(0);
} else if (cmd === "scale-contention") {
  await runScaleContention(process.argv[3]!);
  process.exit(0);
} else if (cmd === "run") {
  const phaseIdx = process.argv.indexOf("--phase");
  const phase = phaseIdx >= 0 ? process.argv[phaseIdx + 1] ?? "baseline" : "baseline";
  await runAll(phase);
  process.exit(0);
} else {
  console.error("Usage: bun scripts/qa-direction29-bench.ts run --phase <baseline|post>");
  process.exit(1);
}
