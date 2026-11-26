/** Execution configuration attached to AccountCore; never contains credentials. */
export interface CodexProfile {
  harnessId: string;
  directory: string;
  /** Detect directory replacement without reading authentication data. */
  directoryIdentity: string;
}
export interface CodexProfileView {
  accountId: string;
  displayName: string;
  harnessId: string;
  directory: string;
  authentication: "unknown" | "authenticated" | "required";
  availability: "unchecked" | "ready" | "unavailable" | "authentication-required";
  checkedAt: number | null;
  diagnostic?: "status-unrecognized" | "status-timeout" | "status-unavailable" | "recorded-fixture";
  quota: "unknown";
  /**
   * The latest provider refusal still standing for this account's harness, or null. A sign-in check
   * neither creates nor clears it: signed in and refused by the provider are different facts.
   */
  providerRefusal?: import("../provider-refusal.ts").ProviderRefusalSummary | null;
  /**
   * The executable this profile's launch resolves to and what is known about its version (Direction 9).
   * Added by the account routes; a read of the list starts no process (an unread version is "not checked").
   */
  launchTarget?: import("../provider-launch-target.ts").LaunchTargetFacts | null;
  setupCommand: string;
}

/** Shared by CLI execution and consented app-server inspections. */
export const CODEX_AUTH_ENV = ["OPENAI_API_KEY", "CODEX_API_KEY", "CODEX_ACCESS_TOKEN", "OPENAI_ACCESS_TOKEN", "OPENAI_IDENTITY_TOKEN_FILE", "OPENAI_FEDERATION_RULE_ID"];
export const CODEX_FILE_AUTH = ["-c", 'cli_auth_credentials_store="file"'];
export const CODEX_FILE_AUTH_ENV = "FORGEORBIT_CODEX_PROFILE_FILE_AUTH";
