/**
 * Read-only scan behind `POST /projects/discover`.
 *
 * Stats an allowlist of relative paths. Reads text only for manifests the
 * pure analyzer classifies, and never opens secret filenames. The only
 * child process is `git rev-parse` (branch and toplevel). Make, npm, Docker,
 * and anything else found on disk are not executed.
 */

import { lstatSync, readdirSync, readFileSync, realpathSync, statSync } from "node:fs";
import path from "node:path";
import {
  DISCOVERY_REL_PATHS,
  DISCOVERY_TEXT_CAP,
  READABLE_REL_PATHS,
  SECRET_FILE_NAMES,
  analyzeProject,
  validateFolderName,
  type ProjectDiscovery,
  type ScanFacts,
} from "../shared/project-discovery.ts";

const GIT_TIMEOUT_MS = 4_000;
const DOC_TEXT_CAP = 8 * 1024;

export type DiscoverResult =
  | { ok: true; report: ProjectDiscovery }
  | { ok: false; status: 400 | 404; error: string };

export function isInside(root: string, target: string): boolean {
  const rel = path.relative(root, target);
  return rel === "" || (!rel.startsWith(`..${path.sep}`) && rel !== ".." && !path.isAbsolute(rel));
}

async function gitRevParse(cwd: string, args: string[]): Promise<string | null> {
  const proc = Bun.spawn(["git", ...args], {
    cwd,
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
    env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
  });
  const timer = setTimeout(() => proc.kill(), GIT_TIMEOUT_MS);
  try {
    const [stdout, , exitCode] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]);
    if (exitCode !== 0) return null;
    const value = stdout.trim();
    return value || null;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

async function readGit(cwd: string): Promise<ScanFacts["git"]> {
  const inside = await gitRevParse(cwd, ["rev-parse", "--is-inside-work-tree"]);
  if (inside !== "true") return { present: false, branch: null, toplevel: null };
  const [branch, toplevel] = await Promise.all([
    gitRevParse(cwd, ["rev-parse", "--abbrev-ref", "HEAD"]),
    gitRevParse(cwd, ["rev-parse", "--show-toplevel"]),
  ]);
  let canonicalTop: string | null = toplevel;
  if (toplevel) {
    try {
      canonicalTop = realpathSync(toplevel);
    } catch {
      canonicalTop = toplevel;
    }
  }
  return { present: true, branch, toplevel: canonicalTop };
}

function inodeKey(real: string): string {
  try {
    const st = statSync(real);
    return `${st.dev}:${st.ino}`;
  } catch {
    return real;
  }
}

/** A regular file inside `root`, or why it was skipped. */
export function locateFile(root: string, rel: string): { ok: true; real: string; size: number } | { ok: false; outside?: boolean } {
  const abs = path.join(root, rel);
  let linked;
  try {
    linked = lstatSync(abs);
  } catch {
    return { ok: false };
  }
  if (!linked.isFile() && !linked.isSymbolicLink()) return { ok: false };
  let real: string;
  try {
    real = realpathSync(abs);
  } catch {
    return { ok: false };
  }
  if (!isInside(root, real)) return { ok: false, outside: true };
  let st;
  try {
    st = statSync(real);
  } catch {
    return { ok: false };
  }
  if (!st.isFile()) return { ok: false };
  return { ok: true, real, size: st.size };
}

function readText(real: string, size: number, cap: number): string | null {
  if (size > cap) return null;
  try {
    return readFileSync(real, "utf8");
  } catch {
    return null;
  }
}

function textCap(rel: string): number {
  if (
    rel.endsWith(".md") ||
    rel.endsWith(".markdown") ||
    rel === "Dockerfile" ||
    rel === "dockerfile"
  ) return DOC_TEXT_CAP;
  return DISCOVERY_TEXT_CAP;
}

/**
 * `path` is an existing directory, or the parent of `folderName` when the
 * new project folder does not exist yet. Never creates anything.
 */
export async function discoverProject(input: { path?: unknown; folderName?: unknown }): Promise<DiscoverResult> {
  const raw = typeof input.path === "string" ? input.path.trim() : "";
  if (!raw) return { ok: false, status: 400, error: "path required" };
  if (!path.isAbsolute(raw)) return { ok: false, status: 400, error: "path must be absolute" };

  const folderName = typeof input.folderName === "string" ? input.folderName.trim() : "";
  if (input.folderName != null && input.folderName !== "" && !folderName) {
    return { ok: false, status: 400, error: "Folder name is required." };
  }
  if (folderName) {
    const nameError = validateFolderName(folderName);
    if (nameError) return { ok: false, status: 400, error: nameError };
  }

  let parentReal: string;
  try {
    const parentStat = statSync(raw);
    if (!parentStat.isDirectory()) return { ok: false, status: 400, error: "path is not a directory" };
    parentReal = realpathSync(raw);
  } catch {
    return { ok: false, status: 404, error: `path does not exist: ${raw}` };
  }

  const planned = folderName ? path.join(parentReal, folderName) : parentReal;
  let projectReal = planned;
  let willCreateDirectory = false;
  if (folderName) {
    try {
      const plannedStat = statSync(planned);
      if (!plannedStat.isDirectory()) return { ok: false, status: 400, error: "That name is already a file." };
      projectReal = realpathSync(planned);
    } catch {
      willCreateDirectory = true;
      projectReal = planned;
    }
  }

  const scanRoot = willCreateDirectory ? parentReal : projectReal;
  const git = await readGit(scanRoot);
  const warnings: string[] = [];
  const files = new Set<string>();
  const inodes = new Map<string, string>();
  const texts: Record<string, string> = {};

  if (!willCreateDirectory) {
    for (const rel of DISCOVERY_REL_PATHS) {
      const located = locateFile(projectReal, rel);
      if (!located.ok) {
        if (located.outside) warnings.push(`Skipped ${rel} because it points outside the project.`);
        continue;
      }
      files.add(rel);
      inodes.set(rel, inodeKey(located.real));
      if (!READABLE_REL_PATHS.has(rel)) continue;
      const cap = textCap(rel);
      if (located.size > cap) {
        warnings.push(`${rel} is too large to inspect.`);
        continue;
      }
      const text = readText(located.real, located.size, cap);
      if (text == null) warnings.push(`Couldn't read ${rel}.`);
      else texts[rel] = text;
    }
  }

  const secretsNoted: string[] = [];
  if (!willCreateDirectory) {
    for (const name of SECRET_FILE_NAMES) {
      try {
        const st = lstatSync(path.join(projectReal, name));
        if (st.isFile() || st.isSymbolicLink()) secretsNoted.push(name);
      } catch {
        /* absent */
      }
    }
  }

  let rootEntries: string[] = [];
  let empty = willCreateDirectory;
  if (!willCreateDirectory) {
    try {
      const entries = readdirSync(projectReal, { withFileTypes: true });
      rootEntries = entries.map((entry) => entry.name);
      empty = entries.every((entry) => entry.name === ".DS_Store");
    } catch {
      warnings.push("Couldn't list the folder.");
    }
  }

  const facts: ScanFacts = {
    projectPath: projectReal,
    willCreateDirectory,
    empty,
    files,
    inodes,
    rootEntries,
    texts,
    git,
    secretsNoted,
    warnings,
  };
  return { ok: true, report: analyzeProject(facts) };
}
