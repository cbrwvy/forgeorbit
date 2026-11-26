import { test as base, expect, type APIRequestContext, type Page } from "@playwright/test";
import { spawn, type ChildProcess } from "node:child_process";
import { createWriteStream } from "node:fs";
import { mkdir, mkdtemp, readFile, realpath, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { createServer } from "node:net";
import path from "node:path";
import { E2E_BASE_URL } from "../playwright.config";
import { REPO_ROOT, isolatedCoreEnv, seedIsolatedHarnessHomes, writeFxStubBin } from "./isolated-env";
import { gotoApp } from "./helpers";
import type { Task, Run, TaskQcReview, TaskQcState } from "../src/shared/types.ts";

/** FO-PRODUCT03: Owner UI assignment + two-task FO-AUTO02 batch (fake drivers only). */
export interface ProductBackend {
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

export const test = base.extend<{ product: ProductBackend; productEnv: Record<string, string> }>({
  productEnv: [{}, { option: true }],
  product: async ({ productEnv }, use, testInfo) => {
    const dataDir = await realpath(await mkdtemp(path.join(tmpdir(), "fo-head-auto01-e2e-")));
    const reservation = createServer();
    await new Promise<void>((resolve) => reservation.listen(0, "127.0.0.1", resolve));
    const port = (reservation.address() as { port: number }).port;
    await new Promise<void>((resolve) => reservation.close(() => resolve()));
    const apiToken = crypto.randomUUID();
    const apiBase = `http://127.0.0.1:${port}`;
    const fxBin = writeFxStubBin(dataDir);
    const seeded = seedIsolatedHarnessHomes(dataDir, fxBin);
    expect(seeded.ok, JSON.stringify(seeded)).toBe(true);
    const env = isolatedCoreEnv({
      dataDir,
      apiPort: port,
      apiToken,
      fxBin,
      extra: {
        CI: "1",
        AGETOR_CLAUDE_DRIVER: "fake",
        AGETOR_FAKE_QC_VERDICT: "PASS",
        AGETOR_FAKE_MANAGER_DELAY_MS: "300",
        ...productEnv,
      },
    });
    const logPath = path.join(dataDir, "backend.log");
    const log = createWriteStream(logPath, { flags: "a" });
    let child: ChildProcess | undefined;
    async function start() {
      child = spawn("bun", ["src/bun/headless.ts"], { cwd: REPO_ROOT, env, stdio: ["ignore", "pipe", "pipe"] });
      await writeFile(path.join(dataDir, "backend-pids.log"), `${child.pid}\n`, { flag: "a" });
      child.stdout!.pipe(log, { end: false });
      child.stderr!.pipe(log, { end: false });
      await expect.poll(async () => {
        if (child!.exitCode !== null) throw new Error(`Backend exited: ${await readFile(logPath, "utf8")}`);
        return fetch(`${apiBase}/health`, { signal: AbortSignal.timeout(1000) }).then((r) => r.ok, () => false);
      }, { timeout: 30_000 }).toBe(true);
    }
    try {
      await start();
      await use({
        dataDir,
        apiBase,
        apiToken,
        bootBase: `${E2E_BASE_URL}/#api=${port}&token=${apiToken}`,
        restart: async () => {
          await stop(child!);
          await start();
        },
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

test.use({ actionTimeout: 15_000 });

export async function api<T>(
  request: APIRequestContext,
  b: ProductBackend,
  method: "get" | "post" | "put" | "patch",
  route: string,
  data?: unknown,
  status = 200,
): Promise<T> {
  const r = await request[method](b.apiBase + route, { headers: { authorization: `Bearer ${b.apiToken}` }, ...(data === undefined ? {} : { data }) });
  const text = await r.text();
  expect(r.status(), `${method} ${route}: ${text}`).toBe(status);
  return JSON.parse(text) as T;
}
