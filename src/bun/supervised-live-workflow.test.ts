import { afterAll, beforeAll, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { makeTask } from "../cli/test-fixtures.ts";
import path from "node:path";

const DATA_DIR = mkdtempSync(path.join(tmpdir(), "fo-live01-"));
process.env.AGETOR_DATA_DIR = DATA_DIR;
process.env.AGETOR_API_PORT = "4417";
process.env.AGETOR_CLAUDE_DRIVER = "fake";

let server: { stop: () => void };
let token: string;
let tasks: typeof import("./db.ts").tasks;
let projects: typeof import("./db.ts").projects;

beforeAll(async () => {
  ({ tasks, projects } = await import("./db.ts"));
  const { startApiServer, API_TOKEN } = await import("./server.ts");
  server = startApiServer() as unknown as { stop: () => void };
  token = API_TOKEN;
});

afterAll(() => {
  server?.stop?.();
});

const url = (p: string) => `http://127.0.0.1:4417${p}`;
const auth = () => ({ authorization: `Bearer ${token}` });

test("supervised-workflow endpoint reflects backlog → inbox → ready", async () => {
  const workdir = mkdtempSync(path.join(tmpdir(), "fo-live-wf-"));
  projects.upsert(workdir, "Live");
  const now = Date.now();
  const task = tasks.insert(makeTask({
    id: randomUUID(),
    title: "Live workflow",
    prompt: "Say hi",
    column: "backlog",
    workdir,
    model: "opus-5.5",
    effort: "high",
    mode: "auto",
    createdAt: now,
    updatedAt: now,
  }));

  let res = await fetch(url(`/tasks/${task.id}/supervised-workflow`), { headers: auth() });
  expect(res.status).toBe(200);
  expect((await res.json()).phase).toBe("backlog-draft");

  const { admitTaskToInbox } = await import("./pm-intake.ts");
  admitTaskToInbox(task.id, workdir);
  res = await fetch(url(`/tasks/${task.id}/supervised-workflow`), { headers: auth() });
  expect((await res.json()).phase).toBe("inbox-triage");

  tasks.update(task.id, { column: "ready" });
  res = await fetch(url(`/tasks/${task.id}/supervised-workflow`), { headers: auth() });
  const body = await res.json();
  expect(body.phase).toBe("ready-prepare");
  expect(body.usesFakeDriver).toBe(false); // No persisted dispatch yet; global fake settings are not run evidence.
});

test("missing harness surfaces clear QC start error", async () => {
  const workdir = mkdtempSync(path.join(tmpdir(), "fo-live-miss-"));
  projects.upsert(workdir, "Miss");
  const now = Date.now();
  const task = tasks.insert(makeTask({
    id: randomUUID(),
    title: "QC miss",
    prompt: "x",
    column: "review",
    workdir,
    model: "opus-5.5",
    effort: "high",
    mode: "auto",
    createdAt: now,
    updatedAt: now,
  }));
  const { startTask } = await import("./orchestrator.ts");
  const started = await startTask(task.id);
  if ("error" in started) throw new Error(started.error);
  const deadline = Date.now() + 8000;
  while (Date.now() < deadline && tasks.get(task.id)?.column !== "review") {
    await new Promise((r) => setTimeout(r, 50));
  }
  const prep = await fetch(url(`/tasks/${task.id}/qc/reviews`), {
    method: "POST",
    headers: { ...auth(), "content-type": "application/json" },
    body: JSON.stringify({ reviewerHarness: "no-such-harness-xyz", reviewerModel: "opus-5.5" }),
  });
  expect(prep.status).toBe(400);
  expect((await prep.json()).error).toContain("Unknown harness");
});

test("project rules snapshot on implementation run", async () => {
  const workdir = mkdtempSync(path.join(tmpdir(), "fo-live-rules-"));
  projects.upsert(workdir, "Rules");
  const { projectRules, runs } = await import("./db.ts");
  projectRules.insert({
    id: randomUUID(),
    projectPath: workdir,
    name: "Style",
    body: "Use small functions.",
    enabled: true,
    sortOrder: 0,
  });
  const now = Date.now();
  const task = tasks.insert(makeTask({
    id: randomUUID(),
    title: "Rules task",
    prompt: "implement",
    column: "ready",
    workdir,
    model: "opus-5.5",
    effort: "high",
    mode: "auto",
    createdAt: now,
    updatedAt: now,
  }));
  const { startTask } = await import("./orchestrator.ts");
  const started = await startTask(task.id);
  if ("error" in started) throw new Error(started.error);
  const run = runs.get(started.runId);
  expect(run?.projectRulesSnapshot?.rules.some((r) => r.body.includes("small functions"))).toBe(true);
});
