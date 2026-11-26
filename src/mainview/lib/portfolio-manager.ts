/**
 * Portfolio manager view-model (FO-008C). Pure helpers for the Portfolio
 * Manager tab: what a delegation card may offer, how a status reads, and the
 * header status. Nothing here calls the API.
 */

import type { DelegationView, PlanPriority, PortfolioPlan } from "../../shared/portfolio-manager.ts";

export interface DelegationActions {
  canApprove: boolean;
  canReject: boolean;
  /** Label of the approve button: a first send or a retry. */
  approveLabel: string;
  /** Why approve is disabled, when it is. */
  blockedReason: string | null;
  tone: "neutral" | "info" | "success" | "danger" | "muted";
}

/** What the owner can do with a delegation right now. */
export function delegationActions(delegation: DelegationView, busy: boolean): DelegationActions {
  const target = delegation.target;
  switch (delegation.status) {
    case "proposed":
    case "failed": {
      const blockedReason = busy ? "Working…" : target.problem;
      return {
        canApprove: blockedReason == null,
        canReject: !busy,
        approveLabel: delegation.status === "failed" ? "Approve & retry" : "Approve & send",
        blockedReason,
        tone: delegation.status === "failed" ? "danger" : "neutral",
      };
    }
    case "sending":
      return { canApprove: false, canReject: false, approveLabel: "Sending…", blockedReason: "Being sent.", tone: "info" };
    case "sent":
      return { canApprove: false, canReject: false, approveLabel: "Sent", blockedReason: null, tone: "info" };
    case "answered":
      return { canApprove: false, canReject: false, approveLabel: "Answered", blockedReason: null, tone: "success" };
    case "rejected":
      return { canApprove: false, canReject: false, approveLabel: "Rejected", blockedReason: null, tone: "muted" };
  }
}

export function delegationTargetLabel(delegation: DelegationView): string {
  const target = delegation.target;
  if (!target.managerConfigured) return "No agent configured";
  return `${target.harnessLabel ?? target.harnessId ?? "Unknown harness"}${target.model ? ` · ${target.model}` : ""}`;
}

const PRIORITY_LABEL: Record<PlanPriority, string> = { critical: "Critical", high: "High", normal: "Normal", low: "Low" };

export function planPriorityLabel(priority: PlanPriority | null): string {
  return priority ? PRIORITY_LABEL[priority] : "No priority";
}

/** Project names for a plan entry's dependencies, falling back to the path. */
export function dependencyNames(plan: PortfolioPlan, paths: readonly string[]): string[] {
  return paths.map((dep) => plan.projects.find((item) => item.projectPath === dep)?.projectName ?? dep);
}

export interface ConnectionView {
  label: string;
  tone: "text-info" | "text-danger" | "text-warning" | "text-success";
}

export function portfolioConnection(input: {
  answering: boolean;
  problem: string | null;
  needsConsent: boolean;
}): ConnectionView {
  if (input.answering) return { label: "Answering…", tone: "text-info" };
  if (input.problem) {
    const transient = input.problem === "Loading agents…" || input.problem.startsWith("Checking");
    return { label: transient ? input.problem : "Unavailable", tone: "text-danger" };
  }
  if (input.needsConsent) return { label: "Confirm the agent to start", tone: "text-warning" };
  return { label: "Ready", tone: "text-success" };
}

/** Delegations still waiting for the owner, newest first. */
export function pendingDelegations(delegations: readonly DelegationView[]): DelegationView[] {
  return delegations.filter((item) => item.status === "proposed" || item.status === "failed").sort((a, b) => b.createdAt - a.createdAt);
}
