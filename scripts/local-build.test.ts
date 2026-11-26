import { expect, test } from "bun:test";
import { localPlist, verifyLocalStyles } from "./local-app.ts";
import { mkdtempSync, writeFileSync } from "node:fs";
import { validateBuildMetadata, type BuildMetadata } from "../src/shared/release-version.ts";
import { stableBuildGates } from "./stable-build-gates.ts";

const local: BuildMetadata = { schemaVersion: 1, productVersion: "1.0.3", buildNumber: 4, macBundleVersion: "1.0.3", sourceRevision: "a".repeat(40), sourceTreeSHA256: "b".repeat(64), sourceDirty: true, channel: "dev", identifier: "app.forgeorbit", platform: "macos", arch: "arm64", builtAt: "2026-10-29T00:00:00Z", localBuild: true };
test("personal package remains dev with production identity and cannot enter stable acceptance", () => {
  expect(validateBuildMetadata(local)).toBe(local);
  expect(() => validateBuildMetadata({ ...local, channel: "stable", sourceDirty: false })).toThrow("Local builds");
  expect(() => validateBuildMetadata({ ...local, identifier: "app.forgeorbit.qa" })).toThrow("Local builds");
  expect(() => stableBuildGates(local, { codesign: false, notarize: false }, {})).toThrow();
});
test("package acceptance refuses missing or unprocessed Tailwind output", () => {
  const root = mkdtempSync("/private/tmp/fo-local-css-");
  writeFileSync(root + "/index.html", '<link rel="stylesheet" href="/style.css">');
  writeFileSync(root + "/style.css", "@tailwind utilities; body{@apply bg-background}");
  expect(() => verifyLocalStyles(root)).toThrow("Unprocessed");
  writeFileSync(root + "/style.css", ".flex{display:flex}");
  expect(() => verifyLocalStyles(root)).not.toThrow();
  writeFileSync(root + "/index.html", "<html></html>");
  expect(() => verifyLocalStyles(root)).toThrow("Missing");
});
test("local names are restamped before sealing while version, executable and identity stay intact", () => {
  const plist = '<plist><dict><key>CFBundleName</key><string>ForgeOrbit-dev</string><key>CFBundleDisplayName</key><string>ForgeOrbit-dev</string><key>CFBundleIdentifier</key><string>app.forgeorbit</string><key>CFBundleVersion</key><string>1.0.3</string><key>CFBundleExecutable</key><string>launcher</string></dict></plist>';
  const next = localPlist(plist);
  expect(next).not.toContain("ForgeOrbit-dev");
  expect(next).toContain("app.forgeorbit"); expect(next).toContain("1.0.3"); expect(next).toContain("launcher");
  expect(localPlist(next)).toBe(next);
  expect(() => localPlist("<plist></plist>")).toThrow("Missing");
});
test("production URL-scheme dictionaries do not capture top-level version/display fields", async () => {
  const { patchBundleInfoPlist } = await import("./macos-bundle-metadata.ts");
  const { spawnSync } = await import("node:child_process");
  const root = mkdtempSync("/private/tmp/fo-local-plist-");
  const nested = '<plist><dict><key>CFBundleName</key><string>ForgeOrbit</string><key>CFBundleURLTypes</key><array><dict><key>CFBundleURLSchemes</key><array><string>forgeorbit</string><string>agetor</string></array></dict></array></dict></plist>';
  writeFileSync(root + "/Info.plist", patchBundleInfoPlist(nested, "1.0.3", 4));
  const result = spawnSync("/usr/bin/plutil", ["-convert", "json", "-o", "-", root + "/Info.plist"], { encoding: "utf8" });
  expect(result.status).toBe(0); const plist = JSON.parse(result.stdout);
  expect(plist.CFBundleShortVersionString).toBe("1.0.3"); expect(plist.CFBundleVersion).toBe("1.0.3"); expect(plist.CFBundleDisplayName).toBe("ForgeOrbit");
  expect(plist.CFBundleURLTypes[0].CFBundleURLSchemes).toEqual(["forgeorbit", "agetor"]);
  expect(plist.CFBundleURLTypes[0].CFBundleShortVersionString).toBeUndefined();
});
