import { afterAll, beforeAll, expect, spyOn, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { FORGEORBIT_COMPANY } from "../shared/clusters/types.ts";
import { KNOWLEDGE_CONTEXT_LIMITS, type KnowledgeContextTarget } from "../shared/knowledge/context.ts";
import type { KnowledgeCreateInput, KnowledgeOwnerRef } from "../shared/knowledge/document.ts";
import { ClusterCore } from "./cluster-core.ts";
import { KnowledgeContextService, type ContextResult } from "./knowledge-context.ts";
import { KnowledgeCore } from "./knowledge-core.ts";
import { createKnowledgeFiles } from "./knowledge-files.ts";
import { migrate } from "./migrate.ts";
import { migrations } from "./migrations/index.ts";

/**
 * FO-011E resolver: scope, eligibility, revision safety, one-turn grants.
 * In-memory/temporary SQLite and temp files only. Any spawned process or
 * outbound request fails the test.
 */

let spawn: ReturnType<typeof spyOn>;
let fetchGuard: ReturnType<typeof spyOn>;
beforeAll(() => {
  spawn = spyOn(Bun, "spawn").mockImplementation(() => { throw new Error("Unexpected process"); });
  fetchGuard = spyOn(globalThis, "fetch").mockImplementation((() => { throw new Error("Unexpected request"); }) as unknown as typeof fetch);
});
afterAll(() => {
  spawn.mockRestore();
  fetchGuard.mockRestore();
});

const COMPANY: KnowledgeOwnerRef = { kind: "company", id: FORGEORBIT_COMPANY.id };

function note(owner: KnowledgeOwnerRef, title: string, content: string, extra: Partial<KnowledgeCreateInput> = {}): KnowledgeCreateInput {
  return { owner, title, description: "", category: "general", tags: [], content, sensitive: false, ...extra };
}

function setup(dbFile?: string, root = mkdtempSync(path.join(tmpdir(), "fo011e-"))) {
  const db = new Database(dbFile ?? ":memory:");
  db.run("PRAGMA foreign_keys = ON");
  migrate(db, migrations);
  let clock = 1_700_000_000_000;
  const files = createKnowledgeFiles(path.join(root, "knowledge"));
  const core = new KnowledgeCore(db, files, { now: () => clock });
  const clusters = new ClusterCore(db, { now: () => clock, pathExists: () => false, realpath: () => null });
  const service = new KnowledgeContextService(db, core, {
    now: () => clock,
    resolveProject: (raw) => {
      const row = db.query<{ path: string }, [string]>(`SELECT path FROM projects WHERE path = ?`).get(raw);
      return row ? { ok: true, path: row.path } : { ok: false, status: 404, error: "project is not registered" };
    },
  });
  const project = (p: string, name: string) => db.run(`INSERT INTO projects (path, name, added_at) VALUES (?, ?, 1)`, [p, name]);
  return {
    db, core, clusters, service, root, files, project,
    advance: (ms: number) => { clock += ms; },
    grants: () => db.query<{ status: string }, []>(`SELECT status FROM knowledge_context_grants ORDER BY created_at, id`).all().map((row) => row.status),
  };
}

type Setup = ReturnType<typeof setup>;
const P = (projectPath: string): KnowledgeContextTarget => ({ kind: "project", projectPath });
const PORTFOLIO: KnowledgeContextTarget = { kind: "portfolio" };

function ok<T>(result: ContextResult<T>): T {
  if (!result.ok) throw new Error(`expected ok, got ${result.status} ${result.error} ${JSON.stringify(result.issues ?? [])}`);
  return result.value;
}

function titles(result: ContextResult<{ documents: Array<{ document: { title: string } }> }>): string[] {
  return ok(result).documents.map((entry) => entry.document.title);
}

/** Preview then approve, the way the owner does. */
function confirm(s: Setup, target: KnowledgeContextTarget, ids: Array<string | { id: string; purpose: string }>) {
  const selections = ids.map((entry) => (typeof entry === "string" ? { id: entry } : entry));
  const preview = ok(s.service.preview(target, selections));
  const grant = ok(s.service.approve(
    target,
    preview.items.map((item) => ({ id: item.id, revision: item.revision, sha256: item.sha256, ...(item.purpose ? { purpose: item.purpose } : {}) })),
    preview.previewKey,
  ));
  return { preview, grant };
}

function world() {
  const s = setup();
  s.project("/registry/alpha", "Alpha");
  s.project("/registry/beta", "Beta");
  s.project("/registry/free", "Free");
  const lunar = s.clusters.create({ name: "Lunarian Forge" });
  const other = s.clusters.create({ name: "Other Cluster" });
  s.clusters.assign(lunar.id, "/registry/alpha");
  s.clusters.assign(other.id, "/registry/beta");
  const docs = {
    company: s.core.create(note(COMPANY, "Company conventions", "company body")),
    lunar: s.core.create(note({ kind: "cluster", id: lunar.id }, "Lunar architecture", "lunar body")),
    other: s.core.create(note({ kind: "cluster", id: other.id }, "Other architecture", "other-cluster body")),
    alpha: s.core.create(note({ kind: "project", id: "/registry/alpha" }, "Alpha decisions", "alpha body")),
    beta: s.core.create(note({ kind: "project", id: "/registry/beta" }, "Beta decisions", "beta body")),
    free: s.core.create(note({ kind: "project", id: "/registry/free" }, "Free decisions", "free body")),
  };
  return { s, lunar, other, docs };
}

test("project manager scope is company + current cluster + own project, from the registry", () => {
  const { s } = world();
  expect(titles(s.service.eligible(P("/registry/alpha"))).sort()).toEqual(["Alpha decisions", "Company conventions", "Lunar architecture"]);
  // No cluster: company + project only.
  expect(titles(s.service.eligible(P("/registry/free"))).sort()).toEqual(["Company conventions", "Free decisions"]);
  const levels = ok(s.service.eligible(P("/registry/alpha"))).documents.map((entry) => entry.level);
  expect(levels).toEqual(["company", "cluster", "project"]);
  expect(ok(s.service.eligible(P("/registry/alpha"))).owners).toEqual([]);
});

test("a path that is not a registered project (a git worktree, a typo) has no scope", () => {
  const { s } = world();
  for (const bad of ["/registry/alpha/.worktrees/feature", "/registry/missing", "/registry/alpha/../beta"]) {
    const result = s.service.eligible(P(bad));
    expect(result.ok).toBe(false);
  }
});

test("nested projects do not see each other's notes", () => {
  const s = setup();
  s.project("/registry/parent", "Parent");
  s.project("/registry/parent/child", "Child");
  s.core.create(note({ kind: "project", id: "/registry/parent" }, "Parent note", "parent"));
  s.core.create(note({ kind: "project", id: "/registry/parent/child" }, "Child note", "child"));
  expect(titles(s.service.eligible(P("/registry/parent")))).toEqual(["Parent note"]);
  expect(titles(s.service.eligible(P("/registry/parent/child")))).toEqual(["Child note"]);
});

test("foreign project and foreign cluster notes are refused even when named by id", () => {
  const { s, docs } = world();
  for (const foreign of [docs.beta, docs.other, docs.free]) {
    const preview = ok(s.service.preview(P("/registry/alpha"), [{ id: foreign.id }]));
    expect(preview.canApprove).toBe(false);
    expect(preview.items).toEqual([]);
    expect(preview.issues.map((issue) => issue.code)).toEqual(["out-of-scope"]);
    const approved = s.service.approve(P("/registry/alpha"), [{ id: foreign.id, revision: 1, sha256: "0".repeat(64) }], preview.previewKey);
    expect(approved.ok).toBe(false);
  }
  expect(s.grants()).toEqual([]);
  // Explicit owner browsing outside scope is forbidden for a project manager.
  expect(s.service.eligible(P("/registry/alpha"), { kind: "project", id: "/registry/beta" }).ok).toBe(false);
  expect(s.service.eligible(P("/registry/alpha"), { kind: "cluster", id: "00000000-0000-4000-8000-000000000000" }).ok).toBe(false);
});

test("moving a project to another cluster drops the old cluster at once, even for a confirmed grant", () => {
  const { s, lunar, other, docs } = world();
  const { grant } = confirm(s, P("/registry/alpha"), [docs.lunar.id]);
  s.clusters.move(other.id, "/registry/alpha");
  expect(titles(s.service.eligible(P("/registry/alpha"))).sort()).toEqual(["Alpha decisions", "Company conventions", "Other architecture"]);
  const used = s.service.consume(P("/registry/alpha"), grant.grantId, "m1");
  expect(used.ok).toBe(false);
  expect(s.grants()).toEqual(["rejected"]);
  // The old selection is not valid against the new scope either.
  const stale = s.service.preview(P("/registry/alpha"), [{ id: docs.lunar.id }]);
  expect(ok(stale).issues[0]?.code).toBe("out-of-scope");
  expect(lunar.id).not.toBe(other.id);
});

test("sensitive and archived notes are listed as ineligible and never previewed or granted", () => {
  const { s, docs } = world();
  const secret = s.core.create(note(COMPANY, "Staging access", "internal host list", { sensitive: true }));
  const old = s.core.create(note(COMPANY, "Old notes", "obsolete"));
  s.core.archive(old.id, 1);
  const eligible = ok(s.service.eligible(P("/registry/alpha")));
  const byTitle = new Map(eligible.documents.map((entry) => [entry.document.title, entry]));
  expect(byTitle.get("Staging access")).toMatchObject({ eligible: false, reason: "sensitive" });
  expect(byTitle.has("Old notes")).toBe(false);
  for (const id of [secret.id, old.id]) {
    const preview = ok(s.service.preview(P("/registry/alpha"), [{ id }]));
    expect(preview.canApprove).toBe(false);
    expect(preview.items).toEqual([]);
    expect(JSON.stringify(preview)).not.toContain("internal host list");
  }
  expect(docs.company.id).toBeTruthy();
});

test("marking a note sensitive, archiving it, or deleting it after confirmation voids the grant", () => {
  for (const change of ["sensitive", "archive", "delete", "edit"] as const) {
    const { s, docs } = world();
    const { grant } = confirm(s, P("/registry/alpha"), [docs.company.id, docs.alpha.id]);
    if (change === "sensitive") s.core.update(docs.alpha.id, { expectedRevision: 1, sensitive: true });
    if (change === "archive") s.core.archive(docs.alpha.id, 1);
    if (change === "delete") { s.core.archive(docs.alpha.id, 1); s.core.remove(docs.alpha.id, 1); }
    if (change === "edit") s.core.update(docs.alpha.id, { expectedRevision: 1, content: "changed after the owner looked" });
    const used = s.service.consume(P("/registry/alpha"), grant.grantId, "m1");
    expect(used.ok).toBe(false);
    if (!used.ok) {
      expect(used.status).toBe(409);
      expect(JSON.stringify(used)).not.toContain("changed after the owner looked");
    }
    expect(s.grants()).toEqual(["rejected"]);
  }
});

test("revision and hash mismatches are conflicts; a newer revision is never sent silently", () => {
  const { s, docs } = world();
  const preview = ok(s.service.preview(P("/registry/alpha"), [{ id: docs.alpha.id }]));
  s.core.update(docs.alpha.id, { expectedRevision: 1, content: "second revision" });
  const stale = s.service.approve(
    P("/registry/alpha"),
    preview.items.map((item) => ({ id: item.id, revision: item.revision, sha256: item.sha256 })),
    preview.previewKey,
  );
  expect(stale.ok).toBe(false);
  if (!stale.ok) {
    expect(stale.status).toBe(409);
    expect(stale.issues?.[0]?.code).toBe("stale-revision");
  }
  // Same revision number, wrong hash.
  const current = ok(s.service.preview(P("/registry/alpha"), [{ id: docs.alpha.id }]));
  const wrongHash = s.service.approve(
    P("/registry/alpha"),
    [{ id: docs.alpha.id, revision: current.items[0]!.revision, sha256: "f".repeat(64) }],
    current.previewKey,
  );
  expect(wrongHash.ok).toBe(false);
  if (!wrongHash.ok) expect(wrongHash.issues?.[0]?.code).toBe("stale-hash");
  // A forged preview key is refused too.
  const forged = s.service.approve(
    P("/registry/alpha"),
    current.items.map((item) => ({ id: item.id, revision: item.revision, sha256: item.sha256 })),
    "0".repeat(32),
  );
  expect(forged.ok).toBe(false);
  expect(s.grants()).toEqual([]);
});

test("a note whose stored bytes no longer match the recorded checksum is refused", () => {
  const { s, docs } = world();
  s.db.run(`UPDATE knowledge_documents SET byte_length = byte_length + 1 WHERE id = ?`, [docs.alpha.id]);
  const preview = ok(s.service.preview(P("/registry/alpha"), [{ id: docs.alpha.id }]));
  expect(preview.canApprove).toBe(false);
  expect(preview.issues.length).toBe(1);
});

test("nothing is sent without approval: preview creates no grant, unknown grants are refused", () => {
  const { s, docs } = world();
  ok(s.service.preview(P("/registry/alpha"), [{ id: docs.alpha.id }]));
  expect(s.grants()).toEqual([]);
  for (const id of ["0".repeat(64), "f".repeat(64)]) {
    const used = s.service.consume(P("/registry/alpha"), id, "m1");
    expect(used.ok).toBe(false);
  }
});

test("a grant is single-use: the second message gets nothing and no content", () => {
  const { s, docs } = world();
  const { grant } = confirm(s, P("/registry/alpha"), [docs.company.id]);
  const first = ok(s.service.consume(P("/registry/alpha"), grant.grantId, "m1"));
  expect(first.documents.map((doc) => doc.content)).toEqual(["company body"]);
  const second = s.service.consume(P("/registry/alpha"), grant.grantId, "m2");
  expect(second.ok).toBe(false);
  expect(s.grants()).toEqual(["consumed"]);
});

test("two connections racing for one grant: exactly one wins", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "fo011e-race-"));
  const file = path.join(dir, "race.sqlite");
  const a = setup(file, dir);
  a.project("/registry/alpha", "Alpha");
  const doc = a.core.create(note(COMPANY, "Shared", "shared body"));
  const { grant } = confirm(a, P("/registry/alpha"), [doc.id]);
  const db2 = new Database(file);
  db2.run("PRAGMA busy_timeout = 2000");
  const core2 = new KnowledgeCore(db2, createKnowledgeFiles(path.join(dir, "knowledge")));
  const second = new KnowledgeContextService(db2, core2, {
    resolveProject: () => ({ ok: true, path: "/registry/alpha" }),
  });
  const results = [
    a.service.consume(P("/registry/alpha"), grant.grantId, "m1"),
    second.consume(P("/registry/alpha"), grant.grantId, "m2"),
    a.service.consume(P("/registry/alpha"), grant.grantId, "m3"),
  ];
  expect(results.filter((result) => result.ok)).toHaveLength(1);
  db2.close();
});

test("a new confirmation replaces the previous live one; grants are bound to their manager", () => {
  const { s, docs } = world();
  const first = confirm(s, P("/registry/alpha"), [docs.company.id]).grant;
  const second = confirm(s, P("/registry/alpha"), [docs.alpha.id]).grant;
  expect(s.grants().sort()).toEqual(["approved", "revoked"]);
  expect(s.service.consume(P("/registry/alpha"), first.grantId, "m").ok).toBe(false);
  // Bound to the project: another project's manager and the portfolio can't spend it.
  expect(s.service.consume(P("/registry/free"), second.grantId, "m").ok).toBe(false);
  expect(s.service.consume(PORTFOLIO, second.grantId, "m").ok).toBe(false);
  expect(s.service.consume(P("/registry/alpha"), second.grantId, "m").ok).toBe(true);
});

test("a grant expires, can be revoked, and does not survive a restart", () => {
  const { s, docs } = world();
  const a = confirm(s, P("/registry/alpha"), [docs.company.id]).grant;
  s.advance(KNOWLEDGE_CONTEXT_LIMITS.grantTtlMs + 1);
  expect(s.service.consume(P("/registry/alpha"), a.grantId, "m").ok).toBe(false);
  expect(s.grants()).toEqual(["expired"]);

  const b = confirm(s, P("/registry/alpha"), [docs.company.id]).grant;
  expect(ok(s.service.revoke(P("/registry/alpha"), b.grantId)).revoked).toBe(true);
  expect(s.service.consume(P("/registry/alpha"), b.grantId, "m").ok).toBe(false);

  const c = confirm(s, P("/registry/alpha"), [docs.company.id]).grant;
  expect(s.service.recover()).toBe(1);
  expect(s.service.consume(P("/registry/alpha"), c.grantId, "m").ok).toBe(false);
  expect(s.service.recover()).toBe(0);
});

test("budget: a note over the single limit and a selection over the total are refused, never cut", () => {
  const s = setup();
  s.project("/registry/alpha", "Alpha");
  const big = s.core.create(note(COMPANY, "Huge", "x".repeat(KNOWLEDGE_CONTEXT_LIMITS.documentBytes + 1)));
  const eligible = ok(s.service.eligible(P("/registry/alpha"))).documents.find((entry) => entry.document.id === big.id);
  expect(eligible).toMatchObject({ eligible: false, reason: "too-large" });
  expect(ok(s.service.preview(P("/registry/alpha"), [{ id: big.id }])).issues[0]?.code).toBe("too-large");

  const each = KNOWLEDGE_CONTEXT_LIMITS.documentBytes - 100;
  const ids = [0, 1, 2, 3].map((i) => s.core.create(note(COMPANY, `Part ${i}`, "y".repeat(each))).id);
  const preview = ok(s.service.preview(P("/registry/alpha"), ids.map((id) => ({ id }))));
  expect(preview.totalBytes).toBe(each * 4);
  expect(preview.canApprove).toBe(false);
  expect(preview.issues.map((issue) => issue.code)).toContain("over-budget");
  expect(preview.tokenEstimate).toBeNull();
  expect(preview.tokenNote).toContain("Unknown token estimate");
  // Fewer notes fit.
  expect(ok(s.service.preview(P("/registry/alpha"), ids.slice(0, 2).map((id) => ({ id })))).canApprove).toBe(true);
});

test("preview order is deterministic whatever order the owner clicked", () => {
  const { s, docs } = world();
  const forward = ok(s.service.preview(P("/registry/alpha"), [docs.company, docs.lunar, docs.alpha].map((doc) => ({ id: doc.id }))));
  const backward = ok(s.service.preview(P("/registry/alpha"), [docs.alpha, docs.lunar, docs.company].map((doc) => ({ id: doc.id }))));
  expect(forward.items.map((item) => item.level)).toEqual(["company", "cluster", "project"]);
  expect(backward.previewKey).toBe(forward.previewKey);
});

test("portfolio: company notes by default; other owners only when named, with a purpose; unavailable owners void the choice", () => {
  const { s, docs, lunar } = world();
  expect(titles(s.service.eligible(PORTFOLIO))).toEqual(["Company conventions"]);
  const owners = ok(s.service.eligible(PORTFOLIO)).owners;
  expect(owners.map((item) => item.label)).toContain("Lunarian Forge");
  expect(owners.map((item) => item.label)).toContain("Beta");
  // Naming a cluster lists only that cluster, not its projects.
  expect(titles(s.service.eligible(PORTFOLIO, { kind: "cluster", id: lunar.id }))).toEqual(["Lunar architecture"]);
  // A non-company note needs a purpose.
  const bare = ok(s.service.preview(PORTFOLIO, [{ id: docs.beta.id }]));
  expect(bare.issues[0]?.code).toBe("purpose-required");
  const purposeful = confirm(s, PORTFOLIO, [{ id: docs.beta.id, purpose: "Check Beta's open decisions" }, docs.company.id]);
  expect(purposeful.preview.items.map((item) => item.purpose)).toEqual([null, "Check Beta's open decisions"]);
  // The project leaves the registry: the choice is void.
  s.db.run(`DELETE FROM projects WHERE path = '/registry/beta'`);
  const used = s.service.consume(PORTFOLIO, purposeful.grant.grantId, "m");
  expect(used.ok).toBe(false);
  expect(s.grants()).toEqual(["rejected"]);
  // And a removed project can't be browsed any more.
  expect(s.service.eligible(PORTFOLIO, { kind: "project", id: "/registry/beta" }).ok).toBe(false);
  // Neighbours in the same cluster are not mixed in.
  expect(titles(s.service.eligible(PORTFOLIO, { kind: "project", id: "/registry/alpha" }))).toEqual(["Alpha decisions"]);
});

test("audit keeps metadata only: no Markdown in the grant table or the audit list", () => {
  const { s, docs } = world();
  const { grant } = confirm(s, P("/registry/alpha"), [docs.alpha.id]);
  const used = ok(s.service.consume(P("/registry/alpha"), grant.grantId, "message-1"));
  expect(used.ref).toBe(grant.grantId.slice(0, 8));
  const audit = ok(s.service.transmissions(P("/registry/alpha")));
  expect(audit.transmissions).toHaveLength(1);
  const entry = audit.transmissions[0]!;
  expect(entry).toMatchObject({ status: "consumed", messageId: "message-1", totalBytes: "alpha body".length });
  expect(entry.items[0]).toMatchObject({ id: docs.alpha.id, title: "Alpha decisions", revision: 1 });
  const dump = JSON.stringify(s.db.query(`SELECT * FROM knowledge_context_grants`).all()) + JSON.stringify(audit);
  expect(dump).not.toContain("alpha body");
  // The audit list never exposes the capability itself.
  expect(JSON.stringify(audit)).not.toContain(grant.grantId);
  // Another manager's audit is separate.
  expect(ok(s.service.transmissions(P("/registry/free"))).transmissions).toEqual([]);
});

test("the resolver starts no process and makes no request (guards installed for the whole file)", () => {
  const { s, docs } = world();
  confirm(s, P("/registry/alpha"), [docs.company.id]);
  expect(spawn).not.toHaveBeenCalled();
  expect(fetchGuard).not.toHaveBeenCalled();
});
