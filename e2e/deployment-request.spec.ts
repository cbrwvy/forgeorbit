import { execFileSync, execSync } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { expect, test as base } from "./fixtures";
import { gotoApp, openWorkspaces } from "./helpers";

const test = base.extend<{ deploymentProject: string }>({
  deploymentProject: async ({}, use) => {
    const dir = await mkdtemp(path.join(tmpdir(), "fo-deploy-e2e-"));
    try { await use(dir); }
    finally { await rm(dir, { recursive: true, force: true }); }
  },
});

test("FO-DEPLOY02 staging request, dry-run, and synthetic execution authorization", async ({ page, freshBackend: backend, deploymentProject: dir }) => {
  const auth = { authorization: `Bearer ${backend.apiToken}` };

  await execSync("git init -b main", { cwd: dir, stdio: "ignore" });
  await execSync("git config user.email e2e@test.local", { cwd: dir, stdio: "ignore" });
  await execSync("git config user.name E2E", { cwd: dir, stdio: "ignore" });
  await execSync("git commit --allow-empty -m init", { cwd: dir, stdio: "ignore" });

  const projectRes = await page.request.post(`${backend.apiBase}/projects`, {
    headers: auth,
    data: { path: dir, name: "Deploy E2E" },
  });
  expect(projectRes.ok(), await projectRes.text()).toBeTruthy();

  const clusterRes = await page.request.post(`${backend.apiBase}/clusters`, {
    headers: auth,
    data: { name: "E2E Cluster" },
  });
  expect(clusterRes.ok()).toBeTruthy();
  const clusterId = (await clusterRes.json()).id as string;

  await page.request.post(`${backend.apiBase}/clusters/${clusterId}/projects`, {
    headers: auth,
    data: { projectPath: dir },
  });
  await page.request.post(`${backend.apiBase}/infrastructure/project-environments`, {
    headers: auth,
    data: { projectPath: dir, environment: "staging" },
  });
  const resource = await page.request.post(`${backend.apiBase}/infrastructure/resources`, {
    headers: auth,
    data: { name: "E2E CI", resourceType: "cicd", clusterIds: [clusterId], projectPaths: [dir] },
  });
  expect(resource.ok()).toBeTruthy();
  const resourceId = (await resource.json()).id as string;
  await page.request.post(`${backend.apiBase}/infrastructure/resources/${resourceId}/environment-links`, {
    headers: auth,
    data: { projectPath: dir, environment: "staging" },
  });
  await page.request.post(`${backend.apiBase}/deployment-staging-integrations`, {
    headers: auth,
    data: {
      clusterId,
      projectPath: dir,
      integrationType: "forgeorbit-fake-staging-v1",
      integrationLabel: "E2E Fake",
      projectSlug: "demo",
      entrypointRef: "@forgeorbit-fake-staging-v1",
    },
  });

  await gotoApp(page, backend.bootBase);
  await openWorkspaces(page);
  await page.getByTestId("clusters-more").click();
  await page.getByTestId("clusters-more-menu-infrastructure").click();
  await expect(page.getByTestId("deployment-requests-panel")).toBeVisible();

  await page.getByTestId("deployment-project").selectOption({ label: "Deploy E2E" });
  await page.getByTestId("deployment-cluster").selectOption({ label: "E2E Cluster" });
  await page.getByTestId("deployment-actor-role").selectOption("project-manager");
  await page.getByTestId("deployment-submit").click();

  const row = page.getByTestId("deployment-request-row").filter({ hasText: "Deploy E2E" });
  await expect(row).toHaveAttribute("data-status", "awaiting_owner");
  await expect(row.getByTestId("deployment-plan")).toBeVisible();

  const owner = await page.request.get(`${backend.apiBase}/owner-actions`, { headers: auth });
  const holds = (await owner.json()).deploymentRequestHolds as unknown[];
  expect(holds.length).toBeGreaterThan(0);

  await page.getByTestId("deployment-actor-role").selectOption("owner");
  await row.getByTestId("deployment-approve").click();
  await expect(row).toHaveAttribute("data-status", "dry_run_complete");
  await expect(row.getByTestId("deployment-dry-run-result")).toHaveAttribute("data-outcome", "SIMULATED");
  await expect(row.getByTestId("deployment-dry-run-result")).toContainText("synthetic adapter");
  await expect(row).toHaveAttribute("data-execution-state", "awaiting_execution_auth");
  await expect(row.getByTestId("deployment-execution-readiness")).toBeVisible();

  await page.getByTestId("deployment-actor-role").selectOption("project-manager");
  await expect(row.getByTestId("deployment-authorize-execution")).toHaveCount(0);

  await page.getByTestId("deployment-actor-role").selectOption("owner");
  await row.getByTestId("deployment-authorize-execution").click();
  await expect(row).toHaveAttribute("data-execution-state", "ready_to_execute");
  await expect(row.getByTestId("deployment-execution-authorized")).toBeVisible();
  await expect(row.getByTestId("deployment-owner-confirmation")).toContainText("unsupported");
  await expect(row.getByTestId("deployment-synthetic-authorization")).toContainText("issued; unused");
  await expect(row.getByTestId("deployment-authorize-execution")).toHaveCount(0);

  const ownerAfter = await page.request.get(`${backend.apiBase}/owner-actions`, { headers: auth });
  const execHolds = (await ownerAfter.json()).deploymentExecutionAuthHolds as unknown[];
  expect(execHolds.length).toBe(0);
  await row.getByTestId("deployment-revoke-execution").click();
  await expect(row).toHaveAttribute("data-execution-state", "awaiting_execution_auth");
  await expect(row).toContainText("Execution authorization revoked.");
  await expect(row.getByTestId("deployment-synthetic-authorization")).toContainText("not issued or revoked");
});

test.describe("FO-DEPLOY04 External staging manual handoff", () => {
  test.use({ backendEnv: {
    FORGEORBIT_DEPLOYMENT_STAGING_ADAPTER: "external",
  } });

  test("unsupported confirmation never enables real execution; exact review packet on desktop and mobile", async ({ page, freshBackend: backend, deploymentProject: dir }) => {
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    const auth = { authorization: `Bearer ${backend.apiToken}` };
    const git = (...args: string[]) => execFileSync("git", args, { cwd: dir, encoding: "utf8" }).trim();
    git("init", "-b", "main");
    git("-c", "user.name=E2E", "-c", "user.email=e2e@example.invalid", "commit", "--allow-empty", "-m", "fixture");
    const sha = git("rev-parse", "HEAD");
    const reference = `ghcr.io/example-company/example-project@sha256:${"a".repeat(64)}`;
    const catalog = path.join(dir, "published-images.env");
    await writeFile(catalog, `EXPECTED_SHA=${sha}\nEXAMPLE_PROJECT_SHA=${sha}\nEXAMPLE_PROJECT_IMAGE=${reference}\n`);
    const post = async (route: string, data: unknown) => {
      const res = await page.request.post(`${backend.apiBase}${route}`, { headers: auth, data });
      expect(res.ok(), await res.text()).toBeTruthy();
      return res.json();
    };
    await post("/projects", { path: dir, name: "External staging Review E2E" });
    const cluster = await post("/clusters", { name: "External staging Review Cluster" });
    await post(`/clusters/${cluster.id}/projects`, { projectPath: dir });
    await post("/infrastructure/project-environments", { projectPath: dir, environment: "staging" });
    const resource = await post("/infrastructure/resources", { name: "External staging fixture resource", resourceType: "cicd", clusterIds: [cluster.id], projectPaths: [dir] });
    await post(`/infrastructure/resources/${resource.id}/environment-links`, { projectPath: dir, environment: "staging" });
    await post("/deployment-staging-integrations", {
      clusterId: cluster.id, projectPath: dir, integrationType: "external-staging-v1",
      integrationLabel: "Local fixture only", projectSlug: "example-project",
      entrypointRef: path.resolve("scripts/fixtures/deploy-staging-fixture.sh"), imagesCatalogRef: catalog,
      realExecutionConfigured: true, realExecutionEnabled: true,
    });
    const request = await post("/deployment-requests", { projectPath: dir, clusterId: cluster.id,
      environment: "staging", revision: "HEAD", requestedByRole: "head-of-pm" });
    const record = await post(`/deployment-requests/${request.id}/approve`, { approvalDigest: request.approvalDigest });
    const denied = await page.request.post(`${backend.apiBase}/deployment-requests/${request.id}/authorize-execution`, {
      headers: auth, data: { executionAuthDigest: record.executionAuthDigest ?? "0".repeat(64), confirmOwner: true },
    });
    expect(denied.status()).toBe(409);
    // Config-only inspection deliberately does not promote this plan to execution auth.
    expect((await denied.json()).code).toBe("state");
    expect(record.status).toBe("dry_run_unsupported");

    await gotoApp(page, backend.bootBase);
    await openWorkspaces(page);
    await page.getByTestId("clusters-more").click();
    await page.getByTestId("clusters-more-menu-infrastructure").click();
    const row = page.getByTestId("deployment-request-row").filter({ hasText: "External staging Review E2E" });
    await expect(row.getByTestId("deployment-owner-confirmation")).toContainText("unsupported");
    await expect(row.getByTestId("deployment-owner-confirmation")).toContainText("Execution readiness: blocked");
    await expect(row.getByTestId("deployment-authorize-execution")).toHaveCount(0);
    await expect(row.getByTestId("deployment-plan-digest")).toContainText(record.planDigest);
    await expect(row.getByTestId("deployment-revision-sha")).toContainText(sha);
    await expect(row.getByTestId("deployment-image-artifacts")).toContainText(reference);
    await row.getByTestId("deployment-review-handoff").click();
    const packet = page.getByTestId("deployment-manual-handoff");
    await expect(packet).toContainText('"executionAuthorized": false');
    await expect(packet).toContainText('"dryRunOutcome": "UNSUPPORTED"');
    await expect(packet).toContainText(record.planDigest);
    await expect(packet).toContainText(cluster.id);
    await expect(packet).toContainText(reference);
    await page.setViewportSize({ width: 390, height: 844 });
    await expect(packet).toBeVisible();
    await expect(row.getByTestId("deployment-owner-confirmation")).toBeVisible();
    expect(await packet.evaluate((el) => el.scrollWidth <= el.clientWidth)).toBe(true);
    await packet.getByRole("button", { name: "Close review packet" }).click();
    await expect(packet).toHaveCount(0);
    const after = await page.request.get(`${backend.apiBase}/deployment-requests/${request.id}`, { headers: auth });
    expect(await after.json()).toMatchObject({ executionState: "none", executionAuthAt: null, attempts: [] });
    expect(errors).toEqual([]);
  });
});
