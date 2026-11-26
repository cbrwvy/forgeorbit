/**
 * Application identity for Owner enrollment.
 * An ad-hoc or unsigned binary is not the production app.
 * A missing TeamIdentifier is not ad-hoc: the personal local Owner
 * certificate has no Apple team. Production trust is the pinned leaf hash.
 * The QA bundle id is a separate identity and cannot satisfy production trust.
 */
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir, userInfo } from "node:os";
import path from "node:path";
import { PRODUCTION_BUNDLE_ID, QA_BUNDLE_ID } from "../../shared/owner-trust/protocol.ts";
import { LOCAL_OWNER_ANCHOR_ACCOUNT, LOCAL_OWNER_ANCHOR_SERVICE, sameCertPin } from "../../shared/owner-trust/signing-policy.ts";

export interface ApplicationIdentity {
  bundleId: string | null;
  teamId: string | null;
  signed: boolean;
  adhoc: boolean;
  trustClass: "production" | "qa-dev" | "unestablished";
  source: string;
  certSha256?: string | null;
  anchorSha256?: string | null;
  authority?: string | null;
}

export function classifySignature(input: {
  bundleId: string | null;
  teamId: string | null;
  signed: boolean;
  adhoc: boolean;
  certSha256?: string | null;
  anchorSha256?: string | null;
}): ApplicationIdentity["trustClass"] {
  if (input.bundleId === QA_BUNDLE_ID && input.signed) return "qa-dev";
  if (!input.signed || input.adhoc || input.bundleId !== PRODUCTION_BUNDLE_ID) return "unestablished";
  if (!sameCertPin(input.certSha256, input.anchorSha256)) return "unestablished";
  return "production";
}

export function identityFromCodesign(
  text: string,
  bundleId: string | null,
  source: string,
  pins: { certSha256?: string | null; anchorSha256?: string | null; sealValid?: boolean } = {},
): ApplicationIdentity {
  const codesignIdentifier = /Identifier=([^\n]+)/.exec(text)?.[1]?.trim() ?? null;
  // Info.plist is the application identity. The Electrobun launcher executable
  // is signed as "launcher" and must not replace CFBundleIdentifier.
  const identifier = bundleId ?? codesignIdentifier;
  const team = /TeamIdentifier=([^\n]+)/.exec(text)?.[1]?.trim() ?? null;
  const sealValid = pins.sealValid !== false;
  const signed = sealValid && (/Signature=/.test(text) || /Authority=/.test(text) || /CodeDirectory/.test(text));
  // `TeamIdentifier=not set` is normal for a self-signed certificate.
  // Only an explicit ad-hoc signature is ad-hoc.
  const adhoc = /Signature=adhoc/.test(text);
  const identifierMismatch = Boolean(!adhoc && bundleId === PRODUCTION_BUNDLE_ID && codesignIdentifier && codesignIdentifier !== PRODUCTION_BUNDLE_ID);
  const resolvedTeam = team && team !== "not set" ? team : null;
  const authority = /Authority=([^\n]+)/.exec(text)?.[1]?.trim() ?? null;
  const certSha256 = pins.certSha256 ?? null;
  const anchorSha256 = pins.anchorSha256 ?? null;
  return {
    bundleId: identifier || null,
    teamId: resolvedTeam,
    signed: signed && !identifierMismatch,
    adhoc,
    trustClass: classifySignature({
      bundleId: identifier || null,
      teamId: resolvedTeam,
      signed: signed && !identifierMismatch,
      adhoc,
      certSha256,
      anchorSha256,
    }),
    source,
    certSha256,
    anchorSha256,
    authority,
  };
}

function plistBundleId(plist: string): string | null {
  return /<key>CFBundleIdentifier<\/key>\s*<string>([^<]+)<\/string>/.exec(plist)?.[1] ?? null;
}

export function bundleRootFor(start: string): { root: string; bundleId: string } | null {
  let current = path.resolve(start);
  for (let depth = 0; depth < 8; depth += 1) {
    const plist = path.join(current, "Contents", "Info.plist");
    if (existsSync(plist)) {
      try {
        const bundleId = plistBundleId(readFileSync(plist, "utf8"));
        if (bundleId) return { root: current, bundleId };
      } catch {
        return null;
      }
    }
    const parent = path.dirname(current);
    if (parent === current) break;
    current = parent;
  }
  return null;
}

export function leafCertificateSha256(target: string): string | null {
  if (process.platform !== "darwin" || !existsSync(target)) return null;
  const dir = mkdtempSync(path.join(tmpdir(), "fo-leaf-"));
  try {
    const prefix = path.join(dir, "cert");
    spawnSync("codesign", ["--display", `--extract-certificates=${prefix}`, target], { encoding: "utf8" });
    const leaf = `${prefix}0`;
    if (!existsSync(leaf)) return null;
    return createHash("sha256").update(readFileSync(leaf)).digest("hex");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

export function leafCertificateSha1(target: string): string | null {
  if (process.platform !== "darwin" || !existsSync(target)) return null;
  const dir = mkdtempSync(path.join(tmpdir(), "fo-leaf-"));
  try {
    const prefix = path.join(dir, "cert");
    spawnSync("codesign", ["--display", `--extract-certificates=${prefix}`, target], { encoding: "utf8" });
    const leaf = `${prefix}0`;
    if (!existsSync(leaf)) return null;
    return createHash("sha1").update(readFileSync(leaf)).digest("hex").toUpperCase();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** Real OS home directory even when HOME/USER are redirected or absent in QA/Finder launches. */
export function realUserHome(): string | null {
  try {
    const info = userInfo();
    if (process.platform === "darwin") {
      const uid = typeof process.getuid === "function" ? process.getuid() : info.uid;
      if (typeof uid === "number" && uid >= 0) {
        const ds = spawnSync("/usr/bin/dscacheutil", ["-q", "user", "-a", "uid", String(uid)], { encoding: "utf8" });
        if (ds.status === 0) {
          const dir = /^dir:\s*(.+)$/m.exec(ds.stdout ?? "")?.[1]?.trim();
          if (dir && path.isAbsolute(dir)) return dir;
        }
      }
    }
    return info.homedir || null;
  } catch {
    return process.env.HOME || null;
  }
}

/** Public fingerprint of the Owner anchor. Missing, malformed, and non-macOS results are null. */
export function readLocalOwnerAnchor(): string | null {
  if (process.platform !== "darwin") return null;
  const query = (keychain?: string): string | null => {
    const args = [
      "find-generic-password", "-s", LOCAL_OWNER_ANCHOR_SERVICE, "-a", LOCAL_OWNER_ANCHOR_ACCOUNT, "-w",
      ...(keychain ? [keychain] : []),
    ];
    const result = spawnSync("security", args, { encoding: "utf8" });
    if (result.status !== 0) return null;
    const value = result.stdout.trim().toLowerCase();
    return /^[0-9a-f]{64}$/.test(value) ? value : null;
  };
  const direct = query();
  if (direct) return direct;
  const home = realUserHome();
  if (home) {
    const loginKeychain = path.join(home, "Library", "Keychains", "login.keychain-db");
    if (existsSync(loginKeychain)) return query(loginKeychain);
  }
  return null;
}

export function readApplicationIdentity(execPath = process.execPath): ApplicationIdentity {
  const bundle = bundleRootFor(execPath);
  if (!bundle || process.platform !== "darwin") {
    return { bundleId: bundle?.bundleId ?? null, teamId: null, signed: false, adhoc: false, trustClass: "unestablished", source: execPath, certSha256: null, anchorSha256: null, authority: null };
  }
  const result = spawnSync("codesign", ["-dv", "--verbose=4", bundle.root], { encoding: "utf8" });
  const text = `${result.stdout ?? ""}\n${result.stderr ?? ""}`;
  const certSha256 = leafCertificateSha256(bundle.root);
  const anchorSha256 = readLocalOwnerAnchor();
  if (!text.trim()) {
    return { bundleId: bundle.bundleId, teamId: null, signed: false, adhoc: false, trustClass: "unestablished", source: bundle.root, certSha256, anchorSha256, authority: null };
  }
  const sealValid = bundle.bundleId === PRODUCTION_BUNDLE_ID && !/Signature=adhoc/.test(text) && sameCertPin(certSha256, anchorSha256)
    ? spawnSync("codesign", ["--verify", "--strict", bundle.root], { encoding: "utf8" }).status === 0
    : true;
  return identityFromCodesign(text, bundle.bundleId, bundle.root, { certSha256, anchorSha256, sealValid });
}
