/** Only backend dispatch evidence establishes provenance. Provider output/model names cannot. */
export type ExecutionType = "real-provider" | "synthetic" | "fixture" | "unknown";
export interface RunExecution {
  accountProfile?: { id: string; displayName: string; harnessId: string } | null;
  type: ExecutionType;
  provider: string | null;
  model: string | null;
  mode: string | null;
  turns: number | null;
  reportedCostUsd: number | null;
  configuredThresholdUsd: number | null;
  configuredTurnLimit: number | null;
  outcome: string;
  limitTermination: boolean | null;
  termination: string | null;
  quota: "unknown";
}
export function executionFromEvents(events: {stream: string; data: string}[], outcome: string): RunExecution {
  const view: RunExecution = { type: "unknown", provider: null, model: null, mode: null, turns: null, reportedCostUsd: null,
    configuredThresholdUsd: null, configuredTurnLimit: null, outcome, limitTermination: null, termination: null, quota: "unknown" };
  const number = (v: unknown) => typeof v === "number" && Number.isFinite(v) && v >= 0 ? v : null;
  let identitySeen = false;
  for (const e of events) {
    if (e.stream !== "status") continue;
    let data;
    try { data = JSON.parse(e.data); } catch { continue; }
    if (!data || typeof data !== "object") continue;
    if (data.kind === "execution-identity" && !identitySeen && ["real-provider", "synthetic", "fixture", "unknown"].includes(data.executionType)) {
      identitySeen = true;
      view.type = data.executionType;
      if (data.accountProfile && typeof data.accountProfile.id === "string" && typeof data.accountProfile.displayName === "string" && typeof data.accountProfile.harnessId === "string") view.accountProfile = { id: data.accountProfile.id, displayName: data.accountProfile.displayName, harnessId: data.accountProfile.harnessId };
      view.provider = typeof data.provider === "string" ? data.provider : null;
      view.model = typeof data.model === "string" ? data.model : null;
      view.mode = typeof data.mode === "string" ? data.mode : null;
    } else if (data.kind === "claude-bounded-start") {
      view.configuredThresholdUsd = number(data.maxBudgetUsd);
      view.configuredTurnLimit = number(data.maxTurns);
      // Historical records have a known transport, but no reliable executable provenance.
      view.mode ??= "bounded-print";
    } else if (data.kind === "claude-bounded-result") {
      view.turns = Number.isInteger(data.num_turns) ? number(data.num_turns) : null;
      view.reportedCostUsd = number(data.total_cost_usd);
      view.termination = typeof data.subtype === "string" ? data.subtype : null;
      view.limitTermination = ["error_max_turns", "error_max_budget_usd"].includes(data.subtype)
        || (view.turns != null && view.configuredTurnLimit != null && view.turns > view.configuredTurnLimit);
    } else if (data.kind === "claude-bounded-exit" && data.problem) {
      view.termination = String(data.problem);
    }
  }
  return view;
}
