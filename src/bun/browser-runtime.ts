/**
 * FO-BROWSER04 Bundled Chromium Runtime Resolution.
 * Resolves and validates the packaged Chromium browser runtime inside the .app
 * bundle, ensuring cache-independent operation without global Playwright dependencies.
 */

import { closeSync, existsSync, lstatSync, openSync, readFileSync, readSync } from "node:fs";
import path from "node:path";
import { BrowserSessionError } from "./browser-session-error.ts";

export interface ChromiumDescriptor {
  revision: string;
  browserVersion: string;
  title: string;
}

export type ChromiumValidationFailureCode =
  | "missing_executable"
  | "invalid_resource_path"
  | "corrupted_bundle"
  | "revision_mismatch"
  | "invalid_permissions"
  | "unsupported_architecture";

export interface ChromiumValidationResult {
  valid: boolean;
  code?: ChromiumValidationFailureCode;
  reason?: string;
}

export interface ChromiumRuntimeResolution {
  executablePath: string;
  revision: string;
  browserVersion: string;
  registryDir: string;
  isBundled: boolean;
}

const MACH_O_MH_MAGIC_64 = 0xfeedfacf;
const MACH_O_CPU_TYPE_ARM64 = 0x0100000c;

/**
 * Dynamically resolves expected Chromium revision and version from pinned playwright-core.
 * Does not hardcode revisions.
 */
export function resolveExpectedChromiumDetails(): ChromiumDescriptor {
  const candidates: string[] = [];

  // Packaged app path: <execPath>/../../Resources/app/node_modules/playwright-core/browsers.json
  const packagedDir = path.join(path.dirname(process.execPath), "..", "Resources", "app", "node_modules", "playwright-core", "browsers.json");
  candidates.push(packagedDir);

  // Module resolution from current file
  try {
    const corePkg = path.dirname(import.meta.resolve("playwright-core").replace(/^file:\/\//, ""));
    candidates.push(path.join(corePkg, "browsers.json"));
  } catch {
    // ignore
  }

  // Repository or working directory node_modules fallback
  candidates.push(path.join(process.cwd(), "node_modules", "playwright-core", "browsers.json"));

  for (const candidate of candidates) {
    if (existsSync(candidate)) {
      try {
        const data = JSON.parse(readFileSync(candidate, "utf8")) as {
          browsers?: Array<{ name: string; revision: string; browserVersion?: string; title?: string }>;
        };
        const entry = data.browsers?.find((b) => b.name === "chromium");
        if (entry && entry.revision) {
          return {
            revision: entry.revision,
            browserVersion: entry.browserVersion ?? "unknown",
            title: entry.title ?? "Chrome for Testing",
          };
        }
      } catch {
        // continue
      }
    }
  }

  throw new BrowserSessionError(
    "Playwright browser configuration is missing or unreadable.",
    503,
    "browser_runtime_unavailable",
  );
}

/**
 * True when running inside a packaged macOS application bundle.
 */
export function isPackagedApp(): boolean {
  const execDir = path.dirname(process.execPath);
  const contentsDir = path.dirname(execDir);
  const appDir = path.dirname(contentsDir);
  return (
    path.basename(execDir) === "MacOS" &&
    path.basename(contentsDir) === "Contents" &&
    path.basename(appDir).endsWith(".app")
  );
}

/**
 * Resolved location of the bundled Chromium registry directory.
 */
export function resolveChromiumRegistryDir(): { path: string; source: "packaged" | "override" | "dev" | "global" } {
  // 1. Packaged application bundle
  const packaged = path.join(path.dirname(process.execPath), "..", "Resources", "app", "chromium");
  if (isPackagedApp()) {
    return { path: packaged, source: "packaged" };
  }

  // 2. Unit test override (NODE_ENV=test only)
  if (process.env.NODE_ENV === "test" && process.env.FORGEORBIT_CHROMIUM_DIR) {
    return { path: path.resolve(process.env.FORGEORBIT_CHROMIUM_DIR), source: "override" };
  }

  // 3. Dev checkout under vendor/chromium
  const dev = path.join(process.cwd(), "vendor", "chromium");
  if (existsSync(dev)) {
    return { path: dev, source: "dev" };
  }

  // 4. In dev/tests without local vendor copy, report packaged candidate
  return { path: packaged, source: "packaged" };
}

/**
 * Sub-path inside chromium registry directory to the Chromium executable on macOS Apple Silicon.
 */
export function relativeChromiumExecutablePath(revision: string): string {
  return path.join(
    `chromium-${revision}`,
    "chrome-mac-arm64",
    "Google Chrome for Testing.app",
    "Contents",
    "MacOS",
    "Google Chrome for Testing",
  );
}

/**
 * Validates executable binary, architecture, permissions, and bundle structure.
 */
export function validateChromiumExecutable(
  executablePath: string,
  expectedRevision: string,
  expectedRoot?: string,
): ChromiumValidationResult {
  if (!executablePath || typeof executablePath !== "string") {
    return { valid: false, code: "missing_executable", reason: "Executable path is empty" };
  }

  // 1. Path safety and canonical containment
  if (expectedRoot) {
    try {
      const canonicalRoot = path.resolve(expectedRoot);
      const canonicalTarget = path.resolve(executablePath);
      const rel = path.relative(canonicalRoot, canonicalTarget);
      if (rel.startsWith("..") || path.isAbsolute(rel)) {
        return { valid: false, code: "invalid_resource_path", reason: "Executable path escapes root" };
      }
    } catch (e) {
      return { valid: false, code: "invalid_resource_path", reason: String(e) };
    }
  }

  // 2. Existence
  if (!existsSync(executablePath)) {
    return { valid: false, code: "missing_executable", reason: "Executable does not exist" };
  }

  // 3. Revision check in path
  const expectedDirName = `chromium-${expectedRevision}`;
  if (!executablePath.split(path.sep).includes(expectedDirName)) {
    return {
      valid: false,
      code: "revision_mismatch",
      reason: `Path does not match expected revision directory ${expectedDirName}`,
    };
  }

  // 4. Bundle structure check (Google Chrome for Testing.app)
  const appBundle = path.resolve(executablePath, "../../..");
  const frameworksDir = path.join(appBundle, "Contents", "Frameworks", "Google Chrome for Testing Framework.framework");
  const infoPlist = path.join(appBundle, "Contents", "Info.plist");
  if (!existsSync(frameworksDir) || !existsSync(infoPlist)) {
    return {
      valid: false,
      code: "corrupted_bundle",
      reason: "Missing nested frameworks or Info.plist in application bundle",
    };
  }

  // 5. Executable permissions
  try {
    const stat = lstatSync(executablePath);
    if (!stat.isFile()) {
      return { valid: false, code: "corrupted_bundle", reason: "Executable is not a regular file" };
    }
    if ((stat.mode & 0o111) === 0) {
      return { valid: false, code: "invalid_permissions", reason: "Executable lacks execute permissions" };
    }
  } catch (e) {
    return { valid: false, code: "missing_executable", reason: String(e) };
  }

  // 6. Architecture verification (Mach-O 64-bit arm64)
  try {
    const fd = openSync(executablePath, "r");
    const buf = Buffer.alloc(8);
    const readBytes = readSync(fd, buf, 0, 8, 0);
    closeSync(fd);
    if (readBytes < 8) {
      return { valid: false, code: "corrupted_bundle", reason: "Executable header too short" };
    }
    const magic = buf.readUInt32LE(0);
    const cpuType = buf.readUInt32LE(4);
    if (magic !== MACH_O_MH_MAGIC_64) {
      return {
        valid: false,
        code: "unsupported_architecture",
        reason: `Invalid Mach-O 64 header (magic 0x${magic.toString(16)})`,
      };
    }
    if (cpuType !== MACH_O_CPU_TYPE_ARM64) {
      return {
        valid: false,
        code: "unsupported_architecture",
        reason: `Unsupported CPU architecture (cpuType 0x${cpuType.toString(16)}, expected Apple Silicon arm64)`,
      };
    }
  } catch (e) {
    return { valid: false, code: "unsupported_architecture", reason: `Failed to inspect header: ${e}` };
  }

  return { valid: true };
}

/**
 * Resolves the active Chromium runtime.
 * Inside packaged app: strictly resolves bundled Chromium or throws 503 browser_runtime_unavailable.
 * In dev/test: prefers bundled/vendor Chromium; falls back to verified dev environment if available.
 */
export function resolveChromiumRuntime(): ChromiumRuntimeResolution {
  const descriptor = resolveExpectedChromiumDetails();
  const reg = resolveChromiumRegistryDir();
  const packaged = isPackagedApp();

  const candidateExecutable = path.join(reg.path, relativeChromiumExecutablePath(descriptor.revision));
  const validation = validateChromiumExecutable(candidateExecutable, descriptor.revision, reg.path);

  if (validation.valid) {
    process.env.PLAYWRIGHT_BROWSERS_PATH = reg.path;
    return {
      executablePath: candidateExecutable,
      revision: descriptor.revision,
      browserVersion: descriptor.browserVersion,
      registryDir: reg.path,
      isBundled: true,
    };
  }

  // If running in packaged app, or test override was specified, do NOT fall back to global cache or system browsers.
  if (packaged || reg.source === "override") {
    console.warn(`[browser] Bundled runtime validation failed (${validation.code}): ${validation.reason}`);
    throw new BrowserSessionError(
      "The Playwright Chromium runtime is not installed for this process.",
      503,
      "browser_runtime_unavailable",
    );
  }

  // In development / local testing, if vendor/chromium wasn't prepared,
  // allow development fallback to local Playwright cache if it matches the pinned revision.
  const globalCacheDir = path.join(
    process.env.HOME || "",
    "Library",
    "Caches",
    "ms-playwright",
  );
  const globalCandidate = path.join(globalCacheDir, relativeChromiumExecutablePath(descriptor.revision));
  const globalValidation = validateChromiumExecutable(globalCandidate, descriptor.revision, globalCacheDir);

  if (globalValidation.valid) {
    return {
      executablePath: globalCandidate,
      revision: descriptor.revision,
      browserVersion: descriptor.browserVersion,
      registryDir: globalCacheDir,
      isBundled: false,
    };
  }

  console.warn(`[browser] No valid Chromium runtime found (${validation.code}: ${validation.reason})`);
  throw new BrowserSessionError(
    "The Playwright Chromium runtime is not installed for this process.",
    503,
    "browser_runtime_unavailable",
  );
}
