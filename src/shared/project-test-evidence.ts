/**
 * Read-only project-test evidence for the Owner's task review (FO-PERMISSIONS-04).
 * Pure: no database, no filesystem, no clock. The backend gathers the stored
 * permission requests and the task's *current* source binding and hands them here.
 *
 * Rules, in the order they matter:
 *  - This is evidence of one fixed test, shown next to QC. It never decides QC, Done,
 *    Owner acceptance or mission progress, and nothing here is written anywhere.
 *  - A pass is "current" only when the bytes it ran against are the bytes the task's
 *    workspace holds now. Anything else is "historical" (we can show it differs) or
 *    "unverified" (we cannot establish either way). Neither is proof for this revision.
 *  - A request that did not run (denied, cancelled, expired, blocked — including a sandbox
 *    that could not be applied) is "did not run", never "failed". "Did not run" is used only
 *    where the stored status itself establishes that no test process started.
 *  - An interrupted request is "interrupted — result unknown", never "did not run": its status is
 *    claimed before the process is spawned, so the row cannot say whether a test started.
 *  - The latest request decides the headline. An earlier pass is shown as earlier and
 *    can never hide a newer pending, running, blocked or failed attempt.
 */
import { effectiveStatus, type ProjectPermissionRequest } from "./project-permissions.ts";

export type ProjectTestKind =
  /** Ran and exited 0. */
  | "passed"
  /** Ran and did not pass (non-zero exit, timeout or output limit). */
  | "failed"
  /** No test started: denied, cancelled, expired, blocked, sandbox not applied. */
  | "did-not-run"
  /** Interrupted, or finished without an observed exit code: whether a test started, and what it found, is unknown. */
  | "interrupted"
  /** A newer attempt is waiting for the Owner. */
  | "pending"
  /** A newer attempt is running now. */
  | "running"
  /** No request has been made for this task. */
  | "not-run";

export type ProjectTestFreshness = "current" | "historical" | "unverified";

export type ProjectTestFreshnessReason =
  | "matches"
  | "source-changed"
  | "workspace-changed"
  | "workspace-in-progress"
  | "workspace-unavailable"
  | "source-unreadable";

/** What the task's workspace holds now. `null` when no workspace is bound to this task and project. */
export interface CurrentSourceBinding {
  projectPath: string;
  stagingPath: string;
  /** Workspace lifecycle status. */
  status: string;
  /** Fingerprint of the files now, or `null` when it could not be read (or was not read: the source is in flux). */
  sourceFingerprint: string | null;
}

export interface ProjectTestEvidenceEntry {
  requestId: string;
  kind: ProjectTestKind;
  status: string;
  command: string;
  exitCode: number | null;
  /** The core's own sentence about the outcome. */
  reason: string | null;
  authority: ProjectPermissionRequest["authority"];
  createdAt: number;
  /** When the result (or the decision that it would not run) was recorded. */
  decidedAt: number | null;
  finishedAt: number | null;
  /** Only for kinds that ran (`passed` / `failed`). `null` otherwise. */
  freshness: ProjectTestFreshness | null;
  freshnessReason: ProjectTestFreshnessReason | null;
}

export interface ProjectTestEvidence {
  taskId: string;
  projectPath: string | null;
  /** Kind of the latest request. This is the headline; it is never replaced by an earlier result. */
  kind: ProjectTestKind;
  /** The latest request of this task in this project, or `null` when none was made. */
  latest: ProjectTestEvidenceEntry | null;
  /** The most recent request that actually ran. Equals `latest` when the latest ran. */
  lastResult: ProjectTestEvidenceEntry | null;
  /** True only when a passing `lastResult` is current for the implementation under review. */
  currentPass: boolean;
}

/** Kind of one request from its effective status and exit code. Unknown statuses never read as a pass. */
export function projectTestKind(status: string, exitCode: number | null): ProjectTestKind {
  switch (status) {
    case "completed":
      // A pass needs an observed exit 0. A "completed" row without one is never read as a pass,
      // and is not evidence that nothing ran either.
      return exitCode === 0 ? "passed" : exitCode == null ? "interrupted" : "failed";
    case "failed":
      // A failure needs an observed exit code. Without one (timeout, output limit, no exit) the
      // result is unknown, not a recorded failing test.
      return exitCode == null ? "interrupted" : "failed";
    case "interrupted":
      return "interrupted";
    case "pending":
      return "pending";
    case "running":
      return "running";
    default:
      // denied, cancelled, expired, blocked and anything unknown: no result exists.
      return "did-not-run";
  }
}

export function projectTestFreshness(
  request: Pick<ProjectPermissionRequest, "projectPath" | "cwd" | "sourceFingerprint">,
  current: CurrentSourceBinding | null,
): { freshness: ProjectTestFreshness; reason: ProjectTestFreshnessReason } {
  if (!current) return { freshness: "unverified", reason: "workspace-unavailable" };
  if (current.projectPath !== request.projectPath) return { freshness: "unverified", reason: "workspace-unavailable" };
  if (current.status === "abandoned") return { freshness: "unverified", reason: "workspace-unavailable" };
  // A different staging directory means a newer workspace replaced the one that was tested.
  if (current.stagingPath !== request.cwd) return { freshness: "historical", reason: "workspace-changed" };
  if (current.status === "armed" || current.status === "executing") return { freshness: "historical", reason: "workspace-in-progress" };
  if (current.sourceFingerprint == null) return { freshness: "unverified", reason: "source-unreadable" };
  if (current.sourceFingerprint !== request.sourceFingerprint) return { freshness: "historical", reason: "source-changed" };
  return { freshness: "current", reason: "matches" };
}

function entryOf(request: ProjectPermissionRequest, now: number, current: CurrentSourceBinding | null): ProjectTestEvidenceEntry {
  const status = effectiveStatus(request, now);
  const kind = projectTestKind(status, request.exitCode);
  const ran = kind === "passed" || kind === "failed";
  const judged = ran ? projectTestFreshness(request, current) : null;
  return {
    requestId: request.id,
    kind,
    status,
    command: request.command,
    exitCode: request.exitCode,
    reason: request.reason,
    authority: request.authority,
    createdAt: request.createdAt,
    decidedAt: request.decidedAt,
    finishedAt: request.finishedAt,
    freshness: judged?.freshness ?? null,
    freshnessReason: judged?.reason ?? null,
  };
}

/**
 * `requests` must already be restricted to this task and this project (newest first is
 * not assumed: they are ordered here). Another task's or project's rows are the caller's
 * bug, so they are also dropped here as a second line of defence.
 */
export function buildProjectTestEvidence(input: {
  taskId: string;
  projectPath: string | null;
  requests: readonly ProjectPermissionRequest[];
  current: CurrentSourceBinding | null;
  now: number;
}): ProjectTestEvidence {
  const own = input.requests
    .filter((request) => request.taskId === input.taskId && input.projectPath != null && request.projectPath === input.projectPath)
    .slice()
    .sort((a, b) => b.createdAt - a.createdAt);
  if (own.length === 0) {
    return { taskId: input.taskId, projectPath: input.projectPath, kind: "not-run", latest: null, lastResult: null, currentPass: false };
  }
  const entries = own.map((request) => entryOf(request, input.now, input.current));
  const latest = entries[0]!;
  const lastResult = entries.find((entry) => entry.kind === "passed" || entry.kind === "failed") ?? null;
  return {
    taskId: input.taskId,
    projectPath: input.projectPath,
    kind: latest.kind,
    latest,
    lastResult,
    // A pass counts as current only when nothing newer has happened since it.
    currentPass: lastResult != null && lastResult === latest && lastResult.kind === "passed" && lastResult.freshness === "current",
  };
}
