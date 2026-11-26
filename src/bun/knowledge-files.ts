/**
 * Markdown bytes for knowledge notes.
 *
 * Files live under `<dataDir>/knowledge/bodies/<document-id>/<revision>.md`.
 * The id and revision are checked before they touch the filesystem. A write
 * lands in a temporary file in the same directory, is fsynced, then renamed.
 * Symlinks are refused so a note cannot be aimed outside the managed root.
 */

import { createHash, randomUUID } from "node:crypto";
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
  rmdirSync,
  unlinkSync,
  writeSync,
} from "node:fs";
import path from "node:path";
import { isKnowledgeDocumentId } from "../shared/knowledge/document.ts";
import { KnowledgeError } from "./knowledge-error.ts";

export interface StoredRevision {
  byteLength: number;
  sha256: string;
}

export interface KnowledgeFiles {
  writeRevision(id: string, revision: number, bytes: Uint8Array): StoredRevision;
  readRevision(id: string, revision: number, expectedSha256?: string): Uint8Array;
  removeRevision(id: string, revision: number): void;
  removeDocument(id: string): void;
}

export interface KnowledgeFileHooks {
  beforeRename?: () => void;
  afterRename?: () => void;
}

const NOFOLLOW = typeof constants.O_NOFOLLOW === "number" ? constants.O_NOFOLLOW : 0;

export function createKnowledgeFiles(rootDir: string, hooks: KnowledgeFileHooks = {}): KnowledgeFiles {
  return {
    writeRevision(id, revision, bytes) {
      const location = resolveLocation(rootDir, id, revision, true);
      if (!location) throw new KnowledgeError("Knowledge storage rejected the path.", 500);
      const tempPath = path.join(location.directory, `.${revision}.${randomUUID()}.tmp`);
      let renamed = false;
      let fd: number | null = null;
      try {
        fd = openSync(tempPath, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | NOFOLLOW, 0o600);
        const payload = Buffer.from(bytes);
        let offset = 0;
        while (offset < payload.length) {
          const wrote = writeSync(fd, payload, offset, payload.length - offset);
          if (wrote <= 0) throw new KnowledgeError("Knowledge storage rejected the write.", 500);
          offset += wrote;
        }
        fsyncSync(fd);
        closeSync(fd);
        fd = null;
        assertRegularInside(tempPath, location.rootReal);
        hooks.beforeRename?.();
        renameSync(tempPath, location.file);
        renamed = true;
        hooks.afterRename?.();
        assertRegularInside(location.file, location.rootReal);
        syncDirectory(location.directory);
        return { byteLength: payload.byteLength, sha256: sha256(payload) };
      } catch (error) {
        if (fd != null) {
          try { closeSync(fd); } catch { /* already closed */ }
        }
        unlinkIfInside(tempPath, location.rootReal);
        if (renamed) unlinkIfInside(location.file, location.rootReal);
        if (error instanceof KnowledgeError) throw error;
        throw new KnowledgeError("Knowledge storage rejected the write.", 500);
      }
    },
    readRevision(id, revision, expectedSha256) {
      const location = resolveLocation(rootDir, id, revision, false);
      if (!location) throw new KnowledgeError("Stored Markdown is unavailable.", 500);
      try {
        assertRegularInside(location.file, location.rootReal);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") {
          throw new KnowledgeError("Stored Markdown is unavailable.", 500);
        }
        throw error;
      }
      const bytes = readFileSync(location.file);
      if (expectedSha256 && sha256(bytes) !== expectedSha256) {
        throw new KnowledgeError("Stored Markdown does not match its revision.", 500);
      }
      return bytes;
    },
    removeRevision(id, revision) {
      const location = resolveLocation(rootDir, id, revision, false);
      if (!location) return;
      unlinkIfInside(location.file, location.rootReal);
    },
    removeDocument(id) {
      const location = resolveLocation(rootDir, id, 1, false);
      if (!location) return;
      let names: string[] = [];
      try {
        names = readdirSync(location.directory);
      } catch {
        return;
      }
      for (const name of names) {
        if (!/^(?:[1-9][0-9]{0,9}\.md|\.[1-9][0-9]{0,9}\.[^/]+\.tmp)$/.test(name)) continue;
        unlinkIfInside(path.join(location.directory, name), location.rootReal);
      }
      try {
        const stat = lstatSync(location.directory);
        if (stat.isDirectory() && !stat.isSymbolicLink()) rmdirSync(location.directory);
      } catch {
        /* leftover files stay inside the managed directory */
      }
    },
  };
}

interface Location {
  rootReal: string;
  directory: string;
  file: string;
}

function resolveLocation(rootDir: string, id: string, revision: number, create: boolean): Location | null {
  if (!isKnowledgeDocumentId(id)) throw new KnowledgeError("Invalid document id.", 400);
  if (!Number.isSafeInteger(revision) || revision < 1 || revision > 1_000_000_000) {
    throw new KnowledgeError("Invalid revision.", 400);
  }
  const rootReal = ensureRoot(rootDir);
  const directory = path.join(rootReal, "bodies", id);
  if (create) {
    ensureChildDir(path.join(rootReal, "bodies"), rootReal);
    ensureChildDir(directory, rootReal);
  } else {
    const stat = statOrNull(directory);
    if (!stat) return null;
    if (stat.isSymbolicLink() || !stat.isDirectory()) {
      throw new KnowledgeError("Knowledge storage rejected the path.", 500);
    }
    assertInside(rootReal, realpathSync(directory));
  }
  return { rootReal, directory, file: path.join(directory, `${revision}.md`) };
}

function ensureRoot(rootDir: string): string {
  const resolved = path.resolve(rootDir);
  const existing = statOrNull(resolved);
  if (existing?.isSymbolicLink()) throw new KnowledgeError("Knowledge storage rejected the path.", 500);
  if (!existing) {
    mkdirSync(resolved, { recursive: true, mode: 0o700 });
    syncDirectory(path.dirname(resolved));
  }
  const created = lstatSync(resolved);
  if (created.isSymbolicLink() || !created.isDirectory()) {
    throw new KnowledgeError("Knowledge storage rejected the path.", 500);
  }
  return realpathSync(resolved);
}

function ensureChildDir(directory: string, rootReal: string): void {
  const existing = statOrNull(directory);
  if (existing?.isSymbolicLink()) throw new KnowledgeError("Knowledge storage rejected the path.", 500);
  if (!existing) {
    mkdirSync(directory, { mode: 0o700 });
    syncDirectory(path.dirname(directory));
  }
  const stat = lstatSync(directory);
  if (stat.isSymbolicLink() || !stat.isDirectory()) {
    throw new KnowledgeError("Knowledge storage rejected the path.", 500);
  }
  assertInside(rootReal, realpathSync(directory));
}

function assertRegularInside(file: string, rootReal: string): void {
  const stat = lstatSync(file);
  if (stat.isSymbolicLink() || !stat.isFile()) {
    throw new KnowledgeError("Knowledge storage rejected the path.", 500);
  }
  assertInside(rootReal, realpathSync(file));
}

function unlinkIfInside(file: string, rootReal: string): void {
  const stat = statOrNull(file);
  if (!stat || stat.isSymbolicLink() || !stat.isFile()) return;
  let real: string;
  try {
    real = realpathSync(file);
  } catch {
    return;
  }
  if (!isInside(rootReal, real)) return;
  unlinkSync(file);
}

function assertInside(rootReal: string, candidateReal: string): void {
  if (!isInside(rootReal, candidateReal)) {
    throw new KnowledgeError("Knowledge storage rejected the path.", 500);
  }
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

function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

/** Persist directory entries before SQLite can commit references to them. */
function syncDirectory(directory: string): void {
  const fd = openSync(directory, constants.O_RDONLY | NOFOLLOW);
  try {
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}
