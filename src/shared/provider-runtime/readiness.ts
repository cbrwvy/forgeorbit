/**
 * Owner-facing readiness. executableNow is false until a future authorized
 * live run. A catalog, a binary, or a CLI login is not that run.
 */
import { PROVIDER_RUNTIME_CONTRACTS, PROVIDER_RUNTIME_IDS, type ProviderRuntimeId } from "./contract.ts";

export type ReadinessFlag = "yes" | "no" | "unknown";

export interface RuntimeReadiness {
  providerId: ProviderRuntimeId;
  label: string;
  installed: ReadinessFlag;
  cliVersion: string | null;
  adapterVersion: string;
  authentication: "unknown" | "cli-reported" | "absent";
  accountBinding: "exact-profile" | "partial" | "ambient-blocked" | "none" | "gateway";
  identity: "unknown";
  models: "unknown" | "catalog-only";
  developer: "needs-authorization" | "blocked" | "missing-cli";
  reviewer: "needs-authorization" | "blocked" | "missing-cli";
  sandbox: "outer-seatbelt" | "incompatible" | "not-verified" | "provider-policy";
  blockerCodes: string[];
  quotaSource: "unknown" | "recorded-percent" | "run-telemetry";
  authorizedExecution: "not-authorized";
  genuineExecution: "not-verified";
  executableNow: false;
  /** What the harness's launch resolves to, from the same resolver the launch uses (Direction 9). Null for a provider with no harness here. */
  launchTarget: import("../provider-launch-target.ts").LaunchTargetFacts | null;
}

const LABELS: Record<ProviderRuntimeId, string> = {
  codex: "Codex",
  "claude-code": "Claude Code",
  cursor: "Cursor",
  antigravity: "Antigravity",
  gemini: "Gemini CLI",
  fx: "fx",
  "deepseek-dsh": "DeepSeek DSH",
};

export function readinessFor(input: {
  providerId: ProviderRuntimeId;
  installed: boolean | null;
  cliVersion?: string | null;
  authentication?: "unknown" | "cli-reported" | "absent";
  launchTarget?: import("../provider-launch-target.ts").LaunchTargetFacts | null;
}): RuntimeReadiness {
  const contract = PROVIDER_RUNTIME_CONTRACTS[input.providerId];
  const installed: ReadinessFlag = input.installed == null ? "unknown" : input.installed ? "yes" : "no";
  const blocked = input.providerId === "cursor" || input.providerId === "deepseek-dsh";
  const missing = installed === "no";
  const eligibility = blocked ? "blocked" : missing ? "missing-cli" : "needs-authorization";
  const blockerCodes = ["live-not-authorized", "owner-proof-required", "identity-unknown"];
  if (blocked) blockerCodes.push(input.providerId === "cursor" ? "cursor-sandbox" : "deepseek-containment");
  if (input.providerId === "claude-code") blockerCodes.push("claude-partial-isolation");
  if (input.providerId === "fx") blockerCodes.push("fx-gateway");
  if (missing) blockerCodes.push("missing-cli");
  if (contract.quotaDataVerified === false) blockerCodes.push("quota-unknown");
  return {
    providerId: input.providerId,
    label: LABELS[input.providerId],
    installed,
    cliVersion: input.cliVersion ?? null,
    adapterVersion: contract.adapterVersion,
    authentication: input.authentication ?? "unknown",
    accountBinding: contract.isolation === "exact-profile" ? "exact-profile"
      : contract.isolation === "partial-serialize" ? "partial"
        : contract.isolation === "ambient-blocked" ? "ambient-blocked"
          : contract.isolation === "gateway-not-upstream" ? "gateway"
            : "none",
    identity: "unknown",
    models: "unknown",
    developer: eligibility,
    reviewer: eligibility,
    sandbox: input.providerId === "cursor" ? "incompatible"
      : input.providerId === "deepseek-dsh" ? "not-verified"
        : input.providerId === "codex" ? "outer-seatbelt"
          : "provider-policy",
    blockerCodes,
    quotaSource: input.providerId === "codex" ? "recorded-percent" : input.providerId === "claude-code" ? "run-telemetry" : "unknown",
    authorizedExecution: "not-authorized",
    genuineExecution: "not-verified",
    executableNow: false,
    launchTarget: input.launchTarget ?? null,
  };
}

export function readinessMatrix(probes: Partial<Record<ProviderRuntimeId, { installed: boolean | null; cliVersion?: string | null; authentication?: RuntimeReadiness["authentication"]; launchTarget?: RuntimeReadiness["launchTarget"] }>>): RuntimeReadiness[] {
  return PROVIDER_RUNTIME_IDS.map((providerId) => readinessFor({ providerId, installed: probes[providerId]?.installed ?? null, cliVersion: probes[providerId]?.cliVersion, authentication: probes[providerId]?.authentication, launchTarget: probes[providerId]?.launchTarget }));
}
