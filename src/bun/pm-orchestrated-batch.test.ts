import { afterAll, beforeAll, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { makeTask } from "../cli/test-fixtures.ts";

const DATA_DIR = mkdtempSync(path.join(tmpdir(), "fo-auto02-"));
process.env.AGETOR_DATA_DIR = DATA_DIR;
process.env.AGETOR_API_PORT = "4422";
process.env.AGETOR_ALLOW_LEGACY_QUEUE_POLICY_SCHEMA = "1";
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
});

const url = (p: string) => `http://127.0.0.1:4422${p}`;
const auth = () => ({ authorization: `Bearer ${token}`, "content-type": "application/json" });

async function seedProject(name: string) {
  const workdir = mkdtempSync(path.join(tmpdir(), `fo-auto02-proj-${name}-`));
  projects.upsert(workdir, name);
  return workdir;
}

async function seedReadyTask(workdir: string, title: string) {
  const now = Date.now();
  return tasks.insert(makeTask({
    id: randomUUID(),
    title,
    prompt: "Implement feature",
    column: "ready",
    workdir,
    model: "opus-5.5",
    effort: "high",
    mode: "auto",
    createdAt: now,
    updatedAt: now,
  }));
}

async function employeeFor(projectPath: string, name: string) {
  return (await fetch(url("/employees"), {
    method: "POST",
    headers: auth(),
    body: JSON.stringify({ name, jobTitle: "Eng", projectPath }),
  }).then((r) => r.json())) as { id: string };
}

async function assign(taskId: string, employeeId: string) {
  await fetch(url("/task-assignments"), { method: "POST", headers: auth(), body: JSON.stringify({ taskId, employeeId }) });
}

const grantBody = (employeeId: string) => ({
  queuePolicySchema: "legacy-auto02" as const,
  defaults: {
    implementerEmployeeId: employeeId,
    implementerHarnessId: "claude-code",
    implementerModel: "opus-5.5",
    reviewerHarness: "claude-code",
    reviewerModel: "haiku-5.5",
    autoReviewAfterImplementation: true,
    autoReworkOnChanges: false,
    maxLaunches: 2,
  },
});

test("FO-DEEPSEEK01: two Ready tasks cannot approve or start with unsupported Developer or Reviewer", async () => {
  const dir = await seedProject("DeepSeek-blocked");
  const a = await seedReadyTask(dir, "DeepSeek A"), b = await seedReadyTask(dir, "DeepSeek B");
  const dev = await employeeFor(dir, "DeepSeek Developer");
  await assign(a.id, dev.id); await assign(b.id, dev.id);
  const response = await fetch(url("/project-manager/orchestrated-batches"), {
    method: "POST", headers: auth(), body: JSON.stringify({ path: dir, taskIds: [a.id, b.id] }),
  });
  expect(response.status).toBe(201);
  const draft = await response.json() as { batch: { id: string; revision: number } };
  for (const role of ["implementerHarnessId", "reviewerHarness"] as const) {
    const defaults = { ...grantBody(dev.id).defaults, [role]: "deepseek-dsh" };
    // Repeated approval cannot create a grant/run or silently substitute Claude.
    for (let i = 0; i < 2; i++) {
      const rejected = await fetch(url(`/project-manager/orchestrated-batches/${draft.batch.id}/approve`), {
        method: "POST", headers: auth(), body: JSON.stringify({ path: dir, revision: draft.batch.revision, queuePolicySchema: "legacy-auto02", defaults }),
      });
      expect([400, 409]).toContain(rejected.status);
      expect(await rejected.text()).toMatch(/Unknown harness|resource is missing or disabled/i);
    }
  }
  const start = await fetch(url(`/project-manager/orchestrated-batches/${draft.batch.id}/start`), {
    method: "POST", headers: auth(), body: JSON.stringify({ path: dir }),
  });
  expect(start.status).toBe(409);
  for (const task of [a, b]) {
    expect(tasks.get(task.id)?.column).toBe("ready");
    expect(tasks.get(task.id)?.agent).toBe("claude-code");
    const history = await fetch(url(`/tasks/${task.id}/runs`), { headers: auth() }).then(r => r.json());
    expect(history).toEqual([]);
  }
});

test("FO-AUTO02: multi-task batch runs task1 PASS then task2 without re-approval", async () => {
  const dirA = await seedProject("A");
  const dirB = await seedProject("B");
  const t1 = await seedReadyTask(dirA, "Task one");
  const t2 = await seedReadyTask(dirA, "Task two");
  const tB = await seedReadyTask(dirB, "Other project");
  const dev = await employeeFor(dirA, "DevA");
  await assign(t1.id, dev.id);
  await assign(t2.id, dev.id);

  const draft = await fetch(url("/project-manager/orchestrated-batches"), {
    method: "POST",
    headers: auth(),
    body: JSON.stringify({ path: dirA, taskIds: [t1.id, t2.id, tB.id] }),
  });
  expect(draft.status).toBe(404);

  const draftOk = await fetch(url("/project-manager/orchestrated-batches"), {
    method: "POST",
    headers: auth(),
    body: JSON.stringify({ path: dirA, taskIds: [t1.id, t2.id] }),
  });
  expect(draftOk.status).toBe(201);
  const batch = (await draftOk.json()).batch as { id: string; revision: number };

  const backlog = await seedReadyTask(dirA, "Backlog block");
  tasks.update(backlog.id, { column: "backlog" });
  const bad = await fetch(url("/project-manager/orchestrated-batches"), {
    method: "POST",
    headers: auth(),
    body: JSON.stringify({ path: dirA, taskIds: [backlog.id] }),
  });
  expect(bad.status).toBe(409);

  await fetch(url(`/project-manager/orchestrated-batches/${batch.id}/approve`), {
    method: "POST",
    headers: auth(),
    body: JSON.stringify({ path: dirA, revision: batch.revision, ...grantBody(dev.id) }),
  });

  await fetch(url(`/project-manager/orchestrated-batches/${batch.id}/start`), {
    method: "POST",
    headers: auth(),
    body: JSON.stringify({ path: dirA }),
  });

  const deadline = Date.now() + 120_000;
  let t1Done = false;
  let t2Started = false;
  let t2Reviewed = false;
  while (Date.now() < deadline) {
    const view = await fetch(url(`/project-manager/orchestrated-batches/${batch.id}?path=${encodeURIComponent(dirA)}`), { headers: auth() }).then((r) => r.json());
    const rows = view.tasks as { taskId: string; phase: string }[];
    if (rows.find((r) => r.taskId === t1.id)?.phase === "awaiting_owner") t1Done = true;
    if (rows.find((r) => r.taskId === t2.id)?.phase !== "queued") t2Started = true;
    t2Reviewed = rows.find((r) => r.taskId === t2.id)?.phase === "awaiting_owner";
    // Let the whole batch settle before the next test changes the fake verdict.
    if (t1Done && t2Reviewed) break;
    await new Promise((r) => setTimeout(r, 250));
  }
  expect(t1Done).toBe(true);
  expect(t2Started).toBe(true);
  expect(t2Reviewed).toBe(true);
}, 120_000);

test("FO-AUTO02: CHANGES_REQUESTED on second task pauses batch when rework disabled", async () => {
  process.env.AGETOR_FAKE_QC_VERDICT = "PASS";
  const dir = await seedProject("Pause");
  const t1 = await seedReadyTask(dir, "First");
  const t2 = await seedReadyTask(dir, "Second");
  const { subscribeGlobal } = await import("./orchestrator.ts");
  const { runs } = await import("./db.ts");
  // Select B's fixture verdict at its implementation settlement, before its
  // automatic QC prompt is assembled. Polling A's PASS can miss that window.
  const unsubscribe = subscribeGlobal((event) => {
    if (event.kind === "run-status" && event.taskId === t2.id && event.status === "succeeded" && !runs.get(event.runId)?.qcReviewId) {
      process.env.AGETOR_FAKE_QC_VERDICT = "CHANGES_REQUESTED";
    }
  });
  try {
    const dev = await employeeFor(dir, "DevB");
    await assign(t1.id, dev.id);
    await assign(t2.id, dev.id);
    const draft = await fetch(url("/project-manager/orchestrated-batches"), {
      method: "POST",
      headers: auth(),
      body: JSON.stringify({ path: dir, taskIds: [t1.id, t2.id] }),
    }).then((r) => r.json());
    await fetch(url(`/project-manager/orchestrated-batches/${draft.batch.id}/approve`), {
      method: "POST",
      headers: auth(),
      body: JSON.stringify({ path: dir, revision: draft.batch.revision, ...grantBody(dev.id) }),
    });
    await fetch(url(`/project-manager/orchestrated-batches/${draft.batch.id}/start`), {
      method: "POST",
      headers: auth(),
      body: JSON.stringify({ path: dir }),
    });
    const deadline2 = Date.now() + 120_000;
    while (Date.now() < deadline2) {
      const batch = await fetch(url(`/project-manager/orchestrated-batches/${draft.batch.id}?path=${encodeURIComponent(dir)}`), { headers: auth() }).then((r) => r.json());
      if (batch.batch.status === "paused") break;
      await new Promise((r) => setTimeout(r, 250));
    }
    const final = await fetch(url(`/project-manager/orchestrated-batches/${draft.batch.id}?path=${encodeURIComponent(dir)}`), { headers: auth() }).then((r) => r.json());
    expect(final.batch.status).toBe("paused");
    expect(final.tasks.map((t: { phase: string }) => t.phase)).toEqual(["awaiting_owner", "paused"]);
    expect(tasks.get(t1.id)?.qcState?.latestVerdict).toBe("PASS");
    expect(tasks.get(t2.id)?.qcState?.latestVerdict).toBe("CHANGES_REQUESTED");
  } finally {
    unsubscribe();
    process.env.AGETOR_FAKE_QC_VERDICT = "PASS";
  }
}, 120_000);

test("FO-AUTO02: pause prevents further task launches", async () => {
  const dir = await seedProject("Hold");
  const t1 = await seedReadyTask(dir, "Only");
  const dev = await employeeFor(dir, "DevC");
  await assign(t1.id, dev.id);
  const draft = await fetch(url("/project-manager/orchestrated-batches"), {
    method: "POST",
    headers: auth(),
    body: JSON.stringify({ path: dir, taskIds: [t1.id] }),
  }).then((r) => r.json());
  await fetch(url(`/project-manager/orchestrated-batches/${draft.batch.id}/approve`), {
    method: "POST",
    headers: auth(),
    body: JSON.stringify({ path: dir, revision: draft.batch.revision, ...grantBody(dev.id) }),
  });
  await fetch(url(`/project-manager/orchestrated-batches/${draft.batch.id}/pause`), {
    method: "POST",
    headers: auth(),
    body: JSON.stringify({ path: dir }),
  });
  const start = await fetch(url(`/project-manager/orchestrated-batches/${draft.batch.id}/start`), {
    method: "POST",
    headers: auth(),
    body: JSON.stringify({ path: dir }),
  });
  expect(start.status).toBeGreaterThanOrEqual(400);
});
