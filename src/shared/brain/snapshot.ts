/**
 * Brain category inside a profile snapshot (FO-BRAIN02-A).
 *
 * Manifest v4 stays the complete-profile format. `brain` is an added record.
 * A snapshot written before this record is legacy-absent: it has no Brain
 * files, and restoring it does not invent memories or delete another profile.
 */

import { isBrainMemoryId } from "./document.ts";

export const BRAIN_SNAPSHOT_INDEX = "brain/index.sqlite";
export const BRAIN_PROJECT_SCOPE_CAP = 20;

export type BrainSnapshotCoverage = "included" | "absent" | "legacy-absent" | "invalid";

export interface BrainSnapshotProjectScope {
  scopeId: string;
  count: number;
  /** True when the snapshotted projects table still names this path. */
  registered: boolean;
}

/**
 * Written on new manifest v4 snapshots. Absent means the profile had no Brain
 * store. Included means the index and the committed Markdown were packaged
 * together. Pending rows are not packaged.
 */
export interface SnapshotBrainRecord {
  coverage: "included" | "absent";
  schemaVersion: number;
  memoryCount: number;
  archivedCount: number;
  revisionCount: number;
  pendingExcluded: number;
  unindexedExcluded: number;
  orphanedProjectCount: number;
  projectScopesTruncated: boolean;
  projectScopes: BrainSnapshotProjectScope[];
}

export interface BrainSnapshotCoverageSummary {
  coverage: BrainSnapshotCoverage;
  memoryCount: number | null;
  archivedCount: number | null;
  revisionCount: number | null;
  pendingExcluded: number | null;
  orphanedProjectCount: number | null;
}

export interface BackupBrainPreview extends BrainSnapshotCoverageSummary {
  /** Project scope paths that are not a real directory on this computer. */
  missingProjectPaths: string[];
  projectScopesTruncated: boolean;
}

const MEMORY_FILE = /^brain\/memories\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.md$/;
const REVISION_FILE = /^brain\/revisions\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\/([1-9][0-9]*)\.md$/;

export function parseBrainSnapshotPath(
  filePath: string,
): { ok: true; normalizedPath: string } | { ok: false } {
  const normalized = filePath.replaceAll("\\", "/");
  if (normalized === BRAIN_SNAPSHOT_INDEX) return { ok: true, normalizedPath: normalized };
  const memory = MEMORY_FILE.exec(normalized);
  if (memory && isBrainMemoryId(memory[1]!)) return { ok: true, normalizedPath: normalized };
  const revision = REVISION_FILE.exec(normalized);
  if (!revision || !isBrainMemoryId(revision[1]!)) return { ok: false };
  const revisionNumber = Number(revision[2]);
  if (!Number.isSafeInteger(revisionNumber) || revisionNumber < 1) return { ok: false };
  return { ok: true, normalizedPath: normalized };
}

export function emptyBrainCoverage(coverage: BrainSnapshotCoverage): BrainSnapshotCoverageSummary {
  return {
    coverage,
    memoryCount: coverage === "absent" ? 0 : null,
    archivedCount: coverage === "absent" ? 0 : null,
    revisionCount: coverage === "absent" ? 0 : null,
    pendingExcluded: coverage === "absent" ? 0 : null,
    orphanedProjectCount: coverage === "absent" ? 0 : null,
  };
}

function count(value: unknown): number | null {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : null;
}

/** Turns a manifest `brain` value into the coverage the UI is allowed to show. */
export function summarizeBrainRecord(value: unknown): BrainSnapshotCoverageSummary {
  if (value === undefined || value === null) return emptyBrainCoverage("legacy-absent");
  if (typeof value !== "object") return emptyBrainCoverage("invalid");
  const record = value as Partial<SnapshotBrainRecord>;
  if (record.coverage === "absent") return emptyBrainCoverage("absent");
  if (record.coverage !== "included") return emptyBrainCoverage("invalid");
  const memoryCount = count(record.memoryCount);
  const archivedCount = count(record.archivedCount);
  const revisionCount = count(record.revisionCount);
  const pendingExcluded = count(record.pendingExcluded);
  const orphanedProjectCount = count(record.orphanedProjectCount);
  if (
    memoryCount === null ||
    archivedCount === null ||
    revisionCount === null ||
    pendingExcluded === null ||
    orphanedProjectCount === null ||
    record.schemaVersion !== 1
  ) {
    return emptyBrainCoverage("invalid");
  }
  return {
    coverage: "included",
    memoryCount,
    archivedCount,
    revisionCount,
    pendingExcluded,
    orphanedProjectCount,
  };
}
