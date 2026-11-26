import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { makeTask } from "../cli/test-fixtures.ts";

const DATA_DIR = mkdtempSync(path.join(tmpdir(), "fo-project-lifecycle01-"));
process.env.AGETOR_DATA_DIR = DATA_DIR;
process.env.AGETOR_API_PORT = "4789";
process.env.AGETOR_ALLOW_LEGACY_QUEUE_POLICY_SCHEMA = "1";
process.env.AGETOR_CLAUDE_DRIVER = "fake";
process.env.AGETOR_CODEX_DRIVER = "fake";
process.env.AGETOR_CODEX_BIN = "/bin/echo";
process.env.AGETOR_FAKE_QC_VERDICT = "PASS";

let server: { stop: () => void };
let token: string;
let db: typeof import("./db.ts").db;
let tasks: typeof import("./db.ts").tasks;
let runs: typeof import("./db.ts").runs;
let projects: typeof import("./db.ts").projects;
let projectExecutions: typeof import("./db.ts").projectExecutions;
let startTask: typeof import("./orchestrator.ts").startTask;
let sendInput: typeof import("./orchestrator.ts").sendInput;
let rearmFxAutoResumes: typeof import("./orchestrator.ts").rearmFxAutoResumes;
let stopFxAutoResumeTimers: typeof import("./orchestrator.ts").stopFxAutoResumeTimers;
let reconcileProjectLifecyclesOnBoot: typeof import("./project-lifecycle.ts").reconcileProjectLifecyclesOnBoot;
let projectLifecycleTaskRefusal: typeof import("./project-lifecycle.ts").projectLifecycleTaskRefusal;
let recoverOrchestratedWorkflows: typeof import("./pm-orchestrated-workflow.ts").recoverOrchestratedWorkflows;
let recoverOrchestratedBatches: typeof import("./pm-orchestrated-batch.ts").recoverOrchestratedBatches;

const createdDirs: string[] = [];

beforeAll(async () => {
  ({ db, tasks, runs, projects, projectExecutions } = await import("./db.ts"));
  const { harnesses } = await import("./db.ts");
  harnesses.setEnabled("claude-code", true);
  harnesses.setEnabled("codex", true);
  ({ startTask, sendInput, rearmFxAutoResumes, stopFxAutoResumeTimers } = await import("./orchestrator.ts"));
  ({ reconcileProjectLifecyclesOnBoot, projectLifecycleTaskRefusal } = await import("./project-lifecycle.ts"));
  const wfMod = await import("./pm-orchestrated-workflow.ts");
  const batchMod = await import("./pm-orchestrated-batch.ts");
  const execBatchMod = await import("./execution-batches.ts");
  recoverOrchestratedWorkflows = wfMod.recoverOrchestratedWorkflows;
  recoverOrchestratedBatches = batchMod.recoverOrchestratedBatches;
  wfMod.initOrchestratedWorkflows();
  batchMod.initOrchestratedBatches();
  execBatchMod.initExecutionBatches();
  const { startApiServer, API_TOKEN } = await import("./server.ts");
  server = startApiServer() as unknown as { stop: () => void };
  token = API_TOKEN;
});

afterAll(async () => {
  stopFxAutoResumeTimers?.();
  const execBatchMod = await import("./execution-batches.ts");
  execBatchMod.stopExecutionBatchTimers();
  server?.stop?.();
  for (const dir of createdDirs) {
    rmSync(dir, { recursive: true, force: true });
  }
  rmSync(DATA_DIR, { recursive: true, force: true });
});

const url = (p: string) => `http://127.0.0.1:4789${p}`;
const auth = () => ({ authorization: `Bearer ${token}`, "content-type": "application/json" });

function seedGitProject(name: string): string {
  const dir = realpathSync(mkdtempSync(path.join(tmpdir(), `fo-lifecycle-proj-${name}-`)));
  createdDirs.push(dir);
  execFileSync("git", ["init", "-q"], { cwd: dir });
  execFileSync("git", ["config", "user.email", "qa@example.test"], { cwd: dir });
  execFileSync("git", ["config", "user.name", "QA"], { cwd: dir });
  mkdirSync(path.join(dir, "docs"), { recursive: true });
  writeFileSync(path.join(dir, "README.md"), `# ${name}\n`);
  execFileSync("git", ["add", "."], { cwd: dir });
  execFileSync("git", ["commit", "-q", "-m", "init"], { cwd: dir });
  projects.upsert(dir, name);
  return dir;
}

function seedTask(
  workdir: string,
  title: string,
  opts: Partial<{
    column: "backlog" | "inbox" | "ready" | "running" | "review" | "blocked" | "done";
    agent: string;
    model: string;
    mode: string;
    isolation: "worktree" | "none";
  }> = {},
) {
  const now = Date.now();
  return tasks.insert(makeTask({
    id: randomUUID(),
    title,
    prompt: `Implement ${title}`,
    column: opts.column ?? "ready",
    agent: (opts.agent ?? "codex") as "codex",
    model: opts.model ?? "gpt-5.3-codex",
    effort: "medium",
    mode: opts.mode ?? "auto",
    isolation: opts.isolation ?? "none",
    workdir,
    createdAt: now,
    updatedAt: now,
  }));
}

async function waitUntil(predicate: () => boolean | Promise<boolean>, timeoutMs = 4000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await new Promise((r) => setTimeout(r, 25));
  }
  throw new Error("Timed out waiting for condition.");
}

describe("FO-PROJECT-LIFECYCLE01 — Project-wide Start / Stop lifecycle controls", () => {
  test("requires Owner Bearer authorization on all lifecycle routes", async () => {
    const projectDir = seedGitProject("auth-gate");

    for (const badHeaders of [{}, { authorization: "Bearer wrong-token" }] as Record<string, string>[]) {
      const getRes = await fetch(url(`/projects/lifecycle?path=${encodeURIComponent(projectDir)}`), {
        headers: badHeaders,
      });
      expect(getRes.status).toBe(401);

      const stopRes = await fetch(url("/projects/lifecycle/stop"), {
        method: "POST",
        headers: { "content-type": "application/json", ...badHeaders },
        body: JSON.stringify({ path: projectDir }),
      });
      expect(stopRes.status).toBe(401);

      const startRes = await fetch(url("/projects/lifecycle/start"), {
        method: "POST",
        headers: { "content-type": "application/json", ...badHeaders },
        body: JSON.stringify({ path: projectDir }),
      });
      expect(startRes.status).toBe(401);
    }
  });

  test("stops an idle Running project to Paused, is idempotent, blocks launches while preserving editing, and resumes safely without auto-launching", async () => {
    const projectDir = seedGitProject("idle-stop-resume");
    const backlogTask = seedTask(projectDir, "Backlog item", { column: "backlog" });
    const inboxTask = seedTask(projectDir, "Inbox item", { column: "inbox" });
    const readyTask = seedTask(projectDir, "Ready item", { column: "ready" });

    // Initial state on GET /projects and GET /projects/lifecycle is Running.
    const listBefore = await fetch(url("/projects"), { headers: auth() }).then((r) => r.json()) as Array<{
      path: string;
      lifecycle?: { state: string; canStop: boolean; canStart: boolean; launchesBlocked: boolean; startUnavailableCode: string | null };
    }>;
    const initialProj = listBefore.find((p) => p.path === projectDir);
    expect(initialProj?.lifecycle?.state).toBe("running");
    expect(initialProj?.lifecycle?.canStop).toBe(true);
    expect(initialProj?.lifecycle?.canStart).toBe(false);
    expect(initialProj?.lifecycle?.launchesBlocked).toBe(false);
    expect(initialProj?.lifecycle?.startUnavailableCode).toBe("already-running");

    // Seed an interrupted supervised "starting" proposal with no recorded run so Start reconciliation is exercised too.
    const interruptedProposalId = randomUUID();
    projectExecutions.put({
      id: interruptedProposalId,
      projectPath: projectDir,
      taskId: readyTask.id,
      status: "starting",
      runId: null,
      data: JSON.stringify({
        id: interruptedProposalId,
        projectPath: projectDir,
        taskId: readyTask.id,
        taskTitle: readyTask.title,
        source: "owner",
        status: "starting",
        revision: 1,
        reason: "Interrupted start",
        config: {
          pipelineId: null,
          profileId: null,
          harness: "codex",
          model: "gpt-5.3-codex",
          effort: "medium",
          mode: "auto",
          fast: false,
          maxMode: false,
        },
        resolved: {
          harnessLabel: "Codex",
          harnessKind: "codex",
          modelLabel: "gpt-5.3-codex",
          modeLabel: "auto",
          accessLevel: 3,
          profileName: null,
          pipelineName: null,
          pipelineSteps: [],
          workdir: projectDir,
          isolation: "direct",
          workspace: projectDir,
          previousMode: null,
        },
        checks: [],
        checkedAt: Date.now(),
        reviewedFingerprint: "fp",
        usageNotice: null,
        runId: null,
        error: null,
        createdAt: Date.now(),
        updatedAt: Date.now(),
        approvedAt: Date.now(),
        startedAt: null,
        history: [],
      }),
      createdAt: Date.now(),
    });

    // 1. Stop idle Running project -> Paused immediately.
    const stop1 = await fetch(url("/projects/lifecycle/stop"), {
      method: "POST",
      headers: auth(),
      body: JSON.stringify({ path: projectDir }),
    });
    expect(stop1.status).toBe(200);
    const stop1Body = await stop1.json() as {
      changed: boolean;
      previousState: string;
      lifecycle: {
        state: string;
        launchesBlocked: boolean;
        waitingForActiveWork: boolean;
        activeExecutions: number;
        canStart: boolean;
        canStop: boolean;
        stopUnavailableCode: string | null;
      };
    };
    expect(stop1Body.changed).toBe(true);
    expect(stop1Body.previousState).toBe("running");
    expect(stop1Body.lifecycle.state).toBe("paused");
    expect(stop1Body.lifecycle.launchesBlocked).toBe(true);
    expect(stop1Body.lifecycle.waitingForActiveWork).toBe(false);
    expect(stop1Body.lifecycle.activeExecutions).toBe(0);
    expect(stop1Body.lifecycle.canStart).toBe(true);
    expect(stop1Body.lifecycle.canStop).toBe(false);
    expect(stop1Body.lifecycle.stopUnavailableCode).toBe("already-paused");

    // 6. Repeated Stop while Paused is idempotent.
    const stop2 = await fetch(url("/projects/lifecycle/stop"), {
      method: "POST",
      headers: auth(),
      body: JSON.stringify({ path: projectDir }),
    }).then((r) => r.json()) as { changed: boolean; lifecycle: { state: string } };
    expect(stop2.changed).toBe(false);
    expect(stop2.lifecycle.state).toBe("paused");

    // Queue columns are untouched.
    expect(tasks.get(backlogTask.id)?.column).toBe("backlog");
    expect(tasks.get(inboxTask.id)?.column).toBe("inbox");
    expect(tasks.get(readyTask.id)?.column).toBe("ready");

    // 4. All AI launch boundaries are refused while Paused:
    // Board task start:
    const boardStart = await fetch(url(`/tasks/${readyTask.id}/start`), {
      method: "POST",
      headers: auth(),
    });
    expect([400, 409]).toContain(boardStart.status);
    expect(await boardStart.text()).toMatch(/paused/i);
    expect(runs.listForTask(readyTask.id)).toEqual([]);

    // Project Manager turn:
    await fetch(url("/project-manager/config"), {
      method: "PUT",
      headers: auth(),
      body: JSON.stringify({ path: projectDir, harness: "claude-code", model: "sonnet-4.6" }),
    });
    const pmRes = await fetch(url("/project-manager/messages"), {
      method: "POST",
      headers: auth(),
      body: JSON.stringify({ path: projectDir, text: "Plan next sprint" }),
    });
    expect(pmRes.status).toBe(409);
    expect(await pmRes.text()).toMatch(/paused/i);

    // Project Interview turn:
    const ivRes = await fetch(url("/project-interviews/turns"), {
      method: "POST",
      headers: auth(),
      body: JSON.stringify({
        interviewId: "interview-paused-test",
        harness: "claude-code",
        request: { kind: "question" },
        project: {
          path: projectDir,
          name: "idle-stop-resume",
          mode: "import",
          targets: { idea: "docs/IDEA.md", prd: null },
        },
        messages: [],
        drafts: {},
      }),
    });
    expect(ivRes.status).toBe(409);
    expect(await ivRes.text()).toMatch(/paused/i);

    // Viewing and safe non-launch task editing still work while Paused:
    const patchRes = await fetch(url(`/tasks/${readyTask.id}`), {
      method: "PATCH",
      headers: auth(),
      body: JSON.stringify({ title: "Ready item (edited safely)" }),
    });
    expect(patchRes.status).toBe(200);
    expect(tasks.get(readyTask.id)?.title).toBe("Ready item (edited safely)");

    // 7. Start / Resume the safely Paused project:
    const startRes = await fetch(url("/projects/lifecycle/start"), {
      method: "POST",
      headers: auth(),
      body: JSON.stringify({ path: projectDir }),
    });
    expect(startRes.status).toBe(200);
    const startBody = await startRes.json() as {
      changed: boolean;
      previousState: string;
      reconciledStartingProposals: number;
      lifecycle: { state: string; launchesBlocked: boolean; canStop: boolean; canStart: boolean };
    };
    expect(startBody.changed).toBe(true);
    expect(startBody.previousState).toBe("paused");
    expect(startBody.reconciledStartingProposals).toBe(1);
    expect(startBody.lifecycle.state).toBe("running");
    expect(startBody.lifecycle.launchesBlocked).toBe(false);
    expect(startBody.lifecycle.canStop).toBe(true);
    expect(startBody.lifecycle.canStart).toBe(false);

    // Resuming does NOT auto-launch Ready tasks!
    expect(tasks.get(readyTask.id)?.column).toBe("ready");
    expect(runs.listForTask(readyTask.id)).toEqual([]);
  });

  test("Stop with one active Run enters Draining, blocks new launches & Start, keeps other projects unaffected, preserves truthful Run status, and settles to Paused", async () => {
    const projectA = seedGitProject("draining-proj-a");
    const projectB = seedGitProject("independent-proj-b");
    const activeTaskA = seedTask(projectA, "In-flight task A");
    const queuedTaskA = seedTask(projectA, "Queued task A");
    const taskB = seedTask(projectB, "Independent task B");

    // Hold fake Codex run in flight for 450ms so we can deterministically inspect Draining.
    process.env.AGETOR_FAKE_CODEX_RESOLVE_DELAY_MS = "450";
    try {
      const startedA = await startTask(activeTaskA.id);
      expect("runId" in startedA).toBe(true);
      if (!("runId" in startedA)) throw new Error("Failed to start activeTaskA");

      // Active run is genuinely running.
      expect(runs.get(startedA.runId)?.status).toBe("running");
      expect(tasks.get(activeTaskA.id)?.column).toBe("running");

      // 2. Request Stop on projectA while activeTaskA is running -> Draining.
      const stopRes = await fetch(url("/projects/lifecycle/stop"), {
        method: "POST",
        headers: auth(),
        body: JSON.stringify({ path: projectA }),
      });
      expect(stopRes.status).toBe(200);
      const stopData = await stopRes.json() as {
        changed: boolean;
        previousState: string;
        lifecycle: {
          state: string;
          waitingForActiveWork: boolean;
          activeExecutions: number;
          launchesBlocked: boolean;
          canStart: boolean;
          canStop: boolean;
          startUnavailableCode: string | null;
          stopUnavailableCode: string | null;
        };
      };
      expect(stopData.changed).toBe(true);
      expect(stopData.previousState).toBe("running");
      expect(stopData.lifecycle.state).toBe("draining");
      expect(stopData.lifecycle.waitingForActiveWork).toBe(true);
      expect(stopData.lifecycle.activeExecutions).toBe(1);
      expect(stopData.lifecycle.launchesBlocked).toBe(true);
      expect(stopData.lifecycle.canStart).toBe(false);
      expect(stopData.lifecycle.canStop).toBe(false);
      expect(stopData.lifecycle.startUnavailableCode).toBe("draining-active-work");
      expect(stopData.lifecycle.stopUnavailableCode).toBe("already-draining");

      // 5. Active Run is NOT killed or mislabeled as completed while Draining.
      expect(runs.get(startedA.runId)?.status).toBe("running");
      expect(tasks.get(activeTaskA.id)?.column).toBe("running");

      // 6. Repeated Stop while Draining is idempotent.
      const repeatStop = await fetch(url("/projects/lifecycle/stop"), {
        method: "POST",
        headers: auth(),
        body: JSON.stringify({ path: projectA }),
      }).then((r) => r.json()) as { changed: boolean; lifecycle: { state: string } };
      expect(repeatStop.changed).toBe(false);
      expect(repeatStop.lifecycle.state).toBe("draining");

      // 3. New execution in projectA while Draining is refused; Start while Draining is also refused.
      const blockedStart = await startTask(queuedTaskA.id);
      expect("error" in blockedStart).toBe(true);
      if ("error" in blockedStart) expect(blockedStart.error).toMatch(/draining/i);
      expect(runs.listForTask(queuedTaskA.id)).toEqual([]);

      const blockedInput = await sendInput(startedA.runId, "extra follow-up while draining");
      expect(blockedInput.delivered).toBe(false);

      const prematureResume = await fetch(url("/projects/lifecycle/start"), {
        method: "POST",
        headers: auth(),
        body: JSON.stringify({ path: projectA }),
      });
      expect(prematureResume.status).toBe(409);
      const prematureJson = await prematureResume.json() as { code: string };
      expect(prematureJson.code).toBe("draining-active-work");

      // 10. Project B is completely unaffected — remains Running and can launch work!
      process.env.AGETOR_FAKE_CODEX_RESOLVE_DELAY_MS = "20";
      const bLifecycle = await fetch(url(`/projects/lifecycle?path=${encodeURIComponent(projectB)}`), {
        headers: auth(),
      }).then((r) => r.json()) as { lifecycle: { state: string } };
      expect(bLifecycle.lifecycle.state).toBe("running");

      const startedB = await startTask(taskB.id);
      expect("runId" in startedB).toBe(true);
      await waitUntil(() => tasks.get(taskB.id)?.column === "review");

      // Wait for activeTaskA's fake run to finish naturally -> projectA settles to Paused!
      await waitUntil(() => tasks.get(activeTaskA.id)?.column === "review");
      await waitUntil(async () => {
        const snap = await fetch(url(`/projects/lifecycle?path=${encodeURIComponent(projectA)}`), {
          headers: auth(),
        }).then((r) => r.json()) as { lifecycle: { state: string; activeExecutions: number } };
        return snap.lifecycle.state === "paused" && snap.lifecycle.activeExecutions === 0;
      });

      // Completed Run and task Review state are preserved intact; no real provider ran.
      const settledRun = runs.get(startedA.runId)!;
      expect(settledRun.status).toBe("succeeded");
      expect(tasks.get(activeTaskA.id)?.column).toBe("review");
      const eventsA = runs.events(startedA.runId);
      expect(eventsA.some((e) => e.data.includes("fake response to:"))).toBe(true);
    } finally {
      process.env.AGETOR_FAKE_CODEX_RESOLVE_DELAY_MS = "20";
    }
  });

  test("preserves pending approvals, phase grants, QC gates, and keeps paused or expired batches blocked on Project Start", async () => {
    const projectDir = seedGitProject("gates-and-batches");
    const task1 = seedTask(projectDir, "Batch Task 1", { agent: "claude-code", model: "opus-5.5" });
    const task2 = seedTask(projectDir, "Batch Task 2", { agent: "claude-code", model: "opus-5.5" });
    const execBatchTask = seedTask(projectDir, "ExecBatch Task", { agent: "codex", model: "gpt-5.3-codex" });
    const reviewReadyTask = seedTask(projectDir, "QC Gate Task", { agent: "codex", model: "gpt-5.3-codex" });

    // Run reviewReadyTask once so it lands in Review with a completed Developer run, needing QC before Done.
    const implStart = await startTask(reviewReadyTask.id);
    expect("runId" in implStart).toBe(true);
    await waitUntil(() => tasks.get(reviewReadyTask.id)?.column === "review");

    // Assign developer employee to task1 & task2 and create an orchestrated gated batch with an unspent phase grant AND a second expired batch.
    const dev = await fetch(url("/employees"), {
      method: "POST",
      headers: auth(),
      body: JSON.stringify({ name: "Lifecycle Dev", jobTitle: "Engineer", projectPath: projectDir }),
    }).then((r) => r.json()) as { id: string };
    await fetch(url("/task-assignments"), {
      method: "POST",
      headers: auth(),
      body: JSON.stringify({ taskId: task1.id, employeeId: dev.id }),
    });
    await fetch(url("/task-assignments"), {
      method: "POST",
      headers: auth(),
      body: JSON.stringify({ taskId: task2.id, employeeId: dev.id }),
    });

    // Create gated FO-AUTO03 batch, approve it, mint one active developer phase grant on task1, and pause the batch explicitly.
    const draftRes = await fetch(url("/project-manager/orchestrated-batches"), {
      method: "POST",
      headers: auth(),
      body: JSON.stringify({ path: projectDir, taskIds: [task1.id] }),
    }).then((r) => r.json()) as { batch: { id: string; revision: number } };

    const approvedRes = await fetch(url(`/project-manager/orchestrated-batches/${draftRes.batch.id}/approve`), {
      method: "POST",
      headers: auth(),
      body: JSON.stringify({
        path: projectDir,
        revision: draftRes.batch.revision,
        defaults: {
          implementerEmployeeId: dev.id,
          implementerHarnessId: "claude-code",
          implementerModel: "opus-5.5",
          reviewerHarness: "claude-code",
          reviewerModel: "haiku-5.5",
          autoReviewAfterImplementation: true,
          autoReworkOnChanges: false,
          maxLaunches: 2,
          evidencePolicy: "review-without-observed-test",
          completionGate: "owner-done",
          requireTaskWorkspace: false,
        },
      }),
    });
    expect(approvedRes.status).toBe(200);

    const phaseGrantRes = await fetch(url(`/project-manager/orchestrated-batches/${draftRes.batch.id}/phase-grants`), {
      method: "POST",
      headers: auth(),
      body: JSON.stringify({ path: projectDir, taskId: task1.id, phase: "developer", validMinutes: 60 }),
    });
    expect(phaseGrantRes.status).toBe(200);
    const afterGrant = await phaseGrantRes.json() as { batch: { phaseGrants: Array<{ id: string; status: string; consumedRunId: string | null }> } };
    expect(afterGrant.batch.phaseGrants[0]?.status).toBe("active");

    // Pause the batch explicitly at the batch level ("Paused by the owner").
    const pausedBatchRes = await fetch(url(`/project-manager/orchestrated-batches/${draftRes.batch.id}/pause`), {
      method: "POST",
      headers: auth(),
      body: JSON.stringify({ path: projectDir }),
    });
    expect(pausedBatchRes.status).toBe(200);

    // Also prepare a second orchestrated batch on task2 and expire its policy timestamp in SQLite.
    const expiredDraft = await fetch(url("/project-manager/orchestrated-batches"), {
      method: "POST",
      headers: auth(),
      body: JSON.stringify({ path: projectDir, taskIds: [task2.id] }),
    }).then((r) => r.json()) as { batch: { id: string; revision: number } };
    await fetch(url(`/project-manager/orchestrated-batches/${expiredDraft.batch.id}/approve`), {
      method: "POST",
      headers: auth(),
      body: JSON.stringify({
        path: projectDir,
        revision: expiredDraft.batch.revision,
        queuePolicySchema: "legacy-auto02",
        defaults: {
          implementerEmployeeId: dev.id,
          implementerHarnessId: "claude-code",
          implementerModel: "opus-5.5",
          reviewerHarness: "claude-code",
          reviewerModel: "haiku-5.5",
          autoReviewAfterImplementation: true,
          autoReworkOnChanges: false,
          maxLaunches: 2,
          validMinutes: 5,
        },
      }),
    });
    const rawExpiredRow = db.query<{ data_json: string }, [string]>(
      `SELECT data_json FROM pm_orchestrated_batches WHERE id = ?`,
    ).get(expiredDraft.batch.id)!;
    const parsedExpired = JSON.parse(rawExpiredRow.data_json) as { policy: { expiresAt: number } };
    parsedExpired.policy.expiresAt = Date.now() - 60_000;
    db.run(`UPDATE pm_orchestrated_batches SET data_json = ? WHERE id = ?`, [
      JSON.stringify(parsedExpired),
      expiredDraft.batch.id,
    ]);

    // Also prepare a pending supervised execution proposal on execBatchTask (Owner approval pending).
    const prepProposal = await fetch(url("/project-manager/executions"), {
      method: "POST",
      headers: auth(),
      body: JSON.stringify({ path: projectDir, taskId: execBatchTask.id }),
    });
    expect([200, 201]).toContain(prepProposal.status);
    const proposalBody = await prepProposal.json() as { execution: { id: string; revision: number; status: string } };
    expect(proposalBody.execution.status).toBe("proposed");

    // Stop the project.
    const stopRes = await fetch(url("/projects/lifecycle/stop"), {
      method: "POST",
      headers: auth(),
      body: JSON.stringify({ path: projectDir }),
    });
    expect(stopRes.status).toBe(200);

    // While Paused:
    // - Approving the supervised proposal is refused WITHOUT mutating/invalidating the proposal's revision.
    const blockedApprove = await fetch(url(`/project-manager/executions/${proposalBody.execution.id}/approve`), {
      method: "POST",
      headers: auth(),
      body: JSON.stringify({ path: projectDir, revision: proposalBody.execution.revision, acknowledgeUsage: true }),
    });
    expect(blockedApprove.status).toBe(409);

    // - Starting QC review on reviewReadyTask is refused while Paused.
    const blockedQc = await fetch(url(`/tasks/${reviewReadyTask.id}/qc/reviews`), {
      method: "POST",
      headers: auth(),
      body: JSON.stringify({ reviewerHarness: "claude-code", reviewerModel: "haiku-5.5" }),
    });
    expect(blockedQc.status).toBe(409);

    // - Resuming the paused batch while Project is Paused is refused.
    const blockedBatchResume = await fetch(url(`/project-manager/orchestrated-batches/${draftRes.batch.id}/resume`), {
      method: "POST",
      headers: auth(),
      body: JSON.stringify({ path: projectDir }),
    });
    expect(blockedBatchResume.status).toBe(409);

    // Now Start / Resume the project!
    const resumeProj = await fetch(url("/projects/lifecycle/start"), {
      method: "POST",
      headers: auth(),
      body: JSON.stringify({ path: projectDir }),
    });
    expect(resumeProj.status).toBe(200);

    // Verify 8 & 9:
    // - The paused batch is STILL paused at the batch level, and its phase grant is STILL active & unconsumed!
    const batchAfterStart = await fetch(
      url(`/project-manager/orchestrated-batches/${draftRes.batch.id}?path=${encodeURIComponent(projectDir)}`),
      { headers: auth() },
    ).then((r) => r.json()) as {
      batch: { status: string; progress: { pauseReason: string | null }; phaseGrants: Array<{ status: string; consumedRunId: string | null }> };
    };
    expect(batchAfterStart.batch.status).toBe("paused");
    expect(batchAfterStart.batch.progress.pauseReason).toBe("Paused by the owner.");
    expect(batchAfterStart.batch.phaseGrants[0]?.status).toBe("active");
    expect(batchAfterStart.batch.phaseGrants[0]?.consumedRunId).toBeNull();
    expect(runs.listForTask(task1.id)).toEqual([]);

    // - The expired batch was NOT renewed and still refuses Start with 409 expired!
    const tryStartExpired = await fetch(url(`/project-manager/orchestrated-batches/${expiredDraft.batch.id}/start`), {
      method: "POST",
      headers: auth(),
      body: JSON.stringify({ path: projectDir }),
    });
    expect(tryStartExpired.status).toBe(409);
    expect(await tryStartExpired.text()).toMatch(/expired/i);
    expect(runs.listForTask(task2.id)).toEqual([]);

    // - QC / Owner Done gate was NOT bypassed on reviewReadyTask!
    expect(tasks.get(reviewReadyTask.id)?.column).toBe("review");

    // - Preserved pending supervised proposal still has its original revision and CAN now be approved by the Owner!
    const okApprove = await fetch(url(`/project-manager/executions/${proposalBody.execution.id}/approve`), {
      method: "POST",
      headers: auth(),
      body: JSON.stringify({ path: projectDir, revision: proposalBody.execution.revision, acknowledgeUsage: true }),
    });
    expect(okApprove.status).toBe(200);
    await waitUntil(() => tasks.get(execBatchTask.id)?.column === "review");
  });

  test("persists lifecycle state across controlled restart reconciliation, fails closed on unknown/corrupt state, and serializes concurrent Start/Stop without duplicate dispatch", async () => {
    const pausedProj = seedGitProject("restart-paused");
    const drainingProj = seedGitProject("restart-draining");
    const recoveringProj = seedGitProject("restart-recovering");
    const corruptProj = seedGitProject("restart-corrupt");

    const pausedTask = seedTask(pausedProj, "Paused task across restart", { agent: "claude-code", model: "opus-5.5" });
    const fxTask = seedTask(pausedProj, "Paused fx task", { agent: "fx", model: "zai/glm-5.3-flash" });

    // Stop pausedProj normally via API.
    await fetch(url("/projects/lifecycle/stop"), {
      method: "POST",
      headers: auth(),
      body: JSON.stringify({ path: pausedProj }),
    });
    expect(projects.getLifecycleRaw(pausedProj)?.lifecycleState).toBe("paused");

    // Seed an active workflow row and a pending fx auto-resume row inside pausedProj to prove boot recovery does NOT launch them!
    const dev = await fetch(url("/employees"), {
      method: "POST",
      headers: auth(),
      body: JSON.stringify({ name: "Restart Dev", jobTitle: "Eng", projectPath: pausedProj }),
    }).then((r) => r.json()) as { id: string };
    await fetch(url("/task-assignments"), {
      method: "POST",
      headers: auth(),
      body: JSON.stringify({ taskId: pausedTask.id, employeeId: dev.id }),
    });
    const wfId = randomUUID();
    const wfNow = Date.now();
    const wfGrant = {
      taskId: pausedTask.id,
      projectPath: pausedProj,
      implementerEmployeeId: dev.id,
      implementerHarnessId: "claude-code",
      implementerModel: "opus-5.5",
      implementerEffort: "medium",
      reviewerEmployeeId: null,
      reviewerHarness: "claude-code",
      reviewerModel: "haiku-5.5",
      autoReviewAfterImplementation: true,
      autoReworkOnChanges: false,
      maxReworkIterations: 0,
      maxLaunches: 2,
      expiresAt: wfNow + 3_600_000,
      approvedAt: wfNow,
      approvedBy: "owner",
      grantEpoch: 1,
    };
    db.run(
      `INSERT INTO pm_orchestrated_workflows (id, task_id, project_path, status, phase, grant_json, data_json, created_at, updated_at) VALUES (?, ?, ?, 'active', 'implementing', ?, ?, ?, ?)`,
      [
        wfId,
        pausedTask.id,
        pausedProj,
        JSON.stringify(wfGrant),
        JSON.stringify({
          id: wfId,
          taskId: pausedTask.id,
          projectPath: pausedProj,
          status: "active",
          grant: wfGrant,
          progress: {
            phase: "implementing",
            activeEmployeeAttemptId: null,
            activeReviewId: null,
            completedImplementationRunIds: [],
            completedReviewIds: [],
            finishedSteps: [],
            pauseReason: null,
          },
          counters: { launchesUsed: 0, implementationRuns: 0, reviewRuns: 0, reworkIterationsUsed: 0 },
          createdAt: wfNow,
          updatedAt: wfNow,
        }),
        wfNow,
        wfNow,
      ],
    );

    const fxRunId = randomUUID();
    runs.insert({
      id: fxRunId,
      taskId: fxTask.id,
      agent: "fx",
      status: "failed",
      startedAt: wfNow - 1000,
      endedAt: wfNow - 500,
      exitCode: 1,
      tmuxSession: null,
      claudeSessionId: null,
      codexSessionId: null,
      cursorSessionId: null,
      geminiSessionId: null,
      fxSessionId: "fx-sess-1",
      antigravitySessionId: null,
    });
    runs.appendEvent(
      fxRunId,
      "status",
      `fx-recovery: ${JSON.stringify({
        version: 1,
        state: "paused",
        reason: "rate_limit",
        requiredAction: "continue_later",
        summary: "Rate limited",
      })}`,
    );
    tasks.setFxRecovery(fxTask.id, {
      state: "paused",
      runId: fxRunId,
      pausedAt: wfNow,
      autoResume: { at: wfNow + 60_000, attempt: 1, max: 3, delaySec: 60 },
      autoResumeCount: 0,
    });

    // Simulate persisted states left by a prior process before restart:
    projects.setLifecycleState(drainingProj, "draining", "Stop requested before restart", wfNow);
    projects.setLifecycleState(recoveringProj, "recovering", "Interrupted recovery", wfNow);
    projects.setLifecycleState(corruptProj, "corrupt_unknown_xyz", "Corrupt row", wfNow);

    // 11. Controlled boot reconciliation sequence:
    const bootChanges = reconcileProjectLifecyclesOnBoot();
    expect(bootChanges).toBeGreaterThanOrEqual(2);
    recoverOrchestratedWorkflows();
    recoverOrchestratedBatches();
    const armedFx = await rearmFxAutoResumes();
    expect(armedFx).toBe(0);
    // Preserved fxRecovery row untouched on paused project:
    expect(tasks.get(fxTask.id)?.fxRecovery?.runId).toBe(fxRunId);

    await new Promise((r) => setTimeout(r, 80));

    // Paused project stayed paused and launched zero runs!
    expect(projects.getLifecycleRaw(pausedProj)?.lifecycleState).toBe("paused");
    expect(runs.listForTask(pausedTask.id)).toEqual([]);

    // Draining project with 0 live runs settled to Paused on boot.
    expect(projects.getLifecycleRaw(drainingProj)?.lifecycleState).toBe("paused");

    // Interrupted recovering project failed closed to Paused on boot (not Running!).
    expect(projects.getLifecycleRaw(recoveringProj)?.lifecycleState).toBe("paused");

    // Corrupt/unknown state fails closed: blocks launches AND refuses blind Start!
    const corruptSnap = await fetch(url(`/projects/lifecycle?path=${encodeURIComponent(corruptProj)}`), {
      headers: auth(),
    }).then((r) => r.json()) as {
      lifecycle: { state: string; launchesBlocked: boolean; canStart: boolean; canStop: boolean; startUnavailableCode: string };
    };
    expect(corruptSnap.lifecycle.state).toBe("invalid");
    expect(corruptSnap.lifecycle.launchesBlocked).toBe(true);
    expect(corruptSnap.lifecycle.canStart).toBe(false);
    expect(corruptSnap.lifecycle.canStop).toBe(true);
    expect(corruptSnap.lifecycle.startUnavailableCode).toBe("invalid-state");

    const corruptTask = seedTask(corruptProj, "Task in corrupt project");
    const corruptLaunch = await startTask(corruptTask.id);
    expect("error" in corruptLaunch).toBe(true);
    expect(runs.listForTask(corruptTask.id)).toEqual([]);

    const corruptStartRes = await fetch(url("/projects/lifecycle/start"), {
      method: "POST",
      headers: auth(),
      body: JSON.stringify({ path: corruptProj }),
    });
    expect(corruptStartRes.status).toBe(409);
    expect((await corruptStartRes.json() as { code: string }).code).toBe("invalid-state");

    // Resetting corrupt state explicitly via Owner Stop transitions safely to Paused.
    const resetStop = await fetch(url("/projects/lifecycle/stop"), {
      method: "POST",
      headers: auth(),
      body: JSON.stringify({ path: corruptProj }),
    }).then((r) => r.json()) as { lifecycle: { state: string } };
    expect(resetStop.lifecycle.state).toBe("paused");

    // 12. Concurrent Start and Stop requests serialize cleanly and never cause duplicate dispatch!
    const concurrentProj = seedGitProject("concurrent-toggle");
    const concurrentTask = seedTask(concurrentProj, "Concurrent safety task");
    const responses = await Promise.all([
      fetch(url("/projects/lifecycle/stop"), { method: "POST", headers: auth(), body: JSON.stringify({ path: concurrentProj }) }),
      fetch(url("/projects/lifecycle/start"), { method: "POST", headers: auth(), body: JSON.stringify({ path: concurrentProj }) }),
      fetch(url("/projects/lifecycle/stop"), { method: "POST", headers: auth(), body: JSON.stringify({ path: concurrentProj }) }),
      fetch(url("/projects/lifecycle/start"), { method: "POST", headers: auth(), body: JSON.stringify({ path: concurrentProj }) }),
    ]);
    for (const r of responses) expect(r.status).toBe(200);
    expect(runs.listForTask(concurrentTask.id)).toEqual([]);
    const finalConcurrent = await fetch(url(`/projects/lifecycle?path=${encodeURIComponent(concurrentProj)}`), {
      headers: auth(),
    }).then((r) => r.json()) as { lifecycle: { state: string } };
    expect(["running", "paused"]).toContain(finalConcurrent.lifecycle.state);
  });
});
