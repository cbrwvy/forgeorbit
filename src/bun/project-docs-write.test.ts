import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, renameSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const DATA_DIR = mkdtempSync(path.join(tmpdir(), "fo003-docs-write-"));
process.env.AGETOR_DATA_DIR = DATA_DIR;

let checkDocTargets: typeof import("./project-docs-write.ts").checkDocTargets;
let writeProjectDocs: typeof import("./project-docs-write.ts").writeProjectDocs;
let hooks: typeof import("./project-docs-write.ts").__testing.hooks;
let projects: typeof import("./db.ts").projects;
const cleanup: string[] = [];

beforeAll(async () => {
  const mod = await import("./project-docs-write.ts");
  ({ checkDocTargets, writeProjectDocs } = mod);
  hooks = mod.__testing.hooks;
  ({ projects } = await import("./db.ts"));
});

afterAll(() => {
  for (const dir of cleanup) {
    try {
      chmodSync(dir, 0o755);
    } catch {
      /* gone */
    }
  }
});

function project(name: string, register = true): string {
  const dir = realpathSync(mkdtempSync(path.join(tmpdir(), `fo003-${name}-`)));
  if (register) projects.upsert(dir, name);
  return dir;
}

const IDEA = { kind: "idea", path: "docs/IDEA.md", content: "# Idea\n" };
const PRD = { kind: "prd", path: "docs/PRD.md", content: "# PRD\n" };

describe("checkDocTargets", () => {
  test("a folder that doesn't exist yet reports free targets and creates nothing", () => {
    const parent = project("parent", false);
    const planned = path.join(parent, "new-app");
    const result = checkDocTargets({ projectPath: planned, files: [IDEA, PRD] });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.projectExists).toBe(false);
    expect(result.checks.map((c) => c.state)).toEqual(["free", "free"]);
    expect(existsSync(planned)).toBe(false);
  });

  test("an existing file is reported, not touched", () => {
    const dir = project("exists");
    mkdirSync(path.join(dir, "docs"));
    writeFileSync(path.join(dir, "docs", "IDEA.md"), "mine\n");
    const result = checkDocTargets({ projectPath: dir, files: [IDEA, PRD] });
    expect(result.ok && result.checks.map((c) => c.state)).toEqual(["exists", "free"]);
    expect(existsSync(path.join(dir, "docs", "PRD.md"))).toBe(false);
  });

  test("traversal is rejected before any check", () => {
    const dir = project("traverse");
    const result = checkDocTargets({ projectPath: dir, files: [{ kind: "idea", path: "../IDEA.md" }] });
    expect(result.ok).toBe(false);
    expect(!result.ok && result.status).toBe(400);
  });

  test("a symlinked folder that escapes the project is refused", () => {
    const dir = project("escape");
    const outside = project("outside", false);
    symlinkSync(outside, path.join(dir, "docs"));
    const result = checkDocTargets({ projectPath: dir, files: [IDEA] });
    expect(result.ok && result.checks[0]!.state).toBe("outside");
  });
});

describe("writeProjectDocs", () => {
  test("creates missing docs/ and both files, and verifies them", () => {
    const dir = project("write");
    const result = writeProjectDocs({ projectPath: dir, files: [IDEA, PRD] });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.results.map((r) => r.status)).toEqual(["created", "created"]);
    expect(readFileSync(path.join(dir, "docs", "IDEA.md"), "utf8")).toBe("# Idea\n");
    expect(readFileSync(path.join(dir, "docs", "PRD.md"), "utf8")).toBe("# PRD\n");
    expect(readdirSync(path.join(dir, "docs")).sort()).toEqual(["IDEA.md", "PRD.md"]);
  });

  test("writes a single document at an alternative path", () => {
    const dir = project("alt");
    writeFileSync(path.join(dir, "PRD.md"), "existing prd\n");
    const result = writeProjectDocs({ projectPath: dir, files: [{ kind: "idea", path: "IDEA.md", content: "# Idea\n" }] });
    expect(result.ok && result.results[0]!.status).toBe("created");
    expect(readFileSync(path.join(dir, "PRD.md"), "utf8")).toBe("existing prd\n");
    expect(existsSync(path.join(dir, "docs"))).toBe(false);
  });

  test("never overwrites: an existing target refuses the whole request", () => {
    const dir = project("no-overwrite");
    mkdirSync(path.join(dir, "docs"));
    writeFileSync(path.join(dir, "docs", "PRD.md"), "keep\n");
    const result = writeProjectDocs({ projectPath: dir, files: [IDEA, PRD] });
    expect(result.ok).toBe(false);
    expect(!result.ok && result.status).toBe(409);
    expect(readFileSync(path.join(dir, "docs", "PRD.md"), "utf8")).toBe("keep\n");
    expect(existsSync(path.join(dir, "docs", "IDEA.md"))).toBe(false);
  });

  test("a dangling symlink at the target counts as existing", () => {
    const dir = project("dangling");
    mkdirSync(path.join(dir, "docs"));
    symlinkSync("/nonexistent/target.md", path.join(dir, "docs", "IDEA.md"));
    const result = writeProjectDocs({ projectPath: dir, files: [IDEA] });
    expect(!result.ok && result.status).toBe(409);
  });

  test("a symlink escape is refused and nothing is written outside", () => {
    const dir = project("write-escape");
    const outside = project("write-outside", false);
    symlinkSync(outside, path.join(dir, "docs"));
    const result = writeProjectDocs({ projectPath: dir, files: [IDEA] });
    expect(!result.ok && result.status).toBe(409);
    expect(readdirSync(outside)).toEqual([]);
  });

  test("path traversal is refused", () => {
    const dir = project("write-traverse");
    const result = writeProjectDocs({ projectPath: dir, files: [{ kind: "idea", path: "docs/../../IDEA.md", content: "x" }] });
    expect(!result.ok && result.status).toBe(400);
  });

  test("an unregistered folder is refused", () => {
    const dir = project("unregistered", false);
    const result = writeProjectDocs({ projectPath: dir, files: [IDEA] });
    expect(!result.ok && result.status).toBe(404);
    expect(existsSync(path.join(dir, "docs"))).toBe(false);
  });

  test("one failed document is reported while the other is kept", () => {
    const dir = project("partial");
    mkdirSync(path.join(dir, "locked"));
    chmodSync(path.join(dir, "locked"), 0o555);
    cleanup.push(path.join(dir, "locked"));
    const result = writeProjectDocs({
      projectPath: dir,
      files: [IDEA, { kind: "prd", path: "locked/PRD.md", content: "# PRD\n" }],
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.results[0]).toMatchObject({ kind: "idea", status: "created" });
    expect(result.results[1]).toMatchObject({ kind: "prd", status: "failed" });
    expect(result.results[1]!.error).toContain("locked/PRD.md");
    expect(readFileSync(path.join(dir, "docs", "IDEA.md"), "utf8")).toBe("# Idea\n");
  });

  test("empty content and duplicate paths are refused", () => {
    const dir = project("invalid");
    expect(writeProjectDocs({ projectPath: dir, files: [{ ...IDEA, content: " " }] }).ok).toBe(false);
    expect(writeProjectDocs({ projectPath: dir, files: [IDEA, { ...PRD, path: "docs/IDEA.md" }] }).ok).toBe(false);
  });
});

describe("races and recovery (FO-003.1)", () => {
  afterEach(() => {
    hooks.beforeOpen = undefined;
    hooks.beforeLink = undefined;
  });

  function leftovers(dir: string): string[] {
    return readdirSync(dir).filter((name) => name.endsWith(".tmp"));
  }

  test("a file created at the target during the write is never overwritten, and no temp file stays", () => {
    const dir = project("race-create");
    hooks.beforeLink = (absolute) => writeFileSync(absolute, "someone else\n");
    const result = writeProjectDocs({ projectPath: dir, files: [IDEA] });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.results[0]).toMatchObject({ status: "failed" });
    expect(result.results[0]!.error).toContain("appeared while saving");
    expect(readFileSync(path.join(dir, "docs", "IDEA.md"), "utf8")).toBe("someone else\n");
    expect(leftovers(path.join(dir, "docs"))).toEqual([]);
  });

  test("a parent folder swapped for an outside symlink mid-write leaves nothing outside", () => {
    const dir = project("race-swap");
    const outside = project("race-outside", false);
    mkdirSync(path.join(dir, "docs"));
    hooks.beforeOpen = () => {
      renameSync(path.join(dir, "docs"), path.join(dir, "docs-moved"));
      symlinkSync(outside, path.join(dir, "docs"));
    };
    const result = writeProjectDocs({ projectPath: dir, files: [IDEA] });
    expect(result.ok && result.results[0]!.status).toBe("failed");
    expect(readdirSync(outside)).toEqual([]);
    expect(readdirSync(path.join(dir, "docs-moved"))).toEqual([]);
  });

  test("a failed write removes its temp file", () => {
    const dir = project("tmp-cleanup");
    hooks.beforeLink = () => {
      throw new Error("disk full");
    };
    const result = writeProjectDocs({ projectPath: dir, files: [IDEA] });
    expect(result.ok && result.results[0]!.status).toBe("failed");
    expect(result.ok && result.results[0]!.error).toContain("disk full");
    expect(readdirSync(path.join(dir, "docs"))).toEqual([]);
  });

  test("partial save then retry: only PRD is written and IDEA is untouched", () => {
    const dir = project("retry");
    mkdirSync(path.join(dir, "locked"));
    chmodSync(path.join(dir, "locked"), 0o555);
    cleanup.push(path.join(dir, "locked"));
    const prd = { kind: "prd", path: "locked/PRD.md", content: "# PRD\n" };
    const first = writeProjectDocs({ projectPath: dir, files: [IDEA, prd] });
    expect(first.ok && first.results.map((r) => r.status)).toEqual(["created", "failed"]);
    const ideaPath = path.join(dir, "docs", "IDEA.md");
    const before = statSync(ideaPath);

    // Retrying everything is refused as a whole: IDEA now exists.
    chmodSync(path.join(dir, "locked"), 0o755);
    const again = writeProjectDocs({ projectPath: dir, files: [IDEA, prd] });
    expect(!again.ok && again.status).toBe(409);
    expect(existsSync(path.join(dir, "locked", "PRD.md"))).toBe(false);

    // The wizard retries only what failed.
    const retry = writeProjectDocs({ projectPath: dir, files: [prd] });
    expect(retry.ok && retry.results.map((r) => r.status)).toEqual(["created"]);
    const after = statSync(ideaPath);
    expect(after.ino).toBe(before.ino);
    expect(after.mtimeMs).toBe(before.mtimeMs);
    expect(readFileSync(ideaPath, "utf8")).toBe("# Idea\n");
    expect(readFileSync(path.join(dir, "locked", "PRD.md"), "utf8")).toBe("# PRD\n");
    expect(leftovers(path.join(dir, "locked"))).toEqual([]);
    expect(leftovers(path.join(dir, "docs"))).toEqual([]);
  });
});
