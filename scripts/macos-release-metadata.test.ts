import { expect, test } from "bun:test";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { BUNDLE_COPYRIGHT, patchBundleInfoPlist } from "./macos-bundle-metadata.ts";
import { MACOS_DEPLOYMENT_TARGET, clangDeploymentArgs, machOMinOS, versionAtMost } from "./macos-deployment.ts";

const TEMPLATE = `<?xml version="1.0" encoding="UTF-8"?>
<plist version="1.0"><dict>
    <key>CFBundleIdentifier</key>
    <string>app.forgeorbit</string>
    <key>CFBundleName</key>
    <string>ForgeOrbit</string>
    <key>CFBundleVersion</key>
    <string>1.0.2</string>
</dict></plist>
`;

test("bundle metadata adds the short version, dock title and copyright without a minimum OS claim", () => {
  const once = patchBundleInfoPlist(TEMPLATE, "1.0.2", 4);
  expect(once).toContain("<key>CFBundleShortVersionString</key>\n    <string>1.0.2</string>");
  expect(once).toContain("<key>CFBundleDisplayName</key>\n    <string>ForgeOrbit</string>");
  expect(once).toContain(`<string>${BUNDLE_COPYRIGHT}</string>`);
  expect(once).not.toContain("LSMinimumSystemVersion");
  expect(once).not.toContain("Lunarian");
  const twice = patchBundleInfoPlist(once, "1.0.2", 4);
  expect(twice.match(/CFBundleShortVersionString/g)).toHaveLength(1);
  expect(twice.match(/CFBundleDisplayName/g)).toHaveLength(1);
  expect(patchBundleInfoPlist(once, "1.0.3", 5)).toContain("<string>1.0.3</string>");
  expect(() => patchBundleInfoPlist(TEMPLATE, "1.0", 4)).toThrow("non-semver");
});

test("deployment target comparison rejects host-SDK minos 27", () => {
  expect(MACOS_DEPLOYMENT_TARGET).toBe("14.0");
  expect(clangDeploymentArgs()).toEqual(["-target", "arm64-apple-macos14.0"]);
  expect(versionAtMost("14.0", "14.0")).toBe(true);
  expect(versionAtMost("13.0", "14.0")).toBe(true);
  expect(versionAtMost("14.8.5", "14.0")).toBe(false);
  expect(versionAtMost("27.0", "14.0")).toBe(false);
  expect(versionAtMost("nope", "14.0")).toBe(false);
});

test("clang deployment args stamp minos 14.0 on a tiny binary", async () => {
  if (process.platform !== "darwin" || process.arch !== "arm64") return;
  const dir = mkdtempSync(path.join(tmpdir(), "fo-minos-"));
  const source = path.join(dir, "t.c");
  const bin = path.join(dir, "t");
  writeFileSync(source, "int main(void) { return 0; }\n");
  const compiled = spawnSync("clang", [...clangDeploymentArgs(), "-O2", "-Werror=unguarded-availability", "-o", bin, source], {
    encoding: "utf8",
  });
  expect(compiled.status, compiled.stderr).toBe(0);
  expect(await machOMinOS(bin)).toBe("14.0");
  const ran = spawnSync(bin, [], { encoding: "utf8" });
  expect(ran.status).toBe(0);
});

test("release hooks stamp Info.plist before codesign", () => {
  const config = readFileSync(path.join(import.meta.dir, "../electrobun.config.ts"), "utf8");
  expect(config).toContain('postBuild: "scripts/macos-post-build.ts"');
  expect(config).toContain('postWrap: "scripts/macos-bundle-metadata.ts"');
  const post = readFileSync(path.join(import.meta.dir, "macos-post-build.ts"), "utf8");
  expect(post.indexOf("patchHookBundles")).toBeLessThan(post.indexOf("verify-catalog-package.ts"));
});
