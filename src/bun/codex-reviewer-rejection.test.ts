/**
 * Offline Codex reviewer rejection. Fake driver only: no provider process.
 */
import { afterAll, beforeAll, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { writeCodexProfileFixture, writeSyntheticCodexProfile } from "../../e2e/codex-profile-fixture.ts";
import { makeTask } from "../cli/test-fixtures.ts";

const root = realpathSync(mkdtempSync(path.join(tmpdir(), "fo-codex-reject-")));
const ownerHome = path.join(root, "owner");
mkdirSync(ownerHome);
process.env.HOME = ownerHome;
process.env.AGETOR_DATA_DIR = path.join(root, "data");
process.env.AGETOR_API_PORT = "4438";
process.env.AGETOR_CODEX_DRIVER = "fake";
process.env.AGETOR_CODEX_BIN = writeCodexProfileFixture(root, process.execPath);
process.env.AGETOR_FAKE_QC_VERDICT = "PASS";
process.env.AGETOR_USAGE_OFFLINE = "1";
process.env.AGETOR_DISABLE_UPDATES = "1";
process.env.AGETOR_ALLOW_LEGACY_QUEUE_POLICY_SCHEMA = "1";

let server: { stop: () => void };
let token: string;
let tasks: typeof import("./db.ts").tasks;
let projects: typeof import("./db.ts").projects;
let db: typeof import("./db.ts").db;

beforeAll(async () => {
  ({ tasks, projects, db } = await import("./db.ts"));
  const { startApiServer, API_TOKEN } = await import("./server.ts");
  const { initOrchestratedWorkflows, recoverOrchestratedWorkflows } = await import("./pm-orchestrated-workflow.ts");
  const { initOrchestratedBatches, recoverOrchestratedBatches } = await import("./pm-orchestrated-batch.ts");
  initOrchestratedWorkflows();
  initOrchestratedBatches();
  server = startApiServer() as unknown as { stop: () => void };
  token = API_TOKEN;
  recoverOrchestratedWorkflows();
  recoverOrchestratedBatches();
});

afterAll(() => {
  server?.stop?.();
  db?.close?.();
  rmSync(root, { recursive: true, force: true });
});

const url = (p: string) => `http://127.0.0.1:4438${p}`;
const auth = () => ({ authorization: `Bearer ${token}`, "content-type": "application/json" });

test("failed reviewer model_not_found pauses the batch without a QC verdict or a second task", async () => {
  const { CodexProfiles } = await import("./codex-profiles.ts");
  const { AccountCore } = await import("./account-core.ts");
  const { subscribeGlobal } = await import("./orchestrator.ts");
  const { runs } = await import("./db.ts");
  const { recoverOrchestratedBatches } = await import("./pm-orchestrated-batch.ts");
  const { recoverOrchestratedWorkflows } = await import("./pm-orchestrated-workflow.ts");
  const profiles = new CodexProfiles();
  const core = new AccountCore(db);
  const dirA = path.join(ownerHome, "profile-a");
  const dirB = path.join(ownerHome, "profile-b");
  writeSyntheticCodexProfile(dirA, "subject-a");
  writeSyntheticCodexProfile(dirB, "subject-b");
  const profileA = profiles.register({ displayName: "Profile A", directory: dirA });
  const profileB = profiles.register({ displayName: "Profile B", directory: dirB });
  expect((await profiles.check(profileA.accountId)).authentication).toBe("authenticated");
  expect((await profiles.check(profileB.accountId)).authentication).toBe("authenticated");

  const workdir = path.join(root, "project");
  mkdirSync(workdir);
  projects.upsert(workdir, "Reject Co");
  const now = Date.now();
  const taskA = tasks.insert(makeTask({
    id: randomUUID(), title: "Task A", prompt: "Implement shift", column: "ready", workdir,
    agent: profileA.harnessId, model: "gpt-6.1-sol", effort: "low", mode: "auto", isolation: "none",
    createdAt: now, updatedAt: now,
  }));
  const taskB = tasks.insert(makeTask({
    id: randomUUID(), title: "Task B", prompt: "Implement clamp", column: "ready", workdir,
    agent: profileB.harnessId, model: "gpt-6.1-sol", effort: "low", mode: "auto", isolation: "none",
    createdAt: now, updatedAt: now,
  }));
  const devA = await fetch(url("/employees"), {
    method: "POST", headers: auth(),
    body: JSON.stringify({ name: "Developer A", jobTitle: "Eng", projectPath: workdir }),
  }).then((r) => r.json()) as { id: string };
  const devB = await fetch(url("/employees"), {
    method: "POST", headers: auth(),
    body: JSON.stringify({ name: "Developer B", jobTitle: "Eng", projectPath: workdir }),
  }).then((r) => r.json()) as { id: string };
  await fetch(url("/task-assignments"), { method: "POST", headers: auth(), body: JSON.stringify({ taskId: taskA.id, employeeId: devA.id }) });
  await fetch(url("/task-assignments"), { method: "POST", headers: auth(), body: JSON.stringify({ taskId: taskB.id, employeeId: devB.id }) });

  const draft = await fetch(url("/project-manager/orchestrated-batches"), {
    method: "POST", headers: auth(),
    body: JSON.stringify({ path: workdir, taskIds: [taskA.id, taskB.id] }),
  });
  expect(draft.status).toBe(201);
  const batch = (await draft.json()).batch as { id: string; revision: number };
  const approved = await fetch(url(`/project-manager/orchestrated-batches/${batch.id}/approve`), {
    method: "POST", headers: auth(),
    body: JSON.stringify({
      path: workdir,
      revision: batch.revision,
      queuePolicySchema: "legacy-auto02",
      defaults: {
        implementerEmployeeId: devA.id,
        implementerHarnessId: profileA.harnessId,
        implementerModel: "gpt-6.1-sol",
        implementerMode: "auto",
        implementerEffort: "low",
        reviewerHarness: profileB.harnessId,
        reviewerModel: "gpt-6.1-sol",
        reviewerMode: "ask",
        autoReviewAfterImplementation: true,
        autoReworkOnChanges: false,
        maxLaunches: 2,
        maxReworkIterations: 0,
      },
      perTask: {
        [taskB.id]: { implementerEmployeeId: devB.id, implementerHarnessId: profileB.harnessId, implementerModel: "gpt-6.1-sol", implementerMode: "auto", implementerEffort: "low" },
      },
      validMinutes: 90,
    }),
  });
  expect(approved.status, await approved.clone().text()).toBe(200);

  const unsubscribe = subscribeGlobal((event) => {
    if (event.kind === "run-status" && event.taskId === taskA.id && event.status === "succeeded" && !runs.get(event.runId)?.qcReviewId) {
      process.env.AGETOR_FAKE_QC_VERDICT = "MODEL_NOT_FOUND";
    }
  });
  try {
    const started = await fetch(url(`/project-manager/orchestrated-batches/${batch.id}/start`), {
      method: "POST", headers: auth(), body: JSON.stringify({ path: workdir }),
    });
    expect(started.status, await started.clone().text()).toBe(200);
    const deadline = Date.now() + 60_000;
    let settled = false;
    while (Date.now() < deadline) {
      const view = await fetch(url(`/project-manager/orchestrated-batches/${batch.id}?path=${encodeURIComponent(workdir)}`), { headers: auth() }).then((r) => r.json()) as { batch: { status: string }; blocker: string | null };
      if (view.batch.status === "paused" && tasks.get(taskA.id)?.column === "blocked") {
        settled = true;
        expect(view.blocker ?? "").toContain("not supported when using Codex with a ChatGPT account");
        break;
      }
      await new Promise((r) => setTimeout(r, 100));
    }
    expect(settled).toBe(true);
  } finally {
    unsubscribe();
    process.env.AGETOR_FAKE_QC_VERDICT = "PASS";
  }

  const runsA = await fetch(url(`/tasks/${taskA.id}/runs`), { headers: auth() }).then((r) => r.json()) as { id: string; agent: string; status: string; qcReviewId: string | null }[];
  expect(runsA).toHaveLength(2);
  expect(runsA.filter((r) => r.status === "succeeded" && !r.qcReviewId).map((r) => r.agent)).toEqual([profileA.harnessId]);
  const reviewRun = runsA.find((r) => r.qcReviewId);
  expect(reviewRun).toMatchObject({ status: "failed", agent: profileB.harnessId });
  const stderr = runs.events(reviewRun!.id).filter((e) => e.stream === "stderr").map((e) => e.data).join("\n");
  expect(stderr).toContain("model_not_found");
  expect(stderr).toContain("The 'gpt-6.1-sol' model is not supported when using Codex with a ChatGPT account.");

  const qc = await fetch(url(`/tasks/${taskA.id}/qc`), { headers: auth() }).then((r) => r.json()) as { state: { latestVerdict: string | null; awaitingOwnerApproval: boolean }; reviews: { verdict: string | null; summary: string | null }[] };
  expect(qc.state.latestVerdict).toBeNull();
  expect(qc.state.awaitingOwnerApproval).toBe(false);
  expect(qc.reviews).toHaveLength(1);
  expect(qc.reviews[0]?.verdict).toBeNull();
  expect(qc.reviews[0]?.summary).toContain("Profile B");
  expect(qc.reviews[0]?.summary).toContain("No other model or account was selected");
  expect(tasks.get(taskA.id)?.column).toBe("blocked");
  expect(tasks.get(taskA.id)?.agent).toBe(profileA.harnessId);
  expect(tasks.get(taskB.id)?.column).toBe("ready");
  expect(await fetch(url(`/tasks/${taskB.id}/runs`), { headers: auth() }).then((r) => r.json())).toEqual([]);

  const capsA = core.modelCapabilities(profileA.accountId);
  const capsB = core.modelCapabilities(profileB.accountId);
  expect(capsA.some((c) => c.support === "unsupported")).toBe(false);
  const rejection = capsB.find((c) => c.modelId === "gpt-6.1-sol" && c.harnessId === profileB.harnessId);
  expect(rejection).toMatchObject({ support: "unsupported", verification: "verified", source: "codex-provider-model-rejection" });
  expect(rejection!.expiresAt).not.toBeNull();
  expect(rejection!.expiresAt! - rejection!.observedAt).toBeLessThanOrEqual(24 * 60 * 60 * 1000);
  expect((await profiles.check(profileB.accountId)).authentication).toBe("authenticated");

  const before = runsA.length;
  recoverOrchestratedBatches();
  recoverOrchestratedWorkflows();
  await new Promise((r) => setTimeout(r, 400));
  const after = await fetch(url(`/tasks/${taskA.id}/runs`), { headers: auth() }).then((r) => r.json()) as unknown[];
  expect(after).toHaveLength(before);
  expect(tasks.get(taskB.id)?.column).toBe("ready");
  const resumed = await fetch(url(`/project-manager/orchestrated-batches/${batch.id}/resume`), {
    method: "POST", headers: auth(), body: JSON.stringify({ path: workdir }),
  });
  expect(resumed.status).toBe(409);
  expect(await resumed.text()).toContain("Reviewer process failed");
  expect(tasks.get(taskA.id)?.column).not.toBe("done");
  expect(tasks.get(taskB.id)?.column).toBe("ready");
});
