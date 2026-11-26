import { spawnSync } from "node:child_process";
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { captureBuild, json, sha256, writeProvenance, verifyWrapper, verifyShipping } from "./release-metadata.ts";
import { reserveStable } from "./release-identities.ts";
import { runtimeApp } from "./inspect-built-app.ts";
import { assertUpdaterContract } from "./updater-sdk-contract.ts";
import { stableBuildGates } from "./stable-build-gates.ts";
import { sealLocalApp } from "./local-app.ts";
import { acceptNativeRpcBuild } from "./native-rpc-build-acceptance.ts";
import { verifyNativeLifecyclePackage } from "./electrobun-lifecycle.ts";
import { verifyBackupWorkerPackage } from "./backup-worker-package.ts";
import { verifyBundledBrowserPackage } from "./bundled-browser-package.ts";
import { prepareBrainModel, verifyBrainModelPackage } from "./prepare-brain-model.ts";

// Use the existing SDK builder, then independently accept its package. Never
// invokes SDK dev/launch or the potentially downloading CJS bootstrap wrapper.
const args = process.argv.slice(2);
if (args.length > 1 || args.some(arg => !/^--env=(dev|stable)$/.test(arg))) {
  throw new Error("Expected only --env=dev|stable");
}
const project = process.cwd();
assertUpdaterContract(project);
prepareBrainModel(project);
const { default: config } = await import(path.join(project, "electrobun.config.ts"));
const channel = (args[0]?.slice("--env=".length) || "dev") as "dev" | "stable";
const metadata = captureBuild(project, channel, config.app.identifier);
if (config.app.version !== metadata.productVersion) throw new Error("Config/product version mismatch");
if (channel === "stable") {
  stableBuildGates(metadata, config.build.mac, process.env);
  reserveStable(path.join(project, ".forgeorbit-release/identities"), metadata);
}
const cli = path.join(project, "node_modules/electrobun/bin", process.platform === "win32" ? "electrobun.exe" : "electrobun");
const result = spawnSync(cli, ["build", ...args], { cwd: project, env: { ...process.env, FORGEORBIT_BUILD_METADATA: JSON.stringify(metadata) }, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
process.stdout.write(result.stdout || "");
process.stderr.write(result.stderr || "");
if (result.error) throw result.error;
if (result.status !== 0) throw new Error("NATIVE-003: SDK build failed; no accepted artifact");
const log = result.stdout + result.stderr;
// Reject fallback/absent hooks before trusting any SDK-generated output path.
if (/failed to load config|using default config/i.test(log)
  || !log.includes("[FO-NATIVE003] socket transform applied") || !log.includes("[FO-NATIVE003] package verified")) {
  throw new Error("NATIVE-003: config fallback or security receipts missing; no accepted artifact");
}

const platform = process.platform === "darwin" ? "macos" : process.platform === "win32" ? "win" : "linux";
const output = path.resolve(project, config.build?.buildFolder || "build", `${channel}-${platform}-${process.arch}`);
const packages = readdirSync(output, { withFileTypes: true }).filter(entry => entry.isDirectory()
  && (platform === "macos" ? entry.name.endsWith(".app") : entry.name === `${config.app.name}${channel === "stable" ? "" : `-${channel}`}`));
if (packages.length !== 1) throw new Error("NATIVE-003: package output missing/ambiguous");
const packaged = path.join(output, packages[0]!.name);
let inspected = platform === "macos" ? runtimeApp(packaged, project) : packaged;
const appCode = path.join(inspected, ...(platform === "macos" ? ["Contents"] : []), "Resources/app");
console.log("[FO-NATIVE003] build accepted", JSON.stringify(acceptNativeRpcBuild(log, appCode)));
if (!log.includes("[FO-NATIVE004] Utils transform applied") || !log.includes("[FO-NATIVE004] package verified")) {
  throw new Error("NATIVE-004: lifecycle receipts missing; no accepted artifact");
}
verifyNativeLifecyclePackage(appCode);
console.log("[FO-NATIVE004] build accepted");
verifyBackupWorkerPackage(appCode);
console.log("[FO-BACKUP-RUNNER] build accepted");
verifyBundledBrowserPackage(appCode);
console.log("[FO-BROWSER04] build accepted");
verifyBrainModelPackage(appCode);
if (process.env.FORGEORBIT_NATIVE_QA_ROOT) {
  const { verifyQaStoragePackage } = await import("./electrobun-qa-storage.ts");
  if (!log.includes("[FO-NATIVE005] QA storage transform applied")
    || !log.includes("[FO-NATIVE005] QA storage package verified")) {
    throw new Error("NATIVE-005: QA storage receipts missing; no accepted artifact");
  }
  verifyQaStoragePackage(path.dirname(path.dirname(appCode)), process.env.FORGEORBIT_NATIVE_QA_ROOT);
  console.log("[FO-NATIVE005] QA storage build accepted");
}

if (process.env.FORGEORBIT_ISOLATED_NATIVE_STORAGE === "1") {
  const { verifyIsolatedStoragePackage } = await import("./electrobun-qa-storage.ts");
  if (!log.includes("[FO-NATIVE005] QA storage transform applied")) throw new Error("NATIVE-ISOLATED: storage transform receipt missing; no accepted artifact");
  verifyIsolatedStoragePackage(path.dirname(path.dirname(appCode)));
  console.log("[FO-NATIVE-ISOLATED] isolated WebKit store build accepted (production identity)");
}

const after = captureBuild(project, channel, config.app.identifier);
if (json({ ...after, builtAt: metadata.builtAt }) !== json(metadata)) throw new Error("Source inputs changed during build");
if (metadata.localBuild) inspected = sealLocalApp(packaged, metadata);
const provenance = writeProvenance(inspected, output, metadata);
if (channel === "stable") {
  if (/skipping codesign|skipping notarization/.test(log)) throw new Error("Stable signing/notarization receipts missing");
  verifyWrapper(packaged, metadata, provenance.sdk.hash);
  // Canonical DMG filename must be settled before recording shipping hashes.
  await import("./rename-dmg.ts");
  const artifacts = path.resolve(project, config.build?.artifactFolder || "artifacts");
  const feed = path.join(artifacts, `${channel}-${platform}-${process.arch}-update.json`);
  const body = JSON.parse(readFileSync(feed, "utf8"));
  if (body.version !== metadata.productVersion || body.hash !== provenance.sdk.hash || body.platform !== metadata.platform || body.arch !== metadata.arch) throw new Error("SDK feed/package mismatch");
  const tar = path.join(artifacts, `${channel}-${platform}-${process.arch}-${config.app.name}.app.tar.zst`);
  const shipped = readdirSync(artifacts).filter(n => n.endsWith(".dmg") || n.endsWith(".tar.zst")).map(name => ({name, sha256: sha256(readFileSync(path.join(artifacts, name)))}));
  if (!shipped.some(f => path.join(artifacts, f.name) === tar)) throw new Error("Update archive missing");
  writeFileSync(feed, json({ ...body, forgeorbit: { ...metadata, artifactManifestSHA256: provenance.artifactManifestSHA256 } }));
  writeFileSync(path.join(artifacts, "forgeorbit-provenance.json"), json({ ...provenance, shipped }));
  writeFileSync(path.join(artifacts, "forgeorbit-artifact-manifest.json"), readFileSync(path.join(output, "forgeorbit-artifact-manifest.json")));
  verifyShipping(artifacts, output);
}
console.log("[FO-VERSION01] package provenance accepted", provenance.artifactManifestSHA256);
