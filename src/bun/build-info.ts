import { readFileSync } from "node:fs";
import path from "node:path";
import pkg from "../../package.json" with { type: "json" };
import { macBundleVersion, validateBuildMetadata, type AppBuildInfo, type BuildMetadata } from "../shared/release-version.ts";
import { migrations } from "./migrations/index.ts";
import { updatesEnabled } from "./update-policy.ts";

export type { AppBuildInfo };

export function packagedBuildMetadataPath(execPath = process.execPath): string {
  return path.join(path.dirname(execPath), "../Resources/forgeorbit-build.json");
}

function readPackagedMetadata(metadataPath: string): BuildMetadata | null {
  try {
    const raw = JSON.parse(readFileSync(metadataPath, "utf8"));
    return validateBuildMetadata(raw);
  } catch {
    return null;
  }
}

/**
 * Reads runtime build provenance from the packaged bundle's
 * `Contents/Resources/forgeorbit-build.json` when present, falling back to
 * bundled `package.json` metadata in non-packaged CLI/test runs.
 */
export function readBuildInfo(options: {
  execPath?: string;
  metadataPath?: string;
  env?: NodeJS.ProcessEnv;
} = {}): AppBuildInfo {
  const metadataPath = options.metadataPath ?? packagedBuildMetadataPath(options.execPath);
  const metadata = readPackagedMetadata(metadataPath);
  const buildNumber = metadata?.buildNumber ?? pkg.forgeorbitBuildNumber;
  return {
    version: metadata?.productVersion ?? pkg.version,
    buildNumber,
    macBundleVersion: metadata?.macBundleVersion ?? macBundleVersion(buildNumber),
    sourceRevision: metadata?.sourceRevision ?? null,
    sourceTreeSHA256: metadata?.sourceTreeSHA256 ?? null,
    sourceDirty: metadata?.sourceDirty ?? null,
    channel: metadata?.channel ?? null,
    identifier: metadata?.identifier ?? null,
    localBuild: metadata?.localBuild === true,
    builtAt: metadata?.builtAt ?? null,
    migrationCeiling: migrations.at(-1)?.id ?? null,
    updatesEnabled: updatesEnabled(options.env ?? process.env),
  };
}
