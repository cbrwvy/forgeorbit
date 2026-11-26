import { spawnSync } from "node:child_process";
import { chmodSync, copyFileSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, renameSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import path from "node:path";
import { sourcePaths, json, verifyProvenance } from "./release-metadata.ts";
import { verifyLocalStyles } from "./local-app.ts";

// Build from a plain input copy: no .env, credentials, QA flags or parent
// signing/provider environment can enter SDK hooks. No Git checkout is made.
if (process.platform !== "darwin" || process.arch !== "arm64") throw new Error("build:local requires macOS Apple Silicon");
const repo = process.cwd();
// QA only: bake the non-persistent WebKit store into an otherwise ordinary production-identity local build and write it
// to build/local-isolated, never to build/local (the installable package).
const isolated = process.argv.includes("--isolated-storage");
function run(command: string[], cwd: string, env?: NodeJS.ProcessEnv): string {
  const result = spawnSync(command[0]!, command.slice(1), { cwd, env, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
  if (result.error || result.status !== 0) throw new Error(`Local build command failed: ${command[0]}\n${result.error ?? ""}\n${result.stdout}\n${result.stderr}`);
  return result.stdout;
}
const capsule = mkdtempSync("/private/tmp/fo-local-build-"), source = path.join(capsule, "source"), home = path.join(capsule, "home"), tmp = path.join(capsule, "tmp"), tools = path.join(capsule, "tools");
for (const dir of [source, home, tmp, tools]) mkdirSync(dir, { mode: 0o700 });
const git = run(["/usr/bin/xcrun", "--find", "git"], repo).trim();
symlinkSync(git, path.join(tools, "git"));
const clean: NodeJS.ProcessEnv = { HOME: home, TMPDIR: tmp, PATH: `${tools}:/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin`, SHELL: "/bin/sh", LANG: "en_US.UTF-8", GIT_OPTIONAL_LOCKS: "0", FORGEORBIT_LOCAL_BUILD: "1", FORGEORBIT_BUILD_SOURCE_REPOSITORY: repo, ...(isolated ? { FORGEORBIT_ISOLATED_NATIVE_STORAGE: "1" } : {}) };
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
  console.log("[FO-LOCAL01] building", name);
  const result = spawnSync(process.execPath, ["--no-env-file", ...args], { cwd: source, env: clean, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
  const log = (result.stdout || "") + (result.stderr || ""); writeFileSync(path.join(logs, name + ".log"), log);
  if (result.status !== 0) throw new Error(`Local ${name} failed; evidence: ${logs}\n${log.slice(-6000)}`);
}
const built = path.join(source, "build/dev-macos-arm64"), output = path.join(repo, isolated ? "build/local-isolated" : "build/local");
const receipt = verifyProvenance(path.join(built, "ForgeOrbit.app"), built);
if (!receipt.metadata.localBuild || receipt.sdk.name !== "ForgeOrbit") throw new Error("Missing personal package identity");
mkdirSync(path.dirname(output), { recursive: true });
if (existsSync(output)) renameSync(output, output + ".retained-" + Date.now());
mkdirSync(output, { mode: 0o700 });
run(["/bin/cp", "-cRp", path.join(built, "ForgeOrbit.app"), path.join(output, "ForgeOrbit.app")], repo, clean);
for (const name of ["forgeorbit-artifact-manifest.json", "forgeorbit-provenance.json"]) copyFileSync(path.join(built, name), path.join(output, name));
verifyProvenance(path.join(output, "ForgeOrbit.app"), output);
writeFileSync(path.join(output, "local-build.json"), json({ capsule, app: path.join(output, "ForgeOrbit.app"), artifactManifestSHA256: receipt.artifactManifestSHA256, signing: "ad-hoc", publication: false, isolatedStorage: isolated }));
console.log("[FO-LOCAL01] local package accepted", path.join(output, "ForgeOrbit.app"), receipt.artifactManifestSHA256);
