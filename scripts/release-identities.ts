import { mkdirSync, readdirSync, readFileSync, writeFileSync, rmdirSync } from "node:fs";
import path from "node:path";
import { validateBuildMetadata, compareVersions, type BuildMetadata } from "../src/shared/release-version.ts";
import { json } from "./release-metadata.ts";

/** Local append-only reservations. Failed attempts consume their identity.
 * Back up this directory; never put it in artifacts/ (SDK replaces that dir). */
export function reserveStable(dir: string, metadata: BuildMetadata): string {
  validateBuildMetadata(metadata);
  if (metadata.channel !== "stable") throw new Error("Only stable identities are reserved");
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const lock = dir + ".lock";
  mkdirSync(lock, { mode: 0o700 }); // Fail closed on concurrent/stale owner.
  try {
  const identity = `${metadata.identifier}-${metadata.platform}-${metadata.arch}-${metadata.productVersion}`;
  const file = path.join(dir, identity + ".json");
  // Build counter is globally increasing across versions/platforms. The local
  // single-owner workflow serializes builds; exclusive creation also rejects
  // duplicate stable identities even before an artifact exists.
  for (const name of readdirSync(dir)) {
    if (!name.endsWith(".json")) throw new Error("Unknown release reservation entry");
    const prior = validateBuildMetadata(JSON.parse(readFileSync(path.join(dir, name), "utf8")));
    if (prior.productVersion === metadata.productVersion && prior.identifier === metadata.identifier
      && prior.platform === metadata.platform && prior.arch === metadata.arch) throw new Error("Stable product version already reserved; use a new version/build");
    if (prior.buildNumber >= metadata.buildNumber) throw new Error("Build number does not exceed local release history");
    if (prior.identifier === metadata.identifier && prior.platform === metadata.platform && prior.arch === metadata.arch
      && compareVersions(prior.productVersion, metadata.productVersion) >= 0) throw new Error("Stable product version must increase");
  }
  writeFileSync(file, json(metadata), { flag: "wx", mode: 0o600 });
  return file;
  } finally { rmdirSync(lock); }
}
