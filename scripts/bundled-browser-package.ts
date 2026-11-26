/**
 * FO-BROWSER04 Bundled Browser Package Hook.
 * Installs and verifies the packaged Chromium runtime inside Contents/Resources/app/chromium.
 */

import { existsSync, mkdirSync, rmSync } from "node:fs";
import { spawnSync } from "node:child_process";
import path from "node:path";
import {
  relativeChromiumExecutablePath,
  resolveExpectedChromiumDetails,
  validateChromiumExecutable,
} from "../src/bun/browser-runtime.ts";

export function installBundledBrowser(appCode: string): void {
  const details = resolveExpectedChromiumDetails();
  const repoRoot = path.resolve(import.meta.dir, "..");
  const vendorChromium = path.join(repoRoot, "vendor", "chromium");
  const destChromium = path.join(appCode, "chromium");

  if (!existsSync(vendorChromium)) {
    throw new Error(
      `[FO-BROWSER04] Cannot install bundled browser: vendor/chromium is missing. Run 'bun scripts/prepare-browser.ts' first.`,
    );
  }

  const destExecutable = path.join(destChromium, relativeChromiumExecutablePath(details.revision));
  if (existsSync(destExecutable)) {
    const existing = validateChromiumExecutable(destExecutable, details.revision, destChromium);
    if (existing.valid) {
      console.log("[FO-BROWSER04] Bundled Chromium already installed and valid in package.");
      return;
    }
    rmSync(destChromium, { recursive: true, force: true });
  }

  mkdirSync(appCode, { recursive: true });
  console.log(`[FO-BROWSER04] Installing bundled Chromium runtime into ${destChromium}...`);
  const cp = spawnSync("/bin/cp", ["-cRp", vendorChromium, destChromium], { encoding: "utf8" });
  if (cp.status !== 0) {
    throw new Error(`[FO-BROWSER04] Failed to copy Chromium to ${destChromium}: ${cp.stderr || cp.stdout}`);
  }

  // Ensure ad-hoc signature on nested .app bundle is sealed
  const appBundle = path.resolve(destExecutable, "../../..");
  const signResult = spawnSync("/usr/bin/codesign", ["-s", "-", "--force", "--deep", appBundle], { encoding: "utf8" });
  if (signResult.status !== 0) {
    console.warn(`[FO-BROWSER04] Warning: ad-hoc signing returned code ${signResult.status}: ${signResult.stderr}`);
  }

  verifyBundledBrowserPackage(appCode);
  console.log("[FO-BROWSER04] Bundled Chromium installed and verified in package.");
}

export function verifyBundledBrowserPackage(appCode: string): void {
  const details = resolveExpectedChromiumDetails();
  const destChromium = path.join(appCode, "chromium");
  const destExecutable = path.join(destChromium, relativeChromiumExecutablePath(details.revision));

  const validation = validateChromiumExecutable(destExecutable, details.revision, destChromium);
  if (!validation.valid) {
    throw new Error(
      `[FO-BROWSER04] Bundled Chromium package verification failed (${validation.code}): ${validation.reason} at ${destExecutable}`,
    );
  }
}
