import { test, expect, beforeAll, afterAll } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { emptyEstimationSettings, type EstimationRecord } from "../shared/estimation/settings.ts";

const DATA_DIR = mkdtempSync(path.join(tmpdir(), "agetor-estimation-"));
process.env.AGETOR_DATA_DIR = DATA_DIR;
// Port 0: the OS picks a free port, read back from `server.port`, so this
// file can't collide with another test's fixed port. FORGEORBIT_API_PORT
// wins over AGETOR_API_PORT in getApiPort(), so it must not leak in.
delete process.env.FORGEORBIT_API_PORT;
process.env.AGETOR_API_PORT = "0";

let server: { stop: () => void; port: number };
let token: string;
let runs: typeof import("./db.ts").runs;

beforeAll(async () => {
  ({ runs } = await import("./db.ts"));
  const started = await import("./server.ts");
  server = started.startApiServer() as unknown as { stop: () => void; port: number };
  token = started.API_TOKEN;
});

afterAll(() => {
  server?.stop?.();
});

const url = (p: string) => `http://127.0.0.1:${server.port}${p}`;
const auth = () => ({ authorization: `Bearer ${token}` });

test("estimation routes require the bearer token and a registered project", async () => {
  const open = await fetch(url("/projects/estimation?path=/tmp"));
  expect(open.status).toBe(401);
  const missing = await fetch(url(`/projects/estimation?path=${encodeURIComponent("/tmp/not-a-registered-project")}`), { headers: auth() });
  expect(missing.status).toBe(404);
});

test("settings stay inside the project that saved them and prompts are not returned", async () => {
  const alpha = mkdtempSync(path.join(tmpdir(), "est-alpha-"));
  const beta = mkdtempSync(path.join(tmpdir(), "est-beta-"));
  for (const [dir, name] of [[alpha, "Alpha"], [beta, "Beta"]] as const) {
    const created = await fetch(url("/projects"), {
      method: "POST",
      headers: { ...auth(), "content-type": "application/json" },
      body: JSON.stringify({ path: dir, name }),
    });
    expect(created.ok).toBe(true);
  }
  const task = await fetch(url("/tasks"), {
    method: "POST",
    headers: { ...auth(), "content-type": "application/json" },
    body: JSON.stringify({
      title: "Plan the orbit",
      prompt: "SECRET_PROMPT_MARKER depends on something and takes 40 hours",
      isolation: "none",
      workdir: alpha,
    }),
  });
  expect(task.ok).toBe(true);
  const createdTask = (await task.json()) as { id: string };
  runs.insert({
    id: "est-run-1",
    taskId: createdTask.id,
    agent: "claude-code",
    status: "succeeded",
    startedAt: 1_000,
    endedAt: 61_000,
    exitCode: 0,
    tmuxSession: null,
    claudeSessionId: "session-secret-should-not-leak",
    codexSessionId: null,
    cursorSessionId: null,
    geminiSessionId: null,
    fxSessionId: null,
    origin: null,
  });

  const settings = emptyEstimationSettings();
  settings.reportCurrency = "EUR";
  const saved = await fetch(url("/projects/estimation"), {
    method: "PUT",
    headers: { ...auth(), "content-type": "application/json" },
    body: JSON.stringify({ path: alpha, settings }),
  });
  expect(saved.status).toBe(200);
  const alphaBody = (await saved.json()) as EstimationRecord;
  expect(alphaBody.settings?.reportCurrency).toBe("EUR");
  expect(alphaBody.observations.some((row) => row.agentMs === 60_000 && row.taskId === createdTask.id)).toBe(true);
  const alphaText = JSON.stringify(alphaBody);
  expect(alphaText).not.toContain("SECRET_PROMPT_MARKER");
  expect(alphaText).not.toContain("session-secret-should-not-leak");

  const betaGet = await fetch(url(`/projects/estimation?path=${encodeURIComponent(beta)}`), { headers: auth() });
  expect(betaGet.status).toBe(200);
  const betaBody = (await betaGet.json()) as EstimationRecord;
  expect(betaBody.settings).toBeNull();
  expect(betaBody.observations).toEqual([]);
  expect(betaBody.currentFingerprint).not.toBe(alphaBody.currentFingerprint);

  const secret = await fetch(url("/projects/estimation"), {
    method: "PUT",
    headers: { ...auth(), "content-type": "application/json" },
    body: JSON.stringify({ path: alpha, settings: { ...settings, apiKey: "sk-test" } }),
  });
  expect(secret.status).toBe(400);

  const inverted = emptyEstimationSettings();
  inverted.reportCurrency = "USD";
  inverted.stages = {
    [createdTask.id]: [{
      id: "implementation",
      kind: "implementation",
      effort: { optimisticMs: 9, expectedMs: 1, conservativeMs: 2 },
      repetitions: null,
      harnessFromTask: true,
      harnessId: null,
      modelFromTask: true,
      modelId: null,
      consumption: null,
    }],
  };
  const rejected = await fetch(url("/projects/estimation"), {
    method: "PUT",
    headers: { ...auth(), "content-type": "application/json" },
    body: JSON.stringify({ path: alpha, settings: inverted }),
  });
  expect(rejected.status).toBe(400);
  const still = await fetch(url(`/projects/estimation?path=${encodeURIComponent(alpha)}`), { headers: auth() });
  const stillBody = (await still.json()) as EstimationRecord;
  expect(stillBody.settings?.reportCurrency).toBe("EUR");
});

test("structured dependencies feed the estimate and mark a saved one stale, per project", async () => {
  const json = { ...auth(), "content-type": "application/json" };
  const gamma = mkdtempSync(path.join(tmpdir(), "est-gamma-"));
  const delta = mkdtempSync(path.join(tmpdir(), "est-delta-"));
  for (const [dir, name] of [[gamma, "Gamma"], [delta, "Delta"]] as const) {
    const created = await fetch(url("/projects"), { method: "POST", headers: json, body: JSON.stringify({ path: dir, name }) });
    expect(created.ok).toBe(true);
  }
  const makeTask = async (title: string, workdir: string) => {
    const res = await fetch(url("/tasks"), {
      method: "POST",
      headers: json,
      body: JSON.stringify({ title, prompt: title, isolation: "none", workdir }),
    });
    expect(res.ok).toBe(true);
    return ((await res.json()) as { id: string }).id;
  };
  const first = await makeTask("First", gamma);
  const second = await makeTask("Second", gamma);
  const elsewhere = await makeTask("Elsewhere", delta);

  const settings = emptyEstimationSettings();
  settings.reportCurrency = "USD";
  const saved = await fetch(url("/projects/estimation"), { method: "PUT", headers: json, body: JSON.stringify({ path: gamma, settings }) });
  expect(saved.status).toBe(200);
  const before = (await saved.json()) as EstimationRecord;
  expect(before.structuredDependencies).toEqual([]);
  expect(before.backlogFingerprint).toBe(before.currentFingerprint);

  const link = await fetch(url(`/project-manager/tasks/${second}/scheduling`), {
    method: "PUT",
    headers: json,
    body: JSON.stringify({ path: gamma, dependsOn: [first], priority: "critical" }),
  });
  expect(link.status).toBe(200);
  // A link to another project's task is refused by the scheduling layer.
  const foreign = await fetch(url(`/project-manager/tasks/${second}/scheduling`), {
    method: "PUT",
    headers: json,
    body: JSON.stringify({ path: gamma, dependsOn: [first, elsewhere] }),
  });
  expect(foreign.ok).toBe(false);

  const after = (await (await fetch(url(`/projects/estimation?path=${encodeURIComponent(gamma)}`), { headers: auth() })).json()) as EstimationRecord;
  expect(after.structuredDependencies).toEqual([{ taskId: second, dependsOn: first }]);
  expect(after.backlogFingerprint).toBe(before.backlogFingerprint);
  expect(after.currentFingerprint).not.toBe(before.currentFingerprint);
  // The manual list is still empty: the board link is not copied into it.
  expect(after.settings?.dependencies).toEqual({});

  const light = await fetch(url(`/projects/estimation/dependencies?path=${encodeURIComponent(gamma)}`), { headers: auth() });
  expect(light.status).toBe(200);
  expect(((await light.json()) as { structuredDependencies: unknown }).structuredDependencies).toEqual(after.structuredDependencies);

  const other = (await (await fetch(url(`/projects/estimation?path=${encodeURIComponent(delta)}`), { headers: auth() })).json()) as EstimationRecord;
  expect(other.structuredDependencies).toEqual([]);

  // Saving again with an empty manual list keeps the link and clears stale.
  const resaved = (await (await fetch(url("/projects/estimation"), { method: "PUT", headers: json, body: JSON.stringify({ path: gamma, settings }) })).json()) as EstimationRecord;
  expect(resaved.structuredDependencies).toEqual([{ taskId: second, dependsOn: first }]);
  expect(resaved.backlogFingerprint).toBe(resaved.currentFingerprint);
  expect(resaved.backlogFingerprint).toBe(after.currentFingerprint);

  // Removing the link moves the fingerprint again.
  const unlink = await fetch(url(`/project-manager/tasks/${second}/scheduling`), {
    method: "PUT",
    headers: json,
    body: JSON.stringify({ path: gamma, dependsOn: [] }),
  });
  expect(unlink.status).toBe(200);
  const unlinked = (await (await fetch(url(`/projects/estimation?path=${encodeURIComponent(gamma)}`), { headers: auth() })).json()) as EstimationRecord;
  expect(unlinked.structuredDependencies).toEqual([]);
  expect(unlinked.currentFingerprint).toBe(before.currentFingerprint);
  expect(unlinked.currentFingerprint).not.toBe(unlinked.backlogFingerprint);
});

test("a dependency write announces task_dependencies on /app/events, a no-op write does not", async () => {
  const { subscribeAppEvents } = await import("./quit-guard.ts");
  const { linkProposalDependencies } = await import("./task-scheduling.ts");
  const seen: Array<{ projectPath: string; taskIds: string[] }> = [];
  const unsubscribe = subscribeAppEvents((event) => {
    if (event.type === "task_dependencies") seen.push({ projectPath: event.projectPath, taskIds: event.taskIds });
  });
  try {
    const json = { ...auth(), "content-type": "application/json" };
    const dir = mkdtempSync(path.join(tmpdir(), "est-events-"));
    expect((await fetch(url("/projects"), { method: "POST", headers: json, body: JSON.stringify({ path: dir, name: "Events" }) })).ok).toBe(true);
    const makeTask = async (title: string) => {
      const res = await fetch(url("/tasks"), { method: "POST", headers: json, body: JSON.stringify({ title, prompt: title, isolation: "none", workdir: dir }) });
      return ((await res.json()) as { id: string }).id;
    };
    const a = await makeTask("A");
    const b = await makeTask("B");
    const c = await makeTask("C");
    const put = (taskId: string, body: Record<string, unknown>) =>
      fetch(url(`/project-manager/tasks/${taskId}/scheduling`), { method: "PUT", headers: json, body: JSON.stringify({ path: dir, ...body }) });

    expect((await put(b, { dependsOn: [a] })).status).toBe(200);
    expect(seen).toEqual([{ projectPath: dir, taskIds: [b] }]);
    // Same links again, or a priority-only change: nothing to re-read.
    expect((await put(b, { dependsOn: [a] })).status).toBe(200);
    expect((await put(b, { priority: "high" })).status).toBe(200);
    expect(seen).toHaveLength(1);
    // A refused write (a cycle) announces nothing.
    expect((await put(a, { dependsOn: [b] })).ok).toBe(false);
    expect(seen).toHaveLength(1);

    // Links written for an approved proposal's tasks announce once.
    expect(linkProposalDependencies(dir, [{ taskId: c, dependsOn: [a, b] }])).toEqual([]);
    expect(seen.at(-1)).toEqual({ projectPath: dir, taskIds: [c] });
    expect(linkProposalDependencies(dir, [{ taskId: c, dependsOn: [a] }])).toEqual([]);
    expect(seen).toHaveLength(2);

    expect((await put(b, { dependsOn: [] })).status).toBe(200);
    expect(seen.at(-1)).toEqual({ projectPath: dir, taskIds: [b] });
  } finally {
    unsubscribe();
  }
});
