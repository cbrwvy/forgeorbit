/**
 * Creates the IDEA.md / PRD.md drafts the user accepted in the project
 * wizard (FO-003). The only code path that writes interview output into a
 * project, and it runs only from the wizard's confirm, after registration.
 *
 * Rules:
 * - Targets are project-relative `.md` paths that stay inside the project
 *   after realpath (a symlinked folder that points outside is refused).
 * - An existing file is never overwritten — not even a dangling symlink.
 *   The file is written to a temp name in the same folder and `link`ed into
 *   place, which fails if the name exists, so creation is all-or-nothing
 *   per file and a racing writer can't be clobbered.
 * - Missing folders on the way (`docs/`) are created one level at a time.
 * - Every target is checked before anything is written. If a later write
 *   still fails, files already created stay and the result says exactly
 *   which ones exist; nothing is deleted to roll back.
 * - No git commands.
 *
 * TOCTOU (FO-003.1). The final path component can't be raced: the temp file
 * is opened `O_CREAT|O_EXCL|O_NOFOLLOW` and `link(2)` never follows or
 * replaces an existing name. A folder on the way can still be swapped for a
 * symlink between the check and the write — Bun/Node have no `openat`, so
 * the walk can't be pinned to directory descriptors. What this module does
 * instead: re-check the parent's realpath right before opening, then after
 * the link compare the new file's realpath and inode with the file it just
 * wrote. If the file landed outside the project it is removed — only when
 * the inode is ours — and the write is reported failed. A swap in that
 * window could still create a folder or, briefly, our own new file outside
 * the project; it can never overwrite or delete anyone else's file.
 */

import {
  closeSync,
  constants as fsConstants,
  fstatSync,
  fsyncSync,
  linkSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  realpathSync,
  statSync,
  unlinkSync,
  writeSync,
} from "node:fs";
import path from "node:path";
import { isInside } from "./project-discovery.ts";
import { findRegisteredDuplicate } from "./project-register.ts";
import type { DocKind } from "../shared/project-discovery.ts";
import { INTERVIEW_LIMITS, validateDocTarget } from "../shared/project-interview.ts";

export type DocTargetState = "free" | "exists" | "invalid" | "outside";

export interface DocTargetCheck {
  kind: DocKind;
  path: string;
  state: DocTargetState;
  /** Absolute path the file would be created at, when known. */
  absolute: string | null;
  error: string | null;
}

export interface DocWriteResult {
  kind: DocKind;
  path: string;
  status: "created" | "failed";
  absolute: string | null;
  error: string | null;
}

type Failure = { ok: false; status: 400 | 404 | 409; error: string };

function parseFiles(value: unknown, withContent: boolean):
  | { ok: true; files: { kind: DocKind; path: string; content: string }[] }
  | Failure {
  if (!Array.isArray(value) || value.length === 0) return { ok: false, status: 400, error: "files required" };
  if (value.length > 2) return { ok: false, status: 400, error: "At most two documents." };
  const files: { kind: DocKind; path: string; content: string }[] = [];
  const seenKinds = new Set<string>();
  const seenPaths = new Set<string>();
  for (const raw of value) {
    if (!raw || typeof raw !== "object") return { ok: false, status: 400, error: "invalid file entry" };
    const record = raw as Record<string, unknown>;
    const kind = record.kind === "idea" || record.kind === "prd" ? record.kind : null;
    if (!kind) return { ok: false, status: 400, error: "kind must be idea or prd" };
    const rel = typeof record.path === "string" ? record.path.trim() : "";
    const pathError = validateDocTarget(rel);
    if (pathError) return { ok: false, status: 400, error: `${rel || kind}: ${pathError}` };
    if (seenKinds.has(kind)) return { ok: false, status: 400, error: `Two ${kind} documents.` };
    if (seenPaths.has(rel.toLowerCase())) return { ok: false, status: 400, error: "Both documents use the same path." };
    seenKinds.add(kind);
    seenPaths.add(rel.toLowerCase());
    let content = "";
    if (withContent) {
      if (typeof record.content !== "string" || !record.content.trim()) {
        return { ok: false, status: 400, error: `${rel}: the document is empty.` };
      }
      if (record.content.length > INTERVIEW_LIMITS.draftChars) return { ok: false, status: 400, error: `${rel}: the document is too large.` };
      if (record.content.includes("\0")) return { ok: false, status: 400, error: `${rel}: the document contains a NUL character.` };
      content = record.content;
    }
    files.push({ kind, path: rel, content });
  }
  return { ok: true, files };
}

function errorCode(error: unknown): string | undefined {
  return (error as NodeJS.ErrnoException | undefined)?.code;
}

/**
 * Walk `rel`'s folders under `root` (a realpath). Existing segments must be
 * folders that stay inside `root` after realpath. With `create`, missing
 * folders are made. Returns the real parent folder and the target path.
 */
function resolveTarget(
  root: string,
  rel: string,
  create: boolean,
): { ok: true; parent: string; absolute: string; missingDirs: boolean } | { ok: false; state: "invalid" | "outside"; error: string } {
  const segments = rel.split("/");
  const fileName = segments.pop()!;
  let current = root;
  let missingDirs = false;
  for (const segment of segments) {
    const next = path.join(current, segment);
    let st;
    try {
      st = lstatSync(next);
    } catch (error) {
      if (errorCode(error) !== "ENOENT") return { ok: false, state: "invalid", error: `Couldn't check ${segment}/.` };
      if (!create) {
        missingDirs = true;
        current = next;
        continue;
      }
      try {
        mkdirSync(next, { mode: 0o755 });
      } catch (mkdirError) {
        if (errorCode(mkdirError) !== "EEXIST") {
          return { ok: false, state: "invalid", error: `Couldn't create the folder ${segment}/: ${(mkdirError as Error).message}` };
        }
      }
      st = lstatSync(next);
    }
    if (st.isSymbolicLink()) {
      let real: string;
      try {
        real = realpathSync(next);
      } catch {
        return { ok: false, state: "invalid", error: `${segment}/ is a broken link.` };
      }
      if (!isInside(root, real)) return { ok: false, state: "outside", error: `${segment}/ links outside the project.` };
      if (!statSync(real).isDirectory()) return { ok: false, state: "invalid", error: `${segment} is not a folder.` };
      current = real;
      continue;
    }
    if (!st.isDirectory()) return { ok: false, state: "invalid", error: `${segment} is a file, not a folder.` };
    current = next;
  }
  return { ok: true, parent: current, absolute: path.join(current, fileName), missingDirs };
}

function existsAtAll(absolute: string): boolean {
  try {
    lstatSync(absolute);
    return true;
  } catch {
    return false;
  }
}

function checkOne(root: string | null, plannedRoot: string, kind: DocKind, rel: string): DocTargetCheck {
  if (!root) {
    // The project folder doesn't exist yet: it is created on confirm, empty.
    return { kind, path: rel, state: "free", absolute: path.join(plannedRoot, rel), error: null };
  }
  const resolved = resolveTarget(root, rel, false);
  if (!resolved.ok) return { kind, path: rel, state: resolved.state, absolute: null, error: resolved.error };
  if (!resolved.missingDirs && existsAtAll(resolved.absolute)) {
    return { kind, path: rel, state: "exists", absolute: resolved.absolute, error: `${rel} already exists. It will not be overwritten.` };
  }
  return { kind, path: rel, state: "free", absolute: resolved.absolute, error: null };
}

function rootOf(projectPath: string): { ok: true; real: string | null } | Failure {
  if (!path.isAbsolute(projectPath)) return { ok: false, status: 400, error: "projectPath must be absolute" };
  try {
    const st = statSync(projectPath);
    if (!st.isDirectory()) return { ok: false, status: 400, error: "projectPath is not a directory" };
    return { ok: true, real: realpathSync(projectPath) };
  } catch (error) {
    if (errorCode(error) === "ENOENT") return { ok: true, real: null };
    return { ok: false, status: 400, error: "Couldn't read the project folder." };
  }
}

/** Read-only: where each target would land and whether it's free. */
export function checkDocTargets(body: { projectPath?: unknown; files?: unknown }):
  | { ok: true; projectExists: boolean; checks: DocTargetCheck[] }
  | Failure {
  const projectPath = typeof body.projectPath === "string" ? body.projectPath.trim() : "";
  if (!projectPath) return { ok: false, status: 400, error: "projectPath required" };
  const parsed = parseFiles(body.files, false);
  if (!parsed.ok) return parsed;
  const root = rootOf(projectPath);
  if (!root.ok) return root;
  return {
    ok: true,
    projectExists: root.real != null,
    checks: parsed.files.map((file) => checkOne(root.real, projectPath, file.kind, file.path)),
  };
}

/** Test seams for racing the write (FO-003.1). */
export const __testing = {
  hooks: {} as {
    /** Runs after the parent re-check, before the temp file is opened. */
    beforeOpen?: (absolute: string) => void;
    /** Runs after the temp file is written, before it's linked into place. */
    beforeLink?: (absolute: string) => void;
  },
};

class WriteError extends Error {
  constructor(message: string, readonly code?: string) {
    super(message);
  }
}

const TMP_FLAGS = fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_NOFOLLOW;

function sameInode(target: string, ino: number, dev: number): boolean {
  try {
    const st = lstatSync(target);
    return st.ino === ino && st.dev === dev;
  } catch {
    return false;
  }
}

function writeExclusive(root: string, parent: string, absolute: string, content: string): void {
  // The parent was resolved through realpath; it must still be itself.
  let parentReal: string;
  try {
    parentReal = realpathSync(parent);
  } catch {
    throw new WriteError("The folder changed while saving.");
  }
  if (parentReal !== parent || !isInside(root, parentReal)) throw new WriteError("The folder changed while saving.");

  __testing.hooks.beforeOpen?.(absolute);
  const tmp = path.join(parent, `.${path.basename(absolute)}.${crypto.randomUUID().slice(0, 8)}.tmp`);
  let fd: number | null;
  try {
    fd = openSync(tmp, TMP_FLAGS, 0o644);
  } catch (error) {
    throw new WriteError((error as Error).message, errorCode(error));
  }
  let ino = 0;
  let dev = 0;
  try {
    writeSync(fd, content);
    fsyncSync(fd);
    ({ ino, dev } = fstatSync(fd));
    closeSync(fd);
    fd = null;
    __testing.hooks.beforeLink?.(absolute);
    linkSync(tmp, absolute);
  } catch (error) {
    throw new WriteError((error as Error).message, errorCode(error));
  } finally {
    if (fd != null) {
      try {
        closeSync(fd);
      } catch {
        /* already closed */
      }
    }
    // The temp name is ours (created O_EXCL); remove it whatever happened.
    try {
      if (sameInode(tmp, ino, dev) || ino === 0) unlinkSync(tmp);
    } catch {
      /* already gone */
    }
  }

  let finalReal: string | null = null;
  try {
    finalReal = realpathSync(absolute);
  } catch {
    finalReal = null;
  }
  if (!finalReal || !isInside(root, finalReal) || !sameInode(finalReal, ino, dev)) {
    if (finalReal && sameInode(finalReal, ino, dev)) {
      try {
        unlinkSync(finalReal);
      } catch {
        /* best effort */
      }
    }
    throw new WriteError("The folder changed while saving, so the document was not kept.");
  }
}

/**
 * Create the accepted documents inside a registered project. Validation
 * and the free-check run for every file first; any problem refuses the
 * whole request with 409 and writes nothing.
 */
export function writeProjectDocs(body: { projectPath?: unknown; files?: unknown }):
  | { ok: true; results: DocWriteResult[] }
  | (Failure & { checks?: DocTargetCheck[] }) {
  const projectPath = typeof body.projectPath === "string" ? body.projectPath.trim() : "";
  if (!projectPath) return { ok: false, status: 400, error: "projectPath required" };
  const parsed = parseFiles(body.files, true);
  if (!parsed.ok) return parsed;
  const root = rootOf(projectPath);
  if (!root.ok) return root;
  if (!root.real) return { ok: false, status: 404, error: "The project folder does not exist." };
  if (!findRegisteredDuplicate(root.real)) {
    return { ok: false, status: 404, error: "Add the project before saving its documents." };
  }
  const realRoot = root.real;
  const checks = parsed.files.map((file) => checkOne(realRoot, realRoot, file.kind, file.path));
  const blocked = checks.find((check) => check.state !== "free");
  if (blocked) {
    return { ok: false, status: 409, error: blocked.error ?? `${blocked.path} can't be created.`, checks };
  }

  const results: DocWriteResult[] = [];
  for (const file of parsed.files) {
    const resolved = resolveTarget(realRoot, file.path, true);
    if (!resolved.ok) {
      results.push({ kind: file.kind, path: file.path, status: "failed", absolute: null, error: resolved.error });
      continue;
    }
    try {
      writeExclusive(realRoot, resolved.parent, resolved.absolute, file.content);
    } catch (error) {
      const code = error instanceof WriteError ? error.code : errorCode(error);
      const message = code === "EEXIST"
        ? `${file.path} appeared while saving. It was not overwritten.`
        : `Couldn't write ${file.path}: ${(error as Error).message}`;
      results.push({ kind: file.kind, path: file.path, status: "failed", absolute: resolved.absolute, error: message });
      continue;
    }
    let verified = false;
    try {
      verified = readFileSync(resolved.absolute, "utf8") === file.content;
    } catch {
      verified = false;
    }
    results.push(
      verified
        ? { kind: file.kind, path: file.path, status: "created", absolute: resolved.absolute, error: null }
        : {
          kind: file.kind,
          path: file.path,
          status: "failed",
          absolute: resolved.absolute,
          error: `${file.path} was created but reads back differently. Check it before using it.`,
        },
    );
  }
  return { ok: true, results };
}
