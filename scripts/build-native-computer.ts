#!/usr/bin/env bun
// Builds vendor/computer-use/forgeorbit-native-cu. The packaged app copies it
// to Contents/Resources/app/bin. Electrobun does not re-sign that directory,
// so the signature applied here is the one that ships.

import { existsSync, statSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

const REPO_ROOT = path.resolve(import.meta.dir, "..");
const SRC = path.join(REPO_ROOT, "native", "computer-use", "helper.swift");
const OUT_DIR = path.join(REPO_ROOT, "vendor", "computer-use");
const EXE = path.join(OUT_DIR, "forgeorbit-native-cu");
const STAMP = path.join(OUT_DIR, ".signed-by");

function fail(message: string): never {
  console.error(`[build-native-computer] ${message}`);
  process.exit(1);
}

async function run(cmd: string[]): Promise<string> {
  const proc = Bun.spawn(cmd, { stdout: "pipe", stderr: "pipe" });
  const [out, err] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
  if (await proc.exited !== 0) {
    console.error(err.trim() || out.trim());
    throw new Error(`command failed: ${cmd.join(" ")}`);
  }
  return out.trim();
}

async function main() {
  if (process.platform !== "darwin") {
    await mkdir(OUT_DIR, { recursive: true });
    console.log(`[build-native-computer] skipped on ${process.platform}`);
    return;
  }
  if (process.arch !== "arm64") fail(`expected arm64, got ${process.arch}`);
  if (!existsSync(SRC)) fail("missing native/computer-use/helper.swift");
  await mkdir(OUT_DIR, { recursive: true });
  const devId = process.env.ELECTROBUN_DEVELOPER_ID;
  const desiredIdentity = devId || "adhoc";
  if (existsSync(EXE) && existsSync(STAMP)) {
    const newest = Math.max(statSync(SRC).mtimeMs, statSync(new URL(import.meta.url).pathname).mtimeMs);
    if (statSync(EXE).mtimeMs >= newest && (await readFile(STAMP, "utf8")).trim() === desiredIdentity) {
      console.log("[build-native-computer] cached");
      return;
    }
  }
  await run([
    "xcrun", "swiftc", "-O", "-target", "arm64-apple-macos14.0",
    "-framework", "AppKit", "-framework", "ApplicationServices", "-framework", "CoreGraphics", "-framework", "CryptoKit",
    "-o", EXE, SRC,
  ]);
  const signArgs = devId
    ? ["--force", "--options", "runtime", "--timestamp", "--sign", devId]
    : ["--force", "--sign", "-"];
  await run(["codesign", ...signArgs, EXE]);
  await run(["codesign", "--verify", "--strict", EXE]);
  await writeFile(STAMP, `${desiredIdentity}\n`);
  const arch = await run(["lipo", "-archs", EXE]);
  if (arch !== "arm64") fail(`built ${arch}, expected arm64`);
  console.log(`[build-native-computer] ${path.relative(REPO_ROOT, EXE)}`);
}

main().catch((error: unknown) => {
  console.error(`[build-native-computer] ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
});
