/**
 * Signs a ForgeOrbit app from the inside out.
 * The local-owner channel uses the persistent login-keychain certificate.
 * It refuses ad-hoc, QA, Developer ID as a substitute, and codesign --deep.
 * This script does not create the Owner identity.
 *
 * The certificate is self-signed and is not in the system trust store. Signing
 * therefore selects the exact certificate whose leaf SHA-256 equals the
 * login-keychain anchor (by SHA-1, with `--keychain login`) instead of relying
 * on a common name that a second certificate could also carry.
 *
 * The Owner key is deliberately not pre-authorized for codesign (`-T` and
 * `security set-key-partition-list` are not used). macOS therefore asks the
 * Owner before codesign may use the key. All targets after the helper are
 * signed by one codesign process so that prompt is asked once for that process;
 * the Owner can answer "Allow" without granting a permanent "Always Allow".
 *
 * Nested signatures already carry entitlements for the vendored Bun/Chromium
 * binaries. `--preserve-metadata=entitlements` keeps them; without it a re-sign
 * silently strips JIT and library-validation entitlements.
 */
import { spawnSync } from "node:child_process";
import { existsSync, readdirSync, readSync, closeSync, openSync, realpathSync, statSync } from "node:fs";
import path from "node:path";
import { readLocalOwnerAnchor } from "../src/bun/owner-trust/identity.ts";
import { evaluateLocalSignature } from "../src/bun/owner-trust/local-signature.ts";
import { PRODUCTION_BUNDLE_ID, QA_BUNDLE_ID } from "../src/shared/owner-trust/protocol.ts";
import {
  HELPER_BUNDLE_RELATIVE_PATH,
  LOCAL_OWNER_CERT_CN,
  PRODUCTION_HELPER_ID,
  QA_HELPER_ID,
} from "../src/shared/owner-trust/signing-policy.ts";
import { certificatePins, findCodesigningIdentity, loginKeychainPath } from "./local-owner-identity.ts";

export interface SignTargets {
  helper: string;
  /** Mach-O files except the helper. */
  binaries: string[];
  /** Nested .app/.framework/.xpc bundles, deepest first. */
  bundles: string[];
}

export interface SignApplicationOptions {
  app: string;
  /** Value passed to `codesign --sign`: a SHA-1 for the pinned Owner certificate. */
  identity: string;
  keychain?: string;
  helperId: string;
  log?: (line: string) => void;
}

function isMachO(file: string): boolean {
  let fd = -1;
  try {
    const info = statSync(file);
    if (!info.isFile() || info.size < 4) return false;
    fd = openSync(file, "r");
    const header = Buffer.alloc(4);
    if (readSync(fd, header, 0, 4, 0) !== 4) return false;
    const magic = header.readUInt32BE(0);
    return magic === 0xFEEDFACE || magic === 0xFEEDFACF || magic === 0xCAFEBABE || magic === 0xBEBAFECA
      || magic === 0xCAFEBABF || magic === 0xBFBAFECA
      || magic === 0xCEFAEDFE || magic === 0xCFFAEDFE;
  } catch {
    return false;
  } finally {
    if (fd >= 0) closeSync(fd);
  }
}

function collect(root: string, binaries: string[], bundles: string[], app: string): void {
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    if (entry.isSymbolicLink()) continue;
    const full = path.join(root, entry.name);
    if (entry.isDirectory()) {
      collect(full, binaries, bundles, app);
      if (/\.(app|framework|xpc)$/.test(entry.name) && full !== app) bundles.push(full);
      continue;
    }
    if (entry.isFile() && isMachO(full)) binaries.push(full);
  }
}

/** Enumerates nested code. Bundles are returned deepest first so they sign inside out. */
export function collectSignTargets(app: string): SignTargets {
  const binaries: string[] = [];
  const bundles: string[] = [];
  collect(app, binaries, bundles, app);
  binaries.sort((a, b) => b.length - a.length);
  bundles.sort((a, b) => b.length - a.length);
  const helper = path.join(app, HELPER_BUNDLE_RELATIVE_PATH);
  return { helper, binaries: binaries.filter((binary) => binary !== helper), bundles };
}

function appMainExecutable(app: string): string | null {
  const result = spawnSync("plutil", ["-extract", "CFBundleExecutable", "raw", path.join(app, "Contents/Info.plist")], { encoding: "utf8" });
  const name = result.stdout?.trim();
  return name ? path.join(app, "Contents/MacOS", name) : null;
}

export interface SignApplicationResult extends SignTargets {
  /** codesign processes started. */
  processes: number;
  /** Private-key operations performed with the Owner identity. */
  ownerKeyOperations: number;
}

/**
 * Signs the application inside out while touching the Owner key only twice.
 *
 * macOS asks for the private key once per signature operation, not once per
 * process. Signing every nested Mach-O with the Owner identity therefore opens
 * one dialog per file (63 on the real bundle). Nested third-party code does not
 * need the Owner identity: only the helper and the application must carry it.
 * Every other Mach-O and nested bundle is re-signed ad-hoc, which uses no key,
 * preserves its entitlements, and keeps the inside-out order. The Owner key is
 * then used exactly twice: the helper (its own identifier) and the application
 * (the main executable and the bundle seal).
 */
export function signApplication(options: SignApplicationOptions): SignApplicationResult {
  const log = options.log ?? (() => {});
  const targets = collectSignTargets(options.app);
  if (!existsSync(targets.helper)) throw new Error("The Owner helper is not embedded. Build it before signing.");
  const main = appMainExecutable(options.app);
  const nestedBinaries = targets.binaries.filter((binary) => binary !== main);
  const ownerBase = [
    "--force",
    "--sign", options.identity,
    ...(options.keychain ? ["--keychain", options.keychain] : []),
    "--preserve-metadata=entitlements",
  ];
  // "-" is an ad-hoc signature and uses no private key.
  const ownerKeyOperations = options.identity === "-" ? 0 : 2;
  let processes = 0;
  const run = (args: string[]): void => {
    processes += 1;
    const result = spawnSync("codesign", args, { encoding: "utf8" });
    if (result.status !== 0) {
      throw new Error(`${result.stderr || result.stdout}`.trim() || "codesign failed");
    }
  };
  if (nestedBinaries.length > 0 || targets.bundles.length > 0) {
    // Ad-hoc: no private key, so no Owner dialog. Entitlements are preserved.
    run(["--force", "--sign", "-", "--preserve-metadata=entitlements", ...nestedBinaries, ...targets.bundles]);
    log(`ad-hoc signed ${nestedBinaries.length} nested binary/binaries and ${targets.bundles.length} nested bundle(s); no Owner key access`);
  }
  // Owner key operation 1 of 2: the helper is a bare Mach-O, so its identifier
  // has to be explicit.
  run([...ownerBase, "--identifier", options.helperId, targets.helper]);
  log(ownerKeyOperations > 0 ? `Owner-signed helper ${options.helperId} (key use 1 of 2)` : `signed helper ${options.helperId}`);
  // Owner key operation 2 of 2: signs the application main executable and the
  // bundle seal over all nested code.
  run([...ownerBase, options.app]);
  log(ownerKeyOperations > 0 ? "Owner-signed the application (key use 2 of 2)" : "signed the application");
  return { ...targets, processes, ownerKeyOperations };
}


function keychainSearchList(): string[] {
  const result = spawnSync("security", ["list-keychains", "-d", "user"], { encoding: "utf8" });
  return (result.stdout ?? "").split("\n").map((line) => line.trim().replaceAll('"', "")).filter(Boolean);
}

function sameKeychainPath(left: string, right: string): boolean {
  try { return realpathSync(left) === realpathSync(right); } catch { return path.resolve(left) === path.resolve(right); }
}

/**
 * Refuses to sign while the user keychain search list contains a keychain
 * other than the login keychain. A stray keychain (for example a disposable
 * test keychain left in the list) can make codesign ask for that keychain's
 * password instead of the Owner's login password. Nothing is changed here; the
 * Owner must clean the search list explicitly.
 */
function assertCleanOwnerKeychainSearchList(login: string): void {
  if (!path.isAbsolute(login) || !existsSync(login)) {
    console.error("The login keychain path is not an existing absolute path. Nothing was signed.");
    process.exit(2);
  }
  const listed = keychainSearchList();
  if (!listed.some((entry) => sameKeychainPath(entry, login))) {
    console.error("The user keychain search list does not contain the login keychain. Nothing was signed.");
    process.exit(2);
  }
  const extra = listed.filter((entry) => !sameKeychainPath(entry, login));
  if (extra.length > 0) {
    console.error("The user keychain search list contains extra keychains:");
    for (const entry of extra) console.error(`  ${entry}`);
    console.error("A stray keychain can make codesign ask for a different keychain password. Remove it from the search list before signing.");
    console.error("Nothing was signed. Do not use Always Allow.");
    process.exit(2);
  }
}

function main(): void {
  const appArg = process.argv.find((arg) => arg.startsWith("--app="))?.slice("--app=".length);
  let channel = process.argv.find((arg) => arg.startsWith("--channel="))?.slice("--channel=".length) ?? "local-owner";
  if (channel === "production") channel = "local-owner";
  const identityArg = process.argv.find((arg) => arg.startsWith("--identity="))?.slice("--identity=".length) ?? "";

  if (!appArg || (channel !== "local-owner" && channel !== "qa")) {
    console.error("Usage: bun scripts/sign-macos-app.ts --app=<path> --channel=local-owner|qa [--identity=<name>]");
    console.error("local-owner signs app.forgeorbit with the login-keychain certificate \"" + LOCAL_OWNER_CERT_CN + "\".");
    console.error("It does not create that certificate. Run scripts/local-owner-identity.ts from Terminal first.");
    process.exit(2);
  }
  const app = path.resolve(appArg);
  const identity = channel === "local-owner" ? (identityArg || LOCAL_OWNER_CERT_CN) : (identityArg || "-");

  if (channel === "local-owner") {
    if (identity !== LOCAL_OWNER_CERT_CN || /adhoc|developer id|apple development|qa/i.test(identity)) {
      console.error("local-owner signing accepts only \"" + LOCAL_OWNER_CERT_CN + "\". Ad-hoc and Developer ID are refused.");
      process.exit(2);
    }
  }
  if (channel === "qa" && identity === LOCAL_OWNER_CERT_CN) {
    console.error("QA signing refuses the local Owner identity.");
    process.exit(2);
  }

  const plist = spawnSync("plutil", ["-extract", "CFBundleIdentifier", "raw", path.join(app, "Contents/Info.plist")], { encoding: "utf8" }).stdout?.trim();
  if (channel === "local-owner" && plist !== PRODUCTION_BUNDLE_ID) {
    console.error(`Refusing to sign ${plist ?? "an unknown bundle"} as the local Owner app. Expected ${PRODUCTION_BUNDLE_ID}.`);
    process.exit(2);
  }
  if (channel === "qa" && plist !== QA_BUNDLE_ID) {
    console.error(`Refusing to sign ${plist ?? "an unknown bundle"} as QA. Expected ${QA_BUNDLE_ID}.`);
    process.exit(2);
  }
  const helper = path.join(app, HELPER_BUNDLE_RELATIVE_PATH);
  if (!existsSync(helper)) {
    console.error("The Owner helper is not embedded. Build it before signing.");
    process.exit(2);
  }

  // A self-signed certificate is not trusted by Gatekeeper, so codesign cannot
  // resolve it by common name alone. Resolve the exact certificate that the
  // login-keychain anchor pins, then sign by its SHA-1 with `--keychain login`.
  let signName = identity;
  let certificateSha1: string | null = null;
  let keychain: string | undefined;
  if (channel === "local-owner") {
    const login = loginKeychainPath();
    if (!login) {
      console.error("The login keychain could not be resolved. Nothing was signed.");
      process.exit(2);
    }
    assertCleanOwnerKeychainSearchList(login);
    if (!findCodesigningIdentity(LOCAL_OWNER_CERT_CN, login)) {
      console.error(`The identity "${LOCAL_OWNER_CERT_CN}" is not in the keychain. Run scripts/local-owner-identity.ts --create from Terminal.`);
      process.exit(2);
    }
    const anchor = readLocalOwnerAnchor();
    if (!anchor) {
      console.error("The login-keychain Owner anchor is missing. Run scripts/local-owner-identity.ts --create from Terminal.");
      process.exit(2);
    }
    const pinned = certificatePins(LOCAL_OWNER_CERT_CN, login).find((pin) => pin.sha256 === anchor);
    if (!pinned) {
      console.error("No certificate with this common name matches the stored Owner anchor. Nothing was signed.");
      console.error("The old certificate stays pinned. Run scripts/local-owner-identity.ts --status.");
      process.exit(2);
    }
    signName = pinned.sha1;
    certificateSha1 = pinned.sha1;
    keychain = login;
  }

  try {
    const targets = signApplication({
      app,
      identity: signName,
      keychain,
      helperId: channel === "qa" ? QA_HELPER_ID : PRODUCTION_HELPER_ID,
      log: (line) => console.error(`[sign-macos-app] ${line}`),
    });
    if (channel === "local-owner") {
      // Exactly two private-key operations: the helper and the application.
      // Nested code is re-signed ad-hoc and never asks for the Owner key.
      console.error(`[sign-macos-app] ${targets.processes} codesign process(es), ${targets.ownerKeyOperations} Owner key use(s). Expect exactly ${targets.ownerKeyOperations} Keychain prompts, one at a time. Answer Allow for each; never Always Allow.`);
    }
    if (channel === "qa") {
      console.log(JSON.stringify({ app, bundleId: plist, helperId: QA_HELPER_ID, channel, identity, processes: targets.processes, ownerKeyOperations: targets.ownerKeyOperations, deep: false, authoritative: false }, null, 2));
      process.exit(0);
    }
    const report = evaluateLocalSignature(app, { requireOwnerCn: true });
    if (!report.ok || !report.authoritative) {
      console.error(report.reason);
      console.error(JSON.stringify(report, null, 2));
      process.exit(2);
    }
    console.log(JSON.stringify({
      app,
      bundleId: report.bundleId,
      helperId: report.helperId,
      channel,
      identity,
      certificateSha1,
      teamId: report.teamId,
      certSha256: report.appCertSha256,
      binaries: targets.binaries.length,
      nestedBundles: targets.bundles.length,
      processes: targets.processes,
      ownerKeyOperations: targets.ownerKeyOperations,
      deep: false,
      authoritative: report.authoritative,
      enrolled: false,
    }, null, 2));
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(2);
  }
}

if (import.meta.main) main();
