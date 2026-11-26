import {
  describePermissions,
  layoutNeedsExternalGit,
  type PermissionDisclosure,
  type WorkspaceLayout,
} from "./permissions.ts";

export const ACCESS_MODES = ["workspace", "isolated", "full-computer"] as const;
export type AccessMode = (typeof ACCESS_MODES)[number];

export type SeatbeltAvailability = "available" | "nested-blocked" | "unavailable" | "unchecked";

export type WorkspaceEnvironmentKind =
  | "project-folder"
  | "git-worktree"
  | "predicted-worktree"
  | "task-staging"
  | "none";

export interface AccessDiagnostics {
  accessMode: AccessMode;
  requestedAccessModeValid: boolean;
  harnessId: string;
  harnessKind: string;
  harnessMode: string;
  effectiveWorkspace: {
    kind: WorkspaceEnvironmentKind;
    path: string | null;
    branch: string | null;
    predicted: boolean;
  };
  osEnforcement: {
    mechanism: "macos-seatbelt-restricted" | "macos-seatbelt" | "none";
    filesystemReads: "restricted-workspace" | "broad-same-uid" | "none";
    filesystemWrites: "workspace-only" | "read-only" | "unrestricted-same-uid";
    network: "sandbox-disabled" | "unrestricted";
    summaryCodes: string[];
  };
  appEnforcementCodes: string[];
  unverifiedCodes: string[];
  computerUse: {
    grantedByMode: false;
    browserSeparate: true;
    nativeSeparate: true;
    sensitiveTargetsBlocked: true;
    activeNoteCode: "cu-separate-note" | "cu-full-computer-grant-note";
  };
  launchAllowed: boolean;
  blockCodes: string[];
  blockReason: string | null;
  driverIsFake: boolean;
  /** True when the project's "Development in a working copy" setting applies to this launch. */
  workingCopyDevelopment?: boolean;
}

export interface AssessAccessDiagnosticsInput {
  requestedAccessMode?: unknown;
  kind: string;
  harnessId?: string;
  mode: string;
  isolation: "worktree" | "none";
  workdir: string;
  worktreePath?: string | null;
  branch?: string | null;
  stagedCwd?: string | null;
  layout: WorkspaceLayout;
  predicted?: boolean;
  readScope?: "broad" | "restricted";
  seatbeltStatus?: SeatbeltAvailability;
  cursorSeatbeltActive?: boolean;
  isPipeline?: boolean;
  driverIsFake?: boolean;
  permission?: PermissionDisclosure | null;
  /** Project-scoped "Development in a working copy" opt-in (Developer launches only; never Reviewer). */
  workingCopyDevelopment?: boolean;
}

const KNOWN_HARNESS_KINDS = new Set([
  "codex",
  "claude-code",
  "cursor",
  "gemini",
  "antigravity",
  "fx",
]);

export function normalizeAccessMode(value: unknown): AccessMode | null {
  if (typeof value !== "string") return null;
  return (ACCESS_MODES as readonly string[]).includes(value) ? (value as AccessMode) : null;
}

function isReadOnlyAppMode(kind: string, mode: string): boolean {
  if (kind === "claude-code") return mode === "plan" || mode === "bounded-print";
  if (kind === "gemini") return mode === "ask" || mode === "plan";
  if (kind === "antigravity") return mode === "plan";
  if (kind === "cursor") return mode === "ask";
  return false;
}

function blockMessageFor(code: string, harnessKind: string, mode: string, fallbackReason?: string | null): string {
  switch (code) {
    case "block-invalid-access-mode":
      return "Unknown access mode. Select Workspace, Isolated, or Full Computer explicitly.";
    case "block-isolated-pipeline":
      return "Isolated mode is not supported for multi-step pipelines; pipeline steps share a workspace without staged-only OS confinement.";
    case "block-full-computer-pipeline":
      return "Full Computer mode cannot run multi-step pipelines; external capabilities require separate per-action Owner grants.";
    case "block-full-computer-no-process-grant":
      return "Full Computer allows separate per-action Owner grants for a selected application, window, or browser origin. Selecting Full Computer grants nothing to process launches and never falls back to Workspace or unrestricted access.";
    case "block-isolated-unsupported-harness":
      return `Isolated mode requires OS-enforced workspace and no-network confinement. ${harnessKind || "This harness"} runs without a ForgeOrbit OS sandbox; launch refused with no fallback.`;
    case "block-isolated-full-access":
      return "Isolated mode cannot run in Codex Full access because it disables OS sandboxing and permits network access.";
    case "block-isolated-seatbelt-nested":
      return "OS Seatbelt isolation is blocked by an enclosing sandbox (nested sandbox-exec cannot apply); launch refused with no fallback.";
    case "block-isolated-seatbelt-unavailable":
      return "macOS Seatbelt isolation is unavailable on this host; Isolated mode refuses to launch without fallback.";
    case "block-isolated-requires-staging":
      return "Isolated mode requires a prepared Task Workspace with explicitly supplied inputs and no automatic write-back. Create the task, prepare Task Workspace inputs, then start.";
    case "block-isolated-worktree-conflict":
      return "Isolated mode operates in a disposable staging environment rather than a project Git worktree.";
    case "block-unknown-harness":
      return "Unknown harness. Pick an enabled registered harness before launching.";
    case "block-codex-external-git":
    case "block-unknown-layout":
    case "block-unknown-codex-mode":
      return fallbackReason ?? `Launch blocked for Codex mode "${mode}".`;
    case "block-working-copy-unsupported-harness":
      return `Development in a working copy requires an OS-enforced working-copy and offline-command sandbox (currently supported on Codex Auto). ${harnessKind || "This harness"} cannot enforce that boundary for child processes; launch blocked without weakening permissions.`;
    case "block-working-copy-full-access":
      return "Development in a working copy cannot run in Codex Full access because it disables OS sandboxing and permits network access for project commands.";
    case "block-working-copy-seatbelt-nested":
      return "macOS Seatbelt isolation is blocked by an enclosing sandbox (nested sandbox-exec cannot apply); working-copy launch refused without fallback.";
    case "block-working-copy-seatbelt-unavailable":
      return "macOS Seatbelt isolation is unavailable on this host; working-copy development refuses to launch without OS write confinement.";
    default:
      return fallbackReason ?? "Launch blocked by access-mode policy.";
  }
}

/**
 * Pure launch permission and enforcement classifier across Workspace, Isolated, and Full Computer.
 * Reuses Codex `describePermissions` without changing Codex's existing disclosure contract, and adds
 * honest OS vs application vs unverified reporting for every supported harness and workspace target.
 */
export function assessAccessDiagnostics(input: AssessAccessDiagnosticsInput): AccessDiagnostics {
  const rawMode = input.requestedAccessMode;
  const parsedMode = rawMode === undefined || rawMode === null ? "workspace" : normalizeAccessMode(rawMode);
  const requestedAccessModeValid = parsedMode !== null;
  const accessMode: AccessMode = parsedMode ?? "workspace";
  const harnessId = input.harnessId ?? input.kind;
  const kind = input.kind;
  const mode = input.mode;
  const driverIsFake = input.driverIsFake === true;
  const stagedPath = input.stagedCwd?.trim() || null;

  const blockCodes: string[] = [];
  const blockMessages: string[] = [];
  const addBlock = (code: string, customMessage?: string | null) => {
    if (!blockCodes.includes(code)) blockCodes.push(code);
    const msg = blockMessageFor(code, kind, mode, customMessage);
    if (!blockMessages.includes(msg)) blockMessages.push(msg);
  };

  if (!requestedAccessModeValid) {
    addBlock("block-invalid-access-mode");
  }

  const workspaceAppCodes: string[] = [];
  if (stagedPath) {
    workspaceAppCodes.push("app-task-staging");
  } else if (input.isolation === "worktree" && accessMode === "workspace" && !(input.workingCopyDevelopment === true && !input.isPipeline && !input.worktreePath)) {
    workspaceAppCodes.push("app-git-worktree");
  }

  const computerUse = {
    grantedByMode: false as const,
    browserSeparate: true as const,
    nativeSeparate: true as const,
    sensitiveTargetsBlocked: true as const,
    activeNoteCode: accessMode === "full-computer"
      ? ("cu-full-computer-grant-note" as const)
      : ("cu-separate-note" as const),
  };

  if (input.isPipeline && accessMode === "isolated") {
    addBlock("block-isolated-pipeline");
  }
  if (input.isPipeline && accessMode === "full-computer") {
    addBlock("block-full-computer-pipeline");
  }

  if (accessMode === "full-computer") {
    addBlock("block-full-computer-no-process-grant");
    const unverifiedCodes = driverIsFake ? ["gap-fake-driver-no-os-proof"] : [];
    return {
      accessMode,
      requestedAccessModeValid,
      harnessId,
      harnessKind: kind,
      harnessMode: mode,
      effectiveWorkspace: { kind: "none", path: null, branch: null, predicted: false },
      osEnforcement: {
        mechanism: "none",
        filesystemReads: "none",
        filesystemWrites: "read-only",
        network: "sandbox-disabled",
        summaryCodes: ["os-none-no-process"],
      },
      appEnforcementCodes: ["app-cu-grants-separate", "app-mode-grants-nothing"],
      unverifiedCodes,
      computerUse,
      launchAllowed: false,
      blockCodes,
      blockReason: blockMessages[0] ?? null,
      driverIsFake,
    };
  }

  if (accessMode === "isolated") {
    const seatbeltStatus = input.seatbeltStatus ?? "unchecked";
    if (input.isolation === "worktree") {
      addBlock("block-isolated-worktree-conflict");
    }
    if (!stagedPath) {
      addBlock("block-isolated-requires-staging");
    }

    if (kind === "codex") {
      if (mode === "full-access") {
        addBlock("block-isolated-full-access");
      } else if (mode !== "auto" && mode !== "ask") {
        addBlock("block-unknown-codex-mode", "Unknown Codex permission mode. Choose Ask or Auto explicitly.");
      }
      if (seatbeltStatus === "nested-blocked") {
        addBlock("block-isolated-seatbelt-nested");
      } else if (seatbeltStatus === "unavailable") {
        addBlock("block-isolated-seatbelt-unavailable");
      }
      const layoutForCodex = stagedPath ? input.layout : "non-git";
      const permission = input.permission ?? describePermissions({
        kind: "codex",
        mode: mode === "ask" || mode === "auto" ? mode : "ask",
        layout: layoutForCodex,
        predicted: false,
        readScope: "restricted",
      });
      if (permission && !permission.launchAllowed) {
        if (permission.layout === "unknown") addBlock("block-unknown-layout", permission.blockReason);
        else if (layoutNeedsExternalGit(permission.layout) && mode === "auto") addBlock("block-codex-external-git", permission.blockReason);
        else addBlock("block-unknown-codex-mode", permission.blockReason);
      }

      const canSeatbeltHold = (mode === "auto" || mode === "ask")
        && seatbeltStatus !== "nested-blocked"
        && seatbeltStatus !== "unavailable";

      const unverifiedCodes: string[] = [];
      if (canSeatbeltHold) {
        unverifiedCodes.push("gap-provider-traffic-separate", "gap-hardlink-fd-caveat", "gap-same-uid-secrets");
      } else {
        unverifiedCodes.push("gap-no-os-sandbox");
        if (mode === "full-access") unverifiedCodes.push("gap-network-unrestricted", "gap-same-uid-secrets");
      }
      if (driverIsFake) unverifiedCodes.push("gap-fake-driver-no-os-proof");

      return {
        accessMode,
        requestedAccessModeValid,
        harnessId,
        harnessKind: kind,
        harnessMode: mode,
        effectiveWorkspace: stagedPath
          ? { kind: "task-staging", path: stagedPath, branch: null, predicted: false }
          : { kind: "none", path: null, branch: null, predicted: false },
        osEnforcement: canSeatbeltHold
          ? {
              mechanism: "macos-seatbelt-restricted",
              filesystemReads: "restricted-workspace",
              filesystemWrites: mode === "ask" ? "read-only" : "workspace-only",
              network: "sandbox-disabled",
              summaryCodes: ["os-seatbelt-restricted"],
            }
          : {
              mechanism: "none",
              filesystemReads: "broad-same-uid",
              filesystemWrites: "unrestricted-same-uid",
              network: mode === "full-access" ? "unrestricted" : "sandbox-disabled",
              summaryCodes: ["os-none"],
            },
        appEnforcementCodes: ["app-task-staging", "app-cu-grants-separate", "app-mode-grants-nothing"],
        unverifiedCodes,
        computerUse,
        launchAllowed: blockCodes.length === 0,
        blockCodes,
        blockReason: blockMessages[0] ?? null,
        driverIsFake,
      };
    }

    if (!KNOWN_HARNESS_KINDS.has(kind)) {
      addBlock("block-unknown-harness");
    } else {
      addBlock("block-isolated-unsupported-harness");
    }

    const unverifiedCodes = ["gap-no-os-sandbox", "gap-network-unrestricted", "gap-same-uid-secrets"];
    if (driverIsFake) unverifiedCodes.push("gap-fake-driver-no-os-proof");

    return {
      accessMode,
      requestedAccessModeValid,
      harnessId,
      harnessKind: kind,
      harnessMode: mode,
      effectiveWorkspace: stagedPath
        ? { kind: "task-staging", path: stagedPath, branch: null, predicted: false }
        : { kind: "none", path: null, branch: null, predicted: false },
      osEnforcement: {
        mechanism: "none",
        filesystemReads: "broad-same-uid",
        filesystemWrites: "unrestricted-same-uid",
        network: "unrestricted",
        summaryCodes: ["os-none"],
      },
      appEnforcementCodes: ["app-task-staging", "app-cu-grants-separate", "app-mode-grants-nothing"],
      unverifiedCodes,
      computerUse,
      launchAllowed: false,
      blockCodes,
      blockReason: blockMessages[0] ?? null,
      driverIsFake,
    };
  }

  // accessMode === "workspace"
  const workingCopyDev = input.workingCopyDevelopment === true && !input.isPipeline;
  const effectiveWorkspace = stagedPath
    ? { kind: "task-staging" as const, path: stagedPath, branch: null, predicted: false }
    : workingCopyDev && !input.worktreePath
      ? { kind: "task-staging" as const, path: input.workdir, branch: null, predicted: true }
      : input.isolation === "worktree"
        ? input.worktreePath
          ? { kind: "git-worktree" as const, path: input.worktreePath, branch: input.branch ?? null, predicted: false }
          : { kind: "predicted-worktree" as const, path: input.workdir, branch: input.branch ?? null, predicted: true }
        : { kind: "project-folder" as const, path: input.workdir, branch: input.branch ?? null, predicted: false };

  if (workingCopyDev && !workspaceAppCodes.includes("app-working-copy")) {
    workspaceAppCodes.push("app-working-copy");
  }

  if (kind === "codex") {
    const readScope = input.readScope ?? "broad";
    const effectiveLayout: WorkspaceLayout = workingCopyDev && !input.worktreePath ? "non-git" : input.layout;
    if (workingCopyDev) {
      const seatbeltStatus = input.seatbeltStatus ?? "unchecked";
      if (mode === "full-access") {
        addBlock("block-working-copy-full-access");
      } else if (seatbeltStatus === "nested-blocked") {
        addBlock("block-working-copy-seatbelt-nested");
      } else if (seatbeltStatus === "unavailable") {
        addBlock("block-working-copy-seatbelt-unavailable");
      }
    }
    const permission = input.permission ?? describePermissions({
      kind: "codex",
      mode,
      layout: effectiveLayout,
      predicted: workingCopyDev && !stagedPath ? true : input.predicted,
      readScope,
      workingCopy: workingCopyDev,
    })!;
    if (!permission.launchAllowed) {
      if (workingCopyDev && mode === "full-access") {
        addBlock("block-working-copy-full-access", permission.blockReason);
      } else if (permission.layout === "unknown") addBlock("block-unknown-layout", permission.blockReason);
      else if (layoutNeedsExternalGit(permission.layout) && mode === "auto") addBlock("block-codex-external-git", permission.blockReason);
      else addBlock("block-unknown-codex-mode", permission.blockReason);
    }

    const unverifiedCodes: string[] = [];
    if (permission.sandbox === "danger-full-access") {
      unverifiedCodes.push("gap-no-os-sandbox", "gap-network-unrestricted", "gap-same-uid-secrets");
    } else {
      if (permission.readScope !== "restricted") unverifiedCodes.push("gap-broad-reads");
      unverifiedCodes.push("gap-provider-traffic-separate", "gap-hardlink-fd-caveat", "gap-same-uid-secrets");
    }
    if (input.isPipeline) unverifiedCodes.push("gap-pipeline-unbounded");
    if (driverIsFake) unverifiedCodes.push("gap-fake-driver-no-os-proof");

    const restricted = permission.readScope === "restricted" && permission.sandbox !== "danger-full-access";
    return {
      accessMode,
      requestedAccessModeValid,
      harnessId,
      harnessKind: kind,
      harnessMode: mode,
      effectiveWorkspace,
      osEnforcement: permission.sandbox === "danger-full-access"
        ? {
            mechanism: "none",
            filesystemReads: "broad-same-uid",
            filesystemWrites: "unrestricted-same-uid",
            network: "unrestricted",
            summaryCodes: ["os-none"],
          }
        : {
            mechanism: restricted ? "macos-seatbelt-restricted" : "macos-seatbelt",
            filesystemReads: restricted ? "restricted-workspace" : "broad-same-uid",
            filesystemWrites: permission.sandbox === "read-only" ? "read-only" : "workspace-only",
            network: "sandbox-disabled",
            summaryCodes: [restricted ? "os-seatbelt-restricted" : "os-seatbelt-write-only"],
          },
      appEnforcementCodes: ["app-cli-flags", ...workspaceAppCodes, "app-cu-grants-separate"],
      unverifiedCodes,
      computerUse,
      launchAllowed: blockCodes.length === 0,
      blockCodes,
      blockReason: blockMessages[0] ?? null,
      driverIsFake,
      ...(workingCopyDev ? { workingCopyDevelopment: true } : {}),
    };
  }

  if (!KNOWN_HARNESS_KINDS.has(kind)) {
    addBlock("block-unknown-harness");
  } else if (workingCopyDev) {
    addBlock("block-working-copy-unsupported-harness");
  }

  const cursorSeatbelt = kind === "cursor" && input.cursorSeatbeltActive === true;
  const appEnforcementCodes = ["app-cli-flags", ...workspaceAppCodes];
  if (isReadOnlyAppMode(kind, mode)) appEnforcementCodes.push("app-cli-readonly");
  appEnforcementCodes.push("app-cu-grants-separate");

  const unverifiedCodes: string[] = [];
  if (!cursorSeatbelt) {
    unverifiedCodes.push("gap-no-os-sandbox", "gap-network-unrestricted", "gap-same-uid-secrets");
  } else {
    unverifiedCodes.push("gap-provider-traffic-separate", "gap-hardlink-fd-caveat");
  }
  if (kind === "cursor" && mode === "auto" && !cursorSeatbelt) unverifiedCodes.push("gap-cursor-sandbox-disabled");
  if (kind === "fx" && mode === "yolo") unverifiedCodes.push("gap-fx-default-yolo");
  if (kind === "antigravity" && mode === "ask") unverifiedCodes.push("gap-antigravity-accept-edits");
  if (kind === "claude-code" && mode === "bypass") unverifiedCodes.push("gap-claude-bypass");
  if (input.isPipeline) unverifiedCodes.push("gap-pipeline-unbounded");
  if (driverIsFake) unverifiedCodes.push("gap-fake-driver-no-os-proof");

  return {
    accessMode,
    requestedAccessModeValid,
    harnessId,
    harnessKind: kind,
    harnessMode: mode,
    effectiveWorkspace,
    osEnforcement: cursorSeatbelt
      ? {
          mechanism: "macos-seatbelt",
          filesystemReads: "restricted-workspace",
          filesystemWrites: "workspace-only",
          network: "unrestricted",
          summaryCodes: ["os-seatbelt-cursor"],
        }
      : {
          mechanism: "none",
          filesystemReads: "broad-same-uid",
          filesystemWrites: "unrestricted-same-uid",
          network: "unrestricted",
          summaryCodes: ["os-none"],
        },
    appEnforcementCodes,
    unverifiedCodes,
    computerUse,
    launchAllowed: blockCodes.length === 0,
    blockCodes,
    blockReason: blockMessages[0] ?? null,
    driverIsFake,
    ...(workingCopyDev ? { workingCopyDevelopment: true } : {}),
  };
}
