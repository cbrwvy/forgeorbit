import { afterAll, beforeAll, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { realpathSync } from "node:fs";
import { ClusterCore } from "../cluster-core.ts";
import { migrate } from "../migrate.ts";
import { migrations } from "../migrations/index.ts";
import { DeploymentRequestCore } from "../deployment-request-core.ts";
import { InfraAutoService } from "./service.ts";
import { deploymentGateForTask } from "./gate.ts";
import { buildGitMutationArgs, type GitRunner } from "./git.ts";
import { infraAutoHttp } from "./http.ts";
import { parseWorkflowJobs } from "../../shared/infra-auto/model.ts";
import { normalizePolicyBody, policyDigest, evaluateApplicablePolicies, independentAuthorizationRequired } from "../../shared/autonomy-policy.ts";

const root = realpathSync(mkdtempSync(path.join(tmpdir(), "fo-infra-auto01-")));
const dirs = {
  shared: path.join(root, "shared"),
  health: path.join(root, "health"),
  dependent: path.join(root, "dependent"),
  other: path.join(root, "other"),
};

let db: Database;
let service: InfraAutoService;
let now = 1_700_000_000_000;
let northId = "";
let southId = "";
const shas = { shared: "", health: "", dependent: "", other: "" };

function git(cwd: string, args: string[]) {
  const proc = spawnSync("git", ["-c", "user.email=test@example.invalid", "-c", "user.name=Infra Test", ...args], {
    cwd,
    encoding: "utf8",
  });
  if (proc.status !== 0) throw new Error(`${args.join(" ")}\n${proc.stderr || proc.stdout}`);
  return (proc.stdout ?? "").trim();
}

function makeRepo(dir: string, readme: string): string {
  mkdirSync(path.join(dir, ".github", "workflows"), { recursive: true });
  writeFileSync(path.join(dir, ".github", "workflows", "ci.yml"), `name: CI\n# token=ghp_supersecret\n`);
  writeFileSync(path.join(dir, ".github", "workflows", "deploy.yml"), "name: Deploy\n");
  writeFileSync(path.join(dir, "README.md"), readme);
  git(dir, ["init", "-b", "develop"]);
  git(dir, ["add", "."]);
  git(dir, ["commit", "-m", "init"]);
  return git(dir, ["rev-parse", "HEAD"]);
}

function binding(projectPath: string, clusterId: string, extras: Record<string, unknown> = {}) {
  service.upsertBinding({
    clusterId,
    projectPath,
    role: extras.role ?? "application",
    environment: extras.environment ?? "staging",
    sourceBranch: "develop",
    workflowName: "ci.yml",
    adapter: extras.adapter ?? "fake",
    services: [{ name: "web", kind: "application" }],
    health: extras.health ?? { kind: "simulated", simulatedOutcome: "pass" },
    requiredChecks: ["ci.yml"],
    dependsOnProjectPath: extras.dependsOnProjectPath ?? null,
  }, "owner");
}

beforeAll(() => {
  shas.shared = makeRepo(dirs.shared, "shared");
  shas.health = makeRepo(dirs.health, "health");
  shas.dependent = makeRepo(dirs.dependent, "dependent");
  shas.other = makeRepo(dirs.other, "other");
  db = new Database(":memory:");
  db.run("PRAGMA foreign_keys = ON");
  migrate(db, migrations);
  const clusters = new ClusterCore(db, { now: () => now });
  for (const [dir, name] of [[dirs.shared, "Shared"], [dirs.health, "Health"], [dirs.dependent, "Dependent"], [dirs.other, "Other"]] as const) {
    db.run("INSERT INTO projects (path, name, added_at) VALUES (?, ?, ?)", [dir, name, now]);
  }
  northId = clusters.create({ name: "North", slug: "north" }).id;
  southId = clusters.create({ name: "South", slug: "south" }).id;
  clusters.assign(northId, dirs.shared);
  clusters.assign(northId, dirs.health);
  clusters.assign(northId, dirs.dependent);
  clusters.assign(southId, dirs.other);
  service = new InfraAutoService(db, { now: () => now });
});

afterAll(() => {
  db.close();
  rmSync(root, { recursive: true, force: true });
});

test("FO-INFRA-AUTO01 acceptance scenario", async () => {
  expect(buildGitMutationArgs("push", "origin", "develop")).toEqual(["push", "origin", "develop:develop"]);
  expect(buildGitMutationArgs("push", "origin", "develop").join(" ")).not.toContain("--force");
  expect(() => buildGitMutationArgs("push", "origin", "--force")).toThrow(/Invalid branch/);

  binding(dirs.shared, northId, { role: "shared-infrastructure" });
  binding(dirs.health, northId, { health: { kind: "simulated", simulatedOutcome: "fail" } });
  binding(dirs.dependent, northId, { dependsOnProjectPath: dirs.shared });
  binding(dirs.other, southId, { adapter: "github-actions" });
  binding(dirs.other, southId, { environment: "production", adapter: "github-actions" });

  expect(service.discoverWorkflows(dirs.health).map((item) => item.name)).toEqual(["ci.yml", "deploy.yml"]);
  expect(JSON.stringify(service.discoverWorkflows(dirs.health))).not.toContain("ghp_");
  expect(() => service.inspectGit(path.join(root, "missing"))).toThrow(/not a directory/);
  const outside = mkdtempSync(path.join(root, "unregistered-"));
  expect(() => service.inspectGit(outside)).toThrow(/registered project/);

  const healthGit = service.inspectGit(dirs.health);
  expect(healthGit.branch).toBe("develop");
  expect(healthGit.head).toBe(shas.health);
  expect(git(dirs.health, ["branch", "--list"]).split("\n").some((line) => line.includes("feature/") || line.includes("agetor/"))).toBe(false);

  service.recordCiRun({
    projectPath: dirs.health, workflowName: "ci.yml", runKey: "health-ok", sha: shas.health,
    branch: "develop", status: "completed", conclusion: "success",
  }, "owner");
  service.recordCiRun({
    projectPath: dirs.health, workflowName: "deploy.yml", runKey: "health-bad", sha: shas.health,
    branch: "develop", status: "completed", conclusion: "failure",
    failedJobs: [{ name: "build", conclusion: "failure", failedSteps: ["compile"] }],
    logExcerpt: "token=ghp_supersecret",
  }, "owner");
  service.recordCiRun({
    projectPath: dirs.shared, workflowName: "ci.yml", runKey: "shared-ok", sha: shas.shared,
    branch: "develop", status: "completed", conclusion: "success",
  }, "owner");
  service.recordCiRun({
    projectPath: dirs.dependent, workflowName: "ci.yml", runKey: "dep-ok", sha: shas.dependent,
    branch: "develop", status: "completed", conclusion: "success",
  }, "owner");
  service.recordCiRun({
    projectPath: dirs.other, workflowName: "ci.yml", runKey: "other-bad", sha: shas.other,
    branch: "develop", status: "completed", conclusion: "failure",
    logExcerpt: "ghp_supersecret failed",
  }, "owner");

  const jobs = parseWorkflowJobs({ jobs: [{ name: "build", conclusion: "failure", steps: [{ name: "token=ghp_supersecret", conclusion: "failure" }] }] });
  expect(JSON.stringify(jobs)).not.toContain("ghp_");

  const blockedCi = service.preparePlan({ projectPath: dirs.other, environment: "staging" }, "api");
  expect(blockedCi.plan?.state).toBe("blocked");
  expect(blockedCi.blockers.join("\n")).toContain("failure");
  expect(blockedCi.plan?.sha).toBe(shas.other);

  const planned = service.preparePlan({ projectPath: dirs.shared, environment: "staging" }, "api");
  expect(planned.plan?.state).toBe("configuration-verified");
  expect(planned.plan?.sha).toBe(shas.shared);
  const frozen = planned.plan!.sha;
  writeFileSync(path.join(dirs.shared, "README.md"), "moved");
  git(dirs.shared, ["add", "README.md"]);
  git(dirs.shared, ["commit", "-m", "move"]);
  const storedSha = db.query<{ sha: string }, [string]>("SELECT sha FROM infra_plans WHERE id = ?").get(planned.plan!.id);
  expect(storedSha?.sha).toBe(frozen);

  expect(() => service.dispatch(planned.plan!.id, "missing", "api")).toThrow(/configuration-verified/);
  const early = service.preparePlan({ projectPath: dirs.dependent, environment: "staging" }, "api");
  expect(early.plan?.state).toBe("blocked");
  expect(early.blockers.join(" ")).toContain("no completed");
  service.bindTaskGate("task-dependent", dirs.dependent, dirs.shared);
  expect(deploymentGateForTask(db, "task-dependent")).toContain("Waiting for");

  const auth = service.authorizeSynthetic(planned.plan!.id, "owner");
  expect(() => service.dispatch(planned.plan!.id, "missing", "api")).toThrow(/Authorization/);
  const dispatched = service.dispatch(planned.plan!.id, auth.id, "api");
  expect(dispatched.state).toBe("simulated");
  expect(dispatched.provenance).toBe("fake-adapter");
  expect(dispatched.sha).toBe(frozen);
  expect(deploymentGateForTask(db, "task-dependent")).toBeNull();
  expect(() => service.dispatch(planned.plan!.id, auth.id, "api")).toThrow(/simulated/);
  expect(() => service.authorizeSynthetic(planned.plan!.id, "owner")).toThrow(/cannot be authorized/);
  const consumed = db.query<{ consumed_at: number | null }, [string]>("SELECT consumed_at FROM infra_authorizations WHERE id = ?").get(auth.id);
  expect(typeof consumed?.consumed_at).toBe("number");

  const healthPlan = service.preparePlan({ projectPath: dirs.health, environment: "staging" }, "api");
  expect(healthPlan.plan?.state).toBe("configuration-verified");
  const healthAuth = service.authorizeSynthetic(healthPlan.plan!.id, "owner");
  const healthRun = service.dispatch(healthPlan.plan!.id, healthAuth.id, "api");
  expect(healthRun.state).toBe("failed");
  expect(healthRun.health).toBe("failed");
  expect(healthRun.state).not.toBe("simulated");
  expect(service.answer("Why did the staging deployment fail for Health?")).toContain("not marked successful");

  const later = service.preparePlan({ projectPath: dirs.dependent, environment: "staging" }, "api");
  expect(later.plan?.state).toBe("configuration-verified");
  const laterAuth = service.authorizeSynthetic(later.plan!.id, "owner");
  const running = service.dispatch(later.plan!.id, laterAuth.id, "api", { defer: true });
  expect(running.state).toBe("running");
  expect(service.answer("Show all active deployments")).toContain("running");
  now += 61_000;
  expect(service.expireObservations().expired).toBe(1);
  expect(service.answer("Show all active deployments")).toBe("No deployment is dispatched or running.");

  const httpHealth = service.preparePlan({ projectPath: dirs.health, environment: "staging" }, "api");
  service.upsertBinding({
    clusterId: northId,
    projectPath: dirs.health,
    role: "application",
    environment: "staging",
    sourceBranch: "develop",
    workflowName: "ci.yml",
    adapter: "fake",
    services: [{ name: "web", kind: "application" }],
    health: { kind: "http-insufficient" },
    requiredChecks: ["ci.yml"],
  }, "owner");
  const httpPlan = service.preparePlan({ projectPath: dirs.health, environment: "staging", sha: shas.health }, "api");
  expect(httpPlan.plan?.sha).toBe(shas.health);
  expect(httpHealth.plan?.sha).toBe(shas.health);
  const httpAuth = service.authorizeSynthetic(httpPlan.plan!.id, "owner");
  expect(service.dispatch(httpPlan.plan!.id, httpAuth.id, "api").state).toBe("unknown");

  expect(() => service.authorizeSynthetic(blockedCi.plan!.id, "owner")).toThrow(/unsupported/);
  const handoff = service.manualHandoff(planned.plan!.id);
  expect(handoff.executionAuthorized).toBe(false);
  expect(handoff.target.sha).toBe(frozen);
  expect(JSON.stringify(handoff)).not.toContain("ghp_");
  expect(JSON.stringify(handoff)).not.toMatch(/ssh |Bearer /);

  service.saveProductionPolicy({
    clusterId: southId,
    permittedProjectPaths: [dirs.other],
    permittedEnvironments: ["production"],
    allowedBranches: ["develop"],
    requiredChecks: ["ci.yml"],
    requireStagingEvidence: true,
    permittedAdapter: "github-actions",
    maxConcurrent: 1,
  }, "owner");
  const production = service.preparePlan({ projectPath: dirs.other, environment: "production" }, "api");
  expect(production.plan?.state).toBe("blocked");
  expect(production.blockers.join("\n")).toContain("capability has not been issued");
  expect(() => service.authorizeSynthetic(production.plan!.id, "owner")).toThrow(/Production deployment is denied/);

  const failing = service.answer("Which projects have failing CI?");
  expect(failing).toContain("Health");
  expect(failing).toContain("Other");
  expect(failing).not.toContain("ghp_");
  expect(service.answer("Show the infrastructure of the north cluster")).toContain("Shared");
  expect(service.answer("Show the infrastructure of the example-infrastructure cluster")).toContain("No registered cluster");
  expect(service.answer("Show the current staging deployment of Shared")).toContain("simulated");
  expect(service.answer("Why did the staging deployment fail for Health?")).toContain("unknown");
  const prepared = service.answer("Prepare Health for deployment.");
  expect(prepared).toContain("Proposal");
  expect(prepared).toContain("was not dispatched");
  expect(service.answer("Prepare a rollback for Shared.")).toContain("not executed");
  expect(service.answer("Which projects depend on the shared infrastructure repository?")).toContain("Dependent");
  expect(service.answer("Is Other ready for production?")).toContain("not authorized for production");

  expect(() => service.upsertBinding({ clusterId: northId, projectPath: dirs.shared, role: "application", environment: "development", sourceBranch: "develop", workflowName: "ci.yml", adapter: "fake", services: [], health: { kind: "none" }, requiredChecks: [] }, "agent")).toThrow(/cannot change/);

  const body = normalizePolicyBody({
    mode: "full-autonomy",
    scopeKind: "workspace",
    scopeRef: "workspace",
    projects: [dirs.shared, dirs.health, dirs.dependent, dirs.other],
    clusters: [northId, southId],
    permittedActions: ["git_read", "ci_inspect"],
    specialistRoles: ["developer"],
    providers: ["claude-code"],
    models: ["haiku"],
    expiresAt: now + 60_000,
  }, now);
  expect(independentAuthorizationRequired("staging_deploy")).toBe(true);
  expect(() => normalizePolicyBody({ ...body, permittedActions: ["production_deploy"] }, now)).toThrow(/cannot be permitted/);
  const denied = evaluateApplicablePolicies([{ id: "p", revision: 1, digest: policyDigest(body), body }], {
    action: "staging_deploy",
    projectPath: dirs.shared,
  }, {
    launchesUsed: 0, launchesInFlight: 0, reworkUsedForTask: 0, now, activatedAt: now,
    lifecycleAllowed: true, emergencyStopped: false, paused: false, revoked: false, expired: false,
  });
  expect(denied.allow).toBe(false);
  db.run(
    `INSERT INTO autonomy_policies (id, revision, status, mode, scope_kind, scope_ref, body_json, digest, created_at, updated_at)
     VALUES ('p', 1, 'active', 'full-autonomy', 'workspace', 'workspace', ?, ?, ?, ?)`,
    [JSON.stringify(body), policyDigest(body), now, now],
  );
  db.run(
    `INSERT INTO autonomy_activations (id, policy_id, revision, digest, activated_by, activated_at, expires_at, status, provenance_json, created_at, updated_at)
     VALUES ('act', 'p', 1, ?, 'owner', ?, ?, 'active', '{}', ?, ?)`,
    [policyDigest(body), now, now + 60_000, now, now],
  );
  const fresh = service.preparePlan({ projectPath: dirs.dependent, environment: "staging" }, "api");
  expect(() => service.dispatch(fresh.plan!.id, "none", "autonomy")).toThrow(/outside the intersected|does not authorize|Independent/);

  const allowedBody = normalizePolicyBody({ ...body, permittedActions: ["git_read", "staging_deploy"] }, now);
  db.run("UPDATE autonomy_policies SET body_json = ?, digest = ? WHERE id = 'p'", [JSON.stringify(allowedBody), policyDigest(allowedBody)]);
  db.run("UPDATE autonomy_activations SET digest = ? WHERE id = 'act'", [policyDigest(allowedBody)]);
  expect(() => service.authorizeSynthetic(fresh.plan!.id, "autonomy")).toThrow(/cannot change/);
  const ownerAuth = service.authorizeSynthetic(fresh.plan!.id, "owner");
  const autonomous = service.dispatch(fresh.plan!.id, ownerAuth.id, "autonomy");
  expect(autonomous.provenance).toBe("fake-adapter");
  expect(autonomous.state).toBe("simulated");

  db.run(
    `INSERT INTO deployment_requests (
      id, project_path, cluster_id, environment, revision, requested_by_role, status, preflight_json, created_at, updated_at
    ) VALUES ('11111111-1111-4111-8111-111111111111', ?, ?, 'staging', ?, 'owner', 'approved', '{"findings":[],"plan":null,"passed":false}', ?, ?)`,
    [dirs.shared, northId, shas.shared, now, now],
  );
  const legacy = new DeploymentRequestCore(db, { now: () => now }).get("11111111-1111-4111-8111-111111111111");
  expect(legacy.id).toBe("11111111-1111-4111-8111-111111111111");
  expect(legacy.revision).toBe(shas.shared);

  const restarted = new InfraAutoService(db, { now: () => now });
  expect(restarted.snapshot().plans.some((plan) => plan.sha === frozen && plan.state === "simulated")).toBe(true);
  const live = await restarted.observeLiveCi(dirs.shared);
  expect(live.error).toContain("not enabled");
  expect(live.recorded).toBe(0);

  service.setControl({ cancelled: true }, "owner");
  expect(() => service.preparePlan({ projectPath: dirs.shared, environment: "staging" }, "api")).toThrow(/cancelled/);

  const logs = db.query<{ detail: string }, []>("SELECT detail FROM infra_operation_log").all().map((row) => row.detail).join("\n");
  expect(logs).not.toContain("ghp_");
  expect(logs).not.toContain("supersecret");
});

test("git push uses the fixed adapter and consumes one synthetic grant", () => {
  service.setControl({ cancelled: false, paused: false }, "owner");
  const calls: string[][] = [];
  const sha = "dddddddddddddddddddddddddddddddddddddddd";
  const runner: GitRunner = (_cwd, args) => {
    calls.push(args);
    if (args[0] === "status") return { status: 0, stdout: "## develop...origin/develop [ahead 1]\n", stderr: "" };
    if (args[0] === "rev-parse" || args.includes("rev-parse")) return { status: 0, stdout: `${sha}\n`, stderr: "" };
    if (args[0] === "log") return { status: 0, stdout: `${sha}\tsubject\n`, stderr: "" };
    if (args[0] === "diff") return { status: 0, stdout: "", stderr: "" };
    if (args[0] === "remote") return { status: 0, stdout: "origin\n", stderr: "" };
    if (args[0] === "push") return { status: 0, stdout: "", stderr: "" };
    if (args[0] === "cat-file") return { status: 0, stdout: "commit\n", stderr: "" };
    return { status: 1, stdout: "", stderr: "unexpected" };
  };
  const local = new InfraAutoService(db, { now: () => now, git: runner });
  const grant = local.authorizeGit({ projectPath: dirs.shared, op: "push", remote: "origin", branch: "develop" }, "owner");
  const pushed = local.mutateGit({ projectPath: dirs.shared, op: "push", remote: "origin", branch: "develop", authorizationId: grant.id }, "api");
  expect(pushed.args).toEqual(["push", "origin", "develop:develop"]);
  expect(calls.some((args) => args.includes("--force") || args.includes("reset"))).toBe(false);
  expect(() => local.mutateGit({ projectPath: dirs.shared, op: "push", remote: "origin", branch: "develop", authorizationId: grant.id }, "api")).toThrow(/already used|Authorization/);
});

test("HTTP refuses an unauthenticated dispatch and does not trust a claimed actor", async () => {
  const denied = await infraAutoHttp(new Request("http://127.0.0.1/infra-auto/plans/prepare", { method: "POST", body: "{}" }), false, { service });
  expect(denied.status).toBe(401);
  const agent = await infraAutoHttp(new Request("http://127.0.0.1/infra-auto/bindings", {
    method: "POST",
    body: JSON.stringify({ actor: "agent", projectPath: dirs.shared }),
  }), true, { service });
  expect(agent.status).toBe(403);
});
