/**
 * Task-owned execution baseline and change classification.
 * Pure data. It does not read the filesystem, spawn a process, or publish files.
 * Codex workspace-write on a staging directory is not an OS sandbox.
 */
import { isSecretRelPath, isUnsafeRelPath, sha256Text } from "./review-evidence.ts";
import {
  summarizeWorkingCopyChecks,
  type WorkingCopyCheckRecord,
  type WorkingCopyCheckSummary,
} from "./working-copy-checks.ts";

export type TaskWorkspaceWriteScope = "explicit-outputs" | "working-copy";

export const TASK_WORKSPACE_LIMITS = {
  maxFiles: 200,
  maxFileBytes: 48_000,
  maxTotalBytes: 2_000_000,
  maxOutputPaths: 8,
  maxDependencyPaths: 8,
} as const;

export const TASK_WORKSPACE_WORKING_COPY_LIMITS = {
  maxFiles: 4_000,
  maxFileBytes: 2_000_000,
  maxTotalBytes: 64_000_000,
  maxPublishPaths: 200,
  maxDiffTextBytes: 48_000,
  maxTotalDiffBytes: 120_000,
  maxChecks: 40,
} as const;

export const TASK_STAGING_WRITE_BOUNDARY =
  "The Developer process cwd is a task-owned directory outside the project. Codex Auto uses sandbox workspace-write with no extra writable roots, so that sandbox's writable workspace is the staging directory. This is not an OS sandbox, seatbelt, or file-permission change. A process that ignores the Codex sandbox can still write anywhere the OS user can write. ForgeOrbit does not copy staging changes into the project unless the Owner approves those exact paths. A zero exit code does not approve publication.";

export const TASK_WORKING_COPY_WRITE_BOUNDARY =
  "Development in a working copy is enabled for this project. The Developer edits an isolated task working copy outside the project and runs local project checks inside the macOS Seatbelt sandbox with network disabled and a private scratch directory. Eligible file changes are discovered after execution and presented with a reviewable diff and observed check results. The original project stays unchanged until you review and approve publication. Direct project writes, automatic publication, git push, deployment, network access for project commands, and dependency installation remain blocked.";

export const FAKE_TASK_FILES_MARKER = "__agetor_fake_task_files__";
export const FAKE_TASK_CHECKS_MARKER = "__agetor_fake_task_checks__";

export type WorkspaceFileProvenance = "tracked" | "untracked" | "absent" | "dependency";
export type WorkspaceChangeKind = "unchanged" | "created" | "modified" | "deleted";
export type WorkspaceChangeScope = "output" | "pre-existing" | "dependency" | "artifact" | "unauthorized";
export type TaskWorkspaceStatus =
  | "armed"
  | "executing"
  | "settled"
  | "published"
  | "publication-partial"
  | "abandoned";

const EPHEMERAL_ARTIFACT_SEGMENTS = new Set([
  ".pytest_cache",
  "__pycache__",
  ".mypy_cache",
  ".ruff_cache",
  ".vitest",
  ".cache",
  ".turbo",
  ".parcel-cache",
  "coverage",
]);

const EPHEMERAL_ARTIFACT_BASENAMES = new Set([
  ".eslintcache",
  ".tsbuildinfo",
]);

/** True when a newly created/updated path inside a working copy is an unmistakable ephemeral check/build cache. */
export function isWorkingCopyArtifactPath(rel: string): boolean {
  const parts = rel.split("/");
  const base = parts[parts.length - 1] ?? "";
  if (EPHEMERAL_ARTIFACT_BASENAMES.has(base) || base.endsWith(".tsbuildinfo")) return true;
  if (parts.some((seg) => EPHEMERAL_ARTIFACT_SEGMENTS.has(seg))) return true;
  return false;
}

export interface BaselineFile {
  path: string;
  sha256: string | null;
  bytes: number;
  provenance: WorkspaceFileProvenance;
}

export interface ChangeEntry {
  path: string;
  kind: WorkspaceChangeKind;
  scope: WorkspaceChangeScope;
  beforeSha256: string | null;
  afterSha256: string | null;
  beforeProvenance: WorkspaceFileProvenance | null;
  /** After-bytes for an in-scope created or modified text file. Never a secret file. */
  text: string | null;
  reason: string | null;
  /** When a created file matches a deleted baseline file by content hash, records the original path. */
  renamedFrom?: string | null;
  /** Per-file bounded unified diff for review. Never a secret file. */
  diff?: string | null;
}

export interface PublicationAttempt {
  id: string;
  at: number;
  paths: string[];
  outcome: "applied" | "refused" | "partial";
  reason: string | null;
  results: { path: string; status: "applied" | "failed" | "already-applied"; beforeSha256: string | null; afterSha256: string | null; error: string | null }[];
}

export interface TaskWorkspaceManifest {
  version: 1;
  projectId: string;
  projectPath: string;
  taskId: string;
  taskRevision: string;
  developerRunId: string | null;
  stagingPath: string;
  /** Private 0700 scratch directory alongside stagingPath for temp files/check outputs. */
  scratchPath?: string | null;
  /** Absent on legacy rows, which default to `explicit-outputs`. */
  writeScope?: TaskWorkspaceWriteScope;
  gitHead: string;
  outputPaths: string[];
  dependencyPaths: string[];
  files: BaselineFile[];
  omitted: { path: string; reason: string }[];
  fingerprint: string;
  resourceFingerprint: string;
  executionMode: "task-staging";
  layout: "non-git";
  sandbox: "workspace-write";
  osSandbox: boolean;
  writeBoundary: string;
  exitCode: number | null;
  /** Set when the Developer run was stopped by the Owner or reached its time limit: its staged files are incomplete and cannot be published. */
  interruption?: { reason: "manual" | "time-limit"; limitSeconds: number | null } | null;
  violation: boolean;
  scanComplete: boolean;
  changes: ChangeEntry[];
  /** Combined bounded unified diff across eligible discovered changes. */
  diff?: string | null;
  /** Observed/recorded local project checks for this working copy. */
  checks?: WorkingCopyCheckRecord[];
  publications: PublicationAttempt[];
}

export interface TaskWorkspaceView {
  id: string;
  taskId: string;
  status: TaskWorkspaceStatus;
  projectId: string;
  projectPath: string;
  stagingPath: string;
  scratchPath: string | null;
  writeScope: TaskWorkspaceWriteScope;
  gitHead: string;
  taskRevision: string;
  developerRunId: string | null;
  outputPaths: string[];
  dependencyPaths: string[];
  fingerprint: string;
  resourceFingerprint: string;
  executionMode: "task-staging";
  layout: "non-git";
  sandbox: "workspace-write";
  osSandbox: boolean;
  writeBoundary: string;
  exitCode: number | null;
  interruption: { reason: "manual" | "time-limit"; limitSeconds: number | null } | null;
  violation: boolean;
  scanComplete: boolean;
  files: BaselineFile[];
  omitted: { path: string; reason: string }[];
  changes: ChangeEntry[];
  diff: string | null;
  checks: WorkingCopyCheckRecord[];
  checkSummary: WorkingCopyCheckSummary;
  publications: PublicationAttempt[];
  evidenceScope: {
    included: { path: string; role: "implementation" | "test" }[];
    omitted: { path: string; reason: string }[];
  };
  authorizesPublication: false;
  authorizesReviewer: false;
  authorizesTest: false;
}

export function normalizeWorkspacePaths(values: unknown, limit: number): { ok: true; paths: string[] } | { ok: false; error: string } {
  if (values == null) return { ok: true, paths: [] };
  if (!Array.isArray(values)) return { ok: false, error: "Paths must be a list of relative project paths." };
  if (values.length > limit) return { ok: false, error: `At most ${limit} paths can be named.` };
  const paths: string[] = [];
  for (const value of values) {
    if (typeof value !== "string") return { ok: false, error: "Each path must be a string." };
    const rel = value.trim().replace(/^\.\//, "");
    if (isUnsafeRelPath(rel) || rel === ".git" || rel.startsWith(".git/")) {
      return { ok: false, error: `Unsafe path: ${rel || "(empty)"}` };
    }
    if (isSecretRelPath(rel)) return { ok: false, error: `Secret path cannot be an execution path: ${rel}` };
    if (!paths.includes(rel)) paths.push(rel);
  }
  return { ok: true, paths };
}

export function workspaceFingerprint(input: {
  projectPath: string;
  gitHead: string;
  outputPaths: string[];
  files: { path: string; sha256: string | null; provenance: string }[];
}): string {
  const files = [...input.files].sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
  return sha256Text(JSON.stringify({
    projectPath: input.projectPath,
    gitHead: input.gitHead,
    outputPaths: [...input.outputPaths].sort(),
    files,
  }));
}

export function resourceFingerprint(input: {
  projectPath: string;
  gitHead: string;
  outputPaths: string[];
  taskId: string;
  writeScope?: TaskWorkspaceWriteScope;
  osSandbox?: boolean;
}): string {
  const writeScope = input.writeScope ?? "explicit-outputs";
  const osSandbox = input.osSandbox ?? false;
  return sha256Text(JSON.stringify({
    executionMode: "task-staging",
    ...(writeScope === "working-copy" ? { writeScope } : {}),
    layout: "non-git",
    sandbox: "workspace-write",
    osSandbox,
    taskId: input.taskId,
    projectPath: input.projectPath,
    gitHead: input.gitHead,
    outputPaths: [...input.outputPaths].sort(),
  }));
}

export function classifyWorkspaceChanges(input: {
  files: BaselineFile[];
  outputPaths: string[];
  dependencyPaths: string[];
  after: { path: string; sha256: string; unsafe?: string }[];
  writeScope?: TaskWorkspaceWriteScope;
}): { changes: ChangeEntry[]; violation: boolean; scanComplete: boolean } {
  const writeScope = input.writeScope ?? "explicit-outputs";
  const before = new Map(input.files.map((file) => [file.path, file]));
  const after = new Map(input.after.map((file) => [file.path, file]));
  const paths = [...new Set([...before.keys(), ...after.keys()])].sort();
  const changes: ChangeEntry[] = [];
  for (const rel of paths) {
    const prior = before.get(rel) ?? null;
    const next = after.get(rel) ?? null;
    if (next?.unsafe) {
      changes.push({
        path: rel, kind: prior && prior.provenance !== "absent" ? "modified" : "created", scope: "unauthorized",
        beforeSha256: prior?.sha256 ?? null, afterSha256: null, beforeProvenance: prior?.provenance ?? null,
        text: null, reason: next.unsafe,
      });
      continue;
    }
    const beforeHash = prior && prior.provenance !== "absent" ? prior.sha256 : null;
    const afterHash = next?.sha256 ?? null;
    let kind: WorkspaceChangeKind = "unchanged";
    if (beforeHash == null && afterHash != null) kind = "created";
    else if (beforeHash != null && afterHash == null) kind = "deleted";
    else if (beforeHash !== afterHash) kind = "modified";
    const dependency = input.dependencyPaths.includes(rel) || prior?.provenance === "dependency";
    let scope: WorkspaceChangeScope = "pre-existing";
    let reason: string | null = null;

    if (writeScope === "working-copy") {
      if (kind !== "unchanged") {
        if (isUnsafeRelPath(rel) || rel === ".git" || rel.startsWith(".git/")) {
          scope = "unauthorized";
          reason = "Unsafe or Git metadata path cannot be changed in a working copy.";
        } else if (isSecretRelPath(rel)) {
          scope = "unauthorized";
          reason = "Secret or credential path cannot be published from a working copy.";
        } else if (beforeHash == null && isWorkingCopyArtifactPath(rel)) {
          scope = "artifact";
          reason = "Ephemeral build or check cache artifact (excluded from project publication).";
        } else {
          scope = "output";
        }
      } else if (dependency) {
        scope = "dependency";
      }
    } else {
      const output = input.outputPaths.includes(rel);
      if (kind !== "unchanged" && !output) {
        scope = "unauthorized";
        reason = "This path is outside the Owner-approved output paths.";
      } else if (output) {
        scope = "output";
      } else if (dependency) {
        scope = "dependency";
      }
    }

    changes.push({
      path: rel,
      kind,
      scope,
      beforeSha256: beforeHash,
      afterSha256: afterHash,
      beforeProvenance: prior?.provenance ?? null,
      text: null,
      reason,
    });
  }

  // Detect exact-content 1:1 renames in working-copy mode so review diffs show renames clearly.
  if (writeScope === "working-copy") {
    const deletedByHash = new Map<string, ChangeEntry[]>();
    const createdByHash = new Map<string, ChangeEntry[]>();
    for (const entry of changes) {
      if (entry.scope !== "output") continue;
      if (entry.kind === "deleted" && entry.beforeSha256) {
        const list = deletedByHash.get(entry.beforeSha256) ?? [];
        list.push(entry);
        deletedByHash.set(entry.beforeSha256, list);
      } else if (entry.kind === "created" && entry.afterSha256) {
        const list = createdByHash.get(entry.afterSha256) ?? [];
        list.push(entry);
        createdByHash.set(entry.afterSha256, list);
      }
    }
    for (const [hash, createdList] of createdByHash.entries()) {
      const deletedList = deletedByHash.get(hash);
      if (createdList.length === 1 && deletedList && deletedList.length === 1) {
        createdList[0]!.renamedFrom = deletedList[0]!.path;
      }
    }
  }

  const violation = changes.some((entry) => entry.scope === "unauthorized");
  return { changes, violation, scanComplete: true };
}

export function evidenceScopeFromChanges(changes: ChangeEntry[], files: BaselineFile[]): TaskWorkspaceView["evidenceScope"] {
  const included: { path: string; role: "implementation" | "test" }[] = [];
  const omitted: { path: string; reason: string }[] = [];
  for (const entry of changes) {
    if ((entry.kind === "created" || entry.kind === "modified") && entry.scope === "output") {
      included.push({ path: entry.path, role: "implementation" });
      const sibling = siblingTest(entry.path);
      if (sibling && files.some((file) => file.path === sibling && file.provenance !== "absent") && !included.some((item) => item.path === sibling)) {
        included.push({ path: sibling, role: "test" });
      }
    } else if (entry.scope === "unauthorized") {
      omitted.push({ path: entry.path, reason: "Unauthorized change. Not included as this task's implementation." });
    } else if (entry.scope === "artifact") {
      omitted.push({ path: entry.path, reason: "Ephemeral build or check artifact. Not included as project source." });
    } else if (entry.kind === "unchanged" && entry.beforeProvenance === "untracked") {
      omitted.push({ path: entry.path, reason: "Pre-existing untracked file from earlier work. Not a change from this Developer run." });
    } else if (entry.scope === "dependency" && entry.kind === "unchanged") {
      omitted.push({ path: entry.path, reason: "Labeled dependency. Not a modification from this Developer run." });
    }
  }
  return { included, omitted };
}

function siblingTest(rel: string): string | null {
  const slash = rel.lastIndexOf("/");
  const dir = slash === -1 ? "" : rel.slice(0, slash);
  const base = slash === -1 ? rel : rel.slice(slash + 1);
  const dot = base.lastIndexOf(".");
  if (dot <= 0) return null;
  const name = `${base.slice(0, dot)}.test${base.slice(dot)}`;
  return dir ? `${dir}/${name}` : name;
}

export interface ParsedFakeTaskFiles {
  ok: true;
  writes: { path: string; contents: string }[];
  deletes?: string[];
  renames?: { from: string; to: string }[];
}

export function parseFakeTaskFiles(prompt: string): ParsedFakeTaskFiles | { ok: false; error: string } | null {
  const idx = prompt.lastIndexOf(FAKE_TASK_FILES_MARKER);
  if (idx < 0) return null;
  const raw = prompt.slice(idx + FAKE_TASK_FILES_MARKER.length).trim();
  if (!raw.startsWith(":")) return { ok: false, error: "Fake task file marker is missing its payload." };
  const body = raw.slice(1).trim();
  let parsed: unknown;
  try {
    parsed = JSON.parse(body.slice(0, body.indexOf("}") >= 0 ? matchingObject(body) : 0));
  } catch {
    return { ok: false, error: "Fake task file marker payload is not JSON." };
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return { ok: false, error: "Fake task file marker payload must be an object." };
  }
  const rec = parsed as { writes?: unknown; deletes?: unknown; renames?: unknown };
  const writes = Array.isArray(rec.writes) ? rec.writes : null;
  if (!writes) return { ok: false, error: "Fake task file marker has no writes list." };
  if (writes.length > 32) return { ok: false, error: "Fake task file marker names too many writes." };
  const out: { path: string; contents: string }[] = [];
  for (const item of writes) {
    if (!item || typeof item !== "object") return { ok: false, error: "Fake task file write is not an object." };
    const path = (item as { path?: unknown }).path;
    const contents = (item as { contents?: unknown }).contents;
    if (typeof path !== "string" || typeof contents !== "string") return { ok: false, error: "Fake task file write needs a path and contents." };
    const rel = path.trim().replace(/^\.\//, "");
    if (isUnsafeRelPath(rel)) return { ok: false, error: `Fake task file path is unsafe: ${rel}` };
    if (Buffer.byteLength(contents) > TASK_WORKSPACE_LIMITS.maxFileBytes) return { ok: false, error: `Fake task file exceeds the size limit: ${rel}` };
    out.push({ path: rel, contents });
  }
  let deletes: string[] | undefined;
  if (rec.deletes !== undefined) {
    if (!Array.isArray(rec.deletes) || rec.deletes.length > 32) return { ok: false, error: "Fake task file deletes list is invalid." };
    deletes = [];
    for (const item of rec.deletes) {
      if (typeof item !== "string") return { ok: false, error: "Fake task file delete path must be a string." };
      const rel = item.trim().replace(/^\.\//, "");
      if (isUnsafeRelPath(rel)) return { ok: false, error: `Fake task file delete path is unsafe: ${rel}` };
      deletes.push(rel);
    }
  }
  let renames: { from: string; to: string }[] | undefined;
  if (rec.renames !== undefined) {
    if (!Array.isArray(rec.renames) || rec.renames.length > 32) return { ok: false, error: "Fake task file renames list is invalid." };
    renames = [];
    for (const item of rec.renames) {
      if (!item || typeof item !== "object") return { ok: false, error: "Fake task file rename must be an object." };
      const from = (item as { from?: unknown }).from;
      const to = (item as { to?: unknown }).to;
      if (typeof from !== "string" || typeof to !== "string") return { ok: false, error: "Fake task file rename needs from and to paths." };
      const fromRel = from.trim().replace(/^\.\//, "");
      const toRel = to.trim().replace(/^\.\//, "");
      if (isUnsafeRelPath(fromRel) || isUnsafeRelPath(toRel)) return { ok: false, error: `Fake task file rename path is unsafe: ${fromRel} -> ${toRel}` };
      renames.push({ from: fromRel, to: toRel });
    }
  }
  return {
    ok: true,
    writes: out,
    ...(deletes ? { deletes } : {}),
    ...(renames ? { renames } : {}),
  };
}

export function parseFakeTaskChecks(prompt: string): { ok: true; commands: string[] } | { ok: false; error: string } | null {
  const idx = prompt.lastIndexOf(FAKE_TASK_CHECKS_MARKER);
  if (idx < 0) return null;
  const raw = prompt.slice(idx + FAKE_TASK_CHECKS_MARKER.length).trim();
  if (!raw.startsWith(":")) return { ok: false, error: "Fake task check marker is missing its payload." };
  const body = raw.slice(1).trim();
  let parsed: unknown;
  try {
    parsed = JSON.parse(body.slice(0, body.indexOf("}") >= 0 ? matchingObject(body) : 0));
  } catch {
    return { ok: false, error: "Fake task check marker payload is not JSON." };
  }
  const commands = parsed && typeof parsed === "object" && Array.isArray((parsed as { commands?: unknown }).commands)
    ? (parsed as { commands: unknown[] }).commands
    : null;
  if (!commands) return { ok: false, error: "Fake task check marker has no commands list." };
  if (commands.length > 10) return { ok: false, error: "Fake task check marker names too many commands." };
  const out: string[] = [];
  for (const item of commands) {
    if (typeof item !== "string" || !item.trim()) return { ok: false, error: "Each fake task check command must be a non-empty string." };
    out.push(item.trim());
  }
  return { ok: true, commands: out };
}

function matchingObject(body: string): number {
  let depth = 0;
  let inString = false;
  let escape = false;
  for (let i = 0; i < body.length; i++) {
    const ch = body[i];
    if (inString) {
      if (escape) escape = false;
      else if (ch === "\\") escape = true;
      else if (ch === "\"") inString = false;
      continue;
    }
    if (ch === "\"") inString = true;
    else if (ch === "{") depth++;
    else if (ch === "}") {
      depth--;
      if (depth === 0) return i + 1;
    }
  }
  throw new Error("truncated");
}

export function workspaceView(id: string, status: TaskWorkspaceStatus, manifest: TaskWorkspaceManifest): TaskWorkspaceView {
  const writeScope: TaskWorkspaceWriteScope = manifest.writeScope ?? "explicit-outputs";
  const checks = Array.isArray(manifest.checks) ? manifest.checks : [];
  return {
    id,
    taskId: manifest.taskId,
    status,
    projectId: manifest.projectId,
    projectPath: manifest.projectPath,
    stagingPath: manifest.stagingPath,
    scratchPath: manifest.scratchPath ?? null,
    writeScope,
    gitHead: manifest.gitHead,
    taskRevision: manifest.taskRevision,
    developerRunId: manifest.developerRunId,
    outputPaths: manifest.outputPaths,
    dependencyPaths: manifest.dependencyPaths,
    fingerprint: manifest.fingerprint,
    resourceFingerprint: manifest.resourceFingerprint,
    executionMode: "task-staging",
    layout: "non-git",
    sandbox: "workspace-write",
    osSandbox: manifest.osSandbox === true,
    writeBoundary: manifest.writeBoundary,
    exitCode: manifest.exitCode,
    interruption: manifest.interruption ?? null,
    violation: manifest.violation,
    scanComplete: manifest.scanComplete,
    files: manifest.files,
    omitted: manifest.omitted,
    changes: manifest.changes,
    diff: manifest.diff ?? null,
    checks,
    checkSummary: summarizeWorkingCopyChecks(checks),
    publications: manifest.publications,
    evidenceScope: evidenceScopeFromChanges(manifest.changes, manifest.files),
    authorizesPublication: false,
    authorizesReviewer: false,
    authorizesTest: false,
  };
}
