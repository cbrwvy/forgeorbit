import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import pkg from "../../package.json" with { type: "json" };
import { macBundleVersion } from "../shared/release-version.ts";
import { migrations } from "./migrations/index.ts";
import { packagedBuildMetadataPath, readBuildInfo } from "./build-info.ts";

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("readBuildInfo", () => {
  test("reads packaged forgeorbit-build.json adjacent to Contents/MacOS/bun", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "fo-build-info-"));
    tempDirs.push(dir);
    const macOsDir = path.join(dir, "ForgeOrbit.app/Contents/MacOS");
    const resourcesDir = path.join(dir, "ForgeOrbit.app/Contents/Resources");
    mkdirSync(macOsDir, { recursive: true });
    mkdirSync(resourcesDir, { recursive: true });

    const execPath = path.join(macOsDir, "bun");
    const revision = "89d2cb77ca0abddc91eee89ef8658e29ea229cdb";
    const treeSha = "a".repeat(64);
    const metadata = {
      schemaVersion: 1,
      productVersion: pkg.version,
      buildNumber: pkg.forgeorbitBuildNumber,
      macBundleVersion: macBundleVersion(pkg.forgeorbitBuildNumber),
      sourceRevision: revision,
      sourceTreeSHA256: treeSha,
      sourceDirty: true,
      channel: "dev",
      identifier: "app.forgeorbit",
      platform: "macos",
      arch: "arm64",
      builtAt: "2026-11-18T08:30:00.000Z",
      localBuild: true,
    };
    writeFileSync(packagedBuildMetadataPath(execPath), JSON.stringify(metadata));

    const info = readBuildInfo({ execPath, env: {} });
    expect(info).toEqual({
      version: pkg.version,
      buildNumber: pkg.forgeorbitBuildNumber,
      macBundleVersion: macBundleVersion(pkg.forgeorbitBuildNumber),
      sourceRevision: revision,
      sourceTreeSHA256: treeSha,
      sourceDirty: true,
      channel: "dev",
      identifier: "app.forgeorbit",
      localBuild: true,
      builtAt: "2026-11-18T08:30:00.000Z",
      migrationCeiling: migrations.at(-1)?.id ?? null,
      updatesEnabled: false,
    });
  });

  test("falls back safely to package.json metadata when packaged metadata is missing or invalid", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "fo-build-info-missing-"));
    tempDirs.push(dir);
    const invalidPath = path.join(dir, "forgeorbit-build.json");
    writeFileSync(invalidPath, "{bad json");

    const info = readBuildInfo({ metadataPath: invalidPath, env: {} });
    expect(info.version).toBe(pkg.version);
    expect(info.buildNumber).toBe(pkg.forgeorbitBuildNumber);
    expect(info.macBundleVersion).toBe(macBundleVersion(pkg.forgeorbitBuildNumber));
    expect(info.sourceRevision).toBeNull();
    expect(info.channel).toBeNull();
    expect(info.localBuild).toBe(false);
    expect(info.migrationCeiling).toBe(migrations.at(-1)?.id ?? null);
    expect(info.updatesEnabled).toBe(false);
  });

  test("respects disabled-by-default and override semantics for updatesEnabled", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "fo-build-info-env-"));
    tempDirs.push(dir);
    const absent = path.join(dir, "missing.json");
    expect(readBuildInfo({ metadataPath: absent, env: {} }).updatesEnabled).toBe(false);
    expect(readBuildInfo({ metadataPath: absent, env: { FORGEORBIT_ENABLE_UPDATES: "1" } }).updatesEnabled).toBe(true);
    expect(readBuildInfo({ metadataPath: absent, env: { FORGEORBIT_ENABLE_UPDATES: "1", FORGEORBIT_DISABLE_UPDATES: "1" } }).updatesEnabled).toBe(false);
  });
});
