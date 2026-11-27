import { beforeAll, afterAll, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdirSync, mkdtempSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { migrations } from "./migrations/index.ts";
import { migrate } from "./migrate.ts";
import type { PortfolioManagerState } from "../shared/portfolio-manager.ts";

const root = realpathSync(mkdtempSync(join(tmpdir(), "fo-d3-core-")));
const profile = join(root, "profile");
const alpha = join(root, "alpha");
const beta = join(root, "beta");
mkdirSync(alpha);
mkdirSync(beta);
const socket = Bun.listen({ hostname: "127.0.0.1", port: 0, socket: { data() {} } });
const port = socket.port;
socket.stop(true);
const env = {
  AGETOR_API_PORT: String(port),
  AGETOR_DATA_DIR: profile,
  FORGEORBIT_DATA_DIR: profile,
  AGETOR_USAGE_OFFLINE: "1",
  AGETOR_CODEX_DRIVER: "fake",
  AGETOR_CODEX_BIN: "/bin/echo",
  AGETOR_CURSOR_DRIVER: "fake",
  AGETOR_CURSOR_BIN: "/usr/bin/false",
  AGETOR_TMUX_BIN: "/bin/echo",
};
Object.assign(process.env, env);

let token: string;
let close: () => void;
let store: typeof import("./db.ts");
let fake: typeof import("./portfolio-manager-fake.ts").fakeTurnLog;
let config: { harness: string; model: string; effort: string; consentKey: string };

async function call(method: string, route: string, body?: unknown, expected = 200, auth = true) {
  const response = await fetch(`http://127.0.0.1:${port}${route}`, {
    method, headers: { ...(auth ? { authorization: `Bearer ${token}` } : {}), "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const result = await response.json();
  expect(response.status, `${method} ${route}: ${JSON.stringify(result)}`).toBe(expected);
  return result;
}

beforeAll(async () => {
  store = await import("./db.ts");
  fake = (await import("./portfolio-manager-fake.ts")).fakeTurnLog;
  const server = await import("./server.ts");
  const api = server.startApiServer();
  close = () => api.stop(true);
  token = server.API_TOKEN;
  store.harnesses.setEnabled("codex", true);
  const preflight = await call("POST", "/project-interviews/preflight", { harness: "codex", model: "gpt-6.1-sol", effort: "low" });
  config = { harness: "codex", model: "gpt-6.1-sol", effort: "low", consentKey: preflight.isolation.consentKey };
  await call("PUT", "/portfolio-manager/config", { config });
  store.projects.upsert(alpha, "Alpha");
  store.projects.upsert(beta, "Beta");
});
afterAll(() => close?.());

async function send(text: string, scope: object, extra: object = {}) {
  const sent = await call("POST", "/portfolio-manager/messages", { text, scope, ...extra }, 202);
  for (let i = 0; i < 80; i++) {
    const turn = await call("GET", `/portfolio-manager/turns/${sent.turn.id}`);
    if (turn.status !== "running") {
      expect(turn.status).toBe("succeeded");
      return (await call("GET", "/portfolio-manager") as PortfolioManagerState);
    }
    await Bun.sleep(25);
  }
  throw new Error("Fake Head turn did not settle");
}


let orchestrator: typeof import("./orchestrator.ts");
beforeAll(async () => { orchestrator = await import("./orchestrator.ts"); });

const a = { kind: "project", path: alpha };
const b = { kind: "project", path: beta };
const board = (fields: object) => `__fake_head_board__ ${JSON.stringify(fields)}`;
async function addTask(dir: string, title: string, prompt = "Fixture prompt.") {
  const made = await orchestrator.createTask({ title, prompt, workdir: dir, column: "backlog", agent: "codex", model: "gpt-6.1-sol", isolation: "none" } as never);
  if ("error" in made) throw new Error(made.error);
  return made.task;
}
const counts = () => ({
  tasks: store.db.query<{ n: number }, []>("SELECT COUNT(*) n FROM tasks").get()!.n,
  runs: store.db.query<{ n: number }, []>("SELECT COUNT(*) n FROM runs").get()!.n,
  exec: store.db.query<{ n: number }, []>("SELECT COUNT(*) n FROM employee_executions").get()!.n,
});
const proposals = async () => ((await call("GET", "/portfolio-manager")) as PortfolioManagerState).boardProposals ?? [];

test("scoped conversations: the displayed scope, the context supplied, switching and reopening", async () => {
  const alphaTask = await addTask(alpha, "ALPHA_TASK_TITLE");
  const betaTask = await addTask(beta, "BETA_TASK_TITLE");
  const baseline = counts();

  // Company scope: a bounded directory, counts, no task titles or prompts.
  let state = await send("__fake_head_scope__ company", { kind: "workspace" });
  const company = fake.lastPortfolioPrompt;
  expect(company).toContain("Alpha");
  expect(company).toContain("Beta");
  expect(company).not.toContain("ALPHA_TASK_TITLE");
  expect(company).not.toContain("BETA_TASK_TITLE");
  expect(state.messages.at(-1)!.headScope).toMatchObject({ scope: { kind: "workspace" }, label: "Workspace", projectPath: null });

  // Project scope: only that project's board.
  state = await send("__fake_head_scope__ alpha", a);
  expect(fake.lastPortfolioPrompt).toContain("ALPHA_TASK_TITLE");
  expect(fake.lastPortfolioPrompt).not.toContain("BETA_TASK_TITLE");
  expect(state.messages.at(-1)!.headScope).toMatchObject({ scope: a, projectPath: alpha });
  const alphaReply = state.messages.at(-1)!.text;

  // Switching: the other project's turn inherits nothing from the first project, not even its reply.
  state = await send("__fake_head_scope__ beta", b);
  expect(fake.lastPortfolioPrompt).toContain("BETA_TASK_TITLE");
  expect(fake.lastPortfolioPrompt).not.toContain("ALPHA_TASK_TITLE");
  expect(fake.lastPortfolioPrompt).not.toContain(alphaReply.slice(0, 40));

  // Back to the first project and to the company: still isolated.
  await send("__fake_head_scope__ alpha again", a);
  expect(fake.lastPortfolioPrompt).not.toContain("BETA_TASK_TITLE");
  await send("__fake_head_scope__ company again", { kind: "workspace" });
  expect(fake.lastPortfolioPrompt).not.toContain("ALPHA_TASK_TITLE");

  // Reopening reads the same record, with every message's scope, and starts nothing.
  const before = fake.portfolio;
  const reopened = await call("GET", "/portfolio-manager") as PortfolioManagerState;
  await call("GET", "/portfolio-manager");
  expect(reopened.messages.filter((m) => m.role === "manager").map((m) => m.headScope?.scope.kind)).toEqual(
    state.messages.filter((m) => m.role === "manager").map((m) => m.headScope?.scope.kind).concat(["project", "workspace"]));
  expect(fake.portfolio).toBe(before);
  expect(counts()).toEqual(baseline);
  void alphaTask; void betaTask;
});

test("a company-scoped proposal names the affected project before approval and applies only there", async () => {
  const alphaTask = await addTask(alpha, "Company bystander");
  const baseline = counts();
  const create = board({ kind: "create", project: "Beta", title: "Company-scoped create", description: "Proposed from the company scope." });
  const state = await send(create, { kind: "workspace" });
  const proposal = state.boardProposals!.at(-1)!;
  expect(proposal.status).toBe("pending");
  expect(proposal.affectedProjects).toEqual([{ path: beta, name: "Beta" }]);
  expect(proposal.context.projectPath).toBe(beta);
  expect(counts()).toEqual(baseline);

  const applied = await call("POST", `/head-pm/board-proposals/${proposal.messageId}/approve`, { confirm: true });
  expect(applied.status).toBe("applied");
  const created = store.tasks.get(proposal.messageId)!;
  expect(created.title).toBe("Company-scoped create");
  expect(created.workdir).toBe(beta);
  expect(created.column).toBe("backlog");
  expect(store.tasks.get(alphaTask.id)!.title).toBe("Company bystander");
  expect(counts()).toEqual({ ...baseline, tasks: baseline.tasks + 1 });
});

test("a company scope cannot edit an existing task it was never shown; a project scope names its project too", async () => {
  const betaTask = await addTask(beta, "Company edit target");
  const pending = (await proposals()).length;
  const refused = await send(board({ kind: "edit", taskId: betaTask.id, project: "Beta", title: "Company edit" }), { kind: "workspace" });
  expect((await proposals()).length).toBe(pending);
  expect(refused.messages.at(-1)!.protocolErrors.join(" ")).toMatch(/not in this turn's context/i);
  const state = await send(board({ kind: "edit", taskId: betaTask.id, title: "Project edit" }), b);
  const proposal = state.boardProposals!.at(-1)!;
  expect(proposal.affectedProjects).toEqual([{ path: beta, name: "Beta" }]);
});

test("invalid and out-of-scope targets are refused with no proposal and no change", async () => {
  const mine = await addTask(alpha, "Scope probe alpha");
  const theirs = await addTask(beta, "Scope probe beta");
  const baseline = counts();
  const pending = (await proposals()).length;
  const refused = async (fields: object, scope: object, why: RegExp) => {
    const state = await send(board(fields), scope);
    expect((await proposals()).length).toBe(pending);
    expect(state.messages.at(-1)!.protocolErrors.join(" ")).toMatch(why);
    expect(counts()).toEqual(baseline);
  };
  // A project turn cannot touch another project's task.
  await refused({ kind: "edit", taskId: theirs.id, title: "Hijack" }, a, /invalid|context/i);
  // A company turn must name the project, and a name that matches nothing is refused.
  await refused({ kind: "edit", taskId: mine.id, title: "No project named" }, { kind: "workspace" }, /Select the exact project/i);
  await refused({ kind: "edit", taskId: mine.id, project: "Nowhere", title: "Ghost project" }, { kind: "workspace" }, /unavailable|registered/i);
  // A task that is not in the named project.
  await refused({ kind: "edit", taskId: theirs.id, project: "Alpha", title: "Wrong project" }, { kind: "workspace" }, /invalid|context/i);
  // A task id that does not exist.
  await refused({ kind: "edit", taskId: "00000000-0000-4000-8000-000000000000", project: "Alpha", title: "Ghost task" }, { kind: "workspace" }, /invalid|context/i);
  // A cluster turn cannot name a project outside the cluster.
  const cluster = await call("POST", "/clusters", { name: "D3 cluster", slug: "d3-cluster" }, 201);
  await call("POST", `/clusters/${cluster.id}/projects`, { projectPath: alpha }, 201);
  await refused({ kind: "edit", taskId: theirs.id, project: "Beta", title: "Outside the cluster" }, { kind: "cluster", id: "d3-cluster" }, /not a member/i);
});

test("approve and reject settle exactly one reviewed action; stale and replayed approvals change nothing", async () => {
  const task = await addTask(alpha, "Settle target");
  const baseline = counts();
  const first = (await send(board({ kind: "edit", taskId: task.id, title: "Settle target v2" }), a)).boardProposals!.at(-1)!;
  const second = (await send(board({ kind: "edit", taskId: task.id, title: "Settle target v3" }), a)).boardProposals!.at(-1)!;
  expect(store.tasks.get(task.id)!.title).toBe("Settle target");
  // Reject: nothing changes, and a later approve of the rejected proposal changes nothing either.
  const rejected = await call("POST", `/head-pm/board-proposals/${first.messageId}/reject`, { confirm: true });
  expect(rejected.status).toBe("rejected");
  await call("POST", `/head-pm/board-proposals/${first.messageId}/approve`, { confirm: true }, 409);
  expect(store.tasks.get(task.id)!.title).toBe("Settle target");
  // Approve the other: applied once, replay is identical.
  const applied = await call("POST", `/head-pm/board-proposals/${second.messageId}/approve`, { confirm: true });
  expect(applied.status).toBe("applied");
  expect(await call("POST", `/head-pm/board-proposals/${second.messageId}/approve`, { confirm: true })).toEqual(applied);
  expect(store.tasks.get(task.id)!.title).toBe("Settle target v3");
  expect(counts()).toEqual(baseline);
  // A proposal whose task is gone when the Owner approves fails closed.
  const stale = (await send(board({ kind: "edit", taskId: task.id, title: "Settle target v4" }), a)).boardProposals!.at(-1)!;
  store.db.run("DELETE FROM tasks WHERE id = ?", [task.id]);
  const result = await call("POST", `/head-pm/board-proposals/${stale.messageId}/approve`, { confirm: true });
  expect(result.status).toBe("failed");
  expect(store.tasks.get(task.id)).toBeNull();
});

test("a task-scoped turn can only propose for the task it was shown", async () => {
  const shown = await addTask(alpha, "Task scope shown");
  const hidden = await addTask(alpha, "Task scope hidden sibling");
  const baseline = counts();
  const pending = (await proposals()).length;
  const scope = { kind: "task", id: shown.id };
  const state = await send(board({ kind: "edit", taskId: hidden.id, title: "Sibling hijack" }), scope);
  expect((await proposals()).length).toBe(pending);
  expect(state.messages.at(-1)!.protocolErrors.join(" ")).toMatch(/invalid|context/i);
  expect(counts()).toEqual(baseline);
  expect(store.tasks.get(hidden.id)!.title).toBe("Task scope hidden sibling");
  // The task it was shown is fine.
  const ok = await send(board({ kind: "edit", taskId: shown.id, title: "Task scope shown v2" }), scope);
  expect(ok.boardProposals!.at(-1)!.status).toBe("pending");
});

test("a specialist outside the scope cannot be proposed; one the scope listed can", async () => {
  const { EmployeeCore } = await import("./employee-core.ts");
  const core = new EmployeeCore(store.db);
  const mine = core.createWorker({ name: "Alpha Specialist", jobTitle: "Engineer", projectPath: alpha });
  const theirs = core.createWorker({ name: "Beta Specialist", jobTitle: "Engineer", projectPath: beta });
  const task = await addTask(alpha, "Assign probe");
  await call("PATCH", `/tasks/${task.id}`, { column: "inbox" });
  const pending = (await proposals()).length;
  const refused = await send(board({ kind: "assign", taskId: task.id, employeeId: theirs.id }), a);
  expect((await proposals()).length).toBe(pending);
  expect(refused.messages.at(-1)!.protocolErrors.join(" ")).toMatch(/Specialist not found in this scope/);
  const ok = await send(board({ kind: "assign", taskId: task.id, employeeId: mine.id }), a);
  const proposal = ok.boardProposals!.at(-1)!;
  expect(proposal).toMatchObject({ status: "pending", action: { kind: "assign", employeeId: mine.id } });
  expect(proposal.affectedProjects).toEqual([{ path: alpha, name: "Alpha" }]);
  // Nothing is assigned until the Owner approves.
  expect(store.db.query("SELECT 1 FROM employee_task_assignments WHERE task_id = ?").get(task.id)).toBeNull();
});

test("workspace and project scopes support create_batch to add multiple Backlog tasks in one approval", async () => {
  const baseline = counts();
  // Workspace prompt advertises create_batch so Head of PM can create tasks directly from Workspace scope.
  await send("__fake_head_scope__ batch prompt check", { kind: "workspace" });
  expect(fake.lastPortfolioPrompt).toContain('"kind":"create_batch"');

  // Workspace-scoped batch targeting one project (including terse item with omitted description).
  const batchMsg = board({
    kind: "create_batch",
    project: "Beta",
    tasks: [
      { title: "Batch task 1", description: "Implement login page." },
      { title: "Batch task 2", description: "Add dark mode toggle." },
      { title: "Batch task 3" },
    ],
  });
  const state = await send(batchMsg, { kind: "workspace" });
  const proposal = state.boardProposals!.at(-1)!;
  expect(proposal.status).toBe("pending");
  expect(proposal.action.kind).toBe("create_batch");
  expect(proposal.affectedProjects).toEqual([{ path: beta, name: "Beta" }]);
  expect(proposal.context.projectPath).toBe(beta);
  expect(counts()).toEqual(baseline);

  const applied = await call("POST", `/head-pm/board-proposals/${proposal.messageId}/approve`, { confirm: true });
  expect(applied.status).toBe("applied");
  expect(applied.action.kind).toBe("create_batch");
  const ids = applied.action.createdTaskIds as string[];
  expect(ids).toHaveLength(3);
  expect(counts()).toEqual({ ...baseline, tasks: baseline.tasks + 3 });
  const created = ids.map((taskId) => store.tasks.get(taskId)!);
  expect(created.map((t) => ({ title: t.title, prompt: t.prompt, workdir: t.workdir, column: t.column }))).toEqual([
    { title: "Batch task 1", prompt: "Implement login page.", workdir: beta, column: "backlog" },
    { title: "Batch task 2", prompt: "Add dark mode toggle.", workdir: beta, column: "backlog" },
    { title: "Batch task 3", prompt: "Batch task 3", workdir: beta, column: "backlog" },
  ]);
  // Replaying approve is idempotent and does not duplicate tasks.
  expect(await call("POST", `/head-pm/board-proposals/${proposal.messageId}/approve`, { confirm: true })).toEqual(applied);
  expect(counts()).toEqual({ ...baseline, tasks: baseline.tasks + 3 });

  // Multi-project batch from Workspace scope creates each task in its own project.
  const crossState = await send(board({
    kind: "create_batch",
    tasks: [
      { project: "Alpha", title: "Alpha batch item", description: "For Alpha." },
      { project: "Beta", title: "Beta batch item", description: "For Beta." },
    ],
  }), { kind: "workspace" });
  const crossProposal = crossState.boardProposals!.at(-1)!;
  expect(crossProposal.status).toBe("pending");
  expect(crossProposal.affectedProjects).toEqual([{ path: alpha, name: "Alpha" }, { path: beta, name: "Beta" }]);
  const crossApplied = await call("POST", `/head-pm/board-proposals/${crossProposal.messageId}/approve`, { confirm: true });
  expect(crossApplied.status).toBe("applied");
  const crossIds = crossApplied.action.createdTaskIds as string[];
  expect(store.tasks.get(crossIds[0]!)!.workdir).toBe(alpha);
  expect(store.tasks.get(crossIds[1]!)!.workdir).toBe(beta);
  expect(counts()).toEqual({ ...baseline, tasks: baseline.tasks + 5 });

  // Single-item create_batch normalizes to single create.
  const singleState = await send(board({
    kind: "create_batch",
    project: "Alpha",
    tasks: [{ title: "Solo batch item", description: "Just one." }],
  }), { kind: "workspace" });
  expect(singleState.boardProposals!.at(-1)!.action.kind).toBe("create");

  // Scope and limit enforcement: project-scoped batch cannot target another project; >25 tasks rejected.
  const pendingCount = (await proposals()).length;
  const crossScopeRefused = await send(board({
    kind: "create_batch",
    tasks: [
      { title: "Ok in Alpha", description: "Fine" },
      { project: "Beta", title: "Sneaky Beta", description: "Out of scope" },
    ],
  }), a);
  expect((await proposals()).length).toBe(pendingCount);
  expect(crossScopeRefused.messages.at(-1)!.protocolErrors.join(" ")).toMatch(/outside the selected scope/i);

  const tooManyRefused = await send(board({
    kind: "create_batch",
    project: "Alpha",
    tasks: Array.from({ length: 26 }, (_, i) => ({ title: `Task ${i + 1}`, description: `Desc ${i + 1}` })),
  }), { kind: "workspace" });
  expect((await proposals()).length).toBe(pendingCount);
  expect(tooManyRefused.messages.at(-1)!.protocolErrors.join(" ")).toMatch(/at most 25/i);
});
