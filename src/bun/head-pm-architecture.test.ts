import { beforeAll, afterAll, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdirSync, mkdtempSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { migrations } from "./migrations/index.ts";
import { migrate } from "./migrate.ts";
import { AccountCore } from "./account-core.ts";
import type { PortfolioManagerState } from "../shared/portfolio-manager.ts";

const root = realpathSync(mkdtempSync(join(tmpdir(), "fo-arch01-core-")));
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

test("scoped Head uses the selected Cursor profile, requires consent and persists one fake reply", async () => {
  store.harnesses.setEnabled("cursor", true);
  const profile = store.agentProfiles.insert({ name: "Head Cursor", harness: "cursor", model: "grok-4.7", effort: "high" });
  const accounts = new AccountCore(store.db);
  const account = accounts.createAccount({ provider: "cursor", displayName: "Fixture Cursor" });
  accounts.bindHarness(account.id, "cursor");
  accounts.bindProfile(account.id, profile.id);
  const untouched = ["project_manager_messages", "runs", "browser_agent_grants", "native_computer_agent_grants"]
    .map((table) => store.db.query(`SELECT * FROM ${table}`));
  const snapshot = () => untouched.map((query) => query.all());
  const before = snapshot();
  const calls = fake.portfolio;
  const scope = { kind: "project", path: alpha };
  const text = "__fake_head_scope__ Cursor route";
  try {
    await call("PUT", "/portfolio-manager/config", { config: { profileId: profile.id, consentKey: null } });
    const preflight = await call("POST", "/portfolio-manager/preflight");
    expect(preflight.harness.id).toBe("cursor");
    expect(preflight.model).toBe("grok-4.7");
    await call("POST", "/portfolio-manager/messages", { text, scope }, 428);
    expect(fake.portfolio).toBe(calls);
    await call("PUT", "/portfolio-manager/config", { config: { profileId: profile.id, consentKey: preflight.isolation.consentKey } });
    const state = await send(text, scope);
    const reply = state.messages.at(-1)!;
    expect(reply).toMatchObject({ role: "manager", headScope: { scope } });
    expect(reply.text).toContain("Alpha");
    const row = store.db.query<{ requested_runtime: string }, [string]>(
      "SELECT requested_runtime FROM portfolio_manager_turn_attributions WHERE turn_id = ?",
    ).get(reply.attribution!.turnId)!;
    expect(JSON.parse(row.requested_runtime)).toMatchObject({
      harnessId: "cursor", model: "grok-4.7", effort: "high", mode: "ask",
      requestedAccountId: account.id, actualAccountId: null, actualModel: null,
    });
    expect((await call("GET", "/portfolio-manager")).messages.at(-1)).toEqual(reply);
    expect(snapshot()).toEqual(before);
    expect(fake.portfolio).toBe(calls + 1);
  } finally {
    await call("PUT", "/portfolio-manager/config", { config: { ...config, profileId: null } });
  }
});

test("120 adds durable Head proposals without rewriting the existing workspace", () => {
  using db = new Database(":memory:");
  const prior = migrations.slice(0, migrations.findIndex((item) => item.id === "120_head_board_proposals"));
  migrate(db, prior);
  db.run("INSERT INTO projects (path,name,added_at) VALUES ('/legacy','Legacy',1)");
  db.run(`INSERT INTO project_managers (project_path,config,updated_at) VALUES ('/legacy','{"harness":"cursor"}',1)`);
  db.run(`INSERT INTO project_manager_messages (id,project_path,seq,data,created_at)
    VALUES ('pm','/legacy',1,'{"id":"pm","role":"manager","text":"Original legacy message"}',1)`);
  db.run(`INSERT INTO portfolio_manager (id,config,updated_at) VALUES ('global','{"harness":"cursor"}',1)`);
  db.run(`INSERT INTO portfolio_manager_messages (id,seq,data,created_at)
    VALUES ('head',1,'{"id":"head","role":"manager","text":"Original Head message"}',1)`);
  db.run(`INSERT INTO tasks (id,title,prompt,"column",agent,workdir,created_at,updated_at)
    VALUES ('existing','Interrupted','Original prompt','running','cursor','/legacy',1,1)`);
  const tables = ["projects", "project_managers", "project_manager_messages", "project_manager_proposals",
    "portfolio_manager", "portfolio_manager_messages", "tasks", "runs", "ai_employees",
    "employee_task_assignments", "activity_events", "brain_context_grants"];
  const snapshot = () => tables.map((table) => db.query(`SELECT * FROM ${table}`).all());
  const before = snapshot();
  const throughHead = migrations.slice(0, prior.length + 1);
  expect(migrate(db, throughHead)).toEqual(["120_head_board_proposals"]);
  expect(migrate(db, throughHead)).toEqual([]);
  expect(snapshot()).toEqual(before);
  expect(db.query("SELECT * FROM head_board_proposals").all()).toEqual([]);
});

test("scopes, Brain grants, privileged actions, stale approvals, and restart fail closed", async () => {
  const cluster = await call("POST", "/clusters", { name: "Duplicate cluster", slug: "alpha-cluster" }, 201);
  await call("POST", "/clusters", { name: "Duplicate cluster", slug: "other-cluster" }, 201);
  await call("POST", `/clusters/${cluster.id}/projects`, { projectPath: alpha }, 201);
  const other = join(root, "other");
  mkdirSync(other);
  store.projects.upsert(other, "Beta");
  const before = fake.portfolio;
  await call("POST", "/portfolio-manager/messages", { scope: { kind: "cluster", id: "Duplicate cluster" }, text: "Which one?" }, 409);
  await call("POST", "/portfolio-manager/messages", { scope: { kind: "project", path: "Beta" }, text: "Which one?" }, 409);
  expect(fake.portfolio).toBe(before);
  await send("__fake_head_scope__ overview", { kind: "workspace" });
  expect(fake.lastPortfolioPrompt).not.toContain(alpha);
  await send("__fake_head_scope__ selected", { kind: "cluster", id: "alpha-cluster" });
  expect(fake.lastPortfolioPrompt).toContain(alpha);
  expect(fake.lastPortfolioPrompt).not.toContain(beta);

  const memory = async (projectPath: string, content: string) => call("POST", "/brain/memories", {
    scopeKind: "project", projectPath, title: content, kind: "fact", content,
  }, 201);
  const alphaMemory = await memory(alpha, "ALPHA_BRAIN_ONLY");
  const betaMemory = await memory(beta, "BETA_BRAIN_ONLY");
  const grant = async (projectPath: string, id: string) => {
    const body = { managerKind: "portfolio", mode: "projects", projectPaths: [projectPath] };
    const preview = await call("POST", "/brain/context/preview", { ...body, memories: [{ id }] });
    expect(preview.canApprove).toBe(true);
    const created = await call("POST", "/brain/context/grants", {
      ...body, previewKey: preview.previewKey, confirm: true,
      memories: preview.items.map((item: { id: string; revision: number; sha256: string }) => ({ id: item.id, revision: item.revision, sha256: item.sha256 })),
    }, 201);
    return created.grantId as string;
  };
  const a = { kind: "project", path: alpha };
  const b = { kind: "project", path: beta };
  const wrongGrant = await grant(beta, betaMemory.id);
  const turnsBefore = fake.portfolio;
  await call("POST", "/portfolio-manager/messages", { scope: a, text: "Read this", brainGrantId: wrongGrant }, 409);
  expect(fake.portfolio).toBe(turnsBefore);
  const board = (kind: string, fields: object) => `__fake_head_board__ ${JSON.stringify({ kind, ...fields })}`;
  const read = await send(board("create", { title: "Never create", description: "Uses a Brain grant" }), a,
    { brainGrantId: await grant(alpha, alphaMemory.id) });
  expect(fake.lastPortfolioPrompt).toContain("ALPHA_BRAIN_ONLY");
  expect(fake.lastPortfolioPrompt).not.toContain("BETA_BRAIN_ONLY");
  expect(read.boardProposals).toEqual([]);
  expect(read.messages.at(-1)?.protocolErrors.join(" ")).toContain("separate turn");
  await send("__fake_head_scope__ Beta follow-up", b);
  expect(fake.lastPortfolioPrompt).not.toContain("ALPHA_BRAIN_ONLY");
  expect(fake.lastPortfolioPrompt).not.toContain("Never create");
  await send("__fake_head_scope__ Alpha follow-up", a);
  expect(fake.lastPortfolioPrompt).not.toContain("ALPHA_BRAIN_ONLY");

  const infrastructure = await send(board("deploy", { environment: "staging", resourceId: cluster.id }), a);
  expect(infrastructure.boardProposals).toEqual([]);
  expect(infrastructure.messages.at(-1)?.protocolErrors).not.toHaveLength(0);
  expect(store.db.query("SELECT * FROM deployment_requests").all()).toEqual([]);
  const proposalState = await send(board("create", { title: "Move hazard", description: "Review the change." }), a);
  const id = proposalState.boardProposals!.at(-1)!.messageId;
  await call("POST", `/head-pm/board-proposals/${id}/approve`, { confirm: false }, 400);
  await call("POST", `/head-pm/board-proposals/${id}/approve`, { confirm: true }, 401, false);
  const nextCluster = await call("POST", "/clusters", { name: "Next cluster" }, 201);
  await call("POST", `/clusters/${nextCluster.id}/projects/move`, { projectPath: alpha });
  const stale = await call("POST", `/head-pm/board-proposals/${id}/approve`, { confirm: true });
  expect(stale.status).toBe("failed");
  expect(store.tasks.list()).toEqual([]);

  const createdState = await send(board("create", { title: "Keep this task", description: "Created exactly once." }), a);
  const approvedId = createdState.boardProposals!.at(-1)!.messageId;
  const applied = await call("POST", `/head-pm/board-proposals/${approvedId}/approve`, { confirm: true });
  const replay = await call("POST", `/head-pm/board-proposals/${approvedId}/approve`, { confirm: true });
  expect(replay).toEqual(applied);
  expect(store.tasks.list().map((task) => task.id)).toEqual([approvedId]);
  const pendingState = await send(board("create", { title: "Interrupted approval", description: "Must never run automatically." }), b);
  const pendingId = pendingState.boardProposals!.at(-1)!.messageId;
  store.db.run("UPDATE head_board_proposals SET status='applying' WHERE message_id=?", [pendingId]);
  store.portfolioManagerStore.appendMessage("interrupted-turn", JSON.stringify({
    id: "interrupted-turn", role: "owner", text: "Interrupted request", status: "pending",
  }), 1000);
  store.projectManagers.appendMessage(alpha, "legacy", JSON.stringify({
    id: "legacy", role: "manager", text: "Historical PM reply",
  }), 100);

  const script = `
    const { getPortfolioManagerState } = await import("./src/bun/portfolio-manager.ts");
    const { getManagerState } = await import("./src/bun/project-manager.ts");
    const { fakeTurnLog } = await import("./src/bun/portfolio-manager-fake.ts");
    const { tasks, runs } = await import("./src/bun/db.ts");
    console.log(JSON.stringify({ head: getPortfolioManagerState(), pm: getManagerState(${JSON.stringify(alpha)}),
      launches: fakeTurnLog.portfolio + fakeTurnLog.manager, tasks: tasks.list().map((task) => task.id), runs: runs.listForTask(${JSON.stringify(approvedId)}).length }));
  `;
  const restart = Bun.spawnSync([process.execPath, "--no-env-file", "-e", script], {
    env: { ...env, NODE_ENV: "test", PATH: "/usr/bin:/bin:/opt/homebrew/bin", HOME: root },
  });
  expect(restart.exitCode, restart.stderr.toString()).toBe(0);
  const restored = JSON.parse(restart.stdout.toString().trim().split("\n").at(-1)!);
  expect(restored.head.value.config).toMatchObject(config);
  expect(restored.head.value.activeTurn).toBeNull();
  expect(restored.head.value.messages).toHaveLength(pendingState.messages.length + 1);
  expect(restored.head.value.messages.at(-1).status).toBe("failed");
  expect(restored.head.value.boardProposals.find((item: { messageId: string }) => item.messageId === pendingId).status).toBe("failed");
  expect(restored.pm.value.messages[0].text).toBe("Historical PM reply");
  expect(restored.tasks).toEqual([approvedId]);
  expect(restored.launches).toBe(0);
  expect(restored.runs).toBe(0);
});
