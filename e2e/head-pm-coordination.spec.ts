/**
 * FO-HEAD01 — Head of PM cross-project coordination (fake codex driver, no live models).
 */
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test, expect, type APIRequestContext, type E2EBackend, type Page } from "./fixtures";
import { gotoApp } from "./helpers";

test.describe.configure({ mode: "serial" });
test.use({
  backendEnv: {
    AGETOR_CODEX_DRIVER: "fake",
    AGETOR_CODEX_BIN: "/bin/echo",
    AGETOR_FAKE_PORTFOLIO_DELAY_MS: "300",
    AGETOR_FAKE_MANAGER_DELAY_MS: "300",
  },
});

const auth = (b: E2EBackend) => ({ authorization: `Bearer ${b.apiToken}` });

/** Isolated backends start with harness rows disabled; preflight requires enabled (SQLite only). */
async function enableCodex(request: APIRequestContext, b: E2EBackend): Promise<void> {
  const res = await request.patch(`${b.apiBase}/harnesses/codex`, { headers: auth(b), data: { enabled: true } });
  expect(res.ok(), await res.text()).toBeTruthy();
}

async function api(request: APIRequestContext, b: E2EBackend, method: string, route: string, data?: unknown, ok = 200) {
  const res = await request.fetch(`${b.apiBase}${route}`, {
    method,
    headers: { ...auth(b), ...(data ? { "content-type": "application/json" } : {}) },
    data,
  });
  expect(res.status(), await res.text()).toBe(ok);
  return res.status() === 204 ? null : await res.json();
}

async function registerProject(request: APIRequestContext, b: E2EBackend, name: string): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), `fo-head01-${name.replace(/\W+/g, "-")}-`));
  await api(request, b, "POST", "/projects", { path: dir, name });
  return dir;
}

async function consentKey(request: APIRequestContext, b: E2EBackend): Promise<string> {
  const body = await api(request, b, "POST", "/project-interviews/preflight", { harness: "codex", model: "gpt-6.1-sol" });
  return body.isolation.consentKey as string;
}

async function configureManagers(request: APIRequestContext, b: E2EBackend, dirs: string[]): Promise<void> {
  await enableCodex(request, b);
  const key = await consentKey(request, b);
  await api(request, b, "PUT", "/portfolio-manager/config", {
    config: { harness: "codex", model: "gpt-6.1-sol", effort: "low", consentKey: key },
  });
  for (const dir of dirs) {
    await api(request, b, "PUT", "/project-manager/config", {
      path: dir,
      config: { harness: "codex", model: "gpt-6.1-sol", effort: "low", consentKey: key },
    });
    await api(request, b, "POST", "/employees/project-managers", { projectPath: dir }, 201);
  }
}

const orb = (page: Page) => page.getByTestId("head-pm-orb");
const panel = (page: Page) => page.getByTestId("head-pm-panel");

test("Head of PM shows two clusters and completes Owner delegation to one project (fake driver)", async ({ page, request, backend: b }) => {
  await gotoApp(page, b.bootBase);
  const alpha = await registerProject(request, b, "Alpha Auth");
  const beta = await registerProject(request, b, "Beta Side");
  const cAlpha = await api(request, b, "POST", "/clusters", { name: "Cluster Alpha" }, 201);
  const cBeta = await api(request, b, "POST", "/clusters", { name: "Cluster Beta" }, 201);
  await api(request, b, "POST", `/clusters/${cAlpha.id}/projects`, { projectPath: alpha }, 201);
  await api(request, b, "POST", `/clusters/${cBeta.id}/projects`, { projectPath: beta }, 201);
  await configureManagers(request, b, [alpha, beta]);

  await orb(page).click();
  await expect(panel(page)).toBeVisible();
  await page.getByTestId("head-pm-context-all").click();
  await expect(page.getByTestId("head-pm-coordination")).toBeVisible({ timeout: 10_000 });
  await expect(page.getByTestId("head-pm-coordination-cluster").filter({ hasText: "Cluster Alpha" })).toBeVisible();
  await expect(page.getByTestId("head-pm-coordination-cluster").filter({ hasText: "Cluster Beta" })).toBeVisible();

  await page.getByTestId("head-pm-composer").fill("Delegate to the manager of Alpha Auth — prepare authentication refactor");
  await page.getByTestId("head-pm-send").click();
  await expect(page.getByTestId("head-pm-busy")).toHaveCount(0, { timeout: 20_000 });

  const delegation = page.getByTestId("portfolio-delegation").first();
  await expect(delegation).toHaveAttribute("data-status", "proposed");
  await expect(delegation).toContainText("Alpha");

  await delegation.getByTestId("portfolio-delegation-approve").click();
  await page.getByRole("dialog").getByRole("button", { name: "Send request" }).click();
  await expect(delegation).toHaveAttribute("data-status", /^(sent|answered)$/, { timeout: 20_000 });

  const alphaPm = await api(request, b, "GET", `/project-manager?path=${encodeURIComponent(alpha)}`);
  expect(alphaPm.messages.some((m: { delegationId?: string }) => m.delegationId)).toBe(true);
  const betaPm = await api(request, b, "GET", `/project-manager?path=${encodeURIComponent(beta)}`);
  expect(betaPm.messages.filter((m: { role: string }) => m.role === "owner").length).toBe(0);

  const portfolioState = await api(request, b, "GET", "/portfolio-manager");
  const delRow = portfolioState.delegations.find((d: { projectPath: string }) => d.projectPath === alpha)!;
  const again = await request.post(`${b.apiBase}/portfolio-manager/delegations/${encodeURIComponent(delRow.id)}/approve`, {
    headers: auth(b),
    data: { revision: delRow.revision },
  });
  expect(again.status()).toBe(200);
  expect((await again.json()).alreadySent).toBe(true);

  const coord = await api(request, b, "GET", "/portfolio-manager/coordination");
  expect(coord.projects.find((p: { projectPath: string }) => p.projectPath === alpha)?.clusterName).toBe("Cluster Alpha");
  expect(coord.delegations.some((d: { status: string }) => d.status === "sent" || d.status === "answered")).toBe(true);
});
