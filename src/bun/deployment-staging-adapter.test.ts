import { afterAll, beforeAll, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { execSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { sanitizeDeploymentLog } from "../shared/deployment-request/log-sanitize.ts";
import { setFakeStagingAdapterMode } from "./deployment-fake-staging-adapter.ts";

const TASK_ROOT = mkdtempSync(path.join(tmpdir(), "fo-deploy02-task-"));
const DATA_DIR = path.join(TASK_ROOT, "data");
process.env.AGETOR_DATA_DIR = DATA_DIR;
process.env.AGETOR_API_PORT = "4423";
process.env.FORGEORBIT_DEPLOYMENT_STAGING_ADAPTER = "fake";
process.env.FORGEORBIT_DEPLOYMENT_DRY_RUN_ADAPTER = "1";

let server: { stop: () => void };
let token: string;
let db: typeof import("./db.ts").db;
let projects: typeof import("./db.ts").projects;

function auth() {
  return { authorization: `Bearer ${token}`, "content-type": "application/json" };
}

const url = (p: string) => `http://127.0.0.1:4423${p}`;

async function registerGitProject(name: string): Promise<string> {
  const dir = mkdtempSync(path.join(TASK_ROOT, `proj-${name}-`));
  execSync("git init -b main", { cwd: dir, stdio: "ignore" });
  execSync("git config user.email test@test.local", { cwd: dir, stdio: "ignore" });
  execSync("git config user.name Test", { cwd: dir, stdio: "ignore" });
  execSync("git commit --allow-empty -m init", { cwd: dir, stdio: "ignore" });
  projects.upsert(dir, name);
  return dir;
}

async function createCluster(name: string): Promise<string> {
  const res = await fetch(url("/clusters"), { method: "POST", headers: auth(), body: JSON.stringify({ name }) });
  expect(res.ok).toBe(true);
  return ((await res.json()) as { id: string }).id;
}

async function assignCluster(clusterId: string, projectPath: string) {
  const res = await fetch(url(`/clusters/${clusterId}/projects`), {
    method: "POST",
    headers: auth(),
    body: JSON.stringify({ projectPath }),
  });
  expect(res.ok, await res.text()).toBe(true);
}

async function declareEnv(projectPath: string) {
  const res = await fetch(url("/infrastructure/project-environments"), {
    method: "POST",
    headers: auth(),
    body: JSON.stringify({ projectPath, environment: "staging" }),
  });
  expect(res.ok).toBe(true);
}

async function linkCicd(projectPath: string, clusterId: string) {
  const create = await fetch(url("/infrastructure/resources"), {
    method: "POST",
    headers: auth(),
    body: JSON.stringify({
      name: "Fixture staging",
      resourceType: "cicd",
      clusterIds: [clusterId],
      projectPaths: [projectPath],
    }),
  });
  const resource = (await create.json()) as { id: string };
  await fetch(url(`/infrastructure/resources/${resource.id}/environment-links`), {
    method: "POST",
    headers: auth(),
    body: JSON.stringify({ projectPath, environment: "staging" }),
  });
}

async function createIntegration(clusterId: string, projectPath: string) {
  const res = await fetch(url("/deployment-staging-integrations"), {
    method: "POST",
    headers: auth(),
    body: JSON.stringify({
      clusterId,
      projectPath,
      integrationType: "forgeorbit-fake-staging-v1",
      integrationLabel: "Fake staging",
      projectSlug: "demo",
      entrypointRef: "@forgeorbit-fake-staging-v1",
    }),
  });
  const text = await res.text();
  expect(res.ok, text).toBe(true);
  return JSON.parse(text) as { id: string };
}

async function createRequest(projectPath: string, clusterId: string, environment: "staging" | "production" = "staging") {
  const res = await fetch(url("/deployment-requests"), {
    method: "POST",
    headers: auth(),
    body: JSON.stringify({
      projectPath,
      clusterId,
      environment,
      revision: "HEAD",
      requestedByRole: "owner",
    }),
  });
  const text = await res.text();
  expect(res.ok, text).toBe(true);
  return JSON.parse(text) as Record<string, unknown>;
}

async function approveRequest(id: string, digest: string) {
  const res = await fetch(url(`/deployment-requests/${id}/approve`), {
    method: "POST",
    headers: auth(),
    body: JSON.stringify({ approvalDigest: digest }),
  });
  const text = await res.text();
  expect(res.ok, text).toBe(true);
  return JSON.parse(text) as Record<string, unknown>;
}

beforeAll(async () => {
  ({ db, projects } = await import("./db.ts"));
  const { startApiServer, API_TOKEN } = await import("./server.ts");
  server = startApiServer() as unknown as { stop: () => void };
  token = API_TOKEN;
});

afterAll(() => {
  server?.stop?.();
  try {
    rmSync(TASK_ROOT, { recursive: true, force: true });
  } catch {
    /* best effort */
  }
});

test("FO-DEPLOY02: fake adapter dry-run and execution authorization flow", async () => {
  setFakeStagingAdapterMode("ok");
  const project = await registerGitProject("StagingFlow");
  const cluster = await createCluster("FlowCluster");
  await assignCluster(cluster, project);
  await declareEnv(project);
  await linkCicd(project, cluster);
  await createIntegration(cluster, project);

  const created = await createRequest(project, cluster);
  expect(created.status).toBe("awaiting_owner");
  const approved = await approveRequest(created.id as string, created.approvalDigest as string);
  expect(approved.status).toBe("dry_run_complete");
  expect((approved.dryRun as { outcome: string }).outcome).toBe("SIMULATED");
  expect(approved.executionState).toBe("awaiting_execution_auth");

  const execDigest = approved.executionAuthDigest as string;
  const authRes = await fetch(url(`/deployment-requests/${created.id}/authorize-execution`), {
    method: "POST",
    headers: auth(),
    body: JSON.stringify({ executionAuthDigest: execDigest }),
  });
  expect(authRes.ok).toBe(true);
  const authorized = (await authRes.json()) as { executionState: string };
  expect(authorized.executionState).toBe("ready_to_execute");

  const blocked = await fetch(url(`/deployment-requests/${created.id}/execute`), { method: "POST", headers: auth() });
  expect(blocked.status).toBe(403);

  process.env.FORGEORBIT_DEPLOYMENT_STAGING_EXECUTE = "1";
  const { DeploymentRequestCore } = await import("./deployment-request-core.ts");
  const core = new DeploymentRequestCore(db, { executionEnabled: () => true });
  const executed = await core.executeStaging(created.id as string);
  expect(executed.executionState).toBe("succeeded");
  expect(executed.attempts.length).toBe(1);
  expect(executed.attempts[0]?.logSanitized).toContain("[redacted]");
  delete process.env.FORGEORBIT_DEPLOYMENT_STAGING_EXECUTE;

  const dup = await fetch(url(`/deployment-requests/${created.id}/execute`), { method: "POST", headers: auth() });
  expect(dup.status).toBe(409);
});

test("FO-DEPLOY02: production execution blocked", async () => {
  const project = await registerGitProject("ProdBlock");
  const cluster = await createCluster("ProdBlockC");
  await assignCluster(cluster, project);
  await fetch(url("/infrastructure/project-environments"), {
    method: "POST",
    headers: auth(),
    body: JSON.stringify({ projectPath: project, environment: "production" }),
  });
  const req = await fetch(url("/deployment-requests"), {
    method: "POST",
    headers: auth(),
    body: JSON.stringify({
      projectPath: project,
      clusterId: cluster,
      environment: "production",
      revision: "HEAD",
      requestedByRole: "owner",
    }),
  });
  const json = (await req.json()) as { id: string; approvalDigest: string };
  await fetch(url(`/deployment-requests/${json.id}/approve`), {
    method: "POST",
    headers: auth(),
    body: JSON.stringify({ approvalDigest: json.approvalDigest, confirmProduction: true }),
  });
  const authExec = await fetch(url(`/deployment-requests/${json.id}/authorize-execution`), {
    method: "POST",
    headers: auth(),
    body: JSON.stringify({ executionAuthDigest: "0".repeat(64) }),
  });
  expect(authExec.status).toBe(409);
});

test("FO-DEPLOY02: stale execution authorization rejected", async () => {
  setFakeStagingAdapterMode("ok");
  const project = await registerGitProject("StaleExec");
  const cluster = await createCluster("StaleExecC");
  await assignCluster(cluster, project);
  await declareEnv(project);
  await linkCicd(project, cluster);
  await createIntegration(cluster, project);
  const created = await createRequest(project, cluster);
  const approved = await approveRequest(created.id as string, created.approvalDigest as string);
  const bad = await fetch(url(`/deployment-requests/${created.id}/authorize-execution`), {
    method: "POST",
    headers: auth(),
    body: JSON.stringify({ executionAuthDigest: "0".repeat(64) }),
  });
  expect(bad.status).toBe(409);
  expect(approved.executionAuthDigest).not.toBe("0".repeat(64));
});

test("FO-DEPLOY02: failed fake execution and reconciliation", async () => {
  setFakeStagingAdapterMode("execute_fail");
  process.env.FORGEORBIT_DEPLOYMENT_STAGING_EXECUTE = "1";
  const project = await registerGitProject("FailExec");
  const cluster = await createCluster("FailExecC");
  await assignCluster(cluster, project);
  await declareEnv(project);
  await linkCicd(project, cluster);
  await createIntegration(cluster, project);
  const created = await createRequest(project, cluster);
  const approved = await approveRequest(created.id as string, created.approvalDigest as string);
  await fetch(url(`/deployment-requests/${created.id}/authorize-execution`), {
    method: "POST",
    headers: auth(),
    body: JSON.stringify({ executionAuthDigest: approved.executionAuthDigest }),
  });
  const { DeploymentRequestCore } = await import("./deployment-request-core.ts");
  const core = new DeploymentRequestCore(db, { executionEnabled: () => true });
  const failed = await core.executeStaging(created.id as string);
  expect(failed.executionState).toBe("failed");
  delete process.env.FORGEORBIT_DEPLOYMENT_STAGING_EXECUTE;
  setFakeStagingAdapterMode("ok");
});

test("FO-DEPLOY02: Needs You lists execution authorization holds", async () => {
  const owner = await fetch(url("/owner-actions"), { headers: auth() });
  const payload = (await owner.json()) as { deploymentExecutionAuthHolds: unknown[] };
  expect(Array.isArray(payload.deploymentExecutionAuthHolds)).toBe(true);
});

test("FO-DEPLOY02: log sanitizer redacts secrets", () => {
  const out = sanitizeDeploymentLog("token=supersecret\nBearer abc.def.ghi");
  expect(out).toContain("[redacted]");
  expect(out).not.toContain("supersecret");
});

test("FO-DEPLOY02: legacy dry-run JSON normalizes synthetic REAL label", async () => {
  const { normalizeDryRunResult } = await import("../shared/deployment-request/dry-run-display.ts");
  const normalized = normalizeDryRunResult({
    outcome: "REAL_DRY_RUN_VERIFIED",
    simulated: true,
    remoteCommandsExecuted: 0,
    message: "REAL_DRY_RUN_VERIFIED — old",
    plan: {} as import("../shared/deployment-request/types.ts").DeploymentPlan,
  });
  expect(normalized.outcome).toBe("SIMULATED");
});

test("FO-DEPLOY02: unsupported project integration rejected at create", async () => {
  const project = await registerGitProject("BadSlug");
  const cluster = await createCluster("BadSlugC");
  await assignCluster(cluster, project);
  process.env.FORGEORBIT_DEPLOYMENT_ALLOWED_SLUGS = "example-project,example-service";
  try {
    const res = await fetch(url("/deployment-staging-integrations"), {
      method: "POST",
      headers: auth(),
      body: JSON.stringify({
        clusterId: cluster,
        projectPath: project,
        integrationType: "external-staging-v1",
        integrationLabel: "Example Staging",
        projectSlug: "not-a-real-project",
        entrypointRef: "/usr/local/sbin/deploy-staging.sh",
      }),
    });
    expect(res.status).toBe(400);
  } finally {
    delete process.env.FORGEORBIT_DEPLOYMENT_ALLOWED_SLUGS;
  }
});
