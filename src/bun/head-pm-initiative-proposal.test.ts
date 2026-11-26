/**
 * FO-HEAD03 — chat-driven initiative proposals and factual status answers.
 */

import { afterAll, beforeAll, beforeEach, expect, test } from "bun:test";
import { mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { parseInitiativeProposal } from "../shared/head-pm-initiative-proposal.ts";
import { tryAnswerInitiativeStatusQuestion } from "./head-pm-initiative-status.ts";

const DATA_DIR = mkdtempSync(path.join(tmpdir(), "fo-head03-"));
process.env.AGETOR_DATA_DIR = DATA_DIR;
process.env.AGETOR_API_PORT = "4694";
process.env.AGETOR_CODEX_DRIVER = "fake";
process.env.AGETOR_CODEX_BIN = "/bin/echo";
process.env.AGETOR_FAKE_PORTFOLIO_DELAY_MS = "20";

let base = "";
let token = "";
let server: { stop: () => void };
let store: typeof import("./db.ts");
let proposalMod: typeof import("./head-pm-initiative-proposal.ts");
let initiativeMod: typeof import("./head-pm-initiative.ts");
let ClusterCore: typeof import("./cluster-core.ts").ClusterCore;
let EmployeeCore: typeof import("./employee-core.ts").EmployeeCore;
let consent = "";

beforeAll(async () => {
  store = await import("./db.ts");
  proposalMod = await import("./head-pm-initiative-proposal.ts");
  initiativeMod = await import("./head-pm-initiative.ts");
  ({ ClusterCore } = await import("./cluster-core.ts"));
  ({ EmployeeCore } = await import("./employee-core.ts"));
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
    try { store.db.run("DELETE FROM clusters WHERE id = ?", [row.id]); } catch { /* */ }
  }
  store.db.run("DELETE FROM portfolio_manager_delegations");
  store.db.run("DELETE FROM portfolio_manager_messages");
  store.db.run("DELETE FROM head_pm_initiative_proposals");
  store.db.run("DELETE FROM head_pm_initiatives");
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
  const dir = realpathSync(mkdtempSync(path.join(tmpdir(), "fo-head03-proj-")));
  writeFileSync(path.join(dir, "README.md"), name);
  store.projects.upsert(dir, name);
  return dir;
}

async function configureManagers(dirs: string[]): Promise<void> {
  await call("PUT", "/portfolio-manager/config", {
    config: { harness: "codex", model: "gpt-6.1-sol", effort: "low", consentKey: consent },
  });
  for (const dir of dirs) {
    await call("PUT", "/project-manager/config", {
      path: dir,
      config: { harness: "codex", model: "gpt-6.1-sol", effort: "low", consentKey: consent },
    });
    new EmployeeCore(store.db).ensureProjectManager(dir);
  }
}

test("parseInitiativeProposal rejects unknown project refs", () => {
  const refs = new Map([["P1", { path: "/a", name: "Alpha" }]]);
  const bad = parseInitiativeProposal({
    title: "T",
    projects: [{ project: "P99", objective: "o", request: "r" }],
  }, refs);
  expect(bad.ok).toBe(false);
});

test("chat message creates proposal, approval creates one initiative with drafts", async () => {
  const clusters = new ClusterCore(store.db, { now: () => Date.now(), pathExists: () => true, realpath: (p) => p });
  const cA = clusters.create({ name: "Cluster A" });
  const cB = clusters.create({ name: "Cluster B" });
  const alpha = newProject("Project Alpha");
  const beta = newProject("Project Beta");
  clusters.assign(cA.id, alpha);
  clusters.assign(cB.id, beta);
  await configureManagers([alpha, beta]);

  const send = await call("POST", "/portfolio-manager/messages", {
    text: "Coordinate authentication improvements across Project Alpha and Project Beta. Assign preparation to their project managers.",
  });
  expect(send.status).toBe(202);
  const turnId = send.json.turn.id as string;
  for (let i = 0; i < 200; i++) {
    const turn = await call("GET", `/portfolio-manager/turns/${turnId}`);
    if (turn.json.status !== "running") break;
    await Bun.sleep(25);
  }
  const portfolio = (await call("GET", "/portfolio-manager")).json;
  const managerMsg = portfolio.messages.find((m: any) => m.role === "manager" && m.initiativeProposalId);
  expect(managerMsg).toBeTruthy();
  expect(portfolio.delegations.filter((d: any) => d.status === "proposed")).toHaveLength(0);

  const proposalId = managerMsg.initiativeProposalId as string;
  const approved = await call("POST", `/head-pm/initiative-proposals/${proposalId}/approve`);
  expect(approved.status).toBe(200);
  expect(approved.json.alreadyCreated).toBe(false);
  const again = await call("POST", `/head-pm/initiative-proposals/${proposalId}/approve`);
  expect(again.json.alreadyCreated).toBe(true);

  const initiatives = await call("GET", "/head-pm/initiatives");
  expect(initiatives.json.filter((i: any) => i.title.includes("authentication"))).toHaveLength(1);
  const initiative = initiatives.json[0];
  expect(initiative.contributions).toHaveLength(2);
  expect(initiative.contributions[0].delegationDraft?.request).toContain("authentication");

  const prep = await call("POST", `/head-pm/initiatives/${initiative.id}/contributions/${encodeURIComponent(alpha)}/prepare-delegation`, {});
  expect(prep.status).toBe(201);
  const dA = prep.json.delegation;
  const approveD = await call("POST", `/portfolio-manager/delegations/${dA.id}/approve`, { revision: dA.revision });
  expect(approveD.status).toBe(200);
  for (let i = 0; i < 200; i++) {
    const pm = (await call("GET", `/project-manager?path=${encodeURIComponent(alpha)}`)).json;
    if (pm.messages.some((m: any) => m.delegationId === dA.id)) break;
    await Bun.sleep(25);
  }
  expect((await call("GET", `/project-manager?path=${encodeURIComponent(alpha)}`)).json.messages.filter((m: any) => m.delegationId === dA.id)).toHaveLength(1);
});

test("factual status answer does not start a portfolio turn", async () => {
  const alpha = newProject("Auth Only");
  initiativeMod.createHeadPmInitiative({ title: "Authentication initiative", projectPaths: [alpha] });
  const send = await call("POST", "/portfolio-manager/messages", { text: "What is the status of the authentication initiative?" });
  expect(send.status).toBe(202);
  expect(send.json.turn.status).toBe("succeeded");
  expect(send.json.message.status).toBe("answered");
  const portfolio = (await call("GET", "/portfolio-manager")).json;
  const reply = portfolio.messages.find((m: any) => m.role === "manager" && m.text.includes("Authentication initiative"));
  expect(reply?.text).toContain("draft");
});

test("link-batch rejects unrelated project batch", async () => {
  const alpha = newProject("Alpha");
  const beta = newProject("Beta");
  const created = initiativeMod.createHeadPmInitiative({ title: "Link test", projectPaths: [alpha, beta] });
  expect(created.ok).toBe(true);
  if (!created.ok) return;
  const batchId = "batch-other";
  store.db.run(
    `INSERT INTO pm_orchestrated_batches (id, project_path, status, data_json, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)`,
    [batchId, beta, "paused", JSON.stringify({ id: batchId, projectPath: beta, title: "B", status: "paused", tasks: [] }), Date.now(), Date.now()],
  );
  const bad = await call("POST", `/head-pm/initiatives/${created.value.id}/contributions/${encodeURIComponent(alpha)}/link-batch`, { batchId });
  expect(bad.status).toBe(404);
});

test("tryAnswerInitiativeStatusQuestion uses persisted initiatives only", () => {
  const alpha = newProject("Status");
  initiativeMod.createHeadPmInitiative({ title: "Authentication initiative", goal: "auth", projectPaths: [alpha] });
  const answer = tryAnswerInitiativeStatusQuestion("What is the status of the authentication initiative?");
  expect(answer).toContain("Authentication initiative");
  expect(answer).not.toContain("running agent");
});
