import { PROVIDER_FOR_HARNESS } from "../../shared/accounts/capabilities.ts";
import type { Database } from "bun:sqlite";
import { existsSync } from "node:fs";
import { join } from "node:path";
import type { Task } from "../../shared/types.ts";

export type Complexity = "low" | "medium" | "high";
export interface RunScope {
  projectPath: string | null;
  clusterId: string | null;
  missionId: string | null;
  category: string;
  specialistRole?: string;
  technology: string;
  complexity: Complexity | null;
}

export const providerName = (kind: string): string => Object.hasOwn(PROVIDER_FOR_HARNESS, kind) ?
  PROVIDER_FOR_HARNESS[kind as keyof typeof PROVIDER_FOR_HARNESS] : kind;

const manifests = [
  ["package.json", "JavaScript/TypeScript"], ["Cargo.toml", "Rust"], ["go.mod", "Go"],
  ["pyproject.toml", "Python"], ["Package.swift", "Swift"], ["Gemfile", "Ruby"],
  ["pom.xml", "JVM"], ["composer.json", "PHP"],
] as const;

/** Bounded project signals. No project file contents or inference are needed. */
export function scopeFor(
  database: Database, task: Pick<Task, "id" | "prompt" | "taskType">, projectPath: string | null,
): RunScope & { complexity: Complexity } {
  const membership = projectPath && database.query<{ cluster_id: string }, [string]>(
    "SELECT cluster_id FROM cluster_project_memberships WHERE project_path = ?",
  ).get(projectPath);
  const mission = database.query<{ mission_id: string }, [string]>(
    "SELECT mission_id FROM orchestration_reservations WHERE task_id = ? AND status IN ('reserved','starting','running','awaiting_qc','qc_running')",
  ).get(task.id);
  const technology = projectPath
    ? manifests.filter(([file]) => existsSync(join(projectPath, file))).map(([, name]) => name).join(", ")
    : "";
  const scopePoints = task.prompt.length + 120 * (task.prompt.match(/^\s*(?:[-*]|\d+\.)\s+/gm)?.length ?? 0);
  const crossCutting = /\b(migration|concurrency|authentication|refactor|architecture)\b/i.test(task.prompt);
  const complexity = scopePoints > 3200 || crossCutting ? "high" : scopePoints > 650 ? "medium" : "low";
  return {
    projectPath, clusterId: membership ? membership.cluster_id : null,
    missionId: mission?.mission_id ?? null, category: task.taskType, technology: technology || "unknown", complexity,
  };
}
