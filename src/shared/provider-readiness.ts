/**
 * FO-PROVIDERS-READY01: honest readiness for Cursor and DeepSeek.
 *
 * A provider is executable only when its own runtime requirements hold
 * inside ForgeOrbit's containment. Model catalogs, CLI login, and an outer
 * Seatbelt probe are separate facts. None of them is a successful inference.
 */

export const PROVIDER_READINESS_LADDER = [
  "installed",
  "authenticated",
  "model-discoverable",
  "runtime-compatible",
  "kernel-contained",
  "executable",
  "real-inference-verified",
] as const;

export type ProviderReadinessStep = (typeof PROVIDER_READINESS_LADDER)[number];

export const CURSOR_INTERNAL_SANDBOX_BLOCKER =
  "Cursor is not executable. Its required sandbox checks that /usr/bin/sandbox-exec is executable, then applies a nested seatbelt through the colocated cursorsandbox helper. ForgeOrbit's outer Seatbelt allows process execution only for the bundled Node binary and /usr/bin/security, so that check returns EPERM and the CLI exits with \"Sandbox mode is enabled but not available on this system.\" Granting execute on sandbox-exec makes the check pass, and macOS then returns sandbox_apply: Operation not permitted. The required sandbox cannot initialize under the required policy. Execution stays blocked.";

export const CURSOR_ACCOUNT_BINDING =
  "Cursor uses the active macOS Keychain login. ForgeOrbit does not substitute that identity for a different requested account.";

export const CURSOR_LAST_OUTCOME =
  "FO-CURSOR05: one authorized inference exited 1 with no model response. This milestone rechecked sandbox startup offline and did not send a model request.";

export const DEEPSEEK_CONTAINMENT_BLOCKER =
  "DeepSeek is not executable. Assessed DSH 0.2.1-rc.5 and 0.2.2-rc.1 leave project reads unconfined, and a path Seatbelt still allows a hard link inside the project to read and, for Developer, write an outside inode. Inherited file descriptors and setsid descendants are not contained. No multi-account adapter exists. Quota is Unknown. Developer and Reviewer execution stays blocked.";

export const DEEPSEEK_ACCOUNT_BINDING =
  "No DeepSeek account adapter is registered. Authentication stays Unknown. A requested account is not invented or substituted.";

export const DEEPSEEK_LAST_OUTCOME =
  "FO-DEEPSEEK03: path containment passed ordinary checks and failed hard-link, inherited-descriptor, and setsid cases. This milestone reproduced the hard-link read. No DSH process and no model request were started.";

/** Real Cursor and DeepSeek launches stay refused. Fake drivers are unaffected. */
export function cursorRealExecutionBlock(): string {
  return CURSOR_INTERNAL_SANDBOX_BLOCKER;
}

export function deepseekRealExecutionBlock(): string {
  return DEEPSEEK_CONTAINMENT_BLOCKER;
}

export interface ProviderDiagnostic {
  id: "cursor" | "deepseek-dsh";
  label: string;
  version: string | null;
  installed: boolean;
  /** CLI login is not AccountCore selection and is not execution readiness. */
  authentication: "unknown" | "cli-reported" | "absent";
  modelDiscovery: "not-checked" | "previously-observed" | "none-verified";
  runtimeCompatible: false;
  /** Outer Seatbelt facts are not a claim that the provider's own sandbox works. */
  kernelContainment: "outer-policy-only" | "not-verified";
  executable: false;
  realInferenceVerified: false;
  sandboxCompatibility: "incompatible" | "not-verified";
  accountBinding: "ambient-keychain" | "none";
  quota: "unknown";
  developerMode: "blocked";
  reviewerMode: "blocked";
  blockers: readonly string[];
  lastOutcome: "cursor-sandbox-startup" | "deepseek-containment";
}

export function cursorProviderDiagnostic(input: {
  installed: boolean;
  version: string | null;
  loggedIn: boolean | null;
}): ProviderDiagnostic {
  return {
    id: "cursor",
    label: "Cursor",
    version: input.version,
    installed: input.installed,
    authentication: input.loggedIn === true ? "cli-reported" : input.loggedIn === false ? "absent" : "unknown",
    modelDiscovery: "previously-observed",
    runtimeCompatible: false,
    kernelContainment: "outer-policy-only",
    executable: false,
    realInferenceVerified: false,
    sandboxCompatibility: "incompatible",
    accountBinding: "ambient-keychain",
    quota: "unknown",
    developerMode: "blocked",
    reviewerMode: "blocked",
    blockers: ["cursor-internal-sandbox"],
    lastOutcome: "cursor-sandbox-startup",
  };
}

export function deepseekProviderDiagnostic(input: {
  installed: boolean;
  version: string | null;
}): ProviderDiagnostic {
  return {
    id: "deepseek-dsh",
    label: "DeepSeek Harness",
    version: input.version,
    installed: input.installed,
    authentication: "unknown",
    modelDiscovery: "none-verified",
    runtimeCompatible: false,
    kernelContainment: "not-verified",
    executable: false,
    realInferenceVerified: false,
    sandboxCompatibility: "not-verified",
    accountBinding: "none",
    quota: "unknown",
    developerMode: "blocked",
    reviewerMode: "blocked",
    blockers: ["deepseek-containment"],
    lastOutcome: "deepseek-containment",
  };
}

/** Classifies the offline startup probe. A passing access check is still incompatible. */
export function classifyCursorSandboxProbe(probe: {
  sandboxExecAccess: string;
  nestedApply: "not-attempted" | "denied" | "applied" | "error";
}): { compatible: false; reason: string } {
  if (probe.nestedApply === "applied") {
    return {
      compatible: false,
      reason: "Nested sandbox_apply returned success. That is not accepted as containment, because a replacement profile could drop ForgeOrbit's file rules. Execution stays blocked.",
    };
  }
  if (probe.sandboxExecAccess === "EPERM") {
    return {
      compatible: false,
      reason: "Under the production Seatbelt, access(X_OK) on /usr/bin/sandbox-exec returns EPERM. Cursor treats that as sandbox unavailable.",
    };
  }
  if (probe.nestedApply === "denied") {
    return {
      compatible: false,
      reason: "sandbox-exec is executable and sandbox_apply returns Operation not permitted. Cursor's required sandbox still cannot start.",
    };
  }
  return {
    compatible: false,
    reason: "Cursor's internal sandbox did not demonstrate a compatible startup. Execution stays blocked.",
  };
}
