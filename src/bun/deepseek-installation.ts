/**
 * FO-DEEPSEEK01: read-only Desktop-carried DSH discovery, including launchd's
 * minimal PATH. Never launches Electron/DSH, loads a profile, reads credentials,
 * probes an API, registers a Harness or adds models to the resource catalog.
 *
 * The assessed 0.2.1-rc.5 ships real headless/ACP interfaces, but its mutable
 * plugin composition, retries and auxiliary model calls are not bound to our
 * execution grants. Keep it outside AgentKind until a bounded adapter exists.
 */
import { accessSync, constants, existsSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import type { HarnessInstallation } from "../shared/harness-installation.ts";
import { DEEPSEEK_ASSESSED_VERSIONS, deepseekPolicyAssessment } from "./deepseek-execution-policy.ts";

const APP = "DeepSeek Harness.app";
const CLI = "Contents/Resources/runtime/cli/bin/dsh";

/** XML plist metadata only. Binary/unreadable/oversized metadata stays unidentified. */
function readSmall(file: string): string {
  if (statSync(file).size > 64 * 1024) throw new Error("Metadata too large");
  return readFileSync(file, "utf8");
}
function plistString(plist: string, key: string): string | null {
  const value = plist.match(new RegExp(`<key>${key}</key>\\s*<string>([^<]*)</string>`))?.[1];
  return value && /^[a-zA-Z0-9.\-]+$/.test(value) ? value : null;
}

export function discoverDeepSeekInstallation(options: {
  env?: NodeJS.ProcessEnv;
  home?: string;
} = {}): HarnessInstallation {
  const env = options.env ?? process.env;
  const override = env.FORGEORBIT_DEEPSEEK_APP_PATH;
  const candidates = override !== undefined
    ? (path.isAbsolute(override) ? [override] : [])
    : [path.join("/Applications", APP), path.join(options.home ?? homedir(), "Applications", APP)];
  const app = candidates.find((p) => existsSync(p));
  const base: HarnessInstallation = {
    id: "deepseek-dsh", provider: "deepseek", label: "DeepSeek Harness",
    path: null, version: null, status: "missing", authentication: "unknown",
    quota: "unknown", models: [], executionSupported: false,
  };
  if (!app) return base;
  const result: HarnessInstallation = { ...base, path: path.join(app, CLI), status: "unidentified" };
  try {
    const plist = readSmall(path.join(app, "Contents/Info.plist"));
    if (plistString(plist, "CFBundleIdentifier") !== "com.deepseek.dsh") return result;
    const version = plistString(plist, "CFBundleShortVersionString");
    if (!version) return result;
    const launcher = readSmall(result.path!);
    accessSync(result.path!, constants.X_OK);
    if (!launcher.startsWith("#!/bin/sh\n") || !launcher.includes("@deepseek-ai/dsh-desktop-host/lib/cli.js")
      || !statSync(path.join(app, "Contents/MacOS/DeepSeek Harness")).isFile()
      || !statSync(path.join(app, "Contents/Resources/app.asar")).isFile()) return result;
    const assessed = (DEEPSEEK_ASSESSED_VERSIONS as readonly string[]).includes(version);
    return { ...result, version, status: assessed ? "execution-unsupported" : "unassessed-version",
      ...(assessed ? { executionPolicy: deepseekPolicyAssessment() } : {}) };
  } catch {
    return result;
  }
}
