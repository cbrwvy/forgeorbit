import { rmSync } from "node:fs";
import path from "node:path";
import { test, expect } from "./fixtures";
import { gotoApp } from "./helpers";
import { writeDeepSeekFixture } from "./deepseek-fixture";

test("installed DSH is visible with an honest execution blocker in EN/RU; never becomes a resource", async ({ page, freshBackend: backend }) => {
  const app = writeDeepSeekFixture(backend.dataDir);
  const headers = { authorization: `Bearer ${backend.apiToken}` };
  const payload = async () => (await page.request.get(`${backend.apiBase}/harnesses`, { headers })).json();
  const first = await payload();
  expect(first.installations[0]).toMatchObject({ status: "execution-unsupported", version: "0.2.1-rc.5", models: [], executionSupported: false });
  expect(first.installations[0].executionPolicy).toMatchObject({status: "blocked", protocol: "headless-jsonl", blockers: ["filesystem-read-scope", "filesystem-write-scope", "hard-link-alias", "inherited-file-descriptor", "setsid-descendant", "component-boot"]});
  expect(first.providerDiagnostics.find((item: { id: string }) => item.id === "cursor")).toMatchObject({ executable: false, runtimeCompatible: false, realInferenceVerified: false, sandboxCompatibility: "incompatible" });
  expect(first.providerDiagnostics.find((item: { id: string }) => item.id === "deepseek-dsh")).toMatchObject({ executable: false, authentication: "unknown", quota: "unknown" });
  expect(first.harnesses.some((h: { id: string }) => h.id === "deepseek-dsh")).toBe(false);

  await gotoApp(page, backend.bootBase);
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  await page.getByRole("navigation", { name: "Settings sections" }).getByRole("button", { name: "AI providers and accounts", exact: true }).click();
  const cursor = page.getByTestId("provider-diagnostic-cursor");
  await expect(cursor).toContainText("Execution blocked");
  await expect(cursor).toContainText("Incompatible");
  await expect(cursor).toContainText("Keychain");
  await expect(cursor).not.toContainText("Verified ready");
  const card = page.getByTestId("deepseek-installation");
  await expect(card).toContainText("Detected · execution unavailable");
  await expect(card).toContainText("0.2.1-rc.5");
  await expect(card).toContainText("Developer or Reviewer");
  await expect(card.getByTestId("deepseek-policy-blocker")).toContainText("cannot confine file reads to the project");
  await expect(card).toContainText("Authentication: Unknown · Quota: Unknown");
  expect(await card.getByRole("switch").count()).toBe(0);
  await page.keyboard.press("Alt+Shift+l");
  await expect(cursor).toContainText("Исполнение заблокировано");
  await expect(cursor).toContainText("Несовместимо");
  await expect(card).toContainText("Обнаружено · исполнение недоступно");
  await expect(card).toContainText("Авторизация: Неизвестно · Квота: Неизвестно");
  await expect(card.getByTestId("deepseek-policy-blocker")).toContainText("не ограничивает чтение файлов каталогом проекта");
  await page.screenshot({ path: test.info().outputPath("deepseek-ru.png") });
  await page.keyboard.press("Alt+Shift+l");
  await expect(card).toContainText("Detected · execution unavailable");
  // Reload exercises backend rediscovery and UI persistence without creating registry rows.
  await page.reload();
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  await page.getByRole("navigation", { name: "Settings sections" }).getByRole("button", { name: "AI providers and accounts", exact: true }).click();
  await expect(card).toContainText("Detected · execution unavailable");
  expect((await payload()).harnesses).toEqual(first.harnesses);
  const invalid = await page.request.post(`${backend.apiBase}/harnesses`, { headers, data: { id: "deepseek-dsh", kind: "deepseek", label: "DeepSeek" } });
  expect(invalid.status()).toBe(400);
  for (const kind of ["claude-code", "codex", "fx"]) {
    const alias = await page.request.post(`${backend.apiBase}/harnesses`, { headers, data: { id: "deepseek-dsh", kind, label: "DeepSeek" } });
    expect(alias.status()).toBe(400);
    expect(await alias.text()).toContain("cannot alias another harness");
  }
  // Removing the task-owned fixture updates the existing metadata endpoint.
  rmSync(app, { recursive: true });
  expect((await payload()).installations[0].status).toBe("missing");
});
