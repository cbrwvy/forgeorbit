import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

/**
 * Project Manager Team Builder Integration Tests (FO-014C).
 * Uses fake driver (no real AI / CLI).
 */

const DATA_DIR = mkdtempSync(path.join(tmpdir(), "fo014c-pm-"));
process.env.AGETOR_DATA_DIR = DATA_DIR;
process.env.AGETOR_API_PORT = "4719";
process.env.AGETOR_CODEX_DRIVER = "fake";
process.env.AGETOR_CODEX_BIN = "/bin/echo";
process.env.AGETOR_TMUX_BIN = "/bin/echo";
process.env.AGETOR_USAGE_OFFLINE = "1";
for (const kind of ["CLAUDE", "CURSOR", "GEMINI", "FX", "ANTIGRAVITY"]) {
  process.env[`AGETOR_${kind}_BIN`] = "/nonexistent/fo014c-cli";
}

let base = "";
let token = "";
let server: { stop: () => void };
let db: typeof import("../db.ts");
let manager: typeof import("../project-manager.ts");
let fake: typeof import("../project-manager-fake.ts");
let consent = "";

beforeAll(async () => {
  db = await import("../db.ts");
  manager = await import("../project-manager.ts");
  fake = await import("../project-manager-fake.ts");
  const started = await import("../server.ts");
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
  const dir = realpathSync(mkdtempSync(path.join(tmpdir(), "fo014c-proj-")));
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

async function ask(dir: string, text: string): Promise<any> {
  const sent = await call("POST", "/project-manager/messages", { path: dir, text });
  expect(sent.status).toBe(202);
  await settle(sent.json.turn.id);
  return (await call("GET", `/project-manager?path=${encodeURIComponent(dir)}`)).json;
}

describe("Project Manager Team Builder Integration", () => {
  for (const slug of ["startup-mvp", "enterprise-feature", "marketing-campaign", "incident-response"]) {
    it(`FO-INT02: ${slug} flows from Owner through PM, approval and versioned professional profile`, async () => {
      const { RoleCatalogService } = await import("./role-catalog.ts");
      const catalog = new RoleCatalogService();
      const dir = newProject(`Acceptance ${slug}`);
      await configure(dir);
      const pm = await call("POST", "/employees/project-managers", { projectPath: dir });
      expect(pm.status).toBe(201);
      const legacy = await call("POST", "/employees", { name: "Legacy Worker", jobTitle: "Engineer", roleCategory: "engineering" });
      expect(legacy.status).toBe(201);
      const legacyId = legacy.json.id;
      expect((await call("GET", `/employees/${legacyId}/professional-profile`)).json.profile).toBeNull();
      const counts = () => ["tasks", "runs", "employee_executions"].map((table) => db.db.query(`SELECT COUNT(*) AS n FROM ${table}`).get());
      const before = counts();
      const text = `Recommend a team based on the ${slug} blueprint.`;
      const state = await ask(dir, text);
      const reply = [...state.messages].reverse().find((m: any) => m.role === "manager");
      expect(reply.sources).toContainEqual(expect.objectContaining({ id: "runbook", status: "included", detail: expect.stringContaining(slug) }));
      const list = (await call("GET", `/hiring-proposals?projectPath=${encodeURIComponent(dir)}`)).json.proposals;
      expect(list.length).toBeGreaterThanOrEqual(2);
      for (const proposal of list) {
        expect(catalog.getRole(proposal.catalogRoleSlug).slug).toBe(proposal.catalogRoleSlug);
        expect(proposal.proposedBy.employeeId).toBe(pm.json.employee.id);
        expect(proposal.projectPath).toBe(dir);
      }
      // A repeated owner request must not make a second pending row per role.
      await ask(dir, text);
      const repeated = (await call("GET", `/hiring-proposals?projectPath=${encodeURIComponent(dir)}`)).json.proposals;
      expect(repeated.map((p: any) => p.id).sort()).toEqual(list.map((p: any) => p.id).sort());
      const proposal = list[0];
      const template = catalog.getRole(proposal.catalogRoleSlug);
      const approved = await call("POST", `/hiring-proposals/${proposal.id}/approve`, { expectedRevision: 1 });
      expect(approved.status).toBe(200);
      const id = approved.json.employee.id;
      expect(approved.json.proposal.createdEmployeeId).toBe(id);
      const replay = await call("POST", `/hiring-proposals/${proposal.id}/approve`, { expectedRevision: 1 });
      expect(replay.status).toBe(200);
      expect(replay.json.alreadyApplied).toBe(true);
      expect(replay.json.employee.id).toBe(id);
      const profilePath = `/employees/${id}/professional-profile`;
      expect((await call("GET", profilePath)).json.profile.currentRevision).toBe(1);
      const custom = `# Owner instructions for ${slug}\nKeep project evidence.`;
      expect((await call("PUT", profilePath, { expectedRevision: 1, promptMarkdown: custom })).status).toBe(200);
      const reassignment = { catalogRoleSlug: "engineering-database-optimizer", expectedRevision: 2 };
      expect((await call("POST", profilePath, { ...reassignment, expectedRevision: 1 })).status).toBe(409);
      expect((await call("POST", profilePath, reassignment)).status).toBe(200);
      const history = (await call("GET", `${profilePath}/revisions`)).json.revisions;
      expect(history.map((r: any) => r.revision)).toEqual([3, 2, 1]);
      expect((await call("GET", `${profilePath}/revisions/2`)).json.revision.promptMarkdown).toBe(custom);
      expect((await call("GET", `/employees/${id}`)).json.id).toBe(id);
      expect((await call("GET", `/employees/${legacyId}`)).json.id).toBe(legacyId);
      expect(catalog.getRole(template.slug).originalMarkdown).toBe(template.originalMarkdown);
      expect(counts()).toEqual(before); // No Task Runtime invocation, task or run creation.
    });
  }

  it("proposes AI specialist team from catalog and attaches IDs to message", async () => {
    const dir = newProject("Team Builder Project");
    await configure(dir);

    const state = await ask(dir, "Please build a team for this project");
    const reply = [...state.messages].reverse().find((m: any) => m.role === "manager");
    expect(reply).toBeDefined();
    expect(reply.hiringProposalIds).toBeDefined();
    expect(reply.hiringProposalIds.length).toBe(2);

    // Verify proposals in DB
    const listRes = await call("GET", `/hiring-proposals?projectPath=${encodeURIComponent(dir)}`);
    expect(listRes.status).toBe(200);
    expect(listRes.json.proposals.length).toBe(2);

    const slugs = listRes.json.proposals.map((p: any) => p.catalogRoleSlug);
    expect(slugs).toContain("engineering-frontend-developer");
    expect(slugs).toContain("engineering-backend-architect");
  });

  it("handles malformed entries and invalid slugs gracefully", async () => {
    const dir = newProject("Bad Hiring Project");
    await configure(dir);

    const state = await ask(dir, `Please recommend a team ${fake.FAKE_PM_HIRE_BAD_MARKER}`);
    const reply = [...state.messages].reverse().find((m: any) => m.role === "manager");
    expect(reply).toBeDefined();
    expect(reply.proposalError).toContain("Team hiring suggestions:");
    expect(reply.proposalError).toContain("not found in the role catalog");

    // The two valid proposals still survived
    expect(reply.hiringProposalIds.length).toBe(2);
  });

  it("does not create hiring proposals when reply has plain text", async () => {
    const dir = newProject("Plain Project");
    await configure(dir);

    const state = await ask(dir, "What is the overall goal of this project?");
    const reply = [...state.messages].reverse().find((m: any) => m.role === "manager");
    expect(reply.hiringProposalIds ?? null).toBeNull();

    const listRes = await call("GET", `/hiring-proposals?projectPath=${encodeURIComponent(dir)}`);
    expect(listRes.json.proposals.length).toBe(0);
  });

  it("existing PM features (plans, task proposals) continue to work without regression", async () => {
    const dir = newProject("Regression Project");
    await configure(dir);

    // Plan
    const planState = await ask(dir, "Give me a plan for this project");
    const planReply = [...planState.messages].reverse().find((m: any) => m.role === "manager");
    expect(planReply.plan).not.toBeNull();
    expect(planReply.plan.steps.length).toBeGreaterThan(0);

    // Tasks proposal
    const taskState = await ask(dir, "Create tasks to split this work");
    const taskReply = [...taskState.messages].reverse().find((m: any) => m.role === "manager");
    expect(taskReply.proposalId).not.toBeNull();
  });
});
