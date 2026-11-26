/**
 * FO-INFRA-AUTO01 operations over the cluster registry and FO-DEPLOY records.
 * Remote GitHub dispatch and production execution stay refused.
 */
import { randomUUID } from "node:crypto";
import { lstatSync, realpathSync } from "node:fs";
import type { Database } from "bun:sqlite";
import {
  assessProduction,
  assertGitToken,
  assertWorkflowFile,
  deploymentPlanDigest,
  INFRA_ADAPTERS,
  INFRA_ENVIRONMENTS,
  INFRA_ROLES,
  normalizeSha,
  redactInfraText,
  SYNTHETIC_AUTH_TTL_MS,
  TRUSTED_OWNER_CHANNEL,
  type CiFailedJob,
  type InfraAdapter,
  type InfraEnvironment,
  type InfraHealthConfig,
  type InfraOperationState,
  type InfraRole,
  type InfraServiceRef,
  type InfraSnapshot,
  type ProductionPolicyBody,
} from "../../shared/infra-auto/model.ts";
import {
  evaluateApplicablePolicies,
  type ApplicablePolicy,
  type AutonomyAction,
  type AutonomyPolicyBody,
} from "../../shared/autonomy-policy.ts";
import { branchCommit, buildGitMutationArgs, defaultGitRunner, inspectGit, verifyCommit, type GitRunner } from "./git.ts";
import { checksForSha, discoverLocalWorkflows, type LiveCiPort } from "./ci.ts";

export class InfraAutoError extends Error {
  constructor(message: string, readonly status = 400, readonly code = "invalid") {
    super(message);
    this.name = "InfraAutoError";
  }
}

export type InfraActor = "api" | "owner" | "head" | "agent" | "autonomy";

export interface InfraAutoOptions {
  now?: () => number;
  git?: GitRunner;
  liveCi?: LiveCiPort | null;
}

interface BindingRow {
  id: string;
  cluster_id: string;
  project_path: string;
  role: InfraRole;
  environment: InfraEnvironment;
  environment_label: string;
  source_branch: string;
  workflow_name: string;
  adapter: InfraAdapter;
  services_json: string;
  health_json: string;
  required_checks_json: string;
  depends_on_project_path: string | null;
}

interface PlanRow {
  id: string;
  cluster_id: string;
  project_path: string;
  environment: string;
  environment_label: string;
  repository_path: string;
  branch: string;
  sha: string;
  adapter: string;
  workflow_name: string;
  dependencies_json: string;
  services_json: string;
  health_json: string;
  required_checks_json: string;
  rollback_json: string;
  digest: string;
  state: InfraOperationState;
  failure_reason: string | null;
  created_at: number;
  updated_at: number;
}

const OBSERVATION_BUDGET_MS = 60_000;
const CONFIG_ACTORS = new Set<InfraActor>(["api", "owner"]);

function json<T>(raw: string, fallback: T): T {
  try {
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

function asServices(raw: unknown): InfraServiceRef[] {
  if (!Array.isArray(raw)) throw new InfraAutoError("services must be a list.");
  return raw.map((item) => {
    if (!item || typeof item !== "object") throw new InfraAutoError("Invalid service.");
    const record = item as Record<string, unknown>;
    const name = typeof record.name === "string" ? record.name.trim() : "";
    const kind = record.kind;
    if (!name || name.length > 80 || (kind !== "application" && kind !== "database" && kind !== "worker")) {
      throw new InfraAutoError("Invalid service.");
    }
    return { name, kind };
  });
}

function asHealth(raw: unknown): InfraHealthConfig {
  if (!raw || typeof raw !== "object") throw new InfraAutoError("health is required.");
  const record = raw as Record<string, unknown>;
  const kind = record.kind;
  if (kind !== "simulated" && kind !== "http-insufficient" && kind !== "none") {
    throw new InfraAutoError("Unknown health check kind.");
  }
  const outcome = record.simulatedOutcome;
  if (outcome != null && outcome !== "pass" && outcome !== "fail") throw new InfraAutoError("Invalid simulated health outcome.");
  return { kind, ...(outcome === "pass" || outcome === "fail" ? { simulatedOutcome: outcome } : {}) };
}

function asStringList(raw: unknown, field: string): string[] {
  if (!Array.isArray(raw)) throw new InfraAutoError(`${field} must be a list.`);
  const out: string[] = [];
  for (const item of raw) {
    if (typeof item !== "string" || !item.trim() || item.length > 120) throw new InfraAutoError(`Invalid ${field} entry.`);
    if (!out.includes(item.trim())) out.push(item.trim());
  }
  return out;
}

export class InfraAutoService {
  private readonly now: () => number;
  private readonly git: GitRunner;
  private readonly liveCi: LiveCiPort | null;

  constructor(private readonly db: Database, options: InfraAutoOptions = {}) {
    this.now = options.now ?? Date.now;
    this.git = options.git ?? defaultGitRunner;
    this.liveCi = options.liveCi ?? null;
  }

  channel() {
    return TRUSTED_OWNER_CHANNEL;
  }

  upsertBinding(input: Record<string, unknown>, actor: InfraActor): { id: string } {
    this.requireConfigActor(actor);
    const clusterId = this.requireString(input.clusterId, "clusterId");
    const projectPath = this.registeredRoot(this.requireString(input.projectPath, "projectPath"));
    this.requireMembership(clusterId, projectPath);
    const roleValue = input.role;
    if (typeof roleValue !== "string" || !INFRA_ROLES.includes(roleValue as InfraRole)) throw new InfraAutoError("Unknown infrastructure role.");
    const role = roleValue as InfraRole;
    const environmentValue = input.environment;
    if (typeof environmentValue !== "string" || !INFRA_ENVIRONMENTS.includes(environmentValue as InfraEnvironment)) throw new InfraAutoError("Unknown environment.");
    const environment = environmentValue as InfraEnvironment;
    const environmentLabel = typeof input.environmentLabel === "string" ? input.environmentLabel.trim() : "";
    if (environment === "custom" && !environmentLabel) throw new InfraAutoError("A custom environment needs a label.");
    if (environment !== "custom" && environmentLabel) throw new InfraAutoError("Only a custom environment takes a label.");
    const sourceBranch = assertGitToken(this.requireString(input.sourceBranch, "sourceBranch"), "branch", true);
    const workflowName = assertWorkflowFile(this.requireString(input.workflowName, "workflowName"));
    const adapterValue = input.adapter;
    if (typeof adapterValue !== "string" || !INFRA_ADAPTERS.includes(adapterValue as InfraAdapter)) throw new InfraAutoError("Unknown deployment adapter.");
    const adapter = adapterValue as InfraAdapter;
    const services = asServices(input.services ?? []);
    const health = asHealth(input.health ?? { kind: "none" });
    const requiredChecks = asStringList(input.requiredChecks ?? [], "requiredChecks");
    const dependsOn = input.dependsOnProjectPath == null || input.dependsOnProjectPath === ""
      ? null
      : this.registeredRoot(this.requireString(input.dependsOnProjectPath, "dependsOnProjectPath"));
    if (dependsOn === projectPath) throw new InfraAutoError("A project cannot depend on itself.");
    const now = this.now();
    const existing = this.db.query<{ id: string }, [string, string, string]>(
      "SELECT id FROM infra_bindings WHERE project_path = ? AND environment = ? AND environment_label = ?",
    ).get(projectPath, environment as string, environmentLabel);
    const id = existing?.id ?? randomUUID();
    this.db.run(
      `INSERT INTO infra_bindings (
        id, cluster_id, project_path, role, environment, environment_label, source_branch, workflow_name,
        adapter, services_json, health_json, required_checks_json, depends_on_project_path, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(project_path, environment, environment_label) DO UPDATE SET
        cluster_id = excluded.cluster_id,
        role = excluded.role,
        source_branch = excluded.source_branch,
        workflow_name = excluded.workflow_name,
        adapter = excluded.adapter,
        services_json = excluded.services_json,
        health_json = excluded.health_json,
        required_checks_json = excluded.required_checks_json,
        depends_on_project_path = excluded.depends_on_project_path,
        updated_at = excluded.updated_at`,
      [
        id, clusterId, projectPath, role, environment, environmentLabel, sourceBranch, workflowName, adapter,
        JSON.stringify(services), JSON.stringify(health), JSON.stringify(requiredChecks), dependsOn, now, now,
      ],
    );
    this.log("binding", projectPath, `Saved ${environment} binding for adapter ${adapter}.`);
    return { id };
  }

  saveProductionPolicy(input: Record<string, unknown>, actor: InfraActor): ProductionPolicyBody {
    this.requireConfigActor(actor);
    if (input.executionAuthorized === true || input.capability === true) {
      throw new InfraAutoError("A production policy cannot issue execution capability.", 403, "production-denied");
    }
    const body: ProductionPolicyBody = {
      permittedProjectPaths: asStringList(input.permittedProjectPaths ?? [], "permittedProjectPaths").map((item) => this.registeredRoot(item)),
      permittedEnvironments: asStringList(input.permittedEnvironments ?? [], "permittedEnvironments"),
      allowedBranches: asStringList(input.allowedBranches ?? [], "allowedBranches").map((item) => assertGitToken(item, "branch", true)),
      requiredChecks: asStringList(input.requiredChecks ?? [], "requiredChecks"),
      requireStagingEvidence: input.requireStagingEvidence !== false,
      permittedAdapter: input.permittedAdapter == null ? null : (INFRA_ADAPTERS.includes(input.permittedAdapter as InfraAdapter) ? input.permittedAdapter as InfraAdapter : (() => { throw new InfraAutoError("Unknown adapter."); })()),
      windowStart: typeof input.windowStart === "string" ? input.windowStart : null,
      windowEnd: typeof input.windowEnd === "string" ? input.windowEnd : null,
      maxConcurrent: Number.isInteger(input.maxConcurrent) ? Number(input.maxConcurrent) : 1,
      approvalRequired: true,
      rollbackRule: "prepare-only",
      executionAuthorized: false,
    };
    if (body.maxConcurrent < 1 || body.maxConcurrent > 5) throw new InfraAutoError("maxConcurrent must be 1..5.");
    for (const environment of body.permittedEnvironments) {
      if (!INFRA_ENVIRONMENTS.includes(environment as InfraEnvironment)) throw new InfraAutoError("Unknown production environment.");
    }
    const clusterId = typeof input.clusterId === "string" ? input.clusterId : null;
    const id = clusterId ?? "default";
    this.db.run(
      `INSERT INTO infra_production_policies (id, cluster_id, body_json, updated_at) VALUES (?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET body_json = excluded.body_json, cluster_id = excluded.cluster_id, updated_at = excluded.updated_at`,
      [id, clusterId, JSON.stringify(body), this.now()],
    );
    return body;
  }

  inspectGit(projectPath: string, actor: InfraActor = "api") {
    const root = this.registeredRoot(projectPath);
    if (actor === "autonomy") this.requireAutonomy("git_read", root);
    return inspectGit(root, this.git);
  }

  authorizeGit(input: { projectPath: string; op: "fetch" | "push"; remote: string; branch: string }, actor: InfraActor) {
    this.requireConfigActor(actor);
    this.assertOpen();
    const root = this.registeredRoot(input.projectPath);
    const inspection = inspectGit(root, this.git);
    if (!inspection.head) throw new InfraAutoError("The repository has no commit to bind.");
    const remote = assertGitToken(input.remote, "remote", false);
    const branch = assertGitToken(input.branch, "branch", true);
    if (inspection.branch !== branch) {
      throw new InfraAutoError(`The checked out branch is ${inspection.branch ?? "detached"}. Refusing to switch branches.`);
    }
    const digest = deploymentPlanDigest({
      clusterId: "git",
      projectPath: root,
      environment: "development",
      environmentLabel: input.op,
      repositoryPath: root,
      branch,
      sha: inspection.head,
      adapter: "manual",
      workflowName: "git.yml",
      dependencies: [remote],
      services: [],
      health: { kind: "none" },
      requiredChecks: [],
      rollback: { kind: "prepare-previous-sha", previousSha: null },
    });
    return this.insertAuth({
      kind: "git",
      planId: null,
      digest,
      projectPath: root,
      environment: input.op,
      sha: inspection.head,
    });
  }

  mutateGit(input: { projectPath: string; op: "fetch" | "push"; remote: string; branch: string; authorizationId: string }, actor: InfraActor) {
    this.assertOpen();
    if (this.runtime().paused) throw new InfraAutoError("Infrastructure operations are paused.", 409, "paused");
    const root = this.registeredRoot(input.projectPath);
    if (actor === "autonomy") this.requireAutonomy("git_mutate", root);
    if (actor === "agent" || actor === "head") throw new InfraAutoError("This actor cannot mutate Git.", 403, "actor");
    const inspection = inspectGit(root, this.git);
    const branch = assertGitToken(input.branch, "branch", true);
    if (inspection.branch !== branch) {
      throw new InfraAutoError("Push and fetch stay on the checked out branch. ForgeOrbit will not check out a different branch.");
    }
    const binding = this.bindingFor(root, "staging") ?? this.bindingFor(root, "production") ?? this.bindingFor(root, "development");
    if (binding && binding.source_branch !== branch) {
      throw new InfraAutoError(`The configured branch for this project is ${binding.source_branch}.`);
    }
    const args = buildGitMutationArgs(input.op, input.remote, branch);
    if (args.some((arg) => arg === "--force" || arg === "--delete" || arg.startsWith("+"))) {
      throw new InfraAutoError("Force push and branch deletion are not available.", 403, "destructive");
    }
    const digest = deploymentPlanDigest({
      clusterId: "git",
      projectPath: root,
      environment: "development",
      environmentLabel: input.op,
      repositoryPath: root,
      branch,
      sha: inspection.head ?? "",
      adapter: "manual",
      workflowName: "git.yml",
      dependencies: [assertGitToken(input.remote, "remote", false)],
      services: [],
      health: { kind: "none" },
      requiredChecks: [],
      rollback: { kind: "prepare-previous-sha", previousSha: null },
    });
    const authId = this.consumeAuth(input.authorizationId, { digest, projectPath: root, environment: input.op, sha: inspection.head ?? "" });
    const result = this.git(root, args);
    const detail = redactInfraText(`${args.join(" ")}\n${result.stderr}\n${result.stdout}`, 1_000);
    this.log("git", root, detail);
    if (result.status !== 0) throw new InfraAutoError(detail.split("\n").find((line) => line.trim()) || "Git command failed.", 409, "git");
    return { ok: true as const, args, authorizationId: authId, output: detail };
  }

  discoverWorkflows(projectPath: string) {
    const root = this.registeredRoot(projectPath);
    return discoverLocalWorkflows(root);
  }

  recordCiRun(input: {
    projectPath: string;
    workflowName: string;
    runKey: string;
    sha: string;
    branch?: string;
    status: string;
    conclusion: string | null;
    failedJobs?: unknown;
    logExcerpt?: string;
  }, actor: InfraActor) {
    this.requireConfigActor(actor);
    const root = this.registeredRoot(input.projectPath);
    const sha = normalizeSha(input.sha);
    if (!sha) throw new InfraAutoError("CI records require a 40-character SHA.");
    const workflowName = assertWorkflowFile(input.workflowName);
    const runKey = assertGitToken(input.runKey, "run key", false);
    const id = randomUUID();
    this.db.run(
      `INSERT INTO infra_ci_records (
        id, project_path, workflow_name, run_key, sha, branch, status, conclusion, failed_jobs_json, log_excerpt, source, observed_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'fake', ?)
      ON CONFLICT(project_path, workflow_name, run_key) DO UPDATE SET
        sha = excluded.sha, branch = excluded.branch, status = excluded.status, conclusion = excluded.conclusion,
        failed_jobs_json = excluded.failed_jobs_json, log_excerpt = excluded.log_excerpt, observed_at = excluded.observed_at`,
      [
        id, root, workflowName, runKey, sha, input.branch ?? null, input.status, input.conclusion,
        JSON.stringify(Array.isArray(input.failedJobs) ? input.failedJobs : []), redactInfraText(input.logExcerpt ?? ""), this.now(),
      ],
    );
    return { id, sha };
  }

  async observeLiveCi(projectPath: string): Promise<{ recorded: number; error: string | null }> {
    const root = this.registeredRoot(projectPath);
    if (!this.liveCi) {
      return { recorded: 0, error: "Live GitHub observation is not enabled. No CI result was invented." };
    }
    try {
      const runs = await this.liveCi.listRuns(root);
      let recorded = 0;
      for (const run of runs) {
        const sha = normalizeSha(run.headSha);
        if (!sha) continue;
        const workflowName = `gh${run.id}.yml`;
        this.db.run(
          `INSERT INTO infra_ci_records (
            id, project_path, workflow_name, run_key, sha, branch, status, conclusion, failed_jobs_json, log_excerpt, source, observed_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, '[]', '', 'github', ?)
          ON CONFLICT(project_path, workflow_name, run_key) DO UPDATE SET
            sha = excluded.sha, status = excluded.status, conclusion = excluded.conclusion, observed_at = excluded.observed_at`,
          [randomUUID(), root, workflowName, `gh-${run.id}`, sha, run.headBranch, run.status === "completed" ? "completed" : run.status, run.conclusion, this.now()],
        );
        recorded += 1;
      }
      return { recorded, error: null };
    } catch (error) {
      return { recorded: 0, error: redactInfraText(error instanceof Error ? error.message : "GitHub observation failed.") };
    }
  }

  preparePlan(input: { projectPath: string; environment: InfraEnvironment; sha?: string }, actor: InfraActor): { plan: PlanRow | null; blockers: string[] } {
    this.assertOpen();
    if (actor === "agent") throw new InfraAutoError("An agent cannot prepare a deployment plan.", 403, "actor");
    const root = this.registeredRoot(input.projectPath);
    const binding = this.bindingFor(root, input.environment);
    if (!binding) {
      return { plan: null, blockers: [`No ${input.environment} binding is configured for this project.`] };
    }
    if (actor === "autonomy") {
      if (input.environment === "production") {
        throw new InfraAutoError("Full Autonomy cannot grant production deployment.", 403, "production-denied");
      }
      this.requireAutonomy("staging_deploy", root, binding.cluster_id);
    }
    const blockers: string[] = [];
    let sha: string | null = null;
    let branch = binding.source_branch;
    try {
      const inspection = inspectGit(root, this.git);
      if (inspection.branch !== binding.source_branch) {
        blockers.push(`Checked out branch is ${inspection.branch ?? "detached"}. The configured branch is ${binding.source_branch}. No checkout was performed.`);
      }
      if (inspection.conflicts.length > 0) blockers.push(`Unresolved conflicts: ${inspection.conflicts.join(", ")}.`);
      sha = input.sha ? normalizeSha(input.sha) : branchCommit(root, binding.source_branch, this.git);
      if (input.sha && !sha) blockers.push("The requested SHA is not a 40-character commit id.");
      if (!input.sha && !sha) blockers.push(`Branch ${binding.source_branch} does not resolve to a commit.`);
    } catch (error) {
      blockers.push(error instanceof Error ? error.message : "Git inspection failed.");
    }
    if (!sha || !verifyCommit(root, sha, this.git)) {
      blockers.push("The deployment SHA could not be verified. No plan was frozen.");
      return { plan: null, blockers };
    }
    const records = this.ciRecords(root);
    const required = json<string[]>(binding.required_checks_json, []);
    const ci = checksForSha(records, sha, required);
    blockers.push(...ci.blockers);
    const dependency = this.dependencyBlocker(binding);
    if (dependency) blockers.push(dependency);
    if (this.projectLifecycle(root) === "paused") blockers.push("The project is paused.");
    if (input.environment === "production") {
      blockers.push(...this.productionAssessment(root, binding, sha).reasons);
    }
    const health = json<InfraHealthConfig>(binding.health_json, { kind: "none" });
    const services = json<InfraServiceRef[]>(binding.services_json, []);
    const dependencies = binding.depends_on_project_path ? [binding.depends_on_project_path] : [];
    const previous = this.previousSha(root, input.environment, sha);
    const digestInput = {
      clusterId: binding.cluster_id,
      projectPath: root,
      environment: input.environment,
      environmentLabel: binding.environment_label,
      repositoryPath: root,
      branch,
      sha,
      adapter: binding.adapter,
      workflowName: binding.workflow_name,
      dependencies,
      services,
      health,
      requiredChecks: required,
      rollback: { kind: "prepare-previous-sha" as const, previousSha: previous },
    };
    const digest = deploymentPlanDigest(digestInput);
    const state: InfraOperationState = blockers.length > 0 ? "blocked" : "configuration-verified";
    const now = this.now();
    const id = randomUUID();
    this.db.run(
      `INSERT INTO infra_plans (
        id, cluster_id, project_path, environment, environment_label, repository_path, branch, sha, adapter,
        workflow_name, dependencies_json, services_json, health_json, required_checks_json, rollback_json,
        digest, state, failure_reason, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        id, binding.cluster_id, root, input.environment, binding.environment_label, root, branch, sha, binding.adapter,
        binding.workflow_name, JSON.stringify(dependencies), JSON.stringify(services), JSON.stringify(health),
        JSON.stringify(required), JSON.stringify(digestInput.rollback), digest, state,
        blockers.length ? redactInfraText(blockers.join("\n"), 2_000) : null, now, now,
      ],
    );
    this.log("plan", root, `Prepared ${input.environment} plan ${id} at ${sha} (${state}).`);
    return { plan: this.plan(id), blockers };
  }

  authorizeSynthetic(planId: string, actor: InfraActor) {
    this.requireConfigActor(actor);
    this.assertOpen();
    const plan = this.plan(planId);
    if (plan.environment === "production") {
      throw new InfraAutoError("Production deployment is denied. No capability was issued.", 403, "production-denied");
    }
    if (plan.adapter !== "fake") {
      throw new InfraAutoError(TRUSTED_OWNER_CHANNEL.reason, 403, "owner-channel-unsupported");
    }
    if (plan.state !== "configuration-verified") {
      throw new InfraAutoError(`Plan is ${plan.state} and cannot be authorized.`, 409, "state");
    }
    const digest = this.recompute(plan);
    if (digest !== plan.digest) throw new InfraAutoError("Plan digest mismatch.", 409, "digest");
    const auth = this.insertAuth({ kind: plan.environment === "staging" ? "deployment" : "deployment", planId: plan.id, digest, projectPath: plan.project_path, environment: plan.environment, sha: plan.sha });
    this.db.run("UPDATE infra_plans SET state = 'execution-authorized', updated_at = ? WHERE id = ?", [this.now(), plan.id]);
    return auth;
  }

  revoke(authorizationId: string, actor: InfraActor) {
    this.requireConfigActor(actor);
    const changed = this.db.run(
      "UPDATE infra_authorizations SET revoked_at = ? WHERE id = ? AND consumed_at IS NULL AND revoked_at IS NULL",
      [this.now(), authorizationId],
    ).changes;
    if (changed !== 1) throw new InfraAutoError("Authorization cannot be revoked.", 409, "authorization");
    return { revoked: true };
  }

  dispatch(planId: string, authorizationId: string, actor: InfraActor, options: { defer?: boolean } = {}) {
    this.assertOpen();
    if (this.runtime().paused) throw new InfraAutoError("Infrastructure operations are paused.", 409, "paused");
    const plan = this.plan(planId);
    if (actor === "autonomy") {
      if (plan.environment === "production") {
        throw new InfraAutoError("Full Autonomy cannot grant production deployment.", 403, "production-denied");
      }
      this.requireAutonomy("staging_deploy", plan.project_path, plan.cluster_id);
    }
    if (actor === "agent" || actor === "head") throw new InfraAutoError("This actor cannot dispatch a deployment.", 403, "actor");
    if (plan.environment === "production") {
      throw new InfraAutoError("Production deployment is denied. No capability was issued.", 403, "production-denied");
    }
    if (plan.adapter !== "fake") {
      throw new InfraAutoError(`${TRUSTED_OWNER_CHANNEL.reason} No workflow dispatch was sent.`, 403, "owner-channel-unsupported");
    }
    if (plan.state !== "execution-authorized") throw new InfraAutoError(`Plan is ${plan.state}.`, 409, "state");
    const digest = this.recompute(plan);
    if (digest !== plan.digest) throw new InfraAutoError("The frozen plan no longer matches its digest.", 409, "digest");
    if (!verifyCommit(plan.repository_path, plan.sha, this.git)) {
      throw new InfraAutoError("The frozen SHA is no longer a commit in the repository.", 409, "sha");
    }
    const binding = this.bindingFor(plan.project_path, plan.environment as InfraEnvironment);
    if (binding && (binding.workflow_name !== plan.workflow_name || binding.source_branch !== plan.branch)) {
      throw new InfraAutoError("The configured workflow or branch changed. The frozen plan was not updated.", 409, "frozen");
    }
    const dependency = binding ? this.dependencyBlocker(binding) : "The deployment binding is gone.";
    if (dependency) throw new InfraAutoError(dependency, 409, "dependency");
    if (this.activeAttempt(plan.project_path, plan.environment)) {
      throw new InfraAutoError("A deployment for this project and environment is already active.", 409, "conflict");
    }
    const health = json<InfraHealthConfig>(plan.health_json, { kind: "none" });
    const now = this.now();
    const attemptId = randomUUID();
    let terminal: InfraOperationState = options.defer ? "running" : this.healthState(health);
    let healthResult = options.defer ? "pending" : this.healthLabel(health);
    let failure = options.defer ? null : this.healthFailure(health);
    this.db.transaction(() => {
      this.consumeAuth(authorizationId, { digest, projectPath: plan.project_path, environment: plan.environment, sha: plan.sha });
      this.db.run(
        `INSERT INTO infra_attempts (
          id, plan_id, authorization_id, state, sha, health, provenance, failure_reason, log_excerpt, started_at, finished_at
        ) VALUES (?, ?, ?, ?, ?, ?, 'fake-adapter', ?, '', ?, ?)`,
        [attemptId, plan.id, authorizationId, terminal, plan.sha, healthResult, failure, now, options.defer ? null : now],
      );
      this.db.run("UPDATE infra_plans SET state = ?, failure_reason = ?, updated_at = ? WHERE id = ?", [terminal, failure, now, plan.id]);
    })();
    this.log("dispatch", plan.project_path, `Fake adapter ${terminal} for ${plan.sha}. This is not a remote deployment.`);
    if (terminal === "simulated") this.clearGates(plan.project_path);
    return { attemptId, state: terminal, sha: plan.sha, provenance: "fake-adapter", health: healthResult };
  }

  settle(planId: string) {
    const plan = this.plan(planId);
    const attempt = this.db.query<{ id: string; started_at: number }, [string]>(
      "SELECT id, started_at FROM infra_attempts WHERE plan_id = ? AND state = 'running'",
    ).get(planId);
    if (!attempt) throw new InfraAutoError("No running attempt is recorded.", 409, "state");
    if (this.now() > attempt.started_at + OBSERVATION_BUDGET_MS) {
      this.finishAttempt(plan, attempt.id, "unknown", "unknown", "The observation deadline elapsed. The outcome was not recorded as success.");
      return { state: "unknown" as const };
    }
    const health = json<InfraHealthConfig>(plan.health_json, { kind: "none" });
    const state = this.healthState(health);
    this.finishAttempt(plan, attempt.id, state, this.healthLabel(health), this.healthFailure(health));
    if (state === "simulated") this.clearGates(plan.project_path);
    return { state };
  }

  expireObservations() {
    const rows = this.db.query<{ id: string; plan_id: string; started_at: number }, []>(
      "SELECT id, plan_id, started_at FROM infra_attempts WHERE state = 'running'",
    ).all();
    let expired = 0;
    for (const row of rows) {
      if (this.now() <= row.started_at + OBSERVATION_BUDGET_MS) continue;
      const plan = this.plan(row.plan_id);
      this.finishAttempt(plan, row.id, "unknown", "unknown", "The observation deadline elapsed. The outcome was not recorded as success.");
      expired += 1;
    }
    return { expired };
  }

  prepareRollback(planId: string, actor: InfraActor) {
    this.assertOpen();
    if (actor === "autonomy") {
      const plan = this.plan(planId);
      this.requireAutonomy("rollback_prepare", plan.project_path, plan.cluster_id);
    }
    const plan = this.plan(planId);
    const previous = json<{ previousSha: string | null }>(plan.rollback_json, { previousSha: null }).previousSha;
    if (!previous) {
      return { plan: null, blockers: ["No earlier deployed SHA is recorded. Rollback was not executed."] };
    }
    return this.preparePlan({ projectPath: plan.project_path, environment: plan.environment as InfraEnvironment, sha: previous }, actor === "autonomy" ? "api" : actor);
  }

  manualHandoff(planId: string) {
    const plan = this.plan(planId);
    const project = this.projectRow(plan.project_path);
    const cluster = this.db.query<{ name: string }, [string]>("SELECT name FROM clusters WHERE id = ?").get(plan.cluster_id);
    return {
      schema: "forgeorbit-infra-review-v1",
      reviewOnly: true as const,
      executionAuthorized: false as const,
      action: plan.environment === "production" ? "deploy-production" : "deploy-staging",
      planId: plan.id,
      planDigest: plan.digest,
      generatedAt: this.now(),
      target: {
        clusterId: plan.cluster_id,
        clusterName: cluster?.name ?? plan.cluster_id,
        projectPath: plan.project_path,
        projectName: project?.name ?? plan.project_path,
        environment: plan.environment,
        branch: plan.branch,
        sha: plan.sha,
        adapter: plan.adapter,
        workflowName: plan.workflow_name,
      },
      instructions: "This packet is not authorization and contains no command. Revalidate the target, SHA, and digest on a separate Owner-controlled surface. ForgeOrbit did not dispatch it.",
    };
  }

  setControl(input: { paused?: boolean; cancelled?: boolean }, actor: InfraActor) {
    this.requireConfigActor(actor);
    const current = this.runtime();
    const paused = input.paused ?? current.paused;
    const cancelled = input.cancelled ?? current.cancelled;
    this.db.run(
      `INSERT INTO infra_runtime (id, paused, cancelled, updated_at) VALUES ('global', ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET paused = excluded.paused, cancelled = excluded.cancelled, updated_at = excluded.updated_at`,
      [paused ? 1 : 0, cancelled ? 1 : 0, this.now()],
    );
    if (cancelled) {
      const running = this.db.query<{ id: string; plan_id: string }, []>(
        "SELECT id, plan_id FROM infra_attempts WHERE state = 'running'",
      ).all();
      for (const row of running) {
        this.finishAttempt(this.plan(row.plan_id), row.id, "cancelled", "not-run", "Cancelled before a result was recorded.");
      }
    }
    return { paused, cancelled };
  }

  bindTaskGate(taskId: string, projectPath: string, upstreamProjectPath: string) {
    const project = this.registeredRoot(projectPath);
    const upstream = this.registeredRoot(upstreamProjectPath);
    const reason = `Waiting for a completed staging deployment of ${upstream}. Starting the deployment command is not enough.`;
    this.db.run(
      `INSERT INTO infra_task_gates (task_id, project_path, upstream_project_path, reason, created_at)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(task_id) DO UPDATE SET project_path = excluded.project_path, upstream_project_path = excluded.upstream_project_path, reason = excluded.reason`,
      [taskId, project, upstream, reason, this.now()],
    );
  }

  snapshot(): InfraSnapshot {
    const runtime = this.runtime();
    const clusters = this.db.query<{ id: string; name: string }, []>("SELECT id, name FROM clusters WHERE archived_at IS NULL ORDER BY name").all();
    const plans = this.db.query<PlanRow, []>("SELECT * FROM infra_plans ORDER BY created_at DESC, rowid DESC LIMIT 40").all();
    return {
      channel: TRUSTED_OWNER_CHANNEL,
      paused: runtime.paused,
      cancelled: runtime.cancelled,
      note: "Recorded configuration and local inspection only. Empty server lists are not a live status. Simulated results are not remote deployments.",
      clusters: clusters.map((cluster) => ({
        id: cluster.id,
        name: cluster.name,
        servers: this.servers(cluster.id),
        projects: this.clusterProjects(cluster.id),
      })),
      plans: plans.map((plan) => this.snapshotPlan(plan)),
      dependencies: this.dependencyViews(),
      production: this.productionViews(),
    };
  }

  answer(text: string): string | null {
    const trimmed = text.trim();
    if (!trimmed) return null;
    const lower = trimmed.toLowerCase();
    const infra = /infrastructur|инфраструктур|failing ci|падающ\p{L}* ci|staging deployment|current staging|\bстенд\b|active deployments|активн\p{L}* развертыван|shared infrastructure|общ\p{L}* инфраструктур|ready for production|готов\p{L}* к продакш|rollback|откат|for deployment|к развертыван|deploy the approved|deploy .+ to staging|разверн/iu.test(lower);
    if (!infra) return null;
    const projects = this.db.query<{ path: string; name: string }, []>("SELECT path, name FROM projects").all();
    const clusters = this.db.query<{ id: string; name: string; slug: string | null }, []>("SELECT id, name, slug FROM clusters").all();
    const project = matchNamed(trimmed, projects.map((item) => ({ id: item.path, labels: [item.name] })));
    const cluster = matchNamed(trimmed, clusters.map((item) => ({ id: item.id, labels: [item.name, item.slug ?? ""] })));

    if (/infrastructur|инфраструктур/i.test(lower) && /cluster|кластер/i.test(lower)) {
      if (!cluster) return redactInfraText(`No registered cluster name in that request matches the registry. Nothing was invented.`);
      const view = this.snapshot().clusters.find((item) => item.id === cluster.id);
      if (!view) return "That cluster is not in the registry.";
      const lines = [`Infrastructure registry for ${view.name}.`, "Servers are declarations. Reachability was not checked."];
      if (view.servers.length === 0) lines.push("No servers are recorded. That is not a live server count.");
      for (const server of view.servers) lines.push(`• ${server.name} (${server.resourceType}) — not verified`);
      if (view.projects.length === 0) lines.push("No projects are assigned.");
      for (const item of view.projects) {
        lines.push(`• ${item.name} role ${item.role ?? "unspecified"} branch ${item.gitBranch ?? "unknown"} sha ${item.gitSha ?? "unknown"} CI pass ${item.ciPassing} fail ${item.ciFailing}${item.gitError ? ` git: ${item.gitError}` : ""}`);
      }
      return redactInfraText(lines.join("\n"));
    }

    if (/failing ci|падающ\p{L}* ci/iu.test(lower)) {
      const failing = this.failingProjects();
      if (failing.length === 0) return "No recorded CI run is failing. Missing CI was not treated as a pass.";
      return redactInfraText(failing.map((item) => `${item.name}: ${item.detail}`).join("\n"));
    }

    if (/why did the staging|почему.+(staging|стенд)/iu.test(lower)) {
      const target = project ?? this.onlyProject();
      if (!target) return "Name the project. More than one staging record exists, and none was chosen for you.";
      const latest = this.latestPlan(target.id, "staging");
      if (!latest) return `${this.projectName(target.id)} has no staging deployment record.`;
      return redactInfraText(`${this.projectName(target.id)} staging plan ${latest.id} is ${latest.state} at ${latest.sha}. ${latest.failure_reason ?? "No failure reason is recorded."}`);
    }

    if (/current staging|staging deployment of|текущ\p{L}* стенд/iu.test(lower)) {
      if (!project) return "Name the project. No staging deployment was selected.";
      const latest = this.latestAttempt(project.id, "staging");
      if (!latest) return `${project.name} has no recorded staging deployment.`;
      return redactInfraText(`${project.name} staging record is ${latest.state} at ${latest.sha}. Health: ${latest.health}. Provenance: ${latest.provenance}. This is not inferred server status.`);
    }

    if (/active deployments|активн\p{L}* развертыван/iu.test(lower)) {
      const active = this.db.query<PlanRow, []>(
        "SELECT * FROM infra_plans WHERE state IN ('dispatched', 'running') ORDER BY updated_at DESC",
      ).all();
      if (active.length === 0) return "No deployment is dispatched or running.";
      return redactInfraText(active.map((plan) => `${this.projectName(plan.project_path)} ${plan.environment} ${plan.state} ${plan.sha}`).join("\n"));
    }

    if (/depend|завис\p{L}* от/iu.test(lower) && /shared|общ/iu.test(lower)) {
      const rows = this.dependencyViews();
      if (rows.length === 0) return "No project binding depends on a shared infrastructure repository.";
      return redactInfraText(rows.map((row) => `${row.projectName} depends on ${row.dependsOn}${row.blocked ? ` — blocked: ${row.reason}` : " — upstream staging record is complete"}`).join("\n"));
    }

    if (/ready for production|готов\p{L}* к продакш/iu.test(lower)) {
      if (!project) return "Name the project. Production readiness was not guessed.";
      const binding = this.bindingFor(project.id, "production") ?? this.bindingFor(project.id, "staging");
      const sha = binding ? branchCommit(project.id, binding.source_branch, this.git) : null;
      const assessment = binding ? this.productionAssessment(project.id, binding, sha) : assessProduction({
        policy: null, projectPath: project.id, environment: "production", branch: "unknown", sha: null, checks: [], stagingSha: null, nowMinutes: 0, activeProduction: 0,
      });
      return redactInfraText(`${project.name} is not authorized for production.\n${assessment.reasons.join("\n")}`);
    }

    if (/rollback|откат/iu.test(lower)) {
      const target = project ?? this.onlyProject();
      if (!target) return "Name the project to prepare a rollback. Nothing was executed.";
      const latest = this.latestPlan(target.id, "staging");
      if (!latest) return `${this.projectName(target.id)} has no staging plan to roll back. Nothing was executed.`;
      const prepared = this.prepareRollback(latest.id, "api");
      const proposal = this.propose("rollback", target.id, "staging", prepared.plan?.id ?? null, prepared.blockers.join(" ") || "Rollback plan prepared. It was not executed.");
      return redactInfraText(`Rollback proposal ${proposal}. ${prepared.blockers.join(" ") || `Frozen SHA ${prepared.plan?.sha}. Execution was not started.`}`);
    }

    if (/prepare .+ for deployment|подготов\p{L}*.+к развертыван|deploy the approved|deploy .+ to staging|разверн/iu.test(lower)) {
      const staging = this.stagingTargets();
      const target = project ?? (staging.length === 1 ? staging[0]! : null);
      if (!target) {
        return staging.length === 0
          ? "No staging binding is configured. No deployment was prepared."
          : `Name one project. Staging bindings exist for: ${staging.map((item) => item.name).join(", ")}. No deployment was prepared.`;
      }
      const environment: InfraEnvironment = /production|продакш/i.test(lower) ? "production" : "staging";
      const prepared = this.preparePlan({ projectPath: target.id, environment }, "api");
      const proposal = this.propose(environment === "production" ? "deploy" : "prepare", target.id, environment, prepared.plan?.id ?? null, prepared.blockers.join(" ") || "Plan prepared. Dispatch still needs a separate authorization.");
      const sha = prepared.plan?.sha ?? "unavailable";
      const state = prepared.plan?.state ?? "blocked";
      return redactInfraText([
        `Proposal ${proposal} for ${this.projectName(target.id)} ${environment}.`,
        `State: ${state}. SHA: ${sha}.`,
        prepared.blockers.length ? prepared.blockers.join("\n") : "The plan is frozen. It was not dispatched.",
        TRUSTED_OWNER_CHANNEL.reason,
      ].join("\n"));
    }
    return null;
  }

  private propose(kind: string, projectPath: string, environment: string, planId: string | null, detail: string): string {
    const id = randomUUID();
    this.db.run(
      "INSERT INTO infra_proposals (id, kind, project_path, environment, plan_id, status, detail, created_at) VALUES (?, ?, ?, ?, ?, 'pending', ?, ?)",
      [id, kind, projectPath, environment, planId, redactInfraText(detail, 1_000), this.now()],
    );
    return id;
  }

  private productionAssessment(projectPath: string, binding: BindingRow, sha: string | null) {
    const policy = this.policyFor(binding.cluster_id);
    const checks = this.ciRecords(projectPath).filter((record) => !sha || record.sha === sha).map((record) => ({ name: record.name, conclusion: record.conclusion }));
    const staging = this.latestAttempt(projectPath, "staging");
    const stagingSha = staging && (staging.state === "simulated" || staging.state === "succeeded") && staging.health === "passed" ? staging.sha : null;
    const date = new Date(this.now());
    return assessProduction({
      policy,
      projectPath,
      environment: "production",
      branch: binding.source_branch,
      sha,
      checks,
      stagingSha,
      nowMinutes: date.getUTCHours() * 60 + date.getUTCMinutes(),
      activeProduction: this.db.query<{ count: number }, [string]>(
        "SELECT COUNT(*) AS count FROM infra_plans WHERE project_path = ? AND environment = 'production' AND state IN ('dispatched', 'running')",
      ).get(projectPath)?.count ?? 0,
    });
  }

  private policyFor(clusterId: string): ProductionPolicyBody | null {
    const row = this.db.query<{ body_json: string }, [string]>(
      `SELECT body_json FROM infra_production_policies
       WHERE cluster_id = ? OR id = 'default'
       ORDER BY CASE WHEN id = 'default' THEN 1 ELSE 0 END
       LIMIT 1`,
    ).get(clusterId);
    if (!row) return null;
    const body = json<ProductionPolicyBody | null>(row.body_json, null);
    if (!body) return null;
    return { ...body, executionAuthorized: false, approvalRequired: true, rollbackRule: "prepare-only" };
  }

  private dependencyBlocker(binding: BindingRow): string | null {
    if (!binding.depends_on_project_path) return null;
    const upstream = binding.depends_on_project_path;
    const attempt = this.latestAttempt(upstream, binding.environment);
    if (!attempt) return `Dependency ${upstream} has no completed ${binding.environment} deployment.`;
    if (attempt.state === "running" || attempt.state === "dispatched") {
      return `Dependency ${upstream} is still ${attempt.state}. A started command is not completion.`;
    }
    if (attempt.state === "failed" || attempt.health === "failed") {
      return `Dependency ${upstream} failed. Dependents stay blocked.`;
    }
    if (attempt.state !== "simulated" && attempt.state !== "succeeded") {
      return `Dependency ${upstream} is ${attempt.state}, so the dependent deployment is blocked.`;
    }
    if (attempt.health !== "passed") return `Dependency ${upstream} has no passing health check.`;
    return null;
  }

  private previousSha(projectPath: string, environment: string, current: string): string | null {
    const row = this.db.query<{ sha: string }, [string, string, string]>(
      `SELECT a.sha FROM infra_attempts a
       JOIN infra_plans p ON p.id = a.plan_id
       WHERE p.project_path = ? AND p.environment = ? AND a.sha != ?
         AND a.state IN ('simulated', 'succeeded') AND a.health = 'passed'
       ORDER BY a.finished_at DESC, a.rowid DESC LIMIT 1`,
    ).get(projectPath, environment, current);
    return row?.sha ?? null;
  }

  private healthState(health: InfraHealthConfig): InfraOperationState {
    if (health.kind === "simulated" && health.simulatedOutcome === "pass") return "simulated";
    if (health.kind === "simulated" && health.simulatedOutcome === "fail") return "failed";
    if (health.kind === "http-insufficient") return "unknown";
    return "blocked";
  }

  private healthLabel(health: InfraHealthConfig): string {
    if (health.kind === "simulated") return health.simulatedOutcome === "pass" ? "passed" : "failed";
    if (health.kind === "http-insufficient") return "unknown";
    return "not-run";
  }

  private healthFailure(health: InfraHealthConfig): string | null {
    if (health.kind === "simulated" && health.simulatedOutcome === "fail") return "The configured health check failed. The deployment was not marked successful.";
    if (health.kind === "http-insufficient") return "An HTTP response alone is not application health. The outcome is unknown.";
    if (health.kind === "none") return "No health check is configured. The deployment was not marked successful.";
    return null;
  }

  private finishAttempt(plan: PlanRow, attemptId: string, state: InfraOperationState, health: string, failure: string | null) {
    const now = this.now();
    this.db.run(
      "UPDATE infra_attempts SET state = ?, health = ?, failure_reason = ?, finished_at = ? WHERE id = ?",
      [state, health, failure, now, attemptId],
    );
    this.db.run("UPDATE infra_plans SET state = ?, failure_reason = ?, updated_at = ? WHERE id = ?", [state, failure, now, plan.id]);
  }

  private clearGates(upstream: string) {
    this.db.run("DELETE FROM infra_task_gates WHERE upstream_project_path = ?", [upstream]);
  }

  private activeAttempt(projectPath: string, environment: string): boolean {
    const row = this.db.query<{ count: number }, [string, string]>(
      `SELECT COUNT(*) AS count FROM infra_attempts a
       JOIN infra_plans p ON p.id = a.plan_id
       WHERE p.project_path = ? AND p.environment = ? AND a.state IN ('dispatched', 'running')`,
    ).get(projectPath, environment);
    return (row?.count ?? 0) > 0;
  }

  private insertAuth(input: { kind: string; planId: string | null; digest: string; projectPath: string; environment: string; sha: string }) {
    const now = this.now();
    const id = randomUUID();
    const nonce = randomUUID();
    this.db.run(
      `INSERT INTO infra_authorizations (
        id, kind, plan_id, digest, project_path, environment, sha, channel, issued_at, expires_at, nonce
      ) VALUES (?, ?, ?, ?, ?, ?, ?, 'synthetic', ?, ?, ?)`,
      [id, input.kind, input.planId, input.digest, input.projectPath, input.environment, input.sha, now, now + SYNTHETIC_AUTH_TTL_MS, nonce],
    );
    return { id, nonce, expiresAt: now + SYNTHETIC_AUTH_TTL_MS, channel: "synthetic" as const };
  }

  private consumeAuth(id: string, expected: { digest: string; projectPath: string; environment: string; sha: string }) {
    const now = this.now();
    const changed = this.db.run(
      `UPDATE infra_authorizations
       SET consumed_at = ?
       WHERE id = ? AND consumed_at IS NULL AND revoked_at IS NULL AND expires_at > ?
         AND digest = ? AND project_path = ? AND environment = ? AND sha = ? AND channel = 'synthetic'`,
      [now, id, now, expected.digest, expected.projectPath, expected.environment, expected.sha],
    ).changes;
    if (changed !== 1) throw new InfraAutoError("Authorization is missing, expired, revoked, already used, or bound to a different plan.", 403, "authorization");
    return id;
  }

  private recompute(plan: PlanRow): string {
    return deploymentPlanDigest({
      clusterId: plan.cluster_id,
      projectPath: plan.project_path,
      environment: plan.environment as InfraEnvironment,
      environmentLabel: plan.environment_label,
      repositoryPath: plan.repository_path,
      branch: plan.branch,
      sha: plan.sha,
      adapter: plan.adapter as InfraAdapter,
      workflowName: plan.workflow_name,
      dependencies: json<string[]>(plan.dependencies_json, []),
      services: json<InfraServiceRef[]>(plan.services_json, []),
      health: json<InfraHealthConfig>(plan.health_json, { kind: "none" }),
      requiredChecks: json<string[]>(plan.required_checks_json, []),
      rollback: json(plan.rollback_json, { kind: "prepare-previous-sha" as const, previousSha: null }),
    });
  }

  private requireAutonomy(action: AutonomyAction, projectPath: string, clusterId?: string) {
    const rows = this.db.query<{
      id: string; revision: number; digest: string; body_json: string; status: string; expires_at: number; activated_at: number;
    }, []>(
      `SELECT p.id, p.revision, p.digest, p.body_json, a.status, a.expires_at, a.activated_at
       FROM autonomy_activations a
       JOIN autonomy_policies p ON p.id = a.policy_id AND p.revision = a.revision
       WHERE a.status IN ('active', 'paused', 'revoked', 'expired')`,
    ).all();
    const policies: ApplicablePolicy[] = [];
    for (const row of rows) {
      try {
        policies.push({ id: row.id, revision: row.revision, digest: row.digest, body: JSON.parse(row.body_json) as AutonomyPolicyBody });
      } catch {
        continue;
      }
    }
    const emergency = this.db.query<{ active: number }, []>("SELECT active FROM autonomy_emergency WHERE id = 'global'").get();
    const activation = rows.find((row) => row.status === "active") ?? rows[0];
    const paused = rows.some((row) => row.status === "paused");
    const decision = evaluateApplicablePolicies(policies, {
      action,
      projectPath,
      clusterId: clusterId ?? null,
    }, {
      launchesUsed: 0,
      launchesInFlight: 0,
      reworkUsedForTask: 0,
      now: this.now(),
      activatedAt: activation?.activated_at ?? this.now(),
      lifecycleAllowed: !["paused", "draining", "invalid"].includes(this.projectLifecycle(projectPath) ?? ""),
      emergencyStopped: emergency?.active === 1,
      paused,
      revoked: activation?.status === "revoked",
      expired: activation ? this.now() >= activation.expires_at : false,
    });
    if (!decision.allow) throw new InfraAutoError(decision.reason, 403, "autonomy");
  }

  private ciRecords(projectPath: string) {
    return this.db.query<{
      workflow_name: string; sha: string; status: string; conclusion: string | null; failed_jobs_json: string; log_excerpt: string;
    }, [string]>(
      "SELECT workflow_name, sha, status, conclusion, failed_jobs_json, log_excerpt FROM infra_ci_records WHERE project_path = ? ORDER BY observed_at ASC",
    ).all(projectPath).map((row) => ({
      name: row.workflow_name,
      sha: row.sha,
      status: row.status,
      conclusion: row.conclusion,
      failedJobs: json<CiFailedJob[]>(row.failed_jobs_json, []),
      logExcerpt: row.log_excerpt,
    }));
  }

  private failingProjects(): Array<{ name: string; detail: string }> {
    const rows = this.db.query<{ project_path: string; workflow_name: string; sha: string; conclusion: string | null; log_excerpt: string }, []>(
      "SELECT project_path, workflow_name, sha, conclusion, log_excerpt FROM infra_ci_records WHERE conclusion = 'failure' ORDER BY observed_at DESC",
    ).all();
    return rows.map((row) => ({
      name: this.projectName(row.project_path),
      detail: `${row.workflow_name} failed at ${row.sha}. ${row.log_excerpt}`.trim(),
    }));
  }

  private servers(clusterId: string) {
    return this.db.query<{ id: string; name: string; resource_type: string }, [string]>(
      `SELECT r.id, r.name, r.resource_type
       FROM infrastructure_resources r
       JOIN infrastructure_cluster_links l ON l.resource_id = r.id
       WHERE l.cluster_id = ? AND r.archived_at IS NULL
         AND r.resource_type IN ('vps', 'database', 'deployment-environment', 'cicd')
       ORDER BY r.name`,
    ).all(clusterId).map((row) => ({ id: row.id, name: row.name, resourceType: row.resource_type, status: "not-verified" as const }));
  }

  private clusterProjects(clusterId: string) {
    const rows = this.db.query<{ path: string; name: string }, [string]>(
      `SELECT p.path, p.name FROM projects p
       JOIN cluster_project_memberships m ON m.project_path = p.path
       WHERE m.cluster_id = ? ORDER BY p.name`,
    ).all(clusterId);
    return rows.map((row) => {
      const binding = this.db.query<{ role: string }, [string]>(
        "SELECT role FROM infra_bindings WHERE project_path = ? ORDER BY updated_at DESC LIMIT 1",
      ).get(row.path);
      let gitBranch: string | null = null;
      let gitSha: string | null = null;
      let gitError: string | null = null;
      try {
        const git = inspectGit(row.path, this.git);
        gitBranch = git.branch;
        gitSha = git.head;
      } catch (error) {
        gitError = error instanceof Error ? error.message : "Git inspection failed.";
      }
      const ci = this.ciRecords(row.path);
      return {
        path: row.path,
        name: row.name,
        role: binding?.role ?? null,
        gitBranch,
        gitSha,
        gitError,
        ciFailing: ci.filter((item) => item.conclusion === "failure").length,
        ciPassing: ci.filter((item) => item.conclusion === "success").length,
      };
    });
  }

  private dependencyViews() {
    const rows = this.db.query<BindingRow, []>(
      "SELECT * FROM infra_bindings WHERE depends_on_project_path IS NOT NULL",
    ).all();
    return rows.map((row) => {
      const reason = this.dependencyBlocker(row);
      return {
        projectName: this.projectName(row.project_path),
        dependsOn: this.projectName(row.depends_on_project_path ?? ""),
        blocked: reason != null,
        reason: reason ?? "Upstream staging health passed.",
      };
    });
  }

  private productionViews() {
    const projects = this.db.query<{ path: string; name: string }, []>("SELECT path, name FROM projects").all();
    return projects.map((project) => {
      const binding = this.bindingFor(project.path, "production");
      if (!binding) {
        return { projectName: project.name, ready: false as const, executionAuthorized: false as const, reasons: ["No production binding is configured."] };
      }
      const sha = branchCommit(project.path, binding.source_branch, this.git);
      const assessment = this.productionAssessment(project.path, binding, sha);
      return { projectName: project.name, ready: false as const, executionAuthorized: false as const, reasons: assessment.reasons };
    });
  }

  private snapshotPlan(plan: PlanRow): InfraSnapshot["plans"][number] {
    const auth = this.db.query<{ consumed_at: number | null; revoked_at: number | null; expires_at: number }, [string]>(
      "SELECT consumed_at, revoked_at, expires_at FROM infra_authorizations WHERE plan_id = ? ORDER BY issued_at DESC LIMIT 1",
    ).get(plan.id);
    const attempt = this.db.query<{ provenance: string; health: string }, [string]>(
      "SELECT provenance, health FROM infra_attempts WHERE plan_id = ?",
    ).get(plan.id);
    let authorization: InfraSnapshot["plans"][number]["authorization"] = "none";
    if (auth?.revoked_at) authorization = "synthetic-revoked";
    else if (auth?.consumed_at) authorization = "synthetic-consumed";
    else if (auth && auth.expires_at <= this.now()) authorization = "synthetic-expired";
    else if (auth) authorization = "synthetic-open";
    return {
      id: plan.id,
      projectPath: plan.project_path,
      projectName: this.projectName(plan.project_path),
      clusterName: this.db.query<{ name: string }, [string]>("SELECT name FROM clusters WHERE id = ?").get(plan.cluster_id)?.name ?? plan.cluster_id,
      environment: plan.environment,
      branch: plan.branch,
      sha: plan.sha,
      adapter: plan.adapter,
      state: plan.state,
      authorization,
      health: attempt?.health ?? "not-run",
      failure: plan.failure_reason,
      provenance: attempt?.provenance ?? "plan",
    };
  }

  private latestPlan(projectPath: string, environment: string): PlanRow | null {
    return this.db.query<PlanRow, [string, string]>(
      "SELECT * FROM infra_plans WHERE project_path = ? AND environment = ? ORDER BY created_at DESC, rowid DESC LIMIT 1",
    ).get(projectPath, environment) ?? null;
  }

  private latestAttempt(projectPath: string, environment: string) {
    return this.db.query<{ state: string; sha: string; health: string; provenance: string }, [string, string]>(
      `SELECT a.state, a.sha, a.health, a.provenance
       FROM infra_attempts a JOIN infra_plans p ON p.id = a.plan_id
       WHERE p.project_path = ? AND p.environment = ?
       ORDER BY a.started_at DESC, a.rowid DESC LIMIT 1`,
    ).get(projectPath, environment) ?? null;
  }

  private plan(id: string): PlanRow {
    const row = this.db.query<PlanRow, [string]>("SELECT * FROM infra_plans WHERE id = ?").get(id);
    if (!row) throw new InfraAutoError("Deployment plan not found.", 404, "not-found");
    return row;
  }

  private bindingFor(projectPath: string, environment: InfraEnvironment): BindingRow | null {
    return this.db.query<BindingRow, [string, string]>(
      "SELECT * FROM infra_bindings WHERE project_path = ? AND environment = ? ORDER BY updated_at DESC, rowid DESC LIMIT 1",
    ).get(projectPath, environment) ?? null;
  }

  private registeredRoot(projectPath: string): string {
    if (typeof projectPath !== "string" || !projectPath.startsWith("/") || projectPath.includes("\0")) {
      throw new InfraAutoError("Repository is not a registered project workspace.", 403, "path");
    }
    let real: string;
    try {
      if (!lstatSync(projectPath).isDirectory()) throw new Error("missing");
      real = realpathSync(projectPath);
    } catch {
      throw new InfraAutoError("Repository path is not a directory.", 404, "path");
    }
    const rows = this.db.query<{ path: string }, []>("SELECT path FROM projects").all();
    const match = rows.some((row) => {
      try {
        return realpathSync(row.path) === real;
      } catch {
        return false;
      }
    });
    if (!match) throw new InfraAutoError("Repository is not a registered project workspace.", 403, "path");
    return real;
  }

  private requireMembership(clusterId: string, projectPath: string) {
    const cluster = this.db.query<{ id: string }, [string]>("SELECT id FROM clusters WHERE id = ? AND archived_at IS NULL").get(clusterId);
    if (!cluster) throw new InfraAutoError("Cluster is not in the registry.", 404, "cluster");
    const member = this.db.query<{ project_path: string }, [string, string]>(
      "SELECT project_path FROM cluster_project_memberships WHERE cluster_id = ? AND project_path = ?",
    ).get(clusterId, projectPath);
    if (!member) throw new InfraAutoError("The project is not a member of that cluster.", 409, "membership");
  }

  private projectLifecycle(projectPath: string): string | null {
    return this.db.query<{ lifecycle_state: string }, [string]>("SELECT lifecycle_state FROM projects WHERE path = ?").get(projectPath)?.lifecycle_state ?? null;
  }

  private projectRow(projectPath: string) {
    return this.db.query<{ name: string }, [string]>("SELECT name FROM projects WHERE path = ?").get(projectPath) ?? null;
  }

  private projectName(projectPath: string): string {
    return this.projectRow(projectPath)?.name ?? projectPath;
  }

  private stagingTargets(): Array<{ id: string; name: string }> {
    const rows = this.db.query<{ project_path: string }, []>(
      "SELECT DISTINCT project_path FROM infra_bindings WHERE environment = 'staging'",
    ).all();
    return rows.map((row) => ({ id: row.project_path, name: this.projectName(row.project_path) }));
  }

  private onlyProject(): { id: string; name: string } | null {
    const rows = this.db.query<{ path: string; name: string }, []>("SELECT path, name FROM projects").all();
    if (rows.length !== 1) return null;
    return { id: rows[0]!.path, name: rows[0]!.name };
  }

  private runtime() {
    const row = this.db.query<{ paused: number; cancelled: number }, []>(
      "SELECT paused, cancelled FROM infra_runtime WHERE id = 'global'",
    ).get();
    return { paused: row?.paused === 1, cancelled: row?.cancelled === 1 };
  }

  private assertOpen() {
    if (this.runtime().cancelled) throw new InfraAutoError("Infrastructure operations are cancelled.", 409, "cancelled");
  }

  private requireConfigActor(actor: InfraActor) {
    if (!CONFIG_ACTORS.has(actor)) throw new InfraAutoError("This actor cannot change infrastructure configuration.", 403, "actor");
  }

  private requireString(value: unknown, field: string): string {
    if (typeof value !== "string" || !value.trim()) throw new InfraAutoError(`${field} is required.`);
    return value.trim();
  }

  private log(kind: string, projectPath: string | null, detail: string) {
    this.db.run(
      "INSERT INTO infra_operation_log (kind, project_path, detail, created_at) VALUES (?, ?, ?, ?)",
      [kind, projectPath, redactInfraText(detail, 1_000), this.now()],
    );
  }
}

function matchNamed(text: string, items: Array<{ id: string; labels: string[] }>): { id: string; name: string } | null {
  const haystack = text.toLowerCase();
  const candidates = items.flatMap((item) => item.labels.map((label) => ({ id: item.id, name: label.trim() })));
  candidates.sort((a, b) => b.name.length - a.name.length);
  for (const item of candidates) {
    const name = item.name.toLowerCase();
    if (name.length < 3) continue;
    if (haystack.includes(name)) return item;
  }
  return null;
}
