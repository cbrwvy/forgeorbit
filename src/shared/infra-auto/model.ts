/**
 * FO-INFRA-AUTO01 shared contracts.
 *
 * Plans, CI facts, and operation states. No process execution and no secrets.
 */
import { createHash } from "node:crypto";
import { sanitizeDeploymentLog } from "../deployment-request/log-sanitize.ts";

export const INFRA_OPERATION_STATES = [
  "simulated",
  "configuration-verified",
  "execution-authorized",
  "dispatched",
  "running",
  "failed",
  "succeeded",
  "blocked",
  "unknown",
  "cancelled",
] as const;
export type InfraOperationState = (typeof INFRA_OPERATION_STATES)[number];

export const INFRA_ENVIRONMENTS = ["development", "staging", "production", "custom"] as const;
export type InfraEnvironment = (typeof INFRA_ENVIRONMENTS)[number];

export const INFRA_ADAPTERS = ["fake", "github-actions", "manual"] as const;
export type InfraAdapter = (typeof INFRA_ADAPTERS)[number];

export const INFRA_ROLES = ["application", "shared-infrastructure", "database", "worker"] as const;
export type InfraRole = (typeof INFRA_ROLES)[number];

export const TRUSTED_OWNER_CHANNEL = {
  available: false as const,
  method: "unavailable" as const,
  result: "unsupported" as const,
  executionReady: false as const,
  reason:
    "Trusted Owner confirmation is unsupported. Electrobun RPC authenticates a webview key, not a person. No LocalAuthentication or Secure Enclave signing path is installed. A bearer token, a chat message, or a confirmation dialog cannot authorize remote execution. Review the manual handoff outside ForgeOrbit.",
};

export const SYNTHETIC_AUTH_TTL_MS = 5 * 60_000;

const SHA_RE = /^[0-9a-f]{40}$/;

export function normalizeSha(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const sha = value.trim().toLowerCase();
  return SHA_RE.test(sha) ? sha : null;
}

export function assertGitToken(value: string, label: string, slashes: boolean): string {
  const pattern = slashes
    ? /^[A-Za-z0-9][A-Za-z0-9._/-]{0,127}$/
    : /^[A-Za-z0-9][A-Za-z0-9._-]{0,64}$/;
  if (
    !pattern.test(value) ||
    value.includes("..") ||
    value.includes("@") ||
    value.includes(":") ||
    value.includes("\\") ||
    value.startsWith("-") ||
    value.endsWith("/") ||
    value.includes("//")
  ) {
    throw new Error(`Invalid ${label}.`);
  }
  return value;
}

export function assertWorkflowFile(value: string): string {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,80}\.ya?ml$/.test(value)) {
    throw new Error("Workflow name must be a configured workflow file name.");
  }
  return value;
}

export function redactInfraText(text: string, maxChars = 4_000): string {
  const stripped = text
    .replace(/\bghp_[A-Za-z0-9_]+\b/g, "[redacted]")
    .replace(/\bgithub_pat_[A-Za-z0-9_]+\b/g, "[redacted]")
    .replace(/\bAKIA[0-9A-Z]{16}\b/g, "[redacted]")
    .replace(/\bsk-[A-Za-z0-9]{8,}\b/g, "[redacted]");
  return sanitizeDeploymentLog(stripped, maxChars);
}

export interface InfraServiceRef {
  name: string;
  kind: "application" | "database" | "worker";
}

export interface InfraHealthConfig {
  kind: "simulated" | "http-insufficient" | "none";
  simulatedOutcome?: "pass" | "fail";
}

export interface InfraPlanDigestInput {
  clusterId: string;
  projectPath: string;
  environment: InfraEnvironment;
  environmentLabel: string;
  repositoryPath: string;
  branch: string;
  sha: string;
  adapter: InfraAdapter;
  workflowName: string;
  dependencies: string[];
  services: InfraServiceRef[];
  health: InfraHealthConfig;
  requiredChecks: string[];
  rollback: { kind: "prepare-previous-sha"; previousSha: string | null };
}

export function deploymentPlanDigest(plan: InfraPlanDigestInput): string {
  return createHash("sha256").update(JSON.stringify({
    v: 1,
    clusterId: plan.clusterId,
    projectPath: plan.projectPath,
    environment: plan.environment,
    environmentLabel: plan.environmentLabel,
    repositoryPath: plan.repositoryPath,
    branch: plan.branch,
    sha: plan.sha,
    adapter: plan.adapter,
    workflowName: plan.workflowName,
    dependencies: [...plan.dependencies].sort(),
    services: plan.services.map((service) => `${service.kind}:${service.name}`).sort(),
    health: {
      kind: plan.health.kind,
      simulatedOutcome: plan.health.simulatedOutcome ?? null,
    },
    requiredChecks: [...plan.requiredChecks].sort(),
    rollback: plan.rollback,
  })).digest("hex");
}

export interface ProductionPolicyBody {
  permittedProjectPaths: string[];
  permittedEnvironments: string[];
  allowedBranches: string[];
  requiredChecks: string[];
  requireStagingEvidence: boolean;
  permittedAdapter: InfraAdapter | null;
  windowStart: string | null;
  windowEnd: string | null;
  maxConcurrent: number;
  approvalRequired: true;
  rollbackRule: "prepare-only";
  executionAuthorized: false;
}

export interface ProductionAssessment {
  ready: false;
  executionAuthorized: false;
  reasons: string[];
}

function minutesOf(clock: string): number | null {
  const match = /^([01]\d|2[0-3]):([0-5]\d)$/.exec(clock);
  if (!match) return null;
  return Number(match[1]) * 60 + Number(match[2]);
}

export function assessProduction(input: {
  policy: ProductionPolicyBody | null;
  projectPath: string;
  environment: string;
  branch: string;
  sha: string | null;
  checks: Array<{ name: string; conclusion: string | null }>;
  stagingSha: string | null;
  nowMinutes: number;
  activeProduction: number;
}): ProductionAssessment {
  const reasons: string[] = [];
  const policy = input.policy;
  if (!policy) {
    reasons.push("No production policy is configured. Production deployment is denied by default.");
  } else {
    if (!policy.permittedProjectPaths.includes(input.projectPath)) {
      reasons.push("This project is not in the production allowlist.");
    }
    if (!policy.permittedEnvironments.includes(input.environment)) {
      reasons.push(`Environment ${input.environment} is not a permitted production environment.`);
    }
    if (!policy.allowedBranches.includes(input.branch)) {
      reasons.push(`Branch ${input.branch} is not an allowed production branch.`);
    }
    if (policy.permittedAdapter && policy.permittedAdapter !== "manual" && policy.permittedAdapter !== "github-actions" && policy.permittedAdapter !== "fake") {
      reasons.push("The production adapter is not permitted.");
    }
    for (const check of policy.requiredChecks) {
      const found = input.checks.find((item) => item.name === check);
      if (!found) reasons.push(`Required CI check ${check} is not recorded for this SHA.`);
      else if (found.conclusion !== "success") reasons.push(`Required CI check ${check} is ${found.conclusion ?? "unfinished"}.`);
    }
    if (policy.requireStagingEvidence) {
      if (!input.stagingSha) reasons.push("No staging deployment evidence is recorded.");
      else if (input.sha && input.stagingSha !== input.sha) {
        reasons.push("Staging evidence is for a different SHA.");
      }
    }
    const start = policy.windowStart ? minutesOf(policy.windowStart) : null;
    const end = policy.windowEnd ? minutesOf(policy.windowEnd) : null;
    if (policy.windowStart && start == null) reasons.push("The production window start is invalid.");
    if (policy.windowEnd && end == null) reasons.push("The production window end is invalid.");
    if (start != null && end != null && (input.nowMinutes < start || input.nowMinutes > end)) {
      reasons.push("The current time is outside the production window.");
    }
    if (input.activeProduction >= policy.maxConcurrent) {
      reasons.push("The maximum number of concurrent production deployments is already in use.");
    }
  }
  reasons.push("Production execution capability has not been issued. A Full Autonomy policy cannot grant it, and the trusted Owner channel is unavailable.");
  return { ready: false, executionAuthorized: false, reasons };
}

export interface CiFailedJob {
  name: string;
  conclusion: string;
  failedSteps: string[];
}

export function parseWorkflowJobs(payload: unknown): CiFailedJob[] {
  const jobs = payload && typeof payload === "object" && Array.isArray((payload as { jobs?: unknown }).jobs)
    ? (payload as { jobs: unknown[] }).jobs
    : [];
  const failed: CiFailedJob[] = [];
  for (const job of jobs) {
    if (!job || typeof job !== "object") continue;
    const record = job as Record<string, unknown>;
    const conclusion = typeof record.conclusion === "string" ? record.conclusion : "";
    if (conclusion !== "failure" && conclusion !== "timed_out" && conclusion !== "cancelled") continue;
    const steps = Array.isArray(record.steps) ? record.steps : [];
    const failedSteps = steps.flatMap((step) => {
      if (!step || typeof step !== "object") return [];
      const item = step as Record<string, unknown>;
      if (item.conclusion !== "failure") return [];
      return [typeof item.name === "string" ? redactInfraText(item.name, 160) : "unnamed step"];
    });
    failed.push({
      name: typeof record.name === "string" ? redactInfraText(record.name, 160) : "unnamed job",
      conclusion,
      failedSteps,
    });
  }
  return failed;
}

export interface GitInspection {
  path: string;
  branch: string | null;
  head: string | null;
  upstream: string | null;
  ahead: number | null;
  behind: number | null;
  dirty: boolean;
  changedFiles: string[];
  conflicts: string[];
  recentCommits: Array<{ sha: string; subject: string }>;
  diffStat: string;
  detached: boolean;
  fetchReady: { ready: boolean; reason: string };
  pushReady: { ready: boolean; reason: string };
}

export interface InfraSnapshotPlan {
  id: string;
  projectPath: string;
  projectName: string;
  clusterName: string;
  environment: string;
  branch: string;
  sha: string;
  adapter: string;
  state: InfraOperationState;
  authorization: "none" | "synthetic-open" | "synthetic-consumed" | "synthetic-revoked" | "synthetic-expired";
  health: string;
  failure: string | null;
  provenance: string;
}

export interface InfraSnapshot {
  channel: typeof TRUSTED_OWNER_CHANNEL;
  paused: boolean;
  cancelled: boolean;
  note: string;
  clusters: Array<{
    id: string;
    name: string;
    servers: Array<{ id: string; name: string; resourceType: string; status: "not-verified" }>;
    projects: Array<{
      path: string;
      name: string;
      role: string | null;
      gitBranch: string | null;
      gitSha: string | null;
      gitError: string | null;
      ciFailing: number;
      ciPassing: number;
    }>;
  }>;
  plans: InfraSnapshotPlan[];
  dependencies: Array<{ projectName: string; dependsOn: string; blocked: boolean; reason: string }>;
  production: Array<{ projectName: string; ready: false; executionAuthorized: false; reasons: string[] }>;
}
