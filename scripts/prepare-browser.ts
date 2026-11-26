#!/usr/bin/env bun
/**
 * FO-BROWSER04 Build-time Chromium Runtime Preparation.
 * Copies the pinned Chromium browser revision from local Playwright cache into
 * vendor/chromium for packaging into the ForgeOrbit application bundle.
 */

import { existsSync, lstatSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { homedir, userInfo } from "node:os";
import {
  relativeChromiumExecutablePath,
  resolveExpectedChromiumDetails,
  validateChromiumExecutable,
} from "../src/bun/browser-runtime.ts";

const repoRoot = path.resolve(import.meta.dir, "..");
const vendorDir = path.join(repoRoot, "vendor", "chromium");

export function prepareBundledBrowser(): {
  vendorDir: string;
  revision: string;
  browserVersion: string;
  executablePath: string;
  sizeBytes: number;
} {
  const details = resolveExpectedChromiumDetails();
  mkdirSync(vendorDir, { recursive: true, mode: 0o755 });
  const destRevisionDir = path.join(vendorDir, `chromium-${details.revision}`);
  const destExecutable = path.join(vendorDir, relativeChromiumExecutablePath(details.revision));

  // If vendor/chromium is already present and valid, this is a fast no-op.
  if (existsSync(destExecutable)) {
    const existing = validateChromiumExecutable(destExecutable, details.revision, vendorDir);
    if (existing.valid) {
      const duResult = spawnSync("/usr/bin/du", ["-sk", destRevisionDir], { encoding: "utf8" });
      const sizeKb = Number(duResult.stdout?.trim().split(/\s+/)[0]) || 0;
      const sizeBytes = sizeKb * 1024;
      console.log(
        `[vendor-browser] Chromium revision ${details.revision} (${details.browserVersion}) verified in vendor/chromium (${(sizeBytes / (1024 * 1024)).toFixed(1)} MB)`,
      );
      return {
        vendorDir,
        revision: details.revision,
        browserVersion: details.browserVersion,
        executablePath: destExecutable,
        sizeBytes,
      };
    }
    console.log(`[vendor-browser] Existing vendor/chromium is invalid (${existing.code}), refreshing...`);
    rmSync(destRevisionDir, { recursive: true, force: true });
  }

  // Find source Playwright installation
  const candidates: string[] = [];
  if (process.env.FORGEORBIT_PLAYWRIGHT_CACHE) {
    candidates.push(path.join(process.env.FORGEORBIT_PLAYWRIGHT_CACHE, `chromium-${details.revision}`));
  }
  if (process.env.FORGEORBIT_BUILD_SOURCE_REPOSITORY) {
    candidates.push(path.join(process.env.FORGEORBIT_BUILD_SOURCE_REPOSITORY, "vendor", "chromium", `chromium-${details.revision}`));
  }
  const realHome = (() => {
    try {
      return userInfo().homedir;
    } catch {
      return homedir();
    }
  })();
  candidates.push(path.join(realHome, "Library", "Caches", "ms-playwright", `chromium-${details.revision}`));
  if (process.env.HOME && process.env.HOME !== realHome) {
    candidates.push(path.join(process.env.HOME, "Library", "Caches", "ms-playwright", `chromium-${details.revision}`));
  }

  let sourceRoot: string | null = null;
  let sourceExecutable: string | null = null;
  for (const cand of candidates) {
    const execCand = path.join(
      cand,
      "chrome-mac-arm64",
      "Google Chrome for Testing.app",
      "Contents",
      "MacOS",
      "Google Chrome for Testing",
    );
    if (existsSync(cand) && existsSync(execCand)) {
      const val = validateChromiumExecutable(execCand, details.revision, cand);
      if (val.valid) {
        sourceRoot = cand;
        sourceExecutable = execCand;
        break;
      }
    }
  }

  if (!sourceRoot || !sourceExecutable) {
    throw new Error(
      `[vendor-browser] Required Chromium revision ${details.revision} (version ${details.browserVersion}) is not installed in Playwright cache. Run 'bunx playwright install chromium' first.`,
    );
  }

  console.log(`[vendor-browser] Copying Chromium ${details.revision} (${details.browserVersion}) from ${sourceRoot} to ${destRevisionDir}...`);
  const cpResult = spawnSync("/bin/cp", ["-cRp", sourceRoot, destRevisionDir], {
    encoding: "utf8",
  });
  if (cpResult.status !== 0) {
    throw new Error(`[vendor-browser] Failed to copy Chromium: ${cpResult.stderr || cpResult.stdout}`);
  }

  // Ad-hoc sign the nested .app bundle so local bundle verification succeeds
  const appBundle = path.resolve(destExecutable, "../../..");
  const signResult = spawnSync("/usr/bin/codesign", ["-s", "-", "--force", "--deep", appBundle], {
    encoding: "utf8",
  });
  if (signResult.status !== 0) {
    console.warn(`[vendor-browser] Warning: ad-hoc re-signing returned code ${signResult.status}: ${signResult.stderr}`);
  }

  // Validate the resulting destination
  const postValidation = validateChromiumExecutable(destExecutable, details.revision, vendorDir);
  if (!postValidation.valid) {
    throw new Error(
      `[vendor-browser] Vendored Chromium failed validation (${postValidation.code}): ${postValidation.reason}`,
    );
  }

  // Calculate disk size
  const duResult = spawnSync("/usr/bin/du", ["-sk", destRevisionDir], { encoding: "utf8" });
  const sizeKb = Number(duResult.stdout?.trim().split(/\s+/)[0]) || 0;
  const sizeBytes = sizeKb * 1024;

  const metadata = {
    revision: details.revision,
    browserVersion: details.browserVersion,
    executable: path.relative(vendorDir, destExecutable),
    sizeBytes,
    preparedAt: new Date().toISOString(),
    arch: "arm64",
  };
  writeFileSync(path.join(vendorDir, ".browser-metadata.json"), JSON.stringify(metadata, null, 2));

  console.log(
    `[vendor-browser] Chromium revision ${details.revision} (${details.browserVersion}) ready in vendor/chromium (${(sizeBytes / (1024 * 1024)).toFixed(1)} MB)`,
  );

  return {
    vendorDir,
    revision: details.revision,
    browserVersion: details.browserVersion,
    executablePath: destExecutable,
    sizeBytes,
  };
}

if (import.meta.main) {
  try {
    prepareBundledBrowser();
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
}
