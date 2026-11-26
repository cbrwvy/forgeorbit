export type BuildChannel = "dev" | "stable";
export interface AppBuildInfo {
  version: string;
  buildNumber: number | null;
  macBundleVersion: string | null;
  sourceRevision: string | null;
  sourceTreeSHA256: string | null;
  sourceDirty: boolean | null;
  channel: BuildChannel | null;
  identifier: string | null;
  localBuild: boolean;
  builtAt: string | null;
  migrationCeiling: string | null;
  updatesEnabled: boolean;
}
export interface BuildMetadata {
  schemaVersion: 1;
  productVersion: string;
  buildNumber: number;
  macBundleVersion: string;
  sourceRevision: string;
  sourceTreeSHA256: string;
  sourceDirty: boolean;
  channel: BuildChannel;
  identifier: string;
  platform: string;
  arch: string;
  builtAt: string;
  /** Personal, ad-hoc packaged app on the existing dev channel. */
  localBuild?: true;
}

// Release SemVer subset: numeric X.Y.Z, no leading zeros/prerelease/build
// suffix. Channels are separate fields; macOS short versions remain numeric.
export function versionParts(version: string): number[] {
  if (!/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(version)) throw new Error("Expected canonical release SemVer X.Y.Z");
  const parts = version.split(".").map(Number);
  if (parts.some(n => !Number.isSafeInteger(n) || n > 9999)) throw new Error("Product version component exceeds 9999");
  return parts;
}
export function compareVersions(a: string, b: string): number {
  const left = versionParts(a), right = versionParts(b);
  for (let i = 0; i < 3; i++) if (left[i] !== right[i]) return left[i]! > right[i]! ? 1 : -1;
  return 0;
}
export function validateBuildNumber(value: unknown): asserts value is number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1 || value > 99_990_000) throw new Error("Build number must be an integer in 1..99990000");
}
/** A global counter mapped to Apple's 4.2.2 digit CFBundleVersion format. */
export function macBundleVersion(value: number): string {
  validateBuildNumber(value);
  const n = value - 1;
  return `${1 + Math.floor(n / 10000)}.${Math.floor(n % 10000 / 100)}.${n % 100}`;
}
export function validateBuildMetadata(value: unknown): BuildMetadata {
  if (!value || typeof value !== "object") throw new Error("Missing ForgeOrbit build metadata");
  const m = value as BuildMetadata;
  versionParts(m.productVersion); validateBuildNumber(m.buildNumber);
  if (m.schemaVersion !== 1 || m.macBundleVersion !== macBundleVersion(m.buildNumber)
    || !/^[a-f0-9]{40}$/.test(m.sourceRevision) || !/^[a-f0-9]{64}$/.test(m.sourceTreeSHA256)
    || typeof m.sourceDirty !== "boolean" || !["dev", "stable"].includes(m.channel)
    || !["app.forgeorbit", "app.forgeorbit.qa"].includes(m.identifier)
    || !["macos", "linux", "win"].includes(m.platform) || !["arm64", "x64"].includes(m.arch)
    || typeof m.builtAt !== "string" || !Number.isFinite(Date.parse(m.builtAt))) throw new Error("Invalid ForgeOrbit build metadata");
  if (m.localBuild !== undefined && (m.localBuild !== true || m.channel !== "dev" || m.identifier !== "app.forgeorbit")) throw new Error("Local builds require production identity on the dev channel");
  if (m.channel === "stable" && (m.sourceDirty || m.identifier !== "app.forgeorbit")) throw new Error("Stable requires clean production source and identity");
  return m;
}

export interface UpdateCandidate {
  version: string;
  hash: string; // Electrobun opaque cache/content token, NOT a SHA-256.
  forgeorbit: BuildMetadata & { artifactManifestSHA256: string };
}
export function updateDecision(local: BuildMetadata, localHash: string, input: unknown): "same" | "upgrade" {
  validateBuildMetadata(local);
  const candidate = input as UpdateCandidate;
  const next = validateBuildMetadata(candidate?.forgeorbit);
  if (local.channel !== "stable" || next.channel !== local.channel || next.identifier !== local.identifier
    || next.platform !== local.platform || next.arch !== local.arch) throw new Error("Update channel/identity/platform mismatch");
  if (candidate.version !== next.productVersion || typeof candidate.hash !== "string" || !candidate.hash || candidate.hash === "dev"
    || !/^[a-f0-9]{64}$/.test(candidate.forgeorbit.artifactManifestSHA256)) throw new Error("Invalid update provenance");
  const order = compareVersions(next.productVersion, local.productVersion);
  if (order < 0 || next.buildNumber < local.buildNumber) throw new Error("Automatic downgrade refused");
  if (order === 0) {
    if (next.buildNumber !== local.buildNumber || candidate.hash !== localHash
      || next.sourceRevision !== local.sourceRevision || next.sourceTreeSHA256 !== local.sourceTreeSHA256) throw new Error("Conflicting stable release identity");
    return "same";
  }
  if (next.buildNumber <= local.buildNumber || candidate.hash === localHash) throw new Error("Non-increasing release build identity");
  return "upgrade";
}
