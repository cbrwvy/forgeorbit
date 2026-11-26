import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { migrate } from "./migrate.ts";
import { migrations } from "./migrations/index.ts";
import { openBrainStore } from "./brain-store.ts";

/**
 * Direction 17: a disposable schema-142 profile (core database plus Brain store)
 * upgrades to migration 143 without changing a Brain record. Nothing here is the
 * Owner's profile.
 */
test("a schema-142 profile with Brain records upgrades through 143 and keeps every Brain record", () => {
  const ids = migrations.map((m) => m.id);
  const at = ids.indexOf("143_router_issued_plans");
  expect(at).toBeGreaterThan(0);
  const root = mkdtempSync(path.join(tmpdir(), "fo-d17-mig-"));
  const core = new Database(":memory:");
  try {
    core.run("PRAGMA foreign_keys = ON");
    migrate(core, migrations.slice(0, at));
    expect(core.query(`SELECT name FROM sqlite_master WHERE name = 'router_v2_issued_plans'`).all()).toEqual([]);

    const project = "/Users/qa/d17-upgrade";
    core.run(`INSERT INTO projects (path, name, added_at) VALUES (?, 'Upgrade', 5)`, [project]);
    const store = openBrainStore(path.join(root, "brain"), { isRegistered: (p) => p === project });
    const memory = store.create({ scopeKind: "project", projectPath: project, title: "Upgrade survivor", kind: "decision", content: "Keep WAL on the job queue database." }).memory;
    const edited = store.update(memory.id, { expectedRevision: memory.revision, content: "Keep WAL on the job queue database and set busy_timeout to 2000." });
    store.close();

    const insertCandidate = (id: string, status: string, eventId: string) =>
      core.run(
        `INSERT INTO brain_extraction_candidates (id, status, source_event_kind, source_event_id, source_record_ids_json, scope_kind, scope_id, title, kind, content, confidence, extraction_method, provenance_json, quality_json, related_memory_ids_json, memory_id, created_at, updated_at)
         VALUES (?, ?, 'completed_task', ?, '["t1"]', 'project', ?, 'T', 'fact', 'Some durable content for the candidate', 0.9, 'heuristic', '{}', '{}', '[]', ?, 1, 1)`,
        [id, status, eventId, project, status === "approved" ? memory.id : null],
      );
    insertCandidate("c-pending", "candidate", "e1");
    insertCandidate("c-rejected", "rejected", "e2");
    insertCandidate("c-approved", "approved", "e3");
    core.run(
      `INSERT INTO brain_context_grants (id, manager_kind, project_path, scope_mode, inherit_company, project_scopes_json, status, preview_key, digest, items_json, total_chars, approved_by, created_at, expires_at)
       VALUES (?, 'project', ?, 'project', 0, '[]', 'consumed', 'pk', ?, '[]', 10, 'owner', 1, 2)`,
      ["a".repeat(64), project, "b".repeat(64)],
    );

    const tables = ["projects", "brain_extraction_candidates", "brain_context_grants", "brain_memory_proposals"];
    const before = tables.map((table) => core.query(`SELECT * FROM ${table}`).all());
    const files = (dir: string) =>
      readdirSync(dir, { recursive: true })
        .map(String)
        .filter((f) => f.endsWith(".md"))
        .sort()
        .map((f) => [f, createHash("sha256").update(readFileSync(path.join(dir, f))).digest("hex")]);
    const filesBefore = files(path.join(root, "brain"));
    expect(filesBefore.length).toBeGreaterThan(0);

    expect(migrate(core, migrations)).toEqual(ids.slice(at));
    expect(tables.map((table) => core.query(`SELECT * FROM ${table}`).all())).toEqual(before);
    expect(core.query(`SELECT name FROM sqlite_master WHERE name = 'router_v2_issued_plans'`).all()).toHaveLength(1);
    expect(files(path.join(root, "brain"))).toEqual(filesBefore);

    const reopened = openBrainStore(path.join(root, "brain"), { isRegistered: (p) => p === project });
    const read = reopened.read(memory.id);
    expect(read.revision).toBe(edited.revision);
    expect(read.contentSha256).toBe(edited.contentSha256);
    expect(read.content).toContain("busy_timeout");
    reopened.close();
  } finally {
    core.close();
    rmSync(root, { recursive: true, force: true });
  }
});
