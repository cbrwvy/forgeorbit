/**
 * FO-ROUTING04: AI Router 2.0 — Deterministic Candidate Evaluation & Ranking Engine
 */

import { describeNoQualifier, summarizeNoQualifier } from "./no-qualifier.ts";
import { CURSOR_INTERNAL_SANDBOX_BLOCKER, DEEPSEEK_CONTAINMENT_BLOCKER } from "../provider-readiness.ts";
import {
  assessApiCost,
  classifyCapacity,
  expectedCompletionMs,
  historyConfidence,
  POLICY_WEIGHTS_NOTE,
  RECOMMENDATION_BOUNDARY,
  strictCapacityAllowed,
  validatePolicyWeights,
} from "./resource-decision.ts";
import { PROVIDER_LIMIT_REASON, refusalApplies, type ProviderRefusalSummary } from "../provider-refusal.ts";
import {
  type CandidateEvaluation,
  type CandidateReadiness,
  type EvidenceClass,
  type ProjectRouterPolicyConfig,
  type RouterRole,
  type ScoreBreakdown,
  type TaskRequirementsInput,
  DEFAULT_PRESET_WEIGHTS,
} from "./types.ts";

export interface EvaluatorCandidateInput {
  id: string; // e.g. JSON.stringify([harnessId, accountId, modelId, mode])
  harnessId: string;
  harnessLabel: string;
  kind: string;
  enabled: boolean;
  cliInstalled: boolean | null;
  simulated?: boolean;
  cliLoggedIn: boolean | null;
  accountId: string | null;
  accountLabel: string | null;
  provider: string;
  supportsRealMultiAccount: boolean;
  isolationType: "child-home" | "config-dir" | "ambient-keychain" | "none";
  modelId: string;
  modelLabel: string;
  mode: string;
  modeLabel: string;
  access: "read-only" | "workspace-write" | "unknown";
  qualityTier: "flagship" | "advanced" | "standard" | "economy";
  benchmarkScore?: number | null;
  costMinor?: number | null; // comparable API minor units, never a subscription balance
  currency?: string;
  billing?: "api" | "subscription" | "internal" | "unknown";
  measuredLatencyMs?: number | null;
  latencySampleCount?: number;
  queueWaitMs?: number | null;
  quotaDemand?: number | null;
  poolId?: string | null;
  poolExhausted?: boolean;
  providerIdentity?: string | null;
  tools?: string[];
  sandbox?: string;
  quotaState: {
    isUnknown: boolean;
    capacityEvidence?: "verified-headroom" | "verified-exhausted" | "owner-reported" | "configured" | "stale" | "unknown";
    remainingPercent?: number | null;
    remainingUnits?: number | null;
    unitKind?: string;
    isExhausted?: boolean;
    isConflict?: boolean;
  };
  historyStats: {
    runCount: number;
    successRate?: number | null; // 0..1
    qcPassRate?: number | null; // 0..1
    reworkRate?: number | null;
    measuredQuality?: number | null;
    isSyntheticTest?: boolean;
    comparable?: boolean;
    role?: RouterRole;
  };
  concurrency: {
    occupied: number;
    limit: number | null;
  };
  activeBlocks?: string[];
  /** See `CandidateEvaluation.providerRefusal`. */
  providerRefusal?: ProviderRefusalSummary | null;
  ownerPreferred?: {
    harness?: boolean;
    model?: boolean;
    account?: boolean;
  };
}

export function evaluateCandidateReadiness(input: EvaluatorCandidateInput): CandidateReadiness {
  if (input.cliInstalled !== true) return "installed";
  if (input.cliLoggedIn !== true) return "installed";
  // model discoverable
  if (input.kind === "cursor" || input.kind === "deepseek" || input.kind === "deepseek-dsh") return "runtime-incompatible";
  if (input.activeBlocks && input.activeBlocks.length > 0) return "model-discoverable";
  if (!input.enabled) return "model-discoverable";
  // executable
  if (input.quotaState.isExhausted) return "executable";
  return "verified-ready";
}

export function eliminateCandidate(
  c: EvaluatorCandidateInput,
  req: TaskRequirementsInput,
  policy: ProjectRouterPolicyConfig,
): { eligible: boolean; reasons: string[] } {
  const reasons: string[] = [];

  // 1. Specific hard blocks from FO-009 / FO-CURSOR05 / FO-DEEPSEEK03
  if (c.kind === "cursor") {
    reasons.push(`cursor-internal-sandbox-unavailable: ${CURSOR_INTERNAL_SANDBOX_BLOCKER}`);
  }
  if (c.kind === "deepseek" || c.kind === "deepseek-dsh") {
    reasons.push(`deepseek-containment-blocked: ${DEEPSEEK_CONTAINMENT_BLOCKER}`);
  }
  if (c.activeBlocks) {
    for (const block of c.activeBlocks) {
      reasons.push(`active-block: ${block}`);
    }
  }

  // 2. Harness enablement and installation
  if (!c.enabled) {
    reasons.push("harness-disabled: Harness is disabled in Settings.");
  }
  if (c.cliInstalled === false && !c.simulated) {
    reasons.push("cli-not-installed: CLI executable is not installed.");
  }
  if (c.cliLoggedIn === false) {
    reasons.push("account-unauthenticated: Account credentials or login missing.");
  }

  // 3. Specialist Role & Permission isolation
  const targetRole: RouterRole = req.role ?? "developer";
  if (targetRole === "reviewer" && c.access !== "read-only") {
    reasons.push("reviewer-read-only-required: Reviewer / Quality Control strictly requires read-only permission mode.");
  }
  if (targetRole === "developer" && c.access !== "workspace-write") {
    reasons.push("developer-write-required: Developer specialist requires workspace-write permission mode.");
  }
  if (targetRole === "head" && c.access !== "read-only") {
    reasons.push("head-read-only-required: Head of PM requires read-only execution mode.");
  }

  // 4. Quota elimination. Owner reports, configured limits, stale reads, and Unknown
  // never count as verified capacity. A shared pool is exhausted once, not per model.
  if (c.accountId && c.providerRefusal && refusalApplies(c.providerRefusal, c)) reasons.push(PROVIDER_LIMIT_REASON);
  if (c.poolExhausted) {
    reasons.push("shared-pool-exhausted: The shared quota pool has no remaining verified capacity. A local note is not a provider reservation.");
  }
  if (c.quotaState.isExhausted || (c.quotaState.remainingPercent !== undefined && c.quotaState.remainingPercent !== null && c.quotaState.remainingPercent <= 0 && classifyCapacity(c.quotaState) === "verified-insufficient")) {
    reasons.push("quota-exhausted: Verified quota is completely exhausted.");
  }
  if (policy.quotaPolicy === "strict" && !strictCapacityAllowed(c.quotaState)) {
    const capacity = classifyCapacity(c.quotaState);
    if (capacity === "verified-insufficient") {
      // A known shortfall is stated as a shortfall, once. It is not "unverified" capacity.
      if (!reasons.some((reason) => reason.startsWith("quota-exhausted:") || reason.startsWith("shared-pool-exhausted:"))) {
        reasons.push("quota-exhausted: Verified quota is completely exhausted.");
      }
    } else reasons.push(capacity === "unknown"
      ? "quota-unknown-strict: Strict quota policy rejects candidates whose quota cannot be verified."
      : `quota-unverified-strict: Strict quota policy rejects ${capacity} capacity.`);
  }

  // 5. Concurrency limits
  if (c.concurrency.limit !== null && c.concurrency.occupied >= c.concurrency.limit) {
    reasons.push(`concurrency-limit-reached: Concurrency limit (${c.concurrency.limit}) fully occupied.`);
  }

  // 6. Owner Constraints
  const constr = policy.constraints;
  if (constr.allowedHarnessIds && constr.allowedHarnessIds.length > 0 && !constr.allowedHarnessIds.includes(c.harnessId)) {
    reasons.push("owner-harness-disallowed: Harness not in Owner allowed list.");
  }
  if (constr.forbiddenModels && constr.forbiddenModels.includes(c.modelId)) {
    reasons.push("owner-model-forbidden: Model forbidden by Owner policy.");
  }
  if (policy.envelopeLocked) {
    const harnesses = constr.allowedHarnessIds ?? [];
    const accounts = constr.allowedAccountIds ?? [];
    const models = constr.allowedModels ?? [];
    const unscopedOnly = policy.envelopeAllowUnscopedAccount === true && accounts.length === 0;
    const accountOk = unscopedOnly ? !c.accountId : Boolean(c.accountId) && accounts.includes(c.accountId!);
    if (harnesses.length === 0 || models.length === 0 || !harnesses.includes(c.harnessId) || !models.includes(c.modelId) || !accountOk) {
      reasons.push("autonomy-envelope: Resource is outside the approved Full Autonomy envelope. The envelope was not expanded.");
    }
  } else if (constr.allowedAccountIds && constr.allowedAccountIds.length > 0) {
    if (!c.accountId || !constr.allowedAccountIds.includes(c.accountId)) {
      reasons.push("owner-account-disallowed: Account not in Owner allowed list.");
    }
  }
  if (!policy.envelopeLocked && constr.allowedModels && constr.allowedModels.length > 0 && !constr.allowedModels.includes(c.modelId)) {
    reasons.push("owner-model-disallowed: Model not in Owner allowed list.");
  }
  if (constr.maxCostMinor != null && c.costMinor == null) reasons.push("cost-budget-unknown: No comparable API cost evidence.");
  if (constr.maxCostMinor != null && c.costMinor != null && c.costMinor > constr.maxCostMinor) {
    reasons.push(`cost-budget-exceeded: Estimated cost (${c.costMinor} cents) exceeds Owner max budget (${constr.maxCostMinor} cents).`);
  }
  if (constr.minQualityTier) {
    const tierRanks: Record<string, number> = { economy: 1, standard: 2, advanced: 3, flagship: 4 };
    if ((tierRanks[c.qualityTier] ?? 0) < (tierRanks[constr.minQualityTier] ?? 0)) {
      reasons.push(`quality-tier-insufficient: Quality tier ${c.qualityTier} is below required min tier ${constr.minQualityTier}.`);
    }
  }

  return {
    eligible: reasons.length === 0,
    reasons,
  };
}

export function calculateCandidateScores(
  c: EvaluatorCandidateInput,
  req: TaskRequirementsInput,
  policy: ProjectRouterPolicyConfig,
): ScoreBreakdown {
  const complexity = req.complexity ?? "unknown";
  const taskType = req.type ?? "general";
  const weightError = validatePolicyWeights(policy.weights);
  const w = weightError ? DEFAULT_PRESET_WEIGHTS.balanced : policy.weights;
  const historyComparable = c.historyStats.isSyntheticTest !== true && c.historyStats.comparable !== false &&
    (c.historyStats.role == null || c.historyStats.role === (req.role ?? "developer"));
  const measuredQuality = historyComparable && c.historyStats.runCount >= 3 && c.historyStats.measuredQuality != null
    ? Math.min(100, Math.max(0, c.historyStats.measuredQuality)) : null;

  // --- 1. Quality Score ---
  // Configured tiers are planning labels. They are not measured benchmark outcomes.
  let baseQuality = 65;
  const qualityEvidence = measuredQuality == null ? "configured" as const : "verified" as const;
  if (measuredQuality != null) baseQuality = measuredQuality;
  else {
    switch (c.qualityTier) {
      case "flagship":
        baseQuality = 95;
        break;
      case "advanced":
        baseQuality = 80;
        break;
      case "standard":
        baseQuality = 65;
        break;
      case "economy":
        baseQuality = 45;
        break;
    }
  }

  // Adjust configured tiers for task complexity. Measured quality is already role- and category-specific.
  let qualityAdjusted = baseQuality;
  if (measuredQuality == null && (complexity === "high" || complexity === "very-high" || taskType === "architecture")) {
    if (c.qualityTier === "flagship") qualityAdjusted += 5;
    else if (c.qualityTier === "economy") qualityAdjusted -= 25;
  } else if (measuredQuality == null && (complexity === "low" || taskType === "documentation")) {
    if (c.qualityTier === "economy") qualityAdjusted += 15;
    else if (c.qualityTier === "flagship") qualityAdjusted -= 10;
  }
  const qualityFinal = Math.min(100, Math.max(0, qualityAdjusted));

  // --- 2. Cost Score ---
  const cost = assessApiCost({
    costMinor: c.costMinor, currency: c.currency, billing: c.billing, policyCurrency: policy.constraints.currency,
  });
  const costScore = cost.score;
  const costEvidence = cost.evidence;
  const costDetail = cost.detail;

  // --- 3. Latency Score ---
  // Fastest uses expected completion: measured duration, queue wait, and rework overhead.
  let latencyScore = 50;
  let latencyEvidence: "verified" | "unknown" = "unknown";
  let latencyDetail = "Latency not measured";
  const completionMs = expectedCompletionMs(c.measuredLatencyMs, c.queueWaitMs, c.historyStats.reworkRate);
  if (completionMs != null && (c.latencySampleCount ?? 1) > 0) {
    latencyEvidence = c.latencySampleCount != null && c.latencySampleCount < 3 ? "unknown" : "verified";
    const ms = completionMs;
    if (ms <= 2000) {
      latencyScore = 95;
      latencyDetail = `Fast (~${(ms / 1000).toFixed(1)}s)`;
    } else if (ms <= 5000) {
      latencyScore = 80;
      latencyDetail = `Moderate (~${(ms / 1000).toFixed(1)}s)`;
    } else if (ms <= 15000) {
      latencyScore = 60;
      latencyDetail = `Standard (~${(ms / 1000).toFixed(1)}s)`;
    } else if (ms <= 30000) {
      latencyScore = 40;
      latencyDetail = `Slow (~${(ms / 1000).toFixed(1)}s)`;
    } else {
      latencyScore = 20;
      latencyDetail = `Very slow (>30s)`;
    }
    if ((c.queueWaitMs ?? 0) > 0) latencyDetail += ` Includes ${((c.queueWaitMs ?? 0) / 1000).toFixed(1)}s of account queue wait.`;
  }

  // --- 4. Quota Score ---
  // Only a verified window contributes a quota score. Manual and configured values stay Unknown.
  let quotaScore = 50;
  let quotaEvidence: "verified" | "unknown" = "unknown";
  const capacityClass = classifyCapacity(c.quotaState);
  let quotaDetail = "Quota unknown";
  if (capacityClass === "verified-sufficient" && c.quotaState.remainingPercent != null) {
    quotaEvidence = "verified";
    const pct = c.quotaState.remainingPercent;
    if (pct >= 80) {
      quotaScore = 95;
      quotaDetail = `Verified high remaining allowance (${pct}%). This is not a reservation with the provider.`;
    } else if (pct >= 50) {
      quotaScore = 80;
      quotaDetail = `Verified healthy allowance (${pct}%).`;
    } else if (pct >= 20) {
      quotaScore = 50;
      quotaDetail = `Verified moderate allowance (${pct}%).`;
    } else if (pct > 0) {
      quotaScore = 20;
      quotaDetail = `Verified low remaining allowance (${pct}%).`;
    }
  } else if (capacityClass === "verified-insufficient") {
    quotaEvidence = "verified";
    quotaScore = 0;
    quotaDetail = "Verified quota is exhausted.";
  } else if (capacityClass === "owner-reported") {
    quotaDetail = "Owner-reported capacity is not verified quota.";
  } else if (capacityClass === "stale") {
    quotaDetail = "Quota evidence is stale and is not treated as current capacity.";
  } else if (capacityClass === "configured-unverified") {
    quotaDetail = "A configured limit is not a provider balance.";
  } else {
    quotaDetail = policy.quotaPolicy === "permissive"
      ? "Quota is Unknown. Permissive policy: allowed with safeguard. Remaining capacity is not invented."
      : "Quota is Unknown. Strict policy: excluded.";
  }

  // --- 5. Execution History Score ---
  let historyScore = 50;
  let historyEvidence: EvidenceClass = "unknown";
  let historyDetail = "Cold-start: insufficient historical runs (< 3)";
  const hist = c.historyStats;
  const confidence = historyConfidence(hist.runCount, historyComparable);
  if (hist.isSyntheticTest) {
    historyDetail = "Synthetic or fixture results are excluded from ranking.";
  } else if (!historyComparable) {
    historyDetail = "This sample is not comparable to the requested role or task class, so it does not train the ranking.";
  } else if (hist.runCount >= 3) {
    historyEvidence = "verified";
    const succ = hist.successRate ?? 0.5;
    const qc = hist.qcPassRate ?? 0.5;
    historyScore = Math.round((succ * 0.6 + qc * 0.4) * 100);
    historyDetail = `${hist.runCount} comparable real runs (Success: ${(succ * 100).toFixed(0)}%, QC Pass: ${(qc * 100).toFixed(0)}%). Confidence: ${confidence}.`;
  } else if (hist.runCount > 0) {
    historyDetail = `Low confidence: ${hist.runCount} comparable run(s), below the minimum of 3. This is not a measured ranking.`;
  }

  // --- 6. Preference Bonus ---
  let prefBonus = 0;
  if (c.ownerPreferred?.account) prefBonus += 10;
  if (c.ownerPreferred?.model) prefBonus += 5;
  if (c.ownerPreferred?.harness) prefBonus += 5;

  // --- Total Weighted Score ---
  const totalWeight = w.quality + w.cost + w.latency + w.quota + w.history;
  const normalizedTotalWeight = totalWeight > 0 ? totalWeight : 100;

  const weightedSum =
    (qualityFinal * w.quality +
      costScore * w.cost +
      latencyScore * w.latency +
      quotaScore * w.quota +
      historyScore * w.history) /
    normalizedTotalWeight;

  const totalScore = Math.round(Math.min(100, Math.max(0, weightedSum + prefBonus)));

  return {
    quality: {
      score: qualityFinal,
      evidence: qualityEvidence,
      tier: c.qualityTier,
      benchmarkScore: c.benchmarkScore,
      detail: measuredQuality != null
        ? `Measured quality from ${c.historyStats.runCount} comparable executions. Configured tier ${c.qualityTier} is not the ranking basis.`
        : `Configured quality tier ${c.qualityTier}. This is not a measured benchmark.`,
    },
    cost: {
      score: costScore,
      evidence: costEvidence,
      estimatedCostMinor: cost.comparable ? c.costMinor : null,
      currency: c.currency ?? policy.constraints.currency ?? "USD",
      comparable: cost.comparable,
      detail: costDetail,
    },
    latency: {
      score: latencyScore,
      evidence: latencyEvidence,
      measuredLatencyMs: c.measuredLatencyMs,
      detail: latencyDetail,
    },
    quota: {
      score: quotaScore,
      evidence: quotaEvidence,
      remainingPercent: c.quotaState.remainingPercent,
      unitKind: c.quotaState.unitKind,
      isUnknown: capacityClass !== "verified-sufficient" && capacityClass !== "verified-insufficient",
      capacityEvidence: c.quotaState.capacityEvidence,
      capacityClass,
      detail: quotaDetail,
    },
    history: {
      score: historyScore,
      evidence: historyEvidence,
      successRate: hist.successRate,
      qcPassRate: hist.qcPassRate,
      runCount: hist.runCount,
      confidence,
      comparable: historyComparable,
      detail: historyDetail,
    },
    preferenceBonus: prefBonus,
    totalScore,
  };
}

export function evaluateCandidates(
  candidates: EvaluatorCandidateInput[],
  req: TaskRequirementsInput,
  policy: ProjectRouterPolicyConfig,
): {
  selected: CandidateEvaluation | null;
  eligible: CandidateEvaluation[];
  ineligible: CandidateEvaluation[];
  all: CandidateEvaluation[];
  accountPin: { requestedAccountId: string; honored: boolean } | null;
  explanation: string;
  authorizesExecution: false;
} {
  const evaluated: CandidateEvaluation[] = candidates.map((c) => {
    const readiness = evaluateCandidateReadiness(c);
    const elimination = eliminateCandidate(c, req, policy);
    const scores = calculateCandidateScores(c, req, policy);

    const selectionReasons: string[] = [];
    const warnings: string[] = [];

    if (elimination.eligible) {
      selectionReasons.push(POLICY_WEIGHTS_NOTE[policy.preset]);
      if (scores.quality.evidence === "verified") selectionReasons.push("Quality rank uses measured comparable history.");
      else selectionReasons.push(`Quality rank uses the configured tier ${scores.quality.tier}. It is not a measured benchmark.`);
      if (scores.cost.comparable === false || scores.cost.evidence === "unknown") selectionReasons.push(scores.cost.detail);
      if (c.ownerPreferred?.account) selectionReasons.push("Owner preferred account");
      if (c.ownerPreferred?.model) selectionReasons.push("Owner preferred model");
      if (c.ownerPreferred?.harness) selectionReasons.push("Owner preferred harness");

      if (c.quotaState.isUnknown || classifyCapacity(c.quotaState) !== "verified-sufficient") {
        warnings.push(scores.quota.detail);
      }
      if (c.isolationType === "ambient-keychain") {
        warnings.push("Provider uses active macOS Keychain account. AccountCore metadata alone does not switch authentication.");
      }
      if (c.isolationType === "config-dir") {
        warnings.push("PARTIAL. CLAUDE_CONFIG_DIR is bound for this profile. Verified provider subject stays Unknown.");
      }
    }

    const isManual = Boolean(
      req.requestedHarnessId &&
      req.requestedHarnessId === c.harnessId &&
      (!req.requestedModelId || req.requestedModelId === c.modelId) &&
      (!req.requestedAccountId || req.requestedAccountId === c.accountId),
    );

    if (isManual) {
      selectionReasons.unshift("Manual Owner override requested for this task");
    }

    return {
      candidateId: c.id,
      harnessId: c.harnessId,
      harnessLabel: c.harnessLabel,
      kind: c.kind,
      accountId: c.accountId,
      accountLabel: c.accountLabel,
      modelId: c.modelId,
      modelLabel: c.modelLabel,
      mode: c.mode,
      modeLabel: c.modeLabel,
      role: req.role ?? "developer",
      eligible: elimination.eligible,
      readiness,
      eliminationReasons: elimination.reasons,
      scores,
      selectionReasons,
      warnings,
      isManualOverride: isManual,
      provider: c.provider,
      providerIdentity: c.providerIdentity ?? null,
      poolId: c.poolId ?? null,
      billing: c.billing ?? "unknown",
      tools: c.tools ?? [],
      sandbox: c.sandbox ?? c.isolationType,
      providerRefusal: c.providerRefusal ?? null,
      authorizesExecution: false,
    };
  });

  const eligible = evaluated.filter((e) => e.eligible);
  const ineligible = evaluated.filter((e) => !e.eligible);

  // Deterministic sorting:
  // 1. Manual override first (if eligible)
  // 2. Total score descending
  // 3. Harness label ascending, Model ID ascending, Account ID ascending (stable tie-breaking)
  eligible.sort((a, b) => {
    if (a.isManualOverride && !b.isManualOverride) return -1;
    if (!a.isManualOverride && b.isManualOverride) return 1;
    if (b.scores.totalScore !== a.scores.totalScore) return b.scores.totalScore - a.scores.totalScore;
    if (a.harnessLabel !== b.harnessLabel) return a.harnessLabel.localeCompare(b.harnessLabel);
    if (a.modelId !== b.modelId) return a.modelId.localeCompare(b.modelId);
    return (a.accountId ?? "").localeCompare(b.accountId ?? "");
  });

  const requested = Boolean(req.requestedAccountId || req.requestedModelId || req.requestedHarnessId || req.requestedMode);
  const matchesRequest = (row: (typeof eligible)[number]) =>
    (!req.requestedAccountId || row.accountId === req.requestedAccountId) &&
    (!req.requestedModelId || row.modelId === req.requestedModelId) &&
    (!req.requestedHarnessId || row.harnessId === req.requestedHarnessId) &&
    (!req.requestedMode || row.mode === req.requestedMode);
  const selected = requested ? (eligible.find(matchesRequest) ?? null) : (eligible[0] ?? null);
  if (selected) {
    selected.selectionReasons.unshift(`Selected under ${policy.preset}. Tie-break is harness label, model id, then account id.`);
  }
  const weightError = validatePolicyWeights(policy.weights);
  if (weightError) {
    for (const row of evaluated) row.warnings.push(`${weightError} Balanced weights were used for this preview. The saved policy was not rewritten.`);
  }
  const accountPin = req.requestedAccountId
    ? { requestedAccountId: req.requestedAccountId, honored: selected?.accountId === req.requestedAccountId }
    : null;
  const pinMiss = Boolean(req.requestedHarnessId || req.requestedModelId || req.requestedAccountId || req.requestedMode) && !selected;

  return {
    selected,
    eligible,
    ineligible,
    all: evaluated,
    accountPin,
    explanation: [
      selected ? selected.selectionReasons.join(" ") : "No eligible resource.",
      selected ? "" : describeNoQualifier(summarizeNoQualifier(ineligible)),
      pinMiss ? "The pinned resource was not replaced with another candidate." : "",
      RECOMMENDATION_BOUNDARY,
    ].filter(Boolean).join(" "),
    authorizesExecution: false as const,
  };
}
