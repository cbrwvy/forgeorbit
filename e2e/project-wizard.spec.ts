import { access, mkdir, mkdtemp, readFile, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test, expect, type APIRequestContext, type E2EBackend, type Page } from "./fixtures";
import { gotoApp } from "./helpers";

/**
 * FO-002 project wizard. The worker backend has its own SQLite file, and
 * every fixture directory is a temp folder. The wizard types paths instead
 * of opening the native panel, which headless mode does not have.
 */

test.describe.configure({ mode: "serial" });

function auth(backend: E2EBackend): { authorization: string } {
  return { authorization: `Bearer ${backend.apiToken}` };
}

async function tempDir(name: string): Promise<string> {
  return mkdtemp(path.join(tmpdir(), `fo002-${name}-`));
}

async function exists(file: string): Promise<boolean> {
  try {
    await access(file);
    return true;
  } catch {
    return false;
  }
}

async function register(
  request: APIRequestContext,
  backend: E2EBackend,
  dir: string,
  name: string,
): Promise<void> {
  const res = await request.post(`${backend.apiBase}/projects`, {
    headers: auth(backend),
    data: { path: dir, name },
  });
  expect(res.ok(), await res.text()).toBeTruthy();
}

async function openWizard(page: Page): Promise<void> {
  await page.getByTestId("workspace-add-project").click();
  await expect(page.getByTestId("project-wizard")).toBeVisible();
  await expect(page.getByTestId("wizard-body")).toHaveAttribute("data-step", "project");
}

async function fillIdentity(
  page: Page,
  fields: { name: string; directory: string; description?: string; folderName?: string; mode?: "import" | "create" },
): Promise<void> {
  if (fields.mode === "create") await page.getByTestId("wizard-mode-create").click();
  await page.getByTestId("wizard-name").fill(fields.name);
  await page.getByTestId("wizard-directory").fill(fields.directory);
  if (fields.folderName) {
    await page.getByTestId("wizard-placement-new-folder").click();
    await page.getByTestId("wizard-folder-name").fill(fields.folderName);
  }
  if (fields.description) await page.getByTestId("wizard-description").fill(fields.description);
}

async function advance(page: Page, testId: "wizard-next" | "wizard-submit" = "wizard-next"): Promise<void> {
  await page.getByTestId(testId).click();
}

test("imports an existing project, opens its workspace, and leaves files alone", async ({ page, request, freshBackend: backend }) => {
  const dir = await tempDir("import");
  const idea = path.join(dir, "docs", "IDEA.md");
  const prd = path.join(dir, "docs", "PRD.md");
  await mkdir(path.dirname(idea), { recursive: true });
  await writeFile(idea, "# Keep idea\n");
  await writeFile(prd, "# Keep prd\n");
  await writeFile(path.join(dir, "README.md"), "# Readme\n");

  await gotoApp(page, backend.bootBase);
  await openWizard(page);
  await fillIdentity(page, { name: "Imported Orbit", directory: dir, description: "Already on disk" });
  await advance(page);
  await expect(page.getByTestId("wizard-body")).toHaveAttribute("data-step", "discovery");
  await expect(page.getByTestId("wizard-readme")).toContainText("Readme");
  await advance(page);
  await expect(page.getByTestId("wizard-docs")).toHaveAttribute("data-state", "both");
  await expect(page.getByTestId("wizard-docs-interview")).toHaveCount(0);
  await expect(page.getByTestId("wizard-doc-idea-status")).toHaveText("Found");
  await expect(page.getByTestId("wizard-doc-prd-status")).toHaveText("Found");
  await advance(page);
  await expect(page.getByTestId("wizard-git")).toContainText("Not a git repository");
  await advance(page);
  await expect(page.getByTestId("wizard-body")).toHaveAttribute("data-step", "launch");
  await expect(page.getByRole("radio", { name: /Skip for now/ })).toBeChecked();
  await advance(page);
  await expect(page.getByTestId("wizard-review-name")).toHaveText("Imported Orbit");
  await expect(page.getByTestId("wizard-review-folder")).toContainText(path.basename(dir));
  await expect(page.getByTestId("wizard-review-environment")).toHaveText("Not configured");
  await expect(page.getByTestId("wizard-change").filter({ hasText: "Do not save a launch profile" })).toBeVisible();
  await expect(page.getByTestId("wizard-change").filter({ hasText: "Do not start the project" })).toBeVisible();
  await expect(page.getByTestId("wizard-change").filter({ hasText: "untouched" })).toBeVisible();
  await advance(page, "wizard-submit");

  await expect(page.getByTestId("project-header-name")).toHaveText("Imported Orbit");
  await page.getByTestId("project-header-details-toggle").click();
  await expect(page.getByTestId("project-header-description")).toHaveText("Already on disk");
  await expect(page.locator(`[data-testid="project-nav-item"][data-path]`).filter({ hasText: "Imported Orbit" })).toBeVisible();
  await page.getByTestId("project-page-board").click();
  await expect(page.getByTestId("new-task-project")).toContainText(path.basename(dir));
  expect(await readFile(idea, "utf8")).toBe("# Keep idea\n");
  expect(await readFile(prd, "utf8")).toBe("# Keep prd\n");
});

test("creates a new folder only after confirm and opens that workspace", async ({ page, freshBackend: backend }) => {
  const parent = await tempDir("create");
  await writeFile(path.join(parent, "parent.txt"), "stay\n");
  const folderName = "new-orbit";

  await gotoApp(page, backend.bootBase);
  await openWizard(page);
  await fillIdentity(page, {
    mode: "create",
    name: "Created Orbit",
    directory: parent,
    folderName,
  });
  await advance(page);
  await expect(page.getByTestId("wizard-warning").filter({ hasText: "does not exist yet" })).toBeVisible();
  await expect(page.getByTestId("wizard-docs")).toHaveCount(0);
  await advance(page);
  await expect(page.getByTestId("wizard-docs")).toHaveAttribute("data-state", "none");
  await expect(page.getByTestId("wizard-docs-interview")).toBeVisible();
  await advance(page);
  await advance(page);
  await expect(page.getByTestId("wizard-body")).toHaveAttribute("data-step", "launch");
  await advance(page);
  await expect(page.getByTestId("wizard-change").filter({ hasText: "Create the folder" })).toBeVisible();
  const created = path.join(parent, folderName);
  expect(await exists(created)).toBe(false);
  await advance(page, "wizard-submit");
  await expect(page.getByTestId("project-header-name")).toHaveText("Created Orbit");
  expect(await exists(created)).toBe(true);
  expect(await readFile(path.join(parent, "parent.txt"), "utf8")).toBe("stay\n");
  expect(await exists(path.join(created, "docs", "IDEA.md"))).toBe(false);
});

test("shows one missing document and alternate paths without writing them", async ({ page, freshBackend: backend }) => {
  const onlyIdea = await tempDir("idea");
  await mkdir(path.join(onlyIdea, "docs"));
  await writeFile(path.join(onlyIdea, "docs", "IDEA.md"), "# Only idea\n");
  const alternate = await tempDir("alt");
  await mkdir(path.join(alternate, "documentation"));
  await writeFile(path.join(alternate, "IDEA.md"), "# Alt idea\n");
  await writeFile(path.join(alternate, "documentation", "PRD.md"), "# Alt prd\n");

  await gotoApp(page, backend.bootBase);
  await openWizard(page);
  await fillIdentity(page, { name: "Idea Only", directory: onlyIdea });
  await advance(page);
  await advance(page);
  await expect(page.getByTestId("wizard-docs")).toHaveAttribute("data-state", "idea-only");
  await expect(page.getByTestId("wizard-doc-idea-status")).toHaveText("Found");
  await expect(page.getByTestId("wizard-doc-prd-status")).toHaveText("Missing");
  await expect(page.getByTestId("wizard-docs-interview")).toBeVisible();
  await page.getByTestId("wizard-cancel").click();

  await openWizard(page);
  await fillIdentity(page, { name: "Alt Docs", directory: alternate });
  await advance(page);
  await advance(page);
  await expect(page.getByTestId("wizard-docs")).toHaveAttribute("data-state", "alternatives");
  await expect(page.locator('[data-testid="wizard-doc-alternative"][data-path="IDEA.md"]')).toBeChecked();
  await expect(page.locator('[data-testid="wizard-doc-alternative"][data-path="documentation/PRD.md"]')).toBeChecked();
  await page.getByTestId("wizard-cancel").click();
  expect(await readFile(path.join(onlyIdea, "docs", "IDEA.md"), "utf8")).toBe("# Only idea\n");
  expect(await exists(path.join(onlyIdea, "docs", "PRD.md"))).toBe(false);
});

test("reports compose, makefile, and no git, and does not run either", async ({ page, freshBackend: backend }) => {
  const dir = await tempDir("tools");
  await writeFile(path.join(dir, "compose.yaml"), "services:\n  web:\n    image: nginx\n  worker:\n");
  await writeFile(path.join(dir, "Makefile"), "dev:\n\ttouch fo002-should-not-run\ntest:\n\ttouch fo002-should-not-test\n");
  await writeFile(path.join(dir, "package.json"), JSON.stringify({
    dependencies: { react: "19.0.0" },
    scripts: { dev: "echo SECRET_SCRIPT_BODY", test: "vitest" },
  }));
  await writeFile(path.join(dir, ".env"), "SUPER_SECRET_TOKEN=nope\n");

  await gotoApp(page, backend.bootBase);
  await openWizard(page);
  await fillIdentity(page, { name: "Tools Orbit", directory: dir });
  await advance(page);
  await expect(page.getByTestId("wizard-stack")).toContainText("Node / React");
  await expect(page.getByTestId("wizard-stack")).toContainText("Docker Compose");
  await expect(page.getByTestId("project-wizard")).not.toContainText("SECRET_SCRIPT_BODY");
  await expect(page.getByTestId("project-wizard")).not.toContainText("SUPER_SECRET_TOKEN");
  await advance(page);
  await advance(page);
  await expect(page.getByTestId("wizard-git")).toContainText("Not a git repository");
  await expect(page.getByTestId("wizard-launch-command").filter({ hasText: "npm run dev" })).toBeVisible();
  await expect(page.getByTestId("wizard-launch-command").filter({ hasText: "docker compose up" })).toBeVisible();
  await expect(page.getByTestId("wizard-launch-command").filter({ hasText: "make dev" })).toBeVisible();
  await expect(page.getByTestId("wizard-test-tool").filter({ hasText: "npm run test" })).toBeVisible();
  await expect(page.getByTestId("wizard-makefile-target").filter({ hasText: "test" })).toBeVisible();
  await expect(page.getByTestId("wizard-compose-service").filter({ hasText: "web" })).toBeVisible();
  await expect(page.getByTestId("wizard-no-commands")).toBeVisible();
  await page.getByTestId("wizard-cancel").click();
  expect(await exists(path.join(dir, "fo002-should-not-run"))).toBe(false);
  expect(await exists(path.join(dir, "fo002-should-not-test"))).toBe(false);
});

test("refuses a duplicate directory and keeps the existing project", async ({ page, request, freshBackend: backend }) => {
  const dir = await tempDir("dup");
  await register(request, backend, dir, "Already Orbit");
  const link = `${dir}-link`;
  await symlink(dir, link);

  await gotoApp(page, backend.bootBase);
  await expect(page.getByTestId("project-nav-item").filter({ hasText: "Already Orbit" })).toBeVisible();
  await openWizard(page);
  await fillIdentity(page, { name: "Duplicate", directory: dir });
  await advance(page);
  await expect(page.getByTestId("wizard-error")).toContainText("Already Orbit");
  await expect(page.getByTestId("wizard-body")).toHaveAttribute("data-step", "project");
  await page.getByTestId("wizard-directory").fill(link);
  await advance(page);
  await expect(page.getByTestId("wizard-error")).toContainText("Already Orbit");
  await page.getByTestId("wizard-cancel").click();
  await expect(page.getByTestId("project-nav-item").filter({ hasText: "Already Orbit" })).toHaveCount(1);
  await expect(page.getByTestId("project-nav-item").filter({ hasText: "Duplicate" })).toHaveCount(0);
});

test("cancel discards the draft and back keeps what was typed", async ({ page, freshBackend: backend }) => {
  const dir = await tempDir("nav");
  await gotoApp(page, backend.bootBase);
  await openWizard(page);
  await fillIdentity(page, { name: "Draft Orbit", directory: dir, description: "Keep me" });
  await page.getByTestId("wizard-cancel").click();
  await expect(page.getByTestId("project-wizard")).toHaveCount(0);
  await openWizard(page);
  await expect(page.getByTestId("wizard-name")).toHaveValue("");
  await fillIdentity(page, { name: "Draft Orbit", directory: dir });
  await advance(page);
  await expect(page.getByTestId("wizard-body")).toHaveAttribute("data-step", "discovery");
  await page.getByTestId("wizard-back").click();
  await expect(page.getByTestId("wizard-name")).toHaveValue("Draft Orbit");
  await expect(page.getByTestId("wizard-directory")).toHaveValue(dir);
  await page.getByTestId("wizard-step-discovery").click();
  await expect(page.getByTestId("wizard-body")).toHaveAttribute("data-step", "discovery");
  await page.getByTestId("wizard-cancel").click();
});

test("stays usable in a short window, under reduced motion, and in both themes", async ({ page, request, freshBackend: backend }) => {
  await gotoApp(page, backend.bootBase);
  try {
    await page.emulateMedia({ reducedMotion: "reduce" });
    await page.setViewportSize({ width: 420, height: 640 });
    await openWizard(page);
    await expect(page.getByTestId("wizard-next")).toBeVisible();
    await expect(page.getByTestId("wizard-cancel")).toBeVisible();
    await page.getByTestId("wizard-cancel").click();
    await page.setViewportSize({ width: 1280, height: 800 });

    await page.getByRole("button", { name: "Settings", exact: true }).click();
    const settings = page.getByRole("dialog");
    await settings.getByRole("button", { name: "Light", exact: true }).click();
    await expect(page.locator("html")).not.toHaveClass(/dark/);
    await settings.getByRole("button", { name: "Close", exact: true }).click();
    await openWizard(page);
    const light = await page.getByTestId("project-wizard").evaluate((el) => {
      const match = getComputedStyle(el).color.match(/rgba?\((\d+)/);
      return match ? Number(match[1]) : -1;
    });
    expect(light).toBeLessThan(80);
    await page.getByTestId("wizard-cancel").click();

    await page.getByRole("button", { name: "Settings", exact: true }).click();
    const darkSettings = page.getByRole("dialog");
    await darkSettings.getByRole("button", { name: "Dark", exact: true }).click();
    await expect(page.locator("html")).toHaveClass(/dark/);
    await darkSettings.getByRole("button", { name: "Close", exact: true }).click();
    await openWizard(page);
    const dark = await page.getByTestId("project-wizard").evaluate((el) => {
      const match = getComputedStyle(el).color.match(/rgba?\((\d+)/);
      return match ? Number(match[1]) : -1;
    });
    expect(dark).toBeGreaterThan(180);
    await page.getByTestId("wizard-cancel").click();
  } finally {
    await request.put(`${backend.apiBase}/preferences/theme`, {
      headers: auth(backend),
      data: { value: "auto" },
    });
  }
});
