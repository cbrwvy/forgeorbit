import type { Account, Binding, ModelCapability, QuotaState, Subscription } from "../accounts/types.ts";
import type { Money } from "../estimation/types.ts";
import type { CostAssessment, SpendingPolicy, TaskPriority } from "../task-scheduling.ts";

export const ROUTING_POLICIES = ["quality-first", "balanced", "cost-efficient", "fastest-eligible", "preserve-limited-resources"] as const;
export type RoutingPolicy = typeof ROUTING_POLICIES[number];
export type Complexity = "low" | "medium" | "high" | "very-high" | "unknown";
export interface TaskRequirements {
  taskId: string; projectId: string;
  type: "backend" | "frontend" | "testing" | "architecture" | "documentation" | "devops" | "general";
  complexity: Complexity; priority: TaskPriority | null;
  capabilities: string[]; tools: string[]; requiredPermissions: string[];
  allowedPermissions: string[] | null; contextTokens: number | null;
  /** Exact quota units, never inferred from percentages or task titles. */
  quotaDemands: { quotaId: string; amount: number }[];
  provenance: string[];
}
/** Internal contract. HTTP clients cannot submit verified resource facts. */
export interface VerifiedFact<T> {
  value: T; verification: "verified" | "unverified" | "unknown";
  source: string; observedAt: number; expiresAt: number | null;
}
export interface ModelEvidence {
  capabilities: VerifiedFact<string[]> | null; tools: VerifiedFact<string[]> | null;
  permissions: VerifiedFact<string[]> | null; contextTokens: VerifiedFact<number> | null;
  /** Confirmed provider/harness vocabulary, ordered least to most. Empty = no parameter. */
  efforts: VerifiedFact<string[]> | null;
  quality: VerifiedFact<{ benchmark: string; score: number }> | null;
  durationMs: VerifiedFact<{ taskId: string; basis: string; ms: number }> | null;
  expectedCost: VerifiedFact<{ taskId: string; basis: string; money: Money }> | null;
}
export interface ResourceCandidate {
  id: string; harnessId: string; accountId: string | null; modelId: string | null;
  profileIds: string[]; enabled: boolean;
  /** Proof for this exact harness/account login, independent from registry identity. */
  authorization: VerifiedFact<boolean> | null; availability: VerifiedFact<boolean> | null;
  support: ModelCapability | null; billing: VerifiedFact<CostAssessment> | null; evidence: ModelEvidence;
}
export interface ResourceLimit {
  id: string;
  scope: { kind: "global" } | { kind: "harness" | "account" | "subscription" | "pool"; id: string };
  limit: VerifiedFact<number | "unbounded"> | null;
  /** All active usage in this scope, across projects/harnesses. */
  occupied: VerifiedFact<number> | null;
}
export interface OwnerRoutingConstraints {
  allowedHarnesses: string[] | null; allowedAccounts: string[] | null;
  spending: SpendingPolicy | null; maxExpectedCost: Money | null;
  globalConcurrency: number | null; projectPriority: TaskPriority | null;
  requiredApprovals: string[];
}
export interface RoutingSnapshot {
  capturedAt: number; candidates: ResourceCandidate[];
  accounts: Account[]; bindings: Binding[]; subscriptions: Subscription[];
  subscriptionLinks: { accountId: string; subscriptionId: string }[];
  quotas: QuotaState[]; limits: ResourceLimit[];
  occupancyComplete: boolean;
}
export interface CandidateAssessment {
  candidate: Pick<ResourceCandidate, "id" | "harnessId" | "accountId" | "modelId" | "profileIds">;
  status: "verified" | "conditional" | "excluded";
  reasons: string[]; unknowns: string[]; provenance: string[];
  expectedCost: { taskId: string; money: Money; basis: string; source: string } | null;
  thinkingEffort: { value: string | null; status: "verified" | "conditional" | "not-applicable"; reason: string };
  quotaEvidence: QuotaState[]; conflicts: string[]; requiredOwnerApproval: string[];
  ranking: { quality: { benchmark: string; score: number } | null; duration: { basis: string; ms: number } | null; reserve: number | null };
}
export interface RoutingPreview {
  status: "recommended" | "no-verified-candidate";
  requirements: TaskRequirements; policy: RoutingPolicy; ownerConstraints: OwnerRoutingConstraints;
  recommendedCandidate: CandidateAssessment | null;
  conditionalCandidates: CandidateAssessment[]; excludedCandidates: CandidateAssessment[];
  alternativeCandidates: CandidateAssessment[];
  unknownInformation: string[]; requiredOwnerApproval: string[];
  capturedAt: number; readOnly: true; execution: "preview-only";
  revalidation: { requiredBeforeExecution: true; reservesResources: false; checks: string[] };
}
