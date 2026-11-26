import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { compareVersions, validateBuildNumber, versionParts } from "../src/shared/release-version.ts";
import { productIdentity, json } from "./release-metadata.ts";

/** Local, explicit allocation. No build, tag, commit, network or publication. */
export function advanceVersion(project: string, target = "patch") {
  const current = productIdentity(project), parts = versionParts(current.version);
  const next = target === "build" ? current.version : target === "patch" ? `${parts[0]}.${parts[1]}.${parts[2]! + 1}`
    : target === "minor" ? `${parts[0]}.${parts[1]! + 1}.0` : target === "major" ? `${parts[0]! + 1}.0.0` : target;
  versionParts(next);
  if (target !== "build" && compareVersions(next, current.version) <= 0) throw new Error("Product version must increase; use build for a dev-only build increment");
  const buildNumber = current.buildNumber + 1; validateBuildNumber(buildNumber);
  const file = path.join(project, "package.json"), pkg = JSON.parse(readFileSync(file, "utf8"));
  pkg.version = next; pkg.forgeorbitBuildNumber = buildNumber;
  writeFileSync(file, json(pkg));
  return { version: next, buildNumber };
}
if (import.meta.main) console.log(json(advanceVersion(process.cwd(), process.argv[2])));
