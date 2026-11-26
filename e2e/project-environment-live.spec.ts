import { copyFile, mkdtemp } from "node:fs/promises";
import { Database } from "bun:sqlite";
import { createServer } from "node:net";
import { homedir, tmpdir } from "node:os";
import path from "node:path";
import { test, expect, type APIRequestContext, type E2EBackend, type Page } from "./fixtures";
import { gotoApp } from "./helpers";

/**
 * Real Start / Stop / Restart through the Environment page. The service is a
 * loopback Bun fixture in a temp project. The worker backend already has its
 * own temp data dir. Docker is not invoked.
 */

test.describe.configure({ mode: "serial" });

const HOME = homedir();

function assertIsolated(dir: string): void {
  const resolved = path.resolve(dir);
  for (const banned of [path.join(HOME, ".agetor"), path.join(HOME, ".agetor-dev")]) {
    if (resolved === banned || resolved.startsWith(banned + path.sep)) {
      throw new Error(`refusing to use user data directory ${resolved}`);
    }
  }
  const temp = path.resolve(tmpdir());
  if (!resolved.startsWith(temp + path.sep)) {
    throw new Error(`${resolved} is outside the temp directory; live smoke stopped`);
  }
}

function auth(backend: E2EBackend): { authorization: string } {
  return { authorization: `Bearer ${backend.apiToken}` };
}

async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.on("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        reject(new Error("no port"));
        return;
      }
      server.close(() => resolve(address.port));
    });
  });
}

async function serviceUp(port: number): Promise<boolean> {
  try {
    const res = await fetch(`http://127.0.0.1:${port}/health`, { signal: AbortSignal.timeout(500) });
    return res.status === 200;
  } catch {
    return false;
  }
}

function processExists(pid: number | null): boolean {
  if (pid === null || !Number.isInteger(pid) || pid <= 0) return false;
  const result = Bun.spawnSync(["/bin/ps", "-p", String(pid)]);
  return result.exitCode === 0;
}

function serverCount(scriptPath: string): number {
  const result = Bun.spawnSync(["/bin/ps", "-ax", "-o", "command="]);
  const text = new TextDecoder().decode(result.stdout);
  return text.split("\n").filter((line) => line.includes(scriptPath) && !line.includes("/usr/bin/perl")).length;
}

async function openProject(page: Page, projectPath: string): Promise<void> {
  await page.locator(`[data-testid="project-nav-item"][data-path="${projectPath}"]`).click();
  await expect(page.getByTestId("project-header-name")).toBeVisible();
}

async function environmentIndex(request: APIRequestContext, backend: E2EBackend, projectPath: string) {
  const res = await request.get(`${backend.apiBase}/projects/environment?path=${encodeURIComponent(projectPath)}`, {
    headers: auth(backend),
  });
  expect(res.ok(), await res.text()).toBeTruthy();
  return res.json() as Promise<{
    profiles: { profile: { id: string; name: string }; status: { recordedPhase: string; pid: number | null; ownership: string } }[];
  }>;
}

test("the environment page starts, restarts, and stops a real loopback service", async ({ page, request, backend }) => {
  test.setTimeout(120_000);
  assertIsolated(backend.dataDir);
  const projectDir = path.resolve(await mkdtemp(path.join(tmpdir(), "fo-ui-smoke-")));
  assertIsolated(projectDir);
  const scriptPath = path.join(projectDir, "smoke-server.ts");
  await copyFile(path.join(process.cwd(), "src/bun/environment/smoke-server.ts"), scriptPath);
  await Bun.write(path.join(projectDir, "compose.yaml"), "services:\n  web:\n    image: example.invalid/fo-smoke:none\n");
  const port = await freePort();
  const site = `http://127.0.0.1:${port}/health`;
  let ownedPid: number | null = null;

  const registered = await request.post(`${backend.apiBase}/projects`, {
    headers: auth(backend),
    data: { path: projectDir, name: "UI Smoke" },
  });
  expect(registered.ok(), await registered.text()).toBeTruthy();

  try {
    expect(await serviceUp(port)).toBe(false);
    await gotoApp(page, backend.bootBase);
    await openProject(page, projectDir);
    await page.getByTestId("environment-card-open").click();
    await expect(page.getByTestId("environment-phase")).toHaveText("Not configured");
    expect(await serviceUp(port)).toBe(false);
    expect(serverCount(scriptPath)).toBe(0);

    await page.getByTestId("environment-configure").click();
    await expect(page.getByTestId("environment-suggestion")).toHaveAttribute("data-file", "compose.yaml");
    await page.getByTestId("profile-kind").selectOption("local-process");
    await page.getByTestId("profile-name").fill("Smoke");
    await page.getByTestId("profile-executable").fill(process.execPath);
    await page.getByTestId("profile-args").fill(`${scriptPath}\n${port}`);
    await page.getByTestId("profile-http-url").fill(site);
    await page.getByTestId("profile-website").fill(site);
    await page.getByTestId("profile-grace").fill("4000");
    await page.getByTestId("profile-kill-after-grace").check();
    await page.getByTestId("profile-save").click();
    await expect(page.getByTestId("environment-phase")).toHaveText("Stopped", { timeout: 10_000 });
    expect(await serviceUp(port)).toBe(false);

    const database = new Database(path.join(backend.dataDir, "agetor.sqlite"), { readonly: true });
    const saved = database.query<{ data: string }, []>("SELECT data FROM environment_profiles").get();
    database.close();
    expect(saved?.data).toContain("Smoke");

    await page.getByTestId("environment-start").click();
    await expect(page.getByTestId("environment-phase")).toHaveAttribute("data-phase", "running", { timeout: 25_000 });
    await expect(page.getByTestId("environment-health")).toContainText("200");
    await expect(page.getByTestId("environment-logs")).toContainText("fo-smoke-ready");
    await expect(page.getByTestId("environment-urls")).toContainText("Up");
    expect(await serviceUp(port)).toBe(true);
    expect(serverCount(scriptPath)).toBe(1);

    const running = await environmentIndex(request, backend, projectDir);
    ownedPid = running.profiles[0]?.status.pid ?? null;
    expect(ownedPid).toBeGreaterThan(1);
    const stored = new Database(path.join(backend.dataDir, "agetor.sqlite"), { readonly: true });
    const secret = stored.query<{ data: string }, []>("SELECT data FROM environment_profiles").get()?.data.match(/"token":"([a-f0-9]{32})"/)?.[1];
    stored.close();
    expect(secret).toBeTruthy();
    await expect(page.getByTestId("environment-page")).not.toContainText(secret ?? "");
    await expect(page.getByTestId("environment-logs")).not.toContainText(secret ?? "");

    const opened = page.waitForRequest((req) => req.url().includes("/open-external") && req.method() === "POST");
    await page.getByTestId("environment-open-website").click();
    const openRequest = await opened;
    expect(openRequest.postDataJSON()).toEqual({ url: site });
    expect((await openRequest.response())?.status()).toBe(501);
    await expect(page.getByTestId("environment-error")).toContainText("Could not open");
    expect(await serviceUp(port)).toBe(true);

    const firstPid = ownedPid;
    await page.getByTestId("environment-restart").click();
    await expect.poll(async () => (await environmentIndex(request, backend, projectDir)).profiles[0]?.status.pid, {
      timeout: 25_000,
    }).not.toBe(firstPid);
    await expect(page.getByTestId("environment-phase")).toHaveAttribute("data-phase", "running");
    ownedPid = (await environmentIndex(request, backend, projectDir)).profiles[0]?.status.pid ?? null;
    expect(processExists(firstPid)).toBe(false);
    expect(await serviceUp(port)).toBe(true);
    expect(serverCount(scriptPath)).toBe(1);

    await expect(page.getByTestId("environment-start")).toHaveCount(0);
    const second = await request.post(
      `${backend.apiBase}/projects/environment/${running.profiles[0]?.profile.id}/start?path=${encodeURIComponent(projectDir)}`,
      { headers: auth(backend) },
    );
    expect(second.ok(), await second.text()).toBeTruthy();
    expect((await environmentIndex(request, backend, projectDir)).profiles[0]?.status.pid).toBe(ownedPid);
    expect(serverCount(scriptPath)).toBe(1);

    await page.getByTestId("environment-stop").click();
    await expect(page.getByTestId("environment-phase")).toHaveAttribute("data-phase", "stopped", { timeout: 20_000 });
    expect(await serviceUp(port)).toBe(false);
    expect(ownedPid === null || !processExists(ownedPid)).toBe(true);
    ownedPid = null;

    await page.getByTestId("environment-start").click();
    await expect(page.getByTestId("environment-phase")).toHaveAttribute("data-phase", "running", { timeout: 25_000 });
    expect(await serviceUp(port)).toBe(true);
    expect(serverCount(scriptPath)).toBe(1);
    ownedPid = (await environmentIndex(request, backend, projectDir)).profiles[0]?.status.pid ?? null;

    await page.getByTestId("environment-stop").click();
    await expect(page.getByTestId("environment-phase")).toHaveAttribute("data-phase", "stopped", { timeout: 20_000 });
    expect(await serviceUp(port)).toBe(false);
    ownedPid = null;

    await page.getByRole("button", { name: "Collapse project sidebar" }).click();
    await page.getByRole("button", { name: "Collapse new task panel" }).click();
    await page.setViewportSize({ width: 390, height: 700 });
    await expect(page.getByTestId("environment-page")).toBeVisible();
    await expect(page.getByTestId("environment-start")).toBeVisible();
    const fits = await page.getByTestId("environment-page").evaluate((node) => node.scrollWidth <= node.clientWidth + 1);
    expect(fits).toBe(true);
  } finally {
    const index = await environmentIndex(request, backend, projectDir).catch(() => null);
    const id = index?.profiles[0]?.profile.id;
    if (id) {
      await request.post(
        `${backend.apiBase}/projects/environment/${id}/stop?path=${encodeURIComponent(projectDir)}`,
        { headers: auth(backend) },
      ).catch(() => {});
    }
    if (ownedPid && ownedPid > 1 && processExists(ownedPid)) {
      try {
        process.kill(-ownedPid, "SIGTERM");
      } catch {
        try {
          process.kill(ownedPid, "SIGTERM");
        } catch {
          /* already gone */
        }
      }
    }
  }
});
