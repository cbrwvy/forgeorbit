#!/usr/bin/env bun
// Historical helper. Electrobun's template still omits CFBundleShortVersionString.
// The supported path is scripts/macos-post-build.ts (postBuild, before the
// inner codesign) and scripts/macos-bundle-metadata.ts (postWrap, before the
// wrapper codesign). Rebuilding a DMG here used to copy a patched plist into
// a new unsigned disk image and drop the notarization ticket. This command
// no longer does that.
//
// Optional: patch one already-written unsigned plist in place.
//   bun scripts/patch-info-plist.ts path/to/Info.plist
// Refuses when codesign reports a Developer ID authority. Ad-hoc linker
// signatures are not a release seal; those plists can still be restamped
// before a real codesign.

import { readFile, writeFile } from "node:fs/promises";
import { patchBundleInfoPlist } from "./macos-bundle-metadata.ts";

const target = process.argv[2];
if (!target) {
  console.log("[patch-info-plist] release builds stamp Info.plist in postBuild and postWrap. No DMG is rewritten.");
  process.exit(0);
}

const signed = Bun.spawnSync(["codesign", "-dv", target], { stdout: "pipe", stderr: "pipe" });
const details = new TextDecoder().decode(signed.stderr) + new TextDecoder().decode(signed.stdout);
if (signed.exitCode === 0 && /Authority=Developer ID/.test(details)) {
  console.error("[patch-info-plist] refusing to edit a Developer ID signed plist. Restamp before codesign.");
  process.exit(1);
}

const { version, forgeorbitBuildNumber } = await Bun.file("package.json").json();
const next = patchBundleInfoPlist(await readFile(target, "utf8"), version, forgeorbitBuildNumber);
await writeFile(target, next);
console.log(`[patch-info-plist] ${target}`);
