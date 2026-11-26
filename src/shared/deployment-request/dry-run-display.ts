/**
 * FO-DEPLOY02 — honest dry-run outcome labels (display + legacy normalization).
 */

import type { DryRunOutcome, DryRunResult } from "./types.ts";

export type DryRunEvidence = "none" | "synthetic" | "config" | "local-preflight" | "local-dry-run";

/** Normalize persisted rows that mis-labeled synthetic runs before FO-DEPLOY02 closeout. */
export function normalizeDryRunResult(raw: DryRunResult): DryRunResult {
  if (raw.simulated && raw.outcome === "REAL_DRY_RUN_VERIFIED") {
    return {
      ...raw,
      outcome: "SIMULATED",
      evidence: raw.evidence ?? "synthetic",
      message: raw.message.includes("SIMULATED")
        ? raw.message
        : "SIMULATED — in-process test adapter (not verified against real infrastructure).",
    };
  }
  return raw;
}

export function dryRunOutcomeLabel(outcome: DryRunOutcome, simulated: boolean): string {
  if (simulated && outcome === "REAL_DRY_RUN_VERIFIED") return "SIMULATED";
  return outcome;
}

export function dryRunOutcomeDescription(dryRun: DryRunResult): string {
  const normalized = normalizeDryRunResult(dryRun);
  const label = dryRunOutcomeLabel(normalized.outcome, normalized.simulated);
  switch (label) {
    case "SIMULATED":
      return "Simulation passed — synthetic adapter only; does not prove real staging deploy.";
    case "CONFIG_VERIFIED":
      return "Configuration verified — mapping and entrypoint checks only.";
    case "REAL_PREFLIGHT_VERIFIED":
      return "Local preflight subprocess succeeded (read-only LF preflight mode).";
    case "REAL_DRY_RUN_VERIFIED":
      return "Local dry-run subprocess succeeded (read-only LF --dry-run).";
    case "NOT_CONFIGURED":
      return "Adapter not configured on this ForgeOrbit instance.";
    case "UNSUPPORTED":
      return "Dry-run not supported with current adapter settings.";
    case "FAILED":
      return "Dry-run or preflight failed.";
    default:
      return normalized.message;
  }
}
