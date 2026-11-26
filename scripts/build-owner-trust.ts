/**
 * Build and sign the embedded Owner helper.
 * QA builds get app.forgeorbit.qa.owner-trust. Every other build gets
 * app.forgeorbit.owner-trust. The build stays ad-hoc unless
 * ELECTROBUN_DEVELOPER_ID is already set. An ad-hoc binary is not the
 * local Owner identity. The Owner signs the finished bundle separately.
 */
import { existsSync, statSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

const root = path.resolve(import.meta.dir, "..");
const outDir = path.join(root, "vendor/owner-trust");
const binary = path.join(outDir, "forgeorbit-owner-trust");
const stamp = path.join(outDir, ".signed-by");
const source = path.join(root, "native/owner-trust/main.swift");
const qa = Boolean(process.env.FORGEORBIT_NATIVE_QA_ROOT) || process.env.FORGEORBIT_QA_LIVE_IDENTITY === "1";
const identifier = qa ? "app.forgeorbit.qa.owner-trust" : "app.forgeorbit.owner-trust";
const devId = process.env.ELECTROBUN_DEVELOPER_ID?.trim() || "";
const desired = `${qa ? "qa" : "production"}:${devId || "adhoc"}:${identifier}`;

async function run(command: string[]): Promise<string> {
  const child = Bun.spawn(command, { stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  const code = await child.exited;
  if (code !== 0) throw new Error(`${command.join(" ")} failed\n${stderr || stdout}`);
  return (stdout + stderr).trim();
}

if (process.platform !== "darwin" || process.arch !== "arm64") {
  await mkdir(outDir, { recursive: true });
  console.log(`[build-owner-trust] skipped on ${process.platform}/${process.arch}`);
  process.exit(0);
}

await mkdir(outDir, { recursive: true });
if (existsSync(binary) && existsSync(stamp)) {
  const stampText = (await readFile(stamp, "utf8")).trim();
  if (statSync(binary).mtimeMs >= statSync(source).mtimeMs && stampText === desired) {
    console.log(`[build-owner-trust] cached ${identifier}`);
    process.exit(0);
  }
}

await run([
  "swiftc", "-O", "-target", "arm64-apple-macosx14.0",
  "-framework", "LocalAuthentication", "-framework", "Security", "-framework", "AppKit", "-framework", "CryptoKit",
  "-o", binary, source,
]);
const sign = devId
  ? ["codesign", "--force", "--options", "runtime", "--timestamp", "--identifier", identifier, "--sign", devId, binary]
  : ["codesign", "--force", "--sign", "-", "--identifier", identifier, binary];
console.log(devId ? `[build-owner-trust] signing ${identifier} with Developer ID` : `[build-owner-trust] ad-hoc signature for ${identifier}`);
await run(sign);
await run(["codesign", "--verify", "--strict", binary]);
const info = await run(["codesign", "-dv", "--verbose=4", binary]);
if (!info.includes(`Identifier=${identifier}`)) throw new Error(`Helper identifier is not ${identifier}`);
await writeFile(stamp, `${desired}\n`);
console.log(`[build-owner-trust] ${binary}`);
