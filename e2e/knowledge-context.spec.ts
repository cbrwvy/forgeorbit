import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test, expect, type APIRequestContext, type E2EBackend, type Page } from "./fixtures";
import { gotoApp, openPortfolio } from "./helpers";

/**
 * FO-011E: choosing knowledge notes for an AI manager, reviewing them, and
 * the owner's one-message confirmation. Every agent is the fake codex driver
 * (no real CLI, no AI quota); each test has its own backend and data dir.
 */

test.describe.configure({ mode: "serial" });
test.use({
  backendEnv: {
    AGETOR_CODEX_DRIVER: "fake",
    AGETOR_CODEX_BIN: "/bin/echo",
    AGETOR_FAKE_MANAGER_DELAY_MS: "300",
    AGETOR_FAKE_PORTFOLIO_DELAY_MS: "300",
  },
});

const auth = (backend: E2EBackend) => ({ authorization: `Bearer ${backend.apiToken}` });

async function enableCodex(request: APIRequestContext, backend: E2EBackend): Promise<void> {
  const res = await request.patch(`${backend.apiBase}/harnesses/codex`, { headers: auth(backend), data: { enabled: true } });
  expect(res.ok(), await res.text()).toBeTruthy();
}

async function registerProject(request: APIRequestContext, backend: E2EBackend, name: string): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), `fo011e-${name.replace(/\W+/g, "-")}-`));
  const res = await request.post(`${backend.apiBase}/projects`, { headers: auth(backend), data: { path: dir, name } });
  expect(res.ok(), await res.text()).toBeTruthy();
  return (await res.json()).path as string;
}

async function addNote(
  request: APIRequestContext,
  backend: E2EBackend,
  ownerKind: string,
  ownerId: string,
  title: string,
  content: string,
  sensitive = false,
): Promise<{ id: string; revision: number }> {
  const res = await request.post(`${backend.apiBase}/knowledge/documents`, {
    headers: auth(backend),
    data: { ownerKind, ownerId, title, content, sensitive },
  });
  expect(res.status(), await res.text()).toBe(201);
  return await res.json();
}

async function transmissions(request: APIRequestContext, backend: E2EBackend, target: string): Promise<any[]> {
  const res = await request.get(`${backend.apiBase}/knowledge/context/transmissions?${target}`, { headers: auth(backend) });
  expect(res.status()).toBe(200);
  return (await res.json()).transmissions;
}

async function openManager(page: Page, dir: string): Promise<void> {
  await page.locator(`[data-testid="project-nav-item"][data-path="${dir}"]`).click();
  await expect(page.getByTestId("project-header-name")).toBeVisible();
  await page.getByTestId("project-page-manager").click();
  await expect(page.getByTestId("manager-page")).toBeVisible();
}

async function setUpAgent(page: Page): Promise<void> {
  await expect(page.getByTestId("manager-harness")).toHaveValue("codex", { timeout: 20_000 });
  await page.getByTestId("manager-consent").check();
  await expect(page.getByTestId("manager-connection")).toHaveText("Ready");
}

function countPosts(page: Page, needle: string): () => number {
  let count = 0;
  page.on("request", (req) => {
    if (req.method() === "POST" && req.url().includes(needle)) count += 1;
  });
  return () => count;
}

const picker = (page: Page) => page.getByTestId("manager-knowledge");
const rowFor = (page: Page, title: string) => picker(page).getByTestId("manager-knowledge-row").filter({ hasText: title });

async function openPicker(page: Page): Promise<void> {
  await page.getByTestId("manager-knowledge-toggle").click();
  await expect(page.getByTestId("manager-knowledge-panel")).toBeVisible();
  await expect(page.getByTestId("manager-knowledge-loading")).toHaveCount(0);
}

async function world(request: APIRequestContext, backend: E2EBackend) {
  await enableCodex(request, backend);
  const dir = await registerProject(request, backend, "ExampleApp");
  const other = await registerProject(request, backend, "Elsewhere");
  const company = await addNote(request, backend, "company", "company:forgeorbit", "Company conventions", "Use small commits.");
  const own = await addNote(request, backend, "project", dir, "ExampleApp decisions", "Ship the editor first.");
  const foreign = await addNote(request, backend, "project", other, "Elsewhere decisions", "FOREIGN_BODY");
  const secret = await addNote(request, backend, "project", dir, "Server access", "SENSITIVE_BODY", true);
  return { dir, other, company, own, foreign, secret };
}

test("select, review, confirm and send: nothing leaves before Send, and the permission is spent once", async ({ page, request, freshBackend: backend }) => {
  test.slow();
  const w = await world(request, backend);
  const sends = countPosts(page, "/project-manager/messages");
  const grants = countPosts(page, "/knowledge/context/grants");

  await gotoApp(page, backend.bootBase);
  await openManager(page, w.dir);
  await setUpAgent(page);
  // Nothing is attached by default.
  await expect(page.getByTestId("manager-knowledge-summary")).toHaveText("None selected");

  await openPicker(page);
  await expect(page.getByTestId("manager-knowledge-search")).toBeFocused();
  // Only this manager's scope is listed; the other project's note is not.
  await expect(picker(page).getByTestId("manager-knowledge-row")).toHaveCount(3);
  await expect(page.getByText("Elsewhere decisions")).toHaveCount(0);
  await expect(picker(page).getByTestId("manager-knowledge-group-company")).toContainText("Company conventions");
  await expect(picker(page).getByTestId("manager-knowledge-group-project")).toContainText("ExampleApp decisions");
  // The sensitive note is visible but can't be chosen.
  const secretRow = rowFor(page, "Server access");
  await expect(secretRow.getByTestId("manager-knowledge-check")).toBeDisabled();
  await expect(secretRow.getByTestId("manager-knowledge-reason")).toContainText("never sent");

  // Search narrows the list.
  await page.getByTestId("manager-knowledge-search").fill("conventions");
  await expect(picker(page).getByTestId("manager-knowledge-row")).toHaveCount(1);
  await page.getByTestId("manager-knowledge-search").fill("zzz-no-match");
  await expect(page.getByTestId("manager-knowledge-no-match")).toBeVisible();
  await page.getByTestId("manager-knowledge-search").fill("");

  await rowFor(page, "Company conventions").getByTestId("manager-knowledge-check").check();
  await rowFor(page, "ExampleApp decisions").getByTestId("manager-knowledge-check").check();
  // Choosing is not consent: nothing was confirmed or sent.
  await expect(page.getByTestId("manager-knowledge-summary")).toHaveText("2 selected, not sent");
  await expect(page.getByTestId("manager-knowledge-approve")).toBeDisabled();
  expect(grants()).toBe(0);

  await page.getByTestId("manager-knowledge-preview-button").click();
  const preview = page.getByTestId("manager-knowledge-preview");
  await expect(preview).toBeVisible();
  await expect(preview).toContainText("Project manager · ExampleApp");
  await expect(preview.getByTestId("manager-knowledge-preview-item")).toHaveCount(2);
  await expect(preview).toContainText("rev 1");
  await expect(page.getByTestId("manager-knowledge-budget")).toContainText("Unknown token estimate");
  await expect(page.getByTestId("manager-knowledge-budget")).toContainText("2 of 8 notes");
  expect(grants()).toBe(0);

  await page.getByTestId("manager-knowledge-approve").click();
  await expect(page.getByTestId("manager-knowledge-summary")).toHaveText("2 notes approved for the next message");
  await expect(page.getByTestId("manager-knowledge-panel")).toHaveCount(0);
  await expect(page.getByTestId("manager-knowledge-toggle")).toBeFocused();
  expect(grants()).toBe(1);
  expect(sends()).toBe(0);
  expect(await transmissions(request, backend, `managerKind=project&projectPath=${encodeURIComponent(w.dir)}`)).toMatchObject([{ status: "approved" }]);

  await page.getByTestId("manager-composer").fill("What should we do next?");
  await page.getByTestId("manager-send").click();
  await expect(page.getByTestId("manager-busy")).toBeVisible();
  await expect(page.getByTestId("manager-busy")).toHaveCount(0);
  expect(sends()).toBe(1);
  // The permission is spent: the picker is empty again.
  await expect(page.getByTestId("manager-knowledge-summary")).toHaveText("None selected");

  const audit = await transmissions(request, backend, `managerKind=project&projectPath=${encodeURIComponent(w.dir)}`);
  expect(audit).toHaveLength(1);
  expect(audit[0]).toMatchObject({ status: "consumed" });
  expect(audit[0].items.map((item: any) => item.title).sort()).toEqual(["Company conventions", "ExampleApp decisions"]);
  expect(JSON.stringify(audit)).not.toContain("Use small commits.");

  // The next message carries nothing unless the owner confirms again.
  await page.getByTestId("manager-composer").fill("And then?");
  await page.getByTestId("manager-send").click();
  await expect(page.getByTestId("manager-busy")).toBeVisible();
  await expect(page.getByTestId("manager-busy")).toHaveCount(0);
  expect(await transmissions(request, backend, `managerKind=project&projectPath=${encodeURIComponent(w.dir)}`)).toHaveLength(1);
});

test("cancel: a confirmed selection can be withdrawn and then nothing is attached", async ({ page, request, freshBackend: backend }) => {
  const w = await world(request, backend);
  await gotoApp(page, backend.bootBase);
  await openManager(page, w.dir);
  await setUpAgent(page);
  await openPicker(page);
  await rowFor(page, "ExampleApp decisions").getByTestId("manager-knowledge-check").check();
  await page.getByTestId("manager-knowledge-preview-button").click();
  await page.getByTestId("manager-knowledge-approve").click();
  await expect(page.getByTestId("manager-knowledge-summary")).toContainText("1 note approved");
  await page.getByTestId("manager-knowledge-revoke").click();
  await expect(page.getByTestId("manager-knowledge-summary")).toHaveText("None selected");
  const audit = await transmissions(request, backend, `managerKind=project&projectPath=${encodeURIComponent(w.dir)}`);
  expect(audit).toMatchObject([{ status: "revoked" }]);
});

test("a note edited after the preview is not confirmed: the owner is asked to review again", async ({ page, request, freshBackend: backend }) => {
  const w = await world(request, backend);
  await gotoApp(page, backend.bootBase);
  await openManager(page, w.dir);
  await setUpAgent(page);
  await openPicker(page);
  await rowFor(page, "ExampleApp decisions").getByTestId("manager-knowledge-check").check();
  await page.getByTestId("manager-knowledge-preview-button").click();
  await expect(page.getByTestId("manager-knowledge-preview")).toContainText("rev 1");
  const edit = await request.patch(`${backend.apiBase}/knowledge/documents/${w.own.id}`, {
    headers: auth(backend),
    data: { expectedRevision: 1, content: "Changed after the owner looked." },
  });
  expect(edit.status()).toBe(200);
  await page.getByTestId("manager-knowledge-approve").click();
  await expect(page.getByTestId("manager-knowledge-error")).toBeVisible();
  await expect(page.getByTestId("manager-knowledge-issues")).toContainText("newer revision");
  await expect(page.getByTestId("manager-knowledge-summary")).not.toContainText("approved");
  // The preview is gone; reviewing again shows revision 2 and can be confirmed.
  await expect(page.getByTestId("manager-knowledge-preview")).toHaveCount(0);
  await page.getByTestId("manager-knowledge-preview-button").click();
  await expect(page.getByTestId("manager-knowledge-preview")).toContainText("rev 2");
  await page.getByTestId("manager-knowledge-approve").click();
  await expect(page.getByTestId("manager-knowledge-summary")).toContainText("1 note approved");
});

test("moving the project to another cluster voids a confirmed cluster note at send time", async ({ page, request, freshBackend: backend }) => {
  test.slow();
  await enableCodex(request, backend);
  const dir = await registerProject(request, backend, "Mover");
  const mk = async (name: string) => {
    const res = await request.post(`${backend.apiBase}/clusters`, { headers: auth(backend), data: { name } });
    expect(res.status()).toBe(201);
    return (await res.json()).id as string;
  };
  const oldCluster = await mk("Old cluster");
  const newCluster = await mk("New cluster");
  const assigned = await request.post(`${backend.apiBase}/clusters/${oldCluster}/projects`, { headers: auth(backend), data: { projectPath: dir } });
  expect(assigned.status()).toBe(201);
  await addNote(request, backend, "cluster", oldCluster, "Old cluster agreement", "OLD_CLUSTER_BODY");
  const sends = countPosts(page, "/project-manager/messages");

  await gotoApp(page, backend.bootBase);
  await openManager(page, dir);
  await setUpAgent(page);
  await openPicker(page);
  await rowFor(page, "Old cluster agreement").getByTestId("manager-knowledge-check").check();
  await page.getByTestId("manager-knowledge-preview-button").click();
  await page.getByTestId("manager-knowledge-approve").click();
  await expect(page.getByTestId("manager-knowledge-summary")).toContainText("1 note approved");

  const moved = await request.post(`${backend.apiBase}/clusters/${newCluster}/projects/move`, { headers: auth(backend), data: { projectPath: dir } });
  expect(moved.status()).toBe(200);

  await page.getByTestId("manager-composer").fill("Use the cluster notes");
  await page.getByTestId("manager-send").click();
  await expect(page.getByTestId("manager-error")).toBeVisible();
  expect(sends()).toBe(1);
  await expect(page.getByTestId("manager-knowledge-summary")).toHaveText("None selected");
  const audit = await transmissions(request, backend, `managerKind=project&projectPath=${encodeURIComponent(dir)}`);
  expect(audit).toMatchObject([{ status: "rejected" }]);
  // No manager turn ran and no owner message was stored.
  const state = await (await request.get(`${backend.apiBase}/project-manager?path=${encodeURIComponent(dir)}`, { headers: auth(backend) })).json();
  expect(state.messages).toEqual([]);
  // The old cluster's note is no longer listed.
  await openPicker(page);
  await expect(page.getByText("Old cluster agreement")).toHaveCount(0);
});

test("keyboard: toggle, search focus, space to choose, Escape closes and returns focus", async ({ page, request, freshBackend: backend }) => {
  const w = await world(request, backend);
  await gotoApp(page, backend.bootBase);
  await openManager(page, w.dir);
  await setUpAgent(page);
  const toggle = page.getByTestId("manager-knowledge-toggle");
  await toggle.focus();
  await expect(toggle).toHaveAttribute("aria-expanded", "false");
  await page.keyboard.press("Enter");
  await expect(toggle).toHaveAttribute("aria-expanded", "true");
  await expect(page.getByTestId("manager-knowledge-search")).toBeFocused();
  await page.keyboard.press("Tab");
  await expect(picker(page).getByTestId("manager-knowledge-check").first()).toBeFocused();
  await page.keyboard.press("Space");
  await expect(page.getByTestId("manager-knowledge-summary")).toHaveText("1 selected, not sent");
  await page.keyboard.press("Escape");
  await expect(page.getByTestId("manager-knowledge-panel")).toHaveCount(0);
  await expect(toggle).toBeFocused();
  await expect(toggle).toHaveAttribute("aria-expanded", "false");
});

test("empty and error states are explicit", async ({ page, request, freshBackend: backend }) => {
  await enableCodex(request, backend);
  const dir = await registerProject(request, backend, "Lonely");
  await gotoApp(page, backend.bootBase);
  await openManager(page, dir);
  await setUpAgent(page);
  await openPicker(page);
  await expect(page.getByTestId("manager-knowledge-empty")).toBeVisible();
  await expect(page.getByTestId("manager-knowledge-preview-button")).toBeDisabled();
  await expect(page.getByTestId("manager-knowledge-summary")).toHaveText("None selected");
  // A failing listing shows an alert instead of an empty list.
  await page.route("**/knowledge/context/eligible**", (route) => route.fulfill({ status: 500, contentType: "application/json", body: '{"error":"Knowledge operation failed."}' }));
  // Close and open again: every opening reads the scope anew.
  await page.getByTestId("manager-knowledge-toggle").click();
  await page.getByTestId("manager-knowledge-toggle").click();
  await expect(page.getByTestId("manager-knowledge-error")).toContainText("Knowledge operation failed.");
});

for (const colorScheme of ["light", "dark"] as const) {
  for (const width of [390, 768, 1024, 1440]) {
    test(`layout: ${colorScheme} at ${width}px has no horizontal overflow and keeps controls reachable`, async ({ page, request, freshBackend: backend }) => {
      const w = await world(request, backend);
      await page.emulateMedia({ colorScheme });
      await page.setViewportSize({ width, height: 900 });
      await gotoApp(page, backend.bootBase);
      await openManager(page, w.dir);
      await setUpAgent(page);
      await openPicker(page);
      await rowFor(page, "Company conventions").getByTestId("manager-knowledge-check").check();
      await page.getByTestId("manager-knowledge-preview-button").click();
      await expect(page.getByTestId("manager-knowledge-preview")).toBeVisible();
      await page.getByTestId("manager-knowledge-approve").scrollIntoViewIfNeeded();
      await expect(page.getByTestId("manager-knowledge-approve")).toBeVisible();
      const overflow = await picker(page).evaluate((element) => element.scrollWidth - element.clientWidth);
      expect(overflow).toBeLessThanOrEqual(1);
      const colors = await picker(page).evaluate((element) => {
        const style = getComputedStyle(element);
        return { background: style.backgroundColor, color: getComputedStyle(element.querySelector("button")!).color };
      });
      expect(colors.background).not.toBe("rgba(0, 0, 0, 0)");
      expect(colors.color).not.toBe(colors.background);
    });
  }
}

test("portfolio manager: company notes by default; another project's note needs its owner named and a purpose", async ({ page, request, freshBackend: backend }) => {
  test.slow();
  await enableCodex(request, backend);
  const exampleProject = await registerProject(request, backend, "ExampleApp");
  await addNote(request, backend, "company", "company:forgeorbit", "Portfolio rules", "Keep Review distinct from Done.");
  await addNote(request, backend, "project", exampleProject, "ExampleApp decisions", "EXAMPLE_APP_BODY");
  const sends = countPosts(page, "/portfolio-manager/messages");

  await gotoApp(page, backend.bootBase);
  await openPortfolio(page);
  await page.getByTestId("portfolio-tab-manager").click();
  await expect(page.getByTestId("portfolio-manager")).toBeVisible();
  await expect(page.getByTestId("portfolio-manager-harness")).toHaveValue("codex", { timeout: 20_000 });
  await page.getByTestId("portfolio-manager-consent").check();
  await expect(page.getByTestId("portfolio-manager-connection")).toHaveText("Ready");

  const box = page.getByTestId("portfolio-manager-knowledge");
  await expect(page.getByTestId("portfolio-manager-knowledge-summary")).toHaveText("None selected");
  await page.getByTestId("portfolio-manager-knowledge-toggle").click();
  await expect(box.getByTestId("portfolio-manager-knowledge-row")).toHaveCount(1);
  await expect(box).toContainText("Portfolio rules");
  await expect(box).not.toContainText("ExampleApp decisions");
  // A project's notes only appear once its owner is named.
  await box.getByTestId("portfolio-manager-knowledge-owner").selectOption({ label: "Project · ExampleApp" });
  await expect(box.getByTestId("portfolio-manager-knowledge-row")).toHaveCount(2);
  const row = box.getByTestId("portfolio-manager-knowledge-row").filter({ hasText: "ExampleApp decisions" });
  await row.getByTestId("portfolio-manager-knowledge-check").check();
  await box.getByTestId("portfolio-manager-knowledge-preview-button").click();
  await expect(box.getByTestId("portfolio-manager-knowledge-issues")).toContainText("Say why");
  await expect(box.getByTestId("portfolio-manager-knowledge-approve")).toBeDisabled();
  await row.getByTestId("portfolio-manager-knowledge-purpose").fill("Check ExampleApp's open decisions");
  await box.getByTestId("portfolio-manager-knowledge-preview-button").click();
  await expect(box.getByTestId("portfolio-manager-knowledge-preview")).toContainText("Purpose: Check ExampleApp's open decisions");
  await box.getByTestId("portfolio-manager-knowledge-approve").click();
  await expect(page.getByTestId("portfolio-manager-knowledge-summary")).toContainText("1 note approved");
  expect(sends()).toBe(0);

  await page.getByTestId("portfolio-manager-composer").fill("Review my portfolio");
  await page.getByTestId("portfolio-manager-send").click();
  await expect(page.getByTestId("portfolio-manager-busy")).toBeVisible();
  await expect(page.getByTestId("portfolio-manager-busy")).toHaveCount(0);
  expect(sends()).toBe(1);
  await expect(page.getByTestId("portfolio-manager-knowledge-summary")).toHaveText("None selected");
  const audit = await transmissions(request, backend, "managerKind=portfolio");
  expect(audit).toMatchObject([{ status: "consumed" }]);
});
