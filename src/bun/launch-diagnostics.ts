import { accessSync, constants, existsSync } from "node:fs";
import { spawnSync } from "node:child_process";
import type { Harness, Task } from "../shared/types.ts";
import { defaultModeFor } from "../shared/types.ts";
import {
  assessAccessDiagnostics,
  type AccessDiagnostics,
  type SeatbeltAvailability,
} from "../shared/execution/access-mode.ts";
import { harnesses } from "./db.ts";
import { detectWorkspaceLayout, detectWorkspaceLayoutNow, type DetectedLayout } from "./execution-layout.ts";
import { stagingCwdForTask } from "./task-workspace.ts";
import { currentReadScope } from "./codex-read-scope.ts";
import { agentDriverIsFake } from "./agents.ts";
import { ownerProjectOf } from "./project-ownership.ts";
import { isWorkspaceDevelopmentEnabled } from "./project-permissions.ts";

let seatbeltProbeOverride: (() => SeatbeltAvailability) | null = null;

export function useSeatbeltProbeForTests(probe: (() => SeatbeltAvailability) | null): void {
  seatbeltProbeOverride = probe;
}

/**
 * Checks whether macOS `/usr/bin/sandbox-exec` can actually apply a Seatbelt profile
 * from this process. Inside an enclosing sandbox, nested `sandbox-exec` fails with
 * exit 71 / Operation not permitted and is reported honestly as `nested-blocked`.
 */
export function probeSeatbeltCapability(): SeatbeltAvailability {
  if (seatbeltProbeOverride) return seatbeltProbeOverride();
  if (process.platform !== "darwin") return "unavailable";
  try {
    accessSync("/usr/bin/sandbox-exec", constants.X_OK);
  } catch {
    return "unavailable";
  }
  const probe = spawnSync(
    "/usr/bin/sandbox-exec",
    ["-p", "(version 1)(allow default)", "/usr/bin/true"],
    { encoding: "utf8", timeout: 3000 },
  );
  if (probe.status === 0) return "available";
  const detail = `${probe.stderr ?? ""}\n${probe.stdout ?? ""}`;
  if (probe.status === 71 || /Operation not permitted|sandbox_apply/i.test(detail)) {
    return "nested-blocked";
  }
  return "unavailable";
}

function readScopeSafe(): "broad" | "restricted" {
  try {
    return currentReadScope();
  } catch {
    return "broad";
  }
}

function resolveHarnessSafe(harnessId: string | null | undefined): Harness | undefined {
  if (!harnessId?.trim()) return undefined;
  return harnesses.getByIdOrKind(harnessId) ?? undefined;
}

export async function diagnoseTaskLaunch(
  task: Pick<Task, "id" | "agent" | "mode" | "isolation" | "workdir" | "worktreePath" | "branch" | "pipelineId" | "accessMode">,
  opts?: {
    harnessId?: string;
    mode?: string | null;
    seatbeltStatus?: SeatbeltAvailability;
    cursorSeatbeltActive?: boolean;
    driverIsFake?: boolean;
    ignoreStagingRequirement?: boolean;
    isReviewer?: boolean;
  },
): Promise<AccessDiagnostics> {
  const accessMode = task.accessMode ?? "workspace";
  const harnessId = opts?.harnessId ?? task.agent;
  const harness = resolveHarnessSafe(harnessId);
  const kind = harness?.kind ?? "";
  const effectiveMode = opts?.mode ?? task.mode ?? (harness ? defaultModeFor(harness.kind) : "");
  const staging = opts?.ignoreStagingRequirement ? { cwd: null, block: null } : stagingCwdForTask(task.id);
  const stagedCwd = staging.cwd;
  const ownerProject = !opts?.isReviewer && !task.pipelineId && !task.worktreePath
    ? ownerProjectOf(task.workdir, { fresh: true })
    : null;
  const workingCopyDevelopment = Boolean(
    ownerProject && accessMode === "workspace" && isWorkspaceDevelopmentEnabled(ownerProject),
  );
  const subject = stagedCwd
    ? { isolation: "none" as const, workdir: stagedCwd, worktreePath: null }
    : { isolation: task.isolation, workdir: task.workdir, worktreePath: task.worktreePath };
  const layout = !stagedCwd && workingCopyDevelopment
    ? { layout: "non-git" as const, predicted: true }
    : await detectWorkspaceLayout(subject);
  const effectiveReadScope = accessMode === "isolated" && kind === "codex"
    ? "restricted"
    : readScopeSafe();
  const driverIsFake = opts?.driverIsFake ?? (harness ? agentDriverIsFake(harness.kind) : false);
  const seatbeltStatus = opts?.seatbeltStatus
    ?? (accessMode === "isolated" || (workingCopyDevelopment && !driverIsFake) ? probeSeatbeltCapability() : "unchecked");

  const diagnostics = assessAccessDiagnostics({
    requestedAccessMode: task.accessMode ?? "workspace",
    kind,
    harnessId,
    mode: effectiveMode,
    isolation: task.isolation,
    workdir: task.workdir,
    worktreePath: task.worktreePath,
    branch: task.branch,
    stagedCwd: opts?.ignoreStagingRequirement ? task.workdir : stagedCwd,
    layout: layout.layout,
    predicted: layout.predicted,
    readScope: effectiveReadScope,
    seatbeltStatus,
    cursorSeatbeltActive: opts?.cursorSeatbeltActive,
    isPipeline: Boolean(task.pipelineId),
    driverIsFake,
    workingCopyDevelopment,
  });

  if (staging.block && !stagedCwd && accessMode !== "full-computer") {
    return {
      ...diagnostics,
      launchAllowed: false,
      blockReason: staging.block,
    };
  }
  return diagnostics;
}

export function diagnoseTaskLaunchNow(
  task: Pick<Task, "id" | "agent" | "mode" | "isolation" | "workdir" | "worktreePath" | "branch" | "pipelineId" | "accessMode">,
  opts?: {
    harnessId?: string;
    mode?: string | null;
    seatbeltStatus?: SeatbeltAvailability;
    cursorSeatbeltActive?: boolean;
    driverIsFake?: boolean;
    ignoreStagingRequirement?: boolean;
    isReviewer?: boolean;
    detectLayout?: (subject: Pick<Task, "isolation" | "workdir" | "worktreePath">) => DetectedLayout;
  },
): AccessDiagnostics {
  const accessMode = task.accessMode ?? "workspace";
  const harnessId = opts?.harnessId ?? task.agent;
  const harness = resolveHarnessSafe(harnessId);
  const kind = harness?.kind ?? "";
  const effectiveMode = opts?.mode ?? task.mode ?? (harness ? defaultModeFor(harness.kind) : "");
  const staging = opts?.ignoreStagingRequirement ? { cwd: null, block: null } : stagingCwdForTask(task.id);
  const stagedCwd = staging.cwd;
  const ownerProject = !opts?.isReviewer && !task.pipelineId && !task.worktreePath
    ? ownerProjectOf(task.workdir, { fresh: true })
    : null;
  const workingCopyDevelopment = Boolean(
    ownerProject && accessMode === "workspace" && isWorkspaceDevelopmentEnabled(ownerProject),
  );
  const subject = stagedCwd
    ? { isolation: "none" as const, workdir: stagedCwd, worktreePath: null }
    : { isolation: task.isolation, workdir: task.workdir, worktreePath: task.worktreePath };
  const layout = !stagedCwd && workingCopyDevelopment
    ? { layout: "non-git" as const, predicted: true }
    : (opts?.detectLayout ?? detectWorkspaceLayoutNow)(subject);
  const effectiveReadScope = accessMode === "isolated" && kind === "codex"
    ? "restricted"
    : readScopeSafe();
  const driverIsFake = opts?.driverIsFake ?? (harness ? agentDriverIsFake(harness.kind) : false);
  const seatbeltStatus = opts?.seatbeltStatus
    ?? (accessMode === "isolated" || (workingCopyDevelopment && !driverIsFake) ? probeSeatbeltCapability() : "unchecked");

  const diagnostics = assessAccessDiagnostics({
    requestedAccessMode: task.accessMode ?? "workspace",
    kind,
    harnessId,
    mode: effectiveMode,
    isolation: task.isolation,
    workdir: task.workdir,
    worktreePath: task.worktreePath,
    branch: task.branch,
    stagedCwd: opts?.ignoreStagingRequirement ? task.workdir : stagedCwd,
    layout: layout.layout,
    predicted: layout.predicted,
    readScope: effectiveReadScope,
    seatbeltStatus,
    cursorSeatbeltActive: opts?.cursorSeatbeltActive,
    isPipeline: Boolean(task.pipelineId),
    driverIsFake,
    workingCopyDevelopment,
  });

  if (staging.block && !stagedCwd && accessMode !== "full-computer") {
    return {
      ...diagnostics,
      launchAllowed: false,
      blockReason: staging.block,
    };
  }
  return diagnostics;
}

export async function diagnoseDraftLaunch(input: {
  accessMode?: unknown;
  harnessId?: string;
  mode?: string | null;
  isolation?: unknown;
  workdir?: string;
  branch?: string | null;
  isPipeline?: boolean;
  seatbeltStatus?: SeatbeltAvailability;
  cursorSeatbeltActive?: boolean;
}): Promise<AccessDiagnostics> {
  const harness = resolveHarnessSafe(input.harnessId);
  const kind = harness?.kind ?? "";
  const effectiveMode = input.mode ?? (harness ? defaultModeFor(harness.kind) : "");
  const isolation = input.isolation === "none" ? "none" as const : "worktree" as const;
  const workdir = typeof input.workdir === "string" ? input.workdir.trim() : "";
  const requested = input.accessMode === undefined || input.accessMode === null ? "workspace" : input.accessMode;
  const ownerProject = workdir && !input.isPipeline ? ownerProjectOf(workdir, { fresh: true }) : null;
  const workingCopyDevelopment = Boolean(
    ownerProject && requested === "workspace" && isWorkspaceDevelopmentEnabled(ownerProject),
  );
  const layout = workingCopyDevelopment
    ? { layout: "non-git" as const, predicted: true }
    : workdir && existsSync(workdir)
      ? await detectWorkspaceLayout({ isolation, workdir, worktreePath: null })
      : { layout: "unknown" as const, predicted: true };
  const effectiveReadScope = requested === "isolated" && kind === "codex"
    ? "restricted"
    : readScopeSafe();
  const driverIsFake = harness ? agentDriverIsFake(harness.kind) : false;
  const seatbeltStatus = input.seatbeltStatus
    ?? (requested === "isolated" || (workingCopyDevelopment && !driverIsFake) ? probeSeatbeltCapability() : "unchecked");

  return assessAccessDiagnostics({
    requestedAccessMode: requested,
    kind,
    harnessId: input.harnessId ?? kind,
    mode: effectiveMode,
    isolation,
    workdir,
    worktreePath: null,
    branch: input.branch ?? null,
    stagedCwd: null,
    layout: layout.layout,
    predicted: layout.predicted,
    readScope: effectiveReadScope,
    seatbeltStatus,
    cursorSeatbeltActive: input.cursorSeatbeltActive,
    isPipeline: input.isPipeline === true,
    driverIsFake,
    workingCopyDevelopment,
  });
}
