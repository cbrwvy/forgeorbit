import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

/**
 * FO-010D: assignment proposals through the real server, the real project
 * manager runner (fake codex driver, no CLI), and the FO-010C assignment API.
 * Nothing here starts a run or calls a model router.
 */

const DATA_DIR = mkdtempSync(path.join(tmpdir(), "fo010d-manager-"));
process.env.AGETOR_DATA_DIR = DATA_DIR;
process.env.AGETOR_API_PORT = "4712";
process.env.AGETOR_CODEX_DRIVER = "fake";
process.env.AGETOR_CODEX_BIN = "/bin/echo";
process.env.AGETOR_TMUX_BIN = "/bin/echo";
process.env.AGETOR_USAGE_OFFLINE = "1";
for (const kind of ["CLAUDE", "CURSOR", "GEMINI", "FX", "ANTIGRAVITY"]) {
  process.env[`AGETOR_${kind}_BIN`] = "/nonexistent/fo010d-cli";
}

let base = "";
let token = "";
let server: { stop: () => void };
let db: typeof import("./db.ts");
let manager: typeof import("./project-manager.ts");
let fake: typeof import("./project-manager-fake.ts");
let fakeLog: typeof import("./portfolio-manager-fake.ts");
let orchestrator: typeof import("./orchestrator.ts");
let consent = "";

beforeAll(async () => {
  db = await import("./db.ts");
  manager = await import("./project-manager.ts");
  fake = await import("./project-manager-fake.ts");
  fakeLog = await import("./portfolio-manager-fake.ts");
  orchestrator = await import("./orchestrator.ts");
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

async function call(method: string, route: string, body?: unknown, auth = true): Promise<{ status: number; json: any }> {
  const res = await fetch(`${base}${route}`, {
    method,
    headers: { ...(auth ? { authorization: `Bearer ${token}` } : {}), "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: res.status, json: await res.json().catch(() => null) };
}

function newProject(name: string): string {
  const dir = realpathSync(mkdtempSync(path.join(tmpdir(), "fo010d-proj-")));
  mkdirSync(path.join(dir, "src"));
  db.projects.upsert(dir, name);
  return dir;
}

async function configure(dir: string): Promise<void> {
  const res = await call("PUT", "/project-manager/config", {
    path: dir,
    config: { harness: "codex", model: "gpt-6.1-sol", effort: "low", consentKey: consent },
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

async function ask(dir: string, text: string, origin?: { delegationId: string }): Promise<any> {
  if (origin) {
    const sent = await manager.sendManagerMessage(dir, { text }, {}, origin);
    expect(sent.ok).toBe(true);
    if (!sent.ok) throw new Error("not sent");
    await settle(sent.value.turn.id);
  } else {
    const sent = await call("POST", "/project-manager/messages", { path: dir, text });
    expect(sent.status).toBe(202);
    await settle(sent.json.turn.id);
  }
  return (await call("GET", `/project-manager?path=${encodeURIComponent(dir)}`)).json;
}

async function worker(dir: string, name: string, jobTitle = "QA Engineer") {
  const res = await call("POST", "/employees", { name, jobTitle, projectPath: dir });
  expect(res.status).toBe(201);
  return res.json as { id: string; name: string };
}

async function task(dir: string, title: string) {
  const created = await orchestrator.createTask({ title, prompt: title, workdir: dir, isolation: "none" });
  if ("error" in created) throw new Error(created.error);
  return created.task;
}

const proposalsFor = async (dir: string, status = "pending") =>
  (await call("GET", `/assignment-proposals?projectPath=${encodeURIComponent(dir)}&status=${status}`)).json.proposals as any[];

/** The token a fresh routing review hands back (FO-ORCH02). */
const reviewToken = async (proposalId: string): Promise<string> =>
  (await call("GET", `/assignment-proposals/${proposalId}/recommendations`)).json.review.reviewToken as string;

const snapshot = () => ({
  runs: db.db.query(`SELECT COUNT(*) AS n FROM runs`).get(),
  accounts: db.db.query(`SELECT COUNT(*) AS n FROM resource_accounts`).get(),
});

describe("routes", () => {
  test("every proposal route requires the API token", async () => {
    const routes: [string, string][] = [
      ["GET", "/assignment-proposals"],
      ["POST", "/assignment-proposals"],
      ["GET", "/assignment-proposals/summary"],
      ["GET", "/assignment-proposals/x"],
      ["GET", "/assignment-proposals/x/history"],
      ["POST", "/assignment-proposals/x/approve"],
      ["POST", "/assignment-proposals/x/reject"],
      ["POST", "/assignment-proposals/x/cancel"],
    ];
    for (const [method, route] of routes) {
      const res = await fetch(`${base}${route}`, { method, body: method === "GET" ? undefined : "{}" });
      expect(res.status).toBe(401);
    }
    const query = await fetch(`${base}/assignment-proposals/summary?token=${token}`);
    expect(query.status).toBe(401);
  });

  test("request bodies are strict", async () => {
    const dir = newProject("Strict");
    const ada = await worker(dir, "Ada");
    const t = await task(dir, "Strict task");
    const good = { taskId: t.id, employeeId: ada.id, rationale: "Fits" };
    expect((await call("POST", "/assignment-proposals", { ...good, projectPath: dir })).status).toBe(400);
    expect((await call("POST", "/assignment-proposals", { ...good, model: "gpt-6" })).status).toBe(400);
    expect((await call("POST", "/assignment-proposals", { taskId: t.id, employeeId: ada.id })).status).toBe(400);
    expect((await call("POST", "/assignment-proposals", [good])).status).toBe(400);
    expect((await call("POST", "/assignment-proposals/not-a-uuid/approve", { expectedRevision: 1, expectedAssignmentRevision: null, allowReassign: false })).status).toBe(400);
    expect((await call("GET", `/assignment-proposals?projectPath=${encodeURIComponent(dir)}&extra=1`)).status).toBe(400);
    expect((await call("GET", "/assignment-proposals?status=banana")).status).toBe(400);
    expect((await call("DELETE", "/assignment-proposals")).status).toBe(405);
    const created = await call("POST", "/assignment-proposals", good);
    expect(created.status).toBe(201);
    const id = created.json.proposal.id;
    for (const bad of [
      {},
      { expectedRevision: 1 },
      { expectedRevision: 1, expectedAssignmentRevision: null, allowReassign: "true" },
      { expectedRevision: 1, expectedAssignmentRevision: null, allowReassign: false, extra: true },
      { expectedRevision: "1", expectedAssignmentRevision: null, allowReassign: false },
    ]) {
      expect((await call("POST", `/assignment-proposals/${id}/approve`, bad)).status).toBe(400);
    }
    expect((await call("POST", `/assignment-proposals/${id}/reject`, { expectedRevision: 1, extra: 1 })).status).toBe(400);
    expect((await call("GET", `/assignment-proposals/${crypto.randomUUID()}`)).status).toBe(404);
    expect((await call("GET", `/assignment-proposals/${id}`)).json.proposal.status).toBe("pending");
  });

  test("owner create → review → approve assigns through the FO-010C API and starts nothing", async () => {
    const dir = newProject("Owner flow");
    const ada = await worker(dir, "Ada");
    const t = await task(dir, "Owner flow task");
    const before = snapshot();
    const created = await call("POST", "/assignment-proposals", { taskId: t.id, employeeId: ada.id, rationale: "Ada owns QA" });
    expect(created.status).toBe(201);
    expect(created.json.execution.status).toBe("not-authorized");
    const proposal = created.json.proposal;
    expect((await call("GET", `/task-assignments/task?taskId=${t.id}`)).json.assignment).toBeNull();

    const approve = { expectedRevision: proposal.revision, expectedAssignmentRevision: null, allowReassign: false };
    const approved = await call("POST", `/assignment-proposals/${proposal.id}/approve`, approve);
    expect(approved.status).toBe(200);
    expect(approved.json).toMatchObject({ alreadyApplied: false, proposal: { status: "approved", result: { reassigned: false } } });
    const assignment = (await call("GET", `/task-assignments/task?taskId=${t.id}`)).json.assignment;
    expect(assignment).toMatchObject({ employeeId: ada.id, id: approved.json.proposal.result.assignmentId });

    const replay = await call("POST", `/assignment-proposals/${proposal.id}/approve`, approve);
    expect(replay.status).toBe(200);
    expect(replay.json.alreadyApplied).toBe(true);
    expect((await call("GET", `/task-assignments/history?taskId=${t.id}`)).json.events).toHaveLength(1);

    const history = await call("GET", `/assignment-proposals/${proposal.id}/history`);
    expect(history.json.events.map((e: any) => e.action)).toEqual(["created", "approved"]);
    expect(snapshot()).toEqual(before);
    expect((await call("GET", `/tasks/${t.id}`)).json.column).not.toBe("running");
  });

  test("a stale conflict answers 409 with the proposal and marks it out of date", async () => {
    const dir = newProject("Stale flow");
    const ada = await worker(dir, "Ada");
    const bea = await worker(dir, "Bea");
    const t = await task(dir, "Stale task");
    const created = (await call("POST", "/assignment-proposals", { taskId: t.id, employeeId: ada.id, rationale: "Ada" })).json.proposal;
    // The owner assigns someone else directly before reviewing.
    expect((await call("POST", "/task-assignments", { taskId: t.id, employeeId: bea.id })).status).toBe(201);
    const res = await call("POST", `/assignment-proposals/${created.id}/approve`, { expectedRevision: 1, expectedAssignmentRevision: null, allowReassign: true });
    expect(res.status).toBe(409);
    expect(res.json.proposal).toMatchObject({ status: "stale", staleReason: "The task's assignment changed after this was proposed." });
    expect((await call("GET", `/task-assignments/task?taskId=${t.id}`)).json.assignment.employeeId).toBe(bea.id);
    const summary = (await call("GET", "/assignment-proposals/summary")).json;
    expect(summary.projects.find((p: any) => p.projectPath === dir)).toBeUndefined();
  });
});

describe("project manager", () => {
  test("the prompt lists the team only when the project has workers, and a suggestion becomes a pending proposal", async () => {
    const dir = newProject("Manager flow");
    await configure(dir);
    await task(dir, "Write the release notes");

    await ask(dir, "What should we do next?");
    expect(fakeLog.fakeTurnLog.lastManagerPrompt).not.toContain("### Team");
    expect(fakeLog.fakeTurnLog.lastManagerPrompt).not.toContain("<assignment_proposals>");

    const ada = await worker(dir, "Ada", "Technical Writer");
    const before = snapshot();
    const state = await ask(dir, "Please assign the open task");
    expect(fakeLog.fakeTurnLog.lastManagerPrompt).toContain("### Team (workers of this project)");
    expect(fakeLog.fakeTurnLog.lastManagerPrompt).toContain("Ada (Technical Writer)");
    expect(fakeLog.fakeTurnLog.lastManagerPrompt).toContain("<assignment_proposals>");
    const reply = [...state.messages].reverse().find((m: any) => m.role === "manager");
    expect(reply.proposalError).toBeNull();

    const pending = await proposalsFor(dir);
    expect(pending).toHaveLength(1);
    expect(pending[0]).toMatchObject({
      status: "pending",
      worker: { id: ada.id, name: "Ada" },
      task: { title: "Write the release notes" },
      proposedBy: { kind: "project-manager", delegationId: null },
    });
    // Suggesting is not assigning, and not running.
    expect((await call("GET", `/task-assignments/task?taskId=${pending[0].taskId}`)).json.assignment).toBeNull();
    expect(snapshot()).toEqual(before);

    const body = { expectedRevision: pending[0].revision, expectedAssignmentRevision: null, allowReassign: false };
    // FO-ORCH02 contract: a PM suggestion needs a freshly reviewed routing
    // token. Without one, or with a tampered one, nothing is assigned.
    const noToken = await call("POST", `/assignment-proposals/${pending[0].id}/approve`, body);
    expect(noToken.status).toBe(409);
    const tampered = await call("POST", `/assignment-proposals/${pending[0].id}/approve`, { ...body, routingReviewToken: `${await reviewToken(pending[0].id)}x` });
    expect(tampered.status).toBe(409);
    expect((await call("GET", `/task-assignments/task?taskId=${pending[0].taskId}`)).json.assignment).toBeNull();
    const approved = await call("POST", `/assignment-proposals/${pending[0].id}/approve`, { ...body, routingReviewToken: await reviewToken(pending[0].id) });
    expect(approved.status).toBe(200);
    expect((await call("GET", `/task-assignments/task?taskId=${pending[0].taskId}`)).json.assignment.employeeId).toBe(ada.id);
    expect(snapshot()).toEqual(before);
  });

  test("invalid suggestions in a model reply are dropped and the owner is told", async () => {
    const dir = newProject("Manager bad");
    await configure(dir);
    await worker(dir, "Ada");
    await task(dir, "First open task");
    await task(dir, "Second open task");
    await task(dir, "Third open task");
    const state = await ask(dir, `assign the tasks ${fake.FAKE_PM_ASSIGN_BAD_MARKER}`);
    const reply = [...state.messages].reverse().find((m: any) => m.role === "manager");
    expect(reply.proposalError).toContain("Assignment suggestions:");
    expect(reply.proposalError).toContain("No such task");
    expect(reply.proposalError).toContain("No such worker in this project");
    expect(reply.proposalError).toContain("had no reason");
    expect(await proposalsFor(dir)).toHaveLength(1);
  });

  test("a suggestion for an assigned task is marked as needing explicit reassign consent", async () => {
    const dir = newProject("Manager reassign");
    await configure(dir);
    const ada = await worker(dir, "Ada");
    const bea = await worker(dir, "Bea");
    const t = await task(dir, "Held task");
    expect((await call("POST", "/task-assignments", { taskId: t.id, employeeId: ada.id })).status).toBe(201);
    await ask(dir, `assign again ${fake.FAKE_PM_ASSIGN_REASSIGN_MARKER}`);
    expect(fakeLog.fakeTurnLog.lastManagerPrompt).toContain("assigned to Ada");
    const [proposal] = await proposalsFor(dir);
    expect(proposal).toMatchObject({ needsReassign: true, worker: { id: bea.id }, currentAssignment: { employeeId: ada.id, revision: 1 } });
    const routingReviewToken = await reviewToken(proposal.id);
    const refused = await call("POST", `/assignment-proposals/${proposal.id}/approve`, { expectedRevision: 1, expectedAssignmentRevision: 1, allowReassign: false, routingReviewToken });
    expect(refused.status).toBe(409);
    expect((await call("GET", `/task-assignments/task?taskId=${t.id}`)).json.assignment.employeeId).toBe(ada.id);
    const done = await call("POST", `/assignment-proposals/${proposal.id}/approve`, { expectedRevision: 1, expectedAssignmentRevision: 1, allowReassign: true, routingReviewToken: await reviewToken(proposal.id) });
    expect(done.status).toBe(200);
    expect(done.json.proposal.result.reassigned).toBe(true);
    expect((await call("GET", `/task-assignments/task?taskId=${t.id}`)).json.assignment).toMatchObject({ employeeId: bea.id, revision: 2 });
  });

  test("a delegated request keeps its provenance on the proposal", async () => {
    const dir = newProject("Manager delegated");
    await configure(dir);
    const ada = await worker(dir, "Ada");
    await task(dir, "Delegated task");
    await ask(dir, "assign the open task", { delegationId: "delegation-123" });
    const [proposal] = await proposalsFor(dir);
    expect(proposal.proposedBy.delegationId).toBe("delegation-123");
    expect(proposal.worker.id).toBe(ada.id);
    expect(proposal.status).toBe("pending");
  });

  test("a project's manager cannot propose for another project's team or tasks", async () => {
    const one = newProject("Isolated one");
    const two = newProject("Isolated two");
    await configure(one);
    await worker(two, "Bea");
    await task(two, "Other project task");
    await task(one, "Own task");
    await ask(one, "assign the open task");
    // One has no workers, so no team section and no proposal.
    expect(fakeLog.fakeTurnLog.lastManagerPrompt).not.toContain("Bea");
    expect(await proposalsFor(one)).toEqual([]);
    expect(await proposalsFor(two)).toEqual([]);
  });

  test("the project summary lists pending proposals only for registered projects", async () => {
    const dir = newProject("Summary");
    const ada = await worker(dir, "Ada");
    const t = await task(dir, "Summary task");
    await call("POST", "/assignment-proposals", { taskId: t.id, employeeId: ada.id, rationale: "Ada" });
    const summary = (await call("GET", "/assignment-proposals/summary")).json;
    expect(summary.projects.find((p: any) => p.projectPath === dir)).toMatchObject({ projectName: "Summary", pending: 1 });
    expect(summary.pendingTotal).toBe(summary.projects.reduce((sum: number, p: any) => sum + p.pending, 0));
  });
});
