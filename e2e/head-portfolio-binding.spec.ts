import { test as base, expect, type APIRequestContext, type Page } from "@playwright/test";
import { spawn, type ChildProcess } from "node:child_process";
import { createWriteStream } from "node:fs";
import { mkdir, mkdtemp, readFile, realpath, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { createServer } from "node:net";
import path from "node:path";
import { Database } from "bun:sqlite";
import { E2E_BASE_URL } from "../playwright.config";
import { REPO_ROOT, isolatedCoreEnv, seedIsolatedHarnessHomes, writeFxStubBin } from "./isolated-env";
import { gotoApp, openPortfolio } from "./helpers";

/** FO-012: one company/project/worker/task/run chain, not independent page fixtures.
 * Local lifecycle permits an actual backend restart without modifying shared fixtures.
 * Data and logs are retained under the system temp dir; logs are also attached.
 */
interface OrganizationBackend {
  dataDir: string;
  apiBase: string;
  apiToken: string;
  bootBase: string;
  restart(): Promise<void>;
}

async function stop(child: ChildProcess) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const exited = new Promise<void>((resolve) => child.once("exit", () => resolve()));
  child.kill("SIGTERM");
  await Promise.race([exited, new Promise((resolve) => setTimeout(resolve, 4000))]);
  if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
  await exited;
}

const test = base.extend<{ organization: OrganizationBackend; organizationEnv: Record<string, string> }>({
  organizationEnv: [{}, { option: true }],
  organization: async ({ organizationEnv }, use, testInfo) => {
    const dataDir = await realpath(await mkdtemp(path.join(tmpdir(), "fo012b-organization-")));
    const reservation = createServer();
    await new Promise<void>((resolve) => reservation.listen(0, "127.0.0.1", resolve));
    const port = (reservation.address() as { port: number }).port;
    await new Promise<void>((resolve) => reservation.close(() => resolve()));
    const apiToken = crypto.randomUUID();
    const apiBase = `http://127.0.0.1:${port}`;
    const fxBin = writeFxStubBin(dataDir);
    const seeded = seedIsolatedHarnessHomes(dataDir, fxBin);
    expect(seeded.ok, JSON.stringify(seeded)).toBe(true);
    const env = isolatedCoreEnv({ dataDir, apiPort: port, apiToken, fxBin, extra: {
      CI: "1", AGETOR_FAKE_MANAGER_DELAY_MS: "300", AGETOR_FAKE_PORTFOLIO_DELAY_MS: "300", ...organizationEnv,
    } });
    const logPath = path.join(dataDir, "backend.log");
    const log = createWriteStream(logPath, { flags: "a" });
    let child: ChildProcess | undefined;
    async function start() {
      child = spawn("bun", ["src/bun/headless.ts"], { cwd: REPO_ROOT, env, stdio: ["ignore", "pipe", "pipe"] });
      child.stdout!.pipe(log, { end: false });
      child.stderr!.pipe(log, { end: false });
      await expect.poll(async () => {
        if (child!.exitCode !== null) throw new Error(`Backend exited: ${await readFile(logPath, "utf8")}`);
        return fetch(`${apiBase}/health`, { signal: AbortSignal.timeout(1000) }).then((r) => r.ok, () => false);
      }, { timeout: 30_000 }).toBe(true);
    }
    try {
      await start();
      await use({ dataDir, apiBase, apiToken, bootBase: `${E2E_BASE_URL}/#api=${port}&token=${apiToken}`,
        restart: async () => { await stop(child!); await start(); },
      });
    } finally {
      if (child) await stop(child);
      await new Promise<void>((resolve) => log.end(resolve));
      for (const name of ["backend.log", "daemon.log"]) {
        await testInfo.attach(name, { path: path.join(dataDir, name), contentType: "text/plain" });
      }
      const directoryArtifact = testInfo.outputPath("isolated-data-directory.txt");
      await writeFile(directoryArtifact, dataDir);
      await testInfo.attach("isolated-data-directory", { path: directoryArtifact, contentType: "text/plain" });
    }
  },
});


test.use({ actionTimeout: 12_000 });
const auth = (b: OrganizationBackend) => ({ authorization: `Bearer ${b.apiToken}` });
async function api(request: APIRequestContext, b: OrganizationBackend, method: "get" | "post" | "put" | "patch" | "delete", route: string, data?: unknown, status = 200): Promise<any> {
  const r = await request[method](b.apiBase + route, { headers: auth(b), ...(data === undefined ? {} : { data }) });
  const text = await r.text(); expect(r.status(), `${method} ${route}: ${text}`).toBe(status); return JSON.parse(text);
}
async function company(page: Page) {
  await page.getByTestId("workspace-company").click(); await expect(page.getByTestId("company-page")).toBeVisible();
}
async function bind(page: Page) {
  await page.getByTestId("head-binding-bind").focus(); await page.keyboard.press("Enter");
  await expect(page.getByRole("dialog")).toContainText("organizational Head");
  await page.getByRole("dialog").getByRole("button", { name: "Confirm binding" }).click();
  await expect(page.getByTestId("head-binding-status")).toHaveText("Portfolio Manager Binding: Bound");
}
async function send(page: Page, text: string) {
  await page.getByTestId("portfolio-manager-composer").fill(text); await page.getByTestId("portfolio-manager-send").click();
  await expect(page.getByTestId("portfolio-manager-busy")).toBeVisible(); await expect(page.getByTestId("portfolio-manager-busy")).toHaveCount(0);
}

test("Company bind → same global runtime → delegation → change Head → archive/unbind → restart", async ({ page, request, organization: b }, info) => {
  test.setTimeout(90_000);
  const errors: string[] = []; page.on("pageerror", e => errors.push(e.message));
  const dir = path.join(b.dataDir, "project"); await mkdir(dir);
  await api(request, b, "post", "/projects", { path: dir, name: "Binding project" });
  const h = (await api(request, b, "put", "/employees/head", { name: "Morgan Head" }, 201)).employee;
  await api(request, b, "patch", "/harnesses/codex", { enabled: true });
  const preflight = await api(request, b, "post", "/project-interviews/preflight", { harness: "codex", model: "gpt-6.1-sol" });
  const config = { harness: "codex", model: "gpt-6.1-sol", effort: "low", consentKey: preflight.isolation.consentKey };
  await api(request, b, "put", "/portfolio-manager/config", { config });
  await api(request, b, "put", "/project-manager/config", { path: dir, config });
  await gotoApp(page, b.bootBase); await company(page);
  await expect(page.getByTestId("head-binding-status")).toContainText("Unbound");
  await expect(page.getByTestId("head-binding-uuid")).toContainText(h.id); await bind(page);
  await page.getByTestId("head-binding-open-manager").click();
  await expect(page.getByTestId("portfolio-manager-head")).toContainText(h.id);
  await expect(page.getByTestId("portfolio-manager-empty")).toBeVisible();
  await send(page, "Delegate to Binding project");
  const s = await api(request, b, "get", "/portfolio-manager");
  const d = s.delegations[0]; expect(d.attribution.head.employeeId).toBe(h.id);
  expect((await api(request, b, "get", `/project-manager?path=${encodeURIComponent(dir)}`)).messages).toEqual([]);
  await expect(page.getByTestId("portfolio-reply-head")).toContainText(h.id);
  const card = page.getByTestId("portfolio-delegation"); await card.getByTestId("portfolio-delegation-approve").click();
  await page.getByRole("dialog").getByRole("button", { name: "Send request" }).click();
  await expect(card).toHaveAttribute("data-status", "answered");
  const target = await api(request, b, "get", `/project-manager?path=${encodeURIComponent(dir)}`);
  expect(target.messages[0].portfolioAttribution).toEqual(d.attribution);
  // Rename is identity maintenance; historical turn keeps original name.
  await api(request, b, "patch", `/employees/${h.id}`, { name: "Morgan Renamed" });
  await company(page); await expect(page.getByTestId("head-binding-status")).toContainText("Bound");
  await expect(page.getByTestId("company-head-name")).toHaveText("Morgan Renamed");
  await page.getByTestId("company-head-open").click(); await page.getByTestId("employee-archive").click();
  await page.getByRole("dialog").getByRole("button", { name: "Archive", exact: true }).click();
  await company(page); await expect(page.getByTestId("head-binding-status")).toContainText("Invalid");
  await expect(page.getByTestId("head-binding-employee-status")).toContainText("archived");
  const next = (await api(request, b, "put", "/employees/head", { name: "Taylor Head" }, 201)).employee;
  await page.reload(); await company(page); await bind(page);
  await page.getByTestId("head-binding-open-manager").click();
  await expect(page.getByTestId("portfolio-manager-head")).toContainText(next.id);
  await expect(page.getByTestId("portfolio-reply-head")).toContainText(h.id);
  await send(page, "Portfolio summary");
  await expect(page.getByTestId("portfolio-reply-head").last()).toContainText(next.id);
  const before = await api(request, b, "get", "/portfolio-manager");
  await b.restart(); await page.reload();
  await openPortfolio(page); await page.getByTestId("portfolio-tab-manager").click();
  await expect(page.getByTestId("portfolio-manager-head")).toContainText(next.id);
  const after = await api(request, b, "get", "/portfolio-manager");
  expect(after.messages).toEqual(before.messages); expect(after.delegations).toEqual(before.delegations); expect(after.config).toEqual(before.config);
  await company(page); await page.getByTestId("head-binding-unbind").click();
  await page.getByRole("dialog").getByRole("button", { name: "Unbind", exact: true }).click();
  await expect(page.getByTestId("head-binding-status")).toContainText("Unbound");
  await page.getByTestId("head-binding-open-manager").click(); await expect(page.getByTestId("portfolio-manager-head")).toContainText("Legacy manager mode");
  expect(errors).toEqual([]);
  await info.attach("runtime-attribution", { body: JSON.stringify(after.messages.map((m: any) => ({ id: m.id, attribution: m.attribution })), null, 2), contentType: "application/json" });
});

test("bound identity fits Light/Dark and 390/768/1024/1440; keyboard confirmation and Escape", async ({ page, request, organization: b }, info) => {
  const h = (await api(request, b, "put", "/employees/head", { name: "A long Head name for responsive binding" }, 201)).employee;
  await gotoApp(page, b.bootBase); await company(page);
  await page.getByTestId("head-binding-bind").focus(); await page.keyboard.press("Enter");
  await page.keyboard.press("Escape"); await expect(page.getByRole("dialog")).toHaveCount(0);
  expect((await api(request, b, "get", "/portfolio-manager/head-binding")).status).toBe("unbound");
  await bind(page);
  for (const theme of ["light", "dark"] as const) {
    await page.emulateMedia({ colorScheme: theme, reducedMotion: "reduce" });
    await expect.poll(() => page.locator("html").evaluate(n => n.classList.contains("dark"))).toBe(theme === "dark");
    for (const width of [390, 768, 1024, 1440]) {
      await page.setViewportSize({ width, height: 900 });
      await expect(page.getByTestId("head-binding-uuid")).toContainText(h.id);
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
      const box = await page.getByTestId("head-portfolio-binding").boundingBox(); expect(box!.width).toBeLessThanOrEqual(width);
      await page.screenshot({ path: info.outputPath(`head-${theme}-${width}.png`) });
    }
  }
  await page.getByTestId("head-binding-open-manager").focus(); await page.keyboard.press("Enter");
  await expect(page.getByTestId("portfolio-manager-head")).toContainText(h.id);
  await expect(page.getByTestId("portfolio-manager-empty")).toBeVisible();
});

test("empty/loading/error binding never claims Bound; recovery requires a fresh server read", async ({ page, organization: b }) => {
  let release!: () => void; const gate = new Promise<void>(resolve => release = resolve);
  await page.route("**/portfolio-manager/head-binding", async route => { await gate; await route.fulfill({ status: 503, contentType: "application/json", body: JSON.stringify({ error: "Binding read unavailable" }) }); });
  await gotoApp(page, b.bootBase); await company(page);
  await expect(page.getByTestId("head-binding-status")).toContainText("Loading");
  await expect(page.getByTestId("company-head-empty")).toBeVisible();
  release(); await expect(page.getByTestId("head-binding-error")).toContainText("Binding read unavailable");
  await expect(page.getByTestId("head-binding-bind")).toHaveCount(0);
  await page.unroute("**/portfolio-manager/head-binding");
  await page.getByRole("button", { name: "Refresh binding" }).click();
  await expect(page.getByTestId("head-binding-status")).toContainText("Unbound");
});
