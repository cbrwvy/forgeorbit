import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { BunPlugin } from "bun";

const launcherHash = "dc7c0cd922fce45f39e8f9e0eb40eb25f1df0b806cc9890b208292c3398ae9e9";
const utilsHash = "7935a7f91da405f6c5f99d82b5415a39697a8577260b4d4345d1b3a016fdbb79";
const sdk = () => path.resolve(import.meta.dirname, "../node_modules/electrobun");
function checked(source: string, hash: string) {
  if (createHash("sha256").update(source).digest("hex") !== hash) throw new Error("NATIVE-004: unreviewed Electrobun source; rebase lifecycle integration");
  return source;
}
function replace(source: string, before: string, after: string) {
  if (source.split(before).length !== 2) throw new Error("NATIVE-004: ambiguous lifecycle patch");
  return source.replace(before, after);
}
function assertSdk() {
  if (JSON.parse(readFileSync(path.join(sdk(), "package.json"), "utf8")).version !== "1.18.1") {
    throw new Error("NATIVE-004: unreviewed Electrobun version");
  }
}
export function patchLauncher(source: string) {
  source = checked(source, launcherHash);
  return replace(source, "  new Worker(appEntrypointPath, {});", `  // FO-NATIVE004-LAUNCHER-V1
  const { Worker: Supervisor } = __require("node:worker_threads");
  const launcherPid = process.ppid;
  if (launcherPid <= 1) lib.symbols.forceExit(1);
  const startup = new SharedArrayBuffer(4);
  new Supervisor(join(resourcesDir, "forgeorbit-lifecycle.js"), {
    workerData: { appEntrypointPath, libPath: absoluteLibPath, startup, launcherPid }
  });
  // Establish supervision before entering the blocking native event loop.
  Atomics.wait(new Int32Array(startup), 0, 0, 10000);
  if (Atomics.load(new Int32Array(startup), 0) !== 1) lib.symbols.forceExit(1);`);
}
export function patchUtils(source: string) {
  source = checked(source, utilsHash);
  source = replace(source, "let isQuitting = false;", `console.log("FO-NATIVE004-UTILS-V1: synchronous native cleanup installed");
let isQuitting = false;`);
  source = replace(source, "\tif (native) {\n\t\tnative.symbols.stopEventLoop();", `\tif (native) {
\t\t// forceExit bypasses Bun's exit hooks; the JS fallback emits its own.
\t\tprocess.emit("exit", 0);
\t\tnative.symbols.stopEventLoop();`);
  return replace(source, "\tif (native) {\n\t\tif (isQuitting) {", `\tif (native) {
\t\tif ((code && code !== 0) || !globalThis[Symbol.for("forgeorbit.native.backendReady")]) {
\t\t\t// Fatal startup/runtime failure must not be vetoed or become exit 0.
\t\t\tconst failureCode = code || 1;
\t\t\tprocess.emit("exit", failureCode);
\t\t\tnative.symbols.forceExit(failureCode);
\t\t\treturn;
\t\t}
\t\tif (isQuitting) {`);
}
export function electrobunLifecycle(): BunPlugin {
  return { name: "forgeorbit-native004", setup(build) {
    assertSdk();
    patchUtils(readFileSync(path.join(sdk(), "dist/api/bun/core/Utils.ts"), "utf8"));
    build.onLoad({ filter: /[/\\]electrobun[/\\]dist[/\\]api[/\\]bun[/\\]core[/\\]Utils\.ts$/ }, async args => {
      console.log("[FO-NATIVE004] Utils transform applied");
      return { contents: patchUtils(await Bun.file(args.path).text()), loader: "ts" };
    });
  } };
}

/** Post-build, before signing. Patch copied Resources only, never installed SDK. */
export async function installLauncherLifecycle(resources: string) {
  assertSdk();
  const file = path.join(resources, "main.js");
  writeFileSync(file, patchLauncher(readFileSync(file, "utf8")));
  const build = await Bun.build({ entrypoints: [path.resolve(import.meta.dirname, "../patches/electrobun-1.18.1/lifecycle-supervisor.ts")], target: "bun" });
  if (!build.success || build.outputs.length !== 1) throw new Error("NATIVE-004: supervisor build failed");
  writeFileSync(path.join(resources, "forgeorbit-lifecycle.js"), await build.outputs[0]!.text());
  console.log("[FO-NATIVE004] launcher integration installed");
}
export function verifyLauncherLifecycle(resources: string) {
  assertSdk();
  if (readFileSync(path.join(resources, "main.js"), "utf8") !== patchLauncher(readFileSync(path.join(sdk(), "dist/main.js"), "utf8"))) {
    throw new Error("NATIVE-004: launcher integration missing or changed");
  }
  const supervisor = readFileSync(path.join(resources, "forgeorbit-lifecycle.js"), "utf8");
  if (!supervisor.includes("FO-NATIVE004-SUPERVISOR-V1") || !supervisor.includes('backend.on("exit"') || !supervisor.includes("forceExit")) {
    throw new Error("NATIVE-004: supervisor integration missing");
  }
}

export function verifyNativeLifecyclePackage(appCode: string) {
  verifyLauncherLifecycle(path.dirname(appCode));
  if (!readFileSync(path.join(appCode, "bun/index.js"), "utf8").includes("FO-NATIVE004-UTILS-V1")) {
    throw new Error("NATIVE-004: backend lifecycle transform missing");
  }
}
