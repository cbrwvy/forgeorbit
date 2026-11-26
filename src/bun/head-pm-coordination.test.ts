/**
 * FO-HEAD01 — Head of PM cross-project coordination (fake-driver / isolated DB).
 * No live model calls.
 */

import { afterAll, beforeAll, beforeEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";

const DATA_DIR = mkdtempSync(path.join(tmpdir(), "fo-head01-"));
process.env.AGETOR_DATA_DIR = DATA_DIR;
process.env.AGETOR_API_PORT = "4692";
process.env.AGETOR_CODEX_DRIVER = "fake";
process.env.AGETOR_CODEX_BIN = "/bin/echo";

let base = "";
let token = "";
let server: { stop: () => void };
let store: typeof import("./db.ts");
let portfolio: typeof import("./portfolio-manager.ts");
let coordination: typeof import("./head-pm-coordination.ts");
let EmployeeCore: typeof import("./employee-core.ts").EmployeeCore;
let ClusterCore: typeof import("./cluster-core.ts").ClusterCore;
let consent = "";

beforeAll(async () => {
  store = await import("./db.ts");
  portfolio = await import("./portfolio-manager.ts");
  coordination = await import("./head-pm-coordination.ts");
  ({ EmployeeCore } = await import("./employee-core.ts"));
  ({ ClusterCore } = await import("./cluster-core.ts"));
  const started = await import("./server.ts");
  token = started.API_TOKEN;
  server = started.startApiServer() as unknown as { stop: () => void };
  base = `http://127.0.0.1:${process.env.AGETOR_API_PORT}`;
  store.harnesses.setEnabled("codex", true);
  const preflight = await fetch(`${base}/project-interviews/preflight`, {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify({ harness: "codex", model: "gpt-6.1-sol" }),
  }).then((r) => r.json());
  consent = preflight.isolation.consentKey;
});

afterAll(() => {
  server?.stop?.();
});

beforeEach(() => {
  for (const project of store.projects.list()) store.projects.delete(project.path);
  for (const row of store.db.query<{ id: string }, []>("SELECT id FROM clusters").all()) {
    try { store.db.run("DELETE FROM clusters WHERE id = ?", [row.id]); } catch { /* membership cleared with projects */ }
  }
  store.db.run("DELETE FROM portfolio_manager_delegations");
  store.db.run("DELETE FROM portfolio_manager_messages");
  store.db.run("DELETE FROM portfolio_manager_plans");
});

async function call(method: string, route: string, body?: unknown): Promise<{ status: number; json: any }> {
  const res = await fetch(`${base}${route}`, {
    method,
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: res.status, json: await res.json().catch(() => null) };
}

function newProject(name: string): string {
  const dir = realpathSync(mkdtempSync(path.join(tmpdir(), "fo-head01-proj-")));
  writeFileSync(path.join(dir, "README.md"), name);
  store.projects.upsert(dir, name);
  return dir;
}

async function configurePortfolio(): Promise<void> {
  expect((await call("PUT", "/portfolio-manager/config", {
    config: { harness: "codex", model: "gpt-6.1-sol", effort: "low", consentKey: consent },
  })).status).toBe(200);
}

async function configureProjectManager(dir: string): Promise<void> {
  expect((await call("PUT", "/project-manager/config", {
    path: dir,
    config: { harness: "codex", model: "gpt-6.1-sol", effort: "low", consentKey: consent },
  })).status).toBe(200);
}

async function settle(route: string): Promise<any> {
  for (let i = 0; i < 400; i++) {
    const { json } = await call("GET", route);
    if (json?.status && json.status !== "running") return json;
    await Bun.sleep(20);
  }
  throw new Error(`turn never settled: ${route}`);
}

async function askPortfolio(text: string): Promise<any> {
  const sent = await call("POST", "/portfolio-manager/messages", { text });
  expect(sent.status).toBe(202);
  await settle(`/portfolio-manager/turns/${sent.json.turn.id}`);
  return (await call("GET", "/portfolio-manager")).json;
}

function clusters(): InstanceType<typeof ClusterCore> {
  return new ClusterCore(store.db, { now: () => Date.now(), pathExists: () => true, realpath: (p) => p });
}

test("coordination lists two clusters, PM identities, and task columns", () => {
  const c1 = clusters().create({ name: "Cluster Alpha" });
  const c2 = clusters().create({ name: "Cluster Beta" });
  const a = newProject("Project A");
  const b = newProject("Project B");
  clusters().assign(c1.id, a);
  clusters().assign(c2.id, b);
  new EmployeeCore(store.db).ensureProjectManager(a);
  new EmployeeCore(store.db).ensureProjectManager(b);
  const now = Date.now();
  store.tasks.insert({
    id: randomUUID(),
    title: "Blocked in A",
    prompt: "x",
    column: "blocked",
    agent: "codex",
    workdir: a,
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

  const snap = coordination.buildHeadPmCoordination();
  expect(snap.clusters.map((c) => c.name).sort()).toEqual(["Cluster Alpha", "Cluster Beta"]);
  const rowA = snap.projects.find((p) => p.projectPath === a)!;
  const rowB = snap.projects.find((p) => p.projectPath === b)!;
  expect(rowA.clusterName).toBe("Cluster Alpha");
  expect(rowB.clusterName).toBe("Cluster Beta");
  expect(rowA.projectManager?.name).toBeTruthy();
  expect(rowB.projectManager?.name).toBeTruthy();
  expect(rowA.columns.blocked).toBe(1);
  expect(rowB.columns.blocked ?? 0).toBe(0);
});

test("delegation approve is idempotent and routes to the correct project only", async () => {
  const c1 = clusters().create({ name: "Studio A" });
  const c2 = clusters().create({ name: "Studio B" });
  const a = newProject("Alpha App");
  const b = newProject("Beta App");
  clusters().assign(c1.id, a);
  clusters().assign(c2.id, b);
  await configurePortfolio();
  await configureProjectManager(a);
  await configureProjectManager(b);
  new EmployeeCore(store.db).ensureProjectManager(a);
  new EmployeeCore(store.db).ensureProjectManager(b);

  const send = await call("POST", "/portfolio-manager/messages", {
    text: "Delegate to the manager of Alpha App — prepare auth refactor",
  });
  expect(send.status).toBe(202);
  await settle(`/portfolio-manager/turns/${send.json.turn.id}`);

  const state = (await call("GET", "/portfolio-manager")).json;
  const proposal = state.delegations.find((d: any) => d.projectPath === a);
  expect(proposal).toBeTruthy();
  expect(proposal.projectName).toContain("Alpha");
  expect(state.delegations.every((d: any) => d.projectPath !== b || d.status === "rejected")).toBe(true);

  const approved = await call("POST", `/portfolio-manager/delegations/${proposal.id}/approve`, { revision: proposal.revision });
  expect(approved.status).toBe(200);
  expect(approved.json.alreadySent).toBe(false);

  const pmMessages = (await call("GET", `/project-manager?path=${encodeURIComponent(a)}`)).json.messages;
  expect(pmMessages.some((m: any) => m.delegationId === proposal.id)).toBe(true);
  const pmB = (await call("GET", `/project-manager?path=${encodeURIComponent(b)}`)).json.messages;
  expect(pmB.filter((m: any) => m.delegationId).length).toBe(0);

  const again = await call("POST", `/portfolio-manager/delegations/${proposal.id}/approve`, { revision: approved.json.delegation.revision });
  expect(again.status).toBe(200);
  expect(again.json.alreadySent).toBe(true);
});

test("rejecting delegation creates no project manager message", async () => {
  const dir = newProject("Reject Me");
  await configurePortfolio();
  await configureProjectManager(dir);
  const state = await askPortfolio("Delegate to the manager of Reject Me");
  const proposal = state.delegations[0];
  expect((await call("POST", `/portfolio-manager/delegations/${proposal.id}/reject`)).status).toBe(200);
  const pm = (await call("GET", `/project-manager?path=${encodeURIComponent(dir)}`)).json.messages;
  expect(pm.filter((m: any) => m.role === "owner").length).toBe(0);
});

test("missing project on approve returns a clear error", async () => {
  const dir = newProject("Ghost");
  await configurePortfolio();
  await configureProjectManager(dir);
  const state0 = await askPortfolio("Delegate to the manager of Ghost");
  const proposal = state0.delegations.find((d: any) => d.projectPath === dir)!;
  store.projects.delete(dir);
  const res = await call("POST", `/portfolio-manager/delegations/${proposal.id}/approve`, { revision: proposal.revision });
  expect(res.status).toBe(409);
  expect(res.json.error).toContain("no longer a registered project");
});

test("GET /portfolio-manager/coordination matches buildHeadPmCoordination", async () => {
  const dir = newProject("API Mirror");
  const http = await call("GET", "/portfolio-manager/coordination");
  expect(http.status).toBe(200);
  const direct = coordination.buildHeadPmCoordination();
  expect(http.json.projects.some((p: any) => p.projectPath === dir)).toBe(true);
  expect(http.json.capturedAt).toBeGreaterThan(0);
  expect(direct.projects.length).toBe(http.json.projects.length);
});

test("gatherPortfolioContext includes company structure lines (FO-HEAD01)", () => {
  const c = clusters().create({ name: "Orbit" });
  const dir = newProject("Orbit App");
  clusters().assign(c.id, dir);
  const gathered = portfolio.gatherPortfolioContext();
  expect(gathered.context.overview.some((line) => line.includes("Cluster"))).toBe(true);
  expect(gathered.sources.some((s) => s.id === "company")).toBe(true);
  const project = gathered.context.projects.find((p) => p.path === dir);
  expect(project?.lines.some((line) => line.includes("Cluster: Orbit"))).toBe(true);
});

test("FO-AUTO01 regression: coordination reports orchestrated holds without changing task column", () => {
  const dir = newProject("Auto Hold");
  const now = Date.now();
  const taskId = randomUUID();
  store.tasks.insert({
    id: taskId,
    title: "Ready task",
    prompt: "do",
    column: "ready",
    agent: "codex",
    workdir: dir,
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
  const wfId = randomUUID();
  const grant = JSON.stringify({
    taskId,
    projectPath: dir,
    implementerEmployeeId: randomUUID(),
    implementerHarnessId: "codex",
    implementerModel: "gpt-6.1-sol",
    reviewerHarness: "codex",
    reviewerModel: "gpt-6.1-sol",
    autoReviewAfterImplementation: false,
    autoReworkOnChanges: false,
    maxLaunches: 1,
    maxReworkCycles: 0,
    approvedAt: now,
  });
  const data = JSON.stringify({
    progress: { phase: "implement", pauseReason: "owner pause", awaitingOwnerAt: null },
    counters: { launches: 0, reworkCycles: 0 },
  });
  store.db.run(
    `INSERT INTO pm_orchestrated_workflows (id, task_id, project_path, status, phase, grant_json, data_json, created_at, updated_at)
     VALUES (?, ?, ?, 'paused', 'implement', ?, ?, ?, ?)`,
    [wfId, taskId, dir, grant, data, now, now],
  );
  const snap = coordination.buildHeadPmCoordination();
  const row = snap.projects.find((p) => p.projectPath === dir)!;
  expect(row.activeWorkflows.some((w) => w.status === "paused")).toBe(true);
  expect(snap.ownerQueue.orchestratedHolds).toBeGreaterThan(0);
  expect(store.tasks.get(taskId)?.column).toBe("ready");
});

test("delegation survives coordination re-read after simulated restart", async () => {
  const dir = newProject("Persist");
  await configurePortfolio();
  await configureProjectManager(dir);
  await askPortfolio("Delegate Persist");
  const before = coordination.buildHeadPmCoordination();
  expect(before.delegations.length).toBe(1);
  const { recoverPortfolioDelegations } = await import("./portfolio-manager.ts");
  recoverPortfolioDelegations();
  const after = coordination.buildHeadPmCoordination();
  expect(after.delegations[0]?.id).toBe(before.delegations[0]?.id);
});
