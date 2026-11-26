import { afterAll, beforeAll, describe, expect, spyOn, test } from "bun:test";
import { mkdtempSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

/**
 * FO-BRAIN03 through the real manager turns. The agent is the fake driver.
 * No provider CLI runs, and no proposal is written into Brain until approve.
 */

const DATA_DIR = mkdtempSync(path.join(tmpdir(), "fo-brain03-mgr-"));
process.env.AGETOR_DATA_DIR = DATA_DIR;
process.env.AGETOR_API_PORT = "4763";
process.env.AGETOR_CODEX_DRIVER = "fake";
process.env.AGETOR_CODEX_BIN = "/bin/echo";
process.env.AGETOR_CURSOR_BIN = "/nonexistent/cursor-agent";
process.env.AGETOR_TMUX_BIN = "/bin/echo";

let base = "";
let token = "";
let server: { stop: () => void };
let db: typeof import("./db.ts");
let fakePm: typeof import("./project-manager-fake.ts");
let fakePortfolio: typeof import("./portfolio-manager-fake.ts");
let consent = "";
const spies: Array<ReturnType<typeof spyOn>> = [];

beforeAll(async () => {
  for (const method of ["log", "warn", "error", "info"] as const) {
    spies.push(spyOn(console, method).mockImplementation(() => {}));
  }
  db = await import("./db.ts");
  fakePm = await import("./project-manager-fake.ts");
  fakePortfolio = await import("./portfolio-manager-fake.ts");
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
  for (const spy of spies) spy.mockRestore();
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
  const dir = realpathSync(mkdtempSync(path.join(tmpdir(), "fo-brain03-proj-")));
  db.projects.upsert(dir, name);
  return dir;
}

async function configure(dir: string | null): Promise<void> {
  const config = { harness: "codex", model: "gpt-6.1-sol", effort: "low", consentKey: consent };
  const res = dir
    ? await call("PUT", "/project-manager/config", { path: dir, config })
    : await call("PUT", "/portfolio-manager/config", { config });
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

const memoryCount = async () => (await call("GET", "/brain/status")).json.counts.active as number;
const proposalCount = () => db.db.query<{ n: number }, []>("SELECT COUNT(*) AS n FROM brain_memory_proposals").get()?.n ?? 0;

async function managerReply(dir: string, text: string, extra: Record<string, unknown> = {}) {
  const turns = fakePortfolio.fakeTurnLog.manager;
  const sent = await call("POST", "/project-manager/messages", { path: dir, text, ...extra });
  expect(sent.status).toBe(202);
  const turn = await settle(`/project-manager/turns/${sent.json.turn.id}`);
  expect(turn.status).toBe("succeeded");
  expect(fakePortfolio.fakeTurnLog.manager).toBe(turns + 1);
  const state = await call("GET", `/project-manager?path=${encodeURIComponent(dir)}`);
  return state.json.messages.at(-1);
}

describe("FO-BRAIN03 manager proposals", () => {
  test("proposal generation is off by default and a bad tag keeps the reply", async () => {
    const alpha = newProject("Alpha");
    await configure(alpha);
    const before = proposalCount();
    const plain = await managerReply(alpha, "What is next?");
    expect(plain.text).toBeTruthy();
    expect(fakePortfolio.fakeTurnLog.lastManagerPrompt).not.toContain("## Memory proposals for this message");
    const bad = await managerReply(alpha, fakePm.FAKE_PM_MEMORY_BAD_MARKER);
    expect(bad.text).toContain("unreadable");
    expect(bad.proposalError).toContain("did not allow");
    expect(proposalCount()).toBe(before);
    expect(await memoryCount()).toBe(0);
  });

  test("an opted-in project manager proposes only its own project", async () => {
    const alpha = newProject("Alpha Own");
    const beta = newProject("Beta Other");
    await configure(alpha);
    const reply = await managerReply(alpha, fakePm.FAKE_PM_MEMORY_MARKER, { allowMemoryProposals: true });
    expect(fakePortfolio.fakeTurnLog.lastManagerPrompt).toContain("## Memory proposals for this message");
    expect(fakePortfolio.fakeTurnLog.lastManagerPrompt).toContain(alpha);
    expect(fakePortfolio.fakeTurnLog.lastManagerPrompt).not.toContain(beta);
    expect(reply.text).toContain("not saved until you approve");
    expect(reply.memoryProposalIds).toHaveLength(1);
    const listed = await call("GET", `/brain/proposals?messageId=${reply.id}`);
    expect(listed.status).toBe(200);
    expect(listed.json.proposals[0].scope).toEqual({ kind: "project", id: alpha });
    expect(listed.json.proposals[0].status).toBe("pending");
    expect(await memoryCount()).toBe(0);

    const cross = await managerReply(alpha, fakePm.FAKE_PM_MEMORY_CROSS_MARKER, { allowMemoryProposals: true });
    expect(cross.memoryProposalIds ?? []).toHaveLength(0);
    expect(cross.proposalError).toContain("outside");
    const company = await managerReply(alpha, fakePm.FAKE_PM_MEMORY_COMPANY_MARKER, { allowMemoryProposals: true });
    expect(company.proposalError).toContain("Company scope");
    const secret = await managerReply(alpha, fakePm.FAKE_PM_MEMORY_SECRET_MARKER, { allowMemoryProposals: true });
    expect(secret.proposalError).toContain("credential");
    const many = await managerReply(alpha, fakePm.FAKE_PM_MEMORY_MANY_MARKER, { allowMemoryProposals: true });
    expect(many.proposalError).toContain("none were saved");
    const inject = await managerReply(alpha, fakePm.FAKE_PM_MEMORY_INJECT_MARKER, { allowMemoryProposals: true });
    expect(inject.text).toContain("not saved until you approve");
    expect(inject.memoryProposalIds ?? []).toHaveLength(0);
    const tasks = db.db.query<{ n: number }, []>("SELECT COUNT(*) AS n FROM tasks").get()?.n ?? 0;
    expect(tasks).toBe(0);
    expect(await memoryCount()).toBe(0);
  });

  test("head of PM proposes company and the named project, then approval writes one memory", async () => {
    const alpha = newProject("Alpha Head");
    await configure(null);
    const bare = await call("POST", "/portfolio-manager/messages", { text: fakePortfolio.FAKE_PORTFOLIO_MEMORY_MARKER, allowMemoryProposals: true });
    expect(bare.status).toBe(400);
    const known = await call("GET", "/projects");
    const paths = (known.json as { path: string }[]).map((project) => project.path).slice(0, 8);
    expect(paths).toContain(alpha);
    const turns = fakePortfolio.fakeTurnLog.portfolio;
    const sent = await call("POST", "/portfolio-manager/messages", {
      text: fakePortfolio.FAKE_PORTFOLIO_MEMORY_MARKER,
      allowMemoryProposals: true,
      allowCompanyMemoryProposals: true,
      memoryProposalProjectPaths: paths,
    });
    expect(sent.status).toBe(202);
    await settle(`/portfolio-manager/turns/${sent.json.turn.id}`);
    expect(fakePortfolio.fakeTurnLog.portfolio).toBe(turns + 1);
    expect(fakePortfolio.fakeTurnLog.lastPortfolioPrompt).toContain("## Memory proposals for this message");
    expect(fakePortfolio.fakeTurnLog.lastPortfolioPrompt).toContain("- company");
    expect(fakePortfolio.fakeTurnLog.lastPortfolioPrompt).toContain(alpha);
    const state = await call("GET", "/portfolio-manager");
    const reply = state.json.messages.at(-1);
    expect(reply.memoryProposalIds).toHaveLength(2);
    const listed = await call("GET", `/brain/proposals?messageId=${reply.id}`);
    const company = listed.json.proposals.find((item: { scope: { kind: string } }) => item.scope.kind === "company");
    const project = listed.json.proposals.find((item: { scope: { kind: string } }) => item.scope.kind === "project");
    expect(paths).toContain(project.scope.id);
    const edited = await call("PATCH", `/brain/proposals/${company.id}`, {
      expectedRevision: company.revision,
      title: "Owner-edited boundary",
      content: "The Owner rejected the deployment because the security boundary was not acceptable.",
    });
    expect(edited.status).toBe(200);
    expect(edited.json.editedByOwner).toBe(true);
    const approved = await call("POST", `/brain/proposals/${company.id}/approve`, { expectedRevision: edited.json.revision });
    expect(approved.status).toBe(201);
    expect(approved.json.memory.origin).toBe("owner-approved-proposal");
    expect(approved.json.memory.executable).toBe(false);
    expect(approved.json.memory.role).toBe("data");
    const replay = await call("POST", `/brain/proposals/${company.id}/approve`, { expectedRevision: edited.json.revision });
    expect(replay.status).toBe(200);
    expect(replay.json.memory.id).toBe(approved.json.memory.id);
    const rejected = await call("POST", `/brain/proposals/${project.id}/reject`, { expectedRevision: project.revision, reason: "Not needed." });
    expect(rejected.status).toBe(200);
    expect(rejected.json.memoryId).toBeNull();
    const memories = await call("GET", "/brain/memories?scopeKind=company");
    expect(memories.json.memories.filter((item: { id: string }) => item.id === approved.json.memory.id)).toHaveLength(1);
    const actions = await call("GET", "/owner-actions");
    expect(actions.json.memoryProposals.some((item: { id: string }) => item.id === company.id)).toBe(false);
    expect(actions.json.proposals.some((item: { id: string }) => item.id === company.id)).toBe(false);
  });
});
