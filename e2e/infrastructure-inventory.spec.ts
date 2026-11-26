import { mkdtemp, readdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { expect, test, type APIRequestContext, type E2EBackend, type Page } from "./fixtures";
import { gotoApp, openWorkspaces } from "./helpers";

/**
 * FO-011D infrastructure inventory. Isolated backend, fixture records only.
 * No harness, no remote host, and no project-directory writes.
 */

test.describe.configure({ mode: "serial" });

function auth(backend: E2EBackend): { authorization: string } {
  return { authorization: `Bearer ${backend.apiToken}` };
}

async function registerProject(request: APIRequestContext, backend: E2EBackend, name: string): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), `fo011d-${name}-`));
  await writeFile(path.join(dir, "keep.txt"), name);
  const res = await request.post(`${backend.apiBase}/projects`, {
    headers: auth(backend),
    data: { path: dir, name },
  });
  expect(res.ok(), await res.text()).toBeTruthy();
  return dir;
}

async function createCluster(request: APIRequestContext, backend: E2EBackend, name: string): Promise<string> {
  const res = await request.post(`${backend.apiBase}/clusters`, {
    headers: auth(backend),
    data: { name },
  });
  expect(res.ok(), await res.text()).toBeTruthy();
  return (await res.json()).id as string;
}

test("inventory create, relations, archive, knowledge, and responsive layout", async ({ page, freshBackend: backend }) => {
  const alpha = await registerProject(page.request, backend, "Alpha");
  const beta = await registerProject(page.request, backend, "Beta");
  const before = await readdir(alpha);
  const first = await createCluster(page.request, backend, "Lunarian");
  const second = await createCluster(page.request, backend, "Other");
  const note = await page.request.post(`${backend.apiBase}/knowledge/documents`, {
    headers: auth(backend),
    data: {
      ownerKind: "cluster",
      ownerId: first,
      title: "Deploy notes",
      category: "deployment",
      content: "marker-not-a-live-status",
    },
  });
  expect(note.ok(), await note.text()).toBeTruthy();

  await gotoApp(page, backend.bootBase);
  await expect(page.getByTestId("workspace-infrastructure")).toHaveCount(0);
  await openWorkspaces(page);
  await page.getByTestId("clusters-more").click();
  await page.getByTestId("clusters-more-menu-infrastructure").click();
  await expect(page.getByTestId("infrastructure-inventory")).toBeVisible();
  await expect(page.getByTestId("infrastructure-status-note")).toContainText("Not verified");
  await expect(page.getByTestId("infrastructure-empty")).toBeVisible();
  await expect(page.getByTestId("infrastructure-inventory")).not.toContainText("Online");

  const longName = `Shared staging fixture ${"north ".repeat(6)}`.trim();
  await page.getByTestId("infrastructure-create").click();
  await expect(page.getByTestId("resource-form-name")).toBeFocused();
  await page.getByTestId("resource-form-name").fill(longName);
  await page.getByTestId("resource-form-type").selectOption("vps");
  await page.getByTestId("resource-form-provider").fill("Fixture");
  await page.getByTestId("resource-form-hostname").fill("staging.fixture.invalid");
  await page.getByTestId("resource-form-environment").selectOption("staging");
  await page.getByTestId("resource-form-cost").fill("15");
  await page.getByTestId("resource-form-currency").fill("usd");
  await page.getByTestId("resource-form-status").selectOption("unknown");
  await page.getByTestId("resource-form-save").click();
  const card = page.getByTestId("resource-card");
  await expect(card).toHaveCount(1);
  await expect(card.getByTestId("resource-name")).toContainText("Shared staging fixture");
  await expect(card.getByTestId("resource-status")).toHaveAttribute("data-status", "unknown");
  await expect(card.getByTestId("resource-status")).toContainText("Unknown");
  await expect(card.getByTestId("resource-cost")).toContainText("15 USD");
  await expect(card).toContainText("No cluster");
  await expect(page.getByTestId("infrastructure-domains")).not.toContainText("staging.fixture.invalid");

  await card.getByTestId("resource-assign-cluster").selectOption({ label: "Lunarian" });
  await card.getByTestId("resource-assign-cluster-submit").click();
  await expect(card.getByTestId("resource-cluster-chip")).toHaveCount(1);
  await card.getByTestId("resource-assign-cluster").selectOption({ label: "Other" });
  await card.getByTestId("resource-assign-cluster-submit").click();
  await expect(card.getByTestId("resource-cluster-chip")).toHaveCount(2);
  await card.getByTestId("resource-assign-project").selectOption({ label: "Alpha" });
  await card.getByTestId("resource-assign-project-submit").click();
  await expect(card.getByTestId("resource-project-chip")).toHaveCount(1);
  await card.getByTestId("resource-assign-project").selectOption({ label: "Beta" });
  await card.getByTestId("resource-assign-project-submit").click();
  await expect(card.getByTestId("resource-project-chip")).toHaveCount(2);
  await expect(page.getByTestId("resource-card")).toHaveCount(1);

  await page.getByTestId("infrastructure-environment-project").selectOption({ label: "Alpha" });
  await page.getByTestId("project-environment-add").filter({ hasText: "Staging" }).click();
  await page.getByTestId("project-environment-add").filter({ hasText: "Production" }).click();
  await expect(page.getByTestId("project-environment-chip")).toHaveCount(2);

  await page.getByTestId("resource-edit").click();
  await page.getByTestId("resource-form-name").fill(`${longName} edited`);
  await page.getByTestId("resource-form-save").click();
  await expect(card.getByTestId("resource-name")).toContainText("edited");

  await page.getByTestId("infrastructure-create").click();
  await page.getByTestId("resource-form-name").fill("Fixture domain");
  await page.getByTestId("resource-form-type").selectOption("domain");
  await page.getByTestId("resource-form-hostname").fill("docs.fixture.invalid");
  await page.getByTestId("resource-form-save").click();
  await expect(page.getByTestId("infrastructure-domains")).toContainText("Fixture domain");
  await expect(page.getByTestId("infrastructure-domains")).toContainText("docs.fixture.invalid");
  await expect(page.getByTestId("infrastructure-domains")).not.toContainText("staging.fixture.invalid");

  const domain = page.getByTestId("resource-card").filter({ hasText: "Fixture domain" });
  await domain.getByTestId("resource-archive").click();
  await expect(page.getByRole("dialog")).toContainText("does not shut down a server");
  await page.keyboard.press("Escape");
  await expect(domain).toHaveCount(1);
  await domain.getByTestId("resource-archive").click();
  await page.getByRole("button", { name: "Archive resource" }).click();
  await expect(domain).toHaveCount(0);
  await page.getByTestId("infrastructure-filter-archived").selectOption("archived");
  await expect(page.getByTestId("resource-card")).toHaveCount(1);

  await page.getByTestId("infrastructure-back").click();
  await page.getByTestId("cluster-card").filter({ hasText: "Lunarian" }).getByTestId("cluster-open").click();
  await page.getByTestId("cluster-tab-infrastructure").click();
  await expect(page.getByTestId("cluster-infrastructure-status")).toContainText("Not verified");
  await expect(page.getByTestId("cluster-infrastructure")).not.toContainText("Online");
  await expect(page.getByTestId("resource-card").filter({ hasText: "edited" })).toHaveCount(1);
  await expect(page.getByTestId("infrastructure-knowledge-link")).toContainText("Deploy notes");
  await expect(page.getByTestId("cluster-infrastructure")).not.toContainText("marker-not-a-live-status");
  await page.getByTestId("infrastructure-knowledge-link").click();
  await expect(page.getByTestId("cluster-knowledge")).toBeVisible();

  await page.getByTestId("cluster-breadcrumb-clusters").click();
  await page.getByTestId("cluster-card").filter({ hasText: "Other" }).getByTestId("cluster-open").click();
  await page.getByTestId("cluster-tab-infrastructure").click();
  const shared = page.getByTestId("resource-card").filter({ hasText: "edited" });
  await expect(shared).toHaveCount(1);
  await expect(shared.getByTestId("resource-cluster-chip")).toHaveCount(2);

  await page.getByTestId("infrastructure-search").focus();
  await page.keyboard.type("edited");
  await expect(shared).toBeVisible();
  await page.getByTestId("infrastructure-create").focus();
  await page.keyboard.press("Enter");
  await expect(page.getByRole("dialog")).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(page.getByRole("dialog")).toHaveCount(0);

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
  const backdrop = await shared.evaluate((node) => {
    const style = getComputedStyle(node);
    return style.backdropFilter || style.getPropertyValue("-webkit-backdrop-filter");
  });
  expect(backdrop === "none" || backdrop === "").toBe(true);

  for (const width of [390, 768, 1024, 1440]) {
    await page.setViewportSize({ width, height: 800 });
    const fits = await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth + 1);
    expect(fits).toBe(true);
  }

  expect(await readdir(alpha)).toEqual(before);
  expect(await readdir(beta)).toEqual(["keep.txt"]);
  const listed = await page.request.get(`${backend.apiBase}/infrastructure/resources?archived=all`, { headers: auth(backend) });
  expect(listed.ok()).toBeTruthy();
  const resources = (await listed.json()).resources as { name: string }[];
  expect(resources.filter((resource) => resource.name.includes("edited"))).toHaveLength(1);
});
