/**
 * FO-HEAD03 E2E — Head chat → initiative proposal → Owner approval → delegations.
 */
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test, expect, type APIRequestContext, type E2EBackend } from "./fixtures";
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
  const dir = await mkdtemp(path.join(tmpdir(), `fo-head03-${name.replace(/\W+/g, "-")}-`));
  await api(request, b, "POST", "/projects", { path: dir, name });
  return dir;
}

async function configureManagers(request: APIRequestContext, b: E2EBackend, dirs: string[]): Promise<void> {
  await request.patch(`${b.apiBase}/harnesses/codex`, { headers: auth(b), data: { enabled: true } });
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

test("Head chat proposes initiative, Owner approves, prepares delegations (fake driver)", async ({ page, request, backend: b }) => {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await gotoApp(page, b.bootBase);
  const alpha = await registerProject(request, b, "Project Alpha");
  const beta = await registerProject(request, b, "Project Beta");
  const cAlpha = await api(request, b, "POST", "/clusters", { name: "Cluster Alpha" }, 201);
  const cBeta = await api(request, b, "POST", "/clusters", { name: "Cluster Beta" }, 201);
  await api(request, b, "POST", `/clusters/${cAlpha.id}/projects`, { projectPath: alpha }, 201);
  await api(request, b, "POST", `/clusters/${cBeta.id}/projects`, { projectPath: beta }, 201);
  await configureManagers(request, b, [alpha, beta]);

  await page.getByTestId("head-pm-orb").click();
  await page.getByTestId("head-pm-context-all").click();
  await page.getByTestId("head-pm-composer").fill(
    "Coordinate authentication improvements across Project Alpha and Project Beta. Assign preparation to their project managers.",
  );
  await page.getByTestId("head-pm-send").click();
  await expect(page.getByTestId("head-pm-initiative-proposal")).toBeVisible({ timeout: 20_000 });
  await expect(page.getByTestId("head-pm-initiative-proposal-project")).toHaveCount(2);
  const proposal = page.getByTestId("head-pm-initiative-proposal");
  await expect(proposal).toHaveAttribute("data-status", "proposed");
  await expect(proposal.getByTestId("head-pm-initiative-proposal-title")).toHaveValue(/authentication/i);
  await expect(proposal.getByTestId("head-pm-initiative-proposal-goal")).not.toHaveValue("");
  await expect(proposal.getByTestId("head-pm-initiative-proposal-project").nth(0)).toContainText("Project Alpha");
  await expect(proposal.getByTestId("head-pm-initiative-proposal-project").nth(1)).toContainText("Project Beta");
  expect(await api(request, b, "GET", "/head-pm/initiatives")).toHaveLength(0);

  const writes: string[] = [];
  page.on("request", (req) => {
    if (req.url().startsWith(b.apiBase) && !["GET", "OPTIONS"].includes(req.method())) {
      writes.push(new URL(req.url()).pathname);
    }
  });

  const portfolioBefore = await api(request, b, "GET", "/portfolio-manager");
  expect(portfolioBefore.delegations.filter((d: { status: string }) => d.status === "proposed")).toHaveLength(0);
  const managerMsg = portfolioBefore.messages.find((m: { role: string; initiativeProposalId?: string }) => m.role === "manager" && m.initiativeProposalId);
  expect(managerMsg?.initiativeProposalId).toBeTruthy();
  const approval = page.waitForResponse((res) =>
    res.url().endsWith(`/head-pm/initiative-proposals/${managerMsg!.initiativeProposalId}/approve`)
      && res.request().method() === "POST",
  );
  // The card calls approve directly; there is no secondary confirmation dialog.
  await proposal.getByTestId("head-pm-initiative-proposal-approve").click();
  expect((await approval).status()).toBe(200);
  await expect(proposal).toHaveAttribute("data-status", "approved");
  await expect(proposal.getByTestId("head-pm-initiative-proposal-approve")).toHaveCount(0);
  await expect(page.getByTestId("head-pm-initiative-row")).toHaveCount(1, { timeout: 15_000 });
  await expect(page.getByTestId("head-pm-initiative-detail")).toBeVisible({ timeout: 10_000 });
  await expect(page.getByTestId("head-pm-initiative-contribution")).toHaveCount(2);
  await expect(page.getByTestId("head-pm-initiative-from-chat")).toBeVisible();
  await expect(page.getByTestId("head-pm-initiative-row")).toBeInViewport();
  await expect(page.getByTestId("head-pm-initiatives")).toBeFocused();

  // Revisit the persisted card and use its replacement Open control repeatedly.
  await page.getByTestId("head-pm-orb").click();
  await page.getByTestId("head-pm-orb").click();
  await proposal.getByTestId("head-pm-initiative-proposal-open").click();
  await expect(page.getByTestId("head-pm-initiative-row")).toBeInViewport();
  await expect(page.getByTestId("head-pm-initiatives")).toBeFocused();
  await proposal.getByTestId("head-pm-initiative-proposal-open").click();
  await expect(page.getByTestId("head-pm-initiative-row")).toBeInViewport();
  await expect(page.getByTestId("head-pm-initiatives")).toBeFocused();
  await expect(page.getByTestId("head-pm-initiative-row")).toHaveCount(1);
  expect(await api(request, b, "GET", "/head-pm/initiatives")).toHaveLength(1);

  await page.locator(`[data-testid="head-pm-initiative-prepare"][data-path="${alpha}"]`).click();
  await page.locator(`[data-testid="head-pm-initiative-prepare"][data-path="${beta}"]`).click();
  await expect(page.locator('[data-testid="portfolio-delegation"]')).toHaveCount(2, { timeout: 10_000 });

  const list = await api(request, b, "GET", "/head-pm/initiatives");
  expect(list.filter((i: { title: string }) => i.title.includes("authentication"))).toHaveLength(1);
  const final = await api(request, b, "GET", "/portfolio-manager");
  expect(final.delegations).toHaveLength(2);
  expect(final.delegations.every((d: { status: string }) => d.status === "proposed")).toBe(true);
  expect(await api(request, b, "GET", "/tasks")).toHaveLength(0);
  expect(writes.filter((route) => route.endsWith("/approve"))).toEqual([
    `/head-pm/initiative-proposals/${managerMsg!.initiativeProposalId}/approve`,
  ]);
  expect(writes.filter((route) => /\/(start|execute|deploy|launch)(\/|$)/.test(route))).toEqual([]);
  expect(errors).toEqual([]);
});
