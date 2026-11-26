/**
 * Verifies a ForgeOrbit bundle against a local signing certificate.
 * A matching test certificate is not the Owner anchor.
 * This module does not create keys and does not enroll the Owner.
 */
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import { PRODUCTION_BUNDLE_ID, QA_BUNDLE_ID } from "../../shared/owner-trust/protocol.ts";
import {
  HELPER_BUNDLE_RELATIVE_PATH,
  LOCAL_OWNER_CERT_CN,
  PRODUCTION_HELPER_ID,
  QA_HELPER_ID,
  sameCertPin,
} from "../../shared/owner-trust/signing-policy.ts";
import { identityFromCodesign, leafCertificateSha1, leafCertificateSha256, readLocalOwnerAnchor } from "./identity.ts";

export interface LocalSignatureReport {
  ok: boolean;
  authoritative: boolean;
  code: string;
  reason: string;
  bundleId: string | null;
  helperId: string | null;
  adhoc: boolean;
  helperAdhoc: boolean;
  appCertSha256: string | null;
  helperCertSha256: string | null;
  anchorSha256: string | null;
  authority: string | null;
  teamId: string | null;
  requirementOk: boolean;
  verifyOk: boolean;
  helperVerifyOk: boolean;
}

function codesignText(target: string): string {
  const result = spawnSync("codesign", ["-dv", "--verbose=4", target], { encoding: "utf8" });
  return `${result.stdout ?? ""}\n${result.stderr ?? ""}`;
}

function verifyStrict(target: string, requirement?: string): boolean {
  const args = ["--verify", "--strict", "--verbose=2"];
  if (requirement) args.push("-R", requirement.startsWith("=") ? requirement : `=${requirement}`);
  args.push(target);
  return spawnSync("codesign", args, { encoding: "utf8" }).status === 0;
}

function plistBundleId(app: string): string | null {
  const result = spawnSync("plutil", ["-extract", "CFBundleIdentifier", "raw", path.join(app, "Contents/Info.plist")], { encoding: "utf8" });
  const value = result.stdout?.trim();
  return value || null;
}

export function evaluateLocalSignature(app: string, options: { anchor?: string | null; requireOwnerCn?: boolean } = {}): LocalSignatureReport {
  const requireOwnerCn = options.requireOwnerCn !== false;
  const helper = path.join(app, HELPER_BUNDLE_RELATIVE_PATH);
  const bundleId = existsSync(path.join(app, "Contents/Info.plist")) ? plistBundleId(app) : null;
  const anchor = options.anchor === undefined ? readLocalOwnerAnchor() : options.anchor;
  const empty = (code: string, reason: string): LocalSignatureReport => ({
    ok: false,
    authoritative: false,
    code,
    reason,
    bundleId,
    helperId: null,
    adhoc: false,
    helperAdhoc: false,
    appCertSha256: null,
    helperCertSha256: null,
    anchorSha256: anchor,
    authority: null,
    teamId: null,
    requirementOk: false,
    verifyOk: false,
    helperVerifyOk: false,
  });
  if (!existsSync(app)) return empty("application-missing", "The application bundle does not exist.");
  if (bundleId === QA_BUNDLE_ID) return empty("qa-identity-rejected", "A QA bundle cannot be the local Owner identity.");
  if (bundleId !== PRODUCTION_BUNDLE_ID) return empty("application-identity-unestablished", "The bundle identifier is not app.forgeorbit.");
  if (!existsSync(helper)) return empty("helper-missing", "The Owner helper is not embedded.");
  const appIdentity = identityFromCodesign(codesignText(app), bundleId, app, { certSha256: leafCertificateSha256(app), anchorSha256: anchor });
  const helperText = codesignText(helper);
  const helperIdentity = identityFromCodesign(helperText, null, helper, { certSha256: leafCertificateSha256(helper), anchorSha256: anchor });
  const helperId = /Identifier=([^\n]+)/.exec(helperText)?.[1]?.trim() ?? helperIdentity.bundleId;
  const appSha1 = leafCertificateSha1(app);
  const helperSha1 = leafCertificateSha1(helper);
  const appRequirement = appSha1 ? `identifier "${PRODUCTION_BUNDLE_ID}" and certificate leaf = H"${appSha1}"` : undefined;
  const helperRequirement = helperSha1 ? `identifier "${PRODUCTION_HELPER_ID}" and certificate leaf = H"${helperSha1}"` : undefined;
  const verifyOk = verifyStrict(app);
  const helperVerifyOk = verifyStrict(helper);
  const requirementOk = Boolean(appRequirement && helperRequirement && verifyStrict(app, appRequirement) && verifyStrict(helper, helperRequirement));
  const base = {
    bundleId,
    helperId,
    adhoc: appIdentity.adhoc,
    helperAdhoc: helperIdentity.adhoc,
    appCertSha256: appIdentity.certSha256 ?? null,
    helperCertSha256: helperIdentity.certSha256 ?? null,
    anchorSha256: anchor,
    authority: appIdentity.authority ?? null,
    teamId: appIdentity.teamId,
    requirementOk,
    verifyOk,
    helperVerifyOk,
  };
  const refuse = (code: string, reason: string): LocalSignatureReport => ({ ok: false, authoritative: false, code, reason, ...base });
  if (appIdentity.adhoc || !appIdentity.signed || helperIdentity.adhoc || !helperIdentity.signed) {
    return refuse("unsigned-or-adhoc", "An ad-hoc or unsigned bundle is not the local Owner identity.");
  }
  if (helperId !== PRODUCTION_HELPER_ID) return refuse("helper-identity-mismatch", "The embedded helper identifier is not app.forgeorbit.owner-trust.");
  if (!sameCertPin(base.appCertSha256, base.helperCertSha256)) {
    return refuse("helper-identity-mismatch", "The helper certificate does not match the application certificate.");
  }
  if (!verifyOk || !helperVerifyOk) return refuse("signature-invalid", "codesign --verify --strict rejected the application or the helper.");
  if (!requirementOk) return refuse("requirement-mismatch", "The designated certificate requirement does not match the signed identifier.");
  if (!sameCertPin(base.appCertSha256, anchor)) {
    return refuse("anchor-mismatch", "The signing certificate does not match the local Owner anchor.");
  }
  const ownerCn = base.authority === LOCAL_OWNER_CERT_CN;
  if (requireOwnerCn && !ownerCn) {
    return refuse("untrusted-authority", "The certificate is not the ForgeOrbit Local Owner identity.");
  }
  return {
    ok: true,
    authoritative: ownerCn && options.anchor === undefined,
    code: ownerCn && options.anchor === undefined ? "local-owner-verified" : "signature-verified-not-authoritative",
    reason: ownerCn && options.anchor === undefined
      ? "The bundle matches the login-keychain Owner anchor. This is not Owner enrollment."
      : "The bundle matches the supplied certificate pin. It is not the Owner anchor.",
    ...base,
  };
}

export { QA_HELPER_ID };
