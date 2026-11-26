import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { migrate } from "../migrate.ts";
import { migrations } from "../migrations/index.ts";

test("088 follows 087 and leaves 076-087 intact", () => {
  const ids = migrations.map((m) => m.id);
  const at = ids.indexOf("088_employee_hiring_proposals");
  expect(at).toBeGreaterThan(0);
  expect(ids[at - 1]).toBe("087_employee_professional_profiles");
  expect(ids.includes("083_something")).toBe(false); // 083 intentionally missing
});

test("088 fresh, upgrade, rerun, and schema constraints", () => {
  const db = new Database(":memory:");
  try {
    db.run("PRAGMA foreign_keys = ON");
    const at = migrations.findIndex((m) => m.id === "088_employee_hiring_proposals");

    // Apply up to 087
    migrate(db, migrations.slice(0, at));

    // Seed existing employee, profile, and assignments
    db.run(
      `INSERT INTO ai_employees (
        id, kind, name, name_source, job_title, role_category, specializations, status, created_at, updated_at
      ) VALUES ('emp-1', 'worker', 'Ada', 'owner', 'Engineer', 'engineering', '[]', 'active', 10, 10)`,
    );
    db.run(
      `INSERT INTO ai_employee_professional_profiles (
        employee_id, catalog_role_slug, professional_title, division, current_revision, created_at, updated_at
      ) VALUES ('emp-1', 'engineering-frontend-developer', 'Frontend Developer', 'engineering', 1, 10, 10)`,
    );

    const tablesBefore = [
      "ai_employees",
      "ai_employee_professional_profiles",
      "employee_task_assignments",
      "assignment_proposals",
    ];
    const countsBefore = tablesBefore.map((t) => db.query(`SELECT COUNT(*) AS n FROM ${t}`).get());

    // Upgrade to 088
    const applied = migrate(db, migrations.slice(0, at + 1));
    expect(applied).toEqual(["088_employee_hiring_proposals"]);

    // Existing data untouched
    const countsAfter = tablesBefore.map((t) => db.query(`SELECT COUNT(*) AS n FROM ${t}`).get());
    expect(countsAfter).toEqual(countsBefore);

    // New tables exist
    expect(
      db
        .query(
          `SELECT name FROM sqlite_master WHERE type = 'table' AND name IN ('hiring_proposals', 'hiring_proposal_events') ORDER BY name`,
        )
        .all(),
    ).toEqual([
      { name: "hiring_proposal_events" },
      { name: "hiring_proposals" },
    ]);

    // Rerun is idempotent
    expect(migrate(db, migrations.slice(0, at + 1))).toEqual([]);

    // Check schema constraints
    const sha64 = "a".repeat(64);
    db.run(
      `INSERT INTO hiring_proposals (
        id, project_path, proposed_name, kind, professional_title, catalog_role_slug,
        template_sha256, prompt_markdown, justification, competencies, related_tasks,
        proposed_by_kind, proposed_by_employee_id, source_message_id, status, revision,
        created_at, updated_at
      ) VALUES ('prop-1', '/work/proj', 'Alex', 'worker', 'Frontend Dev', 'engineering-frontend-developer',
        '${sha64}', 'Some prompt', 'We need a frontend developer', '[]', '[]',
        'project-manager', 'emp-1', 'msg-1', 'pending', 1, 10, 10)`,
    );

    // Cannot insert pending with decided_at
    expect(() =>
      db.run(
        `INSERT INTO hiring_proposals (
          id, project_path, proposed_name, kind, professional_title, catalog_role_slug,
          template_sha256, prompt_markdown, justification, competencies, related_tasks,
          proposed_by_kind, proposed_by_employee_id, source_message_id, status, revision,
          created_at, updated_at, decided_at
        ) VALUES ('prop-2', '/work/proj', 'Alex', 'worker', 'Frontend Dev', 'engineering-frontend-developer',
          '${sha64}', 'Some prompt', 'Reason', '[]', '[]',
          'project-manager', 'emp-1', 'msg-1', 'pending', 1, 10, 10, 20)`,
      ),
    ).toThrow();

    // Cannot insert approved without created_employee_id
    expect(() =>
      db.run(
        `INSERT INTO hiring_proposals (
          id, project_path, proposed_name, kind, professional_title, catalog_role_slug,
          template_sha256, prompt_markdown, justification, competencies, related_tasks,
          proposed_by_kind, proposed_by_employee_id, source_message_id, status, revision,
          created_at, updated_at, decided_at
        ) VALUES ('prop-3', '/work/proj', 'Alex', 'worker', 'Frontend Dev', 'engineering-frontend-developer',
          '${sha64}', 'Some prompt', 'Reason', '[]', '[]',
          'project-manager', 'emp-1', 'msg-1', 'approved', 2, 10, 20, 20)`,
      ),
    ).toThrow();

    // Events table audit insert
    db.run(
      `INSERT INTO hiring_proposal_events (
        proposal_id, project_path, action, actor, proposal_revision, created_employee_id, note, created_at
      ) VALUES ('prop-1', '/work/proj', 'created', 'project-manager', 1, NULL, 'Proposed by PM', 10)`,
    );
    expect(db.query(`SELECT COUNT(*) AS n FROM hiring_proposal_events`).get()).toEqual({ n: 1 });
  } finally {
    db.close();
  }
});
