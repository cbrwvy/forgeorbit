import type { EmployeeRunReviewFacts } from "./run.ts";

/**
 * How the launch review describes where the agent will work. Decided from the reviewed launch
 * target (`workspaceKind`, resolved together with the workspace path by the review itself), never
 * from the task's isolation field alone: an armed task-owned workspace is recorded with
 * `isolation: "none"` but does not run in the project folder.
 *
 * Reviews recorded before `workspaceKind` existed say nothing about the target (null), rather
 * than guessing from today's task.
 */
export type LaunchTargetNote = {
  /** Catalogue id of the sentence under the Isolation row. */
  noteId: "execution.target_task_staging" | "execution.target_working_copy" | "execution.target_worktree" | "execution.no_worktree_isolation";
  /** The project-folder case is a warning; the other two describe a separate directory. */
  tone: "warning" | "info";
  /** Catalogue id replacing the raw isolation value, when the raw value would mislead. */
  valueId: "execution.isolation_task_staging" | "execution.isolation_working_copy" | "execution.isolation_worktree" | null;
};

export function launchTargetNote(facts: Pick<EmployeeRunReviewFacts, "workspaceKind" | "workingCopyWriteScope" | "workspaceDevelopment">): LaunchTargetNote | null {
  switch (facts.workspaceKind) {
    case "task-staging":
      if (facts.workingCopyWriteScope === "working-copy" || facts.workspaceDevelopment === true) {
        return { noteId: "execution.target_working_copy", tone: "info", valueId: "execution.isolation_working_copy" };
      }
      return { noteId: "execution.target_task_staging", tone: "info", valueId: "execution.isolation_task_staging" };
    case "worktree":
      return { noteId: "execution.target_worktree", tone: "info", valueId: "execution.isolation_worktree" };
    case "project-folder":
      return { noteId: "execution.no_worktree_isolation", tone: "warning", valueId: null };
    default:
      return null;
  }
}

/** Outputs shown as "eligible for later publication"; only an armed staging workspace has them. */
export function publishablePaths(facts: Pick<EmployeeRunReviewFacts, "workspaceKind" | "stagedOutputPaths">): string[] {
  return facts.workspaceKind === "task-staging" ? [...(facts.stagedOutputPaths ?? [])] : [];
}
