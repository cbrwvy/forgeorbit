/**
 * Which registered project a task workdir belongs to (FO-008C, unified in
 * FO-008D). This is the one ownership contract for the portfolio, project
 * managers, scheduling, supervised execution and batches.
 *
 * The board stores a task's `workdir` as typed when it was created. A task
 * may live in a subfolder of a registered project, behind a symlink, or in
 * a linked Git worktree of one. The portfolio attributes such a workdir to
 * a project only when the link can be proven from the file system:
 *
 * - exact match with a registered path;
 * - the workdir (lexical or canonical) is the project folder or below it,
 *   compared on whole path segments (`/a/app` never owns `/a/app2`);
 * - nested registered projects: the deepest one wins;
 * - a linked Git worktree: its `.git` file names `<repo>/.git/worktrees/<n>`
 *   and that folder's `gitdir` file points back. The worktree's subpath is
 *   mapped into the main checkout. No `git` process is started.
 *
 * A workdir whose lexical and canonical forms point at different projects,
 * or that two registrations claim equally, is ambiguous and left out. A
 * workdir inside a project by path that resolves outside every project (a
 * symlink escape) belongs to no project.
 *
 * Reads (lists, context) use a short-lived cache. Anything that writes or
 * launches re-checks fresh (`fresh: true`, `verifyLaunchScope`): seeing a
 * task in a project never by itself grants the right to run it there.
 */

import { readFileSync, realpathSync, statSync } from "node:fs";
import path from "node:path";
import { dataDir, projects, tasks } from "./db.ts";
import type { Task } from "../shared/types.ts";

export interface OwnershipFs {
  realpath(p: string): string | null;
  /** Small text file contents, or null when missing / not a regular file. */
  readText(p: string): string | null;
  isDirectory(p: string): boolean;
}

const MAX_GIT_FILE_BYTES = 4096;
const MAX_WALK_UP = 64;

export const nodeOwnershipFs: OwnershipFs = {
  realpath(p) {
    try {
      return realpathSync(p);
    } catch {
      return null;
    }
  },
  readText(p) {
    try {
      const stat = statSync(p);
      if (!stat.isFile() || stat.size > MAX_GIT_FILE_BYTES) return null;
      return readFileSync(p, "utf8");
    } catch {
      return null;
    }
  },
  isDirectory(p) {
    try {
      return statSync(p).isDirectory();
    } catch {
      return false;
    }
  },
};

export interface AmbiguousWorkdir {
  workdir: string;
  candidates: string[];
  reason: string;
}

export interface WorkdirOwnership {
  /** Registered project path → raw workdir strings that belong to it. The
   *  project's own path is always the first entry. */
  byProject: Map<string, string[]>;
  ambiguous: AmbiguousWorkdir[];
  /** Workdirs no registered project claims (not counted anywhere). */
  unattributed: string[];
  /** The subset of `unattributed` inside a project by path whose real
   *  location (through a symlink) lies outside every project. */
  escapes: string[];
  /** Workdirs attributed through a subfolder, symlink or worktree link. */
  indirect: { workdir: string; projectPath: string; via: "subfolder" | "worktree" }[];
}

/** POSIX-normalized absolute form without a trailing slash, or null. */
export function lexicalPath(p: string): string | null {
  if (typeof p !== "string" || !p.trim() || !path.isAbsolute(p) || p.includes("\0")) return null;
  const resolved = path.resolve(p);
  return resolved.length > 1 && resolved.endsWith("/") ? resolved.slice(0, -1) : resolved;
}

/** True when `child` is `root` or below it, on whole segments. */
export function isWithin(root: string, child: string): boolean {
  if (child === root) return true;
  const base = root === "/" ? "/" : `${root}/`;
  return child.startsWith(base);
}

interface Root {
  projectPath: string;
  forms: string[];
}

/** Deepest project whose root (any form) contains `p`; ambiguous on a tie
 *  between two different projects at the same depth. */
function deepestOwner(roots: readonly Root[], p: string): { owner: string | null; tie: string[] } {
  let best: { depth: number; owners: Set<string> } | null = null;
  for (const root of roots) {
    for (const form of root.forms) {
      if (!isWithin(form, p)) continue;
      const depth = form === "/" ? 0 : form.split("/").length;
      if (!best || depth > best.depth) best = { depth, owners: new Set([root.projectPath]) };
      else if (depth === best.depth) best.owners.add(root.projectPath);
    }
  }
  if (!best) return { owner: null, tie: [] };
  if (best.owners.size > 1) return { owner: null, tie: [...best.owners] };
  return { owner: [...best.owners][0] ?? null, tie: [] };
}

/**
 * The main checkout a linked worktree folder belongs to, proven by the
 * `.git` file and the back-pointer in `<repo>/.git/worktrees/<name>/gitdir`.
 * Returns the main checkout path plus the workdir's subpath inside it.
 */
export function worktreeMainPath(start: string, fs: OwnershipFs): string | null {
  let dir = start;
  for (let i = 0; i < MAX_WALK_UP; i++) {
    const marker = path.join(dir, ".git");
    if (fs.isDirectory(marker)) return null; // an ordinary checkout, not a linked worktree
    const text = fs.readText(marker);
    if (text != null) {
      const match = /^gitdir:\s*(.+?)\s*$/m.exec(text);
      if (!match) return null;
      const gitdir = path.resolve(dir, match[1]!);
      const linked = /^(.*)\/\.git\/worktrees\/[^/]+$/.exec(gitdir);
      if (!linked || !linked[1]) return null;
      const back = fs.readText(path.join(gitdir, "gitdir"));
      if (back == null) return null;
      const backPath = path.resolve(gitdir, back.trim());
      const ownMarker = fs.realpath(marker) ?? marker;
      const backReal = fs.realpath(backPath) ?? backPath;
      if (backReal !== ownMarker && backPath !== marker) return null;
      const main = fs.realpath(linked[1]) ?? linked[1];
      const rel = path.relative(dir, start);
      return rel ? path.join(main, rel) : main;
    }
    const parent = path.dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
  return null;
}

export type TaskOwnership =
  | { kind: "owned"; projectPath: string; via: "exact" | "subfolder" | "worktree" }
  | { kind: "ambiguous"; candidates: string[]; reason: string }
  | { kind: "unattributed"; reason: "outside" | "symlink-escape" | "invalid" };

interface Roots {
  roots: Root[];
  registered: ReadonlySet<string>;
}

function buildRoots(projectPaths: readonly string[], fs: OwnershipFs): Roots {
  const roots: Root[] = [];
  for (const projectPath of projectPaths) {
    const forms = new Set<string>();
    const lexical = lexicalPath(projectPath);
    if (lexical) forms.add(lexical);
    const canonical = lexical ? fs.realpath(lexical) : null;
    if (canonical) forms.add(canonical);
    roots.push({ projectPath, forms: [...forms] });
  }
  return { roots, registered: new Set(projectPaths) };
}

/**
 * One workdir against the registered projects. The real location decides
 * when the folder exists: a path inside a project that resolves (through a
 * symlink) to somewhere no project owns is a symlink escape, not a task of
 * that project. A folder that no longer exists is judged by its path only.
 */
function classifyOne({ roots, registered }: Roots, workdir: string, fs: OwnershipFs): TaskOwnership {
  if (registered.has(workdir)) return { kind: "owned", projectPath: workdir, via: "exact" };
  const lexical = lexicalPath(workdir);
  if (!lexical) return { kind: "unattributed", reason: "invalid" };
  const canonical = fs.realpath(lexical);
  const byLexical = deepestOwner(roots, lexical);
  const byCanonical = canonical ? deepestOwner(roots, canonical) : { owner: null, tie: [] };
  const ties = [...new Set([...byLexical.tie, ...byCanonical.tie])];
  if (ties.length > 0) return { kind: "ambiguous", candidates: ties, reason: "More than one registered project points at this folder." };
  if (byLexical.owner && byCanonical.owner && byLexical.owner !== byCanonical.owner) {
    return {
      kind: "ambiguous",
      candidates: [byLexical.owner, byCanonical.owner],
      reason: "The folder's path and its real location belong to different projects.",
    };
  }
  if (byCanonical.owner) return { kind: "owned", projectPath: byCanonical.owner, via: "subfolder" };
  // A linked worktree (or a folder removed from one) is proven by its own
  // `.git` file and the back-pointer in the main checkout.
  const mapped = worktreeMainPath(canonical ?? lexical, fs);
  if (mapped) {
    const byWorktree = deepestOwner(roots, mapped);
    if (byWorktree.tie.length > 0) {
      return { kind: "ambiguous", candidates: byWorktree.tie, reason: "The worktree's main checkout is claimed by more than one project." };
    }
    if (byWorktree.owner) {
      if (byLexical.owner && byLexical.owner !== byWorktree.owner) {
        return { kind: "ambiguous", candidates: [byLexical.owner, byWorktree.owner], reason: "The folder's path and its worktree belong to different projects." };
      }
      return { kind: "owned", projectPath: byWorktree.owner, via: "worktree" };
    }
  }
  if (byLexical.owner) {
    // Inside a project by path, but it resolves to a place no project owns.
    if (canonical) return { kind: "unattributed", reason: "symlink-escape" };
    return { kind: "owned", projectPath: byLexical.owner, via: "subfolder" };
  }
  return { kind: "unattributed", reason: "outside" };
}

export function classifyWorkdir(projectPaths: readonly string[], workdir: string, fs: OwnershipFs = nodeOwnershipFs): TaskOwnership {
  return classifyOne(buildRoots(projectPaths, fs), workdir, fs);
}

export function classifyWorkdirs(
  projectPaths: readonly string[],
  workdirs: readonly string[],
  fs: OwnershipFs = nodeOwnershipFs,
): WorkdirOwnership {
  const byProject = new Map<string, string[]>(projectPaths.map((projectPath) => [projectPath, [projectPath]]));
  const roots = buildRoots(projectPaths, fs);
  const ambiguous: AmbiguousWorkdir[] = [];
  const unattributed: string[] = [];
  const escapes: string[] = [];
  const indirect: WorkdirOwnership["indirect"] = [];
  const seen = new Set<string>();
  for (const workdir of workdirs) {
    if (seen.has(workdir)) continue;
    seen.add(workdir);
    const result = classifyOne(roots, workdir, fs);
    if (result.kind === "ambiguous") {
      ambiguous.push({ workdir, candidates: result.candidates, reason: result.reason });
    } else if (result.kind === "unattributed") {
      unattributed.push(workdir);
      if (result.reason === "symlink-escape") escapes.push(workdir);
    } else if (result.via !== "exact") {
      byProject.get(result.projectPath)!.push(workdir);
      indirect.push({ workdir, projectPath: result.projectPath, via: result.via });
    }
  }
  return { byProject, ambiguous, unattributed, escapes, indirect };
}

/* ────────────────────────────────────────────────────────────────────────── *
 * The registry-bound contract.
 * ────────────────────────────────────────────────────────────────────────── */

const CACHE_TTL_MS = 2000;

interface Cache {
  version: number;
  at: number;
  roots: Roots;
  results: Map<string, TaskOwnership>;
}

let cache: Cache | null = null;

function freshRoots(): Roots {
  return buildRoots(projects.list().map((project) => project.path), nodeOwnershipFs);
}

function cachedRoots(now: number): Cache {
  const version = projects.version();
  if (!cache || cache.version !== version || now - cache.at > CACHE_TTL_MS) {
    cache = { version, at: now, roots: freshRoots(), results: new Map() };
  }
  return cache;
}

/** Ownership of one workdir. `fresh` skips the cache (writes, launches). */
export function ownershipOf(workdir: string, opts: { fresh?: boolean } = {}): TaskOwnership {
  if (opts.fresh) return classifyOne(freshRoots(), workdir, nodeOwnershipFs);
  const current = cachedRoots(Date.now());
  let result = current.results.get(workdir);
  if (!result) {
    result = classifyOne(current.roots, workdir, nodeOwnershipFs);
    current.results.set(workdir, result);
  }
  return result;
}

export function ownerProjectOf(workdir: string, opts: { fresh?: boolean } = {}): string | null {
  const result = ownershipOf(workdir, opts);
  return result.kind === "owned" ? result.projectPath : null;
}

/**
 * Per-snapshot fresh ownership resolver: inspects project roots cleanly once
 * and memoizes distinct workdirs within the synchronous pass, avoiding O(P*T)
 * redundant root scans across multi-project / multi-task listings.
 */
export function createFreshOwnershipResolver(
  fs: OwnershipFs = nodeOwnershipFs,
): (workdir: string) => TaskOwnership {
  const roots = buildRoots(projects.list().map((project) => project.path), fs);
  const seen = new Map<string, TaskOwnership>();
  return (workdir: string) => {
    let result = seen.get(workdir);
    if (!result) {
      result = classifyOne(roots, workdir, fs);
      seen.set(workdir, result);
    }
    return result;
  };
}

export function taskInProject(task: Pick<Task, "workdir">, projectPath: string, opts: { fresh?: boolean } = {}): boolean {
  return ownerProjectOf(task.workdir, opts) === projectPath;
}

/** Board tasks (no pipeline steps) that belong to the project. */
export function projectTasks(projectPath: string, opts: { fresh?: boolean; list?: Task[] } = {}): Task[] {
  return (opts.list ?? tasks.list()).filter((task) => !task.pipelineParentId && taskInProject(task, projectPath, opts));
}

/** Every distinct workdir attributed to the project, the project path first.
 *  Feeds the SQL helpers that filter by `workdir IN (…)`. */
export function projectWorkdirs(projectPath: string, list: Pick<Task, "workdir">[] = tasks.list()): string[] {
  const out = [projectPath];
  for (const task of list) {
    if (!out.includes(task.workdir) && ownerProjectOf(task.workdir) === projectPath) out.push(task.workdir);
  }
  return out;
}

/** Derived fields the task routes add to a task (never stored). */
export function ownershipFields(workdir: string): { ownerProjectPath: string | null; projectOwnership: TaskOwnershipKind } {
  const result = ownershipOf(workdir);
  return {
    ownerProjectPath: result.kind === "owned" ? result.projectPath : null,
    projectOwnership: result.kind === "owned" ? result.via : result.kind === "ambiguous" ? "ambiguous" : result.reason === "symlink-escape" ? "symlink-escape" : "unattributed",
  };
}

export type TaskOwnershipKind = "exact" | "subfolder" | "worktree" | "ambiguous" | "symlink-escape" | "unattributed";

export type LaunchScopeCode = "task-outside-project" | "ownership-ambiguous" | "symlink-escape" | "workdir-missing" | "foreign-worktree" | "pipeline-step";

/**
 * The server-side check before a project-scoped launch (supervised
 * execution, batches): the task belongs to this project now (fresh), its
 * folder exists and really lies in the project, and a recorded worktree is
 * this task's own under the data dir — never another task's or a foreign
 * checkout.
 */
export function verifyLaunchScope(
  task: Pick<Task, "id" | "workdir" | "worktreePath" | "pipelineParentId">,
  projectPath: string,
  fs: OwnershipFs = nodeOwnershipFs,
): { ok: true } | { ok: false; code: LaunchScopeCode; reason: string } {
  if (task.pipelineParentId) return { ok: false, code: "pipeline-step", reason: "A pipeline step is started by its pipeline, not here." };
  const ownership = classifyOne(buildRoots(projects.list().map((project) => project.path), fs), task.workdir, fs);
  if (ownership.kind === "ambiguous") {
    return { ok: false, code: "ownership-ambiguous", reason: `The task's folder can't be attributed to one project: ${ownership.reason}` };
  }
  if (ownership.kind === "unattributed") {
    return ownership.reason === "symlink-escape"
      ? { ok: false, code: "symlink-escape", reason: "The task's folder resolves outside the project through a symlink." }
      : { ok: false, code: "task-outside-project", reason: "The task's folder is not part of this project." };
  }
  if (ownership.projectPath !== projectPath) {
    return { ok: false, code: "task-outside-project", reason: "The task belongs to another project." };
  }
  if (!fs.realpath(lexicalPath(task.workdir) ?? task.workdir)) {
    return { ok: false, code: "workdir-missing", reason: `The task's folder ${task.workdir} doesn't exist.` };
  }
  if (task.worktreePath) {
    const root = path.join(dataDir, "worktrees");
    const own = path.join(root, task.id);
    const lexical = lexicalPath(task.worktreePath);
    const canonical = lexical ? fs.realpath(lexical) : null;
    const canonicalOwn = (fs.realpath(root) ?? root) + path.sep + task.id;
    if (!lexical || !isWithin(own, lexical) || (canonical != null && !isWithin(canonicalOwn, canonical))) {
      return { ok: false, code: "foreign-worktree", reason: "The task's recorded worktree is not its own worktree." };
    }
  }
  return { ok: true };
}

export const __testing = {
  clearCache(): void {
    cache = null;
  },
};
