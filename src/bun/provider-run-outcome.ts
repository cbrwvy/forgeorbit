/**
 * Provider outcomes of settled task runs (Developer and QC Reviewer).
 *
 * Bound to the identity the run actually LAUNCHED with: the persisted `execution-identity` status
 * event (harness, account profile, model) written by `spawnAgent`. Never the account that is selected
 * now, and never the Developer's settings inherited by a Reviewer. A run records:
 *
 *   - a usage-limit refusal, when `providerRefusalEvidence` proves it from the run's own persisted
 *     process stderr (the rules from FO-PROVIDER-REFUSAL01), or
 *   - a successful provider answer, which ends refusals for exactly that harness, account and model.
 *
 * Skipped, with a reason, when the launch identity cannot be established. Observation only: nothing
 * here retries, launches, routes, estimates quota or changes QC or Done rules.
 */
import { runs } from "./db.ts";
import { getRunExecution } from "./run-execution.ts";
import { recordProviderRefusal, supersedeProviderRefusals } from "./provider-refusals.ts";
import { redactSecrets } from "../shared/project-interview.ts";
import { providerRefusalEvidence, type ProviderRefusalSummary } from "../shared/provider-refusal.ts";

export type ProviderOutcomeResult =
  | { action: "refusal-recorded"; refusal: ProviderRefusalSummary; surface: string }
  | { action: "answer-recorded"; cleared: number; surface: string }
  | { action: "skipped"; reason: ProviderOutcomeSkip };

export type ProviderOutcomeSkip =
  | "run-not-found"
  | "not-a-codex-run"
  | "no-launch-identity"
  | "launch-identity-mismatch"
  | "not-provider-origin"
  | "model-unknown"
  | "no-provider-evidence"
  | "not-a-provider-answer";

/** Provider-origin runs: the real CLI, or the deterministic fake driver used by offline tests. */
const PROVIDER_ORIGIN = new Set(["real-provider", "synthetic"]);

export function noteRunProviderOutcome(runId: string): ProviderOutcomeResult {
  const run = runs.get(runId);
  if (!run) return { action: "skipped", reason: "run-not-found" };
  // Only Codex runs have refusal proof today. Other harnesses are out of scope.
  if (run.agent !== "codex" && !run.agent.startsWith("codex-profile-")) return { action: "skipped", reason: "not-a-codex-run" };
  const execution = getRunExecution(runId);
  // The identity event is the only launch-time record. Without it nothing is attributed.
  if (!execution || execution.type === "unknown") return { action: "skipped", reason: "no-launch-identity" };
  if (!PROVIDER_ORIGIN.has(execution.type)) return { action: "skipped", reason: "not-provider-origin" };
  // A named profile must name this run's own harness; anything else is not attributed by guessing.
  if (execution.accountProfile && execution.accountProfile.harnessId !== run.agent) return { action: "skipped", reason: "launch-identity-mismatch" };
  if (!execution.model) return { action: "skipped", reason: "model-unknown" };
  const accountId = execution.accountProfile?.id ?? null;
  const surface = run.qcReviewId ? "reviewer-run" : "developer-run";
  const scope = { harnessId: run.agent, accountId, modelId: execution.model };
  // The run's own settle time orders it against other evidence. A late event keeps its real time.
  const at = run.endedAt ?? Date.now();

  if (run.status === "succeeded") {
    const cleared = supersedeProviderRefusals(scope, runId, at, surface);
    return { action: "answer-recorded", cleared, surface };
  }
  if (run.status !== "failed" && run.status !== "cancelled") return { action: "skipped", reason: "not-a-provider-answer" };
  const evidence = providerRefusalEvidence(run.agent, run.codexSessionId, runs.events(runId));
  if (!evidence) return { action: "skipped", reason: "no-provider-evidence" };
  const refusal = recordProviderRefusal({
    kind: evidence.kind, provider: "codex", scope, surface, evidenceId: runId,
    proof: evidence.proof, retryHint: evidence.retryHint, diagnostics: redactSecrets(evidence.diagnostics), now: at,
  });
  return { action: "refusal-recorded", refusal, surface };
}
