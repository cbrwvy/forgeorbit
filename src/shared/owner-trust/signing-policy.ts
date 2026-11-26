/**
 * Build identity matrix for Owner trust.
 * The canonical production bundle id is the current app identifier,
 * `app.forgeorbit`. Any legacy non-canonical bundle identifier
 * (`app.forgeorbit.legacy`) stays outside this trust domain.
 * No Keychain or profile migration is performed.
 *
 * Personal-use production trust is a self-signed code-signing certificate
 * in the login keychain, pinned by SHA-256. It is not an Apple Developer ID
 * and it does not invent a TeamIdentifier.
 */
import { PRODUCTION_BUNDLE_ID, QA_BUNDLE_ID } from "./protocol.ts";

export const PRODUCTION_HELPER_ID = "app.forgeorbit.owner-trust";
export const QA_HELPER_ID = "app.forgeorbit.qa.owner-trust";
export const HISTORICAL_STABLE_BUNDLE_ID = "app.forgeorbit.legacy";
export const HELPER_BUNDLE_RELATIVE_PATH = "Contents/Resources/app/bin/forgeorbit-owner-trust";
export const PRODUCTION_KEYCHAIN_TAG = "app.forgeorbit.owner-trust.signing";
export const QA_KEYCHAIN_TAG = "app.forgeorbit.qa.owner-trust.signing";
export const LOCAL_OWNER_CERT_CN = "ForgeOrbit Local Owner";
export const LOCAL_OWNER_ANCHOR_SERVICE = "app.forgeorbit.local-owner-anchor";
export const LOCAL_OWNER_ANCHOR_ACCOUNT = "certificate-sha256";
export const TEST_SIGNING_CERT_CN = "ForgeOrbit Test Signing Fixture";

export type BuildIdentityChannel = "development" | "qa" | "production" | "stable";

export interface BuildIdentityRow {
  channel: BuildIdentityChannel;
  bundleId: string;
  signingRequirement: string;
  teamIdRequirement: string;
  helperId: string;
  keychainIdentity: string;
  trustEnrollment: string;
  providerExecution: string;
  qaFixture: string;
}

export const BUILD_IDENTITY_MATRIX: readonly BuildIdentityRow[] = [
  {
    channel: "development",
    bundleId: PRODUCTION_BUNDLE_ID,
    signingRequirement: "ad-hoc local seal; not the Owner certificate",
    teamIdRequirement: "none",
    helperId: PRODUCTION_HELPER_ID,
    keychainIdentity: "not eligible",
    trustEnrollment: "refused",
    providerExecution: "refused",
    qaFixture: "refused",
  },
  {
    channel: "qa",
    bundleId: QA_BUNDLE_ID,
    signingRequirement: "ad-hoc disposable seal; never the production identity",
    teamIdRequirement: "none",
    helperId: QA_HELPER_ID,
    keychainIdentity: QA_KEYCHAIN_TAG,
    trustEnrollment: "refused for production",
    providerExecution: "refused",
    qaFixture: "eligible inside the disposable profile",
  },
  {
    channel: "production",
    bundleId: PRODUCTION_BUNDLE_ID,
    signingRequirement: "login-keychain certificate ForgeOrbit Local Owner, leaf SHA-256 pinned outside the repo",
    teamIdRequirement: "none; a TeamIdentifier is not fabricated",
    helperId: PRODUCTION_HELPER_ID,
    keychainIdentity: PRODUCTION_KEYCHAIN_TAG,
    trustEnrollment: "eligible after an explicit Owner authentication",
    providerExecution: "eligible only after enrollment, a fresh proof, and the remaining policy checks",
    qaFixture: "refused",
  },
  {
    channel: "stable",
    bundleId: PRODUCTION_BUNDLE_ID,
    signingRequirement: "same local Owner certificate as production; Apple notarization is not a personal-use requirement",
    teamIdRequirement: "none; a TeamIdentifier is not fabricated",
    helperId: PRODUCTION_HELPER_ID,
    keychainIdentity: PRODUCTION_KEYCHAIN_TAG,
    trustEnrollment: "same production enrollment; a legacy app.forgeorbit.legacy bundle is not accepted",
    providerExecution: "same production gate",
    qaFixture: "refused",
  },
];

export interface SignatureClaim {
  bundleId: string | null;
  teamId: string | null;
  signed: boolean;
  adhoc: boolean;
  helperId: string | null;
  helperTeamId: string | null;
  helperAdhoc: boolean;
  helperSigned: boolean;
  helperInsideBundle: boolean;
  certSha256?: string | null;
  anchorSha256?: string | null;
  helperCertSha256?: string | null;
}

export function sameCertPin(left: string | null | undefined, right: string | null | undefined): boolean {
  if (!left || !right) return false;
  return /^[0-9a-f]{64}$/.test(left.toLowerCase()) && left.toLowerCase() === right.toLowerCase();
}

export function localOwnerIdentityEstablished(identity: {
  bundleId: string | null;
  trustClass: string;
  adhoc: boolean;
  signed: boolean;
  certSha256?: string | null;
  anchorSha256?: string | null;
}): boolean {
  return identity.trustClass === "production"
    && identity.signed
    && !identity.adhoc
    && identity.bundleId === PRODUCTION_BUNDLE_ID
    && sameCertPin(identity.certSha256, identity.anchorSha256);
}

export function productionSignatureAllowed(claim: SignatureClaim): { ok: true } | { ok: false; code: string; reason: string } {
  if (claim.bundleId === QA_BUNDLE_ID || claim.helperId === QA_HELPER_ID) {
    return { ok: false, code: "qa-identity-rejected", reason: "A QA identity cannot enter the production trust domain." };
  }
  if (claim.bundleId === HISTORICAL_STABLE_BUNDLE_ID) {
    return { ok: false, code: "historical-bundle-rejected", reason: "The historical stable bundle id is not the production Owner identity." };
  }
  if (!claim.signed || claim.adhoc || claim.bundleId !== PRODUCTION_BUNDLE_ID || !sameCertPin(claim.certSha256, claim.anchorSha256)) {
    return { ok: false, code: "application-identity-unestablished", reason: "Production requires app.forgeorbit signed by the pinned local Owner certificate. A TeamIdentifier is not accepted in its place." };
  }
  if (!claim.helperSigned || claim.helperAdhoc || !claim.helperInsideBundle || claim.helperId !== PRODUCTION_HELPER_ID) {
    return { ok: false, code: "helper-identity-mismatch", reason: "Production requires the embedded helper to be signed inside the application bundle." };
  }
  if (!sameCertPin(claim.helperCertSha256, claim.certSha256)) {
    return { ok: false, code: "helper-identity-mismatch", reason: "The helper certificate does not match the application certificate." };
  }
  if (claim.teamId && claim.helperTeamId && claim.teamId !== claim.helperTeamId) {
    return { ok: false, code: "helper-team-mismatch", reason: "The helper TeamIdentifier does not match the application." };
  }
  return { ok: true };
}
