/**
 * Resolves the embedded Owner helper.
 * An environment path, a PATH lookup, and a symlink that leaves the bundle
 * are ignored. Production approval uses only the copy inside the app bundle.
 */
import { spawnSync } from "node:child_process";
import { existsSync, lstatSync, realpathSync } from "node:fs";
import path from "node:path";
import { bundleRootFor, identityFromCodesign, leafCertificateSha256, type ApplicationIdentity } from "./identity.ts";
import { HELPER_BUNDLE_RELATIVE_PATH, PRODUCTION_HELPER_ID, QA_HELPER_ID, sameCertPin } from "../../shared/owner-trust/signing-policy.ts";
import { PRODUCTION_BUNDLE_ID, QA_BUNDLE_ID } from "../../shared/owner-trust/protocol.ts";

export const OWNER_TRUST_HELPER_ENV = "FORGEORBIT_OWNER_TRUST_HELPER";

export interface HelperAssessment {
  ok: boolean;
  code: string;
  reason: string;
  path: string | null;
  identifier: string | null;
  teamId: string | null;
  adhoc: boolean;
  signed: boolean;
  insideBundle: boolean;
  certSha256: string | null;
}

export function expectedHelperId(bundleId: string | null): string | null {
  if (bundleId === PRODUCTION_BUNDLE_ID) return PRODUCTION_HELPER_ID;
  if (bundleId === QA_BUNDLE_ID) return QA_HELPER_ID;
  return null;
}

export function bundledHelperPath(execPath = process.execPath): string | null {
  const bundle = bundleRootFor(execPath);
  if (!bundle) return null;
  return path.join(bundle.root, HELPER_BUNDLE_RELATIVE_PATH);
}

export function developmentHelperPath(): string {
  return path.resolve(import.meta.dir, "../../../vendor/owner-trust/forgeorbit-owner-trust");
}

export function assessHelperCandidate(input: {
  purpose: "status" | "approve";
  bundleId: string | null;
  bundleRoot: string | null;
  appTeamId: string | null;
  appAdhoc: boolean;
  appSigned: boolean;
  appCertSha256?: string | null;
  anchorSha256?: string | null;
  helperCertSha256?: string | null;
  candidate: string | null;
  envOverride: string | null;
  codesignText: string;
  helperVerifyOk?: boolean;
}): HelperAssessment {
  const refuse = (code: string, reason: string, extra?: Partial<HelperAssessment>): HelperAssessment => ({
    ok: false,
    code,
    reason,
    path: extra?.path ?? null,
    identifier: extra?.identifier ?? null,
    teamId: extra?.teamId ?? null,
    adhoc: extra?.adhoc ?? false,
    signed: extra?.signed ?? false,
    insideBundle: false,
    certSha256: extra?.certSha256 ?? null,
  });
  if (input.envOverride) {
    return refuse("helper-path-override-rejected", "An environment path cannot select the Owner helper.");
  }
  if (!input.candidate) return refuse("native-helper-unavailable", "The native Owner helper is not embedded in this application.");
  let real = input.candidate;
  try {
    if (!existsSync(input.candidate)) return refuse("native-helper-unavailable", "The native Owner helper is not embedded in this application.");
    const stat = lstatSync(input.candidate);
    real = realpathSync(input.candidate);
    if (stat.isSymbolicLink() && real !== input.candidate) {
      const root = input.bundleRoot ? realpathSync(input.bundleRoot) : null;
      if (!root || !real.startsWith(root + path.sep)) {
        return refuse("helper-path-rejected", "The Owner helper symlink leaves the application bundle.", { path: real });
      }
    }
  } catch {
    return refuse("native-helper-unavailable", "The native Owner helper path could not be read.");
  }
  const expectedInside = input.bundleRoot ? path.join(input.bundleRoot, HELPER_BUNDLE_RELATIVE_PATH) : null;
  let inside = false;
  if (expectedInside) {
    try { inside = realpathSync(expectedInside) === real; } catch { inside = false; }
  }
  const identity = identityFromCodesign(input.codesignText, null, real);
  const identifier = /Identifier=([^\n]+)/.exec(input.codesignText)?.[1]?.trim() ?? identity.bundleId;
  const base = {
    path: real,
    identifier,
    teamId: identity.teamId,
    adhoc: identity.adhoc,
    signed: identity.signed,
    insideBundle: inside,
    certSha256: input.helperCertSha256 ?? null,
  };
  if (!identity.signed) {
    return refuse("helper-unsigned", "The Owner helper has no code signature.", base);
  }
  if (input.purpose === "approve" && !inside) {
    return refuse("helper-path-rejected", "Approval can use only the helper embedded in this application.", base);
  }
  const expected = expectedHelperId(input.bundleId);
  if (input.purpose === "approve" && input.bundleId === PRODUCTION_BUNDLE_ID) {
    if (!input.appSigned || input.appAdhoc || !sameCertPin(input.appCertSha256, input.anchorSha256)) {
      return refuse("application-identity-unestablished", "This application is not signed by the pinned local Owner certificate.", base);
    }
    if (identity.adhoc || identifier !== PRODUCTION_HELPER_ID || !sameCertPin(input.helperCertSha256, input.appCertSha256) || input.helperVerifyOk === false) {
      return refuse("helper-identity-mismatch", "The embedded helper is not signed by the same local Owner certificate.", base);
    }
    if (input.appTeamId && identity.teamId && input.appTeamId !== identity.teamId) {
      return refuse("helper-team-mismatch", "The helper TeamIdentifier does not match the application.", base);
    }
  }
  if (input.purpose === "approve" && input.bundleId === QA_BUNDLE_ID) {
    if (identifier !== QA_HELPER_ID) {
      return refuse("helper-identity-mismatch", "The QA application requires its own helper identity.", base);
    }
    if (Boolean(identity.teamId) !== Boolean(input.appTeamId) || (identity.teamId && identity.teamId !== input.appTeamId)) {
      return refuse("helper-team-mismatch", "The helper TeamIdentifier does not match the QA application.", base);
    }
  }
  if (input.purpose === "approve" && !expected) {
    return refuse("caller-identity-rejected", "This process is not the ForgeOrbit application. It cannot request Owner approval.", base);
  }
  if (expected && identifier && identifier !== expected) {
    return refuse("helper-identity-mismatch", "The helper identifier does not match this application.", base);
  }
  return {
    ok: true,
    code: "helper-ok",
    reason: "The helper identity matches this application.",
    ...base,
    insideBundle: inside,
  };
}

export function codesignText(target: string): string {
  const result = spawnSync("codesign", ["-dv", "--verbose=4", target], { encoding: "utf8" });
  return `${result.stdout ?? ""}\n${result.stderr ?? ""}`;
}

export function assessInstalledHelper(purpose: "status" | "approve", app: ApplicationIdentity, execPath = process.execPath): HelperAssessment {
  if (process.env[OWNER_TRUST_HELPER_ENV]) {
    return assessHelperCandidate({
      purpose,
      bundleId: app.bundleId,
      bundleRoot: bundleRootFor(execPath)?.root ?? null,
      appTeamId: app.teamId,
      appAdhoc: app.adhoc,
      appSigned: app.signed,
      appCertSha256: app.certSha256,
      anchorSha256: app.anchorSha256,
      candidate: null,
      envOverride: process.env[OWNER_TRUST_HELPER_ENV] ?? null,
      codesignText: "",
    });
  }
  const bundled = bundledHelperPath(execPath);
  const candidate = purpose === "approve"
    ? bundled
    : (bundled && existsSync(bundled) ? bundled : developmentHelperPath());
  const exists = Boolean(candidate && existsSync(candidate));
  const helperVerifyOk = purpose === "approve" && app.bundleId === PRODUCTION_BUNDLE_ID && exists && process.platform === "darwin"
    ? spawnSync("codesign", ["--verify", "--strict", candidate!], { encoding: "utf8" }).status === 0
    : true;
  return assessHelperCandidate({
    purpose,
    bundleId: app.bundleId,
    bundleRoot: bundleRootFor(execPath)?.root ?? null,
    appTeamId: app.teamId,
    appAdhoc: app.adhoc,
    appSigned: app.signed,
    appCertSha256: app.certSha256,
    anchorSha256: app.anchorSha256,
    helperCertSha256: exists ? leafCertificateSha256(candidate!) : null,
    candidate: exists ? candidate : null,
    envOverride: null,
    codesignText: exists ? codesignText(candidate!) : "",
    helperVerifyOk,
  });
}
