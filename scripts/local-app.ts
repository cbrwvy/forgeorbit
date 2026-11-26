import { readFileSync, writeFileSync, renameSync, existsSync } from "node:fs";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { validateBuildMetadata, type BuildMetadata } from "../src/shared/release-version.ts";
import { json } from "./release-metadata.ts";

/** Missing PostCSS/Tailwind config otherwise produces a successful but
 * unstyled Vite build. Refuse unprocessed styles before accepting a package. */
export function verifyLocalStyles(dist: string): void {
  const html = readFileSync(path.join(dist, "index.html"), "utf8");
  const css = [...html.matchAll(/href="([^"]+\.css)"/g)];
  if (!css.length) throw new Error("Missing packaged stylesheet");
  for (const [, href] of css) {
    const contents = readFileSync(path.join(dist, href!.replace(/^\//, "")), "utf8");
    if (/@(?:tailwind|apply)\b/.test(contents) || !/\.flex\s*\{\s*display:\s*flex/.test(contents)) throw new Error("Unprocessed packaged Tailwind styles");
  }
}

export function localPlist(xml: string): string {
  for (const key of ["CFBundleName", "CFBundleDisplayName"]) {
    const pattern = new RegExp(`<key>${key}</key>\\s*<string>[^<]*</string>`);
    if (!pattern.test(xml)) throw new Error(`Missing local package ${key}`);
    xml = xml.replace(pattern, `<key>${key}</key>\n    <string>ForgeOrbit</string>`);
  }
  return xml;
}

/** Finalize only personal dev output; stable signing gates are separate. */
export function sealLocalApp(app: string, metadata: BuildMetadata): string {
  validateBuildMetadata(metadata);
  if (!metadata.localBuild || metadata.channel !== "dev" || metadata.identifier !== "app.forgeorbit") throw new Error("Not a personal local package");
  const final = path.join(path.dirname(app), "ForgeOrbit.app");
  if (existsSync(final)) throw new Error("Local output already exists");
  renameSync(app, final);
  const plist = path.join(final, "Contents/Info.plist"), version = path.join(final, "Contents/Resources/version.json");
  writeFileSync(plist, localPlist(readFileSync(plist, "utf8")));
  const sdk = JSON.parse(readFileSync(version, "utf8"));
  if (sdk.channel !== "dev" || sdk.hash !== "dev" || sdk.identifier !== "app.forgeorbit") throw new Error("Conflicting local SDK metadata");
  writeFileSync(version, json({ ...sdk, name: "ForgeOrbit" }));
  for (const args of [["--force", "--deep", "--sign", "-", final], ["--verify", "--deep", "--strict", final]]) {
    const result = spawnSync("/usr/bin/codesign", args, { encoding: "utf8" });
    if (result.status !== 0) throw new Error("Local ad-hoc seal failed: " + result.stderr);
  }
  console.log("[FO-LOCAL01] ad-hoc bundle seal verified; dev channel, no notarization");
  return final;
}
