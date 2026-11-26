/**
 * Kanban urgency (1..5) and persisted vertical order (FO-KANBAN-URGENCY01), through the real board in Chromium and the
 * real Bun core on disposable projects. The order is asserted on the DOM the user sees, not just on an API answer.
 */
import { mkdirSync, mkdtempSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { expect, test, type APIRequestContext, type E2EBackend, type Locator, type Page } from "./fixtures";
import { gotoApp, openAllTasks } from "./helpers";
import { clickProjectPage } from "./project-nav";

const SHOTS = path.resolve(import.meta.dir, "../docs/qa/evidence/fo-kanban-urgency01");
const auth = (backend: E2EBackend) => ({ authorization: `Bearer ${backend.apiToken}`, "content-type": "application/json" });

test.describe.configure({ mode: "parallel", timeout: 120_000 });
test.use({ viewport: { width: 1500, height: 1300 } });

function makeProject(name: string): string {
  const root = realpathSync(mkdtempSync(path.join(tmpdir(), `fo-urgency-${name}-`)));
  const project = path.join(root, name);
  mkdirSync(project, { recursive: true });
  return project;
}

async function registerProject(request: APIRequestContext, backend: E2EBackend, name: string): Promise<string> {
  const dir = makeProject(name);
  const res = await request.post(`${backend.apiBase}/projects`, { headers: auth(backend), data: { path: dir, name } });
  expect(res.ok(), await res.text()).toBeTruthy();
  return (await res.json()).path as string;
}

async function addTask(request: APIRequestContext, backend: E2EBackend, workdir: string, title: string, urgency?: number, column = "ready"): Promise<string> {
  const res = await request.post(`${backend.apiBase}/tasks`, {
    headers: auth(backend),
    data: { title, prompt: `${title} prompt`, workdir, column, isolation: "none", ...(urgency === undefined ? {} : { urgency }) },
  });
  expect(res.ok(), await res.text()).toBeTruthy();
  return (await res.json()).id as string;
}

async function tasksOf(request: APIRequestContext, backend: E2EBackend): Promise<Array<{ id: string; title: string; column: string; urgency: number; boardRank: number; updatedAt: number }>> {
  return (await (await request.get(`${backend.apiBase}/tasks`, { headers: auth(backend) })).json()) as never;
}

/** Titles of the cards in one column, top to bottom, as rendered. */
async function shown(page: Page, column: string): Promise<string[]> {
  return page.locator(`[data-testid="task-card"][data-column="${column}"]`).evaluateAll((cards) =>
    cards.map((c) => c.getAttribute("aria-label") ?? ""),
  );
}

function card(page: Page, title: string): Locator {
  return page.locator(`[data-testid="task-card"][aria-label="${title}"]`);
}

type Point = { x: number; y: number };

async function center(locator: Locator): Promise<Point> {
  const box = (await locator.boundingBox())!;
  return { x: box.x + box.width / 2, y: box.y + box.height / 2 };
}

/** A real pointer drag with the mouse: down on the card's handle, move in steps, optionally hold (no mouse-up). */
async function dragHandle(page: Page, from: string, target: Point | (() => Promise<Point>), hold = false): Promise<void> {
  const start = await center(card(page, from).getByTestId("task-card-handle"));
  await page.mouse.move(start.x, start.y);
  await page.mouse.down();
  // The first small move arms the drag (the pointer sensor needs a few pixels), the rest follows the pointer.
  await page.mouse.move(start.x, start.y + 4, { steps: 2 });
  const end = typeof target === "function" ? await target() : target;
  await page.mouse.move(end.x, end.y, { steps: 16 });
  if (!hold) await page.mouse.up();
}

/** A point on the upper half of a card (drop above it) or the lower half (drop below it). */
async function onCard(page: Page, title: string, half: "upper" | "lower"): Promise<Point> {
  const box = (await card(page, title).boundingBox())!;
  return { x: box.x + box.width / 2, y: box.y + (half === "upper" ? box.height * 0.25 : box.height * 0.75) };
}

async function openBoard(page: Page, backend: E2EBackend, options: { pinned?: boolean } = {}): Promise<void> {
  // A tall window and the New Task panel unpinned: every card is on screen, so real mouse coordinates are valid.
  await gotoApp(page, backend.bootBase, { newTaskPinned: options.pinned ?? false });
  await openAllTasks(page);
  await expect(page.getByTestId("task-card").first()).toBeVisible({ timeout: 20_000 });
}

test("all five levels render on the cards in English and are ordered by urgency; the order survives a reload", async ({ page, request, freshBackend: backend }) => {
  const workdir = await registerProject(request, backend, "levels");
  for (const [u, name] of [[1, "Minimal"], [3, "Normal"], [5, "Critical"], [2, "Low"], [4, "High"]] as const) await addTask(request, backend, workdir, `${name} task`, u);
  await openBoard(page, backend);
  expect(await shown(page, "ready")).toEqual(["Critical task", "High task", "Normal task", "Low task", "Minimal task"]);
  const badges = await page.locator('[data-testid="task-card"][data-column="ready"] [data-testid="task-card-urgency"]').allTextContents();
  expect(badges).toEqual(["5/5 · Critical", "4/5 · High", "3/5 · Normal", "2/5 · Low", "1/5 · Minimal"]);
  await expect(page.getByTestId("urgency-separator")).toHaveCount(5);
  await page.screenshot({ path: path.join(SHOTS, "01-five-levels-en.png") });
  await page.reload();
  await expect(page.getByTestId("task-card").first()).toBeVisible({ timeout: 20_000 });
  expect(await shown(page, "ready")).toEqual(["Critical task", "High task", "Normal task", "Low task", "Minimal task"]);
});

test.describe("Russian", () => {
  test.use({ locale: "ru-RU" });
  test("all five levels render in Russian", async ({ page, request, freshBackend: backend }) => {
    const workdir = await registerProject(request, backend, "levels-ru");
    for (const u of [1, 2, 3, 4, 5]) await addTask(request, backend, workdir, `Задача ${u}`, u);
    await openBoard(page, backend);
    const badges = await page.locator('[data-testid="task-card"][data-column="ready"] [data-testid="task-card-urgency"]').allTextContents();
    expect(badges).toEqual(["5/5 · Критическая", "4/5 · Высокая", "3/5 · Обычная", "2/5 · Низкая", "1/5 · Минимальная"]);
    await page.screenshot({ path: path.join(SHOTS, "02-five-levels-ru.png") });
  });
});

test("a task created without urgency is 3/5; the New Task form offers urgency with 3/5 as the default", async ({ page, request, freshBackend: backend }) => {
  const workdir = await registerProject(request, backend, "default");
  const id = await addTask(request, backend, workdir, "No urgency given");
  expect((await tasksOf(request, backend)).find((t) => t.id === id)!.urgency).toBe(3);
  const bad = await request.post(`${backend.apiBase}/tasks`, { headers: auth(backend), data: { title: "x", prompt: "y", workdir, isolation: "none", urgency: 6 } });
  expect(bad.status()).toBe(400);
  await openBoard(page, backend, { pinned: true });
  await expect(card(page, "No urgency given").getByTestId("task-card-urgency")).toHaveText("3/5 · Normal");
  const select = page.getByTestId("new-task-urgency");
  await expect(select).toHaveValue("3");
  await expect(select.locator("option")).toHaveText(["5/5 · Critical", "4/5 · High", "3/5 · Normal", "2/5 · Low", "1/5 · Minimal"]);
});

async function sevenTasks(request: APIRequestContext, backend: E2EBackend, workdir: string) {
  await addTask(request, backend, workdir, "A five", 5);
  await addTask(request, backend, workdir, "B five", 5);
  await addTask(request, backend, workdir, "C four", 4);
  await addTask(request, backend, workdir, "D three", 3);
  await addTask(request, backend, workdir, "E three", 3);
  await addTask(request, backend, workdir, "F two", 2);
  await addTask(request, backend, workdir, "G one", 1);
}

test("dragging inside one urgency group reorders it with the mouse; nothing else changes and it persists", async ({ page, request, freshBackend: backend }) => {
  const workdir = await registerProject(request, backend, "inside");
  await sevenTasks(request, backend, workdir);
  await openBoard(page, backend);
  expect(await shown(page, "ready")).toEqual(["A five", "B five", "C four", "D three", "E three", "F two", "G one"]);
  const before = await tasksOf(request, backend);
  await page.screenshot({ path: path.join(SHOTS, "03-before-drag.png") });
  await dragHandle(page, "E three", () => onCard(page, "D three", "upper"), true);
  // An ordinary drag inside the group never shows the "same urgency only" hint.
  await expect(page.getByTestId("reorder-constraint-hint")).toHaveCount(0);
  await page.screenshot({ path: path.join(SHOTS, "04-dragging-inside-group.png") });
  await page.mouse.up();
  await expect.poll(() => shown(page, "ready")).toEqual(["A five", "B five", "C four", "E three", "D three", "F two", "G one"]);
  await page.screenshot({ path: path.join(SHOTS, "05-after-drag.png") });
  const after = await tasksOf(request, backend);
  for (const row of after) {
    const old = before.find((b) => b.id === row.id)!;
    expect([row.title, row.column, row.urgency, row.updatedAt]).toEqual([old.title, old.column, old.urgency, old.updatedAt]);
  }
  await page.reload();
  await expect(page.getByTestId("task-card").first()).toBeVisible({ timeout: 20_000 });
  expect(await shown(page, "ready")).toEqual(["A five", "B five", "C four", "E three", "D three", "F two", "G one"]);
});

test("the lowest card dragged to the very top lands first inside its own urgency, and the hint appears only outside the group", async ({ page, request, freshBackend: backend }) => {
  const workdir = await registerProject(request, backend, "top");
  await addTask(request, backend, workdir, "A five", 5);
  await addTask(request, backend, workdir, "C four", 4);
  await addTask(request, backend, workdir, "D three", 3);
  await addTask(request, backend, workdir, "G one", 1);
  await addTask(request, backend, workdir, "H one", 1);
  await openBoard(page, backend);
  expect(await shown(page, "ready")).toEqual(["A five", "C four", "D three", "G one", "H one"]);
  const topOfColumn = async () => { const box = (await card(page, "A five").boundingBox())!; return { x: box.x + box.width / 2, y: box.y + 2 }; };
  await dragHandle(page, "H one", topOfColumn, true);
  await expect(page.getByTestId("reorder-constraint-hint")).toBeVisible();
  await expect(page.getByTestId("reorder-constraint-hint")).toHaveText("Tasks can be reordered only within the same urgency level");
  await page.screenshot({ path: path.join(SHOTS, "06-constraint-hint.png") });
  await page.mouse.up();
  await expect(page.getByTestId("reorder-constraint-hint")).toHaveCount(0);
  // Final order: still below every higher urgency, first inside the urgency-1 group.
  await expect.poll(() => shown(page, "ready")).toEqual(["A five", "C four", "D three", "H one", "G one"]);
  const rows = await tasksOf(request, backend);
  expect(rows.find((t) => t.title === "H one")!.urgency).toBe(1);
  expect(rows.find((t) => t.title === "H one")!.column).toBe("ready");
});

test("a level-2 card dragged below everything stays last inside urgency 2, above urgency 1", async ({ page, request, freshBackend: backend }) => {
  const workdir = await registerProject(request, backend, "bottom");
  await sevenTasks(request, backend, workdir);
  await addTask(request, backend, workdir, "H two", 2);
  await openBoard(page, backend);
  expect(await shown(page, "ready")).toEqual(["A five", "B five", "C four", "D three", "E three", "F two", "H two", "G one"]);
  await dragHandle(page, "F two", async () => { const box = (await card(page, "G one").boundingBox())!; return { x: box.x + box.width / 2, y: box.y + box.height + 40 }; });
  await expect.poll(() => shown(page, "ready")).toEqual(["A five", "B five", "C four", "D three", "E three", "H two", "F two", "G one"]);
});

test("the server refuses a position outside the urgency group and a stale request, and the board stays as it was", async ({ request, freshBackend: backend }) => {
  const workdir = await registerProject(request, backend, "refuse");
  const low = await addTask(request, backend, workdir, "Low one", 1);
  const high = await addTask(request, backend, workdir, "High five", 5);
  const reorder = (id: string, body: unknown) => request.post(`${backend.apiBase}/tasks/${id}/reorder`, { headers: auth(backend), data: body });
  const outside = await reorder(low, { expectedColumn: "ready", expectedUrgency: 1, placement: { before: high } });
  expect(outside.status()).toBe(409);
  expect((await outside.json()).code).toBe("outside-group");
  const stale = await reorder(low, { expectedColumn: "ready", expectedUrgency: 4, placement: "first" });
  expect(stale.status()).toBe(409);
  expect((await stale.json()).code).toBe("stale");
  const noBearer = await request.post(`${backend.apiBase}/tasks/${low}/reorder`, { data: { expectedColumn: "ready", expectedUrgency: 1, placement: "first" } });
  expect([401, 403]).toContain(noBearer.status());
  const extra = await reorder(low, { expectedColumn: "ready", expectedUrgency: 1, placement: "first", column: "done" });
  expect(extra.status()).toBe(400);
  const rows = await tasksOf(request, backend);
  expect(rows.find((t) => t.id === low)!.column).toBe("ready");
  expect(rows.find((t) => t.id === low)!.urgency).toBe(1);
});

test("changing urgency in Task Details moves the card to the end of its new group and changes nothing else", async ({ page, request, freshBackend: backend }) => {
  const workdir = await registerProject(request, backend, "change");
  await addTask(request, backend, workdir, "Task A", 5);
  await addTask(request, backend, workdir, "Task B", 4);
  await addTask(request, backend, workdir, "Task C", 3);
  const dId = await addTask(request, backend, workdir, "Task D", 2);
  await openBoard(page, backend);
  const before = (await tasksOf(request, backend)).find((t) => t.id === dId)!;
  await card(page, "Task D").getByTestId("task-card-primary").click();
  await page.locator("aside").getByRole("button", { name: "Details", exact: true }).click();
  await page.getByText("Task details", { exact: true }).first().click();
  await page.getByTestId("task-urgency-select").selectOption("5");
  await expect.poll(() => shown(page, "ready")).toEqual(["Task A", "Task D", "Task B", "Task C"]);
  const after = (await tasksOf(request, backend)).find((t) => t.id === dId)!;
  expect([after.title, after.column, after.urgency]).toEqual([before.title, before.column, 5]);
  await page.screenshot({ path: path.join(SHOTS, "07-urgency-changed-details.png") });
  await page.keyboard.press("Escape");
  // It can now be dragged above the other urgency-5 card.
  await dragHandle(page, "Task D", () => onCard(page, "Task A", "upper"));
  await expect.poll(() => shown(page, "ready")).toEqual(["Task D", "Task A", "Task B", "Task C"]);
});

test("columns keep independent orders and a card moved to another column keeps its urgency", async ({ page, request, freshBackend: backend }) => {
  const workdir = await registerProject(request, backend, "columns");
  const r1 = await addTask(request, backend, workdir, "Ready one", 3);
  await addTask(request, backend, workdir, "Ready two", 3);
  await addTask(request, backend, workdir, "Backlog one", 3, "backlog");
  await addTask(request, backend, workdir, "Backlog two", 3, "backlog");
  await openBoard(page, backend);
  await dragHandle(page, "Ready two", () => onCard(page, "Ready one", "upper"));
  await expect.poll(() => shown(page, "ready")).toEqual(["Ready two", "Ready one"]);
  expect(await shown(page, "backlog")).toEqual(["Backlog one", "Backlog two"]);
  const moved = await request.patch(`${backend.apiBase}/tasks/${r1}`, { headers: auth(backend), data: { column: "backlog" } });
  expect(moved.ok()).toBeTruthy();
  await page.reload();
  await expect(page.getByTestId("task-card").first()).toBeVisible({ timeout: 20_000 });
  expect(await shown(page, "ready")).toEqual(["Ready two"]);
  expect(await shown(page, "backlog")).toEqual(["Backlog one", "Backlog two", "Ready one"]);
  expect((await tasksOf(request, backend)).find((t) => t.id === r1)!.urgency).toBe(3);
});

test("a filtered view reorders its visible cards without disturbing hidden ones", async ({ page, request, freshBackend: backend }) => {
  const workdir = await registerProject(request, backend, "filtered");
  for (const name of ["alpha one", "beta two", "alpha three", "beta four", "alpha five"]) await addTask(request, backend, workdir, name, 3);
  await openBoard(page, backend);
  expect(await shown(page, "ready")).toEqual(["alpha one", "beta two", "alpha three", "beta four", "alpha five"]);
  await page.getByPlaceholder(/search/i).first().fill("alpha");
  await expect.poll(() => shown(page, "ready")).toEqual(["alpha one", "alpha three", "alpha five"]);
  await dragHandle(page, "alpha five", () => onCard(page, "alpha one", "lower"));
  await expect.poll(() => shown(page, "ready")).toEqual(["alpha one", "alpha five", "alpha three"]);
  await page.getByPlaceholder(/search/i).first().fill("");
  // The hidden "beta" cards kept their relative order; the moved card sits right after its visible neighbour.
  await expect.poll(() => shown(page, "ready")).toEqual(["alpha one", "alpha five", "beta two", "alpha three", "beta four"]);
  await page.reload();
  await expect(page.getByTestId("task-card").first()).toBeVisible({ timeout: 20_000 });
  expect(await shown(page, "ready")).toEqual(["alpha one", "alpha five", "beta two", "alpha three", "beta four"]);
});

test("a paused project can be reordered without being resumed", async ({ page, request, freshBackend: backend }) => {
  const workdir = await registerProject(request, backend, "paused");
  await addTask(request, backend, workdir, "First", 3);
  await addTask(request, backend, workdir, "Second", 3);
  const stop = await request.post(`${backend.apiBase}/projects/lifecycle/stop`, { headers: auth(backend), data: { path: workdir, reason: "e2e" } });
  expect(stop.ok(), await stop.text()).toBeTruthy();
  const state = async () => (await (await request.get(`${backend.apiBase}/projects/lifecycle?path=${encodeURIComponent(workdir)}`, { headers: auth(backend) })).json()).lifecycle.state as string;
  const pausedState = await state();
  expect(["paused", "draining"]).toContain(pausedState);
  await openBoard(page, backend);
  await dragHandle(page, "Second", () => onCard(page, "First", "upper"));
  await expect.poll(() => shown(page, "ready")).toEqual(["Second", "First"]);
  expect(await state()).toBe(pausedState);
  expect(await (await request.get(`${backend.apiBase}/tasks`, { headers: auth(backend) })).json()).toHaveLength(2);
  const runs = await Promise.all((await tasksOf(request, backend)).map(async (t) => (await (await request.get(`${backend.apiBase}/tasks/${t.id}/runs`, { headers: auth(backend) })).json()).length));
  expect(runs).toEqual([0, 0]);
});

test("a card is reordered from the keyboard inside its urgency group", async ({ page, request, freshBackend: backend }) => {
  const workdir = await registerProject(request, backend, "keyboard");
  await sevenTasks(request, backend, workdir);
  await openBoard(page, backend);
  const handle = card(page, "E three").getByTestId("task-card-handle");
  await handle.focus();
  await page.keyboard.press("ArrowUp");
  await expect.poll(() => shown(page, "ready")).toEqual(["A five", "B five", "C four", "E three", "D three", "F two", "G one"]);
  await expect(page.getByTestId("reorder-announcement")).toContainText("E three moved to position 1 of 2 in Normal");
  // Focus stays on the moved card's handle, and the arrow keys never cross the urgency boundary.
  await expect(card(page, "E three").getByTestId("task-card-handle")).toBeFocused();
  await page.keyboard.press("ArrowUp");
  await expect(page.getByTestId("reorder-announcement")).toContainText("already at the top");
  expect(await shown(page, "ready")).toEqual(["A five", "B five", "C four", "E three", "D three", "F two", "G one"]);
  await page.keyboard.press("End");
  await expect.poll(() => shown(page, "ready")).toEqual(["A five", "B five", "C four", "D three", "E three", "F two", "G one"]);
  const g = card(page, "G one").getByTestId("task-card-handle");
  await g.focus();
  await page.keyboard.press("ArrowUp");
  await expect(page.getByTestId("reorder-announcement")).toContainText("already at the top");
  expect(await shown(page, "ready")).toEqual(["A five", "B five", "C four", "D three", "E three", "F two", "G one"]);
});

test("the board scrolls horizontally in a compact window and the last column is reachable", async ({ page, request, freshBackend: backend }) => {
  const workdir = await registerProject(request, backend, "scroll");
  await addTask(request, backend, workdir, "Only task", 3);
  await page.setViewportSize({ width: 900, height: 640 });
  await openBoard(page, backend);
  const metrics = await page.locator(".kanban-scroll").evaluate((el) => ({ scrollWidth: el.scrollWidth, clientWidth: el.clientWidth }));
  expect(metrics.scrollWidth).toBeGreaterThan(metrics.clientWidth);
  await page.locator(".kanban-scroll").evaluate((el) => { el.scrollLeft = el.scrollWidth; });
  const last = page.getByRole("heading", { level: 2 }).last();
  await expect(last).toBeInViewport();
  await page.screenshot({ path: path.join(SHOTS, "08-compact-scrolled.png") });
  await page.locator(".kanban-scroll").evaluate((el) => { el.scrollLeft = 0; });
  await page.screenshot({ path: path.join(SHOTS, "09-compact.png") });
});

test("a long title in a narrow column keeps the urgency badge and the handle visible", async ({ page, request, freshBackend: backend }) => {
  const workdir = await registerProject(request, backend, "long");
  await addTask(request, backend, workdir, "An extremely long task title that must wrap inside a narrow Kanban column without hiding the urgency indicator or the drag handle ".repeat(2), 5);
  await openBoard(page, backend);
  const first = page.getByTestId("task-card").first();
  await expect(first.getByTestId("task-card-urgency")).toBeVisible();
  await expect(first.getByTestId("task-card-handle")).toBeVisible();
  const box = (await first.boundingBox())!;
  const badge = (await first.getByTestId("task-card-urgency").boundingBox())!;
  expect(badge.x + badge.width).toBeLessThanOrEqual(box.x + box.width + 1);
});

test("the project board scrolls horizontally in a compact window, the page itself does not, and a card can still be dragged after scrolling", async ({ page, request, freshBackend: backend }) => {
  const workdir = await registerProject(request, backend, "compact");
  await addTask(request, backend, workdir, "First normal", 3);
  await addTask(request, backend, workdir, "Second normal", 3);
  await addTask(request, backend, workdir, "Lone minimal", 1);
  await page.setViewportSize({ width: 960, height: 760 });
  await gotoApp(page, backend.bootBase, { newTaskPinned: false });
  await page.locator(`[data-testid="project-nav-item"][data-path="${workdir}"]`).click();
  await clickProjectPage(page, "board");
  await expect(page.getByTestId("task-card").first()).toBeVisible({ timeout: 20_000 });
  const scroller = page.locator(".kanban-scroll");
  const m = await scroller.evaluate((el) => ({ scrollWidth: el.scrollWidth, clientWidth: el.clientWidth, doc: document.documentElement.scrollWidth <= document.documentElement.clientWidth + 1 }));
  expect(m.scrollWidth).toBeGreaterThan(m.clientWidth);
  expect(m.doc).toBe(true);
  // Every column can be reached: the last heading comes into view after scrolling to the far right.
  await scroller.evaluate((el) => { el.scrollLeft = el.scrollWidth; });
  await expect(page.getByRole("heading", { level: 2 }).last()).toBeInViewport();
  await page.screenshot({ path: path.join(SHOTS, "10-project-board-compact-right.png") });
  // Back to the Ready column and reorder with the mouse.
  await card(page, "Second normal").scrollIntoViewIfNeeded();
  await dragHandle(page, "Second normal", () => onCard(page, "First normal", "upper"));
  await expect.poll(() => shown(page, "ready")).toEqual(["Second normal", "First normal", "Lone minimal"]);
  await page.screenshot({ path: path.join(SHOTS, "11-project-board-compact-reordered.png") });
});
