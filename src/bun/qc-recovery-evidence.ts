/**
 * Implementation identity for a QC-only recovery.
 * The product does not snapshot the whole tree when a Developer run finishes.
 * Without a verified task-owned publication, recovery is allowed only when the
 * current Git worktree can be named and no listed file is newer than that run.
 * A file published through that run's own workspace may be newer: its bytes
 * must match the applied publication and the Developer change set.
 * This pass lists and hashes files. It does not spawn a test and does not launch a Reviewer.
 */
import { createHash } from "node:crypto";
import { lstatSync, readFileSync, realpathSync } from "node:fs";
import path from "node:path";
import {
  QC_RECOVERY_LIMITS,
  recoveryIdentityHash,
  recoveryRequirementsHash,
  recoveryTreeFingerprint,
  type QcRecoveryEvidence,
} from "../shared/qc-recovery.ts";
import { publishedSourceTrust } from "./task-workspace.ts";

export class QcRecoveryEvidenceError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "QcRecoveryEvidenceError";
  }
}

async function git(cwd: string, args: string[]): Promise<{ code: number; out: string; err: string }> {
  const proc = Bun.spawn(["git", "-C", cwd, ...args], { stdout: "pipe", stderr: "pipe" });
  const [out, err, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  return { code, out, err };
}

export async function collectRecoveryEvidence(input: {
  taskId: string;
  title: string;
  prompt: string;
  workdir: string;
  projectPath: string;
  isolation: string;
  worktreePath: string | null;
  developerRunId: string;
  developerEndedAt: number | null;
}): Promise<QcRecoveryEvidence> {
  if (input.developerEndedAt == null) {
    throw new QcRecoveryEvidenceError("The Developer run has no finish time, so later file edits cannot be distinguished.");
  }
  let workspace = input.workdir;
  if (input.isolation === "worktree") {
    if (!input.worktreePath) {
      throw new QcRecoveryEvidenceError("The implementation worktree path was not recorded, and no source snapshot was captured.");
    }
    workspace = input.worktreePath;
  }
  let workspacePath: string;
  let projectPath: string;
  try {
    workspacePath = realpathSync(workspace);
    projectPath = realpathSync(input.projectPath);
  } catch {
    throw new QcRecoveryEvidenceError("The implementation workspace is missing, and no source snapshot was captured when the Developer run finished.");
  }
  if (workspacePath !== projectPath && !workspacePath.startsWith(projectPath + path.sep)) {
    throw new QcRecoveryEvidenceError("The workspace is outside the task project. Recovery will not review it.");
  }
  const inside = await git(workspacePath, ["rev-parse", "--is-inside-work-tree"]);
  if (inside.code !== 0 || inside.out.trim() !== "true") {
    throw new QcRecoveryEvidenceError("This workspace is not a Git repository. ForgeOrbit did not capture a source snapshot when the Developer run finished, so the implementation cannot be identified.");
  }
  const head = await git(workspacePath, ["rev-parse", "HEAD"]);
  const gitHead = head.out.trim();
  if (head.code !== 0 || !/^[0-9a-f]{40}$/i.test(gitHead)) {
    throw new QcRecoveryEvidenceError("The workspace has no commit to identify. ForgeOrbit did not capture a source snapshot when the Developer run finished.");
  }
  const trust = publishedSourceTrust({
    developerRunId: input.developerRunId,
    taskId: input.taskId,
    projectPath,
    gitHead,
  });
  if (trust.mode === "rejected") throw new QcRecoveryEvidenceError(trust.reason ?? "Task-owned publication provenance is not valid.");
  const published = new Map(trust.accepted.map((item) => [item.path, item.sha256]));
  const listed = await git(workspacePath, ["ls-files", "-z", "--cached", "--others", "--exclude-standard"]);
  if (listed.code !== 0) {
    throw new QcRecoveryEvidenceError("The Git file list could not be read, so the implementation cannot be identified.");
  }
  const names = listed.out.split("\0").filter((name) => name.length > 0).sort((a, b) => a < b ? -1 : a > b ? 1 : 0);
  if (names.length > QC_RECOVERY_LIMITS.maxFiles) {
    throw new QcRecoveryEvidenceError(`The worktree has ${names.length} files. Recovery will not hash a tree that large without a snapshot captured at the Developer run.`);
  }
  const files: { path: string; sha256: string }[] = [];
  const newestAllowed = input.developerEndedAt + QC_RECOVERY_LIMITS.clockSkewMs;
  for (const rel of names) {
    if (rel.includes("..") || path.isAbsolute(rel)) {
      throw new QcRecoveryEvidenceError(`Git listed an unsafe path (${rel}). Recovery stopped.`);
    }
    const abs = path.join(workspacePath, rel);
    let st: ReturnType<typeof lstatSync>;
    try {
      st = lstatSync(abs);
    } catch {
      throw new QcRecoveryEvidenceError(`Listed file ${rel} is missing. The worktree changed while it was being identified.`);
    }
    if (st.isSymbolicLink()) {
      throw new QcRecoveryEvidenceError(`Listed path ${rel} is a symlink. Recovery will not follow it without a captured snapshot.`);
    }
    if (!st.isFile()) {
      throw new QcRecoveryEvidenceError(`Listed path ${rel} is not a file. Recovery cannot identify it.`);
    }
    let real = abs;
    try {
      real = realpathSync(abs);
    } catch {
      throw new QcRecoveryEvidenceError(`Listed file ${rel} could not be resolved.`);
    }
    if (real !== abs || (real !== workspacePath && !real.startsWith(workspacePath + path.sep))) {
      throw new QcRecoveryEvidenceError(`Listed path ${rel} escapes the workspace.`);
    }
    if (st.size > QC_RECOVERY_LIMITS.maxFileBytes) {
      throw new QcRecoveryEvidenceError(`File ${rel} is too large to fingerprint without a snapshot captured at the Developer run.`);
    }
    const sha256 = createHash("sha256").update(readFileSync(abs)).digest("hex");
    const expectedPublication = published.get(rel);
    if (expectedPublication && sha256 !== expectedPublication) {
      throw new QcRecoveryEvidenceError(`${rel} no longer matches the bytes published for this Developer run.`);
    }
    if (!expectedPublication && st.mtimeMs > newestAllowed) {
      throw new QcRecoveryEvidenceError(`File ${rel} changed after the successful Developer run. No source snapshot was captured, so recovery will not review later edits.`);
    }
    files.push({ path: rel, sha256 });
  }
  for (const [rel] of published) {
    if (!files.some((file) => file.path === rel)) {
      throw new QcRecoveryEvidenceError(`Published path ${rel} is missing from the workspace.`);
    }
  }
  const requirementsHash = recoveryRequirementsHash(input.prompt);
  const identityHash = recoveryIdentityHash({
    taskId: input.taskId,
    title: input.title,
    prompt: input.prompt,
    workdir: input.workdir,
    projectPath: input.projectPath,
    developerRunId: input.developerRunId,
    isolation: input.isolation,
  });
  const treeFingerprint = recoveryTreeFingerprint(gitHead, files);
  const publishedPaths = trust.mode === "published" ? trust.accepted.map((item) => item.path) : [];
  const newerPublished = publishedPaths.filter((rel) => {
    try {
      return lstatSync(path.join(workspacePath, rel)).mtimeMs > newestAllowed;
    } catch {
      return false;
    }
  });
  const note = publishedPaths.length === 0
    ? `No source snapshot was stored when Developer run ${input.developerRunId} finished. The current Git worktree is ${gitHead.slice(0, 12)} with ${files.length} listed file(s), and none are newer than that run. Approving reviews this fingerprint only.`
    : `No source snapshot was stored when Developer run ${input.developerRunId} finished. The current Git worktree is ${gitHead.slice(0, 12)} with ${files.length} listed file(s). ${publishedPaths.join(", ")} matches the applied publication and the Developer change set${newerPublished.length > 0 ? `; ${newerPublished.join(", ")} is newer because that publication wrote it after the Developer run` : ""}. Other listed files are not newer than that run. Approving reviews this fingerprint only.`;
  return {
    snapshotCapturedAtDeveloperRun: false,
    basis: "git-worktree-not-newer-than-developer-run",
    note,
    taskId: input.taskId,
    title: input.title,
    requirementsHash,
    identityHash,
    developerRunId: input.developerRunId,
    developerEndedAt: input.developerEndedAt,
    projectPath: input.projectPath,
    workspacePath,
    gitHead,
    treeFingerprint,
    fileCount: files.length,
    paths: files.map((file) => file.path),
    ...(publishedPaths.length > 0 ? { publishedPaths } : {}),
  };
}
