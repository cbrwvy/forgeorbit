/**
 * Reports whether the personal local Owner signing identity is present.
 * Certificate names and fingerprints are public metadata.
 * Private keys are not read, copied, or printed.
 * Developer ID and notarization are not required for this personal app.
 *
 * A personal self-signed certificate is not in the system trust store, so the
 * identity is looked up without `find-identity -v`. Trust comes from the
 * pinned login-keychain anchor, not from Gatekeeper.
 */
import { spawnSync } from "node:child_process";
import { PRODUCTION_BUNDLE_ID, QA_BUNDLE_ID } from "../src/shared/owner-trust/protocol.ts";
import {
  LOCAL_OWNER_CERT_CN,
  PRODUCTION_HELPER_ID,
  QA_HELPER_ID,
} from "../src/shared/owner-trust/signing-policy.ts";
import { readLocalOwnerAnchor } from "../src/bun/owner-trust/identity.ts";
import { certificatePins, findCodesigningIdentity, loginKeychainPath } from "./local-owner-identity.ts";

const result = spawnSync("security", ["find-identity", "-p", "codesigning"], { encoding: "utf8" });
const text = `${result.stdout ?? ""}\n${result.stderr ?? ""}`;
const identities = text.split("\n").map((line) => line.trim()).filter((line) => /^\d+\)/.test(line));
const login = loginKeychainPath();
const localOwner = Boolean(login && findCodesigningIdentity(LOCAL_OWNER_CERT_CN, login));
const pins = login ? certificatePins(LOCAL_OWNER_CERT_CN, login) : [];
const anchor = readLocalOwnerAnchor();
const pinned = anchor ? pins.find((pin) => pin.sha256 === anchor) ?? null : null;
const report = {
  product: "personal-use",
  statement: "ForgeOrbit is a personal-use macOS application. Public Apple distribution requirements are not part of the product.",
  productionBundleId: PRODUCTION_BUNDLE_ID,
  qaBundleId: QA_BUNDLE_ID,
  productionHelperId: PRODUCTION_HELPER_ID,
  qaHelperId: QA_HELPER_ID,
  localOwnerCommonName: LOCAL_OWNER_CERT_CN,
  localOwnerIdentityPresent: localOwner,
  localOwnerCertificateCount: pins.length,
  localOwnerCertificateSha256: pinned?.sha256 ?? pins[0]?.sha256 ?? null,
  localOwnerAnchorPresent: Boolean(anchor),
  anchorMatchesIdentity: Boolean(pinned),
  // The certificate is self-signed and not in the system trust store. The
  // sign script selects it by pinned fingerprint with `codesign --keychain`.
  gatekeeperTrustRequired: false,
  developerIdRequired: false,
  notarizationRequired: false,
  identities: identities.map((line) => line.replace(/[0-9A-F]{40}/, (hash) => `${hash.slice(0, 8)}…`)),
  productionSigning: localOwner && pinned ? "local-owner-ready" : "owner-action-required",
  notarization: "not part of personal use",
};
console.log(JSON.stringify(report, null, 2));
process.exit(0);
