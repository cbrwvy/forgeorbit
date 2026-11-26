/**
 * Markdown bytes for Brain memories.
 *
 * Files live under `<dataDir>/brain/memories/<id>.md`.
 * The id is checked before it is joined. Symlinks are refused.
 * A write lands in a temporary file, is fsynced, then renamed.
 */

import {
  closeSync,
  constants,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  unlinkSync,
  writeSync,
} from "node:fs";
import path from "node:path";
import { isBrainMemoryId } from "../shared/brain/document.ts";
import { BrainError } from "./brain-error.ts";

const NOFOLLOW = typeof constants.O_NOFOLLOW === "number" ? constants.O_NOFOLLOW : 0;

export interface BrainLayout {
  rootReal: string;
  memoriesDir: string;
  revisionsDir: string;
  databasePath: string;
}

export function openBrainLayout(rootDir: string): BrainLayout {
  const rootReal = ensureDir(path.resolve(rootDir));
  const memoriesDir = ensureChild(rootReal, "memories");
  const revisionsDir = ensureChild(rootReal, "revisions");
  const databasePath = path.join(rootReal, "index.sqlite");
  const existing = statOrNull(databasePath);
  if (existing?.isSymbolicLink()) throw new BrainError("Brain storage rejected the path.", 500, "path_rejected");
  return { rootReal, memoriesDir, revisionsDir, databasePath };
}

export function memoryFilePath(layout: BrainLayout, id: string): string {
  assertId(id);
  return path.join(layout.memoriesDir, `${id}.md`);
}

export function writeMemoryFile(layout: BrainLayout, id: string, text: string): void {
  const target = memoryFilePath(layout, id);
  const existing = statOrNull(target);
  if (existing?.isSymbolicLink()) throw new BrainError("Brain storage rejected the path.", 500, "path_rejected");
  const temp = path.join(layout.memoriesDir, `.${id}.${process.pid}.tmp`);
  let fd: number | null = null;
  try {
    fd = openSync(temp, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | NOFOLLOW, 0o600);
    const payload = Buffer.from(text, "utf8");
    let offset = 0;
    while (offset < payload.length) {
      const wrote = writeSync(fd, payload, offset, payload.length - offset);
      if (wrote <= 0) throw new BrainError("Brain storage rejected the write.", 500, "path_rejected");
      offset += wrote;
    }
    fsyncSync(fd);
    closeSync(fd);
    fd = null;
    assertRegularInside(temp, layout.rootReal);
    renameSync(temp, target);
    assertRegularInside(target, layout.rootReal);
    syncDirectory(layout.memoriesDir);
  } catch (error) {
    if (fd != null) {
      try { closeSync(fd); } catch { /* already closed */ }
    }
    unlinkIfRegular(temp, layout.rootReal);
    if (error instanceof BrainError) throw error;
    throw new BrainError("Brain storage rejected the write.", 500, "path_rejected");
  }
}

export function readMemoryFile(layout: BrainLayout, id: string): { text: string } | { missing: true } | { rejected: true } {
  const target = memoryFilePath(layout, id);
  const stat = statOrNull(target);
  if (!stat) return { missing: true };
  if (stat.isSymbolicLink() || !stat.isFile()) return { rejected: true };
  try {
    assertRegularInside(target, layout.rootReal);
  } catch {
    return { rejected: true };
  }
  return { text: readFileSync(target, "utf8") };
}

export function copyRevision(layout: BrainLayout, id: string, revision: number, text: string): void {
  assertId(id);
  if (!Number.isSafeInteger(revision) || revision < 1) {
    throw new BrainError("Invalid revision.", 400, "invalid_request");
  }
  const directory = ensureChild(layout.revisionsDir, id);
  const target = path.join(directory, `${revision}.md`);
  if (statOrNull(target)?.isSymbolicLink()) throw new BrainError("Brain storage rejected the path.", 500, "path_rejected");
  if (statOrNull(target)?.isFile()) return;
  const temp = path.join(directory, `.${revision}.tmp`);
  let fd: number | null = null;
  try {
    fd = openSync(temp, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | NOFOLLOW, 0o600);
    const payload = Buffer.from(text, "utf8");
    writeSync(fd, payload);
    fsyncSync(fd);
    closeSync(fd);
    fd = null;
    renameSync(temp, target);
    assertRegularInside(target, layout.rootReal);
  } catch (error) {
    if (fd != null) {
      try { closeSync(fd); } catch { /* already closed */ }
    }
    unlinkIfRegular(temp, layout.rootReal);
    if (error instanceof BrainError) throw error;
    throw new BrainError("Brain storage rejected the write.", 500, "path_rejected");
  }
}

export function listMemoryNames(layout: BrainLayout): string[] {
  const stat = lstatSync(layout.memoriesDir);
  if (stat.isSymbolicLink() || !stat.isDirectory()) {
    throw new BrainError("Brain storage rejected the path.", 500, "path_rejected");
  }
  return readdirSync(layout.memoriesDir);
}

function assertId(id: string): void {
  if (!isBrainMemoryId(id)) throw new BrainError("Invalid memory id.", 400, "invalid_request");
}

function ensureDir(directory: string): string {
  const existing = statOrNull(directory);
  if (existing?.isSymbolicLink()) throw new BrainError("Brain storage rejected the path.", 500, "path_rejected");
  if (!existing) {
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    syncDirectory(path.dirname(directory));
  }
  const created = lstatSync(directory);
  if (created.isSymbolicLink() || !created.isDirectory()) {
    throw new BrainError("Brain storage rejected the path.", 500, "path_rejected");
  }
  return realpathSync(directory);
}

function ensureChild(parentReal: string, name: string): string {
  if (name !== "memories" && name !== "revisions" && !isBrainMemoryId(name)) {
    throw new BrainError("Brain storage rejected the path.", 500, "path_rejected");
  }
  const directory = path.join(parentReal, name);
  const existing = statOrNull(directory);
  if (existing?.isSymbolicLink()) throw new BrainError("Brain storage rejected the path.", 500, "path_rejected");
  if (!existing) {
    mkdirSync(directory, { mode: 0o700 });
    syncDirectory(parentReal);
  }
  const stat = lstatSync(directory);
  if (stat.isSymbolicLink() || !stat.isDirectory()) {
    throw new BrainError("Brain storage rejected the path.", 500, "path_rejected");
  }
  const real = realpathSync(directory);
  if (!isInside(parentReal, real)) throw new BrainError("Brain storage rejected the path.", 500, "path_rejected");
  return real;
}

function assertRegularInside(file: string, rootReal: string): void {
  const stat = lstatSync(file);
  if (stat.isSymbolicLink() || !stat.isFile()) {
    throw new BrainError("Brain storage rejected the path.", 500, "path_rejected");
  }
  if (!isInside(rootReal, realpathSync(file))) {
    throw new BrainError("Brain storage rejected the path.", 500, "path_rejected");
  }
}

function unlinkIfRegular(file: string, rootReal: string): void {
  const stat = statOrNull(file);
  if (!stat || stat.isSymbolicLink() || !stat.isFile()) return;
  try {
    if (!isInside(rootReal, realpathSync(file))) return;
  } catch {
    return;
  }
  unlinkSync(file);
}

function isInside(rootReal: string, candidateReal: string): boolean {
  const relative = path.relative(rootReal, candidateReal);
  return relative !== "" && !relative.startsWith("..") && !path.isAbsolute(relative);
}

function statOrNull(file: string): ReturnType<typeof lstatSync> | null {
  try {
    return lstatSync(file);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

function syncDirectory(directory: string): void {
  const fd = openSync(directory, constants.O_RDONLY | NOFOLLOW);
  try {
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}
