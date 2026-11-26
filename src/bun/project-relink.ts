/**
 * FO-PORTABLE-UI01: Project and Brain scope relinking core.
 *
 * Provides safe, verified external project relinking when an imported profile
 * contains projects whose external directories are missing on the destination machine.
 *
 * Guarantees:
 * - Selected directory must exist, be a directory, and not be a symbolic link.
 * - Resolves canonical realpath safely.
 * - Rejects system roots, application bundles, active/base data dirs, and sensitive folders.
 * - Rejects mappings that conflict with or duplicate another registered project.
 * - Transactionally updates SQLite references.
 * - Safely rebinds Brain project memory scopes without deleting, altering content,
 *   or leaking across projects. Company memories remain untouched.
 * - Idempotent operation.
 */

import { Database } from "bun:sqlite";
import { existsSync, lstatSync, realpathSync, statSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { resolveDataDir } from "./data-dir.ts";
import { openBrainStore, brainDirectory, type BrainStore } from "./brain-store.ts";

export class ProjectRelinkError extends Error {
  constructor(
    message: string,
    public readonly code: string,
    public readonly status: number = 400,
  ) {
    super(message);
    this.name = "ProjectRelinkError";
  }
}

export interface RelinkProjectInput {
  oldPath: string;
  newPath: string;
}

export interface RelinkProjectResult {
  ok: true;
  oldPath: string;
  newPath: string;
  reboundBrainMemories: number;
}

export function validateProjectRelink(
  oldPathRaw: unknown,
  newPathRaw: unknown,
  db: Database,
  dataDir: string,
): { oldPath: string; newPath: string; realNewPath: string } {
  if (typeof oldPathRaw !== "string" || !oldPathRaw.trim()) {
    throw new ProjectRelinkError("oldPath is required", "INVALID_INPUT", 400);
  }
  if (typeof newPathRaw !== "string" || !newPathRaw.trim()) {
    throw new ProjectRelinkError("newPath is required", "INVALID_INPUT", 400);
  }

  const oldPath = path.resolve(oldPathRaw.trim());
  const newPath = path.resolve(newPathRaw.trim());

  // 1. Verify oldPath is currently registered
  const projectRow = db.query<{ path: string; name: string }, [string]>(
    "SELECT path, name FROM projects WHERE path = ?;",
  ).get(oldPath);
  if (!projectRow) {
    throw new ProjectRelinkError(`Project is not registered: ${oldPath}`, "PROJECT_NOT_FOUND", 404);
  }

  // 2. Validate newPath
  if (!path.isAbsolute(newPath)) {
    throw new ProjectRelinkError("newPath must be an absolute path", "INVALID_INPUT", 400);
  }

  let stat;
  try {
    stat = statSync(newPath);
  } catch {
    throw new ProjectRelinkError(`Selected directory does not exist: ${newPath}`, "DIRECTORY_NOT_FOUND", 400);
  }

  if (!stat.isDirectory()) {
    throw new ProjectRelinkError(`Selected path is not a directory: ${newPath}`, "NOT_A_DIRECTORY", 400);
  }

  // Refuse symlinks
  try {
    const lstat = lstatSync(newPath);
    if (lstat.isSymbolicLink()) {
      throw new ProjectRelinkError("Symbolic links are not permitted as project directories", "UNTRUSTED_SYMLINK", 400);
    }
  } catch (err) {
    if (err instanceof ProjectRelinkError) throw err;
    throw new ProjectRelinkError(`Could not inspect path: ${newPath}`, "PATH_INSPECTION_FAILED", 400);
  }

  let realNewPath: string;
  try {
    realNewPath = realpathSync(newPath);
  } catch {
    throw new ProjectRelinkError(`Could not resolve realpath for: ${newPath}`, "PATH_RESOLUTION_FAILED", 400);
  }

  // 3. Protected-path checks
  const protectedRoots = [
    "/",
    "/System",
    "/Library",
    "/Applications",
    "/usr",
    "/bin",
    "/sbin",
    "/var",
    "/private",
    "/Volumes",
  ];
  for (const root of protectedRoots) {
    if (realNewPath === root) {
      throw new ProjectRelinkError(`System directory is protected: ${root}`, "PROTECTED_PATH", 400);
    }
  }

  // Disallow inside .app bundles
  if (/\.app($|\/)/.test(realNewPath) || /\.app($|\/)/.test(newPath)) {
    throw new ProjectRelinkError("Application bundles cannot be used as project repositories", "PROTECTED_PATH", 400);
  }

  // Disallow inside active or base profile directories
  const home = homedir();
  const protectedDataCandidates = [
    dataDir,
    resolveDataDir(),
    process.env.FORGEORBIT_DATA_DIR,
    process.env.AGETOR_DATA_DIR,
    path.join(home, ".agetor"),
    path.join(home, "Library", "Application Support", "ForgeOrbit"),
    path.join(home, ".ssh"),
    path.join(home, ".codex"),
    path.join(home, ".claude"),
    path.join(home, ".config"),
  ];

  for (const candidate of protectedDataCandidates) {
    if (!candidate) continue;
    let realCandidate = candidate;
    try {
      realCandidate = realpathSync(candidate);
    } catch {
      /* not on disk */
    }
    if (realNewPath === realCandidate || (!path.relative(realCandidate, realNewPath).startsWith("..") && !path.isAbsolute(path.relative(realCandidate, realNewPath)))) {
      throw new ProjectRelinkError(`Selected path is protected: ${newPath}`, "PROTECTED_PATH", 400);
    }
  }

  // 4. Duplicate or conflicting project mapping detection
  interface OtherProjectRow { path: string; name: string }
  const otherProjects = db.query<OtherProjectRow, [string]>(
    "SELECT path, name FROM projects WHERE path != ?;",
  ).all(oldPath);

  for (const other of otherProjects) {
    if (path.resolve(other.path) === newPath) {
      throw new ProjectRelinkError(
        `Path is already assigned to project "${other.name}" (${other.path})`,
        "PROJECT_CONFLICT",
        409,
      );
    }
    let otherReal: string | null = null;
    try {
      otherReal = realpathSync(other.path);
    } catch {
      /* other project directory may not exist on disk */
    }
    if (otherReal && otherReal === realNewPath) {
      throw new ProjectRelinkError(
        `Directory already resolves to project "${other.name}" (${other.path})`,
        "PROJECT_CONFLICT",
        409,
      );
    }
  }

  return { oldPath, newPath, realNewPath };
}

export function relinkProject(
  input: RelinkProjectInput,
  deps: {
    db: Database;
    dataDir: string;
    brainStore?: BrainStore;
    onVersionBump?: () => void;
    throwOnBrainError?: boolean;
  },
): RelinkProjectResult {
  const { oldPath, realNewPath: newPath } = validateProjectRelink(input.oldPath, input.newPath, deps.db, deps.dataDir);

  if (oldPath === newPath) {
    return { ok: true, oldPath, newPath, reboundBrainMemories: 0 };
  }

  // 1. Transactionally update database references
  const tx = deps.db.transaction(() => {
    deps.db.run("PRAGMA defer_foreign_keys = ON;");

    // Primary project row
    deps.db.run("UPDATE projects SET path = ? WHERE path = ?;", [newPath, oldPath]);

    // Tasks workdir
    deps.db.run("UPDATE tasks SET workdir = ? WHERE workdir = ?;", [newPath, oldPath]);

    // Cluster memberships
    deps.db.run("UPDATE cluster_project_memberships SET project_path = ? WHERE project_path = ?;", [newPath, oldPath]);

    // AI employees
    deps.db.run("UPDATE ai_employees SET project_path = ? WHERE project_path = ?;", [newPath, oldPath]);

    // Project managers
    deps.db.run("UPDATE project_managers SET project_path = ? WHERE project_path = ?;", [newPath, oldPath]);

    // Project rules
    deps.db.run("UPDATE project_rules SET project_path = ? WHERE project_path = ?;", [newPath, oldPath]);

    // Environment profiles
    deps.db.run("UPDATE environment_profiles SET project_path = ? WHERE project_path = ?;", [newPath, oldPath]);

    // Infrastructure links
    deps.db.run("UPDATE infrastructure_project_links SET project_path = ? WHERE project_path = ?;", [newPath, oldPath]);
    deps.db.run("UPDATE infrastructure_project_environments SET project_path = ? WHERE project_path = ?;", [newPath, oldPath]);

    // Brain context grants
    deps.db.run("UPDATE brain_context_grants SET project_path = ? WHERE project_path = ?;", [newPath, oldPath]);

    // Brain memory proposals
    deps.db.run("UPDATE brain_memory_proposals SET source_project_path = ? WHERE source_project_path = ?;", [newPath, oldPath]);
    deps.db.run("UPDATE brain_memory_proposals SET scope_id = ? WHERE scope_kind = 'project' AND scope_id = ?;", [newPath, oldPath]);

    // Optional tables
    const optionalTables = [
      "project_interviews",
      "project_manager_messages",
      "project_manager_proposals",
      "project_manager_decisions",
      "project_manager_executions",
      "project_execution_batches",
      "project_estimation",
      "portfolio_manager_delegations",
      "deployment_requests",
      "deployment_staging_integrations",
      "pm_orchestrated_workflows",
      "pm_orchestrated_batches",
      "qc_recovery_grants",
      "review_test_authorizations",
      "pm_provider_recovery",
      "browser_agent_grants",
      "native_computer_agent_grants",
      "activity_events",
    ];

    for (const tbl of optionalTables) {
      const exists = (deps.db.query<{ count: number }, [string]>(
        "SELECT count(*) as count FROM sqlite_master WHERE type='table' AND name = ?;",
      ).get(tbl)?.count ?? 0) > 0;
      if (exists) {
        const cols = new Set(deps.db.query<{ name: string }, []>(`PRAGMA table_info(${tbl});`).all().map((c) => c.name));
        if (cols.has("project_path")) {
          deps.db.run(`UPDATE ${tbl} SET project_path = ? WHERE project_path = ?;`, [newPath, oldPath]);
        }
      }
    }

    const violations = deps.db.query("PRAGMA foreign_key_check;").all();
    if (violations.length > 0) {
      throw new ProjectRelinkError(
        `Foreign key integrity violation during relink: ${JSON.stringify(violations)}`,
        "FOREIGN_KEY_VIOLATION",
        500,
      );
    }
  });

  tx();

  // 2. Rebind Brain project scopes
  let reboundCount = 0;
  try {
    let brain = deps.brainStore;
    let shouldClose = false;
    if (!brain) {
      const brainDir = brainDirectory(deps.dataDir);
      if (existsSync(path.join(brainDir, "index.sqlite"))) {
        brain = openBrainStore(brainDir, { isRegistered: () => true });
        shouldClose = true;
      }
    }
    if (brain) {
      try {
        const res = brain.rebindProjectScope(oldPath, newPath);
        reboundCount = res.reboundCount;
      } finally {
        if (shouldClose) brain.close();
      }
    }
  } catch (err) {
    console.error("[project-relink] Brain scope rebinding issue:", err);
    if (deps.throwOnBrainError) {
      throw err;
    }
  }

  deps.onVersionBump?.();

  return {
    ok: true,
    oldPath,
    newPath,
    reboundBrainMemories: reboundCount,
  };
}
