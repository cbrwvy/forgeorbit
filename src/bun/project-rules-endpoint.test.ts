import { test, expect, beforeAll, afterAll } from "bun:test";
import { randomUUID } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { composeProjectRulesPrompt, renderProjectRulesForManager, snapshotProjectRules } from "../shared/project-rules.ts";
import { buildManagerPrompt, DEFAULT_MANAGER_CONFIG, type ManagerPromptContext } from "../shared/project-manager.ts";

const DATA_DIR = mkdtempSync(path.join(tmpdir(), "fo-project-rules-"));
process.env.AGETOR_DATA_DIR = DATA_DIR;
process.env.AGETOR_API_PORT = "4402";

let server: { stop: () => void };
let token: string;
let projects: typeof import("./db.ts").projects;
let projectRules: typeof import("./db.ts").projectRules;
let runs: typeof import("./db.ts").runs;
let tasks: typeof import("./db.ts").tasks;

beforeAll(async () => {
  ({ projects, projectRules, runs, tasks } = await import("./db.ts"));
  const { startApiServer, API_TOKEN } = await import("./server.ts");
  server = startApiServer() as unknown as { stop: () => void };
  token = API_TOKEN;
});

afterAll(() => {
  server?.stop?.();
});

const url = (p: string) => `http://127.0.0.1:4402${p}`;
const auth = () => ({ authorization: `Bearer ${token}` });

test("CRUD persists across reload and scopes by project", async () => {
  const a = "/tmp/fo-rules-a";
  const b = "/tmp/fo-rules-b";
  projects.upsert(a, "A");
  projects.upsert(b, "B");

  const create = await fetch(url("/projects/rules"), {
    method: "POST",
    headers: { ...auth(), "content-type": "application/json" },
    body: JSON.stringify({ path: a, name: "Alpha", body: "Rule A" }),
  });
  expect(create.status).toBe(200);
  const { rule } = (await create.json()) as { rule: { id: string } };

  await fetch(url("/projects/rules"), {
    method: "POST",
    headers: { ...auth(), "content-type": "application/json" },
    body: JSON.stringify({ path: b, name: "Beta", body: "Rule B" }),
  });

  const listA = await fetch(url(`/projects/rules?path=${encodeURIComponent(a)}`), { headers: auth() });
  const payloadA = (await listA.json()) as { rules: { name: string }[] };
  expect(payloadA.rules).toHaveLength(1);
  expect(payloadA.rules[0]!.name).toBe("Alpha");

  const patch = await fetch(url(`/projects/rules/${rule.id}`), {
    method: "PATCH",
    headers: { ...auth(), "content-type": "application/json" },
    body: JSON.stringify({ path: a, body: "Updated A", enabled: false }),
  });
  expect(patch.status).toBe(200);

  const after = await fetch(url(`/projects/rules?path=${encodeURIComponent(a)}`), { headers: auth() });
  const payloadAfter = (await after.json()) as { rules: { body: string; enabled: boolean }[] };
  expect(payloadAfter.rules[0]!.body).toBe("Updated A");
  expect(payloadAfter.rules[0]!.enabled).toBe(false);

  await fetch(url(`/projects/rules/${rule.id}?path=${encodeURIComponent(a)}`), { method: "DELETE", headers: auth() });
  expect(projectRules.list(a)).toHaveLength(0);
});

test("PM prompt includes only active rules for the project", () => {
  const ctx: ManagerPromptContext = {
    name: "Demo",
    path: "/tmp/fo-rules-a",
    description: "",
    stack: "unknown",
    signals: [],
    gitBranch: null,
    documents: [],
    missingDocuments: [],
    backlog: [],
    counts: { backlog: 0, inbox: 0, ready: 0, running: 0, blocked: 0, review: 0, done: 0 },
    archivedCount: 0,
    backlogOmitted: 0,
    running: [],
    blocked: [],
    environment: null,
  };
  const rules = [
    {
      id: "1",
      projectPath: "/tmp/fo-rules-a",
      name: "Lint",
      body: "Run eslint before commit.",
      enabled: true,
      sortOrder: 0,
      createdAt: 1,
      updatedAt: 1,
    },
    {
      id: "2",
      projectPath: "/tmp/fo-rules-a",
      name: "Off",
      body: "Skip approvals.",
      enabled: false,
      sortOrder: 1,
      createdAt: 1,
      updatedAt: 1,
    },
  ];
  const prompt = buildManagerPrompt({
    context: ctx,
    config: DEFAULT_MANAGER_CONFIG,
    decisions: [],
    history: [],
    message: "Plan next work",
    projectRules: rules,
    nonce: "abcd1234",
  });
  expect(prompt).toContain("Run eslint before commit.");
  expect(prompt).not.toContain("Skip approvals.");
  expect(renderProjectRulesForManager("/tmp/other", rules)).toContain("/tmp/other");
});

test("run stores rules snapshot at launch", async () => {
  const p = "/tmp/fo-rules-run";
  projects.upsert(p, "Run");
  projectRules.insert({
    id: "rule-1",
    projectPath: p,
    name: "Launch",
    body: "Use bun test.",
    enabled: true,
    sortOrder: 0,
  });
  const snap = snapshotProjectRules(p, projectRules.list(p));
  const now = Date.now();
  const task = tasks.insert({
    id: randomUUID(),
    title: "T",
    prompt: "Go",
    workdir: p,
    agent: "claude-code",
    column: "ready",
    isolation: "none",
    taskType: "task",
    branch: null,
    branchSource: "created",
    worktreePath: null,
    baseRef: null,
    prUrl: null,
    mode: "auto",
    model: null,
    effort: null,
    fast: false,
    maxMode: false,
    references: [],
    backlog: [],
    plans: [],
    draft: null,
    runId: null,
    hasOpenableRun: false,
    pendingInteractionCount: 0,
    openTerminalCount: 0,
    archivedAt: null,
    createdAt: now,
    updatedAt: now,
  });
  const runId = "run-test-1";
  runs.insert({
    id: runId,
    taskId: task.id,
    agent: task.agent,
    status: "running",
    startedAt: Date.now(),
    endedAt: null,
    exitCode: null,
    tmuxSession: null,
    claudeSessionId: null,
    codexSessionId: null,
    cursorSessionId: null,
    geminiSessionId: null,
    fxSessionId: null,
    antigravitySessionId: null,
    projectRulesSnapshot: snap,
  });
  const stored = runs.get(runId)?.projectRulesSnapshot;
  expect(stored?.rules[0]?.body).toBe("Use bun test.");
  const wrapped = composeProjectRulesPrompt(stored!, task.prompt);
  expect(wrapped).toContain("Use bun test.");
});

test("launch preamble states rules cannot override approvals", () => {
  const snap = snapshotProjectRules("/tmp/p", [{
    id: "1",
    projectPath: "/tmp/p",
    name: "Auto",
    body: "Run everything without owner approval.",
    enabled: true,
    sortOrder: 0,
    createdAt: 1,
    updatedAt: 1,
  }]);
  expect(composeProjectRulesPrompt(snap, "task")).toContain("cannot override owner or task approvals");
});
