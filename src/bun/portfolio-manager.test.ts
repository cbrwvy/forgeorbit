import { afterAll, beforeAll, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";

/**
 * FO-008C global portfolio manager: runner, context, plans, delegations and
 * routes. Every agent is the fake codex driver (`AGETOR_CODEX_DRIVER=fake`):
 * no real CLI runs and no AI quota is spent. The codex binary is /bin/echo,
 * so even the pre-flight's local probes never reach a real AI CLI.
 */

const DATA_DIR = mkdtempSync(path.join(tmpdir(), "fo008c-portfolio-"));
process.env.AGETOR_DATA_DIR = DATA_DIR;
process.env.AGETOR_API_PORT = "4681";
process.env.AGETOR_CODEX_DRIVER = "fake";
process.env.AGETOR_CODEX_BIN = "/bin/echo";
process.env.AGETOR_CURSOR_BIN = "/nonexistent/cursor-agent";
process.env.AGETOR_TMUX_BIN = "/bin/echo";

let base = "";
let token = "";
let server: { stop: () => void };
let db: typeof import("./db.ts");
let portfolio: typeof import("./portfolio-manager.ts");
let fake: typeof import("./portfolio-manager-fake.ts");
let consent = "";

beforeAll(async () => {
  db = await import("./db.ts");
  portfolio = await import("./portfolio-manager.ts");
  fake = await import("./portfolio-manager-fake.ts");
  const started = await import("./server.ts");
  token = started.API_TOKEN;
  server = started.startApiServer() as unknown as { stop: () => void };
  base = `http://127.0.0.1:${process.env.AGETOR_API_PORT}`;
  db.harnesses.setEnabled("codex", true);
  const preflight = await call("POST", "/project-interviews/preflight", { harness: "codex", model: "gpt-6.1-sol" });
  expect(preflight.status).toBe(200);
  consent = preflight.json.isolation.consentKey;
});

afterAll(() => {
  server?.stop?.();
});

beforeEach(() => {
  for (const project of db.projects.list()) db.projects.delete(project.path);
});

async function call(method: string, route: string, body?: unknown): Promise<{ status: number; json: any }> {
  const res = await fetch(`${base}${route}`, {
    method,
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: res.status, json: await res.json().catch(() => null) };
}

function newProject(name: string, files: Record<string, string> = {}): string {
  const dir = realpathSync(mkdtempSync(path.join(tmpdir(), "fo008c-proj-")));
  for (const [rel, text] of Object.entries(files)) {
    mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
    writeFileSync(path.join(dir, rel), text);
  }
  db.projects.upsert(dir, name);
  return dir;
}

function addTask(workdir: string, title: string, column: "backlog" | "ready" | "running" | "blocked" | "review" | "done" = "backlog"): string {
  const now = Date.now();
  const id = randomUUID();
  db.tasks.insert({
    id,
    title,
    prompt: title,
    column,
    agent: "codex",
    workdir,
    isolation: "none",
    taskType: "task",
    branch: null,
    branchSource: "created",
    worktreePath: null,
    baseRef: null,
    prUrl: null,
    mode: null,
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
  return id;
}

async function configurePortfolio(overrides: Record<string, unknown> = {}): Promise<void> {
  const res = await call("PUT", "/portfolio-manager/config", {
    config: { harness: "codex", model: "gpt-6.1-sol", effort: "low", consentKey: consent, ...overrides },
  });
  expect(res.status).toBe(200);
}

async function configureProjectManager(dir: string): Promise<void> {
  const res = await call("PUT", "/project-manager/config", {
    path: dir,
    config: { harness: "codex", model: "gpt-6.1-sol", effort: "low", consentKey: consent },
  });
  expect(res.status).toBe(200);
}

async function settle(route: string): Promise<any> {
  for (let i = 0; i < 400; i++) {
    const { json } = await call("GET", route);
    if (json?.status && json.status !== "running") return json;
    await Bun.sleep(20);
  }
  throw new Error(`turn never settled: ${route}`);
}

async function ask(text: string): Promise<{ turn: any; state: any }> {
  const sent = await call("POST", "/portfolio-manager/messages", { text });
  expect(sent.status).toBe(202);
  const turn = await settle(`/portfolio-manager/turns/${sent.json.turn.id}`);
  const state = (await call("GET", "/portfolio-manager")).json;
  return { turn, state };
}

function lastManager(state: any): any {
  return [...state.messages].reverse().find((m: any) => m.role === "manager");
}

function pmMessages(dir: string): any[] {
  return db.projectManagers.listMessages(dir).map((raw) => JSON.parse(raw));
}

test("every portfolio manager route requires the API token", async () => {
  const routes: [string, string][] = [
    ["GET", "/portfolio-manager"],
    ["PUT", "/portfolio-manager/config"],
    ["GET", "/portfolio-manager/context"],
    ["POST", "/portfolio-manager/preflight"],
    ["POST", "/portfolio-manager/messages"],
    ["GET", "/portfolio-manager/turns/x"],
    ["DELETE", "/portfolio-manager/turns/x"],
    ["POST", "/portfolio-manager/plans/x/accept"],
    ["POST", "/portfolio-manager/plans/x/dismiss"],
    ["POST", "/portfolio-manager/delegations/x/approve"],
    ["POST", "/portfolio-manager/delegations/x/reject"],
    ["POST", "/portfolio-manager/decisions"],
    ["DELETE", "/portfolio-manager/decisions/x"],
  ];
  for (const [method, route] of routes) {
    const res = await fetch(`${base}${route}`, { method, body: method === "GET" || method === "DELETE" ? undefined : "{}" });
    expect(res.status).toBe(401);
    const forged = await fetch(`${base}${route}`, { method, headers: { authorization: "Bearer nope" }, body: method === "GET" || method === "DELETE" ? undefined : "{}" });
    expect(forged.status).toBe(401);
  }
});

describe("one global manager", () => {
  test("its config is global and independent of project managers", async () => {
    const dir = newProject("Solo");
    await configurePortfolio({ language: "ru", instructions: "Prefer finishing work over starting it.", extraDocs: ["docs/X.md"] });
    const state = (await call("GET", "/portfolio-manager")).json;
    expect(state.config.language).toBe("ru");
    expect(state.config.instructions).toBe("Prefer finishing work over starting it.");
    // The portfolio manager never reads project documents.
    expect(state.config.extraDocs).toEqual([]);
    const pm = (await call("GET", `/project-manager?path=${encodeURIComponent(dir)}`)).json;
    expect(pm.config.language).toBe("auto");
    expect(pm.messages).toEqual([]);
  });

  test("an unknown harness or profile is refused", async () => {
    expect((await call("PUT", "/portfolio-manager/config", { config: { harness: "ghost" } })).status).toBe(400);
    expect((await call("PUT", "/portfolio-manager/config", { config: { profileId: "nope" } })).status).toBe(400);
  });

  test("a message needs confirmed consent first", async () => {
    newProject("Consent");
    await configurePortfolio({ consentKey: null });
    const sent = await call("POST", "/portfolio-manager/messages", { text: "hello" });
    expect(sent.status).toBe(428);
    expect(sent.json.isolation.consentKey).toBe(consent);
    await configurePortfolio();
  });
});

describe("context", () => {
  test("an empty portfolio is reported as empty, not finished", async () => {
    await configurePortfolio();
    const context = (await call("GET", "/portfolio-manager/context")).json;
    expect(context.projectCount).toBe(0);
    expect(context.sources.find((s: any) => s.id === "projects").status).toBe("missing");
    const { state } = await ask("What is happening in all my projects?");
    expect(lastManager(state).text).toContain("Portfolio: 0 project(s)");
    expect(fake.fakeTurnLog.lastPortfolioPrompt).toContain("(No registered projects.)");
  });

  test("the prompt carries real portfolio data, redacted, without project files", async () => {
    await configurePortfolio();
    const alpha = newProject("Alpha", { ".env": "OPENAI_API_KEY=sk-proj-REALSECRETREALSECRET1234", "src/app.ts": "const hidden = 'SOURCE_CODE_MARKER';" });
    mkdirSync(path.join(alpha, "packages", "web"), { recursive: true });
    addTask(alpha, "Fix login crash", "blocked");
    addTask(path.join(alpha, "packages", "web"), "Subfolder task in web", "review");
    addTask(alpha, "Rotate token sk-ant-LEAKEDLEAKEDLEAKED123456", "ready");
    const beta = newProject("Beta");
    const old = Date.now() - 3 * 24 * 3600_000;
    db.db.run(
      `INSERT INTO environment_profiles (id, project_path, data, updated_at) VALUES (?, ?, ?, ?)`,
      [`env-${randomUUID()}`, beta, JSON.stringify({ runtime: { phase: "degraded", updatedAt: old } }), old],
    );
    await ask("What is happening?");
    const prompt = fake.fakeTurnLog.lastPortfolioPrompt;
    expect(prompt).toContain("— Alpha (");
    expect(prompt).toContain("— Beta (");
    expect(prompt).toContain("Fix login crash");
    // Tasks in a subfolder of the project count on it.
    expect(prompt).toContain("Subfolder task in web");
    // An old environment phase is history, not the present state.
    expect(prompt).toContain("Environment: current state unknown — last recorded degraded");
    // Accounts are never invented.
    expect(prompt).toContain("account not identified (may share an account with another harness)");
    expect(prompt).not.toContain("LEAKEDLEAKEDLEAKED");
    expect(prompt).not.toContain("REALSECRET");
    expect(prompt).not.toContain("SOURCE_CODE_MARKER");
    expect(prompt).toContain("A project with no tasks is empty, not finished.");
    // Registered paths are legitimate portfolio data and may contain the
    // application's name (including when TMPDIR is named for a QA run).
    const withoutPaths = prompt.replaceAll(alpha, "[alpha]").replaceAll(beta, "[beta]");
    expect(withoutPaths.toLowerCase()).not.toContain("forgeorbit");
    expect(withoutPaths.toLowerCase()).not.toContain("agetor");
  });

  test("reading the state and the context starts no process and calls no model", async () => {
    const alpha = newProject("Quiet");
    addTask(alpha, "Something", "ready");
    const spawn = spyOn(Bun, "spawn");
    const spawnSync = spyOn(Bun, "spawnSync");
    const before = fake.fakeTurnLog.portfolio + fake.fakeTurnLog.manager;
    try {
      expect((await call("GET", "/portfolio-manager")).status).toBe(200);
      expect((await call("GET", "/portfolio-manager/context")).status).toBe(200);
      expect(spawn).not.toHaveBeenCalled();
      expect(spawnSync).not.toHaveBeenCalled();
    } finally {
      spawn.mockRestore();
      spawnSync.mockRestore();
    }
    expect(fake.fakeTurnLog.portfolio + fake.fakeTurnLog.manager).toBe(before);
  });

  test("a large portfolio is cut deterministically and says so", async () => {
    const dirs = Array.from({ length: 3 }, (_, i) => newProject(`Many ${i}`));
    for (const dir of dirs) addTask(dir, "work", "backlog");
    const gathered = portfolio.gatherPortfolioContext();
    expect(gathered.context.projects.map((item) => item.name)).toEqual(["Many 0", "Many 1", "Many 2"]);
    expect(gathered.context.omittedProjects).toBe(0);
    expect([...gathered.refs.keys()]).toEqual(["P1", "P2", "P3"]);
  });
});

describe("chat", () => {
  test("multi-turn conversation keeps the history", async () => {
    newProject("Gamma");
    await configurePortfolio();
    await ask("First question about my projects");
    const { state } = await ask("Second question");
    expect(fake.fakeTurnLog.lastPortfolioPrompt).toContain("Owner: First question about my projects");
    expect(lastManager(state).text).toMatch(/Earlier messages: [1-9]/);
  });

  test("a failed turn keeps the message and redacts the CLI error", async () => {
    newProject("Delta");
    await configurePortfolio();
    const { turn, state } = await ask("check __fake_portfolio_secret__");
    expect(turn.status).toBe("failed");
    const owner = [...state.messages].reverse().find((m: any) => m.role === "owner");
    expect(owner.status).toBe("failed");
    expect(JSON.stringify(state)).not.toContain("fakeSECRETfakeSECRET");
  });

  test("cancel stops a running turn", async () => {
    newProject("Epsilon");
    await configurePortfolio();
    const sent = await call("POST", "/portfolio-manager/messages", { text: "slow __fake_portfolio_slow__" });
    expect(sent.status).toBe(202);
    expect((await call("POST", "/portfolio-manager/messages", { text: "second" })).status).toBe(409);
    expect((await call("DELETE", `/portfolio-manager/turns/${sent.json.turn.id}`)).status).toBe(200);
    const turn = await settle(`/portfolio-manager/turns/${sent.json.turn.id}`);
    expect(turn.status).toBe("cancelled");
    const state = (await call("GET", "/portfolio-manager")).json;
    expect(state.messages.find((m: any) => m.id === sent.json.message.id).status).toBe("cancelled");
  });

  test("a message pending at restart becomes retryable, and retry answers it", async () => {
    newProject("Zeta");
    await configurePortfolio();
    const id = randomUUID();
    db.portfolioManagerStore.appendMessage(id, JSON.stringify({ id, role: "owner", text: "Orphaned question", createdAt: Date.now(), status: "pending" }), 400);
    const state = (await call("GET", "/portfolio-manager")).json;
    const orphan = state.messages.find((m: any) => m.id === id);
    expect(orphan.status).toBe("failed");
    expect(orphan.error).toContain("closed");
    const retry = await call("POST", "/portfolio-manager/messages", { retryMessageId: id });
    expect(retry.status).toBe(202);
    await settle(`/portfolio-manager/turns/${retry.json.turn.id}`);
    const after = (await call("GET", "/portfolio-manager")).json;
    expect(after.messages.find((m: any) => m.id === id).status).toBe("answered");
    expect(after.messages.filter((m: any) => m.text === "Orphaned question")).toHaveLength(1);
    // Only the last failed message can be retried.
    expect((await call("POST", "/portfolio-manager/messages", { retryMessageId: id })).status).toBe(409);
  });
});

describe("plans and protocol", () => {
  test("a plan becomes a read-only card; unknown harnesses are dropped", async () => {
    const a = newProject("ExampleApp");
    const b = newProject("ExampleService");
    addTask(a, "Blocking bug", "blocked");
    addTask(b, "Migration", "ready");
    await configurePortfolio();
    const tasksBefore = db.tasks.list().length;
    const { state } = await ask("Составь план работы на сегодня");
    const reply = lastManager(state);
    expect(reply.planId).not.toBeNull();
    const plan = state.plans.find((p: any) => p.id === reply.planId);
    expect(plan.status).toBe("proposed");
    expect(plan.projects.map((p: any) => p.projectPath)).toEqual([a, b]);
    expect(plan.projects[0].suggestedHarness).toBe("codex");
    expect(plan.projects[1].suggestedHarness).toBeNull();
    expect(plan.notes.join(" ")).toContain("ghost-harness");
    expect(plan.projects[1].dependsOn).toEqual([a]);
    expect(plan.projects[0].expectedEffect).toBeNull();
    expect(db.tasks.list().length).toBe(tasksBefore);

    const accepted = await call("POST", `/portfolio-manager/plans/${plan.id}/accept`);
    expect(accepted.status).toBe(200);
    expect(accepted.json.status).toBe("accepted");
    const after = (await call("GET", "/portfolio-manager")).json;
    expect(after.decisions.some((d: any) => d.source === "approval" && d.text.includes("Plan for today"))).toBe(true);
    expect((await call("POST", `/portfolio-manager/plans/${plan.id}/dismiss`)).status).toBe(409);
    expect(db.tasks.list().length).toBe(tasksBefore);
  });

  test("invalid structured output never becomes a card", async () => {
    newProject("Eta");
    await configurePortfolio();
    const garbage = await ask("plan __fake_portfolio_garbage__");
    expect(garbage.turn.status).toBe("failed");

    const badPlan = await ask("plan __fake_portfolio_badplan__");
    const planReply = lastManager(badPlan.state);
    expect(planReply.planId).toBeNull();
    expect(planReply.protocolErrors.join(" ")).toContain("not in the portfolio");

    const badDelegation = await ask("delegate __fake_portfolio_baddelegation__");
    const delegationReply = lastManager(badDelegation.state);
    expect(delegationReply.delegationIds).toEqual([]);
    expect(delegationReply.protocolErrors.join(" ")).toContain("not in the portfolio");
  });

  test("decisions can be confirmed and removed", async () => {
    newProject("Theta");
    await configurePortfolio();
    const added = await call("POST", "/portfolio-manager/decisions", { text: "ExampleApp comes first this week" });
    expect(added.status).toBe(200);
    const again = await call("POST", "/portfolio-manager/decisions", { text: "exampleapp comes first this week" });
    expect(again.json.id).toBe(added.json.id);
    await ask("Anything else?");
    expect(fake.fakeTurnLog.lastPortfolioPrompt).toContain("- ExampleApp comes first this week");
    expect((await call("DELETE", `/portfolio-manager/decisions/${added.json.id}`)).json.deleted).toBe(true);
  });
});

describe("delegation", () => {
  async function propose(text: string): Promise<any> {
    const { state } = await ask(text);
    const reply = lastManager(state);
    expect(reply.delegationIds.length).toBeGreaterThan(0);
    return state.delegations.filter((d: any) => reply.delegationIds.includes(d.id));
  }

  test("a proposal sends nothing; approval sends exactly one request to the right manager", async () => {
    const a = newProject("ExampleApp");
    const b = newProject("ExampleService");
    addTask(a, "Moderation", "backlog");
    await configurePortfolio();
    const [proposal] = await propose("Попроси менеджера ExampleService проверить блокировки");
    expect(proposal.projectPath).toBe(b);
    expect(proposal.status).toBe("proposed");
    expect(proposal.request).toContain("ExampleService");
    // The target has no agent yet: shown before approval, and approval refuses.
    expect(proposal.target.managerConfigured).toBe(false);
    expect(proposal.target.problem).toContain("no agent");
    const managerTurnsBefore = fake.fakeTurnLog.manager;
    expect(pmMessages(b)).toEqual([]);
    const refused = await call("POST", `/portfolio-manager/delegations/${proposal.id}/approve`, { revision: proposal.revision });
    expect(refused.status).toBe(409);
    expect(refused.json.error).toContain("Nothing was sent");
    expect(pmMessages(b)).toEqual([]);
    expect(fake.fakeTurnLog.manager).toBe(managerTurnsBefore);

    await configureProjectManager(b);
    const stale = await call("POST", `/portfolio-manager/delegations/${proposal.id}/approve`, { revision: proposal.revision + 5 });
    expect(stale.status).toBe(409);
    const portfolioTurnsBefore = fake.fakeTurnLog.portfolio;
    const approved = await call("POST", `/portfolio-manager/delegations/${proposal.id}/approve`, { revision: proposal.revision });
    expect(approved.status).toBe(200);
    expect(approved.json.alreadySent).toBe(false);
    expect(approved.json.delegation.status).toBe("sent");

    const messages = pmMessages(b);
    expect(messages).toHaveLength(1);
    expect(messages[0].role).toBe("owner");
    expect(messages[0].text).toBe(proposal.request);
    expect(messages[0].delegationId).toBe(proposal.id);
    // The other project's manager never heard of it.
    expect(pmMessages(a)).toEqual([]);

    await settle(`/project-manager/turns/${approved.json.delegation.pmTurnId}`);
    const state = (await call("GET", "/portfolio-manager")).json;
    const done = state.delegations.find((d: any) => d.id === proposal.id);
    expect(done.status).toBe("answered");
    expect(done.result.status).toBe("answered");
    expect(done.result.reply.length).toBeGreaterThan(0);
    expect(state.messages.some((m: any) => m.role === "system" && m.delegationId === proposal.id && m.text.includes("answered"))).toBe(true);
    // The answer is stored in the project manager's own history.
    expect(pmMessages(b).map((m) => m.role)).toEqual(["owner", "manager"]);
    // No hidden second global call, and no task was started or created.
    expect(fake.fakeTurnLog.portfolio).toBe(portfolioTurnsBefore);
    expect(db.tasks.list().filter((t) => t.workdir === b)).toEqual([]);

    // A second approve answers with the stored state and sends nothing.
    const again = await call("POST", `/portfolio-manager/delegations/${proposal.id}/approve`, { revision: done.revision });
    expect(again.status).toBe(200);
    expect(again.json.alreadySent).toBe(true);
    expect(pmMessages(b)).toHaveLength(2);

    // The next global question carries the answer as an observation.
    await ask("What did the managers say?");
    expect(fake.fakeTurnLog.lastPortfolioPrompt).toContain("asked: Check the remaining blockers in ExampleService — answered:");
    expect(fake.fakeTurnLog.lastPortfolioPrompt).toMatch(/P\d ExampleService/);
  });

  test("concurrent approvals send one request", async () => {
    const a = newProject("Concurrent");
    await configurePortfolio();
    await configureProjectManager(a);
    const [proposal] = await propose("delegate to the manager of Concurrent");
    const results = await Promise.all([
      call("POST", `/portfolio-manager/delegations/${proposal.id}/approve`, { revision: proposal.revision }),
      call("POST", `/portfolio-manager/delegations/${proposal.id}/approve`, { revision: proposal.revision }),
      call("POST", `/portfolio-manager/delegations/${proposal.id}/approve`, { revision: proposal.revision }),
    ]);
    const sent = results.filter((r) => r.status === 200 && r.json.alreadySent === false);
    expect(sent).toHaveLength(1);
    expect(results.every((r) => r.status === 200 || r.status === 409)).toBe(true);
    expect(pmMessages(a).filter((m) => m.role === "owner")).toHaveLength(1);
    await settle(`/project-manager/turns/${sent[0]!.json.delegation.pmTurnId}`);
  });

  test("a failure while sending is recorded and can be retried", async () => {
    const a = newProject("Flaky");
    await configurePortfolio();
    await configureProjectManager(a);
    const [proposal] = await propose("delegate to the manager of Flaky");
    const failed = await portfolio.approveDelegation(proposal.id, { revision: proposal.revision }, {}, async () => ({ ok: false, status: 500, error: "boom" }));
    expect(failed.ok).toBe(false);
    const stored = (await call("GET", "/portfolio-manager")).json.delegations.find((d: any) => d.id === proposal.id);
    expect(stored.status).toBe("failed");
    expect(stored.error).toContain("boom");
    expect(pmMessages(a)).toEqual([]);

    const thrown = await portfolio.approveDelegation(proposal.id, { revision: stored.revision }, {}, async () => { throw new Error("kaput"); });
    expect(thrown.ok).toBe(false);
    const afterThrow = (await call("GET", "/portfolio-manager")).json.delegations.find((d: any) => d.id === proposal.id);
    expect(afterThrow.status).toBe("failed");

    const retried = await call("POST", `/portfolio-manager/delegations/${proposal.id}/approve`, { revision: afterThrow.revision });
    expect(retried.status).toBe(200);
    expect(retried.json.delegation.status).toBe("sent");
    expect(pmMessages(a).filter((m) => m.role === "owner")).toHaveLength(1);
    await settle(`/project-manager/turns/${retried.json.delegation.pmTurnId}`);
  });

  test("a failed project manager answer is retried in place, not duplicated", async () => {
    const a = newProject("Retry PM");
    await configurePortfolio();
    await configureProjectManager(a);
    const [proposal] = await propose("delegate to the manager of Retry PM");
    // Make the project manager's answer fail once by rewriting the request.
    db.portfolioManagerStore.putDelegation(proposal.id, a, proposal.messageId, "proposed", JSON.stringify({ ...proposal, target: undefined, request: "please __fake_pm_fail__" }), proposal.createdAt);
    const sent = await call("POST", `/portfolio-manager/delegations/${proposal.id}/approve`, { revision: proposal.revision });
    expect(sent.status).toBe(200);
    await settle(`/project-manager/turns/${sent.json.delegation.pmTurnId}`);
    const failed = (await call("GET", "/portfolio-manager")).json.delegations.find((d: any) => d.id === proposal.id);
    expect(failed.status).toBe("failed");
    expect(failed.result.status).toBe("failed");
    const retried = await call("POST", `/portfolio-manager/delegations/${proposal.id}/approve`, { revision: failed.revision });
    expect(retried.status).toBe(200);
    await settle(`/project-manager/turns/${retried.json.delegation.pmTurnId}`);
    expect(pmMessages(a).filter((m) => m.role === "owner")).toHaveLength(1);
  });

  test("reject sends nothing and blocks a later approval", async () => {
    const a = newProject("Rejected");
    await configurePortfolio();
    await configureProjectManager(a);
    const [proposal] = await propose("delegate to the manager of Rejected");
    const rejected = await call("POST", `/portfolio-manager/delegations/${proposal.id}/reject`);
    expect(rejected.status).toBe(200);
    expect(rejected.json.status).toBe("rejected");
    expect((await call("POST", `/portfolio-manager/delegations/${proposal.id}/approve`, { revision: rejected.json.revision })).status).toBe(409);
    expect(pmMessages(a)).toEqual([]);
  });

  test("an unregistered target is refused and nothing is sent", async () => {
    const a = newProject("Gone");
    await configurePortfolio();
    await configureProjectManager(a);
    const [proposal] = await propose("delegate to the manager of Gone");
    db.projects.delete(a);
    const res = await call("POST", `/portfolio-manager/delegations/${proposal.id}/approve`, { revision: proposal.revision });
    expect(res.status).toBe(409);
    expect(pmMessages(a)).toEqual([]);
  });

  test("an approval interrupted by an app exit is reconciled safely", async () => {
    const a = newProject("Interrupted");
    await configurePortfolio();
    await configureProjectManager(a);
    const proposals = await propose("delegate __fake_portfolio_two__");
    expect(proposals.length).toBe(1); // one project in this portfolio
    const [proposal] = proposals;
    // Claimed, then the app stopped before sending anything.
    db.portfolioManagerStore.putDelegation(proposal.id, a, proposal.messageId, "sending", JSON.stringify({ ...proposal, target: undefined, status: "sending" }), proposal.createdAt);
    const state = (await call("GET", "/portfolio-manager")).json;
    const reconciled = state.delegations.find((d: any) => d.id === proposal.id);
    expect(reconciled.status).toBe("failed");
    expect(reconciled.error).toContain("Nothing was sent");
    expect(pmMessages(a)).toEqual([]);

    // Claimed and sent, then the app stopped before recording it: adopted.
    const pmId = randomUUID();
    db.projectManagers.appendMessage(a, pmId, JSON.stringify({ id: pmId, role: "owner", text: proposal.request, createdAt: Date.now(), status: "failed", error: "closed", delegationId: proposal.id }), 400);
    db.portfolioManagerStore.putDelegation(proposal.id, a, proposal.messageId, "sending", JSON.stringify({ ...reconciled, target: undefined, status: "sending" }), proposal.createdAt);
    const adopted = (await call("GET", "/portfolio-manager")).json.delegations.find((d: any) => d.id === proposal.id);
    expect(adopted.pmMessageId).toBe(pmId);
    expect(adopted.status).toBe("failed");
    expect(adopted.result.status).toBe("failed");
  });
});

describe("delegation events (FO-008D)", () => {
  async function collect(): Promise<{ events: any[]; stop: () => void }> {
    const { subscribeAppEvents } = await import("./quit-guard.ts");
    const events: any[] = [];
    const stop = subscribeAppEvents((event) => {
      if (event.type === "portfolio_delegation") events.push(event);
    });
    return { events, stop };
  }

  async function proposeFor(name: string): Promise<{ dir: string; proposal: any }> {
    const dir = newProject(name);
    await configurePortfolio();
    await configureProjectManager(dir);
    const { state } = await ask(`delegate to the manager of ${name}`);
    const reply = lastManager(state);
    return { dir, proposal: state.delegations.find((d: any) => reply.delegationIds.includes(d.id)) };
  }

  async function waitFor(check: () => boolean): Promise<void> {
    for (let i = 0; i < 300; i++) {
      if (check()) return;
      await Bun.sleep(20);
    }
    throw new Error("condition never met");
  }

  test("proposed, sent and answered are pushed without any read, with ids and status only", async () => {
    const { events, stop } = await collect();
    try {
      const { dir, proposal } = await proposeFor("Evented");
      expect(events.some((e) => e.delegationId === proposal.id && e.status === "proposed")).toBe(true);
      const portfolioTurns = fake.fakeTurnLog.portfolio;
      const approved = await call("POST", `/portfolio-manager/delegations/${proposal.id}/approve`, { revision: proposal.revision });
      expect(approved.status).toBe(200);
      expect(events.some((e) => e.delegationId === proposal.id && e.status === "sent")).toBe(true);
      // The answer is announced when the project manager settles — no GET of
      // the portfolio state happens in between.
      await waitFor(() => events.some((e) => e.delegationId === proposal.id && e.status === "answered"));
      const stored = JSON.parse(db.portfolioManagerStore.getDelegation(proposal.id)!);
      expect(stored.status).toBe("answered");
      for (const event of events) {
        expect(Object.keys(event).sort()).toEqual(["delegationId", "projectPath", "status", "ts", "type"]);
        expect(JSON.stringify(event)).not.toContain(proposal.request);
      }
      expect(events.filter((e) => e.delegationId === proposal.id).every((e) => e.projectPath === dir)).toBe(true);
      // Events never trigger another model call.
      expect(fake.fakeTurnLog.portfolio).toBe(portfolioTurns);
      // A later read is a no-op and announces nothing new.
      const count = events.length;
      await call("GET", "/portfolio-manager");
      await call("GET", "/portfolio-manager");
      expect(events.length).toBe(count);
    } finally {
      stop();
    }
  });

  test("a failed project manager answer is pushed as failed", async () => {
    const { events, stop } = await collect();
    try {
      const { dir, proposal } = await proposeFor("Evented Fail");
      db.portfolioManagerStore.putDelegation(proposal.id, dir, proposal.messageId, "proposed", JSON.stringify({ ...proposal, target: undefined, request: "please __fake_pm_fail__" }), proposal.createdAt);
      const approved = await call("POST", `/portfolio-manager/delegations/${proposal.id}/approve`, { revision: proposal.revision });
      expect(approved.status).toBe(200);
      await waitFor(() => events.some((e) => e.delegationId === proposal.id && e.status === "failed"));
    } finally {
      stop();
    }
  });

  test("a refused send and a reject are pushed", async () => {
    const { events, stop } = await collect();
    try {
      const { proposal } = await proposeFor("Evented Refused");
      const failed = await portfolio.approveDelegation(proposal.id, { revision: proposal.revision }, {}, async () => ({ ok: false, status: 500, error: "boom" }));
      expect(failed.ok).toBe(false);
      expect(events.some((e) => e.delegationId === proposal.id && e.status === "failed")).toBe(true);
      const second = await proposeFor("Evented Rejected");
      expect((await call("POST", `/portfolio-manager/delegations/${second.proposal.id}/reject`)).status).toBe(200);
      expect(events.some((e) => e.delegationId === second.proposal.id && e.status === "rejected")).toBe(true);
    } finally {
      stop();
    }
  });

  test("boot recovery settles in-flight delegations and announces them", async () => {
    const { events, stop } = await collect();
    try {
      const { dir, proposal } = await proposeFor("Recovered");
      // Sent before a crash; the project manager's turn died with the app.
      const pmId = randomUUID();
      db.projectManagers.appendMessage(dir, pmId, JSON.stringify({ id: pmId, role: "owner", text: proposal.request, createdAt: Date.now(), status: "pending", delegationId: proposal.id }), 400);
      db.portfolioManagerStore.putDelegation(proposal.id, dir, proposal.messageId, "sent", JSON.stringify({ ...proposal, target: undefined, status: "sent", pmMessageId: pmId }), proposal.createdAt);
      const turns = fake.fakeTurnLog.portfolio + fake.fakeTurnLog.manager;
      expect(portfolio.recoverPortfolioDelegations()).toBe(1);
      expect(events.some((e) => e.delegationId === proposal.id && e.status === "failed")).toBe(true);
      expect(JSON.parse(db.portfolioManagerStore.getDelegation(proposal.id)!).status).toBe("failed");
      // Nothing re-asked anyone.
      expect(fake.fakeTurnLog.portfolio + fake.fakeTurnLog.manager).toBe(turns);
      expect(portfolio.recoverPortfolioDelegations()).toBe(0);
    } finally {
      stop();
    }
  });
});
