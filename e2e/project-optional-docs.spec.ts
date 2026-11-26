import { access, mkdtemp, readFile, readdir, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test, expect, type APIRequestContext, type E2EBackend, type Page } from "./fixtures";
import { gotoApp } from "./helpers";
import { clickProjectPage, projectPageIsMore } from "./project-nav";

/**
 * FO-002.1: IDEA and PRD are optional in the project wizard. Agents are the
 * fake codex driver and every folder is a temp directory, so no real CLI,
 * model or user project is involved.
 */

test.describe.configure({ mode: "serial" });
test.use({
  backendEnv: {
    AGETOR_CODEX_DRIVER: "fake",
    AGETOR_CODEX_BIN: "/bin/echo",
    AGETOR_FAKE_INTERVIEW_DELAY_MS: "200",
  },
});

function auth(backend: E2EBackend): { authorization: string } {
  return { authorization: `Bearer ${backend.apiToken}` };
}

async function tempDir(name: string): Promise<string> {
  return mkdtemp(path.join(tmpdir(), `fo0021-${name}-`));
}

async function exists(file: string): Promise<boolean> {
  try {
    await access(file);
    return true;
  } catch {
    return false;
  }
}

async function enableCodex(request: APIRequestContext, backend: E2EBackend): Promise<void> {
  const res = await request.patch(`${backend.apiBase}/harnesses/codex`, { headers: auth(backend), data: { enabled: true } });
  expect(res.ok(), await res.text()).toBeTruthy();
}

function countTurns(page: Page): () => number {
  let turns = 0;
  page.on("request", (req) => {
    if (req.method() === "POST" && req.url().includes("/project-interviews/turns")) turns += 1;
  });
  return () => turns;
}

async function toDocs(page: Page, name: string, directory: string, description?: string): Promise<void> {
  await page.getByTestId("workspace-add-project").click();
  await expect(page.getByTestId("project-wizard")).toBeVisible();
  await page.getByTestId("wizard-name").fill(name);
  await page.getByTestId("wizard-directory").fill(directory);
  if (description) await page.getByTestId("wizard-description").fill(description);
  await page.getByTestId("wizard-next").click();
  await expect(page.getByTestId("wizard-body")).toHaveAttribute("data-step", "discovery");
  await page.getByTestId("wizard-next").click();
  await expect(page.getByTestId("wizard-body")).toHaveAttribute("data-step", "docs");
}

async function stepsToReview(page: Page): Promise<void> {
  for (const step of ["environment", "launch", "review"]) {
    await page.getByTestId("wizard-next").click();
    await expect(page.getByTestId("wizard-body")).toHaveAttribute("data-step", step);
  }
}

async function openProject(page: Page, name: string): Promise<void> {
  await page.locator(`[data-testid="project-nav-item"][data-path]`).filter({ hasText: name }).first().click();
  await expect(page.getByTestId("project-header")).toBeVisible();
}

test("management-only project: skip IDEA & PRD and the environment, then use the whole workspace", async ({ page, request, backend }) => {
  const dir = await tempDir("mgmt");
  await writeFile(path.join(dir, "notes.txt"), "stay\n");
  const turns = countTurns(page);

  await gotoApp(page, backend.bootBase);
  await toDocs(page, "Ops Desk", dir);
  await expect(page.getByTestId("wizard-docs-skip-block")).toContainText("later from the project workspace");
  await page.getByTestId("wizard-docs-skip-all").click();
  // Skip needs no confirmation and moves on.
  await expect(page.getByTestId("wizard-body")).toHaveAttribute("data-step", "environment");
  await page.getByTestId("wizard-back").click();
  await expect(page.getByTestId("wizard-doc-idea-status")).toHaveText("Skipped");
  await expect(page.getByTestId("wizard-doc-prd-status")).toHaveText("Skipped");
  await expect(page.getByTestId("wizard-docs-interview")).toHaveCount(0);
  await expect(page.getByTestId("wizard-docs-skip-block")).toHaveCount(0);

  await stepsToReview(page);
  await expect(page.getByTestId("wizard-review-documentation")).toHaveText("IDEA: skipped · PRD: skipped");
  await expect(page.getByTestId("wizard-review-environment")).toHaveText("Not configured");
  await expect(page.getByTestId("wizard-change").filter({ hasText: "IDEA and PRD are skipped" })).toBeVisible();
  await expect(page.getByTestId("wizard-change").filter({ hasText: "Do not create or overwrite IDEA.md or PRD.md" })).toBeVisible();
  await page.getByTestId("wizard-submit").click();

  await expect(page.getByTestId("project-header-name")).toHaveText("Ops Desk");
  expect(await readdir(dir)).toEqual(["notes.txt"]);
  expect(turns()).toBe(0);

  // Overview: documents are "Not created", with create actions and no error.
  await expect(page.getByTestId("project-docs-card")).toBeVisible();
  await expect(page.getByTestId("project-doc-idea")).toHaveAttribute("data-state", "missing");
  await expect(page.getByTestId("project-doc-prd")).toHaveAttribute("data-state", "missing");
  await expect(page.getByTestId("project-doc-idea-status")).toHaveText("Not created");
  await expect(page.getByTestId("project-docs-optional")).toBeVisible();
  await expect(page.getByTestId("project-doc-idea-create")).toBeVisible();
  await expect(page.getByTestId("project-doc-prd-create")).toBeVisible();
  await expect(page.getByTestId("project-docs-error")).toHaveCount(0);

  // Every workspace page opens without documents.
  for (const [id, probe] of [
    ["manager", "manager-page"],
    ["knowledge", "knowledge-page"],
    ["board", "new-task-project"],
    ["environment", "environment-page"],
  ] as const) {
    await clickProjectPage(page, id);
    if (projectPageIsMore(id)) await expect(page.getByTestId("project-more")).toHaveAttribute("data-current", "true");
    else await expect(page.getByTestId(`project-page-${id}`)).toHaveAttribute("aria-pressed", "true");
    await expect(page.getByTestId(probe).first()).toBeVisible();
  }
  const manager = await request.get(`${backend.apiBase}/project-manager/context?path=${encodeURIComponent(dir)}`, { headers: auth(backend) });
  const sources = (await manager.json()).sources as { id: string; status: string }[];
  expect(sources.find((source) => source.id === "idea")?.status).toBe("missing");
  expect(turns()).toBe(0);
  expect(await exists(path.join(dir, "IDEA.md"))).toBe(false);
  expect(await exists(path.join(dir, "docs"))).toBe(false);
});

test("skip IDEA, keep PRD: the interview needs real input first and writes only the PRD", async ({ page, request, freshBackend: backend }) => {
  await enableCodex(request, backend);
  const dir = await tempDir("prd-only");
  await gotoApp(page, backend.bootBase);
  await toDocs(page, "Prd Only", dir);

  await page.getByTestId("wizard-doc-idea-skip").click();
  await expect(page.getByTestId("wizard-doc-idea-status")).toHaveText("Skipped");
  await expect(page.getByTestId("wizard-doc-prd-status")).toHaveText("Missing");
  await expect(page.getByTestId("wizard-docs-interview")).toContainText("Missing: PRD.md");
  await page.getByTestId("wizard-open-interview").click();
  await expect(page.getByTestId("interview-doc-idea")).toContainText("Skipped");
  await page.getByTestId("interview-harness").selectOption("codex");
  await page.getByTestId("interview-consent").check();
  await page.getByTestId("interview-start").click();
  await expect(page.getByTestId("interview-message").last()).toContainText("What do you want to build");

  // No description and no answer yet: nothing real to write a PRD from.
  await expect(page.getByTestId("interview-prd-hint")).toContainText("no IDEA.md");
  await expect(page.getByTestId("interview-finish")).toBeDisabled();
  await page.getByTestId("interview-answer").fill("A shared on-call rota for a support team");
  await expect(page.getByTestId("interview-prd-hint")).toHaveCount(0);
  await page.getByTestId("interview-send").click();
  await expect(page.getByTestId("interview-message").last()).toContainText("main users");
  await page.getByTestId("interview-finish").click();
  await expect(page.getByTestId("interview-preview-prd")).toBeVisible();
  await expect(page.getByTestId("interview-tab-idea")).toHaveCount(0);
  await page.getByTestId("interview-accept-toggle").click();
  await stepsToReview(page);
  await expect(page.getByTestId("wizard-review-documentation")).toContainText("IDEA: skipped · PRD: docs/PRD.md (new draft)");
  await page.getByTestId("wizard-submit").click();
  await expect(page.getByTestId("project-wizard")).toHaveCount(0);
  expect((await readdir(path.join(dir, "docs"))).sort()).toEqual(["PRD.md"]);
  expect(await readFile(path.join(dir, "docs", "PRD.md"), "utf8")).toContain("PRD");
  await expect(page.getByTestId("project-doc-prd")).toHaveAttribute("data-state", "exists");
  await expect(page.getByTestId("project-doc-idea")).toHaveAttribute("data-state", "missing");
});

test("skip PRD only, undo a skip, and a skip never reaches the next folder", async ({ page, backend }) => {
  const dir = await tempDir("undo");
  const other = await tempDir("other");
  await gotoApp(page, backend.bootBase);
  await toDocs(page, "Undo", dir);
  await page.getByTestId("wizard-doc-prd-skip").click();
  await expect(page.getByTestId("wizard-doc-prd-status")).toHaveText("Skipped");
  await expect(page.getByTestId("wizard-doc-idea-status")).toHaveText("Missing");
  await expect(page.getByTestId("wizard-docs-interview")).toContainText("Missing: IDEA.md");
  await page.getByTestId("wizard-doc-prd-unskip").click();
  await expect(page.getByTestId("wizard-doc-prd-status")).toHaveText("Missing");
  await page.getByTestId("wizard-doc-prd-skip").click();
  await page.getByTestId("wizard-step-project").click();
  await page.getByTestId("wizard-directory").fill(other);
  await page.getByTestId("wizard-next").click();
  await page.getByTestId("wizard-next").click();
  await expect(page.getByTestId("wizard-body")).toHaveAttribute("data-step", "docs");
  await expect(page.getByTestId("wizard-doc-prd-status")).toHaveText("Missing");
  await page.getByTestId("wizard-cancel").click();
  expect(await readdir(dir)).toEqual([]);
  expect(await readdir(other)).toEqual([]);
});

test("keyboard: Skip is reachable and works from the keyboard at a narrow width", async ({ page, backend }) => {
  await page.setViewportSize({ width: 390, height: 800 });
  const dir = await tempDir("kbd");
  await gotoApp(page, backend.bootBase);
  await toDocs(page, "Keys", dir);
  const skip = page.getByTestId("wizard-docs-skip-all");
  await skip.focus();
  await expect(skip).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(page.getByTestId("wizard-body")).toHaveAttribute("data-step", "environment");
  const box = await page.getByTestId("project-wizard").boundingBox();
  expect(box!.width).toBeLessThanOrEqual(390);
});

test("create IDEA later from the workspace, then PRD, and an existing document is never overwritten", async ({ page, request, freshBackend: backend }) => {
  await enableCodex(request, backend);
  const dir = await tempDir("later");
  await writeFile(path.join(dir, "notes.txt"), "stay\n");
  const registered = await request.post(`${backend.apiBase}/projects`, { headers: auth(backend), data: { path: dir, name: "Later Desk" } });
  expect(registered.ok()).toBeTruthy();
  const turns = countTurns(page);

  await gotoApp(page, backend.bootBase);
  await openProject(page, "Later Desk");
  await expect(page.getByTestId("project-doc-idea")).toHaveAttribute("data-state", "missing");
  await expect(page.getByTestId("project-doc-prd")).toHaveAttribute("data-state", "missing");

  await page.getByTestId("project-doc-idea-create").click();
  await expect(page.getByTestId("create-doc-dialog")).toHaveAttribute("data-kind", "idea");
  await expect(page.getByTestId("create-doc-submit")).toBeDisabled();
  expect(turns()).toBe(0);
  await page.getByTestId("interview-harness").selectOption("codex");
  await page.getByTestId("interview-consent").check();
  await page.getByTestId("interview-start").click();
  await expect(page.getByTestId("interview-message").last()).toContainText("What do you want to build");
  expect(turns()).toBe(1);
  await page.getByTestId("interview-answer").fill("An internal help desk for facilities requests");
  await page.getByTestId("interview-send").click();
  await expect(page.getByTestId("interview-message").last()).toContainText("main users");
  await page.getByTestId("interview-finish").click();
  await expect(page.getByTestId("interview-preview-idea")).toBeVisible();
  // Generating writes nothing.
  expect(await exists(path.join(dir, "docs"))).toBe(false);
  await expect(page.getByTestId("create-doc-submit")).toBeEnabled();
  await page.getByTestId("create-doc-submit").click();
  await expect(page.getByTestId("create-doc-dialog")).toHaveCount(0);

  expect(await readFile(path.join(dir, "docs", "IDEA.md"), "utf8")).toContain("An internal help desk for facilities requests");
  expect(await exists(path.join(dir, "docs", "PRD.md"))).toBe(false);
  await expect(page.getByTestId("project-doc-idea")).toHaveAttribute("data-state", "exists");
  await expect(page.getByTestId("project-doc-idea-status")).toHaveText("docs/IDEA.md");
  await expect(page.getByTestId("project-doc-idea-create")).toHaveCount(0);
  await expect(page.getByTestId("project-doc-prd")).toHaveAttribute("data-state", "missing");

  // The recorded location survives a reload.
  await page.reload();
  await openProject(page, "Later Desk");
  await expect(page.getByTestId("project-doc-idea-status")).toHaveText("docs/IDEA.md");

  // PRD next, with IDEA now existing as context.
  await page.getByTestId("project-doc-prd-create").click();
  await expect(page.getByTestId("create-doc-dialog")).toHaveAttribute("data-kind", "prd");
  await page.getByTestId("interview-harness").selectOption("codex");
  await page.getByTestId("interview-consent").check();
  await page.getByTestId("interview-start").click();
  await expect(page.getByTestId("interview-message").last()).toContainText("What do you want to build");
  await expect(page.getByTestId("interview-doc-idea")).toContainText("Exists: docs/IDEA.md");
  await page.getByTestId("interview-finish").click();
  await expect(page.getByTestId("interview-preview-prd")).toBeVisible();
  // A file appears at the target before Create: it must win.
  await mkdir(path.join(dir, "docs"), { recursive: true });
  await writeFile(path.join(dir, "docs", "PRD.md"), "# Written meanwhile\n");
  await page.getByTestId("create-doc-submit").click();
  await expect(page.getByTestId("create-doc-error")).toContainText("already exists");
  expect(await readFile(path.join(dir, "docs", "PRD.md"), "utf8")).toBe("# Written meanwhile\n");
  await page.getByTestId("create-doc-cancel").click();
  await expect(page.getByTestId("create-doc-dialog")).toHaveCount(0);
  await expect(page.getByTestId("project-doc-prd")).toHaveAttribute("data-state", "exists");
});

test("the Docs step and the documents card fit every width in light and dark", async ({ page, backend }) => {
  const dir = await tempDir("layout");
  await gotoApp(page, backend.bootBase);
  for (const scheme of ["light", "dark"] as const) {
    await page.emulateMedia({ colorScheme: scheme });
    for (const width of [390, 768, 1024, 1440]) {
      await page.setViewportSize({ width, height: 900 });
      await page.getByTestId("workspace-add-project").click();
      await page.getByTestId("wizard-name").fill("Layout");
      await page.getByTestId("wizard-directory").fill(dir);
      await page.getByTestId("wizard-next").click();
      await page.getByTestId("wizard-next").click();
      await expect(page.getByTestId("wizard-body")).toHaveAttribute("data-step", "docs");
      await page.getByTestId("wizard-doc-idea-skip").click();
      for (const id of ["wizard-docs-skip-all", "wizard-doc-idea-unskip", "wizard-doc-prd-skip"]) {
        const box = await page.getByTestId(id).boundingBox();
        expect(box, id).not.toBeNull();
        expect(box!.x).toBeGreaterThanOrEqual(0);
        expect(box!.x + box!.width).toBeLessThanOrEqual(width);
      }
      const overflow = await page.getByTestId("wizard-body").evaluate((el) => el.scrollWidth - el.clientWidth);
      expect(overflow).toBeLessThanOrEqual(1);
      await page.screenshot({ path: test.info().outputPath(`docs-${scheme}-${width}.png`) });
      await page.getByTestId("wizard-cancel").click();
      await expect(page.getByTestId("project-wizard")).toHaveCount(0);
    }
  }
});
