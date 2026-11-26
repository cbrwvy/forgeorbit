/** One permission decision shared by recommendations, review, preflight and argv. */
export const WORKSPACE_LAYOUTS = ["repo-root", "linked-worktree", "repo-subfolder", "non-git", "unknown"] as const;
export type WorkspaceLayout = (typeof WORKSPACE_LAYOUTS)[number];
export type CodexSandbox = "read-only" | "workspace-write" | "danger-full-access";
export function layoutNeedsExternalGit(layout: WorkspaceLayout): boolean {
  return layout === "linked-worktree" || layout === "repo-subfolder";
}
export function codexSandboxFor(mode: string, _layout: WorkspaceLayout): CodexSandbox {
  if (mode === "full-access") return "danger-full-access";
  if (mode === "auto") return "workspace-write";
  if (mode === "ask") return "read-only";
  throw new Error("Unknown Codex permission mode. Choose a supported mode explicitly.");
}
export interface PermissionDisclosure {
  harnessKind: "codex";
  mode: string;
  layout: WorkspaceLayout;
  sandbox: CodexSandbox;
  approval: "never-asked";
  /** Full access is possible only through the separately named mode. */
  escalated: boolean;
  network: "unrestricted" | "codex-config" | "sandbox-disabled";
  predicted: boolean;
  codes: string[];
  /** `restricted`: tool commands read only the working directory, system libraries and Bun (opt-in profile). Absent means broad. */
  readScope?: "broad" | "restricted";
  /** True when the project's "Development in a working copy" setting applies to this launch. */
  workingCopy?: boolean;
  /** Set only when the opt-in supervised-run time limit applies to the run this disclosure describes. */
  timeLimitSeconds?: number;
  /** False means a new Owner decision is required, never a silent fallback. */
  launchAllowed?: boolean;
  blockReason?: string | null;
}
export function describePermissions(input: { kind: string; mode: string; layout: WorkspaceLayout; predicted?: boolean; readScope?: "broad" | "restricted"; workingCopy?: boolean; timeLimitSeconds?: number | null }): PermissionDisclosure | null {
  if (input.kind !== "codex") return null;
  const known = ["auto", "ask", "full-access"].includes(input.mode);
  const sandbox = known ? codexSandboxFor(input.mode, input.layout) : "read-only";
  const workingCopy = input.workingCopy === true;
  const blockReason = !known ? "Unknown Codex permission mode. Choose a supported mode explicitly."
    : workingCopy && sandbox === "danger-full-access"
      ? "Development in a working copy requires sandboxed Auto mode. Full access disables the working-copy sandbox and is not allowed."
    : input.layout === "unknown" ? "Workspace permissions are Unknown. Verify the folder and review again."
    : input.mode === "auto" && layoutNeedsExternalGit(input.layout)
      ? "Owner decision required: sandboxed Auto cannot authorize Git writes outside this workspace. Choose Read-only, use the repository root, or explicitly select Full access and review again."
      : null;
  const codes = [`sandbox-${sandbox}`, "approval-never-asked", sandbox === "danger-full-access" ? "network-unrestricted" : "network-sandbox-disabled"];
  if (workingCopy && sandbox !== "danger-full-access") codes.push("working-copy-development");
  if (layoutNeedsExternalGit(input.layout)) codes.push(`layout-${input.layout}`);
  if (input.layout === "unknown") codes.push("layout-unknown");
  const restricted = input.readScope === "restricted" && sandbox !== "danger-full-access";
  if (restricted) codes.push("read-scope-restricted");
  if (blockReason) codes.push("owner-decision-required");
  return { harnessKind: "codex", mode: input.mode, layout: input.layout, sandbox, approval: "never-asked", readScope: restricted ? "restricted" : "broad",
    escalated: sandbox === "danger-full-access", network: sandbox === "danger-full-access" ? "unrestricted" : "sandbox-disabled",
    predicted: input.predicted === true, codes, launchAllowed: !blockReason, blockReason,
    ...(workingCopy ? { workingCopy: true } : {}),
    ...(input.timeLimitSeconds && input.timeLimitSeconds > 0 ? { timeLimitSeconds: input.timeLimitSeconds } : {}) };
}
export function permissionSummary(d: PermissionDisclosure): string {
  const policy = `Sandbox: ${d.sandbox}. Approval policy: never (non-interactive). Network policy: ${d.network === "unrestricted" ? "unrestricted" : "disabled for sandboxed commands (provider and control-plane traffic is separate)"}.`;
  return policy + (d.blockReason ? ` ${d.blockReason}` : d.escalated ? " Full user privileges require explicit Owner choice." : " Git operations may require separate Owner action; sandbox denial never enables full access.");
}
