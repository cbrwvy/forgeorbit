import { Database } from "bun:sqlite";
import path from "node:path";
import { expect, type APIRequestContext, type Locator, type Page } from "@playwright/test";
import type { E2EBackend } from "./fixtures";
import type { HarnessQuota } from "../src/shared/types.ts";

/**
 * Helpers shared across e2e/*.spec.ts. Parametrized by the worker's
 * `E2EBackend` (e2e/fixtures.ts) rather than the old static
 * E2E_API_PORT/E2E_API_TOKEN module constants — each worker now owns its own
 * backend, so there is no single fixed port/token pair to close over.
 */

export interface GotoAppOptions {
  /**
   * Defaults to `true`: before navigating, seeds `onboardingDismissed="true"`
   * directly against the backend this `url` points at, so the
   * "Getting started" block on Home (FO-UX-SIMPLIFY02-M7) never appears for a spec that isn't testing it. Every
   * fresh per-worker backend (e2e/fixtures.ts's `backend`) starts with that
   * preference absent — which is exactly the "show onboarding" state — so
   * without this default, theme/font-size/quote specs would get a welcome
   * dialog overlay blocking their first click. Only e2e/onboarding.spec.ts
   * needs the real first-run state, via `{ seedOnboardingDismissed: false }`.
   */
  seedOnboardingDismissed?: boolean;
  /**
   * Defaults to `true`: pins the New task panel (`agetor:newTaskPinned=1`,
   * src/mainview/lib/new-task-presentation.ts). Since FO-UX02-D stage 1 the
   * shipped default is a sheet opened by ⌘N, but most specs drive the form
   * that used to be always open, so they run against the still-supported
   * pinned mode. Specs about the sheet pass `{ newTaskPinned: false }`.
   */
  newTaskPinned?: boolean;
}

/** Preference key onboarding's visibility logic reads
 *  (`ONBOARDING_DISMISSED_PREF` in src/mainview/lib/getting-started.ts) — kept as
 *  a literal here rather than imported so this file has no dependency on
 *  mainview source. */
const ONBOARDING_DISMISSED_KEY = "onboardingDismissed";

/** Pulls `apiBase`/`token` out of a boot URL's `#api=<port>&token=<token>`
 *  hash. Used so `gotoApp` can seed a preference through `page.request`
 *  (available on `Page` without a separate `request` fixture) without
 *  widening its signature to take a full `E2EBackend` object — every
 *  existing caller already builds a plain url string (some, like font-
 *  size.spec.ts, append extra hash params of their own), so keeping `url`
 *  as the second parameter means zero edits to those call sites. */
function backendFromBootUrl(url: string): { apiBase: string; token: string } | null {
  const hashIndex = url.indexOf("#");
  if (hashIndex === -1) return null;
  const params = new URLSearchParams(url.slice(hashIndex + 1));
  const port = params.get("api");
  const token = params.get("token");
  if (!port || !token) return null;
  return { apiBase: `http://127.0.0.1:${port}`, token };
}

/** Navigates to a boot URL and waits for real rendered content — the
 *  Settings button in the app bar — rather than a fixed sleep. Callers
 *  assemble the URL themselves (`backend.bootBase` plus any spec-specific
 *  hash params, e.g. font-size.spec's `&fontSize=`). See `GotoAppOptions`
 *  for the default onboarding-dismissal seeding. */
export async function gotoApp(page: Page, url: string, options: GotoAppOptions = {}): Promise<void> {
  const { seedOnboardingDismissed = true, newTaskPinned = true } = options;
  if (newTaskPinned) {
    await page.addInitScript(() => {
      try { localStorage.setItem("agetor:newTaskPinned", "1"); } catch { /* storage unavailable */ }
    });
  }
  if (seedOnboardingDismissed) {
    const backend = backendFromBootUrl(url);
    if (backend) {
      const res = await page.request.put(`${backend.apiBase}/preferences/${ONBOARDING_DISMISSED_KEY}`, {
        headers: { authorization: `Bearer ${backend.token}` },
        data: { value: "true" },
      });
      if (!res.ok()) {
        throw new Error(
          `gotoApp: failed to seed ${ONBOARDING_DISMISSED_KEY} (${res.status()} ${await res.text()})`,
        );
      }
    }
  }
  await page.goto(url);
  // The Settings control carries a stable test id. Waiting on its English
  // accessible name made every RU-locale caller (e.g. the M1 Russian spec)
  // race the preference being applied: once the UI rendered "Настройки" the
  // helper could never see "Settings".
  //
  // 20 s, not Playwright's 5 s default: the shared Vite server compiles the
  // module graph on the first page request, and on a loaded machine that
  // alone can outlast 5 s — the window is blank, not failed. This only
  // widens the wait for real rendered content; it adds no sleep or retry.
  await expect(page.getByTestId("open-settings")).toBeVisible({ timeout: 20_000 });
}

/** Home → All tasks. The global board left the rail; Home still opens it. */
export async function openAllTasks(page: Page): Promise<void> {
  const bar = page.getByTestId("all-tasks-bar");
  if (await bar.isVisible().catch(() => false)) return;
  const opener = page.getByTestId("global-open-board");
  if (!(await opener.isVisible().catch(() => false))) {
    await page.getByTestId("workspace-overview").click();
    await expect(page.getByTestId("global-open-board")).toBeVisible();
  }
  await page.getByTestId("global-open-board").click();
  await expect(bar).toBeVisible();
}

/** Workspaces rail: the spaces list. */
export async function openWorkspaces(page: Page): Promise<void> {
  await page.getByTestId("workspace-workspaces").click();
  await expect(page.getByTestId("clusters-page")).toBeVisible();
}

/** Portfolio, from the Workspaces more menu. */
export async function openPortfolio(page: Page): Promise<void> {
  if (await page.getByTestId("portfolio-dashboard").isVisible().catch(() => false)) return;
  if (!(await page.getByTestId("clusters-more").isVisible().catch(() => false))) await openWorkspaces(page);
  await page.getByTestId("clusters-more").click();
  await page.getByTestId("clusters-more-menu-portfolio").click();
  await expect(page.getByTestId("portfolio-dashboard")).toBeVisible();
}

/** Settings → Execution plans. Opening the page does not start work. */
export async function openExecutionPlans(page: Page): Promise<void> {
  if (!(await page.getByTestId("settings-nav-plans").isVisible().catch(() => false))) {
    await page.getByTestId("open-settings").click();
  }
  await page.getByTestId("settings-nav-plans").click();
  await expect(page.getByTestId("mission-control-page")).toBeVisible();
}

/**
 * A registered project's Analytics tab, with the existing filters and views open.
 * Analytics is no longer a rail item; the figures stay limited to this project.
 */
export async function openProjectAnalytics(page: Page, projectPath: string): Promise<void> {
  await page.locator(`[data-testid="project-nav-item"][data-path="${projectPath}"]`).click();
  await page.getByTestId("project-page-analytics").click();
  await expect(page.getByTestId("project-analytics")).toBeVisible();
  const details = page.getByTestId("project-analytics-details");
  if ((await details.getAttribute("open")) === null) await details.locator("summary").first().click();
  await expect(page.getByTestId("usage-page")).toBeVisible();
}

/** Explicit board entry for specs whose subject is a card or column.
 * FO-001 deliberately boots into Overview; do not change the app default
 * (or gotoApp) just to satisfy older board tests. */
export async function gotoBoard(page: Page, url: string): Promise<void> {
  await gotoApp(page, url);
  await openAllTasks(page);
}

/** Opens Settings → General (the default section on open — no tab click
 *  needed) and waits for the dialog to render. */
export async function openSettingsGeneral(page: Page): Promise<Locator> {
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  const dialog = page.getByRole("dialog");
  await expect(dialog.getByRole("heading", { name: "Settings" })).toBeVisible();
  return dialog;
}

/** Arrange-only helper: seeds a persisted preference directly through the
 *  API so a test starts from a known state, without that setup step itself
 *  being the thing under test. */
export async function putPreference(
  request: APIRequestContext,
  backend: E2EBackend,
  key: string,
  value: string,
): Promise<void> {
  const res = await request.put(`${backend.apiBase}/preferences/${key}`, {
    headers: { authorization: `Bearer ${backend.apiToken}` },
    data: { value },
  });
  expect(res.ok()).toBeTruthy();
}

/** Reads back the full persisted-preferences object. */
export async function getPreferences(
  request: APIRequestContext,
  backend: E2EBackend,
): Promise<Record<string, string>> {
  const res = await request.get(`${backend.apiBase}/preferences`, {
    headers: { authorization: `Bearer ${backend.apiToken}` },
  });
  return (await res.json()) as Record<string, string>;
}

/**
 * Arrange-only helper for the per-harness usage tracker (docs/plans/harness-
 * usage-tracker.md): seeds a `harness_usage` snapshot directly into the
 * worker's isolated SQLite DB, bypassing the poller entirely.
 *
 * There is no ingestion route that works offline — `POST
 * /harnesses/:id/usage/refresh` hits the real provider (Anthropic/OpenAI/
 * Cursor) over the network — so a deterministic e2e test can't seed a known
 * meter through the HTTP API the way `putPreference` does. The app instead
 * boot-seeds the topbar tracker via `GET /usage`, which reads straight from
 * the `harness_usage` table (`src/bun/server.ts`'s `/usage` route, `db.ts`'s
 * `harnessUsage.getAll()`) with no other side effects — so writing the same
 * row this helper's backend counterpart (`harnessUsage.upsert`, `src/bun/db
 * .ts`) would write, directly via `bun:sqlite`, reproduces exactly what a
 * real poll would have persisted. Must run BEFORE `gotoApp` — App.tsx reads
 * `GET /usage` once, at mount.
 *
 * Opens and closes its own `Database` handle per call rather than caching
 * one on the backend fixture: this runs a handful of times per spec, well
 * off any hot path, and a short-lived handle can't outlive (and so can't
 * conflict with) the backend process's own WAL-mode connection to the same
 * file.
 */
export function seedHarnessUsage(backend: E2EBackend, quota: HarnessQuota): void {
  const db = new Database(path.join(backend.dataDir, "agetor.sqlite"));
  try {
    // The headless backend holds this file too. A write that arrives during
    // its transaction used to throw SQLITE_BUSY immediately; wait it out.
    db.exec("PRAGMA busy_timeout = 5000");
    db.run(
      `INSERT INTO harness_usage (harness_id, snapshot_json, updated_at)
       VALUES (?, ?, ?)
       ON CONFLICT(harness_id) DO UPDATE SET snapshot_json = excluded.snapshot_json, updated_at = excluded.updated_at`,
      [quota.harnessId, JSON.stringify(quota), Date.now()],
    );
  } finally {
    db.close();
  }
}

/** Opens a short-lived handle on the backend's SQLite file for an
 *  arrange-only write — same reasoning (and busy_timeout) as
 *  `seedHarnessUsage` above. */
function withBackendDb<T>(backend: E2EBackend, fn: (db: Database) => T): T {
  const db = new Database(path.join(backend.dataDir, "agetor.sqlite"));
  try {
    db.exec("PRAGMA busy_timeout = 5000");
    return fn(db);
  } finally {
    db.close();
  }
}

/**
 * Arrange-only helper for the archived-history retention e2e
 * (docs/plans/non-blocking-session-restore.md, TT8): appends a `tool_use` row
 * and its paired `tool_result` row — `bytes` of text in the result's
 * `content`, so the persisted payload is a little over `bytes` — to `runId`'s
 * event stream, straight through `bun:sqlite`. No HTTP route can plant a
 * bulky `tool_result` (the fake drivers emit tiny ones), and the retention
 * pass only trims rows above `RETENTION_TRIM_BYTES` (4 KB), so the test needs
 * a deterministic oversized row. The two rows share `toolUseId`, so RunPanel
 * pairs them into one collapsed tool card exactly as it does for a real
 * transcript. Returns the ids so a spec can read the row back.
 */
export function seedArchivedToolResult(
  backend: E2EBackend,
  opts: { taskId: string; runId: string; bytes: number },
): { toolUseId: string; toolResultEventId: number } {
  const toolUseId = `toolu_retention_${opts.taskId.slice(0, 8)}`;
  const content = "retention-payload-".repeat(Math.ceil(opts.bytes / 18)).slice(0, opts.bytes);
  const toolUse = JSON.stringify({
    id: toolUseId,
    name: "Bash",
    input: { command: "cat big-output.txt", description: "print a large file" },
  });
  const toolResult = JSON.stringify({ toolUseId, content, isError: false });
  return withBackendDb(backend, (db) => {
    const now = Date.now();
    db.run("INSERT INTO run_events (run_id, stream, data, ts) VALUES (?, 'tool_use', ?, ?)", [
      opts.runId,
      toolUse,
      now,
    ]);
    const res = db.run("INSERT INTO run_events (run_id, stream, data, ts) VALUES (?, 'tool_result', ?, ?)", [
      opts.runId,
      toolResult,
      now + 1,
    ]);
    return { toolUseId, toolResultEventId: Number(res.lastInsertRowid) };
  });
}

/** Arrange-only helper: rewrites a task's `archived_at` to `msAgo`
 *  milliseconds in the past, so the retention pass sees it as archived for
 *  that long without the spec waiting out a real 30 days. */
export function backdateArchivedAt(backend: E2EBackend, taskId: string, msAgo: number): void {
  withBackendDb(backend, (db) => {
    const res = db.run("UPDATE tasks SET archived_at = ? WHERE id = ? AND archived_at IS NOT NULL", [
      Date.now() - msAgo,
      taskId,
    ]);
    if (res.changes !== 1) throw new Error(`backdateArchivedAt: task ${taskId} is not archived (changes=${res.changes})`);
  });
}

/** Arrange/assert helper: reads a single scalar via the backend's SQLite
 *  file (read-only use — counts for the restore spec). */
export function queryBackendScalar(backend: E2EBackend, sql: string, params: (string | number)[] = []): number {
  return withBackendDb(backend, (db) => {
    const row = db.query<{ n: number }, (string | number)[]>(sql).get(...params);
    return row?.n ?? 0;
  });
}

/**
 * Waits for a task's terminal pane to be live: `TerminalView`'s pane carries
 * `data-ready="true"` once the PTY has delivered its first output frame over
 * the WebSocket (xterm's canvas renders before anything arrives, so its mere
 * visibility proves nothing). `scope` is the run panel (or any container
 * holding the Terminal section). The default 20 s ceiling matches
 * `terminals.test.ts`'s `SHELL_READY_MS` — a cold login shell on a loaded box.
 */
export async function waitForTerminalReady(scope: Locator, timeoutMs = 20_000): Promise<Locator> {
  const pane = scope.locator('[data-testid="terminal-pane"][data-ready="true"]').first();
  await expect(pane).toBeAttached({ timeout: timeoutMs });
  return pane;
}
