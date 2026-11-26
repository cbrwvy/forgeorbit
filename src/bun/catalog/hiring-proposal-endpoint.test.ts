import { beforeEach, describe, expect, it } from "bun:test";
import { Database } from "bun:sqlite";
import { hiringProposalHttp } from "./hiring-proposal-http.ts";
import { catalogHttp } from "./catalog-http.ts";
import { HiringProposalCore } from "./hiring-proposal-core.ts";
import { RoleCatalogService } from "./role-catalog.ts";
import { RunbookCatalogService } from "./runbook-catalog.ts";
import { migrate } from "../migrate.ts";
import { migrations } from "../migrations/index.ts";

describe("Hiring Proposal HTTP API & Runbooks", () => {
  let db: Database;
  let catalog: RoleCatalogService;
  let runbooks: RunbookCatalogService;
  let core: HiringProposalCore;

  const PROJECT_A = "/workspaces/proj-alpha";

  beforeEach(() => {
    db = new Database(":memory:");
    db.run("PRAGMA foreign_keys = ON");
    migrate(db, migrations);

    catalog = new RoleCatalogService();
    runbooks = new RunbookCatalogService({ catalog });
    core = new HiringProposalCore(db, { catalog });

    db.run(
      `INSERT INTO projects (path, name, added_at) VALUES (?, ?, ?)`,
      [PROJECT_A, "Project Alpha", 10],
    );
  });

  const request = (
    path: string,
    options: {
      method?: string;
      body?: unknown;
      authorized?: boolean;
    } = {},
  ) => {
    const authorized = options.authorized ?? true;
    const req = new Request(`http://localhost:3000${path}`, {
      method: options.method ?? "GET",
      headers: {
        "content-type": "application/json",
      },
      body: options.body !== undefined ? JSON.stringify(options.body) : undefined,
    });
    return hiringProposalHttp(req, authorized, { core });
  };

  const catalogRequest = (path: string, authorized = true) => {
    const req = new Request(`http://localhost:3000${path}`, {
      method: "GET",
    });
    return catalogHttp(req, authorized, { service: catalog, runbooks });
  };

  it("requires bearer auth", async () => {
    const res = await request("/hiring-proposals", { authorized: false });
    expect(res.status).toBe(401);
    const body = await res.json();
    expect(body.error).toBe("unauthorized");
  });

  it("creates, lists, and retrieves hiring proposals", async () => {
    // Create proposal
    const createRes = await request("/hiring-proposals", {
      method: "POST",
      body: {
        projectPath: PROJECT_A,
        roleSlug: "engineering-frontend-developer",
        proposedName: "Sarah",
        professionalTitle: "Lead UI Developer",
        justification: "To build the main dashboard view.",
        competencies: ["React", "TypeScript"],
      },
    });
    expect(createRes.status).toBe(201);
    const created = await createRes.json();
    expect(created.proposal.id).toBeDefined();
    expect(created.proposal.proposedName).toBe("Sarah");
    expect(created.proposal.catalogRoleSlug).toBe("engineering-frontend-developer");
    expect(created.proposal.status).toBe("pending");

    // List proposals
    const listRes = await request(`/hiring-proposals?projectPath=${encodeURIComponent(PROJECT_A)}`);
    expect(listRes.status).toBe(200);
    const list = await listRes.json();
    expect(list.proposals.length).toBe(1);
    expect(list.proposals[0].id).toBe(created.proposal.id);

    // Get proposal by id
    const getRes = await request(`/hiring-proposals/${created.proposal.id}`);
    expect(getRes.status).toBe(200);
    const got = await getRes.json();
    expect(got.proposal.id).toBe(created.proposal.id);

    // Summary endpoint
    const summaryRes = await request("/hiring-proposals/summary");
    expect(summaryRes.status).toBe(200);
    const summary = await summaryRes.json();
    expect(summary.pendingTotal).toBe(1);
    expect(summary.projects.length).toBe(1);
  });

  it("supports editing proposal before approval via PATCH", async () => {
    const prop = core.create(PROJECT_A, {
      roleSlug: "engineering-frontend-developer",
      proposedName: "Sam",
      justification: "Initial reason",
    });

    const patchRes = await request(`/hiring-proposals/${prop.id}`, {
      method: "PATCH",
      body: {
        expectedRevision: 1,
        proposedName: "Samantha",
        professionalTitle: "Staff Frontend Engineer",
      },
    });
    expect(patchRes.status).toBe(200);
    const patched = await patchRes.json();
    expect(patched.proposal.proposedName).toBe("Samantha");
    expect(patched.proposal.professionalTitle).toBe("Staff Frontend Engineer");
    expect(patched.proposal.revision).toBe(2);
  });

  it("approves proposal and creates employee via POST /hiring-proposals/:id/approve", async () => {
    const prop = core.create(PROJECT_A, {
      roleSlug: "engineering-frontend-developer",
      proposedName: "Sam",
      justification: "Approval test",
    });

    const approveRes = await request(`/hiring-proposals/${prop.id}/approve`, {
      method: "POST",
      body: {
        expectedRevision: 1,
        changeNote: "Owner approved",
      },
    });
    expect(approveRes.status).toBe(200);
    const approved = await approveRes.json();
    expect(approved.alreadyApplied).toBe(false);
    expect(approved.proposal.status).toBe("approved");
    expect(approved.employee).toBeDefined();
    expect(approved.employee.name).toBe("Sam");
    expect(approved.employee.id).toBe(approved.proposal.createdEmployeeId);
  });

  it("rejects proposal via POST /hiring-proposals/:id/reject", async () => {
    const prop = core.create(PROJECT_A, {
      roleSlug: "engineering-backend-architect",
      proposedName: "Alex",
      justification: "Reject test",
    });

    const rejectRes = await request(`/hiring-proposals/${prop.id}/reject`, {
      method: "POST",
      body: {
        expectedRevision: 1,
        note: "Over budget",
      },
    });
    expect(rejectRes.status).toBe(200);
    const rejected = await rejectRes.json();
    expect(rejected.proposal.status).toBe("rejected");
    expect(rejected.proposal.decisionNote).toBe("Over budget");
  });

  it("exposes runbooks over catalog HTTP API", async () => {
    // List runbooks
    const listRes = await catalogRequest("/catalog/runbooks");
    expect(listRes.status).toBe(200);
    const list = await listRes.json();
    expect(list.runbooks.length).toBe(4);
    expect(list.runbooks.map((r: any) => r.slug)).toContain("startup-mvp");

    // Get single runbook
    const getRes = await catalogRequest("/catalog/runbooks/startup-mvp");
    expect(getRes.status).toBe(200);
    const detail = await getRes.json();
    expect(detail.runbook.slug).toBe("startup-mvp");
    expect(detail.runbook.roster.length).toBeGreaterThan(0);

    // Nonexistent runbook
    const notFoundRes = await catalogRequest("/catalog/runbooks/nonexistent-blueprint");
    expect(notFoundRes.status).toBe(404);
  });
});
