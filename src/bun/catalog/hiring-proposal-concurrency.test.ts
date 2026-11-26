/**
 * Concurrency, Boundary, Scope, and Runbook Scenario Probes (FO-INT01).
 *
 * Verifies:
 * - Real two-connection SQLite write transaction boundaries and deduplication (INT01-02).
 * - Exact UTF-8 byte boundary and multibyte prompt validation (INT01-01).
 * - Sibling prefix collision prevention /work/app vs /work/app-other (INT01-04).
 * - Mandatory revision precondition and CAS on profile reassignment (INT01-05).
 * - Distinct fake responses and structured untrusted context for all 4 runbooks (INT01-03).
 * - File-backed SQLite restart/reopen persistence.
 */

import { randomUUID } from "node:crypto";
import { Database } from "bun:sqlite";
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { migrate } from "../migrate.ts";
import { migrations } from "../migrations/index.ts";
import { RoleCatalogService } from "./role-catalog.ts";
import { HiringProposalCore, HiringProposalError } from "./hiring-proposal-core.ts";
import { EmployeeProfileCore, EmployeeProfileError } from "./employee-profile-core.ts";
import { MAX_PROMPT_BYTES } from "../../shared/employees/profile-types.ts";
import { HIRING_PROPOSAL_LIMITS } from "../../shared/hiring/types.ts";
import { fakeManagerReply } from "../project-manager-fake.ts";
import { buildManagerPrompt } from "../../shared/project-manager.ts";

describe("FO-INT01 Comprehensive Probes", () => {
  let tempDir: string;
  let dbPath: string;
  let db1: Database;
  let db2: Database;
  let catalog: RoleCatalogService;
  let core1: HiringProposalCore;
  let core2: HiringProposalCore;
  let profileCore1: EmployeeProfileCore;

  const PROJECT_APP = "/work/app";
  const PROJECT_SIBLING = "/work/app-other";

  beforeAll(async () => {
    tempDir = await mkdtemp(path.join(tmpdir(), "fo-int01-test-"));
    dbPath = path.join(tempDir, "test.db");

    // Two distinct SQLite connections to the exact same database file
    db1 = new Database(dbPath);
    db2 = new Database(dbPath);

    // Apply migrations on connection 1
    migrate(db1, migrations);

    catalog = new RoleCatalogService();
    core1 = new HiringProposalCore(db1, { catalog });
    core2 = new HiringProposalCore(db2, { catalog });
    profileCore1 = new EmployeeProfileCore(db1, { catalog });

    // Seed projects
    db1.run(`INSERT INTO projects (path, name, added_at) VALUES (?, ?, ?)`, [PROJECT_APP, "Main App", 10]);
    db1.run(`INSERT INTO projects (path, name, added_at) VALUES (?, ?, ?)`, [PROJECT_SIBLING, "Sibling App", 20]);

    // Seed tasks with sibling paths
    db1.run(`INSERT INTO tasks (id, title, prompt, "column", agent, workdir, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`, [
      "task-main-001",
      "Main App Task",
      "Prompt",
      "backlog",
      "default",
      `${PROJECT_APP}/src`,
      10,
      10,
    ]);
    db1.run(`INSERT INTO tasks (id, title, prompt, "column", agent, workdir, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`, [
      "task-sibling-002",
      "Sibling App Task",
      "Prompt",
      "backlog",
      "default",
      `${PROJECT_SIBLING}/src`,
      10,
      10,
    ]);
  });

  afterAll(async () => {
    db1.close();
    db2.close();
    await rm(tempDir, { recursive: true, force: true });
  });

  /* ────────────────────────────────────────────────────────────────────────── *
   * INT01-01: Unified Prompt Validation & Multibyte Probes
   * ────────────────────────────────────────────────────────────────────────── */
  describe("INT01-01: Unified Prompt Validation", () => {
    it("accepts prompt at exact 512 KiB limit (524,288 UTF-8 bytes)", () => {
      const exactPrompt = "A".repeat(MAX_PROMPT_BYTES);
      expect(Buffer.byteLength(exactPrompt, "utf-8")).toBe(MAX_PROMPT_BYTES);

      const prop = core1.create(PROJECT_APP, {
        roleSlug: "engineering-frontend-developer",
        justification: "Exact limit test",
        promptMarkdown: exactPrompt,
      });

      expect(prop.id).toBeDefined();
      expect(Buffer.byteLength(prop.promptMarkdown, "utf-8")).toBe(MAX_PROMPT_BYTES);
    });

    it("rejects prompt exceeding 512 KiB by 1 byte with 413 error", () => {
      const overPrompt = "A".repeat(MAX_PROMPT_BYTES + 1);
      expect(Buffer.byteLength(overPrompt, "utf-8")).toBe(MAX_PROMPT_BYTES + 1);

      expect(() =>
        core1.create(PROJECT_APP, {
          roleSlug: "engineering-backend-architect",
          justification: "Over limit test",
          promptMarkdown: overPrompt,
        }),
      ).toThrow(HiringProposalError);

      try {
        core1.create(PROJECT_APP, {
          roleSlug: "engineering-backend-architect",
          justification: "Over limit test",
          promptMarkdown: overPrompt,
        });
      } catch (err: any) {
        expect(err.status).toBe(413);
        expect(err.message).toContain("Prompt exceeds maximum allowed size of 524288 bytes");
      }
    });

    it("measures UTF-8 bytes accurately for multibyte characters (Cyrillic, Emojis)", () => {
      // Cyrillic characters are 2 bytes each in UTF-8
      const cyrillicChar = "Ж";
      expect(cyrillicChar.length).toBe(1); // 1 JS code unit
      expect(Buffer.byteLength(cyrillicChar, "utf-8")).toBe(2); // 2 UTF-8 bytes

      // Create a string where JS length < 512K, but UTF-8 bytes > 512K
      const count = 262_145; // 262,145 code units < 524,288, but 524,290 UTF-8 bytes > 524,288!
      const multibyteOver = cyrillicChar.repeat(count);
      expect(multibyteOver.length).toBeLessThan(MAX_PROMPT_BYTES);
      expect(Buffer.byteLength(multibyteOver, "utf-8")).toBeGreaterThan(MAX_PROMPT_BYTES);

      expect(() =>
        core1.create(PROJECT_APP, {
          roleSlug: "marketing-growth-hacker",
          justification: "Multibyte test",
          promptMarkdown: multibyteOver,
        }),
      ).toThrow(HiringProposalError);
    });

    it("rejects prompt over 512 KiB on approval", () => {
      const prop = core1.create(PROJECT_APP, {
        roleSlug: "testing-reality-checker",
        justification: "Approval limit test",
      });

      const hugePrompt = "X".repeat(MAX_PROMPT_BYTES + 10);
      expect(() =>
        core1.approve(prop.id, {
          expectedRevision: 1,
          promptMarkdown: hugePrompt,
        }),
      ).toThrow(HiringProposalError);
    });
  });

  /* ────────────────────────────────────────────────────────────────────────── *
   * INT01-02: SQLite Concurrency & Deduplication Between Two Connections
   * ────────────────────────────────────────────────────────────────────────── */
  describe("INT01-02: Two-Connection Concurrency & Deduplication", () => {
    it("migration 089 index prevents inserting concurrent pending proposals for same project and role", () => {
      // Connection 1 creates pending proposal for devops
      const prop1 = core1.create(PROJECT_APP, {
        roleSlug: "engineering-devops-automator",
        justification: "First proposal for devops",
      });
      expect(prop1.id).toBeDefined();

      // Connection 2 attempts to insert a second pending proposal directly
      expect(() => {
        db2.run(
          `INSERT INTO hiring_proposals (
            id, project_path, catalog_role_slug, template_sha256, proposed_name, professional_title,
            prompt_markdown, justification, competencies, related_tasks, proposed_by_kind, status, revision, created_at, updated_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          [
            "prop-concurrent-002",
            PROJECT_APP,
            "engineering-devops-automator",
            "a".repeat(64),
            "Devops 2",
            "DevOps Automator",
            "prompt",
            "Second proposal",
            "[]",
            "[]",
            "owner",
            "pending",
            1,
            Date.now(),
            Date.now(),
          ],
        );
      }).toThrow(/UNIQUE constraint failed/);
    });

    it("two concurrent connections approving same project + role serializes and rejects duplicate", () => {
      // Simulate legacy or pre-existing duplicate proposals by temporarily bypassing partial index
      db1.run(`DROP INDEX IF EXISTS idx_hiring_proposals_pending_role`);

      const roleSha = catalog.getRole("engineering-backend-architect").sha256;
      const propAId = randomUUID();
      const propBId = randomUUID();
      const now = Date.now();

      db1.run(
        `INSERT INTO hiring_proposals (
          id, project_path, catalog_role_slug, template_sha256, proposed_name, professional_title,
          prompt_markdown, justification, competencies, related_tasks, proposed_by_kind, status, revision, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          propAId,
          PROJECT_APP,
          "engineering-backend-architect",
          roleSha,
          "Architect 1",
          "Backend Architect",
          "prompt 1",
          "First architect proposal",
          "[]",
          "[]",
          "owner",
          "pending",
          1,
          now,
          now,
        ],
      );

      db2.run(
        `INSERT INTO hiring_proposals (
          id, project_path, catalog_role_slug, template_sha256, proposed_name, professional_title,
          prompt_markdown, justification, competencies, related_tasks, proposed_by_kind, status, revision, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          propBId,
          PROJECT_APP,
          "engineering-backend-architect",
          roleSha,
          "Architect 2",
          "Backend Architect",
          "prompt 2",
          "Second architect proposal",
          "[]",
          "[]",
          "owner",
          "pending",
          1,
          now + 1,
          now + 1,
        ],
      );

      // Connection 1 approves propA
      const approval1 = core1.approve(propAId, { expectedRevision: 1 });
      expect(approval1.proposal.status).toBe("approved");
      expect(approval1.employee.id).toBeDefined();

      // Connection 2 now attempts to approve propB for the SAME project + role
      // In-transaction duplicate employee check MUST detect connection 1's employee and throw 409
      expect(() => core2.approve(propBId, { expectedRevision: 1 })).toThrow(HiringProposalError);

      try {
        core2.approve(propBId, { expectedRevision: 1 });
      } catch (err: any) {
        expect(err.status).toBe(409);
        expect(err.message).toContain("is already hired in this project");
      }

      // Verify ai_employees has exactly ONE employee for engineering-backend-architect
      const employees = db1
        .query(
          `SELECT e.* FROM ai_employees e
           JOIN ai_employee_professional_profiles p ON p.employee_id = e.id
           WHERE e.project_path = ? AND p.catalog_role_slug = 'engineering-backend-architect'`,
        )
        .all(PROJECT_APP);

      expect(employees.length).toBe(1);

      // Clean up propB and restore partial index
      db1.run(`DELETE FROM hiring_proposals WHERE id = ?`, [propBId]);
      db1.run(
        `CREATE UNIQUE INDEX IF NOT EXISTS idx_hiring_proposals_pending_role
         ON hiring_proposals (project_path, catalog_role_slug)
         WHERE status = 'pending'`,
      );
    });

    it("PM replay idempotency returns existing proposals and prevents duplicates", () => {
      const messageId = "pm-msg-idempotent-001";
      const drafts = [
        {
          roleSlug: "testing-evidence-collector",
          justification: "Collect testing evidence",
        },
      ];

      // Turn 1
      const res1 = core1.createFromManager(PROJECT_APP, drafts, { messageId });
      expect(res1.created.length).toBe(1);
      expect(res1.dropped.length).toBe(0);
      const firstId = res1.created[0]!.id;

      // Turn 2 replay with identical messageId
      const res2 = core2.createFromManager(PROJECT_APP, drafts, { messageId });
      expect(res2.created.length).toBe(1);
      expect(res2.created[0]!.id).toBe(firstId);
      expect(res2.dropped.length).toBe(0);

      // Verify only 1 row in DB
      const count = db1
        .query<{ n: number }, [string, string]>(
          `SELECT COUNT(*) AS n FROM hiring_proposals WHERE project_path = ? AND source_message_id = ?`,
        )
        .get(PROJECT_APP, messageId)?.n;

      expect(count).toBe(1);
    });

    it("injected transaction failure rolls back cleanly without orphan employee", () => {
      const prop = core1.create(PROJECT_APP, {
        roleSlug: "support-infrastructure-maintainer",
        justification: "Rollback probe",
      });

      const empCountBefore = db1.query<{ n: number }, []>(`SELECT COUNT(*) AS n FROM ai_employees`).get()?.n ?? 0;

      // Fail by exceeding prompt size limit on approval
      expect(() =>
        core1.approve(prop.id, {
          expectedRevision: 1,
          promptMarkdown: "X".repeat(MAX_PROMPT_BYTES + 100),
        }),
      ).toThrow(HiringProposalError);

      const empCountAfter = db1.query<{ n: number }, []>(`SELECT COUNT(*) AS n FROM ai_employees`).get()?.n ?? 0;
      expect(empCountAfter).toBe(empCountBefore);

      // Proposal remains pending
      expect(core1.get(prop.id)?.status).toBe("pending");
    });

    it("file-backed SQLite database persists across close and reopen", () => {
      // Close existing connections
      db1.close();
      db2.close();

      // Reopen fresh connection to the same file
      const reopenedDb = new Database(dbPath);
      const reopenedCore = new HiringProposalCore(reopenedDb, { catalog });

      const list = reopenedCore.list({ projectPath: PROJECT_APP });
      expect(list.proposals.length).toBeGreaterThan(0);

      reopenedDb.close();

      // Re-init db1 and db2 for subsequent tests
      db1 = new Database(dbPath);
      db2 = new Database(dbPath);
      core1 = new HiringProposalCore(db1, { catalog });
      core2 = new HiringProposalCore(db2, { catalog });
      profileCore1 = new EmployeeProfileCore(db1, { catalog });
    });
  });

  /* ────────────────────────────────────────────────────────────────────────── *
   * INT01-04: Sibling Prefix Collision Scope Probes
   * ────────────────────────────────────────────────────────────────────────── */
  describe("INT01-04: Exact Project/Task Scope & Sibling Prefix Collision", () => {
    it("rejects task reference belonging to sibling project /work/app-other from /work/app", () => {
      // Sibling task is task-sibling-002 in /work/app-other
      expect(() =>
        core1.create(PROJECT_APP, {
          roleSlug: "marketing-social-media-strategist",
          justification: "Cross-project task attempt",
          relatedTasks: ["task-sibling-002"],
        }),
      ).toThrow(HiringProposalError);

      try {
        core1.create(PROJECT_APP, {
          roleSlug: "marketing-social-media-strategist",
          justification: "Cross-project task attempt",
          relatedTasks: ["task-sibling-002"],
        });
      } catch (err: any) {
        expect(err.status).toBe(400);
        expect(err.message).toContain("foreign project");
      }
    });

    it("accepts task reference belonging strictly within project root", () => {
      const prop = core1.create(PROJECT_APP, {
        roleSlug: "marketing-social-media-strategist",
        justification: "Valid same-project task reference",
        relatedTasks: ["task-main-001"],
      });

      expect(prop.id).toBeDefined();
      expect(prop.relatedTasks).toEqual(["task-main-001"]);
    });

    it("rejects ambiguous task reference matching multiple tasks", () => {
      // Seed two tasks with common prefix
      db1.run(`INSERT INTO tasks (id, title, prompt, "column", agent, workdir, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`, [
        "task-dup-01",
        "Dup 1",
        "Prompt",
        "backlog",
        "default",
        `${PROJECT_APP}/src`,
        10,
        10,
      ]);
      db1.run(`INSERT INTO tasks (id, title, prompt, "column", agent, workdir, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`, [
        "task-dup-02",
        "Dup 2",
        "Prompt",
        "backlog",
        "default",
        `${PROJECT_APP}/src`,
        10,
        10,
      ]);

      expect(() =>
        core1.create(PROJECT_APP, {
          roleSlug: "design-brand-guardian",
          justification: "Ambiguous task reference",
          relatedTasks: ["task-dup"],
        }),
      ).toThrow(HiringProposalError);
    });
  });

  /* ────────────────────────────────────────────────────────────────────────── *
   * INT01-05: Validation and Revision Contract
   * ────────────────────────────────────────────────────────────────────────── */
  describe("INT01-05: Validation and Revision Contract", () => {
    it("rejects invalid types on optional fields with 400", () => {
      expect(() =>
        core1.create(PROJECT_APP, {
          roleSlug: "support-legal-compliance-checker",
          justification: "Bad type test",
          promptMarkdown: 42 as any,
        }),
      ).toThrow(HiringProposalError);

      expect(() =>
        core1.create(PROJECT_APP, {
          roleSlug: "support-legal-compliance-checker",
          justification: "Bad type test",
          proposedName: 1234 as any,
        }),
      ).toThrow(HiringProposalError);
    });

    it("requires expectedRevision when reassigning existing employee profile", () => {
      // Create employee
      const empId = "emp-reassign-001";
      db1.run(
        `INSERT INTO ai_employees (id, name, name_source, job_title, role_category, specializations, kind, status, project_path, created_at, updated_at)
         VALUES (?, ?, 'generated', 'Worker', 'engineering', '[]', 'worker', 'active', ?, ?, ?)`,
        [empId, "Test Worker", PROJECT_APP, Date.now(), Date.now()],
      );

      // Assign initial profile
      profileCore1.assignRole(empId, {
        catalogRoleSlug: "engineering-frontend-developer",
      });

      // Attempt reassignment WITHOUT expectedRevision
      expect(() =>
        profileCore1.assignRole(empId, {
          catalogRoleSlug: "engineering-backend-architect",
        }),
      ).toThrow(EmployeeProfileError);

      try {
        profileCore1.assignRole(empId, {
          catalogRoleSlug: "engineering-backend-architect",
        });
      } catch (err: any) {
        expect(err.status).toBe(400);
        expect(err.message).toContain("expectedRevision is required when reassigning an existing professional profile");
      }

      // Reassignment WITH stale expectedRevision throws 409
      expect(() =>
        profileCore1.assignRole(empId, {
          catalogRoleSlug: "engineering-backend-architect",
          expectedRevision: 99,
        }),
      ).toThrow(EmployeeProfileError);

      // Reassignment WITH correct expectedRevision succeeds and increments to revision 2
      const updated = profileCore1.assignRole(empId, {
        catalogRoleSlug: "engineering-backend-architect",
        expectedRevision: 1,
      });

      expect(updated.currentRevision).toBe(2);
      expect(updated.catalogRoleSlug).toBe("engineering-backend-architect");
    });

    it("repeat approval with conflicting payload throws 409", () => {
      const prop = core1.create(PROJECT_APP, {
        roleSlug: "support-support-responder",
        justification: "Repeat approval probe",
      });

      // First approval
      core1.approve(prop.id, { expectedRevision: 1 });

      // Second approval with same payload is idempotent 200 (exact replay with expectedRevision = 1)
      const replay = core1.approve(prop.id, { expectedRevision: 1 });
      expect(replay.alreadyApplied).toBe(true);

      // Re-approval with conflicting payload throws 409
      expect(() =>
        core1.approve(prop.id, {
          expectedRevision: 1,
          proposedName: "Completely Different Name",
        }),
      ).toThrow(HiringProposalError);
    });
  });

  /* ────────────────────────────────────────────────────────────────────────── *
   * INT01-03: Four Canonical Runbooks & Fake Responses
   * ────────────────────────────────────────────────────────────────────────── */
  describe("INT01-03: Four Canonical Runbooks Context & Fake Responses", () => {
    const CANONICAL_SLUGS = [
      "startup-mvp",
      "enterprise-feature",
      "marketing-campaign",
      "incident-response",
    ];

    it("returns distinct fake responses for all four canonical runbook scenarios", () => {
      const responses = new Map<string, any>();

      for (const slug of CANONICAL_SLUGS) {
        const prompt = `Project name: Main App\n\n## The owner's message\nPlease recommend a team based on the ${slug} blueprint.`;
        const res = fakeManagerReply(prompt);
        expect(res.code).toBe(0);
        expect(res.assistant).not.toBeNull();

        // Extract JSON inside <hiring_proposals>
        const match = /<hiring_proposals>\n([\s\S]+?)\n<\/hiring_proposals>/.exec(res.assistant!);
        expect(match).not.toBeNull();
        const parsed = JSON.parse(match![1]!);
        expect(parsed.proposals.length).toBeGreaterThanOrEqual(2);

        // Every proposed role slug must be valid in the role catalog
        for (const p of parsed.proposals) {
          const role = catalog.getRole(p.role_slug);
          expect(role.slug).toBe(p.role_slug);
        }

        responses.set(slug, parsed.proposals.map((p: any) => p.role_slug));
      }

      // Verify all 4 responses propose distinct role combinations
      const startup = responses.get("startup-mvp")!;
      const enterprise = responses.get("enterprise-feature")!;
      const marketing = responses.get("marketing-campaign")!;
      const incident = responses.get("incident-response")!;

      expect(startup).not.toEqual(enterprise);
      expect(startup).not.toEqual(marketing);
      expect(startup).not.toEqual(incident);
      expect(enterprise).not.toEqual(marketing);
      expect(enterprise).not.toEqual(incident);
      expect(marketing).not.toEqual(incident);

      // Verify specific characteristic roles
      expect(startup).toContain("engineering-frontend-developer");
      expect(enterprise).toContain("engineering-senior-developer");
      expect(marketing).toContain("marketing-growth-hacker");
      expect(incident).toContain("support-infrastructure-maintainer");
    });

    it("renders runbook context strictly inside untrusted project data block", () => {
      const prompt = buildManagerPrompt({
        context: {
          path: PROJECT_APP,
          name: "Main App",
          description: "Test App",
          stack: "Bun, SQLite",
          signals: [],
          gitBranch: "main",
          documents: [],
          missingDocuments: [],
          counts: { backlog: 1, inbox: 0, ready: 0, running: 0, blocked: 0, review: 0, done: 0 },
          backlog: [],
          backlogOmitted: 0,
          archivedCount: 0,
          running: [],
          blocked: [],
          environment: null,
          runbookScenario: {
            slug: "startup-mvp",
            title: "Startup MVP Build",
            summary: "Idea to live product",
            mode: "NEXUS-Sprint",
            duration: "4-6 weeks",
            groups: [
              {
                group: "Core Team",
                activation: "always",
                agents: [
                  { slug: "engineering-frontend-developer", name: "Frontend Developer", division: "engineering" },
                ],
              },
            ],
            existingTeamCount: 1,
            projectConstraints: ["Max proposals: 10"],
          },
        },
        config: { language: "en", instructions: "" },
        decisions: [],
        history: [],
        message: "Build team for startup-mvp",
        nonce: "test-nonce-123",
      });

      // Context must be inside BEGIN/END project data
      const beginIdx = prompt.indexOf("--- BEGIN project data test-nonce-123 ---");
      const endIdx = prompt.indexOf("--- END project data test-nonce-123 ---");
      const runbookIdx = prompt.indexOf("### Selected runbook scenario");

      expect(beginIdx).toBeGreaterThan(0);
      expect(endIdx).toBeGreaterThan(beginIdx);
      expect(runbookIdx).toBeGreaterThan(beginIdx);
      expect(runbookIdx).toBeLessThan(endIdx);

      // Verify structured fields
      expect(prompt).toContain("Selected runbook: Startup MVP Build");
      expect(prompt).toContain("Canonical slug: startup-mvp");
      expect(prompt).toContain("Mode: NEXUS-Sprint");
      expect(prompt).toContain("Frontend Developer [engineering-frontend-developer]");
    });
  });
});
