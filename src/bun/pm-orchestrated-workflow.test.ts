import { afterAll, beforeAll, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { makeTask } from "../cli/test-fixtures.ts";
import path from "node:path";

const DATA_DIR = mkdtempSync(path.join(tmpdir(), "fo-auto01-"));
process.env.AGETOR_DATA_DIR = DATA_DIR;
process.env.AGETOR_API_PORT = "4421";
process.env.AGETOR_CLAUDE_DRIVER = "fake";
process.env.AGETOR_FAKE_QC_VERDICT = "PASS";

let server: { stop: () => void };
let token: string;
let tasks: typeof import("./db.ts").tasks;
let projects: typeof import("./db.ts").projects;

beforeAll(async () => {
  ({ tasks, projects } = await import("./db.ts"));
  const { startApiServer, API_TOKEN } = await import("./server.ts");
  const { initOrchestratedWorkflows, recoverOrchestratedWorkflows } = await import("./pm-orchestrated-workflow.ts");
  initOrchestratedWorkflows();
  server = startApiServer() as unknown as { stop: () => void };
  token = API_TOKEN;
  recoverOrchestratedWorkflows();
});

afterAll(() => {
  server?.stop?.();
});

const url = (p: string) => `http://127.0.0.1:4421${p}`;
const auth = () => ({ authorization: `Bearer ${token}`, "content-type": "application/json" });

async function seedReadyTask(title: string) {
  const workdir = mkdtempSync(path.join(tmpdir(), "fo-auto-task-"));
  projects.upsert(workdir, "Auto");
  const now = Date.now();
  return tasks.insert(makeTask({
    id: randomUUID(),
    title,
    prompt: "Say hi in README",
    column: "ready",
    workdir,
    model: "opus-5.5",
    effort: "high",
    mode: "auto",
    createdAt: now,
    updatedAt: now,
  }));
}

test("FO-AUTO01: approve grant and run bounded implement → QC → awaiting owner", async () => {
  const task = await seedReadyTask("Orchestrated");
  const employee = (await fetch(url("/employees"), {
    method: "POST",
    headers: auth(),
    body: JSON.stringify({ name: "Dev", jobTitle: "Eng", projectPath: task.workdir }),
  }).then((r) => r.json())) as { id: string };

  await fetch(url("/task-assignments"), {
    method: "POST",
    headers: auth(),
    body: JSON.stringify({ taskId: task.id, employeeId: employee.id }),
  });

  const approve = await fetch(url(`/tasks/${task.id}/orchestrated-workflow`), {
    method: "POST",
    headers: auth(),
    body: JSON.stringify({
      implementerEmployeeId: employee.id,
      implementerHarnessId: "claude-code",
      implementerModel: "opus-5.5",
      reviewerHarness: "claude-code",
      reviewerModel: "haiku-5.5",
      autoReviewAfterImplementation: true,
      autoReworkOnChanges: false,
      maxLaunches: 2,
    }),
  });
  expect(approve.status).toBe(200);
  expect((await approve.json()).workflow?.status).toBe("active");

  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    const view = await fetch(url(`/tasks/${task.id}/orchestrated-workflow`), { headers: auth() }).then((r) => r.json());
    if (view.workflow?.status === "awaiting_owner") break;
    await new Promise((r) => setTimeout(r, 200));
  }

  const final = await fetch(url(`/tasks/${task.id}/orchestrated-workflow`), { headers: auth() }).then((r) => r.json());
  expect(final.workflow.status).toBe("awaiting_owner");
  const qc = await fetch(url(`/tasks/${task.id}/qc`), { headers: auth() }).then((r) => r.json());
  expect(qc.state.awaitingOwnerApproval).toBe(true);
  expect(qc.state.latestVerdict).toBe("PASS");

  // The historical grant stays available after Owner acceptance, but must no
  // longer inflate Needs You or ask the Owner to accept an already-Done task.
  const holdsBefore = await fetch(url("/owner-actions"), { headers: auth() }).then((r) => r.json());
  expect(holdsBefore.orchestratedWorkflowHolds.some((h: { taskId: string }) => h.taskId === task.id)).toBe(true);
  const accepted = await fetch(url(`/tasks/${task.id}`), {
    method: "PATCH", headers: auth(), body: JSON.stringify({ column: "done" }),
  });
  expect(accepted.status).toBe(200);
  const holdsAfter = await fetch(url("/owner-actions"), { headers: auth() }).then((r) => r.json());
  expect(holdsAfter.orchestratedWorkflowHolds.some((h: { taskId: string }) => h.taskId === task.id)).toBe(false);
  const after = await fetch(url(`/tasks/${task.id}/orchestrated-workflow`), { headers: auth() }).then((r) => r.json());
  expect(after.ownerAction).toBeNull();
  expect(after.workflow).toEqual(final.workflow);
});

test("backlog cannot approve orchestration", async () => {
  const task = await seedReadyTask("Backlog block");
  tasks.update(task.id, { column: "backlog" });
  const res = await fetch(url(`/tasks/${task.id}/orchestrated-workflow`), {
    method: "POST",
    headers: auth(),
    body: JSON.stringify({
      implementerEmployeeId: "x",
      implementerHarnessId: "claude-code",
      implementerModel: "opus-5.5",
      reviewerHarness: "claude-code",
      reviewerModel: "haiku-5.5",
    }),
  });
  expect(res.status).toBe(409);
});

test("CHANGES_REQUESTED pauses when rework not authorized", async () => {
  process.env.AGETOR_FAKE_QC_VERDICT = "CHANGES_REQUESTED";
  const task = await seedReadyTask("No rework");
  const employee = (await fetch(url("/employees"), {
    method: "POST",
    headers: auth(),
    body: JSON.stringify({ name: "Dev2", jobTitle: "Eng", projectPath: task.workdir }),
  }).then((r) => r.json())) as { id: string };
  await fetch(url("/task-assignments"), { method: "POST", headers: auth(), body: JSON.stringify({ taskId: task.id, employeeId: employee.id }) });
  await fetch(url(`/tasks/${task.id}/orchestrated-workflow`), {
    method: "POST",
    headers: auth(),
    body: JSON.stringify({
      implementerEmployeeId: employee.id,
      implementerHarnessId: "claude-code",
      implementerModel: "opus-5.5",
      reviewerHarness: "claude-code",
      reviewerModel: "haiku-5.5",
      autoReworkOnChanges: false,
      maxLaunches: 2,
    }),
  });

  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    const view = await fetch(url(`/tasks/${task.id}/orchestrated-workflow`), { headers: auth() }).then((r) => r.json());
    if (view.workflow?.status === "paused") break;
    await new Promise((r) => setTimeout(r, 200));
  }
  const view = await fetch(url(`/tasks/${task.id}/orchestrated-workflow`), { headers: auth() }).then((r) => r.json());
  expect(view.workflow.status).toBe("paused");
  expect(view.workflow.progress.pauseReason).toContain("Rework");
  process.env.AGETOR_FAKE_QC_VERDICT = "PASS";
});
