import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readdirSync, realpathSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

/**
 * FO-005A project manager: runner, context, proposals and routes. Every
 * agent is the fake codex driver (`AGETOR_CODEX_DRIVER=fake`) — no real CLI
 * runs and no AI quota is spent. Cursor points at a missing binary to
 * exercise "not available".
 */

const DATA_DIR = mkdtempSync(path.join(tmpdir(), "fo005-manager-"));
process.env.AGETOR_DATA_DIR = DATA_DIR;
process.env.AGETOR_API_PORT = "4671";
process.env.AGETOR_CODEX_DRIVER = "fake";
process.env.AGETOR_CODEX_BIN = "/bin/echo";
process.env.AGETOR_CURSOR_BIN = "/nonexistent/cursor-agent";
process.env.AGETOR_TMUX_BIN = "/bin/echo";

let base = "";
let token = "";
let server: { stop: () => void };
let db: typeof import("./db.ts");
let manager: typeof import("./project-manager.ts");
let fake: typeof import("./project-manager-fake.ts");
let orchestrator: typeof import("./orchestrator.ts");
let consent = "";

beforeAll(async () => {
  db = await import("./db.ts");
  manager = await import("./project-manager.ts");
  fake = await import("./project-manager-fake.ts");
  orchestrator = await import("./orchestrator.ts");
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

async function call(method: string, route: string, body?: unknown): Promise<{ status: number; json: any }> {
  const res = await fetch(`${base}${route}`, {
    method,
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: res.status, json: await res.json().catch(() => null) };
}

const q = (p: string) => `path=${encodeURIComponent(p)}`;

function newProject(name: string, files: Record<string, string> = {}): string {
  const dir = realpathSync(mkdtempSync(path.join(tmpdir(), "fo005-proj-")));
  for (const [rel, text] of Object.entries(files)) {
    mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
    writeFileSync(path.join(dir, rel), text);
  }
  db.projects.upsert(dir, name);
  return dir;
}

async function configure(dir: string, overrides: Record<string, unknown> = {}): Promise<void> {
  const res = await call("PUT", "/project-manager/config", {
    path: dir,
    config: { harness: "codex", model: "gpt-6.1-sol", effort: "low", consentKey: consent, ...overrides },
  });
  expect(res.status).toBe(200);
}

async function settle(turnId: string): Promise<any> {
  for (let i = 0; i < 400; i++) {
    const { json } = await call("GET", `/project-manager/turns/${turnId}`);
    if (json?.status && json.status !== "running") return json;
    await Bun.sleep(20);
  }
  throw new Error("turn never settled");
}

async function ask(dir: string, text: string): Promise<{ turn: any; state: any }> {
  const sent = await call("POST", "/project-manager/messages", { path: dir, text });
  expect(sent.status).toBe(202);
  const turn = await settle(sent.json.turn.id);
  const state = (await call("GET", `/project-manager?${q(dir)}`)).json;
  return { turn, state };
}

function lastManager(state: any): any {
  return [...state.messages].reverse().find((m: any) => m.role === "manager");
}

function projectTasks(dir: string) {
  return db.tasks.list().filter((task) => task.workdir === dir);
}

test("every manager route requires the API token", async () => {
  const dir = newProject("Auth check");
  const routes: [string, string][] = [
    ["GET", `/project-manager?${q(dir)}`],
    ["PUT", "/project-manager/config"],
    ["POST", "/project-manager/messages"],
    ["POST", "/project-manager/proposals/x/approve"],
    ["POST", "/project-manager/decisions"],
  ];
  for (const [method, route] of routes) {
    const res = await fetch(`${base}${route}`, { method, body: method === "GET" ? undefined : "{}" });
    expect(res.status).toBe(401);
  }
});

describe("projects and config", () => {
  test("only registered projects have a manager", async () => {
    const stray = realpathSync(mkdtempSync(path.join(tmpdir(), "fo005-stray-")));
    expect((await call("GET", `/project-manager?${q(stray)}`)).status).toBe(404);
    expect((await call("GET", `/project-manager?path=relative/dir`)).status).toBe(400);
    expect((await call("POST", "/project-manager/messages", { path: stray, text: "hi" })).status).toBe(404);
  });

  test("each project keeps its own configuration", async () => {
    const a = newProject("Alpha");
    const b = newProject("Beta");
    await configure(a, { language: "ru", instructions: "Keep tasks small." });
    await configure(b, { language: "en", extraDocs: ["docs/ARCH.md", "../escape.md", ".env.md", "notes.txt"] });
    const stateA = (await call("GET", `/project-manager?${q(a)}`)).json;
    const stateB = (await call("GET", `/project-manager?${q(b)}`)).json;
    expect(stateA.config.language).toBe("ru");
    expect(stateA.config.instructions).toBe("Keep tasks small.");
    expect(stateB.config.language).toBe("en");
    expect(stateB.config.instructions).toBe("");
    // Only safe markdown paths inside the project survive.
    expect(stateB.config.extraDocs).toEqual(["docs/ARCH.md"]);
  });

  test("rejects an unknown harness or profile", async () => {
    const dir = newProject("Bad config");
    expect((await call("PUT", "/project-manager/config", { path: dir, config: { harness: "nope" } })).status).toBe(400);
    expect((await call("PUT", "/project-manager/config", { path: dir, config: { profileId: "missing" } })).status).toBe(400);
  });
});

describe("harness state", () => {
  test("a message without an agent is refused", async () => {
    const dir = newProject("No agent");
    const res = await call("POST", "/project-manager/messages", { path: dir, text: "hello" });
    expect(res.status).toBe(400);
    expect(res.json.error).toContain("Choose an agent");
  });

  test("an unavailable harness reports its real state and starts nothing", async () => {
    const dir = newProject("Cursor missing");
    await configure(dir, { harness: "cursor", model: null, effort: null });
    const res = await call("POST", "/project-manager/messages", { path: dir, text: "hello" });
    expect(res.status).toBe(422);
    expect(res.json.error).toContain("not available");
    const state = (await call("GET", `/project-manager?${q(dir)}`)).json;
    expect(state.messages).toEqual([]);
  });

  test("an unsupported harness is refused with its reason", async () => {
    const dir = newProject("Claude");
    await configure(dir, { harness: "claude-code", model: null, effort: null });
    const res = await call("POST", "/project-manager/messages", { path: dir, text: "hello" });
    expect(res.status).toBe(422);
    expect(res.json.error).toContain("Claude Code");
  });

  test("a message is refused until the isolation summary was confirmed", async () => {
    const dir = newProject("Consent");
    await configure(dir, { consentKey: null });
    const res = await call("POST", "/project-manager/messages", { path: dir, text: "hello" });
    expect(res.status).toBe(428);
    expect(res.json.isolation.consentKey).toBe(consent);
    const pre = await call("POST", "/project-manager/preflight", { path: dir });
    expect(pre.status).toBe(200);
    expect(pre.json.isolation.consentKey).toBe(consent);
  });
});

describe("context", () => {
  test("reads IDEA.md and PRD.md from the project and reports sources", async () => {
    const dir = newProject("Docs project", {
      "docs/IDEA.md": "# Orbit Notes\n\nA notes app for teams.\n",
      "docs/PRD.md": "# Orbit Notes PRD\n\n## Functional Requirements\n- FR-1: Write notes\n",
      "README.md": "# Readme\n",
    });
    await configure(dir);
    const { state } = await ask(dir, "What is this project?");
    const reply = lastManager(state);
    expect(reply.text).toContain("IDEA: docs/IDEA.md (Orbit Notes)");
    expect(reply.text).toContain("PRD: docs/PRD.md");
    const ids = reply.sources.map((s: any) => `${s.id}:${s.status}`);
    expect(ids).toContain("idea:included");
    expect(ids).toContain("prd:included");
    expect(ids).toContain("readme:included");
    const ctx = await call("GET", `/project-manager/context?${q(dir)}`);
    expect(ctx.status).toBe(200);
    expect(ctx.json.sources.find((s: any) => s.id === "idea").path).toBe("docs/IDEA.md");
  });

  test("missing documentation is reported, not invented", async () => {
    const dir = newProject("Empty project");
    await configure(dir);
    const { state } = await ask(dir, "What is this project?");
    const reply = lastManager(state);
    expect(reply.text).toContain("IDEA: not found");
    expect(reply.text).toContain("PRD: not found");
    expect(reply.sources.find((s: any) => s.id === "idea").status).toBe("missing");
    expect(reply.sources.find((s: any) => s.id === "backlog").status).toBe("missing");
  });

  test("never reads secrets or files outside the project; redacts credentials", async () => {
    const outside = realpathSync(mkdtempSync(path.join(tmpdir(), "fo005-outside-")));
    writeFileSync(path.join(outside, "SECRET.md"), "# outside secret file\n");
    const dir = newProject("Secrets", {
      "docs/IDEA.md": "# Idea\nOPENAI_API_KEY=sk-livelivelivelivelive1234\n",
      ".env": "TOKEN=abc",
      ".env.md": "# not allowed",
    });
    symlinkSync(path.join(outside, "SECRET.md"), path.join(dir, "docs", "LINK.md"));
    await configure(dir, { extraDocs: ["docs/LINK.md", ".env.md", "../SECRET.md"] });
    const state = (await call("GET", `/project-manager?${q(dir)}`)).json;
    expect(state.config.extraDocs).toEqual(["docs/LINK.md"]);
    const gathered = await manager.gatherManagerContext(dir, state.config);
    const prompt = JSON.stringify(gathered.context);
    expect(prompt).not.toContain("outside secret file");
    expect(prompt).not.toContain("sk-livelive");
    expect(prompt).toContain("[redacted]");
    expect(prompt).not.toContain("TOKEN=abc");
    expect(gathered.sources.find((s) => s.id === "doc:docs/LINK.md")?.status).toBe("skipped");
  });

  test("the backlog in the prompt is this project's tasks only", async () => {
    const a = newProject("Board A");
    const b = newProject("Board B");
    await orchestrator.createTask({ title: "Only in A", prompt: "a", workdir: a, isolation: "none" });
    await orchestrator.createTask({ title: "Only in B", prompt: "b", workdir: b, isolation: "none" });
    const config = (await call("GET", `/project-manager?${q(a)}`)).json.config;
    const gathered = await manager.gatherManagerContext(a, config);
    expect(gathered.context.backlog.map((t) => t.title)).toEqual(["Only in A"]);
  });
});

describe("chat", () => {
  test("multi-turn chat keeps history per project and restores it", async () => {
    const a = newProject("Chat A");
    const b = newProject("Chat B");
    await configure(a);
    await configure(b);
    await ask(a, "first question");
    const second = await ask(a, "second question");
    expect(lastManager(second.state).text).toContain("Earlier messages: 1.");
    const other = await ask(b, "hello from b");
    expect(lastManager(other.state).text).toContain("Earlier messages: 0.");
    const restored = (await call("GET", `/project-manager?${q(a)}`)).json;
    expect(restored.messages.filter((m: any) => m.role === "owner").map((m: any) => m.text)).toEqual(["first question", "second question"]);
    expect(restored.messages.every((m: any) => m.role !== "owner" || m.status === "answered")).toBe(true);
    expect(restored.lastActivityAt).toBeGreaterThan(0);
    const otherState = (await call("GET", `/project-manager?${q(b)}`)).json;
    expect(otherState.messages.some((m: any) => m.text === "first question")).toBe(false);
  });

  test("confirmed decisions reach the next prompt", async () => {
    const dir = newProject("Decisions");
    await configure(dir);
    const { state } = await ask(dir, "Should we decide on storage?");
    expect(lastManager(state).suggestedDecisions).toEqual(["Use SQLite for storage"]);
    const added = await call("POST", "/project-manager/decisions", { path: dir, text: "Use SQLite for storage", source: "manager" });
    expect(added.status).toBe(201);
    const again = await call("POST", "/project-manager/decisions", { path: dir, text: "use sqlite for storage" });
    expect(again.json.id).toBe(added.json.id);
    const next = await ask(dir, "status?");
    expect(lastManager(next.state).text).toContain("Confirmed decisions: 1.");
    const removed = await call("DELETE", `/project-manager/decisions/${added.json.id}?${q(dir)}`);
    expect(removed.json.deleted).toBe(true);
  });

  test("a failing CLI marks the message failed with a redacted error, and retry recovers", async () => {
    const dir = newProject("Fail");
    await configure(dir);
    const failed = await ask(dir, `please ${fake.FAKE_PM_SECRET_MARKER}`);
    expect(failed.turn.status).toBe("failed");
    expect(failed.turn.error).toContain("[redacted]");
    expect(failed.turn.error).not.toContain("sk-fakeSECRET");
    const owner = failed.state.messages.at(-1);
    expect(owner.status).toBe("failed");
    // A different message can't be "retried".
    expect((await call("POST", "/project-manager/messages", { path: dir, retryMessageId: "nope" })).status).toBe(404);
    // Retry re-sends the same stored message (the fake still fails on its
    // marker); a new message afterwards recovers.
    const retried = await call("POST", "/project-manager/messages", { path: dir, retryMessageId: owner.id });
    expect(retried.status).toBe(202);
    expect((await settle(retried.json.turn.id)).status).toBe("failed");
    const recovered = await ask(dir, "What is this project?");
    expect(recovered.turn.status).toBe("succeeded");
    expect(lastManager(recovered.state).text).toContain("Project Fail.");
    // The failed message stays failed; only answered turns enter the prompt.
    expect(lastManager(recovered.state).text).toContain("Earlier messages: 0.");
  });

  test("retry of a cancelled message succeeds", async () => {
    const dir = newProject("Cancel");
    await configure(dir);
    const sent = await call("POST", "/project-manager/messages", { path: dir, text: `${fake.FAKE_PM_SLOW_MARKER} hello` });
    expect(sent.status).toBe(202);
    // One turn at a time per project.
    const second = await call("POST", "/project-manager/messages", { path: dir, text: "again" });
    expect(second.status).toBe(409);
    expect((await call("GET", `/project-manager?${q(dir)}`)).json.activeTurn.id).toBe(sent.json.turn.id);
    expect((await call("DELETE", `/project-manager/turns/${sent.json.turn.id}`)).json.cancelled).toBe(true);
    const turn = await settle(sent.json.turn.id);
    expect(turn.status).toBe("cancelled");
    const state = (await call("GET", `/project-manager?${q(dir)}`)).json;
    expect(state.activeTurn).toBeNull();
    expect(state.messages.at(-1).status).toBe("cancelled");
    expect(state.messages.filter((m: any) => m.role === "manager")).toEqual([]);
  });

  test("a message whose turn died with the app becomes retryable", async () => {
    const dir = newProject("Crashed turn");
    await configure(dir);
    const orphan = { id: "orphan-1", role: "owner", text: "hello?", createdAt: 1, status: "pending", error: null, plan: null, proposalId: null, proposalError: null, suggestedDecisions: [], sources: [] };
    db.projectManagers.appendMessage(dir, orphan.id, JSON.stringify(orphan), 400);
    const state = (await call("GET", `/project-manager?${q(dir)}`)).json;
    expect(state.activeTurn).toBeNull();
    expect(state.messages[0].status).toBe("failed");
    expect(state.messages[0].error).toContain("closed before");
    const retried = await call("POST", "/project-manager/messages", { path: dir, retryMessageId: "orphan-1" });
    expect(retried.status).toBe(202);
    expect((await settle(retried.json.turn.id)).status).toBe("succeeded");
  });

  test("a reply without the protocol fails the turn and proposes nothing", async () => {
    const dir = newProject("Garbage");
    await configure(dir);
    const { turn, state } = await ask(dir, `make tasks ${fake.FAKE_PM_GARBAGE_MARKER}`);
    expect(turn.status).toBe("failed");
    expect(turn.error).toContain("could not be read");
    expect(state.proposals).toEqual([]);
  });

  test("an invalid proposal is dropped but the answer is kept", async () => {
    const dir = newProject("Bad task");
    await configure(dir);
    const { turn, state } = await ask(dir, `tasks ${fake.FAKE_PM_BADTASK_MARKER}`);
    expect(turn.status).toBe("succeeded");
    const reply = lastManager(state);
    expect(reply.proposalId).toBeNull();
    expect(reply.proposalError).toContain("acceptance criteria");
    expect(state.proposals).toEqual([]);
  });

  test("a plan request returns a structured plan", async () => {
    const dir = newProject("Plan");
    await configure(dir);
    const { state } = await ask(dir, "Give me a development plan");
    const reply = lastManager(state);
    expect(reply.plan.steps.map((s: any) => s.title)).toEqual(["Foundation", "Core flows", "Polish"]);
  });

  test("recommends the next task from the real backlog", async () => {
    const dir = newProject("Next");
    const created = await orchestrator.createTask({ title: "Set up CI", prompt: "ci", workdir: dir, isolation: "none" });
    if ("error" in created) throw new Error(created.error);
    await configure(dir);
    const { state } = await ask(dir, "What should we do next?");
    expect(lastManager(state).text).toContain(`#${created.task.id.slice(0, 8)} Set up CI`);
  });
});

describe("proposals", () => {
  async function propose(dir: string, text = "Break user authentication into tasks") {
    const { state } = await ask(dir, text);
    const reply = lastManager(state);
    expect(reply.proposalId).toBeTruthy();
    return state.proposals.find((p: any) => p.id === reply.proposalId);
  }

  test("generates a proposal with criteria, priorities and dependencies", async () => {
    const dir = newProject("Auth");
    await configure(dir);
    const proposal = await propose(dir);
    expect(proposal.status).toBe("pending");
    expect(proposal.items.map((i: any) => i.title)).toEqual([
      "Create the user model",
      "Implement registration",
      "Implement user login",
      "Implement password recovery",
      "Add authentication tests",
    ]);
    expect(proposal.items[1].dependsOn).toEqual([{ kind: "item", itemId: "i1" }]);
    expect(proposal.items[0].acceptanceCriteria.length).toBe(2);
    expect(proposal.items[3].priority).toBe("medium");
    // Nothing is created before approval.
    expect(projectTasks(dir)).toEqual([]);
  });

  test("edit, then approve creates backlog tasks without starting agents", async () => {
    const dir = newProject("Approve");
    await configure(dir);
    const proposal = await propose(dir);
    const edited = await call("PATCH", `/project-manager/proposals/${proposal.id}`, {
      path: dir,
      revision: proposal.revision,
      items: [
        { id: "i1", title: "Create the users table", priority: "low" },
        { id: "i4", include: false },
      ],
    });
    expect(edited.status).toBe(200);
    expect(edited.json.items[0].title).toBe("Create the users table");
    // A stale revision is refused.
    const stale = await call("POST", `/project-manager/proposals/${proposal.id}/approve`, { path: dir, revision: proposal.revision });
    expect(stale.status).toBe(409);
    const approved = await call("POST", `/project-manager/proposals/${proposal.id}/approve`, {
      path: dir,
      revision: edited.json.revision,
      items: [{ id: "i2", description: "Sign-up form, endpoint and validation." }],
    });
    expect(approved.status).toBe(200);
    expect(approved.json.proposal.status).toBe("approved");
    expect(approved.json.created.length).toBe(4);
    const tasks = projectTasks(dir);
    expect(tasks.map((t) => t.title).sort()).toEqual([
      "Add authentication tests",
      "Create the users table",
      "Implement registration",
      "Implement user login",
    ]);
    for (const task of tasks) {
      expect(task.column).toBe("backlog");
      expect(task.isolation).toBe("none");
      expect(task.runId).toBeNull();
      expect(task.worktreePath).toBeNull();
      expect(db.runs.listForTask(task.id)).toEqual([]);
    }
    const registration = tasks.find((t) => t.title === "Implement registration")!;
    const usersTable = tasks.find((t) => t.title === "Create the users table")!;
    expect(registration.prompt).toContain("Sign-up form, endpoint and validation.");
    expect(registration.prompt).toContain("## Acceptance criteria");
    expect(registration.prompt).toContain(`Create the users table (task ${usersTable.id.slice(0, 8)})`);
    expect(usersTable.prompt).toContain("Priority: Low");
    expect(approved.json.proposal.items.find((i: any) => i.id === "i4").result.status).toBe("skipped");

    // Approving again (double click, replayed request) creates nothing.
    const again = await call("POST", `/project-manager/proposals/${proposal.id}/approve`, { path: dir, revision: 1 });
    expect(again.status).toBe(200);
    expect(again.json.alreadyApproved).toBe(true);
    expect(projectTasks(dir).length).toBe(4);

    const state = (await call("GET", `/project-manager?${q(dir)}`)).json;
    expect(state.decisions.some((d: any) => d.source === "approval")).toBe(true);
    expect(state.messages.at(-1).role).toBe("system");
  });

  test("tasks land in the proposal's own project", async () => {
    const a = newProject("Target A");
    const b = newProject("Target B");
    await configure(a);
    const proposal = await propose(a);
    // Another project's path can't reach this proposal.
    const cross = await call("POST", `/project-manager/proposals/${proposal.id}/approve`, { path: b, revision: proposal.revision });
    expect(cross.status).toBe(404);
    const ok = await call("POST", `/project-manager/proposals/${proposal.id}/approve`, { path: a, revision: proposal.revision });
    expect(ok.status).toBe(200);
    expect(projectTasks(a).length).toBe(5);
    expect(projectTasks(b).length).toBe(0);
  });

  test("Git projects retain worktree isolation before canonical creation without creating a development worktree", async () => {
    // Read-only Git probe against the existing checkout; capture the creation
    // input instead of persisting or launching any task in the developer repo.
    const dir = realpathSync(path.resolve(import.meta.dir, "../.."));
    db.projects.upsert(dir, "Read-only Git capability fixture");
    try {
      await configure(dir);
      const proposal = await propose(dir);
      const inputs: Parameters<typeof orchestrator.createTask>[0][] = [];
      const result = await manager.approveProposal(dir, proposal.id, { revision: proposal.revision }, {
        createTask: async (input) => { inputs.push(input); return { error: "Fixture capture: no task persisted." }; },
      });
      expect(result.ok).toBe(true);
      expect(inputs.length).toBeGreaterThan(0);
      expect(inputs.every(input => input.isolation === "worktree" && input.workdir === dir)).toBe(true);
      expect(projectTasks(dir)).toEqual([]);
    } finally { db.projects.delete(dir); }
  });

  test("invalid Git metadata blocks PM approval without silently choosing none", async () => {
    const dir = newProject("Invalid Git");
    writeFileSync(path.join(dir, ".git"), "gitdir: /nonexistent/fo012c-invalid-git\n");
    await configure(dir);
    const proposal = await propose(dir);
    const result = await call("POST", `/project-manager/proposals/${proposal.id}/approve`, { path: dir, revision: proposal.revision });
    expect(result.status).toBe(409);
    expect(result.json.error).toContain("Cannot verify");
    expect(projectTasks(dir)).toEqual([]);
    const state = (await call("GET", `/project-manager?${q(dir)}`)).json;
    expect(state.proposals.find((p: any) => p.id === proposal.id).revision).toBe(proposal.revision);
  });

  test("reject creates nothing", async () => {
    const dir = newProject("Reject");
    await configure(dir);
    const proposal = await propose(dir);
    const rejected = await call("POST", `/project-manager/proposals/${proposal.id}/reject`, { path: dir });
    expect(rejected.status).toBe(200);
    expect(rejected.json.status).toBe("rejected");
    const approve = await call("POST", `/project-manager/proposals/${proposal.id}/approve`, { path: dir, revision: rejected.json.revision });
    expect(approve.status).toBe(409);
    expect(projectTasks(dir)).toEqual([]);
  });

  test("concurrent approvals create each task once", async () => {
    const dir = newProject("Double click");
    await configure(dir);
    const proposal = await propose(dir);
    const body = { path: dir, revision: proposal.revision };
    const [first, second] = await Promise.all([
      call("POST", `/project-manager/proposals/${proposal.id}/approve`, body),
      call("POST", `/project-manager/proposals/${proposal.id}/approve`, body),
    ]);
    expect([first.status, second.status].sort()).toEqual([200, 409]);
    expect(projectTasks(dir).length).toBe(5);
  });

  test("partial failure keeps what was created and a retry creates only the rest", async () => {
    const dir = newProject("Partial");
    await configure(dir);
    const proposal = await propose(dir);
    let calls = 0;
    const flaky: typeof orchestrator.createTask = async (input) => {
      calls += 1;
      if (calls === 3) return { error: "disk full" };
      return orchestrator.createTask(input);
    };
    const first = await manager.approveProposal(dir, proposal.id, { revision: proposal.revision }, { createTask: flaky });
    if (!first.ok) throw new Error(first.error);
    expect(first.value.proposal.status).toBe("partial");
    expect(first.value.created.length).toBe(4);
    const failed = first.value.proposal.items.filter((i) => i.result?.status === "failed");
    expect(failed.length).toBe(1);
    expect(failed[0]!.result!.error).toBe("disk full");
    expect(projectTasks(dir).length).toBe(4);

    const retry = await manager.approveProposal(dir, proposal.id, { revision: first.value.proposal.revision });
    if (!retry.ok) throw new Error(retry.error);
    expect(retry.value.proposal.status).toBe("approved");
    expect(retry.value.created.length).toBe(1);
    expect(projectTasks(dir).length).toBe(5);
    expect(new Set(projectTasks(dir).map((t) => t.title)).size).toBe(5);
  });

  test("an item left 'creating' by a crash adopts its task instead of duplicating", async () => {
    const dir = newProject("Crash");
    await configure(dir);
    const proposal = await propose(dir);
    let calls = 0;
    const crashing: typeof orchestrator.createTask = async (input) => {
      calls += 1;
      const out = await orchestrator.createTask(input);
      if (calls === 1) throw new Error("process died after insert");
      return out;
    };
    const first = await manager.approveProposal(dir, proposal.id, { revision: proposal.revision }, { createTask: crashing });
    if (!first.ok) throw new Error(first.error);
    // Simulate the crash leaving the first item in "creating".
    const stored = first.value.proposal;
    const items = stored.items.map((i) => (i.id === "i1" ? { ...i, result: { status: "creating" as const, taskId: null, error: null, at: Date.now() - 50 } } : i));
    db.projectManagers.putProposal(dir, stored.id, "partial", JSON.stringify({ ...stored, items, status: "partial" }), stored.createdAt);
    const retry = await manager.approveProposal(dir, proposal.id, { revision: stored.revision });
    if (!retry.ok) throw new Error(retry.error);
    expect(retry.value.created).toEqual([]);
    expect(projectTasks(dir).filter((t) => t.title === "Create the user model").length).toBe(1);
    expect(retry.value.proposal.status).toBe("approved");
  });

  test("duplicates of existing tasks and of each other are flagged and not recreated", async () => {
    const dir = newProject("Dups");
    const existing = await orchestrator.createTask({ title: "Implement user login", prompt: "x", workdir: dir, isolation: "none" });
    if ("error" in existing) throw new Error(existing.error);
    await configure(dir);
    const proposal = await propose(dir, `tasks ${fake.FAKE_PM_DUP_MARKER}`);
    expect(proposal.items[0].duplicate).toMatchObject({ kind: "task", taskId: existing.task.id });
    expect(proposal.items[0].duplicateAction).toBe("use-existing");
    expect(proposal.items[1].duplicate).toMatchObject({ kind: "task", taskId: existing.task.id });
    const approved = await call("POST", `/project-manager/proposals/${proposal.id}/approve`, {
      path: dir,
      revision: proposal.revision,
      items: [{ id: "i2", duplicateAction: "skip" }],
    });
    expect(approved.status).toBe(200);
    const items = approved.json.proposal.items;
    expect(items[0].result).toMatchObject({ status: "linked", taskId: existing.task.id });
    expect(items[1].result.status).toBe("skipped");
    expect(items[2].result.status).toBe("created");
    const recovery = projectTasks(dir).find((t) => t.title === "Implement password recovery")!;
    // The dependency points at the existing task it was linked to.
    expect(recovery.prompt).toContain(`(task ${existing.task.id.slice(0, 8)})`);
    expect(projectTasks(dir).filter((t) => t.title === "Implement user login").length).toBe(1);
  });

  test("a matching task that appears after review stops the approve", async () => {
    const dir = newProject("Late dup");
    await configure(dir);
    const proposal = await propose(dir);
    await orchestrator.createTask({ title: "Implement registration", prompt: "made by hand", workdir: dir, isolation: "none" });
    const res = await call("POST", `/project-manager/proposals/${proposal.id}/approve`, { path: dir, revision: proposal.revision });
    expect(res.status).toBe(409);
    expect(res.json.proposal.items[1].duplicate.kind).toBe("task");
    expect(projectTasks(dir).length).toBe(1);
    const ok = await call("POST", `/project-manager/proposals/${proposal.id}/approve`, { path: dir, revision: res.json.proposal.revision });
    expect(ok.status).toBe(200);
    expect(projectTasks(dir).filter((t) => t.title === "Implement registration").length).toBe(1);
  });

  test("edits can't empty an included item", async () => {
    const dir = newProject("Edit guard");
    await configure(dir);
    const proposal = await propose(dir);
    const res = await call("PATCH", `/project-manager/proposals/${proposal.id}`, {
      path: dir,
      revision: proposal.revision,
      items: [{ id: "i1", acceptanceCriteria: [] }],
    });
    expect(res.status).toBe(400);
    expect(res.json.error).toContain("acceptance criterion");
  });
});

describe("isolation of the turn", () => {
  test("a turn writes nothing to the project and leaves no scratch files", async () => {
    const dir = newProject("Untouched", { "docs/IDEA.md": "# Idea\n" });
    await configure(dir);
    const before = readdirSync(dir, { recursive: true }).sort();
    await ask(dir, "What is this project?");
    expect(readdirSync(dir, { recursive: true }).sort()).toEqual(before);
    const scratch = path.join(DATA_DIR, "interview-scratch");
    let left: string[] = [];
    try {
      left = readdirSync(scratch);
    } catch {
      left = [];
    }
    expect(left).toEqual([]);
  });
});
