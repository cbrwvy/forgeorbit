import { afterAll, beforeAll, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { DeploymentRequestCore } from "./deployment-request-core.ts";
import { deploymentRequestHttp } from "./deployment-request-http.ts";
import { SYNTHETIC_AUTH_TTL_MS } from "../shared/deployment-request/owner-authorization.ts";
import { setFakeStagingAdapterMode } from "./deployment-fake-staging-adapter.ts";
import type { DeploymentRequestRecord, DeploymentPlan } from "../shared/deployment-request/types.ts";

const root = mkdtempSync(path.join(tmpdir(), "fo-deploy04-test-"));
process.env.AGETOR_DATA_DIR = path.join(root, "data");
process.env.FORGEORBIT_DATA_DIR = process.env.AGETOR_DATA_DIR;
process.env.AGETOR_API_PORT = "4425";
let db: typeof import("./db.ts").db;
let projects: typeof import("./db.ts").projects;
let server: { stop: () => void };
let token: string;
let now = 1_800_000_000_000;
const core = () => new DeploymentRequestCore(db, { now: () => now, executionEnabled: () => true });
const fixture = path.resolve("scripts/fixtures/deploy-staging-fixture.sh");

async function api(route: string, data?: unknown) {
  const response = await fetch(`http://127.0.0.1:4425${route}`, {
    method: data === undefined ? "GET" : "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: data === undefined ? undefined : JSON.stringify(data),
  });
  expect(response.ok, await response.clone().text()).toBe(true);
  return response.json() as Promise<any>;
}

async function prepared(kind: "fake" | "lf" = "fake", role = "owner", localPreflight = true) {
  process.env.FORGEORBIT_DEPLOYMENT_STAGING_ADAPTER = kind === "lf" ? "external" : "fake";
  if (localPreflight) process.env.FORGEORBIT_DEPLOYMENT_EXTERNAL_LOCAL_PREFLIGHT = "1";
  else delete process.env.FORGEORBIT_DEPLOYMENT_EXTERNAL_LOCAL_PREFLIGHT;
  setFakeStagingAdapterMode("ok");
  const dir = mkdtempSync(path.join(root, "project-"));
  const git = (...args: string[]) => execFileSync("git", args, { cwd: dir, encoding: "utf8" }).trim();
  git("init", "-b", "main");
  git("-c", "user.name=Test", "-c", "user.email=test@example.invalid", "commit", "--allow-empty", "-m", "fixture");
  const sha = git("rev-parse", "HEAD");
  projects.upsert(dir, "Authorization fixture");
  const cluster = await api("/clusters", { name: `Cluster ${path.basename(dir)}` });
  await api(`/clusters/${cluster.id}/projects`, { projectPath: dir });
  await api("/infrastructure/project-environments", { projectPath: dir, environment: "staging" });
  const resource = await api("/infrastructure/resources", {
    name: "Synthetic deployment resource", resourceType: "cicd", clusterIds: [cluster.id], projectPaths: [dir],
  });
  await api(`/infrastructure/resources/${resource.id}/environment-links`, { projectPath: dir, environment: "staging" });
  const catalog = path.join(dir, "published-images.env");
  writeFileSync(catalog, `EXPECTED_SHA=${sha}\nEXAMPLE_PROJECT_SHA=${sha}\nEXAMPLE_PROJECT_IMAGE=ghcr.io/example-company/example-project@sha256:${"a".repeat(64)}\n`);
  await api("/deployment-staging-integrations", {
    clusterId: cluster.id, projectPath: dir,
    integrationType: kind === "lf" ? "external-staging-v1" : "forgeorbit-fake-staging-v1",
    integrationLabel: "Synthetic fixture only", projectSlug: kind === "lf" ? "example-project" : "demo",
    entrypointRef: kind === "lf" ? fixture : "@forgeorbit-fake-staging-v1",
    imagesCatalogRef: kind === "lf" ? catalog : null,
    realExecutionConfigured: kind === "lf", realExecutionEnabled: kind === "lf",
  });
  const c = core();
  const request = c.create({ projectPath: dir, clusterId: cluster.id, environment: "staging", revision: "HEAD", requestedByRole: role });
  expect(request.status).toBe("awaiting_owner");
  const record = c.approve(request.id, { approvalDigest: request.approvalDigest });
  expect(record.status).toBe(kind === "lf" && !localPreflight ? "dry_run_unsupported" : "dry_run_complete");
  return { c, record, catalog };
}

function authorize(c: DeploymentRequestCore, r: DeploymentRequestRecord) {
  return c.authorizeExecution(r.id, { executionAuthDigest: r.executionAuthDigest, confirmOwner: true });
}

function tamperPlan(id: string, edit: (plan: DeploymentPlan) => void) {
  const row = db.query<{ preflight_json: string }, [string]>("SELECT preflight_json FROM deployment_requests WHERE id = ?").get(id)!;
  const preflight = JSON.parse(row.preflight_json);
  edit(preflight.plan);
  db.run("UPDATE deployment_requests SET preflight_json = ? WHERE id = ?", [JSON.stringify(preflight), id]);
}

beforeAll(async () => {
  ({ db, projects } = await import("./db.ts"));
  const { startApiServer, API_TOKEN } = await import("./server.ts");
  server = startApiServer() as unknown as { stop: () => void };
  token = API_TOKEN;
});
afterAll(() => { server?.stop(); db?.close(); rmSync(root, { recursive: true, force: true }); });

test("FO-DEPLOY04: Bearer-only External staging authorization and execution are rejected", async () => {
  const { record } = await prepared("lf");
  const response = await fetch(`http://127.0.0.1:4425/deployment-requests/${record.id}/authorize-execution`, {
    method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify({ executionAuthDigest: record.executionAuthDigest }),
  });
  expect(response.status).toBe(403);
  expect(await response.json()).toMatchObject({ code: "owner-channel-unsupported" });
  await expect(core().executeStaging(record.id)).rejects.toMatchObject({ status: 403 });
  expect(core().get(record.id).attempts).toHaveLength(0);
});

for (const role of ["owner", "project-manager", "head-of-pm"]) {
  test(`FO-DEPLOY04: ${role} + confirmOwner cannot create trusted authorization`, async () => {
    const { c, record } = await prepared("lf", role);
    expect(() => authorize(c, record)).toThrow("Trusted Owner confirmation is unsupported");
    expect(c.get(record.id)).toMatchObject({ executionAuthAt: null, executionState: "awaiting_execution_auth",
      ownerConfirmation: { result: "unsupported", executionReady: false, expiresAt: null } });
  });
}

test("FO-DEPLOY04: client native success, role and authentication data are rejected", async () => {
  const { c, record } = await prepared("lf");
  for (const extra of [{ nativeAuthenticated: true }, { requestedByRole: "owner" }, { token: "one-time" }, { result: "success" }]) {
    const response = await deploymentRequestHttp(new Request(`http://localhost/deployment-requests/${record.id}/authorize-execution`, {
      method: "POST", body: JSON.stringify({ executionAuthDigest: record.executionAuthDigest, confirmOwner: true, ...extra }),
    }), true, { core: c });
    expect(response.status).toBe(400);
  }
  expect(c.get(record.id).executionAuthAt).toBeNull();
});

test("FO-DEPLOY04: manual handoff binds exact target, SHA, artifacts, integration and action; no grant", async () => {
  const { c, record } = await prepared("lf");
  const response = await deploymentRequestHttp(new Request(`http://localhost/deployment-requests/${record.id}/manual-handoff`), true, { core: c });
  expect(response.ok).toBe(true);
  const packet = await response.json();
  expect(packet).toMatchObject({ requestId: record.id, action: "deploy-staging", reviewOnly: true, executionAuthorized: false,
    planDigest: record.planDigest, revisionResolved: record.revisionResolved,
    target: { projectPath: record.projectPath, clusterId: record.clusterId, environment: "staging" },
    integration: { id: record.integrationId, type: "external-staging-v1" },
    imageArtifacts: record.preflight.plan!.imageArtifacts, imageCatalogDigest: record.preflight.plan!.imageCatalogDigest });
  expect(c.get(record.id).executionAuthAt).toBeNull();
  expect(c.get(record.id).attempts).toHaveLength(0);
  const unauth = await deploymentRequestHttp(new Request(`http://localhost/deployment-requests/${record.id}/manual-handoff`), false, { core: c });
  expect(unauth.status).toBe(401);
});

test("FO-DEPLOY04: changed live image catalog invalidates manual packet", async () => {
  const { c, record, catalog } = await prepared("lf");
  writeFileSync(catalog, `EXPECTED_SHA=${record.revisionResolved}\nEXAMPLE_PROJECT_SHA=${record.revisionResolved}\nEXAMPLE_PROJECT_IMAGE=ghcr.io/example-company/example-project@sha256:${"b".repeat(64)}\n`);
  expect(() => c.manualHandoff(record.id)).toThrow("Image catalog changed");
});

test("FO-DEPLOY04: config-only External staging handoff works with all execution flags off; no dry-run success is invented", async () => {
  const { c, record } = await prepared("lf", "head-of-pm", false);
  expect(c.manualHandoff(record.id)).toMatchObject({ reviewOnly: true, executionAuthorized: false, dryRunOutcome: "UNSUPPORTED" });
  expect(c.get(record.id)).toMatchObject({ executionState: "none", executionAuthAt: null, attempts: [] });
});

test("FO-DEPLOY04: cancelling pending External staging confirmation never issues a grant", async () => {
  const { c, record } = await prepared("lf");
  expect(c.cancelExecution(record.id)).toMatchObject({ executionAuthAt: null, executionState: "awaiting_execution_auth" });
  expect(() => authorize(c, c.get(record.id))).toThrow("Trusted Owner confirmation is unsupported");
  await expect(c.executeStaging(record.id)).rejects.toMatchObject({ code: "owner-channel-unsupported" });
});

for (const [name, edit] of [
  ["project", (p: DeploymentPlan) => { p.projectPath = "/different"; }],
  ["cluster", (p: DeploymentPlan) => { p.clusterId = "00000000-0000-4000-8000-000000000001"; }],
  ["SHA", (p: DeploymentPlan) => { p.revisionResolved = "b".repeat(40); }],
  ["images", (p: DeploymentPlan) => { p.imageCatalogDigest = "b".repeat(64); }],
  ["steps", (p: DeploymentPlan) => { p.steps[0]!.detail += " modified"; }],
  ["entrypoint", (p: DeploymentPlan) => { p.entrypointRef = "/tmp/other-deploy-staging.sh"; }],
  ["project slug", (p: DeploymentPlan) => { p.stagingProjectSlug = "other"; }],
] as const) {
  test(`FO-DEPLOY04: changed ${name} invalidates synthetic grant and External staging review packet`, async () => {
    const { c, record } = await prepared();
    authorize(c, record);
    tamperPlan(record.id, edit);
    await expect(c.executeStaging(record.id)).rejects.toMatchObject({ status: 409 });
    expect(c.get(record.id).attempts).toHaveLength(0);
    const lf = await prepared("lf");
    tamperPlan(lf.record.id, edit);
    expect(() => lf.c.manualHandoff(lf.record.id)).toThrow("Approved plan or integration changed");
  });
}

test("FO-DEPLOY04: synthetic grant is valid only for one request; expires at five minutes", async () => {
  const first = await prepared();
  const second = await prepared();
  expect(() => second.c.authorizeExecution(second.record.id, { executionAuthDigest: first.record.executionAuthDigest })).toThrow("does not match");
  authorize(first.c, first.record);
  now += SYNTHETIC_AUTH_TTL_MS;
  await expect(first.c.executeStaging(first.record.id)).rejects.toMatchObject({ code: "expired" });
  expect(first.c.get(first.record.id).attempts).toHaveLength(0);
});

test("FO-DEPLOY04: concurrent cores consume a synthetic grant exactly once; restart cannot replay", async () => {
  const { c, record } = await prepared();
  authorize(c, record);
  const connection = new Database(db.filename);
  const competing = new DeploymentRequestCore(connection, { now: () => now, executionEnabled: () => true });
  const results = await Promise.allSettled([c.executeStaging(record.id), competing.executeStaging(record.id)]);
  connection.close();
  expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
  expect(results.filter((r) => r.status === "rejected")).toHaveLength(1);
  const restarted = core();
  expect(restarted.get(record.id).attempts).toHaveLength(1);
  expect(restarted.get(record.id).executionAuthDigest).toBeNull();
  await expect(restarted.executeStaging(record.id)).rejects.toMatchObject({ status: 409 });
  expect(() => authorize(restarted, record)).toThrow("not awaiting");
  // Fresh Bun process and SQLite connection: consumed state is durable, not a Map-only guard.
  const child = Bun.spawn(["bun", "--no-env-file", "-e", `
    import { Database } from "bun:sqlite";
    import { DeploymentRequestCore } from ${JSON.stringify(path.resolve("src/bun/deployment-request-core.ts"))};
    const db = new Database(process.argv[1]);
    const c = new DeploymentRequestCore(db, { executionEnabled: () => true });
    try { await c.executeStaging(process.argv[2]); process.exitCode = 1; }
    catch (error) { console.log(JSON.stringify({ code: error.code, attempts: c.get(process.argv[2]).attempts.length, digest: c.get(process.argv[2]).executionAuthDigest })); }
    db.close();
  `, db.filename, record.id], { env: { ...process.env }, stdout: "pipe", stderr: "pipe" });
  const output = await new Response(child.stdout).text();
  const errors = await new Response(child.stderr).text();
  expect(await child.exited, errors).toBe(0);
  expect(JSON.parse(output)).toMatchObject({ code: "state", attempts: 1, digest: null });
});

test("FO-DEPLOY04: attempt insert failure rolls back grant consumption", async () => {
  const { c, record } = await prepared();
  authorize(c, record);
  db.run("CREATE TRIGGER reject_test_attempt BEFORE INSERT ON deployment_execution_attempts BEGIN SELECT RAISE(ABORT, 'fixture failure'); END");
  try { await expect(c.executeStaging(record.id)).rejects.toThrow("fixture failure"); }
  finally { db.run("DROP TRIGGER reject_test_attempt"); }
  expect(c.get(record.id)).toMatchObject({ executionState: "ready_to_execute", attempts: [] });
  expect(c.get(record.id).executionAuthDigest).toBeTruthy();
});

test("FO-DEPLOY04: cancellation revokes synthetic grant; old digest stays invalid after restart", async () => {
  const { c, record } = await prepared();
  authorize(c, record);
  c.cancelExecution(record.id);
  await expect(core().executeStaging(record.id)).rejects.toMatchObject({ status: 409 });
  expect(() => authorize(core(), record)).toThrow("does not match");
  expect(core().get(record.id).executionAuthAt).toBeNull();
});

test("FO-DEPLOY04: fake approval cannot authorize production or production handoff", async () => {
  const { c, record } = await prepared();
  authorize(c, record);
  db.run("UPDATE deployment_requests SET environment = 'production' WHERE id = ?", [record.id]);
  await expect(c.executeStaging(record.id)).rejects.toMatchObject({ code: "production", status: 403 });
  expect(() => c.manualHandoff(record.id)).toThrow("Production handoff is prohibited");
});

test("FO-DEPLOY04: legacy External staging ready rows never execute, including after restart or fake adapter selection", async () => {
  const { record } = await prepared("lf");
  db.run("UPDATE deployment_requests SET execution_state = 'ready_to_execute', execution_auth_at = ?, execution_auth_digest = ? WHERE id = ?",
    [now, record.executionAuthDigest, record.id]);
  for (const adapter of ["external", "fake"]) {
    process.env.FORGEORBIT_DEPLOYMENT_STAGING_ADAPTER = adapter;
    await expect(core().executeStaging(record.id)).rejects.toMatchObject({ code: "owner-channel-unsupported" });
  }
  expect(core().get(record.id).attempts).toHaveLength(0);
});

test("FO-DEPLOY04: External staging deploy facade refuses even direct calls; no fallback auth provider", async () => {
  const { record } = await prepared("lf");
  const { StagingIntegrationCore } = await import("./deployment-staging-integration-core.ts");
  const { externalStagingExecuteDeploy } = await import("./deployment-external-staging-executor.ts");
  const integration = new StagingIntegrationCore(db).get(record.integrationId!);
  expect(await externalStagingExecuteDeploy(record.preflight.plan!, integration, integration.imagesCatalogRef!, { timeoutMs: 100 }))
    .toMatchObject({ exitCode: null, state: "failed", errorMessage: expect.stringContaining("unsupported") });
  expect(core().get(record.id).ownerConfirmation.executionReady).toBe(false);
});
