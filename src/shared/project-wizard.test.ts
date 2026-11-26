import { expect, test } from "bun:test";
import { analyzeProject, expandHomePath, validateFolderName, type ScanFacts } from "./project-discovery.ts";
import {
  docLifecycle,
  effectiveSkips,
  existingDocPaths,
  parseProjectMeta,
  projectMetaKey,
  projectTarget,
  relativeInside,
  reviewChanges,
  reviewRows,
  wizardSaveSteps,
  serializeProjectMeta,
  validateProjectStep,
  withDocPath,
  EMPTY_WIZARD_DRAFT,
  type WizardDraft,
} from "./project-wizard.ts";

function draft(overrides: Partial<WizardDraft> = {}): WizardDraft {
  return {
    mode: "import",
    placement: "existing",
    name: "Orbit",
    description: "",
    directory: "/work/app",
    folderName: "",
    ideaPath: null,
    prdPath: null,
    ideaSkipped: false,
    prdSkipped: false,
    ...overrides,
  };
}

function facts(): ScanFacts {
  return {
    projectPath: "/work/app",
    willCreateDirectory: false,
    empty: true,
    files: new Set(),
    inodes: new Map(),
    rootEntries: [],
    texts: {},
    git: { present: true, branch: "main", toplevel: "/work/app" },
    secretsNoted: [],
    warnings: [],
  };
}

test("project step rejects a missing name, a relative path, and a bad folder name", () => {
  expect(validateProjectStep(draft({ name: "  " }), "/Users/me")).toBe("Project name is required.");
  expect(validateProjectStep(draft({ directory: "app" }), "/Users/me")).toMatch(/full path/);
  expect(validateProjectStep(draft({ directory: "~/app" }), "")).toMatch(/Home directory/);
  expect(validateFolderName("../x")).toMatch(/slash/);
  expect(validateFolderName(".git")).toMatch(/not allowed/);
  expect(validateProjectStep(draft({
    mode: "create",
    placement: "new-folder",
    directory: "/work",
    folderName: "orbit",
  }), "/Users/me")).toBeNull();
});

test("the target path keeps a new folder unsaved until confirm", () => {
  expect(expandHomePath("~/code/app", "/Users/me")).toBe("/Users/me/code/app");
  expect(projectTarget(draft({
    mode: "create",
    placement: "new-folder",
    directory: "/work",
    folderName: "orbit",
  }), "/Users/me")).toBe("/work/orbit");
  expect(projectTarget(draft({ directory: "/work/app/" }), "/Users/me")).toBe("/work/app");
});

test("a picked file has to stay inside the project", () => {
  expect(relativeInside("/work/app", "/work/app/docs/IDEA.md")).toBe("docs/IDEA.md");
  expect(relativeInside("/work/app", "/work/app/../secret.md")).toBeNull();
  expect(relativeInside("/work/app", "/etc/passwd")).toBeNull();
});

test("review promises no file writes and no command runs", () => {
  const discovery = analyzeProject({ ...facts(), willCreateDirectory: true, projectPath: "/work/orbit" });
  const lines = reviewChanges(draft({
    description: "A local orbit",
    ideaPath: "IDEA.md",
  }), discovery);
  expect(lines.some((line) => line.includes("Create the folder /work/orbit"))).toBe(true);
  expect(lines.some((line) => line.includes("untouched"))).toBe(true);
  expect(lines.some((line) => line.includes("Do not create or overwrite IDEA.md"))).toBe(true);
  expect(lines.some((line) => line.includes("Do not run install"))).toBe(true);
  expect(lines).toContain("Do not save a launch profile.");
  expect(lines).toContain("Do not start the project.");
  expect(lines.some((line) => line.startsWith("Start"))).toBe(false);
  const rows = reviewRows(draft({ description: "A local orbit" }), discovery);
  expect(rows.find((row) => row.label === "Environment")?.value).toBe("Not configured");
});

test("review lists accepted interview drafts and still promises no overwrite", () => {
  const discovery = analyzeProject({ ...facts(), willCreateDirectory: true, projectPath: "/work/orbit" });
  const writes = [{ kind: "prd" as const, path: "docs/PRD.md" }];
  const lines = reviewChanges(draft({ ideaPath: "IDEA.md" }), discovery, writes);
  expect(lines).toContain("Create docs/PRD.md from the draft you reviewed. Stop if that file already exists.");
  expect(lines).toContain("Do not overwrite any existing document.");
  expect(lines.some((line) => line.includes("Do not create or overwrite IDEA.md"))).toBe(false);
  const rows = reviewRows(draft({ ideaPath: "IDEA.md" }), discovery, writes);
  expect(rows.find((row) => row.label === "Documentation")?.value).toBe("IDEA: IDEA.md · PRD: docs/PRD.md (new draft)");
  const saved = reviewChanges(draft({ ideaPath: "IDEA.md" }), discovery, writes, {
    state: "ready",
    summary: "Docker Compose · compose.yaml · fo-00000000 · web",
  });
  expect(saved).toContain("Save the launch profile: Docker Compose · compose.yaml · fo-00000000 · web.");
  expect(saved).toContain("Do not start the project.");
  expect(saved.some((line) => line.startsWith("Start"))).toBe(false);
});

test("a retry registers once, then only the steps that are still pending", () => {
  expect(wizardSaveSteps({ registered: false, documentsPending: true, profilePending: true })).toEqual([
    "register",
    "documents",
    "profile",
  ]);
  expect(wizardSaveSteps({ registered: true, documentsPending: true, profilePending: true })).toEqual([
    "documents",
    "profile",
  ]);
  expect(wizardSaveSteps({ registered: true, documentsPending: false, profilePending: true })).toEqual(["profile"]);
  expect(wizardSaveSteps({ registered: true, documentsPending: false, profilePending: false })).toEqual([]);
});

test("project meta round-trips and drops unsafe document paths", () => {
  const key = projectMetaKey("/work/app");
  expect(key.includes("/")).toBe(false);
  const raw = serializeProjectMeta({ description: "Hello", idea: "docs/IDEA.md", prd: "../secret.md" });
  expect(raw).not.toBeNull();
  const parsed = parseProjectMeta(raw);
  expect(parsed.description).toBe("Hello");
  expect(parsed.idea).toBe("docs/IDEA.md");
  expect(parsed.prd).toBeNull();
  expect(serializeProjectMeta({})).toBeNull();
  expect(parseProjectMeta("not json")).toEqual({});
});

test("the default wizard draft skips nothing, so the standard flow is unchanged", () => {
  expect(EMPTY_WIZARD_DRAFT.ideaSkipped).toBe(false);
  expect(EMPTY_WIZARD_DRAFT.prdSkipped).toBe(false);
  const discovery = analyzeProject({ ...facts(), projectPath: "/work/app" });
  expect(effectiveSkips(draft(), discovery)).toEqual({ idea: false, prd: false });
  const lines = reviewChanges(draft(), discovery);
  expect(lines).toContain("Do not create or overwrite IDEA.md or PRD.md.");
  expect(lines.some((line) => line.includes("skipped"))).toBe(false);
  const rows = reviewRows(draft(), discovery);
  expect(rows.find((row) => row.label === "Documentation")?.value).toBe("IDEA: missing · PRD: missing");
});

test("review says what was skipped and promises nothing is created", () => {
  const discovery = analyzeProject({ ...facts(), projectPath: "/work/app" });
  const both = reviewChanges(draft({ ideaSkipped: true, prdSkipped: true }), discovery);
  expect(both).toContain("Do not create or overwrite IDEA.md or PRD.md.");
  expect(both).toContain("IDEA and PRD are skipped. You can create them later from the project workspace.");
  expect(both.some((line) => line.startsWith("Create docs/"))).toBe(false);
  const idea = reviewChanges(draft({ ideaSkipped: true }), discovery);
  expect(idea).toContain("IDEA is skipped. You can create it later from the project workspace.");
  const rows = reviewRows(draft({ ideaSkipped: true }), discovery);
  expect(rows.find((row) => row.label === "Documentation")?.value).toBe("IDEA: skipped · PRD: missing");
  const prd = reviewRows(draft({ ideaSkipped: true, prdSkipped: true }), discovery);
  expect(prd.find((row) => row.label === "Documentation")?.value).toBe("IDEA: skipped · PRD: skipped");
});

test("skip and a drafted PRD together: the PRD is created, the IDEA is only skipped", () => {
  const discovery = analyzeProject({ ...facts(), projectPath: "/work/app" });
  const writes = [{ kind: "prd" as const, path: "docs/PRD.md" }];
  const lines = reviewChanges(draft({ ideaSkipped: true }), discovery, writes);
  expect(lines).toContain("Create docs/PRD.md from the draft you reviewed. Stop if that file already exists.");
  expect(lines).toContain("IDEA is skipped. You can create it later from the project workspace.");
  const rows = reviewRows(draft({ ideaSkipped: true }), discovery, writes);
  expect(rows.find((row) => row.label === "Documentation")?.value).toBe("IDEA: skipped · PRD: docs/PRD.md (new draft)");
});

test("a skip is ignored for a document that exists or was picked", () => {
  const discovery = analyzeProject({ ...facts(), projectPath: "/work/app" });
  expect(effectiveSkips(draft({ ideaSkipped: true, ideaPath: "docs/IDEA.md" }), discovery).idea).toBe(false);
  const withFiles = analyzeProject({ ...facts(), files: new Set(["docs/PRD.md"]), projectPath: "/work/app" });
  expect(effectiveSkips(draft({ prdSkipped: true }), withFiles).prd).toBe(false);
});

test("document lifecycle separates exists, in progress, failed, skipped and not created", () => {
  const base = { existing: null, planned: false, failed: false, skipped: false };
  expect(docLifecycle({ ...base, existing: "docs/IDEA.md" })).toBe("exists");
  expect(docLifecycle({ ...base, existing: "docs/IDEA.md", failed: true })).toBe("exists");
  expect(docLifecycle({ ...base, planned: true })).toBe("planned");
  expect(docLifecycle({ ...base, failed: true, planned: true })).toBe("failed");
  expect(docLifecycle({ ...base, skipped: true })).toBe("skipped");
  expect(docLifecycle(base)).toBe("missing");
});

test("existing documents come from the filesystem first, then a confirmed recorded path", () => {
  const none = { idea: null, prd: null, alternatives: [], state: "none" as const };
  const meta = { idea: "notes/idea.md", prd: "docs/PRD.md" };
  expect(existingDocPaths(none, meta, { idea: false, prd: false })).toEqual({ idea: null, prd: null });
  expect(existingDocPaths(none, meta, { idea: true, prd: false })).toEqual({ idea: "notes/idea.md", prd: null });
  const found = { ...none, prd: { kind: "prd" as const, path: "docs/PRD.md", standard: true }, state: "prd-only" as const };
  expect(existingDocPaths(found, { idea: null, prd: "elsewhere.md" }, { idea: false, prd: true }).prd).toBe("docs/PRD.md");
});

test("recording a created document keeps the description and the other document", () => {
  const meta = withDocPath({ description: "Ops", idea: "docs/IDEA.md" }, "prd", "docs/PRD.md");
  expect(meta).toEqual({ description: "Ops", idea: "docs/IDEA.md", prd: "docs/PRD.md" });
  const parsed = parseProjectMeta(serializeProjectMeta(meta));
  expect(parsed).toEqual({ description: "Ops", idea: "docs/IDEA.md", prd: "docs/PRD.md" });
});
