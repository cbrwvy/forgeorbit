/**
 * Owner-operated local code-signing identity.
 * The private key stays in the login keychain. This file does not write a
 * .p12 into the repository and does not print the key.
 * Creating the ForgeOrbit Local Owner identity requires an interactive Owner
 * terminal. A non-interactive agent session is refused.
 */
import { createHash, randomBytes } from "node:crypto";
import { spawnSync } from "node:child_process";
import { mkdtempSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  LOCAL_OWNER_ANCHOR_ACCOUNT,
  LOCAL_OWNER_ANCHOR_SERVICE,
  LOCAL_OWNER_CERT_CN,
} from "../src/shared/owner-trust/signing-policy.ts";
import { readLocalOwnerAnchor } from "../src/bun/owner-trust/identity.ts";

function run(command: string[], input?: string): { status: number; stdout: string; stderr: string } {
  const result = spawnSync(command[0]!, command.slice(1), { encoding: "utf8", input });
  return { status: result.status ?? 1, stdout: result.stdout ?? "", stderr: result.stderr ?? "" };
}

function shred(file: string): void {
  try {
    const size = statSync(file).size;
    writeFileSync(file, Buffer.alloc(size));
  } catch {
    // The file may already be gone.
  }
  rmSync(file, { force: true });
}

export function loginKeychainPath(): string {
  return run(["security", "login-keychain"]).stdout.trim().replaceAll("\"", "");
}

function samePath(left: string, right: string): boolean {
  try { return realpathSync(left) === realpathSync(right); } catch { return path.resolve(left) === path.resolve(right); }
}

export function certificateDerSha256(pem: string): { sha256: string; sha1: string } {
  const body = pem.replace(/-----BEGIN CERTIFICATE-----/g, "").replace(/-----END CERTIFICATE-----/g, "").replace(/\s/g, "");
  const der = Buffer.from(body, "base64");
  return {
    sha256: createHash("sha256").update(der).digest("hex"),
    sha1: createHash("sha1").update(der).digest("hex").toUpperCase(),
  };
}

/**
 * Finds the keychain identity for a common name.
 *
 * The validity filter (`find-identity -v`) is deliberately not used: a
 * personal self-signed certificate is not trusted by Gatekeeper, so `-v`
 * reports zero identities even when the identity is present and usable by
 * `codesign --keychain`. The trust anchor is the pinned leaf fingerprint, not
 * the system trust store.
 */
export function findCodesigningIdentity(commonName: string, keychain?: string): string | null {
  const args = ["find-identity", "-p", "codesigning"];
  if (keychain) args.push(keychain);
  const listed = run(["security", ...args]).stdout;
  const line = listed.split("\n").find((entry) => entry.includes(`"${commonName}"`));
  return line ?? null;
}

/** Public fingerprints of every certificate with this common name. This is not a private key. */
export function certificatePins(commonName: string, keychain?: string): Array<{ sha256: string; sha1: string }> {
  const args = ["find-certificate", "-a", "-c", commonName, "-p"];
  if (keychain) args.push(keychain);
  const result = run(["security", ...args]);
  if (result.status !== 0 || !result.stdout.includes("BEGIN CERTIFICATE")) return [];
  const pins: Array<{ sha256: string; sha1: string }> = [];
  const pattern = /-----BEGIN CERTIFICATE-----([\s\S]*?)-----END CERTIFICATE-----/g;
  for (const match of result.stdout.matchAll(pattern)) {
    const der = Buffer.from(match[1]!.replace(/\s/g, ""), "base64");
    if (der.length === 0) continue;
    pins.push({
      sha256: createHash("sha256").update(der).digest("hex"),
      sha1: createHash("sha1").update(der).digest("hex").toUpperCase(),
    });
  }
  return pins;
}

export function keychainCertificateSha256(commonName: string, keychain?: string): string | null {
  return certificatePins(commonName, keychain)[0]?.sha256 ?? null;
}

/**
 * Imports a disposable code-signing certificate into a caller-supplied keychain.
 * It refuses the Owner common name and the login keychain.
 */
export function createDisposableCodeSigningIdentity(input: { commonName: string; keychain: string; password: string }): { sha256: string; sha1: string } {
  if (input.commonName === LOCAL_OWNER_CERT_CN || input.commonName.toLowerCase().includes("local owner")) {
    throw new Error("Refusing to create the Owner signing identity from a test or agent path.");
  }
  if (samePath(input.keychain, loginKeychainPath())) {
    throw new Error("Refusing to import a disposable identity into the login keychain.");
  }
  return importSelfSignedIdentity({ ...input, nonExtractable: false, allowCodesign: true });
}

function importSelfSignedIdentity(input: { commonName: string; keychain: string; password: string; nonExtractable: boolean; allowCodesign: boolean }): { sha256: string; sha1: string } {
  // The private key does exist before the Keychain import. It is written only
  // inside a 0700 mkdtemp directory and is encrypted with a random passphrase
  // that never leaves this process. It is still a temporary copy: do not claim
  // the imported key was never extractable at any point. `security import -x`
  // makes the Keychain item non-extractable after import; the temporary PEM is
  // overwritten and removed in the finally block.
  const dir = mkdtempSync(path.join(tmpdir(), "fo-signing-"));
  const key = path.join(dir, "key.pem");
  const cert = path.join(dir, "cert.pem");
  const p12 = path.join(dir, "identity.p12");
  const config = path.join(dir, "codesign.cnf");
  const keyPassword = randomBytes(32).toString("hex");
  const p12Password = randomBytes(32).toString("hex");
  try {
    writeFileSync(config, [
      "[req]",
      "distinguished_name = dn",
      "x509_extensions = codesign_ext",
      "prompt = no",
      "[dn]",
      `CN = ${input.commonName}`,
      "[codesign_ext]",
      "keyUsage = critical, digitalSignature",
      "extendedKeyUsage = critical, codeSigning",
      "basicConstraints = CA:FALSE",
      "",
    ].join("\n"), { mode: 0o600 });
    const generated = run([
      "openssl", "req", "-x509", "-newkey", "rsa:2048",
      "-keyout", key, "-out", cert, "-days", "3650", "-config", config,
      "-passout", `pass:${keyPassword}`,
    ]);
    if (generated.status !== 0) throw new Error(generated.stderr || generated.stdout || "openssl req failed");
    const packed = run([
      "openssl", "pkcs12", "-export", "-inkey", key, "-in", cert, "-out", p12,
      "-passin", `pass:${keyPassword}`, "-passout", `pass:${p12Password}`,
    ]);
    if (packed.status !== 0) throw new Error(packed.stderr || "openssl pkcs12 failed");
    const args = ["security", "import", p12, "-k", input.keychain, "-f", "pkcs12", "-P", p12Password];
    if (input.nonExtractable) args.push("-x");
    if (input.allowCodesign) args.push("-T", "/usr/bin/codesign");
    const imported = run(args);
    if (imported.status !== 0) throw new Error(imported.stderr || imported.stdout || "security import failed");
    if (input.allowCodesign) {
      const partitioned = run(["security", "set-key-partition-list", "-S", "apple-tool:,apple:,codesign:", "-s", "-k", input.password, input.keychain]);
      if (partitioned.status !== 0) throw new Error(partitioned.stderr || partitioned.stdout || "set-key-partition-list failed");
    }
    const pem = run(["openssl", "x509", "-in", cert, "-outform", "PEM"]);
    return certificateDerSha256(pem.stdout);
  } finally {
    shred(key);
    shred(p12);
    shred(cert);
    shred(config);
    rmSync(dir, { recursive: true, force: true });
  }
}

function writeAnchor(sha256: string): void {
  const result = run([
    "security", "add-generic-password", "-U",
    "-s", LOCAL_OWNER_ANCHOR_SERVICE,
    "-a", LOCAL_OWNER_ANCHOR_ACCOUNT,
    "-w", sha256,
    "-A",
    "-D", "ForgeOrbit local Owner certificate SHA-256",
  ]);
  if (result.status !== 0) throw new Error(result.stderr || "The Owner anchor could not be stored in the login keychain.");
}

function ownerInstructions(): string {
  return [
    "ForgeOrbit is a personal-use macOS application. Public Apple distribution requirements are not part of the product.",
    "",
    "Create the local Owner identity yourself, in Terminal:",
    "  bun scripts/local-owner-identity.ts --create --confirm-owner-action",
    "",
    "The private key remains in the login keychain. macOS may ask before codesign uses it.",
    "Do not export a .p12. Do not paste the key into chat.",
  ].join("\n");
}

function main(): void {
  const args = new Set(process.argv.slice(2));
  const login = loginKeychainPath();
  if (args.has("--status")) {
    const present = Boolean(findCodesigningIdentity(LOCAL_OWNER_CERT_CN, login || undefined));
    const pins = login ? certificatePins(LOCAL_OWNER_CERT_CN, login) : [];
    const anchor = readLocalOwnerAnchor();
    const pinned = anchor ? pins.find((pin) => pin.sha256 === anchor) ?? null : null;
    console.log(JSON.stringify({
      commonName: LOCAL_OWNER_CERT_CN,
      present,
      certificateCount: pins.length,
      sha256: pinned?.sha256 ?? pins[0]?.sha256 ?? null,
      anchorPresent: Boolean(anchor),
      anchorMatchesCertificate: Boolean(pinned),
      // A personal self-signed certificate is not in the system trust store.
      // Signing works through the explicit `--keychain` + pinned fingerprint.
      trustedByGatekeeper: false,
      privateKeyExported: false,
    }, null, 2));
    return;
  }
  if (!args.has("--create") || !args.has("--confirm-owner-action")) {
    console.error(ownerInstructions());
    process.exit(2);
  }
  if (!process.stdin.isTTY) {
    console.error("Refusing to create the Owner signing identity from a non-interactive session.");
    console.error(ownerInstructions());
    process.exit(2);
  }
  const existing = findCodesigningIdentity(LOCAL_OWNER_CERT_CN, login || undefined);
  const replace = args.has("--replace-anchor");
  if (existing && !replace) {
    const sha256 = keychainCertificateSha256(LOCAL_OWNER_CERT_CN, login || undefined);
    console.log(JSON.stringify({ created: false, alreadyPresent: true, commonName: LOCAL_OWNER_CERT_CN, sha256 }, null, 2));
    console.error("The local Owner identity already exists. It was not replaced.");
    return;
  }
  if (replace && !args.has("--confirm-replace-local-owner-anchor")) {
    console.error("Replacing the Owner anchor also requires --confirm-replace-local-owner-anchor.");
    console.error("Replacement does not move the Secure Enclave key. Existing enrollments stay pinned to the old certificate.");
    process.exit(2);
  }
  if (!login) {
    console.error("The login keychain could not be resolved. No identity was created.");
    process.exit(2);
  }
  const created = importSelfSignedIdentity({
    commonName: LOCAL_OWNER_CERT_CN,
    keychain: login,
    password: "",
    nonExtractable: true,
    allowCodesign: false,
  });
  // Do not write an anchor for an identity that codesign cannot see. The
  // anchor is the only thing that authorizes this certificate, so a failed
  // import must fail closed instead of leaving a pin nobody can sign with.
  const imported = findCodesigningIdentity(LOCAL_OWNER_CERT_CN, login);
  const pinned = certificatePins(LOCAL_OWNER_CERT_CN, login).some((pin) => pin.sha256 === created.sha256);
  if (!imported || !pinned) {
    console.error("The identity was imported but codesign cannot see it in the login keychain. The anchor was not written.");
    process.exit(2);
  }
  writeAnchor(created.sha256);
  console.log(JSON.stringify({
    created: true,
    commonName: LOCAL_OWNER_CERT_CN,
    sha256: created.sha256,
    sha1: created.sha1,
    keychain: "login",
    privateKeyExported: false,
    p12Retained: false,
  }, null, 2));
  console.error("Identity created. Signing will use it by pinned SHA-1 with --keychain login.");
  console.error("The next codesign use can prompt in macOS Keychain. Allow it only if you are signing ForgeOrbit.");
}

if (import.meta.main) main();
