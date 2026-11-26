/**
 * Project permission rules and requests for one bounded local action.
 * Pure: no database, no process, no clock except where a value is passed in.
 *
 * Supported action today: `run_project_test` — one fixed `bun test ./<path>`
 * through the existing offline observed-test runner. There is no general
 * command action here and a model cannot add one.
 */

export const PERMISSION_ACTIONS = ["run_project_test"] as const;
export type PermissionAction = (typeof PERMISSION_ACTIONS)[number];

/** `ask` is the absence of a rule, so it is never stored. */
export type PermissionRuleMode = "deny" | "allow";
export type PermissionEffect = "ask" | "deny" | "allow";

export const PERMISSION_REQUEST_TTL_MS = 10 * 60_000;
export const PERMISSION_RULE_LIMIT_PER_PROJECT = 20;

export interface ProjectPermissionRule {
  id: string;
  projectPath: string;
  action: PermissionAction;
  mode: PermissionRuleMode;
  /** Exact command an allow rule is bound to. `null` on a deny rule means "every command in this project". */
  command: string | null;
  createdAt: number;
  revokedAt: number | null;
}

export type PermissionRequestStatus =
  | "pending"
  | "running"
  | "completed"
  | "failed"
  | "denied"
  | "cancelled"
  | "expired"
  | "blocked"
  | "interrupted";

export const TERMINAL_REQUEST_STATUSES: readonly PermissionRequestStatus[] = [
  "completed",
  "failed",
  "denied",
  "cancelled",
  "expired",
  "blocked",
  "interrupted",
];

/** How a run was authorized. `owner-once` is consumed by the run that used it. */
export type PermissionAuthority = "owner-once" | "project-rule";

/**
 * Who asked. `owner` = the Owner's own submit from the task panel. `worker` = the core read a
 * structured suggestion from a settled Developer run. A worker origin can only ever create a
 * pending request (or a recorded denial): it is never run by a rule, only by the Owner's Allow once.
 */
export type PermissionOrigin = "owner" | "worker";

export interface ProjectPermissionRequest {
  id: string;
  projectPath: string;
  taskId: string;
  taskTitle: string;
  action: PermissionAction;
  command: string;
  argv: string[];
  cwd: string;
  sourceFingerprint: string;
  commandFingerprint: string;
  status: PermissionRequestStatus;
  authority: PermissionAuthority | null;
  origin: PermissionOrigin;
  /** The Developer run whose output carried the suggestion. `null` for an Owner request. */
  originRunId: string | null;
  ruleId: string | null;
  /** One plain sentence about the outcome. Never invented: it quotes the gate or the test. */
  reason: string | null;
  exitCode: number | null;
  summary: string | null;
  isolation: string | null;
  createdAt: number;
  expiresAt: number;
  decidedAt: number | null;
  startedAt: number | null;
  finishedAt: number | null;
}

export interface PermissionDecision {
  effect: PermissionEffect;
  ruleId: string | null;
  reason: string;
}

/** Cheap, browser-safe shape check for the form. The server's `validateRuleCommand` is authoritative. */
export function looksLikeTestCommand(raw: string): boolean {
  const command = raw.trim();
  return /^bun test \.\/[A-Za-z0-9_./-]+$/.test(command) && !command.includes("..") && !command.includes("//");
}

/**
 * Effective rule for one request. A deny rule wins over everything; an allow
 * rule applies only to the exact command it names; otherwise the answer is Ask.
 * Callers still have to pass every other gate (stop, admission, workspace).
 */
export function evaluateProjectRule(
  rules: readonly ProjectPermissionRule[],
  target: { projectPath: string; action: PermissionAction; command: string },
): PermissionDecision {
  const active = rules.filter((rule) => rule.revokedAt == null && rule.projectPath === target.projectPath && rule.action === target.action);
  const deny = active.find((rule) => rule.mode === "deny" && (rule.command == null || rule.command === target.command));
  if (deny) {
    return { effect: "deny", ruleId: deny.id, reason: deny.command == null ? "This project denies the action." : "A project rule denies this command." };
  }
  const allow = active.find((rule) => rule.mode === "allow" && rule.command === target.command);
  if (allow) return { effect: "allow", ruleId: allow.id, reason: "An Owner project rule allows this exact command." };
  return { effect: "ask", ruleId: null, reason: "No rule covers this command. It needs your decision." };
}

/** Project default for the UI: Deny when an active project-wide deny rule exists, else Ask. */
export function projectDefault(rules: readonly ProjectPermissionRule[], projectPath: string, action: PermissionAction = "run_project_test"): "ask" | "deny" {
  return rules.some((rule) => rule.revokedAt == null && rule.projectPath === projectPath && rule.action === action && rule.mode === "deny" && rule.command == null)
    ? "deny"
    : "ask";
}

/** Status as shown now: a pending request past its time reads as expired without any write. */
export function effectiveStatus(request: Pick<ProjectPermissionRequest, "status" | "expiresAt">, now: number): PermissionRequestStatus {
  return request.status === "pending" && request.expiresAt <= now ? "expired" : request.status;
}

/** What the Owner is shown and what an approval must echo back to be accepted. */
export interface ProjectPermissionsPayload {
  action: PermissionAction;
  /** Project-scoped Developer working-copy development toggle (opt-in, default false). */
  workspaceDevelopment?: boolean;
  rules: ProjectPermissionRule[];
  requests: ProjectPermissionRequest[];
}

/** Row in the existing Owner attention roll-up. Same fields the Owner needs to decide. */
export interface ProjectPermissionRequestRow {
  projectPath: string;
  id: string;
  title: string;
  taskId: string;
  command: string;
  cwd: string;
  commandFingerprint: string;
  expiresAt: number;
  origin?: PermissionOrigin;
}

/** Read-only task-panel answer. The target is backend-derived; the UI only displays it. */
export interface ProjectTestPreview {
  taskId: string;
  eligible: boolean;
  /** Why not, as the backend's own gate code (`workspace`, `emergency-stop`, `open`, …). */
  code: string | null;
  /** The backend's own sentence. Shown as is. */
  reason: string | null;
  target: {
    projectPath: string;
    command: string;
    cwd: string;
    sourceFingerprint: string;
    commandFingerprint: string;
  } | null;
  /** What submitting would do right now: `allow` runs immediately, `ask` waits for the Owner, `deny` records a denial. */
  effect: PermissionEffect | null;
  ruleId: string | null;
  openRequestId: string | null;
  requests: ProjectPermissionRequest[];
}
