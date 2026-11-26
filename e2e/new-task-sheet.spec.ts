import { mkdtemp } from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { test, expect, type APIRequestContext, type E2EBackend, type Page } from "./fixtures";
import { gotoApp } from "./helpers";

/**
 * FO-UX02-D stage 1 (variant A): New task is a sheet (⌘N / "New task") unless
 * the Owner pins the panel, and "Needs you" is one list of everything on the
 * board that waits for the Owner. Specs about the sheet run with
 * `newTaskPinned: false` — the shipped default; every other spec keeps driving
 * the pinned panel (see `GotoAppOptions.newTaskPinned`).
 */

test.describe.configure({ mode: "parallel" });

const auth = (b: E2EBackend) => ({ authorization: `Bearer ${b.apiToken}` });

async function registerProject(request: APIRequestContext, b: E2EBackend, name: string): Promise<string> {
  const dir = await mkdtemp(path.join(b.dataDir, `ux02d-${name}-`));
  const res = await request.post(`${b.apiBase}/projects`, { headers: auth(b), data: { path: dir, name } });
  expect(res.ok()).toBeTruthy();
  return dir;
}

async function createTask(request: APIRequestContext, b: E2EBackend, title: string, workdir: string, extra: Record<string, unknown> = {}): Promise<{ id: string }> {
  const res = await request.post(`${b.apiBase}/tasks`, { headers: auth(b), data: { title, prompt: title, isolation: "none", workdir, ...extra } });
  expect(res.ok(), `POST /tasks -> ${res.status()}: ${await res.text()}`).toBeTruthy();
  return (await res.json()) as { id: string };
}

const sheet = (page: Page) => page.getByRole("dialog").locator('[data-testid="new-task-panel"][data-presentation="sheet"]');

test("New task opens as a sheet from the header button and ⌘N, keeps the draft, and creates a backlog task", async ({ page, request, freshBackend: backend }) => {
  const dir = await registerProject(request, backend, "Sheet Orbit");
  await gotoApp(page, backend.bootBase, { newTaskPinned: false });
  // Default: no permanent panel, no dialog.
  await expect(page.getByTestId("new-task-panel")).toHaveCount(0);
  await expect(page.getByRole("dialog")).toHaveCount(0);

  await page.getByTestId("header-new-task").click();
  await expect(sheet(page)).toBeVisible();
  await expect(sheet(page).getByPlaceholder("Short description")).toBeFocused();
  await sheet(page).getByPlaceholder("Short description").fill("Draft survives the sheet");

  // Esc closes, focus goes back to the trigger, and the draft is still there on reopen (⌘N / Ctrl+N).
  await page.keyboard.press("Escape");
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await expect(page.getByTestId("header-new-task")).toBeFocused();
  await page.keyboard.press("Control+n");
  await expect(sheet(page)).toBeVisible();
  await expect(sheet(page).getByPlaceholder("Short description")).toHaveValue("Draft survives the sheet");

  // Project context: opened from a project, the sheet starts in that project's directory.
  await page.getByTestId("new-task-sheet-close").click();
  await page.locator(`[data-testid="project-nav-item"][data-path="${dir}"]`).click();
  // Inside a project the project header owns the button; the title-bar one is not duplicated.
  await expect(page.getByTestId("header-new-task")).toHaveCount(0);
  await page.getByTestId("project-new-task").click();
  await expect(sheet(page)).toBeVisible();
  await expect(sheet(page)).toContainText(path.basename(dir));

  // Create into the backlog: the sheet closes and the task exists, not started.
  const title = `sheet-task-${randomUUID().slice(0, 8)}`;
  await sheet(page).getByPlaceholder("Short description").fill(title);
  await sheet(page).locator("textarea").first().fill("Written from the sheet");
  await sheet(page).getByRole("button", { name: "Create assignment" }).click();
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await expect.poll(async () => {
    const res = await request.get(`${backend.apiBase}/tasks`, { headers: auth(backend) });
    const rows = (await res.json()) as { title: string; column: string }[];
    return rows.find((t) => t.title === title)?.column ?? null;
  }).toBe("backlog");
});

test("⌘N does not stack a second dialog on top of an open modal", async ({ page, freshBackend: backend }) => {
  await gotoApp(page, backend.bootBase, { newTaskPinned: false });
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  await expect(page.getByRole("dialog")).toHaveCount(1);
  await page.keyboard.press("Control+n");
  await expect(page.getByRole("dialog")).toHaveCount(1);
  await expect(sheet(page)).toHaveCount(0);
});

test("pinning the panel in Settings brings the side panel back and survives a reload; ⌘N then just focuses it", async ({ page, freshBackend: backend }) => {
  await gotoApp(page, backend.bootBase, { newTaskPinned: false });
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  await page.getByRole("switch", { name: "Pin the New task panel" }).click();
  await page.keyboard.press("Escape");
  await expect(page.getByTestId("new-task-panel")).toBeVisible();
  await expect(page.getByTestId("new-task-panel")).not.toHaveAttribute("data-presentation", "sheet");

  await page.reload();
  await expect(page.getByTestId("new-task-panel")).toBeVisible();
  await page.keyboard.press("Control+n");
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await expect(page.getByTestId("new-task-panel").getByPlaceholder("Short description")).toBeFocused();
});

test("Needs you lists what waits for the Owner, most urgent first, and opens the task", async ({ page, request, freshBackend: backend }) => {
  const dir = await registerProject(request, backend, "Needs Orbit");
  await gotoApp(page, backend.bootBase);
  // Nothing waiting yet: empty state, no badge.
  await page.getByTestId("workspace-overview").click(); await page.getByTestId("workspace-attention").click();
  await expect(page.getByTestId("attention-page")).toBeVisible();
  await expect(page.getByTestId("attention-empty")).toBeVisible();
  await expect(page.getByTestId("workspace-overview-badge")).toHaveCount(0);

  const review = await createTask(request, backend, "Result to review", dir, { column: "review" });
  const blocked = await createTask(request, backend, "Stuck on a question", dir, { column: "blocked" });
  await createTask(request, backend, "Plain backlog task", dir);

  await expect(page.getByTestId("attention-row")).toHaveCount(2, { timeout: 10_000 });
  // Blocked outranks review.
  await expect(page.getByTestId("attention-row").nth(0)).toHaveAttribute("data-task-id", blocked.id);
  await expect(page.getByTestId("attention-row").nth(1)).toHaveAttribute("data-task-id", review.id);
  await expect(page.getByTestId("attention-count")).toContainText("2");
  await expect(page.getByTestId("workspace-overview-badge")).toHaveText("2");
  await expect(page.getByTestId("workspace-overview")).toHaveAttribute("aria-label", "Home, 2");

  // Open: the same run panel the board card opens; nothing is approved from this list.
  await page.getByTestId("attention-row").nth(1).getByTestId("attention-open").click();
  await expect(page.getByRole("complementary").or(page.getByTestId("run-panel")).first()).toBeVisible();
  await expect(page.getByText("Result to review").first()).toBeVisible();
});
