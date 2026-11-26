/**
 * FO-AUTONOMY-FULL01 — durable autonomy policy contract.
 *
 * Pure evaluation. A model recommendation is not an input that can grant
 * permission. Broader policies intersect with narrower ones; they never
 * override a more restrictive project or task policy. Revisions are compared
 * so an existing activation keeps the digest it was approved with.
 */
import { createHash } from "node:crypto";
import { containsCredentialMaterial } from "./brain/document.ts";
import { CURSOR_INTERNAL_SANDBOX_BLOCKER, DEEPSEEK_CONTAINMENT_BLOCKER } from "./provider-readiness.ts";
import { approvedTestCommand } from "./review-evidence.ts";

export const AUTONOMY_MODES = ["supervised", "autonomous", "full-autonomy"] as const;
export type AutonomyMode = (typeof AUTONOMY_MODES)[number];

export const AUTONOMY_SCOPE_KINDS = ["task", "project", "cluster", "workspace"] as const;
export type AutonomyScopeKind = (typeof AUTONOMY_SCOPE_KINDS)[number];

export const AUTONOMY_ACTIONS = [
  "create_task",
  "prioritize_task",
  "manage_backlog",
  "manage_inbox",
  "assign_specialist",
  "plan_task",
  "launch_task",
  "run_qc",
  "request_rework",
  "update_mission_status",
  "save_observation",
  "retrieve_brain",
  "persist_memory",
  "complete_task",
  "run_observed_test",
  "select_model",
  "coordinate_projects",
  "git_read",
  "git_mutate",
  "ci_inspect",
  "ci_dispatch",
  "staging_deploy",
  "deployment_health",
  "rollback_prepare",
  "rollback_execute",
] as const;
export type AutonomyAction = (typeof AUTONOMY_ACTIONS)[number];

/** Operations that stay denied even if a policy body lists them. */
export const ALWAYS_DENIED_OPERATIONS = [
  "edit_policy",
  "renew_policy",
  "elevate_policy",
  "unrestricted_filesystem",
  "credential_extraction",
  "unauthorized_account_switch",
  "delete_unrelated_files",
  "production_deploy",
  "destructive_infrastructure",
  "self_modify_policy",
  "self_modify_improvement_safety",
  "edit_sandbox",
] as const;
export type DeniedOperation = (typeof ALWAYS_DENIED_OPERATIONS)[number];

export const ROUTER_PRESETS = [
  "best-quality",
  "lowest-cost",
  "balanced",
  "fastest",
  "quota-saver",
  "custom",
] as const;
export type AutonomyRouterPreset = (typeof ROUTER_PRESETS)[number];

export const MEMORY_APPROVALS = ["owner", "propose", "auto-low-risk"] as const;
export type MemoryApproval = (typeof MEMORY_APPROVALS)[number];

const MODE_RANK: Record<AutonomyMode, number> = {
  supervised: 0,
  autonomous: 1,
  "full-autonomy": 2,
};

const SCOPE_RANK: Record<AutonomyScopeKind, number> = {
  workspace: 1,
  cluster: 2,
  project: 3,
  task: 4,
};

const INFRA_PRIVILEGED = new Set<AutonomyAction>(["git_mutate", "ci_dispatch", "staging_deploy", "rollback_execute"]);

export function independentAuthorizationRequired(action: AutonomyAction): boolean {
  return INFRA_PRIVILEGED.has(action);
}

const AUTONOMOUS_ROUTINE = new Set<AutonomyAction>([
  "git_read",
  "ci_inspect",
  "deployment_health",
  "rollback_prepare",
  "create_task",
  "prioritize_task",
  "manage_backlog",
  "manage_inbox",
  "assign_specialist",
  "plan_task",
  "launch_task",
  "run_qc",
  "request_rework",
  "update_mission_status",
  "save_observation",
  "retrieve_brain",
  "select_model",
  "coordinate_projects",
]);

/** One Owner-fixed Bun test. An agent cannot append to this list. */
export interface AuthorizedTestGrant {
  projectPath: string;
  command: string;
  outputPaths: string[];
  taskId?: string | null;
}

export interface AutonomySpending {
  /** Advisory ceiling. Not a provider billing cap. */
  limitUsd: number | null;
  /** When true, automatic execution is refused because ForgeOrbit cannot enforce provider billing. */
  requireEnforceableCap: boolean;
  enforceable: false;
  measured: false;
}

export interface AutonomyPolicyBody {
  mode: AutonomyMode;
  scopeKind: AutonomyScopeKind;
  scopeRef: string;
  missionId: string | null;
  projects: string[];
  clusters: string[];
  taskIds: string[];
  permittedActions: AutonomyAction[];
  deniedOperations: DeniedOperation[];
  specialistRoles: string[];
  providers: string[];
  models: string[];
  accounts: string[];
  allowUnscopedAccount: boolean;
  maxConcurrentWorkers: number;
  maxLaunches: number;
  maxDurationMs: number;
  /** Advisory planning target. The existing activation duration remains the runtime limit. */
  expectedDurationMs?: number;
  /** Requires current positive account-bound provider evidence at admission. */
  requireVerifiedQuota?: true;
  spending: AutonomySpending;
  qc: {
    required: boolean;
    requireIndependentReviewer: boolean;
    requireObservedTest: boolean;
  };
  maxReworkAttempts: number;
  completion: {
    autoComplete: boolean;
    conditions: Array<"qc_pass" | "observed_test">;
  };
  memory: { approval: MemoryApproval };
  routerPreset: AutonomyRouterPreset;
  /**
   * Self-improvement permission. Absent on policies created before FO-SELF-IMPROVE01.
   * Default is disabled. Enabling it on an active policy is an expansion.
   */
  selfImprovement?: {
    enabled: boolean;
    lowRiskActivation: boolean;
  };
  /**
   * Fixed test commands. Empty or absent means none. Adding a command or an
   * output path is an expansion of an active grant. Omitted from the digest
   * when empty so policies stored before this field keep their digest.
   */
  authorizedTests?: AuthorizedTestGrant[];
  expiresAt: number;
}

export interface PolicyTarget {
  projectPath: string;
  taskId?: string | null;
  clusterId?: string | null;
  role?: string | null;
  provider?: string | null;
  model?: string | null;
  accountId?: string | null;
  action: AutonomyAction;
}

export interface PolicyCounters {
  launchesUsed: number;
  launchesInFlight: number;
  reworkUsedForTask: number;
  now: number;
  activatedAt: number;
  lifecycleAllowed: boolean;
  verifiedQuota?: boolean;
  lifecycleReason?: string | null;
  emergencyStopped: boolean;
  paused: boolean;
  revoked: boolean;
  expired: boolean;
}

export interface PolicyDecision {
  allow: boolean;
  reason: string;
  policyId: string | null;
  revision: number | null;
  digest: string | null;
  mode: AutonomyMode | null;
  intersectedPolicyIds: string[];
}

export interface ApplicablePolicy {
  id: string;
  revision: number;
  digest: string;
  body: AutonomyPolicyBody;
}

const BLOCKED_PROVIDERS = new Set(["cursor", "deepseek", "deepseek-dsh"]);

export function isBlockedProvider(provider: string | null | undefined, model: string | null | undefined): string | null {
  const p = (provider ?? "").toLowerCase();
  const m = (model ?? "").toLowerCase();
  if (p === "cursor" || p.includes("cursor")) return CURSOR_INTERNAL_SANDBOX_BLOCKER;
  if (p.includes("deepseek") || m.includes("deepseek")) return DEEPSEEK_CONTAINMENT_BLOCKER;
  if (BLOCKED_PROVIDERS.has(p)) return `${provider} is not executable.`;
  return null;
}

function uniq(values: string[]): string[] {
  const out: string[] = [];
  for (const value of values) {
    const trimmed = value.trim();
    if (!trimmed || out.includes(trimmed)) continue;
    out.push(trimmed);
  }
  return out;
}

function asStringList(raw: unknown, field: string): string[] {
  if (!Array.isArray(raw)) throw new Error(`${field} must be a list.`);
  return uniq(raw.map((item) => {
    if (typeof item !== "string") throw new Error(`${field} entries must be strings.`);
    return item;
  }));
}

export function normalizePolicyBody(raw: unknown, now = Date.now()): AutonomyPolicyBody {
  if (!raw || typeof raw !== "object") throw new Error("Policy body is required.");
  const body = raw as Record<string, unknown>;
  const mode = body.mode;
  if (!AUTONOMY_MODES.includes(mode as AutonomyMode)) throw new Error("Unknown operating mode.");
  const scopeKind = body.scopeKind;
  if (!AUTONOMY_SCOPE_KINDS.includes(scopeKind as AutonomyScopeKind)) throw new Error("Unknown policy scope.");
  const scopeRef = typeof body.scopeRef === "string" ? body.scopeRef.trim() : "";
  if (!scopeRef) throw new Error("Policy scope reference is required.");
  const requestedActions = asStringList(body.permittedActions ?? [], "permittedActions");
  for (const action of requestedActions) {
    if ((ALWAYS_DENIED_OPERATIONS as readonly string[]).includes(action)) {
      throw new Error(`Action ${action} cannot be permitted.`);
    }
  }
  const permitted = requestedActions.filter((item): item is AutonomyAction => AUTONOMY_ACTIONS.includes(item as AutonomyAction));
  if (permitted.length !== requestedActions.length) {
    throw new Error("Permitted actions contain an unknown category.");
  }
  const spendingRaw = (body.spending ?? {}) as Record<string, unknown>;
  const qcRaw = (body.qc ?? {}) as Record<string, unknown>;
  const completionRaw = (body.completion ?? {}) as Record<string, unknown>;
  const memoryRaw = (body.memory ?? {}) as Record<string, unknown>;
  const conditions = Array.isArray(completionRaw.conditions)
    ? completionRaw.conditions.filter((item) => item === "qc_pass" || item === "observed_test")
    : ["qc_pass"];
  const approval = memoryRaw.approval;
  if (approval != null && !MEMORY_APPROVALS.includes(approval as MemoryApproval)) {
    throw new Error("Unknown memory approval policy.");
  }
  const preset = body.routerPreset ?? "balanced";
  if (!ROUTER_PRESETS.includes(preset as AutonomyRouterPreset)) throw new Error("Unknown router preset.");
  const maxConcurrent = Number(body.maxConcurrentWorkers ?? 2);
  const maxLaunches = Number(body.maxLaunches ?? 8);
  const maxDurationMs = Number(body.maxDurationMs ?? 60 * 60 * 1000);
  const maxRework = Number(body.maxReworkAttempts ?? 1);
  if (!Number.isInteger(maxConcurrent) || maxConcurrent < 1 || maxConcurrent > 32) throw new Error("Concurrent worker limit must be 1..32.");
  if (!Number.isInteger(maxLaunches) || maxLaunches < 1 || maxLaunches > 500) throw new Error("Launch limit must be 1..500.");
  if (!Number.isInteger(maxDurationMs) || maxDurationMs < 60_000 || maxDurationMs > 7 * 24 * 60 * 60 * 1000) {
    throw new Error("Execution duration must be between 1 minute and 7 days.");
  }
  if (!Number.isInteger(maxRework) || maxRework < 0 || maxRework > 5) throw new Error("Rework attempts must be 0..5.");
  const expectedDurationMs = body.expectedDurationMs == null ? null : Number(body.expectedDurationMs);
  if (expectedDurationMs !== null && (!Number.isInteger(expectedDurationMs) || expectedDurationMs < 60_000 || expectedDurationMs > maxDurationMs)) {
    throw new Error("Expected duration must be between one minute and the execution duration limit.");
  }
  const expiresAt = Number(body.expiresAt ?? now + maxDurationMs);
  if (!Number.isFinite(expiresAt)) throw new Error("Expiration is required.");
  const limitUsd = spendingRaw.limitUsd == null ? null : Number(spendingRaw.limitUsd);
  if (limitUsd != null && (!Number.isFinite(limitUsd) || limitUsd < 0)) throw new Error("Spending limit must be a non-negative number.");
  const normalized: AutonomyPolicyBody = {
    mode: mode as AutonomyMode,
    scopeKind: scopeKind as AutonomyScopeKind,
    scopeRef,
    missionId: typeof body.missionId === "string" && body.missionId.trim() ? body.missionId.trim() : null,
    projects: asStringList(body.projects ?? [], "projects"),
    clusters: asStringList(body.clusters ?? [], "clusters"),
    taskIds: asStringList(body.taskIds ?? [], "taskIds"),
    permittedActions: permitted,
    deniedOperations: [...ALWAYS_DENIED_OPERATIONS],
    specialistRoles: asStringList(body.specialistRoles ?? [], "specialistRoles").map((role) => role.toLowerCase()),
    providers: asStringList(body.providers ?? [], "providers").map((item) => item.toLowerCase()),
    models: asStringList(body.models ?? [], "models"),
    accounts: asStringList(body.accounts ?? [], "accounts"),
    allowUnscopedAccount: body.allowUnscopedAccount === true,
    maxConcurrentWorkers: maxConcurrent,
    maxLaunches,
    maxDurationMs,
    ...(expectedDurationMs === null ? {} : { expectedDurationMs }),
    ...(body.requireVerifiedQuota === true ? { requireVerifiedQuota: true as const } : {}),
    spending: {
      limitUsd,
      requireEnforceableCap: spendingRaw.requireEnforceableCap === true,
      enforceable: false,
      measured: false,
    },
    qc: {
      required: qcRaw.required !== false,
      requireIndependentReviewer: qcRaw.requireIndependentReviewer !== false,
      requireObservedTest: qcRaw.requireObservedTest === true,
    },
    maxReworkAttempts: maxRework,
    completion: {
      autoComplete: completionRaw.autoComplete === true,
      conditions: conditions.length > 0 ? conditions as Array<"qc_pass" | "observed_test"> : ["qc_pass"],
    },
    memory: { approval: (approval as MemoryApproval) ?? "owner" },
    routerPreset: preset as AutonomyRouterPreset,
    selfImprovement: normalizeSelfImprovement(body.selfImprovement),
    authorizedTests: normalizeAuthorizedTests(body.authorizedTests),
    expiresAt,
  };
  if (normalized.scopeKind === "project" && !normalized.projects.includes(normalized.scopeRef)) {
    normalized.projects = [...normalized.projects, normalized.scopeRef];
  }
  if (normalized.scopeKind === "cluster" && !normalized.clusters.includes(normalized.scopeRef)) {
    normalized.clusters = [...normalized.clusters, normalized.scopeRef];
  }
  if (normalized.scopeKind === "task" && !normalized.taskIds.includes(normalized.scopeRef)) {
    normalized.taskIds = [...normalized.taskIds, normalized.scopeRef];
  }
  if (normalized.projects.length === 0) throw new Error("A policy must name the projects it covers.");
  if (normalized.specialistRoles.length === 0) throw new Error("A policy must name the specialist roles it allows.");
  if (normalized.providers.length === 0 || normalized.models.length === 0) {
    throw new Error("A policy must name the providers and models it allows.");
  }
  for (const provider of normalized.providers) {
    const blocked = isBlockedProvider(provider, null);
    if (blocked && normalized.providers.length === 1) throw new Error(blocked);
  }
  for (const model of normalized.models) {
    if (model.toLowerCase().includes("deepseek") && normalized.models.length === 1) {
      throw new Error(DEEPSEEK_CONTAINMENT_BLOCKER);
    }
  }
  return normalized;
}

export function canonicalPolicyBody(body: AutonomyPolicyBody): AutonomyPolicyBody {
  const canonical: AutonomyPolicyBody = {
    ...body,
    projects: [...body.projects].sort(),
    clusters: [...body.clusters].sort(),
    taskIds: [...body.taskIds].sort(),
    permittedActions: [...body.permittedActions].sort(),
    deniedOperations: [...body.deniedOperations].sort() as DeniedOperation[],
    specialistRoles: [...body.specialistRoles].sort(),
    providers: [...body.providers].sort(),
    models: [...body.models].sort(),
    accounts: [...body.accounts].sort(),
    completion: { ...body.completion, conditions: [...body.completion.conditions].sort() as Array<"qc_pass" | "observed_test"> },
  };
  if (canonical.expectedDurationMs == null) delete canonical.expectedDurationMs;
  if (!canonical.requireVerifiedQuota) delete canonical.requireVerifiedQuota;
  if (!canonical.authorizedTests || canonical.authorizedTests.length === 0) delete canonical.authorizedTests;
  else {
    canonical.authorizedTests = [...canonical.authorizedTests]
      .map((grant) => ({ ...grant, outputPaths: [...grant.outputPaths].sort(), taskId: grant.taskId ?? null }))
      .sort((a, b) => `${a.projectPath}\0${a.command}\0${a.taskId ?? ""}`.localeCompare(`${b.projectPath}\0${b.command}\0${b.taskId ?? ""}`));
  }
  return canonical;
}

export function policyDigest(body: AutonomyPolicyBody): string {
  return createHash("sha256").update(JSON.stringify(canonicalPolicyBody(body))).digest("hex");
}

export function policyCoversTarget(body: AutonomyPolicyBody, target: Pick<PolicyTarget, "projectPath" | "taskId" | "clusterId">): boolean {
  if (!body.projects.includes(target.projectPath)) return false;
  if (body.scopeKind === "task") {
    return Boolean(target.taskId) && body.taskIds.includes(target.taskId!);
  }
  if (body.scopeKind === "project") return body.projects.includes(target.projectPath);
  if (body.scopeKind === "cluster") {
    if (target.clusterId && !body.clusters.includes(target.clusterId) && body.scopeRef !== target.clusterId) {
      return body.projects.includes(target.projectPath);
    }
    return body.projects.includes(target.projectPath);
  }
  return body.scopeKind === "workspace" && body.projects.includes(target.projectPath);
}

function intersect<T>(lists: T[][]): T[] {
  if (lists.length === 0) return [];
  return lists[0]!.filter((item) => lists.every((list) => list.includes(item)));
}

export function revisionExpands(previous: AutonomyPolicyBody, next: AutonomyPolicyBody): string[] {
  const reasons: string[] = [];
  if (MODE_RANK[next.mode] > MODE_RANK[previous.mode]) reasons.push("mode");
  for (const project of next.projects) if (!previous.projects.includes(project)) reasons.push(`project:${project}`);
  for (const cluster of next.clusters) if (!previous.clusters.includes(cluster)) reasons.push(`cluster:${cluster}`);
  for (const taskId of next.taskIds) if (!previous.taskIds.includes(taskId)) reasons.push(`task:${taskId}`);
  for (const action of next.permittedActions) if (!previous.permittedActions.includes(action)) reasons.push(`action:${action}`);
  for (const denied of previous.deniedOperations) if (!next.deniedOperations.includes(denied)) reasons.push(`denied:${denied}`);
  for (const role of next.specialistRoles) if (!previous.specialistRoles.includes(role)) reasons.push(`role:${role}`);
  for (const provider of next.providers) if (!previous.providers.includes(provider)) reasons.push(`provider:${provider}`);
  for (const model of next.models) if (!previous.models.includes(model)) reasons.push(`model:${model}`);
  for (const account of next.accounts) if (!previous.accounts.includes(account)) reasons.push(`account:${account}`);
  if (next.allowUnscopedAccount && !previous.allowUnscopedAccount) reasons.push("unscoped-account");
  if (next.maxConcurrentWorkers > previous.maxConcurrentWorkers) reasons.push("concurrency");
  if (next.maxLaunches > previous.maxLaunches) reasons.push("launches");
  if (next.maxDurationMs > previous.maxDurationMs) reasons.push("duration");
  if (next.maxReworkAttempts > previous.maxReworkAttempts) reasons.push("rework");
  if (next.expiresAt > previous.expiresAt) reasons.push("expiration");
  if (next.completion.autoComplete && !previous.completion.autoComplete) reasons.push("auto-complete");
  if (!next.qc.required && previous.qc.required) reasons.push("qc-required");
  if (!next.qc.requireObservedTest && previous.qc.requireObservedTest) reasons.push("observed-test");
  if (next.memory.approval === "auto-low-risk" && previous.memory.approval !== "auto-low-risk") reasons.push("memory");
  if (previous.memory.approval === "owner" && next.memory.approval === "propose") reasons.push("memory");
  if (previous.requireVerifiedQuota && !next.requireVerifiedQuota) reasons.push("quota-evidence");
  if (previous.spending.requireEnforceableCap && !next.spending.requireEnforceableCap) reasons.push("spend-cap");
  if ((next.spending.limitUsd ?? Infinity) > (previous.spending.limitUsd ?? Infinity)) reasons.push("spend-limit");
  const previousImprovement = previous.selfImprovement?.enabled === true;
  const nextImprovement = next.selfImprovement?.enabled === true;
  if (nextImprovement && !previousImprovement) reasons.push("self-improvement");
  if (next.selfImprovement?.lowRiskActivation === true && previous.selfImprovement?.lowRiskActivation !== true) {
    reasons.push("self-improvement-activation");
  }
  const previousTests = new Set((previous.authorizedTests ?? []).map((grant) => `${grant.projectPath}\0${grant.command}`));
  for (const grant of next.authorizedTests ?? []) {
    const key = `${grant.projectPath}\0${grant.command}`;
    if (!previousTests.has(key)) reasons.push(`test-command:${grant.command}`);
    const previousGrant = (previous.authorizedTests ?? []).find((item) => item.projectPath === grant.projectPath && item.command === grant.command);
    for (const output of grant.outputPaths) {
      if (!previousGrant?.outputPaths.includes(output)) reasons.push(`test-output:${output}`);
    }
  }
  return reasons;
}

function normalizeAuthorizedTests(raw: unknown): AuthorizedTestGrant[] {
  if (raw == null) return [];
  if (!Array.isArray(raw)) throw new Error("authorizedTests must be a list.");
  if (raw.length > 8) throw new Error("A policy may name at most 8 fixed test commands.");
  return raw.map((item) => {
    if (!item || typeof item !== "object") throw new Error("Each authorized test must be an object.");
    const row = item as Record<string, unknown>;
    const projectPath = typeof row.projectPath === "string" ? row.projectPath.trim() : "";
    const command = typeof row.command === "string" ? row.command.trim() : "";
    if (!projectPath || !command) throw new Error("An authorized test needs a project path and a command.");
    const testPath = command.startsWith("bun test ./") ? command.slice("bun test ./".length) : "";
    if (!testPath || approvedTestCommand(testPath) !== command) {
      throw new Error("An authorized test must be the fixed command bun test ./<relative test path>.");
    }
    if (!Array.isArray(row.outputPaths) || row.outputPaths.length === 0 || row.outputPaths.length > 8) {
      throw new Error("An authorized test needs 1..8 output paths.");
    }
    const outputPaths = row.outputPaths.map((entry) => {
      if (typeof entry !== "string") throw new Error("Output paths must be strings.");
      const rel = entry.trim();
      if (!/^[A-Za-z0-9_./-]+$/.test(rel) || rel.startsWith("/") || rel.split("/").includes("..") || rel === testPath) {
        throw new Error(`Output path ${entry} is not a safe relative implementation path.`);
      }
      return rel;
    });
    const taskId = typeof row.taskId === "string" && row.taskId.trim() ? row.taskId.trim() : null;
    return { projectPath, command, outputPaths, taskId };
  });
}

function normalizeSelfImprovement(raw: unknown): { enabled: boolean; lowRiskActivation: boolean } {
  const body = raw && typeof raw === "object" ? raw as Record<string, unknown> : {};
  const enabled = body.enabled === true;
  return { enabled, lowRiskActivation: enabled && body.lowRiskActivation === true };
}

function modeAllows(mode: AutonomyMode, action: AutonomyAction, body: AutonomyPolicyBody): boolean {
  if (mode === "supervised") return false;
  if (INFRA_PRIVILEGED.has(action)) return mode === "full-autonomy";
  if (action === "complete_task") return body.completion.autoComplete === true;
  if (action === "persist_memory") return body.memory.approval === "auto-low-risk";
  if (mode === "autonomous") return AUTONOMOUS_ROUTINE.has(action);
  return true;
}

export function evaluateApplicablePolicies(
  policies: ApplicablePolicy[],
  target: PolicyTarget,
  counters: PolicyCounters,
): PolicyDecision {
  const applicable = policies.filter((policy) => policyCoversTarget(policy.body, target));
  if (applicable.length === 0) {
    return {
      allow: false,
      reason: "No active Owner policy covers this target.",
      policyId: null,
      revision: null,
      digest: null,
      mode: null,
      intersectedPolicyIds: [],
    };
  }
  const ordered = [...applicable].sort((a, b) => SCOPE_RANK[b.body.scopeKind] - SCOPE_RANK[a.body.scopeKind]);
  const narrowest = ordered[0]!;
  const bodies = applicable.map((policy) => policy.body);
  const mode = bodies.reduce<AutonomyMode>((min, body) => (MODE_RANK[body.mode] < MODE_RANK[min] ? body.mode : min), bodies[0]!.mode);
  const permitted = intersect(bodies.map((body) => body.permittedActions));
  const roles = intersect(bodies.map((body) => body.specialistRoles));
  const providers = intersect(bodies.map((body) => body.providers));
  const models = intersect(bodies.map((body) => body.models));
  const accounts = intersect(bodies.map((body) => body.accounts));
  const maxConcurrent = Math.min(...bodies.map((body) => body.maxConcurrentWorkers));
  const maxLaunches = Math.min(...bodies.map((body) => body.maxLaunches));
  const maxDuration = Math.min(...bodies.map((body) => body.maxDurationMs));
  const maxRework = Math.min(...bodies.map((body) => body.maxReworkAttempts));
  const expiresAt = Math.min(...bodies.map((body) => body.expiresAt));
  const autoComplete = bodies.every((body) => body.completion.autoComplete);
  const requireCap = bodies.some((body) => body.spending.requireEnforceableCap);
  const allowUnscoped = bodies.every((body) => body.allowUnscopedAccount);
  const base = {
    policyId: narrowest.id,
    revision: narrowest.revision,
    digest: narrowest.digest,
    mode,
    intersectedPolicyIds: applicable.map((policy) => policy.id),
  };
  const deny = (reason: string): PolicyDecision => ({ allow: false, reason, ...base });
  if (counters.emergencyStopped) return deny("Emergency stop is active. New autonomous work is refused.");
  if (counters.revoked) return deny("The Owner policy is revoked. Resume requires a new activation.");
  if (counters.paused) return deny("The Owner policy is paused.");
  if (counters.expired || counters.now >= expiresAt) return deny("The Owner policy is expired.");
  if (counters.now >= counters.activatedAt + maxDuration) return deny("The authorized execution duration is exhausted.");
  if ((ALWAYS_DENIED_OPERATIONS as readonly string[]).includes(target.action)) {
    return deny(`${target.action} is denied by the autonomy security boundary.`);
  }
  if (!modeAllows(mode, target.action, { ...narrowest.body, completion: { ...narrowest.body.completion, autoComplete } })) {
    return deny(`${mode} mode does not authorize ${target.action}.`);
  }
  if (!permitted.includes(target.action)) return deny(`Action ${target.action} is outside the intersected Owner policy.`);
  if (target.role && !roles.includes(target.role.toLowerCase())) return deny(`Role ${target.role} is not allowed by every applicable policy.`);
  const providerBlock = isBlockedProvider(target.provider, target.model);
  if (providerBlock && (target.action === "launch_task" || target.action === "run_qc" || target.action === "select_model")) {
    return deny(providerBlock);
  }
  if (target.provider && !providers.includes(target.provider.toLowerCase())) {
    return deny(`Provider ${target.provider} is outside the Owner policy. No fallback was applied.`);
  }
  if (target.model && !models.includes(target.model)) {
    return deny(`Model ${target.model} is outside the Owner policy. No fallback was applied.`);
  }
  if (target.accountId) {
    if (!accounts.includes(target.accountId)) return deny(`Account ${target.accountId} is outside the Owner policy.`);
  } else if (!allowUnscoped && (target.action === "launch_task" || target.action === "select_model" || target.action === "run_qc")) {
    return deny("The policy does not allow an account-less resource.");
  }
  if (!counters.lifecycleAllowed && (target.action === "launch_task" || target.action === "run_qc" || target.action === "request_rework")) {
    return deny(counters.lifecycleReason || "Project lifecycle does not allow a new launch.");
  }
  if (requireCap && (target.action === "launch_task" || target.action === "run_qc" || target.action === "plan_task")) {
    return deny("This policy requires a verified spending cap. Provider billing limits are not enforceable, so automatic execution is refused.");
  }
  if ((target.action === "launch_task" || target.action === "run_qc") &&
      bodies.some(body => body.requireVerifiedQuota) && counters.verifiedQuota !== true) {
    return deny("This policy requires fresh, positive, verified quota for the selected account and model.");
  }
  if ((target.action === "launch_task" || target.action === "run_qc") && counters.launchesUsed >= maxLaunches) {
    return deny("The launch budget for this policy is exhausted.");
  }
  if (target.action === "launch_task" && counters.launchesInFlight >= maxConcurrent) {
    return deny("The concurrency limit for this policy is full.");
  }
  if (target.action === "request_rework" && counters.reworkUsedForTask >= maxRework) {
    return deny("The rework budget for this task is exhausted.");
  }
  if (target.action === "complete_task" && !autoComplete) {
    return deny("Automatic completion is not authorized by every applicable policy.");
  }
  const reason = independentAuthorizationRequired(target.action)
    ? `Policy ${narrowest.id} revision ${narrowest.revision} allows ${target.action}. Independent Owner authorization is still required before it can run.`
    : `Authorized by policy ${narrowest.id} revision ${narrowest.revision}.`;
  return { allow: true, reason, ...base };
}

export interface MemoryCandidateInput {
  taskTitle: string;
  projectPath: string;
  reviewId: string;
  verdict: "PASS" | "CHANGES_REQUESTED" | "BLOCKED" | null;
  summary: string | null;
}

export function buildLowRiskMemoryCandidate(input: MemoryCandidateInput):
  | { ok: true; title: string; content: string; sourceRef: string; projectPath: string }
  | { ok: false; reason: string } {
  if (input.verdict !== "PASS") return { ok: false, reason: "Only a PASS review can produce a low-risk observation." };
  const summary = (input.summary ?? "").trim();
  if (!summary) return { ok: false, reason: "The review has no persisted summary to source." };
  if (!input.reviewId.trim() || !input.projectPath.trim()) return { ok: false, reason: "Source review and project are required." };
  const title = `QC observation: ${input.taskTitle}`.slice(0, 180);
  const content = summary.slice(0, 2000);
  if (containsCredentialMaterial(`${title}\n${content}`)) {
    return { ok: false, reason: "The observation contains credential-like material." };
  }
  return {
    ok: true,
    title,
    content,
    sourceRef: `qc-review:${input.reviewId}`,
    projectPath: input.projectPath,
  };
}

export function missionSummaryFromFacts(input: {
  title: string;
  goal: string;
  policyId: string;
  revision: number;
  tasks: Array<{ title: string; phase: string; column: string | null; verdict: string | null; projectPath: string }>;
  excludedUntouched: string[];
}): string {
  const lines = [
    `Mission “${input.title}” under policy ${input.policyId} revision ${input.revision}.`,
    `Goal: ${input.goal}`,
  ];
  for (const task of input.tasks) {
    lines.push(`- ${task.title} (${task.projectPath}): phase ${task.phase}, column ${task.column ?? "missing"}, QC ${task.verdict ?? "none"}.`);
  }
  const done = input.tasks.filter((task) => task.column === "done" && task.verdict === "PASS").length;
  lines.push(`${done} of ${input.tasks.length} tasks are Done with QC PASS.`);
  if (input.excludedUntouched.length > 0) {
    lines.push(`No work was recorded in excluded projects: ${input.excludedUntouched.join(", ")}.`);
  }
  return lines.join("\n");
}
