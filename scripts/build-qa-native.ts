import { spawnSync } from "node:child_process";
import { chmodSync, copyFileSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, renameSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import path from "node:path";
import { sourcePaths, json, verifyProvenance } from "./release-metadata.ts";
import { verifyLocalStyles } from "./local-app.ts";
import { QA_IDENTIFIER } from "./electrobun-qa-storage.ts";

/** Opt-in NATIVE-005 QA package: ForgeOrbitQA + app.forgeorbit.qa, baked runtime
 * root, non-persist WebKit partition, fake-driver bootstrap. Does not touch
 * build/local or production WebKit namespaces. */
if (process.platform !== "darwin" || process.arch !== "arm64") throw new Error("build:qa-native requires macOS Apple Silicon");
const repo = process.cwd();
const outputRoot = path.resolve(process.env.FORGEORBIT_QA_OUTPUT_ROOT || path.join(repo, "build/qa-native"));
mkdirSync(path.join(outputRoot, "runtime"), { recursive: true, mode: 0o700 });
const qaRuntime = realpathSync(path.join(outputRoot, "runtime"));

function run(command: string[], cwd: string, env?: NodeJS.ProcessEnv): string {
  const result = spawnSync(command[0]!, command.slice(1), { cwd, env, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
  if (result.error || result.status !== 0) throw new Error(`QA build command failed: ${command[0]}\n${result.error ?? ""}\n${result.stdout}\n${result.stderr}`);
  return result.stdout;
}

const capsule = mkdtempSync("/private/tmp/fo-qa-native-build-"), source = path.join(capsule, "source"), home = path.join(capsule, "home"), tmp = path.join(capsule, "tmp"), tools = path.join(capsule, "tools");
for (const dir of [source, home, tmp, tools]) mkdirSync(dir, { mode: 0o700 });
const git = run(["/usr/bin/xcrun", "--find", "git"], repo).trim();
symlinkSync(git, path.join(tools, "git"));
const live = process.env.FORGEORBIT_QA_LIVE_IDENTITY === "1";
const clean: NodeJS.ProcessEnv = {
  HOME: home, TMPDIR: tmp, PATH: `${tools}:/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin`, SHELL: "/bin/sh", LANG: "en_US.UTF-8",
  GIT_OPTIONAL_LOCKS: "0", FORGEORBIT_BUILD_SOURCE_REPOSITORY: repo,
  ...(live ? { FORGEORBIT_QA_LIVE_IDENTITY: "1" } : { FORGEORBIT_NATIVE_QA_ROOT: qaRuntime }),
};
const listed = run([git, "ls-files", "-co", "--exclude-standard", "-z", "--", ...sourcePaths], repo, clean).split("\0").filter(Boolean);
for (const file of new Set(listed)) {
  const original = path.join(repo, file), target = path.join(source, file), stat = lstatSync(original);
  if (!stat.isFile() || file.split("/").includes("..")) throw new Error("Unexpected build input: " + file);
  mkdirSync(path.dirname(target), { recursive: true }); copyFileSync(original, target); chmodSync(target, stat.mode & 0o777); utimesSync(target, stat.atime, stat.mtime);
}
for (const folder of ["node_modules", "vendor"]) {
  if (!existsSync(path.join(repo, folder))) throw new Error(`Prepare local ${folder} prerequisites first`);
  run(["/bin/cp", "-cRp", path.join(repo, folder), path.join(source, folder)], repo, clean);
}
const logs = path.join(capsule, "evidence"); mkdirSync(logs, { mode: 0o700 });
for (const [name, args] of [
  ["vendor-tmux", ["scripts/fetch-tmux.ts"]],
  ["vendor-notifier", ["scripts/build-notifier.ts"]],
  ["vendor-disclaim", ["scripts/build-disclaim.ts"]],
  ["vendor-owner-trust", ["scripts/build-owner-trust.ts"]],
  ["vendor-native-computer", ["scripts/build-native-computer.ts"]],
  ["vendor-browser", ["scripts/prepare-browser.ts"]],
  ["vite", ["node_modules/vite/bin/vite.js", "build"]],
  ["secure", ["scripts/build-native-secure.ts", "--env=dev"]],
] as [string, string[]][]) {
  if (name === "secure") verifyLocalStyles(path.join(source, "dist"));
  console.log("[FO-QA-NATIVE] building", name);
  const result = spawnSync(process.execPath, ["--no-env-file", ...args], { cwd: source, env: clean, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
  const log = (result.stdout || "") + (result.stderr || ""); writeFileSync(path.join(logs, name + ".log"), log);
  if (result.status !== 0) throw new Error(`QA ${name} failed; evidence: ${logs}\n${log.slice(-6000)}`);
}
const built = path.join(source, "build/dev-macos-arm64");
const appName = "ForgeOrbitQA-dev.app";
const builtApp = path.join(built, appName);
if (!existsSync(builtApp)) throw new Error(`Missing ${builtApp}`);
const receipt = verifyProvenance(builtApp, built);
if (receipt.sdk.identifier !== QA_IDENTIFIER || !receipt.sdk.name.startsWith("ForgeOrbitQA")) {
  throw new Error("Missing QA package identity");
}
mkdirSync(outputRoot, { recursive: true, mode: 0o700 });
const destApp = path.join(outputRoot, appName);
if (existsSync(destApp)) renameSync(destApp, destApp + ".retained-" + Date.now());
run(["/bin/cp", "-cRp", builtApp, destApp], repo, clean);
for (const name of ["forgeorbit-artifact-manifest.json", "forgeorbit-provenance.json"]) {
  copyFileSync(path.join(built, name), path.join(outputRoot, name));
}
verifyProvenance(destApp, outputRoot);
writeFileSync(path.join(outputRoot, "qa-native-build.json"), json({
  capsule, app: destApp, qaRuntimeRoot: qaRuntime, bundleIdentifier: QA_IDENTIFIER,
  webkitPartition: "fo-native005-qa-ephemeral", artifactManifestSHA256: receipt.artifactManifestSHA256,
  signing: "unsigned-dev", publication: false,
}));
console.log("[FO-QA-NATIVE] QA package accepted", destApp, "runtime", qaRuntime, receipt.artifactManifestSHA256);
