import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test, expect, type APIRequestContext, type E2EBackend, type Page } from "./fixtures";
import { gotoApp, putPreference, openAllTasks } from "./helpers";
import { clickProjectPage } from "./project-nav";

/**
 * FO-UX-SIMPLIFY02-M5: the project workspace — four tabs plus More, a simpler header
 * (work status, one lifecycle action, Ask Head of PM, Details) and task cards that lead
 * with title, status and the next action. Fake drivers only; nothing starts an agent.
 */
test.describe.configure({ mode: "serial" });

const auth = (b: E2EBackend) => ({ authorization: `Bearer ${b.apiToken}` });

async function registerProject(request: APIRequestContext, b: E2EBackend, name: string): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), "m5-"));
  const res = await request.post(`${b.apiBase}/projects`, { headers: auth(b), data: { path: dir, name } });
  expect(res.ok(), await res.text()).toBeTruthy();
  return (await res.json()).path as string;
}
async function createTask(request: APIRequestContext, b: E2EBackend, title: string, workdir: string, column: string) {
  const res = await request.post(`${b.apiBase}/tasks`, { headers: auth(b), data: { title, prompt: `${title} — a longer description of the work.`, isolation: "none", workdir, column } });
  expect(res.ok(), await res.text()).toBeTruthy();
  return (await res.json()) as { id: string };
}
async function storeWorkspace(page: Page, value: unknown) {
  await page.addInitScript((stored) => { localStorage.setItem("agetor:workspace", JSON.stringify(stored)); }, value);
}
const openProject = async (page: Page, dir: string) => {
  await page.locator(`[data-testid="project-nav-item"][data-path="${dir}"]`).click();
  await expect(page.getByTestId("project-header-name")).toBeVisible();
};

const PAGES: { id: string; probe: string; more: boolean }[] = [
  { id: "overview", probe: "project-overview", more: false },
  { id: "board", probe: "all-tasks-search-never", more: false },
  { id: "manager", probe: "manager-page", more: false },
  { id: "team", probe: "project-team-page", more: false },
  { id: "estimates", probe: "project-estimates", more: true },
  { id: "environment", probe: "environment-page", more: true },
  { id: "knowledge", probe: "knowledge-page", more: true },
  { id: "brain", probe: "brain-page", more: true },
  { id: "settings", probe: "project-settings-page", more: true },
];

test("every old project page opens from a saved selection and shows its owner tab", async ({ page, request, freshBackend: backend }) => {
  const dir = await registerProject(request, backend, "Saved Orbit");
  await gotoApp(page, backend.bootBase);
  for (const item of PAGES) {
    // Write the old saved value, then cold-start the webview on it.
    await page.evaluate((stored) => localStorage.setItem("agetor:workspace", JSON.stringify(stored)), { scope: "project", path: dir, page: item.id });
    await page.reload();
    await expect(page.getByTestId(item.id === "board" ? "project-header" : item.probe).first()).toBeVisible();
    if (item.id === "board") await expect(page.getByTestId("project-breadcrumb-page")).toHaveText("Tasks");
    if (item.more) {
      // A page under More makes More the selected tab and names the page.
      await expect(page.getByTestId("project-more")).toHaveAttribute("data-current", "true");
      await expect(page.getByTestId("project-more-current")).toBeVisible();
    } else {
      await expect(page.getByTestId(`project-page-${item.id}`)).toHaveAttribute("aria-pressed", "true");
      await expect(page.getByTestId("project-more")).not.toHaveAttribute("data-current", "true");
    }
  }
});

test("every moved tab and control is reachable, and navigation alone writes nothing", async ({ page, request, freshBackend: backend }) => {
  const dir = await registerProject(request, backend, "Reach Orbit");
  await createTask(request, backend, "Reach task", dir, "backlog");
  const writes: string[] = [];
  page.on("request", (req) => {
    if (req.method() !== "GET" && req.url().startsWith(backend.apiBase)) writes.push(`${req.method()} ${new URL(req.url()).pathname}`);
  });
  await gotoApp(page, backend.bootBase);
  await openProject(page, dir);
  writes.length = 0;
  for (const item of PAGES) {
    await clickProjectPage(page, item.id);
    await expect(page.getByTestId(item.id === "board" ? "project-header" : item.probe).first()).toBeVisible();
    await expect(page.getByTestId("project-breadcrumb-page")).toBeVisible();
  }
  // Plan and Execution keeps inbox, plan, runs and history.
  await clickProjectPage(page, "manager");
  for (const tab of ["inbox", "plan", "autonomy", "chat"]) {
    await page.getByTestId(`manager-tab-${tab}`).click();
    await expect(page.getByTestId(`manager-tab-${tab}`)).toHaveAttribute("aria-selected", "true");
  }
  await expect(page.getByTestId("manager-where-hint")).toBeVisible();
  // Project-level actions that exist on the old header are still in the page: Details holds the path.
  await page.getByTestId("project-header-details-toggle").click();
  await expect(page.getByTestId("project-header-path")).toBeVisible();
  await expect(page.getByTestId("project-header-copy-path")).toBeVisible();
  // Only the harmless view-state writes may happen (none of them approve, save a policy or start work).
  const forbidden = writes.filter((w) => /approve|start|authorize|policies|execute|emergency|stop|assign/i.test(w));
  expect(forbidden, writes.join("\n")).toEqual([]);
});

test("Ask Head of PM opens with this project selected; other projects keep their own scope", async ({ page, request, freshBackend: backend }) => {
  const a = await registerProject(request, backend, "Alpha Head");
  const b = await registerProject(request, backend, "Beta Head");
  await gotoApp(page, backend.bootBase);
  await openProject(page, a);
  await page.getByTestId("project-open-head-pm").click();
  await expect(page.getByTestId("head-pm-scope")).toHaveValue(`project:${a}`);
  await openProject(page, b);
  await page.getByTestId("project-open-head-pm").click();
  await expect(page.getByTestId("head-pm-scope")).toHaveValue(`project:${b}`);
});

test("lifecycle: one action from the real state, scope note in Details, same request as before", async ({ page, request, freshBackend: backend }) => {
  const dir = await registerProject(request, backend, "Life Orbit");
  await gotoApp(page, backend.bootBase);
  await openProject(page, dir);
  const state = page.getByTestId("project-lifecycle-state");
  await expect(state).toHaveAttribute("data-state", "running");
  await expect(state).toContainText("Open for work");
  await expect(page.getByTestId("project-lifecycle-start")).toHaveCount(0);
  const stop = page.getByTestId("project-lifecycle-stop");
  await expect(stop).toBeEnabled();
  // No-confirm navigation never touched it; the click sends exactly one lifecycle request.
  const sent: string[] = [];
  page.on("request", (req) => { if (req.method() !== "GET" && req.url().startsWith(backend.apiBase)) sent.push(new URL(req.url()).pathname); });
  await stop.click();
  await expect(page.getByTestId("project-lifecycle-confirmation")).toBeVisible();
  expect(sent.filter((p) => /lifecycle|stop|start/i.test(p)).length).toBe(1);
  const after = await state.getAttribute("data-state");
  expect(["paused", "draining"]).toContain(after);
  if (after === "paused") {
    await expect(state).toContainText("Paused");
    await expect(page.getByTestId("project-lifecycle-start")).toBeEnabled();
  } else {
    await expect(state).not.toContainText("Paused");
    await expect(page.getByTestId("project-lifecycle-stop")).toBeDisabled();
  }
  await page.getByTestId("project-header-details-toggle").click();
  await expect(page.getByTestId("project-actions-scope")).toContainText("Emergency Stop");
  // Emergency Stop itself is untouched and still in the title bar.
  await expect(page.getByTestId("emergency-stop-button")).toBeVisible();
});

test("More menu: keyboard open, arrow keys, Escape returns focus, Enter selects", async ({ page, request, freshBackend: backend }) => {
  const dir = await registerProject(request, backend, "Keys Orbit");
  await gotoApp(page, backend.bootBase);
  await openProject(page, dir);
  const more = page.getByTestId("project-more");
  await more.focus();
  await page.keyboard.press("Enter");
  const menu = page.getByTestId("project-more-menu");
  await expect(menu).toBeVisible();
  await expect(page.getByTestId("project-page-estimates")).toBeFocused();
  await page.keyboard.press("ArrowDown");
  await expect(page.getByTestId("project-page-environment")).toBeFocused();
  await page.keyboard.press("End");
  await expect(page.getByTestId("project-page-settings")).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(menu).toHaveCount(0);
  await expect(more).toBeFocused();
  await page.keyboard.press("ArrowDown");
  await expect(menu).toBeVisible();
  await page.keyboard.press("ArrowDown");
  await page.keyboard.press("Enter");
  await expect(page.getByTestId("environment-page")).toBeVisible();
  await expect(more).toHaveAttribute("data-current", "true");
  await more.click();
  await expect(page.getByTestId("project-page-environment")).toHaveAttribute("aria-current", "page");
  await page.keyboard.press("Escape");
});

test("task cards lead with title, status and the next action — project board and global board", async ({ page, request, freshBackend: backend }) => {
  const dir = await registerProject(request, backend, "Card Orbit");
  const ids: Record<string, string> = {};
  for (const [name, column] of [["Backlog item", "backlog"], ["Review item", "review"], ["Blocked item", "blocked"]] as const) {
    ids[name] = (await createTask(request, backend, name, dir, column)).id;
  }
  await gotoApp(page, backend.bootBase);
  await openProject(page, dir);
  await clickProjectPage(page, "board");
  const card = (title: string) => page.getByRole("group", { name: title });
  const check = async () => {
    const backlog = card("Backlog item");
    await expect(backlog.getByTestId("task-card-status")).toHaveText("Backlog");
    await expect(backlog.getByTestId("task-estimate")).toBeVisible();
    const review = card("Review item");
    await expect(review.getByTestId("task-card-status")).toHaveText("Review");
    await expect(review.getByTestId("task-mark-done")).toBeVisible();
    const blocked = card("Blocked item");
    await expect(blocked.getByTestId("task-card-status")).toContainText("Waiting for you");
    await expect(blocked.getByRole("button", { name: /Review|Answer/ })).toBeVisible();
    // The full path is no longer printed on the card; it is a tooltip on the short folder name.
    await expect(backlog.getByTestId("task-card-folder")).toHaveAttribute("title", new RegExp(dir.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
    expect(await backlog.getByText(dir, { exact: true }).count()).toBe(0);
    // Title comes before status, status before the actions.
    const order = await backlog.evaluate((el) => {
      const top = (sel: string) => el.querySelector(sel)!.getBoundingClientRect().top;
      return [top("[aria-label='Backlog item'] , button[aria-label='Backlog item']"), top("[data-testid=task-card-status]"), top("[data-testid=task-estimate]")];
    });
    expect(order[0]!).toBeLessThanOrEqual(order[1]!);
    expect(order[1]!).toBeLessThan(order[2]!);
  };
  await check();
  await openAllTasks(page);
  await expect(page.getByTestId("all-tasks-bar")).toBeVisible();
  await check();
});

for (const locale of ["en", "ru"] as const) {
  for (const theme of ["light", "dark"] as const) {
    test(`layout ${locale}/${theme}: header, tabs and More menu fit at 1024 and 800 px; dock covers nothing needed`, async ({ page, request, freshBackend: backend }, info) => {
      await putPreference(request, backend, "locale", locale);
      await putPreference(request, backend, "theme", theme);
      const dir = await registerProject(request, backend, "Layout Orbit с очень длинным названием проекта для проверки обрезки");
      await createTask(request, backend, "Layout task", dir, "backlog");
      await gotoApp(page, backend.bootBase);
      for (const width of [1024, 800]) {
        await page.setViewportSize({ width, height: 760 });
        await openProject(page, dir);
        for (const target of ["overview", "board", "team", "settings"]) {
          await clickProjectPage(page, target);
          await expect(page.getByTestId("project-tabs")).toBeVisible();
          const fits = await page.evaluate(() => {
            const vw = innerWidth;
            const out: string[] = [];
            for (const id of ["project-header", "project-header-actions", "project-tabs", "project-header-name"]) {
              const r = document.querySelector<HTMLElement>(`[data-testid=${id}]`)?.getBoundingClientRect();
              if (!r) { out.push(`${id}: missing`); continue; }
              if (r.left < -1 || r.right > vw + 1) out.push(`${id}: ${Math.round(r.left)}..${Math.round(r.right)} of ${vw}`);
            }
            if (document.documentElement.scrollWidth > vw + 1) out.push("horizontal page scroll");
            const tabs = document.querySelector<HTMLElement>("[data-testid=project-tabs]")!;
            if (tabs.scrollWidth > tabs.clientWidth + 1) out.push("tab strip scrolls");
            for (const btn of Array.from(tabs.querySelectorAll<HTMLElement>("button"))) {
              const r = btn.getBoundingClientRect();
              if (r.right > vw + 1 || r.left < -1) out.push(`tab ${btn.dataset.testid} outside window`);
            }
            return out;
          });
          expect(fits, `${locale}/${theme}/${width}/${target}`).toEqual([]);
        }
        // The More menu opens fully inside the window and every item is visible.
        await page.getByTestId("project-more").click();
        const menu = page.getByTestId("project-more-menu");
        await expect(menu).toBeVisible();
        const box = (await menu.boundingBox())!;
        expect(box.x).toBeGreaterThanOrEqual(0);
        expect(box.x + box.width).toBeLessThanOrEqual(width + 1);
        expect(box.y + box.height).toBeLessThanOrEqual(760 + 1);
        await expect(menu.getByRole("menuitem")).toHaveCount(5);
        await page.screenshot({ path: info.outputPath(`more-${locale}-${theme}-${width}.png`) });
        await page.keyboard.press("Escape");
        // The Head of PM dock must not sit on the header actions or the tab strip.
        const overlap = await page.evaluate(() => {
          const dock = document.querySelector<HTMLElement>("[data-testid=shell-dock]")?.getBoundingClientRect();
          if (!dock) return [];
          const hit: string[] = [];
          for (const id of ["project-header-actions", "project-tabs"]) {
            const r = document.querySelector<HTMLElement>(`[data-testid=${id}]`)!.getBoundingClientRect();
            if (r.left < dock.right && r.right > dock.left && r.top < dock.bottom && r.bottom > dock.top) hit.push(id);
          }
          return hit;
        });
        expect(overlap).toEqual([]);
        await clickProjectPage(page, "board");
        await expect(page.getByTestId("task-card-status").first()).toBeVisible();
        await page.screenshot({ path: info.outputPath(`board-${locale}-${theme}-${width}.png`) });
      }
    });
  }
}
