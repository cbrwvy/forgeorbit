import { afterAll, beforeAll, expect, test } from "bun:test";
import { execSync } from "node:child_process";
import { mkdtempSync, writeFileSync, rmSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const TASK_ROOT = mkdtempSync(path.join(tmpdir(), "fo-deploy03-task-"));
const DATA_DIR = path.join(TASK_ROOT, "data");
process.env.AGETOR_DATA_DIR = DATA_DIR;
process.env.AGETOR_API_PORT = "4424";
process.env.FORGEORBIT_DEPLOYMENT_STAGING_ADAPTER = "external";
process.env.FORGEORBIT_DEPLOYMENT_EXTERNAL_LOCAL_PREFLIGHT = "1";

const FIXTURE = path.resolve("scripts/fixtures/deploy-staging-fixture.sh");

let server: { stop: () => void };
let token: string;
let db: typeof import("./db.ts").db;
let projects: typeof import("./db.ts").projects;

function auth() {
  return { authorization: `Bearer ${token}`, "content-type": "application/json" };
}

const url = (p: string) => `http://127.0.0.1:4424${p}`;

function writeCatalog(dir: string, sha: string, slug: "example-project"): string {
  const file = path.join(dir, "published-images.env");
  const appRef = `ghcr.io/example-company/example-project:${sha}@sha256:${"a".repeat(64)}`;
  writeFileSync(
    file,
    `EXPECTED_SHA=${sha}\nEXAMPLE_PROJECT_SHA=${sha}\nEXAMPLE_PROJECT_IMAGE=${appRef}\n`,
    "utf8",
  );
  chmodSync(file, 0o600);
  return file;
}

async function registerGitProject(name: string): Promise<{ dir: string; sha: string }> {
  const dir = mkdtempSync(path.join(TASK_ROOT, `proj-${name}-`));
  execSync("git init -b main", { cwd: dir, stdio: "ignore" });
  execSync("git config user.email test@test.local", { cwd: dir, stdio: "ignore" });
  execSync("git config user.name Test", { cwd: dir, stdio: "ignore" });
  execSync("git commit --allow-empty -m init", { cwd: dir, stdio: "ignore" });
  const sha = execSync("git rev-parse HEAD", { cwd: dir, encoding: "utf8" }).trim();
  projects.upsert(dir, name);
  return { dir, sha };
}

async function setupExternalIntegration(projectPath: string, clusterId: string, catalog: string) {
  await fetch(url(`/clusters/${clusterId}/projects`), {
    method: "POST",
    headers: auth(),
    body: JSON.stringify({ projectPath }),
  });
  await fetch(url("/infrastructure/project-environments"), {
    method: "POST",
    headers: auth(),
    body: JSON.stringify({ projectPath, environment: "staging" }),
  });
  const create = await fetch(url("/infrastructure/resources"), {
    method: "POST",
    headers: auth(),
    body: JSON.stringify({
      name: "Example Staging CI",
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
  const res = await fetch(url("/deployment-staging-integrations"), {
    method: "POST",
    headers: auth(),
    body: JSON.stringify({
      clusterId,
      projectPath,
      integrationType: "external-staging-v1",
      integrationLabel: "Example Staging Fixture",
      projectSlug: "example-project",
      entrypointRef: FIXTURE,
      imagesCatalogRef: catalog,
      realExecutionConfigured: true,
      realExecutionEnabled: true,
    }),
  });
  expect(res.ok, await res.text()).toBe(true);
}

beforeAll(async () => {
  ({ db, projects } = await import("./db.ts"));
  const { startApiServer, API_TOKEN } = await import("./server.ts");
  server = startApiServer() as unknown as { stop: () => void };
  token = API_TOKEN;
});

afterAll(() => {
  server?.stop?.();
  delete process.env.FORGEORBIT_DEPLOYMENT_STAGING_EXECUTE;
  delete process.env.FORGEORBIT_DEPLOYMENT_EXTERNAL_REAL_EXECUTE;
  try {
    rmSync(TASK_ROOT, { recursive: true, force: true });
  } catch {
    /* best effort */
  }
});

test("FO-DEPLOY03: External staging fixture preflight and dry-run via subprocess", async () => {
  delete process.env.STAGING_FIXTURE_MODE;
  const { dir, sha } = await registerGitProject("ExampleDry");
  const clusterRes = await fetch(url("/clusters"), { method: "POST", headers: auth(), body: JSON.stringify({ name: "ExampleC" }) });
  const clusterId = ((await clusterRes.json()) as { id: string }).id;
  await fetch(url(`/clusters/${clusterId}/projects`), {
    method: "POST",
    headers: auth(),
    body: JSON.stringify({ projectPath: dir }),
  });
  const catalog = writeCatalog(dir, sha, "example-project");
  await setupExternalIntegration(dir, clusterId, catalog);

  const createRes = await fetch(url("/deployment-requests"), {
    method: "POST",
    headers: auth(),
    body: JSON.stringify({
      projectPath: dir,
      clusterId,
      environment: "staging",
      revision: "HEAD",
      requestedByRole: "owner",
    }),
  });
  const createBody = await createRes.text();
  expect(createRes.ok, createBody).toBe(true);
  const created = JSON.parse(createBody) as { id: string; approvalDigest: string; preflight: { plan: { imageArtifacts: unknown[] } } };
  expect(created.preflight.plan.imageArtifacts.length).toBeGreaterThan(0);

  const approved = await fetch(url(`/deployment-requests/${created.id}/approve`), {
    method: "POST",
    headers: auth(),
    body: JSON.stringify({ approvalDigest: created.approvalDigest }),
  });
  const approvedJson = (await approved.json()) as { status: string; dryRun: { outcome: string } };
  expect(approvedJson.status).toBe("dry_run_complete");
  expect(approvedJson.dryRun.outcome).toBe("REAL_DRY_RUN_VERIFIED");
});

test("FO-DEPLOY03/04: External staging HTTP path denies untrusted authorization", async () => {
  process.env.STAGING_FIXTURE_MODE = "ok";
  const { dir, sha } = await registerGitProject("ExampleExec");
  const clusterRes = await fetch(url("/clusters"), { method: "POST", headers: auth(), body: JSON.stringify({ name: "ExampleExecC" }) });
  const clusterId = ((await clusterRes.json()) as { id: string }).id;
  await fetch(url(`/clusters/${clusterId}/projects`), {
    method: "POST",
    headers: auth(),
    body: JSON.stringify({ projectPath: dir }),
  });
  const catalog = writeCatalog(dir, sha, "example-project");
  await setupExternalIntegration(dir, clusterId, catalog);

  const createRes = await fetch(url("/deployment-requests"), {
    method: "POST",
    headers: auth(),
    body: JSON.stringify({
      projectPath: dir,
      clusterId,
      environment: "staging",
      revision: "HEAD",
      requestedByRole: "owner",
    }),
  });
  const createBody = await createRes.text();
  expect(createRes.ok, createBody).toBe(true);
  const created = JSON.parse(createBody) as { id: string; approvalDigest: string; executionAuthDigest?: string };
  const approved = await fetch(url(`/deployment-requests/${created.id}/approve`), {
    method: "POST",
    headers: auth(),
    body: JSON.stringify({ approvalDigest: created.approvalDigest }),
  });
  const approvedJson = (await approved.json()) as { executionAuthDigest: string };
  const authRes = await fetch(url(`/deployment-requests/${created.id}/authorize-execution`), {
    method: "POST",
    headers: auth(),
    body: JSON.stringify({ executionAuthDigest: approvedJson.executionAuthDigest, confirmOwner: true }),
  });
  expect(authRes.status).toBe(403);
  expect((await authRes.json() as { code: string }).code).toBe("owner-channel-unsupported");
  const execRes = await fetch(url(`/deployment-requests/${created.id}/execute`), { method: "POST", headers: auth() });
  expect(execRes.status).toBe(403);
  const { DeploymentRequestCore } = await import("./deployment-request-core.ts");
  expect(new DeploymentRequestCore(db).get(created.id).attempts).toHaveLength(0);

});

test("FO-DEPLOY03: missing catalog fails preflight binding", async () => {
  const { dir, sha: _sha } = await registerGitProject("ExampleNoCat");
  const clusterRes = await fetch(url("/clusters"), { method: "POST", headers: auth(), body: JSON.stringify({ name: "ExampleNoCatC" }) });
  const clusterId = ((await clusterRes.json()) as { id: string }).id;
  await fetch(url(`/clusters/${clusterId}/projects`), {
    method: "POST",
    headers: auth(),
    body: JSON.stringify({ projectPath: dir }),
  });
  await fetch(url("/infrastructure/project-environments"), {
    method: "POST",
    headers: auth(),
    body: JSON.stringify({ projectPath: dir, environment: "staging" }),
  });
  await fetch(url("/deployment-staging-integrations"), {
    method: "POST",
    headers: auth(),
    body: JSON.stringify({
      clusterId,
      projectPath: dir,
      integrationType: "external-staging-v1",
      integrationLabel: "Example Staging no catalog",
      projectSlug: "example-project",
      entrypointRef: FIXTURE,
      realExecutionConfigured: true,
      realExecutionEnabled: true,
    }),
  });
  const createRes = await fetch(url("/deployment-requests"), {
    method: "POST",
    headers: auth(),
    body: JSON.stringify({
      projectPath: dir,
      clusterId,
      environment: "staging",
      revision: "HEAD",
      requestedByRole: "owner",
    }),
  });
  const createBody = await createRes.text();
  expect(createRes.ok, createBody).toBe(true);
  const json = JSON.parse(createBody) as { preflight: { findings: { code: string }[] } };
  expect(json.preflight.findings.some((f) => f.code === "catalog.optional" || f.code === "catalog.missing")).toBe(true);
});

test("FO-DEPLOY03: External staging real execute gate off by default", async () => {
  delete process.env.FORGEORBIT_DEPLOYMENT_EXTERNAL_REAL_EXECUTE;
  const { DeploymentRequestCore } = await import("./deployment-request-core.ts");
  const core = new DeploymentRequestCore(db, { executionEnabled: () => true });
  const { dir, sha } = await registerGitProject("ExampleGate");
  const clusterRes = await fetch(url("/clusters"), { method: "POST", headers: auth(), body: JSON.stringify({ name: "ExampleGateC" }) });
  const clusterId = ((await clusterRes.json()) as { id: string }).id;
  await fetch(url(`/clusters/${clusterId}/projects`), { method: "POST", headers: auth(), body: JSON.stringify({ projectPath: dir }) });
  const catalog = writeCatalog(dir, sha, "example-project");
  await setupExternalIntegration(dir, clusterId, catalog);
  const createRes = await fetch(url("/deployment-requests"), {
    method: "POST",
    headers: auth(),
    body: JSON.stringify({ projectPath: dir, clusterId, environment: "staging", revision: "HEAD", requestedByRole: "owner" }),
  });
  const createBody = await createRes.text();
  expect(createRes.ok, createBody).toBe(true);
  const created = JSON.parse(createBody) as { id: string; approvalDigest: string };
  await fetch(url(`/deployment-requests/${created.id}/approve`), {
    method: "POST",
    headers: auth(),
    body: JSON.stringify({ approvalDigest: created.approvalDigest }),
  });
  const row = core.get(created.id);
  expect(() => core.authorizeExecution(created.id, { executionAuthDigest: row.executionAuthDigest!, confirmOwner: true }))
    .toThrow("Trusted Owner confirmation is unsupported");
  await expect(core.executeStaging(created.id)).rejects.toMatchObject({ status: 403 });
});


test("FO-DEPLOY03: fixed argv fixture transport remains functional (no trusted authorization claim)", async () => {
  const { buildExternalControllerArgv, runExternalControllerArgv } = await import("./deployment-external-staging-executor.ts");
  const { DeploymentRequestCore } = await import("./deployment-request-core.ts");
  const core = new DeploymentRequestCore(db);
  const record = core.list().find((r) => r.projectName === "ExampleExec")!;
  const { StagingIntegrationCore } = await import("./deployment-staging-integration-core.ts");
  const integration = new StagingIntegrationCore(db).get(record.integrationId!);
  expect(integration.entrypointRef).toBe(FIXTURE);
  const plan = record.preflight.plan!;
  const argv = buildExternalControllerArgv("deploy", integration, plan, { imagesFilePath: integration.imagesCatalogRef! });
  expect(argv).toEqual([FIXTURE, "deploy", "example-project", "--sha", record.revisionResolved!, "--images-file", integration.imagesCatalogRef!]);
  const result = await runExternalControllerArgv(argv, { timeoutMs: 2000 });
  expect(result.exitCode).toBe(0);
  expect(result.log).toContain("deploy ok");
});
