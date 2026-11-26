import { test, expect } from "./fixtures";
import { gotoApp, seedHarnessUsage } from "./helpers";
import type { HarnessQuota } from "../src/shared/types.ts";

/**
 * E2E coverage for the redesigned 4-service topbar AI indicators
 * (Codex, Claude, Cursor, Antigravity) and per-service read-only popovers.
 */

const NOW = Date.now();
const HOUR_MS = 60 * 60_000;
const DAY_MS = 24 * HOUR_MS;

function claudeCodeQuota(): HarnessQuota {
  return {
    harnessId: "claude-code",
    kind: "claude-code",
    planType: "max",
    status: "ok",
    source: "cache",
    fetchedAtMs: NOW,
    meters: [
      { id: "five_hour", label: "Session (5h)", usedPercent: 42, resetsAtMs: NOW + 3 * HOUR_MS },
      { id: "seven_day", label: "Weekly", usedPercent: 95, resetsAtMs: NOW + 2 * DAY_MS },
    ],
    reason: null,
  };
}

function codexHealthyQuota(): HarnessQuota {
  return {
    harnessId: "codex",
    kind: "codex",
    planType: "plus",
    status: "ok",
    source: "api",
    fetchedAtMs: NOW,
    meters: [
      { id: "session", label: "Session (5h)", usedPercent: 20, resetsAtMs: NOW + 4 * HOUR_MS },
      { id: "weekly", label: "Weekly", usedPercent: 30, resetsAtMs: NOW + 5 * DAY_MS },
    ],
    reason: null,
  };
}

test("renders only connected service indicators in topbar; clicking one opens only its popover with limits and Escape restores focus", async ({
  page,
  request,
  backend,
}) => {
  for (const [id, enabled] of [
    ["claude-code", true],
    ["codex", true],
    ["cursor", false],
    ["antigravity", false],
    ["gemini", false],
    ["fx", false],
  ] as const) {
    const res = await request.patch(`${backend.apiBase}/harnesses/${id}`, {
      headers: { authorization: `Bearer ${backend.apiToken}` },
      data: { enabled },
    });
    expect(res.ok(), `PATCH /harnesses/${id} -> ${res.status()}`).toBeTruthy();
  }

  seedHarnessUsage(backend, claudeCodeQuota());
  seedHarnessUsage(backend, codexHealthyQuota());
  await gotoApp(page, backend.bootBase);

  const banner = page.getByRole("banner");
  const group = banner.getByTestId("topbar-ai-resources");
  await expect(group).toBeVisible();

  const codexBtn = group.getByTestId("topbar-service-codex");
  const claudeBtn = group.getByTestId("topbar-service-claude");
  const cursorBtn = group.getByTestId("topbar-service-cursor");
  const agyBtn = group.getByTestId("topbar-service-antigravity");

  // Only connected (enabled) services appear in the topbar.
  await expect(codexBtn).toBeVisible();
  await expect(claudeBtn).toBeVisible();
  await expect(cursorBtn).toHaveCount(0);
  await expect(agyBtn).toHaveCount(0);

  // Claude has 95% weekly used (5% left) -> yellow.
  await expect(claudeBtn).toHaveAttribute("data-service-status", "yellow");

  // Click Claude -> opens ONLY Claude's popover.
  await claudeBtn.click();
  const dialog = page.getByTestId("topbar-service-panel");
  await expect(dialog).toBeVisible();
  await expect(dialog).toHaveAttribute("data-service-id", "claude");

  await expect(dialog.getByTestId("topbar-service-title")).toHaveText("Claude");
  await expect(dialog.getByTestId("topbar-service-plan")).toHaveText("max");
  await expect(dialog.getByText("Session (5h)", { exact: true })).toBeVisible();
  await expect(dialog.getByText("58% left", { exact: true })).toBeVisible();
  await expect(dialog.getByText("Weekly", { exact: true })).toBeVisible();
  await expect(dialog.getByText("5% left", { exact: true })).toBeVisible();
  // Does not dump other services into Claude's card.
  await expect(dialog.getByText("Codex", { exact: true })).toHaveCount(0);

  // Passive read-only summary: no Refresh button; links to Accounts instead.
  await expect(dialog.getByRole("button", { name: "Refresh usage" })).toHaveCount(0);
  await expect(dialog.getByTestId("topbar-service-open-accounts")).toBeVisible();

  // Clicking Codex switches directly to Codex's card.
  await codexBtn.click();
  await expect(dialog).toHaveAttribute("data-service-id", "codex");
  await expect(dialog.getByTestId("topbar-service-title")).toHaveText("Codex");

  // Escape closes it and restores focus to the active trigger.
  await page.keyboard.press("Escape");
  await expect(dialog).toBeHidden();
  await expect(codexBtn).toBeFocused();

  // Clicking "Open Accounts & Settings" opens Settings -> Accounts cleanly.
  await claudeBtn.click();
  await expect(dialog).toBeVisible();
  await dialog.getByTestId("topbar-service-open-accounts").click();
  await expect(dialog).toBeHidden();
  await expect(page.getByRole("dialog")).toBeVisible();
});
