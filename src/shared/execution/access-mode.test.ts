import { expect, test } from "bun:test";
import {
  ACCESS_MODES,
  assessAccessDiagnostics,
  normalizeAccessMode,
} from "./access-mode.ts";

test("normalizeAccessMode validates only the three defined modes", () => {
  expect(ACCESS_MODES).toEqual(["workspace", "isolated", "full-computer"]);
  for (const mode of ACCESS_MODES) expect(normalizeAccessMode(mode)).toBe(mode);
  for (const invalid of ["", "root", "sudo", "sandbox", null, undefined, 42]) {
    expect(normalizeAccessMode(invalid)).toBeNull();
  }
});

test("invalid access mode fails closed without silently falling back to workspace", () => {
  const result = assessAccessDiagnostics({
    requestedAccessMode: "unrestricted",
    kind: "codex",
    mode: "auto",
    isolation: "none",
    workdir: "/tmp/project",
    layout: "repo-root",
    readScope: "restricted",
  });
  expect(result.requestedAccessModeValid).toBe(false);
  expect(result.launchAllowed).toBe(false);
  expect(result.blockCodes).toContain("block-invalid-access-mode");
});

test("Workspace mode accurately distinguishes OS-enforced Codex boundaries from app-only harnesses and broad reads", () => {
  const codexBroad = assessAccessDiagnostics({
    requestedAccessMode: "workspace",
    kind: "codex",
    mode: "auto",
    isolation: "none",
    workdir: "/Users/dev/project",
    layout: "repo-root",
    readScope: "broad",
  });
  expect(codexBroad.launchAllowed).toBe(true);
  expect(codexBroad.osEnforcement.mechanism).toBe("macos-seatbelt");
  expect(codexBroad.osEnforcement.filesystemReads).toBe("broad-same-uid");
  expect(codexBroad.osEnforcement.network).toBe("sandbox-disabled");
  expect(codexBroad.unverifiedCodes).toContain("gap-broad-reads");
  expect(codexBroad.computerUse.grantedByMode).toBe(false);

  const codexWorktreeBlocked = assessAccessDiagnostics({
    requestedAccessMode: "workspace",
    kind: "codex",
    mode: "auto",
    isolation: "worktree",
    workdir: "/Users/dev/project",
    layout: "linked-worktree",
    predicted: true,
    readScope: "broad",
  });
  expect(codexWorktreeBlocked.launchAllowed).toBe(false);
  expect(codexWorktreeBlocked.blockCodes).toContain("block-codex-external-git");

  const claude = assessAccessDiagnostics({
    requestedAccessMode: "workspace",
    kind: "claude-code",
    mode: "bypass",
    isolation: "none",
    workdir: "/Users/dev/project",
    layout: "repo-root",
  });
  expect(claude.launchAllowed).toBe(true);
  expect(claude.osEnforcement.mechanism).toBe("none");
  expect(claude.osEnforcement.network).toBe("unrestricted");
  expect(claude.unverifiedCodes).toContain("gap-no-os-sandbox");
  expect(claude.unverifiedCodes).toContain("gap-claude-bypass");

  const cursorAuto = assessAccessDiagnostics({
    requestedAccessMode: "workspace",
    kind: "cursor",
    mode: "auto",
    isolation: "none",
    workdir: "/Users/dev/project",
    layout: "repo-root",
  });
  expect(cursorAuto.osEnforcement.mechanism).toBe("none");
  expect(cursorAuto.unverifiedCodes).toContain("gap-cursor-sandbox-disabled");

  const fxDefault = assessAccessDiagnostics({
    requestedAccessMode: "workspace",
    kind: "fx",
    mode: "yolo",
    isolation: "none",
    workdir: "/Users/dev/project",
    layout: "repo-root",
  });
  expect(fxDefault.osEnforcement.mechanism).toBe("none");
  expect(fxDefault.unverifiedCodes).toContain("gap-fx-default-yolo");
});

test("Isolated mode requires disposable staging, restricted Codex Seatbelt, and no network fallback", () => {
  const allowed = assessAccessDiagnostics({
    requestedAccessMode: "isolated",
    kind: "codex",
    mode: "auto",
    isolation: "none",
    workdir: "/Users/dev/project",
    stagedCwd: "/Users/dev/.agetor/task-workspaces/t1/staging",
    layout: "non-git",
    readScope: "restricted",
    seatbeltStatus: "available",
  });
  expect(allowed.launchAllowed).toBe(true);
  expect(allowed.effectiveWorkspace.kind).toBe("task-staging");
  expect(allowed.osEnforcement.mechanism).toBe("macos-seatbelt-restricted");
  expect(allowed.osEnforcement.filesystemReads).toBe("restricted-workspace");
  expect(allowed.osEnforcement.filesystemWrites).toBe("workspace-only");
  expect(allowed.osEnforcement.network).toBe("sandbox-disabled");
  expect(allowed.computerUse.grantedByMode).toBe(false);

  const unstaged = assessAccessDiagnostics({
    requestedAccessMode: "isolated",
    kind: "codex",
    mode: "auto",
    isolation: "none",
    workdir: "/Users/dev/project",
    stagedCwd: null,
    layout: "repo-root",
    seatbeltStatus: "available",
  });
  expect(unstaged.launchAllowed).toBe(false);
  expect(unstaged.blockCodes).toContain("block-isolated-requires-staging");
  expect(unstaged.effectiveWorkspace.path).toBeNull();

  for (const kind of ["claude-code", "cursor", "gemini", "antigravity", "fx"]) {
    const unsupported = assessAccessDiagnostics({
      requestedAccessMode: "isolated",
      kind,
      mode: "auto",
      isolation: "none",
      workdir: "/Users/dev/project",
      stagedCwd: "/Users/dev/.agetor/task-workspaces/t1/staging",
      layout: "non-git",
      seatbeltStatus: "available",
    });
    expect(unsupported.launchAllowed).toBe(false);
    expect(unsupported.blockCodes).toContain("block-isolated-unsupported-harness");
    expect(unsupported.osEnforcement.mechanism).toBe("none");
  }

  const codexFullAccess = assessAccessDiagnostics({
    requestedAccessMode: "isolated",
    kind: "codex",
    mode: "full-access",
    isolation: "none",
    workdir: "/Users/dev/project",
    stagedCwd: "/Users/dev/.agetor/task-workspaces/t1/staging",
    layout: "non-git",
    seatbeltStatus: "available",
  });
  expect(codexFullAccess.launchAllowed).toBe(false);
  expect(codexFullAccess.blockCodes).toContain("block-isolated-full-access");

  const nested = assessAccessDiagnostics({
    requestedAccessMode: "isolated",
    kind: "codex",
    mode: "ask",
    isolation: "none",
    workdir: "/Users/dev/project",
    stagedCwd: "/Users/dev/.agetor/task-workspaces/t1/staging",
    layout: "non-git",
    seatbeltStatus: "nested-blocked",
  });
  expect(nested.launchAllowed).toBe(false);
  expect(nested.blockCodes).toContain("block-isolated-seatbelt-nested");

  const pipelineIsolated = assessAccessDiagnostics({
    requestedAccessMode: "isolated",
    kind: "codex",
    mode: "auto",
    isolation: "none",
    workdir: "/Users/dev/project",
    stagedCwd: "/Users/dev/.agetor/task-workspaces/t1/staging",
    layout: "non-git",
    seatbeltStatus: "available",
    isPipeline: true,
  });
  expect(pipelineIsolated.launchAllowed).toBe(false);
  expect(pipelineIsolated.blockCodes).toContain("block-isolated-pipeline");
});

test("Full Computer mode grants nothing on selection and keeps Computer Use separate from process launches", () => {
  const fullComp = assessAccessDiagnostics({
    requestedAccessMode: "full-computer",
    kind: "codex",
    mode: "full-access",
    isolation: "none",
    workdir: "/Users/dev/project",
    layout: "repo-root",
  });
  expect(fullComp.launchAllowed).toBe(false);
  expect(fullComp.blockCodes).toContain("block-full-computer-no-process-grant");
  expect(fullComp.osEnforcement.mechanism).toBe("none");
  expect(fullComp.osEnforcement.filesystemWrites).toBe("read-only");
  expect(fullComp.computerUse.grantedByMode).toBe(false);
  expect(fullComp.computerUse.browserSeparate).toBe(true);
  expect(fullComp.computerUse.nativeSeparate).toBe(true);
  expect(fullComp.computerUse.sensitiveTargetsBlocked).toBe(true);
  expect(fullComp.effectiveWorkspace.kind).toBe("none");
});
