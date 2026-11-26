import { expect, test } from "bun:test";
import { FORGEORBIT_COMPANY } from "../clusters/types.ts";
import {
  KNOWLEDGE_LIMITS,
  knowledgeExportFilename,
  parseKnowledgeCreate,
  parseKnowledgeDelete,
  parseKnowledgeUpdate,
} from "./document.ts";
import { knowledgeImagePolicy, knowledgeLinkPolicy } from "./markdown.ts";

const company = { ownerKind: "company", ownerId: FORGEORBIT_COMPANY.id, title: "Conventions" };

test("company, cluster, and project owners parse, and a folder name is not an owner", () => {
  expect(parseKnowledgeCreate(company).ok).toBe(true);
  const cluster = parseKnowledgeCreate({ ...company, ownerKind: "cluster", ownerId: "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee" });
  expect(cluster.ok && cluster.value.owner).toEqual({ kind: "cluster", id: "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee" });
  const project = parseKnowledgeCreate({ ...company, ownerKind: "project", ownerId: "/registry/alpha" });
  expect(project.ok && project.value.owner).toEqual({ kind: "project", id: "/registry/alpha" });
  expect(parseKnowledgeCreate({ ...company, ownerKind: "project", ownerId: "alpha" }).ok).toBe(false);
  expect(parseKnowledgeCreate({ ...company, ownerKind: "company", ownerId: "other" }).ok).toBe(false);
});

test("the client cannot choose a markdown path, and oversized markdown is rejected", () => {
  const pathAttempt = parseKnowledgeCreate({ ...company, path: "/tmp/note.md" });
  expect(pathAttempt.ok).toBe(false);
  if (!pathAttempt.ok) expect(pathAttempt.error).toContain("path");
  const huge = parseKnowledgeCreate({ ...company, content: "a".repeat(KNOWLEDGE_LIMITS.contentBytes + 1) });
  expect(huge.ok).toBe(false);
  if (!huge.ok) expect(huge.status).toBe(413);
});

test("tags and categories normalize, and a stale revision is required on update", () => {
  const created = parseKnowledgeCreate({ ...company, category: "Infrastructure", tags: ["VPS", "vps", "staging"] });
  expect(created.ok && created.value.category).toBe("infrastructure");
  expect(created.ok && created.value.tags).toEqual(["vps", "staging"]);
  expect(parseKnowledgeUpdate({ title: "Renamed" }).ok).toBe(false);
  const renamed = parseKnowledgeUpdate({ expectedRevision: 2, title: "Renamed" });
  expect(renamed.ok && renamed.value).toEqual({ expectedRevision: 2, title: "Renamed" });
  expect(parseKnowledgeDelete({ expectedRevision: 1, confirm: "archive" }).ok).toBe(false);
  expect(parseKnowledgeDelete({ expectedRevision: 1, confirm: "delete" }).ok).toBe(true);
});

test("markdown links and images stay closed unless they are ordinary web URLs", () => {
  expect(knowledgeLinkPolicy("javascript:alert(1)")).toBe("blocked");
  expect(knowledgeLinkPolicy("file:///etc/passwd")).toBe("blocked");
  expect(knowledgeLinkPolicy("/Users/me/secret.md")).toBe("blocked");
  expect(knowledgeLinkPolicy("https://example.com/docs")).toBe("external");
  expect(knowledgeImagePolicy("file:///tmp/a.png")).toBe("blocked");
  expect(knowledgeImagePolicy("/tmp/a.png")).toBe("blocked");
  expect(knowledgeImagePolicy("https://example.com/a.png")).toBe("remote");
  expect(knowledgeExportFilename("../etc/passwd")).toBe("etc-passwd.md");
});
