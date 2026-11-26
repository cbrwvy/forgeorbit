import { test, expect, api, registerProject, projectPage } from "./organization-acceptance-fixture";
import { gotoApp } from "./helpers";

test("native recovery: card open is a separate button from execution actions", async ({ page, companyBackend: b, request }) => {
  const dir = await registerProject(request, b, "Native card regression");
  const task = await api(request, b, "POST", "/tasks", { title: "Open without execution", prompt: "Synthetic", workdir: dir, isolation: "none", column: "ready" });
  await gotoApp(page, b.bootBase);
  await projectPage(page, dir, "board");
  const card = page.getByRole("group", { name: task.title, exact: true });
  const open = card.getByRole("button", { name: task.title, exact: true });
  await expect(open.locator("button")).toHaveCount(0);
  await expect(card.getByRole("button", { name: "Run", exact: true })).toBeVisible();
  for (const key of ["Enter", "Space"]) {
    await open.focus();
    await page.keyboard.press(key);
    await expect(page.getByRole("button", { name: "Close task details" })).toBeVisible();
    await page.getByRole("button", { name: "Close task details" }).click();
  }
  await open.click();
  await expect(page.getByRole("button", { name: "Close task details" })).toBeVisible();
  expect(await api(request, b, "GET", `/tasks/${task.id}/runs`)).toHaveLength(0);
});

test("native recovery: nested modal keeps keyboard focus and returns to opener", async ({ page, companyBackend: b }) => {
  await gotoApp(page, b.bootBase);
  const settings = page.getByRole("button", { name: "Settings", exact: true });
  await settings.focus();
  await page.keyboard.press("Space");
  const dialog = page.getByRole("dialog");
  await dialog.getByRole("button", { name: "Library", exact: true }).click();
  await dialog.getByRole("button", { name: "Add agent", exact: true }).click();
  const name = page.getByTestId("agent-profile-name");
  await expect(name).toBeFocused();
  for (const key of ["Tab", "Tab", "Shift+Tab", "Shift+Tab"]) {
    await page.keyboard.press(key);
    expect(await dialog.evaluate(el => el.contains(document.activeElement))).toBe(true);
  }
  await page.keyboard.press("Escape");
  await expect(name).toHaveCount(0);
  await page.keyboard.press("Escape");
  await expect(dialog).toHaveCount(0);
  await expect(settings).toBeFocused();
});
