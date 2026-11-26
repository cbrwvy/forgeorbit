import { expect, test as base, type APIRequestContext, type Page } from "@playwright/test";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdir, mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { createServer } from "node:net";
import path from "node:path";
import { E2E_BASE_URL } from "../playwright.config";
import { REPO_ROOT, isolatedCoreEnv, seedIsolatedHarnessHomes, writeFxStubBin } from "./isolated-env";
import { writeCodexProfileFixture, writeSyntheticCodexProfile } from "./codex-profile-fixture";
import { gotoApp } from "./helpers";

interface Backend { dataDir: string; apiBase: string; apiToken: string; bootBase: string; ownerHome: string; restart(): Promise<void> }

async function stop(child: ChildProcess) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const exited = new Promise<void>((resolve) => child.once("exit", () => resolve()));
  child.kill("SIGTERM");
  await Promise.race([exited, new Promise((resolve) => setTimeout(resolve, 4000))]);
  if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
  await exited;
}

const test = base.extend<{ backend: Backend }>({
  backend: async ({}, use) => {
    const root = await realpath(await mkdtemp(path.join(tmpdir(), "fo-codex-reg-ui-")));
    const dataDir = path.join(root, "data");
    const ownerHome = path.join(root, "owner");
    await mkdir(dataDir);
    await mkdir(ownerHome);
    const reservation = createServer();
    await new Promise<void>((resolve) => reservation.listen(0, "127.0.0.1", resolve));
    const port = (reservation.address() as { port: number }).port;
    await new Promise<void>((resolve) => reservation.close(() => resolve()));
    const apiToken = crypto.randomUUID();
    const apiBase = `http://127.0.0.1:${port}`;
    const fxBin = writeFxStubBin(dataDir);
    expect(seedIsolatedHarnessHomes(dataDir, fxBin).ok).toBe(true);
    const env = isolatedCoreEnv({
      dataDir, apiPort: port, apiToken, fxBin,
      extra: { HOME: ownerHome, AGETOR_CODEX_BIN: writeCodexProfileFixture(root, process.execPath), AGETOR_CODEX_DRIVER: "fake" },
    });
    let child: ChildProcess | undefined;
    async function start() {
      child = spawn("bun", ["src/bun/headless.ts"], { cwd: REPO_ROOT, env, stdio: "ignore" });
      await expect.poll(async () => {
        if (child!.exitCode !== null) return "exited";
        return fetch(`${apiBase}/health`).then((response) => response.ok, () => false);
      }, { timeout: 30_000 }).toBe(true);
    }
    try {
      await start();
      await use({
        dataDir, apiBase, apiToken, ownerHome,
        bootBase: `${E2E_BASE_URL}/#api=${port}&token=${apiToken}`,
        restart: async () => { await stop(child!); await start(); },
      });
    } finally {
      if (child) await stop(child);
      await rm(root, { recursive: true, force: true });
    }
  },
});

async function openAccounts(page: Page, locale: "en" | "ru") {
  const copy = locale === "en"
    ? { settings: "Settings", sections: "Settings sections", accounts: "AI providers and accounts" }
    : { settings: "Настройки", sections: "Разделы настроек", accounts: "ИИ-провайдеры и аккаунты" };
  await page.getByRole("button", { name: copy.settings, exact: true }).click();
  await page.getByRole("navigation", { name: copy.sections }).getByRole("button", { name: copy.accounts, exact: true }).click();
  await expect(page.getByTestId("codex-profiles")).toBeVisible();
}

async function preference(request: APIRequestContext, backend: Backend, value: string) {
  const response = await request.put(`${backend.apiBase}/preferences/locale`, {
    headers: { authorization: `Bearer ${backend.apiToken}` },
    data: { value },
  });
  expect(response.ok()).toBe(true);
}

test("Settings accounts registers distinct profiles and shows validation errors", async ({ page, request, backend }) => {
  test.setTimeout(120_000);
  const homes = ["profile-a", "profile-b"].map((name, index) => {
    const directory = path.join(backend.ownerHome, name);
    writeSyntheticCodexProfile(directory, `ui-subject-${index}`);
    return directory;
  });
  await preference(request, backend, "en");
  await gotoApp(page, backend.bootBase);
  await openAccounts(page, "en");
  for (const [index, directory] of homes.entries()) {
    await page.getByTestId("codex-profile-add").click();
    await page.getByTestId("codex-profile-name").fill(index === 0 ? "Profile A" : "Profile B");
    await page.getByTestId("codex-profile-directory").fill(directory);
    await page.getByTestId("codex-profile-save").click();
    await expect(page.getByTestId("codex-profile-card")).toHaveCount(index + 1);
  }
  const ids = await page.getByTestId("codex-profile-card").evaluateAll((cards) => cards.map((card) => card.getAttribute("data-account-id")));
  expect(new Set(ids).size).toBe(2);
  await page.getByTestId("codex-profile-add").click();
  await page.getByTestId("codex-profile-name").fill("Missing");
  await page.getByTestId("codex-profile-directory").fill(path.join(backend.ownerHome, "missing-profile"));
  await page.getByTestId("codex-profile-save").click();
  const error = page.getByTestId("codex-profile-error");
  await expect(error).toContainText("missing or unreadable");
  await expect(error).not.toContainText("Account operation failed");
  await expect(error).not.toContainText("could not be confirmed");
  await expect(page.getByTestId("codex-profile-card")).toHaveCount(2);

  await preference(request, backend, "ru");
  await page.reload();
  await openAccounts(page, "ru");
  await page.getByTestId("codex-profile-add").click();
  await page.getByTestId("codex-profile-name").fill("Отсутствует");
  await page.getByTestId("codex-profile-directory").fill(path.join(backend.ownerHome, "missing-profile-ru"));
  await page.getByTestId("codex-profile-save").click();
  await expect(page.getByTestId("codex-profile-error")).toContainText("Не удалось обновить профиль");
  await expect(page.getByTestId("codex-profile-error")).not.toContainText("Account operation failed");

  await backend.restart();
  await preference(request, backend, "en");
  await page.reload();
  await openAccounts(page, "en");
  await expect(page.getByTestId("codex-profile-card")).toHaveCount(2);
  await expect(page.getByTestId("codex-profile-card").filter({ hasText: "Profile A" })).toBeVisible();
  await expect(page.getByTestId("codex-profile-card").filter({ hasText: "Profile B" })).toBeVisible();
});
