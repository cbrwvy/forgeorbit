import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { FORGEORBIT_COMPANY } from "../shared/clusters/types.ts";
import { KNOWLEDGE_LIMITS } from "../shared/knowledge/document.ts";
import { KnowledgeCore } from "./knowledge-core.ts";
import { createKnowledgeFiles } from "./knowledge-files.ts";
import { knowledgeHttp } from "./knowledge-http.ts";
import { migrate } from "./migrate.ts";
import { migrations } from "./migrations/index.ts";

function server() {
  const db = new Database(":memory:");
  db.run("PRAGMA foreign_keys = ON");
  migrate(db, migrations);
  const core = new KnowledgeCore(db, createKnowledgeFiles(path.join(mkdtempSync(path.join(tmpdir(), "fo011c-http-")), "knowledge")), { now: () => 9 });
  const call = (pathname: string, init?: RequestInit) => knowledgeHttp(new Request(`http://127.0.0.1${pathname}`, init), true, { core });
  return { db, core, call };
}

test("missing bearer is unauthorized before the body is interpreted", async () => {
  const { call } = server();
  void call;
  const response = await knowledgeHttp(new Request("http://127.0.0.1/knowledge/documents", {
    method: "POST",
    body: "{",
  }), false);
  expect(response.status).toBe(401);
  expect(await response.json()).toEqual({ error: "unauthorized" });
});

test("create, read, update, archive, export, and the documented error statuses", async () => {
  const { db, call } = server();
  db.run(`INSERT INTO projects (path, name, added_at) VALUES ('/registry/alpha', 'Alpha', 1)`);
  db.run(`INSERT INTO projects (path, name, added_at) VALUES ('/registry/beta', 'Beta', 1)`);
  const created = await call("/knowledge/documents", {
    method: "POST",
    body: JSON.stringify({
      ownerKind: "project",
      ownerId: "/registry/alpha",
      title: "Alpha note",
      content: "alpha-body",
      tags: ["product"],
      category: "product",
    }),
  });
  expect(created.status).toBe(201);
  const document = await created.json() as { id: string; revision: number };
  expect(document.revision).toBe(1);

  const denied = await call("/knowledge/documents", {
    method: "POST",
    body: JSON.stringify({ ownerKind: "project", ownerId: "/registry/alpha", title: "Nope", path: "/tmp/x.md" }),
  });
  expect(denied.status).toBe(400);

  const traversal = await call("/knowledge/documents/..%2F..%2Fetc%2Fpasswd");
  expect(traversal.status).toBe(400);

  const missing = await call("/knowledge/documents/aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee");
  expect(missing.status).toBe(404);

  const unknownProject = await call("/knowledge/documents", {
    method: "POST",
    body: JSON.stringify({ ownerKind: "project", ownerId: "/registry/missing", title: "Nope" }),
  });
  expect(unknownProject.status).toBe(404);

  const oversized = await call("/knowledge/documents", {
    method: "POST",
    body: JSON.stringify({
      ownerKind: "company",
      ownerId: FORGEORBIT_COMPANY.id,
      title: "Big",
      content: "a".repeat(KNOWLEDGE_LIMITS.contentBytes + 1),
    }),
  });
  expect(oversized.status).toBe(413);

  const stale = await call(`/knowledge/documents/${document.id}`, {
    method: "PATCH",
    body: JSON.stringify({ expectedRevision: 9, content: "nope" }),
  });
  expect(stale.status).toBe(409);

  const renamed = await call(`/knowledge/documents/${document.id}`, {
    method: "PATCH",
    body: JSON.stringify({ expectedRevision: 1, title: "Alpha renamed" }),
  });
  expect(renamed.status).toBe(200);

  const exported = await call(`/knowledge/documents/${document.id}/export?format=markdown`);
  expect(exported.status).toBe(200);
  expect(exported.headers.get("content-type")).toContain("text/markdown");
  expect(exported.headers.get("content-security-policy")).toContain("default-src 'none'");
  expect(await exported.text()).toBe("alpha-body");
  const historical = await call(`/knowledge/documents/${document.id}/export?revision=1`);
  expect(await historical.json()).toMatchObject({ revision: 1, markdown: "alpha-body" });
  expect(exported.headers.get("content-disposition")).toStartWith("attachment;");
  expect(exported.headers.get("x-content-type-options")).toBe("nosniff");
  expect(exported.headers.get("cache-control")).toBe("no-store");

  const other = await call("/knowledge/search?q=alpha-body&projectPath=/registry/beta");
  expect(other.status).toBe(200);
  expect(await other.json()).toEqual({ hits: [], truncated: false });

  const archived = await call(`/knowledge/documents/${document.id}/archive`, {
    method: "POST",
    body: JSON.stringify({ expectedRevision: 2 }),
  });
  expect(archived.status).toBe(200);
  const removed = await call(`/knowledge/documents/${document.id}`, {
    method: "DELETE",
    body: JSON.stringify({ expectedRevision: 2, confirm: "delete" }),
  });
  expect(removed.status).toBe(200);
  expect(db.query(`SELECT path FROM projects`).all()).toEqual([
    { path: "/registry/alpha" },
    { path: "/registry/beta" },
  ]);
});

test("streaming body limits, result limits, immutable ownership and storage errors fail closed", async () => {
  const { call, core } = server();
  const streamed = new Request("http://127.0.0.1/knowledge/documents", {
    method: "POST",
    body: new ReadableStream({
      start(controller) {
        controller.enqueue(new Uint8Array(KNOWLEDGE_LIMITS.bodyBytes));
        controller.enqueue(new Uint8Array(1));
        controller.close();
      },
    }),
    duplex: "half",
  } as RequestInit);
  const oversized = await knowledgeHttp(streamed, true, { core });
  expect(oversized.status).toBe(413);
  expect(await oversized.json()).toEqual({ error: "Body too large." });
  const created = await call("/knowledge/documents", {
    method: "POST", body: JSON.stringify({ ownerKind: "company", ownerId: FORGEORBIT_COMPANY.id, title: "Owned" }),
  });
  const { id } = await created.json() as { id: string };
  expect((await call(`/knowledge/documents/${id}`, {
    method: "PATCH", body: JSON.stringify({ expectedRevision: 1, ownerKind: "project", ownerId: "/registry/another" }),
  })).status).toBe(400);
  for (const route of [
    "/knowledge/documents?ownerKind=company&ownerId=company:forgeorbit&limit=201",
    "/knowledge/search?q=note&ownerKind=company&ownerId=company:forgeorbit&limit=51",
    "/knowledge/search?q=note&projectPath=/registry/app&ownerKind=company&ownerId=company:forgeorbit",
  ]) expect((await call(route)).status).toBe(400);
  const broken = Object.create(core) as KnowledgeCore;
  broken.scope = () => { throw new Error("EACCES /private/user/secret-marker.md"); };
  const error = await knowledgeHttp(new Request("http://127.0.0.1/knowledge/scope?projectPath=/registry/app"), true, { core: broken });
  expect(error.status).toBe(500);
  expect(await error.json()).toEqual({ error: "Knowledge operation failed." });
});
