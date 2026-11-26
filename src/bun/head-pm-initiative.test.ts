/**
 * FO-HEAD02 — cross-project initiatives (fake driver, isolated DB).
 */

import { afterAll, beforeAll, beforeEach, expect, test } from "bun:test";
import { mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const DATA_DIR = mkdtempSync(path.join(tmpdir(), "fo-head02-"));
process.env.AGETOR_DATA_DIR = DATA_DIR;
process.env.AGETOR_API_PORT = "4693";
process.env.AGETOR_CODEX_DRIVER = "fake";
process.env.AGETOR_CODEX_BIN = "/bin/echo";

let base = "";
let token = "";
let server: { stop: () => void };
let store: typeof import("./db.ts");
let initiative: typeof import("./head-pm-initiative.ts");
let ClusterCore: typeof import("./cluster-core.ts").ClusterCore;
let EmployeeCore: typeof import("./employee-core.ts").EmployeeCore;
let consent = "";

beforeAll(async () => {
  store = await import("./db.ts");
  initiative = await import("./head-pm-initiative.ts");
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
  const dir = realpathSync(mkdtempSync(path.join(tmpdir(), "fo-head02-proj-")));
  writeFileSync(path.join(dir, "README.md"), name);
  store.projects.upsert(dir, name);
  return dir;
}

async function configureManagers(dirs: string[]): Promise<void> {
  expect((await call("PUT", "/portfolio-manager/config", {
    config: { harness: "codex", model: "gpt-6.1-sol", effort: "low", consentKey: consent },
  })).status).toBe(200);
  for (const dir of dirs) {
    expect((await call("PUT", "/project-manager/config", {
      path: dir,
      config: { harness: "codex", model: "gpt-6.1-sol", effort: "low", consentKey: consent },
    })).status).toBe(200);
    new EmployeeCore(store.db).ensureProjectManager(dir);
  }
}

test("initiative persists, routes delegations per project, idempotent approve", async () => {
  const clusters = new ClusterCore(store.db, { now: () => Date.now(), pathExists: () => true, realpath: (p) => p });
  const cA = clusters.create({ name: "Cluster A" });
  const cB = clusters.create({ name: "Cluster B" });
  const alpha = newProject("Project Alpha");
  const beta = newProject("Project Beta");
  clusters.assign(cA.id, alpha);
  clusters.assign(cB.id, beta);
  await configureManagers([alpha, beta]);

  const created = initiative.createHeadPmInitiative({
    title: "Auth across Alpha and Beta",
    goal: "Coordinate authentication improvements",
    projectPaths: [alpha, beta],
  });
  expect(created.ok).toBe(true);
  if (!created.ok) return;
  const id = created.value.id;
  expect(created.value.contributions).toHaveLength(2);
  expect(created.value.contributions.every((c) => c.clusterName)).toBe(true);

  const prepA = initiative.prepareHeadPmDelegation(id, alpha, {
    objective: "Alpha auth",
    request: "Prepare Alpha authentication tasks",
  });
  const prepB = initiative.prepareHeadPmDelegation(id, beta, {
    objective: "Beta auth",
    request: "Prepare Beta authentication tasks",
  });
  expect(prepA.ok && prepB.ok).toBe(true);
  if (!prepA.ok || !prepB.ok) return;
  expect(prepA.value.delegation.status).toBe("proposed");
  expect(prepB.value.delegation.projectPath).toBe(beta);

  const portfolioBefore = (await call("GET", "/portfolio-manager")).json;
  expect(portfolioBefore.delegations.filter((d: any) => d.status === "proposed")).toHaveLength(2);
  expect((await call("GET", `/project-manager?path=${encodeURIComponent(alpha)}`)).json.messages).toEqual([]);

  const dA = prepA.value.delegation;
  const approved = await call("POST", `/portfolio-manager/delegations/${dA.id}/approve`, { revision: dA.revision });
  expect(approved.status).toBe(200);
  for (let i = 0; i < 400; i++) {
    const pm = (await call("GET", `/project-manager?path=${encodeURIComponent(alpha)}`)).json;
    if (pm.messages.some((m: any) => m.delegationId === dA.id)) break;
    await Bun.sleep(30);
  }

  const pmAlpha = (await call("GET", `/project-manager?path=${encodeURIComponent(alpha)}`)).json.messages;
  expect(pmAlpha.filter((m: any) => m.delegationId === dA.id)).toHaveLength(1);
  const pmBeta = (await call("GET", `/project-manager?path=${encodeURIComponent(beta)}`)).json.messages;
  expect(pmBeta.filter((m: any) => m.delegationId)).toHaveLength(0);

  const again = await call("POST", `/portfolio-manager/delegations/${dA.id}/approve`, { revision: approved.json.delegation.revision });
  expect(again.json.alreadySent).toBe(true);
  expect((await call("GET", `/project-manager?path=${encodeURIComponent(alpha)}`)).json.messages.filter((m: any) => m.delegationId === dA.id)).toHaveLength(1);

  const view = initiative.getHeadPmInitiative(id)!;
  expect(view.delegations.some((d) => d.id === dA.id)).toBe(true);
  expect(view.status).not.toBe("completed");

  server.stop();
  const restarted = await import("./server.ts");
  server = restarted.startApiServer() as unknown as { stop: () => void };
  const afterRestart = initiative.getHeadPmInitiative(id)!;
  expect(afterRestart.title).toBe("Auth across Alpha and Beta");
  expect(afterRestart.contributions.find((c) => c.projectPath === alpha)?.delegationId).toBe(dA.id);
});

test("cancelled initiative rejects new delegations", () => {
  const alpha = newProject("Only");
  const created = initiative.createHeadPmInitiative({ title: "X", projectPaths: [alpha] });
  expect(created.ok).toBe(true);
  if (!created.ok) return;
  initiative.cancelHeadPmInitiative(created.value.id);
  const prep = initiative.prepareHeadPmDelegation(created.value.id, alpha, { objective: "o", request: "r" });
  expect(prep.ok).toBe(false);
  if (!prep.ok) expect(prep.status).toBe(409);
});
