/** Fresh read-only workspace probes and configuration fingerprints for Owner permission reviews. */
import { existsSync, lstatSync, realpathSync, statSync, readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import type { Task, Harness } from "../shared/types.ts";
import type { WorkspaceLayout } from "../shared/execution/permissions.ts";
import { gitWorkingTreeCapability, gitWritableRoots } from "./worktree.ts";

export interface DetectedLayout {
  layout: WorkspaceLayout;
  /** True when the workspace does not exist yet (a worktree created at start). */
  predicted: boolean;
}

export async function detectWorkspaceLayout(task: Pick<Task, "isolation" | "workdir" | "worktreePath">): Promise<DetectedLayout> {
  try {
    const worktreeExists = !!task.worktreePath && existsSync(task.worktreePath);
    if (task.isolation === "worktree" && !worktreeExists) {
      // A task worktree is always a linked worktree of the source repo.
      const capability = await gitWorkingTreeCapability(task.workdir);
      if (capability.kind === "git") return { layout: "linked-worktree", predicted: true };
      return { layout: capability.kind === "non-git" ? "non-git" : "unknown", predicted: true };
    }
    const cwd = task.isolation === "worktree" ? task.worktreePath! : task.workdir;
    if (!existsSync(cwd)) return { layout: "unknown", predicted: false };
    const capability = await gitWorkingTreeCapability(cwd);
    if (capability.kind === "non-git") return { layout: "non-git", predicted: false };
    if (capability.kind !== "git") return { layout: "unknown", predicted: false };
    const external = await gitWritableRoots(cwd);
    if (external.length === 0) return { layout: "repo-root", predicted: false };
    let dotGitIsFile = false;
    try { dotGitIsFile = lstatSync(path.join(cwd, ".git")).isFile(); } catch { /* subfolder below the root */ }
    return { layout: dotGitIsFile ? "linked-worktree" : "repo-subfolder", predicted: false };
  } catch {
    return { layout: "unknown", predicted: false };
  }
}

/** Binds review to canonical cwd and Git metadata locations, not only a layout label.
 * No Git mutation. A missing or unreadable location cannot yield a launch grant.
 * Predicted linked worktrees bind to the source topology until creation; the
 * final adapter validates the newly created workspace independently.
 */
export function workspacePermissionIdentity(task: Pick<Task, "isolation" | "workdir" | "worktreePath">, harness?: Pick<Harness, "home" | "env"> & Partial<Pick<Harness, "bin">>): string | null {
  try {
    const cwd = task.isolation === "worktree" && task.worktreePath && existsSync(task.worktreePath) ? task.worktreePath : task.workdir;
    if (!statSync(cwd).isDirectory()) return null;
    const root = realpathSync(cwd);
    const git = spawnSync("git", ["rev-parse", "--show-toplevel", "--absolute-git-dir", "--path-format=absolute", "--git-common-dir"],
      { cwd, encoding: "utf8", timeout: 3000, env: { ...process.env, LC_ALL: "C" } });
    let topology: string[];
    if (git.status === 0) topology = git.stdout.trim().split("\n").map((p) => realpathSync(p));
    else if (git.status === 128 && /not a git repository/.test(git.stderr)) {
      for (let dir = root; ; dir = path.dirname(dir)) {
        try { lstatSync(path.join(dir, ".git")); return null; }
        catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") return null; }
        if (path.dirname(dir) === dir) break;
      }
      topology = ["non-git"];
    }
    else return null;
    const environment: Record<string, string | undefined> = { ...process.env, ...(harness?.home ? { HOME: harness.home, CODEX_HOME: path.join(harness.home, ".codex") } : {}), ...harness?.env };
    const codexHome = environment.CODEX_HOME ?? path.join(environment.HOME ?? "", ".codex");
    const configs: string[] = [];
    const add = (file: string) => { if (existsSync(file)) configs.push(file, createHash("sha256").update(readFileSync(file)).digest("hex")); };
    add(path.join(codexHome, "config.toml"));
    if (existsSync(codexHome)) for (const file of readdirSync(codexHome).sort()) if (file.endsWith(".config.toml")) add(path.join(codexHome, file));
    for (let dir = root; ; dir = path.dirname(dir)) {
      add(path.join(dir, ".codex", "config.toml"));
      if (path.dirname(dir) === dir) break;
    }
    add("/etc/codex/managed_config.toml");
    add("/etc/codex/requirements.toml");
    return createHash("sha256").update(JSON.stringify([root, topology, codexHome, configs, harness?.env ?? {}, harness?.bin ?? null, environment.AGETOR_CODEX_ARGS ?? ""])).digest("hex");
  } catch { return null; }
}

/** Read-only synchronous counterpart for a check inside the Owner claim transaction. */
export function detectWorkspaceLayoutNow(task: Pick<Task, "isolation" | "workdir" | "worktreePath">): DetectedLayout {
  try {
    const predicted = task.isolation === "worktree" && !(task.worktreePath && existsSync(task.worktreePath));
    const cwd = task.isolation === "worktree" && !predicted ? task.worktreePath! : task.workdir;
    if (!statSync(cwd).isDirectory()) return { layout: "unknown", predicted };
    const result = spawnSync("git", ["rev-parse", "--show-toplevel", "--absolute-git-dir", "--path-format=absolute", "--git-common-dir"], { cwd, encoding: "utf8", timeout: 3000 });
    if (result.status !== 0) {
      if (result.status !== 128 || !/not a git repository/.test(result.stderr)) return { layout: "unknown", predicted };
      for (let dir = realpathSync(cwd); ; dir = path.dirname(dir)) {
        try { lstatSync(path.join(dir, ".git")); return { layout: "unknown", predicted }; }
        catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") return { layout: "unknown", predicted }; }
        if (path.dirname(dir) === dir) break;
      }
      return { layout: "non-git", predicted };
    }
    if (predicted) return { layout: "linked-worktree", predicted };
    const [top, gitDir, common] = result.stdout.trim().split("\n");
    const root = realpathSync(cwd);
    if (root !== realpathSync(top!)) return { layout: "repo-subfolder", predicted };
    if (realpathSync(gitDir!) !== path.join(root, ".git") || realpathSync(common!) !== path.join(root, ".git")) return { layout: "linked-worktree", predicted };
    return { layout: "repo-root", predicted };
  } catch { return { layout: "unknown", predicted: false }; }
}
