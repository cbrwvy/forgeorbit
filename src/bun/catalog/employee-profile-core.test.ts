import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { migrate } from "../migrate.ts";
import { migrations } from "../migrations/index.ts";
import { EmployeeProfileCore, EmployeeProfileError } from "./employee-profile-core.ts";
import { RoleCatalogService } from "./role-catalog.ts";

describe("EmployeeProfileCore", () => {
  let db: Database;
  let catalog: RoleCatalogService;
  let core: EmployeeProfileCore;
  let nowClock = 1000;

  const EMP_UUID = "11111111-2222-3333-4444-555555555555";
  const LEGACY_EMP_UUID = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";

  beforeEach(() => {
    db = new Database(":memory:");
    db.run("PRAGMA foreign_keys = ON");
    migrate(db, migrations);

    catalog = new RoleCatalogService();
    catalog.initialize();

    nowClock = 1000;
    core = new EmployeeProfileCore(db, {
      catalog,
      now: () => ++nowClock,
    });

    // Seed test employees in ai_employees
    db.run(
      `INSERT INTO ai_employees (
        id, kind, name, name_source, job_title, role_category, specializations, status, created_at, updated_at
      ) VALUES (?, 'worker', 'Ada Lovelace', 'owner', 'Software Engineer', 'engineering', '[]', 'active', 500, 500)`,
      [EMP_UUID],
    );

    db.run(
      `INSERT INTO ai_employees (
        id, kind, name, name_source, job_title, role_category, specializations, status, created_at, updated_at
      ) VALUES (?, 'worker', 'Legacy Worker', 'generated', 'Junior Engineer', 'engineering', '[]', 'active', 400, 400)`,
      [LEGACY_EMP_UUID],
    );
  });

  afterEach(() => {
    db.close();
  });

  test("legacy employee without profile returns null", () => {
    const profile = core.getProfile(LEGACY_EMP_UUID);
    expect(profile).toBeNull();
  });

  test("throws 404 for non-existent employee", () => {
    expect(() => core.getProfile("00000000-0000-0000-0000-000000000000")).toThrow(EmployeeProfileError);
  });

  test("assigns a profession from the catalog creating revision 1", () => {
    const profile = core.assignRole(EMP_UUID, {
      catalogRoleSlug: "engineering-backend-architect",
    });

    expect(profile.employeeId).toBe(EMP_UUID);
    expect(profile.catalogRoleSlug).toBe("engineering-backend-architect");
    expect(profile.professionalTitle).toBe("Backend Architect");
    expect(profile.division).toBe("engineering");
    expect(profile.currentRevision).toBe(1);
    expect(profile.activePrompt.revision).toBe(1);
    expect(profile.activePrompt.promptMarkdown).toContain("Backend Architect");
    expect(profile.activePrompt.ownerProvenance).toBe("owner");
    expect(profile.template?.name).toBe("Backend Architect");

    const fetched = core.getProfile(EMP_UUID);
    expect(fetched).not.toBeNull();
    expect(fetched?.currentRevision).toBe(1);
  });

  test("updates prompt instructions incrementing to revision 2", () => {
    core.assignRole(EMP_UUID, {
      catalogRoleSlug: "engineering-backend-architect",
    });

    const updated = core.updatePrompt(EMP_UUID, {
      promptMarkdown: "# Customized Backend Architect\nAlways prioritize safety and clean code.",
      expectedRevision: 1,
      changeNote: "Add safety focus",
    });

    expect(updated.currentRevision).toBe(2);
    expect(updated.activePrompt.revision).toBe(2);
    expect(updated.activePrompt.promptMarkdown).toBe(
      "# Customized Backend Architect\nAlways prioritize safety and clean code.",
    );
    expect(updated.activePrompt.changeNote).toBe("Add safety focus");
  });

  test("rejects stale revision with 409 conflict", () => {
    core.assignRole(EMP_UUID, {
      catalogRoleSlug: "engineering-backend-architect",
    });

    core.updatePrompt(EMP_UUID, {
      promptMarkdown: "First edit",
      expectedRevision: 1,
    });

    // Stale edit with expectedRevision 1 should fail
    expect(() =>
      core.updatePrompt(EMP_UUID, {
        promptMarkdown: "Concurrent edit",
        expectedRevision: 1,
      }),
    ).toThrow(EmployeeProfileError);

    try {
      core.updatePrompt(EMP_UUID, {
        promptMarkdown: "Concurrent edit",
        expectedRevision: 1,
      });
    } catch (err) {
      expect((err as EmployeeProfileError).status).toBe(409);
    }
  });

  test("idempotent save with same prompt text does not create duplicate revision", () => {
    core.assignRole(EMP_UUID, {
      catalogRoleSlug: "engineering-backend-architect",
    });

    const p1 = core.updatePrompt(EMP_UUID, {
      promptMarkdown: "Identical instructions",
      expectedRevision: 1,
    });
    expect(p1.currentRevision).toBe(2);

    // Save exact same content again
    const p2 = core.updatePrompt(EMP_UUID, {
      promptMarkdown: "Identical instructions",
      expectedRevision: 2,
    });
    expect(p2.currentRevision).toBe(2);

    const revs = core.listRevisions(EMP_UUID);
    expect(revs.length).toBe(2);
  });

  test("restores original template creating a new monotonic revision", () => {
    core.assignRole(EMP_UUID, {
      catalogRoleSlug: "engineering-backend-architect",
    });

    core.updatePrompt(EMP_UUID, {
      promptMarkdown: "Custom instructions override",
      expectedRevision: 1,
    });

    const restored = core.resetToTemplate(EMP_UUID, 2);
    expect(restored.currentRevision).toBe(3);
    expect(restored.activePrompt.revision).toBe(3);
    expect(restored.activePrompt.changeNote).toBe("Restored from original catalog template");
    expect(restored.activePrompt.promptMarkdown).toContain("Backend Architect");

    const history = core.listRevisions(EMP_UUID);
    expect(history.length).toBe(3);
    expect(history.map((h) => h.revision)).toEqual([3, 2, 1]);
  });

  test("retrieves full historical revision content", () => {
    core.assignRole(EMP_UUID, {
      catalogRoleSlug: "engineering-backend-architect",
    });

    core.updatePrompt(EMP_UUID, {
      promptMarkdown: "Revision 2 custom instructions",
      expectedRevision: 1,
    });

    const rev1 = core.getRevision(EMP_UUID, 1);
    expect(rev1.revision).toBe(1);
    expect(rev1.promptMarkdown).toContain("Backend Architect");

    const rev2 = core.getRevision(EMP_UUID, 2);
    expect(rev2.revision).toBe(2);
    expect(rev2.promptMarkdown).toBe("Revision 2 custom instructions");
  });

  test("renaming and archiving employee preserves professional profile and revisions", () => {
    core.assignRole(EMP_UUID, {
      catalogRoleSlug: "engineering-backend-architect",
    });

    // Rename employee in ai_employees
    db.run("UPDATE ai_employees SET name = 'Ada King-Noel' WHERE id = ?", [EMP_UUID]);
    const afterRename = core.getProfile(EMP_UUID);
    expect(afterRename?.catalogRoleSlug).toBe("engineering-backend-architect");

    // Archive employee in ai_employees
    db.run("UPDATE ai_employees SET status = 'archived', archived_at = 9999 WHERE id = ?", [EMP_UUID]);
    const afterArchive = core.getProfile(EMP_UUID);
    expect(afterArchive?.catalogRoleSlug).toBe("engineering-backend-architect");
    expect(core.listRevisions(EMP_UUID).length).toBe(1);
  });

  test("rejects invalid role slug and empty prompts", () => {
    expect(() =>
      core.assignRole(EMP_UUID, {
        catalogRoleSlug: "invalid-non-existent-slug",
      }),
    ).toThrow(EmployeeProfileError);

    expect(() =>
      core.assignRole(EMP_UUID, {
        catalogRoleSlug: "engineering-backend-architect",
        promptMarkdown: "   ",
      }),
    ).toThrow(EmployeeProfileError);
  });
});
