import { afterAll, afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const repoRoot = path.resolve(import.meta.dir, "../..");
const prevForgeorbitDataDir = process.env.FORGEORBIT_DATA_DIR;
const prevAgetorDataDir = process.env.AGETOR_DATA_DIR;
const ownedDbDir = !prevForgeorbitDataDir && !prevAgetorDataDir ? mkdtempSync(path.join(tmpdir(), "fo-updater-db-")) : null;
if (ownedDbDir) {
  process.env.FORGEORBIT_DATA_DIR = ownedDbDir;
  process.env.AGETOR_DATA_DIR = ownedDbDir;
}
const tempRoot = mkdtempSync(path.join(tmpdir(), "fo-updater-test-"));

const prevEnable = process.env.FORGEORBIT_ENABLE_UPDATES;
const prevDisable = process.env.FORGEORBIT_DISABLE_UPDATES;
const prevAgetorDisable = process.env.AGETOR_DISABLE_UPDATES;

function restoreEnv(): void {
  const restore = (key: string, value: string | undefined) => {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  };
  restore("FORGEORBIT_ENABLE_UPDATES", prevEnable);
  restore("FORGEORBIT_DISABLE_UPDATES", prevDisable);
  restore("AGETOR_DISABLE_UPDATES", prevAgetorDisable);
}

let stopLoopRef: (() => void) | null = null;

afterEach(() => {
  stopLoopRef?.();
  restoreEnv();
});

afterAll(() => {
  stopLoopRef?.();
  restoreEnv();
  if (prevForgeorbitDataDir === undefined) delete process.env.FORGEORBIT_DATA_DIR;
  else process.env.FORGEORBIT_DATA_DIR = prevForgeorbitDataDir;
  if (prevAgetorDataDir === undefined) delete process.env.AGETOR_DATA_DIR;
  else process.env.AGETOR_DATA_DIR = prevAgetorDataDir;
  rmSync(tempRoot, { recursive: true, force: true });
});

describe("disabled updater offline proof", () => {
  test("dev-channel bundle short-circuits before any HTTP fetch even under installUpdateGuard + Electrobun Updater", async () => {
    const requests: string[] = [];
    const server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch(req) {
        requests.push(`${req.method} ${new URL(req.url).pathname}`);
        return new Response("{}", { status: 200 });
      },
    });
    const bundleRoot = mkdtempSync(path.join(tempRoot, "bundle-"));
    const macOsDir = path.join(bundleRoot, "Contents/MacOS");
    const resourcesDir = path.join(bundleRoot, "Contents/Resources");
    mkdirSync(macOsDir, { recursive: true });
    mkdirSync(resourcesDir, { recursive: true });

    writeFileSync(
      path.join(resourcesDir, "version.json"),
      JSON.stringify({
        version: "1.0.3",
        hash: "dev",
        channel: "dev",
        baseUrl: `http://127.0.0.1:${server.port}/releases/latest/download`,
        name: "ForgeOrbit",
        identifier: "app.forgeorbit",
      }),
    );

    const { installUpdateGuard } = await import("./update-policy.ts");
    const { macBundleVersion } = await import("../shared/release-version.ts");
    const localBuild = {
      schemaVersion: 1 as const,
      productVersion: "1.0.3",
      buildNumber: 4,
      macBundleVersion: macBundleVersion(4),
      sourceRevision: "89d2cb77ca0abddc91eee89ef8658e29ea229cdb",
      sourceTreeSHA256: "a".repeat(64),
      sourceDirty: true,
      channel: "dev" as const,
      identifier: "app.forgeorbit",
      platform: "macos",
      arch: "arm64",
      builtAt: "2026-11-18T08:30:00.000Z",
      localBuild: true as const,
    };
    writeFileSync(path.join(resourcesDir, "forgeorbit-build.json"), JSON.stringify(localBuild));

    try {
      // Run Electrobun's real Updater in a fresh process with cwd=Contents/MacOS before importing
      // electrobun/bun in this process so its RPC listener port does not collide and localInfo is fresh.
      const outFile = path.join(tempRoot, "sdk-probe-result.json");
      const updaterModulePath = path.join(repoRoot, "node_modules/electrobun/dist/api/bun/index.ts");
      const sdkProbe = Bun.spawnSync(
        [
          process.execPath,
          "-e",
          `import { writeFileSync } from "node:fs"; import { Updater } from ${JSON.stringify(updaterModulePath)}; const info = await Updater.getLocalInfo(); const r = await Updater.checkForUpdate(); writeFileSync(${JSON.stringify(outFile)}, JSON.stringify({ info, r })); process.exit(0);`,
        ],
        { cwd: macOsDir, stdout: "pipe", stderr: "pipe", timeout: 15_000 },
      );
      expect(sdkProbe.exitCode, new TextDecoder().decode(sdkProbe.stderr)).toBe(0);
      const { info, r: rawResult } = JSON.parse(readFileSync(outFile, "utf8"));
      expect(info.channel).toBe("dev");
      expect(info.hash).toBe("dev");
      expect(rawResult.updateAvailable).toBe(false);
      expect(rawResult.updateReady).toBe(false);
      expect(rawResult.error).toBe("");

      let guardedSdkCalled = 0;
      const sdk = {
        getLocalInfo: async () => ({
          version: localBuild.productVersion,
          channel: "dev",
          identifier: localBuild.identifier,
          hash: "dev",
        }),
        checkForUpdate: async () => {
          guardedSdkCalled += 1;
          await fetch(`http://127.0.0.1:${server.port}/dev-macos-arm64-update.json`);
          return { version: "1.0.4", hash: "next", updateAvailable: true, updateReady: false, error: "" };
        },
      };
      installUpdateGuard(sdk, () => localBuild);
      const guardedResult = await sdk.checkForUpdate();
      expect(guardedResult.updateAvailable).toBe(false);
      expect(guardedSdkCalled).toBe(0);
      expect(requests).toEqual([]);
    } finally {
      server.stop(true);
    }
  });

  test("startUpdaterLoop, checkForUpdate, and applyUpdate perform zero fetches when disabled by default or flag", async () => {
    const { Updater } = await import("electrobun/bun");
    const {
      applyUpdate,
      checkForUpdate,
      getUpdateSnapshot,
      startUpdaterLoop,
      stopUpdaterLoop,
    } = await import("./updater.ts");
    stopLoopRef = stopUpdaterLoop;

    const requests: string[] = [];
    const server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch(req) {
        requests.push(`${req.method} ${new URL(req.url).pathname}`);
        return new Response("{}", { status: 200 });
      },
    });
    const fetchCalls: string[] = [];
    const originalFetch = globalThis.fetch;
    const originalBaseUrl = Updater.localInfo.baseUrl;
    const originalSdkCheck = Updater.checkForUpdate;
    const originalSdkDownload = Updater.downloadUpdate;
    const originalSdkApply = Updater.applyUpdate;
    let sdkCalls = 0;

    try {
      globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
        fetchCalls.push(String(input));
        return originalFetch(input, init);
      }) as typeof fetch;
      Updater.localInfo.baseUrl = async () => `http://127.0.0.1:${server.port}/releases/latest/download`;
      Updater.checkForUpdate = async () => {
        sdkCalls += 1;
        throw new Error("SDK checkForUpdate must not be called when updates are disabled");
      };
      Updater.downloadUpdate = async () => {
        sdkCalls += 1;
        throw new Error("SDK downloadUpdate must not be called when updates are disabled");
      };
      Updater.applyUpdate = async () => {
        sdkCalls += 1;
        throw new Error("SDK applyUpdate must not be called when updates are disabled");
      };

      delete process.env.FORGEORBIT_ENABLE_UPDATES;
      delete process.env.FORGEORBIT_DISABLE_UPDATES;
      delete process.env.AGETOR_DISABLE_UPDATES;

      startUpdaterLoop();
      await checkForUpdate();
      expect(getUpdateSnapshot().status).toBe("idle");
      expect(getUpdateSnapshot().error).toBeNull();
      await expect(applyUpdate()).rejects.toThrow("Updates disabled");

      process.env.FORGEORBIT_ENABLE_UPDATES = "1";
      process.env.FORGEORBIT_DISABLE_UPDATES = "1";
      startUpdaterLoop();
      await checkForUpdate();
      expect(getUpdateSnapshot().status).toBe("idle");
      await expect(applyUpdate()).rejects.toThrow("Updates disabled");

      expect(sdkCalls).toBe(0);
      expect(fetchCalls).toEqual([]);
      expect(requests).toEqual([]);
    } finally {
      globalThis.fetch = originalFetch;
      Updater.localInfo.baseUrl = originalBaseUrl;
      Updater.checkForUpdate = originalSdkCheck;
      Updater.downloadUpdate = originalSdkDownload;
      Updater.applyUpdate = originalSdkApply;
      server.stop(true);
    }
  });

  test("isAllowedUpdateBaseUrl permits only cbrwvy/forgeorbit releases and rejects upstream or empty feeds", async () => {
    const { isAllowedUpdateBaseUrl } = await import("./updater.ts");
    expect(isAllowedUpdateBaseUrl("https://github.com/cbrwvy/forgeorbit/releases/latest/download")).toBe(true);
    expect(isAllowedUpdateBaseUrl("https://github.com/alamops/agetor/releases/latest/download")).toBe(false);
    expect(isAllowedUpdateBaseUrl("http://127.0.0.1:4317/")).toBe(false);
    expect(isAllowedUpdateBaseUrl("")).toBe(false);
    expect(isAllowedUpdateBaseUrl(null)).toBe(false);
  });
});
