/**
 * FO-ROUTING04: AI Router 2.0 — Shared Types and Routing Contracts
 */

import type { ProviderRefusalSummary } from "../provider-refusal.ts";

export const ROUTER_ROLES = ["developer", "reviewer", "head", "devops", "research"] as const;
export type RouterRole = (typeof ROUTER_ROLES)[number];

export const READINESS_STATES = [
  "installed",
  "authenticated",
  "model-discoverable",
  "runtime-incompatible",
  "executable",
  "verified-ready",
] as const;
export type CandidateReadiness = (typeof READINESS_STATES)[number];

export const POLICY_PRESETS = [
  "best-quality",
  "lowest-cost",
  "balanced",
  "fastest",
  "quota-saver",
  "custom",
] as const;
export type RouterPolicyPreset = (typeof POLICY_PRESETS)[number];

export const QUOTA_POLICIES = ["strict", "permissive"] as const;
export type RouterQuotaPolicy = (typeof QUOTA_POLICIES)[number];

export const AUTONOMY_MODES = ["supervised", "autonomous", "full-autonomy"] as const;
export type RouterAutonomyMode = (typeof AUTONOMY_MODES)[number];

export const EVIDENCE_CLASSES = ["verified", "estimated", "configured", "unknown"] as const;
export type EvidenceClass = (typeof EVIDENCE_CLASSES)[number];

export interface PolicyWeights {
  quality: number; // 0..100
  cost: number; // 0..100
  latency: number; // 0..100
  quota: number; // 0..100
  history: number; // 0..100
}

export interface RouterConstraints {
  maxCostMinor?: number | null; // e.g. in cents
  currency?: string | null;
  maxLatencyMs?: number | null;
  minQualityTier?: "economy" | "standard" | "advanced" | "flagship" | null;
  allowedHarnessIds?: string[] | null;
  forbiddenModels?: string[] | null;
  allowedModels?: string[] | null;
  allowedAccountIds?: string[] | null;
}

export interface DimensionScore {
  score: number; // 0..100
  evidence: EvidenceClass;
  detail: string;
}

export interface ScoreBreakdown {
  quality: DimensionScore & { tier?: string; benchmarkScore?: number | null };
  cost: DimensionScore & { estimatedCostMinor?: number | null; currency?: string; comparable?: boolean };
  latency: DimensionScore & { measuredLatencyMs?: number | null };
  quota: DimensionScore & { remainingPercent?: number | null; unitKind?: string; isUnknown?: boolean; capacityEvidence?: "verified-headroom" | "verified-exhausted" | "owner-reported" | "configured" | "stale" | "unknown"; capacityClass?: "verified-sufficient" | "verified-insufficient" | "owner-reported" | "stale" | "configured-unverified" | "unknown" };
  history: DimensionScore & { successRate?: number | null; qcPassRate?: number | null; runCount: number; confidence?: "high" | "low" | "none"; comparable?: boolean };
  preferenceBonus: number;
  totalScore: number;
}

export interface CandidateEvaluation {
  candidateId: string;
  harnessId: string;
  harnessLabel: string;
  kind: string;
  accountId: string | null;
  accountLabel: string | null;
  modelId: string;
  modelLabel: string;
  mode: string;
  modeLabel: string;
  role: RouterRole;
  eligible: boolean;
  readiness: CandidateReadiness;
  eliminationReasons: string[];
  scores: ScoreBreakdown;
  selectionReasons: string[];
  warnings: string[];
  isManualOverride?: boolean;
  provider?: string;
  providerIdentity?: string | null;
  poolId?: string | null;
  billing?: "api" | "subscription" | "internal" | "unknown";
  tools?: string[];
  sandbox?: string;
  /** A recorded usage-limit refusal for this operation. It affects launch eligibility separately from capacity. */
  providerRefusal?: ProviderRefusalSummary | null;
  authorizesExecution?: false;
}

export interface TaskRequirementsInput {
  taskId: string;
  projectId: string;
  title?: string;
  type?: "backend" | "frontend" | "testing" | "architecture" | "documentation" | "devops" | "general";
  complexity?: "low" | "medium" | "high" | "very-high" | "unknown";
  role?: RouterRole;
  priority?: "critical" | "high" | "normal" | "low" | null;
  requestedHarnessId?: string | null;
  requestedModelId?: string | null;
  requestedAccountId?: string | null;
  requestedMode?: string | null;
  dependsOn?: string[];
  category?: string;
  technology?: string;
}

export interface ProjectRouterPolicyConfig {
  scopeId: string; // 'global' or project path
  preset: RouterPolicyPreset;
  quotaPolicy: RouterQuotaPolicy;
  autonomyMode: RouterAutonomyMode;
  weights: PolicyWeights;
  constraints: RouterConstraints;
  /** When set, an empty allow-list refuses every resource instead of meaning "unset". */
  envelopeLocked?: boolean;
  /**
   * With envelopeLocked and an empty account list, only an unscoped candidate
   * is inside the envelope. A named account is not invented.
   */
  envelopeAllowUnscopedAccount?: boolean;
  updatedAt: number;
}

export const DEFAULT_PRESET_WEIGHTS: Record<RouterPolicyPreset, PolicyWeights> = {
  "best-quality": { quality: 60, history: 20, latency: 10, cost: 10, quota: 0 },
  "lowest-cost": { cost: 60, quota: 20, history: 10, quality: 10, latency: 0 },
  balanced: { quality: 30, cost: 30, latency: 20, history: 20, quota: 0 },
  fastest: { latency: 60, history: 20, quality: 10, cost: 10, quota: 0 },
  "quota-saver": { quota: 60, cost: 20, quality: 10, history: 10, latency: 0 },
  custom: { quality: 20, cost: 20, latency: 20, quota: 20, history: 20 },
};

export const DEFAULT_ROUTER_POLICY: ProjectRouterPolicyConfig = {
  scopeId: "global",
  preset: "balanced",
  quotaPolicy: "permissive",
  autonomyMode: "supervised",
  weights: DEFAULT_PRESET_WEIGHTS["balanced"],
  constraints: {
    maxCostMinor: null,
    currency: "USD",
    maxLatencyMs: null,
    minQualityTier: null,
    allowedHarnessIds: null,
    forbiddenModels: null,
    allowedAccountIds: null,
  },
  updatedAt: 0,
};

export interface QuotaAdapterInfo {
  id: string;
  provider: string;
  kind: "trusted_adapter" | "official_api" | "usage_observation" | "owner_budget" | "persisted_consumption";
  enabled: boolean;
  notes: string;
}

export interface RoutingDecisionRecord {
  id: string;
  projectPath: string;
  taskId: string | null;
  role: RouterRole;
  policyPreset: RouterPolicyPreset;
  quotaPolicy: RouterQuotaPolicy;
  autonomyMode: RouterAutonomyMode;
  selectedHarnessId: string;
  selectedModelId: string;
  selectedAccountId: string | null;
  selectedMode: string;
  decisionType: "automatic" | "manual-override" | "fallback";
  /** recommendation is read-only. approval changes a saved plan. fallback-proposal is not execution. */
  authority?: "recommendation" | "approval" | "fallback-proposal";
  planDigest: string | null;
  evaluation: CandidateEvaluation;
  actualAttribution: {
    runId?: string | null;
    actualHarnessId?: string;
    actualModelId?: string;
    actualAccountId?: string | null;
    executionTimeMs?: number | null;
    reportedCostUsd?: number | null;
    qcVerdict?: string | null;
    outcome?: string | null;
  } | null;
  createdAt: number;
  updatedAt: number;
}

export interface MultiProjectAllocationSlot {
  projectPath: string;
  taskId: string;
  taskTitle: string;
  role: RouterRole;
  selectedCandidate: CandidateEvaluation | null;
  alternatives: CandidateEvaluation[];
  blockers: string[];
}

export interface MultiProjectAllocationPlan {
  id: string;
  policyPreset: RouterPolicyPreset;
  quotaPolicy: RouterQuotaPolicy;
  autonomyMode: RouterAutonomyMode;
  slots: MultiProjectAllocationSlot[];
  planDigest: string;
  createdAt: number;
  approvedAt: number | null;
  appliedAt: number | null;
  status: "proposed" | "approved" | "applied" | "stale" | "invalidated";
  staleReason?: string | null;
  allocation?: {
    objective: string;
    optimal: boolean;
    explored: number;
    limit: number;
    feasible: boolean;
    reason: string | null;
    limitations?: string[];
    withheld?: Record<string, string>;
  };
  authorizesExecution?: false;
}
