import { interviewSupportFor } from "../project-interview.ts";
/** FO-ROUTING02: evidence for an existing executor option, never a catalog or grant. */
export const RESOURCE_ROLES = ["developer", "reviewer", "project-manager", "head"] as const;
export type ResourceRole = typeof RESOURCE_ROLES[number];
export type EligibilityState = "eligible" | "ineligible" | "unknown";
export interface EligibilityReason { code: string; state: EligibilityState }
export interface AccountResourceEvidence {
  account: { id: string; label: string; provider: string } | null;
  fingerprint: string | null;
  configuration: "valid" | "invalid" | "unknown";
  authentication: "authenticated" | "required" | "unknown";
  model: "supported" | "unsupported" | "unknown";
  capabilities: string[];
  /** Enforced adapter/mode restrictions, never model quality claims. */
  access: "read-only" | "workspace-write" | "unknown";
  /**
   * The provider refused a request for exactly this account, harness and model, and nothing since
   * has shown it answering. An observation, not a quota: it carries no balance and no reset.
   */
  providerRefusal?: import("../provider-refusal.ts").ProviderRefusalSummary | null;
}
export interface AccountEligibility {
  state: EligibilityState;
  role: ResourceRole;
  reasons: EligibilityReason[];
  evidence: AccountResourceEvidence;
  /** Eligibility is not an execution grant, including for authenticated resources. */
  authorization: "owner-approval-required";
}
export function evaluateAccountEligibility(input: {
  evidence: AccountResourceEvidence; role: ResourceRole; kind: string;
  enabled: boolean; installed: boolean | null; modeSupported: boolean;
  policyBlocked: boolean; permissionBlocked: boolean;
}): AccountEligibility {
  const e = input.evidence, reasons: EligibilityReason[] = [];
  const add = (code: string, state: EligibilityState) => reasons.push({ code, state });
  if (!input.enabled) add("harness-disabled", "ineligible");
  if (input.kind === "deepseek-dsh") add("execution-adapter-unavailable", "ineligible");
  if (input.installed !== true) add(input.installed === false ? "cli-not-installed" : "installation-unknown", input.installed === false ? "ineligible" : "unknown");
  if (!input.modeSupported) add("mode-unsupported", "ineligible");
  if (input.policyBlocked) add("resource-policy-blocked", "ineligible");
  if (input.permissionBlocked) add("permission-owner-decision", "ineligible");
  if (e.configuration !== "valid") add("resource-configuration-" + e.configuration, e.configuration === "invalid" ? "ineligible" : "unknown");
  if (!e.account) add("account-unidentified", "unknown");
  if (!e.fingerprint) add("fingerprint-unavailable", "unknown");
  if (e.authentication !== "authenticated") add("authentication-" + e.authentication, e.authentication === "required" ? "ineligible" : "unknown");
  if (e.model !== "supported") add("model-" + e.model, e.model === "unsupported" ? "ineligible" : "unknown");
  if (input.role === "reviewer" && e.access !== "read-only") add("reviewer-read-only-required", e.access === "unknown" ? "unknown" : "ineligible");
  if (input.role === "developer" && e.access !== "workspace-write") add("developer-write-required", e.access === "unknown" ? "unknown" : "ineligible");
  if (input.role === "project-manager" || input.role === "head") {
    if (e.access !== "read-only") add("manager-read-only-required", e.access === "unknown" ? "unknown" : "ineligible");
    // Existing manager execution contracts support these providers only.
    if (!interviewSupportFor(input.kind).supported) add("manager-adapter-unavailable", "ineligible");
  }
  // A signed-in account can still be refused. Only a later successful answer ends this; a login
  // check, a passed retry hint or an Owner click does not. Unknown, never ineligible and never eligible.
  if (e.providerRefusal) add("provider-usage-limit-refused", "unknown");
  if (!reasons.length) add("role-compatible", "eligible");
  return { state: reasons.some(r => r.state === "ineligible") ? "ineligible" : reasons.some(r => r.state === "unknown") ? "unknown" : "eligible",
    role: input.role, reasons, evidence: e, authorization: "owner-approval-required" };
}
