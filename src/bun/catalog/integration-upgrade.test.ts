import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { migrate } from "../migrate.ts";
import { migrations as registry } from "../migrations/index.ts";
// Historical 088/089 contracts stay scoped to their registry prefix.
const migrations = registry.filter(m => m.id.slice(0, 3) <= "089");

const through = (version: string) => migrations.filter((m) => m.id.slice(0, 3) <= version && !m.id.startsWith("088a_"));
function healthy(db: Database) {
  expect(db.query("PRAGMA integrity_check").all()).toEqual([{ integrity_check: "ok" }]);
  expect(db.query("PRAGMA foreign_key_check").all()).toEqual([]);
}
function proposal(db: Database, id: string, message: string | null, status = "pending", role = "engineering-frontend-developer") {
  db.run(`INSERT INTO hiring_proposals
    (id, project_path, proposed_name, professional_title, catalog_role_slug, template_sha256,
     prompt_markdown, justification, proposed_by_kind, source_message_id, status, created_at, updated_at, decided_at)
    VALUES (?, '/work/project', 'Ada', 'Developer', ?, ?, 'Original prompt', 'Original reason', 'project-manager', ?, ?, 10, 10, ?)`,
    [id, role, "a".repeat(64), message, status, status === "pending" ? null : 20]);
  db.run(`INSERT INTO hiring_proposal_events
    (proposal_id, project_path, action, actor, proposal_revision, created_at)
    VALUES (?, '/work/project', 'created', 'project-manager', 1, 10)`, [id]);
}
const snapshot = (db: Database) => ["hiring_proposals", "hiring_proposal_events", "ai_employees", "ai_employee_professional_profiles", "ai_employee_profile_revisions"]
  .map((table) => db.query(`SELECT * FROM ${table} ORDER BY rowid`).all());
function seedLegacy(db: Database) {
  db.run(`INSERT INTO ai_employees (id, kind, name, name_source, job_title, role_category, specializations, status, created_at, updated_at)
    VALUES ('original-uuid', 'worker', 'Legacy Ada', 'owner', 'Engineer', 'engineering', '[]', 'active', 1, 1)`);
}

for (const version of ["000", "086", "087", "088"]) {
  test(`FO-INT02: fresh/upgrade from ${version} reaches 089, preserves identity, reopens and reruns`, () => {
    const dir = mkdtempSync(path.join(tmpdir(), "fo-int02-upgrade-"));
    let db = new Database(path.join(dir, "test.sqlite"));
    try {
      db.run("PRAGMA foreign_keys = ON");
      migrate(db, through(version));
      if (version !== "000") seedLegacy(db);
      const applied = migrate(db, migrations);
      expect(applied.at(-1)).toBe("089_hiring_proposal_dedup");
      if (version !== "000") expect(db.query("SELECT id, name FROM ai_employees").all()).toEqual([{ id: "original-uuid", name: "Legacy Ada" }]);
      healthy(db);
      db.close();
      db = new Database(path.join(dir, "test.sqlite"));
      db.run("PRAGMA foreign_keys = ON");
      expect(migrate(db, migrations)).toEqual([]);
      healthy(db);
    } finally { db.close(); rmSync(dir, { recursive: true, force: true }); }
  });
}

test("FO-INT02: populated 088 pending proposals and audit records survive 089 byte-for-byte", () => {
  const db = new Database(":memory:");
  try {
    db.run("PRAGMA foreign_keys = ON");
    migrate(db, through("088"));
    seedLegacy(db);
    db.run(`INSERT INTO ai_employee_professional_profiles
      (employee_id, catalog_role_slug, professional_title, division, current_revision, created_at, updated_at)
      VALUES ('original-uuid', 'engineering-frontend-developer', 'Developer', 'engineering', 1, 1, 1)`);
    db.run(`INSERT INTO ai_employee_profile_revisions
      (id, employee_id, revision, catalog_role_slug, professional_title, division, prompt_markdown, prompt_sha256, created_at)
      VALUES ('original-revision', 'original-uuid', 1, 'engineering-frontend-developer', 'Developer', 'engineering', 'Original customized prompt', ?, 1)`, ["b".repeat(64)]);
    proposal(db, "one", "message-one");
    proposal(db, "two", "message-two", "pending", "engineering-backend-architect");
    const before = snapshot(db);
    expect(migrate(db, migrations)).toEqual(["088a_legacy_hiring_compatibility", "089_hiring_proposal_dedup"]);
    expect(snapshot(db)).toEqual(before);
    expect(migrate(db, migrations)).toEqual([]);
    healthy(db);
  } finally { db.close(); }
});

// Historical failure controls: the registry without 088a must still reproduce
// both original defects. Successful compatibility paths have separate snapshot tests.
for (const duplicate of ["pending-role", "source-message"]) {
  test(`FO-INT02 BLOCKER: legal 088 ${duplicate} duplicates reject 089 without deleting data`, () => {
    const dir = mkdtempSync(path.join(tmpdir(), "fo-int02-duplicate-"));
    const filename = path.join(dir, "test.sqlite");
    let db = new Database(filename);
    try {
      db.run("PRAGMA foreign_keys = ON");
      migrate(db, through("088"));
      seedLegacy(db);
      if (duplicate === "pending-role") {
        proposal(db, "one", "message-one");
        proposal(db, "two", "message-two");
      } else {
        // Non-pending duplicates isolate the second index failure; 088 permits it.
        proposal(db, "one", "same-message", "rejected");
        proposal(db, "two", "same-message", "withdrawn");
      }
      const before = snapshot(db);
      for (let attempt = 0; attempt < 2; attempt++) {
        expect(() => migrate(db, migrations.filter((m) => !m.id.startsWith("088a_")))).toThrow(/UNIQUE constraint failed/);
        expect(snapshot(db)).toEqual(before);
        expect(db.query("SELECT id FROM _migrations WHERE id LIKE '089%'").all()).toEqual([]);
        // If the second index fails, the first must also roll back.
        expect(db.query("SELECT name FROM sqlite_master WHERE name IN ('idx_hiring_proposals_pending_role', 'idx_hiring_proposals_pm_replay')").all()).toEqual([]);
        healthy(db);
        db.close();
        db = new Database(filename);
        db.run("PRAGMA foreign_keys = ON");
      }
      expect(snapshot(db)).toEqual(before);
    } finally { db.close(); rmSync(dir, { recursive: true, force: true }); }
  });
}
