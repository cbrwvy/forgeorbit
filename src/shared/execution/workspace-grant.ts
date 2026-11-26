/**
 * Owner approval for one Developer execution in a task-owned directory.
 * The grant is data about a project, an operation, and a scope. It does not
 * select Full access and it does not write the project's Git data.
 */
import { validateProjectPath } from "../clusters/paths.ts";
import { normalizeWorkspacePaths, TASK_WORKSPACE_LIMITS } from "../task-workspace.ts";

export const DEVELOPER_EXECUTION_OPERATION = "developer-execution";
export const TASK_STAGING_SCOPE = "task-staging";

export const TASK_STAGING_PERMISSION_BLOCK =
  "Execution planning is blocked. This repository can be read without extra access. Sandboxed Auto cannot write external Git metadata such as the shared Git directory used by a linked worktree. Approve a task-owned workspace for this registered project, operation developer-execution, scope task-staging. That approval writes only inside the task-owned directory. Full access stays off. Rejecting this permission leaves execution blocked. Nothing was started.";

export interface TaskStagingGrant {
  operation: typeof DEVELOPER_EXECUTION_OPERATION;
  projectPath: string;
  scope: typeof TASK_STAGING_SCOPE;
  outputPaths: string[];
}

const GRANT_KEYS = ["operation", "projectPath", "scope", "outputPaths"] as const;

export function parseTaskStagingGrant(value: unknown): { ok: true; grant: TaskStagingGrant } | { ok: false; error: string } {
  if (!value || typeof value !== "object" || Array.isArray(value)) return { ok: false, error: "Execution permission must name the project, operation, and scope." };
  const record = value as Record<string, unknown>;
  for (const key of Object.keys(record)) {
    if (!(GRANT_KEYS as readonly string[]).includes(key)) return { ok: false, error: "Execution permission has an unsupported field." };
  }
  if (record.operation !== DEVELOPER_EXECUTION_OPERATION) {
    return { ok: false, error: "Execution permission operation must be developer-execution." };
  }
  if (record.scope !== TASK_STAGING_SCOPE) {
    return { ok: false, error: "Execution permission scope must be task-staging." };
  }
  const project = validateProjectPath(record.projectPath);
  if (!project.ok) return { ok: false, error: project.error };
  const outputs = normalizeWorkspacePaths(record.outputPaths, TASK_WORKSPACE_LIMITS.maxOutputPaths);
  if (!outputs.ok) return { ok: false, error: outputs.error };
  if (outputs.paths.length === 0) return { ok: false, error: "Name at least one permitted output path." };
  return {
    ok: true,
    grant: {
      operation: DEVELOPER_EXECUTION_OPERATION,
      projectPath: project.path,
      scope: TASK_STAGING_SCOPE,
      outputPaths: outputs.paths,
    },
  };
}

export function presentPermissionBlocks(errors: { code: string; message: string }[]): { code: string; message: string }[] {
  return errors.map((item) =>
    item.code === "permission-owner-decision" && item.message.includes("Git writes outside")
      ? { ...item, code: "task-staging-required", message: TASK_STAGING_PERMISSION_BLOCK }
      : item,
  );
}
