import { constants, closeSync, fstatSync, lstatSync, openSync, readSync, realpathSync } from "node:fs";
import { opendir } from "node:fs/promises";
import path from "node:path";
import ignore, { type Ignore } from "ignore";
import { SECRET_FILE_NAMES } from "../shared/project-discovery.ts";

// Bounds include ignored entries, directories and metadata, not just matches.
export const NON_GIT_LIMITS = { entries: 25_000, directories: 1024, depth: 20, milliseconds: 2000,
  ignoreBytes: 64 * 1024, totalIgnoreBytes: 256 * 1024, rules: 2048 } as const;
const excludedNames = new Set<string>([...SECRET_FILE_NAMES, "node_modules", "vendor"]);
type Rules = { base: string; matcher: Ignore };
type Listing = { files: string[]; truncated: boolean } | { error: string };

function absent(error: unknown): boolean {
  return (error as NodeJS.ErrnoException).code === "ENOENT";
}

/** Metadata-only, fail-closed fallback. Authority comes from the HTTP route's
 * exact registered root, never a client-supplied search query or an ancestor.
 * All symlinks are excluded (including in-root links). No Git/global ignore
 * configuration or parent/home files are read by this walker. */
const inflight = new Map<string, Promise<Listing>>();
export function listNonGitProjectFiles(dir: string, root: string, excludedRoots: string[]): Promise<Listing> {
  const key = JSON.stringify([dir, root, excludedRoots]);
  const pending = inflight.get(key);
  if (pending) return pending;
  if (inflight.size >= 2) return Promise.resolve({ error: "file discovery is busy; try again" });
  const load = scan(dir, root, excludedRoots).finally(() => inflight.delete(key));
  inflight.set(key, load);
  return load;
}

async function scan(dir: string, root: string, excludedRoots: string[]): Promise<Listing> {
  if (!path.isAbsolute(root) || dir.split(path.sep).includes("..") || path.resolve(dir) !== path.resolve(root)) {
    return { error: "non-Git file suggestions require the registered project root" };
  }
  let canonical: string;
  try {
    canonical = realpathSync(root);
    // A registered symlink root is deliberately unsupported; registration is
    // not permission to follow a root that can later be redirected elsewhere.
    if (lstatSync(root).isSymbolicLink() || !lstatSync(root).isDirectory()) throw Error();
  } catch { return { error: "project root is unavailable" }; }
  try { lstatSync(path.join(canonical, ".git")); return { error: "project has unavailable Git metadata" }; }
  catch (error) { if (!absent(error)) return { error: "project Git metadata is unavailable" }; }
  const blocked = new Set(excludedRoots.map(p => path.resolve(canonical, path.relative(path.resolve(root), path.resolve(p)))));
  const files: string[] = [];
  let visited = 0, directories = 0, ignoreBytes = 0, rules = 0, truncated = false;
  const deadline = performance.now() + NON_GIT_LIMITS.milliseconds;
  const exhausted = () => visited >= NON_GIT_LIMITS.entries || directories >= NON_GIT_LIMITS.directories || performance.now() >= deadline;

  function checkedDirectory(abs: string): boolean {
    // Check every component, both before and after opening a directory. Never
    // enumerate a symlink; re-check ancestors after asynchronous operations.
    try {
      if (realpathSync(root) !== canonical) return false;
      let current = canonical;
      for (const part of path.relative(canonical, abs).split(path.sep).filter(Boolean)) {
        current = path.join(current, part);
        const st = lstatSync(current);
        if (st.isSymbolicLink() || !st.isDirectory()) return false;
      }
      return realpathSync(abs) === abs;
    } catch { return false; }
  }

  function directoryRules(abs: string, base: string, parents: Rules[]): Rules[] {
    const filename = path.join(abs, ".gitignore");
    let fd: number;
    try { fd = openSync(filename, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK); }
    catch (error) { if (absent(error)) return parents; throw Error("project ignore rules are unavailable"); }
    try {
      const st = fstatSync(fd);
      if (!st.isFile() || st.size > NON_GIT_LIMITS.ignoreBytes || ignoreBytes + st.size > NON_GIT_LIMITS.totalIgnoreBytes || !checkedDirectory(abs)) {
        throw Error("project ignore rules exceed safe limits or are unavailable");
      }
      const buffer = Buffer.alloc(st.size + 1);
      const bytes = readSync(fd, buffer, 0, buffer.length, 0);
      if (bytes !== st.size) throw Error("project ignore rules changed during discovery");
      ignoreBytes += bytes;
      const patterns = buffer.subarray(0, bytes).toString("utf8").split(/\r?\n/);
      rules += patterns.length;
      if (rules > NON_GIT_LIMITS.rules) throw Error("project ignore rules exceed safe limits");
      return [...parents, { base, matcher: ignore().add(patterns) }];
    } finally { closeSync(fd); }
  }

  async function visit(abs: string, relative: string, parents: Rules[], depth: number): Promise<void> {
    if (exhausted() || depth > NON_GIT_LIMITS.depth) { truncated = true; return; }
    if (!checkedDirectory(abs)) { truncated = true; return; }
    // A nested repository is its own scope, even if not registered yet.
    if (relative) {
      try { lstatSync(path.join(abs, ".git")); return; }
      catch (error) { if (!absent(error)) { truncated = true; return; } }
    }
    let stream;
    try { stream = await opendir(abs); }
    catch { if (!relative) throw Error("project root is not readable"); truncated = true; return; }
    directories++;
    try {
      if (!checkedDirectory(abs)) { truncated = true; return; }
      const active = directoryRules(abs, relative, parents);
      for (;;) {
        if (exhausted()) { truncated = true; break; }
        const entry = await stream.read();
        if (!entry) break;
        visited++;
        const name = entry.name;
        if (name.startsWith(".") || excludedNames.has(name) || name.includes("\\")) continue;
        const rel = relative ? `${relative}/${name}` : name;
        const target = path.join(abs, name);
        if (blocked.has(target)) continue;
        let st;
        try {
          if (!checkedDirectory(abs)) { truncated = true; break; }
          st = lstatSync(target);
        } catch { truncated = true; continue; }
        if (st.isSymbolicLink() || (!st.isDirectory() && !st.isFile())) continue;
        let ignored = false;
        for (const { base, matcher } of active) {
          const result = matcher.test((base ? rel.slice(base.length + 1) : rel) + (st.isDirectory() ? "/" : ""));
          if (result.ignored) ignored = true;
          else if (result.unignored) ignored = false;
        }
        if (ignored) continue;
        if (st.isDirectory()) {
          try { await visit(target, rel, active, depth + 1); }
          catch (error) {
            if (absent(error)) truncated = true;
            else throw error;
          }
        } else files.push(rel);
      }
    } finally { await stream.close(); }
  }
  try {
    await visit(canonical, "", [], 0);
    if (!checkedDirectory(canonical)) return { error: "project root changed during discovery" };
    return { files, truncated };
  } catch (error) {
    return { error: error instanceof Error ? error.message : "project files are unavailable" };
  }
}
