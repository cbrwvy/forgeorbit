/**
 * Bounded, read-only snapshot recovery preview.
 *
 * This module deliberately contains no server, profile or database-writer
 * imports: it runs inside the isolated backup worker (and only there for a
 * user-facing preview), so a modified snapshot database is never opened inside
 * the trusted main process.
 */

import type { Database } from "bun:sqlite";
import { existsSync, lstatSync } from "node:fs";
import path from "node:path";
import { summarizeBrainRecord, type SnapshotBrainRecord } from "../shared/brain/snapshot.ts";
import { getReferencedInternalAssets, type SnapshotManifest } from "./backup-manager.ts";
import { buildRecoveryPreview } from "./backup-restore.ts";
import type {
  BackupActivationReadiness,
  BackupRecoveryPreview,
  BackupSnapshotCounts,
  BackupSnapshotSummary,
} from "../shared/backup.ts";

const MAX_PREVIEW_PROJECTS = 50;
const MAX_PREVIEW_WORKTREES = 40;
const MAX_PREVIEW_ENVIRONMENTS = 30;
const MAX_PREVIEW_PROVIDERS = 20;
const MAX_PREVIEW_DEPENDENCIES = 40;

function boundedList(value: unknown, max: number): string[] {
  if (!Array.isArray(value)) return [];
  const out: string[] = [];
  for (const entry of value) {
    if (out.length >= max) break;
    if (typeof entry === "string" && entry.length > 0) out.push(entry);
  }
  return out;
}

/**
 * Builds the recovery preview from an already-open, read-only snapshot
 * database. The caller owns the handle and its lifetime.
 */
export function buildSnapshotRecoveryPreview(
  snapshotPath: string,
  legacy: boolean,
  db: Database,
  manifest: SnapshotManifest,
): BackupRecoveryPreview {
  const recovery = buildRecoveryPreview(db);
  let internalExpected = 0;
  let crossProfile: string[] = [];
  let external: string[] = [];
  try {
    const assets = getReferencedInternalAssets(db, {
      dataDir: snapshotPath,
      attachmentsRootDir: path.join(snapshotPath, "attachments"),
      screenshotsRootDir: path.join(snapshotPath, "screenshots"),
      issueThreadsRootDir: path.join(snapshotPath, "issue-threads"),
      pipelineRunsRootDir: path.join(snapshotPath, "pipeline-runs"),
      sourceProfileRootSha256: manifest.origin?.sourceProfileRootSha256,
      sourceProfileRealSha256: manifest.origin?.sourceProfileRealSha256,
      sourceProfileAliasSha256s: manifest.origin?.sourceProfileAliasSha256s,
    });
    internalExpected = assets.entries?.length ?? 0;
    crossProfile = (assets.crossProfileReferences ?? []).map((entry) => entry.rawPath);
    external = (assets.unresolvedExternalReferences ?? []).map((entry) => entry.rawPath);
  } catch {
    // A preview that cannot scan references must not claim readiness.
    throw new Error("Could not inspect snapshot references");
  }
  const externalProjects = recovery.projects.filter((project) => project.requiresUserIntervention).length;
  const readiness: BackupActivationReadiness = legacy
    ? "legacy-unverified"
    : crossProfile.length > 0 || external.length > 0 || externalProjects > 0
      ? "requires-external-recovery"
      : "ready";
  const projects = recovery.projects.slice(0, MAX_PREVIEW_PROJECTS).map((project) => ({
    projectPath: project.projectPath,
    name: project.name ?? null,
    existsOnDisk: project.existsOnDisk,
    requiresUserIntervention: project.requiresUserIntervention,
    taskCount: project.taskCount ?? null,
  }));
  const worktrees = recovery.worktrees.slice(0, MAX_PREVIEW_WORKTREES).map((worktree) => ({
    taskId: worktree.taskId,
    taskTitle: worktree.taskTitle ?? null,
    worktreePath: worktree.worktreePath,
    existsOnDisk: worktree.existsOnDisk,
    status: worktree.status,
  }));
  const environmentProfiles = recovery.environmentProfiles
    .slice(0, MAX_PREVIEW_ENVIRONMENTS)
    .map((environment) => ({
      id: environment.id,
      projectPath: environment.projectPath,
      needsReconnection: environment.needsReconnection,
    }));
  const providerAuth = recovery.providerAuth.slice(0, MAX_PREVIEW_PROVIDERS).map((provider) => ({
    harnessId: provider.harnessId,
    harnessName: provider.harnessName,
    requiresAuthCheck: provider.requiresAuthCheck,
  }));
  return {
    projects,
    worktrees,
    environmentProfiles,
    providerAuth,
    totalProjects: recovery.totalProjects,
    totalClusters: recovery.totalClusters,
    totalTasks: recovery.totalTasks,
    externalProjectsRequiringAttention: recovery.totalExternalProjectsRequiringAttention,
    missingWorktrees: recovery.totalMissingWorktrees,
    internalReferencesExpected: internalExpected,
    // A successful verification (required before preview) proves every
    // manifest-backed internal reference exists. Legacy snapshots are never
    // automatically rebound, so their count stays unknown.
    internalReferencesUnresolved: legacy ? null : 0,
    unresolvedCrossProfileReferences: crossProfile.length,
    crossProfileDependencies: boundedList(crossProfile, MAX_PREVIEW_DEPENDENCIES),
    unresolvedExternalReferences: external.length,
    unresolvedExternalDependencies: boundedList(external, MAX_PREVIEW_DEPENDENCIES),
    readiness,
    readinessAdvisory: true,
    legacy,
    truncated:
      recovery.projects.length > projects.length ||
      recovery.worktrees.length > worktrees.length ||
      recovery.environmentProfiles.length > environmentProfiles.length ||
      recovery.providerAuth.length > providerAuth.length ||
      crossProfile.length > MAX_PREVIEW_DEPENDENCIES ||
      external.length > MAX_PREVIEW_DEPENDENCIES,
    brain: brainPreview(manifest.brain),
  };
}

function brainPreview(record: SnapshotBrainRecord | undefined): BackupRecoveryPreview["brain"] {
  const summary = summarizeBrainRecord(record);
  const scopes = record?.coverage === "included" ? record.projectScopes : [];
  const missingProjectPaths: string[] = [];
  let truncated = record?.coverage === "included" ? record.projectScopesTruncated === true : false;
  for (const scope of scopes) {
    if (!isRealDirectory(scope.scopeId)) {
      if (missingProjectPaths.length >= 8) {
        truncated = true;
        break;
      }
      missingProjectPaths.push(scope.scopeId);
    }
  }
  return {
    ...summary,
    missingProjectPaths,
    projectScopesTruncated: truncated,
  };
}

function isRealDirectory(candidate: string): boolean {
  if (!path.isAbsolute(candidate)) return false;
  try {
    if (!existsSync(candidate)) return false;
    const stat = lstatSync(candidate);
    return stat.isDirectory() && !stat.isSymbolicLink();
  } catch {
    return false;
  }
}

/**
 * Builds the bounded snapshot summary from the worker's verified manifest
 * summary. Used by the preview route so the summary and recovery preview
 * describe the same verified content (the main process never re-reads a
 * possibly-changed manifest after verification).
 */
export function summaryFromVerifiedSnapshot(input: {
  snapshotPath: string;
  manifestVersion: 1 | 2 | 3 | 4;
  snapshotId: string;
  appVersion: string | null;
  schemaVersion: string | null;
  createdAt: number;
  manifestVerified: boolean;
  coverage: "complete-profile" | "legacy-database-knowledge" | null;
  categories: string[] | undefined;
  stats: {
    fileCount: number;
    totalBytes: number;
    knowledgeDocumentCount: number;
    knowledgeRevisionCount: number;
    attachmentCount?: number;
    screenshotCount?: number;
    issueThreadCount?: number;
    pipelineRunCount?: number;
  };
  databaseBytes: number | null;
  databaseSha256: string | null;
  brain?: unknown;
}): BackupSnapshotSummary {
  const legacy = input.coverage !== "complete-profile";
  // The manifest and the shared UI summary use different category spellings
  // (singular `attachment`/`issue-thread` vs plural `attachments`/...).
  const categoryMap: Record<string, BackupSnapshotSummary["categories"][number]> = {
    database: "database",
    knowledge: "knowledge",
    attachment: "attachments",
    attachments: "attachments",
    screenshot: "screenshots",
    screenshots: "screenshots",
    "issue-thread": "issue-threads",
    "issue-threads": "issue-threads",
    "pipeline-run": "pipeline-runs",
    "pipeline-runs": "pipeline-runs",
    brain: "brain",
  };
  const categories: BackupSnapshotSummary["categories"] = [];
  for (const entry of input.categories ?? []) {
    const mapped = categoryMap[entry];
    if (mapped && !categories.includes(mapped)) categories.push(mapped);
  }
  if (!categories.includes("database")) categories.unshift("database");
  const counts: BackupSnapshotCounts = {
    knowledgeDocuments: input.stats.knowledgeDocumentCount,
    knowledgeRevisions: input.stats.knowledgeRevisionCount,
    attachments: input.stats.attachmentCount ?? 0,
    screenshots: input.stats.screenshotCount ?? 0,
    issueThreads: input.stats.issueThreadCount ?? 0,
    pipelineRuns: input.stats.pipelineRunCount ?? 0,
  };
  return {
    snapshotPath: input.snapshotPath,
    snapshotId: input.snapshotId,
    manifestVersion: input.manifestVersion,
    coverage: input.coverage,
    createdAt: input.createdAt,
    appVersion: input.appVersion,
    schemaVersion: input.schemaVersion,
    manifestVerified: input.manifestVerified,
    files: input.stats.fileCount,
    totalBytes: input.stats.totalBytes,
    databaseBytes: input.databaseBytes,
    databaseSha256: input.databaseSha256,
    categories,
    counts,
    brain: summarizeBrainRecord(input.brain),
    legacy,
    available: true,
    manifestError: null,
  };
}
