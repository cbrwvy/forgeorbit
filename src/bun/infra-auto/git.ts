/**
 * Fixed-argv Git adapter for registered project workspaces.
 * The argument list is chosen here. Callers cannot pass a shell command.
 */
import { spawnSync } from "node:child_process";
import { mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { assertGitToken, normalizeSha, redactInfraText, type GitInspection } from "../../shared/infra-auto/model.ts";

const HOOKS = path.join(tmpdir(), "forgeorbit-empty-git-hooks");
mkdirSync(HOOKS, { recursive: true });

export interface GitResult {
  status: number;
  stdout: string;
  stderr: string;
}

export type GitRunner = (cwd: string, args: string[]) => GitResult;

export const defaultGitRunner: GitRunner = (cwd, args) => {
  const proc = spawnSync("git", ["-c", `core.hooksPath=${HOOKS}`, "-c", "credential.helper=", ...args], {
    cwd,
    encoding: "utf8",
    timeout: 8_000,
    env: {
      ...process.env,
      GIT_TERMINAL_PROMPT: "0",
      GIT_CONFIG_NOSYSTEM: "1",
    },
  });
  return { status: proc.status ?? 1, stdout: proc.stdout ?? "", stderr: proc.stderr ?? "" };
};

const UNMERGED = new Set(["DD", "AU", "UD", "UA", "DU", "AA", "UU"]);

export function buildGitMutationArgs(op: "fetch" | "push", remote: string, branch: string): string[] {
  const safeRemote = assertGitToken(remote, "remote", false);
  const safeBranch = assertGitToken(branch, "branch", true);
  if (op === "fetch") return ["fetch", "--prune", safeRemote];
  return ["push", safeRemote, `${safeBranch}:${safeBranch}`];
}

export function inspectGit(cwd: string, run: GitRunner = defaultGitRunner): GitInspection {
  const status = run(cwd, ["status", "--porcelain=v1", "-b", "--untracked-files=all"]);
  if (status.status !== 0) {
    throw new Error(redactInfraText(status.stderr || status.stdout || "git status failed").split("\n")[0] ?? "git status failed");
  }
  const lines = status.stdout.split("\n").filter((line) => line.length > 0);
  const header = lines[0]?.startsWith("## ") ? lines[0].slice(3) : "";
  const detached = header.startsWith("HEAD (no branch)") || header.startsWith("No commits yet");
  let branch: string | null = null;
  let upstream: string | null = null;
  let ahead: number | null = null;
  let behind: number | null = null;
  if (!detached && header) {
    const [refs, tracking] = header.split(" [");
    const parts = (refs ?? "").split("...");
    branch = parts[0] || null;
    upstream = parts[1] || null;
    if (tracking) {
      const aheadMatch = /ahead (\d+)/.exec(tracking);
      const behindMatch = /behind (\d+)/.exec(tracking);
      ahead = aheadMatch ? Number(aheadMatch[1]) : 0;
      behind = behindMatch ? Number(behindMatch[1]) : 0;
    }
  }
  const changedFiles: string[] = [];
  const conflicts: string[] = [];
  for (const line of lines.slice(header ? 1 : 0)) {
    if (line.startsWith("## ")) continue;
    const code = line.slice(0, 2);
    const file = line.slice(3);
    if (!file) continue;
    changedFiles.push(file);
    if (UNMERGED.has(code)) conflicts.push(file);
  }
  const head = run(cwd, ["rev-parse", "--verify", "HEAD"]);
  const headSha = head.status === 0 ? normalizeSha(head.stdout.trim()) : null;
  const log = run(cwd, ["log", "-n", "8", "--format=%H%x09%s"]);
  const recentCommits = log.status === 0
    ? log.stdout.split("\n").flatMap((line) => {
        const [sha, subject] = line.split("\t");
        const normalized = normalizeSha(sha ?? "");
        if (!normalized) return [];
        return [{ sha: normalized, subject: redactInfraText(subject ?? "", 160) }];
      })
    : [];
  const diff = run(cwd, ["diff", "--stat"]);
  const staged = run(cwd, ["diff", "--cached", "--stat"]);
  const diffStat = redactInfraText(`${diff.stdout}\n${staged.stdout}`.trim(), 2_000);
  const remotes = run(cwd, ["remote"]);
  const remoteNames = remotes.status === 0 ? remotes.stdout.split("\n").map((item) => item.trim()).filter(Boolean) : [];
  const fetchReady = remoteNames.length > 0
    ? { ready: true, reason: "A remote is configured. Fetch has not been run by this inspection." }
    : { ready: false, reason: "No Git remote is configured." };
  let pushReason = "Push was not run.";
  let pushReady = false;
  if (detached || !branch) pushReason = "The repository is not on a named branch.";
  else if (conflicts.length > 0) pushReason = "Unmerged files are present.";
  else if (changedFiles.length > 0) pushReason = "The worktree has uncommitted changes.";
  else if (!upstream) pushReason = "The branch has no upstream.";
  else if ((behind ?? 0) > 0) pushReason = "The branch is behind its upstream.";
  else if ((ahead ?? 0) === 0) pushReason = "The branch has no commits to push.";
  else {
    pushReady = true;
    pushReason = `The branch is ${ahead} commit(s) ahead of ${upstream}. Push still requires a separate authorization.`;
  }
  return {
    path: cwd,
    branch,
    head: headSha,
    upstream,
    ahead,
    behind,
    dirty: changedFiles.length > 0,
    changedFiles,
    conflicts,
    recentCommits,
    diffStat,
    detached,
    fetchReady,
    pushReady: { ready: pushReady, reason: pushReason },
  };
}

export function verifyCommit(cwd: string, sha: string, run: GitRunner = defaultGitRunner): boolean {
  const normalized = normalizeSha(sha);
  if (!normalized) return false;
  const result = run(cwd, ["cat-file", "-t", normalized]);
  return result.status === 0 && result.stdout.trim() === "commit";
}

export function branchCommit(cwd: string, branch: string, run: GitRunner = defaultGitRunner): string | null {
  const safe = assertGitToken(branch, "branch", true);
  const result = run(cwd, ["rev-parse", "--verify", `${safe}^{commit}`]);
  if (result.status !== 0) return null;
  return normalizeSha(result.stdout.trim());
}
