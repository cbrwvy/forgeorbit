import { afterAll, beforeAll, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { execSync } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const DATA_DIR = mkdtempSync(path.join(tmpdir(), "fo-deploy01-"));
process.env.AGETOR_DATA_DIR = DATA_DIR;
process.env.AGETOR_API_PORT = "4422";
process.env.FORGEORBIT_DEPLOYMENT_DRY_RUN_ADAPTER = "1";

let server: { stop: () => void };
let token: string;
let db: typeof import("./db.ts").db;
let projects: typeof import("./db.ts").projects;

function auth() {
  return { authorization: `Bearer ${token}`, "content-type": "application/json" };
}

const url = (p: string) => `http://127.0.0.1:4422${p}`;

async function registerGitProject(name: string): Promise<string> {
  const dir = mkdtempSync(path.join(tmpdir(), `fo-deploy-proj-${name}-`));
  execSync("git init -b main", { cwd: dir, stdio: "ignore" });
  execSync("git config user.email test@test.local", { cwd: dir, stdio: "ignore" });
  execSync("git config user.name Test", { cwd: dir, stdio: "ignore" });
  execSync("git commit --allow-empty -m init", { cwd: dir, stdio: "ignore" });
  projects.upsert(dir, name);
  return dir;
}

async function createCluster(name: string): Promise<string> {
  const res = await fetch(url("/clusters"), {
    method: "POST",
    headers: auth(),
    body: JSON.stringify({ name }),
  });
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

async function declareEnv(projectPath: string, environment: "staging" | "production") {
  const res = await fetch(url("/infrastructure/project-environments"), {
    method: "POST",
    headers: auth(),
    body: JSON.stringify({ projectPath, environment }),
  });
  expect(res.ok, await res.text()).toBe(true);
}

async function linkCicd(projectPath: string, environment: "staging" | "production", clusterId: string) {
  const create = await fetch(url("/infrastructure/resources"), {
    method: "POST",
    headers: auth(),
    body: JSON.stringify({
      name: `Fixture ${environment}`,
      resourceType: "cicd",
      clusterIds: [clusterId],
      projectPaths: [projectPath],
    }),
  });
  const createText = await create.text();
  expect(create.ok, createText).toBe(true);
  const resource = JSON.parse(createText) as { id: string };
  const link = await fetch(url(`/infrastructure/resources/${resource.id}/environment-links`), {
    method: "POST",
    headers: auth(),
    body: JSON.stringify({ projectPath, environment }),
  });
  const linkText = await link.text();
  expect(link.ok, linkText).toBe(true);
}

async function createRequest(body: Record<string, unknown>) {
  const res = await fetch(url("/deployment-requests"), { method: "POST", headers: auth(), body: JSON.stringify(body) });
  const text = await res.text();
  return { res, json: res.ok ? (JSON.parse(text) as Record<string, unknown>) : null, text };
}

beforeAll(async () => {
  ({ db, projects } = await import("./db.ts"));
  const { startApiServer, API_TOKEN } = await import("./server.ts");
  server = startApiServer() as unknown as { stop: () => void };
  token = API_TOKEN;
});

afterAll(() => {
  server?.stop?.();
  delete process.env.FORGEORBIT_DEPLOYMENT_DRY_RUN_ADAPTER;
});

test("FO-DEPLOY01 acceptance: staging request through simulated dry-run", async () => {
  const project = await registerGitProject("Alpha");
  const cluster = await createCluster("Cluster A");
  await assignCluster(cluster, project);
  await declareEnv(project, "staging");
  await linkCicd(project, "staging", cluster);

  const { res, json } = await createRequest({
    projectPath: project,
    clusterId: cluster,
    environment: "staging",
    revision: "HEAD",
    requestedByRole: "owner",
  });
  expect(res.status).toBe(201);
  expect(json?.status).toBe("awaiting_owner");
  const digest = json?.approvalDigest as string;
  const approve = await fetch(url(`/deployment-requests/${json?.id}/approve`), {
    method: "POST",
    headers: auth(),
    body: JSON.stringify({ approvalDigest: digest }),
  });
  const approveText = await approve.text();
  expect(approve.ok, approveText).toBe(true);
  const done = JSON.parse(approveText) as { status: string; dryRun: { outcome: string; simulated: boolean; remoteCommandsExecuted: number } };
  expect(done.status).toBe("dry_run_complete");
  expect(done.dryRun.outcome).toBe("SIMULATED");
  expect(done.dryRun.simulated).toBe(true);
  expect(done.dryRun.remoteCommandsExecuted).toBe(0);
});

test("FO-DEPLOY01: production requires confirmProduction", async () => {
  const project = await registerGitProject("Prod");
  const cluster = await createCluster("Cluster P");
  await assignCluster(cluster, project);
  await declareEnv(project, "production");
  await linkCicd(project, "production", cluster);
  const { json } = await createRequest({
    projectPath: project,
    clusterId: cluster,
    environment: "production",
    revision: "HEAD",
    requestedByRole: "owner",
  });
  const digest = json?.approvalDigest as string;
  const denied = await fetch(url(`/deployment-requests/${json?.id}/approve`), {
    method: "POST",
    headers: auth(),
    body: JSON.stringify({ approvalDigest: digest }),
  });
  expect(denied.status).toBe(400);
  const ok = await fetch(url(`/deployment-requests/${json?.id}/approve`), {
    method: "POST",
    headers: auth(),
    body: JSON.stringify({ approvalDigest: digest, confirmProduction: true }),
  });
  expect(ok.ok).toBe(true);
});

test("FO-DEPLOY01: wrong cluster rejected at preflight", async () => {
  const project = await registerGitProject("WrongCluster");
  const a = await createCluster("A");
  const b = await createCluster("B");
  await assignCluster(a, project);
  await declareEnv(project, "staging");
  const { json } = await createRequest({
    projectPath: project,
    clusterId: b,
    environment: "staging",
    revision: "HEAD",
    requestedByRole: "owner",
  });
  expect(json?.status).toBe("preflight_failed");
  const codes = (json?.preflight as { findings: { code: string }[] }).findings.map((f) => f.code);
  expect(codes).toContain("cluster.membership");
});

test("FO-DEPLOY01: missing environment rejected", async () => {
  const project = await registerGitProject("NoEnv");
  const cluster = await createCluster("C");
  await assignCluster(cluster, project);
  const { json } = await createRequest({
    projectPath: project,
    clusterId: cluster,
    environment: "staging",
    revision: "HEAD",
    requestedByRole: "owner",
  });
  expect(json?.status).toBe("preflight_failed");
  const codes = (json?.preflight as { findings: { code: string }[] }).findings.map((f) => f.code);
  expect(codes).toContain("environment.missing");
});

test("FO-DEPLOY01: invalid revision rejected", async () => {
  const project = await registerGitProject("BadRev");
  const cluster = await createCluster("D");
  await assignCluster(cluster, project);
  await declareEnv(project, "staging");
  const { json } = await createRequest({
    projectPath: project,
    clusterId: cluster,
    environment: "staging",
    revision: "not-a-real-ref-xyz",
    requestedByRole: "owner",
  });
  expect(json?.status).toBe("preflight_failed");
});

test("FO-DEPLOY01: PM and Head proposals await Owner approval", async () => {
  for (const role of ["project-manager", "head-of-pm"] as const) {
    const project = await registerGitProject(`PM-${role}`);
    const cluster = await createCluster(`C-${role}`);
    await assignCluster(cluster, project);
    await declareEnv(project, "staging");
    await linkCicd(project, "staging", cluster);
    const { json } = await createRequest({
      projectPath: project,
      clusterId: cluster,
      environment: "staging",
      revision: "HEAD",
      requestedByRole: role,
    });
    expect(json?.status).toBe("awaiting_owner");
    expect(json?.requestedByRole).toBe(role);
  }
});

test("FO-DEPLOY01: duplicate approval rejected", async () => {
  const project = await registerGitProject("Dup");
  const cluster = await createCluster("DupC");
  await assignCluster(cluster, project);
  await declareEnv(project, "staging");
  await linkCicd(project, "staging", cluster);
  const { json } = await createRequest({
    projectPath: project,
    clusterId: cluster,
    environment: "staging",
    revision: "HEAD",
    requestedByRole: "owner",
  });
  const digest = json?.approvalDigest as string;
  const first = await fetch(url(`/deployment-requests/${json?.id}/approve`), {
    method: "POST",
    headers: auth(),
    body: JSON.stringify({ approvalDigest: digest }),
  });
  expect(first.ok).toBe(true);
  const second = await fetch(url(`/deployment-requests/${json?.id}/approve`), {
    method: "POST",
    headers: auth(),
    body: JSON.stringify({ approvalDigest: digest }),
  });
  expect(second.status).toBe(409);
});

test("FO-DEPLOY01: patch invalidates stale approval digest", async () => {
  const project = await registerGitProject("Patch");
  const cluster = await createCluster("PatchC");
  await assignCluster(cluster, project);
  await declareEnv(project, "staging");
  await linkCicd(project, "staging", cluster);
  const { json } = await createRequest({
    projectPath: project,
    clusterId: cluster,
    environment: "staging",
    revision: "HEAD",
    requestedByRole: "owner",
  });
  const stale = json?.approvalDigest as string;
  const patched = await fetch(url(`/deployment-requests/${json?.id}`), {
    method: "PATCH",
    headers: auth(),
    body: JSON.stringify({ revision: "HEAD" }),
  });
  expect(patched.ok).toBe(true);
  const fresh = (await patched.json()) as { approvalDigest: string };
  const bad = await fetch(url(`/deployment-requests/${json?.id}/approve`), {
    method: "POST",
    headers: auth(),
    body: JSON.stringify({ approvalDigest: stale }),
  });
  expect(bad.status).toBe(409);
  const good = await fetch(url(`/deployment-requests/${json?.id}/approve`), {
    method: "POST",
    headers: auth(),
    body: JSON.stringify({ approvalDigest: fresh.approvalDigest }),
  });
  expect(good.ok).toBe(true);
});

test("FO-DEPLOY01: missing adapter is NOT_CONFIGURED", async () => {
  const prev = process.env.FORGEORBIT_DEPLOYMENT_DRY_RUN_ADAPTER;
  delete process.env.FORGEORBIT_DEPLOYMENT_DRY_RUN_ADAPTER;
  const project = await registerGitProject("NoAdapter");
  const cluster = await createCluster("NoAdapterC");
  await assignCluster(cluster, project);
  await declareEnv(project, "staging");
  await linkCicd(project, "staging", cluster);
  const { json } = await createRequest({
    projectPath: project,
    clusterId: cluster,
    environment: "staging",
    revision: "HEAD",
    requestedByRole: "owner",
  });
  const approve = await fetch(url(`/deployment-requests/${json?.id}/approve`), {
    method: "POST",
    headers: auth(),
    body: JSON.stringify({ approvalDigest: json?.approvalDigest }),
  });
  const done = (await approve.json()) as { status: string; dryRun: { outcome: string } };
  expect(done.status).toBe("dry_run_not_configured");
  expect(done.dryRun.outcome).toBe("NOT_CONFIGURED");
  if (prev) process.env.FORGEORBIT_DEPLOYMENT_DRY_RUN_ADAPTER = prev;
  else process.env.FORGEORBIT_DEPLOYMENT_DRY_RUN_ADAPTER = "1";
});

test("FO-DEPLOY01: history survives new core instance", async () => {
  const list = await fetch(url("/deployment-requests"), { headers: auth() });
  const before = ((await list.json()) as { requests: unknown[] }).requests.length;
  expect(before).toBeGreaterThan(0);
  const { DeploymentRequestCore } = await import("./deployment-request-core.ts");
  const core = new DeploymentRequestCore(db);
  expect(core.list().length).toBe(before);
});

test("FO-DEPLOY01: Needs You lists pending deployment decisions", async () => {
  const project = await registerGitProject("NeedsYou");
  const cluster = await createCluster("NeedsYouC");
  await assignCluster(cluster, project);
  await declareEnv(project, "staging");
  await linkCicd(project, "staging", cluster);
  await createRequest({
    projectPath: project,
    clusterId: cluster,
    environment: "staging",
    revision: "HEAD",
    requestedByRole: "project-manager",
  });
  const owner = await fetch(url("/owner-actions"), { headers: auth() });
  const payload = (await owner.json()) as { deploymentRequestHolds: { id: string }[] };
  expect(payload.deploymentRequestHolds?.length).toBeGreaterThan(0);
});

test("FO-DEPLOY01: FO-AUTO01 grant does not authorize deployment", async () => {
  const { makeTask } = await import("../cli/test-fixtures.ts");
  const { tasks } = await import("./db.ts");
  const workdir = await registerGitProject("AutoBypass");
  const now = Date.now();
  const task = tasks.insert(
    makeTask({
      id: randomUUID(),
      title: "Auto",
      prompt: "x",
      column: "ready",
      workdir,
      model: "opus-5.5",
      effort: "high",
      mode: "auto",
      createdAt: now,
      updatedAt: now,
    }),
  );
  const grant = await fetch(url(`/tasks/${task.id}/orchestrated-workflow`), {
    method: "POST",
    headers: auth(),
    body: JSON.stringify({
      implementerEmployeeId: randomUUID(),
      implementerHarnessId: "claude-code",
      implementerModel: "opus-5.5",
      reviewerHarness: "claude-code",
      reviewerModel: "haiku-5.5",
      autoReviewAfterImplementation: false,
      autoReworkOnChanges: false,
      maxLaunches: 1,
    }),
  });
  expect(grant.status).toBeGreaterThanOrEqual(400);
  const holds = await fetch(url("/owner-actions"), { headers: auth() });
  const data = (await holds.json()) as { deploymentRequestHolds: unknown[] };
  expect(Array.isArray(data.deploymentRequestHolds)).toBe(true);
});
