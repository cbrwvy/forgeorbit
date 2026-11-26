import { test, expect, type Page, type E2EBackend } from "./fixtures";
import { gotoApp } from "./helpers";
import type { CodexSourceState } from "../src/shared/accounts/codex-source";

async function open(page: Page, backend: E2EBackend) {
  await gotoApp(page, backend.bootBase);
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  await page.getByRole("navigation", { name: "Settings sections" }).getByRole("button", { name: "AI providers and accounts", exact: true }).click();
  await page.getByTestId("accounts-dashboard").getByRole("button", { name: "Quota Sources", exact: true }).click();
  await expect(page.getByTestId("codex-connector")).toBeVisible();
}
const state = (extra: Partial<CodexSourceState> = {}): CodexSourceState => ({ sourceId: "codex-app-server", status: "disconnected", authentication: "unknown",
  requiresOpenaiAuth: null, observedAt: null, expiresAt: null, linkedAccountId: null, binding: "unverified", refreshAvailable: false,
  reason: "No documented stable subject. Binding and Refresh blocked.", ...extra });
const auth = (page: Page) => page.getByTestId("codex-connector").getByRole("button", { name: "Verify Authentication", exact: true });
const consent = (page: Page) => page.getByTestId("codex-connector").getByRole("checkbox");

test("real backend status is read-only and cannot manufacture binding or refresh", async ({ page, request, freshBackend: b }) => {
  let postCount = 0;
  page.on("request", req => { if (req.url().includes("codex-source") && req.method() === "POST") postCount++; });
  await open(page, b);
  const connector = page.getByTestId("codex-connector");
  await expect(connector).toContainText("Disconnected. Checking authentication requires");
  await expect(auth(page)).toBeDisabled();
  await expect(connector.getByRole("button", { name: "Confirm Link — Unavailable" })).toBeDisabled();
  await expect(page.getByTestId("quota-source-codex-app-server").getByRole("button", { name: "Refresh Codex app-server rate limits", exact: true })).toBeDisabled();
  await consent(page).check(); await expect(auth(page)).toBeEnabled();
  await consent(page).uncheck();
  expect(postCount).toBe(0);
  const response = await request.get(`${b.apiBase}/account-core/codex-source`, { headers: { authorization: `Bearer ${b.apiToken}` } });
  expect(response.headers()["cache-control"]).toBe("no-store");
  expect(await response.json()).toMatchObject({ linkedAccountId: null, observedAt: null, refreshAvailable: false });
  const forbidden = await request.post(`${b.apiBase}/account-core/codex-source/inspect?token=${b.apiToken}`, { data: { consent: true } });
  expect(forbidden.status()).toBe(401);
});

test("fake auth inspection requires new consent, remains Unassigned, expires locally and disconnects", async ({ page, freshBackend: b }) => {
  const methods: string[] = [];
  const now = Date.now();
  await page.route("**/account-core/codex-source**", async route => {
    const method = route.request().method(); methods.push(method);
    if (method === "POST") expect(route.request().postDataJSON()).toEqual({ consent: true });
    await route.fulfill({ json: method === "POST" ? state({ status: "unassigned", authentication: "chatgpt", observedAt: now, expiresAt: now + 60_000 }) : state() });
  });
  await open(page, b);
  await page.clock.install({ time: now });
  await consent(page).check(); await auth(page).click();
  const connector = page.getByTestId("codex-connector");
  await expect(connector).toContainText("chatgpt");
  await expect(connector).toContainText("Unassigned / Unverified");
  await expect(auth(page)).toBeDisabled();
  await page.clock.fastForward(60_001);
  await expect(connector).toContainText("stale");
  expect(methods.filter(m => m === "POST")).toHaveLength(1);
  await connector.getByRole("button", { name: "Disconnect / Cancel Check" }).click();
  await expect(connector).toContainText("disconnected");
  expect(methods.filter(m => m === "DELETE")).toHaveLength(1);
  for (const width of [390, 1280]) {
    await page.setViewportSize({ width, height: 900 });
    await expect(connector).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    await page.screenshot({ path: test.info().outputPath(`codex-source-${width}.png`), fullPage: true });
  }
});

test("fake timeout and cancellation never display successful authentication", async ({ page, freshBackend: b }) => {
  let mode = "timeout";
  let pending: (() => Promise<void>) | undefined;
  await page.route("**/account-core/codex-source**", async route => {
    if (route.request().method() === "POST") {
      if (mode === "timeout") await route.fulfill({ status: 504, json: { error: "Codex inspection timed out." } });
      else pending = async () => { await route.fulfill({ json: state({ status: "unassigned", authentication: "chatgpt" }) }).catch(() => {}); };
    } else await route.fulfill({ json: state() });
  });
  await open(page, b);
  await consent(page).check(); await auth(page).click();
  await expect(page.getByTestId("codex-connector").getByRole("alert")).toContainText("timed out");
  mode = "pending"; await consent(page).check(); await auth(page).click();
  await expect(auth(page)).toBeDisabled();
  await page.getByTestId("codex-connector").getByRole("button", { name: "Disconnect / Cancel Check" }).click();
  await expect(page.getByTestId("codex-connector")).toContainText("disconnected");
  await pending?.();
  await expect(page.getByTestId("codex-connector")).not.toContainText("chatgpt");
});
