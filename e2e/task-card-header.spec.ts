import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { test, expect, type APIRequestContext, type E2EBackend, type Locator, type Page } from "./fixtures";
import { gotoBoard } from "./helpers";

/**
 * Manager-first board cards keep title, current status and next action visible.
 * Technical metadata remains available after explicitly expanding Details.
 * Geometry checks ensure metadata follows the action and the title keeps its
 * own full-width row. These are fixture-only checks; no run is started.
 */

test.describe.configure({ mode: "serial" });

interface TaskRow {
  id: string;
  title: string;
}

/** Create (but never start) a task with a task type + model + mode set, so
 *  the board card renders every header row this spec asserts on. isolation
 *  "none" + a plain temp dir keeps this a pure API/DB round-trip — no git,
 *  no worktree, no agent process. */
async function createHeaderTask(
  request: APIRequestContext,
  backend: E2EBackend,
  title: string,
): Promise<TaskRow> {
  const auth = { authorization: `Bearer ${backend.apiToken}` };
  const createRes = await request.post(`${backend.apiBase}/tasks`, {
    headers: auth,
    data: {
      title,
      prompt: "investigate and fix the reported defect",
      isolation: "none",
      workdir: tmpdir(),
      agent: "claude-code",
      taskType: "bug",
      model: "opus",
      mode: "auto",
    },
  });
  expect(createRes.ok(), `POST /tasks -> ${createRes.status()}: ${await createRes.text()}`).toBeTruthy();
  return (await createRes.json()) as TaskRow;
}

/** Scopes a locator to the board `TaskCard` for the given exact title —
 *  mirrors `e2e/unread-indicator.spec.ts`'s `taskCard` helper: the root
 *  `<Card>` carries `cursor-grab` (drag-handle styling unique to board
 *  cards; the run panel's `<aside>` never has it), so this can't
 *  accidentally match anything else in the DOM. */
function taskCard(page: Page, title: string) {
  return page.locator('[data-testid="task-card"]').filter({ has: page.getByText(title, { exact: true }) });
}

/** The row-1 harness badge (`<Badge variant="secondary">` in TaskCard.tsx).
 *  Not locatable via `getByText("claude-code", { exact: true })`:
 *  `@lobehub/icons`' `ClaudeCode.Color` glyph renders a hidden SVG
 *  `<title>Claude Code</title>` node, which DOM `textContent` (what
 *  Playwright's text matching reads) concatenates with the badge's own
 *  `claude-code` text node — the badge's real `textContent` is
 *  `"Claude Codeclaude-code"`, not `"claude-code"`, so an exact match never
 *  hits. The badge carries its own test id (it used to be found by its pill
 *  shape class, which FO-UX-VISUAL01 changed); it selects the whole badge
 *  (icon + text), which is also what geometry assertions want. */
function harnessBadge(card: Locator) {
  return card.getByTestId("task-card-harness");
}

/** Bounding boxes are asserted repeatedly below; a thin wrapper keeps every
 *  call site honest about non-null (Playwright returns null only for a
 *  detached/invisible element, which every locator here has already been
 *  proven visible before this is called). */
async function box(locator: Locator) {
  const b = await locator.boundingBox();
  expect(b, "expected a visible element with a bounding box").not.toBeNull();
  return b!;
}

test.describe("task card header layout", () => {
  test("renders the type icon, harness badge, model·mode line, and title inside the card", async ({
    page,
    request,
    backend,
  }) => {
    const title = `header-e2e ${randomUUID()} verify the header layout renders`;
    await createHeaderTask(request, backend, title);

    await gotoBoard(page, backend.bootBase);
    const card = taskCard(page, title);
    await expect(card).toBeVisible({ timeout: 10_000 });

    await card.locator("summary").filter({ hasText: "Details" }).click();

    // Row 1, left cluster: task-type icon. "bug" -> TASK_TYPES' "Bug" label
    // (src/shared/types.ts), applied verbatim as the icon's aria-label.
    await expect(card.locator('[aria-label="Bug"]')).toBeVisible();

    // Row 1, right: the harness badge renders `task.agent` verbatim (in
    // amongst the brand glyph's own hidden SVG <title> text — see
    // `harnessBadge`'s doc comment — hence `toContainText`, not an exact
    // match).
    await expect(harnessBadge(card)).toContainText("claude-code");

    // Row 2: `[model, mode].join(" · ")`.
    await expect(card.getByText("opus · auto", { exact: true })).toBeVisible();

    // Row 3: the full title.
    await expect(card.getByText(title, { exact: true })).toBeVisible();
  });

  test("lays the card out title+icon, status, next action, then harness/model metadata (M5)", async ({
    page,
    request,
    backend,
  }) => {
    const title = `header-e2e ${randomUUID()} confirm the card row geometry`;
    await createHeaderTask(request, backend, title);

    await gotoBoard(page, backend.bootBase);
    const card = taskCard(page, title);
    await expect(card).toBeVisible({ timeout: 10_000 });

    await card.locator("summary").filter({ hasText: "Details" }).click();
    const icon = card.locator('[aria-label="Bug"]');
    const cardTitle = card.getByText(title, { exact: true });
    const status = card.getByTestId("task-card-status");
    const action = card.getByTestId("task-card-primary");
    const badge = harnessBadge(card);
    const modelMode = card.getByText("opus · auto", { exact: true });
    await expect(icon).toBeVisible();
    await expect(cardTitle).toBeVisible();
    await expect(status).toBeVisible();
    await expect(action).toBeVisible();
    await expect(badge).toBeVisible();
    await expect(modelMode).toBeVisible();

    const [iconBox, titleBox, statusBox, actionBox, badgeBox, modelModeBox] = await Promise.all([
      box(icon), box(cardTitle), box(status), box(action), box(badge), box(modelMode),
    ]);

    // Row 1: the type icon sits at the left of the title, on its first line.
    expect(iconBox.x, "type icon should sit left of the title").toBeLessThan(titleBox.x);
    expect(Math.abs(iconBox.y - titleBox.y), "icon and title share the first line").toBeLessThan(10);
    // Row 2: status (as words) under the title. Row 3: the next action under the status.
    expect(statusBox.y, "status should sit below the title").toBeGreaterThan(titleBox.y + titleBox.height - 2);
    expect(actionBox.y, "the next action should sit below the status").toBeGreaterThan(statusBox.y + statusBox.height - 2);
    // Row 4: secondary metadata (harness badge, model · mode) comes after the action.
    expect(badgeBox.y, "harness badge is secondary metadata below the action").toBeGreaterThan(actionBox.y);
    expect(modelModeBox.y, "model · mode is secondary metadata below the action").toBeGreaterThan(actionBox.y);
  });
});
