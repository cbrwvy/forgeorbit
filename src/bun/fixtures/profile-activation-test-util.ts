/**
 * Shared synthetic fixtures for the FO-P2-005-A activation tests.
 *
 * Every profile, snapshot, restore and control directory lives under a fresh
 * temporary root. Nothing here can read or write the owner's real ForgeOrbit
 * profile: the environment is always overridden before a child process imports
 * runtime modules.
 */

import { Database } from "bun:sqlite";
import { createHash, randomUUID } from "node:crypto";
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  lstatSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { BackupService, type BackupRunnerLike } from "../backup-service.ts";
import { migrate } from "../migrate.ts";
import { createPrivateSqliteFile } from "../private-storage.ts";
import { migrations } from "../migrations/index.ts";
import { isBackupStateTerminal, type BackupOperationView } from "../../shared/backup.ts";

export const PROBE_PATH = path.join(import.meta.dir, "profile-activation-probe.ts");

export interface SyntheticRoot {
  root: string;
  cleanup(): void;
}

export function makeRoot(prefix: string): SyntheticRoot {
  const root = mkdtempSync(path.join(tmpdir(), prefix));
  return {
    root,
    cleanup() {
      try {
        rmSync(root, { recursive: true, force: true });
      } catch {
        /* best effort */
      }
    },
  };
}

export function ensureDir(dir: string): string {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  return dir;
}

export function sha256Bytes(value: string | Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

export interface SyntheticProfileOptions {
  tasks?: Array<{
    id: string;
    refs?: string[];
    title?: string;
  }>;
  attachment?: { relativePath: string; bytes: string };
  knowledge?: { title: string; body: string };
  /** Write a WAL-mode database (default) or a plain rollback-journal database. */
  journalMode?: "wal" | "delete";
  /** Stop after this migration id, like a profile last opened by an older build. */
  throughMigration?: string;
  /** Extra rows, written before the database is closed. */
  seed?: (db: Database, now: number) => void;
}

export interface SyntheticProfile {
  dataDir: string;
  dbPath: string;
}

/**
 * Create a migrated profile with optional internal assets. The database is
 * closed before returning so it is never held open across an activation test.
 */
export function createSyntheticProfile(
  dataDir: string,
  options: SyntheticProfileOptions = {},
): SyntheticProfile {
  ensureDir(dataDir);
  for (const category of ["knowledge", "attachments", "screenshots", "issue-threads", "pipeline-runs"]) {
    ensureDir(path.join(dataDir, category));
  }
  const dbPath = path.join(dataDir, "agetor.sqlite");
  createPrivateSqliteFile(dbPath);
  const db = new Database(dbPath);
  db.run("PRAGMA foreign_keys = ON;");
  if ((options.journalMode ?? "wal") === "wal") db.run("PRAGMA journal_mode = WAL;");
  if (options.throughMigration) {
    const last = migrations.findIndex((m) => m.id === options.throughMigration);
    if (last < 0) throw new Error(`unknown migration ${options.throughMigration}`);
    migrate(db, migrations.slice(0, last + 1));
  } else {
    migrate(db, migrations);
  }
  const now = Date.now();
  for (const task of options.tasks ?? [{ id: "task-synthetic" }]) {
    db.run(
      "INSERT INTO tasks (id, title, prompt, column, agent, workdir, refs, created_at, updated_at) VALUES (?, ?, ?, 'review', 'claude-code', ?, ?, ?, ?);",
      [task.id, task.title ?? `Synthetic ${task.id}`, "Synthetic only", dataDir, JSON.stringify(task.refs ?? []), now, now],
    );
  }
  options.seed?.(db, now);
  if (options.attachment) {
    const target = path.join(dataDir, options.attachment.relativePath);
    ensureDir(path.dirname(target));
    writeFileSync(target, options.attachment.bytes, { mode: 0o600 });
    chmodSync(target, 0o600);
  }
  if (options.knowledge) {
    const documentId = randomUUID();
    const bytes = Buffer.from(options.knowledge.body, "utf8");
    const file = path.join(dataDir, "knowledge", "bodies", documentId, "1.md");
    ensureDir(path.dirname(file));
    writeFileSync(file, bytes, { mode: 0o600 });
    chmodSync(file, 0o600);
    db.run(
      `INSERT INTO knowledge_documents (id, owner_kind, owner_id, title, description, category, tags_json, sensitive, revision, created_at, updated_at, archived_at, content_sha256, byte_length)
       VALUES (?, 'company', 'company:test', ?, '', 'general', '[]', 0, 1, ?, ?, NULL, ?, ?);`,
      [documentId, options.knowledge.title, now, now, sha256Bytes(bytes), bytes.byteLength],
    );
    db.run(
      `INSERT INTO knowledge_revisions (document_id, revision, created_at, byte_length, content_sha256)
       VALUES (?, 1, ?, ?, ?);`,
      [documentId, now, bytes.byteLength, sha256Bytes(bytes)],
    );
  }
  // Checkpoint WAL into the main file, then switch to a plain journal so the
  // restored copy is a self-contained single file.
  if ((options.journalMode ?? "wal") === "wal") {
    db.run("PRAGMA wal_checkpoint(TRUNCATE);");
    // Leave a self-contained rollback-journal database so a read-only open
    // (preflight, verification) does not need to create -shm files.
    db.run("PRAGMA journal_mode = DELETE;");
  }
  db.close();
  chmodSync(dbPath, 0o600);
  for (const suffix of ["-wal", "-shm"]) {
    try {
      rmSync(`${dbPath}${suffix}`, { force: true });
    } catch {
      /* ignore */
    }
  }
  return { dataDir, dbPath };
}

export interface VerifiedSnapshot {
  snapshotPath: string;
  verificationId: string;
  service: BackupService;
}

export function makeBackupService(source: SyntheticProfile, root: string): BackupService {
  return new BackupService({
    dataDir: source.dataDir,
    dbPath: source.dbPath,
    registryPath: path.join(root, "registry", "backup-registry.json"),
  });
}

export async function waitForOperation(
  service: BackupService,
  operationId: string,
  timeoutMs = 120_000,
): Promise<BackupOperationView> {
  const deadline = Date.now() + timeoutMs;
  let last = service.getOperation(operationId);
  while (Date.now() < deadline) {
    last = service.getOperation(operationId);
    if (last && isBackupStateTerminal(last.state)) {
      return last;
    }
    await Bun.sleep(25);
  }
  return last;
}

export async function createVerifiedSnapshot(input: {
  source: SyntheticProfile;
  root: string;
  parent: string;
}): Promise<VerifiedSnapshot> {
  ensureDir(input.parent);
  const service = makeBackupService(input.source, input.root);
  const grant = service.issueDestinationGrant(input.parent, "backup-parent");
  const created = await waitForOperation(service, service.startCreate(grant.id).id);
  if (created.state !== "completed" || !created.snapshotPath) {
    throw new Error(`synthetic snapshot failed: ${created.state} ${created.error?.message ?? ""}`);
  }
  const verified = await waitForOperation(service, service.startVerify(created.snapshotPath).id);
  if (verified.state !== "completed" || !verified.verify?.ok) {
    throw new Error(`synthetic snapshot verification failed: ${verified.state}`);
  }
  return { snapshotPath: created.snapshotPath, verificationId: verified.id, service };
}

export async function restoreCandidate(input: {
  snapshot: VerifiedSnapshot;
  parent: string;
  name: string;
}): Promise<{ destinationPath: string; service: BackupService }> {
  ensureDir(input.parent);
  const service = input.snapshot.service;
  const grant = service.issueDestinationGrant(input.parent, "restore-parent");
  const restored = await waitForOperation(
    service,
    service.startRestore({
      snapshotPath: input.snapshot.snapshotPath,
      grantId: grant.id,
      verificationId: input.snapshot.verificationId,
      destinationName: input.name,
    }).id,
  );
  if (restored.state !== "completed" || !restored.destinationPath) {
    throw new Error(`synthetic restore failed: ${restored.state} ${restored.error?.message ?? ""}`);
  }
  return { destinationPath: restored.destinationPath, service };
}

export interface IsolatedEnvOptions {
  baseDataDir: string;
  extra?: Record<string, string | undefined>;
}

/**
 * Process environment for a child probe. HOME and TMPDIR are redirected too,
 * so no runtime module can discover the owner's real profile by accident.
 */
export function isolatedProbeEnv(options: IsolatedEnvOptions): Record<string, string> {
  const root = path.dirname(options.baseDataDir);
  const home = ensureDir(path.join(root, "home"));
  const tmp = ensureDir(path.join(root, "tmp"));
  const env: Record<string, string> = {
    HOME: home,
    TMPDIR: tmp,
    FORGEORBIT_DATA_DIR: options.baseDataDir,
    AGETOR_DATA_DIR: options.baseDataDir,
    NODE_ENV: "test",
    PATH: process.env.PATH ?? "/usr/bin:/bin:/usr/sbin:/sbin",
  };
  for (const [key, value] of Object.entries(options.extra ?? {})) {
    if (value === undefined) delete env[key];
    else env[key] = value;
  }
  return env;
}

export interface ProbeResult {
  exitCode: number;
  signalCode: string | null;
  stdout: string;
  stderr: string;
  json: unknown | null;
  error: { code: string; message: string } | null;
}

export function parseProbeLines(stdout: string): unknown[] {
  const out: unknown[] = [];
  for (const line of stdout.split("\n")) {
    if (line.startsWith("ACTIVATION_PROBE ")) {
      out.push(JSON.parse(line.slice("ACTIVATION_PROBE ".length)));
    }
  }
  return out;
}

export function runProbeSync(
  mode: string,
  env: Record<string, string>,
  argument?: string,
): ProbeResult {
  const cmd = [process.execPath, PROBE_PATH, mode];
  if (argument !== undefined) cmd.push(argument);
  const result = Bun.spawnSync({
    cmd,
    cwd: path.dirname(env.FORGEORBIT_DATA_DIR ?? env.AGETOR_DATA_DIR ?? process.cwd()),
    env,
    stdout: "pipe",
    stderr: "pipe",
    timeout: 120_000,
  });
  const stdout = result.stdout ? new TextDecoder().decode(result.stdout) : "";
  const stderr = result.stderr ? new TextDecoder().decode(result.stderr) : "";
  let json: unknown | null = null;
  let error: { code: string; message: string } | null = null;
  for (const line of stdout.split("\n")) {
    if (line.startsWith("ACTIVATION_PROBE ")) {
      json = JSON.parse(line.slice("ACTIVATION_PROBE ".length));
    }
  }
  for (const line of stderr.split("\n")) {
    if (line.startsWith("ACTIVATION_PROBE_ERROR ")) {
      error = JSON.parse(line.slice("ACTIVATION_PROBE_ERROR ".length));
    }
  }
  return {
    exitCode: result.exitCode ?? -1,
    signalCode: (result as unknown as { signalCode?: string | null }).signalCode ?? null,
    stdout,
    stderr,
    json,
    error,
  };
}

export interface LockHolder {
  pid: number;
  stop(): void;
}

export async function startLockHolder(env: Record<string, string>): Promise<LockHolder> {
  const proc = Bun.spawn({
    cmd: [process.execPath, PROBE_PATH, "hold-lock"],
    cwd: path.dirname(env.FORGEORBIT_DATA_DIR ?? process.cwd()),
    env,
    stdout: "pipe",
    stderr: "pipe",
  });
  const reader = proc.stdout.getReader();
  let buffered = "";
  const deadline = Date.now() + 30_000;
  try {
    while (Date.now() < deadline) {
      const { done, value } = await reader.read();
      if (done) break;
      buffered += new TextDecoder().decode(value);
      const ready = buffered
        .split("\n")
        .find((line) => line.startsWith("ACTIVATION_PROBE ") && line.includes('"ready":true'));
      if (ready) {
        const parsed = JSON.parse(ready.slice("ACTIVATION_PROBE ".length)) as { pid: number };
        return {
          pid: parsed.pid,
          stop() {
            try {
              proc.kill("SIGTERM");
            } catch {
              /* already gone */
            }
          },
        };
      }
    }
  } finally {
    void reader.releaseLock();
  }
  try {
    proc.kill("SIGKILL");
  } catch {
    /* ignore */
  }
  throw new Error(`lock holder did not become ready: ${buffered.slice(-500)}`);
}

export function readJson(file: string): Record<string, unknown> {
  return JSON.parse(readFileSync(file, "utf8")) as Record<string, unknown>;
}

export function writeJson(file: string, value: unknown, mode = 0o600): void {
  writeFileSync(file, JSON.stringify(value, null, 2), { mode });
  chmodSync(file, mode);
}

export function copyProfile(sourceDir: string, destinationDir: string): void {
  ensureDir(destinationDir);
  for (const entry of ["knowledge", "attachments", "screenshots", "issue-threads", "pipeline-runs"]) {
    const source = path.join(sourceDir, entry);
    if (existsSync(source)) copyDirectory(source, path.join(destinationDir, entry));
  }
  for (const file of ["agetor.sqlite", ".forgeorbit-recovery.json", ".forgeorbit-restore-confirmed.json"]) {
    const source = path.join(sourceDir, file);
    if (existsSync(source)) {
      copyFileSync(source, path.join(destinationDir, file));
      chmodSync(path.join(destinationDir, file), 0o600);
    }
  }
}

function copyDirectory(source: string, destination: string): void {
  ensureDir(destination);
  for (const entry of readdirSync(source, { withFileTypes: true })) {
    const from = path.join(source, entry.name);
    const to = path.join(destination, entry.name);
    const st = lstatSync(from);
    if (st.isDirectory()) {
      copyDirectory(from, to);
    } else if (st.isFile()) {
      ensureDir(path.dirname(to));
      copyFileSync(from, to);
      chmodSync(to, 0o600);
    }
  }
}

export type { BackupRunnerLike };
