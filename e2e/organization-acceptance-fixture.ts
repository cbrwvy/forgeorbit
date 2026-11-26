import { test as base, expect, type APIRequestContext, type Page } from "@playwright/test";
import { spawn, type ChildProcess } from "node:child_process";
import { createWriteStream } from "node:fs";
import { mkdir, mkdtemp, readFile, realpath, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { Database } from "bun:sqlite";
import { E2E_BASE_URL } from "../playwright.config";
import { REPO_ROOT, isolatedCoreEnv, seedIsolatedHarnessHomes, writeFxStubBin } from "./isolated-env";
import { clickProjectPage } from "./project-nav";

/** FO-012C uses the canonical headless server, not an in-test runtime.
 * Only owned disposable children may be stopped. SQLite inspection is read-only.
 */
export interface AcceptanceBackend {
  dataDir: string;
  apiBase: string;
  apiToken: string;
  bootBase: string;
  restart(crash?: boolean): Promise<void>;
}

export const test = base.extend<{ companyBackend: AcceptanceBackend; companyEnv: Record<string, string> }>({
  companyEnv: [{}, { option: true }],
  companyBackend: async ({ companyEnv }, use, info) => {
    const dataDir = await realpath(await mkdtemp(path.join(tmpdir(), "fo012c-company-")));
    const reservation = createServer();
    await new Promise<void>(resolve => reservation.listen(0, "127.0.0.1", resolve));
    const port = (reservation.address() as { port: number }).port;
    await new Promise<void>(resolve => reservation.close(() => resolve()));
    const apiToken = crypto.randomUUID(), apiBase = `http://127.0.0.1:${port}`;
    const fxBin = writeFxStubBin(dataDir);
    const seeded = seedIsolatedHarnessHomes(dataDir, fxBin);
    expect(seeded.ok, JSON.stringify(seeded)).toBe(true);
    const env = isolatedCoreEnv({ dataDir, apiPort: port, apiToken, fxBin, extra: {
      AGETOR_FAKE_MANAGER_DELAY_MS: "200", AGETOR_FAKE_PORTFOLIO_DELAY_MS: "200", ...companyEnv,
    } });
    const logPath = path.join(dataDir, "backend.log"), log = createWriteStream(logPath, { flags: "a" });
    const lifecycle: { pid?: number; action: string; time: number }[] = [];
    let child: ChildProcess | undefined;
    async function start() {
      child = spawn("bun", ["src/bun/headless.ts"], { cwd: REPO_ROOT, env, stdio: ["ignore", "pipe", "pipe"] });
      lifecycle.push({ pid: child.pid, action: "start", time: Date.now() });
      child.stdout!.pipe(log, { end: false }); child.stderr!.pipe(log, { end: false });
      await expect.poll(async () => {
        if (child!.exitCode !== null) throw Error(`Owned backend exited: ${await readFile(logPath, "utf8")}`);
        return fetch(`${apiBase}/health`, { signal: AbortSignal.timeout(1000) }).then(r => r.ok, () => false);
      }, { timeout: 30_000 }).toBe(true);
    }
    async function stop(crash = false) {
      if (!child || child.exitCode !== null || child.signalCode !== null) return;
      const owned = child;
      const exited = new Promise<void>(resolve => owned.once("exit", () => resolve()));
      lifecycle.push({ pid: owned.pid, action: crash ? "crash-SIGKILL" : "stop-SIGTERM", time: Date.now() });
      owned.kill(crash ? "SIGKILL" : "SIGTERM");
      await Promise.race([exited, new Promise<void>((_, reject) => {
        const timer = setTimeout(() => reject(Error(`Owned backend ${owned.pid} did not exit`)), 5000);
        timer.unref();
      })]);
      lifecycle.push({ pid: owned.pid, action: "exited", time: Date.now() });
    }
    try {
      await start();
      await use({ dataDir, apiBase, apiToken, bootBase: `${E2E_BASE_URL}/#api=${port}&token=${apiToken}`,
        restart: async crash => { await stop(crash); await start(); } });
    } finally {
      await stop();
      await new Promise<void>(resolve => log.end(resolve));
      await info.attach("owned-backend-lifecycle", { body: JSON.stringify({ dataDir, lifecycle }, null, 2), contentType: "application/json" });
      await info.attach("backend-log", { path: logPath, contentType: "text/plain" });
      await writeFile(info.outputPath("disposable-data-directory.txt"), dataDir);
    }
  },
});
export { expect };

export async function api(request: APIRequestContext, b: AcceptanceBackend, method: string, route: string, data?: unknown, expected = 200): Promise<any> {
  const response = await request.fetch(b.apiBase + route, { method, headers: { authorization: `Bearer ${b.apiToken}` }, data });
  const text = await response.text();
  expect(response.status(), `${method} ${route}: ${text}`).toBe(expected);
  return text ? JSON.parse(text) : null;
}
export function sql(b: AcceptanceBackend, query: string): any[] {
  const db = new Database(path.join(b.dataDir, "agetor.sqlite"), { readonly: true });
  try { return db.query(query).all(); } finally { db.close(); }
}
export async function registerProject(request: APIRequestContext, b: AcceptanceBackend, name: string, documents = false) {
  const dir = path.join(b.dataDir, "projects", name);
  await mkdir(dir, { recursive: true });
  if (documents) {
    await mkdir(path.join(dir, "docs"));
    await writeFile(path.join(dir, "docs/IDEA.md"), `# ${name}\nOffline acceptance idea.\n`);
    await writeFile(path.join(dir, "docs/PRD.md"), `# ${name} requirements\nOwner approves every protected action.\n`);
  }
  await api(request, b, "POST", "/projects", { path: dir, name });
  return dir;
}
export async function projectPage(page: Page, dir: string, surface: string) {
  await page.locator(`[data-testid="project-nav-item"][data-path="${dir}"]`).click();
  await clickProjectPage(page, surface);
}
export async function managerMessage(page: Page, kind: "manager" | "portfolio-manager", text: string) {
  await page.getByTestId(`${kind}-composer`).fill(text);
  await page.getByTestId(`${kind}-send`).click();
  await expect(page.getByTestId(`${kind}-busy`)).toBeVisible();
  await expect(page.getByTestId(`${kind}-busy`)).toHaveCount(0);
}
