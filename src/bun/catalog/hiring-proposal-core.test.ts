import { beforeEach, describe, expect, it } from "bun:test";
import { Database } from "bun:sqlite";
import { HiringProposalCore, HiringProposalError } from "./hiring-proposal-core.ts";
import { RoleCatalogService } from "./role-catalog.ts";
import { EmployeeCore } from "../employee-core.ts";
import { EmployeeProfileCore } from "./employee-profile-core.ts";
import { migrate } from "../migrate.ts";
import { migrations } from "../migrations/index.ts";

describe("HiringProposalCore", () => {
  let db: Database;
  let catalog: RoleCatalogService;
  let core: HiringProposalCore;
  let nowMs = 1_000_000;
  const now = () => nowMs;

  const PROJECT_A = "/workspaces/project-alpha";
  const PROJECT_B = "/workspaces/project-beta";

  beforeEach(() => {
    db = new Database(":memory:");
    db.run("PRAGMA foreign_keys = ON");
    migrate(db, migrations);

    catalog = new RoleCatalogService();
    core = new HiringProposalCore(db, { catalog, now });

    // Seed registered projects
    db.run(
      `INSERT INTO projects (path, name, added_at) VALUES (?, ?, ?)`,
      [PROJECT_A, "Project Alpha", 10],
    );
    db.run(
      `INSERT INTO projects (path, name, added_at) VALUES (?, ?, ?)`,
      [PROJECT_B, "Project Beta", 20],
    );

    // Seed tasks in Project Alpha
    db.run(
      `INSERT INTO tasks (id, title, prompt, "column", agent, workdir, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      ["task-1", "Build React UI", "prompt text", "backlog", "default", `${PROJECT_A}/src`, 10, 10],
    );
    // Seed task in Project Beta
    db.run(
      `INSERT INTO tasks (id, title, prompt, "column", agent, workdir, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      ["task-beta-1", "Beta Task", "prompt text", "backlog", "default", `${PROJECT_B}/src`, 10, 10],
    );

    // Seed Project Manager in Project Alpha
    db.run(
      `INSERT INTO ai_employees (id, kind, name, name_source, job_title, role_category, specializations, project_path, status, created_at, updated_at)
       VALUES ('pm-1', 'project-manager', 'Manager Alpha', 'generated', 'Project Manager', 'project-management', '[]', ?, 'active', 10, 10)`,
      [PROJECT_A],
    );
  });

  // 1. Valid PM team proposal
  it("1. Valid PM team proposal creates pending proposal with correct metadata", () => {
    const drafts = [
      {
        name: "Devon",
        roleSlug: "engineering-frontend-developer",
        title: "Senior Frontend Engineer",
        justification: "Needs to build responsive client UI for Project Alpha.",
        competencies: ["React", "TypeScript"],
        relatedTasks: ["task-1"],
        adaptedPrompt: "# Custom Frontend Dev\nFocus on accessibility.",
      },
    ];

    const res = core.createFromManager(PROJECT_A, drafts, { messageId: "msg-123" });
    expect(res.dropped).toEqual([]);
    expect(res.created.length).toBe(1);

    const prop = res.created[0]!;
    expect(prop.id).toBeDefined();
    expect(prop.projectPath).toBe(PROJECT_A);
    expect(prop.proposedName).toBe("Devon");
    expect(prop.professionalTitle).toBe("Senior Frontend Engineer");
    expect(prop.catalogRoleSlug).toBe("engineering-frontend-developer");
    expect(prop.templateSha256).toBeDefined();
    expect(prop.promptMarkdown).toBe("# Custom Frontend Dev\nFocus on accessibility.");
    expect(prop.justification).toBe("Needs to build responsive client UI for Project Alpha.");
    expect(prop.competencies).toEqual(["React", "TypeScript"]);
    expect(prop.relatedTasks).toEqual(["task-1"]);
    expect(prop.status).toBe("pending");
    expect(prop.revision).toBe(1);
    expect(prop.sourceMessageId).toBe("msg-123");
    expect(prop.proposedBy.kind).toBe("project-manager");
    expect(prop.proposedBy.employeeId).toBe("pm-1");
  });

  // 2. Multiple catalog roles
  it("2. Multiple catalog roles are all recorded cleanly", () => {
    const drafts = [
      {
        roleSlug: "engineering-frontend-developer",
        justification: "Frontend UI work.",
        competencies: ["React"],
        relatedTasks: [],
      },
      {
        roleSlug: "engineering-backend-architect",
        justification: "Backend API and database architecture.",
        competencies: ["Bun", "SQLite"],
        relatedTasks: [],
      },
      {
        roleSlug: "testing-reality-checker",
        justification: "Quality assurance and testing.",
        competencies: ["Playwright"],
        relatedTasks: [],
      },
    ];

    const res = core.createFromManager(PROJECT_A, drafts);
    expect(res.dropped).toEqual([]);
    expect(res.created.length).toBe(3);
    const slugs = res.created.map((p) => p.catalogRoleSlug);
    expect(slugs).toEqual([
      "engineering-frontend-developer",
      "engineering-backend-architect",
      "testing-reality-checker",
    ]);
  });

  // 3. Missing catalog slug
  it("3. Missing catalog slug is dropped without recording proposal", () => {
    const drafts = [
      {
        roleSlug: "nonexistent-superhero-agent",
        justification: "Should fail validation.",
      },
    ];

    const res = core.createFromManager(PROJECT_A, drafts);
    expect(res.created).toEqual([]);
    expect(res.dropped.length).toBe(1);
    expect(res.dropped[0]).toContain("not found in the role catalog");
  });

  // 4. Missing project
  it("4. Missing project fails cleanly", () => {
    const drafts = [
      {
        roleSlug: "engineering-frontend-developer",
        justification: "Missing project test.",
      },
    ];

    const res = core.createFromManager("/nonexistent/project", drafts);
    expect(res.created).toEqual([]);
    expect(res.dropped[0]).toContain("not registered");

    expect(() =>
      core.create("/nonexistent/project", {
        roleSlug: "engineering-frontend-developer",
        justification: "Owner create test.",
      }),
    ).toThrow(HiringProposalError);
  });

  // 5. Foreign project
  it("5. Foreign project task reference is dropped", () => {
    const drafts = [
      {
        roleSlug: "engineering-frontend-developer",
        justification: "Reference task from another project.",
        relatedTasks: ["task-beta-1"],
      },
    ];

    const res = core.createFromManager(PROJECT_A, drafts);
    expect(res.created).toEqual([]);
    expect(res.dropped[0]).toContain("references task from a foreign project");
  });

  // 6. Archived project
  it("6. Archived project rejects hiring proposals", () => {
    db.run(
      `INSERT INTO clusters (id, name, created_at, updated_at, archived_at) VALUES ('c1', 'Cluster 1', 10, 10, 50)`,
    );
    db.run(
      `INSERT INTO cluster_project_memberships (project_path, cluster_id, assigned_at, updated_at) VALUES (?, 'c1', 10, 10)`,
      [PROJECT_A],
    );

    const res = core.createFromManager(PROJECT_A, [
      {
        roleSlug: "engineering-frontend-developer",
        justification: "Archived project test.",
      },
    ]);
    expect(res.created).toEqual([]);
    expect(res.dropped[0]).toContain("archived");

    expect(() =>
      core.create(PROJECT_A, {
        roleSlug: "engineering-frontend-developer",
        justification: "Archived project test.",
      }),
    ).toThrow("archived");
  });

  // 7. Existing employee duplication
  it("7. Existing employee duplication is detected and refused", () => {
    // Hire frontend developer Ada in Project Alpha
    const empId = "emp-ada";
    db.run(
      `INSERT INTO ai_employees (id, kind, name, name_source, job_title, role_category, specializations, project_path, status, created_at, updated_at)
       VALUES (?, 'worker', 'Ada', 'owner', 'Frontend Developer', 'engineering', '[]', ?, 'active', 10, 10)`,
      [empId, PROJECT_A],
    );
    db.run(
      `INSERT INTO ai_employee_professional_profiles (employee_id, catalog_role_slug, professional_title, division, current_revision, created_at, updated_at)
       VALUES (?, 'engineering-frontend-developer', 'Frontend Developer', 'engineering', 1, 10, 10)`,
      [empId],
    );

    // PM tries to propose the same role for Project Alpha
    const res = core.createFromManager(PROJECT_A, [
      {
        roleSlug: "engineering-frontend-developer",
        justification: "Try to duplicate Ada.",
      },
    ]);
    expect(res.created).toEqual([]);
    expect(res.dropped[0]).toContain("already exists in this project");

    // Owner create also refuses duplicate active employee
    expect(() =>
      core.create(PROJECT_A, {
        roleSlug: "engineering-frontend-developer",
        justification: "Owner duplicate create.",
      }),
    ).toThrow("already exists in this project");
  });

  // 10. Hiring Proposal persistence & audit trail
  it("10. Hiring Proposal persistence and event history are preserved", () => {
    const prop = core.create(PROJECT_A, {
      roleSlug: "engineering-frontend-developer",
      proposedName: "Luna",
      professionalTitle: "Lead UI Developer",
      justification: "Owner initiated hiring.",
      competencies: ["CSS", "HTML", "React"],
      relatedTasks: ["task-1"],
    });

    const retrieved = core.get(prop.id);
    expect(retrieved).not.toBeNull();
    expect(retrieved!.proposedName).toBe("Luna");
    expect(retrieved!.professionalTitle).toBe("Lead UI Developer");
    expect(retrieved!.status).toBe("pending");
    expect(retrieved!.revision).toBe(1);
    expect(retrieved!.proposedBy.kind).toBe("owner");

    const hist = core.history(prop.id);
    expect(hist.events.length).toBe(1);
    expect(hist.events[0]!.action).toBe("created");
    expect(hist.events[0]!.actor).toBe("owner");
  });

  // 11. Owner approval
  it("11. Owner approval transitions proposal to approved, creates employee and profile", () => {
    const prop = core.create(PROJECT_A, {
      roleSlug: "engineering-frontend-developer",
      proposedName: "Kai",
      justification: "For approval test.",
    });

    nowMs = 2_000_000;
    const approval = core.approve(prop.id, {
      expectedRevision: 1,
      changeNote: "Owner approved Kai",
    });

    expect(approval.alreadyApplied).toBe(false);
    expect(approval.proposal.status).toBe("approved");
    expect(approval.proposal.revision).toBe(2);
    expect(approval.proposal.decidedAt).toBe(2_000_000);
    expect(approval.proposal.createdEmployeeId).toBeDefined();

    // Verify employee was created
    const emp = approval.employee;
    expect(emp).toBeDefined();
    expect(emp.id).toBe(approval.proposal.createdEmployeeId!);
    expect(emp.name).toBe("Kai");
    expect(emp.projectPath).toBe(PROJECT_A);
    expect(emp.status).toBe("active");

    // Verify profile was created at revision 1
    const profileCore = new EmployeeProfileCore(db, { catalog });
    const profile = profileCore.getProfile(emp.id);
    expect(profile).not.toBeNull();
    expect(profile!.catalogRoleSlug).toBe("engineering-frontend-developer");
    expect(profile!.currentRevision).toBe(1);
    expect(profile!.activePrompt.ownerProvenance).toBe("owner");

    // Verify event in proposal history
    const hist = core.history(prop.id);
    expect(hist.events.length).toBe(2);
    expect(hist.events[1]!.action).toBe("approved");
    expect(hist.events[1]!.actor).toBe("owner");
    expect(hist.events[1]!.proposalRevision).toBe(2);
    expect(hist.events[1]!.createdEmployeeId).toBe(emp.id);
  });

  // 12. Owner rejection
  it("12. Owner rejection transitions proposal to rejected without creating employee", () => {
    const prop = core.create(PROJECT_A, {
      roleSlug: "engineering-backend-architect",
      justification: "To be rejected.",
    });

    const employeesBefore = db.query(`SELECT COUNT(*) AS n FROM ai_employees`).get() as { n: number };

    const rej = core.reject(prop.id, {
      expectedRevision: 1,
      note: "Not needed for this milestone",
    });

    expect(rej.alreadyApplied).toBe(false);
    expect(rej.proposal.status).toBe("rejected");
    expect(rej.proposal.revision).toBe(2);
    expect(rej.proposal.createdEmployeeId).toBeNull();
    expect(rej.proposal.decisionNote).toBe("Not needed for this milestone");

    // No employee created
    const employeesAfter = db.query(`SELECT COUNT(*) AS n FROM ai_employees`).get() as { n: number };
    expect(employeesAfter.n).toBe(employeesBefore.n);
  });

  // 13. Stale revision
  it("13. Stale revision rejects concurrent or outdated approval", () => {
    const prop = core.create(PROJECT_A, {
      roleSlug: "engineering-frontend-developer",
      justification: "Stale revision test.",
    });

    expect(() =>
      core.approve(prop.id, {
        expectedRevision: 999, // Stale!
      }),
    ).toThrow(HiringProposalError);

    try {
      core.approve(prop.id, { expectedRevision: 999 });
    } catch (err) {
      expect((err as HiringProposalError).status).toBe(409);
    }
  });

  // 14. Double approval
  it("14. Double approval is idempotent on exact replay and prevents second employee creation", () => {
    const prop = core.create(PROJECT_A, {
      roleSlug: "engineering-frontend-developer",
      justification: "Double approval test.",
    });

    const first = core.approve(prop.id, { expectedRevision: 1 });
    expect(first.alreadyApplied).toBe(false);

    // Count employees
    const employeesCount = (db.query(`SELECT COUNT(*) AS n FROM ai_employees`).get() as { n: number }).n;

    // Replay with expectedRevision = 1
    const second = core.approve(prop.id, { expectedRevision: 1 });
    expect(second.alreadyApplied).toBe(true);
    expect(second.proposal.id).toBe(first.proposal.id);
    expect(second.employee.id).toBe(first.employee.id);

    // No second employee was created
    const countAfter = (db.query(`SELECT COUNT(*) AS n FROM ai_employees`).get() as { n: number }).n;
    expect(countAfter).toBe(employeesCount);
  });

  // 15. Concurrent approval
  it("15. Concurrent approval fails with 409 conflict", () => {
    const prop = core.create(PROJECT_A, {
      roleSlug: "engineering-frontend-developer",
      justification: "Concurrency test.",
    });

    // Simulate concurrent modification bump
    db.run(`UPDATE hiring_proposals SET revision = 2 WHERE id = ?`, [prop.id]);

    expect(() =>
      core.approve(prop.id, { expectedRevision: 1 }),
    ).toThrow(HiringProposalError);
  });

  // 16. Atomic employee and profile creation
  it("16. Atomic employee and profile creation guarantees consistency", () => {
    const prop = core.create(PROJECT_A, {
      roleSlug: "engineering-devops-automator",
      proposedName: "DevOps specialist",
      justification: "Atomic test.",
    });

    const approval = core.approve(prop.id, { expectedRevision: 1 });
    const empId = approval.employee.id;

    // Verify employee in ai_employees
    const empRow = db.query(`SELECT * FROM ai_employees WHERE id = ?`).get(empId);
    expect(empRow).not.toBeNull();

    // Verify professional profile in ai_employee_professional_profiles
    const profRow = db.query(`SELECT * FROM ai_employee_professional_profiles WHERE employee_id = ?`).get(empId);
    expect(profRow).not.toBeNull();

    // Verify revision in ai_employee_profile_revisions
    const revRow = db.query(`SELECT * FROM ai_employee_profile_revisions WHERE employee_id = ? AND revision = 1`).get(empId);
    expect(revRow).not.toBeNull();
  });

  // 17. Approval failure rollback
  it("17. Approval failure rollback leaves no orphan employee", () => {
    const prop = core.create(PROJECT_A, {
      roleSlug: "engineering-frontend-developer",
      justification: "Rollback test.",
    });

    const employeesBefore = (db.query(`SELECT COUNT(*) AS n FROM ai_employees`).get() as { n: number }).n;

    // Trigger failure by exceeding prompt size limit (512 KiB)
    const hugePrompt = "x".repeat(520 * 1024);
    expect(() =>
      core.approve(prop.id, {
        expectedRevision: 1,
        promptMarkdown: hugePrompt,
      }),
    ).toThrow(HiringProposalError);

    // Proposal stays pending
    expect(core.get(prop.id)!.status).toBe("pending");

    // No employee was left in ai_employees
    const employeesAfter = (db.query(`SELECT COUNT(*) AS n FROM ai_employees`).get() as { n: number }).n;
    expect(employeesAfter).toBe(employeesBefore);
  });

  // 18. Catalog SHA mismatch
  it("18. Catalog SHA mismatch rejects approval", () => {
    const prop = core.create(PROJECT_A, {
      roleSlug: "engineering-frontend-developer",
      justification: "SHA mismatch test.",
    });

    // Artificially change proposal's template_sha256 to simulate upstream file modification
    const alteredSha = "f".repeat(64);
    db.run(`UPDATE hiring_proposals SET template_sha256 = ? WHERE id = ?`, [alteredSha, prop.id]);

    expect(() =>
      core.approve(prop.id, { expectedRevision: 1 }),
    ).toThrow("Catalog SHA mismatch");
  });

  // 19. Edited professional prompt
  it("19. Edited professional prompt on approval is stored in profile revision 1", () => {
    const prop = core.create(PROJECT_A, {
      roleSlug: "engineering-frontend-developer",
      justification: "Custom prompt test.",
    });

    const customPrompt = "# Super Custom Instructions\nOnly build Tailwind components.";
    const approval = core.approve(prop.id, {
      expectedRevision: 1,
      proposedName: "Custom Alex",
      professionalTitle: "Tailwind Architect",
      promptMarkdown: customPrompt,
      changeNote: "Owner customized prompt",
    });

    expect(approval.proposal.proposedName).toBe("Custom Alex");
    expect(approval.proposal.professionalTitle).toBe("Tailwind Architect");
    expect(approval.proposal.promptMarkdown).toBe(customPrompt);

    const profileCore = new EmployeeProfileCore(db, { catalog });
    const profile = profileCore.getProfile(approval.employee.id)!;
    expect(profile.professionalTitle).toBe("Tailwind Architect");
    expect(profile.activePrompt.promptMarkdown).toBe(customPrompt);
    expect(profile.activePrompt.changeNote).toBe("Owner customized prompt");
  });

  // 20. Correct Employee UUID & 21. Correct project scope
  it("20 & 21. Correct Employee UUID and Project scope", () => {
    const prop = core.create(PROJECT_A, {
      roleSlug: "engineering-frontend-developer",
      justification: "Scope test.",
    });

    const approval = core.approve(prop.id, { expectedRevision: 1 });
    const emp = approval.employee;

    // UUID v4 format
    expect(emp.id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
    expect(approval.proposal.createdEmployeeId).toBe(emp.id);

    // Exact project path
    expect(emp.projectPath).toBe(PROJECT_A);
  });

  // 22. No automatic assignment & 23. No automatic execution
  it("22 & 23. Employee creation does not assign tasks or trigger execution", () => {
    const prop = core.create(PROJECT_A, {
      roleSlug: "engineering-frontend-developer",
      justification: "Isolation test.",
      relatedTasks: ["task-1"],
    });

    const approval = core.approve(prop.id, { expectedRevision: 1 });
    const empId = approval.employee.id;

    // 0 task assignments
    const assignments = db
      .query(`SELECT COUNT(*) AS n FROM employee_task_assignments WHERE employee_id = ?`)
      .get(empId) as { n: number };
    expect(assignments.n).toBe(0);

    // 0 runs started
    const runs = db.query(`SELECT COUNT(*) AS n FROM runs`).get() as { n: number };
    expect(runs.n).toBe(0);
  });

  // 26. Restart persistence
  it("26. Restart persistence retains proposals, events, and created profiles", () => {
    const prop = core.create(PROJECT_A, {
      roleSlug: "engineering-frontend-developer",
      proposedName: "Persistent Worker",
      justification: "Persistence test.",
    });
    core.approve(prop.id, { expectedRevision: 1 });

    // New instance connected to the same DB
    const freshCore = new HiringProposalCore(db, { catalog, now });
    const retrieved = freshCore.get(prop.id);
    expect(retrieved).not.toBeNull();
    expect(retrieved!.status).toBe("approved");
    expect(retrieved!.proposedName).toBe("Persistent Worker");

    const hist = freshCore.history(prop.id);
    expect(hist.events.length).toBe(2);
  });

  // 27. Existing Employee regressions
  it("27. Existing EmployeeCore methods continue to work without regression", () => {
    const employees = new EmployeeCore(db);

    // Create worker directly
    const worker = employees.createWorker({
      name: "Direct Worker",
      jobTitle: "Software Engineer",
      projectPath: PROJECT_A,
    });
    expect(worker.id).toBeDefined();
    expect(worker.name).toBe("Direct Worker");

    // Set head
    const headResult = employees.setHead({ name: "Global Head" });
    expect(headResult.employee.name).toBe("Global Head");

    // Update worker
    const updated = employees.update(worker.id, { name: "Renamed Worker" });
    expect(updated.name).toBe("Renamed Worker");

    // Archive worker
    const archived = employees.archive(worker.id);
    expect(archived.status).toBe("archived");
  });

  // 28. Existing Professional Profile regressions
  it("28. Existing EmployeeProfileCore methods continue to work without regression", () => {
    const employees = new EmployeeCore(db);
    const worker = employees.createWorker({
      name: "Profile Worker",
      jobTitle: "Developer",
      projectPath: PROJECT_A,
    });

    const profileCore = new EmployeeProfileCore(db, { catalog });

    // Assign role
    const assigned = profileCore.assignRole(worker.id, {
      catalogRoleSlug: "engineering-frontend-developer",
    });
    expect(assigned.catalogRoleSlug).toBe("engineering-frontend-developer");
    expect(assigned.currentRevision).toBe(1);

    // Update prompt
    const updated = profileCore.updatePrompt(worker.id, {
      promptMarkdown: "# Version 2 instructions",
      expectedRevision: 1,
      changeNote: "Second revision",
    });
    expect(updated.currentRevision).toBe(2);

    // Revisions list
    const revs = profileCore.listRevisions(worker.id);
    expect(revs.length).toBe(2);
  });
});
