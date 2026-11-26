import type { Locator } from "@playwright/test";
import { mkdir, rm, symlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { test, expect, api, registerProject, projectPage } from "./organization-acceptance-fixture";
import { gotoApp } from "./helpers";

async function query(prompt: Locator, value: string) {
  await prompt.fill(value);
  await prompt.dispatchEvent("keyup");
}

test.beforeEach(async ({ page }) => {
  await page.route("**/*", route => /^https?:\/\/(localhost|127\.0\.0\.1)(:|\/)/.test(route.request().url()) ? route.continue() : route.abort());
});

test("FO-FILES01 real non-Git PromptComposer preserves EN/RU drafts and supports keyboard/mouse/empty states", async ({ page, request, companyBackend: b }, info) => {
  const dir = await registerProject(request, b, "Plain project");
  const other = await registerProject(request, b, "Other project");
  await mkdir(path.join(dir, "src")); await mkdir(path.join(dir, "docs"));
  await writeFile(path.join(dir, "README.md"), "# synthetic");
  await writeFile(path.join(dir, "src/widget.ts"), "not read");
  await writeFile(path.join(dir, "docs/заметки.md"), "not read");
  await writeFile(path.join(dir, ".env"), "synthetic secret");
  await writeFile(path.join(dir, ".gitignore"), "ignored.txt\n");
  await writeFile(path.join(dir, "ignored.txt"), "ignored");
  await writeFile(path.join(other, "cross-project-only.txt"), "outside");
  await symlink(other, path.join(dir, "escape"));
  const listing = await api(request, b, "GET", `/files/index?dir=${encodeURIComponent(dir)}`);
  expect(listing).toEqual({ files: ["README.md", "docs/заметки.md", "src/widget.ts"], truncated: false });
  const observed: { status: number; url: string; body: unknown }[] = [];
  page.on("response", async response => {
    if (new URL(response.url()).pathname === "/files/index") observed.push({ status: response.status(), url: response.url(), body: await response.json() });
  });
  await gotoApp(page, b.bootBase); await projectPage(page, dir, "board");
  await page.getByTestId("isolate-toggle").uncheck();
  const prompt = page.getByTestId("prompt-textarea");
  const title = page.getByPlaceholder(/^(Short description|Краткое описание)$/);
  await title.fill("Draft title · черновик");
  const row = (rel: string) => page.locator(`[data-testid="at-file-autocomplete-row"][data-path="${rel}"]`);
  for (const locale of ["en", "ru"]) {
    if (await page.locator("html").getAttribute("lang") !== locale) await page.keyboard.press("Alt+Shift+L");
    await expect(page.locator("html")).toHaveAttribute("lang", locale);
    await query(prompt, "Existing draft · текст @");
    await expect(row("README.md")).toBeVisible();
    await expect(page.getByRole("listbox", { name: locale === "en" ? "Project file suggestions" : "Подсказки файлов проекта" })).toBeVisible();
    await query(prompt, "Existing draft · текст @wid");
    await expect(row("src/widget.ts")).toBeVisible();
    await page.keyboard.press("Enter");
    await expect(prompt).toHaveValue("Existing draft · текст @src/widget.ts ");
    await expect(page.getByTestId("at-file-autocomplete")).toBeHidden();
    await query(prompt, "Existing draft · текст @зам");
    await expect(row("docs/заметки.md")).toBeVisible();
    await row("docs/заметки.md").getByRole("option").click();
    await expect(prompt).toHaveValue("Existing draft · текст @docs/заметки.md ");
    await expect(prompt).toBeFocused();
    await query(prompt, "Existing draft · текст @READ");
    await expect(row("README.md")).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(page.getByTestId("at-file-autocomplete")).toBeHidden();
    await expect(prompt).toHaveValue("Existing draft · текст @READ");
    await page.keyboard.press("Alt+Shift+L");
    await expect(prompt).toHaveValue("Existing draft · текст @READ");
    await expect(title).toHaveValue("Draft title · черновик");
    await page.keyboard.press("Alt+Shift+L");
    await query(prompt, "Existing draft · текст @no-such-file");
    await expect(page.getByTestId("at-file-empty")).toHaveText(locale === "en" ? "No matching project files." : "Подходящих файлов проекта нет.");
    await page.screenshot({ path: info.outputPath(`${locale}-empty.png`) });
    await page.keyboard.press("Escape"); await expect(prompt).toBeFocused();
    await expect(prompt).toHaveValue("Existing draft · текст @no-such-file");
    await query(prompt, "Existing draft · текст @wid"); await expect(row("src/widget.ts")).toBeVisible();
    await page.screenshot({ path: info.outputPath(`${locale}-suggestions.png`) });
  }
  expect(observed.some(r => r.status === 200 && (r.body as { files: string[] }).files.includes("src/widget.ts"))).toBe(true);
  await info.attach("real-file-index-responses", { body: JSON.stringify(observed, null, 2), contentType: "application/json" });
  expect(await api(request, b, "GET", "/tasks")).toEqual([]);
});

test("FO-FILES01 missing registered root shows real translated backend error and retains draft", async ({ page, request, companyBackend: b }, info) => {
  const dir = await registerProject(request, b, "Missing folder");
  await rm(dir, { recursive: true });
  await gotoApp(page, b.bootBase); await projectPage(page, dir, "board");
  await page.getByTestId("isolate-toggle").uncheck();
  const prompt = page.getByTestId("prompt-textarea");
  for (const locale of ["en", "ru"]) {
    if (await page.locator("html").getAttribute("lang") !== locale) await page.keyboard.press("Alt+Shift+L");
    const draft = `Draft · черновик @file-${locale}`;
    await query(prompt, draft);
    const error = page.getByTestId("at-file-error");
    await expect(error).toContainText(locale === "en" ? "Couldn't list this project's files" : "Не удалось получить файлы проекта");
    await expect(error).toContainText("directory does not exist");
    await page.screenshot({ path: info.outputPath(`${locale}-error.png`) });
    await page.keyboard.press("Escape"); await expect(error).toBeHidden();
    await expect(prompt).toHaveValue(draft);
  }
  expect(await api(request, b, "GET", "/tasks")).toEqual([]);
});
