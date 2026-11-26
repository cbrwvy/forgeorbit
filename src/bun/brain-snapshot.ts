/**
 * Consistent Brain snapshot for the profile backup engine (FO-BRAIN02-A).
 *
 * The live index is not copied. A reserved lock is held only while the
 * committed rows and their Markdown bytes are read. The staging index is a
 * new database built from that read. Pending rows are omitted and counted.
 * A hash mismatch releases the lock and fails the attempt so a writer that
 * changed a file before its index commit cannot publish a mixed snapshot.
 */

import { createHash } from "node:crypto";
import {
  closeSync,
  existsSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  realpathSync,
  writeSync,
} from "node:fs";
import path from "node:path";
import { Database } from "bun:sqlite";
import { BRAIN_SCHEMA_SQL } from "./brain-store.ts";
import { decodeMemoryFile, isBrainMemoryId } from "../shared/brain/document.ts";
import {
  BRAIN_PROJECT_SCOPE_CAP,
  BRAIN_SNAPSHOT_INDEX,
  parseBrainSnapshotPath,
  type SnapshotBrainRecord,
} from "../shared/brain/snapshot.ts";

const LOCK_WAIT_MS = 1_500;
const LOCK_HOLD_MS = 5_000;

export class BrainSnapshotError extends Error {
  constructor(
    message: string,
    readonly code: "busy" | "inconsistent" | "symlink" | "unsafe_path",
  ) {
    super(message);
    this.name = "BrainSnapshotError";
  }
}

interface MemoryRow {
  id: string;
  scope_kind: string;
  scope_id: string;
  title: string;
  kind: string;
  status: string;
  origin: string;
  provenance_json: string;
  revision: number;
  content_sha256: string;
  byte_length: number;
  body: string;
  created_at: number;
  updated_at: number;
  archived_at: number | null;
  durability: string;
}

interface RevisionRow {
  memory_id: string;
  revision: number;
  content_sha256: string;
  byte_length: number;
  title: string;
  kind: string;
  status: string;
  created_at: number;
}

interface RequestRow {
  request_id: string;
  memory_id: string;
  payload_sha256: string;
  created_at: number;
}

interface CapturedFile {
  relativePath: string;
  bytes: Buffer;
}

export interface BrainCaptureFile {
  path: string;
  bytes: number;
  sha256: string;
  category: "brain";
}

export interface BrainCapture {
  record: SnapshotBrainRecord;
  files: BrainCaptureFile[];
}

export function captureBrainSnapshot(input: {
  sourceRoot: string;
  stagingDir: string;
  registeredProjectPaths: readonly string[];
}): BrainCapture {
  const sourceRoot = path.resolve(input.sourceRoot);
  if (!existsSync(sourceRoot)) return absentCapture();
  const rootStat = lstatSync(sourceRoot);
  if (rootStat.isSymbolicLink()) {
    throw new BrainSnapshotError(`Brain root is a symbolic link: ${sourceRoot}`, "symlink");
  }
  if (!rootStat.isDirectory()) {
    throw new BrainSnapshotError(`Brain root is not a directory: ${sourceRoot}`, "unsafe_path");
  }
  const rootReal = realpathSync(sourceRoot);
  const indexPath = path.join(rootReal, "index.sqlite");
  if (!existsSync(indexPath)) {
    if (unexpectedPayload(rootReal)) {
      throw new BrainSnapshotError("Brain directory has files but no index.", "inconsistent");
    }
    return absentCapture();
  }
  const indexStat = lstatSync(indexPath);
  if (indexStat.isSymbolicLink() || !indexStat.isFile()) {
    throw new BrainSnapshotError("Brain index is not a regular file.", "symlink");
  }
  assertInside(rootReal, indexPath);

  const started = Date.now();
  const db = new Database(indexPath);
  let locked = false;
  try {
    db.run(`PRAGMA busy_timeout = ${LOCK_WAIT_MS}`);
    try {
      db.run("BEGIN IMMEDIATE");
      locked = true;
    } catch (error) {
      throw new BrainSnapshotError(
        `Brain snapshot could not lock the index: ${(error as Error).message}`,
        "busy",
      );
    }
    const schema = db.query("SELECT version FROM brain_schema WHERE id = 1").get() as { version: number } | null;
    if (!schema || schema.version !== 1) {
      throw new BrainSnapshotError("Brain index schema is not version 1.", "inconsistent");
    }
    const memories = db.query("SELECT * FROM brain_memories").all() as MemoryRow[];
    const revisions = db.query("SELECT * FROM brain_revisions").all() as RevisionRow[];
    const requests = db.query("SELECT * FROM brain_requests").all() as RequestRow[];
    const committed = memories.filter((row) => row.durability === "committed");
    const pending = memories.filter((row) => row.durability !== "committed");
    const committedIds = new Set(committed.map((row) => row.id));
    const files: CapturedFile[] = [];
    for (const row of committed) {
      if (Date.now() - started > LOCK_HOLD_MS) {
        throw new BrainSnapshotError("Brain snapshot released its lock before the hold deadline.", "busy");
      }
      const relative = `brain/memories/${row.id}.md`;
      const absolute = path.join(rootReal, "memories", `${row.id}.md`);
      const bytes = readRegular(rootReal, absolute);
      assertCurrentFile(row, bytes);
      files.push({ relativePath: relative, bytes });
      const history = revisions.filter((revision) => revision.memory_id === row.id && revision.revision < row.revision);
      for (const revision of history) {
        const revisionRelative = `brain/revisions/${row.id}/${revision.revision}.md`;
        const revisionAbsolute = path.join(rootReal, "revisions", row.id, `${revision.revision}.md`);
        if (!existsSync(revisionAbsolute)) {
          throw new BrainSnapshotError(`Missing Brain revision file ${revisionRelative}.`, "inconsistent");
        }
        const revisionBytes = readRegular(rootReal, revisionAbsolute);
        assertRevisionFile(row, revision, revisionBytes);
        files.push({ relativePath: revisionRelative, bytes: revisionBytes });
      }
    }
    const unindexedExcluded = countUnindexed(rootReal, committedIds, new Set(pending.map((row) => row.id)));
    const registered = new Set(input.registeredProjectPaths);
    const scopeCounts = new Map<string, { count: number; registered: boolean }>();
    let archivedCount = 0;
    let orphanedProjectCount = 0;
    for (const row of committed) {
      if (row.status === "archived") archivedCount += 1;
      if (row.scope_kind !== "project") continue;
      const known = registered.has(row.scope_id);
      if (!known) orphanedProjectCount += 1;
      const current = scopeCounts.get(row.scope_id) ?? { count: 0, registered: known };
      current.count += 1;
      scopeCounts.set(row.scope_id, current);
    }
    const projectScopes = [...scopeCounts.entries()].map(([scopeId, value]) => ({
      scopeId,
      count: value.count,
      registered: value.registered,
    }));
    const record: SnapshotBrainRecord = {
      coverage: "included",
      schemaVersion: 1,
      memoryCount: committed.length,
      archivedCount,
      revisionCount: revisions.filter((revision) => committedIds.has(revision.memory_id)).length,
      pendingExcluded: pending.length,
      unindexedExcluded,
      orphanedProjectCount,
      projectScopesTruncated: projectScopes.length > BRAIN_PROJECT_SCOPE_CAP,
      projectScopes: projectScopes.slice(0, BRAIN_PROJECT_SCOPE_CAP),
    };
    const keptRevisions = revisions.filter((revision) => committedIds.has(revision.memory_id));
    const keptRequests = requests.filter((request) => committedIds.has(request.memory_id));
    db.run("COMMIT");
    locked = false;
    db.close();
    const indexBytes = writeStaging(input.stagingDir, files, committed, keptRevisions, keptRequests);
    const packaged: BrainCaptureFile[] = [
      {
        path: BRAIN_SNAPSHOT_INDEX,
        bytes: indexBytes.length,
        sha256: sha256(indexBytes),
        category: "brain",
      },
    ];
    for (const file of files) {
      packaged.push({
        path: file.relativePath,
        bytes: file.bytes.length,
        sha256: sha256(file.bytes),
        category: "brain",
      });
    }
    packaged.sort((a, b) => a.path.localeCompare(b.path));
    return { record, files: packaged };
  } catch (error) {
    if (locked) {
      try { db.run("ROLLBACK"); } catch { /* already closed */ }
    }
    try { db.close(); } catch { /* already closed */ }
    if (error instanceof BrainSnapshotError) throw error;
    const message = (error as Error).message ?? "Brain snapshot failed";
    if (/busy|locked/i.test(message)) throw new BrainSnapshotError(message, "busy");
    throw new BrainSnapshotError(message, "inconsistent");
  }
}

/** Checks a packaged Brain tree. Issues are empty only when the category matches its files. */
export function verifyPackagedBrain(
  snapshotDir: string,
  brain: SnapshotBrainRecord | undefined,
  files: readonly { path: string }[],
): string[] {
  const brainFiles = files
    .map((file) => file.path.replaceAll("\\", "/"))
    .filter((filePath) => filePath === BRAIN_SNAPSHOT_INDEX || filePath.startsWith("brain/"));
  if (!brain || brain.coverage === "absent") {
    return brainFiles.length === 0 ? [] : ["Brain files are present on a snapshot that does not include Brain."];
  }
  if (brain.coverage !== "included" || brain.schemaVersion !== 1) {
    return ["Brain snapshot record is invalid."];
  }
  const issues: string[] = [];
  if (!brainFiles.includes(BRAIN_SNAPSHOT_INDEX)) issues.push("Brain snapshot is missing brain/index.sqlite.");
  for (const filePath of brainFiles) {
    if (!parseBrainSnapshotPath(filePath).ok) issues.push(`Brain snapshot path is not allowed: ${filePath}`);
  }
  if (issues.length > 0) return issues;
  const indexPath = path.join(snapshotDir, "brain", "index.sqlite");
  let db: Database | null = null;
  try {
    const indexStat = lstatSync(indexPath);
    if (indexStat.isSymbolicLink() || !indexStat.isFile()) {
      return ["Brain index is not a regular file."];
    }
    db = new Database(indexPath, { readonly: true });
    const integrity = db.query("PRAGMA integrity_check").get() as { integrity_check: string } | null;
    if (!integrity || integrity.integrity_check !== "ok") issues.push("Brain index failed integrity_check.");
    const schema = db.query("SELECT version FROM brain_schema WHERE id = 1").get() as { version: number } | null;
    if (!schema || schema.version !== 1) issues.push("Brain index schema is not version 1.");
    const memories = db.query("SELECT * FROM brain_memories").all() as MemoryRow[];
    const revisions = db.query("SELECT * FROM brain_revisions").all() as RevisionRow[];
    if (memories.some((row) => row.durability !== "committed")) {
      issues.push("Brain snapshot index still contains a pending write.");
    }
    const expected = new Set<string>([BRAIN_SNAPSHOT_INDEX]);
    let archived = 0;
    for (const row of memories) {
      if (row.durability !== "committed") continue;
      if (row.status === "archived") archived += 1;
      const relative = `brain/memories/${row.id}.md`;
      expected.add(relative);
      const absolute = path.join(snapshotDir, "brain", "memories", `${row.id}.md`);
      if (!brainFiles.includes(relative) || !existsSync(absolute)) {
        issues.push(`Brain snapshot is missing ${relative}.`);
        continue;
      }
      try {
        assertCurrentFile(row, readRegular(realpathSync(path.join(snapshotDir, "brain")), absolute));
      } catch (error) {
        issues.push(error instanceof BrainSnapshotError ? error.message : `Brain file ${relative} is not consistent.`);
      }
      for (const revision of revisions.filter((item) => item.memory_id === row.id && item.revision < row.revision)) {
        const revisionRelative = `brain/revisions/${row.id}/${revision.revision}.md`;
        expected.add(revisionRelative);
        const revisionAbsolute = path.join(snapshotDir, "brain", "revisions", row.id, `${revision.revision}.md`);
        if (!brainFiles.includes(revisionRelative) || !existsSync(revisionAbsolute)) {
          issues.push(`Brain snapshot is missing ${revisionRelative}.`);
          continue;
        }
        try {
          assertRevisionFile(row, revision, readRegular(realpathSync(path.join(snapshotDir, "brain")), revisionAbsolute));
        } catch (error) {
          issues.push(error instanceof BrainSnapshotError ? error.message : `Brain revision ${revisionRelative} is not consistent.`);
        }
      }
    }
    for (const filePath of brainFiles) {
      if (!expected.has(filePath)) issues.push(`Brain snapshot contains an unexpected file: ${filePath}`);
    }
    if (memories.filter((row) => row.durability === "committed").length !== brain.memoryCount) {
      issues.push("Brain memory count does not match the snapshot record.");
    }
    if (archived !== brain.archivedCount) issues.push("Brain archived count does not match the snapshot record.");
    const committedIds = new Set(memories.filter((row) => row.durability === "committed").map((row) => row.id));
    const revisionCount = revisions.filter((revision) => committedIds.has(revision.memory_id)).length;
    if (revisionCount !== brain.revisionCount) issues.push("Brain revision count does not match the snapshot record.");
  } catch (error) {
    issues.push(`Brain index could not be verified: ${(error as Error).message}`);
  } finally {
    try { db?.close(); } catch { /* already closed */ }
  }
  return issues;
}

function absentCapture(): BrainCapture {
  return {
    record: {
      coverage: "absent",
      schemaVersion: 1,
      memoryCount: 0,
      archivedCount: 0,
      revisionCount: 0,
      pendingExcluded: 0,
      unindexedExcluded: 0,
      orphanedProjectCount: 0,
      projectScopesTruncated: false,
      projectScopes: [],
    },
    files: [],
  };
}

function writeStaging(
  stagingDir: string,
  files: readonly CapturedFile[],
  memories: readonly MemoryRow[],
  revisions: readonly RevisionRow[],
  requests: readonly RequestRow[],
): Buffer {
  for (const file of files) {
    const target = path.join(stagingDir, ...file.relativePath.split("/"));
    mkdirSync(path.dirname(target), { recursive: true, mode: 0o700 });
    writeDurable(target, file.bytes);
  }
  const indexPath = path.join(stagingDir, "brain", "index.sqlite");
  mkdirSync(path.dirname(indexPath), { recursive: true, mode: 0o700 });
  const db = new Database(indexPath, { create: true });
  try {
    db.run("PRAGMA journal_mode = DELETE");
    db.run("PRAGMA foreign_keys = ON");
    db.exec(BRAIN_SCHEMA_SQL);
    const tx = db.transaction(() => {
      db.run("INSERT INTO brain_schema (id, version) VALUES (1, 1)");
      for (const row of memories) {
        db.run(
          `INSERT INTO brain_memories (
            id, scope_kind, scope_id, title, kind, status, origin, provenance_json, revision,
            content_sha256, byte_length, body, created_at, updated_at, archived_at, durability
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'committed')`,
          [
            row.id, row.scope_kind, row.scope_id, row.title, row.kind, row.status, row.origin,
            row.provenance_json, row.revision, row.content_sha256, row.byte_length, row.body,
            row.created_at, row.updated_at, row.archived_at,
          ],
        );
      }
      for (const revision of revisions) {
        db.run(
          `INSERT INTO brain_revisions (memory_id, revision, content_sha256, byte_length, title, kind, status, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
          [
            revision.memory_id, revision.revision, revision.content_sha256, revision.byte_length,
            revision.title, revision.kind, revision.status, revision.created_at,
          ],
        );
      }
      for (const request of requests) {
        db.run(
          "INSERT INTO brain_requests (request_id, memory_id, payload_sha256, created_at) VALUES (?, ?, ?, ?)",
          [request.request_id, request.memory_id, request.payload_sha256, request.created_at],
        );
      }
    });
    tx();
    const integrity = db.query("PRAGMA integrity_check").get() as { integrity_check: string };
    if (integrity.integrity_check !== "ok") {
      throw new BrainSnapshotError("Exported Brain index failed integrity_check.", "inconsistent");
    }
  } finally {
    db.close();
  }
  for (const suffix of ["-wal", "-shm", "-journal"]) {
    const sidecar = `${indexPath}${suffix}`;
    if (existsSync(sidecar)) {
      throw new BrainSnapshotError("Exported Brain index left a journal sidecar.", "inconsistent");
    }
  }
  return readFileSync(indexPath);
}

function assertCurrentFile(row: MemoryRow, bytes: Buffer): void {
  const decoded = decodeMemoryFile(bytes.toString("utf8"));
  if (!decoded.ok) throw new BrainSnapshotError(`Brain file for ${row.id} could not be read.`, "inconsistent");
  const hash = sha256(decoded.body);
  if (hash !== row.content_sha256 || hash !== decoded.header.contentSha256 || decoded.body !== row.body) {
    throw new BrainSnapshotError(`Brain file for ${row.id} does not match the index hash.`, "inconsistent");
  }
  if (
    decoded.header.id !== row.id ||
    decoded.header.scopeKind !== row.scope_kind ||
    decoded.header.scopeId !== row.scope_id ||
    decoded.header.revision !== row.revision ||
    decoded.header.status !== row.status
  ) {
    throw new BrainSnapshotError(`Brain file for ${row.id} does not match the index metadata.`, "inconsistent");
  }
}

function assertRevisionFile(memory: MemoryRow, revision: RevisionRow, bytes: Buffer): void {
  const decoded = decodeMemoryFile(bytes.toString("utf8"));
  if (!decoded.ok) {
    throw new BrainSnapshotError(`Brain revision ${memory.id}/${revision.revision} could not be read.`, "inconsistent");
  }
  const hash = sha256(decoded.body);
  if (hash !== revision.content_sha256 || decoded.header.id !== memory.id || decoded.header.revision !== revision.revision) {
    throw new BrainSnapshotError(
      `Brain revision ${memory.id}/${revision.revision} does not match the index hash.`,
      "inconsistent",
    );
  }
  if (decoded.header.scopeId !== memory.scope_id || decoded.header.scopeKind !== memory.scope_kind) {
    throw new BrainSnapshotError(`Brain revision ${memory.id}/${revision.revision} changed scope.`, "inconsistent");
  }
}

function readRegular(rootReal: string, filePath: string): Buffer {
  let stat;
  try {
    stat = lstatSync(filePath);
  } catch {
    throw new BrainSnapshotError(`Brain file is missing: ${filePath}`, "inconsistent");
  }
  if (stat.isSymbolicLink()) throw new BrainSnapshotError(`Brain path is a symbolic link: ${filePath}`, "symlink");
  if (!stat.isFile()) throw new BrainSnapshotError(`Brain path is not a regular file: ${filePath}`, "unsafe_path");
  assertInside(rootReal, filePath);
  return readFileSync(filePath);
}

function countUnindexed(rootReal: string, committed: Set<string>, pending: Set<string>): number {
  let extra = 0;
  const memoriesDir = path.join(rootReal, "memories");
  if (existsSync(memoriesDir)) {
    const dirStat = lstatSync(memoriesDir);
    if (dirStat.isSymbolicLink()) throw new BrainSnapshotError("Brain memories directory is a symbolic link.", "symlink");
    for (const name of readdirSync(memoriesDir)) {
      if (name.startsWith(".")) continue;
      const full = path.join(memoriesDir, name);
      const stat = lstatSync(full);
      if (stat.isSymbolicLink()) throw new BrainSnapshotError(`Brain path is a symbolic link: ${full}`, "symlink");
      if (!name.endsWith(".md")) {
        extra += 1;
        continue;
      }
      const id = name.slice(0, -3);
      if (!isBrainMemoryId(id) || (!committed.has(id) && !pending.has(id))) extra += 1;
    }
  }
  const revisionsDir = path.join(rootReal, "revisions");
  if (existsSync(revisionsDir)) {
    const dirStat = lstatSync(revisionsDir);
    if (dirStat.isSymbolicLink()) throw new BrainSnapshotError("Brain revisions directory is a symbolic link.", "symlink");
    for (const name of readdirSync(revisionsDir)) {
      if (name.startsWith(".")) continue;
      const full = path.join(revisionsDir, name);
      const stat = lstatSync(full);
      if (stat.isSymbolicLink()) throw new BrainSnapshotError(`Brain path is a symbolic link: ${full}`, "symlink");
      if (!isBrainMemoryId(name) || (!committed.has(name) && !pending.has(name))) extra += 1;
    }
  }
  return extra;
}

function unexpectedPayload(rootReal: string): boolean {
  for (const name of ["memories", "revisions"]) {
    const directory = path.join(rootReal, name);
    if (!existsSync(directory)) continue;
    const stat = lstatSync(directory);
    if (stat.isSymbolicLink()) throw new BrainSnapshotError(`Brain path is a symbolic link: ${directory}`, "symlink");
    if (readdirSync(directory).some((entry) => !entry.startsWith("."))) return true;
  }
  return readdirSync(rootReal).some((entry) => entry !== "memories" && entry !== "revisions" && !entry.startsWith("."));
}

function assertInside(rootReal: string, filePath: string): void {
  const real = realpathSync(filePath);
  const relative = path.relative(rootReal, real);
  if (relative === "" || relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new BrainSnapshotError(`Brain path escapes the Brain root: ${filePath}`, "unsafe_path");
  }
}

function writeDurable(filePath: string, bytes: Buffer): void {
  const fd = openSync(filePath, "w", 0o600);
  try {
    writeSync(fd, bytes);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}

function sha256(value: Buffer | string): string {
  const hash = createHash("sha256");
  hash.update(value);
  return hash.digest("hex");
}
