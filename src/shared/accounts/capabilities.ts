import { QUOTA_SOURCES, type QuotaSourceCapability } from "./quota-sources.ts";
import { AGENT_OPTIONS, type AgentKind } from "../types.ts";
import type { SourceCapability } from "./types.ts";
export interface AccountSourceCapabilities {
  storedUsage: SourceCapability; liveQuota: SourceCapability; identityVerification: SourceCapability;
  modelVerification: SourceCapability;
  tokens?: "run-telemetry"; requests?: "upstream-report"; billing?: "upstream-report"; note: string; quotaSources?: readonly QuotaSourceCapability[];
}
const manual: AccountSourceCapabilities = {
  storedUsage: "unsupported", liveQuota: "user-provided-only", identityVerification: "unsupported",
  modelVerification: "unsupported", note: "No approved live connector in FO-009C. Manual metadata only.",
};
/** Capability of THIS integration, not a claim about all provider APIs. No discovery occurs here. */
export const ACCOUNT_SOURCE_CAPABILITIES: Record<AgentKind | "deepseek-dsh", AccountSourceCapabilities> = {
  "claude-code": { ...manual, tokens: "run-telemetry", storedUsage: "supported-safe", note: "Reads stored utilization and transcript aggregates only. Existing credential-based polling is not invoked or certified by this core." },
  codex: { ...manual, tokens: "run-telemetry", storedUsage: "supported-safe", note: "Reads stored meters only. Existing undocumented API and auth-file fallback are not approved identity mechanisms." },
  cursor: { ...manual, storedUsage: "supported-safe", note: "Reads stored meters only. Cookie extraction and undocumented endpoints are excluded." },
  gemini: { ...manual }, fx: { ...manual, tokens: "run-telemetry", requests: "upstream-report" }, antigravity: { ...manual },
  "deepseek-dsh": { ...manual },
};
export function accountSourceCapabilities(kind: string): AccountSourceCapabilities {
  return { ...(ACCOUNT_SOURCE_CAPABILITIES[kind as AgentKind | "deepseek-dsh"] ?? { ...manual, storedUsage: "unknown", liveQuota: "unknown", note: "Unknown harness kind." }),
    quotaSources: QUOTA_SOURCES.filter(source => source.id === "manual" || source.harnessKinds.includes(kind)) };
}

export const PROVIDER_FOR_HARNESS: Record<AgentKind | "deepseek-dsh", string> = {
  codex: "openai", "claude-code": "anthropic", gemini: "google", antigravity: "google",
  fx: "fx", cursor: "cursor", "deepseek-dsh": "deepseek",
};

export function providerCapability(kind: string) {
  const known = Object.hasOwn(PROVIDER_FOR_HARNESS, kind);
  const options = Object.hasOwn(AGENT_OPTIONS, kind) ? AGENT_OPTIONS[kind as AgentKind] : undefined;
  return {
    kind, provider: known ? PROVIDER_FOR_HARNESS[kind as keyof typeof PROVIDER_FOR_HARNESS] : kind,
    modes: options?.modes.map(mode => ({ id: mode.id, label: mode.label })) ?? [],
    accountSelection: kind === "codex" ? "child-home" : kind === "claude-code" ? "config-dir" : "unavailable",
    isolation: kind === "codex" ? "profile" : kind === "claude-code" ? "partial" : "unverified",
    ...accountSourceCapabilities(kind),
  };
}
