import { access, chmod, mkdir, mkdtemp, readFile, readdir, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test, expect, type APIRequestContext, type E2EBackend, type Page } from "./fixtures";
import { gotoApp } from "./helpers";

/**
 * FO-003 AI project interview inside the project wizard. Every agent is the
 * fake codex driver (no real CLI, no AI quota). Each test gets a fresh
 * backend so saved interviews and projects never leak between tests.
 */

test.describe.configure({ mode: "serial" });
test.use({
  backendEnv: {
    AGETOR_CODEX_DRIVER: "fake",
    AGETOR_CODEX_BIN: "/bin/echo",
    AGETOR_FAKE_INTERVIEW_DELAY_MS: "300",
  },
});

function auth(backend: E2EBackend): { authorization: string } {
  return { authorization: `Bearer ${backend.apiToken}` };
}

async function tempDir(name: string): Promise<string> {
  return mkdtemp(path.join(tmpdir(), `fo003-${name}-`));
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

/** Counts interview turn requests, to prove none is sent without a click. */
function countTurns(page: Page): () => number {
  let turns = 0;
  page.on("request", (req) => {
    if (req.method() === "POST" && req.url().includes("/project-interviews/turns")) turns += 1;
  });
  return () => turns;
}

async function openWizard(page: Page): Promise<void> {
  await page.getByTestId("workspace-add-project").click();
  await expect(page.getByTestId("project-wizard")).toBeVisible();
}

async function toDocs(page: Page, fields: { name: string; directory: string; folderName?: string; mode?: "create" | "import" }): Promise<void> {
  await openWizard(page);
  if (fields.mode === "create") await page.getByTestId("wizard-mode-create").click();
  await page.getByTestId("wizard-name").fill(fields.name);
  await page.getByTestId("wizard-directory").fill(fields.directory);
  if (fields.folderName) {
    await page.getByTestId("wizard-placement-new-folder").click();
    await page.getByTestId("wizard-folder-name").fill(fields.folderName);
  }
  await page.getByTestId("wizard-next").click();
  await expect(page.getByTestId("wizard-body")).toHaveAttribute("data-step", "discovery");
  await page.getByTestId("wizard-next").click();
  await expect(page.getByTestId("wizard-body")).toHaveAttribute("data-step", "docs");
}

/** The isolation summary must be confirmed before the first turn. */
async function consent(page: Page): Promise<void> {
  await expect(page.getByTestId("interview-isolation")).toBeVisible();
  await expect(page.getByTestId("interview-start")).toBeDisabled();
  await page.getByTestId("interview-consent").check();
  await expect(page.getByTestId("interview-start")).toBeEnabled();
}

async function startInterview(page: Page): Promise<void> {
  await page.getByTestId("wizard-open-interview").click();
  await expect(page.getByTestId("interview")).toBeVisible();
  await page.getByTestId("interview-harness").selectOption("codex");
  await consent(page);
  await page.getByTestId("interview-start").click();
  await expect(page.getByTestId("interview-message").last()).toContainText("What do you want to build");
}

async function answer(page: Page, text: string, expectNext: string | RegExp): Promise<void> {
  await page.getByTestId("interview-answer").fill(text);
  await page.getByTestId("interview-send").click();
  await expect(page.getByTestId("interview-message").last()).toContainText(expectNext);
}

async function toReview(page: Page): Promise<void> {
  await page.getByTestId("wizard-next").click();
  await expect(page.getByTestId("wizard-body")).toHaveAttribute("data-step", "environment");
  await page.getByTestId("wizard-next").click();
  await expect(page.getByTestId("wizard-body")).toHaveAttribute("data-step", "launch");
  await page.getByTestId("wizard-next").click();
  await expect(page.getByTestId("wizard-body")).toHaveAttribute("data-step", "review");
}

test("new project: interview, drafts, preview, edit, improve, and confirmed write", async ({ page, request, freshBackend: backend }) => {
  await enableCodex(request, backend);
  const parent = await tempDir("new");
  const created = path.join(parent, "orbit-notes");
  const turns = countTurns(page);

  await gotoApp(page, backend.bootBase);
  await toDocs(page, { name: "Orbit Notes", directory: parent, folderName: "orbit-notes", mode: "create" });
  await expect(page.getByTestId("wizard-docs-interview")).toContainText("Missing: IDEA.md and PRD.md");
  // Opening the wizard and the interview sends nothing to any agent.
  await page.getByTestId("wizard-open-interview").click();
  await expect(page.getByTestId("interview-log")).toContainText("Nothing has been sent yet");
  expect(turns()).toBe(0);
  await page.getByTestId("interview-back").click();

  await startInterview(page);
  expect(turns()).toBe(1);
  await answer(page, "A shared notes app for small teams", "main users");
  await page.getByTestId("interview-skip").click();
  await expect(page.getByTestId("interview-message").last()).toContainText("MVP");
  await expect(page.getByTestId("interview-message").filter({ hasText: "(skipped)" })).toHaveCount(1);
  await answer(page, "Offline sync and search", "enough to draft");
  await page.getByTestId("interview-notes").locator("summary").click();
  await expect(page.getByTestId("interview-notes-confirmed")).toContainText("Offline sync and search");
  await expect(page.getByTestId("interview-notes-open")).toContainText("Pricing is not decided");

  await page.getByTestId("interview-finish").click();
  await expect(page.getByTestId("interview-preview-idea")).toBeVisible();
  await expect(page.getByTestId("interview-markdown").locator("h1")).toHaveText("Orbit Notes");
  await expect(page.getByTestId("interview-target")).toHaveValue("docs/IDEA.md");
  // Generating never writes: the folder doesn't even exist yet.
  expect(await exists(created)).toBe(false);

  await page.getByTestId("interview-mode-edit").click();
  const edited = "# Orbit Notes\n\n## Product Summary\nEdited by hand.\n";
  await page.getByTestId("interview-editor").fill(edited);
  await page.getByTestId("interview-mode-preview").click();
  await expect(page.getByTestId("interview-markdown")).toContainText("Edited by hand.");

  await page.getByTestId("interview-tab-prd").click();
  await page.getByTestId("interview-improve-section").selectOption("Functional Requirements");
  await page.getByTestId("interview-improve-instruction").fill("List offline sync");
  await page.getByTestId("interview-improve-submit").click();
  await expect(page.getByTestId("interview-markdown")).toContainText("Revised section: List offline sync");

  await page.getByTestId("interview-accept-toggle").click();
  await expect(page.getByTestId("interview-accept-toggle")).toHaveAttribute("aria-checked", "true");
  await toReview(page);
  await expect(page.getByTestId("wizard-change").filter({ hasText: "Create docs/IDEA.md from the draft" })).toBeVisible();
  await expect(page.getByTestId("wizard-change").filter({ hasText: "Do not overwrite any existing document" })).toBeVisible();
  await expect(page.getByTestId("wizard-review-documentation")).toContainText("docs/PRD.md (new draft)");
  expect(await exists(created)).toBe(false);

  await page.getByTestId("wizard-submit").click();
  await expect(page.getByTestId("project-wizard")).toHaveCount(0);
  expect(await readFile(path.join(created, "docs", "IDEA.md"), "utf8")).toBe(edited);
  const prd = await readFile(path.join(created, "docs", "PRD.md"), "utf8");
  expect(prd).toContain("Revised section: List offline sync");
  expect(prd).toContain("Offline sync and search");
  expect((await readdir(created)).sort()).toEqual(["docs"]);
  // The saved interview is gone once the documents exist.
  const saved = await request.get(`${backend.apiBase}/project-interviews/draft?path=${encodeURIComponent(created)}`, { headers: auth(backend) });
  expect((await saved.json()).state).toBeNull();
});

test("existing project with only IDEA.md at an alternative path drafts PRD.md beside it", async ({ page, request, freshBackend: backend }) => {
  await enableCodex(request, backend);
  const dir = await tempDir("idea-only");
  await writeFile(path.join(dir, "IDEA.md"), "# Existing idea\n\nKeep me.\n");
  await writeFile(path.join(dir, "README.md"), "# Readme\n");

  await gotoApp(page, backend.bootBase);
  await toDocs(page, { name: "Idea Only", directory: dir });
  await expect(page.getByTestId("wizard-docs-interview")).toContainText("Missing: PRD.md");
  await startInterview(page);
  await expect(page.getByTestId("interview-doc-idea")).toContainText("Exists: IDEA.md");
  await expect(page.getByTestId("interview-tab-idea")).toHaveCount(0);
  await page.getByTestId("interview-finish").click();
  await expect(page.getByTestId("interview-preview-prd")).toBeVisible();
  await expect(page.getByTestId("interview-target")).toHaveValue("PRD.md");
  await page.getByTestId("interview-accept-toggle").click();
  await toReview(page);
  await page.getByTestId("wizard-submit").click();
  await expect(page.getByTestId("project-wizard")).toHaveCount(0);
  expect(await readFile(path.join(dir, "IDEA.md"), "utf8")).toBe("# Existing idea\n\nKeep me.\n");
  expect(await readFile(path.join(dir, "PRD.md"), "utf8")).toContain("# Idea Only PRD");
  expect(await exists(path.join(dir, "docs"))).toBe(false);
});

test("a file that appears at the target blocks confirm and is never overwritten", async ({ page, request, freshBackend: backend }) => {
  await enableCodex(request, backend);
  const dir = await tempDir("conflict");
  await gotoApp(page, backend.bootBase);
  await toDocs(page, { name: "Conflict", directory: dir });
  await startInterview(page);
  await page.getByTestId("interview-finish").click();
  await expect(page.getByTestId("interview-preview-idea")).toBeVisible();
  await page.getByTestId("interview-accept-toggle").click();

  await mkdir(path.join(dir, "docs"));
  await writeFile(path.join(dir, "docs", "PRD.md"), "# Written meanwhile\n");
  await toReview(page);
  await expect(page.getByTestId("wizard-doc-conflicts")).toContainText("docs/PRD.md already exists");
  await expect(page.getByTestId("wizard-submit")).toBeDisabled();
  expect(await readFile(path.join(dir, "docs", "PRD.md"), "utf8")).toBe("# Written meanwhile\n");
  expect(await exists(path.join(dir, "docs", "IDEA.md"))).toBe(false);

  // A traversal path is refused in the preview.
  await page.getByTestId("wizard-step-docs").click();
  await page.getByTestId("wizard-open-interview").click();
  await page.getByTestId("interview-tab-prd").click();
  await page.getByTestId("interview-target").fill("../PRD.md");
  await expect(page.getByTestId("interview-target-hint")).toContainText("must stay inside the project");
  await expect(page.getByTestId("interview-accept-toggle")).toBeDisabled();
  await page.getByTestId("interview-target").fill("docs/PRD-draft.md");
  await page.getByTestId("interview-accept-toggle").click();
  await toReview(page);
  await expect(page.getByTestId("wizard-doc-conflicts")).toHaveCount(0);
  await page.getByTestId("wizard-submit").click();
  await expect(page.getByTestId("project-wizard")).toHaveCount(0);
  expect(await readFile(path.join(dir, "docs", "PRD.md"), "utf8")).toBe("# Written meanwhile\n");
  expect(await readFile(path.join(dir, "docs", "PRD-draft.md"), "utf8")).toContain("PRD");
  expect(await exists(path.join(dir, "docs", "IDEA.md"))).toBe(true);
});

test("declining to save drafts writes nothing", async ({ page, request, freshBackend: backend }) => {
  await enableCodex(request, backend);
  const dir = await tempDir("decline");
  await gotoApp(page, backend.bootBase);
  await toDocs(page, { name: "Decline", directory: dir });
  await startInterview(page);
  await page.getByTestId("interview-finish").click();
  await expect(page.getByTestId("interview-preview-idea")).toBeVisible();
  await toReview(page);
  await expect(page.getByTestId("wizard-change").filter({ hasText: "Do not create or overwrite IDEA.md" })).toBeVisible();
  await page.getByTestId("wizard-submit").click();
  await expect(page.getByTestId("project-wizard")).toHaveCount(0);
  expect(await readdir(dir)).toEqual([]);
});

test("unsupported agent, CLI error with retry, edit answer, and cancel", async ({ page, request, freshBackend: backend }) => {
  await enableCodex(request, backend);
  const dir = await tempDir("errors");
  await gotoApp(page, backend.bootBase);
  await toDocs(page, { name: "Errors", directory: dir });
  await page.getByTestId("wizard-open-interview").click();
  await page.getByTestId("interview-harness").selectOption("claude-code");
  await expect(page.getByTestId("interview-agent-problem")).toContainText("Interviews don't support it yet");
  await expect(page.getByTestId("interview-start")).toBeDisabled();

  await page.getByTestId("interview-harness").selectOption("codex");
  await consent(page);
  await page.getByTestId("interview-start").click();
  await expect(page.getByTestId("interview-message").last()).toContainText("What do you want to build");

  await page.getByTestId("interview-answer").fill("__fake_interview_fail__");
  await page.getByTestId("interview-send").click();
  await expect(page.getByTestId("interview-error")).toContainText("CLI exited with an error");
  await expect(page.getByTestId("interview-retry")).toBeVisible();
  await page.getByTestId("interview-edit-last").click();
  await expect(page.getByTestId("interview-answer")).toHaveValue("__fake_interview_fail__");
  await answer(page, "A planner", "main users");
  await expect(page.getByTestId("interview-error")).toHaveCount(0);

  await page.getByTestId("interview-answer").fill("__fake_interview_slow__ students");
  await page.getByTestId("interview-send").click();
  await expect(page.getByTestId("interview-busy")).toBeVisible();
  await page.getByTestId("interview-cancel").click();
  await expect(page.getByTestId("interview-error")).toContainText("Request cancelled");
  await expect(page.getByTestId("interview-busy")).toHaveCount(0);
  expect(await readdir(dir)).toEqual([]);
});

test("the interview survives Back, closing the wizard, and is restored for the same folder", async ({ page, request, freshBackend: backend }) => {
  await enableCodex(request, backend);
  const dir = await tempDir("restore");
  await gotoApp(page, backend.bootBase);
  await toDocs(page, { name: "Restore", directory: dir });
  await startInterview(page);
  await answer(page, "A recipe tracker", "main users");

  await page.getByTestId("wizard-back").click();
  await expect(page.getByTestId("wizard-docs")).toBeVisible();
  await page.getByTestId("wizard-back").click();
  await expect(page.getByTestId("wizard-body")).toHaveAttribute("data-step", "discovery");
  await page.getByTestId("wizard-next").click();
  await expect(page.getByTestId("wizard-docs-interview-progress")).toContainText("Interview in progress");

  // Closing the wizard while a turn runs stops that turn on the server.
  await page.getByTestId("wizard-open-interview").click();
  // A reopened interview asks for confirmation again before sending.
  await page.getByTestId("interview-answer").fill("__fake_interview_slow__ families");
  await expect(page.getByTestId("interview-send")).toBeDisabled();
  await page.getByTestId("interview-consent").check();
  await expect(page.getByTestId("interview-send")).toBeEnabled();
  const turnResponse = page.waitForResponse((res) => res.url().includes("/project-interviews/turns") && res.request().method() === "POST");
  await page.getByTestId("interview-send").click();
  const turnId = ((await (await turnResponse).json()) as { id: string }).id;
  await expect(page.getByTestId("interview-busy")).toBeVisible();
  await page.getByTestId("wizard-cancel").click();
  await expect(page.getByTestId("project-wizard")).toHaveCount(0);
  await expect.poll(async () => {
    const res = await request.get(`${backend.apiBase}/project-interviews/turns/${turnId}`, { headers: auth(backend) });
    return ((await res.json()) as { status: string }).status;
  }).toBe("cancelled");
  expect(await readdir(dir)).toEqual([]);

  await toDocs(page, { name: "Restore", directory: dir });
  await page.getByTestId("wizard-open-interview").click();
  await expect(page.getByTestId("interview-restored")).toBeVisible();
  await expect(page.getByTestId("interview-message").filter({ hasText: "A recipe tracker" })).toHaveCount(1);
  await page.getByTestId("interview-discard").click();
  await expect(page.getByTestId("wizard-docs")).toBeVisible();
  await page.getByTestId("wizard-cancel").click();
  const saved = await request.get(`${backend.apiBase}/project-interviews/draft?path=${encodeURIComponent(dir)}`, { headers: auth(backend) });
  expect((await saved.json()).state).toBeNull();
});

test("a document that fails to save is reported and can be retried", async ({ page, request, freshBackend: backend }) => {
  await enableCodex(request, backend);
  const dir = await tempDir("save-fail");
  const locked = path.join(dir, "locked");
  await mkdir(locked);
  await gotoApp(page, backend.bootBase);
  await toDocs(page, { name: "Save Fail", directory: dir });
  await startInterview(page);
  await page.getByTestId("interview-finish").click();
  await page.getByTestId("interview-tab-prd").click();
  await page.getByTestId("interview-target").fill("locked/PRD.md");
  await page.getByTestId("interview-accept-toggle").click();
  await chmod(locked, 0o555);
  try {
    await toReview(page);
    await page.getByTestId("wizard-submit").click();
    await expect(page.getByTestId("wizard-doc-result").filter({ hasText: "Created docs/IDEA.md" })).toBeVisible();
    await expect(page.getByTestId("wizard-doc-result").and(page.locator('[data-status="failed"]'))).toContainText("locked/PRD.md");
    await expect(page.getByTestId("wizard-error")).toContainText("could not be saved");
    await expect(page.getByTestId("wizard-back")).toHaveCount(0);

    const ideaFile = path.join(dir, "docs", "IDEA.md");
    const ideaBefore = await stat(ideaFile);
    const ideaText = await readFile(ideaFile, "utf8");
    await chmod(locked, 0o755);
    await page.getByTestId("wizard-submit").click();
    await expect(page.getByTestId("project-wizard")).toHaveCount(0);
    expect(await readFile(path.join(locked, "PRD.md"), "utf8")).toContain("PRD");
    // The retry wrote only PRD.md: IDEA.md is the same file, unchanged.
    const ideaAfter = await stat(ideaFile);
    expect(ideaAfter.ino).toBe(ideaBefore.ino);
    expect(ideaAfter.mtimeMs).toBe(ideaBefore.mtimeMs);
    expect(await readFile(ideaFile, "utf8")).toBe(ideaText);
    expect(ideaText).toContain("# Save Fail");
    expect((await readdir(path.join(dir, "docs"))).filter((name) => name.endsWith(".tmp"))).toEqual([]);
    expect((await readdir(locked)).filter((name) => name.endsWith(".tmp"))).toEqual([]);
  } finally {
    await chmod(locked, 0o755).catch(() => {});
  }
});

test("the interview fits a narrow window in light and dark", async ({ page, request, freshBackend: backend }) => {
  await enableCodex(request, backend);
  const dir = await tempDir("narrow");
  await gotoApp(page, backend.bootBase);
  await page.emulateMedia({ reducedMotion: "reduce" });
  for (const theme of ["Light", "Dark"] as const) {
    await page.getByRole("button", { name: "Settings", exact: true }).click();
    const settings = page.getByRole("dialog");
    await settings.getByRole("button", { name: theme, exact: true }).click();
    if (theme === "Dark") await expect(page.locator("html")).toHaveClass(/dark/);
    else await expect(page.locator("html")).not.toHaveClass(/dark/);
    await settings.getByRole("button", { name: "Close", exact: true }).click();

    await page.setViewportSize({ width: 420, height: 680 });
    await toDocs(page, { name: "Narrow", directory: dir });
    await page.getByTestId("wizard-open-interview").click();
    await expect(page.getByTestId("interview-start")).toBeVisible();
    const overflow = await page.getByTestId("wizard-body").evaluate((el) => el.scrollWidth - el.clientWidth);
    expect(overflow).toBeLessThanOrEqual(1);
    const color = await page.getByTestId("interview").evaluate((el) => {
      const match = getComputedStyle(el).color.match(/rgba?\((\d+)/);
      return match ? Number(match[1]) : -1;
    });
    if (theme === "Dark") expect(color).toBeGreaterThan(180);
    else expect(color).toBeLessThan(80);
    await page.getByTestId("interview-harness").selectOption("codex");
    await consent(page);
    await page.getByTestId("interview-start").click();
    await expect(page.getByTestId("interview-answer")).toBeVisible();
    await page.getByTestId("interview-discard").click();
    await page.getByTestId("wizard-cancel").click();
    await page.setViewportSize({ width: 1280, height: 800 });
  }
  await request.put(`${backend.apiBase}/preferences/theme`, { headers: auth(backend), data: { value: "auto" } });
});
