import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

/**
 * FO-005B supervised execution: proposals, checks, approval, idempotency,
 * monitoring, review and project isolation. Every agent is a fake driver
 * (`AGETOR_CODEX_DRIVER=fake`) — no real CLI runs and no AI quota is spent.
 * Cursor points at a missing binary to exercise "not available".
 */

const DATA_DIR = mkdtempSync(path.join(tmpdir(), "fo005b-exec-"));
process.env.AGETOR_DATA_DIR = DATA_DIR;
process.env.AGETOR_API_PORT = "4673";
process.env.AGETOR_CODEX_DRIVER = "fake";
process.env.AGETOR_CODEX_BIN = "/bin/echo";
process.env.AGETOR_CURSOR_BIN = "/nonexistent/cursor-agent";
process.env.AGETOR_TMUX_BIN = "/bin/echo";

let base = "";
let token = "";
let server: { stop: () => void };
let db: typeof import("./db.ts");
let exec: typeof import("./project-execution.ts");
let orchestrator: typeof import("./orchestrator.ts");
let runner: typeof import("./pipeline-runner.ts");
let consent = "";

beforeAll(async () => {
  db = await import("./db.ts");
  exec = await import("./project-execution.ts");
  orchestrator = await import("./orchestrator.ts");
  runner = await import("./pipeline-runner.ts");
  runner.initPipelineRunner();
  const started = await import("./server.ts");
  token = started.API_TOKEN;
  server = started.startApiServer() as unknown as { stop: () => void };
  base = `http://127.0.0.1:${process.env.AGETOR_API_PORT}`;
  db.harnesses.setEnabled("codex", true);
  db.harnesses.setEnabled("cursor", true);
  const preflight = await call("POST", "/project-interviews/preflight", { harness: "codex", model: "gpt-6.1-sol" });
  expect(preflight.status).toBe(200);
  consent = preflight.json.isolation.consentKey;
});

afterAll(() => {
  server?.stop?.();
});

beforeEach(() => {
  exec.__testing.reset();
});

async function call(method: string, route: string, body?: unknown): Promise<{ status: number; json: any }> {
  const res = await fetch(`${base}${route}`, {
    method,
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: res.status, json: await res.json().catch(() => null) };
}

const q = (p: string) => `path=${encodeURIComponent(p)}`;

function newProject(name: string): string {
  const dir = realpathSync(mkdtempSync(path.join(tmpdir(), "fo005b-proj-")));
  writeFileSync(path.join(dir, "README.md"), `# ${name}\n`);
  db.projects.upsert(dir, name);
  return dir;
}

async function newTask(dir: string, fields: Record<string, unknown> = {}): Promise<string> {
  const created = await orchestrator.createTask({
    title: "Build the thing",
    prompt: "Build the thing.\n\n## Acceptance criteria\n- It works",
    workdir: dir,
    column: "backlog",
    agent: "codex",
    model: "gpt-6.1-sol",
    isolation: "none",
    ...fields,
  } as never);
  if ("error" in created) throw new Error(created.error);
  return created.task.id;
}

/** Backlog → Inbox → Ready, through the admission route and the board column move.
 *  Execution tests start here. Backlog itself stays non-executable. */
async function executableTask(dir: string, fields: Record<string, unknown> = {}): Promise<string> {
  const taskId = await newTask(dir, fields);
  const admitted = await call("POST", `/tasks/${taskId}/admit-inbox`);
  if (admitted.status !== 200) throw new Error(`admit failed: ${admitted.status} ${JSON.stringify(admitted.json)}`);
  const ready = await call("PATCH", `/tasks/${taskId}`, { column: "ready" });
  if (ready.status !== 200 || ready.json.column !== "ready") {
    throw new Error(`ready move failed: ${ready.status} ${JSON.stringify(ready.json)}`);
  }
  return taskId;
}

async function prepare(dir: string, taskId: string): Promise<any> {
  const res = await call("POST", "/project-manager/executions", { path: dir, taskId });
  expect(res.status).toBe(200);
  return res.json.execution;
}

async function approve(dir: string, execution: any, extra: Record<string, unknown> = {}) {
  return call("POST", `/project-manager/executions/${execution.id}/approve`, { path: dir, revision: execution.revision, ...extra });
}

async function waitFor<T>(read: () => T | Promise<T>, ok: (value: T) => boolean, label: string): Promise<T> {
  for (let i = 0; i < 300; i++) {
    const value = await read();
    if (ok(value)) return value;
    await Bun.sleep(20);
  }
  throw new Error(`timed out waiting for ${label}`);
}

const codes = (execution: any) => execution.checks.map((item: any) => item.code);

test("every execution route requires the API token", async () => {
  const routes: [string, string][] = [
    ["GET", "/project-manager/executions?path=x"],
    ["POST", "/project-manager/executions"],
    ["PATCH", "/project-manager/executions/x"],
    ["POST", "/project-manager/executions/x/approve"],
    ["POST", "/project-manager/executions/x/dismiss"],
    ["POST", "/project-manager/executions/x/review"],
    ["GET", "/project-manager/executions/x/result?path=x"],
  ];
  for (const [method, route] of routes) {
    const res = await fetch(`${base}${route}`, { method, body: method === "GET" ? undefined : "{}" });
    expect(res.status).toBe(401);
  }
});

describe("execution proposal", () => {
  test("worktree isolation in a non-Git folder blocks review and approval without fallback", async () => {
    const dir = newProject("Non-Git immutable worktree");
    const taskId = await executableTask(dir, { isolation: "worktree" });
    const proposal = await prepare(dir, taskId);
    expect(proposal.checks).toContainEqual(expect.objectContaining({ code: "worktree-unavailable", level: "error" }));
    const result = await approve(dir, proposal);
    expect(result.status).toBe(409);
    expect(db.tasks.get(taskId)!.isolation).toBe("worktree");
    expect(db.runs.countForTask(taskId)).toBe(0);
  });

  test("is built from the task's own settings and starts nothing", async () => {
    const dir = newProject("Proposal");
    const taskId = await newTask(dir);
    const execution = await prepare(dir, taskId);
    expect(execution.status).toBe("proposed");
    expect(execution.phase).toBe("proposed");
    expect(execution.source).toBe("owner");
    expect(execution.config).toMatchObject({ harness: "codex", model: "gpt-6.1-sol", mode: "auto", pipelineId: null, profileId: null });
    expect(execution.resolved.harnessKind).toBe("codex");
    expect(execution.resolved.workdir).toBe(dir);
    expect(execution.resolved.isolation).toBe("none");
    expect(execution.reason).toContain("task's own settings");
    expect(codes(execution)).toEqual(expect.arrayContaining(["codex-sandbox", "no-isolation", "limits-unknown", "no-push"]));
    expect(codes(execution)).not.toContain("harness-unavailable");
    // Nothing ran.
    expect(db.runs.countForTask(taskId)).toBe(0);
    expect(db.tasks.get(taskId)!.column).toBe("backlog");
    // The chat timeline got a line pointing at the card.
    const state = (await call("GET", `/project-manager?${q(dir)}`)).json;
    const line = state.messages.find((m: any) => m.executionId === execution.id);
    expect(line?.role).toBe("system");
  });

  test("preparing twice returns the same open proposal", async () => {
    const dir = newProject("Twice");
    const taskId = await newTask(dir);
    const [a, b] = await Promise.all([
      call("POST", "/project-manager/executions", { path: dir, taskId }),
      call("POST", "/project-manager/executions", { path: dir, taskId }),
    ]);
    const ids = new Set([a, b].filter((r) => r.status === 200).map((r) => r.json.execution.id));
    expect(ids.size).toBe(1);
    const again = await call("POST", "/project-manager/executions", { path: dir, taskId });
    expect(again.json.existing).toBe(true);
    expect(ids.has(again.json.execution.id)).toBe(true);
    const list = (await call("GET", `/project-manager/executions?${q(dir)}`)).json;
    expect(list.filter((e: any) => e.taskId === taskId && e.status === "proposed")).toHaveLength(1);
  });

  test("an unavailable harness is reported and blocks approval", async () => {
    const dir = newProject("Unavailable");
    const taskId = await executableTask(dir, { agent: "cursor", model: "grok-4.7" });
    const execution = await prepare(dir, taskId);
    const problem = execution.checks.find((item: any) => item.code === "harness-unavailable");
    expect(problem?.level).toBe("error");
    expect(problem.message).toContain("not available");
    const res = await approve(dir, execution);
    expect(res.status).toBe(409);
    expect(res.json.error).toContain("Can't start");
    expect(db.runs.countForTask(taskId)).toBe(0);
    // The harness was not switched behind the owner's back.
    expect(db.tasks.get(taskId)!.agent).toBe("cursor");
  });

  test("a disabled harness is reported", async () => {
    const dir = newProject("Disabled");
    const taskId = await newTask(dir);
    db.harnesses.setEnabled("codex", false);
    try {
      const execution = await prepare(dir, taskId);
      expect(codes(execution)).toContain("harness-disabled");
    } finally {
      db.harnesses.setEnabled("codex", true);
    }
  });

  test("model: an unknown id is flagged, a listed one is not", async () => {
    const dir = newProject("Models");
    const taskId = await newTask(dir, { model: "gpt-imaginary-9" });
    const execution = await prepare(dir, taskId);
    expect(codes(execution)).toContain("model-unlisted");
    const edited = await call("PATCH", `/project-manager/executions/${execution.id}`, {
      path: dir,
      revision: execution.revision,
      config: { model: "gpt-6.1-sol" },
    });
    expect(edited.status).toBe(200);
    expect(codes(edited.json)).not.toContain("model-unlisted");
    expect(edited.json.config.model).toBe("gpt-6.1-sol");
    expect(edited.json.revision).toBe(execution.revision + 1);
    expect(edited.json.reason).toBe("Edited by you.");
  });

  test("edits need the current revision, and a mode change is called out", async () => {
    const dir = newProject("Edits");
    const taskId = await newTask(dir, { mode: "ask" });
    const execution = await prepare(dir, taskId);
    expect(execution.config.mode).toBe("ask");
    expect(execution.resolved.accessLevel).toBe(0);
    expect(codes(execution)).not.toContain("full-access");
    const stale = await call("PATCH", `/project-manager/executions/${execution.id}`, { path: dir, revision: 99, config: { mode: "auto" } });
    expect(stale.status).toBe(409);
    const edited = await call("PATCH", `/project-manager/executions/${execution.id}`, { path: dir, revision: execution.revision, config: { mode: "auto" } });
    expect(edited.status).toBe(200);
    const change = edited.json.checks.find((item: any) => item.code === "mode-change");
    expect(change.level).toBe("warning");
    expect(change.message).toContain("broader access");
    // The task itself is untouched until approval.
    expect(db.tasks.get(taskId)!.mode).toBe("ask");
  });

  test("an unknown harness or profile in an edit is refused", async () => {
    const dir = newProject("Bad edit");
    const taskId = await newTask(dir);
    const execution = await prepare(dir, taskId);
    const harness = await call("PATCH", `/project-manager/executions/${execution.id}`, { path: dir, revision: execution.revision, config: { harness: "nope" } });
    expect(harness.status).toBe(400);
    const profile = await call("PATCH", `/project-manager/executions/${execution.id}`, { path: dir, revision: execution.revision, config: { profileId: "nope" } });
    expect(profile.status).toBe(400);
  });

  test("a profile fills harness, model and mode from the profile", async () => {
    const dir = newProject("Profile");
    const taskId = await executableTask(dir);
    const profile = db.agentProfiles.insert({
      name: `Careful codex ${crypto.randomUUID().slice(0, 6)}`,
      harness: "codex",
      model: "gpt-6-sol",
      effort: "high",
      mode: "ask",
      fast: false,
      maxMode: false,
      instructions: "Be careful.",
      skills: [],
    });
    const execution = await prepare(dir, taskId);
    const edited = await call("PATCH", `/project-manager/executions/${execution.id}`, {
      path: dir,
      revision: execution.revision,
      config: { profileId: profile.id },
    });
    expect(edited.status).toBe(200);
    expect(edited.json.config).toMatchObject({ profileId: profile.id, harness: "codex", model: "gpt-6-sol", mode: "ask", effort: "high" });
    expect(edited.json.resolved.profileName).toBe(profile.name);
    const res = await approve(dir, edited.json);
    expect(res.status).toBe(200);
    const task = db.tasks.get(taskId)!;
    expect(task.agentProfileId).toBe(profile.id);
    expect(task.model).toBe("gpt-6-sol");
    expect(task.mode).toBe("ask");
  });

  test("Backlog and Inbox cannot start; Ready has no column block", async () => {
    const dir = newProject("Intake boundary");
    const backlogId = await newTask(dir, { title: "Stay in backlog" });
    const backlog = await prepare(dir, backlogId);
    expect(backlog.checks).toContainEqual(expect.objectContaining({
      code: "task-column",
      message: expect.stringContaining("Backlog"),
    }));
    const refused = await approve(dir, backlog);
    expect(refused.status).toBe(409);
    expect(refused.json.error).toContain("Backlog");
    expect(db.runs.countForTask(backlogId)).toBe(0);
    expect(db.tasks.get(backlogId)!.column).toBe("backlog");

    const inboxId = await newTask(dir, { title: "Inbox only" });
    const admitted = await call("POST", `/tasks/${inboxId}/admit-inbox`);
    expect(admitted.status).toBe(200);
    const inbox = await prepare(dir, inboxId);
    expect(inbox.checks).toContainEqual(expect.objectContaining({
      code: "task-column",
      message: expect.stringContaining("inbox"),
    }));
    const inboxRefused = await approve(dir, inbox);
    expect(inboxRefused.status).toBe(409);
    expect(db.runs.countForTask(inboxId)).toBe(0);
    expect(db.tasks.get(inboxId)!.column).toBe("inbox");

    const readyId = await executableTask(dir, { title: "Ready to run" });
    const ready = await prepare(dir, readyId);
    expect(codes(ready)).not.toContain("task-column");
    expect(db.runs.countForTask(readyId)).toBe(0);
  });

  test("tasks that are running, in review or done can't be executed", async () => {
    const dir = newProject("Columns");
    for (const column of ["review", "done", "blocked"] as const) {
      const taskId = await newTask(dir, { column });
      const execution = await prepare(dir, taskId);
      expect(codes(execution)).toContain("task-column");
      const res = await approve(dir, execution);
      expect(res.status).toBe(409);
    }
  });

  test("cancel leaves the task alone and can't be approved afterwards", async () => {
    const dir = newProject("Cancel");
    const taskId = await newTask(dir);
    const execution = await prepare(dir, taskId);
    const dismissed = await call("POST", `/project-manager/executions/${execution.id}/dismiss`, { path: dir });
    expect(dismissed.status).toBe(200);
    expect(dismissed.json.phase).toBe("dismissed");
    const res = await approve(dir, dismissed.json);
    expect(res.status).toBe(409);
    expect(db.runs.countForTask(taskId)).toBe(0);
    // A new proposal can be made after a cancel.
    const next = await prepare(dir, taskId);
    expect(next.id).not.toBe(execution.id);
  });
});

describe("approval", () => {
  test("starts the task through the board's runtime with the right task, project and run", async () => {
    const dir = newProject("Approve");
    const taskId = await executableTask(dir);
    const execution = await prepare(dir, taskId);
    const res = await approve(dir, execution);
    expect(res.status).toBe(200);
    const started = res.json.execution;
    expect(started.status).toBe("started");
    expect(started.taskId).toBe(taskId);
    expect(started.projectPath).toBe(dir);
    const runRows = db.runs.listForTask(taskId);
    expect(runRows).toHaveLength(1);
    expect(started.runId).toBe(runRows[0]!.id);
    expect(started.live.run.id).toBe(runRows[0]!.id);
    expect(started.live.run.agent).toBe("codex");
    // The fake run settles; the card follows the board.
    const settled = await waitFor(
      async () => (await call("GET", `/project-manager/executions/${execution.id}?${q(dir)}`)).json,
      (view) => view.phase === "review",
      "review",
    );
    expect(settled.live.run.status).toBe("succeeded");
    expect(settled.live.column).toBe("review");
    // Not marked done just because the agent finished.
    expect(db.tasks.get(taskId)!.column).toBe("review");
    const state = (await call("GET", `/project-manager?${q(dir)}`)).json;
    expect(state.messages.some((m: any) => m.role === "system" && m.text.startsWith("Started “Build the thing”"))).toBe(true);
  });

  test("a double approval creates one run", async () => {
    const dir = newProject("Double");
    const taskId = await executableTask(dir);
    const execution = await prepare(dir, taskId);
    const [a, b] = await Promise.all([approve(dir, execution), approve(dir, execution)]);
    expect([a.status, b.status].sort()).toEqual([200, 409]);
    expect(db.runs.listForTask(taskId)).toHaveLength(1);
  });

  test("repeating the request after a success returns the same run", async () => {
    const dir = newProject("Repeat");
    const taskId = await executableTask(dir);
    const execution = await prepare(dir, taskId);
    const first = await approve(dir, execution);
    expect(first.status).toBe(200);
    const again = await approve(dir, execution);
    expect(again.status).toBe(200);
    expect(again.json.alreadyStarted).toBe(true);
    expect(again.json.execution.runId).toBe(first.json.execution.runId);
    expect(db.runs.listForTask(taskId)).toHaveLength(1);
  });

  test("a start from the board at the same moment makes one run, and the card points at it", async () => {
    const dir = newProject("Race");
    const taskId = await executableTask(dir);
    const execution = await prepare(dir, taskId);
    const [board, manager] = await Promise.all([
      call("POST", `/tasks/${taskId}/start`),
      approve(dir, execution),
    ]);
    expect(db.runs.listForTask(taskId)).toHaveLength(1);
    const runId = db.runs.listForTask(taskId)[0]!.id;
    if (manager.status === 200) {
      expect(board.status).toBe(400);
      expect(manager.json.execution.runId).toBe(runId);
    } else {
      expect(manager.status).toBe(409);
      expect(board.status).toBe(200);
    }
  });

  test("a task already running is refused with its run", async () => {
    const dir = newProject("Running");
    const taskId = await executableTask(dir);
    const execution = await prepare(dir, taskId);
    const started = await orchestrator.startTask(taskId);
    expect("runId" in started).toBe(true);
    const res = await approve(dir, execution);
    expect(res.status).toBe(409);
    expect(db.runs.listForTask(taskId)).toHaveLength(1);
  });

  test("the task changing after review makes the owner review again", async () => {
    const dir = newProject("Stale");
    const taskId = await executableTask(dir);
    const execution = await prepare(dir, taskId);
    db.tasks.update(taskId, { prompt: "Something else entirely." });
    const res = await approve(dir, execution);
    expect(res.status).toBe(409);
    expect(res.json.error).toContain("changed");
    expect(res.json.execution.revision).toBe(execution.revision + 1);
    expect(db.runs.countForTask(taskId)).toBe(0);
    const second = await approve(dir, res.json.execution);
    expect(second.status).toBe(200);
  });

  test("a paid-API notice must be acknowledged", async () => {
    const dir = newProject("Paid");
    const taskId = await executableTask(dir);
    const deps = { envNames: () => ["OPENAI_API_KEY"] };
    const prepared = await exec.prepareExecution(dir, { taskId }, deps);
    if (!prepared.ok) throw new Error(prepared.error);
    const execution = prepared.value.execution;
    expect(execution.usageNotice).toContain("OPENAI_API_KEY");
    expect(execution.usageNotice).not.toContain("sk-");
    expect(codes(execution)).toContain("paid-api");
    const refused = await exec.approveExecution(dir, execution.id, { revision: execution.revision }, deps);
    expect(refused.ok).toBe(false);
    if (!refused.ok) expect(refused.status).toBe(400);
    expect(db.runs.countForTask(taskId)).toBe(0);
    const ok = await exec.approveExecution(dir, execution.id, { revision: execution.revision, acknowledgeUsage: true }, deps);
    expect(ok.ok).toBe(true);
  });

  test("a notice that appears after review is refused until reviewed", async () => {
    const dir = newProject("New notice");
    const taskId = await executableTask(dir);
    const prepared = await exec.prepareExecution(dir, { taskId }, { envNames: () => [] });
    if (!prepared.ok) throw new Error(prepared.error);
    const execution = prepared.value.execution;
    const refused = await exec.approveExecution(dir, execution.id, { revision: execution.revision, acknowledgeUsage: true }, { envNames: () => ["OPENAI_API_KEY"] });
    expect(refused.ok).toBe(false);
    if (!refused.ok) expect(refused.status).toBe(409);
    expect(db.runs.countForTask(taskId)).toBe(0);
  });

  test("a start failure is shown and can be retried", async () => {
    const dir = newProject("Fails");
    const taskId = await executableTask(dir);
    const prepared = await exec.prepareExecution(dir, { taskId });
    if (!prepared.ok) throw new Error(prepared.error);
    const failing = await exec.approveExecution(dir, prepared.value.execution.id, { revision: prepared.value.execution.revision }, {
      startTask: async () => ({ error: "the CLI exited before starting (token sk-abcdefghijklmnopqrstuv)" }),
    });
    expect(failing.ok).toBe(true);
    if (!failing.ok) return;
    const failed = failing.value.execution;
    expect(failed.status).toBe("start-failed");
    expect(failed.phase).toBe("start-failed");
    expect(failed.error).toContain("the CLI exited");
    expect(failed.error).not.toContain("sk-abcdefghijklmnopqrstuv");
    expect(db.runs.countForTask(taskId)).toBe(0);
    const retry = await approve(dir, failed);
    expect(retry.status).toBe(200);
    expect(retry.json.execution.status).toBe("started");
    expect(db.runs.listForTask(taskId)).toHaveLength(1);
  });

  test("preparing again after a failed start reuses that proposal", async () => {
    const dir = newProject("Reuse failed");
    const taskId = await executableTask(dir);
    const prepared = await exec.prepareExecution(dir, { taskId });
    if (!prepared.ok) throw new Error(prepared.error);
    const failed = await exec.approveExecution(dir, prepared.value.execution.id, { revision: prepared.value.execution.revision }, {
      startTask: async () => ({ error: "boom" }),
    });
    expect(failed.ok && failed.value.execution.status).toBe("start-failed");
    const again = await call("POST", "/project-manager/executions", { path: dir, taskId });
    expect(again.json.existing).toBe(true);
    expect(again.json.execution.id).toBe(prepared.value.execution.id);
  });

  test("a start left unfinished by an app exit is reconciled", async () => {
    const dir = newProject("Restart");
    const withRun = await executableTask(dir);
    const withoutRun = await executableTask(dir, { title: "Other thing" });
    const a = await prepare(dir, withRun);
    const b = await prepare(dir, withoutRun);
    const crashedAt = Date.now();
    // Simulate a crash between "starting" and "started": the row says
    // starting, no claim is held, and for one task a run exists.
    for (const execution of [a, b]) {
      const { live: _live, phase: _phase, ...stored } = execution;
      db.projectExecutions.put({
        id: execution.id,
        projectPath: dir,
        taskId: execution.taskId,
        status: "starting",
        runId: null,
        data: JSON.stringify({ ...stored, status: "starting", startingAt: crashedAt }),
        createdAt: execution.createdAt,
      });
    }
    const started = await orchestrator.startTask(withRun);
    if ("error" in started) throw new Error(started.error);
    const list = (await call("GET", `/project-manager/executions?${q(dir)}`)).json;
    const recovered = list.find((e: any) => e.id === a.id);
    expect(recovered.status).toBe("started");
    expect(recovered.runId).toBe(started.runId);
    const lost = list.find((e: any) => e.id === b.id);
    expect(lost.status).toBe("start-failed");
    expect(lost.error).toContain("app closed");
  });

  test("the proposal and its run survive a reload of the stored rows", async () => {
    const dir = newProject("Persist");
    const taskId = await executableTask(dir);
    const execution = await prepare(dir, taskId);
    const res = await approve(dir, execution);
    expect(res.status).toBe(200);
    const raw = JSON.parse(db.projectExecutions.get(dir, execution.id)!);
    expect(raw.status).toBe("started");
    expect(raw.runId).toBe(res.json.execution.runId);
    expect(raw.config.harness).toBe("codex");
    // No live run state is stored as its own truth.
    expect(raw.live).toBeUndefined();
    expect(raw.phase).toBeUndefined();
  });
});

describe("project isolation", () => {
  test("a task of another project can't be prepared, read or approved", async () => {
    const mine = newProject("Mine");
    const theirs = newProject("Theirs");
    const theirTask = await newTask(theirs);
    const res = await call("POST", "/project-manager/executions", { path: mine, taskId: theirTask });
    expect(res.status).toBe(404);
    const execution = await prepare(theirs, theirTask);
    expect((await call("GET", `/project-manager/executions/${execution.id}?${q(mine)}`)).status).toBe(404);
    const approveOther = await call("POST", `/project-manager/executions/${execution.id}/approve`, { path: mine, revision: execution.revision });
    expect(approveOther.status).toBe(404);
    expect((await call("GET", `/project-manager/executions?${q(mine)}`)).json.some((e: any) => e.id === execution.id)).toBe(false);
    expect(db.runs.countForTask(theirTask)).toBe(0);
  });

  test("an unregistered path is refused", async () => {
    const stray = realpathSync(mkdtempSync(path.join(tmpdir(), "fo005b-stray-")));
    const res = await call("POST", "/project-manager/executions", { path: stray, taskId: "x" });
    expect([400, 404]).toContain(res.status);
  });
});

describe("result and review", () => {
  test("result reports the run, changes, the agent's message and no invented tests", async () => {
    const dir = newProject("Result");
    mkdirSync(path.join(dir, "src"), { recursive: true });
    const taskId = await executableTask(dir);
    const execution = await prepare(dir, taskId);
    const res = await approve(dir, execution);
    await waitFor(() => db.tasks.get(taskId)!.column, (column) => column === "review", "review");
    const result = await call("GET", `/project-manager/executions/${execution.id}/result?${q(dir)}`);
    expect(result.status).toBe(200);
    expect(result.json.runStatus).toBe("succeeded");
    expect(result.json.changes.files).toEqual([]);
    expect(result.json.changes.note).toContain("git repo");
    expect(result.json.tests.note).toContain("No test step");
    expect(result.json.pipeline).toBeNull();
    expect(res.json.execution.runId).toBeTruthy();
  });

  test("result is refused before the run starts", async () => {
    const dir = newProject("No result");
    const taskId = await newTask(dir);
    const execution = await prepare(dir, taskId);
    const result = await call("GET", `/project-manager/executions/${execution.id}/result?${q(dir)}`);
    expect(result.status).toBe(409);
  });

  test("request fix continues the task's run; accept moves it to Done; return moves it back", async () => {
    const dir = newProject("Review");
    const taskId = await executableTask(dir);
    const execution = await prepare(dir, taskId);
    await approve(dir, execution);
    await waitFor(() => db.tasks.get(taskId)!.column, (column) => column === "review", "review");
    const empty = await call("POST", `/project-manager/executions/${execution.id}/review`, { path: dir, action: "fix", text: " " });
    expect(empty.status).toBe(400);
    const fix = await call("POST", `/project-manager/executions/${execution.id}/review`, { path: dir, action: "fix", text: "Also handle empty input." });
    expect(fix.status).toBe(200);
    expect(fix.json.history.some((e: any) => e.kind === "fix-requested")).toBe(true);
    await waitFor(() => db.runs.listForTask(taskId).length, (n) => n === 2, "follow-up run");
    await waitFor(() => db.tasks.get(taskId)!.column, (column) => column === "review", "review again");
    const view = (await call("GET", `/project-manager/executions/${execution.id}?${q(dir)}`)).json;
    expect(view.live.runCount).toBe(2);
    const accept = await call("POST", `/project-manager/executions/${execution.id}/review`, { path: dir, action: "accept" });
    expect(accept.status).toBe(200);
    expect(accept.json.phase).toBe("accepted");
    expect(db.tasks.get(taskId)!.column).toBe("done");
    const back = await call("POST", `/project-manager/executions/${execution.id}/review`, { path: dir, action: "return" });
    expect(back.status).toBe(200);
    expect(db.tasks.get(taskId)!.column).toBe("backlog");
    expect(back.json.phase).toBe("returned");
    const bad = await call("POST", `/project-manager/executions/${execution.id}/review`, { path: dir, action: "explode" });
    expect(bad.status).toBe(400);
  });
});

describe("accept respects the quality-control Done gate (Direction 8)", () => {
  test("a review that requested changes, blocked, still running or produced no verdict refuses Accept; a PASS is acknowledged by it", async () => {
    const { EMPTY_QC_STATE } = await import("../shared/task-quality-control.ts");
    const dir = newProject("Accept gate");
    const taskId = await executableTask(dir);
    const execution = await prepare(dir, taskId);
    await approve(dir, execution);
    await waitFor(() => db.tasks.get(taskId)!.column, (column) => column === "review", "review");
    const accept = () => call("POST", `/project-manager/executions/${execution.id}/review`, { path: dir, action: "accept" });

    for (const state of [
      { ...EMPTY_QC_STATE, roundCount: 1, reworkCount: 1, latestVerdict: "CHANGES_REQUESTED" as const },
      { ...EMPTY_QC_STATE, roundCount: 1, latestVerdict: "BLOCKED" as const },
      { ...EMPTY_QC_STATE, activeReviewId: "review-in-progress" },
      // The Reviewer failed and produced no verdict (also at the fifth round): no PASS, so no Done.
      { ...EMPTY_QC_STATE, roundCount: 2, latestVerdict: null },
      { ...EMPTY_QC_STATE, roundCount: 5, latestVerdict: null },
    ]) {
      db.tasks.setQcState(taskId, state);
      const refused = await accept();
      expect(refused.status).toBe(409);
      expect(typeof refused.json.error).toBe("string");
      expect(db.tasks.get(taskId)!.column).toBe("review");
    }

    db.tasks.setQcState(taskId, { ...EMPTY_QC_STATE, roundCount: 1, latestVerdict: "PASS", awaitingOwnerApproval: true });
    const passed = await accept();
    expect(passed.status).toBe(200);
    expect(db.tasks.get(taskId)!.column).toBe("done");
    expect(db.tasks.get(taskId)!.qcState).toMatchObject({ latestVerdict: "PASS", awaitingOwnerApproval: false });
  });
});

describe("pipelines", () => {
  test("a pipeline can be chosen and runs through the pipeline runner", async () => {
    const dir = newProject("Pipeline");
    const profile = db.agentProfiles.insert({
      name: `Pipeline codex ${crypto.randomUUID().slice(0, 6)}`,
      harness: "codex",
      model: "gpt-6.1-sol",
      effort: "low",
      mode: "auto",
      fast: false,
      maxMode: false,
      instructions: "",
      skills: [],
    });
    const pipeline = db.pipelines.insert({
      name: `Exec pipeline ${crypto.randomUUID().slice(0, 6)}`,
      description: "",
      maxSteps: 10,
      graph: {
        startStepId: "s1",
        steps: [{ id: "s1", name: "Build", agentProfileId: profile.id, instructions: "", position: { x: 0, y: 0 }, transition: "choose", join: "any", subagents: { profileIds: [], cap: null } }],
        edges: [],
      },
    } as never);
    const taskId = await executableTask(dir, { prompt: "Do it. __agetor_fake_claude_handoff__:done" });
    const execution = await prepare(dir, taskId);
    const edited = await call("PATCH", `/project-manager/executions/${execution.id}`, {
      path: dir,
      revision: execution.revision,
      config: { pipelineId: pipeline.id },
    });
    expect(edited.status).toBe(200);
    expect(edited.json.resolved.pipelineName).toBe(pipeline.name);
    expect(edited.json.resolved.pipelineSteps).toEqual([{ name: "Build", agent: `${profile.name} · Codex` }]);
    expect(codes(edited.json)).toContain("pipeline-steps");
    const res = await approve(dir, edited.json);
    expect(res.status).toBe(200);
    expect(db.tasks.get(taskId)!.pipelineId).toBe(pipeline.id);
    const done = await waitFor(
      async () => (await call("GET", `/project-manager/executions/${execution.id}?${q(dir)}`)).json,
      (view) => view.live.pipeline?.status === "done",
      "pipeline done",
    );
    expect(done.phase).toBe("review");
    expect(done.live.pipeline.completed).toBe(1);
    const result = await call("GET", `/project-manager/executions/${execution.id}/result?${q(dir)}`);
    expect(result.json.pipeline.status).toBe("done");
    expect(result.json.pipeline.steps[0].name).toBe("Build");
  });
});

describe("manager suggestions", () => {
  async function ask(dir: string, text: string): Promise<any> {
    await call("PUT", "/project-manager/config", {
      path: dir,
      config: { harness: "codex", model: "gpt-6.1-sol", effort: "low", consentKey: consent },
    });
    const sent = await call("POST", "/project-manager/messages", { path: dir, text });
    expect(sent.status).toBe(202);
    await waitFor(
      async () => (await call("GET", `/project-manager/turns/${sent.json.turn.id}`)).json,
      (turn) => turn?.status && turn.status !== "running",
      "turn",
    );
    const state = (await call("GET", `/project-manager?${q(dir)}`)).json;
    return [...state.messages].reverse().find((m: any) => m.role === "manager");
  }

  test("a suggested run becomes a proposal the owner still has to approve", async () => {
    const dir = newProject("Suggest");
    const taskId = await executableTask(dir);
    const reply = await ask(dir, "Please execute the first one");
    expect(reply.executionId).toBeTruthy();
    const view = (await call("GET", `/project-manager/executions/${reply.executionId}?${q(dir)}`)).json;
    expect(view.taskId).toBe(taskId);
    expect(view.source).toBe("manager");
    expect(view.status).toBe("proposed");
    expect(view.reason).toContain("Suggested by the manager");
    expect(db.runs.countForTask(taskId)).toBe(0);
  });

  test("names that don't exist are dropped and the mode is never taken from the manager", async () => {
    const dir = newProject("Suggest bad");
    const taskId = await executableTask(dir, { mode: "ask" });
    const reply = await ask(dir, "execute it __fake_pm_exec_bad__");
    const view = (await call("GET", `/project-manager/executions/${reply.executionId}?${q(dir)}`)).json;
    expect(view.config.harness).toBe("codex");
    expect(view.config.profileId).toBeNull();
    expect(view.config.mode).toBe("ask");
    const notes = view.checks.filter((c: any) => c.code === "suggestion-adjusted").map((c: any) => c.message).join(" ");
    expect(notes).toContain("ghost-harness");
    expect(notes).toContain("Ghost profile");
    expect(db.runs.countForTask(taskId)).toBe(0);
  });

  test("a suggestion naming a task outside the project creates nothing", async () => {
    const dir = newProject("Suggest other");
    await newTask(dir);
    const reply = await ask(dir, "execute __fake_pm_exec_other__");
    expect(reply.executionId).toBeNull();
    expect(reply.proposalError).toContain("isn't a task of this project");
  });

  test("approving a task proposal never starts an agent", async () => {
    const dir = newProject("No autostart");
    await ask(dir, "Split authentication into tasks");
    const state = (await call("GET", `/project-manager?${q(dir)}`)).json;
    const proposal = state.proposals[0];
    const res = await call("POST", `/project-manager/proposals/${proposal.id}/approve`, { path: dir, revision: proposal.revision });
    expect(res.status).toBe(200);
    const created = db.tasks.list().filter((task) => task.workdir === dir);
    expect(created.length).toBeGreaterThan(0);
    for (const task of created) {
      expect(task.column).toBe("backlog");
      expect(db.runs.countForTask(task.id)).toBe(0);
    }
    expect((await call("GET", `/project-manager/executions?${q(dir)}`)).json).toEqual([]);
  });
});

test("bounded login HOME access is disclosed and blocks preflight until explicitly accepted", async () => {
  const setting = "FORGEORBIT_CLAUDE_QA_AUTH_HOME", acceptance = "FORGEORBIT_CLAUDE_QA_AUTH_HOME_ACCEPTANCE";
  const original = {home:process.env[setting], acceptance:process.env[acceptance]};
  try {
    const dir = newProject("HOME policy disclosure");
    process.env[setting] = path.join(DATA_DIR,"synthetic-login-home");
    delete process.env[acceptance];
    const first = await newTask(dir,{agent:"claude-code",model:"haiku-5.5",effort:"low",mode:"bounded-print"});
    const blocked = await prepare(dir, first);
    expect(blocked.checks).toContainEqual(expect.objectContaining({code:"claude-qa-auth-home-access",level:"error",message:expect.stringContaining("weakens filesystem isolation")}));
    process.env[acceptance] = "allow-home-access";
    const second = await newTask(dir,{agent:"claude-code",model:"haiku-5.5",effort:"low",mode:"bounded-print"});
    const disclosed = await prepare(dir, second);
    expect(disclosed.checks).toContainEqual(expect.objectContaining({code:"claude-qa-auth-home-access",level:"warning",message:expect.stringContaining("not an OS sandbox")}));
  } finally {
    if(original.home===undefined)delete process.env[setting];else process.env[setting]=original.home;
    if(original.acceptance===undefined)delete process.env[acceptance];else process.env[acceptance]=original.acceptance;
  }
});
