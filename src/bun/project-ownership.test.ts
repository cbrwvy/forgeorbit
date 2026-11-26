import { beforeAll, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

/** FO-008C/D: which registered project a task workdir belongs to. Only the
 *  file system is read — no git process is started. The module reads the
 *  registry, so the database lives in a temp dir. */

process.env.AGETOR_DATA_DIR = mkdtempSync(path.join(tmpdir(), "fo008d-own-db-"));

let mod: typeof import("./project-ownership.ts");
let db: typeof import("./db.ts");
let classifyWorkdirs: typeof import("./project-ownership.ts")["classifyWorkdirs"];
let isWithin: typeof import("./project-ownership.ts")["isWithin"];
let lexicalPath: typeof import("./project-ownership.ts")["lexicalPath"];
let worktreeMainPath: typeof import("./project-ownership.ts")["worktreeMainPath"];
let nodeOwnershipFs: typeof import("./project-ownership.ts")["nodeOwnershipFs"];

beforeAll(async () => {
  db = await import("./db.ts");
  mod = await import("./project-ownership.ts");
  ({ classifyWorkdirs, isWithin, lexicalPath, worktreeMainPath, nodeOwnershipFs } = mod);
});

function scratch(name: string): string {
  return realpathSync(mkdtempSync(path.join(tmpdir(), `fo008c-own-${name}-`)));
}

test("path containment compares whole segments", () => {
  expect(isWithin("/a/app", "/a/app")).toBe(true);
  expect(isWithin("/a/app", "/a/app/src")).toBe(true);
  expect(isWithin("/a/app", "/a/app2")).toBe(false);
  expect(isWithin("/a/app", "/a/ap")).toBe(false);
  expect(lexicalPath("/a/app/")).toBe("/a/app");
  expect(lexicalPath("/a/./b/../app")).toBe("/a/app");
  expect(lexicalPath("relative/dir")).toBeNull();
});

test("exact, subfolder and missing-folder workdirs", () => {
  const root = scratch("basic");
  const project = path.join(root, "proj");
  mkdirSync(path.join(project, "pkg"), { recursive: true });
  const result = classifyWorkdirs([project], [project, path.join(project, "pkg"), path.join(project, "gone", "later"), path.join(root, "proj2")]);
  expect(result.byProject.get(project)).toEqual([project, path.join(project, "pkg"), path.join(project, "gone", "later")]);
  expect(result.unattributed).toEqual([path.join(root, "proj2")]);
  expect(result.ambiguous).toEqual([]);
});

test("a symlinked workdir follows its real location", () => {
  const root = scratch("link");
  const project = path.join(root, "real");
  mkdirSync(path.join(project, "src"), { recursive: true });
  const alias = path.join(root, "alias");
  symlinkSync(path.join(project, "src"), alias);
  const result = classifyWorkdirs([project], [alias]);
  expect(result.byProject.get(project)).toEqual([project, alias]);
});

test("a symlink inside one project that points into another is ambiguous", () => {
  const root = scratch("cross");
  const a = path.join(root, "a");
  const b = path.join(root, "b");
  mkdirSync(path.join(b, "lib"), { recursive: true });
  mkdirSync(a);
  symlinkSync(path.join(b, "lib"), path.join(a, "vendored"));
  const result = classifyWorkdirs([a, b], [path.join(a, "vendored")]);
  expect(result.byProject.get(a)).toEqual([a]);
  expect(result.byProject.get(b)).toEqual([b]);
  expect(result.ambiguous).toHaveLength(1);
  expect(result.ambiguous[0]!.candidates.sort()).toEqual([a, b].sort());
});

test("two registrations of the same folder never guess", () => {
  const root = scratch("dup");
  const real = path.join(root, "real");
  mkdirSync(path.join(real, "x"), { recursive: true });
  const alias = path.join(root, "alias");
  symlinkSync(real, alias);
  const result = classifyWorkdirs([real, alias], [path.join(real, "x")]);
  expect(result.ambiguous).toHaveLength(1);
});

test("a linked git worktree is attributed to its main checkout", () => {
  const root = scratch("wt");
  const main = path.join(root, "main");
  const wt = path.join(root, "elsewhere", "feature");
  mkdirSync(path.join(main, ".git", "worktrees", "feature"), { recursive: true });
  mkdirSync(path.join(main, "web"), { recursive: true });
  mkdirSync(path.join(wt, "web"), { recursive: true });
  writeFileSync(path.join(wt, ".git"), `gitdir: ${path.join(main, ".git", "worktrees", "feature")}\n`);
  writeFileSync(path.join(main, ".git", "worktrees", "feature", "gitdir"), `${path.join(wt, ".git")}\n`);
  expect(worktreeMainPath(path.join(wt, "web"), nodeOwnershipFs)).toBe(path.join(main, "web"));
  const result = classifyWorkdirs([main], [wt, path.join(wt, "web")]);
  expect(result.byProject.get(main)).toEqual([main, wt, path.join(wt, "web")]);
  expect(result.indirect.every((item) => item.via === "worktree")).toBe(true);
});

test("a worktree whose back-pointer does not match is not trusted", () => {
  const root = scratch("wt-bad");
  const main = path.join(root, "main");
  const wt = path.join(root, "feature");
  mkdirSync(path.join(main, ".git", "worktrees", "feature"), { recursive: true });
  mkdirSync(wt, { recursive: true });
  writeFileSync(path.join(wt, ".git"), `gitdir: ${path.join(main, ".git", "worktrees", "feature")}\n`);
  writeFileSync(path.join(main, ".git", "worktrees", "feature", "gitdir"), `/somewhere/else/.git\n`);
  const result = classifyWorkdirs([main], [wt]);
  expect(result.byProject.get(main)).toEqual([main]);
  expect(result.unattributed).toEqual([wt]);
});

test("a worktree of a nested project maps to the deepest registered project", () => {
  const root = scratch("wt-nested");
  const repo = path.join(root, "repo");
  const nested = path.join(repo, "apps", "api");
  mkdirSync(path.join(repo, ".git", "worktrees", "w1"), { recursive: true });
  mkdirSync(nested, { recursive: true });
  const wt = path.join(root, "w1");
  mkdirSync(path.join(wt, "apps", "api"), { recursive: true });
  writeFileSync(path.join(wt, ".git"), "gitdir: ../repo/.git/worktrees/w1\n");
  writeFileSync(path.join(repo, ".git", "worktrees", "w1", "gitdir"), `${path.join(wt, ".git")}\n`);
  const result = classifyWorkdirs([repo, nested], [path.join(wt, "apps", "api"), path.join(wt, "docs")]);
  expect(result.byProject.get(nested)).toEqual([nested, path.join(wt, "apps", "api")]);
  expect(result.byProject.get(repo)).toEqual([repo, path.join(wt, "docs")]);
});

test("a project subfolder that symlinks outside every project is an escape, not a project task", () => {
  const root = scratch("escape");
  const project = path.join(root, "proj");
  const outside = path.join(root, "outside");
  mkdirSync(project);
  mkdirSync(outside);
  symlinkSync(outside, path.join(project, "out"));
  const result = classifyWorkdirs([project], [path.join(project, "out")]);
  expect(result.byProject.get(project)).toEqual([project]);
  expect(result.unattributed).toEqual([path.join(project, "out")]);
  expect(result.escapes).toEqual([path.join(project, "out")]);
  expect(mod.classifyWorkdir([project], path.join(project, "out"))).toEqual({ kind: "unattributed", reason: "symlink-escape" });
  // A path that no longer exists is judged by its path only.
  expect(mod.classifyWorkdir([project], path.join(project, "removed"))).toEqual({ kind: "owned", projectPath: project, via: "subfolder" });
  void db;
});
