import { afterAll, beforeAll, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { FORGEORBIT_COMPANY } from "../shared/clusters/types.ts";
import type { KnowledgeCreateInput, KnowledgeOwnerRef } from "../shared/knowledge/document.ts";
import { ClusterCore } from "./cluster-core.ts";
import { effectiveKnowledgeForProject } from "./knowledge-effective.ts";
import { setDocumentInheritToProjects, setProjectInheritanceSettings } from "./knowledge-inheritance-store.ts";
import { KnowledgeCore } from "./knowledge-core.ts";
import { createKnowledgeFiles } from "./knowledge-files.ts";
import { migrate } from "./migrate.ts";
import { migrations } from "./migrations/index.ts";

const COMPANY: KnowledgeOwnerRef = { kind: "company", id: FORGEORBIT_COMPANY.id };

function note(owner: KnowledgeOwnerRef, title: string, content: string): KnowledgeCreateInput {
  return { owner, title, description: "", category: "general", tags: [], content, sensitive: false };
}

function setup() {
  const db = new Database(":memory:");
  db.run("PRAGMA foreign_keys = ON");
  migrate(db, migrations);
  let clock = 1_700_000_000_000;
  const files = createKnowledgeFiles(mkdtempSync(path.join(tmpdir(), "fo011e-eff-")));
  const core = new KnowledgeCore(db, files, { now: () => clock });
  const clusters = new ClusterCore(db, { now: () => clock, pathExists: () => false, realpath: () => null });
  const project = (p: string, name: string) => db.run(`INSERT INTO projects (path, name, added_at) VALUES (?, ?, 1)`, [p, name]);
  return { db, core, clusters, project, clock: () => clock, advance: (ms: number) => { clock += ms; } };
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
    other: s.core.create(note({ kind: "cluster", id: other.id }, "Other architecture", "other body")),
    alpha: s.core.create(note({ kind: "project", id: "/registry/alpha" }, "Alpha decisions", "alpha body")),
    beta: s.core.create(note({ kind: "project", id: "/registry/beta" }, "Beta decisions", "beta body")),
  };
  return { s, lunar, other, docs };
}

test("defaults inherit nothing until owner enables sharing and project acceptance", () => {
  const { s, docs } = world();
  const preview = effectiveKnowledgeForProject(s.db, s.core, "/registry/alpha")!.preview;
  expect(preview.included.map((line) => line.title)).toEqual(["Alpha decisions"]);
  expect(preview.excluded.some((line) => line.title === "Company conventions" && line.reason === "inheritance-disabled")).toBe(true);
  expect(preview.excluded.some((line) => line.title === "Lunar architecture" && line.reason === "inheritance-disabled")).toBe(true);
  setDocumentInheritToProjects(s.db, docs.company.id, true);
  setProjectInheritanceSettings(s.db, "/registry/alpha", { acceptCompany: true }, Date.now());
  const next = effectiveKnowledgeForProject(s.db, s.core, "/registry/alpha")!.preview;
  expect(next.included.map((line) => line.title).sort()).toEqual(["Alpha decisions", "Company conventions"]);
  expect(next.documents.map((d) => d.content)).toEqual(["company body", "alpha body"]);
  void docs.other;
});

test("cluster A knowledge does not reach cluster B projects", () => {
  const { s, docs, lunar, other } = world();
  setDocumentInheritToProjects(s.db, docs.lunar.id, true);
  setDocumentInheritToProjects(s.db, docs.other.id, true);
  setProjectInheritanceSettings(s.db, "/registry/alpha", { acceptCluster: true }, Date.now());
  setProjectInheritanceSettings(s.db, "/registry/beta", { acceptCluster: true }, Date.now());
  const alpha = effectiveKnowledgeForProject(s.db, s.core, "/registry/alpha")!.preview;
  const beta = effectiveKnowledgeForProject(s.db, s.core, "/registry/beta")!.preview;
  expect(alpha.included.some((line) => line.title === "Lunar architecture")).toBe(true);
  expect(alpha.included.some((line) => line.title === "Other architecture")).toBe(false);
  expect(beta.included.some((line) => line.title === "Other architecture")).toBe(true);
  expect(beta.included.some((line) => line.title === "Lunar architecture")).toBe(false);
  expect(lunar.id).not.toBe(other.id);
});

test("disabling inheritance removes sources from new preview", () => {
  const { s, docs } = world();
  setDocumentInheritToProjects(s.db, docs.company.id, true);
  setProjectInheritanceSettings(s.db, "/registry/alpha", { acceptCompany: true }, Date.now());
  expect(effectiveKnowledgeForProject(s.db, s.core, "/registry/alpha")!.preview.included.length).toBe(2);
  setProjectInheritanceSettings(s.db, "/registry/alpha", { acceptCompany: false }, Date.now());
  const after = effectiveKnowledgeForProject(s.db, s.core, "/registry/alpha")!.preview;
  expect(after.included.map((line) => line.title)).toEqual(["Alpha decisions"]);
});

test("preview matches deterministic ordering", () => {
  const { s, docs } = world();
  setDocumentInheritToProjects(s.db, docs.company.id, true);
  setProjectInheritanceSettings(s.db, "/registry/alpha", { acceptCompany: true }, Date.now());
  const a = effectiveKnowledgeForProject(s.db, s.core, "/registry/alpha")!.preview;
  const b = effectiveKnowledgeForProject(s.db, s.core, "/registry/alpha")!.preview;
  expect(a.version).toBe(b.version);
  expect(a.included.map((line) => line.id)).toEqual(b.included.map((line) => line.id));
});
