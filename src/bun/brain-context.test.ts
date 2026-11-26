import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { BRAIN_CONTEXT_LIMITS } from "../shared/brain/context.ts";
import { BrainContextService } from "./brain-context.ts";
import { openBrainStore, type BrainStore } from "./brain-store.ts";

const ALPHA = "/registry/alpha";
const BETA = "/registry/beta";
const SQL = readFileSync(new URL("./migrations/115_brain_context.sql", import.meta.url), "utf8");

function world() {
  const names = new Map<string, string>([[ALPHA, "Alpha"], [BETA, "Beta"]]);
  const root = mkdtempSync(path.join(tmpdir(), "fo-brain-ctx-"));
  const store = openBrainStore(path.join(root, "brain"), {
    isRegistered: (projectPath) => names.has(projectPath),
  });
  const db = new Database(":memory:");
  db.exec(SQL);
  const service = new BrainContextService(db, store, {
    now: () => 1_700_000_000_000,
    projectName: (projectPath) => names.get(projectPath) ?? null,
    listProjects: () => [...names].map(([projectPath, name]) => ({ path: projectPath, name })),
  });
  return { root, store, db, service, names };
}

function remember(store: BrainStore, scope: "company" | "project", title: string, content: string, projectPath = ALPHA) {
  return store.create({
    scopeKind: scope,
    ...(scope === "project" ? { projectPath } : {}),
    title,
    kind: scope === "company" ? "fact" : "decision",
    content,
  }).memory;
}

async function approve(service: BrainContextService, target: { kind: "project"; projectPath: string } | { kind: "portfolio" }, access: { mode: "company" | "project" | "project-company" | "projects"; projectPaths: string[]; inheritCompany: boolean }, ids: string[]) {
  const preview = service.preview(target, access, ids.map((id) => ({ id })));
  expect(preview.ok).toBe(true);
  if (!preview.ok) throw new Error("preview failed");
  expect(preview.value.canApprove).toBe(true);
  const grant = service.approve(
    target,
    access,
    preview.value.items.map((item) => ({ id: item.id, revision: item.revision, sha256: item.sha256 })),
    preview.value.previewKey,
  );
  expect(grant.ok).toBe(true);
  if (!grant.ok) throw new Error("approve failed");
  expect(grant.value.digest).toBe(preview.value.digest);
  expect(grant.value.preview.items.map((item) => item.content)).toEqual(preview.value.items.map((item) => item.content));
  return { preview: preview.value, grant: grant.value };
}

test("Brain is empty and off until the owner selects a scope", () => {
  const { service } = world();
  const listed = service.eligible({ kind: "project", projectPath: ALPHA }, { mode: "project", projectPaths: [ALPHA], inheritCompany: false }, "");
  expect(listed.ok).toBe(true);
  if (listed.ok) expect(listed.value.memories).toEqual([]);
  const head = service.eligible({ kind: "portfolio" }, { mode: "company", projectPaths: [], inheritCompany: true }, "");
  expect(head.ok).toBe(true);
  if (head.ok) {
    expect(head.value.memories).toEqual([]);
    expect(head.value.availableProjects.map((item) => item.path).sort()).toEqual([ALPHA, BETA]);
  }
});

test("company, project, inheritance, and project isolation", () => {
  const { store, service } = world();
  const company = remember(store, "company", "Company fact", "COMPANY_BODY");
  const alpha = remember(store, "project", "Alpha decision", "ALPHA_BODY", ALPHA);
  const beta = remember(store, "project", "Beta decision", "BETA_BODY", BETA);

  const projectOnly = service.eligible({ kind: "project", projectPath: ALPHA }, { mode: "project", projectPaths: [ALPHA], inheritCompany: false }, "");
  expect(projectOnly.ok && projectOnly.value.memories.map((item) => item.id)).toEqual([alpha.id]);

  const inherited = service.eligible({ kind: "project", projectPath: ALPHA }, { mode: "project-company", projectPaths: [ALPHA], inheritCompany: true }, "");
  expect(inherited.ok && inherited.value.memories.map((item) => item.id).sort()).toEqual([alpha.id, company.id].sort());

  const betaOnly = service.eligible({ kind: "project", projectPath: BETA }, { mode: "project", projectPaths: [BETA], inheritCompany: false }, "");
  expect(betaOnly.ok && betaOnly.value.memories.map((item) => item.id)).toEqual([beta.id]);

  const leaked = service.preview(
    { kind: "project", projectPath: BETA },
    { mode: "project", projectPaths: [BETA], inheritCompany: false },
    [{ id: alpha.id }],
  );
  expect(leaked.ok && leaked.value.canApprove).toBe(false);
  expect(leaked.ok && leaked.value.issues.some((issue) => issue.code === "out-of-scope")).toBe(true);

  const missingInherit = service.preview(
    { kind: "project", projectPath: ALPHA },
    { mode: "project", projectPaths: [ALPHA], inheritCompany: false },
    [{ id: company.id }],
  );
  expect(missingInherit.ok && missingInherit.value.issues.some((issue) => issue.message.includes("company inheritance"))).toBe(true);

  const head = service.preview(
    { kind: "portfolio" },
    { mode: "projects", projectPaths: [ALPHA], inheritCompany: false },
    [{ id: alpha.id }, { id: beta.id }],
  );
  expect(head.ok && head.value.canApprove).toBe(false);
  expect(head.ok && head.value.items.map((item) => item.id)).toEqual([alpha.id]);
  expect(head.ok && head.value.issues.some((issue) => issue.memoryId === beta.id)).toBe(true);
});

test("archived, corrupted, missing, and unregistered memories are refused", () => {
  const { root, store, service, names } = world();
  const archived = remember(store, "project", "Old", "OLD_BODY");
  store.archive(archived.id, archived.revision);
  const live = remember(store, "project", "Live", "LIVE_BODY");
  const corrupt = remember(store, "project", "Corrupt", "ORIGINAL");
  const missing = remember(store, "project", "Missing", "GONE");
  const file = path.join(root, "brain", "memories", `${corrupt.id}.md`);
  writeFileSync(file, readFileSync(file, "utf8").replace("ORIGINAL", "TAMPERED"));
  unlinkSync(path.join(root, "brain", "memories", `${missing.id}.md`));

  const preview = service.preview(
    { kind: "project", projectPath: ALPHA },
    { mode: "project", projectPaths: [ALPHA], inheritCompany: false },
    [{ id: archived.id }, { id: corrupt.id }, { id: missing.id }, { id: live.id }],
  );
  expect(preview.ok).toBe(true);
  if (!preview.ok) return;
  expect(preview.value.canApprove).toBe(false);
  expect(preview.value.items.map((item) => item.id)).toEqual([live.id]);
  expect(preview.value.issues.map((issue) => issue.code).sort()).toEqual(["archived", "integrity", "integrity"]);

  const unknown = service.preview(
    { kind: "project", projectPath: "/registry/missing" },
    { mode: "project", projectPaths: ["/registry/missing"], inheritCompany: false },
    [{ id: live.id }],
  );
  expect(unknown.ok).toBe(false);
  if (!unknown.ok) expect(unknown.status).toBe(404);

  names.delete(BETA);
  const orphan = service.eligible(
    { kind: "portfolio" },
    { mode: "projects", projectPaths: [BETA], inheritCompany: false },
    "",
  );
  expect(orphan.ok).toBe(false);
  if (!orphan.ok) expect(orphan.error).toContain("not registered");
});

test("approval freezes the revision and a later edit blocks the turn", () => {
  const { store, service, db } = world();
  const memory = remember(store, "project", "Layout", "VERSION_ONE");
  const { grant } = awaitApprove(service, memory.id);
  store.update(memory.id, { expectedRevision: memory.revision, content: "VERSION_TWO" });
  const consumed = service.consume({ kind: "project", projectPath: ALPHA }, grant.grantId, "message-1", "turn-1");
  expect(consumed.ok).toBe(false);
  if (!consumed.ok) expect(consumed.error).toContain("Nothing was sent");
  const row = db.query<{ status: string; used: number }, [string]>(`SELECT status, used FROM brain_context_grants WHERE id = ?`).get(grant.grantId);
  expect(row).toEqual({ status: "rejected", used: 0 });
  const again = service.consume({ kind: "project", projectPath: ALPHA }, grant.grantId, "message-2", "turn-2");
  expect(again.ok).toBe(false);
});

function awaitApprove(service: BrainContextService, id: string) {
  const target = { kind: "project" as const, projectPath: ALPHA };
  const access = { mode: "project" as const, projectPaths: [ALPHA], inheritCompany: false };
  const preview = service.preview(target, access, [{ id }]);
  if (!preview.ok || !preview.value.canApprove) throw new Error("expected a preview");
  const grant = service.approve(target, access, preview.value.items.map((item) => ({ id: item.id, revision: item.revision, sha256: item.sha256 })), preview.value.previewKey);
  if (!grant.ok) throw new Error(grant.error);
  return { grant: grant.value, preview: preview.value };
}

test("a grant is one manager, one use, and restart expires what was not sent", () => {
  const { store, service, db } = world();
  const alpha = remember(store, "project", "Alpha", "ALPHA_BODY");
  const beta = remember(store, "project", "Beta", "BETA_BODY", BETA);
  const first = awaitApprove(service, alpha.id);
  const replayTarget = { kind: "project" as const, projectPath: ALPHA };
  const used = service.consume(replayTarget, first.grant.grantId, "m1", "t1");
  expect(used.ok).toBe(true);
  if (used.ok) {
    expect(used.value.digest).toBe(first.preview.digest);
    expect(used.value.memories.map((item) => item.content)).toEqual(["ALPHA_BODY"]);
    service.markUsed(first.grant.grantId);
  }
  expect(service.consume(replayTarget, first.grant.grantId, "m2", "t2").ok).toBe(false);
  const betaGrant = awaitApproveFor(service, beta.id, BETA);
  expect(service.consume(replayTarget, betaGrant.grantId, "m3", "t3").ok).toBe(false);
  expect(service.consume({ kind: "portfolio" }, first.grant.grantId, "m4", "t4").ok).toBe(false);

  const pending = awaitApprove(service, alpha.id);
  expect(service.recover()).toBe(2);
  expect(service.consume(replayTarget, pending.grant.grantId, "m5", "t5").ok).toBe(false);
  const kept = db.query<{ status: string; used: number; digest: string }, []>(
    `SELECT status, used, digest FROM brain_context_grants WHERE message_id = 'm1'`,
  ).get();
  expect(kept?.status).toBe("consumed");
  expect(kept?.used).toBe(1);
  expect(kept?.digest).toBe(first.preview.digest);
});

function awaitApproveFor(service: BrainContextService, id: string, projectPath: string) {
  const target = { kind: "project" as const, projectPath };
  const access = { mode: "project" as const, projectPaths: [projectPath], inheritCompany: false };
  const preview = service.preview(target, access, [{ id }]);
  if (!preview.ok || !preview.value.canApprove) throw new Error("expected a preview");
  const grant = service.approve(target, access, preview.value.items.map((item) => ({ id: item.id, revision: item.revision, sha256: item.sha256 })), preview.value.previewKey);
  if (!grant.ok) throw new Error(grant.error);
  return grant.value;
}

test("character and count limits fail closed", () => {
  const { store, service } = world();
  const big = remember(store, "project", "Big", "x".repeat(BRAIN_CONTEXT_LIMITS.totalChars + 1));
  const refused = service.preview(
    { kind: "project", projectPath: ALPHA },
    { mode: "project", projectPaths: [ALPHA], inheritCompany: false },
    [{ id: big.id }],
  );
  expect(refused.ok && refused.value.canApprove).toBe(false);
  expect(refused.ok && refused.value.issues.some((issue) => issue.code === "too-large")).toBe(true);

  const left = remember(store, "project", "Left", "y".repeat(5_000));
  const right = remember(store, "project", "Right", "z".repeat(4_000));
  const over = service.preview(
    { kind: "project", projectPath: ALPHA },
    { mode: "project", projectPaths: [ALPHA], inheritCompany: false },
    [{ id: left.id }, { id: right.id }],
  );
  expect(over.ok && over.value.canApprove).toBe(false);
  expect(over.ok && over.value.issues.some((issue) => issue.code === "over-budget" && issue.message.includes("nothing is cut"))).toBe(true);
});

test("employee and reviewer prompts are not wired to Brain grants", () => {
  const employee = readFileSync(new URL("./employee-run.ts", import.meta.url), "utf8");
  const reviewer = readFileSync(new URL("../shared/qc-review-prompt.ts", import.meta.url), "utf8");
  expect(employee).not.toContain("loadBrainContext");
  expect(employee).not.toContain("brainGrantId");
  expect(reviewer).not.toContain("renderBrainContextSection");
});
