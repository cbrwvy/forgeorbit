import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { expect, test } from "bun:test";
import {
  relativeChromiumExecutablePath,
  resolveChromiumRuntime,
  resolveExpectedChromiumDetails,
  validateChromiumExecutable,
} from "./browser-runtime.ts";
import { BrowserSessionManager } from "./browser-session.ts";
import { BrowserSessionError } from "./browser-session-error.ts";
import { createPlaywrightBrowserEngine } from "./browser-engine.ts";

function createMockBundle(
  root: string,
  revision: string,
  options: {
    corruptFramework?: boolean;
    corruptPlist?: boolean;
    chmod?: number;
    fakeArch?: "arm64" | "x86_64" | "invalid_magic";
    missingBinary?: boolean;
  } = {},
): string {
  const rel = relativeChromiumExecutablePath(revision);
  const execPath = path.join(root, rel);
  const execDir = path.dirname(execPath);
  mkdirSync(execDir, { recursive: true });

  const appDir = path.resolve(execPath, "../../..");
  const contentsDir = path.join(appDir, "Contents");
  mkdirSync(contentsDir, { recursive: true });

  if (!options.corruptPlist) {
    writeFileSync(path.join(contentsDir, "Info.plist"), "<plist></plist>");
  }

  if (!options.corruptFramework) {
    const fwDir = path.join(contentsDir, "Frameworks", "Google Chrome for Testing Framework.framework");
    mkdirSync(fwDir, { recursive: true });
    writeFileSync(path.join(fwDir, "stub"), "framework");
  }

  if (!options.missingBinary) {
    const buf = Buffer.alloc(8);
    const magic = options.fakeArch === "invalid_magic" ? 0x12345678 : 0xfeedfacf;
    const cpuType = options.fakeArch === "x86_64" ? 0x01000007 : 0x0100000c;
    buf.writeUInt32LE(magic, 0);
    buf.writeUInt32LE(cpuType, 4);
    writeFileSync(execPath, buf);
    chmodSync(execPath, options.chmod ?? 0o755);
  }

  return execPath;
}

test("dynamically resolves expected Chromium revision and version without hardcoding", () => {
  const details = resolveExpectedChromiumDetails();
  expect(details.revision).toBe("1234");
  expect(details.browserVersion).toBe("151.0.7922.34");
  expect(details.title).toBe("Chrome for Testing");
});

test("validates a healthy mock arm64 Chromium bundle", () => {
  const tmp = mkdtempSync("/private/tmp/fo-browser-test-valid-");
  try {
    const execPath = createMockBundle(tmp, "1234", { fakeArch: "arm64", chmod: 0o755 });
    const result = validateChromiumExecutable(execPath, "1234", tmp);
    expect(result.valid).toBe(true);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

// Case 1: Bundled executable missing
test("Case 1: bundled executable missing fails clearly", () => {
  const tmp = mkdtempSync("/private/tmp/fo-browser-case1-");
  try {
    const execPath = createMockBundle(tmp, "1234", { missingBinary: true });
    const result = validateChromiumExecutable(execPath, "1234", tmp);
    expect(result.valid).toBe(false);
    expect(result.code).toBe("missing_executable");
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

// Case 2: Browser revision mismatch
test("Case 2: browser revision mismatch fails clearly", () => {
  const tmp = mkdtempSync("/private/tmp/fo-browser-case2-");
  try {
    // Bundle built for 9999, but expected is 1234
    const execPath = createMockBundle(tmp, "9999");
    const result = validateChromiumExecutable(execPath, "1234", tmp);
    expect(result.valid).toBe(false);
    expect(result.code).toBe("revision_mismatch");
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

// Case 3: Invalid executable permissions
test("Case 3: non-executable file permissions fail clearly", () => {
  const tmp = mkdtempSync("/private/tmp/fo-browser-case3-");
  try {
    const execPath = createMockBundle(tmp, "1234", { chmod: 0o644 });
    const result = validateChromiumExecutable(execPath, "1234", tmp);
    expect(result.valid).toBe(false);
    expect(result.code).toBe("invalid_permissions");
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

// Case 4: Invalid resource path
test("Case 4: invalid resource path escaping root fails clearly", () => {
  const tmp = mkdtempSync("/private/tmp/fo-browser-case4-");
  try {
    const other = mkdtempSync("/private/tmp/fo-browser-case4-other-");
    try {
      const execPath = createMockBundle(other, "1234");
      const result = validateChromiumExecutable(execPath, "1234", tmp);
      expect(result.valid).toBe(false);
      expect(result.code).toBe("invalid_resource_path");
    } finally {
      rmSync(other, { recursive: true, force: true });
    }
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

// Case 5: Unsupported architecture
test("Case 5: unsupported CPU architecture (x86_64) or invalid Mach-O magic fails clearly", () => {
  const tmp = mkdtempSync("/private/tmp/fo-browser-case5-");
  try {
    // 5a: x86_64 architecture
    const execX86 = createMockBundle(tmp, "1234", { fakeArch: "x86_64" });
    const resX86 = validateChromiumExecutable(execX86, "1234", tmp);
    expect(resX86.valid).toBe(false);
    expect(resX86.code).toBe("unsupported_architecture");

    // 5b: invalid magic bytes
    const execInvalid = createMockBundle(tmp, "1234", { fakeArch: "invalid_magic" });
    const resInvalid = validateChromiumExecutable(execInvalid, "1234", tmp);
    expect(resInvalid.valid).toBe(false);
    expect(resInvalid.code).toBe("unsupported_architecture");
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

// Case 6: Corrupted or incomplete bundle
test("Case 6: corrupted or incomplete bundle fails clearly", () => {
  const tmpA = mkdtempSync("/private/tmp/fo-browser-case6a-");
  const tmpB = mkdtempSync("/private/tmp/fo-browser-case6b-");
  try {
    // 6a: missing Frameworks
    const execNoFw = createMockBundle(tmpA, "1234", { corruptFramework: true });
    const resNoFw = validateChromiumExecutable(execNoFw, "1234", tmpA);
    expect(resNoFw.valid).toBe(false);
    expect(resNoFw.code).toBe("corrupted_bundle");

    // 6b: missing Info.plist
    const execNoPlist = createMockBundle(tmpB, "1234", { corruptPlist: true });
    const resNoPlist = validateChromiumExecutable(execNoPlist, "1234", tmpB);
    expect(resNoPlist.valid).toBe(false);
    expect(resNoPlist.code).toBe("corrupted_bundle");
  } finally {
    rmSync(tmpA, { recursive: true, force: true });
    rmSync(tmpB, { recursive: true, force: true });
  }
});

// Case 7: Browser process fails to start cleans up profile directory completely
test("Case 7: browser launch failure cleans up temporary profile directory without leaks", async () => {
  const tmp = mkdtempSync("/private/tmp/fo-browser-case7-");
  try {
    // Script that immediately exits 1
    const failingScript = path.join(tmp, "failing-browser.sh");
    writeFileSync(failingScript, "#!/bin/sh\nexit 1\n", { mode: 0o755 });

    const engine = await createPlaywrightBrowserEngine({ executablePath: failingScript });
    const manager = new BrowserSessionManager({
      root: path.join(tmp, "browser-sessions"),
      engine,
    });

    let thrown: unknown;
    try {
      await manager.create();
    } catch (e) {
      thrown = e;
    }

    expect(thrown instanceof BrowserSessionError).toBe(true);
    // Profile directory must be completely cleaned up
    const sessionsDir = path.join(tmp, "browser-sessions");
    const contents = existsSync(sessionsDir) ? readdirSync(sessionsDir) : [];
    // Only registry.json might exist; no leftover brw_ session directory
    expect(contents.filter((f) => f.startsWith("brw_"))).toEqual([]);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test("resolveChromiumRuntime strictly fails with 503 browser_runtime_unavailable under test override when invalid", () => {
  const tmp = mkdtempSync("/private/tmp/fo-browser-test-override-");
  const prevOverride = process.env.FORGEORBIT_CHROMIUM_DIR;
  try {
    process.env.FORGEORBIT_CHROMIUM_DIR = tmp; // empty dir without chromium
    expect(() => resolveChromiumRuntime()).toThrow();
    try {
      resolveChromiumRuntime();
    } catch (e) {
      expect(e instanceof BrowserSessionError).toBe(true);
      expect((e as BrowserSessionError).code).toBe("browser_runtime_unavailable");
      expect((e as BrowserSessionError).status).toBe(503);
    }
  } finally {
    if (prevOverride !== undefined) process.env.FORGEORBIT_CHROMIUM_DIR = prevOverride;
    else delete process.env.FORGEORBIT_CHROMIUM_DIR;
    rmSync(tmp, { recursive: true, force: true });
  }
});
