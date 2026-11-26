// Stamps the fields Electrobun's Info.plist template leaves out.
// postBuild runs before the inner app is codesigned. postWrap runs after the
// self-extracting wrapper rewrites Info.plist from that same template and
// before the wrapper is codesigned. Patching later would invalidate the seal.
//
// LSMinimumSystemVersion is intentionally absent. Mach-O minos is recorded on
// each binary; a plist key would claim an OS we have not launched on.

import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { macBundleVersion, versionParts } from "../src/shared/release-version.ts";
import { hookMetadata, json } from "./release-metadata.ts";

export const BUNDLE_COPYRIGHT = "© 2026 ForgeOrbit contributors";

function upsertKey(xml: string, key: string, value: string): string {
  const escaped = value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
  const pattern = new RegExp(`<key>${key}<\\/key>\\s*<string>[^<]*<\\/string>`);
  const replacement = `<key>${key}</key>\n    <string>${escaped}</string>`;
  if (pattern.test(xml)) return xml.replace(pattern, replacement);
  if (!xml.includes("</dict>")) throw new Error(`Info.plist has no dict to stamp ${key}`);
  return xml.replace(/<\/dict>\s*<\/plist>\s*$/, `    ${replacement}\n</dict>\n</plist>`);
}

export function patchBundleInfoPlist(xml: string, version: string, buildNumber: number): string {
  try { versionParts(version); } catch { throw new Error(`refusing non-semver bundle version "${version}"`); }
  let next = upsertKey(xml, "CFBundleShortVersionString", version);
  next = upsertKey(next, "CFBundleVersion", macBundleVersion(buildNumber));
  if (!next.includes("<key>CFBundleDisplayName</key>")) {
    const name = next.match(/<key>CFBundleName<\/key>\s*<string>[^<]*<\/string>/);
    if (name) {
      next = next.replace(
        /<\/dict>\s*<\/plist>\s*$/,
        `    ${name[0].replace("CFBundleName", "CFBundleDisplayName")}\n</dict>\n</plist>`,
      );
    }
  }
  next = upsertKey(next, "NSHumanReadableCopyright", BUNDLE_COPYRIGHT);
  if (next.includes("<key>LSMinimumSystemVersion</key>")) {
    throw new Error("Info.plist already declares LSMinimumSystemVersion; this hook does not own that key");
  }
  return next;
}

async function patchFile(plistPath: string, version: string, buildNumber: number): Promise<void> {
  const original = await readFile(plistPath, "utf8");
  const next = patchBundleInfoPlist(original, version, buildNumber);
  if (next !== original) await writeFile(plistPath, next);
  console.log(`[macos-bundle-metadata] ${path.relative(process.cwd(), plistPath)}`);
}

/** Electrobun postBuild / postWrap entry. Wrapper path wins when both are set. */
export async function patchHookBundles(): Promise<void> {
  const metadata = hookMetadata();
  const version = metadata.productVersion;
  if (!version) throw new Error("ELECTROBUN_APP_VERSION is required to stamp Info.plist");
  const wrapper = process.env.ELECTROBUN_WRAPPER_BUNDLE_PATH;
  if (wrapper) {
    await patchFile(path.join(wrapper, "Contents", "Info.plist"), version, metadata.buildNumber);
    await writeFile(path.join(wrapper, "Contents/Resources/forgeorbit-build.json"), json(metadata));
    return;
  }
  const buildDir = process.env.ELECTROBUN_BUILD_DIR;
  const appName = process.env.ELECTROBUN_APP_NAME;
  if (!buildDir || !appName) {
    throw new Error("ELECTROBUN_BUILD_DIR and ELECTROBUN_APP_NAME are required to stamp Info.plist");
  }
  if (process.env.ELECTROBUN_OS && process.env.ELECTROBUN_OS !== "macos") {
    await writeFile(path.join(buildDir, appName, "Resources/forgeorbit-build.json"), json(metadata));
    return;
  }
  await patchFile(path.join(buildDir, `${appName}.app`, "Contents", "Info.plist"), version, metadata.buildNumber);
  await writeFile(path.join(buildDir, `${appName}.app`, "Contents/Resources/forgeorbit-build.json"), json(metadata));
}

if (import.meta.main) {
  await patchHookBundles();
}
