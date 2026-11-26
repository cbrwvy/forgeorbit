/**
 * Task-owned staging for one Developer run.
 * Reads the project with git ls-files and rev-parse only. Copies a bounded
 * snapshot into a directory under the ForgeOrbit data dir. Does not create a
 * Git repository, branch, clone, or linked worktree, and does not publish
 * unless the Owner names the paths and sets approve: true.
 * The Codex workspace-write sandbox on that directory is not an OS sandbox.
 */
import { createHash, randomUUID } from "node:crypto";
import { chmodSync, closeSync, constants, existsSync, fstatSync, openSync, readSync, lstatSync, mkdirSync, readdirSync, readFileSync, realpathSync, renameSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import path from "node:path";
import { isSecretRelPath, isSecretText, isUnsafeRelPath } from "../shared/review-evidence.ts";
import { redactSecrets } from "../shared/project-interview.ts";
import { formatUnifiedDiff } from "../shared/unified-diff.ts";
import {
  classifyWorkspaceChanges,
  normalizeWorkspacePaths,
  parseFakeTaskFiles,
  resourceFingerprint,
  TASK_STAGING_WRITE_BOUNDARY,
  TASK_WORKING_COPY_WRITE_BOUNDARY,
  TASK_WORKSPACE_LIMITS,
  TASK_WORKSPACE_WORKING_COPY_LIMITS,
  workspaceFingerprint,
  workspaceView,
  type BaselineFile,
  type ChangeEntry,
  type PublicationAttempt,
  type TaskWorkspaceManifest,
  type TaskWorkspaceStatus,
  type TaskWorkspaceView,
  type TaskWorkspaceWriteScope,
  type WorkspaceFileProvenance,
} from "../shared/task-workspace.ts";
import { extractRunShellChecksFromEvents, type WorkingCopyCheckRecord } from "../shared/working-copy-checks.ts";
import type { Task } from "../shared/types.ts";
import { dataDir, db, projects, runs, tasks } from "./db.ts";
import { taskInProject } from "./project-ownership.ts";

export class TaskWorkspaceError extends Error {
  constructor(message: string, readonly status: number, readonly code: string) {
    super(message);
  }
}

interface Row {
  id: string;
  task_id: string;
  run_id: string | null;
  status: TaskWorkspaceStatus;
  manifest_json: string;
  created_at: number;
  updated_at: number;
}

const OPEN = "('armed','executing','settled','publication-partial')";

function sha256(bytes: Buffer | string): string {
  return createHash("sha256").update(bytes).digest("hex");
}

async function git(cwd: string, args: string[]): Promise<{ code: number; out: string; err: string }> {
  const proc = Bun.spawn(["git", "--no-optional-locks", "-C", cwd, ...args], { stdout: "pipe", stderr: "pipe" });
  const [out, err, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  return { code, out, err };
}

function parseManifest(raw: string): TaskWorkspaceManifest | null {
  try {
    const value = JSON.parse(raw) as TaskWorkspaceManifest;
    if (!value || value.version !== 1 || !Array.isArray(value.files) || !Array.isArray(value.outputPaths)) return null;
    return value;
  } catch {
    return null;
  }
}

function rowView(row: Row): TaskWorkspaceView | null {
  const manifest = parseManifest(row.manifest_json);
  if (!manifest) return null;
  return workspaceView(row.id, row.status, manifest);
}

function latestRow(taskId: string): Row | null {
  return db.query<Row, [string]>(
    `SELECT * FROM task_workspaces WHERE task_id = ? ORDER BY created_at DESC LIMIT 1`,
  ).get(taskId) ?? null;
}

function openRow(taskId: string): Row | null {
  return db.query<Row, [string]>(
    `SELECT * FROM task_workspaces WHERE task_id = ? AND status IN ${OPEN} ORDER BY created_at DESC LIMIT 1`,
  ).get(taskId) ?? null;
}

function save(row: Row, status: TaskWorkspaceStatus, manifest: TaskWorkspaceManifest, runId: string | null = row.run_id): void {
  const now = Date.now();
  db.run(
    `UPDATE task_workspaces SET status = ?, run_id = ?, manifest_json = ?, updated_at = ? WHERE id = ?`,
    [status, runId, JSON.stringify(manifest), now, row.id],
  );
}

function projectAllowsWorkspaceDevelopment(projectPath: string): boolean {
  const direct = projects.get(projectPath);
  if (direct) return direct.workspaceDevelopment === true;
  try {
    const canonical = realpathSync(projectPath);
    const byCanonical = projects.get(canonical);
    if (byCanonical) return byCanonical.workspaceDevelopment === true;
    for (const proj of projects.list()) {
      try {
        if (realpathSync(proj.path) === canonical) return proj.workspaceDevelopment === true;
      } catch { /* ignore missing projects */ }
    }
  } catch { /* ignore */ }
  return false;
}

export function getTaskWorkspace(taskId: string): TaskWorkspaceView | null {
  const row = latestRow(taskId);
  return row ? rowView(row) : null;
}

export function getWorkspaceScratchPath(taskId: string): string | null {
  const row = openRow(taskId);
  if (!row) return null;
  const manifest = parseManifest(row.manifest_json);
  if (!manifest?.scratchPath || !existsSync(manifest.scratchPath)) return null;
  return manifest.scratchPath;
}

export function getWorkspaceWriteScope(taskId: string): TaskWorkspaceWriteScope | null {
  const row = openRow(taskId);
  if (!row) return null;
  const manifest = parseManifest(row.manifest_json);
  if (!manifest) return null;
  return manifest.writeScope ?? "explicit-outputs";
}

export function abandonWorkspaceIfArmed(taskId: string, workspaceId: string): boolean {
  const row = openRow(taskId);
  if (!row || row.id !== workspaceId || row.status !== "armed") return false;
  const manifest = parseManifest(row.manifest_json);
  if (manifest) removeStaging(manifest.stagingPath);
  save(row, "abandoned", manifest ?? emptyManifest(taskId), row.run_id);
  return true;
}

export function recordWorkingCopyCheck(taskId: string, record: WorkingCopyCheckRecord): TaskWorkspaceView | null {
  const row = openRow(taskId) ?? latestRow(taskId);
  if (!row) return null;
  const manifest = parseManifest(row.manifest_json);
  if (!manifest) return null;
  const existing = Array.isArray(manifest.checks) ? manifest.checks : [];
  const filtered = existing.filter((item) => item.id !== record.id);
  manifest.checks = [...filtered, record].slice(-TASK_WORKSPACE_WORKING_COPY_LIMITS.maxChecks);
  save(row, row.status, manifest, row.run_id);
  return workspaceView(row.id, row.status, manifest);
}

export function permissionSubject<T extends Pick<Task, "id" | "isolation" | "workdir" | "worktreePath">>(task: T): T | Pick<Task, "isolation" | "workdir" | "worktreePath"> {
  const row = openRow(task.id);
  if (!row || row.status !== "armed") return task;
  const manifest = parseManifest(row.manifest_json);
  if (!manifest || !existsSync(manifest.stagingPath)) return task;
  return { isolation: "none", workdir: manifest.stagingPath, worktreePath: null };
}

export function stagingCwdForTask(taskId: string): { cwd: string | null; block: string | null } {
  const row = openRow(taskId);
  if (!row) return { cwd: null, block: null };
  if (row.status !== "armed") {
    return { cwd: null, block: "A task workspace is still open. Abandon it before starting another Developer run. Nothing was started in the project folder." };
  }
  const manifest = parseManifest(row.manifest_json);
  if (!manifest || !existsSync(manifest.stagingPath)) {
    return { cwd: null, block: "Task staging is missing. Nothing was started in the project folder." };
  }
  const boundary = boundaryError(manifest.stagingPath, manifest.projectPath);
  if (boundary) return { cwd: null, block: `${boundary} Nothing was started in the project folder.` };
  return { cwd: manifest.stagingPath, block: null };
}

export function bindArmedRun(taskId: string, runId: string): void {
  const row = openRow(taskId);
  const manifest = row && row.status === "armed" ? parseManifest(row.manifest_json) : null;
  if (!row || !manifest) throw new Error("Task staging disappeared before the run was recorded.");
  manifest.developerRunId = runId;
  save(row, "executing", manifest, runId);
}

/**
 * Publication is applicable only when this run has a task workspace.
 * A published workspace must still match the bytes written for that run.
 * A missing workspace returns no blocker: ordinary git evidence does not need one.
 */
export function publicationAlignmentForRun(runId: string): { status: string | null; blocker: string | null } {
  const row = db.query<Row, [string]>(`SELECT * FROM task_workspaces WHERE run_id = ? ORDER BY created_at DESC LIMIT 1`).get(runId);
  if (!row) return { status: null, blocker: null };
  const manifest = parseManifest(row.manifest_json);
  if (!manifest) return { status: row.status, blocker: "The task workspace record is unreadable." };
  if (row.status === "armed" || row.status === "executing") {
    return { status: row.status, blocker: "The task workspace is still executing." };
  }
  if (manifest.violation) return { status: row.status, blocker: "The task workspace recorded an unauthorized change." };
  if (row.status === "publication-partial") return { status: row.status, blocker: "Publication of the task-owned change set is incomplete." };
  if (row.status === "settled") return { status: row.status, blocker: "Publish the approved task-owned change set before authorizing a project test." };
  if (row.status !== "published") return { status: row.status, blocker: "The task workspace is not published." };
  let root: string;
  try {
    root = realpathSync(manifest.projectPath);
  } catch {
    return { status: row.status, blocker: "The project folder is missing." };
  }
  let applied = 0;
  for (const attempt of manifest.publications) {
    for (const result of attempt.results) {
      if (result.status !== "applied" && result.status !== "already-applied") continue;
      applied += 1;
      const entry = manifest.changes.find((item) => item.path === result.path);
      if (entry?.kind === "deleted") {
        if (hashIfFile(root, result.path) !== null) {
          return { status: row.status, blocker: `${result.path} was recreated after deletion was published for this run.` };
        }
        continue;
      }
      if (!result.afterSha256) return { status: row.status, blocker: `Published path ${result.path} has no recorded hash.` };
      if (entry?.afterSha256 && entry.afterSha256 !== result.afterSha256) {
        return { status: row.status, blocker: `Recorded hash for ${result.path} does not match the publication.` };
      }
      if (hashIfFile(root, result.path) !== result.afterSha256) {
        return { status: row.status, blocker: `${result.path} no longer matches the bytes published for this run.` };
      }
    }
  }
  if (applied === 0) return { status: row.status, blocker: "The published workspace has no applied paths." };
  return { status: row.status, blocker: null };
}

/** Read only a small text file that this exact workspace run published with Owner approval. */
export function readPublishedMissionArtifact(runId: string, projectPath: string, relative: string): string | null {
  if (isUnsafeRelPath(relative) || isSecretRelPath(relative)) return null;
  const row = db.query<Row, [string]>("SELECT * FROM task_workspaces WHERE run_id = ? AND status = 'published'").get(runId);
  const manifest = row && parseManifest(row.manifest_json);
  if (!manifest || manifest.projectPath !== projectPath || manifest.developerRunId !== runId ||
    manifest.violation || !manifest.scanComplete) return null;
  const change = manifest.changes.find(item => item.path === relative && item.kind !== "deleted");
  if (!change?.afterSha256 || !manifest.publications.some(attempt => attempt.results.some(result =>
    result.path === relative && result.afterSha256 === change.afterSha256 &&
    (result.status === "applied" || result.status === "already-applied")))) return null;
  try {
    const root = realpathSync(projectPath);
    const file = path.join(root, relative);
    if (!file.startsWith(root + path.sep) || realpathSync(file) !== file) return null;
    const fd = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    try {
      const stat = fstatSync(fd);
      if (!stat.isFile() || stat.nlink !== 1 || stat.size < 1 || stat.size > 8192) return null;
      const bytes = Buffer.alloc(stat.size);
      if (readSync(fd, bytes, 0, bytes.length, 0) !== bytes.length ||
        createHash("sha256").update(bytes).digest("hex") !== change.afterSha256) return null;
      const value = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
      return value.trim() && !/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(value) && !isSecretText(value) && redactSecrets(value) === value ? value : null;
    } finally {
      closeSync(fd);
    }
  } catch {
    return null;
  }
}

export interface PublishedSourceTrust {
  /** No usable task workspace for this run, so callers keep the mtime check. */
  mode: "legacy" | "published" | "rejected";
  /** Applied output paths whose later mtime is the publication write. */
  accepted: { path: string; sha256: string }[];
  reason: string | null;
}

/**
 * A newer project file is an expected publication only when this Developer run's
 * own workspace, change set, and applied publication all name that path and
 * the current bytes. Anything else stays on the conservative freshness check,
 * or is rejected when the recorded publication itself does not hold.
 * The task revision's prompt hash must still match the task's current prompt.
 * Its timestamp prefix is the moment the workspace was prepared, not later column updates.
 */
export function publishedSourceTrust(input: {
  developerRunId: string;
  taskId: string;
  projectPath: string;
  gitHead: string;
}): PublishedSourceTrust {
  const legacy: PublishedSourceTrust = { mode: "legacy", accepted: [], reason: null };
  const row = db.query<Row, [string]>(`SELECT * FROM task_workspaces WHERE run_id = ? ORDER BY created_at DESC LIMIT 1`).get(input.developerRunId);
  if (!row) return legacy;
  const reject = (reason: string): PublishedSourceTrust => ({ mode: "rejected", accepted: [], reason });
  const manifest = parseManifest(row.manifest_json);
  if (!manifest) return reject("The task workspace record is unreadable.");
  if (row.task_id !== input.taskId || manifest.taskId !== input.taskId) {
    return reject("This task workspace is associated with a different task.");
  }
  if (row.run_id !== input.developerRunId || manifest.developerRunId !== input.developerRunId) {
    return reject("This task workspace is associated with a different Developer run.");
  }
  let root: string;
  try {
    root = realpathSync(input.projectPath);
    if (realpathSync(manifest.projectPath) !== root) return reject("The project path changed since the task workspace baseline.");
  } catch {
    return reject("The project folder is missing.");
  }
  if (input.gitHead !== manifest.gitHead) return reject("The source Git identity changed since the task workspace baseline.");
  const task = tasks.get(input.taskId);
  const recordedPrompt = /^[0-9]+:([0-9a-f]{64})$/.exec(manifest.taskRevision)?.[1] ?? "";
  if (!task || recordedPrompt !== sha256(task.prompt)) return reject("The task revision does not match the recorded baseline.");
  if (!manifest.scanComplete) return reject("The change-set scan is incomplete.");
  if (manifest.violation || manifest.changes.some((entry) => entry.scope === "unauthorized")) {
    return reject("The task workspace recorded an unauthorized change.");
  }
  if (row.status === "armed" || row.status === "executing") return reject("The task workspace is still executing.");
  if (row.status === "publication-partial") return reject("Publication of the task-owned change set is incomplete.");
  if (row.status !== "published") return legacy;
  const accepted: { path: string; sha256: string }[] = [];
  const deletedPaths = new Set<string>();
  const seen = new Set<string>();
  const isWorkingCopy = (manifest.writeScope ?? "explicit-outputs") === "working-copy";
  for (const attempt of manifest.publications) {
    for (const result of attempt.results) {
      if (result.status !== "applied" && result.status !== "already-applied") continue;
      if (isUnsafeRelPath(result.path) || result.path === ".git" || result.path.startsWith(".git/")) {
        return reject(`Published path ${result.path} is unsafe.`);
      }
      if (!isWorkingCopy && !manifest.outputPaths.includes(result.path)) {
        return reject(`Published path ${result.path} was not an approved output.`);
      }
      const entry = manifest.changes.find((item) => item.path === result.path);
      if (!entry || entry.scope !== "output" || entry.kind === "unchanged") {
        return reject(`Published path ${result.path} was not an in-scope Developer change.`);
      }
      if (entry.kind === "deleted") {
        deletedPaths.add(result.path);
        continue;
      }
      if (seen.has(result.path)) {
        const prior = accepted.find((item) => item.path === result.path);
        if (prior && prior.sha256 !== result.afterSha256) return reject(`Recorded hash for ${result.path} does not match the publication.`);
        continue;
      }
      if (!result.afterSha256 || !/^[0-9a-f]{64}$/.test(result.afterSha256)) {
        return reject(`Published path ${result.path} has no recorded hash.`);
      }
      if (entry.afterSha256 !== result.afterSha256) return reject(`Recorded hash for ${result.path} does not match the publication.`);
      seen.add(result.path);
      accepted.push({ path: result.path, sha256: result.afterSha256 });
    }
  }
  if (accepted.length === 0 && deletedPaths.size === 0) return reject("The published workspace has no applied paths.");
  for (const item of accepted) {
    const problem = publishedFileError(root, item.path, item.sha256);
    if (problem) return reject(problem);
  }
  for (const rel of deletedPaths) {
    if (hashIfFile(root, rel) !== null) return reject(`${rel} was recreated after deletion was published for this Developer run.`);
  }
  const drift = projectDrift(manifest);
  if (drift) return reject(drift);
  return { mode: "published", accepted, reason: null };
}

function publishedFileError(root: string, rel: string, expected: string): string | null {
  if (isUnsafeRelPath(rel) || rel === ".git" || rel.startsWith(".git/")) return `Published path ${rel} is unsafe.`;
  const abs = path.join(root, rel);
  let st: ReturnType<typeof lstatSync>;
  try {
    st = lstatSync(abs);
  } catch {
    return `Published path ${rel} is missing.`;
  }
  if (st.isSymbolicLink()) return `Published path ${rel} is a symlink. Recovery will not follow it.`;
  if (!st.isFile()) return `Published path ${rel} is not a regular file.`;
  let real: string;
  try {
    real = realpathSync(abs);
  } catch {
    return `Published path ${rel} could not be resolved.`;
  }
  if (real !== abs || (real !== root && !real.startsWith(root + path.sep))) return `Published path ${rel} escapes the project.`;
  if (sha256(readFileSync(abs)) !== expected) return `${rel} no longer matches the bytes published for this Developer run.`;
  return null;
}

export function readChangeSetForRun(runId: string): { entries: ChangeEntry[]; files: BaselineFile[]; violation: boolean } | null {
  const row = db.query<Row, [string]>(`SELECT * FROM task_workspaces WHERE run_id = ? ORDER BY created_at DESC LIMIT 1`).get(runId);
  const manifest = row ? parseManifest(row.manifest_json) : null;
  if (!row || !manifest || (row.status !== "settled" && row.status !== "published" && row.status !== "publication-partial" && row.status !== "executing")) return null;
  if (manifest.changes.length === 0 && row.status === "executing") return null;
  return { entries: manifest.changes, files: manifest.files, violation: manifest.violation };
}

function boundaryError(staging: string, project: string): string | null {
  let stage: string;
  let root: string;
  try {
    stage = realpathSync(staging);
    root = realpathSync(project);
  } catch {
    return "The staging directory or project root could not be resolved.";
  }
  if (stage === root || stage.startsWith(root + path.sep) || root.startsWith(stage + path.sep)) {
    return "Staging must sit outside the project root.";
  }
  const home = realpathSync(dataDir);
  const owned = path.join(home, "task-workspaces");
  if (stage !== owned && !stage.startsWith(owned + path.sep)) return "Staging escaped the task-workspace directory.";
  for (let dir = stage; ; dir = path.dirname(dir)) {
    try {
      if (lstatSync(path.join(dir, ".git"))) return "Staging is inside a Git repository. It was not used.";
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") return "Staging filesystem state is ambiguous.";
    }
    if (path.dirname(dir) === dir) break;
  }
  return null;
}

export async function prepareTaskWorkspace(
  taskId: string,
  body: { outputPaths?: unknown; dependencyPaths?: unknown; includePaths?: unknown; writeScope?: unknown },
  options?: { approvedProjectPath: string },
): Promise<TaskWorkspaceView> {
  const task = tasks.get(taskId);
  if (!task) throw new TaskWorkspaceError("Task not found.", 404, "not-found");
  if (task.archivedAt != null) throw new TaskWorkspaceError("Task is archived.", 409, "archived");
  const writeScope: TaskWorkspaceWriteScope =
    body.writeScope === "working-copy"
      ? "working-copy"
      : body.writeScope === undefined || body.writeScope === "explicit-outputs"
        ? "explicit-outputs"
        : (() => { throw new TaskWorkspaceError("Invalid workspace write scope.", 400, "paths"); })();
  const isWorkingCopy = writeScope === "working-copy";
  if (task.isolation === "worktree") {
    const materialized = !!task.worktreePath && existsSync(task.worktreePath);
    if (materialized || (!options && !isWorkingCopy)) {
      throw new TaskWorkspaceError("This task uses worktree isolation. Task staging does not create a worktree, and it does not run in the project folder instead.", 409, "worktree");
    }
  }
  const limits = isWorkingCopy ? TASK_WORKSPACE_WORKING_COPY_LIMITS : TASK_WORKSPACE_LIMITS;
  const outputs = normalizeWorkspacePaths(
    isWorkingCopy ? (body.outputPaths ?? []) : body.outputPaths,
    TASK_WORKSPACE_LIMITS.maxOutputPaths,
  );
  if (!outputs.ok) throw new TaskWorkspaceError(outputs.error, 400, "paths");
  if (!isWorkingCopy && outputs.paths.length === 0) throw new TaskWorkspaceError("Name at least one permitted output path.", 400, "paths");
  const dependencies = normalizeWorkspacePaths(body.dependencyPaths, TASK_WORKSPACE_LIMITS.maxDependencyPaths);
  if (!dependencies.ok) throw new TaskWorkspaceError(dependencies.error, 400, "paths");
  const includes = normalizeWorkspacePaths(body.includePaths, limits.maxFiles);
  if (!includes.ok) throw new TaskWorkspaceError(includes.error, 400, "paths");
  if (outputs.paths.some((rel) => dependencies.paths.includes(rel))) {
    throw new TaskWorkspaceError("A path cannot be both a permitted output and a dependency.", 400, "paths");
  }
  const existing = openRow(taskId);
  if (existing && existing.status !== "published") {
    throw new TaskWorkspaceError("A task workspace is already open. Abandon or publish it before preparing another.", 409, "open");
  }
  let projectPath: string;
  try {
    projectPath = realpathSync(task.workdir);
    if (!lstatSync(projectPath).isDirectory()) throw new Error("not a directory");
  } catch {
    throw new TaskWorkspaceError("The project folder is missing.", 409, "project");
  }
  if (options && !taskInProject(task, options.approvedProjectPath, { fresh: true })) {
    throw new TaskWorkspaceError("The task is outside the approved project.", 409, "project");
  }
  if (isWorkingCopy && !projectAllowsWorkspaceDevelopment(projectPath)) {
    throw new TaskWorkspaceError(
      "Development in a working copy is disabled for this project. Enable it in Project settings first.",
      409,
      "workspace-development-disabled",
    );
  }
  const head = await git(projectPath, ["rev-parse", "HEAD"]);
  const gitHead = head.code === 0 ? head.out.trim() : "";
  if (!/^[0-9a-f]{40}$/i.test(gitHead)) throw new TaskWorkspaceError("The project has no commit to use as a baseline.", 409, "git");
  const listed = await listProjectFiles(projectPath);
  if (!listed.ok) throw new TaskWorkspaceError(listed.error, 409, "list");
  const wanted = includes.paths.length > 0 ? new Set(includes.paths) : null;
  const files: BaselineFile[] = [];
  const omitted: { path: string; reason: string }[] = [];
  let total = 0;
  for (const item of listed.files) {
    if (wanted && !wanted.has(item.path) && !outputs.paths.includes(item.path) && !dependencies.paths.includes(item.path)) continue;
    if (isSecretRelPath(item.path)) {
      omitted.push({ path: item.path, reason: "Secret or credential path. It was not copied." });
      continue;
    }
    const read = readProjectFile(projectPath, item.path, { maxFileBytes: limits.maxFileBytes, allowBinary: isWorkingCopy });
    if (!read.ok) {
      if (isWorkingCopy) {
        omitted.push({ path: item.path, reason: read.error });
        continue;
      }
      throw new TaskWorkspaceError(`${read.error} Name includePaths to limit the snapshot. Nothing was copied.`, 409, "snapshot");
    }
    if (files.length >= limits.maxFiles || total + read.bytes > limits.maxTotalBytes) {
      throw new TaskWorkspaceError(`The project snapshot exceeds ${limits.maxFiles} files or ${limits.maxTotalBytes} bytes. Name includePaths. Nothing was copied into the project.`, 409, "limit");
    }
    total += read.bytes;
    const provenance: WorkspaceFileProvenance = dependencies.paths.includes(item.path) ? "dependency" : item.provenance;
    files.push({ path: item.path, sha256: read.sha256, bytes: read.bytes, provenance });
  }
  for (const rel of outputs.paths) {
    if (!files.some((file) => file.path === rel)) files.push({ path: rel, sha256: null, bytes: 0, provenance: "absent" });
  }
  for (const rel of dependencies.paths) {
    if (!files.some((file) => file.path === rel)) {
      throw new TaskWorkspaceError(`Dependency ${rel} is not a regular file in the project.`, 409, "dependency");
    }
  }
  // Git listing yields to other requests. Recheck before copying or claiming
  // the workspace so a concurrent preparation cannot create a second open row.
  const current = tasks.get(taskId);
  if (!current || current.updatedAt !== task.updatedAt || current.worktreePath !== task.worktreePath
    || (current.worktreePath && existsSync(current.worktreePath))
    || (options && !taskInProject(current, options.approvedProjectPath, { fresh: true }))) {
    throw new TaskWorkspaceError("The task or its project changed while preparing staging. Review again.", 409, "race");
  }
  if (openRow(taskId)) throw new TaskWorkspaceError("A task workspace is already open. Review it before preparing another.", 409, "open");
  const id = randomUUID();
  const sessionDir = path.join(dataDir, "task-workspaces", task.id, id);
  const stagingPath = path.join(sessionDir, "root");
  mkdirSync(stagingPath, { recursive: true });
  const outside = boundaryError(stagingPath, projectPath);
  if (outside) {
    rmSync(sessionDir, { recursive: true, force: true });
    throw new TaskWorkspaceError(outside, 409, "boundary");
  }
  let scratchReal: string | null = null;
  if (isWorkingCopy) {
    const scratchPath = path.join(sessionDir, "scratch");
    mkdirSync(scratchPath, { recursive: true, mode: 0o700 });
    chmodSync(scratchPath, 0o700);
    const scratchOutside = boundaryError(scratchPath, projectPath);
    if (scratchOutside) {
      rmSync(sessionDir, { recursive: true, force: true });
      throw new TaskWorkspaceError(scratchOutside, 409, "boundary");
    }
    scratchReal = realpathSync(scratchPath);
  }
  try {
    for (const file of files) {
      if (file.provenance === "absent" || file.sha256 == null) continue;
      const source = readProjectFile(projectPath, file.path, { maxFileBytes: limits.maxFileBytes, allowBinary: isWorkingCopy });
      if (!source.ok || source.sha256 !== file.sha256) throw new TaskWorkspaceError(`Baseline changed while staging ${file.path}.`, 409, "race");
      const dest = path.join(stagingPath, file.path);
      mkdirSync(path.dirname(dest), { recursive: true });
      writeFileSync(dest, source.bytesBody);
      if (isWorkingCopy && (source.mode & 0o111) !== 0) {
        chmodSync(dest, 0o755);
      }
      if (sha256(readFileSync(dest)) !== file.sha256) throw new TaskWorkspaceError(`Staged copy of ${file.path} does not match the project.`, 409, "copy");
    }
  } catch (error) {
    rmSync(sessionDir, { recursive: true, force: true });
    if (error instanceof TaskWorkspaceError) throw error;
    throw new TaskWorkspaceError("The staging directory could not be written.", 409, "copy");
  }
  const manifest: TaskWorkspaceManifest = {
    version: 1,
    projectId: sha256(projectPath),
    projectPath,
    taskId: task.id,
    taskRevision: `${task.updatedAt}:${sha256(task.prompt)}`,
    developerRunId: null,
    stagingPath: realpathSync(stagingPath),
    scratchPath: scratchReal,
    writeScope,
    gitHead,
    outputPaths: outputs.paths,
    dependencyPaths: dependencies.paths,
    files,
    omitted,
    fingerprint: workspaceFingerprint({ projectPath, gitHead, outputPaths: outputs.paths, files }),
    resourceFingerprint: resourceFingerprint({ projectPath, gitHead, outputPaths: outputs.paths, taskId: task.id, writeScope }),
    executionMode: "task-staging",
    layout: "non-git",
    sandbox: "workspace-write",
    osSandbox: isWorkingCopy,
    writeBoundary: isWorkingCopy ? TASK_WORKING_COPY_WRITE_BOUNDARY : TASK_STAGING_WRITE_BOUNDARY,
    exitCode: null,
    violation: false,
    scanComplete: true,
    changes: [],
    diff: null,
    checks: [],
    publications: [],
  };
  const now = Date.now();
  try {
    db.run(
      `INSERT INTO task_workspaces (id, task_id, run_id, status, manifest_json, created_at, updated_at) VALUES (?, ?, NULL, 'armed', ?, ?, ?)`,
      [id, task.id, JSON.stringify(manifest), now, now],
    );
  } catch (error) {
    rmSync(sessionDir, { recursive: true, force: true });
    throw error;
  }
  void import("./queue-gates.ts").then((gates) => gates.notifyGatedTask(task.id));
  return workspaceView(id, "armed", manifest);
}

/** Keep the settled files and allow one more Developer run in the same directory. */
export function rearmSettledWorkspace(taskId: string): TaskWorkspaceView | null {
  const row = openRow(taskId);
  if (!row || row.status !== "settled") return null;
  const manifest = parseManifest(row.manifest_json);
  if (!manifest || !existsSync(manifest.stagingPath)) return null;
  save(row, "armed", manifest, null);
  return workspaceView(row.id, "armed", manifest);
}

export function abandonTaskWorkspace(taskId: string): TaskWorkspaceView {
  const row = openRow(taskId);
  if (!row) throw new TaskWorkspaceError("No open task workspace.", 404, "not-found");
  if (row.status === "executing") throw new TaskWorkspaceError("A Developer run is still using this staging directory.", 409, "executing");
  const manifest = parseManifest(row.manifest_json);
  if (manifest) removeStaging(manifest.stagingPath);
  const next = manifest ?? emptyManifest(taskId);
  save(row, "abandoned", next, row.run_id);
  return workspaceView(row.id, "abandoned", next);
}

function readVerifiedBaselineText(projectPath: string, rel: string, expectedSha256: string | null): string | null {
  if (!expectedSha256 || isUnsafeRelPath(rel) || rel === ".git" || rel.startsWith(".git/")) return null;
  let root: string;
  try { root = realpathSync(projectPath); } catch { return null; }
  const abs = path.join(root, rel);
  try {
    const st = lstatSync(abs);
    if (st.isSymbolicLink() || !st.isFile()) return null;
    if (realpathSync(abs) !== abs || !abs.startsWith(root + path.sep)) return null;
    if (st.size > TASK_WORKSPACE_WORKING_COPY_LIMITS.maxFileBytes) return null;
    const body = readFileSync(abs);
    if (body.includes(0) || sha256(body) !== expectedSha256) return null;
    return body.toString("utf8");
  } catch {
    return null;
  }
}

function classifyAndEnrichManifest(manifest: TaskWorkspaceManifest): void {
  const writeScope: TaskWorkspaceWriteScope = manifest.writeScope ?? "explicit-outputs";
  const isWorkingCopy = writeScope === "working-copy";
  const maxFiles = isWorkingCopy ? TASK_WORKSPACE_WORKING_COPY_LIMITS.maxFiles : TASK_WORKSPACE_LIMITS.maxFiles;
  const scanned = scanStaging(manifest.stagingPath, maxFiles);
  const classified = scanned.ok
    ? classifyWorkspaceChanges({
      files: manifest.files,
      outputPaths: manifest.outputPaths,
      dependencyPaths: manifest.dependencyPaths,
      after: scanned.files,
      writeScope,
    })
    : { changes: [] as ChangeEntry[], violation: true, scanComplete: false };

  const diffChunks: string[] = [];
  let diffChars = 0;

  if (scanned.ok) {
    for (const entry of classified.changes) {
      if (entry.scope !== "output") continue;
      if ((entry.kind === "created" || entry.kind === "modified") && entry.afterSha256) {
        const abs = path.join(manifest.stagingPath, entry.path);
        try {
          const body = readFileSync(abs);
          if (sha256(body) !== entry.afterSha256) {
            entry.scope = "unauthorized";
            entry.text = null;
            entry.diff = null;
            entry.reason = "Output changed while being recorded.";
            classified.violation = true;
            continue;
          }
          if (isWorkingCopy) {
            if (body.byteLength > TASK_WORKSPACE_WORKING_COPY_LIMITS.maxFileBytes) {
              entry.scope = "unauthorized";
              entry.text = null;
              entry.diff = null;
              entry.reason = "Output exceeds the working-copy file size limit.";
              classified.violation = true;
              continue;
            }
            if (body.includes(0)) {
              entry.text = null;
              entry.diff = null;
              continue;
            }
            const text = body.toString("utf8");
            if (isSecretText(text)) {
              entry.scope = "unauthorized";
              entry.text = null;
              entry.diff = null;
              entry.reason = "Output contains key material or secret text.";
              classified.violation = true;
              continue;
            }
            entry.text = text.length <= TASK_WORKSPACE_LIMITS.maxFileBytes ? text : null;
            const beforeBaseline = entry.renamedFrom
              ? manifest.files.find((f) => f.path === entry.renamedFrom)
              : manifest.files.find((f) => f.path === entry.path);
            const beforeText = entry.kind === "modified"
              ? readVerifiedBaselineText(manifest.projectPath, entry.path, entry.beforeSha256)
              : entry.renamedFrom && beforeBaseline?.sha256
                ? readVerifiedBaselineText(manifest.projectPath, entry.renamedFrom, beforeBaseline.sha256)
                : "";
            const fileDiff = formatUnifiedDiff({
              path: entry.path,
              kind: entry.kind,
              beforeText,
              afterText: text,
              renamedFrom: entry.renamedFrom ?? null,
              maxChars: TASK_WORKSPACE_WORKING_COPY_LIMITS.maxDiffTextBytes,
            });
            entry.diff = fileDiff;
            if (diffChars < TASK_WORKSPACE_WORKING_COPY_LIMITS.maxTotalDiffBytes) {
              const remaining = TASK_WORKSPACE_WORKING_COPY_LIMITS.maxTotalDiffBytes - diffChars;
              const chunk = fileDiff.length > remaining ? `${fileDiff.slice(0, remaining)}\n... (diff truncated)` : fileDiff;
              diffChunks.push(chunk);
              diffChars += chunk.length + 1;
            }
          } else {
            if (body.includes(0) || isSecretText(body.toString("utf8"))) {
              entry.scope = "unauthorized";
              entry.text = null;
              entry.reason = "Output is not bounded plain text, or it changed while being recorded.";
              classified.violation = true;
              continue;
            }
            entry.text = body.toString("utf8");
          }
        } catch {
          entry.scope = "unauthorized";
          entry.reason = "Output could not be read back from staging.";
          classified.violation = true;
        }
      } else if (isWorkingCopy && entry.kind === "deleted" && entry.beforeSha256) {
        const beforeText = readVerifiedBaselineText(manifest.projectPath, entry.path, entry.beforeSha256);
        if (beforeText !== null) {
          const fileDiff = formatUnifiedDiff({
            path: entry.path,
            kind: "deleted",
            beforeText,
            afterText: null,
            maxChars: TASK_WORKSPACE_WORKING_COPY_LIMITS.maxDiffTextBytes,
          });
          entry.diff = fileDiff;
          if (diffChars < TASK_WORKSPACE_WORKING_COPY_LIMITS.maxTotalDiffBytes) {
            const remaining = TASK_WORKSPACE_WORKING_COPY_LIMITS.maxTotalDiffBytes - diffChars;
            const chunk = fileDiff.length > remaining ? `${fileDiff.slice(0, remaining)}\n... (diff truncated)` : fileDiff;
            diffChunks.push(chunk);
            diffChars += chunk.length + 1;
          }
        }
      }
    }
  } else {
    classified.changes.push({
      path: ".", kind: "modified", scope: "unauthorized", beforeSha256: null, afterSha256: null,
      beforeProvenance: null, text: null, reason: scanned.error,
    });
  }

  manifest.changes = classified.changes;
  manifest.violation = classified.violation;
  manifest.scanComplete = classified.scanComplete;
  if (isWorkingCopy) {
    manifest.diff = diffChunks.length > 0 ? diffChunks.join("\n") : null;
  }
}

export function rescanSettledWorkspace(taskId: string): TaskWorkspaceView | null {
  const row = openRow(taskId);
  if (!row || (row.status !== "settled" && row.status !== "publication-partial")) return null;
  const manifest = parseManifest(row.manifest_json);
  if (!manifest) return null;
  classifyAndEnrichManifest(manifest);
  save(row, row.status, manifest, row.run_id);
  return workspaceView(row.id, row.status, manifest);
}

export function settleTaskWorkspace(runId: string, exitCode: number | null, interruption: TaskWorkspaceManifest["interruption"] = null): void {
  const row = db.query<Row, [string]>(`SELECT * FROM task_workspaces WHERE run_id = ? ORDER BY created_at DESC LIMIT 1`).get(runId);
  if (!row || row.status !== "executing") return;
  const manifest = parseManifest(row.manifest_json);
  if (!manifest) return;
  classifyAndEnrichManifest(manifest);
  if ((manifest.writeScope ?? "explicit-outputs") === "working-copy") {
    const observed = extractRunShellChecksFromEvents(runs.events(runId), manifest.stagingPath);
    const existing = Array.isArray(manifest.checks) ? manifest.checks : [];
    const byId = new Map<string, WorkingCopyCheckRecord>();
    for (const item of existing) byId.set(item.id, item);
    for (const item of observed) {
      if (!byId.has(item.id)) byId.set(item.id, item);
    }
    manifest.checks = [...byId.values()].slice(-TASK_WORKSPACE_WORKING_COPY_LIMITS.maxChecks);
  }
  manifest.exitCode = exitCode;
  if (interruption) manifest.interruption = interruption;
  save(row, "settled", manifest, runId);
}

export function recoverTaskWorkspaces(): number {
  const rows = db.query<Row, []>(`SELECT * FROM task_workspaces WHERE status = 'executing'`).all();
  let settled = 0;
  for (const row of rows) {
    if (!row.run_id) continue;
    const run = runs.get(row.run_id);
    if (!run || run.status === "running") continue;
    settleTaskWorkspace(row.run_id, run.exitCode);
    settled += 1;
  }
  return settled;
}

export async function publishTaskWorkspace(taskId: string, body: { approve?: unknown; paths?: unknown }): Promise<TaskWorkspaceView> {
  if (body.approve !== true) throw new TaskWorkspaceError("Publication requires approve: true on this request. A Developer run does not approve it.", 400, "approve");
  const named = normalizeWorkspacePaths(body.paths, TASK_WORKSPACE_WORKING_COPY_LIMITS.maxPublishPaths);
  if (!named.ok) throw new TaskWorkspaceError(named.error, 400, "paths");
  if (named.paths.length === 0) throw new TaskWorkspaceError("Name the paths to publish.", 400, "paths");
  const row = openRow(taskId);
  if (!row || (row.status !== "settled" && row.status !== "publication-partial")) {
    throw new TaskWorkspaceError("Publication waits until the Developer run has settled. Nothing was written to the project.", 409, "status");
  }
  const manifest = parseManifest(row.manifest_json);
  if (!manifest) throw new TaskWorkspaceError("Task staging record is unreadable.", 409, "corrupt");
  const isWorkingCopy = (manifest.writeScope ?? "explicit-outputs") === "working-copy";
  if (!isWorkingCopy && named.paths.length > TASK_WORKSPACE_LIMITS.maxOutputPaths) {
    throw new TaskWorkspaceError(`At most ${TASK_WORKSPACE_LIMITS.maxOutputPaths} paths are allowed.`, 400, "paths");
  }
  if (manifest.interruption) {
    throw new TaskWorkspaceError(
      `The Developer run was ${manifest.interruption.reason === "time-limit" ? "stopped at its time limit" : "stopped by the Owner"} before it finished, so its staged files are incomplete. Nothing was published. Start a new run.`,
      409, "interrupted",
    );
  }
  if (!manifest.scanComplete) throw new TaskWorkspaceError("The staging scan is incomplete. Nothing was published.", 409, "scan");
  const attempt: PublicationAttempt = { id: randomUUID(), at: Date.now(), paths: named.paths, outcome: "refused", reason: null, results: [] };
  const refuse = (reason: string): TaskWorkspaceView => {
    attempt.reason = reason;
    manifest.publications.push(attempt);
    save(row, row.status, manifest, row.run_id);
    throw new TaskWorkspaceError(reason, 409, "refused");
  };
  for (const rel of named.paths) {
    const entry = manifest.changes.find((item) => item.path === rel);
    if (!entry || entry.scope !== "output" || entry.kind === "unchanged") return refuse(`Path ${rel} is not an in-scope change from this run.`);
  }
  const drift = projectDrift(manifest, named.paths);
  if (drift) return refuse(drift);
  let status: TaskWorkspaceStatus = row.status;
  try {
    for (const rel of named.paths) {
      __testing.beforePublishWrite?.(rel);
      const entry = manifest.changes.find((item) => item.path === rel)!;
      const result = applyOne(manifest, entry);
      attempt.results.push(result);
      if (result.status === "failed") {
        attempt.outcome = "partial";
        attempt.reason = result.error;
        status = "publication-partial";
        break;
      }
    }
  } catch (error) {
    const rel = named.paths[attempt.results.length] ?? named.paths[0]!;
    attempt.results.push({ path: rel, status: "failed", beforeSha256: null, afterSha256: null, error: error instanceof Error ? error.message : "write failed" });
    attempt.outcome = attempt.results.some((item) => item.status === "applied" || item.status === "already-applied") ? "partial" : "refused";
    attempt.reason = attempt.results.at(-1)?.error ?? "write failed";
    status = attempt.outcome === "partial" ? "publication-partial" : row.status;
    manifest.publications.push(attempt);
    save(row, status, manifest, row.run_id);
    throw new TaskWorkspaceError(attempt.reason ?? "Publication failed.", 409, "partial");
  }
  if (attempt.outcome !== "partial") attempt.outcome = "applied";
  manifest.publications.push(attempt);
  if (status !== "publication-partial") status = "published";
  save(row, status, manifest, row.run_id);
  if (status === "published") {
    void import("./queue-gates.ts").then((gates) => gates.notifyGatedTask(taskId));
  }
  const view = workspaceView(row.id, status, manifest);
  if (attempt.outcome === "partial") throw new TaskWorkspaceError(attempt.reason ?? "Publication stopped after a partial write.", 409, "partial");
  return view;
}

function applyOne(manifest: TaskWorkspaceManifest, entry: ChangeEntry): PublicationAttempt["results"][number] {
  const dest = path.join(manifest.projectPath, entry.path);
  const current = hashIfFile(manifest.projectPath, entry.path);
  const prior = appliedEntry(manifest, entry.path);
  if (prior.applied) {
    if (current !== prior.afterSha256) {
      return { path: entry.path, status: "failed", beforeSha256: current, afterSha256: entry.afterSha256, error: `${entry.path} no longer matches the bytes already published.` };
    }
    return { path: entry.path, status: "already-applied", beforeSha256: entry.beforeSha256, afterSha256: prior.afterSha256, error: null };
  }
  if (entry.kind === "deleted") {
    if (current !== entry.beforeSha256) {
      return { path: entry.path, status: "failed", beforeSha256: current, afterSha256: null, error: `${entry.path} changed in the project since the baseline.` };
    }
    try {
      const st = lstatSync(dest);
      if (st.isSymbolicLink() || !st.isFile() || realpathSync(dest) !== dest) {
        return { path: entry.path, status: "failed", beforeSha256: current, afterSha256: null, error: `${entry.path} is not a regular file inside the project.` };
      }
      unlinkSync(dest);
    } catch (error) {
      return { path: entry.path, status: "failed", beforeSha256: current, afterSha256: null, error: error instanceof Error ? error.message : "delete failed" };
    }
    return { path: entry.path, status: "applied", beforeSha256: entry.beforeSha256, afterSha256: null, error: null };
  }
  if (current !== entry.beforeSha256) {
    return { path: entry.path, status: "failed", beforeSha256: current, afterSha256: null, error: `${entry.path} changed in the project since the baseline.` };
  }
  const staged = path.join(manifest.stagingPath, entry.path);
  let body: Buffer;
  let stagedMode = 0o644;
  try {
    const st = lstatSync(staged);
    if (st.isSymbolicLink() || !st.isFile()) throw new Error("not a regular file");
    if (realpathSync(staged) !== staged) throw new Error("staging path escapes");
    stagedMode = st.mode;
    body = readFileSync(staged);
  } catch {
    return { path: entry.path, status: "failed", beforeSha256: current, afterSha256: null, error: `${entry.path} could not be read from staging.` };
  }
  if (sha256(body) !== entry.afterSha256) {
    return { path: entry.path, status: "failed", beforeSha256: current, afterSha256: sha256(body), error: `${entry.path} in staging no longer matches the reviewed change.` };
  }
  const parent = path.dirname(dest);
  mkdirSync(parent, { recursive: true });
  if (!realpathSync(parent).startsWith(manifest.projectPath + path.sep) && realpathSync(parent) !== manifest.projectPath) {
    return { path: entry.path, status: "failed", beforeSha256: current, afterSha256: null, error: `${entry.path} would be written outside the project.` };
  }
  const tmp = path.join(parent, `.fo-publish-${sha256(entry.path).slice(0, 12)}`);
  writeFileSync(tmp, body, { flag: "w" });
  if ((stagedMode & 0o111) !== 0) {
    try { chmodSync(tmp, 0o755); } catch { /* ignore chmod errors */ }
  }
  try {
    const again = hashIfFile(manifest.projectPath, entry.path);
    if (again !== entry.beforeSha256) {
      unlinkSync(tmp);
      return { path: entry.path, status: "failed", beforeSha256: again, afterSha256: null, error: `${entry.path} changed while publication was writing.` };
    }
    // POSIX rename replaces the destination in one directory update.
    renameSync(tmp, dest);
  } catch (error) {
    try { unlinkSync(tmp); } catch { /* the temp file may already have been renamed */ }
    return { path: entry.path, status: "failed", beforeSha256: current, afterSha256: null, error: error instanceof Error ? error.message : "rename failed" };
  }
  return { path: entry.path, status: "applied", beforeSha256: entry.beforeSha256, afterSha256: entry.afterSha256, error: null };
}

function appliedEntry(manifest: TaskWorkspaceManifest, rel: string): { applied: true; afterSha256: string | null } | { applied: false } {
  for (const attempt of [...manifest.publications].reverse()) {
    const found = [...attempt.results].reverse().find((item) => item.path === rel && (item.status === "applied" || item.status === "already-applied"));
    if (found) return { applied: true, afterSha256: found.afterSha256 };
  }
  return { applied: false };
}

function projectDrift(manifest: TaskWorkspaceManifest, publishPaths: readonly string[] = []): string | null {
  let root: string;
  try { root = realpathSync(manifest.projectPath); } catch { return "The project folder is missing."; }
  if (root !== manifest.projectPath) return "The project path changed since the baseline.";
  const checked = new Set<string>();
  for (const file of manifest.files) {
    checked.add(file.path);
    const applied = appliedEntry(manifest, file.path);
    const current = hashIfFile(root, file.path);
    if (applied.applied) {
      if (current !== applied.afterSha256) return `${file.path} no longer matches the bytes already published for this run.`;
      continue;
    }
    const expected = file.provenance === "absent" ? null : file.sha256;
    if (current !== expected) return `${file.path} changed in the project since the baseline. Publication was refused.`;
  }
  for (const rel of publishPaths) {
    if (checked.has(rel)) continue;
    const applied = appliedEntry(manifest, rel);
    const current = hashIfFile(root, rel);
    if (applied.applied) {
      if (current !== applied.afterSha256) return `${rel} no longer matches the bytes already published for this run.`;
      continue;
    }
    if (current !== null) return `${rel} already exists in the project since the baseline. Publication was refused.`;
  }
  return null;
}

function hashIfFile(root: string, rel: string): string | null {
  if (isUnsafeRelPath(rel)) return null;
  const abs = path.join(root, rel);
  try {
    const st = lstatSync(abs);
    if (st.isSymbolicLink() || !st.isFile()) return null;
    if (realpathSync(abs) !== abs) return null;
    return sha256(readFileSync(abs));
  } catch {
    return null;
  }
}

function removeStaging(stagingPath: string): void {
  const home = realpathSync(dataDir);
  const owned = path.join(home, "task-workspaces");
  let target: string;
  try { target = realpathSync(stagingPath); } catch { return; }
  if (!target.startsWith(owned + path.sep)) return;
  const sessionDir = path.dirname(target);
  if (path.dirname(sessionDir).startsWith(owned + path.sep) || path.dirname(sessionDir) === owned) {
    rmSync(sessionDir, { recursive: true, force: true });
  }
}

function emptyManifest(taskId: string): TaskWorkspaceManifest {
  return {
    version: 1, projectId: "", projectPath: "", taskId, taskRevision: "", developerRunId: null, stagingPath: "",
    gitHead: "", outputPaths: [], dependencyPaths: [], files: [], omitted: [], fingerprint: "", resourceFingerprint: "",
    executionMode: "task-staging", layout: "non-git", sandbox: "workspace-write", osSandbox: false,
    writeBoundary: TASK_STAGING_WRITE_BOUNDARY, exitCode: null, violation: false, scanComplete: false, changes: [], publications: [],
  };
}

async function listProjectFiles(root: string): Promise<{ ok: true; files: { path: string; provenance: "tracked" | "untracked" }[] } | { ok: false; error: string }> {
  const tracked = await git(root, ["ls-files", "-z", "--cached"]);
  const untracked = await git(root, ["ls-files", "-z", "--others", "--exclude-standard"]);
  if (tracked.code !== 0 || untracked.code !== 0) return { ok: false, error: "The project file list could not be read." };
  const files: { path: string; provenance: "tracked" | "untracked" }[] = [];
  const seen = new Set<string>();
  for (const [blob, provenance] of [[tracked.out, "tracked"], [untracked.out, "untracked"]] as const) {
    for (const name of blob.split("\0")) {
      if (!name || seen.has(name)) continue;
      seen.add(name);
      files.push({ path: name, provenance });
    }
  }
  files.sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
  return { ok: true, files };
}

function readProjectFile(
  root: string,
  rel: string,
  opts?: { maxFileBytes?: number; allowBinary?: boolean },
): { ok: true; sha256: string; bytes: number; bytesBody: Buffer; mode: number } | { ok: false; error: string } {
  if (isUnsafeRelPath(rel) || rel === ".git" || rel.startsWith(".git/")) return { ok: false, error: `Unsafe path ${rel}.` };
  const abs = path.join(root, rel);
  let st: ReturnType<typeof lstatSync>;
  try { st = lstatSync(abs); } catch { return { ok: false, error: `${rel} disappeared while the baseline was being read.` }; }
  if (st.isSymbolicLink()) return { ok: false, error: `${rel} is a symlink. It was not followed.` };
  if (!st.isFile()) return { ok: false, error: `${rel} is not a regular file.` };
  let real = abs;
  try { real = realpathSync(abs); } catch { return { ok: false, error: `${rel} could not be resolved.` }; }
  if (real !== abs || !real.startsWith(root + path.sep)) return { ok: false, error: `${rel} escapes the project.` };
  const maxFileBytes = opts?.maxFileBytes ?? TASK_WORKSPACE_LIMITS.maxFileBytes;
  if (st.size > maxFileBytes) return { ok: false, error: `${rel} exceeds the snapshot size limit.` };
  const body = readFileSync(abs);
  if (body.includes(0)) {
    if (!opts?.allowBinary) return { ok: false, error: `${rel} is not plain text.` };
  } else if (isSecretText(body.toString("utf8"))) {
    return { ok: false, error: `${rel} contains key material. It was not copied.` };
  }
  return { ok: true, sha256: sha256(body), bytes: body.byteLength, bytesBody: body, mode: st.mode };
}

function scanStaging(
  staging: string,
  maxFiles: number = TASK_WORKSPACE_LIMITS.maxFiles,
): { ok: true; files: { path: string; sha256: string; unsafe?: string }[] } | { ok: false; error: string } {
  let root: string;
  try { root = realpathSync(staging); } catch { return { ok: false, error: "Staging directory is missing." }; }
  const files: { path: string; sha256: string; unsafe?: string }[] = [];
  const walk = (dir: string): string | null => {
    let entries;
    try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return "Staging could not be listed."; }
    for (const entry of entries) {
      if (files.length > maxFiles) return "Staging contains more files than the snapshot limit.";
      const name = typeof entry.name === "string" ? entry.name : Buffer.from(entry.name).toString();
      const abs = path.join(dir, name);
      const rel = path.relative(root, abs).split(path.sep).join("/");
      if (isUnsafeRelPath(rel)) return `Staging contains an unsafe path (${rel}).`;
      if (entry.isSymbolicLink()) {
        files.push({ path: rel, sha256: "", unsafe: "Symlink in staging. It was not followed." });
        continue;
      }
      if (entry.isDirectory()) {
        const nested = walk(abs);
        if (nested) return nested;
        continue;
      }
      if (!entry.isFile()) {
        files.push({ path: rel, sha256: "", unsafe: "Staging contains a non-regular file." });
        continue;
      }
      try {
        if (realpathSync(abs) !== abs) {
          files.push({ path: rel, sha256: "", unsafe: "Staging path escapes the staging directory." });
          continue;
        }
        const body = readFileSync(abs);
        files.push({ path: rel, sha256: sha256(body) });
      } catch {
        return `Staging file ${rel} could not be read.`;
      }
    }
    return null;
  };
  const error = walk(root);
  if (error) return { ok: false, error };
  return { ok: true, files };
}

export function applyFakeTaskFiles(prompt: string, cwd: string | undefined): { ok: true } | { ok: false; error: string } | null {
  const parsed = parseFakeTaskFiles(prompt);
  if (!parsed) return null;
  if (!parsed.ok) return parsed;
  if (!cwd) return { ok: false, error: "Fake task files have no working directory. Nothing was written." };
  let root: string;
  try { root = realpathSync(cwd); } catch { return { ok: false, error: "Fake task file directory is missing. Nothing was written." }; }
  for (const write of parsed.writes) {
    const dest = path.join(root, write.path);
    mkdirSync(path.dirname(dest), { recursive: true });
    const parent = realpathSync(path.dirname(dest));
    if (parent !== root && !parent.startsWith(root + path.sep)) return { ok: false, error: "Fake task file path escapes the working directory." };
    writeFileSync(dest, write.contents);
    if (realpathSync(dest) !== dest) return { ok: false, error: "Fake task file path escapes the working directory." };
  }
  for (const rename of parsed.renames ?? []) {
    const src = path.join(root, rename.from);
    const dest = path.join(root, rename.to);
    try {
      const st = lstatSync(src);
      if (st.isSymbolicLink() || !st.isFile() || realpathSync(src) !== src) {
        return { ok: false, error: `Fake rename source ${rename.from} is not a safe file in the working directory.` };
      }
    } catch {
      return { ok: false, error: `Fake rename source ${rename.from} does not exist.` };
    }
    mkdirSync(path.dirname(dest), { recursive: true });
    const parent = realpathSync(path.dirname(dest));
    if (parent !== root && !parent.startsWith(root + path.sep)) return { ok: false, error: "Fake rename destination escapes the working directory." };
    renameSync(src, dest);
    if (realpathSync(dest) !== dest) return { ok: false, error: "Fake rename destination escapes the working directory." };
  }
  for (const del of parsed.deletes ?? []) {
    const target = path.join(root, del);
    try {
      const st = lstatSync(target);
      if (st.isSymbolicLink() || !st.isFile() || realpathSync(target) !== target) {
        return { ok: false, error: `Fake delete target ${del} is not a safe file in the working directory.` };
      }
      unlinkSync(target);
    } catch {
      return { ok: false, error: `Fake delete target ${del} does not exist.` };
    }
  }
  return { ok: true };
}

export const __testing = {
  beforePublishWrite: null as null | ((rel: string) => void),
};
