/**
 * FO-HEAD02 — Owner-facing cross-project initiative controls (fake codex driver).
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
  const dir = await mkdtemp(path.join(tmpdir(), `fo-head02-${name.replace(/\W+/g, "-")}-`));
  await api(request, b, "POST", "/projects", { path: dir, name });
  return dir;
}

async function enableCodex(request: APIRequestContext, b: E2EBackend): Promise<void> {
  await request.patch(`${b.apiBase}/harnesses/codex`, { headers: auth(b), data: { enabled: true } });
}

async function configureManagers(request: APIRequestContext, b: E2EBackend, dirs: string[]): Promise<void> {
  await enableCodex(request, b);
  const body = await api(request, b, "POST", "/project-interviews/preflight", { harness: "codex", model: "gpt-6.1-sol" });
  const key = body.isolation.consentKey as string;
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

test("Owner creates initiative, Head prepares two delegations, Owner approves both (fake driver)", async ({ page, request, backend: b }) => {
  await gotoApp(page, b.bootBase);
  const alpha = await registerProject(request, b, "Alpha Auth");
  const beta = await registerProject(request, b, "Beta Auth");
  const cAlpha = await api(request, b, "POST", "/clusters", { name: "Cluster Alpha" }, 201);
  const cBeta = await api(request, b, "POST", "/clusters", { name: "Cluster Beta" }, 201);
  await api(request, b, "POST", `/clusters/${cAlpha.id}/projects`, { projectPath: alpha }, 201);
  await api(request, b, "POST", `/clusters/${cBeta.id}/projects`, { projectPath: beta }, 201);
  await configureManagers(request, b, [alpha, beta]);

  await page.getByTestId("head-pm-orb").click();
  await page.getByTestId("head-pm-context-all").click();
  await expect(page.getByTestId("head-pm-initiatives")).toBeVisible({ timeout: 10_000 });

  await page.getByTestId("head-pm-initiative-create").click();
  await page.getByTestId("head-pm-initiative-title").fill("Coordinate authentication");
  await page.locator(`[data-testid="head-pm-initiative-project-pick"][data-path="${alpha}"]`).check();
  await page.locator(`[data-testid="head-pm-initiative-project-pick"][data-path="${beta}"]`).check();
  await page.getByTestId("head-pm-initiative-submit").click();
  await expect(page.getByTestId("head-pm-initiative-detail")).toBeVisible();
  await expect(page.getByTestId("head-pm-initiative-contribution")).toHaveCount(2);

  await page.locator(`[data-testid="head-pm-initiative-prepare"][data-path="${alpha}"]`).click();
  await page.locator(`[data-testid="head-pm-initiative-prepare"][data-path="${beta}"]`).click();
  await expect(page.getByTestId("portfolio-delegation")).toHaveCount(2);
  await expect(page.getByTestId("portfolio-delegation").first()).toHaveAttribute("data-status", "proposed");

  expect((await api(request, b, "GET", `/project-manager?path=${encodeURIComponent(alpha)}`)).messages).toEqual([]);
  expect((await api(request, b, "GET", `/project-manager?path=${encodeURIComponent(beta)}`)).messages).toEqual([]);

  const delegations = page.getByTestId("portfolio-delegation");
  await delegations.nth(0).getByTestId("portfolio-delegation-approve").click();
  await page.getByRole("dialog").getByRole("button", { name: "Send request" }).click();
  await expect(delegations.nth(0)).toHaveAttribute("data-status", /^(sent|answered)$/, { timeout: 20_000 });
  await delegations.nth(1).getByTestId("portfolio-delegation-approve").click();
  await page.getByRole("dialog").getByRole("button", { name: "Send request" }).click();
  await expect(delegations.nth(1)).toHaveAttribute("data-status", /^(sent|answered)$/, { timeout: 20_000 });

  await expect.poll(async () => {
    const alphaPm = await api(request, b, "GET", `/project-manager?path=${encodeURIComponent(alpha)}`);
    return alphaPm.messages.filter((m: { role: string; delegationId?: string }) => m.role === "owner" && m.delegationId).length;
  }).toBe(1);
  await expect.poll(async () => {
    const betaPm = await api(request, b, "GET", `/project-manager?path=${encodeURIComponent(beta)}`);
    return betaPm.messages.filter((m: { role: string; delegationId?: string }) => m.role === "owner" && m.delegationId).length;
  }).toBe(1);

  const alphaPm = await api(request, b, "GET", `/project-manager?path=${encodeURIComponent(alpha)}`);
  const betaPm = await api(request, b, "GET", `/project-manager?path=${encodeURIComponent(beta)}`);
  const alphaDel = alphaPm.messages.find((m: { delegationId?: string }) => m.delegationId)?.delegationId;
  const betaDel = betaPm.messages.find((m: { delegationId?: string }) => m.delegationId)?.delegationId;
  expect(alphaDel).toBeTruthy();
  expect(betaDel).toBeTruthy();
  expect(alphaDel).not.toBe(betaDel);

  const list = await api(request, b, "GET", "/head-pm/initiatives");
  expect(list).toHaveLength(1);
  expect(list[0]!.contributions.every((c: { delegationId: string | null }) => c.delegationId)).toBe(true);
});
