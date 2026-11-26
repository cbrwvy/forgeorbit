import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync, lstatSync, readdirSync, readlinkSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import path from "node:path";
import { macBundleVersion, validateBuildMetadata, validateBuildNumber, versionParts, type BuildChannel, type BuildMetadata } from "../src/shared/release-version.ts";

export const sha256 = (bytes: string | Buffer) => createHash("sha256").update(bytes).digest("hex");
export const json = (value: unknown) => JSON.stringify(value, null, 2) + "\n";
export function productIdentity(project: string): { version: string; buildNumber: number } {
  const pkg = JSON.parse(readFileSync(path.join(project, "package.json"), "utf8"));
  versionParts(pkg.version); validateBuildNumber(pkg.forgeorbitBuildNumber);
  return { version: pkg.version, buildNumber: pkg.forgeorbitBuildNumber };
}
function git(project: string, args: string[]): string {
  const out = spawnSync("git", args, { cwd: project, encoding: "utf8" });
  if (out.status !== 0) throw new Error("Build provenance requires a readable local Git checkout");
  return out.stdout.trim();
}
export const sourcePaths = ["package.json", "bun.lock", "electrobun.config.ts", "vite.config.ts", "postcss.config.js", "tailwind.config.js", "tsconfig.json", "src", "scripts", "native", "patches", "resources"];
export function captureBuild(project: string, channel: BuildChannel, identifier: string): BuildMetadata {
  const product = productIdentity(project);
  // Dev-only plain QA copies can read the existing checkout's revision/file
  // list without creating a Git checkout/worktree. Their actual copied inputs
  // are hashed below and are always explicitly marked dirty.
  const sourceRepository = process.env.FORGEORBIT_BUILD_SOURCE_REPOSITORY ?? project;
  if (channel === "stable" && sourceRepository !== project) throw new Error("Stable requires the actual clean source checkout");
  const files = git(sourceRepository, ["ls-files", "-co", "--exclude-standard", "-z", "--", ...sourcePaths]).split("\0").filter(Boolean);
  if (existsSync(path.join(project, "electrobun.base.ts"))) files.push("electrobun.base.ts");
  files.sort();
  const entries = [...new Set(files)].map(file => {
    const full = path.join(project, file), stat = lstatSync(full);
    if (!stat.isFile()) throw new Error(`Non-regular build source: ${file}`);
    return { path: file, mode: stat.mode & 0o777, sha256: sha256(readFileSync(full)) };
  });
  const sourceDirty = sourceRepository !== project || Boolean(git(project, ["status", "--porcelain", "--untracked-files=all", "--", ...sourcePaths]));
  return validateBuildMetadata({ schemaVersion: 1, productVersion: product.version, buildNumber: product.buildNumber,
    macBundleVersion: macBundleVersion(product.buildNumber), sourceRevision: git(sourceRepository, ["rev-parse", "HEAD"]),
    sourceTreeSHA256: sha256(json(entries)), sourceDirty, channel, identifier,
    platform: process.platform === "darwin" ? "macos" : process.platform === "win32" ? "win" : "linux",
    arch: process.arch, builtAt: new Date().toISOString(),
    ...(process.env.FORGEORBIT_LOCAL_BUILD === "1" ? { localBuild: true as const } : {}) });
}
export function hookMetadata(): BuildMetadata {
  const raw = process.env.FORGEORBIT_BUILD_METADATA;
  if (!raw) throw new Error("Use build-native-secure.ts: build metadata missing");
  const supplied = validateBuildMetadata(JSON.parse(raw));
  // SDK watch rebuilds reuse the hook environment; refresh diagnostic dev
  // source metadata on each hook. Distribution builds never use this mode.
  const m = process.env.FORGEORBIT_DEV_WATCH === "1" && supplied.channel === "dev"
    ? captureBuild(process.cwd(), "dev", supplied.identifier) : supplied;
  const product = productIdentity(process.cwd());
  if (Boolean(m.localBuild) !== (process.env.FORGEORBIT_LOCAL_BUILD === "1") || product.version !== m.productVersion || product.buildNumber !== m.buildNumber
    || process.env.ELECTROBUN_APP_VERSION !== m.productVersion || process.env.ELECTROBUN_APP_IDENTIFIER !== m.identifier
    || process.env.ELECTROBUN_BUILD_ENV !== m.channel) throw new Error("Conflicting build/config/hook metadata");
  return m;
}

export interface ArtifactEntry { path: string; mode: number; type: "file" | "directory" | "symlink"; sha256?: string; bytes?: number; target?: string }
/** Detached inventory includes ALL bundle bytes, including signatures and
 * embedded build metadata. No self-reference, timestamps or exclusions. */
export function artifactInventory(root: string): ArtifactEntry[] {
  const entries: ArtifactEntry[] = [];
  function walk(relative: string) {
    const full = path.join(root, relative), s = lstatSync(full);
    const base = { path: relative || ".", mode: s.mode & 0o777 };
    if (s.isSymbolicLink()) {
      const target = readlinkSync(full), resolved = path.resolve(path.dirname(full), target);
      if (path.isAbsolute(target) || !resolved.startsWith(path.resolve(root) + path.sep)) throw new Error("External bundle symlink");
      entries.push({ ...base, type: "symlink", target });
    } else if (s.isDirectory()) {
      entries.push({ ...base, type: "directory" });
      for (const name of readdirSync(full).sort()) walk(relative ? relative + "/" + name : name);
    } else if (s.isFile()) entries.push({ ...base, type: "file", sha256: sha256(readFileSync(full)), bytes: s.size });
    else throw new Error("Special file in artifact");
  }
  walk(""); return entries;
}
export function verifyPackage(app: string, expected?: BuildMetadata): { metadata: BuildMetadata; sdk: Record<string, any> } {
  const resources = path.join(app, process.platform === "darwin" ? "Contents/Resources" : "Resources");
  const metadata = validateBuildMetadata(JSON.parse(readFileSync(path.join(resources, "forgeorbit-build.json"), "utf8")));
  if (expected && json(metadata) !== json(expected)) throw new Error("Packaged source/build provenance mismatch");
  const sdk = JSON.parse(readFileSync(path.join(resources, "version.json"), "utf8"));
  if (sdk.version !== metadata.productVersion || sdk.channel !== metadata.channel || sdk.identifier !== metadata.identifier
    || typeof sdk.hash !== "string" || !sdk.hash || (metadata.channel === "dev" ? sdk.hash !== "dev" : sdk.hash === "dev")) throw new Error("Packaged Electrobun version mismatch");
  if (metadata.platform === "macos") {
    verifyMacPlist(app, metadata);
  }
  return { metadata, sdk };
}
function verifyMacPlist(app: string, metadata: BuildMetadata) {
  const result = spawnSync("/usr/bin/plutil", ["-convert", "json", "-o", "-", path.join(app, "Contents/Info.plist")], { encoding: "utf8" });
  if (result.status !== 0) throw new Error("Invalid macOS package plist");
  const plist = JSON.parse(result.stdout);
  for (const [key, value] of Object.entries({ CFBundleShortVersionString: metadata.productVersion, CFBundleVersion: metadata.macBundleVersion, CFBundleIdentifier: metadata.identifier })) {
    if (plist[key] !== value) throw new Error(`Packaged ${key} mismatch`);
  }
}
export function writeProvenance(app: string, out: string, metadata: BuildMetadata) {
  const verified = verifyPackage(app, metadata), entries = artifactInventory(app), manifest = json({ schemaVersion: 1, entries });
  mkdirSync(out, { recursive: true });
  const artifactManifestSHA256 = sha256(manifest);
  writeFileSync(path.join(out, "forgeorbit-artifact-manifest.json"), manifest);
  const provenance = { schemaVersion: 1, metadata, sdk: verified.sdk, artifactManifestSHA256 };
  writeFileSync(path.join(out, "forgeorbit-provenance.json"), json(provenance));
  return provenance;
}
export function verifyProvenance(app: string, out: string) {
  const receipt = JSON.parse(readFileSync(path.join(out, "forgeorbit-provenance.json"), "utf8"));
  const actual = verifyPackage(app, receipt.metadata);
  if (json(actual.sdk) !== json(receipt.sdk)) throw new Error("SDK provenance mismatch");
  const manifest = readFileSync(path.join(out, "forgeorbit-artifact-manifest.json"), "utf8");
  if (sha256(manifest) !== receipt.artifactManifestSHA256 || manifest !== json({ schemaVersion: 1, entries: artifactInventory(app) })) throw new Error("Artifact inventory/provenance mismatch");
  return receipt;
}

export function verifyWrapper(app: string, metadata: BuildMetadata, sdkHash: string) {
  const resources = path.join(app, "Contents/Resources");
  if (json(JSON.parse(readFileSync(path.join(resources, "forgeorbit-build.json"), "utf8"))) !== json(metadata)) throw new Error("Wrapper provenance mismatch");
  const sdk = JSON.parse(readFileSync(path.join(resources, "metadata.json"), "utf8"));
  if (sdk.hash !== sdkHash || sdk.identifier !== metadata.identifier || sdk.channel !== metadata.channel) throw new Error("Wrapper SDK identity mismatch");
  verifyMacPlist(app, metadata);
}

/** Verify the local shipping bytes as well as the runtime bundle receipt. */
export function verifyShipping(artifacts: string, receiptDir: string) {
  const original = JSON.parse(readFileSync(path.join(receiptDir, "forgeorbit-provenance.json"), "utf8"));
  const shipped = JSON.parse(readFileSync(path.join(artifacts, "forgeorbit-provenance.json"), "utf8"));
  const { shipped: files, ...base } = shipped;
  if (json(base) !== json(original) || !Array.isArray(files) || !files.length) throw new Error("Shipping provenance mismatch");
  if (readFileSync(path.join(artifacts, "forgeorbit-artifact-manifest.json"), "utf8") !== readFileSync(path.join(receiptDir, "forgeorbit-artifact-manifest.json"), "utf8")) throw new Error("Shipping manifest mismatch");
  const m = validateBuildMetadata(original.metadata);
  const prefix = `${m.channel}-${m.platform}-${m.arch}`;
  const names = new Set<string>();
  for (const file of files) {
    if (typeof file.name !== "string" || file.name !== path.basename(file.name) || names.has(file.name)
      || !/^[a-f0-9]{64}$/.test(file.sha256) || sha256(readFileSync(path.join(artifacts, file.name))) !== file.sha256) throw new Error("Shipping bytes/hash mismatch");
    names.add(file.name);
  }
  if (!names.has(`ForgeOrbit-${m.arch}.dmg`) || !names.has(`${prefix}-ForgeOrbit.app.tar.zst`)) throw new Error("Shipping artifact missing");
  const feed = JSON.parse(readFileSync(path.join(artifacts, `${prefix}-update.json`), "utf8"));
  if (feed.version !== m.productVersion || feed.hash !== original.sdk.hash || feed.platform !== m.platform || feed.arch !== m.arch
    || json(feed.forgeorbit) !== json({ ...m, artifactManifestSHA256: original.artifactManifestSHA256 })) throw new Error("Shipping feed mismatch");
  return shipped;
}
