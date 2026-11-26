import { afterEach, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import path from "node:path";
import { tmpdir } from "node:os";
import { listProjectFiles, resolveAtPath } from "./project-files.ts";
import { listNonGitProjectFiles, NON_GIT_LIMITS } from "./non-git-project-files.ts";

const roots: string[] = [];
function project() { const dir = mkdtempSync(path.join(tmpdir(), "fo-files01-unit-")); roots.push(dir); return dir; }
function file(root: string, rel: string, text = "not read by discovery") {
  mkdirSync(path.dirname(path.join(root, rel)), { recursive: true }); writeFileSync(path.join(root, rel), text);
}
function list(dir: string, options: Partial<Parameters<typeof listProjectFiles>[0]> = {}) {
  return listProjectFiles({ dir, nonGitRoot: dir, ...options });
}
afterEach(() => { for (const dir of roots.splice(0)) rmSync(dir, { recursive: true, force: true }); });

test("registered non-Git scope lists names only, respects nested Git ignore semantics and conservative visibility", async () => {
  const dir = project();
  file(dir, "README.md"); file(dir, "docs/мои заметки.md"); file(dir, "src/app.ts");
  file(dir, ".gitignore", "*.log\n!keep.log\n/root-only.txt\ncache/\nsub/*.tmp\n");
  file(dir, "sub/.gitignore", "!keep.tmp\nlocal.txt\n");
  for (const p of ["hide.log", "keep.log", "root-only.txt", "sub/root-only.txt", "cache/hide.txt", "sub/a.tmp", "sub/keep.tmp", "sub/local.txt",
    ".env", ".hidden/visible.txt", "credentials.json", "secrets.json", "id_rsa", "node_modules/pkg/index.js", "vendor/pkg/file"]) file(dir, p);
  file(dir, "embedded/.git/config"); file(dir, "embedded/private.txt");
  const result = await list(dir);
  expect(result).toEqual({ files: ["README.md", "docs/мои заметки.md", "keep.log", "src/app.ts", "sub/keep.tmp", "sub/root-only.txt"], truncated: false });
  const searched = await list(dir, { q: "app", limit: 1 });
  expect(searched).toEqual({ files: ["src/app.ts"], truncated: false });
  expect(await list(dir, { q: "docs" })).toEqual({ files: ["docs/", "docs/мои заметки.md"], truncated: false });
  expect(await list(dir, { q: "no-match" })).toEqual({ files: [], truncated: false });
  expect(existsSync(path.join(dir, ".git"))).toBe(false);
});

test("unapproved scope, ref preview, traversal and absolute queries cannot broaden fallback authority", async () => {
  const dir = project(), outside = project(); file(dir, "safe.txt"); file(outside, "outside-only.txt");
  expect(await listProjectFiles({ dir })).toEqual({ error: "not a git repository" });
  expect("error" in await list(dir, { ref: "HEAD" })).toBe(true);
  expect("error" in await listProjectFiles({ dir: outside, nonGitRoot: dir })).toBe(true);
  expect("error" in await listProjectFiles({ dir: `${dir}/../${path.basename(outside)}`, nonGitRoot: outside })).toBe(true);
  expect(await list(dir, { q: "../outside-only" })).toEqual({ files: [], truncated: false });
  expect(await list(dir, { q: outside })).toEqual({ files: [], truncated: false });
  expect(resolveAtPath(dir, "../outside-only.txt", false)).toBeNull();
  expect(resolveAtPath(dir, path.join(outside, "outside-only.txt"), false)).toBeNull();
});

test("outside/in-root/broken symlinks and registered nested projects never enter the listing", async () => {
  const dir = project(), outside = project(); file(dir, "safe.txt"); file(outside, "outside.txt");
  symlinkSync(outside, path.join(dir, "escape")); symlinkSync(path.join(outside, "outside.txt"), path.join(dir, "escape.txt"));
  symlinkSync(path.join(dir, "safe.txt"), path.join(dir, "inside-link")); symlinkSync("missing", path.join(dir, "broken"));
  file(dir, "child/child-only.txt");
  expect(await list(dir, { excludedProjectRoots: [path.join(dir, "child")] })).toEqual({ files: ["safe.txt"], truncated: false });
  expect(resolveAtPath(dir, "escape.txt", false)).toBeNull();
  expect(resolveAtPath(dir, "escape/outside.txt", false)).toBeNull();
  const alias = path.join(project(), "alias"); symlinkSync(dir, alias);
  expect("error" in await list(alias)).toBe(true);
});

test("unreadable/symlink/oversized ignore metadata fails closed instead of exposing ignored files", async () => {
  const dir = project(), other = project(); file(dir, "secret.txt"); file(other, "policy", "secret.txt\n");
  symlinkSync(path.join(other, "policy"), path.join(dir, ".gitignore"));
  expect("error" in await list(dir)).toBe(true);
  rmSync(path.join(dir, ".gitignore")); file(dir, ".gitignore", "x".repeat(NON_GIT_LIMITS.ignoreBytes + 1));
  expect("error" in await list(dir)).toBe(true);
  file(dir, ".gitignore", "secret.txt\n"); chmodSync(path.join(dir, ".gitignore"), 0);
  try { expect("error" in await list(dir)).toBe(true); }
  finally { chmodSync(path.join(dir, ".gitignore"), 0o600); }
});

test("permission denied and vanished root are handled without exceptions or fabricated completeness", async () => {
  const dir = project(); file(dir, "safe.txt"); file(dir, "denied/private.txt"); chmodSync(path.join(dir, "denied"), 0);
  try { expect(await list(dir)).toEqual({ files: ["safe.txt"], truncated: true }); }
  finally { chmodSync(path.join(dir, "denied"), 0o700); }
  chmodSync(dir, 0);
  try { expect("error" in await list(dir)).toBe(true); }
  finally { chmodSync(dir, 0o700); }
  rmSync(dir, { recursive: true }); expect("error" in await list(dir)).toBe(true);
});

test("depth and entry budgets bound large scans and report truncation", async () => {
  const dir = project(); file(dir, "top.txt");
  file(dir, `${"deep/".repeat(NON_GIT_LIMITS.depth + 1)}hidden-by-limit.txt`);
  const deep = await list(dir);
  expect(deep).toEqual({ files: ["top.txt"], truncated: true });
  const big = project();
  for (let i = 0; i <= NON_GIT_LIMITS.entries; i++) file(big, `item-${i}.txt`, "");
  const result = await list(big, { q: "item", limit: 2 });
  if ("error" in result) throw Error(result.error);
  expect(result.files.length).toBeLessThanOrEqual(2); expect(result.truncated).toBe(true);
}, 15_000);

test("parallel requests are stable, scopes stay separate, updated ignore rules are not cached", async () => {
  const a = project(), b = project(); file(a, "a.txt"); file(b, "b.txt");
  const before = readdirSync(a);
  const results = await Promise.all(Array.from({ length: 12 }, () => list(a, { q: "a" })));
  for (const result of results) expect(result).toEqual({ files: ["a.txt"], truncated: false });
  expect(await list(b, { q: "a" })).toEqual({ files: [], truncated: false });
  expect(readdirSync(a)).toEqual(before);
  file(a, ".gitignore", "a.txt\n"); expect(await list(a, { q: "a" })).toEqual({ files: [], truncated: false });
});

test("broken Git metadata does not enable filesystem fallback", async () => {
  const dir = project(); file(dir, "safe.txt"); mkdirSync(path.join(dir, ".git"));
  expect("error" in await list(dir)).toBe(true);
  rmSync(path.join(dir, ".git"), { recursive: true }); file(dir, ".git", "invalid gitfile");
  expect("error" in await list(dir)).toBe(true);
});

test("ordinary file contents need no read permission and discovery does not mutate the tree", async () => {
  const dir = project(); file(dir, "unreadable.txt"); chmodSync(path.join(dir, "unreadable.txt"), 0);
  try {
    expect(await list(dir)).toEqual({ files: ["unreadable.txt"], truncated: false });
    expect(readdirSync(dir)).toEqual(["unreadable.txt"]);
  } finally { chmodSync(path.join(dir, "unreadable.txt"), 0o600); }
});

test("disappearance during a scan settles safely; distinct concurrent scans are bounded", async () => {
  const gone = project(); file(gone, "vanishing/file.txt");
  const disappearing = listNonGitProjectFiles(gone, gone, []);
  rmSync(gone, { recursive: true });
  expect("error" in await disappearing).toBe(true);
  const a = project(), b = project(), c = project();
  file(a, "a.txt"); file(b, "b.txt"); file(c, "c.txt");
  const first = listNonGitProjectFiles(a, a, []), second = listNonGitProjectFiles(b, b, []);
  expect(await listNonGitProjectFiles(c, c, [])).toEqual({ error: "file discovery is busy; try again" });
  expect(await first).toEqual({ files: ["a.txt"], truncated: false });
  expect(await second).toEqual({ files: ["b.txt"], truncated: false });
});
