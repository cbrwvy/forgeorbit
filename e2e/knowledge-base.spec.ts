import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test, expect, type APIRequestContext, type E2EBackend, type Page } from "./fixtures";
import { gotoApp, openWorkspaces, openPortfolio } from "./helpers";

/**
 * FO-011C knowledge notes. Fresh backends and temp directories only.
 * No harness, model, SSH, or user repository.
 */

test.describe.configure({ mode: "serial" });

function auth(backend: E2EBackend): { authorization: string } {
  return { authorization: `Bearer ${backend.apiToken}` };
}

async function registerProject(request: APIRequestContext, backend: E2EBackend, name: string): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), `fo011c-${name}-`));
  const res = await request.post(`${backend.apiBase}/projects`, {
    headers: auth(backend),
    data: { path: dir, name },
  });
  expect(res.ok(), await res.text()).toBeTruthy();
  return dir;
}

async function openKnowledge(page: Page): Promise<void> {
  await page.getByTestId("workspace-knowledge").click();
  await expect(page.getByTestId("knowledge-page")).toHaveAttribute("data-owner-kind", "company");
}

test("company notes, safe preview, search, archive, keyboard, and viewports", async ({ page, freshBackend: backend }) => {
  await page.context().grantPermissions(["clipboard-read", "clipboard-write"]);
  await gotoApp(page, backend.bootBase);
  const nav = page.getByTestId("workspace-knowledge");
  await nav.focus();
  await page.keyboard.press("Enter");
  await expect(page.getByTestId("knowledge-empty")).toBeVisible();
  await expect(page.getByTestId("knowledge-credential-warning")).toBeVisible();
  await expect(page.getByTestId("knowledge-infrastructure-note")).toContainText("not a confirmed");

  await page.getByTestId("knowledge-create").focus();
  await page.keyboard.press("Enter");
  await expect(page.getByTestId("knowledge-title")).toBeFocused();
  const title = "Architecture decision for the editor";
  await page.getByTestId("knowledge-title").fill(title);
  await page.getByTestId("knowledge-tags").fill("architecture, editor");
  await page.getByTestId("knowledge-body").fill([
    "Hello note",
    "",
    "<script>window.__knowledgeXss = 1</script>",
    "",
    "[run](javascript:alert(1))",
    "",
    "![secret](file:///etc/passwd)",
    "",
    "![remote](https://example.com/shot.png)",
  ].join("\n"));
  await page.getByTestId("knowledge-mode-preview").click();
  await expect(page.getByTestId("knowledge-preview")).toContainText("Hello note");
  await expect(page.getByTestId("knowledge-preview").locator("script")).toHaveCount(0);
  await expect(page.locator("[href^='javascript:']")).toHaveCount(0);
  await expect(page.getByTestId("knowledge-link-blocked")).toBeVisible();
  await expect(page.getByTestId("knowledge-image-blocked")).toBeVisible();
  await expect(page.getByTestId("knowledge-image-remote")).toBeVisible();
  expect(await page.evaluate(() => (window as unknown as { __knowledgeXss?: number }).__knowledgeXss)).toBeUndefined();

  await page.getByTestId("knowledge-mode-edit").click();
  await page.getByTestId("knowledge-save").click();
  await expect(page.getByTestId("knowledge-status")).toHaveText("Saved");
  await expect(page.getByTestId("knowledge-item")).toContainText(title);

  await page.getByTestId("knowledge-search").fill("Hello note");
  await expect(page.getByTestId("knowledge-item")).toHaveCount(1);
  await page.getByTestId("knowledge-copy").click();
  await expect(page.getByTestId("knowledge-status")).toHaveText("Copied Markdown");

  const [download] = await Promise.all([
    page.waitForEvent("download"),
    page.getByTestId("knowledge-export").click(),
  ]);
  expect(await readFile(await download.path(), "utf8")).toContain("Hello note");

  await page.reload();
  await expect(page.getByRole("button", { name: "Settings" })).toBeVisible();
  await openKnowledge(page);
  await expect(page.getByTestId("knowledge-item")).toContainText(title);
  await page.getByTestId("knowledge-item").click();
  await page.getByTestId("knowledge-archive").click();
  await page.getByRole("button", { name: "Archive note" }).click();
  await expect(page.getByTestId("knowledge-status")).toHaveText("Archived");
  await expect(page.getByTestId("knowledge-empty")).toBeVisible();
  await page.getByTestId("knowledge-show-archived").check();
  await expect(page.getByTestId("knowledge-item")).toContainText(title);

  await page.emulateMedia({ colorScheme: "dark", reducedMotion: "reduce" });
  await expect.poll(() => page.locator("html").getAttribute("class")).toContain("dark");
  await page.emulateMedia({ colorScheme: "light", reducedMotion: "reduce" });
  const session = await page.context().newCDPSession(page);
  await session.send("Emulation.setEmulatedMedia", {
    features: [
      { name: "prefers-color-scheme", value: "light" },
      { name: "prefers-reduced-motion", value: "reduce" },
      { name: "prefers-reduced-transparency", value: "reduce" },
    ],
  });
  const filter = await page.getByTestId("knowledge-page").evaluate((node) => getComputedStyle(node).backdropFilter);
  expect(filter === "none" || filter === "").toBe(true);

  for (const width of [390, 768, 1024, 1440]) {
    await page.setViewportSize({ width, height: 800 });
    const box = await page.getByTestId("knowledge-page").boundingBox();
    expect(box?.width ?? 0).toBeLessThanOrEqual(width);
    const fits = await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth + 1);
    expect(fits).toBe(true);
  }

  await openPortfolio(page);
  await expect(page.getByTestId("portfolio-dashboard")).toBeVisible();
  await openWorkspaces(page);
  await expect(page.getByTestId("clusters-page")).toBeVisible();
  await page.getByTestId("workspace-overview").click();
  await expect(page.getByTestId("global-overview")).toBeVisible();
});

test("project notes do not appear on another project", async ({ page, request, freshBackend: backend }) => {
  const alpha = await registerProject(request, backend, "alpha");
  const beta = await registerProject(request, backend, "beta");
  await gotoApp(page, backend.bootBase);
  await page.locator(`[data-testid="project-nav-item"][data-path="${alpha}"]`).click();
  await page.getByTestId("project-more").click(); await page.getByTestId("project-page-knowledge").click();
  await expect(page.getByTestId("knowledge-page")).toHaveAttribute("data-owner-kind", "project");
  await expect(page.getByTestId("knowledge-scope")).toContainText("No cluster");
  await page.getByTestId("knowledge-create").click();
  await page.getByTestId("knowledge-title").fill("Only Alpha");
  await page.getByTestId("knowledge-body").fill("alpha-private");
  await page.getByTestId("knowledge-save").click();
  await expect(page.getByTestId("knowledge-status")).toHaveText("Saved");

  await page.locator(`[data-testid="project-nav-item"][data-path="${beta}"]`).click();
  await page.getByTestId("project-more").click(); await page.getByTestId("project-page-knowledge").click();
  await expect(page.getByTestId("knowledge-item")).toHaveCount(0);
  await page.getByTestId("knowledge-search").fill("alpha-private");
  await expect(page.getByTestId("knowledge-empty")).toBeVisible();
  await expect(page.getByTestId("project-page-overview")).toBeVisible();
  await page.getByTestId("project-page-overview").click();
  await expect(page.getByTestId("project-overview")).toBeVisible();
});

test("a dirty editor asks before leaving", async ({ page, freshBackend: backend }) => {
  await gotoApp(page, backend.bootBase);
  await openKnowledge(page);
  await page.getByTestId("knowledge-create").click();
  await page.getByTestId("knowledge-body").fill("unsaved draft");
  await page.getByTestId("workspace-overview").click();
  await expect(page.getByRole("dialog")).toContainText("Discard unsaved note changes?");
  await page.getByRole("button", { name: "Keep editing" }).click();
  await expect(page.getByTestId("knowledge-body")).toHaveValue("unsaved draft");
  await page.getByTestId("workspace-overview").click();
  await page.getByRole("button", { name: "Discard" }).click();
  await expect(page.getByTestId("global-overview")).toBeVisible();
});

test("a newer save is not overwritten by a stale editor", async ({ page, request, freshBackend: backend }) => {
  await gotoApp(page, backend.bootBase);
  await openKnowledge(page);
  await page.getByTestId("knowledge-create").click();
  await page.getByTestId("knowledge-title").fill("Concurrent");
  await page.getByTestId("knowledge-body").fill("first");
  await page.getByTestId("knowledge-save").click();
  await expect(page.getByTestId("knowledge-revision")).toHaveText("1");
  const id = await page.getByTestId("knowledge-details").innerText();
  const documentId = id.match(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/)?.[0];
  expect(documentId).toBeTruthy();
  const patched = await request.patch(`${backend.apiBase}/knowledge/documents/${documentId}`, {
    headers: auth(backend),
    data: { expectedRevision: 1, content: "from the other editor" },
  });
  expect(patched.ok(), await patched.text()).toBeTruthy();
  await page.getByTestId("knowledge-body").fill("stale local text");
  await page.getByTestId("knowledge-save").click();
  await expect(page.getByTestId("knowledge-conflict")).toBeVisible();
  await expect(page.getByTestId("knowledge-body")).toHaveValue("stale local text");
});

test("remote image consent belongs to one image URL", async ({ page, request, freshBackend: backend }) => {
  const requested: string[] = [];
  await page.route("https://example.invalid/kb-image-*.png", async route => {
    requested.push(route.request().url());
    await route.fulfill({ status: 200, contentType: "image/png", body: Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/l9sAAAAASUVORK5CYII=", "base64") });
  });
  for (const title of ["First image", "Second image"]) {
    const response = await request.post(`${backend.apiBase}/knowledge/documents`, {
      headers: auth(backend),
      data: { ownerKind: "company", ownerId: "company:forgeorbit", title, content: `![remote](https://example.invalid/kb-image-${title.startsWith("First") ? "one" : "two"}.png)` },
    });
    expect(response.status()).toBe(201);
  }
  await gotoApp(page, backend.bootBase);
  await openKnowledge(page);
  await page.getByTestId("knowledge-item").filter({ hasText: "First image" }).click();
  await page.getByTestId("knowledge-mode-preview").click();
  await expect(page.getByTestId("knowledge-image-remote")).toBeVisible();
  expect(requested).toEqual([]);
  await page.getByTestId("knowledge-image-remote").click();
  await expect.poll(() => requested).toEqual(["https://example.invalid/kb-image-one.png"]);
  await page.getByTestId("knowledge-item").filter({ hasText: "Second image" }).click();
  await expect(page.getByTestId("knowledge-image-remote")).toBeVisible();
  await expect(page.getByTestId("knowledge-preview").locator("img")).toHaveCount(0);
  expect(requested).toEqual(["https://example.invalid/kb-image-one.png"]);
});

test("cluster knowledge supports edit, filters, dirty tab guard, restore and confirmed delete", async ({ page, request, freshBackend: backend }) => {
  const response = await request.post(`${backend.apiBase}/clusters`, { headers: auth(backend), data: { name: "Knowledge cluster" } });
  expect(response.status()).toBe(201);
  await gotoApp(page, backend.bootBase);
  await openWorkspaces(page);
  await page.getByTestId("cluster-open").click();
  await page.getByTestId("cluster-tab-knowledge").click();
  await expect(page.getByTestId("knowledge-page")).toHaveAttribute("data-owner-kind", "cluster");
  await page.getByTestId("knowledge-create").click();
  await page.getByTestId("knowledge-title").fill("Deployment agreement");
  await page.getByTestId("knowledge-category").selectOption("deployment");
  await page.getByTestId("knowledge-tags").fill("staging, review");
  await page.getByTestId("knowledge-body").fill("# Cluster agreement\n\nOwner reviews the deployment.");
  await page.getByTestId("knowledge-save").click();
  await expect(page.getByTestId("knowledge-revision")).toHaveText("1");
  await page.getByTestId("knowledge-body").fill("# Cluster agreement\n\nOwner reviews every deployment.");
  await page.getByTestId("knowledge-body").press("ControlOrMeta+s");
  await expect(page.getByTestId("knowledge-revision")).toHaveText("2");
  await page.getByTestId("knowledge-filter-category").selectOption("architecture");
  await expect(page.getByTestId("knowledge-empty")).toBeVisible();
  await page.getByTestId("knowledge-filter-category").selectOption("deployment");
  await page.getByTestId("knowledge-filter-tag").fill("staging");
  await expect(page.getByTestId("knowledge-item")).toHaveCount(1);
  await page.getByTestId("knowledge-body").fill("unsaved cluster edit");
  await page.getByTestId("cluster-tab-overview").click();
  await page.getByRole("button", { name: "Keep editing" }).click();
  await expect(page.getByTestId("knowledge-body")).toHaveValue("unsaved cluster edit");
  await page.getByTestId("cluster-tab-overview").click();
  await page.getByRole("button", { name: "Discard", exact: true }).click();
  await page.getByTestId("cluster-tab-knowledge").click();
  await page.getByTestId("knowledge-item").click();
  await expect(page.getByTestId("knowledge-body")).toHaveValue("# Cluster agreement\n\nOwner reviews every deployment.");
  await page.getByTestId("knowledge-archive").click();
  await page.getByRole("button", { name: "Archive note", exact: true }).click();
  await expect(page.getByTestId("knowledge-status")).toHaveText("Archived");
  await page.getByTestId("knowledge-restore").click();
  await expect(page.getByTestId("knowledge-status")).toHaveText("Restored");
  await expect(page.getByTestId("knowledge-item")).toHaveCount(1);
  await page.getByTestId("knowledge-archive").click();
  await page.getByRole("button", { name: "Archive note", exact: true }).click();
  await expect(page.getByTestId("knowledge-status")).toHaveText("Archived");
  await page.getByTestId("knowledge-delete").click();
  await page.getByRole("dialog").getByRole("button", { name: "Cancel", exact: true }).click();
  await expect(page.getByTestId("knowledge-title")).toHaveValue("Deployment agreement");
  await page.getByTestId("knowledge-delete").click();
  await page.getByRole("button", { name: "Delete note", exact: true }).click();
  await expect(page.getByTestId("knowledge-status")).toHaveText("Deleted");
  await page.getByTestId("knowledge-show-archived").check();
  await expect(page.getByTestId("knowledge-empty")).toBeVisible();
  await openKnowledge(page);
  await expect(page.getByTestId("knowledge-item")).toHaveCount(0);
});

test("the active editor fits every requested viewport and theme", async ({ page, freshBackend: backend }, info) => {
  await gotoApp(page, backend.bootBase);
  await openKnowledge(page);
  await page.getByTestId("knowledge-create").click();
  await page.getByTestId("knowledge-title").fill("Architecture and deployment decisions");
  await page.getByTestId("knowledge-tags").fill("architecture, staging");
  await page.getByTestId("knowledge-body").fill("# A managed Markdown note\n\nKeep project knowledge with its owner.\n\n- Review revisions\n- Confirm deployment facts");
  for (const theme of ["light", "dark"] as const) {
    await page.emulateMedia({ colorScheme: theme, reducedMotion: "reduce" });
    await expect.poll(() => page.locator("html").evaluate(node => node.classList.contains("dark"))).toBe(theme === "dark");
    for (const width of [390, 768, 1024, 1440]) {
      await page.setViewportSize({ width, height: 900 });
      await expect(page.getByTestId("knowledge-body")).toBeVisible();
      await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth + 1)).toBe(true);
      await expect.poll(() => page.getByTestId("knowledge-page").evaluate(node => node.scrollWidth <= node.clientWidth + 1)).toBe(true);
      await page.screenshot({ path: info.outputPath(`knowledge-${theme}-${width}.png`), fullPage: true });
    }
  }
});

test("registering a project cannot silently discard a knowledge draft", async ({ page, freshBackend: backend }) => {
  const dir = await mkdtemp(path.join(tmpdir(), "fo011c-wizard-"));
  await gotoApp(page, backend.bootBase);
  await openKnowledge(page);
  await page.getByTestId("knowledge-create").click();
  await page.getByTestId("knowledge-body").fill("keep this company draft");
  await page.getByTestId("workspace-add-project").click();
  await page.getByTestId("wizard-name").fill("Newly registered project");
  await page.getByTestId("wizard-directory").fill(dir);
  for (const step of ["discovery", "docs", "environment", "launch", "review"]) {
    await page.getByTestId("wizard-next").click();
    await expect(page.getByTestId("wizard-body")).toHaveAttribute("data-step", step);
  }
  await page.getByTestId("wizard-submit").click();
  await expect(page.getByRole("dialog")).toContainText("Discard unsaved note changes?");
  await page.getByRole("button", { name: "Keep editing", exact: true }).click();
  await expect(page.getByTestId("knowledge-body")).toHaveValue("keep this company draft");
  await page.getByTestId("project-nav-item").filter({ hasText: "Newly registered project" }).click();
  await page.getByRole("button", { name: "Discard", exact: true }).click();
  await expect(page.getByTestId("project-header-name")).toHaveText("Newly registered project");
});
