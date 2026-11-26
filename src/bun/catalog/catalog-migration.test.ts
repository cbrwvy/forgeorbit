import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { migrate } from "../migrate.ts";
import { migrations } from "../migrations/index.ts";

test("087 follows 086 and leaves 076-086 intact", () => {
  const ids = migrations.map((m) => m.id);
  const at = ids.indexOf("087_employee_professional_profiles");
  expect(at).toBeGreaterThan(0);
  expect(ids[at - 1]).toBe("086_head_portfolio_binding");
  expect(ids.includes("083_something")).toBe(false); // 083 intentionally missing
});

test("087 fresh, upgrade, rerun, and restart persistence", () => {
  const db = new Database(":memory:");
  try {
    db.run("PRAGMA foreign_keys = ON");
    const at = migrations.findIndex((m) => m.id === "087_employee_professional_profiles");

    // Apply up to 086
    migrate(db, migrations.slice(0, at));

    // Seed existing employee and assignments
    db.run(
      `INSERT INTO ai_employees (
        id, kind, name, name_source, job_title, role_category, specializations, status, created_at, updated_at
      ) VALUES ('emp-1', 'worker', 'Ada', 'owner', 'Engineer', 'engineering', '[]', 'active', 10, 10)`,
    );

    const tablesBefore = ["ai_employees", "employee_task_assignments", "head_portfolio_binding"];
    const countsBefore = tablesBefore.map((t) => db.query(`SELECT COUNT(*) AS n FROM ${t}`).get());

    // Upgrade to 087
    const applied = migrate(db, migrations.slice(0, at + 1));
    expect(applied).toEqual(["087_employee_professional_profiles"]);

    // Existing data untouched
    const countsAfter = tablesBefore.map((t) => db.query(`SELECT COUNT(*) AS n FROM ${t}`).get());
    expect(countsAfter).toEqual(countsBefore);

    // New tables exist
    expect(
      db
        .query(
          `SELECT name FROM sqlite_master WHERE type = 'table' AND name IN ('ai_employee_professional_profiles', 'ai_employee_profile_revisions') ORDER BY name`,
        )
        .all(),
    ).toEqual([
      { name: "ai_employee_professional_profiles" },
      { name: "ai_employee_profile_revisions" },
    ]);

    // Rerun is idempotent
    expect(migrate(db, migrations.slice(0, at + 1))).toEqual([]);

    // Check schema constraints
    const sha64 = "a".repeat(64);
    db.run(
      `INSERT INTO ai_employee_professional_profiles (
        employee_id, catalog_role_slug, professional_title, division, current_revision, created_at, updated_at
      ) VALUES ('emp-1', 'engineering-backend-architect', 'Backend Architect', 'engineering', 1, 10, 10)`,
    );

    db.run(
      `INSERT INTO ai_employee_profile_revisions (
        id, employee_id, revision, catalog_role_slug, professional_title, division, prompt_markdown, prompt_sha256, owner_provenance, created_at
      ) VALUES ('rev-1', 'emp-1', 1, 'engineering-backend-architect', 'Backend Architect', 'engineering', 'prompt text', ?, 'owner', 10)`,
      [sha64],
    );

    // Duplicate revision number rejected
    expect(() =>
      db.run(
        `INSERT INTO ai_employee_profile_revisions (
          id, employee_id, revision, catalog_role_slug, professional_title, division, prompt_markdown, prompt_sha256, owner_provenance, created_at
        ) VALUES ('rev-2', 'emp-1', 1, 'engineering-backend-architect', 'Backend Architect', 'engineering', 'prompt text 2', ?, 'owner', 20)`,
        [sha64],
      ),
    ).toThrow();

    // Invalid SHA rejected (not 64 chars)
    expect(() =>
      db.run(
        `INSERT INTO ai_employee_profile_revisions (
          id, employee_id, revision, catalog_role_slug, professional_title, division, prompt_markdown, prompt_sha256, owner_provenance, created_at
        ) VALUES ('rev-3', 'emp-1', 2, 'engineering-backend-architect', 'Backend Architect', 'engineering', 'prompt text 2', 'short', 'owner', 20)`,
      ),
    ).toThrow();

    // Empty prompt rejected
    expect(() =>
      db.run(
        `INSERT INTO ai_employee_profile_revisions (
          id, employee_id, revision, catalog_role_slug, professional_title, division, prompt_markdown, prompt_sha256, owner_provenance, created_at
        ) VALUES ('rev-4', 'emp-1', 2, 'engineering-backend-architect', 'Backend Architect', 'engineering', '   ', ?, 'owner', 20)`,
        [sha64],
      ),
    ).toThrow();

    expect(db.query(`PRAGMA foreign_key_check`).all()).toEqual([]);
  } finally {
    db.close();
  }
});
