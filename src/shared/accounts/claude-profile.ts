/** Claude config-directory reference. Never contains credentials or a verified subject. */
export interface ClaudeProfile {
  harnessId: string;
  directory: string;
  /** Detect directory replacement without reading authentication data. */
  directoryIdentity: string;
  /**
   * Explicit Owner acceptance of the existing disclosure: Claude authentication
   * may still consult the login credential store. Never implied by registration.
   */
  homeAccessAccepted: boolean;
}

export const CLAUDE_PROFILE_SUPPORT = "partial" as const;

export const CLAUDE_PROFILE_LIMITATIONS = [
  "PARTIAL. CLAUDE_CONFIG_DIR selects this profile's config and session directory.",
  "A successful auth status does not prove a distinct provider subject. The subject stays Unknown.",
  "Credential-store isolation is not established: macOS Keychain and ~/.claude.json are not isolated by CLAUDE_CONFIG_DIR alone. ForgeOrbit does not read the keychain or copy credentials.",
  "Launch stays blocked until the Owner accepts the existing HOME-access disclosure for this profile. Acceptance does not grant a broader filesystem policy.",
] as const;

export interface ClaudeProfileView {
  accountId: string;
  displayName: string;
  harnessId: string;
  directory: string;
  homeAccessAccepted: boolean;
  support: "partial";
  authentication: "unknown" | "authenticated" | "required" | "unavailable";
  availability: "unchecked" | "ready" | "unavailable" | "authentication-required" | "acceptance-required";
  checkedAt: number | null;
  verifiedSubject: null;
  limitations: string[];
  /** The executable this profile's launch resolves to (Direction 9). Added by the account routes. */
  launchTarget?: import("../provider-launch-target.ts").LaunchTargetFacts | null;
  setupCommand: string;
}
