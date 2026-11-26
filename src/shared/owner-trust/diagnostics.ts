/**
 * Owner-facing authorization state.
 * A development build, a QA build, and a machine that can show Touch ID
 * are not production ready. Authentication is a separate later step.
 */
import { HISTORICAL_STABLE_BUNDLE_ID } from "./signing-policy.ts";
import { PRODUCTION_BUNDLE_ID, QA_BUNDLE_ID } from "./protocol.ts";

export const OWNER_TRUST_STATES = [
  "development-or-qa",
  "unsigned-or-adhoc",
  "trusted-signature-missing",
  "helper-missing",
  "helper-identity-mismatch",
  "secure-enclave-unavailable",
  "owner-not-enrolled",
  "native-authentication-unavailable",
  "owner-authorization-pending",
  "authorization-refused",
  "ready-for-confirmation",
] as const;

export type OwnerTrustState = (typeof OWNER_TRUST_STATES)[number];

export interface OwnerTrustStateInput {
  bundleId: string | null;
  trustClass: string;
  adhoc: boolean;
  signed: boolean;
  teamId: string | null;
  helperPresent: boolean;
  helperOk: boolean;
  helperCode: string | null;
  secureEnclaveHardware: boolean | null;
  enrolled: boolean;
  enrollmentState: "none" | "active" | "revoked" | "restored-inactive";
  userAuthenticationAvailable: boolean | null;
  pending: boolean;
  refused: boolean;
}

export function classifyOwnerTrustState(input: OwnerTrustStateInput): OwnerTrustState {
  if (input.bundleId === QA_BUNDLE_ID || input.trustClass === "qa-dev") return "development-or-qa";
  if (input.bundleId === HISTORICAL_STABLE_BUNDLE_ID) return "trusted-signature-missing";
  if (!input.bundleId || input.trustClass === "unestablished" && !input.signed) return "development-or-qa";
  if (input.adhoc) return "unsigned-or-adhoc";
  if (input.bundleId !== PRODUCTION_BUNDLE_ID || input.trustClass !== "production") return "trusted-signature-missing";
  if (!input.helperPresent || input.helperCode === "native-helper-unavailable") return "helper-missing";
  if (!input.helperOk) return "helper-identity-mismatch";
  if (input.secureEnclaveHardware === false) return "secure-enclave-unavailable";
  if (input.enrollmentState === "revoked" || input.enrollmentState === "restored-inactive") return "authorization-refused";
  if (!input.enrolled) return "owner-not-enrolled";
  if (input.userAuthenticationAvailable === false) return "native-authentication-unavailable";
  if (input.refused) return "authorization-refused";
  if (input.pending) return "owner-authorization-pending";
  return "ready-for-confirmation";
}
